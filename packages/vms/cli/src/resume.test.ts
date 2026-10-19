import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { startCutProxy } from "./testing/cut-proxy"
import { KEY, TOKEN, startFakePlatform, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { alive, baseEnv, cli, ENTRY, makeRepo, platformEnv, tempDir, transcripts, waitFor, write } from "./testing/fixtures"
import { formatBytes } from "./units"

// real processes over real HTTP, with streams cut and reattached on the way
setDefaultTimeout(40_000)

let root: string

beforeEach(async () => {
  root = await tempDir("resume")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  for (const text of transcripts) for (const secret of [KEY, TOKEN]) expect(text).not.toContain(secret)
})

/** quick retries, so a test sees many of them */
const FAST = { KYORA_VMS_REATTACH_BASE_MS: "40", KYORA_VMS_REATTACH_WINDOW_MS: "20000" }

/**
 * Output with every kind of byte on both streams, written a line at a time (each write one
 * syscall, so a pipe never splits one) over about a second: stdout lines with a multi-byte
 * character, a line that isn't UTF-8, stderr every few lines, and an exit code of its own.
 */
const SCRIPT = [
  "i=0",
  "while [ $i -lt 240 ]; do",
  "  printf 'out %04d caf\\303\\251 %s\\n' $i 0123456789abcdef0123456789abcdef0123456789abcdef",
  "  if [ $((i % 9)) -eq 0 ]; then echo \"err $i\" >&2; fi",
  "  if [ $((i % 40)) -eq 0 ]; then printf 'raw \\377\\376 %d\\n' $i; sleep 0.1; fi",
  "  i=$((i+1))",
  "done",
  "exit 3",
].join("\n")

/** what the command writes, run here */
function expected(script: string): { stdout: Buffer; stderr: Buffer } {
  const result = Bun.spawnSync(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" })
  return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) }
}

interface RawResult {
  code: number
  stdout: Buffer
  stderr: string
  /** stderr without kyora-vms's own lines: the command's bytes */
  remoteStderr: Buffer
}

/** the CLI with its output as bytes (the fixtures decode text, which would hide a byte out of place) */
function spawnRaw(args: string[], env: Record<string, string | undefined>, cwd = root) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", ENTRY, ...args],
    cwd,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  const collect = async (stream: ReadableStream<Uint8Array>, into: Buffer[]) => {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) into.push(Buffer.from(chunk))
  }
  const reading = Promise.all([collect(proc.stdout, chunks), collect(proc.stderr, errors)])
  const done = (async (): Promise<RawResult> => {
    const [code] = await Promise.all([proc.exited, reading])
    const stderr = Buffer.concat(errors)
    const text = stderr.toString("latin1")
    transcripts.push(Buffer.concat(chunks).toString("latin1"), text)
    const remote = text
      .split(/(?<=\n)/)
      .filter((line) => !line.startsWith("[kyora-vms] "))
      .join("")
    return { code, stdout: Buffer.concat(chunks), stderr: stderr.toString("utf8"), remoteStderr: Buffer.from(remote, "latin1") }
  })()
  return { proc, done, stdout: () => Buffer.concat(chunks).toString("utf8") }
}

const reconnects = (stderr: string) => stderr.split("\n").filter((line) => line === "[kyora-vms] reconnecting…").length

