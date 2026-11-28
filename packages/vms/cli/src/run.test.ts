import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError, type CreateSpec, type ExecRequest, type VmsClient } from "./api"
import { END_OF_ARCHIVE, headerBlocks, padding } from "./tar"

/** run() keeps a sandbox whose outputs did not come down, and destroys it otherwise. */

const ENV = { KYORA_VMS_REATTACH_BASE_MS: "5", KYORA_VMS_REATTACH_WINDOW_MS: "300", KYORA_VMS_KEEP_ON_FAILURE_TTL: undefined } as Record<string, string | undefined>
const saved: Record<string, string | undefined> = {}
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kyora-run-"))
  writeFileSync(join(root, "main.c"), "int main() {}\n")
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function tar(name: string, data: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(data)
  return Buffer.concat([...headerBlocks({ name, type: "file", mode: 0o644, size: body.length, mtime: 0 }), body, padding(body.length), END_OF_ARCHIVE])
}

const dns = () => new ApiError("download /work/out: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0)
const exit = (code: number) => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "exit", code })}\n`)

const EIGHT_HOURS = 8 * 3_600_000

interface Fake {
  api: VmsClient
  /** the create's epoch ms, as the server answered it */
  createdAt: number
  created: CreateSpec[]
  destroyed: string[]
  updates: { id: string; change: { ttlSeconds?: number } }[]
  downloads: number
  /** looks at the sandbox (api.get) */
  looks: number
}

interface FakeOptions {
  download: (attempt: number) => Response | Promise<Response>
  exec?: (request: ExecRequest) => Response | Promise<Response>
  attach?: () => Promise<Response>
  update?: (signal?: AbortSignal) => void | Promise<void>
  expiresAt?: (createdAt: number) => string
  /** what the create's answer leaves out, or (expiresAt: null) says is unlimited */
  createReply?: { omit?: ("createdAt" | "expiresAt")[]; unlimited?: boolean }
  create?: (spec: CreateSpec) => void
  name?: string
  /** a look at the sandbox; it is there unless this throws */
  get?: (signal?: AbortSignal) => void | Promise<void>
  /** false: the server's answers name no idle timeout */
  idle?: false
}

function fake(options: FakeOptions): Fake {
  const state: Fake = { api: null as unknown as VmsClient, createdAt: 0, created: [], destroyed: [], updates: [], downloads: 0, looks: 0 }
  let idleSeconds = 1200
  state.api = {
    url: "https://cloud.kyora.sh",
    kind: async () => "vmd",
    create: async (spec: CreateSpec) => {
      state.created.push(spec)
      options.create?.(spec)
      state.createdAt = Date.now()
      idleSeconds = spec.idleSeconds ?? 1200
      const reply: Record<string, unknown> = { id: "sb_0123456789abcdef", name: options.name ?? "quiet-otter", status: "running", createdAt: new Date(state.createdAt).toISOString(), expiresAt: options.createReply?.unlimited ? null : new Date(state.createdAt + EIGHT_HOURS).toISOString(), ...(options.idle === false ? {} : { idleSeconds }) }
      for (const key of options.createReply?.omit ?? []) delete reply[key]
      return reply
    },
    upload: async (_id: string, _dest: string, body: ReadableStream<Uint8Array>) => {
      await new Response(body).arrayBuffer()
      return { bytes: 0, entries: 1, durationMs: 0 }
    },
    exec: async (_id: string, request: ExecRequest) => (options.exec ?? (() => exit(0)))(request),
    attach: async () => (options.attach ?? (() => Promise.reject(new ApiError("gone", 404, "exec_not_found"))))(),
    execExited: () => {},
    download: async () => options.download(++state.downloads),
    get: async (id: string, signal?: AbortSignal) => {
      state.looks++
      await options.get?.(signal)
      return { id, status: "running", idleSeconds }
    },
    update: async (id: string, change: { ttlSeconds?: number }, signal?: AbortSignal) => {
      state.updates.push({ id, change })
      await options.update?.(signal)
      return { id, createdAt: new Date(state.createdAt).toISOString(), expiresAt: options.expiresAt?.(state.createdAt) ?? new Date(state.createdAt + (change.ttlSeconds ?? 0) * 1000).toISOString(), ...(options.idle === false ? {} : { idleSeconds }) }
    },
    destroy: async (id: string) => {
      state.destroyed.push(id)
    },
  } as unknown as VmsClient
  return state
}

async function captured(work: () => Promise<number>, onEvent?: (event: Record<string, unknown>) => void | Promise<void>): Promise<{ code: number; notes: string[]; events: Record<string, unknown>[] }> {
  const notes: string[] = []
  const events: Record<string, unknown>[] = []
  const stderr = process.stderr.write.bind(process.stderr)
  const stdout = process.stdout.write.bind(process.stdout)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    notes.push(...String(chunk).split("\n").filter(Boolean).map((line) => line.replace(/^\[[^\]]+\] /, "")))
    return true
  }) as typeof process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    let blocked: void | Promise<void> = undefined
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      events.push(JSON.parse(line))
      blocked = onEvent?.(events.at(-1)!) ?? blocked
    }
    const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined
    if (blocked) void blocked.then(() => done?.())
    else done?.()
    return true
  }) as typeof process.stdout.write
  try {
    return { code: await work(), notes, events }
  } finally {
    process.stderr.write = stderr
    process.stdout.write = stdout
  }
}

async function runWith(state: Fake, json = false, outs = ["/work/out"], prepare?: (to: string) => void, spec: CreateSpec = {}, onEvent?: (event: Record<string, unknown>) => void | Promise<void>, keep = false, exec: ExecRequest = { cmd: ["make"] }) {
  const { run } = await import("./run")
  const to = mkdtempSync(join(root, "to-"))
  prepare?.(to)
  const result = await captured(() => run(state.api, { dir: root, git: false, spec, wait: 0, exec, outs, to, keep, json }), onEvent)
  return { ...result, to }
}

test("a pull that fails twice with ENOTFOUND, then answers, lands, and the sandbox is destroyed", async () => {
  const state = fake({ download: (attempt) => {
    if (attempt <= 2) throw dns()
    return new Response(tar("out/app", "binary"))
  } })
  const { code, notes, to } = await runWith(state)
  expect(code).toBe(0)
  expect(state.downloads).toBe(3)
  expect(await Bun.file(join(to, "out/app")).text()).toBe("binary")
  expect(notes.filter((line) => line.startsWith("download of /work/out broke off (download /work/out: can't reach"))).toHaveLength(1)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(state.updates).toEqual([])
})

test("a pull that keeps failing keeps the sandbox for an hour, names the command that fetches it later, and exits 125", async () => {
  const state = fake({ download: () => {
    throw dns()
  } })
  const before = Date.now()
  const { code, notes, events } = await runWith(state, true, ["/work/out", "/work/my dir"])
  expect(code).toBe(125)
  expect(state.destroyed).toEqual([])
  expect(notes).toContain("--out /work/my dir: not tried, sb_0123456789abcdef is out of reach")
  expect(state.updates).toHaveLength(1)
  const ttl = state.updates[0]!.change.ttlSeconds!
  expect(ttl).toBeGreaterThanOrEqual(3600)
  expect(ttl).toBeLessThanOrEqual(3600 + Math.ceil((Date.now() - before) / 1000))
  expect(notes).toContainEqual(expect.stringMatching(/^--out \/work\/out: download \/work\/out: can't reach .*ENOTFOUND.*; still failing after 300ms of retries$/))
  const kept = events.find((event) => event.type === "kept")!
  expect(kept).toEqual({ type: "kept", id: "sb_0123456789abcdef", reason: "download_failed", expiresAt: new Date(state.createdAt + ttl * 1000).toISOString(), idleSeconds: 3601, confirmed: true })
  expect(notes.find((line) => line.startsWith("kept "))).toMatch(new RegExp(`^kept sb_0123456789abcdef \\(quiet-otter\\) until ${kept.expiresAt}, or sooner after 3601s without activity: the outputs were not downloaded, \`kyora vms pull quiet-otter /work/out '/work/my dir' --to [^\`]+\`, \`kyora vms rm quiet-otter\` when done$`))
  expect(events.find((event) => event.type === "summary")).toMatchObject({ id: "sb_0123456789abcdef", exitCode: 125, kept: true })
})

