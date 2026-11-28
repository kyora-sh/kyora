import { sandboxArgument } from "./names"
import { ApiError, type CreateSpec, type ExecRequest, type Sandbox, type VmsClient } from "./api"
import { execDeadline, positiveEnv, reattachPolicy, runExec, timeoutGraceMs, type ExecOutcome } from "./exec"
import { describeHistory, historyHint, installHistory, prepareHistory, withHistory, type History, type HistoryOptions } from "./history"
import { Interrupt } from "./interrupt"
import { pause } from "./multipart"
import { failureCode, FAILED, json, note, queueNotes, regionNote, summarizeList } from "./output"
import { listFiles } from "./pack"
import { pull, push, pushShape, transient, WORK, type PullResult, type PushOptions } from "./transfer"
import { formatBytes, formatMs } from "./units"

export interface RunOptions {
  dir: string
  /** false for --no-git: walk the directory even inside a repo */
  git: boolean
  /** --git, --git-depth, --git-base: the history goes up too, and .git is set up around it */
  history?: HistoryOptions | null
  spec: CreateSpec
  /** kyora cloud: seconds the create may wait in line when there is no room (0: fail at once) */
  wait: number
  exec: ExecRequest
  outs: string[]
  to: string
  keep: boolean
  json: boolean
  /** --shards and parts in flight; unset lets push decide */
  upload?: Omit<PushOptions, "signal">
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** how long a failed destroy waits before it is asked once more */
export const DESTROY_RETRY_MS = 2_000

/** destroys `id`, asking once more after DESTROY_RETRY_MS when the first ask fails; a sandbox still left says so plainly, since it keeps running and billing */
export async function destroyQuietly(api: VmsClient, id: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  try {
    await api.destroy(id)
    return true
  } catch (first) {
    await wait(DESTROY_RETRY_MS)
    try {
      await api.destroy(id)
      return true
    } catch (error) {
      note(`WARNING: sandbox ${id} is still running (destroy failed twice: ${message(first)}; then ${message(error)}). It keeps running and billing until \`kyora vms rm ${id}\` stops it`)
      return false
    }
  }
}

/**
 * Why the sandbox ended, in its machine's words (`sandbox <id> is gone (<why>)`), when a look at it is
 * answered so: the 404's `ended`, or from a server that predates it, its message. Null otherwise. Any
 * other 404 proves nothing: a scoped token or a region that no longer covers a live sandbox says only
 * "no such sandbox", and so does a kyora-vmd that forgot one.
 */
export async function sandboxEnded(api: VmsClient, id: string, signal?: AbortSignal): Promise<string | null> {
  try {
    await api.get(id, signal)
    return null
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) return null
    if (error.ended) return `sandbox ${id} is gone (${error.ended})`
    const at = error.message.indexOf(`sandbox ${id} is gone (`)
    return at === -1 ? null : error.message.slice(at)
  }
}

/** a command refused for now is asked again this often at most, each wait bounded, all of them within --timeout, or the budget without one */
const EXEC_START_TRIES = 5
const EXEC_START_MIN_WAIT_MS = 1_000
const EXEC_START_MAX_WAIT_MS = 60_000
const EXEC_START_BUDGET_MS = 5 * 60_000
const EXEC_START_DEFAULT_WAIT_MS = 5_000

/** the 429s a limiter answers before the command is admitted, so nothing ran and no key is spent: kyora cloud's and kyora-node's per-sandbox exec_limit */
const REFUSED_FOR_NOW = new Set(["exec_limit"])

const refusedForNow = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 429 && error.code !== undefined && REFUSED_FOR_NOW.has(error.code)

/** how long a command refused for now waits before it is asked again: the server's word, from a second to a minute */
export function execStartWaitMs(error: ApiError): number {
  const asked = error.retryAfterMs ?? EXEC_START_DEFAULT_WAIT_MS
  return Number.isFinite(asked) ? Math.min(EXEC_START_MAX_WAIT_MS, Math.max(EXEC_START_MIN_WAIT_MS, asked)) : EXEC_START_MIN_WAIT_MS
}

const idleNote = (seconds: number | undefined) => (seconds ? `; a sandbox ends after ${lifetime(seconds)} without activity (--idle)` : "")

