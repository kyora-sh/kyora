import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { FLEET_IMAGE_NAMES } from "../../shared/image-chunks"
import { canonicalJson, checkSpec, contentKey, filePathProblem, loadSpec, pnpmStep, SpecError, type ImageSpec } from "./image-spec"
import { tempDir, write } from "./testing/fixtures"

/**
 * kyora.image.json (image-spec.ts): every mistake said by field before a sandbox starts, the compile
 * to the builder's spec, and the content key: the same inputs give the same key, and any change to
 * the spec, a file's content or the base gives another.
 */

let root: string

beforeEach(async () => {
  root = await tempDir("image-spec")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const PLATFORM = {
  name: "platform",
  base: "default",
  apt: ["ffmpeg", "sqlite3", "git", "curl", "jq", "ca-certificates"],
  node: "24.11.1",
  pnpm: "10.33.2",
  env: { npm_config_store_dir: "/opt/pnpm-store" },
  files: { "/opt/platform/pnpm-lock.yaml": "pnpm-lock.yaml" },
  run: ["cd /opt/platform && pnpm fetch"],
}

async function spec(raw: unknown, files: Record<string, string> = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }): Promise<ImageSpec> {
  for (const [path, text] of Object.entries(files)) await write(root, path, text)
  await write(root, "kyora.image.json", JSON.stringify(raw))
  return loadSpec(join(root, "kyora.image.json"))
}

async function problems(raw: unknown): Promise<string[]> {
  try {
    await checkSpec(raw, "kyora.image.json")
  } catch (error) {
    if (error instanceof SpecError) return error.problems.map((problem) => problem.field)
    throw error
  }
  return []
}

test("the platform spec compiles to the builder's: kyora/<base>, pnpm through corepack first, nodejs.org and repo.yarnpkg.com allowed, files kept out", async () => {
  const compiled = await spec(PLATFORM)
  expect(compiled.name).toBe("platform")
  expect(compiled.base).toBe("default")
  expect(compiled.compiled).toEqual({
    name: "platform",
    base: "kyora/default",
    apt: PLATFORM.apt,
    node: "24.11.1",
    env: PLATFORM.env,
    run: [pnpmStep("10.33.2"), "cd /opt/platform && pnpm fetch"],
  })
  expect(compiled.build).toMatchObject({ network: "registries", allow: ["nodejs.org", "repo.yarnpkg.com"], diskGb: 64, vcpus: 8, memoryMb: 16384, timeoutSeconds: 3600 })
  expect(compiled.files).toEqual([{ path: "/opt/platform/pnpm-lock.yaml", given: "pnpm-lock.yaml", from: join(await realpath(root), "pnpm-lock.yaml"), mode: "0644", sha256: new Bun.CryptoHasher("sha256").update("lockfileVersion: '9.0'\n").digest("hex"), bytes: 23 }])
  expect(pnpmStep("10.33.2").run).toContain("corepack install -g pnpm@10.33.2")
})

test("the run-sandbox spec: desktop with uv's python 3.12 and a pinned rust; kyora/ bases and build options", async () => {
  const compiled = await spec({
    name: "run-sandbox",
    base: "kyora/desktop",
    python: ["3.12"],
    rustup: { toolchains: ["1.90.0"] },
    pip: ["requests==2.32.5"],
    build: { size: "xl", disk: "100G", timeout: "2h", allow: ["static.example.com"] },
  })
  expect(compiled.base).toBe("desktop")
  expect(compiled.compiled).toMatchObject({ base: "kyora/desktop", python: ["3.12"], rustup: { toolchains: ["1.90.0"] }, pip: ["requests==2.32.5"] })
  expect(compiled.compiled.run).toBeUndefined()
  expect(compiled.build).toMatchObject({ vcpus: 16, memoryMb: 32768, diskGb: 100, timeoutSeconds: 7200, allow: ["static.example.com"] })
})

test("every mistake is said at once, by field", async () => {
  expect(await problems({ name: "Platform", base: "default" })).toEqual(["name"])
  expect(await problems({ name: "desktop", base: "default" })).toEqual(["name"])
  expect(await problems({ name: "p", base: "img_abc" })).toEqual(["base"])
  expect(await problems({ name: "p" })).toEqual(["base"])
  expect(await problems({ name: "p", base: "default", node: "24", pnpm: "latest", bun: "1.x" })).toEqual(["node", "bun", "pnpm"])
  expect(await problems({ name: "p", base: "default", apt: ["ok", "Bad Name"], npm: ["typescript"], pip: ["requests>=2"] })).toEqual(["apt[1]", "npm[0]", "pip[0]"])
  expect(await problems({ name: "p", base: "default", extends: "full", packages: [] })).toEqual(["extends", "packages"])
  expect(await problems({ name: "p", base: "default", env: { "BAD-KEY": "x", SPACED: "a b", API_TOKEN: "abc" } })).toEqual(["env.BAD-KEY", "env.SPACED", "env.API_TOKEN"])
  expect(await problems({ name: "p", base: "default", run: ["", { run: "x", user: "admin" }, { run: "y", as: "root" }] })).toEqual(["run[0]", "run[1].user", "run[2].as"])
  expect(await problems({ name: "p", base: "default", build: { network: "wide", size: "huge", disk: "lots", gpu: true } })).toEqual(["build.gpu", "build.network", "build.disk", "build.size"])
  expect(await problems({ name: "p", base: "base", pnpm: "10.33.2" })).toEqual(["pnpm"])
  expect(await problems({ name: "p", base: "default", files: { "/work/x": "a", "/etc/kyora/env": "b", "relative": "c", "/opt/missing": "nope.txt" } })).toEqual(['files["/work/x"]', 'files["/etc/kyora/env"]', 'files["relative"]', 'files["/opt/missing"]'])
  const message = await checkSpec({ name: "p", base: "default", node: "24.x" }, "kyora.image.json").catch((error: Error) => error.message)
  expect(message).toContain('node: must be an exact version like "24.11.1" (pin it')
})

/** the problems a spec in `dir` has, by field and message */
async function fileProblems(dir: string, files: Record<string, unknown>): Promise<Array<{ field: string; message: string }>> {
  await write(dir, "kyora.image.json", JSON.stringify({ name: "p", base: "default", files, build: { network: "open" } }))
  try {
    await loadSpec(join(dir, "kyora.image.json"))
  } catch (error) {
    if (error instanceof SpecError) return error.problems
    throw error
  }
  return []
}

test("files are read from the spec's directory only: an absolute path, .., a link out or a linked directory out is refused", async () => {
  // the repo: the spec in a subdirectory, a secret beside the repo, links of every kind
  const repo = join(root, "repo")
  const outside = join(root, "secrets")
  await write(outside, "id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n")
  await write(repo, "image/config/app.toml", "region = \"eu\"\n")
  await write(repo, "sibling.txt", "next to the spec's directory, not in it\n")
  await symlink(join(outside, "id_ed25519"), join(repo, "image", "key-link"))
  await symlink(outside, join(repo, "image", "dir-link"))
  await symlink("config/app.toml", join(repo, "image", "inside-link"))
  await mkdir(join(repo, "image", "nested"), { recursive: true })
  await symlink("../config", join(repo, "image", "nested", "config-link"))
  const dir = join(repo, "image")

  const absolute = await fileProblems(dir, { "/opt/x": join(outside, "id_ed25519"), "/opt/y": "/etc/hosts", "/opt/z": "~/.ssh/id_ed25519" })
  expect(absolute.map((problem) => problem.field)).toEqual(['files["/opt/x"]', 'files["/opt/y"]', 'files["/opt/z"]'])
  for (const problem of absolute) expect(problem.message).toContain("relative to the spec's directory")

  const dotdot = await fileProblems(dir, { "/opt/x": "../sibling.txt", "/opt/y": "config/../../sibling.txt", "/opt/z": { from: "../../secrets/id_ed25519" } })
  expect(dotdot.map((problem) => problem.field)).toEqual(['files["/opt/x"]', 'files["/opt/y"]', 'files["/opt/z"]'])
  for (const problem of dotdot) expect(problem.message).toContain("relative to the spec's directory, without ..")

  const linkOut = await fileProblems(dir, { "/opt/key": "key-link" })
  expect(linkOut).toEqual([{ field: 'files["/opt/key"]', message: expect.stringContaining("outside the spec's directory") }])
  expect(linkOut[0]!.message).toContain("relative to the spec's directory")

  const dirOut = await fileProblems(dir, { "/opt/key": "dir-link/id_ed25519" })
  expect(dirOut).toEqual([{ field: 'files["/opt/key"]', message: expect.stringContaining("outside the spec's directory") }])

  // a link that stays inside is fine, and the file is read through its real path
  expect(await fileProblems(dir, { "/opt/a": "inside-link", "/opt/b": "nested/config-link/app.toml", "/opt/c": "config/app.toml" })).toEqual([])
  const spec = await loadSpec(join(dir, "kyora.image.json"))
  const real = join(await realpath(dir), "config", "app.toml")
  expect(spec.files.map((file) => [file.path, file.from])).toEqual([["/opt/a", real], ["/opt/b", real], ["/opt/c", real]])
  // nothing under it is a directory or missing
  expect((await fileProblems(dir, { "/opt/d": "config" }))[0]!.message).toContain("not a file, relative to the spec's directory")
  expect((await fileProblems(dir, { "/opt/e": "missing.txt" }))[0]!.message).toContain("no such file, relative to the spec's directory")
})

test("base is one of kyora's images: an account image's name (or anything else) is refused", async () => {
  expect(await problems({ name: "p", base: "platform" })).toEqual(["base"])
  expect(await problems({ name: "p", base: "kyora/tools" })).toEqual(["base"])
  for (const base of ["default", "full", "desktop", "kyora/node", "python", "rust"]) expect(await problems({ name: "p", base })).toEqual([])
})

test("FLEET_IMAGE_NAMES holds the fleet's images, so none can be shadowed by an account image", () => {
  for (const name of ["default", "base", "node", "python", "rust", "full", "desktop"]) expect([name, FLEET_IMAGE_NAMES.has(name)]).toEqual([name, true])
})

test("file paths: the image's own, never runtime mounts or kyora's; /bin is /usr/bin", () => {
  expect(filePathProblem("/opt/app/config.toml")).toBeNull()
  expect(filePathProblem("/usr/local/bin/tool")).toBeNull()
  expect(filePathProblem("/tmp/x")).toContain("/tmp")
  expect(filePathProblem("/var/run/x")).toContain("/var/run")
  expect(filePathProblem("/sbin/kyora-init")).toContain("kyora's own")
  expect(filePathProblem("/opt/../etc/passwd")).toContain("normalized")
})

test("canonical JSON: one text for one value, whatever order it was written in", () => {
  expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}')
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
})

