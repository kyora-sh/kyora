import { afterEach, beforeEach, expect, test } from "bun:test"
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, mkdirSync, openSync, writeFileSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSnapshot, withSwitchLock, writeSnapshot } from "../store"
import { syncLiveSlot } from "../sync"
import { gapsPath, readHistory } from "../token-history"
import { describeIdentity, type Snapshot } from "../types"
import {
  GROK_API_KEY_SCOPE,
  GROK_AUTH_NOTE,
  GROK_DEFAULT_SCOPE,
  GROK_LEGACY_SCOPE,
  grokAuthPath,
  grokHome,
  grokLockPath,
  grokProvider,
  grokScope,
  grokSession,
  refreshStore,
  withGrokLock,
  XAI_API_KEY_NOTE,
} from "./grok"

let dir: string
const VARS = ["GROK_HOME", "GROK_AUTH_PATH", "GROK_AUTH", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID", "GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID", "KYORA_SWITCH_DIR", "KYORA_GROK_TOKEN_URL", "KYORA_GROK_USAGE_URL"]
const previous = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-grok-"))
  for (const name of VARS) delete process.env[name]
  process.env.GROK_HOME = join(dir, "grok")
  process.env.KYORA_SWITCH_DIR = join(dir, "slots")
})

afterEach(async () => {
  for (const name of VARS) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  await rm(dir, { recursive: true, force: true })
})

const authPath = () => join(dir, "grok", "auth.json")
const ENTERPRISE_SCOPE = "https://idp.acme.example::cli"

function session(email: string, token: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: `fake-session-${token}`,
    auth_mode: "oidc",
    create_time: "2026-10-01T00:00:00Z",
    user_id: `user-${token}`,
    email,
    first_name: "Fixture",
    last_name: "User",
    coding_data_retention_opt_out: true,
    refresh_token: `fake-refresh-${token}`,
    expires_at: "2099-01-01T00:00:00Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    ...extra,
  }
}

const apiKey = (key: string) => ({ key, auth_mode: "api_key", create_time: "2026-10-01T00:00:00Z", user_id: "" })
const store = (entries: Record<string, unknown>) => `${JSON.stringify(entries, null, 2)}\n`
const snapshotOf = (text: string): Snapshot => ({ provider: "grok", identity: {}, files: { "auth.json": text }, capturedAt: 1 })
const live = async () => JSON.parse(await Bun.file(authPath()).text()) as Record<string, Record<string, unknown>>
const slotOf = async (name: string) => JSON.parse((await readSnapshot("grok", name))!.files["auth.json"]!) as Record<string, Record<string, unknown>>

async function seed(text: string): Promise<void> {
  await mkdir(join(dir, "grok"), { recursive: true })
  await writeFile(authPath(), text)
}

async function save(name: string, entries: Record<string, unknown>): Promise<void> {
  await seed(store(entries))
  await writeSnapshot(name, (await grokProvider.capture())!)
}

/** the CLI in its own process, on this test's dirs, with every vendor route on a local server */
/** a `pgrep` that finds grok running, or finds nothing: whatever runs on this machine never reaches a test */
function pgrep(running: boolean): string {
  const bin = join(dir, running ? "bin-running" : "bin-idle")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "pgrep"), running ? "#!/bin/sh\necho 4242\n" : "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  return bin
}

