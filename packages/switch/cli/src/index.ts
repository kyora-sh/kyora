#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import type { LiveUsage } from "@kyora-sh/usage"
import { parseArgs } from "node:util"
import { isIdle, isRunning, PROVIDERS, providerById, runningSessions, type Sessions } from "./providers"
import {
  assertName,
  isCloudOwned,
  listSlots,
  markLive,
  readSettings,
  readSlot,
  readSnapshot,
  removeSlot,
  renameSlot,
  rootDir,
  READ_SYNC_TIMEOUT_MS,
  slotDir,
  type Slot,
  SwitchLockBusy,
  withSwitchLock,
  writeBackup,
  writeSettings,
  writeSnapshot,
} from "./store"
import { LoginLockBusy } from "./lock"
import { heldBack, readRenewalFailures, recordRenewal } from "./backoff"
import { duration, LiveWriteError } from "./renewal"
import { grantFingerprint, type LiveState, sameFiles, syncLiveSlot } from "./sync"
import { beginSwitch, recordSwitch } from "./token-history"
import { dataCollection, type DataCollection } from "./data-collection"
import { readMuseTeam, writeMuseTeam } from "./providers/muse"
import { deleteWebSession, findBrowser, moveWebSession, NO_BROWSER, webLogin, writeWebSession } from "./web-session"
import { accountKey, describeIdentity, isProviderId, programName, scrub, scrubDeep, setPrivate, setProgramName, shownIdentity, type Identity, type Provider, type ProviderId, type Snapshot } from "./types"

const HELP = `kyora-switch: hot-swap Claude Code, Codex, OpenCode, Muse, Grok Build and Antigravity logins

usage:
  kyora-switch claude save <slot>       store the Claude account you are logged into
  kyora-switch claude load <slot>       log Claude Code back into a stored account
  kyora-switch claude list              slots for Claude Code
  kyora-switch claude usage             how much quota each stored account has left
  kyora-switch claude refresh           renew the live login and stale slots, then show usage
  kyora-switch claude sync              copy the live login back into its slot
  kyora-switch claude clear             sign out locally, without revoking the account
  kyora-switch claude rm <slot>         delete a slot
  kyora-switch claude rename <a> <b>    rename a slot

  kyora-switch codex save <slot>        same commands for Codex
  kyora-switch codex load <slot>

  kyora-switch opencode save <slot>     and for OpenCode Go / Zen keys, leaving
  kyora-switch opencode load <slot>     every other opencode provider login alone

  kyora-switch muse save <slot>         same commands for Muse
  kyora-switch muse load <slot>
  kyora-switch muse team <slot> <id>    the dev.meta.ai team whose usage the slot shows
  kyora-switch muse team <slot> [unset] show the slot's team, or clear it
  kyora-switch muse web-login <slot>    keep a dev.meta.ai browser session for the slot's usage
  kyora-switch muse web-logout <slot>   forget the slot's browser session

  kyora-switch grok save <slot>         and for Grok Build
  kyora-switch grok load <slot>

  kyora-switch agy save <slot>          and for Antigravity (agy): manual loads only,
  kyora-switch agy load <slot>          never switched automatically

  kyora-switch status                   which account each CLI is logged into, and its data collection
  kyora-switch usage                    remaining quota across every stored account
  kyora-switch refresh                  renew the live logins and stale slots, then show usage
  kyora-switch sync                     copy each live login back into its slot
  kyora-switch doctor                   where each CLI keeps its auth on this machine
  kyora-switch private on|off           hide account emails everywhere, show only the plan

status, list, usage and load update the slot for the current local login.
Only refresh renews logins: usage reads quota and never calls a token server.
A renewal that failed is retried after an hour, or at once by
\`kyora-switch <cli> refresh\`; a refused refresh token only after a new save.

A slot uploaded with \`kyora session creds sync\` is in use by kyora cloud until
\`kyora session creds return\`: local sync and refresh skip it,
and load, save and rename refuse it (load and save take --force).

options:
  --json         machine-readable output (list, status, usage)
  --refresh      usage: run refresh first
  --no-renew     accepted and ignored: usage never renews a login
  --force        load or save a slot in use by kyora cloud, or load agy while it runs
  --private      hide account emails for this command (KYORA_SWITCH_PRIVATE=1 too)
  --reveal       show them for this command, even in private mode
  -y, --yes      skip the confirmation on rm
  -h, --help     this help

Slots live in ~/.kyora/switch/<provider> (override with KYORA_SWITCH_DIR). Every
load backs the outgoing login up first, so a switch made before saving is still
recoverable.`

const help = () => HELP.replaceAll("kyora-switch", programName())

function die(message: string): never {
  console.error(`[kyora-switch] ${message}`)
  process.exit(2)
}

const note = (message: string) => console.error(`[kyora-switch] ${message}`)

const pad = (id: string) => id.padEnd(8)

const CLOUD_TAG = "  (kyora cloud)"

/** what to do about a slot kyora cloud's broker owns */
const takeBack = (name: string) => `\`kyora session creds return --slot ${name}\` takes it back`

function warnNotes(provider: Provider, snapshot: Snapshot | null): void {
  for (const message of provider.notes?.(snapshot) ?? []) note(message)
}

const unreadableMessage = (error: unknown): string => scrub(error instanceof Error ? error.message : String(error))

/** the live login is the very grant a slot kyora cloud's broker owns: said once per read */
function warnOwned(provider: Provider, state: Pick<LiveState, "skipped">): void {
  if (!state.skipped) return
  note(
    `skipped "${state.skipped}": in use by kyora cloud. ${provider.label} uses the same login locally and may be signed out. ${takeBack(state.skipped)}`,
  )
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question)
  for await (const line of console) return line.trim()
  return ""
}

