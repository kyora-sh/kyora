import { codexCredentials, codexLifetimeTokens } from "@kyora-sh/usage"
import { listSlots, readSnapshot } from "./store"
import { codexPrincipal } from "./identity"
import { addCounts, claudeCodeStats, emptyCounts, localTokens, type TokenCounts } from "./tokens-local"
import { describeIdentity, scrub, scrubDeep, type Provider } from "./types"

type Counts = { [K in keyof TokenCounts]: number | null }
interface Row {
  slot: string | null
  account?: string
  cloudOwned?: true
  counts: Counts
  included: boolean
  duplicateOf?: string
  /** why an account total is missing */
  note?: string
}
interface ProviderTokens {
  source: "account" | "local"
  scope: string
  rows: Row[]
  counts: Counts
  complete: boolean
  note?: string
  /** local counts: the oldest record still on this machine */
  since?: number | null
  /** Claude: what Claude Code's own /stats shows, which counts each log line and keeps deleted days */
  claudeCode?: { counts: TokenCounts; through: string; firstUse: number | null }
}
const unavailable = (): Counts => ({ input: null, output: null, cacheRead: null, cacheWrite: null, total: null })

function sum(target: Counts, value: Counts): void {
  for (const key of Object.keys(target) as (keyof Counts)[]) {
    target[key] = target[key] === null || value[key] === null ? null : target[key]! + value[key]!
  }
}

/**
 * Codex's account route: one lifetime total per account, read with each slot's stored token (never
 * refreshed or synced here). Slots of one login (the same ChatGPT account and user, whatever their
 * emails say) count once; two users of one workspace are two. A slot whose token names no user can't
 * be told apart from another slot of its workspace: such slots count once, and the total is partial.
 */
async function accountTokens(provider: Provider): Promise<ProviderTokens> {
  const slots = await listSlots(provider.id)
  const rows: Row[] = []
  const accounts = new Map<string, Row>()
  const counts: Counts = emptyCounts()
  let available = true
  let ambiguous = false
  const snapshots = await Promise.all(slots.map(slot => readSnapshot(provider.id, slot.name)))
  const principals = snapshots.map(snapshot => {
    try { return codexPrincipal(JSON.parse(snapshot?.files["auth.json"] ?? "")) } catch { return null }
  })
  // workspaces that hold a slot with no user id: every slot in one of them is keyed by the workspace alone
  const unknown = new Set(principals.flatMap(principal => principal && !principal.user ? [principal.account] : []))
  for (const [index, slot] of slots.entries()) {
    const snapshot = snapshots[index]
    const credentials = codexCredentials(snapshot?.files["auth.json"] ?? "")
    const principal = principals[index]
    const key = credentials && principal ? JSON.stringify(unknown.has(principal.account) ? [principal.account] : [principal.account, principal.user]) : null
    const duplicate = key ? accounts.get(key) : undefined
    if (duplicate && unknown.has(principal!.account)) ambiguous = true
    const total = credentials ? await codexLifetimeTokens(credentials.token, credentials.account) : null
    const expiry = snapshot ? provider.credentialExpiry?.(snapshot) : undefined
    const row: Row = {
      slot: slot.name, account: describeIdentity(slot.identity),
      ...(slot.cloudOwned ? { cloudOwned: true } : {}),
      counts: { ...unavailable(), total }, included: !duplicate,
      ...(duplicate ? { duplicateOf: duplicate.slot! } : {}),
      ...(total !== null ? {}
        : !credentials ? { note: "no ChatGPT login in this slot, so no account total" }
        : expiry !== undefined && expiry <= Date.now() ? { note: "its stored access token has expired; loading the slot refreshes it" }
        : { note: "Codex reported no total for this slot's token" }),
    }
    rows.push(row)
    if (key && !duplicate) accounts.set(key, row)
    if (duplicate && total !== null && (duplicate.counts.total === null || total > duplicate.counts.total)) {
      duplicate.counts.total = total
      delete duplicate.note
    }
  }
  for (const row of rows.filter(row => row.included)) {
    if (row.counts.total === null) available = false
    sum(counts, { ...row.counts, total: row.counts.total ?? 0 })
  }
  return {
    source: "account", scope: "Account lifetime tokens reported by Codex",
    rows, counts, complete: available && !ambiguous,
    note: `${slots.length ? "" : "No Codex slots are saved. "}The account endpoint supplies only a total. Slots of the same account and user count once. ${ambiguous ? "Some slots of one workspace name no user, so they could not be told apart and count once. " : ""}Unavailable accounts are excluded from the known total; use --local for local records.`,
  }
}

