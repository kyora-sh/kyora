import { describe, expect, test } from "bun:test"
import { client, error, json } from "./testing/fake.js"

const scope = { labels: { team: "docs" } }
const binding = { id: "sb1", secretId: "sec_1", host: "api.example.com", pathPrefix: "/", methods: ["GET"], injection: { type: "header", name: "authorization", template: "Bearer {{secret}}" }, scope, enabled: true, expiresAt: null, createdAt: 1, updatedAt: 1, lastUsedAt: null }
const delivery = { id: "sd1", secretId: "sec_1", kind: "env", target: "API_KEY", mode: null, scope, enabled: true, expiresAt: null, createdAt: 1, updatedAt: 1, lastDeliveredAt: null, visibleToCode: true }
const secret = { id: "sec_1", name: "example", description: "", hosts: ["api.example.com"], sandbox: true, version: 1, createdAt: 1, updatedAt: 1, bindings: [binding], deliveries: [delivery] }

describe("secrets", () => {
  test("every secrets method reaches its operation with its body", async () => {
    const { kyora, requests } = client((request) => {
      const path = request.url.pathname
      if (request.method === "DELETE") return json(200, { deleted: path.split("/").at(-1) })
      if (path === "/v1/secrets" && request.method === "GET") return json(200, { secrets: [secret] })
      if (path.includes("/bindings")) return json(request.method === "POST" ? 201 : 200, binding)
      if (path.includes("/deliveries")) return json(request.method === "POST" ? 201 : 200, delivery)
      return json(request.method === "POST" ? 201 : 200, secret)
    })
    expect((await kyora.secrets.list())[0]!.bindings[0]!.host).toBe("api.example.com")
    expect((await kyora.secrets.get("example")).id).toBe("sec_1")
    await kyora.secrets.create({ name: "example", value: "example-value", hosts: ["api.example.com"], sandbox: true })
    await kyora.secrets.rotate("sec_1", { value: "example-value-2", version: 1 })
    await kyora.secrets.createBinding("sec_1", { host: "api.example.com", injection: { type: "header", name: "Authorization", template: "Bearer {{secret}}" }, scope })
    await kyora.secrets.updateBinding("sec_1", "sb1", { enabled: false })
    await kyora.secrets.deleteBinding("sec_1", "sb1")
    expect((await kyora.secrets.createDelivery("sec_1", { env: "API_KEY", scope })).target).toBe("API_KEY")
    await kyora.secrets.updateDelivery("sec_1", "sd1", { expiresAt: null })
    await kyora.secrets.deleteDelivery("sec_1", "sd1")
    await kyora.secrets.delete("sec_1")
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/secrets",
      "GET /v1/secrets/example",
      "POST /v1/secrets",
      "PUT /v1/secrets/sec_1/value",
      "POST /v1/secrets/sec_1/bindings",
      "PATCH /v1/secrets/sec_1/bindings/sb1",
      "DELETE /v1/secrets/sec_1/bindings/sb1",
      "POST /v1/secrets/sec_1/deliveries",
      "PATCH /v1/secrets/sec_1/deliveries/sd1",
      "DELETE /v1/secrets/sec_1/deliveries/sd1",
      "DELETE /v1/secrets/sec_1",
    ])
    expect(requests[3]!.json).toEqual({ value: "example-value-2", version: 1 })
    expect(requests[5]!.json).toEqual({ enabled: false })
    expect(requests[8]!.json).toEqual({ expiresAt: null })
  })

  test("a rotation that lost the race is a conflict", async () => {
    const { kyora } = client(() => error(409, "secret_changed"))
    const failure = await kyora.secrets.rotate("sec_1", { value: "example-value", version: 1 }).catch((caught: unknown) => caught)
    expect(failure).toMatchObject({ code: "secret_changed", status: 409 })
  })
})
