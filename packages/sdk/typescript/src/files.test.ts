import { describe, expect, test } from "bun:test"
import { packFiles, unpack } from "./tar.js"
import { client, error, json, sandbox } from "./testing/fake.js"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe("tar", () => {
  test("packs files with their parent directories, and reads them back", () => {
    const long = `${"deep/".repeat(30)}file.txt`
    const entries = unpack(packFiles([{ path: "in/report.md", data: "# hi" }, { path: long, data: new Uint8Array([1, 2, 3]), mode: 0o755 }, { path: "./in/b.txt", data: "" }]))
    expect(entries.filter((entry) => entry.type === "dir").map((entry) => entry.name)).toContain("in/")
    const files = entries.filter((entry) => entry.type === "file")
    expect(files.map((entry) => entry.name)).toEqual(["in/report.md", long, "in/b.txt"])
    expect(text(files[0]!.data)).toBe("# hi")
    expect([...files[1]!.data]).toEqual([1, 2, 3])
    expect(files[1]!.mode).toBe(0o755)
  })

  test("refuses a path that leaves the destination", () => {
    expect(() => packFiles([{ path: "../etc/passwd", data: "x" }])).toThrow(RangeError)
    expect(() => packFiles([{ path: "/", data: "x" }])).toThrow(RangeError)
  })

  test("a truncated archive is an error", () => {
    const archive = packFiles([{ path: "a.txt", data: "hello" }])
    expect(() => unpack(archive.subarray(0, 600))).toThrow("truncated")
  })
})

describe("files", () => {
  test("upload sends one tar to the destination", async () => {
    const { kyora, requests } = client(() => json(200, { bytes: 2048, entries: 2, durationMs: 5 }))
    const result = await kyora.files.upload("sb_1", { "inbox/contract.pdf": new Uint8Array([37, 80, 68, 70]) }, { dest: "/work/job" })
    expect(result.entries).toBe(2)
    const request = requests[0]!
    expect(request.method).toBe("PUT")
    expect(request.url.pathname).toBe("/v1/sandboxes/sb_1/files")
    expect(request.url.searchParams.get("dest")).toBe("/work/job")
    expect(request.headers.get("content-type")).toBe("application/x-tar")
    const file = unpack(request.body!).find((entry) => entry.type === "file")!
    expect(file.name).toBe("inbox/contract.pdf")
    expect([...file.data]).toEqual([37, 80, 68, 70])
  })

  test("a large archive goes up in parts and is completed", async () => {
    const partSize = 32 * 1024 * 1024
    const { kyora, requests } = client((request) => {
      const path = request.url.pathname
      if (path.endsWith("/uploads")) return json(201, { uploadId: "up_1", partSize, maxPartBytes: partSize, expiresAt: "x" })
      if (path.includes("/parts/")) return json(200, { n: Number(path.split("/").at(-1)), etag: `e${path.split("/").at(-1)}` })
      return json(200, { bytes: 1, entries: 1, durationMs: 1 })
    })
    await kyora.files.uploadTar("sb_1", new Uint8Array(65 * 1024 * 1024 + 1))
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "POST /v1/sandboxes/sb_1/uploads",
      "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/1",
      "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/2",
      "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/3",
      "POST /v1/sandboxes/sb_1/uploads/up_1/complete",
    ])
    expect(requests.at(-1)!.json).toEqual({ parts: [{ n: 1, etag: "e1" }, { n: 2, etag: "e2" }, { n: 3, etag: "e3" }] })
  })

  test("a failed part aborts the upload", async () => {
    const { kyora, requests } = client((request) => {
      if (request.url.pathname.endsWith("/uploads")) return json(201, { uploadId: "up_2", partSize: 32 * 1024 * 1024, maxPartBytes: 32 * 1024 * 1024, expiresAt: "x" })
      if (request.method === "DELETE") return json(204, null)
      return error(400, "upload_rejected")
    })
    await expect(kyora.files.uploadTar("sb_1", new Uint8Array(65 * 1024 * 1024))).rejects.toMatchObject({ code: "upload_rejected" })
    expect(requests.at(-1)!.method).toBe("DELETE")
    expect(requests.at(-1)!.url.pathname).toBe("/v1/sandboxes/sb_1/uploads/up_2")
  })

  test("download and read unpack what the sandbox sends", async () => {
    const archive = packFiles([{ path: "out/summary.json", data: '{"ok":true}' }])
    const { kyora, requests } = client(() => new Response(archive as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "application/x-tar" } }))
    expect(text(await kyora.files.read("sb_1", "/work/out/summary.json"))).toBe('{"ok":true}')
    expect(requests[0]!.url.searchParams.getAll("path")).toEqual(["/work/out/summary.json"])
    const entries = await kyora.files.download("sb_1", ["/work/out"])
    expect(entries.map((entry) => entry.name)).toEqual(["out/", "out/summary.json"])
  })
})

