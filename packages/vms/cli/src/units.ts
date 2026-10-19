const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i
const SIZE_UNITS: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/**
 * `8G`, `512M`, `1.5GiB`. A bare number is GiB: nobody sizes a build VM in bytes,
 * and `--memory 8` meaning 8 MB would boot a VM that cannot run anything.
 */
export function parseSize(text: string, flag: string): number {
  const match = SIZE.exec(text.trim())
  if (!match) throw new Error(`${flag} ${JSON.stringify(text)} is not a size like 8G or 512M`)
  const unit = match[2]!.toLowerCase()
  const bytes = Number(match[1]) * (unit === "" ? 1024 ** 3 : SIZE_UNITS[unit]!)
  if (!(bytes > 0)) throw new Error(`${flag} must be more than zero`)
  return bytes
}

export const memoryMb = (text: string) => Math.round(parseSize(text, "--memory") / 1024 ** 2)
export const diskGb = (text: string) => Math.ceil(parseSize(text, "--disk") / 1024 ** 3)

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
const DURATION_UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }

/** `90s`, `30m`, `1h30m`; a bare number is seconds. Whole seconds out, at least one. */
export function parseSeconds(text: string, flag: string): number {
  const trimmed = text.trim()
  let seconds: number
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) seconds = Number(trimmed)
  else {
    seconds = 0
    let consumed = ""
    for (const match of trimmed.matchAll(DURATION_PART)) {
      seconds += Number(match[1]) * DURATION_UNITS[match[2]!]!
      consumed += match[0]
    }
    if (consumed !== trimmed || consumed === "") {
      throw new Error(`${flag} ${JSON.stringify(text)} is not a duration like 90s, 30m or 1h30m`)
    }
  }
  if (!(seconds > 0)) throw new Error(`${flag} must be more than zero`)
  return Math.max(1, Math.ceil(seconds))
}

export function positiveInt(text: string, flag: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a whole number above zero`)
  return value
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  // compare what will be printed, so 1023.97 KB reads 1.0 MB rather than 1024 KB
  while (Number(value.toFixed(1)) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 99.95 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** rounds once, up front, so a boundary never prints as 1000ms, 60.0s or 1m60s */
export function formatMs(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** "in 52m" / "3m ago" for timestamps from the API */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-"
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return "-"
  const ms = at - now
  const minutes = Math.round(Math.abs(ms) / 60_000)
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`
  return ms >= 0 ? `in ${span}` : `${span} ago`
}
