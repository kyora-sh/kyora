import { ApiError, type TtySession, type VmsClient } from "./api"
import { sandboxArgument } from "./names"
import { reattachable, reattachPolicy } from "./exec"
import { pause } from "./multipart"
import { FAILED, printJson } from "./output"
import { formatMs } from "./units"

/**
 * `kyora vms shell <id>`: a terminal in the sandbox, a tmux session that lives
 * in the guest. The local terminal goes raw and talks to it over a WebSocket (kyora-vmd's terminal
 * framing: binary messages, the first byte 0 for the terminal's bytes and 1 for JSON control), its
 * size follows SIGWINCH, and the session outlives the connection: a dropped one is attached again,
 * with backoff, and tmux redraws the screen. `~.` after Enter detaches, as in ssh; tmux's own C-b d
 * does too, and so does a signal (SIGTERM, SIGHUP, SIGINT, SIGQUIT from outside: in raw mode the
 * keys send none). Whatever ends it, the terminal is put back the way it was.
 */

export const TTY_DATA = 0
export const TTY_CONTROL = 1
/** the most columns and rows a server takes (kyora-vmd, kyora cloud and the guest agent alike) */
export const TTY_MAX_SIZE = 1000

/** a signal from outside: each detaches, and the exit code is 128 + its number, as a shell's would be */
export type TerminalSignal = "SIGTERM" | "SIGHUP" | "SIGINT" | "SIGQUIT"
export const SIGNAL_EXIT: Record<TerminalSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }

/** the local terminal, as the shell uses it (processIo() is the real one; tests bring a fake) */
export interface TerminalIo {
  readonly isTTY: boolean
  /** the local $TERM, passed on (the guest falls back to xterm-256color if it doesn't know it) */
  readonly term: string
  size(): { cols: number; rows: number }
  setRaw(on: boolean): void
  onKeys(listener: (data: Uint8Array) => void): () => void
  onResize(listener: () => void): () => void
  /** resolves once the terminal took it: output is acked only then */
  write(data: Uint8Array | string): Promise<void>
  /** a line of kyora's own, on stderr */
  status(text: string): void
  onSignal(listener: (signal: TerminalSignal) => void): () => void
}

export interface ShellOptions {
  sandboxName?: string
  name: string
  /** keys reach the session (the default); false watches it */
  control: boolean
  /** run this in a new window of the session (once: a reattach doesn't run it again) */
  cmd?: string[]
  cwd?: string
  env?: Record<string, string>
  /** OSC 52 from the sandbox reaches the local terminal (it sets its clipboard); off, it is taken out */
  clipboard?: boolean
  io?: TerminalIo
  /** nothing from the machine itself this long is a dead connection (kyora-vmd's keepalive comes every 15 s) */
  machineSilentMs?: number
  /** the client's keepalive */
  pingEveryMs?: number
  /** a connection that hasn't said `opened` by then is a broken one */
  openMs?: number
  /** how long reattaching goes on after a break with no progress (KYORA_VMS_REATTACH_WINDOW_MS, as for exec) */
  reconnectForMs?: number
  /** the first wait, doubled up to backoffMaxMs (KYORA_VMS_REATTACH_BASE_MS) */
  backoffBaseMs?: number
  backoffMaxMs?: number
}

const MACHINE_SILENT_MS = 45_000
const PING_EVERY_MS = 20_000
const OPEN_MS = 30_000
/** refusals that attaching again won't change: the request, the key, the sandbox, a machine without terminals */
const FINAL = [400, 401, 403, 404, 501]
/** acks go out after this much output (kyora-vmd's window is 256 KiB), or shortly after the last of it */
const ACK_BYTES = 32 * 1024
const ACK_DELAY_MS = 20
/** keys go up in messages this big at most (kyora-vmd takes 64 KiB) */
const MAX_KEYS = 32 * 1024
/** what tmux may have left switched on in a terminal it didn't get to put back: alternate screen, mouse, paste, focus, keypad, cursor */
export const TERMINAL_RESET = "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b>\x1b[?25h\x1b[0m\r\n"
const HELP = "escapes, after Enter: ~. detach (the session keeps running) · ~~ a ~ · ~? this"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** the local terminal's size, as much of it as a server takes */
export function serverSize(size: { cols: number; rows: number }): { cols: number; rows: number } {
  const clamp = (value: number) => Math.min(TTY_MAX_SIZE, Math.max(1, Math.floor(value) || 1))
  return { cols: clamp(size.cols), rows: clamp(size.rows) }
}

