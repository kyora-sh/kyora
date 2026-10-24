import { createHash, randomUUID } from "node:crypto"
import { chmod, rename, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { VmsClient } from "./api"
import { isFullId } from "./names"

export const SUBCOMMANDS = "new ls usage top attach rm run create shell share ssh exec push pull screenshot computer rename ttl resize network completion health regions images image nodes session storage tokens login logout whoami snapshot snapshots restore"
const safeName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9-]{1,32}$/.test(name)
const safeCandidate = (name: unknown): name is string => typeof name === "string" && (safeName(name) || isFullId(name))
const TOKEN_SCOPES = "vms:read vms:write vms:exec vms:share public-urls images storage storage:presign projects:read deploys"
const TOKEN_FLAGS = "--scope --project --label --region --max-sandboxes --max-vcpus --max-memory --max-ttl --network --names --name-prefix --expires --org --json"
const SNAPSHOT_SUBCOMMANDS = "create ls list show rm delete restore"
const SNAPSHOT_FLAGS = "--full --name --ttl --no-wait --json"
const RESTORE_FLAGS = "--no-share --size --network --allow --cpus --allocated-cpus --cpu-limit --max-memory --autoscale --memory --disk --ttl --idle --display --region --wait --no-wait --name --no-resume --json"
const TARGETS = "attach ssh shell share ls exec push pull rm screenshot computer rename ttl resize network"

export async function completionNames(api: VmsClient, key: string): Promise<string[]> {
  const digest = createHash("sha256").update(key).digest("hex")
  const path = join(tmpdir(), `kyora-vms-completion-${process.getuid?.() ?? "user"}-${digest}.json`)
  try {
    const cached = await Bun.file(path).json() as { at: number; names: string[] }
    if (Date.now() - cached.at >= 0 && Date.now() - cached.at < 5000 && Array.isArray(cached.names) && cached.names.every(safeCandidate)) return cached.names
  } catch {}
  const names = (await api.list()).flatMap((s) => s.name ? (safeName(s.name) ? [s.name] : []) : (typeof s.id === "string" && isFullId(s.id) ? [s.id] : []))
  const staging = `${path}.${randomUUID()}`
  try {
    await Bun.write(staging, JSON.stringify({ at: Date.now(), names }), { mode: 0o600 })
    await chmod(staging, 0o600)
    await rename(staging, path)
  } finally {
    await unlink(staging).catch(() => {})
  }
  return names
}

/** kyora's own commands; `kyora vms` takes SUBCOMMANDS, and `kyora-vms` is `kyora vms` */
export const COMMANDS = "vms run tui detach back session switch top support projects link deploy deployments image images login logout whoami org help"
const IMAGE = "build check lock ls versions rm push usage"

/**
 * One completion function for `kyora` and `kyora-vms`: `n` is where the sandbox verb sits, 1 for
 * `kyora-vms <verb>`, 2 for `kyora vms <verb>`, none for kyora's other commands.
 */
