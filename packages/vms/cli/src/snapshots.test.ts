import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { VmsClient } from "./api"
import { baseEnv, cli, tempDir } from "./testing/fixtures"

let root: string
let server: Server<unknown>
interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
const calls: Call[] = []

const SANDBOX_ID = "sb_0123456789abcdef"
const now = new Date().toISOString()
const makeSnapshot = (over: Record<string, unknown> = {}) => ({ id: "snap_1", kind: "fs", status: "ready", name: null, sandbox: SANDBOX_ID, bytes: 2048, logicalBytes: 4096, dataBytes: 2048, image: "base", resumable: false, createdAt: now, readyAt: now, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), ...over })
const makeSandbox = (over: Record<string, unknown> = {}) => ({ id: "sb_restored1", status: "running", network: "registries", vcpus: 4, memoryMb: 8192, diskGb: 30, expiresAt: null, createdAt: now, name: "restored", image: "base", ...over })

let snapshotPolls: number
let restorePolls: number
let snapshotOutcome: "ready" | "failed"
let creatingPolls: number
let restoreOutcome: "running" | "failed"
let snapshotError: { status: number; body: unknown } | null
let snapshotList: Array<Record<string, unknown>>
let sandboxesList: Array<Record<string, unknown>>
let missingSnapshots: Set<string>
let listPaging: boolean
let snapshotPaging: boolean
let endlessPaging: boolean
let busyPolls: number
let sandboxExtra: Record<string, unknown>
let busySnapshots: Set<string>

beforeEach(async () => {
  root = await tempDir("snapshots")
  calls.length = 0
  snapshotPolls = 0
  restorePolls = 0
  snapshotOutcome = "ready"
  creatingPolls = 1
  restoreOutcome = "running"
  snapshotError = null
  snapshotList = [makeSnapshot()]
  sandboxesList = []
  missingSnapshots = new Set()
  listPaging = false
  snapshotPaging = false
  endlessPaging = false
  busyPolls = 0
  sandboxExtra = {}
  busySnapshots = new Set()
  process.env.KYORA_VMS_POLL_MS = "1"
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const body = request.method === "POST" ? await request.json().catch(() => null) : null
    calls.push({ method: request.method, path, query: url.searchParams, body, headers: Object.fromEntries(request.headers.entries()) })
    if (request.method === "POST" && /^\/v1\/sandboxes\/[^/]+\/snapshots$/.test(path)) {
      if (snapshotError) return Response.json(snapshotError.body, { status: snapshotError.status, headers: { "retry-after": "5" } })
      return Response.json(makeSnapshot({ status: "creating", bytes: null, name: (body as { name?: string } | null)?.name ?? null, kind: (body as { kind?: string } | null)?.kind ?? "fs" }), { status: 202 })
    }
    if (request.method === "GET" && path === "/v1/snapshots") {
      if (endlessPaging) return Response.json({ snapshots: [makeSnapshot({ id: `snap_${url.searchParams.get("cursor") ?? "0"}` })], next_cursor: String(Number(url.searchParams.get("cursor") ?? 0) + 1) })
      if (snapshotPaging && !url.searchParams.get("cursor")) return Response.json({ snapshots: [makeSnapshot({ id: "snap_p1" })], next_cursor: "page2" })
      if (snapshotPaging) return Response.json({ snapshots: [makeSnapshot({ id: "snap_p2" })] })
      return Response.json({ snapshots: snapshotList })
    }
    if (request.method === "GET" && /^\/v1\/snapshots\/[^/]+$/.test(path)) {
      if (busyPolls > 0) {
        busyPolls--
        return Response.json({ error: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 5 }, { status: 429 })
      }
      snapshotPolls++
      if (snapshotOutcome === "failed") return Response.json(makeSnapshot({ status: "failed", error: "the disk exploded" }))
      return Response.json(makeSnapshot(snapshotPolls <= creatingPolls ? { status: "creating", bytes: null } : {}))
    }
    if (request.method === "DELETE" && /^\/v1\/snapshots\/[^/]+$/.test(path)) {
      if (busySnapshots.has(path.split("/").at(-1)!)) return Response.json({ error: "snapshot_busy", message: "it is being taken" }, { status: 409 })
      if (missingSnapshots.has(path.split("/").at(-1)!)) return Response.json({ error: "not_found", message: "no such snapshot" }, { status: 404 })
      return new Response(null, { status: 204 })
    }
    if (request.method === "POST" && path === "/v1/sandboxes") return Response.json(makeSandbox({ status: "starting", ...sandboxExtra }), { status: 202 })
    if (request.method === "GET" && path === "/v1/sandboxes") {
      if (listPaging && !url.searchParams.get("cursor")) return Response.json({ sandboxes: [makeSandbox({ id: "sb_page1", labels: { team: "a", env: "prod" } })], next_cursor: "page2" })
      if (listPaging) return Response.json({ sandboxes: [makeSandbox({ id: "sb_page2", labels: { team: "a", env: "prod" } })] })
      return Response.json({ sandboxes: sandboxesList })
    }
    if (request.method === "GET" && /^\/v1\/sandboxes\/[^/]+\/tty\/sessions$/.test(path)) return Response.json({ sessions: [] })
    if (request.method === "POST" && /^\/v1\/sandboxes\/[^/]+\/ports$/.test(path)) return Response.json({ label: "my-app", port: (body as { port: number }).port, private: !(body as { public?: boolean }).public, url: "https://my-app.kyora.run" }, { status: 201 })
    if (request.method === "GET" && (/^\/v1\/sandboxes\/[^/]+\/ports$/.test(path) || path === "/v1/ports")) return Response.json({ ports: [{ label: "my-app", port: 3000, private: true, url: "https://my-app.kyora.run" }] })
    if (request.method === "DELETE" && (/^\/v1\/sandboxes\/[^/]+\/ports\/[^/]+$/.test(path) || /^\/v1\/ports\/[^/]+$/.test(path))) return new Response(null, { status: 204 })
    if (request.method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(path)) {
      restorePolls++
      if (restoreOutcome === "failed") return Response.json(makeSandbox({ status: "failed" }))
      return Response.json(makeSandbox({ ...(restorePolls <= 1 ? { status: "starting" } : {}), ...sandboxExtra }))
    }
    if (request.method === "DELETE" && /^\/v1\/sandboxes\/[^/]+$/.test(path)) return new Response(null, { status: 204 })
    return Response.json({ error: "not_found", message: `no route ${request.method} ${path}` }, { status: 404 })
  } })
})
afterEach(async () => { server.stop(true); delete process.env.KYORA_VMS_POLL_MS; await rm(root, { recursive: true, force: true }) })
const run = (args: string[]) => cli(args, { cwd: root, env: baseEnv(server.url.toString(), { HOME: root, KYORA_VMS_POLL_MS: "1" }) })
const client = () => new VmsClient({ url: server.url.toString(), key: "kvms_test" })