test("a TTL update answered with a refusal is no proof it did not land: the note claims the shorter floor, unconfirmed", async () => {
  const state = fake({
    download: () => {
      throw dns()
    },
    // as kyora cloud can: the node took the TTL, then a check after it refused and the rollback did not reach the node
    update: () => {
      throw new ApiError("update sb_0123456789abcdef: the scoped grant no longer allows this", 401, "unauthorized")
    },
  })
  const { code, notes, events } = await runWith(state, true)
  expect(code).toBe(125)
  expect(state.destroyed).toEqual([])
  const expiresAt = new Date(state.createdAt + state.updates[0]!.change.ttlSeconds! * 1000).toISOString()
  expect(Date.parse(expiresAt)).toBeLessThan(state.createdAt + EIGHT_HOURS)
  expect(events.find((event) => event.type === "kept")).toEqual({ type: "kept", id: "sb_0123456789abcdef", reason: "download_failed", expiresAt, idleSeconds: 3601, confirmed: false })
  expect(notes).toContainEqual(expect.stringMatching(new RegExp(`^kept sb_0123456789abcdef \\(quiet-otter\\); its expiry could not be confirmed \\(update sb_0123456789abcdef: the scoped grant no longer allows this; at the earliest ${expiresAt}, or sooner after 3601s without activity\\): the outputs were not downloaded, \`kyora vms pull quiet-otter /work/out --to [^\`]+\`, \`kyora vms rm quiet-otter\` when done$`)))
})

test("a TTL update whose answer was lost: the note claims no more than the shorter of the old expiry and the one asked for", async () => {
  const state = fake({
    download: () => {
      throw dns()
    },
    update: () => {
      throw new ApiError("update sb_0123456789abcdef: can't reach https://cloud.kyora.sh (socket hang up)", 0)
    },
  })
  const { notes, events } = await runWith(state, true)
  expect(state.destroyed).toEqual([])
  const kept = events.find((event) => event.type === "kept")!
  // the update may have landed: the TTL asked for, shorter than the create's eight hours, is all that is sure
  expect(kept).toMatchObject({ confirmed: false, idleSeconds: 3601, expiresAt: new Date(state.createdAt + state.updates[0]!.change.ttlSeconds! * 1000).toISOString() })
  expect(notes).toContainEqual(expect.stringMatching(new RegExp(`^kept sb_0123456789abcdef \\(quiet-otter\\); its expiry could not be confirmed \\(update sb_0123456789abcdef: can't reach .*; at the earliest ${kept.expiresAt}, or sooner after 3601s without activity\\): the outputs were not downloaded`)))
})