export function completion(shell: string): string {
  if (shell === "bash") return `# source <(kyora vms completion bash)
_kyora() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" words="" n=1
  if [ "\${COMP_WORDS[0]##*/}" != "kyora-vms" ]; then
    n=0
    if [ "$COMP_CWORD" -eq 1 ]; then words="${COMMANDS}"
    elif [ "\${COMP_WORDS[1]}" = "vms" ]; then n=2
    elif { [ "\${COMP_WORDS[1]}" = "image" ] || [ "\${COMP_WORDS[1]}" = "images" ]; } && [ "$COMP_CWORD" -eq 2 ]; then words="${IMAGE}"
    fi
  fi
  if [ "$n" -gt 0 ]; then
    local at=$((COMP_CWORD - n))
    if [ "$at" -eq 0 ]; then
      words="${SUBCOMMANDS}"
    else
      case "\${COMP_WORDS[n]}" in
        completion) words="bash zsh fish" ;;
        tokens)
          if [ "$at" -eq 1 ]; then words="create ls revoke"
          elif [ "\${COMP_WORDS[COMP_CWORD-1]}" = "--scope" ]; then words="${TOKEN_SCOPES}"
          elif [ "\${COMP_WORDS[n+1]}" = "create" ]; then words="${TOKEN_FLAGS}"
          fi ;;
        image|images) words="${IMAGE}" ;;
        snapshot|snapshots)
          if [ "$at" -eq 1 ]; then words="${SNAPSHOT_SUBCOMMANDS}"; [ "\${COMP_WORDS[n]}" = "snapshot" ] && words="$words $(kyora vms __complete 2>/dev/null)"
          elif [ "$at" -eq 2 ] && [ "\${COMP_WORDS[n+1]}" = "create" ]; then words="$(kyora vms __complete 2>/dev/null)"
          elif [ "\${COMP_WORDS[n+1]}" = "restore" ]; then words="${RESTORE_FLAGS}"
          elif [[ " ls list show rm delete " == *" \${COMP_WORDS[n+1]} "* ]]; then words="--json"
          else words="${SNAPSHOT_FLAGS}"
          fi ;;
        restore) [ "$at" -gt 1 ] && words="${RESTORE_FLAGS}" ;;
        ls) words="--label --json $(kyora vms __complete 2>/dev/null)" ;;
        ${TARGETS.split(" ").join("|")}) words="$(kyora vms __complete 2>/dev/null)" ;;
      esac
    fi
  fi
  COMPREPLY=()
  local candidate
  for candidate in $words; do
    if [[ "$candidate" == "$cur"* ]]; then
      COMPREPLY+=("$candidate")
    fi
  done
}
complete -F _kyora kyora kyora-vms`
  if (shell === "zsh") return `# source <(kyora vms completion zsh)
_kyora() {
  local -a candidates
  local n=2
  if [[ \${words[1]:t} != kyora-vms ]]; then
    n=0
    if (( CURRENT == 2 )); then candidates=(${COMMANDS})
    elif [[ $words[2] == vms ]]; then n=3
    elif [[ $words[2] == (image|images) ]] && (( CURRENT == 3 )); then candidates=(${IMAGE})
    fi
  fi
  if (( n > 0 )); then
    if (( CURRENT == n )); then
      candidates=(${SUBCOMMANDS})
    elif [[ $words[n] == completion ]]; then
      candidates=(bash zsh fish)
    elif [[ $words[n] == tokens ]]; then
      if (( CURRENT == n + 1 )); then candidates=(create ls revoke)
      elif [[ $words[CURRENT-1] == --scope ]]; then candidates=(${TOKEN_SCOPES})
      elif [[ $words[n+1] == create ]]; then candidates=(${TOKEN_FLAGS})
      fi
    elif [[ $words[n] == (image|images) ]] && (( CURRENT == n + 1 )); then
      candidates=(${IMAGE})
    elif [[ $words[n] == (snapshot|snapshots) ]]; then
      if (( CURRENT == n + 1 )); then candidates=(${SNAPSHOT_SUBCOMMANDS}); [[ $words[n] == snapshot ]] && candidates+=(\${(f)"$(kyora vms __complete 2>/dev/null)"})
      elif (( CURRENT == n + 2 )) && [[ $words[n+1] == create ]]; then candidates=(\${(f)"$(kyora vms __complete 2>/dev/null)"})
      elif [[ $words[n+1] == restore ]]; then candidates=(${RESTORE_FLAGS})
      elif [[ $words[n+1] == (ls|list|show|rm|delete) ]]; then candidates=(--json)
      else candidates=(${SNAPSHOT_FLAGS})
      fi
    elif [[ $words[n] == restore ]] && (( CURRENT > n + 1 )); then
      candidates=(${RESTORE_FLAGS})
    elif [[ $words[n] == ls ]]; then
      candidates=(--label --json \${(f)"$(kyora vms __complete 2>/dev/null)"})
    elif [[ " ${TARGETS} " == *" $words[n] "* ]]; then
      candidates=(\${(f)"$(kyora vms __complete 2>/dev/null)"})
    fi
  fi
  compadd -- $candidates
}
compdef _kyora kyora kyora-vms`
  if (shell === "fish") {
    const vms = (command: string, seen: string) => `complete -c ${command} -n '${seen}; and not __fish_seen_subcommand_from ${SUBCOMMANDS}' -a '${SUBCOMMANDS}'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from ${TARGETS}; and not __fish_seen_subcommand_from snapshot snapshots restore tokens' -a '(kyora vms __complete 2>/dev/null)'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from tokens' -a 'create ls revoke'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from tokens; and __fish_seen_subcommand_from create' -l scope -r -a '${TOKEN_SCOPES}'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from tokens; and __fish_seen_subcommand_from create' -l project -r
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots; and not __fish_seen_subcommand_from ${SNAPSHOT_SUBCOMMANDS}' -a '${SNAPSHOT_SUBCOMMANDS}'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot; and not __fish_seen_subcommand_from ls list show rm delete restore' -a '(kyora vms __complete 2>/dev/null)'
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots' -l json
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots; and not __fish_seen_subcommand_from restore ls list show rm delete' -l full
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots; and not __fish_seen_subcommand_from restore ls list show rm delete' -l name -r
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots; and not __fish_seen_subcommand_from restore ls list show rm delete' -l ttl -r
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from snapshot snapshots; and not __fish_seen_subcommand_from restore ls list show rm delete' -l no-wait
${RESTORE_FLAGS.split(" ").map((flag) => `complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from restore' -l ${flag.slice(2)}`).join("\n")}
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from ls; and not __fish_seen_subcommand_from snapshot snapshots tokens' -l label -r
complete -c ${command} -n '${seen}; and __fish_seen_subcommand_from image images' -a '${IMAGE}'`
    return `# kyora vms completion fish | source
complete -c kyora -f
complete -c kyora -n '__fish_use_subcommand' -a '${COMMANDS}'
complete -c kyora -n '__fish_seen_subcommand_from image images; and not __fish_seen_subcommand_from vms' -a '${IMAGE}'
${vms("kyora", "__fish_seen_subcommand_from vms")}
complete -c kyora-vms -f
${vms("kyora-vms", "true")}`
  }
  throw new Error("completion takes bash, zsh or fish")
}
