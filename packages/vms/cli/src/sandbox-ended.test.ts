import { afterEach, expect, test } from "bun:test"
import { ApiError, VmsClient } from "./api"
import { sandboxEnded } from "./run"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const ID = "sb_0123456789abcdef"
const client = () => new VmsClient({ url: "https://cloud.test", key: "kyora_test" })
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch
}

test("a 404's ended is why the sandbox ended, whatever its message says", async () => {
  answer(404, { error: "not_found", message: `sandbox ${ID} has ended: reaped`, ended: "reaped on its machine" })
  expect(await client().get(ID).catch((error: unknown) => error)).toMatchObject({ status: 404, code: "not_found", ended: "reaped on its machine" })
  expect(await sandboxEnded(client(), ID)).toBe(`sandbox ${ID} is gone (reaped on its machine)`)
})

test("a server without ended is read from its message, as before", async () => {
  answer(404, { error: "not_found", message: `sandbox ${ID} is gone (expired)` })
  expect(await sandboxEnded(client(), ID)).toBe(`sandbox ${ID} is gone (expired)`)
})

test("any other 404, an empty or non-string ended, or ended on another status proves nothing", async () => {
  answer(404, { error: "not_found", message: "no such sandbox" })
  expect(await sandboxEnded(client(), ID)).toBeNull()
  for (const ended of ["", 7, null]) {
    answer(404, { error: "not_found", message: "no such sandbox", ended })
    expect(await sandboxEnded(client(), ID)).toBeNull()
  }
  answer(409, { error: "starting", message: `sandbox ${ID} is still starting`, ended: "expired" })
  const error = await client().get(ID).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).ended).toBeUndefined()
  expect(await sandboxEnded(client(), ID)).toBeNull()
})
