import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ApiError, type CreateSpec, type VmsClient } from "../api"
import { collectExec } from "../exec"
import { extractTar } from "../extract"
import { gitMax, installHistory, prepareHistory, withHistory } from "../history"
import { Interrupt } from "../interrupt"
import { FAILED, note, printJson, queueNotes } from "../output"
import { git, type Listing, listFiles } from "../pack"
import { pull, push, WORK } from "../transfer"
import { formatMs, relativeTime } from "../units"
import { type AgentAdapter, type AgentId, exists, fileHash, type LocalSession, restoreConversation, sessionRoot, type StagedFile, writeAtomic } from "./agents"
import { follow, startDetached } from "./attach"
import { claudeAdapter } from "./claude"
import { codexAdapter } from "./codex"
import { branchRef, createBranch, deleteBranch, describeImport, importBundle, type ImportOutcome, PERSONAL_FILE, repoTop, revParse, SESSION_NAME, snapshotWorktree } from "./git"
import { mountablePath, type PathMap, REMOTE_HOME, REMOTE_WORK, toRemote } from "./paths"
import {
  type CloudCredential,
  checkpointArchive,
  createSession,
  deleteCredential,
  endSession,
  getSession,
  listCredentials,
  putCredential,
  returnCredential,
  type SessionCreated,
  updateSession,
} from "./platform"
import { CHECKPOINT_EVERY_S, CONTROL_DIR, exportDir, parseState, type RemoteState, setupRequest, STATUS_DIR, supervisorRequest, verifyExport } from "./remote"
import { clearCloudOwned, fingerprintOf, liveClaudeFingerprint, listSlots, markCloudOwned, readSlot, SLOT_NAME, type SlotProvider, slotCredential, writeBackSlot } from "./slots"
import { drivenFromCloud, forgetUpload, listStates, rememberReturn, rememberUpload, resolveState, returnedVersion, saveState, type SessionState, uploadedFingerprint, uploadOf, uploads } from "./state"

export const ADAPTERS: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

export const DEFAULT_PROMPT = (branch: string) =>
  [
    `You are now running unattended in a kyora cloud VM: the same repository at the same path, on branch ${branch}.`,
    "Continue the task from this conversation where it left off. Nobody is there to answer questions, so make reasonable decisions and note them.",
    `Commit your work on ${branch} as you reach milestones; it is synced back to the user's laptop from there.`,
  ].join(" ")

/**
 * The agent's permission mode in the VM when `up --permission-mode` doesn't name one. Nobody is
 * there to approve a tool call, and the VM is the boundary. Whether this
 * stays the default is still being decided: this constant is the one place to change it.
 */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions"

/** a kyora-vmd's sandbox cap unless its key raises it (kyora-vmd's --max-ttl) */
const VMD_TTL_S = 8 * 3600

/** untracked files whose names say "secret": they go up with the snapshot, onto kyora/<name>, and into a --pr */
const SECRET_NAME = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_[^/]*|\.mcp\.json)$/

/**
 * The untracked files the snapshot takes along (everything `git status` lists that .gitignore
 * doesn't exclude): they reach the VM, kyora/<name>, and with `pull --pr` the pull request. Those
 * named like secrets (`.env*`, `*.pem`, `*.key`, `id_*`, `.mcp.json`) are singled out. An untracked
 * `.claude/settings.local.json` doesn't go at all (`leftOut`): its env and hooks are where tokens live.
 */
export async function untrackedFiles(top: string): Promise<{ files: string[]; secrets: string[]; leftOut: string[] }> {
  const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], top)
  const all = listed.ok ? listed.stdout.split("\0").filter(Boolean).sort() : []
  const files = all.filter((file) => !PERSONAL_FILE.test(file))
  return { files, secrets: files.filter((file) => SECRET_NAME.test(file)), leftOut: all.filter((file) => PERSONAL_FILE.test(file)) }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const iso = () => new Date().toISOString()
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "-")

export interface UpOptions {
  repo: string
  session?: string
  agent: AgentId
  name?: string
  spec: CreateSpec
  wait: number
  ttlSeconds: number
  prompt?: string
  permissionMode: string
  model?: string
  checkpointSeconds: number
  /** commits of history the VM gets (git log, blame); 0 for all of it */
  gitDepth: number
  /** the explicit, unsafe opt-in: this kyora-switch slot's login is copied into the VM */
  copyCredentials?: string
  json: boolean
}

/** where a session's agent finds its credentials, and what it has to say about them */
async function credentialPlan(api: VmsClient, options: UpOptions, platform: boolean): Promise<{ copied: StagedFile[]; warning: string | null }> {
  const adapter = ADAPTERS[options.agent]
  if (options.copyCredentials) {
    const slot = await readSlot(options.agent, options.copyCredentials)
    if (!slot) throw new Error(`no kyora-switch slot ${options.agent}/${options.copyCredentials}`)
    return {
      copied: adapter.copiedCredentials(slot.files),
      warning:
        `--unsafe-copy-credentials: the login in ${options.agent}/${slot.name} is readable by everything in the VM and may sign this laptop out. Revoke it if the VM ran code you do not trust.`,
    }
  }
  if (!platform) throw new Error("sessions require kyora cloud; set KYORA_VMS_URL to https://cloud.kyora.sh, or pass --unsafe-copy-credentials <slot>")
  if (options.agent !== "claude") throw new Error(`${adapter.label} sessions require --unsafe-copy-credentials <slot>`)
  const { credentials } = await listCredentials(api)
  const usable = credentials.filter((credential) => credential.provider === "claude" && credential.cloudOwned && credential.state !== "revoked")
  if (usable.length === 0) throw new Error("no Claude login linked: run `kyora session creds sync --slot <name>`")
  return { copied: [], warning: null }
}

