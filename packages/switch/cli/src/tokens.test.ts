import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PROVIDERS } from "./providers"
import { listSlots, renameSlot, rootDir, writeSnapshot } from "./store"
import { beginSwitch, gapsPath, historyPath, readHistory, recordSwitch } from "./token-history"
import { collectTokens } from "./tokens"
import { agyEvents, cachePath, localTokens } from "./tokens-local"
import { setPrivate, type ProviderId } from "./types"

const dirs = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KYORA_SWITCH_DIR", "GROK_HOME", "ANTIGRAVITY_GEMINI_DIR"] as const
const T = Date.parse("2026-01-01T00:00:00Z")
let root: string
let previous: Record<string, string | undefined>
let server: ReturnType<typeof Bun.serve> | undefined
const fixture = (name: string) => join(import.meta.dir, "fixtures", "tokens", name)

function assertSandbox(env: Record<string, string | undefined> = process.env): void {
  for (const key of dirs) expect(env[key]?.startsWith(`${root}/`)).toBe(true)
  expect(env.KYORA_SWITCH_NO_KEYCHAIN).toBe("1")
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyora-token-test-"))
  previous = Object.fromEntries([...dirs, "KYORA_CODEX_TOKENS_URL", "KYORA_SWITCH_NO_KEYCHAIN", "KYORA_SWITCH_PRIVATE"].map(key => [key, process.env[key]]))
  for (const key of dirs) process.env[key] = join(root, key.toLowerCase())
  process.env.KYORA_SWITCH_NO_KEYCHAIN = "1"
  process.env.KYORA_CODEX_TOKENS_URL = "http://127.0.0.1:1/no-network"
  delete process.env.KYORA_SWITCH_PRIVATE
  setPrivate(false)
  assertSandbox()
})
afterEach(async () => {
  server?.stop(true); server = undefined
  setPrivate(false)
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}
async function saved(provider: ProviderId, name = "work", at = 1) {
  return writeSnapshot(name, { provider, identity: { account: `${name}@example.com`, org: "Example Org", plan: "pro" }, capturedAt: at, files: {} })
}
async function copy(name: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await copyFile(fixture(name), path)
}
async function run(...args: string[]) {
  assertSandbox()
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "index.ts"), ...args], {
    env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

async function claudeFixture() {
  await saved("claude")
  await saved("claude", "home", 2)
  await recordSwitch("claude", "work", T + 1000)
  await recordSwitch("claude", "home", T + 3000)
  const path = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "project", "session.jsonl")
  await copy("claude.jsonl", path)
  return path
}

test("Claude deduplicates messages, attributes by time and preserves pre-switch usage", async () => {
  const path = await claudeFixture()
  await copy("claude.jsonl", join(dirname(path), "subagents", "copied.jsonl"))
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.unattributed.total).toBe(19)
  expect(data.slots.get("work")).toEqual({ input: 100, output: 15, cacheRead: 20, cacheWrite: 30, total: 165 })
  expect(data.slots.get("home")?.total).toBe(320)
  expect(data.total.total).toBe(504)
})

test("cache hits unchanged files and invalidates size, mtime, deletion and history independently", async () => {
  const path = await claudeFixture()
  const slots = await listSlots("claude")
  expect((await localTokens("claude", slots)).filesRead).toBe(1)
  expect((await localTokens("claude", slots)).filesCached).toBe(1)
  await appendFile(path, "{}\n")
  expect((await localTokens("claude", slots)).filesRead).toBe(1)
  await utimes(path, new Date(), new Date(Date.now() + 10_000))
  expect((await localTokens("claude", slots)).filesRead).toBe(1)
  await writeFile(historyPath(), "")
  const unattributed = await localTokens("claude", slots)
  expect(unattributed.filesCached).toBe(1)
  expect(unattributed.unattributed.total).toBe(504)
  expect((await stat(join(rootDir(), "token-cache-v1.sqlite"))).mode & 0o777).toBe(0o600)
  await rm(path)
  expect((await localTokens("claude", slots)).total.total).toBe(0)
})

test("clear ends an interval; renamed slots retain history; deleted slots become unattributed", async () => {
  await claudeFixture()
  await recordSwitch("claude", null, T + 2500)
  await renameSlot("claude", "work", "renamed")
  let data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("renamed")?.total).toBe(165)
  expect(data.slots.get("home")?.total).toBe(320)
  await rm(join(rootDir(), "claude", "home"), { recursive: true })
  data = await localTokens("claude", await listSlots("claude"))
  expect(data.unattributed.total).toBe(339)
  await writeFile(historyPath(), JSON.stringify({ provider: "claude", slot: "renamed", at: T + 1000, createdAt: 1 }) + "\n" + JSON.stringify({ provider: "claude", slot: null, at: T + 2500 }) + "\n")
  expect((await localTokens("claude", await listSlots("claude"))).unattributed.total).toBe(339)
})

test("damaged history disables attribution and damaged records mark partial counts", async () => {
  const path = await claudeFixture()
  await appendFile(path, "{broken\n")
  await appendFile(historyPath(), "{broken\n")
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.skipped).toBe(2)
  expect(data.unattributed.total).toBe(504)
})

test("Codex counters use deltas, deduplicate repeats, and include archived sessions", async () => {
  await saved("codex")
  await recordSwitch("codex", "work", T + 1000)
  await copy("codex.jsonl", join(process.env.CODEX_HOME!, "archived_sessions", "rollout.jsonl"))
  const data = await localTokens("codex", await listSlots("codex"))
  expect(data.unattributed.total).toBe(12)
  expect(data.slots.get("work")).toEqual({ input: 240, output: 30, cacheRead: 60, cacheWrite: 0, total: 330 })
})

test("Codex exact usage supersedes counter estimates and cache tokens are not counted twice", async () => {
  const path = join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl")
  await copy("codex-exact.jsonl", path)
  const rows = (await readFile(path, "utf8")).trim().split("\n")
  await appendFile(path, rows[1]! + "\n")
  const data = await localTokens("codex", [])
  expect(data.total).toEqual({ input: 75, output: 10, cacheRead: 20, cacheWrite: 5, total: 110 })
})

test("OpenCode storage counts Go and Zen only, including reasoning output", async () => {
  const path = join(process.env.XDG_DATA_HOME!, "opencode", "storage", "message", "session", "go.json")
  await copy("opencode.json", path)
  const data = JSON.parse(await readFile(path, "utf8"))
  await put(join(dirname(path), "other.json"), JSON.stringify({ ...data, id: "other", providerID: "openai" }))
  expect((await localTokens("opencode", [])).total).toEqual({ input: 100, output: 12, cacheRead: 20, cacheWrite: 30, total: 162 })
})

test("Muse session logs count model_completed usage, attribute by slot and ignore other files", async () => {
  await saved("muse")
  await saved("muse", "home", 2)
  await recordSwitch("muse", "work", T + 1000)
  await recordSwitch("muse", "home", T + 4000)
  const line = (id: string, recorded_at: number, usage: Record<string, unknown>) => JSON.stringify({
    id, record_type: "event", recorded_at, payload_type: "runtime.session",
    payload: { kind: "run", event: { kind: "model_completed", model: "muse-wonder-1.0", usage } },
  })
  const sessions = join(process.env.XDG_DATA_HOME!, "muse", "sessions", "2026", "01", "01")
  const first = join(sessions, "session-one", "session.jsonl")
  await put(first, [
    line("muse-before", T * 1000, { input_tokens: 10, output_tokens: 2, cached_tokens: 3, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 1 }),
    line("muse-work", (T + 2000) * 1000, { input_tokens: 100, output_tokens: 15, cached_tokens: 20, cache_read_tokens: 20, cache_write_tokens: 30, reasoning_tokens: 5 }),
    JSON.stringify({ id: "status-1", record_type: "event", recorded_at: (T + 2100) * 1000, payload_type: "runtime.session", payload: { kind: "run", event: { kind: "run_started" } } }),
    JSON.stringify({ id: "omit-1", record_type: "omitted_record", recorded_at: (T + 2200) * 1000 }),
    line("muse-bad", (T + 2300) * 1000, { input_tokens: "bad", output_tokens: 10 }),
    "{broken",
    "",
  ].join("\n"))
  await put(join(sessions, "session-two", "session.jsonl"), [
    line("muse-work", (T + 2000) * 1000, { input_tokens: 100, output_tokens: 15, cached_tokens: 20, cache_read_tokens: 20, cache_write_tokens: 30, reasoning_tokens: 5 }),
    line("muse-home", T + 5000, { input_tokens: 200, output_tokens: 20, cached_tokens: 40, cache_write_tokens: 60, reasoning_tokens: 4 }),
    "",
  ].join("\n"))
  await put(join(sessions, "session-one", "other.jsonl"), line("muse-ignored", (T + 2000) * 1000, { input_tokens: 9999, output_tokens: 9999 }) + "\n")

  const data = await localTokens("muse", await listSlots("muse"))
  expect(data.skipped).toBe(2)
  expect(data.unattributed).toEqual({ input: 6, output: 2, cacheRead: 3, cacheWrite: 1, total: 12 })
  expect(data.slots.get("work")).toEqual({ input: 50, output: 15, cacheRead: 20, cacheWrite: 30, total: 115 })
  expect(data.slots.get("home")).toEqual({ input: 100, output: 20, cacheRead: 40, cacheWrite: 60, total: 220 })
  expect(data.total).toEqual({ input: 156, output: 37, cacheRead: 63, cacheWrite: 91, total: 347 })
})

