import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { rm } from "node:fs/promises"
import { baseEnv, cli, tempDir } from "./testing/fixtures"

/** Share commands against a local API fake: fixed grants, TTL parsing, owner operations and name resolution. */
let root: string
let server: Server<unknown>
const calls: Array<{ method: string; path: string; body: unknown }> = []
/** the sandbox was created unshareable: every share create is refused */
let disabled = false
const id = "sb_abcdef_abcdefghijklmnop"
const share = { id: "share_abcdefghijklmnop", stream: "screen", session: null, expiresAt: "2026-10-05T14:00:00Z", url: "https://view.kyora.run/s#kshare_test", wsUrl: "wss://view.kyora.run/s/ws", token: "kshare_test" }

beforeEach(async () => {
  root = await tempDir("shares")
  calls.length = 0
  disabled = false
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : null
    calls.push({ method: request.method, path, body })
    if (path.endsWith("/resolve")) return Response.json({ id })
    if (path === "/v1/sandboxes") return Response.json({ sandboxes: [{ id }] })
    if (request.method === "GET" && !path.endsWith("/shares")) return Response.json({ id })
    if (request.method === "DELETE") return Response.json({ ok: true })
    if (disabled && request.method === "POST") return Response.json({ error: "share_disabled", message: "sharing was disabled when this sandbox was created and cannot be enabled" }, { status: 403 })
    return Response.json(request.method === "GET" ? { shares: [{ ...share, url: undefined, wsUrl: undefined, token: undefined }] } : { ...share, ...body }, { status: request.method === "POST" ? 201 : 200 })
  } })
})
afterEach(async () => {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
})
const run = (args: string[]) => cli(args, { cwd: root, env: baseEnv(server.url.toString(), { HOME: root }) })

