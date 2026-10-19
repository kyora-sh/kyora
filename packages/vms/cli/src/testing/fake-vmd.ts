import type { Server } from "bun"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { fakeTty, type FakeTty } from "./fake-tty"
import { ACCOUNT_IMAGE_NAME, CHUNK_SIZE, chunkLength, isReservedAccountImageName, MAX_STORED_CHUNK, type ManifestChunk, parseChunkList, SHA256_HEX } from "../../../shared/image-chunks"

export const KEY = "kvms_test_7f3a9c1e5b2d8f604a1c3e5b7d9f1a2c"
/** a kyora cloud personal token the fake platform accepts from the start */
export const TOKEN = "kyora_test_4b8e2d6f0a1c3e5b7d9f1a2c4e6b8d0f"
/** every token a fake platform's login handed out, so no test output may contain one either */
export const MINTED: string[] = []

/**
 * A stand-in for kyora-vmd that speaks the Host API contract over real HTTP, with a
 * temp dir as each sandbox's /work: uploads are unpacked by the system tar (bsdtar
 * here, GNU tar in CI), downloads are packed by it, and exec runs the command for
 * real in its own process group so a dropped stream can kill it the way the host does.
 *
 * `startFakePlatform` is the same server playing kyora cloud: kyora_ tokens, the
 * device login, /v1/me and /v1/nodes, and multipart uploads whose parts land on disk
 * and are checked the way R2 checks them before the whole is unpacked.
 */

interface FakeSandbox {
  shareable?: boolean
  name?: string
  image?: string
  idleSeconds?: number
  ttlSeconds?: number
  id: string
  root: string
  work: string
  network: string
  egressAllow?: string[]
  vcpus: number
  memoryMb: number
  diskGb: number
  createdAt: string
  expiresAt: string | null
  busy: number
}

export interface ExecRecord {
  id: string
  cmd: string[]
  cwd: string
  env: Record<string, string>
  timeoutSeconds?: number
  stdin?: string
  pid: number
}

export interface MultipartRecord {
  /** the sandbox */
  id: string
  uploadId: string
  dest: string
  contentType: string
  status: "open" | "complete" | "aborted"
  /** sizes of the parts it was completed with, in order */
  parts: number[]
  /** sha256 of the object the parts made up */
  sha256: string | null
  bytes: number
}

export interface DeviceRecord {
  deviceCode: string
  userCode: string
  client: string
  hostname: string | null
  status: "pending" | "approved" | "denied" | "claimed"
  expiresAt: number
  polls: number
}

export interface FakeOptions {
  /** Add API warnings to successful creates, including queued creates. */
  createWarnings?: string[]
  /** Simulate a server from before unshareable sandboxes: it drops `shareable` and never shows it. */
  ignoreShareable?: boolean
  /** Simulate a vmd from before user network policies. */
  networkPolicy?: boolean
  /** terminals: the machine's keepalive (default 15 s) */
  ttyKeepaliveMs?: number
  /** answer every computer action with this error */
  computerFailure?: { status: number; error: string; message: string }
  /** answer POST /v1/sandboxes with this error instead */
  defaultTtlSeconds?: number
  maxTtlSeconds?: number
  createFailure?: { status: number; error: string; message: string }
  /**
   * kyora cloud: a create that may wait (`wait` > 0) gets a ticket behind this many others; each
   * poll moves it up one, and a poll at the head gets the sandbox (or `queueFailure`)
   */
  queueAhead?: number
  /** kyora cloud: how the wait in line ends instead of with a sandbox (e.g. 503 no_capacity once it ran out) */
  queueFailure?: { status: number; error: string; message: string }
  /** kyora cloud: each poll of a ticket is held this long first (a long poll with no news) */
  queuePollMs?: number
  /** kyora cloud: answers a poll (its `attempt`th for that ticket, from 1) instead of the queue; null lets the queue answer */
  queuePoll?: (attempt: number) => Response | null
  /** 413 once an upload body passes this many bytes */
  uploadLimit?: number
  /** replaces the tar the fake would build for GET …/files */
  download?: (paths: string[], compress: boolean) => Response
  /** replaces the event stream of POST …/exec, for infrastructure failures */
  exec?: () => Response
  /** kyora cloud: the part size it hands out (the real one says 64 MiB) */
  partSize?: number
  /** kyora cloud: answers part `n` of `uploadId` (its `attempt`th PUT, from 1) instead of storing it; null stores it as usual */
  part?: (n: number, attempt: number, uploadId: string) => Response | null | Promise<Response | null>
  /** kyora cloud: seconds between login polls, and until a login code expires */
  deviceInterval?: number
  deviceExpiresIn?: number
  /** kyora cloud: what GET /v1/nodes lists */
  images?: unknown[]
  nodes?: unknown[]
  /**
   * kyora cloud: offer stored downloads as byte ranges, the way the platform is to next:
   * `accept-ranges: bytes`, an `etag`, and `content-location` naming the stored object,
   * which answers `Range: bytes=a-b` with a 206
   */
  ranges?: boolean
  /** kyora cloud: store a download before answering (with its length), as the platform does, without offering ranges */
  storeDownloads?: boolean
  /** kyora cloud: answers a range request (its `attempt`th for that start, from 1) instead of serving it; null serves it */
  range?: (start: number, end: number, attempt: number) => Response | null | Promise<Response | null>
  /** every request but /v1/health waits this long before it is looked at (a round trip to the edge) */
  latencyMs?: number
  /** kyora cloud: each completed upload goes into the sandbox at most this fast (the machine's side of a push: R2 → node → guest) */
  unpackBytesPerSecond?: number
  /**
   * kyora cloud: completed uploads wait until `count` are in, then go into the sandbox one
   * after another in the order `order` gives (indexes into the archives, each listed by its
   * entry names): any order a machine unpacking them side by side could end up taking
   */
  unpackOrder?: { count: number; order: (archives: string[][]) => number[] }
  /**
   * exec: false answers like a server from before resumable commands (it ignores `resumable`: no
   * `started` line, and dropping the stream kills the command); default true
   */
  resumable?: boolean
  /** exec: a server whose guest agent is too old: `{"type":"started","resumable":false}`, then as before */
  oldAgent?: boolean
  /**
   * Resumable streams, the exec's and then each reattach's in the order they open, are cut
   * after this many output bytes each, in the middle of the next line; streams past the end of
   * the list run uncut
   */
  cutAfter?: number[]
  /**
   * how a cut looks to the client: "end" closes the response mid-line, "reset" errors it (a
   * dropped connection), "orphan" leaves it open with nothing from the command any more, only
   * `orphanPing` every `orphanPingMs` (a control plane still answering for a machine path that is gone)
   */
  cutMode?: "end" | "reset" | "orphan"
  /** what an orphaned stream keeps sending; default kyora cloud's own keepalive, `{"type":"ping","from":"cloud"}` */
  orphanPing?: Record<string, unknown>
  /** default 100 */
  orphanPingMs?: number
  /**
   * exec streams carry kyora-vmd's keepalive after this much silence, and say so in
   * `x-kyora-keepalive-ms` (default 20 s, as kyora-vmd); false: a server that sends neither
   */
  keepaliveMs?: number | false
  /**
   * the keepalives are the machine's own, as kyora-vmd's are: `{"type":"ping","from":"machine","seq",
   * "stdout","stderr"}`, and each stream's first line says so (`started`/`attached` carry `"from":
   * "machine"`, a plain exec opens with one) (default); false: plain `{"type":"ping"}`, as a kyora-vmd
   * from before it marked them
   */
  machinePings?: boolean
  /** exec: the command runs past its `timeoutSeconds` (only a cancel or the end stops it) */
  ignoreTimeouts?: boolean
  /**
   * exec: the sandbox stays busy (409 exec_busy) this long after a command's exit went out, as kyora
   * cloud's was until kyora-node's result came (before it freed the slot at the exit)
   */
  busyAfterExitMs?: number
  /** answers reattach attempt `attempt` (from 1, any exec) instead of serving it; null serves it */
  attach?: (attempt: number) => Response | null | Promise<Response | null>
  /** reattaches replay only the latest this many bytes of each stream; older output is a gap */
  keepBytes?: number
  /** PUT …/files: called as upload `attempt` (from 1) arrives, before it is read (a test cuts the connection here) */
  onUpload?: (attempt: number) => void | Promise<void>
  /** PUT …/files: an answer instead of taking the upload (a 409 of a sandbox that can't take files now); null takes it */
  refuseUpload?: (dest: string) => Response | null
  /** GET …/files: download `attempt` (from 1) breaks off after this many body bytes; null sends it whole */
  cutDownload?: (attempt: number) => number | null
  /** kyora cloud: answers the complete of attempt `attempt` (from 1, any upload) instead of doing it; null does it */
  complete?: (attempt: number) => Response | null | Promise<Response | null>
}

