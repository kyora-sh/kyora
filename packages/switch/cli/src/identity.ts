import { createHash } from "node:crypto"
import type { Identity } from "./types"

/** Decode a JWT payload without verifying the signature: this is display only. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1]
  if (!segment) return null
  try {
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/** Pull the account out of `~/.codex/auth.json`: the id_token carries it, an API key does not. */
export function codexIdentity(auth: unknown): Identity {
  const root = record(auth) ?? {}
  const tokens = record(root.tokens) ?? {}
  const idToken = str(tokens.id_token)
  const payload = idToken ? (jwtPayload(idToken) ?? {}) : {}
  const claims = record(payload["https://api.openai.com/auth"]) ?? {}
  const account = str(payload.email) ?? str(claims.chatgpt_account_id) ?? str(tokens.account_id)
  const plan = str(claims.chatgpt_plan_type) ?? (str(root.OPENAI_API_KEY) ? "api key" : undefined)
  return { account, plan }
}

/**
 * Who a Codex auth.json is signed in as, by ids that don't change: the ChatGPT account (workspace) it
 * acts in and the user within it, from the id token's claims (the access token's when it has none).
 * The email is not one: it can change, and two users of one workspace are two people. `user` is
 * undefined when no token names one.
 */
export function codexPrincipal(auth: unknown): { account: string; user: string | undefined } | null {
  const tokens = record(record(auth)?.tokens) ?? {}
  const account = str(tokens.account_id)
  if (!account) return null
  for (const token of [str(tokens.id_token), str(tokens.access_token)]) {
    const payload = token ? jwtPayload(token) : null
    const claims = record(payload?.["https://api.openai.com/auth"])
    if (!claims) continue
    const same = str(claims.chatgpt_account_id) === undefined || claims.chatgpt_account_id === account
    // Codex reads chatgpt_user_id, else user_id; the membership id only belongs to the account it names
    const user = str(claims.chatgpt_user_id) ?? str(claims.user_id) ?? (same ? str(claims.chatgpt_account_user_id) : undefined)
    if (user) return { account, user }
  }
  return { account, user: undefined }
}

/** The credential an opencode auth entry stands for: the API key, or an oauth entry's account id. */
export function opencodeCredential(entry: unknown): string | undefined {
  const auth = record(entry)
  return str(auth?.key) ?? str(auth?.accountId)
}

/**
 * The account doubles as the key `syncLiveSlot` matches slots on, so it cannot be the
 * last four characters alone: two keys that share them would overwrite each other's
 * slot. Those four stay for the eye, since the OpenCode console shows the same ones,
 * and a short hash of the whole key keeps every credential distinct.
 */
export function opencodeAccount(credential: string): string {
  const fingerprint = createHash("sha256").update(credential).digest("hex").slice(0, 8)
  return `key …${credential.slice(-4)} #${fingerprint}`
}

/**
 * Go and Zen logins are bare API keys with no email behind them, so they are named by
 * the key itself. The Go key names the login when there is one, Zen's otherwise.
 */
export function opencodeIdentity(auth: unknown): Identity {
  const root = record(auth) ?? {}
  const go = record(root["opencode-go"])
  const zen = record(root.opencode)
  const credential = opencodeCredential(go) ?? opencodeCredential(zen)
  return {
    account: credential ? opencodeAccount(credential) : undefined,
    plan: go && zen ? "Go + Zen" : go ? "Go" : zen ? "Zen" : undefined,
  }
}

/**
 * The `providers.meta` entry of a Muse `auth.json` document, or the document
 * itself when it is already a bare credential (the keychain blob's shape).
 * Null when neither names a meta credential.
 */
export function museMeta(auth: unknown): Record<string, unknown> | null {
  const root = record(auth)
  if (!root) return null
  const providers = record(root.providers)
  const meta = record(providers?.meta) ?? record(root.meta)
  if (meta) return meta
  return "access_token" in root || "refresh_token" in root || "api_key" in root || "mechanism" in root ? root : null
}

/** a Muse login stored as an API key (`muse auth set`) rather than an account login */
export function museApiKeyLogin(meta: Record<string, unknown>): boolean {
  return meta.mechanism === "api_key" || (meta.mechanism !== "oauth" && str(meta.api_key) !== undefined)
}

/**
 * Who a Muse login is, from its stored credential: the account email; the full
 * name only as a display name when there is no email, since names are not unique.
 * The plan is the subscription tier, else a stored key's "api key". Never any
 * part of a token or key.
 */
export function museIdentity(auth: unknown): Identity {
  const meta = museMeta(auth) ?? {}
  const subscribed = meta.is_subs_active === true || meta.subs_active === true
  const apiKey = museApiKeyLogin(meta)
  const account = str(meta.user_email)
  const name = account === undefined ? str(meta.user_full_name) : undefined
  return {
    account,
    ...(name !== undefined ? { name } : {}),
    plan: str(meta.subs_tier_name) ?? str(meta.subs_tier_id) ?? str(meta.tier) ?? (subscribed ? "subscription" : apiKey ? "api key" : undefined),
  }
}

/** Pull the account out of the `oauthAccount` slice of `~/.claude.json`. */
export function claudeIdentity(account: unknown): Identity {
  const oauth = record(record(account)?.oauthAccount) ?? {}
  return {
    account: str(oauth.emailAddress) ?? str(oauth.accountUuid),
    org: str(oauth.organizationName),
    plan: str(oauth.seatTier) ?? str(oauth.billingType),
  }
}

/**
 * Who a Grok Build login is, from its auth.json entry: the account email, the full name only
 * as a display name when there is none, the team (or organization) a team login acts for. A
 * team login carries no email, so a login without one is matched by its sign-in scope and its
 * user id, and one acting for a team (or, without an email, an organization) by its scope and that
 * principal alone: grok rewrites such a login's user id once it looks the user up. A stored API
 * key is named by the key, like an OpenCode one. Never any part of a session token.
 */
export function grokIdentity(entry: unknown, scope?: string): Identity {
  const auth = record(entry)
  if (!auth) return {}
  if (auth.auth_mode === "api_key") {
    const key = str(auth.key)
    return { account: key ? opencodeAccount(key) : undefined, plan: "api key" }
  }
  const account = str(auth.email)
  const name = [str(auth.first_name), str(auth.last_name)].filter(Boolean).join(" ")
  const org = str(auth.team_name) ?? str(auth.organization_name)
  const team = auth.principal_type === "Team"
  const organization = account === undefined && auth.principal_type === "Organization"
  const user = str(auth.user_id)
  const principal = str(auth.principal_id) ?? (team ? str(auth.team_id) : str(auth.organization_id))
  // a team or organization login without its principal has no stable id at all
  const key = team || organization ? principal && `${auth.principal_type} ${principal}` : account === undefined ? user : undefined
  const id = scope && key ? `${scope} ${key}` : undefined
  return {
    account,
    ...(account === undefined && name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(org ? { org } : {}),
    ...(team ? { plan: "team" } : {}),
  }
}
