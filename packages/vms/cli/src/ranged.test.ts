import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { ApiError } from "./api"
import { rangedSize, rangedStream, type RangeSource } from "./ranged"

const KiB = 1024
const WINDOW = 64 * KiB
const noSleep = async () => {}

const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** the first response's body: `data` in awkward chunks, noting how much was read and whether it was cancelled */
function firstResponse(data: Uint8Array) {
  const state = { read: 0, cancelled: false }
  const sizes = [1, 7 * KiB, 50 * KiB, 333, 64 * KiB + 1, 12 * KiB]
  let i = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.read >= data.length) return controller.close()
        const chunk = data.slice(state.read, state.read + sizes[i++ % sizes.length]!)
        state.read += chunk.length
        controller.enqueue(chunk)
      },
      cancel() {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, state }
}

interface Get {
  start: number
  end: number
}

/** a server that serves ranges of `data`; `answer` may replace (or delay) any of them */
function server(data: Uint8Array, answer?: (get: Get, attempt: number, signal: AbortSignal) => Promise<Response | null> | Response | null) {
  const gets: Get[] = []
  const attempts = new Map<number, number>()
  let inFlight = 0
  let maxInFlight = 0
  const aborted: number[] = []
  const source: RangeSource = {
    async get(start, end, signal) {
      const get = { start, end }
      gets.push(get)
      const attempt = (attempts.get(start) ?? 0) + 1
      attempts.set(start, attempt)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      signal.addEventListener("abort", () => aborted.push(start), { once: true })
      try {
        const custom = await answer?.(get, attempt, signal)
        if (custom) return custom
        return new Response(data.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${data.length}` } })
      } finally {
        inFlight--
      }
    },
  }
  return { source, gets, aborted, maxInFlight: () => maxInFlight }
}

async function collect(stream: ReadableStream<Uint8Array>, onChunk?: () => Promise<void> | void): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return new Uint8Array(Buffer.concat(parts))
    parts.push(value)
    await onChunk?.()
  }
}

const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))

describe("rangedSize", () => {
  const response = (headers: Record<string, string>) => new Response(null, { headers })
  test("only a byte-range offer for more than one window counts", () => {
    expect(rangedSize(response({ "accept-ranges": "bytes", "content-length": String(3 * WINDOW) }), WINDOW)).toBe(3 * WINDOW)
    expect(rangedSize(response({ "accept-ranges": "none, Bytes", "content-length": String(WINDOW + 1) }), WINDOW)).toBe(WINDOW + 1)
    expect(rangedSize(response({ "accept-ranges": "bytes", "content-length": String(WINDOW) }), WINDOW)).toBeNull()
    expect(rangedSize(response({ "accept-ranges": "none", "content-length": String(3 * WINDOW) }), WINDOW)).toBeNull()
    expect(rangedSize(response({ "content-length": String(3 * WINDOW) }), WINDOW)).toBeNull()
    expect(rangedSize(response({ "accept-ranges": "bytes" }), WINDOW)).toBeNull()
    expect(rangedSize(response({ "accept-ranges": "bytes", "content-length": String(3 * WINDOW), "content-encoding": "gzip" }), WINDOW)).toBeNull()
  })
})

describe("rangedStream", () => {
  test("hands on exactly the object in order: the first window from the first response, the rest as ranges", async () => {
    const data = new Uint8Array(randomBytes(5 * WINDOW + 123))
    const first = firstResponse(data)
    const { source, gets } = server(data, async ({ start }) => {
      // out of order on purpose
      await Bun.sleep(start === WINDOW ? 30 : Math.random() * 10)
      return null
    })
    const out = await collect(rangedStream(first.stream, data.length, source, { window: WINDOW }))
    expect(sha(out)).toBe(sha(data))
    expect(gets.map((get) => [get.start, get.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([1, 2, 3, 4, 5].map((i) => [i * WINDOW, Math.min(data.length, (i + 1) * WINDOW) - 1]))
    // dropped once its window was out: at most one chunk past it was read
    expect(first.state.cancelled).toBe(true)
    expect(first.state.read).toBeLessThanOrEqual(WINDOW + 64 * KiB + 1)
  })

  test("keeps at most `parallel` windows fetched or waiting, however slow the reader", async () => {
    const data = new Uint8Array(randomBytes(12 * WINDOW))
    const first = firstResponse(data)
    const { source, gets, maxInFlight } = server(data, async () => {
      await Bun.sleep(Math.random() * 5)
      return null
    })
    const stream = rangedStream(first.stream, data.length, source, { window: WINDOW, parallel: 4 })
    const reader = stream.getReader()
    const parts: Uint8Array[] = []
    let received = 0
    let most = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
      received += value.length
      // windows asked for (the first response's own included) and not yet all handed on
      most = Math.max(most, 1 + gets.length - Math.floor(received / WINDOW))
      await Bun.sleep(1)
    }
    expect(sha(new Uint8Array(Buffer.concat(parts)))).toBe(sha(data))
    expect(gets).toHaveLength(11)
    expect(most).toBe(4)
    expect(maxInFlight()).toBeLessThanOrEqual(4)
  })

  test("a server that answers a range with the whole object (200): the first response is read to its end instead", async () => {
    const data = new Uint8Array(randomBytes(3 * WINDOW + 5))
    const first = firstResponse(data)
    const fallbacks: unknown[] = []
    const { source } = server(data, () => new Response(data, { status: 200 }))
    const out = await collect(rangedStream(first.stream, data.length, source, { window: WINDOW, onFallback: (reason) => fallbacks.push(reason) }))
    expect(sha(out)).toBe(sha(data))
    expect(first.state.read).toBe(data.length)
    expect(String(fallbacks[0])).toContain("the server answered 200")
  })

  test("a range that fails before the first response is dropped: that one is read whole, nothing twice", async () => {
    const data = new Uint8Array(randomBytes(4 * WINDOW))
    const first = firstResponse(data)
    const fallbacks: unknown[] = []
    // window 1 would have proved ranges, but window 2 fails for good first
    const { source, aborted } = server(data, async ({ start }, _, signal) => {
      if (start === WINDOW) return hang(signal)
      if (start === 2 * WINDOW) return Response.json({ error: "not_found" }, { status: 404 })
      return null
    })
    const failing: RangeSource = {
      async get(start, end, signal) {
        const response = await source.get(start, end, signal)
        if (response.status === 404) throw new ApiError("download bytes: no such download", 404)
        return response
      },
    }
    const out = await collect(rangedStream(first.stream, data.length, failing, { window: WINDOW, onFallback: (reason) => fallbacks.push(reason) }))
    expect(sha(out)).toBe(sha(data))
    expect(first.state.read).toBe(data.length)
    expect(String(fallbacks[0])).toContain("no such download")
    // the ranges still out were dropped
    expect(aborted).toContain(WINDOW)
  })

  test("a window that breaks off or meets a 5xx is fetched again, with backoff", async () => {
    const data = new Uint8Array(randomBytes(4 * WINDOW))
    const first = firstResponse(data)
    const sleeps: number[] = []
    const { source, gets } = server(data, ({ start, end }, attempt) => {
      if (start === 2 * WINDOW && attempt === 1) throw new ApiError("download bytes: HTTP 502 from something in front of kyora cloud", 502)
      // a body that stops short
      if (start === 2 * WINDOW && attempt === 2) return new Response(data.slice(start, start + 100), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${data.length}` } })
      return null
    })
    const out = await collect(rangedStream(first.stream, data.length, source, { window: WINDOW, sleep: async (ms) => void sleeps.push(ms) }))
    expect(sha(out)).toBe(sha(data))
    expect(gets.filter((get) => get.start === 2 * WINDOW)).toHaveLength(3)
    expect(sleeps).toEqual([500, 1000])
  })

  test("once the ranges took over, a window that keeps failing fails the stream", async () => {
    const data = new Uint8Array(randomBytes(4 * WINDOW))
    const first = firstResponse(data)
    let tries = 0
    const { source } = server(data, ({ start }) => {
      if (start !== 3 * WINDOW) return null
      tries++
      throw new ApiError("download bytes: internal error", 500)
    })
    // window 3 only starts failing after the first response was dropped
    const slow: RangeSource = {
      async get(start, end, signal) {
        if (start === 3 * WINDOW) await Bun.sleep(40)
        return source.get(start, end, signal)
      },
    }
    const stream = rangedStream(first.stream, data.length, slow, { window: WINDOW, sleep: noSleep })
    await expect(collect(stream)).rejects.toThrow("download bytes: internal error")
    expect(tries).toBe(4)
    expect(first.state.cancelled).toBe(true)
  })

  test("more bytes than the range asked for is a refusal, not a retry", async () => {
    const data = new Uint8Array(randomBytes(3 * WINDOW))
    const first = firstResponse(data)
    const { source, gets } = server(data, ({ start, end }) => {
      if (start !== 2 * WINDOW) return null
      return new Response(new Uint8Array(end - start + 2), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${data.length}` } })
    })
    const slow: RangeSource = {
      async get(start, end, signal) {
        if (start === 2 * WINDOW) await Bun.sleep(40)
        return source.get(start, end, signal)
      },
    }
    await expect(collect(rangedStream(first.stream, data.length, slow, { window: WINDOW, sleep: noSleep }))).rejects.toThrow("more bytes came than were asked for")
    expect(gets.filter((get) => get.start === 2 * WINDOW)).toHaveLength(1)
  })

  test("an abort from outside (Ctrl-C) stops every range and the first response", async () => {
    const data = new Uint8Array(randomBytes(6 * WINDOW))
    const first = firstResponse(data)
    const controller = new AbortController()
    const { source, aborted } = server(data, (_, __, signal) => hang(signal))
    const stream = rangedStream(first.stream, data.length, source, { window: WINDOW, signal: controller.signal })
    const reading = collect(stream, () => {
      if (!controller.signal.aborted) controller.abort(new Error("interrupted by SIGINT"))
    })
    await expect(reading).rejects.toThrow("interrupted by SIGINT")
    expect(aborted.sort((a, b) => a - b)).toEqual([WINDOW, 2 * WINDOW, 3 * WINDOW])
    expect(first.state.cancelled).toBe(true)
  })

  test("a reader that stops early (a broken archive) drops the ranges and the first response", async () => {
    const data = new Uint8Array(randomBytes(6 * WINDOW))
    const first = firstResponse(data)
    const { source, aborted } = server(data, (_, __, signal) => hang(signal))
    const reader = rangedStream(first.stream, data.length, source, { window: WINDOW }).getReader()
    await reader.read()
    await reader.cancel(new Error("not a tar archive"))
    expect(aborted.sort((a, b) => a - b)).toEqual([WINDOW, 2 * WINDOW, 3 * WINDOW])
    expect(first.state.cancelled).toBe(true)
  })

  test("a first response shorter than it said is an error, not a short file", async () => {
    const data = new Uint8Array(randomBytes(3 * WINDOW))
    const first = firstResponse(data.slice(0, WINDOW / 2))
    const { source } = server(data, (_, __, signal) => hang(signal))
    await expect(collect(rangedStream(first.stream, data.length, source, { window: WINDOW }))).rejects.toThrow(`the download ended after ${WINDOW / 2} of ${data.length} bytes`)
  })
})