test("snapshot posts no kind by default and polls until ready, printing only the id", async () => {
  const result = await run(["snapshot", SANDBOX_ID])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("snap_1\n")
  expect(result.stderr).toContain("snap_1")
  const post = calls.find((call) => call.method === "POST")!
  expect(post.path).toBe(`/v1/sandboxes/${SANDBOX_ID}/snapshots`)
  expect(post.body).toEqual({})
  expect(calls.filter((call) => call.method === "GET" && call.path === "/v1/snapshots/snap_1").length).toBeGreaterThan(0)
})

test("snapshot --full --name --ttl sends kind, name and ttlDays; a partial day is a usage error", async () => {
  const result = await run(["snapshot", SANDBOX_ID, "--full", "--name", "n", "--ttl", "7d"])
  expect(result.code).toBe(0)
  expect(calls.find((call) => call.method === "POST")!.body).toEqual({ kind: "full", name: "n", ttlDays: 7 })
  calls.length = 0
  const bad = await run(["snapshot", SANDBOX_ID, "--ttl", "36h"])
  expect(bad.code).not.toBe(0)
  expect(bad.stderr).toContain("--ttl")
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
})

test("snapshot --no-wait does not poll and --json prints the snapshot", async () => {
  const noWait = await run(["snapshot", SANDBOX_ID, "--no-wait"])
  expect(noWait.code).toBe(0)
  expect(noWait.stdout).toBe("snap_1\n")
  expect(noWait.stderr).toContain("kyora vms snapshot show snap_1")
  expect(calls.filter((call) => call.method === "GET")).toHaveLength(0)
  const json = await run(["snapshot", SANDBOX_ID, "--json"])
  expect(json.code).toBe(0)
  expect(JSON.parse(json.stdout).id).toBe("snap_1")
  expect(JSON.parse(json.stdout).status).toBe("ready")
})

test("a failed snapshot and a refused full snapshot exit non-zero with the server text", async () => {
  snapshotOutcome = "failed"
  const failed = await run(["snapshot", SANDBOX_ID])
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain("the disk exploded")
  snapshotOutcome = "ready"
  snapshotError = { status: 403, body: { error: "full_snapshots_not_allowed", message: "full snapshots are not allowed for this account" } }
  const refused = await run(["snapshot", SANDBOX_ID, "--full"])
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("full snapshots are not allowed for this account")
})

test("snapshot ls and snapshots never print the machine a snapshot is on", async () => {
  snapshotList = [makeSnapshot({ node: "machine-x" })]
  for (const args of [["snapshot", "ls"], ["snapshots"], ["snapshots", "ls"]]) {
    const result = await run(args)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("snap_1")
    expect(result.stdout).not.toContain("machine-x")
    expect(result.stderr).not.toContain("machine-x")
  }
  const json = await run(["snapshot", "ls", "--json"])
  expect(JSON.parse(json.stdout).snapshots[0].id).toBe("snap_1")
})