test("Muse records with a malformed reasoning_tokens still count", async () => {
  const line = (id: string, usage: Record<string, unknown>) => JSON.stringify({
    id, record_type: "event", recorded_at: (T + 2000) * 1000, payload_type: "runtime.session",
    payload: { kind: "run", event: { kind: "model_completed", model: "muse-wonder-1.0", usage } },
  })
  const path = join(process.env.XDG_DATA_HOME!, "muse", "sessions", "2026", "01", "01", "session-one", "session.jsonl")
  await put(path, [
    line("muse-reasoning", { input_tokens: 100, output_tokens: 15, cached_tokens: 20, cache_read_tokens: 20, cache_write_tokens: 30, reasoning_tokens: "bad" }),
    line("muse-cached", { input_tokens: 10, output_tokens: 2, cached_tokens: "bad", cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 1 }),
    "",
  ].join("\n"))
  const data = await localTokens("muse", [])
  expect(data.skipped).toBe(0)
  expect(data.total).toEqual({ input: 56, output: 17, cacheRead: 23, cacheWrite: 31, total: 127 })
})

test("Grok Build usage.json counts each turn once, forks included, attributes by slot and skips subagent files", async () => {
  await saved("grok")
  await saved("grok", "home", 2)
  await recordSwitch("grok", "work", T + 1000)
  await recordSwitch("grok", "home", T + 4000)
  const turn = (turnNumber: number, at: number, usage: Record<string, unknown>) => ({ turnNumber, endedAt: new Date(at).toISOString(), ...usage, totalTokens: 0, modelCalls: 1 })
  const before = turn(1, T, { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cacheCreationTokens: 1, reasoningTokens: 1 })
  const work = turn(2, T + 2000, { inputTokens: 100, outputTokens: 15, cachedReadTokens: 20, cacheCreationTokens: 30, reasoningTokens: 5 })
  const sessions = join(process.env.GROK_HOME!, "sessions", "%2FUsers%2Fa%2Frepo")
  await put(join(sessions, "s1", "usage.json"), JSON.stringify({ sessionId: "s1", session: { inputTokens: 110 }, turns: [before, work, turn(3, T + 2100, { inputTokens: "bad", outputTokens: 1 }), { turnNumber: 4 }] }))
  await put(join(sessions, "s1", "summary.json"), JSON.stringify({ session_kind: "fork" }))
  await put(join(sessions, "s2", "usage.json"), JSON.stringify({ sessionId: "s2", turns: [before, work, turn(3, T + 5000, { inputTokens: 200, outputTokens: 20, cachedReadTokens: 40, cacheCreationTokens: 60 })] }))
  await put(join(sessions, "s2", "summary.json"), JSON.stringify({ session_kind: "fork" }))
  await put(join(sessions, "sub", "usage.json"), JSON.stringify({ sessionId: "sub", turns: [turn(1, T + 2000, { inputTokens: 9999, outputTokens: 9999 })] }))
  await put(join(sessions, "sub", "summary.json"), JSON.stringify({ session_kind: "subagent" }))
  await put(join(sessions, "s3", "plan.json"), JSON.stringify({ turns: [turn(1, T + 2000, { inputTokens: 9999, outputTokens: 9999 })] }))
  await put(join(sessions, "s4", "usage.json"), "{broken")

  const data = await localTokens("grok", await listSlots("grok"))
  expect(data.skipped).toBe(3)
  expect(data.unattributed).toEqual({ input: 6, output: 2, cacheRead: 3, cacheWrite: 1, total: 12 })
  expect(data.slots.get("work")).toEqual({ input: 50, output: 15, cacheRead: 20, cacheWrite: 30, total: 115 })
  expect(data.slots.get("home")).toEqual({ input: 100, output: 20, cacheRead: 40, cacheWrite: 60, total: 220 })
  expect(data.total).toEqual({ input: 156, output: 37, cacheRead: 63, cacheWrite: 91, total: 347 })
})

/** a protobuf field: a varint, or a length-delimited message or string */
function proto(field: number, value: number | Uint8Array | string): Uint8Array {
  const varint = (n: number) => { const out: number[] = []; do { out.push((n % 128) + (n >= 128 ? 128 : 0)); n = Math.floor(n / 128) } while (n > 0); return out }
  if (typeof value === "number") return new Uint8Array([...varint(field * 8), ...varint(value)])
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  return new Uint8Array([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes])
}
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]))

/** an agy step's metadata (CortexStepMetadata): its creation time, and a reply's usage with its message id */
function agyStep(at: number, usage?: { input: number; output: number; read?: number; write?: number; id?: string }): Uint8Array {
  const created = proto(1, concat(proto(1, Math.floor(at / 1000)), proto(2, (at % 1000) * 1e6)))
  if (!usage) return concat(created, proto(4, "planner"))
  const stats = concat(proto(1, 7), proto(2, usage.input), proto(3, usage.output), proto(4, usage.write ?? 0), proto(5, usage.read ?? 0), ...(usage.id ? [proto(7, usage.id), proto(11, `resp-${usage.id}`)] : []))
  return concat(created, proto(9, stats), proto(11, 3))
}

function agyConversation(name: string, steps: (Uint8Array | null)[], wal = false): void {
  const dir = join(process.env.ANTIGRAVITY_GEMINI_DIR!, "antigravity-cli", "conversations")
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, name), { create: true })
  try {
    if (wal) db.exec("PRAGMA journal_mode=WAL")
    db.exec("CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `metadata` blob, PRIMARY KEY (`idx`))")
    steps.forEach((metadata, idx) => db.run("INSERT INTO steps (idx, metadata) VALUES (?, ?)", [idx, metadata]))
  } finally { db.close(true) }
  // agy's own SQLite removes the side files on exit; macOS's system SQLite keeps them
  if (wal) for (const side of ["-wal", "-shm"]) rmSync(join(dir, `${name}${side}`), { force: true })
}

test("agy conversation databases count each reply once, forks included, attribute by slot and skip unreadable steps", async () => {
  await saved("agy")
  await saved("agy", "home", 2)
  await recordSwitch("agy", "work", T + 1000)
  await recordSwitch("agy", "home", T + 4000)
  const before = agyStep(T, { input: 10, output: 2, read: 3, id: "bot-1" })
  const work = agyStep(T + 2000, { input: 100, output: 15, read: 20, write: 30, id: "bot-2" })
  // a reply with no ids at all, copied into the fork along with the rest
  const anonymous = agyStep(T + 2500, { input: 7, output: 1 })
  agyConversation("0b6f8f4e-1111-4c2a-9d3e-000000000001.db", [agyStep(T - 10), before, work, anonymous, null, new Uint8Array([0xff]), new Uint8Array(16 * 1024 * 1024 + 1)], true)
  agyConversation("0b6f8f4e-1111-4c2a-9d3e-000000000002.db", [before, work, anonymous, agyStep(T + 5000, { input: 200, output: 20, read: 40, write: 60 })])
  agyConversation("conversation_summaries.db", [agyStep(T + 2000, { input: 9999, output: 9999, id: "bot-x" })])
  const conversations = join(process.env.ANTIGRAVITY_GEMINI_DIR!, "antigravity-cli", "conversations")
  expect((await readdir(conversations)).sort()).toEqual(["0b6f8f4e-1111-4c2a-9d3e-000000000001.db", "0b6f8f4e-1111-4c2a-9d3e-000000000002.db", "conversation_summaries.db"])

  const data = await localTokens("agy", await listSlots("agy"))
  expect(data.skipped).toBe(2)
  expect(data.unattributed).toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 0, total: 15 })
  expect(data.slots.get("work")).toEqual({ input: 107, output: 16, cacheRead: 20, cacheWrite: 30, total: 173 })
  expect(data.slots.get("home")).toEqual({ input: 200, output: 20, cacheRead: 40, cacheWrite: 60, total: 320 })
  expect(data.since).toBe(T)
  // read only: agy's databases and their side files are left as they were
  expect((await readdir(conversations)).sort()).toEqual(["0b6f8f4e-1111-4c2a-9d3e-000000000001.db", "0b6f8f4e-1111-4c2a-9d3e-000000000002.db", "conversation_summaries.db"])
  expect((await localTokens("agy", await listSlots("agy"))).filesCached).toBe(2)
})

