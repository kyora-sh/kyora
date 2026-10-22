import { userEgressAllow } from "@kyora-sh/hostnames"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import { NETWORKS, VmsClient, type CreateSpec, type ExecRequest } from "./api"
import { loadConfig, type Config } from "./config"
import { DeployUsage, resolveProject } from "./deploys"
import { SIZES } from "./ergonomics"
import { execDeadline, runExec, timeoutGraceMs } from "./exec"
import { lockedImage } from "./image-refs"
import type { Schema } from "./mcp"
import { resolveDestructiveTarget, resolveTarget, validName } from "./names"
import { note } from "./output"
import { listFiles } from "./pack"
import { publishPage, removePage, type PagesDeps } from "./pages"
import { repoTop } from "./sessions/git"
import { getSession } from "./sessions/platform"
import { resolveState } from "./sessions/state"
import { redact, rememberSecret } from "./redact"
import { presignRequest, StorageClient, validBucket } from "./storage"
import { top } from "./top"
import { pull, push, remotePath, WORK, type PullResult } from "./transfer"
import { diskGb, memoryMb, parseSeconds } from "./units"

/** what a tool works with: clients made from the login in use when it is called */
export interface ToolContext {
  api: VmsClient
  config: Config
  /** KYORA_STORAGE_KEY's scoped key when it is set, else the login's, as for `kyora vms storage` */
  storage: StorageClient
  pages: PagesDeps
  /** where relative local paths start */
  cwd: string
  /** aborted when the client cancels the call or goes away */
  signal: AbortSignal
  progress: (message: string) => void
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: Schema
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

/** arguments the schema let through that still make no sense: the client is told so as invalid params */
export class ToolInputError extends Error {}

export async function toolContext(signal: AbortSignal, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<ToolContext> {
  const config = await loadConfig(env, cwd)
  rememberSecret(config.key)
  rememberSecret(env.KYORA_STORAGE_KEY?.trim())
  if (!config.key) throw new Error(`not logged in to ${config.url}: run \`kyora login\` in a terminal (the next call picks it up), or set KYORA_TOKEN in the MCP server's environment`)
  const progress = (message: string) => note(message)
  const api = new VmsClient(config)
  return {
    api,
    config,
    storage: new StorageClient(config.url, env.KYORA_STORAGE_KEY?.trim() || config.key),
    pages: { api, storage: new StorageClient(config.url, config.key), progress },
    cwd,
    signal,
    progress,
  }
}

const string = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "string", description, ...extra })
const integer = (description: string, minimum: number, maximum: number, extra: Partial<Schema> = {}): Schema => ({ type: "integer", description, minimum, maximum, ...extra })
const boolean = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "boolean", description, ...extra })
const strings = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "array", description, items: { type: "string" }, ...extra })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false })

const SANDBOX = string("the sandbox: its name, id, or a unique id prefix", { minLength: 1 })
const READ = { readOnlyHint: true, openWorldHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const

const SPEC: Record<string, Schema> = {
  name: string("a name for the VM: 1-32 characters of a-z, 0-9 and - (default: a friendly random name)"),
  image: string("the guest image, e.g. desktop or one of your images (name, name@N); default: the machine's"),
  size: string("CPU/RAM preset: s 2/4G, m 4/8G, l 8/16G, xl 16/32G", { enum: Object.keys(SIZES) }),
  cpus: integer("vCPUs (default 4)", 1, 64),
  memory: string("RAM, e.g. 8G or 512M (default 8G)"),
  disk: string("scratch disk behind /work, e.g. 60G (default 30G)"),
  network: string("none (default): no network; registries: package registries only (npm, crates.io, PyPI, GitHub); open: the internet, if your account allows it", { enum: [...NETWORKS] }),
  allow: strings("extra HTTPS hostnames (or *.suffix) to allow with network none or registries", { maxItems: 32 }),
  region: string("the region to run in and only there, e.g. eu, us, apac; global or unset: the nearest with room"),
  ttl: string("total lifetime, e.g. 2h, or none (default: the server's)"),
  idle: string("idle timeout, e.g. 30m, or none"),
  no_share: boolean("never allow view shares of this VM"),
  wait_seconds: integer("how long to wait in line when no machine has room (default 300)", 0, 900),
}

const COMMAND: Record<string, Schema> = {
  command: string("the shell command, run with sh -c", { minLength: 1 }),
  cwd: string("working directory in the VM, relative to /work (default /work)"),
  env: { type: "object", description: "environment variables for the command", additionalProperties: { type: "string" } },
  stdin: string("text sent to the command's stdin"),
  timeout_seconds: integer("kill the command after this long; exit code 124 then (default 600)", 1, 86_400),
  output_limit: integer("bytes kept from the end of each of stdout and stderr (default 20000)", 1_000, 1_000_000),
}

const input = <T>(compute: () => T): T => {
  try {
    return compute()
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : String(error))
  }
}

