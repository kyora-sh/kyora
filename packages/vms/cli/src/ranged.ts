import { ApiError } from "./api"
import { pause, retryable } from "./multipart"

const MiB = 1024 * 1024

/** bytes per ranged request */
export const WINDOW = 16 * MiB
/** windows in flight or waiting their turn, the one being handed on included */
export const WINDOWS = 4
/** the size of the pieces a window is handed on in */
const SLICE = MiB

export interface RangeSource {
  /** bytes `start` to `end`, both inclusive: a 206 for exactly that range, or an error */
  get(start: number, end: number, signal: AbortSignal): Promise<Response>
}

export interface RangedOptions {
  /** bytes per window (default 16 MiB) */
  window?: number
  /** windows in flight at once, the one being handed on included (default 4) */
  parallel?: number
  /** further tries for a window that failed on the way (default 3) */
  retries?: number
  signal?: AbortSignal
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** the ranges did not pan out, so the first response is read to its end after all */
  onFallback?: (reason: unknown) => void
}

/**
 * The size of the object behind a response that offers byte ranges and is worth
 * splitting (more than one window), else null. An encoded body is left alone: its
 * length is not the object's.
 */
export function rangedSize(response: Response, window = WINDOW): number | null {
  const ranges = response.headers.get("accept-ranges")
  if (!ranges?.split(",").some((unit) => unit.trim().toLowerCase() === "bytes")) return null
  if (response.headers.get("content-encoding")) return null
  const size = Number(response.headers.get("content-length"))
  if (!Number.isSafeInteger(size) || size <= window) return null
  return size
}

/** the server answered a range with something else: it does not do ranges after all */
export class RangeRefused extends Error {}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

/** a window's body into a buffer of exactly its size; anything else is an error */
async function readWindow(response: Response, length: number, what: string): Promise<Uint8Array> {
  const buffer = new Uint8Array(length)
  let filled = 0
  const reader = response.body!.getReader()
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>
      try {
        next = await reader.read()
      } catch (error) {
        throw new ApiError(`${what} broke off: ${error instanceof Error ? error.message : String(error)}`, 0)
      }
      if (next.done) break
      if (filled + next.value.length > length) throw new RangeRefused(`${what}: more bytes came than were asked for`)
      buffer.set(next.value, filled)
      filled += next.value.length
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  if (filled < length) throw new ApiError(`${what} ended after ${filled} of ${length} bytes`, 0)
  return buffer
}

/**
 * The whole object as one ordered stream, fetched as byte ranges in parallel. The first
 * window comes from `first` (the response that offered ranges) as it arrives, while the
 * next ones are fetched `parallel - 1` at a time and handed on in order, so at most
 * `parallel` windows are held. `first` is only dropped once a ranged response proved
 * itself (a 206 for exactly the range asked for) and none failed: a server that does not
 * serve ranges after all, or a window that fails before then, just means `first` is read
 * to its end, as it would have been without ranges. After that a window is retried like
 * a part (network errors, 5xx, 408, 429; three more times) and then fails the stream.
 */
export function rangedStream(first: ReadableStream<Uint8Array>, size: number, source: RangeSource, options: RangedOptions = {}): ReadableStream<Uint8Array> {
  const window = options.window ?? WINDOW
  const parallel = Math.max(2, options.parallel ?? WINDOWS)
  const retries = options.retries ?? 3
  const sleep = options.sleep ?? pause
  const count = Math.ceil(size / window)
  const ranges = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, ranges.signal]) : ranges.signal
  const primary = first.getReader()
  const windows = new Map<number, Promise<Uint8Array>>()
  let state: "first" | "ranged" | "whole" = "first"
  let scheduled = 1
  let offset = 0
  /** what `first` sent past its window, kept until the ranges prove themselves */
  let carry: Uint8Array | null = null
  let current: Uint8Array | null = null
  let proved = false
  let trouble: { error: unknown } | null = null
  let decide!: () => void
  /** settles once a range proved itself or one failed */
  const decision = new Promise<void>((resolve) => (decide = resolve))

  async function fetchWindow(index: number): Promise<Uint8Array> {
    const start = index * window
    const end = Math.min(size, start + window) - 1
    const what = `download bytes ${start}-${end}`
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await source.get(start, end, signal)
        const match = CONTENT_RANGE.exec(response.headers.get("content-range") ?? "")
        if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end || (match[3] !== "*" && Number(match[3]) !== size)) {
          await response.body?.cancel().catch(() => {})
          throw new RangeRefused(`${what}: the server answered ${response.status} ${response.headers.get("content-range") ?? "without a content-range"}`)
        }
        proved = true
        decide()
        return await readWindow(response, end - start + 1, what)
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (error instanceof RangeRefused || attempt >= retries || !retryable(error)) throw error
        await sleep(500 * 2 ** attempt, signal)
      }
    }
  }

  function schedule(): void {
    if (state === "whole") return
    const handing = Math.floor(offset / window)
    while (scheduled < count && scheduled - handing < parallel) {
      const task = fetchWindow(scheduled)
      task.catch((error) => {
        // while `first` is still there, trouble with any window means reading it instead;
        // later the window's turn to be handed on rethrows it
        if (state !== "ranged") trouble ??= { error }
        decide()
      })
      windows.set(scheduled++, task)
    }
  }

  function dropRanges(why: unknown): void {
    ranges.abort(why)
    windows.clear()
  }

  async function next(): Promise<Uint8Array | null> {
    for (;;) {
      options.signal?.throwIfAborted()
      if (offset >= size) return null
      if (state === "first" && offset >= window) {
        await decision
        options.signal?.throwIfAborted()
        if (proved && !trouble) {
          state = "ranged"
          carry = null
          await primary.cancel().catch(() => {})
        } else {
          state = "whole"
          dropRanges(new Error("reading the whole response instead"))
          options.onFallback?.(trouble?.error ?? null)
        }
        continue
      }
      if (state !== "ranged") {
        if (carry) {
          const chunk = carry
          carry = null
          offset += chunk.length
          return chunk
        }
        const { value, done } = await primary.read()
        if (done) throw new ApiError(`the download ended after ${offset} of ${size} bytes`, 0)
        if (state === "first" && offset + value.length > window) {
          const head = value.subarray(0, window - offset)
          carry = value.subarray(window - offset)
          offset += head.length
          return head
        }
        if (offset + value.length > size) throw new ApiError(`the download is longer than the ${size} bytes it announced`, 0)
        offset += value.length
        return value
      }
      const index = Math.floor(offset / window)
      if (!current) {
        schedule()
        current = await windows.get(index)!
        windows.delete(index)
      }
      const within = offset - index * window
      const chunk = current.subarray(within, within + SLICE)
      offset += chunk.length
      if (within + chunk.length >= current.length) {
        current = null
        schedule()
      }
      return chunk
    }
  }

  return new ReadableStream<Uint8Array>(
    {
      start: schedule,
      async pull(controller) {
        try {
          const chunk = await next()
          if (chunk) return controller.enqueue(chunk)
          controller.close()
          dropRanges(new Error("done"))
          await primary.cancel().catch(() => {})
        } catch (error) {
          const cause = options.signal?.aborted ? options.signal.reason : error
          dropRanges(cause)
          await primary.cancel(cause).catch(() => {})
          controller.error(cause)
        }
      },
      async cancel(why) {
        dropRanges(why)
        await primary.cancel(why).catch(() => {})
      },
    },
    { highWaterMark: 0 },
  )
}