for (const kind of ["vmd", "platform"] as const) {
  describe(`reattaching (${kind === "vmd" ? "a kyora-vmd" : "kyora cloud"})`, () => {
    let server: FakeVmd
    const env = (extra: Record<string, string | undefined> = {}) => (kind === "vmd" ? baseEnv(server.url, { ...FAST, ...extra }) : platformEnv(server.url, { ...FAST, ...extra }))

    beforeEach(async () => {
      server = kind === "vmd" ? await startFakeVmd() : await startFakePlatform()
    })

    afterEach(async () => {
      await server.stop()
    })

    test("two execs in one sandbox return their own output and exit", async () => {
      const id = (await cli(["create"], { cwd: root, env: env() })).stdout.trim()
      const a = spawnRaw(["exec", id, "--", "sh", "-c", "echo alpha; sleep 0.5; exit 3"], env())
      await waitFor(() => a.stdout().includes("alpha"), 5000, "first output")
      const b = spawnRaw(["exec", id, "--", "sh", "-c", "echo beta; sleep 0.1; exit 7"], env())
      const [first, second] = await Promise.all([a.done, b.done])
      expect(first).toMatchObject({ code: 3, stdout: Buffer.from("alpha\n") })
      expect(second).toMatchObject({ code: 7, stdout: Buffer.from("beta\n") })
      expect(server.execs).toHaveLength(2)
    })

    test("a long command whose stream is cut three times: every byte once, in order, and its own exit code", async () => {
      server.options.cutAfter = [2_000, 6_000, 3_000]
      // the cloud's cuts are dropped connections, the kyora-vmd's clean ends mid-line: both are breaks
      server.options.cutMode = kind === "platform" ? "reset" : "end"
      const repo = await makeRepo(root)
      const result = await spawnRaw(["run", "--", "sh", "-c", SCRIPT], env(), repo).done
      const want = expected(SCRIPT)

      expect(result.code).toBe(3)
      expect(server.cuts).toBe(3)
      expect(result.stdout.equals(want.stdout)).toBe(true)
      expect(result.remoteStderr.equals(want.stderr)).toBe(true)
      expect(reconnects(result.stderr)).toBe(3)
      // each reattach carried on exactly where the output written so far ended
      expect(server.attaches.map((attach) => attach.status)).toEqual([200, 200, 200])
      const offsets = server.attaches.map((attach) => attach.from.split(",").map(Number))
      for (let i = 1; i < offsets.length; i++) expect(offsets[i]![0]!).toBeGreaterThan(offsets[i - 1]![0]!)
      expect(result.stderr).not.toContain("never arrived")
      expect(result.stderr).toMatch(/exit 3$/m)
      expect(server.destroyed).toHaveLength(1)
    })

    test("exec reattaches the same way, and --json carries every event line once", async () => {
      server.options.cutAfter = [1_500]
      const id = (await cli(["create"], { cwd: root, env: env() })).stdout.trim()
      const result = await spawnRaw(["exec", id, "--json", "--", "sh", "-c", SCRIPT], env()).done
      const want = expected(SCRIPT)

      expect(result.code).toBe(3)
      const events = result.stdout
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(events[0]).toMatchObject({ type: "started", resumable: true })
      expect(events.filter((event) => event.type === "attached")).toHaveLength(1)
      const bytesOf = (stream: string) =>
        Buffer.concat(
          events
            .filter((event) => event.type === stream)
            .map((event) => (typeof event.b64 === "string" ? Buffer.from(event.b64, "base64") : Buffer.from(String(event.data), "utf8"))),
        )
      expect(bytesOf("stdout").equals(want.stdout)).toBe(true)
      expect(bytesOf("stderr").equals(want.stderr)).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: "exit", code: 3 })
      expect(reconnects(result.stderr)).toBe(1)
    })

    test("reattaching that fails a few times (503, the network) gets through, with one reconnecting line", async () => {
      server.options.cutAfter = [1_000]
      const failures = [
        { status: 503, error: "vmd_unavailable" },
        { status: 503, error: "node_offline" },
        { status: 502, error: "node_disconnected" },
        { status: 504, error: "gateway_timeout" },
      ]
      server.options.attach = (attempt) => {
        const failure = failures[attempt - 1]
        return failure ? Response.json({ error: failure.error, message: "the machine is restarting" }, { status: failure.status }) : null
      }
      const repo = await makeRepo(root)
      const result = await spawnRaw(["run", "--", "sh", "-c", SCRIPT], env(), repo).done

      expect(result.code).toBe(3)
      expect(result.stdout.equals(expected(SCRIPT).stdout)).toBe(true)
      expect(server.attaches.map((attach) => attach.status)).toEqual([503, 503, 502, 504, 200])
      expect(reconnects(result.stderr)).toBe(1)
    })
  })
}

