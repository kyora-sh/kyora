# kyora vms

Run commands in disposable VMs. `kyora vms run` uploads your worktree, runs the command, streams its output live and exits with its exit code. It then downloads the artifacts you asked for and destroys the VM.

```bash
kyora vms run --network registries --out target/release/app -- cargo build --release
```

`kyora vms` is one command group of the `kyora` CLI, which also has `kyora run` and `kyora tui` (the kyora agent harness), `kyora detach` and `kyora back`, deploys and `kyora switch` (`kyora --help` lists them). `kyora login`, `logout`, `whoami` and `org` are the same commands as `kyora vms login` and the rest. `kyora-vms`, the earlier name, still works: `kyora-vms <args>` is `kyora vms <args>`.

## Start a VM and get back into it

```bash
kyora vms new brisk-otter                  # fresh VM, straight into its main shell
# Enter, then ~. to detach; the shell keeps running
kyora vms ls
kyora vms attach brisk-otter               # ssh is an alias; no argument selects the sole VM
kyora vms rename brisk-otter build-box
kyora vms ttl build-box 4h
kyora vms rm build-box
```

`new` defaults to registry networking and a 1-hour idle timeout. Its TTL uses the
server default and cap unless `--ttl` is supplied.
Omit the name for a friendly adjective-noun name. `new -- htop` starts a command in the
terminal; without a TTY it runs the command, returns its exit code and keeps the VM.
`--size s|m|l|xl` selects 2/4G, 4/8G, 8/16G or 16/32G CPU/RAM; `--cpus` and `--memory`
override either dimension. The other create options work too.

Sandbox names use 1-32 characters of `a-z`, `0-9` and `-`, and are unique among your live
sandboxes across regions (per API key on a direct daemon). A collision returns HTTP 409
`name_taken`. Every sandbox argument accepts a name, a full ID or a unique ID prefix;
an ambiguous prefix lists its candidates. Names starting with `-` go after `--`, for
example `kyora vms attach -- -build`. `attach` with several VMs offers a numbered
picker in a TTY. Bare `kyora vms` in a TTY shows help when no credentials are
configured, otherwise it lists your VMs and a one-line hint.

`ls` shows NAME, a unique short ID, IMAGE, SIZE, NET, REGION when present, AGE, EXPIRES,
IDLE and SHELLS. IDLE is the remaining time when activity is available, otherwise the
configured timeout; `-` means unknown. SHELLS reports attached clients or detached
sessions. `ls --json` returns `{ sandboxes: [...] }`; `ls <x> --json` returns one sandbox,
with full IDs. `create [name]` still prints only its ID to stdout for scripts and keeps
its existing network/TTL/idle defaults. Old unnamed sandboxes continue to work by ID.

`ttl <x> <duration|none>` sets the **total lifetime from creation**; it does not restart
the clock. `none` removes the deadline where the operator and machine key allow it.
Session parents and children keep their session-managed deadlines.
`rm` accepts several names or IDs; `rm --all` asks for confirmation in a TTY and requires `--yes` in scripts. Destructive names and prefixes resolve against live server records; reads still accept unique prefixes from the list.

```bash
source <(kyora vms completion bash)        # or zsh
kyora vms completion fish | source
```

Completions include subcommands and sandbox names, cached for five seconds per server
and credential in a private temporary file.

## Install