function cli(args: string[], port: number, running = false) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), "grok", ...args], {
    env: {
      PATH: `${pgrep(running)}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      GROK_HOME: join(dir, "grok"),
      KYORA_SWITCH_DIR: join(dir, "slots"),
      KYORA_SWITCH_NO_KEYCHAIN: "1",
      NODE_ENV: "test",
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
      KYORA_GROK_TOKEN_URL: `http://127.0.0.1:${port}/token`,
      KYORA_GROK_USAGE_URL: `http://127.0.0.1:${port}/usage`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function output(proc: ReturnType<typeof cli>): Promise<string> {
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return `${out}${err}`
}

test("locations follow GROK_HOME and GROK_AUTH_PATH, an empty one counting as unset", () => {
  expect(grokHome()).toBe(join(dir, "grok"))
  expect(grokAuthPath()).toBe(authPath())
  process.env.GROK_AUTH_PATH = join(dir, "elsewhere.json")
  expect(grokAuthPath()).toBe(join(dir, "elsewhere.json"))
  process.env.GROK_AUTH_PATH = ""
  process.env.GROK_HOME = ""
  expect(grokHome().endsWith("/.grok")).toBe(true)
  expect(grokAuthPath()).toBe(join(grokHome(), "auth.json"))
})

test("process name matches the launcher and the versioned binary it links to", () => {
  const pattern = new RegExp("^(?:" + grokProvider.processName + ")$")
  for (const name of ["grok", "grok-1.0.52-macos-aarch64", "grok-1.0.52-maco", "grok-1.0.52-lin"]) expect(pattern.test(name)).toBe(true)
  for (const name of ["groks", "grok-", "grok-build", "bash"]) expect(pattern.test(name)).toBe(false)
})

test("capture returns null with no auth.json, an empty one, an empty store, or one grok could not sign in with", async () => {
  expect(await grokProvider.capture()).toBeNull()
  await seed("")
  expect(await grokProvider.capture()).toBeNull()
  await seed("  \n")
  expect(await grokProvider.capture()).toBeNull()
  await seed("{}")
  expect(await grokProvider.capture()).toBeNull()
  await seed(store({ [GROK_DEFAULT_SCOPE]: { key: "fake-stub", auth_mode: "oidc" }, [GROK_API_KEY_SCOPE]: { key: "fake-xai-key" } }))
  expect(await grokProvider.capture()).toBeNull()
  await seed(store({ [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") }))
  expect(await grokProvider.capture()).toBeNull()
})

test("capture reports a corrupt auth.json instead of silently skipping it", async () => {
  await seed("{not json")
  await expect(grokProvider.capture()).rejects.toThrow("is not valid JSON")
  await seed("[]")
  await expect(grokProvider.capture()).rejects.toThrow("is not a JSON object")
})

test("capture keeps only grok's session and stored key, byte stable, and names the account and its team", async () => {
  const a = session("a@acme.dev", "a", { principal_type: "Team", team_name: "Acme", principal_id: "team-1" })
  await seed(store({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key"), [ENTERPRISE_SCOPE]: session("e@acme.dev", "e"), [GROK_DEFAULT_SCOPE]: a }))
  const captured = (await grokProvider.capture())!
  expect(captured.identity).toEqual({ account: "a@acme.dev", id: `${GROK_DEFAULT_SCOPE} Team team-1`, org: "Acme", plan: "team" })
  expect(captured.files["auth.json"]).toBe(store({ [GROK_DEFAULT_SCOPE]: a, [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") }))
  expect(captured.files["auth.json"]).not.toContain("fake-session-e")

  await seed(JSON.stringify({ [GROK_DEFAULT_SCOPE]: a, [ENTERPRISE_SCOPE]: session("e@acme.dev", "e"), [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") }))
  expect((await grokProvider.capture())!.files["auth.json"]).toBe(captured.files["auth.json"]!)
})

test("restore swaps the session and key as a pair and keeps every other scope", async () => {
  await save("work", { [GROK_DEFAULT_SCOPE]: session("work@acme.dev", "w") })
  const enterprise = session("e@acme.dev", "e")
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("home@acme.dev", "h"), [GROK_API_KEY_SCOPE]: apiKey("fake-home-key"), [ENTERPRISE_SCOPE]: enterprise }))

  await grokProvider.restore((await readSnapshot("grok", "work"))!)

  const after = await live()
  expect(Object.keys(after)).toEqual([GROK_DEFAULT_SCOPE, ENTERPRISE_SCOPE])
  expect(after[GROK_DEFAULT_SCOPE]!.email).toBe("work@acme.dev")
  expect(after[ENTERPRISE_SCOPE]).toEqual(enterprise)
  expect((await stat(authPath())).mode & 0o777).toBe(0o600)
  expect(await Bun.file(authPath()).text()).toBe(JSON.stringify({ [GROK_DEFAULT_SCOPE]: after[GROK_DEFAULT_SCOPE], [ENTERPRISE_SCOPE]: enterprise }, null, 2))
})

test("restore of the login already live leaves auth.json byte for byte", async () => {
  const text = `{"${GROK_DEFAULT_SCOPE}": ${JSON.stringify(session("a@acme.dev", "a"))}, "${ENTERPRISE_SCOPE}": ${JSON.stringify(session("e@acme.dev", "e"))}}`
  await seed(text)
  await grokProvider.restore((await grokProvider.capture())!)
  expect(await Bun.file(authPath()).text()).toBe(text)
})

test("restore writes through a symlinked auth.json to its target", async () => {
  const target = join(dir, "dotfiles", "grok-auth.json")
  await mkdir(join(dir, "dotfiles"), { recursive: true })
  await writeFile(target, store({ [GROK_DEFAULT_SCOPE]: session("home@acme.dev", "h") }))
  await mkdir(join(dir, "grok"), { recursive: true })
  await symlink(target, authPath())

  await grokProvider.restore(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("work@acme.dev", "w") })))

  expect((await lstat(authPath())).isSymbolicLink()).toBe(true)
  expect(JSON.parse(await readFile(target, "utf8"))[GROK_DEFAULT_SCOPE].email).toBe("work@acme.dev")
})

test("restore refuses a slot saved for a scope grok does not sign in with, and leaves auth.json alone", async () => {
  const text = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a"), [ENTERPRISE_SCOPE]: session("dormant@acme.dev", "d") })
  await seed(text)
  await expect(grokProvider.restore(snapshotOf(store({ [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") })))).rejects.toThrow("auth.json is unchanged")
  expect(await Bun.file(authPath()).text()).toBe(text)

  const legacy = snapshotOf(store({ [GROK_LEGACY_SCOPE]: session("l@acme.dev", "l") }))
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { auth_mode: "web_login" }) }))
  await expect(grokProvider.restore(legacy)).rejects.toThrow("auth.json is unchanged")
  await seed(text)
  await grokProvider.restore(legacy)
  expect(Object.keys(await live()).sort()).toEqual([GROK_LEGACY_SCOPE, ENTERPRISE_SCOPE].sort())
})

test("signing out the last login through a symlinked auth.json empties its target and keeps the link", async () => {
  const target = join(dir, "dotfiles", "grok-auth.json")
  await mkdir(join(dir, "dotfiles"), { recursive: true })
  await writeFile(target, store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") }))
  await mkdir(join(dir, "grok"), { recursive: true })
  await symlink(target, authPath())
  await grokProvider.forget()
  expect((await lstat(authPath())).isSymbolicLink()).toBe(true)
  expect(await readFile(target, "utf8")).toBe("{}")
  expect(await grokProvider.capture()).toBeNull()
})

test("restore follows GROK_AUTH_PATH and refuses a slot with no credentials", async () => {
  process.env.GROK_AUTH_PATH = join(dir, "custom", "auth.json")
  await grokProvider.restore(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })))
  expect(await Bun.file(join(dir, "custom", "auth.json")).exists()).toBe(true)
  await expect(grokProvider.restore({ ...snapshotOf(""), files: {} })).rejects.toThrow("slot has no Grok Build credentials")
  await expect(grokProvider.restore(snapshotOf("{}"))).rejects.toThrow("slot has no Grok Build credentials")
})

test("forget signs out the active scope alone, as grok's logout does, and deletes the file with the last one", async () => {
  const enterprise = session("e@acme.dev", "e")
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a"), [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key"), [ENTERPRISE_SCOPE]: enterprise }))
  await grokProvider.forget()
  expect(await live()).toEqual({ [ENTERPRISE_SCOPE]: enterprise, [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") })

  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") }))
  await grokProvider.forget()
  expect(await Bun.file(authPath()).exists()).toBe(false)
  await grokProvider.forget()
  expect(await Bun.file(authPath()).exists()).toBe(false)
})

test("the session is the active scope's entry, else the legacy scope's; a legacy web login is none", () => {
  const a = session("a@acme.dev", "a")
  const b = session("b@acme.dev", "b")
  expect(grokSession({ [GROK_DEFAULT_SCOPE]: a, [GROK_LEGACY_SCOPE]: b })?.entry).toEqual(a)
  expect(grokSession({ [GROK_LEGACY_SCOPE]: b })?.entry).toEqual(b)
  expect(grokSession({ [GROK_DEFAULT_SCOPE]: { ...a, auth_mode: "web_login" }, [GROK_LEGACY_SCOPE]: b })).toBeNull()
  expect(grokSession({ [GROK_DEFAULT_SCOPE]: { ...a, key: undefined }, [GROK_LEGACY_SCOPE]: b })?.entry).toEqual(b)
  expect(grokSession({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") })).toBeNull()
})

test("the scope comes from the OIDC or OAuth2 env, else config.toml, as grok keys it; an empty variable is set", async () => {
  const home = join(dir, "grok")
  expect(grokScope({ GROK_HOME: home })).toBe(GROK_DEFAULT_SCOPE)
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "https://idp.acme.example/", GROK_OIDC_CLIENT_ID: "cli" })).toBe(ENTERPRISE_SCOPE)
  expect(grokScope({ GROK_HOME: home, GROK_OAUTH2_ISSUER: "https://auth.acme.example", GROK_OAUTH2_CLIENT_ID: "c2" })).toBe("https://auth.acme.example::c2")
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "https://idp.acme.example" })).toBe(GROK_DEFAULT_SCOPE)
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "", GROK_OIDC_CLIENT_ID: "" })).toBe("::")
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "https://idp.acme.example", GROK_OIDC_CLIENT_ID: "" })).toBe("https://idp.acme.example::")
  expect(grokScope({ GROK_HOME: home, GROK_OAUTH2_ISSUER: "", GROK_OAUTH2_CLIENT_ID: "c2" })).toBe("::c2")
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "", GROK_OAUTH2_ISSUER: "https://auth.acme.example", GROK_OAUTH2_CLIENT_ID: "c2" })).toBe("https://auth.acme.example::c2")

  await mkdir(home, { recursive: true })
  await writeFile(join(home, "config.toml"), '[grok_com_config.oidc]\nissuer = "https://idp.acme.example/"\nclient_id = "cli"\n')
  expect(grokScope({ GROK_HOME: home })).toBe(ENTERPRISE_SCOPE)
  await writeFile(join(home, "config.toml"), '[auth.oauth2]\nclient_id = "c3"\n')
  expect(grokScope({ GROK_HOME: home })).toBe("https://auth.x.ai::c3")
  expect(grokScope({ GROK_HOME: home, GROK_OIDC_ISSUER: "https://idp.acme.example", GROK_OIDC_CLIENT_ID: "cli" })).toBe(ENTERPRISE_SCOPE)

  const enterprise = session("e@acme.dev", "e")
  const env = { GROK_HOME: home, GROK_OIDC_ISSUER: "https://idp.acme.example", GROK_OIDC_CLIENT_ID: "cli" }
  expect(grokSession({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a"), [ENTERPRISE_SCOPE]: enterprise }, env)?.entry).toEqual(enterprise)
})

test("a stored API key alone is named by the key and never shows it whole", async () => {
  await seed(store({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key-1234") }))
  const captured = (await grokProvider.capture())!
  expect(captured.identity.plan).toBe("api key")
  expect(captured.identity.account).toMatch(/^key …1234 #[0-9a-f]{8}$/)
  expect(describeIdentity(captured.identity)).not.toContain("fake-xai-key")
  expect(grokProvider.grant!(captured)).toBe("fake-xai-key-1234")
  expect(grokProvider.credentialExpiry!(captured)).toBeUndefined()
})

test("a login with no email shows the full name, which is never its account, and is matched by its user id", async () => {
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("", "a") }))
  expect((await grokProvider.capture())!.identity).toEqual({ account: undefined, name: "Fixture User", id: `${GROK_DEFAULT_SCOPE} user-a` })
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("", "a", { principal_type: "Team" }) }))
  expect((await grokProvider.capture())!.identity.id).toBeUndefined()
})

