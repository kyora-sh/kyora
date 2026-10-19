import { homedir } from "node:os"
import { join } from "node:path"

export interface LiveUsage {
  remainingPct: number
  detail: string
  windows?: UsageWindow[]
  /** the subscription tier the windows belong to, when the vendor names it */
  plan?: string
}

export interface UsageWindow {
  label: string
  usedPct: number
  resetsAt?: number
  active?: boolean
}

/**
 * Tolerant extraction of used/total credit figures from the undocumented
 * Bailian token-plan console payload: field casing and nesting drift, so any
 * object carrying a used+total numeric pair counts.
 */
export function parseTokenPlanUsage(payload: unknown): LiveUsage | null {
  const found = findUsagePair(payload)
  if (!found || found.total <= 0) return null
  const remaining = Math.max(0, found.total - found.used)
  return {
    remainingPct: Math.round((remaining / found.total) * 100),
    detail: `${remaining.toLocaleString()} of ${found.total.toLocaleString()} credits left`,
  }
}

function findUsagePair(node: unknown): { used: number; total: number } | null {
  if (node === null || typeof node !== "object") return null
  const obj = node as Record<string, unknown>
  let used: number | null = null
  let total: number | null = null
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "number") continue
    const lower = key.toLowerCase()
    if (lower.includes("used")) used = value
    else if (lower.includes("total")) total = value
  }
  if (used !== null && total !== null) return { used, total }
  for (const value of Object.values(obj)) {
    const nested = findUsagePair(value)
    if (nested) return nested
  }
  return null
}

/**
 * Generic quota-window extraction for vendor usage payloads (kimi, z.ai):
 * collects objects carrying a used+limit numeric pair; the tightest window
 * determines the remaining percentage.
 */
export function parseQuotaWindows(payload: unknown): LiveUsage | null {
  const windows: { used: number; limit: number; label: string }[] = []
  collectWindows(payload, windows)
  let worst = -1
  const parts: string[] = []
  for (const window of windows.slice(0, 3)) {
    const pct = Math.max(0, Math.round((1 - window.used / window.limit) * 100))
    worst = worst === -1 ? pct : Math.min(worst, pct)
    parts.push(`${window.used.toLocaleString()}/${window.limit.toLocaleString()}${window.label ? ` ${window.label}` : ""}`)
  }
  if (worst === -1) return null
  return { remainingPct: worst, detail: parts.join(" · ") }
}

function collectWindows(node: unknown, out: { used: number; limit: number; label: string }[]): void {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) collectWindows(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  let used: number | null = null
  let limit: number | null = null
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "number") continue
    const lower = key.toLowerCase()
    if (lower.includes("used") || lower === "usage") used = value
    else if (lower.includes("limit") || lower.includes("total") || lower.includes("quota")) limit = value
  }
  if (used !== null && limit !== null && limit > 0) {
    const label = ["window", "scope", "name", "type", "period"]
      .map((key) => obj[key])
      .find((value): value is string => typeof value === "string")
    out.push({ used, limit, label: label ?? "" })
    return
  }
  for (const value of Object.values(obj)) collectWindows(value, out)
}

/**
 * Z.ai's monitor payload reports per-window percentages (TIME_LIMIT /
 * TOKENS_LIMIT entries with `percentage` used); the tightest window wins.
 */
export function parseZaiQuota(payload: unknown): LiveUsage | null {
  const windows: { pct: number; label: string }[] = []
  collectPercentages(payload, windows)
  if (windows.length === 0) return parseQuotaWindows(payload)
  const worst = Math.max(...windows.map((window) => window.pct))
  return {
    remainingPct: Math.max(0, Math.round(100 - worst)),
    detail: windows
      .slice(0, 3)
      .map((window) => `${window.label}${Math.round(window.pct)}% used`)
      .join(" · "),
  }
}

function collectPercentages(node: unknown, out: { pct: number; label: string }[]): void {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) collectPercentages(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  if (typeof obj.percentage === "number") {
    const label = typeof obj.type === "string" ? `${obj.type.toLowerCase().replace("_limit", "")} ` : ""
    out.push({ pct: obj.percentage, label })
  }
  for (const value of Object.values(obj)) collectPercentages(value, out)
}

