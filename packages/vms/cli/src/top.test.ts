import { describe, expect, spyOn, test } from "bun:test"
import { VmsClient } from "./api"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SandboxSample, SandboxStats, SandboxStatsResponse } from "./stats-types"
import { handleKey, initialState, parseTopOptions, top } from "./top"
import { bar, computeRow, graph, renderTop, sortRows, sparkline, truncate, updated, updateState, uptime, visibleRows } from "./top-view"

const sample = (change: Partial<SandboxSample> = {}): SandboxSample => ({ verifiedAt: Object.fromEntries(["cpuUsec", "memMbSeconds", "netRxBytes", "netTxBytes", "diskUsedBytes"].map((counter) => [counter, change.sampledAt ?? 1000])) as NonNullable<SandboxSample["verifiedAt"]>, gaps: { cpuUsec: 0, memMbSeconds: 0, netRxBytes: 0, netTxBytes: 0, diskUsedBytes: 0 }, sampledAt: 1000, receivedAt: 1000, startedAt: "2026-10-13T10:00:00Z", cpuUsec: 1e6, memMbSeconds: 1024, netRxBytes: 100, netTxBytes: 200, diskUsedBytes: 2 ** 30, wallSeconds: 1, memoryMb: 8192, memoryGapMs: 0, lifetime: "vm", generation: "host", sequence: null, resets: 0, ...change })
const vm = (change: Partial<SandboxStats> = {}): SandboxStats => ({ id: "sb_fixture", name: "builder", region: "eu", vcpus: 4, memoryMb: 8192, diskGb: 30, sample: sample(), ...change })
const nextVm = () => vm({ sample: sample({ sampledAt: 3000, receivedAt: 3000, wallSeconds: 3, cpuUsec: 5e6, memMbSeconds: 5120, netRxBytes: 4196, netTxBytes: 2248 }) })
const response = (sandboxes: SandboxStats[], at = 3000): SandboxStatsResponse => ({ account: "fixture", at, sandboxes })
const fixture = () => updateState(updateState(initialState(), response([vm()], 1000)), response([nextVm()]))

