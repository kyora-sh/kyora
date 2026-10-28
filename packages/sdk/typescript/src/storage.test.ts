import { describe, expect, test } from "bun:test"
import { client, error, json } from "./testing/fake.js"

const MiB = 1024 * 1024
const bucket = (name: string) => ({ name, region: "eu", createdAt: "x" })
const route = (request: { method: string; url: URL }) => `${request.method} ${request.url.pathname}${request.url.search}`

describe("storage", () => {
  test("buckets, CORS, keys, audit and presign reach their operations", async () => {
    const { kyora, requests } = client((request) => {
      const path = request.url.pathname
      if (path.endsWith("/cors")) return json(200, { bucket: "site", origins: request.method === "PUT" ? ["https://example.com"] : [], methods: [], allowedHeaders: [], exposeHeaders: [], maxAgeSeconds: 0 })
      if (path.endsWith("/presign")) return json(201, { url: "https://signed.example.test/o", method: "PUT", key: "a.txt", expiresAt: "x", headers: {} })
      if (path === "/v1/storage/keys") return request.method === "GET" ? json(200, { keys: [] }) : json(201, { id: "sk_1", key: "secret" })
      if (path.startsWith("/v1/storage/keys/")) return json(200, { id: "sk_1", revoked: true })
      if (path === "/v1/storage/audit") return json(200, { events: [] })
      if (path === "/v1/storage/buckets") return request.method === "GET" ? json(200, { buckets: [bucket("site")], limit: 10 }) : json(201, bucket("site"))
      return json(200, bucket("site"))
    })
    expect((await kyora.storage.buckets.list()).map((listed) => listed.name)).toEqual(["site"])
    await kyora.storage.buckets.create("site", { region: "eu" })
    await kyora.storage.buckets.get("site")
    await kyora.storage.buckets.cors("site")
    expect((await kyora.storage.buckets.setCors("site", ["https://example.com"])).origins).toEqual(["https://example.com"])
    await kyora.storage.buckets.clearCors("site")
    expect((await kyora.storage.objects.presign("site", { key: "a.txt", method: "PUT", ttlSeconds: 60 })).url).toBe("https://signed.example.test/o")
    await kyora.storage.keys.list()
    expect((await kyora.storage.keys.create({ bucket: "site", prefix: "build/", access: "read" })).key).toBe("secret")
    expect((await kyora.storage.keys.revoke("sk_1")).revoked).toBe(true)
    await kyora.storage.audit({ limit: 5 })
    expect(requests.map(route)).toEqual([
      "GET /v1/storage/buckets",
      "POST /v1/storage/buckets",
      "GET /v1/storage/buckets/site",
      "GET /v1/storage/buckets/site/cors",
      "PUT /v1/storage/buckets/site/cors",
      "DELETE /v1/storage/buckets/site/cors",
      "POST /v1/storage/buckets/site/presign",
      "GET /v1/storage/keys",
      "POST /v1/storage/keys",
      "DELETE /v1/storage/keys/sk_1",
      "GET /v1/storage/audit?limit=5",
    ])
    expect(requests[1]!.json).toEqual({ name: "site", region: "eu" })
    expect(requests[4]!.json).toEqual({ origins: ["https://example.com"] })
    expect(requests[6]!.json).toEqual({ key: "a.txt", method: "PUT", ttlSeconds: 60 })
  })

  test("a bucket goes to the client's region unless the create names one", async () => {
    const { kyora, requests } = client(() => json(201, bucket("site")), { region: "eu" })
    await kyora.storage.buckets.create("site")
    await kyora.storage.buckets.create("site", { region: "us" })
    expect(requests.map((request) => request.json)).toEqual([{ name: "site", region: "eu" }, { name: "site", region: "us" }])
  })

  test("a forced bucket delete is called again until kyora answers it deleted, counting every object", async () => {
    const { kyora, requests } = client((_, index) => (index < 2 ? json(202, { name: "site", deleted: false, objectsDeleted: 1000, done: false, message: "more" }) : json(200, { name: "site", deleted: true, objectsDeleted: 7, done: true })))
    expect(await kyora.storage.buckets.delete("site", { force: true })).toEqual({ name: "site", deleted: true, objectsDeleted: 2007, done: true })
    expect(requests.map(route)).toEqual(Array(3).fill("DELETE /v1/storage/buckets/site?force=true"))
  })

  test("a bucket delete without force sends no force, and a non-empty bucket is an error", async () => {
    const { kyora, requests } = client(() => error(409, "bucket_not_empty"))
    await expect(kyora.storage.buckets.delete("site")).rejects.toMatchObject({ code: "bucket_not_empty" })
    expect(requests.map(route)).toEqual(["DELETE /v1/storage/buckets/site"])
  })

  test("objects are listed page by page, keys with slashes kept", async () => {
    const object = (key: string) => ({ key, size: 1, etag: "e", lastModified: "x" })
    const { kyora, requests } = client((request) => (request.url.searchParams.get("cursor") ? json(200, { objects: [object("b/2")], prefixes: [], cursor: null }) : json(200, { objects: [object("b/1")], prefixes: ["b/c/"], cursor: "c1" })))
    const page = await kyora.storage.objects.list("site", { prefix: "b/", limit: 1 })
    expect(page).toEqual({ items: [object("b/1")], nextCursor: "c1", prefixes: ["b/c/"] })
    const keys: string[] = []
    for await (const listed of kyora.storage.objects.iterate("site", { prefix: "b/" })) keys.push(listed.key)
    expect(keys).toEqual(["b/1", "b/2"])
    expect(requests.map(route)).toEqual(["GET /v1/storage/buckets/site/o?prefix=b%2F&limit=1", "GET /v1/storage/buckets/site/o?prefix=b%2F", "GET /v1/storage/buckets/site/o?prefix=b%2F&cursor=c1"])
  })

  test("get, getStream, head and delete reach the object", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "5", etag: '"abc"', "content-type": "text/plain", "last-modified": "Wed, 28 Oct 2026 00:00:00 GMT" } })
      if (request.method === "DELETE") return json(204, null)
      return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
    })
    expect(new TextDecoder().decode(await kyora.storage.objects.get("site", "dir/a b.txt"))).toBe("hello")
    expect(await new Response(await kyora.storage.objects.getStream("site", "dir/a b.txt")).text()).toBe("hello")
    expect(await kyora.storage.objects.head("site", "dir/a b.txt")).toEqual({ size: 5, etag: '"abc"', contentType: "text/plain", lastModified: "Wed, 28 Oct 2026 00:00:00 GMT" })
    await kyora.storage.objects.delete("site", "dir/a b.txt")
    expect(requests.map(route)).toEqual(Array.from(["GET", "GET", "HEAD", "DELETE"], (method) => `${method} /v1/storage/buckets/site/o/dir/a%20b.txt`))
  })

  test("a missing object is a not_found error on get and on head", async () => {
    const { kyora } = client((request) => (request.method === "HEAD" ? new Response(null, { status: 404 }) : error(404, "not_found")))
    await expect(kyora.storage.objects.get("site", "gone")).rejects.toMatchObject({ code: "not_found", status: 404 })
    await expect(kyora.storage.objects.head("site", "gone")).rejects.toMatchObject({ code: "not_found", status: 404 })
  })

  test("a small object goes up in one PUT with its content type", async () => {
    const { kyora, requests } = client(() => json(200, { key: "a.txt", size: 5, etag: "e" }))
    expect(await kyora.storage.objects.put("site", "a.txt", "hello", { contentType: "text/plain" })).toEqual({ key: "a.txt", size: 5, etag: "e" })
    expect(requests.map(route)).toEqual(["PUT /v1/storage/buckets/site/o/a.txt"])
    expect(requests[0]!.headers.get("content-type")).toBe("text/plain")
    expect(new TextDecoder().decode(requests[0]!.body!)).toBe("hello")
  })

  test("a large object goes up in parts and is completed", async () => {
    const { kyora, requests } = client((request) => {
      const query = request.url.searchParams
      if (request.method === "POST" && query.has("uploads")) return json(201, { key: "big", uploadId: "up_1", maxPartBytes: 32 * MiB, maxParts: 10000 })
      if (request.method === "PUT") return json(200, { partNumber: Number(query.get("partNumber")), etag: `e${query.get("partNumber")}` })
      return json(200, { key: "big", size: 65 * MiB + 1, etag: "e-3" })
    })
    expect((await kyora.storage.objects.put("site", "big", new Uint8Array(65 * MiB + 1), { contentType: "video/mp4" })).etag).toBe("e-3")
    expect(requests.map(route)).toEqual([
      "POST /v1/storage/buckets/site/o/big?uploads=",
      "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=1",
      "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=2",
      "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=3",
      "POST /v1/storage/buckets/site/o/big?uploadId=up_1",
    ])
    expect(requests[0]!.headers.get("content-type")).toBe("video/mp4")
    expect(requests.slice(1, 4).map((request) => request.body!.length)).toEqual([32 * MiB, 32 * MiB, MiB + 1])
    expect(requests.at(-1)!.json).toEqual({ parts: [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` })) })
  })

  test("a failed part aborts the multipart upload", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(201, { key: "big", uploadId: "up_2", maxPartBytes: 32 * MiB, maxParts: 10000 })
      if (request.method === "DELETE") return json(204, null)
      return error(400, "invalid_request")
    })
    await expect(kyora.storage.objects.put("site", "big", new Uint8Array(65 * MiB))).rejects.toMatchObject({ code: "invalid_request" })
    expect(route(requests.at(-1)!)).toBe("DELETE /v1/storage/buckets/site/o/big?uploadId=up_2")
  })

  test("an upload past kyora's part count is refused, and aborted", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(201, { key: "big", uploadId: "up_3", maxPartBytes: MiB, maxParts: 2 })
      if (request.method === "DELETE") return json(204, null)
      return json(200, { partNumber: 1, etag: "e" })
    })
    await expect(kyora.storage.objects.put("site", "big", new Uint8Array(65 * MiB))).rejects.toMatchObject({ code: "invalid_request", status: 0 })
    expect(requests.filter((request) => request.method === "PUT").length).toBe(2)
    expect(route(requests.at(-1)!)).toBe("DELETE /v1/storage/buckets/site/o/big?uploadId=up_3")
  })
})