async function save(provider: Provider, name: string, force: boolean): Promise<void> {
  const notLoggedIn = () => die(`${provider.label} is not logged in: ${provider.loginHint}`)
  if (!(await provider.capture())) notLoggedIn()
  assertName(name)
  const snapshot = await withSwitchLock(provider.id, async () => {
    const snapshot = (await provider.capture()) ?? notLoggedIn()
    if (isCloudOwned(await readSlot(provider.id, name))) {
      if (!force) die(`"${name}" is in use by kyora cloud. ${takeBack(name)} first; --force saves anyway`)
      note(`"${name}" stays marked as kyora cloud's: \`kyora session creds return --slot ${name}\` will see the slot changed here and leave it alone without --force`)
    }
    const previous = await readSlot(provider.id, name)
    if (provider.webSession && previous && accountKey(previous.identity) !== accountKey(snapshot.identity) && (await deleteWebSession(provider.id, name))) {
      note(`dropped "${name}"'s web session: it belonged to the slot's previous account`)
    }
    // the switch history: unknown from here until its line, so a save that never gets one attributes nothing
    await beginSwitch(provider.id)
    // the live login, saved: the next sync finds in the slot that login's own past
    await writeSnapshot(name, snapshot, { live: grantFingerprint(provider, snapshot) ?? null })
    await recordRenewal(provider.id, grantFingerprint(provider, snapshot))
    // the live login is this slot's from here on, the same as after a load
    await recordSwitch(provider.id, name)
    return snapshot
  })
  console.log(`saved ${provider.id} "${name}": ${describeIdentity(snapshot.identity)}`)
  console.log(`  ${slotDir(provider.id, name)}`)
  warnNotes(provider, snapshot)
}

/** runs a capture, backup and switch under the provider's own lock on its login store, when it has one */
const exclusively = <T>(provider: Provider, change: () => Promise<T>): Promise<T> =>
  provider.exclusive ? provider.exclusive(change) : change()

/** a load of a slot kyora cloud's broker owns: refused without --force, noted with it */
function checkCloudOwned(provider: Provider, slot: Slot | null, force: boolean, noted: boolean): void {
  if (!isCloudOwned(slot)) return
  if (!force) die(`"${slot!.name}" is in use by kyora cloud. ${takeBack(slot!.name)} first; --force loads it anyway and may sign out the cloud session`)
  if (!noted) note(`loading "${slot!.name}" while it is in use by kyora cloud may sign out ${provider.label} or the cloud session`)
}

async function load(provider: Provider, name: string, force: boolean): Promise<void> {
  const slot = (await readSlot(provider.id, assertName(name))) ?? die(`no ${provider.id} slot "${name}"`)
  checkCloudOwned(provider, slot, force, false)

  const snapshot = await withSwitchLock(provider.id, () => exclusively(provider, async () => {
    checkCloudOwned(provider, await readSlot(provider.id, name), force, isCloudOwned(slot))
    if (provider.loadsOnlyWhenIdle && !force) {
      const sessions = await runningSessions(provider)
      if ("unknown" in sessions) die(`could not tell whether ${provider.label} is running (${sessions.unknown}): quit it first, or --force loads anyway`)
      if (isRunning(sessions)) die(`${provider.label} is running and would keep or overwrite its login: quit it first, or --force loads anyway`)
    }
    const state = await syncLiveSlot(provider)
    const { active: outgoing, synced, live } = state
    warnOwned(provider, state)
    // read under the lock: a refresh that was renewing this slot has written its rotated token back by now
    const stored = (await readSnapshot(provider.id, name)) ?? die(`no ${provider.id} slot "${name}"`)
    const incoming = synced === name && outgoing ? outgoing : stored
    await provider.checkRestore?.(incoming)
    if (outgoing) {
      const backup = await writeBackup(outgoing)
      if (synced) note(`synced ${provider.id} "${synced}" from the live login before switching away`)
      else if (!live) {
        note(`the login you just replaced (${describeIdentity(outgoing.identity)}) was in no slot; it is in ${backup}`)
      }
    }

    await beginSwitch(provider.id)
    try {
      await provider.restore(incoming)
    } catch (error) {
      // a restore that left the live login as it was: the switch never happened, so it ends on the login still live
      const now = await provider.capture().catch(() => undefined)
      if (now !== undefined && (outgoing ? now !== null && sameFiles(now, outgoing) : now === null)) await recordSwitch(provider.id, outgoing ? (live?.name ?? null) : null)
      throw error
    }
    await recordSwitch(provider.id, name)
    // the slot holds the live login now: what the next sync finds in it is that login's own past
    const loaded = grantFingerprint(provider, incoming)
    if (loaded) await markLive(provider.id, name, loaded)
    return incoming
  }))
  console.log(`${provider.id} → "${name}": ${describeIdentity(snapshot.identity)}`)
  warnNotes(provider, snapshot)
  const sessions = await runningSessions(provider)
  if (isRunning(sessions)) {
    note(`${provider.label} is running: restart it, the old token is already in memory`)
  }
  unknownRunning(provider, sessions)
}

/** after a switch, when a CLI may still hold the old token in memory */
function unknownRunning(provider: Provider, sessions: Sessions): void {
  if ("unknown" in sessions) note(`could not tell whether ${provider.label} is running (${sessions.unknown}): if it is, restart it, the old token is already in memory`)
}

async function list(provider: Provider, json: boolean): Promise<void> {
  const state = await syncLiveSlot(provider, READ_SYNC_TIMEOUT_MS)
  const { slots, live } = state
  warnOwned(provider, state)
  if (json) return console.log(JSON.stringify(slots.map((slot) => ({ ...slot, identity: shownIdentity(slot.identity) })), null, 2))
  if (slots.length === 0) {
    return console.log(`no ${provider.id} slots yet: run \`${programName()} ${provider.id} save <slot>\` while logged in`)
  }

  for (const slot of slots) {
    const active = live?.name === slot.name ? "  (active)" : ""
    // Grok Build keeps the training choice per account, in the login itself
    const training = provider.id === "grok" ? dataCollection("grok", await readSnapshot(provider.id, slot.name)).training : undefined
    const choice = training === "opted-out" ? "  training opted out" : training === "opted-in" ? "  training opted in" : ""
    console.log(`${pad(slot.name)} ${describeIdentity(slot.identity)}${isCloudOwned(slot) ? CLOUD_TAG : ""}${active}${choice}`)
  }
}


