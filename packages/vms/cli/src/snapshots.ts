import { timeoutGraceMs } from "./exec"
import { Interrupt } from "./interrupt"
import { resolveTarget } from "./names"
import { note, printJson, queueNotes, regionNote } from "./output"
import { destroyQuietly } from "./run"
import { describe, printTable } from "./session"
import { formatBytes, formatMs, parseSeconds, relativeTime } from "./units"
import type { CreateSpec, Snapshot, VmsClient } from "./api"

export interface SnapshotCommandArgs {
  verb: string
  positionals: string[]
  json: boolean
  full?: boolean
  name?: string
  ttl?: string
  noWait?: boolean
  noResume?: boolean
  spec?: CreateSpec
  wait?: number
  given: string[]
}

const SUBCOMMANDS = ["create", "ls", "list", "show", "rm", "delete", "restore"]
const CREATE_GIVEN = new Set(["full", "name", "ttl", "no-wait"])
const RESTORE_GIVEN = new Set(["no-share", "size", "network", "allow", "cpus", "allocated-cpus", "cpu-limit", "max-memory", "autoscale", "memory", "disk", "ttl", "idle", "display", "region", "strict", "wait", "no-wait", "name", "no-resume"])

function checkGiven(args: SnapshotCommandArgs, allowed: Set<string>, label: string, usage: (message: string) => never): void {
  for (const flag of args.given) if (flag !== "json" && !allowed.has(flag)) usage(`${label} does not take --${flag}`)
}

/** one listing per command, however many names it resolves */
function snapshotLister(api: VmsClient): () => Promise<Snapshot[]> {
  let listed: Promise<Snapshot[]> | undefined
  return () => listed ??= api.snapshots()
}

async function resolveSnapshotRef(list: () => Promise<Snapshot[]>, ref: string, usage: (message: string) => never): Promise<string> {
  if (ref.startsWith("snap_")) return ref
  const named = (await list()).filter((snapshot) => snapshot.name === ref)
  // a name used again after a failed snapshot means the one that worked
  const matches = named.length > 1 ? named.filter((snapshot) => snapshot.status === "ready") : named
  if (matches.length === 1) return matches[0]!.id
  if (named.length === 0) usage(`no snapshot named ${ref}`)
  return usage(`more than one snapshot named ${ref}: ${named.map((snapshot) => snapshot.id).join(", ")}`)
}

async function createSnapshot(api: VmsClient, args: SnapshotCommandArgs, target: string | undefined, usage: (message: string) => never): Promise<number> {
  checkGiven(args, CREATE_GIVEN, "snapshot", usage)
  if (!target) usage("usage: kyora vms snapshot <sandbox> [--full] [--name NAME] [--ttl 7d] [--no-wait] [--json]")
  let ttlDays: number | undefined
  if (args.ttl !== undefined) {
    let seconds: number
    try { seconds = parseSeconds(args.ttl, "--ttl") } catch (error) { usage(error instanceof Error ? error.message : String(error)) }
    if (seconds % 86_400 !== 0 || seconds < 86_400) usage("--ttl for a snapshot must be a whole number of days, e.g. 7d")
    ttlDays = seconds / 86_400
  }
  const sandbox = await resolveTarget(api, target)
  const interrupt = new Interrupt()
  let seen: Snapshot | undefined
  try {
    const snapshot = await api.snapshot(sandbox, {
      ...(args.full ? { kind: "full" as const } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(ttlDays !== undefined ? { ttlDays } : {}),
      wait: !args.noWait,
      signal: interrupt.signal,
      onProgress: (current) => { seen = current },
    })
    seen = snapshot
    if (interrupt.interrupted) {
      note(`stopped waiting; snapshot ${snapshot.id} continues server side (kyora vms snapshot show ${snapshot.id})`)
      return interrupt.code!
    }
    if (args.json) printJson(snapshot)
    else {
      console.log(snapshot.id)
      note(args.noWait ? `snapshot ${snapshot.id} is being taken (kyora vms snapshot show ${snapshot.id})` : `${snapshot.name ? `${snapshot.name} · ` : ""}${snapshot.id} · ${snapshot.kind} · ${snapshot.bytes === null ? "size unknown" : formatBytes(snapshot.bytes)} · expires ${relativeTime(snapshot.expiresAt)}`)
    }
    return 0
  } catch (error) {
    if (interrupt.interrupted) {
      note(seen ? `stopped waiting; snapshot ${seen.id} continues server side (kyora vms snapshot show ${seen.id})` : "stopped before the snapshot was asked for; nothing was taken")
      return interrupt.code!
    }
    throw error
  } finally {
    interrupt.dispose()
  }
}

async function listSnapshots(api: VmsClient, args: SnapshotCommandArgs, usage: (message: string) => never): Promise<number> {
  checkGiven(args, new Set(), "snapshot ls", usage)
  const snapshots = await api.snapshots()
  if (args.json) {
    printJson({ snapshots })
    return 0
  }
  if (snapshots.length === 0) {
    console.log("no snapshots")
    return 0
  }
  printTable([
    ["ID", "NAME", "KIND", "STATUS", "SANDBOX", "SIZE", "AGE", "EXPIRES"],
    ...snapshots.map((snapshot) => [snapshot.id, snapshot.name ?? "-", snapshot.kind, snapshot.status, snapshot.sandbox, snapshot.bytes === null ? "-" : formatBytes(snapshot.bytes), formatMs(Math.max(0, Date.now() - Date.parse(snapshot.createdAt))), relativeTime(snapshot.expiresAt)]),
  ])
  return 0
}

async function showSnapshot(api: VmsClient, args: SnapshotCommandArgs, ref: string | undefined, extra: string | undefined, usage: (message: string) => never): Promise<number> {
  checkGiven(args, new Set(), "snapshot show", usage)
  if (!ref || extra !== undefined) usage("usage: kyora vms snapshot show <snapshot> [--json]")
  const snapshot = await api.getSnapshot(await resolveSnapshotRef(snapshotLister(api), ref, usage))
  if (args.json) {
    printJson(snapshot)
    return 0
  }
  const lines: Array<[string, string]> = [
    ["id", snapshot.id],
    ["name", snapshot.name ?? "-"],
    ["kind", snapshot.kind],
    ["status", snapshot.status],
    ["sandbox", snapshot.sandbox],
    ["size", snapshot.bytes === null ? "-" : formatBytes(snapshot.bytes)],
    ["image", snapshot.image ?? "-"],
    ["resumable", String(snapshot.resumable)],
    ["created", snapshot.createdAt],
    ["ready", snapshot.readyAt ?? "-"],
    ["expires", snapshot.expiresAt],
    ...(snapshot.error ? [["error", snapshot.error] as [string, string]] : []),
  ]
  for (const [key, value] of lines) console.log(`${key}: ${value}`)
  return 0
}

async function removeSnapshots(api: VmsClient, args: SnapshotCommandArgs, refs: string[], usage: (message: string) => never): Promise<number> {
  checkGiven(args, new Set(), "snapshot rm", usage)
  if (refs.length === 0) usage("usage: kyora vms snapshot rm <snapshot>... [--json]")
  // every name resolves before anything is deleted: a bad one fails the command with nothing done
  const list = snapshotLister(api)
  const ids: string[] = []
  for (const ref of refs) ids.push(await resolveSnapshotRef(list, ref, usage))
  const deleted: string[] = []
  const missing: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of new Set(ids)) {
    try {
      if (await api.deleteSnapshot(id)) {
        deleted.push(id)
        if (!args.json) console.log(id)
      } else {
        missing.push(id)
        note(`${id}: no such snapshot`)
      }
    } catch (error) {
      // one refusal (a snapshot still being taken) doesn't stop the others, and the report says what went
      failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      note(`${id}: ${failed.at(-1)!.error}`)
    }
  }
  if (args.json) printJson({ deleted, missing, ...(failed.length ? { failed } : {}) })
  return missing.length || failed.length ? 1 : 0
}

