import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cooldownRemainingMs, lastRunAt, loadUsage, looksRateLimited, markRun, resetHintMs } from "./state"
import {
  codexCredentials,
  grokUsage,
  MUSE_UNAUTHORIZED,
  museTeams,
  museUsage,
  opencodeAuthPath,
  opencodeGoUsage,
  opencodeKey,
  parseClaudeOauthUsage,
  parseCodexUsage,
  parseGrokBilling,
  parseMuseQuota,
  parseMuseTeams,
  parseOpencodeGoUsage,
  parseQuotaWindows,
  parseTokenPlanUsage,
  parseZaiQuota,
} from "./quota"

beforeEach(() => {
  process.env.KYORA_REVIEW_STATE_DIR = mkdtempSync(join(tmpdir(), "kyora-usage-"))
})

describe("usage state", () => {
  test("rate_limited sets a cooldown, ok clears it", () => {
    markRun("codex", "rate_limited", 60_000)
    expect(cooldownRemainingMs("codex")).toBeGreaterThan(0)
    markRun("codex", "ok", 60_000)
    expect(cooldownRemainingMs("codex")).toBe(0)
    expect(loadUsage().engines.codex!.runs).toBe(2)
  })

  test("lastRunAt orders engines for rotation", () => {
    markRun("grok", "ok", 0)
    expect(lastRunAt("grok")).toBeGreaterThan(0)
    expect(lastRunAt("never-ran")).toBe(0)
  })

  test("missing state file reads as empty", () => {
    expect(loadUsage()).toEqual({ engines: {} })
    expect(cooldownRemainingMs("codex")).toBe(0)
  })
})

describe("looksRateLimited", () => {
  test("matches vendor limit messages", () => {
    expect(looksRateLimited("Claude usage limit reached. Your limit resets at 7pm")).toBe(true)
    expect(looksRateLimited("HTTP 429 Too Many Requests")).toBe(true)
    expect(looksRateLimited("insufficient_quota: You exceeded your current quota")).toBe(true)
    expect(looksRateLimited("You've hit your usage limit.")).toBe(true)
  })

  test("ignores ordinary failures", () => {
    expect(looksRateLimited("SyntaxError: unexpected token")).toBe(false)
    expect(looksRateLimited("exit 1: command not found")).toBe(false)
  })
})

describe("parseTokenPlanUsage", () => {
  test("finds used/total pairs regardless of casing and nesting", () => {
    const payload = { code: 200, data: { subscription: { UsedCredit: 250, TotalCredit: 1000 } } }
    expect(parseTokenPlanUsage(payload)).toEqual({ remainingPct: 75, detail: "750 of 1,000 credits left" })
  })

  test("returns null for empty or zero-total payloads", () => {
    expect(parseTokenPlanUsage({ data: { totalCount: 0 } })).toBeNull()
    expect(parseTokenPlanUsage(null)).toBeNull()
    expect(parseTokenPlanUsage("<html>login</html>")).toBeNull()
  })
})

describe("parseQuotaWindows", () => {
  test("collects windows and reports the tightest one", () => {
    const payload = {
      usage: { limit: 2048, used: 512, remaining: 1536, resetTime: "2026-08-03T00:00:00Z" },
      limits: [{ window: "5h", limit: 200, used: 190, remaining: 10 }],
    }
    const live = parseQuotaWindows(payload)
    expect(live!.remainingPct).toBe(5)
    expect(live!.detail).toContain("512/2,048")
    expect(live!.detail).toContain("190/200 5h")
  })

  test("returns null when no used/limit pairs exist", () => {
    expect(parseQuotaWindows({ message: "ok" })).toBeNull()
    expect(parseQuotaWindows(null)).toBeNull()
  })
})

describe("parseZaiQuota", () => {
  test("reads percentage windows from the live monitor shape", () => {
    const payload = {
      code: 200,
      data: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 0, remaining: 100, percentage: 12 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 87 },
        ],
      },
    }
    const live = parseZaiQuota(payload)
    expect(live!.remainingPct).toBe(13)
    expect(live!.detail).toBe("time 12% used · tokens 87% used")
  })

  test("falls back to used/limit pairs when no percentages exist", () => {
    expect(parseZaiQuota({ data: { used: 30, limit: 100 } })!.remainingPct).toBe(70)
  })
})

