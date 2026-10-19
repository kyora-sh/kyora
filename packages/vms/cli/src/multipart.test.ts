import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { ApiError } from "./api"
import { PartPool, partsInFlight, sendParts, type PartSink } from "./multipart"

const KiB = 1024

/** `bytes`, handed out in chunks of awkward sizes, the way a zstd stream arrives */
function chunked(bytes: Uint8Array, onCancel?: () => void): ReadableStream<Uint8Array> {
  let offset = 0
  let i = 0
  const sizes = [1, 7 * KiB, 100 * KiB, 333, 64 * KiB, 64 * KiB + 1, 12 * KiB]
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      const size = sizes[i++ % sizes.length]!
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
    cancel: () => onCancel?.(),
  })
}

/** keeps a copy of every part it was given (the buffers get reused), after an optional delay */
function recorder(delay = () => 0) {
  const stored = new Map<number, Uint8Array>()
  const buffers = new Set<ArrayBufferLike>()
  let inFlight = 0
  let maxInFlight = 0
  const sink: PartSink = {
    async put(n, part) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      buffers.add(part.buffer)
      try {
        await Bun.sleep(delay())
        stored.set(n, part.slice())
        return `etag-${n}`
      } finally {
        inFlight--
      }
    },
  }
  const joined = () => Buffer.concat([...stored.entries()].sort(([a], [b]) => a - b).map(([, part]) => part))
  return { sink, stored, buffers, joined, maxInFlight: () => maxInFlight }
}

const noSleep = { sleep: async () => {} }