describe("snapshots, ports and tokens", () => {
  const snap = (status: string) => ({ id: "snap_1", kind: "fs", status, name: null, sandbox: "sb_1", bytes: null, logicalBytes: null, dataBytes: null, image: null, resumable: false, createdAt: "x", expiresAt: "y" })

  test("a snapshot is polled until ready", async () => {
    const { kyora, requests } = client((_, index) => json(index === 0 ? 202 : 200, snap(index < 2 ? "creating" : "ready")))
    const states: string[] = []
    const ready = await kyora.snapshots.create("sb_1", { name: "base" }, { intervalMs: 5, onProgress: (current) => states.push(current.status) })
    expect(ready.status).toBe("ready")
    expect(states).toEqual(["creating", "creating", "ready"])
    expect(requests[0]!.json).toEqual({ name: "base" })
  })

  test("a restore that fails is destroyed", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, sandbox("sb_r", { status: "starting" }))
      if (request.method === "DELETE") return json(204, null)
      return json(200, sandbox("sb_r", { status: "failed" }))
    })
    await expect(kyora.snapshots.restore("snap_1", { vcpus: 2 }, { intervalMs: 5 })).rejects.toMatchObject({ code: "sandbox_ended" })
    expect((requests[0]!.json as { fromSnapshot: string }).fromSnapshot).toBe("snap_1")
    expect(requests.at(-1)!.method).toBe("DELETE")
    expect(requests.at(-1)!.url.pathname).toBe("/v1/sandboxes/sb_r")
    expect(requests[0]!.headers.get("idempotency-key")).toStartWith("sdk-")
  })

  test("a restore under the caller's key that fails is left running, its id on the error", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, sandbox("sb_r", { status: "starting" }))
      return json(200, sandbox("sb_r", { status: "failed" }))
    })
    const failure = await kyora.snapshots.restore("snap_1", {}, { idempotencyKey: "job-42", intervalMs: 5 }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "sandbox_ended", sandboxId: "sb_r" })
    expect(requests[0]!.headers.get("idempotency-key")).toBe("job-42")
    expect(requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("a restore under the caller's key that is aborted is left running", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, sandbox("sb_r", { status: "starting" }))
      return json(200, sandbox("sb_r", { status: "starting" }))
    })
    const abort = new AbortController()
    const reason = new Error("stop")
    await expect(kyora.snapshots.restore("snap_1", {}, { idempotencyKey: "job-42", intervalMs: 5, signal: abort.signal, onProgress: () => abort.abort(reason) })).rejects.toBe(reason)
    expect(requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("a restore under a header key in any casing sends that one key and leaves the sandbox running", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, sandbox("sb_r", { status: "starting" }))
      return json(200, sandbox("sb_r", { status: "failed" }))
    })
    const failure = await kyora.snapshots.restore("snap_1", {}, { headers: { "IDEMPOTENCY-key": "job-42" }, intervalMs: 5 }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "sandbox_ended", sandboxId: "sb_r" })
    expect(requests[0]!.headers.get("idempotency-key")).toBe("job-42")
    expect(requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("a restore keeps the key it started with when its options change under it", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(202, sandbox("sb_r", { status: "starting" }))
      return json(200, sandbox("sb_r", { status: "failed" }))
    })
    const options: { idempotencyKey?: string; headers?: Record<string, string>; intervalMs: number; onProgress: () => void } = {
      idempotencyKey: "job-42",
      intervalMs: 5,
      onProgress: () => {
        delete options.idempotencyKey
        options.headers = {}
      },
    }
    const failure = await kyora.snapshots.restore("snap_1", {}, options).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "sandbox_ended", sandboxId: "sb_r" })
    expect(requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("a restore given two different keys sends nothing", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_r")))
    await expect(kyora.snapshots.restore("snap_1", {}, { idempotencyKey: "job-42", headers: { "Idempotency-Key": "job-43" } })).rejects.toBeInstanceOf(TypeError)
    expect(requests).toHaveLength(0)
  })

  test("a restore that replays another's sandbox under the same key never destroys it", async () => {
    let gets = 0
    const { kyora, requests } = client((request) => {
      if (request.method === "POST") return json(201, sandbox("sb_r", { status: "starting" }))
      if (request.method === "DELETE") return json(204, null)
      return json(200, sandbox("sb_r", { status: ++gets === 1 ? "running" : "starting" }))
    })
    const first = await kyora.snapshots.restore("snap_1", {}, { idempotencyKey: "job-42", intervalMs: 5 })
    expect(first.status).toBe("running")
    const failure = await kyora.snapshots.restore("snap_1", {}, { idempotencyKey: "job-42", intervalMs: 5, timeoutMs: 50 }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "timeout", sandboxId: "sb_r" })
    expect(requests.filter((request) => request.method === "POST").map((request) => request.headers.get("idempotency-key"))).toEqual(["job-42", "job-42"])
    expect(requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("ports and tokens reach their operations", async () => {
    const { kyora, requests } = client((request) => {
      if (request.url.pathname.endsWith("/ports") && request.method === "GET") return json(200, { ports: [] })
      if (request.url.pathname.includes("/tokens") && request.method === "GET") return json(200, { tokens: [], capabilities: [] })
      if (request.method === "DELETE") return json(204, null)
      return json(201, { token: "kyora_new", record: {} })
    })
    await kyora.ports.list("sb_1")
    await kyora.ports.unexpose("sb_1", "web")
    await kyora.tokens.list({ org: "acme" })
    await kyora.tokens.create({ name: "ci", scopes: ["vms:exec"], constraints: { labels: { ci: "1" }, maxSandboxes: 2 } })
    await kyora.tokens.delete("tok_1")
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/sandboxes/sb_1/ports",
      "DELETE /v1/sandboxes/sb_1/ports/web",
      "GET /v1/orgs/acme/tokens",
      "POST /v1/tokens",
      "DELETE /v1/tokens/tok_1",
    ])
  })
})

