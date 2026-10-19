import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Snapshot } from "../types"
import { agyDir, agyIdentity, agyKeyringBypass, agyProvider, decodeAgyLogin, encodeAgyLogin, agyQuotaThroughAgy, refreshAgyLogin, renewThroughAgy } from "./agy"

let dir: string
let env: Record<string, string | undefined>
const VARS = ["ANTIGRAVITY_GEMINI_DIR", "KYORA_AGY_TOKEN_URL", "KYORA_AGY_USAGE_URL", "KYORA_AGY_OAUTH_CLIENT_SECRET", "KYORA_SWITCH_DIR"]
const previous = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
const servers: { stop: (force?: boolean) => void }[] = []

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
const idToken = (claims: Record<string, unknown>) => `${segment({ alg: "RS256" })}.${segment(claims)}.fake-signature`

/** an agy login as go-keyring stores it, with fake tokens only */
function login(name: string, extra: { expiry?: string; email?: string | null } = {}): string {
  return encodeAgyLogin({
    token: { access_token: `fake-access-${name}`, token_type: "Bearer", refresh_token: `fake-refresh-${name}`, expiry: extra.expiry ?? "2099-01-01T10:00:00.123456789+02:00" },
    auth_method: "consumer",
    id_token: idToken({ ...(extra.email === null ? {} : { email: extra.email ?? `${name}@example.test` }), sub: `sub-${name}`, azp: "fake-client.apps.example", aud: "fake-client.apps.example" }),
  })
}

const snapshot = (blob: string): Snapshot => ({ provider: "agy", identity: agyIdentity(decodeAgyLogin(blob)), files: { "keychain.txt": blob }, capturedAt: 1 })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-agy-"))
  for (const name of VARS) delete process.env[name]
  process.env.KYORA_SWITCH_DIR = join(dir, "switch")
  process.env.ANTIGRAVITY_GEMINI_DIR = join(dir, "gemini")
})

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const name of VARS) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  await rm(dir, { recursive: true, force: true })
})

test("a go-keyring login decodes to its account, expiry and grant, and encodes back as it was", () => {
  const blob = login("work")
  expect(blob.startsWith("go-keyring-base64:")).toBe(true)
  expect(encodeAgyLogin(decodeAgyLogin(blob)!)).toBe(blob)
  const saved = snapshot(blob)
  expect(saved.identity).toEqual({ account: "work@example.test" })
  expect(agyProvider.credentialExpiry!(saved)).toBe(Date.parse("2099-01-01T08:00:00.123Z"))
  expect(agyProvider.grant!(saved)).toBe("fake-refresh-work")
})

test("a login with no email is matched by its subject, and one that does not decode by its raw value", () => {
  expect(agyIdentity(decodeAgyLogin(login("anon", { email: null })))).toEqual({ id: "google sub-anon" })
  const odd = snapshot("not a go-keyring value")
  expect(odd.identity).toEqual({})
  expect(agyProvider.grant!(odd)).toBe("not a go-keyring value")
  expect(agyProvider.credentialExpiry!(odd)).toBeUndefined()
})

test("agy's app data follows an absolute ANTIGRAVITY_GEMINI_DIR only, as agy resolves it", () => {
  expect(agyDir({ ANTIGRAVITY_GEMINI_DIR: "/abs/gem" })).toBe("/abs/gem/antigravity-cli")
  expect(agyDir({ ANTIGRAVITY_GEMINI_DIR: "relative" }).endsWith("/.gemini/antigravity-cli")).toBe(true)
})

test("without a keychain there is no live login to read, and a load is refused before it begins", async () => {
  expect(await agyProvider.capture()).toBeNull()
  await expect(agyProvider.checkRestore!(snapshot(login("work")))).rejects.toThrow("macOS keychain")
})

function tokenServer(answer: (form: URLSearchParams) => Response) {
  const forms: URLSearchParams[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const form = new URLSearchParams(await request.text())
      forms.push(form)
      return answer(form)
    },
  })
  servers.push(server)
  process.env.KYORA_AGY_TOKEN_URL = server.url.href
  return forms
}