describe("parseClaudeOauthUsage", () => {
  test("reads window utilization in fraction or percent form", () => {
    const live = parseClaudeOauthUsage({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 61 } })
    expect(live!.remainingPct).toBe(39)
    expect(live!.detail).toBe("5h 42% used · 7d 61% used")
  })

  test("returns null without usable windows", () => {
    expect(parseClaudeOauthUsage({ subscriptionType: "max" })).toBeNull()
  })
})

describe("resetHintMs", () => {
  test("parses duration hints", () => {
    expect(resetHintMs("Please try again in 3 hours.")).toBe(3 * 3_600_000)
    expect(resetHintMs("retry after 90 seconds")).toBe(90_000)
    expect(resetHintMs("resets in 45 minutes")).toBe(45 * 60_000)
  })

  test("returns null without a parseable duration", () => {
    expect(resetHintMs("limit resets at 7pm")).toBeNull()
    expect(resetHintMs("try again later")).toBeNull()
  })
})

describe("parseClaudeOauthUsage", () => {
  test("prefers the limits array, so a model-scoped weekly window is not missed", () => {
    const parsed = parseClaudeOauthUsage({
      five_hour: { utilization: 49, resets_at: "2026-09-08T03:40:00.011853+00:00" },
      seven_day: { utilization: 32, resets_at: "2026-09-12T09:00:00.011875+00:00" },
      limits: [
        { kind: "session", group: "session", percent: 49, resets_at: "2026-09-08T03:40:00.011853+00:00", scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 32, resets_at: "2026-09-12T09:00:00.011875+00:00", scope: null, is_active: false },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 62,
          resets_at: "2026-09-12T09:00:00.012118+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ],
    })
    expect(parsed?.windows?.map((w) => w.label)).toEqual(["session", "weekly", "weekly Fable"])
    expect(parsed?.windows?.find((w) => w.label === "weekly Fable")).toEqual({
      label: "weekly Fable",
      usedPct: 62,
      resetsAt: Date.parse("2026-09-12T09:00:00.012118+00:00"),
      active: true,
    })
    expect(parsed?.remainingPct).toBe(38)
  })

  test("falls back to the top-level windows when there is no limits array", () => {
    const parsed = parseClaudeOauthUsage({
      five_hour: { utilization: 32, resets_at: "2026-09-08T03:39:59.660912+00:00" },
      seven_day: { utilization: 30 },
    })
    expect(parsed?.remainingPct).toBe(68)
    expect(parsed?.windows).toEqual([
      { label: "5h", usedPct: 32, resetsAt: Date.parse("2026-09-08T03:39:59.660912+00:00") },
      { label: "7d", usedPct: 30, resetsAt: undefined },
    ])
  })

  test("skips windows the payload leaves null and reports nothing when all are", () => {
    expect(parseClaudeOauthUsage({ five_hour: { utilization: 45 }, seven_day: null })?.remainingPct).toBe(55)
    expect(parseClaudeOauthUsage({ five_hour: null, seven_day: null })).toBeNull()
    expect(parseClaudeOauthUsage(null)).toBeNull()
  })
})

describe("parseCodexUsage", () => {
  const payload = {
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 73, limit_window_seconds: 604800, reset_at: 1789321995 },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1788843816 },
          secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 1789430616 },
        },
      },
    ],
  }

  test("labels windows by length and keeps named sub-limits", () => {
    const parsed = parseCodexUsage(payload)
    expect(parsed?.windows).toEqual([
      { label: "7d", usedPct: 73, resetsAt: 1789321995000 },
      { label: "GPT-5.3-Codex-Spark 5h", usedPct: 4, resetsAt: 1788843816000 },
      { label: "GPT-5.3-Codex-Spark 7d", usedPct: 9, resetsAt: 1789430616000 },
    ])
    expect(parsed?.remainingPct).toBe(27)
  })

  test("returns null when no window carries a percentage", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toBeNull()
    expect(parseCodexUsage(null)).toBeNull()
  })
})

describe("codexCredentials", () => {
  test("takes the access token and account id, rejecting anything else", () => {
    expect(codexCredentials(JSON.stringify({ tokens: { access_token: "t", account_id: "a" } }))).toEqual({
      token: "t",
      account: "a",
    })
    expect(codexCredentials(JSON.stringify({ tokens: { access_token: "t" } }))).toBeNull()
    expect(codexCredentials("not json")).toBeNull()
  })
})

