/**
 * Sharded pushes and ranged downloads against a fake kyora cloud that has the shape of the
 * real path: every connection capped at --mbps each way (a TCP proxy: one connection's
 * throughput to the edge), a round trip per request (--latency-ms), 64 MiB parts, and the
 * machine's side of each push (R2 → node → guest unpack) capped at --unpack-mbps per stream.
 * Then the same with no caps at all (--raw), where only this machine's CPU and disk count.
 *
 *   bun run bench                     # ~1 GB tree, 1/2/4/8 shards, both scenarios
 *   bun src/testing/bench-transfers.ts --size-mb 512 --mbps 25 --shards 1,4
 *
 * The tree is built once (about 40% incompressible assets, 30% mid-size binaries, 30%
 * source-like text) and kept under $TMPDIR for the next run.
 */
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { MAX_PARTS_IN_FLIGHT, partsInFlight } from "../multipart"
import { formatBytes, formatMs } from "../units"
import { startFakePlatform, TOKEN, type FakeVmd } from "./fake-vmd"
import { platformEnv, rssOf, spawnCli } from "./fixtures"
import { ThrottleProxy } from "./throttle-proxy"

const MiB = 1024 * 1024
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    tree: { type: "string" },
    "size-mb": { type: "string", default: "1024" },
    mbps: { type: "string", default: "40" },
    "unpack-mbps": { type: "string", default: "60" },
    "latency-ms": { type: "string", default: "30" },
    "part-mb": { type: "string", default: "64" },
    shards: { type: "string", default: "1,2,4,8" },
    "download-mb": { type: "string", default: "512" },
    raw: { type: "boolean", default: true },
  },
  allowNegative: true,
})
const sizeMb = Number(values["size-mb"])
const mbps = Number(values.mbps)
const unpackMbps = Number(values["unpack-mbps"])
const latencyMs = Number(values["latency-ms"])
const partSize = Number(values["part-mb"]) * MiB
const shardCounts = values.shards!.split(",").map(Number)
const downloadMb = Number(values["download-mb"])
const treeDir = values.tree ?? join(tmpdir(), `kyora-vms-bench-tree-${sizeMb}`)
const MB = 1_000_000

// ── the tree ─────────────────────────────────────────────────────────────────

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function textPool(bytes: number): Uint8Array {
  const random = prng(42)
  const words = ["fn", "let", "mut", "impl", "struct", "pub", "use", "self", "match", "Some", "None", "Ok", "Err", "return", "if", "else", "for", "in", "while", "async", "await", "const", "trait", "where", "mod", "type", "enum", "u64", "String", "Vec", "HashMap", "Option", "Result", "Arc"]
  const lines: string[] = []
  let length = 0
  while (length < bytes) {
    const indent = "    ".repeat(Math.floor(random() * 4))
    const count = 3 + Math.floor(random() * 9)
    const parts = Array.from({ length: count }, () => (random() < 0.35 ? `ident_${Math.floor(random() * 6000)}` : words[Math.floor(random() * words.length)]!))
    const line = `${indent}${parts.join(" ")};\n`
    lines.push(line)
    length += line.length
  }
  return new TextEncoder().encode(lines.join(""))
}

interface Manifest {
  files: number
  bytes: number
}

async function walk(dir: string): Promise<Manifest> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(dir, { recursive: true })) {
    const stats = await lstat(join(dir, entry))
    if (stats.isFile()) {
      files++
      bytes += stats.size
    }
  }
  return { files, bytes }
}

