import { parseArgs } from "node:util"
import { ApiError, VERSION } from "./api"
import { loadConfig } from "./config"
import { note, printJson, write } from "./output"

/**
 * `kyora vms storage …`: kyora cloud's managed object storage. Private
 * buckets of the account (or org) the token acts as; inside a sandbox, a session's token reaches
 * its own prefix (`sessions/<id>/`), and KYORA_STORAGE_KEY, a scoped key, its bucket and prefix.
 */

export const STORAGE_HELP = `kyora vms storage: private object storage for your account (kyora cloud)

  kyora vms storage ls                              your buckets
  kyora vms storage ls <bucket> [prefix]            the objects in one (--limit N, --delimiter)
  kyora vms storage mb <bucket> [--region ID]       make a bucket (in your region unless you name one)
  kyora vms storage rb <bucket> [--force]           delete an empty bucket (--force: with its objects)
  kyora vms storage put <bucket> <key> <file|->     upload (large files go in parts); --content-type
  kyora vms storage get <bucket> <key> [file|-]     download (to stdout without a file, or with -)
  kyora vms storage rm <bucket> <key>               delete an object
  kyora vms storage presign <bucket> <key>          a URL for that one object, for --ttl seconds
                    [--put [--length N]] [--ttl S]  (at most 900; default 300); --put to upload
                    [--inline]                      (a session's or a scoped key gives --length); a GET
                                                    downloads, or with --inline shows media in the browser
  kyora vms storage usage [--month YYYY-MM]         this month's storage usage and cost

The key in use: KYORA_STORAGE_KEY (a scoped key, kysk_…) when it is set, else your login's (or,
in a kyora session's sandbox, the session's: keys are then under sessions/<session id>/).
Nothing is ever public: presigned URLs are for one object and at most 15 minutes. --json for JSON.`

export class StorageUsage extends Error {}
const usage = (message: string): never => {
  throw new StorageUsage(message)
}

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  region: { type: "string" },
  force: { type: "boolean" },
  put: { type: "boolean" },
  inline: { type: "boolean" },
  ttl: { type: "string" },
  length: { type: "string" },
  limit: { type: "string" },
  delimiter: { type: "boolean" },
  month: { type: "string" },
  "content-type": { type: "string" },
} as const
type Option = keyof typeof OPTIONS

const VERBS: Record<string, Option[]> = {
  ls: ["limit", "delimiter"],
  mb: ["region"],
  rb: ["force"],
  put: ["content-type"],
  get: [],
  rm: [],
  presign: ["put", "ttl", "length", "inline"],
  usage: ["month"],
}

/** the largest single PUT through kyora cloud (STORAGE_MAX_PUT_MB's default); larger goes in parts */
const SINGLE_PUT = 90 * 1000 * 1000
const PART_SIZE = 64 * 1024 * 1024
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** a bucket's name, as kyora cloud takes it: nothing else may go into a storage request's path */
export const validBucket = (name: string): boolean => BUCKET.test(name)

export const encodeKey = (key: string): string => key.split("/").map((segment) => encodeURIComponent(segment)).join("/")

interface CallOptions {
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  /** gives up on the request (and its answer's body) when aborted */
  signal?: AbortSignal
}

