import { Kyora, type KyoraOptions } from "../client.js"

export interface Recorded {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array | null
  /** the body parsed as JSON, when it is */
  json: unknown
  signal: AbortSignal | undefined
}

export type Handler = (request: Recorded, index: number) => Response | Promise<Response>

/** a fetch that answers from `handler` and records every request */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = []
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    let body: Uint8Array | null = null
    if (typeof init.body === "string") body = new TextEncoder().encode(init.body)
    else if (init.body instanceof Uint8Array) body = init.body
    else if (init.body instanceof ReadableStream) body = new Uint8Array(await new Response(init.body).arrayBuffer())
    let json: unknown
    try {
      json = body ? JSON.parse(new TextDecoder().decode(body)) : undefined
    } catch {
      json = undefined
    }
    const recorded: Recorded = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers), body, json, signal: init.signal ?? undefined }
    requests.push(recorded)
    if (init.signal?.aborted) throw init.signal.reason
    const answer = handler(recorded, requests.length - 1)
    if (!init.signal) return answer
    return Promise.race([
      answer,
      new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })),
    ])
  }
  return { fetch: fetcher as typeof fetch, requests }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status, headers })
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

export function error(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json(status, { error: code, message: `${code} happened`, ...extra }, headers)
}

/**
 * An NDJSON stream of `frames`, one chunk per entry (a string entry is sent as is, so a test can
 * split a line). `hang`: the stream stays open after the last chunk until the request is aborted.
 */
export function ndjson(chunks: Array<Record<string, unknown> | string>, options: { hang?: boolean; signal?: AbortSignal; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(typeof chunk === "string" ? chunk : `${JSON.stringify(chunk)}\n`))
      if (!options.hang) controller.close()
      else options.signal?.addEventListener("abort", () => controller.error(options.signal!.reason), { once: true })
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson", ...options.headers } })
}

export function client(handler: Handler, options: KyoraOptions = {}): { kyora: Kyora; requests: Recorded[] } {
  const { fetch, requests } = fakeFetch(handler)
  return { kyora: new Kyora({ token: "kyora_test", baseUrl: "https://kyora.test", fetch, retry: { baseDelayMs: 1, maxDelayMs: 5 }, ...options }), requests }
}

export const sandbox = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "running",
  shareable: true,
  network: "none",
  egressAllow: [],
  vcpus: 2,
  allocatedVcpus: 2,
  memoryMb: 4096,
  diskGb: 30,
  image: "default",
  labels: {},
  ttlSeconds: 3600,
  idleSeconds: 0,
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: null,
  ...extra,
})
