import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deployment, DeploymentState, DeploymentView, ProjectView } from "../../shared/deploys"
import { VmsClient } from "./api"
import { deployCommand, DeployUsage, githubRepository, parseDeployArgs, resolveProject } from "./deploys"
import { FAILED } from "./output"

setDefaultTimeout(30_000)
const entry = join(import.meta.dir, "kyora.ts")
const project: ProjectView = { id: "prj_test", accountId: "usr_test", name: "test-app", installationId: 1, repoId: 2, repoFullName: "owner/repo", productionBranch: "main", region: "eu", createdAt: 1, deletedAt: null, url: "https://test-app.kyora.run", liveDeployment: null }
const deployment: Deployment = { id: "dpl_test", environment: "production", sha: "a".repeat(40), ref: "refs/heads/main", trigger: "cli", state: "queued", sequence: 1, releaseId: null, buildSandbox: null, runtimeSandbox: null, error: null, createdAt: 1, updatedAt: 1, finishedAt: null, expiresAt: null }
const detail = (state: DeploymentState): DeploymentView => ({ ...deployment, state, events: [{ at: 1, kind: "deploy.started", detail: null }], url: project.url, logsReady: true, logTail: "", error: state === "failed" ? { code: "build_failed", message: "build exited 1" } : null })
const notInstalled = { error: "not_installed", message: "install the kyora GitHub App on this repository", installUrl: "https://github.com/apps/kyora/installations/new" }
let root: string
let server: ReturnType<typeof Bun.serve>
let handler: (request: Request, url: URL) => Response | Promise<Response>
let calls: Array<{ method: string; path: string; auth: string | null; body: unknown }>
const realLog = console.log

async function git(args: string[], cwd = root) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  return stdout.trim()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyora-deploys-"))
  await git(["init", "--quiet"])
  calls = []
  handler = (_, url) => {
    if (url.pathname === "/v1/projects") return Response.json({ projects: [project] })
    if (url.pathname.endsWith("/deployments/dpl_test/logs")) return new Response("build output\n")
    if (url.pathname.endsWith("/deployments/dpl_test")) return Response.json(detail("live"))
    if (url.pathname.endsWith("/deployments")) return Response.json({ deployments: [deployment] })
    return Response.json(project)
  }
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url)
    calls.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get("authorization"), body: request.method === "POST" ? await request.clone().json() : null })
    return handler(request, url)
  } })
})

afterEach(async () => {
  console.log = realLog
  server.stop(true)
  await rm(root, { recursive: true, force: true })
})

const api = () => new VmsClient({ url: server.url.origin, key: "kyora_test" })
async function cli(args: string[], cwd = root) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, KYORA_VMS_URL: server.url.origin, KYORA_TOKEN: "kyora_test", KYORA_VMS_KEY: "kyora_test" } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

test("deploy commands parse flags and positionals with strict command-specific usage", () => {
  expect(parseDeployArgs("projects", ["create", "--repo", "owner/repo", "--name", "test-app", "--branch", "release", "--region", "eu", "--json"]).values).toMatchObject({ repo: "owner/repo", name: "test-app", branch: "release", region: "eu", json: true })
  for (const [group, args] of [
    ["projects", ["ls", "--json"]], ["projects", ["show"]], ["projects", ["show", "test-app", "--project", "prj_test"]], ["projects", ["rm", "test-app", "--yes"]],
    ["link", []], ["link", ["test-app", "--json"]], ["deploy", ["--prod", "--ref", "release", "--project", "test-app", "--follow", "--json"]],
    ["deploy", ["--env", "production", "--sha", "a".repeat(40)]], ["deployments", ["ls", "--project", "prj_test"]], ["deployments", ["logs", "dpl_test", "--follow"]],
  ] as const) expect(() => parseDeployArgs(group, [...args])).not.toThrow()
  for (const group of ["projects", "link", "deploy", "deployments"]) expect(parseDeployArgs(group, ["--help"]).values.help).toBe(true)
  for (const [group, args] of [
    ["projects", []], ["projects", ["create"]], ["projects", ["create", "--repo", "bad"]], ["projects", ["create", "--repo", "o/r", "extra"]],
    ["projects", ["ls", "extra"]], ["projects", ["ls", "--repo", "o/r"]], ["projects", ["show", "a", "b"]], ["projects", ["show", "../bad"]],
    ["projects", ["rm"]], ["projects", ["rm", "a", "--follow"]], ["link", ["a", "b"]], ["link", ["--yes"]], ["deploy", ["extra"]],
    ["deploy", ["--ref", "main", "--sha", "a".repeat(40)]], ["deploy", ["--sha", "short"]], ["deploy", ["--ref", ""]],
    ["deploy", ["--unknown"]], ["deploy", ["--project", "../bad"]], ["deployments", []], ["deployments", ["ls", "--follow"]],
    ["deployments", ["logs", "bad"]], ["deployments", ["logs", "dpl_a", "dpl_b"]], ["deployments", ["logs", "--region", "eu"]],
  ] as const) expect(() => parseDeployArgs(group, [...args])).toThrow(DeployUsage)
  expect(() => parseDeployArgs("deploy", ["--env", "preview"])).toThrow("not yet available")
})

