import { KyoraError, type KyoraErrorInit } from "./errors.js"
import type { ExecCancelResponse, ExecExitFrame, ExecRequest as WireExecRequest } from "./generated/schemas.js"
import { endOf, pause, randomKey, timeoutError, unref, type CallOptions, type Transport, type WaitOptions } from "./http.js"

export type Stream = "stdout" | "stderr"

/** A command to run. `key` names it: the same request with the same key rejoins it instead of starting it again. */
export type ExecRequest = Omit<WireExecRequest, "resumable">

export interface ExecOptions extends WaitOptions {
  /** each chunk of output as it arrives */
  onOutput?: (stream: Stream, chunk: Uint8Array) => void | Promise<void>
  /** bytes of each stream kept in the result; output past it still streams to onOutput (default 16 MiB) */
  maxOutputBytes?: number
  /** how long a broken stream is reattached to before the call gives up (default 2 min) */
  reattachWindowMs?: number
  /** a stream that says nothing this long, not even a keepalive, counts as broken (default 60 s) */
  idleMs?: number
  /** aborting `signal` also cancels the command (default true); the deadline never does */
  cancelOnAbort?: boolean
}

export interface ByteOffsets {
  stdout: number
  stderr: number
}

export interface ExecResult {
  /** the command's exit code; null when a signal ended it */
  exitCode: number | null
  /** the signal that ended the command (a Linux name or number), or null */
  signal: string | number | null
  /** the exec's timeoutSeconds stopped the command */
  timedOut: boolean
  durationMs: number
  stdout: Uint8Array
  stderr: Uint8Array
  /**
   * Output the result is missing, per stream: past maxOutputBytes, dropped while nothing was
   * attached (the sandbox keeps the latest output of each stream), or short of the totals the exit reports.
   */
  truncated: { stdout: boolean; stderr: boolean }
  /** the command's id, for attach and cancel */
  execId: string | null
  /** the exec key the command ran under */
  key: string | null
}

/**
 * The call stopped waiting while the command may still run: its deadline passed (`timeout`), or
 * the stream broke and could not be reattached in time (`stream_lost`). Reattach with
 * `exec.attach(sandbox, execId, { from: offsets })`, or rerun the same request with the same key.
 */
export class ExecDetachedError extends KyoraError {
  constructor(
    init: KyoraErrorInit,
    readonly execId: string | null,
    readonly key: string | null,
    /** bytes of each stream read so far */
    readonly offsets: ByteOffsets,
  ) {
    super(init)
  }
}

const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024
const DEFAULT_WINDOW_MS = 2 * 60_000
const DEFAULT_IDLE_MS = 60_000
const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 10_000
/** how long the first line of an exec may take: the machine gets 60 s to start the command */
const START_TIMEOUT_MS = 120_000
/** a server that sends this header sends a line at least that often */
const KEEPALIVE_HEADER = "x-kyora-keepalive-ms"

const encoder = new TextEncoder()

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** an exception of the caller's onOutput: it ends the call as it is, never taken for a broken stream */
class OutputCallbackError {
  constructor(readonly error: unknown) {}
}

/** the command's output so far, and where a reattach carries on */
class Collector {
  readonly offsets: ByteOffsets = { stdout: 0, stderr: 0 }
  readonly truncated = { stdout: false, stderr: false }
  private readonly kept: Record<Stream, Uint8Array[]> = { stdout: [], stderr: [] }
  private readonly keptBytes: ByteOffsets = { stdout: 0, stderr: 0 }
  execId: string | null = null
  key: string | null
  /** a started or attached frame came: the command runs, whether or not kyora named it */
  started = false

  constructor(
    private readonly max: number,
    private readonly onOutput: ExecOptions["onOutput"],
    key: string | null,
  ) {
    this.key = key
  }

  async output(stream: Stream, data: Uint8Array): Promise<void> {
    this.offsets[stream] += data.length
    const room = this.max - this.keptBytes[stream]
    if (data.length > room) this.truncated[stream] = true
    const keep = room >= data.length ? data : data.subarray(0, Math.max(0, room))
    if (keep.length > 0) {
      this.kept[stream].push(keep)
      this.keptBytes[stream] += keep.length
    }
    try {
      await this.onOutput?.(stream, data)
    } catch (error) {
      throw new OutputCallbackError(error)
    }
  }

