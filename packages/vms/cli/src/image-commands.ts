import { dirname, join, resolve } from "node:path"
import { KYORA_YML_MAX_BYTES, KYORA_YML_PATHS, PACKAGE, parseKyoraYml, toImageJson, type CiImageSpec, type KyoraYml } from "../../shared/ci-image-spec"
import { ACCOUNT_IMAGE_NAME } from "../../shared/image-chunks"
import { ApiError, type VmsClient } from "./api"
import { listAccountImages } from "./account-images"
import { apiBackend, buildImage, BuildFailure } from "./image-build"
import { findVersion, writeLock } from "./image-refs"
import { SPEC_FILE, SpecError } from "./image-spec"
import { Interrupt } from "./interrupt"
import { failureCode, json, note, write } from "./output"
import { formatBytes, formatMs } from "./units"

export interface FromOptions {
  /** a kyora image to build on, e.g. gha-runner */
  from?: string
  /** a setup script, run as root with bash -euo pipefail */
  file?: string
  packages?: string[]
}

/**
 * `image build <name> --from <base>`: the spec a kyora.yml's `image:` makes (packages/vms/shared/ci-image-spec.ts),
 * from a setup script and packages, as a kyora.image.json.
 */
export async function fromSpec(name: string, options: FromOptions, usage: (message: string) => never): Promise<Record<string, unknown>> {
  const packages = options.packages ?? []
  for (const item of packages) if (!PACKAGE.test(item)) usage(`--package takes an Ubuntu package name: ${JSON.stringify(item)}`)
  if (options.file === undefined && packages.length === 0) usage("image build --from needs what to add to the base: --file setup.sh or --package P")
  let setup: string | null = null
  if (options.file !== undefined) {
    const file = Bun.file(options.file)
    if (!(await file.exists())) usage(`--file ${options.file}: no such file`)
    setup = await file.text()
  }
  const spec: CiImageSpec = { packages, setup }
  return { ...toImageJson(spec, options.from!, { name }) }
}

/**
 * `kyora vms image check [dir]`: what CI makes of <dir>/.github/kyora.yml, each warning on its own line;
 * 0 when nothing is refused (warnings may remain), 1 when CI ignores the file or an image in it, 2 no file
 */
export async function checkCommand(options: { dir?: string; json: boolean }): Promise<number> {
  const dir = resolve(options.dir ?? ".")
  let file: string | undefined
  for (const path of KYORA_YML_PATHS) if (file === undefined && (await Bun.file(join(dir, path)).exists())) file = path
  if (file === undefined) {
    note(`image check: no ${KYORA_YML_PATHS.join(" or ")} in ${dir}`)
    return 2
  }
  const refused: string[] = []
  let parsed: KyoraYml
  try {
    // bytes as CI reads them: a BOM stays and counts toward the cap
    const bytes = await Bun.file(join(dir, file)).slice(0, KYORA_YML_MAX_BYTES + 1).arrayBuffer()
    parsed = parseKyoraYml(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), refused)
  } catch (error) {
    refused.push("kyora.yml")
    parsed = { spec: null, ref: null, packages: [], labels: {}, warnings: [`kyora.yml: can't be read (${error instanceof Error ? error.message : String(error)})`] }
  }
  if (options.json) await json({ file, ok: refused.length === 0, refused, ...parsed })
  else {
    for (const warning of parsed.warnings) await write(process.stdout, `${file}: ${warning}\n`)
    if (refused.length > 0) await write(process.stdout, `${file}: refused ${refused.join(", ")}\n`)
    else if (parsed.warnings.length === 0) await write(process.stdout, `${file}: ok\n`)
  }
  return refused.length === 0 ? 0 : 1
}

/**
 * `kyora vms image build [spec] [--name N] [--region R] [--json]`, or `image build <name> --from <base> [--file F] [--package P]...`:
 * 0 built or reused, 1 the build failed, 2 a bad spec, 125 kyora failed
 */
