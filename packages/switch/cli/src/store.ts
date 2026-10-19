import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { readJsonIfExists, readTextIfExists, writeFileAtomic } from "./fsx"
import { acquireLock, LockUnavailable, releaseLock } from "./lock"
import { isPrivate, type Identity, type ProviderId, type Snapshot } from "./types"

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const META_FILE = "slot.json"
const MAX_BACKUPS = 10

/**
 * `kyora session creds sync` (the kyora CLI) uploaded this slot to kyora cloud, whose model broker
 * now refreshes its login: the slot's refresh token is the broker's to spend. `kyora session creds
 * return` hands it back and removes the marker. Written by the vms CLI as an object; any truthy
 * value counts.
 */
export type CloudOwned = { at?: number; by?: string; fingerprint?: string } | true

export interface Slot {
  name: string
  provider: ProviderId
  identity: Identity
  createdAt: number
  updatedAt: number
  /** present only on slots kyora cloud's broker owns (see CloudOwned) */
  cloudOwned?: CloudOwned
  /**
   * the fingerprint (sync.ts) of the login last written here while it was the live one (save, load,
   * the live-login sync): while the slot still holds it, what it holds is the live login's own past
   */
  live?: string
  /** the fingerprint of the grant a renewal written here spent: a live login still holding it is older than this slot */
  renewedFrom?: string
}

export function isCloudOwned(slot: Pick<Slot, "cloudOwned"> | null | undefined): boolean {
  return Boolean(slot?.cloudOwned)
}

function cloudOwnedOf(value: unknown): CloudOwned | undefined {
  if (!value) return undefined
  if (typeof value !== "object" || Array.isArray(value)) return true
  const marker = value as Record<string, unknown>
  return {
    ...(typeof marker.at === "number" ? { at: marker.at } : {}),
    ...(typeof marker.by === "string" ? { by: marker.by } : {}),
    ...(typeof marker.fingerprint === "string" ? { fingerprint: marker.fingerprint } : {}),
  }
}

export function rootDir(): string {
  return process.env.KYORA_SWITCH_DIR ?? join(homedir(), ".kyora", "switch")
}

const SETTINGS_FILE = "settings.json"

export interface Settings {
  private?: boolean
}

/** ~/.kyora/switch/settings.json; none means every default */
export async function readSettings(): Promise<Settings> {
  const path = join(rootDir(), SETTINGS_FILE)
  if ((await stat(path).catch(() => null))?.isDirectory()) throw new Error(`${path} is a directory`)
  const settings = await readJsonIfExists(path)
  return settings ? { ...(typeof settings.private === "boolean" ? { private: settings.private } : {}) } : {}
}

export async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(rootDir(), { recursive: true, mode: 0o700 })
  const path = join(rootDir(), SETTINGS_FILE)
  // an empty directory in its place is replaced; one with files in it is never deleted from here
  if ((await stat(path).catch(() => null))?.isDirectory()) {
    await rmdir(path).catch(() => {
      throw new Error(`${path} is a directory with files in it: move it away, then run this again`)
    })
  }
  await writeFileAtomic(join(rootDir(), SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, 0o600)
}

export function slotDir(provider: ProviderId, name: string): string {
  return join(rootDir(), provider, assertName(name))
}

/** Slot names become path segments, so they are held to a strict alphabet. */
export function assertName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    // private mode never echoes it: a rejected name is often an email
    throw new Error(`invalid slot name${isPrivate() ? "" : ` "${name}"`}: use letters, digits, dot, dash or underscore`)
  }
  return name
}

export async function listSlots(provider: ProviderId): Promise<Slot[]> {
  let names: string[]
  try {
    names = await readdir(join(rootDir(), provider))
  } catch {
    return []
  }
  const slots: Slot[] = []
  for (const name of names.sort()) {
    if (!NAME_PATTERN.test(name)) continue
    const slot = await readSlot(provider, name)
    if (slot) slots.push(slot)
  }
  return slots
}

export async function readSlot(provider: ProviderId, name: string): Promise<Slot | null> {
  const meta = await readJsonIfExists(join(slotDir(provider, name), META_FILE))
  if (!meta) return null
  const cloudOwned = cloudOwnedOf(meta.cloudOwned)
  return {
    name,
    provider,
    identity: (meta.identity as Identity) ?? {},
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
    updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
    ...(cloudOwned ? { cloudOwned } : {}),
    ...(typeof meta.live === "string" ? { live: meta.live } : {}),
    ...(typeof meta.renewedFrom === "string" ? { renewedFrom: meta.renewedFrom } : {}),
  }
}

export async function readSnapshot(provider: ProviderId, name: string): Promise<Snapshot | null> {
  const slot = await readSlot(provider, name)
  if (!slot) return null
  const dir = slotDir(provider, name)
  const files: Record<string, string> = {}
  for (const file of await readdir(dir)) {
    if (file === META_FILE) continue
    const text = await readTextIfExists(join(dir, file))
    if (text !== null) files[file] = text
  }
  return { provider, identity: slot.identity, files, capturedAt: slot.updatedAt }
}

/**
 * `live`: the fingerprint of the login when it is the live one being written (null when it isn't;
 * undefined keeps what was there). `renewedFrom`: the grant a renewal being written spent; any
 * other write drops it.
 */