describe("top rates", () => {
  test("CPU is allocated-vCPU percent, memory is resident average and network is bytes/s", () => {
    expect(computeRow(nextVm(), vm())).toMatchObject({ cpuPercent: 50, memoryUsedMb: 2048, netRxPerSecond: 2048, netTxPerSecond: 1024 })
  })
  test("unverified counters and recovery gaps never invent rates", () => {
    for (const [counter, rate] of [["cpuUsec", "cpuPercent"], ["memMbSeconds", "memoryUsedMb"], ["netRxBytes", "netRxPerSecond"], ["netTxBytes", "netTxPerSecond"]] as const) {
      const good = nextVm()
      const failed = vm({ sample: { ...good.sample!, verifiedAt: { ...good.sample!.verifiedAt!, [counter]: null } } })
      expect(computeRow(failed, vm())[rate]).toBeNull()
      expect(computeRow(good, failed)[rate]).toBeNull()
      const gap = vm({ sample: { ...good.sample!, gaps: { ...good.sample!.gaps!, [counter]: 1 } } })
      expect(computeRow(gap, vm())[rate]).toBeNull()
    }
    expect(computeRow(vm({ sample: { ...nextVm().sample!, verifiedAt: null } }), vm()).cpuPercent).toBeNull()
  })
  test("missing, repeated and backward samples do not invent rates", () => {
    for (const previous of [undefined, vm({ sample: null }), nextVm()]) expect(computeRow(nextVm(), previous).cpuPercent).toBeNull()
    expect(computeRow(vm(), nextVm()).netRxPerSecond).toBeNull()
    expect(computeRow(vm({ sample: null }), vm()).memoryUsedMb).toBeNull()
  })
  test("counter resets invalidate only that rate; changed lifetime or generation invalidates all rates", () => {
    expect(computeRow(vm({ sample: sample({ sampledAt: 3000, wallSeconds: 3, cpuUsec: 0, netRxBytes: 4196 }) }), vm())).toMatchObject({ cpuPercent: null, netRxPerSecond: 2048 })
    for (const change of [{ startedAt: "new" }, { generation: "new" }, { lifetime: "new" }, { resets: 1 }]) {
      expect(computeRow(vm({ sample: { ...nextVm().sample!, ...change } }), vm())).toMatchObject({ cpuPercent: null, memoryUsedMb: null, netRxPerSecond: null, netTxPerSecond: null })
    }
  })
  test("monotonic runtime wins over host clock jumps; memory averages over the measured part of the interval", () => {
    expect(computeRow(vm({ sample: { ...nextVm().sample!, sampledAt: 999999, memoryGapMs: 1 } }), vm())).toMatchObject({ cpuPercent: 50 })
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: 1000 } }), vm()).memoryUsedMb).toBe(4096)
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: 2000 } }), vm()).memoryUsedMb).toBeNull()
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: null } }), vm()).memoryUsedMb).toBeNull()
    expect(computeRow(vm({ sample: { ...nextVm().sample!, gaps: null } }), vm({ sample: sample({ gaps: null }) })).memoryUsedMb).toBeNull()
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: 500 } }), vm({ sample: sample({ memoryGapMs: 1000 }) })).memoryUsedMb).toBeNull()
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: 5000 } }), vm()).memoryUsedMb).toBeNull()
    expect(computeRow(vm({ sample: { ...nextVm().sample!, memoryGapMs: 3000 } }), vm({ sample: sample({ memoryGapMs: 2000 }) })).memoryUsedMb).toBe(4096)
    expect(computeRow(vm({ sample: { ...nextVm().sample!, sampledAt: 500, sequence: 2 } }), vm({ sample: sample({ sequence: 1 }) })).cpuPercent).toBe(50)
  })
  test("duplicate polls preserve the rates and do not append history; missing and ended VMs are pruned", () => {
    const state = fixture()
    const duplicate = updateState(state, response([nextVm()], 5000))
    expect(duplicate.rows[0]?.cpuPercent).toBe(50)
    expect(duplicate.history).toEqual(state.history)
    expect(updateState(duplicate, response([])).history).toEqual({})
    expect(updateState(duplicate, response([vm({ sample: null })])).rows[0]?.cpuPercent).toBeNull()
    let long = state
    for (let n = 4; n < 250; n++) long = updateState(long, response([vm({ sample: sample({ sampledAt: n * 1000, wallSeconds: n }) })]))
    expect(long.history.sb_fixture).toHaveLength(180)
  })
})

