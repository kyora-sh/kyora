import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { cli, platformEnv, tempDir } from "./testing/fixtures"

setDefaultTimeout(30_000)

let root: string
let server: Server<unknown>
let hasMembers: boolean
let empty: boolean
let refuseSandbox: boolean
let notEnabled: boolean
const calls: Array<{ method: string; path: string; body: unknown }> = []
const network = {
  id: "net_x", name: "backend", cidr: "10.20.0.0/24", gateway: "10.20.0.1",
  createdAt: "2026-11-04T00:00:00.000Z", memberCount: 2,
}
const members = [{ sandboxId: "sb_member", ip: "10.20.0.5", state: "active" }, { sandboxId: "sb_starting", ip: "10.20.0.6", state: "pending" }]
const NOT_ENABLED = "private networks are not enabled for this account; ask kyora support"

beforeEach(async () => {
  root = await tempDir("networks")
  calls.length = 0
  hasMembers = false
  empty = false
  refuseSandbox = false
  notEnabled = false
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : null
    calls.push({ method: request.method, path, body })
    if (notEnabled && path.startsWith("/v1/networks")) return Response.json({ error: "privnet_not_enabled", message: NOT_ENABLED }, { status: 403 })
    if (path === "/v1/networks" && request.method === "POST") return Response.json({ ...network, memberCount: 0 }, { status: 201 })
    if (path === "/v1/networks" && request.method === "GET") return Response.json({ networks: empty ? [] : [network] })
    if (path === "/v1/networks/net_x" && request.method === "GET") return Response.json({ ...network, memberCount: members.length, members })
    if (path === "/v1/networks/net_x" && request.method === "DELETE") {
      if (hasMembers) return Response.json({ error: "network_has_members", message: "remove the network's sandboxes first" }, { status: 409 })
      return new Response(null, { status: 204 })
    }
    if (path === "/v1/sandboxes" && request.method === "POST") {
      if (refuseSandbox) return Response.json({ error: "network_full", message: "every address is taken" }, { status: 409 })
      return Response.json({ id: "sb_created", name: "member", status: "running", network: "none", vcpus: 4, memoryMb: 8192, diskGb: 30, createdAt: network.createdAt, expiresAt: null }, { status: 201 })
    }
    return Response.json({ error: "network_not_found", message: "private network not found" }, { status: 404 })
  } })
})
afterEach(async () => { server.stop(true); await rm(root, { recursive: true, force: true }) })
const run = (args: string[]) => cli(args, { cwd: root, env: platformEnv(server.url.toString(), { HOME: root }) })

test("networks create sends the name and CIDR and prints the network", async () => {
  const result = await run(["networks", "create", "backend", "--cidr", network.cidr])
  expect(result.code).toBe(0)
  expect(calls).toEqual([{ method: "POST", path: "/v1/networks", body: { name: "backend", cidr: network.cidr } }])
  expect(result.stdout).toMatch(/NAME\s+ID\s+CIDR\s+MEMBERS\s+CREATED/)
  expect(result.stdout).toMatch(/backend\s+net_x\s+10\.20\.0\.0\/24\s+0\s+2026-11-04/)
  const json = await run(["networks", "create", "backend", "--cidr", network.cidr, "--json"])
  expect(json.code).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual({ ...network, memberCount: 0 })
})

test("networks ls prints a table or JSON and handles an empty list", async () => {
  const listed = await run(["networks", "ls"])
  expect(listed.code).toBe(0)
  expect(listed.stdout).toMatch(/NAME\s+ID\s+CIDR\s+MEMBERS\s+CREATED/)
  expect(listed.stdout).toMatch(/backend\s+net_x\s+10\.20\.0\.0\/24\s+2\s+2026-11-04/)
  const json = await run(["networks", "ls", "--json"])
  expect(json.code).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual({ networks: [network] })
  empty = true
  expect((await run(["networks", "ls"])).stdout).toContain("no private networks yet")
  expect(JSON.parse((await run(["networks", "ls", "--json"])).stdout)).toEqual({ networks: [] })
})

test("an account without private networks hears how it gets them, as the server says it", async () => {
  notEnabled = true
  for (const args of [["networks", "ls"], ["networks", "create", "backend", "--cidr", network.cidr], ["create", "--private-network", "backend"]]) {
    const refused = await run(args)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain(NOT_ENABLED)
  }
  expect(calls.some((call) => call.path === "/v1/sandboxes")).toBe(false)
})

