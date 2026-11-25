import { afterEach, expect, test } from "bun:test"
import { ApiError, ApiResponseError, finalRefusal, VmsClient } from "./api"
import { reattachable } from "./exec"
import { retryable } from "./multipart"
import { transient } from "./transfer"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const client = () => new VmsClient({ url: "https://cloud.test", key: "kyora_test" })
const LIFETIME = "a lifetime of 36000 s is unavailable here (longest: 8h); choose a shorter --ttl"

function serve(answer: (path: string) => Response): string[] {
  const paths: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1/health") return Response.json({ version: "kyora-cloud" })
    paths.push(path)
    return answer(path)
  }) as typeof fetch
  return paths
}

test("an error keeps what the body said about retrying, through a response error too", async () => {
  serve(() => Response.json({ error: "no_capacity", message: LIFETIME, retryable: false }, { status: 503 }))
  const refused = (await client().list().catch((error: unknown) => error)) as ApiError
  expect(refused.retryable).toBe(false)
  expect(finalRefusal(refused)).toBe(true)
  expect(new ApiResponseError(refused, {}).retryable).toBe(false)
  serve(() => Response.json({ error: "no_capacity", message: "capacity unavailable", retryable: true }, { status: 503 }))
  const again = (await client().list().catch((error: unknown) => error)) as ApiError
  expect(again.retryable).toBe(true)
  expect(again.message).toContain("retry later")
  serve(() => Response.json({ error: "no_capacity", message: "capacity unavailable" }, { status: 503 }))
  expect(((await client().list().catch((error: unknown) => error)) as ApiError).retryable).toBeUndefined()
})

test("no retry predicate goes on after a final refusal", () => {
  for (const status of [0, 429, 502, 503, 504]) {
    const said = new ApiError("refused", status, "no_capacity", undefined, false)
    const unsaid = new ApiError("refused", status, "no_capacity")
    expect([retryable(said), transient(said), reattachable(said)]).toEqual([false, false, false])
    expect(retryable(unsaid)).toBe(true)
    if (status !== 429) expect(reattachable(unsaid)).toBe(true)
  }
})

test("a GET answered do_reset with retryable: false is not asked again", async () => {
  const paths = serve(() => Response.json({ error: "do_reset", message: "no", retryable: false }, { status: 503, headers: { "retry-after": "0" } }))
  await expect(client().list()).rejects.toMatchObject({ code: "do_reset", retryable: false })
  expect(paths).toHaveLength(1)
})

test("a queued create stops polling at a final refusal", async () => {
  let n = 0
  const paths = serve(() => n++ === 0
    ? Response.json({ status: "queued", ticket: "tkt_1", position: 1 }, { status: 202 })
    : Response.json({ error: "internal", message: "the ticket is gone", retryable: false }, { status: 502 }))
  await expect(client().create({ image: "default" } as never, { wait: 30 })).rejects.toMatchObject({ code: "internal", retryable: false })
  expect(paths).toHaveLength(2)
})

test("a 429 sandbox_limit keeps its own hint, final or not", async () => {
  for (const extra of [{}, { retryable: false }]) {
    serve(() => Response.json({ error: "sandbox_limit", message: "at your limit", ...extra }, { status: 429 }))
    await expect(client().list()).rejects.toThrow("you are at your limit of concurrent sandboxes; `kyora vms ls`, then `kyora vms rm <id>`")
  }
})
