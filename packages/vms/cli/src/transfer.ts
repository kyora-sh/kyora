import { posix } from "node:path"
import { ApiError, type MultipartUpload, type UploadResult, type VmsClient } from "./api"
import { extractTar, type ExtractResult } from "./extract"
import { PartPool, partsInFlight, pause, sendParts, type PartProgress, type SentParts } from "./multipart"
import { note } from "./output"
import { listFiles, uploadBody, type Listing, type PackEntry, type UploadBody } from "./pack"
import { rangedSize, rangedStream } from "./ranged"
import { autoShards, planShards } from "./shard"
import { TarTruncated } from "./tar"
import { formatBytes } from "./units"
import { decompressIfZstd, zstdAvailable } from "./zstd"

export const WORK = "/work"

/** `target/release/app` → `/work/target/release/app`; the guest only serves /work and /tmp */
export function remotePath(path: string, base = WORK): string {
  const abs = posix.normalize(path.startsWith("/") ? path : posix.join(base, path)).replace(/(.)\/+$/, "$1")
  const allowed = [WORK, "/tmp"].some((root) => abs === root || abs.startsWith(`${root}/`))
  if (!allowed) throw new Error(`${path}: sandbox paths live under /work (or /tmp)`)
  return abs
}

export interface PushOptions {
  signal?: AbortSignal
  /**
   * How many archives the upload is split into. Unset: by size on kyora cloud (one per
   * 256 MiB, at most 8), and one streamed PUT on a kyora-vmd, exactly as it always was.
   */
  shards?: number
  /** kyora cloud: parts in flight, all shards together (default: partsInFlight(partSize); KYORA_VMS_PARTS_IN_FLIGHT) */
  partsInFlight?: number
}

export interface PushResult {
  listing: Listing
  /** the server's answer; over several shards their bytes and entries summed (each entry once), the slowest unpack's durationMs */
  server: UploadResult
  /** compressed bytes on the wire */
  sent: number
  durationMs: number
  warnings: string[]
  /** the requests a kyora cloud upload took; a kyora-vmd takes each tar in one */
  parts?: number
  /** the archives it went up as, each unpacked on its own */
  shards: number
}

/**
 * A kyora-vmd takes the tar as one streamed PUT. kyora cloud sits behind Cloudflare,
 * which refuses any request body past ~100 MB however it is sent, so there the tar
 * always goes up in parts, whatever its size (a small one is a single part). A large
 * upload is split into shards first, each its own tar.zst and its own upload, all going
 * up at once and unpacked into the sandbox side by side: one stream is bounded by one
 * connection's throughput (and one core's compression, and one unpacker), several are not.
 */
export async function push(api: VmsClient, id: string, source: Listing | { dir: string; git: boolean }, dest: string, options: PushOptions = {}): Promise<PushResult> {
  const files = "entries" in source ? source : await listFiles(source.dir, { git: source.git })
  const warnings: string[] = []
  // a retry packs the same files again: its warnings are the ones already seen
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message)
  }
  const started = Date.now()
  const platform = (await api.kind()) === "platform"
  const count = options.shards ?? (platform ? autoShards(files.bytes) : 1)
  const shards = count > 1 ? planShards(files.entries, count) : null
  const groups: PackEntry[][] = shards ? shards.map((shard) => shard.entries) : [files.entries]
  // each archive can be packed again for a retry; the latest of each is the one that went up
  const makers = groups.map((entries) => () => uploadBody(entries, warn))
  let bodies = makers.map((make) => make())
  // a directory that went up with several shards was unpacked, and counted, by each
  const carried = shards ? shards.reduce((total, shard) => total + shard.entries.length, 0) - files.entries.length : 0
  const result = (server: UploadResult, parts?: number): PushResult => ({
    listing: files,
    server: carried > 0 ? { ...server, entries: Math.max(0, server.entries - carried) } : server,
    sent: bodies.reduce((total, body) => total + body.sent(), 0),
    durationMs: Date.now() - started,
    warnings,
    shards: bodies.length,
    ...(parts !== undefined ? { parts } : {}),
  })
  if (platform) {
    const { server, parts } = await pushInParts(api, id, dest, bodies, makers, options.signal, options.partsInFlight)
    return result(server, parts)
  }
  // a kyora-vmd: the whole tar in one PUT (one per shard). One the network or a restart of the
  // host cut off is packed and sent again: unpacking the same files over what landed is harmless.
  for (let attempt = 1; ; attempt++) {
    try {
      if (bodies.length === 1) return result(await api.upload(id, dest, bodies[0]!.stream, bodies[0]!.contentType, options.signal))
      return result(await pushStreams(api, id, dest, bodies, options.signal))
    } catch (error) {
      await Promise.all(bodies.map((body) => body.stream.cancel().catch(() => {})))
      if (options.signal?.aborted || attempt >= TRANSFER_ATTEMPTS || !transient(error)) throw error
      note(`upload to ${id} broke off (${errorText(error)}); sending it again`)
      await pause(retryDelay(attempt), options.signal ?? new AbortController().signal)
      bodies = makers.map((make) => make())
    }
  }
}