test("a team login without email follows its slot through a token rotation and grok's user lookup, and never into another team's", async () => {
  // grok signs a team in with the team as its user id, then rewrites it to the user's once it looks the user up
  const team = (refresh: string, principal: string, user = principal) =>
    session("", refresh, { user_id: user, principal_type: "Team", principal_id: principal, team_name: "Acme" })
  await save("acme", { [GROK_DEFAULT_SCOPE]: team("t1", "team-1") })
  await save("other", { [GROK_DEFAULT_SCOPE]: team("o1", "team-2") })
  expect((await readSnapshot("grok", "acme"))!.identity.id).toBe(`${GROK_DEFAULT_SCOPE} Team team-1`)

  await seed(store({ [GROK_DEFAULT_SCOPE]: team("t2", "team-1", "user-t") }))
  expect((await syncLiveSlot(grokProvider)).synced).toBe("acme")
  expect((await slotOf("acme"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-t2")
  expect((await slotOf("other"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-o1")

  await seed(store({ [GROK_DEFAULT_SCOPE]: team("n1", "team-3") }))
  expect((await syncLiveSlot(grokProvider)).synced).toBeNull()

  // two users' slots of one team share its id: a rotation of either matches both, so neither is written
  await save("acme2", { [GROK_DEFAULT_SCOPE]: team("u1", "team-1", "user-u") })
  await seed(store({ [GROK_DEFAULT_SCOPE]: team("t3", "team-1", "user-t") }))
  const state = await syncLiveSlot(grokProvider)
  expect(state.synced).toBeNull()
  expect(state.ambiguous.sort()).toEqual(["acme", "acme2"])
  expect((await slotOf("acme"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-t2")
  expect((await slotOf("acme2"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-u1")
})

test("an organization login without email is matched by the organization, one with an email by the email", async () => {
  const org = (email: string, user: string) => session(email, "o", { user_id: user, principal_type: "Organization", principal_id: "org-1" })
  await seed(store({ [GROK_DEFAULT_SCOPE]: org("", "org-1") }))
  const signedIn = (await grokProvider.capture())!.identity.id
  await seed(store({ [GROK_DEFAULT_SCOPE]: org("", "user-o") }))
  expect((await grokProvider.capture())!.identity.id).toBe(signedIn!)
  expect(signedIn).toBe(`${GROK_DEFAULT_SCOPE} Organization org-1`)
  await seed(store({ [GROK_DEFAULT_SCOPE]: org("o@acme.dev", "user-o") }))
  const withEmail = (await grokProvider.capture())!.identity
  expect(withEmail.account).toBe("o@acme.dev")
  expect(withEmail.id).toBeUndefined()
})

test("grant prefers the refresh token, then the session token", () => {
  expect(grokProvider.grant!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })))).toBe("fake-refresh-a")
  expect(grokProvider.grant!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { refresh_token: undefined }) })))).toBe("fake-session-a")
  expect(grokProvider.grant!(snapshotOf("{not json"))).toBeUndefined()
})

test("each stored login is its own grant: a slot is backed up when its stored key changes, not on a routine refresh", async () => {
  await save("work", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a"), [GROK_API_KEY_SCOPE]: apiKey("fake-key-1") })
  expect(grokProvider.fileGrants!((await readSnapshot("grok", "work"))!)).toEqual({ [GROK_DEFAULT_SCOPE]: "fake-refresh-a", [GROK_API_KEY_SCOPE]: "fake-key-1" })

  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { key: "fake-session-a2" }), [GROK_API_KEY_SCOPE]: apiKey("fake-key-1") }))
  expect((await syncLiveSlot(grokProvider)).synced).toBe("work")
  expect(await readdir(join(dir, "slots", "sync-backups")).catch(() => [])).toEqual([])

  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { key: "fake-session-a2" }), [GROK_API_KEY_SCOPE]: apiKey("fake-key-2") }))
  expect((await syncLiveSlot(grokProvider)).synced).toBe("work")
  expect((await slotOf("work"))[GROK_API_KEY_SCOPE]!.key).toBe("fake-key-2")
  const backups = await readdir(join(dir, "slots", "sync-backups", "grok"))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, "slots", "sync-backups", "grok", backups[0]!, "auth.json"), "utf8")).toContain("fake-key-1")
})