describe("uploads and waits under one deadline", () => {
  const MiB = 1024 * 1024
  const multipart = (partSize: number, delayMs = 0) => (request: { method: string; url: URL }) => {
    const path = request.url.pathname
    const answer = () => {
      if (path.endsWith("/uploads")) return json(201, { uploadId: "up_s", partSize, maxPartBytes: partSize, expiresAt: "x" })
      if (path.includes("/parts/")) return json(200, { n: Number(path.split("/").at(-1)), etag: "e" })
      if (request.method === "DELETE") return json(204, null)
      return json(200, { bytes: 1, entries: 1, durationMs: 1 })
    }
    return delayMs ? new Promise<Response>((resolve) => setTimeout(() => resolve(answer()), delayMs)) : answer()
  }
  const stream = (total: number, chunk = MiB) => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close()
        const size = Math.min(chunk, total - sent)
        sent += size
        controller.enqueue(new Uint8Array(size))
      },
    })
  }

  test("a large stream goes up in parts, never as one PUT", async () => {
    const { kyora, requests } = client(multipart(32 * MiB))
    await kyora.files.uploadTar("sb_1", stream(65 * MiB))
    const parts = requests.filter((request) => request.url.pathname.includes("/parts/"))
    expect(parts.map((request) => request.body!.length)).toEqual([32 * MiB, 32 * MiB, MiB])
    expect(requests.some((request) => request.url.pathname.endsWith("/files"))).toBe(false)
  })

  test("a small stream goes up as one PUT", async () => {
    const { kyora, requests } = client(multipart(32 * MiB))
    await kyora.files.uploadTar("sb_1", stream(3 * MiB))
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual(["PUT /v1/sandboxes/sb_1/files"])
    expect(requests[0]!.body!.length).toBe(3 * MiB)
  })

  test("timeoutMs bounds the whole multipart upload, not each part", async () => {
    const { kyora, requests } = client(multipart(32 * MiB, 80))
    await expect(kyora.files.uploadTar("sb_1", new Uint8Array(65 * MiB), { timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" })
    expect(requests.at(-1)!.method).toBe("DELETE")
  })

  test("a part size out of bounds is refused, and the upload aborted", async () => {
    const { kyora, requests } = client(multipart(1024))
    await expect(kyora.files.uploadTar("sb_1", new Uint8Array(65 * MiB))).rejects.toMatchObject({ code: "bad_response" })
    expect(requests.at(-1)!.method).toBe("DELETE")
  })

  test("waitUntilRunning's first request is inside its deadline", async () => {
    const { kyora } = client(() => new Promise<Response>(() => {}))
    const started = Date.now()
    await expect(kyora.sandboxes.waitUntilRunning("sb_1", { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("uploads that stall or fail early", () => {
  const MiB = 1024 * 1024
  const watched = (chunks: number, then: "hang" | "close") => {
    let cancelled = false
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < chunks) {
          sent++
          controller.enqueue(new Uint8Array(MiB))
        } else if (then === "close") controller.close()
        else return new Promise<void>(() => {})
      },
      cancel() {
        cancelled = true
      },
    })
    return { stream, cancelled: () => cancelled }
  }

  test("a stalled stream ends at the deadline, and is cancelled", async () => {
    const source = watched(1, "hang")
    const { kyora, requests } = client(() => json(200, {}))
    const started = Date.now()
    await expect(kyora.files.uploadTar("sb_1", source.stream, { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(source.cancelled()).toBe(true)
    expect(requests.length).toBe(0)
  })

  test("and at an abort", async () => {
    const source = watched(1, "hang")
    const { kyora } = client(() => json(200, {}))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("stop")), 30)
    await expect(kyora.files.uploadTar("sb_1", source.stream, { signal: controller.signal })).rejects.toThrow("stop")
    expect(source.cancelled()).toBe(true)
  })

  test("a failed createUpload cancels the stream", async () => {
    const source = watched(70, "hang")
    const { kyora } = client(() => error(403, "insufficient_scope"))
    await expect(kyora.files.uploadTar("sb_1", source.stream)).rejects.toMatchObject({ code: "insufficient_scope" })
    expect(source.cancelled()).toBe(true)
  })

  test("a cleanup that hangs never holds the caller past its deadline", async () => {
    const { kyora, requests } = client((request) => {
      const path = request.url.pathname
      if (path.endsWith("/uploads")) return json(201, { uploadId: "up_h", partSize: 32 * MiB, maxPartBytes: 32 * MiB, expiresAt: "x" })
      if (request.method === "DELETE") return new Promise<Response>(() => {})
      return new Promise<Response>((resolve) => setTimeout(() => resolve(json(200, { n: 1, etag: "e" })), 80))
    })
    const started = Date.now()
    await expect(kyora.files.uploadTar("sb_1", new Uint8Array(65 * MiB), { timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" })
    expect(Date.now() - started).toBeLessThan(600)
    expect(requests.at(-1)!.method).toBe("DELETE")
  })
})
