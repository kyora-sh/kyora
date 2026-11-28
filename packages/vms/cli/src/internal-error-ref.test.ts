import { afterEach, expect, spyOn, test } from "bun:test"
import { ApiError, VmsClient } from "./api"
import { DESTROY_RETRY_MS, destroyQuietly } from "./run"

const restore: Array<() => void> = []
afterEach(() => { while (restore.length) restore.pop()!() })

function answering(body: unknown, status: number) {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(body, { status })) as unknown as typeof fetch)
  restore.push(() => fetcher.mockRestore())
}

const client = () => new VmsClient({ url: "https://cloud.kyora.sh", key: "kyora_test" })

test("an internal error that carries kyora cloud's reference names it, so a report finds its log line", async () => {
  answering({ error: "internal", message: "internal error", ref: "8f0a1b2c3d4e5f60-AMS" }, 500)
  const error = await client().destroy("sb_eu_abc123_xyz").catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).message).toStartWith("destroy sb_eu_abc123_xyz: internal error (ref 8f0a1b2c3d4e5f60-AMS)")
})

test("an answer without a reference, or with one that isn't a plain token, reads as before", async () => {
  for (const ref of [undefined, "<script>", "x".repeat(65)]) {
    answering({ error: "internal", message: "internal error", ...(ref === undefined ? {} : { ref }) }, 500)
    const error = await client().destroy("sb_eu_abc123_xyz").catch((caught: unknown) => caught) as ApiError
    expect({ ref, message: error.message.includes("(ref ") }).toEqual({ ref, message: false })
    restore.pop()!()
  }
})

type Destroy = (id: string) => Promise<boolean>
const fakeApi = (destroy: Destroy) => ({ destroy }) as unknown as Parameters<typeof destroyQuietly>[0]

function stderr() {
  const lines: string[] = []
  const write = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true }) as typeof process.stderr.write)
  restore.push(() => write.mockRestore())
  return lines
}

test("a destroy that fails once is asked again after the wait, and says nothing when the second ask destroys it", async () => {
  const lines = stderr()
  const waits: number[] = []
  let asked = 0
  const destroyed = await destroyQuietly(fakeApi(async () => { if (++asked === 1) throw new ApiError("destroy sb_x: internal error (ref r1)", 500, "internal"); return true }), "sb_x", async (ms) => { waits.push(ms) })
  expect({ destroyed, asked, waits, said: lines.join("") }).toEqual({ destroyed: true, asked: 2, waits: [DESTROY_RETRY_MS], said: "" })
})

test("a destroy that fails twice says loudly that the sandbox is still running and billing, with both errors and the way to stop it", async () => {
  const lines = stderr()
  let asked = 0
  const destroyed = await destroyQuietly(fakeApi(async () => { asked++; throw new ApiError(`destroy sb_x: internal error (ref r${asked})`, 500, "internal") }), "sb_x", async () => {})
  const said = lines.join("")
  expect({ destroyed, asked }).toEqual({ destroyed: false, asked: 2 })
  expect(said).toContain("WARNING: sandbox sb_x is still running")
  expect(said).toContain("(ref r1)")
  expect(said).toContain("(ref r2)")
  expect(said).toContain("keeps running and billing until `kyora vms rm sb_x` stops it")
})

test("a destroy that succeeds at once is asked once and never waits", async () => {
  const waits: number[] = []
  let asked = 0
  expect(await destroyQuietly(fakeApi(async () => { asked++; return true }), "sb_x", async (ms) => { waits.push(ms) })).toBe(true)
  expect({ asked, waits }).toEqual({ asked: 1, waits: [] })
})
