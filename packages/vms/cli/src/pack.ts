import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, readlink } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"
import { END_OF_ARCHIVE, headerBlocks, padding } from "./tar"
import { zstdAvailable, zstdCompress } from "./zstd"

/** skipped when the directory is not a git repo, where .gitignore would have said so */
export const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", "dist"])

export interface PackEntry {
  /** posix path inside the archive */
  rel: string
  abs: string
  stats: Stats
}

export interface Listing {
  mode: "git" | "walk"
  entries: PackEntry[]
  /** file bytes before compression */
  bytes: number
}

export interface SpawnOptions {
  /** replaces the environment (the default is ours) */
  env?: Record<string, string | undefined>
  /** kills the process */
  signal?: AbortSignal
  /** fed to the process, which otherwise gets none */
  stdin?: string
}

export async function spawnText(cmd: string[], cwd: string, options: SpawnOptions = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn({
      cmd,
      cwd,
      // no index.lock from the refresh ls-files does, so we never block the user's own git
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdin: options.stdin !== undefined ? Buffer.from(options.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: options.signal,
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { ok: code === 0, stdout, stderr: stderr.trim() }
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** git in the user's repo, with their config, but never their fsmonitor */
export const git = (args: string[], cwd: string, options?: SpawnOptions) => spawnText(["git", "-c", "core.fsmonitor=false", ...args], cwd, options)

const exists = (path: string) => lstat(path).then(() => true, () => false)

/** the nearest `.git` at or above dir: a directory, or a file in worktrees and submodules */
async function gitMarker(dir: string): Promise<string | null> {
  let current = resolve(dir)
  while (true) {
    if (await exists(join(current, ".git"))) return join(current, ".git")
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Git mode whenever git recognises the directory. Inside a repo git cannot read
 * (not installed, dubious ownership, a broken .git) we stop rather than walk,
 * because walking would upload exactly what .gitignore keeps out: .env files,
 * keys, local credentials. `--no-git` is the explicit way to walk anyway.
 */
async function packMode(dir: string, useGit: boolean): Promise<Listing["mode"]> {
  if (!useGit) return "walk"
  const result = await git(["rev-parse", "--is-inside-work-tree"], dir)
  if (result.ok && result.stdout.trim() === "true") return "git"
  const marker = await gitMarker(dir)
  if (!marker) return "walk"
  const reason = result.ok ? "git says it is not a work tree" : result.stderr.split("\n")[0] || "git failed"
  throw new Error(
    `${dir} is in the git repo at ${dirname(marker)}, but git could not list its files (${reason}). Nothing was uploaded, since .gitignore could not be applied; fix git, or pass --no-git to upload everything except ${[...SKIP_DIRS].join(", ")}`,
  )
}

/**
 * Tracked plus untracked-but-not-ignored files, exactly what `git status` would
 * consider part of the worktree. Submodules and nested repos show up as a single
 * directory entry, so we list those with their own git.
 */
async function gitEntries(dir: string, prefix: string, out: PackEntry[]): Promise<void> {
  const result = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir)
  if (!result.ok) throw new Error(`git ls-files failed in ${dir}: ${result.stderr}`)
  const seen = new Set<string>()
  for (const raw of result.stdout.split("\0")) {
    const path = raw.replace(/\/+$/, "")
    if (!path || seen.has(path)) continue
    seen.add(path)
    const abs = join(dir, path)
    const stats = await lstat(abs).catch(() => null)
    // deleted in the worktree but still in the index
    if (!stats) continue
    if (stats.isDirectory()) {
      if (await exists(join(abs, ".git"))) await gitEntries(abs, `${prefix}${path}/`, out)
      else out.push({ rel: `${prefix}${path}`, abs, stats })
      continue
    }
    out.push({ rel: `${prefix}${path}`, abs, stats })
  }
}

async function walkEntries(root: string, rel: string, out: PackEntry[]): Promise<void> {
  const dirents = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of dirents) {
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
    const abs = join(root, childRel)
    const stats = await lstat(abs).catch(() => null)
    if (!stats) continue
    out.push({ rel: childRel, abs, stats })
    if (stats.isDirectory()) await walkEntries(root, childRel, out)
  }
}

export async function listFiles(dir: string, options: { git?: boolean } = {}): Promise<Listing> {
  const stats = await lstat(dir).catch(() => null)
  if (!stats?.isDirectory()) throw new Error(`${dir} is not a directory`)
  const entries: PackEntry[] = []
  const mode = await packMode(dir, options.git ?? true)
  if (mode === "git") await gitEntries(dir, "", entries)
  else await walkEntries(dir, "", entries)
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const bytes = entries.reduce((sum, entry) => sum + (entry.stats.isFile() ? entry.stats.size : 0), 0)
  return { mode, entries, bytes }
}

/** a link the guest would refuse to unpack, and which would point off the upload anyway */
function escapes(rel: string, target: string): boolean {
  if (isAbsolute(target)) return true
  const resolved = posix.normalize(posix.join(posix.dirname(rel), target))
  return resolved === ".." || resolved.startsWith("../")
}

const CHUNK = 256 * 1024

/** batches headers and small files into ~256 KiB writes; big file chunks pass straight through */
function coalescer() {
  const buffer = new Uint8Array(CHUNK)
  let used = 0

  function* flush(): Generator<Uint8Array> {
    if (used === 0) return
    yield buffer.slice(0, used)
    used = 0
  }

  function* add(chunk: Uint8Array): Generator<Uint8Array> {
    if (chunk.length >= CHUNK / 2) {
      yield* flush()
      yield chunk
      return
    }
    if (used + chunk.length > CHUNK) yield* flush()
    buffer.set(chunk, used)
    used += chunk.length
  }

  return { add, flush }
}

async function* tarChunks(entries: PackEntry[], warn: (message: string) => void): AsyncGenerator<Uint8Array> {
  const out = coalescer()
  const mtime = (stats: Stats) => Math.floor(stats.mtimeMs / 1000)
  // setuid/setgid/sticky mean nothing in the guest; exec bits are the point
  const mode = (stats: Stats) => stats.mode & 0o777

  for (const { rel, abs, stats } of entries) {
    if (stats.isDirectory()) {
      for (const block of headerBlocks({ name: `${rel}/`, type: "dir", mode: mode(stats) | 0o700, size: 0, mtime: mtime(stats) })) yield* out.add(block)
      continue
    }
    if (stats.isSymbolicLink()) {
      const target = await readlink(abs).catch(() => null)
      if (target === null) continue
      if (escapes(rel, target)) {
        warn(`skipped symlink ${rel} -> ${target}: it points outside the upload`)
        continue
      }
      for (const block of headerBlocks({ name: rel, type: "symlink", linkname: target, mode: 0o777, size: 0, mtime: mtime(stats) })) yield* out.add(block)
      continue
    }
    if (!stats.isFile()) continue

    let handle
    try {
      // O_NOFOLLOW: a file swapped for a symlink since we listed it is not followed
      handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      warn(`skipped ${rel}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
      continue
    }
    try {
      const current = await handle.stat()
      const size = current.size
      for (const block of headerBlocks({ name: rel, type: "file", mode: mode(current), size, mtime: mtime(current) })) yield* out.add(block)
      let left = size
      while (left > 0) {
        const buffer = new Uint8Array(Math.min(CHUNK, left))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) {
          warn(`${rel} shrank while it was being packed; the rest is zeros`)
          for (let rest = left; rest > 0; rest -= CHUNK) yield* out.add(new Uint8Array(Math.min(CHUNK, rest)))
          break
        }
        left -= bytesRead
        yield* out.add(buffer.subarray(0, bytesRead))
      }
      yield* out.add(padding(size))
    } finally {
      await handle.close()
    }
  }
  yield* out.add(END_OF_ARCHIVE)
  yield* out.flush()
}

/** the archive as a pull stream: nothing is read from disk until the upload asks for it */
export function tarStream(entries: PackEntry[], warn: (message: string) => void): ReadableStream<Uint8Array> {
  const chunks = tarChunks(entries, warn)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await chunks.return(undefined)
    },
  })
}

export interface UploadBody {
  stream: ReadableStream<Uint8Array>
  contentType: string
  /** compressed bytes handed to the network so far */
  sent: () => number
}

export function uploadBody(entries: PackEntry[], warn: (message: string) => void): UploadBody {
  let sent = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.length
      controller.enqueue(chunk)
    },
  })
  const tar = tarStream(entries, warn)
  const stream = (zstdAvailable ? tar.pipeThrough(zstdCompress()) : tar).pipeThrough(counter)
  return { stream, contentType: zstdAvailable ? "application/zstd" : "application/x-tar", sent: () => sent }
}
