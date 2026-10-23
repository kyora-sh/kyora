import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ApiError, type CreateSpec, type ExecRequest, type Sandbox, type VmsClient } from "./api"
import { pushImage, type AccountImage, type PushOptions } from "./account-images"
import { collectExec, runExec } from "./exec"
import { BUILDER_FILES, BUILDER_HASH } from "./image-builder-assets"
import { digestOf, refOf } from "./image-refs"
import { checkSpec, contentKey, FileChanged, loadSpec, readChecked, type ImageSpec } from "./image-spec"
import { FAILED } from "./output"
import { pull, push } from "./transfer"
import { formatBytes, formatMs } from "./units"

/**
 * `kyora vms image build [kyora.image.json]`: one command from a spec in a
 * repo to a pinned account image, `name@N`. Orchestrated by the CLI with what kyora cloud has today:
 *
 *   1. the spec is checked and compiled here, and its files hashed: a mistake costs no sandbox;
 *   2. the content key (spec, files, the base's fleet build, the builder) is looked up among the
 *      account's versions of the name: a match is that version, at once (`cached`);
 *   3. else a throwaway builder sandbox boots the base itself, in the image's region; the builder
 *      (carried in the CLI) and the spec's files go up, and kyora-image-build builds against the
 *      sandbox's own read-only root as --base, its log streamed here;
 *   4. the image comes down to this machine and is pushed as the name's next version, with its key;
 *   5. the builder is destroyed whatever happened.
 *
 * Pushing from here rather than from inside the sandbox: no credential of the account ever enters a
 * sandbox the spec's own steps ran in as root (a chroot is no boundary), and the push is the tested
 * one (`image push`: only chunks the account lacks go up). It costs the image's bytes down to this
 * machine once.
 */

/** where the builder and the spec's files go in the builder sandbox, and what it builds there */
export const REMOTE_DIR = "/work/.kyora-image-build"
export const OUTPUT = "/work/rootfs.ext4"
/** a build's own room: the image is at most this big */
const MAX_ROOT_GB = 48
/** what the sandbox lives past the build: the download of the image */
const TTL_MARGIN_S = 3600

export interface BuildResult {
  ref: string
  name: string
  version: number
  digest: string
  region: string | null
  sizeBytes: number
  storedBytes: number
  durationMs: number
  cached: boolean
  id: string
  key: string
  base: string
}

/** what a failed build exits with: 2 a spec the builder refused, 1 a build that failed, 125 kyora itself */
export class BuildFailure extends Error {
  constructor(message: string, readonly code: number, readonly reason: string) {
    super(message)
  }
}

/** what the build needs from kyora cloud: the real one is apiBackend, the tests' a fake */
export interface BuildBackend {
  /** where a create that names no region goes for this account */
  defaultRegion(): Promise<string | null>
  /** the builds of a fleet image the region's machines boot it from (empty: kyora cloud doesn't say) */
  fleetBuilds(image: string, region: string | null): Promise<string[]>
  accountImages(): Promise<AccountImage[]>
  createSandbox(spec: CreateSpec): Promise<Sandbox>
  /** a local directory's files into the sandbox at `dest` */
  upload(id: string, dir: string, dest: string): Promise<void>
  /** a short command, its output kept */
  run(id: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** a long command, its output handed over as it comes */
  stream(id: string, request: ExecRequest, output: (stream: "stdout" | "stderr", text: string) => void): Promise<{ code: number; error: string | null }>
  /** a sandbox file into `to`; the local path */
  download(id: string, path: string, to: string): Promise<string>
  push(path: string, options: PushOptions): Promise<AccountImage>
  destroy(id: string): Promise<void>
}

export interface BuildOptions {
  specPath: string
  /** a spec made here rather than read from specPath (`--from`): checked the same way, specPath naming it */
  raw?: Record<string, unknown>
  name?: string
  region?: string
  /** progress (stderr in the CLI) */
  log: (line: string) => void
  signal?: AbortSignal
  now?: () => number
  /** where the image is downloaded to (a fresh temporary directory by default) */
  scratch?: string
}

/** the builder's NDJSON log, a line at a time, as people read it */
export function renderLog(line: string): { text: string | null; result?: Record<string, unknown> } {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { text: line }
  }
  if (typeof record !== "object" || record === null) return { text: line }
  if ("fsBytes" in record || "error" in record) return { text: null, result: record }
  const data = typeof record.data === "string" ? record.data : ""
  if (record.stream === "sys") return { text: `==> ${data}` }
  const phase = typeof record.phase === "string" ? record.phase : "build"
  const step = typeof record.step === "number" ? ` ${record.step}` : ""
  return { text: `[${phase}${step}] ${data}` }
}

