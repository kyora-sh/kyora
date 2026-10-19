import { AGY_UNAUTHORIZED, agyUsage, parseAgyQuota, vendorUrl, type LiveUsage } from "@kyora-sh/usage"
import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { jwtPayload } from "../identity"
import { keychainDelete, keychainRead, keychainSupported, keychainWrite } from "../keychain"
import { tokenRequest } from "../renewal"
import type { Identity, Provider, QuotaUnavailable, Renewal, Snapshot } from "../types"

/** the macOS keychain item agy keeps its login in, through go-keyring */
export const AGY_KEYCHAIN_SERVICE = "gemini"
export const AGY_KEYCHAIN_ACCOUNT = "antigravity"
const KEYCHAIN_FILE = "keychain.txt"
const PREFIX = "go-keyring-base64:"
/** golang.org/x/oauth2 renews a token this long before it expires */
const EXPIRY_DELTA_MS = 10_000

export const AGY_ENV_NOTE =
  "AGY_LLM_GATEWAY_API_KEY, AGY_ADC_AUTH or GOOGLE_CLOUD_PROJECT is set: agy may sign in with that instead of the keychain login, so slot switches may not change what agy runs as"

/** `$ANTIGRAVITY_GEMINI_DIR` when it is an absolute path, else `~/.gemini`, as agy resolves it */
export function agyGeminiDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.ANTIGRAVITY_GEMINI_DIR
  return dir && isAbsolute(dir) ? dir : join(homedir(), ".gemini")
}

/** agy's app data: settings.json and the conversations it records */
export function agyDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agyGeminiDir(env), "antigravity-cli")
}

type Doc = Record<string, unknown>

function record(value: unknown): Doc | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : undefined
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/** the JSON document a go-keyring value holds: `go-keyring-base64:` and base64, or the JSON itself */
export function decodeAgyLogin(blob: string | undefined): Doc | null {
  if (blob === undefined) return null
  const text = blob.startsWith(PREFIX) ? Buffer.from(blob.slice(PREFIX.length), "base64").toString("utf8") : blob
  try {
    return record(JSON.parse(text)) ?? null
  } catch {
    return null
  }
}

export function encodeAgyLogin(doc: Doc): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(doc), "utf8").toString("base64")}`
}

const loginOf = (snapshot: Snapshot): Doc | null => decodeAgyLogin(snapshot.files[KEYCHAIN_FILE])

function claimsOf(doc: Doc | null): Doc {
  const idToken = str(doc?.id_token)
  return (idToken && jwtPayload(idToken)) || {}
}

/** the Google account a login signs in as: the email of its ID token, else its subject */
export function agyIdentity(doc: Doc | null): Identity {
  const claims = claimsOf(doc)
  const account = str(claims.email)
  const subject = str(claims.sub)
  return { ...(account ? { account } : {}), ...(!account && subject ? { id: `google ${subject}` } : {}) }
}

const MARKER_PREFIX = "keyring-marker-"

/** the marker agy leaves while it bypasses the keychain and keeps its login in a file, when there is one */
export function agyKeyringBypass(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of [agyDir(env), agyGeminiDir(env)]) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const marker = names.sort().find((name) => name.startsWith(MARKER_PREFIX))
    if (marker) return join(dir, marker)
  }
  return undefined
}

export const agyBypassNote = (marker: string): string =>
  `agy's keyring-bypass marker is at ${marker}: agy may keep its login in a file instead of the keychain, so slot switches may not change what agy runs as`

function agyNotes(): string[] {
  const marker = agyKeyringBypass()
  return [...(agyGatewayEnv() ? [AGY_ENV_NOTE] : []), ...(marker ? [agyBypassNote(marker)] : [])]
}

export function agyGatewayEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGY_LLM_GATEWAY_API_KEY || env.AGY_ADC_AUTH || env.GOOGLE_CLOUD_PROJECT)
}

/**
 * Trades the login's refresh token at Google's token endpoint for a new access token, as agy
 * does when its own runs out, for the OAuth client its ID token was issued to. A client secret,
 * when Google wants one for that client, comes from KYORA_AGY_OAUTH_CLIENT_SECRET.
 */
