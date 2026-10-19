import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { saveLogin } from "./credentials"
import { cli, platformEnv, tempDir } from "./testing/fixtures"

let root: string
let server: Server<unknown>
const calls: Array<{ method: string; path: string; body: unknown }> = []
const authorizations: Array<string | null> = []
const record = { id: "tok_deploy", name: "deploy", scopes: ["vms:write"], expiresAt: "2026-11-01T00:00:00Z", revokedAt: null }

beforeEach(async () => {
  root = await tempDir("tokens")
  calls.length = 0
  authorizations.length = 0
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname
    authorizations.push(request.headers.get("authorization"))
    calls.push({ method: request.method, path, body: request.method === "POST" ? await request.json() : undefined })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json(request.method === "POST" ? { token: "kyora_deploy_once", record } : { tokens: [record] }, { status: request.method === "POST" ? 201 : 200 })
  } })
})

afterEach(async () => { server.stop(true); await rm(root, { recursive: true, force: true }) })
const run = (args: string[]) => cli(args, { cwd: root, env: platformEnv(server.url.href) })

test("tokens create sends capabilities, selector, limits and expiry, and prints the secret once", async () => {
  const created = await run(["tokens", "create", "deploy", "--scope", "vms:write,vms:exec", "--scope", "public-urls", "--label", "team=deploy", "--label", "app=web=one", "--region", "us", "--region", "apac", "--max-sandboxes", "2", "--max-vcpus", "2", "--max-memory", "2G", "--max-ttl", "1h", "--network", "registries", "--names", "deploy-web,deploy-api", "--name-prefix", "deploy-", "--expires", "30d"])
  expect(created.code).toBe(0)
  expect(created.stdout.trim()).toBe("kyora_deploy_once")
  expect(calls).toEqual([{ method: "POST", path: "/v1/tokens", body: {
    name: "deploy", scopes: ["vms:write", "vms:exec", "public-urls"], expires: "30d",
    constraints: { labels: { team: "deploy", app: "web=one" }, regions: ["us", "apac"], maxSandboxes: 2, maxVcpus: 2, maxMemoryMb: 2048, maxTtlSeconds: 3600, networkModes: ["registries"], names: ["deploy-web", "deploy-api"], namePrefix: "deploy-" },
  } }])
})

test("tokens ls and revoke support structured output and org tokens", async () => {
  const listed = await run(["tokens", "ls", "--json"])
  expect(listed.code).toBe(0)
  expect(JSON.parse(listed.stdout)).toEqual({ tokens: [record] })
  const created = await run(["tokens", "create", "deploy", "--scope", "vms:write", "--org", "acme", "--json"])
  expect(created.code).toBe(0)
  expect(JSON.parse(created.stdout).token).toBe("kyora_deploy_once")
  const revoked = await run(["tokens", "revoke", "tok_deploy", "--org", "acme", "--json"])
  expect(revoked.code).toBe(0)
  expect(JSON.parse(revoked.stdout)).toEqual({ revoked: "tok_deploy" })
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/tokens", "POST /v1/orgs/acme/tokens", "DELETE /v1/orgs/acme/tokens/tok_deploy"])
})

test("tokens validates required scopes, label pairs and command-specific flags", async () => {
  for (const args of [["tokens", "create", "deploy"], ["tokens", "create", "deploy", "--scope", "vms:write", "--label", "bad"], ["tokens", "ls", "--scope", "vms:read"], ["tokens", "revoke"], ["tokens", "create", "deploy", "--scope", "vms:write", "--network", "bad"]]) expect((await run(args)).code).not.toBe(0)
  expect(calls).toEqual([])
  expect((await run(["tokens", "--help"])).stdout).toContain("--max-sandboxes")
})

test("explicit org token management sends the stored personal credential after org use", async () => {
  const origin = server.url.origin
  await saveLogin(join(root, ".config", "kyora", "credentials.json"), origin, { token: "kyora_personal", login: "owner", url: origin, use: "acme", orgs: { acme: { token: "kyora_active_org", id: "usr_acme", login: "acme", actor: "owner", expiresAt: null } } })
  const env = platformEnv(server.url.href, { HOME: root, KYORA_TOKEN: undefined })
  for (const args of [["ls"], ["create", "deploy", "--scope", "vms:write"], ["revoke", "tok_deploy"]]) {
    expect((await cli(["tokens", ...args, "--org", "acme", "--json"], { cwd: root, env })).code).toBe(0)
  }
  expect(authorizations).toEqual(["Bearer kyora_personal", "Bearer kyora_personal", "Bearer kyora_personal"])
})

test("explicit environment credentials keep precedence for org token management", async () => {
  const origin = server.url.origin
  await saveLogin(join(root, ".config", "kyora", "credentials.json"), origin, { token: "kyora_personal", login: "owner", url: origin, use: "acme", orgs: { acme: { token: "kyora_active_org", id: "usr_acme", login: "acme", actor: "owner", expiresAt: null } } })
  expect((await cli(["tokens", "ls", "--org", "acme", "--json"], { cwd: root, env: platformEnv(server.url.href, { HOME: root, KYORA_TOKEN: "kyora_explicit" }) })).code).toBe(0)
  expect(authorizations).toEqual(["Bearer kyora_explicit"])
})

test("project deploy keys send capabilities and repeated project constraints", async () => {
  const response = await run(["tokens", "create", "project-deploy", "--scope", "projects:read,deploys", "--project", "web,prj_one", "--project", "api"])
  expect(response.code).toBe(0)
  expect(calls).toEqual([{ method: "POST", path: "/v1/tokens", body: { name: "project-deploy", scopes: ["projects:read", "deploys"], constraints: { projects: ["web", "prj_one", "api"] }, expires: "30d" } }])
})

test("token completion includes project scopes and constraints in every shell", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const response = await run(["completion", shell])
    expect(response.code).toBe(0)
    expect(response.stdout).toContain("projects:read")
    expect(response.stdout).toContain("deploys")
    expect(response.stdout).toContain(shell === "fish" ? "-l project" : "--project")
    expect(response.stdout).toContain("create ls revoke")
  }
})