async function restoreSnapshot(api: VmsClient, args: SnapshotCommandArgs, refs: string[], usage: (message: string) => never): Promise<number> {
  if (args.given.includes("image")) usage("restore boots the snapshot's image; --image does not go with restore")
  checkGiven(args, RESTORE_GIVEN, "restore", usage)
  const [ref, extra] = refs
  if (!ref || extra !== undefined) usage("usage: kyora vms restore <snapshot> [create options] [--no-resume] [--json]")
  const id = await resolveSnapshotRef(snapshotLister(api), ref, usage)
  const spec: CreateSpec = { ...(args.spec ?? {}), ...(args.noResume ? { resume: false } : {}) }
  const wait = args.wait ?? 0
  const interrupt = new Interrupt()
  try {
    // a restore that fails or is cut off after the create destroys its sandbox itself
    const sandbox = await api.restore(id, spec, { wait, graceMs: timeoutGraceMs(), signal: interrupt.signal, onQueued: queueNotes(wait) })
    if (interrupt.interrupted) {
      await destroyQuietly(api, sandbox.id)
      return interrupt.code!
    }
    if (args.json) printJson(sandbox)
    else {
      console.log(sandbox.id)
      // the region, never the machine it landed on
      const { node: _node, ...shown } = sandbox
      note(`${sandbox.name ? `${sandbox.name} · ` : ""}${sandbox.id} ${describe(shown)}`)
      regionNote(sandbox)
    }
    return 0
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    throw error
  } finally {
    interrupt.dispose()
  }
}

export async function snapshotCommand(api: VmsClient, args: SnapshotCommandArgs, usage: (message: string) => never): Promise<number> {
  const [first, ...rest] = args.positionals
  if (args.verb === "restore") return restoreSnapshot(api, args, args.positionals, usage)
  if (first === undefined) {
    if (args.verb === "snapshots") return listSnapshots(api, args, usage)
    return usage("usage: kyora vms snapshot <sandbox> [--full] [--name NAME] [--ttl 7d] [--no-wait] [--json], or kyora vms snapshot ls | show <snapshot> | rm <snapshot>...")
  }
  if (!SUBCOMMANDS.includes(first)) {
    if (args.verb === "snapshots") usage(`unknown snapshot command "${first}"; run \`kyora vms --help\``)
    if (rest.length) usage("usage: kyora vms snapshot <sandbox> [--full] [--name NAME] [--ttl 7d] [--no-wait] [--json]")
    return createSnapshot(api, args, first, usage)
  }
  switch (first) {
    case "create":
      if (rest.length > 1) usage("usage: kyora vms snapshot create <sandbox> [--full] [--name NAME] [--ttl 7d] [--no-wait] [--json]")
      return createSnapshot(api, args, rest[0], usage)
    case "ls":
    case "list":
      if (rest.length) usage("usage: kyora vms snapshot ls [--json]")
      return listSnapshots(api, args, usage)
    case "show":
      return showSnapshot(api, args, rest[0], rest[1], usage)
    case "rm":
    case "delete":
      return removeSnapshots(api, args, rest, usage)
    case "restore":
      return restoreSnapshot(api, args, rest, usage)
    default:
      return usage(`unknown snapshot command "${first}"`)
  }
}