/** what the push must land, the marker file included (it goes up like any other) */
async function buildTree(dir: string): Promise<Manifest> {
  const marker = join(dir, ".kyora-bench.json")
  const want = JSON.stringify({ sizeMb, version: 1 })
  if ((await Bun.file(marker).exists()) && (await Bun.file(marker).text()) === want) return walk(dir)
  console.error(`building a ${sizeMb} MB tree in ${dir} …`)
  await rm(dir, { recursive: true, force: true })
  const random = prng(7)
  const budget = sizeMb * MiB
  const assets = Math.max(1, Math.round((budget * 0.4) / (48 * MiB)))
  await mkdir(join(dir, "assets"), { recursive: true })
  for (let i = 0; i < assets; i++) {
    const writer = Bun.file(join(dir, "assets", `asset-${String(i).padStart(2, "0")}.bin`)).writer()
    for (let written = 0; written < 48 * MiB; written += MiB) writer.write(randomBytes(MiB))
    await writer.end()
  }
  await mkdir(join(dir, "vendor"), { recursive: true })
  const libs = Math.round((budget * 0.3) / (2 * MiB))
  for (let i = 0; i < libs; i++) await Bun.write(join(dir, "vendor", `lib-${String(i).padStart(3, "0")}.a`), randomBytes(2 * MiB))
  const pool = textPool(4 * MiB)
  let text = 0
  for (let i = 0; text < budget * 0.3; i++) {
    const size = 4 * 1024 + Math.floor(random() * 56 * 1024)
    const start = Math.floor(random() * (pool.length - size))
    const path = join(dir, "src", `pkg-${String(i % 64).padStart(2, "0")}`, `mod-${String(i).padStart(5, "0")}.rs`)
    await Bun.write(path, pool.subarray(start, start + size), { createPath: true })
    text += size
  }
  await Bun.write(marker, want)
  return walk(dir)
}

// ── runs ─────────────────────────────────────────────────────────────────────