function relative(timestamp: number): string {
  const ms = timestamp - Date.now()
  return ms <= 0 ? "now" : duration(ms)
}

function describeQuota(quota: LiveUsage): string {
  const windows = quota.windows ?? []
  if (windows.length === 0) return `${`${quota.remainingPct}% left`.padEnd(9)}  ${quota.detail}`
  const detail = [
    ...(quota.plan ? [quota.plan] : []),
    ...windows.map((window) => `${window.label} ${window.usedPct}% used${window.resetsAt ? `, resets in ${relative(window.resetsAt)}` : ""}`),
  ].join(" · ")
  return `${`${quota.remainingPct}% left`.padEnd(9)}  ${detail}`
}

interface UsageRow {
  provider: ProviderId
  slot: string | null
  account: string
  live: boolean
  quota: LiveUsage | null
  /** why there is no quota, when the provider said */
  unavailable?: string
  expiresAt?: number
  note?: string
  /** only on slots kyora cloud's broker owns */
  cloudOwned?: true
  /** the live login's expired access token: who renews it, or why this run could not */
  renewal?: string
}

async function readQuota(provider: Provider, snapshot: Snapshot, identity: Identity, slot?: string): Promise<Pick<UsageRow, "quota" | "unavailable">> {
  const result = provider.quotaWithReason ? await provider.quotaWithReason(snapshot, slot) : provider.quota ? await provider.quota(snapshot) : null
  if (result && "unavailable" in result) return { quota: null, unavailable: scrub(result.unavailable, identity) }
  return { quota: scrubDeep(result, identity) }
}

/** a stored access token that has lapsed, of a provider that can renew it */
function stale(provider: Provider, snapshot: Snapshot): boolean {
  const expiry = provider.credentialExpiry?.(snapshot)
  return Boolean(provider.refresh) && expiry !== undefined && expiry <= Date.now()
}

/** a live login whose access token is expired, or inside the margin its CLI renews it at */
function due(provider: Provider, snapshot: Snapshot): boolean {
  const expiry = provider.credentialExpiry?.(snapshot)
  return expiry !== undefined && expiry - (provider.renewalMarginMs?.() ?? 0) <= Date.now()
}

/** kyora-switch renews this live login itself, when its CLI is not running */
const renewsLive = (provider: Provider, snapshot: Snapshot): boolean =>
  Boolean(provider.refresh && provider.writeRenewal) && !provider.renewsItself?.(snapshot)

/** the grant a renewal spent: none when it kept its refresh token, as Google's renewals do, so the grant still signs in */
const spentBy = (provider: Provider, renewed: Snapshot, grant: string | null): string | null =>
  grant && grantFingerprint(provider, renewed) !== grant ? grant : null

const messageOf = (error: unknown): string => scrub(error instanceof Error ? error.message : String(error))

/**
 * Writes a renewal into every slot holding the grant it spent, so none keeps the spent token,
 * keeping each slot's other credentials; a slot that fails does not stop the others. `live`
 * names the slot that holds the live login.
 */
async function keepRenewal(provider: Provider, renewed: Snapshot, spent: string | null, live: string | null): Promise<{ written: string[]; failed: string[]; error?: string }> {
  const kept: { written: string[]; failed: string[]; error?: string } = { written: [], failed: [] }
  if (!spent) return kept
  let slots: Slot[]
  try {
    slots = await listSlots(provider.id)
  } catch (error) {
    return { written: [], failed: ["(the slot list)"], error: messageOf(error) }
  }
  for (const slot of slots) {
    if (isCloudOwned(slot)) continue
    try {
      const held = await readSnapshot(provider.id, slot.name)
      if (!held || grantFingerprint(provider, held) !== spent) continue
      await writeBackup(held)
      const next = provider.carryRenewal?.(renewed, held) ?? { ...renewed, identity: held.identity }
      await writeSnapshot(slot.name, next, { live: slot.name === live ? grantFingerprint(provider, next) : null, renewedFrom: spentBy(provider, next, spent) })
      kept.written.push(slot.name)
    } catch (error) {
      kept.failed.push(slot.name)
      kept.error ??= messageOf(error)
    }
  }
  return kept
}

