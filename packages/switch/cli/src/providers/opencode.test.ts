import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSnapshot, writeSnapshot } from "../store"
import { opencodeAccount } from "../identity"
import { syncLiveSlot } from "../sync"
import { mergeSubscriptions, opencodeProvider, subscriptionSlice } from "./opencode"

let dir: string
const previous = { data: process.env.XDG_DATA_HOME, slots: process.env.KYORA_SWITCH_DIR }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-opencode-"))
  process.env.XDG_DATA_HOME = join(dir, "data")
  process.env.KYORA_SWITCH_DIR = join(dir, "slots")
})

afterEach(async () => {
  if (previous.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previous.data
  if (previous.slots === undefined) delete process.env.KYORA_SWITCH_DIR
  else process.env.KYORA_SWITCH_DIR = previous.slots
  await rm(dir, { recursive: true, force: true })
})

const authPath = () => join(dir, "data", "opencode", "auth.json")
const writeAuth = (auth: Record<string, unknown>) => Bun.write(authPath(), JSON.stringify(auth, null, 2))
const readAuth = async () => JSON.parse(await Bun.file(authPath()).text()) as Record<string, unknown>

const OTHERS = {
  openai: { type: "oauth", refresh: "r", access: "a", expires: 1789000000000, accountId: "acct-1" },
  "zai-coding-plan": { type: "api", key: "zai-test-key" },
}
const go = (key: string) => ({ type: "api", key })

test("locations follow XDG_DATA_HOME, the way opencode resolves its data dir", () => {
  expect(opencodeProvider.locations()).toEqual([authPath()])
})

test("capture returns null without auth.json, or when only other providers are logged in", async () => {
  expect(await opencodeProvider.capture()).toBeNull()
  await writeAuth(OTHERS)
  expect(await opencodeProvider.capture()).toBeNull()
})

test("capture takes only the Go and Zen entries, identified by the key", async () => {
  await writeAuth({ ...OTHERS, opencode: go("sk-zen-key-9999"), "opencode-go": go("sk-go-key-1234") })
  const snapshot = (await opencodeProvider.capture())!

  expect(snapshot.identity).toEqual({ account: opencodeAccount("sk-go-key-1234"), plan: "Go + Zen" })
  expect(Object.keys(JSON.parse(snapshot.files["auth.json"]!))).toEqual(["opencode-go", "opencode"])
  expect(snapshot.files["auth.json"]).not.toContain("zai-test-key")
  expect(snapshot.files["auth.json"]).not.toContain("acct-1")
})

test("capture reports a corrupt auth.json instead of silently skipping it", async () => {
  await Bun.write(authPath(), "{not json")
  await expect(opencodeProvider.capture()).rejects.toThrow(/not valid JSON/)
})

test("restore swaps the Go key and leaves every other provider untouched, at 0600", async () => {
  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-work-0001") })
  const work = (await opencodeProvider.capture())!

  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-home-0002") })
  await opencodeProvider.restore(work)

  expect(await readAuth()).toEqual({ ...OTHERS, "opencode-go": go("sk-go-work-0001") })
  expect(Object.keys(await readAuth())).toEqual(["openai", "zai-coding-plan", "opencode-go"])
  expect((await stat(authPath())).mode & 0o777).toBe(0o600)
})

test("restore creates auth.json when opencode has never logged in", async () => {
  await writeAuth({ "opencode-go": go("sk-go-work-0001") })
  const work = (await opencodeProvider.capture())!
  await rm(authPath())

  await opencodeProvider.restore(work)
  expect(await readAuth()).toEqual({ "opencode-go": go("sk-go-work-0001") })
})

test("restore refuses a slot with no Go or Zen entry", async () => {
  const empty = { provider: "opencode" as const, identity: {}, capturedAt: 0 }
  await expect(opencodeProvider.restore({ ...empty, files: {} })).rejects.toThrow(/no OpenCode credentials/)
  await expect(opencodeProvider.restore({ ...empty, files: { "auth.json": JSON.stringify(OTHERS) } })).rejects.toThrow(
    /no OpenCode credentials/,
  )
})

test("mergeSubscriptions drops a Zen entry that is the outgoing login's own key", () => {
  const live = { ...OTHERS, "opencode-go": go("sk-shared-0001"), opencode: go("sk-shared-0001") }
  expect(mergeSubscriptions(live, { "opencode-go": go("sk-go-home-0002") })).toEqual({
    ...OTHERS,
    "opencode-go": go("sk-go-home-0002"),
  })
})

test("mergeSubscriptions keeps a Zen key that is a separate credential from the outgoing Go key", () => {
  const live = { "opencode-go": go("sk-go-work-0001"), opencode: go("sk-zen-own-0003") }
  expect(mergeSubscriptions(live, { "opencode-go": go("sk-go-home-0002") })).toEqual({
    "opencode-go": go("sk-go-home-0002"),
    opencode: go("sk-zen-own-0003"),
  })
})

test("mergeSubscriptions replaces a Go-only login with a Zen-only slot", () => {
  const live = { ...OTHERS, "opencode-go": go("sk-go-work-0001") }
  expect(mergeSubscriptions(live, { opencode: go("sk-zen-home-0004") })).toEqual({
    ...OTHERS,
    opencode: go("sk-zen-home-0004"),
  })
})

test("mergeSubscriptions does not mutate the live entries", () => {
  const live = { "opencode-go": go("sk-go-work-0001") }
  mergeSubscriptions(live, { "opencode-go": go("sk-go-home-0002") })
  expect(live).toEqual({ "opencode-go": go("sk-go-work-0001") })
})

test("subscriptionSlice orders Go before Zen whatever order the file has", () => {
  expect(Object.keys(subscriptionSlice({ opencode: 1, openai: 2, "opencode-go": 3 }))).toEqual(["opencode-go", "opencode"])
})

test("forget removes only the Go and Zen entries", async () => {
  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-work-0001"), opencode: go("sk-zen-0003") })
  await opencodeProvider.forget()

  expect(await readAuth()).toEqual(OTHERS)
  expect(await opencodeProvider.capture()).toBeNull()
  expect((await stat(authPath())).mode & 0o777).toBe(0o600)
})

test("forget is a no-op when there is nothing to remove, and never creates the file", async () => {
  await opencodeProvider.forget()
  expect(await Bun.file(authPath()).exists()).toBe(false)

  await Bun.write(authPath(), JSON.stringify(OTHERS))
  await opencodeProvider.forget()
  expect(await Bun.file(authPath()).text()).toBe(JSON.stringify(OTHERS))
})

test("quota asks the Go usage route with the slot's own key, and has nothing to ask for Zen", async () => {
  const seen: (string | null)[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization"))
      return Response.json({
        usage: {
          rolling: { status: "ok", percent: 20, resetsAt: "2026-09-30T04:12:09.000Z" },
          weekly: { status: "ok", percent: 55, resetsAt: "2026-10-05T00:00:00.000Z" },
          monthly: { status: "ok", percent: 30, resetsAt: "2026-10-16T12:14:01.000Z" },
        },
      })
    },
  })
  const previousUrl = process.env.KYORA_OPENCODE_USAGE_URL
  process.env.KYORA_OPENCODE_USAGE_URL = server.url.href
  try {
    await writeAuth({ "opencode-go": go("sk-go-work-0001"), opencode: go("sk-zen-0003") })
    const usage = await opencodeProvider.quota!((await opencodeProvider.capture())!)
    expect(usage?.remainingPct).toBe(45)
    expect(usage?.windows?.map((window) => window.label)).toEqual(["5h", "weekly", "monthly"])
    expect(seen).toEqual(["Bearer sk-go-work-0001"])

    await writeAuth({ opencode: go("sk-zen-0003") })
    expect(await opencodeProvider.quota!((await opencodeProvider.capture())!)).toBeNull()
    expect(seen.length).toBe(1)
  } finally {
    if (previousUrl === undefined) delete process.env.KYORA_OPENCODE_USAGE_URL
    else process.env.KYORA_OPENCODE_USAGE_URL = previousUrl
  }
})