test("a running agy's conversation is read with what is still only in its WAL, and nothing is written", async () => {
  agyConversation("0b6f8f4e-1111-4c2a-9d3e-000000000003.db", [agyStep(T, { input: 10, output: 2, id: "bot-1" })], true)
  const path = join(process.env.ANTIGRAVITY_GEMINI_DIR!, "antigravity-cli", "conversations", "0b6f8f4e-1111-4c2a-9d3e-000000000003.db")
  const writer = new Database(path)
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
    writer.run("INSERT INTO steps (idx, metadata) VALUES (?, ?)", [1, agyStep(T + 1000, { input: 5, output: 1, id: "bot-2" })])
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0)
    const data = await localTokens("agy", [])
    expect(data.skipped).toBe(0)
    expect(data.total).toEqual({ input: 15, output: 3, cacheRead: 0, cacheWrite: 0, total: 18 })
  } finally { writer.close() }
})

test("an agy conversation that agy starts writing during the scan is partial", async () => {
  agyConversation("0b6f8f4e-1111-4c2a-9d3e-000000000004.db", [agyStep(T, { input: 10, output: 2, id: "bot-1" }), agyStep(T + 1000, { input: 5, output: 1, id: "bot-2" })])
  const path = join(process.env.ANTIGRAVITY_GEMINI_DIR!, "antigravity-cli", "conversations", "0b6f8f4e-1111-4c2a-9d3e-000000000004.db")
  const scan = async (during: () => Promise<unknown>) => {
    let skipped = 0
    let first = true
    for (const _event of agyEvents(path, () => skipped++)) if (first) { first = false; await during() }
    return skipped
  }
  expect(await scan(async () => {})).toBe(0)
  expect(await scan(() => writeFile(`${path}-wal`, ""))).toBe(1)
  await rm(`${path}-wal`)
  expect(await scan(() => utimes(path, new Date(), new Date(T)))).toBe(1)
})

test("OpenCode SQLite takes precedence over migrated JSON, reads WAL changes and never mutates messages", async () => {
  const dir = join(process.env.XDG_DATA_HOME!, "opencode")
  await copy("opencode.json", join(dir, "storage", "message", "session", "go.json"))
  const data = await readFile(fixture("opencode.json"), "utf8")
  const db = new Database(join(dir, "opencode.db"), { create: true })
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, data TEXT)")
    db.query("INSERT INTO message VALUES (?, ?, ?)").run("msg-go", T + 2000, data)
    expect((await localTokens("opencode", [])).total.total).toBe(162)
    expect((await localTokens("opencode", [])).filesCached).toBe(1)
    db.query("INSERT INTO message VALUES (?, ?, ?)").run("msg-second", T + 4000, data)
    expect((await localTokens("opencode", [])).total.total).toBe(324)
    expect(db.query("SELECT count(*) AS n FROM message").get()).toEqual({ n: 2 })
  } finally { db.close() }
})

test("an unsupported OpenCode database reports partial coverage even with legacy JSON present", async () => {
  const dir = join(process.env.XDG_DATA_HOME!, "opencode")
  await copy("opencode.json", join(dir, "storage", "message", "session", "go.json"))
  const db = new Database(join(dir, "opencode.db"), { create: true })
  db.exec("CREATE TABLE unknown_messages (id TEXT)")
  db.close()
  for (let scan = 0; scan < 2; scan++) {
    const data = await collectTokens([PROVIDERS.find(provider => provider.id === "opencode")!], true)
    expect(data.providers.opencode?.complete).toBe(false)
    expect(data.complete).toBe(false)
  }
})

test("token collection errors scrub account paths in private mode", async () => {
  process.env.KYORA_SWITCH_DIR = join(root, "alice@example.com", "switch")
  await mkdir(dirname(rootDir()), { recursive: true })
  await chmod(dirname(rootDir()), 0o000)
  try {
    const privateResult = await run("claude", "tokens", "--private")
    expect(privateResult.code).not.toBe(0)
    expect(privateResult.err).not.toContain("alice@example.com")
    const revealed = await run("claude", "tokens", "--reveal")
    expect(revealed.code).not.toBe(0)
    expect(revealed.err).toContain("alice@example.com")
  } finally { await chmod(dirname(rootDir()), 0o700) }
})

test("OpenCode's current schema: session_message under session_v2, forks counted from their creation, unmigrated V1 messages kept", async () => {
  const path = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db")
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  const message = JSON.parse(await readFile(fixture("opencode.json"), "utf8"))
  // a V2 assistant message: no id or role in the data (they are columns), the model's provider nested
  const { id: _id, role: _role, providerID: _provider, time: _time, ...rest } = message
  const v2 = (provider: string, created: number) => JSON.stringify({ ...rest, agent: "build", model: { providerID: provider, id: "glm-5", variant: "default" }, content: [], time: { created, completed: created + 5 } })
  try {
    db.exec(await readFile(fixture("opencode-schema.sql"), "utf8"))
    db.exec("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 0, 0, '[]')")
    const session = db.query("INSERT INTO session_v2 (id, project_id, fork_session_id, fork_boundary, slug, directory, version, time_created, time_updated) VALUES (?, 'global', ?, ?, ?, '/work', '2', ?, ?)")
    session.run("ses_parent", null, null, "parent", T, T)
    // forked after the parent's first answer: its copy keeps that answer's seq and time
    session.run("ses_fork", "ses_parent", JSON.stringify({ type: "after", messageID: "msg_parent_1" }), "fork", T + 3000, T + 3000)
    const insert = db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    insert.run("msg_parent_0", "ses_parent", "user", 0, T + 1000, T + 1000, JSON.stringify({ text: "hi", time: { created: T + 1000 } }))
    insert.run("msg_parent_1", "ses_parent", "assistant", 1, T + 2000, T + 2005, v2("opencode-go", T + 2000))
    insert.run("evt_fork_0", "ses_fork", "user", 0, T + 1000, T + 1000, JSON.stringify({ text: "hi", time: { created: T + 1000 } }))
    insert.run("evt_fork_1", "ses_fork", "assistant", 1, T + 2000, T + 2005, v2("opencode-go", T + 2000))
    insert.run("msg_fork_2", "ses_fork", "assistant", 2, T + 4000, T + 4005, v2("opencode", T + 4000))
    // V1: the parent's session was migrated (its V1 rows stay behind), another one not yet
    const v1 = db.query("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', ?, '/work', 'old', '1', ?, ?)")
    v1.run("ses_parent", "parent", T, T)
    v1.run("ses_v1_only", "old", T, T)
    const legacy = db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
    legacy.run("msg_parent_1", "ses_parent", T + 2000, T + 2005, JSON.stringify({ ...message, id: undefined }))
    legacy.run("msg_v1_only", "ses_v1_only", T + 500, T + 505, JSON.stringify({ ...message, id: undefined, providerID: "opencode" }))
  } finally { db.close() }
  const data = await localTokens("opencode", [])
  expect(data.skipped).toBe(0)
  // the parent's answer, the fork's own one and the unmigrated V1 one; not the fork's copy, not the migrated V1 row
  expect(data.total).toEqual({ input: 300, output: 36, cacheRead: 60, cacheWrite: 90, total: 486 })
})

async function codexSlot(name: string, account: string, owned = false) {
  await writeSnapshot(name, { provider: "codex", identity: { account: `${account}@example.com`, plan: "pro" }, capturedAt: Date.now(), files: {
    "auth.json": JSON.stringify({ tokens: { access_token: `fixture-${name}`, refresh_token: "fixture-refresh", account_id: account } }),
  } })
  if (owned) {
    const path = join(rootDir(), "codex", name, "slot.json")
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), cloudOwned: true }))
  }
}

