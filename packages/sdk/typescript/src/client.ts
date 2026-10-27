import { KyoraError } from "./errors.js"
import { Exec } from "./exec.js"
import { OPERATIONS, type OperationId, type Operations } from "./generated/operations.js"
import type {
  CreateSandboxRequest,
  CreateSnapshotRequest,
  CreateTokenRequest,
  CreateTokenResponse,
  CreateUploadResponse,
  ExposePortRequest,
  Health,
  HeldPortList,
  LoginResponse,
  Me,
  NetworkUpdateRequest,
  NetworkUpdateResponse,
  Port,
  PortList,
  PortWithSandbox,
  PushFilesResponse,
  QueueTicket,
  RegionList,
  ResolveResponse,
  Sandbox,
  SandboxList,
  SandboxStats,
  SetRegionResponse,
  Snapshot,
  SnapshotList,
  Token,
  TokenList,
  UpdateSandboxRequest,
  UploadPartResponse,
  Usage,
} from "./generated/schemas.js"
import { callerKey, DEFAULT_BASE_URL, DEFAULT_RETRY, endOf, pause, readJson, timeoutError, Transport, USER_AGENT, type CallOptions, type RequestParts, type RetryOptions, type WaitOptions } from "./http.js"
import { follow, labelQuery, matching, type ListOptions, type ListPage } from "./paging.js"
import { packFiles, unpack, type FileInput, type TarEntry } from "./tar.js"

export interface KyoraOptions {
  /** a kyora token (kyora_...); defaults to the KYORA_TOKEN environment variable */
  token?: string
  /** default https://cloud.kyora.sh */
  baseUrl?: string
  /** the region creates and restores go to when they name none; unset, kyora picks */
  region?: string
  /** a fetch of your own (a proxy, a test double); default the global fetch */
  fetch?: typeof fetch
  /** how long a call that does not stream may take, retries included (default 30 s) */
  timeoutMs?: number
  /** how failed calls are repeated; false: never */
  retry?: RetryOptions | false
  userAgent?: string
}

export interface CreateOptions extends CallOptions {
  /**
   * The create's Idempotency-Key; a fresh one by default, the same for every retry of this call. A
   * create cut short by its deadline or an abort may still have made its sandbox: the same create
   * with the same key answers that sandbox instead of making another.
   */
  idempotencyKey?: string
  /** each ticket while a create with `wait` waits in line for room */
  onQueued?: (ticket: QueueTicket) => void
}

export interface PollOptions<T> extends WaitOptions {
  /** each state while it is waited on */
  onProgress?: (current: T) => void
  /** the first wait between polls, doubled up to 5 s (default 1 s) */
  intervalMs?: number
}

export interface UploadOptions extends CallOptions {
  /** where the archive unpacks, under /work (default /work) */
  dest?: string
}

/** the arguments of a raw call: the operation's path parameters, query, body and headers */
export type CallInput<O extends OperationId> = ((typeof OPERATIONS)[O]["pathParams"] extends readonly [] ? { path?: Record<string, never> } : { path: Operations[O]["path"] }) & {
  query?: Operations[O]["query"]
  body?: Operations[O]["body"]
  headers?: Operations[O]["headers"]
  contentType?: string
}

/** JSON operations answer their parsed body; streamed, binary and HEAD ones the Response, headers and all */
export type CallResult<O extends OperationId> = (typeof OPERATIONS)[O]["method"] extends "HEAD" ? Response : (typeof OPERATIONS)[O]["response"] extends "json" | "none" ? Operations[O]["response"] : Response

const CREATE_TIMEOUT_MS = 120_000
const QUEUE_POLL_S = 25
const QUEUE_GRACE_MS = 60_000
/** failed polls in a row before the wait in line gives up */
const QUEUE_RETRIES = 8
const POLL_TIMEOUT_MS = 60 * 60_000
/** an archive up to this size goes up in one PUT; a larger one in parts */
const SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024

/** one request per part of a large upload may take this long */
const TRANSFER_TIMEOUT_MS = 10 * 60_000
/** the part sizes the SDK accepts from kyora: a part is held in memory whole */
const MIN_PART_BYTES = 64 * 1024
const MAX_PART_BYTES = 256 * 1024 * 1024

