import { expect, test } from "bun:test"
import { VmsClient } from "./api"

for (const [code, hint] of [
  ["no_capacity", "no capacity is available for that right now; `kyora vms regions` shows the room in each region; ask for less or retry later"],
  ["unschedulable", "the requested size exceeds available capacity, so waiting would not help; ask for less (--cpus, --memory, --disk)"],
  ["queue_limit", "you already have that many creates waiting for capacity; let them finish or stop some"],
  ["queue_full", "the queue for capacity is full; retry in a minute"],
  ["region_unavailable", "capacity is unavailable in that region; `kyora vms regions` lists the regions; --region global uses capacity in any region"],
]) {
  test(`${code} retains its capacity remedy and error fields`, async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: code, message: "capacity unavailable" }, { status: 503 }) })
    try {
      const api = new VmsClient({ url: server.url.toString(), key: "kyora_test", keySource: "test", urlSource: "test", credentials: "/dev/null" })
      await expect(api.list()).rejects.toMatchObject({ status: 503, code })
      await expect(api.list()).rejects.toThrow(hint)
    } finally {
      server.stop(true)
    }
  })
}

test("a refusal the server calls final (retryable: false) keeps its own advice, without the capacity hint", async () => {
  const message = "a lifetime of 36000 s is unavailable here (longest: 8h); choose a shorter --ttl"
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "no_capacity", message, retryable: false }, { status: 503 }) })
  try {
    const api = new VmsClient({ url: server.url.toString(), key: "kyora_test", keySource: "test", urlSource: "test", credentials: "/dev/null" })
    const refused = await api.list().catch((error: Error) => error)
    expect(refused).toMatchObject({ status: 503, code: "no_capacity" })
    expect((refused as Error).message).toEndWith(message)
    expect((refused as Error).message).not.toContain("retry later")
  } finally {
    server.stop(true)
  }
})
