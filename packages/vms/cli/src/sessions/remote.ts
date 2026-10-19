import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { ExecRequest } from "../api"
import { CHECKPOINT_REF } from "./git"
import { REMOTE_WORK } from "./paths"

/**
 * What runs in the VM. Two scripts, both bash (every kyora image has it):
 *
 * - SETUP, a short exec right after the repo and its history are in: the repo at the laptop's
 *   path when the image lets it (a bind mount of /work, with sudo), excludes for the VM's own
 *   files under /work, a committer for checkpoints, and the agent's CLI at the laptop's version
 *   (npm, through the registries proxy) unless the image has it already.
 * - SUPERVISOR, the session itself: one resumable exec that outlives every connection to it
 *   and every restart of the host. It starts the agent, and every CHECKPOINT seconds snapshots its
 *   work as a commit on refs/kyora/checkpoint: the working tree through a throwaway index, on
 *   top of kyora/<name>'s tip, with `commit-tree`, so the agent's own index, HEAD, branch and
 *   anything it is in the middle of (a merge, a rebase) are never touched; while one of those is
 *   going on it waits. It keeps an export ready for the laptop: those commits as a bundle, the
 *   transcript, and a state file. It reports each checkpoint to kyora cloud (also when only the
 *   transcript moved), which keeps the last one, so a VM that dies takes nothing with it.
 *
 * A sandbox runs one exec at a time, and the supervisor holds that slot for the session's life,
 * so the laptop never execs again while it runs. It talks to the supervisor through files:
 * uploading `control/sync-<n>` asks for a fresh export (`state` then says `seq=<n>`),
 * `control/stop` for a clean stop; downloads read `status/` and the export it names. Uploads and
 * downloads don't take the exec slot.
 *
 * Exports are generations: each is built aside, then renamed into place as `export.<n>` (a
 * rename to a fresh name, atomic on any filesystem) and never touched again; `status/state`
 * (itself replaced by a rename) names the current one as `export=<n>`. A reader reads the state,
 * then fetches the generation it names: never a directory half written or half swapped. A
 * generation the state named stays for KYORA_EXPORT_KEEP_S (5 min) after the state moved on to a
 * newer one (and the two newest always stay), so a reader that read the state just before a new
 * export still finds the one it was told about; one the state never named goes as soon as two
 * newer exist. Each carries a `manifest` (every file with its size) the laptop checks what it
 * fetched against.
 *
 * TODO(feat/vms-shell): once sandboxes have persistent tmux terminals, the supervisor runs in a
 * tmux window instead (the agent then interactive, `claude --resume <id>` with the prompt), and
 * `attach` joins that window through `kyora vms shell`; the file protocol stays as it is.
 */

export const SESSION_DIR = "/tmp/kyora-session"
export const CONTROL_DIR = `${SESSION_DIR}/control`
/** generation `n` of the export (the current one is `export=<n>` in the status state) */
export const exportDir = (generation: number): string => `${SESSION_DIR}/export.${generation}`
/** how long an export generation stays after a newer one replaced it */
export const EXPORT_KEEP_S = 300
/** the most export generations kept at once, however recent (a long conversation is a copy in each) */
export const EXPORT_KEEP_MAX = 6
export const STATUS_DIR = `${SESSION_DIR}/status`

/** how often the supervisor commits by default */
export const CHECKPOINT_EVERY_S = 600
/** the shortest --checkpoint: below it the reports alone would keep the VM busy */
export const CHECKPOINT_MIN_S = 60
/** the ref the checkpoints are made on, in the VM; the export's bundle carries it (git.ts imports it) */
export { CHECKPOINT_REF } from "./git"
/** what kyora cloud keeps of one checkpoint report (sessions.ts MAX_CHECKPOINT) */
export const CHECKPOINT_MAX_BYTES = 90 * 1000 * 1000

