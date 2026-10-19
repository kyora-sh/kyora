import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { baseEnv, cli, tempDir } from "./testing/fixtures"

let root: string
let server: Server<unknown>
let refuseTrusted = false
const calls: Array<{ method: string; path: string; body: unknown }> = []
beforeEach(async () => {
  root = await tempDir("ports")
  calls.length = 0
  refuseTrusted = false
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : null
    calls.push({ method: request.method, path, body })
    if (refuseTrusted && body?.trusted) return Response.json({ error: "trust_required", message: "trusted URLs require admin or vetted access" }, { status: 403 })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const port = { label: "my-app", port: 3000, private: true, url: "https://my-app.kyora.run" }
    return Response.json(request.method === "GET" ? { ports: [port] } : port, { status: request.method === "POST" ? 201 : 200 })
  } })
})
afterEach(async () => { server.stop(true); await rm(root, { recursive: true, force: true }) })
const run = (args: string[]) => cli(args, { cwd: root, env: baseEnv(server.url.toString(), { HOME: root }) })

test("expose prints the public URL and sends the name, port and private setting", async () => {
  const result = await run(["expose", "sb_test", "3000", "--name", "my-app", "--private"])
  expect(result.code).toBe(0)
  expect(result.stdout.trim()).toBe("https://my-app.kyora.run")
  expect(calls).toEqual([{ method: "POST", path: "/v1/sandboxes/sb_test/ports", body: { port: 3000, name: "my-app" } }])
})

test("expose defaults private, lists URLs and supports JSON output", async () => {
  expect((await run(["expose", "sb_test", "3000"])).code).toBe(0)
  expect(calls[0]!.body).toEqual({ port: 3000 })
  const listed = await run(["expose", "sb_test", "--list"])
  expect(listed.stdout).toContain("https://my-app.kyora.run  3000  private")
  const json = await run(["expose", "sb_test", "--list", "--json"])
  expect(JSON.parse(json.stdout).ports[0].port).toBe(3000)
})

test("unexpose removes a label and invalid invocations make no requests", async () => {
  expect((await run(["unexpose", "sb_test", "my-app"])).code).toBe(0)
  expect(calls[0]).toEqual({ method: "DELETE", path: "/v1/sandboxes/sb_test/ports/my-app", body: null })
  calls.length = 0
  for (const args of [["expose", "sb_test", "65536"], ["expose", "sb_test", "--list", "3000"], ["expose", "sb_test", "3000", "--public", "--private"], ["unexpose"]]) expect((await run(args)).code).not.toBe(0)
  expect(calls).toHaveLength(0)
})

test("public and trusted are explicit flags, and the server's trust refusal prints no URL", async () => {
  expect((await run(["expose", "sb_test", "3000", "--public", "--trusted"])).code).toBe(0)
  expect(calls[0]!.body).toEqual({ port: 3000, public: true, trusted: true })
  refuseTrusted = true
  const refused = await run(["expose", "sb_test", "3000", "--trusted"])
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("trusted URLs require admin or vetted access")
  expect(refused.stdout).not.toContain("https://")
})

test("lists all held names and releases a name without a surviving sandbox", async () => {
  expect((await run(["expose", "--list"])).code).toBe(0)
  expect(calls[0]).toEqual({ method: "GET", path: "/v1/ports", body: null })
  expect((await run(["unexpose", "my-app"])).code).toBe(0)
  expect(calls[1]).toEqual({ method: "DELETE", path: "/v1/ports/my-app", body: null })
})