test("a slot holding another scope's login as well is backed up before sync narrows it to grok's own", async () => {
  const a = session("a@acme.dev", "a")
  await writeSnapshot("work", { ...snapshotOf(store({ [GROK_DEFAULT_SCOPE]: a, [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") })), identity: { account: "a@acme.dev" } })
  await seed(store({ [GROK_DEFAULT_SCOPE]: a }))
  expect((await syncLiveSlot(grokProvider)).synced).toBe("work")
  const backups = await readdir(join(dir, "slots", "sync-backups", "grok"))
  expect(await readFile(join(dir, "slots", "sync-backups", "grok", backups[0]!, "auth.json"), "utf8")).toContain("fake-refresh-e")
})

test("credentialExpiry reads expires_at, else grok's 30 day TTL from create_time", () => {
  expect(grokProvider.credentialExpiry!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })))).toBe(Date.parse("2099-01-01T00:00:00Z"))
  const noExpiry = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { expires_at: undefined }) })
  expect(grokProvider.credentialExpiry!(snapshotOf(noExpiry))).toBe(Date.parse("2026-10-31T00:00:00Z"))
})

test("GROK_AUTH beats every slot and an environment key beats a stored one; neither value is read into a slot", async () => {
  const keyOnly = store({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") })
  const signedIn = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })
  expect(grokProvider.notes!(snapshotOf(keyOnly))).toEqual([])
  process.env.XAI_API_KEY = "fake-env-key"
  expect(grokProvider.notes!(snapshotOf(keyOnly))).toEqual([XAI_API_KEY_NOTE])
  expect(grokProvider.notes!(snapshotOf(signedIn))).toEqual([])
  delete process.env.XAI_API_KEY
  process.env.GROK_CODE_XAI_API_KEY = "fake-legacy-key"
  expect(grokProvider.notes!(snapshotOf(keyOnly))).toEqual([XAI_API_KEY_NOTE])
  delete process.env.GROK_CODE_XAI_API_KEY
  process.env.GROK_AUTH = JSON.stringify(session("env@acme.dev", "env"))
  expect(grokProvider.notes!(snapshotOf(signedIn))).toEqual([GROK_AUTH_NOTE])
  expect(grokProvider.notes!(null)).toEqual([GROK_AUTH_NOTE])
  expect(grokProvider.locations()).toContain(GROK_AUTH_NOTE)
  await seed(signedIn)
  const captured = (await grokProvider.capture())!
  expect(JSON.stringify(captured)).not.toContain("fake-session-env")
})

