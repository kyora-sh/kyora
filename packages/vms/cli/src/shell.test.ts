import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { realpath, rm } from "node:fs/promises"
import { ApiError, VmsClient } from "./api"
import { ClipboardFilter, Escapes, shell, SIGNAL_EXIT, TERMINAL_RESET, type ShellOptions, type TerminalIo, type TerminalSignal } from "./shell"
import { KEY, startFakePlatform, startFakeVmd, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, ENTRY, platformEnv, tempDir, waitFor } from "./testing/fixtures"

setDefaultTimeout(30_000)

/** the local terminal: keys typed, sizes, signals; what was written and said; raw mode as it went */
class FakeTerminal implements TerminalIo {
  isTTY = true
  term = "xterm-256color"
  cols = 100
  rows = 30
  readonly raw: boolean[] = []
  output = ""
  readonly statuses: string[] = []
  private readonly keys = new Set<(data: Uint8Array) => void>()
  private readonly resizes = new Set<() => void>()
  private readonly signals = new Set<(signal: TerminalSignal) => void>()

  size() {
    return { cols: this.cols, rows: this.rows }
  }
  setRaw(on: boolean): void {
    this.raw.push(on)
  }
  onKeys(listener: (data: Uint8Array) => void) {
    this.keys.add(listener)
    return () => this.keys.delete(listener)
  }
  onResize(listener: () => void) {
    this.resizes.add(listener)
    return () => this.resizes.delete(listener)
  }
  onSignal(listener: (signal: TerminalSignal) => void) {
    this.signals.add(listener)
    return () => this.signals.delete(listener)
  }
  async write(data: Uint8Array | string): Promise<void> {
    this.output += typeof data === "string" ? data : new TextDecoder().decode(data)
  }
  status(text: string): void {
    this.statuses.push(text)
  }
  type(text: string): void {
    for (const listener of this.keys) listener(new TextEncoder().encode(text))
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    for (const listener of this.resizes) listener()
  }
  signal(name: TerminalSignal): void {
    for (const listener of this.signals) listener(name)
  }
  /** listeners still subscribed (all gone once the shell ended) */
  get listening(): number {
    return this.keys.size + this.resizes.size + this.signals.size
  }
}

const fast: Partial<ShellOptions> = { backoffBaseMs: 20, backoffMaxMs: 100, machineSilentMs: 600, pingEveryMs: 100 }

let vmd: FakeVmd | null = null
afterEach(async () => {
  await vmd?.stop()
  vmd = null
})

