import zlib from "node:zlib"
import type { Transform } from "node:stream"

type ZstdZlib = typeof zlib & {
  createZstdCompress?: () => Transform
  createZstdDecompress?: () => Transform
}
const z = zlib as ZstdZlib

/**
 * zstd runs in-process (Bun's node:zlib has had it since 1.2.19), so a laptop
 * without the zstd binary still sends compressed uploads. Without it we fall back
 * to plain tar, which the API accepts too.
 */
export const zstdAvailable = typeof z.createZstdCompress === "function" && typeof z.createZstdDecompress === "function"

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function wrap(node: Transform): TransformStream<Uint8Array, Uint8Array> {
  let controller!: TransformStreamDefaultController<Uint8Array>
  const ended = new Promise<void>((resolve, reject) => {
    node.on("end", resolve)
    node.on("error", reject)
  })
  ended.catch(() => {})
  node.on("data", (chunk: Uint8Array) => {
    try {
      controller.enqueue(chunk)
    } catch {
      // the consumer went away (a 413 cut the upload short): stop compressing
      node.destroy()
    }
  })
  return new TransformStream<Uint8Array, Uint8Array>({
    start(c) {
      controller = c
    },
    // resolving only once zlib took the chunk keeps memory to about one chunk in flight
    transform: (chunk) => new Promise<void>((resolve, reject) => node.write(chunk, (error) => (error ? reject(error) : resolve()))),
    async flush() {
      node.end()
      await ended
    },
  })
}

export function zstdCompress(): TransformStream<Uint8Array, Uint8Array> {
  return wrap(z.createZstdCompress!())
}

export function zstdDecompress(): TransformStream<Uint8Array, Uint8Array> {
  return wrap(z.createZstdDecompress!())
}

/** Decompresses when the stream starts with the zstd magic, whatever its content type said. */
export async function decompressIfZstd(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader()
  const head: Uint8Array[] = []
  let length = 0
  let done = false
  while (length < MAGIC.length) {
    const next = await reader.read()
    if (next.done) {
      done = true
      break
    }
    head.push(next.value)
    length += next.value.length
  }
  const first = new Uint8Array(length)
  let offset = 0
  for (const chunk of head) {
    first.set(chunk, offset)
    offset += chunk.length
  }

  const replay = new ReadableStream<Uint8Array>({
    start(c) {
      if (first.length > 0) c.enqueue(first)
      if (done) c.close()
    },
    async pull(c) {
      const next = await reader.read()
      if (next.done) c.close()
      else c.enqueue(next.value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  const isZstd = MAGIC.every((byte, i) => first[i] === byte)
  if (!isZstd) return replay
  if (!zstdAvailable) throw new Error("the server sent zstd but this Bun has no zstd support; upgrade Bun (>= 1.2.19)")
  return replay.pipeThrough(zstdDecompress())
}
