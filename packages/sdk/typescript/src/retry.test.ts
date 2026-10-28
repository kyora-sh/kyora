import { describe, expect, test } from "bun:test"
import { KyoraError } from "./errors.js"
import { client, error, json, sandbox } from "./testing/fake.js"

describe("retries", () => {
  test("a read is repeated after the Retry-After kyora asks for", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? error(503, "waking", { retryable: true, retryAfterMs: 30 }) : json(200, sandbox("sb_1"))))
    const started = Date.now()
    expect((await kyora.sandboxes.get("sb_1")).id).toBe("sb_1")
    expect(requests.length).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  test("a Retry-After past the deadline is thrown at once, not slept", async () => {
    const { kyora, requests } = client(() => error(503, "waking", { retryable: true, retryAfterMs: 10_000 }, { "retry-after": "10" }))
    const started = Date.now()
    const failure = (await kyora.sandboxes.get("sb_1", { timeoutMs: 2_000 }).catch((caught: unknown) => caught)) as KyoraError
    expect(Date.now() - started).toBeLessThan(500)
    expect(failure).toBeInstanceOf(KyoraError)
    expect(failure.code).toBe("waking")
    expect(failure.retryAfterMs).toBe(10_000)
    expect(requests.length).toBe(1)
  })

  test("a Retry-After past maxRetryAfterMs is thrown too", async () => {
    const { kyora, requests } = client(() => error(429, "rate_limited", {}, { "retry-after": "60" }), { retry: { maxRetryAfterMs: 1_000 } })
    const failure = (await kyora.me().catch((caught: unknown) => caught)) as KyoraError
    expect(failure.code).toBe("rate_limited")
    expect(failure.retryAfterMs).toBe(60_000)
    expect(requests.length).toBe(1)
  })

  test("a non-retryable error is never repeated", async () => {
    const { kyora, requests } = client(() => error(409, "name_taken"))
    await expect(kyora.sandboxes.update("sb_1", { name: "x" })).rejects.toMatchObject({ code: "name_taken", class: "conflict", retryable: false })
    expect(requests.length).toBe(1)
  })

  test("gives up after maxAttempts", async () => {
    const { kyora, requests } = client(() => error(503, "node_offline"), { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } })
    await expect(kyora.sandboxes.get("sb_1")).rejects.toMatchObject({ code: "node_offline", retryable: true })
    expect(requests.length).toBe(3)
  })

  test("no answer at all is retried for a read", async () => {
    let calls = 0
    const { kyora } = client(() => {
      if (calls++ === 0) throw new TypeError("connection reset")
      return json(200, sandbox("sb_1"))
    })
    expect((await kyora.sandboxes.get("sb_1")).id).toBe("sb_1")
    expect(calls).toBe(2)
  })

  test("an unkeyed write is repeated on a 429 only, never after a 503 that may have run it", async () => {
    const limited = client((_, index) => (index === 0 ? error(429, "rate_limited", {}, { "retry-after": "0" }) : json(201, { label: "web", port: 80, private: true, trusted: false, url: "https://x.test" })))
    expect((await limited.kyora.ports.expose("sb_1", 80)).label).toBe("web")
    expect(limited.requests.length).toBe(2)
    const reset = client(() => error(503, "do_reset", { retryable: true, retryAfterMs: 1 }))
    await expect(reset.kyora.ports.expose("sb_1", 80)).rejects.toMatchObject({ code: "do_reset" })
    expect(reset.requests.length).toBe(1)
  })

  test("retry: false makes one try", async () => {
    const { kyora, requests } = client(() => error(503, "waking"), { retry: false })
    await expect(kyora.sandboxes.get("sb_1")).rejects.toMatchObject({ code: "waking" })
    expect(requests.length).toBe(1)
  })

  test("an aborted call rejects with the signal's reason", async () => {
    const { kyora } = client(() => error(503, "waking", { retryAfterMs: 5_000 }), { retry: { maxRetryAfterMs: 60_000 } })
    const controller = new AbortController()
    const pending = kyora.sandboxes.get("sb_1", { signal: controller.signal })
    setTimeout(() => controller.abort(new Error("stop")), 20)
    await expect(pending).rejects.toThrow("stop")
  })

  test("a call past its timeout is a timeout error", async () => {
    const { kyora } = client(() => new Promise<Response>(() => {}))
    await expect(kyora.me({ timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout", status: 0, class: "transient", retryable: true })
  })

  test("a redirect is refused, so the token never follows it", async () => {
    const { kyora } = client(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }))
    await expect(kyora.me()).rejects.toMatchObject({ code: "bad_response", status: 302 })
  })
})