/**
 * Claude's OAuth usage payload carries a `limits` array covering session, weekly
 * and per-model weekly windows; the older top-level keys are the fallback.
 */
export function parseClaudeOauthUsage(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const obj = payload as Record<string, unknown>
  const windows = Array.isArray(obj.limits) ? claudeLimitWindows(obj.limits) : []
  return summarize(windows.length > 0 ? windows : claudeLegacyWindows(obj))
}

function summarize(windows: UsageWindow[]): LiveUsage | null {
  if (windows.length === 0) return null
  const worst = Math.max(...windows.map((window) => window.usedPct))
  return {
    remainingPct: Math.max(0, Math.round(100 - worst)),
    detail: windows.map((window) => `${window.label} ${window.usedPct}% used`).join(" · "),
    windows,
  }
}

function claudeLimitWindows(limits: unknown[]): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const entry of limits) {
    if (entry === null || typeof entry !== "object") continue
    const limit = entry as Record<string, unknown>
    if (typeof limit.percent !== "number") continue
    windows.push({
      label: claudeLimitLabel(limit),
      usedPct: Math.round(limit.percent),
      resetsAt: parseTimestamp(limit.resets_at),
      active: limit.is_active === true,
    })
  }
  return windows
}

function claudeLimitLabel(limit: Record<string, unknown>): string {
  const kind = typeof limit.kind === "string" ? limit.kind : "limit"
  const scope = limit.scope as Record<string, unknown> | null | undefined
  const model = scope?.model as Record<string, unknown> | null | undefined
  const name = typeof model?.display_name === "string" ? model.display_name : undefined
  if (kind === "session") return "session"
  if (kind === "weekly_all") return "weekly"
  if (kind === "weekly_scoped") return name ? `weekly ${name}` : "weekly scoped"
  return name ? `${kind} ${name}` : kind
}

function claudeLegacyWindows(obj: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const window = obj[key]
    if (window === null || typeof window !== "object") continue
    const util = utilizationOf(window as Record<string, unknown>)
    if (util === null) continue
    windows.push({ label, usedPct: Math.round(util), resetsAt: resetsAtOf(window as Record<string, unknown>) })
  }
  return windows
}

function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw > 1e11 ? raw : raw * 1000
  if (typeof raw !== "string") return undefined
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

function resetsAtOf(window: Record<string, unknown>): number | undefined {
  return parseTimestamp(window.resets_at)
}

function utilizationOf(window: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(window)) {
    if (typeof value !== "number") continue
    if (/util|percent|pct/i.test(key)) return value < 1 ? value * 100 : value
  }
  return null
}