test("the content key: the same inputs give the same key; the spec, a file's content, the base or the builder change it", async () => {
  const base = await spec(PLATFORM)
  const key = contentKey(base, "full-0123", "sha256:builder")
  expect(key).toMatch(/^sha256:[0-9a-f]{64}$/)
  // the same spec written in another order, another name or description: the same key
  const reordered = await spec({ run: PLATFORM.run, files: PLATFORM.files, env: PLATFORM.env, pnpm: PLATFORM.pnpm, node: PLATFORM.node, apt: PLATFORM.apt, base: "default", name: "platform", description: "free text" })
  expect(contentKey(reordered, "full-0123", "sha256:builder")).toBe(key)
  expect(contentKey({ ...base, compiled: { ...base.compiled, name: "other" } }, "full-0123", "sha256:builder")).toBe(key)
  // any change to what is built
  expect(contentKey(await spec({ ...PLATFORM, apt: [...PLATFORM.apt, "htop"] }), "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(await spec({ ...PLATFORM, pnpm: "10.33.1" }), "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(await spec({ ...PLATFORM, run: ["cd /opt/platform && pnpm fetch --prod"] }), "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(await spec(PLATFORM, { "pnpm-lock.yaml": "lockfileVersion: '9.1'\n" }), "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(await spec({ ...PLATFORM, files: { "/opt/platform/pnpm-lock.yaml": { from: "pnpm-lock.yaml", mode: "0600" } } }), "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(base, "full-4567", "sha256:builder")).not.toBe(key)
  expect(contentKey({ ...base, base: "full" }, "full-0123", "sha256:builder")).not.toBe(key)
  expect(contentKey(base, "full-0123", "sha256:another-builder")).not.toBe(key)
  // and back: the same inputs again
  expect(contentKey(await spec(PLATFORM), "full-0123", "sha256:builder")).toBe(key)
})