test("refresh trades the refresh token for the client the ID token names, keeping the refresh token and the rest of the login", async () => {
  const forms = tokenServer(() => Response.json({ access_token: "fake-renewed", expires_in: 3600, token_type: "Bearer" }))
  const before = Date.now()
  const result = await refreshAgyLogin(login("work"))
  if (!("blob" in result)) throw new Error(result.failure)
  expect(Object.fromEntries(forms[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: "fake-refresh-work", client_id: "fake-client.apps.example" })
  const renewed = decodeAgyLogin(result.blob)!
  const token = renewed.token as Record<string, string>
  expect(token.access_token).toBe("fake-renewed")
  expect(token.refresh_token).toBe("fake-refresh-work")
  expect(Date.parse(token.expiry!)).toBeGreaterThanOrEqual(before + 3_600_000)
  expect(renewed.id_token).toBe(decodeAgyLogin(login("work"))!.id_token)
  expect(renewed.auth_method).toBe("consumer")
})

test("refresh sends a configured client secret, and a client refusal without one says how to give it", async () => {
  const forms = tokenServer(() => Response.json({ error: "invalid_client" }, { status: 401 }))
  const refused = await refreshAgyLogin(login("work"))
  expect("failure" in refused && refused.failure).toContain("KYORA_AGY_OAUTH_CLIENT_SECRET")
  expect(forms[0]!.has("client_secret")).toBe(false)
  process.env.KYORA_AGY_OAUTH_CLIENT_SECRET = "fake-secret"
  const again = await refreshAgyLogin(login("work"))
  expect(forms[1]!.get("client_secret")).toBe("fake-secret")
  expect("failure" in again && again.failure).not.toContain("KYORA_AGY_OAUTH_CLIENT_SECRET")
  expect(JSON.stringify(again)).not.toContain("fake-refresh")
})

test("agy renews the live login itself, and a saved slot that is not live, a failed run or a stale result renews nothing", async () => {
  const stale = login("work", { expiry: "2000-01-01T00:00:00Z" })
  const fresh = login("work2")
  let held = stale
  let runs = 0
  const runner = (ok = true, after = fresh) => ({ run: async () => (runs++, (held = after), ok), read: async () => held })
  expect(await renewThroughAgy(stale, runner())).toEqual({ blob: fresh })
  held = stale
  expect(await renewThroughAgy(login("other"), runner())).toBeUndefined()
  expect(runs).toBe(1)
  expect(await renewThroughAgy(stale, runner(false))).toEqual({ failure: expect.stringContaining("`agy models` failed") })
  held = stale
  expect(await renewThroughAgy(stale, runner(true, login("work3", { expiry: "2000-01-01T00:00:00Z" })))).toEqual({ failure: expect.stringContaining("left the login expired") })
})

test("the live login's quota comes from agy's own /usage, and a saved slot or a failed run gets none from it", async () => {
  const blob = login("work")
  const soon = new Date(Date.now() + 3_600_000).toISOString()
  const out = JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          { name: "Gemini Models", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.6, reset_time: soon }, { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.25, reset_time: soon }] },
          { name: "Claude and GPT models", buckets: [{ id: "other-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: soon }] },
        ],
      },
    },
  })
  let runs = 0
  const runner = (text: string | null) => ({ usage: async () => (runs++, text), read: async () => blob })
  const usage = await agyQuotaThroughAgy(blob, runner(out))
  expect(usage?.windows?.map((window) => [window.label, window.usedPct])).toEqual([["Gemini Models weekly", 40], ["Gemini Models 5h", 75], ["Claude and GPT models weekly", 0]])
  expect(await agyQuotaThroughAgy(login("other"), runner(out))).toBeNull()
  expect(runs).toBe(1)
  expect(await agyQuotaThroughAgy(blob, runner(null))).toBeNull()
  expect(await agyQuotaThroughAgy(blob, runner("not json"))).toBeNull()
})