const SETUP = `set -u
want=$1 bin=$2 pkg=$3 version=$4 health=\${5:-}
work=\${KYORA_SESSION_WORK:-${REMOTE_WORK}} dir=\${KYORA_SESSION_DIR:-${SESSION_DIR}}
mkdir -p "$dir/control" "$dir/status"
mode=mapped
if [ "$want" = "$work" ]; then
  mode=same-path
elif [ -d "$want" ] && mountpoint -q "$want" 2>/dev/null; then
  mode=same-path
elif sudo -n mkdir -p "$want" 2>/dev/null && sudo -n mount --bind "$work" "$want" 2>/dev/null; then
  mode=same-path
fi
# the VM's own files under /work (HOME, cargo, the session's config) never go into a checkpoint
exclude=$(cd "$work" && git rev-parse --git-path info/exclude 2>/dev/null || echo .git/info/exclude)
case "$exclude" in /*) ;; *) exclude="$work/$exclude" ;; esac
mkdir -p "$(dirname "$exclude")"
for path in /.home/ /.cargo/ /.kyora-session/; do
  grep -qxF "$path" "$exclude" 2>/dev/null || printf '%s\\n' "$path" >>"$exclude"
done
git -C "$work" config user.name >/dev/null || git -C "$work" config user.name "kyora session"
git -C "$work" config user.email >/dev/null || git -C "$work" config user.email "session@kyora.invalid"
export PATH="$HOME/.local/bin:$PATH"
have=$("$bin" --version 2>/dev/null | head -n 1 || true)
need=1
if [ -n "$have" ]; then
  if [ -z "$version" ]; then need=0; else case "$have" in "$version"*|*" $version"*|*"v$version"*) need=0 ;; esac; fi
fi
if [ "$need" = 1 ]; then
  command -v npm >/dev/null 2>&1 || { echo "this image has neither $bin\${version:+ $version} nor npm to install it with; pick an image with node (e.g. --image node)" >&2; exit 3; }
  echo "installing $pkg\${version:+@$version}" >&2
  npm install -g --prefix "$HOME/.local" --no-fund --no-audit --loglevel=error "$pkg\${version:+@$version}" >&2 || { echo "npm could not install $pkg (the sandbox needs network registries)" >&2; exit 3; }
  "$bin" --version >/dev/null 2>&1 || { echo "$bin does not run after installing $pkg" >&2; exit 3; }
fi
# the broker has to be reachable: in network registries, only through the machine's egress proxy
if [ -n "$health" ] && ! curl -fsS -m 20 -o /dev/null "$health" 2>/dev/null; then
  echo "the VM can't reach kyora cloud at $health; the machine's egress proxy needs KYORA_VMS_PROXY_PLATFORM set to that host" >&2
  exit 4
fi
echo "mode=$mode"
`