describe("parseOpencodeGoUsage", () => {
  // the shape `GET /zen/go/v1/usage` returns: console routes/zen/go/v1/usage.ts
  const payload = {
    usage: {
      rolling: { status: "ok", percent: 12, resetsAt: "2026-09-30T04:12:09.000Z" },
      weekly: { status: "ok", percent: 41, resetsAt: "2026-10-05T00:00:00.000Z" },
      monthly: { status: "ok", percent: 63, resetsAt: "2026-10-16T12:14:01.000Z" },
    },
  }

  test("reads the five-hour, weekly and monthly windows, tightest wins", () => {
    const parsed = parseOpencodeGoUsage(payload)
    expect(parsed?.windows).toEqual([
      { label: "5h", usedPct: 12, resetsAt: Date.parse("2026-09-30T04:12:09.000Z") },
      { label: "weekly", usedPct: 41, resetsAt: Date.parse("2026-10-05T00:00:00.000Z") },
      { label: "monthly", usedPct: 63, resetsAt: Date.parse("2026-10-16T12:14:01.000Z") },
    ])
    expect(parsed?.remainingPct).toBe(37)
    expect(parsed?.detail).toBe("5h 12% used · weekly 41% used · monthly 63% used")
  })

  test("a rate-limited window counts as spent, whatever its percent says", () => {
    const parsed = parseOpencodeGoUsage({
      usage: { ...payload.usage, rolling: { status: "rate-limited", percent: 99, resetsAt: "2026-09-30T04:12:09.000Z" } },
    })
    expect(parsed?.windows?.[0]?.usedPct).toBe(100)
    expect(parsed?.remainingPct).toBe(0)
  })

  test("skips malformed windows and returns null without any", () => {
    const parsed = parseOpencodeGoUsage({ usage: { rolling: { percent: "12" }, weekly: null, monthly: { percent: 5 } } })
    expect(parsed?.windows).toEqual([{ label: "monthly", usedPct: 5, resetsAt: undefined }])
    expect(parseOpencodeGoUsage({ usage: {} })).toBeNull()
    expect(parseOpencodeGoUsage({ type: "error", error: { type: "EntitlementError" } })).toBeNull()
    expect(parseOpencodeGoUsage(null)).toBeNull()
  })
})

describe("opencodeKey", () => {
  const auth = JSON.stringify({
    openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    "opencode-go": { type: "api", key: "sk-go-test" },
    opencode: { type: "api", key: "sk-zen-test" },
  })

  test("picks the Go key by default and Zen on request", () => {
    expect(opencodeKey(auth)).toBe("sk-go-test")
    expect(opencodeKey(auth, "opencode")).toBe("sk-zen-test")
  })

  test("returns undefined for a missing entry, an oauth entry or broken JSON", () => {
    expect(opencodeKey(JSON.stringify({ opencode: { type: "api", key: "sk-zen-test" } }))).toBeUndefined()
    expect(opencodeKey(JSON.stringify({ "opencode-go": { type: "oauth", access: "a" } }))).toBeUndefined()
    expect(opencodeKey("{not json")).toBeUndefined()
  })
})

describe("opencodeAuthPath", () => {
  test("follows XDG_DATA_HOME the way opencode does", () => {
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = "/tmp/xdg-data"
    try {
      expect(opencodeAuthPath()).toBe("/tmp/xdg-data/opencode/auth.json")
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
  })
})

describe("opencodeGoUsage", () => {
  test("sends the key as a bearer token and reads the windows back", async () => {
    const seen: (string | null)[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const authorization = request.headers.get("authorization")
        seen.push(authorization)
        if (authorization !== "Bearer sk-go-test") {
          return Response.json({ type: "error", error: { type: "AuthError" } }, { status: 401 })
        }
        return Response.json({ usage: { rolling: { status: "ok", percent: 30, resetsAt: "2026-09-30T04:12:09.000Z" } } })
      },
    })
    const previous = process.env.KYORA_OPENCODE_USAGE_URL
    process.env.KYORA_OPENCODE_USAGE_URL = server.url.href
    try {
      expect((await opencodeGoUsage("sk-go-test"))?.remainingPct).toBe(70)
      expect(await opencodeGoUsage("sk-wrong")).toBeNull()
      expect(seen).toEqual(["Bearer sk-go-test", "Bearer sk-wrong"])
    } finally {
      if (previous === undefined) delete process.env.KYORA_OPENCODE_USAGE_URL
      else process.env.KYORA_OPENCODE_USAGE_URL = previous
    }
  })
})