describe("giving up", () => {
  let vmd: FakeVmd
  const env = (extra: Record<string, string | undefined> = {}) => baseEnv(vmd.url, { ...FAST, ...extra })

  beforeEach(async () => {
    vmd = await startFakeVmd()
  })

  afterEach(async () => {
    await vmd.stop()
  })

  test("a reattach that keeps failing past the window is 125, saying so", async () => {
    vmd.options.cutAfter = [5]
    vmd.options.attach = () => Response.json({ error: "vmd_unavailable", message: "kyora-vmd is restarting" }, { status: 503 })
    const repo = await makeRepo(root)
    const started = Date.now()
    const result = await spawnRaw(["run", "--", "sh", "-c", "echo first line; sleep 2; echo more"], env({ KYORA_VMS_REATTACH_WINDOW_MS: "1500" }), repo).done

    expect(result.code).toBe(125)
    expect(result.stdout.toString()).toStartWith("first line\n")
    expect(result.stderr).toMatch(/lost the command's stream \(.*kyora-vmd is restarting.*\) and could not reattach within 1\.5s; it may still be running in sb_\w+/)
    expect(reconnects(result.stderr)).toBe(1)
    expect(vmd.attaches.length).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(vmd.destroyed).toHaveLength(1)
  })

  test("reattaches that only say attached and then detached are no progress: the window still runs out", async () => {
    vmd.options.cutAfter = [5]
    // every reattach answers and is let go of at once, as when the machine's socket keeps dropping
    vmd.options.attach = () =>
      new Response(`${JSON.stringify({ type: "attached", id: "a".repeat(32), running: true })}\n${JSON.stringify({ type: "detached", reason: "the machine's connection dropped" })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })
    const repo = await makeRepo(root)
    const started = Date.now()
    const running = spawnRaw(["run", "--", "sh", "-c", "echo first line; sleep 30"], env({ KYORA_VMS_REATTACH_WINDOW_MS: "1500" }), repo)
    // control events resetting the window would retry for ever: bounded here, so that fails instead of hanging
    const stuck = setTimeout(() => running.proc.kill("SIGKILL"), 15_000)
    const result = await running.done
    clearTimeout(stuck)

    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/could not reattach within 1\.5s/)
    expect(reconnects(result.stderr)).toBe(1)
    expect(vmd.attaches.length).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(12_000)
  })

  test("a reattach answered 404 (the command is gone) is 125 at once", async () => {
    vmd.options.cutAfter = [5]
    vmd.options.attach = () => Response.json({ error: "exec_not_found", message: "no such exec in this sandbox" }, { status: 404 })
    const repo = await makeRepo(root)
    const result = await spawnRaw(["run", "--", "sh", "-c", "echo first line; sleep 5"], env({ KYORA_VMS_REATTACH_WINDOW_MS: "600000" }), repo).done

    expect(result.code).toBe(125)
    expect(result.stderr).toContain("and it can't be reattached: reattach to the command in")
    expect(result.stderr).toContain("no such exec in this sandbox")
    expect(vmd.attaches).toHaveLength(1)
  })

  test("a server without resumable commands breaks as it always did: 125, no reattach", async () => {
    vmd.options.resumable = false
    vmd.options.exec = () => new Response(`${JSON.stringify({ type: "stdout", data: "partial\n" })}\n{"type":"std`, { headers: { "content-type": "application/x-ndjson" } })
    const repo = await makeRepo(root)
    const result = await spawnRaw(["run", "--", "cargo", "build"], env(), repo).done

    expect(result.code).toBe(125)
    expect(result.stdout.toString()).toBe("partial\n")
    expect(result.stderr).toContain("the exec stream ended without an exit status (connection lost?)")
    expect(reconnects(result.stderr)).toBe(0)
    expect(vmd.requests.some((request) => request.includes("/execs/"))).toBe(false)
  })

  test("a guest agent too old to keep the command: started without an id, and a break is 125", async () => {
    vmd.options.oldAgent = true
    const repo = await makeRepo(root)
    const running = spawnRaw(["run", "--", "sh", "-c", "echo first line; sleep 30"], env(), repo)
    await waitFor(() => running.stdout().includes("first line"), 15_000, "the command to start")
    // the classic exec stream has no cut of its own: the whole server goes away instead
    await vmd.stop()
    const result = await running.done
    expect(result.code).toBe(125)
    expect(reconnects(result.stderr)).toBe(0)
    vmd = await startFakeVmd()
  })
})

describe("what the break leaves", () => {
  let vmd: FakeVmd
  const env = (extra: Record<string, string | undefined> = {}) => baseEnv(vmd.url, { ...FAST, ...extra })

  beforeEach(async () => {
    vmd = await startFakeVmd()
  })

  afterEach(async () => {
    await vmd.stop()
  })

  test("output the sandbox no longer holds is a gap: said on stderr, and the rest carries on", async () => {
    // cut right after the first line, before the burst
    vmd.options.cutAfter = [3]
    vmd.options.keepBytes = 1_000
    // the reattach only comes once the command is done: all but the last 1000 bytes of each stream are gone by then
    vmd.options.attach = async () => {
      await waitFor(() => [...vmd.commands.values()][0]?.exit, 15_000, "the command to finish")
      return null
    }
    const script = "echo head; sleep 0.3; i=0; while [ $i -lt 300 ]; do printf 'line %04d of the build\\n' $i; i=$((i+1)); done"
    const repo = await makeRepo(root)
    const result = await spawnRaw(["run", "--", "sh", "-c", script], env(), repo).done
    const want = expected(script).stdout

    expect(result.code).toBe(0)
    const head = result.stdout.subarray(0, result.stdout.length - 1_000)
    expect(want.subarray(0, head.length).equals(head)).toBe(true)
    expect(result.stdout.subarray(-1_000).equals(want.subarray(-1_000))).toBe(true)
    const lost = want.length - result.stdout.length
    expect(lost).toBeGreaterThan(4_000)
    expect(result.stdout.subarray(0, 5).toString()).toBe("head\n")
    expect(result.stderr).toContain(`[kyora-vms] ${formatBytes(lost)} of the command's stdout were dropped while nobody was attached`)
    expect(result.stderr).not.toContain("never arrived")
  })

  test("a stream that goes quiet past the idle limit (a half-open connection) is reattached", async () => {
    const repo = await makeRepo(root)
    const result = await spawnRaw(["run", "--", "sh", "-c", "echo before; sleep 2; echo after"], env({ KYORA_VMS_STREAM_IDLE_MS: "500", KYORA_VMS_REATTACH_BASE_MS: "250" }), repo).done

    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toBe("before\nafter\n")
    expect(vmd.attaches.length).toBeGreaterThanOrEqual(2)
    // quiet reattaches that got nowhere are one break, not one each
    expect(reconnects(result.stderr)).toBe(1)
    // each stream given up on was closed before the next: none stays attached, unread, in the guest
    // (bun's fetch before 1.4 keeps the connection when only the body is cancelled)
    expect(vmd.maxFollowing).toBe(1)
  })

  test("Ctrl-C while reconnecting still cancels the command by its id", async () => {
    vmd.options.cutAfter = [5]
    vmd.options.attach = () => Response.json({ error: "shutting_down", message: "restarting" }, { status: 503 })
    const repo = await makeRepo(root)
    const running = spawnRaw(["run", "--", "sh", "-c", "echo started; exec sleep 30"], env(), repo)
    await waitFor(() => vmd.attaches.length > 0, 15_000, "the reattaching")
    running.proc.kill("SIGINT")
    const result = await running.done

    expect(result.code).toBe(130)
    const [command] = [...vmd.commands.values()]
    expect(vmd.cancels).toEqual([{ id: command!.id, execId: command!.execId, pid: command!.pid }])
    await waitFor(() => !alive(command!.pid), 5_000, "the remote process to die")
    expect(vmd.destroyed).toEqual([command!.id])
  })
})

/** a process that must end on its own: killed past `ms`, so a hang fails the test instead of the suite */
async function bounded(running: ReturnType<typeof spawnRaw>, ms = 20_000): Promise<RawResult & { ms: number }> {
  const started = Date.now()
  const stuck = setTimeout(() => running.proc.kill("SIGKILL"), ms)
  const result = await running.done
  clearTimeout(stuck)
  return { ...result, ms: Date.now() - started }
}

/** an exec answer that is all headers: nothing on it, ever (Bun sends the headers with the first bytes, so a blank line gets them out) */
const silentStream = (headers: Record<string, string> = {}, first = "\n") =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (first) controller.enqueue(new TextEncoder().encode(first))
      },
    }),
    { headers: { "content-type": "application/x-ndjson", ...headers } },
  )

