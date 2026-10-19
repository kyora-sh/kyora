import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, posix, resolve, sep } from "node:path"
import { ACCOUNT_IMAGE_NAME, FLEET_IMAGE_NAMES, isReservedAccountImageName } from "../../shared/image-chunks"
import { SIZES } from "./ergonomics"
import { diskGb, parseSeconds } from "./units"

/**
 * `kyora.image.json`: the image spec `kyora-vms image build` reads from a repo. It is
 * the in-VM builder's spec (packages/vms/image/tools/imagespec.py)
 * with a few things a repo wants: a built-in `base` by its plain name, `pnpm` through corepack, `files`
 * as local paths next to the spec, and `build` options for the builder sandbox. `compileSpec` turns it
 * into the builder's spec; `contentKey` is what makes a build of the same inputs on the same base the
 * same version.
 */

export const SPEC_FILE = "kyora.image.json"
export const LOCK_FILE = "kyora.image.lock"
/** the content key's own format: a change to what it covers is a new number */
export const KEY_FORMAT = 1

export interface FileEntry {
  /** where it goes in the image */
  path: string
  /** the local file as the spec gives it, relative to the spec's directory */
  given: string
  /** the local file's real path, checked inside the spec's real directory */
  from: string
  mode: string
  sha256: string
  bytes: number
}

export interface BuildOptions {
  network: "none" | "registries" | "open"
  allow: string[]
  diskGb: number
  vcpus: number
  memoryMb: number
  timeoutSeconds: number
}

export interface ImageSpec {
  name: string
  description: string
  /** a built-in image: default, full, desktop, … */
  base: string
  /** the builder's spec (imagespec.py's format), without files: they go in through the base */
  compiled: Record<string, unknown>
  files: FileEntry[]
  build: BuildOptions
  /** where the spec file is */
  path: string
  /** the spec's real directory: the build context its files are read from */
  root: string
}

export class SpecError extends Error {
  constructor(readonly problems: Array<{ field: string; message: string }>, readonly path: string) {
    super(`${path}: ${problems.length === 1 ? "" : `${problems.length} problems:\n  `}${problems.map((problem) => `${problem.field}: ${problem.message}`).join("\n  ")}`)
  }
}

const KNOWN = new Set(["$schema", "name", "description", "base", "apt", "node", "pnpm", "bun", "uv", "python", "rustup", "npm", "pip", "uvTools", "cargo", "env", "files", "run", "build", "salt"])
const HINTS: Record<string, string> = { extends: "base", extra: "run", packages: "apt", environment: "env", steps: "run", corepack: "pnpm" }
const BUILD_KEYS = new Set(["network", "allow", "disk", "size", "cpus", "memory", "timeout"])
const RUN_KEYS = new Set(["run", "user", "timeoutSeconds"])

// the builder's own patterns (packages/vms/image/tools/profiles.py, imagespec.py): checked here
// first so a mistake is said before any sandbox starts; the builder checks them again
const BASE = /^(?:kyora\/)?([a-z0-9][a-z0-9._-]{0,63})$/
const APT = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/
const EXACT = /^v?\d+\.\d+\.\d+$/
const PNPM = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const NPM = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const UV_TOOL = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._-]+\])?==([A-Za-z0-9.!+-]+)$/
const CRATE = /^([A-Za-z0-9_-]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/
const PYTHON = /^3\.\d+(\.\d+)?$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_VALUE = /^[A-Za-z0-9_./:,@%+=-]*$/
const FILE_PATH = /^(\/[A-Za-z0-9._@+,:~=-]+)+$/
const MODE = /^0[0-7]{3}$/
const HOST = /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** never in the image: the runtime's mounts, and what kyora-init binds from the scratch disk */
const FORBIDDEN_ROOTS = ["/work", "/tmp", "/mnt", "/run", "/proc", "/sys", "/dev", "/var/run", "/var/lock"]
/** what boots the guest and what the build writes itself */
const KYORA_OWNED = ["/etc/kyora", "/etc/kyora-image.json", "/usr/sbin/kyora-init", "/usr/local/bin/kyora-vm-agent"]
/** merged /usr: a file under /bin goes to /usr/bin, where the base has it (a /bin directory of ours would hide the link) */
const USR_MERGED: Array<[string, string]> = [["/bin", "/usr/bin"], ["/sbin", "/usr/sbin"], ["/lib", "/usr/lib"], ["/lib32", "/usr/lib32"], ["/lib64", "/usr/lib64"], ["/libx32", "/usr/libx32"]]

const FILES_MAX = 256
const FILE_MAX_BYTES = 1024 ** 3
const RUN_MAX = 64
const RUN_TIMEOUT_MAX = 24 * 3600
const ALLOW_MAX = 32
const DEFAULT_DISK_GB = 64
const DEFAULT_TIMEOUT_S = 3600
/** what the builder downloads itself for `node`, beyond the registries allowlist: node, and the yarn corepack installs with it */
const NODE_HOSTS = ["nodejs.org", "repo.yarnpkg.com"]

type Raw = Record<string, unknown>
const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value)