/** tries a transfer gets when the network, or a restart of something on the way, cuts it off */
export const TRANSFER_ATTEMPTS = 3

const retryDelay = (attempt: number) => 1_000 * 2 ** (attempt - 1)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** a response body that broke off mid-way: the connection, not what it carried */
export class BrokenStream extends Error {}

/**
 * Cut off on the way, not refused: the network (no answer, a reset), a body that broke off, or
 * a gateway saying what is behind it is away for a moment (502/503/504: cloudflared or the
 * Worker while kyora-vmd or kyora-node restarts). A 4xx or a 500 is an answer, not asked again.
 */
export function transient(error: unknown): boolean {
  if (error instanceof BrokenStream) return true
  return error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)
}

/** passes a body on, turning its read errors into BrokenStream so a retry can tell them from a bad archive */
function watched(body: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; broken: () => boolean } {
  const reader = body.getReader()
  let broken = false
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          broken = true
          controller.error(new BrokenStream(`the download broke off: ${errorText(error)}`))
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
  return { stream, broken: () => broken }
}

/** `parts` and `shards` for --json: kyora cloud's always, a kyora-vmd's shards only when split */
export function pushShape(result: PushResult): { parts?: number; shards?: number } {
  return {
    ...(result.parts !== undefined ? { parts: result.parts } : {}),
    ...(result.parts !== undefined || result.shards > 1 ? { shards: result.shards } : {}),
  }
}

/** one shard's answer as is; several summed, with the slowest unpack's time */
function combine(results: UploadResult[]): UploadResult {
  if (results.length === 1) return results[0]!
  return {
    bytes: results.reduce((total, result) => total + (result.bytes ?? 0), 0),
    entries: results.reduce((total, result) => total + (result.entries ?? 0), 0),
    durationMs: Math.max(...results.map((result) => result.durationMs ?? 0)),
  }
}

/**
 * Runs every task at once. The first to fail stops the others (through the signal they
 * get) and is what is thrown; what they throw after it is only the echo of that.
 */
async function allOrNothing<T>(tasks: ((signal: AbortSignal) => Promise<T>)[], signal?: AbortSignal): Promise<T[]> {
  const stop = new AbortController()
  const shared = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  let failure = null as { error: unknown } | null
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      task(shared).catch((error: unknown) => {
        failure ??= { error }
        stop.abort(error)
        throw error
      }),
    ),
  )
  if (failure) throw failure.error
  return settled.map((outcome) => (outcome as PromiseFulfilledResult<T>).value)
}

/** a kyora-vmd with --shards: one streamed PUT per shard, side by side */
async function pushStreams(api: VmsClient, id: string, dest: string, bodies: UploadBody[], signal?: AbortSignal): Promise<UploadResult> {
  try {
    return combine(await allOrNothing(bodies.map((body) => (shared) => api.upload(id, dest, body.stream, body.contentType, shared)), signal))
  } catch (error) {
    // nothing more will be packed for shards that never got going
    await Promise.all(bodies.map((body) => body.stream.cancel().catch(() => {})))
    throw error
  }
}

