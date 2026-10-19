import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { BUILDER_HASH } from "./image-builder-assets"
import { contentKey, loadSpec } from "./image-spec"
import { startFakePlatform, type FakeAccountImage, type FakeVmd } from "./testing/fake-vmd"
import { cli, platformEnv, tempDir, write } from "./testing/fixtures"

/**
 * The image commands end to end against the fake kyora cloud: `image build --json` (a cached build
 * needs no sandbox; a bad spec exits 2 naming the field), `image lock`, `create --image <name>`
 * pinned by the lock, `image ls`, `image versions` and `image rm name@N`.
 */

setDefaultTimeout(60_000)

let root: string
let cloud: FakeVmd

const BUILD = "full-0123"
const SPEC = { name: "platform", base: "default", apt: ["jq"], node: "24.11.1", pnpm: "10.33.2" }

beforeEach(async () => {
  root = await tempDir("image-cli")
  cloud = await startFakePlatform({ images: [{ name: "default", regions: [{ region: "eu", available: true, building: false, unknown: false, builds: [BUILD] }] }] })
})

afterEach(async () => {
  await cloud.stop()
  await rm(root, { recursive: true, force: true })
})

const env = () => platformEnv(cloud.url)

function seed(version: number, fields: Partial<FakeAccountImage> = {}): FakeAccountImage {
  const image: FakeAccountImage = {
    id: `img_seeded${String(version).padStart(6, "0")}`,
    name: "platform",
    version,
    specKey: null,
    base: null,
    status: "ready",
    region: "eu",
    sha256: String(version).repeat(64).slice(0, 64),
    bytes: 4 * 1024 * 1024,
    chunks: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    readyAt: "2026-10-06T00:00:01.000Z",
    ...fields,
  }
  cloud.accountImages.set(image.id, image)
  return image
}

test("image build --json: the same spec on the same base is the version that has its key, at once, as one JSON line", async () => {
  await write(root, "kyora.image.json", JSON.stringify(SPEC))
  const key = contentKey(await loadSpec(join(root, "kyora.image.json")), BUILD, BUILDER_HASH)
  seed(1)
  seed(2, { specKey: key, base: `default@${BUILD}` })
  const built = await cli(["image", "build", "--json"], { cwd: root, env: env() })
  expect(built.code).toBe(0)
  const result = JSON.parse(built.stdout) as Record<string, unknown>
  expect(result).toMatchObject({ ref: "platform@2", name: "platform", version: 2, digest: `sha256:${"2".repeat(64)}`, region: "eu", sizeBytes: 4 * 1024 * 1024, cached: true, key })
  expect(typeof result.durationMs).toBe("number")
  expect(built.stdout.trim().split("\n")).toHaveLength(1)
  expect(built.stderr).toContain("reusing it (cached)")
  // nothing booted for it
  expect(cloud.created).toHaveLength(0)

  // plain: the ref on stdout, for scripts
  const plain = await cli(["image", "build", join(root, "kyora.image.json")], { cwd: "/", env: env() })
  expect([plain.code, plain.stdout.trim()]).toEqual([0, "platform@2"])
})

test("image build with a bad spec exits 2 and names every field; no spec at all says what to write", async () => {
  await write(root, "kyora.image.json", JSON.stringify({ ...SPEC, node: "24", apt: ["Bad"] }))
  const bad = await cli(["image", "build", "--json"], { cwd: root, env: env() })
  expect(bad.code).toBe(2)
  expect(bad.stdout).toBe("")
  expect(bad.stderr).toContain('node: must be an exact version like "24.11.1"')
  expect(bad.stderr).toContain("apt[0]")
  expect(cloud.created).toHaveLength(0)
  const none = await cli(["image", "build"], { cwd: join(root, ".."), env: env() })
  expect(none.code).toBe(2)
  expect(none.stderr).toContain("kyora.image.json")
})

test("image lock pins the newest version; create --image <name> here boots it and says so; elsewhere it is the newest", async () => {
  await write(root, "kyora.image.json", JSON.stringify(SPEC))
  seed(1)
  seed(2)
  const locked = await cli(["image", "lock"], { cwd: root, env: env() })
  expect(locked.code).toBe(0)
  const lock = JSON.parse(await Bun.file(join(root, "kyora.image.lock")).text())
  expect(lock.images.platform).toMatchObject({ ref: "platform@2", version: 2, digest: `sha256:${"2".repeat(64)}`, id: "img_seeded000002" })

  seed(3)
  const pinned = await cli(["create", "--image", "platform"], { cwd: root, env: env() })
  expect(pinned.code).toBe(0)
  expect((cloud.created.at(-1) as { image?: string }).image).toBe("platform@2")
  expect(pinned.stderr).toContain("pinned by kyora.image.lock")
  const anywhere = await cli(["create", "--image", "platform"], { cwd: join(root, ".."), env: env() })
  expect((cloud.created.at(-1) as { image?: string }).image).toBe("platform")
  expect(anywhere.code).toBe(0)
  // a pinned ref is taken as it is, the lock or not
  await cli(["create", "--image", `platform@sha256:${"1".repeat(64)}`], { cwd: root, env: env() })
  expect((cloud.created.at(-1) as { image?: string }).image).toBe(`platform@sha256:${"1".repeat(64)}`)
  const relocked = await cli(["image", "lock", "--json"], { cwd: root, env: env() })
  expect(JSON.parse(relocked.stdout)).toMatchObject({ ref: "platform@3" })
})

test("image ls by name, image versions, image rm name@N", async () => {
  seed(1)
  seed(2, { region: "us" })
  seed(1, { id: "img_seededrunner1", name: "runner" })
  const listed = await cli(["image", "ls"], { cwd: root, env: env() })
  expect(listed.code).toBe(0)
  expect(listed.stdout).toContain("platform  platform@2  2 versions  4.0 MB  eu,us")
  expect(listed.stdout).toContain("runner  runner@1  1 version")
  const versions = await cli(["image", "versions", "platform"], { cwd: root, env: env() })
  expect(versions.stdout.trim().split("\n").map((line) => line.split("  ")[0])).toEqual(["platform@2", "platform@1"])
  const removed = await cli(["image", "rm", "platform@1", "--json"], { cwd: root, env: env() })
  expect(removed.code).toBe(0)
  expect(JSON.parse(removed.stdout)).toEqual({ deleted: "img_seeded000001", ref: "platform@1" })
  expect(cloud.accountImages.get("img_seeded000001")!.status).toBe("deleted")
  const gone = await cli(["image", "rm", "platform@1"], { cwd: root, env: env() })
  expect(gone.code).not.toBe(0)
  expect(gone.stderr).toContain("no such image")
  const bare = await cli(["image", "rm", "platform"], { cwd: root, env: env() })
  expect(bare.code).not.toBe(0)
  expect(bare.stderr).toContain("name@N")
})
