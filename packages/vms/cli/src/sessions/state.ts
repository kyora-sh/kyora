import { readdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentId } from "./agents"
import { sha256, writeAtomic } from "./agents"
import type { PathMap } from "./paths"

/**
 * What the laptop remembers about each session, one small file per session in
 * `$XDG_STATE_HOME/kyora/sessions` (default `~/.local/state/kyora/sessions`), 0600, named by the
 * session and its repo (`<name>@<repo hash>.json`): two repos may each have a kyora/s1. kyora
 * cloud keeps its own record (who drives, the sandbox, the last checkpoint); this one has what
 * only the laptop knows: which transcript went up and what it looked like then, so a pull can
 * tell whether someone resumed it here meanwhile. Files from before the repo was in the name
 * (`<name>.json`) are moved over the first time they are read.
 */

export type Driver = "cloud" | "local"

export interface SessionState {
  version: 1
  /** the branch is kyora/<name> */
  name: string
  /** kyora cloud's id for it (ses_…) */
  id: string
  url: string
  /** the repo's top level, as git spells it */
  repo: string
  agent: AgentId
  /** the agent's own id for the conversation, which the VM keeps using */
  agentSession: string
  /** the laptop's copy: the original, or the fork a pull made; `hash` as it was last written or read */
  local: { id: string; file: string; extra: string | null; hash: string }
  /** the transcript and its directory in the VM, relative to its HOME: what the supervisor exports */
  remoteFiles: { file: string; extra: string | null }
  map: PathMap
  mode: "same-path" | "mapped"
  /** the snapshot commit kyora/<name> started at */
  base: string
  /** HEAD when it went up */
  head: string | null
  /** the branch HEAD was on then, the default base of --pr */
  upstream: string | null
  sandbox: string
  /** the supervisor command in the sandbox (a resumable exec) */
  exec: string | null
  driver: Driver
  /** fingerprints of the credential slots this session's broker uses, as they were uploaded */
  slots?: Record<string, string>
  createdAt: string
  pulledAt: string | null
  stoppedAt: string | null
}

export const stateDir = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "kyora", "sessions")

/** a repo's short stable tag in state file names */
export const repoKey = (repo: string): string => sha256(`kyora-repo:${repo}`).slice(0, 12)

const fileOf = (repo: string, name: string) => join(stateDir(), `${name}@${repoKey(repo)}.json`)

export async function saveState(state: SessionState): Promise<void> {
  await writeAtomic(fileOf(state.repo, state.name), `${JSON.stringify(state, null, 2)}\n`, 0o600)
}

async function readState(path: string): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SessionState
  } catch {
    return null
  }
}

export async function loadState(name: string, repo: string): Promise<SessionState | null> {
  await migrate()
  return readState(fileOf(repo, name))
}

/** state files named by the session alone (before the repo was in the name), moved to `<name>@<repo>.json` */
async function migrate(): Promise<void> {
  for (const file of await readdir(stateDir()).catch(() => [] as string[])) {
    if (!file.endsWith(".json") || file.includes("@")) continue
    const old = join(stateDir(), file)
    const state = await readState(old)
    if (!state || typeof state.repo !== "string" || typeof state.name !== "string") continue
    // a file of that session already in the new place wins; the old one is dropped either way
    if (!(await readState(fileOf(state.repo, state.name)))) await saveState(state)
    await rm(old, { force: true })
  }
}

export async function listStates(): Promise<SessionState[]> {
  await migrate()
  const out: SessionState[] = []
  for (const file of (await readdir(stateDir()).catch(() => [] as string[])).sort()) {
    if (!file.endsWith(".json")) continue
    const state = await readState(join(stateDir(), file))
    if (state) out.push(state)
  }
  return out
}

export async function removeState(state: Pick<SessionState, "repo" | "name">): Promise<void> {
  await rm(fileOf(state.repo, state.name), { force: true })
}

/**
 * The session a command means: the one named (in this repo, else the only one of that name
 * anywhere), else the one of this repo still driven from the cloud, else the newest of this
 * repo. Several driven at once, or one name in several repos, need more to go on.
 */
