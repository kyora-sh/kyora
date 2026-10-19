import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ACCOUNT_IMAGE_ID, ACCOUNT_IMAGE_NAME, ACCOUNT_IMAGE_REF, isReservedAccountImageName } from "../../shared/image-chunks"
import type { AccountImage } from "./account-images"
import { LOCK_FILE } from "./image-spec"

/**
 * Account image refs, as `create --image`, `image rm` and `image lock` take them: `img_…`, `name`
 * (the newest version), `name@N` (the Nth push of the name) and `name@sha256:<hex>` (the newest
 * version with those bytes: the sha256 of the image file). kyora cloud resolves them the same way,
 * within the caller's own
 * account or org; another account's image is never found.
 */

export interface ParsedRef {
  name: string
  version?: number
  sha256?: string
}

export function parseRef(text: string): ParsedRef | null {
  const pinned = ACCOUNT_IMAGE_REF.exec(text)
  if (pinned) return { name: pinned[1]!, ...(pinned[2] !== undefined ? { version: Number(pinned[2]) } : { sha256: pinned[3]! }) }
  return ACCOUNT_IMAGE_NAME.test(text) ? { name: text } : null
}

/** `img_…`, `name@N` or `name@sha256:…`: only ever an account image */
export const isPinnedRef = (text: string): boolean => ACCOUNT_IMAGE_ID.test(text) || ACCOUNT_IMAGE_REF.test(text)

export const refOf = (image: Pick<AccountImage, "name" | "version">): string => `${image.name}@${image.version}`
export const digestOf = (image: Pick<AccountImage, "sha256">): string => `sha256:${image.sha256}`

/** the version a ref names among an account's images (ready ones), or null: the server's rules, for listing and deleting */
export function findVersion(images: AccountImage[], ref: string, region?: string): AccountImage | null {
  if (ACCOUNT_IMAGE_ID.test(ref)) return images.find((image) => image.id === ref) ?? null
  const parsed = parseRef(ref)
  if (!parsed) return null
  const candidates = images
    .filter((image) => image.name === parsed.name && image.status === "ready")
    .filter((image) => (parsed.version === undefined || image.version === parsed.version) && (parsed.sha256 === undefined || image.sha256 === parsed.sha256))
    .sort((a, b) => b.version - a.version)
  if (parsed.version !== undefined || region === undefined) return candidates[0] ?? null
  return candidates.find((image) => image.region === region) ?? candidates[0] ?? null
}

// ── kyora.image.lock ──────────────────────────────────────────────────────────

export interface LockEntry {
  /** name@N: what `create --image <name>` boots while the lock is there */
  ref: string
  version: number
  /** sha256 of the image file */
  digest: string
  id: string
  region: string | null
  lockedAt: string
}

export interface Lock {
  lockVersion: 1
  images: Record<string, LockEntry>
}

const isEntry = (value: unknown): value is LockEntry => {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.ref === "string" && ACCOUNT_IMAGE_REF.test(entry.ref)
}

/** the lock in `dir`, or null when there is none; a lock that isn't one is an error, never ignored (sync: create's options are) */
export function readLock(dir: string): Lock | null {
  const path = join(dir, LOCK_FILE)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(`${join(dir, LOCK_FILE)} is not JSON: fix it, or run kyora-vms image lock again`)
  }
  const images = typeof raw === "object" && raw !== null ? (raw as { images?: unknown }).images : undefined
  if (typeof images !== "object" || images === null || !Object.values(images).every(isEntry)) {
    throw new Error(`${join(dir, LOCK_FILE)} is not an image lock ({"lockVersion": 1, "images": {name: {ref, …}}}): run kyora-vms image lock again`)
  }
  return { lockVersion: 1, images: images as Record<string, LockEntry> }
}

/** pins `image` under its name in `dir`'s lock, keeping every other name's pin; the path written */
export async function writeLock(dir: string, image: AccountImage, now = new Date()): Promise<string> {
  const lock = readLock(dir) ?? { lockVersion: 1 as const, images: {} }
  lock.images[image.name] = { ref: refOf(image), version: image.version, digest: digestOf(image), id: image.id, region: image.region, lockedAt: now.toISOString() }
  const sorted = Object.fromEntries(Object.entries(lock.images).sort(([a], [b]) => (a < b ? -1 : 1)))
  const path = join(dir, LOCK_FILE)
  await Bun.write(path, `${JSON.stringify({ lockVersion: 1, images: sorted }, null, 2)}\n`)
  return path
}

/**
 * What `--image` boots: a bare name the lock in `dir` pins becomes the locked ref (said on
 * stderr); everything else is as given. A fleet name is never looked up.
 */
export function lockedImage(image: string, dir: string, note: (message: string) => void): string {
  if (!ACCOUNT_IMAGE_NAME.test(image) || isReservedAccountImageName(image)) return image
  const lock = readLock(dir)
  const entry = lock?.images[image]
  if (!entry) return image
  note(`--image ${image}: ${entry.ref} (${entry.digest.slice(0, 19)}…), pinned by ${LOCK_FILE}`)
  return entry.ref
}