/** generated files into a temp dir, then up as one push to dest */
async function pushFiles(api: VmsClient, id: string, files: StagedFile[], dest: string, signal?: AbortSignal): Promise<void> {
  if (files.length === 0) return
  const tmp = await mkdtemp(join(tmpdir(), "kyora-session-files-"))
  try {
    for (const file of files) await writeAtomic(join(tmp, file.rel), file.contents, 0o600)
    await push(api, id, await listFiles(tmp, { git: false }), dest, { signal })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** the repo's files as they go to the VM: what the snapshot took, so without the untracked paths it left out */
export async function treeListing(top: string, leftOut: string[]): Promise<Listing> {
  const listing = await listFiles(top, { git: true })
  if (leftOut.length === 0) return listing
  const skip = new Set(leftOut)
  const entries = listing.entries.filter((entry) => !skip.has(entry.rel))
  return { ...listing, entries, bytes: entries.reduce((sum, entry) => sum + (entry.stats.isFile() ? entry.stats.size : 0), 0) }
}

/** `git check-ignore`: whether the repo leaves this path out (then it didn't go up with the tree) */
const ignoredIn = (top: string) => async (rel: string) => (await git(["check-ignore", "-q", "--", rel], top)).ok

/** every file the tree took up (tracked, and untracked .gitignore doesn't exclude), relative to the top */
const filesIn = (top: string) => async () => {
  const listed = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], top)
  return listed.ok ? [...new Set(listed.stdout.split("\0").filter(Boolean))] : []
}