/** a command started with `resumable: true`: it outlives its stream, and its output is kept for reattaches */
export interface FakeCommand {
  execId: string
  /** the sandbox */
  id: string
  pid: number
  /** output as it came, both streams interleaved, each chunk with its offset in its own stream */
  chunks: { stream: "stdout" | "stderr"; offset: number; data: Uint8Array }[]
  ends: { stdout: number; stderr: number }
  exit: Record<string, unknown> | null
  /** woken when output or the exit arrives */
  listeners: Set<() => void>
  /** streams following it right now */
  following: number
}

export interface FakeVmd {
  kind: "vmd" | "platform"
  url: string
  options: FakeOptions
  sandboxes: Map<string, FakeSandbox>
  created: Record<string, unknown>[]
  destroyed: string[]
  /** single-request uploads (PUT …/files) */
  uploads: { id: string; dest: string; contentType: string | null; bytes: number; entries: number }[]
  execs: ExecRecord[]
  /** exec streams whose client went away before the command finished */
  disconnects: { id: string; pid: number }[]
  /** resumable commands by exec id */
  commands: Map<string, FakeCommand>
  /** reattach requests, as they arrived, with the answer's status */
  attaches: { id: string; execId: string; from: string; status: number }[]
  /** explicit cancels (POST …/execs/:execId/cancel) */
  cancels: { id: string; execId: string; pid: number | null }[]
  /** resumable streams cut so far (by `cutAfter` or `cut()`) */
  cuts: number
  /** the most streams of one command open at once (a client that gives up on one must close it, not leave it attached) */
  maxFollowing: number
  /** cuts every resumable stream open right now, mid-line; returns how many */
  cut: () => number
  /** PUT …/files requests, cut or not */
  uploadAttempts: number
  /** kyora cloud's account images, one account's, by id */
  accountImages: Map<string, FakeAccountImage>
  /** the chunk keys the account holds, with their stored sizes */
  imageChunks: Map<string, number>
  /** PUT /v1/images/:id/chunks/:key, in order, by key */
  imageChunkPuts: string[]
  /** GET …/files requests */
  downloadAttempts: number
  unauthorized: number
  /** "METHOD /path" of every request, in order */
  requests: string[]
  /** computer actions (POST …/computer), with the accept header they came with */
  computer: { id: string; action: Record<string, unknown>; accept: string | null }[]
  /** kyora cloud: multipart uploads, as started, completed or aborted */
  multipart: MultipartRecord[]
  /** kyora cloud: every part PUT in order of arrival, stored or not */
  partPuts: { uploadId: string; n: number; bytes: number; attempt: number }[]
  /** kyora cloud: the most part PUTs being received at once */
  maxPartsInFlight: number
  /** kyora cloud: the most completed uploads being unpacked into a sandbox at once */
  maxUnpacking: number
  /** kyora cloud: requests for byte ranges of stored downloads, as they arrived */
  rangeGets: { transfer: string; start: number; end: number; status: number }[]
  /** kyora cloud: creates that waited in line, by ticket */
  tickets: Map<string, { ahead: number; polls: number; status: "queued" | "placed" | "failed" | "cancelled"; spec: Record<string, unknown> }>
  /** kyora cloud: device logins */
  devices: DeviceRecord[]
  /** kyora cloud: tokens it takes, TOKEN and whatever logins minted */
  tokens: Set<string>
  /** kyora cloud: what the person in the browser does with a login code */
  decide: (userCode: string, decision: "approved" | "denied") => void
  work: (id: string) => string
  /** terminals (`GET …/tty`, `…/tty/sessions`): their sessions, attaches and what the clients sent */
  tty: FakeTty
  stop: () => Promise<void>
}

const error = (status: number, code: string, message: string) => Response.json({ error: code, message }, { status })

export interface FakeAccountImage {
  id: string
  name: string
  /** each push of a name is its next version */
  version: number
  specKey: string | null
  base: string | null
  status: "uploading" | "ready" | "deleted"
  region: string | null
  sha256: string
  bytes: number
  chunks: ManifestChunk[]
  createdAt: string
  readyAt: string | null
}

const imageView = (image: FakeAccountImage) => ({
  id: image.id,
  name: image.name,
  version: image.version,
  ref: `${image.name}@${image.version}`,
  specKey: image.specKey,
  base: image.base,
  status: image.status,
  region: image.region,
  sha256: image.sha256,
  bytes: image.bytes,
  chunks: image.chunks.length,
  dataBytes: image.chunks.reduce((sum, entry) => sum + chunkLength(entry[0], image.bytes), 0),
  storedBytes: [...new Map(image.chunks.map((entry) => [entry[2], entry[3]])).values()].reduce((sum, bytes) => sum + bytes, 0),
  digest: image.status === "ready" ? "0".repeat(64) : null,
  createdAt: image.createdAt,
  readyAt: image.readyAt,
  expiresAt: null,
  error: null,
})

/**
 * kyora cloud's account image routes, in memory: one account, its deduplicated chunk set, the begin / PUT / commit state machine and the
 * usage view. Null for paths it doesn't own.
 */
async function accountImageRoute(vmd: FakeVmd, request: Request, url: URL): Promise<Response | null> {
  const images = vmd.accountImages
  const live = () => [...images.values()].filter((image) => image.status === "ready")
  if (url.pathname === "/v1/images" && request.method === "POST") {
    const body = await request.json() as Record<string, unknown>
    if (typeof body.name !== "string" || !ACCOUNT_IMAGE_NAME.test(body.name)) return error(400, "invalid_request", "name must be an image name")
    if (typeof body.bytes !== "number" || body.bytes <= 0 || body.bytes % CHUNK_SIZE !== 0) return error(400, "invalid_request", "bytes must be a positive multiple of 4 MiB")
    if (typeof body.sha256 !== "string" || !SHA256_HEX.test(body.sha256) || body.chunkSize !== CHUNK_SIZE) return error(400, "invalid_request", "sha256 and chunkSize")
    if (isReservedAccountImageName(body.name)) return error(409, "name_reserved", `${body.name} is a kyora image's name`)
    const version = 1 + Math.max(0, ...[...images.values()].filter((image) => image.name === body.name).map((image) => image.version))
    let chunks: ManifestChunk[]
    try {
      chunks = parseChunkList(body.chunks, body.bytes)
    } catch (failure) {
      return error(400, "invalid_request", (failure as Error).message)
    }
    const id = `img_fake${String(images.size + 1).padStart(8, "0")}`
    images.set(id, { id, name: body.name, version, specKey: typeof body.specKey === "string" ? body.specKey : null, base: typeof body.base === "string" ? body.base : null, status: "uploading", region: typeof body.region === "string" ? body.region : "eu", sha256: body.sha256, bytes: body.bytes, chunks, createdAt: new Date().toISOString(), readyAt: null })
    const missing = [...new Set(chunks.map((entry) => entry[2]))].filter((key) => !vmd.imageChunks.has(key))
    return Response.json({ id, missing, image: imageView(images.get(id)!) }, { status: 201 })
  }
  if (url.pathname === "/v1/images/usage" && request.method === "GET") {
    const keys = new Map<string, number>()
    for (const image of live()) for (const entry of image.chunks) keys.set(entry[2], entry[3])
    const storedBytes = [...keys.values()].reduce((sum, bytes) => sum + bytes, 0)
    return Response.json({ month: new Date().toISOString().slice(0, 7), storedBytes, gbMonths: 0, usd: 0, rate: 0.0225, images: live().length, caps: { images: 100, storedBytes: 200e9 } })
  }
  const chunk = /^\/v1\/images\/([^/]+)\/chunks\/([0-9a-f]{64})$/.exec(url.pathname)
  if (chunk && request.method === "PUT") {
    const image = images.get(decodeURIComponent(chunk[1]!))
    if (!image || image.status === "deleted") return error(404, "image_not_found", "no such image")
    if (image.status !== "uploading") return error(409, "image_closed", "not uploading")
    const key = chunk[2]!
    if (!image.chunks.some((entry) => entry[2] === key)) return error(400, "invalid_request", "that key is not in the image's manifest")
    const data = new Uint8Array(await request.arrayBuffer())
    if (data.byteLength > MAX_STORED_CHUNK) return error(413, "too_large", "chunk too large")
    if (new Bun.CryptoHasher("sha256").update(data).digest("hex") !== key) return error(422, "chunk_mismatch", "the chunk's sha256 is not its key")
    vmd.imageChunkPuts.push(key)
    const stored = !vmd.imageChunks.has(key)
    vmd.imageChunks.set(key, data.byteLength)
    return Response.json({ key, bytes: data.byteLength, stored })
  }
  const commit = /^\/v1\/images\/([^/]+)\/commit$/.exec(url.pathname)
  if (commit && request.method === "POST") {
    const image = images.get(decodeURIComponent(commit[1]!))
    if (!image || image.status === "deleted") return error(404, "image_not_found", "no such image")
    const missing = [...new Set(image.chunks.map((entry) => entry[2]))].filter((key) => !vmd.imageChunks.has(key))
    if (missing.length) return Response.json({ error: "chunks_missing", message: `${missing.length} chunk(s) missing`, missing }, { status: 409 })
    image.status = "ready"
    image.readyAt = new Date().toISOString()
    return Response.json(imageView(image))
  }
  const one = /^\/v1\/images\/([^/]+)$/.exec(url.pathname)
  if (one) {
    const image = images.get(decodeURIComponent(one[1]!))
    if (!image || image.status === "deleted") return error(404, "image_not_found", "no such image")
    if (request.method === "GET") return Response.json(imageView(image))
    if (request.method === "DELETE") {
      image.status = "deleted"
      return new Response(null, { status: 204 })
    }
  }
  return null
}

