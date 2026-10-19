import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { KEY, MINTED, startFakePlatform, startFakeVmd, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, makeRepo, platformEnv, rssOf, spawnCli, tempDir, transcripts, waitFor, write } from "./testing/fixtures"

// real processes over real HTTP, and a login that polls once a second
setDefaultTimeout(30_000)

/** older bun buffers streamed fetch bodies; memory bounds only hold from 1.4.2 */
const MODERN_BUN = Bun.semver.satisfies(Bun.version, ">=1.4.2")
const KiB = 1024
const MiB = 1024 * KiB

let root: string
let cloud: FakeVmd

beforeEach(async () => {
  root = await tempDir("cloud")
  cloud = await startFakePlatform()
})

afterEach(async () => {
  await cloud.stop()
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  // no output, success or failure, may carry a key or a token, not even a freshly minted one
  expect(transcripts.length).toBeGreaterThan(0)
  for (const text of transcripts) for (const secret of [KEY, TOKEN, ...MINTED]) expect(text).not.toContain(secret)
})

const env = (extra: Record<string, string | undefined> = {}) => platformEnv(cloud.url, extra)
const sha = (bytes: Uint8Array | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const shaOf = async (path: string) => sha(await Bun.file(path).arrayBuffer())

/** outside git, with one incompressible file, so zstd cannot shrink it below a few parts */
async function bigDir(size: number): Promise<{ dir: string; data: Buffer }> {
  const dir = join(root, "big")
  const data = randomBytes(size)
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, "blob.bin"), data)
  await write(dir, "small.txt", "hello\n")
  return { dir, data }
}