test("refresh trades the refresh token at xAI's token endpoint and keeps the stored key", async () => {
  const forms: Record<string, string>[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      const form = Object.fromEntries(new URLSearchParams(await request.text()))
      forms.push(form)
      if (form.refresh_token !== "fake-refresh-a") return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: "fake-session-a2", refresh_token: "fake-refresh-a2", expires_in: 3600 })
    },
  })
  process.env.KYORA_GROK_TOKEN_URL = server.url.href
  const key = apiKey("fake-xai-key")
  const before = Date.now()
  const renewal = await grokProvider.refresh!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { principal_type: "Team", principal_id: "team-1" }), [GROK_API_KEY_SCOPE]: key })))
  if (!("snapshot" in renewal)) throw new Error(renewal.failure)
  const refreshed = renewal.snapshot
  expect(forms).toEqual([{ grant_type: "refresh_token", refresh_token: "fake-refresh-a", client_id: "b1a00492-073a-47ea-816f-4c329264a828", principal_type: "Team", principal_id: "team-1" }])
  const next = JSON.parse(refreshed.files["auth.json"]!)
  expect(next[GROK_API_KEY_SCOPE]).toEqual(key)
  expect(next[GROK_DEFAULT_SCOPE]).toMatchObject({ key: "fake-session-a2", refresh_token: "fake-refresh-a2", email: "a@acme.dev", user_id: "user-a", auth_mode: "oidc" })
  expect(Date.parse(next[GROK_DEFAULT_SCOPE].expires_at)).toBeGreaterThanOrEqual(before + 3_600_000)
  expect(grokProvider.grant!(refreshed)).toBe("fake-refresh-a2")

  expect(await grokProvider.refresh!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "spent") })))).toEqual({
    failure: "the stored refresh token was already used or revoked: log in again and save",
  })
})

test("refresh leaves alone what grok does not renew through xAI: other issuers, external providers, stored keys", async () => {
  let calls = 0
  using server = Bun.serve({ port: 0, fetch() { calls++; return Response.json({ access_token: "never" }) } })
  process.env.KYORA_GROK_TOKEN_URL = server.url.href
  const otherIssuer = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { oidc_issuer: "https://idp.acme.example" }) })
  const external = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { auth_mode: "external" }) })
  const noRefresh = store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { refresh_token: undefined }) })
  for (const text of [otherIssuer, external, noRefresh, store({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") }), "{not json"]) expect(await refreshStore(text)).toHaveProperty("failure")
  expect(calls).toBe(0)
  expect(grokProvider.renewsItself!(snapshotOf(otherIssuer))).toBe(true)
  expect(grokProvider.renewsItself!(snapshotOf(external))).toBe(true)
  expect(grokProvider.renewsItself!(snapshotOf(noRefresh))).toBe(false)
})

test("quota asks the CLI proxy with the session token and user id, never with an API key", async () => {
  const seen: (string | null)[][] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push([request.headers.get("authorization"), request.headers.get("x-userid")])
      return Response.json({ config: { creditUsagePercent: 25, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" } } })
    },
  })
  process.env.KYORA_GROK_USAGE_URL = server.url.href
  const usage = await grokProvider.quota!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })))
  expect(usage?.remainingPct).toBe(75)
  expect(usage?.windows?.[0]?.label).toBe("weekly")
  expect(await grokProvider.quota!(snapshotOf(store({ [GROK_API_KEY_SCOPE]: apiKey("fake-xai-key") })))).toBeNull()
  expect(await grokProvider.quota!(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "b", { oidc_issuer: "https://idp.acme.example" }) })))).toBeNull()
  expect(seen).toEqual([["Bearer fake-session-a", "user-a"]])
})

const flock = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
}).symbols.flock

