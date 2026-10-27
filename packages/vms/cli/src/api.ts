import { friendlyName, resolveDestructiveTarget, validName } from "./names.js"
import { version } from "../package.json"
import { DEFAULT_URL, originOf, PLATFORM_TOKEN_PREFIX, VMD_KEY_PREFIX, type Config } from "./client-config.js"
import { formatMs } from "./units.js"
import { notePrefix } from "./note-name.js"
import type { SandboxStatsResponse } from "./stats-types.js"
import type { Deployment, DeploymentCreate, DeploymentList, DeploymentView, ProjectCreate, ProjectList, ProjectView } from "../../shared/deploys.js"
export type { SandboxSample, SandboxStats, SandboxStatsResponse } from "./stats-types.js"

export const VERSION: string = version

/**
 * A view share. `token`, `url` and `wsUrl` come only in the create's answer: `url` is the
 * viewer page with the token in its fragment (`https://view.kyora.run/s#kshare_…`); `wsUrl` is its socket, to
 * which the token goes as the first message.
 */
/** another X display in the sandbox, by its socket's path, and its xauthority file if it needs a cookie */
export interface ShareDisplay {
  socket: string
  xauthority?: string
}

export interface Share {
  id: string
  token?: string
  url?: string
  wsUrl?: string
  stream: "screen" | "tty"
  session: string | null
  /** a screen share's display: null for kyora's own desktop */
  display?: ShareDisplay | null
  /** a screen share's quality: high (every change, 30 fps and more) unless low was asked for */
  quality?: "high" | "low"
  /**
   * how a screen share is served: `vnc` (each viewer its own RFB, the default) or `broadcast` (the display encoded
   * once as H.264 and sent to every viewer, for an audience)
   */
  mode?: "vnc" | "broadcast"
  /** a broadcast share's live input: a printable key `masked` (the default) or its character (`full`, the owner's choice) */
  keys?: "masked" | "full"
  /** a broadcast share recorded into one of the owner's buckets (`record`): where, and how it goes */
  recording?: ShareRecording
  expiresAt: string
}

/** a share's recording: fMP4 segments, an HLS playlist and a manifest in `path` */
export interface ShareRecording {
  state: "recording" | "finalizing" | "done" | "incomplete" | "failed"
  bucket: string
  prefix: string
  path: string
  playlist: string
  manifest: string
  startedAt: string | null
  startedAtUs: number | null
  durationMs: number
  segments: number
  /** the segments' length, in seconds (2 to 10; 10 unless the share asked) */
  segmentSeconds?: number
  error?: string
}

export const NETWORKS = ["none", "registries", "open"] as const
export type Network = (typeof NETWORKS)[number]

/**
 * A sandbox's egress policy, as `PATCH …/network` answers it. Kept here rather than imported from
 * @kyora-sh/hostnames, which is not published: the library's declarations must stand alone
 * (library.test.ts checks both stay the same shape).
 */
export interface EgressPolicy {
  network: "none" | "registries"
  egressAllow: string[]
}

/** `PATCH …/network`: either field, or both */
export interface EgressChange {
  network?: "none" | "registries"
  egressAllow?: string[]
}

/** what answers at the URL: kyora cloud (many machines, a login) or one kyora-vmd (an API key) */
export type Kind = "platform" | "vmd"

/** the `version` kyora cloud's /v1/health reports; a kyora-vmd reports its own release */
export const PLATFORM_VERSION = "kyora-cloud"

export interface Sandbox {
  /** false: created unshareable, so it is never shared */
  shareable?: boolean
  warnings?: string[]
  name?: string
  image?: string
  idleSeconds?: number
  ttlSeconds?: number
  lastActivityAt?: string
  id: string
  status: string
  network: Network
  vcpus: number
  allocatedVcpus?: number
  memoryMb: number
  diskGb: number
  expiresAt: string | null
  createdAt: string
  labels?: Record<string, string>
  /** the machine it runs on (kyora cloud) */
  node?: string
  /** kyora cloud with regions: the region it is in, and the one it asked for when that had no room */
  region?: string
  requestedRegion?: string
}

export interface CreateSpec {
  /** false for good: no view share of it, of its snapshots' restores or of its session's sandboxes */
  shareable?: boolean
  /** kyora cloud: restore this snapshot of yours (snap_…) instead; its sharing policy carries over */
  fromSnapshot?: string
  /** with fromSnapshot: resume a full snapshot's memory (its default), or restore only the files */
  resume?: boolean
  /** kyora cloud, platform admins only: this machine only, by name */
  node?: string
  name?: string
  vcpus?: number
  allocatedVcpus?: number
  cpuLimit?: number
  maxMemoryMb?: number
  autoscale?: boolean
  memoryMb?: number
  diskGb?: number
  egressAllow?: string[]
  network?: Network
  /**
   * kyora cloud: the region to run in, and only there; `global` (or left
   * out, with no default of yours) is the region nearest you, overflowing to the next when it is full
   */
  region?: string
  ttlSeconds?: number
  idleSeconds?: number
  /** a guest image the machine has; the machine's default when absent */
  image?: string
  labels?: Record<string, string>
  /** a desktop image's screen size; its default is 1280x800 */
  display?: { width: number; height: number }
  /** kyora cloud: the session (ses_…) this sandbox is for, which gives it the session TTL class */
  session?: string
}

/** one action of the Anthropic computer-use toolset, as its tool_use block says it: `{action: name, …input}` */
export type ComputerAction = Record<string, unknown> & { action: string }

export type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }

/** a computer action's answer: `content` is what the tool_result's content would be */
export interface ComputerResult {
  action: string
  content: ContentBlock[]
  /** the screenshot in content, when there is one */
  image?: { width: number; height: number; bytes: number }
  /** the screen it is of: coordinates are in its pixels */
  screen?: { width: number; height: number }
  cursor?: { x: number; y: number }
  desktop?: Record<string, unknown>
}

export interface Screenshot {
  png: Uint8Array<ArrayBuffer>
  width: number
  height: number
  screen: { width: number; height: number }
}

/** kyora cloud: where a create stands while it waits in line for a machine with room */
export interface QueueTicket {
  ticket: string
  status: "queued"
  /** 1 at the head of the line */
  position: number
  ahead: number
  depth: number
  enqueuedAt: string
  /** it fails with no_capacity if no room came up by then */
  waitUntil: string
}

export type SnapshotKind = "fs" | "full"

export interface Snapshot {
  id: string; kind: SnapshotKind; status: "creating" | "ready" | "failed" | "deleted"; name: string | null; sandbox: string
  bytes: number | null; logicalBytes: number | null; dataBytes: number | null; image: string | null
  spec?: Record<string, unknown>; resumable: boolean; createdAt: string; readyAt?: string; expiresAt: string; error?: string
}

export interface Exposure { label: string; port: number; private: boolean; trusted?: boolean; url: string; sandboxId?: string; running?: boolean }

export interface ListOptions { labels?: Record<string, string>; signal?: AbortSignal }

export interface CreateOptions {
  /** kyora cloud: seconds to wait in line when there is no room (0 or unset: fail at once); a kyora-vmd has no line */
  wait?: number
  /**
   * ms past `wait` the client keeps polling before it gives up on a line that never answers and
   * takes the create out of it (the server ends the wait at `wait` itself; default 60 s)
   */
  graceMs?: number
  /** aborting it while the create waits in line takes it out (a sandbox it was just given goes too) */
  signal?: AbortSignal
  /** told where the create stands, each time the server says */
  onQueued?: (ticket: QueueTicket) => void
}

export interface UploadResult {
  bytes: number
  entries: number
  durationMs: number
}

export interface ExecRequest {
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutSeconds?: number
  stdin?: string
  /** ask for a command that outlives a broken connection (a server that can't ignores it) */
  resumable?: boolean
  /**
   * a resumable command's idempotency key: kyora cloud starts at most one
   * command per sandbox and key, and the same key again answers with that command to reattach to
   */
  key?: string
}

/** how much of each stream has been written out: where a reattach carries on */
export interface StreamOffsets {
  stdout: number
  stderr: number
}

/** a terminal session in a sandbox: a tmux session */
export interface TtySession {
  name: string
  windows: number
  /** clients attached right now */
  attached: number
  createdAt?: number
  /** when it last printed something (ms), if known */
  activityAt?: number | null
  /** something runs in it: a window's own command, or a job in a shell's foreground */
  busy: boolean
  running?: string[]
}