const local = (context: ToolContext, path: string) => resolve(context.cwd, path)

/** the bucket argument, checked: it goes into the request's path */
function bucketOf(args: Record<string, unknown>): string {
  const bucket = args.bucket as string
  if (!validBucket(bucket)) throw new ToolInputError("a bucket's name is 3-63 characters of a-z, 0-9 and -")
  return bucket
}
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

function specOf(args: Record<string, unknown>, context: ToolContext): CreateSpec {
  return input(() => {
    const spec: CreateSpec = {}
    if (args.name !== undefined) spec.name = validName(args.name as string)
    if (args.size !== undefined) Object.assign(spec, SIZES[args.size as string])
    if (args.cpus !== undefined) spec.vcpus = args.cpus as number
    if (args.memory !== undefined) spec.memoryMb = memoryMb(args.memory as string)
    if (args.disk !== undefined) spec.diskGb = diskGb(args.disk as string)
    if (args.network !== undefined) spec.network = args.network as CreateSpec["network"]
    if (args.allow !== undefined) {
      if (args.network === "open") throw new Error("allow goes with network none or registries")
      spec.egressAllow = userEgressAllow(args.allow, true)
    }
    if (args.region !== undefined) spec.region = args.region as string
    if (args.ttl !== undefined) spec.ttlSeconds = args.ttl === "none" ? 0 : parseSeconds(args.ttl as string, "ttl")
    if (args.idle !== undefined) spec.idleSeconds = args.idle === "none" ? 0 : parseSeconds(args.idle as string, "idle")
    if (args.image !== undefined) spec.image = lockedImage(args.image as string, context.cwd, context.progress)
    if (args.no_share) spec.shareable = false
    return spec
  })
}

function execOf(args: Record<string, unknown>): ExecRequest {
  return input(() => ({
    cmd: ["sh", "-c", args.command as string],
    cwd: args.cwd === undefined ? WORK : remotePath(args.cwd as string),
    timeoutSeconds: (args.timeout_seconds as number | undefined) ?? 600,
    ...(args.env ? { env: args.env as Record<string, string> } : {}),
    ...(args.stdin !== undefined ? { stdin: args.stdin as string } : {}),
  }))
}

/** bytes kept in front of a tail, so a credential cut at its start is still recognised and redacted whole */
const OVERLAP = 512

/** a character cut at the start of `bytes` is dropped, not shown broken */
function decodeTail(bytes: Uint8Array): string {
  let start = 0
  while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start++
  return new TextDecoder().decode(bytes.subarray(start))
}

/** the last `limit` bytes of a stream, redacted, and how many it had in all */
export class Tail {
  private chunks: Buffer[] = []
  private kept = 0
  total = 0

  constructor(private readonly limit: number, private readonly clean: (text: string) => string = (text) => redact(text)) {}

  push(data: Uint8Array | string): void {
    const chunk = Buffer.from(data)
    this.total += chunk.length
    this.chunks.push(chunk)
    this.kept += chunk.length
    if (this.kept > (this.limit + OVERLAP) * 2) {
      const joined = Buffer.concat(this.chunks).subarray(-(this.limit + OVERLAP))
      this.chunks = [joined]
      this.kept = joined.length
    }
  }

  get truncated(): boolean {
    return this.total > this.limit
  }

  text(): string {
    const all = Buffer.concat(this.chunks)
    // redacted with the overlap still in front, then cut to the limit
    const clean = Buffer.from(this.clean(this.total > all.length ? decodeTail(all) : new TextDecoder().decode(all)))
    return clean.length > this.limit ? decodeTail(clean.subarray(-this.limit)) : clean.toString()
  }
}

/** how long an upload or a download of a VM call may take before it is given up on */
const TRANSFER_MS = 30 * 60_000
const transfer = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_MS)])
/** a storage request that moves no file */
const STORAGE_MS = 2 * 60_000
const quick = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(STORAGE_MS)])

/** creates sent and not answered yet: their VMs are destroyed once they come, so shutdown waits for them */
let creating = 0
export const createsInFlight = (): number => creating

