import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import type { UploadResult, VmsClient } from "./api"
import { KEY, startFakePlatform, startFakeVmd, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, platformEnv, spawnCli, tempDir, transcripts, waitFor, write } from "./testing/fixtures"
import { push } from "./transfer"

// real processes over real HTTP
setDefaultTimeout(30_000)

const KiB = 1024
const MiB = 1024 * KiB

let root: string
let cloud: FakeVmd

beforeEach(async () => {
  root = await tempDir("shards")
  cloud = await startFakePlatform()
})

afterEach(async () => {
  await cloud.stop()
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  expect(transcripts.length).toBeGreaterThan(0)
  for (const text of transcripts) for (const secret of [KEY, TOKEN]) expect(text).not.toContain(secret)
})

const env = () => platformEnv(cloud.url)
const sha = (bytes: Uint8Array | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** outside git: incompressible blobs, text, an executable, a symlink and an empty directory */
async function tree(blobs = 24, size = 96 * KiB): Promise<string> {
  const dir = join(root, "tree")
  for (let i = 0; i < blobs; i++) {
    await mkdir(join(dir, "data"), { recursive: true })
    await Bun.write(join(dir, "data", `blob-${String(i).padStart(2, "0")}.bin`), randomBytes(size))
  }
  await write(dir, "bin/run.sh", "#!/bin/sh\necho ran\n", 0o755)
  await write(dir, "src/a/b/c.txt", "deep\n".repeat(1000))
  await mkdir(join(dir, "empty"), { recursive: true })
  await symlink("src/a/b/c.txt", join(dir, "link"))
  return dir
}

/** path → what is there: a file's sha and exec bit, a link's target, or a directory */
async function describeTree(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const path = rel ? `${rel}/${name}` : name
    const stats = await lstat(join(dir, path))
    if (stats.isSymbolicLink()) out[path] = `-> ${await readlink(join(dir, path))}`
    else if (stats.isDirectory()) {
      out[path] = "dir"
      Object.assign(out, await describeTree(dir, path))
    } else out[path] = `${sha(await Bun.file(join(dir, path)).arrayBuffer())}${stats.mode & 0o100 ? " x" : ""}`
  }
  return out
}

async function createdId(): Promise<string> {
  const created = await cli(["create"], { cwd: root, env: env() })
  expect(created.code).toBe(0)
  return created.stdout.trim()
}

