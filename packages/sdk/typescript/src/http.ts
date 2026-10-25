import { errorFromResponse, KyoraError } from "./errors.js"
import { OPERATIONS, type OperationId } from "./generated/operations.js"
import { SPEC_VERSION } from "./generated/errors.js"

export const DEFAULT_BASE_URL = "https://cloud.kyora.sh"

/** How a call repeats a request that failed in a way that can succeed later. */
export interface RetryOptions {
  /** tries in all, the first included (default 4) */
  maxAttempts?: number
  /** the first backoff when kyora sends no Retry-After; doubled per try (default 250 ms) */
  baseDelayMs?: number
  /** the longest backoff (default 5 s) */
  maxDelayMs?: number
  /** a Retry-After longer than this is never waited out: the error is thrown instead (default 30 s) */
  maxRetryAfterMs?: number
}

/**
 * Bounds on how long a call may take, all optional. `deadline` and `timeoutMs` bound the whole call,
 * waits and retries included; a Retry-After that would end past them is thrown as the error it came
 * with instead of waited out. Aborting `signal` stops the call with the signal's reason.
 */
export interface WaitOptions {
  signal?: AbortSignal
  /** ms from the start of the call */
  timeoutMs?: number
  /** an absolute end: epoch ms or a Date */
  deadline?: number | Date
}

export interface CallOptions extends WaitOptions {
  /** false: one try only */
  retry?: RetryOptions | false
  headers?: Record<string, string>
}

export type QueryValue = string | number | boolean | readonly string[] | undefined

export interface RequestParts {
  path?: Record<string, string | number>
  query?: Record<string, QueryValue>
  /** a JSON body, or the raw body of an operation that takes bytes */
  body?: unknown
  contentType?: string
  /** an explicit Idempotency-Key; an operation that takes one gets a fresh key otherwise */
  idempotencyKey?: string
  /** the request carries its own idempotency (an exec `key`), so it repeats safely */
  keyed?: boolean
  /** statuses besides 2xx to hand back instead of throwing */
  accept?: number[]
  /** for streamed answers: how long the response may take to start; the body then takes as long as it takes */
  headersTimeoutMs?: number
}

export interface TransportConfig {
  baseUrl: string
  token: string | undefined
  fetch: typeof fetch
  timeoutMs: number
  retry: Required<RetryOptions> | false
  userAgent: string
}

export const DEFAULT_RETRY: Required<RetryOptions> = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 5_000, maxRetryAfterMs: 30_000 }

const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "PATCH"])

/** the epoch ms a call must end by, or Infinity */
export function endOf(options: WaitOptions, fallbackMs?: number): number {
  const now = Date.now()
  const timeout = options.timeoutMs ?? fallbackMs
  const byTimeout = timeout === undefined ? Infinity : now + timeout
  const byDeadline = options.deadline === undefined ? Infinity : options.deadline instanceof Date ? options.deadline.getTime() : options.deadline
  return Math.min(byTimeout, byDeadline)
}

export function timeoutError(operation: string, cause?: unknown): KyoraError {
  return new KyoraError({ code: "timeout", status: 0, message: `${operation}: the deadline passed`, operation, cause })
}

/** waits `ms`, or rejects with the signal's reason once it aborts */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const stop = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener("abort", stop, { once: true })
  })
}

/** a timer that does not keep Node or Bun running */
export function unref(timer: ReturnType<typeof setTimeout> | undefined): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

const isStream = (body: unknown): body is ReadableStream => typeof ReadableStream !== "undefined" && body instanceof ReadableStream

export function randomKey(prefix: string): string {
  return `${prefix}${globalThis.crypto.randomUUID()}`
}

export class Transport {
  constructor(readonly config: TransportConfig) {}

