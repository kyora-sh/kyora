import { ApiError, type ExecRequest, type StreamOffsets, type VmsClient } from "./api"
import { pause } from "./multipart"
import { FAILED, note, write } from "./output"
import { formatBytes, formatMs } from "./units"

export interface ExitEvent {
  type: "exit"
  code: number | null
  signal: string | number | null
  durationMs?: number
  timedOut?: boolean
  /** a resumable command's total bytes per stream */
  bytes?: Partial<StreamOffsets>
}

/** the guest is Linux, so its signal numbers, not the laptop's (SIGUSR1 is 10 there, 30 on macOS) */
const LINUX_SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPWR: 30, SIGSYS: 31,
}

function signalNumber(signal: string | number | null | undefined): number | null {
  if (typeof signal === "number") return signal > 0 ? signal : null
  if (!signal) return null
  const name = signal.toUpperCase()
  return LINUX_SIGNALS[name.startsWith("SIG") ? name : `SIG${name}`] ?? null
}

/** --timeout's exit code (GNU timeout's), whether the sandbox or kyora-vms called it */
const TIMED_OUT = 124

/**
 * Shell conventions, so an agent reads the result the way it would a local run:
 * a timeout is 124 (GNU timeout), death by signal n is 128+n, and a negative code
 * (Python's way of saying "killed by signal") maps the same way.
 */
export function exitCodeOf(event: ExitEvent): number {
  if (event.timedOut) return TIMED_OUT
  if (typeof event.code === "number") return event.code < 0 ? 128 + Math.min(-event.code, 127) : Math.min(event.code, 255)
  const signal = signalNumber(event.signal)
  return signal ? 128 + signal : FAILED
}

export interface ExecOutcome {
  code: number
  exit: ExitEvent | null
  /** an infrastructure failure the server reported, or a stream that ended early; the caller prints it */
  error: string | null
  /** kyora-vms gave up on the command at its deadline (--timeout and the grace) */
  expired?: boolean
}

type Stream = keyof StreamOffsets

/** the exec ids the agent hands out: 128 random bits */
const EXEC_ID = /^[0-9a-f]{32}$/

/**
 * On an exec or attach response: the server sends a line at least this often (ms), so silence
 * means the stream is broken from the first byte on. kyora-vmd and kyora cloud say it.
 */
export const KEEPALIVE_HEADER = "x-kyora-keepalive-ms"

/** kyora cloud marks its own keepalives `{"type":"ping","from":"cloud"}` */
const CLOUD = "cloud"
/**
 * kyora-vmd marks its own `{"type":"ping","from":"machine","seq":n,"stdout":…,"stderr":…}`, and says
 * so on each stream's first line (`started` and `attached` carry `"from":"machine"`; a plain exec's
 * first line is such a keepalive): the only keepalives that prove the path to the command alive. A
 * relay in between (a control plane a deploy replaced, say) can keep sending plain pings for a
 * machine that is long gone.
 */
const MACHINE = "machine"

/** lines only a server that sends keepalives sends: one of them arms the watchdog on a stream without the header */
const KEEPALIVE_LINES = new Set(["ping", "started", "attached"])

/** a relay's own opening and end: no sign the command's machine got anywhere, wherever they came from */
const RELAY_LINES = new Set(["started", "attached", "detached"])

function payload(event: { data?: unknown; b64?: unknown }): Uint8Array | string {
  if (typeof event.b64 === "string") return Buffer.from(event.b64, "base64")
  return typeof event.data === "string" ? event.data : ""
}