describe("sharded pushes to kyora cloud", () => {
  test("--shards 4: four archives, each its own upload, going up and unpacking side by side; every file lands once, byte for byte", async () => {
    cloud.options.partSize = 256 * KiB
    // the machine's side of a push takes a while, so the shards overlap there too
    cloud.options.unpackBytesPerSecond = 2 * MiB
    const dir = await tree()
    const id = await createdId()
    const result = await cli(["push", id, dir, "--shards", "4", "--json"], { cwd: root, env: env() })

    expect(result.code).toBe(0)
    expect(await describeTree(cloud.work(id))).toEqual(await describeTree(dir))
    expect(cloud.multipart).toHaveLength(4)
    expect(cloud.multipart.every((upload) => upload.status === "complete" && upload.contentType === "application/zstd" && upload.id === id)).toBe(true)
    // the shards really were side by side, on the wire and in the sandbox
    expect(cloud.maxPartsInFlight).toBeGreaterThan(1)
    expect(cloud.maxUnpacking).toBeGreaterThan(1)

    const pushed = JSON.parse(result.stdout)
    const parts = cloud.multipart.reduce((total, upload) => total + upload.parts.length, 0)
    expect(pushed).toMatchObject({ shards: 4, parts, files: "walk", sent: cloud.multipart.reduce((total, upload) => total + upload.parts.reduce((a, b) => a + b, 0), 0) })
    // each shard's entries, summed: every entry once (the fake counts what tar lists)
    expect(pushed.entries).toBe(Object.keys(await describeTree(dir)).length)
    expect(result.stderr).toMatch(new RegExp(`uploaded \\S+ \\S+ in ${parts} parts over 4 shards, \\S+ \\S+/s; unpacking in the sandbox`))

    const human = await cli(["push", id, dir, "--shards", "3"], { cwd: root, env: env() })
    expect(human.stdout).toMatch(/^uploaded \d+ entries \(\S+ \S+ on the wire in \d+ parts over 3 shards, \S+ \S+ raw\) to \/work in \S+\n$/)
  })

  test("run --shards: the command sees the whole tree", async () => {
    const dir = await tree(6)
    const result = await cli(["run", "--dir", dir, "--shards", "3", "--json", "--", "sh", "-c", "ls data | wc -l; ./bin/run.sh; cat link | wc -l"], { cwd: root, env: env() })
    expect(result.code).toBe(0)
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(events.find((event) => event.type === "upload")).toMatchObject({ shards: 3, parts: 3 })
    expect(events.filter((event) => event.type === "stdout").map((event) => event.data).join("").split(/\s+/).filter(Boolean)).toEqual(["6", "ran", "1000"])
  })

  test("a shard refused for good stops every shard: its upload and the others' are aborted, nothing runs, the sandbox goes", async () => {
    cloud.options.partSize = 256 * KiB
    // the second upload's first part is refused; the others' parts take their time
    cloud.options.part = (_, __, uploadId) => (uploadId === cloud.multipart[1]?.uploadId ? Response.json({ error: "storage_rejected", message: "R2 said no" }, { status: 400 }) : Bun.sleep(300).then(() => null))
    const dir = await tree()
    const result = await cli(["run", "--dir", dir, "--shards", "4", "--", "true"], { cwd: root, env: env() })

    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/upload part 1 to sb_\w+: R2 said no/)
    expect(cloud.multipart).toHaveLength(4)
    expect(cloud.multipart.map((upload) => upload.status)).toEqual(["aborted", "aborted", "aborted", "aborted"])
    for (const upload of cloud.multipart) expect(cloud.requests).toContain(`DELETE /v1/sandboxes/${upload.id}/uploads/${upload.uploadId}`)
    // the refused part was not retried, and nothing went on after it
    expect(cloud.partPuts.filter((put) => put.uploadId === cloud.multipart[1]!.uploadId)).toHaveLength(1)
    expect(cloud.requests.filter((request) => request.endsWith("/complete"))).toEqual([])
    expect(cloud.execs).toHaveLength(0)
    expect(cloud.destroyed).toHaveLength(1)
  })

  test("Ctrl-C during a sharded upload aborts every shard and destroys the sandbox", async () => {
    let release = () => {}
    const held = new Promise<null>((resolve) => (release = () => resolve(null)))
    cloud.options.part = () => held
    const dir = await tree(12)
    const running = spawnCli(["run", "--dir", dir, "--shards", "3", "--", "true"], { cwd: root, env: env() })
    await waitFor(() => new Set(cloud.partPuts.map((put) => put.uploadId)).size === 3, 15_000, "a part of every shard")
    running.proc.kill("SIGINT")
    const result = await running.done
    release()

    expect(result.code).toBe(130)
    expect(cloud.multipart.map((upload) => upload.status)).toEqual(["aborted", "aborted", "aborted"])
    expect(cloud.execs).toHaveLength(0)
    expect(cloud.destroyed).toHaveLength(1)
  })

  test("KYORA_VMS_PARTS_IN_FLIGHT caps the parts in flight of all shards together", async () => {
    cloud.options.partSize = 256 * KiB
    cloud.options.part = () => Bun.sleep(20).then(() => null)
    const dir = await tree()
    const id = await createdId()
    const result = await cli(["push", id, dir, "--shards", "4", "--json"], { cwd: root, env: { ...env(), KYORA_VMS_PARTS_IN_FLIGHT: "1" } })
    expect(result.code).toBe(0)
    expect(cloud.maxPartsInFlight).toBe(1)
    expect(await describeTree(cloud.work(id))).toEqual(await describeTree(dir))
  })

  test("--shards and KYORA_VMS_PARTS_IN_FLIGHT are checked", async () => {
    for (const bad of ["0", "-1", "two", "17"]) {
      const result = await cli(["push", "sb_x", ".", "--shards", bad], { cwd: root, env: env() })
      expect(result.code).toBe(125)
      expect(result.stderr).toContain("--shards")
    }
    for (const bad of ["0", "many", "33"]) {
      const result = await cli(["push", "sb_x", "."], { cwd: root, env: { ...env(), KYORA_VMS_PARTS_IN_FLIGHT: bad } })
      expect(result.code).toBe(125)
      expect(result.stderr).toContain("KYORA_VMS_PARTS_IN_FLIGHT")
    }
    expect((await cli(["exec", "sb_x", "--shards", "2", "--", "true"], { cwd: root, env: env() })).stderr).toContain("exec does not take --shards")
    expect(cloud.requests).toEqual([])
  })
})