async function probeJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/** Pulls the OAuth access token out of a Claude Code credentials blob. */
export function claudeAccessToken(credentials: string): string | undefined {
  try {
    const token = JSON.parse(credentials)?.claudeAiOauth?.accessToken
    return typeof token === "string" && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/** Asks Anthropic what is left on the five-hour and seven-day windows for one token. */
/** A test override of a vendor URL: only a loopback address, so a stray env var can never send a bearer token elsewhere. */
export function vendorUrl(name: string, fallback: string): string {
  const value = process.env[name]
  if (!value) return fallback
  try {
    const { hostname, protocol } = new URL(value)
    if ((protocol === "http:" || protocol === "https:") && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) return value
  } catch {}
  return fallback
}

export async function claudeOauthUsage(token: string): Promise<LiveUsage | null> {
  const payload = await probeJson(vendorUrl("KYORA_CLAUDE_USAGE_URL", "https://api.anthropic.com/api/oauth/usage"), {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  })
  return payload ? parseClaudeOauthUsage(payload) : null
}

export async function bearerUsage(
  url: string,
  key: string,
  parse: (payload: unknown) => LiveUsage | null,
): Promise<LiveUsage | null> {
  const payload = await probeJson(url, { authorization: `Bearer ${key}` })
  return payload ? parse(payload) : null
}

function windowLabel(seconds: unknown): string {
  if (typeof seconds !== "number" || seconds <= 0) return "window"
  const hours = Math.round(seconds / 3600)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function codexWindows(rateLimit: unknown, prefix = ""): UsageWindow[] {
  if (rateLimit === null || typeof rateLimit !== "object") return []
  const limit = rateLimit as Record<string, unknown>
  const windows: UsageWindow[] = []
  for (const key of ["primary_window", "secondary_window"]) {
    const window = limit[key]
    if (window === null || typeof window !== "object") continue
    const entry = window as Record<string, unknown>
    if (typeof entry.used_percent !== "number") continue
    windows.push({
      label: `${prefix}${windowLabel(entry.limit_window_seconds)}`,
      usedPct: Math.round(entry.used_percent),
      resetsAt: parseTimestamp(entry.reset_at),
    })
  }
  return windows
}

/** Reads the plan window plus any model-scoped limits out of Codex's usage payload. */
export function parseCodexUsage(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const obj = payload as Record<string, unknown>
  const windows = codexWindows(obj.rate_limit)

  if (Array.isArray(obj.additional_rate_limits)) {
    for (const entry of obj.additional_rate_limits) {
      if (entry === null || typeof entry !== "object") continue
      const extra = entry as Record<string, unknown>
      const name = typeof extra.limit_name === "string" ? `${extra.limit_name} ` : ""
      windows.push(...codexWindows(extra.rate_limit, name))
    }
  }
  return summarize(windows)
}

/** Pulls the ChatGPT access token and account id out of a Codex auth.json blob. */
export function codexCredentials(auth: string): { token: string; account: string } | null {
  try {
    const tokens = JSON.parse(auth)?.tokens
    const token = tokens?.access_token
    const account = tokens?.account_id
    return typeof token === "string" && typeof account === "string" ? { token, account } : null
  } catch {
    return null
  }
}

/** Asks ChatGPT what is left on the Codex plan windows for one account. */
export async function codexUsage(token: string, account: string): Promise<LiveUsage | null> {
  const payload = await probeJson(vendorUrl("KYORA_CODEX_USAGE_URL", "https://chatgpt.com/backend-api/wham/usage"), {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": account,
    accept: "application/json",
  })
  return payload ? parseCodexUsage(payload) : null
}

export function parseCodexLifetimeTokens(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null
  const stats = (payload as Record<string, unknown>).stats
  if (!stats || typeof stats !== "object") return null
  const total = (stats as Record<string, unknown>).lifetime_tokens
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null
}

export async function codexLifetimeTokens(token: string, account: string): Promise<number | null> {
  const payload = await probeJson(vendorUrl("KYORA_CODEX_TOKENS_URL", "https://chatgpt.com/backend-api/wham/profiles/me"), {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": account,
    "user-agent": "codex-cli",
    accept: "application/json",
  })
  return parseCodexLifetimeTokens(payload)
}

/** opencode's provider logins, under the xdg-basedir data dir it uses on macOS too. */
export function opencodeAuthPath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")
}

/** OpenCode Go (`opencode-go`) and its pay-as-you-go sibling Zen (`opencode`), as auth.json names them. */
export type OpencodeSubscription = "opencode-go" | "opencode"

/** Pulls the Go or Zen API key out of opencode's auth.json text. */
export function opencodeKey(auth: string, provider: OpencodeSubscription = "opencode-go"): string | undefined {
  try {
    const key = JSON.parse(auth)?.[provider]?.key
    return typeof key === "string" && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

const OPENCODE_GO_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
] as const

/**
 * Go's limits are dollar amounts, but its usage route reports each window as a
 * floored percentage: a rolling five hours, the calendar week, and a month
 * anchored on the subscription date.
 */
export function parseOpencodeGoUsage(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const usage = (payload as Record<string, unknown>).usage
  if (usage === null || typeof usage !== "object") return null

  const windows: UsageWindow[] = []
  for (const [key, label] of OPENCODE_GO_WINDOWS) {
    const window = (usage as Record<string, unknown>)[key]
    if (window === null || typeof window !== "object") continue
    const entry = window as Record<string, unknown>
    if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue
    const usedPct = entry.status === "rate-limited" ? 100 : Math.min(100, Math.max(0, Math.round(entry.percent)))
    windows.push({ label, usedPct, resetsAt: parseTimestamp(entry.resetsAt) })
  }
  return summarize(windows)
}

/** Asks OpenCode what is left on a Go key's five-hour, weekly and monthly windows. */
export async function opencodeGoUsage(key: string): Promise<LiveUsage | null> {
  const payload = await probeJson(vendorUrl("KYORA_OPENCODE_USAGE_URL", "https://opencode.ai/zen/go/v1/usage"), {
    authorization: `Bearer ${key}`,
    accept: "application/json",
    "user-agent": "kyora-usage",
  })
  return payload ? parseOpencodeGoUsage(payload) : null
}

function grokCents(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined
  // proto3 JSON leaves a zero out, so a $0 amount arrives as {}
  const cents = (value as Record<string, unknown>).val ?? 0
  return typeof cents === "number" && Number.isFinite(cents) ? cents : undefined
}

function grokPeriodLabel(type: unknown): string {
  if (typeof type !== "string") return "period"
  if (/WEEK/i.test(type)) return "weekly"
  if (/MONTH/i.test(type)) return "monthly"
  if (/DAY/i.test(type)) return "daily"
  return "period"
}

/**
 * Grok Build's credits config: the share of the included credits used in the current period
 * (weekly or monthly), else the older monthly limit and spend in cents. proto3 JSON omits a
 * zero percentage, so a period with no percentage is one with nothing used yet.
 */
export function parseGrokBilling(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const config = (payload as Record<string, unknown>).config
  if (config === null || typeof config !== "object") return null
  const obj = config as Record<string, unknown>
  const period = obj.currentPeriod !== null && typeof obj.currentPeriod === "object" ? (obj.currentPeriod as Record<string, unknown>) : undefined
  const limit = grokCents(obj.monthlyLimit)
  let used: number | undefined
  if (typeof obj.creditUsagePercent === "number" && Number.isFinite(obj.creditUsagePercent)) used = obj.creditUsagePercent
  else if (limit !== undefined && limit > 0) used = ((grokCents(obj.used) ?? 0) / limit) * 100
  else if (period) used = 0
  if (used === undefined) return null
  return summarize([
    {
      label: period ? grokPeriodLabel(period.type) : "monthly",
      usedPct: Math.min(100, Math.max(0, Math.round(used))),
      resetsAt: parseTimestamp(period?.end ?? obj.billingPeriodEnd),
    },
  ])
}

/** the grok release whose `/usage` call grokUsage repeats, sent as its client version */
const GROK_CLIENT_VERSION = "1.0.52"

/** Asks Grok Build's CLI proxy what is left of a login's included credits, the call `/usage` makes, headers included. */
export async function grokUsage(token: string, userId: string): Promise<LiveUsage | null> {
  const payload = await probeJson(vendorUrl("KYORA_GROK_USAGE_URL", "https://cli-chat-proxy.grok.com/v1/billing?format=credits"), {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    ...(userId ? { "x-userid": userId } : {}),
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-mode": "headless",
    accept: "application/json",
  })
  return payload ? parseGrokBilling(payload) : null
}

function decimal(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function museWindow(used: unknown, limit: unknown, label: string, resetsAt: unknown): UsageWindow | null {
  const spent = decimal(used)
  const budget = decimal(limit)
  if (spent === undefined || budget === undefined || budget <= 0) return null
  return { label, usedPct: Math.max(0, Math.round((spent / budget) * 100)), resetsAt: parseTimestamp(resetsAt) }
}

/**
 * Muse Code's subscription quota, as the dev.meta.ai usage page reads it: a rolling window
 * (five hours) and a weekly one, each a weighted amount used of a weighted limit in decimal
 * strings, resets in epoch seconds, and the tier's display name.
 */
export function parseMuseQuota(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const quota = (payload as Record<string, unknown>).subscription_quota
  if (quota === null || typeof quota !== "object") return null
  const q = quota as Record<string, unknown>
  const windows = [
    museWindow(q.window_weighted_used, q.window_weighted_limit, windowLabel(q.window_duration_secs), q.window_resets_at),
    museWindow(q.weekly_weighted_used, q.weekly_weighted_limit, "weekly", q.weekly_resets_at),
  ].filter((window): window is UsageWindow => window !== null)
  const usage = summarize(windows)
  if (!usage) return null
  return typeof q.tier === "string" && q.tier ? { ...usage, plan: q.tier } : usage
}

/** The team ids of a dev.meta.ai teams listing (`{teams: [{team_id}]}`). */
export function parseMuseTeams(payload: unknown): string[] | null {
  if (payload === null || typeof payload !== "object") return null
  const teams = (payload as Record<string, unknown>).teams
  if (!Array.isArray(teams)) return null
  return teams
    .map((team) => (team !== null && typeof team === "object" ? (team as Record<string, unknown>).team_id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

/** dev.meta.ai refused the token or the session */
export const MUSE_UNAUTHORIZED = "unauthorized"

/** a CLI login's access token, or the headers a browser session sends to a path (its cookies and user agent) */
export type MuseAuth = string | { headers: (path: string) => Record<string, string> }

async function musePortal(path: string, auth: MuseAuth): Promise<unknown | typeof MUSE_UNAUTHORIZED | null> {
  try {
    const url = new URL(path, vendorUrl("KYORA_MUSE_USAGE_URL", "https://dev.meta.ai"))
    const response = await fetch(url, {
      headers: { ...(typeof auth === "string" ? { authorization: `Bearer ${auth}` } : auth.headers(path)), accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    })
    if (response.status === 401 || response.status === 403) return MUSE_UNAUTHORIZED
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/** The teams a Muse login belongs to, by id, from the list the dev.meta.ai portal loads first. */
export async function museTeams(auth: MuseAuth): Promise<string[] | typeof MUSE_UNAUTHORIZED | null> {
  const payload = await musePortal("/api/portal/teams", auth)
  return payload === MUSE_UNAUTHORIZED ? payload : parseMuseTeams(payload)
}

/** Asks dev.meta.ai what is left on a team's Muse Code subscription windows, the call its usage page makes. */
export async function museUsage(auth: MuseAuth, teamId: string): Promise<LiveUsage | typeof MUSE_UNAUTHORIZED | null> {
  const payload = await musePortal(`/api/portal/teams/${encodeURIComponent(teamId)}/subscription-quota`, auth)
  return payload === MUSE_UNAUTHORIZED ? payload : parseMuseQuota(payload)
}

/** a Code Assist bucket's share left (0 to 1); proto3 JSON leaves a zero out, so a bucket with a reset and no share is spent */
function agyWindow(bucket: Record<string, unknown>, label: string): UsageWindow | null {
  if (bucket.disabled === true) return null
  const raw = bucket.remainingFraction ?? bucket.remaining_fraction
  const resetsAt = parseTimestamp(bucket.resetTime ?? bucket.reset_time)
  const left = typeof raw === "number" && Number.isFinite(raw) ? raw : resetsAt !== undefined ? 0 : undefined
  if (left === undefined) return null
  return { label, usedPct: Math.min(100, Math.max(0, Math.round((1 - left) * 100))), resetsAt }
}

const agyText = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/**
 * Antigravity's quota from Code Assist: the summary agy's `/usage` shows (its buckets, alone or in
 * groups, each a share left and a reset), else retrieveUserQuota's per model buckets. Also reads the
 * snake_case form `agy -p /usage --output-format json` prints under `command.data`.
 */
export function parseAgyQuota(payload: unknown): LiveUsage | null {
  if (payload === null || typeof payload !== "object") return null
  const root = payload as Record<string, unknown>
  const found: { bucket: Record<string, unknown>; label: string; detail?: string }[] = []
  const seen = new Set<string>()
  const add = (bucket: unknown, group?: string) => {
    if (bucket === null || typeof bucket !== "object") return
    const b = bucket as Record<string, unknown>
    // a bucket is the same one only when every field that names it matches: one model's REQUESTS and TOKENS buckets are two
    const identity = JSON.stringify([group, b.bucketId, b.displayName, b.window, b.modelId, b.tokenType])
    if (seen.has(identity)) return
    seen.add(identity)
    const name = agyText(b.displayName) ?? agyText(b.window) ?? agyText(b.modelId) ?? agyText(b.bucketId) ?? agyText(b.tokenType) ?? agyText(b.name) ?? "quota"
    const detail = [agyText(b.window), agyText(b.tokenType)?.toLowerCase(), agyText(b.bucketId)].find((part) => part && part !== name)
    found.push({ bucket: b, label: group && group !== name ? `${group} ${name}` : name, detail })
  }
  for (const bucket of Array.isArray(root.buckets) ? root.buckets : []) add(bucket)
  for (const group of Array.isArray(root.groups) ? root.groups : []) {
    if (group === null || typeof group !== "object") continue
    const g = group as Record<string, unknown>
    for (const bucket of Array.isArray(g.buckets) ? g.buckets : []) add(bucket, agyText(g.displayName) ?? agyText(g.name))
  }
  const shared = (label: string) => found.filter((entry) => entry.label === label).length > 1
  const windows = found
    .map((entry) => agyWindow(entry.bucket, shared(entry.label) && entry.detail ? `${entry.label} ${entry.detail}` : entry.label))
    .filter((window): window is UsageWindow => window !== null)
  return summarize(windows)
}

export const AGY_UNAUTHORIZED = "unauthorized"

/** what KYORA_SWITCH_DEBUG=1 prints for a Code Assist call: its path, status and the answer's field names, never a value */
function agyTrace<T>(path: string, status: number, answer: T): T {
  if (process.env.KYORA_SWITCH_DEBUG === "1") {
    const fields = answer !== null && typeof answer === "object" ? Object.keys(answer).join(",") : ""
    process.stderr.write(`agy ${path}: HTTP ${status}${fields ? ` (${fields})` : ""}\n`)
  }
  return answer
}

async function codeAssist(path: string, token: string, body: unknown): Promise<unknown | typeof AGY_UNAUTHORIZED | null> {
  const base = vendorUrl("KYORA_AGY_USAGE_URL", "https://daily-cloudcode-pa.googleapis.com")
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/v1internal:${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) return agyTrace(path, response.status, AGY_UNAUTHORIZED)
    if (!response.ok) return agyTrace(path, response.status, null)
    return agyTrace(path, response.status, await response.json())
  } catch {
    return null
  }
}

/**
 * What is left of an Antigravity login's quota, read only: loadCodeAssist names the login's
 * Code Assist project and tier, then the quota summary (else retrieveUserQuota) for that project.
 */
export async function agyUsage(token: string): Promise<LiveUsage | typeof AGY_UNAUTHORIZED | null> {
  const load = await codeAssist("loadCodeAssist", token, { metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } })
  if (load === AGY_UNAUTHORIZED || load === null || typeof load !== "object") return load === AGY_UNAUTHORIZED ? load : null
  const info = load as Record<string, unknown>
  const named = info.cloudaicompanionProject
  const project = agyText(named) ?? agyText((named as Record<string, unknown> | null)?.id)
  if (!project) return null
  const tier = (value: unknown) => agyText((value as Record<string, unknown> | null)?.name)
  const plan = tier(info.paidTier) ?? tier(info.currentTier)
  for (const path of ["retrieveUserQuotaSummary", "retrieveUserQuota"]) {
    const payload = await codeAssist(path, token, { project })
    if (payload === AGY_UNAUTHORIZED) return payload
    const usage = parseAgyQuota(payload)
    if (usage) return plan ? { ...usage, plan } : usage
  }
  return null
}