async function createSandbox(cloud: FakeVmd): Promise<string> {
  const response = await fetch(`${cloud.url}/v1/sandboxes`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" })
  return ((await response.json()) as { id: string }).id
}

async function destroySandbox(cloud: FakeVmd, id: string): Promise<void> {
  await fetch(`${cloud.url}/v1/sandboxes/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })
}

/** a process to completion, sampling its resident memory */
async function measured(cmd: string[], env: Record<string, string | undefined>): Promise<{ ms: number; peak: number; stdout: string; code: number }> {
  const started = performance.now()
  const proc = Bun.spawn({ cmd, env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>, stdout: "pipe", stderr: "inherit" })
  let peak = 0
  const sampler = setInterval(() => (peak = Math.max(peak, rssOf(proc.pid))), 25)
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearInterval(sampler)
  return { ms: performance.now() - started, peak, stdout, code }
}

interface Row {
  label: string
  ms: number
  raw: number
  sent: number
  parts: number
  shards: number
  peak: number
}

async function pushRow(cloud: FakeVmd, url: string, tree: Manifest, label: string, shards: number, partsInFlight?: number): Promise<Row> {
  const id = await createSandbox(cloud)
  const runner = join(import.meta.dir, "bench-push.ts")
  const run = await measured([process.execPath, "--no-env-file", runner, url, id, treeDir, String(shards), ...(partsInFlight ? [String(partsInFlight)] : [])], { ...process.env, KYORA_TOKEN: TOKEN })
  if (run.code !== 0) throw new Error(`push with ${shards} shard(s) failed`)
  const result = JSON.parse(run.stdout) as { raw: number; sent: number; parts: number; shards: number }
  const landed = await walk(cloud.work(id))
  if (landed.files !== tree.files || landed.bytes !== tree.bytes) throw new Error(`the sandbox got ${landed.files} files / ${landed.bytes} bytes, not ${tree.files} / ${tree.bytes}`)
  await destroySandbox(cloud, id)
  return { label, ms: run.ms, raw: result.raw, sent: result.sent, parts: result.parts, shards: result.shards, peak: run.peak }
}

async function downloadRow(cloud: FakeVmd, url: string, label: string, ranges: boolean): Promise<Row> {
  const id = await createSandbox(cloud)
  const file = join(cloud.work(id), "dl", "big.bin")
  await mkdir(join(cloud.work(id), "dl"), { recursive: true })
  const writer = Bun.file(file).writer()
  const hasher = new Bun.CryptoHasher("sha256")
  for (let written = 0; written < downloadMb * MiB; written += MiB) {
    const chunk = randomBytes(MiB)
    hasher.update(chunk)
    writer.write(chunk)
  }
  await writer.end()
  const expected = hasher.digest("hex")
  cloud.options.ranges = ranges
  const to = join(tmpdir(), `kyora-vms-bench-pull-${Date.now()}`)
  const cli = spawnCli(["pull", id, "dl/big.bin", "--to", to, "--json"], { cwd: tmpdir(), env: platformEnv(url) })
  const started = performance.now()
  let peak = 0
  const sampler = setInterval(() => (peak = Math.max(peak, rssOf(cli.proc.pid))), 25)
  const result = await cli.done
  clearInterval(sampler)
  const ms = performance.now() - started
  if (result.code !== 0) throw new Error(`pull failed: ${result.stderr}`)
  const [download] = JSON.parse(result.stdout).downloads as { bytes: number; ranged?: boolean }[]
  if ((download!.ranged ?? false) !== ranges) throw new Error(`expected ranged=${ranges}`)
  const got = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(join(to, "dl", "big.bin")).stream() as unknown as AsyncIterable<Uint8Array>) got.update(chunk)
  if (got.digest("hex") !== expected) throw new Error("the download does not match")
  await rm(to, { recursive: true, force: true })
  await destroySandbox(cloud, id)
  return { label, ms, raw: downloadMb * MiB, sent: download!.bytes, parts: ranges ? Math.ceil(download!.bytes / (16 * MiB)) : 1, shards: 1, peak }
}

function table(title: string, rows: Row[], parts: string): void {
  const base = rows[0]!.ms
  console.log(`\n${title}\n`)
  console.log(`| run | time | raw MB/s | on the wire | ${parts} | peak RSS | vs first row |`)
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const row of rows) {
    console.log(`| ${row.label} | ${formatMs(row.ms)} | ${Math.round(row.raw / MB / (row.ms / 1000))} | ${formatBytes(row.sent)} | ${row.parts} | ${Math.round(row.peak / MiB)} MiB | ${(base / row.ms).toFixed(2)}× |`)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const tree = await buildTree(treeDir)
console.log(`tree: ${tree.files.toLocaleString("en-US")} files, ${formatBytes(tree.bytes)} (${treeDir}); bun ${Bun.version}; ${Number(values["part-mb"])} MiB parts`)

const scenarios: { name: string; throttled: boolean }[] = [{ name: `edge-like: ${mbps} MB/s per connection each way, ${latencyMs} ms per request, unpack ${unpackMbps} MB/s per stream`, throttled: true }]
if (values.raw) scenarios.push({ name: "raw loopback: no caps (this machine's CPU and disk only)", throttled: false })

for (const scenario of scenarios) {
  const cloud = await startFakePlatform({
    partSize,
    storeDownloads: true,
    ...(scenario.throttled ? { latencyMs, unpackBytesPerSecond: unpackMbps * MB } : {}),
  })
  const proxy = scenario.throttled ? new ThrottleProxy(Number(new URL(cloud.url).port), mbps * MB) : null
  const url = proxy ? proxy.url : cloud.url
  try {
    const rows: Row[] = [await pushRow(cloud, url, tree, "before: 1 archive, 2 parts in flight", 1, 2)]
    const inFlight = partsInFlight(partSize)
    for (const shards of shardCounts) rows.push(await pushRow(cloud, url, tree, `${shards} shard${shards === 1 ? "" : "s"}, ${inFlight} parts in flight`, shards))
    const most = Math.max(...shardCounts)
    if (inFlight < MAX_PARTS_IN_FLIGHT) rows.push(await pushRow(cloud, url, tree, `${most} shards, ${MAX_PARTS_IN_FLIGHT} parts in flight`, most, MAX_PARTS_IN_FLIGHT))
    table(`push, ${scenario.name}`, rows, "parts")
    const downloads = [await downloadRow(cloud, url, "one stream", false), await downloadRow(cloud, url, "ranges, 4 × 16 MiB", true)]
    table(`download of ${downloadMb} MiB (incompressible), ${scenario.name}`, downloads, "requests")
  } finally {
    proxy?.stop()
    await cloud.stop()
  }
}
