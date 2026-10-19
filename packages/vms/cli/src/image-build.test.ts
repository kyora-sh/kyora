import { afterEach, beforeEach, expect, test } from "bun:test"
import { readdir, rename, rm, symlink } from "node:fs/promises"
import { join, relative } from "node:path"
import type { CreateSpec, ExecRequest, Sandbox } from "./api"
import type { AccountImage, PushOptions } from "./account-images"
import { BuildFailure, buildImage, driverScript, renderLog, type BuildBackend, OUTPUT, REMOTE_DIR } from "./image-build"
import { BUILDER_FILES, BUILDER_HASH } from "./image-builder-assets"
import { contentKey, loadSpec, pnpmStep, SpecError } from "./image-spec"
import { tempDir, write } from "./testing/fixtures"

/**
 * `kyora-vms image build`'s orchestration (image-build.ts) against a fake kyora cloud and a fake
 * builder sandbox: what the builder is created with, what goes up, the streamed log, the push with
 * the content key, the cache, and the builder destroyed whatever happens.
 */

let root: string

beforeEach(async () => {
  root = await tempDir("image-build")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SPEC = {
  name: "platform",
  base: "default",
  apt: ["ffmpeg", "jq"],
  node: "24.11.1",
  pnpm: "10.33.2",
  files: { "/opt/platform/pnpm-lock.yaml": "pnpm-lock.yaml" },
  run: ["cd /opt/platform && pnpm fetch"],
}
const BUILD = "full-0123"
const MANIFEST = JSON.stringify({ id: BUILD, profile: "full", builtAt: "2026-10-01T00:00:00+00:00" })

const image = (fields: Partial<AccountImage>): AccountImage => ({
  id: "img_000000000001",
  name: "platform",
  version: 1,
  ref: "platform@1",
  specKey: null,
  base: null,
  status: "ready",
  region: "eu",
  sha256: "ab".repeat(32),
  bytes: 64 * 1024 * 1024,
  chunks: 10,
  dataBytes: 40 * 1024 * 1024,
  storedBytes: 20 * 1024 * 1024,
  digest: "cd".repeat(32),
  createdAt: "2026-10-06T00:00:00.000Z",
  readyAt: "2026-10-06T00:00:01.000Z",
  expiresAt: null,
  error: null,
  ...fields,
})

/** what the builder prints: log records, then its result */
const LOG = [
  { t: "t", phase: "spec", step: null, stream: "sys", data: "spec platform on kyora/default: 8 phases, 2 run steps" },
  { t: "t", phase: "apt", step: null, stream: "err", data: "Reading package lists..." },
  { t: "t", phase: "run", step: 2, stream: "out", data: "Progress: resolved 412, reused 0" },
  { fsBytes: 64 * 1024 * 1024, digest: "sha256:" + "e".repeat(64), rootfs: { digest: "sha256:" + "f".repeat(64) } },
].map((record) => JSON.stringify(record)).join("\n") + "\n"

interface Fake {
  backend: BuildBackend
  calls: string[]
  created: CreateSpec[]
  uploaded: Map<string, string>
  streamed: ExecRequest[]
  pushed: Array<{ path: string; options: PushOptions }>
  destroyed: string[]
}

function fake(options: { images?: AccountImage[]; builds?: string[]; stream?: (output: (stream: "stdout" | "stderr", text: string) => void) => { code: number; error: string | null }; push?: () => never; created?: () => Promise<void> } = {}): Fake {
  const state: Fake = { backend: null as unknown as BuildBackend, calls: [], created: [], uploaded: new Map(), streamed: [], pushed: [], destroyed: [] }
  state.backend = {
    defaultRegion: async () => "eu",
    fleetBuilds: async (name, region) => {
      state.calls.push(`builds ${name} ${region}`)
      return options.builds ?? [BUILD]
    },
    accountImages: async () => options.images ?? [],
    createSandbox: async (spec) => {
      state.calls.push("create")
      state.created.push(spec)
      // what happens on this machine while the builder boots, after the spec was checked
      await options.created?.()
      return { id: "sbx_builder", status: "running", region: "eu" } as Sandbox
    },
    upload: async (_id, dir, dest) => {
      state.calls.push(`upload ${dest}`)
      const walk = async (at: string): Promise<void> => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
          const path = join(at, entry.name)
          if (entry.isDirectory()) await walk(path)
          else state.uploaded.set(relative(dir, path), await Bun.file(path).text())
        }
      }
      await walk(dir)
    },
    run: async (_id, cmd) => {
      state.calls.push(`run ${cmd.join(" ")}`)
      return { code: 0, stdout: MANIFEST, stderr: "" }
    },
    stream: async (_id, request, output) => {
      state.calls.push("stream")
      state.streamed.push(request)
      if (options.stream) return options.stream(output)
      // in pieces that split lines, as a network does
      for (let at = 0; at < LOG.length; at += 37) output("stdout", LOG.slice(at, at + 37))
      output("stderr", "a line of the driver's own\n")
      return { code: 0, error: null }
    },
    download: async (_id, path, to) => {
      state.calls.push(`download ${path}`)
      const local = join(to, "rootfs.ext4")
      await Bun.write(local, "image")
      return local
    },
    push: async (path, pushOptions) => {
      state.calls.push("push")
      if (options.push) options.push()
      state.pushed.push({ path, options: pushOptions })
      return image({ id: "img_000000000009", version: 3, ref: "platform@3", specKey: pushOptions.specKey ?? null, base: pushOptions.base ?? null })
    },
    destroy: async (id) => {
      state.calls.push("destroy")
      state.destroyed.push(id)
    },
  }
  return state
}