/** the image path a file really lands at: /bin/x is /usr/bin/x */
export function realImagePath(path: string): string {
  for (const [alias, target] of USR_MERGED) if (path === alias || path.startsWith(`${alias}/`)) return target + path.slice(alias.length)
  return path
}

export function filePathProblem(path: unknown): string | null {
  if (typeof path !== "string" || !FILE_PATH.test(path) || posix.normalize(path) !== path) return "must be a normalized absolute path of [A-Za-z0-9._@+,:~=-] parts"
  const real = realImagePath(path)
  for (const root of FORBIDDEN_ROOTS) if (real === root || real.startsWith(`${root}/`)) return `is under ${root}, which is not part of the image`
  for (const owned of KYORA_OWNED) if (real === owned || real.startsWith(`${owned}/`)) return `is kyora's own (${owned})`
  return null
}

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

/** JSON with sorted keys and no spaces: one text for one value, whatever order it was written in */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  return JSON.stringify(value ?? null)
}

/**
 * Reads, checks and compiles a spec. Every problem is said at once, by field; local files are
 * hashed. `name` overrides the spec's name.
 */
export async function loadSpec(path: string, overrides: { name?: string } = {}): Promise<ImageSpec> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new SpecError([{ field: "spec", message: `no such file (write a ${SPEC_FILE})` }], path)
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch (error) {
    throw new SpecError([{ field: "spec", message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }], path)
  }
  return checkSpec(raw, path, overrides)
}

