import { chmod, copyFile, link, lstat, mkdir, open, realpath, symlink, unlink, utimes } from "node:fs/promises"
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { readTar, TarError, type TarEntry } from "./tar"

export interface ExtractResult {
  entries: number
  bytes: number
  /** paths written, relative to the destination */
  written: string[]
  /** entries refused for trying to leave the destination, with the reason */
  refused: string[]
  /** entries that could not be written (a file where a directory is, a full disk…), with the error */
  failed: string[]
  /** entry kinds we never create locally (devices, fifos) */
  skipped: string[]
}

class Unsafe extends Error {}

/** posix member name → clean relative path; null for absolute paths and any `..` */
function cleanName(name: string): string | null {
  if (name.startsWith("/") || name.includes("\0")) return null
  const parts = name.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.includes("..")) return null
  return parts.join("/")
}

/**
 * Unpacks an untrusted tar with the rules of Python's `data` filter (the guest
 * agent's own): no absolute names, no `..`, no links that resolve outside, no
 * devices, no setuid or group/other-write bits. On top of that every directory
 * we pass through is checked on disk, so a symlink planted earlier in the same
 * archive, or already in the destination, cannot carry a later write out.
 */
class Extractor {
  readonly result: ExtractResult = { entries: 0, bytes: 0, written: [], refused: [], failed: [], skipped: [] }

  constructor(
    private readonly root: string,
    private readonly rename: (name: string) => string,
  ) {}

  private inside(path: string): boolean {
    const rel = relative(this.root, path)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  /** the real directory for `parts`, creating what is missing one level at a time */
  private async directory(parts: string[]): Promise<string> {
    let current = this.root
    for (const part of parts) {
      const next = join(current, part)
      const stats = await lstat(next).catch(() => null)
      if (!stats) {
        await mkdir(next, { mode: 0o755 })
        current = next
      } else if (stats.isDirectory()) {
        current = next
      } else if (stats.isSymbolicLink()) {
        const real = await realpath(next).catch(() => null)
        if (!real || !this.inside(real)) throw new Unsafe(`${part} is a symlink leading outside the destination`)
        if (!(await lstat(real)).isDirectory()) throw new Unsafe(`${part} is a symlink to something that is not a directory`)
        current = real
      } else {
        throw new Error(`${next} exists and is not a directory`)
      }
    }
    return current
  }

  private async clear(target: string): Promise<void> {
    const stats = await lstat(target).catch(() => null)
    if (!stats) return
    if (stats.isDirectory()) throw new Error(`${target} is a directory`)
    // unlink, never write through: an existing symlink here would redirect the write
    await unlink(target)
  }

  async add(entry: TarEntry, body: () => AsyncGenerator<Uint8Array>): Promise<void> {
    const name = cleanName(this.rename(entry.name))
    if (name === null) throw new Unsafe("absolute path or `..`")
    if (name === "") return
    const parts = name.split("/")
    const leaf = parts.pop()!

    if (entry.type === "dir") {
      const dir = await this.directory([...parts, leaf])
      await chmod(dir, (entry.mode & 0o755) | 0o700)
      return
    }
    if (entry.type === "other") {
      this.result.skipped.push(`${name} (tar type ${JSON.stringify(entry.typeflag)})`)
      return
    }

    const parent = await this.directory(parts)
    const target = join(parent, leaf)

    if (entry.type === "symlink") {
      const link = entry.linkname
      if (!link || isAbsolute(link)) throw new Unsafe(`symlink to absolute path ${link}`)
      const logical = posix.normalize(posix.join(posix.dirname(name), link))
      if (logical === ".." || logical.startsWith("../") || !this.inside(resolve(parent, link))) {
        throw new Unsafe(`symlink to ${link} leads outside the destination`)
      }
      await this.clear(target)
      await symlink(link, target)
    } else if (entry.type === "hardlink") {
      const source = cleanName(this.rename(entry.linkname))
      if (!source) throw new Unsafe(`hard link to ${entry.linkname}`)
      const sourceParts = source.split("/")
      const sourcePath = join(await this.directory(sourceParts.slice(0, -1)), sourceParts.at(-1)!)
      const stats = await lstat(sourcePath).catch(() => null)
      if (!stats?.isFile()) throw new Unsafe(`hard link to ${entry.linkname}, which is not a regular file inside the destination`)
      await this.clear(target)
      await linkOrCopy(sourcePath, target, (stats.mode & 0o755) | 0o600)
    } else {
      await this.clear(target)
      const mode = (entry.mode & 0o755) | 0o600
      const handle = await open(target, "wx", mode)
      try {
        for await (const chunk of body()) {
          let offset = 0
          while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten
          this.result.bytes += chunk.length
        }
      } catch (error) {
        // no half-written artifact left behind looking like a whole one
        await handle.close()
        await unlink(target).catch(() => {})
        throw error
      }
      await handle.close()
      await chmod(target, mode)
      if (entry.mtime > 0) await utimes(target, entry.mtime, entry.mtime).catch(() => {})
    }
    this.result.written.push(name)
  }
}

/**
 * A hard link where the filesystem allows one, else a copy. The copy is given
 * the mode explicitly, since copyFile does not promise to carry exec bits over.
 */
export async function linkOrCopy(source: string, target: string, mode: number, linker: typeof link = link): Promise<void> {
  try {
    await linker(source, target)
  } catch {
    await copyFile(source, target)
    await chmod(target, mode)
  }
}

/** `rename` maps member names (and hard link targets) before any safety check runs */
export async function extractTar(stream: ReadableStream<Uint8Array>, dest: string, rename: (name: string) => string = (name) => name): Promise<ExtractResult> {
  await mkdir(dest, { recursive: true })
  const extractor = new Extractor(await realpath(dest), rename)
  for await (const { entry, body } of readTar(stream)) {
    extractor.result.entries++
    try {
      await extractor.add(entry, body)
    } catch (error) {
      // a broken archive ends the pull; an entry that cannot land only costs that entry
      if (error instanceof TarError) throw error
      if (error instanceof Unsafe) extractor.result.refused.push(`${entry.name} (${error.message})`)
      else extractor.result.failed.push(`${entry.name} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
    }
  }
  return extractor.result
}
