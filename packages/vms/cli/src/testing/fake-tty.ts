import type { Server, ServerWebSocket } from "bun"

/**
 * Terminals as kyora-vmd serves them (and its framing), for the fake
 * kyora-vmd and kyora cloud alike (their paths are the same): `GET …/tty` a WebSocket, `…/tty/sessions`
 * the sessions API. A session keeps its "screen" (everything it printed); an attach says nothing
 * until the client's first message, then `opened` and the screen redrawn (a clear, then all of it).
 * Keys come back as output. `exit\r` ends the session, `\x02d` (tmux's C-b d) detaches the client.
 * `cut()` drops every terminal's connection; `silence()` leaves them open with nothing more from the
 * "machine" (a relay whose machine side is gone). Sizes are checked as kyora-vmd checks them (1-1000).
 */

export interface FakeTtySession {
  sandbox: string
  name: string
  screen: string
  windows: number
  /** each window's command, as POST …/tty/sessions asked for it */
  commands: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string> }>
}

export interface FakeTtyAttach {
  sandbox: string
  name: string
  cols: number
  rows: number
  control: boolean
  term: string
}

/** what a client sent on one attach (by its index in `attaches`) */
export interface FakeTtyMessage {
  attach: number
  kind: number
  /** a control message's JSON, else the bytes as text */
  control?: Record<string, unknown>
  text?: string
}

interface Socket {
  attach: number
  started: boolean
  silent: boolean
  /** silent, but a relay in between keeps sending its own, unmarked keepalives */
  plainPings: boolean
  seq: number
  keepalive: ReturnType<typeof setInterval> | undefined
}

