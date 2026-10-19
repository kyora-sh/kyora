import type { LiveUsage } from "@kyora-sh/usage"
import type { WebSessionConfig } from "./web-session"

export const PROVIDER_IDS = ["claude", "codex", "opencode", "muse", "grok", "agy"] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface Identity {
  account?: string
  /** a display name for a login with no account; never used to match a login to a slot */
  name?: string
  /** a stable id a login is matched on when its account cannot name it (no email, or a team login); never shown */
  id?: string
  org?: string
  plan?: string
}

/** why a login has no quota to show, in place of the generic hint */
export interface QuotaUnavailable {
  unavailable: string
}

export interface Snapshot {
  provider: ProviderId
  identity: Identity
  files: Record<string, string>
  capturedAt: number
}

/** a renewal of a login: the renewed login, or why there is none, in plain words that never carry a secret */
/** `alreadyLive`: the CLI wrote the renewed login live itself, so it is not written again */
export type Renewal = { snapshot: Snapshot; alreadyLive?: true } | { failure: string }

export interface Provider {
  id: ProviderId
  label: string
  processName: string
  /** the arguments of a node process that runs this CLI as a Node.js script, for a CLI installed that way */
  nodeScript?: RegExp
  loginHint: string
  locations(): string[]
  capture(): Promise<Snapshot | null>
  forget(): Promise<void>
  restore(snapshot: Snapshot): Promise<void>
  /** throws what `restore` would refuse the snapshot over, before a switch begins, changing nothing */
  checkRestore?(snapshot: Snapshot): Promise<void>
  quota?(snapshot: Snapshot): Promise<LiveUsage | null>
  /** in place of quota: the quota, or why there is none; `slot` names the slot the login was read from, when it is one */
  quotaWithReason?(snapshot: Snapshot, slot?: string): Promise<LiveUsage | QuotaUnavailable | null>
  credentialExpiry?(snapshot: Snapshot): number | undefined
  refresh?(snapshot: Snapshot): Promise<Renewal>
  /** how long before its access token expires the CLI renews a login, so a live login inside it is due */
  renewalMarginMs?(): number
  /**
   * Puts a renewal of the live login live: the credential store alone, written as the CLI's own
   * renewal writes it. kyora-switch renews a live login only for a provider that has this, and
   * only while the CLI is not running.
   */
  writeRenewal?(renewed: Snapshot): Promise<void>
  /**
   * The secret that tells one login (grant) from another of the same account: the refresh
   * token, or a key. Two `/login`s of one email are two grants; kyora-switch matches the live
   * login to its slot by this first, by email only after (sync.ts).
   */
  grant?(snapshot: Snapshot): string | undefined
  quotaHint?: string
  /**
   * Notes about a captured login that a switch could otherwise hide: an
   * environment variable that beats every slot, or two backends holding
   * different logins. Printed wherever a switch could look silent.
   */
  notes?(snapshot: Snapshot | null): string[]
  /**
   * The credential each stored file (or each login in a file that holds several) holds on its own: sync backs a slot up
   * before replacing any of them with another, even when the grant it matched the slot by
   * is unchanged. A refresh that keeps a file's credential is not a replacement.
   */
  fileGrants?(snapshot: Snapshot): Record<string, string>
  /** the login is one its own CLI renews and kyora-switch never does, so a stale slot of it is not a failed renewal */
  renewsItself?(snapshot: Snapshot): boolean
  /** a renewal of one slot written into another slot holding the same grant, keeping that slot's other credentials */
  carryRenewal?(renewed: Snapshot, onto: Snapshot): Snapshot
  /** a load is refused while the CLI runs, without --force: it would keep or overwrite the login loaded under it */
  loadsOnlyWhenIdle?: boolean
  /** runs `change` (a capture, backup and restore or sign-out) holding the CLI's own lock on its login store */
  exclusive?<T>(change: () => Promise<T>): Promise<T>
  /** a site whose browser session `web-login` can keep per slot, for what the CLI login cannot read */
  webSession?: WebSessionConfig
}

/** what a login is matched to a slot by, after its grant: the stable id when it has one, else the account */
export function accountKey(identity: Identity): string | undefined {
  return identity.id ?? identity.account
}

export function isProviderId(value: string | undefined): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value ?? "")
}

/** what private mode prints in place of an account's email and org */
export const MASK = "•••"
let privateMode = false

/** private mode (`kyora-switch private on`, --private): accounts print as their plan alone */
export function setPrivate(on: boolean): void {
  privateMode = on
}

let program = "kyora-switch"

/** the command help and hints name: `kyora-switch`, or `kyora switch` when the kyora CLI runs it */
export const programName = (): string => program

export function setProgramName(name: string): void {
  program = name
}

export function describeIdentity(identity: Identity): string {
  if (privateMode) return [MASK, ...(identity.plan ? [identity.plan] : [])].join(" · ")
  const parts = [identity.account ?? identity.name ?? "unknown account"]
  if (identity.org) parts.push(identity.org)
  if (identity.plan) parts.push(identity.plan)
  return parts.join(" · ")
}

export function isPrivate(): boolean {
  return privateMode
}

const EMAIL = /[^\s@"'<>(),;]+@[^\s@"'<>(),;]+\.[A-Za-z]{2,}/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/**
 * A provider's free text (quota labels, details, notes) in private mode: without the account's email
 * and org, and without anything shaped like an email or an account id. Unchanged outside private mode.
 */
export function scrub(text: string, identity?: Identity): string {
  if (!privateMode) return text
  let out = text
  for (const value of [identity?.account, identity?.name, identity?.org]) if (value) out = out.split(value).join(MASK)
  return out.replace(EMAIL, MASK).replace(UUID, MASK)
}

/** scrub() over every string in a value (a provider's quota object, for text and --json alike) */
export function scrubDeep<T>(value: T, identity?: Identity): T {
  if (!privateMode) return value
  if (typeof value === "string") return scrub(value, identity) as T
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, identity)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, identity)])) as T
  }
  return value
}

/** an identity as --json shows it: in private mode only the plan survives */
export function shownIdentity(identity: Identity): Identity {
  return privateMode ? { account: MASK, ...(identity.plan ? { plan: identity.plan } : {}) } : identity
}
