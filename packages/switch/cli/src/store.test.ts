import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertName,
  listSlots,
  readSlot,
  readSnapshot,
  removeSlot,
  renameSlot,
  rootDir,
  SwitchLockBusy,
  withSwitchLock,
  writeBackup,
  writeSnapshot,
} from "./store"
import type { Snapshot } from "./types"

let dir: string
const previous = process.env.KYORA_SWITCH_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-test-"))
  process.env.KYORA_SWITCH_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.KYORA_SWITCH_DIR
  else process.env.KYORA_SWITCH_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "codex",
    identity: { account: "me@example.com", plan: "pro" },
    files: { "auth.json": '{"tokens":{}}' },
    capturedAt: 1,
    ...overrides,
  }
}

test("rootDir honours KYORA_SWITCH_DIR", () => {
  expect(rootDir()).toBe(dir)
})

test("slot names are restricted to safe path segments", () => {
  expect(assertName("work-2")).toBe("work-2")
  expect(() => assertName("../escape")).toThrow(/invalid slot name/)
  expect(() => assertName("a/b")).toThrow(/invalid slot name/)
  expect(() => assertName("")).toThrow(/invalid slot name/)
  expect(() => assertName(".hidden")).toThrow(/invalid slot name/)
})

test("a snapshot round-trips through save and read", async () => {
  await writeSnapshot("work", snapshot())
  expect((await readSlot("codex", "work"))?.identity.account).toBe("me@example.com")

  const restored = await readSnapshot("codex", "work")
  expect(restored?.files).toEqual({ "auth.json": '{"tokens":{}}' })
  expect(restored?.identity.account).toBe("me@example.com")
})

test("slots are namespaced per provider, so the same name holds two accounts", async () => {
  await writeSnapshot("work", snapshot({ identity: { account: "codex@work.dev" } }))
  await writeSnapshot(
    "work",
    snapshot({ provider: "claude", identity: { account: "claude@work.dev" }, files: { "credentials.json": "{}" } }),
  )

  expect((await readSlot("codex", "work"))?.identity.account).toBe("codex@work.dev")
  expect((await readSlot("claude", "work"))?.identity.account).toBe("claude@work.dev")
  expect((await listSlots("codex")).length).toBe(1)
})

test("re-saving a slot drops files the new snapshot no longer has", async () => {
  await writeSnapshot("work", snapshot({ files: { "auth.json": "{}", "stale.json": "{}" } }))
  await writeSnapshot("work", snapshot({ files: { "auth.json": "{}" } }))

  expect(Object.keys((await readSnapshot("codex", "work"))!.files)).toEqual(["auth.json"])
})

test("createdAt survives a re-save", async () => {
  const first = await writeSnapshot("work", snapshot())
  const second = await writeSnapshot("work", snapshot({ capturedAt: 999 }))
  expect(second.createdAt).toBe(first.createdAt)
  expect(second.updatedAt).toBe(999)
})

test("listSlots is sorted, readSlot is null for unknown names", async () => {
  await writeSnapshot("work", snapshot())
  await writeSnapshot("private", snapshot())
  expect((await listSlots("codex")).map((slot) => slot.name)).toEqual(["private", "work"])
  expect(await listSlots("claude")).toEqual([])
  expect(await readSlot("codex", "nope")).toBeNull()
  expect(await readSnapshot("codex", "nope")).toBeNull()
})

test("remove and rename move the whole slot", async () => {
  await writeSnapshot("work", snapshot())
  await renameSlot("codex", "work", "day-job")
  expect((await readSlot("codex", "day-job"))?.name).toBe("day-job")
  expect(await readSlot("codex", "work")).toBeNull()

  await removeSlot("codex", "day-job")
  expect(await listSlots("codex")).toEqual([])
})

test("writeBackup stores the outgoing files under the provider", async () => {
  const path = await writeBackup(snapshot())
  expect(path.startsWith(join(dir, "backups", "codex"))).toBe(true)
  expect(await Bun.file(join(path, "auth.json")).text()).toBe('{"tokens":{}}')
})