/** an archive read in parts of a given size, from bytes or a stream; `unread` puts a part back */
interface PartSource {
  next(size: number): Promise<Uint8Array>
  unread(part: Uint8Array): void
  cancel(): void
}

function bytesSource(bytes: Uint8Array): PartSource {
  let offset = 0
  return {
    next: async (size) => {
      const part = bytes.subarray(offset, offset + size)
      offset += part.length
      return part
    },
    unread: (part) => {
      offset -= part.length
    },
    cancel: () => {},
  }
}

function streamSource(stream: ReadableStream<Uint8Array>): PartSource {
  const reader = stream.getReader()
  let held: Uint8Array[] = []
  let heldBytes = 0
  let done = false
  return {
    async next(size) {
      while (heldBytes < size && !done) {
        const chunk = await reader.read()
        if (chunk.done) done = true
        else if (chunk.value.length > 0) {
          held.push(chunk.value)
          heldBytes += chunk.value.length
        }
      }
      const out = new Uint8Array(Math.min(size, heldBytes))
      let filled = 0
      const rest: Uint8Array[] = []
      for (const chunk of held) {
        const take = Math.min(chunk.length, out.length - filled)
        out.set(chunk.subarray(0, take), filled)
        filled += take
        if (take < chunk.length) rest.push(chunk.subarray(take))
      }
      held = rest
      heldBytes -= out.length
      return out
    },
    unread(part) {
      held.unshift(part)
      heldBytes += part.length
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  }
}

/** how long the cleanup of a failed upload may take */
const ABORT_UPLOAD_TIMEOUT_MS = 5_000

/** `promise`, or a timeout at `until`, or the signal's reason once it aborts */
function bounded<T>(promise: Promise<T>, until: number, signal: AbortSignal | undefined, operation: string): Promise<T> {
  if (!Number.isFinite(until) && !signal) return promise
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = Number.isFinite(until) ? setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      reject(timeoutError(operation))
    }, Math.max(0, until - Date.now())) : undefined
    if (signal?.aborted) return stop()
    signal?.addEventListener("abort", stop, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        reject(error)
      },
    )
  })
}