for (const kind of ["vmd", "platform"] as const) {
  async function setup(keepaliveMs = 100) {
    vmd = kind === "vmd" ? await startFakeVmd({ ttyKeepaliveMs: keepaliveMs }) : await startFakePlatform({ ttyKeepaliveMs: keepaliveMs })
    const api = new VmsClient({ url: vmd.url, key: kind === "vmd" ? KEY : TOKEN, keySource: "test", urlSource: "test", credentials: "/dev/null" })
    const { id } = await api.create({})
    const io = new FakeTerminal()
    const fake = vmd
    const run = (options: Partial<ShellOptions> = {}) => shell(api, id, { name: "main", control: true, io, ...fast, ...options })
    const sent = (kind_: number) => fake.tty.messages.filter((message) => message.kind === kind_)
    return { vmd: fake, api, id, io, run, sent }
  }

  describe(`kyora vms shell (${kind === "vmd" ? "kyora-vmd" : "kyora cloud"})`, () => {
    test("named main shell prints attach and remove hints after detaching", async () => {
      const { vmd, io, run } = await setup()
      const done = run({ sandboxName: "brisk-otter" })
      await waitFor(() => vmd.tty.attaches.length === 1, 5_000, "the attach")
      io.type("~.")
      expect(await done).toBe(0)
      expect(io.statuses.at(-1)).toBe("back in: kyora vms attach brisk-otter · gone: kyora vms rm brisk-otter")
      expect(io.raw.at(-1)).toBe(false)
    })

    test("raw mode, its size first, keys and output, acks, resizes; ~. detaches and puts the terminal back", async () => {
      const { vmd, io, run, sent } = await setup()
      const done = run()
      await waitFor(() => vmd.tty.attaches.length === 1, 5_000, "the attach")
      expect(vmd.tty.attaches[0]).toMatchObject({ name: "main", cols: 100, rows: 30, control: true, term: "xterm-256color" })
      // the stream starts with the client's size; then the redraw
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the redraw")
      expect(vmd.tty.messages[0]).toEqual({ attach: 0, kind: 1, control: { type: "resize", cols: 100, rows: 30 } })
      expect(io.raw).toEqual([true])
      io.type("echo hi\r")
      await waitFor(() => io.output.includes("echo hi\r"), 5_000, "the echo")
      expect(sent(0).map((message) => message.text)).toEqual(["echo hi\r"])
      // what came in is acked, all of it
      const total = new TextEncoder().encode(io.output).byteLength
      await waitFor(() => sent(1).some((message) => message.control!.type === "ack" && message.control!.bytes === total), 5_000, "the ack")
      // SIGWINCH: the new size goes up
      io.resize(132, 43)
      await waitFor(() => sent(1).some((message) => message.control!.type === "resize" && message.control!.cols === 132 && message.control!.rows === 43), 5_000, "the resize")
      // keepalives both ways
      await waitFor(() => sent(1).some((message) => message.control!.type === "ping"), 5_000, "the client's keepalive")
      // ~ mid-line is a ~; after Enter, ~~ is one; then ~. detaches
      io.type("a~b\r~~\r~.")
      expect(await done).toBe(0)
      await waitFor(() => sent(0).map((message) => message.text).join("") === "echo hi\ra~b\r~\r", 5_000, "the keys before the detach")
      expect(io.raw).toEqual([true, false])
      expect(io.output.endsWith(TERMINAL_RESET)).toBe(true)
      expect(io.statuses.at(-1)).toContain("detached from main; it keeps running")
      expect(io.listening).toBe(0)
      await waitFor(() => vmd.tty.open === 0, 5_000, "the connection to close")
      expect(vmd.tty.sessions.size).toBe(1)
    })

    test("a cut connection reattaches by itself, once said, and tmux redraws what was there", async () => {
      const { vmd, io, run, sent } = await setup()
      const done = run()
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the first attach")
      io.type("first-line\r")
      await waitFor(() => io.output.includes("first-line"), 5_000, "the echo")
      expect(vmd.tty.cut()).toBe(1)
      await waitFor(() => vmd.tty.attaches.length === 2 && io.output.split("\x1b[H\x1b[2J").length === 3, 5_000, "the reattach and its redraw")
      expect(io.statuses.filter((line) => line === "reconnecting…")).toHaveLength(1)
      // the redraw has the screen as it was
      expect(io.output.split("\x1b[H\x1b[2J").at(-1)).toContain("first-line")
      io.type("second-line\r")
      await waitFor(() => io.output.endsWith("second-line\r"), 5_000, "the echo after the reattach")
      // a new break is a new episode: said again
      vmd.tty.cut()
      await waitFor(() => vmd.tty.attaches.length === 3, 5_000, "the third attach")
      expect(io.statuses.filter((line) => line === "reconnecting…")).toHaveLength(2)
      io.type("\r~.")
      expect(await done).toBe(0)
      // never two at once, and every attach after the first is the same session at the same size
      expect(vmd.tty.maxOpen).toBe(1)
      expect(vmd.tty.attaches.map((attach) => [attach.name, attach.cols, attach.control])).toEqual([["main", 100, true], ["main", 100, true], ["main", 100, true]])
      await waitFor(() => sent(0).map((message) => message.text).join("") === "first-line\rsecond-line\r\r", 5_000, "the keys")
    })

    test("a connection the machine went quiet on is a break, whatever a relay keeps sending", async () => {
      const { vmd, io, run } = await setup()
      const done = run()
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      // the machine's keepalives stop; a relay goes on with plain ones of its own
      vmd.tty.silence(true)
      await waitFor(() => vmd.tty.attaches.length === 2, 5_000, "the reattach")
      expect(io.statuses).toContain("reconnecting…")
      io.type("\r~.")
      expect(await done).toBe(0)
    })

    test("the session ending, or tmux detaching the client, ends it: no reconnecting", async () => {
      const { vmd, io, run } = await setup()
      const ended = run()
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      io.type("exit\r")
      expect(await ended).toBe(0)
      expect(io.output).toContain("[exited]")
      expect(io.statuses).not.toContain("reconnecting…")
      expect(io.output.endsWith(TERMINAL_RESET)).toBe(false)
      const detached = run()
      await waitFor(() => vmd.tty.attaches.length === 2 && io.output.split("\x1b[H\x1b[2J").length === 3, 5_000, "the second attach")
      io.type("\x02d")
      expect(await detached).toBe(0)
      expect(io.statuses.at(-1)).toContain("detached from main")
      expect(vmd.tty.attaches).toHaveLength(2)
      expect(io.raw).toEqual([true, false, true, false])
    })

    test("a session that ended while disconnected, or a sandbox that went, ends it", async () => {
      const { vmd, api, id, io, run } = await setup()
      const done = run()
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      vmd.tty.refuse = true
      vmd.tty.cut()
      await waitFor(() => io.statuses.includes("reconnecting…"), 5_000, "the break")
      vmd.tty.sessions.clear()
      vmd.tty.refuse = false
      expect(await done).toBe(0)
      expect(io.statuses.at(-1)).toBe("the session main ended while this was disconnected")
      expect(io.output.endsWith(TERMINAL_RESET)).toBe(true)

      const again = run()
      await waitFor(() => vmd.tty.open === 1, 5_000, "the attach")
      vmd.tty.refuse = true
      vmd.tty.cut()
      await waitFor(() => io.statuses.filter((line) => line === "reconnecting…").length === 2, 5_000, "the second break")
      await api.destroy(id)
      vmd.tty.refuse = false
      expect(await again).toBe(125)
      expect(io.statuses.at(-1)).toContain(`no sandbox ${id}`)
    })

    test("it gives up reattaching after a while without progress, and says how to come back", async () => {
      const { vmd, io, run } = await setup()
      const done = run({ reconnectForMs: 400 })
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      vmd.tty.refuse = true
      vmd.tty.cut()
      expect(await done).toBe(125)
      expect(io.statuses.at(-1)).toMatch(/^gave up reattaching after .*; the session keeps running: kyora vms shell /)
      expect(io.raw).toEqual([true, false])
    })

    test("transient vmd and gateway refusals recover the same session with one status line", async () => {
      const { vmd, io, run } = await setup()
      const done = run()
      try {
        await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the first attach")
        io.type("kept screen\r")
        await waitFor(() => io.output.includes("kept screen"), 5_000, "the echo")
        vmd.tty.refuseAttach = { status: 503, error: "vmd_unavailable", message: "vmd is restarting" }
        vmd.tty.cut()
        await waitFor(() => io.statuses.includes("reconnecting…"), 5_000, "retrying")
        for (const status of [502, 504, 503]) {
          vmd.tty.refuseAttach = { status, error: "node_disconnected", message: "machine reconnecting" }
          await Bun.sleep(100)
        }
        vmd.tty.refuseAttach = null
        await waitFor(() => vmd.tty.attaches.length === 2 && io.output.split("\x1b[H\x1b[2J").at(-1)!.includes("kept screen"), 5_000, "recovered redraw")
        expect(io.statuses).toEqual(["reconnecting…"])
        expect(vmd.tty.sessions.size).toBe(1)
      } finally {
        io.type("\r~.")
        await done
      }
    })

    test("-- cmd opens its window once; a reattach doesn't run it again", async () => {
      const { vmd, id, io, run } = await setup()
      const done = run({ cmd: ["claude", "--resume"], cwd: "/work/app", env: { K: "v" } })
      await waitFor(() => io.output.includes("[window: claude --resume]"), 5_000, "the window")
      vmd.tty.cut()
      await waitFor(() => vmd.tty.attaches.length === 2, 5_000, "the reattach")
      io.type("\r~.")
      expect(await done).toBe(0)
      expect(vmd.tty.sessions.get(`${id}/main`)!.commands).toEqual([{ cmd: ["claude", "--resume"], cwd: "/work/app", env: { K: "v" } }])
    })

    test("--view: the attach is view only, and no key leaves this machine", async () => {
      const { vmd, io, run, sent } = await setup()
      const done = run({ control: false })
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      expect(vmd.tty.attaches[0]!.control).toBe(false)
      expect(io.statuses[0]).toContain("view only")
      io.type("rm -rf /work\r")
      await Bun.sleep(150)
      io.type("~.")
      expect(await done).toBe(0)
      expect(sent(0)).toEqual([])
    })

    test("a signal from outside (SIGTERM, SIGHUP, SIGINT, SIGQUIT) detaches and puts the terminal back, with its exit code", async () => {
      const { io, run } = await setup()
      const signals = Object.entries(SIGNAL_EXIT) as Array<[TerminalSignal, number]>
      for (const [signal, code] of signals) {
        const before = io.output.length
        const done = run()
        await waitFor(() => io.output.slice(before).includes("\x1b[H\x1b[2J"), 5_000, `the attach (${signal})`)
        io.signal(signal)
        expect([signal, await done]).toEqual([signal, code])
        expect(io.output.endsWith(TERMINAL_RESET)).toBe(true)
      }
      expect(io.raw).toEqual(signals.flatMap(() => [true, false]))
      expect(io.listening).toBe(0)
    })

    test("~. or a signal while the attach is still connecting is honoured at once, and nothing stays attached", async () => {
      const { vmd, io, run } = await setup()
      // the server takes its time with the upgrade (the guest attaching its tmux client)
      vmd.tty.upgradeDelayMs = 800
      for (const what of ["SIGTERM", "SIGHUP", "~."] as const) {
        const done = run()
        await Bun.sleep(200)
        const asked = Date.now()
        if (what === "~.") io.type("~.")
        else io.signal(what)
        const result = await Promise.race([done, Bun.sleep(3_000).then(() => "still attached 3 s later")])
        expect([what, result]).toEqual([what, what === "~." ? 0 : SIGNAL_EXIT[what]])
        expect(Date.now() - asked).toBeLessThan(400)
        expect(io.statuses.at(-1)).toContain("detached from main")
        // the upgrade the server finished anyway is let go of: no attach survives the CLI
        await Bun.sleep(800)
        await waitFor(() => vmd.tty.open === 0, 5_000, `nothing attached after ${what}`)
      }
      expect(vmd.tty.messages.filter((message) => message.kind === 0)).toEqual([])
    })

    test("~. while a reattach hangs (the network went) detaches at once", async () => {
      const { vmd, io, run } = await setup()
      const done = run({ openMs: 5_000, backoffBaseMs: 50 })
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      vmd.tty.hang = true
      vmd.tty.cut()
      await waitFor(() => io.statuses.includes("reconnecting…"), 5_000, "the break")
      // the reattach's WebSocket is the one waiting now
      await Bun.sleep(300)
      const asked = Date.now()
      io.type("\r~.")
      expect(await done).toBe(0)
      expect(Date.now() - asked).toBeLessThan(400)
      vmd.tty.hang = false
    })

    test("KYORA_VMS_REATTACH_WINDOW_MS bounds reattaching, as it does for exec", async () => {
      const { vmd, io, run } = await setup()
      const before = process.env.KYORA_VMS_REATTACH_WINDOW_MS
      process.env.KYORA_VMS_REATTACH_WINDOW_MS = "400"
      try {
        const done = run({ reconnectForMs: undefined })
        await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
        vmd.tty.refuse = true
        vmd.tty.cut()
        const cut = Date.now()
        expect(await done).toBe(125)
        expect(Date.now() - cut).toBeLessThan(1_500)
        expect(io.statuses.at(-1)).toMatch(/^gave up reattaching after 400ms /)
      } finally {
        if (before === undefined) delete process.env.KYORA_VMS_REATTACH_WINDOW_MS
        else process.env.KYORA_VMS_REATTACH_WINDOW_MS = before
      }
    })

    test("a terminal wider or taller than a server takes is cut to 1000, at the attach and on a resize", async () => {
      const { vmd, io, run, sent } = await setup()
      io.cols = 1200
      const done = run()
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      expect(vmd.tty.attaches[0]).toMatchObject({ cols: 1000, rows: 30 })
      expect(vmd.tty.messages[0]!.control).toEqual({ type: "resize", cols: 1000, rows: 30 })
      io.resize(1500, 1100)
      await waitFor(() => sent(1).some((message) => message.control!.type === "resize" && message.control!.cols === 1000 && message.control!.rows === 1000), 5_000, "the resize")
      io.type("echo wide\r")
      await waitFor(() => io.output.includes("echo wide\r"), 5_000, "the echo")
      io.type("~.")
      expect(await done).toBe(0)
      expect(io.statuses).not.toContain("reconnecting…")
      expect(vmd.tty.attaches).toHaveLength(1)
    })

    test("a refused attach says the server's reason; one that attaching again won't change ends it", async () => {
      const { vmd, id, io, run } = await setup()
      vmd.tty.refuseAttach = { status: 501, error: "unsupported", message: "this sandbox's image has no terminals (no tmux)" }
      const started = Date.now()
      expect(await run()).toBe(125)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(io.statuses.at(-1)).toBe(`attach to ${id}: this sandbox's image has no terminals (no tmux) (501)`)
      expect(io.raw).toEqual([true, false])
      // a transient refusal retries with one status line
      vmd.tty.refuseAttach = { status: 409, error: "busy", message: "a sandbox takes 8 terminals at once" }
      const done = run()
      await waitFor(() => io.statuses.includes("reconnecting…"), 5_000, "retrying")
      await Bun.sleep(300)
      expect(io.statuses.filter((line) => line === "reconnecting…")).toHaveLength(1)
      vmd.tty.refuseAttach = null
      await waitFor(() => io.output.includes("\x1b[H\x1b[2J"), 5_000, "the attach")
      io.type("~.")
      expect(await done).toBe(0)
    })

    test("OSC 52 from the sandbox never reaches the local terminal's clipboard, unless --clipboard", async () => {
      const { vmd, io, run } = await setup()
      for (const clipboard of [false, true]) {
        const before = io.output.length
        const done = run({ clipboard })
        await waitFor(() => io.output.slice(before).includes("\x1b[H\x1b[2J"), 5_000, "the attach")
        // split across messages, between its own bytes and in the middle of the text
        vmd.tty.print("main", "before\x1b]5")
        vmd.tty.print("main", "2;c;cHduZWQ=\x07after\x1b]52;c;")
        vmd.tty.print("main", "dGhlcmU=\x1b\\end\r\n")
        await waitFor(() => io.output.slice(before).includes("end\r\n"), 5_000, "the output")
        const shown = io.output.slice(before)
        if (clipboard) expect(shown).toContain("before\x1b]52;c;cHduZWQ=\x07after\x1b]52;c;dGhlcmU=\x1b\\end")
        else expect(shown).toContain("beforeafterend")
        expect(shown.includes("\x1b]52")).toBe(clipboard)
        io.type("\r~.")
        expect(await done).toBe(0)
      }
    })

    test("not a terminal, no tmux: refused before the terminal goes raw", async () => {
      const { vmd, io, run } = await setup()
      io.isTTY = false
      expect(await run()).toBe(125)
      expect(io.statuses[0]).toContain("needs a terminal")
      io.isTTY = true
      vmd.tty.refuse = true
      await expect(run()).rejects.toThrow("not connected")
      expect(io.raw).toEqual([])
      expect(vmd.tty.attaches).toEqual([])
    })
  })
}