const SUPERVISOR = `set -u
dir=\${KYORA_SESSION_DIR:-${SESSION_DIR}}
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$dir/control" "$dir/status"
cd "$KYORA_SESSION_CWD" || { echo "kyora session: $KYORA_SESSION_CWD is not there" >&2; exit 3; }
repo=$(git rev-parse --show-toplevel)
gitdir=$(git -C "$repo" rev-parse --absolute-git-dir)
branch=$KYORA_SESSION_BRANCH base=$KYORA_SESSION_BASE every=\${KYORA_CHECKPOINT_S:-${CHECKPOINT_EVERY_S}}
ref=${CHECKPOINT_REF} limit=\${KYORA_CHECKPOINT_MAX_BYTES:-${CHECKPOINT_MAX_BYTES}} min_report=\${KYORA_REPORT_MIN_S:-${CHECKPOINT_MIN_S}}
seq=0 agent=starting agent_exit='' pid='' supervisor=running checkpoint='' checkpoint_at='' note='' report='' final='' taken=''
exported_size=0 exported_convo='' exported_checkpoint='' exported='' reported_size=0 last_report=0 tick=\${KYORA_SESSION_TICK_S:-2}
keep_s=\${KYORA_EXPORT_KEEP_S:-${EXPORT_KEEP_S}} keep_max=\${KYORA_EXPORT_KEEP_MAX:-${EXPORT_KEEP_MAX}}
# what a supervisor before this one left half built
rm -rf "$dir"/tmp-export.* "$dir/checkpoint.tar"
# the export generation: past whatever a supervisor before this one left; and the one the status state names
gen=0
for d in "$dir"/export.[0-9]*; do
  n=\${d##*/export.}
  case "$n" in ''|*[!0-9]*) continue ;; esac
  if [ "$n" -gt "$gen" ]; then gen=$n; fi
done
named=$(sed -n 's/^export=//p' "$dir/status/state" 2>/dev/null)
case "$named" in ''|*[!0-9]*) named=0 ;; esac
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# git for the supervisor's own work: none of the repo's hooks, no fsmonitor, nothing signed
g() { git -C "$repo" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false "$@"; }
transcript_size() {
  local n
  n=$(wc -c 2>/dev/null <"$HOME/$KYORA_SESSION_FILE" | tr -d ' ')
  echo "\${n:-0}"
}
# what an export of the conversation would hold, in short: the transcript's size and the bytes beside it (subagents)
conversation() {
  local extra=0
  if [ -n "\${KYORA_SESSION_EXTRA:-}" ] && [ -d "$HOME/$KYORA_SESSION_EXTRA" ]; then
    extra=$(find "$HOME/$KYORA_SESSION_EXTRA" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
  fi
  echo "$(transcript_size):\${extra:-0}"
}
state() {
  local tip head
  tip=$(git -C "$repo" rev-parse -q --verify "$branch" 2>/dev/null || true)
  head=$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null || echo detached)
  printf 'seq=%s\\nagent=%s\\nagent_exit=%s\\npid=%s\\nsupervisor=%s\\nstarted=%s\\nupdated=%s\\nbase=%s\\ntip=%s\\nhead=%s\\ncheckpoint=%s\\ncheckpoint_at=%s\\ntranscript_bytes=%s\\nnote=%s\\nreport=%s\\nexport=%s\\nfinal=%s\\n' \\
    "$seq" "$agent" "$agent_exit" "$pid" "$supervisor" "$started" "$(now)" "$base" "$tip" "$head" "$checkpoint" "$checkpoint_at" "$(transcript_size)" "$note" "$report" "$([ "$gen" -gt 0 ] && echo "$gen")" "$final"
}
status() {
  # replaced by a rename; on a disk too full for the copy, written in place (better than not at all)
  if ! { state >"$dir/status/state.tmp" && mv -f "$dir/status/state.tmp" "$dir/status/state"; } 2>/dev/null; then
    rm -f "$dir/status/state.tmp"
    state >"$dir/status/state" 2>/dev/null || return 0
  fi
  # the generation the state named until now is out of date for readers from here on
  if [ "$named" != "$gen" ]; then
    if [ "$named" -gt 0 ]; then date +%s >"$dir/retired.$named"; fi
    named=$gen
  fi
  prune
}
# what the agent is in the middle of, if anything: a checkpoint then waits rather than snapshot it half done
in_progress() {
  local what
  for what in MERGE_HEAD:merge CHERRY_PICK_HEAD:cherry-pick REVERT_HEAD:revert; do
    [ -e "$gitdir/\${what%%:*}" ] && { echo "\${what#*:}"; return 0; }
  done
  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then echo rebase; return 0; fi
  [ -n "$(git -C "$repo" ls-files -u 2>/dev/null | head -n 1)" ] && { echo "conflict resolution"; return 0; }
  return 1
}
# $1: what it is for; $2: "final" for the last one, which is taken even mid-merge (the throwaway index and
# commit-tree never touch what the agent is in the middle of); \`taken\` says whether it was, or why not
checkpoint() {
  local last=\${2:-} op tip prev tree index new parents what=$1
  taken=
  # only on the session's branch: work the agent put on a branch of its own stays where it is
  if [ "$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null)" != "$branch" ]; then
    note="HEAD is not on $branch; checkpoints wait for it"
    taken="HEAD is not on $branch"
    return 0
  fi
  if op=$(in_progress); then
    if [ -z "$last" ]; then
      note="a $op is in progress; checkpoints wait for it"
      taken="a $op is in progress"
      return 0
    fi
    what="$what, in the middle of a $op"
  fi
  note=
  tip=$(g rev-parse -q --verify "$branch^{commit}" 2>/dev/null) || { taken="$branch has no commit"; return 0; }
  # before the first checkpoint, the snapshot the session started from is the one the laptop has
  prev=$(g rev-parse -q --verify "$ref^{commit}" 2>/dev/null || echo "$base")
  # the working tree as a tree, through a copy of the agent's index: the agent's own is never written
  index=$(mktemp "$dir/index.XXXXXX") || { taken="no room for a throwaway index"; return 0; }
  cp "$gitdir/index" "$index" 2>/dev/null || rm -f "$index"
  if ! GIT_INDEX_FILE=$index g add -A >/dev/null 2>&1 || ! tree=$(GIT_INDEX_FILE=$index g write-tree 2>/dev/null); then
    rm -f "$index"
    taken="the working tree could not be written as a tree"
    return 0
  fi
  rm -f "$index"
  if [ -n "$prev" ] && [ "$(g rev-parse "$prev^{tree}")" = "$tree" ] && { [ "$prev" = "$tip" ] || g merge-base --is-ancestor "$tip" "$prev"; }; then
    new=$prev
  elif [ "$(g rev-parse "$tip^{tree}")" = "$tree" ] && { [ -z "$prev" ] || g merge-base --is-ancestor "$prev" "$tip"; }; then
    # everything is committed: the branch's tip is the checkpoint
    new=$tip
  else
    # on top of the tip, and of the last checkpoint when the tip doesn't contain it, so the laptop always fast-forwards
    parents="-p $tip"
    if [ -n "$prev" ] && ! g merge-base --is-ancestor "$prev" "$tip"; then parents="$parents -p $prev"; fi
    new=$(g commit-tree "$tree" $parents -m "kyora checkpoint: $what" 2>/dev/null) || { taken="commit-tree failed"; return 0; }
  fi
  if [ "$new" != "$prev" ] || ! g rev-parse -q --verify "$ref" >/dev/null 2>&1; then
    g update-ref -m "kyora checkpoint: $what" "$ref" "$new" >/dev/null 2>&1 || { taken="update-ref failed"; return 0; }
  fi
  if [ "$new" != "$checkpoint" ]; then checkpoint=$new checkpoint_at=$(now); fi
  taken=yes
}
# whether the current generation already holds everything: the same checkpoint, the conversation as long
current() {
  [ "$gen" -gt 0 ] && [ -d "$dir/export.$gen" ] && [ "$checkpoint" = "$exported_checkpoint" ] && [ "$(conversation)" = "$exported_convo" ]
}
# a new export generation, all or nothing: built aside, complete with its manifest, then renamed into
# place under a name never used before (a rename onto an existing directory would move it inside
# instead). Any step that fails (a full disk, say) leaves nothing behind, says why in \`exported\`, and
# returns non-zero: a generation is never missing its bundle or its conversation.
export_now() {
  local tmp="$dir/tmp-export.$$" rel prev=$gen n=$((gen + 1)) size convo
  exported=
  rm -rf "$tmp"
  mkdir -p "$tmp/home" || { export_failed "there was no room to build it"; return 1; }
  if [ -n "$checkpoint" ] && [ "$checkpoint" != "$base" ]; then
    g bundle create "$tmp/history.bundle" "$base..$ref" >/dev/null 2>&1 || { export_failed "the bundle of its commits could not be written"; return 1; }
  fi
  size=$(transcript_size) convo=$(conversation)
  for rel in "$KYORA_SESSION_FILE" "\${KYORA_SESSION_EXTRA:-}"; do
    [ -n "$rel" ] && [ -e "$HOME/$rel" ] || continue
    { mkdir -p "$tmp/home/$(dirname "$rel")" && cp -a "$HOME/$rel" "$tmp/home/$rel"; } 2>/dev/null || { export_failed "the conversation could not be copied"; return 1; }
  done
  while [ -e "$dir/export.$n" ]; do n=$((n + 1)); done
  gen=$n
  if ! { state >"$tmp/state" && (cd "$tmp" && find . -type f ! -name manifest | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\\n' "$(wc -c <"$f" | tr -d ' ')" "\${f#./}"; done) >"$tmp/manifest" && mv "$tmp" "$dir/export.$n"; } 2>/dev/null; then
    gen=$prev
    export_failed "its files could not be written"
    return 1
  fi
  exported_size=$size exported_convo=$convo exported_checkpoint=$checkpoint
  # the one it replaced, if the status state never named it: no reader can have been told about it
  if [ "$prev" -gt 0 ] && [ "$prev" != "$named" ]; then echo 0 >"$dir/retired.$prev"; fi
  prune
  return 0
}
export_failed() {
  rm -rf "$dir/tmp-export.$$"
  exported=$1
  note="the export failed: $1"
}
# generations two or more behind that are out of date for keep_s, and past keep_max the oldest of the
# rest; never the one the status state names, one it named within keep_s, or the newest two
prune() {
  local f k at t count
  t=$(date +%s)
  for f in "$dir"/retired.*; do
    [ -e "$f" ] || continue
    k=\${f##*/retired.}
    case "$k" in ''|*[!0-9]*) continue ;; esac
    [ "$k" -lt $((gen - 1)) ] || continue
    at=$(cat "$f" 2>/dev/null || echo "$t")
    [ $((t - at)) -ge "$keep_s" ] || continue
    rm -rf "$dir/export.$k"
    rm -f "$f"
  done
  count=0
  for f in "$dir"/export.[0-9]*; do [ -d "$f" ] && count=$((count + 1)); done
  [ "$count" -gt "$keep_max" ] || return 0
  for k in $(for f in "$dir"/export.[0-9]*; do echo "\${f##*/export.}"; done | sort -n); do
    [ "$count" -gt "$keep_max" ] || break
    case "$k" in ''|*[!0-9]*) continue ;; esac
    if [ "$k" = "$named" ] || [ "$k" -ge $((gen - 1)) ]; then continue; fi
    # one the state named within keep_s stays, cap or not: a reader may have been told about it
    at=$(cat "$dir/retired.$k" 2>/dev/null || echo 0)
    if [ "$at" != 0 ] && [ $((t - at)) -lt "$keep_s" ]; then continue; fi
    rm -rf "$dir/export.$k"
    rm -f "$dir/retired.$k"
    count=$((count - 1))
  done
}
# a stop that couldn't export (a full disk): everything but the generation the state names and the newest whole one goes, so the state saying why fits
make_room() {
  local f k
  rm -rf "$dir"/tmp-export.* "$dir/checkpoint.tar"
  for f in "$dir"/export.[0-9]*; do
    k=\${f##*/export.}
    if [ "$k" != "$named" ] && [ "$k" != "$gen" ]; then rm -rf "$f" "$dir/retired.$k"; fi
  done
}
# a PUT of the checkpoint report: its HTTP status (000 when kyora cloud wasn't reached)
put() {
  local code
  code=$(curl -sS -m "$1" -o /dev/null -w '%{http_code}' -X PUT "$KYORA_SESSION_API/checkpoint?commit=$checkpoint$2" -H "authorization: Bearer $KYORA_SESSION_TOKEN" "\${@:3}" 2>/dev/null) || true
  echo "\${code:-000}"
}
report() {
  # kyora cloud keeps the last checkpoint (commits and transcript), so a VM that dies loses nothing
  [ -n "\${KYORA_SESSION_API:-}" ] || return 0
  local tar="$dir/checkpoint.tar" size code
  rm -f "$tar"
  # the size that counts is the tar's own, headers and padding included
  if [ "$gen" -eq 0 ] || ! tar -C "$dir/export.$gen" -cf "$tar" . 2>/dev/null; then
    rm -f "$tar"
    report="the checkpoint could not be packed at $(now)"
    return 0
  fi
  size=$(wc -c <"$tar" | tr -d ' ')
  if [ "\${size:-0}" -le "$limit" ]; then code=$(put 300 "" -H "content-type: application/x-tar" --data-binary @"$tar"); else code=413; fi
  rm -f "$tar"
  if [ "$code" = 413 ]; then
    code=$(put 30 "&tooLarge=1")
    case "$code" in 2??) report="checkpoint $checkpoint is too large for kyora cloud to keep ($size bytes); it keeps the last one that fit" ;; *) report="checkpoint $checkpoint is too large for kyora cloud to keep ($size bytes), and reporting that failed (HTTP $code)" ;; esac
  else
    case "$code" in 2??) report="stored at $(now)" ;; *) report="reporting checkpoint $checkpoint to kyora cloud failed (HTTP $code) at $(now)" ;; esac
  fi
  reported_size=$exported_size last_report=$(date +%s)
}
# the agent and what it runs (its process group): SIGINT first, as a person at its terminal would, TERM after 30 s
stop_agent() {
  [ -n "$pid" ] || return 0
  kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  agent_exit=$? agent=stopped pid=
}
finish() {
  local exported_ok=no
  stop_agent
  checkpoint "the session stopped" final
  supervisor=stopped
  # nothing new since the current generation: it is the last export; else a new one, whole or not at all
  if current || export_now; then exported_ok=yes; fi
  # the laptop destroys the sandbox only on done: the last checkpoint made, and in an export whole
  if [ "$taken" != yes ]; then
    final="skipped: $taken"
  elif [ "$exported_ok" != yes ]; then
    final="skipped: the export failed ($exported)"
  else
    final=done
  fi
  [ "$exported_ok" = yes ] || make_room
  status
  # kyora cloud keeps only a whole export: a failed one is never reported
  if [ "$exported_ok" = yes ]; then report; fi
  status
  exit 0
}
trap finish TERM HUP

# job control just for the start: a background job of a shell without it ignores SIGINT (and can't trap
# it), so a stop's INT would never reach the agent; with it the agent gets a process group of its own
set -m
"$@" </dev/null &
pid=$! agent=running
set +m
status
next=$(( $(date +%s) + every ))
while :; do
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    agent_exit=$? agent=exited pid=
    checkpoint "the agent finished (exit $agent_exit)"
    if export_now; then report; fi
  fi
  # every sync asked for since the last round, answered by one export: the highest number is what the state says
  asked=0
  for request in "$dir"/control/sync-*; do
    [ -e "$request" ] || continue
    n=\${request##*/sync-}
    rm -f "$request"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    if [ "$n" -gt "$asked" ]; then asked=$n; fi
  done
  if [ "$asked" -gt 0 ]; then
    checkpoint "synced to the laptop"
    if [ "$asked" -gt "$seq" ]; then seq=$asked; fi
    # nothing new since the current generation (the same checkpoint, the conversation as long): it answers this one too
    if ! current; then export_now; fi
    status
  fi
  if [ -e "$dir/control/stop" ]; then
    rm -f "$dir/control/stop"
    finish
  fi
  if [ "$(date +%s)" -ge "$next" ]; then
    before=$checkpoint
    checkpoint "periodic"
    # new commits, or a conversation that moved on without any (no more often than min_report)
    if [ "$checkpoint" != "$before" ] || { [ "$(transcript_size)" != "$reported_size" ] && [ $(( $(date +%s) - last_report )) -ge "$min_report" ]; }; then
      if export_now; then report; fi
    fi
    next=$(( $(date +%s) + every ))
  fi
  status
  sleep "$tick"
done
`

