import { constants } from "node:fs"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { opencodeCredential } from "./identity"
import { SUBSCRIPTION_KEYS } from "./providers/opencode"
import { readSlot, readSnapshot, rootDir } from "./store"
import { accountKey, isProviderId, type Identity, type ProviderId } from "./types"

export function identityKey(identity: Identity): string {
  return createHash("sha256").update(JSON.stringify(accountKey(identity) ?? null)).digest("hex")
}

/** which slot each provider was switched to, and when: `tokens` attributes local logs by it. Older builds never read it. */
export function historyPath(): string {
  return join(rootDir(), "switch-history.jsonl")
}

/**
 * Switches whose outcome the history may not show: one line as each begins (`beginSwitch`), and one
 * when its history line could not be written. From each, until the next history line, `tokens`
 * attributes nothing, rather than putting it down to the slot that was live before.
 */
export function gapsPath(): string {
  return join(rootDir(), "switch-history.gaps.jsonl")
}

/** OpenCode's subscriptions in a slot, each by a fingerprint of its key: Go and Zen are attributed apart */
export function subscriptionPrints(files: Record<string, string>): Record<string, string> {
  let auth: Record<string, unknown> = {}
  try { auth = JSON.parse(files["auth.json"] ?? "{}") ?? {} } catch {}
  const prints: Record<string, string> = {}
  for (const key of SUBSCRIPTION_KEYS) {
    const credential = opencodeCredential(auth[key])
    if (credential) prints[key] = createHash("sha256").update(credential).digest("hex").slice(0, 16)
  }
  return prints
}

// never waits on a FIFO (or a device) and never follows a link: the file must be a regular one of ours
const WRITE = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW
const READ = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const MAX_HISTORY = 16 * 1024 * 1024
const ROTATE_HISTORY = 15 * 1024 * 1024
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(rootDir(), { recursive: true, mode: 0o700 })
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_HISTORY) throw failure("EFBIG", "too large")
  let handle: Awaited<ReturnType<typeof open>> | undefined = await open(path, WRITE, 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw failure("ENOTREG", "not a regular file")
    if (info.size && info.size + bytes >= ROTATE_HISTORY) {
      await handle.close()
      handle = undefined
      try { await rename(path, `${path}.${randomUUID()}.segment`) }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
      handle = await open(path, WRITE, 0o600)
      if (!(await handle.stat()).isFile()) throw failure("ENOTREG", "not a regular file")
    }
    const { bytesWritten } = await handle.write(line)
    if (bytesWritten !== bytes) throw failure("EIO", "short write")
  } finally { await handle?.close() }
}

function invalidPaths(provider: ProviderId): string[] {
  return [join(rootDir(), `switch-history.${provider}.invalid`), join(rootDir(), provider, ".switch-history.invalid")]
}

async function* historyFiles(skipped: () => void): AsyncGenerator<[string, boolean]> {
  yield [historyPath(), false]
  yield [gapsPath(), true]
  let names
  try { names = await readdir(rootDir()) }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") skipped(); return }
  for (const name of names) {
    if (/^switch-history\.jsonl\.[0-9a-f-]{36}\.segment$/.test(name)) yield [join(rootDir(), name), false]
    else if (/^switch-history\.gaps\.jsonl\.[0-9a-f-]{36}\.segment$/.test(name)) yield [join(rootDir(), name), true]
  }
}

async function invalidate(provider: ProviderId): Promise<void> {
  for (const path of invalidPaths(provider)) {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(rootDir(), { recursive: true, mode: 0o700 })
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile("invalid\n"); await handle.sync() }
      finally { await handle.close() }
      await rename(temp, path)
      return
    } catch (error) { debug("switch invalidation", error) }
    finally { await rm(temp, { force: true }).catch(() => {}) }
  }
}

/** a regular file's text, or null when there is none; anything else at the path (a FIFO, a directory) throws instead of blocking */
async function readRegular(path: string): Promise<{ text: string; partial: boolean; truncated: boolean } | null> {
  let handle
  try { handle = await open(path, READ) }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw failure("ENOTREG", "not a regular file")
    const start = Math.max(0, info.size - MAX_HISTORY * 2)
    const bytes = Buffer.alloc(Math.min(info.size, MAX_HISTORY * 2))
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, start + length)
      if (!bytesRead) break
      length += bytesRead
    }
    let text = bytes.subarray(0, length).toString("utf8")
    if (start) {
      const boundary = text.indexOf("\n")
      text = boundary === -1 ? "" : text.slice(boundary + 1)
    }
    return { text, partial: info.size > MAX_HISTORY, truncated: start > 0 }
  } finally { await handle.close() }
}

/** what KYORA_SWITCH_DEBUG=1 prints for a write that failed: the error's code alone, never a path or a message (private mode) */
function debug(what: string, error: unknown): void {
  if (process.env.KYORA_SWITCH_DEBUG !== "1") return
  const code = (error as NodeJS.ErrnoException)?.code
  console.error(`[kyora-switch] ${what} not written (${typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : "error"})`)
}

