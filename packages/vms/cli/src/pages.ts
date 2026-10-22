import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { ApiError, VmsClient, type Page } from "./api"
import { loadConfig } from "./config"
import { note, printJson } from "./output"
import { StorageClient } from "./storage"
import { formatBytes } from "./units"

/**
 * `kyora publish` and `kyora pages …`: static pages. A publish uploads a directory (or one file) to a fresh
 * prefix of a bucket of yours, points the page's name at it, and then deletes the prefix it was served
 * from before, so a redeploy goes live at once and leaves nothing behind.
 */
export const PAGES_HELP = `kyora publish: a directory or a file as a static page (kyora cloud)

  kyora publish <dir|file> [--name N] [--public] [--spa] [--bucket B]
                             upload it and serve it at its own URL, which it prints. Private: only you,
                             signed in, can open it; --public for everyone. --name asks for that name
                             (else kyora makes one from the directory's); publishing to it again puts the
                             new files live at once and deletes the old ones. --spa serves index.html
                             for paths with no file; --bucket is where the files go (default pages,
                             made in your default region if missing)
  kyora pages ls             your pages
  kyora pages show <name>    one page: its URL, bucket and prefix
  kyora pages rm <name> [--keep-files]
                             release the name (30-day cooldown for other accounts) and delete its files
  kyora pages login <name>   a link, good for 60 seconds, that signs your browser in to a private page

A single file is published under its own name, with an index.html that redirects to it (unless it is
index.html). At most 2000 files and 500 MB per publish. Serve a public page on your own domain with
\`kyora vms domain add <hostname> --page <name>\`. --json for JSON.`

export class PagesUsage extends Error {}
const usage = (message: string): never => {
  throw new PagesUsage(message)
}

export const DEFAULT_BUCKET = "pages"
export const MAX_FILES = 2000
export const MAX_BYTES = 500 * 1000 * 1000
const IN_FLIGHT = 8
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
/** a DNS label of a-z, 0-9 and -: kyora cloud also refuses reserved names and ones under 4 characters */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** a publish's own directory in the bucket: when it was made, and 32 random bits */
const PUBLISH_ID = /^\d{8}t\d{6}z-[0-9a-f]{8}$/
/** never uploaded: a repository's history and the Finder's litter */
const SKIP = new Set([".git", ".DS_Store"])

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  zip: "application/zip",
  gz: "application/gzip",
}

/** a file's content type by its extension; anything unknown is plain bytes */
export function contentType(path: string): string {
  const dot = path.lastIndexOf(".")
  const extension = dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : ""
  return TYPES[extension] ?? "application/octet-stream"
}

export function publishId(now = new Date(), random = crypto.getRandomValues(new Uint8Array(4))): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase()
  return `${stamp}-${Buffer.from(random).toString("hex")}`
}

/** where a first publish without a name goes: `_` is no page's name, so its prefixes never overlap a named one's */
const UNNAMED = "_"

/** a prefix a publish made, `<name>/<publish id>/` (or `_/<publish id>/` for a first one without a name): the only kind ever deleted */
export function publishedPrefix(prefix: string): boolean {
  const parts = prefix.split("/")
  return parts.length === 3 && parts[2] === "" && (parts[0] === UNNAMED || NAME.test(parts[0]!)) && PUBLISH_ID.test(parts[1]!)
}