export interface FakeTty {
  sessions: Map<string, FakeTtySession>
  attaches: FakeTtyAttach[]
  messages: FakeTtyMessage[]
  /** the most attaches open at once (a client must close the old one before it opens another) */
  maxOpen: number
  readonly open: number
  /** answer every terminal request 503 (a machine that is restarting) */
  refuse: boolean
  /** answer the terminal's own route with this (kyora-vmd's refusal), WebSocket or plain request */
  refuseAttach: { status: number; error: string; message: string } | null
  /** the terminal's upgrade waits this long (the guest attaching) */
  upgradeDelayMs: number
  /** the terminal's route never answers (the network went), until `hang` is off again */
  hang: boolean
  cut(): number
  /** with `plainPings`, a relay keeps the connection busy with keepalives that aren't the machine's */
  silence(plainPings?: boolean): number
  /** output from the sandbox on every terminal attached to `name` */
  print(name: string, text: string): void
  /** a terminal route's answer; null once the request became a WebSocket */
  handle(request: Request, server: Server<unknown>, sandbox: string, rest: string): Response | Promise<Response | null> | null
  websocket: {
    open(ws: ServerWebSocket<unknown>): void
    message(ws: ServerWebSocket<unknown>, data: string | Buffer): void
    close(ws: ServerWebSocket<unknown>): void
  }
  stop(): void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
/** columns and rows at most, as kyora-vmd takes them */
const MAX_SIZE = 1000
const inRange = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SIZE

export function fakeTty(options: { keepaliveMs?: number } = {}): FakeTty {
  const sockets = new Map<ServerWebSocket<unknown>, Socket>()
  const keyOf = (sandbox: string, name: string) => `${sandbox}/${name}`
  const send = (ws: ServerWebSocket<unknown>, kind: number, payload: string | Record<string, unknown>) => {
    const bytes = encoder.encode(typeof payload === "string" ? payload : JSON.stringify(payload))
    const message = new Uint8Array(bytes.byteLength + 1)
    message[0] = kind
    message.set(bytes, 1)
    ws.send(message)
  }

  const tty: FakeTty = {
    sessions: new Map(),
    attaches: [],
    messages: [],
    maxOpen: 0,
    refuse: false,
    refuseAttach: null,
    upgradeDelayMs: 0,
    hang: false,
    get open() {
      return sockets.size
    },
    cut() {
      const open = [...sockets.keys()]
      for (const ws of open) ws.terminate()
      return open.length
    },
    silence(plainPings = false) {
      for (const socket of sockets.values()) {
        socket.silent = true
        socket.plainPings = plainPings
      }
      return sockets.size
    },
    print(name, text) {
      for (const [ws, socket] of sockets) {
        const attach = tty.attaches[socket.attach]!
        if (attach.name !== name || socket.silent) continue
        const session = tty.sessions.get(keyOf(attach.sandbox, name))
        if (session) session.screen += text
        send(ws, 0, text)
      }
    },
    handle(request, server, sandbox, rest) {
      const url = new URL(request.url)
      if (tty.refuse) return Response.json({ error: "node_offline", message: "the sandbox's machine is not connected" }, { status: 503 })
      if (rest === "/tty") {
        if (tty.hang)
          return (async () => {
            while (tty.hang) await Bun.sleep(20)
            return Response.json({ error: "unavailable", message: "too late" }, { status: 503 })
          })()
        if (request.method !== "GET") return Response.json({ error: "method_not_allowed", message: "use GET" }, { status: 405 })
        const name = url.searchParams.get("name") ?? "main"
        if (!NAME.test(name)) return Response.json({ error: "invalid_request", message: "bad name" }, { status: 400 })
        const cols = Number(url.searchParams.get("cols"))
        const rows = Number(url.searchParams.get("rows"))
        for (const [what, value] of [["cols", cols], ["rows", rows]] as const) {
          if (!inRange(value)) return Response.json({ error: "invalid_request", message: `${what} must be a whole number from 1 to ${MAX_SIZE}` }, { status: 400 })
        }
        // every refusal comes before the upgrade's check, so a plain request reads it (as from kyora-vmd)
        const refusal = tty.refuseAttach
        if (refusal) return Response.json({ error: refusal.error, message: refusal.message }, { status: refusal.status })
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "upgrade_required", message: "a terminal is a WebSocket" }, { status: 426 })
        const upgrade = (): Response | null => {
          const attach: FakeTtyAttach = { sandbox, name, cols, rows, control: url.searchParams.get("control") === "1", term: url.searchParams.get("term") ?? "" }
          tty.attaches.push(attach)
          if (server.upgrade(request, { data: { tty: tty.attaches.length - 1 } })) return null
          return Response.json({ error: "invalid_request", message: "upgrade failed" }, { status: 400 })
        }
        return tty.upgradeDelayMs > 0 ? Bun.sleep(tty.upgradeDelayMs).then(upgrade) : upgrade()
      }
      if (rest === "/tty/sessions") {
        if (request.method === "GET") {
          const sessions = [...tty.sessions.values()]
            .filter((session) => session.sandbox === sandbox)
            .map((session) => ({ name: session.name, windows: session.windows, attached: [...sockets.values()].filter((socket) => tty.attaches[socket.attach]!.name === session.name).length, createdAt: 0, activityAt: Date.now(), busy: session.commands.length > 0, running: session.commands.map((window) => window.cmd[0]!) }))
          return Response.json({ sessions })
        }
        if (request.method === "POST") {
          return request.json().then((body) => {
            const { name = "main", cmd, cwd, env } = body as { name?: string; cmd?: string[]; cwd?: string; env?: Record<string, string> }
            const key = keyOf(sandbox, name)
            const existing = tty.sessions.get(key)
            const session = existing ?? { sandbox, name, screen: "", windows: 0, commands: [] }
            session.windows += 1
            if (cmd) {
              session.commands.push({ cmd, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) })
              session.screen += `[window: ${cmd.join(" ")}]\r\n`
            }
            tty.sessions.set(key, session)
            return Response.json({ name, created: !existing, window: `@${session.windows}` }, { status: existing ? 200 : 201 })
          })
        }
        return Response.json({ error: "method_not_allowed", message: "use GET or POST" }, { status: 405 })
      }
      const kill = /^\/tty\/sessions\/([^/]+)$/.exec(rest)
      if (kill && request.method === "DELETE") {
        const name = decodeURIComponent(kill[1]!)
        if (!NAME.test(name)) return Response.json({ error: "invalid_request", message: "bad name" }, { status: 400 })
        if (!tty.sessions.delete(keyOf(sandbox, name))) return Response.json({ error: "session_not_found", message: `no session ${name}` }, { status: 404 })
        for (const [ws, socket] of sockets) {
          if (tty.attaches[socket.attach]!.name !== name) continue
          send(ws, 1, { type: "exit", from: "machine", reason: "ended" })
          ws.close(1000, "the session ended")
        }
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: "not_found", message: "no such route" }, { status: 404 })
    },
    websocket: {
      open(ws) {
        const attach = (ws.data as { tty: number }).tty
        const socket: Socket = { attach, started: false, silent: false, plainPings: false, seq: 0, keepalive: undefined }
        sockets.set(ws, socket)
        tty.maxOpen = Math.max(tty.maxOpen, sockets.size)
        socket.keepalive = setInterval(() => {
          if (socket.plainPings) send(ws, 1, { type: "ping" })
          else if (socket.started && !socket.silent) send(ws, 1, { type: "ping", from: "machine", seq: ++socket.seq })
        }, options.keepaliveMs ?? 15_000)
      },
      message(ws, data) {
        const socket = sockets.get(ws)
        if (!socket) return
        const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
        const attach = tty.attaches[socket.attach]!
        const kind = bytes[0]!
        if (kind === 1) {
          const control = JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>
          tty.messages.push({ attach: socket.attach, kind, control })
          // kyora-vmd ends a stream whose client asks for a size it doesn't take
          if (control.type === "resize" && (!inRange(control.cols) || !inRange(control.rows))) return ws.close(1008, "a resize out of range")
        } else tty.messages.push({ attach: socket.attach, kind, text: decoder.decode(bytes.subarray(1)) })
        if (socket.silent) return
        const key = keyOf(attach.sandbox, attach.name)
        if (!socket.started) {
          socket.started = true
          const existing = tty.sessions.get(key)
          const session = existing ?? { sandbox: attach.sandbox, name: attach.name, screen: "", windows: 1, commands: [] }
          tty.sessions.set(key, session)
          send(ws, 1, { type: "opened", from: "machine", name: attach.name, created: !existing, control: attach.control, cols: attach.cols, rows: attach.rows, keepaliveMs: options.keepaliveMs ?? 15_000, windowBytes: 256 * 1024 })
          // tmux's redraw: the whole screen
          send(ws, 0, `\x1b[H\x1b[2J${session.screen}`)
        }
        if (kind !== 0 || !attach.control) return
        const text = decoder.decode(bytes.subarray(1))
        const session = tty.sessions.get(key)!
        if (text.includes("\x02d")) {
          send(ws, 0, "[detached (from session main)]\r\n")
          send(ws, 1, { type: "exit", from: "machine", reason: "detached" })
          ws.close(1000, "the session detached this client")
          return
        }
        session.screen += text
        send(ws, 0, text)
        if (text.includes("exit\r")) {
          tty.sessions.delete(key)
          send(ws, 0, "[exited]\r\n")
          send(ws, 1, { type: "exit", from: "machine", reason: "ended" })
          ws.close(1000, "the session ended")
        }
      },
      close(ws) {
        const socket = sockets.get(ws)
        clearInterval(socket?.keepalive)
        sockets.delete(ws)
      },
    },
    stop() {
      tty.hang = false
      for (const socket of sockets.values()) clearInterval(socket.keepalive)
    },
  }
  return tty
}