export async function refreshAgyLogin(blob: string): Promise<{ blob: string } | { failure: string; clientRefused?: true }> {
  const doc = decodeAgyLogin(blob)
  const token = record(doc?.token)
  const refreshToken = str(token?.refresh_token)
  if (!doc || !token) return { failure: "the stored login is unreadable: log in to agy again and save" }
  if (!refreshToken) return { failure: "no refresh token is stored: log in to agy again and save" }
  const claims = claimsOf(doc)
  const clientId = str(claims.azp) ?? str(claims.aud)
  if (!clientId) return { failure: "the stored login names no OAuth client: log in to agy again and save" }

  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId })
  const secret = process.env.KYORA_AGY_OAUTH_CLIENT_SECRET
  if (secret) form.set("client_secret", secret)
  const answer = await tokenRequest(vendorUrl("KYORA_AGY_TOKEN_URL", "https://oauth2.googleapis.com/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if ("failure" in answer) {
    return !secret && /invalid_client|invalid_request|unauthorized_client/.test(answer.failure)
      ? { failure: `${answer.failure}; Google may want agy's client secret in KYORA_AGY_OAUTH_CLIENT_SECRET, or run agy once to renew it`, clientRefused: true }
      : answer
  }
  const data = answer.data
  const accessToken = str(data.access_token)
  if (!accessToken) return { failure: "the token server's answer had no access token" }
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : undefined
  const next: Doc = {
    ...doc,
    token: {
      ...token,
      access_token: accessToken,
      token_type: str(data.token_type) ?? token.token_type,
      refresh_token: str(data.refresh_token) ?? refreshToken,
      ...(expiresIn !== undefined ? { expiry: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    },
    ...(str(data.id_token) ? { id_token: data.id_token } : {}),
  }
  return { blob: encodeAgyLogin(next) }
}

type AgyRunner = { run: () => Promise<boolean>; read: () => Promise<string | null> }

const agyRunner: AgyRunner = {
  async run() {
    try {
      const proc = Bun.spawn(["agy", "models"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 60_000 })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  },
  read: () => (keychainSupported() ? keychainRead(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT) : Promise.resolve(null)),
}

/**
 * Lets agy renew the live login itself, for a client Google will not renew without its secret:
 * `agy models` is the lightest call that makes agy talk to Google, and it sends no prompt. Only
 * the login agy holds can renew this way, so a saved slot that is not live is left as it was.
 */
export async function renewThroughAgy(blob: string, runner: AgyRunner = agyRunner): Promise<{ blob: string } | { failure: string } | undefined> {
  if ((await runner.read()) !== blob) return undefined
  if (!(await runner.run())) return { failure: "`agy models` failed, so agy could not renew the login: run `agy` and sign in if it asks" }
  const renewed = await runner.read()
  const expiry = Date.parse(str(record(decodeAgyLogin(renewed ?? undefined)?.token)?.expiry) ?? "")
  return renewed && renewed !== blob && expiry > Date.now() ? { blob: renewed } : { failure: "agy ran but left the login expired: run `agy` and sign in if it asks" }
}

type AgyUsageRunner = { usage: () => Promise<string | null>; read: () => Promise<string | null> }

const agyUsageRunner: AgyUsageRunner = {
  async usage() {
    try {
      const proc = Bun.spawn(["agy", "-p", "/usage", "--output-format", "json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000 })
      const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      return code === 0 ? out : null
    } catch {
      return null
    }
  },
  read: () => agyRunner.read(),
}

/**
 * The live login's quota as agy's own `/usage` reports it, a local command that sends no prompt.
 * Code Assist names no project for a consumer login, so its quota calls refuse kyora-switch; agy
 * knows how to ask. Only for the login agy holds, and only while its token is valid, so reading
 * usage never makes agy renew a login.
 */
export async function agyQuotaThroughAgy(blob: string | undefined, runner: AgyUsageRunner = agyUsageRunner): Promise<LiveUsage | null> {
  if (blob === undefined || (await runner.read()) !== blob) return null
  const out = await runner.usage()
  if (!out) return null
  try {
    return parseAgyQuota(record(record(JSON.parse(out))?.command)?.data ?? null)
  } catch {
    return null
  }
}

async function writeLive(blob: string): Promise<void> {
  if (!keychainSupported()) throw new Error("agy keeps its login in the macOS keychain, which kyora-switch cannot write on this platform")
  await keychainWrite(blob, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, { ascii: true })
}

/** when the stored access token runs out: the Go time agy wrote, nanoseconds and offset included */
function expiryOf(snapshot: Snapshot): number | undefined {
  const expiry = str(record(loginOf(snapshot)?.token)?.expiry)
  const parsed = expiry ? Date.parse(expiry) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

function slotBlob(snapshot: Snapshot): string {
  const blob = snapshot.files[KEYCHAIN_FILE]
  if (blob === undefined) throw new Error("slot has no Antigravity login")
  return blob
}

export const agyProvider: Provider = {
  id: "agy",
  label: "Antigravity",
  processName: "agy",
  loadsOnlyWhenIdle: true,
  loginHint: "run `agy` and sign in",

  locations() {
    const locations = keychainSupported() ? [`macOS keychain: ${AGY_KEYCHAIN_SERVICE} (${AGY_KEYCHAIN_ACCOUNT})`] : ["macOS keychain (not available on this platform)"]
    return [...locations, ...agyNotes()]
  },

  notes: agyNotes,

  async capture(): Promise<Snapshot | null> {
    if (!keychainSupported()) return null
    const blob = await keychainRead(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT)
    if (blob === null) return null
    return { provider: "agy", identity: agyIdentity(decodeAgyLogin(blob)), files: { [KEYCHAIN_FILE]: blob }, capturedAt: Date.now() }
  },

  async forget(): Promise<void> {
    if (keychainSupported()) await keychainDelete(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT)
  },

  async checkRestore(snapshot: Snapshot): Promise<void> {
    slotBlob(snapshot)
    if (!keychainSupported()) throw new Error("agy keeps its login in the macOS keychain, which kyora-switch cannot write on this platform")
  },

  async restore(snapshot: Snapshot): Promise<void> {
    await writeLive(slotBlob(snapshot))
  },

  credentialExpiry: expiryOf,

  grant(snapshot: Snapshot): string | undefined {
    return str(record(loginOf(snapshot)?.token)?.refresh_token) ?? snapshot.files[KEYCHAIN_FILE]
  },

  async refresh(snapshot: Snapshot): Promise<Renewal> {
    const blob = snapshot.files[KEYCHAIN_FILE]
    if (blob === undefined) return { failure: "no login is stored: log in to agy again and save" }
    const renewed = await refreshAgyLogin(blob)
    if ("blob" in renewed) return { snapshot: { ...snapshot, files: { ...snapshot.files, [KEYCHAIN_FILE]: renewed.blob } } }
    const viaAgy = renewed.clientRefused ? await renewThroughAgy(blob) : undefined
    if (viaAgy === undefined) return renewed.clientRefused ? { failure: `${renewed.failure.split(";")[0]}; without agy's client secret only the live login renews, through agy: load this slot, then refresh` } : renewed
    if ("failure" in viaAgy) return viaAgy
    return { snapshot: { ...snapshot, files: { ...snapshot.files, [KEYCHAIN_FILE]: viaAgy.blob } }, alreadyLive: true }
  },

  renewalMarginMs: () => EXPIRY_DELTA_MS,

  async writeRenewal(renewed: Snapshot): Promise<void> {
    await writeLive(slotBlob(renewed))
  },

  async quotaWithReason(snapshot: Snapshot): Promise<LiveUsage | QuotaUnavailable | null> {
    const token = str(record(loginOf(snapshot)?.token)?.access_token)
    if (!token) return null
    const expiry = expiryOf(snapshot)
    if (expiry !== undefined && expiry <= Date.now()) return null
    const live = await agyQuotaThroughAgy(snapshot.files[KEYCHAIN_FILE])
    if (live) return live
    const usage = await agyUsage(token)
    if (usage === AGY_UNAUTHORIZED) return { unavailable: "Google refused the stored access token: run agy once, or refresh this slot" }
    return usage
  },
}
