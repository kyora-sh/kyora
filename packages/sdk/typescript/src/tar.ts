/**
 * Just enough POSIX tar (ustar, with pax for long names) to send files into a sandbox and read
 * the archives it sends back. Pax, GNU long names and base-256 numbers are read; pax is written.
 */

const BLOCK = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const OCTAL_LIMIT = 0o77777777777
/** the uid of the guest's `sandbox` user, so the files are its own */
const GUEST_UID = 1000

export type EntryType = "file" | "dir" | "symlink" | "hardlink" | "other"

export interface TarEntry {
  /** the name as the archive has it */
  name: string
  type: EntryType
  mode: number
  size: number
  /** unix seconds */
  mtime: number
  linkname: string
  /** a regular file's bytes; empty for anything else */
  data: Uint8Array
}

export interface FileInput {
  /** relative to the upload's destination; parent directories are created */
  path: string
  data: string | Uint8Array
  /** default 0o644 */
  mode?: number
}

function put(block: Uint8Array, offset: number, width: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, width), offset)
}

function putNumber(block: Uint8Array, offset: number, width: number, value: number): void {
  put(block, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`)
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const bytes = encoder.encode(body).length
  let length = bytes + String(bytes).length
  while (length !== bytes + String(length).length) length = bytes + String(length).length
  return `${length}${body}`
}

const fitsUstar = (text: string) => /^[\x20-\x7e]*$/.test(text) && text.length <= 100

function header(name: string, typeflag: string, mode: number, size: number, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK)
  put(block, 0, 100, name)
  putNumber(block, 100, 8, mode & 0o7777)
  putNumber(block, 108, 8, GUEST_UID)
  putNumber(block, 116, 8, GUEST_UID)
  putNumber(block, 124, 12, size)
  putNumber(block, 136, 12, mtime)
  put(block, 148, 8, "        ")
  put(block, 156, 1, typeflag)
  put(block, 257, 6, "ustar\0")
  put(block, 263, 2, "00")
  let sum = 0
  for (const byte of block) sum += byte
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)

function entryBlocks(name: string, typeflag: string, mode: number, data: Uint8Array, mtime: number): Uint8Array[] {
  if (data.length > OCTAL_LIMIT) throw new RangeError(`${name}: too large for one archive entry`)
  const blocks: Uint8Array[] = []
  if (!fitsUstar(name)) {
    const pax = encoder.encode(paxRecord("path", name))
    blocks.push(header(`PaxHeader/${name.replace(/[^\x20-\x7e]/g, "_").slice(-90)}`, "x", 0o644, pax.length, mtime), pax, padding(pax.length))
  }
  blocks.push(header(fitsUstar(name) ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(0, 100), typeflag, mode, data.length, mtime), data, padding(data.length))
  return blocks
}

/** a clean relative path, or a RangeError for one that leaves its root */
function relative(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") throw new RangeError(`${path}: a path may not leave the destination`)
    parts.push(part)
  }
  if (parts.length === 0) throw new RangeError(`${JSON.stringify(path)} names no file`)
  return parts.join("/")
}

/** a tar of `files`, with an entry for every parent directory */
export function packFiles(files: readonly FileInput[]): Uint8Array {
  const mtime = Math.floor(Date.now() / 1000)
  const blocks: Uint8Array[] = []
  const dirs = new Set<string>()
  for (const file of files) {
    const name = relative(file.path)
    const parts = name.split("/")
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      if (dirs.has(dir)) continue
      dirs.add(dir)
      blocks.push(...entryBlocks(`${dir}/`, "5", 0o755, new Uint8Array(), mtime))
    }
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data
    blocks.push(...entryBlocks(name, "0", file.mode ?? 0o644, data, mtime))
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function readNumber(bytes: Uint8Array): number {
  if (bytes[0]! & 0x80) {
    let value = 0
    for (let i = 1; i < bytes.length; i++) value = value * 256 + bytes[i]!
    return value
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

const TYPE_OF: Record<string, EntryType> = { "0": "file", "\0": "file", "7": "file", "1": "hardlink", "2": "symlink", "5": "dir" }

/** the entries of a whole archive in memory; a truncated or broken one is an Error */
export function unpack(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let pax: Record<string, string> = {}
  let longName: string | null = null
  let longLink: string | null = null
  let offset = 0
  const take = (n: number) => {
    if (offset + n > archive.length) throw new Error("the archive is truncated")
    const bytes = archive.subarray(offset, offset + n)
    offset += n + ((BLOCK - (n % BLOCK)) % BLOCK)
    return bytes
  }
  for (;;) {
    if (offset + BLOCK > archive.length) throw new Error("the archive is truncated: it ends without its end-of-archive marker")
    const block = archive.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (block.every((byte) => byte === 0)) return entries
    if (!checksumOk(block)) throw new Error("not a tar archive (bad header checksum)")
    const typeflag = String.fromCharCode(block[156]!)
    const headerSize = readNumber(block.subarray(124, 136))
    if (typeflag === "x") {
      pax = { ...pax, ...parsePax(take(headerSize)) }
      continue
    }
    if (typeflag === "L" || typeflag === "K") {
      const text = cString(take(headerSize))
      if (typeflag === "L") longName = text
      else longLink = text
      continue
    }
    if (typeflag === "g") {
      take(headerSize)
      continue
    }
    const prefix = cString(block.subarray(257, 263)) === "ustar" ? cString(block.subarray(345, 500)) : ""
    const raw = cString(block.subarray(0, 100))
    const size = pax.size !== undefined ? Number(pax.size) : headerSize
    const type = TYPE_OF[typeflag] ?? "other"
    const data = take(size)
    entries.push({
      name: (pax.path ?? longName ?? (prefix ? `${prefix}/${raw}` : raw)).replace(/^(\.\/)+/, ""),
      type,
      mode: readNumber(block.subarray(100, 108)),
      size,
      mtime: pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : readNumber(block.subarray(136, 148)),
      linkname: pax.linkpath ?? longLink ?? cString(block.subarray(157, 257)),
      data: type === "file" ? data.slice() : new Uint8Array(),
    })
    pax = {}
    longName = longLink = null
  }
}
