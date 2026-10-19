import { parseArgs } from "node:util"
import { NETWORKS, type CreateSpec, type Network, VmsClient } from "../api"
import { loadConfig } from "../config"
import { diskGb, memoryMb, parseSeconds, positiveInt } from "../units"
import { AGENTS, type AgentId } from "./agents"
import { attach, credsList, credsRemove, credsReturn, credsSync, DEFAULT_PERMISSION_MODE, guard, list, pullSession, status, up } from "./commands"
import { repoTop } from "./git"
import { CHECKPOINT_EVERY_S, CHECKPOINT_MIN_S } from "./remote"
import type { SlotProvider } from "./slots"

export const SESSION_HELP = `kyora session: move a coding agent's session (repo and conversation) to a kyora VM, let it run, sync it back

the short way:
  kyora detach [name]                   this repo's newest conversation into a VM; it carries on there
  kyora back [name]                     its commits and conversation back here, and the VM ends; resume locally

usage:
  kyora session up [options]            snapshot the working tree onto kyora/<name>, start the conversation
                                        in a VM at the same path, headless, checkpointing as it goes
  kyora session status [name]           where it runs, its branch, last checkpoint, the agent's state
  kyora session attach [name]           watch the agent (Ctrl-C lets go; it runs on)
  kyora session pull [name]             its commits onto kyora/<name> and its conversation back here
  kyora session down [name]             the same as pull (--stop ends the session and destroys the VM)
  kyora session list                    the sessions this laptop knows
  kyora session creds sync --slot S…    upload kyora-switch logins to kyora cloud (opt-in; or --all)
  kyora session creds list              what kyora cloud holds, and each slot's state
  kyora session creds return --slot S   return a login to its local slot and end cloud use
  kyora session creds rm --slot S       delete a slot from kyora cloud
  kyora session guard                   a Claude Code SessionStart hook: warns when you resume a conversation the cloud drives

\`kyora detach\` takes every option of up (a name may come first instead of --name). \`kyora back\` is
pull --stop: it takes pull's options, and --keep syncs without ending the session.

up:
  --repo DIR              the repo (default .); the conversation must have run in it
  --session ID | --latest which conversation (default: the newest of this repo)
  --agent claude|codex    whose conversation (default claude; codex needs --unsafe-copy-credentials for now)
  --name NAME             the branch is kyora/NAME (default: a random s…)
  --no-share              permanently disable view shares, including session children and snapshots
  --image NAME            the guest image, e.g. desktop (default $KYORA_VMS_IMAGE, else the machine's)
  --ttl DURATION          how long the session may run (default 12h; kyora cloud caps it, 8h unless raised)
  --network MODE          registries (default) or open
  --cpus N  --memory SIZE  --disk SIZE   the sandbox's size, as for kyora vms create
  --wait DURATION | --no-wait   waiting for capacity (default 15m)
  --prompt TEXT           what the agent is told when it resumes (default: carry on, commit to the branch)
  --permission-mode MODE  the agent's permission mode in the VM (default ${DEFAULT_PERMISSION_MODE})
  --model MODEL           the model to carry on with (default: the one the conversation last used)
  --checkpoint DURATION   how often work is checkpointed and reported when something changed (default 10m, at least 1m)
  --git-depth N           commits of history the VM gets (default 50; 0 for all)
  --unsafe-copy-credentials SLOT   copy that kyora-switch slot's login into the VM.
                          The credential is then readable by everything that runs there.

pull / down / back:
  --keep                  back only: sync, but leave the session running in the cloud
  --stop                  end the session after syncing: its token, its children and its sandbox go
                          (only once the VM confirmed its last checkpoint; --force destroys it regardless)
  --pr                    push kyora/<name> to origin and open a pull request (gh), with your own git credentials
  --base BRANCH           the pull request's base (default: the branch you were on at up)

creds:
  --slot NAME             a kyora-switch slot (repeatable)
  --all                   sync: every kyora-switch slot of the provider
  --provider claude|codex (default claude)
  --setup-token / --api-key  a token from stdin instead of a slot (\`claude setup-token\` makes one that doesn't rotate); needs --name
  --allow-live            sync a slot even though it is this laptop's live login (one side will be signed out)
  --force                 sync: replace a cloud login, or overwrite a local slot on return

  --json                  machine-readable output
  -h, --help              this help

Never touches your checked-out branch or main: work comes back on kyora/<name>, or beside it as
refs/kyora/<name>-remote when kyora/<name> moved here too.`

