import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprintOf } from "./sync"

/**
 * kyora-switch, run as the user runs it, next to slots `kyora session creds sync` uploaded to
 * kyora cloud (a review probe, made a regression test). Temp HOME, config and slot dirs,
 * no keychain, a fake token endpoint: nothing real is read or written.
 */

let root: string
let claudeDir: string
let switchDir: string
let server: ReturnType<typeof Bun.serve>
/** refresh tokens the fake endpoint still honours; each refresh spends one and hands out the next */
let valid: Set<string>
let seen: string[]
/** runs while the fake endpoint answers a refresh: another process changing the live login meanwhile */
let duringRefresh: (() => Promise<void>) | undefined
let serverError = false

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/token") return Response.json({})
      const { refresh_token } = (await request.json()) as { refresh_token: string }
      seen.push(refresh_token)
      await duringRefresh?.()
      if (serverError) return new Response("", { status: 500 })
      if (!valid.has(refresh_token)) return Response.json({ error: "invalid_grant" }, { status: 400 })
      valid.delete(refresh_token)
      const next = `${refresh_token}-2`
      valid.add(next)
      return Response.json({ access_token: `AT-${next}`, refresh_token: next, expires_in: 28_800 })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

beforeEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = await mkdtemp(join(tmpdir(), "kyora-switch-cloud-owned-"))
  claudeDir = join(root, "home", ".claude-test")
  switchDir = join(root, "home", "switch")
  await mkdir(claudeDir, { recursive: true })
  seen = []
  claudeRunning = false
  pgrepIdle = "exit 1"
  psLines = []
  duringRefresh = undefined
  serverError = false
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const later = () => Date.now() + 3_600_000
const blob = (refresh: string, expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: `AT-${refresh}`, refreshToken: refresh, expiresAt, scopes: ["user:inference"] } })
const account = (email: string) => `${JSON.stringify({ oauthAccount: { emailAddress: email } }, null, 2)}\n`

async function slot(name: string, email: string, refresh: string, expiresAt: number, cloudOwned = false): Promise<void> {
  const dir = join(switchDir, "claude", name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "credentials.json"), blob(refresh, expiresAt))
  await writeFile(join(dir, "account.json"), account(email))
  const meta = { name, provider: "claude", identity: { account: email }, createdAt: 1, updatedAt: 1 }
  // what `kyora session creds sync` writes
  const marker = cloudOwned ? { cloudOwned: { at: 2, by: "kyora session creds sync", fingerprint: fingerprintOf(refresh) } } : {}
  await writeFile(join(dir, "slot.json"), JSON.stringify({ ...meta, ...marker }))
}

async function loggedIn(email: string, refresh: string): Promise<void> {
  await writeFile(join(claudeDir, ".credentials.json"), blob(refresh, later()))
  await writeFile(join(claudeDir, ".claude.json"), account(email))
}

const refreshOf = async (name: string): Promise<string> =>
  JSON.parse(await readFile(join(switchDir, "claude", name, "credentials.json"), "utf8")).claudeAiOauth.refreshToken

const runningFlag = () => join(root, "claude-running")

/**
 * The only tools on PATH: a `pgrep` that finds Claude Code while `runningFlag` exists and
 * otherwise runs `pgrepIdle` (null: no `pgrep` at all), and a `ps` printing `psLines`
 * (`$PPID` is the kyora-switch running it). Whatever runs on this machine never reaches a test.
 */
async function tools(): Promise<string> {
  const bin = join(root, "bin")
  await mkdir(bin, { recursive: true })
  await rm(join(bin, "pgrep"), { force: true })
  if (pgrepIdle !== null) await writeFile(join(bin, "pgrep"), `#!/bin/sh\n[ -e "${runningFlag()}" ] && echo 4242 && exit 0\n${pgrepIdle}\n`, { mode: 0o755 })
  await rm(join(bin, "ps"), { force: true })
  await writeFile(join(bin, "ps"), `#!/bin/sh\n${psLines.map((line) => `echo "${line}"`).join("\n")}\n`, { mode: 0o755 })
  if (claudeRunning) await writeFile(runningFlag(), "")
  else await rm(runningFlag(), { force: true })
  return bin
}

