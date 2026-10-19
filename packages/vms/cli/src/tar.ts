/**
 * Just enough of POSIX tar (ustar + pax) to stream a worktree out and read build
 * results back, identically on macOS and Linux: bsdtar and GNU tar disagree on
 * flags, exclusion syntax and how they spell long names, and we need neither.
 */

export const BLOCK = 512

export type EntryType = "file" | "dir" | "symlink" | "hardlink" | "other"

export interface TarHeader {
  name: string
  type: EntryType
  mode: number
  size: number
  /** unix seconds */
  mtime: number
  linkname?: string
  uid?: number
  gid?: number
  /** raw typeflag, for entries such as devices that only tests write */
  typeflag?: string
}

export interface TarEntry extends Required<Omit<TarHeader, "uid" | "gid">> {}

const FLAG_OF: Record<Exclude<EntryType, "other">, string> = { file: "0", hardlink: "1", symlink: "2", dir: "5" }
const TYPE_OF: Record<string, EntryType> = { "0": "file", "\0": "file", "7": "file", "1": "hardlink", "2": "symlink", "5": "dir" }

/** the uid of the guest's `sandbox` user, so files stay its own even if root unpacks them */
const GUEST_UID = 1000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const OCTAL_LIMIT = 0o77777777777

function put(block: Uint8Array, offset: number, width: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, width), offset)
}