export class StorageClient {
  constructor(
    readonly url: string,
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, "user-agent": `kyora-vms/${VERSION}`, ...options.headers }
    let body = options.body
    if (options.json !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.json)
    }
    let response: Response
    try {
      response = await this.fetcher(`${this.url}${path}`, { method, headers, body, redirect: "manual", signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error
      throw new ApiError(`storage: can't reach ${this.url} (${error instanceof Error ? error.message : String(error)})`, 0)
    }
    if (response.ok) return response
    const problem = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new ApiError(`storage: ${problem?.message ?? `HTTP ${response.status}`}`, response.status, problem?.error)
  }

  object(bucket: string, key: string, query = ""): string {
    // a . or .. segment would be resolved away, and the request would go to some other path
    if (key.split("/").some((segment) => segment === "." || segment === "..")) throw new ApiError("storage: a key's segments can't be . or ..", 0, "invalid_request")
    return `/v1/storage/buckets/${bucket}/o/${encodeKey(key)}${query}`
  }

  /** a file (or stdin's bytes) in one PUT, or in parts when it is larger than one may be */
  async put(bucket: string, key: string, data: Blob, contentType: string | null, signal?: AbortSignal): Promise<{ key: string; size: number; etag: string }> {
    const type: Record<string, string> = contentType ? { "content-type": contentType } : {}
    if (data.size <= SINGLE_PUT) {
      return (await (await this.call("PUT", this.object(bucket, key), { body: data, headers: { "content-length": String(data.size), ...type }, signal })).json()) as { key: string; size: number; etag: string }
    }
    const started = (await (await this.call("POST", this.object(bucket, key, "?uploads"), { headers: type, signal })).json()) as { uploadId: string; maxPartBytes: number }
    const size = Math.min(PART_SIZE, started.maxPartBytes)
    const query = (extra: string) => `?uploadId=${encodeURIComponent(started.uploadId)}${extra}`
    try {
      const parts: Array<{ partNumber: number; etag: string }> = []
      for (let offset = 0, partNumber = 1; offset < data.size; offset += size, partNumber++) {
        const chunk = data.slice(offset, Math.min(offset + size, data.size))
        const answer = (await (await this.call("PUT", this.object(bucket, key, query(`&partNumber=${partNumber}`)), { body: chunk, headers: { "content-length": String(chunk.size) }, signal })).json()) as { etag: string }
        parts.push({ partNumber, etag: answer.etag })
      }
      return (await (await this.call("POST", this.object(bucket, key, query("")), { json: { parts }, signal })).json()) as { key: string; size: number; etag: string }
    } catch (error) {
      await this.call("DELETE", this.object(bucket, key, query("")), { signal: AbortSignal.timeout(30_000) }).catch(() => {})
      throw error
    }
  }

  /** every object under a prefix, page after page (up to `limit`) */
  async list(bucket: string, prefix: string, limit: number | null, delimiter: boolean, signal?: AbortSignal): Promise<{ objects: Array<{ key: string; size: number; lastModified: string }>; prefixes: string[] }> {
    const objects: Array<{ key: string; size: number; lastModified: string }> = []
    const prefixes: string[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ prefix, limit: String(Math.min(1000, limit === null ? 1000 : limit - objects.length)) })
      if (cursor) query.set("cursor", cursor)
      if (delimiter) query.set("delimiter", "/")
      const page = (await (await this.call("GET", `/v1/storage/buckets/${bucket}/o?${query}`, { signal })).json()) as { objects: typeof objects; prefixes: string[]; cursor: string | null }
      objects.push(...page.objects)
      prefixes.push(...page.prefixes)
      cursor = page.cursor
    } while (cursor && (limit === null || objects.length < limit))
    return { objects, prefixes }
  }
}

const bucketArg = (value: string | undefined, verb: string): string => {
  if (!value) return usage(`storage ${verb} needs a bucket`)
  if (!BUCKET.test(value)) return usage("a bucket's name is 3-63 characters of a-z, 0-9 and -")
  return value
}

const wholeNumber = (value: string | undefined, flag: string): number | null => {
  if (value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) usage(`${flag} takes a whole number`)
  return parsed
}

const human = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** `presign`'s request body: a GET (a download, or `inline` for media) or a PUT, its length signed when given */
export function presignRequest(key: string, options: { put?: boolean; ttl: number | null; length: number | null; inline?: boolean }): Record<string, unknown> {
  return {
    key,
    method: options.put ? "PUT" : "GET",
    ...(options.ttl !== null ? { ttlSeconds: options.ttl } : {}),
    ...(options.length !== null ? { contentLength: options.length } : {}),
    ...(options.inline ? { inline: true } : {}),
  }
}