describe("ClipboardFilter", () => {
  const text = (filter: ClipboardFilter, ...chunks: string[]) => chunks.map((chunk) => new TextDecoder().decode(filter.push(new TextEncoder().encode(chunk)))).join("")

  test("OSC 52 goes, ended by BEL or ST, whole or in pieces; everything else stays", () => {
    expect(text(new ClipboardFilter(), "a\x1b]52;c;eA==\x07b")).toBe("ab")
    expect(text(new ClipboardFilter(), "a\x1b]52;;eA==\x1b\\b")).toBe("ab")
    // every split point
    const whole = "x\x1b[1mbold\x1b]52;c;aGVsbG8=\x1b\\y\x1b]0;title\x07z"
    for (let at = 0; at <= whole.length; at++) expect([at, text(new ClipboardFilter(), whole.slice(0, at), whole.slice(at))]).toEqual([at, "x\x1b[1mboldy\x1b]0;title\x07z"])
    // other OSCs, and what only starts like one, pass
    expect(text(new ClipboardFilter(), "\x1b]5;x\x07\x1b]520;y\x07\x1b]8;;http://x\x1b\\")).toBe("\x1b]5;x\x07\x1b]520;y\x07\x1b]8;;http://x\x1b\\")
    expect(text(new ClipboardFilter(), "\x1b", "]", "5", "x")).toBe("\x1b]5x")
    // CAN or SUB cuts it short; an ESC that starts something else ends it, and is that something
    expect(text(new ClipboardFilter(), "\x1b]52;c;abc\x18ok")).toBe("ok")
    expect(text(new ClipboardFilter(), "\x1b]52;c;abc\x1b[31mred")).toBe("\x1b[31mred")
    expect(text(new ClipboardFilter(), "\x1b]52;c;abc\x1b", "]52;c;def\x07ok")).toBe("ok")
    // a chunk without ESC is passed as it is
    const plain = new TextEncoder().encode("plain")
    expect(new ClipboardFilter().push(plain)).toBe(plain)
  })
})