let claudeRunning = false
let pgrepIdle: string | null = "exit 1"
let psLines: string[] = []

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
    env: {
      PATH: await tools(),
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: claudeDir,
      KYORA_SWITCH_DIR: switchDir,
      KYORA_SWITCH_NO_KEYCHAIN: "1",
      NODE_ENV: "test",
      CODEX_HOME: join(root, "codex"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      KYORA_REVIEW_STATE_DIR: join(root, "state", "kyora-review"),
      KYORA_CLAUDE_TOKEN_URL: `http://127.0.0.1:${server.port}/token`,
      KYORA_CLAUDE_USAGE_URL: `http://127.0.0.1:${server.port}/usage`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: `${out}${err}` }
}

test("list syncs the live login into its own slot, never into a same-email slot kyora cloud owns", async () => {
  valid = new Set(["LIVE-2", "CLOUD"])
  // the laptop's login rotated since `save work`; a second /login of the same account, for kyora cloud, is cloud-work
  await loggedIn("a@x", "LIVE-2")
  await slot("work", "a@x", "LIVE", later())
  await slot("cloud-work", "a@x", "CLOUD", later(), true)

  const listed = await run("claude", "list")
  expect(listed.code).toBe(0)
  expect(await refreshOf("cloud-work")).toBe("CLOUD")
  // the unmarked slot of that account still picks up the CLI's newer token, as before
  expect(await refreshOf("work")).toBe("LIVE-2")
  expect(listed.out).toMatch(/cloud-work .*\(kyora cloud\)/)
  expect(listed.out).toMatch(/work +a@x {2}\(active\)/)
  // the marker survives
  expect(JSON.parse(await readFile(join(switchDir, "claude", "cloud-work", "slot.json"), "utf8")).cloudOwned).toMatchObject({ by: "kyora session creds sync" })
})

test("refresh renews stale slots of the laptop's and leaves those kyora cloud owns to the broker", async () => {
  valid = new Set(["LIVE", "OTHER", "SPARE"])
  await loggedIn("a@x", "LIVE")
  await slot("work", "a@x", "LIVE", later())
  // another account's slot, uploaded to kyora cloud; its access token lapsed
  await slot("other", "b@x", "OTHER", Date.now() - 1000, true)
  // and one that isn't: refresh still renews it
  await slot("spare", "c@x", "SPARE", Date.now() - 1000)

  const refreshed = await run("claude", "refresh")
  expect(refreshed.code).toBe(0)
  expect(seen).toEqual(["SPARE"])
  expect(await refreshOf("spare")).toBe("SPARE-2")
  expect(await refreshOf("other")).toBe("OTHER")
  expect(valid.has("OTHER")).toBe(true)
  expect(refreshed.out).toContain("in use by kyora cloud, not refreshed locally")
})

test("a laptop logged into the broker's own login: sync skips the slot and says so", async () => {
  valid = new Set(["CLOUD"])
  await loggedIn("a@x", "CLOUD")
  await slot("cloud-work", "a@x", "CLOUD", 1, true)
  const before = await readFile(join(switchDir, "claude", "cloud-work", "credentials.json"), "utf8")

  const synced = await run("claude", "sync")
  expect(synced.code).toBe(0)
  expect(synced.out).toContain(`skipped "cloud-work": in use by kyora cloud`)
  expect(await readFile(join(switchDir, "claude", "cloud-work", "credentials.json"), "utf8")).toBe(before)
})