const ESC = 0x1b
const BEL = 0x07
/** `ESC ] 52 ;`: OSC 52, a clipboard write */
const OSC52 = [ESC, 0x5d, 0x35, 0x32, 0x3b]

/**
 * OSC 52 (`ESC ] 52 ; … BEL`, or `… ESC \`) sets the clipboard of the terminal it reaches: what runs in
 * the sandbox (or tmux, for anyone attached) would write yours. Unless --clipboard lets them through,
 * they are taken out of the output, also when one is split across messages; everything else passes
 * byte for byte. A sequence ends where a terminal would end it: BEL, ST, CAN or SUB, or an ESC that
 * starts something else. One filter per connection: a reattach starts with tmux's redraw.
 */
export class ClipboardFilter {
  /** how much of OSC52 matched so far (held back until it is known), or -1 inside one, -2 at an ESC inside one */
  private state = 0

  push(chunk: Uint8Array): Uint8Array {
    if (this.state === 0 && chunk.indexOf(ESC) === -1) return chunk
    const out = new Uint8Array(chunk.byteLength + OSC52.length)
    let at = 0
    for (let i = 0; i < chunk.byteLength; i++) {
      const byte = chunk[i]!
      if (this.state === -1) {
        if (byte === BEL || byte === 0x18 || byte === 0x1a) this.state = 0
        else if (byte === ESC) this.state = -2
        continue
      }
      if (this.state === -2) {
        this.state = 0
        // ST ends it; any other ESC sequence ends it too, and is one of its own
        if (byte === 0x5c) continue
        this.state = 1
      }
      if (this.state > 0) {
        if (byte === OSC52[this.state]) {
          this.state += 1
          if (this.state === OSC52.length) this.state = -1
          continue
        }
        // not one: what was held goes out after all
        out.set(OSC52.slice(0, this.state), at)
        at += this.state
        this.state = 0
      }
      if (byte === ESC) this.state = 1
      else out[at++] = byte
    }
    return out.subarray(0, at)
  }
}

/** ssh's escapes: `~` right after a newline (or first thing) starts one */
export class Escapes {
  private atLineStart = true
  private tilde = false

  /** keys in; what goes to the session, and whether they asked to detach (or for help) */
  push(data: Uint8Array): { send: Uint8Array; detach: boolean; help: boolean } {
    const out: number[] = []
    let detach = false
    let help = false
    for (const byte of data) {
      if (this.tilde) {
        this.tilde = false
        if (byte === 0x2e) {
          detach = true
          break
        }
        if (byte === 0x3f) {
          help = true
          continue
        }
        // `~~` is one `~`; `~` and anything else is both
        out.push(0x7e)
        if (byte === 0x7e) {
          this.atLineStart = false
          continue
        }
      } else if (byte === 0x7e && this.atLineStart) {
        this.tilde = true
        continue
      }
      out.push(byte)
      this.atLineStart = byte === 0x0d || byte === 0x0a
    }
    return { send: Uint8Array.from(out), detach, help }
  }
}