export interface PageFile {
  /** its key under the publish's prefix, with / between directories */
  key: string
  /** on disk; absent for one made here (a single file's index.html) */
  path?: string
  /** the file as it was listed: it is uploaded only if it is still that file */
  inode?: { dev: number; ino: number }
  data?: string
  size: number
  type: string
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** the files a publish of `source` uploads: a directory's tree (no symlinks, no .git), or one file and an index.html that leads to it */
export async function pageFiles(source: string): Promise<PageFile[]> {
  const root = resolve(source)
  const info = await lstat(root).catch(() => null)
  if (!info) throw new Error(`no such file or directory: ${source}`)
  if (info.isFile()) {
    const name = basename(root)
    const files: PageFile[] = [{ key: name, path: root, inode: { dev: info.dev, ino: info.ino }, size: info.size, type: contentType(name) }]
    if (name !== "index.html") {
      const href = escapeHtml(`./${encodeURIComponent(name)}`)
      const data = `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=${href}">\n<title>${escapeHtml(name)}</title>\n<a href="${href}">${escapeHtml(name)}</a>\n`
      files.push({ key: "index.html", data, size: Buffer.byteLength(data), type: TYPES.html! })
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) throw new Error(`${source} is over ${formatBytes(MAX_BYTES)}; a page takes at most that`)
    return files
  }
  if (!info.isDirectory()) throw new Error(`${source} is neither a file nor a directory`)
  const files: PageFile[] = []
  let bytes = 0
  const top = await realpath(root)
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        // a directory swapped for a symlink while this ran leads outside: nothing from there
        const stat = await lstat(path)
        const real = await realpath(path)
        const there = await lstat(real)
        if (!real.startsWith(`${top}${sep}`) || there.dev !== stat.dev || there.ino !== stat.ino) throw new Error(`${path} is not inside ${source} any more`)
        bytes += stat.size
        const key = relative(root, path).split(sep).join("/")
        files.push({ key, path, inode: { dev: stat.dev, ino: stat.ino }, size: stat.size, type: contentType(key) })
        if (files.length > MAX_FILES) throw new Error(`${source} has more than ${MAX_FILES} files; a page takes at most ${MAX_FILES}`)
        if (bytes > MAX_BYTES) throw new Error(`${source} is over ${formatBytes(MAX_BYTES)}; a page takes at most that`)
      }
    }
  }
  await walk(root)
  if (files.length === 0) throw new Error(`${source} has no files to publish`)
  return files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export interface PagesDeps {
  api: Pick<VmsClient, "pageCreate" | "pages" | "page" | "pageRemove" | "pageLogin">
  storage: StorageClient
  /** told what is going on, for stderr */
  progress?: (message: string) => void
}

export interface PublishOptions {
  source: string
  name?: string
  public?: boolean
  spa?: boolean
  bucket?: string
  signal?: AbortSignal
}

export interface PublishResult {
  page: Page
  files: number
  bytes: number
  /** the prefix the page was served from before, now deleted; null when there was none (or it was kept) */
  replaced: { bucket: string; prefix: string; deleted: number } | null
}

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function ensureBucket(storage: StorageClient, bucket: string, signal?: AbortSignal): Promise<void> {
  const { buckets } = (await (await storage.call("GET", "/v1/storage/buckets", { signal })).json()) as { buckets: Array<{ name: string }> }
  if (buckets.some((entry) => entry.name === bucket)) return
  try {
    await storage.call("POST", "/v1/storage/buckets", { json: { name: bucket }, signal })
  } catch (error) {
    // made by a publish running beside this one
    if (!(error instanceof ApiError && error.status === 409)) throw error
  }
}

/** `each` over the items, IN_FLIGHT at a time; the first failure stops the rest from starting, and is thrown once all in flight are done */
async function inParallel<T>(items: T[], each: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(IN_FLIGHT, items.length) }, async () => {
    while (next < items.length && !failed) {
      try {
        signal?.throwIfAborted()
        await each(items[next++]!)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }))
  const rejected = results.find((result) => result.status === "rejected")
  if (rejected) throw rejected.reason
}

/**
 * A file's bytes as listed: opened without following a symlink, and read only if the opened file is the
 * one listed (not one swapped in since). Read whole, through that descriptor, so nothing else is read later.
 */
export async function listedFile(file: PageFile, root?: string): Promise<Blob> {
  if (!file.path) return new Blob([file.data!])
  const changed = () => new Error(`${file.path} changed while it was being published`)
  // no directory on the way from the source to it may have become a symlink
  if (root) for (let dir = dirname(file.path); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) throw changed()
  }
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => Promise.reject(changed()))
  try {
    const now = await handle.stat()
    if (!now.isFile() || now.dev !== file.inode?.dev || now.ino !== file.inode?.ino || now.size !== file.size) throw changed()
    // exactly the bytes listed: a file that grows meanwhile is not read past them
    const bytes = Buffer.alloc(file.size)
    for (let read = 0; read < file.size;) {
      const { bytesRead } = await handle.read(bytes, read, file.size - read, read)
      if (bytesRead === 0) throw changed()
      read += bytesRead
    }
    return new Blob([bytes])
  } finally {
    await handle.close()
  }
}

/** a refusal from kyora cloud itself: the page was not switched (a 408 is the way's, not kyora cloud's) */
const refused = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408

/** how long deleting old files may take, apart from the publish's own cancellation (the switch already happened) */
const CLEANUP_MS = 5 * 60_000

/** every object under `prefix`, deleted; returns how many */
export async function deletePrefix(storage: StorageClient, bucket: string, prefix: string, signal: AbortSignal = AbortSignal.timeout(CLEANUP_MS)): Promise<number> {
  const { objects } = await storage.list(bucket, prefix, null, false, signal)
  await inParallel(objects, async (object) => {
    await storage.call("DELETE", storage.object(bucket, object.key), { signal }).catch((error) => {
      if (!isMissing(error)) throw error
    })
  }, signal)
  return objects.length
}

