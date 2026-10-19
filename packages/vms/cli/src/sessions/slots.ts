import { readdir, readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { sha256, writeAtomic } from "./agents"

/**
 * kyora-switch's slots, as packages/switch/cli lays them out: `$KYORA_SWITCH_DIR` (default
 * `~/.kyora/switch`)/<provider>/<slot>/ holds `slot.json` ({ name, provider, identity, createdAt,
 * updatedAt }) and the login's files: `credentials.json` (Claude Code's OAuth blob,
 * `{claudeAiOauth: {accessToken, refreshToken, expiresAt, scopes, …}}`) and `account.json` for
 * Claude, `auth.json` for Codex. `creds sync` never touches a slot's login; it marks the slot
 * `cloudOwned` in its slot.json, so kyora-switch leaves it alone (no copying the live login into
 * it, no refreshing it) while kyora cloud's broker owns it. `creds return` puts the login the
 * broker kept refreshing back into its slot, in that same format, and clears the mark.
 */

export type SlotProvider = "claude" | "codex"

export const switchRoot = (env: Record<string, string | undefined> = process.env): string => env.KYORA_SWITCH_DIR || join(env.HOME || homedir(), ".kyora", "switch")

/** kyora-switch's own rule for slot names; they are path segments */
export const SLOT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export interface SlotRead {
  name: string
  provider: SlotProvider
  identity: { account?: string; org?: string; plan?: string }
  files: Record<string, string>
  updatedAt: number
  /** kyora cloud's broker owns it (written by `creds sync`, cleared by `creds return`) */
  cloudOwned: CloudOwned | null
}

/** slot.json's mark on a slot kyora cloud's broker owns; kyora-switch skips a slot that has one */
export interface CloudOwned {
  at: number
  by: string
  /** the login's fingerprint as it went up (fingerprintOf its refresh token) */
  fingerprint: string
}

export async function listSlots(provider: SlotProvider): Promise<string[]> {
  const names = await readdir(join(switchRoot(), provider)).catch(() => [] as string[])
  return names.filter((name) => SLOT_NAME.test(name)).sort()
}

export async function readSlot(provider: SlotProvider, name: string): Promise<SlotRead | null> {
  if (!SLOT_NAME.test(name)) throw new Error(`invalid slot name "${name}"`)
  const dir = join(switchRoot(), provider, name)
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(await readFile(join(dir, "slot.json"), "utf8"))
  } catch {
    return null
  }
  const files: Record<string, string> = {}
  for (const file of await readdir(dir)) {
    if (file === "slot.json" || file.endsWith(".tmp")) continue
    files[file] = await readFile(join(dir, file), "utf8")
  }
  const owned = meta.cloudOwned
  return {
    name,
    provider,
    identity: (meta.identity as SlotRead["identity"]) ?? {},
    files,
    updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
    cloudOwned: owned && typeof owned === "object" ? (owned as CloudOwned) : owned ? { at: 0, by: "unknown", fingerprint: "" } : null,
  }
}

/** slot.json, rewritten atomically (0600) with `change` applied and every other field kept */
async function rewriteMeta(provider: SlotProvider, name: string, change: (meta: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  if (!SLOT_NAME.test(name)) throw new Error(`invalid slot name "${name}"`)
  const path = join(switchRoot(), provider, name, "slot.json")
  const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  await writeAtomic(path, `${JSON.stringify(change(meta), null, 2)}\n`, 0o600)
}

/** marks the slot as the broker's (`creds sync`): kyora-switch then never syncs into it or refreshes it */
export async function markCloudOwned(provider: SlotProvider, name: string, fingerprint: string, now = Date.now()): Promise<void> {
  await rewriteMeta(provider, name, (meta) => ({ ...meta, cloudOwned: { at: now, by: "kyora session creds sync", fingerprint } }))
}

/** the broker let go of it (`creds return`, `creds rm`): kyora-switch's again */
export async function clearCloudOwned(provider: SlotProvider, name: string): Promise<void> {
  await rewriteMeta(provider, name, ({ cloudOwned: _owned, ...meta }) => meta).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  })
}

export type CredentialKind = "oauth" | "oauth-token" | "api-key"

export interface SlotCredential {
  kind: CredentialKind
  /** the text the broker keeps: Claude's whole credentials blob, or a bare token or key */
  credential: string
  /**
   * Tells two logins apart without revealing either: a hash of the refresh token (OAuth) or of
   * the key. The refresh-rotation guard compares it: the slot changed under the broker.
   */
  fingerprint: string
  expiresAt?: number
}

export const fingerprintOf = (secret: string): string => sha256(`kyora-slot:${secret}`).slice(0, 24)

