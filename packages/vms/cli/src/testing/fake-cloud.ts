import type { Server } from "bun"
import type { Page } from "../api"
import { TOKEN } from "./fake-vmd"

/**
 * kyora cloud's account routes from memory, for the pages, storage, domains, public URL, deploy and
 * region commands: what each was sent is in `requests`, every object stored in `objects`.
 */
export interface FakeCloud {
  url: string
  requests: string[]
  buckets: Map<string, string>
  /** `bucket/key` → its bytes and content type */
  objects: Map<string, { data: Uint8Array<ArrayBuffer>; type: string | null }>
  pages: Map<string, Page>
  /** the `hint` each POST /v1/pages sent (null: none) */
  hints: Array<string | null>
  /** names another account holds */
  taken: Set<string>
  /** POST /v1/pages switches the page, then answers this status anyway (an answer lost on the way) */
  pageLostAnswer: number | null
  /** the PUT of an object, this many PUTs from now (1: the next), fails with a 500 */
  failPut: number | null
  /** what POST /v1/pages answers instead, when set */
  pageFailure: { status: number; error: string; message: string } | null
  /** what GET /v1/me says; a test may plant the token in it */
  me: Record<string, unknown>
  stop: () => void
}

const error = (status: number, code: string, message: string) => Response.json({ error: code, message }, { status })

