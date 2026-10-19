import { grokUsage, vendorUrl, type LiveUsage } from "@kyora-sh/usage"
import { AsyncLocalStorage } from "node:async_hooks"
import { readFileSync } from "node:fs"
import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { readTextIfExists, writeFileAtomic } from "../fsx"
import { grokIdentity } from "../identity"
import { acquireLock, LockUnavailable, LoginLockBusy, releaseLock } from "../lock"
import { networkFailure, refusal, tokenRequest } from "../renewal"
import type { Provider, Renewal, Snapshot } from "../types"

const AUTH_FILE = "auth.json"
const LOCK_FILE = "auth.json.lock"

/** the issuer and client Grok Build signs xAI accounts in with: its auth.json scope is `issuer::client_id` */
export const GROK_XAI_ISSUER = "https://auth.x.ai"
const GROK_XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const GROK_DEFAULT_SCOPE = `${GROK_XAI_ISSUER}::${GROK_XAI_CLIENT_ID}`
/** the scope pre-OIDC builds wrote, which grok still reads when the current one is missing */
export const GROK_LEGACY_SCOPE = "https://accounts.x.ai/sign-in"
/** where `grok login --api-key` (and the desktop app) store a plain xAI API key */
export const GROK_API_KEY_SCOPE = "xai::api_key"
/** credentials minted before this many milliseconds ago with no expires_at are past grok's own TTL */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** how long load and clear wait for a grok process to let go of auth.json.lock */
export const GROK_LOCK_TIMEOUT_MS = 10_000

export const GROK_AUTH_NOTE =
  "GROK_AUTH is set: grok uses that login instead of auth.json, so slot switches do not change what grok runs as (unset GROK_AUTH to use slots)"

export const XAI_API_KEY_NOTE =
  "XAI_API_KEY (or GROK_CODE_XAI_API_KEY) is set and this login has no account session: grok uses the environment key, not the one stored in auth.json"

export const GROK_PRECEDENCE =
  "precedence: GROK_AUTH, then the account login in auth.json, then XAI_API_KEY (else GROK_CODE_XAI_API_KEY), then the key `grok login --api-key` stored"

const nonEmpty = (value: string | undefined): string | undefined => (value ? value : undefined)

/** `$GROK_HOME` when it is set and not empty, else `~/.grok`, as grok resolves it */
export function grokHome(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.GROK_HOME) ?? join(homedir(), ".grok")
}

/** `$GROK_AUTH_PATH` when it is set and not empty, else auth.json in the grok home */
export function grokAuthPath(): string {
  return nonEmpty(process.env.GROK_AUTH_PATH) ?? join(grokHome(), AUTH_FILE)
}

type Entry = Record<string, unknown>
type Store = Record<string, unknown>

function record(value: unknown): Entry | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

interface IdentityProvider {
  issuer: string
  client: string
}

/** a string as grok's config reads one: set even when empty */
const given = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function envProvider(issuer: string | undefined, client: string | undefined): IdentityProvider | undefined {
  return issuer !== undefined && client !== undefined ? { issuer, client } : undefined
}

/** a `[grok_com_config.oidc]` or `.oauth2` table over the provider it overrides; without one it must name both fields, as grok requires */
function tableOver(table: unknown, base: IdentityProvider | undefined): IdentityProvider | undefined {
  const fields = record(table)
  if (!fields) return base
  return envProvider(given(fields.issuer) ?? base?.issuer, given(fields.client_id) ?? base?.client)
}

/** `[grok_com_config]` of the user's config.toml, with its `[auth]` alias filled in under it as grok does */
export function grokLoginConfig(env: NodeJS.ProcessEnv = process.env): Entry | undefined {
  let config: Entry | undefined
  try {
    config = record(Bun.TOML.parse(readFileSync(join(grokHome(env), "config.toml"), "utf8")))
  } catch {
    return undefined
  }
  const section = record(config?.grok_com_config)
  const alias = record(config?.auth)
  return section || alias ? { ...alias, ...section } : undefined
}