describe("sendParts", () => {
  test("cuts the stream into equal parts but the last, and they add back up to the same bytes", async () => {
    const data = randomBytes(1024 * KiB + 123)
    const { sink, stored, joined } = recorder()
    const sent = await sendParts(sink, chunked(data), 64 * KiB)

    expect(sent.parts.map((part) => part.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
    expect(sent.parts.every((part) => part.etag === `etag-${part.n}`)).toBe(true)
    expect(sent.bytes).toBe(data.length)
    const sizes = [...stored.entries()].sort(([a], [b]) => a - b).map(([, part]) => part.length)
    expect(sizes.slice(0, -1).every((size) => size === 64 * KiB)).toBe(true)
    expect(sizes.at(-1)).toBe(123)
    expect(new Bun.CryptoHasher("sha256").update(joined()).digest("hex")).toBe(new Bun.CryptoHasher("sha256").update(data).digest("hex"))
  })

  test("never has more than two parts in flight, or more than two buffers", async () => {
    const data = randomBytes(640 * KiB)
    const record = recorder(() => Math.random() * 15)
    const sent = await sendParts(record.sink, chunked(data), 32 * KiB)
    expect(sent.parts).toHaveLength(20)
    expect(record.maxInFlight()).toBe(2)
    expect(record.buffers.size).toBeLessThanOrEqual(2)
    expect(record.joined().equals(data)).toBe(true)
  })

  test("a stream of exactly n parts sends no empty part after them, an empty one sends one empty part", async () => {
    const whole = recorder()
    expect((await sendParts(whole.sink, chunked(randomBytes(128 * KiB)), 64 * KiB)).parts).toHaveLength(2)
    const empty = recorder()
    const sent = await sendParts(empty.sink, chunked(new Uint8Array(0)), 64 * KiB)
    expect(sent.parts).toEqual([{ n: 1, etag: "etag-1" }])
    expect(empty.stored.get(1)!.length).toBe(0)
  })

  test("a part that fails on the way is sent again, with backoff, from the same bytes", async () => {
    const data = randomBytes(300 * KiB)
    const record = recorder()
    const tries: number[] = []
    const sleeps: number[] = []
    const sink: PartSink = {
      async put(n, part, signal) {
        if (n === 3) {
          tries.push(part.length)
          if (tries.length === 1) throw new ApiError("upload part 3: HTTP 502 from something in front of kyora cloud", 502)
          if (tries.length === 2) throw new ApiError("upload part 3: can't reach it (socket closed)", 0)
        }
        return record.sink.put(n, part, signal)
      },
    }
    const sent = await sendParts(sink, chunked(data), 64 * KiB, { sleep: async (ms) => void sleeps.push(ms) })
    expect(tries).toEqual([64 * KiB, 64 * KiB, 64 * KiB])
    expect(sleeps).toEqual([500, 1000])
    expect(sent.parts).toHaveLength(5)
    expect(record.joined().equals(data)).toBe(true)
  })

  test("gives up after three retries, stops the stream and says why", async () => {
    let cancelled = false
    const sleeps: number[] = []
    let tries = 0
    const sink: PartSink = {
      async put(n) {
        if (n === 2) {
          tries++
          throw new ApiError("upload part 2: internal error", 500)
        }
        return `etag-${n}`
      },
    }
    const attempt = sendParts(sink, chunked(randomBytes(512 * KiB), () => (cancelled = true)), 64 * KiB, { sleep: async (ms) => void sleeps.push(ms) })
    await expect(attempt).rejects.toThrow("upload part 2: internal error")
    expect(tries).toBe(4)
    expect(sleeps).toEqual([500, 1000, 2000])
    expect(cancelled).toBe(true)
  })

  test("a refusal (4xx) is not retried", async () => {
    let tries = 0
    const sink: PartSink = {
      async put(n) {
        if (n === 1) {
          tries++
          throw new ApiError("upload part 1: no such upload", 404)
        }
        return `etag-${n}`
      },
    }
    await expect(sendParts(sink, chunked(randomBytes(200 * KiB)), 64 * KiB, noSleep)).rejects.toThrow("no such upload")
    expect(tries).toBe(1)
  })

  test("an abort from outside (Ctrl-C) stops at once, without retries", async () => {
    const controller = new AbortController()
    let calls = 0
    const sink: PartSink = {
      // hangs like a slow upload until the abort
      put: (_, __, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          if (++calls === 2) controller.abort(new Error("interrupted by SIGINT"))
        }),
    }
    await expect(sendParts(sink, chunked(randomBytes(512 * KiB)), 64 * KiB, { signal: controller.signal, ...noSleep })).rejects.toThrow("interrupted by SIGINT")
    expect(calls).toBe(2)
  })

  test("uploads sharing a pool have no more parts in flight together than it has, or buffers", async () => {
    const pool = new PartPool(4)
    const data = [randomBytes(700 * KiB), randomBytes(333 * KiB), randomBytes(1024 * KiB + 7)]
    let inFlight = 0
    let most = 0
    const buffers = new Set<ArrayBufferLike>()
    const records = data.map(() => recorder(() => 2 + Math.random() * 5))
    const sent = await Promise.all(
      data.map((bytes, i) =>
        sendParts(
          {
            async put(n, part, signal) {
              inFlight++
              most = Math.max(most, inFlight)
              buffers.add(part.buffer)
              try {
                return await records[i]!.sink.put(n, part, signal)
              } finally {
                inFlight--
              }
            },
          },
          chunked(bytes),
          32 * KiB,
          { pool },
        ),
      ),
    )
    expect(most).toBe(4)
    expect(pool.mostOut).toBe(4)
    expect(buffers.size).toBeLessThanOrEqual(4)
    for (const [i, bytes] of data.entries()) {
      expect(records[i]!.joined().equals(bytes)).toBe(true)
      expect(sent[i]!.parts).toHaveLength(Math.ceil(bytes.length / (32 * KiB)))
    }
  })

  test("a part size of its own does not grow the pool past its size", async () => {
    const pool = new PartPool(2)
    const signal = new AbortController().signal
    const a = await pool.take(1000, signal)
    const b = await pool.take(1000, signal)
    pool.give(a)
    pool.give(b)
    const c = await pool.take(2000, signal)
    expect(c.length).toBe(2000)
    // one of the two idle 1000-byte buffers went to make room
    expect([a, b]).not.toContain(c)
    const d = await pool.take(1000, signal)
    expect([a, b]).toContain(d)
  })

  test("waiting for a buffer ends with an abort, and leaves no place in the queue", async () => {
    const pool = new PartPool(1)
    const signal = new AbortController().signal
    const held = await pool.take(64, signal)
    const controller = new AbortController()
    const waiting = pool.take(64, controller.signal)
    controller.abort(new Error("interrupted by SIGINT"))
    await expect(waiting).rejects.toThrow("interrupted by SIGINT")
    pool.give(held)
    // the aborted waiter did not swallow the slot
    expect(await Promise.race([pool.take(64, signal).then(() => "taken"), Bun.sleep(50).then(() => "stuck")])).toBe("taken")
  })

  test("parts in flight: eight, fewer where eight would pass 256 MiB, never under two", () => {
    expect(partsInFlight(8 * 1024 * KiB)).toBe(8)
    expect(partsInFlight(32 * 1024 * KiB)).toBe(8)
    expect(partsInFlight(64 * 1024 * KiB)).toBe(4)
    expect(partsInFlight(128 * 1024 * KiB)).toBe(2)
    expect(partsInFlight(1024 * 1024 * KiB)).toBe(2)
  })

  test("a stream that breaks mid-way fails the upload with its own error", async () => {
    let sent = 0
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 3) controller.enqueue(randomBytes(40 * KiB))
        else controller.error(new Error("packing failed: EIO"))
      },
    })
    const { sink } = recorder()
    await expect(sendParts(sink, broken, 64 * KiB, noSleep)).rejects.toThrow("packing failed: EIO")
  })
})