export async function up(api: VmsClient, options: UpOptions): Promise<number> {
  const interrupt = new Interrupt()
  const top = await repoTop(resolve(options.repo))
  const adapter = ADAPTERS[options.agent]
  const local = await adapter.find({ cwd: resolve(options.repo), top, id: options.session })
  const driven = await drivenFromCloud(local.id)
  if (driven) throw new Error(`${adapter.label} session ${local.id} already runs in the cloud as ${driven.name} (\`kyora session status ${driven.name}\`)`)
  const platform = (await api.kind()) === "platform"
  const creds = await credentialPlan(api, options, platform)
  const name = options.name ?? `s${randomBytes(3).toString("hex")}`
  if (!SESSION_NAME.test(name)) throw new Error(`--name ${name}: lowercase letters, digits, . _ - (at most 48)`)
  if (await revParse(top, branchRef(name))) throw new Error(`kyora/${name} exists already; pick another --name`)
  const localRoot = (await sessionRoot(local.cwd, top)) ?? top
  const upstream = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], top)).stdout.trim() || null
  const untracked = await untrackedFiles(top)

  const cleanup: Array<() => Promise<unknown>> = []
  let created: SessionCreated | null = null
  try {
    // 1. the working tree as a commit on kyora/<name>; the user's index and files stay as they are
    const snapshot = await snapshotWorktree(top, `kyora session ${name}: the working tree as it moved to the cloud`, untracked.leftOut)
    await createBranch(top, name, snapshot.commit)
    cleanup.push(() => deleteBranch(top, name, snapshot.commit))
    const branch = branchRef(name)

    // 2. kyora cloud's record of it: who drives, and the session token for the broker
    let ttlSeconds = options.ttlSeconds
    if (platform) {
      created = await createSession(api, { name, agent: options.agent, agentSession: local.id, repo: top, branch: `kyora/${name}`, base: snapshot.commit, ttlSeconds })
      const session = created.session
      cleanup.push(() => endSession(api, session.id, { destroy: true, reason: "up failed" }).catch(() => {}))
      if (ttlSeconds > created.limits.maxTtlSeconds) {
        note(`--ttl ${formatMs(ttlSeconds * 1000)} is over what kyora cloud gives a session (${formatMs(created.limits.maxTtlSeconds * 1000)}); using that`)
        ttlSeconds = created.limits.maxTtlSeconds
      }
    } else if (ttlSeconds > VMD_TTL_S) {
      note(`--ttl ${formatMs(ttlSeconds * 1000)} exceeds the default limit; using ${formatMs(VMD_TTL_S * 1000)}`)
      ttlSeconds = VMD_TTL_S
    }

    // 3. the sandbox, the repo in it with kyora/<name> checked out, and history behind it
    const spec: CreateSpec = { network: "registries", ...options.spec, ttlSeconds, idleSeconds: Math.min(ttlSeconds, 8 * 3600), labels: { ...options.spec.labels, "kyora.session": name }, ...(created ? { session: created.session.id } : {}) }
    const sandbox = await api.create(spec, { wait: options.wait, signal: interrupt.signal, onQueued: queueNotes(options.wait) })
    cleanup.push(() => api.destroy(sandbox.id).catch(() => {}))
    // recorded at once: the supervisor's exec may then run as long as the session's TTL class lets it
    if (created) await updateSession(api, created.session.id, { sandboxId: sandbox.id })
    note(`${sandbox.id}: pushing ${top} at ${short(snapshot.commit)} (kyora/${name})`)
    let listing = await treeListing(top, untracked.leftOut)
    const history = await prepareHistory(top, listing, { maxBytes: gitMax(), ...(options.gitDepth > 0 ? { depth: options.gitDepth } : {}), at: { commit: snapshot.commit, branch } }, interrupt.signal)
    try {
      listing = withHistory(listing, history)
      await push(api, sandbox.id, listing, WORK, { signal: interrupt.signal })
      await installHistory(api, sandbox.id, history, WORK, interrupt.signal)
    } finally {
      await history.cleanup()
    }

    // 4. the repo at the laptop's path, if the image lets it; the agent's CLI at the laptop's version
    const plan = adapter.launch(local, { local: localRoot, remote: localRoot }, { prompt: "", permissionMode: options.permissionMode, broker: null, configArgs: [] })
    const want = mountablePath(localRoot) || localRoot === REMOTE_WORK ? localRoot : REMOTE_WORK
    const setup = await collectExec(await api.exec(sandbox.id, setupRequest({ want, bin: plan.install.bin, pkg: plan.install.pkg, version: plan.install.version, health: created && !options.copyCredentials ? new URL("/v1/health", created.broker.anthropic).toString() : null }), interrupt.signal))
    api.execExited(sandbox.id)
    if (setup.code !== 0) throw new Error(`setting up the session in ${sandbox.id} failed (exit ${setup.code}): ${setup.error ?? setup.stderr.trim().split("\n").slice(-3).join(" / ")}`)
    const mode = want === localRoot && /mode=same-path/.test(setup.stdout) ? "same-path" : "mapped"
    const map: PathMap = { local: localRoot, remote: mode === "same-path" ? localRoot : REMOTE_WORK }
    if (mode === "mapped") note(`${sandbox.id}'s image can't put the repo at ${localRoot}: it stays at ${REMOTE_WORK}, and the conversation's paths are rewritten to match (and back on pull)`)

    // 5. the conversation and the project's portable config into the VM's HOME
    const config = await adapter.config(local, map, { ignored: ignoredIn(top), files: filesIn(top) })
    await pushFiles(api, sandbox.id, [...(await adapter.stage(local, map)), ...config.files, ...creds.copied], REMOTE_HOME, interrupt.signal)

    // 6. the supervisor: the agent, checkpoints, the export; it outlives this command
    const launch = adapter.launch(local, map, {
      prompt: options.prompt ?? DEFAULT_PROMPT(`kyora/${name}`),
      permissionMode: options.permissionMode,
      broker: created && !options.copyCredentials ? { baseUrl: created.broker.anthropic, token: created.token } : null,
      configArgs: config.args,
      ...(options.model ? { model: options.model } : {}),
    })
    const paths = adapter.exportPaths(local, map)
    const execId = await startDetached(
      api,
      sandbox.id,
      supervisorRequest({
        cwd: toRemote(map, local.cwd),
        branch,
        base: snapshot.commit,
        file: paths.file,
        extra: paths.extra,
        checkpointSeconds: options.checkpointSeconds,
        api: created?.api ?? null,
        token: created?.token ?? null,
        agent: { argv: launch.argv, env: launch.env },
        timeoutSeconds: ttlSeconds,
      }),
    )
    if (created) await updateSession(api, created.session.id, { execId, state: "running", driver: "cloud", mode })

    const state: SessionState = {
      version: 1,
      name,
      id: created?.session.id ?? sandbox.id,
      url: api.url,
      repo: top,
      agent: options.agent,
      agentSession: local.id,
      local: { id: local.id, file: local.file, extra: local.extra, hash: (await fileHash(local.file))! },
      remoteFiles: paths,
      map,
      mode,
      base: snapshot.commit,
      head: snapshot.parent,
      upstream,
      sandbox: sandbox.id,
      exec: execId,
      driver: "cloud",
      slots: platform && !options.copyCredentials ? await uploads() : undefined,
      createdAt: iso(),
      pulledAt: null,
      stoppedAt: null,
    }
    await saveState(state)
    cleanup.length = 0

    if (options.json) printJson({ session: state, dropped: config.dropped, warning: creds.warning, untracked: untracked.files, secrets: untracked.secrets, leftOut: untracked.leftOut })
    else {
      console.log(`${name}: ${adapter.label} session ${local.id} runs in ${sandbox.id} on kyora/${name} (${mode === "same-path" ? `at ${localRoot}` : `at ${REMOTE_WORK}, paths mapped`})`)
      console.log(`  ttl ${formatMs(ttlSeconds * 1000)} · checkpoint every ${formatMs(options.checkpointSeconds * 1000)} · ${created ? "login credentials stay out of the VM" : "credentials copied into the VM"}`)
      if (config.dropped.length > 0) console.log(`  left out of the VM's config:\n${config.dropped.map((line) => `    - ${line}`).join("\n")}`)
      if (untracked.leftOut.length > 0) console.log(`  left here, untracked and personal: ${untracked.leftOut.join(", ")}`)
      if (untracked.files.length > 0) {
        const shown = untracked.files.slice(0, 20).map((file) => `    ${file}`).join("\n")
        console.log(`  untracked files that went up (on kyora/${name} now, and in a --pr):\n${shown}${untracked.files.length > 20 ? `\n    … and ${untracked.files.length - 20} more` : ""}`)
      }
      console.log(`  kyora session attach ${name}   watch it\n  kyora session status ${name}   where it stands\n  kyora session pull ${name}     its commits and conversation back here (--stop ends it, --pr opens a PR)`)
    }
    if (creds.warning) note(creds.warning)
    if (untracked.secrets.length > 0) {
      note(
        `untracked files that look like secrets went up with the snapshot: ${untracked.secrets.join(", ")}. They are in the VM and on kyora/${name}, and \`pull --pr\` would push them; ` +
          `add them to .gitignore (then \`kyora session pull ${name} --stop\` and \`up\` again), or delete them from kyora/${name} before a --pr`,
      )
    }
    return 0
  } catch (error) {
    for (const undo of cleanup.reverse()) await undo().catch(() => {})
    if (interrupt.interrupted) return interrupt.code!
    throw error
  } finally {
    interrupt.dispose()
  }
}