test("a spent refresh token says to log in again", async () => {
  tokenServer(() => Response.json({ error: "invalid_grant" }, { status: 400 }))
  const result = await agyProvider.refresh!(snapshot(login("work")))
  expect("failure" in result && result.failure).toContain("log in again")
})

function quotaServer(routes: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: { path: string; auth: string | null; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ path, auth: request.headers.get("authorization"), body })
      return routes[path]?.(body) ?? new Response("not found", { status: 404 })
    },
  })
  servers.push(server)
  process.env.KYORA_AGY_USAGE_URL = server.url.href
  return calls
}

test("quota reads the login's project, then the quota summary's buckets, with the slot's access token", async () => {
  const calls = quotaServer({
    "/v1internal:loadCodeAssist": () => Response.json({ cloudaicompanionProject: "fake-project", currentTier: { id: "standard-tier", name: "Google AI Ultra" } }),
    "/v1internal:retrieveUserQuotaSummary": () => Response.json({
      groups: [{ displayName: "Agent", buckets: [
        { window: "5h", remainingFraction: 0.75, resetTime: "2099-01-01T00:00:00Z" },
        { window: "weekly", resetTime: "2099-01-05T00:00:00Z" },
        { window: "off", remainingFraction: 1, disabled: true },
      ] }],
    }),
  })
  const usage = await agyProvider.quotaWithReason!(snapshot(login("work")))
  expect(usage).toEqual({
    remainingPct: 0,
    detail: "Agent 5h 25% used · Agent weekly 100% used",
    windows: [
      { label: "Agent 5h", usedPct: 25, resetsAt: Date.parse("2099-01-01T00:00:00Z") },
      { label: "Agent weekly", usedPct: 100, resetsAt: Date.parse("2099-01-05T00:00:00Z") },
    ],
    plan: "Google AI Ultra",
  })
  expect(calls.map((call) => call.path)).toEqual(["/v1internal:loadCodeAssist", "/v1internal:retrieveUserQuotaSummary"])
  expect(calls.every((call) => call.auth === "Bearer fake-access-work")).toBe(true)
  expect(calls[1]!.body).toEqual({ project: "fake-project" })
})

test("without a summary, quota reads retrieveUserQuota's per model buckets", async () => {
  quotaServer({
    "/v1internal:loadCodeAssist": () => Response.json({ cloudaicompanionProject: { id: "fake-project" } }),
    "/v1internal:retrieveUserQuota": () => Response.json({ buckets: [{ modelId: "gemini-pro", remainingFraction: 0.4, resetTime: "2099-01-01T00:00:00Z", tokenType: "REQUESTS" }] }),
  })
  const usage = await agyProvider.quotaWithReason!(snapshot(login("work")))
  expect(usage && "remainingPct" in usage && usage.detail).toBe("gemini-pro 60% used")
})

test("buckets that share a model but not a token type are two windows, the tightest one counting", async () => {
  quotaServer({
    "/v1internal:loadCodeAssist": () => Response.json({ cloudaicompanionProject: "fake-project" }),
    "/v1internal:retrieveUserQuota": () => Response.json({ buckets: [
      { modelId: "gemini-pro", tokenType: "REQUESTS", remainingFraction: 0.9, resetTime: "2099-01-01T00:00:00Z" },
      { modelId: "gemini-pro", tokenType: "WTUS", resetTime: "2099-01-01T00:00:00Z" },
      { modelId: "gemini-pro", tokenType: "WTUS", resetTime: "2099-01-01T00:00:00Z" },
    ] }),
  })
  const usage = await agyProvider.quotaWithReason!(snapshot(login("work")))
  expect(usage).toMatchObject({ remainingPct: 0, detail: "gemini-pro requests 10% used · gemini-pro wtus 100% used" })
})