export function processIo(): TerminalIo {
  const stdin = process.stdin
  const stdout = process.stdout
  let raw = false
  // whatever ends the process, the terminal goes back to how it was
  const restore = () => {
    if (raw && stdin.isTTY) stdin.setRawMode(false)
  }
  process.once("exit", restore)
  return {
    isTTY: Boolean(stdin.isTTY && stdout.isTTY),
    term: process.env.TERM || "xterm-256color",
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    setRaw(on) {
      if (!stdin.isTTY) return
      stdin.setRawMode(on)
      raw = on
      if (on) {
        // Bun's (and libuv's) raw mode leaves output processing on: a newline from tmux would also
        // return the cursor to the first column, and full-screen programs draw in the wrong place.
        // Raw as ssh makes it: no output processing either. Raw mode off puts the terminal's own back.
        try {
          Bun.spawnSync(["stty", "-opost"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" })
        } catch {
          // no stty: newlines also return the cursor, the rest works
        }
        stdin.resume()
      } else stdin.pause()
    },
    onKeys(listener) {
      const handler = (chunk: Buffer | string) => listener(typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk))
      stdin.on("data", handler)
      return () => stdin.off("data", handler)
    },
    onResize(listener) {
      stdout.on("resize", listener)
      process.on("SIGWINCH", listener)
      return () => {
        stdout.off("resize", listener)
        process.off("SIGWINCH", listener)
      }
    },
    write: (data) =>
      new Promise((resolve) => {
        try {
          stdout.write(data, () => resolve())
        } catch {
          resolve()
        }
      }),
    status: (text) => process.stderr.write(`\r\n[kyora-vms] ${text}\r\n`),
    onSignal(listener) {
      // raw mode sends no signal from the keys: these come from outside (kill, a closed terminal)
      const handlers = (Object.keys(SIGNAL_EXIT) as TerminalSignal[]).map((signal) => [signal, () => listener(signal)] as const)
      for (const [signal, handler] of handlers) process.on(signal, handler)
      return () => {
        for (const [signal, handler] of handlers) process.off(signal, handler)
      }
    },
  }
}

/** how an attach ended; a break says whether its WebSocket was taken at all, and whether the session opened on it */
type Outcome = { kind: "exit"; reason: string } | { kind: "detach" } | { kind: "break"; why: string; upgraded: boolean; opened: boolean }

interface Connection {
  ws: WebSocket
  opened: boolean
  send(kind: number, payload: Uint8Array): void
  end(): void
}

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1)
  out[0] = kind
  out.set(payload, 1)
  return out
}

const control = (event: Record<string, unknown>) => frame(TTY_CONTROL, encoder.encode(JSON.stringify(event)))

class Shell {
  private readonly io: TerminalIo
  private readonly escapes = new Escapes()
  /** the attach in progress, from its WebSocket's first moment (a detach ends it, open or not) */
  private current: Connection | null = null
  private detaching = false
  /** aborted by a detach: the waits and requests between attaches end with it */
  private readonly leaving = new AbortController()
  /** a session was attached at least once in this run */
  private everOpened = false
  signalled: number | null = null

  constructor(
    private readonly api: VmsClient,
    private readonly id: string,
    private readonly options: ShellOptions,
  ) {
    this.io = options.io!
  }

  /** ~., a signal: let go of the session (it keeps running), whatever the attach is doing */
  detach(): void {
    this.detaching = true
    this.current?.end()
    this.leaving.abort(new Error("detached"))
  }

  keys(data: Uint8Array): void {
    const { send, detach, help } = this.escapes.push(data)
    if (help) this.io.status(HELP)
    const connection = this.current
    // view only, keys never leave this machine; while reconnecting, they are dropped (as over ssh)
    if (send.byteLength > 0 && this.options.control && connection?.opened) {
      for (let at = 0; at < send.byteLength; at += MAX_KEYS) connection.send(TTY_DATA, send.subarray(at, at + MAX_KEYS))
    }
    if (detach) this.detach()
  }

  /** the local terminal's size, as the server takes it (a wider one is cut to TTY_MAX_SIZE) */
  private size(): { cols: number; rows: number } {
    return serverSize(this.io.size())
  }

  resized(): void {
    const connection = this.current
    if (connection?.opened) connection.send(TTY_CONTROL, encoder.encode(JSON.stringify({ type: "resize", ...this.size() })))
  }

  private query(size: { cols: number; rows: number }) {
    return { name: this.options.name, ...size, control: this.options.control, term: this.io.term }
  }