export async function buildCommand(api: VmsClient, options: { spec?: string; name?: string; region?: string; json: boolean } & FromOptions, usage: (message: string) => never): Promise<number> {
  if (options.name !== undefined && !ACCOUNT_IMAGE_NAME.test(options.name)) usage("--name takes 1-64 lowercase letters, digits and dashes, a letter first")
  let specPath = resolve(options.spec ?? SPEC_FILE)
  let raw: Record<string, unknown> | undefined
  let name = options.name
  if (options.from !== undefined) {
    // the positional is the image's name here, not a spec
    if (options.spec !== undefined && name !== undefined && options.spec !== name) usage(`image build --from: the name is ${options.spec} or --name ${name}, not both`)
    name = name ?? options.spec
    if (name === undefined) usage("image build --from needs the image's name: kyora vms images build <name> --from gha-runner --file setup.sh")
    if (!ACCOUNT_IMAGE_NAME.test(name)) usage("the image's name is 1-64 lowercase letters, digits and dashes, a letter first")
    raw = await fromSpec(name, options, usage)
    specPath = `--from ${options.from}`
  } else if (options.file !== undefined || (options.packages ?? []).length > 0) usage("--file and --package go with --from <base>, e.g. --from gha-runner")
  const interrupt = new Interrupt()
  try {
    const result = await buildImage(apiBackend(api, interrupt.signal), {
      specPath,
      ...(raw ? { raw } : {}),
      ...(name ? { name } : {}),
      ...(options.region ? { region: options.region } : {}),
      log: note,
      signal: interrupt.signal,
    })
    if (options.json) {
      const { ref, name, version, digest, region, sizeBytes, storedBytes, durationMs, cached, id, key, base } = result
      await json({ ref, name, version, digest, region, sizeBytes, storedBytes, durationMs, cached, id, key, base })
    } else {
      note(`${result.ref}${result.cached ? " (cached)" : ""}: ${formatBytes(result.sizeBytes)}, ${result.digest.slice(0, 19)}…, in ${result.region ?? "-"}, ${formatMs(result.durationMs)}; boot it with kyora vms create --image ${result.ref}`)
      await write(process.stdout, `${result.ref}\n`)
    }
    return 0
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    if (error instanceof SpecError) {
      note(error.message)
      return 2
    }
    if (error instanceof BuildFailure) {
      note(error.message)
      return error.code
    }
    note(error instanceof Error ? error.message : String(error))
    return failureCode(error)
  } finally {
    interrupt.dispose()
  }
}

/** `kyora vms image lock [spec] [--name N]`: the spec's name's newest version, pinned in kyora.image.lock next to the spec */
export async function lockCommand(api: VmsClient, options: { spec?: string; name?: string; json: boolean }, usage: (message: string) => never): Promise<number> {
  const specPath = resolve(options.spec ?? SPEC_FILE)
  let name = options.name
  if (name === undefined) {
    const file = Bun.file(specPath)
    if (!(await file.exists())) usage(`image lock: no ${specPath}; give the spec, or --name`)
    try {
      const raw = JSON.parse(await file.text()) as { name?: unknown }
      if (typeof raw.name === "string") name = raw.name
    } catch {
      usage(`image lock: ${specPath} is not JSON`)
    }
  }
  if (!name || !ACCOUNT_IMAGE_NAME.test(name)) usage("image lock: the spec has no image name; pass --name")
  const latest = findVersion(await listAccountImages(api), name)
  if (!latest) throw new ApiError(`no ready version of ${name} in this account: kyora vms image build first`, 404, "image_not_found")
  const path = await writeLock(dirname(specPath), latest)
  if (options.json) await json({ lock: path, name, ref: latest.ref, version: latest.version, digest: `sha256:${latest.sha256}`, id: latest.id, region: latest.region })
  else note(`${path}: ${name} pinned to ${latest.ref} (sha256:${latest.sha256.slice(0, 12)}…)`)
  return 0
}
