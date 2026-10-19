import { expect, test } from "bun:test"
import { ApiError, VmsClient } from "./api"
import { reattachPolicy, runExec } from "./exec"

/** Reattaches tolerate raw network failures and still expire while an attach request hangs. */

const policy = { windowMs: 200, baseDelayMs: 5, maxDelayMs: 20, idleMs: 1_000 }
const initial = () => new Response(`${JSON.stringify({ type: "started", id: "a".repeat(32), resumable: true })}\n${JSON.stringify({ type: "detached", reason: "rollout" })}\n`)

test("exec retries network failures and transient error codes even with an unusual status", async () => {
  const failures = [new TypeError("fetch failed"), Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), new ApiError("offline", 409, "node_offline"), new ApiError("vmd restarting", 400, "vmd_unavailable")]
  let attempts = 0
  const api = {
    exec: async () => initial(),
    attach: async () => {
      const failure = failures[attempts++]
      if (failure) throw failure
      return new Response('{"type":"exit","code":7}\n')
    },
    execExited: () => {},
  } as unknown as VmsClient
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 7 })
  expect(attempts).toBe(5)
})

test("a hanging reattach is aborted at the window and gives up with 125", async () => {
  let aborted = false
  const api = {
    exec: async () => initial(),
    attach: async (_id: string, _exec: string, _from: unknown, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(signal.reason)
      }, { once: true })
    }),
  } as unknown as VmsClient
  const at = Date.now()
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 125, error: expect.stringContaining("could not reattach") })
  expect(aborted).toBe(true)
  expect(Date.now() - at).toBeLessThan(1_000)
})

test("the default exec and shell retry window is two minutes", () => {
  const old = process.env.KYORA_VMS_REATTACH_WINDOW_MS
  delete process.env.KYORA_VMS_REATTACH_WINDOW_MS
  try {
    expect(reattachPolicy().windowMs).toBe(120_000)
  } finally {
    if (old !== undefined) process.env.KYORA_VMS_REATTACH_WINDOW_MS = old
  }
})

test("every resumable exec carries a key of its own, and a reattach follows a `started` and `detached` answer", async () => {
  const keys: unknown[] = []
  const api = {
    exec: async (_id: string, request: Record<string, unknown>) => {
      keys.push(request.key)
      return initial()
    },
    attach: async () => new Response('{"type":"exit","code":0}\n'),
    execExited: () => {},
  } as unknown as VmsClient
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 0 })
  expect(await runExec(api, "sb_test", { cmd: ["true"] }, { json: false, policy })).toMatchObject({ code: 0 })
  expect(keys).toHaveLength(2)
  for (const key of keys) expect(key).toMatch(/^kyora-vms:[0-9a-f-]{36}$/)
  expect(keys[0]).not.toBe(keys[1])
  // a caller's own key goes as it is
  await runExec(api, "sb_test", { cmd: ["true"], key: "setup-1" }, { json: false, policy })
  expect(keys[2]).toBe("setup-1")
})

test("an exec the machine never got (exec_not_started) is sent again with the same key; other refusals are answers", async () => {
  const bodies: Array<Record<string, unknown>> = []
  let refusals = 2
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      bodies.push(body)
      if (body.cmd && (body.cmd as string[])[0] === "busy") return Response.json({ error: "exec_busy", message: "busy" }, { status: 409 })
      if (refusals-- > 0) return Response.json({ error: "exec_not_started", message: "the machine reconnected before the command reached it" }, { status: 503 })
      return new Response('{"type":"exit","code":0}\n', { headers: { "content-type": "application/x-ndjson" } })
    },
  })
  try {
    const client = new VmsClient({ url: `http://127.0.0.1:${server.port}`, key: "kyora_test" })
    const response = await client.exec("sb_test", { cmd: ["true"], resumable: true, key: "k-1" })
    expect(response.status).toBe(200)
    expect(bodies.map((body) => body.key)).toEqual(["k-1", "k-1", "k-1"])
    await expect(client.exec("sb_test", { cmd: ["busy"], resumable: true, key: "k-2" })).rejects.toMatchObject({ code: "exec_busy" })
    expect(bodies).toHaveLength(4)
  } finally {
    server.stop(true)
  }
})