  /** the URL of an operation with its path and query parameters filled in */
  url(operation: OperationId, parts: RequestParts = {}): string {
    const spec = OPERATIONS[operation]
    const path = spec.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      const value = parts.path?.[name]
      if (value === undefined || value === "") throw new KyoraError({ code: "invalid_request", status: 0, message: `${operation}: ${name} is required`, operation, class: "invalid", retryable: false })
      // an object key takes the rest of the path, its slashes included
      return name === "objectKey" ? String(value).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(value))
    })
    const query = new URLSearchParams()
    for (const [name, value] of Object.entries(parts.query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) query.append(name, item)
      else query.set(name, String(value))
    }
    const text = query.toString()
    return `${this.config.baseUrl}${path}${text ? `?${text}` : ""}`
  }

  /**
   * One call: retried while the error is retryable and the request is safe to repeat (a read, a
   * PUT, PATCH or DELETE, or a request carrying an idempotency key), honouring Retry-After within
   * the call's deadline. Returns the response for the caller to read.
   */
  async send(operation: OperationId, parts: RequestParts = {}, options: CallOptions = {}): Promise<Response> {
    const spec = OPERATIONS[operation]
    const streamed = spec.response === "ndjson" || spec.response === "binary"
    const until = endOf(options, streamed ? undefined : this.config.timeoutMs)
    const retry = options.retry === false || this.config.retry === false ? null : { ...this.config.retry, ...options.retry }
    const headers: Record<string, string> = { ...options.headers }
    let keyed = parts.keyed === true
    if (spec.idempotencyKey) {
      headers["Idempotency-Key"] = parts.idempotencyKey ?? randomKey("sdk-")
      keyed = true
    }
    const replayable = !isStream(parts.body)
    const repeatable = (error: KyoraError) => {
      if (!replayable || !error.retryable) return false
      if (keyed || REPEATABLE_METHODS.has(spec.method)) return true
      // an unkeyed write is repeated only when kyora refused it outright
      return error.status === 429
    }
    for (let attempt = 1; ; attempt++) {
      let error: KyoraError
      try {
        const response = await this.once(operation, parts, headers, until, options.signal)
        if (response.ok || parts.accept?.includes(response.status)) return response
        error = await errorFromResponse(operation, response)
      } catch (caught) {
        if (options.signal?.aborted) throw options.signal.reason ?? caught
        if (!(caught instanceof KyoraError)) throw caught
        error = caught
      }
      if (!retry || attempt >= retry.maxAttempts || !repeatable(error) || error.code === "timeout") throw error
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
      const wait = error.retryAfterMs ?? backoff
      if (wait > retry.maxRetryAfterMs || Date.now() + wait >= until) throw error
      await pause(wait, options.signal)
    }
  }

  /** one request and its answer's headers; never retried */
  private async once(operation: OperationId, parts: RequestParts, extra: Record<string, string>, until: number, signal?: AbortSignal): Promise<Response> {
    const spec = OPERATIONS[operation]
    const headers: Record<string, string> = { "user-agent": this.config.userAgent, ...extra }
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`
    let body: BodyInit | undefined
    if (parts.body !== undefined && spec.body === "json") {
      headers["content-type"] = "application/json"
      body = JSON.stringify(parts.body)
    } else if (parts.body !== undefined && spec.body === "binary") {
      headers["content-type"] = parts.contentType ?? spec.contentTypes[0] ?? "application/octet-stream"
      body = parts.body as BodyInit
    }
    const remaining = until - Date.now()
    if (remaining <= 0) throw timeoutError(operation)
    const deadline = Number.isFinite(remaining) ? new AbortController() : null
    const deadlineTimer = deadline ? setTimeout(() => deadline.abort(timeoutError(operation)), remaining) : undefined
    const start = parts.headersTimeoutMs ? new AbortController() : null
    const startTimer = start ? setTimeout(() => start.abort(timeoutError(operation)), parts.headersTimeoutMs) : undefined
    const signals = [signal, deadline?.signal, start?.signal].filter((item): item is AbortSignal => item !== undefined)
    const init: RequestInit & { duplex?: "half" } = {
      method: spec.method,
      headers,
      body,
      // a redirect would carry the token to wherever it points
      redirect: "manual",
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    }
    if (isStream(body)) init.duplex = "half"
    let response: Response
    try {
      response = await this.config.fetch(this.url(operation, parts), init)
    } catch (error) {
      clearTimeout(deadlineTimer)
      if (signal?.aborted) throw signal.reason ?? error
      if (deadline?.signal.aborted || start?.signal.aborted) throw timeoutError(operation, error)
      if (error instanceof KyoraError) throw error
      throw new KyoraError({ code: "network_error", status: 0, message: `${operation}: can't reach ${this.config.baseUrl} (${error instanceof Error ? error.message : String(error)})`, operation, cause: error })
    } finally {
      clearTimeout(startTimer)
    }
    // the deadline keeps bounding the body while it is read; once read, its abort is a no-op, and the timer holds no process open
    unref(deadlineTimer)
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      throw new KyoraError({ code: "bad_response", status: response.status, message: `${operation}: ${this.config.baseUrl} redirected to ${response.headers.get("location") ?? "?"}; check baseUrl`, operation })
    }
    return response
  }

  /** a call whose answer is JSON (or nothing, on a 204) */
  async json<T>(operation: OperationId, parts: RequestParts = {}, options: CallOptions = {}): Promise<T> {
    const response = await this.send(operation, parts, options)
    return readJson<T>(operation, response)
  }
}

export async function readJson<T>(operation: string, response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new KyoraError({ code: "bad_response", status: response.status, message: `${operation}: the answer is not JSON`, operation, cause: error })
  }
}

export const USER_AGENT = `kyora-sdk-typescript (api ${SPEC_VERSION})`
