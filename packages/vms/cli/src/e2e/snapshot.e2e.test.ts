/**
 * End to end against a real kyora cloud: snapshots survive a destroy and come back where they left off.
 * It runs only with KYORA_E2E=1 (skipped otherwise), against whatever your own `loadConfig()` points at:
 *
 *   KYORA_E2E=1 bun test src/e2e/snapshot.e2e.test.ts                       # region eu
 *   KYORA_E2E=1 KYORA_E2E_REGION=us bun test src/e2e/snapshot.e2e.test.ts   # any region the cloud has
 *
 * Each case creates its own sandbox (network none, 15 min TTL) and snapshot (1 day TTL), times and logs every
 * phase, and deletes both in a `finally`; `afterAll` and SIGINT/SIGTERM sweep anything a timed-out case left.
 *   1. full: a process holding a random value in memory, counting once a second, is the same process with the
 *      same value after a full snapshot, a destroy and a restore, and is still counting.
 *   2. fs: the files come back, the processes don't.
 *   3. clock: right after a full restore the guest's clock is within 1 s of the real time again (the clock step).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ApiError, VmsClient, type Sandbox } from "../api"
import { loadConfig } from "../config"
import { collectExec } from "../exec"
import { formatBytes, formatMs } from "../units"

const ENABLED = process.env.KYORA_E2E === "1"
const REGION = process.env.KYORA_E2E_REGION?.trim() || "eu"
const SANDBOX_TTL_SECONDS = 900
const SNAPSHOT_TTL_DAYS = 1
const CASE_TIMEOUT_MS = 15 * 60_000
const QUEUE_WAIT_SECONDS = 120
const RUNNING_DEADLINE_MS = 5 * 60_000
const SNAPSHOT_DEADLINE_MS = 6 * 60_000
const CLOCK_TOLERANCE_MS = 1_000

interface Snapshot {
  id: string
  kind: string
  status: string
  bytes?: number
  logicalBytes?: number
  error?: string
}

let client: VmsClient
const sandboxes = new Set<string>()
const snapshots = new Set<string>()
const summaries: string[] = []
let closing = false

const log = (line: string) => console.log(`[e2e ${REGION}] ${line}`)
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** the timed phases of one case, logged as they finish and summed up at the end */
class Phases {
  private readonly rows: string[] = []
  private readonly started = performance.now()
  constructor(private readonly name: string) {}

