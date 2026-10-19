import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import {
  type AgentAdapter,
  AgentError,
  type ConfigOptions,
  exists,
  type LaunchOptions,
  type LaunchPlan,
  type LocalSession,
  mapJsonl,
  moveField,
  type PreparedConfig,
  SESSION_ID,
  sessionRoot,
  type StagedFile,
  walk,
} from "./agents"
import { claudeProjectName, type PathMap, REMOTE_HOME, toLocal, toRemote, within } from "./paths"

/** a VM path back on the laptop, when it is inside the repo */
const rebaseRemote = (path: string, map: PathMap): string | null => {
  const local = toLocal(map, path)
  return within(map.local, local) ? local : null
}

/**
 * Claude Code, as 2.1.287 lays out its files (read out of the binary, and the same on Linux):
 *
 * - `$CLAUDE_CONFIG_DIR` (default `~/.claude`) holds `projects/<encoded cwd>/<session id>.jsonl`,
 *   one JSON entry per line, each with the `sessionId` and the `cwd` it was written in, and a
 *   `<session id>/` directory beside it for subagent transcripts (`subagents/agent-*.jsonl`) and
 *   tool results kept out of the transcript. `claude --resume <id>` looks for the id under the
 *   directory of the cwd it starts in, so the VM starts it in the same path (or the session file
 *   moves to /work's directory, its `cwd`s rewritten).
 * - `~/.claude.json` holds onboarding and per-project trust. A fresh VM gets both marked done.
 * - Auth: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) point
 *   it at a gateway, here kyora's broker. It never sees an Anthropic credential.
 */

export const claudeConfigDir = (env: Record<string, string | undefined> = process.env): string => env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude")

/** settings that run something on this laptop, or hand Claude Code a credential: never copied */
const CREDENTIAL_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "forceLoginMethod", "forceLoginOrgUUID"]
/** env a project may set that would take the broker's place */
const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_)/
/** directories a command may name that the VM has too */
const SYSTEM_PATHS = ["/usr/", "/bin/", "/sbin/", "/opt/", "/tmp/", "/etc/", "/dev/null", "/proc/", "/work/"]

export interface Settings {
  [key: string]: unknown
}

type Hook = { type?: string; command?: string; [key: string]: unknown }
type HookGroup = { matcher?: string; hooks?: Hook[]; [key: string]: unknown }

/**
 * Absolute paths (and ~, $HOME) a command names that aren't the project's own: what a hook or
 * MCP server would find missing in the VM, or would read out of a home it doesn't have.
 */