/** the slots a renewal could not be written into, which still hold the token it spent; `live`: the renewal is live, so a save copies it in */
const missed = (provider: Provider, kept: { failed: string[]; error?: string }, live: boolean): string =>
  kept.failed.length === 0
    ? ""
    : `; ${kept.failed.map((name) => (name.startsWith("(") ? name : `"${name}"`)).join(", ")} could not be written (${kept.error}) and still hold${kept.failed.length === 1 ? "s" : ""} a spent token${live ? `: \`${programName()} ${provider.id} save <slot>\` writes the live login in` : ""}`

/** `missed`: the slots a live renewal could not be written into */
type LiveRenewal = { renewed: Snapshot; missed?: string } | { failure: string } | null

const unsure = (provider: Provider, sessions: { unknown: string }): { failure: string } => ({
  failure: `could not tell whether ${provider.label} is running (${sessions.unknown}), so the live login was left to it`,
})

/**
 * Renews the live login when its access token is expired or inside the margin its CLI renews it
 * at, and only while that CLI is known not to run: a running CLI renews its own login. Under
 * kyora-switch's slot lock and then the CLI's own lock on its login store, the login is read
 * again, so one the CLI renewed meanwhile (or a CLI that started meanwhile) is left alone. After
 * the token call, a CLI that started, or a live login that changed, keeps its login and the
 * renewal goes into the slots and a backup. Otherwise the renewal is written live, then into
 * every slot holding the grant it spent, before either lock is let go. Null: nothing to renew.
 */
async function renewLiveLogin(provider: Provider, explicit: boolean): Promise<LiveRenewal> {
  const refresh = provider.refresh
  const write = provider.writeRenewal
  if (!refresh || !write) return null
  const first = await provider.capture()
  if (!first || !due(provider, first) || !renewsLive(provider, first)) return null
  const sessions = await runningSessions(provider)
  if ("unknown" in sessions) return unsure(provider, sessions)
  if (!isIdle(sessions)) return null
  try {
    return await withSwitchLock(provider.id, () => exclusively(provider, async (): Promise<LiveRenewal> => {
      const locked = await runningSessions(provider)
      if ("unknown" in locked) return unsure(provider, locked)
      if (!isIdle(locked)) return null
      const state = await syncLiveSlot(provider)
      const before = state.active
      if (state.spent && state.live) return { failure: `a renewal already spent its token and is in "${state.live.name}": \`${programName()} ${provider.id} load ${state.live.name}\` puts it live` }
      if (!before || state.skipped || !due(provider, before) || !renewsLive(provider, before)) return null
      const spent = grantFingerprint(provider, before)
      const held = await heldBack(provider.id, spent, explicit)
      if (held !== undefined) return { failure: held }
      const renewal = await refresh(before)
      await recordRenewal(provider.id, spent, "failure" in renewal ? renewal.failure : undefined)
      if ("failure" in renewal) return renewal
      const renewed = renewal.snapshot
      // a renewal that did not go live is backed up after the slots, so no backup made meanwhile can replace it
      const keptAside = async (): Promise<{ kept: Awaited<ReturnType<typeof keepRenewal>>; backup: string }> => {
        const kept = await keepRenewal(provider, renewed, spent, null)
        const backup = (await writeBackup(renewed).catch(() => null)) ?? "no backup (it could not be written)"
        return { kept, backup }
      }
      // the token call can take its whole timeout, and a CLI with no lock kyora can take (Claude Code) may start meanwhile
      const after = await runningSessions(provider)
      const now = await provider.capture().catch(() => null)
      const alreadyLive = renewal.alreadyLive === true && now !== null && sameFiles(now, renewed)
      const unchanged = now !== null && (sameFiles(now, before) || alreadyLive)
      if (!isIdle(after) || !unchanged) {
        const { kept, backup } = await keptAside()
        // a live login still holding the spent grant never syncs over a slot this renewal went into
        const slots = unchanged && kept.written.length > 0 ? `, and in ${kept.written.map((name) => `"${name}"`).join(", ")}, which \`${programName()} ${provider.id} load <slot>\` puts live` : ""
        const why =
          "unknown" in after
            ? `could not tell whether ${provider.label} started while it was being renewed (${after.unknown}), so the live login was left to it`
            : isRunning(after)
              ? `${provider.label} started while it was being renewed, so the live login was left to it`
              : "the live login changed while it was being renewed, so it was left as it is"
        return { failure: `${why}; the renewal is in ${backup}${slots}${missed(provider, kept, false)}` }
      }
      try {
        if (!alreadyLive) await write(renewed)
      } catch (error) {
        const { kept, backup } = await keptAside()
        const stores = error instanceof LiveWriteError ? `: ${scrub(error.message)}` : ` (${messageOf(error)}); the live login still holds the spent token`
        throw new Error(
          `renewed the live ${provider.label} login but could not write it live${stores}. The renewal is in ${backup}: put its credentials back live, or ${provider.loginHint}${missed(provider, kept, false)}`,
        )
      }
      const kept = await keepRenewal(provider, renewed, spent, state.live?.name ?? null)
      return kept.failed.length > 0 ? { renewed, missed: missed(provider, kept, true) } : { renewed }
    }))
  } catch (error) {
    if (error instanceof SwitchLockBusy) return { failure: "another kyora-switch is changing these slots, try again" }
    if (error instanceof LoginLockBusy) return { failure: `${provider.label} held its login lock, it may be renewing the login itself; try again` }
    throw error
  }
}

/** who renews a live login whose access token has expired, when nothing renewed it in this run */
async function liveRenewalHint(provider: Provider, snapshot: Snapshot): Promise<string> {
  const sessions = await runningSessions(provider)
  if (isRunning(sessions)) return `${provider.label} is running and renews it itself`
  if (!renewsLive(provider, snapshot)) return `${provider.label} renews it when it next runs`
  if ("unknown" in sessions) return `${provider.label} renews it when it next runs (whether it runs now could not be told: ${sessions.unknown})`
  return `${provider.label} renews it when it next runs; \`${programName()} refresh\` renews it now`
}

/**
 * Refreshes a slot that is not live and whose access token has lapsed, writing the rotated
 * credentials straight back so the spent refresh token is never kept. Never a slot kyora cloud's
 * broker owns: its refresh token is the broker's to spend. A grant several slots share is spent
 * once, and the renewal written into each of them before kyora-switch's lock is let go, so a load
 * never puts a token live that a renewal has spent. A grant whose renewal failed (in `failed`) is
 * not tried again. Null: the slot is gone, or another kyora-switch held the lock.
 */