async function specFile(raw: unknown = SPEC): Promise<string> {
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(root, "kyora.image.json", JSON.stringify(raw))
  return join(root, "kyora.image.json")
}

test("a build: the builder boots the base in the region, the builder, spec and files go up, the log streams, the image is pushed with its key, the builder goes", async () => {
  const path = await specFile()
  const state = fake()
  const lines: string[] = []
  const result = await buildImage(state.backend, { specPath: path, log: (line) => lines.push(line) })

  expect(state.calls).toEqual([`builds default eu`, "create", "run cat /etc/kyora-image.json", `upload ${REMOTE_DIR}`, "stream", `download ${OUTPUT}`, "push", "destroy"])
  expect(state.created[0]).toMatchObject({ image: "default", region: "eu", network: "registries", egressAllow: ["nodejs.org", "repo.yarnpkg.com"], vcpus: 8, memoryMb: 16384, diskGb: 64, idleSeconds: 0, ttlSeconds: 3600 + 3600, labels: { "image-build": "platform" } })
  expect(state.created[0]!.name).toMatch(/^build-platform-[a-z0-9]+$/)

  // the builder as the CLI carries it, the compiled spec, the files by index, the driver
  for (const [file, { text }] of Object.entries(BUILDER_FILES)) expect(state.uploaded.get(file)).toBe(text)
  const compiled = JSON.parse(state.uploaded.get("spec.json")!)
  expect(compiled).toMatchObject({ name: "platform", base: "kyora/default", node: "24.11.1", run: [pnpmStep("10.33.2"), "cd /opt/platform && pnpm fetch"] })
  expect(state.uploaded.get("files.list")).toBe("0 0644 /opt/platform/pnpm-lock.yaml\n")
  expect(state.uploaded.get("files/0")).toBe("lockfileVersion: '9.0'\n")
  expect(state.uploaded.get("build.sh")).toContain("--base-ref 'kyora/default'")
  expect(state.streamed[0]).toMatchObject({ cmd: ["sudo", "-n", "/bin/bash", `${REMOTE_DIR}/build.sh`], timeoutSeconds: 3600 + 300 })

  // the log, line by line however it was cut, as people read it
  expect(lines).toContain("==> spec platform on kyora/default: 8 phases, 2 run steps")
  expect(lines).toContain("[apt] Reading package lists...")
  expect(lines).toContain("[run 2] Progress: resolved 412, reused 0")
  expect(lines).toContain("a line of the driver's own")

  const key = contentKey(await loadSpec(path), BUILD, BUILDER_HASH)
  expect(state.pushed[0]!.options).toMatchObject({ name: "platform", region: "eu", specKey: key, base: `default@${BUILD}` })
  expect(result).toMatchObject({ ref: "platform@3", name: "platform", version: 3, digest: `sha256:${"ab".repeat(32)}`, region: "eu", sizeBytes: 64 * 1024 * 1024, cached: false, key, base: `default@${BUILD}` })
  expect(state.destroyed).toEqual(["sbx_builder"])
})