test("usage failures exit nonzero without making API requests", async () => {
  for (const args of [["deploy", "--env", "staging"], ["deploy", "--ref", "main", "--sha", "a".repeat(40)], ["projects", "create"], ["deployments", "logs", "bad"]]) {
    const result = await cli(args)
    expect(result.code).toBe(FAILED)
    expect(result.stderr).toContain("usage:")
  }
  expect(calls).toHaveLength(0)
  const result = await cli(["--help"])
  expect(result.code).toBe(0)
  for (const command of ["projects", "link", "deploy", "deployments"]) expect(result.stdout).toContain(`kyora ${command}`)
})

test("project resolution uses flag before root project.json, including from subdirectories", async () => {
  const nested = join(root, "src", "nested")
  await mkdir(nested, { recursive: true })
  await mkdir(join(root, ".kyora"))
  await Bun.write(join(root, ".kyora", "project.json"), JSON.stringify({ project: project.id, name: project.name }))
  expect(await resolveProject(undefined, nested)).toBe(project.id)
  expect(await resolveProject("override", nested)).toBe("override")
  expect(await resolveProject("override", tmpdir())).toBe("override")
  expect((await cli(["deployments", "ls", "--json"], nested)).code).toBe(0)
  expect(calls.at(-1)?.path).toBe("/v1/projects/prj_test/deployments")
  expect((await cli(["projects", "show", "ignored", "--project", "override", "--json"], nested)).code).toBe(0)
  expect(calls.at(-1)?.path).toBe("/v1/projects/override")
  await cli(["deploy", "--project", "override"], nested)
  expect(calls.at(-1)?.path).toBe("/v1/projects/override/deployments")
})

test("missing and invalid project links give a clear usage error", async () => {
  await expect(resolveProject(undefined, root)).rejects.toThrow("run kyora link")
  await expect(resolveProject(undefined, tmpdir())).rejects.toThrow("run kyora link")
  const missing = await cli(["deploy"])
  expect(missing.code).toBe(FAILED)
  expect(missing.stderr).toContain("run kyora link")
  await mkdir(join(root, ".kyora"))
  for (const text of ["bad json", "null", "{}", '{"project":"../bad"}', '{"project":4}']) {
    await Bun.write(join(root, ".kyora", "project.json"), text)
    await expect(resolveProject(undefined, root)).rejects.toThrow("run kyora link again")
  }
  expect(calls).toHaveLength(0)
})