/** downloads a sandbox path into a temp dir; null when the sandbox (or the path) is gone */
async function fetchDir(api: VmsClient, sandbox: string, path: string, signal?: AbortSignal): Promise<{ root: string; dir: string } | null> {
  const root = await mkdtemp(join(tmpdir(), "kyora-session-pull-"))
  try {
    await pull(api, sandbox, path, root, signal)
    return { root, dir: join(root, path.slice(1)) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return null
    throw error
  }
}

async function remoteState(api: VmsClient, state: SessionState): Promise<RemoteState | null> {
  const fetched = await fetchDir(api, state.sandbox, STATUS_DIR).catch(() => null)
  if (!fetched) return null
  try {
    return parseState(await readFile(join(fetched.dir, "state"), "utf8"))
  } catch {
    return null
  } finally {
    await rm(fetched.root, { recursive: true, force: true })
  }
}

/**
 * The export the supervisor's state names (the one `known` names, else the current one), fetched
 * and checked whole against its manifest. A generation cleaned up or cut mid-download is fetched
 * again from a fresh state; null when there is no export (yet) or no sandbox.
 */
async function fetchExport(api: VmsClient, state: SessionState, known: RemoteState | null): Promise<{ root: string; dir: string } | null> {
  let remote = known
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!remote || remote.export === null) remote = await remoteState(api, state)
    if (!remote || remote.export === null) return null
    const fetched = await fetchDir(api, state.sandbox, exportDir(remote.export))
    if (fetched && (await verifyExport(fetched.dir, remote.export))) return fetched
    if (fetched) await rm(fetched.root, { recursive: true, force: true })
    // the generation it names isn't there, and a fresh state names the same: no export to take (kyora cloud's checkpoint may stand in)
    const named = remote.export
    remote = await remoteState(api, state)
    if (!fetched && (!remote || remote.export === null || remote.export === named)) return null
  }
  throw new Error(`${state.name}'s export kept changing under the download; try again`)
}

/** a file into the supervisor's control directory: its whole protocol. "gone" when the sandbox is, "unavailable" when it can't take files now */
async function signalSupervisor(api: VmsClient, state: SessionState, file: string): Promise<"asked" | "gone" | "unavailable"> {
  try {
    await pushFiles(api, state.sandbox, [{ rel: file, contents: `${iso()}\n` }], CONTROL_DIR)
    return "asked"
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return "gone"
    if (error instanceof ApiError && error.status === 409) return "unavailable"
    throw error
  }
}

/** waits for the supervisor's state to say `done`; null when it never did */
async function awaitState(api: VmsClient, state: SessionState, done: (remote: RemoteState) => boolean, timeoutMs: number): Promise<RemoteState | null> {
  const until = Date.now() + timeoutMs
  let last: RemoteState | null = null
  while (Date.now() < until) {
    last = await remoteState(api, state)
    if (last && done(last)) return last
    if (last && last.supervisor !== "running") return last
    await Bun.sleep(1_000)
  }
  return null
}

interface Guarded {
  slot: string
  why: string
}

/**
 * The refresh-rotation guard, on the laptop's side: a slot the broker owns whose refresh token
 * changed here since it went up was refreshed (or re-logged) on this laptop meanwhile. One of
 * the two copies is spent now, and whichever refreshes next with it is signed out.
 */
async function rotatedSlots(state: SessionState): Promise<Guarded[]> {
  const found: Guarded[] = []
  for (const [key, uploaded] of Object.entries({ ...state.slots, ...(await uploads()) })) {
    const [provider, name] = key.split("/") as [SlotProvider, string]
    const slot = await readSlot(provider, name).catch(() => null)
    if (!slot) continue
    const now = (() => {
      try {
        return slotCredential(slot).fingerprint
      } catch {
        return null
      }
    })()
    if (now && now !== uploaded) found.push({ slot: key, why: "its login changed on this laptop while in use by kyora cloud" })
  }
  return found
}