/** a real 1x1 PNG: what the fake desktop's screenshots are */
export const FAKE_PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"))

const decoder = new TextDecoder("utf-8", { fatal: true })

function outputEvent(type: "stdout" | "stderr", chunk: Uint8Array): Record<string, string> {
  try {
    return { type, data: decoder.decode(chunk) }
  } catch {
    return { type, b64: Buffer.from(chunk).toString("base64") }
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // already gone
  }
}

/** /work/… → the sandbox's temp dir; null for anything outside /work */
function local(sandbox: FakeSandbox, path: string): string | null {
  const normal = posix.normalize(path)
  if (normal === "/work") return sandbox.work
  // the guest's /tmp, which kyora session's supervisor talks through (control/, status/, export/)
  if (normal.startsWith("/tmp/")) return join(sandbox.root, normal.slice(1))
  if (!normal.startsWith("/work/")) return null
  return join(sandbox.work, normal.slice("/work/".length))
}

/**
 * A request body's chunks, read as kyora-vmd reads an upload: through a reader that is never
 * released. On Bun 1.3, releaseLock() on a request body's reader after it read to the end now and
 * then throws "undefined is not a function", and `for await` over the body calls it on the way out,
 * so the upload failed as if the client had gone away. Leaving early cancels the rest, as that did.
 */
async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        finished = true
        return
      }
      yield value
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
  }
}

