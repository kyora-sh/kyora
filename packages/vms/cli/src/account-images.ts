import { stat } from "node:fs/promises"
import { CHUNK_SIZE, type ManifestChunk } from "../../shared/image-chunks"
import { cutFile, type StoredChunk } from "../../shared/image-chunks-bun"
import { ApiError, type VmsClient } from "./api"
import { pause, retryable } from "./multipart"
import { json, note, write } from "./output"
import { formatBytes } from "./units"

/**
 * `kyora-vms image push|ls|rm|usage`: account images, built once, stored
 * on the account in kyora cloud and pulled by the machines that boot them. A push cuts the file
 * into the shared chunk format (packages/vms/shared/image-chunks.ts), tells the server the whole
 * chunk list, uploads only the chunks the account doesn't hold yet, and commits.
 */

export interface AccountImage {
  id: string
  name: string
  /** each push of a name is its next version: name@1, name@2, … */
  version: number
  /** name@version */
  ref: string
  /** the content key of the build that made it (kyora-vms image build), when one did */
  specKey: string | null
  /** what it was built on, as the build said */
  base: string | null
  status: "uploading" | "ready" | "failed" | "deleted"
  region: string | null
  sha256: string
  bytes: number
  chunks: number
  dataBytes: number
  storedBytes: number
  digest: string | null
  createdAt: string | null
  readyAt: string | null
  expiresAt: string | null
  error: string | null
}

export interface ImageUsage {
  month: string
  storedBytes: number
  gbMonths: number
  usd: number
  rate: number
  images: number
  caps?: { images?: number; storedBytes?: number }
}

/** stored chunks a push keeps from its first read, so the upload needn't read and compress the file again */
const KEEP_BYTES = 256 * 1024 * 1024
const PARALLEL = 4
const RETRIES = 4

const imagePath = (id: string) => `/v1/images/${encodeURIComponent(id)}`

export interface PushOptions {
  name: string
  region?: string
  /** image build: the content key, so a build of the same inputs reuses this version */
  specKey?: string
  /** image build: what it was built on */
  base?: string
  /** progress lines (stderr in the CLI) */
  log?: (message: string) => void
  parallel?: number
  /** stored bytes kept from the first read (default 256 MiB); past it the upload reads the file again */
  keepBytes?: number
}

export interface PushResult {
  image: AccountImage
  chunks: number
  uploaded: number
  uploadedBytes: number
}

async function putChunk(api: VmsClient, id: string, chunk: StoredChunk): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await api.call("upload image chunk", "PUT", `${imagePath(id)}/chunks/${chunk.key}`, { body: chunk.stored, contentType: "application/zstd", timeout: 120_000 })
      return
    } catch (error) {
      if (attempt >= RETRIES || !retryable(error)) throw error
      await pause(500 * 2 ** attempt, new AbortController().signal)
    }
  }
}

/** Sends `chunks` at most `parallel` at once; a failure stops the rest. */
async function sendAll(api: VmsClient, id: string, chunks: StoredChunk[], parallel: number): Promise<void> {
  let next = 0
  let failure: unknown = null
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, async () => {
    while (failure === null && next < chunks.length) {
      const chunk = chunks[next++]!
      try {
        await putChunk(api, id, chunk)
      } catch (error) {
        failure ??= error
      }
    }
  }))
  if (failure !== null) throw failure
}