describe("idempotency keys", () => {
  test("a create carries a fresh Idempotency-Key, the same on every retry", async () => {
    const { kyora, requests } = client((_, index) => (index < 2 ? error(503, "no_capacity", { retryable: true, retryAfterMs: 1 }) : json(201, sandbox("sb_new"))))
    expect((await kyora.sandboxes.create({ vcpus: 2 })).id).toBe("sb_new")
    const keys = requests.map((request) => request.headers.get("idempotency-key"))
    expect(keys.length).toBe(3)
    expect(keys[0]).toMatch(/^sdk-[0-9a-f-]{36}$/)
    expect(new Set(keys).size).toBe(1)
    const second = client(() => json(201, sandbox("sb_2")))
    await second.kyora.sandboxes.create()
    await second.kyora.sandboxes.create()
    expect(second.requests[0]!.headers.get("idempotency-key")).not.toBe(second.requests[1]!.headers.get("idempotency-key"))
  })

  test("an explicit key is sent as given", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_1")))
    await kyora.sandboxes.create({}, { idempotencyKey: "job-42" })
    expect(requests[0]!.headers.get("idempotency-key")).toBe("job-42")
  })

  test("a key given as a header in any casing is sent once, as given", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_1")))
    await kyora.sandboxes.create({}, { headers: { "idempotency-KEY": "job-42" } })
    await kyora.sandboxes.create({}, { idempotencyKey: "job-43", headers: { "Idempotency-Key": "job-43", "idempotency-key": "job-43" } })
    await kyora.call("createSandbox", { body: {} }, { headers: { "IDEMPOTENCY-KEY": "job-44" } })
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual(["job-42", "job-43", "job-44"])
  })

  test("two different keys are a TypeError, before anything is sent", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_1")))
    await expect(kyora.sandboxes.create({}, { idempotencyKey: "job-42", headers: { "idempotency-key": "job-43" } })).rejects.toBeInstanceOf(TypeError)
    await expect(kyora.sandboxes.create({}, { headers: { "Idempotency-Key": "job-42", "idempotency-key": "job-43" } })).rejects.toBeInstanceOf(TypeError)
    expect(requests).toHaveLength(0)
  })

  test("operations without a key in the spec pass a caller's Idempotency-Key header through as given", async () => {
    const { kyora, requests } = client(() => json(200, sandbox("sb_1")))
    await kyora.sandboxes.get("sb_1", { headers: { "IdemPotency-key": "job-42" } })
    await kyora.call("getSandbox", { path: { id: "sb_1" } }, { headers: { "IDEMPOTENCY-KEY": "job-43" } })
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual(["job-42", "job-43"])
  })

  test("operations without a key in the spec get none", async () => {
    const { kyora, requests } = client(() => json(200, { snapshot: true, id: "snap_1", status: "ready" }))
    await kyora.snapshots.create("sb_1", {}, { wait: false })
    expect(requests[0]!.headers.get("idempotency-key")).toBeNull()
  })

  test("the client's region goes on creates that name none", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_1")), { region: "eu" })
    await kyora.sandboxes.create({ vcpus: 2 })
    await kyora.sandboxes.create({ region: "us" })
    expect(requests.map((request) => (request.json as { region?: string }).region)).toEqual(["eu", "us"])
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer kyora_test")
  })
})