export async function resolveState(name: string | undefined, repo: string | null): Promise<SessionState> {
  const all = await listStates()
  if (name) {
    const wanted = name.replace(/^kyora\//, "")
    const named = all.filter((state) => state.name === wanted)
    const here = repo === null ? [] : named.filter((state) => state.repo === repo)
    if (here.length === 1) return here[0]!
    if (named.length === 1) return named[0]!
    if (named.length > 1) throw new Error(`session ${wanted} exists in ${named.length} repos (${named.map((state) => state.repo).join(", ")}); run this from the one you mean, or pass --repo`)
    throw new Error(`no session ${name} here (\`kyora session list\` shows them)`)
  }
  const mine = all.filter((state) => repo === null || state.repo === repo)
  const driving = mine.filter((state) => state.driver === "cloud")
  if (driving.length === 1) return driving[0]!
  if (driving.length > 1) throw new Error(`${driving.length} sessions of this repo run in the cloud (${driving.map((s) => s.name).join(", ")}); name one`)
  const newest = mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!newest) throw new Error(repo ? `no session for ${repo}; \`kyora session up\` starts one` : "no sessions; `kyora session up` starts one")
  return newest
}

/** the session, if any, whose conversation `agentSession` is driven from the cloud right now */
export async function drivenFromCloud(agentSession: string): Promise<SessionState | null> {
  return (await listStates()).find((state) => state.driver === "cloud" && (state.agentSession === agentSession || state.local.id === agentSession)) ?? null
}

/**
 * What `creds sync` handed kyora cloud, by slot ("claude/work"): the fingerprint of the login as it
 * went, and the version kyora cloud gave it (what a later upload over it must name). Older files
 * hold the fingerprint alone.
 */
export interface Upload {
  fingerprint: string
  version: number | null
}

const uploadsFile = () => join(stateDir(), "..", "credentials.json")

async function uploadRecords(): Promise<Record<string, Upload>> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(uploadsFile(), "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
  const out: Record<string, Upload> = {}
  for (const [slot, value] of Object.entries(raw)) {
    if (typeof value === "string") out[slot] = { fingerprint: value, version: null }
    else if (value && typeof value === "object" && typeof (value as Upload).fingerprint === "string") {
      out[slot] = { fingerprint: (value as Upload).fingerprint, version: typeof (value as Upload).version === "number" ? (value as Upload).version : null }
    }
  }
  return out
}

/** by slot: the fingerprint each went up with */
export async function uploads(): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await uploadRecords()).map(([slot, upload]) => [slot, upload.fingerprint]))
}

export async function uploadOf(slot: string): Promise<Upload | null> {
  return (await uploadRecords())[slot] ?? null
}

export async function rememberUpload(slot: string, fingerprint: string, version: number | null = null): Promise<void> {
  await writeAtomic(uploadsFile(), `${JSON.stringify({ ...(await uploadRecords()), [slot]: { fingerprint, version } }, null, 2)}\n`, 0o600)
}

export async function forgetUpload(slot: string): Promise<void> {
  const current = await uploadRecords()
  delete current[slot]
  await writeAtomic(uploadsFile(), `${JSON.stringify(current, null, 2)}\n`, 0o600)
}

/** what `creds return` took back, by slot: the version, so a newer one in kyora cloud later stands out */
const returnsFile = () => join(stateDir(), "..", "returned.json")

async function returnRecords(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(returnsFile(), "utf8")) as Record<string, number>
  } catch {
    return {}
  }
}

export async function rememberReturn(slot: string, version: number): Promise<void> {
  await writeAtomic(returnsFile(), `${JSON.stringify({ ...(await returnRecords()), [slot]: version }, null, 2)}\n`, 0o600)
}

export async function returnedVersion(slot: string): Promise<number | null> {
  const version = (await returnRecords())[slot]
  return typeof version === "number" ? version : null
}

export async function uploadedFingerprint(slot: string): Promise<string | null> {
  return (await uploadRecords())[slot]?.fingerprint ?? null
}