export async function checkSpec(raw: unknown, path: string, overrides: { name?: string } = {}): Promise<ImageSpec> {
  const problems: Array<{ field: string; message: string }> = []
  const problem = (field: string, message: string) => problems.push({ field, message })
  if (!isObject(raw)) throw new SpecError([{ field: "spec", message: "must be a JSON object" }], path)
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) problem(key, `unknown key${HINTS[key] ? ` (did you mean "${HINTS[key]}"?)` : ""}`)
  }

  const name = overrides.name ?? raw.name
  if (typeof name !== "string" || !ACCOUNT_IMAGE_NAME.test(name)) problem("name", `must be 1-64 lowercase letters, digits and dashes, a letter first (or pass --name): ${JSON.stringify(name ?? null)}`)
  else if (isReservedAccountImageName(name)) problem("name", `${name} is a kyora image's own name (--image ${name} boots it); give yours another`)
  if (raw.description !== undefined && typeof raw.description !== "string") problem("description", "must be a string")

  const baseMatch = typeof raw.base === "string" ? BASE.exec(raw.base) : null
  if (!baseMatch) problem("base", `must name a built-in image, e.g. "default", "full" or "desktop": ${JSON.stringify(raw.base ?? null)}`)
  // a kyora image only: the builder boots the base, and the content key trusts the build id it reports
  else if (!FLEET_IMAGE_NAMES.has(baseMatch[1]!)) problem("base", `must be one of kyora's images (\`kyora-vms images\` lists them), not ${JSON.stringify(raw.base)}; building on your own images comes later`)

  const list = (key: string, pattern: RegExp, what: string) => {
    const value = raw[key]
    if (value === undefined) return [] as string[]
    if (!Array.isArray(value)) {
      problem(key, "must be a list of strings")
      return []
    }
    value.forEach((item, i) => {
      if (typeof item !== "string" || !pattern.test(item)) problem(`${key}[${i}]`, `must be ${what}: ${JSON.stringify(item)}`)
    })
    return value.filter((item): item is string => typeof item === "string")
  }
  const apt = list("apt", APT, "a package name, or name=version")
  list("npm", NPM, 'name@x.y.z, an exact version (e.g. "typescript@5.9.3")')
  list("pip", UV_TOOL, 'name==x.y.z, an exact version (e.g. "requests==2.32.5")')
  list("uvTools", UV_TOOL, "name==x.y.z, an exact version")
  list("cargo", CRATE, "crate@x.y.z, an exact version")
  list("python", PYTHON, 'a CPython version like "3.12" or "3.12.7"')
  for (const key of ["node", "bun", "uv"]) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !EXACT.test(value)) {
      const floating = typeof value === "string" && /^v?\d+(\.(\d+|x))?(\.x)?$/.test(value)
      problem(key, `must be an exact version like "${key === "node" ? "24.11.1" : "1.2.3"}"${floating ? " (pin it: a version that floats would change under the same spec)" : ""}: ${JSON.stringify(value)}`)
    }
  }
  if (raw.pnpm !== undefined && (typeof raw.pnpm !== "string" || !PNPM.test(raw.pnpm))) problem("pnpm", `must be an exact version like "10.33.2" (corepack installs it): ${JSON.stringify(raw.pnpm)}`)
  if (raw.rustup !== undefined && !isObject(raw.rustup)) problem("rustup", 'must be an object like {"toolchains": ["1.90.0"]}')
  if (raw.salt !== undefined && (typeof raw.salt !== "string" || raw.salt.length > 256)) problem("salt", "must be a string of at most 256 characters")

  const env = raw.env
  if (env !== undefined) {
    if (!isObject(env)) problem("env", 'must be an object {"NAME": "value"}')
    else for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY.test(key)) problem(`env.${key}`, "is not a variable name")
      else if (value !== null && (typeof value !== "string" || !ENV_VALUE.test(value))) problem(`env.${key}`, `values are plain words (no spaces, quotes or $), or null to remove one: ${JSON.stringify(value)}`)
      else if (/token|secret|password|api_?key/i.test(key)) problem(`env.${key}`, "looks like a secret: env is written into the image for anyone who boots it (build-time secrets come later)")
    }
  }

  const run = raw.run
  const steps: Array<string | Raw> = []
  if (run !== undefined) {
    if (!Array.isArray(run)) problem("run", "must be a list of shell commands")
    else run.forEach((step, i) => {
      const where = `run[${i}]`
      let command: unknown = step
      if (isObject(step)) {
        for (const key of Object.keys(step)) if (!RUN_KEYS.has(key)) problem(`${where}.${key}`, "unknown key (a step is {run, user, timeoutSeconds})")
        if (step.user !== undefined && step.user !== "root" && step.user !== "sandbox") problem(`${where}.user`, 'must be "root" or "sandbox"')
        const timeout = step.timeoutSeconds
        if (timeout !== undefined && !(typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1 && timeout <= RUN_TIMEOUT_MAX)) problem(`${where}.timeoutSeconds`, `must be a whole number of seconds, 1-${RUN_TIMEOUT_MAX}`)
        command = step.run
      }
      if (typeof command !== "string" || !command.trim()) problem(isObject(step) ? `${where}.run` : where, "must be a non-empty shell command")
      else steps.push(step as string | Raw)
    })
  }

  const build = parseBuild(raw.build, problem)
  if (raw.node !== undefined && build.network !== "open") for (const host of NODE_HOSTS) if (!build.allow.includes(host)) build.allow.push(host)
  if (build.allow.length > ALLOW_MAX) problem("build.allow", `at most ${ALLOW_MAX} hosts, with the ${NODE_HOSTS.length} node needs`)

  const files = await parseFiles(raw.files, dirname(resolve(path)), problem)
  if (raw.pnpm !== undefined && raw.node === undefined && baseMatch && ["base", "python", "rust"].includes(baseMatch[1]!)) problem("pnpm", `needs node: ${baseMatch[1]} has none, so set node too`)
  const pnpmSteps = typeof raw.pnpm === "string" ? [pnpmStep(raw.pnpm)] : []
  if (steps.length + pnpmSteps.length > RUN_MAX) problem("run", `at most ${RUN_MAX} steps${pnpmSteps.length ? " (pnpm takes one)" : ""}`)

  if (problems.length > 0) throw new SpecError(problems, path)

  const base = baseMatch![1]!
  const compiled: Record<string, unknown> = { name, base: `kyora/${base}` }
  if (typeof raw.description === "string") compiled.description = raw.description
  for (const key of ["apt", "npm", "pip", "uvTools", "cargo", "python"]) if (raw[key] !== undefined && (raw[key] as unknown[]).length > 0) compiled[key] = raw[key]
  for (const key of ["node", "bun", "uv", "rustup", "env", "salt"]) if (raw[key] !== undefined) compiled[key] = raw[key]
  if (apt.length === 0) delete compiled.apt
  const allSteps = [...pnpmSteps, ...steps]
  if (allSteps.length > 0) compiled.run = allSteps
  const root = await realpath(dirname(resolve(path))).catch(() => dirname(resolve(path)))
  return { name: name as string, description: typeof raw.description === "string" ? raw.description : "", base, compiled, files, build, path: resolve(path), root }
}