  /** one attach, from the WebSocket to its end */
  private connect(deadline?: number): Promise<Outcome> {
    const options = this.options
    const size = this.size()
    const ws = this.api.ttySocket(this.id, this.query(size))
    const started = Date.now()
    const clipboard = options.clipboard ? null : new ClipboardFilter()
    return new Promise<Outcome>((resolve) => {
      let done = false
      let upgraded = false
      let exit: string | null = null
      let received = 0
      let acked = 0
      let lastSeq = 0
      let lastMachine = Date.now()
      let writing: Promise<void> = Promise.resolve()
      let ackTimer: ReturnType<typeof setTimeout> | undefined
      const connection: Connection = {
        ws,
        opened: false,
        send: (kind, payload) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame(kind, payload))
        },
        end: () => {
          try {
            ws.close(1000, "detached")
          } catch {
            // closed already
          }
          settle()
        },
      }
      const ack = () => {
        clearTimeout(ackTimer)
        ackTimer = undefined
        if (received > acked && ws.readyState === WebSocket.OPEN) {
          acked = received
          ws.send(control({ type: "ack", bytes: received }))
        }
      }
      const settle = () => {
        if (done) return
        done = true
        clearInterval(watchdog)
        clearInterval(pinger)
        clearTimeout(ackTimer)
        if (this.current === connection) this.current = null
        // what came before the end is written out first
        void writing.then(() =>
          resolve(exit !== null ? { kind: "exit", reason: exit } : this.detaching ? { kind: "detach" } : { kind: "break", why: closedWhy, upgraded, opened: connection.opened }),
        )
      }
      let closedWhy = "the connection closed"
      const broken = (why: string) => {
        closedWhy = why
        const terminate = (ws as unknown as { terminate?: () => void }).terminate
        try {
          if (terminate) terminate.call(ws)
          else ws.close()
        } catch {
          // gone
        }
        settle()
      }
      const watchdog = setInterval(() => {
        const now = Date.now()
        if (this.detaching) connection.end()
        else if (!connection.opened && (now - started > (options.openMs ?? OPEN_MS) || (deadline !== undefined && now >= deadline))) broken("the terminal did not open")
        else if (connection.opened && now - lastMachine > (options.machineSilentMs ?? MACHINE_SILENT_MS)) broken(`nothing from the sandbox's machine for ${formatMs(options.machineSilentMs ?? MACHINE_SILENT_MS)}`)
      }, Math.min(1_000, Math.max(10, Math.floor((options.machineSilentMs ?? MACHINE_SILENT_MS) / 4))))
      const pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(control({ type: "ping" }))
      }, options.pingEveryMs ?? PING_EVERY_MS)
      // a detach from here on ends this attach, connecting or not
      this.current = connection
      ws.addEventListener("open", () => {
        upgraded = true
        // detached while it connected: it never gets to be an attach
        if (done || this.detaching) return connection.end()
        // the first word: the stream starts when the client is there, at its size
        ws.send(control({ type: "resize", ...this.size() }))
      })
      ws.addEventListener("message", (event) => {
        if (done) return
        const data = (event as MessageEvent).data
        if (typeof data === "string") return broken("the server sent text on a terminal")
        const bytes = new Uint8Array(data as ArrayBuffer)
        if (bytes[0] === TTY_DATA) {
          lastMachine = Date.now()
          const payload = bytes.subarray(1)
          const shown = clipboard ? clipboard.push(payload) : payload
          writing = writing.then(async () => {
            if (shown.byteLength > 0) await this.io.write(shown)
            // acked as received: what was taken out was taken in
            received += payload.byteLength
            if (received - acked >= ACK_BYTES) ack()
            else ackTimer ??= setTimeout(ack, ACK_DELAY_MS)
          })
          return
        }
        if (bytes[0] !== TTY_CONTROL) return
        let event_: Record<string, unknown>
        try {
          event_ = JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>
        } catch {
          return
        }
        // only the machine's own lines say it is there: a relay's would not be marked, nor numbered on
        if (event_.from !== "machine") return
        if (event_.type === "ping") {
          if (typeof event_.seq === "number" && event_.seq > lastSeq) {
            lastSeq = event_.seq
            lastMachine = Date.now()
          }
          return
        }
        lastMachine = Date.now()
        if (event_.type === "opened") {
          connection.opened = true
          this.everOpened = true
          // the size may have changed while it opened
          const now = this.size()
          if (now.cols !== size.cols || now.rows !== size.rows) this.resized()
        } else if (event_.type === "exit") exit = typeof event_.reason === "string" ? event_.reason : "ended"
      })
      ws.addEventListener("close", (event) => {
        if (!done) closedWhy = (event as CloseEvent).reason || `the connection closed (${(event as CloseEvent).code})`
        settle()
      })
      ws.addEventListener("error", () => {
        if (!done && !connection.opened) closedWhy = "the terminal's connection failed"
      })
    })
  }

  /** where it stands before attaching again: null to go on, or the code to end with */
  private async check(signal = this.leaving.signal): Promise<number | null> {
    let sessions: TtySession[]
    try {
      sessions = await this.api.ttySessions(this.id, signal)
    } catch (error) {
      if (this.detaching) return null
      if (error instanceof ApiError && FINAL.includes(error.status) && !reattachable(error)) {
        this.io.status(error.message)
        return FAILED
      }
      return null
    }
    if (this.everOpened && !sessions.some((session) => session.name === this.options.name)) {
      this.io.status(`the session ${this.options.name} ended while this was disconnected`)
      return 0
    }
    return null
  }

  /**
   * A WebSocket the server didn't take says nothing of why: the server is asked plainly. A refusal
   * attaching again won't change ends it with the server's reason; a transient refusal keeps
   * the retry episode going. Null: go on.
   */
  private async refused(signal = this.leaving.signal): Promise<number | null> {
    const refusal = await this.api.ttyRefusal(this.id, this.query(this.size()), signal)
    if (!refusal || this.detaching) return null
    if (FINAL.includes(refusal.status) && !reattachable(refusal)) {
      this.io.status(`${refusal.message} (${refusal.status})`)
      return FAILED
    }
    return null
  }

  async run(): Promise<number> {
    const options = this.options
    const policy = reattachPolicy()
    const windowMs = options.reconnectForMs ?? policy.windowMs
    const base = options.backoffBaseMs ?? policy.baseDelayMs
    const max = options.backoffMaxMs ?? Math.max(base, policy.maxDelayMs)
    let delay = base
    // when this break began, and what it was: progress (an attach that opened) starts a new one
    let since: number | null = null
    let why = ""
    const gaveUp = async () => {
      await this.io.write(TERMINAL_RESET)
      this.io.status(`gave up reattaching after ${formatMs(windowMs)} (${why}); the session keeps running: ${this.again()}`)
      return FAILED
    }
    if (!options.control) this.io.status(`view only: keys go nowhere; ~. after Enter leaves`)
    for (;;) {
      if (this.detaching) return this.detached()
      // no attempt starts past the deadline
      if (since !== null && Date.now() - since >= windowMs) return gaveUp()
      let outcome: Outcome
      try {
        outcome = await this.connect(since === null ? undefined : since + windowMs)
      } catch (error) {
        if (!reattachable(error)) throw error
        outcome = { kind: "break", why: error instanceof Error ? error.message : String(error), opened: false, upgraded: false }
      }
      if (outcome.kind === "exit") {
        if (outcome.reason === "detached") this.detachHint()
        return 0
      }
      if (outcome.kind === "detach") return this.detached()
      why = outcome.why
      if (outcome.opened) {
        since = null
        delay = base
      } else if (!outcome.upgraded) {
        if (since !== null && Date.now() - since >= windowMs) return gaveUp()
        const signal = since === null ? this.leaving.signal : AbortSignal.any([this.leaving.signal, AbortSignal.timeout(Math.max(1, since + windowMs - Date.now()))])
        const ended = await this.refused(signal)
        if (ended !== null) {
          await this.io.write(TERMINAL_RESET)
          return ended
        }
        if (this.detaching) return this.detached()
      }
      if (since === null) {
        since = Date.now()
        this.io.status("reconnecting…")
      }
      if (Date.now() - since > windowMs) return gaveUp()
      await pause(Math.min(delay, Math.max(0, since + windowMs - Date.now())), this.leaving.signal).catch(() => {})
      delay = Math.min(delay * 2, max)
      if (this.detaching) return this.detached()
      if (Date.now() - since >= windowMs) return gaveUp()
      const signal = AbortSignal.any([this.leaving.signal, AbortSignal.timeout(Math.max(1, since + windowMs - Date.now()))])
      const ended = await this.check(signal)
      if (ended !== null) {
        await this.io.write(TERMINAL_RESET)
        return ended
      }
    }
  }

  private again(): string {
    const label = this.options.sandboxName ?? this.id
    const session = this.options.name === "main" ? "" : ` --name ${this.options.name}`
    const target = label.startsWith("-") ? `${session} ${sandboxArgument(label)}` : ` ${label}${session}`
    return `kyora vms ${this.options.sandboxName && this.options.name === "main" ? "attach" : "shell"}${target}`
  }

  private detachHint(): void {
    this.io.status(this.options.sandboxName && this.options.name === "main"
      ? `back in: kyora vms attach ${sandboxArgument(this.options.sandboxName!)} · gone: kyora vms rm ${sandboxArgument(this.options.sandboxName!)}`
      : `detached from ${this.options.name}; it keeps running: ${this.again()}`)
  }

  private async detached(): Promise<number> {
    // tmux didn't get to put the terminal back: its client was let go of
    await this.io.write(TERMINAL_RESET)
    this.detachHint()
    return this.signalled ?? 0
  }
}