test("route probes each slot with its own credentials, deduplicates account totals and leaves cloud-owned files untouched", async () => {
  const seen: string[] = []
  server = Bun.serve({ port: 0, fetch(request) {
    seen.push(`${request.headers.get("chatgpt-account-id")}:${request.headers.get("authorization")}`)
    return Response.json({ stats: { lifetime_tokens: request.headers.get("chatgpt-account-id") === "a" ? 1234 : 500 } })
  } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  await codexSlot("work", "a", true)
  await codexSlot("copy", "a")
  await codexSlot("home", "b")
  const path = join(rootDir(), "codex", "work", "auth.json")
  const before = await readFile(path, "utf8")
  const result = await collectTokens(PROVIDERS.filter(p => p.id === "codex"), false)
  expect(result.overall.total).toBe(1734)
  expect(result.overall.input).toBeNull()
  expect(result.providers.codex?.rows.find(row => row.slot === "work")?.cloudOwned).toBe(true)
  expect(seen.sort()).toEqual(["a:Bearer fixture-copy", "a:Bearer fixture-work", "b:Bearer fixture-home"])
  expect(await readFile(path, "utf8")).toBe(before)
})

test("unavailable account totals stay null, never silently become zero or local totals", async () => {
  server = Bun.serve({ port: 0, fetch() { return Response.json({ stats: {} }, { status: 403 }) } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  await codexSlot("work", "a")
  const result = await collectTokens(PROVIDERS.filter(p => p.id === "codex"), false)
  expect(result.providers.codex?.rows[0]?.counts.total).toBeNull()
  expect(result.complete).toBe(false)
})

test("JSON, provider selection, stored private mode and --reveal work without reading live credentials", async () => {
  await claudeFixture()
  await put(join(rootDir(), "settings.json"), JSON.stringify({ private: true }))
  const result = await run("tokens", "--local", "--json")
  expect(result.code).toBe(0)
  const data = JSON.parse(result.out)
  expect(data.overall.total).toBe(504)
  expect(Object.keys(data.providers)).toEqual(["claude", "codex", "opencode", "muse", "grok", "agy"])
  expect(result.out + result.err).not.toContain("@example.com")
  expect(result.out).not.toContain("Example Org")
  expect((await run("claude", "tokens", "--json", "--reveal")).out).toContain("work@example.com")
  const text = await run("claude", "tokens", "--private", "--detailed")
  expect(text.out).toContain("Claude   504 tokens   this Mac · all time")
  expect(text.out).toContain("cache write")
  expect(text.out).toContain("by account")
  expect(text.out).toContain("earlier")
  expect(text.out).not.toContain("@example.com")
})

test("the detailed view: compact totals, bars largest first, a card for every tool", async () => {
  const { compact } = await import("./tokens")
  expect([compact(0), compact(999), compact(1_234), compact(112_222_018_069), compact(266_734_021), compact(1_500_000_000_000)])
    .toEqual(["0", "999", "1.2K", "112B", "267M", "1.5T"])
  await claudeFixture()
  const text = await run("tokens", "--local", "--detailed")
  expect(text.code).toBe(0)
  for (const name of ["Claude", "Codex", "OpenCode", "Muse", "Grok Build", "Antigravity"]) expect(text.out).toMatch(new RegExp(`^${name} +\\d`, "m"))
  expect(text.out).toMatch(/^Claude {6}504 tokens/m)
  expect(text.out).toMatch(/^Grok Build {2}0 tokens/m)
  expect(text.out).toMatch(/^Antigravity 0 tokens/m)
  expect(text.out).toMatch(/^Total {7}504 tokens/m)
  const kinds = text.out.split("\n").filter(line => /^ {2}(cache read|cache write|output|input) /.test(line))
  const values = kinds.map(line => Number(line.trim().split(/\s{2,}/)[1]))
  expect(values).toEqual([...values].sort((a, b) => b - a))
})

test("the default view: the grand total, then one line per tool, in shared columns", async () => {
  await claudeFixture()
  const local = await run("tokens", "--local")
  expect(local.code).toBe(0)
  expect(local.out).toBe([
    "total      504   input 310   output 37   cache read 63   cache write 94",
    "claude     504   input 310   output 37   cache read 63   cache write 94",
    "codex        0   input 0     output 0    cache read 0    cache write 0",
    "opencode     0   input 0     output 0    cache read 0    cache write 0",
    "muse         0   input 0     output 0    cache read 0    cache write 0",
    "grok         0   input 0     output 0    cache read 0    cache write 0",
    "agy          0   input 0     output 0    cache read 0    cache write 0",
    "",
    "claude counts the logs Claude Code still keeps, from 2026-01-01.",
    "",
  ].join("\n"))
  // Codex's account route has only a total: the grand total's parts say they leave it out
  server = Bun.serve({ port: 0, fetch() { return Response.json({ stats: { lifetime_tokens: 1_234_567_890 } }) } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  await codexSlot("work", "a")
  const lines = (await run("tokens")).out.split("\n")
  expect(lines[0]).toBe("total      1.2b   input 310   output 37   cache read 63   cache write 94   (parts leave out codex)")
  expect(lines[2]).toBe("codex      1.2b   account lifetime total, no breakdown")
  // one tool: no separate total
  expect((await run("claude", "tokens", "--local")).out.split("\n")[0]).toBe("claude   504   input 310   output 37   cache read 63   cache write 94")
  const { amount } = await import("./tokens")
  expect([0, 999, 37_615_419, 519_900_000, 260_312_000_000, 1_500_000_000_000, 999_950, 999_999_999].map(amount)).toEqual(["0", "999", "37.6m", "519.9m", "260.3b", "1.5t", "1.0m", "1.0b"])
  // an account that reports nothing is unknown, not zero, and the remarks share one parenthesis
  server.stop(true)
  server = Bun.serve({ port: 0, fetch() { return Response.json({ stats: {} }, { status: 403 }) } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  expect((await run("codex", "tokens")).out).toBe("codex   unknown   unavailable   (partial)\n")
  expect((await run("tokens")).out.split("\n")[0]).toBe("total          504   input 310   output 37   cache read 63   cache write 94   (parts leave out codex, partial)")
})

test("Claude Code's /stats: its cache, then every log line after the day it covers; kyora counts each reply once", async () => {
  const path = await claudeFixture()
  await copy("claude.jsonl", join(dirname(path), "subagents", "agent-a.jsonl"))
  const statsPath = join(process.env.CLAUDE_CONFIG_DIR!, "stats-cache.json")
  const stats = (through: string) => JSON.stringify({
    version: 5, lastComputedDate: through, firstSessionDate: "2025-11-03T09:00:00.000Z", totalSessions: 3,
    modelUsage: {
      "claude-old": { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000, costUSD: 1, contextWindow: 0 },
      "claude-sonnet": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 },
    },
  })
  const claude = async () => (await collectTokens(PROVIDERS.filter(p => p.id === "claude"), false)).providers.claude!
  await put(statsPath, stats("2025-12-31"))
  let data = await claude()
  expect(data.counts.total).toBe(504)
  expect(data.since).toBe(T)
  // each of the 2 files: 4 lines, one reply logged twice, every line counted
  expect(data.claudeCode).toEqual({
    counts: { input: 1001 + 820, output: 2001 + 94, cacheRead: 3001 + 166, cacheWrite: 4001 + 248, total: 10_004 + 1328 },
    through: "2025-12-31", firstUse: Date.parse("2025-11-03T09:00:00.000Z"),
  })
  const text = (await run("claude", "tokens", "--local")).out
  expect(text).toContain("claude counts the logs Claude Code still keeps, from 2026-01-01. Claude Code deletes logs older than cleanupPeriodDays, so usage from 2025-11-03 until then is missing here.")
  expect(text).toContain("Claude Code's /stats says 11.3k (input 1.8k, output 2.1k, cache read 3.2k, cache write 4.2k): it counts a reply once per content block it logged, and keeps deleted days.")
  expect((await run("claude", "tokens", "--local", "--detailed")).out).toContain("  Claude Code's /stats says 11.3k")
  // a day the cache already covers is not counted again
  await put(statsPath, stats("2026-01-01"))
  expect((await claude()).claudeCode?.counts.total).toBe(10_004)
  // no cache, or one that is not a regular file or does not parse: no /stats line
  const fraction = JSON.parse(stats("2025-12-31"))
  fraction.modelUsage["claude-old"].inputTokens = 1.5
  for (const bad of ["link", "dir", "fifo", "junk", "huge", "fraction", "date", "none"]) {
    await rm(statsPath, { recursive: true, force: true })
    if (bad === "link") { await put(join(root, "elsewhere.json"), stats("2025-12-31")); await symlink(join(root, "elsewhere.json"), statsPath) }
    if (bad === "dir") await mkdir(statsPath)
    if (bad === "fifo") expect(Bun.spawnSync(["mkfifo", statsPath]).exitCode).toBe(0)
    if (bad === "junk") await put(statsPath, "{")
    if (bad === "huge") await put(statsPath, stats("2025-12-31").replace("{", `{"pad":"${"x".repeat(16 * 1024 * 1024)}",`))
    if (bad === "fraction") await put(statsPath, JSON.stringify(fraction))
    if (bad === "date") await put(statsPath, stats("2026-99-99"))
    data = await claude()
    expect(data.claudeCode).toBeUndefined()
    expect(data.counts.total).toBe(504)
  }
})

test("successful load and clear append history without changing the slot format", async () => {
  await codexSlot("work", "a")
  const path = join(rootDir(), "codex", "work", "slot.json")
  const before = Object.keys(JSON.parse(await readFile(path, "utf8")))
  expect((await run("codex", "load", "work")).code).toBe(0)
  expect((await run("codex", "clear")).code).toBe(0)
  const history = (await readFile(historyPath(), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(history.map(row => row.slot)).toEqual(["work", null])
  expect(history.every(row => row.provider === "codex" && typeof row.at === "number")).toBe(true)
  const after = Object.keys(JSON.parse(await readFile(path, "utf8"))).filter(key => key !== "live")
  expect(after.sort()).toEqual(before.sort())
})

test("replacing a slot's account leaves its earlier usage unattributed", async () => {
  await claudeFixture()
  await writeSnapshot("work", { provider: "claude", identity: { account: "replacement@example.com" }, capturedAt: T + 5000, files: {} })
  const result = await localTokens("claude", await listSlots("claude"))
  expect(result.slots.get("work")?.total).toBe(0)
  expect(result.unattributed.total).toBe(184)
})

test("Codex counter resets start a fresh delta without counting context-window estimates", async () => {
  const path = join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl")
  const rows = (await readFile(fixture("codex.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  const reset = { type: "event_msg", timestamp: "2026-01-01T00:00:05Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 200000 } } } }
  await put(path, [...rows, reset, { ...rows[0], timestamp: "2026-01-01T00:00:06Z" }].map(row => JSON.stringify(row)).join("\n"))
  expect((await localTokens("codex", [])).total.total).toBe(354)
})

const PARENT = "0199a000-0000-7000-8000-00000000000a"
const FORK = "0199a000-0000-7000-8000-00000000000f"
const rollout = (id: string, minute = "00") => `rollout-2026-01-01T00-${minute}-00-${id}.jsonl`
const lines = async (name: string) => (await readFile(fixture(name), "utf8")).trim().split("\n").map(line => JSON.parse(line))
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n"
function counter(at: string, input: number, output: number, cached: number) {
  const usage = { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: input + output }
  return { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } }
}
function record(at: string, response: string, input: number, output: number, cached: number, thread?: string) {
  return { type: "token_usage_record", timestamp: at, payload: { ...(thread ? { thread_id: thread } : {}), response_id: response, usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: 0, total_tokens: input + output } } }
}

test("equal adjacent Codex counter intervals are covered once by following records", async () => {
  await put(join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl"), jsonl([
    counter("2026-01-01T00:00:01Z", 100, 0, 0),
    record("2026-01-01T00:00:01.1Z", "response-1", 100, 0, 0),
    counter("2026-01-01T00:00:02Z", 200, 0, 0),
    record("2026-01-01T00:00:02.1Z", "response-2", 100, 0, 0),
  ]))
  const data = await localTokens("codex", [])
  expect(data.total.total).toBe(200)
  expect(data.skipped).toBe(0)
})

test("Codex record cumulative usage disambiguates equal adjacent counter intervals", async () => {
  const exact = record("2026-01-01T00:00:01.9Z", "response-2", 100, 0, 0)
  await put(join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl"), jsonl([
    counter("2026-01-01T00:00:01Z", 100, 0, 0),
    { ...exact, payload: { ...exact.payload, total_usage: { input_tokens: 200, output_tokens: 0 } } },
    counter("2026-01-01T00:00:02Z", 200, 0, 0),
  ]))
  const data = await localTokens("codex", [])
  expect(data.total.total).toBe(200)
  expect(data.skipped).toBe(0)
})

test("equal Codex interval totals with different components keep usage in the correct slot", async () => {
  await saved("codex")
  await saved("codex", "home", 2)
  await recordSwitch("codex", "work", T)
  await recordSwitch("codex", "home", T + 1500)
  await put(join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl"), jsonl([
    counter("2026-01-01T00:00:01Z", 100, 0, 0),
    record("2026-01-01T00:00:01.9Z", "response-2", 0, 100, 0),
    counter("2026-01-01T00:00:02Z", 100, 100, 0),
  ]))
  const data = await localTokens("codex", await listSlots("codex"))
  expect(data.total).toEqual({ input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 })
  expect(data.slots.get("work")?.input).toBe(100)
  expect(data.slots.get("home")?.output).toBe(100)
  expect(data.skipped).toBe(0)
})

