import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { museIdentity } from "../identity"
import { keychainSupported } from "../keychain"
import { readSlot, readSnapshot, renameSlot, slotDir, writeBackup, writeSnapshot } from "../store"
import { syncLiveSlot } from "../sync"
import { describeIdentity } from "../types"
import { readWebSession, webSessionPath, writeWebSession } from "../web-session"
import { applyMuseBackendChange, museApiKeyNote, museRefusedNote, museWebExpiredNote, readMuseTeam, writeMuseTeam, META_API_KEY_NOTE, MUSE_BACKEND_DISAGREE_NOTE, MUSE_KEYCHAIN_UNREADABLE_NOTE, metaApiKeyPresent, mergeMeta, museBackendsDisagree, museAuthPath, museConfigDir, museProvider, preferredIdentity, preferredMeta, museBackupsDir, readStableMusePair, withoutMeta, type MuseBackendOps } from "./muse"

let dir: string
const previous = {
  xdg: process.env.XDG_CONFIG_HOME,
  key: process.env.META_API_KEY,
  slots: process.env.KYORA_SWITCH_DIR,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-muse-"))
  process.env.XDG_CONFIG_HOME = dir
  process.env.KYORA_SWITCH_DIR = join(dir, "slots")
  delete process.env.META_API_KEY
})

afterEach(async () => {
  if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previous.xdg
  if (previous.key === undefined) delete process.env.META_API_KEY
  else process.env.META_API_KEY = previous.key
  if (previous.slots === undefined) delete process.env.KYORA_SWITCH_DIR
  else process.env.KYORA_SWITCH_DIR = previous.slots
  await rm(dir, { recursive: true, force: true })
})

const authPath = () => join(dir, "muse", "auth.json")

function login(email: string, token: string): string {
  return JSON.stringify({
    providers: {
      meta: {
        mechanism: "oauth",
        access_token: token,
        refresh_token: `refresh-${token}`,
        expires_at: 1789000000,
        user_email: email,
        user_full_name: "Fixture User",
        subs_tier_name: "pro",
        is_subs_active: true,
      },
    },
  })
}

async function seed(email: string, token: string): Promise<void> {
  await Bun.write(authPath(), login(email, token))
  await Bun.write(join(dir, "muse", "settings.json"), '{"model":"muse-wonder-1.0"}')
}

test("locations follow XDG_CONFIG_HOME, the way muse resolves its config dir", () => {
  expect(museConfigDir()).toBe(join(dir, "muse"))
  expect(museAuthPath()).toBe(authPath())
  expect(museProvider.locations()).toEqual([authPath()])
})

test("process name matches the launcher and the versioned binary", () => {
  const pattern = new RegExp("^(?:" + museProvider.processName + ")$")
  for (const name of ["muse", "muse-bin-1.4.8-R6256.1", "muse-bin-1.4.8-"]) expect(pattern.test(name)).toBe(true)
  for (const name of ["musescore", "muse-bin-", "bash"]) expect(pattern.test(name)).toBe(false)
})

function sliceText(email: string, token: string): string {
  const meta = (JSON.parse(login(email, token)) as { providers: { meta: unknown } }).providers.meta
  return `${JSON.stringify({ providers: { meta } }, null, 2)}\n`
}

test("the keychain is unreachable from tests, whatever directory they run in", () => {
  expect(keychainSupported()).toBe(false)
})

test("capture returns null when there is no auth.json, or no login in it", async () => {
  expect(await museProvider.capture()).toBeNull()
  await Bun.write(authPath(), JSON.stringify({ providers: {} }))
  expect(await museProvider.capture()).toBeNull()
})

test("capture reads the identity, restore writes the file back at 0600", async () => {
  await seed("work@acme.dev", "work-token")
  const work = (await museProvider.capture())!
  expect(work.identity).toEqual({ account: "work@acme.dev", plan: "pro" })
  expect(work.files["auth.json"]).toBe(sliceText("work@acme.dev", "work-token"))

  await seed("home@me.dev", "home-token")
  await museProvider.restore(work)

  expect(await Bun.file(authPath()).text()).toBe(sliceText("work@acme.dev", "work-token"))
  expect((await stat(authPath())).mode & 0o777).toBe(0o600)
})

test("capture stores only the meta entry, byte stable", async () => {
  const meta = (JSON.parse(login("work@acme.dev", "work-token")) as { providers: { meta: unknown } }).providers.meta
  await Bun.write(authPath(), JSON.stringify({ credential_backend: "file", providers: { other: { api_key: "other-fake-key" }, meta }, extra: 1 }))
  const saved = (await museProvider.capture())!
  expect(saved.files["auth.json"]).toBe(sliceText("work@acme.dev", "work-token"))
  expect(saved.files["auth.json"]).not.toContain("other-fake-key")
  expect(saved.files["auth.json"]).not.toContain("credential_backend")

  await Bun.write(authPath(), `{ "extra": 2, "providers": { "other": {"api_key":"other-fake-key"}, "meta": ${JSON.stringify(meta)} } }`)
  expect((await museProvider.capture())!.files["auth.json"]).toBe(saved.files["auth.json"])
})