export async function pushImage(api: VmsClient, path: string, options: PushOptions): Promise<PushResult> {
  const log = options.log ?? (() => {})
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new ApiError(`${path} is not a file`, 0, "invalid_request")
  if (info.size === 0 || info.size % CHUNK_SIZE !== 0) {
    throw new ApiError(`${path} is ${info.size} bytes; an image is a whole number of 4 MiB chunks (pad it with zeros to the next multiple of 4194304, e.g. truncate -s)`, 0, "invalid_request")
  }
  // first read: the whole chunk list (the server needs it before anything is sent)
  const entries: ManifestChunk[] = []
  const kept = new Map<string, StoredChunk>()
  let keptBytes = 0
  let complete = true
  const first = cutFile(path)
  let whole: { sha256: string; bytes: number }
  for (;;) {
    const next = await first.next()
    if (next.done) {
      whole = next.value
      break
    }
    for (const chunk of next.value) {
      entries.push([chunk.index, chunk.sha, chunk.key, chunk.stored.byteLength])
      if (kept.has(chunk.key)) continue
      if (complete && keptBytes + chunk.stored.byteLength <= (options.keepBytes ?? KEEP_BYTES)) {
        kept.set(chunk.key, chunk)
        keptBytes += chunk.stored.byteLength
      } else {
        complete = false
        kept.clear()
        keptBytes = 0
      }
    }
  }
  const storedTotal = [...new Map(entries.map((entry) => [entry[2], entry[3]])).values()].reduce((sum, bytes) => sum + bytes, 0)
  log(`${path}: ${formatBytes(whole.bytes)}, ${entries.length} non-zero chunks, ${formatBytes(storedTotal)} compressed`)
  const begun = await api.call<{ id: string; missing: string[] }>("start image push", "POST", "/v1/images", {
    json: { name: options.name, bytes: whole.bytes, sha256: whole.sha256, chunkSize: CHUNK_SIZE, chunks: entries, ...(options.region ? { region: options.region } : {}), ...(options.specKey ? { specKey: options.specKey } : {}), ...(options.base ? { base: options.base } : {}) },
  })
  const missing = new Set(begun.missing)
  const parallel = Math.max(1, Math.min(16, options.parallel ?? PARALLEL))
  let uploaded = 0
  let uploadedBytes = 0
  const send = async (chunks: StoredChunk[]) => {
    const due = chunks.filter((chunk) => missing.delete(chunk.key))
    await sendAll(api, begun.id, due, parallel)
    uploaded += due.length
    uploadedBytes += due.reduce((sum, chunk) => sum + chunk.stored.byteLength, 0)
  }
  log(`${begun.id}: ${missing.size} of ${new Set(entries.map((entry) => entry[2])).size} chunks to upload`)
  if (missing.size > 0 && complete) await send([...kept.values()])
  else if (missing.size > 0) {
    // too big to keep: read it again, and only the chunks the server asked for go
    const byIndex = new Map(entries.map((entry) => [entry[0], entry]))
    const again = cutFile(path)
    try {
      for (;;) {
        const next = await again.next()
        if (next.done) {
          if (next.value.sha256 !== whole.sha256) throw new ApiError(`${path} changed while it was pushed; not committing`, 0, "image_changed")
          break
        }
        for (const chunk of next.value) {
          if (byIndex.get(chunk.index)?.[2] !== chunk.key) throw new ApiError(`${path} changed while it was pushed; not committing`, 0, "image_changed")
        }
        await send(next.value)
        if (missing.size === 0) break
      }
    } finally {
      // left early (all sent, or a failure): the generator's own finally closes the file
      await again.return({ sha256: "", bytes: 0 })
    }
  }
  if (missing.size > 0) throw new ApiError(`${missing.size} chunk(s) the server asked for are not in ${path}`, 0, "image_changed")
  const image = await api.call<AccountImage>("commit image", "POST", `${imagePath(begun.id)}/commit`, { json: {} })
  log(`${image.ref ?? image.id} (${image.id}): ${image.status}, ${uploaded} chunks uploaded (${formatBytes(uploadedBytes)})`)
  return { image, chunks: entries.length, uploaded, uploadedBytes }
}

export async function listAccountImages(api: VmsClient): Promise<AccountImage[]> {
  const listed = await api.call<{ account?: AccountImage[] }>("list images", "GET", "/v1/images", { timeout: 30_000 })
  return listed.account ?? []
}

export async function imageUsage(api: VmsClient): Promise<ImageUsage> {
  return api.call<ImageUsage>("image usage", "GET", "/v1/images/usage", { timeout: 30_000 })
}

export async function removeImage(api: VmsClient, id: string): Promise<void> {
  await api.call("delete image", "DELETE", imagePath(id), { accept: [204], timeout: 30_000 })
}

const IMAGE_ID = /^img_[A-Za-z0-9_-]{8,64}$/
export const isImageId = (value: string): boolean => IMAGE_ID.test(value)

export interface ImageCommandValues {
  name?: string
  region?: string
}

const USAGE = `usage: kyora-vms image build [kyora.image.json] [--name N] [--region R] [--json]
       kyora-vms image lock [kyora.image.json] [--name N]        pin the newest version in kyora.image.lock
       kyora-vms image ls | versions <name> | rm <name@N|img_…> | usage
       kyora-vms image push <file.ext4> --name N [--region R]`

/** an account's images by name: the newest ready version, how many, their regions */
export function imageGroups(images: AccountImage[]): Array<{ name: string; latest: AccountImage | null; versions: number; regions: string[]; pending: number }> {
  const names = [...new Set(images.map((image) => image.name))].sort()
  return names.map((name) => {
    const all = images.filter((image) => image.name === name)
    const ready = all.filter((image) => image.status === "ready").sort((a, b) => b.version - a.version)
    return {
      name,
      latest: ready[0] ?? null,
      versions: ready.length,
      regions: [...new Set(ready.map((image) => image.region ?? "-"))].sort(),
      pending: all.length - ready.length,
    }
  })
}

