import type { CustomDomain, DnsRecord, VmsClient } from "./api"

/**
 * `kyora vms domain …`: custom domains for public URLs. Your hostname,
 * CNAMEd to kyora, serves one of your public names exactly like <label>.kyora.run does.
 */

export const DomainUsage = `usage:
  kyora vms domain add <hostname> --to <label> [--dcv http|txt]   serve a public URL name on your hostname
  kyora vms domain ls                                             your custom domains
  kyora vms domain status <hostname>                              current status and missing DNS records
  kyora vms domain rm <hostname>                                  remove it (its certificate goes too)`

type Print = (line: string) => void

function table(records: DnsRecord[]): string[] {
  const width = (pick: (record: DnsRecord) => string) => Math.max(...records.map((record) => pick(record).length))
  const type = width((record) => record.type)
  const name = width((record) => record.name)
  const value = width((record) => record.value)
  return records.flatMap((record) => [
    `  ${record.type.padEnd(type)}  ${record.name.padEnd(name)}  ${record.value.padEnd(value)}  ${record.required ? "required" : "optional"}`,
    ...(record.note ? [`  ${"".padEnd(type)}  ${record.note}`] : []),
  ])
}

/** the records not in place yet, as the public DNS showed them */
function printMissing(domain: CustomDomain, print: Print): void {
  if (!domain.missing?.length) return
  print("")
  print("Missing:")
  const records = domain.missing.map((record) => ({ ...record, purpose: "", required: true }) as DnsRecord)
  for (const line of table(records)) print(line.replace(/\s+required$/, ""))
}

/** the DNS records to add, the one that matters first */
export function printRecords(domain: CustomDomain, print: Print): void {
  const required = domain.records.filter((record) => record.required)
  const optional = domain.records.filter((record) => !record.required)
  print("")
  print(`Add ${required.length === 1 ? "this record" : "these records"} at your DNS provider:`)
  for (const line of table(required)) print(line)
  if (optional.length) {
    print("")
    print("Optional:")
    for (const line of table(optional)) print(line)
  }
}

function summary(domain: CustomDomain): string {
  const state = [domain.status, ...(domain.attached ? [] : ["detached"]), ...(domain.blocked ? ["blocked by kyora"] : [])].join(", ")
  return `${domain.hostname} → ${domain.label} (${state})`
}

export async function domainCommand(api: VmsClient, args: { positionals: string[]; to?: string; dcv?: string; json: boolean }, usage: (message: string) => never, print: Print = (line) => console.log(line)): Promise<number> {
  const [action, hostname, extra] = args.positionals
  if (!action || extra !== undefined) usage(DomainUsage)
  if (action !== "add" && (args.to !== undefined || args.dcv !== undefined)) usage(`domain ${action} takes no --to or --dcv\n${DomainUsage}`)
  if (action === "ls" || action === "list") {
    if (hostname !== undefined) usage(DomainUsage)
    const domains = await api.domains()
    if (args.json) print(JSON.stringify({ domains }))
    else if (!domains.length) print("no custom domains yet: kyora vms domain add <hostname> --to <label>")
    else for (const domain of domains) print(`${domain.hostname}  ${domain.label}  ${domain.status}${domain.attached ? "" : "  detached"}`)
    return 0
  }
  if (!hostname) usage(DomainUsage)
  if (action === "add") {
    if (!args.to) usage(`domain add needs --to <label>, one of your public URL names (kyora vms expose --list)\n${DomainUsage}`)
    if (args.dcv !== undefined && args.dcv !== "http" && args.dcv !== "txt") usage("--dcv takes http (the default: nothing to add but the TXT and the CNAME) or txt")
    const domain = await api.domainAdd(hostname, args.to, args.dcv as "http" | "txt" | undefined)
    if (args.json) {
      print(JSON.stringify(domain))
      return 0
    }
    print(summary(domain))
    if (domain.status !== "active") {
      printRecords(domain, print)
      print("")
      if (domain.status === "unverified") print("The TXT record verifies your ownership.")
      print(`Then check: kyora vms domain status ${domain.hostname}`)
      print("The certificate is issued once the CNAME resolves, usually within minutes (DNS caches can make it longer).")
    } else print(domain.url)
    return 0
  }
  if (action === "status") {
    const domain = await api.domain(hostname)
    if (args.json) {
      print(JSON.stringify(domain))
      return 0
    }
    print(summary(domain))
    if (domain.reason && domain.status !== "active") print(`  ${domain.reason}`)
    if (domain.why && domain.why !== domain.reason) print(`  ${domain.why}`)
    if (domain.stale) print("  (status unavailable; showing the last known status)")
    if (domain.status === "active" && domain.serving) print(domain.url)
    printMissing(domain, print)
    if (domain.status !== "active" && !domain.blocked) printRecords(domain, print)
    return 0
  }
  if (action === "rm" || action === "remove") {
    await api.domainRemove(hostname)
    if (args.json) print(JSON.stringify({ removed: true, hostname }))
    return 0
  }
  return usage(`unknown domain action "${action}"\n${DomainUsage}`)
}