test("an expired access token is never sent, and a refused one says so", async () => {
  const calls = quotaServer({ "/v1internal:loadCodeAssist": () => new Response("", { status: 401 }) })
  expect(await agyProvider.quotaWithReason!(snapshot(login("old", { expiry: "2001-01-01T00:00:00Z" })))).toBeNull()
  expect(calls).toHaveLength(0)
  expect(await agyProvider.quotaWithReason!(snapshot(login("work")))).toEqual({ unavailable: expect.stringContaining("refused the stored access token") })
})

// the CLI end to end, against a fake `security` that keeps one item per service and account in a file
async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--preload", join(dir, "platform.ts"), join(import.meta.dir, "../index.ts"), ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, output: stdout + stderr }
}

const items = () => join(dir, "keychain.json")
const live = async (): Promise<string | undefined> => (await Bun.file(items()).json().catch(() => ({})))["gemini/antigravity"]
const setLive = async (blob: string) => Bun.write(items(), JSON.stringify({ "gemini/antigravity": blob }))

async function agyRunning(running: boolean): Promise<void> {
  await Bun.write(join(dir, "bin", "pgrep"), running ? '#!/bin/sh\n[ "$2" = agy ] && echo 4242 && exit 0\nexit 1\n' : "#!/bin/sh\nexit 1\n")
  await chmod(join(dir, "bin", "pgrep"), 0o700)
}

async function setUpCli(): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true })
  await Bun.write(join(dir, "platform.ts"), 'Object.defineProperty(process, "platform", { value: "darwin" })')
  await Bun.write(join(dir, "bin", "security"), `#!${process.execPath}
const args = process.argv.slice(2)
const path = process.env.FAKE_KEYCHAIN
const store = await Bun.file(path).json().catch(() => ({}))
const arg = (list, flag) => list[list.indexOf(flag) + 1]
if (args[0] === "find-generic-password") {
  const value = store[arg(args, "-s") + "/" + arg(args, "-a")]
  if (value === undefined) process.exit(44)
  process.stdout.write(value)
} else if (args[0] === "-i" || args[0] === "add-generic-password") {
  const line = args[0] === "-i" ? (await Bun.stdin.text()).trim() : args.join(" ")
  const words = line.replace(/"/g, "").split(/\\s+/)
  if (!words.includes("-w")) process.exit(2)
  store[arg(words, "-s") + "/" + arg(words, "-a")] = arg(words, "-w")
  await Bun.write(path, JSON.stringify(store))
} else if (args[0] === "delete-generic-password") {
  delete store[arg(args, "-s") + "/" + arg(args, "-a")]
  await Bun.write(path, JSON.stringify(store))
} else process.exit(1)
`)
  await chmod(join(dir, "bin", "security"), 0o700)
  await Bun.write(join(dir, "bin", "ps"), "#!/bin/sh\n")
  await chmod(join(dir, "bin", "ps"), 0o700)
  await agyRunning(false)
  const home = (name: string) => join(dir, "home", name)
  env = {
    ...process.env,
    PATH: join(dir, "bin"),
    NODE_ENV: "production",
    KYORA_SWITCH_NO_KEYCHAIN: "0",
    KYORA_SWITCH_PRIVATE: "0",
    HOME: home("home"),
    CLAUDE_CONFIG_DIR: home("claude"),
    CODEX_HOME: home("codex"),
    GROK_HOME: home("grok"),
    XDG_CONFIG_HOME: home("config"),
    XDG_DATA_HOME: home("data"),
    ANTIGRAVITY_GEMINI_DIR: join(dir, "gemini"),
    KYORA_SWITCH_DIR: join(dir, "switch"),
    FAKE_KEYCHAIN: items(),
  }
}

