import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { baseEnv, cli, tempDir } from "./testing/fixtures"

let root: string
let server: Server<unknown>
let status = "pending"
let missing: Array<{ type: string; name: string; value: string }> | undefined
const calls: Array<{ method: string; path: string; body: unknown }> = []
const PROOF = "kyora-domain-verification=v1:0123456789abcdef0123456789abcdef01234567"
const domain = () => ({
  hostname: "shop.example.com", label: "my-app", status, reason: status === "pending" ? "waiting for shop.example.com to resolve through its CNAME to custom.kyora.run" : status === "unverified" ? "waiting for the TXT record _kyora-verify.shop.example.com; add it, then run kyora-vms domain status shop.example.com" : null,
  attached: true, dcv: "http", url: "https://shop.example.com", createdAt: "2026-10-05T00:00:00.000Z", checkedAt: "2026-10-05T00:00:00.000Z",
  records: [
    { type: "TXT", name: "_kyora-verify.shop.example.com", value: PROOF, purpose: "ownership", required: true, note: "proves the hostname is yours, for this kyora account; keep it" },
    { type: "CNAME", name: "shop.example.com", value: "custom.kyora.run", purpose: "routing", required: true },
    { type: "TXT", name: "_cf-custom-hostname.shop.example.com", value: "owner-1", purpose: "prevalidation", required: false, note: "optional until the CNAME resolves" },
  ],
  ...(missing ? { missing } : {}),
})
beforeEach(async () => {
  root = await tempDir("domains")
  calls.length = 0
  status = "pending"
  missing = undefined
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : null
    calls.push({ method: request.method, path, body })
    if (path === "/v1/domains/taken.example.com") return Response.json({ error: "domain_taken", message: "this hostname is already in use on kyora" }, { status: 409 })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (request.method === "POST") return (body as { hostname: string }).hostname === "taken.example.com" ? Response.json({ error: "domain_taken", message: "this hostname is already in use on kyora" }, { status: 409 }) : Response.json(domain(), { status: 201 })
    if (path === "/v1/domains") return Response.json({ domains: [domain(), { ...domain(), hostname: "old.example.com", attached: false, status: "active" }] })
    return Response.json({ ...domain(), serving: status === "active" })
  } })
})
afterEach(async () => { server.stop(true); await rm(root, { recursive: true, force: true }) })
const run = (args: string[]) => cli(args, { cwd: root, env: baseEnv(server.url.toString(), { HOME: root }) })

test("domain add sends the hostname and label and prints the DNS records to add", async () => {
  const result = await run(["domain", "add", "shop.example.com", "--to", "my-app"])
  expect(result.code).toBe(0)
  expect(calls).toEqual([{ method: "POST", path: "/v1/domains", body: { hostname: "shop.example.com", label: "my-app" } }])
  expect(result.stdout).toContain("shop.example.com → my-app (pending)")
  expect(result.stdout).toContain("Add these records at your DNS provider:")
  expect(result.stdout).toMatch(/TXT\s+_kyora-verify\.shop\.example\.com\s+kyora-domain-verification=v1:[0-9a-f]{40}\s+required/)
  expect(result.stdout).toMatch(/CNAME\s+shop\.example\.com\s+custom\.kyora\.run\s+required/)
  expect(result.stdout.indexOf("_kyora-verify")).toBeLessThan(result.stdout.indexOf("custom.kyora.run"))
  expect(result.stdout).toMatch(/TXT\s+_cf-custom-hostname\.shop\.example\.com\s+owner-1\s+optional/)
  expect(result.stdout).toContain("kyora-vms domain status shop.example.com")
  expect((await run(["domain", "add", "shop.example.com", "--to", "my-app", "--dcv", "txt"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ hostname: "shop.example.com", label: "my-app", dcv: "txt" })
  const json = await run(["domain", "add", "shop.example.com", "--to", "my-app", "--json"])
  expect(JSON.parse(json.stdout).records[1].value).toBe("custom.kyora.run")
  // not proven yet: it says the TXT comes first
  status = "unverified"
  const unverified = await run(["domain", "add", "shop.example.com", "--to", "my-app"])
  expect(unverified.stdout).toContain("shop.example.com → my-app (unverified)")
  expect(unverified.stdout).toContain("The TXT record verifies your ownership.")
})

test("domain status says which records are missing", async () => {
  status = "unverified"
  missing = [{ type: "TXT", name: "_kyora-verify.shop.example.com", value: PROOF }]
  const txt = await run(["domain", "status", "shop.example.com"])
  expect(txt.code).toBe(0)
  expect(txt.stdout).toContain("shop.example.com → my-app (unverified)")
  expect(txt.stdout).toContain("Missing:")
  expect(txt.stdout).toMatch(/Missing:\n\s+TXT\s+_kyora-verify\.shop\.example\.com\s+kyora-domain-verification=v1:[0-9a-f]{40}\n/)
  status = "pending"
  missing = [{ type: "CNAME", name: "shop.example.com", value: "custom.kyora.run" }]
  const cname = await run(["domain", "status", "shop.example.com"])
  expect(cname.stdout).toMatch(/Missing:\n\s+CNAME\s+shop\.example\.com\s+custom\.kyora\.run\n/)
  status = "active"
  missing = undefined
  expect((await run(["domain", "status", "shop.example.com"])).stdout).not.toContain("Missing:")
})

test("domain ls, status and rm", async () => {
  const listed = await run(["domain", "ls"])
  expect(listed.stdout).toContain("shop.example.com  my-app  pending")
  expect(listed.stdout).toContain("old.example.com  my-app  active  detached")
  status = "active"
  const shown = await run(["domain", "status", "shop.example.com"])
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("shop.example.com → my-app (active)")
  expect(shown.stdout).toContain("https://shop.example.com")
  expect(calls.at(-1)).toEqual({ method: "GET", path: "/v1/domains/shop.example.com", body: null })
  expect((await run(["domain", "rm", "shop.example.com"])).code).toBe(0)
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/v1/domains/shop.example.com", body: null })
})

test("the server's refusal is printed, and bad invocations make no requests", async () => {
  const refused = await run(["domain", "add", "taken.example.com", "--to", "my-app"])
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("this hostname is already in use on kyora")
  calls.length = 0
  for (const args of [["domain"], ["domain", "add", "shop.example.com"], ["domain", "add", "shop.example.com", "--to", "my-app", "--dcv", "email"], ["domain", "ls", "--to", "x"], ["domain", "status"], ["domain", "rm", "a.example.com", "b.example.com"], ["domain", "move", "a.example.com"]]) {
    expect({ args, code: (await run(args)).code === 0 }).toEqual({ args, code: false })
  }
  expect(calls).toHaveLength(0)
})