/**
 * The scope grok looks its account login up under: an OIDC deployment's (GROK_OIDC_ISSUER and
 * GROK_OIDC_CLIENT_ID, or `[grok_com_config.oidc]` in config.toml), else a custom OAuth2
 * provider's (GROK_OAUTH2_ISSUER and GROK_OAUTH2_CLIENT_ID, or `[grok_com_config.oauth2]`), else
 * xAI's own. An empty variable or field counts as set, as grok reads them.
 */
export function grokScope(env: NodeJS.ProcessEnv = process.env, config: Entry | undefined = grokLoginConfig(env)): string {
  const envOidc = envProvider(env.GROK_OIDC_ISSUER, env.GROK_OIDC_CLIENT_ID)
  const envOauth2 = envProvider(env.GROK_OAUTH2_ISSUER, env.GROK_OAUTH2_CLIENT_ID)
  const xai = { issuer: GROK_XAI_ISSUER, client: GROK_XAI_CLIENT_ID }
  const oidc = tableOver(config?.oidc, envOidc)
  const oauth2 = tableOver(config?.oauth2, envOidc ? undefined : (envOauth2 ?? xai)) ?? envOauth2
  const chosen = oidc ?? oauth2 ?? xai
  return `${chosen.issuer.replace(/\/+$/, "")}::${chosen.client}`
}

/** The auth.json document; an empty file is an empty store, as grok reads it after a crash. */
export function parseStore(text: string, source: string): Store {
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${source} is not valid JSON`)
  }
  const store = record(parsed)
  if (!store) throw new Error(`${source} is not a JSON object`)
  return store
}

const AUTH_MODES = new Set(["web_login", "grok", "oidc", "external", "api_key"])

/** an entry grok can sign in with at all: it refuses the whole file over one that lacks a field it requires */
function readable(entry: Entry | undefined): entry is Entry {
  return (
    entry !== undefined &&
    str(entry.key) !== undefined &&
    AUTH_MODES.has(entry.auth_mode as string) &&
    typeof entry.user_id === "string" &&
    timeOf(entry.create_time) !== undefined
  )
}

const isWebLogin = (entry: Entry): boolean => entry.auth_mode === "web_login" || entry.auth_mode === "grok"

type Session = { scope: string; entry: Entry }

/**
 * The account login grok signs requests with: the entry under its scope, else under the legacy
 * scope. A legacy web login is no login at all: grok makes its owner sign in again.
 */
export function grokSession(store: Store, env: NodeJS.ProcessEnv = process.env): Session | null {
  for (const scope of [grokScope(env), GROK_LEGACY_SCOPE]) {
    const entry = record(store[scope])
    if (!entry) continue
    if (isWebLogin(entry)) return null
    if (readable(entry)) return { scope, entry }
  }
  return null
}

function storedKey(store: Store): Entry | undefined {
  const entry = record(store[GROK_API_KEY_SCOPE])
  return readable(entry) ? entry : undefined
}

/** grok's own entries in a login store: the session it signs in with, and the stored API key */
interface Slice {
  session?: Session
  key?: Entry
}

/** The slice of the live store grok signs in with. */
function liveSlice(store: Store): Slice {
  return { session: grokSession(store) ?? undefined, key: storedKey(store) }
}

/** The slice a slot holds: its one session, under whatever scope it was saved from, and its key. */
function slotSlice(store: Store): Slice {
  const session =
    grokSession(store) ??
    Object.entries(store)
      .filter(([scope]) => scope !== GROK_API_KEY_SCOPE)
      .map(([scope, value]) => ({ scope, entry: record(value) }))
      .find((found): found is Session => readable(found.entry) && !isWebLogin(found.entry))
  return { session: session ?? undefined, key: storedKey(store) }
}

/** the slice in a fixed shape (session first, then the key), so an unchanged login always serializes the same */
function sliceText(slice: Slice): string {
  const entries: Store = {}
  if (slice.session) entries[slice.session.scope] = slice.session.entry
  if (slice.key) entries[GROK_API_KEY_SCOPE] = slice.key
  return `${JSON.stringify(entries, null, 2)}\n`
}

/** auth.json as grok writes it: its scopes in sorted order, pretty printed */
function storeText(store: Store): string {
  const sorted: Store = {}
  for (const scope of Object.keys(store).sort()) sorted[scope] = store[scope]
  return JSON.stringify(sorted, null, 2)
}

function snapshotSlice(snapshot: Snapshot): Slice {
  try {
    return slotSlice(parseStore(snapshot.files[AUTH_FILE] ?? "", AUTH_FILE))
  } catch {
    return {}
  }
}

/** The entry a slice is named by and matched on: its account login, else its stored API key. */
const loginOf = (slice: Slice): Entry | undefined => slice.session?.entry ?? slice.key

export function xaiApiKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.XAI_API_KEY || env.GROK_CODE_XAI_API_KEY)
}

function isXaiLogin(entry: Entry): boolean {
  const issuer = str(entry.oidc_issuer)?.replace(/\/+$/, "")
  return (entry.auth_mode === "oidc" || entry.auth_mode === "external") && issuer === GROK_XAI_ISSUER
}

/** The credential behind each login a slot holds, by scope: its refresh token, else its key. */
export function grokFileGrants(snapshot: Snapshot): Record<string, string> {
  let stored: Store
  try {
    stored = parseStore(snapshot.files[AUTH_FILE] ?? "", AUTH_FILE)
  } catch {
    return {}
  }
  const grants: Record<string, string> = {}
  for (const [scope, value] of Object.entries(stored)) {
    const entry = record(value)
    const grant = str(entry?.refresh_token) ?? str(entry?.key)
    if (grant) grants[scope] = grant
  }
  return grants
}

/** A renewal of one slot carried into another that holds the same grant: its session, and the other slot's own key. */
export function carryGrokRenewal(renewed: Snapshot, onto: Snapshot): Snapshot {
  return { ...onto, files: { ...onto.files, [AUTH_FILE]: sliceText({ session: snapshotSlice(renewed).session, key: snapshotSlice(onto).key }) } }
}

/** The token endpoint xAI's discovery document names; only ever an https x.ai host. */
async function xaiTokenEndpoint(): Promise<{ endpoint: string } | { failure: string }> {
  const override = vendorUrl("KYORA_GROK_TOKEN_URL", "")
  if (override) return { endpoint: override }
  let response: Response
  try {
    response = await fetch(`${GROK_XAI_ISSUER}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    return { failure: networkFailure(error) }
  }
  if (!response.ok) return { failure: await refusal(response) }
  const endpoint = ((await response.json().catch(() => null)) as Entry | null)?.token_endpoint
  const unusable = { failure: "xAI's sign-in configuration names no usable token endpoint" }
  if (typeof endpoint !== "string") return unusable
  try {
    const url = new URL(endpoint)
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai")) ? { endpoint } : unusable
  } catch {
    return unusable
  }
}

