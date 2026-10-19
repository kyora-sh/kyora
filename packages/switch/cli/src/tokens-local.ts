import { constants as sqlite, Database } from "bun:sqlite"
import { constants, createReadStream, existsSync, statSync } from "node:fs"
import { chmod, mkdir, open, opendir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { agyDir } from "./providers/agy"
import { claudeDir } from "./providers/claude"
import { codexDir } from "./providers/codex"
import { grokHome } from "./providers/grok"
import { readSnapshot, rootDir, type Slot } from "./store"
import { identityKey, readHistory, subscriptionPrints } from "./token-history"
import type { ProviderId } from "./types"

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export const emptyCounts = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
export function addCounts(target: TokenCounts, value: TokenCounts): void {
  for (const key of Object.keys(target) as (keyof TokenCounts)[]) target[key] += value[key]
}
const PARTS = ["input", "output", "cacheRead", "cacheWrite"] as const

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
}
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
const time = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : NaN
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined
const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT"
const MAX_RECORD = 16 * 1024 * 1024
/** the cache's schema and what each parser yields: a cache another version wrote is dropped and recounted */
const CACHE_VERSION = 7

function parsed(parts: Buffer[], size: number): Record<string, any> | undefined {
  try { return object(JSON.parse(Buffer.concat(parts, size).toString("utf8"))) } catch { return undefined }
}

/**
 * One JSON object per line, streamed with at most one record (MAX_RECORD) in memory. With `end`,
 * only that many bytes are read: a log still being appended is read as it stood when its size was
 * taken. A last line without its newline that does not parse is still being written, not damaged.
 */
export async function* jsonLines(path: string, skipped: () => void, end?: number): AsyncGenerator<Record<string, any>> {
  if (end === 0) return
  let parts: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of createReadStream(path, end === undefined ? {} : { end: end - 1 })) {
    const bytes = chunk as Buffer
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const part = bytes.subarray(start, newline === -1 ? bytes.length : newline)
      size += part.length
      if (size > MAX_RECORD) { overflow = true; parts = [] }
      if (!overflow) parts.push(part)
      if (newline === -1) break
      if (overflow) skipped()
      else if (size) {
        const row = parsed(parts, size)
        if (row) yield row
        else skipped()
      }
      parts = []; size = 0; overflow = false
      start = newline + 1
    }
  }
  if (overflow) skipped()
  else if (size) {
    const row = parsed(parts, size)
    if (row) yield row
  }
}

async function* files(dir: string, extension: string): AsyncGenerator<string> {
  let entries
  try { entries = await opendir(dir) }
  catch (error) { if (gone(error)) return; throw error }
  for await (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path, extension)
    else if (entry.isFile() && entry.name.endsWith(extension)) yield resolve(path)
  }
}

/**
 * `scope`: what the tokens were billed to within the provider, when that differs per slot (OpenCode's Go or Zen).
 * `line`: Claude only, the usage this one log line states. A reply is logged once per content block, each
 * line with the whole reply's usage: the event counts it once, Claude Code's own stats count every line.
 */
interface Event extends TokenCounts { key: string; at: number; scope?: string; line?: TokenCounts }
function counts(input: unknown, output: unknown, read: unknown, write: unknown): TokenCounts {
  const value = { input: count(input), output: count(output), cacheRead: count(read), cacheWrite: count(write), total: 0 }
  value.total = value.input + value.output + value.cacheRead + value.cacheWrite
  return value
}

/** Codex's input_tokens includes the cached reads and writes, and output_tokens the reasoning */
function codexCounts(usage: Record<string, any>): TokenCounts {
  const read = count(usage.cached_input_tokens)
  const write = count(usage.cache_write_input_tokens)
  return counts(Math.max(0, count(usage.input_tokens) - read - write), usage.output_tokens, read, write)
}

/** OpenCode's subscriptions: Go (`opencode-go`) and Zen (`opencode`); a slot can hold either or both, so each is attributed on its own */
export const OPENCODE_SCOPES = ["opencode-go", "opencode"] as const

