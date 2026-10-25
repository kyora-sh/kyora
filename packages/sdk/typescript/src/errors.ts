import { ERROR_CODES, type ErrorClass, type ErrorCode, type ErrorCodeEntry } from "./generated/errors.js"

/**
 * Codes the SDK itself raises, for failures that never got an answer from kyora:
 * `timeout` (the deadline or the request timeout passed), `network_error` (no answer),
 * `bad_response` (an answer the SDK can't read), `stream_lost` (an exec stream broke and could not
 * be reattached in time) and `exec_error` (kyora reported the exec stream failed).
 */
export type ClientErrorCode = "timeout" | "network_error" | "bad_response" | "stream_lost" | "exec_error"

const CLIENT_CODES: Record<ClientErrorCode, { class: ErrorClass; retryable: boolean }> = {
  timeout: { class: "transient", retryable: true },
  network_error: { class: "transient", retryable: true },
  bad_response: { class: "unavailable", retryable: false },
  stream_lost: { class: "transient", retryable: true },
  exec_error: { class: "unavailable", retryable: false },
}

export interface KyoraErrorInit {
  code: string
  status: number
  message: string
  retryable?: boolean
  retryAfterMs?: number
  class?: ErrorClass
  operation?: string
  body?: unknown
  cause?: unknown
}

/**
 * Every failure of a call. Branch on `code` (or on `class` for a family of codes), never on
 * `message`. `status` is the HTTP status, or 0 when nothing answered. `retryable` says whether the
 * same request can succeed later; `retryAfterMs` is the least wait kyora asked for.
 */
export class KyoraError extends Error {
  override readonly name = "KyoraError"
  readonly code: ErrorCode | ClientErrorCode | (string & {})
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly class: ErrorClass
  /** the operationId of the call that failed */
  readonly operation: string | undefined
  /** the error body as kyora sent it, with any fields beyond `error` and `message` */
  readonly body: unknown

  constructor(init: KyoraErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    const known = classify(init.code, init.status)
    this.code = init.code
    this.status = init.status
    this.class = init.class ?? known.class
    this.retryable = init.retryable ?? known.retryable
    this.retryAfterMs = init.retryAfterMs
    this.operation = init.operation
    this.body = init.body
  }
}

/** whether `error` is a KyoraError, optionally of one class */
export function isKyoraError(error: unknown, errorClass?: ErrorClass): error is KyoraError {
  return error instanceof KyoraError && (errorClass === undefined || error.class === errorClass)
}

function statusClass(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth"
  if (status === 402 || status === 413) return "limit"
  if (status === 404 || status === 410) return "not_found"
  if (status === 409) return "conflict"
  if (status === 429 || status === 502 || status === 503 || status === 504 || status === 0) return "transient"
  if (status >= 500) return "unavailable"
  return "invalid"
}

const statusRetryable = (status: number) => status === 0 || status === 429 || status === 502 || status === 503 || status === 504

/**
 * The class and retryability of a code at a status, from the catalog (x-kyora-error-codes). A code
 * the catalog doesn't know (one newer than this SDK) is taken by its status, as the spec asks.
 */
export function classify(code: string, status: number): { class: ErrorClass; retryable: boolean } {
  const client = CLIENT_CODES[code as ClientErrorCode]
  if (client) return client
  const entry = (ERROR_CODES as Record<string, ErrorCodeEntry>)[code]
  if (!entry) return { class: statusClass(status), retryable: statusRetryable(status) }
  const retryable = typeof entry.retryable === "boolean" ? entry.retryable : entry.retryable.includes(status)
  return { class: entry.class, retryable }
}

/** Retry-After as milliseconds: delay-seconds or an HTTP date */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds < 0 ? undefined : Math.round(seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** the KyoraError a non-2xx answer stands for; reads (and so consumes) its body */
export async function errorFromResponse(operation: string, response: Response): Promise<KyoraError> {
  const text = await response.text().catch(() => "")
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const code = typeof fields.error === "string" && fields.error ? fields.error : `http_${response.status}`
  const message = typeof fields.message === "string" && fields.message ? fields.message : text.trim() && !text.trimStart().startsWith("<") ? text.trim().slice(0, 200) : `HTTP ${response.status}`
  const after = typeof fields.retryAfterMs === "number" && Number.isFinite(fields.retryAfterMs) && fields.retryAfterMs >= 0 ? Math.round(fields.retryAfterMs) : parseRetryAfter(response.headers.get("retry-after"))
  const init: KyoraErrorInit = { code, status: response.status, message: `${operation}: ${message}`, operation, body }
  if (typeof fields.retryable === "boolean") init.retryable = fields.retryable
  if (after !== undefined) init.retryAfterMs = after
  return new KyoraError(init)
}
