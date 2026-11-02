import { Console } from "node:console"
import { format } from "node:util"
import { VERSION } from "./api"
import { createsInFlight, kyoraTools, toolContext, ToolInputError, type Tool, type ToolContext } from "./mcp-tools"
import { note } from "./output"
import { knownSecrets, redact } from "./redact"

export { redact } from "./redact"

/**
 * `kyora mcp`: the CLI as a Model Context Protocol server on stdio (JSON-RPC 2.0, one message per line).
 * stdout carries nothing but its frames: whatever else would print there goes to stderr instead.
 */
export const MCP_HELP = `kyora mcp: the kyora CLI as an MCP server on stdio

  claude mcp add kyora -- kyora mcp

Its tools run VMs (create, exec, run, push, pull, destroy), publish pages, and manage storage,
public URLs, custom domains and deploys, as your \`kyora login\` (or KYORA_TOKEN in the server's
environment). Tokens never appear in tool results. Relative paths are relative to the directory the
server was started in.`

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

const INSTRUCTIONS = `kyora runs commands in disposable microVMs and publishes static pages.
- vms_run is the one-call path: upload a local directory, run a shell command, get the output tails and exit code, optionally pull files back; the VM is destroyed after.
- For several commands against one upload: vms_create, vms_push, vms_exec (repeat), vms_pull, then vms_destroy.
- A VM has no network unless you ask: network "registries" reaches package registries, "open" the internet.
- publish uploads a directory or a file (an HTML report, a built app, screenshots) and returns its URL. Pages are private unless public: true; pages_login_url gives the user a sign-in link.`

type Id = string | number | null

interface Request {
  id?: unknown
  method?: unknown
  params?: unknown
}

export interface Frame {
  jsonrpc: "2.0"
  id: Id
  result?: unknown
  error?: { code: number; message: string }
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

const CANCELLED = "cancelled by the client"

export interface ServerOptions {
  tools: Tool[]
  /** a tool call's context, made per call so a `kyora login` meanwhile is picked up */
  context: (signal: AbortSignal) => Promise<ToolContext>
  /** values to keep out of everything sent back */
  secrets: () => Array<string | null | undefined>
}

const isId = (value: unknown): value is string | number => typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class McpServer {
  private readonly tools: Map<string, Tool>
  private readonly running = new Map<string | number, { controller: AbortController; done: Promise<unknown> }>()

  constructor(private readonly options: ServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  }

  /** one line from the client: what to send back, each its own line (a batch's answers as one array; nothing for a notification) */
  async line(text: string): Promise<Array<Frame | Frame[]>> {
    if (!text.trim()) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return [this.error(null, PARSE_ERROR, "not JSON")]
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return [this.error(null, INVALID_REQUEST, "an empty batch")]
      const frames = (await Promise.all(parsed.map((one) => this.message(one)))).filter((frame): frame is Frame => frame !== null)
      return frames.length ? [frames] : []
    }
    const frame = await this.message(parsed)
    return frame ? [frame] : []
  }