describe("parseGrokBilling", () => {
  test("reads the credits percentage and the current period", () => {
    const end = "2026-10-20T00:00:00Z"
    expect(parseGrokBilling({ config: { creditUsagePercent: 42.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-13T00:00:00Z", end } } })).toEqual({
      remainingPct: 57,
      detail: "weekly 43% used",
      windows: [{ label: "weekly", usedPct: 43, resetsAt: Date.parse(end) }],
    })
  })

  test("a period with no percentage is one with nothing used yet", () => {
    expect(parseGrokBilling({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } })?.windows).toEqual([{ label: "monthly", usedPct: 0, resetsAt: undefined }])
  })

  test("falls back to the older monthly limit and spend, with zero cents left out", () => {
    const usage = parseGrokBilling({ config: { monthlyLimit: { val: 2000 }, used: { val: 1500 }, billingPeriodEnd: "2026-11-01T00:00:00Z" } })
    expect(usage?.remainingPct).toBe(25)
    expect(usage?.windows?.[0]?.resetsAt).toBe(Date.parse("2026-11-01T00:00:00Z"))
    expect(parseGrokBilling({ config: { monthlyLimit: { val: 2000 }, used: {} } })?.remainingPct).toBe(100)
  })

  test("clamps the percentage and rejects payloads without credits", () => {
    expect(parseGrokBilling({ config: { creditUsagePercent: 130, currentPeriod: {} } })?.remainingPct).toBe(0)
    expect(parseGrokBilling({ config: {} })).toBeNull()
    expect(parseGrokBilling({ config: { monthlyLimit: {} } })).toBeNull()
    expect(parseGrokBilling({ error: "unauthorized" })).toBeNull()
    expect(parseGrokBilling(null)).toBeNull()
  })
})

describe("grokUsage", () => {
  test("sends the session token, the CLI's token header, the user id and its client headers", async () => {
    const seen: Record<string, string | null>[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const headers = {
          authorization: request.headers.get("authorization"),
          token: request.headers.get("x-xai-token-auth"),
          user: request.headers.get("x-userid"),
          version: request.headers.get("x-grok-client-version"),
          mode: request.headers.get("x-grok-client-mode"),
        }
        seen.push(headers)
        if (headers.authorization !== "Bearer fake-grok-session") return Response.json({ error: "unauthorized" }, { status: 401 })
        return Response.json({ config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } })
      },
    })
    const previous = process.env.KYORA_GROK_USAGE_URL
    process.env.KYORA_GROK_USAGE_URL = server.url.href
    try {
      expect((await grokUsage("fake-grok-session", "user-1"))?.remainingPct).toBe(90)
      expect(await grokUsage("fake-wrong", "user-1")).toBeNull()
      expect(seen).toEqual([
        { authorization: "Bearer fake-grok-session", token: "xai-grok-cli", user: "user-1", version: "1.0.52", mode: "headless" },
        { authorization: "Bearer fake-wrong", token: "xai-grok-cli", user: "user-1", version: "1.0.52", mode: "headless" },
      ])
    } finally {
      if (previous === undefined) delete process.env.KYORA_GROK_USAGE_URL
      else process.env.KYORA_GROK_USAGE_URL = previous
    }
  })
})

const museQuota = {
  subscription_quota: {
    tier_id: "100",
    tier: "Everyday Usage",
    as_of: 1_792_000_000,
    window_weighted_limit: "400",
    window_weighted_used: "100",
    window_duration_secs: 18_000,
    window_resets_at: 1_792_008_057,
    weekly_weighted_limit: "2000",
    weekly_weighted_used: "1300",
    weekly_resets_at: 1_792_293_077,
  },
}