test("restore merges only the meta entry and keeps every other key and provider", async () => {
  await seed("work@acme.dev", "work-token")
  const work = (await museProvider.capture())!
  const meta = (JSON.parse(login("home@me.dev", "home-token")) as { providers: { meta: unknown } }).providers.meta
  await Bun.write(authPath(), JSON.stringify({ credential_backend: "file", providers: { other: { api_key: "other-fake-key" }, meta }, extra: 1 }))

  await museProvider.restore(work)

  const live = JSON.parse(await Bun.file(authPath()).text()) as { credential_backend: string; extra: number; providers: { meta: { user_email: string }; other: unknown } }
  expect(live.credential_backend).toBe("file")
  expect(live.extra).toBe(1)
  expect(live.providers.other).toEqual({ api_key: "other-fake-key" })
  expect(live.providers.meta.user_email).toBe("work@acme.dev")
  expect(mergeMeta({ a: 1, providers: { other: 2 } }, { user_email: "w@acme.dev" })).toEqual({ a: 1, providers: { other: 2, meta: { user_email: "w@acme.dev" } } })
})

test("forget and the no-file-credential path remove only the meta entry", async () => {
  const meta = (JSON.parse(login("work@acme.dev", "work-token")) as { providers: { meta: unknown } }).providers.meta
  await Bun.write(authPath(), JSON.stringify({ credential_backend: "file", providers: { other: { api_key: "other-fake-key" }, meta } }))
  await museProvider.forget()
  expect(JSON.parse(await Bun.file(authPath()).text())).toEqual({ credential_backend: "file", providers: { other: { api_key: "other-fake-key" } } })
  expect(await museProvider.capture()).toBeNull()
  expect(withoutMeta({ a: 1, providers: { other: 2, meta: { user_email: "w@acme.dev" } } })).toEqual({ a: 1, providers: { other: 2 } })
  expect(withoutMeta({ providers: { meta: { user_email: "w@acme.dev" } } })).toEqual({})
})

test("an auth.json whose providers entry is not an object is refused, never replaced", () => {
  for (const providers of ["oops", [1], 3]) {
    expect(() => mergeMeta({ providers }, { user_email: "w@acme.dev" })).toThrow('auth.json has a "providers" entry that is not an object')
    expect(() => withoutMeta({ providers })).toThrow('auth.json has a "providers" entry that is not an object')
  }
  expect(mergeMeta({ a: 1 }, { user_email: "w@acme.dev" })).toEqual({ a: 1, providers: { meta: { user_email: "w@acme.dev" } } })
})

test("capture reports a corrupt auth.json instead of silently skipping it", async () => {
  await Bun.write(authPath(), "{not json")
  await expect(museProvider.capture()).rejects.toThrow(/not valid JSON/)
})

test("restore refuses a slot with no credentials", async () => {
  await expect(museProvider.restore({ provider: "muse", identity: {}, files: {}, capturedAt: 0 })).rejects.toThrow(
    /no Muse credentials/,
  )
})

test("restore leaves settings.json and trust.json alone", async () => {
  await seed("work@acme.dev", "work-token")
  const work = (await museProvider.capture())!
  await Bun.write(join(dir, "muse", "trust.json"), '{"trusted":true}')

  await museProvider.restore(work)

  expect(await Bun.file(join(dir, "muse", "settings.json")).text()).toBe('{"model":"muse-wonder-1.0"}')
  expect(await Bun.file(join(dir, "muse", "trust.json")).text()).toBe('{"trusted":true}')
  expect(Object.keys(work.files)).toEqual(["auth.json"])
})

test("forget removes auth.json, keeps settings, and is a no-op when signed out", async () => {
  await seed("work@acme.dev", "work-token")
  await museProvider.forget()
  expect(await Bun.file(authPath()).exists()).toBe(false)
  expect(await museProvider.capture()).toBeNull()
  expect(await Bun.file(join(dir, "muse", "settings.json")).text()).toBe('{"model":"muse-wonder-1.0"}')

  await museProvider.forget()
  expect(await Bun.file(authPath()).exists()).toBe(false)
})

test("a slot saved before forget still restores afterwards", async () => {
  await seed("work@acme.dev", "work-token")
  const saved = (await museProvider.capture())!

  await museProvider.forget()
  await museProvider.restore(saved)

  expect(await Bun.file(authPath()).text()).toBe(sliceText("work@acme.dev", "work-token"))
})

test("a keychain-only slot fails loudly where there is no keychain", async () => {
  await seed("home@me.dev", "home-token")
  const before = await Bun.file(authPath()).text()
  await expect(
    museProvider.restore({ provider: "muse", identity: {}, files: { "keychain.json": "opaque-fake-blob" }, capturedAt: 0 }),
  ).rejects.toThrow(/only a macOS keychain login/)
  expect(await Bun.file(authPath()).text()).toBe(before)
})

