import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyora-switch-unreadable-"))
  const museDir = join(root, "xdg-config", "muse")
  await mkdir(museDir, { recursive: true })
  await writeFile(join(museDir, "auth.json"), "{not json")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(...args: string[]) {
  return runEnv({}, ...args)
}

async function runEnv(extra: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      KYORA_SWITCH_DIR: join(root, "switch"),
      KYORA_SWITCH_NO_KEYCHAIN: "1",
      NODE_ENV: "test",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

test("status prints other providers and a muse unreadable line, exit 1", async () => {
  const result = await run("status")
  expect(result.code).toBe(1)
  expect(result.out).toContain("muse     unreadable:")
  expect(result.out).toContain("is not valid JSON")
  expect(result.out).toContain("claude")
  expect(result.out).toContain("codex")
  expect(result.out).toContain("opencode")
})

test("status --json carries an error entry for muse and entries for others, exit 1", async () => {
  const result = await run("status", "--json")
  expect(result.code).toBe(1)
  const rows = JSON.parse(result.out) as { provider: string; error?: string }[]
  expect(rows.find((row) => row.provider === "muse")?.error).toContain("is not valid JSON")
  expect(rows.some((row) => row.provider === "claude")).toBe(true)
  expect(rows.some((row) => row.provider === "codex")).toBe(true)
})

test("usage prints other providers and a muse unreadable line, exit 1", async () => {
  const result = await run("usage")
  expect(result.code).toBe(1)
  expect(result.out).toContain("muse: unreadable:")
  expect(result.out).toContain("claude")
  expect(result.out).toContain("codex")
})

test("usage --json carries an error in place of muse rows, exit 1", async () => {
  const result = await run("usage", "--json")
  expect(result.code).toBe(1)
  const data = JSON.parse(result.out) as Record<string, unknown>
  expect((data.muse as { error: string }).error).toContain("is not valid JSON")
  expect(Array.isArray(data.claude)).toBe(true)
})

test("refresh prints other providers and a muse unreadable line, exit 1", async () => {
  const result = await run("refresh")
  expect(result.code).toBe(1)
  expect(result.out).toContain("muse: unreadable:")
})

test("sync prints other providers and a muse unreadable line, exit 1", async () => {
  const result = await run("sync")
  expect(result.code).toBe(1)
  expect(result.out).toContain("muse     unreadable:")
  expect(result.out).toContain("claude")
  expect(result.out).toContain("codex")
})

test("muse clear prints the META_API_KEY note", async () => {
  await writeFile(join(root, "xdg-config", "muse", "auth.json"), JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: "fake-token", refresh_token: "fake-refresh", user_email: "a@acme.dev" } } }))
  const result = await runEnv({ META_API_KEY: "fake-env-key" }, "muse", "clear")
  expect(result.code).toBe(0)
  expect(result.out + result.err).toContain("META_API_KEY is set")
  expect(result.out + result.err).not.toContain("fake-env-key")
})

test("single-provider muse usage still fails loudly", async () => {
  const result = await run("muse", "usage")
  expect(result.code).toBe(2)
  expect(result.out + result.err).toContain("is not valid JSON")
})

test("a corrupt grok auth.json is an unreadable line beside the other providers, never a crash", async () => {
  const grokHome = join(root, "grok")
  await mkdir(grokHome, { recursive: true })
  await writeFile(join(grokHome, "auth.json"), "{not json")
  const status = await runEnv({ GROK_HOME: grokHome }, "status")
  expect(status.code).toBe(1)
  expect(status.out).toContain("grok     unreadable:")
  expect(status.out).toContain("claude")
  const usage = await runEnv({ GROK_HOME: grokHome }, "usage", "--json")
  expect(usage.code).toBe(1)
  expect((JSON.parse(usage.out).grok as { error: string }).error).toContain("is not valid JSON")
})
