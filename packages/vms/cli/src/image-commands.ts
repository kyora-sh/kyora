import { dirname, resolve } from "node:path"
import { ACCOUNT_IMAGE_NAME } from "../../shared/image-chunks"
import { ApiError, type VmsClient } from "./api"
import { listAccountImages } from "./account-images"
import { apiBackend, buildImage, BuildFailure } from "./image-build"
import { findVersion, writeLock } from "./image-refs"
import { SPEC_FILE, SpecError } from "./image-spec"
import { Interrupt } from "./interrupt"
import { failureCode, json, note, write } from "./output"
import { formatBytes, formatMs } from "./units"

/** `kyora vms image build [spec] [--name N] [--region R] [--json]`: 0 built or reused, 1 the build failed, 2 a bad spec, 125 kyora failed */
export async function buildCommand(api: VmsClient, options: { spec?: string; name?: string; region?: string; json: boolean }, usage: (message: string) => never): Promise<number> {
  if (options.name !== undefined && !ACCOUNT_IMAGE_NAME.test(options.name)) usage("--name takes 1-64 lowercase letters, digits and dashes, a letter first")
  const specPath = resolve(options.spec ?? SPEC_FILE)
  const interrupt = new Interrupt()
  try {
    const result = await buildImage(apiBackend(api, interrupt.signal), {
      specPath,
      ...(options.name ? { name: options.name } : {}),
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
