import { sandboxArgument } from "./names"
import { ApiError, type CreateSpec, type ExecRequest, type Sandbox, type VmsClient } from "./api"
import { execDeadline, runExec, timeoutGraceMs } from "./exec"
import { describeHistory, historyHint, installHistory, prepareHistory, withHistory, type History, type HistoryOptions } from "./history"
import { Interrupt } from "./interrupt"
import { failureCode, FAILED, json, note, queueNotes, regionNote, summarizeList } from "./output"
import { listFiles } from "./pack"
import { pull, push, pushShape, WORK, type PullResult, type PushOptions } from "./transfer"
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

export async function destroyQuietly(api: VmsClient, id: string): Promise<boolean> {
  try {
    await api.destroy(id)
    return true
  } catch (error) {
    note(`could not destroy ${id} (${message(error)}); \`kyora vms rm ${id}\` stops it now`)
    return false
  }
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
    let queuedAt: number | null = null
    let ahead: number | null = null
    const notes = queueNotes(options.wait)
    // the create request is not tied to Ctrl-C (cut short, it would leave a sandbox we never learn
    // the id of); a wait in line for room is, and Ctrl-C then takes the create out of line
    sandbox = await api.create(options.spec, {
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
    const outcome = await runExec(api, sandbox.id, options.exec, { json: options.json, signal: interrupt.signal, deadline: execDeadline(options.exec, started) })
    timings.exec = Date.now() - started
    code = outcome.code
    if (outcome.error) note(outcome.error)

    // once kyora gave up on the command, --out gets what the grace allows, no more: the machine may be out of reach
    const late = outcome.expired ? AbortSignal.timeout(timeoutGraceMs()) : null
    const pulling = late ? AbortSignal.any([interrupt.signal, late]) : interrupt.signal
    for (const out of options.outs) {
      started = Date.now()
      try {
        const result = await pull(api, sandbox.id, out, options.to, pulling)
        downloaded += result.received
        const incomplete = reportPull(result)
        if (options.json) {
          const { entries, refused, failed, durationMs } = result
          await json({ type: "download", path: out, to: options.to, entries, bytes: result.received, refused, failed, durationMs, ...(result.ranged ? { ranged: true } : {}) })
        }
        if (incomplete && code === 0) code = FAILED
      } catch (error) {
        if (interrupt.interrupted) throw error
        const missing = error instanceof ApiError && error.status === 404
        const reason = missing ? "not found in the sandbox" : late?.aborted ? `not fetched within ${formatMs(timeoutGraceMs())} of giving up on the command` : message(error)
        note(`--out ${out}: ${reason}`)
        if (options.json) await json({ type: "download", path: out, error: missing ? "not_found" : reason })
        if (code === 0) code = FAILED
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
      if (options.keep) {
        kept = true
        const label = sandboxArgument(sandbox.name ?? sandbox.id)
        note(`kept ${sandbox.id}${sandbox.name ? ` (${sandbox.name})` : ""}: \`kyora vms exec ${label} -- …\`, \`kyora vms rm ${label}\` when done`)
      } else {
        await destroyQuietly(api, sandbox.id)
      }
    }
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
