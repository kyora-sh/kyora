import { afterEach, expect, spyOn, test } from "bun:test"
import { ApiError, VmsClient } from "./api"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const reset = (retryAfter = "0") => Response.json({ error: "do_reset", message: "kyora cloud restarted while it answered; try again" }, { status: 503, headers: { "retry-after": retryAfter } })
const client = () => new VmsClient({ url: "https://cloud.test", key: "kyora_test" })

function serve(answers: Array<() => Response>): { calls: Array<{ method: string; path: string; at: number }> } {
  const calls: Array<{ method: string; path: string; at: number }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, at: Date.now() })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!
    return next()
  }) as typeof fetch
  return { calls }
}

for (const body of ["", "<html>Bad Gateway</html>"]) test(`non-JSON server errors use plain wording (${body ? "HTML" : "empty"})`, async () => {
  serve([() => new Response(body, { status: 502 })])
  for (const key of ["kvms_test", "kyora_test"]) {
    await expect(new VmsClient({ url: "https://cloud.test", key }).list()).rejects.toMatchObject({
      status: 502, message: expect.stringContaining("the server request failed (HTTP 502)"),
    })
  }
})

test("a GET answered do_reset is asked again after the server's Retry-After", async () => {
  const { calls } = serve([() => reset("1"), () => Response.json({ sandboxes: [] })])
  expect(await client().list()).toEqual([])
  expect(calls).toHaveLength(2)
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(900)
})

test("a Retry-After past the overall deadline is not waited out", async () => {
  const { calls } = serve([() => reset("60")])
  const started = Date.now()
  const error = await client().list().catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({ status: 503, code: "do_reset", retryAfterMs: 60_000 })
  expect(calls).toHaveLength(1)
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("repeated do_reset on a GET stops at the try budget", async () => {
  const { calls } = serve([() => reset("0")])
  await expect(client().list()).rejects.toMatchObject({ code: "do_reset" })
  expect(calls).toHaveLength(4)
})

test("a create answered do_reset is never sent again", async () => {
  const { calls } = serve([() => reset("0"), () => Response.json({ id: "sb_a" }, { status: 201 })])
  await expect(client().create({ image: "default" } as never)).rejects.toMatchObject({ status: 503, code: "do_reset" })
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
  expect(calls).toHaveLength(1)
})

test("a create whose do_reset or internal error carries its key back is sent again with the same key, and only then", async () => {
  const sent: Array<{ key: string | null; version: string | null }> = []
  const answers: Array<(key: string) => Response> = [
    (key) => { const r = reset("0"); r.headers.set("idempotency-key", key); return r },
    (key) => Response.json({ error: "internal", message: "internal error" }, { status: 500, headers: { "idempotency-key": key } }),
    (key) => Response.json({ id: "sb_a" }, { status: 201, headers: { "idempotency-key": key } }),
  ]
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({ key: headers.get("idempotency-key"), version: headers.get("cloudflare-workers-version-key") })
    return answers[sent.length - 1]!(headers.get("idempotency-key")!)
  }) as typeof fetch
  expect(await client().create({ image: "default" } as never)).toMatchObject({ id: "sb_a" })
  expect(sent).toHaveLength(3)
  expect(new Set(sent.map((call) => call.key)).size).toBe(1)
  expect(sent.every((call) => call.key && call.version === call.key)).toBe(true)
})

for (const [label, answer] of [
  ["no_capacity under the key", (key: string) => Response.json({ error: "no_capacity", message: "no room" }, { status: 503, headers: { "idempotency-key": key } })],
  ["an internal error without it", () => Response.json({ error: "internal", message: "internal error" }, { status: 500 })],
] as const) test(`a create answered ${label} is not sent again`, async () => {
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    return answer(new Headers(init?.headers).get("idempotency-key")!)
  }) as typeof fetch
  await expect(client().create({ image: "default" } as never)).rejects.toBeInstanceOf(ApiError)
  expect(calls).toBe(1)
})