test("the same spec, files and base: the version with that key, at once, and no sandbox", async () => {
  const path = await specFile()
  const key = contentKey(await loadSpec(path), BUILD, BUILDER_HASH)
  const older = image({ version: 1, ref: "platform@1", specKey: key })
  const newer = image({ id: "img_000000000002", version: 2, ref: "platform@2", specKey: key })
  const elsewhere = image({ id: "img_000000000003", version: 4, ref: "platform@4", specKey: key, region: "us" })
  const state = fake({ images: [older, newer, elsewhere] })
  const result = await buildImage(state.backend, { specPath: path, log: () => {} })
  expect(state.calls).toEqual([`builds default eu`])
  expect(result).toMatchObject({ ref: "platform@2", cached: true, key, region: "eu" })
  // another region's version is no cache for this one
  const there = fake({ images: [older] })
  expect((await buildImage(there.backend, { specPath: path, region: "us", log: () => {} })).cached).toBe(false)
})

test("a server that lists no builds: the builder's own base decides, and a cached version still costs no build", async () => {
  const path = await specFile()
  const key = contentKey(await loadSpec(path), BUILD, BUILDER_HASH)
  const state = fake({ builds: [], images: [image({ specKey: key })] })
  const result = await buildImage(state.backend, { specPath: path, log: () => {} })
  expect(result).toMatchObject({ ref: "platform@1", cached: true })
  expect(state.calls).toEqual([`builds default eu`, "create", "run cat /etc/kyora-image.json", "destroy"])
})

test("a changed file is another key: built again", async () => {
  const path = await specFile()
  const key = contentKey(await loadSpec(path), BUILD, BUILDER_HASH)
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.1'\n")
  const state = fake({ images: [image({ specKey: key })] })
  expect((await buildImage(state.backend, { specPath: path, log: () => {} })).cached).toBe(false)
  expect(state.pushed[0]!.options.specKey).not.toBe(key)
})

