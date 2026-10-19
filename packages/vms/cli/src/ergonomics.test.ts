import { afterEach, expect, test } from "bun:test"
import { VmsClient, type Sandbox } from "./api"
import { completion, completionNames } from "./completion"
import { attachSandbox, newSandbox, selectSandbox } from "./ergonomics"
import { friendlyName, resolveDestructiveTarget, resolveTarget, resolveSandbox, sandboxArgs, shortIds, validName } from "./names"
import { KEY, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, ENTRY } from "./testing/fixtures"

let vmd: FakeVmd | undefined
afterEach(async () => { await vmd?.stop() })

async function setup() {
  vmd = await startFakeVmd()
  return new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "/dev/null" })
}

const box = (id: string, name?: string) => ({ id, name } as Sandbox)

test("names validate and generated names are friendly", () => {
  for (const name of ["brisk-otter", "a", "a".repeat(32), "a-0"]) expect(validName(name)).toBe(name)
  for (const name of ["", "UPPER", "with_space", "a".repeat(33), "a.b", "a/b"]) expect(() => validName(name)).toThrow("name must")
  for (let i = 0; i < 100; i++) expect(friendlyName()).toMatch(/^[a-z]+-[a-z]+$/)
})

test("resolution: exact name/id, unique prefixes, ambiguity and missing", () => {
  const sandboxes = [box("sb_abc111", "brisk-otter"), box("sb_abc222", "calm-fox"), box("sb_def333")]
  expect(resolveSandbox(sandboxes, "brisk-otter")).toBe(sandboxes[0]!)
  expect(resolveSandbox(sandboxes, "sb_abc111")).toBe(sandboxes[0]!)
  expect(resolveSandbox(sandboxes, "sb_def")).toBe(sandboxes[2]!)
  expect(() => resolveSandbox(sandboxes, "sb_abc")).toThrow("brisk-otter  sb_abc111\n  calm-fox  sb_abc222")
  expect(() => resolveSandbox(sandboxes, "missing")).toThrow("no sandbox")
  expect(() => resolveSandbox(sandboxes, "")).toThrow("must not be empty")
  const ids = shortIds(sandboxes)
  expect(new Set(ids).size).toBe(3)
  ids.forEach((id, i) => expect(resolveSandbox(sandboxes, id)).toBe(sandboxes[i]!))
})

test("new creates with interactive defaults before attaching main, carrying a command", async () => {
  const api = await setup()
  vmd!.options.defaultTtlSeconds = 5400
  const calls: unknown[] = []
  const open = async (_api: VmsClient, id: string, options: Parameters<typeof attachSandbox>[2]) => {
    calls.push({ id, options, present: vmd!.sandboxes.has(id) })
    return 0
  }
  expect(await newSandbox(api, { name: "brisk-otter" }, 0, { io: { isTTY: true } as any, cmd: ["htop"] }, open)).toBe(0)
  expect(vmd!.created[0]).toMatchObject({ name: "brisk-otter", network: "registries", idleSeconds: 3600 })
  expect(vmd!.created[0]).not.toHaveProperty("ttlSeconds")
  const created = [...vmd!.sandboxes.values()][0]!
  expect(Math.round((Date.parse(created.expiresAt!) - Date.parse(created.createdAt)) / 60_000)).toBe(90)
  expect(calls[0]).toMatchObject({ present: true, options: { name: "main", sandboxName: "brisk-otter", cmd: ["htop"] } })
})

test("attach without an argument: none, one, several and a TTY picker", async () => {
  const api = await setup()
  await expect(selectSandbox(api, undefined, false)).rejects.toThrow("kyora-vms new")
  const first = await api.create({ name: "brisk-otter" })
  expect((await selectSandbox(api, undefined, false)).id).toBe(first.id)
  const second = await api.create({ name: "calm-fox" })
  await expect(selectSandbox(api, undefined, false)).rejects.toThrow("several sandboxes")
  expect((await selectSandbox(api, undefined, true, async () => "2")).id).toBe(second.id)
  expect((await selectSandbox(api, "brisk-otter", false)).id).toBe(first.id)
})