/** `kyora vms shell <id> [--name main] [--view] [-- cmd…]` */
export async function shell(api: VmsClient, id: string, options: ShellOptions): Promise<number> {
  const io = options.io ?? processIo()
  if (!io.isTTY) {
    io.status("shell needs a terminal: stdin and stdout aren't one (for a command, use kyora vms exec)")
    return FAILED
  }
  // the sandbox is there and has terminals: real answers, before the terminal goes raw
  await api.ttySessions(id)
  if (options.cmd) await api.ttyCreate(id, { name: options.name, cmd: options.cmd, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}), ...serverSize(io.size()) })
  const session = new Shell(api, id, { ...options, io })
  const stops = [
    io.onKeys((data) => session.keys(data)),
    io.onResize(() => session.resized()),
    io.onSignal((signal) => {
      session.signalled = SIGNAL_EXIT[signal]
      session.detach()
    }),
  ]
  io.setRaw(true)
  try {
    return await session.run()
  } finally {
    io.setRaw(false)
    for (const stop of stops) stop()
  }
}

/** `kyora vms shell <id> --list` */
export async function listSessions(api: VmsClient, id: string, json: boolean): Promise<number> {
  const sessions = await api.ttySessions(id)
  if (json) {
    printJson({ sessions })
    return 0
  }
  if (sessions.length === 0) {
    console.log(`no terminal sessions in ${id}; kyora vms shell ${id} starts one`)
    return 0
  }
  const rows = sessions.map((session) => [
    session.name,
    String(session.windows),
    session.attached > 0 ? `${session.attached} attached` : "detached",
    session.busy ? `running ${(session.running ?? []).join(", ") || "something"}` : "idle",
    typeof session.activityAt === "number" && session.activityAt > 0 ? `${formatMs(Math.max(0, Date.now() - session.activityAt))} ago` : "",
  ])
  const header = ["NAME", "WINDOWS", "CLIENTS", "STATE", "LAST OUTPUT"]
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)))
  for (const row of [header, ...rows]) console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
  return 0
}

/** `kyora vms shell <id> --kill <name>` */
export async function killSession(api: VmsClient, id: string, name: string, json: boolean): Promise<number> {
  await api.ttyKill(id, name)
  if (json) printJson({ killed: name })
  else console.log(`killed ${name} in ${id}`)
  return 0
}