export async function status(api: VmsClient, name: string | undefined, repo: string | null, asJson: boolean): Promise<number> {
  const state = await resolveState(name, repo)
  const platform = (await api.kind()) === "platform" && state.id.startsWith("ses_")
  const cloud = platform ? await getSession(api, state.id).catch((error) => ({ error: message(error) })) : null
  const remote = state.driver === "cloud" ? await remoteState(api, state) : null
  const localHash = await fileHash(state.local.file)
  const resumedHere = state.driver === "cloud" && localHash !== null && localHash !== state.local.hash
  const rotated = await rotatedSlots(state)
  const behind = platform ? await rotatedSinceReturn((await listCredentials(api).catch(() => ({ credentials: [] as CloudCredential[] }))).credentials) : []
  if (asJson) {
    printJson({ session: state, cloud, remote, resumedHere, rotated, behind })
    return 0
  }
  const session = cloud && !("error" in cloud) ? cloud : null
  console.log(`${state.name} · ${ADAPTERS[state.agent].label} ${state.agentSession} · driven from the ${state.driver}${state.stoppedAt ? ` (stopped ${relativeTime(state.stoppedAt)})` : ""}`)
  console.log(`  repo      ${state.repo} on kyora/${state.name} (from ${short(state.base)}${state.upstream ? `, ${state.upstream}` : ""})`)
  console.log(`  sandbox   ${state.sandbox}${state.mode === "mapped" ? " (repo at /work, paths mapped)" : ""}${session ? ` · ${session.state}` : ""}`)
  if (remote) {
    const exit = remote.agentExit === null ? "" : ` (exit ${remote.agentExit})`
    console.log(`  agent     ${remote.agent}${exit}${remote.started ? ` · since ${relativeTime(remote.started)}` : ""} · transcript ${Math.round(remote.transcriptBytes / 1024)} KB`)
    console.log(`  checkpoint ${remote.checkpoint ? `${short(remote.checkpoint)} ${relativeTime(remote.checkpointAt ?? undefined)}` : "none yet"}${remote.tip && remote.tip !== remote.checkpoint ? ` · tip ${short(remote.tip)}` : ""}`)
    if (remote.note) console.log(`  note      ${remote.note}`)
    if (remote.report) console.log(`  reported  ${remote.report}`)
  } else if (state.driver === "cloud") {
    const last = session?.lastCheckpoint
    console.log(
      `  agent     unreachable (the sandbox is gone or busy)${last ? ` · last checkpoint ${short(last.commit)} ${relativeTime(last.at)}${last.stored ? ", kept by kyora cloud: `kyora session pull` gets it" : ", too large for kyora cloud to keep (`pull` falls back to an older one, if it kept one)"}` : ""}`,
    )
  }
  if (session?.slot) console.log(`  login     slot ${session.slot}`)
  if (session && session.children.length > 0) console.log(`  children  ${session.children.join(", ")}`)
  if (resumedHere) note(`the conversation was resumed on this laptop while the cloud drives it; a pull keeps both (the VM's comes back under a new id)`)
  for (const guard of rotated) note(`slot ${guard.slot}: ${guard.why}; the local or cloud login may be signed out`)
  for (const slot of behind) note(`${slot}: a newer login is available in kyora cloud; run \`kyora session creds return --slot ${slot.split("/")[1]}\` again`)
  return 0
}

export async function attach(api: VmsClient, name: string | undefined, repo: string | null, raw: boolean): Promise<number> {
  const state = await resolveState(name, repo)
  if (!state.exec) throw new Error(`${state.name} has no running command to attach to`)
  const interrupt = new Interrupt()
  try {
    note(`attached to ${state.name} in ${state.sandbox}; Ctrl-C lets go (the agent runs on)`)
    const end = await follow(api, state.sandbox, state.exec, { raw, signal: interrupt.signal })
    if (end.kind === "exit") note(`the session's supervisor ended${end.code === null ? "" : ` (exit ${end.code})`}; \`kyora session pull ${state.name}\` brings its work back`)
    else if (end.kind === "lost") {
      note(`lost the session's stream: ${end.reason}`)
      return FAILED
    }
    return 0
  } finally {
    interrupt.dispose()
  }
}

export interface PullOptions {
  name?: string
  repo: string | null
  stop: boolean
  /** --stop even though the supervisor never confirmed its last checkpoint */
  force?: boolean
  pr: boolean
  base?: string
  json: boolean
  /** how long the supervisor gets to confirm a sync or stop (90 s; tests shorten it) */
  confirmMs?: number
}

/**
 * The VM's work back here: a fresh export (asked for through the control directory), its
 * commits fetched onto kyora/<name> (or beside it), its transcript back into place (or forked),
 * and with --stop the session ended and its sandbox destroyed. When the sandbox is gone, the
 * last checkpoint kyora cloud kept stands in.
 */