async function refreshSlot(provider: Provider, name: string, failed: Map<string, string>, explicit: boolean): Promise<Snapshot | null> {
  const refresh = provider.refresh
  if (!refresh) return null
  try {
    return await withSwitchLock(provider.id, async () => {
      const slot = await readSlot(provider.id, name)
      const snapshot = slot && (await readSnapshot(provider.id, name))
      if (!slot || !snapshot) return null
      if (isCloudOwned(slot) || !stale(provider, snapshot)) return snapshot
      // a slot holding the live grant, or one of the live account's, may hold a copy of it: refreshing it would sign the CLI out
      const active = await provider.capture()
      const grant = grantFingerprint(provider, snapshot)
      const liveKey = active ? accountKey(active.identity) : undefined
      if (active && ((grant !== null && grant === grantFingerprint(provider, active)) || (liveKey !== undefined && accountKey(slot.identity) === liveKey))) return snapshot
      if (provider.renewsItself?.(snapshot)) {
        note(`${provider.id} "${name}": ${provider.label} renews this login itself; load the slot to renew it`)
        return snapshot
      }

      const earlier = grant ? (failed.get(grant) ?? (await heldBack(provider.id, grant, explicit))) : undefined
      const renewal = earlier !== undefined ? { failure: earlier } : await refresh(snapshot)
      if (earlier === undefined) await recordRenewal(provider.id, grant, "failure" in renewal ? renewal.failure : undefined)
      if ("failure" in renewal) {
        if (grant) failed.set(grant, renewal.failure)
        note(`${provider.id} "${name}": login not renewed: ${scrub(renewal.failure)}`)
        return snapshot
      }
      const refreshed = renewal.snapshot
      await writeBackup(refreshed)
      // refreshed here, not the live login: its grant is its own
      await writeSnapshot(name, refreshed, { live: null, renewedFrom: spentBy(provider, refreshed, grant) })
      if (grant) {
        // the grant is not the live one (checked above), so every other slot holding it holds a spent token now
        for (const other of await listSlots(provider.id)) {
          if (other.name === name || isCloudOwned(other)) continue
          const held = await readSnapshot(provider.id, other.name)
          if (!held || grantFingerprint(provider, held) !== grant) continue
          await writeBackup(held)
          const carried = provider.carryRenewal?.(refreshed, held) ?? { ...refreshed, identity: held.identity }
          await writeSnapshot(other.name, carried, { live: null, renewedFrom: spentBy(provider, carried, grant) })
        }
      }
      return refreshed
    })
  } catch (error) {
    if (!(error instanceof SwitchLockBusy)) throw error
    note(`${provider.id} "${name}": not refreshed, ${error.message}`)
    return null
  }
}

/**
 * `refresh`: renew the live login when it is due and its CLI is not running, and every stale slot,
 * first; without it nothing is renewed and no token server is called. `explicit`: a refresh of this
 * provider alone, which retries a grant whose renewal failed within the hour.
 */
async function usageRows(provider: Provider, refresh: boolean, explicit: boolean): Promise<UsageRow[]> {
  const renewal = refresh ? await renewLiveLogin(provider, explicit) : null
  const recorded = await readRenewalFailures(provider.id)
  const state = await syncLiveSlot(provider, READ_SYNC_TIMEOUT_MS)
  if (renewal && "renewed" in renewal) note(`${provider.id}${state.live ? ` "${state.live.name}"` : ""}: renewed the live login`)
  if (renewal && "failure" in renewal) note(`${provider.id}${state.live ? ` "${state.live.name}"` : ""}: live login not renewed: ${scrub(renewal.failure)}`)
  const renewalOf = async (snapshot: Snapshot): Promise<string | undefined> => {
    const expiry = provider.credentialExpiry?.(snapshot)
    if (expiry === undefined || expiry > Date.now()) return undefined
    if (renewal && "failure" in renewal) return `not renewed: ${scrub(renewal.failure)}`
    const failure = recorded.get(grantFingerprint(provider, snapshot) ?? "")
    return failure && renewsLive(provider, snapshot) ? `not renewed: ${scrub(failure.reason)}` : await liveRenewalHint(provider, snapshot)
  }
  const { active, slots } = state
  warnOwned(provider, state)
  const rows: UsageRow[] = []
  const failed = new Map<string, string>()
  const failedRenewal = (snapshot: Snapshot): string | undefined => {
    if (!stale(provider, snapshot)) return undefined
    const grant = grantFingerprint(provider, snapshot)
    const failure = grant ? (failed.get(grant) ?? recorded.get(grant)?.reason) : undefined
    if (failure !== undefined) return `not renewed: ${scrub(failure)}`
    return provider.renewsItself?.(snapshot) ? undefined : `\`${programName()} refresh\` renews it`
  }

  for (const slot of slots) {
    const live = Boolean(active && state.live?.name === slot.name)
    let snapshot = live ? active : await readSnapshot(provider.id, slot.name)
    if (!live && refresh && snapshot && stale(provider, snapshot)) snapshot = (await refreshSlot(provider, slot.name, failed, explicit)) ?? snapshot
    const skippedRefresh = !live && refresh && snapshot !== null && stale(provider, snapshot)
    rows.push({
      provider: provider.id,
      slot: slot.name,
      account: describeIdentity(slot.identity),
      live,
      ...(snapshot ? await readQuota(provider, snapshot, slot.identity, slot.name) : { quota: null }),
      expiresAt: snapshot ? provider.credentialExpiry?.(snapshot) : undefined,
      renewal: !snapshot || isCloudOwned(slot) ? undefined : live ? await renewalOf(snapshot) : failedRenewal(snapshot),
      ...(isCloudOwned(slot)
        ? {
            cloudOwned: true as const,
            note: `in use by kyora cloud${skippedRefresh ? ", not refreshed locally" : ""}; ${takeBack(slot.name)}`,
          }
        : {}),
    })
  }

  if (active && !rows.some((row) => row.live)) {
    rows.unshift({
      provider: provider.id,
      slot: null,
      account: describeIdentity(active.identity),
      live: true,
      ...(await readQuota(provider, active, active.identity)),
      expiresAt: provider.credentialExpiry?.(active),
      renewal: await renewalOf(active),
      note: "not saved to a slot",
    })
  }
  if (renewal && "renewed" in renewal && renewal.missed) {
    // a slot left with the spent token fails the run, without hiding any other provider's rows
    process.exitCode = 1
    const row = rows.find((candidate) => candidate.live)
    if (row) row.note = `${row.note ? `${row.note}; ` : ""}renewed the live login${renewal.missed}`
  }
  return rows
}

function unavailable(provider: Provider, row: UsageRow): string {
  if (row.unavailable) return row.unavailable
  if (provider.quotaHint) return provider.quotaHint
  if (row.expiresAt !== undefined && row.expiresAt <= Date.now() && row.cloudOwned) {
    return `local login expired ${duration(Date.now() - row.expiresAt)} ago; in use by kyora cloud`
  }
  if (row.expiresAt !== undefined && row.expiresAt <= Date.now() && row.renewal) {
    return `access token expired ${duration(Date.now() - row.expiresAt)} ago; ${row.renewal}`
  }
  if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
    return `stored access token expired ${duration(Date.now() - row.expiresAt)} ago; load this slot to refresh it`
  }
  return "no quota reported"
}