test("Codex records retain cache-write corrections to counters at the same timestamp", async () => {
  const exact = (at: string, response: string) => {
    const row = record(at, response, 100, 10, 20)
    row.payload.usage.cache_write_input_tokens = 5
    return row
  }
  await put(join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl"), jsonl([
    counter("2026-01-01T00:00:01Z", 100, 10, 20),
    exact("2026-01-01T00:00:01Z", "response-1"),
    counter("2026-01-01T00:00:02Z", 200, 20, 40),
    exact("2026-01-01T00:00:02Z", "response-2"),
  ]))
  const data = await localTokens("codex", [])
  expect(data.total).toEqual({ input: 150, output: 20, cacheRead: 40, cacheWrite: 10, total: 220 })
  expect(data.skipped).toBe(0)
})

test("a Codex parent returning in stages keeps its cached fork baseline unresolved", async () => {
  const parentPath = join(process.env.CODEX_HOME!, "sessions", rollout(PARENT))
  const meta = jsonl([{ type: "session_meta", payload: { id: PARENT } }])
  const usage = jsonl([counter("2026-01-01T00:00:01Z", 100, 0, 0)])
  await put(join(process.env.CODEX_HOME!, "sessions", rollout(FORK, "10")), jsonl([
    { type: "session_meta", payload: { id: FORK, history_base: { thread_id: PARENT, end_byte_offset: Buffer.byteLength(meta + usage) } } },
    counter("2026-01-01T00:11:00Z", 150, 0, 0),
  ]))
  expect((await localTokens("codex", [])).skipped).toBe(1)
  await put(parentPath, meta)
  let data = await localTokens("codex", [])
  expect(data.skipped).toBe(1)
  expect(data.total.total).toBe(0)
  await appendFile(parentPath, usage.slice(0, -2))
  expect((await localTokens("codex", [])).skipped).toBe(1)
  await appendFile(parentPath, usage.slice(-2))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(150)
  expect(data.skipped).toBe(0)
  expect(data.filesRead).toBe(2)
  expect((await localTokens("codex", [])).filesCached).toBe(2)
})

test("an unmarked Codex fork keeps its own usage when its parent later reaches the same counter", async () => {
  const sessions = join(process.env.CODEX_HOME!, "sessions")
  const parent = await lines(rollout(PARENT))
  parent.push(counter("2026-01-01T00:12:00Z", 350, 37, 70))
  await put(join(sessions, rollout(PARENT)), jsonl(parent))
  const fork = (await lines(rollout(FORK, "10"))).filter(row => row.payload?.type !== "thread_settings_applied")
  await put(join(sessions, rollout(FORK, "10")), jsonl(fork))
  const data = await localTokens("codex", [])
  expect(data.total.total).toBe(387 + 45)
  expect(data.skipped).toBeGreaterThan(0)
})

test("a returning Codex parent resolves a cached history baseline", async () => {
  const parentPath = join(process.env.CODEX_HOME!, "archived_sessions", rollout(PARENT))
  const parent = await readFile(fixture(rollout(PARENT)), "utf8")
  const end = Buffer.byteLength(parent.split("\n").slice(0, 3).join("\n") + "\n")
  await put(join(process.env.CODEX_HOME!, "sessions", rollout(FORK, "10")), jsonl([
    { type: "session_meta", payload: { id: FORK, forked_from_id: PARENT, history_base: { thread_id: PARENT, end_byte_offset: end } } },
    counter("2026-01-01T00:11:00Z", 150, 15, 30),
  ]))
  expect((await localTokens("codex", [])).skipped).toBe(1)
  expect((await localTokens("codex", [])).filesCached).toBe(1)
  await put(parentPath, parent)
  let data = await localTokens("codex", [])
  expect(data.total.total).toBe(342 + 43)
  expect(data.skipped).toBe(0)
  expect(data.filesRead).toBe(2)
  await rm(parentPath)
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(43)
  expect(data.skipped).toBe(0)
  expect(data.filesCached).toBe(1)
})

test("mixed Codex sessions: coverage per counter interval, an older Codex's counters before the first record counted", async () => {
  const path = join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl")
  // upgraded mid-session: two counters from before records, then a record before its counter, then
  // a record whose counter was not written yet (the file is still being written)
  await put(path, jsonl([
    counter("2026-01-01T00:00:00Z", 10, 2, 3), counter("2026-01-01T00:00:02Z", 110, 12, 23),
    record("2026-01-01T00:00:03.9Z", "response-3", 200, 20, 40), counter("2026-01-01T00:00:04Z", 310, 32, 63),
    record("2026-01-01T00:00:06Z", "response-4", 100, 10, 0),
  ]))
  let data = await localTokens("codex", [])
  expect(data.total.total).toBe(342 + 110)
  expect(data.skipped).toBe(0)

  // a counter after records began that no record covers: counted, but the file is partial
  await put(path, jsonl([record("2026-01-01T00:00:01.9Z", "response-1", 10, 2, 3), counter("2026-01-01T00:00:02Z", 10, 2, 3), counter("2026-01-01T00:00:04Z", 110, 12, 23)]))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(122)
  expect(data.skipped).toBe(1)

  // a record written after its counter (the other order) covers that counter, every time
  await put(path, jsonl([counter("2026-01-01T00:00:02Z", 10, 2, 3), record("2026-01-01T00:00:02.1Z", "response-1", 10, 2, 3), counter("2026-01-01T00:00:04Z", 110, 12, 23), record("2026-01-01T00:00:04.1Z", "response-2", 100, 10, 20)]))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(122)
  expect(data.skipped).toBe(0)

  // a record from an earlier interval, after a later counter: it covers the counter it matches, and the file is partial
  const legacy = await readFile(fixture("codex.jsonl"), "utf8")
  const exact = (await readFile(fixture("codex-exact.jsonl"), "utf8")).trim().split("\n")[1]!
  await put(path, legacy + exact + "\n")
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(342)
  expect(data.skipped).toBe(1)
})

