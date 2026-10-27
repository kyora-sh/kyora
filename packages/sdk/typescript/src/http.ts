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

/** the Idempotency-Key a caller gave, as `idempotencyKey` or as a header in any casing; two that differ are a TypeError */
export function callerKey(operation: string, idempotencyKey: string | undefined, headers: Record<string, string> | undefined): string | undefined {
  const keys = new Set(Object.entries(headers ?? {}).filter(([name, value]) => name.toLowerCase() === "idempotency-key" && value).map(([, value]) => value))
  if (idempotencyKey) keys.add(idempotencyKey)
  if (keys.size > 1) throw new TypeError(`${operation}: two different idempotency keys, ${[...keys].map((key) => JSON.stringify(key)).join(" and ")}`)
  return keys.values().next().value
}

/** a token a header can carry: visible ASCII, no spaces */
const TOKEN = /^[\x21-\x7e]+$/

/** what a response is read into, inside the call: a body that breaks off mid-way is retried like no answer */
export type Reader<T> = (response: Response, attempt: number) => Promise<T>

const INSPECT = Symbol.for("nodejs.util.inspect.custom")

export class Transport {
  readonly #token: string | undefined

  constructor(
    readonly config: TransportConfig,
    token: string | undefined,
  ) {
    if (token !== undefined && !TOKEN.test(token)) throw new TypeError("the kyora token has characters an HTTP header can't carry (spaces, line breaks or non-ASCII)")
    this.#token = token
  }