/** a line per finished part on stderr (one line rewritten in a terminal), once there is more than one */
function uploadProgress(shards: number) {
  const started = Date.now()
  const tty = Boolean(process.stderr.isTTY)
  const bytes = new Array<number>(shards).fill(0)
  const cut = new Array<number>(shards).fill(0)
  const finished = new Array<SentParts | null>(shards).fill(null)
  const over = shards > 1 ? ` over ${shards} shards` : ""
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0)
  let shown = false
  const show = (line: string) => {
    shown = true
    if (tty) process.stderr.write(`\r\x1b[K[kyora-vms] ${line}`)
    else note(line)
  }
  const rate = (sent: number) => `${formatBytes(Math.round(sent / Math.max((Date.now() - started) / 1000, 0.001)))}/s`
  return {
    part(shard: number, progress: PartProgress) {
      bytes[shard] = progress.bytes
      cut[shard] = progress.cut
      if (total(cut) > 1) show(`uploading: ${formatBytes(total(bytes))} sent${over}, ${rate(total(bytes))}`)
    },
    sent(shard: number, sent: SentParts) {
      finished[shard] = sent
      if (finished.some((done) => done === null)) return
      const parts = total(finished.map((done) => done!.parts.length))
      const sentBytes = total(finished.map((done) => done!.bytes))
      if (parts > 1) show(`uploaded ${formatBytes(sentBytes)} in ${parts} parts${over}, ${rate(sentBytes)}; unpacking in the sandbox`)
    },
    end() {
      if (shown && tty) process.stderr.write("\n")
    },
  }
}

/**
 * Each shard is a multipart upload of its own: started, cut into parts as it is packed,
 * completed (which unpacks it into the sandbox, on the machine, while the other shards
 * may still be going up). The parts of all of them share one pool, so at most
 * `partsInFlight` parts are in flight, and in memory, at once. Anything failing, or a
 * Ctrl-C, stops every shard and aborts each upload that did not complete.
 */
async function pushInParts(
  api: VmsClient,
  id: string,
  dest: string,
  bodies: UploadBody[],
  makers: (() => UploadBody)[],
  signal?: AbortSignal,
  inFlight?: number,
): Promise<{ server: UploadResult; parts: number }> {
  const progress = uploadProgress(bodies.length)
  /** uploads started; a completed (or already given up) one needs no abort */
  const open: { uploadId: string; completed: boolean }[] = []
  let pool: PartPool | null = null

  /**
   * Parts retry on their own (sendParts). A start or a complete cut off on the way (the Worker
   * redeployed, or the machine's kyora-node or kyora-vmd restarted while the complete waited for
   * the unpack) is not repeated as such: kyora cloud refuses a second complete of one upload
   * (409 upload_closed), and one whose push failed has dropped its object already. The shard
   * goes up again as a new upload instead, packed afresh; unpacking the same files again over
   * what did land is harmless.
   */
  async function shard(index: number, shared: AbortSignal): Promise<{ server: UploadResult; parts: number }> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) bodies[index] = makers[index]!()
      const body = bodies[index]!
      let phase: "start" | "parts" | "complete" = "start"
      let record: { uploadId: string; completed: boolean } | null = null
      try {
        const upload: MultipartUpload = await api.startUpload(id, dest, body.contentType, shared)
        const opened = { uploadId: upload.uploadId, completed: false }
        record = opened
        open.push(opened)
        pool ??= new PartPool(inFlight ?? partsInFlight(upload.partSize))
        phase = "parts"
        const sent = await sendParts({ put: (n, part, partSignal) => api.uploadPart(id, upload.uploadId, n, part, partSignal) }, body.stream, upload.partSize, {
          signal: shared,
          pool,
          onPart: (part) => progress.part(index, part),
        })
        progress.sent(index, sent)
        phase = "complete"
        const server = await api.completeUpload(id, upload.uploadId, sent.parts, shared)
        opened.completed = true
        return { server, parts: sent.parts.length }
      } catch (error) {
        await body.stream.cancel().catch(() => {})
        if (shared.aborted || phase === "parts" || attempt >= TRANSFER_ATTEMPTS || !transient(error)) throw error
        if (record) {
          // spent either way (after a complete that went through, this is a harmless 409)
          await api.abortUpload(id, record.uploadId).catch(() => {})
          record.completed = true
        }
        note(`upload to ${id} broke off (${errorText(error)}); sending ${bodies.length > 1 ? `shard ${index + 1}` : "it"} again`)
        await pause(retryDelay(attempt), shared)
      }
    }
  }

  try {
    const results = await allOrNothing(
      bodies.map((_, index) => (shared) => shard(index, shared)),
      signal,
    )
    return { server: combine(results.map((result) => result.server)), parts: results.reduce((total, result) => total + result.parts, 0) }
  } catch (error) {
    // leave no half upload in storage (after a completed one this is a harmless 409)
    await Promise.all(open.filter((upload) => !upload.completed).map((upload) => api.abortUpload(id, upload.uploadId).catch(() => {})))
    await Promise.all(bodies.map((body) => body.stream.cancel().catch(() => {})))
    throw error
  } finally {
    progress.end()
  }
}

