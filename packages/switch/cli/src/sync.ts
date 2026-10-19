import { createHash } from "node:crypto"
import { isCloudOwned, listSlots, readSnapshot, SWITCH_LOCK_TIMEOUT_MS, SwitchLockBusy, withSwitchLock, writeBackup, writeSnapshot, type Slot } from "./store"
import { accountKey, type Provider, type Snapshot } from "./types"

export interface LiveState {
  active: Snapshot | null
  slots: Slot[]
  synced: string | null
  /** the slot holding the live login (see findLiveSlot), or null */
  live: Slot | null
  /** the live login is the grant of a slot kyora cloud's broker owns: nothing was written to it */
  skipped: string | null
  /** several slots have the live login's email and none its token: none of them was written */
  ambiguous: string[]
  /** the live login differs from its slot, and another kyora-switch held the slots: the copy waits for the next sync */
  busy?: true
  /** the live login holds the grant a renewal in its slot spent: the slot is newer, so nothing was written to it */
  spent?: true
}

export function sameFiles(a: Snapshot, b: Snapshot): boolean {
  const keys = Object.keys(a.files).sort()
  if (keys.join("\n") !== Object.keys(b.files).sort().join("\n")) return false
  return keys.every((key) => a.files[key] === b.files[key])
}

/** the same fingerprint kyora session computes (packages/vms/cli/src/sessions/slots.ts): it never reveals the secret */
export const fingerprintOf = (secret: string): string =>
  createHash("sha256").update(`kyora-slot:${secret}`).digest("hex").slice(0, 24)

/** the fingerprint of a login's grant (its refresh token, or key), when the provider can tell */
export function grantFingerprint(provider: Provider, snapshot: Snapshot): string | null {
  const secret = provider.grant?.(snapshot)
  return secret ? fingerprintOf(secret) : null
}

/**
 * The slot that holds the live login. By grant first: the slot whose stored login has the live
 * refresh token (or key), or a slot kyora cloud's broker owns whose marker names it. Only then by
 * account email, only among slots kyora cloud doesn't own, and only when one slot has that email:
 * two `/login`s of one email are two grants, and an email match would copy one over the other.
 */
export async function findLiveSlot(provider: Provider, active: Snapshot | null, slots: Slot[]): Promise<Slot | null> {
  if (!active) return null
  const live = grantFingerprint(provider, active)
  if (live) {
    const matches: Slot[] = []
    for (const slot of slots) {
      const marker = slot.cloudOwned
      if (marker && marker !== true && marker.fingerprint === live) {
        matches.push(slot)
        continue
      }
      const stored = await readSnapshot(provider.id, slot.name)
      if (stored && grantFingerprint(provider, stored) === live) matches.push(slot)
    }
    // a grant in a slot the broker owns as well as in one of the laptop's: the broker's wins, so nothing writes it
    const found = matches.find(isCloudOwned) ?? matches[0]
    if (found) return found
  }
  const byEmail = sameEmail(slots, active)
  return byEmail.length === 1 ? byEmail[0]! : null
}

/** the slots kyora cloud doesn't own that have the live login's account (its email, or its stable id) */
const sameEmail = (slots: Slot[], active: Snapshot) => {
  const account = accountKey(active.identity)
  if (typeof account !== "string" || account.length === 0) return []
  return slots.filter((slot) => !isCloudOwned(slot) && accountKey(slot.identity) === account)
}

/**
 * Copies the live login back into the slot that holds it, so the CLI's own token refreshes
 * never leave that slot behind. No network, no keychain write: it only reads what every other
 * command already reads. A slot kyora cloud's broker owns is never written: its refresh token is
 * the broker's (`skipped` names it when the live login is that very grant). A copy to make is
 * read again and made under kyora-switch's slot lock; when another kyora-switch holds it past
 * `timeoutMs`, the copy waits for the next sync (`busy`).
 */
export async function syncLiveSlot(provider: Provider, timeoutMs = SWITCH_LOCK_TIMEOUT_MS): Promise<LiveState> {
  const first = await readLiveState(provider)
  if (!first.write) return first.state
  try {
    return await withSwitchLock(provider.id, async () => {
      const again = await readLiveState(provider)
      return again.write ? await again.write() : again.state
    }, timeoutMs)
  } catch (error) {
    if (!(error instanceof SwitchLockBusy)) throw error
    const after = await readLiveState(provider)
    return after.write ? { ...after.state, busy: true } : after.state
  }
}

/** the live login, its slot, and the copy into that slot to make, if any */
async function readLiveState(provider: Provider): Promise<{ state: LiveState; write?: () => Promise<LiveState> }> {
  const active = await provider.capture()
  const slots = await listSlots(provider.id)
  const match = await findLiveSlot(provider, active, slots)
  const ambiguous = active && !match ? sameEmail(slots, active).map((slot) => slot.name) : []
  if (!active || !match) return { state: { active, slots, synced: null, live: match, skipped: null, ambiguous: ambiguous.length > 1 ? ambiguous : [] } }
  if (isCloudOwned(match)) return { state: { active, slots, synced: null, live: match, skipped: match.name, ambiguous: [] } }

  const state: LiveState = { active, slots, synced: null, live: match, skipped: null, ambiguous: [] }
  const stored = await readSnapshot(provider.id, match.name)
  if (stored && sameFiles(stored, active)) return { state }
  // a renewal kyora-switch wrote here spent the live login's grant: copying the live login back would put the spent token over it
  const live = grantFingerprint(provider, active)
  if (live && match.renewedFrom === live) return { state: { ...state, spent: true } }

  const write = async (): Promise<LiveState> => {
    // matched by email and holding another grant than the live one: a token rotation can't be told from a
    // fresh login of the same email (another workspace), so what it held stays recoverable, in the sync backups
    const held = stored ? grantFingerprint(provider, stored) : null
    const storedGrants = stored ? (provider.fileGrants?.(stored) ?? {}) : {}
    const activeGrants = provider.fileGrants?.(active) ?? {}
    const replaced = Object.entries(storedGrants).some(([file, grant]) => activeGrants[file] !== grant)
    if (stored && ((live && held !== live) || replaced)) await writeBackup(stored, "sync")
    await writeSnapshot(match.name, active, { live })
    const after = await listSlots(provider.id)
    return { active, slots: after, synced: match.name, live: after.find((slot) => slot.name === match.name) ?? match, skipped: null, ambiguous: [] }
  }
  return { state, write }
}
