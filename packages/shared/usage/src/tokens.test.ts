import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexLifetimeTokens, parseCodexLifetimeTokens } from "./quota"

const dirs = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KYORA_SWITCH_DIR"]
let root: string
let previous: Record<string, string | undefined>
let server: ReturnType<typeof Bun.serve> | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyora-usage-tokens-"))
  previous = Object.fromEntries([...dirs, "KYORA_CODEX_TOKENS_URL", "KYORA_SWITCH_NO_KEYCHAIN"].map(key => [key, process.env[key]]))
  for (const key of dirs) {
    process.env[key] = join(root, key.toLowerCase())
    expect(process.env[key]?.startsWith(`${root}/`)).toBe(true)
  }
  process.env.KYORA_SWITCH_NO_KEYCHAIN = "1"
})
afterEach(async () => {
  server?.stop(true); server = undefined
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

test("lifetime tokens accepts zero and rejects missing, negative, fractional and unsafe values", () => {
  expect(parseCodexLifetimeTokens({ stats: { lifetime_tokens: 1234, daily_usage_buckets: [] } })).toBe(1234)
  expect(parseCodexLifetimeTokens({ stats: { lifetime_tokens: 0 } })).toBe(0)
  for (const value of [null, {}, { stats: null }, { stats: {} }, ...[-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "10"].map(total => ({ stats: { lifetime_tokens: total } }))]) {
    expect(parseCodexLifetimeTokens(value)).toBeNull()
  }
})

test("lifetime probe uses bearer and account headers and treats malformed or unavailable replies as unknown", async () => {
  let status = 200
  let payload: unknown = { stats: { lifetime_tokens: 456 } }
  let authorized = false
  server = Bun.serve({ port: 0, fetch(request) {
    authorized = request.headers.get("authorization") === "Bearer fixture-token" && request.headers.get("chatgpt-account-id") === "fixture-account"
    return Response.json(payload, { status })
  } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  expect(await codexLifetimeTokens("fixture-token", "fixture-account")).toBe(456)
  expect(authorized).toBe(true)
  status = 429
  expect(await codexLifetimeTokens("fixture-token", "fixture-account")).toBeNull()
  status = 200; payload = { stats: {} }
  expect(await codexLifetimeTokens("fixture-token", "fixture-account")).toBeNull()
})

test("lifetime probe never forwards credentials to redirects", async () => {
  let redirected = false
  server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/other") { redirected = true; return Response.json({ stats: { lifetime_tokens: 1 } }) }
    return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server!.port}/other` } })
  } })
  process.env.KYORA_CODEX_TOKENS_URL = `http://127.0.0.1:${server.port}/profiles/me`
  expect(await codexLifetimeTokens("fixture-token", "fixture-account")).toBeNull()
  expect(redirected).toBe(false)
})

test("a URL override that isn't loopback is ignored, so a stray env var never receives a bearer token", async () => {
  const seen: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input))
    return new Response("{}", { status: 500 })
  }) as typeof fetch
  try {
    process.env.KYORA_CODEX_TOKENS_URL = "https://collector.example/steal"
    await codexLifetimeTokens("token", "account")
    process.env.KYORA_CODEX_TOKENS_URL = "http://127.0.0.1:9/profiles/me"
    await codexLifetimeTokens("token", "account")
  } finally {
    globalThis.fetch = real
  }
  expect(seen).toEqual(["https://chatgpt.com/backend-api/wham/profiles/me", "http://127.0.0.1:9/profiles/me"])
})
