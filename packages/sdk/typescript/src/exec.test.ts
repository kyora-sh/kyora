import { describe, expect, test } from "bun:test"
import { ExecDetachedError } from "./exec.js"
import { client, error, json, ndjson } from "./testing/fake.js"

const ID = "0123456789abcdef0123456789abcdef"
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const exit = (code: number | null, extra: Record<string, unknown> = {}) => ({ type: "exit", code, signal: null, durationMs: 12, timedOut: false, ...extra })

describe("exec stream", () => {
  test("collects stdout and stderr as bytes, text and base64 alike, across split chunks", async () => {
    const { kyora, requests } = client(() =>
      ndjson([
        { type: "started", id: ID, resumable: true, key: "k1" },
        '{"type":"stdout","da',
        'ta":"hello "}\n',
        { type: "ping", from: "cloud" },
        { type: "stdout", b64: btoa(String.fromCharCode(0xff, 0x00, 0x41)) },
        { type: "stderr", data: "warn\n" },
        exit(3, { bytes: { stdout: 9, stderr: 5 } }),
      ]),
    )
    const chunks: string[] = []
    const result = await kyora.exec.run("sb_1", { cmd: ["sh", "-c", "work"], key: "k1" }, { onOutput: (stream, chunk) => void chunks.push(`${stream}:${chunk.length}`) })
    expect(result.exitCode).toBe(3)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBe(12)
    expect([...result.stdout]).toEqual([...new TextEncoder().encode("hello "), 0xff, 0x00, 0x41])
    expect(text(result.stderr)).toBe("warn\n")
    expect(result.truncated).toEqual({ stdout: false, stderr: false })
    expect(result.execId).toBe(ID)
    expect(result.key).toBe("k1")
    expect(chunks).toEqual(["stdout:6", "stdout:3", "stderr:5"])
    expect(requests[0]!.json).toEqual({ cmd: ["sh", "-c", "work"], key: "k1", resumable: true })
  })

  test("a timeout and a signal come through as they are", async () => {
    const { kyora } = client(() => ndjson([{ type: "started", id: ID, resumable: true }, exit(null, { signal: "SIGKILL", timedOut: true })]))
    const result = await kyora.exec.run("sb_1", { cmd: ["sleep", "99"], timeoutSeconds: 1 })
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true })
  })

  test("every exec is resumable under a fresh key unless it names one", async () => {
    const { kyora, requests } = client(() => ndjson([exit(0)]))
    await kyora.exec.run("sb_1", { cmd: ["true"] })
    await kyora.exec.run("sb_1", { cmd: ["true"] })
    const keys = requests.map((request) => (request.json as { key: string; resumable: boolean }).key)
    expect(keys[0]).toMatch(/^sdk-/)
    expect(keys[0]).not.toBe(keys[1])
    expect(requests.every((request) => (request.json as { resumable: boolean }).resumable === true)).toBe(true)
  })

  test("truncation: past maxOutputBytes, a gap, or short of the exit's totals", async () => {
    const { kyora } = client(() =>
      ndjson([
        { type: "started", id: ID, resumable: true },
        { type: "stdout", data: "0123456789" },
        { type: "gap", stream: "stderr", from: 0, to: 4 },
        { type: "stderr", data: "tail" },
        exit(0, { bytes: { stdout: 10, stderr: 8 } }),
      ]),
    )
    const result = await kyora.exec.run("sb_1", { cmd: ["x"] }, { maxOutputBytes: 4 })
    expect(text(result.stdout)).toBe("0123")
    expect(text(result.stderr)).toBe("tail")
    expect(result.truncated).toEqual({ stdout: true, stderr: true })
    const short = client(() => ndjson([{ type: "started", id: ID, resumable: true }, { type: "stdout", data: "ab" }, exit(0, { bytes: { stdout: 5, stderr: 0 } })]))
    expect((await short.kyora.exec.run("sb_1", { cmd: ["x"] })).truncated).toEqual({ stdout: true, stderr: false })
  })

  test("an error frame is a KyoraError", async () => {
    const { kyora } = client(() => ndjson([{ type: "started", id: ID, resumable: true }, { type: "error", message: "the machine went away" }]))
    await expect(kyora.exec.run("sb_1", { cmd: ["x"] })).rejects.toMatchObject({ code: "exec_error" })
  })

  test("a refused exec is the refusal, after retrying one that never started", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? error(503, "exec_not_started", { retryable: true, retryAfterMs: 1 }) : error(409, "not_running")))
    await expect(kyora.exec.run("sb_1", { cmd: ["x"], key: "same" })).rejects.toMatchObject({ code: "not_running", status: 409 })
    expect(requests.map((request) => (request.json as { key: string }).key)).toEqual(["same", "same"])
  })
})