export interface TtyCreate {
  name: string
  cmd?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface Health {
  ok: boolean
  version?: string
  capacity?: { vcpusFree?: number; memoryMbFree?: number }
  /** what a kyora-vmd can do (`tty`: terminals); kyora cloud says nothing */
  features?: string[]
}

/** kyora cloud's multipart upload: the tar goes up in `partSize` pieces, each its own request */
export interface MultipartUpload {
  uploadId: string
  partSize: number
}

export interface Part {
  n: number
  etag: string
}

export interface ApiTokenConstraints {
  projects?: string[]
  labels?: Record<string, string>
  regions?: string[]
  maxSandboxes?: number
  maxVcpus?: number
  maxMemoryMb?: number
  maxTtlSeconds?: number
  networkModes?: Network[]
  names?: string[]
  namePrefix?: string
}

export interface ApiTokenRecord {
  id: string
  userId: string
  actorId: string | null
  name: string
  hint: string
  scopes: string[]
  constraints: ApiTokenConstraints | null
  scoped: boolean
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export interface CreateApiToken {
  name: string
  scopes: string[]
  constraints?: ApiTokenConstraints
  expires?: string
}

export interface Me {
  login: string
  /** "org": the token acts as an org, minted by `actor` */
  kind?: "user" | "org"
  actor?: { id: string; login: string; role: string | null }
  memberships?: Array<{ id: string; login: string; name: string | null; role: string }>
  name?: string | null
  role?: string
  vmsAccess?: boolean
  limits?: { maxSandboxes?: number }
  token?: { id?: string; name?: string; scopes?: string[]; constraints?: ApiTokenConstraints | null; expiresAt?: string | null }
}

/** an org as `GET /v1/orgs` shows it */
export interface OrgInfo {
  id: string
  login: string
  name: string | null
  role: string | null
  vmsAccess: boolean
}

export interface OrgToken {
  token: string
  org: { id: string; login: string }
  actor: string
  expiresAt: string | null
}

export interface Room {
  vcpus?: number
  allocatedVcpus?: number
  cpuLimit?: number
  maxMemoryMb?: number
  autoscale?: boolean
  memoryMb?: number
  diskGb?: number | null
}

/** a machine as `GET /v1/nodes` shows it; members see name, connected and free */
export interface NodeInfo {
  name: string
  /** kyora cloud with regions */
  region?: string
  connected: boolean
  free?: Room
  capacity?: Room
  draining?: boolean
  version?: string | null
  running?: number
  lastSeenAt?: string | null
}

/** a DNS record a custom domain needs */
export interface DnsRecord {
  type: string
  name: string
  value: string
  /** ownership: kyora's TXT that ties the hostname to your account; routing: the CNAME to kyora; prevalidation and certificate: Cloudflare's checks */
  purpose: string
  required: boolean
  note?: string
}

/** a custom domain as `/v1/domains` shows it */
export interface CustomDomain {
  hostname: string
  /** the public URL name it serves, or `page:<name>` for a page */
  label: string
  /** the page it serves, if it serves one */
  page?: string
  /** unverified: kyora hasn't seen your ownership TXT yet, nothing is set up at Cloudflare */
  status: "unverified" | "pending" | "active" | "failed"
  reason: string | null
  /** false once its name was released: kept, not served, until attached again */
  attached: boolean
  dcv: "http" | "txt"
  url: string
  records: DnsRecord[]
  createdAt: string | null
  checkedAt: string | null
  /** status only: whether visitors reach the name now, and why not */
  serving?: boolean
  why?: string
  /** status only: Cloudflare didn't answer; this is the last status seen */
  stale?: boolean
  /** the records not in place yet, as the public DNS showed them (the ownership TXT, the CNAME) */
  missing?: Array<{ type: string; name: string; value: string }>
  /** blocked by kyora: not served, and you can't add or remove it */
  blocked?: boolean
}

/** a static page as `/v1/pages` shows it: a name served from a prefix of one of your buckets */
export interface Page {
  name: string
  url: string
  private: boolean
  bucket: string
  /** ends with / */
  prefix: string
  region?: string
  spa: boolean
  notFound?: string | null
  /** taken down by kyora: not served */
  disabled?: boolean
  createdAt: string
  updatedAt: string
}

/** `POST /v1/pages`: a new page, or the caller's own name pointed at another prefix; without a name, kyora cloud makes one from `hint` */
export interface PageCreate {
  name?: string
  hint?: string
  bucket: string
  prefix: string
  public?: boolean
  spa?: boolean
  notFound?: string
}

/** a region as `GET /v1/regions` shows it */
export interface RegionInfo {
  id: string
  label: string
  default: boolean
  jurisdiction: string | null
  fallback: string[]
  /** admins only: how many machines the region has, and how many are connected */
  machines?: number
  connected?: number
  free: Room
}

export interface Regions {
  regions: RegionInfo[]
  /** where a create from here goes when it names no region, and why: your default (only there), or the nearest region and its overflow */
  you: { region: string; by: string; strict?: boolean; overflow?: string[]; location?: Record<string, string> }
  /** the default you set, if any */
  default: string | null
}

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verifyUrl: string
  /** seconds between polls */
  interval: number
  /** seconds until the code is void */
  expiresIn: number
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "approved"; token: string; login: string; expiresAt: string | null; org?: { id: string; login: string }; actor?: string }
  | { status: "denied" | "expired"; message: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** what the server's Retry-After asked for, in ms */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export class ApiResponseError extends ApiError {
  constructor(error: ApiError, readonly body: unknown) {
    super(error.message, error.status, error.code, error.retryAfterMs)
  }
}

/** what an agent reading the error should do next, keyed by status */
const HINTS: Record<Kind, Record<number, string>> = {
  vmd: {
    401: "the API key was not accepted; check KYORA_VMS_KEY or ~/.config/kyora-vms/env",
    403: "this key is not allowed to do that (--network open needs a key with allowOpenNetwork)",
    409: "the sandbox is already running a command; it takes one exec at a time",
    413: "that is over this key's upload limit; keep build output and caches out of the upload (.gitignore them) or push less",
    429: "this key is at its limit of concurrent sandboxes; `kyora vms ls`, then `kyora vms rm <id>`",
    503: "the host is out of capacity or restarting; retry in a minute",
  },
  platform: {
    401: "a KYORA_TOKEN or KYORA_VMS_KEY that is set comes before a stored login",
    403: "this account may not do that (--network open is for admins; an admin grants vms access)",
    409: "the sandbox is busy with an exclusive operation or still starting; older sandboxes take one exec at a time",
    429: "you are at your limit of concurrent sandboxes; `kyora vms ls`, then `kyora vms rm <id>`",
    503: "no capacity is available for that right now; `kyora vms regions` shows the room in each region; ask for less or retry later",
  },
}

/** kyora cloud's queue says more by its error codes than a status could */
const CODE_HINTS: Record<string, string> = {
  unschedulable: "the requested size exceeds available capacity, so waiting would not help; ask for less (--cpus, --memory, --disk)",
  queue_limit: "you already have that many creates waiting for capacity; let them finish or stop some",
  queue_full: "the queue for capacity is full; retry in a minute",
  region_unavailable: "capacity is unavailable in that region; `kyora vms regions` lists the regions; --region global uses capacity in any region",
  unknown_region: "`kyora vms regions` lists the regions there are",
  region_conflict: "a create pinned to a machine runs in that machine's region; leave out --region",
}

/** codes both servers answer with, whose hint beats the one for their status */
const SHARED_CODE_HINTS: Record<string, string> = {
  exec_limit: "the sandbox has reached its concurrent exec limit; wait for a command to finish or cancel it",
  share_disabled: "sharing is fixed when a sandbox is created (--no-share), and its snapshots and session sandboxes keep it",
  vmd_update_required: "update the machine software, then retry",
  snapshot_quota: "delete snapshots you no longer need: `kyora vms snapshot ls`, then `kyora vms snapshot rm <snap>`",
  full_snapshots_not_allowed: "take a filesystem snapshot (leave out --full), or ask an admin to allow full snapshots",
  snapshot_busy: "a snapshot of that sandbox is being taken; `kyora vms snapshot ls` shows when it is done",
  snapshot_not_ready: "the snapshot is still being taken; `kyora vms snapshot show <snap>` shows when it is ready",
}

const TIMEOUTS = { short: 30_000, create: 120_000, exec: 120_000, computer: 120_000 }

/** a queued create's long poll: the server answers within this many seconds, sooner with news */
const QUEUE_POLL_S = 25
/** a poll that fails on the way (network, the edge, a restarting server) is tried again this often in a row */
const QUEUE_RETRIES = 8
/** how long past `wait` a create keeps polling a line that should have answered by then */
const QUEUE_GRACE_MS = 60_000
/** an exec the machine never got (`exec_not_started`, kyora cloud says so after a reconnect) is sent again, this often at most */
const EXEC_NOT_STARTED_TRIES = 5
/** an exec right after our own last one in the sandbox ended waits out a 409 exec_busy for this long at most */
const EXEC_BUSY_AFTER_EXIT_MS = 5_000

const isTicket = (body: unknown): body is QueueTicket =>
  typeof body === "object" && body !== null && (body as { status?: unknown }).status === "queued" && typeof (body as { ticket?: unknown }).ticket === "string"

/** worth asking again: nothing answered, or something in front of kyora cloud did, not kyora cloud itself */
const transient = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 504 || (error.status >= 500 && error.code === undefined) || error.code === "internal" || resetByServer(error))

