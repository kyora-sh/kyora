import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { McpServer, PROTOCOL_VERSIONS, redact, validate, type Frame } from "./mcp"
import { kyoraTools, Tail, toolContext, type Tool } from "./mcp-tools"
import { startFakeCloud, type FakeCloud } from "./testing/fake-cloud"
import { startFakePlatform, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { platformEnv, tempDir, waitFor, write } from "./testing/fixtures"

const KYORA = join(import.meta.dir, "kyora.ts")

let platform: FakeVmd
let cloud: FakeCloud
let root: string

beforeAll(async () => {
  platform = await startFakePlatform()
  cloud = startFakeCloud()
  root = await tempDir("mcp")
})
afterAll(async () => {
  await platform.stop()
  cloud.stop()
  await rm(root, { recursive: true, force: true })
})

const serverFor = (url: string, tools: Tool[] = kyoraTools()) => new McpServer({ tools, context: (signal) => toolContext(signal, platformEnv(url), root), secrets: () => [TOKEN] })

let ids = 0
async function request(server: McpServer, method: string, params?: unknown): Promise<Frame> {
  const frames = await server.line(JSON.stringify({ jsonrpc: "2.0", id: ++ids, method, ...(params === undefined ? {} : { params }) }))
  expect(frames).toHaveLength(1)
  return frames[0] as Frame
}

/** a tool's answer: its JSON, or its error text */
async function call(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; value: any }> {
  const frame = await request(server, "tools/call", { name, arguments: args })
  if (frame.error) throw new Error(`${frame.error.code}: ${frame.error.message}`)
  const result = frame.result as { content: Array<{ type: string; text: string }>; isError: boolean }
  expect(result.content[0]!.type).toBe("text")
  const text = result.content[0]!.text
  let value: unknown = null
  try { value = JSON.parse(text) } catch {}
  return { isError: result.isError, text, value }
}

describe("kyora mcp: the tools", () => {
  test("the tool list: names and required arguments", () => {
    const tools = kyoraTools()
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]))).toEqual({
      whoami: [],
      vms_list: [],
      vms_create: [],
      vms_exec: ["sandbox", "command"],
      vms_run: ["command"],
      vms_push: ["sandbox"],
      vms_pull: ["sandbox", "paths"],
      vms_destroy: ["sandboxes"],
      vms_rename: ["sandbox", "name"],
      vms_ttl: ["sandbox", "ttl"],
      images_list: [],
      regions_list: [],
      usage_top: [],
      session_status: [],
      projects_list: [],
      deploy: [],
      deployments_list: [],
      deployment_logs: [],
      domains_add: ["hostname"],
      domains_list: [],
      domains_status: ["hostname"],
      domains_remove: ["hostname"],
      expose: ["sandbox", "port"],
      ports_list: [],
      unexpose: ["label"],
      storage_buckets: [],
      storage_ls: ["bucket"],
      storage_put: ["bucket", "key"],
      storage_get: ["bucket", "key"],
      storage_rm: ["bucket", "key"],
      storage_presign: ["bucket", "key"],
      publish: ["path"],
      pages_list: [],
      pages_delete: ["name"],
      pages_login_url: ["name"],
    })
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false })
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(name).toMatch(/^[a-z][a-z_]*$/)
        expect(property.description?.length ?? 0).toBeGreaterThan(5)
      }
      for (const name of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties).toHaveProperty(name)
    }
  })

  test("vms_create, vms_exec with its exit code and output tails, vms_list, vms_destroy", async () => {
    const server = serverFor(platform.url)
    const created = await call(server, "vms_create", { name: "mcp-box", network: "registries", size: "s" })
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ name: "mcp-box", network: "registries", vcpus: 2 })
    const id = created.value.id as string

    const ran = await call(server, "vms_exec", { sandbox: "mcp-box", command: "printf out; printf err >&2; exit 3", env: { A: "1" }, timeout_seconds: 60 })
    expect(ran.value).toMatchObject({ sandbox: id, exit_code: 3, stdout: "out", stderr: "err", stdout_bytes: 3, stderr_bytes: 3 })
    expect(platform.execs.at(-1)).toMatchObject({ cmd: ["sh", "-c", "printf out; printf err >&2; exit 3"], env: { A: "1" }, timeoutSeconds: 60 })

    const long = await call(server, "vms_exec", { sandbox: id, command: "i=0; while [ $i -lt 500 ]; do printf 0123456789; i=$((i+1)); done; echo; echo end", output_limit: 1000 })
    expect(long.value.exit_code).toBe(0)
    expect(long.value.stdout).toHaveLength(1000)
    expect(long.value.stdout.endsWith("\nend\n")).toBe(true)
    expect(long.value.stdout_bytes).toBe(5005)
    expect(long.value.truncated).toEqual({ stdout: true, stderr: false })

    expect((await call(server, "vms_list")).value.sandboxes.map((s: { id: string }) => s.id)).toContain(id)
    expect((await call(server, "vms_destroy", { sandboxes: ["mcp-box"] })).value).toEqual({ removed: [id], gone: [] })
    expect(platform.destroyed).toContain(id)
  })

  test("a VM that arrives after its create was cancelled is destroyed", async () => {
    const slow = await startFakePlatform({ latencyMs: 300 })
    try {
      const server = serverFor(slow.url)
      const pending = server.line(JSON.stringify({ jsonrpc: "2.0", id: "create-1", method: "tools/call", params: { name: "vms_create", arguments: { name: "late-box" } } }))
      await waitFor(() => slow.requests.includes("POST /v1/sandboxes"), 5_000, "the create")
      await server.line(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "create-1" } }))
      expect(await pending).toEqual([])
      const created = await waitFor(() => slow.sandboxes.size === 0 && slow.destroyed.length === 1 && slow.destroyed, 5_000, "the destroy")
      expect(created).toHaveLength(1)
    } finally {
      await slow.stop()
    }
  })

  test("a cancelled vms_run destroys its VM at once, while its upload still hangs", async () => {
    const stuck = await startFakePlatform({ part: () => new Promise<Response | null>(() => {}) })
    try {
      const server = serverFor(stuck.url)
      await write(root, "stuck/a.txt", "a")
      const pending = server.line(JSON.stringify({ jsonrpc: "2.0", id: "run-1", method: "tools/call", params: { name: "vms_run", arguments: { dir: "stuck", git: false, command: "true" } } }))
      await waitFor(() => stuck.partPuts.length > 0, 5_000, "the upload")
      await server.line(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "run-1" } }))
      await waitFor(() => stuck.destroyed.length === 1, 3_000, "the destroy")
      expect(await pending).toEqual([])
    } finally {
      await stuck.stop()
    }
  }, 20_000)

  test("vms_run uploads the directory, runs, pulls `out` back and destroys the VM; vms_push and vms_pull", async () => {
    const server = serverFor(platform.url)
    const project = join(root, "project")
    await write(project, "hello.txt", "hello from here\n")
    const out = join(root, "results")
    const ran = await call(server, "vms_run", { dir: "project", git: false, command: "mkdir -p dist && tr a-z A-Z < hello.txt > dist/HELLO.txt && cat dist/HELLO.txt", out: ["dist"], to: "results" })
    expect(ran.isError).toBe(false)
    expect(ran.value).toMatchObject({ kept: false, exit_code: 0, stdout: "HELLO FROM HERE\n" })
    expect(ran.value.downloads[0]).toMatchObject({ path: "/work/dist", to: out })
    expect(await readFile(join(out, "dist/HELLO.txt"), "utf8")).toBe("HELLO FROM HERE\n")
    expect(platform.destroyed).toContain(ran.value.sandbox.id)

    const kept = await call(server, "vms_run", { dir: "project", git: false, command: "exit 7", keep: true })
    expect(kept.value).toMatchObject({ kept: true, exit_code: 7 })
    const id = kept.value.sandbox.id as string
    expect(platform.destroyed).not.toContain(id)
    await write(root, "more/extra.txt", "extra\n")
    expect((await call(server, "vms_push", { sandbox: id, dir: "more", git: false, dest: "/work/more" })).value).toMatchObject({ sandbox: id, dest: "/work/more" })
    const pulled = await call(server, "vms_pull", { sandbox: id, paths: ["more/extra.txt", "missing.txt"], to: "pulled" })
    expect(pulled.value.downloads[0]).toMatchObject({ path: "/work/more/extra.txt" })
    expect(pulled.value.downloads[1]).toMatchObject({ path: "/work/missing.txt" })
    expect(pulled.value.downloads[1].error).toBeDefined()
    expect(await readFile(join(root, "pulled/more/extra.txt"), "utf8")).toBe("extra\n")
    await call(server, "vms_destroy", { sandboxes: [id] })
  })

  test("whoami, images: no token in what comes back, even when the server echoes it", async () => {
    const server = serverFor(cloud.url)
    cloud.me = { login: "ada", kind: "user", token: { name: `laptop ${TOKEN}`, scopes: ["vms"], expiresAt: null } }
    const me = await call(server, "whoami")
    expect(me.value).toMatchObject({ login: "ada", url: cloud.url, source: "$KYORA_TOKEN" })
    expect(me.text).not.toContain(TOKEN)
    expect(me.value.token.name).toBe("laptop [redacted]")
    expect((await call(serverFor(platform.url), "images_list")).value).toHaveProperty("images")
  })

  test("the account tools against kyora cloud's routes", async () => {
    const server = serverFor(cloud.url)
    const id = "sb_eu_abc123_0123456789abcdef"
    expect((await call(server, "vms_rename", { sandbox: "brisk-otter", name: "calm-pine" })).value).toMatchObject({ id, name: "calm-pine" })
    expect((await call(server, "vms_ttl", { sandbox: id, ttl: "4h" })).value.expiresAt).toBe("2026-10-22T04:00:00.000Z")
    expect(cloud.requests).toContain(`PATCH /v1/sandboxes/${id}`)
    expect((await call(server, "regions_list")).value.you.region).toBe("eu")
    expect((await call(server, "usage_top", { wait_seconds: 2 })).value.vms[0]).toMatchObject({ id, name: "brisk-otter" })

    expect((await call(server, "expose", { sandbox: "brisk-otter", port: 3000, name: "my-app", public: true })).value).toMatchObject({ url: "https://my-app.kyora.run", private: false })
    expect((await call(server, "ports_list")).value.ports).toHaveLength(1)
    expect((await call(server, "unexpose", { label: "my-app" })).value).toEqual({ released: true, label: "my-app" })
    expect(cloud.requests).toContain("DELETE /v1/ports/my-app")

    expect((await call(server, "domains_add", { hostname: "shop.example.com", to: "my-app" })).value).toMatchObject({ label: "my-app", status: "unverified" })
    expect((await call(server, "domains_add", { hostname: "docs.example.com", page: "build-report" })).value).toMatchObject({ label: "page:build-report", page: "build-report" })
    expect((await call(server, "domains_add", { hostname: "x.example.com" }).catch((error: Error) => error)).toString()).toContain("give to (a public URL name) or page")
    expect((await call(server, "domains_list")).value.domains).toHaveLength(1)
    expect((await call(server, "domains_status", { hostname: "shop.example.com" })).value.serving).toBe(true)
    expect((await call(server, "domains_remove", { hostname: "shop.example.com" })).value.removed).toBe(true)

    expect((await call(server, "projects_list")).value.projects[0].name).toBe("web")
    expect((await call(server, "deploy", { project: "web", ref: "main" })).value).toMatchObject({ id: "dpl_2", state: "queued" })
    expect((await call(server, "deployments_list", { project: "web" })).value.deployments[0].id).toBe("dpl_1")
    const logs = await call(server, "deployment_logs", { project: "web", limit_bytes: 1000 })
    expect(logs.value).toMatchObject({ deployment: { state: "live" }, truncated: true })
    expect(logs.value.logs).toHaveLength(1000)
    expect(logs.value.logs.endsWith("built\n")).toBe(true)
    const unlinked = await call(server, "deployments_list")
    expect(unlinked.isError).toBe(true)
    expect(unlinked.text).toContain("not in a git repository")
    expect((await call(server, "deploy", { project: "web", ref: "main", sha: "a".repeat(40) }).catch((error: Error) => error)).toString()).toContain("give ref or sha")
  })

  test("a call cancelled while it looks something up changes nothing", async () => {
    const server = serverFor(cloud.url)
    cloud.delayMs = 200
    try {
      for (const [name, args] of [["expose", { sandbox: "brisk-otter", port: 3000 }], ["unexpose", { sandbox: "brisk-otter", label: "x" }], ["vms_ttl", { sandbox: "brisk-otter", ttl: "1s" }]] as const) {
        const before = cloud.requests.length
        const id = `cancel-${name}`
        const pending = server.line(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }))
        // cancelled while the lookup's answer is held back
        await waitFor(() => cloud.requests.length > before, 5_000, "the lookup")
        await server.line(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }))
        expect(await pending).toEqual([])
        expect(cloud.requests.slice(before).filter((line) => !line.startsWith("GET "))).toEqual([])
      }
    } finally {
      cloud.delayMs = 0
    }
  })

  test("storage and pages", async () => {
    const server = serverFor(cloud.url)
    cloud.buckets.set("assets", "eu")
    expect((await call(server, "storage_put", { bucket: "assets", key: "notes/a.txt", content: "hello" })).value).toMatchObject({ key: "notes/a.txt", size: 5 })
    await write(root, "upload/pic.png", "png")
    await call(server, "storage_put", { bucket: "assets", key: "pic.png", file: "upload/pic.png" })
    expect(cloud.objects.get("assets/pic.png")!.type).toBe("image/png")
    expect((await call(server, "storage_buckets")).value.buckets.map((b: { name: string }) => b.name)).toContain("assets")
    expect((await call(server, "storage_ls", { bucket: "assets", prefix: "notes/" })).value.objects.map((o: { key: string }) => o.key)).toEqual(["notes/a.txt"])
    expect((await call(server, "storage_get", { bucket: "assets", key: "notes/a.txt" })).value).toEqual({ key: "notes/a.txt", size: 5, content: "hello" })
    expect((await call(server, "storage_get", { bucket: "assets", key: "notes/a.txt", file: "saved/a.txt" })).value.size).toBe(5)
    expect(await readFile(join(root, "saved/a.txt"), "utf8")).toBe("hello")
    expect((await call(server, "storage_presign", { bucket: "assets", key: "pic.png", ttl_seconds: 60 })).value.url).toContain("X-Signature")
    expect((await call(server, "storage_rm", { bucket: "assets", key: "pic.png" })).value.deleted).toBe(true)
    // nothing but a bucket and an object key goes into the path
    const before = cloud.requests.length
    expect((await call(server, "storage_rm", { bucket: "../../pages/report#", key: "x" }).catch((error: Error) => error)).toString()).toContain("a bucket's name is")
    expect(await call(server, "storage_rm", { bucket: "assets", key: "../../../pages/report" })).toMatchObject({ isError: true })
    expect(cloud.requests.length).toBe(before)

    await write(root, "report/index.html", "<h1>done</h1>")
    const published = await call(server, "publish", { path: "report", name: "build-report" })
    expect(published.value.page).toMatchObject({ name: "build-report", url: "https://build-report.kyora.page", private: true })
    expect((await call(server, "pages_list")).value.pages.map((p: { name: string }) => p.name)).toContain("build-report")
    expect((await call(server, "pages_login_url", { name: "build-report" })).value).toEqual({ loginUrl: "https://build-report.kyora.page/_kyora/login#signed", expiresInSeconds: 60 })
    expect((await call(server, "pages_delete", { name: "build-report" })).value).toMatchObject({ removed: true, files: { deleted: 1 } })
    const missing = await call(server, "pages_delete", { name: "build-report" })
    expect(missing).toMatchObject({ isError: true })
    expect(missing.text).toContain("no such page")
  })

  test("session_status says when there is no session", async () => {
    const result = await call(serverFor(cloud.url), "session_status", { name: "nope" })
    expect(result.isError).toBe(true)
    expect(result.text).toContain("nope")
  })
})