test("writes take grok's auth.json.lock, fail loudly while grok holds it, and never delete it", async () => {
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") }))
  const held = openSync(grokLockPath(), constants.O_RDWR | constants.O_CREAT, 0o600)
  expect(flock(held, 2 | 4)).toBe(0)
  let ran = false
  try {
    await expect(withGrokLock(async () => { ran = true }, 200)).rejects.toThrow("left auth.json unchanged")
    expect(ran).toBe(false)
  } finally {
    flock(held, 8)
    closeSync(held)
  }

  const stamp = await withGrokLock(async () => {
    await grokProvider.restore(snapshotOf(store({ [GROK_DEFAULT_SCOPE]: session("b@acme.dev", "b") })))
    return await readFile(grokLockPath(), "utf8")
  })
  expect(stamp).toMatch(new RegExp(`^${process.pid}:\\d+$`))
  expect((await live())[GROK_DEFAULT_SCOPE]!.email).toBe("b@acme.dev")
  expect(await Bun.file(grokLockPath()).exists()).toBe(true)
})

test("save, switch and load back round-trips both accounts, and the live login syncs into its slot", async () => {
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })
  await save("b", { [GROK_DEFAULT_SCOPE]: session("b@acme.dev", "b") })
  await grokProvider.restore((await readSnapshot("grok", "a"))!)
  expect((await live())[GROK_DEFAULT_SCOPE]!.email).toBe("a@acme.dev")
  expect((await syncLiveSlot(grokProvider)).live?.name).toBe("a")

  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", { key: "fake-session-a2" }) }))
  expect((await syncLiveSlot(grokProvider)).synced).toBe("a")
  expect((await slotOf("a"))[GROK_DEFAULT_SCOPE]!.key).toBe("fake-session-a2")
  expect((await slotOf("b"))[GROK_DEFAULT_SCOPE]!.key).toBe("fake-session-b")
})

test("refresh never spends the live grant, spends a shared one once for every slot, and leaves grok's own renewals to grok", async () => {
  const past = { expires_at: "2020-01-01T00:00:00Z" }
  const spent: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/usage") return Response.json({ config: { creditUsagePercent: 10 } })
      const form = Object.fromEntries(new URLSearchParams(await request.text()))
      spent.push(form.refresh_token!)
      if (form.refresh_token !== "fake-refresh-shared") return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: "fake-session-shared2", refresh_token: "fake-refresh-shared2", expires_in: 3600 })
    },
  })
  await save("a", { [GROK_DEFAULT_SCOPE]: session("live@acme.dev", "live") })
  await save("b", { [GROK_DEFAULT_SCOPE]: session("renamed@acme.dev", "live", past) })
  await save("c", { [GROK_DEFAULT_SCOPE]: session("s@acme.dev", "shared", past) })
  await save("d", { [GROK_DEFAULT_SCOPE]: session("s@acme.dev", "shared", past), [GROK_API_KEY_SCOPE]: apiKey("fake-key-d") })
  await save("e", { [GROK_DEFAULT_SCOPE]: session("e@acme.dev", "e", { ...past, oidc_issuer: "https://idp.acme.example" }) })
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("live@acme.dev", "live") }))

  const printed = await output(cli(["refresh"], server.port!))

  expect(spent).toEqual(["fake-refresh-shared"])
  expect((await slotOf("b"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-live")
  expect((await slotOf("c"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-shared2")
  expect((await slotOf("d"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-shared2")
  expect((await slotOf("d"))[GROK_API_KEY_SCOPE]!.key).toBe("fake-key-d")
  expect((await slotOf("c"))[GROK_API_KEY_SCOPE]).toBeUndefined()
  expect(printed).toContain('grok "e": Grok Build renews this login itself')
  expect(printed).not.toContain("not renewed")
})

test("a load during a slow refresh of its slot waits for it, and puts the rotated token live and in the slot", async () => {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let asked!: () => void
  const refreshing = new Promise<void>((resolve) => (asked = resolve))
  const spent: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/usage") return Response.json({ config: { creditUsagePercent: 10 } })
      const form = Object.fromEntries(new URLSearchParams(await request.text()))
      spent.push(form.refresh_token!)
      if (form.refresh_token !== "fake-refresh-b") return Response.json({ error: "invalid_grant" }, { status: 400 })
      asked()
      await released
      return Response.json({ access_token: "fake-session-b2", refresh_token: "fake-refresh-b2", expires_in: 3600 })
    },
  })
  await save("b", { [GROK_DEFAULT_SCOPE]: session("b@acme.dev", "b", { expires_at: "2020-01-01T00:00:00Z" }) })
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })

  const refresh = output(cli(["refresh"], server.port!))
  await refreshing
  const load = output(cli(["load", "b"], server.port!))
  await Bun.sleep(1_000)
  expect((await live())[GROK_DEFAULT_SCOPE]!.email).toBe("a@acme.dev")
  release()
  await refresh
  expect(await load).toContain('grok → "b"')

  expect(spent).toEqual(["fake-refresh-b"])
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-b2")
  expect((await slotOf("b"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-b2")
})

test("a refresh that waited for a load never spends the grant the load put live", async () => {
  const spent: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/usage") return Response.json({ config: { creditUsagePercent: 10 } })
      spent.push(new URLSearchParams(await request.text()).get("refresh_token")!)
      return Response.json({ access_token: "fake-session-b2", refresh_token: "fake-refresh-b2", expires_in: 3600 })
    },
  })
  const b = { [GROK_DEFAULT_SCOPE]: session("b@acme.dev", "b", { expires_at: "2020-01-01T00:00:00Z" }) }
  await save("b", b)
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })

  let release!: () => void
  const loading = withSwitchLock("grok", () => new Promise<void>((resolve) => (release = resolve)))
  const refresh = output(cli(["refresh"], server.port!))
  await Bun.sleep(1_000)
  await seed(store(b))
  release()
  await loading
  expect(await refresh).not.toContain("renewal failed")
  expect(spent).toEqual([])
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-b")
})