test("CLI name UX: create stays scriptable, table/json, rename, ttl, multi-rm, sizes", async () => {
  await setup()
  const env = baseEnv(vmd!.url)
  for (const verb of ["create", "new"]) expect((await cli([verb, ""], { env })).code).toBe(125)
  expect(vmd!.created).toHaveLength(0)
  const created = await cli(["create", "brisk-otter", "--size", "l", "--cpus", "4"], { env })
  expect(created.code).toBe(0)
  expect(created.stdout.trim()).toMatch(/^sb_/)
  expect(vmd!.created[0]).toMatchObject({ name: "brisk-otter", vcpus: 4, memoryMb: 16384 })
  expect((await cli(["rm", ""], { env })).code).toBe(125)
  expect((await cli(["ls", ""], { env })).code).toBe(125)
  expect(vmd!.sandboxes.size).toBe(1)
  const listed = await cli(["ls"], { env })
  expect(listed.stdout).toMatch(/NAME\s+ID\s+IMAGE\s+SIZE\s+NET\s+AGE\s+EXPIRES\s+IDLE\s+SHELLS/)
  expect(listed.stdout).toContain("brisk-otter")
  expect(listed.stdout).toContain("4/16G")
  const allJson = await cli(["ls", "--json"], { env })
  expect(JSON.parse(allJson.stdout)).toMatchObject({ sandboxes: [{ name: "brisk-otter", id: created.stdout.trim() }] })
  const json = await cli(["ls", "brisk-otter", "--json"], { env })
  expect(JSON.parse(json.stdout)).toMatchObject({ name: "brisk-otter", id: created.stdout.trim() })
  expect((await cli(["rename", "brisk-otter", "calm-fox"], { env })).code).toBe(0)
  expect((await cli(["ttl", "calm-fox", "2h", "--json"], { env })).code).toBe(0)
  expect((await cli(["ttl", "calm-fox", "9h"], { env })).code).toBe(0)
  const unlimited = await cli(["ttl", "calm-fox", "none", "--json"], { env })
  expect(unlimited.code).toBe(0)
  expect(JSON.parse(unlimited.stdout)).toMatchObject({ ttlSeconds: 0, expiresAt: null })
  expect((await cli(["ls"], { env })).stdout).toContain("no expiry")
  vmd!.options.maxTtlSeconds = 3600
  expect((await cli(["ttl", "calm-fox", "none"], { env })).code).toBe(125)
  expect((await cli(["ttl", "calm-fox", "2h"], { env })).code).toBe(125)
  delete vmd!.options.maxTtlSeconds
  expect((await cli(["exec", "calm-fox", "--", "echo", "hi"], { env })).stdout).toBe("hi\n")
  expect((await cli(["create", "tidy-wren"], { env })).code).toBe(0)
  const removed = await cli(["rm", "calm-fox", "tidy-wren"], { env })
  expect(removed.code).toBe(0)
  expect(removed.stdout).toContain("removed calm-fox")
  expect(vmd!.sandboxes.size).toBe(0)
}, 30_000)

test("new -- command works without a TTY, defaults and overrides; bare new doesn't create", async () => {
  await setup()
  const env = baseEnv(vmd!.url)
  expect((await cli(["new"], { env })).code).toBe(125)
  expect(vmd!.created).toHaveLength(0)
  const result = await cli(["new", "brisk-otter", "--network", "none", "--ttl", "2h", "--", "echo", "hello"], { env })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("hello\n")
  expect(result.stderr).toContain("back in: kyora-vms attach brisk-otter · gone: kyora-vms rm brisk-otter")
  expect(vmd!.created[0]).toMatchObject({ network: "none", ttlSeconds: 7200, idleSeconds: 3600 })
})

test("completion scripts and five-second cache include sandbox names", async () => {
  const api = await setup()
  await api.create({ name: "brisk-otter" })
  for (const sh of ["bash", "zsh", "fish"]) {
    expect(completion(sh)).toContain("__complete")
    expect(completion(sh)).toContain("attach")
    expect((await cli(["completion", sh], { env: baseEnv(vmd!.url) })).code).toBe(0)
  }
  expect(() => completion("powershell")).toThrow("bash, zsh or fish")
  const cacheKey = crypto.randomUUID()
  expect(await completionNames(api, cacheKey)).toEqual(["brisk-otter"])
  await api.create({ name: "tidy-wren" })
  expect(await completionNames(api, cacheKey)).toEqual(["brisk-otter"])
})

