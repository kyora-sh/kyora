import { parseArgs } from "node:util"
import { imageCommand } from "./account-images"
import { VmsClient } from "./api"
import { loadConfig } from "./config"
import { topCommand } from "./top"
import { supportCommand } from "./support"
import { deployCommand } from "./deploys"
import { exitFlushed, FAILED, note } from "./output"
import { SESSION_HELP, sessionMain, SessionUsage } from "./sessions/cli"

/**
 * `kyora`, for the commands that span kyora's tools: `kyora session …` and `kyora image …`, the
 * same commands as `kyora-vms session …` and `kyora-vms image …`, with `kyora detach` and `kyora back`
 * as the session's short pair, `kyora switch …`, which is kyora-switch, and `kyora run …` and `kyora tui …`,
 * which kyora.ts hands to the agent harness (`kyora-harness`). Sandboxes themselves stay `kyora-vms`.
 */
const HELP = `kyora: kyora's cross-tool commands

usage:
  kyora run …         run a task with the kyora agent harness (kyora run --help)
  kyora tui …         the harness's terminal UI (kyora tui --help)
  kyora detach        this repo's coding-agent conversation into a kyora VM; it carries on there
  kyora back          its commits and conversation back here, and the VM ends
  kyora session …     the same, with finer control (kyora session --help)
  kyora switch …      hot-swap coding-agent logins between accounts (kyora switch --help)
  kyora top [--once|--json]   live usage of your running VMs (--interval 2, --region ID)
  kyora support new | ls | show | reply                contact support (kyora support --help)
  kyora projects create | ls | show | rm               connect and manage deploy projects
  kyora link [N]                                      select this checkout's project
  kyora deploy [--prod] [--project N] [--follow]        deploy to production
  kyora deployments ls | logs [dpl] [--follow]         deployment status and logs
  kyora image build [kyora.image.json]                 build your image from a spec, stored as name@N
  kyora image lock | ls | versions <name> | rm <name@N> | usage
                                                       pin it, list, delete
  kyora image push <file.ext4> --name N [--region R]   store an ext4 you built yourself

sandboxes: kyora-vms --help`

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv
  if (group === "projects" || group === "link" || group === "deploy" || group === "deployments") return deployCommand(new VmsClient(await loadConfig()), group, rest)
  if (group === "support") return supportCommand(new VmsClient(await loadConfig()), rest)
  if (group === "top") return topCommand(rest)
  if (group === "session") return sessionMain(rest)
  if (group === "detach" || group === "back") return sessionMain([group, ...rest])
  if (group === "image") {
    let parsed: ReturnType<typeof parseImageArgs>
    try {
      parsed = parseImageArgs(rest)
    } catch (error) {
      throw new ImageUsage((error as Error).message)
    }
    const { values, positionals } = parsed
    return imageCommand(new VmsClient(await loadConfig()), positionals, values, Boolean(values.json), (message) => { throw new ImageUsage(message) })
  }
  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(group === "help" && rest[0] === "session" ? SESSION_HELP : HELP)
    return 0
  }
  throw new SessionUsage(`unknown command "${group}"; run \`kyora --help\``)
}

class ImageUsage extends Error {}

const parseImageArgs = (args: string[]) => parseArgs({ args, options: { name: { type: "string" }, region: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true, strict: true })

function exit(code: number): Promise<never> {
  return exitFlushed(code)
}

const argv = Bun.argv.slice(2)
// kyora-switch sets its own exit code and ends the process the way it does standalone
if (argv[0] === "switch") {
  import("kyora-switch/src/index").then(({ run }) => run(argv.slice(1), "kyora switch")).catch((error: unknown) => {
    console.error(`[kyora-switch] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
} else {
  main(argv).then(exit, async (error: unknown) => {
    note(error instanceof Error ? error.message : String(error))
    if (error instanceof SessionUsage) note("run `kyora session --help` for usage")
    if (error instanceof ImageUsage) note("run `kyora --help` for usage")
    await exit(FAILED)
  })
}