test("networks show resolves a name through the list and prints members", async () => {
  const shown = await run(["networks", "show", "backend"])
  expect(shown.code).toBe(0)
  expect(calls).toEqual([{ method: "GET", path: "/v1/networks", body: null }, { method: "GET", path: "/v1/networks/net_x", body: null }])
  expect(shown.stdout).toMatch(/SANDBOX\s+IP\s+STATE/)
  expect(shown.stdout).toMatch(/sb_member\s+10\.20\.0\.5\s+active/)
  expect(shown.stdout).toMatch(/sb_starting\s+10\.20\.0\.6\s+pending/)
  calls.length = 0
  const json = await run(["networks", "show", "net_x", "--json"])
  expect(json.code).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual({ ...network, memberCount: members.length, members })
  expect(calls).toEqual([{ method: "GET", path: "/v1/networks/net_x", body: null }])
})

test("networks rm accepts an id or a name and handles a 204", async () => {
  expect((await run(["networks", "rm", "backend"])).code).toBe(0)
  expect(calls).toEqual([{ method: "GET", path: "/v1/networks", body: null }, { method: "DELETE", path: "/v1/networks/net_x", body: null }])
  calls.length = 0
  expect((await run(["networks", "rm", "net_x"])).code).toBe(0)
  expect(calls).toEqual([{ method: "DELETE", path: "/v1/networks/net_x", body: null }])
})

test("networks rm surfaces network_has_members and missing networks stay errors", async () => {
  hasMembers = true
  const refused = await run(["networks", "rm", "net_x"])
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("remove the network's sandboxes first")
  const missing = await run(["networks", "show", "net_missing"])
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("private network not found")
  const missingName = await run(["networks", "rm", "missing"])
  expect(missingName.code).not.toBe(0)
  expect(missingName.stderr).toContain('network "missing" not found')
  expect(calls.some((call) => call.method === "DELETE" && call.path !== "/v1/networks/net_x")).toBe(false)
})

test("create carries a private network and an optional IP independently of internet mode", async () => {
  const result = await run(["create", "--private-network", "net_x:10.20.0.5", "--network", "registries"])
  expect(result.code).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/sandboxes", body: { privateNetwork: { id: "net_x", ip: "10.20.0.5" }, network: "registries" } })
  calls.length = 0
  expect((await run(["create", "--private-network", "backend"])).code).toBe(0)
  expect(calls[0]).toEqual({ method: "GET", path: "/v1/networks", body: null })
  expect(calls[1]).toMatchObject({ method: "POST", path: "/v1/sandboxes", body: { privateNetwork: { id: "net_x" } } })
  expect((calls[1]!.body as { privateNetwork: unknown }).privateNetwork).toEqual({ id: "net_x" })
})

test("a repeated --private-network joins them all", async () => {
  expect((await run(["create", "--private-network", "net_x:10.20.0.5", "--private-network", "net_y"])).code).toBe(0)
  expect(calls).toHaveLength(1)
  const body = calls[0]!.body as Record<string, unknown>
  expect(body.privateNetworks).toEqual([{ id: "net_x", ip: "10.20.0.5" }, { id: "net_y" }])
  expect(body.privateNetwork).toBeUndefined()
})

test("run and new pass the private network option to sandbox creation", async () => {
  refuseSandbox = true
  for (const verb of ["run", "new"]) {
    calls.length = 0
    const result = await run([verb, "--private-network", "net_x:10.20.0.5", "--", "true"])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("every address is taken")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/sandboxes", body: { privateNetwork: { id: "net_x", ip: "10.20.0.5" } } })
  }
})

test("invalid network command shapes and private network flags fail before a request", async () => {
  for (const args of [["networks"], ["networks", "create", "backend"], ["networks", "ls", "backend"], ["networks", "show"], ["networks", "rm", "net_x", "extra"], ["networks", "ls", "--cidr", network.cidr], ["networks", "move", "net_x"], ["create", "--private-network", ":10.20.0.5"], ["create", "--private-network", "net_x:"], ["create", "--private-network", "net_x:10.20.0.5:extra"], ["create", "--private-network", "net_x:invalid"]]) {
    expect((await run(args)).code).not.toBe(0)
  }
  expect(calls).toEqual([])
})