describe("reattach", () => {
  test("a stream that breaks is reattached from the bytes already read", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true }, { type: "stdout", data: "abc" }, { type: "stderr", data: "e" }])
      return ndjson([{ type: "attached", id: ID, running: true }, { type: "stdout", data: "def" }, exit(0, { bytes: { stdout: 6, stderr: 1 } })])
    })
    const result = await kyora.exec.run("sb_1", { cmd: ["x"] })
    expect(text(result.stdout)).toBe("abcdef")
    expect(text(result.stderr)).toBe("e")
    expect(result.truncated).toEqual({ stdout: false, stderr: false })
    const attach = requests[1]!
    expect(attach.method).toBe("GET")
    expect(attach.url.pathname).toBe(`/v1/sandboxes/sb_1/execs/${ID}/stream`)
    expect(attach.url.searchParams.get("from")).toBe("3,1")
  })

  test("detached ends a stream too, and the reattach follows", async () => {
    const { kyora, requests } = client((request) =>
      request.method === "POST" ? ndjson([{ type: "started", id: ID, resumable: true }, { type: "detached", reason: "deploy" }]) : ndjson([{ type: "attached", id: ID, running: false }, exit(0)]),
    )
    expect((await kyora.exec.run("sb_1", { cmd: ["x"] })).exitCode).toBe(0)
    expect(requests.length).toBe(2)
  })

  test("a stream that broke before naming its command is found again by its key", async () => {
    const { kyora, requests } = client((request, index) => {
      if (index === 0) return ndjson([])
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true, key: "job-7", existing: true }, { type: "detached", reason: "rejoin" }])
      return ndjson([{ type: "attached", id: ID, running: false }, { type: "stdout", data: "done" }, exit(0)])
    })
    const result = await kyora.exec.run("sb_1", { cmd: ["x"], key: "job-7" })
    expect(text(result.stdout)).toBe("done")
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET"])
    expect((requests[1]!.json as { key: string }).key).toBe("job-7")
    expect(requests[2]!.url.searchParams.get("from")).toBe("0,0")
  })

  test("a silent stream is given up on and reattached", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true }], { hang: true, signal: request.signal! })
      return ndjson([{ type: "attached", id: ID, running: false }, exit(0)])
    })
    expect((await kyora.exec.run("sb_1", { cmd: ["x"] }, { idleMs: 50 })).exitCode).toBe(0)
    expect(requests[0]!.signal!.aborted).toBe(true)
    expect(requests.length).toBe(2)
  })

  test("attach by id reads the rest of a command's output", async () => {
    const { kyora, requests } = client(() => ndjson([{ type: "attached", id: ID, running: true }, { type: "stdout", data: "rest" }, exit(1)]))
    const result = await kyora.exec.attach("sb_1", ID, { from: { stdout: 10, stderr: 2 } })
    expect(text(result.stdout)).toBe("rest")
    expect(result.exitCode).toBe(1)
    expect(requests[0]!.url.searchParams.get("from")).toBe("10,2")
  })

  test("a break that can't be reattached within the window is stream_lost, with what to reattach to", async () => {
    const { kyora } = client((request) => (request.method === "POST" ? ndjson([{ type: "started", id: ID, resumable: true }, { type: "stdout", data: "ab" }]) : error(503, "node_offline")))
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"], key: "k" }, { reattachWindowMs: 100 }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect(failure).toMatchObject({ code: "stream_lost", execId: ID, key: "k", offsets: { stdout: 2, stderr: 0 } })
  })

  test("a reattach that is refused for good is that refusal", async () => {
    const { kyora } = client((request) => (request.method === "POST" ? ndjson([{ type: "started", id: ID, resumable: true }]) : error(404, "exec_not_found")))
    await expect(kyora.exec.run("sb_1", { cmd: ["x"] })).rejects.toMatchObject({ code: "exec_not_found" })
  })
})

describe("deadline and abort", () => {
  test("the deadline stops waiting and leaves the command running", async () => {
    const { kyora, requests } = client((request) => ndjson([{ type: "started", id: ID, resumable: true }, { type: "stdout", data: "partial" }], { hang: true, signal: request.signal! }))
    const started = Date.now()
    const failure = await kyora.exec.run("sb_1", { cmd: ["sleep", "60"], key: "k9" }, { timeoutMs: 100 }).catch((caught: unknown) => caught)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect(failure).toMatchObject({ code: "timeout", retryable: true, execId: ID, key: "k9", offsets: { stdout: 7, stderr: 0 } })
    expect(requests.some((request) => request.url.pathname.endsWith("/cancel"))).toBe(false)
  })

  test("a Retry-After past the deadline is the error itself, and the exec never started", async () => {
    const { kyora, requests } = client(() => error(503, "waking", { retryable: true, retryAfterMs: 8_000 }))
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"] }, { timeoutMs: 1_000 }).catch((caught: unknown) => caught)
    expect(failure).toMatchObject({ code: "waking", retryAfterMs: 8_000 })
    expect(requests.length).toBe(1)
  })

  test("an abort cancels the command", async () => {
    const { kyora, requests } = client((request) =>
      request.url.pathname.endsWith("/cancel") ? json(200, { cancelled: true }) : ndjson([{ type: "started", id: ID, resumable: true }], { hang: true, signal: request.signal! }),
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("user stop")), 30)
    await expect(kyora.exec.run("sb_1", { cmd: ["x"] }, { signal: controller.signal })).rejects.toThrow("user stop")
    expect(requests.at(-1)!.url.pathname).toBe(`/v1/sandboxes/sb_1/execs/${ID}/cancel`)
  })
})