test("the note states the expiry the server answered, which can be earlier than the one asked for", async () => {
  const state = fake({
    expiresAt: (createdAt) => new Date(createdAt + 900_000).toISOString(),
    download: () => {
      throw dns()
    },
  })
  const { notes, events } = await runWith(state, true, ["/work/out"], undefined, { idleSeconds: 600 })
  const expiresAt = new Date(state.createdAt + 900_000).toISOString()
  expect(events.find((event) => event.type === "kept")).toEqual({ type: "kept", id: "sb_0123456789abcdef", reason: "download_failed", expiresAt, idleSeconds: 600, confirmed: true })
  expect(notes).toContainEqual(expect.stringMatching(new RegExp(`^kept sb_0123456789abcdef \\(quiet-otter\\) until ${expiresAt}, or sooner after 10m without activity: `)))
})

test("KYORA_VMS_KEEP_ON_FAILURE_TTL sets how long", async () => {
  process.env.KYORA_VMS_KEEP_ON_FAILURE_TTL = "600"
  try {
    const state = fake({ download: () => {
      throw dns()
    } })
    const { notes } = await runWith(state)
    expect(state.updates[0]!.change.ttlSeconds).toBeGreaterThanOrEqual(600)
    expect(state.updates[0]!.change.ttlSeconds).toBeLessThan(3600)
    expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\) until \S+Z, or sooner after \w+ without activity: /))
  } finally {
    delete process.env.KYORA_VMS_KEEP_ON_FAILURE_TTL
  }
})

test("an --out that is not in the sandbox is an answer: 125, and the sandbox is destroyed", async () => {
  const state = fake({ download: () => {
    throw new ApiError("download /work/out: not found", 404, "not_found")
  } })
  const { code, notes } = await runWith(state)
  expect(code).toBe(125)
  expect(state.downloads).toBe(1)
  expect(notes).toContain("--out /work/out: not found in the sandbox")
  expect(state.looks).toBe(1)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(state.updates).toEqual([])
})

const REAPED = "sandbox sb_0123456789abcdef is gone (reaped on its machine (idle timeout, or kyora-vmd restarted))"
const reaped = (action: string) => new ApiError(`${action}: ${REAPED}`, 404, "not_found")

test("an --out whose sandbox ended says so, why, and after how long idle: 125, the rest not tried, nothing kept or destroyed", async () => {
  const state = fake({
    download: () => {
      throw reaped("download /work/out")
    },
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const { code, notes, events } = await runWith(state, true, ["/work/out", "/work/logs"])
  expect(code).toBe(125)
  expect(state.downloads).toBe(1)
  expect(state.looks).toBe(1)
  expect(notes).toContain(`--out /work/out: not downloaded, ${REAPED}; a sandbox ends after 3601s without activity (--idle)`)
  expect(notes).toContain("--out /work/logs: not tried, sb_0123456789abcdef has ended")
  expect(notes.some((line) => line.includes("not found in the sandbox") || line.startsWith("kept "))).toBe(false)
  expect(state.updates).toEqual([])
  expect(state.destroyed).toEqual([])
  expect(events.filter((event) => event.type === "download").map((event) => event.error)).toEqual(["sandbox_gone", "sandbox_gone"])
  expect(events.find((event) => event.type === "gone")).toEqual({ type: "gone", id: "sb_0123456789abcdef", reason: REAPED })
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 125, kept: false })
})

test("a stream lost on a sandbox that ended is no keep: no TTL update, no unconfirmed 'kept', kept:false", async () => {
  const detached = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)
  const state = fake({
    exec: detached,
    attach: () => Promise.reject(reaped("reattach to the command in sb_0123456789abcdef")),
    download: () => new Response(tar("out/app", "binary")),
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const { code, notes, events } = await runWith(state, true, [])
  expect(code).toBe(125)
  expect(state.looks).toBe(1)
  expect(notes).toContain(`sb_0123456789abcdef not kept: ${REAPED}; a sandbox ends after 20m without activity (--idle)`)
  expect(notes.some((line) => line.startsWith("kept "))).toBe(false)
  expect(state.updates).toEqual([])
  expect(state.destroyed).toEqual([])
  expect(events.some((event) => event.type === "kept")).toBe(false)
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 125, kept: false })
})

test("a look that gets no answer proves nothing: the lost stream keeps the sandbox as before", async () => {
  const detached = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)
  const state = fake({
    exec: detached,
    attach: () => Promise.reject(new ApiError("reattach to the command in sb_0123456789abcdef: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0)),
    download: () => new Response(tar("out/app", "binary")),
    get: () => {
      throw new ApiError("get sb_0123456789abcdef: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0)
    },
  })
  const { code, events } = await runWith(state, true)
  expect(code).toBe(125)
  expect(state.looks).toBe(1)
  expect(state.destroyed).toEqual([])
  expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "stream_lost" })
})

