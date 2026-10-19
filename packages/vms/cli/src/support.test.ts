import { afterEach, expect, test } from "bun:test"
import { VmsClient } from "./api"
import { loadConfig } from "./config"
import { parseSupportArgs, supportCommand } from "./support"

const log = console.log
const realFetch = globalThis.fetch
afterEach(() => { console.log = log; globalThis.fetch = realFetch })
const ticket = { id: "sup_abc", subject: "Raise my limit", category: "spend_limit", status: "open", createdAt: "2026-10-13T12:00:00Z", messages: [{ authorId: "usr_alice", authorKind: "user", body: "Please raise it", createdAt: "2026-10-13T12:00:00Z" }] }

test("support parses new, list, show and reply arguments and rejects incomplete commands", () => {
  expect(parseSupportArgs(["new", "--subject", "Raise my limit", "--category", "spend_limit", "--message", "Please raise it"]).values.category).toBe("spend_limit")
  expect(parseSupportArgs(["ls", "--json"]).values.json).toBe(true)
  expect(parseSupportArgs(["show", "sup_abc"]).positionals).toEqual(["show", "sup_abc"])
  expect(parseSupportArgs(["reply", "sup_abc", "--message", "Details"]).values.message).toBe("Details")
  expect(parseSupportArgs(["--help"]).values.help).toBe(true)
  for (const args of [[], ["new"], ["new", "--subject", "Hi", "--message", "Yo", "--category", "unknown"], ["ls", "extra"], ["show"], ["show", "../../admin"], ["reply", "sup_abc"], ["ls", "--message", "Hello"], ["reply", "sup_abc", "--subject", "No", "--message", "Hello"], ["new", "--subject", "x".repeat(201), "--message", "Hello"], ["reply", "sup_abc", "--message", "x".repeat(10_001)]]) expect(() => parseSupportArgs(args)).toThrow()
})

test("support output includes list rows, threads, creation and reply results, and JSON", async () => {
  const lines: string[] = []
  console.log = (...values: unknown[]) => lines.push(values.join(" "))
  const calls: unknown[] = []
  const api = { supportRequest: async (method: "GET" | "POST", id?: string, body?: unknown) => {
    calls.push({ method, id, body })
    return !id && method === "GET" ? { tickets: [ticket] } : { ticket }
  } }
  await supportCommand(api, ["ls"])
  expect(lines).toEqual(["sup_abc  open  spend_limit  Raise my limit"])
  lines.length = 0
  await supportCommand(api, ["show", "sup_abc"])
  expect(lines[1]).toContain("user (usr_alice)")
  expect(lines[1]).toContain("Please raise it")
  await supportCommand(api, ["new", "--subject", "Hi", "--message", "Help"])
  await supportCommand(api, ["reply", "sup_abc", "--message", "Details"])
  expect(calls.slice(-2)).toEqual([{ method: "POST", id: undefined, body: { subject: "Hi", category: "general", message: "Help" } }, { method: "POST", id: "sup_abc", body: { message: "Details" } }])
  lines.length = 0
  await supportCommand(api, ["show", "sup_abc", "--json"])
  expect(JSON.parse(lines.join("\n"))).toEqual({ ticket })
  lines.length = 0
  await supportCommand({ supportRequest: async () => ({ tickets: [] }) }, ["ls"])
  expect(lines).toEqual(["No support tickets."])
})