const byteLength = (data: Uint8Array | string) => (typeof data === "string" ? Buffer.byteLength(data) : data.length)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function parses(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

/** how one response of the stream ended; a break by the watchdog is `silent` */
type Ending = { kind: "exit"; exit: ExitEvent } | { kind: "error"; message: string } | { kind: "break"; reason: string; progressed: boolean; silent: boolean }

/** how reattaching behaves; the environment overrides are for tests */
export interface ReattachPolicy {
  /** how long a break may last before the command is given up on */
  windowMs: number
  /** the first wait; doubled after each failed try, up to maxDelayMs */
  baseDelayMs: number
  maxDelayMs: number
  /**
   * A stream that says nothing this long (not even the server's 20 s keepalive) is taken for
   * broken, and so is one that carries only kyora cloud's own keepalives, nothing from the
   * machine, this long: the control plane answering for a path to the command that is gone.
   */
  idleMs: number
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** how long after --timeout kyora-vms waits for the command's exit before it gives up on it */
export function timeoutGraceMs(): number {
  return positiveEnv("KYORA_VMS_TIMEOUT_GRACE_MS", 60_000)
}

/** when kyora-vms stops waiting for a command, whatever its stream is doing */
export interface Deadline {
  /** epoch ms */
  at: number
  /** what passed, for the line that says so */
  why: string
}

/** an exec's own deadline: --timeout from its start, and the grace; none without --timeout */
export function execDeadline(request: ExecRequest, started = Date.now()): Deadline | null {
  if (!request.timeoutSeconds) return null
  const grace = timeoutGraceMs()
  return { at: started + request.timeoutSeconds * 1000 + grace, why: `its --timeout of ${formatMs(request.timeoutSeconds * 1000)} passed ${formatMs(grace)} ago` }
}

class DeadlinePassed extends Error {
  constructor() {
    super("the command's deadline passed")
  }
}

/** an abort that fires at `at`; `clear` once it is no longer needed */
function expiry(at: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DeadlinePassed()), Math.max(0, at - Date.now()))
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

export function reattachPolicy(): ReattachPolicy {
  const baseDelayMs = positiveEnv("KYORA_VMS_REATTACH_BASE_MS", 250)
  return {
    windowMs: positiveEnv("KYORA_VMS_REATTACH_WINDOW_MS", 2 * 60_000),
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, Math.min(10_000, baseDelayMs * 40)),
    idleMs: positiveEnv("KYORA_VMS_STREAM_IDLE_MS", 60_000),
  }
}

/** worth another reattach: the network, a 5xx, a sandbox busy or starting (409), 408, 429 */
export function reattachable(error: unknown): boolean {
  if (error instanceof ApiError) return ["vmd_unavailable", "node_offline", "node_disconnected"].includes(error.code ?? "") || error.status === 0 || (error.status >= 500 && error.status !== 501) || error.status === 408 || error.status === 409 || error.status === 429
  // fetch can fail before the API wraps it (including during a test or another transport).
  return error instanceof TypeError || (error instanceof Error && /^(ECONN|ENET|EHOST|EPIPE|ETIMEDOUT|Connection|Socket)/.test(String((error as NodeJS.ErrnoException).code ?? "")))
}

/** what the watchdog of one response knows */
interface Watch {
  /** the server has shown it sends keepalives (the header, or a line only such a server sends); before that, silence proves nothing */
  armed: boolean
  /** the last bytes of any kind */
  heard: number
  /** the machine's last line: output, any event of the command's, a keepalive of the machine's own */
  machine: number
  /**
   * The machine's keepalives can be told from anyone else's: kyora cloud marks its own, or (`machineMarks`)
   * kyora-vmd marks its. Either way the machine's silence is told apart from the stream's.
   */
  marked: boolean
  /**
   * kyora-vmd marks its keepalives on this response (its first line said so, or a marked one came):
   * from then on a plain ping is nobody's (a relay keeping a dead stream alive), and only a marked one
   * with a newer `seq` than the last is the machine's (an old line replayed proves nothing). Until
   * then, as from a kyora-vmd that never marks them, a plain ping is the machine's.
   */
  machineMarks: boolean
  /** the highest `seq` of the machine's keepalives on this response */
  seq: number
  /** kyora-node's stream heartbeat has its own sequence, independent of kyora-vmd's NDJSON pings */
  nodeSeq: number
}