test("a load of a slot sharing a grant being renewed gets the renewal, not the spent token", async () => {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let asked!: () => void
  const refreshing = new Promise<void>((resolve) => (asked = resolve))
  const spent: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/usage") return Response.json({ config: { creditUsagePercent: 10 } })
      spent.push(new URLSearchParams(await request.text()).get("refresh_token")!)
      asked()
      await released
      return Response.json({ access_token: "fake-session-shared2", refresh_token: "fake-refresh-shared2", expires_in: 3600 })
    },
  })
  const past = { expires_at: "2020-01-01T00:00:00Z" }
  await save("c", { [GROK_DEFAULT_SCOPE]: session("s@acme.dev", "shared", past) })
  await save("d", { [GROK_DEFAULT_SCOPE]: session("s@acme.dev", "shared", past), [GROK_API_KEY_SCOPE]: apiKey("fake-key-d") })
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })

  const refresh = output(cli(["refresh"], server.port!))
  await refreshing
  const load = output(cli(["load", "d"], server.port!))
  await Bun.sleep(1_000)
  release()
  await refresh
  expect(await load).toContain('grok → "d"')

  expect(spent).toEqual(["fake-refresh-shared"])
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-shared2")
  expect((await live())[GROK_API_KEY_SCOPE]!.key).toBe("fake-key-d")
  expect((await slotOf("c"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-shared2")
})

test("clear copies a token grok rotated since the last sync into its slot before signing out", async () => {
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a2"), [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") }))
  using server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
  expect(await output(cli(["clear"], server.port!))).toContain("grok signed out locally")
  expect((await slotOf("a"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a2")
  expect(Object.keys(await live())).toEqual([ENTERPRISE_SCOPE])
})

test("read commands leave the live login's copy to the next run while the slots are busy, and sync says so", async () => {
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a2") }))
  using server = Bun.serve({ port: 0, fetch: () => Response.json({ config: { creditUsagePercent: 10 } }) })
  let release!: () => void
  const holding = withSwitchLock("grok", () => new Promise<void>((resolve) => (release = resolve)))
  try {
    for (const args of [["list"], ["usage"]]) {
      const started = Date.now()
      expect(await output(cli(args, server.port!))).toContain("a@acme.dev")
      expect(Date.now() - started).toBeLessThan(15_000)
    }
    const state = await syncLiveSlot(grokProvider, 100)
    expect(state.busy).toBe(true)
    expect(state.synced).toBeNull()
    expect((await slotOf("a"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a")
  } finally {
    release()
    await holding
  }
  expect((await syncLiveSlot(grokProvider)).synced).toBe("a")
}, 30_000)

test("a load grok would refuse fails before the switch begins, so attribution stays with the live slot", async () => {
  await writeSnapshot("e", { ...snapshotOf(store({ [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") })), identity: { account: "e@acme.dev" } })
  await save("a", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a") })
  const before = await Bun.file(authPath()).text()
  using server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })

  const proc = cli(["load", "e"], server.port!)
  expect(await output(proc)).toContain("auth.json is unchanged")
  expect(await proc.exited).not.toBe(0)
  expect(await Bun.file(authPath()).text()).toBe(before)
  expect(await Bun.file(gapsPath()).exists()).toBe(false)
  expect((await readHistory("grok")).rows).toEqual([])
})

/** a fake xAI: the token endpoint honours `valid` refresh tokens once each and rotates them; usage answers only a renewed session */
function xai(valid: Set<string>, spent: string[]) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/usage") {
        const fresh = /-(2|grok)$/.test(request.headers.get("authorization") ?? "")
        return fresh ? Response.json({ config: { creditUsagePercent: 25 } }) : new Response(null, { status: 401 })
      }
      const token = new URLSearchParams(await request.text()).get("refresh_token")!
      spent.push(token)
      if (!valid.delete(token)) return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: `${token.replace("refresh", "session")}-2`, refresh_token: `${token}-2`, expires_in: 3600 })
    },
  })
}

const expired = { expires_at: "2020-01-01T00:00:00Z" }

test("refresh renews an idle grok's expired live login under its lock, live and in its slot, keeping every other scope", async () => {
  const spent: string[] = []
  using server = xai(new Set(["fake-refresh-a"]), spent)
  await save("adv", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired), [GROK_API_KEY_SCOPE]: apiKey("fake-key-a") })
  await save("b", { [GROK_DEFAULT_SCOPE]: session("b@acme.dev", "b") })
  await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired), [GROK_API_KEY_SCOPE]: apiKey("fake-key-a"), [ENTERPRISE_SCOPE]: session("e@acme.dev", "e") }))

  const printed = await output(cli(["refresh"], server.port!))

  expect(spent).toEqual(["fake-refresh-a"])
  const now = await live()
  expect(now[GROK_DEFAULT_SCOPE]).toMatchObject({ key: "fake-session-a-2", refresh_token: "fake-refresh-a-2", email: "a@acme.dev" })
  expect(Date.parse(now[GROK_DEFAULT_SCOPE]!.expires_at as string)).toBeGreaterThan(Date.now())
  expect(now[GROK_API_KEY_SCOPE]!.key).toBe("fake-key-a")
  expect(now[ENTERPRISE_SCOPE]!.refresh_token).toBe("fake-refresh-e")
  expect(Object.keys(now)).toEqual(Object.keys(now).sort())
  expect((await slotOf("adv"))[GROK_DEFAULT_SCOPE]).toMatchObject({ key: "fake-session-a-2", refresh_token: "fake-refresh-a-2" })
  expect((await slotOf("adv"))[GROK_API_KEY_SCOPE]!.key).toBe("fake-key-a")
  expect((await slotOf("b"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-b")
  expect(printed).toContain('grok "adv": renewed the live login')
  expect(printed).toContain("75% left")
  expect(printed).not.toContain("expired")
  expect(await Bun.file(grokLockPath()).exists()).toBe(true)

  expect(await output(cli(["refresh"], server.port!))).not.toContain("renewed")
  expect(spent).toEqual(["fake-refresh-a"])
})

test("while grok runs, refresh and usage leave its live login to it, and no hint says to load the slot already live; idle, only refresh renews it", async () => {
  const spent: string[] = []
  using server = xai(new Set(["fake-refresh-a"]), spent)
  await save("adv", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired) })

  const running = await output(cli(["refresh"], server.port!, true))
  expect(spent).toEqual([])
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a")
  expect(running).toContain("Grok Build is running and renews it itself")

  const idle = await output(cli(["usage", "--no-renew"], server.port!))
  expect(spent).toEqual([])
  expect(idle).toContain("Grok Build renews it when it next runs; `kyora-switch refresh` renews it now")
  for (const text of [running, idle]) expect(text).not.toContain("load this slot")

  expect(await output(cli(["usage"], server.port!, true))).toContain("Grok Build is running and renews it itself")
  expect(spent).toEqual([])
  expect(await output(cli(["usage"], server.port!))).toContain("Grok Build renews it when it next runs; `kyora-switch refresh` renews it now")
  expect(spent).toEqual([])
  const renewed = await output(cli(["refresh"], server.port!))
  expect(spent).toEqual(["fake-refresh-a"])
  expect(renewed).toContain('grok "adv": renewed the live login')
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a-2")
})

