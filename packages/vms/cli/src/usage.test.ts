import { expect, test } from "bun:test"
import { usageCommand, usageLines } from "./usage"

const report = { account: { login: "acme" }, period: { id: "2026-10" }, totalUsd: 8,
  spendLimit: { enabled: true, period: "2026-10", limitUsd: 10, remainingUsd: 2 } }

test("monthly usage text shows spend, limit, remaining and support; an unknown remainder says nothing of coverage, and off is clear", () => {
  expect(usageLines(report).join("\n")).toContain("$10.00, $2.00 left")
  expect(usageLines(report).join("\n")).toContain("support@kyora.sh")
  const unknown = usageLines({ ...report, spendLimit: { ...report.spendLimit, remainingUsd: null } }).join("\n")
  expect(unknown).toContain("Monthly spend limit (2026-10): $10.00. Contact support@kyora.sh")
  expect(unknown).not.toContain("partial")
  expect(usageLines({ ...report, spendLimit: { ...report.spendLimit, enabled: false } }).join("\n")).toContain("Monthly spend limit: off")
})

test("usage fetches the account report and preserves all fields as JSON", async () => {
  const calls: unknown[] = []
  const api = { call: async (...args: unknown[]) => { calls.push(args); return report } } as Parameters<typeof usageCommand>[0]
  const lines: string[] = []
  expect(await usageCommand(api, true, (line) => lines.push(line))).toBe(0)
  expect(JSON.parse(lines[0]!)).toEqual(report)
  expect(calls).toEqual([["account usage", "GET", "/v1/usage", { timeout: 60_000 }]])
})