/** whether any page serves files under `prefix` (or a prefix it is under): those are never deleted; undefined when the pages can't be listed */
async function served(api: PagesDeps["api"], bucket: string, prefix: string): Promise<boolean | undefined> {
  const pages = await api.pages().catch(() => undefined)
  return pages?.some((page) => page.bucket === bucket && (page.prefix.startsWith(prefix) || prefix.startsWith(page.prefix)))
}

/** `prefix`'s files deleted if no page serves them; null when they were kept, and why is told */
async function deleteUnserved(deps: PagesDeps, bucket: string, prefix: string): Promise<number | null> {
  if (!publishedPrefix(prefix)) {
    deps.progress?.(`kept ${bucket}/${prefix}: not a prefix kyora publish made`)
    return null
  }
  const used = await served(deps.api, bucket, prefix)
  if (used !== false) {
    deps.progress?.(`kept ${bucket}/${prefix}: ${used ? "a page serves files there" : "could not check that no page serves them"}`)
    return null
  }
  try {
    return await deletePrefix(deps.storage, bucket, prefix)
  } catch (error) {
    deps.progress?.(`the files in ${bucket}/${prefix} were not all deleted: ${message(error)}`)
    return null
  }
}

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new PagesUsage("a page's name is 1-63 characters of a-z, 0-9 and -, not starting or ending with -")
  return name
}

export function checkBucket(bucket: string): string {
  if (!BUCKET.test(bucket)) throw new PagesUsage("a bucket's name is 3-63 characters of a-z, 0-9 and -")
  return bucket
}

/** the page by that name if it is yours, else null */
const ownPage = (api: PagesDeps["api"], name: string) => api.page(name).catch((error) => (isMissing(error) ? null : Promise.reject(error)))

/**
 * Upload to a fresh prefix, point the name at it, then delete what it pointed at before. A publish that
 * fails before the switch deletes its own upload; the page keeps serving what it served. Without a name,
 * kyora cloud makes a new one from the directory's (or file's) name.
 */
export async function publishPage(deps: PagesDeps, options: PublishOptions): Promise<PublishResult> {
  const { api, storage } = deps
  const bucket = checkBucket(options.bucket ?? DEFAULT_BUCKET)
  const files = await pageFiles(options.source)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  const name = options.name === undefined ? null : checkName(options.name)
  const previous = name ? await ownPage(api, name) : null
  await ensureBucket(storage, bucket, options.signal)
  const prefix = `${name ?? UNNAMED}/${publishId()}/`
  deps.progress?.(`uploading ${files.length} file${files.length === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${bucket}/${prefix}`)
  const discard = async (error: unknown): Promise<never> => {
    await deletePrefix(storage, bucket, prefix).catch(() => deps.progress?.(`could not delete ${bucket}/${prefix} after the failed publish`))
    throw error
  }
  // nothing points at a fresh prefix until the switch: a failed upload deletes it
  try {
    await inParallel(files, async (file) => {
      await storage.put(bucket, `${prefix}${file.key}`, await listedFile(file, resolve(options.source)), file.type, options.signal)
    }, options.signal)
    options.signal?.throwIfAborted()
  } catch (error) {
    return discard(error)
  }
  let page: Page
  try {
    page = await api.pageCreate({ ...(name ? { name } : { hint: basename(resolve(options.source)) }), bucket, prefix, ...(options.public ? { public: true } : {}), ...(options.spa ? { spa: true } : {}) })
  } catch (error) {
    if (refused(error)) return discard(error)
    // no answer, or not one to go by: the switch may have happened, or may still happen, so the files stay
    const live = await api.pages().then((pages) => pages.find((one) => one.bucket === bucket && one.prefix === prefix), () => undefined)
    if (!live) throw new Error(`${message(error)}; the page may still switch to ${bucket}/${prefix}, so its files are kept (\`kyora pages ls\` shows where each page points)`)
    page = live
  }
  let replaced: PublishResult["replaced"] = null
  if (previous && (previous.bucket !== page.bucket || previous.prefix !== page.prefix)) {
    const deleted = await deleteUnserved(deps, previous.bucket, previous.prefix)
    if (deleted !== null) replaced = { bucket: previous.bucket, prefix: previous.prefix, deleted }
  }
  return { page, files: files.length, bytes, replaced }
}

export interface RemoveResult {
  name: string
  removed: true
  /** the files deleted with it; null when they were kept */
  files: { bucket: string; prefix: string; deleted: number } | null
}