const OPTIONS = {
  repo: { type: "string" },
  session: { type: "string" },
  latest: { type: "boolean" },
  agent: { type: "string" },
  name: { type: "string" },
  image: { type: "string" },
  ttl: { type: "string" },
  network: { type: "string" },
  cpus: { type: "string" },
  memory: { type: "string" },
  disk: { type: "string" },
  wait: { type: "string" },
  "no-share": { type: "boolean" },
  "no-wait": { type: "boolean" },
  prompt: { type: "string" },
  "permission-mode": { type: "string" },
  model: { type: "string" },
  checkpoint: { type: "string" },
  "git-depth": { type: "string" },
  "unsafe-copy-credentials": { type: "string" },
  stop: { type: "boolean" },
  keep: { type: "boolean" },
  pr: { type: "boolean" },
  base: { type: "string" },
  raw: { type: "boolean" },
  slot: { type: "string", multiple: true },
  provider: { type: "string" },
  "setup-token": { type: "boolean" },
  "api-key": { type: "boolean" },
  "allow-live": { type: "boolean" },
  force: { type: "boolean" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const

type Option = keyof typeof OPTIONS

const UP: Option[] = ["no-share", "repo", "session", "latest", "agent", "name", "image", "ttl", "network", "cpus", "memory", "disk", "wait", "no-wait", "prompt", "permission-mode", "model", "checkpoint", "git-depth", "unsafe-copy-credentials"]

const VERBS: Record<string, Option[]> = {
  up: UP,
  detach: UP,
  back: ["repo", "keep", "force", "pr", "base"],
  status: ["repo"],
  attach: ["repo", "raw"],
  pull: ["repo", "stop", "force", "pr", "base"],
  down: ["repo", "stop", "force", "pr", "base"],
  list: [],
  creds: ["slot", "all", "provider", "setup-token", "api-key", "allow-live", "force", "name"],
  guard: [],
}

export class SessionUsage extends Error {}
const usage = (text: string): never => {
  throw new SessionUsage(text)
}

const IMAGE = /^[a-z0-9][a-z0-9._-]{0,63}$/

async function repoOf(dir: string | undefined): Promise<string | null> {
  return repoTop(dir ?? ".").catch(() => null)
}

export async function sessionMain(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true; args: string[] }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    return usage((error as Error).message)
  }
  const { values, positionals } = parsed
  const [verb, ...rest] = positionals
  if (values.help || !verb || verb === "help") {
    console.log(SESSION_HELP)
    return 0
  }
  const allowed = VERBS[verb] ?? usage(`unknown session command "${verb}"; run \`kyora session --help\``)
  for (const name of Object.keys(values) as Option[]) if (name !== "json" && !allowed.includes(name)) usage(`session ${verb} does not take --${name}`)
  const json = Boolean(values.json)
  // the short pair: `detach [name]` is up, `back [name]` is pull --stop
  if (verb === "detach" && (rest.length > 1 || (rest.length === 1 && values.name))) usage("detach takes one name, as the first argument or --name")
  if (verb === "back" && rest.length > 1) usage(`back takes one session name, got ${rest.join(" ")}`)
  if (verb === "back" && values.keep && values.force) usage("--force goes with ending the session, not --keep")
  if (verb === "guard") return guard()
  if (verb === "list") return list(json)

  const api = new VmsClient(await loadConfig())
  switch (verb) {
    case "up":
    case "detach": {
      if (verb === "up" && rest.length > 0) usage(`session up takes no arguments, got ${rest.join(" ")}`)
      const name = values.name ?? rest[0]
      if (values.session && values.latest) usage("--session and --latest don't go together")
      const agent = (values.agent ?? "claude") as AgentId
      if (!AGENTS.includes(agent)) usage(`--agent must be one of ${AGENTS.join(", ")}`)
      const network = (values.network ?? "registries") as Network
      if (!NETWORKS.includes(network) || network === "none") usage("--network must be registries or open")
      const spec: CreateSpec = { network, ...(values["no-share"] ? { shareable: false } : {}) }
      if (values.cpus) spec.vcpus = positiveInt(values.cpus, "--cpus")
      if (values.memory) spec.memoryMb = memoryMb(values.memory)
      if (values.disk) spec.diskGb = diskGb(values.disk)
      const image = values.image ?? (process.env.KYORA_VMS_IMAGE?.trim() || undefined)
      if (image !== undefined) {
        if (!IMAGE.test(image)) usage("--image must be a short lowercase name, e.g. desktop")
        spec.image = image
      }
      if (values["no-wait"] && values.wait !== undefined) usage("--wait and --no-wait don't go together")
      const depth = values["git-depth"] === undefined ? 50 : values["git-depth"] === "0" ? 0 : positiveInt(values["git-depth"], "--git-depth")
      const checkpoint = values.checkpoint ? parseSeconds(values.checkpoint, "--checkpoint") : CHECKPOINT_EVERY_S
      if (checkpoint < CHECKPOINT_MIN_S) usage(`--checkpoint must be at least ${CHECKPOINT_MIN_S}s`)
      return up(api, {
        repo: values.repo ?? ".",
        ...(values.session ? { session: values.session } : {}),
        agent,
        ...(name ? { name } : {}),
        spec,
        wait: values["no-wait"] ? 0 : values.wait === undefined ? 15 * 60 : parseSeconds(values.wait, "--wait"),
        ttlSeconds: values.ttl ? parseSeconds(values.ttl, "--ttl") : 12 * 3600,
        ...(values.prompt ? { prompt: values.prompt } : {}),
        permissionMode: values["permission-mode"] ?? DEFAULT_PERMISSION_MODE,
        ...(values.model ? { model: values.model } : {}),
        checkpointSeconds: checkpoint,
        gitDepth: depth,
        ...(values["unsafe-copy-credentials"] ? { copyCredentials: values["unsafe-copy-credentials"] } : {}),
        json,
      })
    }
    case "status":
      return status(api, rest[0], await repoOf(values.repo), json)
    case "attach":
      return attach(api, rest[0], await repoOf(values.repo), Boolean(values.raw))
    case "pull":
    case "down":
      if (values.force && !values.stop) usage("--force goes with --stop")
      return pullSession(api, { ...(rest[0] ? { name: rest[0] } : {}), repo: await repoOf(values.repo), stop: Boolean(values.stop), force: Boolean(values.force), pr: Boolean(values.pr), ...(values.base ? { base: values.base } : {}), json })
    case "back":
      return pullSession(api, { ...(rest[0] ? { name: rest[0] } : {}), repo: await repoOf(values.repo), stop: !values.keep, force: Boolean(values.force), pr: Boolean(values.pr), ...(values.base ? { base: values.base } : {}), json })
    case "creds": {
      const [action, ...extra] = rest
      if (extra.length > 0) usage(`unexpected ${extra.join(" ")}`)
      const provider = (values.provider ?? "claude") as SlotProvider
      if (provider !== "claude" && provider !== "codex") usage("--provider must be claude or codex")
      const slots = values.slot ?? []
      switch (action) {
        case "sync": {
          if (values["setup-token"] && values["api-key"]) usage("--setup-token and --api-key don't go together")
          const kind = values["setup-token"] ? "oauth-token" : values["api-key"] ? "api-key" : null
          if (kind && !values.name) usage(`--${values["setup-token"] ? "setup-token" : "api-key"} needs --name for the credential`)
          if (!kind && slots.length === 0 && !values.all) usage("creds sync needs --slot NAME (repeatable) or --all")
          if (values.all && slots.length > 0) usage("--all and --slot don't go together")
          return credsSync(api, { provider, slots, all: Boolean(values.all), allowLive: Boolean(values["allow-live"]), force: Boolean(values.force), ...(kind ? { stdin: { kind, name: values.name! } } : {}), json })
        }
        case "list":
          return credsList(api, json)
        case "return":
          if (slots.length === 0) usage("creds return needs --slot NAME")
          return credsReturn(api, provider, slots, Boolean(values.force), json)
        case "rm":
          if (slots.length === 0) usage("creds rm needs --slot NAME")
          return credsRemove(api, provider, slots)
        default:
          return usage("usage: kyora session creds sync|list|return|rm")
      }
    }
  }
  return usage(`unknown session command "${verb}"`)
}
