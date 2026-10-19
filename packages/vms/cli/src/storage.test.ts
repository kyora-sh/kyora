import { describe, expect, test } from "bun:test"
import { encodeKey, presignRequest, StorageClient, storageMain, StorageUsage } from "./storage"

/** a kyora cloud that answers the storage routes from memory, recording what it was sent */
function fakeCloud() {
  const objects = new Map<string, Uint8Array>()
  const uploads = new Map<string, Map<number, Uint8Array>>()
  const calls: string[] = []
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    calls.push(`${method} ${url.pathname}${url.search}`)
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer kysk_test")
    const match = /^\/v1\/storage\/buckets\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname)
    if (!match) return Response.json({ error: "not_found" }, { status: 404 })
    const key = match[2] === undefined ? null : decodeURIComponent(match[2])
    const body = init.body === undefined ? new Uint8Array(0) : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
    if (key === null) {
      const prefix = url.searchParams.get("prefix") ?? ""
      const limit = Number(url.searchParams.get("limit"))
      const after = url.searchParams.get("cursor") ?? ""
      const keys = [...objects.keys()].filter((entry) => entry.startsWith(prefix) && entry > after).sort()
      const page = keys.slice(0, limit)
      return Response.json({ objects: page.map((entry) => ({ key: entry, size: objects.get(entry)!.byteLength, lastModified: "" })), prefixes: [], cursor: keys.length > limit ? page.at(-1) : null })
    }
    if (method === "POST" && url.searchParams.has("uploads")) {
      uploads.set("u1", new Map())
      return Response.json({ key, uploadId: "u1", maxPartBytes: 64 * 1024 * 1024 }, { status: 201 })
    }
    const uploadId = url.searchParams.get("uploadId")
    if (uploadId && method === "PUT") {
      uploads.get(uploadId)!.set(Number(url.searchParams.get("partNumber")), body)
      return Response.json({ etag: `e${url.searchParams.get("partNumber")}` })
    }
    if (uploadId && method === "POST") {
      const { parts } = JSON.parse(new TextDecoder().decode(body)) as { parts: Array<{ partNumber: number }> }
      const chunks = parts.map((part) => uploads.get(uploadId)!.get(part.partNumber)!)
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      objects.set(key, new Uint8Array(size))
      return Response.json({ key, size, etag: "done" })
    }
    if (method === "PUT") {
      expect(new Headers(init.headers).get("content-length")).toBe(String(body.byteLength))
      objects.set(key, body)
      return Response.json({ key, size: body.byteLength, etag: "x" })
    }
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }) as typeof fetch
  return { objects, calls, client: new StorageClient("https://cloud.test", "kysk_test", fetcher) }
}

describe("kyora-vms storage", () => {
  test("put: one PUT for a small file, parts for one over the single-PUT size", async () => {
    const cloud = fakeCloud()
    expect(await cloud.client.put("assets", "dir/a b.txt", new Blob(["hello"]), "text/plain")).toMatchObject({ key: "dir/a b.txt", size: 5 })
    expect(cloud.calls).toEqual(["PUT /v1/storage/buckets/assets/o/dir/a%20b.txt"])
    const big = new Blob([new Uint8Array(150 * 1024 * 1024)])
    expect(await cloud.client.put("assets", "big.bin", big, null)).toMatchObject({ size: big.size })
    expect(cloud.calls.slice(1)).toEqual([
      "POST /v1/storage/buckets/assets/o/big.bin?uploads",
      "PUT /v1/storage/buckets/assets/o/big.bin?uploadId=u1&partNumber=1",
      "PUT /v1/storage/buckets/assets/o/big.bin?uploadId=u1&partNumber=2",
      "PUT /v1/storage/buckets/assets/o/big.bin?uploadId=u1&partNumber=3",
      "POST /v1/storage/buckets/assets/o/big.bin?uploadId=u1",
    ])
  })

  test("ls follows the cursor, up to --limit", async () => {
    const cloud = fakeCloud()
    for (let index = 0; index < 2500; index++) cloud.objects.set(`k/${String(index).padStart(4, "0")}`, new Uint8Array(1))
    expect((await cloud.client.list("assets", "k/", null, false)).objects).toHaveLength(2500)
    expect((await cloud.client.list("assets", "k/", 1200, false)).objects).toHaveLength(1200)
  })

  test("keys are encoded a segment at a time; bad arguments are usage errors", async () => {
    expect(encodeKey("a/ü ?#/x")).toBe("a/%C3%BC%20%3F%23/x")
    await expect(storageMain(["nope"])).rejects.toBeInstanceOf(StorageUsage)
    await expect(storageMain(["get", "--put"])).rejects.toBeInstanceOf(StorageUsage)
    await expect(storageMain(["presign", "b", "k", "--put", "--inline"])).rejects.toBeInstanceOf(StorageUsage)
    await expect(storageMain(["presign", "b", "k", "--length", "3"])).rejects.toBeInstanceOf(StorageUsage)
  })

  test("presign asks for a download, inline media with --inline, or a PUT of a stated length", () => {
    expect(presignRequest("a.png", { ttl: null, length: null })).toEqual({ key: "a.png", method: "GET" })
    expect(presignRequest("a.png", { ttl: 60, length: null, inline: true })).toEqual({ key: "a.png", method: "GET", ttlSeconds: 60, inline: true })
    expect(presignRequest("up.bin", { put: true, ttl: null, length: 5 })).toEqual({ key: "up.bin", method: "PUT", contentLength: 5 })
  })
})