/**
 * pnpm at an exact version through corepack (node's own; /opt/corepack, where the base keeps it and
 * every exec finds it), the default for whoever runs pnpm, then left to the sandbox user as the base
 * leaves it. A project's own packageManager field still wins in that project.
 */
export function pnpmStep(version: string): { run: string; user: "root" } {
  return {
    run: [
      "command -v corepack >/dev/null || { echo 'pnpm needs corepack: set node (24 or older bundles it)' >&2; exit 1; }",
      "corepack enable pnpm",
      `corepack install -g pnpm@${version}`,
      `test "$(pnpm --version)" = "${version}"`,
      "if id sandbox >/dev/null 2>&1; then find /opt/corepack \\( ! -user sandbox -o ! -group sandbox \\) -exec chown -h sandbox:sandbox {} +; fi",
    ].join("\n"),
    user: "root",
  }
}

function parseBuild(value: unknown, problem: (field: string, message: string) => void): BuildOptions {
  const build: BuildOptions = { network: "registries", allow: [], diskGb: DEFAULT_DISK_GB, vcpus: SIZES.l!.vcpus, memoryMb: SIZES.l!.memoryMb, timeoutSeconds: DEFAULT_TIMEOUT_S }
  if (value === undefined) return build
  if (!isObject(value)) {
    problem("build", 'must be an object {network, allow, disk, size, timeout}')
    return build
  }
  for (const key of Object.keys(value)) if (!BUILD_KEYS.has(key)) problem(`build.${key}`, `unknown key (build takes ${[...BUILD_KEYS].join(", ")})`)
  if (value.network !== undefined) {
    if (value.network === "none" || value.network === "registries" || value.network === "open") build.network = value.network
    else problem("build.network", 'must be "registries" (the default), "open" or "none"')
  }
  if (value.allow !== undefined) {
    if (!Array.isArray(value.allow)) problem("build.allow", "must be a list of hostnames")
    else value.allow.forEach((host, i) => {
      if (typeof host !== "string" || !HOST.test(host.toLowerCase())) problem(`build.allow[${i}]`, `must be a hostname or *.suffix: ${JSON.stringify(host)}`)
      else build.allow.push(host.toLowerCase())
    })
    if (build.network === "open" && build.allow.length > 0) problem("build.allow", "goes with network registries or none; open allows everything")
  }
  const text = (key: string, parse: (input: string) => void) => {
    const raw = value[key]
    if (raw === undefined) return
    try {
      if (typeof raw !== "string" && typeof raw !== "number") throw new Error("must be a string")
      parse(String(raw))
    } catch (error) {
      problem(`build.${key}`, error instanceof Error ? error.message : String(error))
    }
  }
  text("disk", (input) => { build.diskGb = diskGb(input) })
  text("size", (input) => {
    const size = SIZES[input]
    if (!size) throw new Error("must be s, m, l (the default) or xl")
    build.vcpus = size.vcpus
    build.memoryMb = size.memoryMb
  })
  text("cpus", (input) => {
    const n = Number(input)
    if (!Number.isInteger(n) || n < 1) throw new Error("must be a whole number")
    build.vcpus = n
  })
  text("memory", (input) => { build.memoryMb = Math.round(Number(input.replace(/[gG]$/, "")) * 1024) || (() => { throw new Error('must be like "16G"') })() })
  text("timeout", (input) => { build.timeoutSeconds = parseSeconds(input, "build.timeout") })
  if (build.timeoutSeconds > RUN_TIMEOUT_MAX) problem("build.timeout", "at most 24h")
  return build
}

/** `path` is `root` or under it (both real paths) */
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * The spec's files, read from its directory as a build context: a path relative to the spec's
 * directory, no absolute path, no `..`, and every file's real path (links followed) inside the
 * spec's real directory. A symlink is fine while it stays inside; one that leads out is refused, so a
 * cloned repo's spec can't put ~/.ssh or a token file into an image (where a run step could send it on).
 */