export async function pullSession(api: VmsClient, options: PullOptions): Promise<number> {
  const state = await resolveState(options.name, options.repo)
  const adapter = ADAPTERS[state.agent]
  const platform = (await api.kind()) === "platform" && state.id.startsWith("ses_")
  let source = "the sandbox"
  let exported: { root: string; dir: string } | null = null
  // whether the supervisor said its last checkpoint is made (or there is no sandbox left to say it)
  let confirmed = true
  let gone = false
  let why: string | null = null
  try {
    if (state.driver === "cloud" || !state.stoppedAt) {
      const seq = Date.now()
      const signalled = await signalSupervisor(api, state, options.stop ? "stop" : `sync-${seq}`)
      const asked = signalled === "asked"
      // a sandbox that is gone has nothing left to lose; one that is there but didn't answer may
      if (signalled === "unavailable") confirmed = false
      let remote: RemoteState | null = null
      gone = signalled === "gone"
      if (asked) {
        remote = await awaitState(api, state, (s) => (options.stop ? s.supervisor === "stopped" : s.seq >= seq), options.confirmMs ?? 90_000)
        // stopped, and its last checkpoint made: anything short of that may leave work only the sandbox has
        if (options.stop) confirmed = remote?.supervisor === "stopped" && remote.final === "done"
        if (options.stop && remote?.supervisor === "stopped" && remote.final !== "done") note(`the session's supervisor stopped without its last checkpoint (${remote.final ?? "it didn't say why"})`)
        else if (!remote || (options.stop && !confirmed)) note("the session's supervisor didn't confirm within 90 s; taking the export it made last")
        why = remote?.final && remote.final !== "done" ? remote.final : (remote?.note ?? null)
      }
      // the generation the state that answered names (it is complete, and stays a while): never a half-swapped one
      exported = signalled !== "gone" ? await fetchExport(api, state, remote).catch((error) => (asked ? Promise.reject(error) : null)) : null
    }
    if (!exported && platform) {
      const response = await checkpointArchive(api, state.id).catch((error) => {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      })
      if (response) {
        const root = await mkdtemp(join(tmpdir(), "kyora-session-checkpoint-"))
        await extractTar(response.body!, root)
        exported = { root, dir: root }
        source = "the last checkpoint kyora cloud kept"
      }
    }
    if (!exported) {
      throw new Error(
        gone || state.stoppedAt
          ? `nothing to pull for ${state.name}: its sandbox is gone and kyora cloud has no checkpoint of it`
          : `nothing to pull for ${state.name} yet: ${state.sandbox} holds no export${why ? ` (${why})` : ""} and kyora cloud no checkpoint; the sandbox is kept (\`--stop --force\` destroys it)`,
      )
    }

    const top = state.repo
    const bundle = join(exported.dir, "history.bundle")
    const commits: ImportOutcome | null = (await exists(bundle)) ? await importBundle(top, bundle, state.name) : null

    const paths = state.remoteFiles
    const transcript = join(exported.dir, "home", paths.file)
    let conversation: Awaited<ReturnType<typeof restoreConversation>> | null = null
    if (await exists(transcript)) {
      const original: LocalSession = { agent: state.agent, id: state.agentSession, cwd: state.map.local, file: state.local.file, extra: state.local.extra, model: null, version: null }
      const extra = paths.extra && (await exists(join(exported.dir, "home", paths.extra))) ? join(exported.dir, "home", paths.extra) : null
      conversation = await restoreConversation(adapter, { session: original, file: state.local.file, extra: state.local.extra ?? adapter.forkFile(original, state.agentSession).extra, id: state.local.id }, state.local.hash, { file: transcript, extra }, state.map)
      if (conversation.kind === "forked") {
        const fork = adapter.forkFile(original, conversation.id)
        state.local = { id: conversation.id, file: conversation.file, extra: fork.extra, hash: conversation.hash }
      } else state.local = { ...state.local, hash: conversation.hash }
    }

    let prUrl: string | null = null
    if (options.pr) prUrl = await openPullRequest(top, state, commits, options.base)

    let destroyed: string[] = []
    // the sandbox holds the only copy of whatever its last checkpoint didn't catch: it stays unless that checkpoint is made
    const stopping = options.stop && (confirmed || options.force === true)
    if (stopping) {
      if (platform) destroyed = (await endSession(api, state.id, { destroy: true, reason: "kyora session pull --stop" })).destroyed
      else if (await api.destroy(state.sandbox)) destroyed = [state.sandbox]
      state.driver = "local"
      state.stoppedAt = iso()
    }
    state.pulledAt = iso()
    await saveState(state)
    const kept = options.stop && !stopping

    if (options.json) printJson({ session: state.name, source, commits, conversation, pr: prUrl, destroyed, stopped: stopping, ...(kept ? { kept: state.sandbox } : {}) })
    else {
      if (source !== "the sandbox") console.log(`from ${source}`)
      console.log(commits ? describeImport(commits, state.name) : `kyora/${state.name}: no new commits`)
      if (conversation?.kind === "forked") {
        console.log(`conversation: it was resumed on this laptop too, so the VM's went in beside it as ${conversation.id}`)
        console.log(`  ${state.agent === "claude" ? `claude --resume ${conversation.id}` : `codex resume ${conversation.id}`}   (the laptop's own stays ${conversation.from})`)
      } else if (conversation) console.log(`conversation: ${conversation.kind === "updated" ? "brought up to date" : "unchanged"}: ${state.agent === "claude" ? `claude --resume ${conversation.id}` : `codex resume ${conversation.id}`}`)
      if (prUrl) console.log(`pull request: ${prUrl}`)
      if (stopping) console.log(`stopped ${state.name}${destroyed.length > 0 ? `; destroyed ${destroyed.join(", ")}` : ""}`)
      else if (state.driver === "cloud" && !kept) console.log(`${state.name} keeps running in the cloud; \`kyora session pull ${state.name} --stop\` ends it`)
    }
    if (kept) {
      note(
        `not stopped: ${state.sandbox}'s supervisor never confirmed its last checkpoint, so the sandbox may hold work the export above lacks. ` +
          `It keeps running: \`kyora session pull ${state.name} --stop\` tries again, \`--force\` destroys it anyway`,
      )
      return FAILED
    }
    return 0
  } finally {
    if (exported) await rm(exported.root, { recursive: true, force: true })
  }
}

/**
 * --pr: kyora/<name> to GitHub with the laptop's own git credentials (the VM never had any),
 * then a pull request through `gh` when it is installed. Never force, never anything but that
 * branch.
 */
async function openPullRequest(top: string, state: SessionState, commits: ImportOutcome | null, base: string | undefined): Promise<string | null> {
  const ref = commits?.kind === "kept-remote" ? commits.ref : branchRef(state.name)
  const pushed = await git(["push", "--quiet", "origin", `${ref}:refs/heads/kyora/${state.name}`], top)
  if (!pushed.ok) throw new Error(`pushing kyora/${state.name} to origin failed: ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`)
  const target = base ?? state.upstream ?? "main"
  const gh = Bun.spawnSync(["gh", "pr", "create", "--head", `kyora/${state.name}`, "--base", target, "--title", `kyora session ${state.name}`, "--body", `Work from the kyora cloud session ${state.name} (${ADAPTERS[state.agent].label} ${state.agentSession}), started from ${short(state.base)}.`], { cwd: top, stdout: "pipe", stderr: "pipe" })
  if (gh.exitCode === 0) return gh.stdout.toString().trim().split("\n").at(-1) ?? null
  note(`pushed kyora/${state.name}; \`gh pr create --head kyora/${state.name} --base ${target}\` didn't work (${gh.stderr.toString().trim().split("\n").at(-1) ?? "gh missing"}), open the PR by hand`)
  return null
}

