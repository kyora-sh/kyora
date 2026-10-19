import { ApiError } from "./api"
import { formatMs } from "./units"

/** exit code for kyora's own failures, kept apart from the remote command's codes (like `docker run`) */
export const FAILED = 125
/** The requested image is unavailable on the reachable fleet. */
export const IMAGE_UNAVAILABLE = 123
export const failureCode = (error: unknown): number => error instanceof ApiError && error.code === "image_unavailable" ? IMAGE_UNAVAILABLE : FAILED

export function note(message: string): void {
  process.stderr.write(`[kyora-vms] ${message}\n`)
}

/** `[kyora-vms] queued: 3 ahead…` each time a create's place in line changes; the first line says how long it may wait */
export function queueNotes(waitSeconds: number): (ticket: { ahead: number }) => void {
  let last: number | null = null
  return (ticket) => {
    if (ticket.ahead === last) return
    const place = ticket.ahead === 0 ? "next in line" : `${ticket.ahead} ahead`
    note(last === null ? `no machine has room right now; queued: ${place}… (waiting up to ${formatMs(waitSeconds * 1000)}; --no-wait fails at once instead)` : `queued: ${place}…`)
    last = ticket.ahead
  }
}

/** a create that found no room in the region it asked for, and runs in the next one */
export function regionNote(sandbox: { id: string; region?: string; requestedRegion?: string }): void {
  if (sandbox.region && sandbox.requestedRegion && sandbox.region !== sandbox.requestedRegion) {
    note(`no machine in ${sandbox.requestedRegion} had room; ${sandbox.id} runs in ${sandbox.region} (--region ${sandbox.requestedRegion} keeps a create there)`)
  }
}

// a closed pipe (`kyora vms run … | head`) must not kill us before the sandbox is destroyed
process.stdout.on("error", () => {})
process.stderr.on("error", () => {})

/** resolves once the bytes are handed off, so a fast remote cannot outrun a slow terminal */
export function write(stream: NodeJS.WriteStream, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write(data, () => resolve())
    } catch {
      resolve()
    }
  })
}

export const json = (value: unknown) => write(process.stdout, `${JSON.stringify(value)}\n`)

/** one pretty-printed document, for the commands that are not event streams */
export const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2))

/** keeps `[kyora-vms] warning` output to a handful of lines on a noisy pack or extract */
export function summarizeList(items: string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ")
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown
}

/**
 * process.exit drops what a pipe has not taken yet, and an empty write's callback does not wait for it under Bun, so the streams
 * are ended first; a reader that never drains them gets at most `waitMs`
 */
export async function exitFlushed(code: number, waitMs = 10_000): Promise<never> {
  const ended = (stream: NodeJS.WriteStream) =>
    new Promise<void>((resolve) => {
      try {
        stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all([ended(process.stdout), ended(process.stderr)]), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
  clearTimeout(timer)
  process.exit(code)
}
