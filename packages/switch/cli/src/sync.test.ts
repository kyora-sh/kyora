import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexProvider } from "./providers/codex"
import { museProvider, preferredIdentity } from "./providers/muse"
import { readSlot, readSnapshot, writeBackup, writeSnapshot } from "./store"
import { findLiveSlot, fingerprintOf, grantFingerprint, sameFiles, syncLiveSlot } from "./sync"
import type { Provider, Snapshot } from "./types"

let dir: string
const previous = process.env.KYORA_SWITCH_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-sync-"))
  process.env.KYORA_SWITCH_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.KYORA_SWITCH_DIR
  else process.env.KYORA_SWITCH_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

function snapshot(account: string, token: string): Snapshot {
  return {
    provider: "codex",
    identity: { account, plan: "pro" },
    files: { "auth.json": JSON.stringify({ tokens: { access_token: token } }) },
    capturedAt: 1,
  }
}

function provider(live: Snapshot | null): Provider {
  return {
    id: "codex",
    label: "Codex",
    processName: "codex",
    loginHint: "",
    locations: () => [],
    capture: async () => live,
    forget: async () => {},
    restore: async () => {},
  }
}

test("sameFiles compares contents regardless of key order", () => {
  const a: Snapshot = { ...snapshot("a", "t"), files: { "x.json": "1", "y.json": "2" } }
  const b: Snapshot = { ...snapshot("a", "t"), files: { "y.json": "2", "x.json": "1" } }
  expect(sameFiles(a, b)).toBe(true)
  expect(sameFiles(a, { ...b, files: { "y.json": "2", "x.json": "9" } })).toBe(false)
  expect(sameFiles(a, { ...b, files: { "x.json": "1" } })).toBe(false)
})

test("a slot holding the live account picks up the CLI's newer token", async () => {
  await writeSnapshot("work", snapshot("me@work.dev", "stale"))
  const state = await syncLiveSlot(provider(snapshot("me@work.dev", "fresh")))

  expect(state.synced).toBe("work")
  expect(JSON.parse((await readSnapshot("codex", "work"))!.files["auth.json"]!).tokens.access_token).toBe("fresh")
})

test("an already-current slot is left alone, so its timestamps do not churn", async () => {
  const written = await writeSnapshot("work", snapshot("me@work.dev", "same"))
  const state = await syncLiveSlot(provider(snapshot("me@work.dev", "same")))

  expect(state.synced).toBeNull()
  expect((await readSlot("codex", "work"))?.updatedAt).toBe(written.updatedAt)
})

test("other accounts' slots are never touched", async () => {
  await writeSnapshot("work", snapshot("me@work.dev", "work-token"))
  await writeSnapshot("private", snapshot("me@home.dev", "home-token"))
  const state = await syncLiveSlot(provider(snapshot("me@work.dev", "newer")))

  expect(state.synced).toBe("work")
  expect(JSON.parse((await readSnapshot("codex", "private"))!.files["auth.json"]!).tokens.access_token).toBe("home-token")
})

test("nothing happens when the live account is in no slot, or nothing is logged in", async () => {
  await writeSnapshot("work", snapshot("me@work.dev", "t"))
  expect((await syncLiveSlot(provider(snapshot("stranger@x.dev", "t")))).synced).toBeNull()
  expect((await syncLiveSlot(provider(null))).synced).toBeNull()
  expect(JSON.parse((await readSnapshot("codex", "work"))!.files["auth.json"]!).tokens.access_token).toBe("t")
})

// ── slots kyora cloud's broker owns (`kyora session creds sync` marks them in slot.json) ──

/** a Codex login with a refresh token: its grant, which kyora-switch matches by */
function login(account: string, refresh: string, access = `${refresh}-access`): Snapshot {
  return {
    provider: "codex",
    identity: { account, plan: "pro" },
    files: { "auth.json": JSON.stringify({ tokens: { access_token: access, refresh_token: refresh } }) },
    capturedAt: 1,
  }
}

const withGrant = (live: Snapshot | null): Provider => ({ ...provider(live), grant: codexProvider.grant })