test("a copied Codex fork: its parent's history (re-timestamped) only sets where its own counter starts", async () => {
  const sessions = join(process.env.CODEX_HOME!, "sessions", "2026", "01", "01")
  await copy(rollout(PARENT), join(sessions, rollout(PARENT)))
  await copy(rollout(FORK, "10"), join(sessions, rollout(FORK, "10")))
  // the parent's 342, and the fork's own 387 - 342
  let data = await localTokens("codex", [])
  expect(data.total).toEqual({ input: 280, output: 37, cacheRead: 70, cacheWrite: 0, total: 387 })
  expect(data.skipped).toBe(0)

  const fork = await lines(rollout(FORK, "10"))
  const unmarked = fork.filter(row => row.payload?.type !== "thread_settings_applied")
  await put(join(sessions, rollout(FORK, "10")), jsonl(unmarked))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(387)
  expect(data.skipped).toBe(1)

  // a fork's count, once taken, holds when its parent goes
  await rm(join(sessions, rollout(PARENT)))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(45)
  expect(data.filesCached).toBe(1)
  // one never seen with its parent: the copy is the burst written with the fork, an estimate, so partial
  await rm(cachePath())
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(45)
  expect(data.skipped).toBe(1)

  // records in the copy are the parent's, by thread; the fork's own count
  await copy(rollout(PARENT), join(sessions, rollout(PARENT)))
  const parent = await lines(rollout(PARENT))
  parent.splice(3, 0, record("2026-01-01T00:00:03.9Z", "response-p3", 200, 20, 40, PARENT))
  await put(join(sessions, rollout(PARENT)), jsonl(parent))
  const copied = fork.slice()
  copied.splice(4, 0, { ...parent[3], timestamp: "2026-01-01T00:10:00.004Z" })
  copied.splice(copied.length - 1, 0, record("2026-01-01T00:10:59Z", "response-f1", 40, 5, 7, FORK))
  await put(join(sessions, rollout(FORK, "10")), jsonl(copied))
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(387)
  expect(data.skipped).toBe(0)
})

test("a Codex fork that references its parent's history starts its counter at the parent's, at the offset", async () => {
  const sessions = join(process.env.CODEX_HOME!, "archived_sessions")
  await copy(rollout(PARENT), join(sessions, rollout(PARENT)))
  const parent = await readFile(fixture(rollout(PARENT)), "utf8")
  // the parent's history up to (and with) its 122 counter
  const end = Buffer.byteLength(parent.split("\n").slice(0, 3).join("\n") + "\n")
  const meta = { timestamp: "2026-01-01T00:10:00Z", type: "session_meta", payload: { id: FORK, forked_from_id: PARENT, history_base: { thread_id: PARENT, end_ordinal_exclusive: 3, end_byte_offset: end }, timestamp: "2026-01-01T00:10:00Z", cwd: "/work", originator: "codex_cli_rs", cli_version: "0.120.0" } }
  const own = jsonl([meta, { timestamp: "2026-01-01T00:10:00.001Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_id: FORK, thread_settings: {} } }, counter("2026-01-01T00:11:00Z", 150, 15, 30)])
  await put(join(process.env.CODEX_HOME!, "sessions", rollout(FORK, "10")), own)
  let data = await localTokens("codex", [])
  // the parent's 342, and the fork's 165 - 122
  expect(data.total.total).toBe(342 + 43)
  expect(data.skipped).toBe(0)
  // never seen with its parent: where its counter started is unknown, so its first counter counts nothing, and partial
  await rm(join(sessions, rollout(PARENT)))
  await rm(cachePath())
  data = await localTokens("codex", [])
  expect(data.total.total).toBe(0)
  expect(data.skipped).toBe(1)
})

test("a log still being written counts what is complete, and the next run reads the rest", async () => {
  const path = await claudeFixture()
  const rows = (await readFile(path, "utf8")).trim().split("\n")
  const last = rows.pop()!
  await writeFile(path, `${rows.join("\n")}\n${last.slice(0, 40)}`)
  const slots = await listSlots("claude")
  const first = await localTokens("claude", slots)
  expect(first.skipped).toBe(0)
  expect(first.total.total).toBe(184)
  await appendFile(path, `${last.slice(40)}\n`)
  const second = await localTokens("claude", slots)
  expect(second.filesRead).toBe(1)
  expect(second.total.total).toBe(504)
})

test("a log appended during the scan is counted as it stood, not dropped as partial, and recounted next run", async () => {
  await saved("claude")
  const path = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "busy", "session.jsonl")
  const line = (n: number) => JSON.stringify({ type: "assistant", timestamp: new Date(T + n).toISOString(), requestId: `req-${n}`, message: { id: `msg-${n}`, model: "claude-sonnet", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "x".repeat(2000) }] } })
  await put(path, Array.from({ length: 5000 }, (_, n) => line(n)).join("\n") + "\n")
  let appended = 5000
  let scanning = true
  const writer = (async () => {
    while (scanning) {
      await appendFile(path, `${line(appended)}\n`)
      appended++
      await Bun.sleep(0)
    }
  })()
  const during = await localTokens("claude", await listSlots("claude"))
  scanning = false
  await writer
  expect(during.skipped).toBe(0)
  expect(during.total.total).toBeGreaterThanOrEqual(10_000)
  expect(during.total.total).toBeLessThanOrEqual(appended * 2)
  const after = await localTokens("claude", await listSlots("claude"))
  expect(after.skipped).toBe(0)
  expect(after.total.total).toBe(appended * 2)
})