const keepalives = { "x-kyora-keepalive-ms": "20000" }

describe("a stream that never ends", () => {
  let server: FakeVmd

  afterEach(async () => {
    await server.stop()
  })

  test("kyora cloud: a stream that keeps only kyora cloud's own keepalives once the machine is gone is reattached", async () => {
    // a deploy: the relay's machine side went away, and a control plane kept the stream alive with its own pings;
    // a live stream carries the machine's keepalives (every 200 ms here), the orphaned one only the cloud's (every 100 ms)
    server = await startFakePlatform({ cutAfter: [7], cutMode: "orphan", orphanPingMs: 100, keepaliveMs: 200 })
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "echo before; sleep 2; echo after; exit 4"], platformEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "700" }), repo))

    expect(result.code).toBe(4)
    expect(result.stdout.toString()).toBe("before\nafter\n")
    expect(server.cuts).toBe(1)
    expect(reconnects(result.stderr)).toBe(1)
    expect(server.attaches.map((attach) => attach.status)).toEqual([200])
    expect(server.attaches[0]!.from).toBe("7,0")
    expect(server.destroyed).toHaveLength(1)
  })

  test("kyora cloud: a stale relay that keeps sending plain pings after the machine's own keepalives stopped is reattached within the idle limit", async () => {
    // a deploy: the replaced control plane (from before it marked its pings) kept the
    // stream alive with plain {"type":"ping"}, and the machine's side was gone. The machine marks its own
    // keepalives (every 200 ms here), so a plain one is nobody's
    server = await startFakePlatform({ cutAfter: [7], cutMode: "orphan", orphanPing: { type: "ping" }, orphanPingMs: 100, keepaliveMs: 200 })
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "echo before; sleep 2; echo after; exit 4"], platformEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "700" }), repo))

    expect(result.code).toBe(4)
    expect(result.stdout.toString()).toBe("before\nafter\n")
    expect(server.cuts).toBe(1)
    expect(reconnects(result.stderr)).toBe(1)
    expect(server.attaches.map((attach) => attach.status)).toEqual([200])
    expect(server.attaches[0]!.from).toBe("7,0")
  })

  for (const source of [undefined, "node"]) {
    test(`kyora cloud: replaying the ${source ?? "vmd"} keepalive's seq does not keep a dead machine alive: reattached`, async () => {
      server = await startFakePlatform({ cutAfter: [7], cutMode: "orphan", orphanPing: { type: "ping", from: "machine", ...(source ? { source } : {}), seq: 1, stdout: 7, stderr: 0 }, orphanPingMs: 100, keepaliveMs: 200 })
      const repo = await makeRepo(root)
      const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "echo before; sleep 2; echo after; exit 4"], platformEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "700" }), repo))

      expect(result.code).toBe(4)
      expect(result.stdout.toString()).toBe("before\nafter\n")
      expect(reconnects(result.stderr)).toBe(1)
      expect(server.attaches.map((attach) => attach.status)).toEqual([200])
    })
  }

  for (const kind of ["vmd", "platform"] as const) {
    test(`${kind}: an older kyora-vmd that never marks its keepalives: its plain pings are the machine's, and a quiet command is not taken for broken`, async () => {
      server = kind === "vmd" ? await startFakeVmd({ machinePings: false, keepaliveMs: 200 }) : await startFakePlatform({ machinePings: false, keepaliveMs: 200 })
      const repo = await makeRepo(root)
      const env = kind === "vmd" ? baseEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "700" }) : platformEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "700" })
      const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "echo start; sleep 2; echo done"], env, repo))

      expect(result.code).toBe(0)
      expect(result.stdout.toString()).toBe("start\ndone\n")
      expect(reconnects(result.stderr)).toBe(0)
      expect(server.attaches).toEqual([])
    })
  }

  test("kyora cloud: reattaches the machine never speaks on (attached, the cloud's keepalives, the cloud's detached) are no progress: the window runs out, 125", async () => {
    // each reattach holds past 5 s, then kyora cloud ends it (its machine-silence check, or the Worker's): counted as
    // progress, every one would start the window and the backoff over, and a command without --timeout would reconnect for ever
    server = await startFakePlatform({ cutAfter: [6] })
    server.options.attach = () => {
      const encoder = new TextEncoder()
      const line = (event: unknown) => encoder.encode(`${JSON.stringify(event)}\n`)
      let pings: ReturnType<typeof setInterval> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(line({ type: "attached", id: "a".repeat(32), running: true }))
            pings = setInterval(() => controller.enqueue(line({ type: "ping", from: "cloud" })), 200)
            setTimeout(() => {
              clearInterval(pings)
              controller.enqueue(line({ type: "detached", reason: "the machine sent nothing for the command in 60 s; the command keeps running" }))
              controller.close()
            }, 5_500)
          },
          cancel: () => clearInterval(pings),
        }),
        { headers: { "content-type": "application/x-ndjson", ...keepalives } },
      )
    }
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "echo start; exec sleep 30"], platformEnv(server.url, { ...FAST, KYORA_VMS_REATTACH_WINDOW_MS: "3000" }), repo))

    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/lost the command's stream \(the machine sent nothing for the command in 60 s; the command keeps running\) and could not reattach within 3\.0s/)
    expect(reconnects(result.stderr)).toBe(1)
    expect(server.attaches).toHaveLength(1)
    expect(result.ms).toBeLessThan(15_000)
  })

  for (const kind of ["vmd", "platform"] as const) {
    test(`${kind}: an exec stream that goes silent before its first line is 125 within the idle limit, not a hang`, async () => {
      server = kind === "vmd" ? await startFakeVmd() : await startFakePlatform()
      server.options.exec = () => silentStream(keepalives)
      const repo = await makeRepo(root)
      const env = kind === "vmd" ? baseEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "800" }) : platformEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "800" })
      const result = await bounded(spawnRaw(["run", "--", "cargo", "build"], env, repo))

      expect(result.code).toBe(125)
      expect(result.stderr).toMatch(/the exec stream went silent \(nothing heard for 800ms\) and can't be reattached, the server never named the command; it may still be running in sb_\w+/)
      expect(result.ms).toBeLessThan(10_000)
      expect(reconnects(result.stderr)).toBe(0)
      expect(server.destroyed).toHaveLength(1)
    })
  }

  test("a plain (non-resumable) exec stream that goes silent is 125 within the idle limit, since it can't be reattached", async () => {
    server = await startFakeVmd({ resumable: false })
    server.options.exec = () => silentStream({}, `${JSON.stringify({ type: "ping" })}\n${JSON.stringify({ type: "stdout", data: "compiling\n" })}\n`)
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--", "cargo", "build"], baseEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "800" }), repo))

    expect(result.code).toBe(125)
    expect(result.stdout.toString()).toBe("compiling\n")
    expect(result.stderr).toContain("the exec stream went silent (nothing heard for 800ms) and can't be reattached")
    expect(reconnects(result.stderr)).toBe(0)
    expect(server.requests.some((request) => request.includes("/execs/"))).toBe(false)
  })

  test("a server that sends no keepalives at all: a quiet command is not taken for broken", async () => {
    server = await startFakeVmd({ resumable: false, keepaliveMs: false })
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--", "sh", "-c", "sleep 2; echo done"], baseEnv(server.url, { ...FAST, KYORA_VMS_STREAM_IDLE_MS: "300" }), repo))

    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toBe("done\n")
    expect(reconnects(result.stderr)).toBe(0)
  })
})

