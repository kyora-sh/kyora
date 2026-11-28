import { expect, jest, test } from "bun:test"
import { ApiError, VmsClient } from "./api"
import { MAX_REATTACH_WINDOW_MS, reattachable, reattachPolicy, runExec } from "./exec"

/** Reattaches tolerate raw network failures and still expire while an attach request hangs. */

const policy = { windowMs: 200, baseDelayMs: 5, maxDelayMs: 20, idleMs: 1_000 }
const initial = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)

test("exec retries network failures and transient error codes even with an unusual status", async () => {
  const failures = [new TypeError("fetch failed"), Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), new ApiError("offline", 409, "node_offline"), new ApiError("vmd restarting", 400, "vmd_unavailable")]
  let attempts = 0
  const api = {
    exec: async () => initial(),
    attach: async () => {
      const failure = failures[attempts++]
      if (failure) throw failure
      return new Response('{"type":"exit","code":7}\n')
    },
    execExited: () => {},
  } as unknown as VmsClient
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 7 })
  expect(attempts).toBe(5)
})

test("a name that does not resolve (ENOTFOUND, EAI_AGAIN) is the network: the reattach goes on and recovers", async () => {
  const dns = (code: string) => Object.assign(new Error(`getaddrinfo ${code} cloud.kyora.sh`), { code })
  const failures = [
    Object.assign(new TypeError("getaddrinfo ENOTFOUND cloud.kyora.sh"), { code: "ENOTFOUND" }),
    dns("ENOTFOUND"),
    dns("EAI_AGAIN"),
    new Error("fetch failed", { cause: dns("EAI_AGAIN") }),
    new ApiError("reattach to the command in sb_test: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0),
  ]
  let attempts = 0
  const api = {
    exec: async () => initial(),
    attach: async () => {
      const failure = failures[attempts++]
      if (failure) throw failure
      return new Response('{"type":"exit","code":7}\n')
    },
    execExited: () => {},
  } as unknown as VmsClient
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 7 })
  expect(attempts).toBe(6)
})

test("only connection and name-resolution errors are worth a reattach among raw errors", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) expect(reattachable(Object.assign(new Error(code), { code }))).toBe(true)
  for (const code of ["EACCES", "ENOENT", undefined]) expect(reattachable(Object.assign(new Error("no"), { code }))).toBe(false)
  expect(reattachable(new Error("no", { cause: "ENOTFOUND" }))).toBe(false)
  expect(reattachable(undefined)).toBe(false)
  expect(reattachable("ENOTFOUND")).toBe(false)
})

test("a host that never resolves still gives up at the window, saying why, and the stream counts as lost", async () => {
  const api = {
    exec: async () => initial(),
    attach: async () => {
      throw new ApiError("reattach to the command in sb_test: can't reach https://nowhere.invalid (getaddrinfo ENOTFOUND nowhere.invalid)", 0)
    },
  } as unknown as VmsClient
  const at = Date.now()
  const outcome = await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })
  expect(outcome).toMatchObject({ code: 125, lost: true, error: expect.stringMatching(/^lost the command's stream \(.*getaddrinfo ENOTFOUND nowhere\.invalid\)\) and could not reattach within 200ms; it may still be running in sb_test$/) })
  expect(Date.now() - at).toBeLessThan(1_000)
})

test("a hanging reattach is aborted at the window and gives up with 125", async () => {
  let aborted = false
  const api = {
    exec: async () => initial(),
    attach: async (_id: string, _exec: string, _from: unknown, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(signal.reason)
      }, { once: true })
    }),
  } as unknown as VmsClient
  const at = Date.now()
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 125, error: expect.stringContaining("could not reattach") })
  expect(aborted).toBe(true)
  expect(Date.now() - at).toBeLessThan(1_000)
})

function withWindowEnv<T>(value: string | undefined, body: () => T): T {
  const old = process.env.KYORA_VMS_REATTACH_WINDOW_MS
  if (value === undefined) delete process.env.KYORA_VMS_REATTACH_WINDOW_MS
  else process.env.KYORA_VMS_REATTACH_WINDOW_MS = value
  try {
    return body()
  } finally {
    if (old === undefined) delete process.env.KYORA_VMS_REATTACH_WINDOW_MS
    else process.env.KYORA_VMS_REATTACH_WINDOW_MS = old
  }
}