  /** nothing of the command was seen yet: sending it again under its key can only find it, never start a second */
  get untouched(): boolean {
    return !this.started && this.offsets.stdout === 0 && this.offsets.stderr === 0
  }

  /** output up to `to` left the sandbox's buffer before it was read */
  gap(stream: Stream, to: number): void {
    if (to <= this.offsets[stream]) return
    this.offsets[stream] = to
    this.truncated[stream] = true
  }

  result(exit: ExecExitFrame): ExecResult {
    for (const stream of ["stdout", "stderr"] as const) {
      const total = exit.bytes?.[stream]
      if (typeof total === "number" && total > this.offsets[stream]) this.truncated[stream] = true
    }
    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: exit.timedOut === true,
      durationMs: exit.durationMs,
      stdout: concat(this.kept.stdout),
      stderr: concat(this.kept.stderr),
      truncated: { ...this.truncated },
      execId: this.execId,
      key: this.key,
    }
  }
}

type Ending = { kind: "exit"; exit: ExecExitFrame } | { kind: "error"; message: string } | { kind: "break"; reason: string; progressed: boolean }

/**
 * Reads one exec stream to its end or its break. A stream counts as broken when it ends without an
 * exit, says `detached`, or goes silent past `idleMs` once the server has shown it sends keepalives;
 * and when it carries only kyora cloud's own keepalives, nothing from the sandbox's machine, that long.
 */