  /** every call still running, cancelled; resolves once they cleaned up (destroyed their VMs) or `waitMs` passed */
  async shutdown(reason: string, waitMs: number): Promise<void> {
    const pending = [...this.running.values()]
    for (const call of pending) call.controller.abort(new Error(reason))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled(pending.map((call) => call.done)), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))])
    clearTimeout(timer)
  }

  private error(id: Id, code: number, text: string): Frame {
    return { jsonrpc: "2.0", id, error: { code, message: this.redact(text) } }
  }

  private redact(text: string): string {
    return redact(text, this.options.secrets())
  }

  private async message(raw: unknown): Promise<Frame | null> {
    if (typeof raw !== "object" || raw === null) return this.error(null, INVALID_REQUEST, "not a JSON-RPC message")
    const request = raw as Request & { jsonrpc?: unknown }
    const id = isId(request.id) ? request.id : null
    if (typeof request.method !== "string") {
      // a response to something this server never asks: nothing to say
      if ("result" in request || "error" in request) return null
      return this.error(id, INVALID_REQUEST, "no method")
    }
    if (request.jsonrpc !== "2.0") return this.error(id, INVALID_REQUEST, "not JSON-RPC 2.0")
    // a request's id is a string or a whole number, never null
    if ("id" in request && (id === null || (typeof id === "number" && !Number.isInteger(id)))) return this.error(null, INVALID_REQUEST, "an id must be a string or a whole number")
    const params = (typeof request.params === "object" && request.params !== null ? request.params : {}) as Record<string, unknown>
    if (!("id" in request)) {
      if (request.method === "notifications/cancelled" && isId(params.requestId)) this.running.get(params.requestId)?.controller.abort(new Error(CANCELLED))
      return null
    }
    const result = (value: unknown): Frame => ({ jsonrpc: "2.0", id, result: value })
    switch (request.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : ""
        const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]!
        return result({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kyora", title: "kyora", version: VERSION }, instructions: INSTRUCTIONS })
      }
      case "ping":
        return result({})
      case "tools/list":
        return result({ tools: [...this.tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) })
      case "tools/call":
        return this.call(id, params)
      case "resources/list":
        return result({ resources: [] })
      case "prompts/list":
        return result({ prompts: [] })
    }
    return this.error(id, METHOD_NOT_FOUND, `no method ${request.method}`)
  }

  private async call(id: Id, params: Record<string, unknown>): Promise<Frame | null> {
    const tool = typeof params.name === "string" ? this.tools.get(params.name) : undefined
    if (!tool) return this.error(id, INVALID_PARAMS, `no tool ${String(params.name)}`)
    const args = params.arguments ?? {}
    const invalid = validate(tool.inputSchema, args)
    if (invalid) return this.error(id, INVALID_PARAMS, `${tool.name}: ${invalid}`)
    const controller = new AbortController()
    const work = this.options.context(controller.signal).then((context) => {
      controller.signal.throwIfAborted()
      return tool.handler(args as Record<string, unknown>, context)
    })
    if (id !== null) this.running.set(id, { controller, done: work.catch(() => {}) })
    try {
      const value = await work
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: this.redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) }], isError: false } }
    } catch (error) {
      // a cancelled call gets no answer: the client stopped waiting for one
      if (controller.signal.aborted && message(controller.signal.reason) === CANCELLED) return null
      if (error instanceof ToolInputError) return this.error(id, INVALID_PARAMS, `${tool.name}: ${error.message}`)
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: this.redact(message(error)) }], isError: true } }
    } finally {
      if (id !== null) this.running.delete(id)
    }
  }
}

/** the JSON Schema the tools use: objects, strings, numbers, booleans, string arrays and string maps */
export interface Schema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array"
  description?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean | Schema
  items?: Schema
  enum?: string[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  minLength?: number
  default?: unknown
}