/**
 * Trades a slot's xAI refresh token for a new session, the call grok makes when its own token
 * ages out. xAI refresh tokens are single use, so the caller must keep the result or the slot
 * is left holding a spent credential. The slot's stored key stays as it was.
 */
export async function refreshStore(text: string): Promise<{ text: string } | { failure: string }> {
  let slice: Slice
  try {
    slice = slotSlice(parseStore(text, AUTH_FILE))
  } catch {
    return { failure: "the stored login is unreadable: log in again and save" }
  }
  const session = slice.session
  if (!session) return { failure: "no account login is stored, only a key, which never expires" }
  if (session.entry.auth_mode !== "oidc" || !isXaiLogin(session.entry)) return { failure: "grok renews this login itself, not through xAI" }
  const refreshToken = str(session.entry.refresh_token)
  const clientId = str(session.entry.oidc_client_id)
  if (!refreshToken || !clientId) return { failure: "no refresh token is stored: log in again and save" }

  const found = await xaiTokenEndpoint()
  if ("failure" in found) return found
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId })
  for (const key of ["principal_type", "principal_id"] as const) {
    const value = str(session.entry[key])
    if (value) form.set(key, value)
  }
  const answer = await tokenRequest(found.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if ("failure" in answer) return answer
  const data = answer.data
  const accessToken = str(data.access_token)
  if (!accessToken) return { failure: "the token server's answer had no access token" }

  const now = Date.now()
  const next: Entry = {
    ...session.entry,
    key: accessToken,
    create_time: new Date(now).toISOString(),
    refresh_token: str(data.refresh_token) ?? refreshToken,
  }
  if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) next.expires_at = new Date(now + data.expires_in * 1000).toISOString()
  else delete next.expires_at
  return { text: sliceText({ session: { scope: session.scope, entry: next }, key: slice.key }) }
}