test("save, load and list move agy's keychain login between slots, backing the outgoing one up", async () => {
  await setUpCli()
  await setLive(login("work"))
  expect((await cli("agy", "save", "work")).output).toContain('saved agy "work": work@example.test')
  await setLive(login("home"))
  expect((await cli("agy", "save", "home")).code).toBe(0)

  const loaded = await cli("agy", "load", "work")
  expect(loaded.code).toBe(0)
  expect(await live()).toBe(login("work"))
  expect((await cli("agy", "list")).output).toMatch(/work\s+work@example\.test {2}\(active\)/)

  await setLive(login("stray"))
  const replaced = await cli("agy", "load", "home")
  expect(replaced.output).toContain("was in no slot")
  expect(await live()).toBe(login("home"))
  const backups = await readdir(join(dir, "switch", "backups", "agy"))
  const stray = await Promise.all(backups.map((stamp) => Bun.file(join(dir, "switch", "backups", "agy", stamp, "keychain.txt")).text()))
  expect(stray).toContain(login("stray"))
})

test("a load while agy runs is refused before anything is written; --force loads and says to restart it", async () => {
  await setUpCli()
  await setLive(login("work"))
  await cli("agy", "save", "work")
  await setLive(login("home"))
  await agyRunning(true)
  const refused = await cli("agy", "load", "work")
  expect(refused.code).not.toBe(0)
  expect(refused.output).toContain("Antigravity is running and would keep or overwrite its login: quit it first, or --force loads anyway")
  expect(await live()).toBe(login("home"))
  expect(await readdir(join(dir, "switch", "backups", "agy")).catch(() => [])).toEqual([])

  const forced = await cli("agy", "load", "work", "--force")
  expect(forced.code).toBe(0)
  expect(forced.output).toContain("Antigravity is running")
  expect(await live()).toBe(login("work"))
})

test("agy's keyring-bypass marker shows in status notes and doctor", async () => {
  await setUpCli()
  await setLive(login("work"))
  expect(agyKeyringBypass({ ANTIGRAVITY_GEMINI_DIR: join(dir, "gemini") })).toBeUndefined()
  await mkdir(join(dir, "gemini", "antigravity-cli"), { recursive: true })
  await writeFile(join(dir, "gemini", "antigravity-cli", "keyring-marker-unavailable"), "")
  const marker = join(dir, "gemini", "antigravity-cli", "keyring-marker-unavailable")
  expect(agyKeyringBypass({ ANTIGRAVITY_GEMINI_DIR: join(dir, "gemini") })).toBe(marker)
  for (const command of ["status", "doctor"]) expect((await cli(command)).output).toContain(`agy's keyring-bypass marker is at ${marker}`)
})

test("status names the agy login and every provider's data collection, read from local settings", async () => {
  await setUpCli()
  await setLive(login("work"))
  await cli("agy", "save", "work")
  await mkdir(join(dir, "gemini", "antigravity-cli"), { recursive: true })
  await Bun.write(join(dir, "gemini", "antigravity-cli", "settings.json"), JSON.stringify({ enableTelemetry: false }))
  const status = await cli("status")
  expect(status.output).toContain('agy      work@example.test  (slot "work")')
  expect(status.output).toContain("data collection: telemetry off (enableTelemetry in ")
  expect(status.output.match(/data collection:/g)).toHaveLength(6)
  const json = JSON.parse((await cli("status", "--json")).output)
  expect(json.find((row: { provider: string }) => row.provider === "agy").dataCollection).toMatchObject({ training: "unknown", telemetry: "off" })
})

test("refresh renews an idle agy's expired live login in the keychain and its slot, and leaves a running agy's to it", async () => {
  await setUpCli()
  const expired = login("work", { expiry: "2001-01-01T00:00:00Z" })
  await setLive(expired)
  await cli("agy", "save", "work")
  const forms: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      forms.push(new URLSearchParams(await request.text()).get("refresh_token")!)
      return Response.json({ access_token: "fake-renewed", expires_in: 3600 })
    },
  })
  servers.push(server)
  env.KYORA_AGY_TOKEN_URL = server.url.href
  env.KYORA_AGY_USAGE_URL = "http://127.0.0.1:9"

  await agyRunning(true)
  await cli("agy", "refresh")
  expect(forms).toHaveLength(0)
  expect(await live()).toBe(expired)

  await agyRunning(false)
  const refreshed = await cli("agy", "refresh")
  expect(refreshed.output).toContain("renewed the live login")
  expect(forms).toEqual(["fake-refresh-work"])
  const renewed = decodeAgyLogin(await live())!
  expect((renewed.token as Record<string, string>).access_token).toBe("fake-renewed")
  expect(await Bun.file(join(dir, "switch", "agy", "work", "keychain.txt")).text()).toBe((await live())!)
  expect(refreshed.output).not.toContain("fake-refresh")
})