describe("top display", () => {
  test("bars and sparklines clip and preserve missing values", () => {
    expect(bar(50, 100, 4)).toBe("██░░")
    expect(bar(200, 100, 2)).toBe("██")
    expect(bar(null, 100, 2)).toBe("░░")
    expect(sparkline([0, null, 50, 100], 4)).toBe("▁ ▄█")
    expect(sparkline([0, 100], 1)).toBe("█")
    expect(sparkline([0, 100], 0)).toBe("")
    expect(graph([0, null, 100], 3, 2, 100)).toEqual(["  █", "  █"])
    expect(truncate("abcdef", 3)).toBe("ab…")
  })
  test("sorts deterministically without mutating and filters by name and region", () => {
    const a = computeRow(nextVm(), vm())
    const b = { ...a, id: "sb_b", name: "alpha", region: "us", cpuPercent: 10, memoryUsedMb: 4096, netRxPerSecond: 8192 }
    const rows = [a, b]
    for (const [sort, first] of [["cpu", a], ["memory", b], ["name", b], ["net", b]] as const) expect(sortRows(rows, sort)[0]).toEqual(first)
    expect(rows[0]).toBe(a)
    expect(visibleRows({ ...fixture(), rows, filter: "BUILD", region: "eu" })).toEqual([a])
  })
  test("layout bounds every line and height, keeps selection visible and escapes labels", () => {
    for (const width of [1, 12, 35, 79, 80, 100, 125, 160]) for (const height of [1, 3, 8, 24]) {
      const output = renderTop({ ...fixture(), detail: true }, width, height, true)
      expect(output.split("\r\n").length).toBeLessThanOrEqual(height)
      for (const line of output.split("\r\n")) expect(Array.from(line).length).toBeLessThanOrEqual(width)
    }
    expect(renderTop({ ...fixture(), account: "evil\x1b[2J\n" }, 160, 24)).not.toContain("\x1b")
    expect(renderTop(fixture(), 160, 24)).toContain("2.0G/8.0G")
    expect(renderTop({ ...fixture(), detail: true }, 160, 24, true)).toContain("Net TX")
    const rows = Array.from({ length: 30 }, (_, n) => ({ ...fixture().rows[0]!, id: String(n), name: String(n).padStart(2, "0") }))
    expect(renderTop({ ...fixture(), rows, sort: "name", selected: "29" }, 80, 8, true)).toContain("> 29")
  })
  test("keyboard selection, sorting, details and text filters", () => {
    let state = { ...fixture(), rows: [...fixture().rows, { ...fixture().rows[0]!, id: "b", name: "alpha", region: "us" }] }
    state = handleKey(state, "up")
    expect(state.selected).not.toBe("sb_fixture")
    expect(handleKey(state, "enter").detail).toBe(true)
    expect(handleKey(state, "s").sort).toBe("memory")
    expect(handleKey(state, "r").region).toBe("eu")
    state = handleKey(state, "/")
    for (const key of "qbuild") state = handleKey(state, key)
    expect(state.filter).toBe("qbuild")
    expect(handleKey(state, "backspace").filter).toBe("qbuil")
    expect(handleKey(state, "enter").editing).toBe(false)
    expect(handleKey(state, "escape").filter).toBe("")
  })
})

function terminal(tty: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(raw: boolean): void }
  input.isTTY = tty
  input.isRaw = false
  input.setRawMode = (raw) => { input.isRaw = raw }
  const signals = new EventEmitter()
  let text = ""
  const output = Object.assign(new EventEmitter(), { isTTY: tty, columns: 160, rows: 24, write: (chunk: string) => { text += chunk; return true } })
  return { io: { input, output, signals } as unknown as NonNullable<Parameters<typeof top>[2]>, input, output, signals, text: () => text }
}