describe("Idempotent-Replayed", () => {
  test("a create reports whether its answer is an earlier request's create: true, false, or null when kyora doesn't say", async () => {
    const headers: Array<Record<string, string>> = [{ "idempotent-replayed": "true" }, { "idempotent-replayed": "false" }, {}, { "Idempotent-Replayed": "False" }]
    const { kyora } = client((_, index) => json(201, sandbox(`sb_${index}`), headers[index]))
    const seen: Array<boolean | null> = []
    for (let i = 0; i < headers.length; i++) await kyora.sandboxes.create({}, { onReplayed: (replayed) => seen.push(replayed) })
    expect(seen).toEqual([true, false, null, false])
  })

  test("a create retried after a lost answer reports the answer that reached it", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? error(503, "do_reset", {}, { "retry-after": "0" }) : json(201, sandbox("sb_1"), { "idempotent-replayed": "true" })))
    const seen: Array<boolean | null> = []
    await kyora.sandboxes.create({}, { onReplayed: (replayed) => seen.push(replayed) })
    expect(requests).toHaveLength(2)
    expect(seen).toEqual([true])
  })
})

describe("the create queue", () => {
  test("a queued create long-polls its ticket until the sandbox is placed", async () => {
    const ticket = { ticket: "q_1", status: "queued", position: 1, ahead: 0, depth: 1, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_1" }
    const seen: string[] = []
    const { kyora, requests } = client((request, index) => {
      if (index === 0) return json(202, ticket)
      if (index === 1) return json(202, { ...ticket, position: 0 })
      return json(201, sandbox("sb_placed"))
    })
    const placed = await kyora.sandboxes.create({ wait: 30 }, { onQueued: (current) => seen.push(String(current.position)), onReplayed: (replayed) => seen.push(`replayed ${replayed}`) })
    expect(placed.id).toBe("sb_placed")
    expect(seen).toEqual(["replayed null", "1", "0"])
    expect(requests[1]!.url.pathname).toBe("/v1/queue/q_1")
    expect(Number(requests[1]!.url.searchParams.get("wait"))).toBeGreaterThan(0)
  })

  test("an onQueued or onReplayed that throws takes the create out of line", async () => {
    const ticket = { ticket: "q_5", status: "queued", position: 1, ahead: 0, depth: 1, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_5" }
    for (const options of [{ onQueued: () => { throw new Error("refused") } }, { onReplayed: () => { throw new Error("refused") } }]) {
      const { kyora, requests } = client((request) => (request.method === "POST" ? json(202, ticket) : json(204, null)))
      await expect(kyora.sandboxes.create({ wait: 30 }, options)).rejects.toThrow("refused")
      expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual(["POST /v1/sandboxes", "DELETE /v1/queue/q_5"])
    }
  })

  test("a deadline in line takes the create out of line", async () => {
    const ticket = { ticket: "q_2", status: "queued", position: 3, ahead: 2, depth: 3, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_2" }
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, ticket)
      if (request.method === "DELETE") return json(204, null)
      return new Promise<Response>(() => {})
    })
    await expect(kyora.sandboxes.create({ wait: 60 }, { timeoutMs: 1_500 })).rejects.toMatchObject({ code: "timeout" })
    expect(requests.at(-1)!.method).toBe("DELETE")
    expect(requests.at(-1)!.url.pathname).toBe("/v1/queue/q_2")
  })
})

describe("queue polls", () => {
  test("an outcome error of the ticket is the create's answer, never polled again", async () => {
    const ticket = { ticket: "q_3", status: "queued", position: 1, ahead: 0, depth: 1, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_3" }
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, ticket)
      if (request.method === "DELETE") return json(204, null)
      return error(503, "no_capacity", { retryable: true, retryAfterMs: 1 })
    })
    await expect(kyora.sandboxes.create({ wait: 30 })).rejects.toMatchObject({ code: "no_capacity" })
    expect(requests.filter((request) => request.method === "GET").length).toBe(1)
  })

  test("a poll lost on the way is asked again", async () => {
    const ticket = { ticket: "q_4", status: "queued", position: 1, ahead: 0, depth: 1, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_4" }
    const { kyora } = client((request, index) => {
      if (request.method === "POST") return json(202, ticket)
      if (index === 1) return new Response("bad gateway", { status: 502 })
      return json(201, sandbox("sb_q"))
    })
    expect((await kyora.sandboxes.create({ wait: 30 })).id).toBe("sb_q")
  })
})