describe("lifetime compatibility", () => {
  test("new CLI leaves the default to old Workers, and reports old Workers refusing none", async () => {
    cloud.options.defaultTtlSeconds = 3600
    expect((await cli(["create"], { cwd: root, env: env() })).code).toBe(0)
    expect(cloud.created[0]).not.toHaveProperty("ttlSeconds")
    const vm = [...cloud.sandboxes.values()][0]!
    expect((Date.parse(vm.expiresAt!) - Date.parse(vm.createdAt)) / 1000).toBeCloseTo(3600, 0)
    cloud.options.createFailure = { status: 400, error: "invalid_request", message: "ttlSeconds must be between 60 and 28800" }
    const result = await cli(["create", "--ttl", "none"], { cwd: root, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("ttlSeconds must be between")
    expect(cloud.created).toHaveLength(2)
    expect(cloud.created[1]).toMatchObject({ ttlSeconds: 0 })
  })
})

describe("pushing to kyora cloud", () => {
  test("goes up in parts, never as one big PUT, and the sandbox gets the exact bytes", async () => {
    cloud.options.partSize = 256 * KiB
    const { dir, data } = await bigDir(1280 * KiB)
    const result = await cli(["run", "--dir", dir, "--keep", "--json", "--", "true"], { cwd: root, env: env() })

    expect(result.code).toBe(0)
    const [id] = [...cloud.sandboxes.keys()]
    expect(await shaOf(join(cloud.work(id!), "blob.bin"))).toBe(sha(data))
    expect(await Bun.file(join(cloud.work(id!), "small.txt")).text()).toBe("hello\n")

    const [upload] = cloud.multipart
    expect(upload).toMatchObject({ id, dest: "/work", contentType: "application/zstd", status: "complete" })
    expect(upload!.parts.length).toBeGreaterThan(3)
    expect(upload!.parts.slice(0, -1).every((size) => size === 256 * KiB)).toBe(true)
    expect(cloud.uploads).toEqual([])
    expect(cloud.requests.filter((request) => request.startsWith("PUT") && request.endsWith("/files"))).toEqual([])

    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(events.find((event) => event.type === "upload")).toMatchObject({ parts: upload!.parts.length, bytes: upload!.parts.reduce((a, b) => a + b, 0) })
    // large enough to say how it is going, on stderr
    expect(result.stderr).toMatch(/uploading: \S+ \S+ sent, \S+ \S+\/s/)
    expect(result.stderr).toMatch(new RegExp(`uploaded \\S+ \\S+ in ${upload!.parts.length} parts, \\S+ \\S+/s; unpacking in the sandbox`))
  })

  test("a part the edge fumbles is sent again from the same bytes", async () => {
    cloud.options.partSize = 256 * KiB
    cloud.options.part = (n, attempt) => {
      if (n !== 2 || attempt > 2) return null
      if (attempt === 1) return new Response("<html><title>502 Bad Gateway | cloudflare</title></html>", { status: 502, headers: { "content-type": "text/html" } })
      return Response.json({ error: "internal", message: "internal error" }, { status: 500 })
    }
    const { dir, data } = await bigDir(1024 * KiB)
    const result = await cli(["run", "--dir", dir, "--keep", "--", "true"], { cwd: root, env: env() })

    expect(result.code).toBe(0)
    expect(cloud.partPuts.filter((put) => put.n === 2).map((put) => put.attempt)).toEqual([1, 2, 3])
    expect(new Set(cloud.partPuts.filter((put) => put.n === 2).map((put) => put.bytes)).size).toBe(1)
    expect(cloud.multipart[0]!.status).toBe("complete")
    expect(await shaOf(join(cloud.work([...cloud.sandboxes.keys()][0]!), "blob.bin"))).toBe(sha(data))
  })

  test("a part refused for good aborts the upload, runs nothing and destroys the sandbox", async () => {
    cloud.options.partSize = 256 * KiB
    cloud.options.part = (n) => (n === 2 ? Response.json({ error: "storage_rejected", message: "part 2: R2 said no" }, { status: 400 }) : null)
    const { dir } = await bigDir(1024 * KiB)
    const result = await cli(["run", "--dir", dir, "--", "true"], { cwd: root, env: env() })

    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/upload part 2 to sb_\w+: part 2: R2 said no/)
    const [upload] = cloud.multipart
    expect(upload!.status).toBe("aborted")
    expect(cloud.requests).toContain(`DELETE /v1/sandboxes/${upload!.id}/uploads/${upload!.uploadId}`)
    expect(cloud.partPuts.filter((put) => put.n === 2)).toHaveLength(1)
    expect(cloud.execs).toHaveLength(0)
    expect(cloud.destroyed).toEqual([upload!.id])
  })

  test("Ctrl-C mid-upload aborts it and destroys the sandbox", async () => {
    let release = () => {}
    const held = new Promise<null>((resolve) => (release = () => resolve(null)))
    cloud.options.part = () => held
    const repo = await makeRepo(root)
    const running = spawnCli(["run", "--", "true"], { cwd: repo, env: env() })
    await waitFor(() => cloud.partPuts.length > 0, 15_000, "the first part")
    running.proc.kill("SIGINT")
    const result = await running.done
    release()

    expect(result.code).toBe(130)
    expect(cloud.multipart[0]!.status).toBe("aborted")
    expect(cloud.execs).toHaveLength(0)
    expect(cloud.destroyed).toHaveLength(1)
  })

  test("a large push holds the parts in flight in memory, not the upload", async () => {
    const partSize = 8 * MiB
    cloud.options.partSize = partSize
    const { dir, data } = await bigDir(320 * MiB)
    const running = spawnCli(["push", await createdId(), dir, "--json"], { cwd: root, env: env() })
    let peak = 0
    const sampler = setInterval(() => (peak = Math.max(peak, rssOf(running.proc.pid))), 25)
    const result = await running.done
    clearInterval(sampler)

    expect(result.code).toBe(0)
    const pushed = JSON.parse(result.stdout)
    // past 256 MiB it goes up as two shards: the big file alone, and everything else
    expect(pushed.shards).toBe(2)
    expect(cloud.multipart.map((upload) => upload.status)).toEqual(["complete", "complete"])
    const sizes = cloud.multipart.map((upload) => upload.parts.reduce((a, b) => a + b, 0))
    expect(pushed.parts).toBe(sizes.reduce((total, size) => total + Math.max(1, Math.ceil(size / partSize)), 0))
    expect(pushed.parts).toBeGreaterThanOrEqual(40)
    expect(pushed.sent).toBe(sizes.reduce((a, b) => a + b, 0))
    expect(cloud.maxPartsInFlight).toBeLessThanOrEqual(8)
    expect(await shaOf(join(cloud.work([...cloud.sandboxes.keys()][0]!), "blob.bin"))).toBe(sha(data))
    // Holding the upload would be past 320 MiB on the data alone. At most eight 8 MiB parts
    // in flight (each held once: a part goes out as a stream over its buffer, which fetch
    // does not copy) and the garbage of packing hundreds of MB a second locally stay a
    // plateau that does not grow with the upload (seen: 170-180 MiB).
    if (MODERN_BUN) expect(peak).toBeLessThan(256 * MiB)
    console.log(`peak RSS pushing 320 MiB in 8 MiB parts, ${cloud.maxPartsInFlight} in flight: ${Math.round(peak / MiB)} MiB (bun ${Bun.version})`)
  }, 120_000)
})

async function createdId(): Promise<string> {
  const created = await cli(["create"], { cwd: root, env: env() })
  expect(created.code).toBe(0)
  return created.stdout.trim()
}

describe("the rest of kyora cloud", () => {
  test("session verbs work the same, a small push is one part, and the machine is named", async () => {
    const created = await cli(["create", "--network", "registries"], { cwd: root, env: env() })
    const id = created.stdout.trim()
    expect(created.stderr).toContain("network registries")
    expect(created.stderr).toContain("on box-1")
    expect((await cli(["ls"], { cwd: root, env: env() })).stdout).toMatch(/NAME\s+ID\s+IMAGE\s+SIZE/)
    expect(JSON.parse((await cli(["ls", "--json"], { cwd: root, env: env() })).stdout).sandboxes[0]).toMatchObject({ id, node: "box-1" })

    const dir = join(root, "src")
    await write(dir, "input.txt", "hello from push\n")
    const pushed = await cli(["push", id, dir, "--dest", "/work/in", "--json"], { cwd: root, env: env() })
    expect(pushed.code).toBe(0)
    expect(JSON.parse(pushed.stdout)).toMatchObject({ parts: 1 })
    expect(pushed.stderr).not.toContain("uploading")

    const ran = await cli(["exec", id, "--cwd", "in", "--", "sh", "-c", "cat input.txt; mkdir -p ../out && cp input.txt ../out/copy.txt"], { cwd: root, env: env() })
    expect(ran.stdout).toBe("hello from push\n")
    const to = join(root, "pulled")
    expect((await cli(["pull", id, "out/copy.txt", "--to", to], { cwd: root, env: env() })).code).toBe(0)
    expect(await Bun.file(join(to, "out/copy.txt")).text()).toBe("hello from push\n")
    expect((await cli(["rm", id], { cwd: root, env: env() })).stdout).toBe(`removed ${id}\n`)
  })

  test("run --out downloads through it", async () => {
    const repo = await makeRepo(root)
    const result = await cli(["run", "--out", "target/release/app", "--", "sh", "-c", "mkdir -p target/release && printf binary > target/release/app"], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(await Bun.file(join(repo, "target/release/app")).text()).toBe("binary")
    expect(cloud.requests.filter((request) => request.startsWith("GET /v1/sandboxes/") && request.endsWith("/files"))).toHaveLength(1)
  })

  test("health, whoami and nodes", async () => {
    const health = await cli(["health"], { cwd: root, env: env() })
    expect(health.code).toBe(0)
    expect(health.stdout).toContain(`ok · ${cloud.url} · kyora cloud`)
    expect(health.stdout).toContain("token: accepted (from $KYORA_TOKEN) as octo, 0 sandboxes running")
    const healthJson = JSON.parse((await cli(["health", "--json"], { cwd: root, env: env() })).stdout)
    expect(healthJson).toMatchObject({ ok: true, version: "kyora-cloud", url: cloud.url, key: { source: "$KYORA_TOKEN", accepted: true, login: "octo" } })

    const rejected = await cli(["health"], { cwd: root, env: env({ KYORA_TOKEN: "kyora_revoked" }) })
    expect(rejected.code).toBe(125)
    expect(rejected.stdout).toContain("token: rejected (from $KYORA_TOKEN): whoami: missing, invalid or expired token; run kyora-vms login")

    const who = await cli(["whoami"], { cwd: root, env: env() })
    expect(who.code).toBe(0)
    expect(who.stdout).toMatch(new RegExp(`^octo \\(member\\) at ${cloud.url}\ntoken: "ci", from \\$KYORA_TOKEN, expires \\d{4}-\\d\\d-\\d\\d\n$`))

    const nodes = await cli(["nodes"], { cwd: root, env: env() })
    expect(nodes.code).toBe(0)
    expect(nodes.stdout.split("\n").map((line) => line.split(/\s{2,}/))).toEqual([
      ["NAME", "STATUS", "VCPU FREE", "MEM FREE", "DISK FREE"],
      ["box-1", "connected", "12", "40G", "-"],
      ["box-2", "offline", "16", "48G", "-"],
      ["1 of 2 taking sandboxes · 12 vCPU, 40G RAM free"],
      [""],
    ])

    // an admin sees sizes, load and versions too
    const now = new Date().toISOString()
    // as kyora cloud sends them: connected means "takes sandboxes", so a draining machine is never connected
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()
    const size = { capacity: { vcpus: 16, memoryMb: 49152, diskGb: 200 }, free: { vcpus: 12, memoryMb: 40960, diskGb: 150 }, running: 2 }
    cloud.options.nodes = [
      { name: "box-1", connected: false, draining: true, version: "0.2.0", ...size, lastSeenAt: now },
      { name: "box-2", connected: false, draining: true, version: "0.2.0", ...size, lastSeenAt: stale },
    ]
    const admin = await cli(["nodes"], { cwd: root, env: env() })
    expect(admin.stdout).toMatch(/NAME\s+STATUS\s+VCPU FREE\s+MEM FREE\s+DISK FREE\s+SANDBOXES\s+VERSION\s+SEEN\nbox-1\s+draining\s+12\/16\s+40G\/48G\s+150G\/200G\s+2\s+0.2.0\s+0m ago\nbox-2\s+offline\s/)
    expect(admin.stdout).toContain("0 of 2 taking sandboxes")
  })

  test("kyora cloud's own verbs explain themselves against a kyora-vmd", async () => {
    const vmd = await startFakeVmd()
    try {
      const nodes = await cli(["nodes"], { cwd: root, env: baseEnv(vmd.url) })
      expect(nodes.code).toBe(125)
      expect(nodes.stderr).toContain(`${vmd.url} does not support nodes. Run \`kyora-vms health\` to check capacity`)
      const who = await cli(["whoami"], { cwd: root, env: baseEnv(vmd.url) })
      expect(who.stderr).toContain("requires an API key. Run `kyora-vms health` to check the key")
      const login = await cli(["login"], { cwd: root, env: baseEnv(vmd.url) })
      expect(login.code).toBe(125)
      expect(login.stderr).toContain(`${vmd.url} requires an API key (KYORA_VMS_KEY). To sign in to kyora cloud: kyora-vms login --url https://cloud.kyora.sh`)
      // the key says kyora-vmd, so only login (which sends no key) asked the server what it is
      expect(vmd.requests).toEqual(["GET /v1/health"])
    } finally {
      await vmd.stop()
    }
  })

  test("with no token it says to log in", async () => {
    const result = await cli(["ls"], { cwd: root, env: env({ KYORA_TOKEN: undefined }) })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain(`list sandboxes: not logged in to ${cloud.url}; run \`kyora-vms login\`, or set KYORA_TOKEN`)
  })
})

describe("waiting in line for room on kyora cloud", () => {
  test("run waits by default, says its place on stderr, and runs once it has a sandbox", async () => {
    cloud.options.queueAhead = 2
    const repo = await makeRepo(root)
    const result = await cli(["run", "--json", "--", "true"], { cwd: repo, env: env() })

    expect(result.code).toBe(0)
    expect(cloud.created[0]).toMatchObject({ wait: 900 })
    const [ticket] = [...cloud.tickets.keys()]
    expect(cloud.requests.filter((request) => request === `GET /v1/queue/${ticket}`)).toHaveLength(3)
    expect(result.stderr).toContain("no machine has room right now; queued: 2 ahead… (waiting up to 15m00s; --no-wait fails at once instead)")
    expect(result.stderr).toContain("[kyora-vms] queued: 1 ahead…")
    expect(result.stderr).toContain("[kyora-vms] queued: next in line…")
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(events.filter((event) => event.type === "queued").map((event) => event.ahead)).toEqual([2, 1, 0])
    expect(events.find((event) => event.type === "summary").timings.queuedMs).toBeGreaterThanOrEqual(0)
    expect(cloud.destroyed).toHaveLength(1)
  })

  test("a create that waited in line runs a command that reattaches after breaks, output whole", async () => {
    cloud.options.queueAhead = 2
    cloud.options.cutAfter = [30, 90]
    cloud.options.cutMode = "reset"
    const repo = await makeRepo(root)
    const script = "for i in $(seq 1 40); do echo line $i; sleep 0.01; done; exit 5"
    const result = await cli(["run", "--", "sh", "-c", script], { cwd: repo, env: env({ KYORA_VMS_REATTACH_BASE_MS: "40" }) })

    expect(result.code).toBe(5)
    expect(result.stdout).toBe(Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(""))
    expect(result.stderr).toContain("[kyora-vms] queued: next in line…")
    expect(result.stderr.split("\n").filter((line) => line === "[kyora-vms] reconnecting…")).toHaveLength(2)
    expect(cloud.cuts).toBe(2)
    expect(cloud.destroyed).toHaveLength(1)
  })

  test("--wait says how long, --no-wait fails at once as before, and not both", async () => {
    cloud.options.queueAhead = 0
    const waited = await cli(["create", "--wait", "90s", "--json"], { cwd: root, env: env() })
    expect(waited.code).toBe(0)
    expect(cloud.created[0]).toMatchObject({ wait: 90 })
    expect(JSON.parse(waited.stdout).id).toMatch(/^sb_/)
    expect(waited.stderr).toContain("queued: next in line… (waiting up to 1m30s")

    cloud.options.createFailure = { status: 503, error: "no_capacity", message: "no connected machine has room for 4 vCPU / 8192 MB / 30 GB right now" }
    const refused = await cli(["create", "--no-wait"], { cwd: root, env: env() })
    expect(refused.code).toBe(125)
    expect(cloud.created[1]!.wait).toBeUndefined()
    expect(refused.stderr).toContain("no connected machine has room")

    const both = await cli(["create", "--wait", "1m", "--no-wait"], { cwd: root, env: env() })
    expect(both.code).toBe(125)
    expect(both.stderr).toContain("--wait and --no-wait don't go together")
    expect(cloud.created).toHaveLength(2)
  })

  test("a wait that runs out fails the run with 125 and the server's reason; a poll the edge fumbles is asked again", async () => {
    cloud.options.queueAhead = 1
    cloud.options.queuePoll = (attempt) => (attempt === 1 ? new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) : null)
    cloud.options.queueFailure = { status: 503, error: "no_capacity", message: "no connected machine has room for 4 vCPU / 8192 MB / 30 GB right now (waited 15 min in the queue); try a smaller sandbox or later" }
    const repo = await makeRepo(root)
    const result = await cli(["run", "--", "true"], { cwd: repo, env: env() })

    expect(result.code).toBe(125)
    expect(result.stderr).toContain("waited 15 min in the queue")
    expect([...cloud.tickets.values()][0]).toMatchObject({ status: "failed", polls: 3 })
    expect(cloud.execs).toHaveLength(0)
  })

  test("Ctrl-C while in line takes the create out of line; nothing runs and nothing is left", async () => {
    cloud.options.queueAhead = 1_000
    cloud.options.queuePollMs = 200
    const repo = await makeRepo(root)
    const running = spawnCli(["run", "--", "true"], { cwd: repo, env: env() })
    await waitFor(() => cloud.requests.some((request) => request.startsWith("GET /v1/queue/")), 15_000, "the first poll")
    running.proc.kill("SIGINT")
    const result = await running.done

    expect(result.code).toBe(130)
    const [ticket] = [...cloud.tickets.keys()]
    expect(cloud.requests).toContain(`DELETE /v1/queue/${ticket}`)
    expect(cloud.tickets.get(ticket!)!.status).toBe("cancelled")
    expect(cloud.sandboxes.size).toBe(0)
    expect(cloud.execs).toHaveLength(0)
  })

  test("the same for create", async () => {
    cloud.options.queueAhead = 1_000
    cloud.options.queuePollMs = 200
    const running = spawnCli(["create"], { cwd: root, env: env() })
    await waitFor(() => cloud.requests.some((request) => request.startsWith("GET /v1/queue/")), 15_000, "the first poll")
    running.proc.kill("SIGINT")
    const result = await running.done

    expect(result.code).toBe(130)
    expect(result.stdout).toBe("")
    expect([...cloud.tickets.values()][0]!.status).toBe("cancelled")
  })

  test("a line that never answers is left once --wait and the grace are over: 125, out of line, nothing left", async () => {
    // the server would end the wait at --wait itself; this one keeps saying "queued" for ever
    cloud.options.queueAhead = 1_000_000
    cloud.options.queuePollMs = 100
    const repo = await makeRepo(root)
    const started = Date.now()
    const running = spawnCli(["run", "--wait", "1s", "--", "true"], { cwd: repo, env: env({ KYORA_VMS_TIMEOUT_GRACE_MS: "500" }) })
    const stuck = setTimeout(() => running.proc.kill("SIGKILL"), 20_000)
    const result = await running.done
    clearTimeout(stuck)

    expect(result.code).toBe(125)
    expect(result.stderr).toContain("create sandbox: still in line for room well past --wait (1.0s), with no answer from kyora cloud; kyora-vms took the create out of line")
    expect(Date.now() - started).toBeLessThan(10_000)
    const [ticket] = [...cloud.tickets.keys()]
    expect(cloud.requests).toContain(`DELETE /v1/queue/${ticket}`)
    expect(cloud.tickets.get(ticket!)!.status).toBe("cancelled")
    expect(cloud.sandboxes.size).toBe(0)
    expect(cloud.execs).toHaveLength(0)
  })
})

describe("kyora-vms login", () => {
  /** a BROWSER that notes the URL it was asked to open */
  async function browser(): Promise<{ command: string; opened: () => string | null }> {
    const file = join(root, "opened.txt")
    await write(root, "browser.sh", `#!/bin/sh\nprintf '%s' "$1" > '${file}'\n`, 0o755)
    return { command: join(root, "browser.sh"), opened: () => (existsSync(file) ? readFileSync(file, "utf8") : null) }
  }

  const loginEnv = (config: string, extra: Record<string, string | undefined> = {}) => env({ KYORA_TOKEN: undefined, XDG_CONFIG_HOME: config, ...extra })

  test("approved in the browser: the token lands in credentials.json (0600), and commands use it until logout", async () => {
    const config = join(root, "config")
    const open = await browser()
    const running = spawnCli(["login"], { cwd: root, env: loginEnv(config, { BROWSER: open.command }) })
    const device = await waitFor(() => cloud.devices[0], 10_000, "the login to start")
    expect(device).toMatchObject({ client: "kyora-vms", status: "pending" })
    expect(await waitFor(open.opened, 10_000, "the browser")).toBe(`${cloud.url}/device?code=${device.userCode}`)
    await waitFor(() => running.stderr().includes("waiting for you to approve"), 10_000, "the prompt")
    cloud.decide(device.userCode, "approved")
    const result = await running.done

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`logged in to ${cloud.url} as octo\n`)
    expect(result.stderr).toContain(`to sign in, open ${cloud.url}/device?code=${device.userCode}`)
    expect(result.stderr).toContain(`shows the code ${device.userCode}`)
    expect(result.stderr).toContain("opened it in your browser")
    expect(device.polls).toBeGreaterThanOrEqual(1)

    const file = join(config, "kyora", "credentials.json")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(config, "kyora"))).mode & 0o777).toBe(0o700)
    const origin = new URL(cloud.url).origin
    const saved = JSON.parse(await Bun.file(file).text())
    expect(Object.keys(saved)).toEqual([origin])
    expect(saved[origin]).toMatchObject({ login: "octo", url: cloud.url })
    expect(MINTED).toContain(saved[origin].token)

    const who = await cli(["whoami"], { cwd: root, env: loginEnv(config) })
    expect(who.stdout).toContain(`token: "kyora-vms on test", from ${file}`)
    expect((await cli(["ls"], { cwd: root, env: loginEnv(config) })).stdout).toBe("no sandboxes running\n")

    const out = await cli(["logout"], { cwd: root, env: loginEnv(config) })
    expect(out.stdout).toBe(`logged out of ${cloud.url}\n`)
    expect(out.stderr).toContain(`revoke it at ${origin}/dashboard/vms/tokens`)
    expect(await Bun.file(file).exists()).toBe(false)
    const after = await cli(["ls"], { cwd: root, env: loginEnv(config) })
    expect(after.code).toBe(125)
    expect(after.stderr).toContain(`not logged in to ${cloud.url}`)
  })

  test("denied in the browser: nothing is stored", async () => {
    const config = join(root, "config")
    const running = spawnCli(["login", "--json"], { cwd: root, env: loginEnv(config) })
    const device = await waitFor(() => cloud.devices[0], 10_000, "the login to start")
    cloud.decide(device.userCode, "denied")
    const result = await running.done
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("login denied: the login was denied in the browser")
    expect(result.stdout).toBe("")
    expect(await Bun.file(join(config, "kyora", "credentials.json")).exists()).toBe(false)
  })

  test("a code nobody approves runs out", async () => {
    cloud.options.deviceExpiresIn = 1
    const config = join(root, "config")
    const result = await cli(["login"], { cwd: root, env: loginEnv(config) })
    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/login failed: this login expired|ran out before it was approved/)
    expect(await Bun.file(join(config, "kyora", "credentials.json")).exists()).toBe(false)
  })
})