test("a Codex counter that restarts lower counts the new counter in full", async () => {
  const path = join(process.env.CODEX_HOME!, "sessions", "rollout.jsonl")
  const rows = (await readFile(fixture("codex.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  // the fixture ends at 342; a restarted process starts its own counter, here at 122
  await put(path, [...rows, { ...rows[1], timestamp: "2026-01-01T00:00:06Z" }].map(row => JSON.stringify(row)).join("\n") + "\n")
  expect((await localTokens("codex", [])).total.total).toBe(342 + 122)
})

test("a cache another version wrote is dropped and recounted", async () => {
  const path = await claudeFixture()
  await mkdir(rootDir(), { recursive: true })
  const old = new Database(join(rootDir(), "token-cache-v1.sqlite"), { create: true })
  old.exec("CREATE TABLE files (path TEXT PRIMARY KEY, provider TEXT, signature TEXT, active INTEGER, skipped INTEGER); CREATE TABLE events (path TEXT, key TEXT, at REAL, input REAL, output REAL, cacheRead REAL, cacheWrite REAL, total REAL, exact INTEGER, PRIMARY KEY(path, key))")
  old.query("INSERT INTO files VALUES (?, 'claude', 'stale', 1, 0)").run(path)
  old.close()
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.filesRead).toBe(1)
  expect(data.total.total).toBe(504)
})

test("save starts an interval like load does, and a switch log that cannot be written never fails the switch", async () => {
  await put(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-live", refresh_token: "fixture-live-refresh", account_id: "a" } }))
  const saved = await run("codex", "save", "work")
  expect(saved.code).toBe(0)
  const history = (await readFile(historyPath(), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(history.map(row => [row.provider, row.slot])).toEqual([["codex", "work"]])
  expect(history[0].createdAt).toBe((await listSlots("codex"))[0]!.createdAt)

  await rm(historyPath())
  await mkdir(historyPath())
  const quiet = await run("codex", "load", "work")
  expect(quiet.code).toBe(0)
  expect(quiet.out).toContain(`codex → "work"`)
  expect(quiet.err).not.toContain("switch history")
  process.env.KYORA_SWITCH_DEBUG = "1"
  try {
    const debug = await run("codex", "clear")
    expect(debug.code).toBe(0)
    expect(debug.out).toContain("codex signed out locally")
    expect(debug.err).toContain("[kyora-switch] switch history not written")
    expect(debug.out).not.toContain("switch history")
  } finally { delete process.env.KYORA_SWITCH_DEBUG }
})

test("an account total that is missing says why", async () => {
  await codexSlot("live", "a")
  const expired = `x.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.y`
  await writeSnapshot("old", { provider: "codex", identity: { account: "old@example.com" }, capturedAt: 1, files: {
    "auth.json": JSON.stringify({ tokens: { access_token: expired, refresh_token: "fixture-refresh", account_id: "c" } }),
  } })
  await writeSnapshot("apikey", { provider: "codex", identity: { plan: "api key" }, capturedAt: 1, files: { "auth.json": JSON.stringify({ OPENAI_API_KEY: "fixture-key" }) } })
  const rows = (await collectTokens(PROVIDERS.filter(p => p.id === "codex"), false)).providers.codex!.rows
  const note = (slot: string) => rows.find(row => row.slot === slot)?.note
  expect(note("live")).toBe("Codex reported no total for this slot's token")
  expect(note("old")).toContain("expired")
  expect(note("apikey")).toContain("no ChatGPT login")
})

test("--local is only for tokens: elsewhere it fails before anything changes, as it did before tokens existed", async () => {
  for (const args of [["codex", "clear", "--local"], ["claude", "load", "work", "--local"], ["status", "--local"], ["status", "--detailed"], ["usage", "--detailed"]]) {
    const { err, code } = await run(...args)
    expect(code).not.toBe(0)
    expect(err).toContain(args.at(-1)!)
  }
})

test("a switch whose history line fails leaves a gap: what follows goes to no slot until the next line", async () => {
  await claudeFixture()
  // the history stays readable, but can't be appended to for a while
  await chmod(historyPath(), 0o400)
  await recordSwitch("claude", "home", T + 3000 + 500)
  await chmod(historyPath(), 0o600)
  const lines = (await readFile(historyPath(), "utf8")).trim().split("\n")
  expect(lines.map(line => JSON.parse(line).slot)).toEqual(["work", "home"])
  // without the gap, 320 at T + 4000 would be put down to "home" (the line at T + 3000)
  let data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("work")?.total).toBe(165)
  expect(data.slots.get("home")?.total).toBe(0)
  expect(data.unattributed.total).toBe(339)
  expect(data.skipped).toBe(0)
  // the next line that gets written ends the gap
  await recordSwitch("claude", "home", T + 3900)
  data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("home")?.total).toBe(320)

  // a switch begun and never recorded (the process died, both files unwritable after): unknown from where it began
  await rm(historyPath()); await rm(gapsPath())
  await recordSwitch("claude", "work", T + 1000)
  await beginSwitch("claude", T + 3000)
  data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("work")?.total).toBe(165)
  expect(data.unattributed.total).toBe(339)
})

test("readable but unwritable history and gaps durably invalidate attribution without failing a switch", async () => {
  await claudeFixture()
  await beginSwitch("claude", T)
  await chmod(historyPath(), 0o400)
  await chmod(gapsPath(), 0o400)
  await put(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-live", refresh_token: "fixture-live-refresh", account_id: "a" } }))
  const switched = await run("codex", "clear")
  expect(switched.code).toBe(0)
  expect(switched.out).toContain("codex signed out locally")
  await beginSwitch("claude", T + 3500)
  await recordSwitch("claude", "work", T + 3500)
  await chmod(historyPath(), 0o600)
  await chmod(gapsPath(), 0o600)
  expect((await readHistory("claude")).broken).toBeGreaterThan(0)
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("work")?.total).toBe(0)
  expect(data.slots.get("home")?.total).toBe(0)
  expect(data.unattributed.total).toBe(504)
})

test("an unwritable history root falls back to provider invalidation while credentials still load", async () => {
  await claudeFixture()
  await beginSwitch("claude", T)
  const auth = JSON.stringify({ tokens: { access_token: "fixture-loaded", refresh_token: "fixture-refresh", account_id: "a" } })
  await writeSnapshot("work", { provider: "codex", identity: {}, capturedAt: 1, files: { "auth.json": auth } })
  await chmod(historyPath(), 0o400)
  await chmod(gapsPath(), 0o400)
  await chmod(rootDir(), 0o500)
  try {
    const switched = await run("codex", "load", "work")
    expect(switched.code).toBe(0)
    expect(await readFile(join(process.env.CODEX_HOME!, "auth.json"), "utf8")).toBe(auth)
    await beginSwitch("claude", T + 3500)
    await recordSwitch("claude", "work", T + 3500)
  } finally {
    await chmod(rootDir(), 0o700)
    await chmod(historyPath(), 0o600)
    await chmod(gapsPath(), 0o600)
  }
  expect((await readHistory("codex")).broken).toBeGreaterThan(0)
  expect((await readHistory("claude")).broken).toBeGreaterThan(0)
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("work")?.total).toBe(0)
  expect(data.slots.get("home")?.total).toBe(0)
  expect(data.unattributed.total).toBe(504)
})

for (const rotate of [false, true]) {
  test(`concurrent history and gap appends preserve whole records${rotate ? " across rotation" : ""}`, async () => {
    await claudeFixture()
    await beginSwitch("claude", T)
    for (const path of [historyPath(), gapsPath()]) {
      await put(`${path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }))
      if (rotate) await appendFile(path, " ".repeat(16 * 1024 * 1024 - (await stat(path)).size - 1) + "\n")
    }
    const script = `
      import { beginSwitch, recordSwitch } from ${JSON.stringify(join(import.meta.dir, "token-history.ts"))}
      process.send("ready")
      const start = await new Promise(resolve => process.once("message", resolve))
      await Promise.all(Array.from({ length: 64 }, async (_, i) => {
        await beginSwitch("claude", start + i)
        await recordSwitch("claude", null, start + i)
      }))
    `
    assertSandbox()
    const ready: Promise<void>[] = []
    const children = Array.from({ length: 2 }, () => {
      let resolveReady: () => void
      ready.push(new Promise(resolve => { resolveReady = resolve }))
      return Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
        env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
        ipc(message) { if (message === "ready") resolveReady() },
      })
    })
    try {
      await Promise.all(ready)
      for (const [i, child] of children.entries()) child.send(T + 5000 + i * 100)
      expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0])
      const history = await readHistory("claude")
      expect(history.broken).toBe(0)
      expect(history.rows).toHaveLength(259)
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 64; j++) {
          expect(history.rows.filter(row => row.at === T + 5000 + i * 100 + j).map(row => row.gap)).toEqual([true, false])
        }
      }
      const names = await readdir(rootDir())
      expect(names.some(name => name.startsWith("switch-history.jsonl.") && name.endsWith(".segment"))).toBe(rotate)
      expect(names.some(name => name.startsWith("switch-history.gaps.jsonl.") && name.endsWith(".segment"))).toBe(rotate)
      for (const name of names.filter(name => name.endsWith(".jsonl") || name.endsWith(".segment"))) {
        const text = await readFile(join(rootDir(), name), "utf8")
        expect(text.endsWith("\n")).toBe(true)
        for (const line of text.split("\n").filter(line => line.trim())) expect(JSON.parse(line).provider).toBe("claude")
      }
    } finally {
      for (const child of children) child.kill("SIGKILL")
      await Promise.all(children.map(child => child.exited))
    }
  })
}

test("oversized history segments retain bounded tails and partial attribution", async () => {
  await claudeFixture()
  const segment = `${historyPath()}.00000000-0000-0000-0000-000000000000.segment`
  const line = JSON.stringify({ provider: "claude", slot: null, at: T }) + "\n"
  await put(segment, "{discarded\n" + " ".repeat(32 * 1024 * 1024) + "\n" + line)
  let history = await readHistory("claude")
  expect(history.broken).toBe(0)
  expect(history.partial).toBe(true)
  expect(history.rows).toHaveLength(4)
  let data = await localTokens("claude", await listSlots("claude"))
  expect(data.skipped).toBe(1)
  expect(data.slots.get("work")?.total).toBe(165)
  expect(data.slots.get("home")?.total).toBe(320)
  expect((await collectTokens(PROVIDERS.filter(p => p.id === "claude"), true)).complete).toBe(false)

  await writeFile(segment, " ".repeat(16 * 1024 * 1024) + "\n" + line)
  history = await readHistory("claude")
  expect(history.broken).toBe(0)
  expect(history.partial).toBe(true)
  expect(history.rows).toHaveLength(3)
  data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("home")?.total).toBe(320)
})

for (const gaps of [false, true]) {
  for (const retainedProvider of ["claude", "codex"]) {
    test(`discarded ${gaps ? "gap" : "history"} records leave an unknown interval before a ${retainedProvider} tail`, async () => {
      const transcript = await claudeFixture()
      await writeFile(historyPath(), (await readFile(historyPath(), "utf8")).split("\n")[0]! + "\n")
      const path = gaps ? gapsPath() : historyPath()
      const line = (at: number, provider = "claude") => JSON.stringify({ provider, at, ...(gaps ? {} : { slot: null }) }) + "\n"
      const previous = gaps ? line(T + 2500) : (await readFile(historyPath(), "utf8")).replace(String(T + 1000), String(T + 2500))
      await put(`${path}.00000000-0000-0000-0000-000000000001.segment`, previous)
      await put(`${path}.00000000-0000-0000-0000-000000000002.segment`, line(T + 3000) + " ".repeat(32 * 1024 * 1024) + "\n" + line(T + 4500, retainedProvider))
      if (gaps) await recordSwitch("claude", "work", T + 2500)
      await appendFile(transcript, JSON.stringify({ type: "assistant", timestamp: new Date(T + 4600).toISOString(), message: { id: "still-unknown", usage: { input_tokens: 11 } } }) + "\n")
      await recordSwitch("claude", "home", T + 4900)
      await appendFile(transcript, JSON.stringify({ type: "assistant", timestamp: new Date(T + 5000).toISOString(), message: { id: "recovered", usage: { input_tokens: 7 } } }) + "\n")

      const data = await localTokens("claude", await listSlots("claude"))
      expect(data.skipped).toBe(1)
      expect(data.slots.get("work")?.total).toBe(165)
      expect(data.slots.get("home")?.total).toBe(7)
      expect(data.unattributed.total).toBe(350)
      expect(data.total.total).toBe(522)
    })
  }
}

for (const size of [15, 16]) {
  test(`rotation at ${size} MiB keeps history and gap segments below the old reader's size limit`, async () => {
    await claudeFixture()
    await beginSwitch("claude", T)
    for (const path of [historyPath(), gapsPath()]) {
      await appendFile(path, " ".repeat(size * 1024 * 1024 - (await stat(path)).size - 1) + "\n")
    }
    await beginSwitch("claude", T + 3500)
    await recordSwitch("claude", "home", T + 3900)
    const segments = (await readdir(rootDir())).filter(name => name.endsWith(".segment"))
    expect(segments).toHaveLength(2)
    for (const name of segments) expect((await stat(join(rootDir(), name))).size).toBeLessThanOrEqual(16 * 1024 * 1024)
    const history = await readHistory("claude")
    expect(history.broken).toBe(0)
    expect(history.partial).toBe(false)
    expect(history.rows).toHaveLength(5)
  })
}

test("a crash mid-append skips one incomplete trailing history or gap line", async () => {
  await claudeFixture()
  await beginSwitch("claude", T)
  for (const path of [historyPath(), gapsPath()]) {
    assertSandbox()
    let ready: () => void
    const written = new Promise<void>(resolve => { ready = resolve })
    const script = `
      import { open } from "node:fs/promises"
      const handle = await open(${JSON.stringify(path)}, "a")
      await handle.write('{"provider":"claude","at":')
      process.send("written")
      await new Promise(() => {})
    `
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
      env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
      ipc(message) { if (message === "written") ready() },
    })
    try { await written }
    finally { child.kill("SIGKILL"); await child.exited }
  }
  const history = await readHistory("claude")
  expect(history.broken).toBe(0)
  expect(history.partial).toBe(true)
  expect(history.rows).toHaveLength(3)
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.skipped).toBe(1)
  expect(data.slots.get("work")?.total).toBe(165)
  expect(data.slots.get("home")?.total).toBe(320)
})