// ── kyora session's cloudOwned marker in slot.json ──

const metaPath = (name: string) => join(dir, "codex", name, "slot.json")
const rawMeta = async (name: string) => JSON.parse(await Bun.file(metaPath(name)).text()) as Record<string, unknown>

test("a slot.json without the marker reads and writes exactly as before", async () => {
  await writeSnapshot("work", snapshot({ capturedAt: 7 }))
  expect(await readSlot("codex", "work")).toEqual({ name: "work", provider: "codex", identity: { account: "me@example.com", plan: "pro" }, createdAt: 7, updatedAt: 7 })
  expect(await Bun.file(metaPath("work")).text()).toBe(
    `${JSON.stringify({ name: "work", provider: "codex", identity: { account: "me@example.com", plan: "pro" }, createdAt: 7, updatedAt: 7 }, null, 2)}\n`,
  )
})

test("the marker is read as an object or as true, and anything falsy is no marker", async () => {
  await writeSnapshot("work", snapshot())
  const marker = { at: 5, by: "kyora session creds sync", fingerprint: "a".repeat(24) }
  await Bun.write(metaPath("work"), JSON.stringify({ ...(await rawMeta("work")), cloudOwned: marker }))
  expect((await readSlot("codex", "work"))!.cloudOwned).toEqual(marker)
  await Bun.write(metaPath("work"), JSON.stringify({ ...(await rawMeta("work")), cloudOwned: true }))
  expect((await readSlot("codex", "work"))!.cloudOwned).toBe(true)
  await Bun.write(metaPath("work"), JSON.stringify({ ...(await rawMeta("work")), cloudOwned: null }))
  expect("cloudOwned" in (await readSlot("codex", "work"))!).toBe(false)
})

test("a re-save and a rename keep the marker and any field another tool put in slot.json", async () => {
  await writeSnapshot("work", snapshot())
  const marker = { at: 5, by: "kyora session creds sync", fingerprint: "b".repeat(24) }
  await Bun.write(metaPath("work"), JSON.stringify({ ...(await rawMeta("work")), cloudOwned: marker, note: "kept" }))

  const saved = await writeSnapshot("work", snapshot({ capturedAt: 99, files: { "auth.json": '{"tokens":{"x":1}}' } }))
  expect(saved.cloudOwned).toEqual(marker)
  expect(await rawMeta("work")).toMatchObject({ name: "work", updatedAt: 99, cloudOwned: marker, note: "kept" })

  await renameSlot("codex", "work", "day-job")
  expect(await rawMeta("day-job")).toMatchObject({ name: "day-job", cloudOwned: marker, note: "kept" })
  expect((await readSlot("codex", "day-job"))!.cloudOwned).toEqual(marker)
})

test("the slot lock lets one holder per provider in at a time, names the holder to one that gives up, and is no lock without slots", async () => {
  expect(await withSwitchLock("claude", async () => withSwitchLock("claude", async () => "nested", 100))).toBe("nested")
  expect(await readdir(dir)).toEqual([])
  await mkdir(join(dir, "claude"))
  await mkdir(join(dir, "codex"))
  const order: string[] = []
  let release!: () => void
  const held = withSwitchLock("claude", async () => {
    order.push("first in")
    await new Promise<void>((resolve) => (release = resolve))
    order.push("first out")
  })
  await Bun.sleep(20)
  await expect(withSwitchLock("claude", async () => order.push("never"), 100)).rejects.toThrow(new RegExp(`another kyora-switch \\(pid ${process.pid}\\) is changing claude slots`))
  await expect(withSwitchLock("claude", async () => {}, 100)).rejects.toBeInstanceOf(SwitchLockBusy)
  await withSwitchLock("codex", async () => order.push("codex"))
  const second = withSwitchLock("claude", async () => order.push("second in"))
  await Bun.sleep(100)
  release()
  await Promise.all([held, second])
  expect(order).toEqual(["first in", "codex", "first out", "second in"])
})