/** what a slot's files hold, as the broker takes it */
export function slotCredential(slot: SlotRead): SlotCredential {
  if (slot.provider === "claude") {
    const blob = slot.files["credentials.json"]
    if (!blob) throw new Error(`slot claude/${slot.name} has no credentials.json`)
    const oauth = (JSON.parse(blob) as { claudeAiOauth?: { refreshToken?: unknown; accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth
    const refresh = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : null
    const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : null
    if (!refresh && !access) throw new Error(`slot claude/${slot.name} holds no Claude Code login`)
    return { kind: "oauth", credential: blob, fingerprint: fingerprintOf(refresh ?? access!), ...(typeof oauth?.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}) }
  }
  const auth = slot.files["auth.json"]
  if (!auth) throw new Error(`slot codex/${slot.name} has no auth.json`)
  const parsed = JSON.parse(auth) as { OPENAI_API_KEY?: unknown; tokens?: { refresh_token?: unknown } }
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY) return { kind: "api-key", credential: parsed.OPENAI_API_KEY, fingerprint: fingerprintOf(parsed.OPENAI_API_KEY) }
  const refresh = typeof parsed.tokens?.refresh_token === "string" ? parsed.tokens.refresh_token : null
  if (!refresh) throw new Error(`slot codex/${slot.name} holds no Codex login`)
  return { kind: "oauth", credential: auth, fingerprint: fingerprintOf(refresh) }
}

/**
 * Where Claude Code keeps its login on macOS, as 2.1.288 names it (read out of the binary; the
 * keychain itself is never read for this): service `Claude Code-credentials`, plus
 * `-<first 8 hex of sha256(the config dir, NFC)>` when CLAUDE_CONFIG_DIR is set (or
 * CLAUDE_SECURESTORAGE_CONFIG_DIR, which takes precedence and names the hashed directory itself),
 * and the account `$USER` (else the login name; `claude-code-user` when it has odd characters).
 */
export function claudeKeychainService(env: Record<string, string | undefined> = process.env): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const suffixed = secure !== undefined ? secure !== "" : Boolean(env.CLAUDE_CONFIG_DIR)
  if (!suffixed) return "Claude Code-credentials"
  const dir = (secure !== undefined ? secure : (env.CLAUDE_CONFIG_DIR ?? "")).normalize("NFC")
  return `Claude Code-credentials-${sha256(dir).slice(0, 8)}`
}

export function claudeKeychainAccount(env: Record<string, string | undefined> = process.env): string {
  let user: string
  try {
    user = env.USER || userInfo().username
  } catch {
    return "claude-code-user"
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user"
}

/** Claude Code's plaintext credentials file: `<secure storage dir, else the config dir>/.credentials.json` */
export function claudeCredentialsFile(env: Record<string, string | undefined> = process.env): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const dir = secure !== undefined ? secure || join(env.HOME || homedir(), ".claude") : (env.CLAUDE_CONFIG_DIR ?? join(env.HOME || homedir(), ".claude"))
  return join(dir.normalize("NFC"), ".credentials.json")
}

/** reads one keychain item (`security find-generic-password … -w`), or null */
export type KeychainReader = (service: string, account: string) => Promise<string | null>

const securityRead: KeychainReader = async (service, account) => {
  const result = await Bun.$`security find-generic-password -a ${account} -w -s ${service}`.quiet().nothrow()
  const value = result.exitCode === 0 ? result.stdout.toString().trim() : ""
  return value && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value) ? Buffer.from(value, "hex").toString("utf8") : value || null
}

/**
 * The live Claude Code login on this laptop, by fingerprint, to keep `creds sync` from handing
 * the broker the very grant this laptop's CLI refreshes (the two would rotate its refresh token
 * out from under each other). Its credentials file, else the macOS keychain item Claude Code keeps
 * for that config dir (read only; never with KYORA_SWITCH_NO_KEYCHAIN=1, as in tests, unless a
 * reader is handed in).
 */
export async function liveClaudeFingerprint(
  env: Record<string, string | undefined> = process.env,
  keychain: { platform?: string; read?: KeychainReader } = {},
): Promise<string | null> {
  let blob = await readFile(claudeCredentialsFile(env), "utf8").catch(() => null)
  const reader = keychain.read ?? (env.KYORA_SWITCH_NO_KEYCHAIN === "1" || env.NODE_ENV === "test" ? null : securityRead)
  if (blob === null && (keychain.platform ?? process.platform) === "darwin" && reader) blob = await reader(claudeKeychainService(env), claudeKeychainAccount(env))
  if (!blob) return null
  try {
    const oauth = (JSON.parse(blob) as { claudeAiOauth?: { refreshToken?: unknown } }).claudeAiOauth
    return typeof oauth?.refreshToken === "string" ? fingerprintOf(oauth.refreshToken) : null
  } catch {
    return null
  }
}

/**
 * `creds return`: the login the broker kept fresh goes back into its slot. Only the credentials
 * file is replaced, atomically and 0600, and `slot.json`'s updatedAt moves, exactly as a
 * kyora-switch save would leave them; the cloud's mark goes.
 */
export async function writeBackSlot(provider: SlotProvider, name: string, file: string, contents: string, now = Date.now()): Promise<void> {
  if (!SLOT_NAME.test(name)) throw new Error(`invalid slot name "${name}"`)
  const dir = join(switchRoot(), provider, name)
  await readFile(join(dir, "slot.json"), "utf8")
  await writeAtomic(join(dir, file), contents, 0o600)
  await rewriteMeta(provider, name, ({ cloudOwned: _owned, ...meta }) => ({ ...meta, updatedAt: now }))
}