test("GitHub origin parsing accepts HTTPS and both SSH URL forms", () => {
  for (const remote of ["https://github.com/owner/repo", "https://github.com/owner/repo.git", "https://github.com/owner/repo.git/", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git", "ssh://git@github.com:22/owner/repo.git"]) expect(githubRepository(remote)).toBe("owner/repo")
  expect(githubRepository("https://GitHub.com/OWNER/REPO.git")).toBe("OWNER/REPO")
  for (const remote of ["https://gitlab.com/owner/repo", "file:///owner/repo", "http://github.com/owner/repo", "https://github.com/owner/repo/tree/main", "https://github.com/owner", "https://github.com/owner/repo?x=1", "git@github.com:owner/repo/extra", "not a URL"]) expect(githubRepository(remote)).toBeNull()
})

test("link matches origin in nested checkout directories and writes only the root link", async () => {
  const nested = join(root, "src")
  await mkdir(nested)
  await git(["remote", "add", "origin", "https://github.com/OWNER/REPO.git"])
  for (const remote of ["https://github.com/OWNER/REPO.git", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    await git(["remote", "set-url", "origin", remote])
    const result = await cli(["link", "--json"], nested)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(project)
    expect(await Bun.file(join(root, ".kyora", "project.json")).json()).toEqual({ project: project.id, name: project.name })
    expect(await Bun.file(join(nested, ".kyora", "project.json")).exists()).toBe(false)
  }
  await cli(["link", "explicit", "--json"], nested)
  expect(calls.at(-1)?.path).toBe("/v1/projects/explicit")
})

test("link reports no matching or several matching projects and invalid origin", async () => {
  const noOrigin = await cli(["link"])
  expect(noOrigin.code).toBe(FAILED)
  expect(noOrigin.stderr).toContain("origin must be a GitHub")
  await git(["remote", "add", "origin", "git@github.com:owner/repo.git"])
  handler = () => Response.json({ projects: [] })
  const none = await cli(["link"])
  expect(none.code).toBe(FAILED)
  expect(none.stderr).toContain("no project matches origin (owner/repo)")
  handler = () => Response.json({ projects: [project, { ...project, id: "prj_second", name: "second-app" }] })
  const several = await cli(["link"])
  expect(several.code).toBe(FAILED)
  expect(several.stderr).toContain("several projects match origin")
  expect(several.stderr).toContain("test-app, second-app")
  expect(await Bun.file(join(root, ".kyora", "project.json")).exists()).toBe(false)
})

test("projects create sends the shared request and prints project URL and first deployment", async () => {
  handler = (request, url) => url.pathname.endsWith("/deployments") ? Response.json({ deployments: [{ ...deployment, id: "dpl_new" }, deployment] }) : Response.json(project, { status: request.method === "POST" ? 201 : 200 })
  const result = await cli(["projects", "create", "--repo", "owner/repo", "--name", "test-app", "--branch", "release", "--region", "eu"])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain(project.id)
  expect(result.stdout).toContain(project.url)
  expect(result.stdout).toContain("First deployment: dpl_test")
  expect(calls[0]).toEqual({ method: "POST", path: "/v1/projects", auth: "Bearer kyora_test", body: { repo: "owner/repo", name: "test-app", productionBranch: "release", region: "eu" } })
  const asJson = await cli(["projects", "create", "--repo", "owner/repo", "--json"])
  expect(JSON.parse(asJson.stdout)).toEqual(project)
  expect(calls.at(-1)?.body).toEqual({ repo: "owner/repo" })
  expect(calls).toHaveLength(3)
})

test("not_installed prints the install URL and fails, preserving the API error with --json", async () => {
  handler = () => Response.json(notInstalled, { status: 409 })
  const result = await cli(["projects", "create", "--repo", "owner/repo"])
  expect(result.code).toBe(FAILED)
  expect(result.stderr).toContain(notInstalled.installUrl)
  const asJson = await cli(["projects", "create", "--repo", "owner/repo", "--json"])
  expect(asJson.code).toBe(FAILED)
  expect(JSON.parse(asJson.stdout)).toEqual(notInstalled)
})

test("project removal requires --yes off a TTY and honors TTY confirmation", async () => {
  const deleted = { id: project.id, state: "deleting" }
  handler = () => Response.json(deleted, { status: 202 })
  const refused = await cli(["projects", "rm", project.name])
  expect(refused.code).toBe(FAILED)
  expect(refused.stderr).toContain("requires --yes when stdin is not a TTY")
  expect(calls).toHaveLength(0)
  let prompt = ""
  expect(await deployCommand(api(), "projects", ["rm", project.name], { stdinIsTTY: true, confirm: async (message) => { prompt = message; return false } })).toBe(1)
  expect(prompt).toContain("VMs and snapshots")
  expect(calls).toHaveLength(0)
  console.log = () => {}
  expect(await deployCommand(api(), "projects", ["rm", project.name], { stdinIsTTY: true, confirm: async () => true })).toBe(0)
  expect(calls.at(-1)?.method).toBe("DELETE")
  const removed = await cli(["projects", "rm", project.name, "--yes", "--json"])
  expect(removed.code).toBe(0)
  expect(JSON.parse(removed.stdout)).toEqual(deleted)
  expect(calls.at(-1)?.path).toBe("/v1/projects/test-app")
})

test("list, show, deploy and logs preserve API shapes as one JSON document", async () => {
  const unknownFields = { ...project, futureField: { enabled: true } }
  handler = (request, url) => {
    if (url.pathname === "/v1/projects") return Response.json({ projects: [unknownFields] })
    if (url.pathname.endsWith("/logs")) return new Response("build output\n")
    if (url.pathname.endsWith("/deployments")) return Response.json(request.method === "POST" ? deployment : { deployments: [deployment] })
    return Response.json(unknownFields)
  }
  for (const [args, expected] of [
    [["projects", "ls", "--json"], { projects: [unknownFields] }],
    [["projects", "show", project.name, "--json"], unknownFields],
    [["deployments", "ls", "--project", project.id, "--json"], { deployments: [deployment] }],
    [["deploy", "--project", project.id, "--json"], deployment],
    [["deployments", "logs", "--project", project.id, "--json"], "build output\n"],
  ] as const) {
    const result = await cli([...args])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expected)
  }
  expect(calls.at(-1)?.path).toBe("/v1/projects/prj_test/deployments/dpl_test/logs")
  await cli(["deploy", "--project", project.name, "--prod", "--ref", "release"])
  expect(calls.at(-1)?.body).toEqual({ environment: "production", ref: "release" })
  await cli(["deploy", "--project", project.id, "--sha", deployment.sha])
  expect(calls.at(-1)?.body).toEqual({ environment: "production", sha: deployment.sha })
})

test("plain deployment logs select an explicit id and empty lists are clear", async () => {
  const result = await cli(["deployments", "logs", deployment.id, "--project", project.id])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("build output\n")
  expect(calls).toHaveLength(1)
  handler = () => Response.json({ deployments: [] })
  const missing = await cli(["deployments", "logs", "--project", project.id])
  expect(missing.code).toBe(FAILED)
  expect(missing.stderr).toContain("no deployments")
  expect((await cli(["deployments", "ls", "--project", project.id])).stdout).toBe("No deployments.\n")
  handler = () => Response.json({ projects: [] })
  expect((await cli(["projects", "ls"])).stdout).toBe("No projects.\n")
})

function followServer(terminal: DeploymentState, delayed = false) {
  let state: DeploymentState = "building"
  const output = { type: "stdout", data: "build café\n" }
  const exit = { type: "exit", code: terminal === "failed" ? 1 : terminal === "canceled" ? 130 : 0, signal: null, timedOut: false }
  handler = (request, url) => {
    if (url.pathname.endsWith("/logs")) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const bytes = new TextEncoder().encode(JSON.stringify(output) + "\n")
        const split = bytes.indexOf(0xc3) + 1
        controller.enqueue(bytes.slice(0, split))
        controller.enqueue(bytes.slice(split))
        const finish = () => { state = terminal; controller.enqueue(new TextEncoder().encode(JSON.stringify(exit))); controller.close() }
        if (delayed) { state = "starting"; setTimeout(finish, 1200) }
        else finish()
      } }), { headers: { "content-type": "application/x-ndjson" } })
    }
    if (url.pathname.endsWith("/deployments")) return Response.json(request.method === "POST" ? deployment : { deployments: [deployment] })
    return Response.json(detail(state))
  }
  return { output, exit }
}