describe("the kyora-vmd setup stays as it was", () => {
  test("a run sends exactly the requests it always did, with the key and without asking what the server is", async () => {
    const vmd = await startFakeVmd()
    try {
      const repo = await makeRepo(root)
      const result = await cli(["run", "--out", "src", "--", "true"], { cwd: repo, env: baseEnv(vmd.url) })
      expect(result.code).toBe(0)
      const id = vmd.destroyed[0]!
      expect(vmd.requests).toEqual([
        "POST /v1/sandboxes",
        `PUT /v1/sandboxes/${id}/files`,
        `POST /v1/sandboxes/${id}/exec`,
        `GET /v1/sandboxes/${id}/files`,
        `DELETE /v1/sandboxes/${id}`,
      ])
      expect(vmd.multipart).toEqual([])
      expect(vmd.unauthorized).toBe(0)
      // a kyora-vmd has no line to wait in: the create carries no wait
      expect(vmd.created[0]!.wait).toBeUndefined()
    } finally {
      await vmd.stop()
    }
  })

  test("the env file keeps winning after a login to kyora cloud, and login says where commands still go", async () => {
    const vmd = await startFakeVmd()
    try {
      const home = join(root, "home")
      await write(home, ".config/kyora-vms/env", `KYORA_VMS_URL=${vmd.url}\nKYORA_VMS_KEY=${KEY}\n`)
      const owner = { ...baseEnv(vmd.url, { HOME: home }), KYORA_VMS_URL: undefined, KYORA_VMS_KEY: undefined }

      const running = spawnCli(["login", "--url", cloud.url], { cwd: root, env: owner })
      const device = await waitFor(() => cloud.devices[0], 10_000, "the login to start")
      cloud.decide(device.userCode, "approved")
      const login = await running.done
      expect(login.code).toBe(0)
      expect(login.stderr).toContain(`commands go to ${vmd.url} (KYORA_VMS_URL from ${join(home, ".config/kyora-vms/env")}), not here; set KYORA_VMS_URL=${cloud.url} to use this login`)
      expect(await Bun.file(join(home, ".config/kyora-vms/env")).text()).toBe(`KYORA_VMS_URL=${vmd.url}\nKYORA_VMS_KEY=${KEY}\n`)

      const listed = await cli(["ls"], { cwd: root, env: owner })
      expect(listed.stdout).toBe("no sandboxes running\n")
      const health = await cli(["health"], { cwd: root, env: owner })
      expect(health.stdout).toContain(`key: accepted (from ${join(home, ".config/kyora-vms/env")})`)
      expect(vmd.unauthorized).toBe(0)
      expect(cloud.requests.filter((request) => !request.startsWith("POST /v1/auth/"))).toEqual(["GET /v1/health"])
    } finally {
      await vmd.stop()
    }
  })
})

