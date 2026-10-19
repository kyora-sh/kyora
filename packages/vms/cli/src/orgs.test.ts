import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VmsClient } from "./api"
import { loadConfig } from "./config"
import { readCredentials, saveLogin } from "./credentials"
import { orgList, orgUse } from "./orgs"

/** `kyora-vms org ls` / `org use` against a small fake kyora cloud: which stored token commands send */
const PERSONAL = "kyora_personal_000000000000000000000000000000"
const MINTED = "kyora_orgtoken_11111111111111111111111111111"

let home: string
let server: ReturnType<typeof Bun.serve>
let minted: Array<{ org: string; auth: string | null; name: unknown }>

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kyora-vms-test-orgs-"))
  minted = []
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const auth = request.headers.get("authorization")
      // an org's token knows its own org alone; the personal one lists them all
      const acme = { id: "usr_acme", login: "acme", name: "Acme Inc.", role: "admin", vmsAccess: true }
      if (request.method === "GET" && url.pathname === "/v1/orgs") return Response.json({ orgs: auth === `Bearer ${MINTED}` ? [acme] : [acme, { id: "usr_globex", login: "globex", name: null, role: "member", vmsAccess: false }] })
      const match = /^\/v1\/orgs\/([^/]+)\/tokens$/.exec(url.pathname)
      if (request.method === "POST" && match) {
        if (auth !== `Bearer ${PERSONAL}`) return Response.json({ error: "forbidden", message: "personal tokens only" }, { status: 403 })
        if (match[1] !== "acme") return Response.json({ error: "not_found", message: "no such org" }, { status: 404 })
        minted.push({ org: match[1]!, auth, name: ((await request.json()) as { name?: unknown }).name })
        return Response.json({ token: MINTED, org: { id: "usr_acme", login: "acme" }, login: "acme", actor: "alice", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, { status: 201 })
      }
      return Response.json({ error: "not_found", message: "no such route" }, { status: 404 })
    },
  })
})

afterEach(async () => {
  server.stop(true)
  await rm(home, { recursive: true, force: true })
})

const config = () => loadConfig({ HOME: home, KYORA_VMS_URL: `http://127.0.0.1:${server.port}` }, home)
const credentials = () => join(home, ".config", "kyora", "credentials.json")
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.log
  console.log = () => {}
  try {
    return await work()
  } finally {
    console.log = log
  }
}

test("org use mints an org token with the personal one, keeps both, and switches between them", async () => {
  const origin = `http://127.0.0.1:${server.port}`
  await saveLogin(credentials(), origin, { token: PERSONAL, login: "alice", url: origin })
  expect(await config()).toMatchObject({ key: PERSONAL, org: null })

  expect(await quietly(async () => orgUse(await config(), "acme", false))).toBe(0)
  expect(minted).toEqual([{ org: "acme", auth: `Bearer ${PERSONAL}`, name: expect.stringMatching(/^kyora-vms on /) }])
  expect(await config()).toMatchObject({ key: MINTED, org: "acme" })
  const stored = (await readCredentials(credentials()))[origin]!
  expect(stored).toMatchObject({ token: PERSONAL, login: "alice", use: "acme", orgs: { acme: { token: MINTED, id: "usr_acme", actor: "alice" } } })

  // back to personal, then to the org again: its stored token, nothing minted
  await quietly(async () => orgUse(await config(), "personal", false))
  expect(await config()).toMatchObject({ key: PERSONAL, org: null })
  await quietly(async () => orgUse(await config(), "acme", false))
  expect(minted).toHaveLength(1)
  expect((await config()).key).toBe(MINTED)

  // an org you aren't in
  await expect(orgUse(await config(), "initech", false)).rejects.toThrow("you aren't in an org called initech")

  // org ls lists them all with the personal token, and marks the one in use
  const lines: string[] = []
  const log = console.log
  console.log = (line: string) => lines.push(line)
  try {
    const current = await config()
    expect(await orgList(new VmsClient(current), current, false)).toBe(0)
  } finally {
    console.log = log
  }
  expect(lines).toEqual(["  personal  alice", "* acme  admin  Acme Inc.", "  globex  member  (no vms access)"])
})

test("an org-only login (login --org) has no personal token to fall back to or mint with", async () => {
  const origin = `http://127.0.0.1:${server.port}`
  await saveLogin(credentials(), origin, { token: "", login: "bob", url: origin, orgs: { acme: { token: MINTED, id: "usr_acme", login: "acme", actor: "bob", expiresAt: null } }, use: "acme" })
  expect(await config()).toMatchObject({ key: MINTED, org: "acme" })
  await expect(orgUse(await config(), "personal", false)).rejects.toThrow("there is no personal login")
  await expect(orgUse(await config(), "globex", false)).rejects.toThrow("run kyora-vms login --org globex")
  // a `use` naming an org with no stored token is ignored, never a token sent elsewhere
  await saveLogin(credentials(), origin, { token: PERSONAL, login: "bob", url: origin, use: "ghost" })
  expect(await config()).toMatchObject({ key: PERSONAL, org: null })
})