test("history and gap segments preserve attribution across the size boundary", async () => {
  await claudeFixture()
  await beginSwitch("claude", T)
  for (const path of [historyPath(), gapsPath()]) {
    await appendFile(path, " ".repeat(16 * 1024 * 1024 - (await stat(path)).size - 1) + "\n")
  }
  await beginSwitch("claude", T + 3500)
  await recordSwitch("claude", "home", T + 3900)
  expect((await readHistory("claude")).broken).toBe(0)
  const data = await localTokens("claude", await listSlots("claude"))
  expect(data.slots.get("work")?.total).toBe(165)
  expect(data.slots.get("home")?.total).toBe(320)
  expect(data.unattributed.total).toBe(19)
  expect((await readdir(rootDir())).filter(name => name.endsWith(".segment"))).toHaveLength(2)
})

test("a FIFO or a directory at the history paths never hangs a switch or tokens, and the debug line names no path", async () => {
  await saved("claude")
  await mkdir(rootDir(), { recursive: true })
  await rm(historyPath(), { force: true })
  await Bun.$`mkfifo ${historyPath()} ${gapsPath()}`.quiet()
  const started = Date.now()
  await recordSwitch("claude", "work", T + 1000)
  await beginSwitch("claude", T + 2000)
  expect(Date.now() - started).toBeLessThan(5000)
  const data = await localTokens("claude", await listSlots("claude"))
  // neither can be read: nothing is attributed
  expect(data.skipped).toBe(3)

  await put(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-live", refresh_token: "fixture-live-refresh", account_id: "a" } }))
  process.env.KYORA_SWITCH_DEBUG = "1"
  try {
    for (const args of [["codex", "save", "work"], ["codex", "load", "work"], ["codex", "clear"]]) {
      const result = await run(...args)
      expect(result.code).toBe(0)
      expect(result.err).toContain("[kyora-switch] switch history not written (ENXIO)")
      expect(result.err).toContain("[kyora-switch] switch gap not written (ENXIO)")
      expect(result.err).not.toContain(root)
      expect(result.err).not.toContain("switch-history")
    }
    await rm(historyPath()); await mkdir(historyPath())
    const dir = await run("codex", "load", "work", "--private")
    expect(dir.code).toBe(0)
    expect(dir.err).toContain("(EISDIR)")
    expect(dir.err).not.toContain(root)
  } finally { delete process.env.KYORA_SWITCH_DEBUG }
})

async function opencodeSlot(name: string, keys: { go?: string; zen?: string }) {
  const auth = { ...(keys.go ? { "opencode-go": { type: "api", key: keys.go } } : {}), ...(keys.zen ? { opencode: { type: "api", key: keys.zen } } : {}) }
  await writeSnapshot(name, { provider: "opencode", identity: { account: `key …${(keys.go ?? keys.zen)!.slice(-4)}`, plan: keys.go && keys.zen ? "Go + Zen" : keys.go ? "Go" : "Zen" }, capturedAt: 1, files: { "auth.json": `${JSON.stringify(auth, null, 2)}\n` } })
}

test("OpenCode attributes Go and Zen apart: a subscription goes to the slot only while it held that key", async () => {
  await opencodeSlot("go", { go: "fixture-go-1111" })
  await opencodeSlot("both", { go: "fixture-go-2222", zen: "fixture-zen-3333" })
  await recordSwitch("opencode", "go", T + 1000)
  await recordSwitch("opencode", "both", T + 3000)
  const dir = join(process.env.XDG_DATA_HOME!, "opencode", "storage", "message", "session")
  const message = JSON.parse(await readFile(fixture("opencode.json"), "utf8"))
  const at = async (id: string, provider: string, created: number) => put(join(dir, `${id}.json`), JSON.stringify({ ...message, id, providerID: provider, time: { created } }))
  await at("go-early", "opencode-go", T + 2000)
  await at("zen-early", "opencode", T + 2000)
  await at("go-late", "opencode-go", T + 4000)
  await at("zen-late", "opencode", T + 4000)
  let data = await localTokens("opencode", await listSlots("opencode"))
  // "go" held no Zen key: the Zen key live then was someone else's
  expect(data.slots.get("go")?.total).toBe(162)
  expect(data.slots.get("both")?.total).toBe(324)
  expect(data.unattributed.total).toBe(162)

  // "both" saved again with another Zen key: its earlier Zen usage was the old key's
  await opencodeSlot("both", { go: "fixture-go-2222", zen: "fixture-zen-4444" })
  data = await localTokens("opencode", await listSlots("opencode"))
  expect(data.slots.get("both")?.total).toBe(162)
  expect(data.unattributed.total).toBe(324)

  // a line from before subscriptions were kept says nothing about either
  await writeFile(historyPath(), JSON.stringify({ provider: "opencode", slot: "go", at: T + 1000, createdAt: 1 }) + "\n")
  data = await localTokens("opencode", await listSlots("opencode"))
  expect(data.unattributed.total).toBe(648)
})

const idToken = (claims: Record<string, unknown>, email: string) => `fixture.${Buffer.from(JSON.stringify({ email, "https://api.openai.com/auth": claims })).toString("base64url")}.fixture`

test("Codex account totals: one login counts once whatever its email, two users of one workspace count apart", async () => {
  const totals: Record<string, number> = { "fixture-work": 1000, "fixture-renamed": 1200, "fixture-teammate": 300, "fixture-old-1": 50, "fixture-old-2": 70 }
  server = Bun.serve({ port: 0, fetch(request) {
    return Response.json({ stats: { lifetime_tokens: totals[(request.headers.get("authorization") ?? "").replace("Bearer ", "")] ?? 0 } })
  } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  const slot = async (name: string, email: string, account: string, user?: string) => writeSnapshot(name, { provider: "codex", identity: { account: email, plan: "team" }, capturedAt: Date.now(), files: {
    "auth.json": JSON.stringify({ tokens: { id_token: idToken({ chatgpt_account_id: account, ...(user ? { chatgpt_user_id: user } : {}) }, email), access_token: `fixture-${name}`, refresh_token: "fixture-refresh", account_id: account } }),
  } })
  await slot("work", "alice@old.example", "acct-team", "user-alice")
  await slot("renamed", "alice@new.example", "acct-team", "user-alice")
  await slot("teammate", "bob@new.example", "acct-team", "user-bob")
  let result = await collectTokens(PROVIDERS.filter(p => p.id === "codex"), false)
  let rows = result.providers.codex!.rows
  // slots in name order: "renamed" first, and "work" (another email, the same account and user) is its duplicate
  expect(rows.find(row => row.slot === "renamed")?.included).toBe(true)
  expect(rows.find(row => row.slot === "work")).toMatchObject({ included: false, duplicateOf: "renamed" })
  expect(rows.find(row => row.slot === "teammate")?.included).toBe(true)
  // the login's larger total, once, and the teammate's
  expect(result.overall.total).toBe(1200 + 300)
  expect(result.complete).toBe(true)

  // tokens that name no user: their workspace's slots can't be told apart, so they count once, and the total is partial
  await slot("old-1", "carol@legacy.example", "acct-legacy")
  await slot("old-2", "dave@legacy.example", "acct-legacy")
  result = await collectTokens(PROVIDERS.filter(p => p.id === "codex"), false)
  rows = result.providers.codex!.rows
  expect(rows.filter(row => row.slot?.startsWith("old-") && row.included)).toHaveLength(1)
  expect(result.overall.total).toBe(1200 + 300 + 70)
  expect(result.complete).toBe(false)
  expect(result.providers.codex!.note).toContain("could not be told apart")
})