export function localPaths(command: string, project: string): string[] {
  const found: string[] = []
  for (const match of command.matchAll(/(?:^|[\s'"=:(`])(~(?=\/|$|[\s'"])|\$HOME\b|\$\{HOME\}|\/[^\s'"`;|&)]*)/g)) {
    const path = match[1]!
    if (path === "/") continue
    if (path.startsWith("~") || path.startsWith("$")) {
      found.push(path)
      continue
    }
    if (within(project, path)) continue
    if (SYSTEM_PATHS.some((system) => path === system.replace(/\/$/, "") || path.startsWith(system))) continue
    found.push(path)
  }
  return found
}

function readJsonFile(text: string | null, what: string, dropped: string[]): Settings | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Settings
  } catch {}
  dropped.push(`${what}: not a JSON object, left out`)
  return null
}

const readText = (path: string) => readFile(path, "utf8").catch(() => null)

/**
 * A file of the repo's, read only when it really is inside the repo: its real path (every
 * symlink on the way resolved) under the repo's real top. A committed symlink to ~/.ssh/id_ed25519
 * or ~/.claude/settings.json reads as nothing.
 */
async function insideRepo(root: string, path: string): Promise<boolean> {
  const [top, real] = await Promise.all([realpath(root).catch(() => null), realpath(path).catch(() => null)])
  return top !== null && real !== null && (real === top || real.startsWith(`${top}/`))
}

const readInside = async (root: string, path: string, encoding: "utf8" | null = "utf8"): Promise<string | Buffer | null> =>
  (await insideRepo(root, path)) ? (encoding === null ? readFile(path) : readFile(path, encoding)).catch(() => null) : null
const readTextInside = (root: string, path: string) => readInside(root, path) as Promise<string | null>

/** keys about MCP approval: decided on the laptop (`approvedMcp`), never handed to the VM */
const MCP_APPROVAL_KEYS = ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"]

/**
 * The project's settings (`.claude/settings.json`, then `settings.local.json` over it) as one
 * user-level settings file for the VM, which runs with `--setting-sources user` so the copies in
 * the repo don't apply on top. Hooks that name a path outside the project (a script in ~, a tool
 * only this laptop has) are dropped one by one; credential helpers and auth env always; the
 * local file's own `env` and hooks too (it is personal, and where people keep tokens). Plugins
 * aren't installed there.
 * `permissions` never goes: its rules are command lines, and people put tokens in those (the VM
 * runs with its own --permission-mode anyway).
 */
export function mergeSettings(project: Settings | null, local: Settings | null, root: string, dropped: string[]): Settings {
  const merged: Settings = {}
  const hooks: Record<string, HookGroup[]> = {}
  for (const [source, settings] of [["settings.json", project], ["settings.local.json", local]] as const) {
    if (!settings) continue
    for (const [key, value] of Object.entries(settings)) {
      if (CREDENTIAL_KEYS.includes(key)) {
        dropped.push(`.claude/${source}: ${key} (credential helpers are not copied)`)
        continue
      }
      if (key === "enabledPlugins" || key === "extraKnownMarketplaces") {
        dropped.push(`.claude/${source}: ${key} (plugins aren't installed in the VM)`)
        continue
      }
      if (key === "env") {
        if (source === "settings.local.json") {
          const count = typeof value === "object" && value !== null ? Object.keys(value).length : 0
          if (count > 0) dropped.push(`.claude/settings.local.json: env (${count} variable${count === 1 ? "" : "s"}; the local file is where secrets live)`)
          continue
        }
        const env: Record<string, unknown> = {}
        for (const [name, setting] of Object.entries((value as Record<string, unknown>) ?? {})) {
          if (AUTH_ENV.test(name)) dropped.push(`.claude/${source}: env ${name} (local credentials are not copied)`)
          else env[name] = setting
        }
        merged.env = { ...(merged.env as Record<string, unknown> | undefined), ...env }
        continue
      }
      if (key === "statusLine") continue
      if (key === "hooks" && source === "settings.local.json") {
        // the personal file's hooks are this laptop's own automation, and their command lines are where its tokens end up
        if (typeof value === "object" && value !== null && Object.keys(value).length > 0) dropped.push(".claude/settings.local.json: hooks (the local file is personal; its commands stay here)")
        continue
      }
      if (key === "hooks" && typeof value === "object" && value !== null) {
        for (const [event, groups] of Object.entries(value as Record<string, unknown>)) {
          if (!Array.isArray(groups)) continue
          for (const group of groups as HookGroup[]) {
            const kept = (group.hooks ?? []).filter((hook) => {
              const paths = typeof hook.command === "string" ? localPaths(hook.command, root) : []
              if (paths.length === 0) return true
              dropped.push(`.claude/${source}: ${event} hook${group.matcher ? ` (${group.matcher})` : ""} \`${hook.command!.slice(0, 80)}\` (names ${paths[0]}, which is on this laptop only)`)
              return false
            })
            if (kept.length > 0) (hooks[event] ??= []).push({ ...group, hooks: kept })
          }
        }
        continue
      }
      if (key === "permissions") {
        dropped.push(`.claude/${source}: permissions (rules are command lines, and can carry tokens; the VM runs with its own --permission-mode)`)
        continue
      }
      if (MCP_APPROVAL_KEYS.includes(key)) continue
      merged[key] = value
    }
  }
  if (Object.keys(hooks).length > 0) merged.hooks = hooks
  return merged
}

interface McpServer {
  command?: string
  args?: unknown
  url?: string
  env?: unknown
  headers?: unknown
  type?: string
  [key: string]: unknown
}

/** which of the project's `.mcp.json` servers this user approved (Claude Code asks before it starts one) */
export interface McpApproval {
  all: boolean
  enabled: Set<string>
  disabled: Set<string>
}

/**
 * The approvals as Claude Code reads them for a repo (2.1.288): `disabledMcpjsonServers` from any
 * settings file rejects; `enableAllProjectMcpServers` or `enabledMcpjsonServers` approve from the
 * user's own settings or the project's local (personal) ones, never from the repo's shared
 * `.claude/settings.json`: a repo doesn't approve its own servers.
 */
export function approvedMcp(user: Settings | null, project: Settings | null, local: Settings | null): McpApproval {
  const names = (settings: Settings | null, key: string) => (Array.isArray(settings?.[key]) ? (settings![key] as unknown[]).filter((name): name is string => typeof name === "string") : [])
  return {
    all: user?.enableAllProjectMcpServers === true || local?.enableAllProjectMcpServers === true,
    enabled: new Set([...names(user, "enabledMcpjsonServers"), ...names(local, "enabledMcpjsonServers")]),
    disabled: new Set([...names(user, "disabledMcpjsonServers"), ...names(project, "disabledMcpjsonServers"), ...names(local, "disabledMcpjsonServers")]),
  }
}

/** an env or header value that only names a variable (`${GITHUB_TOKEN}`), so it holds no secret itself */
const VARIABLE_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
/** what a token looks like on a command line: the common prefixes, a bearer, a JWT */
const SECRET_LITERAL = /(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_|glpat-|sk-[A-Za-z0-9_-]{8,}|sk_live_|rk_live_|xox[abprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|lin_api_|Bearer\s+\S{6,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/
/** a flag or assignment whose value is a secret: `--token X`, `--api-key=X`, `API_KEY=X` */
const SECRET_NAME = /(token|secret|passw(or)?d|api[-_]?key|apikey|auth|credential|private[-_]?key)/i

/** the first argument of an MCP server's command line that carries a literal secret, described (never shown) */
export function secretArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (SECRET_LITERAL.test(arg)) return `argument ${i + 1}`
    const assigned = /^-{0,2}([A-Za-z0-9_.-]+)=(.+)$/.exec(arg)
    if (assigned && SECRET_NAME.test(assigned[1]!) && !VARIABLE_ONLY.test(assigned[2]!)) return `${assigned[1]}=…`
    if (/^--?[A-Za-z0-9_.-]+$/.test(arg) && SECRET_NAME.test(arg) && i + 1 < args.length && !args[i + 1]!.startsWith("-") && !VARIABLE_ONLY.test(args[i + 1]!)) return `${arg} …`
  }
  return null
}

/**
 * A path segment of an MCP URL that is a credential itself: token-shaped (`/mcp/sk-ak-…/sse`), a
 * UUID (Pipedream's per-user endpoints), or a long random string of letters and digits.
 */
export function secretInPath(url: string): boolean {
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return false
  }
  return path.split("/").some(
    (segment) =>
      SECRET_LITERAL.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      (segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)),
  )
}

/** an MCP server's URL without what can carry a credential: user and password, the query, the fragment */
function bareUrl(url: string): { url: string; stripped: boolean } {
  try {
    const parsed = new URL(url)
    const stripped = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash)
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    return { url: parsed.toString(), stripped }
  } catch {
    return { url, stripped: false }
  }
}