  /** an error text with the token taken out */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join("[token]") : text
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.config.baseUrl, token: this.#token ? "[token]" : null }
  }

  [INSPECT](): string {
    return `Transport { baseUrl: ${JSON.stringify(this.config.baseUrl)}, token: ${this.#token ? "[token]" : "none"} }`
  }

  /** the URL of an operation with its path and query parameters filled in */
  url(operation: OperationId, parts: RequestParts = {}): string {
    const spec = OPERATIONS[operation]
    const invalid = (message: string) => new KyoraError({ code: "invalid_request", status: 0, message: `${operation}: ${message}`, operation, class: "invalid", retryable: false })
    const path = spec.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      const value = parts.path?.[name]
      if (value === undefined || value === "") throw invalid(`${name} is required`)
      // an object key takes the rest of the path, its slashes included; a URL resolves "." and ".." segments (and their %2E spellings) away, so none is sent
      const segments = name === "objectKey" ? String(value).split("/") : [String(value)]
      if (segments.some((segment) => segment === "." || segment === "..")) throw invalid(`${name} may not have "." or ".." segments`)
      return segments.map(encodeURIComponent).join("/")
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

  /** a call whose response the caller reads itself (a stream); the call's deadline keeps bounding the body */
  send(operation: OperationId, parts: RequestParts = {}, options: CallOptions = {}): Promise<Response> {
    return this.request(operation, parts, options, null)
  }

  /** a call whose answer is JSON (or nothing, on a 204) */
  json<T>(operation: OperationId, parts: RequestParts = {}, options: CallOptions = {}): Promise<T> {
    return this.request(operation, parts, options, (response) => readJson<T>(operation, response))
  }

  /** a call whose response `read` reads, inside the call's retries and deadline */
  read<T>(operation: OperationId, parts: RequestParts, options: CallOptions, read: Reader<T>): Promise<T> {
    return this.request(operation, parts, options, read)
  }

  /**
   * One call: retried while the error is retryable and the request is safe to repeat (a read, a
   * PUT, PATCH or DELETE, or a request carrying an idempotency key), honouring Retry-After within
   * the call's deadline.
   */
  private async request<T>(operation: OperationId, parts: RequestParts, options: CallOptions, read: Reader<T> | null): Promise<T> {
    const spec = OPERATIONS[operation]
    const streamed = spec.response === "ndjson" || spec.response === "binary"
    const until = endOf(options, streamed ? undefined : this.config.timeoutMs)
    const retry = options.retry === false || this.config.retry === false ? null : { ...this.config.retry, ...options.retry }
    const headers: Record<string, string> = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "idempotency-key"))
    let keyed = parts.keyed === true
    if (spec.idempotencyKey) {
      headers["Idempotency-Key"] = callerKey(operation, parts.idempotencyKey, options.headers) ?? randomKey("sdk-")
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
        const answer = await this.once(operation, parts, headers, until, options.signal)
        try {
          if (answer.response.ok || parts.accept?.includes(answer.response.status)) return read ? await read(answer.response, attempt) : (answer.response as T)
          error = await errorFromResponse(operation, answer.response)
        } catch (caught) {
          throw answer.failure(caught)
        } finally {
          if (read) answer.settle()
        }
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

  /** a failure on the way (no answer, a body that broke off) as a KyoraError, with the token taken out */
  private wrap(operation: OperationId, what: string, error: unknown): KyoraError {
    const detail = this.redact(error instanceof Error ? error.message : String(error))
    return new KyoraError({ code: "network_error", status: 0, message: `${operation}: ${what} (${detail})`, operation, cause: this.sanitize(error) })
  }

  /**
   * A copy of an error that is safe to keep: its name and redacted message, and so on for a few
   * causes down. Never the error itself, which may hold the request and its Authorization header.
   */
  private sanitize(error: unknown, depth = 3): Error | undefined {
    if (!(error instanceof Error) || depth === 0) return undefined
    const nested = this.sanitize((error as { cause?: unknown }).cause, depth - 1)
    const copy = new Error(this.redact(error.message), nested === undefined ? undefined : { cause: nested })
    copy.name = error.name
    return copy
  }

  /** one request and its answer's headers; never retried */
  private async once(operation: OperationId, parts: RequestParts, extra: Record<string, string>, until: number, signal?: AbortSignal): Promise<{ response: Response; failure: (error: unknown) => unknown; settle: () => void }> {
    const spec = OPERATIONS[operation]
    const headers: Record<string, string> = { "user-agent": this.config.userAgent, ...extra }
    if (this.#token) headers.authorization = `Bearer ${this.#token}`
    let body: BodyInit | undefined
    if (parts.body !== undefined && spec.body === "json") {
      headers["content-type"] = "application/json"
      body = JSON.stringify(parts.body)
    } else if (parts.body !== undefined && spec.body === "binary") {
      headers["content-type"] = parts.contentType ?? spec.contentTypes[0] ?? "application/octet-stream"
      body = parts.body as BodyInit
    }
    const url = this.url(operation, parts)
    const remaining = until - Date.now()
    if (remaining <= 0) throw timeoutError(operation)
    const deadline = Number.isFinite(remaining) ? new AbortController() : null
    const deadlineTimer = deadline ? setTimeout(() => deadline.abort(timeoutError(operation)), remaining) : undefined
    // the deadline keeps bounding a body the caller reads later; it holds no process open
    unref(deadlineTimer)
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
    const failure = (error: unknown, what: string) => {
      if (signal?.aborted) return signal.reason ?? error
      if (deadline?.signal.aborted || start?.signal.aborted) return timeoutError(operation, this.sanitize(error))
      if (error instanceof KyoraError) return error
      return this.wrap(operation, what, error)
    }
    let response: Response
    try {
      response = await this.config.fetch(url, init)
    } catch (error) {
      clearTimeout(deadlineTimer)
      throw failure(error, `can't reach ${this.config.baseUrl}`)
    } finally {
      clearTimeout(startTimer)
    }
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      clearTimeout(deadlineTimer)
      throw new KyoraError({ code: "bad_response", status: response.status, message: `${operation}: ${this.config.baseUrl} redirected to ${response.headers.get("location") ?? "?"}; check baseUrl`, operation })
    }
    return { response, failure: (error) => failure(error, "the answer broke off"), settle: () => clearTimeout(deadlineTimer) }
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
