import type { VmsClient } from "./api"

interface UsageReport {
  account: { login: string }
  period: { id: string }
  totalUsd: number
  spendLimit?: { enabled: boolean; period: string; limitUsd: number | null; remainingUsd: number | null }
}

export function usageLines(report: UsageReport): string[] {
  const money = (usd: number) => `$${usd.toFixed(2)}`
  const lines = [`${report.account.login}, ${report.period.id}: ${money(report.totalUsd)} estimated at list prices`]
  const limit = report.spendLimit
  if (limit) lines.push(limit.enabled && limit.limitUsd !== null
    ? `Monthly spend limit (${limit.period}): ${money(limit.limitUsd)}${limit.remainingUsd === null ? "" : `, ${money(limit.remainingUsd)} left`}. Contact support@kyora.sh to raise it.`
    : "Monthly spend limit: off")
  return lines
}

export async function usageCommand(api: Pick<VmsClient, "call">, asJson: boolean, print: (line: string) => void = console.log): Promise<number> {
  const report = await api.call<UsageReport>("account usage", "GET", "/v1/usage", { timeout: 60_000 })
  if (asJson) print(JSON.stringify(report))
  else for (const line of usageLines(report)) print(line)
  return 0
}
