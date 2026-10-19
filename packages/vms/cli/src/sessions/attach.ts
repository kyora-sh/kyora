import { ApiError, type ExecRequest, type StreamOffsets, type VmsClient } from "../api"
import { pause } from "../multipart"
import { note, write } from "../output"

/**
 * Watching a session's agent from the laptop. Until sandboxes have persistent terminals
 * (feat/vms-shell), the agent runs headless inside the supervisor's resumable exec, and `attach`
 * is a reattach to that exec's stream: from the start of what the sandbox kept (the latest
 * 8 MiB), rendered from the agent's JSON events, reconnecting when the stream breaks. Ctrl-C
 * lets go of the stream; the agent runs on. TODO(feat/vms-shell): a session started in a tmux
 * window attaches through `kyora vms shell` instead, and gets a real terminal.
 */

const EXEC_ID = /^[0-9a-f]{32}$/

/**
 * Starts a resumable command and lets go of it as soon as the machine named it (`started` with
 * its id): it runs on in the sandbox with nobody attached. A server or guest image that can't
 * keep a command (no id) is refused, since dropping the stream would kill it there.
 */
export async function startDetached(api: VmsClient, id: string, request: ExecRequest, timeoutMs = 120_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("no answer")), timeoutMs)
  try {
    const response = await api.exec(id, { ...request, resumable: true }, controller.signal)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const stderr: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === "started") {
          if (event.resumable === true && typeof event.id === "string" && EXEC_ID.test(event.id)) {
            controller.abort(new Error("detached"))
            return event.id
          }
          throw new Error(`${id} does not support detached commands, which sessions require`)
        }
        if (event.type === "stderr" && typeof event.data === "string") stderr.push(event.data)
        if (event.type === "exit" || event.type === "error") {
          const said = typeof event.message === "string" ? event.message : stderr.join("").trim().split("\n").slice(-3).join(" / ")
          throw new Error(`the session's supervisor ended at once${said ? `: ${said}` : ""}`)
        }
      }
    }
    throw new Error("the exec stream ended before the machine named the command")
  } finally {
    clearTimeout(timer)
  }
}

interface Block {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
  is_error?: boolean
}

const firstLine = (text: string, max = 160) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** what a tool call was about, in a few words */
function toolSummary(block: Block): string {
  const input = block.input ?? {}
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.prompt
  return typeof pick === "string" ? `${block.name}: ${firstLine(pick, 120)}` : String(block.name ?? "tool")
}

/**
 * One line of Claude Code's `--output-format stream-json` as text for a person, or null for
 * lines with nothing to show. Anything it doesn't know (another agent's JSON, plain text) comes
 * out as it is.
 */
export function renderEvent(line: string): string | null {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(line)
  } catch {
    return line
  }
  if (typeof event !== "object" || event === null) return line
  const message = event.message as { content?: Block[] | string } | undefined
  switch (event.type) {
    case "system":
      return event.subtype === "init" ? `── ${String(event.session_id ?? "session")} · ${String(event.model ?? "")}`.trimEnd() : null
    case "assistant": {
      const out: string[] = []
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block.type === "text" && block.text?.trim()) out.push(block.text.trim())
        else if (block.type === "tool_use") out.push(`▸ ${toolSummary(block)}`)
      }
      return out.length > 0 ? out.join("\n") : null
    }
    case "user": {
      const out: string[] = []
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block.type !== "tool_result" || !block.is_error) continue
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? (block.content as Block[]).map((part) => part.text ?? "").join(" ") : ""
        out.push(`  ✗ ${firstLine(text)}`)
      }
      return out.length > 0 ? out.join("\n") : null
    }
    case "result": {
      const cost = typeof event.total_cost_usd === "number" ? ` · $${event.total_cost_usd.toFixed(2)}` : ""
      const turns = typeof event.num_turns === "number" ? ` · ${event.num_turns} turns` : ""
      return `── ${event.subtype === "success" ? "done" : String(event.subtype ?? "ended")}${turns}${cost}${typeof event.result === "string" && event.result.trim() ? `\n${event.result.trim()}` : ""}`
    }
    default:
      return typeof event.type === "string" ? null : line
  }
}

export interface FollowOptions {
  /** the agent's own JSON lines instead of the rendering */
  raw: boolean
  signal: AbortSignal
  /** how long a broken stream is retried before giving up */
  windowMs?: number
}

export type FollowEnd = { kind: "exit"; code: number | null } | { kind: "detached" } | { kind: "lost"; reason: string }

/** follows the supervisor's output until it ends, the user lets go (Ctrl-C), or reattaching stops working */
export async function follow(api: VmsClient, id: string, execId: string, options: FollowOptions): Promise<FollowEnd> {
  const offsets: StreamOffsets = { stdout: 0, stderr: 0 }
  let partial = ""
  let failingSince: number | null = null
  let delay = 500
  const decoder = new TextDecoder()
  const emit = async (line: string) => {
    const text = options.raw ? line : renderEvent(line)
    if (text !== null) await write(process.stdout, `${text}\n`)
  }
  for (;;) {
    if (options.signal.aborted) return { kind: "detached" }
    let response: Response
    try {
      response = await api.attach(id, execId, offsets, options.signal)
    } catch (error) {
      if (options.signal.aborted) return { kind: "detached" }
      if (error instanceof ApiError && error.status === 404) return { kind: "lost", reason: "the sandbox no longer has the session's command (it ended over 10 minutes ago, or the sandbox is gone)" }
      failingSince ??= Date.now()
      if (Date.now() - failingSince > (options.windowMs ?? 120_000)) return { kind: "lost", reason: error instanceof Error ? error.message : String(error) }
      await pause(delay, options.signal).catch(() => {})
      delay = Math.min(10_000, delay * 2)
      continue
    }
    failingSince = null
    delay = 500
    const reader = response.body!.getReader()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          let event: Record<string, unknown>
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.type === "stdout" || event.type === "stderr") {
            const bytes = typeof event.b64 === "string" ? Buffer.from(event.b64, "base64") : Buffer.from(typeof event.data === "string" ? event.data : "")
            offsets[event.type] += bytes.length
            if (event.type === "stderr") {
              await write(process.stderr, bytes)
              continue
            }
            partial += bytes.toString("utf8")
            let end: number
            while ((end = partial.indexOf("\n")) !== -1) {
              await emit(partial.slice(0, end))
              partial = partial.slice(end + 1)
            }
          } else if (event.type === "gap" && (event.stream === "stdout" || event.stream === "stderr") && typeof event.to === "number") {
            if (event.to > offsets[event.stream]) note(`(the sandbox kept only the latest 8 MiB; ${event.to - offsets[event.stream]} earlier bytes of ${event.stream} are not shown)`)
            offsets[event.stream] = Math.max(offsets[event.stream], event.to)
            if (event.stream === "stdout") partial = ""
          } else if (event.type === "exit") {
            if (partial.trim()) await emit(partial)
            return { kind: "exit", code: typeof event.code === "number" ? event.code : null }
          } else if (event.type === "error") {
            return { kind: "lost", reason: typeof event.message === "string" ? event.message : "the session reported an error" }
          }
        }
      }
    } catch (error) {
      if (options.signal.aborted) return { kind: "detached" }
      void error
    } finally {
      reader.cancel().catch(() => {})
    }
    // the stream broke or the server let go of it: reattach from what we have
    await pause(delay, options.signal).catch(() => {})
  }
}