function opencodeEvent(row: Record<string, any>, key: string, at?: number): Event | null {
  if ((row.role ?? row.type) !== "assistant") return null
  const provider = row.providerID ?? row.model?.providerID
  if (!(OPENCODE_SCOPES as readonly string[]).includes(provider)) return null
  const usage = object(row.tokens)
  if (!Object.keys(usage).length) return null
  return {
    key: `opencode:${row.id ?? key}`,
    at: time(row.time?.created ?? at),
    scope: provider,
    ...counts(usage.input, count(usage.output) + count(usage.reasoning), usage.cache?.read, usage.cache?.write),
  }
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * Codex rollout files by rollout id: `rollout-<time>-<thread>.jsonl`, or `…-<thread>_<rollout>.jsonl`
 * for a reverted thread. A fork's parent is found here, by `forked_from_id` or `history_base`.
 */
export type CodexRollouts = Map<string, string>
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const ROLLOUT_NAME = new RegExp(`-(${UUID})(?:_(${UUID}))?\\.jsonl$`, "i")

export function indexRollouts(paths: string[]): CodexRollouts {
  const index: CodexRollouts = new Map()
  for (const path of paths) {
    const match = ROLLOUT_NAME.exec(basename(path))
    if (!match) continue
    const [, thread, rollout] = match
    if (rollout) index.set(rollout.toLowerCase(), path)
    // a thread's own file (no revert) is the one its id names; a reverted one stands in otherwise
    if (!rollout || !index.has(thread!.toLowerCase())) index.set(thread!.toLowerCase(), path)
  }
  return index
}

const isCounter = (row: Record<string, any>) => row.type === "event_msg" && row.payload?.type === "token_count" && row.payload.info?.total_token_usage
const isRecord = (row: Record<string, any>) => row.type === "token_usage_record" && row.payload?.usage

interface Origin {
  /** the thread this file is the rollout of */
  own?: string
  /** the thread it was forked from */
  parent?: string
  /** a fork that references its parent's file up to a byte offset instead of copying it (Codex's paginated history) */
  base?: { rollout: string; end: number }
}

async function origin(path: string, end: number): Promise<Origin> {
  for await (const row of jsonLines(path, () => {}, end)) {
    if (row.type !== "session_meta") return {}
    const meta = object(row.payload)
    const base = object(meta.history_base)
    return {
      own: text(meta.id)?.toLowerCase(),
      parent: text(meta.forked_from_id)?.toLowerCase(),
      ...(text(base.thread_id) && Number.isSafeInteger(base.end_byte_offset) ? { base: { rollout: text(base.thread_id)!.toLowerCase(), end: base.end_byte_offset } } : {}),
    }
  }
  return {}
}

/** a rollout's cumulative counter at a byte offset (the last one before it), following its own history base; null when none can be found */
async function counterAt(index: CodexRollouts, rollout: string, end: number, unresolved: Set<string>, depth = 0): Promise<TokenCounts | null> {
  const path = index.get(rollout)
  if (!path || depth > 8) { unresolved.add(rollout); return null }
  let last: TokenCounts | null = null
  try {
    if ((await stat(path)).size < end) { unresolved.add(rollout); return null }
    for await (const row of jsonLines(path, () => {}, end)) if (isCounter(row)) last = codexCounts(row.payload.info.total_token_usage)
  } catch { unresolved.add(rollout); return null }
  if (last) return last
  const from = await origin(path, end).catch((): Origin => ({}))
  return from.base ? counterAt(index, from.base.rollout, from.base.end, unresolved, depth + 1) : emptyCounts()
}

type Inheritance =
  /** not a fork: everything in the file is its own */
  | { kind: "own" }
  /** a copied fork whose own history starts at this row (its first thread_settings_applied of its own) */
  | { kind: "marker"; row: number }
  /** neither: the copy is the burst of rows written with the fork, within a second of each other (an estimate: partial) */
  | { kind: "burst" }

async function inheritance(path: string, end: number, from: Origin): Promise<Inheritance> {
  if (!from.parent || from.base) return { kind: "own" }
  let row = 0
  for await (const line of jsonLines(path, () => {}, end)) {
    if (line.type === "event_msg" && line.payload?.type === "thread_settings_applied" && text(line.payload.thread_id)?.toLowerCase() === from.own) return { kind: "marker", row }
    row++
  }
  return { kind: "burst" }
}

type Item = { kind: "count" | "record"; event: Event; cumulative?: TokenCounts }

/**
 * Which counter deltas the completion records already count, interval by interval: a counter's
 * interval is the records since the counter before it (Codex writes a response's record, then its
 * counter), or, when it had none, the records right after it that add up to it (the other order).
 * A covered delta is dropped for its records; an uncovered one is an older Codex's estimate and
 * counts, unless records had begun before it (that response's record is missing). Records that
 * don't add up to their counter, or that come after a later counter (another layout), also make the
 * file partial: the count can't be shown to be whole.
 */
function cover(items: Item[], partial: () => void): Event[] {
  if (!items.some(item => item.kind === "record")) return items.map(item => item.event)
  const out = new Set<Event>()
  const uncovered: Event[] = []
  // the last counter, with no records of its own yet; `late`: records had begun before it
  let open: { event: Event; cumulative?: TokenCounts; late: boolean } | null = null
  let gap = new Map<string, Event>()
  let recordTotal: TokenCounts | undefined
  let records = false
  let last = -Infinity
  const sum = (events: Map<string, Event>) => {
    const total = emptyCounts()
    for (const event of events.values()) addCounts(total, event)
    return total
  }
  const settle = () => {
    if (!open) return
    if (open.late) partial()
    out.add(open.event)
    uncovered.push(open.event)
    open = null
  }
  const same = (a: TokenCounts | undefined, b: TokenCounts | undefined) => a && b && PARTS.every(part => a[part] === b[part])
  const matches = (counter: Event, record: Event) => same(counter, record) || (counter.at === record.at && counter.output === record.output && counter.cacheRead === record.cacheRead && counter.total === record.total)
  const covered = (events: Map<string, Event>, counter: Event) => same(sum(events), counter) || (events.size === 1 && matches(counter, [...events.values()][0]!))
  for (const { kind, event, cumulative } of items) {
    if (kind === "record") {
      out.add(event)
      records = true
      if (event.at < last) {
        // a record from an earlier interval: it covers the uncovered counter it matches, and the layout is not one this knows
        partial()
        const match = [...uncovered].reverse().find(counter => matches(counter, event) && counter.at <= event.at && out.has(counter))
        if (match) out.delete(match)
        else if (open && matches(open.event, event) && open.event.at <= event.at) open = null
        continue
      }
      gap.set(event.key, event)
      recordTotal = cumulative
      continue
    }
    last = event.at
    if (!gap.size) {
      settle()
      open = { event, cumulative, late: records }
      continue
    }
    const coversOpen = open && covered(gap, open.event) && (!recordTotal || same(recordTotal, open.cumulative))
    const coversCurrent = covered(gap, event) && (!recordTotal || same(recordTotal, cumulative))
    gap = new Map()
    recordTotal = undefined
    if (coversOpen) {
      // the records after the open counter were its own: covered, and this counter is open now
      open = { event, cumulative, late: true }
      continue
    }
    // Codex's order: the records before this counter are its own
    if (!coversCurrent) partial()
    settle()
  }
  if (open && !(gap.size && covered(gap, open.event) && (!recordTotal || same(recordTotal, open.cumulative)))) settle()
  return [...out]
}

/**
 * A Codex rollout's usage. Completion records (`token_usage_record`) are exact, one per response;
 * older Codex only wrote cumulative counters (`token_count`), counted as the deltas between them.
 * A fork's file starts with its parent's history: copied (and re-timestamped as it was written)
 * up to the fork's own `thread_settings_applied`, or referenced up to a byte offset. Neither is
 * the fork's usage: copied counters only set where its own counter starts from, a referenced
 * parent's counter at that offset does the same, and records of another thread are its parent's.
 * Where the boundary can only be estimated, the file is partial.
 */
async function* codexEvents(path: string, skipped: () => void, end: number, index: CodexRollouts, unresolved: Set<string>): AsyncGenerator<Event> {
  const from = await origin(path, end)
  const plan = await inheritance(path, end, from)
  if (plan.kind === "burst") skipped()
  let previous = emptyCounts()
  let baseline = true
  // a referenced history (a fork's parent, or a reverted thread's own prefix): its counter at the offset is where this one starts
  if (from.base) {
    const start = await counterAt(index, from.base.rollout, from.base.end, unresolved)
    if (start) previous = start
    else { baseline = false; skipped() }
  }
  const items: Item[] = []
  let row = -1
  let copying = plan.kind !== "own"
  let burstStart: number | undefined
  for await (const line of jsonLines(path, skipped, end)) {
    row++
    if (row === 0 && line.type === "session_meta") continue
    if (copying) {
      if (plan.kind === "marker") copying = row < plan.row
      else if (plan.kind === "burst") {
        const at = time(line.timestamp)
        burstStart ??= at
        copying = Number.isFinite(at) && Math.abs(at - burstStart) <= 1000
      }
    }
    if (isRecord(line)) {
      const thread = text(line.payload.thread_id)?.toLowerCase()
      // a record of another thread, or one in the copied history: the parent's usage
      if (copying || (thread && from.own && thread !== from.own)) continue
      items.push({ kind: "record", event: { key: `codex:${line.payload.response_id ?? `${path}:${row}`}`, at: time(line.timestamp), ...codexCounts(line.payload.usage) }, ...(line.payload.total_usage ? { cumulative: codexCounts(line.payload.total_usage) } : {}) })
    } else if (isCounter(line)) {
      const usage = line.payload.info.total_token_usage
      const current = codexCounts(usage)
      // a context-window fill zeroes every part (only total_tokens survives), and the counter runs on from zero
      if (!current.total) { previous = current; continue }
      // a counter that went down started over (a restarted session): everything on it is new
      const restarted = PARTS.some((part) => current[part] < previous[part])
      const delta = emptyCounts()
      for (const part of PARTS) delta[part] = restarted ? current[part] : current[part] - previous[part]
      delta.total = delta.input + delta.output + delta.cacheRead + delta.cacheWrite
      previous = current
      // the copied history's counters, or the first one of a fork whose start is unknown: where its own count starts
      if (copying || !baseline) { baseline = true; continue }
      if (delta.total) items.push({ kind: "count", event: { key: `codex:legacy:${line.timestamp}:${JSON.stringify(usage)}`, at: time(line.timestamp), ...delta }, cumulative: current })
    }
  }
  yield* cover(items, skipped)
}

/**
 * One Grok Build session's usage.json: a row per turn, input counting the cached reads and writes.
 * A fork starts from a verbatim copy of its parent's turns, which share their parent's keys and so
 * count once; a subagent's own file is skipped, since its parent's turns already fold it in.
 */
async function* grokEvents(path: string, skipped: () => void, end: number): AsyncGenerator<Event> {
  if (end > MAX_RECORD) { skipped(); return }
  let summary
  try { summary = object(await Bun.file(join(dirname(path), "summary.json")).json()) } catch { summary = {} }
  if (typeof summary.session_kind === "string" && summary.session_kind.startsWith("subagent")) return
  let file
  try { file = object(JSON.parse(await Bun.file(path).slice(0, end).text())) } catch (error) { if (gone(error)) throw error; skipped(); return }
  if (!Array.isArray(file.turns)) { skipped(); return }
  for (const raw of file.turns) {
    const turn = object(raw)
    const valid = (value: unknown) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    if (!text(turn.endedAt) || ![turn.inputTokens, turn.outputTokens, turn.cachedReadTokens, turn.cacheCreationTokens].every(valid)) { skipped(); continue }
    const read = count(turn.cachedReadTokens)
    const write = count(turn.cacheCreationTokens)
    yield {
      key: `grok:${turn.endedAt}:${turn.turnNumber}`,
      at: time(turn.endedAt),
      ...counts(Math.max(0, count(turn.inputTokens) - read - write), turn.outputTokens, read, write),
    }
  }
}

async function* transcriptEvents(provider: ProviderId, path: string, skipped: () => void, end: number, rollouts: CodexRollouts, unresolved: Set<string>): AsyncGenerator<Event> {
  if (provider === "opencode") {
    if (end > MAX_RECORD) { skipped(); return }
    let row
    try { row = object(await Bun.file(path).json()) } catch (error) { if (gone(error)) throw error; skipped(); return }
    const event = opencodeEvent(row, path)
    if (event) yield event
    return
  }
  if (provider === "codex") return yield* codexEvents(path, skipped, end, rollouts, unresolved)
  if (provider === "grok") return yield* grokEvents(path, skipped, end)
  if (provider === "muse") {
    let index = 0
    for await (const row of jsonLines(path, skipped, end)) {
      index++
      const event = object(row.payload).event as Record<string, any> | undefined
      if (row.record_type !== "event" || row.payload_type !== "runtime.session" || object(row.payload).kind !== "run" || !event || event.kind !== "model_completed") continue
      const usage = event.usage
      if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).length === 0) { skipped(); continue }
      const cacheReadRaw = usage.cache_read_tokens !== undefined ? usage.cache_read_tokens : usage.cached_tokens
      const valid = (value: unknown) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      if (![usage.input_tokens, usage.output_tokens, cacheReadRaw, usage.cache_write_tokens].every(valid) || (usage.input_tokens === undefined && usage.output_tokens === undefined)) { skipped(); continue }
      const cacheRead = count(cacheReadRaw)
      const cacheWrite = count(usage.cache_write_tokens)
      const rawAt = row.recorded_at
      const at = typeof rawAt === "number" && rawAt > 1e14 ? rawAt / 1000 : time(rawAt)
      yield {
        key: `muse:${text(row.id) ?? `${path}:${index}`}`,
        at,
        ...counts(Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite), usage.output_tokens, cacheRead, cacheWrite),
      }
    }
    return
  }
  let index = 0
  for await (const row of jsonLines(path, skipped, end)) {
    index++
    if (row.type !== "assistant" || !row.message?.usage || row.message.model === "<synthetic>") continue
    const usage = row.message.usage
    const value = counts(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens)
    yield {
      key: `claude:${row.message.id ? `${row.requestId ?? ""}:${row.message.id}` : row.uuid ?? `${path}:${index}`}`,
      at: time(row.timestamp),
      ...value,
      line: value,
    }
  }
}