export interface SetupArgs {
  /** where the repo should appear: the laptop's path */
  want: string
  bin: string
  pkg: string
  version: string | null
  /** kyora cloud's /v1/health, which the VM must reach for the broker; null without one */
  health: string | null
}

export function setupRequest(args: SetupArgs): ExecRequest {
  return {
    cmd: ["bash", "-c", SETUP, "kyora-session-setup", args.want, args.bin, args.pkg, args.version ?? "", args.health ?? ""],
    cwd: REMOTE_WORK,
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeoutSeconds: 20 * 60,
  }
}

export interface SupervisorArgs {
  /** the agent's working directory in the VM */
  cwd: string
  branch: string
  base: string
  /** the transcript and its directory, relative to the VM's HOME */
  file: string
  extra: string | null
  checkpointSeconds: number
  /** `<kyora cloud>/v1/sessions/<id>`, where checkpoints are reported; null on a kyora-vmd */
  api: string | null
  token: string | null
  agent: { argv: string[]; env: Record<string, string> }
  timeoutSeconds: number
}

export function supervisorRequest(args: SupervisorArgs): ExecRequest {
  const env: Record<string, string> = {
    ...args.agent.env,
    KYORA_SESSION_CWD: args.cwd,
    KYORA_SESSION_BRANCH: args.branch,
    KYORA_SESSION_BASE: args.base,
    KYORA_SESSION_FILE: args.file,
    KYORA_CHECKPOINT_S: String(args.checkpointSeconds),
    GIT_TERMINAL_PROMPT: "0",
  }
  if (args.extra) env.KYORA_SESSION_EXTRA = args.extra
  if (args.api && args.token) {
    env.KYORA_SESSION_API = args.api
    env.KYORA_SESSION_TOKEN = args.token
    // the child token: kyora in the VM creates sandboxes of the session's own
    env.KYORA_VMS_URL = new URL(args.api).origin
    env.KYORA_TOKEN = args.token
  }
  return { cmd: ["bash", "-c", SUPERVISOR, "kyora-session", ...args.agent.argv], cwd: REMOTE_WORK, env, timeoutSeconds: args.timeoutSeconds, resumable: true }
}

