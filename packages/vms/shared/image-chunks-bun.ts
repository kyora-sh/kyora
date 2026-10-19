// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { zstdDecompressSync } from "node:zlib"
import { CHUNK_SIZE, ChunkFormatError, chunkCount, chunkLength, type ManifestChunk } from "./image-chunks"

/**
 * The Bun side of the chunk format (image-chunks.ts), for kyora-node and the CLI: cutting a file into
 * stored chunks, and opening a stored chunk with every check before and after zstd. Not for the
 * Worker (node builtins).
 */

export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

const ZERO_CHUNK = new Uint8Array(CHUNK_SIZE)

const allZero = (plain: Uint8Array): boolean => Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).equals(ZERO_CHUNK.subarray(0, plain.byteLength))

/**
 * A stored chunk checked as stored (its length, sha256 = its key) before zstd sees a byte, then
 * decoded with the output bounded to the chunk's length (a decompression bomb stops there), then
 * checked as plaintext (its length and sha256).
 */
export function openChunk(stored: Uint8Array, entry: ManifestChunk, bytes: number): Uint8Array {
  const [index, sha, key, storedBytes] = entry
  if (stored.byteLength !== storedBytes || sha256Hex(stored) !== key) throw new ChunkFormatError("chunk_mismatch", `chunk ${index}: the stored object is not ${key}`)
  const expected = chunkLength(index, bytes)
  let plain: Uint8Array
  try {
    plain = zstdDecompressSync(stored, { maxOutputLength: expected })
  } catch (error) {
    throw new ChunkFormatError("chunk_mismatch", `chunk ${index} does not decode within ${expected} bytes: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (plain.byteLength !== expected || sha256Hex(plain) !== sha) throw new ChunkFormatError("chunk_mismatch", `chunk ${index}: the plaintext is not ${sha}`)
  return plain
}

export interface StoredChunk {
  index: number
  sha: string
  key: string
  stored: Uint8Array<ArrayBuffer>
}

/**
 * Every non-zero chunk of a file, read, zstd'd (level 3) and named, `batch` at a time; the whole
 * file's sha256 and length at the end. A file that changes size while it is read is refused.
 */
export async function* cutFile(path: string, options: { batch?: number; level?: number } = {}): AsyncGenerator<StoredChunk[], { sha256: string; bytes: number }> {
  const handle = await open(path, "r")
  try {
    const bytes = (await handle.stat()).size
    const whole = createHash("sha256")
    const batch = Math.max(1, options.batch ?? 16)
    const count = chunkCount(bytes)
    for (let first = 0; first < count; first += batch) {
      const out: StoredChunk[] = []
      for (let index = first; index < Math.min(count, first + batch); index++) {
        const length = chunkLength(index, bytes)
        const plain = Buffer.alloc(length)
        const { bytesRead } = await handle.read(plain, 0, length, index * CHUNK_SIZE)
        if (bytesRead !== length) throw new ChunkFormatError("image_changed", `${path} is shorter than it was`)
        whole.update(plain)
        if (allZero(plain)) continue
        const stored = new Uint8Array(Bun.zstdCompressSync(plain, { level: options.level ?? 3 }))
        out.push({ index, sha: sha256Hex(plain), key: sha256Hex(stored), stored })
      }
      if (out.length) yield out
    }
    if ((await handle.stat()).size !== bytes) throw new ChunkFormatError("image_changed", `${path} changed size while it was read`)
    return { sha256: whole.digest("hex"), bytes }
  } finally {
    await handle.close()
  }
}
