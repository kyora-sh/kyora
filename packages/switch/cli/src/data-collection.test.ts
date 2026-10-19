import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dataCollection } from "./data-collection"
import { GROK_DEFAULT_SCOPE } from "./providers/grok"
import { writeSnapshot } from "./store"
import type { Snapshot } from "./types"

let dir: string
const VARS = ["CLAUDE_CONFIG_DIR", "GROK_HOME", "XDG_CONFIG_HOME", "ANTIGRAVITY_GEMINI_DIR", "KYORA_SWITCH_DIR"]
const previous = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-data-"))
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude")
  process.env.GROK_HOME = join(dir, "grok")
  process.env.XDG_CONFIG_HOME = join(dir, "config")
  process.env.ANTIGRAVITY_GEMINI_DIR = join(dir, "gemini")
  process.env.KYORA_SWITCH_DIR = join(dir, "switch")
})

afterEach(async () => {
  for (const name of VARS) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  await rm(dir, { recursive: true, force: true })
})

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, ...extra })

function grokLogin(extra: Record<string, unknown>): Snapshot {
  const entry = { key: "fake-key", auth_mode: "oidc", user_id: "u1", create_time: "2026-10-01T00:00:00Z", email: "work@example.test", ...extra }
  return { provider: "grok", identity: {}, files: { "auth.json": JSON.stringify({ [GROK_DEFAULT_SCOPE]: entry }) }, capturedAt: 1 }
}

test("agy: telemetry is on while enableTelemetry is unset, and follows it once set", async () => {
  const unset = dataCollection("agy", null, env())
  expect(unset).toMatchObject({ telemetry: "on", training: "unknown" })
  expect(unset.line).toContain("telemetry on (default; enableTelemetry unset in ")
  await put(join(dir, "gemini", "antigravity-cli", "settings.json"), JSON.stringify({ enableTelemetry: false }))
  expect(dataCollection("agy", null, env()).telemetry).toBe("off")
  await put(join(dir, "gemini", "antigravity-cli", "settings.json"), JSON.stringify({ enableTelemetry: "false" }))
  expect(dataCollection("agy", null, env())).toMatchObject({ telemetry: "unknown", line: expect.stringContaining("telemetry unknown (unexpected value; enableTelemetry in ") })
})

test("grok: training is the login's own choice, so each slot has its own; telemetry follows config.toml, then the environment", async () => {
  expect(dataCollection("grok", grokLogin({ coding_data_retention_opt_out: true }), env()).line).toBe("training opted out (account, auth.json) · telemetry on (default; [features] telemetry unset)")
  expect(dataCollection("grok", grokLogin({ coding_data_retention_opt_out: false }), env()).training).toBe("opted-in")
  expect(dataCollection("grok", grokLogin({ is_zdr: true }), env()).line).toStartWith("ZDR (account, auth.json)")
  expect(dataCollection("grok", grokLogin({}), env()).training).toBe("unknown")
  expect(dataCollection("grok", null, env({ DISABLE_TELEMETRY: "1" })).line).toBe("training: no login · telemetry off (DISABLE_TELEMETRY)")
  expect(dataCollection("grok", null, env({ GROK_TELEMETRY_ENABLED: "0", DISABLE_TELEMETRY: "" })).telemetry).toBe("off")
  await put(join(dir, "grok", "config.toml"), "[features]\ntelemetry = false\n")
  expect(dataCollection("grok", null, env({ GROK_TELEMETRY_ENABLED: "1" })).line).toContain("telemetry off ([features] telemetry)")
})

test("claude: telemetry is off through either variable, in the environment or settings.json; training is not readable", async () => {
  const clean = env({ DISABLE_TELEMETRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" })
  expect(dataCollection("claude", null, clean).line).toBe("telemetry on (default; DISABLE_TELEMETRY unset) · training: account setting, not readable locally")
  expect(dataCollection("claude", null, { ...clean, DISABLE_TELEMETRY: "1" }).telemetry).toBe("off")
  await put(join(dir, "claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }))
  expect(dataCollection("claude", null, clean).line).toStartWith("telemetry off (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)")
})

test("a settings file that is there but cannot be read is unknown, never the default", async () => {
  await put(join(dir, "gemini", "antigravity-cli", "settings.json"), '{"enableTelemetry": false,')
  await put(join(dir, "claude", "settings.json"), "{not json")
  await put(join(dir, "config", "muse", "settings.json"), "[1]")
  await put(join(dir, "grok", "config.toml"), "[features\n")
  const clean = env({ DISABLE_TELEMETRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "", GROK_TELEMETRY_ENABLED: "" })
  expect(dataCollection("agy", null, clean)).toMatchObject({ telemetry: "unknown", line: expect.stringContaining("settings.json unreadable") })
  expect(dataCollection("claude", null, clean)).toMatchObject({ telemetry: "unknown", line: expect.stringContaining("settings.json unreadable") })
  expect(dataCollection("muse", null, clean).line).toStartWith("contributor mode unknown (")
  expect(dataCollection("grok", null, clean)).toMatchObject({ telemetry: "unknown", line: expect.stringContaining("config.toml unreadable") })
})

test("muse reads contributor mode; codex and opencode keep nothing locally", async () => {
  expect(dataCollection("muse", null, env()).line).toStartWith("contributor mode unset")
  await put(join(dir, "config", "muse", "settings.json"), JSON.stringify({ contributor_mode_enabled: false }))
  expect(dataCollection("muse", null, env())).toMatchObject({ training: "opted-out", line: expect.stringContaining("contributor mode off") })
  expect(dataCollection("codex", null, env()).line).toContain("not readable locally")
  expect(dataCollection("opencode", null, env()).training).toBe("unknown")
})

test("grok list shows each slot's own training choice", async () => {
  await writeSnapshot("out", { ...grokLogin({ coding_data_retention_opt_out: true }), identity: { account: "out@example.test" } })
  await writeSnapshot("in", { ...grokLogin({ coding_data_retention_opt_out: false, email: "in@example.test" }), identity: { account: "in@example.test" } })
  await writeSnapshot("plain", { ...grokLogin({ email: "plain@example.test" }), identity: { account: "plain@example.test" } })
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "index.ts"), "grok", "list"], { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out).toBe(["in       in@example.test  training opted in", "out      out@example.test  training opted out", "plain    plain@example.test", ""].join("\n"))
})