test("kyora vms pull: a path not there is not found; a sandbox that ended says why, and the rest are not tried", async () => {
  const { pullPaths } = await import("./session")
  const to = mkdtempSync(join(root, "pull-"))
  const live = fake({ download: () => {
    throw new ApiError("download /work/out: not found", 404, "not_found")
  } })
  const missing = await captured(() => pullPaths(live.api, "sb_0123456789abcdef", ["/work/out"], to, false))
  expect(missing.code).toBe(125)
  expect(missing.notes).toContain("/work/out: not found in the sandbox")

  const ended = fake({
    download: () => {
      throw reaped("download /work/out")
    },
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const gone = await captured(() => pullPaths(ended.api, "sb_0123456789abcdef", ["/work/out", "/work/logs"], to, false))
  expect(gone.code).toBe(125)
  expect(ended.downloads).toBe(1)
  expect(gone.notes).toEqual([`/work/out: not downloaded, ${REAPED}`, "/work/logs: not tried, sb_0123456789abcdef has ended"])
  expect(ended.looks).toBe(1)
})

const detachedExec = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)
const hidden = () => new ApiError("get sb_0123456789abcdef: no such sandbox", 404, "not_found")

test("a 404 without the machine's 'is gone' proves nothing (a scoped token or region that no longer covers a live sandbox): as before", async () => {
  const lostStream = fake({
    exec: detachedExec,
    attach: () => Promise.reject(new ApiError("reattach to the command in sb_0123456789abcdef: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0)),
    download: () => new Response(tar("out/app", "binary")),
    get: () => {
      throw hidden()
    },
  })
  const lost = await runWith(lostStream, true)
  expect(lost.code).toBe(125)
  expect(lostStream.looks).toBe(1)
  expect(lostStream.updates.length).toBe(1)
  expect(lostStream.destroyed).toEqual([])
  expect(lost.events.some((event) => event.type === "gone")).toBe(false)
  expect(lost.events.find((event) => event.type === "kept")).toMatchObject({ reason: "stream_lost" })

  const pathless = fake({
    download: () => {
      throw new ApiError("download /work/out: no such sandbox", 404, "not_found")
    },
    get: () => {
      throw hidden()
    },
  })
  const missing = await runWith(pathless)
  expect(missing.code).toBe(125)
  expect(missing.notes).toContain("--out /work/out: not found in the sandbox")
  expect(pathless.destroyed).toEqual(["sb_0123456789abcdef"])
})

test("--keep on a sandbox that ended claims no keep: kept:false, the gone event, 125", async () => {
  const state = fake({
    download: () => {
      throw reaped("download /work/out")
    },
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const { code, notes, events } = await runWith(state, true, ["/work/out"], undefined, {}, undefined, true)
  expect(code).toBe(125)
  expect(notes.some((line) => line.startsWith("kept "))).toBe(false)
  expect(events.find((event) => event.type === "gone")).toEqual({ type: "gone", id: "sb_0123456789abcdef", reason: REAPED })
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 125, kept: false })
  expect(state.destroyed).toEqual([])

  const lostStream = fake({
    exec: detachedExec,
    attach: () => Promise.reject(reaped("reattach to the command in sb_0123456789abcdef")),
    download: () => new Response(tar("out/app", "binary")),
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const lost = await runWith(lostStream, true, [], undefined, {}, undefined, true)
  expect(lost.code).toBe(125)
  expect(lost.notes.some((line) => line.startsWith("kept "))).toBe(false)
  expect(lost.events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 125, kept: false })
})

test("Ctrl-C during the look at the sandbox: 130, for run's --out, its keep, and kyora vms pull", async () => {
  const looking = (signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
    process.emit("SIGINT")
  })
  const out = fake({
    download: () => {
      throw reaped("download /work/out")
    },
    get: looking,
  })
  const pulled = await runWith(out, true)
  expect(pulled.code).toBe(130)
  expect(pulled.events.filter((event) => event.type === "download")).toEqual([])
  expect(pulled.events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 130, kept: false })

  const lostStream = fake({
    exec: detachedExec,
    attach: () => Promise.reject(reaped("reattach to the command in sb_0123456789abcdef")),
    download: () => new Response(tar("out/app", "binary")),
    get: looking,
  })
  const lost = await runWith(lostStream, true, [])
  expect(lost.code).toBe(130)
  expect(lostStream.updates).toEqual([])
  expect(lostStream.destroyed).toEqual(["sb_0123456789abcdef"])

  const { pullPaths } = await import("./session")
  const ended = fake({
    download: () => {
      throw reaped("download /work/out")
    },
    get: looking,
  })
  const session = await captured(() => pullPaths(ended.api, "sb_0123456789abcdef", ["/work/out"], mkdtempSync(join(root, "pull-")), false))
  expect(session.code).toBe(130)
  expect(session.notes.some((line) => line.includes("not found in the sandbox"))).toBe(false)
})

test("a sandbox that ended exits 125 though its command exited 17 before", async () => {
  const state = fake({
    exec: () => exit(17),
    download: () => {
      throw reaped("download /work/out")
    },
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const { code, events } = await runWith(state, true)
  expect(code).toBe(125)
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 125, kept: false })
})

test("Ctrl-C after the look said the sandbox ended: 130, and still neither kept nor destroyed, with --keep or without", async () => {
  for (const keep of [true, false]) {
    const state = fake({
      download: () => {
        throw reaped("download /work/out")
      },
      get: () => {
        throw reaped("get sb_0123456789abcdef")
      },
    })
    const { code, notes, events } = await runWith(state, true, ["/work/out"], undefined, {}, (event) => {
      if (event.type === "download") process.emit("SIGINT")
    }, keep)
    expect(code).toBe(130)
    expect(notes.some((line) => line.startsWith("kept "))).toBe(false)
    expect(state.destroyed).toEqual([])
    expect(state.updates).toEqual([])
    expect(events.find((event) => event.type === "gone")).toEqual({ type: "gone", id: "sb_0123456789abcdef", reason: REAPED })
    expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 130, kept: false })
  }
})

