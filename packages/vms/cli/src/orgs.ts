import { hostname } from "node:os"
import { ApiError, VmsClient } from "./api"
import { originOf, type Config } from "./config"
import { readCredentials, saveLogin, type StoredLogin } from "./credentials"
import { note, printJson } from "./output"

/**
 * `kyora-vms org ls` and `org use`: which account the stored kyora cloud login acts as, the person
 * or one of their orgs. An org's token is kept per org
 * beside the personal one in credentials.json; `use` picks which one commands send.
 */

const PERSONAL = new Set(["personal", "-", "me"])

/** the stored login for this URL's origin, or null */
async function storedLogin(config: Config): Promise<StoredLogin | null> {
  return (await readCredentials(config.credentials))[originOf(config.url)] ?? null
}

/** when the key commands send doesn't come from the stored login, `org use` changes nothing they do: say so */
function keyElsewhere(config: Config): void {
  if (config.key && config.keySource !== config.credentials) note(`the key from ${config.keySource} still comes first; unset it for org use to take effect`)
}

/**
 * The person's orgs, marking the one in use. An org's token knows only its own org, so the list
 * comes from the stored personal token when there is one.
 */
export async function orgList(api: VmsClient, config: Config, asJson: boolean): Promise<number> {
  if ((await api.kind()) !== "platform") throw new Error(`${api.url} does not support organizations. Use kyora cloud to manage organizations`)
  const stored = await storedLogin(config)
  const fromStore = config.keySource === config.credentials
  const personal = fromStore && stored?.token && stored.token !== config.key ? new VmsClient({ ...config, key: stored.token, keySource: config.credentials }) : null
  // a personal login that expired still leaves the org in use to list
  const orgs = (personal ? await personal.orgs().catch((error) => (error instanceof ApiError && error.status === 401 ? null : Promise.reject(error))) : null) ?? (await api.orgs())
  const using = fromStore ? (config.org ?? null) : null
  if (asJson) {
    printJson({ orgs, using })
    return 0
  }
  console.log(`${using === null ? "*" : " "} personal${stored?.login ? `  ${stored.login}` : ""}`)
  for (const org of orgs) console.log(`${using === org.login ? "*" : " "} ${org.login}  ${org.role ?? "-"}${org.vmsAccess ? "" : "  (no vms access)"}${org.name ? `  ${org.name}` : ""}`)
  if (orgs.length === 0) note("you aren't in any org")
  keyElsewhere(config)
  return 0
}

/**
 * Acts as `ref` from now on: a stored org token when there is a live one, else one minted with the
 * personal token (`POST /v1/orgs/:org/tokens`). `personal` goes back to the personal token.
 */
export async function orgUse(config: Config, ref: string, asJson: boolean, now = Date.now()): Promise<number> {
  const origin = originOf(config.url)
  const stored = await storedLogin(config)
  if (PERSONAL.has(ref)) {
    if (!stored?.token) throw new Error(`there is no personal login for ${config.url} here; run kyora-vms login`)
    const { use: _use, ...rest } = stored
    await saveLogin(config.credentials, origin, rest)
    if (asJson) printJson({ using: null, login: stored.login })
    else console.log(`acting as ${stored.login} (personal)`)
    keyElsewhere(config)
    return 0
  }
  const handle = ref.toLowerCase()
  const kept = stored?.orgs?.[handle]
  const live = kept && (!kept.expiresAt || Date.parse(kept.expiresAt) > now + 60_000)
  let entry = live ? kept : null
  if (!entry) {
    if (!stored?.token) throw new Error(`no token for the org ${handle} here; run kyora-vms login --org ${handle}`)
    const personal = new VmsClient({ ...config, key: stored.token, keySource: config.credentials })
    try {
      const minted = await personal.orgToken(handle, `kyora-vms on ${hostname()}`)
      entry = { token: minted.token, id: minted.org.id, login: minted.org.login, actor: minted.actor, expiresAt: minted.expiresAt }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new Error(`you aren't in an org called ${handle} (kyora-vms org ls lists yours)`)
      if (error instanceof ApiError && error.status === 401) throw new Error(`the personal login for ${config.url} expired; run kyora-vms login, or kyora-vms login --org ${handle}`)
      throw error
    }
  }
  await saveLogin(config.credentials, origin, { ...stored!, orgs: { ...stored?.orgs, [entry.login]: entry }, use: entry.login })
  if (asJson) printJson({ using: entry.login, id: entry.id, actor: entry.actor, expiresAt: entry.expiresAt ?? null })
  else console.log(`acting as the org ${entry.login}${entry.actor ? ` (as ${entry.actor})` : ""}`)
  keyElsewhere(config)
  return 0
}
