// SPDX-License-Identifier: Apache-2.0
/**
 * The chunk format images move in, shared by the Worker, kyora-node and the
 * CLI. An image is a flat ext4 file cut into 4 MiB chunks; an all-zero chunk is a hole and is never
 * stored. Each stored chunk is zstd'd and named by the sha256 of the stored bytes (its key); a
 * manifest lists `[index, sha256 of the plaintext, key, stored bytes]` in index order. Pure: no Bun,
 * no node builtins (the Worker imports it too). The Bun side (cutting a file, opening a chunk with
 * bounded zstd) is image-chunks-bun.ts.
 */

export const CHUNK_SIZE = 4 * 1024 * 1024
/** zstd's worst case for a 4 MiB chunk is ~16 KiB over it; anything bigger is not a chunk */
export const MAX_STORED_CHUNK = CHUNK_SIZE + 64 * 1024
export const SHA256_HEX = /^[0-9a-f]{64}$/

/** `img_<random>`: an account image's id (the Worker's newId("img")) */
export const ACCOUNT_IMAGE_ID = /^img_[A-Za-z0-9_-]{8,64}$/
/** `ai-<32 hex>`: an account image's name on a machine; never one a person may name */
export const ACCOUNT_IMAGE_LOCAL = /^ai-[0-9a-f]{32}$/
/** raw image names that start like a machine-local account image are the platform's alone */
export const isReservedImageName = (name: string): boolean => name.startsWith("ai-")
/** an account image's own name: lowercase, a letter first, up to 64 */
export const ACCOUNT_IMAGE_NAME = /^[a-z][a-z0-9-]{0,63}$/
/**
 * A pinned version of an account image: `name@N` (its Nth push) or `name@sha256:<64 hex>` (the
 * sha256 of its bytes). A bare name is the newest version. Groups: name, version, sha256.
 */
export const ACCOUNT_IMAGE_REF = /^([a-z][a-z0-9-]{0,63})@(?:([1-9][0-9]{0,8})|sha256:([0-9a-f]{64}))$/
/**
 * Names an account image can't take: the fleet's images and profiles, which a bare `--image` name
 * keeps meaning, and the machine-local ai- prefix.
 */
export const FLEET_IMAGE_NAMES: ReadonlySet<string> = new Set([
  "default", "build", "kyora", "base", "node", "python", "rust", "full", "demo", "desktop", "desktop-office",
  "gha-runner",
])
export const isReservedAccountImageName = (name: string): boolean => FLEET_IMAGE_NAMES.has(name) || isReservedImageName(name)

/** One chunk of a manifest: [index, sha256 of its plaintext, key (sha256 of the stored zstd bytes), stored bytes]. */
export type ManifestChunk = [number, string, string, number]

/** The manifest an account image's commit stores (`acct/<owner>/m/<digest>.json`); D1 keeps its digest. */
export interface AccountImageManifest {
  format: 1
  kind: "kyora-account-image"
  id: string
  sha256: string
  bytes: number
  chunkSize: number
  chunks: ManifestChunk[]
}

/** what a check of chunk lists and manifests refuses with: a code and a message, no transport */
export class ChunkFormatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** the plaintext length of chunk `index` of a `bytes`-long file */
export const chunkLength = (index: number, bytes: number, chunkSize = CHUNK_SIZE): number => Math.min(chunkSize, bytes - index * chunkSize)

/** chunks a `bytes`-long file has, holes included */
export const chunkCount = (bytes: number, chunkSize = CHUNK_SIZE): number => Math.ceil(bytes / chunkSize)

/**
 * A chunk list, checked: entries of four, indexes strictly increasing and inside the file, hex
 * names, stored sizes a chunk can have, at most `maxChunks` of them. Returns a fresh array built
 * from the checked fields only.
 */