describe("kyora mcp: the protocol", () => {
  const server = () => serverFor("http://127.0.0.1:9")

  test("initialize agrees on a version, then ping, tools/list and unknown methods", async () => {
    const init = await request(server(), "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "kyora" } })
    expect(((await request(server(), "initialize", { protocolVersion: "1999-01-01" })).result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSIONS[0]!)
    expect((await request(server(), "ping")).result).toEqual({})
    const listed = (await request(server(), "tools/list")).result as { tools: Array<{ name: string; inputSchema: unknown; annotations: unknown }> }
    expect(listed.tools.length).toBe(kyoraTools().length)
    expect((await request(server(), "nope/nothing")).error?.code).toBe(-32601)
  })

  test("bad JSON, bad requests, notifications and responses", async () => {
    expect(await server().line("{nope")).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }])
    expect(((await server().line("[]"))[0] as Frame).error?.code).toBe(-32600)
    expect(await server().line(JSON.stringify({ id: 1, method: "ping" }))).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "not JSON-RPC 2.0" } }])
    expect(((await server().line(JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "vms_list" } })))[0] as Frame).error?.code).toBe(-32600)
    expect(((await server().line(JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" })))[0] as Frame).error?.code).toBe(-32600)
    expect(await server().line(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toEqual([])
    expect(await server().line(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }))).toEqual([])
    expect(await server().line("   ")).toEqual([])
    const batch = await server().line(JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]))
    // a batch's answers go back as one array
    expect(batch).toEqual([[{ jsonrpc: "2.0", id: "a", result: {} }]])
  })

  test("arguments are checked against the tool's schema", async () => {
    const error = async (name: string, args: unknown) => (await request(server(), "tools/call", { name, arguments: args })).error
    expect(await error("nope", {})).toMatchObject({ code: -32602, message: "no tool nope" })
    expect(await error("vms_exec", { sandbox: "x" })).toMatchObject({ code: -32602, message: "vms_exec: command is required" })
    expect((await error("vms_exec", { sandbox: "x", command: "true", bogus: 1 }))?.message).toBe("vms_exec: bogus is not a known argument")
    expect((await error("vms_exec", { sandbox: "x", command: "true", timeout_seconds: 1.5 }))?.message).toBe("vms_exec: timeout_seconds must be a whole number")
    expect((await error("vms_create", { network: "lan" }))?.message).toBe("vms_create: network must be one of none, registries, open")
    expect((await error("vms_exec", { sandbox: "x", command: "true", env: { A: 1 } }))?.message).toBe("vms_exec: env.A must be a string")
    expect((await error("vms_pull", { sandbox: "x", paths: [] }))?.message).toBe("vms_pull: paths needs at least 1 item")
  })

  test("a call without a login says how to get one", async () => {
    const lonely = new McpServer({ tools: kyoraTools(), context: (signal) => toolContext(signal, platformEnv("http://127.0.0.1:9", { KYORA_TOKEN: undefined }), root), secrets: () => [] })
    const frame = await request(lonely, "tools/call", { name: "vms_list", arguments: {} })
    const result = frame.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("run `kyora login`")
  })

  test("a cancelled call stops and gets no answer; errors are redacted", async () => {
    let aborted = false
    const slow: Tool = {
      name: "slow",
      title: "slow",
      description: "waits for its signal, then fails",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {},
      handler: (_args, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
        aborted = true
        reject(new Error("stopped"))
      })),
    }
    const leaky: Tool = { ...slow, name: "leaky", handler: async () => { throw new Error(`refused ${TOKEN} and kysk_0123456789abcdef0123`) } }
    const fake = new McpServer({ tools: [slow, leaky], context: async (signal) => ({ signal }) as never, secrets: () => [TOKEN] })
    const pending = fake.line(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "slow", arguments: {} } }))
    await Bun.sleep(10)
    expect(await fake.line(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } }))).toEqual([])
    expect(await pending).toEqual([])
    expect(aborted).toBe(true)

    const leaked = (await fake.line(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "leaky" } })))[0] as Frame
    expect(leaked.result).toEqual({ content: [{ type: "text", text: "refused [redacted] and kysk_[redacted]" }], isError: true })

    // shutdown cancels what still runs, and waits for it to clean up
    aborted = false
    const running = fake.line(JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "slow" } }))
    await Bun.sleep(10)
    await fake.shutdown("going away", 5_000)
    expect(aborted).toBe(true)
    expect((((await running)[0] as Frame).result as { isError: boolean }).isError).toBe(true)
  })

  test("redact, validate and Tail", () => {
    expect(redact(`a ${TOKEN} b`, [TOKEN])).toBe("a [redacted] b")
    expect(redact("x kyora_abcdefghijklmnop kvms_abcdefghijklmnop y", [])).toBe("x kyora_[redacted] kvms_[redacted] y")
    expect(redact("kyora_vms is a word", [null, undefined, ""])).toBe("kyora_vms is a word")
    expect(validate({ type: "object", properties: { a: { type: "array", items: { type: "string" }, maxItems: 1 } } }, { a: ["x", "y"] })).toBe("a takes at most 1 items")
    expect(validate({ type: "object" }, [])).toBe("arguments must be an object")
    const tail = new Tail(4)
    for (const piece of ["ab", "cd", "ef", "gh", "ij"]) tail.push(piece)
    expect([tail.text(), tail.total, tail.truncated]).toEqual(["ghij", 10, true])
    const utf = new Tail(4)
    utf.push("xxé€")
    // a character cut at the start is dropped, not shown broken
    expect(utf.text()).toBe("€")
    // a token the cut would split is redacted whole first
    const split = new Tail(20)
    split.push(`${"a".repeat(100)}${TOKEN}`)
    split.push("b".repeat(10))
    expect(split.text()).toBe("[redacted]bbbbbbbbbb")
    for (let i = 0; i < 40; i++) split.push("c".repeat(30))
    split.push(TOKEN.slice(0, 20))
    split.push(`${TOKEN.slice(20)}d`)
    expect(split.text()).not.toContain(TOKEN.slice(-12))
  })
})

