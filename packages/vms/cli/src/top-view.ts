import type { MeterCounter } from "../../shared/metering"
import type { SandboxSample, SandboxStats, SandboxStatsResponse } from "./stats-types"

export type Sort = "cpu" | "memory" | "name" | "net"
export const SORTS: Sort[] = ["cpu", "memory", "name", "net"]
export interface UsageRow extends SandboxStats {
  cpuPercent: number | null
  memoryUsedMb: number | null
  netRxPerSecond: number | null
  netTxPerSecond: number | null
}
export interface HistoryPoint {
  cpu: number | null
  memory: number | null
  rx: number | null
  tx: number | null
}
export interface TopState {
  account: string
  rows: UsageRow[]
  history: Record<string, HistoryPoint[]>
  sort: Sort
  filter: string
  region: string | null
  selected: string | null
  detail: boolean
  editing: boolean
  now: number
}

const growth = (after: number | null, before: number | null, seconds: number): number | null =>
  after !== null && before !== null && after >= before && seconds > 0 ? (after - before) / seconds : null

export function computeRow(vm: SandboxStats, previous?: SandboxStats): UsageRow {
  const a = vm.sample
  const b = previous?.sample
  const same = a && b && a.startedAt === b.startedAt && a.lifetime === b.lifetime && a.generation === b.generation && a.resets === b.resets
  const ordered = same && (a.sequence !== null && b.sequence !== null ? a.sequence > b.sequence : a.sampledAt > b.sampledAt)
  const seconds = ordered ? (a.wallSeconds !== null && b.wallSeconds !== null ? a.wallSeconds - b.wallSeconds : (a.sampledAt - b.sampledAt) / 1000) : 0
  const rate = (counter: MeterCounter) => same && a.verifiedAt?.[counter] != null && b.verifiedAt?.[counter] != null && a.gaps?.[counter] != null && a.gaps[counter] === b.gaps?.[counter] ? growth(a[counter], b[counter], seconds) : null
  const cpu = rate("cpuUsec")
  // memMbSeconds integrates only measured time: divide by the interval less the gap that grew in it
  const gapSeconds = a && b && a.memoryGapMs !== null && b.memoryGapMs !== null && a.memoryGapMs >= b.memoryGapMs ? (a.memoryGapMs - b.memoryGapMs) / 1000 : null
  const memory = same && gapSeconds !== null && gapSeconds < seconds && a.verifiedAt?.memMbSeconds != null && b.verifiedAt?.memMbSeconds != null && a.gaps?.memMbSeconds != null && a.gaps.memMbSeconds === b.gaps?.memMbSeconds
    ? growth(a.memMbSeconds, b.memMbSeconds, seconds - gapSeconds) : null
  return { ...vm,
    cpuPercent: cpu === null || vm.vcpus <= 0 ? null : cpu / (vm.vcpus * 1e6) * 100,
    memoryUsedMb: a?.guest?.memUsedMb ?? memory,
    netRxPerSecond: rate("netRxBytes"),
    netTxPerSecond: rate("netTxBytes"),
  }
}

export function updateState(state: TopState, response: SandboxStatsResponse): TopState {
  const previous = new Map(state.rows.map((row) => [row.id, row]))
  const history: TopState["history"] = {}
  const rows = response.sandboxes.map((vm) => {
    const old = previous.get(vm.id)
    const duplicate = vm.sample && old?.sample && vm.sample.sampledAt === old.sample.sampledAt && vm.sample.sequence === old.sample.sequence && vm.sample.startedAt === old.sample.startedAt && vm.sample.lifetime === old.sample.lifetime && vm.sample.generation === old.sample.generation && vm.sample.resets === old.sample.resets
    const row = duplicate ? { ...old, ...vm, memoryUsedMb: vm.sample?.guest?.memUsedMb ?? (old.sample?.guest?.memUsedMb !== undefined ? null : old.memoryUsedMb) } : computeRow(vm, old)
    const points = state.history[vm.id] ?? []
    history[vm.id] = duplicate || !vm.sample ? points : [...points, { cpu: row.cpuPercent, memory: row.memoryUsedMb, rx: row.netRxPerSecond, tx: row.netTxPerSecond }].slice(-180)
    return row
  })
  const next = { ...state, account: response.account, rows, history, now: response.at }
  const visible = visibleRows(next)
  return { ...next, selected: visible.some((row) => row.id === state.selected) ? state.selected : visible[0]?.id ?? null }
}

