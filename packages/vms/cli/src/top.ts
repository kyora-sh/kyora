import { emitKeypressEvents } from "node:readline"
import { parseArgs } from "node:util"
import { VmsClient } from "./api"
import { loadConfig } from "./config"
import { renderTop, SORTS, updateState, visibleRows, type TopState } from "./top-view"
import type { SandboxStatsResponse } from "./stats-types"

export const TOP_HELP = `kyora top [--interval SECONDS] [--region ID] [--once] [--json]

Your running VMs and their latest usage. Refreshes every 2 seconds by default (minimum 2 seconds).
The node reports about every 15 seconds. MEM is guest used memory (MemTotal - MemAvailable) against allocated RAM.
DISK is guest filesystem used/total. A trailing ~ marks the host fallback:
MEM is the resident interval average; DISK is allocated backing-file blocks.
q quit, up/down select, Enter details, s sort, / filter name, r cycle regions.
--once samples until every vm has a fresh report (up to 20 seconds) and prints a plain table. --json prints computed rows.
Piped output uses --once. Rates are unknown until the node reports a new sample.`

/** How long --once waits for every vm's next report, at most. */
export const ONCE_WAIT_SECONDS = 20

export interface TopOptions { interval: number; region?: string; once?: boolean; json?: boolean; onceWaitSeconds?: number }
interface StatsClient { stats(signal?: AbortSignal): Promise<SandboxStatsResponse> }
export const initialState = (region?: string): TopState => ({ account: "loading", rows: [], history: {}, sort: "cpu", filter: "", region: region ?? null, selected: null, detail: false, editing: false, now: Date.now() })

export function parseTopOptions(args: string[]): TopOptions | null {
  const { values, positionals } = parseArgs({ args, options: { interval: { type: "string" }, region: { type: "string" }, once: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: true })
  if (values.help) return null
  if (positionals.length) throw new Error("top takes no positional arguments")
  const interval = values.interval === undefined ? 2 : Number(values.interval)
  if (!Number.isFinite(interval) || interval < 2 || interval > 3600) throw new Error("--interval takes seconds from 2 to 3600")
  return { interval, region: values.region, once: values.once, json: values.json }
}

export function handleKey(state: TopState, key: string): TopState {
  if (state.editing) {
    if (key === "enter") return { ...state, editing: false }
    if (key === "escape") return { ...state, editing: false, filter: "" }
    if (key === "backspace") return { ...state, filter: state.filter.slice(0, -1), selected: null }
    if (/^[\x20-\x7e]$/.test(key)) return { ...state, filter: (state.filter + key).slice(0, 64), selected: null }
    return state
  }
  const rows = visibleRows(state)
  const index = Math.max(0, rows.findIndex((row) => row.id === state.selected))
  if (key === "up" || key === "down") return { ...state, selected: rows[Math.max(0, Math.min(rows.length - 1, index + (key === "up" ? -1 : 1)))]?.id ?? null }
  if (key === "enter") return { ...state, selected: rows[index]?.id ?? null, detail: !state.detail }
  if (key === "/") return { ...state, editing: true }
  if (key === "s") return { ...state, sort: SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length]! }
  if (key === "r") {
    const regions: Array<string | null> = [null, ...new Set(state.rows.map((row) => row.region).filter(Boolean).sort())]
    return { ...state, region: regions[(regions.indexOf(state.region) + 1) % regions.length]!, selected: null }
  }
  return state
}