/** how long a run keeps a sandbox it could not download from, in seconds (KYORA_VMS_KEEP_ON_FAILURE_TTL) */
export function keepOnFailureSeconds(): number {
  return Math.ceil(positiveEnv("KYORA_VMS_KEEP_ON_FAILURE_TTL", 3600))
}

/** the server's idle timeout when none is asked for, and the most it takes */
const DEFAULT_IDLE_SECONDS = 1200
const MAX_IDLE_SECONDS = 28800

/**
 * A run with --out asks for an idle timeout that outlasts the keep: the TTL update after a failed
 * download is no activity, and the last activity may be a retry window back. An explicit --idle,
 * or a sandbox that never expires, stays as asked.
 */
export function runSpec(options: Pick<RunOptions, "spec" | "outs">): CreateSpec {
  if (options.outs.length === 0 || options.spec.idleSeconds !== undefined || options.spec.ttlSeconds === 0) return options.spec
  const idleSeconds = keepOnFailureSeconds() + Math.ceil(reattachPolicy().windowMs / 1000)
  return { ...options.spec, idleSeconds: Math.min(MAX_IDLE_SECONDS, Math.max(DEFAULT_IDLE_SECONDS, idleSeconds)) }
}

const lifetime = (seconds: number) => (seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`)

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

interface Unfetched {
  reason: "download_failed" | "stream_lost" | "exec_refused"
  paths: string[]
  to: string
  /** when the create was sent */
  since: number
  /** the idle timeout the create asked for, when the server did not say */
  idleSeconds?: number
  json: boolean
  signal: AbortSignal
}

const utc = (at: string | number) => new Date(at).toISOString()

/**
 * Outputs that did not come down, or a command that may still be making them: the sandbox stays for
 * keepOnFailureSeconds instead of being destroyed. A TTL is the sandbox's whole lifetime from its
 * creation, so it is set to the time since the create was sent and that much more. The note says only
 * what the server stated: the expiry it answered, or, with no answer, the earliest the sandbox may go
 * (the expiry it had, or the one asked for, had that landed), and only when both are known. False when
 * `signal` fired.
 */
async function keepUnfetched(api: VmsClient, sandbox: Sandbox, why: Unfetched): Promise<boolean> {
  const label = sandbox.name && !sandbox.name.startsWith("-") ? sandbox.name : sandbox.id
  const ttlSeconds = Math.ceil((Date.now() - why.since) / 1000) + keepOnFailureSeconds()
  let answered: Sandbox | null = null
  let failure: string | null = null
  try {
    answered = await api.update(sandbox.id, { ttlSeconds }, why.signal)
  } catch (error) {
    if (why.signal.aborted) return false
    failure = message(error)
  }
  if (why.signal.aborted) return false
  const idleSeconds = answered?.idleSeconds ?? sandbox.idleSeconds ?? why.idleSeconds
  const idle = idleSeconds === 0 ? "" : `, or sooner after ${idleSeconds === undefined ? "its idle timeout" : lifetime(idleSeconds)} without activity`
  const confirmed = typeof answered?.expiresAt === "string"
  // an expiry of null is none at all; one left out is unknown, and so is the floor
  const had = sandbox.expiresAt === null ? Infinity : typeof sandbox.expiresAt === "string" ? Date.parse(sandbox.expiresAt) : NaN
  const asked = typeof sandbox.createdAt === "string" ? Date.parse(sandbox.createdAt) + ttlSeconds * 1000 : NaN
  const floor = Math.min(had, asked)
  const expiresAt = confirmed ? utc(answered!.expiresAt!) : Number.isFinite(floor) ? utc(floor) : null
  const until = confirmed ? ` until ${expiresAt}${idle}` : `; its expiry could not be confirmed (${failure ?? "the server answered none"}${expiresAt ? `; at the earliest ${expiresAt}${idle}` : ""})`
  const later = why.paths.length > 0 ? `kyora vms pull ${label} ${why.paths.map(shellWord).join(" ")}${why.to === process.cwd() ? "" : ` --to ${shellWord(why.to)}`}` : `kyora vms exec ${label} -- …`
  const what = why.reason === "download_failed" ? "the outputs were not downloaded" : why.reason === "exec_refused" ? "the command was refused for now and never ran" : "lost the command's stream, and it may still be running"
  note(`kept ${sandbox.id}${sandbox.name ? ` (${sandbox.name})` : ""}${until}: ${what}, \`${later}\`, \`kyora vms rm ${label}\` when done`)
  if (why.json) await json({ type: "kept", id: sandbox.id, reason: why.reason, expiresAt, idleSeconds: idleSeconds ?? null, confirmed })
  return !why.signal.aborted
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "y" : "ies"}`

/** --json's account of the history that went up */
export function historyEvent(history: History) {
  return {
    bytes: history.bytes,
    commits: history.commits,
    shallow: history.shallow,
    head: history.head,
    branch: history.branch,
    base: history.base ? { rev: history.base.rev, commit: history.base.sha, ref: history.base.ref } : null,
    staged: history.staged,
  }
}

/** true when something the archive held did not land */
export function reportPull(result: PullResult): boolean {
  if (result.refused.length > 0) note(`refused ${count(result.refused.length, "unsafe entr")} from ${result.path}: ${summarizeList(result.refused)}`)
  if (result.failed.length > 0) note(`could not write ${count(result.failed.length, "entr")} from ${result.path}: ${summarizeList(result.failed)}`)
  if (result.skipped.length > 0) note(`skipped ${summarizeList(result.skipped)}`)
  return result.refused.length + result.failed.length > 0
}

/**
 * create → upload → exec → download → destroy. The exit code is the remote
 * command's; 125 means kyora itself failed, and a failed download turns a
 * remote success into 125 so an agent never mistakes a missing artifact for a build.
 * A download that failed (not a missing path), a stream that was lost, or a command a limiter refused (429) on every try
 * keeps the sandbox for a while instead.
 * A create refused with image_unavailable exits 123.
 */
export async function run(api: VmsClient, options: RunOptions): Promise<number> {
  const interrupt = new Interrupt()
  const timings: Record<"create" | "queued" | "upload" | "git" | "exec" | "download", number | null> = { create: null, queued: null, upload: null, git: null, exec: null, download: null }
  const upload = { bytes: 0, entries: 0 }
  let downloaded = 0
  let sandbox: Sandbox | null = null
  let history: History | null = null
  let code = FAILED
  let kept = false
  let createdBy = 0
  let spec = runSpec(options)
  const unfetched: string[] = []
  let lost = false
  // the command was refused for now on every try: it never ran, and the sandbox stays
  let refused = false
  // the server's word that the sandbox ended: nothing left to fetch, keep or destroy
  let gone: string | null = null

  try {
    let listing = await listFiles(options.dir, { git: options.git })
    interrupt.throwIfInterrupted()
    let started = Date.now()
    // before the sandbox: history that cannot go up stops the run with nothing created
    if (options.history) {
      history = await prepareHistory(options.dir, listing, options.history, interrupt.signal)
      listing = withHistory(listing, history)
    }
    const prepared = Date.now() - started
    interrupt.throwIfInterrupted()

    started = Date.now()
    createdBy = started
    let queuedAt: number | null = null
    let ahead: number | null = null
    const notes = queueNotes(options.wait)
    // the create request is not tied to Ctrl-C (cut short, it would leave a sandbox we never learn
    // the id of); a wait in line for room is, and Ctrl-C then takes the create out of line
    const create = (asked: CreateSpec) => api.create(asked, {
      wait: options.wait,
      graceMs: timeoutGraceMs(),
      signal: interrupt.signal,
      onQueued: (ticket) => {
        queuedAt ??= Date.now()
        notes(ticket)
        if (options.json && ticket.ahead !== ahead) void json({ type: "queued", ticket: ticket.ticket, position: ticket.position, ahead: ticket.ahead, waitUntil: ticket.waitUntil })
        ahead = ticket.ahead
      },
    })
    try {
      sandbox = await create(spec)
    } catch (error) {
      // an account capped below the idle timeout --out asks for: the server's own, as without --out
      if (spec === options.spec || !(error instanceof ApiError) || error.status !== 403 || error.code !== "quota_exceeded") throw error
      spec = options.spec
      sandbox = await create(spec)
    }
    timings.create = Date.now() - started
    if (queuedAt !== null) timings.queued = Date.now() - queuedAt
    if (!options.json) regionNote(sandbox)
    if (options.json) await json({ type: "sandbox", ...sandbox })
    interrupt.throwIfInterrupted()

    const pushed = await push(api, sandbox.id, listing, WORK, { ...options.upload, signal: interrupt.signal })
    timings.upload = pushed.durationMs
    upload.bytes = pushed.sent
    upload.entries = pushed.server.entries ?? listing.entries.length
    if (pushed.warnings.length > 0) note(`packing: ${summarizeList(pushed.warnings)}`)
    if (options.json) {
      await json({ type: "upload", bytes: upload.bytes, entries: upload.entries, files: listing.mode, durationMs: pushed.durationMs, ...pushShape(pushed) })
    }

    if (history) {
      timings.git = prepared + (await installHistory(api, sandbox.id, history, WORK, interrupt.signal))
      if (options.json) await json({ type: "git", ...historyEvent(history), durationMs: timings.git })
    }

    started = Date.now()
    const deadline = execDeadline(options.exec, started)
    const timeoutAt = options.exec.timeoutSeconds ? started + options.exec.timeoutSeconds * 1000 : Infinity
    const waitsEnd = options.exec.timeoutSeconds ? timeoutAt : started + EXEC_START_BUDGET_MS
    let request = options.exec
    let outcome: ExecOutcome
    for (let attempt = 1; ; attempt++) {
      try {
        outcome = await runExec(api, sandbox.id, request, { json: options.json, signal: interrupt.signal, deadline })
        break
      } catch (error) {
        if (!interrupt.interrupted && refusedForNow(error)) {
          const wait = execStartWaitMs(error)
          if (attempt < EXEC_START_TRIES && Date.now() + wait < waitsEnd) {
            note(`${error.message}; asking again in ${formatMs(wait)} (try ${attempt + 1} of ${EXEC_START_TRIES})`)
            await pause(wait, interrupt.signal)
            if (Date.now() < waitsEnd) {
              if (request.timeoutSeconds) request = { ...options.exec, timeoutSeconds: Math.max(1, Math.ceil((timeoutAt - Date.now()) / 1000)) }
              continue
            }
          }
          refused = true
          timings.exec = Date.now() - started
          throw error
        }
        // the command may have started and only its answer been lost: --out still runs, and the sandbox stays
        // exec_not_started on every try proves the command never ran
        if (interrupt.interrupted || !transient(error) || (error instanceof ApiError && error.code === "exec_not_started")) throw error
        outcome = { code: FAILED, exit: null, error: `no answer to the command in ${sandbox.id} (${message(error)}); it may be running there`, lost: true }
        break
      }
    }
    timings.exec = Date.now() - started
    code = outcome.code
    if (outcome.error) note(outcome.error)
    lost = outcome.lost === true

    // once kyora gave up on the command, --out gets what the grace allows, no more: the machine may be out of reach
    const late = outcome.expired ? AbortSignal.timeout(timeoutGraceMs()) : null
    const pulling = late ? AbortSignal.any([interrupt.signal, late]) : interrupt.signal
    // one --out that ran out of retries on the network: the rest would only wait out the same window each
    let unreachable = false
    for (const out of options.outs) {
      if (gone !== null) {
        note(`--out ${out}: not tried, ${sandbox.id} has ended`)
        if (options.json) await json({ type: "download", path: out, error: "sandbox_gone" })
        continue
      }
      if (unreachable) {
        note(`--out ${out}: not tried, ${sandbox.id} is out of reach`)
        if (options.json) await json({ type: "download", path: out, error: "not tried, the sandbox is out of reach" })
        unfetched.push(out)
        continue
      }
      started = Date.now()
      try {
        const result = await pull(api, sandbox.id, out, options.to, pulling, reattachPolicy())
        downloaded += result.received
        const incomplete = reportPull(result)
        if (options.json) {
          const { entries, refused, failed, durationMs } = result
          await json({ type: "download", path: out, to: options.to, entries, bytes: result.received, refused, failed, durationMs, ...(result.ranged ? { ranged: true } : {}) })
        }
        if (incomplete && code === 0) code = FAILED
        // an entry that could not be written here comes down again once that is fixed; a refused one never does
        if (result.failed.length > 0) unfetched.push(out)
      } catch (error) {
        if (interrupt.interrupted) throw error
        const missing = error instanceof ApiError && error.status === 404
        if (missing) gone = await sandboxEnded(api, sandbox.id, interrupt.signal)
        if (interrupt.interrupted) throw error
        const reason = gone !== null ? `not downloaded, ${gone}${idleNote(sandbox.idleSeconds ?? spec.idleSeconds)}` : missing ? "not found in the sandbox" : late?.aborted ? `not fetched within ${formatMs(timeoutGraceMs())} of giving up on the command` : message(error)
        note(`--out ${out}: ${reason}`)
        if (options.json) await json({ type: "download", path: out, error: gone !== null ? "sandbox_gone" : missing ? "not_found" : reason })
        if (code === 0) code = FAILED
        if (!missing) unfetched.push(out)
        if (transient(error)) unreachable = true
      } finally {
        timings.download = (timings.download ?? 0) + Date.now() - started
      }
    }
  } catch (error) {
    if (interrupt.interrupted) code = interrupt.code!
    else {
      note(message(error))
      const hint = historyHint(error, history)
      if (hint) note(hint)
      code = failureCode(error)
    }
  } finally {
    await history?.cleanup()
    if (sandbox) {
      const noted = gone !== null
      // a sandbox already gone is no keep: a TTL update it refused would read as one, unconfirmed
      if (!interrupt.interrupted && !noted && (unfetched.length > 0 || lost || refused)) gone = await sandboxEnded(api, sandbox.id, interrupt.signal)
      // once known gone it is neither kept nor destroyed, Ctrl-C or not; Ctrl-C only decides the exit code
      if (gone !== null) {
        code = FAILED
        if (!noted) note(`${sandbox.id} not kept: ${gone}${idleNote(sandbox.idleSeconds ?? spec.idleSeconds)}`)
        if (options.json) await json({ type: "gone", id: sandbox.id, reason: gone })
      } else if (options.keep) {
        kept = true
        const label = sandboxArgument(sandbox.name ?? sandbox.id)
        note(`kept ${sandbox.id}${sandbox.name ? ` (${sandbox.name})` : ""}: \`kyora vms exec ${label} -- …\`, \`kyora vms rm ${label}\` when done`)
      } else if (!interrupt.interrupted && (unfetched.length > 0 || lost || refused)) {
        const reason = unfetched.length > 0 ? "download_failed" : lost ? "stream_lost" : "exec_refused"
        kept = await keepUnfetched(api, sandbox, { reason, paths: reason === "download_failed" ? unfetched : reason === "stream_lost" ? options.outs : [], to: options.to, since: createdBy, idleSeconds: spec.idleSeconds, json: options.json, signal: interrupt.signal })
        // Ctrl-C while the TTL was being set: the interrupt wins, as anywhere else
        if (!kept) {
          code = interrupt.code!
          await destroyQuietly(api, sandbox.id)
        }
      } else {
        await destroyQuietly(api, sandbox.id)
      }
    }
    // a Ctrl-C during any of the awaits above wins, as anywhere else
    if (interrupt.interrupted) code = interrupt.code!
    interrupt.dispose()
  }

  if (options.json) {
    await json({
      type: "summary",
      id: sandbox?.id ?? null,
      exitCode: code,
      kept,
      upload: { bytes: upload.bytes, entries: upload.entries },
      ...(history && timings.git !== null ? { git: historyEvent(history) } : {}),
      downloadBytes: downloaded,
      timings: Object.fromEntries(Object.entries(timings).map(([stage, ms]) => [`${stage}Ms`, ms])),
    })
  } else if (sandbox) {
    const parts = [`create ${formatMs(timings.create ?? 0)}${timings.queued !== null ? ` (queued ${formatMs(timings.queued)})` : ""}`]
    if (timings.upload !== null) parts.push(`upload ${formatBytes(upload.bytes)} (${upload.entries.toLocaleString("en-US")} entries) ${formatMs(timings.upload)}`)
    if (history && timings.git !== null) parts.push(`git history ${describeHistory(history)} ${formatMs(timings.git)}`)
    if (timings.exec !== null) parts.push(`exec ${formatMs(timings.exec)}`)
    if (timings.download !== null) parts.push(`download ${formatBytes(downloaded)} ${formatMs(timings.download)}`)
    parts.push(`exit ${code}`)
    note(`${sandbox.id}: ${parts.join(" · ")}`)
  }
  return code
}