export function sortRows(rows: UsageRow[], sort: Sort): UsageRow[] {
  const value = (row: UsageRow) => sort === "cpu" ? row.cpuPercent : sort === "memory" ? row.memoryUsedMb : row.netRxPerSecond === null && row.netTxPerSecond === null ? null : (row.netRxPerSecond ?? 0) + (row.netTxPerSecond ?? 0)
  return [...rows].sort((a, b) => (sort === "name" ? 0 : (value(b) ?? -1) - (value(a) ?? -1)) || (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id))
}

export function visibleRows(state: TopState): UsageRow[] {
  return sortRows(state.rows.filter((row) => (!state.region || row.region === state.region) && (row.name ?? row.id).toLowerCase().includes(state.filter.toLowerCase())), state.sort)
}

const bounded = (value: number, max: number) => Math.max(0, Math.min(1, value / Math.max(1, max)))
export function sparkline(values: Array<number | null>, width: number, max = 100): string {
  if (width <= 0) return ""
  const blocks = "▁▂▃▄▅▆▇█"
  return values.slice(-Math.max(0, width)).map((value) => value === null ? " " : blocks[Math.min(7, Math.floor(bounded(value, max) * 7))]!).join("").padStart(Math.max(0, width), " ")
}
export function bar(value: number | null, max: number, width: number): string {
  const size = Math.max(0, width)
  const used = value === null ? 0 : Math.round(bounded(value, max) * size)
  return "█".repeat(used) + "░".repeat(size - used)
}

/** Printable single-cell text for labels supplied by the API or keyboard. */
export const label = (value: string): string => value.replace(/[^\x20-\x7e]/g, "?")
export function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const chars = Array.from(value)
  return chars.length <= width ? value : chars.slice(0, width - 1).join("") + "…"
}

export function bytes(value: number | null): string {
  if (value === null) return "?"
  const units = ["B", "K", "M", "G", "T"]
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`
}
const memory = (mb: number | null) => bytes(mb === null ? null : mb * 2 ** 20)
const percent = (value: number | null) => value === null ? "?" : `${value.toFixed(1)}%`
export const uptime = (sample: SandboxSample | null): string => {
  const started = sample ? Date.parse(sample.startedAt) : NaN
  if (!sample || !Number.isFinite(started) || sample.receivedAt < started) return "?"
  const seconds = (sample.receivedAt - started) / 1000
  return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`
}

/** How fresh the table is: the newest report any vm's node sent, once for the whole table. */
export function updated(rows: UsageRow[], now: number): string {
  const newest = Math.max(...rows.map((row) => row.sample?.sampledAt ?? -Infinity))
  return Number.isFinite(newest) ? `updated ${Math.max(0, Math.floor((now - newest) / 1000))}s ago` : "waiting for reports"
}

export function graph(values: Array<number | null>, width: number, height: number, max: number): string[] {
  const points = values.slice(-width)
  return Array.from({ length: height }, (_, y) => points.map((value) => value === null ? " " : bounded(value, max) * height >= height - y ? "█" : " ").join("").padStart(width, " "))
}