/** a create that counts as in flight until it is answered */
async function createVm(api: VmsClient, spec: CreateSpec, args: Record<string, unknown>, signal: AbortSignal) {
  creating++
  try {
    return await api.create(spec, { wait: (args.wait_seconds as number | undefined) ?? 300, graceMs: timeoutGraceMs(), signal })
  } finally {
    creating--
  }
}

/** a command run to its end (or its timeout), with what it printed kept to a tail of each stream */
async function execute(api: VmsClient, id: string, request: ExecRequest, args: Record<string, unknown>, signal: AbortSignal) {
  const limit = (args.output_limit as number | undefined) ?? 20_000
  const out = { stdout: new Tail(limit), stderr: new Tail(limit) }
  const started = Date.now()
  const outcome = await runExec(api, id, request, { json: false, signal, deadline: execDeadline(request), output: (stream, data) => out[stream].push(data) })
  return {
    exit_code: outcome.code,
    ...(outcome.code === 124 ? { timed_out: true } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    duration_ms: Date.now() - started,
    stdout: out.stdout.text(),
    stderr: out.stderr.text(),
    stdout_bytes: out.stdout.total,
    stderr_bytes: out.stderr.total,
    ...(out.stdout.truncated || out.stderr.truncated ? { truncated: { stdout: out.stdout.truncated, stderr: out.stderr.truncated } } : {}),
  }
}

const sample = (paths: string[], limit = 20) => (paths.length > limit ? [...paths.slice(0, limit), `… and ${paths.length - limit} more`] : paths)

function pulled(result: PullResult) {
  return {
    path: result.path,
    to: result.to,
    entries: result.entries,
    bytes: result.received,
    written: sample(result.written),
    ...(result.refused.length ? { refused: sample(result.refused) } : {}),
    ...(result.failed.length ? { failed: sample(result.failed) } : {}),
  }
}

async function pullAll(api: VmsClient, id: string, paths: string[], to: string, cancel: AbortSignal) {
  const signal = transfer(cancel)
  const results: unknown[] = []
  for (const path of paths) {
    try {
      results.push(pulled(await pull(api, id, path, to, signal)))
    } catch (error) {
      if (signal.aborted) throw error
      results.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

const ports = (sandbox?: string) => (sandbox ? `/v1/sandboxes/${encodeURIComponent(sandbox)}/ports` : "/v1/ports")

async function project(args: Record<string, unknown>, context: ToolContext): Promise<string> {
  try {
    return await resolveProject(text(args.project), context.cwd)
  } catch (error) {
    if (error instanceof DeployUsage) throw new Error(`${error.message.split(/[;\n]/)[0]}; pass project (projects_list names them), or run \`kyora link\` in the checkout`)
    throw error
  }
}

/** `kyora top --once --json`, read from a terminal of its own */
async function usageTop(api: VmsClient, region: string | undefined, waitSeconds: number, signal: AbortSignal): Promise<unknown> {
  let printed = ""
  const input = Object.assign(new EventEmitter(), { isTTY: false, isRaw: false, isPaused: () => true, setRawMode: () => {}, resume: () => {}, pause: () => {} })
  const output = Object.assign(new EventEmitter(), { isTTY: false, columns: 160, rows: 50, write: (chunk: string) => ((printed += chunk), true) })
  const signals = new EventEmitter()
  const stop = () => signals.emit("SIGTERM")
  signal.addEventListener("abort", stop, { once: true })
  try {
    await top(api, { interval: 2, region, once: true, json: true, onceWaitSeconds: waitSeconds }, { input, output, signals } as unknown as Parameters<typeof top>[2])
  } finally {
    signal.removeEventListener("abort", stop)
  }
  signal.throwIfAborted()
  return { vms: printed.trim() ? JSON.parse(printed) : [] }
}

export function kyoraTools(): Tool[] {
  return [
    {
      name: "whoami",
      title: "Who am I",
      description: "The kyora account the server acts as (a user or an org), the server URL, and where the login comes from. Never the token itself.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api, config }) => {
        const me = await api.me()
        return { login: me.login, kind: me.kind ?? "user", ...(me.actor ? { actor: me.actor } : {}), ...(me.role ? { role: me.role } : {}), url: config.url, org: config.org ?? null, source: config.keySource, ...(me.token ? { token: { name: me.token.name, scopes: me.token.scopes, expiresAt: me.token.expiresAt } } : {}) }
      },
    },
    {
      name: "vms_list",
      title: "List VMs",
      description: "Your running VMs (sandboxes): id, name, status, size, network, region, expiry.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api }) => ({ sandboxes: await api.list() }),
    },
    {
      name: "vms_create",
      title: "Create a VM",
      description: "Start a VM and return it (its id and name). It keeps running until its ttl or idle timeout, or vms_destroy: destroy it when done. Use vms_push, vms_exec and vms_pull with it.",
      inputSchema: object(SPEC),
      annotations: WRITE,
      handler: async (args, context) => {
        const spec = specOf(args, context)
        context.signal.throwIfAborted()
        const sandbox = await createVm(context.api, spec, args, context.signal)
        // the create itself is not cut short (its sandbox would be lost): one that arrives after a cancel is destroyed
        if (context.signal.aborted) {
          await context.api.destroy(sandbox.id).catch((error) => context.progress(`could not destroy ${sandbox.id}: ${error instanceof Error ? error.message : String(error)}`))
          context.signal.throwIfAborted()
        }
        return sandbox
      },
    },
    {
      name: "vms_exec",
      title: "Run a command in a VM",
      description: "Run a shell command in an existing VM and wait for it: returns the exit code (124 on timeout, 125 when kyora itself failed) and the last output_limit bytes of stdout and stderr.",
      inputSchema: object({ sandbox: SANDBOX, ...COMMAND }, ["sandbox", "command"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, { api, signal }) => {
        const request = execOf(args)
        const id = await resolveTarget(api, args.sandbox as string)
        signal.throwIfAborted()
        return { sandbox: id, ...(await execute(api, id, request, args, signal)) }
      },
    },
    {
      name: "vms_run",
      title: "Run a command in a fresh VM",
      description: "The one-call path: upload a local directory (in a git repo: tracked files plus untracked ones not ignored) to /work of a fresh VM, run a shell command there, pull the `out` paths back into `to`, and destroy the VM (unless keep). Returns the exit code and output tails. Network is none unless you ask for registries or open.",
      inputSchema: object({
        dir: string("the local directory to upload (default: the server's working directory)"),
        git: boolean("false: upload every file, ignoring .gitignore (default true)"),
        out: strings("paths in the VM, relative to /work, to download afterwards whatever the exit code"),
        to: string("local directory the out paths land in, laid out as under /work (default: dir)"),
        keep: boolean("keep the VM afterwards and return its id (default false: destroyed)"),
        ...COMMAND,
        ...SPEC,
      }, ["command"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        const { api, signal } = context
        const dir = local(context, text(args.dir) ?? ".")
        const spec = specOf(args, context)
        const request = execOf(args)
        const outs = input(() => ((args.out as string[] | undefined) ?? []).map((path) => remotePath(path)))
        const listing = await listFiles(dir, { git: args.git !== false })
        signal.throwIfAborted()
        let id: string | null = null
        let kept = false
        let destroying: Promise<unknown> | null = null
        const destroy = () => (destroying ??= api.destroy(id!).catch((error) => context.progress(`could not destroy ${id}: ${error instanceof Error ? error.message : String(error)}`)))
        // a cancel destroys the VM at once, not after the transfer in flight has cleaned up after itself
        const onCancel = () => void (id && destroy())
        signal.addEventListener("abort", onCancel, { once: true })
        try {
          const sandbox = await createVm(api, spec, args, signal)
          id = sandbox.id
          if (signal.aborted) onCancel()
          const pushed = await push(api, id, listing, WORK, { signal: transfer(signal) })
          const result = await execute(api, id, request, args, signal)
          const downloads = outs.length ? await pullAll(api, id, outs, local(context, text(args.to) ?? dir), signal) : undefined
          kept = Boolean(args.keep)
          return { sandbox: { id, name: sandbox.name, region: sandbox.region }, kept, upload: { entries: pushed.server.entries ?? listing.entries.length, bytes: pushed.sent }, ...result, ...(downloads ? { downloads } : {}) }
        } finally {
          signal.removeEventListener("abort", onCancel)
          if (id && !kept) await destroy()
        }
      },
    },
    {
      name: "vms_push",
      title: "Upload a directory to a VM",
      description: "Upload a local directory into a VM (git-aware like vms_run), to dest (default /work).",
      inputSchema: object({ sandbox: SANDBOX, dir: string("the local directory (default: the server's working directory)"), dest: string("where in the VM, under /work or /tmp (default /work)"), git: boolean("false: upload every file, ignoring .gitignore (default true)") }, ["sandbox"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        const dest = input(() => remotePath(text(args.dest) ?? WORK))
        const id = await resolveTarget(context.api, args.sandbox as string)
        context.signal.throwIfAborted()
        const result = await push(context.api, id, { dir: local(context, text(args.dir) ?? "."), git: args.git !== false }, dest, { signal: transfer(context.signal) })
        return { sandbox: id, dest, entries: result.server.entries ?? result.listing.entries.length, bytes: result.sent, raw_bytes: result.listing.bytes, duration_ms: result.durationMs, ...(result.warnings.length ? { warnings: sample(result.warnings) } : {}) }
      },
    },
    {
      name: "vms_pull",
      title: "Download files from a VM",
      description: "Download paths from a VM (files or directories, relative to /work) into a local directory, laid out as under /work.",
      inputSchema: object({ sandbox: SANDBOX, paths: strings("paths in the VM, relative to /work (or absolute under /work or /tmp)", { minItems: 1 }), to: string("the local directory (default: the server's working directory); files there are overwritten") }, ["sandbox", "paths"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        const paths = input(() => (args.paths as string[]).map((path) => remotePath(path)))
        const id = await resolveTarget(context.api, args.sandbox as string)
        context.signal.throwIfAborted()
        return { sandbox: id, downloads: await pullAll(context.api, id, paths, local(context, text(args.to) ?? "."), context.signal) }
      },
    },
    {
      name: "vms_destroy",
      title: "Destroy VMs",
      description: "Destroy VMs by name or id. Everything in them is gone.",
      inputSchema: object({ sandboxes: strings("names or ids (an id prefix must be unique)", { minItems: 1 }) }, ["sandboxes"]),
      annotations: DESTROY,
      handler: async (args, { api, signal }) => {
        const removed: string[] = []
        const gone: string[] = []
        for (const target of args.sandboxes as string[]) {
          signal.throwIfAborted()
          const id = await resolveDestructiveTarget(api, target)
          signal.throwIfAborted()
          if (await api.destroy(id)) removed.push(id)
          else gone.push(id)
        }
        return { removed, gone }
      },
    },
    {
      name: "vms_rename",
      title: "Rename a VM",
      description: "Give a VM another name.",
      inputSchema: object({ sandbox: SANDBOX, name: string("1-32 characters of a-z, 0-9 and -") }, ["sandbox", "name"]),
      annotations: { ...WRITE, idempotentHint: true },
      handler: async (args, { api, signal }) => {
        const name = input(() => validName(args.name as string))
        const id = await resolveTarget(api, args.sandbox as string)
        signal.throwIfAborted()
        return api.update(id, { name })
      },
    },
    {
      name: "vms_ttl",
      title: "Set a VM's lifetime",
      description: "Set a VM's total lifetime, counted from its creation (not from now): e.g. 4h, or none.",
      inputSchema: object({ sandbox: SANDBOX, ttl: string("e.g. 4h or 90m, or none") }, ["sandbox", "ttl"]),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      handler: async (args, { api, signal }) => {
        const ttlSeconds = input(() => (args.ttl === "none" ? 0 : parseSeconds(args.ttl as string, "ttl")))
        const id = await resolveTarget(api, args.sandbox as string)
        signal.throwIfAborted()
        return api.update(id, { ttlSeconds })
      },
    },
    {
      name: "images_list",
      title: "List images",
      description: "The guest images the fleet has (where each is available) and your account's own images.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api }) => (await api.images()).json(),
    },
    {
      name: "regions_list",
      title: "List regions",
      description: "kyora cloud's regions, what is free in each, and where a create with no region goes.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api }) => api.regions(),
    },
    {
      name: "usage_top",
      title: "Live VM usage",
      description: "CPU, memory, disk and network of your running VMs, as `kyora top --once --json` shows them (waits for fresh samples, up to wait_seconds).",
      inputSchema: object({ region: string("only VMs in this region"), wait_seconds: integer("how long to wait for fresh samples (default 20)", 2, 60) }),
      annotations: READ,
      handler: async (args, { api, signal }) => usageTop(api, text(args.region), (args.wait_seconds as number | undefined) ?? 20, signal),
    },
    {
      name: "session_status",
      title: "kyora session status",
      description: "Where a `kyora detach` session runs: its sandbox, branch, driver and kyora cloud's view of it (checkpoints, state). Detaching and bringing a session back move the calling agent's own conversation, so they are run from a terminal (`kyora detach`, `kyora back`), not as tools.",
      inputSchema: object({ name: string("the session's name (default: this repo's only one)") }),
      annotations: READ,
      handler: async (args, context) => {
        const repo = await repoTop(context.cwd).catch(() => null)
        const state = await resolveState(text(args.name), repo)
        const cloud = state.id.startsWith("ses_") ? await getSession(context.api, state.id).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) : null
        const { name, id, repo: where, agent, sandbox, driver, base, upstream, createdAt, pulledAt, stoppedAt } = state
        return { session: { name, id, repo: where, branch: `kyora/${name}`, agent, sandbox, driver, base, upstream, createdAt, pulledAt, stoppedAt }, cloud }
      },
    },
    {
      name: "projects_list",
      title: "List deploy projects",
      description: "Your deploy projects (a GitHub repo deployed by kyora): id, name, repo, URL.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api }) => api.projects(),
    },
    {
      name: "deploy",
      title: "Deploy to production",
      description: "Start a production deployment of a project (default: the one `kyora link` linked this checkout to) at its production branch, a ref or a commit. Returns the deployment; deployment_logs follows it.",
      inputSchema: object({ project: string("project name or id"), ref: string("a branch or tag"), sha: string("a full 40-character commit SHA") }),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        if (args.ref !== undefined && args.sha !== undefined) throw new ToolInputError("give ref or sha, not both")
        if (args.sha !== undefined && !/^[a-f0-9]{40}$/.test(args.sha as string)) throw new ToolInputError("sha must be a full commit SHA")
        const name = await project(args, context)
        context.signal.throwIfAborted()
        return context.api.deploymentCreate(name, { environment: "production", ...(args.ref ? { ref: args.ref as string } : {}), ...(args.sha ? { sha: args.sha as string } : {}) })
      },
    },
    {
      name: "deployments_list",
      title: "List deployments",
      description: "A project's deployments, newest first, with their state.",
      inputSchema: object({ project: string("project name or id (default: this checkout's)") }),
      annotations: READ,
      handler: async (args, context) => context.api.deployments(await project(args, context)),
    },
    {
      name: "deployment_logs",
      title: "Deployment logs",
      description: "The build and start logs of a deployment (default: the project's newest), with its state; the last limit_bytes of them.",
      inputSchema: object({ project: string("project name or id (default: this checkout's)"), deployment: string("the deployment id, dpl_…"), limit_bytes: integer("bytes kept from the end of the logs (default 20000)", 1_000, 1_000_000) }),
      annotations: READ,
      handler: async (args, context) => {
        const name = await project(args, context)
        const id = text(args.deployment) ?? (await context.api.deployments(name)).deployments[0]?.id
        if (!id) throw new Error("this project has no deployments")
        const tail = new Tail((args.limit_bytes as number | undefined) ?? 20_000)
        const reader = (await context.api.deploymentLogs(name, id)).body?.getReader()
        if (reader) for (let part = await reader.read(); !part.done; part = await reader.read()) tail.push(part.value)
        const detail = await context.api.deployment(name, id)
        return { deployment: detail, logs: tail.text(), ...(tail.truncated ? { truncated: true } : {}) }
      },
    },
    {
      name: "domains_add",
      title: "Add a custom domain",
      description: "Serve one of your public URL names (to) or public pages (page) on a hostname of yours. Returns the DNS records to add (an ownership TXT and a CNAME); domains_status says when it is live.",
      inputSchema: object({ hostname: string("e.g. app.example.com"), to: string("the public URL name (of an exposed port) to serve there"), page: string("the public page to serve there, instead of to"), dcv: string("certificate validation: http (default) or txt", { enum: ["http", "txt"] }) }, ["hostname"]),
      annotations: WRITE,
      handler: async (args, { api }) => {
        if ((args.to === undefined) === (args.page === undefined)) throw new ToolInputError("give to (a public URL name) or page (a public page), one of them")
        return api.domainAdd(args.hostname as string, args.page !== undefined ? { page: args.page as string } : (args.to as string), args.dcv as "http" | "txt" | undefined)
      },
    },
    {
      name: "domains_list",
      title: "List custom domains",
      description: "Your custom domains, what each serves and its status.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { api }) => ({ domains: await api.domains() }),
    },
    {
      name: "domains_status",
      title: "Custom domain status",
      description: "One custom domain's status now: whether it serves, and the DNS records still missing.",
      inputSchema: object({ hostname: string("the hostname") }, ["hostname"]),
      annotations: READ,
      handler: async (args, { api }) => api.domain(args.hostname as string),
    },
    {
      name: "domains_remove",
      title: "Remove a custom domain",
      description: "Stop serving a custom domain and remove it from your account.",
      inputSchema: object({ hostname: string("the hostname") }, ["hostname"]),
      annotations: DESTROY,
      handler: async (args, { api }) => {
        await api.domainRemove(args.hostname as string)
        return { removed: true, hostname: args.hostname }
      },
    },
    {
      name: "expose",
      title: "Expose a VM's port",
      description: "A URL for a port a VM listens on. Private (only you, signed in) unless public; returns the URL.",
      inputSchema: object({ sandbox: SANDBOX, port: integer("the port in the VM", 1, 65_535), name: string("the URL's name (default: generated)"), public: boolean("anyone with the URL can open it"), trusted: boolean("pass the visitor's kyora identity headers through") }, ["sandbox", "port"]),
      annotations: WRITE,
      handler: async (args, { api, signal }) => {
        const id = await resolveTarget(api, args.sandbox as string)
        signal.throwIfAborted()
        return api.call("expose port", "POST", ports(id), { json: { port: args.port, ...(args.name ? { name: args.name } : {}), ...(args.public ? { public: true } : {}), ...(args.trusted ? { trusted: true } : {}) } })
      },
    },
    {
      name: "ports_list",
      title: "List exposed ports",
      description: "Your public URL names: one VM's exposed ports, or all names you hold.",
      inputSchema: object({ sandbox: string("only this VM's ports") }),
      annotations: READ,
      handler: async (args, { api }) => api.call("list exposed ports", "GET", ports(args.sandbox === undefined ? undefined : await resolveTarget(api, args.sandbox as string))),
    },
    {
      name: "unexpose",
      title: "Release a public URL name",
      description: "Release a public URL name (it then has a 30-day cooldown for other accounts).",
      inputSchema: object({ label: string("the URL's name"), sandbox: string("the VM it belongs to (optional)") }, ["label"]),
      annotations: DESTROY,
      handler: async (args, { api, signal }) => {
        const label = encodeURIComponent(args.label as string)
        const path = args.sandbox === undefined ? `/v1/ports/${label}` : `${ports(await resolveTarget(api, args.sandbox as string))}/${label}`
        signal.throwIfAborted()
        await api.call("unexpose port", "DELETE", path, { accept: [204] })
        return { released: true, label: args.label }
      },
    },
    {
      name: "storage_buckets",
      title: "List storage buckets",
      description: "Your private object storage buckets.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { storage, signal }) => (await storage.call("GET", "/v1/storage/buckets", { signal: quick(signal) })).json(),
    },
    {
      name: "storage_ls",
      title: "List objects",
      description: "The objects in a bucket, under a prefix.",
      inputSchema: object({ bucket: string("the bucket"), prefix: string("only keys starting with this"), limit: integer("at most this many (default 1000)", 1, 10_000), delimiter: boolean("group keys by / into prefixes, like directories") }, ["bucket"]),
      annotations: READ,
      handler: async (args, { storage, signal }) => storage.list(bucketOf(args), text(args.prefix) ?? "", (args.limit as number | undefined) ?? 1000, Boolean(args.delimiter), quick(signal)),
    },
    {
      name: "storage_put",
      title: "Upload an object",
      description: "Upload a local file, or the given text, to a bucket under key.",
      inputSchema: object({ bucket: string("the bucket"), key: string("the object's key"), file: string("a local file to upload"), content: string("text to upload instead of a file"), content_type: string("its content type (default: from the file's extension)") }, ["bucket", "key"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        if ((args.file === undefined) === (args.content === undefined)) throw new ToolInputError("give file or content, one of them")
        const file = args.file === undefined ? null : Bun.file(local(context, args.file as string))
        if (file && !(await file.exists())) throw new ToolInputError(`no such file: ${args.file}`)
        const type = text(args.content_type) ?? (file ? file.type.split(";")[0] || null : "text/plain; charset=utf-8")
        return context.storage.put(bucketOf(args), args.key as string, file ?? new Blob([args.content as string]), type, transfer(context.signal))
      },
    },
    {
      name: "storage_get",
      title: "Download an object",
      description: "Download an object to a local file (overwriting it), or without file return it as text when it is UTF-8 and at most max_bytes.",
      inputSchema: object({ bucket: string("the bucket"), key: string("the object's key"), file: string("save it to this local path, overwriting what is there"), max_bytes: integer("the most returned as text (default 100000)", 1, 1_000_000) }, ["bucket", "key"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => {
        const response = await context.storage.call("GET", context.storage.object(bucketOf(args), args.key as string), { signal: transfer(context.signal) })
        if (args.file !== undefined) {
          const path = local(context, args.file as string)
          return { key: args.key, file: path, size: await Bun.write(path, response) }
        }
        const limit = (args.max_bytes as number | undefined) ?? 100_000
        const over = () => new Error(`${args.key} is over max_bytes (${limit}); pass file to save it`)
        if (Number(response.headers.get("content-length") ?? 0) > limit) {
          await response.body?.cancel().catch(() => {})
          throw over()
        }
        const parts: Uint8Array[] = []
        let size = 0
        const reader = response.body?.getReader()
        if (reader) for (let part = await reader.read(); !part.done; part = await reader.read()) {
          size += part.value.length
          if (size > limit) {
            await reader.cancel().catch(() => {})
            throw over()
          }
          parts.push(part.value)
        }
        const bytes = Buffer.concat(parts)
        try {
          return { key: args.key, size: bytes.length, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
        } catch {
          throw new Error(`${args.key} is not text; pass file to save it`)
        }
      },
    },
    {
      name: "storage_rm",
      title: "Delete an object",
      description: "Delete an object from a bucket.",
      inputSchema: object({ bucket: string("the bucket"), key: string("the object's key") }, ["bucket", "key"]),
      annotations: DESTROY,
      handler: async (args, { storage, signal }) => {
        await storage.call("DELETE", storage.object(bucketOf(args), args.key as string), { signal: quick(signal) })
        return { key: args.key, deleted: true }
      },
    },
    {
      name: "storage_presign",
      title: "Presign an object URL",
      description: "A URL for one object, valid for ttl_seconds (at most 900): a download, or with put an upload.",
      inputSchema: object({ bucket: string("the bucket"), key: string("the object's key"), put: boolean("a URL to upload with PUT"), ttl_seconds: integer("how long it is valid (default 300)", 1, 900), length: integer("put: the exact length to sign", 0, 5_000_000_000), inline: boolean("a download shown in the browser (media) instead of saved") }, ["bucket", "key"]),
      annotations: READ,
      handler: async (args, { storage, signal }) => (await storage.call("POST", `/v1/storage/buckets/${bucketOf(args)}/presign`, { json: presignRequest(args.key as string, { put: Boolean(args.put), ttl: (args.ttl_seconds as number | undefined) ?? null, length: (args.length as number | undefined) ?? null, inline: Boolean(args.inline) }), signal: quick(signal) })).json(),
    },
    {
      name: "publish",
      title: "Publish a page",
      description: "Publish a local directory or file (an HTML report, a built app, screenshots) as a static page, and return its URL. Private (only the account's people, signed in, can open it) unless public. Publishing again with the same name replaces it at once. A single file gets an index.html that redirects to it.",
      inputSchema: object({ path: string("the local directory or file", { minLength: 1 }), name: string("the page's name, the first label of its URL (default: made from the directory's name); yours to reuse"), public: boolean("anyone with the URL can open it (default false)"), spa: boolean("serve index.html for paths with no file (single-page apps)"), bucket: string("the storage bucket the files go to (default pages)") }, ["path"]),
      annotations: { ...WRITE, destructiveHint: true },
      handler: async (args, context) => publishPage(context.pages, { source: local(context, args.path as string), name: text(args.name), public: Boolean(args.public), spa: Boolean(args.spa), bucket: text(args.bucket), signal: transfer(context.signal) }),
    },
    {
      name: "pages_list",
      title: "List pages",
      description: "Your published pages: name, URL, private or public, and where their files are.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (_args, { pages }) => ({ pages: await pages.api.pages() }),
    },
    {
      name: "pages_delete",
      title: "Delete a page",
      description: "Unpublish a page: its name is released and its files deleted (unless keep_files).",
      inputSchema: object({ name: string("the page's name"), keep_files: boolean("leave its files in the bucket") }, ["name"]),
      annotations: DESTROY,
      handler: async (args, { pages, signal }) => removePage(pages, args.name as string, Boolean(args.keep_files), signal),
    },
    {
      name: "pages_login_url",
      title: "Sign-in link for a private page",
      description: "A link, valid for 60 seconds, that signs a browser in to a private page. Give it to the user to open.",
      inputSchema: object({ name: string("the page's name") }, ["name"]),
      annotations: { ...WRITE, idempotentHint: false },
      handler: async (args, { pages }) => ({ loginUrl: await pages.api.pageLogin(args.name as string), expiresInSeconds: 60 }),
    },
  ]
}