export async function list(asJson: boolean): Promise<number> {
  const states = await listStates()
  if (asJson) {
    printJson({ sessions: states })
    return 0
  }
  if (states.length === 0) {
    console.log("no sessions; `kyora session up` starts one")
    return 0
  }
  for (const state of states) console.log(`${state.name.padEnd(10)}  ${state.driver.padEnd(5)}  ${state.sandbox.padEnd(22)}  ${state.repo}  (${relativeTime(state.createdAt)})`)
  return 0
}

// ── credentials ─────────────────────────────────────────────────────────────

export interface SyncOptions {
  provider: SlotProvider
  /** the kyora-switch slots to upload; empty with `all` */
  slots: string[]
  /** every slot of the provider (`--all`); without it, `--slot` must name them */
  all?: boolean
  /** take a slot even though it is the login this laptop uses */
  allowLive: boolean
  /** upload over a login the broker owns even though it may have refreshed it since (`--force`) */
  force?: boolean
  /** a bare token or key from stdin instead of a slot: `claude setup-token`'s, or an API key */
  stdin?: { kind: "oauth-token" | "api-key"; name: string }
  json: boolean
}

/**
 * What the laptop keeps once an upload went through: its fingerprint and version (what a later
 * upload over it must name), the slot marked as the broker's in its slot.json (kyora-switch then
 * leaves it alone), and the running sessions told. Done per slot, as each goes up, so a sync that
 * fails half way leaves the record of exactly what did.
 */
async function uploaded(credential: CloudCredential, fromSlot: boolean): Promise<void> {
  const key = `${credential.provider}/${credential.name}`
  await rememberUpload(key, credential.fingerprint, credential.version)
  if (fromSlot) await markCloudOwned(credential.provider, credential.name, credential.fingerprint)
  for (const state of await listStates()) {
    if (state.driver !== "cloud") continue
    state.slots = { ...state.slots, [key]: credential.fingerprint }
    await saveState(state)
  }
}

/**
 * `kyora session creds sync`: kyora-switch slots up to kyora cloud's vault, for the broker. Each
 * slot's login is only read; its slot.json is marked as the broker's. A slot whose login is the
 * one this laptop's CLI is using is refused: both sides would refresh the same rotating token,
 * and one would be signed out. A slot the broker owns already is uploaded again only over the
 * very version this laptop put there (kyora cloud refuses it once the broker refreshed it: the
 * slot's copy is spent then, and `creds return` brings the live one back), or with --force.
 */
export async function credsSync(api: VmsClient, options: SyncOptions): Promise<number> {
  if ((await api.kind()) !== "platform") throw new Error("credential sync requires kyora cloud; set KYORA_VMS_URL to https://cloud.kyora.sh")
  const done: CloudCredential[] = []
  const refused: Array<{ slot: string; why: string }> = []
  const unchanged: string[] = []
  // what kyora cloud holds, asked once: a copy deleted (or handed back) elsewhere is no reason to skip
  let held: Map<string, CloudCredential> | null = null
  const heldNow = async () => (held ??= new Map((await listCredentials(api)).credentials.map((credential) => [`${credential.provider}/${credential.name}`, credential])))
  const put = async (name: string, body: Parameters<typeof putCredential>[3], fromSlot: boolean) => {
    const previous = await uploadOf(`${options.provider}/${name}`)
    // the very login this laptop put there already, and kyora cloud's broker still has it: nothing to send (nor to disturb, a refresh in flight included)
    if (previous && previous.fingerprint === body.fingerprint && !options.force && (await heldNow()).get(`${options.provider}/${name}`)?.cloudOwned) {
      if (fromSlot) await markCloudOwned(options.provider, name, body.fingerprint)
      unchanged.push(`${options.provider}/${name}`)
      return
    }
    try {
      const credential = await putCredential(api, options.provider, name, { ...body, ...(previous?.version ? { expectVersion: previous.version } : {}), ...(options.force ? { force: true } : {}) })
      await uploaded(credential, fromSlot)
      done.push(credential)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) refused.push({ slot: `${options.provider}/${name}`, why: error.message })
      else throw error
    }
  }
  if (options.stdin) {
    const value = (await Bun.stdin.text()).trim()
    if (!value) throw new Error("nothing on stdin: pipe the token in, e.g. `claude setup-token | kyora session creds sync --setup-token --name ci`")
    if (!SLOT_NAME.test(options.stdin.name)) throw new Error(`--name ${options.stdin.name}: letters, digits, . _ -`)
    await put(options.stdin.name, { kind: options.stdin.kind, credential: value, fingerprint: fingerprintOf(value), identity: {} }, false)
  } else {
    if (options.slots.length === 0 && !options.all) throw new Error("creds sync uploads the slots it is told to: --slot NAME (repeatable), or --all for every slot of the provider")
    const names = options.all ? await listSlots(options.provider) : options.slots
    if (names.length === 0) throw new Error(`no kyora-switch slots for ${options.provider}; \`kyora-switch ${options.provider} save <name>\` makes one`)
    const live = options.provider === "claude" ? await liveClaudeFingerprint() : null
    let position = 0
    for (const name of names) {
      const slot = await readSlot(options.provider, name)
      if (!slot) throw new Error(`no kyora-switch slot ${options.provider}/${name}`)
      const credential = slotCredential(slot)
      if (live && credential.fingerprint === live && !options.allowLive) {
        throw new Error(
          `slot ${options.provider}/${name} is in use locally; syncing it may sign this laptop out. ` +
            "Log in once more for the cloud (`/login`, then `kyora-switch claude save cloud-…`), or use `claude setup-token`; --allow-live takes it anyway",
        )
      }
      await put(name, { kind: credential.kind, credential: credential.credential, fingerprint: credential.fingerprint, identity: slot.identity, position: position++ }, true)
    }
  }
  if (options.json) printJson({ credentials: done, refused, unchanged })
  else {
    for (const slot of unchanged) console.log(`${slot}: kyora cloud has this very login already; nothing sent`)
    for (const credential of done) console.log(`uploaded ${credential.provider}/${credential.name} (${credential.kind}${credential.identity.account ? `, ${credential.identity.account}` : ""}) · version ${credential.version} · in use by kyora cloud until \`kyora session creds return\``)
    for (const { slot, why } of refused) console.log(`not uploaded ${slot}: ${why}`)
  }
  return refused.length > 0 ? FAILED : 0
}