describe("top command", () => {
  test("the client authenticates its stats read and rejects older servers", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response([nextVm()])))
    try {
      const api = new VmsClient({ url: "https://fixture.invalid", key: "kyora_fixture" })
      expect((await api.stats()).sandboxes[0]?.name).toBe("builder")
      const [url, options] = fetch.mock.calls[0]!
      expect(String(url)).toBe("https://fixture.invalid/v1/sandboxes?stats=1")
      expect(options?.method).toBe("GET")
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer kyora_fixture")
      fetch.mockResolvedValue(Response.json({ sandboxes: [] }))
      await expect(api.stats()).rejects.toThrow("does not support top")
    } finally { fetch.mockRestore() }
  })
  test("validates intervals and supports help without config", () => {
    expect(parseTopOptions([])?.interval).toBe(2)
    expect(parseTopOptions(["--help"])).toBeNull()
    expect(parseTopOptions(["--once", "--region", "eu", "--interval", "16"])).toMatchObject({ once: true, region: "eu", interval: 16 })
    for (const interval of ["NaN", "", "0", "-1", "3601"]) expect(() => parseTopOptions(["--interval", interval])).toThrow()
    for (const interval of ["0.1", "1.99"]) expect(() => parseTopOptions(["--interval", interval])).toThrow()
    expect(() => parseTopOptions(["extra"])).toThrow()
  })
  test("--once keeps sampling until the node has reported again, then computes rates", async () => {
    const tty = terminal(false)
    let count = 0
    await top({ stats: async () => response([count++ < 3 ? vm() : nextVm()]) }, { interval: 0.001, json: true }, tty.io)
    expect(count).toBe(4)
    expect(JSON.parse(tty.text())[0]).toMatchObject({ name: "builder", cpuPercent: 50 })
  })
  test("--once counts only a newer report as fresh, and stops at its deadline", async () => {
    const backwards = terminal(false)
    let count = 0
    const older = () => vm({ sample: sample({ sampledAt: 500, receivedAt: 500 }) })
    await top({ stats: async () => response([count++ === 0 ? vm() : count < 4 ? older() : nextVm()]) }, { interval: 0.001, json: true }, backwards.io)
    expect(count).toBe(4)
    expect(JSON.parse(backwards.text())[0]).toMatchObject({ cpuPercent: 50 })
    const stuck = terminal(false)
    let polls = 0
    const started = Date.now()
    await top({ stats: async () => { polls++; return response([vm()]) } }, { interval: 0.001, json: true, onceWaitSeconds: 0.05 }, stuck.io)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(polls).toBeGreaterThan(1)
    expect(JSON.parse(stuck.text())[0]).toMatchObject({ name: "builder", cpuPercent: null })
    const hanging = terminal(false)
    let calls = 0
    const signals: AbortSignal[] = []
    await top({ stats: (signal) => { if (signal) signals.push(signal); return calls++ === 0 ? Promise.resolve(response([vm()])) : new Promise<never>(() => {}) } }, { interval: 0.001, json: true, onceWaitSeconds: 0.05 }, hanging.io)
    expect(JSON.parse(hanging.text())[0]).toMatchObject({ name: "builder" })
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.at(-1)!.aborted).toBe(true)
  })
  test("non-TTY and JSON output take two samples when the second is fresh and compute rates", async () => {
    for (const json of [false, true]) {
      const tty = terminal(false)
      let count = 0
      await top({ stats: async () => response([count++ ? nextVm() : vm()]) }, { interval: 0.001, json }, tty.io)
      expect(count).toBe(2)
      expect(tty.text()).not.toContain("\x1b")
      if (json) expect(JSON.parse(tty.text())[0]).toMatchObject({ name: "builder", cpuPercent: 50 })
      else expect(tty.text()).toContain("50.0%")
    }
  })
  test("q, Ctrl-C, SIGTERM and errors restore raw mode, cursor, screen and listeners", async () => {
    for (const event of ["q", "ctrl-c", "SIGTERM", "error"]) {
      const tty = terminal(true)
      const client = { stats: async () => {
        if (event === "error") throw new Error("fixture error")
        queueMicrotask(() => event === "SIGTERM" ? tty.signals.emit(event) : tty.input.emit("keypress", event === "q" ? "q" : "\x03", { name: event === "q" ? "q" : "c", ctrl: event === "ctrl-c" }))
        return response([vm()])
      } }
      if (event === "error") await expect(top(client, { interval: 2 }, tty.io)).rejects.toThrow("fixture error")
      else await top(client, { interval: 2 }, tty.io)
      expect(tty.input.isRaw).toBe(false)
      expect(tty.text()).toStartWith("\x1b[?1049h\x1b[?25l")
      expect(tty.text()).toEndWith("\x1b[0m\x1b[?25h\x1b[?1049l")
      expect(tty.signals.eventNames()).toEqual([])
      expect(tty.input.listenerCount("keypress")).toBe(0)
    }
  })
  for (const stream of ["input", "output"] as const) for (const event of ["error", "close"] as const) {
    test(`${stream} ${event} stops a pending poll and restores the terminal`, async () => {
      const tty = terminal(true)
      tty.input.pause()
      let polls = 0
      const client = { stats: () => {
        polls++
        queueMicrotask(() => (tty[stream] as EventEmitter).emit(event, new Error("stream failed")))
        return new Promise<SandboxStatsResponse>(() => {})
      } }
      let timeout: ReturnType<typeof setTimeout>
      const running = Promise.race([top(client, { interval: 2 }, tty.io), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("poll did not stop")), 100) })])
      try {
        if (event === "error") await expect(running).rejects.toThrow("stream failed")
        else expect(await running).toBe(0)
        expect(polls).toBe(1)
        expect(tty.input.isRaw).toBe(false)
        expect(tty.input.isPaused()).toBe(true)
        expect(tty.text()).toEndWith("\x1b[0m\x1b[?25h\x1b[?1049l")
        expect(tty.input.listenerCount("error")).toBe(0)
        expect(tty.input.listenerCount("close")).toBe(0)
        expect(tty.input.listenerCount("keypress")).toBe(0)
        expect(tty.output.eventNames()).toEqual([])
        expect(tty.signals.eventNames()).toEqual([])
      } finally { clearTimeout(timeout!); tty.signals.emit("SIGTERM") }
    })
  }
  test("NO_COLOR rendering retains selection without styling escapes", () => {
    const plain = renderTop(fixture(), 160, 24, true, false)
    expect(plain).toContain("> builder")
    expect(plain).not.toContain("\x1b")
    expect(renderTop(fixture(), 160, 24, true, true)).toContain("\x1b[7m")
  })
})