async function gap(provider: ProviderId, at: number): Promise<void> {
  try { await appendLine(gapsPath(), `${JSON.stringify({ provider, at })}\n`) }
  catch (error) { debug("switch gap", error); await invalidate(provider) }
}

/**
 * Before a load, save or clear changes the live login: from here until its history line, attribution is
 * unknown, so a switch that never gets its line (a crash, a history that can't be written) leaves a gap
 * instead of the slot before it. Never throws.
 */
export async function beginSwitch(provider: ProviderId, at = Date.now()): Promise<void> {
  await gap(provider, at)
}

/**
 * Appends one switch (a slot, or null for signed out). Never throws: a switch that went through is
 * never failed over its log. A line that can't be written leaves a gap where it can (`gapsPath`), so
 * later records stay unattributed rather than going to the slot before. KYORA_SWITCH_DEBUG=1 says on
 * stderr which write failed, by its error code.
 */
export async function recordSwitch(provider: ProviderId, slot: string | null, at = Date.now()): Promise<void> {
  try {
    const saved = slot === null ? null : await readSlot(provider, slot)
    const subscriptions = saved && provider === "opencode" ? subscriptionPrints((await readSnapshot(provider, saved.name))?.files ?? {}) : undefined
    await appendLine(historyPath(), `${JSON.stringify({ provider, slot, at, createdAt: saved?.createdAt, identityKey: saved && identityKey(saved.identity), ...(subscriptions ? { subscriptions } : {}) })}\n`)
  } catch (error) {
    debug("switch history", error)
    await gap(provider, at)
  }
}

export interface HistoryRow {
  at: number
  slot: string | null
  createdAt: number | null
  identityKey: string | null
  /** OpenCode: the subscriptions the slot held, by key fingerprint (null: a line from before they were kept) */
  subscriptions: Record<string, string> | null
  /** a switch whose outcome is unknown: nothing is attributed from here until the next line */
  gap: boolean
}

/**
 * One provider's switches, in time order (a gap before a line at the same moment). `broken` counts
 * what could not be read: a line that doesn't parse, or a history that isn't a regular file. Any of
 * it means attribution can't be trusted at all.
 */
export async function readHistory(provider: ProviderId): Promise<{ rows: HistoryRow[]; broken: number; partial: boolean; unknown: { from: number; to: number }[] }> {
  const rows: HistoryRow[] = []
  const segments: { gaps: boolean; first: number; last: number; truncated: boolean }[] = []
  let broken = 0
  let partial = false
  for await (const [path, gaps] of historyFiles(() => broken++)) {
    let content
    try { content = await readRegular(path) }
    catch { broken++; continue }
    if (content === null) continue
    partial ||= content.partial
    const segment = { gaps, first: Infinity, last: -Infinity, truncated: content.truncated }
    segments.push(segment)
    const end = content.text.lastIndexOf("\n") + 1
    if (content.text.slice(end).trim()) partial = true
    for (const raw of content.text.slice(0, end).split("\n")) {
      if (!raw.trim()) continue
      let row: Record<string, unknown>
      try { row = JSON.parse(raw) } catch { broken++; continue }
      if (!row || typeof row !== "object" || typeof row.provider !== "string" || !isProviderId(row.provider) || typeof row.at !== "number" || !Number.isFinite(row.at)) { broken++; continue }
      segment.first = Math.min(segment.first, row.at)
      segment.last = Math.max(segment.last, row.at)
      if (row.provider !== provider) continue
      if (gaps) {
        rows.push({ at: row.at, slot: null, createdAt: null, identityKey: null, subscriptions: null, gap: true })
        continue
      }
      if (row.slot !== null && typeof row.slot !== "string") { broken++; continue }
      const subscriptions = row.subscriptions && typeof row.subscriptions === "object" && !Array.isArray(row.subscriptions) ? row.subscriptions as Record<string, string> : null
      rows.push({
        at: row.at, slot: row.slot as string | null,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
        identityKey: typeof row.identityKey === "string" ? row.identityKey : null,
        subscriptions, gap: false,
      })
    }
  }
  for (const path of invalidPaths(provider)) {
    try { if (await readRegular(path) !== null) broken++ }
    catch { broken++ }
  }
  const unknown = segments.filter(segment => segment.truncated).map(segment => ({
    from: segments.reduce((last, previous) => !previous.truncated && previous.gaps === segment.gaps && previous.last < segment.first ? Math.max(last, previous.last) : last, -Infinity),
    to: segment.first,
  }))
  for (const interval of unknown) {
    if (Number.isFinite(interval.to)) rows.push({ at: interval.to, slot: null, createdAt: null, identityKey: null, subscriptions: null, gap: true })
  }
  rows.sort((a, b) => a.at - b.at || Number(b.gap) - Number(a.gap))
  return { rows, broken, partial, unknown }
}