function renderUsage(provider: Provider, rows: UsageRow[], width = slotWidth(rows)): void {
  if (rows.length === 0) {
    console.log(`${provider.id}: nothing logged in and no slots saved`)
    return
  }
  for (const row of rows) {
    const name = (row.slot ?? "live").padEnd(width)
    const marker = row.live ? "*" : " "
    const quota = row.quota ? describeQuota(row.quota) : unavailable(provider, row)
    console.log(`${marker} ${name}  ${row.account}${row.cloudOwned ? CLOUD_TAG : ""}`)
    console.log(`  ${" ".repeat(width)}  ${quota}`)
    if (row.note) console.log(`  ${" ".repeat(width)}  ${row.note}`)
  }
}

function slotWidth(rows: UsageRow[]): number {
  return Math.max(0, ...rows.map((row) => (row.slot ?? "live").length))
}

async function usage(providers: Provider[], json: boolean, refresh: boolean, explicit = false): Promise<void> {
  const multi = providers.length > 1
  const collected = await Promise.all(
    providers.map(async (provider) => {
      try {
        return [provider, await usageRows(provider, refresh, explicit)] as const
      } catch (error) {
        if (!multi) throw error
        return [provider, { error: unreadableMessage(error) }] as const
      }
    }),
  )
  const unreadable = collected.some(([, rows]) => !Array.isArray(rows))
  if (json) {
    console.log(JSON.stringify(Object.fromEntries(collected.map(([p, rows]) => [p.id, rows])), null, 2))
    if (unreadable) process.exitCode = 1
    return
  }

  const width = slotWidth(collected.flatMap(([, rows]) => (Array.isArray(rows) ? rows : [])))
  collected.forEach(([provider, rows], index) => {
    if (index > 0) console.log()
    if (providers.length > 1) console.log(`${provider.id}: ${provider.label}`)
    if (!Array.isArray(rows)) console.log(`${provider.id}: unreadable: ${rows.error}`)
    else renderUsage(provider, rows, width)
  })
  if (unreadable) process.exitCode = 1
}

async function clear(provider: Provider): Promise<void> {
  const outgoing = await withSwitchLock(provider.id, () => exclusively(provider, async () => {
    // the live login's latest tokens go into its slot first, so the slot keeps what the CLI last rotated to
    const state = await syncLiveSlot(provider)
    const outgoing = state.active
    if (!outgoing) return null
    warnOwned(provider, state)

    const backup = await writeBackup(outgoing)
    if (!state.live) {
      note(`${describeIdentity(outgoing.identity)} was in no slot; it is in ${backup}`)
    }

    await beginSwitch(provider.id)
    await provider.forget()
    await recordSwitch(provider.id, null)
    return outgoing
  }))
  if (!outgoing) {
    console.log(`${provider.id} is already signed out: ${provider.loginHint}`)
    return
  }
  console.log(`${provider.id} signed out locally: ${describeIdentity(outgoing.identity)}`)
  console.log(`  the account keeps its session, so a saved slot still loads; ${provider.loginHint} for another one`)
  warnNotes(provider, outgoing)
  const sessions = await runningSessions(provider)
  if (isRunning(sessions)) {
    note(`${provider.label} is running: restart it, the old token is already in memory`)
  }
  unknownRunning(provider, sessions)
}

async function remove(provider: Provider, name: string, yes: boolean): Promise<void> {
  const slot = (await readSlot(provider.id, assertName(name))) ?? die(`no ${provider.id} slot "${name}"`)
  if (!yes) {
    if (!process.stdin.isTTY) die(`refusing to delete ${provider.id} "${name}" without --yes`)
    if ((await prompt(`delete ${provider.id} slot "${name}"? [y/N] `)).toLowerCase() !== "y") {
      return console.log("cancelled")
    }
  }
  const removed = await withSwitchLock(provider.id, async () => {
    const current = (await readSlot(provider.id, name)) ?? die(`no ${provider.id} slot "${name}"`)
    if (provider.webSession) await deleteWebSession(provider.id, name)
    await removeSlot(provider.id, name)
    return current
  })
  console.log(`deleted ${provider.id} "${name}"`)
  if (isCloudOwned(slot) || isCloudOwned(removed)) {
    note(`kyora cloud still holds "${name}": \`kyora session creds rm --slot ${name}\` deletes it there`)
  }
}

async function rename(provider: Provider, from: string, to: string): Promise<void> {
  await withSwitchLock(provider.id, async () => {
    const slot = (await readSlot(provider.id, assertName(from))) ?? die(`no ${provider.id} slot "${from}"`)
    if (isCloudOwned(slot)) die(`"${from}" is in use by kyora cloud; ${takeBack(from)} first`)
    if (await readSlot(provider.id, assertName(to))) die(`${provider.id} slot "${to}" already exists`)
    if (provider.webSession) await moveWebSession(provider.id, from, to)
    try {
      await renameSlot(provider.id, from, to)
    } catch (error) {
      if (provider.webSession && (await readSlot(provider.id, from))) {
        await moveWebSession(provider.id, to, from).catch(() => {
          throw new Error(`${(error as Error).message}; the web session stayed under "${to}": \`${programName()} ${provider.id} web-login ${from}\` replaces it`)
        })
      }
      throw error
    }
  })
  console.log(`renamed ${provider.id} "${from}" to "${to}"`)
}

/** `kyora-switch muse team <slot> [<teamId>|unset]`: the team a Muse slot's usage is read for */
async function museTeam(name: string, team: string | undefined): Promise<void> {
  if (!(await readSlot("muse", assertName(name)))) die(`no muse slot "${name}"`)
  if (team === undefined) {
    const current = await readMuseTeam(name)
    return console.log(current ? `muse "${name}" reads usage for team ${current}` : `muse "${name}" has no team set; its usage reads the login's only team`)
  }
  await writeMuseTeam(name, team === "unset" ? null : team)
  console.log(team === "unset" ? `muse "${name}" team unset` : `muse "${name}" reads usage for team ${team}`)
}