describe("a kyora-vmd", () => {
  test("takes one streamed PUT without --shards however large the upload, and one per shard with it", async () => {
    // in process, with a listing that claims 5 GiB: a kyora-vmd never splits on its own
    const calls: string[] = []
    const api = {
      kind: async () => "vmd" as const,
      async upload(_id: string, _dest: string, body: ReadableStream<Uint8Array>): Promise<UploadResult> {
        calls.push("PUT")
        await new Response(body).arrayBuffer()
        return { bytes: 1, entries: 1, durationMs: 1 }
      },
    } as unknown as VmsClient
    const dir = await tree(2, KiB)
    const { listFiles } = await import("./pack")
    const listing = { ...(await listFiles(dir, { git: false })), bytes: 5 * 1024 * MiB }
    const whole = await push(api, "sb_1", listing, "/work")
    expect(calls).toEqual(["PUT"])
    expect(whole).toMatchObject({ shards: 1 })
    expect(whole.parts).toBeUndefined()

    const vmd = await startFakeVmd()
    try {
      const id = (await cli(["create"], { cwd: root, env: baseEnv(vmd.url) })).stdout.trim()
      const result = await cli(["push", id, dir, "--shards", "3", "--json"], { cwd: root, env: baseEnv(vmd.url) })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ shards: 3 })
      expect(JSON.parse(result.stdout).parts).toBeUndefined()
      expect(vmd.uploads).toHaveLength(3)
      expect(vmd.requests.filter((request) => request === `PUT /v1/sandboxes/${id}/files`)).toHaveLength(3)
      expect(await describeTree(vmd.work(id))).toEqual(await describeTree(dir))
      // without --shards it is the one PUT it always was, and says nothing of shards
      const plain = await cli(["push", id, dir, "--json"], { cwd: root, env: baseEnv(vmd.url) })
      expect(JSON.parse(plain.stdout).shards).toBeUndefined()
      expect(vmd.uploads).toHaveLength(4)
    } finally {
      await vmd.stop()
    }
  })
})