/** release the name, then (unless kept) delete its files, if a publish made their prefix */
export async function removePage(deps: PagesDeps, name: string, keepFiles = false): Promise<RemoveResult> {
  const page = await deps.api.page(checkName(name))
  await deps.api.pageRemove(page.name)
  if (keepFiles) return { name: page.name, removed: true, files: null }
  const deleted = await deleteUnserved(deps, page.bucket, page.prefix)
  return { name: page.name, removed: true, files: deleted === null ? null : { bucket: page.bucket, prefix: page.prefix, deleted } }
}

/** the clients pages use: the login's token, for the pages API and the storage it uploads to */
export async function pagesDeps(progress?: (message: string) => void): Promise<PagesDeps> {
  const config = await loadConfig()
  if (!config.key) throw new ApiError("pages: not logged in; run kyora login, or set KYORA_TOKEN", 0)
  return { api: new VmsClient(config), storage: new StorageClient(config.url, config.key), progress }
}

const OPTIONS = {
  name: { type: "string" },
  public: { type: "boolean" },
  spa: { type: "boolean" },
  bucket: { type: "string" },
  "keep-files": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const
type Option = keyof typeof OPTIONS

const VERBS: Record<string, { args: number; options: Option[]; usage: string }> = {
  publish: { args: 1, options: ["name", "public", "spa", "bucket"], usage: "kyora publish <dir|file> [--name N] [--public] [--spa] [--bucket B]" },
  ls: { args: 0, options: [], usage: "kyora pages ls" },
  show: { args: 1, options: [], usage: "kyora pages show <name>" },
  rm: { args: 1, options: ["keep-files"], usage: "kyora pages rm <name> [--keep-files]" },
  login: { args: 1, options: [], usage: "kyora pages login <name>" },
}
const ALIASES: Record<string, string> = { list: "ls", delete: "rm", remove: "rm" }

/** `kyora pages <verb> …`; `kyora publish …` is `kyora pages publish …` */
export async function pagesMain(argv: string[], deps?: PagesDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true; args: string[] }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    return usage((error as Error).message)
  }
  const { values, positionals } = parsed
  const [rawVerb, ...rest] = positionals
  if (values.help || !rawVerb || rawVerb === "help") {
    console.log(PAGES_HELP)
    return 0
  }
  const verb = ALIASES[rawVerb] ?? rawVerb
  const spec = VERBS[verb] ?? usage(`unknown pages command "${rawVerb}"`)
  for (const name of Object.keys(values) as Option[]) if (name !== "json" && !spec.options.includes(name)) usage(`${verb} does not take --${name}`)
  if (rest.length !== spec.args) usage(`usage: ${spec.usage}`)
  if (values.name !== undefined) checkName(values.name)
  if (values.bucket !== undefined) checkBucket(values.bucket)
  if (verb !== "publish" && verb !== "ls") checkName(rest[0]!)
  const asJson = Boolean(values.json)
  const using = deps ?? (await pagesDeps(note))

  switch (verb) {
    case "publish": {
      const result = await publishPage(using, { source: rest[0]!, name: values.name, public: values.public, spa: values.spa, bucket: values.bucket })
      if (asJson) printJson(result)
      else {
        console.log(result.page.url)
        note(`${result.page.name}: ${result.files} file${result.files === 1 ? "" : "s"}, ${formatBytes(result.bytes)}, ${result.page.private ? `private (\`kyora pages login ${result.page.name}\` signs a browser in)` : "public"}`)
      }
      return 0
    }
    case "ls": {
      const pages = await using.api.pages()
      if (asJson) printJson({ pages })
      else if (pages.length === 0) note("no pages yet: kyora publish <dir>")
      else for (const page of pages) console.log(`${page.name}\t${page.private ? "private" : "public"}\t${page.url}\t${page.updatedAt}`)
      return 0
    }
    case "show": {
      const page = await using.api.page(rest[0]!)
      if (asJson) printJson(page)
      else {
        console.log(page.url)
        console.log(`  ${page.private ? "private" : "public"}${page.spa ? " · spa" : ""} · ${page.bucket}/${page.prefix} · updated ${page.updatedAt}`)
      }
      return 0
    }
    case "rm": {
      const result = await removePage(using, rest[0]!, Boolean(values["keep-files"]))
      if (asJson) printJson(result)
      else console.log(`removed ${result.name}${result.files ? ` and ${result.files.deleted} file${result.files.deleted === 1 ? "" : "s"}` : ""}`)
      return 0
    }
    case "login": {
      const loginUrl = await using.api.pageLogin(rest[0]!)
      if (asJson) printJson({ loginUrl })
      else {
        console.log(loginUrl)
        note("open it within 60 seconds; it signs that browser in to the page")
      }
      return 0
    }
  }
  return usage(`unknown pages command "${rawVerb}"`)
}