/** `kyora-switch <provider> web-login <slot>`: a browser session for the slot, logged in by hand in a throwaway profile */
async function webLoginCommand(provider: Provider, name: string): Promise<void> {
  const config = provider.webSession ?? die(`web-login is not available for ${provider.id}`)
  if (!(await readSlot(provider.id, assertName(name)))) die(`no ${provider.id} slot "${name}"`)
  const browser = findBrowser() ?? die(NO_BROWSER)
  note(`opening ${browser} with a fresh, temporary profile`)
  const session = await webLogin(config, { browser, log: note })
  const where = await withSwitchLock(provider.id, async () => {
    if (!(await readSlot(provider.id, name))) die(`${provider.id} slot "${name}" was removed during the login; nothing saved`)
    return await writeWebSession(provider.id, name, session)
  })
  console.log(`${provider.id} "${name}" web session saved: ${where}`)
}

/** `kyora-switch <provider> web-logout <slot>`: forget the slot's browser session */
async function webLogoutCommand(provider: Provider, name: string): Promise<void> {
  if (!provider.webSession) die(`web-logout is not available for ${provider.id}`)
  const had = await withSwitchLock(provider.id, () => deleteWebSession(provider.id, assertName(name)))
  if (!had && !(await readSlot(provider.id, name))) die(`no ${provider.id} slot "${name}"`)
  console.log(had ? `${provider.id} "${name}" web session removed` : `${provider.id} "${name}" has no web session`)
}

async function sync(providers: Provider[]): Promise<void> {
  let unreadable = false
  for (const provider of providers) {
    try {
      const { active, synced, live, skipped, ambiguous, busy, spent } = await syncLiveSlot(provider)
      if (!active) console.log(`${pad(provider.id)} not logged in: nothing to sync`)
      else if (ambiguous.length > 0) {
        console.log(`${pad(provider.id)} ${describeIdentity(active.identity)} has the email of ${ambiguous.map((name) => `"${name}"`).join(", ")} and the token of none: not synced; \`${programName()} ${provider.id} save <slot>\` picks one`)
      }
      else if (skipped) {
        console.log(`${pad(provider.id)} skipped "${skipped}": in use by kyora cloud; ${takeBack(skipped)}`)
        note(`${provider.label} uses the same login locally and may be signed out`)
      } else if (synced) console.log(`${pad(provider.id)} synced "${synced}": ${describeIdentity(active.identity)}`)
      else if (live && spent) {
        console.log(`${pad(provider.id)} kept "${live.name}": it holds a renewal of the live login's spent token; \`${programName()} ${provider.id} load ${live.name}\` puts it live`)
      } else if (live && busy) {
        console.log(`${pad(provider.id)} skipped "${live.name}": the slot is busy, another kyora-switch is changing it; the next sync copies it`)
      } else if (live) {
        console.log(`${pad(provider.id)} already current: ${describeIdentity(active.identity)}`)
      } else {
        console.log(`${pad(provider.id)} ${describeIdentity(active.identity)} is in no slot; save it first`)
      }
    } catch (error) {
      if (providers.length === 1) throw error
      unreadable = true
      console.log(`${pad(provider.id)} unreadable: ${unreadableMessage(error)}`)
    }
  }
  if (unreadable) process.exitCode = 1
}

async function status(json: boolean): Promise<void> {
  const rows: { provider: ProviderId; identity: Snapshot["identity"] | null; slot: string | null; cloudOwned?: true; error?: string; notes: string[]; data: DataCollection }[] = []
  let unreadable = false
  for (const provider of PROVIDERS) {
    try {
      const state = await syncLiveSlot(provider, READ_SYNC_TIMEOUT_MS)
      warnOwned(provider, state)
      const slot = state.live
      rows.push({ provider: provider.id, identity: state.active?.identity ?? null, slot: slot?.name ?? null, ...(isCloudOwned(slot) ? { cloudOwned: true as const } : {}), notes: provider.notes?.(state.active) ?? [], data: dataCollection(provider.id, state.active) })
    } catch (error) {
      unreadable = true
      rows.push({ provider: provider.id, identity: null, slot: null, error: unreadableMessage(error), notes: [], data: dataCollection(provider.id, null) })
    }
  }
  if (json) {
    const shownData = (data: DataCollection) => ({ training: data.training, telemetry: data.telemetry, detail: scrub(data.line) })
    console.log(JSON.stringify(rows.map((row) => row.error ? { provider: row.provider, error: row.error, dataCollection: shownData(row.data) } : { provider: row.provider, identity: row.identity && shownIdentity(row.identity), slot: row.slot, ...(row.cloudOwned ? { cloudOwned: true } : {}), dataCollection: shownData(row.data) }), null, 2))
    if (unreadable) process.exitCode = 1
    return
  }

  for (const row of rows) {
    const provider = providerById(row.provider)
    const collection = `${pad("")} data collection: ${scrub(row.data.line)}`
    if (row.error) {
      console.log(`${pad(row.provider)} unreadable: ${row.error}`)
      console.log(collection)
      continue
    }
    if (!row.identity) {
      console.log(`${pad(row.provider)} not logged in: ${provider.loginHint}`)
      console.log(collection)
      for (const message of row.notes) note(message)
      continue
    }
    console.log(`${pad(row.provider)} ${describeIdentity(row.identity)}  (${row.slot ? `slot "${row.slot}"${"cloudOwned" in row ? ", kyora cloud's" : ""}` : "no slot"})`)
    console.log(collection)
    for (const message of row.notes) note(message)
  }
  if (unreadable) process.exitCode = 1
}