test("a healthy download can prepare its archive beyond the reset retry deadline", async () => {
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((work: () => void, ms: number) => realTimeout(work, ms > 10_000 ? 5 : ms)) as typeof setTimeout)
  let signal: AbortSignal | undefined
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const ready = realTimeout(() => resolve(new Response("download")), 20)
      signal?.addEventListener("abort", () => { clearTimeout(ready); reject(signal!.reason) }, { once: true })
    })
  }) as typeof fetch
  try {
    const response = await client().download("sb_a", ["/work"], true)
    expect(await response.text()).toBe("download")
    expect(signal).toBeUndefined()
  } finally { timer.mockRestore() }
})

test("a queued create keeps polling through do_reset instead of giving up", async () => {
  const ticket = { status: "queued", ticket: "tkt_1", position: 1 }
  let polls = 0
  const answers = [
    () => Response.json(ticket, { status: 202 }),
    () => { polls++; return reset("0") },
    () => { polls++; return reset("0") },
    () => { polls++; return Response.json({ id: "sb_made", status: "running" }, { status: 201 }) },
  ]
  let n = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/v1/health")) return Response.json({ version: "kyora-cloud" })
    return answers[Math.min(n++, answers.length - 1)]!()
  }) as typeof fetch
  const made = await client().create({ image: "default" } as never, { wait: 30 })
  expect(made).toMatchObject({ id: "sb_made" })
  expect(polls).toBe(3)
})

test("slow reset retries are aborted within the remaining overall deadline", async () => {
  let now = 0
  let calls = 0
  let signal: AbortSignal | undefined
  const timeouts: number[] = []
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    timeouts.push(ms)
    return realTimeout(ms / 1_000)
  })
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls === 1) { now = 20_000; return reset("0") }
    if (calls === 2) { now = 34_000; return reset("0") }
    signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ sandboxes: [] })), 20)
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal!.reason) }, { once: true })
    })
  }) as typeof fetch
  try {
    await expect(client().list()).rejects.toBeInstanceOf(ApiError)
    expect(calls).toBe(3)
    expect(timeouts).toEqual([30_000, 15_000, 1_000])
    expect(signal?.aborted).toBe(true)
  } finally { timeout.mockRestore(); clock.mockRestore() }
})

test("a sleep that overruns the reset deadline does not start another request", async () => {
  let now = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((work: () => void, ms: number) => {
    if (ms === 200) return realTimeout(() => { now = 15_001; work() }, 0)
    return realTimeout(work, ms)
  }) as typeof setTimeout)
  const { calls } = serve([() => reset("0"), () => Response.json({ sandboxes: [] })])
  try {
    await expect(client().list()).rejects.toMatchObject({ code: "do_reset" })
    expect(calls).toHaveLength(1)
  } finally { timer.mockRestore(); clock.mockRestore() }
})

test("the reset deadline aborts requests without a configured timeout", async () => {
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((work: () => void, ms: number) => realTimeout(work, ms > 10_000 ? 5 : ms)) as typeof setTimeout)
  let signal: AbortSignal | undefined
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls === 1) return reset("0")
    signal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal!.reason), { once: true })
    })
  }) as typeof fetch
  try {
    await expect(client().fetchRaw("download", "/v1/download")).rejects.toBeInstanceOf(ApiError)
    expect(calls).toBe(2)
    expect(signal?.aborted).toBe(true)
  } finally { timer.mockRestore() }
})

test("the reset deadline is cleared once a successful stream starts", async () => {
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((work: () => void, ms: number) => realTimeout(work, ms > 10_000 ? 5 : ms)) as typeof setTimeout)
  let signal: AbortSignal | undefined
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls === 1) return reset("0")
    signal = init?.signal ?? undefined
    return new Response(new ReadableStream({ start: (controller) => {
      realTimeout(() => { controller.enqueue(new TextEncoder().encode("download")); controller.close() }, 20)
    } }))
  }) as typeof fetch
  try {
    const response = await client().fetchRaw("download", "/v1/download")
    expect(await response.text()).toBe("download")
    expect(calls).toBe(2)
    expect(signal?.aborted).toBe(false)
  } finally { timer.mockRestore() }
})
