import { describe, expect, test } from "bun:test"
import { client, error, json, sandbox } from "./testing/fake.js"

const NET = "net_0123456789abcdef0123"
const network = { id: NET, name: "backend", cidr: "10.20.0.0/24", gateway: "10.20.0.1", createdAt: "2026-11-04T00:00:00.000Z", memberCount: 1 }

describe("networks", () => {
  test("list, create, get and delete reach their operations and answer the network", async () => {
    const { kyora, requests } = client((request) => {
      if (request.method === "GET" && request.url.pathname === "/v1/networks") return json(200, { networks: [network] })
      if (request.method === "POST") return json(201, { ...network, memberCount: 0 })
      if (request.method === "GET") return json(200, { ...network, members: [{ sandboxId: "sb_1", ip: "10.20.0.5", state: "active" }] })
      return json(204, null)
    })
    expect(await kyora.networks.list()).toEqual([network])
    expect(await kyora.networks.create({ name: "backend", cidr: "10.20.0.0/24" })).toEqual({ ...network, memberCount: 0 })
    expect((await kyora.networks.get(NET)).members).toEqual([{ sandboxId: "sb_1", ip: "10.20.0.5", state: "active" }])
    expect(await kyora.networks.delete(NET)).toBeUndefined()
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual(["GET /v1/networks", "POST /v1/networks", `GET /v1/networks/${NET}`, `DELETE /v1/networks/${NET}`])
    expect(requests[1]!.json).toEqual({ name: "backend", cidr: "10.20.0.0/24" })
  })

  test("a create takes one private network or several", async () => {
    const { kyora, requests } = client(() => json(201, sandbox("sb_1", { privateNetwork: { id: NET, cidr: "10.20.0.0/24", ip: "10.20.0.5" } })))
    const one = await kyora.sandboxes.create({ privateNetwork: { id: NET, ip: "10.20.0.5" } })
    expect(one.privateNetwork).toEqual({ id: NET, cidr: "10.20.0.0/24", ip: "10.20.0.5" })
    await kyora.sandboxes.create({ privateNetworks: [{ id: NET }, { id: "net_fedcba9876543210fedc" }] })
    expect((requests[0]!.json as { privateNetwork: unknown }).privateNetwork).toEqual({ id: NET, ip: "10.20.0.5" })
    expect((requests[1]!.json as { privateNetworks: unknown }).privateNetworks).toEqual([{ id: NET }, { id: "net_fedcba9876543210fedc" }])
  })

  test("an account without private networks gets privnet_not_enabled, not retried", async () => {
    const { kyora, requests } = client(() => error(403, "privnet_not_enabled"))
    const refused = await kyora.networks.list().catch((failure: unknown) => failure)
    expect(refused).toMatchObject({ code: "privnet_not_enabled", status: 403, class: "auth", retryable: false })
    expect(requests).toHaveLength(1)
  })
})