export async function collectTokens(providers: Provider[], local: boolean) {
  const collected: Record<string, ProviderTokens> = {}
  const overall: Counts = emptyCounts()
  let complete = true
  for (const provider of providers) {
    let result: ProviderTokens
    if (provider.id === "codex" && !local) result = await accountTokens(provider)
    else {
      const slots = await listSlots(provider.id)
      const data = await localTokens(provider.id, slots)
      const stats = provider.id === "claude" ? await claudeCodeStats() : null
      const claudeCode = stats && { counts: { ...stats.counts }, through: stats.through, firstUse: stats.firstUse }
      for (const [day, line] of data.lines) if (claudeCode && day > claudeCode.through) addCounts(claudeCode.counts, line)
      result = {
        source: "local", scope: "All retained records counted on this machine",
        rows: [...slots.map(slot => ({ slot: slot.name, account: describeIdentity(slot.identity), ...(slot.cloudOwned ? { cloudOwned: true as const } : {}), counts: data.slots.get(slot.name)!, included: true })),
          { slot: null, counts: data.unattributed, included: true }],
        counts: data.total, complete: data.skipped === 0,
        note: `Time attribution starts at recorded loads and saves. ${data.skipped ? `${data.skipped} records/files were skipped or had incomplete coverage. ` : ""}${provider.id === "opencode" ? "Only Go and Zen messages are counted, each attributed to the slot that held its key. " : ""}${provider.id === "agy" ? "Only replies agy records in its conversations count; its side calls (safety monitors) are not recorded. " : ""}${provider.id === "codex" ? "Older sessions use cumulative token counter deltas, which can be estimates. Mixed sessions decide coverage per counter interval and flag what can't be shown covered as partial. Forks don't count their parent's history again. " : ""}Deleted logs and other machines are not included.`,
        since: data.since,
        ...(claudeCode ? { claudeCode } : {}),
      }
    }
    collected[provider.id] = scrubDeep(result)
    sum(overall, result.counts)
    complete &&= result.complete
  }
  return { providers: collected, overall, complete, scope: "Sum of the reported provider totals; account and local coverage can differ" }
}

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", muse: "Muse", grok: "Grok Build", agy: "Antigravity" }
const BAR = 24

/** 112,222,018,069 → 112.2B: three significant figures read at a glance */
export function compact(value: number): string {
  for (const [size, unit] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= size) {
      const scaled = value / size
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${unit}`
    }
  }
  return String(value)
}
function bar(value: number, max: number): string {
  if (value <= 0 || max <= 0) return ""
  return "█".repeat(Math.floor((value / max) * BAR)) || "▏"
}
/** label, amount and a bar scaled to the largest, largest first */
function bars(entries: [string, number | null, string?][]): string[] {
  const known = entries.filter(([, value]) => value !== null && value > 0) as [string, number, string?][]
  const missing = entries.filter(([, value]) => value === null)
  known.sort((a, b) => b[1] - a[1])
  const width = Math.max(10, ...entries.map(([label]) => label.length))
  const max = known[0]?.[1] ?? 0
  const amounts = known.map(([, value]) => compact(value))
  const amountWidth = Math.max(0, ...amounts.map(amount => amount.length))
  return [
    ...known.map(([label, value], i) => `  ${label.padEnd(width)}  ${amounts[i]!.padStart(amountWidth)}  ${bar(value, max)}`),
    ...missing.map(([label, , note]) => `  ${label.padEnd(width)}  ${"-".padStart(amountWidth)}  ${note ?? "unavailable"}`),
  ]
}

/** one provider: its total, then what it's made of (kinds of tokens on this Mac, or accounts from the account route) */
export function card(id: string, data: ProviderTokens, width = 9): string[] {
  const c = data.counts
  const included = data.rows.filter(row => row.included)
  const scope = data.source === "account"
    ? `lifetime · ${included.length} account${included.length === 1 ? "" : "s"}`
    : "this Mac · all time"
  const lines = [`${(NAMES[id] ?? id).padEnd(width)}${c.total === null ? "unavailable" : `${compact(c.total)} tokens`}   ${scope}${data.complete ? "" : " · partial"}`]
  if (data.source === "account") {
    lines.push(...bars(included.map(row => [row.slot ?? "?", row.counts.total, row.note?.toLowerCase()] as [string, number | null, string?])))
    return lines
  }
  lines.push(...bars([["cache read", c.cacheRead], ["cache write", c.cacheWrite], ["output", c.output], ["input", c.input]]))
  // the split by account, once switches made with this build have attributed anything
  const attributed = data.rows.filter(row => row.slot !== null && (row.counts.total ?? 0) > 0)
  if (attributed.length > 0) {
    const earlier = data.rows.find(row => row.slot === null)
    lines.push("", "  by account",
      ...bars([...attributed.map(row => [row.slot!, row.counts.total] as [string, number | null]), ...(earlier && (earlier.counts.total ?? 0) > 0 ? [["earlier", earlier.counts.total] as [string, number | null]] : [])]))
  }
  return lines
}

/** 260_312_000_000 → 260.3b, as Claude Code's /stats writes it */
export function amount(value: number): string {
  if (value < 1e3) return String(value)
  const units = ["k", "m", "b", "t"]
  const scaled = (index: number) => (value / 10 ** (3 * index + 3)).toFixed(1)
  let index = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3) - 1)
  // 999,950 rounds to 1000.0k: that is 1.0m
  if (index < units.length - 1 && Number(scaled(index)) >= 1000) index++
  return `${scaled(index)}${units[index]}`
}
const PART_NAMES = [["input", "input"], ["output", "output"], ["cacheRead", "cache read"], ["cacheWrite", "cache write"]] as const
const day = (at: number) => new Date(at).toISOString().slice(0, 10)
const breakdown = (counts: Counts) => PART_NAMES.map(([key, name]) => `${name} ${amount(counts[key]!)}`)

/** what Claude's total covers, and what Claude Code's own /stats says instead */
export function claudeNotes(data: ProviderTokens): string[] {
  const notes: string[] = []
  const firstUse = data.claudeCode?.firstUse
  if (data.since != null) {
    notes.push(`claude counts the logs Claude Code still keeps, from ${day(data.since)}.${firstUse && day(firstUse) < day(data.since)
      ? ` Claude Code deletes logs older than cleanupPeriodDays, so usage from ${day(firstUse)} until then is missing here.` : ""}`)
  }
  if (data.claudeCode) {
    const c = data.claudeCode.counts
    notes.push(`Claude Code's /stats says ${amount(c.total!)} (${breakdown(c).join(", ")}): it counts a reply once per content block it logged, and keeps deleted days.`)
  }
  return notes
}

