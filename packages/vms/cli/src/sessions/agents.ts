import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { type PathMap, rebase, within } from "./paths"

/**
 * What a coding agent has to say for its conversation to move to a VM and back. Claude Code is
 * the one this was built for (claude.ts); Codex fits the same shape (codex.ts). Everything about
 * one agent's files, flags and credentials lives in its adapter; the session commands only move
 * what an adapter hands them.
 */

export type AgentId = "claude" | "codex"
export const AGENTS: AgentId[] = ["claude", "codex"]

/** a conversation on the laptop */
export interface LocalSession {
  agent: AgentId
  id: string
  /** the directory the agent ran in, as the agent spells it (Claude keys sessions by it) */
  cwd: string
  /** the transcript */
  file: string
  /** a directory that belongs to it (Claude's `<id>/`: subagent transcripts, tool results), or null */
  extra: string | null
  /** the model it last used, to carry on with */
  model: string | null
  /** the agent's version that last wrote it */
  version: string | null
}

/** a file for the VM, relative to its HOME */
export interface StagedFile {
  rel: string
  contents: string | Uint8Array
}

export interface ConfigOptions {
  /** whether the repo's .gitignore leaves this path (relative to the repo's top) out: then it didn't go up with the tree */
  ignored: (rel: string) => Promise<boolean>
  /** every file that went up with the tree, relative to the repo's top */
  files?: () => Promise<string[]>
}

export interface PreparedConfig {
  files: StagedFile[]
  /** what was left out, one line each, for the user to read */
  dropped: string[]
  /** extra arguments the agent needs for the config to apply (Claude: --setting-sources, --mcp-config) */
  args: string[]
}

export interface LaunchOptions {
  prompt: string
  permissionMode: string
  /** the kyora broker: where model calls go and the session's token for it; null when credentials were copied */
  broker: { baseUrl: string; token: string } | null
  /** arguments from `config` */
  configArgs: string[]
  /** the model to use, when the user picked one */
  model?: string
}

export interface LaunchPlan {
  argv: string[]
  env: Record<string, string>
  /** the npm package that brings the agent's binary, at the laptop's version */
  install: { bin: string; pkg: string; version: string | null }
}

export interface AgentAdapter {
  id: AgentId
  label: string
  /** finds a conversation of this repo: by id, or the newest one */
  find(options: { cwd: string; top: string; id?: string }): Promise<LocalSession>
  /** the transcript (and what belongs to it) as files for the VM's HOME, its paths moved by `map` */
  stage(session: LocalSession, map: PathMap): Promise<StagedFile[]>
  /** the project's own config for the VM: what is portable goes, what points at this laptop is dropped */
  config(session: LocalSession, map: PathMap, options: ConfigOptions): Promise<PreparedConfig>
  /** where the transcript is in the VM, relative to its HOME: what the export brings back */
  exportPaths(session: LocalSession, map: PathMap): { file: string; extra: string | null }
  launch(session: LocalSession, map: PathMap, options: LaunchOptions): LaunchPlan
  /** the transcript's text with one session id swapped for another (a fork gets an id of its own) */
  rename(text: string, from: string, to: string): string
  /** the transcript's text with its recorded working directories moved from one root to another */
  rewriteCwd(text: string, from: string, to: string): string
  /** where a fork with `id` goes on the laptop, next to `session` */
  forkFile(session: LocalSession, id: string): { file: string; extra: string | null }
  /** credentials copied into the VM (the explicit, unsafe opt-in): files under HOME from a kyora-switch slot's files */
  copiedCredentials(slotFiles: Record<string, string>): StagedFile[]
}

export class AgentError extends Error {}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")

export async function fileHash(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path))
  } catch {
    return null
  }
}

export const exists = (path: string) => lstat(path).then(() => true, () => false)

/** a JSONL text line by line through `edit`; lines that aren't JSON objects stay exactly as they were */
export function mapJsonl(text: string, edit: (entry: Record<string, unknown>) => boolean): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        return line
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return line
      return edit(entry as Record<string, unknown>) ? JSON.stringify(entry) : line
    })
    .join("\n")
}