/** grok renews its session this long before it expires: GROK_AUTH_EARLY_INVALIDATION_SECS, else five minutes */
export function grokRenewalMarginMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = env.GROK_AUTH_EARLY_INVALIDATION_SECS
  return seconds !== undefined && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : 300_000
}

/** grok's lock: an flock on auth.json.lock beside the configured auth.json, a file grok never deletes */
export function grokLockPath(): string {
  return join(dirname(grokAuthPath()), LOCK_FILE)
}

/** set while the current call chain holds auth.json.lock: a nested take is a no-op, a concurrent one waits */
const holdingGrokLock = new AsyncLocalStorage<true>()

/** Runs `change` holding grok's auth.json.lock, the lock grok takes before it refreshes or rewrites its logins. */
export async function withGrokLock<T>(change: () => Promise<T>, timeoutMs = GROK_LOCK_TIMEOUT_MS): Promise<T> {
  if (holdingGrokLock.getStore()) return await change()
  const path = grokLockPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const fd = await acquireLock(path, timeoutMs, (holder) => new LoginLockBusy(`grok holds ${path}${holder}; kyora-switch left auth.json unchanged, try again once grok is idle`)).catch((error) => {
    throw error instanceof LockUnavailable ? new Error(`${error.message}, so it leaves grok's auth.json alone`) : error
  })
  try {
    return await holdingGrokLock.run(true, change)
  } finally {
    releaseLock(fd)
  }
}

async function readLive(): Promise<{ text: string | null; store: Store }> {
  const path = grokAuthPath()
  const text = await readTextIfExists(path)
  return { text, store: text === null ? {} : parseStore(text, path) }
}

/** Writes the live store as grok would, through a symlinked auth.json to its target; an unchanged store is left byte for byte. */
async function writeLive(previous: string | null, next: Store): Promise<void> {
  const path = grokAuthPath()
  if (Object.keys(next).length === 0) {
    // a symlinked auth.json keeps its link, and its target no longer holds the login
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) await writeFileAtomic(await realpath(path).catch(() => path), "{}", 0o600)
    else await rm(path, { force: true })
    return
  }
  const text = storeText(next)
  if (previous !== null && storeText(parseStore(previous, path)) === text) return
  await writeFileAtomic(await realpath(path).catch(() => path), text, 0o600)
}

/** the live store without the session grok signs in with */
function withoutLiveSession(store: Store): Store {
  const outgoing = liveSlice(store)
  const next = { ...store }
  if (outgoing.session) delete next[outgoing.session.scope]
  return next
}

/** The slice of a slot restore would put live, or why it would refuse it, leaving auth.json unchanged. */
function restorable(snapshot: Snapshot, store: Store): Slice {
  const text = snapshot.files[AUTH_FILE]
  const slot = text === undefined ? {} : slotSlice(parseStore(text, `the slot's ${AUTH_FILE}`))
  if (!slot.session && !slot.key) throw new Error("slot has no Grok Build credentials")
  const scope = slot.session?.scope
  const current = grokScope()
  if (scope !== undefined && scope !== current && (scope !== GROK_LEGACY_SCOPE || withoutLiveSession(store)[current] !== undefined)) {
    throw new Error(`the slot's login is for ${scope}, but grok signs in with ${current} (GROK_OIDC_*, GROK_OAUTH2_* or config.toml); auth.json is unchanged`)
  }
  return slot
}