export async function storageMain(argv: string[], env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true; args: string[] }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    return usage((error as Error).message)
  }
  const { values, positionals } = parsed
  const [verb, ...rest] = positionals
  if (values.help || !verb || verb === "help") {
    console.log(STORAGE_HELP)
    return 0
  }
  const allowed = VERBS[verb] ?? usage(`unknown storage command "${verb}"; run \`kyora vms storage --help\``)
  for (const name of Object.keys(values) as Option[]) if (name !== "json" && !allowed.includes(name)) usage(`storage ${verb} does not take --${name}`)
  if (verb === "presign" && values.length !== undefined && !values.put) usage("--length is for --put")
  if (verb === "presign" && values.inline && values.put) usage("--inline is for a GET (without --put)")
  const asJson = Boolean(values.json)
  const config = await loadConfig()
  const key = env.KYORA_STORAGE_KEY?.trim() || config.key
  if (!key) throw new ApiError("storage: no key; run kyora vms login, or set KYORA_STORAGE_KEY", 0)
  const client = new StorageClient(config.url, key, fetcher)

  switch (verb) {
    case "ls": {
      if (rest.length === 0) {
        const { buckets } = (await (await client.call("GET", "/v1/storage/buckets")).json()) as { buckets: Array<{ name: string; region: string; createdAt: string }> }
        if (asJson) printJson({ buckets })
        else if (buckets.length === 0) note("no buckets yet: kyora vms storage mb <name>")
        else for (const bucket of buckets) console.log(`${bucket.name}\t${bucket.region}\t${bucket.createdAt}`)
        return 0
      }
      if (rest.length > 2) usage("storage ls takes a bucket and a prefix at most")
      const listed = await client.list(bucketArg(rest[0], "ls"), rest[1] ?? "", wholeNumber(values.limit, "--limit"), Boolean(values.delimiter))
      if (asJson) printJson(listed)
      else {
        for (const prefix of listed.prefixes) console.log(`${"".padStart(10)}  ${prefix}`)
        for (const object of listed.objects) console.log(`${human(object.size).padStart(10)}  ${object.key}`)
      }
      return 0
    }
    case "mb": {
      if (rest.length !== 1) usage("usage: kyora vms storage mb <bucket> [--region ID]")
      const made = (await (await client.call("POST", "/v1/storage/buckets", { json: { name: bucketArg(rest[0], "mb"), ...(values.region ? { region: values.region } : {}) } })).json()) as { name: string; region: string }
      if (asJson) printJson(made)
      else console.log(`${made.name} (${made.region})`)
      return 0
    }
    case "rb": {
      if (rest.length !== 1) usage("usage: kyora vms storage rb <bucket> [--force]")
      const bucket = bucketArg(rest[0], "rb")
      let deleted = 0
      for (;;) {
        const answer = (await (await client.call("DELETE", `/v1/storage/buckets/${bucket}${values.force ? "?force" : ""}`)).json()) as { done: boolean; objectsDeleted: number }
        deleted += answer.objectsDeleted
        if (answer.done) break
        if (!asJson) note(`${deleted} objects deleted so far…`)
      }
      if (asJson) printJson({ name: bucket, deleted: true, objectsDeleted: deleted })
      else console.log(`deleted ${bucket}${deleted > 0 ? ` and ${deleted} objects` : ""}`)
      return 0
    }
    case "put": {
      if (rest.length !== 3) usage("usage: kyora vms storage put <bucket> <key> <file|->")
      const [bucket, objectKey, source] = rest as [string, string, string]
      const data = source === "-" ? new Blob([await Bun.stdin.arrayBuffer()]) : Bun.file(source)
      if (source !== "-" && !(await (data as ReturnType<typeof Bun.file>).exists())) throw new Error(`no such file: ${source}`)
      const stored = await client.put(bucketArg(bucket, "put"), objectKey, data, values["content-type"] ?? (source === "-" ? null : (data as ReturnType<typeof Bun.file>).type.split(";")[0] || null))
      if (asJson) printJson(stored)
      else console.log(`${stored.key}  ${human(stored.size)}`)
      return 0
    }
    case "get": {
      if (rest.length < 2 || rest.length > 3) usage("usage: kyora vms storage get <bucket> <key> [file|-]")
      const [bucket, objectKey, target] = rest as [string, string, string | undefined]
      const response = await client.call("GET", client.object(bucketArg(bucket, "get"), objectKey))
      if (!target || target === "-") {
        const reader = response.body?.getReader()
        if (reader) for (let part = await reader.read(); !part.done; part = await reader.read()) await write(process.stdout, part.value)
      } else {
        const size = await Bun.write(target, response)
        if (!asJson) note(`${target}  ${human(size)}`)
        else printJson({ key: objectKey, file: target, size })
      }
      return 0
    }
    case "rm": {
      if (rest.length !== 2) usage("usage: kyora vms storage rm <bucket> <key>")
      await client.call("DELETE", client.object(bucketArg(rest[0], "rm"), rest[1]!))
      if (asJson) printJson({ key: rest[1], deleted: true })
      return 0
    }
    case "presign": {
      if (rest.length !== 2) usage("usage: kyora vms storage presign <bucket> <key> [--put [--length N]] [--ttl S]")
      const signed = (await (await client.call("POST", `/v1/storage/buckets/${bucketArg(rest[0], "presign")}/presign`, {
        json: presignRequest(rest[1]!, { put: values.put, ttl: wholeNumber(values.ttl, "--ttl"), length: wholeNumber(values.length, "--length"), inline: values.inline }),
      })).json()) as { url: string; expiresAt: string; key: string }
      if (asJson) printJson(signed)
      else {
        console.log(signed.url)
        note(`${values.put ? "PUT" : "GET"} ${signed.key} until ${signed.expiresAt}`)
      }
      return 0
    }
    case "usage": {
      if (rest.length > 0) usage("storage usage takes no arguments")
      if (values.month !== undefined && !/^\d{4}-\d{2}$/.test(values.month)) usage("--month is YYYY-MM")
      const answer = (await (await client.call("GET", `/v1/usage${values.month ? `?month=${values.month}` : ""}`)).json()) as {
        storage: { month: string; regions: Array<{ region: string; gbMonths: number; classA: number; classB: number; r2Usd: number; usd: number }>; total: { usd: number; r2Usd: number }; cap: { bytes: number; usedBytes: number }; meteredThrough: string | null }
      }
      if (asJson) {
        printJson(answer)
        return 0
      }
      const { storage } = answer
      console.log(`storage, ${storage.month} (${storage.meteredThrough ? `usage through ${storage.meteredThrough}` : "no usage recorded yet"}): $${storage.total.usd.toFixed(2)}`)
      for (const line of storage.regions) console.log(`  ${line.region}\t${line.gbMonths.toFixed(3)} GB-months\t${line.classA} writes and lists\t${line.classB} reads\t$${line.usd.toFixed(2)}`)
      console.log(`cap: ${human(storage.cap.usedBytes)} of ${human(storage.cap.bytes)}`)
      return 0
    }
  }
  return usage(`unknown storage command "${verb}"`)
}
