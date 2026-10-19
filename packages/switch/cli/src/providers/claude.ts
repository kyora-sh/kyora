import { claudeAccessToken, claudeOauthUsage, type LiveUsage } from "@kyora-sh/usage"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { readJsonIfExists, readTextIfExists, writeFileAtomic } from "../fsx"
import { claudeIdentity } from "../identity"
import { KEYCHAIN_SERVICE, keychainAccount, keychainDelete, keychainRead, keychainSupported, keychainWrite } from "../keychain"
import { LiveWriteError, tokenRequest } from "../renewal"
import { scrub, type Provider, type Renewal, type Snapshot } from "../types"

const CREDENTIALS_FILE = "credentials.json"
const ACCOUNT_FILE = "account.json"
const ACCOUNT_KEY = "oauthAccount"

const tokenUrl = () => process.env.KYORA_CLAUDE_TOKEN_URL ?? "https://platform.claude.com/v1/oauth/token"
const clientId = () => process.env.KYORA_CLAUDE_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
}

export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json")
}

function credentialsPath(): string {
  return join(claudeDir(), ".credentials.json")
}

async function readCredentials(): Promise<string | null> {
  if (keychainSupported()) {
    const credentials = await keychainRead()
    if (credentials !== null) return credentials
  }
  return await readTextIfExists(credentialsPath())
}

async function writeCredentials(value: string): Promise<void> {
  if (keychainSupported()) {
    await keychainWrite(value)
  }
  await writeFileAtomic(credentialsPath(), value, 0o600)
}

/**
 * Swaps the account identity and nothing else, so projects, machine state and the
 * caches the CLI refetches for itself all survive a switch untouched.
 */
export function mergeAccountIntoConfig(
  config: Record<string, unknown>,
  account: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...config }
  if (ACCOUNT_KEY in account) merged[ACCOUNT_KEY] = account[ACCOUNT_KEY]
  else delete merged[ACCOUNT_KEY]
  return merged
}

interface OauthBlob {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  refreshTokenExpiresAt?: number
  scopes?: string[]
}

/** Claude Code renews its access token once it is within this long of expiring */
const RENEWAL_MARGIN_MS = 5 * 60 * 1000

/**
 * Trades a stored refresh token for a fresh access token, the same call the CLI
 * makes when its own token ages out. The refresh token rotates, so the caller
 * must persist the result or the slot is left holding a spent credential.
 */
export async function refreshCredentials(credentials: string): Promise<{ text: string } | { failure: string }> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(credentials)
  } catch {
    return { failure: "the stored login is unreadable: log in again and save" }
  }
  const oauth = parsed.claudeAiOauth as OauthBlob | undefined
  if (!oauth?.refreshToken) return { failure: "no refresh token is stored: log in again and save" }

  const answer = await tokenRequest(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: clientId(),
      scope: (oauth.scopes ?? []).join(" "),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if ("failure" in answer) return answer
  const data = answer.data
  if (typeof data.access_token !== "string") return { failure: "the token server's answer had no access token" }

  const now = Date.now()
  const next: OauthBlob = {
    ...oauth,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : oauth.refreshToken,
    expiresAt: typeof data.expires_in === "number" ? now + data.expires_in * 1000 : oauth.expiresAt,
    refreshTokenExpiresAt:
      typeof data.refresh_token_expires_in === "number"
        ? now + data.refresh_token_expires_in * 1000
        : oauth.refreshTokenExpiresAt,
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : oauth.scopes,
  }
  return { text: JSON.stringify({ ...parsed, claudeAiOauth: next }) }
}

export function accountSlice(config: Record<string, unknown> | null): Record<string, unknown> {
  return config && ACCOUNT_KEY in config ? { [ACCOUNT_KEY]: config[ACCOUNT_KEY] } : {}
}