test("keychain first: identity, grant and expiry prefer the keychain blob", () => {
  const files = {
    "auth.json": sliceText("file@acme.dev", "file-token"),
    "keychain.json": JSON.stringify({
      providers: {
        meta: {
          mechanism: "oauth",
          access_token: "keychain-token",
          refresh_token: "keychain-refresh",
          expires_at: 1790000000,
          user_email: "keychain@acme.dev",
          subs_tier_name: "max",
        },
      },
    }),
  }
  expect(preferredMeta(files)?.user_email).toBe("keychain@acme.dev")
  expect(preferredIdentity(files)).toEqual({ account: "keychain@acme.dev", plan: "max" })
  const snapshot = { provider: "muse" as const, identity: {}, files, capturedAt: 0 }
  expect(museProvider.grant!(snapshot)).toBe("keychain-refresh")
  expect(museProvider.credentialExpiry!(snapshot)).toBe(1790000000000)

  const opaque = { ...files, "keychain.json": "opaque-fake-blob" }
  expect(preferredMeta(opaque)).toBeNull()
  expect(preferredIdentity(opaque)).toEqual({ account: undefined, plan: undefined })
  expect(museProvider.grant!({ ...snapshot, files: opaque })).toBe("opaque-fake-blob")
  expect(museProvider.credentialExpiry!({ ...snapshot, files: opaque })).toBeUndefined()
  expect(preferredMeta({ "auth.json": files["auth.json"] })?.user_email).toBe("file@acme.dev")
  const bare = { "keychain.json": JSON.stringify({ mechanism: "oauth", access_token: "bare-token", user_email: "bare@acme.dev" }) }
  expect(preferredMeta(bare)?.user_email).toBe("bare@acme.dev")
})

test("credentialExpiry reads expires_at in seconds or milliseconds", async () => {
  await seed("work@acme.dev", "work-token")
  expect(museProvider.credentialExpiry!((await museProvider.capture())!)).toBe(1789000000000)

  const blob = JSON.parse(login("work@acme.dev", "work-token")) as { providers: { meta: Record<string, unknown> } }
  blob.providers.meta.expires_at = 1789000000000
  await Bun.write(authPath(), JSON.stringify(blob))
  expect(museProvider.credentialExpiry!((await museProvider.capture())!)).toBe(1789000000000)

  delete blob.providers.meta.expires_at
  await Bun.write(authPath(), JSON.stringify(blob))
  expect(museProvider.credentialExpiry!((await museProvider.capture())!)).toBeUndefined()
})

test("grant prefers the refresh token, then the access token, then a stored key", async () => {
  await seed("work@acme.dev", "work-token")
  expect(museProvider.grant!((await museProvider.capture())!)).toBe("refresh-work-token")

  const blob = JSON.parse(login("work@acme.dev", "work-token")) as { providers: { meta: Record<string, unknown> } }
  delete blob.providers.meta.refresh_token
  await Bun.write(authPath(), JSON.stringify(blob))
  expect(museProvider.grant!((await museProvider.capture())!)).toBe("work-token")

  await Bun.write(authPath(), JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "stored-key" } } }))
  const keyed = (await museProvider.capture())!
  expect(museProvider.grant!(keyed)).toBe("stored-key")
  expect(keyed.identity).toEqual({ account: undefined, plan: "api key" })
  expect(JSON.stringify(keyed.identity)).not.toContain("stored-key")
})

test("museIdentity names the account by email only, shows a full name without one, and never leaks a secret", () => {
  expect(museIdentity(JSON.parse(login("work@acme.dev", "work-token")))).toEqual({ account: "work@acme.dev", plan: "pro" })
  const named = museIdentity({ providers: { meta: { user_full_name: "Fixture User", subs_active: true } } })
  expect(named).toEqual({ account: undefined, name: "Fixture User", plan: "subscription" })
  expect(describeIdentity(named)).toBe("Fixture User · subscription")
  expect(museIdentity(null)).toEqual({ account: undefined, plan: undefined })
  expect(museIdentity({ providers: { meta: { access_token: "secret-token" } } })).toEqual({
    account: undefined,
    plan: undefined,
  })
})

test("an oauth login with a minted api key is not labelled api key", () => {
  expect(museIdentity({ providers: { meta: { mechanism: "oauth", api_key: "minted-fake-key", user_email: "work@acme.dev" } } })).toEqual({
    account: "work@acme.dev",
    plan: undefined,
  })
  expect(museIdentity({ providers: { meta: { mechanism: "oauth", api_key: "minted-fake-key", subs_tier_name: "pro" } } }).plan).toBe("pro")
  expect(museIdentity({ providers: { meta: { api_key: "stored-fake-key" } } }).plan).toBe("api key")
  expect(museIdentity({ providers: { meta: { mechanism: "api_key", api_key: "stored-fake-key" } } }).plan).toBe("api key")
})

test("META_API_KEY is reported as an override, and its value never reaches a slot", async () => {
  expect(metaApiKeyPresent()).toBe(false)
  expect(museProvider.notes!(null)).toEqual([])

  process.env.META_API_KEY = "env-secret-key"
  expect(metaApiKeyPresent()).toBe(true)
  expect(museProvider.notes!(null)).toEqual([META_API_KEY_NOTE])
  expect(museProvider.locations()).toContain(META_API_KEY_NOTE)

  await seed("work@acme.dev", "work-token")
  const saved = (await museProvider.capture())!
  expect(JSON.stringify(saved.files)).not.toContain("env-secret-key")
  expect(saved.identity).toEqual({ account: "work@acme.dev", plan: "pro" })
})

