import { rm } from "node:fs/promises"
import { join } from "node:path"
import { readJsonIfExists, writeFileAtomic } from "./fsx"
import { duration, REFRESH_TOKEN_SPENT } from "./renewal"
import { rootDir } from "./store"
import { programName, type ProviderId } from "./types"

/** how long `refresh` leaves a grant alone after its renewal failed */
export const RENEWAL_BACKOFF_MS = 3_600_000

const FILE = ".renewal-failures.json"

/** a failed renewal of one grant (by its fingerprint, sync.ts): when, and why in words that never carry a secret */
export interface RenewalFailure {
  at: number
  reason: string
}

const pathOf = (provider: ProviderId): string => join(rootDir(), provider, FILE)

export async function readRenewalFailures(provider: ProviderId): Promise<Map<string, RenewalFailure>> {
  const data = await readJsonIfExists(pathOf(provider)).catch(() => null)
  const failures = new Map<string, RenewalFailure>()
  for (const [grant, value] of Object.entries(data ?? {})) {
    const entry = value as Partial<RenewalFailure> | null
    if (typeof entry?.at === "number" && typeof entry.reason === "string") failures.set(grant, { at: entry.at, reason: entry.reason })
  }
  return failures
}

/** a spent or revoked refresh token never signs in again: only a save of a new login replaces it */
export const isFinal = (failure: RenewalFailure): boolean => failure.reason === REFRESH_TOKEN_SPENT

/**
 * Why `refresh` leaves this grant alone now, or undefined to renew it: a grant whose refresh token
 * was refused stays refused until the slot is saved again; any other failure is retried after an
 * hour, or at once by a refresh of this provider alone (`explicit`).
 */
export async function heldBack(provider: ProviderId, grant: string | null, explicit: boolean): Promise<string | undefined> {
  if (!grant) return undefined
  const failure = (await readRenewalFailures(provider)).get(grant)
  if (!failure) return undefined
  if (isFinal(failure)) return failure.reason
  const age = Date.now() - failure.at
  if (explicit || age < 0 || age >= RENEWAL_BACKOFF_MS) return undefined
  return `${failure.reason} (${duration(age)} ago; retried after an hour, or now by \`${programName()} ${provider} refresh\`)`
}

/** records how a renewal of `grant` went: `failure` keeps it held back, undefined clears it */
export async function recordRenewal(provider: ProviderId, grant: string | null, failure?: string): Promise<void> {
  if (!grant) return
  const failures = await readRenewalFailures(provider)
  if (failure === undefined && !failures.delete(grant)) return
  if (failure !== undefined) failures.set(grant, { at: Date.now(), reason: failure })
  if (failures.size === 0) return await rm(pathOf(provider), { force: true })
  await writeFileAtomic(pathOf(provider), `${JSON.stringify(Object.fromEntries(failures), null, 2)}\n`, 0o600)
}
