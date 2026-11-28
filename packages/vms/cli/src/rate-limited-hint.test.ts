import { afterEach, expect, spyOn, test } from "bun:test"
import { ApiError, VmsClient } from "./api"

/** a 429 rate_limited reads as the server's own message alone, never a hint to remove sandboxes; other 429s keep their hint */

const restore: Array<() => void> = []
afterEach(() => {
  while (restore.length) restore.pop()!()
})

function answering(body: unknown, status: number) {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(body, { status })) as unknown as typeof fetch)
  restore.push(() => fetcher.mockRestore())
}

const platform = () => new VmsClient({ url: "https://cloud.kyora.sh", key: "kyora_test" })
const vmd = () => new VmsClient({ url: "https://vmd.example.test", key: "kvms_test" })
const CONCURRENT = /limit of concurrent sandboxes/
const ID = "sb_eu_abc123_xyz"

async function refused(call: () => Promise<unknown>, body: unknown): Promise<string> {
  answering(body, 429)
  const error = await call().catch((caught: unknown) => caught)
  restore.pop()!()
  expect(error).toBeInstanceOf(ApiError)
  return (error as ApiError).message
}

test("a 429 rate_limited is the server's own message alone, on every server it comes from", async () => {
  const cases: Array<[string, () => Promise<unknown>, string, string]> = [
    ["kyora cloud create", () => platform().create({}, { wait: 0 }), "too many sandbox operations; wait briefly and try again", "create sandbox"],
    ["kyora cloud login", () => new VmsClient({ url: "https://cloud.kyora.sh", key: null }).deviceStart("laptop"), "too many logins from this address; wait a minute", "login"],
    ["login before the server is known: guess() is null, so vmd", () => new VmsClient({ url: "https://kyora.example.test", key: null }).deviceStart("laptop"), "too many logins from this address; wait a minute", "login"],
    ["kyora cloud custom domains", () => platform().domainAdd("app.example.com", "web"), "too many custom domain requests; try again in a minute", "add app.example.com"],
    ["kyora-vmd general limiter", () => vmd().destroy(ID), "slow down; retry in 2s", `destroy ${ID}`],
    ["kyora-vmd computer limiter", () => vmd().computer(ID, { action: "screenshot" }), "slow down: this sandbox takes 10 computer calls a second; retry in 1s", `computer screenshot in ${ID}`],
  ]
  for (const [, call, message, action] of cases) {
    expect(await refused(call, { error: "rate_limited", message })).toBe(`${action}: ${message}`)
  }
})

test("a 429 with no code, or another code, keeps its old hint", async () => {
  for (const client of [platform, vmd]) {
    expect(await refused(() => client().destroy(ID), { message: "too many" })).toMatch(CONCURRENT)
    expect(await refused(() => client().destroy(ID), { error: "sandbox_limit", message: "too many" })).toMatch(CONCURRENT)
  }
  expect(await refused(() => platform().destroy(ID), { error: "queue_limit", message: "too many" })).toContain("you already have that many creates waiting for capacity")
  expect(await refused(() => vmd().destroy(ID), { error: "exec_limit", message: "too many" })).toContain("the sandbox has reached its concurrent exec limit")
})