test("an unchanged login syncs as already current through the store", async () => {
  await seed("work@acme.dev", "work-token")
  await writeSnapshot("work", (await museProvider.capture())!)
  const meta = (JSON.parse(login("work@acme.dev", "work-token")) as { providers: { meta: unknown } }).providers.meta
  await Bun.write(authPath(), `{ "extra": 9, "providers": { "other": {"api_key":"other-fake-key"}, "meta": ${JSON.stringify(meta)} } }`)

  expect((await syncLiveSlot(museProvider)).synced).toBeNull()
  expect((await syncLiveSlot(museProvider)).live?.name).toBe("work")
  expect(await readSnapshot("muse", "work")).not.toBeNull()
})

const OUTGOING = "the login you switched away from is backed up in /fake/backups/muse"

function fakeBackends(failWrite: "once" | "always" | null = null, failDelete = false) {
  const state = { file: "file-a" as string | null, blob: "blob-a" as string | null, writes: 0, deletes: 0, fileWrites: 0 }
  const ops: MuseBackendOps = {
    keychainSupported: true,
    readAuthText: async () => state.file,
    writeAuthText: async (text) => { state.fileWrites++; state.file = text },
    deleteAuthFile: async () => { state.fileWrites++; state.file = null },
    readKeychainBlob: async () => state.blob,
    writeKeychainBlob: async (blob) => {
      state.writes++
      if (failWrite === "always" || (failWrite === "once" && state.writes === 1)) throw new Error("keychain write failed")
      state.blob = blob
    },
    deleteKeychainItem: async () => {
      state.deletes++
      if (failDelete && state.deletes === 1) throw new Error("keychain delete failed")
      state.blob = null
    },
  }
  return { state, ops }
}

test("a failing keychain write during load rolls the auth file back", async () => {
  const { state, ops } = fakeBackends("once")
  await expect(applyMuseBackendChange(ops, OUTGOING, async (backends) => {
    await backends.writeAuthText("file-b")
    await backends.writeKeychainBlob("blob-b")
  })).rejects.toThrow("keychain write failed")
  expect(state.file).toBe("file-a")
  expect(state.blob).toBe("blob-a")
})

test("a failing keychain delete during clear rolls both backends back", async () => {
  const { state, ops } = fakeBackends(null, true)
  await expect(applyMuseBackendChange(ops, OUTGOING, async (backends) => {
    await backends.deleteAuthFile()
    await backends.deleteKeychainItem()
  })).rejects.toThrow("keychain delete failed")
  expect(state.file).toBe("file-a")
  expect(state.blob).toBe("blob-a")
})

test("when rollback itself fails the error says the login may be split, without any secret", async () => {
  const { ops } = fakeBackends("always")
  const error = await applyMuseBackendChange(ops, OUTGOING, async (backends) => {
    await backends.writeAuthText("file-b")
    await backends.writeKeychainBlob("blob-b-secret")
  }).catch((caught: Error) => caught)
  expect((error as Error).message).toContain("may be split between auth.json and the keychain")
  expect((error as Error).message).toContain(OUTGOING)
  expect((error as Error).message).not.toContain("blob-b-secret")
  expect((error as Error).message).not.toContain("blob-a")
})

test("rollback puts back only the backends the change touched", async () => {
  const untouched = fakeBackends()
  await expect(applyMuseBackendChange(untouched.ops, OUTGOING, async () => {
    throw new Error("auth.json is not valid JSON")
  })).rejects.toThrow("auth.json is not valid JSON")
  expect(untouched.state).toEqual({ file: "file-a", blob: "blob-a", writes: 0, deletes: 0, fileWrites: 0 })

  const keychainOnly = fakeBackends("once")
  await expect(applyMuseBackendChange(keychainOnly.ops, OUTGOING, async (backends) => {
    await backends.writeKeychainBlob("blob-b")
  })).rejects.toThrow("keychain write failed")
  expect(keychainOnly.state.fileWrites).toBe(0)
  expect(keychainOnly.state.blob).toBe("blob-a")
})

test("the split-login error points at the directory load and clear back the outgoing login up to", async () => {
  const backup = await writeBackup({ provider: "muse", identity: {}, files: { "auth.json": sliceText("a@acme.dev", "fake-token") }, capturedAt: 0 })
  expect(backup.startsWith(`${museBackupsDir()}/`)).toBe(true)
})