/** what `kyora session creds sync` adds to the slot's slot.json */
async function markCloudOwned(name: string, refresh: string): Promise<void> {
  const path = join(dir, "codex", name, "slot.json")
  const meta = JSON.parse(await Bun.file(path).text())
  await Bun.write(path, JSON.stringify({ ...meta, cloudOwned: { at: 5, by: "kyora session creds sync", fingerprint: fingerprintOf(refresh) } }))
}

const refreshOf = async (name: string) => JSON.parse((await readSnapshot("codex", name))!.files["auth.json"]!).tokens.refresh_token

test("the fingerprint is kyora session's: sha256 of kyora-slot:<secret>, 24 hex", () => {
  const expected = new Bun.CryptoHasher("sha256").update("kyora-slot:RT-1").digest("hex").slice(0, 24)
  expect(fingerprintOf("RT-1")).toBe(expected)
  expect(grantFingerprint(codexProvider, login("a@x", "RT-1"))).toBe(expected)
})

test("a slot kyora cloud owns is never synced into by email, even when it sorts first", async () => {
  await writeSnapshot("cloud-work", login("me@work.dev", "CLOUD"))
  await markCloudOwned("cloud-work", "CLOUD")
  await writeSnapshot("work", login("me@work.dev", "LIVE"))
  // the CLI refreshed since: a new refresh token, so only the email still matches
  const state = await syncLiveSlot(withGrant(login("me@work.dev", "LIVE-2")))

  expect(state.synced).toBe("work")
  expect(state.skipped).toBeNull()
  expect(await refreshOf("cloud-work")).toBe("CLOUD")
  expect(await refreshOf("work")).toBe("LIVE-2")
  expect((await readSlot("codex", "cloud-work"))!.cloudOwned).toEqual({ at: 5, by: "kyora session creds sync", fingerprint: fingerprintOf("CLOUD") })
})

test("the live login being the broker's own grant is skipped and said so, never written", async () => {
  await writeSnapshot("cloud-work", login("me@work.dev", "CLOUD", "old-access"))
  await markCloudOwned("cloud-work", "CLOUD")
  const state = await syncLiveSlot(withGrant(login("me@work.dev", "CLOUD", "new-access")))

  expect(state).toMatchObject({ synced: null, skipped: "cloud-work" })
  expect(state.live?.name).toBe("cloud-work")
  expect(JSON.parse((await readSnapshot("codex", "cloud-work"))!.files["auth.json"]!).tokens.access_token).toBe("old-access")
})

test("the marker's own fingerprint names the grant even when the slot's files moved on", async () => {
  await writeSnapshot("cloud-work", login("me@work.dev", "CHANGED-HERE"))
  await markCloudOwned("cloud-work", "UPLOADED")
  expect((await syncLiveSlot(withGrant(login("me@work.dev", "UPLOADED")))).skipped).toBe("cloud-work")
})

test("by grant first: two logins of one account each keep to their own slot", async () => {
  await writeSnapshot("work", login("me@work.dev", "A"))
  await writeSnapshot("work2", login("me@work.dev", "B"))
  const state = await syncLiveSlot(withGrant(login("me@work.dev", "B", "B-newer-access")))

  expect(state.synced).toBe("work2")
  expect(await refreshOf("work")).toBe("A")
})

test("a live login whose only same-email slot is kyora cloud's is in no slot", async () => {
  await writeSnapshot("cloud-work", login("me@work.dev", "CLOUD"))
  await markCloudOwned("cloud-work", "CLOUD")
  const state = await syncLiveSlot(withGrant(login("me@work.dev", "OTHER")))

  expect(state).toMatchObject({ synced: null, skipped: null, live: null })
  expect(await refreshOf("cloud-work")).toBe("CLOUD")
})

test("a slot overwritten by email, holding another grant, is backed up first (m5)", async () => {
  const claude = (refresh: string): Snapshot => ({ provider: "codex", identity: { account: "me@work.dev" }, files: { "auth.json": JSON.stringify({ tokens: { refresh_token: refresh } }) }, capturedAt: 1 })
  const grantProvider: Provider = { ...provider(claude("LIVE")), grant: (snapshot) => JSON.parse(snapshot.files["auth.json"]!).tokens.refresh_token }
  await writeSnapshot("work", claude("OLDER"))
  const state = await syncLiveSlot(grantProvider)
  expect(state.synced).toBe("work")
  const backups = await readdir(join(dir, "sync-backups", "codex"))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, "sync-backups", "codex", backups[0]!, "auth.json"), "utf8")).toContain("OLDER")
})