test("the default exec and shell retry window is ten minutes, and the environment can't stretch it past thirty", () => {
  expect(withWindowEnv(undefined, () => reattachPolicy().windowMs)).toBe(600_000)
  expect(withWindowEnv("5000", () => reattachPolicy().windowMs)).toBe(5_000)
  expect(withWindowEnv(String(10 * 3_600_000), () => reattachPolicy().windowMs)).toBe(MAX_REATTACH_WINDOW_MS)
  expect(MAX_REATTACH_WINDOW_MS).toBe(1_800_000)
})

test("every resumable exec carries a key of its own, and a reattach follows a `started` and `detached` answer", async () => {
  const keys: unknown[] = []
  const api = {
    exec: async (_id: string, request: Record<string, unknown>) => {
      keys.push(request.key)
      return initial()
    },
    attach: async () => new Response('{"type":"exit","code":0}\n'),
    execExited: () => {},
  } as unknown as VmsClient
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 0 })
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 0 })
  expect(keys).toHaveLength(2)
  for (const key of keys) expect(key).toMatch(/^kyora-vms:[0-9a-f-]{36}$/)
  expect(keys[0]).not.toBe(keys[1])
  // a caller's own key goes as it is
  await runExec(api, "sb_test", { cmd: ["true"], key: "setup-1" }, { json: false, policy })
  expect(keys[2]).toBe("setup-1")
})

test("an exec the machine never got (exec_not_started) is sent again with the same key; other refusals are answers", async () => {
  const bodies: Array<Record<string, unknown>> = []
  let refusals = 2
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      bodies.push(body)
      if (body.cmd && (body.cmd as string[])[0] === "busy") return Response.json({ error: "exec_busy", message: "busy" }, { status: 409 })
      if (refusals-- > 0) return Response.json({ error: "exec_not_started", message: "the machine reconnected before the command reached it" }, { status: 503 })
      return new Response('{"type":"exit","code":0}\n', { headers: { "content-type": "application/x-ndjson" } })
    },
  })
  try {
    const client = new VmsClient({ url: `http://127.0.0.1:${server.port}`, key: "kyora_test" })
    const response = await client.exec("sb_test", { cmd: ["true"], resumable: true, key: "k-1" })
    expect(response.status).toBe(200)
    expect(bodies.map((body) => body.key)).toEqual(["k-1", "k-1", "k-1"])
    await expect(client.exec("sb_test", { cmd: ["busy"], resumable: true, key: "k-2" })).rejects.toMatchObject({ code: "exec_busy" })
    expect(bodies).toHaveLength(4)
  } finally {
    server.stop(true)
  }
})

/** the notes runExec writes to stderr while `body` runs, as they come (`body` may look at them meanwhile) */
async function notes(body: (lines: string[]) => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const stderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split("\n").filter(Boolean).map((line) => line.replace(/^\[[^\]]+\] /, "")))
    return true
  }) as typeof process.stderr.write
  try {
    await body(lines)
  } finally {
    process.stderr.write = stderr
  }
  return lines
}

const lines = (...events: Array<Record<string, unknown>>) => new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""))
const attached = { type: "attached", from: "machine" }

test("a reattach that gets somewhere says so, so the last note isn't 'reconnecting…' for a command that is fine", async () => {
  const api = {
    exec: async () => initial(),
    // the machine's own keepalive is a quiet command's progress; its exit comes later on the same stream
    attach: async () => lines(attached, { type: "ping", from: "machine", seq: 1 }, { type: "exit", code: 3 }),
    execExited: () => {},
  } as unknown as VmsClient
  let outcome: unknown
  expect(await notes(async () => (outcome = await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })))).toEqual(["reconnecting…", "reattached"])
  expect(outcome).toMatchObject({ code: 3 })
})

