import { createHash, randomUUID } from "node:crypto"
import { chmod, rename, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { VmsClient } from "./api"
import { isFullId } from "./names"

export const SUBCOMMANDS = "new ls usage top attach rm run create shell share ssh exec push pull screenshot computer rename ttl resize network completion health regions images image nodes session storage tokens login logout whoami"
const safeName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9-]{1,32}$/.test(name)
const safeCandidate = (name: unknown): name is string => typeof name === "string" && (safeName(name) || isFullId(name))
const TOKEN_SCOPES = "vms:read vms:write vms:exec vms:share public-urls images storage storage:presign projects:read deploys"
const TOKEN_FLAGS = "--scope --project --label --region --max-sandboxes --max-vcpus --max-memory --max-ttl --network --names --name-prefix --expires --org --json"
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

export function completion(shell: string): string {
  if (shell === "bash") return `# source <(kyora-vms completion bash)
_kyora_vms() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" words=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${SUBCOMMANDS}"
  else
    case "\${COMP_WORDS[1]}" in
      completion) words="bash zsh fish" ;;
      tokens)
        if [ "$COMP_CWORD" -eq 2 ]; then words="create ls revoke"
        elif [ "\${COMP_WORDS[COMP_CWORD-1]}" = "--scope" ]; then words="${TOKEN_SCOPES}"
        elif [ "\${COMP_WORDS[2]}" = "create" ]; then words="${TOKEN_FLAGS}"
        fi ;;
      image) words="build lock ls versions rm push usage" ;;
      ${TARGETS.split(" ").join("|")}) words="$(kyora-vms __complete 2>/dev/null)" ;;
    esac
  fi
  COMPREPLY=()
  local candidate
  for candidate in $words; do
    if [[ "$candidate" == "$cur"* ]]; then
      COMPREPLY+=("$candidate")
    fi
  done
}
complete -F _kyora_vms kyora-vms`
  if (shell === "zsh") return `# source <(kyora-vms completion zsh)
_kyora_vms() {
  local -a candidates
  if (( CURRENT == 2 )); then
    candidates=(${SUBCOMMANDS})
  elif [[ $words[2] == completion ]]; then
    candidates=(bash zsh fish)
  elif [[ $words[2] == tokens ]]; then
    if (( CURRENT == 3 )); then candidates=(create ls revoke)
    elif [[ $words[CURRENT-1] == --scope ]]; then candidates=(${TOKEN_SCOPES})
    elif [[ $words[3] == create ]]; then candidates=(${TOKEN_FLAGS})
    fi
  elif [[ $words[2] == image ]] && (( CURRENT == 3 )); then
    candidates=(build lock ls versions rm push usage)
  elif [[ " ${TARGETS} " == *" $words[2] "* ]]; then
    candidates=(\${(f)"$(kyora-vms __complete 2>/dev/null)"})
  fi
  compadd -- $candidates
}
compdef _kyora_vms kyora-vms`
  if (shell === "fish") return `# kyora-vms completion fish | source
complete -c kyora-vms -f
complete -c kyora-vms -n '__fish_use_subcommand' -a '${SUBCOMMANDS}'
complete -c kyora-vms -n '__fish_seen_subcommand_from ${TARGETS}' -a '(kyora-vms __complete 2>/dev/null)'
complete -c kyora-vms -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c kyora-vms -n '__fish_seen_subcommand_from tokens' -a 'create ls revoke'
complete -c kyora-vms -n '__fish_seen_subcommand_from tokens; and __fish_seen_subcommand_from create' -l scope -r -a '${TOKEN_SCOPES}'
complete -c kyora-vms -n '__fish_seen_subcommand_from tokens; and __fish_seen_subcommand_from create' -l project -r
complete -c kyora-vms -n '__fish_seen_subcommand_from image' -a 'build lock ls versions rm push usage'`
  throw new Error("completion takes bash, zsh or fish")
}
