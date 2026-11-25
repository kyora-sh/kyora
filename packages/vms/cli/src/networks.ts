import { ApiError, type CreateSpec, type PrivateNetwork, type VmsClient } from "./api"

export const NetworkUsage = `usage:
  kyora vms networks create <name> --cidr <cidr>   create a private IPv4 subnet
  kyora vms networks ls [--json]                  your private networks
  kyora vms networks show <id|name> [--json]      network details and members
  kyora vms networks rm <id|name>                 remove an empty network`

type Print = (line: string) => void

export async function resolveNetworkId(api: VmsClient, input: string): Promise<string> {
  if (input.startsWith("net_")) return input
  const network = (await api.networks()).find((network) => network.name === input)
  if (!network) throw new ApiError(`network ${JSON.stringify(input)} not found`, 404, "network_not_found")
  return network.id
}

async function privateNetworkOption(api: VmsClient, value: string, usage: (message: string) => never): Promise<NonNullable<CreateSpec["privateNetwork"]>> {
  const [name, ip, extra] = value.split(":")
  if (!name || extra !== undefined || (ip !== undefined && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip))) usage("--private-network takes <id|name>[:<IPv4 address>]")
  return { id: await resolveNetworkId(api, name), ...(ip !== undefined ? { ip } : {}) }
}

/** every --private-network of a create: one stays the `privateNetwork` shorthand */
export async function privateNetworkOptions(api: VmsClient, values: string[], usage: (message: string) => never): Promise<Pick<CreateSpec, "privateNetwork" | "privateNetworks">> {
  const networks = await Promise.all(values.map((value) => privateNetworkOption(api, value, usage)))
  return networks.length === 1 ? { privateNetwork: networks[0]! } : { privateNetworks: networks }
}

function table(rows: string[][], print: Print): void {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  for (const row of rows) print(row.map((value, column) => column === row.length - 1 ? value : value.padEnd(widths[column]!)).join("  "))
}

function printNetworks(networks: PrivateNetwork[], print: Print): void {
  table([["NAME", "ID", "CIDR", "MEMBERS", "CREATED"], ...networks.map((network) => [network.name, network.id, network.cidr, String(network.memberCount), network.createdAt])], print)
}

export async function networksCommand(api: VmsClient, args: { positionals: string[]; cidr?: string; json: boolean }, usage: (message: string) => never, print: Print = (line) => console.log(line)): Promise<number> {
  const [action, target, extra] = args.positionals
  if (!action || extra !== undefined) usage(NetworkUsage)
  if (action !== "create" && args.cidr !== undefined) usage(`networks ${action} takes no --cidr\n${NetworkUsage}`)
  if (action === "ls" || action === "list") {
    if (target !== undefined) usage(NetworkUsage)
    const networks = await api.networks()
    if (args.json) print(JSON.stringify({ networks }))
    else if (!networks.length) print("no private networks yet: kyora vms networks create <name> --cidr <cidr>")
    else printNetworks(networks, print)
    return 0
  }
  if (!target) usage(NetworkUsage)
  if (action === "create") {
    if (!args.cidr) usage(`networks create needs --cidr <cidr>\n${NetworkUsage}`)
    const network = await api.createNetwork(target, args.cidr)
    if (args.json) print(JSON.stringify(network))
    else printNetworks([network], print)
    return 0
  }
  if (action === "show") {
    const network = await api.privateNetwork(await resolveNetworkId(api, target))
    if (args.json) print(JSON.stringify(network))
    else {
      printNetworks([network], print)
      print("")
      table([["SANDBOX", "IP", "STATE"], ...(network.members ?? []).map((member) => [member.sandboxId, member.ip, member.state])], print)
    }
    return 0
  }
  if (action === "rm" || action === "remove") {
    const id = await resolveNetworkId(api, target)
    await api.removeNetwork(id)
    if (args.json) print(JSON.stringify({ removed: true, id }))
    return 0
  }
  return usage(`unknown networks action "${action}"\n${NetworkUsage}`)
}