/** whether a line is the machine's own: kyora cloud's keepalives never are, nor a plain or stale ping once the machine marks its own */
function fromMachine(event: Record<string, unknown>, watch: Watch): boolean {
  if (event.type !== "ping") {
    // the first line of a machine that marks its keepalives says so (a plain exec's first line is its keepalive)
    if ((event.type === "started" || event.type === "attached") && event.from === MACHINE) watch.machineMarks = true
    return true
  }
  if (event.from === CLOUD) {
    watch.marked = true
    return false
  }
  if (event.from === MACHINE) {
    watch.machineMarks = true
    const sequence = event.source === "node" ? "nodeSeq" : "seq"
    if (typeof event.seq !== "number" || !(event.seq > watch[sequence])) return false
    watch[sequence] = event.seq
    return true
  }
  return !watch.machineMarks
}

/**
 * Writes an exec's NDJSON events out as they arrive: stdout and stderr to ours, or
 * every line verbatim with --json. It counts the bytes of each stream it has written,
 * which is where a reattach carries on. Unknown event types (keepalives) are ignored.
 */
/** where a command's output goes instead of this process's stdout and stderr */
export type OutputSink = (stream: "stdout" | "stderr", data: Uint8Array | string) => void | Promise<void>

class Relay {
  readonly bytes: StreamOffsets = { stdout: 0, stderr: 0 }
  execId: string | null = null
  /** the last `error` event, reported with the outcome */
  error: string | null = null

  constructor(
    private readonly json: boolean,
    private readonly idleMs: number,
    private readonly sink?: OutputSink,
  ) {}

