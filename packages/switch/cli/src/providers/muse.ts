import { MUSE_UNAUTHORIZED, museTeams, museUsage, type LiveUsage, type MuseAuth } from "@kyora-sh/usage"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { readJsonIfExists, readTextIfExists, writeFileAtomic } from "../fsx"
import { museApiKeyLogin, museIdentity, museMeta } from "../identity"
import { keychainDelete, keychainRead, keychainSupported, keychainWrite } from "../keychain"
import { rootDir, slotDir } from "../store"
import { programName, type Provider, type QuotaUnavailable, type Snapshot } from "../types"
import { readWebSession, sessionLive, webHeaders, type WebSessionConfig } from "../web-session"

const AUTH_FILE = "auth.json"
const KEYCHAIN_FILE = "keychain.json"

export const MUSE_KEYCHAIN_SERVICE = "ai.meta.dev.credentials"
export const MUSE_KEYCHAIN_ACCOUNT = "meta"

export function museConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "muse") : join(homedir(), ".config", "muse")
}

export function museAuthPath(): string {
  return join(museConfigDir(), AUTH_FILE)
}

/** Whether `META_API_KEY` is set, without ever reading its value into a slot or a message. */
export function metaApiKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.META_API_KEY?.trim())
}

export const META_API_KEY_NOTE =
  "META_API_KEY is set: Muse uses it instead of the account login, so slot switches do not change what Muse runs as (unset META_API_KEY to use slots)"

export const MUSE_BACKEND_DISAGREE_NOTE =
  "auth.json and the macOS keychain hold different Muse logins; kyora-switch follows the keychain, as Muse does on macOS"

