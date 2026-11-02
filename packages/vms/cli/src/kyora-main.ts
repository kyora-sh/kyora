import { parseArgs } from "node:util"
import { imageCommand } from "./account-images"
import { VERSION, VmsClient } from "./api"
import { loadConfig } from "./config"
import { topCommand } from "./top"
import { supportCommand } from "./support"
import { deployCommand } from "./deploys"
import { exitFlushed, failureCode, note } from "./output"
import { SESSION_HELP, sessionMain } from "./sessions/cli"
import { usageHint, vmsMain } from "./vms"

/**
 * `kyora`: the sandboxes as `kyora vms …` (vms.ts), with `kyora session …`, `kyora image …` and
 * `kyora top` also at the top level, `kyora detach` and `kyora back` as the session's short pair,
 * the account commands (`kyora login` is `kyora vms login`), deploys, support, and `kyora switch …`,
 * which is kyora-switch. `kyora run …` and `kyora tui …` never get here: kyora.ts hands them to the
 * agent harness (`kyora-harness`) first. `kyora-vms …` is `kyora vms …`.
 */
const HELP = `kyora: the kyora CLI

usage:
  kyora vms …         disposable VMs: run, new, ls, shell, exec, push, pull… (kyora vms --help)
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
  kyora image build <name> --from gha-runner [--file setup.sh] [--package P]... [--allow HOST]...
                                                       the same from a setup script or packages
  kyora image check [dir]                              what CI makes of dir/.github/kyora.yml; 1 when it refuses some
  kyora image lock | ls | versions <name> | rm <name@N> | usage
                                                       pin it, list, delete
  kyora image push <file.ext4> --name N [--region R]   store an ext4 you built yourself

  kyora login [--url URL] [--org ORG] | logout | whoami | org ls | org use <org>|personal
                                                       your kyora cloud account (the same as kyora vms login…)

kyora-vms is deprecated: kyora-vms <args> is kyora vms <args>.`

const ACCOUNT: ReadonlySet<string> = new Set(["login", "logout", "whoami", "org"])

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv
  if (group === "vms") return vmsMain(rest)
  if (group && ACCOUNT.has(group)) return vmsMain(argv)
  if (group === "projects" || group === "link" || group === "deploy" || group === "deployments") return deployCommand(new VmsClient(await loadConfig()), group, rest)
  if (group === "support") return supportCommand(new VmsClient(await loadConfig()), rest)
  if (group === "top") return topCommand(rest)
  if (group === "session") return sessionMain(rest)
  if (group === "detach" || group === "back") return sessionMain([group, ...rest])
  if (group === "image" || group === "images") {
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
  if (group === "--version" || group === "-v") {
    console.log(VERSION)
    return 0
  }
  throw new KyoraUsage(`unknown command "${group}"`)
}

class KyoraUsage extends Error {}
class ImageUsage extends KyoraUsage {}

const parseImageArgs = (args: string[]) => parseArgs({ args, options: { name: { type: "string" }, region: { type: "string" }, from: { type: "string" }, file: { type: "string" }, package: { type: "string", multiple: true }, allow: { type: "string", multiple: true }, json: { type: "boolean" } }, allowPositionals: true, strict: true })

function exit(code: number): Promise<never> {
  return exitFlushed(code)
}

/** runs `kyora <argv…>` and ends the process with its exit code */
export function runKyora(argv: string[]): void {
  // kyora-switch sets its own exit code and ends the process the way it does standalone
  if (argv[0] === "switch") {
    import("kyora-switch/src/index").then(({ run }) => run(argv.slice(1), "kyora switch")).catch((error: unknown) => {
      console.error(`[kyora-switch] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    })
    return
  }
  main(argv).then(exit, async (error: unknown) => {
    note(error instanceof Error ? error.message : String(error))
    const hint = error instanceof KyoraUsage ? "run `kyora --help` for usage" : usageHint(error)
    if (hint) note(hint)
    await exit(failureCode(error))
  })
}