/** splits a stream's chunks into whole lines */
function lines(each: (line: string) => void): { push: (text: string) => void; end: () => void } {
  let rest = ""
  return {
    push(text) {
      rest += text
      let at: number
      while ((at = rest.indexOf("\n")) !== -1) {
        each(rest.slice(0, at))
        rest = rest.slice(at + 1)
      }
    },
    end() {
      if (rest) each(rest)
      rest = ""
    },
  }
}

/** the script the builder sandbox runs as root: the base (its own root, the spec's files over it) and the build */
export function driverScript(spec: ImageSpec, options: { timeoutSeconds: number; maxRootGb: number }): string {
  const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  return `#!/bin/bash
# kyora vms image build, in the builder sandbox, as root (packages/vms/cli/src/image-build.ts)
set -euo pipefail
B=${REMOTE_DIR}
S=/mnt/scratch/kyora-image-build
R=/run/kyora-image-build
undo() {
  local m
  for m in "$R/base" "$R/root"; do
    if mountpoint -q "$m"; then umount "$m" 2>/dev/null || umount -l "$m" || true; fi
  done
}
trap undo EXIT
undo
rm -rf "$S" "${OUTPUT}"
mkdir -p "$S" "$R/root" "$R/base"
# the base is this sandbox's own image: its root file system, read-only, without the overlays and
# mounts the sandbox runs with (a bind of / alone)
mount --bind / "$R/root"
mount -o remount,bind,ro "$R/root"
base="$R/root"
if [[ -s $B/files.list ]]; then
  # the spec's files, root's, as a layer over the base: in the image at their paths, and there for the steps
  mkdir -p "$S/files"
  while read -r index mode path; do
    sub=""
    IFS=/ read -r -a parts <<<"\${path#/}"
    for part in "\${parts[@]:0:\${#parts[@]}-1}"; do
      sub="$sub/$part"
      if [[ -L $R/root$sub ]]; then echo "files: $path: $sub is a link in the base; give the path it points to" >&2; exit 2; fi
      if [[ -e $R/root$sub && ! -d $R/root$sub ]]; then echo "files: $path: $sub is a file in the base" >&2; exit 2; fi
    done
    install -D -o root -g root -m "$mode" "$B/files/$index" "$S/files$path"
  done <"$B/files.list"
  find "$S/files" -type d -exec chown root:root {} + -exec chmod 0755 {} +
  mount -t overlay overlay -o "ro,lowerdir=$S/files:$R/root" "$R/base"
  base="$R/base"
fi
cd /
KYORA_IMAGE_LIB="$B/lib" python3 -B "$B/kyora-image-build" --spec "$B/spec.json" --base "$base" --output ${OUTPUT} \\
  --work "$S/build" --name ${q(spec.name)} --base-ref ${q(`kyora/${spec.base}`)} --timeout ${options.timeoutSeconds} --max-root-gb ${options.maxRootGb}
chmod 0644 ${OUTPUT}
`
}

/** the directory that goes up: the builder, the compiled spec, the files and the driver */
async function stage(spec: ImageSpec, dir: string, script: string): Promise<void> {
  for (const [path, file] of Object.entries(BUILDER_FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), file.text)
    await chmod(join(dir, path), file.mode)
  }
  await writeFile(join(dir, "spec.json"), `${JSON.stringify(spec.compiled, null, 2)}\n`)
  await mkdir(join(dir, "files"), { recursive: true })
  await writeFile(join(dir, "files.list"), spec.files.map((file, i) => `${i} ${file.mode} ${file.path}\n`).join(""))
  // the bytes checked and hashed into the key, read again through the checked path: a file edited, or a
  // path that now leads out of the spec's directory, stops the build before anything goes up
  for (const [i, file] of spec.files.entries()) {
    try {
      await Bun.write(join(dir, "files", String(i)), await readChecked(file, spec.root))
    } catch (error) {
      if (error instanceof FileChanged) throw new BuildFailure(error.message, 2, "file_changed")
      throw error
    }
  }
  await writeFile(join(dir, "build.sh"), script)
  await chmod(join(dir, "build.sh"), 0o755)
}