async function doctor(): Promise<void> {
  console.log(`slots: ${rootDir()}`)
  for (const provider of PROVIDERS) {
    console.log(`\n${provider.id}: ${provider.label}`)
    for (const location of provider.locations()) console.log(`  ${location}`)

    const snapshot = await provider.capture().catch((error: Error) => error)
    if (snapshot instanceof Error) console.log(`  status:  unreadable: ${snapshot.message}`)
    else if (!snapshot) console.log(`  status:  not logged in: ${provider.loginHint}`)
    else console.log(`  status:  ${describeIdentity(snapshot.identity)}`)

    const running = await runningSessions(provider)
    console.log(`  running: ${"unknown" in running ? `unknown (${running.unknown})` : running.count > 0 ? `yes (${running.count} process${running.count === 1 ? "" : "es"})` : "no"}`)
    console.log(`  slots:   ${(await listSlots(provider.id)).length}`)
  }
}

async function runProvider(
  provider: Provider,
  args: string[],
  json: boolean,
  yes: boolean,
  refresh: boolean,
  force: boolean,
  local: boolean,
  detailed = false,
): Promise<void> {
  const [command = "list", first, second] = args
  switch (command) {
    case "save":
      return await save(provider, first ?? die(`save needs a slot name`), force)
    case "load":
    case "use":
      return await load(provider, first ?? die(`load needs a slot name`), force)
    case "list":
    case "ls":
      return await list(provider, json)
    case "usage":
      return await usage([provider], json, refresh)
    case "tokens":
      return await (await import("./tokens")).tokens([provider], json, local, detailed)
    case "refresh":
      return await usage([provider], json, true, true)
    case "sync":
      return await sync([provider])
    case "rm":
    case "remove":
    case "delete":
      return await remove(provider, first ?? die(`rm needs a slot name`), yes)
    case "rename":
      return await rename(provider, first ?? die("rename needs the current name"), second ?? die("rename needs the new name"))
    case "clear":
    case "signout":
      return await clear(provider)
    case "team":
      if (provider.id !== "muse") die(`team is a muse command`)
      return await museTeam(first ?? die("team needs a slot name"), second)
    case "web-login":
      return await webLoginCommand(provider, first ?? die("web-login needs a slot name"))
    case "web-logout":
      return await webLogoutCommand(provider, first ?? die("web-logout needs a slot name"))
    default:
      die(`unknown ${provider.id} command "${command}"; run \`${programName()} --help\``)
  }
}

/** the stored private setting; settings that can't be read fail closed (private), with a note on how to fix them */
async function storedPrivacy(): Promise<boolean> {
  try {
    return (await readSettings()).private === true
  } catch (error) {
    note(`${(error as Error).message}: private mode assumed; \`${programName()} private on|off\` rewrites it`)
    return true
  }
}

/** `kyora-switch private [on|off]`: hide every account's email and org, show its plan */
async function privateCommand(value: string | undefined): Promise<void> {
  if (value === undefined) {
    const on = await storedPrivacy()
    return console.log(`private mode is ${on ? "on: accounts show their plan only (--reveal for one command)" : "off"}`)
  }
  if (value !== "on" && value !== "off") die(`private takes on or off, not "${value}"`)
  // written whole, without reading: a broken settings file is replaced, not a reason to refuse
  await writeSettings({ private: value === "on" })
  console.log(value === "on" ? "private mode on: accounts show their plan only (--reveal for one command)" : "private mode off")
}

async function main(argv: string[]): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        refresh: { type: "boolean" },
        "no-renew": { type: "boolean" },
        local: { type: "boolean" },
        detailed: { type: "boolean" },
        force: { type: "boolean" },
        private: { type: "boolean" },
        reveal: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    die((error as Error).message)
  }

  const { values, positionals } = parsed
  // --local and --detailed belong to `tokens` alone: anywhere else they fail exactly as they did before `tokens` existed
  if ((values.local || values.detailed) && !(positionals[0] === "tokens" || (isProviderId(positionals[0] ?? "") && positionals[1] === "tokens"))) {
    try {
      parseArgs({ args: argv, options: { json: { type: "boolean" }, refresh: { type: "boolean" }, "no-renew": { type: "boolean" }, force: { type: "boolean" }, private: { type: "boolean" }, reveal: { type: "boolean" }, yes: { type: "boolean", short: "y" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true })
    } catch (error) {
      die((error as Error).message)
    }
  }
  if (values.help) return console.log(help())
  if (values.private && values.reveal) die("--private and --reveal contradict each other")
  // --no-renew is accepted and changes nothing: usage never renews a login
  if (values["no-renew"] && (values.refresh || positionals[0] === "refresh" || (isProviderId(positionals[0] ?? "") && positionals[1] === "refresh"))) die("--no-renew and refresh contradict each other")

  const [head = "status", ...rest] = positionals
  if (head === "private") return await privateCommand(rest[0])
  const env = process.env.KYORA_SWITCH_PRIVATE
  setPrivate(values.reveal ? false : values.private || env === "1" || (env !== "0" && (await storedPrivacy())))
  if (isProviderId(head)) {
    return await runProvider(providerById(head), rest, Boolean(values.json), Boolean(values.yes), Boolean(values.refresh), Boolean(values.force), Boolean(values.local), Boolean(values.detailed))
  }

  switch (head) {
    case "status":
      return await status(Boolean(values.json))
    case "usage":
      return await usage(PROVIDERS, Boolean(values.json), Boolean(values.refresh))
    case "tokens":
      return await (await import("./tokens")).tokens(PROVIDERS, Boolean(values.json), Boolean(values.local), Boolean(values.detailed))
    case "refresh":
      return await usage(PROVIDERS, Boolean(values.json), true)
    case "sync":
      return await sync(PROVIDERS)
    case "doctor":
      return await doctor()
    case "help":
      return console.log(help())
    default:
      die(`unknown command "${head}"; run \`${programName()} --help\``)
  }
}

/** runs kyora-switch with `argv` (the arguments after the command), naming itself `program` in help and hints */
export async function run(argv: string[], program = "kyora-switch"): Promise<void> {
  setProgramName(program)
  await main(argv).catch((error: Error) => die(error.message))
}

if (import.meta.main) void run(Bun.argv.slice(2))