test("Ctrl-C while --json writes the gone event: the interrupt still wins", async () => {
  const state = fake({
    exec: detachedExec,
    attach: () => Promise.reject(reaped("reattach to the command in sb_0123456789abcdef")),
    download: () => new Response(tar("out/app", "binary")),
    get: () => {
      throw reaped("get sb_0123456789abcdef")
    },
  })
  const { code, events } = await runWith(state, true, [], undefined, {}, (event) => {
    if (event.type === "gone") process.emit("SIGINT")
  })
  expect(code).toBe(130)
  expect(state.destroyed).toEqual([])
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 130, kept: false })
})

test("an entry that could not be written here keeps the sandbox to pull again; a refused one does not", async () => {
  const blocked = fake({ download: () => new Response(tar("out/app", "binary")) })
  const kept = await runWith(blocked, false, ["/work/out"], (to) => mkdirSync(join(to, "out/app"), { recursive: true }))
  expect(kept.code).toBe(125)
  expect(kept.notes).toContainEqual(expect.stringMatching(/^could not write 1 entry from \/work\/out: /))
  expect(blocked.destroyed).toEqual([])
  expect(kept.notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\) until \S+Z, or sooner after \w+ without activity: the outputs were not downloaded, `kyora vms pull quiet-otter \/work\/out --to [^`]+`/))

  const unsafe = fake({ download: () => new Response(tar("../escape", "x")) })
  const refused = await runWith(unsafe)
  expect(refused.code).toBe(125)
  expect(refused.notes).toContainEqual(expect.stringMatching(/^refused 1 unsafe entry from \/work\/out: /))
  expect(unsafe.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(unsafe.updates).toEqual([])
})

test("a clean run destroys the sandbox", async () => {
  const state = fake({ download: () => new Response(tar("out/app", "binary")) })
  const { code, notes } = await runWith(state)
  expect(code).toBe(0)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(state.updates).toEqual([])
  expect(notes.some((line) => line.startsWith("kept "))).toBe(false)
})

test("a stream lost past the window keeps the sandbox, though the --out that came down landed", async () => {
  const detached = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)
  const state = fake({
    exec: detached,
    attach: () => Promise.reject(new ApiError("reattach to the command in sb_0123456789abcdef: can't reach https://cloud.kyora.sh (getaddrinfo ENOTFOUND cloud.kyora.sh)", 0)),
    download: () => new Response(tar("out/app", "partial")),
  })
  const { code, notes, events } = await runWith(state, true)
  expect(code).toBe(125)
  expect(notes).toContainEqual(expect.stringMatching(/could not reattach within 300ms; it may still be running in sb_0123456789abcdef$/))
  expect(state.destroyed).toEqual([])
  expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\) until \S+Z, or sooner after \w+ without activity: lost the command's stream, and it may still be running, `kyora vms pull quiet-otter \/work\/out --to [^`]+`, `kyora vms rm quiet-otter` when done$/))
  expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "stream_lost" })
})

test("a run with --out asks for an idle timeout that outlasts the keep; none without --out, never over --idle or no expiry", async () => {
  const { runSpec } = await import("./run")
  expect(runSpec({ spec: {}, outs: ["/work/out"] }).idleSeconds).toBe(3600 + 1)
  expect(runSpec({ spec: {}, outs: [] }).idleSeconds).toBeUndefined()
  expect(runSpec({ spec: { idleSeconds: 300 }, outs: ["/work/out"] }).idleSeconds).toBe(300)
  expect(runSpec({ spec: { ttlSeconds: 0 }, outs: ["/work/out"] }).idleSeconds).toBeUndefined()
  process.env.KYORA_VMS_KEEP_ON_FAILURE_TTL = String(10 * 3600)
  try {
    expect(runSpec({ spec: {}, outs: ["/work/out"] }).idleSeconds).toBe(28800)
  } finally {
    delete process.env.KYORA_VMS_KEEP_ON_FAILURE_TTL
  }

  const withOut = fake({ download: () => new Response(tar("out/app", "binary")) })
  await runWith(withOut)
  expect(withOut.created[0]!.idleSeconds).toBe(3601)
  const without = fake({ download: () => new Response(tar("out/app", "binary")) })
  await runWith(without, false, [])
  expect(without.created[0]!.idleSeconds).toBeUndefined()
  const explicit = fake({ download: () => new Response(tar("out/app", "binary")) })
  await runWith(explicit, false, ["/work/out"], undefined, { idleSeconds: 600 })
  expect(explicit.created[0]!.idleSeconds).toBe(600)
})

test("an exec whose answer was lost on the network still gets its --out tried, and keeps the sandbox; any other refusal destroys it", async () => {
  const lostAnswer = fake({
    exec: () => {
      throw new ApiError("exec in sb_0123456789abcdef: can't reach https://cloud.kyora.sh (socket hang up)", 0)
    },
    download: () => new Response(tar("out/app", "partial")),
  })
  const lost = await runWith(lostAnswer, true)
  expect(lost.code).toBe(125)
  expect(lostAnswer.downloads).toBe(1)
  expect(lost.notes).toContain("no answer to the command in sb_0123456789abcdef (exec in sb_0123456789abcdef: can't reach https://cloud.kyora.sh (socket hang up)); it may be running there")
  expect(lostAnswer.destroyed).toEqual([])
  expect(lost.events.find((event) => event.type === "kept")).toMatchObject({ reason: "stream_lost" })

  const refused = fake({
    exec: () => {
      throw new ApiError("exec in sb_0123456789abcdef: bad request", 400, "invalid_request")
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const answered = await runWith(refused)
  expect(answered.code).toBe(125)
  expect(refused.downloads).toBe(0)
  expect(refused.destroyed).toEqual(["sb_0123456789abcdef"])
})

test("Ctrl-C while the TTL is set: the update is cut short, the sandbox destroyed, and the exit is 130", async () => {
  let cut = false
  const state = fake({
    download: () => {
      throw dns()
    },
    update: (signal) => new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => {
        cut = true
        reject(signal!.reason)
      }, { once: true })
      process.emit("SIGINT")
    }),
  })
  const { code, notes, events } = await runWith(state, true)
  expect(cut).toBe(true)
  expect(code).toBe(130)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(notes.some((line) => line.startsWith("kept ") || line.startsWith("could not set"))).toBe(false)
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 130, kept: false })
})