describe("parseMuseQuota", () => {
  test("reads the rolling and weekly windows from decimal strings, resets in seconds, and the tier", () => {
    expect(parseMuseQuota(museQuota)).toEqual({
      remainingPct: 35,
      detail: "5h 25% used · weekly 65% used",
      windows: [
        { label: "5h", usedPct: 25, resetsAt: 1_792_008_057_000 },
        { label: "weekly", usedPct: 65, resetsAt: 1_792_293_077_000 },
      ],
      plan: "Everyday Usage",
    })
  })

  test("keeps a spent window over 100 and drops windows without a usable limit", () => {
    const over = parseMuseQuota({ subscription_quota: { window_weighted_limit: "10.5", window_weighted_used: "12.6", window_duration_secs: 18_000, weekly_weighted_limit: "0", weekly_weighted_used: "1" } })
    expect(over?.windows).toEqual([{ label: "5h", usedPct: 120, resetsAt: undefined }])
    expect(over?.remainingPct).toBe(0)
    expect(over?.plan).toBeUndefined()
    expect(parseMuseQuota({ subscription_quota: { window_weighted_limit: "x", window_weighted_used: "1" } })).toBeNull()
    expect(parseMuseQuota({ subscription_quota: null })).toBeNull()
    expect(parseMuseQuota(null)).toBeNull()
  })
})

describe("parseMuseTeams", () => {
  test("lists the team ids and rejects anything else", () => {
    expect(parseMuseTeams({ teams: [{ team_id: "1", team_name: "a" }, { team_name: "no id" }, { team_id: "2" }] })).toEqual(["1", "2"])
    expect(parseMuseTeams({ teams: [] })).toEqual([])
    expect(parseMuseTeams({ team_id: "1" })).toBeNull()
    expect(parseMuseTeams(null)).toBeNull()
  })
})

describe("museUsage", () => {
  test("lists the teams and reads a team's quota with the bearer token or a web session's headers; 401 and 403 read as unauthorized", async () => {
    const seen: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url)
        const authorization = request.headers.get("authorization") ?? (request.headers.get("cookie") === "llama_dev_sess=fake-web" ? "Bearer fake-muse-access" : null)
        seen.push(`${request.method} ${pathname} ${request.headers.get("authorization") ?? request.headers.get("cookie")} ${request.headers.get("accept")}`)
        if (authorization === "Bearer fake-forbidden") return Response.json({ error: "forbidden" }, { status: 403 })
        if (authorization !== "Bearer fake-muse-access") return Response.json({ error: "unauthorized" }, { status: 401 })
        if (pathname === "/api/portal/teams") return Response.json({ teams: [{ team_id: "42", team_name: "fixture" }] })
        if (pathname === "/api/portal/teams/42/subscription-quota") return Response.json(museQuota)
        if (pathname === "/api/portal/teams/moved/subscription-quota") return Response.redirect("https://dev.meta.ai/login", 302)
        return Response.json({ error: "not found" }, { status: 404 })
      },
    })
    const previous = process.env.KYORA_MUSE_USAGE_URL
    process.env.KYORA_MUSE_USAGE_URL = server.url.href
    try {
      expect(await museTeams("fake-muse-access")).toEqual(["42"])
      expect((await museUsage("fake-muse-access", "42"))).toMatchObject({ remainingPct: 35, plan: "Everyday Usage" })
      expect(await museUsage("fake-muse-access", "7")).toBeNull()
      expect(await museUsage("fake-muse-access", "moved")).toBeNull()
      expect(await museTeams("fake-wrong")).toBe(MUSE_UNAUTHORIZED)
      expect(await museUsage("fake-forbidden", "42")).toBe(MUSE_UNAUTHORIZED)
      expect(seen.slice(0, 2)).toEqual([
        "GET /api/portal/teams Bearer fake-muse-access application/json",
        "GET /api/portal/teams/42/subscription-quota Bearer fake-muse-access application/json",
      ])
      seen.length = 0
      expect(await museUsage({ headers: (path) => ({ cookie: path.endsWith("/subscription-quota") ? "llama_dev_sess=fake-web" : "none", accept: "text/html" }) }, "42")).toMatchObject({ remainingPct: 35 })
      expect(await museTeams({ headers: () => ({ cookie: "llama_dev_sess=fake-expired" }) })).toBe(MUSE_UNAUTHORIZED)
      expect(seen).toEqual([
        "GET /api/portal/teams/42/subscription-quota llama_dev_sess=fake-web application/json",
        "GET /api/portal/teams llama_dev_sess=fake-expired application/json",
      ])
    } finally {
      if (previous === undefined) delete process.env.KYORA_MUSE_USAGE_URL
      else process.env.KYORA_MUSE_USAGE_URL = previous
    }
  })
})