test("an unrecognised muse keychain blob is not filed into an api-key slot with no account", async () => {
  const apiKeySlot: Snapshot = {
    provider: "muse",
    identity: { account: undefined, plan: "api key" },
    files: { "auth.json": `${JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "stored-fake-key" } } }, null, 2)}\n` },
    capturedAt: 1,
  }
  await writeSnapshot("keyslot", apiKeySlot)
  const liveFiles = { "keychain.json": "<opaque fake bytes>" }
  const live: Snapshot = { provider: "muse", identity: preferredIdentity(liveFiles), files: liveFiles, capturedAt: 2 }
  const liveProvider: Provider = { ...museProvider, capture: async () => live }
  expect(museProvider.grant!(live)).toBe("<opaque fake bytes>")
  const before = (await readSnapshot("muse", "keyslot"))!.files
  const state = await syncLiveSlot(liveProvider)
  expect(state.synced).toBeNull()
  expect(state.live).toBeNull()
  expect(await findLiveSlot(liveProvider, live, state.slots)).toBeNull()
  expect((await readSnapshot("muse", "keyslot"))!.files).toEqual(before)
})

test("a different stored api key live is not synced into an existing api-key slot", async () => {
  const slot: Snapshot = {
    provider: "muse",
    identity: { account: undefined, plan: "api key" },
    files: { "auth.json": `${JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "first-fake-key" } } }, null, 2)}\n` },
    capturedAt: 1,
  }
  await writeSnapshot("keyslot", slot)
  const live: Snapshot = {
    provider: "muse",
    identity: { account: undefined, plan: "api key" },
    files: { "auth.json": `${JSON.stringify({ providers: { meta: { mechanism: "api_key", api_key: "second-fake-key" } } }, null, 2)}\n` },
    capturedAt: 2,
  }
  const liveProvider: Provider = { ...museProvider, capture: async () => live }
  const state = await syncLiveSlot(liveProvider)
  expect(state.synced).toBeNull()
  expect(state.live).toBeNull()
  expect((await readSnapshot("muse", "keyslot"))!.files).toEqual(slot.files)
})

function museLogin(meta: Record<string, unknown>): string {
  return `${JSON.stringify({ providers: { meta: { mechanism: "oauth", ...meta } } }, null, 2)}\n`
}

function museSnapshot(files: Record<string, string>, capturedAt = 1): Snapshot {
  return { provider: "muse", identity: preferredIdentity(files), files, capturedAt }
}

const liveMuse = (live: Snapshot): Provider => ({ ...museProvider, capture: async () => live })

test("a new muse login in an unparseable keychain blob never matches a slot through the stale auth.json", async () => {
  const fileA = museLogin({ access_token: "file-a", refresh_token: "refresh-a", user_email: "a@acme.dev" })
  const blobA = JSON.stringify({ mechanism: "oauth", access_token: "blob-a", refresh_token: "refresh-a", user_email: "a@acme.dev" })
  await writeSnapshot("a", museSnapshot({ "auth.json": fileA, "keychain.json": blobA }))
  const before = (await readSnapshot("muse", "a"))!.files
  const live = museSnapshot({ "auth.json": fileA, "keychain.json": "<opaque fake bytes of login b>" }, 2)
  const state = await syncLiveSlot(liveMuse(live))
  expect(state.live).toBeNull()
  expect(state.synced).toBeNull()
  expect((await readSnapshot("muse", "a"))!.files).toEqual(before)
})

test("a muse slot whose auth.json changes under the same keychain grant is backed up before the sync overwrites it", async () => {
  const blob = JSON.stringify({ mechanism: "oauth", access_token: "blob-a", refresh_token: "refresh-a", user_email: "a@acme.dev" })
  const oldFile = museLogin({ access_token: "OLDER-file", refresh_token: "older-file-refresh", user_email: "a@acme.dev" })
  await writeSnapshot("a", museSnapshot({ "auth.json": oldFile, "keychain.json": blob }))
  const live = museSnapshot({ "auth.json": museLogin({ access_token: "newer-file", refresh_token: "newer-file-refresh", user_email: "a@acme.dev" }), "keychain.json": blob }, 2)
  const state = await syncLiveSlot(liveMuse(live))
  expect(state.synced).toBe("a")
  const backups = await readdir(join(dir, "sync-backups", "muse"))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, "sync-backups", "muse", backups[0]!, "auth.json"), "utf8")).toContain("OLDER-file")
  expect(await syncLiveSlot(liveMuse(live))).toMatchObject({ synced: null, live: { name: "a" } })
  expect(await readdir(join(dir, "sync-backups", "muse"))).toHaveLength(1)
})