/** what a cached count was taken from: size and times, and for SQLite those of its write-ahead log as well */
async function signature(path: string, sqlite = false): Promise<{ stamp: string; size: number }> {
  const main = await stat(path)
  const wal = sqlite ? await stat(`${path}-wal`).catch(() => null) : null
  return { size: main.size, stamp: `${main.size}:${main.mtimeMs}:${main.ctimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}:${wal?.ctimeMs ?? 0}` }
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * OpenCode's messages, whichever schema the database has. Today's: `session_message`, whose sessions
 * are `session_v2` (a fork copies its parent's messages, with their times, and counts from its own
 * creation, as OpenCode's own stats do). Before that, V1's `message` table, which OpenCode migrates
 * session by session and leaves in place: a V1 message counts while its session is not migrated yet.
 */
function opencodeQuery(db: Database): string | null {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name))
  const columns = (table: string) => new Set((db.query(`PRAGMA table_info(${quoted(table)})`).all() as { name: string }[]).map(row => row.name))
  const data = (alias: string) => `CASE WHEN length(CAST(${alias}.data AS BLOB)) <= ${MAX_RECORD} THEN ${alias}.data END AS data`
  const parts: string[] = []
  let migrated: string | null = null
  if (tables.has("session_message")) {
    // the table its sessions are in: what its foreign key names, else today's or V1's
    const referenced = (db.query(`PRAGMA foreign_key_list("session_message")`).all() as { table: string; from: string }[]).find(key => key.from === "session_id")?.table
    const sessions = [referenced, "session_v2", "session"].find(name => name && tables.has(name))
    const own = sessions ? columns(sessions) : new Set<string>()
    const forks = own.has("fork_session_id") && own.has("time_created")
    const copies = forks && columns("session_message").has("seq")
      ? ` AND NOT EXISTS (SELECT 1 FROM session_message p WHERE p.session_id = s.fork_session_id AND p.seq = m.seq AND p.time_created = m.time_created)`
      : ""
    parts.push(`SELECT m.id AS id, m.time_created AS time_created, m.type AS type, ${data("m")} FROM session_message m${sessions ? ` LEFT JOIN ${quoted(sessions)} s ON s.id = m.session_id` : ""}
      WHERE m.type = 'assistant'${forks ? ` AND (s.fork_session_id IS NULL OR (m.time_created >= s.time_created${copies}))` : ""}`)
    migrated = sessions === "session_v2" ? "SELECT id FROM session_v2" : "SELECT DISTINCT session_id FROM session_message"
  }
  if (tables.has("message") && columns("message").has("data")) {
    const unmigrated = migrated && columns("message").has("session_id") ? ` WHERE l.session_id NOT IN (${migrated})` : ""
    parts.push(`SELECT l.id AS id, l.time_created AS time_created, NULL AS type, ${data("l")} FROM message l${unmigrated}`)
  }
  return parts.length ? parts.join(" UNION ALL ") : null
}