export const grokProvider: Provider = {
  id: "grok",
  label: "Grok Build",
  processName: "grok(-[0-9].*)?",
  loginHint: "run `grok login`",

  locations() {
    const locations = [grokAuthPath(), GROK_PRECEDENCE]
    if (process.env.GROK_AUTH) locations.push(GROK_AUTH_NOTE)
    return locations
  },

  notes(snapshot: Snapshot | null) {
    const notes: string[] = []
    if (process.env.GROK_AUTH) notes.push(GROK_AUTH_NOTE)
    if (snapshot && xaiApiKeyPresent() && !snapshotSlice(snapshot).session) notes.push(XAI_API_KEY_NOTE)
    return notes
  },

  fileGrants: grokFileGrants,

  async capture(): Promise<Snapshot | null> {
    const slice = liveSlice((await readLive()).store)
    if (!slice.session && !slice.key) return null
    return { provider: "grok", identity: grokIdentity(loginOf(slice), slice.session?.scope), files: { [AUTH_FILE]: sliceText(slice) }, capturedAt: Date.now() }
  },

  /** Signs out the login grok uses, its scope alone, as `grok logout` does; every other scope stays. */
  async forget(): Promise<void> {
    await withGrokLock(async () => {
      const live = await readLive()
      const slice = liveSlice(live.store)
      const scope = slice.session?.scope ?? (slice.key ? GROK_API_KEY_SCOPE : undefined)
      if (scope === undefined) return
      const next = { ...live.store }
      delete next[scope]
      await writeLive(live.text, next)
    })
  },

  credentialExpiry(snapshot: Snapshot): number | undefined {
    const entry = snapshotSlice(snapshot).session?.entry
    if (!entry) return undefined
    const expires = timeOf(entry.expires_at)
    if (expires !== undefined) return expires
    const created = timeOf(entry.create_time)
    return created === undefined ? undefined : created + TOKEN_TTL_MS
  },

  grant(snapshot: Snapshot): string | undefined {
    const entry = loginOf(snapshotSlice(snapshot))
    return str(entry?.refresh_token) ?? str(entry?.key)
  },

  renewsItself(snapshot: Snapshot): boolean {
    const entry = snapshotSlice(snapshot).session?.entry
    return entry !== undefined && (entry.auth_mode === "external" || !isXaiLogin(entry))
  },

  exclusive: withGrokLock,

  carryRenewal: carryGrokRenewal,

  async refresh(snapshot: Snapshot): Promise<Renewal> {
    const text = snapshot.files[AUTH_FILE]
    if (text === undefined) return { failure: "no login is stored: log in again and save" }
    const refreshed = await refreshStore(text)
    if ("failure" in refreshed) return refreshed
    return { snapshot: { ...snapshot, files: { ...snapshot.files, [AUTH_FILE]: refreshed.text } } }
  },

  renewalMarginMs: () => grokRenewalMarginMs(),

  /** The renewed session into the live auth.json under its own scope, as grok writes a renewal: every other scope, the stored key included, stays. */
  async writeRenewal(renewed: Snapshot): Promise<void> {
    const session = snapshotSlice(renewed).session
    if (!session) throw new Error("the renewal has no Grok Build session")
    await withGrokLock(async () => {
      const live = await readLive()
      await writeLive(live.text, { ...live.store, [session.scope]: session.entry })
    })
  },

  async quota(snapshot: Snapshot): Promise<LiveUsage | null> {
    const entry = snapshotSlice(snapshot).session?.entry
    const token = str(entry?.key)
    return entry && token && isXaiLogin(entry) ? await grokUsage(token, str(entry.user_id) ?? "") : null
  },

  async checkRestore(snapshot: Snapshot): Promise<void> {
    await withGrokLock(async () => {
      restorable(snapshot, (await readLive()).store)
    })
  },

  /**
   * Puts a slot's login in place of the live one: the session grok signs in with and the stored
   * key are replaced as a pair, and every other scope (an enterprise OIDC login, say) stays.
   */
  async restore(snapshot: Snapshot): Promise<void> {
    await withGrokLock(async () => {
      const live = await readLive()
      const slot = restorable(snapshot, live.store)
      const next = withoutLiveSession(live.store)
      delete next[GROK_API_KEY_SCOPE]
      if (slot.session) next[slot.session.scope] = slot.session.entry
      if (slot.key) next[GROK_API_KEY_SCOPE] = slot.key
      await writeLive(live.text, next)
    })
  },
}
