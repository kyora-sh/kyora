import { describe, expect, test } from "bun:test"
import { inspect } from "node:util"
import { Kyora } from "./client.js"
import { KyoraError } from "./errors.js"
import { client, error, fakeFetch, json, sandbox } from "./testing/fake.js"

describe("path parameters", () => {
  test("dot segments are refused before anything is sent, so a URL never resolves them away", async () => {
    const { kyora, requests } = client(() => json(204, null))
    for (const objectKey of ["../../b", "./x", "a/../b", "..", ".", "a/."]) {
      await expect(kyora.call("deleteObject", { path: { name: "a", objectKey } })).rejects.toMatchObject({ code: "invalid_request", class: "invalid" })
    }
    await expect(kyora.sandboxes.get("..")).rejects.toMatchObject({ code: "invalid_request" })
    await expect(kyora.sandboxes.delete(".")).rejects.toMatchObject({ code: "invalid_request" })
    expect(requests.length).toBe(0)
  })

  test("encoded dots and other characters stay inside their segment", async () => {
    const { kyora, requests } = client(() => json(204, null))
    await kyora.call("deleteObject", { path: { name: "a", objectKey: "%2e%2e/%2E/b c/..x" } })
    await kyora.sandboxes.delete("sb_1/../../v1/tokens")
    expect(requests.map((request) => request.url.pathname)).toEqual(["/v1/storage/buckets/a/o/%252e%252e/%252E/b%20c/..x", "/v1/sandboxes/sb_1%2F..%2F..%2Fv1%2Ftokens"])
  })
})

describe("the token", () => {
  test("one a header can't carry is refused up front, without echoing it", () => {
    const attempt = () => new Kyora({ token: "kyora_secret\nInjected: 1", fetch: fakeFetch(() => json(200, {})).fetch })
    expect(attempt).toThrow(TypeError)
    try {
      attempt()
    } catch (caught) {
      expect(String((caught as Error).message)).not.toContain("kyora_secret")
    }
  })

  test("is taken out of wrapped errors", async () => {
    const { kyora } = client(() => {
      throw new TypeError("bad header value Bearer kyora_test")
    }, { retry: false })
    const failure = (await kyora.me().catch((caught: unknown) => caught)) as KyoraError
    expect(failure.code).toBe("network_error")
    expect(failure.message).not.toContain("kyora_test")
    expect(failure.message).toContain("[token]")
    expect(String((failure.cause as Error | undefined)?.message ?? "")).not.toContain("kyora_test")
  })

  test("never shows in inspect or JSON", () => {
    const { kyora } = client(() => json(200, {}))
    for (const text of [inspect(kyora, { depth: 10, showHidden: true }), inspect(kyora.transport, { depth: 10 }), Bun.inspect(kyora), JSON.stringify(kyora), JSON.stringify(kyora.transport), JSON.stringify({ kyora })]) {
      expect(text).not.toContain("kyora_test")
    }
    expect(JSON.parse(JSON.stringify(kyora))).toMatchObject({ baseUrl: "https://kyora.test", token: "[token]" })
  })
})

describe("answers that break off", () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'))
          controller.error(new TypeError("socket hang up"))
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

  test("a read whose body fails is retried", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? broken() : json(200, sandbox("sb_1"))))
    expect((await kyora.sandboxes.get("sb_1")).id).toBe("sb_1")
    expect(requests.length).toBe(2)
  })

  test("and is a KyoraError once retries are spent", async () => {
    const { kyora } = client(() => broken(), { retry: false })
    await expect(kyora.sandboxes.get("sb_1")).rejects.toMatchObject({ code: "network_error", status: 0, retryable: true })
  })
})

describe("deletes", () => {
  test("a 404 on a retry counts as deleted: the first try may have done it", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? error(503, "node_offline") : error(404, "not_found")))
    expect(await kyora.sandboxes.delete("sb_1")).toBe(true)
    expect(requests.length).toBe(2)
    const gone = client(() => error(404, "not_found"))
    expect(await gone.kyora.snapshots.delete("snap_1")).toBe(false)
  })
})

describe("call()", () => {
  test("HEAD answers its Response, headers and all", async () => {
    const { kyora } = client(() => new Response(null, { status: 200, headers: { etag: '"abc"', "content-length": "12" } }))
    const response = await kyora.call("headObject", { path: { name: "a", objectKey: "dir/file.txt" } })
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get("etag")).toBe('"abc"')
  })

  test("an operation without path parameters needs no path", async () => {
    const { kyora, requests } = client(() => json(201, { name: "b" }))
    await kyora.call("createBucket", { body: { name: "b" } })
    expect(requests[0]!.url.pathname).toBe("/v1/storage/buckets")
  })
})

/** compiled by check-types, never run: what call() accepts and refuses */
export function callTypes(kyora: Kyora): void {
  void kyora.call("createBucket", { body: { name: "b" } })
  void kyora.call("listBuckets", {})
  // @ts-expect-error getSandbox has path parameters
  void kyora.call("getSandbox", {})
  // @ts-expect-error a path parameter of another operation
  void kyora.call("getSandbox", { path: { name: "x" } })
  const head: Promise<Response> = kyora.call("headObject", { path: { name: "a", objectKey: "k" } })
  void head
}

describe("final round", () => {
  const breaksOff = (start: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(start))
          controller.error(new TypeError("socket hang up"))
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )

  test("a create whose body breaks off is asked again under the same key", async () => {
    const { kyora, requests } = client((_, index) => (index === 0 ? breaksOff('{"id":') : json(201, sandbox("sb_c"))))
    expect((await kyora.sandboxes.create()).id).toBe("sb_c")
    expect(requests.length).toBe(2)
    expect(requests[0]!.headers.get("idempotency-key")).toBe(requests[1]!.headers.get("idempotency-key"))
  })

  test("a queue poll whose body breaks off is polled again", async () => {
    const ticket = { ticket: "q_9", status: "queued", position: 1, ahead: 0, depth: 1, enqueuedAt: "x", waitUntil: "y", poll: "/v1/queue/q_9" }
    const { kyora } = client((request, index) => {
      if (request.method === "POST") return json(202, ticket)
      if (index === 1) return breaksOff('{"id":')
      return json(201, sandbox("sb_q"))
    })
    expect((await kyora.sandboxes.create({ wait: 30 })).id).toBe("sb_q")
  })

  test("the token in a nested cause never survives", async () => {
    const { kyora } = client(() => {
      const inner = Object.assign(new Error("header Authorization: Bearer kyora_test"), { request: { headers: { authorization: "Bearer kyora_test" } } })
      throw Object.assign(new TypeError("fetch failed", { cause: inner }), { init: { headers: { authorization: "Bearer kyora_test" } } })
    }, { retry: false })
    const failure = (await kyora.me().catch((caught: unknown) => caught)) as KyoraError
    expect(failure.code).toBe("network_error")
    expect(inspect(failure, { depth: 20, showHidden: true })).not.toContain("kyora_test")
    const cause = failure.cause as Error
    expect(cause.name).toBe("TypeError")
    expect((cause.cause as Error).message).toBe("header Authorization: Bearer [token]")
  })
})