test("backends disagree only when both parse and hold different grants", () => {
  const blob = (token: string) => JSON.stringify({ providers: { meta: { access_token: token, refresh_token: `refresh-${token}`, user_email: "a@acme.dev" } } })
  const same = { "auth.json": sliceText("a@acme.dev", "same-token"), "keychain.json": blob("same-token") }
  expect(museBackendsDisagree(same)).toBe(false)
  const different = { "auth.json": sliceText("a@acme.dev", "file-token"), "keychain.json": blob("keychain-token") }
  expect(museBackendsDisagree(different)).toBe(true)
  expect(museBackendsDisagree({ "auth.json": same["auth.json"] })).toBe(false)
  expect(museBackendsDisagree({ "keychain.json": blob("same-token") })).toBe(false)
  expect(museBackendsDisagree({ "auth.json": same["auth.json"], "keychain.json": "opaque-fake-blob" })).toBe(false)
  const snapshot = { provider: "muse" as const, identity: {}, files: different, capturedAt: 0 }
  expect(museProvider.notes!(snapshot)).toEqual([MUSE_BACKEND_DISAGREE_NOTE])
  expect(MUSE_BACKEND_DISAGREE_NOTE).not.toContain("a@acme.dev")
  expect(MUSE_BACKEND_DISAGREE_NOTE).not.toContain("file-token")
  const unreadable = { ...snapshot, files: { "auth.json": same["auth.json"], "keychain.json": "opaque-fake-blob" } }
  expect(museProvider.notes!(unreadable)).toEqual([MUSE_KEYCHAIN_UNREADABLE_NOTE])
  expect(museProvider.notes!({ ...snapshot, files: { "keychain.json": "opaque-fake-blob" } })).toEqual([])
  expect(museProvider.notes!({ ...snapshot, files: same })).toEqual([])
})

test("capture pair is stable on the first try", async () => {
  let files = 0
  const pair = await readStableMusePair(async () => { files++; return "file-a" }, async () => "blob-a", true)
  expect(pair).toEqual({ text: "file-a", blob: "blob-a" })
  expect(files).toBe(2)
})

test("capture pair retries when the file changes once, then reads the stable pair", async () => {
  const values = ["file-a", "file-b", "file-b", "file-b"]
  let index = 0
  const pair = await readStableMusePair(async () => values[index++]!, async () => "blob-b", true)
  expect(pair).toEqual({ text: "file-b", blob: "blob-b" })
  expect(index).toBe(4)
})

test("capture pair retries when the keychain blob changes during the read", async () => {
  const blobs = ["blob-a", "blob-b", "blob-b", "blob-b"]
  let index = 0
  const pair = await readStableMusePair(async () => "file-a", async () => blobs[index++]!, true)
  expect(pair).toEqual({ text: "file-a", blob: "blob-b" })
  expect(index).toBe(4)
})

test("capture pair throws after three attempts when the file keeps changing", async () => {
  let value = 0
  await expect(readStableMusePair(async () => `file-${value++}`, async () => "blob-a", true)).rejects.toThrow(
    "Muse's login changed while it was being read; try again",
  )
  expect(value).toBe(6)
})

test("capture pair without keychain support reads the file once", async () => {
  let files = 0
  const pair = await readStableMusePair(async () => { files++; return "file-a" }, async () => { throw new Error("must not be called") }, false)
  expect(pair).toEqual({ text: "file-a", blob: null })
  expect(files).toBe(1)
})