test("snapshot show prints fields and snapshot rm reports a missing one with exit 1", async () => {
  const shown = await run(["snapshot", "show", "snap_1"])
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("id: snap_1")
  expect(shown.stdout).toContain("kind: fs")
  missingSnapshots = new Set(["snap_b"])
  const removed = await run(["snapshot", "rm", "snap_a", "snap_b", "--json"])
  expect(removed.code).toBe(1)
  expect(JSON.parse(removed.stdout)).toEqual({ deleted: ["snap_a"], missing: ["snap_b"] })
  expect(removed.stderr).toContain("snap_b")
})

test("restore resolves a snapshot by name, posts the create spec and polls until running", async () => {
  snapshotList = [makeSnapshot({ id: "snap_x", name: "my-snap" })]
  const result = await run(["restore", "my-snap", "--size", "m", "--name", "r1"])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("sb_restored1\n")
  const post = calls.find((call) => call.method === "POST" && call.path === "/v1/sandboxes")!
  expect(post.body).toMatchObject({ fromSnapshot: "snap_x", name: "r1", vcpus: 4, memoryMb: 8192 })
  expect(calls.some((call) => call.method === "GET" && call.path === "/v1/sandboxes/sb_restored1")).toBe(true)
})

test("restore --no-resume, --image and a failed restore", async () => {
  const noResume = await run(["restore", "snap_x", "--no-resume"])
  expect(noResume.code).toBe(0)
  expect(calls.find((call) => call.method === "POST" && call.path === "/v1/sandboxes")!.body).toMatchObject({ fromSnapshot: "snap_x", resume: false })
  calls.length = 0
  const image = await run(["restore", "snap_x", "--image", "x"])
  expect(image.code).not.toBe(0)
  expect(image.stderr).toContain("restore boots the snapshot's image")
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
  restoreOutcome = "failed"
  const failed = await run(["restore", "snap_x"])
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain("restore of snap_x into sb_restored1 failed")
})

test("an ambiguous snapshot name is a usage error listing the ids", async () => {
  snapshotList = [makeSnapshot({ id: "snap_1", name: "dup" }), makeSnapshot({ id: "snap_2", name: "dup" })]
  const result = await run(["restore", "dup"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("snap_1")
  expect(result.stderr).toContain("snap_2")
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
  const missing = await run(["snapshot", "show", "nope"])
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("no snapshot named nope")
})

test("ls --label sends both labels and filters; a bad label is a usage error", async () => {
  sandboxesList = [
    makeSandbox({ id: "sb_match1", name: "match", labels: { team: "a", env: "prod" } }),
    makeSandbox({ id: "sb_other1", name: "other", labels: { team: "a", env: "dev" } }),
  ]
  const result = await run(["ls", "--label", "team=a", "--label", "env=prod"])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("match")
  expect(result.stdout).not.toContain("other")
  const list = calls.find((call) => call.method === "GET" && call.path === "/v1/sandboxes")!
  expect(list.query.getAll("label")).toEqual(["team=a", "env=prod"])
  calls.length = 0
  const bad = await run(["ls", "--label", "bad"])
  expect(bad.code).not.toBe(0)
  expect(bad.stderr).toContain("--label takes key=value")
  expect(calls.filter((call) => call.path === "/v1/sandboxes")).toHaveLength(0)
  const positional = await run(["ls", "match", "--label", "team=a"])
  expect(positional.code).not.toBe(0)
})

test("client list labels, paging, ports and the snapshot idempotency header", async () => {
  sandboxesList = [
    makeSandbox({ id: "sb_match1", labels: { team: "a", env: "prod" } }),
    makeSandbox({ id: "sb_other1", labels: { team: "a" } }),
    makeSandbox({ id: "sb_none11", labels: {} }),
  ]
  const api = client()
  const filtered = await api.list({ labels: { team: "a", env: "prod" } })
  expect(filtered.map((sandbox) => sandbox.id)).toEqual(["sb_match1"])
  expect(calls.at(-1)!.query.getAll("label")).toEqual(["team=a", "env=prod"])
  calls.length = 0
  await api.list()
  expect(calls.at(-1)!.query.toString()).toBe("")
  listPaging = true
  expect((await api.list()).map((sandbox) => sandbox.id)).toEqual(["sb_page1", "sb_page2"])
  listPaging = false
  snapshotPaging = true
  expect((await api.snapshots()).map((snapshot) => snapshot.id)).toEqual(["snap_p1", "snap_p2"])
  snapshotPaging = false
  calls.length = 0
  const exposure = await api.expose("sb_test", 3000, { name: "my-app", public: true })
  expect(exposure.url).toBe("https://my-app.kyora.run")
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/sandboxes/sb_test/ports", body: { port: 3000, name: "my-app", public: true } })
  expect((await api.ports("sb_test"))[0]!.label).toBe("my-app")
  expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/sandboxes/sb_test/ports" })
  expect((await api.ports())[0]!.label).toBe("my-app")
  expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/ports" })
  await api.unexpose("sb_test", "my-app")
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/sandboxes/sb_test/ports/my-app" })
  await api.releaseName("my-app")
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/ports/my-app" })
  calls.length = 0
  creatingPolls = 0
  const snapshot = await api.snapshot(SANDBOX_ID, { idempotencyKey: "k" })
  expect(snapshot.status).toBe("ready")
  expect(calls.find((call) => call.method === "POST")!.headers["idempotency-key"]).toBe("k")
})

test("a 429 body's retryAfterMs wins over the whole-second Retry-After header", async () => {
  snapshotError = { status: 429, body: { error: "snapshot_quota", message: "too many snapshots", retryable: true, retryAfterMs: 1_250 } }
  const error = await client().snapshot(SANDBOX_ID).catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: "snapshot_quota", status: 429, retryAfterMs: 1_250 })
})