test("an unchanged login syncs as already current, a rotated sibling provider does not dirty the slot", async () => {
  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-work-0001") })
  await writeSnapshot("work", (await opencodeProvider.capture())!)

  await writeAuth({ ...OTHERS, openai: { ...OTHERS.openai, access: "rotated" }, "opencode-go": go("sk-go-work-0001") })
  expect((await syncLiveSlot(opencodeProvider)).synced).toBeNull()
  expect(await readSnapshot("opencode", "work")).not.toBeNull()
})

test("save, switch and load back round-trips both accounts through the store", async () => {
  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-work-0001") })
  await writeSnapshot("work", (await opencodeProvider.capture())!)
  await writeAuth({ ...OTHERS, "opencode-go": go("sk-go-home-0002") })
  await writeSnapshot("private", (await opencodeProvider.capture())!)

  await opencodeProvider.restore((await readSnapshot("opencode", "work"))!)
  expect((await readAuth())["opencode-go"]).toEqual(go("sk-go-work-0001"))
  expect((await syncLiveSlot(opencodeProvider)).active?.identity).toEqual({ account: opencodeAccount("sk-go-work-0001"), plan: "Go" })

  await opencodeProvider.restore((await readSnapshot("opencode", "private"))!)
  expect(await readAuth()).toEqual({ ...OTHERS, "opencode-go": go("sk-go-home-0002") })
})