test("routine muse token refreshes after a replacement never push the replacement's backup out", async () => {
  const blob = (access: string) => JSON.stringify({ mechanism: "oauth", access_token: access, refresh_token: "keychain-refresh", expires_at: access.length, user_email: "a@acme.dev" })
  const file = (access: string, refresh: string) => museLogin({ access_token: access, refresh_token: refresh, expires_at: access.length, user_email: "a@acme.dev" })
  await writeSnapshot("a", museSnapshot({ "auth.json": file("REPLACED-access", "REPLACED-refresh"), "keychain.json": blob("k0") }))
  await syncLiveSlot(liveMuse(museSnapshot({ "auth.json": file("f0", "file-refresh"), "keychain.json": blob("k0") }, 2)))
  for (let refresh = 1; refresh <= 12; refresh++) {
    const access = `access-${"x".repeat(refresh)}`
    const state = await syncLiveSlot(liveMuse(museSnapshot({ "auth.json": file(access, "file-refresh"), "keychain.json": blob(access) }, 2 + refresh)))
    expect(state.synced).toBe("a")
  }
  const backups = await readdir(join(dir, "sync-backups", "muse"))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, "sync-backups", "muse", backups[0]!, "auth.json"), "utf8")).toContain("REPLACED-refresh")
})

test("a muse login is never filed into a slot by a shared full name", async () => {
  const work = museSnapshot({ "auth.json": museLogin({ access_token: "work", refresh_token: "work-refresh", user_full_name: "Same Name" }) })
  await writeSnapshot("work", work)
  const live = museSnapshot({ "auth.json": museLogin({ access_token: "personal", refresh_token: "personal-refresh", user_full_name: "Same Name" }) }, 2)
  expect(live.identity).toEqual({ account: undefined, name: "Same Name", plan: undefined })
  const state = await syncLiveSlot(liveMuse(live))
  expect(state.live).toBeNull()
  expect(state.synced).toBeNull()
  expect(state.ambiguous).toEqual([])
  expect((await readSnapshot("muse", "work"))!.files).toEqual(work.files)
})

test("a sync that overwrites another grant backs it up, to its own backups with its own cap: load's are never pushed out (third and fourth review)", async () => {
  const login = (refresh: string, account = "me@work.dev"): Snapshot => ({ provider: "codex", identity: { account }, files: { "auth.json": JSON.stringify({ tokens: { refresh_token: refresh } }) }, capturedAt: Date.now() })
  let live = login("RT-1")
  const rotating: Provider = { ...provider(null), capture: async () => live, grant: (snapshot) => JSON.parse(snapshot.files["auth.json"]!).tokens.refresh_token }
  await writeSnapshot("personal", live, { live: grantFingerprint(rotating, live)! })
  // `load` replaced a login that was in no slot: this backup is its only copy
  const only = await writeBackup(login("RT-PERSONAL", "me@home.dev"))
  // a fresh login of the same email (another workspace): the slot's grant is kept, in the sync backups
  live = login("RT-TEAM")
  expect((await syncLiveSlot(rotating)).synced).toBe("personal")
  const kept = await readdir(join(dir, "sync-backups", "codex"))
  expect(kept).toHaveLength(1)
  expect(await readFile(join(dir, "sync-backups", "codex", kept[0]!, "auth.json"), "utf8")).toContain("RT-1")
  // however many follow, load's backups stay: the sync backups have their own cap
  for (let i = 2; i <= 13; i++) {
    live = login(`RT-${i}`)
    await syncLiveSlot(rotating)
    await Bun.sleep(2)
  }
  expect((await readdir(join(dir, "sync-backups", "codex"))).length).toBeLessThanOrEqual(10)
  expect(await readFile(join(only, "auth.json"), "utf8")).toContain("RT-PERSONAL")
})