test("real terminal: bare hints, new creates and attaches, attach picks the only sandbox", async () => {
  if (!Bun.which("python3")) return
  await setup()
  const script = `
import os, pty, sys, time, json, select, signal
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
seen = b""
status = None
detached = False
deadline = time.time() + 8
try:
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                seen += os.read(fd, 65536)
            except OSError:
                break
        if not detached and b"\\x1b[2J" in seen:
            os.write(fd, b"~.")
            detached = True
        done, result = os.waitpid(pid, os.WNOHANG)
        if done:
            status = result
            break
    if status is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if not done:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    print(json.dumps({"code": os.waitstatus_to_exitcode(status), "seen": seen.decode("utf-8", "replace")}))
finally:
    os.close(fd)
`
  const terminal = async (args: string[], extra: Record<string, string> = {}) => {
    const env = Object.fromEntries(Object.entries(baseEnv(vmd!.url, { TERM: "xterm-256color", ...extra })).filter(([, value]) => value !== undefined)) as Record<string, string>
    const proc = Bun.spawn(["python3", "-c", script, process.execPath, "--no-env-file", ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect([code, err]).toEqual([0, ""])
    const report = JSON.parse(out) as { code: number; seen: string }
    expect(report.code).toBe(0)
    return report.seen
  }
  const before = vmd!.requests.length
  const fresh = await terminal([], { KYORA_VMS_KEY: "", KYORA_TOKEN: "" })
  expect(fresh).toContain("kyora-vms login")
  expect(fresh).not.toContain("no API key")
  expect(vmd!.requests).toHaveLength(before)
  expect(await terminal([])).toContain("start a fresh VM: kyora-vms new")
  expect(await terminal(["new", "brisk-otter"])).toContain("back in: kyora-vms attach brisk-otter · gone: kyora-vms rm brisk-otter")
  expect(vmd!.created).toHaveLength(1)
  expect(await terminal([])).toContain("back in: kyora-vms attach <name>")
  expect(await terminal(["attach"])).toContain("back in: kyora-vms attach brisk-otter")
}, 40_000)

test("names use authoritative get before list; an old full id remains idempotent", async () => {
  const sandbox = box("sb_abcdef_wIVUMTr4Ov2p5ef6", "brisk-otter")
  const api = { get: async () => sandbox, list: async () => { throw new Error("stale list must not be used") } }
  expect(await resolveTarget(api, "brisk-otter")).toBe(sandbox.id)
  expect(await selectSandbox(api, "brisk-otter", false)).toBe(sandbox)
  expect(await resolveTarget({ ...api, list: async () => [] }, "sb_AbCdEfGhIjKl_nOp")).toBe("sb_AbCdEfGhIjKl_nOp")
  expect(await resolveTarget({ ...api, list: async () => [sandbox] }, sandbox.id.slice(0, 19))).toBe(sandbox.id)
})

test("leading-dash names work after --, including remote command separators", async () => {
  await setup()
  const env = baseEnv(vmd!.url)
  expect((await cli(["create", "--", "-box"], { env })).code).toBe(0)
  const fresh = await cli(["new", "--name=-fresh", "--", "echo", "fresh"], { env })
  expect(fresh.code).toBe(0)
  expect(fresh.stderr).toContain("back in: kyora-vms attach -- -fresh · gone: kyora-vms rm -- -fresh")
  expect(JSON.parse((await cli(["ls", "--json", "--", "-box"], { env })).stdout)).toMatchObject({ name: "-box" })
  expect((await cli(["exec", "--", "-box", "--", "echo", "escaped"], { env })).stdout).toBe("escaped\n")
  expect(sandboxArgs("shell", [], ["-box"])).toEqual({ positionals: ["-box"], tail: null })
  expect(sandboxArgs("computer", [], ["-box", "type", "--", "-text"])).toEqual({ positionals: ["-box", "type"], tail: ["-text"] })
  expect((await cli(["rename", "--", "-box", "-renamed"], { env })).code).toBe(0)
  expect((await cli(["ttl", "--", "-renamed", "2h"], { env })).code).toBe(0)
  expect((await cli(["rm", "--", "-renamed"], { env })).code).toBe(0)
}, 30_000)

test("rm cannot turn a stale prefix read into an unchecked full-id DELETE", async () => {
  const api = await setup()
  const first = await api.create({ name: "brisk-otter" })
  const second = await api.create({ name: "calm-fox" })
  const requests: string[] = []
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (request.method === "GET" && url.pathname === "/v1/sandboxes") return Response.json({ sandboxes: [first] })
    if (url.pathname.endsWith("/resolve")) {
      const input = decodeURIComponent(url.pathname.split("/").at(-2)!)
      const matches = [...vmd!.sandboxes.values()].filter((s) => s.id === input || s.name === input || s.id.startsWith(input))
      if (matches.length > 1) return Response.json({ error: "ambiguous_prefix", message: `ambiguous: ${matches.map((s) => s.id).join(", ")}` }, { status: 409 })
      return Response.json({ id: matches[0]!.id })
    }
    return fetch(new Request(`${vmd!.url}${url.pathname}${url.search}`, request))
  } })
  try {
    const env = baseEnv(proxy.url.toString())
    expect((await cli(["ls", "sb_00000000", "--json"], { env })).code).toBe(0)
    const removed = await cli(["rm", "sb_00000000"], { env })
    expect(removed.code).toBe(125)
    expect(removed.stderr).toContain(second.id)
    for (const args of [["rename", "sb_00000000", "eager-owl"], ["ttl", "sb_00000000", "2h"], ["shell", "sb_00000000", "--kill", "main"]]) {
      const result = await cli(args, { env })
      expect(result.code).toBe(125)
      expect(result.stderr).toContain(second.id)
    }
    expect(requests.filter((request) => request.startsWith("PATCH"))).toEqual([])
    expect(vmd!.sandboxes.size).toBe(2)
    expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([])
    expect(requests).toContain("GET /v1/sandboxes/sb_00000000/resolve")
    await api.destroy(second.id)
    expect((await cli(["rm", "sb_00000000"], { env })).code).toBe(0)
    expect(vmd!.sandboxes.size).toBe(0)
  } finally {
    proxy.stop(true)
  }
})