export async function top(client: StatsClient, options: TopOptions, terminal = { input: process.stdin, output: process.stdout, signals: process }): Promise<number> {
  const { input, output, signals } = terminal
  const interactive = Boolean(output.isTTY && input.isTTY && !options.once && !options.json)
  let state = initialState(options.region)
  let stopped = false
  let stop!: () => void
  const finished = new Promise<void>((resolve) => { stop = () => { stopped = true; resolve() } })
  let streamError: Error | undefined
  const fail = (error: Error) => { streamError = error; stop() }
  const cancelled = finished.then(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = async (ms = options.interval * 1000) => { await Promise.race([finished, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })]); clearTimeout(timer) }
  const draw = () => {
    const shown = visibleRows(state)
    if (!shown.some((row) => row.id === state.selected)) state = { ...state, selected: shown[0]?.id ?? null }
    state = { ...state, now: Date.now() }
    output.write(`\x1b[H\x1b[2J${renderTop(state, output.columns || 80, output.rows || 24, true, process.env.NO_COLOR === undefined)}`)
  }
  const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    if (key?.ctrl && key.name === "c" || !state.editing && text === "q") { stop(); return }
    state = handleKey(state, key?.name === "return" ? "enter" : ["up", "down", "backspace", "escape"].includes(key?.name ?? "") ? key.name! : text ?? "")
    draw()
  }
  const wasRaw = input.isRaw
  const wasPaused = input.isPaused()
  let entered = false
  input.on("error", fail)
  input.on("close", stop)
  output.on("error", fail)
  output.on("close", stop)
  signals.on("SIGINT", stop)
  signals.on("SIGTERM", stop)
  try {
    if (interactive) {
      entered = true
      output.write("\x1b[?1049h\x1b[?25l")
      input.setRawMode(true)
      emitKeypressEvents(input)
      input.on("keypress", keypress)
      input.on("end", stop)
      input.resume()
      signals.on("SIGWINCH", draw)
      draw()
    }
    const poll = async (signal?: AbortSignal) => {
      const response = await Promise.race([client.stats(signal), cancelled])
      if (response && !stopped) state = updateState(state, response)
    }
    await poll()
    if (interactive) {
      if (!stopped) draw()
      while (!stopped) {
        await wait()
        if (stopped) break
        await poll()
        if (!stopped) draw()
      }
    } else {
      // a node reports about every 15 seconds: keep sampling until each vm has a newer sample, or the time is up
      const first = new Map(state.rows.map((row) => [row.id, row.sample?.sampledAt ?? null]))
      const deadline = Date.now() + Math.max(options.interval, options.onceWaitSeconds ?? ONCE_WAIT_SECONDS) * 1000
      const stale = () => state.rows.some((row) => {
        const before = first.get(row.id)
        return row.sample !== null && before !== undefined && before !== null && row.sample.sampledAt <= before
      })
      do {
        const left = deadline - Date.now()
        if (left <= 0) break
        if (!stopped) await wait(Math.min(options.interval * 1000, left))
        // a stats request still pending at the deadline is cancelled: the table prints what came before it
        if (!stopped) {
          const expiry = new AbortController()
          const cutoff = setTimeout(() => expiry.abort(new Error("top --once deadline")), Math.max(0, deadline - Date.now()))
          try { await Promise.race([poll(expiry.signal), new Promise<void>((resolve) => expiry.signal.addEventListener("abort", () => resolve(), { once: true }))]) }
          catch (error) { if (!expiry.signal.aborted) throw error }
          finally { clearTimeout(cutoff) }
        }
      } while (!stopped && Date.now() < deadline && stale())
      if (!stopped) output.write(options.json ? `${JSON.stringify(visibleRows(state), null, 2)}\n` : `${renderTop(state, output.isTTY ? output.columns || 160 : 160, state.rows.length + 3)}\n`)
    }
    if (streamError) throw streamError
    return 0
  } finally {
    clearTimeout(timer)
    signals.removeListener("SIGINT", stop)
    signals.removeListener("SIGTERM", stop)
    try {
      if (entered) {
        signals.removeListener("SIGWINCH", draw)
        input.removeListener("keypress", keypress)
        input.removeListener("end", stop)
        try { input.setRawMode(Boolean(wasRaw)) } finally {
          if (wasPaused) input.pause()
          try { output.write("\x1b[0m\x1b[?25h\x1b[?1049l") } catch {}
        }
      }
    } finally {
      input.removeListener("error", fail)
      input.removeListener("close", stop)
      output.removeListener("error", fail)
      output.removeListener("close", stop)
    }
  }
}

export async function topCommand(args: string[]): Promise<number> {
  const options = parseTopOptions(args)
  if (!options) { console.log(TOP_HELP); return 0 }
  return top(new VmsClient(await loadConfig()), options)
}