/**
 * The project's `.mcp.json` servers that go to the VM: those this user approved, and of them none
 * that start a program only this laptop has or talk to its localhost. An `env` or `headers` value
 * goes only when it is a bare `${VAR}` reference; a literal one (a token, typically) is dropped,
 * its name listed. A URL loses its user, password and query; a server whose command line carries
 * a literal secret (`--token ghp_…`, `API_KEY=…`) stays here altogether.
 */
export function portableMcp(config: Settings | null, root: string, dropped: string[], approval: McpApproval | null = null): Record<string, McpServer> {
  const servers = (config?.mcpServers ?? {}) as Record<string, McpServer>
  const kept: Record<string, McpServer> = {}
  for (const [name, original] of Object.entries(servers)) {
    if (typeof original !== "object" || original === null) continue
    if (approval && (approval.disabled.has(name) || !(approval.all || approval.enabled.has(name)))) {
      dropped.push(`.mcp.json: ${name} (${approval.disabled.has(name) ? "disabled" : "not approved"} in your settings here)`)
      continue
    }
    const server: McpServer = { ...original }
    for (const field of ["env", "headers"] as const) {
      const values = server[field]
      if (typeof values !== "object" || values === null) continue
      const clean: Record<string, unknown> = {}
      const literal: string[] = []
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value === "string" && VARIABLE_ONLY.test(value)) clean[key] = value
        else literal.push(key)
      }
      if (literal.length > 0) dropped.push(`.mcp.json: ${name} ${field} ${literal.join(", ")} (a value of its own, not a \${VAR} reference: secrets stay here)`)
      server[field] = clean
    }
    if (typeof server.url === "string") {
      const bare = bareUrl(server.url)
      if (/^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(bare.url)) {
        dropped.push(`.mcp.json: ${name} (${bare.url} is this laptop's)`)
        continue
      }
      if (secretInPath(bare.url)) {
        dropped.push(`.mcp.json: ${name} (its URL's path carries a credential: such a server stays here)`)
        continue
      }
      if (bare.stripped) dropped.push(`.mcp.json: ${name} url's user, password and query (where tokens go)`)
      kept[name] = { ...server, url: bare.url }
      continue
    }
    const secret = secretArg(Array.isArray(server.args) ? server.args.map(String) : [])
    if (secret) {
      dropped.push(`.mcp.json: ${name} (its command line carries a secret: ${secret}; pass it as a \${VAR} in env instead)`)
      continue
    }
    const words = [server.command ?? "", ...(Array.isArray(server.args) ? server.args.map(String) : [])]
    const paths = words.flatMap((word) => localPaths(` ${word}`, root))
    if (paths.length > 0) {
      dropped.push(`.mcp.json: ${name} (names ${paths[0]}, which is on this laptop only)`)
      continue
    }
    kept[name] = server
  }
  return kept
}