  async run<T>(phase: string, work: () => Promise<T>, detail?: (value: T) => string): Promise<T> {
    const start = performance.now()
    try {
      const value = await work()
      const took = formatMs(performance.now() - start)
      const extra = detail ? ` (${detail(value)})` : ""
      this.rows.push(`${phase} ${took}${extra}`)
      log(`${this.name}: ${phase} ${took}${extra}`)
      return value
    } catch (error) {
      log(`${this.name}: ${phase} FAILED after ${formatMs(performance.now() - start)}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  done(): void {
    const line = `${this.name}: ${this.rows.join(" · ")} · total ${formatMs(performance.now() - this.started)}`
    summaries.push(line)
    log(line)
  }
}

/** a sandbox or snapshot made after the sweep began (a timed-out case still going) goes at once */
function trackSandbox(id: string): void {
  sandboxes.add(id)
  if (closing) void dropSandbox(id)
}

function trackSnapshot(id: string): void {
  snapshots.add(id)
  if (closing) void dropSnapshot(id)
}

async function dropSandbox(id: string): Promise<void> {
  try {
    await client.destroy(id)
    sandboxes.delete(id)
  } catch (error) {
    log(`cleanup: could not destroy sandbox ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** a snapshot still `creating` can't be deleted yet (409 snapshot_busy): wait for it to end, then delete it */
async function dropSnapshot(id: string): Promise<void> {
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS
  for (;;) {
    try {
      await client.call("delete snapshot", "DELETE", `/v1/snapshots/${encodeURIComponent(id)}`, { timeout: 30_000 })
      snapshots.delete(id)
      return
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        snapshots.delete(id)
        return
      }
      const busy = error instanceof ApiError && error.status === 409
      if (!busy || Date.now() > deadline) {
        log(`cleanup: could not delete snapshot ${id}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      await Bun.sleep(2_000)
    }
  }
}

async function sweep(): Promise<void> {
  closing = true
  await Promise.all([...sandboxes].map(dropSandbox))
  await Promise.all([...snapshots].map(dropSnapshot))
}

/** a sandbox in REGION, tracked for cleanup, once it is running */
async function create(spec: Parameters<VmsClient["create"]>[0]): Promise<Sandbox> {
  const created = await client.create({ ttlSeconds: SANDBOX_TTL_SECONDS, labels: { e2e: "snapshot" }, region: REGION, ...spec }, { wait: QUEUE_WAIT_SECONDS })
  trackSandbox(created.id)
  return created.status === "running" ? created : waitRunning(created.id)
}

/** a restore answers `starting` at once; a failed one turns into a 404 with the reason */
async function waitRunning(id: string): Promise<Sandbox> {
  const deadline = Date.now() + RUNNING_DEADLINE_MS
  for (;;) {
    const sandbox = await client.get(id)
    if (sandbox.status === "running") return sandbox
    if (sandbox.status !== "starting" && sandbox.status !== "queued") throw new Error(`sandbox ${id} is ${sandbox.status}, not running`)
    if (Date.now() > deadline) throw new Error(`sandbox ${id} still ${sandbox.status} after ${formatMs(RUNNING_DEADLINE_MS)}`)
    await Bun.sleep(500)
  }
}

async function destroy(id: string): Promise<void> {
  await client.destroy(id)
  sandboxes.delete(id)
}

/** `bash -lc script` as the sandbox user; fails the case on a non-zero exit */
async function sh(id: string, script: string, timeoutSeconds = 60): Promise<string> {
  const outcome = await collectExec(await client.exec(id, { cmd: ["bash", "-lc", script], timeoutSeconds }))
  client.execExited(id)
  if (outcome.code !== 0 || outcome.error) {
    throw new Error(`exec in ${id} exited ${outcome.code}${outcome.error ? ` (${outcome.error})` : ""}: ${outcome.stderr.trim().slice(-400)}`)
  }
  return outcome.stdout
}

/** POST …/snapshots, then GET /v1/snapshots/:id until it is ready */
async function snapshot(sandboxId: string, kind: "full" | "fs"): Promise<Snapshot> {
  const started = await client.call<Snapshot>(`snapshot ${sandboxId}`, "POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, {
    json: { kind, name: `e2e-${kind}-${tag()}`, ttlDays: SNAPSHOT_TTL_DAYS },
  })
  trackSnapshot(started.id)
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS
  let shown = started
  while (shown.status === "creating") {
    if (Date.now() > deadline) throw new Error(`snapshot ${started.id} still creating after ${formatMs(SNAPSHOT_DEADLINE_MS)}`)
    await Bun.sleep(1_000)
    shown = await client.call<Snapshot>(`get snapshot ${started.id}`, "GET", `/v1/snapshots/${encodeURIComponent(started.id)}`, { timeout: 30_000 })
  }
  if (shown.status !== "ready") throw new Error(`snapshot ${started.id} ended ${shown.status}${shown.error ? `: ${shown.error}` : ""}`)
  return shown
}

const snapshotDetail = (shown: Snapshot) => `${shown.id}, ${formatBytes(shown.bytes ?? 0)} stored`

/** restore a snapshot as a new sandbox, tracked, once it is running */
function restore(snapshotId: string, name: string): Promise<Sandbox> {
  return create({ name, fromSnapshot: snapshotId })
}

const placed = (sandbox: Sandbox) => `${sandbox.id} on ${sandbox.node ?? "?"} in ${sandbox.region ?? "?"}`

/** removes the case's own sandboxes and snapshot whatever happened; the sweep is the backstop */
async function cleanup(ids: string[], snapshotId?: string): Promise<void> {
  await Promise.all(ids.filter((id) => sandboxes.has(id)).map(dropSandbox))
  if (snapshotId && snapshots.has(snapshotId)) await dropSnapshot(snapshotId)
}

// a counter whose value lives only in its memory: it appends `<value> <count>` once a second; MARKER in its argv
// tells it apart from whatever process a fresh boot gives the same pid
const COUNTER = `import os, random, sys, time
value = random.randrange(10**12)
with open("/tmp/e2e-counter.pid", "w") as f: f.write(f"{os.getpid()}\\n")
count = 0
while True:
    count += 1
    with open("/tmp/e2e-counter.log", "a") as f: f.write(f"{value} {count}\\n")
    time.sleep(1)
`

async function startCounter(id: string, marker: string): Promise<void> {
  await sh(id, `cat > /tmp/e2e-counter.py <<'PY'\n${COUNTER}PY\nsetsid nohup python3 /tmp/e2e-counter.py ${marker} >/dev/null 2>&1 </dev/null &\nfor i in $(seq 50); do [ -s /tmp/e2e-counter.log ] && break; sleep 0.1; done\nsleep 2`)
}

interface Counter {
  pid: string
  value: string
  count: number
  alive: boolean
}

async function counter(id: string, marker: string): Promise<Counter> {
  const out = await sh(id, `pid=$(cat /tmp/e2e-counter.pid 2>/dev/null)
last=$(tail -n 1 /tmp/e2e-counter.log 2>/dev/null)
alive=dead
[ -n "$pid" ] && tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q -- ${marker} && alive=alive
echo "$pid|$last|$alive"`)
  const [pid = "", last = "", alive = ""] = out.trim().split("|")
  const [value = "", count = "0"] = last.split(" ")
  return { pid, value, count: Number(count), alive: alive === "alive" }
}

const showCounter = (c: Counter) => `pid ${c.pid || "-"}, value ${c.value || "-"}, count ${c.count}, ${c.alive ? "alive" : "not running"}`

/**
 * How far the guest's clock is from ours: `date` runs somewhere between our two readings, so a right clock reads
 * inside that window and the offset is how far outside it the guest reads. The best of a few samples.
 */
async function clockOffset(id: string): Promise<{ offsetMs: number; windowMs: number }> {
  let best = { offsetMs: Number.POSITIVE_INFINITY, windowMs: 0 }
  for (let i = 0; i < 3; i++) {
    const before = Date.now()
    const guest = Number((await sh(id, "date +%s%3N")).trim())
    const after = Date.now()
    const offsetMs = guest < before ? guest - before : guest > after ? guest - after : 0
    if (Math.abs(offsetMs) < Math.abs(best.offsetMs)) best = { offsetMs, windowMs: after - before }
  }
  return best
}

const signed = (ms: number) => `${ms >= 0 ? "+" : "-"}${formatMs(Math.abs(ms))}`

describe.skipIf(!ENABLED)(`snapshots end to end (region ${REGION})`, () => {
  const onSignal = (signal: string) => {
    log(`${signal}: cleaning up`)
    void sweep().finally(() => process.exit(130))
  }

  beforeAll(async () => {
    const env = (globalThis as Record<symbol, unknown>)[Symbol.for("kyora.e2e.env")] as Record<string, string | undefined> | undefined
    if (!env) throw new Error("run from packages/vms/cli with KYORA_E2E=1 set, so the test preload keeps your config")
    const config = await loadConfig(env)
    if (!config.key) throw new Error(`no key for ${config.url}: log in with \`kyora vms login\` or set KYORA_VMS_KEY`)
    client = new VmsClient(config)
    if ((await client.kind()) !== "platform") throw new Error(`${config.url} is a single kyora-vmd: these tests need kyora cloud`)
    log(`against ${config.url} (key from ${config.keySource ?? "?"})`)
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  })

  afterAll(async () => {
    if (client) await sweep()
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    log(`cleaned up${sandboxes.size || snapshots.size ? `, LEFT OVER: ${[...sandboxes, ...snapshots].join(" ")}` : ""}`)
    if (summaries.length) log(`timings:\n${summaries.map((line) => `  ${line}`).join("\n")}`)
  })

  test(
    "full: the same process, with the same memory, still counting after snapshot, destroy and restore",
    async () => {
      const phases = new Phases("full")
      const marker = `e2e-${tag()}`
      const ids: string[] = []
      let snapshotId: string | undefined
      try {
        const original = await phases.run("create", () => create({ name: `e2e-full-${tag()}`, network: "none" }), placed)
        ids.push(original.id)
        if (original.region) expect(original.region).toBe(REGION)
        const before = await phases.run("start process", async () => {
          await startCounter(original.id, marker)
          return counter(original.id, marker)
        }, showCounter)
        expect(before.alive).toBe(true)

        const shown = await phases.run("snapshot", () => snapshot(original.id, "full"), snapshotDetail)
        snapshotId = shown.id
        await phases.run("destroy original", () => destroy(original.id))

        const restored = await phases.run("restore", () => restore(shown.id, `e2e-full-r-${tag()}`), placed)
        ids.push(restored.id)
        const after = await phases.run("first exec", () => counter(restored.id, marker), showCounter)
        await Bun.sleep(2_000)
        const later = await counter(restored.id, marker)
        log(`full: 2 s later ${showCounter(later)}`)

        expect(after.pid).toBe(before.pid)
        expect(after.value).toBe(before.value)
        expect(after.alive).toBe(true)
        expect(after.count).toBeGreaterThan(before.count)
        expect(later.value).toBe(before.value)
        expect(later.count).toBeGreaterThan(after.count)
        phases.done()
      } finally {
        await cleanup(ids, snapshotId)
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "fs: the files come back, the processes don't",
    async () => {
      const phases = new Phases("fs")
      const marker = `e2e-${tag()}`
      const value = crypto.randomUUID()
      const ids: string[] = []
      let snapshotId: string | undefined
      // /work, $HOME (/work/.home) and /tmp are all on the scratch disk an fs snapshot saves
      const files = ["/work/e2e/value", "$HOME/e2e-value", "/tmp/e2e-value"]
      try {
        const original = await phases.run("create", () => create({ name: `e2e-fs-${tag()}`, network: "none" }), placed)
        ids.push(original.id)
        if (original.region) expect(original.region).toBe(REGION)
        await phases.run("write files, start process", async () => {
          await sh(original.id, `mkdir -p /work/e2e && for f in ${files.join(" ")}; do echo ${value} > "$f"; done && sync`)
          await startCounter(original.id, marker)
        })
        const before = await counter(original.id, marker)
        expect(before.alive).toBe(true)

        const shown = await phases.run("snapshot", () => snapshot(original.id, "fs"), snapshotDetail)
        snapshotId = shown.id
        await phases.run("destroy original", () => destroy(original.id))

        const restored = await phases.run("restore", () => restore(shown.id, `e2e-fs-r-${tag()}`), placed)
        ids.push(restored.id)
        const read = await phases.run("first exec", () => sh(restored.id, `for f in ${files.join(" ")}; do cat "$f" 2>/dev/null || echo missing; done`))
        const after = await counter(restored.id, marker)
        log(`fs: after the restore ${showCounter(after)}; files: ${read.trim().split("\n").join(" ")}`)

        expect(read.trim().split("\n")).toEqual(files.map(() => value))
        // the pid file and the log are files, so they are there; the process they name is not
        expect(after.pid).toBe(before.pid)
        expect(after.alive).toBe(false)
        // [e]2e-… matches the counter's argv but not this bash's own command line
        expect((await sh(restored.id, `grep -ls -- '[${marker[0]}]${marker.slice(1)}' /proc/[0-9]*/cmdline || true`)).trim()).toBe("")
        phases.done()
      } finally {
        await cleanup(ids, snapshotId)
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    `clock: the guest's clock is within ${CLOCK_TOLERANCE_MS} ms of ours right after a full restore`,
    async () => {
      const phases = new Phases("clock")
      const ids: string[] = []
      let snapshotId: string | undefined
      try {
        const original = await phases.run("create", () => create({ name: `e2e-clock-${tag()}`, network: "none" }), placed)
        ids.push(original.id)
        const baseline = await clockOffset(original.id)
        log(`clock: before the snapshot the guest is ${signed(baseline.offsetMs)} off (window ${formatMs(baseline.windowMs)})`)

        const taken = Date.now()
        const shown = await phases.run("snapshot", () => snapshot(original.id, "full"), snapshotDetail)
        snapshotId = shown.id
        await phases.run("destroy original", () => destroy(original.id))
        // the restored memory's clock stopped at the dump: without the step it would be at least this far behind
        const gap = Date.now() - taken
        if (gap < 5_000) await Bun.sleep(5_000 - gap)

        const restored = await phases.run("restore", () => restore(shown.id, `e2e-clock-r-${tag()}`), placed)
        ids.push(restored.id)
        const after = await phases.run("clock check", () => clockOffset(restored.id), (o) => `${signed(o.offsetMs)} off, window ${formatMs(o.windowMs)}`)
        log(`clock: ${formatMs(Date.now() - taken)} between snapshot and check; guest ${signed(after.offsetMs)} off (before: ${signed(baseline.offsetMs)})`)

        expect(Math.abs(after.offsetMs)).toBeLessThanOrEqual(CLOCK_TOLERANCE_MS)
        phases.done()
      } finally {
        await cleanup(ids, snapshotId)
      }
    },
    CASE_TIMEOUT_MS,
  )
})