export function parseChunkList(value: unknown, bytes: number, options: { chunkSize?: number; maxChunks?: number } = {}): ManifestChunk[] {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE
  if (!Array.isArray(value)) throw new ChunkFormatError("invalid_chunks", "chunks must be a list of [index, sha256, key, storedBytes]")
  const count = chunkCount(bytes, chunkSize)
  if (value.length > Math.min(count, options.maxChunks ?? count)) throw new ChunkFormatError("invalid_chunks", `at most ${Math.min(count, options.maxChunks ?? count)} chunks`)
  let previous = -1
  return value.map((entry): ManifestChunk => {
    if (!Array.isArray(entry) || entry.length !== 4) throw new ChunkFormatError("invalid_chunks", "each chunk is [index, sha256, key, storedBytes]")
    const [index, sha, key, stored] = entry as unknown[]
    if (typeof index !== "number" || !Number.isInteger(index) || index <= previous || index >= count) throw new ChunkFormatError("invalid_chunks", "chunk indexes must increase and stay inside the image")
    if (typeof sha !== "string" || !SHA256_HEX.test(sha) || typeof key !== "string" || !SHA256_HEX.test(key)) throw new ChunkFormatError("invalid_chunks", `chunk ${index}: sha256 and key are 64 lowercase hex`)
    if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1 || stored > MAX_STORED_CHUNK) throw new ChunkFormatError("invalid_chunks", `chunk ${index}: storedBytes must be 1-${MAX_STORED_CHUNK}`)
    previous = index
    return [index, sha, key, stored]
  })
}

/** the plaintext bytes a chunk list holds (holes excluded) */
export const dataBytesOf = (chunks: ManifestChunk[], bytes: number, chunkSize = CHUNK_SIZE): number => chunks.reduce((sum, entry) => sum + chunkLength(entry[0], bytes, chunkSize), 0)
/** the stored (zstd) bytes a chunk list names, a key counted each time it is listed */
export const storedBytesOf = (chunks: ManifestChunk[]): number => chunks.reduce((sum, entry) => sum + entry[3], 0)

/**
 * A stored account image manifest, every field checked, against the id, sha256 and length the
 * control plane's record gave (the create message): what a pull trusts once its digest matched.
 */
export function parseAccountManifest(value: unknown, expect: { id: string; sha256: string; bytes: number }, maxBytes: number): AccountImageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChunkFormatError("invalid_manifest", "not an account image manifest")
  const fields = value as Record<string, unknown>
  if (fields.format !== 1 || fields.kind !== "kyora-account-image") throw new ChunkFormatError("invalid_manifest", "not an account image manifest")
  if (fields.id !== expect.id) throw new ChunkFormatError("invalid_manifest", "the manifest is another image's")
  if (fields.sha256 !== expect.sha256 || typeof fields.sha256 !== "string" || !SHA256_HEX.test(fields.sha256)) throw new ChunkFormatError("invalid_manifest", "the manifest names other bytes")
  const bytes = fields.bytes
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes || bytes !== expect.bytes) throw new ChunkFormatError("invalid_manifest", "the manifest's size is not the image's")
  if (fields.chunkSize !== CHUNK_SIZE) throw new ChunkFormatError("invalid_manifest", `the manifest's chunk size is not ${CHUNK_SIZE}`)
  let chunks: ManifestChunk[]
  try {
    chunks = parseChunkList(fields.chunks, bytes)
  } catch (error) {
    throw new ChunkFormatError("invalid_manifest", error instanceof Error ? error.message : String(error))
  }
  return { format: 1, kind: "kyora-account-image", id: expect.id, sha256: expect.sha256, bytes, chunkSize: CHUNK_SIZE, chunks }
}

/**
 * What a create message tells a machine about an account image (the Worker's D1 row): the bytes to
 * pull, the manifest digest to trust, and the machine-local name to boot.
 */
export interface AccountImageRef {
  id: string
  localName: string
  sha256: string
  bytes: number
  digest: string
}

export function parseAccountImageRef(value: unknown, maxBytes: number): AccountImageRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { id, localName, sha256, bytes, digest } = value as Record<string, unknown>
  if (typeof id !== "string" || !ACCOUNT_IMAGE_ID.test(id)) return null
  if (typeof localName !== "string" || !ACCOUNT_IMAGE_LOCAL.test(localName)) return null
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256) || typeof digest !== "string" || !SHA256_HEX.test(digest)) return null
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes || bytes % CHUNK_SIZE !== 0) return null
  return { id, localName, sha256, bytes, digest }
}
