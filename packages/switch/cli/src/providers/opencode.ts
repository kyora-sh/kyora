import { opencodeAuthPath, opencodeGoUsage, opencodeKey, type LiveUsage } from "@kyora-sh/usage"
import { readTextIfExists, writeFileAtomic } from "../fsx"
import { opencodeCredential, opencodeIdentity } from "../identity"
import type { Provider, Snapshot } from "../types"

const AUTH_FILE = "auth.json"

/** The auth.json entries a subscription login owns. Every other key is another provider's login. */
export const SUBSCRIPTION_KEYS = ["opencode-go", "opencode"] as const

type AuthEntries = Record<string, unknown>

function parseAuth(text: string, source: string): AuthEntries {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${source} is not valid JSON`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object`)
  }
  return parsed as AuthEntries
}

async function readAuth(): Promise<AuthEntries | null> {
  const text = await readTextIfExists(opencodeAuthPath())
  return text === null ? null : parseAuth(text, opencodeAuthPath())
}

/** Two-space JSON at 0600, the way opencode writes the file itself. */
async function writeAuth(auth: AuthEntries): Promise<void> {
  await writeFileAtomic(opencodeAuthPath(), JSON.stringify(auth, null, 2), 0o600)
}

/** The subscription entries alone, in a fixed order so an unchanged login always serializes the same. */
export function subscriptionSlice(auth: AuthEntries): AuthEntries {
  const slice: AuthEntries = {}
  for (const key of SUBSCRIPTION_KEYS) if (key in auth) slice[key] = auth[key]
  return slice
}

/**
 * Lays a slot's subscription entries over the live auth.json and leaves every other
 * provider alone. An entry the slot lacks is dropped only when it holds the outgoing
 * login's own key: kept, it would leave the old account half signed in, and the next
 * sync would file that key under the new slot. A Zen key that is a different
 * credential from the outgoing Go key is a login of its own, so it stays.
 */
export function mergeSubscriptions(live: AuthEntries, slot: AuthEntries): AuthEntries {
  const outgoing = opencodeCredential(live["opencode-go"]) ?? opencodeCredential(live.opencode)
  const merged = { ...live }
  for (const key of SUBSCRIPTION_KEYS) {
    if (key in slot) merged[key] = slot[key]
    else if (outgoing !== undefined && opencodeCredential(live[key]) === outgoing) delete merged[key]
  }
  return merged
}

export const opencodeProvider: Provider = {
  id: "opencode",
  label: "OpenCode",
  processName: "opencode",
  loginHint: "run `opencode auth login` and pick OpenCode Go",
  quotaHint: "no quota reported; only a key with an OpenCode Go subscription has windows, Zen is pay-as-you-go",

  locations() {
    const locations = [opencodeAuthPath()]
    if (process.env.OPENCODE_AUTH_CONTENT) {
      locations.push("OPENCODE_AUTH_CONTENT is set, so opencode reads that instead of the file")
    }
    return locations
  },

  async capture(): Promise<Snapshot | null> {
    const auth = await readAuth()
    const slice = auth ? subscriptionSlice(auth) : {}
    if (Object.keys(slice).length === 0) return null
    return {
      provider: "opencode",
      identity: opencodeIdentity(slice),
      files: { [AUTH_FILE]: `${JSON.stringify(slice, null, 2)}\n` },
      capturedAt: Date.now(),
    }
  },

  async forget(): Promise<void> {
    const auth = await readAuth()
    if (!auth || Object.keys(subscriptionSlice(auth)).length === 0) return
    const rest = { ...auth }
    for (const key of SUBSCRIPTION_KEYS) delete rest[key]
    await writeAuth(rest)
  },

  async quota(snapshot: Snapshot): Promise<LiveUsage | null> {
    const key = opencodeKey(snapshot.files[AUTH_FILE] ?? "")
    return key ? await opencodeGoUsage(key) : null
  },

  async restore(snapshot: Snapshot): Promise<void> {
    const text = snapshot.files[AUTH_FILE]
    const slot = text === undefined ? {} : subscriptionSlice(parseAuth(text, `the slot's ${AUTH_FILE}`))
    if (Object.keys(slot).length === 0) throw new Error("slot has no OpenCode credentials")
    await writeAuth(mergeSubscriptions((await readAuth()) ?? {}, slot))
  },
}