/** what `projectConfig` copies into the VM user's ~/.claude, at most */
const MAX_COPIED_FILE = 512 * 1024
const MAX_COPIED_TOTAL = 8 * 1024 * 1024
const MAX_NESTED = 200
/** the project's directories Claude Code reads from `.claude/` (with the `project` source), as user-level ones */
const USER_SCOPE_DIRS = ["skills", "agents", "commands", "output-styles"]

const slug = (rel: string) => rel.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"

/** frontmatter hooks a copied agent or skill runs (user-scope copies run them whatever the folder's trust), naming a laptop-only path */
function laptopHook(text: string, root: string): string | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1]
  if (!front || !/^hooks:/m.test(front)) return null
  for (const match of front.matchAll(/command:\s*(.+)/g)) {
    const paths = localPaths(match[1]!.replace(/^["']|["']$/g, ""), root)
    if (paths.length > 0) return paths[0]!
  }
  return null
}

/**
 * The project's instructions, rules, skills, agents, commands and output styles, for a VM whose
 * Claude Code runs with `--setting-sources user` (so the repo's own settings, hooks, env, helpers
 * and `.mcp.json` are never read there, and neither is anything else the `project` source gates):
 *
 * - CLAUDE.md and .claude/CLAUDE.md of the session's directory and every one above it up to the
 *   repo's top: imported (`@/path`) from the VM user's ~/.claude/CLAUDE.md, read in place from the
 *   repo, imports inside them as they are (Claude Code 2.1.288 loads user-memory imports in -p
 *   without asking);
 * - CLAUDE.md files deeper down: path-scoped user rules (`paths: <dir>/**`) importing them, so they
 *   load when the agent works there, as Claude Code does with nested ones;
 * - .claude/rules of those directories: copied into ~/.claude/rules/kyora-project/;
 * - .claude/{skills,agents,commands,output-styles}: copied into ~/.claude/, minus an agent or
 *   skill whose frontmatter hooks name a laptop-only path.
 *
 * Only what went up with the tree counts; the repo's settings are merged separately (`mergeSettings`).
 */
export async function projectConfig(root: string, cwd: string, remote: (path: string) => string, files: string[], dropped: string[]): Promise<{ imports: string[]; files: StagedFile[] }> {
  const have = new Set(files)
  const cwdRel = relative(root, cwd)
  const chain = [""]
  if (cwdRel) {
    const parts = cwdRel.split("/")
    for (let i = 1; i <= parts.length; i++) chain.push(parts.slice(0, i).join("/"))
  }
  const at = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel)
  const imports: string[] = []
  const staged: StagedFile[] = []
  // only what is inside the repo for real: a symlink out of it (to ~/.ssh, to ~/.claude) is left behind
  const inside = async (rel: string) => {
    if (await insideRepo(root, join(root, rel))) return true
    dropped.push(`${rel} (a symlink out of the repo)`)
    return false
  }
  for (const dir of chain) for (const name of ["CLAUDE.md", ".claude/CLAUDE.md"]) if (have.has(at(dir, name)) && (await inside(at(dir, name)))) imports.push(remote(join(root, at(dir, name))))

  // CLAUDE.md files below the session's directory: loaded when the agent works under them
  const nested = files.filter((file) => /(^|\/)(\.claude\/)?CLAUDE\.md$/.test(file) && !chain.some((dir) => file === at(dir, "CLAUDE.md") || file === at(dir, ".claude/CLAUDE.md")))
  const below = nested.filter((file) => !cwdRel || file.startsWith(`${cwdRel}/`))
  if (below.length > MAX_NESTED) dropped.push(`${below.length - MAX_NESTED} nested CLAUDE.md files past the first ${MAX_NESTED}`)
  for (const file of below.slice(0, MAX_NESTED)) {
    if (!(await inside(file))) continue
    const dir = file.replace(/(^|\/)(\.claude\/)?CLAUDE\.md$/, "")
    const scope = relative(cwd, join(root, dir))
    staged.push({ rel: `.claude/rules/kyora-project/nested/${slug(file)}.md`, contents: `---\npaths:\n  - "${scope}/**"\n---\n@${remote(join(root, file))}\n` })
  }

  let total = 0
  const copy = async (from: string, to: string): Promise<boolean> => {
    if (!(await inside(from))) return false
    const size = (await stat(join(root, from)).catch(() => null))?.size ?? 0
    if (size > MAX_COPIED_FILE || total + size > MAX_COPIED_TOTAL) {
      dropped.push(`${from} (${size > MAX_COPIED_FILE ? "too large" : "past the size kyora session copies"} to copy into the VM's ~/.claude)`)
      return false
    }
    const contents = await readFile(join(root, from)).catch(() => null)
    if (contents === null) return false
    total += size
    staged.push({ rel: to, contents })
    return true
  }
  for (const dir of chain) {
    const base = at(dir, ".claude/")
    for (const file of files.filter((name) => name.startsWith(`${base}rules/`) && name.endsWith(".md")).sort()) {
      await copy(file, `.claude/rules/kyora-project/${slug(dir)}/${file.slice(`${base}rules/`.length)}`)
    }
    for (const kind of USER_SCOPE_DIRS) {
      const own = files.filter((name) => name.startsWith(`${base}${kind}/`)).sort()
      // a skill is its directory: one whose SKILL.md (or an agent whose own file) runs a laptop-only hook stays behind whole
      const refused = new Set<string>()
      for (const file of own.filter((name) => name.endsWith(".md"))) {
        const text = (await readTextInside(root, join(root, file))) ?? ""
        const hook = laptopHook(text, root)
        if (!hook) continue
        const unit = kind === "skills" ? file.slice(0, file.indexOf("/", `${base}${kind}/`.length) + 1) || file : file
        refused.add(unit)
        dropped.push(`${unit} (a hook names ${hook}, which is on this laptop only)`)
      }
      for (const file of own) {
        if ([...refused].some((unit) => file === unit || (unit.endsWith("/") && file.startsWith(unit)))) continue
        await copy(file, `.claude/${kind}/${file.slice(base.length + kind.length + 1)}`)
      }
    }
  }
  return { imports, files: staged }
}

/** the transcript's facts: where it ran, on what model, written by which version */
function describe(text: string): { cwd: string | null; model: string | null; version: string | null } {
  let cwd: string | null = null
  let model: string | null = null
  let version: string | null = null
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (cwd === null && typeof entry.cwd === "string") cwd = entry.cwd
    if (typeof entry.version === "string") version = entry.version
    const message = entry.message as { role?: unknown; model?: unknown } | undefined
    if (entry.type === "assistant" && typeof message?.model === "string" && !message.model.startsWith("<")) model = message.model
  }
  return { cwd, model, version }
}