test("screen and tty shares print only the URL and parse durations", async () => {
  const screen = await run(["share", id, "screen", "--ttl", "2h"])
  expect(screen.code).toBe(0)
  expect(screen.stdout.trim()).toBe(share.url)
  expect(calls[0]).toEqual({ method: "POST", path: `/v1/sandboxes/${id}/shares`, body: { stream: "screen", ttlSeconds: 7200 } })
  const tty = await run(["share", id, "tty:agent", "--ttl", "1h30m", "--json"])
  expect(tty.code).toBe(0)
  expect(JSON.parse(tty.stdout)).toMatchObject({ stream: "tty", session: "agent" })
  expect(calls[1]!.body).toEqual({ stream: "tty", session: "agent", ttlSeconds: 5400 })
  expect((await run(["share", id, "screen"])).code).toBe(0)
  expect(calls[2]!.body).toEqual({ stream: "screen" })
  expect((await run(["share", "--", "-my-run", "screen"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen" })
})

test("another X display: --socket, --xauthority and --quality go to the API, checked for their shape only", async () => {
  expect((await run(["share", id, "screen", "--socket", "/run/app/.X11-unix/X2", "--xauthority", "/run/app/.Xauthority", "--quality", "low"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", display: { socket: "/run/app/.X11-unix/X2", xauthority: "/run/app/.Xauthority" }, quality: "low" })
  expect((await run(["share", id, "screen", "--socket", "/run/app/.X11-unix/X3"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", display: { socket: "/run/app/.X11-unix/X3" } })
  const made = calls.length
  for (const args of [["screen", "--socket", "relative"], ["screen", "--socket", "/a/../X1"], ["screen", "--xauthority", "/a/x"], ["tty:main", "--socket", "/a/X1"], ["screen", "--quality", "grid"]]) expect((await run(["share", id, ...args])).code).not.toBe(0)
  expect(calls).toHaveLength(made)
})

test("--mode broadcast or vnc goes to the API as the share's mode, only when given, and only for a screen", async () => {
  expect((await run(["share", id, "screen", "--mode", "broadcast"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast" })
  expect((await run(["share", id, "screen", "--mode", "vnc", "--quality", "low"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", quality: "low", mode: "vnc" })
  const made = calls.length
  for (const args of [["screen", "--mode", "webrtc"], ["tty:main", "--mode", "broadcast"]]) expect((await run(["share", id, ...args])).code).not.toBe(0)
  expect(calls).toHaveLength(made)
})

test("--keys full or masked goes to the API as the share's keys, only when given, never with --mode vnc or a terminal", async () => {
  expect((await run(["share", id, "screen", "--mode", "broadcast", "--keys", "full"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", keys: "full" })
  expect((await run(["share", id, "screen", "--keys", "masked"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", keys: "masked" })
  const made = calls.length
  for (const args of [["screen", "--keys", "all"], ["screen", "--mode", "vnc", "--keys", "full"], ["tty:main", "--keys", "full"]]) expect((await run(["share", id, ...args])).code).not.toBe(0)
  expect(calls).toHaveLength(made)
})

test("list shows metadata without a URL, revoke targets only its share, and names and prefixes resolve", async () => {
  const list = await run(["share", "my-run", "--list"])
  expect(list.code).toBe(0)
  expect(list.stdout.trim()).toBe(`${share.id}  screen  ${share.expiresAt}`)
  expect(calls.slice(0, 2).map((call) => call.path)).toEqual(["/v1/sandboxes/my-run", `/v1/sandboxes/${id}/shares`])
  expect((await run(["share", "sb_abc", "--revoke", share.id])).code).toBe(0)
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: `/v1/sandboxes/${id}/shares/${share.id}`, body: null })
  const json = await run(["share", id, "--list", "--json"])
  expect(JSON.parse(json.stdout)).toEqual({ shares: [{ ...share, url: undefined, wsUrl: undefined, token: undefined }] })
})

test("invalid combinations, sessions and TTLs fail before any network call", async () => {
  for (const args of [[], [id], [id, "tty:"], [id, "tty:../main"], [id, "exec"], [id, "screen", "--ttl", "25h"], [id, "screen", "--ttl", "none"], [id, "screen", "--ttl", "0"], [id, "--list", "--revoke", share.id], [id, "screen", "--list"], [id, "--list", "--ttl", "2h"], [id, "--revoke", ".."], [id, "--revoke", "../.."], [id, "--revoke", "other-id"]]) expect((await run(["share", ...args])).code).not.toBe(0)
  expect(calls).toHaveLength(0)
})

test("a sandbox created with --no-share refuses shares with the server's reason and no access hint", async () => {
  disabled = true
  const refused = await run(["share", id, "screen"])
  expect(refused.code).toBe(125)
  expect(refused.stdout).toBe("")
  expect(refused.stderr).toContain("sharing was disabled when this sandbox was created and cannot be enabled")
  expect(refused.stderr).toContain("--no-share")
  expect(refused.stderr).not.toContain("--network open")
})

/** L1, for the library: a restore or create that asked for shareable: false and wasn't told so is destroyed and refused */
test("VmsClient.create fails closed on an unconfirmed shareable: false, for creates and restores alike", async () => {
  const { ApiError, VmsClient } = await import("./library")
  const seen: Array<{ method: string; path: string }> = []
  let confirm = false
  const legacy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    seen.push({ method: request.method, path })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const body = await request.json() as Record<string, unknown>
    // a server from before the flag: no `shareable` in its answer (a restore answers 202, starting)
    const sandbox = { id: "sb_abcdef_abcdefghijklmnop", status: body.fromSnapshot ? "starting" : "running", ...(confirm ? { shareable: false } : {}) }
    return Response.json(sandbox, { status: body.fromSnapshot ? 202 : 201 })
  } })
  try {
    const client = new VmsClient({ url: legacy.url.toString().replace(/\/$/, ""), key: "kyora_fake" })
    for (const spec of [{ name: "private-run", shareable: false }, { name: "private-restore", shareable: false, fromSnapshot: "snap_abcdefghijklmnop" }]) {
      const failed = await client.create(spec).then(() => null, (error: unknown) => error)
      expect(failed).toBeInstanceOf(ApiError)
      expect(failed).toMatchObject({ code: "share_policy_unconfirmed" })
      expect(seen.at(-1)).toEqual({ method: "DELETE", path: "/v1/sandboxes/sb_abcdef_abcdefghijklmnop" })
    }
    confirm = true
    expect(await client.create({ name: "private-run", shareable: false })).toMatchObject({ shareable: false })
    expect(seen.at(-1)!.method).toBe("POST")
  } finally {
    legacy.stop(true)
  }
})

test("--record BUCKET[/PREFIX] asks for a recording of the broadcast (a broadcast without --mode), never with --mode vnc or a terminal; the list says how it goes", async () => {
  expect((await run(["share", id, "screen", "--record", "runs/demo/day-1"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", record: { bucket: "runs", prefix: "demo/day-1" } })
  expect((await run(["share", id, "screen", "--mode", "broadcast", "--record", "runs"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", record: { bucket: "runs" } })
  expect((await run(["share", id, "screen", "--record", "runs/"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", record: { bucket: "runs" } })
  const made = calls.length
  for (const args of [["screen", "--mode", "vnc", "--record", "runs"], ["tty:main", "--record", "runs"], ["screen", "--record", "Bad_Bucket"], ["screen", "--record", "/x"]]) expect((await run(["share", id, ...args])).code).not.toBe(0)
  expect(calls).toHaveLength(made)
})

test("--segment-seconds N sets the recording's segment length (2-10 s), only with --record", async () => {
  expect((await run(["share", id, "screen", "--record", "runs/day-1", "--segment-seconds", "2"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", record: { bucket: "runs", prefix: "day-1", segmentSeconds: 2 } })
  expect((await run(["share", id, "screen", "--record", "runs", "--segment-seconds", "10"])).code).toBe(0)
  expect(calls.at(-1)!.body).toEqual({ stream: "screen", mode: "broadcast", record: { bucket: "runs", segmentSeconds: 10 } })
  const made = calls.length
  for (const args of [["--record", "runs", "--segment-seconds", "1"], ["--record", "runs", "--segment-seconds", "11"], ["--record", "runs", "--segment-seconds", "2.5"], ["--record", "runs", "--segment-seconds", "x"], ["--segment-seconds", "4"]]) {
    const refused = await run(["share", id, "screen", ...args])
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("--segment-seconds")
  }
  expect(calls).toHaveLength(made)
})