export function renderTop(state: TopState, width: number, height: number, interactive = false, color = false): string {
  width = Math.max(1, Math.floor(width))
  height = Math.max(1, Math.floor(height))
  const rows = visibleRows(state)
  const cpus = rows.reduce((sum, row) => sum + row.vcpus, 0)
  const mem = rows.reduce((sum, row) => sum + row.memoryMb, 0)
  const lines = [`kyora top | ${label(state.account)} | region ${label(state.region ?? "all")} | ${rows.length} VMs | ${cpus} vCPUs | ${memory(mem)} RAM | ${updated(rows, state.now)}`]
  const wide = width >= 125
  const medium = width >= 100
  const compact = width >= 75
  const nameWidth = wide ? 18 : medium ? 14 : compact ? 10 : 12
  const cell = (text: string, size: number) => truncate(text, size).padEnd(size)
  const usageCell = (text: string, size: number, fallback: boolean) => truncate(text, size - (fallback ? 1 : 0)) + (fallback ? "~" : "")
  const cpuWidth = wide ? 20 : medium ? 17 : 14
  const memoryWidth = wide ? 19 : medium ? 17 : 13
  const columns: Array<{ title: string; width: number; value: (row: UsageRow) => string }> = [
    { title: "NAME", width: nameWidth + 2, value: (row) => `${interactive && row.id === state.selected ? ">" : " "} ${label(row.name ?? row.id)}` },
  ]
  if (compact) columns.push({ title: "REGION", width: wide ? 7 : medium ? 5 : 4, value: (row) => label(row.region) })
  if (medium) columns.push({ title: "SIZE", width: wide ? 9 : 8, value: (row) => `${row.vcpus}c/${memory(row.memoryMb)}` })
  columns.push({ title: compact ? "CPU / HISTORY" : "CPU", width: compact ? cpuWidth : 7, value: (row) => compact ? `${bar(row.cpuPercent, 100, wide ? 6 : medium ? 4 : 3)} ${cell(percent(row.cpuPercent), compact && !medium ? 6 : 7)}${sparkline((state.history[row.id] ?? []).map((p) => p.cpu), wide ? 6 : medium ? 5 : 4)}` : percent(row.cpuPercent) })
  columns.push({ title: "MEM", width: compact ? memoryWidth : 11, value: (row) => usageCell(`${compact ? `${bar(row.memoryUsedMb, row.memoryMb, wide ? 5 : medium ? 3 : 2)} ` : ""}${memory(row.memoryUsedMb)}/${memory(row.memoryMb)}`, compact ? memoryWidth : 11, row.sample?.guest?.memUsedMb === undefined) })
  const diskWidth = wide ? 11 : medium ? 10 : 9
  if (compact) columns.push({ title: "DISK", width: diskWidth, value: (row) => {
    const guest = row.sample?.guest
    const disk = `${bytes(guest?.diskUsedBytes ?? row.sample?.diskUsedBytes ?? null)}/${bytes(guest?.diskTotalBytes ?? row.diskGb * 2 ** 30)}`
    return usageCell(disk, diskWidth, guest?.diskUsedBytes === undefined)
  } })
  for (const direction of ["RX", "TX"] as const) columns.push({ title: `${direction}/s`, width: wide ? 7 : medium ? 6 : compact ? 5 : 7, value: (row) => bytes(direction === "RX" ? row.netRxPerSecond : row.netTxPerSecond) })
  if (compact) columns.push({ title: "UPTIME", width: wide ? 7 : medium ? 6 : 5, value: (row) => uptime(row.sample) })
  lines.push(columns.map((column) => cell(column.title, column.width)).join(" "))
  const detailRows = interactive && state.detail && state.selected && height >= 18 ? 14 : 0
  const room = Math.max(0, height - 2 - (interactive ? 1 : 0) - detailRows)
  const index = rows.findIndex((row) => row.id === state.selected)
  const start = interactive ? Math.max(0, index - room + 1) : 0
  for (const row of rows.slice(start, start + room)) {
    const selected = interactive && row.id === state.selected
    const line = truncate(columns.map((column) => cell(column.value(row), column.width)).join(" "), width)
    lines.push(selected && color ? `\x1b[7m${line}\x1b[0m` : line)
  }
  if (!rows.length && room > 0) lines.push("No running VMs match the filters.")
  if (detailRows) {
    const row = rows.find((row) => row.id === state.selected)
    if (row) {
      const points = state.history[row.id] ?? []
      const graphWidth = Math.max(1, width - 2)
      lines.push(`${label(row.name ?? row.id)} | ${label(row.id)} | ${uptime(row.sample)} | ${row.sample?.guest?.memUsedMb !== undefined ? "memory: guest used" : "memory~: host interval average"}${row.sample?.guest?.memTotalMb !== undefined ? ` (${memory(row.sample.guest.memTotalMb)} guest total)` : ""}`)
      lines.push(`disk${row.sample?.guest?.diskUsedBytes !== undefined ? "" : "~"}: ${bytes(row.sample?.guest?.diskUsedBytes ?? row.sample?.diskUsedBytes ?? null)}/${bytes(row.sample?.guest?.diskTotalBytes ?? row.diskGb * 2 ** 30)} (${row.sample?.guest?.diskUsedBytes !== undefined ? "guest filesystems" : "host backing file"})`)
      for (const [title, values, max] of [
        ["CPU", points.map((p) => p.cpu), 100],
        ["Memory", points.map((p) => p.memory), row.memoryMb],
        ["Net RX", points.map((p) => p.rx), Math.max(1, ...points.map((p) => p.rx ?? 0))],
        ["Net TX", points.map((p) => p.tx), Math.max(1, ...points.map((p) => p.tx ?? 0))],
      ] as const) {
        lines.push(`${title} (${title.startsWith("Net") ? `${bytes(max)}/s` : title === "CPU" ? "100%" : memory(max)})`)
        lines.push(...graph([...values], graphWidth, 2, max))
      }
    }
  }
  if (interactive) lines.push(state.editing ? `Filter: /${label(state.filter)} (Enter apply, Esc clear)` : `q quit | ↑↓ select | Enter detail | s sort:${state.sort} | / name | r region | ~ host fallback | heartbeat ~15s`)
  return lines.slice(0, height).map((line) => line.includes("\x1b") ? line : truncate(line, width)).join(interactive ? "\r\n" : "\n")
}