/** the supervisor's state file: `key=value` lines */
export interface RemoteState {
  seq: number
  agent: "starting" | "running" | "exited" | "stopped" | string
  agentExit: number | null
  supervisor: "running" | "stopped" | string
  started: string | null
  updated: string | null
  base: string | null
  tip: string | null
  head: string | null
  checkpoint: string | null
  checkpointAt: string | null
  transcriptBytes: number
  note: string | null
  /** how the last report to kyora cloud went (stored, too large to keep, failed) */
  report: string | null
  /** the current export generation (`exportDir`), null before the first */
  export: number | null
  /** once stopped: `done` when the last checkpoint was made, `skipped: <why>` when it couldn't be */
  final: string | null
}

export function parseState(text: string): RemoteState {
  const values = new Map<string, string>()
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1))
  }
  const text_ = (key: string) => values.get(key) || null
  const number = (key: string) => {
    const value = Number(values.get(key))
    return values.get(key) !== undefined && values.get(key) !== "" && Number.isFinite(value) ? value : null
  }
  return {
    seq: number("seq") ?? 0,
    agent: values.get("agent") ?? "unknown",
    agentExit: number("agent_exit"),
    supervisor: values.get("supervisor") ?? "unknown",
    started: text_("started"),
    updated: text_("updated"),
    base: text_("base"),
    tip: text_("tip"),
    head: text_("head"),
    checkpoint: text_("checkpoint"),
    checkpointAt: text_("checkpoint_at"),
    transcriptBytes: number("transcript_bytes") ?? 0,
    note: text_("note"),
    report: text_("report"),
    export: number("export"),
    final: text_("final"),
  }
}