test("save, switch and load back round-trips both accounts through the store", async () => {
  await seed("work@acme.dev", "work-token")
  await writeSnapshot("work", (await museProvider.capture())!)
  await seed("home@me.dev", "home-token")
  await writeSnapshot("private", (await museProvider.capture())!)

  await museProvider.restore((await readSnapshot("muse", "work"))!)
  expect(JSON.parse(await Bun.file(authPath()).text()).providers.meta.user_email).toBe("work@acme.dev")

  await museProvider.restore((await readSnapshot("muse", "private"))!)
  expect(JSON.parse(await Bun.file(authPath()).text()).providers.meta.user_email).toBe("home@me.dev")
})

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function portal(teams: string[], status = 200, accepts: (request: Request) => boolean = () => status === 200) {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      seen.push(`${pathname} ${request.headers.get("authorization") ?? `cookie ${request.headers.get("cookie")}`}`)
      if (!accepts(request)) return Response.json({ error: "session required" }, { status: status === 200 ? 401 : status })
      if (pathname === "/api/auth/me") return Response.json({ user_id: "fixture" })
      if (pathname === "/api/portal/teams") return Response.json({ teams: teams.map((team_id) => ({ team_id, team_name: "fixture" })) })
      const quota = /^\/api\/portal\/teams\/([^/]+)\/subscription-quota$/.exec(pathname)
      if (quota && teams.includes(quota[1]!)) {
        return Response.json({ subscription_quota: { tier: "Everyday Usage", window_weighted_limit: "100", window_weighted_used: quota[1] === "2" ? "80" : "10", window_duration_secs: 18_000, window_resets_at: FAR_FUTURE, weekly_weighted_limit: "100", weekly_weighted_used: "30", weekly_resets_at: FAR_FUTURE } })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  const previous = process.env.KYORA_MUSE_USAGE_URL
  process.env.KYORA_MUSE_USAGE_URL = server.url.href
  return {
    seen,
    [Symbol.dispose]() {
      server.stop(true)
      if (previous === undefined) delete process.env.KYORA_MUSE_USAGE_URL
      else process.env.KYORA_MUSE_USAGE_URL = previous
    },
  }
}

async function saveWork(token = "fake-muse-access", expiresAt = FAR_FUTURE): Promise<void> {
  const auth = JSON.parse(login("alice@work.example", token))
  auth.providers.meta.expires_at = expiresAt
  await Bun.write(authPath(), JSON.stringify(auth))
  await writeSnapshot("work", (await museProvider.capture())!)
}

test("usage derives the login's only team and reads its windows with the stored access token", async () => {
  using server = portal(["1"])
  await saveWork()
  const snapshot = (await readSnapshot("muse", "work"))!
  expect(await museProvider.quotaWithReason!(snapshot, "work")).toMatchObject({ remainingPct: 70, plan: "Everyday Usage", windows: [{ label: "5h", usedPct: 10 }, { label: "weekly", usedPct: 30 }] })
  expect(server.seen).toEqual(["/api/portal/teams Bearer fake-muse-access", "/api/portal/teams/1/subscription-quota Bearer fake-muse-access"])
})

test("a slot's team setting picks one of several teams without listing them", async () => {
  using server = portal(["1", "2"])
  await saveWork()
  const snapshot = (await readSnapshot("muse", "work"))!
  expect(await museProvider.quotaWithReason!(snapshot, "work")).toEqual({ unavailable: "this login has 2 teams; set the team id with `kyora-switch muse team work <teamId>`" })
  expect(await museProvider.quotaWithReason!(snapshot)).toEqual({ unavailable: "this login has 2 teams; save this login to a slot, then set its team id with `kyora-switch muse team <slot> <teamId>`" })

  await writeMuseTeam("work", "2")
  server.seen.length = 0
  expect(await museProvider.quotaWithReason!(snapshot, "work")).toMatchObject({ remainingPct: 20 })
  expect(server.seen).toEqual(["/api/portal/teams/2/subscription-quota Bearer fake-muse-access"])

  await writeMuseTeam("work", "9")
  expect(await museProvider.quotaWithReason!(snapshot, "work")).toEqual({
    unavailable: "dev.meta.ai returned no usage for team 9; fix it with `kyora-switch muse team work <teamId>` or clear it with `kyora-switch muse team work unset`",
  })
})

test("the team setting survives the live login's sync into its slot", async () => {
  await saveWork()
  await writeMuseTeam("work", "2")
  const auth = JSON.parse(await Bun.file(authPath()).text())
  auth.providers.meta.access_token = "fake-muse-access-rotated"
  await Bun.write(authPath(), JSON.stringify(auth))
  expect((await syncLiveSlot(museProvider)).synced).toBe("work")
  expect((await readSnapshot("muse", "work"))?.files["auth.json"]).toContain("fake-muse-access-rotated")
  expect(await readMuseTeam("work")).toBe("2")
})

test("a login the portal refuses, with no web session, says to run web-login", async () => {
  for (const status of [401, 403]) {
    using _server = portal(["1"], status)
    await saveWork()
    expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toEqual({ unavailable: "dev.meta.ai does not take the CLI login for usage; run `kyora-switch muse web-login work`" })
    await writeMuseTeam("work", "1")
    expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toEqual({ unavailable: museRefusedNote("work") })
    expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!)).toEqual({ unavailable: "dev.meta.ai does not take the CLI login for usage; save this login to a slot, then run `kyora-switch muse web-login <slot>`" })
    await writeMuseTeam("work", null)
  }
})

test("an expired access token or a login without one is never sent", async () => {
  using server = portal(["1"])
  await saveWork("fake-muse-access", Math.floor(Date.now() / 1000) - 60)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toEqual({ unavailable: "stored access token expired; load this slot and start muse, which renews it" })
  await Bun.write(authPath(), JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "fake-key", user_email: "k@example.com" } } }))
  expect(await museProvider.quotaWithReason!((await museProvider.capture())!)).toEqual({ unavailable: museApiKeyNote(undefined) })
  await writeSnapshot("key", (await museProvider.capture())!)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "key"))!, "key")).toEqual({
    unavailable: "this slot is an API key, which dev.meta.ai shows no usage for; run `kyora-switch muse web-login key`",
  })
  await Bun.write(authPath(), JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "fake-key", access_token: "fake-key" } } }))
  expect(await museProvider.quotaWithReason!((await museProvider.capture())!)).toEqual({ unavailable: museApiKeyNote(undefined) })
  await Bun.write(authPath(), JSON.stringify({ providers: { meta: { mechanism: "oauth", user_email: "k@example.com" } } }))
  expect(await museProvider.quotaWithReason!((await museProvider.capture())!)).toBeNull()
  expect(server.seen).toEqual([])
})

test("the team setting lives in slot.json, survives a re-save and a rename, and never reaches auth.json", async () => {
  await saveWork()
  expect(await readMuseTeam("work")).toBeUndefined()
  await writeMuseTeam("work", "1234567890123456")
  await writeSnapshot("work", (await museProvider.capture())!)
  expect(await readMuseTeam("work")).toBe("1234567890123456")
  expect((await readSlot("muse", "work"))?.identity.account).toBe("alice@work.example")
  await renameSlot("muse", "work", "job")
  expect(await readMuseTeam("job")).toBe("1234567890123456")
  expect(await Bun.file(join(slotDir("muse", "job"), "auth.json")).text()).not.toContain("1234567890123456")
  expect(await Bun.file(authPath()).text()).not.toContain("1234567890123456")
  await writeMuseTeam("job", null)
  expect(await readMuseTeam("job")).toBeUndefined()
  await expect(writeMuseTeam("job", "../x")).rejects.toThrow("a team id is")
  await expect(writeMuseTeam("missing", "1")).rejects.toThrow('no muse slot "missing"')
})