export const claudeProvider: Provider = {
  id: "claude",
  label: "Claude Code",
  processName: "claude(\\.exe)?",
  /** npm installs before the native binary: `node <prefix>/bin/claude`, through its bin link, or `node .../claude-code/cli.js` (or bun) */
  nodeScript: /(?:^|[\s/])(?:\.?bin\/claude|@anthropic-ai\/claude-code\/cli\.js)(?=\s|$)/,
  loginHint: "run `claude` and use /login",

  locations() {
    const store = keychainSupported()
      ? `macOS keychain: ${KEYCHAIN_SERVICE} (${keychainAccount()})`
      : credentialsPath()
    return [...new Set([store, credentialsPath(), claudeConfigPath()])]
  },

  async capture(): Promise<Snapshot | null> {
    const credentials = await readCredentials()
    if (credentials === null) return null

    const slice = accountSlice(await readJsonIfExists(claudeConfigPath()))
    const files: Record<string, string> = {
      [CREDENTIALS_FILE]: credentials,
      [ACCOUNT_FILE]: `${JSON.stringify(slice, null, 2)}\n`,
    }
    return { provider: "claude", identity: claudeIdentity(slice), files, capturedAt: Date.now() }
  },

  async forget(): Promise<void> {
    await rm(credentialsPath(), { force: true })
    if (keychainSupported()) await keychainDelete()

    const config = await readJsonIfExists(claudeConfigPath())
    if (config) await writeFileAtomic(claudeConfigPath(), `${JSON.stringify(mergeAccountIntoConfig(config, {}), null, 2)}\n`)
  },

  credentialExpiry(snapshot: Snapshot): number | undefined {
    try {
      const expiresAt = JSON.parse(snapshot.files[CREDENTIALS_FILE] ?? "{}")?.claudeAiOauth?.expiresAt
      return typeof expiresAt === "number" ? expiresAt : undefined
    } catch {
      return undefined
    }
  },

  grant(snapshot: Snapshot): string | undefined {
    try {
      const oauth = JSON.parse(snapshot.files[CREDENTIALS_FILE] ?? "{}")?.claudeAiOauth as OauthBlob | undefined
      const secret = oauth?.refreshToken || oauth?.accessToken
      return typeof secret === "string" && secret ? secret : undefined
    } catch {
      return undefined
    }
  },

  async refresh(snapshot: Snapshot): Promise<Renewal> {
    const credentials = snapshot.files[CREDENTIALS_FILE]
    if (credentials === undefined) return { failure: "no credentials are stored: log in again and save" }
    const refreshed = await refreshCredentials(credentials)
    if ("failure" in refreshed) return refreshed
    return { snapshot: { ...snapshot, files: { ...snapshot.files, [CREDENTIALS_FILE]: refreshed.text } } }
  },

  renewalMarginMs: () => RENEWAL_MARGIN_MS,

  /** the renewed credentials into the keychain and the file both, as a load writes them; the account in .claude.json is untouched */
  async writeRenewal(renewed: Snapshot): Promise<void> {
    const credentials = renewed.files[CREDENTIALS_FILE]
    if (credentials === undefined) throw new Error("the renewal has no Claude credentials")
    const file = credentialsPath()
    const reason = (error: unknown) => scrub(error instanceof Error ? error.message : String(error))
    const keychain = keychainSupported()
    if (keychain) {
      try {
        await keychainWrite(credentials)
      } catch (error) {
        throw new LiveWriteError(`the keychain could not be written (${reason(error)}); it and ${file} still hold the spent token`)
      }
    }
    try {
      await writeFileAtomic(file, credentials, 0o600)
    } catch (error) {
      throw new LiveWriteError(
        keychain
          ? `the keychain holds the renewal, which Claude Code reads first, but ${file} could not be written (${reason(error)}) and still holds the spent token`
          : `${file} could not be written (${reason(error)}) and still holds the spent token`,
      )
    }
  },

  async quota(snapshot: Snapshot): Promise<LiveUsage | null> {
    const token = claudeAccessToken(snapshot.files[CREDENTIALS_FILE] ?? "")
    return token ? await claudeOauthUsage(token) : null
  },

  async restore(snapshot: Snapshot): Promise<void> {
    const credentials = snapshot.files[CREDENTIALS_FILE]
    if (credentials === undefined) throw new Error("slot has no Claude credentials")
    await writeCredentials(credentials)

    const account = JSON.parse(snapshot.files[ACCOUNT_FILE] ?? "{}") as Record<string, unknown>
    const config = (await readJsonIfExists(claudeConfigPath())) ?? {}
    await writeFileAtomic(claudeConfigPath(), `${JSON.stringify(mergeAccountIntoConfig(config, account), null, 2)}\n`)
  },
}