describe("--timeout is kyora-vms' own deadline too", () => {
  let server: FakeVmd
  /** a grace of half a second, so the tests see the deadline */
  const GRACE = { KYORA_VMS_TIMEOUT_GRACE_MS: "500" }
  const givenUp = /^\[kyora-vms\] gave up on the command in (sb_\w+): its --timeout of 2\.0s passed 500ms ago and no exit status came; (.*)$/m

  afterEach(async () => {
    await server.stop()
  })

  for (const kind of ["vmd", "platform"] as const) {
    test(`${kind}: a stream that looks alive (keepalives a client can't tell apart) and never ends is 124 past --timeout, cancelled and destroyed`, async () => {
      // pings as kyora cloud sent them before it marked its own, from a kyora-vmd that doesn't mark its own
      // either: nothing in the stream says it's dead
      server = kind === "vmd" ? await startFakeVmd() : await startFakePlatform()
      Object.assign(server.options, { cutAfter: [6], cutMode: "orphan", orphanPing: { type: "ping" }, ignoreTimeouts: true, machinePings: false })
      const repo = await makeRepo(root)
      const env = kind === "vmd" ? baseEnv(server.url, { ...FAST, ...GRACE }) : platformEnv(server.url, { ...FAST, ...GRACE })
      const result = await bounded(spawnRaw(["run", "--timeout", "2s", "--", "sh", "-c", "echo start; exec sleep 30"], env, repo))

      expect(result.code).toBe(124)
      expect(result.stdout.toString()).toBe("start\n")
      expect(result.ms).toBeLessThan(10_000)
      const line = givenUp.exec(result.stderr)
      expect(line?.[2]).toBe("cancelled it")
      // one line says it all, then the summary's "exit 124"
      expect(result.stderr.match(/gave up|cancel/g)).toHaveLength(2)
      expect(result.stderr).toMatch(/· exit 124$/m)
      expect(reconnects(result.stderr)).toBe(0)
      const [command] = [...server.commands.values()]
      expect(server.cancels).toEqual([{ id: command!.id, execId: command!.execId, pid: command!.pid }])
      await waitFor(() => !alive(command!.pid), 5_000, "the remote process to die")
      expect(server.destroyed).toEqual([command!.id])
    })
  }

  test("an exit that came on a stream left open is the outcome: not 124, nothing cancelled, and --out after it isn't cut short", async () => {
    server = await startFakeVmd()
    const lines = [{ type: "started", id: "e".repeat(32), resumable: true }, { type: "stdout", data: "built\n" }, { type: "exit", code: 0, signal: null, durationMs: 5, timedOut: false }]
    // the exit, then nothing: the connection never ends
    server.options.exec = () => silentStream(keepalives, lines.map((event) => `${JSON.stringify(event)}\n`).join(""))
    // a download that takes past the deadline the command ran under (1 s and the grace)
    const staged = await tempDir("staged")
    await write(staged, "target/app", "binary")
    const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", staged, "target/app"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" } }).stdout
    server.options.download = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new Uint8Array(tar))
              controller.close()
            }, 2_000)
          },
        }),
        { headers: { "content-type": "application/x-tar" } },
      )
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--timeout", "1s", "--out", "target/app", "--", "cargo", "build"], baseEnv(server.url, { ...FAST, ...GRACE }), repo))
    await rm(staged, { recursive: true, force: true })

    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toBe("built\n")
    expect(result.stderr).not.toContain("gave up")
    expect(server.cancels).toEqual([])
    expect(await Bun.file(join(repo, "target/app")).text()).toBe("binary")
    expect(server.destroyed).toHaveLength(1)

    // and the --git setup's exec, which kyora-vms runs for itself, is not waited on past its exit either
    const again = await bounded(spawnRaw(["run", "--git", "--timeout", "1s", "--", "cargo", "build"], baseEnv(server.url, { ...FAST, ...GRACE }), repo))
    expect(again.code).toBe(0)
    expect(again.stdout.toString()).toBe("built\n")
    expect(again.ms).toBeLessThan(10_000)
    // one exec for the first run; the setup's and the command's for this one
    expect(server.requests.filter((request) => request.startsWith("POST ") && request.endsWith("/exec"))).toHaveLength(3)
  })

  test("exec: 124 past --timeout, the command cancelled, the sandbox left as it is", async () => {
    server = await startFakeVmd({ cutAfter: [6], cutMode: "orphan", orphanPing: { type: "ping" }, ignoreTimeouts: true })
    const id = (await cli(["create"], { cwd: root, env: baseEnv(server.url) })).stdout.trim()
    const result = await bounded(spawnRaw(["exec", id, "--timeout", "2s", "--", "sh", "-c", "echo start; exec sleep 30"], baseEnv(server.url, { ...FAST, ...GRACE })))

    expect(result.code).toBe(124)
    expect(givenUp.exec(result.stderr)?.slice(1)).toEqual([id, "cancelled it"])
    const [command] = [...server.commands.values()]
    expect(server.cancels).toEqual([{ id, execId: command!.execId, pid: command!.pid }])
    expect(server.destroyed).toEqual([])
    expect(server.sandboxes.has(id)).toBe(true)
  })

  test("the deadline holds while reattaching too: 124, not the end of the reattach window", async () => {
    server = await startFakeVmd({ cutAfter: [6], ignoreTimeouts: true })
    server.options.attach = () => Response.json({ error: "node_offline", message: "the machine is not connected" }, { status: 503 })
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--timeout", "2s", "--", "sh", "-c", "echo start; exec sleep 30"], baseEnv(server.url, { ...FAST, ...GRACE, KYORA_VMS_REATTACH_WINDOW_MS: "600000" }), repo))

    expect(result.code).toBe(124)
    expect(reconnects(result.stderr)).toBe(1)
    expect(server.attaches.length).toBeGreaterThanOrEqual(2)
    expect(givenUp.exec(result.stderr)?.[2]).toBe("cancelled it")
    expect(server.cancels).toHaveLength(1)
    expect(server.destroyed).toHaveLength(1)
  })

  test("an exec request that is never answered at all is 124 past --timeout, and the sandbox is destroyed", async () => {
    server = await startFakeVmd()
    // not even the headers: Bun sends them with the first bytes, and none come
    server.options.exec = () => silentStream(keepalives, "")
    const repo = await makeRepo(root)
    const result = await bounded(spawnRaw(["run", "--timeout", "2s", "--", "cargo", "build"], baseEnv(server.url, { ...FAST, ...GRACE }), repo))

    expect(result.code).toBe(124)
    expect(givenUp.exec(result.stderr)?.[2]).toBe("dropped its stream")
    expect(server.cancels).toEqual([])
    expect(server.destroyed).toHaveLength(1)
  })

  test("--out after giving up gets the grace and no more: what answers lands, what hangs is said and left", async () => {
    server = await startFakeVmd({ cutAfter: [6], cutMode: "orphan", orphanPing: { type: "ping" }, ignoreTimeouts: true })
    const repo = await makeRepo(root)
    const running = spawnRaw(["run", "--timeout", "2s", "--out", "target/app", "--", "sh", "-c", "mkdir -p target && printf binary > target/app && echo start && exec sleep 30"], baseEnv(server.url, { ...FAST, ...GRACE }), repo)
    const result = await bounded(running)

    expect(result.code).toBe(124)
    expect(await Bun.file(join(repo, "target/app")).text()).toBe("binary")
    expect(server.destroyed).toHaveLength(1)

    // a download that never finishes is cut off at the grace
    server.options.download = () => silentStream({ "content-type": "application/x-tar" }, "x".repeat(100))
    const again = await bounded(spawnRaw(["run", "--timeout", "2s", "--out", "target/app", "--", "sh", "-c", "echo start; exec sleep 30"], baseEnv(server.url, { ...FAST, ...GRACE }), repo))
    expect(again.code).toBe(124)
    expect(again.stderr).toContain("--out /work/target/app: not fetched within 500ms of giving up on the command")
    expect(again.ms).toBeLessThan(10_000)
    expect(server.destroyed).toHaveLength(2)
  })
})

