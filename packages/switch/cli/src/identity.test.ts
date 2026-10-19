import { expect, test } from "bun:test"
import { claudeIdentity, codexIdentity, jwtPayload, opencodeAccount, opencodeIdentity } from "./identity"

function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `header.${body}.signature`
}

test("jwtPayload decodes base64url without padding", () => {
  expect(jwtPayload(token({ email: "a@b.co", sub: "x" }))).toEqual({ email: "a@b.co", sub: "x" })
})

test("jwtPayload returns null on garbage instead of throwing", () => {
  expect(jwtPayload("not-a-jwt")).toBeNull()
  expect(jwtPayload("a.!!!.c")).toBeNull()
  expect(jwtPayload("")).toBeNull()
})

test("codexIdentity reads the account and plan out of the id_token", () => {
  const auth = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token({
        email: "me@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1" },
      }),
      account_id: "acct-1",
    },
  }
  expect(codexIdentity(auth)).toEqual({ account: "me@example.com", plan: "pro" })
})

test("codexIdentity falls back to account_id, and flags api-key auth", () => {
  expect(codexIdentity({ OPENAI_API_KEY: "sk-test", tokens: { account_id: "acct-2" } })).toEqual({
    account: "acct-2",
    plan: "api key",
  })
})

test("codexIdentity survives a missing or malformed auth file", () => {
  expect(codexIdentity(null)).toEqual({ account: undefined, plan: undefined })
  expect(codexIdentity({ tokens: { id_token: "broken" } })).toEqual({ account: undefined, plan: undefined })
})

test("claudeIdentity reads the oauthAccount slice", () => {
  const slice = {
    oauthAccount: { emailAddress: "me@work.dev", organizationName: "Acme", seatTier: "max" },
    userID: "u1",
  }
  expect(claudeIdentity(slice)).toEqual({ account: "me@work.dev", org: "Acme", plan: "max" })
})

test("opencodeIdentity names the login by its Go key, or Zen's when there is no Go entry", () => {
  const go = { type: "api", key: "sk-go-test-1234" }
  const zen = { type: "api", key: "sk-zen-test-9876" }
  expect(opencodeIdentity({ "opencode-go": go })).toEqual({ account: opencodeAccount("sk-go-test-1234"), plan: "Go" })
  expect(opencodeIdentity({ opencode: zen })).toEqual({ account: opencodeAccount("sk-zen-test-9876"), plan: "Zen" })
  expect(opencodeIdentity({ opencode: zen, "opencode-go": go })).toEqual({ account: opencodeAccount("sk-go-test-1234"), plan: "Go + Zen" })
})

test("opencodeIdentity never carries more of the key than its last four characters", () => {
  const identity = opencodeIdentity({ "opencode-go": { type: "api", key: "sk-secret-middle-abcd" } })
  expect(JSON.stringify(identity)).not.toContain("secret")
})

test("opencodeIdentity tells apart keys that share their last four characters", () => {
  const first = opencodeIdentity({ "opencode-go": { type: "api", key: "sk-go-first-abcd" } })
  const second = opencodeIdentity({ "opencode-go": { type: "api", key: "sk-go-second-abcd" } })
  expect(first.account).toStartWith("key …abcd #")
  expect(first.account).not.toBe(second.account)
})

test("opencodeIdentity survives a missing or malformed auth file", () => {
  expect(opencodeIdentity(null)).toEqual({ account: undefined, plan: undefined })
  expect(opencodeIdentity({ "opencode-go": { type: "api" } })).toEqual({ account: undefined, plan: "Go" })
  expect(opencodeIdentity({ "opencode-go": { type: "oauth", accountId: "acct-5678" } })).toEqual({
    account: opencodeAccount("acct-5678"),
    plan: "Go",
  })
})

test("claudeIdentity falls back to the account uuid when there is no email", () => {
  expect(claudeIdentity({ oauthAccount: { accountUuid: "uuid-1", billingType: "team" } })).toEqual({
    account: "uuid-1",
    org: undefined,
    plan: "team",
  })
})
