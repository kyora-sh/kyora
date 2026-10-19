import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { VmsClient } from "./api"
import { cli, baseEnv, tempDir } from "./testing/fixtures"
import { rm } from "node:fs/promises"

let server: Server<undefined> | undefined
afterEach(async () => { await server?.stop(true); server = undefined })

test("SDK and CLI send fractional allocation and elastic fields on the existing create endpoint", async () => {
  const bodies: unknown[] = []
  const paths: string[] = []
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/v1/health") return Response.json({ ok: true, features: ["vm.burst"] })
    paths.push(path)
    const body = await request.json() as Record<string, unknown>
    bodies.push(body)
    return Response.json({ id: "sb_burst", ...body })
  } })
  const url = `http://127.0.0.1:${server.port}`
  const shape = { vcpus: 8, allocatedVcpus: 0.5, cpuLimit: 0.75, memoryMb: 1024, maxMemoryMb: 4096, autoscale: true }
  const client = new VmsClient({ url, key: "kvms_test" })
  expect(await client.create({ name: "burst", ...shape })).toMatchObject(shape)
  const root = await tempDir("burst")
  try {
    const result = await cli(["create", "--cpus", "8", "--allocated-cpus", "0.5", "--cpu-limit", "0.75", "--memory", "1G", "--max-memory", "4G", "--autoscale"], { cwd: root, env: baseEnv(url) })
    expect(result.code, result.stderr).toBe(0)
    expect(bodies[1]).toMatchObject(shape)
    expect(paths).toEqual(["/v1/sandboxes", "/v1/sandboxes"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