  /** reads one response to its end, or to a break; an abort of `signal` (Ctrl-C, the deadline) is thrown */
  async read(response: Response, signal?: AbortSignal): Promise<Ending> {
    let exit: ExitEvent | null = null
    let failed: string | null = null
    let detached: string | null = null
    /** bytes of the command's output this response wrote: control lines (attached, detached, pings, gaps) are no progress */
    let written = 0
    /**
     * The machine got somewhere on this response: its own keepalive (relayed), a gap, any event of the
     * command's. Not kyora cloud's keepalives or anyone else's (`fromMachine`), nor a relay's opening or
     * its `detached`, which kyora cloud also sends (its machine-silence check, the Worker's watchdog).
     */
    let moved = false
    const started = Date.now()
    // a reattach's stream (an exec id is known) comes from a server that sends keepalives
    const watch: Watch = { armed: response.headers.has(KEEPALIVE_HEADER) || this.execId !== null, heard: started, machine: started, marked: false, machineMarks: false, seq: 0, nodeSeq: 0 }

    const handle = async (line: string) => {
      if (!line.trim()) return
      if (this.json) await write(process.stdout, `${line}\n`)
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      const machine = fromMachine(event, watch)
      if (machine) watch.machine = Date.now()
      if (machine && !RELAY_LINES.has(event.type as string)) moved = true
      if (KEEPALIVE_LINES.has(event.type as string)) watch.armed = true
      if (event.type === "stdout" || event.type === "stderr") {
        const data = payload(event)
        if (this.sink) await this.sink(event.type, data)
        else if (!this.json) await write(event.type === "stdout" ? process.stdout : process.stderr, data)
        this.bytes[event.type] += byteLength(data)
        written += byteLength(data)
      } else if (event.type === "started") {
        if (event.resumable === true && typeof event.id === "string" && EXEC_ID.test(event.id)) this.execId = event.id
      } else if (event.type === "gap") {
        this.gap(event)
      } else if (event.type === "detached") {
        detached = typeof event.reason === "string" && event.reason ? event.reason : "the server let go of the stream"
      } else if (event.type === "exit") {
        exit = event as unknown as ExitEvent
      } else if (event.type === "error") {
        failed = typeof event.message === "string" ? event.message : "unknown"
        this.error = `remote error: ${failed}`
      }
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let broke: string | null = null
    /** the watchdog broke it off */
    let silent = false
    // the last line that matters is the command's exit (or the server's error): read no further, the
    // connection may well stay open, and nothing after it (the deadline, the watchdog) may undo it
    const over = () => detached !== null || exit !== null || failed !== null
    try {
      while (!over()) {
        const next = await this.next(reader, this.limit(watch))
        if (next === "idle") {
          silent = true
          const orphaned = (watch.marked || watch.machineMarks) && Date.now() >= watch.machine + this.idleMs
          broke = orphaned ? `only keepalives that aren't the machine's, nothing from the machine itself, for ${formatMs(this.idleMs)}` : `nothing heard for ${formatMs(this.idleMs)}`
          break
        }
        if (next.done) break
        watch.heard = Date.now()
        buffer += decoder.decode(next.value, { stream: true })
        let newline: number
        while (!over() && (newline = buffer.indexOf("\n")) !== -1) {
          await handle(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
        }
      }
      // a last line without its newline counts only if the stream ended cleanly and it is whole JSON
      const tail = buffer + decoder.decode()
      if (!broke && !over() && tail.trim() && parses(tail)) await handle(tail)
    } catch (error) {
      // an exit that arrived stands, whatever stopped the reading after it
      if (exit === null && failed === null) {
        if (signal?.aborted) throw signal.reason ?? error
        // a line cut off by the break is dropped: its bytes come again from the offsets
        broke = message(error)
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    if (exit) return { kind: "exit", exit }
    if (failed !== null) return { kind: "error", message: failed }
    // A reattach got somewhere once it wrote some of the command's output, or once the machine itself
    // was heard from again (a quiet command's stream carries kyora-vmd's keepalive every 20 s). How
    // long it held, or how it ended, says nothing: one that says attached and is let go of at once
    // is no progress, and nor is one that only kyora cloud kept alive and then let go of, however
    // long that was. The window and the backoff carry on.
    const progressed = written > 0 || moved
    return { kind: "break", reason: detached ?? broke ?? "the stream ended without an exit status", progressed, silent }
  }

  /**
   * When the watchdog gives up on the stream: idleMs after the last bytes, once the server has
   * shown it sends keepalives, and idleMs after the machine's last line, once the machine's
   * keepalives can be told from anyone else's (kyora-vmd marks its own, or kyora cloud its own).
   * Null while neither applies (a server that may not send keepalives at all: the deadline is the
   * backstop there).
   */
  private limit(watch: Watch): number | null {
    const limits: number[] = []
    if (watch.armed) limits.push(watch.heard + this.idleMs)
    if (watch.marked || watch.machineMarks) limits.push(watch.machine + this.idleMs)
    return limits.length > 0 ? Math.min(...limits) : null
  }

  /** the next chunk, or "idle" at `limit` (a half-open connection never errors) */
  private async next(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number | null): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> | "idle"> {
    if (limit === null) return reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<"idle">((resolve) => (timer = setTimeout(() => resolve("idle"), Math.max(0, limit - Date.now()))))
    try {
      return await Promise.race([reader.read(), idle])
    } finally {
      clearTimeout(timer)
    }
  }

  private gap(event: Record<string, unknown>): void {
    const stream = event.stream
    if ((stream !== "stdout" && stream !== "stderr") || typeof event.to !== "number" || !Number.isInteger(event.to)) return
    const lost = event.to - this.bytes[stream]
    if (lost <= 0) return
    note(`${formatBytes(lost)} of the command's ${stream} were dropped while nobody was attached (the sandbox keeps the latest 8 MiB of each stream)`)
    this.bytes[stream] = event.to
  }

  /** a resumable command's exit says how much each stream held: anything short of that never arrived */
  checkTotals(exit: ExitEvent): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const total = exit.bytes?.[stream]
      if (typeof total === "number" && total > this.bytes[stream]) note(`${formatBytes(total - this.bytes[stream])} of the command's ${stream} never arrived`)
    }
  }
}

/**
 * Each stream is opened with an abort of its own, fired once the CLI is done with it, so a
 * stream it gives up on (a break, the idle watchdog) is closed, not just left unread. Bun's
 * fetch before 1.4 keeps the connection when only the body is cancelled; the server, and so
 * the guest, would go on counting it as attached, and a reader that never reads holds the
 * command's output back (and once its buffer is full, the command).
 */
function streamSignal(signal?: AbortSignal): { signal: AbortSignal; close: () => void } {
  const local = new AbortController()
  return { signal: signal ? AbortSignal.any([signal, local.signal]) : local.signal, close: () => local.abort() }
}

async function cancelRemote(api: VmsClient, id: string, execId: string): Promise<void> {
  try {
    await api.cancelExec(id, execId)
  } catch (error) {
    note(`could not cancel the command in ${id} (${message(error)}); it runs until it ends or times out`)
  }
}

/**
 * The deadline passed: the stream is dropped already. A command with an id is cancelled by it
 * (a plain one dies with its stream); the caller destroys the sandbox or leaves it.
 */
async function giveUp(api: VmsClient, id: string, execId: string | null, deadline: Deadline): Promise<ExecOutcome> {
  let what = "dropped its stream"
  if (execId) {
    try {
      await api.cancelExec(id, execId)
      what = "cancelled it"
    } catch (error) {
      what = `could not cancel it (${message(error)})`
    }
  }
  return { code: TIMED_OUT, exit: null, error: `gave up on the command in ${id}: ${deadline.why} and no exit status came; ${what}`, expired: true }
}

/**
 * Runs a command and writes its output out as it comes. It asks for a resumable
 * command: when the stream breaks (the network, a restart of the server or of anything
 * between it and the sandbox), the command keeps running in the sandbox, and this
 * reattaches from the bytes of each stream written so far, backing off, until the
 * window runs out. So the output is continuous and the exit code the command's. A
 * server that can't (no `started` line with an id) breaks as it always did: 125.
 * An abort of `signal` (Ctrl-C) cancels a resumable command explicitly, then is thrown.
 * At `deadline` it stops waiting, whatever the stream is doing, and cancels the command: 124.
 */
export async function runExec(
  api: VmsClient,
  id: string,
  request: ExecRequest,
  options: { json: boolean; signal?: AbortSignal; policy?: ReattachPolicy; deadline?: Deadline | null; output?: OutputSink },
): Promise<ExecOutcome> {
  const policy = options.policy ?? reattachPolicy()
  const relay = new Relay(options.json, policy.idleMs, options.output)
  const expires = options.deadline ? expiry(options.deadline.at) : null
  // every request, read and wait below ends at Ctrl-C or at the deadline; which one it was decides what follows
  const signal = expires ? (options.signal ? AbortSignal.any([options.signal, expires.signal]) : expires.signal) : options.signal
  let current = streamSignal(signal)
  try {
    // its key makes a re-send safe: kyora cloud starts at most one command for it
    const response = await api.exec(id, { ...request, resumable: true, key: request.key ?? `kyora-vms:${crypto.randomUUID()}` }, current.signal)
    let ending = await relay.read(response, signal)
    current.close()
    // a break and the reattaches after it, until one gets somewhere
    let episode: { deadline: number; delay: number } | null = null
    for (;;) {
      if (ending.kind === "exit") {
        api.execExited(id)
        relay.checkTotals(ending.exit)
        return { code: exitCodeOf(ending.exit), exit: ending.exit, error: relay.error }
      }
      if (ending.kind === "error") return { code: FAILED, exit: null, error: relay.error }
      const execId = relay.execId
      if (!execId) {
        // without an id there is nothing to reattach to: a plain exec, or one whose first line never came
        if (!ending.silent) return { code: FAILED, exit: null, error: "the exec stream ended without an exit status (connection lost?)" }
        return { code: FAILED, exit: null, error: `the exec stream went silent (${ending.reason}) and can't be reattached, the server never named the command; it may still be running in ${id}` }
      }
      if (!episode || ending.progressed) {
        note("reconnecting…")
        episode = { deadline: Date.now() + policy.windowMs, delay: policy.baseDelayMs }
      }
      let last = ending.reason
      let attached: Response | null = null
      while (!attached) {
        if (Date.now() >= episode.deadline) {
          const error = `lost the command's stream (${last}) and could not reattach within ${formatMs(policy.windowMs)}; it may still be running in ${id}`
          return { code: FAILED, exit: null, error }
        }
        await pause(Math.min(episode.delay, episode.deadline - Date.now()), signal ?? new AbortController().signal)
        if (Date.now() >= episode.deadline) continue
        episode.delay = Math.min(policy.maxDelayMs, episode.delay * 2)
        const attempt = expiry(episode.deadline)
        const next = streamSignal(signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal)
        try {
          attached = await api.attach(id, execId, relay.bytes, next.signal)
          current = next
        } catch (error) {
          next.close()
          if (signal?.aborted) throw signal.reason ?? error
          if (!attempt.signal.aborted && !reattachable(error)) return { code: FAILED, exit: null, error: `lost the command's stream (${last}), and it can't be reattached: ${message(error)}` }
          last = message(error)
        } finally {
          attempt.clear()
        }
      }
      ending = await relay.read(attached, signal)
      current.close()
    }
  } catch (error) {
    current.close()
    if (options.signal?.aborted) {
      if (relay.execId) await cancelRemote(api, id, relay.execId)
      throw error
    }
    if (expires?.signal.aborted) return giveUp(api, id, relay.execId, options.deadline!)
    throw error
  } finally {
    expires?.clear()
  }
}

interface ExecEvent {
  type?: unknown
  data?: unknown
  b64?: unknown
  message?: unknown
}

/** an exec's NDJSON events in order, each with its line as it came; exit and error are kept for the outcome */
async function readEvents(response: Response, handle: (event: ExecEvent, line: string) => Promise<void> | void): Promise<ExecOutcome> {
  let exit: ExitEvent | null = null
  let error: string | null = null

  const next = async (line: string) => {
    if (!line.trim()) return
    let event: ExecEvent
    try {
      event = JSON.parse(line)
    } catch {
      event = {}
    }
    await handle(event, line)
    if (event.type === "exit") exit = event as ExitEvent
    else if (event.type === "error") error = `remote error: ${typeof event.message === "string" ? event.message : "unknown"}`
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  // nothing after the exit (or the error) matters: a connection left open after it is not waited on
  const over = () => exit !== null || error !== null
  while (!over()) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while (!over() && (newline = buffer.indexOf("\n")) !== -1) {
      await next(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
    }
  }
  if (over()) reader.cancel().catch(() => {})
  else await next(buffer + decoder.decode())

  const finished = exit as ExitEvent | null
  if (finished) return { code: exitCodeOf(finished), exit: finished, error }
  return { code: FAILED, exit: null, error: error ?? "the exec stream ended without an exit status (connection lost?)" }
}

/** the same events kept instead of shown: for the commands kyora-vms runs in the sandbox for itself */
export async function collectExec(response: Response): Promise<ExecOutcome & { stdout: string; stderr: string }> {
  const out = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }
  const encoder = new TextEncoder()
  const outcome = await readEvents(response, (event) => {
    if (event.type !== "stdout" && event.type !== "stderr") return
    const data = payload(event)
    out[event.type].push(typeof data === "string" ? encoder.encode(data) : data)
  })
  // decoded whole, so a character split across two events comes out as itself
  const text = (parts: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(parts))
  return { ...outcome, stdout: text(out.stdout), stderr: text(out.stderr) }
}