test("the sample's counter names match the meter's", async () => {
  const { METER_COUNTERS } = await import("../../shared/metering")
  const names: import("./stats-types").SampleCounter[] = [...METER_COUNTERS]
  expect(names).toEqual(["cpuUsec", "memMbSeconds", "netRxBytes", "netTxBytes", "diskUsedBytes"])
})

test("uptime counts from the sandbox's start, not from the meter's runtime", () => {
  const started = Date.parse("2026-10-13T10:00:00Z")
  expect(uptime(sample({ receivedAt: started + (89 * 3600 + 3 * 60) * 1000, wallSeconds: 76 }))).toBe("89h3m")
  expect(uptime(sample({ startedAt: "not a date" }))).toBe("?")
  expect(uptime(null)).toBe("?")
  expect(uptime(sample({ receivedAt: started - 1000 }))).toBe("?")
})

test("freshness shows once in the header, from the newest report", () => {
  const rows = [computeRow(vm({ sample: sample({ sampledAt: 1000 }) })), computeRow(vm({ id: "b", sample: sample({ sampledAt: 4000 }) }))]
  expect(updated(rows, 9000)).toBe("updated 5s ago")
  expect(updated([computeRow(vm({ sample: null }))], 9000)).toBe("waiting for reports")
})

test("guest usage renders immediately and host fallbacks are marked in the table and details", () => {
  const guest = { memUsedMb: 1792, memTotalMb: 16000, diskUsedBytes: 14 * 2 ** 30, diskTotalBytes: 200 * 2 ** 30, at: 3000 }
  const guestVm = vm({ sample: sample({ guest }) })
  expect(computeRow(guestVm).memoryUsedMb).toBe(1792)
  const state = updateState(initialState(), response([guestVm]))
  const table = renderTop(state, 160, 24)
  expect(table).toContain("MEM")
  expect(table).not.toContain("MEM AVG")
  expect(table).toContain("1.8G/8.0G")
  expect(table).toContain("14G/200G")
  expect(table).not.toContain("~")
  const details = renderTop({ ...state, detail: true }, 200, 24, true)
  expect(details).toContain("memory: guest used")
  expect(details).toContain("guest total")
  expect(details).toContain("guest filesystems")
  const fallback = renderTop(fixture(), 160, 24)
  expect(fallback).toContain("2.0G/8.0G~")
  expect(fallback).toContain("1.0G/30G~")
  const fallbackDetails = renderTop({ ...fixture(), detail: true }, 200, 24, true)
  expect(fallbackDetails).toContain("host interval average")
  expect(fallbackDetails).toContain("host backing file")
  const recovered = updateState(state, response([nextVm()]))
  expect(recovered.rows[0]?.memoryUsedMb).toBe(2048)
})