const ago = (iso: string | null) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "")

/** `kyora-vms image …`; `usage` throws the CLI's usage error */
export async function imageCommand(api: VmsClient, positionals: string[], values: ImageCommandValues, asJson: boolean, usage: (message: string) => never): Promise<number> {
  const [sub, arg, extra] = positionals
  const line = (text: string) => write(process.stdout, `${text}\n`)
  switch (sub) {
    case "build": {
      if (extra) usage(USAGE)
      const { buildCommand } = await import("./image-commands")
      return buildCommand(api, { spec: arg, name: values.name, region: values.region, json: asJson }, usage)
    }
    case "lock": {
      if (extra || values.region) usage("usage: kyora-vms image lock [kyora.image.json] [--name N]")
      const { lockCommand } = await import("./image-commands")
      return lockCommand(api, { spec: arg, name: values.name, json: asJson }, usage)
    }
    case "versions": {
      if (!arg || extra || values.name || values.region) usage("usage: kyora-vms image versions <name>")
      const versions = (await listAccountImages(api)).filter((image) => image.name === arg).sort((a, b) => b.version - a.version)
      if (asJson) await json({ name: arg, versions })
      else if (versions.length === 0) note(`no versions of ${arg} in this account (kyora-vms image ls)`)
      else for (const image of versions) await line(`${image.ref}  ${image.status}  ${image.region ?? "-"}  ${formatBytes(image.bytes)}  sha256:${image.sha256.slice(0, 12)}  ${image.id}  ${ago(image.readyAt ?? image.createdAt)}${image.base ? `  on ${image.base}` : ""}`)
      return 0
    }
    case "push": {
      if (!arg || extra) usage("usage: kyora-vms image push <file.ext4> --name <name> [--region <id>]")
      if (!values.name || !/^[a-z][a-z0-9-]{0,63}$/.test(values.name)) usage("image push needs --name: 1-64 characters of a-z, 0-9 and -, starting with a letter")
      const pushed = await pushImage(api, arg, { name: values.name, ...(values.region ? { region: values.region } : {}), log: asJson ? undefined : note })
      if (asJson) await json({ ...pushed.image, uploaded: pushed.uploaded, uploadedBytes: pushed.uploadedBytes })
      else await line(pushed.image.ref ?? pushed.image.id)
      return 0
    }
    case "ls":
    case "list": {
      if (arg || values.name || values.region) usage("usage: kyora-vms image ls")
      const images = await listAccountImages(api)
      if (asJson) await json({ images, names: imageGroups(images).map(({ latest, ...group }) => ({ ...group, latest: latest?.ref ?? null, sizeBytes: latest?.bytes ?? null })) })
      else {
        const groups = imageGroups(images)
        if (groups.length === 0) note("no images in this account yet: kyora-vms image build")
        for (const group of groups) {
          const latest = group.latest
          await line(`${group.name}  ${latest ? latest.ref : "-"}  ${group.versions} version${group.versions === 1 ? "" : "s"}  ${latest ? formatBytes(latest.bytes) : "-"}  ${group.regions.join(",") || "-"}${group.pending ? `  (${group.pending} not ready)` : ""}`)
        }
      }
      return 0
    }
    case "rm":
    case "delete": {
      if (!arg || extra || values.name || values.region) usage("usage: kyora-vms image rm <name@N|img_…>")
      let id = arg
      if (!isImageId(arg)) {
        const { findVersion, isPinnedRef } = await import("./image-refs")
        if (!isPinnedRef(arg)) usage(`image rm takes one version: name@N or img_… (kyora-vms image versions ${arg}), got ${JSON.stringify(arg)}`)
        const found = findVersion(await listAccountImages(api), arg)
        if (!found) throw new ApiError(`no such image: ${arg} (kyora-vms image versions)`, 404, "image_not_found")
        id = found.id
      }
      await removeImage(api, id)
      if (asJson) await json({ deleted: id, ref: arg })
      return 0
    }
    case "usage": {
      if (arg || values.name || values.region) usage("usage: kyora-vms image usage")
      const used = await imageUsage(api)
      if (asJson) await json(used)
      else await line(`${used.month}: ${formatBytes(used.storedBytes)} stored in ${used.images} image(s), ${used.gbMonths.toFixed(4)} GB-months so far, $${used.usd.toFixed(4)} at $${used.rate}/GB-month`)
      return 0
    }
  }
  return usage(USAGE)
}
