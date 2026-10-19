import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

export class LockUnavailable extends Error {}

/** a CLI held the lock on its own login store past the wait: it may be renewing or rewriting that login right now */
export class LoginLockBusy extends Error {}

let flockSymbol: ((fd: number, operation: number) => number) | undefined

function flock(fd: number, operation: number): number {
  if (!flockSymbol) {
    const libraries = ["libSystem.B.dylib", "libc.so.6", "libc.so"]
    if (process.platform !== "darwin") libraries.push(libraries.shift()!)
    for (const library of libraries) {
      try {
        flockSymbol = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock
        break
      } catch {}
    }
    if (!flockSymbol) throw new LockUnavailable("kyora-switch cannot take file locks on this platform")
  }
  return flockSymbol(fd, operation)
}

/** ` (pid N)` for the process a lock file's stamp names, else nothing */
function holderOf(path: string): string {
  try {
    const pid = readFileSync(path, "utf8").trim().split(":")[0]
    return pid && /^\d+$/.test(pid) ? ` (pid ${pid})` : ""
  } catch {
    return ""
  }
}

/**
 * Takes an exclusive flock on `path` as grok takes its own: flock, check the file was not replaced
 * meanwhile, stamp `pid:unix seconds`. Each call opens its own descriptor, so two callers in one
 * process exclude each other too. `busy` makes the error once `timeoutMs` passes. The directory
 * must exist.
 */
export async function acquireLock(path: string, timeoutMs: number, busy: (holder: string) => Error): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)
    let held = false
    try {
      held = flock(fd, LOCK_EX | LOCK_NB) === 0
      const current = held ? statSync(path, { throwIfNoEntry: false }) : undefined
      const mine = fstatSync(fd)
      if (current && current.ino === mine.ino && current.dev === mine.dev) {
        ftruncateSync(fd, 0)
        writeSync(fd, `${process.pid}:${Math.floor(Date.now() / 1000)}`, 0)
        return fd
      }
    } catch (error) {
      if (held) flock(fd, LOCK_UN)
      closeSync(fd)
      throw error
    }
    if (held) flock(fd, LOCK_UN)
    closeSync(fd)
    if (Date.now() >= deadline) throw busy(holderOf(path))
    await Bun.sleep(50)
  }
}

export function releaseLock(fd: number): void {
  flock(fd, LOCK_UN)
  closeSync(fd)
}