const cli = (...args: string[]) => cliWith({}, ...args)

async function cliWith(extra: Record<string, string>, ...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), ...args], {
    env: {
      ...extra,
      PATH: process.env.PATH ?? "",
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
      CODEX_HOME: join(dir, "codex"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      GROK_HOME: join(dir, "grok"),
      KYORA_SWITCH_DIR: process.env.KYORA_SWITCH_DIR!,
      KYORA_REVIEW_STATE_DIR: join(dir, "state", "kyora-review"),
      KYORA_SWITCH_NO_KEYCHAIN: "1",
      NODE_ENV: "test",
      KYORA_MUSE_USAGE_URL: process.env.KYORA_MUSE_USAGE_URL ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: `${out}${err}` }
}

test("`muse team` sets, shows and unsets a slot's team, and usage prints the plan, the windows or why there are none", async () => {
  using _server = portal(["1", "2"])
  await saveWork()

  expect((await cli("muse", "usage")).out).toContain("this login has 2 teams; set the team id with `kyora-switch muse team work <teamId>`")
  expect(await cli("muse", "team", "work", "2")).toEqual({ code: 0, out: 'muse "work" reads usage for team 2\n' })
  expect((await cli("muse", "team", "work")).out).toBe('muse "work" reads usage for team 2\n')
  expect((await cli("muse", "usage")).out).toMatch(/20% left +Everyday Usage · 5h 80% used, resets in .* · weekly 30% used/)
  expect(JSON.parse((await cli("muse", "usage", "--json")).out).muse[0]).toMatchObject({ slot: "work", quota: { remainingPct: 20, plan: "Everyday Usage" } })

  expect(await cli("muse", "team", "work", "unset")).toEqual({ code: 0, out: 'muse "work" team unset\n' })
  expect(JSON.parse((await cli("muse", "usage", "--json")).out).muse[0]).toMatchObject({ quota: null, unavailable: expect.stringContaining("2 teams") })
  expect(await cli("muse", "team", "missing", "1")).toMatchObject({ code: 2, out: expect.stringContaining('no muse slot "missing"') })
  expect(await cli("claude", "team", "work", "1")).toMatchObject({ code: 2, out: expect.stringContaining("team is a muse command") })
})

const WEB_SESSION = {
  cookies: [
    { name: "llama_dev_sess", value: "fake-web-session", domain: "dev.meta.ai", path: "/", expires: FAR_FUTURE, secure: true },
    { name: "datr", value: "fake-datr", domain: ".meta.ai", path: "/", secure: true },
  ],
  userAgent: "FakeChrome/1.0",
  savedAt: 1,
}
const webAccepted = (request: Request) => (request.headers.get("cookie") ?? "").includes("llama_dev_sess=fake-web-session")

test("a slot's web session reads usage where the CLI login is refused or is an API key", async () => {
  using server = portal(["1"], 200, webAccepted)
  await saveWork()
  await writeWebSession("muse", "work", WEB_SESSION)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toMatchObject({ remainingPct: 70, plan: "Everyday Usage" })
  expect(server.seen).toEqual([
    "/api/portal/teams Bearer fake-muse-access",
    "/api/portal/teams cookie llama_dev_sess=fake-web-session; datr=fake-datr",
    "/api/portal/teams/1/subscription-quota cookie llama_dev_sess=fake-web-session; datr=fake-datr",
  ])

  server.seen.length = 0
  await Bun.write(authPath(), JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "fake-key", access_token: "fake-key" } } }))
  await writeSnapshot("key", (await museProvider.capture())!)
  await writeWebSession("muse", "key", WEB_SESSION)
  await writeMuseTeam("key", "1")
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "key"))!, "key")).toMatchObject({ remainingPct: 70 })
  expect(server.seen).toEqual(["/api/portal/teams/1/subscription-quota cookie llama_dev_sess=fake-web-session; datr=fake-datr"])
})

test("with a team set, a quota call that refuses the bearer falls back to the web session", async () => {
  using server = portal(["1"], 200, webAccepted)
  await saveWork()
  await writeMuseTeam("work", "1")
  await writeWebSession("muse", "work", WEB_SESSION)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toMatchObject({ remainingPct: 70 })
  expect(server.seen).toEqual([
    "/api/portal/teams/1/subscription-quota Bearer fake-muse-access",
    "/api/portal/teams/1/subscription-quota cookie llama_dev_sess=fake-web-session; datr=fake-datr",
  ])
})

test("an account login the portal takes is used before the web session", async () => {
  using server = portal(["1"])
  await saveWork()
  await writeWebSession("muse", "work", WEB_SESSION)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toMatchObject({ remainingPct: 70 })
  expect(server.seen.every((line) => line.endsWith("Bearer fake-muse-access"))).toBe(true)
})