export function startFakeCloud(): FakeCloud {
  const cloud: FakeCloud = {
    url: "",
    stop: () => {},
    requests: [],
    buckets: new Map(),
    objects: new Map(),
    pages: new Map(),
    hints: [],
    taken: new Set(),
    pageFailure: null,
    pageLostAnswer: null,
    failPut: null,
    me: { login: "ada", kind: "user", role: "member", token: { name: "ci", scopes: ["vms"], expiresAt: null } },
  }
  const sandbox = { id: "sb_eu_abc123_0123456789abcdef", name: "brisk-otter", status: "running", network: "none", vcpus: 2, memoryMb: 4096, diskGb: 30, expiresAt: null, createdAt: "2026-10-22T00:00:00.000Z", region: "eu" }
  const server: Server<unknown> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method
      cloud.requests.push(`${method} ${path}${url.search}`)
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return error(401, "unauthorized", "no such token")
      const body = method === "POST" || method === "PATCH" ? await request.clone().json().catch(() => null) as Record<string, unknown> | null : null

      if (path === "/v1/me") return Response.json(cloud.me)
      if (path === "/v1/regions") return Response.json({ regions: [{ id: "eu", label: "Europe", default: true, jurisdiction: "EU", fallback: [], machines: 2, connected: 2, free: { vcpus: 8, memoryMb: 16384 } }], you: { region: "eu", by: "nearest" }, default: null })
      if (path === "/v1/sandboxes" && url.searchParams.has("stats")) return Response.json({ account: "ada", at: Date.now(), sandboxes: [{ id: sandbox.id, name: sandbox.name, region: "eu", vcpus: 2, memoryMb: 4096, diskGb: 30, sample: null }] })
      if (path === "/v1/sandboxes") return Response.json({ sandboxes: [sandbox] })
      if ((path === `/v1/sandboxes/${sandbox.id}` || path === `/v1/sandboxes/${sandbox.name}`) && method === "GET") return Response.json(sandbox)
      if (path === `/v1/sandboxes/${sandbox.id}` && method === "PATCH") return Response.json({ ...sandbox, ...(body?.name ? { name: body.name } : {}), ...(body?.ttlSeconds !== undefined ? { expiresAt: "2026-10-22T04:00:00.000Z" } : {}) })
      if (path === `/v1/sandboxes/${sandbox.id}/ports` && method === "POST") return Response.json({ label: body?.name ?? "quiet-fern", port: body?.port, private: !body?.public, url: `https://${body?.name ?? "quiet-fern"}.kyora.run` }, { status: 201 })
      if (path === `/v1/sandboxes/${sandbox.id}/ports` || path === "/v1/ports") return Response.json({ ports: [{ label: "quiet-fern", port: 3000, private: true, url: "https://quiet-fern.kyora.run" }] })
      if (path.startsWith("/v1/ports/") && method === "DELETE") return new Response(null, { status: 204 })

      if (path === "/v1/domains" && method === "GET") return Response.json({ domains: [{ hostname: "shop.example.com", label: "my-app", status: "active" }] })
      if (path === "/v1/domains" && method === "POST") return Response.json({ hostname: body?.hostname, label: body?.page ? `page:${body.page}` : body?.label, ...(body?.page ? { page: body.page } : {}), status: "unverified", records: [] }, { status: 201 })
      if (path.startsWith("/v1/domains/") && method === "GET") return Response.json({ hostname: decodeURIComponent(path.slice(12)), status: "active", serving: true })
      if (path.startsWith("/v1/domains/") && method === "DELETE") return new Response(null, { status: 204 })

      if (path === "/v1/projects") return Response.json({ projects: [{ id: "prj_1", name: "web", repoFullName: "acme/web", url: "https://web.kyora.app" }] })
      if (path === "/v1/projects/web/deployments" && method === "POST") return Response.json({ id: "dpl_2", state: "queued", ref: body?.ref ?? "main" }, { status: 201 })
      if (path === "/v1/projects/web/deployments") return Response.json({ deployments: [{ id: "dpl_1", state: "live", sha: "a".repeat(40), ref: "main" }] })
      if (path === "/v1/projects/web/deployments/dpl_1/logs") return new Response(`${"x".repeat(5000)}\nbuilt\n`)
      if (path === "/v1/projects/web/deployments/dpl_1") return Response.json({ id: "dpl_1", state: "live", url: "https://web.kyora.app" })

      if (path === "/v1/pages" && method === "GET") return Response.json({ pages: [...cloud.pages.values()] })
      if (path === "/v1/pages" && method === "POST") {
        if (cloud.pageFailure) return error(cloud.pageFailure.status, cloud.pageFailure.error, cloud.pageFailure.message)
        const slug = String(body!.hint ?? "").toLowerCase().replace(/\.[^.]*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "brisk-otter"
        const name = (body!.name as string | undefined) ?? `${slug}-${crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).padStart(4, "0")}`
        if (cloud.taken.has(name)) return error(409, "label_taken", "this name is held by another account or in its 30-day release cooldown")
        const bucket = body!.bucket as string
        const prefix = body!.prefix as string
        if (!prefix) return error(400, "invalid_request", "prefix must not be empty")
        if (!cloud.buckets.has(bucket) || ![...cloud.objects.keys()].some((key) => key.startsWith(`${bucket}/${prefix}`))) return error(400, "invalid_request", "nothing in that bucket and prefix")
        const before = cloud.pages.get(name)
        const page: Page = { name, url: `https://${name}.kyora.page`, private: body!.public !== true, bucket, prefix, region: "eu", spa: body!.spa === true, notFound: null, createdAt: before?.createdAt ?? "2026-10-22T00:00:00.000Z", updatedAt: new Date().toISOString() }
        cloud.hints.push((body!.hint as string | undefined) ?? null)
        cloud.pages.set(name, page)
        if (cloud.pageLostAnswer) return new Response("<html>bad gateway</html>", { status: cloud.pageLostAnswer })
        return Response.json(page, { status: before ? 200 : 201 })
      }
      const pageMatch = /^\/v1\/pages\/([^/]+)(\/login)?$/.exec(path)
      if (pageMatch) {
        const page = cloud.pages.get(decodeURIComponent(pageMatch[1]!))
        if (!page) return error(404, "not_found", "no such page")
        if (pageMatch[2]) return Response.json({ loginUrl: `https://${page.name}.kyora.page/_kyora/login#signed` })
        if (method === "DELETE") {
          cloud.pages.delete(page.name)
          return new Response(null, { status: 204 })
        }
        return Response.json(page)
      }

      if (path === "/v1/storage/buckets" && method === "GET") return Response.json({ buckets: [...cloud.buckets].map(([name, region]) => ({ name, region, createdAt: "2026-10-22T00:00:00.000Z" })) })
      if (path === "/v1/storage/buckets" && method === "POST") {
        if (cloud.buckets.has(body!.name as string)) return error(409, "bucket_exists", "you have that bucket")
        cloud.buckets.set(body!.name as string, "eu")
        return Response.json({ name: body!.name, region: "eu" }, { status: 201 })
      }
      const presign = /^\/v1\/storage\/buckets\/([^/]+)\/presign$/.exec(path)
      if (presign) return Response.json({ url: `https://storage.test/${presign[1]}/${body!.key}?X-Signature=abc`, key: body!.key, expiresAt: "2026-10-22T00:05:00.000Z" })
      const object = /^\/v1\/storage\/buckets\/([^/]+)\/o(?:\/(.+))?$/.exec(path)
      if (object) {
        const bucket = object[1]!
        if (!cloud.buckets.has(bucket)) return error(404, "not_found", "no such bucket")
        if (object[2] === undefined) {
          const prefix = url.searchParams.get("prefix") ?? ""
          const keys = [...cloud.objects.keys()].filter((key) => key.startsWith(`${bucket}/${prefix}`)).map((key) => key.slice(bucket.length + 1)).sort()
          return Response.json({ objects: keys.map((key) => ({ key, size: cloud.objects.get(`${bucket}/${key}`)!.data.length, lastModified: "" })), prefixes: [], cursor: null })
        }
        const key = `${bucket}/${decodeURIComponent(object[2])}`
        if (method === "PUT") {
          if (cloud.failPut !== null && --cloud.failPut === 0) return error(500, "internal", "the store failed")
          const data = new Uint8Array(await request.arrayBuffer())
          cloud.objects.set(key, { data, type: request.headers.get("content-type") })
          return Response.json({ key: decodeURIComponent(object[2]), size: data.length, etag: "e" })
        }
        const stored = cloud.objects.get(key)
        if (!stored) return error(404, "not_found", "no such object")
        if (method === "DELETE") {
          cloud.objects.delete(key)
          return new Response(null, { status: 204 })
        }
        return new Response(stored.data, { headers: { "content-type": stored.type ?? "application/octet-stream" } })
      }
      return error(404, "not_found", `no route ${method} ${path}`)
    },
  })
  cloud.url = server.url.toString().replace(/\/$/, "")
  cloud.stop = () => server.stop(true)
  return cloud
}