/** the grand total (with more than one tool), then one line per tool: its total and what it is made of, names and amounts in shared columns */
export function summary(result: Awaited<ReturnType<typeof collectTokens>>): string[] {
  const providers = Object.entries(result.providers)
  const whole = (counts: Counts) => PART_NAMES.every(([key]) => counts[key] !== null)
  // a tool that reports only a total (Codex's account route) leaves the grand total's parts to the others
  const parts = { ...result.overall }
  const without = providers.filter(([, data]) => !whole(data.counts)).map(([id]) => id)
  if (!whole(parts)) {
    for (const [key] of PART_NAMES) parts[key] = providers.reduce((sum, [, data]) => sum + (whole(data.counts) ? data.counts[key]! : 0), 0)
  }
  // an account total no account reported is unknown, not zero
  const total = (data: ProviderTokens) => data.source === "account" && data.rows.some(row => row.included) && data.rows.every(row => !row.included || row.counts.total === null) ? null : data.counts.total
  const cells = [
    ["total", result.overall.total === null ? "unknown" : amount(result.overall.total), ...breakdown(parts)],
    ...providers.map(([id, data]) => [id, total(data) === null ? "unknown" : amount(total(data)!),
      ...(total(data) === null ? ["unavailable"] : whole(data.counts) ? breakdown(data.counts) : [data.source === "account" ? "account lifetime total, no breakdown" : "no breakdown"])]),
  ]
  const remarks = [
    [...(without.length ? [`parts leave out ${without.join(", ")}`] : []), ...(result.complete ? [] : ["partial"])],
    ...providers.map(([, data]) => data.complete ? [] : ["partial"]),
  ]
  // a row's last cell is not padded, so it never sets a column's width
  const width = (i: number) => Math.max(...cells.map(row => i < 2 || i < row.length - 1 ? row[i]!.length : 0))
  // one tool: its own line is the total
  if (providers.length === 1) { cells.shift(); remarks.shift() }
  const lines = cells.map((row, index) => row.map((cell, i) => i === 1 ? cell.padStart(width(1)) : i < row.length - 1 ? cell.padEnd(width(i)) : cell)
    .join("   ") + (remarks[index]!.length ? `   (${remarks[index]!.join(", ")})` : ""))
  const claude = result.providers.claude
  const notes = claude ? claudeNotes(claude) : []
  return notes.length ? [...lines, "", ...notes] : lines
}

export async function tokens(providers: Provider[], json: boolean, local: boolean, detailed = false): Promise<void> {
  const result = await collectTokens(providers, local).catch((error: unknown) => {
    throw new Error(scrub(error instanceof Error ? error.message : String(error)))
  })
  if (json) return console.log(JSON.stringify(result, null, 2))
  if (!detailed) return console.log(summary(result).join("\n"))
  const out: string[] = []
  // one name column for every card and the total
  const width = Math.max(9, ...Object.keys(result.providers).map(id => (NAMES[id] ?? id).length + 1))
  for (const [id, data] of Object.entries(result.providers)) {
    out.push(...card(id, data, width))
    if (id === "claude" && claudeNotes(data).length) out.push("", ...claudeNotes(data).map(note => `  ${note}`))
    out.push("")
  }
  if (Object.keys(result.providers).length > 1 && result.overall.total !== null) {
    out.push(`${"Total".padEnd(width)}${compact(result.overall.total)} tokens${result.complete ? "" : "   (partial)"}`)
  } else out.pop()
  console.log(out.join("\n"))
}