Requires [Bun](https://bun.sh) ≥ 1.2.19 on your PATH (≥ 1.3.14 for `kyora run` and `kyora tui`). `npx` will not work.

```bash
bun add -g kyora
kyora vms login
```

Or without installing: `bunx kyora vms health`. From a checkout: `bun --no-env-file --config=/dev/null packages/vms/cli/src/kyora.ts vms`.

## Configure

### kyora cloud (the default)

[kyora cloud](https://cloud.kyora.sh) is the default server. Sign in once:

```bash
kyora vms login           # opens the browser; approve the code it shows there
kyora vms health          # ok · https://cloud.kyora.sh · kyora cloud
```

The token is kept in `~/.config/kyora/credentials.json` (mode 0600, one entry per server). `KYORA_TOKEN=kyora_…`, a token made on the dashboard, works instead, in CI for example. `kyora vms whoami` says whose token is in use, `kyora vms regions` shows the room free in each region, and `kyora vms logout` deletes the token here (revoke it on the dashboard to end it everywhere). `login --url` signs in to another kyora cloud; point `KYORA_VMS_URL` at it to use that login.

An organization is a shared kyora cloud account: its members' sandboxes, snapshots, URLs and tokens belong to the org, under its caps. `kyora vms org ls` lists yours, `kyora vms org use acme` makes commands act as it , and `kyora vms org use personal` switches back. With no access of your own, sign in for the org directly: `kyora vms login --org acme`.

### Your own server

You need an API key (`kvms_…`) from whoever runs the box. Put it in `~/.config/kyora-vms/env`:

```bash
mkdir -p ~/.config/kyora-vms
printf 'KYORA_VMS_URL=https://vms.example.com\nKYORA_VMS_KEY=kvms_…\n' > ~/.config/kyora-vms/env
chmod 600 ~/.config/kyora-vms/env
kyora vms health          # ok · https://vms.example.com · server … · key: accepted (from …)
```

### Which one is used

`KYORA_VMS_URL` uses the environment, then `~/.config/kyora-vms/env`, then `https://cloud.kyora.sh` (or `https://vms.kyora.sh` with only a `kvms_` key). Credentials use `KYORA_VMS_KEY` or `KYORA_TOKEN` from the environment, then the env file, then the saved login for that URL. `login` does not override your environment or env file.

## Tell your agent

Paste this into `CLAUDE.md` / `AGENTS.md`:

```markdown
## Heavy or untrusted commands run in kyora vms, not locally

- Builds, test suites and anything that downloads and executes code:
  `kyora vms run --network registries -- <cmd…>`
  It uploads this worktree (git-tracked + untracked-not-ignored files), runs the
  command in a fresh microVM, streams its output, and exits with its exit code.
- To get build outputs back, add `--out <path>` (relative to the repo root), for example
  `kyora vms run --network registries --out target/release/app -- cargo build --release`.
  They land at the same path locally.
- `--network none` (the default) has no network at all; `registries` reaches crates.io,
  npm, PyPI and GitHub only.
- `--allow HOST` adds HTTPS hosts to `none` or `registries`, and refuses `--network open`.
  API creates accept and ignore `egressAllow` with `network: "open"` for compatibility,
  returning a `warnings` array. The CLI prints API create warnings to stderr, including
  after waiting in the queue, so stdout remains usable by scripts.
- `--image NAME` boots a guest image the machine has, e.g. `node`; set `KYORA_VMS_IMAGE` once
  instead of passing it every time.
- Exit code 123 means the requested image is unavailable on reachable machines (`image_unavailable`, HTTP 409).
  The message names the image and regions that report it.
- Exit code 125 means kyora itself failed (read its `[kyora]` line on stderr);
  124 means `--timeout` hit (kyora never waits more than a minute past it); anything
  else is the command's own code.
- When every machine is busy, `run` waits in line on its own (up to 15 min, its place on
  stderr); there is no need to retry it in a loop.
- For several commands against one upload: `id=$(kyora vms create --network registries)`,
  `kyora vms push $id`, `kyora vms exec $id -- …` (repeat), `kyora vms pull $id target/…`,
  then always `kyora vms rm $id`.
- The VM has no `.git` unless you ask. To run `git diff`/`git log` in it, add
  `--git-base origin/main` (that ref, HEAD, and the commits back to their merge base),
  `--git-depth N` (the last N commits) or `--git` (all of HEAD's history).
```

## MCP

`kyora mcp` serves the CLI as an MCP server on stdio, signed in as your `kyora login` (or `KYORA_TOKEN` in the server's environment):

```bash
claude mcp add kyora -- kyora mcp
```

Its tools run VMs (`vms_run`, `vms_create`, `vms_exec`, `vms_push`, `vms_pull`, `vms_destroy` and more), publish pages, and manage storage, public URLs, custom domains and deploys. `vms_run` and `vms_exec` wait for the command (`timeout_seconds`, default 600) and return its exit code with the last `output_limit` bytes of stdout and stderr. Relative paths are relative to the directory the server started in. Tokens never appear in tool results; stdout carries only the protocol. `kyora detach` and `kyora back` move the calling agent's own conversation, so they stay terminal commands; `session_status` reads where a session runs.

## Publish a page

```bash
kyora publish ./report                   # prints the page's URL; private: only you, signed in
kyora publish ./dist --name my-app --public --spa
kyora pages ls | show <name> | rm <name> | login <name>
```

`kyora publish` uploads a directory (or one file, with an `index.html` that redirects to it) to your `pages` bucket and serves it at its own URL. Publishing to the same `--name` again switches the page to the new files at once and then deletes the old ones. A private page opens for you after `kyora pages login <name>`, a sign-in link good for 60 seconds. `kyora vms domain add <hostname> --page <name>` serves a public page on your own domain. At most 2000 files and 500 MB per publish.

## Examples

```bash
# Rust release build, binary back into ./target/release/app
kyora vms run --network registries --cpus 8 --memory 16G --out target/release/app -- cargo build --release

# tests with a hard time limit; exit code is the test runner's, 124 on timeout
kyora vms run --network registries --timeout 20m -- cargo test --workspace

# a subproject of a monorepo, with a variable passed through from your shell
kyora vms run --cwd packages/api --env DATABASE_URL -- bun test

# something you do not trust, with no network at all
kyora vms run -- ./install.sh

# the script comes from stdin
cat bench.py | kyora vms run --stdin -- python3 -

# a review in the VM: what this branch changes against main, local edits included
kyora vms run --git-base origin/main -- sh -c 'git log --oneline origin/main..; git diff origin/main --stat'

# upload once, run many times
id=$(kyora vms create --network registries --ttl 2h)
kyora vms push $id
kyora vms exec $id -- cargo build
kyora vms exec $id -- cargo test
kyora vms pull $id target/debug/app --to ./out
kyora vms rm $id
```

## What `run` does

1. **create** a sandbox (defaults: 4 vCPU, 8 GB RAM, 30 GB scratch disk, no network, 8 h TTL). Cloud creates wait up to 15 minutes for capacity. Set `--wait DURATION` or use `--no-wait` to fail immediately with exit 125. Queue position appears on stderr. Unsupported sizes fail immediately. A direct server does not queue creates.
2. **pack** `--dir` (default `.`). In git, upload tracked and non-ignored untracked files, including nested repos and submodules. Outside git, or with `--no-git`, exclude `.git`, `node_modules`, `target`, `.venv` and `dist`. Executable bits, symlinks and mtimes are preserved; symlinks outside the directory are skipped with a warning.
3. **upload** into `/work`. Cloud uploads use 64 MiB parts and up to 8 archives by default. `--shards N` sets the archive count; `KYORA_VMS_PARTS_IN_FLIGHT=N` (1-32) sets concurrent parts. Progress appears on stderr. `--git`, `--git-depth` or `--git-base` includes git history: see [Git history in the VM](#git-history-in-the-vm).
4. **exec** the command in `/work` or `--cwd`, streaming stdout and stderr.
5. **download** each `--out` path, regardless of exit code, into `--to` (default `--dir`) at the same relative path.
6. **destroy** the VM, including after a failure. `--keep` leaves it running and prints its ID.

One timing line goes to stderr at the end:

```
[kyora] sb_k3v9x2: create 1.4s · upload 3.2 MB (1,284 entries) 0.9s · exec 2m41s · download 7.8 MB 0.6s · exit 0
```

A create that waited in line says so: `create 3m14s (queued 3m12s)`. With `--git` the line also says how much history went up and how long it took to bundle and set up: `· git history 1.9 MB (87 commits) 0.8s ·` after the upload.

Ctrl-C cancels the command, destroys the VM and exits 130. SIGTERM exits 143. A second Ctrl-C exits immediately; the VM remains subject to its TTL. Interrupting a queued create cancels it.

### When the connection breaks

`run` and `exec` reconnect automatically for up to 2 minutes after a connection breaks. The CLI prints `[kyora] reconnecting…` on stderr and resumes output without duplicates.

- The sandbox retains the latest 8 MiB of stdout and stderr. Missing output is reported.
- Exit 125 means reconnection failed or the command is unavailable. The command may still be running; the message names its sandbox.
- Older servers or guest images may not support reconnection.
- If the connection breaks before the command ID arrives, the command may be running without an attachable ID.
- `--json` includes `started`, `attached` and `gap` events.

`--timeout` bounds the command. After its deadline and a 1-minute grace (`KYORA_VMS_TIMEOUT_GRACE_MS`), the CLI cancels it and exits 124. `run` fetches `--out` within that grace and destroys the sandbox; `exec` leaves the sandbox running. A create that exceeds `--wait` and the grace exits 125.

Transfers retry network failures and 502/503/504 responses up to 3 times. A 4xx refusal is not retried.

## Git history in the VM

By default the VM gets your files and no `.git`, so `git diff` and `git log` do not work there. `run` and `push` take three flags that send history along. Each of them turns it on:

| flag | history sent |
| --- | --- |
| `--git` | all of HEAD's history |
| `--git-depth N` | the last N commits of HEAD (a shallow repo) |
| `--git-base REF` | REF too (`origin/main`, `main`, a tag or a commit), and the commits from REF and from HEAD back to their merge bases (all of them, after criss-cross merges), where the history stops (shallow): every commit either side reaches that no merge base does, however the branches merged on the way, and not one commit older. With `--git-depth N` as well, at least N of HEAD's |

In the VM, `/work/.git` then has:

- HEAD on your branch, at your commit (or detached, if yours is).
- The base under its own name (`refs/remotes/origin/main` stays `origin/main`). A commit id or an expression like `HEAD~3` becomes `kyora/base`.
- `origin`, with credentials, query and fragment removed. Only https, http, ssh, git and `host:path` URLs are kept; a local path or a remote helper means no `origin`.
- Your index and staged changes. `git status` and `git diff` show modified, deleted, staged and untracked files as they do locally. Sparse checkout paths remain excluded.

So `git diff origin/main`, `git diff origin/main...HEAD`, `git log origin/main..` and `git merge-base` work in the VM against the same commits as locally.

Git history includes commits, trees and blobs. It excludes git config, credentials, hooks, submodule history, worktree metadata, LFS objects, reflogs and stashes. Linked worktrees are supported. `push --git` replaces `.git` at the destination; setup failures exit 125.

Limits:

- `--dir` (or `push`'s dir) must be the repo's top level.
- HEAD must have a commit.
- Some merge histories cannot be sent with `--git-base`. The CLI refuses before creating a sandbox and suggests `--git-depth N` or `--git`.
- Git history is limited to 1 GiB. Set `KYORA_VMS_GIT_MAX`, for example `KYORA_VMS_GIT_MAX=4G`, to change it. Over-limit history is refused before creating a sandbox.
- The history counts toward the key's upload limit. A 413 says how much of the upload was history.
- The summary line and `--json` report the bundle's size and commit count: `git history 1.9 MB (87 commits) 0.8s`.
- Committed history is sent as it is. A secret that was committed once and deleted later is in it. `--git-depth` and `--git-base` send only recent history.

## Exit codes

| code | meaning |
| --- | --- |
| the command's | the remote command's own exit code, 0-255 |
| 124 | `--timeout` hit and the command was killed, or its exit still hadn't come a minute later and kyora gave up on it (and cancelled it) |
| 128 + n | the command died of signal n (137 = SIGKILL, e.g. out of memory) |
| 130 / 143 | you interrupted kyora vms (Ctrl-C / SIGTERM) |
| 123 | requested image unavailable on reachable machines (HTTP 409 `image_unavailable`); the message names its available regions |
| 125 | kyora itself failed: config, network, API error (no room came up within `--wait`, or at once with `--no-wait`), a command whose stream broke and could not be reattached (see [When the connection breaks](#when-the-connection-breaks)), or an `--out` that was missing or unsafe after a successful command |

## Commands

```
kyora vms run [options] -- <cmd…>        upload, run, stream, download, destroy
kyora vms create [options]                start a sandbox, print its id (only the id on stdout)
kyora vms ls [id]                         your sandboxes
kyora vms exec <id> [options] -- <cmd…>   run a command in a sandbox
kyora vms push <id> [dir] [--dest /work]  upload a directory (git-aware, like run; --no-git, --git, --shards too)
kyora vms pull <id> <path>… [--to dir]    download sandbox paths and unpack them here
kyora vms rm <id>… | --all                destroy sandboxes
kyora vms screenshot <id> [-o file.png]   a screenshot of a desktop sandbox (--image desktop)
kyora vms computer <id> <action> [args…]  drive its desktop: a click, typing, keys, scrolling (below)
kyora vms shell <id> [-- cmd…]            a terminal in the sandbox that outlives its connection (below)
kyora vms health                          is the host up, is the key accepted
kyora vms nodes                           kyora cloud's machines (admins only)
kyora vms regions [default <id>|global]   kyora cloud's regions, what is free in each, where your creates go
kyora vms login [--url URL]               sign in to kyora cloud through the browser
kyora vms login --org ORG                 a token that acts as an org you're in
kyora vms org ls | org use <org>|personal
                                          your orgs, and which account commands act as
kyora vms logout [--url URL]              forget the tokens for that server here
kyora vms whoami                          whose token is in use
kyora vms session up|status|attach|pull   move a Claude Code session to a VM and back (also `kyora session …`)
```

`kyora switch …` runs kyora-switch (hot-swap coding-agent logins between accounts), with the same commands and flags.

`kyora vms create --ttl none` keeps a VM with no expiry and disables idle reaping
unless `--idle DURATION` is also supplied. `--idle none` disables idle reaping for a
finite VM. Create defaults to 8 h TTL and 20 min idle. `ls` shows **no expiry** for
unlimited VMs. `run --ttl none --keep` keeps the VM after execution; run without
`--keep` still removes it. The CLI omits ttlSeconds unless `--ttl` is given: the server defaults to 8 h and
shortens it to a smaller configured cap (older servers retain their own default).
Finite TTLs are at most 10 years. Operator/key/session caps can forbid unlimited lifetimes.
Unlimited VMs are billed per second and count against concurrent limits. Removal, access revocation, eviction or a server reboot ends them. Service restarts preserve them. A server from before
this feature rejects `none` with a validation error; the CLI never silently uses a
finite lifetime instead.

`kyora vms --help` lists every option. Sizes take `8G` / `512M` (a bare number means GB); durations take `90s`, `30m`, `1h30m` (a bare number means seconds). `--env NAME=value` sets a variable; `--env NAME` passes your own `$NAME`. Nothing from your environment reaches the VM unless you name it.

Sandbox paths (`--out`, `pull`, `--cwd`, `--dest`) are relative to `/work` unless absolute, and must stay under `/work` (or `/tmp`).

`--wait DURATION` (run, create) sets the capacity wait, up to 15 minutes (default). `--no-wait` fails immediately. Queue position goes to stderr; `create` prints only the ID to stdout. Direct servers do not queue creates.

`--region ID` (run, create) runs in that kyora cloud region and only there: `eu`, `us`, `apac` (`kyora vms regions` lists them). No room there is exit 125, or a wait in line there; the sandbox and its files never leave it. `$KYORA_VMS_REGION`, and a default of yours (`kyora vms regions default us`), name a region the same way. With no region default, or with `--region global`, region selection is automatic. `--strict` from earlier versions does nothing now but say so. Against a direct server `--region global` means nothing and a named region is refused.

`--no-share` (run, create, new, `kyora session up`) creates a sandbox that can never be shared: `kyora vms share` on it fails with `share_disabled`, for its screen and its terminals. It is fixed for the sandbox's life, carried into its snapshots and every restore of them, and inherited by the sandboxes a session creates. `kyora vms ls --json` shows it as `"shareable": false`.

`kyora vms share <id> screen --mode vnc|broadcast` selects screen sharing mode. `vnc` is the default for small audiences; `broadcast` supports up to 200 viewers per link. Browsers that cannot play broadcasts use VNC. `--list` marks broadcast shares `(broadcast)`. Pointer activity and shortcuts are visible. Typed characters are masked unless you use `--keys full`.

`--shards N` (run, push; 1-16) sets concurrent upload archives. Cloud uploads default to one per 256 MiB, up to 8. Direct servers default to one; each archive counts against the key's upload limit.

### Sessions

`kyora session up` moves the Claude Code session you are in (the working tree as a commit on a
`kyora/<name>` branch, and the conversation) into a VM at the same path, where it runs on headless
and checkpoints as it goes; `kyora session pull` brings its commits and conversation back without
touching your checked-out branch. Login credentials stay out of the VM by default.

### Desktops (computer use)

`--image desktop` gives the sandbox a screen (Xvfb, openbox, Chromium; 1280x800 unless `--display WxH` says otherwise) that `screenshot` and `computer` drive with the Anthropic computer-use tool's actions:

```bash
id=$(kyora vms create --image desktop --display 1280x800)
kyora vms screenshot $id -o screen.png                  # --region x,y,w,h (a zoom), --scale 0.5, -o - for stdout
kyora vms computer $id left_click 640 400               # right_click, double_click, … [x y], --modifiers shift
kyora vms computer $id type "hello"                     # text starting with - goes after --
kyora vms computer $id key ctrl+l                       # --repeat 3; several: key "ctrl+a Delete"
kyora vms computer $id scroll down 5 640 400 --screenshot -o after.png
kyora vms computer $id cursor_position                  # 640 400
```

The other actions are `zoom x0 y0 x1 y1`, `left_click_drag x0 y0 x1 y1`, `mouse_move x y`, `left_mouse_down`, `left_mouse_up`, `hold_key combo seconds`, `wait seconds` and `info`. `--screenshot` adds a screenshot once the action ran and the screen settled; without `-o` a screenshot goes to `./<id>-<time>.png` and its path is printed. `--json` prints the API's answer. An image without a desktop answers `501`, exit 125.

### Terminals

`kyora vms shell <id>` attaches your terminal, raw and at your size, to a tmux session in the sandbox (`main` unless `--name` says otherwise; made if it isn't there). A full-screen program runs there as it does locally, and keeps running when you detach or the network drops:

```bash
kyora vms shell $id                          # a login shell
kyora vms shell $id -- claude                # claude in a new window of "main" (--cwd, -e for that window)
kyora vms shell $id --name build -- npm test # another session
kyora vms shell $id --view                   # watch it; your keys go nowhere
kyora vms shell $id --list                   # NAME  WINDOWS  CLIENTS  STATE  LAST OUTPUT
kyora vms shell $id --kill build
```

`~.` after Enter detaches (`~~` types a `~`, `~?` lists the escapes); tmux's `C-b d` does too, and so does a signal from outside (exit 128 + its number). A dropped connection prints `[kyora] reconnecting…` and attaches again by itself (backing off up to 10 s, for up to 2 minutes: `KYORA_VMS_REATTACH_WINDOW_MS`, as for exec), and tmux redraws the screen; a refusal that attaching again won't change ends it with the server's reason. The terminal is put back as it was however the shell ends. A terminal wider or taller than 1000 is sent as 1000. OSC 52 (a program setting your clipboard) is taken out of the output unless `--clipboard` or `KYORA_VMS_CLIPBOARD=1`. Exit 0 when you detach or the session ends, 125 when it couldn't attach. A session something runs in keeps the sandbox from idling out, but never past its `--ttl`.

### Network modes

- `none` (default): the VM has no network device.
- `registries`: HTTPS access to crates.io, static.rust-lang.org, GitHub, PyPI, npm/yarn, bun.sh and the Debian/Ubuntu archives only. Proxy variables are set in the VM.
- `open`: the internet (no private ranges, no SMTP, rate-limited), only for keys allowed to use it.

### `--json`

`run --json` writes NDJSON to stdout:

```
{"type":"queued","ticket":"q_3_…","position":3,"ahead":2,"waitUntil":"…"}   only while it waits in line, each time its place changes
{"type":"sandbox","id":"sb_…","network":"none",…}
{"type":"upload","bytes":3355443,"entries":1284,"files":"git","durationMs":912}
{"type":"git","bytes":1895669,"commits":87,"shallow":false,"head":"…","branch":"refs/heads/feat","base":null,"staged":0,"durationMs":806}   with --git
{"type":"started","id":"…","resumable":true}     command events
{"type":"stdout","data":"   Compiling app v0.1.0\n"}
{"type":"stderr","data":"…"}
{"type":"exit","code":0,"signal":null,"durationMs":161022,"timedOut":false,"bytes":{"stdout":…,"stderr":…}}
{"type":"download","path":"/work/target/release/app","to":"/repo","entries":1,"bytes":8123456,"refused":[],"durationMs":611}
{"type":"summary","id":"sb_…","exitCode":0,"kept":false,"upload":{…},"downloadBytes":8123456,"timings":{"createMs":1402,"queuedMs":null,…}}
```

`timings.queuedMs` is the part of `createMs` spent waiting in line, or null.

On kyora cloud the upload event also has `parts` (requests it took) and `shards` (archives it went up as), and a download fetched as byte ranges says `"ranged":true`.

`exec --json` prints command events. Output that is not valid UTF-8 arrives as `"b64"` instead of `"data"`. The other commands print one JSON document. Diagnostics always go to stderr.

## End-to-end tests

`src/e2e/` holds tests that run against a real kyora cloud with your own config: the URL and key `kyora vms health` reports (your login, or `KYORA_VMS_KEY`/`KYORA_VMS_URL`). They create real sandboxes, so a plain `bun test` skips them. Opt in with `KYORA_E2E=1`, from `packages/vms/cli`:

```sh
KYORA_E2E=1 bun test src/e2e/snapshot.e2e.test.ts                       # region eu (the default)
KYORA_E2E=1 KYORA_E2E_REGION=us bun test src/e2e/snapshot.e2e.test.ts   # another region
```

`snapshot.e2e.test.ts` needs an account allowed to take full snapshots. It runs three cases, each with its own sandbox (network `none`) and snapshot:

- **full**: a process that keeps a random value in memory and counts once a second is snapshotted (`kind: "full"`), the sandbox is destroyed and the snapshot restored (`fromSnapshot`). It must come back with the same pid and value, still counting.
- **fs**: files in `/work`, `$HOME` and `/tmp` come back from an fs snapshot; the process doesn't.
- **clock**: right after a full restore, the guest's clock is within 1 s of this machine's (the restore steps it). Your own clock must be synced for this one.

Every phase (create, snapshot, destroy, restore, first exec) is timed and logged, with a summary per case at the end. Each case deletes its sandboxes and snapshot when it finishes, pass or fail. A sweep after the file and on Ctrl-C catches anything a timed-out case left behind. As a backstop the sandboxes have a 15 minute TTL and the snapshots expire after a day, and both carry the label `e2e=snapshot`. A run takes about a minute.

## Safety

- **Keys are sent only to `KYORA_VMS_URL` and never printed.** HTTPS is required except for localhost. Redirects are not followed. Saved logins are sent only to the server that issued them.
- **A checkout cannot redirect your key.** Server URLs and credentials from a checkout's `.env` are refused.
- **Git-ignored files stay local.** If git cannot read the repo, the upload fails. `--no-git` includes ignored files; check `git status --ignored` first.
- **Git history excludes local config and credentials.** `--git` includes commits, trees and blobs, with credentials removed from `origin`. Committed secrets still appear in history.
- **Unsafe downloads are refused.** Absolute paths, `..`, escaping links and writes through symlinks are refused. Devices are skipped; setuid and group/other-write bits are cleared. A refused entry exits 125.
- **Host files are never mounted in the VM.** Sandboxes have their own kernel, disk and network namespace.

`kyora vms images [--json]` lists fleet images and per-region availability. Admins also
see each machine's presence, version, SHA-256 and build time. `kyora vms images build
<profile> --node <name>` or `--all` requests an admin rebuild and reports which machines
accepted it. The matching APIs are `GET /v1/images` and admin `POST /v1/images/build`.
An unavailable image exits 123. Use `kyora vms images` to check availability before creating a sandbox.