function* databaseEvents(path: string, skipped: () => void): Generator<Event> {
  const db = new Database(path, { readonly: true })
  try {
    const query = opencodeQuery(db)
    if (!query) { skipped(); return }
    // one statement, so one snapshot of a database opencode may be writing to meanwhile
    for (const raw of db.query(query).iterate()) {
      const row = raw as { id: string; time_created: number; type: string | null; data: string | null }
      if (row.data === null) { skipped(); continue }
      let data
      try { data = object(JSON.parse(row.data)) } catch { skipped(); continue }
      const event = opencodeEvent({ ...data, id: row.id, ...(row.type ? { type: row.type } : {}) }, row.id, row.time_created)
      if (event) yield event
    }
  } finally { db.close() }
}

/** the fields of one protobuf message, by number: varints as numbers, length-delimited ones as bytes; null when it does not parse */
export function protoFields(bytes: Uint8Array): Map<number, (number | Uint8Array)[]> | null {
  const fields = new Map<number, (number | Uint8Array)[]>()
  let at = 0
  const varint = (): number | null => {
    let value = 0
    for (let shift = 0; shift < 64; shift += 7) {
      if (at >= bytes.length) return null
      const byte = bytes[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    return null
  }
  while (at < bytes.length) {
    const key = varint()
    if (key === null) return null
    const field = Math.floor(key / 8)
    let value: number | Uint8Array
    switch (key % 8) {
      case 0: { const read = varint(); if (read === null) return null; value = read; break }
      case 1: at += 8; if (at > bytes.length) return null; continue
      case 2: {
        const length = varint()
        if (length === null || at + length > bytes.length) return null
        value = bytes.subarray(at, at + length); at += length; break
      }
      case 5: at += 4; if (at > bytes.length) return null; continue
      default: return null
    }
    fields.set(field, [...(fields.get(field) ?? []), value])
  }
  return fields
}

const protoNumber = (fields: Map<number, (number | Uint8Array)[]>, field: number): number => {
  const value = fields.get(field)?.at(-1)
  return typeof value === "number" ? value : 0
}
const protoMessage = (fields: Map<number, (number | Uint8Array)[]>, field: number): Uint8Array | undefined => {
  const value = fields.get(field)?.at(-1)
  return value instanceof Uint8Array ? value : undefined
}
const protoString = (fields: Map<number, (number | Uint8Array)[]>, field: number): string | undefined => {
  const value = protoMessage(fields, field)
  return value && value.length ? new TextDecoder().decode(value) : undefined
}

/**
 * One agy conversation database: a step's metadata (CortexStepMetadata) holds its creation time (1)
 * and, for a model reply, its usage (9: 2 input without cache reads, 3 output, 4 cache write, 5 cache
 * read, 7 message id, 11 response id). A fork copies its parent's steps with their ids, so they count once.
 */
export function* agyEvents(path: string, skipped: () => void): Generator<Event> {
  // agy keeps its databases in WAL mode and removes the side files when it exits. Without them, a read only
  // open fails (macOS) or creates side files it cannot remove (Linux), so a database with no WAL is read as
  // immutable; one with a WAL is being written by a running agy, whose side files the read shares
  // URI names are off by default in some SQLite builds (Bun's own on Linux), so the flag turns them on
  const immutable = () => new Database(`file:${path.replace(/[%?#]/g, char => `%${char.charCodeAt(0).toString(16)}`)}?immutable=1`, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_URI)
  const mtime = () => statSync(path, { throwIfNoEntry: false })?.mtimeMs
  const before = mtime()
  const walBefore = existsSync(`${path}-wal`)
  let db: Database
  if (!walBefore) db = immutable()
  else {
    try {
      db = new Database(path, { readonly: true })
      try { db.prepare("PRAGMA schema_version").get() } catch (error) { db.close(); throw error }
    } catch {
      // what is still only in the WAL is not read: partial
      skipped()
      db = immutable()
    }
  }
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(steps)").all() as { name: string }[]).map(row => row.name))
    if (!columns.has("idx") || !columns.has("metadata")) { skipped(); return }
    for (const raw of db.prepare(`SELECT idx, length(metadata) AS size, CASE WHEN length(metadata) <= ${MAX_RECORD} THEN metadata END AS metadata FROM steps`).iterate()) {
      const row = raw as { idx: number; size: number | null; metadata: Uint8Array | null }
      if (row.size !== null && row.size > MAX_RECORD) { skipped(); continue }
      if (!row.metadata) continue
      const step = protoFields(row.metadata)
      if (!step) { skipped(); continue }
      const usageBytes = protoMessage(step, 9)
      if (!usageBytes) continue
      const usage = protoFields(usageBytes)
      const created = protoFields(protoMessage(step, 1) ?? new Uint8Array())
      if (!usage || !created || !created.has(1)) { skipped(); continue }
      const id = protoString(usage, 7) ?? protoString(usage, 11)
      const value = counts(protoNumber(usage, 2), protoNumber(usage, 3), protoNumber(usage, 5), protoNumber(usage, 4))
      // a reply with no id is known by its creation time to the nanosecond and its counts, which a fork copies too
      const stamp = `${protoNumber(created, 1)}.${protoNumber(created, 2)}:${value.input}:${value.output}:${value.cacheRead}:${value.cacheWrite}`
      yield {
        key: `agy:${id ?? stamp}`,
        at: protoNumber(created, 1) * 1000 + Math.floor(protoNumber(created, 2) / 1e6),
        ...value,
      }
    }
    // an immutable read of a database agy started writing meanwhile may have missed or misread steps: partial
    if ((!walBefore && existsSync(`${path}-wal`)) || mtime() !== before) skipped()
  } finally { db.close() }
}

export interface LocalResult {
  slots: Map<string, TokenCounts>
  unattributed: TokenCounts
  total: TokenCounts
  filesRead: number
  filesCached: number
  skipped: number
  /** the oldest record counted, or null when there is none */
  since: number | null
  /** Claude: what every log line states, summed per UTC day, as Claude Code's own stats count it */
  lines: Map<string, TokenCounts>
}

export interface ClaudeCodeStats {
  /** every model's usage in Claude Code's stats cache: each log line counted, kept after the logs are deleted */
  counts: TokenCounts
  /** the last UTC day it covers; later days come from the logs */
  through: string
  /** its first session, or null when it doesn't say */
  firstUse: number | null
}

/** Claude Code's own stats cache (what `/stats` shows), or null when there is none or it can't be read */
export async function claudeCodeStats(): Promise<ClaudeCodeStats | null> {
  let handle
  try { handle = await open(join(claudeDir(), "stats-cache.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW) }
  catch { return null }
  try {
    if (!(await handle.stat()).isFile()) return null
    const bytes = Buffer.alloc(MAX_RECORD + 1)
    let length = 0
    for (let read = 1; read && length < bytes.length; length += read) read = (await handle.read(bytes, length, bytes.length - length, length)).bytesRead
    if (length > MAX_RECORD) return null
    const data = object(JSON.parse(bytes.subarray(0, length).toString("utf8")))
    const through = text(data.lastComputedDate)
    const models = Object.values(object(data.modelUsage)).map(object)
    if (!through || !/^\d{4}-\d{2}-\d{2}$/.test(through) || new Date(Date.parse(through)).toISOString().slice(0, 10) !== through || !models.length) return null
    const total = emptyCounts()
    const fields = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const
    for (const usage of models) {
      // a value Claude Code never writes (a fraction, a string, a negative) means the file isn't its stats: no figure rather than a wrong one
      if (!fields.every(field => usage[field] === undefined || (Number.isSafeInteger(usage[field]) && usage[field] >= 0))) return null
      addCounts(total, counts(usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens))
    }
    const first = time(data.firstSessionDate)
    return { counts: total, through, firstUse: Number.isFinite(first) ? first : null }
  } catch { return null }
  finally { await handle.close() }
}

export function cachePath(): string {
  return join(rootDir(), "token-cache-v1.sqlite")
}

export async function localTokens(provider: ProviderId, slots: Slot[]): Promise<LocalResult> {
  const result: LocalResult = { slots: new Map(slots.map(slot => [slot.name, emptyCounts()])), unattributed: emptyCounts(), total: emptyCounts(), filesRead: 0, filesCached: 0, skipped: 0, since: null, lines: new Map() }
  const path = cachePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: true })
  await chmod(path, 0o600)
  try {
    db.exec("PRAGMA busy_timeout = 30000; PRAGMA cache_size = -4096; PRAGMA temp_store = FILE")
    db.exec("BEGIN IMMEDIATE")
    if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== CACHE_VERSION) {
      db.exec(`DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS files;
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, signature TEXT NOT NULL, active INTEGER NOT NULL, skipped INTEGER NOT NULL, unresolved TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE events (file INTEGER NOT NULL, key TEXT NOT NULL, at REAL NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, scope TEXT,
          lineInput INTEGER NOT NULL DEFAULT 0, lineOutput INTEGER NOT NULL DEFAULT 0, lineCacheRead INTEGER NOT NULL DEFAULT 0, lineCacheWrite INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (file, key)) WITHOUT ROWID;
        PRAGMA user_version = ${CACHE_VERSION}`)
    }
    const known = db.query("SELECT id, signature, skipped, unresolved FROM files WHERE path = ?")
    const put = db.query(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file, key) DO UPDATE SET at = min(at, excluded.at),
      input = max(input, excluded.input), output = max(output, excluded.output), cacheRead = max(cacheRead, excluded.cacheRead), cacheWrite = max(cacheWrite, excluded.cacheWrite),
      lineInput = lineInput + excluded.lineInput, lineOutput = lineOutput + excluded.lineOutput, lineCacheRead = lineCacheRead + excluded.lineCacheRead, lineCacheWrite = lineCacheWrite + excluded.lineCacheWrite`)
    let rollouts: CodexRollouts = new Map()
    const scan = async (path: string, sqlite = false) => {
      let source
      try { source = await signature(path, sqlite) }
      catch (error) { if (!gone(error)) result.skipped++; return }
      const saved = known.get(path) as { id: number; signature: string; skipped: number; unresolved: string } | null
      const returning = saved && (JSON.parse(saved.unresolved) as string[]).some(rollout => rollouts.has(rollout))
      if (saved?.signature === source.stamp && !returning) {
        db.query("UPDATE files SET active = 1 WHERE id = ?").run(saved.id)
        result.filesCached++; result.skipped += saved.skipped
        return
      }
      db.exec("SAVEPOINT scan_file")
      try {
        const id = saved?.id ?? (db.query("INSERT INTO files (path, provider, signature, active, skipped) VALUES (?, ?, '', 0, 0) RETURNING id").get(path, provider) as { id: number }).id
        db.query("DELETE FROM events WHERE file = ?").run(id)
        let skipped = 0
        const unresolved = new Set<string>()
        const events = sqlite ? (provider === "agy" ? agyEvents : databaseEvents)(path, () => skipped++) : transcriptEvents(provider, path, () => skipped++, source.size, rollouts, unresolved)
        for await (const event of events) {
          if (!Number.isFinite(event.at)) { skipped++; continue }
          const line = event.line ?? emptyCounts()
          put.run(id, event.key, event.at, event.input, event.output, event.cacheRead, event.cacheWrite, event.scope ?? null, line.input, line.output, line.cacheRead, line.cacheWrite)
        }
        // what was read is the file as it stood at `source`: a log appended meanwhile, or a database
        // written past the snapshot just read, no longer matches it, so the next run reads it again
        db.query("UPDATE files SET signature = ?, active = 1, skipped = ?, unresolved = ? WHERE id = ?").run(source.stamp, skipped, JSON.stringify([...unresolved]), id)
        db.exec("RELEASE scan_file")
        result.filesRead++; result.skipped += skipped
      } catch (error) {
        db.exec("ROLLBACK TO scan_file; RELEASE scan_file")
        // deleted while it was being read: gone, like any other deleted log
        if (!gone(error)) result.skipped++
      }
    }
    db.query("UPDATE files SET active = 0 WHERE provider = ?").run(provider)
    const roots = provider === "claude" ? [join(claudeDir(), "projects")]
      : provider === "codex" ? [join(codexDir(), "sessions"), join(codexDir(), "archived_sessions")]
      : provider === "opencode" ? [join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "storage", "message")]
      : provider === "muse" ? [join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "muse", "sessions")]
      : provider === "grok" ? [join(grokHome(), "sessions")]
      : provider === "agy" ? [join(agyDir(), "conversations")]
      : []
    const opencodeDb = roots[0] ? resolve(dirname(dirname(roots[0])), "opencode.db") : ""
    if (provider === "opencode" && await Bun.file(opencodeDb).exists()) await scan(opencodeDb, true)
    else {
      const paths: string[] = []
      for (const root of roots) {
        try { for await (const path of files(root, provider === "opencode" || provider === "grok" ? ".json" : provider === "agy" ? ".db" : ".jsonl")) paths.push(path) }
        catch { result.skipped++ }
      }
      // a fork's parent may be any of them, in sessions or archived
      if (provider === "codex") rollouts = indexRollouts(paths)
      const selected = provider === "muse" ? paths.filter(path => basename(path) === "session.jsonl")
        : provider === "grok" ? paths.filter(path => basename(path) === "usage.json")
        : provider === "agy" ? paths.filter(path => new RegExp(`^${UUID}\\.db$`, "i").test(basename(path)))
        : paths
      for (const path of selected) await scan(path, provider === "agy")
    }

    const history = await readHistory(provider)
    result.skipped += history.broken + Number(history.partial)
    // a history that can't be read whole attributes nothing
    const switches = history.broken ? [] : history.rows
    // OpenCode's Go and Zen keys in each slot now: a switch's subscription counts for the slot only while it still holds that key
    const prints = new Map<string, Record<string, string>>()
    if (provider === "opencode") {
      for (const slot of slots) prints.set(slot.name, subscriptionPrints((await readSnapshot(provider, slot.name).catch(() => null))?.files ?? {}))
    }
    let next = 0
    let live: (typeof switches)[number] | undefined
    const totals = db.query(`SELECT min(e.at) AS at, max(e.input) AS input, max(e.output) AS output, max(e.cacheRead) AS cacheRead, max(e.cacheWrite) AS cacheWrite, max(e.scope) AS scope
      FROM events e JOIN files f ON f.id = e.file WHERE f.provider = ? AND f.active = 1 GROUP BY e.key ORDER BY at`)
    for (const raw of totals.iterate(provider)) {
      const event = raw as TokenCounts & { at: number; scope: string | null }
      event.total = event.input + event.output + event.cacheRead + event.cacheWrite
      while (next < switches.length && switches[next]!.at <= event.at) live = switches[next++]
      let slot = live?.slot && !live.gap ? slots.find(slot => slot.name === live!.slot && (live!.createdAt === null || slot.createdAt === live!.createdAt)) : undefined
      // renamed since: the slot that still has the creation time the load recorded
      if (!slot && live?.slot && !live.gap && live.createdAt) {
        const matches = slots.filter(slot => slot.createdAt === live!.createdAt)
        if (matches.length === 1) slot = matches[0]
      }
      if (slot && live?.identityKey && live.identityKey !== identityKey(slot.identity)) slot = undefined
      if (slot && history.unknown.some(interval => event.at > interval.from && event.at < interval.to)) slot = undefined
      // OpenCode: the slot held this subscription's key at the switch, and holds the same one now; a line from before subscriptions were kept says neither
      if (slot && provider === "opencode") {
        const recorded = event.scope ? live?.subscriptions?.[event.scope] : undefined
        if (!recorded || prints.get(slot.name)?.[event.scope!] !== recorded) slot = undefined
      }
      addCounts(slot ? result.slots.get(slot.name)! : result.unattributed, event)
      addCounts(result.total, event)
      result.since ??= event.at
    }
    if (provider === "claude") {
      const days = db.query(`SELECT strftime('%Y-%m-%d', e.at / 1000, 'unixepoch') AS day, sum(e.lineInput) AS input, sum(e.lineOutput) AS output, sum(e.lineCacheRead) AS cacheRead, sum(e.lineCacheWrite) AS cacheWrite
        FROM events e JOIN files f ON f.id = e.file WHERE f.provider = ? AND f.active = 1 GROUP BY day`)
      for (const raw of days.iterate(provider)) {
        const { day, ...line } = raw as TokenCounts & { day: string }
        result.lines.set(day, { ...line, total: line.input + line.output + line.cacheRead + line.cacheWrite })
      }
    }
    db.query("DELETE FROM events WHERE file IN (SELECT id FROM files WHERE provider = ? AND active = 0)").run(provider)
    db.query("DELETE FROM files WHERE provider = ? AND active = 0").run(provider)
    db.exec("COMMIT")
  } finally { db.close() }
  return result
}