/**
 * Download entries are named relative to /work (`target/release/app`), or to / for
 * /tmp paths (`tmp/x`), so they unpack into --to laid out as in the sandbox. A guest
 * that names them from / (`work/target/…`) or by basename (`app`) is mapped onto the
 * same layout, judged by the first entry, so the file lands where --out said either way.
 */
export function layoutFor(path: string): (name: string) => string {
  const expected = path === WORK ? "" : path.startsWith(`${WORK}/`) ? path.slice(WORK.length + 1) : path.slice(1)
  const base = posix.basename(expected)
  const parent = posix.dirname(expected)
  const under = (name: string, prefix: string) => name === prefix || name.startsWith(`${prefix}/`)
  let map: ((name: string) => string) | null = null
  return (raw) => {
    if (!map) {
      const first = raw.replace(/^(\.\/)+/, "")
      if (!expected || under(first, expected)) map = (name) => name
      else if (under(first, `work/${expected}`)) map = (name) => name.replace(/^(\.\/)*work\//, "")
      // an absolute name stays absolute, so the extractor still refuses it
      else if (parent !== "." && under(first, base)) map = (name) => (name.startsWith("/") ? name : `${parent}/${name.replace(/^(\.\/)+/, "")}`)
      else map = (name) => name
    }
    return map(raw)
  }
}

export interface PullResult extends ExtractResult {
  path: string
  to: string
  /** bytes on the wire, compressed when zstd was used */
  received: number
  durationMs: number
  /** fetched as parallel byte ranges */
  ranged: boolean
}

/**
 * kyora cloud answers a download once the archive is stored, so it knows its length and
 * can offer byte ranges (`accept-ranges: bytes`, with the stored object's own URL in
 * `content-location`). Then the rest of it is fetched as 16 MiB ranges, four at a time,
 * and handed to the extractor in order. Anything else (a kyora-vmd, a server that offers
 * no ranges, a small download) streams as one response, as it always did.
 */
async function downloadBody(api: VmsClient, response: Response, signal?: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; ranged: boolean }> {
  const whole = { body: response.body!, ranged: false }
  const size = rangedSize(response)
  const location = response.headers.get("content-location")
  const path = size !== null && location ? api.pathUnder(location, response.url || api.url) : null
  // asked last, so a download that offers nothing costs no request to find out what answers
  if (size === null || path === null || (await api.kind()) !== "platform") return whole
  const etag = response.headers.get("etag")
  const source = { get: (start: number, end: number, rangeSignal: AbortSignal) => api.downloadRange(path, start, end, etag, rangeSignal) }
  return { body: rangedStream(response.body!, size, source, { signal }), ranged: true }
}

/**
 * Downloads a path and unpacks it into `to`. A download only reads, and the extractor
 * replaces what is there (it never writes through it), so one that the network or a restart
 * on the way cut off (no answer, a reset mid-body, a 502/503/504) is fetched and unpacked
 * again from the start, up to TRANSFER_ATTEMPTS times.
 */
export async function pull(api: VmsClient, id: string, path: string, to: string, signal?: AbortSignal): Promise<PullResult> {
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    try {
      return { ...(await pullOnce(api, id, path, to, signal)), durationMs: Date.now() - started }
    } catch (error) {
      if (signal?.aborted || attempt >= TRANSFER_ATTEMPTS || !transient(error)) throw error
      note(`download of ${path} broke off (${errorText(error)}); fetching it again`)
      await pause(retryDelay(attempt), signal ?? new AbortController().signal)
    }
  }
}

async function pullOnce(api: VmsClient, id: string, path: string, to: string, signal?: AbortSignal): Promise<Omit<PullResult, "durationMs">> {
  const response = await api.download(id, [path], zstdAvailable, signal)
  const { body, ranged } = await downloadBody(api, response, signal)
  const source = watched(body)
  let received = 0
  const counted = source.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.length
        controller.enqueue(chunk)
      },
    }),
  )
  try {
    const result = await extractTar(await decompressIfZstd(counted), to, layoutFor(path))
    return { ...result, path, to, received, ranged }
  } catch (error) {
    // whatever the extractor (or zstd) made of a body that broke off, the break is what happened
    // a body that broke off, or one that ended cleanly but short of the archive's end: either way the connection, not the data
    if ((source.broken() || error instanceof TarTruncated) && !signal?.aborted && !(error instanceof BrokenStream)) throw new BrokenStream(`the download broke off (${errorText(error)})`)
    throw error
  }
}