describe("Escapes", () => {
  test("~ only right after a newline (or first), across chunks", () => {
    const escapes = new Escapes()
    const text = (data: Uint8Array) => new TextDecoder().decode(data)
    expect(escapes.push(new TextEncoder().encode("~"))).toMatchObject({ detach: false })
    expect(text(escapes.push(new TextEncoder().encode("x")).send)).toBe("~x")
    expect(text(escapes.push(new TextEncoder().encode("a~.")).send)).toBe("a~.")
    expect(escapes.push(new TextEncoder().encode("\n~?")).help).toBe(true)
    expect(escapes.push(new TextEncoder().encode(".")).detach).toBe(false)
    const fresh = new Escapes()
    expect(fresh.push(new TextEncoder().encode("ls\r~"))).toMatchObject({ detach: false })
    expect(fresh.push(new TextEncoder().encode("."))).toMatchObject({ detach: true })
  })
})

describe("kyora vms shell (the command)", () => {
  test("--list and --kill; the flags it takes and refuses", async () => {
    vmd = await startFakeVmd()
    const root = await realpath(await tempDir("shell"))
    try {
      const env = baseEnv(vmd.url)
      const id = (await cli(["create"], { cwd: root, env })).stdout.trim()
      expect((await cli(["shell", id, "--list"], { cwd: root, env })).stdout).toContain(`no terminal sessions in ${id}`)
      const api = new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "/dev/null" })
      await api.ttyCreate(id, { name: "job", cmd: ["claude"] })
      const listed = await cli(["shell", id, "--list"], { cwd: root, env })
      expect(listed.stdout.split("\n")[0]).toMatch(/^NAME\s+WINDOWS\s+CLIENTS\s+STATE\s+LAST OUTPUT$/)
      expect(listed.stdout).toMatch(/job\s+1\s+detached\s+running claude\s+\S+ ago/)
      expect(JSON.parse((await cli(["shell", id, "--list", "--json"], { cwd: root, env })).stdout).sessions[0]).toMatchObject({ name: "job", busy: true })
      expect(await cli(["shell", id, "--kill", "job"], { cwd: root, env })).toMatchObject({ code: 0, stdout: `killed job in ${id}\n` })
      const missing = await cli(["shell", id, "--kill", "job"], { cwd: root, env })
      expect(missing.code).toBe(125)
      expect(missing.stderr).toContain("no session job")
      for (const args of [["shell"], ["shell", id, "--name", "../x"], ["shell", id, "--kill", "a b"], ["shell", id, "--list", "--kill", "x"], ["shell", id, "--json"], ["shell", id, "--env", "K=v"], ["shell", id, "--"], ["shell", id, "--timeout", "1m"]]) {
        const refused = await cli(args, { cwd: root, env })
        expect([args.join(" "), refused.code]).toEqual([args.join(" "), 125])
      }
      // without a terminal: said, and nothing attached
      const piped = await cli(["shell", id], { cwd: root, env })
      expect(piped.code).toBe(125)
      expect(piped.stderr).toContain("shell needs a terminal")
      expect(vmd.tty.attaches).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an old kyora-vmd without terminals: said so, before the terminal goes raw", async () => {
    // a kyora-vmd from before terminals: no such routes (a 404 before its key is looked at), and no tty in its health
    const old = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/v1/health"
          ? Response.json({ ok: true, version: "0.9", features: ["exec.resume", "vm.adopt"], capacity: { vcpusFree: 4, memoryMbFree: 4096 } })
          : Response.json({ error: "not_found", message: "no such route" }, { status: 404 }),
    })
    try {
      const api = new VmsClient({ url: `http://127.0.0.1:${old.port}`, key: KEY, keySource: "test", urlSource: "test", credentials: "/dev/null" })
      const io = new FakeTerminal()
      const refused = await shell(api, "sb_123", { name: "main", control: true, io }).catch((error: unknown) => error as ApiError)
      expect(refused).toBeInstanceOf(ApiError)
      expect((refused as ApiError).status).toBe(501)
      expect((refused as ApiError).message).toBe(`terminals are unavailable on http://127.0.0.1:${old.port}; update the machine software`)
      expect(io.raw).toEqual([])
      // --list and --kill too
      await expect(api.ttyKill("sb_123", "main")).rejects.toThrow("terminals are unavailable")
      // a sandbox that isn't there, on a kyora-vmd with terminals, is still that
      vmd = await startFakeVmd()
      const current = new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "/dev/null" })
      await expect(current.ttySessions("sb_nope")).rejects.toThrow("no sandbox sb_nope")
    } finally {
      old.stop(true)
    }
  })

  test("in a real pty: a signal from outside (SIGTERM, SIGHUP, SIGINT, SIGQUIT) puts the terminal's modes back, and exits 128 + its number", async () => {
    if (!Bun.which("python3")) return
    vmd = await startFakePlatform({ ttyKeepaliveMs: 200 })
    const root = await realpath(await tempDir("shell-sig"))
    try {
      const env = platformEnv(vmd.url)
      const id = (await cli(["create"], { cwd: root, env })).stdout.trim()
      const script = `
import os, pty, sys, termios, time, json, select, signal
sig = getattr(signal, sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
def modes():
    attrs = termios.tcgetattr(fd)
    return {"echo": bool(attrs[3] & termios.ECHO), "icanon": bool(attrs[3] & termios.ICANON), "isig": bool(attrs[3] & termios.ISIG), "opost": bool(attrs[1] & termios.OPOST)}
before = modes()
seen = b""
raw = None
sent = None
deadline = time.time() + 15
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            seen += os.read(fd, 65536)
        except OSError:
            break
    if raw is None and b"\\x1b[2J" in seen:
        raw = modes()
        time.sleep(0.2)
        os.kill(pid, sig)
        sent = time.time()
    if sent and time.time() - sent > 5:
        break
# the terminal closing (the EIO above) comes a moment before the exit: wait for that, up to 5 s after the signal
limit = (sent or time.time()) + 5
while True:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done != 0 or time.time() > limit:
        break
    time.sleep(0.02)
if done == 0:
    exited = "still running 5 s after the signal"
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
else:
    exited = os.waitstatus_to_exitcode(status)
print(json.dumps({"before": before, "raw": raw, "after": modes(), "exit": exited}))
`
      for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
        const proc = Bun.spawn(["python3", "-c", script, signal, process.execPath, "--no-env-file", ENTRY, "shell", id], { cwd: root, env: Object.fromEntries(Object.entries({ ...env, TERM: "xterm-256color" }).filter(([, value]) => value !== undefined)) as Record<string, string>, stdout: "pipe", stderr: "pipe" })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        const report = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { before: Record<string, boolean>; raw: Record<string, boolean> | null; after: Record<string, boolean>; exit: number | string }
        expect([signal, report.raw?.isig]).toEqual([signal, false])
        expect([signal, report.exit, report.after]).toEqual([signal, code, report.before])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("in a real pty: raw while attached, the terminal's own modes back after ~.", async () => {
    if (!Bun.which("python3")) return
    vmd = await startFakePlatform({ ttyKeepaliveMs: 200 })
    const root = await realpath(await tempDir("shell-pty"))
    try {
      const env = platformEnv(vmd.url)
      const id = (await cli(["create"], { cwd: root, env })).stdout.trim()
      // python's pty: the CLI on a terminal of its own; the script reports that terminal's modes before and after
      const script = `
import os, pty, sys, termios, time, json, select
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def modes():
    attrs = termios.tcgetattr(fd)
    return {"echo": bool(attrs[3] & termios.ECHO), "icanon": bool(attrs[3] & termios.ICANON), "isig": bool(attrs[3] & termios.ISIG), "opost": bool(attrs[1] & termios.OPOST), "icrnl": bool(attrs[0] & termios.ICRNL)}
before = modes()
seen = b""
deadline = time.time() + 15
raw = None
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            seen += os.read(fd, 65536)
        except OSError:
            break
    if raw is None and b"\\x1b[2J" in seen:
        raw = modes()
        os.write(fd, b"hello\\r")
    if raw is not None and b"hello" in seen.split(b"\\x1b[2J")[-1] and b"~." not in seen:
        os.write(fd, b"~.")
        seen += b"~."
_, status = os.waitpid(pid, 0)
# the pty's modes once the CLI is gone: what it found, put back
after = modes()
print(json.dumps({"before": before, "raw": raw, "after": after, "code": os.waitstatus_to_exitcode(status), "seen": seen.decode("utf-8", "replace")[-400:]}))
`
      const proc = Bun.spawn(["python3", "-c", script, process.execPath, "--no-env-file", ENTRY, "shell", id], { cwd: root, env: Object.fromEntries(Object.entries({ ...env, TERM: "xterm-256color" }).filter(([, value]) => value !== undefined)) as Record<string, string>, stdout: "pipe", stderr: "pipe" })
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      const report = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { before: Record<string, boolean>; raw: Record<string, boolean> | null; after: Record<string, boolean>; code: number; seen: string }
      expect([report.code, err]).toEqual([0, ""])
      expect(report.before).toEqual({ echo: true, icanon: true, isig: true, opost: true, icrnl: true })
      // raw as ssh makes it: no echo, no line editing, no signals from keys, and no output processing (a newline from tmux moves down, never to the first column)
      expect(report.raw).toEqual({ echo: false, icanon: false, isig: false, opost: false, icrnl: false })
      expect(report.after).toEqual(report.before)
      expect(report.seen).toContain("back in: kyora vms attach")
      expect(vmd.tty.messages.filter((message) => message.kind === 0).map((message) => message.text).join("")).toBe("hello\r")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