test("'reattached' comes while a quiet reattached stream is still open, not only with its exit", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const send = (event: Record<string, unknown>) => stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`))
  const api = {
    exec: async () => initial(),
    attach: async () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => void (stream = controller) })),
    execExited: () => {},
  } as unknown as VmsClient
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5)
  }
  let beforeExit: string[] = []
  const said = await notes(async (lines) => {
    const running = runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })
    await until(() => stream !== undefined)
    send(attached)
    send({ type: "ping", from: "machine", seq: 1 })
    // the command is still quiet and its stream open: the note is out already
    await until(() => lines.includes("reattached"))
    beforeExit = [...lines]
    send({ type: "exit", code: 0 })
    stream.close()
    await running
  })
  expect(beforeExit).toEqual(["reconnecting…", "reattached"])
  expect(said).toEqual(["reconnecting…", "reattached"])
})

test("a slow reader of the output doesn't hold 'reattached' back", async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const api = {
    exec: async () => initial(),
    attach: async () => lines(attached, { type: "stdout", data: "x\n" }, { type: "exit", code: 0 }),
    execExited: () => {},
  } as unknown as VmsClient
  let whileBlocked: string[] = []
  await notes(async (said) => {
    const running = runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy, output: () => blocked })
    for (let i = 0; i < 400 && !said.includes("reattached"); i++) await Bun.sleep(5)
    whileBlocked = [...said]
    release()
    await running
  })
  expect(whileBlocked).toEqual(["reconnecting…", "reattached"])
})

test("an attach let go of at once is no reattach; each break after a reattach says 'reconnecting…' again", async () => {
  const answers = [
    lines(attached, { type: "detached", reason: "let go" }),
    lines(attached, { type: "stdout", data: "x\n" }, { type: "detached", reason: "cut" }),
    lines(attached, { type: "exit", code: 0 }),
  ]
  const api = {
    exec: async () => initial(),
    attach: async () => answers.shift()!,
    execExited: () => {},
  } as unknown as VmsClient
  expect(await notes(() => runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy, output: () => {} }))).toEqual(["reconnecting…", "reattached", "reconnecting…", "reattached"])
})

test("a long break says it still is one, with how long and why", async () => {
  let attempts = 0
  const api = {
    exec: async () => initial(),
    attach: async () => {
      if (++attempts < 6) throw new ApiError("offline", 503, "node_offline")
      return lines(attached, { type: "exit", code: 0 })
    },
    execExited: () => {},
  } as unknown as VmsClient
  const said = await notes(() => runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy: { ...policy, windowMs: 2_000, stillMs: 30 } }))
  expect(said[0]).toBe("reconnecting…")
  expect(said.some((line) => line.startsWith("still reconnecting to the command in sb_test (") && line.endsWith(" so far: offline)"))).toBe(true)
  expect(said.at(-1)).toBe("reattached")
})

test("an attach that hangs still says the break goes on, then gives up at the window", async () => {
  const api = {
    exec: async () => initial(),
    attach: async (_id: string, _exec: string, _from: unknown, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  } as unknown as VmsClient
  let outcome: unknown
  const said = await notes(async () => (outcome = await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy: { ...policy, windowMs: 400, stillMs: 50 } })))
  expect(outcome).toMatchObject({ code: 125, error: expect.stringContaining("could not reattach") })
  expect(said[0]).toBe("reconnecting…")
  expect(said.filter((line) => line.startsWith("still reconnecting to the command in sb_test (") && line.endsWith(" so far: rollout)")).length).toBeGreaterThan(0)
})

const tick = setImmediate

/** runs `work` on fake timers, jumping to the next timer whenever nothing else is left to run */
async function onFakeTime<T>(work: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  jest.useFakeTimers()
  try {
    const start = Date.now()
    let settled = false
    const running = work().finally(() => {
      settled = true
    })
    running.catch(() => {})
    for (let turns = 0; !settled; turns++) {
      if (turns > 100_000) throw new Error("fake time did not settle")
      await new Promise<void>((resolve) => tick(resolve))
      if (!settled && jest.getTimerCount() > 0) jest.advanceTimersToNextTimer()
    }
    return { value: await running, elapsed: Date.now() - start }
  } finally {
    jest.useRealTimers()
  }
}

const blipPolicy = () => ({ ...withWindowEnv(undefined, reattachPolicy), stillMs: 3_600_000 })
const broken = (...events: Array<Record<string, unknown>>) => lines({ type: "started", id: "a".repeat(32), resumable: true }, ...events, { type: "detached", reason: "the machine disconnected" })

test("a blip longer than two minutes but inside the window: the output goes on from where it broke, and the exit code is the command's", async () => {
  const out: string[] = []
  const from: unknown[] = []
  let blipEnds = 0
  const api = {
    exec: async () => {
      blipEnds = Date.now() + 3 * 60_000
      return broken({ type: "stdout", data: "before " })
    },
    attach: async (_id: string, _exec: string, offsets: unknown) => {
      if (Date.now() < blipEnds) throw new TypeError("fetch failed")
      from.push({ ...(offsets as object) })
      return lines(attached, { type: "stdout", data: "after" }, { type: "exit", code: 7 })
    },
    execExited: () => {},
  } as unknown as VmsClient
  const { value, elapsed } = await onFakeTime(() => notes(() => runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy: blipPolicy(), output: (_stream, data) => void out.push(String(data)) })))
  expect(value.at(-1)).toBe("reattached")
  expect(out.join("")).toBe("before after")
  expect(from).toEqual([{ stdout: 7, stderr: 0 }])
  expect(elapsed).toBeGreaterThanOrEqual(3 * 60_000)
  expect(elapsed).toBeLessThan(3 * 60_000 + 10_000)
})

test("a blip longer than the window gives up as before: 125, saying how long it tried", async () => {
  let outcome: unknown
  const api = {
    exec: async () => broken(),
    attach: async () => {
      throw new ApiError("bad gateway", 502)
    },
  } as unknown as VmsClient
  const { elapsed } = await onFakeTime(() => notes(async () => (outcome = await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy: blipPolicy() }))))
  expect(outcome).toMatchObject({ code: 125, exit: null, error: "lost the command's stream (bad gateway) and could not reattach within 10m00s; it may still be running in sb_test" })
  expect(elapsed).toBe(600_000)
})

test("a command gone mid-blip stops the retries at once", async () => {
  let attempts = 0
  let goneAt = 0
  let ended = 0
  let outcome: unknown
  const api = {
    exec: async () => broken(),
    attach: async () => {
      if (++attempts < 4) throw new TypeError("fetch failed")
      goneAt = Date.now()
      throw new ApiError("no such command", 404, "exec_not_found")
    },
  } as unknown as VmsClient
  await onFakeTime(() => notes(async () => {
    outcome = await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy: blipPolicy() })
    ended = Date.now()
  }))
  expect(outcome).toMatchObject({ code: 125, lost: true, error: expect.stringContaining("can't be reattached: no such command") })
  expect(attempts).toBe(4)
  expect(ended).toBe(goneAt)
})

test("the waits between reattaches double up to the cap, jittered by up to half, never past it", async () => {
  const at: number[] = []
  const api = {
    exec: async () => broken(),
    attach: async () => {
      at.push(Date.now())
      throw new TypeError("fetch failed")
    },
  } as unknown as VmsClient
  const policy = blipPolicy()
  await onFakeTime(() => notes(() => runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })))
  const waits = at.map((time, index) => time - (index ? at[index - 1]! : at[0]! - policy.baseDelayMs))
  for (const [index, wait] of waits.slice(1).entries()) {
    const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (index + 1))
    expect(wait).toBeGreaterThanOrEqual(Math.floor(nominal / 2))
    expect(wait).toBeLessThanOrEqual(nominal)
  }
  expect(new Set(waits.slice(-20)).size).toBeGreaterThan(1)
  expect(at.length).toBeLessThanOrEqual(policy.windowMs / (policy.maxDelayMs / 2) + 10)
  expect(at.at(-1)! - at[0]!).toBeLessThanOrEqual(policy.windowMs)
})