test("load, save and rename refuse a slot kyora cloud owns; load and save take --force", async () => {
  valid = new Set()
  await loggedIn("a@x", "LIVE")
  await slot("work", "a@x", "LIVE", later())
  await slot("cloud-work", "a@x", "CLOUD", later(), true)

  const load = await run("claude", "load", "cloud-work")
  expect(load.code).toBe(2)
  expect(load.out).toContain("kyora session creds return --slot cloud-work")
  expect(JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("LIVE")

  expect((await run("claude", "save", "cloud-work")).code).toBe(2)
  expect(await refreshOf("cloud-work")).toBe("CLOUD")
  expect((await run("claude", "rename", "cloud-work", "elsewhere")).code).toBe(2)

  const forced = await run("claude", "save", "cloud-work", "--force")
  expect(forced.code).toBe(0)
  expect(await refreshOf("cloud-work")).toBe("LIVE")
  expect(JSON.parse(await readFile(join(switchDir, "claude", "cloud-work", "slot.json"), "utf8")).cloudOwned).toBeTruthy()

  const removed = await run("claude", "rm", "cloud-work", "--yes")
  expect(removed.code).toBe(0)
  expect(removed.out).toContain("kyora session creds rm --slot cloud-work")
})

test("refresh leaves every slot with the live login's email alone, as before kyora cloud (m4)", async () => {
  await loggedIn("a@x", "LIVE-RT")
  await slot("work", "a@x", "LIVE-RT", later())
  // an older copy of the same login under another name, its access token lapsed
  await slot("work-old", "a@x", "LIVE-RT", Date.now() - 1000)
  await slot("other", "b@x", "OTHER-RT", Date.now() - 1000)
  valid = new Set(["LIVE-RT", "OTHER-RT"])
  await run("claude", "refresh")
  expect(seen).toEqual(["OTHER-RT"])
  expect(await refreshOf("work-old")).toBe("LIVE-RT")
  expect(valid.has("LIVE-RT")).toBe(true)
})

test("a live login whose email two slots share and whose token neither has is synced into neither (m5)", async () => {
  await loggedIn("a@x", "ROTATED-RT")
  await slot("work", "a@x", "OLD-RT", later())
  await slot("work2", "a@x", "OTHER-GRANT-RT", later())
  valid = new Set()
  const { out } = await run("claude", "sync")
  expect(out).toContain('has the email of "work", "work2" and the token of none: not synced')
  expect(await refreshOf("work")).toBe("OLD-RT")
  expect(await refreshOf("work2")).toBe("OTHER-GRANT-RT")
})

test("a fresh login of a saved account's email doesn't lose the saved one: it is in the sync backups (fourth review)", async () => {
  await loggedIn("a@x", "RT-PERSONAL")
  expect((await run("claude", "save", "personal")).code).toBe(0)
  // `/login` once more with the same email (another workspace, or a login for the cloud), then a look at the slots
  await loggedIn("a@x", "RT-TEAM")
  await run("claude", "list")
  const { readdir: list } = await import("node:fs/promises")
  const kept = await list(join(switchDir, "sync-backups", "claude"))
  expect(kept).toHaveLength(1)
  expect(await readFile(join(switchDir, "sync-backups", "claude", kept[0]!, "credentials.json"), "utf8")).toContain("RT-PERSONAL")
})

test("refresh renews an idle Claude Code's expired live login into its store and its slot, and leaves a running one alone", async () => {
  valid = new Set(["live-r"])
  await slot("work", "w@acme.dev", "live-r", 1)
  await writeFile(join(claudeDir, ".credentials.json"), blob("live-r", 1))
  await writeFile(join(claudeDir, ".claude.json"), account("w@acme.dev"))
  const config = await readFile(join(claudeDir, ".claude.json"), "utf8")

  claudeRunning = true
  const running = await run("claude", "refresh")
  expect(seen).toEqual([])
  expect(running.out).toContain("Claude Code is running and renews it itself")
  expect(running.out).not.toContain("load this slot")

  claudeRunning = false
  const idle = await run("claude", "refresh")
  expect(idle.code).toBe(0)
  expect(seen).toEqual(["live-r"])
  expect(idle.out).toContain('claude "work": renewed the live login')
  const stored = JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")).claudeAiOauth
  expect(stored.refreshToken).toBe("live-r-2")
  expect(stored.expiresAt).toBeGreaterThan(Date.now())
  expect(await refreshOf("work")).toBe("live-r-2")
  expect(await readFile(join(claudeDir, ".claude.json"), "utf8")).toBe(config)
})

test("a live login Claude Code changed during the renewal stays live, and the renewal is kept, never lost", async () => {
  valid = new Set(["live-r"])
  await slot("work", "w@acme.dev", "live-r", 1)
  await writeFile(join(claudeDir, ".credentials.json"), blob("live-r", 1))
  await writeFile(join(claudeDir, ".claude.json"), account("w@acme.dev"))
  duringRefresh = () => writeFile(join(claudeDir, ".credentials.json"), blob("claude-own", later()))

  const result = await run("claude", "refresh")
  expect(seen).toEqual(["live-r"])
  expect(result.out).toContain("the live login changed while it was being renewed, so it was left as it is; the renewal is in ")
  expect(JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("claude-own")
  expect(await refreshOf("work")).toBe("claude-own")
  const named = result.out.match(/the renewal is in (\S+?)\n/)![1]!
  expect(JSON.parse(await readFile(join(named, "credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("live-r-2")
})

async function expiredLive(): Promise<string> {
  valid = new Set(["live-r"])
  await slot("work", "w@acme.dev", "live-r", 1)
  await writeFile(join(claudeDir, ".credentials.json"), blob("live-r", 1))
  await writeFile(join(claudeDir, ".claude.json"), account("w@acme.dev"))
  return await readFile(join(claudeDir, ".credentials.json"), "utf8")
}

test("a Claude Code that starts during the token call keeps its login: the renewal goes to a backup, never live", async () => {
  const live = await expiredLive()
  duringRefresh = () => writeFile(runningFlag(), "")

  const result = await run("claude", "refresh")
  expect(seen).toEqual(["live-r"])
  expect(result.out).toContain("Claude Code started while it was being renewed, so the live login was left to it; the renewal is in ")
  expect(await readFile(join(claudeDir, ".credentials.json"), "utf8")).toBe(live)
  const named = result.out.match(/the renewal is in (\S+?), and in "work", which `kyora-switch claude load <slot>` puts live\n/)![1]!
  expect(JSON.parse(await readFile(join(named, "credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("live-r-2")

  // the run's own sync, and every later one, keep the renewal in its slot: the live login holds the token it spent
  expect(await refreshOf("work")).toBe("live-r-2")
  const synced = await run("claude", "sync")
  expect(synced.out).toContain('kept "work": it holds a renewal of the live login\'s spent token; `kyora-switch claude load work` puts it live')
  expect(await refreshOf("work")).toBe("live-r-2")
  const again = await run("claude", "refresh")
  expect(seen).toEqual(["live-r"])
  expect(again.out).toContain('a renewal already spent its token and is in "work": `kyora-switch claude load work` puts it live')
  expect(await readFile(join(claudeDir, ".credentials.json"), "utf8")).toBe(live)

  expect((await run("claude", "load", "work")).code).toBe(0)
  expect(JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("live-r-2")
  await run("claude", "sync")
  expect(await refreshOf("work")).toBe("live-r-2")
})

test("whether Claude Code runs is unknown when pgrep fails or is missing: the live login is left alone and the row says so", async () => {
  for (const idle of ["exit 2", "exit 3", null]) {
    pgrepIdle = idle
    const live = await expiredLive()
    const result = await run("claude", "refresh")
    expect(seen).toEqual([])
    expect(result.out).toMatch(/not renewed: could not tell whether Claude Code is running \((pgrep failed \(exit [23]\)|pgrep could not be run)\), so the live login was left to it/)
    expect(await readFile(join(claudeDir, ".credentials.json"), "utf8")).toBe(live)

    const shown = await run("claude", "usage", "--no-renew")
    expect(shown.out).toContain("Claude Code renews it when it next runs (whether it runs now could not be told: ")
    expect(shown.out).not.toContain("`kyora-switch refresh` renews it now")
  }
})

test("Claude Code run by node or bun from an npm install counts as running; this process and look-alikes do not", async () => {
  for (const line of [
    "4343 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume",
    "4344 /opt/homebrew/bin/node /opt/homebrew/bin/claude",
    "4345 node /Users/Some One/project/node_modules/.bin/claude -p hi",
    "4349 /Users/me/.bun/bin/bun /tmp/bunx-501-@anthropic-ai/claude-code@latest/node_modules/@anthropic-ai/claude-code/cli.js",
  ]) {
    psLines = [line]
    const live = await expiredLive()
    const result = await run("claude", "refresh")
    expect(seen).toEqual([])
    expect(result.out).toContain("Claude Code is running and renews it itself")
    expect(await readFile(join(claudeDir, ".credentials.json"), "utf8")).toBe(live)
  }

  psLines = [
    "$PPID node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "4346 node /srv/app/server.js --name claude",
    "4347 vim /usr/local/bin/claude",
    "4348 node /usr/local/bin/claude-mcp",
  ]
  await expiredLive()
  const idle = await run("claude", "refresh")
  expect(seen).toEqual(["live-r"])
  expect(idle.out).toContain('claude "work": renewed the live login')
})

test("usage never renews a login, live or due, with or without --no-renew: it says to run refresh, which renews it", async () => {
  const live = await expiredLive()
  claudeRunning = true
  expect((await run("claude", "usage")).out).toContain("Claude Code is running and renews it itself")

  claudeRunning = false
  for (const args of [["claude", "usage"], ["claude", "usage", "--no-renew"], ["usage"]]) {
    const shown = await run(...args)
    expect(shown.out).toContain("Claude Code renews it when it next runs; `kyora-switch refresh` renews it now")
  }
  expect(seen).toEqual([])
  expect(await readFile(join(claudeDir, ".credentials.json"), "utf8")).toBe(live)
  expect((await run("claude", "refresh", "--no-renew")).out).toContain("--no-renew and refresh contradict each other")

  const renewed = await run("refresh")
  expect(renewed.code).toBe(0)
  expect(seen).toEqual(["live-r"])
  expect(renewed.out).toContain('claude "work": renewed the live login')
  expect(JSON.parse(await readFile(join(claudeDir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("live-r-2")
})

test("the owner's watcher: its 5 minute usage polls renew nothing, its refresh renews a live login inside Claude Code's 5 minute margin", async () => {
  valid = new Set(["live-r"])
  await slot("work", "w@acme.dev", "live-r", 1)
  await writeFile(join(claudeDir, ".claude.json"), account("w@acme.dev"))
  await writeFile(join(claudeDir, ".credentials.json"), blob("live-r", Date.now() + 2 * 60_000))
  await run("usage")
  await run("usage")
  expect(seen).toEqual([])
  expect((await run("refresh")).out).toContain('claude "work": renewed the live login')
  expect(seen).toEqual(["live-r"])
  await run("refresh")
  expect(seen).toEqual(["live-r"])
})

test("refresh leaves a grant whose renewal failed alone for an hour unless run for that CLI, and a refused one until it is saved again", async () => {
  await expiredLive()
  serverError = true
  expect((await run("refresh")).out).toContain("server error (HTTP 500)")
  expect(seen).toEqual(["live-r"])
  const held = await run("refresh")
  expect(held.out).toContain("retried after an hour, or now by `kyora-switch claude refresh`")
  expect(seen).toEqual(["live-r"])
  expect((await run("claude", "usage")).out).toContain("not renewed: server error (HTTP 500)")
  await run("claude", "refresh")
  expect(seen).toEqual(["live-r", "live-r"])

  serverError = false
  valid = new Set()
  expect((await run("claude", "refresh")).out).toContain("already used or revoked")
  await run("claude", "refresh")
  await run("refresh")
  expect(seen).toEqual(["live-r", "live-r", "live-r"])
  valid = new Set(["live-r"])
  await run("claude", "save", "work")
  expect((await run("refresh")).out).toContain('claude "work": renewed the live login')
  expect(seen).toEqual(["live-r", "live-r", "live-r", "live-r"])
})