test("non-TTY rm --all refuses before DELETE and --yes is an explicit override", async () => {
  const api = await setup()
  await api.create({ name: "brisk-otter" })
  await api.create({ name: "calm-fox" })
  const env = baseEnv(vmd!.url)
  const refused = await cli(["rm", "--all"], { env })
  expect(refused.code).toBe(125)
  expect(refused.stderr).toContain("--yes")
  expect(vmd!.sandboxes.size).toBe(2)
  expect(vmd!.requests.filter((request) => request.startsWith("DELETE"))).toEqual([])
  expect((await cli(["rm", "--all", "--yes"], { env })).code).toBe(0)
  expect(vmd!.sandboxes.size).toBe(0)
})

test("destructive resolution fails closed when the authoritative endpoint is unavailable", async () => {
  let reads = 0
  const api = {
    resolve: async () => { throw new Error("no such route") },
    get: async () => { reads++; return box("sb_0000000000000001", "brisk-otter") },
    list: async () => { reads++; return [box("sb_0000000000000001", "brisk-otter")] },
  }
  for (const input of ["sb_00000000", "brisk-otter"]) await expect(resolveDestructiveTarget(api, input)).rejects.toThrow("no such route")
  expect(reads).toBe(0)
  expect(await resolveDestructiveTarget(api, "sb_0000000000000001")).toBe("sb_0000000000000001")
})

test("legacy full ids delete against an older server without a resolver; a GET-expanded prefix never does", async () => {
  const legacy = "sb_AbCdEfGhIjKl_nOp"
  const longer = `${legacy}suffix`
  const requests: string[] = []
  let exact = true
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path.endsWith("/resolve")) return Response.json({ error: "not_found", message: "no such route" }, { status: 404 })
    if (request.method === "GET" && path === "/v1/sandboxes") return Response.json({ sandboxes: [{ id: exact ? legacy : longer }] })
    if (request.method === "GET" && path === `/v1/sandboxes/${legacy}`) return Response.json({ id: exact ? legacy : longer, name: "legacy" })
    if (request.method === "DELETE" && path === `/v1/sandboxes/${legacy}`) return new Response(null, { status: 204 })
    return Response.json({ error: "not_found", message: "no such route" }, { status: 404 })
  } })
  try {
    const env = baseEnv(server.url.toString())
    expect((await cli(["ls", legacy, "--json"], { env })).code).toBe(0)
    requests.length = 0
    expect((await cli(["rm", legacy], { env })).code).toBe(0)
    expect(requests).toContain(`GET /v1/sandboxes/${legacy}`)
    expect(requests).toContain(`DELETE /v1/sandboxes/${legacy}`)
    expect(requests).not.toContain("GET /v1/sandboxes")
    exact = false
    requests.length = 0
    expect((await cli(["rm", legacy], { env })).code).toBe(125)
    expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual([])
    expect(requests).not.toContain("GET /v1/sandboxes")
  } finally {
    server.stop(true)
  }
})