async function parseFiles(value: unknown, dir: string, problem: (field: string, message: string) => void): Promise<FileEntry[]> {
  if (value === undefined) return []
  if (!isObject(value)) {
    problem("files", 'must be an object {"/path/in/image": "local/path"} (or {"from": "local/path", "mode": "0755"})')
    return []
  }
  const root = await realpath(dir).catch(() => null)
  if (root === null) {
    problem("files", `the spec's directory ${dir} can't be read`)
    return []
  }
  const entries = Object.entries(value)
  if (entries.length > FILES_MAX) problem("files", `at most ${FILES_MAX} files`)
  const files: FileEntry[] = []
  const reals = new Map<string, string>()
  for (const [path, spec] of entries) {
    const where = `files["${path}"]`
    const bad = filePathProblem(path)
    if (bad) {
      problem(where, `${path} ${bad}`)
      continue
    }
    const real = realImagePath(path)
    for (const [other, otherPath] of reals) {
      if (other === real) problem(where, `${path} and ${otherPath} are the same file`)
      else if (other.startsWith(`${real}/`) || real.startsWith(`${other}/`)) problem(where, `${path} and ${otherPath} can't both be files`)
    }
    reals.set(real, path)
    let from: unknown = spec
    let mode: unknown = "0644"
    if (isObject(spec)) {
      for (const key of Object.keys(spec)) if (key !== "from" && key !== "mode") problem(`${where}.${key}`, "unknown key (a file is a local path, or {from, mode})")
      from = spec.from
      if (spec.mode !== undefined) mode = spec.mode
    }
    if (typeof mode !== "string" || !MODE.test(mode)) {
      problem(`${where}.mode`, `must be an octal string like "0644" or "0755" (no setuid): ${JSON.stringify(mode)}`)
      continue
    }
    if (typeof from !== "string" || !from) {
      problem(where, "must be a local path, relative to the spec's directory")
      continue
    }
    if (isAbsolute(from) || from.startsWith("~") || from.split("/").includes("..")) {
      problem(where, `${from}: must be a path relative to the spec's directory, without .. (files are read from the spec's directory only)`)
      continue
    }
    const local = await realpath(resolve(root, from)).catch(() => null)
    if (local === null) {
      problem(where, `${from}: no such file, relative to the spec's directory (${dir})`)
      continue
    }
    if (!inside(local, root)) {
      problem(where, `${from} is a link to ${local}, outside the spec's directory: files are read relative to the spec's directory only`)
      continue
    }
    const info = await stat(local).catch(() => null)
    if (!info?.isFile()) {
      problem(where, `${from}: not a file, relative to the spec's directory (${dir})`)
      continue
    }
    if (info.size > FILE_MAX_BYTES) {
      problem(where, `${from} is over 1 GiB`)
      continue
    }
    // read through the real path checked above, never the name again
    const bytes = await Bun.file(local).bytes()
    files.push({ path: real, given: from, from: local, mode, sha256: sha256Hex(bytes), bytes: bytes.byteLength })
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export class FileChanged extends Error {}

/**
 * A spec file's bytes again, when the build stages it (minutes after the check): its real path must
 * still be the one checked, inside the spec's real directory (no component swapped for a link), and
 * its bytes the ones hashed into the content key. What is returned is what goes up, so nothing but
 * the checked bytes ever does. FileChanged otherwise.
 */
export async function readChecked(file: FileEntry, root: string): Promise<Uint8Array<ArrayBuffer>> {
  const changed = (why: string) => new FileChanged(`files["${file.path}"]: ${file.given} changed during the build (${why}); nothing was uploaded, run the build again`)
  const real = await realpath(file.from).catch(() => null)
  if (real === null) throw changed("it is gone")
  if (real !== file.from || !inside(real, root)) throw changed(`it now leads to ${real}, not the file checked in the spec's directory`)
  const bytes = await Bun.file(real).bytes().catch(() => null)
  if (bytes === null) throw changed("it can't be read")
  if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw changed("its content is not what was checked")
  return bytes
}

/**
 * The content key: sha256 over the canonical JSON of what decides the image's bytes. The compiled
 * spec (name and description aside: they don't change a byte), each file's path, mode and content
 * hash, the base by its fleet build (the one the builder boots), and the builder itself. Same key,
 * same inputs: the version that has it is reused instead of building again.
 */
export function contentKey(spec: Pick<ImageSpec, "compiled" | "files" | "base">, baseBuild: string, builder: string): string {
  const { name: _name, description: _description, ...content } = spec.compiled
  const doc = {
    format: KEY_FORMAT,
    base: { image: spec.base, build: baseBuild },
    spec: content,
    files: spec.files.map((file) => ({ path: file.path, mode: file.mode, sha256: file.sha256 })),
    builder,
  }
  return `sha256:${sha256Hex(canonicalJson(doc))}`
}