test("duplicate polls update memory when guest usage expires or becomes available", () => {
  const guest = { memUsedMb: 1792, memTotalMb: 16000, diskUsedBytes: 14 * 2 ** 30, diskTotalBytes: 200 * 2 ** 30, at: 3000 }
  const reported = vm({ sample: { ...nextVm().sample!, guest } })
  const state = updateState(updateState(initialState(), response([vm()])), response([reported]))
  const expired = updateState(state, response([nextVm()], 63_000))
  expect(expired.rows[0]?.memoryUsedMb).toBeNull()
  expect(expired.rows[0]?.cpuPercent).toBe(50)
  expect(expired.history).toEqual(state.history)
  expect(renderTop(expired, 80, 24)).toContain("?/8.0G~")
  const recovered = updateState(expired, response([reported]))
  expect(recovered.rows[0]?.memoryUsedMb).toBe(1792)
  expect(recovered.history).toEqual(state.history)
})

test("compact disk cells retain the host fallback marker when allocation is 200 GiB", () => {
  const state = { ...fixture(), rows: fixture().rows.map((row) => ({ ...row, diskGb: 200 })) }
  for (let width = 75; width < 100; width++) {
    const lines = renderTop(state, width, 24).split("\n")
    const start = lines[1]!.indexOf("DISK")
    const disk = lines[2]!.slice(start, start + 9)
    expect(disk).toBe("1.0G/20…~")
    expect(Array.from(lines[2]!).length).toBeLessThanOrEqual(width)
  }
})

test("compact memory cells retain the host fallback marker at 1000 MiB", () => {
  const state = updateState(updateState(initialState(), response([vm()], 1000)), response([
    vm({ sample: sample({ sampledAt: 3000, wallSeconds: 3, memMbSeconds: 3024 }) }),
  ]))
  expect(state.rows[0]?.memoryUsedMb).toBe(1000)
  for (let width = 75; width < 100; width++) {
    const lines = renderTop(state, width, 24).split("\n")
    const start = lines[1]!.indexOf("MEM")
    expect(lines[2]!.slice(start, start + 13)).toBe("░░ 1000M/8.…~")
    expect(Array.from(lines[2]!).length).toBeLessThanOrEqual(width)
  }
})

test("stats memory has no fallback marker while absent guest disk keeps its marker", () => {
  const guest = { memUsedMb: 1792, memTotalMb: 16000, at: 3000 }
  const state = updateState(initialState(), response([vm({ sample: sample({ guest }) })]))
  expect(state.rows[0]?.memoryUsedMb).toBe(1792)
  const table = renderTop(state, 160, 24)
  expect(table).toContain("1.8G/8.0G")
  expect(table).not.toContain("1.8G/8.0G~")
  expect(table).toContain("1.0G/30G~")
  const detail = renderTop({ ...state, detail: true }, 200, 24, true)
  expect(detail).toContain("memory: guest used")
  expect(detail).toContain("disk~: 1.0G/30G (host backing file)")
  const diskOnly = updateState(state, response([vm({ sample: sample({ guest: { diskUsedBytes: 14 * 2 ** 30, diskTotalBytes: 200 * 2 ** 30, at: 3000 } }) })]))
  expect(diskOnly.rows[0]?.memoryUsedMb).toBeNull()
  expect(renderTop(diskOnly, 160, 24)).toContain("?/8.0G~")
  expect(renderTop(diskOnly, 160, 24)).toContain("14G/200G")
  expect(renderTop(diskOnly, 160, 24)).not.toContain("14G/200G~")
})
