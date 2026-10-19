/** Published entry point under Bun and Node ESM: no CLI startup, credential reads or output listeners. */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import type { EgressChange as SharedChange, EgressPolicy as SharedPolicy } from "@kyora-sh/hostnames"
import type { EgressChange, EgressPolicy } from "./library"
import { tempDir } from "./testing/fixtures"

setDefaultTimeout(60_000)
const cwd = join(import.meta.dir, "..")
/** a project that installed the package: node_modules/@kyora-sh/vms is this package, as a link */
let consumer: string

async function run(cmd: string[], at = cwd) {
  const child = Bun.spawn(cmd, { cwd: at, env: { PATH: process.env.PATH!, HOME: process.env.HOME! }, stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  return { code: await child.exited, stdout, stderr }
}

beforeAll(async () => {
  const build = await run([process.execPath, "--no-env-file", "run", "build"])
  expect(build.code, build.stderr).toBe(0)
  consumer = await tempDir("library")
  await mkdir(join(consumer, "node_modules", "@kyora-sh"), { recursive: true })
  await symlink(cwd, join(consumer, "node_modules", "@kyora-sh", "vms"))
  await Bun.write(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }))
})
afterAll(() => rm(consumer, { recursive: true, force: true }))

/** the copies of the egress types the library declares keep the shape of the shared ones (check-types fails otherwise) */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const egressShapes: [Same<EgressPolicy, SharedPolicy>, Same<EgressChange, SharedChange>] = [true, true]

for (const runtime of ["bun", "node"]) test(`library import and share requests work under ${runtime} ESM`, async () => {
  const script = `
    import assert from "node:assert/strict"
    const before = [process.stdout.listenerCount("error"), process.stderr.listenerCount("error")]
    const { VmsClient, ApiError } = await import("@kyora-sh/vms")
    assert.deepEqual([process.stdout.listenerCount("error"), process.stderr.listenerCount("error")], before)
    assert.equal(typeof ApiError, "function")
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.authorization })
      return Response.json(init.method === "GET" ? { shares: [] } : init.method === "DELETE" ? { ok: true } : new URL(url).pathname.endsWith("/shares") ? { id: "share_abcdefghijklmnop", stream: "screen", session: null } : { id: "sb_abcdefghijklmnop", shareable: false })
    }
    const client = new VmsClient({ url: "https://cloud.kyora.sh", key: "kyora_fake" })
    const sandbox = await client.create({ name: "private-run", shareable: false })
    assert.equal(sandbox.shareable, false)
    await client.createShare(sandbox.id, { stream: "screen", ttlSeconds: 60 })
    assert.deepEqual(await client.listShares(sandbox.id), { shares: [] })
    await client.revokeShare(sandbox.id, "share_abcdefghijklmnop")
    assert.deepEqual(calls.map(c => c.method), ["POST", "POST", "GET", "DELETE"])
    assert.equal(calls[0].body.shareable, false)
    assert.deepEqual(calls[1].body, { stream: "screen", ttlSeconds: 60 })
    assert.equal(calls[3].path, "/v1/sandboxes/sb_abcdefghijklmnop/shares/share_abcdefghijklmnop")
    assert.ok(calls.every(c => c.auth === "Bearer kyora_fake"))
  `
  const result = await run(runtime === "node" ? ["node", "--input-type=module", "--eval", script] : [process.execPath, "--no-env-file", "--eval", script], consumer)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe("")
})

test("the declarations stand alone: no Bun types, no unpublished workspace packages", async () => {
  expect(egressShapes).toEqual([true, true])
  await Bun.write(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", lib: ["es2022", "DOM", "DOM.Iterable"], types: [], noEmit: true, skipLibCheck: false },
    include: ["main.ts"],
  }))
  await Bun.write(join(consumer, "main.ts"), `
    import { VmsClient, type ClientConfig, type CreateSpec, type EgressPolicy, type Share } from "@kyora-sh/vms"
    const config: ClientConfig = { url: "https://cloud.kyora.sh", key: "kyora_fake" }
    const client = new VmsClient(config)
    const spec: CreateSpec = { shareable: false, image: "desktop" }
    export async function main(): Promise<[boolean | undefined, Share, Share[], EgressPolicy]> {
      const sandbox = await client.create(spec)
      const share = await client.createShare(sandbox.id, { stream: "tty", session: "agent", ttlSeconds: 60 })
      await client.revokeShare(sandbox.id, share.id)
      return [sandbox.shareable, share, (await client.listShares(sandbox.id)).shares, await client.network(sandbox.id, { egressAllow: [] })]
    }
  `)
  const checked = await run([join(cwd, "node_modules", ".bin", "tsc"), "-p", "."], consumer)
  expect(checked.code, checked.stdout + checked.stderr).toBe(0)
})

test("build keeps both Bun CLI binaries and their startup behavior", async () => {
  for (const bin of ["index.js", "kyora.js"]) {
    const path = join(cwd, "dist", bin)
    expect((await Bun.file(path).text()).split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null")
    const result = await run([process.execPath, "--no-env-file", path, "--help"])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(bin === "index.js" ? "kyora-vms" : "kyora")
  }
})