test("client sends account credentials, API routes and JSON bodies without a server", async () => {
  const calls: Array<{ url: string; method?: string; auth: string | null; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json(init?.method === "GET" && String(input).endsWith("/tickets") ? { tickets: [ticket] } : { ticket })
  }) as typeof fetch
  const api = new VmsClient(await loadConfig({ KYORA_VMS_URL: "https://cloud.kyora.sh", KYORA_TOKEN: "kyora_test" }, "/tmp/kyora-support-test"))
  await api.supportRequest("POST", undefined, { subject: "Hi", category: "general", message: "Hello" })
  await api.supportRequest("GET")
  await api.supportRequest("GET", "sup_abc")
  await api.supportRequest("POST", "sup_abc", { message: "Details" })
  expect(calls.map((c) => [c.method, c.url, c.auth])).toEqual([
    ["POST", "https://cloud.kyora.sh/v1/support/tickets", "Bearer kyora_test"],
    ["GET", "https://cloud.kyora.sh/v1/support/tickets", "Bearer kyora_test"],
    ["GET", "https://cloud.kyora.sh/v1/support/tickets/sup_abc", "Bearer kyora_test"],
    ["POST", "https://cloud.kyora.sh/v1/support/tickets/sup_abc/messages", "Bearer kyora_test"],
  ])
  expect(calls[0]?.body).toEqual({ subject: "Hi", category: "general", message: "Hello" })
  expect(calls[3]?.body).toEqual({ message: "Details" })
})


test("support threads identify deleted authors", async () => {
  const lines: string[] = []
  console.log = (...values: unknown[]) => lines.push(values.join(" "))
  const deleted = { ...ticket, messages: [{ ...ticket.messages[0]!, authorId: null }] }
  await supportCommand({ supportRequest: async () => ({ ticket: deleted }) }, ["show", "sup_abc"])
  expect(lines[1]).toContain("user (deleted user)")
})

test("support show pages through older messages and exposes the cursor in JSON", async () => {
  const lines: string[] = []
  console.log = (...values: unknown[]) => lines.push(values.join(" "))
  const messages = Array.from({ length: 101 }, (_, i) => ({ ...ticket.messages[0]!, id: i + 1, body: `Message ${i + 1}` }))
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    urls.push(url.pathname + url.search)
    const before = Number(url.searchParams.get("before_message") ?? 102)
    const remaining = messages.filter((message) => message.id < before)
    const page = remaining.slice(-50)
    return Response.json({ ticket: { ...ticket, messages: page, nextMessageBefore: remaining.length > 50 ? page[0]!.id : null } })
  }) as typeof fetch
  const api = new VmsClient(await loadConfig({ KYORA_VMS_URL: "https://cloud.kyora.sh", KYORA_TOKEN: "kyora_test" }, "/tmp/kyora-support-test"))
  await supportCommand(api, ["show", "sup_abc"])
  expect(lines.slice(1, 51).map((line) => line.split("\n").at(-1))).toEqual(messages.slice(51).map((message) => message.body))
  expect(lines.at(-1)).toBe("Older messages: kyora support show sup_abc --before 52")
  lines.length = 0
  await supportCommand(api, ["show", "sup_abc", "--before", "52", "--json"])
  expect(JSON.parse(lines.join("\n"))).toEqual({ ticket: { ...ticket, messages: messages.slice(1, 51), nextMessageBefore: 2 } })
  lines.length = 0
  await supportCommand(api, ["show", "sup_abc", "--before", "2"])
  expect(lines).toHaveLength(2)
  expect(lines[1]).toEndWith("\nMessage 1")
  expect(urls).toEqual(["/v1/support/tickets/sup_abc", "/v1/support/tickets/sup_abc?before_message=52", "/v1/support/tickets/sup_abc?before_message=2"])
})

test("support accepts valid show cursors and rejects invalid or misplaced cursors", () => {
  for (const before of ["1", "2147483647"]) expect(parseSupportArgs(["show", "sup_abc", "--before", before]).values.before).toBe(before)
  for (const before of ["", "0", "-1", "abc", "1.5", "2147483648"]) expect(() => parseSupportArgs(["show", "sup_abc", "--before", before])).toThrow()
  for (const args of [["ls"], ["new", "--subject", "Hi", "--message", "Help"], ["reply", "sup_abc", "--message", "Details"]]) expect(() => parseSupportArgs([...args, "--before", "52"])).toThrow()
})
