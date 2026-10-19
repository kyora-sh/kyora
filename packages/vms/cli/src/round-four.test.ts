/** Round-four regressions: untrusted completion output, bounded list concurrency and rollout errors. */
import { expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError, VmsClient, type Sandbox } from "./api"
import { completion, completionNames } from "./completion"
import { list } from "./session"

test("fresh and cached completion candidates reject malicious names and malformed ids", async () => {
  const candidates = [
    { name: "web" }, { name: "$(touch /tmp/kyora-completion-pwned)" }, { name: "bad\nname" }, { name: "sb_0000000000000001" },
    { id: "sb_0000000000000001" }, { id: "sb_us_abcdef_AbCdEfGhIjKlMnOp" }, { id: "sb_$(echo pwned)" },
  ] as Sandbox[]
  let reads = 0
  const api = { list: async () => {
    reads++
    return candidates
  } } as VmsClient
  const key = randomUUID()
  const expected = ["web", "sb_0000000000000001", "sb_us_abcdef_AbCdEfGhIjKlMnOp"]
  expect(await completionNames(api, key)).toEqual(expected)
  expect(await completionNames(api, key)).toEqual(expected)
  expect(reads).toBe(1)
})

test("bash completion treats substitutions literally and matches the user's prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "kyora-completion-"))
  const marker = join(root, "executed")
  try {
    const script = `${completion("bash")}
kyora-vms() { printf '%s\n' "$CANDIDATES"; }
COMP_WORDS=(kyora-vms attach "")
COMP_CWORD=2
_kyora_vms
COMP_WORDS=(kyora-vms attach "we")
_kyora_vms
printf '%s\n' "\${COMPREPLY[@]}"
`
    const proc = Bun.spawn(["bash", "-c", script], { env: { ...process.env, CANDIDATES: `$(touch ${marker})\nweb\nworker` }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect([out, err, code]).toEqual(["web\n", "", 0])
    expect(await stat(marker).then(() => true, () => false)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ls queries eight terminals concurrently and preserves row order", async () => {
  const sandboxes = Array.from({ length: 19 }, (_, i) => ({ id: `sb_${i.toString(16).padStart(16, "0")}`, name: `box-${i}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), vcpus: 1, memoryMb: 1024, network: "none" } as Sandbox))
  let active = 0
  let peak = 0
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const api = { ttySessions: async (id: string) => {
    active++
    calls++
    peak = Math.max(peak, active)
    await gate
    active--
    if (id === sandboxes[3]!.id) throw new Error("old machine")
    return []
  } } as unknown as VmsClient
  const print = spyOn(console, "log").mockImplementation(() => {})
  const running = list(api, undefined, false, sandboxes)
  try {
    await Bun.sleep(10)
    expect(calls).toBe(8)
  } finally {
    release()
    await running
  }
  try {
    expect(peak).toBe(8)
    expect(calls).toBe(19)
    expect(print.mock.calls.slice(1).map((row) => String(row[0]).trim().split(/\s+/)[0])).toEqual(sandboxes.map((s) => s.name))
    expect(String(print.mock.calls[4]![0])).toMatch(/-$/)
  } finally {
    print.mockRestore()
  }
})

for (const component of ["kyora-node", "kyora-vmd"]) {
  test(`an old ${component} gives a clear metadata update hint`, async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: component === "kyora-node" ? "unknown_method" : "invalid_request", message: component === "kyora-node" ? "unknown method metadata" : "only cpuLimit, memoryMb and autoscale can change (not ttlSeconds)" }, { status: 400 }) })
    try {
      const api = new VmsClient({ url: server.url.toString(), key: component === "kyora-node" ? "kyora_test" : "kvms_test", keySource: "test", urlSource: "test", credentials: "/dev/null" })
      await expect(api.update("sb_0000000000000001", { ttlSeconds: 3600 })).rejects.toMatchObject({ message: "sandbox metadata changes are unavailable on this server; update the machine software", status: 409, code: `${component}_update_required` })
    } finally {
      server.stop(true)
    }
  })
}

test("a modern daemon's TTL cap error is preserved", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "invalid_request", message: "ttlSeconds exceeds this key's cap" }, { status: 400 }) })
  try {
    const api = new VmsClient({ url: server.url.toString(), key: "kvms_test", keySource: "test", urlSource: "test", credentials: "/dev/null" })
    await expect(api.update("sb_0000000000000001", { ttlSeconds: 100_000 })).rejects.toMatchObject({ status: 400, code: "invalid_request" })
    await expect(api.update("sb_0000000000000001", { ttlSeconds: 100_000 })).rejects.toThrow("ttlSeconds exceeds this key's cap")
  } finally {
    server.stop(true)
  }
})

test("a cloud-routed old kyora-vmd keeps the update hint, not the busy hint", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "vmd_update_required", message: "metadata changes are unavailable for this sandbox" }, { status: 409 }) })
  try {
    const api = new VmsClient({ url: server.url.toString(), key: "kyora_test", keySource: "test", urlSource: "test", credentials: "/dev/null" })
    const error = await api.update("sb_0000000000000001", { ttlSeconds: 3600 }).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, code } = error as ApiError
    expect({ status, code }).toEqual({ status: 409, code: "vmd_update_required" })
    expect(message).toContain("metadata changes are unavailable for this sandbox; update the machine software, then retry")
    expect(message).not.toContain("one exec at a time")
  } finally {
    server.stop(true)
  }
})