/** a stream handed on at most `bytesPerSecond`, in 256 KiB steps so a big chunk does not arrive in one burst */
export function paced(stream: ReadableStream<Uint8Array>, bytesPerSecond: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  const step = 256 * 1024
  let started = 0
  let sent = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { value, done } = await reader.read()
        if (done) return controller.close()
        started ||= performance.now()
        for (let offset = 0; offset < value.length; offset += step) {
          const piece = value.subarray(offset, offset + step)
          sent += piece.length
          const wait = started + (sent / bytesPerSecond) * 1000 - performance.now()
          if (wait > 0) await Bun.sleep(wait)
          controller.enqueue(piece)
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/** hands on the first `bytes` of a stream, then breaks off the way a dropped connection does */
export function breakAfter(stream: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  let sent = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { value, done } = await reader.read()
        if (done) return controller.close()
        const room = bytes - sent
        if (value.length < room) {
          sent += value.length
          return controller.enqueue(value)
        }
        if (room > 0) controller.enqueue(value.subarray(0, room))
        await Bun.sleep(20)
        reader.cancel().catch(() => {})
        controller.error(new Error("fake: the connection broke off"))
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

const TAR_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1", LC_ALL: "C" }
const hasZstd = Bun.which("zstd") !== null


const DEFAULT_NODES = [
  { name: "box-1", connected: true, free: { vcpus: 12, memoryMb: 40960, diskGb: null } },
  { name: "box-2", connected: false, free: { vcpus: 16, memoryMb: 49152, diskGb: null } },
]

export function startFakeVmd(initial: FakeOptions = {}): Promise<FakeVmd> {
  return startFake("vmd", initial)
}

export function startFakePlatform(initial: FakeOptions = {}): Promise<FakeVmd> {
  return startFake("platform", initial)
}

async function startFake(kind: FakeVmd["kind"], initial: FakeOptions): Promise<FakeVmd> {
  const root = await mkdtemp(join(tmpdir(), "kyora-vms-fake-"))
  const running = new Set<number>()
  const partFiles = new Map<string, Map<number, { path: string; bytes: number; etag: string }>>()
  const attempts = new Map<string, number>()
  /** kyora cloud: stored downloads by transfer id, as R2 keeps them for a day */
  const downloads = new Map<string, { sandbox: string; path: string; size: number; etag: string; contentType: string }>()
  let counter = 0
  let partsInFlight = 0
  let unpacking = 0
  /** completed uploads held for `unpackOrder` */
  const waiting: { names: string[]; go: () => void; finished: Promise<void> }[] = []
  /** resumable streams open right now, each with how to cut it */
  const following = new Set<() => void>()
  /** orphaned streams' keepalive timers, stopped with the server */
  const orphans = new Set<ReturnType<typeof setInterval>>()
  let attachAttempts = 0
  let completeAttempts = 0
  const tty = fakeTty({ keepaliveMs: initial.ttyKeepaliveMs })

  const vmd: FakeVmd = {
    kind,
    url: "",
    options: initial,
    sandboxes: new Map(),
    created: [],
    destroyed: [],
    uploads: [],
    execs: [],
    disconnects: [],
    commands: new Map(),
    attaches: [],
    cancels: [],
    cuts: 0,
    maxFollowing: 0,
    cut: () => {
      const open = [...following]
      for (const cut of open) cut()
      return open.length
    },
    uploadAttempts: 0,
    accountImages: new Map(),
    imageChunks: new Map(),
    imageChunkPuts: [],
    downloadAttempts: 0,
    unauthorized: 0,
    requests: [],
    computer: [],
    multipart: [],
    partPuts: [],
    maxPartsInFlight: 0,
    maxUnpacking: 0,
    rangeGets: [],
    tickets: new Map(),
    devices: [],
    tokens: new Set([TOKEN]),
    decide: (userCode, decision) => {
      const device = vmd.devices.find((d) => d.userCode === userCode)
      if (!device || device.status !== "pending") throw new Error(`no pending login ${userCode}`)
      device.status = decision
    },
    work: (id) => join(root, id, "work"),
    tty,
    stop: async () => {
      tty.stop()
      for (const timer of orphans) clearInterval(timer)
      for (const pid of running) killGroup(pid, "SIGKILL")
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }

  const describe = (s: FakeSandbox) => ({
    id: s.id,
    name: s.name,
    image: s.image,
    idleSeconds: s.idleSeconds,
    ttlSeconds: s.ttlSeconds,
    status: "running",
    ...(vmd.options.ignoreShareable ? {} : { shareable: s.shareable !== false }),
    network: s.network,
    vcpus: s.vcpus,
    memoryMb: s.memoryMb,
    diskGb: s.diskGb,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    ...(kind === "platform" ? { node: "box-1" } : {}),
  })

  /** a desktop that answers every action: OK, the cursor at 640,400, or a 1x1 PNG standing in for a 1280x800 screen */
  async function computer(sandbox: FakeSandbox, request: Request): Promise<Response> {
    const action = (await request.json()) as Record<string, unknown>
    const accept = request.headers.get("accept")
    vmd.computer.push({ id: sandbox.id, action, accept })
    if (vmd.options.computerFailure) {
      const { status, error: code, message } = vmd.options.computerFailure
      return error(status, code, message)
    }
    const shot = action.action === "screenshot" || action.action === "zoom" || action.screenshot === true
    const sizes = { image: { width: 1280, height: 800, bytes: FAKE_PNG.byteLength }, screen: { width: 1280, height: 800 } }
    if ((action.action === "screenshot" || action.action === "zoom") && accept?.includes("image/png")) {
      return new Response(FAKE_PNG, {
        headers: { "content-type": "image/png", "x-kyora-image-width": "1280", "x-kyora-image-height": "800", "x-kyora-screen-width": "1280", "x-kyora-screen-height": "800" },
      })
    }
    const content: Array<Record<string, unknown>> = []
    if (action.action === "cursor_position") content.push({ type: "text", text: "X=640,Y=400" })
    else if (action.action === "info") content.push({ type: "text", text: "a desktop on :1, 1280x800" })
    else if (action.action !== "screenshot" && action.action !== "zoom") content.push({ type: "text", text: "OK" })
    if (shot) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(FAKE_PNG).toString("base64") } })
    return Response.json({
      action: action.action,
      content,
      ...(shot ? sizes : {}),
      ...(action.action === "cursor_position" ? { cursor: { x: 640, y: 400 } } : {}),
      ...(action.action === "info" ? { desktop: { available: true, running: true, display: ":1", width: 1280, height: 800, depth: 24 } } : {}),
    })
  }

  async function createSandbox(request: Request): Promise<Response> {
    const spec = (await request.json()) as Record<string, unknown>
    vmd.created.push(spec)
    if (platform && typeof spec.wait === "number" && spec.wait > 0 && vmd.options.queueAhead !== undefined) {
      const ticket = `q_0_${(++counter).toString(36).padStart(24, "0")}`
      vmd.tickets.set(ticket, { ahead: vmd.options.queueAhead, polls: 0, status: "queued", spec })
      return queueView(ticket, spec.wait)
    }
    return place(spec)
  }

  function queueView(ticket: string, wait = 900): Response {
    const { ahead } = vmd.tickets.get(ticket)!
    const view = { ticket, status: "queued", position: ahead + 1, ahead, depth: ahead + 1, enqueuedAt: new Date().toISOString(), waitUntil: new Date(Date.now() + wait * 1000).toISOString() }
    return Response.json({ ...view, poll: `/v1/queue/${ticket}` }, { status: 202, headers: { location: `/v1/queue/${ticket}` } })
  }

  /** kyora cloud's `GET /v1/queue/:ticket`: a step up the line per poll, then the create's answer */
  async function pollTicket(ticket: string): Promise<Response> {
    const entry = vmd.tickets.get(ticket)
    if (!entry) return error(404, "not_found", "no such ticket")
    entry.polls++
    const override = vmd.options.queuePoll?.(entry.polls)
    if (override) return override
    if (vmd.options.queuePollMs) await Bun.sleep(vmd.options.queuePollMs)
    if (entry.status === "cancelled") return error(410, "cancelled", "the queued create was cancelled")
    if (entry.ahead > 0) {
      entry.ahead--
      return queueView(ticket)
    }
    const failure = vmd.options.queueFailure
    entry.status = failure ? "failed" : "placed"
    return failure ? error(failure.status, failure.error, failure.message) : place(entry.spec)
  }

  async function place(spec: Record<string, unknown>): Promise<Response> {
    if (typeof spec.ttlSeconds === "number" && vmd.options.maxTtlSeconds !== undefined && (spec.ttlSeconds === 0 || spec.ttlSeconds > vmd.options.maxTtlSeconds)) return error(400, "invalid_request", "ttlSeconds exceeds cap")
    const failure = vmd.options.createFailure
    if (failure) return error(failure.status, failure.error, failure.message)
    if (spec.name && [...vmd.sandboxes.values()].some((s) => s.name === spec.name)) return error(409, "name_taken", "name is already in use")
    const id = `sb_${(++counter).toString(16).padStart(16, "0")}`
    const sandbox: FakeSandbox = {
      id,
      shareable: vmd.options.ignoreShareable ? true : spec.shareable !== false,
      name: spec.name as string | undefined,
      image: spec.image as string | undefined,
      idleSeconds: spec.idleSeconds as number | undefined,
      ttlSeconds: spec.ttlSeconds as number | undefined,
      root: join(root, id),
      work: join(root, id, "work"),
      network: (spec.network as string) ?? "none",
      egressAllow: spec.egressAllow as string[] | undefined,
      vcpus: (spec.vcpus as number) ?? 4,
      memoryMb: (spec.memoryMb as number) ?? 8192,
      diskGb: (spec.diskGb as number) ?? 30,
      createdAt: new Date().toISOString(),
      expiresAt: spec.ttlSeconds === 0 ? null : new Date(Date.now() + ((spec.ttlSeconds as number) ?? Math.min(vmd.options.defaultTtlSeconds ?? 8 * 3600, vmd.options.maxTtlSeconds ?? Number.POSITIVE_INFINITY)) * 1000).toISOString(),
      busy: 0,
    }
    await mkdir(sandbox.work, { recursive: true })
    vmd.sandboxes.set(id, sandbox)
    return Response.json({ ...describe(sandbox), ...(vmd.options.createWarnings ? { warnings: vmd.options.createWarnings } : {}) }, { status: 201 })
  }

  /** a tar or tar.zst into `target`, as the guest agent unpacks one; a Response when it went wrong */
  async function unpack(target: string, contentType: string | null, body: ReadableStream<Uint8Array>): Promise<{ bytes: number; entries: number } | Response> {
    await mkdir(target, { recursive: true })
    const zstd = contentType === "application/zstd"
    const tar = ["tar", "-xpvf", "-", "-C", target]
    const proc = Bun.spawn({
      cmd: zstd && hasZstd ? ["sh", "-c", 'zstd -dcq | "$@"', "unpack", ...tar] : tar,
      env: TAR_ENV,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    let bytes = 0
    for await (const chunk of chunks(body)) {
      bytes += chunk.length
      if (vmd.options.uploadLimit !== undefined && bytes > vmd.options.uploadLimit) {
        proc.kill()
        return error(413, "too_large", `upload exceeds this key's limit of ${vmd.options.uploadLimit} bytes`)
      }
      proc.stdin.write(chunk)
      await proc.stdin.flush()
    }
    await proc.stdin.end()
    const code = await proc.exited
    const [stdout, stderr] = await out
    if (code !== 0) return error(400, "bad_archive", `tar failed: ${stderr.trim()}`)
    // bsdtar lists to stderr, GNU tar to stdout
    const entries = `${stdout}${stderr}`.split("\n").filter((line) => line.trim()).length
    return { bytes, entries }
  }

  /** what an archive lists, in order (a directory as `name/`) */
  async function entryNames(path: string, contentType: string | null): Promise<string[]> {
    const zstd = contentType === "application/zstd" && hasZstd
    const proc = Bun.spawn({ cmd: zstd ? ["sh", "-c", 'zstd -dcq <"$0" | tar -tf -', path] : ["tar", "-tf", path], env: TAR_ENV, stdout: "pipe", stderr: "ignore" })
    return (await new Response(proc.stdout).text()).split("\n").filter(Boolean)
  }

  /** with `unpackOrder`: waits for this upload's turn, and returns what ends it */
  async function unpackTurn(object: string, contentType: string | null): Promise<() => void> {
    const gate = vmd.options.unpackOrder
    if (!gate) return () => {}
    const turn = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    waiting.push({ names: await entryNames(object, contentType), go: turn.resolve, finished: done.promise })
    if (waiting.length === gate.count) {
      const batch = waiting.splice(0)
      void (async () => {
        for (const index of gate.order(batch.map((archive) => archive.names))) {
          batch[index]!.go()
          await batch[index]!.finished
        }
      })()
    }
    await turn.promise
    return done.resolve
  }

  async function upload(sandbox: FakeSandbox, request: Request, url: URL): Promise<Response> {
    const attempt = ++vmd.uploadAttempts
    await vmd.options.onUpload?.(attempt)
    const dest = url.searchParams.get("dest") ?? "/work"
    const refused = vmd.options.refuseUpload?.(dest)
    if (refused) {
      // read to the end first: a body left unread breaks the connection under the client on some platforms
      await request.arrayBuffer().catch(() => null)
      return refused
    }
    const target = local(sandbox, dest)
    if (!target) return error(400, "bad_dest", "dest must be under /work")
    const contentType = request.headers.get("content-type")
    const started = Date.now()
    let result: Awaited<ReturnType<typeof unpack>>
    try {
      result = await unpack(target, contentType, request.body ?? new ReadableStream<Uint8Array>())
    } catch {
      // the connection went away mid-body (a test cut it): nobody is there to answer
      return error(400, "short_body", "the client went away mid-upload")
    }
    if (result instanceof Response) return result
    vmd.uploads.push({ id: sandbox.id, dest, contentType, ...result })
    return Response.json({ ...result, durationMs: Date.now() - started })
  }

  async function download(sandbox: FakeSandbox, url: URL): Promise<Response> {
    const attempt = ++vmd.downloadAttempts
    const cutAt = vmd.options.cutDownload?.(attempt) ?? null
    const response = await downloadWhole(sandbox, url)
    if (cutAt === null || !response.ok || !response.body) return response
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    return new Response(breakAfter(response.body, cutAt), { status: response.status, headers })
  }

  async function downloadWhole(sandbox: FakeSandbox, url: URL): Promise<Response> {
    const paths = url.searchParams.getAll("path")
    const compress = url.searchParams.get("compress") === "zstd"
    if (vmd.options.download) return vmd.options.download(paths, compress)
    const rels: string[] = []
    // paths in the guest's /tmp are named from / (tmp/…), as the guest names anything outside /work
    const outside = paths.length > 0 && paths.every((path) => posix.normalize(path).startsWith("/tmp/"))
    for (const path of paths) {
      const target = local(sandbox, path)
      if (!target || !(await lstat(target).catch(() => null))) return error(404, "not_found", `not found: ${path}`)
      rels.push(outside ? posix.normalize(path).slice(1) : target === sandbox.work ? "." : posix.relative("/work", posix.normalize(path)))
    }
    // entries named relative to /work, which is how `run` lays --out out locally
    const base = outside ? sandbox.root : sandbox.work
    const tar = ["tar", "-cf", "-", "-C", base, "--", ...rels]
    const cmd = compress && hasZstd ? ["sh", "-c", 'tar -cf - -C "$0" -- "$@" | zstd -cq', base, ...rels] : tar
    const contentType = compress && hasZstd ? "application/zstd" : "application/x-tar"
    if (!(platform && (vmd.options.ranges || vmd.options.storeDownloads))) {
      const proc = Bun.spawn({ cmd, env: TAR_ENV, stdout: "pipe", stderr: "ignore" })
      return new Response(proc.stdout, { headers: { "content-type": contentType } })
    }
    // the platform stores the archive first (R2), so it knows the length and can serve any part of it
    const transfer = `tx_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const path = join(root, "downloads", transfer)
    await mkdir(join(root, "downloads"), { recursive: true })
    const proc = Bun.spawn({ cmd, env: TAR_ENV, stdout: Bun.file(path), stderr: "ignore" })
    await proc.exited
    const etag = `"${new Bun.CryptoHasher("md5").update(transfer).digest("hex")}"`
    downloads.set(transfer, { sandbox: sandbox.id, path, size: Bun.file(path).size, etag, contentType })
    // as the platform does today: the stored object with its length, and no ranges (Bun offers them on its own otherwise)
    if (!vmd.options.ranges) return new Response(Bun.file(path), { headers: { "content-type": contentType, "accept-ranges": "none", "cache-control": "no-store" } })
    return new Response(Bun.file(path), {
      headers: { "content-type": contentType, "accept-ranges": "bytes", "content-location": `/v1/sandboxes/${sandbox.id}/downloads/${transfer}`, etag, "cache-control": "no-store" },
    })
  }

  /** `GET /v1/sandboxes/:id/downloads/:transfer`: a stored download, whole or (`Range: bytes=a-b`) in part */
  async function storedDownload(sandbox: FakeSandbox, request: Request, transfer: string): Promise<Response> {
    const object = downloads.get(transfer)
    if (!object || object.sandbox !== sandbox.id) return error(404, "not_found", "no such download")
    const headers = { "content-type": object.contentType, "accept-ranges": "bytes", etag: object.etag }
    const ifMatch = request.headers.get("if-match")
    if (ifMatch && ifMatch !== object.etag) return error(412, "precondition_failed", "the download changed")
    const range = request.headers.get("range")
    if (!range) return new Response(Bun.file(object.path), { headers })
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    const start = Number(match?.[1])
    const end = Number(match?.[2])
    if (!match || start > end || end >= object.size) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${object.size}` } })
    }
    const key = `${transfer}/${start}`
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    const override = await vmd.options.range?.(start, end, attempt)
    vmd.rangeGets.push({ transfer, start, end, status: override?.status ?? 206 })
    if (override) return override
    return new Response(Bun.file(object.path).slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${object.size}` } })
  }

  type ExecBody = { cmd: string[]; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number; stdin?: string; resumable?: boolean }

  async function exec(sandbox: FakeSandbox, request: Request): Promise<Response> {
    if (sandbox.busy && (vmd.options.oldAgent || vmd.options.busyAfterExitMs)) return error(409, "exec_busy", `${sandbox.id} is already running a command`)
    if (sandbox.busy >= 32) return error(429, "exec_limit", "this sandbox's limit of 32 execs is reached")
    if (vmd.options.exec) return vmd.options.exec()
    const body = (await request.json()) as ExecBody
    const cwd = local(sandbox, body.cwd ?? "/work")
    if (!cwd) return error(400, "bad_cwd", "cwd must be under /work")
    const resumable = body.resumable === true && vmd.options.resumable !== false && !vmd.options.oldAgent
    return resumable ? resumableExec(sandbox, body, cwd) : classicExec(sandbox, request, body, cwd)
  }

  /** a server's whole stream count: the exec's and every reattach's, in the order they opened */
  let streamsOpened = 0

  /** the sandbox takes the next exec: at once, or `busyAfterExitMs` later */
  const freeSlot = (sandbox: FakeSandbox) => {
    const lag = vmd.options.busyAfterExitMs
    if (lag) setTimeout(() => (sandbox.busy = Math.max(0, sandbox.busy - 1)), lag)
    else sandbox.busy = Math.max(0, sandbox.busy - 1)
  }

  /** what an exec stream's response says about its keepalives */
  const keepaliveHeaders = (): Record<string, string> => {
    const every = vmd.options.keepaliveMs ?? 20_000
    return every === false ? {} : { "x-kyora-keepalive-ms": String(every) }
  }

  /** a stream's keepalive line, as kyora-vmd makes it: marked as the machine's, numbered, with where each stream is */
  function pinger(position: { stdout: number; stderr: number }): { line: () => Record<string, unknown>; marked: boolean } {
    let seq = 0
    const marked = vmd.options.machinePings !== false && vmd.options.keepaliveMs !== false
    return { line: () => (marked ? { type: "ping", from: "machine", seq: ++seq, stdout: position.stdout, stderr: position.stderr } : { type: "ping" }), marked }
  }

  /** kyora-vmd's keepalive: `ping()` after every quiet spell of `keepaliveMs` while the stream is open; `touch` on each line */
  function keepalive(ping: () => void): { touch: () => void; stop: () => void } {
    const every = vmd.options.keepaliveMs ?? 20_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      clearTimeout(timer)
      if (every !== false) timer = setTimeout(ping, every)
    }
    touch()
    return { touch, stop: () => clearTimeout(timer) }
  }

  /**
   * One stream following a resumable command from `from`: every chunk past those offsets
   * as it is or comes, then its exit. Dropping it leaves the command alone.
   */
  function follow(command: FakeCommand, from: { stdout: number; stderr: number }, first: Record<string, unknown>, headers: Record<string, string> = {}): Response {
    const cutAt = vmd.options.cutAfter?.[streamsOpened++]
    const position = { ...from }
    const encoder = new TextEncoder()
    let open = true
    let index = 0
    let sent = 0
    let listener = () => {}
    let cut = () => {}
    let alive: { touch: () => void; stop: () => void } | null = null
    let orphan: ReturnType<typeof setInterval> | undefined
    const cleanup = () => {
      alive?.stop()
      following.delete(cut)
      command.listeners.delete(listener)
      command.following--
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const line = (event: unknown) => encoder.encode(`${JSON.stringify(event)}\n`)
        const send = (event: unknown) => {
          controller.enqueue(line(event))
          alive?.touch()
        }
        const pings = pinger(position)
        alive = keepalive(() => open && send(pings.line()))
        cut = () => {
          if (!open) return
          open = false
          cleanup()
          vmd.cuts++
          if (vmd.options.cutMode === "orphan") {
            // the machine's side is gone and the stream's isn't: only the control plane's keepalives, until the client goes
            const ping = line(vmd.options.orphanPing ?? { type: "ping", from: "cloud" })
            orphan = setInterval(() => {
              try {
                controller.enqueue(ping)
              } catch {
                clearInterval(orphan)
              }
            }, vmd.options.orphanPingMs ?? 100)
            orphans.add(orphan)
            return
          }
          // half a line, then the connection goes: whatever the client makes of it
          controller.enqueue(encoder.encode(`{"type":"stdout","data":"half a li`))
          if (vmd.options.cutMode === "reset") setTimeout(() => controller.error(new Error("fake: the connection broke off")), 20)
          else controller.close()
        }
        following.add(cut)
        command.following++
        vmd.maxFollowing = Math.max(vmd.maxFollowing, command.following)
        // as kyora-vmd: a machine that marks its keepalives says so on the first line
        send(pings.marked ? { ...first, from: "machine" } : first)
        const keep = vmd.options.keepBytes
        if (keep !== undefined) {
          for (const name of ["stdout", "stderr"] as const) {
            const kept = Math.max(0, command.ends[name] - keep)
            if (position[name] < kept) {
              send({ type: "gap", stream: name, from: position[name], to: kept })
              position[name] = kept
            }
          }
        }
        const flush = () => {
          while (open && index < command.chunks.length) {
            const chunk = command.chunks[index++]!
            const end = chunk.offset + chunk.data.length
            if (end <= position[chunk.stream]) continue
            const data = chunk.data.subarray(Math.max(0, position[chunk.stream] - chunk.offset))
            position[chunk.stream] = end
            send(outputEvent(chunk.stream, data))
            sent += data.length
            if (cutAt !== undefined && sent >= cutAt) return cut()
          }
          if (open && command.exit && index >= command.chunks.length) {
            send({ ...command.exit, bytes: { ...command.ends } })
            open = false
            cleanup()
            controller.close()
          }
        }
        listener = flush
        command.listeners.add(listener)
        flush()
      },
      cancel() {
        clearInterval(orphan)
        orphans.delete(orphan!)
        if (!open) return
        open = false
        cleanup()
        vmd.disconnects.push({ id: command.id, pid: command.pid })
      },
    })
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache, no-transform", ...keepaliveHeaders(), ...headers } })
  }

  /** `resumable: true`: the command runs on whatever happens to its stream, and keeps its output */
  function resumableExec(sandbox: FakeSandbox, body: ExecBody, cwd: string): Response {
    sandbox.busy++
    const started = Date.now()
    const proc = Bun.spawn({
      cmd: body.cmd,
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox.work, ...body.env },
      stdin: body.stdin !== undefined ? Buffer.from(body.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    running.add(proc.pid)
    vmd.execs.push({ id: sandbox.id, cmd: body.cmd, cwd: body.cwd ?? "/work", env: body.env ?? {}, timeoutSeconds: body.timeoutSeconds, stdin: body.stdin, pid: proc.pid })
    const command: FakeCommand = {
      execId: randomBytes(16).toString("hex"),
      id: sandbox.id,
      pid: proc.pid,
      chunks: [],
      ends: { stdout: 0, stderr: 0 },
      exit: null,
      listeners: new Set(),
      following: 0,
    }
    vmd.commands.set(command.execId, command)
    const wake = () => {
      for (const listener of [...command.listeners]) listener()
    }
    let timedOut = false
    const timer =
      body.timeoutSeconds && !vmd.options.ignoreTimeouts
        ? setTimeout(() => {
            timedOut = true
            killGroup(proc.pid, "SIGKILL")
          }, body.timeoutSeconds * 1000)
        : null
    const pump = async (readable: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
      for await (const data of readable as unknown as AsyncIterable<Uint8Array>) {
        command.chunks.push({ stream, offset: command.ends[stream], data })
        command.ends[stream] += data.length
        wake()
      }
    }
    void (async () => {
      await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])
      await proc.exited
      running.delete(proc.pid)
      freeSlot(sandbox)
      if (timer) clearTimeout(timer)
      command.exit ={ type: "exit", code: proc.exitCode, signal: proc.signalCode ?? null, durationMs: Date.now() - started, timedOut }
      wake()
    })()
    return follow(command, { stdout: 0, stderr: 0 }, { type: "started", id: command.execId, resumable: true }, { "x-kyora-exec-id": command.execId })
  }

  /** GET …/execs/:execId/stream?from=<stdout>,<stderr> */
  async function attach(sandbox: FakeSandbox, execId: string, url: URL): Promise<Response> {
    const from = url.searchParams.get("from") ?? "0,0"
    const answer = (response: Response) => {
      vmd.attaches.push({ id: sandbox.id, execId, from, status: response.status })
      return response
    }
    const attempt = ++attachAttempts
    const override = await vmd.options.attach?.(attempt)
    if (override) return answer(override)
    const command = vmd.commands.get(execId)
    if (!command || command.id !== sandbox.id) return answer(error(404, "exec_not_found", "no such exec in this sandbox"))
    const offsets = /^(\d+),(\d+)$/.exec(from)
    const stdout = Number(offsets?.[1])
    const stderr = Number(offsets?.[2])
    if (!offsets || stdout > command.ends.stdout || stderr > command.ends.stderr) return answer(error(400, "invalid_request", "from must be <stdout>,<stderr> within what the command wrote"))
    return answer(follow(command, { stdout, stderr }, { type: "attached", id: execId, running: command.exit === null }))
  }

  /** POST …/execs/:execId/cancel: the explicit kill */
  function cancelCommand(sandbox: FakeSandbox, execId: string): Response {
    const command = vmd.commands.get(execId)
    if (!command || command.id !== sandbox.id) {
      vmd.cancels.push({ id: sandbox.id, execId, pid: null })
      return error(404, "exec_not_found", "no such exec in this sandbox")
    }
    vmd.cancels.push({ id: sandbox.id, execId, pid: command.pid })
    const running = command.exit === null
    if (running) {
      killGroup(command.pid, "SIGTERM")
      setTimeout(() => killGroup(command.pid, "SIGKILL"), 2_000).unref?.()
    }
    return Response.json({ cancelled: true, running })
  }

  /** the exec every server had before resumable commands: the stream is the command's life */
  function classicExec(sandbox: FakeSandbox, request: Request, body: ExecBody, cwd: string): Response {
    sandbox.busy++
    const started = Date.now()
    const proc = Bun.spawn({
      cmd: body.cmd,
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox.work, ...body.env },
      stdin: body.stdin !== undefined ? Buffer.from(body.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    running.add(proc.pid)
    vmd.execs.push({ id: sandbox.id, cmd: body.cmd, cwd: body.cwd ?? "/work", env: body.env ?? {}, timeoutSeconds: body.timeoutSeconds, stdin: body.stdin, pid: proc.pid })

    let timedOut = false
    const timer =
      body.timeoutSeconds && !vmd.options.ignoreTimeouts
        ? setTimeout(() => {
            timedOut = true
            killGroup(proc.pid, "SIGKILL")
          }, body.timeoutSeconds * 1000)
        : null
    let open = true
    let alive: { touch: () => void; stop: () => void } | null = null
    const hangUp = () => {
      if (!open) return
      open = false
      alive?.stop()
      vmd.disconnects.push({ id: sandbox.id, pid: proc.pid })
      killGroup(proc.pid, "SIGTERM")
    }
    request.signal.addEventListener("abort", hangUp)
    proc.exited.then(() => {
      running.delete(proc.pid)
      freeSlot(sandbox)
      if (timer) clearTimeout(timer)
    })

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: unknown) => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
            alive?.touch()
          } catch {
            hangUp()
          }
        }
        const position = { stdout: 0, stderr: 0 }
        const pings = pinger(position)
        alive = keepalive(() => send(pings.line()))
        const pump = async (readable: ReadableStream<Uint8Array>, type: "stdout" | "stderr") => {
          for await (const chunk of readable as unknown as AsyncIterable<Uint8Array>) {
            position[type] += chunk.length
            send(outputEvent(type, chunk))
          }
        }
        // a new server whose guest agent can't keep the command says so, then behaves as ever; a plain
        // exec has no such line, and its first is the machine's keepalive (as kyora-vmd)
        if (body.resumable === true && vmd.options.oldAgent) send({ type: "started", resumable: false, ...(pings.marked ? { from: "machine" } : {}) })
        else if (pings.marked) send(pings.line())
        void (async () => {
          await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])
          await proc.exited
          send({ type: "exit", code: proc.exitCode, signal: proc.signalCode ?? null, durationMs: Date.now() - started, timedOut })
          alive?.stop()
          if (open) {
            open = false
            controller.close()
          }
        })()
      },
      cancel: hangUp,
    })
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache, no-transform", ...keepaliveHeaders() } })
  }

  // ── kyora cloud ──────────────────────────────────────────────────────────────

  async function startUpload(sandbox: FakeSandbox, request: Request): Promise<Response> {
    const body = (await request.json()) as { dest?: string; contentType?: string }
    const dest = body.dest ?? "/work"
    if (!local(sandbox, dest)) return error(400, "invalid_request", "dest must be under /work")
    const contentType = body.contentType ?? "application/zstd"
    if (contentType !== "application/zstd" && contentType !== "application/x-tar") return error(415, "unsupported_media_type", contentType)
    const uploadId = `tx_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 10)}`
    await mkdir(join(root, "uploads", uploadId), { recursive: true })
    partFiles.set(uploadId, new Map())
    vmd.multipart.push({ id: sandbox.id, uploadId, dest, contentType, status: "open", parts: [], sha256: null, bytes: 0 })
    const partSize = vmd.options.partSize ?? 64 * 1024 * 1024
    return Response.json({ uploadId, partSize, maxPartBytes: 90_000_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, { status: 201 })
  }

  function openUpload(sandbox: FakeSandbox, uploadId: string): MultipartRecord | Response {
    const record = vmd.multipart.find((m) => m.uploadId === uploadId && m.id === sandbox.id)
    if (!record) return error(404, "not_found", "no such upload")
    if (record.status !== "open") return error(409, "upload_closed", `upload ${uploadId} is ${record.status}`)
    return record
  }

  async function putPart(sandbox: FakeSandbox, request: Request, uploadId: string, n: number): Promise<Response> {
    partsInFlight++
    vmd.maxPartsInFlight = Math.max(vmd.maxPartsInFlight, partsInFlight)
    try {
      return await storePart(sandbox, request, uploadId, n)
    } finally {
      partsInFlight--
    }
  }

  async function storePart(sandbox: FakeSandbox, request: Request, uploadId: string, n: number): Promise<Response> {
    const record = openUpload(sandbox, uploadId)
    if (record instanceof Response) return record
    const attempt = (attempts.get(`${uploadId}/${n}`) ?? 0) + 1
    attempts.set(`${uploadId}/${n}`, attempt)
    const declared = request.headers.get("content-length")
    if (declared === null) return error(411, "length_required", "send each part with a Content-Length")
    let data: Uint8Array
    try {
      data = new Uint8Array(await request.arrayBuffer())
    } catch {
      return error(400, "short_body", "the client went away mid-part")
    }
    vmd.partPuts.push({ uploadId, n, bytes: data.length, attempt })
    const override = await vmd.options.part?.(n, attempt, uploadId)
    if (override) return override
    if (data.length !== Number(declared)) return error(400, "short_body", `${data.length} of ${declared} bytes`)
    const path = join(root, "uploads", uploadId, String(n))
    await Bun.write(path, data)
    const etag = new Bun.CryptoHasher("md5").update(data).digest("hex")
    partFiles.get(uploadId)!.set(n, { path, bytes: data.length, etag })
    return Response.json({ n, etag })
  }

  /** R2's rules: parts ascending, etags matching, every part but the last the same size */
  async function completeUpload(sandbox: FakeSandbox, request: Request, uploadId: string): Promise<Response> {
    const record = openUpload(sandbox, uploadId)
    if (record instanceof Response) return record
    const { parts } = (await request.json()) as { parts?: { n: number; etag: string }[] }
    const attempt = ++completeAttempts
    const override = await vmd.options.complete?.(attempt)
    if (override) return override
    if (!Array.isArray(parts) || parts.length === 0) return error(400, "invalid_request", "parts must be a list of {n, etag}")
    const stored = partFiles.get(uploadId)!
    const partSize = vmd.options.partSize ?? 64 * 1024 * 1024
    const files: string[] = []
    for (const [index, part] of parts.entries()) {
      const file = stored.get(part.n)
      if (index > 0 && part.n <= parts[index - 1]!.n) return error(400, "invalid_request", "parts must be in ascending order")
      if (!file || file.etag !== part.etag) return error(400, "storage_rejected", `part ${part.n}: no such part or a stale etag`)
      const last = index === parts.length - 1
      if (!last && file.bytes !== partSize) return error(400, "storage_rejected", `part ${part.n} is ${file.bytes} bytes; all but the last must be ${partSize}`)
      if (last && file.bytes > partSize) return error(400, "storage_rejected", `the last part is bigger than the others`)
      files.push(file.path)
    }
    const object = join(root, "uploads", uploadId, "object")
    const writer = Bun.file(object).writer()
    const hash = new Bun.CryptoHasher("sha256")
    for (const path of files) {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
      hash.update(bytes)
      writer.write(bytes)
    }
    await writer.end()
    record.status = "complete"
    record.parts = parts.map((part) => stored.get(part.n)!.bytes)
    record.sha256 = hash.digest("hex")
    for (const path of files) await rm(path, { force: true })
    const target = local(sandbox, record.dest)!
    const started = Date.now()
    const rate = vmd.options.unpackBytesPerSecond
    const source = Bun.file(object).stream()
    const finished = await unpackTurn(object, record.contentType)
    unpacking++
    vmd.maxUnpacking = Math.max(vmd.maxUnpacking, unpacking)
    let result: Awaited<ReturnType<typeof unpack>>
    try {
      result = await unpack(target, record.contentType, rate ? paced(source, rate) : source)
    } finally {
      unpacking--
      finished()
    }
    await rm(object, { force: true })
    if (result instanceof Response) return result
    record.bytes = result.bytes
    return Response.json({ ...result, durationMs: Date.now() - started })
  }

  async function abortUpload(sandbox: FakeSandbox, uploadId: string): Promise<Response> {
    const record = openUpload(sandbox, uploadId)
    if (record instanceof Response) return record
    record.status = "aborted"
    await rm(join(root, "uploads", uploadId), { recursive: true, force: true })
    return new Response(null, { status: 204 })
  }

  async function deviceStart(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { client?: string; hostname?: string }
    const letters = "BCDFGHJKLMNPQRSTVWXZ"
    const pick = () => letters[Math.floor(Math.random() * letters.length)]
    const userCode = `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`
    const device: DeviceRecord = {
      deviceCode: `kdev_${crypto.randomUUID().replaceAll("-", "")}`,
      userCode,
      client: body.client ?? "?",
      hostname: body.hostname ?? null,
      status: "pending",
      expiresAt: Date.now() + (vmd.options.deviceExpiresIn ?? 600) * 1000,
      polls: 0,
    }
    vmd.devices.push(device)
    return Response.json({
      deviceCode: device.deviceCode,
      userCode,
      verifyUrl: `${vmd.url}/device?code=${userCode}`,
      interval: vmd.options.deviceInterval ?? 1,
      expiresIn: vmd.options.deviceExpiresIn ?? 600,
    })
  }

  async function devicePoll(request: Request): Promise<Response> {
    const { deviceCode } = (await request.json().catch(() => ({}))) as { deviceCode?: string }
    const device = vmd.devices.find((d) => d.deviceCode === deviceCode)
    if (device) device.polls++
    const gone = (status: "expired" | "denied", message: string) => Response.json({ error: status, status, message }, { status: 410 })
    if (!device || device.status === "claimed" || device.expiresAt <= Date.now()) return gone("expired", "this login expired; run kyora-vms login again")
    if (device.status === "denied") return gone("denied", "the login was denied in the browser")
    if (device.status === "pending") return Response.json({ error: "authorization_pending", status: "pending", message: "waiting for approval in the browser" }, { status: 428 })
    device.status = "claimed"
    const token = `kyora_minted_${crypto.randomUUID().replaceAll("-", "")}`
    vmd.tokens.add(token)
    MINTED.push(token)
    return Response.json({ token, login: "octo", expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() })
  }

  const me = (token: string) =>
    Response.json({
      id: "usr_1",
      login: "octo",
      name: "Octo Cat",
      avatarUrl: null,
      role: "member",
      vmsAccess: true,
      limits: { maxSandboxes: 8 },
      token: { id: "tok_1", name: token === TOKEN ? "ci" : "kyora-vms on test", scopes: ["vms"], expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    })

  const platform = kind === "platform"
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    // Bun.serve answers a bare 413 past 128 MB by default; the real daemon must lift it too
    maxRequestBodySize: 4 * 1024 ** 3,
    websocket: tty.websocket,
    async fetch(request, server) {
      const url = new URL(request.url)
      vmd.requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/v1/health") {
        if (platform) return Response.json({ ok: true, version: "kyora-cloud", nodes: 1, capacity: { vcpusFree: 12, memoryMbFree: 40960 } })
        return Response.json({ ok: true, version: "fake", execLimit: 32, features: [...(vmd.options.oldAgent ? [] : ["exec.concurrent"]), ...(vmd.options.networkPolicy === false ? ["tty"] : ["tty", "network.policy"])], capacity: { vcpusFree: 12, memoryMbFree: 40960 } })
      }
      if (vmd.options.latencyMs) await Bun.sleep(vmd.options.latencyMs)
      if (platform && request.method === "POST" && url.pathname === "/v1/auth/device") return deviceStart(request)
      if (platform && request.method === "POST" && url.pathname === "/v1/auth/device/token") return devicePoll(request)
      const presented = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      if (platform ? !vmd.tokens.has(presented) : presented !== KEY) {
        vmd.unauthorized++
        if (platform) return error(401, "unauthorized", "missing, invalid or expired token; run kyora-vms login")
        return error(401, "unauthorized", "missing or unknown API key")
      }
      if (platform && request.method === "GET" && url.pathname === "/v1/me") return me(presented)
      if (platform && request.method === "GET" && url.pathname === "/v1/images") return Response.json({ images: vmd.options.images ?? [], account: [...vmd.accountImages.values()].filter((image) => image.status !== "deleted").map(imageView) })
      if (platform && url.pathname.startsWith("/v1/images") && url.pathname !== "/v1/images/build") {
        const answered = await accountImageRoute(vmd, request, url)
        if (answered) return answered
      }
      if (platform && request.method === "POST" && url.pathname === "/v1/images/build") {
        const body = await request.json() as { profile: string; node?: string }
        return Response.json({ profile: body.profile, builds: [{ machine: body.node ?? "box-1", accepted: true }] }, { status: 202 })
      }
      if (platform && request.method === "GET" && url.pathname === "/v1/nodes") return Response.json({ nodes: vmd.options.nodes ?? DEFAULT_NODES })
      const queued = platform ? /^\/v1\/queue\/([^/]+)$/.exec(url.pathname) : null
      if (queued && request.method === "GET") return pollTicket(decodeURIComponent(queued[1]!))
      if (queued && request.method === "DELETE") {
        const entry = vmd.tickets.get(decodeURIComponent(queued[1]!))
        if (!entry) return error(404, "not_found", "no such ticket")
        entry.status = "cancelled"
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/v1/sandboxes") {
        if (request.method === "POST") return createSandbox(request)
        if (request.method === "GET") return Response.json({ sandboxes: [...vmd.sandboxes.values()].map(describe) })
      }
      // resumable commands: a server from before them has no such routes
      const execRoute = /^\/v1\/sandboxes\/([^/]+)\/execs\/([^/]+)\/(stream|cancel)$/.exec(url.pathname)
      if (execRoute && vmd.options.resumable !== false) {
        const sandbox = vmd.sandboxes.get(decodeURIComponent(execRoute[1]!))
        if (!sandbox) return error(404, "not_found", `no sandbox ${execRoute[1]}`)
        const execId = decodeURIComponent(execRoute[2]!)
        if (execRoute[3] === "stream" && request.method === "GET") return attach(sandbox, execId, url)
        if (execRoute[3] === "cancel" && request.method === "POST") return cancelCommand(sandbox, execId)
        return error(405, "method_not_allowed", `${request.method} ${url.pathname}`)
      }
      const resolution = /^\/v1\/sandboxes\/([^/]+)\/resolve$/.exec(url.pathname)
      if (resolution && request.method === "GET") {
        const reference = decodeURIComponent(resolution[1]!)
        const sandboxes = [...vmd.sandboxes.values()]
        const exact = sandboxes.filter((s) => s.id === reference || s.name === reference)
        const matches = exact.length ? exact : sandboxes.filter((s) => s.id.startsWith(reference))
        if (matches.length > 1) return error(409, "ambiguous_prefix", `ambiguous prefix: ${matches.map((s) => `${s.name ?? "unnamed"} (${s.id})`).join(", ")}`)
        if (!matches.length) return error(404, "not_found", "no such sandbox")
        return Response.json({ id: matches[0]!.id, name: matches[0]!.name })
      }
      const terminal = /^\/v1\/sandboxes\/([^/]+)(\/tty(?:\/sessions(?:\/[^/]+)?)?)$/.exec(url.pathname)
      if (terminal) {
        const sandbox = vmd.sandboxes.get(decodeURIComponent(terminal[1]!))
        if (!sandbox) return error(404, "not_found", `no sandbox ${terminal[1]}`)
        const answer = await tty.handle(request, server as Server<unknown>, sandbox.id, terminal[2]!)
        return answer ?? undefined
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(network|files|exec|uploads|downloads|computer)(?:\/([^/]+)(?:\/(parts|complete)(?:\/(\d+))?)?)?)?$/.exec(url.pathname)
      if (!match) return error(404, "not_found", "no such route")
      const reference = decodeURIComponent(match[1]!)
      const sandbox = vmd.sandboxes.get(reference) ?? [...vmd.sandboxes.values()].find((s) => s.name === reference)
      if (!sandbox) return error(404, "not_found", `no sandbox ${match[1]}`)
      const [, , resource = "", uploadId, step, n] = match
      if (resource === "network" && request.method === "PATCH") {
        const policy = await request.json() as {
          network?: string
          egressAllow?: string[]
        }
        Object.assign(sandbox, policy)
        return Response.json({ network: sandbox.network, egressAllow: sandbox.egressAllow ?? [] })
      }
      if (resource === "downloads" && platform && uploadId && !step && request.method === "GET") return storedDownload(sandbox, request, uploadId)
      if (resource === "uploads" && platform) {
        if (!uploadId && request.method === "POST") return startUpload(sandbox, request)
        if (uploadId && !step && request.method === "DELETE") return abortUpload(sandbox, uploadId)
        if (uploadId && step === "parts" && n && request.method === "PUT") return putPart(sandbox, request, uploadId, Number(n))
        if (uploadId && step === "complete" && !n && request.method === "POST") return completeUpload(sandbox, request, uploadId)
        return error(405, "method_not_allowed", `${request.method} ${url.pathname}`)
      }
      if (uploadId) return error(404, "not_found", "no such route")
      const action = `${request.method} ${resource}`
      switch (action) {
        case "PATCH ": {
          const change = await request.json() as { name?: string; ttlSeconds?: number; diskGb?: number }
          if (change.diskGb !== undefined) {
            if (change.diskGb < sandbox.diskGb) return error(400, "disk_shrink_unsupported", "diskGb can only grow")
            sandbox.diskGb = change.diskGb
          }
          if (change.name !== undefined) {
            if ([...vmd.sandboxes.values()].some((s) => s.id !== sandbox.id && s.name === change.name)) return error(409, "name_taken", "name is already in use")
            sandbox.name = change.name
          }
          if (change.ttlSeconds !== undefined) {
            if (vmd.options.maxTtlSeconds !== undefined && (change.ttlSeconds === 0 || change.ttlSeconds > vmd.options.maxTtlSeconds)) return error(400, "invalid_request", "ttlSeconds exceeds cap")
            sandbox.ttlSeconds = change.ttlSeconds
            sandbox.expiresAt = change.ttlSeconds === 0 ? null : new Date(Date.parse(sandbox.createdAt) + change.ttlSeconds * 1000).toISOString()
          }
          return Response.json(describe(sandbox))
        }
        case "GET ":
          return Response.json(describe(sandbox))
        case "DELETE ":
          for (const exec of vmd.execs) if (exec.id === sandbox.id) killGroup(exec.pid, "SIGKILL")
          vmd.sandboxes.delete(sandbox.id)
          vmd.destroyed.push(sandbox.id)
          await rm(sandbox.root, { recursive: true, force: true })
          return new Response(null, { status: 204 })
        case "PUT files":
          return upload(sandbox, request, url)
        case "GET files":
          return download(sandbox, url)
        case "POST exec":
          return exec(sandbox, request)
        case "POST computer":
          return computer(sandbox, request)
      }
      return error(405, "method_not_allowed", action)
    },
  })
  vmd.url = `http://127.0.0.1:${server.port}`
  return vmd
}