test("a rate-limited poll waits and asks again instead of failing the snapshot", async () => {
  busyPolls = 2
  const result = await run(["snapshot", SANDBOX_ID])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("snap_1\n")
})

test("restore names the region, never the machine", async () => {
  sandboxExtra = { node: "machine-x", region: "eu" }
  const result = await run(["restore", "snap_x"])
  expect(result.code).toBe(0)
  expect(result.stderr).toContain("eu")
  expect(result.stderr).not.toContain("machine-x")
})

test("snapshot rm resolves every name before it deletes anything", async () => {
  const result = await run(["snapshot", "rm", "snap_a", "no-such-name", "--json"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("no snapshot named no-such-name")
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
})

test("ls --label refuses a key given twice", async () => {
  const result = await run(["ls", "--label", "team=a", "--label", "team=b"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("--label team is given twice")
})

test("a listing that never stops paging fails instead of passing off a partial list", async () => {
  endlessPaging = true
  const error = await client().snapshots().catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: "too_many_pages" })
  expect(calls.filter((call) => call.path === "/v1/snapshots")).toHaveLength(100)
})

test("a snapshot quota or refusal points at snapshots, never at sandboxes", async () => {
  for (const code of ["snapshot_quota", "quota_exceeded"]) {
    snapshotError = { status: 429, body: { error: code, message: "you have 3 snapshots" } }
    const result = await run(["snapshot", SANDBOX_ID])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("kyora vms snapshot rm <snap>")
    expect(result.stderr).not.toContain("concurrent sandboxes")
  }
  snapshotError = { status: 403, body: { error: "full_snapshots_not_allowed", message: "no full snapshots" } }
  const full = await run(["snapshot", SANDBOX_ID, "--full"])
  expect(full.stderr).toContain("leave out --full")
  expect(full.stderr).not.toContain("--network open")
})

test("a restore that fails after the create destroys its sandbox", async () => {
  restoreOutcome = "failed"
  const result = await run(["restore", "snap_x"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("sb_restored1 was destroyed")
  expect(calls.some((call) => call.method === "DELETE" && call.path === "/v1/sandboxes/sb_restored1")).toBe(true)
})

test("the client destroys a restore it was told to stop, and never creates one when told before", async () => {
  const before = new AbortController()
  before.abort()
  await expect(client().restore("snap_x", {}, { signal: before.signal })).rejects.toBeDefined()
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
  const during = new AbortController()
  await expect(client().restore("snap_x", {}, { signal: during.signal, onProgress: () => during.abort() })).rejects.toBeDefined()
  expect(calls.some((call) => call.method === "DELETE" && call.path === "/v1/sandboxes/sb_restored1")).toBe(true)
})

test("snapshot rm keeps going past a refusal and reports it", async () => {
  busySnapshots = new Set(["snap_busy"])
  const result = await run(["snapshot", "rm", "snap_a", "snap_busy", "snap_c", "--json"])
  expect(result.code).toBe(1)
  const report = JSON.parse(result.stdout)
  expect(report.deleted).toEqual(["snap_a", "snap_c"])
  expect(report.missing).toEqual([])
  expect(report.failed[0].id).toBe("snap_busy")
})

test("ls --label __proto__=x is sent as a label, not dropped", async () => {
  sandboxesList = [makeSandbox({ id: "sb_plain11", name: "plain", labels: {} })]
  const result = await run(["ls", "--label", "__proto__=x"])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain("plain")
  expect(calls.find((call) => call.path === "/v1/sandboxes")!.query.getAll("label")).toEqual(["__proto__=x"])
})
