import { describe, expect, test } from "bun:test"
import { classify, errorFromResponse, isKyoraError, KyoraError, parseRetryAfter } from "./errors.js"
import { client, error, json } from "./testing/fake.js"

describe("classify", () => {
  test("takes class and retryability from the catalog", () => {
    expect(classify("waking", 503)).toEqual({ class: "transient", retryable: true })
    expect(classify("quota_exceeded", 429)).toEqual({ class: "limit", retryable: false })
    expect(classify("name_taken", 409)).toEqual({ class: "conflict", retryable: false })
    expect(classify("unauthorized", 401)).toEqual({ class: "auth", retryable: false })
    expect(classify("not_found", 404)).toEqual({ class: "not_found", retryable: false })
    expect(classify("invalid_request", 400)).toEqual({ class: "invalid", retryable: false })
  })

  test("a list of statuses makes a code retryable only after those", () => {
    expect(classify("download_failed", 502).retryable).toBe(true)
    expect(classify("download_failed", 400).retryable).toBe(false)
    expect(classify("egress_unavailable", 503).retryable).toBe(true)
    expect(classify("egress_unavailable", 501).retryable).toBe(false)
  })

  test("a code newer than the catalog is taken by its status", () => {
    expect(classify("brand_new_code", 503)).toEqual({ class: "transient", retryable: true })
    expect(classify("brand_new_code", 429)).toEqual({ class: "transient", retryable: true })
    expect(classify("brand_new_code", 409)).toEqual({ class: "conflict", retryable: false })
    expect(classify("brand_new_code", 403)).toEqual({ class: "auth", retryable: false })
    expect(classify("brand_new_code", 500)).toEqual({ class: "unavailable", retryable: false })
  })
})

describe("errorFromResponse", () => {
  test("reads code, message, retryable and retryAfterMs from the body", async () => {
    const failure = await errorFromResponse("createSandbox", error(503, "no_capacity", { retryable: true, retryAfterMs: 1500 }, { "retry-after": "2" }))
    expect(failure).toBeInstanceOf(KyoraError)
    expect(failure.code).toBe("no_capacity")
    expect(failure.status).toBe(503)
    expect(failure.class).toBe("transient")
    expect(failure.retryable).toBe(true)
    expect(failure.retryAfterMs).toBe(1500)
    expect(failure.operation).toBe("createSandbox")
    expect(failure.message).toContain("no_capacity happened")
  })

  test("falls back to Retry-After, then to the catalog", async () => {
    const failure = await errorFromResponse("getSandbox", error(503, "rate_limited", {}, { "retry-after": "3" }))
    expect(failure.retryAfterMs).toBe(3000)
    expect(failure.retryable).toBe(true)
    const body = await errorFromResponse("getSandbox", error(503, "waking", { retryable: false }))
    expect(body.retryable).toBe(false)
  })

  test("an answer without a JSON body is still an error with a status", async () => {
    const failure = await errorFromResponse("getSandbox", new Response("<html>bad gateway</html>", { status: 502 }))
    expect(failure.code).toBe("http_502")
    expect(failure.class).toBe("transient")
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("getSandbox: HTTP 502")
  })

  test("Retry-After as an HTTP date", () => {
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000)
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe("isKyoraError", () => {
  test("narrows by class", async () => {
    const { kyora } = client(() => error(429, "sandbox_limit"))
    const failure = await kyora.sandboxes.create().catch((caught: unknown) => caught)
    expect(isKyoraError(failure, "limit")).toBe(true)
    expect(isKyoraError(failure, "transient")).toBe(false)
    expect(isKyoraError(new Error("x"))).toBe(false)
  })

  test("a 404 on delete is false, not an error", async () => {
    const { kyora } = client((request) => (request.url.pathname.endsWith("/sb_gone") ? error(404, "not_found") : json(204, null)))
    expect(await kyora.sandboxes.delete("sb_gone")).toBe(false)
    expect(await kyora.sandboxes.delete("sb_here")).toBe(true)
  })
})