/** what is wrong with `value` by `schema`, or null */
export function validate(schema: Schema, value: unknown, path = ""): string | null {
  const at = path || "arguments"
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`
      const record = value as Record<string, unknown>
      const child = (name: string) => (path ? `${path}.${name}` : name)
      for (const name of schema.required ?? []) if (record[name] === undefined || record[name] === null) return `${child(name)} is required`
      for (const [name, field] of Object.entries(record)) {
        if (field === undefined) continue
        const property = schema.properties?.[name] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined)
        if (!property) return `${child(name)} is not a known argument`
        const problem = validate(property, field, child(name))
        if (problem) return problem
      }
      return null
    }
    case "string":
      if (typeof value !== "string") return `${at} must be a string`
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(", ")}`
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} must not be empty`
      return null
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return `${at} must be ${schema.type === "integer" ? "a whole number" : "a number"}`
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`
      return null
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} takes at most ${schema.maxItems} items`
      for (const [index, item] of value.entries()) {
        const problem = schema.items ? validate(schema.items, item, `${at}[${index}]`) : null
        if (problem) return problem
      }
      return null
    }
  }
}

/** what holds stderr back until a line is whole, so a credential written in pieces is still redacted whole */
const STDERR_HOLD = 64 * 1024

export interface Guard {
  /** writes one frame to the real stdout */
  send: (text: string) => Promise<void>
  /** writes out what stderr still holds (a last line without its newline) */
  flush: () => void
}

/**
 * From here on stdout is the transport's alone: process.stdout.write and every console method go to stderr,
 * so nothing a library prints can corrupt a frame. stderr is written a whole line at a time, through `clean`.
 */
export function guardStdout(clean: (text: string) => string = (text) => text): Guard {
  const write = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr) as (chunk: string) => boolean
  let held = ""
  /** the rest of a line that was too long is dropped too, up to its newline */
  let dropping = false
  const flushLines = (all: boolean) => {
    const end = all ? held.length : held.lastIndexOf("\n") + 1
    if (end <= 0) return
    stderr(clean(held.slice(0, end)))
    held = held.slice(end)
  }
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    let text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk)
    if (dropping) {
      const newline = text.indexOf("\n")
      text = newline === -1 ? "" : text.slice(newline + 1)
      dropping = newline === -1
    }
    held += text
    flushLines(false)
    // a line this long: all of it is left out, since a credential could straddle any cut of it
    if (held.length > STDERR_HOLD) {
      held = ""
      dropping = true
      stderr("[kyora] (a line over 64 KB was left out)\n")
    }
    const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write
  process.stdout.write = ((...args: unknown[]) => (process.stderr.write as (...args: unknown[]) => boolean)(...args)) as typeof process.stdout.write
  // a console of its own on stderr, for every method: Bun's own write to the file descriptors directly
  const replacement = new Console({ stdout: process.stderr, stderr: process.stderr }) as unknown as Record<string, unknown>
  const native = console as unknown as Record<string, unknown>
  for (const method of new Set([...Object.keys(native), ...Object.getOwnPropertyNames(native), "write"])) {
    if (method === "Console" || typeof native[method] !== "function") continue
    const own = replacement[method]
    // Bun's own extras (console.write, …): their arguments, as text, on stderr
    native[method] = typeof own === "function" ? own.bind(replacement) : (...args: unknown[]) => {
      process.stderr.write(method === "write" ? args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Uint8Array ? new TextDecoder().decode(arg) : String(arg))).join("") : `${format(...args)}\n`)
      return 0
    }
  }
  return {
    send: (text) => new Promise((resolve) => {
      try {
        write(text, () => resolve())
      } catch {
        resolve()
      }
    }),
    flush: () => flushLines(true),
  }
}

/** the most shutdown waits for calls to finish cleaning up (destroying their VMs) */
const SHUTDOWN_MS = 30_000
/** with a create still unanswered: past its own timeout (120 s), so the VM it makes is destroyed */
const SHUTDOWN_CREATING_MS = 150_000

/** serves until the client closes stdin (or SIGTERM, SIGINT), then cancels the calls still running and lets them clean up */
export async function mcpMain(): Promise<number> {
  const { send, flush } = guardStdout((text) => redact(text))
  const server = new McpServer({ tools: kyoraTools(), context: (signal) => toolContext(signal), secrets: () => knownSecrets() })
  let writing = Promise.resolve()
  const reply = (messages: Array<Frame | Frame[]>) => {
    for (const message of messages) writing = writing.then(() => send(`${JSON.stringify(message)}\n`))
  }
  let signalled!: () => void
  const signal = new Promise<void>((resolve) => (signalled = resolve))
  process.on("SIGTERM", signalled)
  process.on("SIGINT", signalled)
  note(`kyora ${VERSION}: MCP server on stdio`)
  const handling = new Set<Promise<void>>()
  const take = (line: string) => {
    const handled: Promise<void> = server.line(line).then(reply, (error) => note(`mcp: ${message(error)}`)).finally(() => handling.delete(handled))
    handling.add(handled)
  }
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let open = true
  const ended = (async () => {
    let buffer = ""
    while (open) {
      const { done, value } = await reader.read()
      if (done || !open) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while (open && (newline = buffer.indexOf("\n")) !== -1) {
        take(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
    }
    if (open && buffer.trim()) take(buffer)
  })().catch(() => {})
  await Promise.race([ended, signal])
  // no new work from here on
  open = false
  reader.cancel().catch(() => {})
  const wait = createsInFlight() > 0 ? SHUTDOWN_CREATING_MS : SHUTDOWN_MS
  const deadline = Date.now() + wait
  await server.shutdown("the MCP client went away", wait)
  const left = () => Bun.sleep(Math.max(0, deadline - Date.now()))
  await Promise.race([Promise.allSettled([...handling]), left()])
  await Promise.race([writing, Bun.sleep(5_000)])
  flush()
  process.off("SIGTERM", signalled)
  process.off("SIGINT", signalled)
  return 0
}
