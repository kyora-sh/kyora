import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { CHUNK_SIZE } from "../../shared/image-chunks"
import { sha256Hex } from "../../shared/image-chunks-bun"
import { pushImage } from "./account-images"
import { VmsClient } from "./api"
import { startFakePlatform, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { cli, platformEnv, tempDir, transcripts } from "./testing/fixtures"

/**
 * `kyora vms image push|ls|rm|usage` (account-images.ts) against the fake kyora cloud's account
 * image routes: only the chunks the account lacks go up, holes never do, a chunk repeated inside an
 * image goes once, and a second image sharing chunks uploads only its new ones.
 */

setDefaultTimeout(60_000)

let root: string
let cloud: FakeVmd

beforeEach(async () => {
  root = await tempDir("images")
  cloud = await startFakePlatform()
})

afterEach(async () => {
  await cloud.stop()
  await rm(root, { recursive: true, force: true })
})

const env = () => platformEnv(cloud.url)

/** a chunk of `seed`'s bytes: compressible, but every seed different */
function pattern(seed: number): Uint8Array {
  const chunk = new Uint8Array(CHUNK_SIZE)
  for (let at = 0; at < CHUNK_SIZE; at += 512) chunk[at] = (seed * 31 + at / 512) & 0xff
  chunk[0] = seed
  return chunk
}

/** a file of chunks, null for a hole */
async function imageFile(name: string, chunks: Array<number | null>): Promise<{ path: string; keys: string[] }> {
  const file = new Uint8Array(chunks.length * CHUNK_SIZE)
  chunks.forEach((seed, index) => {
    if (seed !== null) file.set(pattern(seed), index * CHUNK_SIZE)
  })
  const path = join(root, name)
  await Bun.write(path, file)
  const keys = chunks.filter((seed): seed is number => seed !== null).map((seed) => sha256Hex(new Uint8Array(Bun.zstdCompressSync(pattern(seed), { level: 3 }))))
  return { path, keys: [...new Set(keys)] }
}

test("push uploads each missing chunk once, skips holes, and a second image only sends its new chunks", async () => {
  const first = await imageFile("first.ext4", [1, null, 1, 2])
  const pushed = await cli(["image", "push", first.path, "--name", "tools"], { cwd: root, env: env() })
  expect(pushed.code).toBe(0)
  expect(pushed.stdout.trim()).toBe("tools@1")
  const id = [...cloud.accountImages.keys()].at(-1)!
  expect(id).toMatch(/^img_/)
  expect(pushed.stderr).toContain("2 of 2 chunks to upload")
  // the repeated chunk 0/2 went up once, the hole never
  expect(cloud.imageChunkPuts.sort()).toEqual([...first.keys].sort())
  const image = cloud.accountImages.get(id)!
  expect(image.status).toBe("ready")
  expect(image.chunks.map((entry) => entry[0])).toEqual([0, 2, 3])
  expect(image.sha256).toBe(sha256Hex(await Bun.file(first.path).bytes()))

  const second = await imageFile("second.ext4", [2, 3])
  const again = await cli(["image", "push", second.path, "--name", "derived", "--region", "us", "--json"], { cwd: root, env: env() })
  expect(again.code).toBe(0)
  const view = JSON.parse(again.stdout) as { id: string; uploaded: number; region: string; status: string }
  expect(view).toMatchObject({ uploaded: 1, region: "us", status: "ready" })
  // only chunk 3's key is new; chunk 2's the account holds from the first image
  expect(cloud.imageChunkPuts).toHaveLength(3)
  expect(cloud.imageChunkPuts.at(-1)).toBe(second.keys.find((key) => !first.keys.includes(key)))

  // a name pushed again is its next version
  const next = await cli(["image", "push", second.path, "--name", "derived"], { cwd: root, env: env() })
  expect(next.code).toBe(0)
  expect(next.stdout.trim()).toBe("derived@2")
  // a kyora image's own name is refused, said plainly
  const taken = await cli(["image", "push", second.path, "--name", "desktop"], { cwd: root, env: env() })
  expect(taken.code).not.toBe(0)
  expect(taken.stderr).toContain("kyora image's name")
})

test("ls, usage and rm round trip; create --image takes an img_ id", async () => {
  const file = await imageFile("one.ext4", [5, null])
  expect((await cli(["image", "push", file.path, "--name", "one"], { cwd: root, env: env() })).stdout.trim()).toBe("one@1")
  const id = [...cloud.accountImages.keys()].at(-1)!
  const listed = await cli(["image", "ls", "--json"], { cwd: root, env: env() })
  expect(listed.code).toBe(0)
  expect((JSON.parse(listed.stdout) as { images: Array<{ id: string; name: string }> }).images.map((image) => [image.id, image.name])).toEqual([[id, "one"]])
  const plain = await cli(["image", "ls"], { cwd: root, env: env() })
  expect(plain.stdout).toContain("one  one@1  1 version  8.0 MB  eu")

  const usage = await cli(["image", "usage", "--json"], { cwd: root, env: env() })
  expect(JSON.parse(usage.stdout)).toMatchObject({ images: 1, rate: 0.0225, storedBytes: cloud.imageChunks.get(file.keys[0]!) })
  expect((await cli(["image", "usage"], { cwd: root, env: env() })).stdout).toContain("$0.0225/GB-month")

  const created = await cli(["create", "--image", id], { cwd: root, env: env() })
  expect(created.code).toBe(0)
  expect((cloud.created.at(-1) as { image?: string }).image).toBe(id)

  expect((await cli(["image", "rm", id], { cwd: root, env: env() })).code).toBe(0)
  expect((JSON.parse((await cli(["image", "ls", "--json"], { cwd: root, env: env() })).stdout) as { images: unknown[] }).images).toEqual([])
  const gone = await cli(["image", "rm", id], { cwd: root, env: env() })
  expect(gone.code).not.toBe(0)
  expect(gone.stderr).toContain("no such image")
  const bad = await cli(["image", "rm", "not-an-id"], { cwd: root, env: env() })
  expect(bad.code).not.toBe(0)
  expect(bad.stderr).toContain("img_")
})

test("a file that is not a whole number of 4 MiB chunks is refused before anything is sent", async () => {
  const path = join(root, "odd.ext4")
  await Bun.write(path, new Uint8Array(CHUNK_SIZE + 1))
  const refused = await cli(["image", "push", path, "--name", "odd"], { cwd: root, env: env() })
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("whole number of 4 MiB chunks")
  expect(cloud.requests.some((line) => line.startsWith("POST /v1/images"))).toBe(false)
  const nameless = await cli(["image", "push", path], { cwd: root, env: env() })
  expect(nameless.stderr).toContain("--name")
})

test("kyora image … is the same command", async () => {
  const file = await imageFile("k.ext4", [9])
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", join(import.meta.dir, "kyora.ts"), "image", "push", file.path, "--name", "via-kyora"],
    cwd: root,
    env: Object.fromEntries(Object.entries(env()).filter(([, value]) => value !== undefined)) as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  transcripts.push(stdout, stderr)
  expect(code).toBe(0)
  expect(stdout.trim()).toBe("via-kyora@1")
  expect([...cloud.accountImages.values()].at(-1)?.name).toBe("via-kyora")
  expect(stdout + stderr).not.toContain(TOKEN)
})

test("an image too big to keep in memory is read again and still sends only what is missing", async () => {
  const seeded = await imageFile("seed.ext4", [21])
  const api = new VmsClient({ url: cloud.url, key: TOKEN })
  await pushImage(api, seeded.path, { name: "seed" })
  const file = await imageFile("big.ext4", [21, null, 22, 23, 22])
  const pushed = await pushImage(api, file.path, { name: "big", keepBytes: 0 })
  expect(pushed).toMatchObject({ chunks: 4, uploaded: 2 })
  expect(pushed.image.status).toBe("ready")
  expect(cloud.imageChunkPuts).toHaveLength(3)
  expect(new Set(cloud.imageChunkPuts)).toEqual(new Set(file.keys))
})