test("a grok holding auth.json.lock makes refresh wait, and a renewal grok made meanwhile is kept, not spent again", async () => {
  const spent: string[] = []
  using server = xai(new Set(["fake-refresh-a"]), spent)
  await save("adv", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired) })
  const held = openSync(grokLockPath(), constants.O_RDWR | constants.O_CREAT, 0o600)
  expect(flock(held, 2 | 4)).toBe(0)
  let refresh: Promise<string>
  try {
    refresh = output(cli(["refresh"], server.port!))
    await Bun.sleep(1_500)
    await seed(store({ [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a-grok") }))
  } finally {
    flock(held, 8)
    closeSync(held)
  }
  const printed = await refresh!

  expect(spent).toEqual([])
  expect((await live())[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a-grok")
  expect((await slotOf("adv"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a-grok")
  expect(printed).not.toContain("renewed")
  expect(printed).toContain("75% left")
})

test("a renewal that fails says why, live or not, never with a token", async () => {
  const spent: string[] = []
  using server = xai(new Set(), spent)
  await save("old", { [GROK_DEFAULT_SCOPE]: session("o@acme.dev", "old", expired) })
  await save("adv", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired) })

  const printed = await output(cli(["refresh"], server.port!))
  expect(spent.sort()).toEqual(["fake-refresh-a", "fake-refresh-old"])
  expect(printed).toContain('grok "old": login not renewed: the stored refresh token was already used or revoked: log in again and save')
  expect(printed).toContain('grok "adv": live login not renewed: the stored refresh token was already used or revoked: log in again and save')
  expect(printed.match(/access token expired .+ ago; not renewed: the stored refresh token was already used or revoked/g)).toHaveLength(2)
  expect(printed).not.toContain("fake-refresh")
  expect(printed).not.toContain("load this slot")
})

test.skipIf(process.getuid?.() === 0)("a renewal that cannot be written live fails loudly and keeps the rotated token in the slot", async () => {
  const spent: string[] = []
  using server = xai(new Set(["fake-refresh-a"]), spent)
  await save("adv", { [GROK_DEFAULT_SCOPE]: session("a@acme.dev", "a", expired) })
  await writeFile(grokLockPath(), "")
  await chmod(join(dir, "grok"), 0o500)
  try {
    const proc = cli(["refresh"], server.port!)
    const printed = await output(proc)
    expect(await proc.exited).not.toBe(0)
    expect(printed).toContain("could not write it live")
    expect(printed).toMatch(/The renewal is in \S+: put its credentials back live, or run `grok login`/)
    expect(printed).not.toContain("fake-refresh")
  } finally {
    await chmod(join(dir, "grok"), 0o700)
  }
  expect(spent).toEqual(["fake-refresh-a"])
  expect((await slotOf("adv"))[GROK_DEFAULT_SCOPE]!.refresh_token).toBe("fake-refresh-a-2")
})
