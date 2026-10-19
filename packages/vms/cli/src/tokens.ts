import { parseArgs } from "node:util"
import { NETWORKS, VmsClient, type ApiTokenConstraints, type Network } from "./api"
import { originOf, loadConfig } from "./config"
import { readCredentials } from "./credentials"
import { printJson } from "./output"
import { printTable } from "./session"
import { memoryMb, parseSeconds, positiveInt } from "./units"

const HELP = `usage:
  kyora-vms tokens create <name> --scope CAPABILITY... [options]
  kyora-vms tokens ls [--org ORG] [--json]
  kyora-vms tokens revoke <id> [--org ORG] [--json]

Capabilities: vms:read, vms:write, vms:exec, vms:share, public-urls, images, storage, storage:presign, projects:read, deploys

Create options:
  --scope CAPABILITY       repeat, or separate with commas
  --project ID_OR_NAME     repeat, or separate with commas; allowed projects
  --label KEY=VALUE        repeat; forced on creates and required for sandbox access
  --region REGION          repeat, or separate with commas; allowed regions
  --max-sandboxes N        concurrent sandboxes created through this token
  --max-vcpus N            maximum vCPUs per sandbox
  --max-memory SIZE        maximum memory per sandbox, such as 2G
  --max-ttl DURATION       maximum lifetime per sandbox, such as 1h
  --network MODE          repeat, or separate with commas; allowed network modes
  --names NAME,...         allowed public URL names
  --name-prefix PREFIX     allowed public URL name prefix
  --expires DURATION       30d by default, at most 90d (also accepts hours)
  --org ORG                manage tokens for this org using a personal full token
  --json                   structured output (create includes the secret once)`

export class TokenUsage extends Error {}
const usage = (message: string): never => { throw new TokenUsage(message) }
const commaList = (values?: string[]): string[] | undefined => values?.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean))

export async function tokensMain(args: string[]): Promise<number> {
  const options = {
    project: { type: "string", multiple: true },
    scope: { type: "string", multiple: true },
    label: { type: "string", multiple: true },
    region: { type: "string", multiple: true },
    "max-sandboxes": { type: "string" },
    "max-vcpus": { type: "string" },
    "max-memory": { type: "string" },
    "max-ttl": { type: "string" },
    network: { type: "string", multiple: true },
    names: { type: "string", multiple: true },
    "name-prefix": { type: "string" },
    expires: { type: "string" },
    org: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } as const
  const parse = () => parseArgs({ args, options, allowPositionals: true, strict: true })
  let parsed: ReturnType<typeof parse>
  try { parsed = parse() } catch (error) { return usage(error instanceof Error ? error.message : String(error)) }
  const { values, positionals } = parsed
  if (values.help || positionals[0] === "help") { console.log(HELP); return 0 }
  const [verb, name, extra] = positionals
  if (!verb || extra || !["create", "ls", "revoke"].includes(verb)) return usage(HELP)
  if (verb === "ls" && name || verb !== "ls" && !name) return usage(HELP)
  if (verb !== "create" && Object.keys(values).some((flag) => !["org", "json"].includes(flag))) return usage(`${verb} takes only --org and --json`)
  const config = await loadConfig()
  if (values.org && config.keySource === config.credentials) {
    const personal = (await readCredentials(config.credentials))[originOf(config.url)]?.token
    if (!personal) throw new Error(`there is no personal login for ${config.url} here; run kyora-vms login`)
    config.key = personal
  }
  const api = new VmsClient(config)
  if (verb === "ls") {
    const tokens = await api.apiTokens(values.org)
    if (values.json) printJson({ tokens })
    else printTable([["ID", "NAME", "SCOPES", "EXPIRES", "STATUS"], ...tokens.map((token) => [token.id, token.name, token.scopes.join(","), token.expiresAt ?? "none", token.revokedAt ? "revoked" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "expired" : "active"])])
  } else if (verb === "revoke") {
    await api.revokeApiToken(name!, values.org)
    if (values.json) printJson({ revoked: name })
    else console.log(`revoked ${name}`)
  } else {
    const scopes = commaList(values.scope)
    if (!scopes?.length) return usage("create requires at least one --scope")
    const labels: Record<string, string> = {}
    for (const pair of values.label ?? []) {
      const equals = pair.indexOf("=")
      if (equals < 1) return usage(`--label ${JSON.stringify(pair)}: expected KEY=VALUE`)
      labels[pair.slice(0, equals)] = pair.slice(equals + 1)
    }
    const modes = commaList(values.network)
    if (modes?.some((mode) => !NETWORKS.includes(mode as Network))) return usage(`--network takes ${NETWORKS.join(", ")}`)
    const constraints: ApiTokenConstraints = {
      ...(values.project ? { projects: commaList(values.project) } : {}),
      ...(values.label ? { labels } : {}),
      ...(values.region ? { regions: commaList(values.region) } : {}),
      ...(values["max-sandboxes"] ? { maxSandboxes: positiveInt(values["max-sandboxes"], "--max-sandboxes") } : {}),
      ...(values["max-vcpus"] ? { maxVcpus: positiveInt(values["max-vcpus"], "--max-vcpus") } : {}),
      ...(values["max-memory"] ? { maxMemoryMb: memoryMb(values["max-memory"]) } : {}),
      ...(values["max-ttl"] ? { maxTtlSeconds: parseSeconds(values["max-ttl"], "--max-ttl") } : {}),
      ...(modes ? { networkModes: modes as Network[] } : {}),
      ...(values.names ? { names: commaList(values.names) } : {}),
      ...(values["name-prefix"] ? { namePrefix: values["name-prefix"] } : {}),
    }
    const created = await api.createApiToken({ name: name!, scopes, constraints, expires: values.expires ?? "30d" }, values.org)
    if (values.json) printJson(created)
    else console.log(created.token)
  }
  return 0
}
