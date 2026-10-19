import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { type AgentAdapter, AgentError, type LocalSession, mapJsonl, moveField, SESSION_ID, sessionRoot, walk } from "./agents"

/**
 * Codex, as its CLI lays out its files: `$CODEX_HOME` (default `~/.codex`) holds
 * `sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`, whose first line is a `session_meta`
 * entry carrying the id and the cwd (`turn_context` entries repeat the cwd). Codex finds a
 * session by id wherever it was started, so the VM's path matters less than for Claude Code, and
 * `codex exec resume <id> <prompt>` carries it on headless.
 *
 * What is missing is a broker: Codex can be pointed at another endpoint (a `model_providers`
 * entry with a `base_url` in config.toml) for API-key use, but a ChatGPT-plan login talks to
 * chatgpt.com's backend with an account id and refreshes rotating tokens the same way Claude
 * Code's OAuth does. TODO(cloud-sessions): a Codex route on the broker (API keys first). Until
 * then a Codex session needs `--unsafe-copy-credentials <slot>` (auth.json goes into the VM) or
 * an OPENAI_API_KEY passed with --env.
 */

export const codexHome = (env: Record<string, string | undefined> = process.env): string => env.CODEX_HOME || join(env.HOME || homedir(), ".codex")

const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function meta(text: string): { id: string | null; cwd: string | null; version: string | null } {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { id?: unknown; cwd?: unknown; cli_version?: unknown } }
      if (entry.type !== "session_meta") continue
      const payload = entry.payload ?? {}
      return {
        id: typeof payload.id === "string" ? payload.id : null,
        cwd: typeof payload.cwd === "string" ? payload.cwd : null,
        version: typeof payload.cli_version === "string" ? payload.cli_version : null,
      }
    } catch {}
  }
  return { id: null, cwd: null, version: null }
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",

  async find({ top, id }) {
    if (id !== undefined && !SESSION_ID.test(id)) throw new AgentError(`--session ${id}: a Codex session id is a UUID`)
    const sessions = join(codexHome(), "sessions")
    let best: { file: string; at: number; cwd: string; version: string | null } | null = null
    for (const rel of await walk(sessions)) {
      const match = ROLLOUT.exec(basename(rel))
      if (!match || (id !== undefined && match[1]!.toLowerCase() !== id.toLowerCase())) continue
      const file = join(sessions, rel)
      const facts = meta(await readFile(file, "utf8"))
      if (!facts.cwd || (await sessionRoot(facts.cwd, top)) === null) {
        if (id !== undefined) throw new AgentError(`Codex session ${id} ran in ${facts.cwd ?? "an unknown directory"}, which is not inside ${top}`)
        continue
      }
      const at = (await stat(file)).mtimeMs
      if (!best || at > best.at) best = { file, at, cwd: facts.cwd, version: facts.version }
    }
    if (!best) throw new AgentError(id ? `no Codex session ${id} under ${sessions}` : `no Codex session for ${top} under ${sessions}`)
    return { agent: "codex", id: ROLLOUT.exec(basename(best.file))![1]!, cwd: best.cwd, file: best.file, extra: null, model: null, version: best.version }
  },

  async stage(session, map) {
    const text = await readFile(session.file, "utf8")
    return [{ rel: `.codex/${relative(codexHome(), session.file)}`, contents: map.local === map.remote ? text : this.rewriteCwd(text, map.local, map.remote) }]
  },

  async config() {
    // AGENTS.md travels with the repo; ~/.codex/config.toml is the user's, not the project's
    return { files: [], dropped: [], args: [] }
  },

  exportPaths(session) {
    return { file: `.codex/${relative(codexHome(), session.file)}`, extra: null }
  },

  launch(session: LocalSession, _map, options) {
    const argv = ["codex", "exec", "resume", session.id, "--json", "--dangerously-bypass-approvals-and-sandbox", ...(options.model ? ["--model", options.model] : []), options.prompt]
    return { argv, env: {}, install: { bin: "codex", pkg: "@openai/codex", version: session.version } }
  },

  rename(text, from, to) {
    return mapJsonl(text, (entry) => {
      const payload = entry.payload as Record<string, unknown> | undefined
      if (entry.type !== "session_meta" || payload?.id !== from) return false
      payload.id = to
      return true
    })
  },

  rewriteCwd(text, from, to) {
    return mapJsonl(text, (entry) => {
      const payload = entry.payload as Record<string, unknown> | undefined
      return typeof payload === "object" && payload !== null ? moveField(payload, "cwd", from, to) : false
    })
  },

  forkFile(session, id) {
    const name = basename(session.file).replace(ROLLOUT, (whole, old: string) => whole.replace(old, id))
    return { file: join(dirname(session.file), name), extra: null }
  },

  copiedCredentials(slotFiles) {
    const auth = slotFiles["auth.json"]
    if (!auth) throw new AgentError("that slot has no auth.json")
    return [{ rel: ".codex/auth.json", contents: auth }]
  },
}