function putNumber(block: Uint8Array, offset: number, width: number, value: number): void {
  if (value >= 0 && value < 8 ** (width - 1)) {
    put(block, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`)
    return
  }
  // GNU base-256 for sizes and times octal cannot hold; pax carries them as well
  block[offset] = 0x80
  let rest = BigInt(Math.max(0, Math.floor(value)))
  for (let i = offset + width - 1; i > offset; i--) {
    block[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const bytes = encoder.encode(body).length
  let length = bytes + String(bytes).length
  while (length !== bytes + String(length).length) length = bytes + String(length).length
  return `${length}${body}`
}

const fitsUstar = (text: string) => /^[\x20-\x7e]*$/.test(text) && text.length <= 100

function ustarBlock(header: TarHeader, name: string, linkname: string, typeflag: string): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK)
  put(block, 0, 100, name)
  putNumber(block, 100, 8, header.mode & 0o7777)
  putNumber(block, 108, 8, header.uid ?? GUEST_UID)
  putNumber(block, 116, 8, header.gid ?? GUEST_UID)
  putNumber(block, 124, 12, header.size)
  putNumber(block, 136, 12, Math.max(0, Math.floor(header.mtime)))
  put(block, 148, 8, "        ")
  put(block, 156, 1, typeflag)
  put(block, 157, 100, linkname)
  put(block, 257, 6, "ustar\0")
  put(block, 263, 2, "00")
  let sum = 0
  for (const byte of block) sum += byte
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

/** header block(s) for one entry: a pax header first whenever ustar cannot say it exactly */
export function headerBlocks(header: TarHeader): Uint8Array<ArrayBuffer>[] {
  const typeflag = header.typeflag ?? FLAG_OF[header.type as Exclude<EntryType, "other">] ?? "0"
  const linkname = header.linkname ?? ""
  let pax = ""
  if (!fitsUstar(header.name)) pax += paxRecord("path", header.name)
  if (!fitsUstar(linkname)) pax += paxRecord("linkpath", linkname)
  if (header.size > OCTAL_LIMIT) pax += paxRecord("size", String(header.size))
  if (header.mtime > OCTAL_LIMIT || header.mtime < 0) pax += paxRecord("mtime", String(Math.floor(header.mtime)))

  const blocks: Uint8Array<ArrayBuffer>[] = []
  if (pax) {
    const data = encoder.encode(pax)
    const short = header.name.replace(/[^\x20-\x7e]/g, "_").slice(-90)
    blocks.push(ustarBlock({ ...header, size: data.length, mode: 0o644 }, `PaxHeader/${short}`, "", "x"))
    blocks.push(data, padding(data.length))
  }
  const safe = (text: string) => (fitsUstar(text) ? text : text.replace(/[^\x20-\x7e]/g, "_").slice(0, 100))
  blocks.push(ustarBlock(header, safe(header.name), safe(linkname), typeflag))
  return blocks.filter((block) => block.length > 0)
}

export function padding(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)
}

export const END_OF_ARCHIVE = new Uint8Array(BLOCK * 2)

// --- reading -------------------------------------------------------------

/** the archive itself is broken (truncated, not a tar): nothing after this point can be trusted */
export class TarError extends Error {}

/**
 * The archive ended before its end: mid-entry, or with no end-of-archive marker. That is the
 * stream carrying it cut short, whatever the server made of it: a server that turns a broken
 * response into a clean end (Bun before 1.4 does), a proxy that closes early. Worth fetching again.
 */
export class TarTruncated extends TarError {}

/** pull-style reader over a byte stream, for exact-size tar blocks */
class ByteReader {
  private chunks: Uint8Array[] = []
  private buffered = 0
  private ended = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.ended) {
      const { done, value } = await this.reader.read()
      if (done) this.ended = true
      else if (value.length > 0) {
        this.chunks.push(value)
        this.buffered += value.length
      }
    }
  }

  private take(n: number): Uint8Array {
    const first = this.chunks[0]!
    if (first.length >= n) {
      this.buffered -= n
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      return first.subarray(0, n)
    }
    const out = new Uint8Array(n)
    let offset = 0
    while (offset < n) {
      const chunk = this.chunks[0]!
      const part = Math.min(chunk.length, n - offset)
      out.set(chunk.subarray(0, part), offset)
      offset += part
      if (part === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(part)
    }
    this.buffered -= n
    return out
  }

  /** exactly n bytes, or null at a clean end of stream */
  async exact(n: number): Promise<Uint8Array | null> {
    await this.fill(n)
    if (this.buffered === 0 && this.ended) return null
    if (this.buffered < n) throw new TarTruncated("archive is truncated")
    return this.take(n)
  }

  /** up to n bytes as they arrive, without buffering them all */
  async next(n: number): Promise<Uint8Array> {
    await this.fill(1)
    if (this.buffered === 0) throw new TarTruncated("archive is truncated")
    return this.take(Math.min(n, this.chunks[0]!.length))
  }

  async skip(n: number): Promise<void> {
    let left = n
    while (left > 0) left -= (await this.next(left)).length
  }

  cancel(): void {
    this.reader.cancel().catch(() => {})
  }
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function readNumber(bytes: Uint8Array): number {
  if (bytes[0]! & 0x80) {
    let value = 0n
    for (let i = 1; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]!)
    return Number(value)
  }
  const text = cString(bytes).trim()
  return text ? Number.parseInt(text, 8) : 0
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!
  return sum === readNumber(block.subarray(148, 156))
}

function parsePax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10)
    if (!(length > 0)) break
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1))
    const eq = record.indexOf("=")
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1)
    offset += length
  }
  return records
}

export interface TarItem {
  entry: TarEntry
  /** the entry's data as it streams in; whatever the consumer leaves is skipped */
  body: () => AsyncGenerator<Uint8Array>
}

/** Streams entries out of a tar byte stream: pax, GNU long names and base-256 sizes included. */
export async function* readTar(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarItem> {
  const reader = new ByteReader(stream.getReader())
  let pax: Record<string, string> = {}
  let longName: string | null = null
  let longLink: string | null = null
  try {
    while (true) {
      const block = await reader.exact(BLOCK)
      // a tar ends with zero blocks; a stream that just stops where a header would be was cut short
      if (!block) throw new TarTruncated("archive ends without its end-of-archive marker (the download was cut short)")
      if (block.every((byte) => byte === 0)) return
      if (!checksumOk(block)) throw new TarError("not a tar archive (bad header checksum)")

      const typeflag = String.fromCharCode(block[156]!)
      const size = readNumber(block.subarray(124, 136))
      const pad = (BLOCK - (size % BLOCK)) % BLOCK
      const meta = async () => {
        const data = size === 0 ? new Uint8Array() : await reader.exact(size)
        if (!data) throw new TarTruncated("archive is truncated")
        await reader.skip(pad)
        return data
      }
      if (typeflag === "x") {
        pax = { ...pax, ...parsePax(await meta()) }
        continue
      }
      if (typeflag === "L" || typeflag === "K") {
        const text = cString(await meta())
        if (typeflag === "L") longName = text
        else longLink = text
        continue
      }
      if (typeflag === "g") {
        await meta()
        continue
      }

      const posix = cString(block.subarray(257, 263)) === "ustar"
      const prefix = posix ? cString(block.subarray(345, 500)) : ""
      const rawName = cString(block.subarray(0, 100))
      const entry: TarEntry = {
        name: pax.path ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName),
        type: TYPE_OF[typeflag] ?? "other",
        typeflag,
        mode: readNumber(block.subarray(100, 108)),
        size: pax.size !== undefined ? Number(pax.size) : size,
        mtime: pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : readNumber(block.subarray(136, 148)),
        linkname: pax.linkpath ?? longLink ?? cString(block.subarray(157, 257)),
      }
      pax = {}
      longName = longLink = null

      let left = entry.size
      async function* body(): AsyncGenerator<Uint8Array> {
        while (left > 0) {
          const chunk = await reader.next(left)
          left -= chunk.length
          yield chunk
        }
      }
      yield { entry, body }
      if (left > 0) await reader.skip(left)
      await reader.skip((BLOCK - (entry.size % BLOCK)) % BLOCK)
    }
  } finally {
    reader.cancel()
  }
}