test("a name that starts with a dash: the printed commands name the sandbox by its id", async () => {
  const state = fake({ name: "-artifact", download: () => {
    throw dns()
  } })
  const { notes } = await runWith(state)
  expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(-artifact\) until \S+Z, or sooner after \w+ without activity: the outputs were not downloaded, `kyora vms pull sb_0123456789abcdef \/work\/out --to [^`]+`, `kyora vms rm sb_0123456789abcdef` when done$/))
})

describe("pull", () => {
  const policy = { windowMs: 100, baseDelayMs: 5, maxDelayMs: 20, idleMs: 1_000 }

  test("with a policy, a try still in flight at the window's end is cut off there", async () => {
    const { pull } = await import("./transfer")
    let attempts = 0
    const api = {
      download: async (_id: string, _paths: string[], _compress: boolean, signal?: AbortSignal) => {
        if (++attempts === 1) throw new ApiError("download /work/out: bad gateway", 502)
        return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
      },
    } as unknown as VmsClient
    const at = Date.now()
    const failure = await captured(async () => {
      await expect(pull(api, "sb_test", "/work/out", mkdtempSync(join(root, "to-")), undefined, policy)).rejects.toThrow("download /work/out: bad gateway; still failing after 100ms of retries")
      return 0
    })
    expect(failure.code).toBe(0)
    expect(attempts).toBe(2)
    expect(Date.now() - at).toBeLessThan(1_000)
  })

  test("without one, a pull keeps its three tries, for callers with deadlines of their own", async () => {
    const { pull, TRANSFER_ATTEMPTS } = await import("./transfer")
    let attempts = 0
    const api = {
      download: async () => {
        attempts++
        throw new ApiError("download /work/out: unavailable", 503)
      },
    } as unknown as VmsClient
    await captured(async () => {
      await expect(pull(api, "sb_test", "/work/out", mkdtempSync(join(root, "to-")))).rejects.toThrow("download /work/out: unavailable")
      return 0
    })
    expect(attempts).toBe(TRANSFER_ATTEMPTS)
  }, 10_000)
})

test("an account capped below the idle timeout --out asks for still runs, with the server's own idle timeout", async () => {
  const state = fake({
    create: (spec) => {
      if ((spec.idleSeconds ?? 0) > 3600) throw new ApiError("create sandbox: your account allows a maximum lifetime of 3600 seconds", 403, "quota_exceeded")
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const { code } = await runWith(state)
  expect(code).toBe(0)
  expect(state.created).toEqual([{ idleSeconds: 3601 }, {}])
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])

  const refused = fake({
    create: () => {
      throw new ApiError("create sandbox: your account allows 0 sandboxes", 403, "quota_exceeded")
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  expect((await runWith(refused, false, [])).code).toBe(125)
  expect(refused.created).toHaveLength(1)
})

test("Ctrl-C while --json writes the kept event: the interrupt still wins", async () => {
  const state = fake({ download: () => {
    throw dns()
  } })
  const { code, events } = await runWith(state, true, ["/work/out"], undefined, {}, (event) => {
    if (event.type === "kept") process.emit("SIGINT")
  })
  expect(code).toBe(130)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(events.find((event) => event.type === "summary")).toMatchObject({ exitCode: 130, kept: false })
})

test("an exec the machine never got (exec_not_started on every try) is no lost command: the sandbox goes", async () => {
  const state = fake({
    exec: () => {
      throw new ApiError("exec in sb_0123456789abcdef: the machine reconnected before it got the command", 503, "exec_not_started")
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const { code, notes } = await runWith(state, true)
  expect(code).toBe(125)
  expect(state.downloads).toBe(0)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(notes.some((line) => line.startsWith("kept ") || line.includes("may be running"))).toBe(false)
})

const refusal = (code: string | undefined, after?: number) => new ApiError(`exec in sb_0123456789abcdef: refused (${code ?? "no code"})`, 429, code, after)
const execLimit = (after?: number) => new ApiError("exec in sb_0123456789abcdef: this sandbox's limit of 32 execs is reached; wait for one to finish or cancel it", 429, "exec_limit", after)

test("an exec a limiter refused (429 exec_limit) is asked again after its Retry-After, and the run goes on and destroys the sandbox", async () => {
  let tries = 0
  const state = fake({
    exec: () => {
      if (++tries <= 2) throw execLimit(1_000)
      return exit(0)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const at = Date.now()
  const { code, notes } = await runWith(state)
  expect(code).toBe(0)
  expect(tries).toBe(3)
  expect(Date.now() - at).toBeGreaterThanOrEqual(2_000)
  expect(notes).toContain("exec in sb_0123456789abcdef: this sandbox's limit of 32 execs is reached; wait for one to finish or cancel it; asking again in 1.0s (try 2 of 5)")
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(state.updates).toEqual([])
})

test("an exec still refused (429 exec_limit) after 5 tries never ran: the sandbox is kept, with how to remove it and its idle timeout", async () => {
  let tries = 0
  const state = fake({
    exec: () => {
      tries++
      throw execLimit(0)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const at = Date.now()
  const { code, notes, events } = await runWith(state, true, [])
  expect(code).toBe(125)
  expect(tries).toBe(5)
  expect(Date.now() - at).toBeGreaterThanOrEqual(4_000)
  expect(state.downloads).toBe(0)
  expect(state.destroyed).toEqual([])
  expect(state.updates).toHaveLength(1)
  expect(notes.filter((line) => line.includes("asking again in 1.0s"))).toHaveLength(4)
  expect(events.find((event) => event.type === "kept")).toMatchObject({ type: "kept", id: "sb_0123456789abcdef", reason: "exec_refused", idleSeconds: 1200, confirmed: true })
  expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\) until \S+Z, or sooner after 20m without activity: the command was refused for now and never ran, `kyora vms exec quiet-otter -- …`, `kyora vms rm quiet-otter` when done$/))
  const summary = events.find((event) => event.type === "summary") as { exitCode: number; kept: boolean; timings: { execMs: number | null } }
  expect(summary).toMatchObject({ exitCode: 125, kept: true })
  expect(summary.timings.execMs).toBeGreaterThanOrEqual(4_000)
})

test("a 429 with any other code (rate_limited included), or none, is an answer: one try, and the sandbox is destroyed", async () => {
  for (const error of [refusal("rate_limited", 1_000), refusal("limit_reached", 1_000), refusal("platform_frozen", 1_000), refusal("too_many_spares", 1_000), refusal(undefined, 1_000)]) {
    let tries = 0
    const state = fake({
      exec: () => {
        tries++
        throw error
      },
      download: () => new Response(tar("out/app", "binary")),
    })
    const { code, events } = await runWith(state, true)
    expect(code).toBe(125)
    expect(tries).toBe(1)
    expect(state.downloads).toBe(0)
    expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
    expect(events.some((event) => event.type === "kept")).toBe(false)
  }
})

test("a 503 is never asked again: one try, then as before, --out runs and the sandbox is kept as a lost stream", async () => {
  for (const error of [new ApiError("exec in sb_0123456789abcdef: the sandbox did not wake in time", 503, "waking", 1_000), new ApiError("exec in sb_0123456789abcdef: the sandbox's machine is not connected", 503, "node_offline")]) {
    let tries = 0
    const state = fake({
      exec: () => {
        tries++
        throw error
      },
      download: () => new Response(tar("out/app", "binary")),
    })
    const { code, notes, events } = await runWith(state, true)
    expect(code).toBe(125)
    expect(tries).toBe(1)
    expect(state.downloads).toBe(1)
    expect(state.destroyed).toEqual([])
    expect(notes).toContain(`no answer to the command in sb_0123456789abcdef (${error.message}); it may be running there`)
    expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "stream_lost" })
  }
})

test("Ctrl-C while a refused exec waits: 130 at once, and the sandbox is destroyed", async () => {
  const state = fake({
    exec: () => {
      setTimeout(() => process.emit("SIGINT"), 20)
      throw execLimit(60_000)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const at = Date.now()
  const { code, events } = await runWith(state, true)
  expect(code).toBe(130)
  expect(Date.now() - at).toBeLessThan(5_000)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
  expect(events.some((event) => event.type === "kept")).toBe(false)
})

test("the waits count inside --timeout: no wait ends past it, each try asks for only the time left, and the sandbox is kept", async () => {
  const timeouts: Array<number | undefined> = []
  const state = fake({
    exec: (request) => {
      timeouts.push(request.timeoutSeconds)
      throw execLimit(1_000)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const at = Date.now()
  const { code, events } = await runWith(state, true, [], undefined, {}, undefined, false, { cmd: ["make"], timeoutSeconds: 3 })
  expect(Date.now() - at).toBeLessThan(3_000)
  expect(code).toBe(125)
  expect(timeouts).toHaveLength(3)
  expect(timeouts[0]).toBe(3)
  expect([2, 3]).toContain(timeouts[1]!)
  expect([1, 2]).toContain(timeouts[2]!)
  expect(state.destroyed).toEqual([])
  expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "exec_refused" })

  const long: Array<number | undefined> = []
  const once = fake({
    exec: (request) => {
      long.push(request.timeoutSeconds)
      throw execLimit(30_000)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const started = Date.now()
  const again = await runWith(once, true, [], undefined, {}, undefined, false, { cmd: ["make"], timeoutSeconds: 10 })
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(again.code).toBe(125)
  expect(long).toEqual([10])
  expect(once.destroyed).toEqual([])
  expect(again.events.find((event) => event.type === "kept")).toMatchObject({ reason: "exec_refused" })
})

/** pause()'s waits (1 s to a minute) end at once, on a clock moved on by each wait and `overshoot` more */
async function onSkippedWaits<T>(work: (clock: { advance: (ms: number) => void; stop: () => void }) => Promise<T>, overshoot = 0): Promise<T> {
  const realNow = Date.now
  const realTimeout = globalThis.setTimeout
  let offset = 0
  let skipping = true
  Date.now = () => realNow() + offset
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if (!skipping || ms === undefined || ms < 1_000 || ms > 60_000) return realTimeout(handler, ms)
    offset += ms + overshoot
    return realTimeout(handler, 0)
  }) as unknown as typeof setTimeout
  try {
    return await work({ advance: (ms) => (offset += ms), stop: () => (skipping = false) })
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realTimeout
  }
}

test("a --timeout over 5 minutes is the waits' only bound: a wait ending past 5 minutes still takes its try", async () => {
  let tries = 0
  const { code, state } = await onSkippedWaits(async (clock) => {
    const state = fake({
      exec: () => {
        if (++tries > 1) {
          clock.stop()
          return exit(0)
        }
        clock.advance(270_000)
        throw execLimit(60_000)
      },
      download: () => new Response(tar("out/app", "binary")),
    })
    const { code } = await runWith(state, false, [], undefined, {}, undefined, false, { cmd: ["make"], timeoutSeconds: 600 })
    return { code, state }
  })
  expect(code).toBe(0)
  expect(tries).toBe(2)
  expect(state.destroyed).toEqual(["sb_0123456789abcdef"])
})

test("a wait that overshoots --timeout sends no further try: the run gives up and keeps the sandbox", async () => {
  let tries = 0
  const state = fake({
    exec: () => {
      tries++
      throw execLimit(1_000)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const { code, events } = await onSkippedWaits(() => runWith(state, true, [], undefined, {}, undefined, false, { cmd: ["make"], timeoutSeconds: 3 }), 5_000)
  expect(code).toBe(125)
  expect(tries).toBe(1)
  expect(state.destroyed).toEqual([])
  expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "exec_refused" })
})

test("a give-up with --out downloads nothing, and its hint is `kyora vms exec`, not pull", async () => {
  const state = fake({
    exec: () => {
      throw execLimit(1_000)
    },
    download: () => new Response(tar("out/app", "binary")),
  })
  const { code, notes } = await onSkippedWaits(() => runWith(state, false, ["/work/out"]))
  expect(code).toBe(125)
  expect(state.downloads).toBe(0)
  expect(state.destroyed).toEqual([])
  const kept = notes.find((line) => line.startsWith("kept "))
  expect(kept).toContain("the command was refused for now and never ran, `kyora vms exec quiet-otter -- …`, `kyora vms rm quiet-otter` when done")
  expect(kept).not.toContain("kyora vms pull")
})

test("a kept refused run names an idle time only when the server gave one", async () => {
  const state = fake({
    exec: () => {
      throw execLimit(1_000)
    },
    download: () => new Response(tar("out/app", "binary")),
    idle: false,
  })
  const { code, notes, events } = await onSkippedWaits(() => runWith(state, true, []))
  expect(code).toBe(125)
  expect(events.find((event) => event.type === "kept")).toMatchObject({ reason: "exec_refused", idleSeconds: null })
  expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\) until \S+Z, or sooner after its idle timeout without activity: the command was refused for now and never ran/))
})

test("vms run's failure line names kyora cloud's history id for the exec when its header gave one", async () => {
  const state = fake({
    exec: () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "error", message: "boom" })}\n`, { headers: { "x-kyora-exec-history": "r_AbCdEfGh-_123456" } }),
    download: () => new Response(tar("out/app", "binary")),
  })
  const { code, notes } = await runWith(state, false, [])
  expect(code).toBe(125)
  expect(notes).toContain("exec r_AbCdEfGh-_123456: remote error: boom")
})