async function readStream(response: Response, collector: Collector, idleMs: number): Promise<Ending> {
  const body = response.body
  if (!body) return { kind: "break", reason: "the exec answer had no body", progressed: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const started = Date.now()
  let armed = response.headers.has(KEEPALIVE_HEADER) || collector.execId !== null
  let heard = started
  let machine = started
  let cloudMarks = false
  let progressed = false
  let ending: Ending | null = null
  let buffer = ""

  const handle = async (line: string) => {
    if (!line.trim()) return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const type = frame.type
    if (type === "ping" || type === "started" || type === "attached") armed = true
    if (type === "ping" && frame.from === "cloud") cloudMarks = true
    else machine = Date.now()
    if (type === "stdout" || type === "stderr") {
      const data = typeof frame.b64 === "string" ? fromBase64(frame.b64) : encoder.encode(typeof frame.data === "string" ? frame.data : "")
      if (data.length > 0) progressed = true
      await collector.output(type, data)
    } else if (type === "started") {
      collector.started = true
      if (frame.resumable === true && typeof frame.id === "string") collector.execId = frame.id
      if (typeof frame.key === "string") collector.key = frame.key
    } else if (type === "attached") {
      collector.started = true
      if (typeof frame.id === "string") collector.execId = frame.id
    } else if (type === "gap") {
      if ((frame.stream === "stdout" || frame.stream === "stderr") && typeof frame.to === "number") collector.gap(frame.stream, frame.to)
      progressed = true
    } else if (type === "ping") {
      if (frame.from !== "cloud") progressed = progressed || collector.execId !== null
    } else if (type === "exit") {
      ending = { kind: "exit", exit: frame as unknown as ExecExitFrame }
    } else if (type === "error") {
      ending = { kind: "error", message: typeof frame.message === "string" ? frame.message : "unknown" }
    } else if (type === "detached") {
      ending = { kind: "break", reason: typeof frame.reason === "string" ? frame.reason : "the server let go of the stream", progressed }
    }
  }

  const next = async (): Promise<Awaited<ReturnType<typeof reader.read>> | "idle"> => {
    const limits: number[] = []
    if (armed) limits.push(heard + idleMs)
    if (cloudMarks) limits.push(machine + idleMs)
    if (limits.length === 0) return reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<"idle">((resolve) => {
      timer = setTimeout(() => resolve("idle"), Math.max(0, Math.min(...limits) - Date.now()))
    })
    try {
      return await Promise.race([reader.read(), idle])
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    while (ending === null) {
      const chunk = await next()
      if (chunk === "idle") return { kind: "break", reason: `nothing from the sandbox for ${idleMs} ms`, progressed }
      if (chunk.done) break
      heard = Date.now()
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline: number
      while (ending === null && (newline = buffer.indexOf("\n")) !== -1) {
        await handle(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
    }
    const tail = buffer + decoder.decode()
    if (ending === null && tail.trim()) await handle(tail)
  } catch (error) {
    if (error instanceof OutputCallbackError) throw error
    // an exit that arrived stands, whatever stopped the reading after it
    if (ending === null) return { kind: "break", reason: describe(error), progressed }
  } finally {
    reader.cancel().catch(() => {})
  }
  return ending ?? { kind: "break", reason: "the stream ended without an exit status", progressed }
}

/** a failure that leaves open whether kyora started the command: no answer, a gateway, an internal error, a restart */
function ambiguous(error: unknown): boolean {
  if (!(error instanceof KyoraError)) return false
  return error.status === 0 || error.status === 500 || error.status === 502 || error.status === 504 || error.code === "do_reset"
}

/** worth another reattach: no answer, a retryable error, or a key whose start kyora can't tell yet */
function reattachable(error: unknown): boolean {
  if (!(error instanceof KyoraError)) return false
  return error.retryable || error.code === "exec_key_unknown"
}

/** an abort of its own for each stream, fired once the SDK is done with it, so a stream it gives up on is closed */
function streamSignal(signal: AbortSignal): { signal: AbortSignal; close: () => void } {
  const local = new AbortController()
  return { signal: AbortSignal.any([signal, local.signal]), close: () => local.abort() }
}

export class Exec {
  constructor(private readonly transport: Transport) {}

  /**
   * Runs a command and collects its output. The command is resumable under its key: when the
   * stream breaks it keeps running, and this reattaches from the bytes already read, so the output
   * is continuous. At the deadline it stops waiting (ExecDetachedError) and the command keeps running.
   */
  async run(sandbox: string, request: ExecRequest, options: ExecOptions = {}): Promise<ExecResult> {
    const key = request.key ?? randomKey("sdk-")
    const body: WireExecRequest = { ...request, resumable: true, key }
    const collector = new Collector(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, options.onOutput, key)
    const stdin = encoder.encode(request.stdin ?? "").length
    return this.drive(sandbox, collector, options, (signal, deadline) =>
      this.transport.send("execCommand", { path: { id: sandbox }, body, keyed: true, headersTimeoutMs: START_TIMEOUT_MS + Math.ceil(stdin / 16) }, { signal, deadline }),
    (signal) => this.transport.send("execCommand", { path: { id: sandbox }, body, keyed: true, headersTimeoutMs: START_TIMEOUT_MS }, { signal, retry: false }))
  }

  /** The rest of a running or finished command's output, from `from` (default the start), to its exit. */
  async attach(sandbox: string, execId: string, options: ExecOptions & { from?: ByteOffsets } = {}): Promise<ExecResult> {
    const collector = new Collector(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, options.onOutput, null)
    collector.execId = execId
    if (options.from) {
      collector.offsets.stdout = options.from.stdout
      collector.offsets.stderr = options.from.stderr
    }
    return this.drive(sandbox, collector, options, (signal, deadline) => this.attachOnce(sandbox, collector, signal, { deadline }), null)
  }

  /** stops a resumable command */
  cancel(sandbox: string, execId: string, options: CallOptions = {}): Promise<ExecCancelResponse> {
    return this.transport.json<ExecCancelResponse>("cancelExec", { path: { id: sandbox, execId } }, options)
  }

  private attachOnce(sandbox: string, collector: Collector, signal: AbortSignal, options: CallOptions = {}): Promise<Response> {
    const from = `${collector.offsets.stdout},${collector.offsets.stderr}`
    return this.transport.send("attachExec", { path: { id: sandbox, execId: collector.execId! }, query: { from }, headersTimeoutMs: 30_000 }, { ...options, signal })
  }

  private async drive(
    sandbox: string,
    collector: Collector,
    options: ExecOptions,
    first: (signal: AbortSignal, deadline: number | undefined) => Promise<Response>,
    rejoin: ((signal: AbortSignal) => Promise<Response>) | null,
  ): Promise<ExecResult> {
    const until = endOf(options)
    const deadline = new AbortController()
    const timer = Number.isFinite(until) ? setTimeout(() => deadline.abort(timeoutError("exec")), Math.max(0, until - Date.now())) : undefined
    unref(timer)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    const windowMs = options.reattachWindowMs ?? DEFAULT_WINDOW_MS
    const detached = (code: "timeout" | "stream_lost", message: string, cause?: unknown) =>
      new ExecDetachedError({ code, status: 0, message: `exec in ${sandbox}: ${message}; the command may still be running`, operation: "execCommand", cause }, collector.execId, collector.key, { ...collector.offsets })
    /** kyora asked to wait past the window or the deadline: its error, with what to reattach to */
    const later = (error: KyoraError) =>
      new ExecDetachedError({ code: error.code, status: error.status, message: `${error.message}; the command may still be running`, operation: error.operation ?? "execCommand", class: error.class, retryable: error.retryable, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}), body: error.body, cause: error }, collector.execId, collector.key, { ...collector.offsets })
    const pastDeadline = () => deadline.signal.aborted || Date.now() >= until
    let current = streamSignal(signal)
    try {
      let ending: Ending
      try {
        ending = await readStream(await first(current.signal, Number.isFinite(until) ? until : undefined), collector, idleMs)
      } catch (error) {
        // no answer, or one that may have come after the command started: its key finds it, if it did
        if (!rejoin || signal.aborted || pastDeadline() || !ambiguous(error)) throw error
        ending = { kind: "break", reason: describe(error), progressed: false }
      }
      current.close()
      let episode: { end: number; delay: number } | null = null
      for (;;) {
        if (ending.kind === "exit") return collector.result(ending.exit)
        if (ending.kind === "error") throw new KyoraError({ code: "exec_error", status: 0, message: `exec in ${sandbox}: ${ending.message}`, operation: "execCommand" })
        if (signal.aborted) throw signal.reason
        // a command that started without an id can't be reattached, and sending it again could run it twice
        if (!collector.execId && !(rejoin && collector.untouched)) throw detached("stream_lost", `the stream broke (${ending.reason}) and kyora never named the command, so it can't be reattached`)
        if (!episode || ending.progressed) episode = { end: Date.now() + windowMs, delay: BASE_DELAY_MS }
        let last = ending.reason
        let asked: number | null = null
        let response: Response | null = null
        while (!response) {
          if (Date.now() >= episode.end) throw detached("stream_lost", `lost the stream (${last}) and could not reattach within ${windowMs} ms`)
          await pause(Math.min(asked ?? episode.delay, episode.end - Date.now()), signal)
          asked = null
          episode.delay = Math.min(MAX_DELAY_MS, episode.delay * 2)
          const next = streamSignal(signal)
          let failure: unknown = null
          try {
            // without an id, the key finds the command again: kyora answers it with its id
            response = collector.execId ? await this.attachOnce(sandbox, collector, next.signal, { retry: false }) : await rejoin!(next.signal)
            current = next
          } catch (error) {
            next.close()
            failure = error
          }
          if (failure === null) continue
          if (signal.aborted) throw signal.reason ?? failure
          if (!reattachable(failure)) throw failure
          last = describe(failure)
          const after = (failure as KyoraError).retryAfterMs
          if (after !== undefined) {
            if (Date.now() + after >= Math.min(episode.end, until)) throw later(failure as KyoraError)
            asked = after
          }
        }
        ending = await readStream(response, collector, idleMs)
        current.close()
      }
    } catch (error) {
      current.close()
      if (error instanceof OutputCallbackError) throw error.error
      if (options.signal?.aborted) {
        if (options.cancelOnAbort !== false && collector.execId) await this.cancel(sandbox, collector.execId).catch(() => undefined)
        throw options.signal.reason ?? error
      }
      if (pastDeadline()) {
        if (error instanceof ExecDetachedError) throw error
        // a Retry-After past the deadline comes back as its own error: the command never started
        if (error instanceof KyoraError && error.code !== "timeout" && !collector.execId && error.status !== 0) throw error
        throw detached("timeout", "the deadline passed", error)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