function grantOfMeta(meta: Record<string, unknown> | null): string | undefined {
  for (const key of ["refresh_token", "access_token", "api_key"] as const) {
    const value = meta?.[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

export const MUSE_KEYCHAIN_UNREADABLE_NOTE =
  "the macOS keychain holds a Muse login kyora-switch cannot read; it follows the keychain, as Muse does on macOS, and not the login in auth.json"

/** The keychain holds a blob in a shape kyora-switch does not recognise, beside a readable login in auth.json. */
export function museKeychainUnreadable(files: Record<string, string>): boolean {
  return files[KEYCHAIN_FILE] !== undefined && metaOf(files[KEYCHAIN_FILE]) === null && grantOfMeta(metaOf(files[AUTH_FILE])) !== undefined
}

/** The credential each stored file holds: its grant when it parses into one, else its raw text. */
export function museFileGrants(files: Record<string, string>): Record<string, string> {
  const grants: Record<string, string> = {}
  for (const file of [AUTH_FILE, KEYCHAIN_FILE]) {
    const text = files[file]
    if (text !== undefined) grants[file] = grantOfMeta(metaOf(text)) ?? text
  }
  return grants
}

export function museBackendsDisagree(files: Record<string, string>): boolean {
  const fileGrant = grantOfMeta(metaOf(files[AUTH_FILE]))
  const keychainGrant = grantOfMeta(metaOf(files[KEYCHAIN_FILE]))
  return fileGrant !== undefined && keychainGrant !== undefined && fileGrant !== keychainGrant
}

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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** The `providers.meta` entry alone, in a fixed shape so an unchanged login always serializes the same. */
export function metaSlice(auth: AuthEntries): AuthEntries {
  const meta = record(record(auth.providers)?.meta)
  return meta ? { providers: { meta } } : {}
}

function liveProviders(live: AuthEntries): Record<string, unknown> {
  if (live.providers === undefined) return {}
  const providers = record(live.providers)
  if (!providers) throw new Error(`${AUTH_FILE} has a "providers" entry that is not an object; kyora-switch leaves it as it is`)
  return providers
}

/** Lays a slot's meta entry over the live auth.json and leaves every other key and provider alone. */
export function mergeMeta(live: AuthEntries, meta: Record<string, unknown>): AuthEntries {
  return { ...live, providers: { ...liveProviders(live), meta } }
}

/** The live document with only `providers.meta` removed. */
export function withoutMeta(live: AuthEntries): AuthEntries {
  const providers = { ...liveProviders(live) }
  delete providers.meta
  const rest = { ...live }
  if (Object.keys(providers).length === 0) delete rest.providers
  else rest.providers = providers
  return rest
}

function metaOf(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null
  try {
    return museMeta(JSON.parse(text))
  } catch {
    return null
  }
}

/** The credential Muse would use from a slot: the keychain blob whenever there is one, even one that does not parse, else the auth file. */
export function preferredMeta(files: Record<string, string>): Record<string, unknown> | null {
  return files[KEYCHAIN_FILE] !== undefined ? metaOf(files[KEYCHAIN_FILE]) : metaOf(files[AUTH_FILE])
}

/** The identity Muse would use from a slot, from the same source as preferredMeta. */
export function preferredIdentity(files: Record<string, string>) {
  const meta = preferredMeta(files)
  return museIdentity(meta ? { providers: { meta } } : null)
}

function expiryOf(meta: Record<string, unknown> | null): number | undefined {
  const raw = meta?.expires_at ?? meta?.expiresAt
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1000
  if (typeof raw === "string") {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

export interface MuseBackendOps {
  readAuthText: () => Promise<string | null>
  writeAuthText: (text: string) => Promise<void>
  deleteAuthFile: () => Promise<void>
  readKeychainBlob: () => Promise<string | null>
  writeKeychainBlob: (blob: string) => Promise<void>
  deleteKeychainItem: () => Promise<void>
  keychainSupported: boolean
}

function liveBackendOps(): MuseBackendOps {
  return {
    readAuthText: () => readTextIfExists(museAuthPath()),
    writeAuthText: async (text) => { await writeFileAtomic(museAuthPath(), text, 0o600) },
    deleteAuthFile: async () => { await rm(museAuthPath(), { force: true }) },
    readKeychainBlob: () => keychainRead(MUSE_KEYCHAIN_SERVICE, MUSE_KEYCHAIN_ACCOUNT),
    writeKeychainBlob: (blob) => keychainWrite(blob, MUSE_KEYCHAIN_SERVICE, MUSE_KEYCHAIN_ACCOUNT),
    deleteKeychainItem: () => keychainDelete(MUSE_KEYCHAIN_SERVICE, MUSE_KEYCHAIN_ACCOUNT),
    keychainSupported: keychainSupported(),
  }
}

const SLOT_META = "slot.json"
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The dev.meta.ai team a slot's usage is read for, kept in the slot's own slot.json, never in Muse's auth.json. */
export async function readMuseTeam(slot: string): Promise<string | undefined> {
  const team = (await readJsonIfExists(join(slotDir("muse", slot), SLOT_META)))?.teamId
  return typeof team === "string" && TEAM_ID.test(team) ? team : undefined
}

/** Sets (or, with null, unsets) the team of a saved slot. */
export async function writeMuseTeam(slot: string, team: string | null): Promise<void> {
  if (team !== null && !TEAM_ID.test(team)) throw new Error("a team id is letters, digits, dash or underscore, as dev.meta.ai shows it in ?team_id=")
  const path = join(slotDir("muse", slot), SLOT_META)
  const meta = await readJsonIfExists(path)
  if (!meta) throw new Error(`no muse slot "${slot}"`)
  const { teamId: _previous, ...rest } = meta
  await writeFileAtomic(path, `${JSON.stringify(team === null ? rest : { ...rest, teamId: team }, null, 2)}\n`, 0o600)
}

/** dev.meta.ai, whose portal API takes the browser session `kyora-switch muse web-login` keeps per slot */
export const MUSE_WEB: WebSessionConfig = {
  origin: "https://dev.meta.ai",
  originEnv: "KYORA_MUSE_USAGE_URL",
  cookieDomains: ["dev.meta.ai", "meta.ai"],
  cookieNames: ["llama_dev_sess", "datr", "dpr", "_fbp"],
  sessionCookies: ["llama_dev_sess"],
  probe: { path: "/api/auth/me" },
}

const webLogin = (slot: string | undefined) =>
  slot ? `run \`${programName()} muse web-login ${slot}\`` : `save this login to a slot, then run \`${programName()} muse web-login <slot>\``

export const museRefusedNote = (slot: string | undefined) => `dev.meta.ai does not take the CLI login for usage; ${webLogin(slot)}`
export const museApiKeyNote = (slot: string | undefined) => `this ${slot ? "slot" : "login"} is an API key, which dev.meta.ai shows no usage for; ${webLogin(slot)}`
export const museWebExpiredNote = (slot: string) => `web session expired: run \`${programName()} muse web-login ${slot}\``

const setTeam = (slot: string | undefined) =>
  slot ? `set the team id with \`${programName()} muse team ${slot} <teamId>\`` : `save this login to a slot, then set its team id with \`${programName()} muse team <slot> <teamId>\``

/**
 * The login's subscription windows, read from the dev.meta.ai portal for the slot's team (`muse team`),
 * else for the login's only team.
 */
async function museQuota(auth: MuseAuth, slot: string | undefined): Promise<LiveUsage | QuotaUnavailable | typeof MUSE_UNAUTHORIZED> {
  const configured = slot ? await readMuseTeam(slot) : undefined
  let team = configured
  if (!team) {
    const teams = await museTeams(auth)
    if (teams === MUSE_UNAUTHORIZED) return teams
    if (teams === null) return { unavailable: `the Muse teams of this login could not be read; ${setTeam(slot)}` }
    if (teams.length !== 1) return { unavailable: `this login has ${teams.length === 0 ? "no team" : `${teams.length} teams`}; ${setTeam(slot)}` }
    team = teams[0]
  }
  const usage = await museUsage(auth, team!)
  if (usage) return usage
  return {
    unavailable: configured
      ? `dev.meta.ai returned no usage for team ${configured}; fix it with \`${programName()} muse team ${slot} <teamId>\` or clear it with \`${programName()} muse team ${slot} unset\``
      : "dev.meta.ai returned no usage for this login's team",
  }
}

export const museBackupsDir = (): string => join(rootDir(), "backups", "muse")

/**
 * Runs `change` against both backends and, when it fails, puts back exactly the backends it
 * touched. `outgoing` names where the login being replaced was backed up, for the error
 * raised when that rollback fails too.
 */
export async function applyMuseBackendChange(
  ops: MuseBackendOps,
  outgoing: string,
  change: (ops: MuseBackendOps) => Promise<void>,
): Promise<void> {
  const previousAuth = await ops.readAuthText()
  const previousBlob = ops.keychainSupported ? await ops.readKeychainBlob() : null
  const touched = { auth: false, keychain: false }
  const tracked: MuseBackendOps = {
    ...ops,
    writeAuthText: (text) => { touched.auth = true; return ops.writeAuthText(text) },
    deleteAuthFile: () => { touched.auth = true; return ops.deleteAuthFile() },
    writeKeychainBlob: (blob) => { touched.keychain = true; return ops.writeKeychainBlob(blob) },
    deleteKeychainItem: () => { touched.keychain = true; return ops.deleteKeychainItem() },
  }
  try {
    await change(tracked)
  } catch (error) {
    try {
      if (touched.auth) {
        if (previousAuth === null) await ops.deleteAuthFile()
        else await ops.writeAuthText(previousAuth)
      }
      if (touched.keychain) {
        if (previousBlob === null) await ops.deleteKeychainItem()
        else await ops.writeKeychainBlob(previousBlob)
      }
    } catch {
      throw new Error(`Muse login may be split between auth.json and the keychain; ${outgoing}`)
    }
    throw error
  }
}

async function deleteMetaVia(ops: MuseBackendOps): Promise<void> {
  const text = await ops.readAuthText()
  if (text === null) return
  const rest = withoutMeta(parseAuth(text, museAuthPath()))
  if (Object.keys(rest).length === 0) await ops.deleteAuthFile()
  else await ops.writeAuthText(`${JSON.stringify(rest, null, 2)}\n`)
}

export async function readStableMusePair(
  readFile: () => Promise<string | null>,
  readBlob: () => Promise<string | null>,
  supported: boolean,
): Promise<{ text: string | null; blob: string | null }> {
  if (!supported) return { text: await readFile(), blob: null }
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await readFile()
    const blob = await readBlob()
    const second = await readFile()
    const blobAgain = await readBlob()
    if (first === second && blob === blobAgain) return { text: first, blob }
  }
  throw new Error("Muse's login changed while it was being read; try again")
}

export const museProvider: Provider = {
  id: "muse",
  label: "Muse",
  processName: "muse(-bin-.+)?",
  loginHint: "run `muse login`",
  quotaHint: "no quota reported (a login without a subscription, or an API key, has no windows)",
  webSession: MUSE_WEB,

  locations() {
    const locations = [museAuthPath()]
    if (keychainSupported()) locations.push(`macOS keychain: ${MUSE_KEYCHAIN_SERVICE} (${MUSE_KEYCHAIN_ACCOUNT})`)
    if (metaApiKeyPresent()) locations.push(META_API_KEY_NOTE)
    return locations
  },

  fileGrants: (snapshot: Snapshot) => museFileGrants(snapshot.files),

  notes(snapshot: Snapshot | null) {
    const notes: string[] = []
    if (metaApiKeyPresent()) notes.push(META_API_KEY_NOTE)
    if (snapshot && museBackendsDisagree(snapshot.files)) notes.push(MUSE_BACKEND_DISAGREE_NOTE)
    if (snapshot && museKeychainUnreadable(snapshot.files)) notes.push(MUSE_KEYCHAIN_UNREADABLE_NOTE)
    return notes
  },

  async capture(): Promise<Snapshot | null> {
    const files: Record<string, string> = {}
    const supported = keychainSupported()
    const pair = await readStableMusePair(
      () => readTextIfExists(museAuthPath()),
      () => keychainRead(MUSE_KEYCHAIN_SERVICE, MUSE_KEYCHAIN_ACCOUNT),
      supported,
    )
    const text = pair.text
    if (text !== null) {
      const slice = metaSlice(parseAuth(text, museAuthPath()))
      if (Object.keys(slice).length > 0) files[AUTH_FILE] = `${JSON.stringify(slice, null, 2)}\n`
    }
    if (pair.blob !== null) files[KEYCHAIN_FILE] = pair.blob
    if (Object.keys(files).length === 0) return null
    return { provider: "muse", identity: preferredIdentity(files), files, capturedAt: Date.now() }
  },

  async forget(): Promise<void> {
    const ops = liveBackendOps()
    await applyMuseBackendChange(ops, `the login you signed out is backed up in ${museBackupsDir()}`, async (backends) => {
      await deleteMetaVia(backends)
      if (backends.keychainSupported) await backends.deleteKeychainItem()
    })
  },

  credentialExpiry(snapshot: Snapshot): number | undefined {
    return expiryOf(preferredMeta(snapshot.files))
  },

  async quotaWithReason(snapshot: Snapshot, slot?: string): Promise<LiveUsage | QuotaUnavailable | null> {
    const meta = preferredMeta(snapshot.files)
    const apiKey = meta !== null && museApiKeyLogin(meta)
    const token = !apiKey && typeof meta?.access_token === "string" && meta.access_token ? meta.access_token : undefined
    const expiry = expiryOf(meta)
    const expired = expiry !== undefined && expiry <= Date.now()
    if (token && !expired) {
      const usage = await museQuota(token, slot)
      if (usage !== MUSE_UNAUTHORIZED) return usage
    }
    const web = slot ? await readWebSession("muse", slot) : null
    if (slot && web) {
      const team = await readMuseTeam(slot)
      if (!sessionLive(MUSE_WEB, web, team ? `/api/portal/teams/${encodeURIComponent(team)}/subscription-quota` : "/api/portal/teams")) return { unavailable: museWebExpiredNote(slot) }
      const usage = await museQuota({ headers: (path) => webHeaders(MUSE_WEB, web, path) }, slot)
      return usage === MUSE_UNAUTHORIZED ? { unavailable: museWebExpiredNote(slot) } : usage
    }
    if (apiKey) return { unavailable: museApiKeyNote(slot) }
    if (!token) return null
    if (expired) return { unavailable: "stored access token expired; load this slot and start muse, which renews it" }
    return { unavailable: museRefusedNote(slot) }
  },

  grant(snapshot: Snapshot): string | undefined {
    return grantOfMeta(preferredMeta(snapshot.files)) || snapshot.files[KEYCHAIN_FILE] || snapshot.files[AUTH_FILE] || undefined
  },

  async restore(snapshot: Snapshot): Promise<void> {
    const auth = snapshot.files[AUTH_FILE]
    const blob = snapshot.files[KEYCHAIN_FILE]
    const slotMeta = auth === undefined ? null : museMeta(parseAuth(auth, `the slot's ${AUTH_FILE}`))
    if (slotMeta === null && blob === undefined) throw new Error("slot has no Muse credentials")
    if (slotMeta === null && blob !== undefined && !keychainSupported()) {
      throw new Error("slot holds only a macOS keychain login, which cannot be restored on this platform")
    }

    const ops = liveBackendOps()
    await applyMuseBackendChange(ops, `the login you switched away from is backed up in ${museBackupsDir()}`, async (backends) => {
      if (slotMeta !== null) {
        const liveText = await backends.readAuthText()
        const live = liveText === null ? {} : parseAuth(liveText, museAuthPath())
        await backends.writeAuthText(`${JSON.stringify(mergeMeta(live, slotMeta), null, 2)}\n`)
      } else await deleteMetaVia(backends)

      if (backends.keychainSupported) {
        if (blob !== undefined) await backends.writeKeychainBlob(blob)
        else await backends.deleteKeychainItem()
      }
    })
  },
}