test("a failed step: exit 1 with the builder's reason, nothing pushed, the builder destroyed", async () => {
  const path = await specFile()
  const state = fake({
    stream: (output) => {
      output("stdout", `${JSON.stringify({ t: "t", phase: "run", step: 2, stream: "err", data: "ERR_PNPM_NO_LOCKFILE" })}\n`)
      output("stdout", `${JSON.stringify({ error: { code: "step_failed", message: "run step 2/2 failed (exit 1): ERR_PNPM_NO_LOCKFILE" } })}\n`)
      return { code: 1, error: null }
    },
  })
  const failure = await buildImage(state.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(BuildFailure)
  expect(failure).toMatchObject({ code: 1, reason: "step_failed" })
  expect((failure as Error).message).toContain("run step 2/2 failed")
  expect(state.calls).not.toContain("push")
  expect(state.destroyed).toEqual(["sbx_builder"])
})

test("a spec the builder refuses exits 2; a stream that broke off is a failure too", async () => {
  const path = await specFile()
  const refused = fake({ stream: (output) => (output("stdout", `${JSON.stringify({ error: { code: "invalid_spec", field: "npm", message: "npm packages need node" } })}\n`), { code: 2, error: null }) })
  expect(await buildImage(refused.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)).toMatchObject({ code: 2, reason: "invalid_spec" })
  const lost = fake({ stream: () => ({ code: 125, error: "the exec stream ended without an exit status" }) })
  expect(await buildImage(lost.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)).toMatchObject({ code: 1, reason: "exec_failed" })
  expect(lost.destroyed).toEqual(["sbx_builder"])
})

test("a push that fails still destroys the builder", async () => {
  const path = await specFile()
  const state = fake({ push: () => { throw new Error("quota_exceeded") } })
  expect(await buildImage(state.backend, { specPath: path, log: () => {} }).catch((error: Error) => error.message)).toBe("quota_exceeded")
  expect(state.destroyed).toEqual(["sbx_builder"])
})

test("a file edited between the check and the staging is refused: nothing goes up, the builder goes", async () => {
  const path = await specFile()
  const state = fake({ created: () => write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nedited: after the check\n") })
  const failure = await buildImage(state.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(BuildFailure)
  expect(failure).toMatchObject({ code: 2, reason: "file_changed" })
  expect((failure as Error).message).toContain("pnpm-lock.yaml changed during the build (its content is not what was checked)")
  expect(state.calls).not.toContain(`upload ${REMOTE_DIR}`)
  expect(state.destroyed).toEqual(["sbx_builder"])
})

test("a path component swapped for a link out of the spec's directory is refused, even to the same bytes", async () => {
  const content = "region = \"eu\"\n"
  await write(root, "config/app.toml", content)
  const path = await specFile({ ...SPEC, files: { "/opt/app/app.toml": "config/app.toml" } })
  const outside = await tempDir("image-build-outside")
  try {
    await write(outside, "app.toml", content)
    const state = fake({
      created: async () => {
        await rename(join(root, "config"), join(root, "config-moved"))
        await symlink(outside, join(root, "config"))
      },
    })
    const failure = await buildImage(state.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 2, reason: "file_changed" })
    expect((failure as Error).message).toContain("config/app.toml changed during the build (it now leads to")
    expect(state.calls).not.toContain(`upload ${REMOTE_DIR}`)
    expect(state.destroyed).toEqual(["sbx_builder"])
    // put back, then gone before the staging: the same refusal
    await rm(join(root, "config"))
    await rename(join(root, "config-moved"), join(root, "config"))
    const gone = fake({ created: () => rm(join(root, "config"), { recursive: true, force: true }) })
    const vanished = await buildImage(gone.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)
    expect(vanished).toMatchObject({ code: 2, reason: "file_changed" })
    expect((vanished as Error).message).toContain("(it is gone)")
    expect(gone.destroyed).toEqual(["sbx_builder"])
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test("a bad spec costs no sandbox", async () => {
  const path = await specFile({ ...SPEC, node: "24" })
  const state = fake()
  expect(await buildImage(state.backend, { specPath: path, log: () => {} }).catch((error: unknown) => error)).toBeInstanceOf(SpecError)
  expect(state.calls).toEqual([])
})

test("the driver is valid bash and builds against the sandbox's own read-only root", async () => {
  const spec = await loadSpec(await specFile())
  const script = driverScript(spec, { timeoutSeconds: 3600, maxRootGb: 48 })
  await write(root, "build.sh", script)
  const checked = Bun.spawnSync(["bash", "-n", join(root, "build.sh")], { stderr: "pipe" })
  expect(checked.stderr.toString()).toBe("")
  expect(checked.exitCode).toBe(0)
  expect(script).toContain('mount --bind / "$R/root"')
  expect(script).toContain('mount -o remount,bind,ro "$R/root"')
  expect(script).toContain(`--output ${OUTPUT}`)
  expect(script).toContain("--name 'platform'")
})

test("renderLog: sys lines, a phase's output, the result, and anything else as it came", () => {
  expect(renderLog(JSON.stringify({ stream: "sys", data: "pack done" }))).toEqual({ text: "==> pack done" })
  expect(renderLog(JSON.stringify({ phase: "npm", step: null, stream: "out", data: "added 1 package" }))).toEqual({ text: "[npm] added 1 package" })
  expect(renderLog('{"fsBytes": 4194304}')).toEqual({ text: null, result: { fsBytes: 4194304 } })
  expect(renderLog("not json")).toEqual({ text: "not json" })
})