/**
 * Whether a fetched export is generation `generation`, whole: its state names it, every file its
 * manifest lists is there at the size listed, and a checkpoint past the snapshot comes with its
 * bundle. A download that raced a cleanup, or was cut, fails this, and is fetched again.
 */
export async function verifyExport(dir: string, generation: number): Promise<boolean> {
  try {
    const state = parseState(await readFile(join(dir, "state"), "utf8"))
    if (state.export !== generation) return false
    const listed = new Set<string>()
    for (const line of (await readFile(join(dir, "manifest"), "utf8")).split("\n")) {
      if (!line) continue
      const space = line.indexOf(" ")
      const size = Number(line.slice(0, space))
      const rel = line.slice(space + 1)
      if (space < 1 || !Number.isInteger(size) || rel.startsWith("/") || rel.split("/").includes("..")) return false
      if ((await stat(join(dir, rel))).size !== size) return false
      listed.add(rel)
    }
    // commits past the snapshot are in a bundle, or the export isn't whole whatever its manifest says
    if (state.checkpoint && state.checkpoint !== state.base && !listed.has("history.bundle")) return false
    return listed.has("state")
  } catch {
    return false
  }
}

/** for tests: the scripts as they run */
export const SCRIPTS = { SETUP, SUPERVISOR }