test("usage shows each agy slot's quota, read with its own access token", async () => {
  await setUpCli()
  await setLive(login("work"))
  await cli("agy", "save", "work")
  const tokens: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      tokens.push(request.headers.get("authorization")!)
      const path = new URL(request.url).pathname
      if (path.endsWith("loadCodeAssist")) return Response.json({ cloudaicompanionProject: "fake-project" })
      return Response.json({ buckets: [{ window: "5h", remainingFraction: 0.9, resetTime: "2099-01-01T00:00:00Z" }] })
    },
  })
  servers.push(server)
  env.KYORA_AGY_USAGE_URL = server.url.href
  const usage = await cli("agy", "usage")
  expect(usage.output).toContain("90% left")
  expect(usage.output).toContain("5h 10% used")
  expect(new Set(tokens)).toEqual(new Set(["Bearer fake-access-work"]))
  const calls = tokens.length
  await cli("usage")
  expect(tokens.length).toBe(2 * calls)
})

test("usage never renews an expired agy login, live or stored: no token call, and a hint to run refresh", async () => {
  await setUpCli()
  await setLive(login("home", { expiry: "2001-01-01T00:00:00Z" }))
  await cli("agy", "save", "home")
  await setLive(login("work", { expiry: "2001-01-01T00:00:00Z" }))
  await cli("agy", "save", "work")
  const forms: string[] = []
  const server = Bun.serve({ port: 0, fetch: () => (forms.push("call"), Response.json({ access_token: "fake-renewed", expires_in: 3600 })) })
  servers.push(server)
  env.KYORA_AGY_TOKEN_URL = server.url.href
  env.KYORA_AGY_USAGE_URL = "http://127.0.0.1:9"
  for (const args of [["agy", "usage"], ["usage"], ["usage", "--no-renew"]]) {
    const shown = (await cli(...args)).output
    expect(shown).toContain("Antigravity renews it when it next runs; `kyora-switch refresh` renews it now")
    expect(shown).toMatch(/access token expired \S+ ago; `kyora-switch refresh` renews it$/m)
  }
  expect(forms).toEqual([])
  expect(await live()).toBe(login("work", { expiry: "2001-01-01T00:00:00Z" }))
  await cli("refresh")
  expect(forms).toEqual(["call", "call"])
})

test("a renewal that keeps Google's refresh token spends nothing: the slot, once loaded, syncs and renews as before", async () => {
  await setUpCli()
  await setLive(login("home"))
  await cli("agy", "save", "home")
  await setLive(login("work", { expiry: "2001-01-01T00:00:00Z" }))
  await cli("agy", "save", "work")
  await setLive(login("home"))
  await cli("agy", "load", "home")
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "fake-renewed", expires_in: 3600 }) })
  servers.push(server)
  env.KYORA_AGY_TOKEN_URL = server.url.href
  env.KYORA_AGY_USAGE_URL = "http://127.0.0.1:9"
  await cli("agy", "refresh")
  const meta = await Bun.file(join(dir, "switch", "agy", "work", "slot.json")).json()
  expect(meta.renewedFrom).toBeUndefined()

  expect((await cli("agy", "load", "work")).code).toBe(0)
  // agy renews its own access token in use, keeping the refresh token
  const doc = decodeAgyLogin(await live())!
  await setLive(encodeAgyLogin({ ...doc, token: { ...(doc.token as object), access_token: "fake-agy-own" } }))
  const synced = await cli("agy", "sync")
  expect(synced.output).toContain('synced "work"')
  expect(synced.output).not.toContain("spent")
})