test("deploy --follow streams output and status through quiet periods, exits zero when live and prints URL", async () => {
  followServer("live", true)
  const result = await cli(["deploy", "--project", project.id, "--follow"])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe(`${deployment.id}\nbuild café\n${project.url}\n`)
  for (const state of ["building", "starting", "live"]) expect(result.stderr).toContain(`${deployment.id}: ${state}`)
  expect(calls.some((call) => call.path.endsWith("/logs?follow=1"))).toBe(true)
})

test("deploy --follow fails for failed, canceled and retired deployments", async () => {
  for (const [state, code] of [["failed", 1], ["canceled", 130], ["retired", FAILED]] as const) {
    followServer(state)
    const result = await cli(["deploy", "--project", project.id, "--follow"])
    expect(result.code).toBe(code)
    expect(result.stdout).not.toContain(project.url)
    expect(result.stderr).toContain(state)
    if (state === "failed") expect(result.stderr).toContain("build exited 1")
  }
})

test("JSON follow emits unchanged deployment, status and log events as NDJSON", async () => {
  const { output, exit } = followServer("live")
  const result = await cli(["deploy", "--project", project.id, "--follow", "--json"])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([deployment, detail("building"), output, exit, detail("live")])
  followServer("failed")
  const failed = await cli(["deploy", "--project", project.id, "--follow", "--json"])
  expect(failed.code).toBe(1)
  expect(JSON.parse(failed.stdout.trim().split("\n").at(-1)!)).toEqual(detail("failed"))
  followServer("live")
  const logs = await cli(["deployments", "logs", "--project", project.id, "--follow", "--json"])
  expect(logs.code).toBe(0)
  expect(logs.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([detail("building"), output, exit, detail("live")])
})

test("follow rejects a truncated stream and preserves status API errors as NDJSON", async () => {
  handler = (request, url) => {
    if (url.pathname.endsWith("/logs")) return new Response('{"type":"stdout","data":"partial"}\n')
    return Response.json(request.method === "POST" ? deployment : detail("building"))
  }
  const truncated = await cli(["deploy", "--project", project.id, "--follow"])
  expect(truncated.code).toBe(FAILED)
  expect(truncated.stderr).toContain("ended before its exit event")
  handler = (request) => request.method === "POST" ? Response.json(deployment) : Response.json({ error: "not_found", message: "no such deployment" }, { status: 404 })
  const missing = await cli(["deploy", "--project", project.id, "--follow", "--json"])
  expect(missing.code).toBe(FAILED)
  expect(missing.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([deployment, { error: "not_found", message: "no such deployment" }])
})
