import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { startFakePlatform, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, platformEnv } from "./testing/fixtures"

// real processes over real HTTP
setDefaultTimeout(30_000)

/**
 * kyora cloud's regions from the CLI: --region (and KYORA_VMS_REGION) on
 * run and create, strict by naming one, `global` for the nearest; `kyora vms regions` to see them and
 * pick a default; a note when a global create ran in another region than the nearest. --strict is a
 * deprecated no-op.
 */

let fake: FakeVmd | null = null
let server: ReturnType<typeof Bun.serve> | null = null

afterEach(async () => {
  await fake?.stop()
  server?.stop(true)
  fake = null
  server = null
})

/** kyora cloud as far as regions go: what it was asked, and the answers a test sets */
function regionsCloud(sandbox: Record<string, unknown> = {}) {
  const seen: Array<{ method: string; path: string; body: unknown }> = []
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
      seen.push({ method: request.method, path: url.pathname, body })
      if (url.pathname === "/v1/health") return Response.json({ ok: true, version: "kyora-cloud" })
      if (url.pathname === "/v1/regions") {
        return Response.json({
          regions: [
            { id: "eu", label: "Europe", default: true, jurisdiction: null, fallback: ["us"], machines: 1, connected: 1, free: { vcpus: 12, memoryMb: 40960 } },
            { id: "us", label: "United States", default: false, jurisdiction: null, fallback: ["eu"], machines: 2, connected: 1, free: { vcpus: 8, memoryMb: 16384 } },
            { id: "apac", label: "Asia-Pacific", default: false, jurisdiction: null, fallback: ["us", "eu"], machines: 0, connected: 0, free: { vcpus: 0, memoryMb: 0 } },
          ],
          you: { region: "us", by: "continent", strict: false, overflow: ["eu"], location: { continent: "NA", country: "US", colo: "IAD" } },
          default: null,
        })
      }
      if (url.pathname === "/v1/me/region") return Response.json({ region: (body as { region: string | null }).region })
      if (url.pathname === "/v1/sandboxes" && request.method === "POST") {
        return Response.json(
          { id: "sb_k1abcd_AAAAAAAAAAAAAAAA", status: "running", network: "none", vcpus: 2, memoryMb: 2048, diskGb: 10, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), node: "box-1", ...sandbox },
          { status: 201 },
        )
      }
      return Response.json({ error: "not_found", message: "no such route" }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

describe("--region", () => {
  test("goes into the create, with KYORA_VMS_REGION as the default and --region over it; global too", async () => {
    fake = await startFakePlatform()
    expect((await cli(["create", "--region", "us"], { env: platformEnv(fake.url) })).code).toBe(0)
    expect(fake.created.at(-1)).toMatchObject({ region: "us" })
    expect((await cli(["create"], { env: platformEnv(fake.url, { KYORA_VMS_REGION: "apac" }) })).code).toBe(0)
    expect(fake.created.at(-1)).toMatchObject({ region: "apac" })
    expect((await cli(["create", "--region", "global"], { env: platformEnv(fake.url, { KYORA_VMS_REGION: "apac" }) })).code).toBe(0)
    expect(fake.created.at(-1)).toMatchObject({ region: "global" })
    expect((await cli(["create", "--region", "eu"], { env: platformEnv(fake.url, { KYORA_VMS_REGION: "apac" }) })).code).toBe(0)
    expect(fake.created.at(-1)).toMatchObject({ region: "eu" })
    // none says nothing: the cloud goes by where you are
    expect((await cli(["create"], { env: platformEnv(fake.url) })).code).toBe(0)
    expect(fake.created.at(-1)!.region).toBeUndefined()
  })

  test("a malformed region is refused before anything is sent", async () => {
    fake = await startFakePlatform()
    const bad = await cli(["create", "--region", "US East"], { env: platformEnv(fake.url) })
    expect(bad.code).toBe(125)
    expect(bad.stderr).toContain("--region must be a region id")
    const env = await cli(["create"], { env: platformEnv(fake.url, { KYORA_VMS_REGION: "eu_west" }) })
    expect(env.stderr).toContain("KYORA_VMS_REGION must be a region id")
    expect(fake.created).toEqual([])
  })

  test("--strict, which naming a region made redundant, only says so and sends nothing", async () => {
    fake = await startFakePlatform()
    const result = await cli(["create", "--region", "us", "--strict"], { env: platformEnv(fake.url) })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("--strict does nothing any more: --region <id> keeps a create in that region")
    expect(fake.created.at(-1)).toEqual(expect.objectContaining({ region: "us" }))
    expect(fake.created.at(-1)!.strict).toBeUndefined()
  })

  test("a single kyora-vmd has no regions: global is dropped, a named region can't be kept", async () => {
    fake = await startFakeVmd()
    expect((await cli(["create", "--region", "global"], { env: baseEnv(fake.url) })).code).toBe(0)
    expect(fake.created.at(-1)!.region).toBeUndefined()
    const named = await cli(["create", "--region", "us"], { env: baseEnv(fake.url) })
    expect(named.code).toBe(125)
    expect(named.stderr).toContain("does not support regions")
    expect(fake.created).toHaveLength(1)
  })

  test("a global create that ran in the next region says so on stderr; stdout is still just the id", async () => {
    const cloud = regionsCloud({ region: "eu", requestedRegion: "us" })
    const result = await cli(["create"], { env: platformEnv(cloud.url) })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("sb_k1abcd_AAAAAAAAAAAAAAAA")
    expect(result.stderr).toContain("on box-1 in eu")
    expect(result.stderr).toContain("no machine in us had room; sb_k1abcd_AAAAAAAAAAAAAAAA runs in eu (--region us keeps a create there)")
  })
})

describe("kyora vms regions", () => {
  test("lists the regions, what is free in each, and where your creates go", async () => {
    const cloud = regionsCloud()
    const result = await cli(["regions"], { env: platformEnv(cloud.url) })
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split("\n")
    expect(lines[0]).toMatch(/^REGION\s+NAME\s+VCPU FREE\s+MEM FREE/)
    expect(lines[1]).toMatch(/^eu\s+Europe\s+12\s+40G/)
    expect(lines[2]).toMatch(/^us\s+United States\s+8\s+16G\s+← yours/)
    expect(lines[3]).toMatch(/^apac\s+Asia-Pacific\s+0/)
    expect(result.stdout).toContain("regions are selected automatically. --region <id> keeps a create in one region.")
    expect(result.stdout).not.toMatch(/MACHINES|FALLS BACK TO|when it is full/)
    const json = await cli(["regions", "--json"], { env: platformEnv(cloud.url) })
    expect(JSON.parse(json.stdout)).toMatchObject({ you: { region: "us" }, regions: [{ id: "eu" }, { id: "us" }, { id: "apac" }] })
  })

  test("default <id> makes one yours (only there), default global or auto goes back to the nearest", async () => {
    const cloud = regionsCloud()
    const set = await cli(["regions", "default", "apac"], { env: platformEnv(cloud.url) })
    expect(set.code).toBe(0)
    expect(set.stdout).toContain("your creates go to apac and only there")
    const global = await cli(["regions", "default", "global"], { env: platformEnv(cloud.url) })
    expect(global.stdout).toContain("regions are selected automatically")
    expect((await cli(["regions", "default", "auto"], { env: platformEnv(cloud.url) })).code).toBe(0)
    expect(cloud.seen.filter((call) => call.path === "/v1/me/region").map((call) => [call.method, call.body])).toEqual([
      ["PUT", { region: "apac" }],
      ["PUT", { region: null }],
      ["PUT", { region: null }],
    ])
    expect((await cli(["regions", "default"], { env: platformEnv(cloud.url) })).code).toBe(125)
    expect((await cli(["regions", "nearest"], { env: platformEnv(cloud.url) })).code).toBe(125)
  })

  test("against a single kyora-vmd there are none", async () => {
    fake = await startFakeVmd()
    const result = await cli(["regions"], { env: baseEnv(fake.url) })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("does not support regions")
  })
})
