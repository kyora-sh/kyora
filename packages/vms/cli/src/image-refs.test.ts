import { afterEach, beforeEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { AccountImage } from "./account-images"
import { findVersion, isPinnedRef, lockedImage, parseRef, readLock, writeLock } from "./image-refs"
import { tempDir, write } from "./testing/fixtures"

/** refs (`name`, `name@N`, `name@sha256:…`, `img_…`) and kyora.image.lock (image-refs.ts) */

let root: string

beforeEach(async () => {
  root = await tempDir("image-refs")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const image = (id: string, version: number, fields: Partial<AccountImage> = {}): AccountImage => ({
  id,
  name: "platform",
  version,
  ref: `platform@${version}`,
  specKey: null,
  base: null,
  status: "ready",
  region: "eu",
  sha256: String(version).repeat(64).slice(0, 64),
  bytes: 4194304,
  chunks: 1,
  dataBytes: 4194304,
  storedBytes: 1000,
  digest: "0".repeat(64),
  createdAt: null,
  readyAt: null,
  expiresAt: null,
  error: null,
  ...fields,
})

test("parseRef and isPinnedRef", () => {
  expect(parseRef("platform")).toEqual({ name: "platform" })
  expect(parseRef("platform@3")).toEqual({ name: "platform", version: 3 })
  expect(parseRef(`platform@sha256:${"a".repeat(64)}`)).toEqual({ name: "platform", sha256: "a".repeat(64) })
  for (const bad of ["Platform", "platform@0", "platform@latest", "platform@sha256:abc", "9lives"]) expect(parseRef(bad)).toBeNull()
  expect(isPinnedRef("platform@3")).toBe(true)
  expect(isPinnedRef("img_0123456789ab")).toBe(true)
  expect(isPinnedRef("platform")).toBe(false)
})

test("findVersion: the newest of a name, one version, the newest with some bytes (in the region asked for)", () => {
  const same = "7".repeat(64)
  const images = [
    image("img_000000000001", 1, { sha256: same }),
    image("img_000000000002", 2),
    image("img_000000000003", 3, { sha256: same, region: "us" }),
    image("img_000000000004", 4, { status: "uploading" }),
    image("img_000000000005", 1, { name: "other", ref: "other@1" }),
  ]
  expect(findVersion(images, "platform")?.id).toBe("img_000000000003")
  expect(findVersion(images, "platform", "eu")?.id).toBe("img_000000000002")
  expect(findVersion(images, "platform@1")?.id).toBe("img_000000000001")
  expect(findVersion(images, "platform@4")).toBeNull()
  expect(findVersion(images, `platform@sha256:${same}`)?.id).toBe("img_000000000003")
  expect(findVersion(images, `platform@sha256:${same}`, "eu")?.id).toBe("img_000000000001")
  expect(findVersion(images, "img_000000000002")?.version).toBe(2)
  expect(findVersion(images, "nobody")).toBeNull()
})

test("the lock: image lock pins a name, others' pins stay; create --image <name> here boots the pinned version and says so", async () => {
  expect(readLock(root)).toBeNull()
  const notes: string[] = []
  expect(lockedImage("platform", root, (line) => notes.push(line))).toBe("platform")
  await writeLock(root, image("img_000000000003", 3), new Date("2026-10-06T12:00:00Z"))
  await writeLock(root, image("img_000000000009", 1, { name: "runner", ref: "runner@1" }))
  const lock = readLock(root)!
  expect(lock.images.platform).toEqual({ ref: "platform@3", version: 3, digest: `sha256:${"3".repeat(64)}`, id: "img_000000000003", region: "eu", lockedAt: "2026-10-06T12:00:00.000Z" })
  expect(Object.keys(lock.images)).toEqual(["platform", "runner"])
  expect(lockedImage("platform", root, (line) => notes.push(line))).toBe("platform@3")
  expect(notes.join("\n")).toContain("platform@3")
  expect(notes.join("\n")).toContain("kyora.image.lock")
  // a pinned ref, a fleet image or a name the lock doesn't know: as given
  expect(lockedImage("platform@1", root, () => {})).toBe("platform@1")
  expect(lockedImage("default", root, () => {})).toBe("default")
  expect(lockedImage("elsewhere", root, () => {})).toBe("elsewhere")
  // a lock that isn't one is said, never ignored
  await write(root, "kyora.image.lock", "{nope")
  expect(() => lockedImage("platform", root, () => {})).toThrow("not JSON")
  await Bun.write(join(root, "kyora.image.lock"), JSON.stringify({ images: { platform: { ref: "latest" } } }))
  expect(() => readLock(root)).toThrow("not an image lock")
})