/** `field` of an entry moved from one root to another, when it is a path under it */
export function moveField(entry: Record<string, unknown>, field: string, from: string, to: string): boolean {
  const value = entry[field]
  if (typeof value !== "string") return false
  const moved = rebase(value, from, to)
  if (moved === null || moved === value) return false
  entry[field] = moved
  return true
}

/** every file under `dir`, relative to it */
export async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  let names: string[]
  try {
    names = await readdir(join(dir, prefix))
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const rel = prefix ? `${prefix}/${name}` : name
    const stats = await lstat(join(dir, rel))
    if (stats.isDirectory()) out.push(...(await walk(dir, rel)))
    else if (stats.isFile()) out.push(rel)
  }
  return out
}

/** the repo root as the agent spells it: its recorded cwd, less however deep inside the repo that was */
export async function sessionRoot(cwd: string, top: string): Promise<string | null> {
  const real = await realpath(cwd).catch(() => cwd)
  const realTop = await realpath(top).catch(() => top)
  if (!within(realTop, real)) return null
  const rel = relative(realTop, real)
  if (!rel) return cwd
  return cwd.endsWith(`/${rel}`) ? cwd.slice(0, cwd.length - rel.length - 1) : null
}

/** written next to its final name, then moved over it: nothing reads half a transcript */
export async function writeAtomic(path: string, contents: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.kyora-${process.pid}-${Date.now()}.tmp`
  await writeFile(tmp, contents, { mode })
  await rename(tmp, path)
}

export interface ExportedConversation {
  /** the transcript as it came out of the VM */
  file: string
  /** its directory, if it had one */
  extra: string | null
}

export type RestoreOutcome =
  /** the laptop's copy is the VM's now */
  | { kind: "updated"; id: string; file: string; hash: string }
  /** nothing new on either side */
  | { kind: "unchanged"; id: string; file: string; hash: string }
  /** the laptop's copy moved on too: the VM's went in beside it under a new id */
  | { kind: "forked"; id: string; file: string; hash: string; from: string }

/**
 * The VM's conversation back onto the laptop. `local` is the copy that went up (or the fork a
 * previous pull made), `uploaded` its hash as it was then. When the laptop's copy is still that,
 * it is replaced by the VM's (paths moved back for a mapped session). When it changed (someone
 * resumed it here meanwhile), it is left alone, and the VM's becomes a new conversation with a
 * fresh id beside it: two drivers never write into one transcript.
 */
export async function restoreConversation(
  adapter: AgentAdapter,
  local: { session: LocalSession; file: string; extra: string | null; id: string },
  uploaded: string,
  exported: ExportedConversation,
  map: PathMap,
  newId: () => string = randomUUID,
): Promise<RestoreOutcome> {
  const remoteId = local.session.id
  const back = async (text: string, id: string) => {
    let out = map.local === map.remote ? text : adapter.rewriteCwd(text, map.remote, map.local)
    if (id !== remoteId) out = adapter.rename(out, remoteId, id)
    return out
  }
  const text = await readFile(exported.file, "utf8")
  const current = await fileHash(local.file)
  if (current !== null && current !== uploaded) {
    const id = newId()
    const target = adapter.forkFile(local.session, id)
    const contents = await back(text, id)
    await writeAtomic(target.file, contents)
    if (exported.extra && target.extra) await copyExtra(exported.extra, target.extra, (body) => back(body, id))
    return { kind: "forked", id, file: target.file, hash: sha256(contents), from: local.id }
  }
  const contents = await back(text, local.id)
  const hash = sha256(contents)
  if (current === hash) return { kind: "unchanged", id: local.id, file: local.file, hash }
  await writeAtomic(local.file, contents)
  if (exported.extra && local.extra) await copyExtra(exported.extra, local.extra, (body) => back(body, local.id))
  return { kind: "updated", id: local.id, file: local.file, hash }
}

/** a conversation's directory, file by file: transcripts in it get the same treatment as the main one */
async function copyExtra(from: string, to: string, transform: (text: string) => Promise<string>): Promise<void> {
  for (const rel of await walk(from)) {
    const source = join(from, rel)
    const contents = rel.endsWith(".jsonl") ? await transform(await readFile(source, "utf8")) : await readFile(source)
    await writeAtomic(join(to, rel), contents)
  }
}

/** a session id an agent made: a UUID, nothing that could walk out of its directory */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