test("a refused exec's wait is the server's, from 1 s to a minute, and 5 s when it names none", async () => {
  const { execStartWaitMs } = await import("./run")
  expect(execStartWaitMs(execLimit(30_000))).toBe(30_000)
  expect(execStartWaitMs(execLimit(600_000))).toBe(60_000)
  expect(execStartWaitMs(execLimit())).toBe(5_000)
  for (const after of [0, -5_000, 200, Number.NaN]) expect(execStartWaitMs(execLimit(after))).toBe(1_000)
})

test("an unconfirmed TTL with either bound unknown claims no time at all; an unlimited old expiry leaves the TTL asked for", async () => {
  const lost = () => {
    throw new ApiError("update sb_0123456789abcdef: can't reach https://cloud.kyora.sh (socket hang up)", 0)
  }
  const failing = () => {
    throw dns()
  }
  for (const omit of [["createdAt"], ["expiresAt"]] as ("createdAt" | "expiresAt")[][]) {
    const state = fake({ download: failing, update: lost, createReply: { omit } })
    const { notes, events } = await runWith(state, true)
    expect(state.destroyed).toEqual([])
    expect(events.find((event) => event.type === "kept")).toEqual({ type: "kept", id: "sb_0123456789abcdef", reason: "download_failed", expiresAt: null, idleSeconds: 3601, confirmed: false })
    expect(notes).toContainEqual(expect.stringMatching(/^kept sb_0123456789abcdef \(quiet-otter\); its expiry could not be confirmed \(update sb_0123456789abcdef: can't reach https:\/\/cloud\.kyora\.sh \(socket hang up\)\): the outputs were not downloaded, /))
  }

  const unlimited = fake({ download: failing, update: lost, createReply: { unlimited: true } })
  const { events } = await runWith(unlimited, true)
  expect(events.find((event) => event.type === "kept")).toMatchObject({ confirmed: false, expiresAt: new Date(unlimited.createdAt + unlimited.updates[0]!.change.ttlSeconds! * 1000).toISOString() })
})