describe("never running a command twice", () => {
  test("a stream that started without resumability and broke is not sent again", async () => {
    const { kyora, requests } = client(() => ndjson([{ type: "started", resumable: false }, { type: "stdout", data: "half" }]))
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"], key: "k1" }, { reattachWindowMs: 200 }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect(failure).toMatchObject({ code: "stream_lost", execId: null, key: "k1", offsets: { stdout: 4, stderr: 0 } })
    expect(requests.length).toBe(1)
  })

  test("output from a server that never sent started is not sent again either", async () => {
    const { kyora, requests } = client(() => ndjson([{ type: "stdout", data: "old server" }]))
    await expect(kyora.exec.run("sb_1", { cmd: ["x"] })).rejects.toMatchObject({ code: "stream_lost" })
    expect(requests.length).toBe(1)
  })
})

describe("an exec whose start is unclear", () => {
  test("no answer to the POST is recovered by its key", async () => {
    const { kyora, requests } = client((request, index) => {
      if (index === 0) throw new TypeError("connection reset")
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true, key: "k5", existing: true }, { type: "detached", reason: "rejoin" }])
      return ndjson([{ type: "attached", id: ID, running: false }, { type: "stdout", data: "ok" }, exit(0)])
    }, { retry: { maxAttempts: 1 } })
    const result = await kyora.exec.run("sb_1", { cmd: ["x"], key: "k5" })
    expect(text(result.stdout)).toBe("ok")
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET"])
    expect(requests.slice(0, 2).map((request) => (request.json as { key: string }).key)).toEqual(["k5", "k5"])
  })

  test("one that can't be recovered in time carries its generated key", async () => {
    const { kyora } = client(() => {
      throw new TypeError("connection reset")
    }, { retry: { maxAttempts: 1 } })
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"] }, { reattachWindowMs: 100 }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect((failure as ExecDetachedError).key).toMatch(/^sdk-/)
    expect((failure as ExecDetachedError).code).toBe("stream_lost")
  })
})

describe("reattach honours Retry-After", () => {
  test("waits what kyora asks between reattaches", async () => {
    const { kyora } = client((request, index) => {
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true }])
      if (index === 1) return error(503, "waking", { retryable: true, retryAfterMs: 120 })
      return ndjson([{ type: "attached", id: ID, running: false }, exit(0)])
    })
    const started = Date.now()
    expect((await kyora.exec.run("sb_1", { cmd: ["x"] })).exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })

  test("a Retry-After past the window or deadline is thrown with what to reattach to", async () => {
    const { kyora } = client((request) => (request.method === "POST" ? ndjson([{ type: "started", id: ID, resumable: true }]) : error(503, "waking", { retryable: true, retryAfterMs: 60_000 })))
    const started = Date.now()
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"], key: "k6" }, { timeoutMs: 5_000 }).catch((caught: unknown) => caught)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect(failure).toMatchObject({ code: "waking", retryAfterMs: 60_000, execId: ID, key: "k6" })
  })
})

describe("onOutput", () => {
  test("an exception it throws ends the call as it is, with no reattach", async () => {
    const { kyora, requests } = client(() => ndjson([{ type: "started", id: ID, resumable: true }, { type: "stdout", data: "a" }, exit(0)]))
    const mine = new Error("sink full")
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"] }, { onOutput: () => { throw mine } }).catch((caught: unknown) => caught)
    expect(failure).toBe(mine)
    expect(requests.length).toBe(1)
  })
})

describe("recovery bounds", () => {
  test("the unclear start's Retry-After is the first recovery delay", async () => {
    const { kyora, requests } = client((request, index) => {
      if (index === 0) return error(503, "do_reset", { retryable: true, retryAfterMs: 300 })
      if (request.method === "POST") return ndjson([{ type: "started", id: ID, resumable: true, existing: true }, { type: "detached", reason: "rejoin" }])
      return ndjson([{ type: "attached", id: ID, running: false }, exit(0)])
    }, { retry: { maxAttempts: 1 } })
    const started = Date.now()
    expect((await kyora.exec.run("sb_1", { cmd: ["x"] })).exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET"])
  })

  test("an unclear start whose Retry-After passes the deadline is thrown with the key", async () => {
    const { kyora } = client(() => error(503, "do_reset", { retryable: true, retryAfterMs: 30_000 }), { retry: { maxAttempts: 1 } })
    const failure = await kyora.exec.run("sb_1", { cmd: ["x"], key: "k8" }, { timeoutMs: 2_000 }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(ExecDetachedError)
    expect(failure).toMatchObject({ code: "do_reset", retryAfterMs: 30_000, key: "k8" })
  })

  test("a reattach that never answers is bounded by the window", async () => {
    const { kyora } = client((request) => (request.method === "POST" ? ndjson([{ type: "started", id: ID, resumable: true }]) : new Promise<Response>(() => {})))
    const started = Date.now()
    await expect(kyora.exec.run("sb_1", { cmd: ["x"] }, { reattachWindowMs: 200 })).rejects.toMatchObject({ code: "stream_lost" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