describe("one command right after another", () => {
  let server: FakeVmd

  afterEach(async () => {
    await server.stop()
  })

  for (const kind of ["vmd", "platform"] as const) {
    test(`${kind}: run --git's command, started right after the setup's exit, waits out a sandbox still busy with the setup`, async () => {
      // as kyora cloud's was, until kyora-node's result for the setup came (it now frees the slot at the exit)
      server = kind === "vmd" ? await startFakeVmd({ busyAfterExitMs: 800 }) : await startFakePlatform({ busyAfterExitMs: 800 })
      const repo = await makeRepo(root)
      const env = kind === "vmd" ? baseEnv(server.url, FAST) : platformEnv(server.url, FAST)
      const result = await bounded(spawnRaw(["run", "--git", "--", "sh", "-c", "git rev-parse --is-inside-work-tree && echo ran"], env, repo))

      expect(result.code).toBe(0)
      expect(result.stdout.toString()).toBe("true\nran\n")
      // the setup, the 409s waited out, the command
      expect(server.requests.filter((request) => request.startsWith("POST ") && request.endsWith("/exec")).length).toBeGreaterThan(2)
      expect(server.execs).toHaveLength(2)
      expect(result.ms).toBeLessThan(10_000)
      // the CLI lets go of each stream at its exit: that is no hang-up to cancel or detach anything over
      expect(server.disconnects).toEqual([])
      expect(server.cancels).toEqual([])
    })
  }
})