describe("kyora mcp: the process", () => {
  test("stdout carries only JSON-RPC frames, and no token reaches stdout or stderr", async () => {
    cloud.me = { login: "ada", kind: "user", token: { name: TOKEN, scopes: ["vms"], expiresAt: null } }
    const proc = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", KYORA, "mcp"],
      cwd: root,
      env: Object.fromEntries(Object.entries(platformEnv(cloud.url)).filter(([, value]) => value !== undefined)) as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const send = (message: unknown) => proc.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`)
    let stdout = ""
    const reading = (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) stdout += new TextDecoder().decode(chunk)
    })()
    const stderr = new Response(proc.stderr).text()
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } })
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vms_list", arguments: {} } })
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pages_delete", arguments: { name: "missing-page" } } })
    send("this is not json")
    await waitFor(() => stdout.split("\n").filter(Boolean).length >= 6, 20_000, "six frames")
    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    await reading
    const errors = await stderr
    const frames = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Frame)
    for (const frame of frames) expect(frame.jsonrpc).toBe("2.0")
    expect(stdout.endsWith("\n")).toBe(true)
    expect(frames.map((frame) => frame.id).sort()).toEqual([1, 2, 3, 4, 5, null].sort())
    const whoami = frames.find((frame) => frame.id === 3)!.result as { content: Array<{ text: string }> }
    expect(JSON.parse(whoami.content[0]!.text)).toMatchObject({ login: "ada", token: { name: "[redacted]" } })
    expect(stdout).not.toContain(TOKEN)
    expect(errors).not.toContain(TOKEN)
    expect(errors).toContain("MCP server on stdio")
  }, 30_000)

  test("after guardStdout, console output and process.stdout.write go to stderr, redacted", async () => {
    const script = `import { guardStdout, redact } from ${JSON.stringify(join(import.meta.dir, "mcp.ts"))}
const { send, flush } = guardStdout((text) => redact(text, []))
console.log("noise")
console.info("info")
process.stdout.write("more noise\\n")
console.error("leak kyora_abcdefghijklmnopqrstuvwxyz")
process.stderr.write("note kvms_abcd")
process.stderr.write("efghijklmnopqrstuvwxyz\\n")
console.table([{ token: "kysk_abcdefghijklmnopqrstuvwxyz" }])
console.count("calls")
console.assert(false, "kys_abcdefghijklmnopqrstuvwxyz")
console.write("raw kyora_abcdefghijklmnopqrstuvwxyz\\n")
process.stderr.write("x".repeat(70000) + "kyora_")
process.stderr.write("abcdefghijklmnopqrstuvwxyz and more")
process.stderr.write(" of that line\\nnext line\\n")
process.stderr.write("last")
await send('{"jsonrpc":"2.0","id":1,"result":{}}\\n')
flush()`
    const file = join(root, "guard.ts")
    await Bun.write(file, script)
    const proc = Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", file], stdout: "pipe", stderr: "pipe" })
    expect(proc.stdout.toString()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    const stderr = proc.stderr.toString()
    expect(stderr.startsWith("noise\ninfo\nmore noise\nleak kyora_[redacted]\nnote kvms_[redacted]\n")).toBe(true)
    expect(stderr).toContain("kysk_[redacted]")
    expect(stderr).toContain("calls: 1")
    expect(stderr).toContain("kys_[redacted]")
    expect(stderr).toContain("raw kyora_[redacted]")
    expect(stderr).toContain("(a line over 64 KB was left out)")
    expect(stderr).not.toContain("xxxxxxxxxx")
    expect(stderr).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(stderr).not.toContain("of that line")
    expect(stderr).toContain("next line\n")
    expect(stderr.endsWith("last")).toBe(true)
    expect(stderr).not.toMatch(/(kyora|kvms|kysk|kys)_abcdefghijkl/)
  })
})
