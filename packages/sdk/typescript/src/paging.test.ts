import { describe, expect, test } from "bun:test"
import { client, json, sandbox } from "./testing/fake.js"

describe("listing", () => {
  test("list sends labels, limit and cursor, and returns the next cursor", async () => {
    const { kyora, requests } = client(() => json(200, { sandboxes: [sandbox("sb_1", { labels: { team: "docs" } })], next_cursor: "c2" }))
    const page = await kyora.sandboxes.list({ labels: { team: "docs", "agent.kind": "reader" }, limit: 50, cursor: "c1" })
    const query = requests[0]!.url.searchParams
    expect(query.getAll("label")).toEqual(["team=docs", "agent.kind=reader"])
    expect(query.get("limit")).toBe("50")
    expect(query.get("cursor")).toBe("c1")
    expect(page.nextCursor).toBe("c2")
    // the row lacks agent.kind: a server that ignored the filter never widens the listing
    expect(page.items).toEqual([])
  })

  test("the last page has no cursor", async () => {
    const { kyora } = client(() => json(200, { sandboxes: [sandbox("sb_1")] }))
    expect((await kyora.sandboxes.list()).nextCursor).toBeNull()
  })

  test("iterate follows next_cursor to the end", async () => {
    const pages: Record<string, { sandboxes: unknown[]; next_cursor?: string }> = {
      "": { sandboxes: [sandbox("sb_1"), sandbox("sb_2")], next_cursor: "p2" },
      p2: { sandboxes: [sandbox("sb_3")], next_cursor: "p3" },
      p3: { sandboxes: [sandbox("sb_4")] },
    }
    const { kyora, requests } = client((request) => json(200, pages[request.url.searchParams.get("cursor") ?? ""]))
    const ids: string[] = []
    for await (const found of kyora.sandboxes.iterate({ limit: 2 })) ids.push(found.id)
    expect(ids).toEqual(["sb_1", "sb_2", "sb_3", "sb_4"])
    expect(requests.map((request) => request.url.searchParams.get("cursor"))).toEqual([null, "p2", "p3"])
    expect(requests.every((request) => request.url.searchParams.get("limit") === "2")).toBe(true)
  })

  test("iterate stops early without fetching further pages", async () => {
    const { kyora, requests } = client(() => json(200, { sandboxes: [sandbox("sb_1"), sandbox("sb_2")], next_cursor: "more" }))
    for await (const found of kyora.sandboxes.iterate()) if (found.id === "sb_1") break
    expect(requests.length).toBe(1)
  })

  test("a cursor that comes back again is an error, not a loop", async () => {
    const { kyora } = client(() => json(200, { sandboxes: [sandbox("sb_1")], next_cursor: "same" }))
    const ids: string[] = []
    const failure = await (async () => {
      for await (const found of kyora.sandboxes.iterate()) ids.push(found.id)
    })().catch((caught: unknown) => caught)
    expect(failure).toMatchObject({ code: "bad_response" })
    expect(ids).toEqual(["sb_1", "sb_1"])
  })

  test("snapshots page the same way", async () => {
    const snap = (id: string) => ({ id, kind: "fs", status: "ready", name: null, sandbox: "sb_1", bytes: 1, logicalBytes: 1, dataBytes: 1, image: null, resumable: false, createdAt: "x", expiresAt: "y" })
    const { kyora, requests } = client((request) => json(200, request.url.searchParams.get("cursor") ? { snapshots: [snap("snap_2")] } : { snapshots: [snap("snap_1")], next_cursor: "n" }))
    const ids: string[] = []
    for await (const found of kyora.snapshots.iterate({ labels: { run: "7" } })) ids.push(found.id)
    expect(ids).toEqual(["snap_1", "snap_2"])
    expect(requests[0]!.url.pathname).toBe("/v1/snapshots")
    expect(requests[1]!.url.searchParams.getAll("label")).toEqual(["run=7"])
  })
})
