import { ApiError, type Part } from "./api"

/**
 * Reads exactly `buffer.length` bytes (fewer only at the end of the stream) into
 * `buffer`, keeping what overflows a chunk for the next part.
 */
export class PartReader {
  private carry: Uint8Array | null = null
  private ended = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  get done(): boolean {
    return this.ended && !this.carry
  }

  async fill(buffer: Uint8Array, signal?: AbortSignal): Promise<number> {
    let filled = 0
    while (filled < buffer.length) {
      // a Ctrl-C should not wait for up to a whole part of packing
      signal?.throwIfAborted()
      let chunk = this.carry
      this.carry = null
      if (!chunk) {
        if (this.ended) break
        const next = await this.reader.read()
        if (next.done) {
          this.ended = true
          break
        }
        chunk = next.value
      }
      const take = Math.min(chunk.length, buffer.length - filled)
      buffer.set(chunk.subarray(0, take), filled)
      filled += take
      if (take < chunk.length) this.carry = chunk.subarray(take)
    }
    return filled
  }
}

/** where the parts go; returns each part's etag */
export interface PartSink {
  put(n: number, part: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string>
}

export interface PartProgress {
  /** the part that just finished */
  n: number
  /** bytes in finished parts */
  bytes: number
  /** parts cut from the stream so far, finished or not */
  cut: number
}

export interface SendPartsOptions {
  signal?: AbortSignal
  /** parts in flight at once, each holding a buffer of partSize (default 2); a pool overrides it */
  parallel?: number
  /** slots and buffers shared with other uploads (the shards of one push) */
  pool?: PartPool
  /** further tries for a part that failed on the way (default 3) */
  retries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onPart?: (progress: PartProgress) => void
}

export interface SentParts {
  parts: Part[]
  bytes: number
}

/** worth another try: the network, a 5xx (Cloudflare's own error pages included), 408, 429 */
export function retryable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 429)
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const done = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}

const MiB = 1024 * 1024

/** the most parts one push has in flight, all its shards together */
export const MAX_PARTS_IN_FLIGHT = 8
/**
 * And the most their buffers may take: four of kyora cloud's 64 MiB parts, eight of 32 MiB.
 * Packing's garbage grows with them, so a push peaks at about twice this (measured, 1 GB
 * tree: ~650 MiB at four 64 MiB parts, ~1.1 GB at eight, for 1.35× the speed on a link
 * capped per connection). KYORA_VMS_PARTS_IN_FLIGHT overrides the count.
 */
export const PART_MEMORY = 256 * MiB

/** parts in flight for this part size: 8, fewer where their buffers would pass PART_MEMORY, never under 2 */
export function partsInFlight(partSize: number, memory = PART_MEMORY, most = MAX_PARTS_IN_FLIGHT): number {
  return Math.max(2, Math.min(most, Math.floor(memory / Math.max(partSize, 1))))
}

interface Waiter {
  resolve: () => void
  reject: (reason: unknown) => void
}

/**
 * The parts in flight across every upload of one push, and the buffers they sit in.
 * Taking a buffer waits its turn (first come, first served) until fewer than `size`
 * parts are out; giving one back hands it to the next part, whichever shard that is
 * for. A buffer is only ever held by a part being cut or sent, so memory stays at
 * `size` parts however many shards go up at once.
 */
export class PartPool {
  private readonly idle: Uint8Array<ArrayBuffer>[] = []
  private readonly waiting: Waiter[] = []
  private out = 0
  private peak = 0

  constructor(readonly size: number) {}

  /** the most buffers out at once so far */
  get mostOut(): number {
    return this.peak
  }

  async take(partSize: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted()
    if (this.out < this.size) this.out++
    else {
      // give() hands the slot straight over, so `out` already counts it
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve: () => {
            signal.removeEventListener("abort", abort)
            resolve()
          },
          reject,
        }
        const abort = () => {
          const index = this.waiting.indexOf(waiter)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        this.waiting.push(waiter)
      })
    }
    this.peak = Math.max(this.peak, this.out)
    const index = this.idle.findIndex((buffer) => buffer.length === partSize)
    if (index !== -1) return this.idle.splice(index, 1)[0]!
    // one of another size would only sit there; dropping it keeps idle + out within size
    if (this.idle.length + this.out > this.size) this.idle.shift()
    // untouched pages cost nothing, so a small push never pays for a whole part
    return new Uint8Array(partSize)
  }

  give(buffer: Uint8Array<ArrayBuffer>): void {
    this.idle.push(buffer)
    const next = this.waiting.shift()
    if (next) next.resolve()
    else this.out--
  }
}

/**
 * Cuts a stream into `partSize` parts as it is produced and uploads them, `parallel` at
 * a time, or as many as a pool shared with other uploads allows. Each part needs its
 * length up front, so it sits in a buffer of its own until its upload is done (and is
 * retried from there); the buffers are reused, so memory stays at the parts in flight
 * however large the stream. A part that fails for good stops the others and the stream.
 */
export async function sendParts(sink: PartSink, body: ReadableStream<Uint8Array>, partSize: number, options: SendPartsOptions = {}): Promise<SentParts> {
  const pool = options.pool ?? new PartPool(Math.max(1, options.parallel ?? 2))
  const retries = options.retries ?? 3
  const sleep = options.sleep ?? pause
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  const reader = body.getReader()
  const source = new PartReader(reader)
  const running = new Set<Promise<void>>()
  const parts: Part[] = []
  let bytes = 0
  let cut = 0
  let failure = null as { error: unknown } | null

  const fail = (error: unknown) => {
    failure ??= { error }
    stop.abort(error)
  }

  async function upload(n: number, part: Uint8Array<ArrayBuffer>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sink.put(n, part, signal)
      } catch (error) {
        if (signal.aborted || attempt >= retries || !retryable(error)) throw error
        await sleep(500 * 2 ** attempt, signal)
      }
    }
  }

  for (let n = 1; !failure; n++) {
    let buffer: Uint8Array<ArrayBuffer>
    try {
      buffer = await pool.take(partSize, signal)
    } catch (error) {
      fail(error)
      break
    }
    let size: number
    try {
      size = await source.fill(buffer, signal)
    } catch (error) {
      pool.give(buffer)
      fail(error)
      break
    }
    // an empty stream still needs one (empty) part for the upload to complete
    if (size === 0 && n > 1) {
      pool.give(buffer)
      break
    }
    cut = n
    const task: Promise<void> = upload(n, buffer.subarray(0, size)).then(
      (etag) => {
        parts.push({ n, etag })
        bytes += size
        pool.give(buffer)
        try {
          options.onPart?.({ n, bytes, cut })
        } catch {
          // progress is decoration; it must not fail the upload
        }
      },
      (error) => {
        pool.give(buffer)
        fail(error)
      },
    )
    running.add(task)
    void task.finally(() => running.delete(task))
    if (size < partSize || source.done) break
  }
  await Promise.allSettled([...running])
  if (failure) {
    // stop packing: nothing more will be read
    await reader.cancel().catch(() => {})
    throw failure.error
  }
  return { parts: parts.sort((a, b) => a.n - b.n), bytes }
}