export async function writeSnapshot(name: string, snapshot: Snapshot, options: { live?: string | null; renewedFrom?: string | null } = {}): Promise<Slot> {
  const dir = slotDir(snapshot.provider, name)
  const existing = await readSlot(snapshot.provider, name)
  // fields other tools keep in slot.json (kyora session's cloudOwned) outlive a re-save
  const kept = (await readJsonIfExists(join(dir, META_FILE)).catch(() => null)) ?? {}
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })

  for (const [file, contents] of Object.entries(snapshot.files)) {
    await writeFileAtomic(join(dir, file), contents, 0o600)
  }
  const slot: Slot = {
    name,
    provider: snapshot.provider,
    identity: snapshot.identity,
    createdAt: existing?.createdAt || snapshot.capturedAt,
    updatedAt: snapshot.capturedAt,
    ...(existing?.cloudOwned ? { cloudOwned: existing.cloudOwned } : {}),
  }
  const { name: _name, provider: _provider, identity: _identity, createdAt: _created, updatedAt: _updated, live: wasLive, renewedFrom: _renewedFrom, ...extra } = kept
  const live = options.live === undefined ? (typeof wasLive === "string" ? wasLive : undefined) : (options.live ?? undefined)
  if (live) slot.live = live
  if (options.renewedFrom) slot.renewedFrom = options.renewedFrom
  await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify({ ...extra, ...slot }, null, 2)}\n`, 0o600)
  return slot
}

export async function removeSlot(provider: ProviderId, name: string): Promise<void> {
  await rm(slotDir(provider, name), { recursive: true, force: true })
}

export async function renameSlot(provider: ProviderId, from: string, to: string): Promise<void> {
  await mkdir(join(rootDir(), provider), { recursive: true, mode: 0o700 })
  await rename(slotDir(provider, from), slotDir(provider, to))
  // the whole slot.json moves along, fields this tool doesn't know included
  const meta = await readJsonIfExists(join(slotDir(provider, to), META_FILE))
  if (meta) {
    await writeFileAtomic(
      join(slotDir(provider, to), META_FILE),
      `${JSON.stringify({ ...meta, name: to }, null, 2)}\n`,
      0o600,
    )
  }
}

/** how long a load or a refresh waits for another kyora-switch's: past one slow token renewal */
export const SWITCH_LOCK_TIMEOUT_MS = 60_000

/** how long a read command (status, list, usage) waits to copy the live login into its slot: the next run copies it */
export const READ_SYNC_TIMEOUT_MS = 2_000

export class SwitchLockBusy extends Error {}

/** the providers whose slot lock the current call chain holds: a nested take is a no-op, a concurrent one waits */
const heldLocks = new AsyncLocalStorage<ReadonlySet<ProviderId>>()

/**
 * Runs `change` holding kyora-switch's own lock on a provider's slots, across processes. A refresh
 * spends a slot's single-use refresh token and writes the rotated one back, and a load puts a slot
 * live: each reads the slot inside the lock, so neither acts on what the other is about to replace.
 * Without the provider's slot directory there is no slot to guard, and where the platform has no
 * flock there is no lock: `change` then runs as it did before there was one.
 */
export async function withSwitchLock<T>(provider: ProviderId, change: () => Promise<T>, timeoutMs = SWITCH_LOCK_TIMEOUT_MS): Promise<T> {
  const held = heldLocks.getStore()
  if (held?.has(provider)) return await change()
  let fd: number
  try {
    fd = await acquireLock(
      join(rootDir(), provider, ".switch.lock"),
      timeoutMs,
      (holder) => new SwitchLockBusy(`another kyora-switch${holder} is changing ${provider} slots; try again once it is done`),
    )
  } catch (error) {
    if (error instanceof LockUnavailable || (error as NodeJS.ErrnoException)?.code === "ENOENT") return await change()
    throw error
  }
  try {
    return await heldLocks.run(new Set([...(held ?? []), provider]), change)
  } finally {
    releaseLock(fd)
  }
}

/** marks a slot as holding the live login (`load` just put it there) */
export async function markLive(provider: ProviderId, name: string, live: string): Promise<void> {
  const path = join(slotDir(provider, name), META_FILE)
  const meta = await readJsonIfExists(path)
  if (meta) await writeFileAtomic(path, `${JSON.stringify({ ...meta, live }, null, 2)}\n`, 0o600)
}

/**
 * Parks a login somewhere recoverable before it is overwritten. `load` and `clear` keep theirs
 * in backups/<provider>; the live-login sync keeps its own in sync-backups/<provider>, with its
 * own cap, so a run of them never pushes out the only copy of a login `load` replaced.
 */
export async function writeBackup(snapshot: Snapshot, kind: "load" | "sync" = "load"): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = join(rootDir(), kind === "sync" ? "sync-backups" : "backups", snapshot.provider, stamp)
  for (const [file, contents] of Object.entries(snapshot.files)) {
    await writeFileAtomic(join(dir, file), contents, 0o600)
  }
  await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(snapshot.identity, null, 2)}\n`, 0o600)
  await pruneBackups(snapshot.provider, kind)
  return dir
}

async function pruneBackups(provider: ProviderId, kind: "load" | "sync"): Promise<void> {
  const dir = join(rootDir(), kind === "sync" ? "sync-backups" : "backups", provider)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names.sort().slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
    await rm(join(dir, name), { recursive: true, force: true })
  }
}