describe("transfers cut off on the way", () => {
  test("a pull that breaks off mid-body is fetched again and lands whole", async () => {
    const vmd = await startFakeVmd()
    try {
      const data = randomBytes(256 * 1024)
      const id = (await cli(["create"], { cwd: root, env: baseEnv(vmd.url) })).stdout.trim()
      await mkdir(join(vmd.work(id), "out"), { recursive: true })
      await Bun.write(join(vmd.work(id), "out", "blob.bin"), data)
      vmd.options.cutDownload = (attempt) => (attempt === 1 ? 4_096 : null)

      const result = await cli(["pull", id, "out", "--to", join(root, "pulled")], { cwd: root, env: baseEnv(vmd.url) })
      expect(result.code).toBe(0)
      expect(vmd.downloadAttempts).toBe(2)
      expect(result.stderr).toMatch(/download of \/work\/out broke off \(.*\); fetching it again/)
      expect(Buffer.from(await Bun.file(join(root, "pulled", "out", "blob.bin")).arrayBuffer()).equals(data)).toBe(true)
    } finally {
      await vmd.stop()
    }
  })

  test("run --out through kyora cloud: a download cut off at once is fetched again", async () => {
    const cloud = await startFakePlatform()
    try {
      cloud.options.cutDownload = (attempt) => (attempt === 1 ? 0 : null)
      const repo = await makeRepo(root)
      const result = await cli(["run", "--out", "target/app", "--", "sh", "-c", "mkdir -p target && printf binary > target/app"], { cwd: repo, env: platformEnv(cloud.url) })
      expect(result.code).toBe(0)
      expect(cloud.downloadAttempts).toBe(2)
      expect(await Bun.file(join(repo, "target/app")).text()).toBe("binary")
    } finally {
      await cloud.stop()
    }
  })

  test("a push to a kyora-vmd whose connection drops mid-upload is packed and sent again", async () => {
    const vmd = await startFakeVmd()
    const proxy = startCutProxy(vmd.url)
    try {
      vmd.options.onUpload = async (attempt) => {
        if (attempt !== 1) return
        await Bun.sleep(50)
        proxy.cut()
      }
      const repo = await makeRepo(root)
      const result = await cli(["run", "--", "cat", "src/main.rs"], { cwd: repo, env: baseEnv(proxy.url) })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('fn main() { println!("hi") }\n')
      expect(vmd.uploadAttempts).toBe(2)
      expect(result.stderr).toMatch(/upload to sb_\w+ broke off \(.*\); sending it again/)
      // the warnings of packing twice are said once
      expect(result.stderr.split("skipped symlink escape").length).toBe(2)
    } finally {
      proxy.stop()
      await vmd.stop()
    }
  })

  test("a refused push (413) is not sent again", async () => {
    const vmd = await startFakeVmd()
    try {
      vmd.options.uploadLimit = 16
      const repo = await makeRepo(root)
      const result = await cli(["run", "--", "true"], { cwd: repo, env: baseEnv(vmd.url) })
      expect(result.code).toBe(125)
      expect(vmd.uploadAttempts).toBe(1)
    } finally {
      await vmd.stop()
    }
  })

  test("kyora cloud: a complete cut off on the way goes up again as a new upload", async () => {
    const cloud = await startFakePlatform()
    try {
      cloud.options.complete = (attempt) => (attempt === 1 ? Response.json({ error: "vmd_unavailable", message: "kyora-vmd POST /v1/sandboxes/sb_x/files failed" }, { status: 503 }) : null)
      const repo = await makeRepo(root)
      const result = await cli(["run", "--", "cat", "src/main.rs"], { cwd: repo, env: platformEnv(cloud.url) })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('fn main() { println!("hi") }\n')
      expect(cloud.multipart.map((upload) => upload.status)).toEqual(["aborted", "complete"])
      expect(result.stderr).toMatch(/upload to sb_\w+ broke off \(.*kyora-vmd POST.*\); sending it again/)
    } finally {
      await cloud.stop()
    }
  })

  test("kyora cloud: a complete refused for good (4xx) is not repeated", async () => {
    const cloud = await startFakePlatform()
    try {
      cloud.options.complete = () => Response.json({ error: "upload_rejected", message: "unsafe archive entry" }, { status: 400 })
      const repo = await makeRepo(root)
      const result = await cli(["run", "--", "true"], { cwd: repo, env: platformEnv(cloud.url) })
      expect(result.code).toBe(125)
      expect(cloud.multipart).toHaveLength(1)
      expect(cloud.execs).toHaveLength(0)
    } finally {
      await cloud.stop()
    }
  })
})
