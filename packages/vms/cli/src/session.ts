import { resolveTarget, shortIds } from "./names"
import { ApiError, type CreateSpec, type ExecRequest, type Health, type NodeInfo, type Sandbox, type VmsClient } from "./api"
import type { Config } from "./config"
import { execDeadline, runExec, timeoutGraceMs } from "./exec"
import { describeHistory, historyHint, installHistory, prepareHistory, withHistory, type History, type HistoryOptions } from "./history"
import { Interrupt } from "./interrupt"
import { FAILED, note, printJson, queueNotes, regionNote, summarizeList } from "./output"
import { listFiles } from "./pack"
import { destroyQuietly, historyEvent, reportPull } from "./run"
import { pull, push, pushShape, type PushOptions } from "./transfer"
import { formatBytes, formatMs, relativeTime } from "./units"

export const memory = (mb: number) => (mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`)

function describe(sandbox: Sandbox): string {
  const where = sandbox.node ? ` · on ${sandbox.node}${sandbox.region ? ` in ${sandbox.region}` : ""}` : sandbox.region ? ` · in ${sandbox.region}` : ""
  return `${sandbox.status} · ${sandbox.vcpus} vCPU · ${memory(sandbox.memoryMb)} RAM · ${sandbox.diskGb}G disk · network ${sandbox.network}${sandbox.shareable === false ? " · sharing disabled" : ""} · ${sandbox.expiresAt === null ? "no expiry" : `expires ${relativeTime(sandbox.expiresAt)}`}${where}`
}

export function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
}

/**
 * Prints only the id on stdout, so `id=$(kyora-vms create)` works. With no room on kyora cloud it
 * waits in line up to `wait` seconds; Ctrl-C meanwhile takes it out of line, and a sandbox that
 * arrives after a Ctrl-C is destroyed rather than printed.
 */
export async function create(api: VmsClient, spec: CreateSpec, wait: number, asJson: boolean): Promise<number> {
  const interrupt = new Interrupt()
  try {
    const sandbox = await api.create(spec, { wait, graceMs: timeoutGraceMs(), signal: interrupt.signal, onQueued: queueNotes(wait) })
    if (interrupt.interrupted) {
      await destroyQuietly(api, sandbox.id)
      return interrupt.code!
    }
    if (asJson) printJson(sandbox)
    else {
      console.log(sandbox.id)
      note(`${sandbox.name ? `${sandbox.name} · ` : ""}${sandbox.id} ${describe(sandbox)}`)
      regionNote(sandbox)
    }
    return 0
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    throw error
  } finally {
    interrupt.dispose()
  }
}

export async function list(api: VmsClient, id: string | undefined, asJson: boolean, known?: Sandbox[]): Promise<number> {
  const sandboxes = known ?? (id ? [await api.get(id)] : await api.list())
  if (asJson) {
    printJson(id ? sandboxes[0] : { sandboxes })
    return 0
  }
  if (sandboxes.length === 0) {
    console.log("no sandboxes running")
    return 0
  }
  const regions = sandboxes.some((s) => s.region)
  const ids = shortIds(sandboxes)
  const rows = [["NAME", "ID", "IMAGE", "SIZE", "NET", ...(regions ? ["REGION"] : []), "AGE", "EXPIRES", "IDLE", "SHELLS"]]
  const terminals: Array<Awaited<ReturnType<VmsClient["ttySessions"]>> | null> = new Array(sandboxes.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, sandboxes.length) }, async () => {
    while (next < sandboxes.length) {
      const i = next++
      terminals[i] = await api.ttySessions(sandboxes[i]!.id).catch(() => null)
    }
  }))
  for (const [i, s] of sandboxes.entries()) {
    const sessions = terminals[i]!
    const attached = sessions?.reduce((n, session) => n + session.attached, 0)
    const shells = sessions === null ? "-" : attached ? `${attached} attached` : `${sessions.length} detached`
    const idle = s.idleSeconds === undefined ? "-" : formatMs(s.lastActivityAt ? Math.max(0, Date.parse(s.lastActivityAt) + s.idleSeconds * 1000 - Date.now()) : s.idleSeconds * 1000)
    rows.push([s.name ?? "-", ids[i]!, s.image ?? "default", `${s.vcpus}/${memory(s.memoryMb)}`, s.network, ...(regions ? [s.region ?? "-"] : []), formatMs(Math.max(0, Date.now() - Date.parse(s.createdAt))), s.expiresAt === null ? "no expiry" : relativeTime(s.expiresAt), idle, shells])
  }
  printTable(rows)
  return 0
}

/** a command in a sandbox that stays: given up on at its deadline, it is cancelled and the sandbox left as it is */
export async function exec(api: VmsClient, id: string, request: ExecRequest, asJson: boolean): Promise<number> {
  const interrupt = new Interrupt()
  try {
    const outcome = await runExec(api, id, request, { json: asJson, signal: interrupt.signal, deadline: execDeadline(request) })
    if (outcome.error) note(outcome.error)
    return outcome.code
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    throw error
  } finally {
    interrupt.dispose()
  }
}

export interface PushDirOptions {
  dir: string
  /** false for --no-git */
  git: boolean
  dest: string
  upload: Omit<PushOptions, "signal">
  /** --git, --git-depth, --git-base */
  history?: HistoryOptions | null
  json: boolean
}

export async function pushDir(api: VmsClient, target: string, options: PushDirOptions): Promise<number> {
  const interrupt = new Interrupt()
  let history: History | null = null
  try {
    let listing = await listFiles(options.dir, { git: options.git })
    if (options.history) {
      history = await prepareHistory(options.dir, listing, options.history, interrupt.signal)
      listing = withHistory(listing, history)
    }
    const id = await resolveTarget(api, target)
    const result = await push(api, id, listing, options.dest, { ...options.upload, signal: interrupt.signal })
    if (result.warnings.length > 0) note(`packing: ${summarizeList(result.warnings)}`)
    const gitMs = history ? await installHistory(api, id, history, options.dest, interrupt.signal) : null
    if (options.json) {
      const git = history ? { git: { ...historyEvent(history), durationMs: gitMs } } : {}
      printJson({ ...result.server, sent: result.sent, files: result.listing.mode, rawBytes: result.listing.bytes, ...pushShape(result), ...git })
    } else {
      const entries = result.server.entries ?? result.listing.entries.length
      const parts = result.parts !== undefined && result.parts > 1 ? ` in ${result.parts} parts` : ""
      const over = result.shards > 1 ? ` over ${result.shards} shards` : ""
      const git = history ? ` with git history ${describeHistory(history)}` : ""
      console.log(`uploaded ${entries.toLocaleString("en-US")} entries (${formatBytes(result.sent)} on the wire${parts}${over}, ${formatBytes(result.listing.bytes)} raw) to ${options.dest}${git} in ${formatMs(result.durationMs + (gitMs ?? 0))}`)
    }
    return 0
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    const hint = historyHint(error, history)
    if (hint) note(hint)
    throw error
  } finally {
    await history?.cleanup()
    interrupt.dispose()
  }
}

export async function pullPaths(api: VmsClient, id: string, paths: string[], to: string, asJson: boolean): Promise<number> {
  const interrupt = new Interrupt()
  const results: unknown[] = []
  let code = 0
  try {
    for (const path of paths) {
      try {
        const result = await pull(api, id, path, to, interrupt.signal)
        if (reportPull(result)) code = FAILED
        const ranged = result.ranged ? { ranged: true } : {}
        results.push({ path, to, entries: result.entries, bytes: result.received, written: result.written, refused: result.refused, failed: result.failed, ...ranged })
        if (!asJson) console.log(`pulled ${path} → ${to} (${result.written.length} entries, ${formatBytes(result.received)}) in ${formatMs(result.durationMs)}`)
      } catch (error) {
        if (interrupt.interrupted) return interrupt.code!
        const missing = error instanceof ApiError && error.status === 404
        const reason = missing ? "not found in the sandbox" : error instanceof Error ? error.message : String(error)
        note(`${path}: ${reason}`)
        results.push({ path, error: missing ? "not_found" : reason })
        code = FAILED
      }
    }
  } finally {
    interrupt.dispose()
  }
  if (asJson) printJson({ downloads: results })
  return code
}

export async function remove(api: VmsClient, ids: string[], all: boolean, asJson: boolean, labels: Record<string, string> = {}): Promise<number> {
  const targets = all ? (await api.list()).map((sandbox) => sandbox.id) : ids
  const removed: string[] = []
  const gone: string[] = []
  for (const id of targets) {
    if (await api.destroy(id)) removed.push(id)
    else gone.push(id)
  }
  if (asJson) printJson({ removed, gone })
  else {
    for (const id of removed) console.log(`removed ${labels[id] ?? id}`)
    for (const id of gone) console.log(`${labels[id] ?? id} was already gone`)
    if (targets.length === 0) console.log("no sandboxes to remove")
  }
  return 0
}

/** reachability plus whether the key works, never the key itself */
export async function health(api: VmsClient, config: Config, asJson: boolean): Promise<number> {
  const status = await api.health()
  if ((await api.kind()) === "platform") return cloudHealth(api, config, status, asJson)
  let key: { source: string | null; accepted: boolean | null; sandboxes?: number; error?: string } = { source: config.keySource, accepted: null }
  if (config.key) {
    try {
      key = { ...key, accepted: true, sandboxes: (await api.list()).length }
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error
      key = { ...key, accepted: false, error: error.message }
    }
  }
  const ready = status.ok && key.accepted === true
  if (asJson) {
    printJson({ ...status, url: config.url, key })
    return ready ? 0 : FAILED
  }
  const capacity = status.capacity
  console.log(`${status.ok ? "ok" : "not ok"} · ${config.url} · server ${status.version ?? "?"}`)
  if (capacity) console.log(`capacity: ${capacity.vcpusFree ?? "?"} vCPU, ${capacity.memoryMbFree !== undefined ? memory(capacity.memoryMbFree) : "?"} RAM free`)
  if (!config.key) console.log("key: not set (KYORA_VMS_KEY or ~/.config/kyora-vms/env)")
  else if (key.accepted) console.log(`key: accepted (from ${key.source}), ${key.sandboxes} sandbox${key.sandboxes === 1 ? "" : "es"} running`)
  else console.log(`key: rejected (from ${key.source}): ${key.error}`)
  return ready ? 0 : FAILED
}

/** kyora cloud's health: its machines, and whose token this is */
async function cloudHealth(api: VmsClient, config: Config, status: Health, asJson: boolean): Promise<number> {
  let token: { source: string | null; accepted: boolean | null; login?: string; sandboxes?: number; error?: string } = { source: config.keySource, accepted: null }
  if (config.key) {
    try {
      const me = await api.me()
      token = { ...token, accepted: true, login: me.login, sandboxes: (await api.list()).length }
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error
      token = { ...token, accepted: false, error: error.message }
    }
  }
  const ready = status.ok && token.accepted === true
  if (asJson) {
    printJson({ ...status, url: config.url, key: token })
    return ready ? 0 : FAILED
  }
  const capacity = status.capacity
  console.log(`${status.ok ? "ok" : "not ok"} · ${config.url} · kyora cloud`)
  if (capacity) console.log(`capacity: ${capacity.vcpusFree ?? "?"} vCPU, ${capacity.memoryMbFree !== undefined ? memory(capacity.memoryMbFree) : "?"} RAM free`)
  if (!config.key) console.log("token: not logged in (`kyora-vms login`)")
  else if (token.accepted) console.log(`token: accepted (from ${token.source}) as ${token.login}, ${token.sandboxes} sandbox${token.sandboxes === 1 ? "" : "es"} running`)
  else console.log(`token: rejected (from ${token.source}): ${token.error}`)
  return ready ? 0 : FAILED
}

/** a machine not heard from for this long is gone (kyora cloud's heartbeats come every 15 s) */
const MACHINE_SILENT_MS = 45_000

/**
 * kyora cloud's `connected` means "takes sandboxes", so a draining machine comes as
 * `connected: false, draining: true` whether or not it is still there; its last heartbeat
 * (`lastSeenAt`, which the admin view carries along with `draining`) tells which.
 */
function machineStatus(node: NodeInfo, now = Date.now()): string {
  if (!node.draining) return node.connected ? "connected" : "offline"
  const seen = node.lastSeenAt ? Date.parse(node.lastSeenAt) : Number.NaN
  return node.connected || now - seen < MACHINE_SILENT_MS ? "draining" : "offline"
}

/** kyora cloud's machines and what is free on them; admins also see sizes, versions and load */
export async function nodes(api: VmsClient, asJson: boolean): Promise<number> {
  if ((await api.kind()) !== "platform") {
    throw new Error(`${api.url} does not support nodes. Run \`kyora-vms health\` to check capacity`)
  }
  const machines = await api.nodes()
  if (asJson) {
    printJson({ nodes: machines })
    return 0
  }
  if (machines.length === 0) {
    console.log("no machines yet; an admin adds them on the dashboard")
    return 0
  }
  const admin = machines.some((node) => node.capacity !== undefined)
  const regional = machines.some((node) => node.region !== undefined)
  const of = (free: number | null | undefined, total: number | null | undefined, format: (n: number) => string) => {
    if (free === undefined || free === null) return "-"
    return admin && total !== undefined && total !== null ? `${format(free)}/${format(total)}` : format(free)
  }
  const rows = [
    ["NAME", ...(regional ? ["REGION"] : []), "STATUS", "VCPU FREE", "MEM FREE", "DISK FREE", ...(admin ? ["SANDBOXES", "VERSION", "SEEN"] : [])],
    ...machines.map((node) => [
      node.name,
      ...(regional ? [node.region ?? "-"] : []),
      machineStatus(node),
      of(node.free?.vcpus, node.capacity?.vcpus, String),
      of(node.free?.memoryMb, node.capacity?.memoryMb, memory),
      of(node.free?.diskGb, node.capacity?.diskGb, (gb) => `${gb}G`),
      ...(admin ? [String(node.running ?? "-"), node.version ?? "-", relativeTime(node.lastSeenAt ?? undefined)] : []),
    ]),
  ]
  printTable(rows)
  const taking = machines.filter((node) => node.connected && !node.draining)
  const vcpus = taking.reduce((sum, node) => sum + (node.free?.vcpus ?? 0), 0)
  const memoryMb = taking.reduce((sum, node) => sum + (node.free?.memoryMb ?? 0), 0)
  console.log(`${taking.length} of ${machines.length} taking sandboxes · ${vcpus} vCPU, ${memory(memoryMb)} RAM free`)
  return 0
}
