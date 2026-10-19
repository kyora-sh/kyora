export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  return `${Math.round(hours / 24)}d`
}

export const REFRESH_TOKEN_SPENT = "the stored refresh token was already used or revoked: log in again and save"

/** how long a Retry-After header asks to wait, in seconds or as a date, as plain words */
function retryAfter(header: string | null, now = Date.now()): string {
  if (!header) return "later"
  const seconds = /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : Date.parse(header) - now
  if (!Number.isFinite(seconds)) return "later"
  return seconds < 60_000 ? `${Math.max(1, Math.ceil(seconds / 1000))}s` : duration(seconds)
}

/** the OAuth `error` code of a refused token request, only when it is one: never the body itself */
async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const code = body?.error
  return typeof code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/i.test(code) ? code : undefined
}

/** why a token server refused a renewal, in words that never carry a token or the response body */
export async function refusal(response: Response): Promise<string> {
  if (response.status === 429) return `rate limited, try again in ${retryAfter(response.headers.get("retry-after"))}`
  if (response.status >= 500) return `server error (HTTP ${response.status}), try again later`
  const code = await errorCode(response)
  if (code === "invalid_grant") return REFRESH_TOKEN_SPENT
  return `the token server refused it (HTTP ${response.status}${code ? `, ${code}` : ""})`
}

/** a fetch that never reached an answer: a timeout, or no connection */
export function networkFailure(error: unknown): string {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "network error: the token server did not answer in time"
    : "network error: could not reach the token server"
}

/**
 * A token request: its JSON answer, or why there was none. A failure is plain words for the
 * user and never carries a token or the server's body.
 */
export async function tokenRequest(url: string, init: RequestInit): Promise<{ data: Record<string, unknown> } | { failure: string }> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { failure: networkFailure(error) }
  }
  if (!response.ok) return { failure: await refusal(response) }
  const data = (await response.json().catch(() => null)) as unknown
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { failure: "the token server sent an unreadable answer" }
  return { data: data as Record<string, unknown> }
}

/** a live write that failed, saying which of the CLI's credential stores holds what */
export class LiveWriteError extends Error {}