describe("fleet image commands", () => {
  test("image_unavailable is exit 123 for run and create, with image and available regions", async () => {
    cloud.options.createFailure = { status: 409, error: "image_unavailable", message: 'image "office" is unavailable in us; regions with this image: eu' }
    for (const args of [["create", "--image", "office"], ["run", "--image", "office", "--dir", root, "--", "true"]]) {
      const result = await cli(args, { cwd: root, env: env() })
      expect(result.code).toBe(123)
      expect(result.stderr).toContain('image "office"')
      expect(result.stderr).toContain("regions with this image: eu")
    }
    expect(cloud.execs).toHaveLength(0)
  })

  test("images lists human and JSON availability; admin build chooses one or all machines", async () => {
    cloud.options.images = [{ name: "office", regions: [{ region: "eu", available: true, building: false, unknown: false, machines: [{ machine: "box-1", present: true, version: "v1", hash: "abc", builtAt: "2026-10-04T00:00:00Z", building: false }] }] }]
    const listed = await cli(["images"], { cwd: root, env: env() })
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("office  eu  available")
    expect(listed.stdout).toContain("box-1  present  v1  abc")
    const json = await cli(["images", "--json"], { cwd: root, env: env() })
    expect(JSON.parse(json.stdout)).toEqual({ images: cloud.options.images, account: [] })
    for (const target of [["--node", "box-1"], ["--all"]]) {
      const build = await cli(["images", "build", "office", ...target, "--json"], { cwd: root, env: env() })
      expect(build.code).toBe(0)
      expect(JSON.parse(build.stdout)).toMatchObject({ builds: [{ machine: "box-1", accepted: true }] })
    }
    const invalid = await cli(["images", "build", "office"], { cwd: root, env: env() })
    expect(invalid.code).toBe(125)
  })
})

test("create and run omit implicit TTL under a finite operator cap", async () => {
  cloud.options.maxTtlSeconds = 1800
  expect((await cli(["create"], { cwd: root, env: env() })).code).toBe(0)
  const vm = [...cloud.sandboxes.values()][0]!
  expect((Date.parse(vm.expiresAt!) - Date.parse(vm.createdAt)) / 1000).toBeCloseTo(1800, 0)
  const repo = await makeRepo(root)
  expect((await cli(["run", "--", "true"], { cwd: repo, env: env() })).code).toBe(0)
  expect(cloud.created).toHaveLength(2)
  for (const spec of cloud.created) expect(spec).not.toHaveProperty("ttlSeconds")
  expect((await cli(["create", "--ttl", "1h"], { cwd: root, env: env() })).code).toBe(125)
})