test("a refused or locally expired web session says to log in again, and an expired one is never sent", async () => {
  using server = portal(["1"], 403, () => false)
  await saveWork("fake-muse-access", Math.floor(Date.now() / 1000) - 60)
  await writeWebSession("muse", "work", WEB_SESSION)
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toEqual({ unavailable: "web session expired: run `kyora-switch muse web-login work`" })
  expect(server.seen).toEqual(["/api/portal/teams cookie llama_dev_sess=fake-web-session; datr=fake-datr"])

  server.seen.length = 0
  await writeWebSession("muse", "work", { ...WEB_SESSION, cookies: [{ ...WEB_SESSION.cookies[0]!, expires: 1 }] })
  expect(await museProvider.quotaWithReason!((await readSnapshot("muse", "work"))!, "work")).toEqual({ unavailable: museWebExpiredNote("work") })
  expect(server.seen).toEqual([])
})

test("the web session is no slot file: a re-save and a sync keep it and never copy it into the slot or Muse's files", async () => {
  await saveWork()
  await writeWebSession("muse", "work", WEB_SESSION)
  await writeSnapshot("work", (await museProvider.capture())!)
  const auth = JSON.parse(await Bun.file(authPath()).text())
  auth.providers.meta.access_token = "fake-muse-access-rotated"
  await Bun.write(authPath(), JSON.stringify(auth))
  expect((await syncLiveSlot(museProvider)).synced).toBe("work")
  expect(await readWebSession("muse", "work")).toEqual(WEB_SESSION)
  expect(Object.keys((await readSnapshot("muse", "work"))!.files)).toEqual(["auth.json"])
  for (const path of [authPath(), join(slotDir("muse", "work"), "auth.json"), join(slotDir("muse", "work"), "slot.json")]) {
    expect(await Bun.file(path).text()).not.toContain("fake-web-session")
  }
})

async function fakeChrome(): Promise<string> {
  const path = join(dir, "fake-chrome")
  const cookies = JSON.stringify([{ name: "llama_dev_sess", value: "fake-web-session", domain: "dev.meta.ai", path: "/", expires: FAR_FUTURE, secure: true }])
  await Bun.write(path, `#!/bin/sh\nexport FAKE_BROWSER_COOKIES='${cookies}'\nexec '${process.execPath}' '${join(import.meta.dir, "..", "fixtures", "fake-browser.ts")}' "$@"\n`)
  await chmod(path, 0o755)
  return path
}

test("saving another account over a slot drops the slot's web session; re-saving the same account keeps it", async () => {
  await saveWork()
  await writeWebSession("muse", "work", WEB_SESSION)
  expect((await cli("muse", "save", "work")).code).toBe(0)
  expect(await readWebSession("muse", "work")).toEqual(WEB_SESSION)

  await seed("other@home.example", "fake-other-access")
  const saved = await cli("muse", "save", "work")
  expect(saved.code).toBe(0)
  expect(saved.out).toContain(`dropped "work"'s web session: it belonged to the slot's previous account`)
  expect(await readWebSession("muse", "work")).toBeNull()
})

test("`muse web-login` keeps the session for the slot without printing it, and web-logout, rename and rm move or clear it", async () => {
  using _server = portal(["1"], 200, webAccepted)
  await saveWork()
  const browser = { KYORA_SWITCH_BROWSER: await fakeChrome() }

  const login = await cliWith(browser, "muse", "web-login", "work")
  expect(login.code).toBe(0)
  expect(login.out).toContain(`muse "work" web session saved: ${webSessionPath("muse", "work")}`)
  expect(login.out).not.toContain("fake-web-session")
  expect((await stat(webSessionPath("muse", "work"))).mode & 0o777).toBe(0o600)
  expect((await readWebSession("muse", "work"))?.cookies.map((cookie) => cookie.name)).toEqual(["datr", "llama_dev_sess"])
  expect((await cli("muse", "usage")).out).toContain("70% left")

  expect((await cli("muse", "rename", "work", "job")).code).toBe(0)
  expect(await readWebSession("muse", "work")).toBeNull()
  expect(await readWebSession("muse", "job")).not.toBeNull()
  expect(await cli("muse", "web-logout", "job")).toEqual({ code: 0, out: 'muse "job" web session removed\n' })
  expect(await cli("muse", "web-logout", "job")).toEqual({ code: 0, out: 'muse "job" has no web session\n' })
  expect(await cli("muse", "web-logout", "missing")).toMatchObject({ code: 2, out: expect.stringContaining('no muse slot "missing"') })

  expect((await cliWith(browser, "muse", "web-login", "job")).code).toBe(0)
  expect((await cli("muse", "rm", "job", "--yes")).code).toBe(0)
  expect(await readWebSession("muse", "job")).toBeNull()

  expect(await cliWith(browser, "muse", "web-login", "missing")).toMatchObject({ code: 2, out: expect.stringContaining('no muse slot "missing"') })
  expect(await cliWith(browser, "claude", "web-login", "work")).toMatchObject({ code: 2, out: expect.stringContaining("web-login is not available for claude") })
  expect(await cliWith({ KYORA_SWITCH_BROWSER: join(dir, "missing") }, "muse", "web-login", "work")).toMatchObject({ code: 2 })
}, 30_000)