describe("downloads kyora cloud offers as byte ranges", () => {
  /** a sandbox with a file big enough for three 16 MiB windows, even compressed */
  async function sandboxWithBig(): Promise<{ id: string; data: Buffer }> {
    const id = await createdId()
    const data = randomBytes(40 * MiB + 321)
    await mkdir(join(cloud.work(id), "out"), { recursive: true })
    await Bun.write(join(cloud.work(id), "out", "big.bin"), data)
    await Bun.write(join(cloud.work(id), "out", "small.txt"), "small\n")
    return { id, data }
  }

  test("come as 16 MiB windows fetched side by side, handed to the extractor in order", async () => {
    cloud.options.ranges = true
    const { id, data } = await sandboxWithBig()
    const to = join(root, "pulled")
    const result = await cli(["pull", id, "out", "--to", to, "--json"], { cwd: root, env: env() })

    expect(result.code).toBe(0)
    expect(sha(await Bun.file(join(to, "out", "big.bin")).arrayBuffer())).toBe(sha(data))
    expect(await Bun.file(join(to, "out", "small.txt")).text()).toBe("small\n")
    const [download] = JSON.parse(result.stdout).downloads
    expect(download).toMatchObject({ path: "/work/out", ranged: true })
    // the first window came with the first response; the rest as ranges of the stored object
    const windows = Math.ceil(download.bytes / (16 * MiB))
    expect(windows).toBeGreaterThanOrEqual(3)
    expect(cloud.rangeGets.map((get) => [get.start, get.end])).toEqual(
      Array.from({ length: windows - 1 }, (_, i) => [(i + 1) * 16 * MiB, Math.min(download.bytes, (i + 2) * 16 * MiB) - 1]),
    )
    expect(new Set(cloud.rangeGets.map((get) => get.transfer)).size).toBe(1)
    expect(cloud.requests.filter((request) => request.startsWith("GET") && request.endsWith("/files"))).toHaveLength(1)
  })

  test("a window the edge fumbles is fetched again; a server that ignores Range is read whole", async () => {
    cloud.options.ranges = true
    cloud.options.range = (start, _, attempt) => (start === 32 * MiB && attempt === 1 ? new Response("<html>502 Bad Gateway</html>", { status: 502 }) : null)
    const { id, data } = await sandboxWithBig()
    const to = join(root, "pulled")
    const fumbled = await cli(["pull", id, "out/big.bin", "--to", to, "--json"], { cwd: root, env: env() })
    expect(fumbled.code).toBe(0)
    expect(sha(await Bun.file(join(to, "out", "big.bin")).arrayBuffer())).toBe(sha(data))
    expect(cloud.rangeGets.filter((get) => get.start === 32 * MiB).map((get) => get.status)).toEqual([502, 206])

    // a Range-blind server answers with the whole object: the first response is read to its end
    cloud.options.range = () => new Response("not what was asked for", { status: 200 })
    await rm(to, { recursive: true, force: true })
    const whole = await cli(["pull", id, "out/big.bin", "--to", to, "--json"], { cwd: root, env: env() })
    expect(whole.code).toBe(0)
    expect(sha(await Bun.file(join(to, "out", "big.bin")).arrayBuffer())).toBe(sha(data))
  })

  test("a small download, or one without an address for its ranges, is one stream as before", async () => {
    cloud.options.ranges = true
    const id = await createdId()
    await Bun.write(join(cloud.work(id), "small.bin"), randomBytes(2 * MiB))
    const pulled = await cli(["pull", id, "small.bin", "--to", join(root, "a"), "--json"], { cwd: root, env: env() })
    expect(pulled.code).toBe(0)
    expect(JSON.parse(pulled.stdout).downloads[0].ranged).toBeUndefined()

    // ranges offered, but where to get them is on another origin: the token does not go there
    cloud.options.ranges = false
    await Bun.write(join(cloud.work(id), "big.bin"), randomBytes(40 * MiB))
    const tar = join(root, "big.tar")
    Bun.spawnSync(["tar", "-cf", tar, "-C", cloud.work(id), "big.bin"])
    cloud.options.download = () =>
      new Response(Bun.file(tar), { headers: { "content-type": "application/x-tar", "accept-ranges": "bytes", "content-location": "https://elsewhere.example/v1/blob" } })
    const offsite = await cli(["pull", id, "big.bin", "--to", join(root, "b"), "--json"], { cwd: root, env: env() })
    expect(offsite.code).toBe(0)
    expect(JSON.parse(offsite.stdout).downloads[0].ranged).toBeUndefined()
    expect(sha(await Bun.file(join(root, "b", "big.bin")).arrayBuffer())).toBe(sha(await Bun.file(join(cloud.work(id), "big.bin")).arrayBuffer()))
    expect(cloud.rangeGets).toEqual([])
  })
})