/** kyora cloud restarted a part of itself while it answered and says to ask again (503 `do_reset`, with Retry-After) */
const resetByServer = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.code === "do_reset"

/** a safe call that was answered `do_reset` is asked again for this long at most, honouring Retry-After */
const RESET_DEADLINE_MS = 15_000
const RESET_TRIES = 4
/** a Retry-After longer than this is not waited out */
const RESET_MAX_WAIT_MS = 10_000
/** a keyed create is sent at most this often */
const KEYED_CREATE_TRIES = 4

function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds < 0 ? undefined : Math.round(seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** how long a snapshot or a restore is waited on: as long as the server gives its snapshot and restore work */
const POLL_TIMEOUT_MS = 60 * 60_000
/** that many failed polls in a row end the wait */
const POLL_RETRIES = 20
/** a busy server's Retry-After is waited out up to this long per poll */
const POLL_MAX_RETRY_AFTER_MS = 30_000
/** a listing is followed this many pages (of up to 1000 rows) at most */
const MAX_PAGES = 100

/** the first wait between snapshot and restore polls; KYORA_VMS_POLL_MS shortens it in tests */
function pollMs(): number {
  const value = Number(process.env.KYORA_VMS_POLL_MS)
  return Number.isFinite(value) && value > 0 ? value : 1_000
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }
    const stop = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })
}

async function apiError(action: string, response: Response, kind: Kind, hints = true): Promise<ApiError> {
  const text = await response.text().catch(() => "")
  let code: string | undefined
  let message: string | undefined
  let after: number | undefined
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; retryAfterMs?: unknown }
    code = typeof body.error === "string" ? body.error : undefined
    message = typeof body.message === "string" ? body.message : code
    // kyora cloud says it to the millisecond on a 429 or 503; the header only in whole seconds
    if (typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs) && body.retryAfterMs >= 0) after = Math.round(body.retryAfterMs)
  } catch {
    // an HTML error page means a proxy answered, not the server itself
    if (text.trim() && !text.trimStart().startsWith("<")) message = text.trim().slice(0, 200)
  }
  message ??= `the server request failed (HTTP ${response.status})`
  const hint = hints
    ? code === "image_unavailable"
      ? kind === "platform" ? "`kyora vms images` shows availability; choose an available region or ask an admin to build the profile" : "build this profile on the host before retrying"
      : ((code === "quota_exceeded" && action.startsWith("snapshot ") ? SHARED_CODE_HINTS.snapshot_quota : undefined) ?? (kind === "platform" && code ? CODE_HINTS[code] : undefined) ?? (code ? SHARED_CODE_HINTS[code] : undefined) ?? HINTS[kind][response.status])
    : undefined
  return new ApiError(`${action}: ${message}${hint ? `; ${hint}` : ""}`, response.status, code, after ?? retryAfterMs(response.headers.get("retry-after")))
}

/**
 * A part as a stream over its own buffer, with its length declared. fetch() sends that as
 * the same fixed-length body the bytes would make (no chunked encoding), but a Uint8Array
 * body it first copies whole, so each part in flight would cost its size twice.
 */
function fixedLength(part: Uint8Array<ArrayBuffer>): { body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  if (part.length === 0) return { body: part, headers: {} }
  const slice = 1024 * 1024
  let offset = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= part.length) return controller.close()
        controller.enqueue(part.subarray(offset, offset + slice))
        offset += slice
      },
    },
    { highWaterMark: 0 },
  )
  return { body, headers: { "content-length": String(part.length) } }
}

interface SendOptions {
  json?: unknown
  body?: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>
  contentType?: string
  signal?: AbortSignal
  /** ms; streaming calls pass none, the server bounds them */
  timeout?: number
  /** ms until the response has to have started; the body may then take as long as it takes */
  headersTimeout?: number
  auth?: boolean
  /**
   * Take a connection of its own and close it afterwards. A server that answers an
   * upload early (a 413) leaves the rest of the body unread, and a connection reused
   * after that can hand those bytes to the next request as if they were one: the
   * cleanup DELETE after a refused push was being lost that way.
   */
  fresh?: boolean
  /** non-2xx statuses the caller reads itself instead of getting an ApiError */
  accept?: number[]
  /** an error says what the server said, without the hint for its status (one about commands, say) */
  noHint?: boolean
  preserveErrorBody?: boolean
  headers?: Record<string, string>
  /** ask again after `do_reset` (default: for GET and HEAD, which repeat safely; never for a write) */
  retryReset?: boolean
}