const builderName = (name: string) => `build-${name.slice(0, 18).replace(/-+$/, "")}-${Math.random().toString(36).slice(2, 7)}`

function resultOf(image: AccountImage, started: number, now: number, cached: boolean, key: string, base: string): BuildResult {
  return {
    ref: refOf(image),
    name: image.name,
    version: image.version,
    digest: digestOf(image),
    region: image.region,
    sizeBytes: image.bytes,
    storedBytes: image.storedBytes,
    durationMs: now - started,
    cached,
    id: image.id,
    key,
    base,
  }
}

/** the account's ready version of `name` with this key in `region`, newest first */
function cachedVersion(images: AccountImage[], name: string, keys: string[], region: string | null): AccountImage | null {
  return images
    .filter((image) => image.name === name && image.status === "ready" && image.specKey !== null && keys.includes(image.specKey) && (region === null || image.region === region))
    .sort((a, b) => b.version - a.version)[0] ?? null
}

export async function buildImage(backend: BuildBackend, options: BuildOptions): Promise<BuildResult> {
  const now = options.now ?? Date.now
  const started = now()
  const log = options.log
  const overrides = options.name ? { name: options.name } : {}
  const spec = options.raw ? await checkSpec(options.raw, options.specPath, overrides) : await loadSpec(options.specPath, overrides)
  const region = options.region ?? (await backend.defaultRegion())
  log(`${spec.name}: base ${spec.base}, ${spec.files.length} file(s), in ${region ?? "your default region"}`)

  // a version built from these inputs on one of the builds the region boots the base from is this build
  const builds = await backend.fleetBuilds(spec.base, region)
  const images = await backend.accountImages()
  const known = cachedVersion(images, spec.name, builds.map((build) => contentKey(spec, build, BUILDER_HASH)), region)
  if (known) {
    log(`${refOf(known)} has the same spec, files and base: reusing it (cached)`)
    return resultOf(known, started, now(), true, known.specKey!, known.base ?? spec.base)
  }

  const scratch = options.scratch ?? await mkdtemp(join(tmpdir(), "kyora-image-build-"))
  let sandbox: Sandbox | null = null
  try {
    const build = spec.build
    sandbox = await backend.createSandbox({
      name: builderName(spec.name),
      image: spec.base,
      ...(region ? { region } : {}),
      vcpus: build.vcpus,
      memoryMb: build.memoryMb,
      diskGb: build.diskGb,
      network: build.network,
      ...(build.allow.length > 0 && build.network !== "open" ? { egressAllow: build.allow } : {}),
      ttlSeconds: build.timeoutSeconds + TTL_MARGIN_S,
      idleSeconds: 0,
      labels: { "image-build": spec.name },
    })
    log(`builder ${sandbox.id}${sandbox.region ? ` in ${sandbox.region}` : ""}: ${build.vcpus} vCPUs, ${build.memoryMb / 1024} GiB, ${build.diskGb} GB disk, network ${build.network}`)

    // the base, as the sandbox booted it: its fleet build is the key's
    const manifest = await backend.run(sandbox.id, ["cat", "/etc/kyora-image.json"])
    let baseBuild: string | null = null
    try {
      const id = (JSON.parse(manifest.stdout) as { id?: unknown }).id
      if (typeof id === "string" && id) baseBuild = id
    } catch {}
    if (manifest.code !== 0 || !baseBuild) throw new BuildFailure(`the builder's base (${spec.base}) has no /etc/kyora-image.json with an id: not a kyora image?`, FAILED, "base_invalid")
    const key = contentKey(spec, baseBuild, BUILDER_HASH)
    const base = `${spec.base}@${baseBuild}`
    const again = cachedVersion(images, spec.name, [key], region)
    if (again) {
      log(`${refOf(again)} has the same spec, files and base (${baseBuild}): reusing it (cached)`)
      return resultOf(again, started, now(), true, key, base)
    }
    log(`base ${base}, key ${key.slice(0, 19)}…`)

    const local = join(scratch, "upload")
    await mkdir(local, { recursive: true })
    await stage(spec, local, driverScript(spec, { timeoutSeconds: build.timeoutSeconds, maxRootGb: Math.min(MAX_ROOT_GB, Math.max(4, build.diskGb - 8)) }))
    await backend.upload(sandbox.id, local, REMOTE_DIR)

    let result: Record<string, unknown> | null = null
    const out = lines((line) => {
      const rendered = renderLog(line)
      if (rendered.result) result = rendered.result
      if (rendered.text !== null) log(rendered.text)
    })
    const err = lines((line) => log(line))
    const buildStarted = now()
    const outcome = await backend.stream(sandbox.id, { cmd: ["sudo", "-n", "/bin/bash", `${REMOTE_DIR}/build.sh`], cwd: "/work", timeoutSeconds: build.timeoutSeconds + 300 }, (stream, text) => (stream === "stdout" ? out : err).push(text))
    out.end()
    err.end()
    const finished = result as Record<string, unknown> | null
    if (outcome.code !== 0 || !finished || "error" in finished) {
      const error = (finished?.error ?? null) as { code?: string; message?: string; field?: string } | null
      const reason = error?.code ?? (outcome.error ? "exec_failed" : "build_failed")
      const why = error?.message ?? outcome.error ?? `the build exited ${outcome.code}`
      throw new BuildFailure(`build failed: ${reason}${error?.field ? ` (${error.field})` : ""}: ${why}`, outcome.code === 2 || reason === "invalid_spec" ? 2 : outcome.code === 124 ? 124 : 1, reason)
    }
    const fsBytes = Number(finished.fsBytes)
    log(`built ${formatBytes(fsBytes)} in ${formatMs(now() - buildStarted)}; downloading it`)

    const path = await backend.download(sandbox.id, OUTPUT, scratch)
    const image = await backend.push(path, { name: spec.name, ...(region ? { region } : {}), specKey: key, base, log })
    return resultOf(image, started, now(), false, key, base)
  } finally {
    if (sandbox) {
      try {
        await backend.destroy(sandbox.id)
        log(`builder ${sandbox.id} destroyed`)
      } catch (error) {
        log(`could not destroy the builder ${sandbox.id} (${error instanceof Error ? error.message : String(error)}): kyora vms rm ${sandbox.id}`)
      }
    }
    if (!options.scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** the build against kyora cloud */
export function apiBackend(api: VmsClient, signal?: AbortSignal): BuildBackend {
  return {
    async defaultRegion() {
      try {
        return (await api.regions()).you.region ?? null
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return null
        throw error
      }
    },
    async fleetBuilds(image, region) {
      const response = await api.images()
      const listed = (await response.json()) as { images?: Array<{ name: string; regions?: Array<{ region: string; builds?: unknown }> }> }
      const entry = listed.images?.find((candidate) => candidate.name === image)
      const regions = (entry?.regions ?? []).filter((candidate) => region === null || candidate.region === region)
      return [...new Set(regions.flatMap((candidate) => (Array.isArray(candidate.builds) ? candidate.builds.filter((build): build is string => typeof build === "string") : [])))]
    },
    async accountImages() {
      const listed = await api.call<{ account?: AccountImage[] }>("list images", "GET", "/v1/images", { timeout: 30_000 })
      return listed.account ?? []
    },
    createSandbox: (spec) => api.create(spec, { wait: 15 * 60, signal }),
    async upload(id, dir, dest) {
      await push(api, id, { dir, git: false }, dest, { signal })
    },
    async run(id, cmd) {
      const outcome = await collectExec(await api.exec(id, { cmd, cwd: "/work", timeoutSeconds: 60 }, signal))
      api.execExited(id)
      return { code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr }
    },
    async stream(id, request, output) {
      const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() }
      const outcome = await runExec(api, id, request, {
        json: false,
        signal,
        output: (stream, data) => output(stream, typeof data === "string" ? data : decoder[stream].decode(data, { stream: true })),
      })
      return { code: outcome.code, error: outcome.error }
    },
    async download(id, path, to) {
      await pull(api, id, path, to, signal)
      return join(to, path.slice("/work/".length))
    },
    push: (path, options) => pushImage(api, path, options).then((pushed) => pushed.image),
    async destroy(id) {
      await api.destroy(id)
    },
  }
}