/** waits for `promise` at most `ms` (no wait at all for 0 or less) */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  if (!(ms > 0)) return
  if (!Number.isFinite(ms)) {
    await promise
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

/** a DELETE that is false when the thing was already gone, unless an earlier try of this call may have deleted it */
async function deleted(transport: Transport, operation: "deleteSandbox" | "deleteSnapshot", path: { id: string }, options: CallOptions): Promise<boolean> {
  return transport.read(operation, { path, accept: [404] }, options, async (response, attempt) => {
    await response.body?.cancel().catch(() => {})
    return response.status !== 404 || attempt > 1
  })
}

/** a poll that failed on the way, not with the create's outcome: nothing answered, a gateway, or a restart (do_reset) */
const lostOnTheWay = (error: unknown) =>
  error instanceof KyoraError && error.code !== "timeout" && (error.status === 0 || error.status === 502 || error.status === 504 || error.code === "do_reset" || error.code.startsWith("http_"))

const isTicket = (body: unknown): body is QueueTicket => typeof body === "object" && body !== null && (body as { status?: unknown }).status === "queued" && typeof (body as { ticket?: unknown }).ticket === "string"

function environmentToken(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.KYORA_TOKEN || undefined
}

const pageOf = <T>(items: T[] | undefined, next: string | undefined): ListPage<T> => ({ items: items ?? [], nextCursor: next || null })

export class Kyora {
  readonly transport: Transport
  readonly region: string | undefined
  readonly sandboxes: Sandboxes
  readonly exec: Exec
  readonly files: Files
  readonly snapshots: Snapshots
  readonly ports: Ports
  readonly tokens: Tokens

  constructor(options: KyoraOptions = {}) {
    const fetcher = options.fetch ?? globalThis.fetch
    if (typeof fetcher !== "function") throw new TypeError("no fetch: pass one as options.fetch")
    this.transport = new Transport(
      {
        baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        fetch: fetcher,
        timeoutMs: options.timeoutMs ?? 30_000,
        retry: options.retry === false ? false : { ...DEFAULT_RETRY, ...options.retry },
        userAgent: options.userAgent ?? USER_AGENT,
      },
      options.token ?? environmentToken(),
    )
    this.region = options.region
    this.sandboxes = new Sandboxes(this)
    this.exec = new Exec(this.transport)
    this.files = new Files(this.transport)
    this.snapshots = new Snapshots(this)
    this.ports = new Ports(this.transport)
    this.tokens = new Tokens(this.transport)
  }

  toJSON(): Record<string, unknown> {
    return { ...this.transport.toJSON(), region: this.region ?? null }
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Kyora { baseUrl: ${JSON.stringify(this.transport.config.baseUrl)}, region: ${JSON.stringify(this.region ?? null)} }`
  }

  /** kyora's health and free capacity; needs no token */
  health(options: CallOptions = {}): Promise<Health> {
    return this.transport.json("getHealth", {}, options)
  }

  regions(options: CallOptions = {}): Promise<RegionList> {
    return this.transport.json("listRegions", {}, options)
  }

  /** the account the token acts for, with its limits */
  me(options: CallOptions = {}): Promise<Me> {
    return this.transport.json("getMe", {}, options)
  }

  /** usage and its estimated cost, for `month` (YYYY-MM, default this one) */
  usage(month?: string, options: CallOptions = {}): Promise<Usage> {
    return this.transport.json("getUsage", { query: { month } }, options)
  }

  /** where the account's creates go when they name no region; null: kyora picks */
  async setDefaultRegion(region: string | null, options: CallOptions = {}): Promise<string | null> {
    return (await this.transport.json<SetRegionResponse>("setDefaultRegion", { body: { region } }, options)).region
  }

  /**
   * Any operation of the API by its operationId, for what the SDK has no helper for yet. Errors,
   * retries and idempotency keys work as for every other call.
   */
  async call<O extends OperationId>(operation: O, input: CallInput<O>, options: CallOptions = {}): Promise<CallResult<O>> {
    const parts: RequestParts = { body: input.body, ...(input.contentType ? { contentType: input.contentType } : {}) }
    if (input.path) parts.path = input.path as Record<string, string | number>
    if (input.query) parts.query = input.query as RequestParts["query"]
    const headers = { ...options.headers, ...(input.headers as Record<string, string> | undefined) }
    const spec = OPERATIONS[operation]
    if (spec.method !== "HEAD" && (spec.response === "json" || spec.response === "none")) return (await this.transport.json(operation, parts, { ...options, headers })) as CallResult<O>
    return (await this.transport.send(operation, parts, { ...options, headers })) as CallResult<O>
  }
}

/** asks `next` again, backing off from 1 s to 5 s, until `done`; a deadline that passes is a timeout */
async function poll<T>(operation: string, current: T, next: (call: CallOptions) => Promise<T>, done: (current: T) => boolean, options: PollOptions<T>): Promise<T> {
  const until = endOf(options, POLL_TIMEOUT_MS)
  const call: CallOptions = { deadline: until, ...(options.signal ? { signal: options.signal } : {}) }
  let delay = options.intervalMs ?? 1_000
  options.onProgress?.(current)
  while (!done(current)) {
    if (Date.now() + delay >= until) throw timeoutError(operation)
    await pause(delay, options.signal)
    delay = Math.min(5_000, delay * 2)
    current = await next(call)
    options.onProgress?.(current)
  }
  return current
}

export class Sandboxes {
  constructor(private readonly kyora: Kyora) {}

  private get transport(): Transport {
    return this.kyora.transport
  }

  /**
   * Creates a sandbox, under an Idempotency-Key, so a retry never creates a second one. With
   * `wait` (seconds) a create kyora has no room for waits in line: this long-polls its ticket until
   * the sandbox is placed, and takes it out of line at the deadline or on abort.
   */
  async create(spec: CreateSandboxRequest = {}, options: CreateOptions = {}): Promise<Sandbox> {
    const body: CreateSandboxRequest = this.kyora.region !== undefined && spec.region === undefined ? { ...spec, region: this.kyora.region } : spec
    const until = endOf(options, spec.wait ? spec.wait * 1000 + QUEUE_GRACE_MS : CREATE_TIMEOUT_MS)
    const parts: RequestParts = { body }
    if (options.idempotencyKey) parts.idempotencyKey = options.idempotencyKey
    // read inside the call: a body that breaks off is asked again, under the same Idempotency-Key
    const { status, answer } = await this.transport.read("createSandbox", parts, { ...options, timeoutMs: Infinity, deadline: until }, async (response) => ({ status: response.status, answer: await readJson<unknown>("createSandbox", response) }))
    if (status === 202 && isTicket(answer)) return this.waitInLine(answer, until, options)
    return answer as Sandbox
  }

  private async waitInLine(ticket: QueueTicket, until: number, options: CreateOptions): Promise<Sandbox> {
    options.onQueued?.(ticket)
    let failures = 0
    try {
      for (;;) {
        const left = until - Date.now()
        if (left <= 1_000) throw timeoutError("createSandbox")
        const wait = Math.max(1, Math.min(QUEUE_POLL_S, Math.floor(left / 1000) - 1))
        let status: number
        let answer: unknown
        try {
          // never repeated as is: an error the ticket answers is the create's own outcome; a body that breaks off is a poll lost on the way
          ;({ status, answer } = await this.transport.read("getQueueTicket", { path: { ticket: ticket.ticket }, query: { wait } }, { signal: options.signal, timeoutMs: (wait + 30) * 1000, deadline: until, retry: false }, async (response) => ({ status: response.status, answer: await readJson<unknown>("getQueueTicket", response) })))
        } catch (error) {
          if (options.signal?.aborted || !lostOnTheWay(error) || ++failures > QUEUE_RETRIES) throw error
          await pause(Math.min(5_000, 250 * 2 ** failures, Math.max(0, until - Date.now())), options.signal)
          continue
        }
        failures = 0
        if (status !== 202 || !isTicket(answer)) return answer as Sandbox
        options.onQueued?.(answer)
      }
    } catch (error) {
      // out of line, so kyora never places a sandbox nobody waits for
      await this.cancelTicket(ticket.ticket).catch(() => undefined)
      throw error
    }
  }

  /** a queued create's ticket; `wait` long-polls up to that many seconds (at most 30) */
  async ticket(ticket: string, wait?: number, options: CallOptions = {}): Promise<QueueTicket | Sandbox> {
    return this.transport.json("getQueueTicket", { path: { ticket }, query: { wait } }, options)
  }

  async cancelTicket(ticket: string, options: CallOptions = {}): Promise<void> {
    await this.transport.json("cancelQueueTicket", { path: { ticket } }, options)
  }

  /** a sandbox by its id, its name, or a unique prefix of its id */
  get(id: string, options: CallOptions = {}): Promise<Sandbox> {
    return this.transport.json("getSandbox", { path: { id } }, options)
  }

  /** one page, newest first */
  async list(options: ListOptions = {}): Promise<ListPage<Sandbox>> {
    const answer = await this.transport.json<SandboxList>("listSandboxes", { query: { label: labelQuery(options.labels), limit: options.limit, cursor: options.cursor } }, options)
    return pageOf(matching(answer.sandboxes, options.labels), answer.next_cursor)
  }

  /** every sandbox matching `labels`, following next_cursor from `cursor` on */
  iterate(options: ListOptions = {}): AsyncGenerator<Sandbox> {
    return follow("listSandboxes", (cursor) => this.list({ ...options, ...(cursor === undefined ? {} : { cursor }) }), options.cursor)
  }

  /** live resource samples of every running sandbox */
  stats(options: CallOptions = {}): Promise<SandboxStats> {
    return this.transport.json("listSandboxes", { query: { stats: "1" } }, options)
  }

  /** rename, change the TTL, grow the disk, or resize */
  update(id: string, change: UpdateSandboxRequest, options: CallOptions = {}): Promise<Sandbox> {
    return this.transport.json("updateSandbox", { path: { id }, body: change }, options)
  }

  /** the id a name or prefix stands for */
  resolve(id: string, options: CallOptions = {}): Promise<ResolveResponse> {
    return this.transport.json("resolveSandbox", { path: { id } }, options)
  }

  setNetwork(id: string, change: NetworkUpdateRequest, options: CallOptions = {}): Promise<NetworkUpdateResponse> {
    return this.transport.json("setSandboxNetwork", { path: { id }, body: change }, options)
  }

  /** destroys a sandbox; false when it was already gone (a retry that finds it gone counts as this call's) */
  delete(id: string, options: CallOptions = {}): Promise<boolean> {
    return deleted(this.transport, "deleteSandbox", { id }, options)
  }

  /** polls until the sandbox runs (default for up to an hour); one that failed, was lost or destroyed is an error */
  async waitUntilRunning(sandbox: string | Sandbox, options: PollOptions<Sandbox> = {}): Promise<Sandbox> {
    const deadline = endOf(options, POLL_TIMEOUT_MS)
    const first = typeof sandbox === "string" ? await this.get(sandbox, { deadline, ...(options.signal ? { signal: options.signal } : {}) }) : sandbox
    return poll("getSandbox", first, (call) => this.get(first.id, call), (current) => {
      if (current.status === "failed" || current.status === "lost" || current.status === "destroyed") {
        throw new KyoraError({ code: "sandbox_ended", status: 0, message: `sandbox ${first.id} is ${current.status}`, operation: "getSandbox", class: "conflict", retryable: false })
      }
      return current.status === "running"
    }, { ...options, deadline })
  }
}

export class Snapshots {
  constructor(private readonly kyora: Kyora) {}

  private get transport(): Transport {
    return this.kyora.transport
  }

  /** Takes a snapshot of a sandbox and, unless `wait: false`, polls until it is ready. */
  async create(sandbox: string, request: CreateSnapshotRequest = {}, options: PollOptions<Snapshot> & CallOptions & { wait?: boolean } = {}): Promise<Snapshot> {
    const deadline = endOf(options, POLL_TIMEOUT_MS)
    const snapshot = await this.transport.json<Snapshot>("createSnapshot", { path: { id: sandbox }, body: request }, { ...options, timeoutMs: CREATE_TIMEOUT_MS, deadline })
    if (options.wait === false) return snapshot
    return poll("getSnapshot", snapshot, (call) => this.get(snapshot.id, call), (current) => {
      if (current.status === "failed") throw new KyoraError({ code: "snapshot_failed", status: 0, message: `snapshot ${current.id} failed: ${current.error ?? "no reason given"}`, operation: "getSnapshot" })
      if (current.status === "deleted") throw new KyoraError({ code: "not_found", status: 404, message: `snapshot ${current.id} was deleted`, operation: "getSnapshot" })
      return current.status === "ready"
    }, { ...options, deadline })
  }

  get(id: string, options: CallOptions = {}): Promise<Snapshot> {
    return this.transport.json("getSnapshot", { path: { id } }, options)
  }

  async list(options: ListOptions = {}): Promise<ListPage<Snapshot>> {
    const answer = await this.transport.json<SnapshotList>("listSnapshots", { query: { label: labelQuery(options.labels), limit: options.limit, cursor: options.cursor } }, options)
    return pageOf(answer.snapshots, answer.next_cursor)
  }

  iterate(options: ListOptions = {}): AsyncGenerator<Snapshot> {
    return follow("listSnapshots", (cursor) => this.list({ ...options, ...(cursor === undefined ? {} : { cursor }) }), options.cursor)
  }

  /** false when it was already gone (a retry that finds it gone counts as this call's) */
  delete(id: string, options: CallOptions = {}): Promise<boolean> {
    return deleted(this.transport, "deleteSnapshot", { id }, options)
  }

  /**
   * A new sandbox from a snapshot, polled until it runs (unless `wait: false`). One that fails or
   * runs out of time is destroyed, so nothing half restored is left behind, unless you passed your
   * own `idempotencyKey` (or Idempotency-Key header): the same key answers the sandbox an earlier
   * restore made, which may be someone else's, so it is never destroyed. The wait's KyoraError then
   * carries its `sandboxId` (an abort throws the signal's reason as it is; `onProgress` has seen the
   * sandbox by then).
   */
  async restore(snapshot: string, spec: Omit<CreateSandboxRequest, "fromSnapshot" | "image"> = {}, options: CreateOptions & PollOptions<Sandbox> & { wait?: boolean } = {}): Promise<Sandbox> {
    const deadline = endOf(options, POLL_TIMEOUT_MS)
    const { timeoutMs: _whole, ...create } = options
    const key = callerKey("createSandbox", options.idempotencyKey, options.headers)
    const sandbox = await this.kyora.sandboxes.create({ ...spec, fromSnapshot: snapshot }, { ...create, ...(key ? { idempotencyKey: key } : {}), deadline })
    if (options.wait === false) return sandbox
    try {
      return await this.kyora.sandboxes.waitUntilRunning(sandbox, { ...options, deadline })
    } catch (error) {
      if (key) {
        if (error instanceof KyoraError) error.sandboxId = sandbox.id
        throw error
      }
      await this.kyora.sandboxes.delete(sandbox.id).catch(() => false)
      throw error
    }
  }
}

export class Files {
  constructor(private readonly transport: Transport) {}

  /** writes files into the sandbox, as one archive unpacked at `dest` */
  upload(sandbox: string, files: readonly FileInput[] | Record<string, string | Uint8Array>, options: UploadOptions = {}): Promise<PushFilesResponse> {
    const list: FileInput[] = Array.isArray(files) ? [...files] : Object.entries(files).map(([path, data]) => ({ path, data }))
    return this.uploadTar(sandbox, packFiles(list), options)
  }

  /**
   * Unpacks a tar (or, with contentType application/zstd, a tar.zst) at `dest`. Up to 64 MiB it
   * goes up in one PUT, past that in parts; a stream is read part by part, never held whole.
   * `timeoutMs` and `deadline` bound the whole upload.
   */
  async uploadTar(sandbox: string, archive: Uint8Array | ReadableStream<Uint8Array>, options: UploadOptions & { contentType?: "application/x-tar" | "application/zstd" } = {}): Promise<PushFilesResponse> {
    const contentType = options.contentType ?? "application/x-tar"
    const deadline = endOf(options)
    const call: CallOptions = { deadline, timeoutMs: TRANSFER_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}), ...(options.retry !== undefined ? { retry: options.retry } : {}), ...(options.headers ? { headers: options.headers } : {}) }
    const source = archive instanceof Uint8Array ? bytesSource(archive) : streamSource(archive)
    // a stalled stream ends at the deadline or the abort, like a request does
    const read = (size: number) => bounded(source.next(size), deadline, options.signal, "uploadTar")
    let upload: CreateUploadResponse | null = null
    try {
      // a first part that is the whole archive goes up as it is
      const first = await read(SINGLE_UPLOAD_BYTES + 1)
      if (first.length <= SINGLE_UPLOAD_BYTES) {
        return await this.transport.json<PushFilesResponse>("pushFiles", { path: { id: sandbox }, query: { dest: options.dest }, body: first, contentType }, call)
      }
      upload = await this.transport.json<CreateUploadResponse>("createUpload", { path: { id: sandbox }, body: { ...(options.dest ? { dest: options.dest } : {}), contentType } }, call)
      const size = Math.min(upload.partSize, upload.maxPartBytes)
      if (!Number.isInteger(size) || size < MIN_PART_BYTES || size > MAX_PART_BYTES) {
        throw new KyoraError({ code: "bad_response", status: 0, message: `createUpload: kyora asked for ${size}-byte parts`, operation: "createUpload" })
      }
      source.unread(first)
      const parts: Array<{ n: number; etag: string }> = []
      for (let n = 1; ; n++) {
        const part = await read(size)
        if (part.length === 0) break
        const answer = await this.transport.json<UploadPartResponse>("uploadPart", { path: { id: sandbox, upload: upload.uploadId, n }, body: part }, call)
        parts.push({ n, etag: answer.etag })
      }
      return await this.transport.json<PushFilesResponse>("completeUpload", { path: { id: sandbox, upload: upload.uploadId }, body: { parts } }, call)
    } catch (error) {
      source.cancel()
      if (upload) {
        // best effort, bounded on its own; the caller hears back by its deadline, at once after an abort
        const abort = this.transport.json("abortUpload", { path: { id: sandbox, upload: upload.uploadId } }, { retry: false, timeoutMs: ABORT_UPLOAD_TIMEOUT_MS }).catch(() => undefined)
        await settleWithin(abort, options.signal?.aborted ? 0 : deadline - Date.now())
      }
      throw error
    }
  }

  /** the tar of `paths` as it streams in */
  async downloadTar(sandbox: string, paths: readonly string[], options: CallOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const response = await this.transport.send("pullFiles", { path: { id: sandbox }, query: { path: paths } }, options)
    if (!response.body) throw new KyoraError({ code: "bad_response", status: response.status, message: "pullFiles: the answer had no body", operation: "pullFiles" })
    return response.body
  }

  /** the entries of `paths`, read whole into memory; for large trees, use downloadTar */
  async download(sandbox: string, paths: readonly string[], options: CallOptions = {}): Promise<TarEntry[]> {
    // read inside the call, so a download that breaks off is fetched again
    return this.transport.read("pullFiles", { path: { id: sandbox }, query: { path: paths } }, options, async (response) => {
      const archive = new Uint8Array(await response.arrayBuffer())
      try {
        return unpack(archive)
      } catch (error) {
        throw new KyoraError({ code: "bad_response", status: response.status, message: `pullFiles: ${error instanceof Error ? error.message : String(error)}`, operation: "pullFiles", retryable: true, cause: error })
      }
    })
  }

  /** one file's bytes */
  async read(sandbox: string, path: string, options: CallOptions = {}): Promise<Uint8Array> {
    const file = (await this.download(sandbox, [path], options)).find((entry) => entry.type === "file")
    if (!file) throw new KyoraError({ code: "not_found", status: 404, message: `pullFiles: ${path} is not a file`, operation: "pullFiles" })
    return file.data
  }
}

export class Ports {
  constructor(private readonly transport: Transport) {}

  /** a URL for a port of the sandbox; `public` needs no login */
  expose(sandbox: string, port: number, options: Omit<ExposePortRequest, "port"> & CallOptions = {}): Promise<Port> {
    const { name, public: open, trusted, ...call } = options
    const body: ExposePortRequest = { port, ...(name !== undefined ? { name } : {}), ...(open !== undefined ? { public: open } : {}), ...(trusted !== undefined ? { trusted } : {}) }
    return this.transport.json("exposePort", { path: { id: sandbox }, body }, call)
  }

  async list(sandbox: string, options: CallOptions = {}): Promise<Port[]> {
    return (await this.transport.json<PortList>("listSandboxPorts", { path: { id: sandbox } }, options)).ports
  }

  /** every name the account holds, with the sandbox it points at */
  async held(options: CallOptions = {}): Promise<PortWithSandbox[]> {
    return (await this.transport.json<HeldPortList>("listPorts", {}, options)).ports
  }

  async unexpose(sandbox: string, label: string, options: CallOptions = {}): Promise<void> {
    await this.transport.json("unexposePort", { path: { id: sandbox, label } }, options)
  }

  /** gives a held name up */
  async release(label: string, options: CallOptions = {}): Promise<void> {
    await this.transport.json("deletePort", { path: { label } }, options)
  }

  /** a one-time login URL for a private port */
  login(sandbox: string, label: string, options: CallOptions = {}): Promise<LoginResponse> {
    return this.transport.json("createPortLogin", { path: { id: sandbox, label } }, options)
  }
}

export interface TokenScope {
  /** an organization's tokens instead of your own */
  org?: string
}

export class Tokens {
  constructor(private readonly transport: Transport) {}

  async list(options: TokenScope & CallOptions = {}): Promise<Token[]> {
    const answer = options.org ? await this.transport.json<TokenList>("listOrgTokens", { path: { org: options.org } }, options) : await this.transport.json<TokenList>("listTokens", {}, options)
    return answer.tokens
  }

  /** a new token; its secret is in the answer only */
  create(request: CreateTokenRequest, options: TokenScope & CallOptions = {}): Promise<CreateTokenResponse> {
    return options.org ? this.transport.json("createOrgToken", { path: { org: options.org }, body: request }, options) : this.transport.json("createToken", { body: request }, options)
  }

  /** revokes a token */
  async delete(id: string, options: TokenScope & CallOptions = {}): Promise<void> {
    if (options.org) await this.transport.json("deleteOrgToken", { path: { org: options.org, id } }, options)
    else await this.transport.json("deleteToken", { path: { id } }, options)
  }
}