const sandboxPath = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`

/** what a VmsClient needs: the URL and key, given, with nothing read from this machine's config or logins */
export type ClientConfig = Pick<Config, "url" | "key"> & Partial<Omit<Config, "url" | "key">>

export class VmsClient {
  /** set by a health probe, which beats any guess */
  private detected: Kind | null = null
  /** when an exec of ours last delivered its exit, by sandbox: a 409 exec_busy right after it is that exec's slot, still being freed */
  private readonly exited = new Map<string, number>()

  constructor(readonly config: ClientConfig) {}

  get url(): string {
    return this.config.url
  }

  /**
   * Which server this is, when that is clear without asking: kyora cloud's tokens
   * start kyora_, kyora-vmd's keys kvms_, and with no key at all the default URL is
   * kyora cloud. A vmd key keeps the vmd path free of any extra request.
   */
  private guess(): Kind | null {
    if (this.detected) return this.detected
    const key = this.config.key
    if (key?.startsWith(PLATFORM_TOKEN_PREFIX)) return "platform"
    if (key?.startsWith(VMD_KEY_PREFIX)) return "vmd"
    if (!key && originOf(this.config.url) === originOf(DEFAULT_URL)) return "platform"
    return null
  }

  /** decided once per invocation; asks /v1/health only when the key does not say */
  async kind(): Promise<Kind> {
    const known = this.guess()
    if (known) return known
    await this.health()
    return this.detected!
  }

  /**
   * One request. A GET or HEAD answered `503 do_reset` is asked again after the server's Retry-After, within
   * RESET_DEADLINE_MS. Writes are never repeated here, and `POST /v1/sandboxes` least of all: a create that
   * was answered `do_reset` may be running, and nothing makes a second one safe.
   */
  private async send(action: string, method: string, path: string, options: SendOptions = {}): Promise<Response> {
    const repeats = options.retryReset ?? (method === "GET" || method === "HEAD")
    if (!repeats) return this.sendOnce(action, method, path, options)
    let deadline: number | undefined
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline === undefined ? Infinity : deadline - Date.now()
      if (remaining <= 0) throw new ApiError(`${action}: reset retry deadline exceeded`, 0)
      const controller = deadline === undefined ? null : new AbortController()
      const timer = controller ? setTimeout(() => controller.abort(new ApiError(`${action}: reset retry deadline exceeded`, 0)), remaining) : undefined
      try {
        return await this.sendOnce(action, method, path, controller ? {
          ...options,
          timeout: options.timeout === undefined ? undefined : Math.min(options.timeout, remaining),
          signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        } : options)
      } catch (error) {
        if (!resetByServer(error) || attempt >= RESET_TRIES || options.signal?.aborted) throw error
        deadline ??= Date.now() + RESET_DEADLINE_MS
        const wait = Math.max(200, (error as ApiError).retryAfterMs ?? 2_000)
        if (wait > RESET_MAX_WAIT_MS || Date.now() + wait >= deadline) throw error
        await pause(wait, options.signal)
        if (Date.now() >= deadline) throw error
      } finally {
        clearTimeout(timer)
      }
    }
  }

  private async sendOnce(action: string, method: string, path: string, options: SendOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers, "user-agent": `kyora-vms/${VERSION}` }
    if (options.auth !== false) {
      if (!this.config.key) throw new ApiError(`${action}: ${await this.missingKey()}`, 0)
      headers.authorization = `Bearer ${this.config.key}`
    }
    let body: BodyInit | undefined
    if (options.json !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.json)
    } else if (options.body) {
      headers["content-type"] = options.contentType ?? "application/octet-stream"
      body = options.body
    }
    if (options.fresh) headers.connection = "close"
    // aborted only while waiting for the response to start; cleared once it has
    const start = options.headersTimeout ? new AbortController() : null
    const startTimer = start ? setTimeout(() => start.abort(new DOMException("no answer", "TimeoutError")), options.headersTimeout) : undefined
    const signals = [options.signal, options.timeout ? AbortSignal.timeout(options.timeout) : undefined, start?.signal].filter((s) => s !== undefined)

    let response: Response
    try {
      response = await fetch(`${this.config.url}${path}`, {
        method,
        headers,
        body,
        // a redirect would carry the bearer key to wherever it points
        redirect: "manual",
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
        ...(options.fresh ? { keepalive: false } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error
      const waited = start?.signal.aborted ? options.headersTimeout! : options.timeout
      const detail = error instanceof Error ? (error.name === "TimeoutError" || start?.signal.aborted ? `no answer after ${waited! / 1000}s` : error.message) : String(error)
      throw new ApiError(`${action}: can't reach ${this.config.url} (${detail})`, 0)
    } finally {
      clearTimeout(startTimer)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(`${action}: ${this.config.url} redirected to ${response.headers.get("location") ?? "?"}; check KYORA_VMS_URL`, response.status)
    }
    if (!response.ok && !options.accept?.includes(response.status)) {
      const body = options.preserveErrorBody ? await response.clone().json().catch(() => null) : null
      const error = await apiError(action, response, this.guess() ?? "vmd", !options.noHint)
      throw options.preserveErrorBody ? new ApiResponseError(error, body) : error
    }
    return response
  }

  private projectRequest(method: string, path = "", body?: ProjectCreate | DeploymentCreate, follow = false, signal?: AbortSignal): Promise<Response> {
    return this.send("projects", method, `/v1/projects${path}`, { json: body, timeout: follow ? undefined : TIMEOUTS.short, signal, noHint: true, preserveErrorBody: true })
  }

  async projectCreate(body: ProjectCreate): Promise<ProjectView> {
    return (await this.projectRequest("POST", "", body)).json() as Promise<ProjectView>
  }

  async projects(): Promise<ProjectList> {
    return (await this.projectRequest("GET")).json() as Promise<ProjectList>
  }

  async project(id: string): Promise<ProjectView> {
    return (await this.projectRequest("GET", `/${encodeURIComponent(id)}`)).json() as Promise<ProjectView>
  }

  async projectRemove(id: string): Promise<unknown> {
    return (await this.projectRequest("DELETE", `/${encodeURIComponent(id)}`)).json()
  }

  async deploymentCreate(project: string, body: DeploymentCreate): Promise<Deployment> {
    return (await this.projectRequest("POST", `/${encodeURIComponent(project)}/deployments`, body)).json() as Promise<Deployment>
  }

  async deployments(project: string): Promise<DeploymentList> {
    return (await this.projectRequest("GET", `/${encodeURIComponent(project)}/deployments`)).json() as Promise<DeploymentList>
  }

  async deployment(project: string, id: string, signal?: AbortSignal): Promise<DeploymentView> {
    return (await this.projectRequest("GET", `/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}`, undefined, false, signal)).json() as Promise<DeploymentView>
  }

  deploymentLogs(project: string, id: string, follow = false, signal?: AbortSignal): Promise<Response> {
    return this.projectRequest("GET", `/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}/logs${follow ? "?follow=1" : ""}`, undefined, follow, signal)
  }

  private async missingKey(): Promise<string> {
    const kind = await this.kind().catch(() => null)
    if (kind === "vmd") return "no API key; set KYORA_VMS_KEY, or put KYORA_VMS_KEY=kvms_… in ~/.config/kyora-vms/env"
    if (kind === "platform") return `not logged in to ${this.url}; run \`kyora vms login\`, or set KYORA_TOKEN`
    return `no credentials for ${this.url}: \`kyora vms login\` for kyora cloud, or KYORA_VMS_KEY=kvms_… for a machine you manage`
  }

  images(): Promise<Response> {
    return this.send("list images", "GET", "/v1/images", { timeout: TIMEOUTS.short })
  }

  buildImage(profile: string, node?: string): Promise<Response> {
    return this.send("build image", "POST", "/v1/images/build", { json: { profile, ...(node ? { node } : { all: true }) }, timeout: TIMEOUTS.short })
  }

  async health(): Promise<Health> {
    const response = await this.send("health", "GET", "/v1/health", { auth: false, timeout: TIMEOUTS.short })
    const health = (await response.json()) as Health
    this.detected = health.version === PLATFORM_VERSION ? "platform" : "vmd"
    return health
  }

  /**
   * With `wait`, kyora cloud answers a create it has no room for with a ticket (202) instead of a
   * 503, and this waits in line: it long-polls the ticket until the create has its answer, the
   * sandbox or the error it ended with. The create request itself is not tied to `signal` (cut
   * short, it would leave a sandbox we never learn the id of); the wait in line is.
   */
  async create(spec: CreateSpec, options: CreateOptions = {}): Promise<Sandbox> {
    for (let attempt = 0; ; attempt++) {
      try {
        const sandbox = await this.createOnce({ ...spec, name: spec.name === undefined ? friendlyName() : validName(spec.name) }, options)
        for (const warning of sandbox.warnings ?? []) process.stderr.write(`${notePrefix()} warning: ${warning}\n`)
        if (spec.shareable === false && sandbox.shareable !== false) return await this.unconfirmedNoShare(sandbox)
        return sandbox
      } catch (error) {
        if (spec.name !== undefined || !(error instanceof ApiError) || error.code !== "name_taken" || attempt >= 5) throw error
      }
    }
  }

  /**
   * Asked for `shareable: false`, and the answer doesn't say so (a server from before the flag ignores it): that
   * sandbox could be shared. Never fail open on version skew: it is destroyed, and the create fails.
   */
  private async unconfirmedNoShare(sandbox: Sandbox): Promise<never> {
    const destroyed = await this.destroy(sandbox.id).then(() => true, () => false)
    throw new ApiError(
      `create sandbox: asked for shareable: false, but ${this.config.url} did not confirm it (a server from before unshareable sandboxes?); ${destroyed ? `sandbox ${sandbox.id} was destroyed` : `destroy sandbox ${sandbox.id} yourself: it can be shared`}`,
      0,
      "share_policy_unconfirmed",
    )
  }

  private async createOnce(spec: CreateSpec, options: CreateOptions): Promise<Sandbox> {
    const started = Date.now()
    if (spec.egressAllow !== undefined && await this.kind() === "vmd" && !(await this.health()).features?.includes("network.policy")) throw new ApiError("create sandbox: user egress policies are unavailable on this server; update the machine software", 501, "egress_unsupported")
    // a single kyora-vmd is one place: global means nothing to it, and a named region can't be kept
    if (spec.region !== undefined && (await this.kind()) !== "platform") {
      if (spec.region !== "global") {
        throw new ApiError(`create sandbox: ${this.url} does not support regions; omit --region ${spec.region} and KYORA_VMS_REGION`, 0, "invalid_request")
      }
      const { region: _region, ...rest } = spec
      spec = rest
    }
    const platform = (await this.kind()) === "platform"
    const wait = options.wait && options.wait > 0 && platform ? options.wait : 0
    const response = platform ? await this.keyedCreate(wait > 0 ? { ...spec, wait } : spec, options.signal) : await this.send("create sandbox", "POST", "/v1/sandboxes", { json: spec, timeout: TIMEOUTS.create })
    const body = (await response.json()) as unknown
    if (response.status === 202 && isTicket(body)) return this.waitInLine(body, { wait, at: started + wait * 1000 + (options.graceMs ?? QUEUE_GRACE_MS) }, options)
    return body as Sandbox
  }

  /**
   * `POST /v1/sandboxes` with an Idempotency-Key, asked again (KEYED_CREATE_TRIES in all) only when kyora cloud
   * carried the key back with a do_reset or an internal error: that answer says it keeps the create under the key,
   * so the repeat gets the first try's sandbox, never a second. The version key keeps every try on one Worker
   * version through a gradual deploy.
   */
  private async keyedCreate(json: CreateSpec & { wait?: number }, signal?: AbortSignal): Promise<Response> {
    const key = crypto.randomUUID()
    const headers = { "Idempotency-Key": key, "Cloudflare-Workers-Version-Key": key }
    for (let attempt = 1; ; attempt++) {
      const response = await this.send("create sandbox", "POST", "/v1/sandboxes", { json, timeout: TIMEOUTS.create, headers, accept: [500, 503] })
      if (response.ok) return response
      const error = await apiError("create sandbox", response.clone(), "platform")
      const keyed = response.headers.get("idempotency-key") === key && (error.code === "do_reset" || error.code === "internal")
      if (!keyed || attempt >= KEYED_CREATE_TRIES) throw error
      await pause(Math.min(RESET_MAX_WAIT_MS, Math.max(500, error.retryAfterMs ?? 2_000)), signal)
    }
  }

  async resize(id: string, diskGb: number): Promise<Sandbox> {
    id = await resolveDestructiveTarget(this, id)
    try {
      return await this.call("resize sandbox", "PATCH", `/v1/sandboxes/${encodeURIComponent(id)}`, { json: { diskGb }, timeout: 100_000 })
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && /only cpuLimit, memoryMb and autoscale can change/.test(error.message)) throw new ApiError("update the machine software to grow disks", 409, "vmd_update_required")
      throw error
    }
  }

  async network(id: string, policy: EgressChange): Promise<EgressPolicy> {
    if (await this.kind() === "vmd" && !(await this.health()).features?.includes("network.policy")) throw new ApiError("update network: network policy changes are unavailable on this server; update the machine software", 501, "egress_unsupported")
    id = await resolveDestructiveTarget(this, id)
    return this.call("update network", "PATCH", `/v1/sandboxes/${encodeURIComponent(id)}/network`, { json: policy })
  }

  /** long-polls the ticket until its answer, or until `until.at`: a line that never answers is left, not waited on for ever */
  private async waitInLine(ticket: QueueTicket, until: { wait: number; at: number }, options: CreateOptions): Promise<Sandbox> {
    const path = `/v1/queue/${encodeURIComponent(ticket.ticket)}`
    options.onQueued?.(ticket)
    let failures = 0
    try {
      for (;;) {
        const left = until.at - Date.now()
        if (left <= 0) {
          await this.cancelQueued(path)
          throw new ApiError(`create sandbox: still in line for room well past --wait (${formatMs(until.wait * 1000)}), with no answer from kyora cloud; kyora took the create out of line`, 503, "queue_timeout")
        }
        let response: Response
        try {
          response = await this.send("create sandbox", "GET", `${path}?wait=${QUEUE_POLL_S}`, { signal: options.signal, timeout: Math.min((QUEUE_POLL_S + 30) * 1000, left), retryReset: false })
        } catch (error) {
          if (options.signal?.aborted || !transient(error) || ++failures > QUEUE_RETRIES) throw error
          // the server keeps the ticket for a minute without a poll: plenty for a few retries
          // a restarting part of kyora cloud (do_reset) says when to ask again; the line's own deadline still holds
          const asked = error instanceof ApiError && resetByServer(error) ? Math.min(error.retryAfterMs ?? 0, RESET_MAX_WAIT_MS) : 0
          await pause(Math.max(0, Math.min(Math.max(asked, Math.min(5_000, 250 * 2 ** failures)), until.at - Date.now())), options.signal)
          continue
        }
        failures = 0
        const body = (await response.json()) as unknown
        if (response.status !== 202 || !isTicket(body)) return body as Sandbox
        options.onQueued?.(body)
      }
    } catch (error) {
      if (options.signal?.aborted) await this.cancelQueued(path)
      throw error
    }
  }

  /** out of line; not tied to Ctrl-C, since this is the cleanup after one */
  private async cancelQueued(path: string): Promise<void> {
    try {
      await this.send("cancel the queued create", "DELETE", path, { timeout: TIMEOUTS.short })
    } catch {
      // unreachable now: the server drops a ticket nobody asks about within a minute, and destroys what it placed for it
    }
  }

  async list(options: ListOptions = {}): Promise<Sandbox[]> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options.labels ?? {})) params.append("label", `${key}=${value}`)
    const sandboxes = await this.pages<Sandbox>("list sandboxes", "/v1/sandboxes", "sandboxes", params, options)
    if (!options.labels) return sandboxes
    const labels = options.labels
    return sandboxes.filter((sandbox) => Object.entries(labels).every(([key, value]) => sandbox.labels?.[key] === value))
  }

  async stats(signal?: AbortSignal): Promise<SandboxStatsResponse> {
    const result = await this.call<SandboxStatsResponse>("sandbox stats", "GET", "/v1/sandboxes?stats=1", { timeout: TIMEOUTS.short, ...(signal ? { signal } : {}) })
    if (typeof result.account !== "string" || !Array.isArray(result.sandboxes)) throw new ApiError("sandbox stats: this server does not support top; use kyora cloud with stats enabled", 0)
    return result
  }

  async resolve(input: string): Promise<{ id: string; name?: string }> {
    const response = await this.send(`resolve ${input}`, "GET", `${sandboxPath(input)}/resolve`, { timeout: TIMEOUTS.short, noHint: true })
    return await response.json() as { id: string; name?: string }
  }

  async update(id: string, change: { name?: string; ttlSeconds?: number }): Promise<Sandbox> {
    try {
      return await this.call<Sandbox>(`update ${id}`, "PATCH", sandboxPath(id), { json: change })
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const component = error.code === "unknown_method" ? "kyora-node" : (/only cpuLimit, memoryMb and autoscale can change/.test(error.message) ? "kyora-vmd" : null)
        if (component) throw new ApiError("sandbox metadata changes are unavailable on this server; update the machine software", 409, `${component}_update_required`)
      }
      throw error
    }
  }

  async get(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const response = await this.send(`get ${id}`, "GET", sandboxPath(id), { timeout: TIMEOUTS.short, ...(signal ? { signal } : {}) })
    return (await response.json()) as Sandbox
  }

  /** false when the sandbox was already gone */
  async destroy(id: string): Promise<boolean> {
    try {
      await this.send(`destroy ${id}`, "DELETE", sandboxPath(id), { timeout: TIMEOUTS.short })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false
      throw error
    }
  }

  async snapshot(id: string, options: { kind?: SnapshotKind; name?: string; ttlDays?: number; stop?: boolean; idempotencyKey?: string; wait?: boolean; timeoutMs?: number; signal?: AbortSignal; onProgress?: (s: Snapshot) => void } = {}): Promise<Snapshot> {
    const body: Record<string, unknown> = {}
    if (options.kind !== undefined) body.kind = options.kind
    if (options.name !== undefined) body.name = options.name
    if (options.ttlDays !== undefined) body.ttlDays = options.ttlDays
    if (options.stop !== undefined) body.stop = options.stop
    if (options.signal?.aborted) throw options.signal.reason
    // like a create, never cut off once sent: a snapshot taken under an id nobody heard of would hold the sandbox busy
    const response = await this.send(`snapshot ${id}`, "POST", `${sandboxPath(id)}/snapshots`, { json: body, timeout: TIMEOUTS.create, ...(options.idempotencyKey ? { headers: { "Idempotency-Key": options.idempotencyKey } } : {}) })
    const snapshot = (await response.json()) as Snapshot
    if (options.wait === false) return snapshot
    return this.poll(snapshot, () => this.getSnapshot(snapshot.id, options.signal), (current) => {
      if (current.status === "failed") throw new ApiError(`snapshot ${current.id} failed: ${current.error ?? "no reason given"}`, 0, "snapshot_failed")
      if (current.status === "deleted") throw new ApiError(`snapshot ${current.id} was deleted`, 404, "not_found")
      return current.status === "ready"
    }, {
      ...options,
      gone: () => new ApiError(`snapshot ${snapshot.id} not found`, 404, "not_found"),
      late: () => new ApiError(`snapshot ${snapshot.id} timed out; it may still finish (kyora vms snapshot show ${snapshot.id})`, 0, "snapshot_timeout"),
    })
  }

  /**
   * asks `next` again, 1 s backing off to 5 s, until `done`: a 404 is `gone`, the deadline `late`; transient failures
   * and a busy server (429, 503, after its Retry-After) are asked again, up to POLL_RETRIES in a row
   */
  private async poll<T>(current: T, next: () => Promise<T>, done: (current: T) => boolean, options: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (current: T) => void; gone: () => ApiError; late: () => ApiError }): Promise<T> {
    options.onProgress?.(current)
    if (done(current)) return current
    const deadline = Date.now() + (options.timeoutMs ?? POLL_TIMEOUT_MS)
    let delay = pollMs()
    let wait = delay
    let failures = 0
    for (;;) {
      await pause(Math.min(wait, deadline - Date.now()), options.signal)
      if (Date.now() >= deadline) throw options.late()
      delay = Math.min(5_000, delay * 2)
      wait = delay
      try {
        current = await next()
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason
        if (!(error instanceof ApiError)) throw error
        if (error.status === 404) throw options.gone()
        if (!(transient(error) || error.status === 429 || error.status === 503) || ++failures > POLL_RETRIES) throw error
        wait = Math.max(delay, Math.min(error.retryAfterMs ?? 0, POLL_MAX_RETRY_AFTER_MS))
        continue
      }
      failures = 0
      options.onProgress?.(current)
      if (done(current)) return current
    }
  }

  async snapshots(): Promise<Snapshot[]> {
    return this.pages<Snapshot>("list snapshots", "/v1/snapshots", "snapshots", new URLSearchParams())
  }

  /** every page of a listing, following `next_cursor` */
  private async pages<T>(action: string, path: string, field: string, params: URLSearchParams, options: { signal?: AbortSignal } = {}): Promise<T[]> {
    let rows: T[] = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    for (;;) {
      const query = new URLSearchParams(params)
      if (cursor !== undefined) query.set("cursor", cursor)
      const text = query.toString()
      const response = await this.send(action, "GET", text ? `${path}?${text}` : path, { timeout: TIMEOUTS.short, ...(options.signal ? { signal: options.signal } : {}) })
      const body = (await response.json()) as Record<string, unknown>
      rows = rows.concat((body[field] as T[] | undefined) ?? [])
      if (typeof body.next_cursor !== "string" || !body.next_cursor) return rows
      // never a partial listing passed off as the whole: rm --all and name lookups act on it
      if (cursors.has(body.next_cursor) || cursors.size + 1 >= MAX_PAGES) throw new ApiError(`${action}: ${this.url} kept answering next_cursor (${cursors.size + 1} pages)`, 0, "too_many_pages")
      cursors.add(body.next_cursor)
      cursor = body.next_cursor
    }
  }

  async getSnapshot(id: string, signal?: AbortSignal): Promise<Snapshot> {
    const response = await this.send(`get snapshot ${id}`, "GET", `/v1/snapshots/${encodeURIComponent(id)}`, { timeout: TIMEOUTS.short, ...(signal ? { signal } : {}) })
    return (await response.json()) as Snapshot
  }

  /** false when the snapshot was already gone */
  async deleteSnapshot(id: string): Promise<boolean> {
    try {
      await this.send(`delete snapshot ${id}`, "DELETE", `/v1/snapshots/${encodeURIComponent(id)}`, { timeout: TIMEOUTS.short })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false
      throw error
    }
  }

  async restore(snapshotId: string, spec: Omit<CreateSpec, "fromSnapshot" | "image"> = {}, options: Omit<CreateOptions, "wait"> & { wait?: number | boolean; timeoutMs?: number; onProgress?: (s: Sandbox) => void } = {}): Promise<Sandbox> {
    if ((spec as { image?: unknown }).image !== undefined) throw new ApiError(`restore of ${snapshotId}: the image is the snapshot's; do not give one`, 0, "invalid_request")
    const createOptions: CreateOptions = {}
    if (typeof options.wait === "number") createOptions.wait = options.wait
    if (options.graceMs !== undefined) createOptions.graceMs = options.graceMs
    if (options.signal !== undefined) createOptions.signal = options.signal
    if (options.onQueued !== undefined) createOptions.onQueued = options.onQueued
    if (options.signal?.aborted) throw options.signal.reason
    const sandbox = await this.create({ ...spec, fromSnapshot: snapshotId }, createOptions)
    if (options.wait === false) return sandbox
    try {
      if (options.signal?.aborted) throw options.signal.reason
      return await this.poll(sandbox, () => this.get(sandbox.id, options.signal), (current) => {
        if (current.status === "failed" || current.status === "lost" || current.status === "destroyed") throw new ApiError(`restore of ${snapshotId} into ${sandbox.id} failed (status ${current.status})`, 0, "restore_failed")
        return current.status === "running"
      }, {
        ...options,
        gone: () => new ApiError(`restore of ${snapshotId} into ${sandbox.id} failed (sandbox not found)`, 0, "restore_failed"),
        late: () => new ApiError(`restore of ${snapshotId} into ${sandbox.id} timed out`, 0, "restore_timeout"),
      })
    } catch (error) {
      // nothing half-restored is left behind, aborted or failed: the caller may never have heard its id
      const destroyed = await this.destroy(sandbox.id).then(() => true, () => false)
      if (!(error instanceof ApiError)) throw error
      throw new ApiError(`${error.message}; ${destroyed ? `${sandbox.id} was destroyed` : `destroy ${sandbox.id} yourself (kyora vms rm ${sandbox.id}), it may still start`}`, error.status, error.code, error.retryAfterMs)
    }
  }

  async expose(id: string, port: number, options: { name?: string; public?: boolean; trusted?: boolean; idempotencyKey?: string } = {}): Promise<Exposure> {
    const response = await this.send("expose port", "POST", `${sandboxPath(id)}/ports`, { json: { port, ...(options.name ? { name: options.name } : {}), ...(options.public ? { public: true } : {}), ...(options.trusted ? { trusted: true } : {}) }, timeout: TIMEOUTS.create, ...(options.idempotencyKey ? { headers: { "Idempotency-Key": options.idempotencyKey } } : {}) })
    return (await response.json()) as Exposure
  }

  async ports(id?: string): Promise<Exposure[]> {
    const response = await this.send("list exposed ports", "GET", id ? `${sandboxPath(id)}/ports` : "/v1/ports", { timeout: TIMEOUTS.create })
    return ((await response.json()) as { ports?: Exposure[] }).ports ?? []
  }

  async unexpose(id: string, label: string): Promise<void> {
    await this.send("unexpose port", "DELETE", `${sandboxPath(id)}/ports/${encodeURIComponent(label)}`, { timeout: TIMEOUTS.create, accept: [204] })
  }

  async releaseName(label: string): Promise<void> {
    await this.send("release name", "DELETE", `/v1/ports/${encodeURIComponent(label)}`, { timeout: TIMEOUTS.create, accept: [204] })
  }

  /** kyora-vmd: the whole tar in one streamed PUT */
  async upload(id: string, dest: string, body: ReadableStream<Uint8Array>, contentType: string, signal?: AbortSignal): Promise<UploadResult> {
    const response = await this.send(`upload to ${id}`, "PUT", `${sandboxPath(id)}/files?dest=${encodeURIComponent(dest)}`, { body, contentType, signal, fresh: true })
    return (await response.json()) as UploadResult
  }

  async startUpload(id: string, dest: string, contentType: string, signal?: AbortSignal): Promise<MultipartUpload> {
    const response = await this.send(`upload to ${id}`, "POST", `${sandboxPath(id)}/uploads`, { json: { dest, contentType }, signal, timeout: TIMEOUTS.short })
    const reply = (await response.json().catch(() => null)) as Partial<MultipartUpload> | null
    const partSize = reply?.partSize
    if (typeof reply?.uploadId !== "string" || !reply.uploadId) throw new ApiError(`upload to ${id}: the server started no upload (no uploadId)`, 502)
    // a part is held in memory whole (R2 wants its length up front), so its size is bounded here too
    if (typeof partSize !== "number" || !Number.isInteger(partSize) || partSize < 64 * 1024 || partSize > 256 * 1024 ** 2) {
      throw new ApiError(`upload to ${id}: the server asked for ${partSize}-byte parts`, 502)
    }
    return { uploadId: reply.uploadId, partSize }
  }

  /** one part, sized up front; returns the etag `completeUpload` needs */
  async uploadPart(id: string, uploadId: string, n: number, part: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
    const { body, headers } = fixedLength(part)
    const response = await this.send(`upload part ${n} to ${id}`, "PUT", `${sandboxPath(id)}/uploads/${encodeURIComponent(uploadId)}/parts/${n}`, { body, headers, signal, fresh: true })
    const reply = (await response.json().catch(() => null)) as { etag?: unknown } | null
    const etag = (typeof reply?.etag === "string" && reply.etag) || response.headers.get("etag")
    if (!etag) throw new ApiError(`upload part ${n} to ${id}: the reply carried no etag`, 502)
    return etag
  }

  /** no timeout: it returns once the machine has unpacked the whole upload into the sandbox */
  async completeUpload(id: string, uploadId: string, parts: Part[], signal?: AbortSignal): Promise<UploadResult> {
    const response = await this.send(`upload to ${id}`, "POST", `${sandboxPath(id)}/uploads/${encodeURIComponent(uploadId)}/complete`, { json: { parts }, signal })
    return (await response.json()) as UploadResult
  }

  /** not tied to Ctrl-C: this is the cleanup after one */
  async abortUpload(id: string, uploadId: string): Promise<void> {
    await this.send(`abort upload to ${id}`, "DELETE", `${sandboxPath(id)}/uploads/${encodeURIComponent(uploadId)}`, { timeout: TIMEOUTS.short })
  }

  /**
   * The raw tar (or tar.zst) response; the caller streams and extracts it. No timeout:
   * kyora cloud answers only once the machine has put the whole archive in storage.
   */
  async download(id: string, paths: string[], compress: boolean, signal?: AbortSignal): Promise<Response> {
    const query = paths.map((path) => `path=${encodeURIComponent(path)}`)
    if (compress) query.push("compress=zstd")
    return this.send(`download ${paths.join(" ")}`, "GET", `${sandboxPath(id)}/files?${query.join("&")}`, { signal })
  }

  /**
   * A URL the server named (a download's `content-location`), as a path under this
   * client's URL, or null when it points anywhere else: the token goes nowhere else.
   */
  pathUnder(location: string, base: string): string | null {
    let url: URL
    try {
      url = new URL(location, base)
    } catch {
      return null
    }
    url.hash = ""
    const href = url.toString()
    return href.startsWith(`${this.config.url}/`) ? href.slice(this.config.url.length) : null
  }

  /** bytes `start`-`end` (inclusive) of a stored download; `etag` pins the object they come from */
  async downloadRange(path: string, start: number, end: number, etag: string | null, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { range: `bytes=${start}-${end}` }
    if (etag) headers["if-match"] = etag
    return this.send(`download bytes ${start}-${end}`, "GET", path, { signal, headers })
  }

  /**
   * The NDJSON event stream; aborting `signal` drops the connection, which kills the remote
   * process group. Its first line comes at once (kyora-vmd gives the guest 30 s to start the
   * command, kyora cloud the machine 60 s), so an answer that takes longer than that never comes.
   */
  async exec(id: string, request: ExecRequest, signal?: AbortSignal): Promise<Response> {
    // and the time a slow link (16 KB/s) takes to send the stdin first
    const headersTimeout = TIMEOUTS.exec + Math.ceil(Buffer.byteLength(request.stdin ?? "") / 16)
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(`exec in ${id}`, "POST", `${sandboxPath(id)}/exec`, { json: request, signal, headersTimeout, headers: { "x-kyora-exec-heartbeats": "sources" } })
      } catch (error) {
        // the machine reconnected before it got the command: it never ran, so sending it again (with its key) is safe
        if (error instanceof ApiError && error.code === "exec_not_started" && attempt + 1 < EXEC_NOT_STARTED_TRIES && !signal?.aborted) {
          await pause(Math.min(2_000, 250 * 2 ** attempt), signal)
          continue
        }
        // our own last exec in the sandbox just ended: its slot may not be free yet (kyora cloud before it
        // freed it at the exit, as soon as kyora-node's late result came). A busy sandbox we can't put
        // down to that, or one still busy a few seconds on, is an answer
        const since = this.exited.get(id)
        const ours = since !== undefined && Date.now() - since < EXEC_BUSY_AFTER_EXIT_MS
        if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "exec_busy" || !ours || signal?.aborted) throw error
        await pause(Math.min(1_000, 100 * 2 ** attempt), signal)
      }
    }
  }

  /** an exec of ours in `id` delivered its exit: the next one may wait out a busy slot for a moment */
  execExited(id: string): void {
    this.exited.set(id, Date.now())
  }

  /**
   * The rest of a resumable command's event stream, from the bytes of each stream already
   * written out. Dropping it never touches the command; `cancelExec` does.
   */
  async attach(id: string, execId: string, from: StreamOffsets, signal?: AbortSignal): Promise<Response> {
    const path = `${sandboxPath(id)}/execs/${encodeURIComponent(execId)}/stream?from=${from.stdout},${from.stderr}`
    return this.send(`reattach to the command in ${id}`, "GET", path, { signal, headersTimeout: TIMEOUTS.short, headers: { "x-kyora-exec-heartbeats": "sources" } })
  }

  /** the explicit kill of a resumable command (Ctrl-C); not tied to Ctrl-C's signal, it is what follows one */
  async cancelExec(id: string, execId: string): Promise<void> {
    await this.send(`cancel the command in ${id}`, "POST", `${sandboxPath(id)}/execs/${encodeURIComponent(execId)}/cancel`, { timeout: 10_000 })
  }

  /**
   * One computer-use action in the sandbox's desktop, answered like the
   * Anthropic tool's result. A wait or hold_key takes up to a minute, then a screenshot may follow.
   */
  async computer(id: string, action: ComputerAction, signal?: AbortSignal): Promise<ComputerResult> {
    const response = await this.send(`computer ${action.action} in ${id}`, "POST", `${sandboxPath(id)}/computer`, { json: action, signal, timeout: TIMEOUTS.computer })
    return (await response.json()) as ComputerResult
  }

  /** a screenshot (or a zoom) as the PNG itself, with its size and the screen's from the headers */
  async screenshot(id: string, action: ComputerAction, signal?: AbortSignal): Promise<Screenshot> {
    const response = await this.send(`screenshot of ${id}`, "POST", `${sandboxPath(id)}/computer`, { json: action, signal, timeout: TIMEOUTS.computer, headers: { accept: "image/png" } })
    const png = new Uint8Array(await response.arrayBuffer())
    const number = (name: string) => Number(response.headers.get(name)) || 0
    return { png, width: number("x-kyora-image-width"), height: number("x-kyora-image-height"), screen: { width: number("x-kyora-screen-width"), height: number("x-kyora-screen-height") } }
  }

  /**
   * A JSON call on kyora cloud for the session commands: the same
   * bearer, redirect and error handling as every other call. `raw` returns the response itself.
   */
  async call<T>(action: string, method: string, path: string, options: { json?: unknown; body?: Uint8Array<ArrayBuffer>; contentType?: string; timeout?: number; accept?: number[] } = {}): Promise<T> {
    const response = await this.send(action, method, path, { json: options.json, body: options.body, contentType: options.contentType, timeout: options.timeout ?? TIMEOUTS.create, accept: options.accept })
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** a stored blob of kyora cloud's (a session's last checkpoint), as its response */
  async fetchRaw(action: string, path: string, signal?: AbortSignal): Promise<Response> {
    return this.send(action, "GET", path, { signal })
  }

  /** the sandbox's terminal sessions; also how `shell` learns the sandbox is there, and has terminals */
  async ttySessions(id: string, signal?: AbortSignal): Promise<TtySession[]> {
    const response = await this.terminals(this.send(`list the terminal sessions of ${id}`, "GET", `${sandboxPath(id)}/tty/sessions`, { timeout: TIMEOUTS.short, signal }))
    return ((await response.json()) as { sessions?: TtySession[] }).sessions ?? []
  }

  async createShare(id: string, body: { stream: "screen" | "tty"; session?: string; display?: ShareDisplay; quality?: "high" | "low"; mode?: "vnc" | "broadcast"; keys?: "masked" | "full"; record?: { bucket: string; prefix?: string; segmentSeconds?: number }; ttlSeconds?: number }): Promise<Share> {
    return this.call("share the sandbox", "POST", `${sandboxPath(id)}/shares`, { json: body })
  }

  async listShares(id: string): Promise<{ shares: Share[] }> {
    return this.call("list sandbox shares", "GET", `${sandboxPath(id)}/shares`)
  }

  async revokeShare(id: string, shareId: string): Promise<void> {
    if (!/^share_[A-Za-z0-9_-]{16}$/.test(shareId)) throw new ApiError("revoke takes the share id from --list", 400, "invalid_request")
    await this.call("revoke the sandbox share", "DELETE", `${sandboxPath(id)}/shares/${encodeURIComponent(shareId)}`)
  }

  /** the session (made if it isn't there), and with `cmd` a new window in it running that */
  async ttyCreate(id: string, body: TtyCreate): Promise<{ name: string; created: boolean; window: string | null }> {
    const response = await this.terminals(this.send(`open a terminal session in ${id}`, "POST", `${sandboxPath(id)}/tty/sessions`, { json: body, timeout: TIMEOUTS.short }))
    return (await response.json()) as { name: string; created: boolean; window: string | null }
  }

  /** ends the session and everything running in it */
  async ttyKill(id: string, name: string): Promise<void> {
    await this.terminals(this.send(`kill the terminal session ${name} in ${id}`, "DELETE", `${sandboxPath(id)}/tty/sessions/${encodeURIComponent(name)}`, { timeout: TIMEOUTS.short }))
  }

  /**
   * A kyora-vmd from before terminals has no such routes: its 404 ("no such route") would read as a
   * missing sandbox. Its health says what it can do; without `tty`, that is what the user is told.
   */
  private async terminals(request: Promise<Response>): Promise<Response> {
    try {
      return await request
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || error.code !== "not_found") throw error
      const features = (await this.health().catch(() => null))?.features
      if (!Array.isArray(features) || features.includes("tty")) throw error
      throw new ApiError(`terminals are unavailable on ${this.url}; update the machine software`, 501, "unsupported")
    }
  }

  /** a terminal's address: the session `name` at this size (kyora-vmd's tty.ts framing, through kyora cloud the same) */
  private ttyPath(id: string, query: { name: string; cols: number; rows: number; control: boolean; term: string }): string {
    const params = new URLSearchParams({ name: query.name, cols: String(query.cols), rows: String(query.rows), control: query.control ? "1" : "0", term: query.term })
    return `${sandboxPath(id)}/tty?${params}`
  }

  /** a terminal: the WebSocket to the session `name` */
  ttySocket(id: string, query: { name: string; cols: number; rows: number; control: boolean; term: string }): WebSocket {
    if (!this.config.key) throw new ApiError(`attach to ${id}: no credentials for ${this.url}`, 0)
    const url = `${this.config.url.replace(/^http/, "ws")}${this.ttyPath(id, query)}`
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.config.key}`, "user-agent": `kyora-vms/${VERSION}` } } as unknown as string[])
    ws.binaryType = "arraybuffer"
    return ws
  }

  /**
   * Why a terminal's WebSocket wasn't taken: a WebSocket that isn't upgraded says only that it wasn't,
   * so the same address is asked again as a plain request. The server answers that 426 when nothing
   * else stands in the way (null: the failure was the network's, or passing); a refusal comes back
   * as the ApiError it is, its status and message.
   */
  async ttyRefusal(id: string, query: { name: string; cols: number; rows: number; control: boolean; term: string }, signal?: AbortSignal): Promise<ApiError | null> {
    try {
      // short: it only says why, and a network that is down shouldn't hold the next attempt up
      const response = await this.send(`attach to ${id}`, "GET", this.ttyPath(id, query), { timeout: 10_000, signal, accept: [426], noHint: true })
      await response.body?.cancel().catch(() => {})
      return null
    } catch (error) {
      return error instanceof ApiError && error.status !== 0 ? error : null
    }
  }

  /** the orgs the person behind this token is in (`kyora vms org ls`); works without vms access of their own */
  async orgs(): Promise<OrgInfo[]> {
    const response = await this.send("list orgs", "GET", "/v1/orgs", { timeout: TIMEOUTS.short })
    return ((await response.json()) as { orgs?: OrgInfo[] }).orgs ?? []
  }

  async supportRequest(method: "GET" | "POST", id?: string, body?: { subject?: string; category?: string; message: string }, before?: string): Promise<{ tickets: import("./support.js").SupportTicket[] } | { ticket: import("./support.js").SupportTicket }> {
    const path = `/v1/support/tickets${id ? `/${encodeURIComponent(id)}${method === "POST" ? "/messages" : ""}` : ""}${before !== undefined ? `?before_message=${encodeURIComponent(before)}` : ""}`
    const response = await this.send("support", method, path, { json: body, timeout: TIMEOUTS.short })
    return await response.json() as { tickets: import("./support.js").SupportTicket[] } | { ticket: import("./support.js").SupportTicket }
  }

  /** an org token for the person behind this personal token (`kyora vms org use`) */
  async orgToken(org: string, name: string): Promise<OrgToken> {
    const response = await this.send(`get a token for the org ${org}`, "POST", `/v1/orgs/${encodeURIComponent(org)}/tokens`, { json: { name }, timeout: TIMEOUTS.short })
    return (await response.json()) as OrgToken
  }

  async createApiToken(body: CreateApiToken, org?: string): Promise<{ token: string; record: ApiTokenRecord }> {
    const path = org ? `/v1/orgs/${encodeURIComponent(org)}/tokens` : "/v1/tokens"
    const response = await this.send("create API token", "POST", path, { json: body, timeout: TIMEOUTS.short })
    return await response.json() as { token: string; record: ApiTokenRecord }
  }

  async apiTokens(org?: string): Promise<ApiTokenRecord[]> {
    const path = org ? `/v1/orgs/${encodeURIComponent(org)}/tokens` : "/v1/tokens"
    const response = await this.send("list API tokens", "GET", path, { timeout: TIMEOUTS.short })
    return ((await response.json()) as { tokens: ApiTokenRecord[] }).tokens
  }

  async revokeApiToken(id: string, org?: string): Promise<void> {
    const path = org ? `/v1/orgs/${encodeURIComponent(org)}/tokens/${encodeURIComponent(id)}` : `/v1/tokens/${encodeURIComponent(id)}`
    const response = await this.send("revoke API token", "DELETE", path, { timeout: TIMEOUTS.short })
    await response.body?.cancel()
  }

  async me(): Promise<Me> {
    const response = await this.send("whoami", "GET", "/v1/me", { timeout: TIMEOUTS.short })
    return (await response.json()) as Me
  }

  async regions(): Promise<Regions> {
    const response = await this.send("list regions", "GET", "/v1/regions", { timeout: TIMEOUTS.short })
    return (await response.json()) as Regions
  }

  /** where your creates go unless they name a region; null: where you are */
  async setRegion(region: string | null): Promise<string | null> {
    const response = await this.send("set your region", "PUT", "/v1/me/region", { json: { region }, timeout: TIMEOUTS.short })
    return ((await response.json()) as { region: string | null }).region
  }

  /** custom domains: a hostname of yours for one of your public URL names, or (`{ page }`) one of your public pages */
  async domainAdd(hostname: string, to: string | { page: string }, dcv?: "http" | "txt"): Promise<CustomDomain> {
    const target = typeof to === "string" ? { label: to } : { page: to.page }
    const response = await this.send(`add ${hostname}`, "POST", "/v1/domains", { json: { hostname, ...target, ...(dcv ? { dcv } : {}) }, timeout: TIMEOUTS.short })
    return (await response.json()) as CustomDomain
  }

  async domains(): Promise<CustomDomain[]> {
    const response = await this.send("list custom domains", "GET", "/v1/domains", { timeout: TIMEOUTS.short })
    return ((await response.json()) as { domains?: CustomDomain[] }).domains ?? []
  }

  /** its status, read from Cloudflare by kyora cloud as you ask */
  async domain(hostname: string): Promise<CustomDomain> {
    const response = await this.send(`status of ${hostname}`, "GET", `/v1/domains/${encodeURIComponent(hostname)}`, { timeout: TIMEOUTS.short })
    return (await response.json()) as CustomDomain
  }

  async domainRemove(hostname: string): Promise<void> {
    await this.send(`remove ${hostname}`, "DELETE", `/v1/domains/${encodeURIComponent(hostname)}`, { timeout: TIMEOUTS.short, accept: [204] })
  }

  /** static pages; their errors say what the server said, without the hints for sandboxes */
  async pageCreate(body: PageCreate): Promise<Page> {
    const response = await this.send("publish", "POST", "/v1/pages", { json: body, timeout: TIMEOUTS.short, noHint: true })
    return (await response.json()) as Page
  }

  async pages(): Promise<Page[]> {
    const response = await this.send("list pages", "GET", "/v1/pages", { timeout: TIMEOUTS.short, noHint: true })
    return ((await response.json()) as { pages?: Page[] }).pages ?? []
  }

  async page(name: string): Promise<Page> {
    const response = await this.send(`page ${name}`, "GET", `/v1/pages/${encodeURIComponent(name)}`, { timeout: TIMEOUTS.short, noHint: true })
    return (await response.json()) as Page
  }

  async pageRemove(name: string): Promise<void> {
    await this.send(`remove page ${name}`, "DELETE", `/v1/pages/${encodeURIComponent(name)}`, { timeout: TIMEOUTS.short, accept: [204], noHint: true })
  }

  /** a signed link, good for 60 s, that signs a browser in to a private page */
  async pageLogin(name: string): Promise<string> {
    const response = await this.send(`sign in to ${name}`, "POST", `/v1/pages/${encodeURIComponent(name)}/login`, { timeout: TIMEOUTS.short, noHint: true })
    return ((await response.json()) as { loginUrl: string }).loginUrl
  }

  async nodes(): Promise<NodeInfo[]> {
    const response = await this.send("list machines", "GET", "/v1/nodes", { timeout: TIMEOUTS.short })
    return ((await response.json()) as { nodes?: NodeInfo[] }).nodes ?? []
  }

  /** `org`: the token is to act as that org (kyora vms login --org); the approver must be in it */
  async deviceStart(hostname: string, org?: string): Promise<DeviceStart> {
    const response = await this.send("login", "POST", "/v1/auth/device", { auth: false, json: { client: "kyora-vms", hostname, ...(org ? { org } : {}) }, timeout: TIMEOUTS.short })
    const start = (await response.json().catch(() => null)) as Partial<DeviceStart> | null
    if (!start || typeof start.deviceCode !== "string" || typeof start.userCode !== "string" || typeof start.verifyUrl !== "string") {
      throw new ApiError(`login: ${this.url} did not start a device login`, 502)
    }
    return {
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verifyUrl: start.verifyUrl,
      interval: typeof start.interval === "number" ? start.interval : 5,
      expiresIn: typeof start.expiresIn === "number" ? start.expiresIn : 600,
    }
  }

  /** 428 while nobody has decided, 410 once denied or expired, 200 with the token */
  async devicePoll(deviceCode: string): Promise<DevicePoll> {
    const response = await this.send("login", "POST", "/v1/auth/device/token", { auth: false, json: { deviceCode }, timeout: TIMEOUTS.short, accept: [410, 428, 429] })
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; status?: unknown; message?: unknown; token?: unknown; login?: unknown; expiresAt?: unknown }
    if (response.status === 428) return { status: "pending" }
    if (response.status === 429 || body.error === "slow_down") return { status: "slow_down" }
    if (response.status === 410) {
      const message = typeof body.message === "string" ? body.message : "the login was not approved"
      return { status: body.status === "denied" || body.error === "denied" ? "denied" : "expired", message }
    }
    if (typeof body.token !== "string" || !body.token) throw new ApiError(`login: ${this.url} approved the login but sent no token`, 502)
    const { org, actor } = body as { org?: { id?: unknown; login?: unknown }; actor?: unknown }
    return {
      status: "approved",
      token: body.token,
      login: typeof body.login === "string" ? body.login : "?",
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      ...(typeof org?.id === "string" && typeof org.login === "string" ? { org: { id: org.id, login: org.login } } : {}),
      ...(typeof actor === "string" ? { actor } : {}),
    }
  }
}