async function newest(dir: string): Promise<string | null> {
  let best: { file: string; at: number } | null = null
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl") || !SESSION_ID.test(name.slice(0, -".jsonl".length))) continue
    const at = (await stat(join(dir, name))).mtimeMs
    if (!best || at > best.at) best = { file: join(dir, name), at }
  }
  return best?.file ?? null
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",

  async find({ cwd, top, id }) {
    const projects = join(claudeConfigDir(), "projects")
    const dirs = [...new Set([join(projects, claudeProjectName(cwd)), join(projects, claudeProjectName(top))])]
    let file: string | null = null
    if (id !== undefined) {
      if (!SESSION_ID.test(id)) throw new AgentError(`--session ${id}: a Claude Code session id is a UUID`)
      for (const dir of dirs) if (!file && (await exists(join(dir, `${id}.jsonl`)))) file = join(dir, `${id}.jsonl`)
      // started in a subdirectory: any project directory may have it
      if (!file) {
        for (const name of await readdir(projects).catch(() => [] as string[])) {
          if (await exists(join(projects, name, `${id}.jsonl`))) {
            file = join(projects, name, `${id}.jsonl`)
            break
          }
        }
      }
      if (!file) throw new AgentError(`no Claude Code session ${id} under ${projects}`)
    } else {
      for (const dir of dirs) {
        const found = await newest(dir)
        if (found && (!file || (await stat(found)).mtimeMs > (await stat(file)).mtimeMs)) file = found
      }
      if (!file) throw new AgentError(`no Claude Code session for ${top} under ${projects} (start one with \`claude\` first, or pass --session <id>)`)
    }
    const text = await readFile(file, "utf8")
    const facts = describe(text)
    const sessionId = basename(file, ".jsonl")
    if (!facts.cwd) throw new AgentError(`${file}: no working directory recorded in it`)
    if ((await sessionRoot(facts.cwd, top)) === null) throw new AgentError(`session ${sessionId} ran in ${facts.cwd}, which is not inside ${top}`)
    const extra = join(dirname(file), sessionId)
    return { agent: "claude", id: sessionId, cwd: facts.cwd, file, extra: (await exists(extra)) ? extra : null, model: facts.model, version: facts.version }
  },

  async stage(session, map) {
    const remoteCwd = toRemote(map, session.cwd)
    const base = `.claude/projects/${claudeProjectName(remoteCwd)}`
    const move = (text: string) => (map.local === map.remote ? text : this.rewriteCwd(text, map.local, map.remote))
    const files: StagedFile[] = [{ rel: `${base}/${session.id}.jsonl`, contents: move(await readFile(session.file, "utf8")) }]
    if (session.extra) {
      for (const rel of await walk(session.extra)) {
        const path = join(session.extra, rel)
        files.push({ rel: `${base}/${session.id}/${rel}`, contents: rel.endsWith(".jsonl") ? move(await readFile(path, "utf8")) : await readFile(path) })
      }
    }
    return files
  },

  async config(session, map, options: ConfigOptions) {
    const root = (await sessionRoot(session.cwd, map.local)) ?? map.local
    const project = session.cwd
    const dropped: string[] = []
    const projectSettings = readJsonFile(await readTextInside(root, join(project, ".claude", "settings.json")), ".claude/settings.json", dropped)
    const localSettings = readJsonFile(await readTextInside(root, join(project, ".claude", "settings.local.json")), ".claude/settings.local.json", dropped)
    const settings = mergeSettings(projectSettings, localSettings, root, dropped)
    const userSettings = readJsonFile(await readText(join(claudeConfigDir(), "settings.json")), "your Claude Code settings.json", [])
    // .mcp.json at the top and where the session runs (the deeper one wins); a gitignored one is personal, and stays
    let servers: Record<string, McpServer> = {}
    for (const dir of [...new Set([root, project])]) {
      const rel = dir === root ? ".mcp.json" : `${relative(root, dir)}/.mcp.json`
      if (!(await exists(join(dir, ".mcp.json")))) continue
      if (await options.ignored(rel)) {
        dropped.push(`${rel} (gitignored: personal, and where tokens live)`)
        continue
      }
      servers = { ...servers, ...portableMcp(readJsonFile(await readTextInside(root, join(dir, ".mcp.json")), rel, dropped), root, dropped, approvedMcp(userSettings, projectSettings, localSettings)) }
    }
    const remoteCwd = toRemote(map, session.cwd)
    const instructions = await projectConfig(root, project, (path) => toRemote(map, path), (await options.files?.()) ?? [], dropped)
    const files: StagedFile[] = [
      { rel: ".claude/settings.json", contents: `${JSON.stringify(settings, null, 2)}\n` },
      { rel: ".kyora-session/mcp.json", contents: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` },
      {
        rel: ".claude.json",
        // a fresh install would stop at onboarding and the trust dialog: both are this user's to have accepted already
        contents: `${JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects: { [remoteCwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }, null, 2)}\n`,
      },
      ...instructions.files,
    ]
    // the VM user's memory: the project's instructions imported in place, and a gitignored CLAUDE.local.md (personal: it didn't go up with the repo)
    const memory: string[] = []
    const inline = instructions.imports.filter((path) => /\s/.test(path))
    if (instructions.imports.length > inline.length) {
      memory.push("<!-- the project's instructions, imported from the repo by kyora session up (the VM runs Claude Code with --setting-sources user) -->", ...instructions.imports.filter((path) => !/\s/.test(path)).map((path) => `@${path}`))
    }
    for (const path of inline) {
      const local = rebaseRemote(path, map)
      const text = local ? await readTextInside(map.local, local) : null
      if (text !== null) memory.push(`<!-- ${path}, copied by kyora session up -->`, text)
    }
    const localMemory = join(project, "CLAUDE.local.md")
    const rel = project === root ? "CLAUDE.local.md" : `${project.slice(root.length + 1)}/CLAUDE.local.md`
    if ((await exists(localMemory)) && (await options.ignored(rel))) {
      const text = await readTextInside(root, localMemory)
      if (text !== null) memory.push("<!-- the project's CLAUDE.local.md, brought along by kyora session up -->", text)
    }
    if (memory.length > 0) files.push({ rel: ".claude/CLAUDE.md", contents: `${memory.join("\n")}\n` })
    return { files, dropped, args: ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", `${REMOTE_HOME}/.kyora-session/mcp.json`] }
  },

  exportPaths(session, map) {
    const base = `.claude/projects/${claudeProjectName(toRemote(map, session.cwd))}`
    return { file: `${base}/${session.id}.jsonl`, extra: `${base}/${session.id}` }
  },

  launch(session, _map, options: LaunchOptions): LaunchPlan {
    const model = options.model ?? session.model
    const argv = [
      "claude",
      "-p",
      "--resume",
      session.id,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      options.permissionMode,
      ...options.configArgs,
      ...(model ? ["--model", model] : []),
      options.prompt,
    ]
    const env: Record<string, string> = {
      // no telemetry, error reports, update checks or feature-flag fetches: the VM only talks to the broker
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    }
    if (options.broker) {
      env.ANTHROPIC_BASE_URL = options.broker.baseUrl
      env.ANTHROPIC_AUTH_TOKEN = options.broker.token
    }
    return { argv, env, install: { bin: "claude", pkg: "@anthropic-ai/claude-code", version: session.version } }
  },

  rename(text, from, to) {
    return mapJsonl(text, (entry) => {
      if (entry.sessionId !== from) return false
      entry.sessionId = to
      return true
    })
  },

  rewriteCwd(text, from, to) {
    return mapJsonl(text, (entry) => moveField(entry, "cwd", from, to))
  },

  forkFile(session, id) {
    return { file: join(dirname(session.file), `${id}.jsonl`), extra: join(dirname(session.file), id) }
  },

  copiedCredentials(slotFiles) {
    const credentials = slotFiles["credentials.json"]
    if (!credentials) throw new AgentError("that slot has no credentials.json")
    return [{ rel: ".claude/.credentials.json", contents: credentials }]
  },
}