export async function credsList(api: VmsClient, asJson: boolean): Promise<number> {
  const { credentials } = await listCredentials(api)
  if (asJson) {
    printJson({ credentials })
    return 0
  }
  if (credentials.length === 0) {
    console.log("kyora cloud holds no credentials; `kyora session creds sync` uploads kyora-switch slots")
    return 0
  }
  const behind = await rotatedSinceReturn(credentials)
  for (const credential of credentials) {
    const state = credential.state === "cooling" && credential.cooldownUntil ? `rate-limited until ${credential.cooldownUntil}` : credential.state
    console.log(`${`${credential.provider}/${credential.name}`.padEnd(24)}  ${credential.kind.padEnd(11)}  ${(credential.cloudOwned ? "cloud" : "returned").padEnd(8)}  ${state}${credential.lastError ? `: ${credential.lastError}` : ""}`)
  }
  for (const slot of behind) note(`${slot}: a newer login is available in kyora cloud; run \`kyora session creds return --slot ${slot.split("/")[1]}\` again`)
  return 0
}

/** handed-back logins whose cloud copy is newer than the version this laptop took back: a refresh that landed after the hand-back */
async function rotatedSinceReturn(credentials: CloudCredential[]): Promise<string[]> {
  const out: string[] = []
  for (const credential of credentials) {
    const key = `${credential.provider}/${credential.name}`
    const took = await returnedVersion(key)
    if (!credential.cloudOwned && took !== null && credential.version > took) out.push(key)
  }
  return out
}

/**
 * `kyora session creds return`: the hand-back. The broker stops using the slot, and the login
 * it kept refreshing goes back into the kyora-switch slot, unless the slot moved on here too
 * (then both copies may be spent; --force writes the cloud's anyway).
 */
export async function credsReturn(api: VmsClient, provider: SlotProvider, names: string[], force: boolean, asJson: boolean): Promise<number> {
  const results: Array<{ name: string; written: boolean; why: string }> = []
  let failed = false
  for (const name of names) {
    const local = await readSlot(provider, name)
    const { credential, value } = await returnCredential(api, provider, name)
    // the version taken back: a newer one later (a refresh that landed after the hand-back) is flagged by `creds list` and `status`
    await rememberReturn(`${provider}/${name}`, credential.version)
    const file = provider === "claude" ? "credentials.json" : "auth.json"
    if (!local) {
      results.push({ name, written: false, why: "no such slot here; the value is not written anywhere" })
      continue
    }
    // the broker let go of it, whatever happens to the value below: kyora-switch's again
    await clearCloudOwned(provider, name)
    const here = slotCredential(local).fingerprint
    const uploaded = await uploadedFingerprint(`${provider}/${name}`)
    if (credential.kind !== "oauth" || value === local.files[file]) {
      await forgetUpload(`${provider}/${name}`)
      results.push({ name, written: false, why: "the slot already holds it" })
    } else if (uploaded && here !== uploaded && !force) {
      failed = true
      results.push({ name, written: false, why: "the local login changed while in use by kyora cloud; log in again, or use --force to keep the cloud login" })
    } else {
      await writeBackSlot(provider, name, file, value)
      await forgetUpload(`${provider}/${name}`)
      results.push({ name, written: true, why: "the slot holds the latest cloud login" })
    }
  }
  if (asJson) printJson({ returned: results })
  else for (const result of results) console.log(`${provider}/${result.name}: ${result.written ? "returned" : "returned to you, not written"} (${result.why})`)
  return failed ? FAILED : 0
}

export async function credsRemove(api: VmsClient, provider: SlotProvider, names: string[]): Promise<number> {
  for (const name of names) {
    await deleteCredential(api, provider, name)
    await forgetUpload(`${provider}/${name}`)
    if (SLOT_NAME.test(name)) await clearCloudOwned(provider, name)
    console.log(`deleted ${provider}/${name} from kyora cloud`)
  }
  return 0
}

/**
 * `kyora session guard`, a Claude Code SessionStart hook: resuming a conversation here that a
 * cloud session is driving prints a warning (its JSON `systemMessage`), and tells the model.
 * Never fails a session start.
 */
export async function guard(): Promise<number> {
  let input: { session_id?: unknown; source?: unknown } = {}
  try {
    input = JSON.parse(await Bun.stdin.text())
  } catch {}
  const id = typeof input.session_id === "string" ? input.session_id : null
  if (!id) return 0
  const state = await drivenFromCloud(id).catch(() => null)
  if (!state) return 0
  const warning = `kyora: this conversation is being driven in the cloud (session ${state.name}, ${state.sandbox}). Changes made here and there will diverge; \`kyora session pull ${state.name}\` keeps both.`
  console.log(JSON.stringify({ systemMessage: warning, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: warning } }))
  return 0
}
