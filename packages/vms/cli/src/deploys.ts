import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import type { DeploymentCreate, DeploymentView, ProjectCreate, ProjectView } from "../../shared/deploys"
import { ApiResponseError, type VmsClient } from "./api"
import { exitCodeOf, type ExitEvent } from "./exec"
import { FAILED, note, printJson, write } from "./output"

export const DEPLOYS_HELP = `usage:
  kyora projects create --repo owner/name [--name N] [--branch B] [--region R]
  kyora projects ls
  kyora projects show [N] [--project N]
  kyora projects rm N [--yes]
  kyora link [N]
  kyora deploy [--prod | --env production] [--ref R | --sha S] [--project N] [--follow]
  kyora deployments ls [--project N]
  kyora deployments logs [dpl] [--project N] [--follow]

All commands accept --json. Follow emits NDJSON.
Project defaults: --project, then .kyora/project.json at the git repository root.
Run kyora link to select this checkout's project.`

export class DeployUsage extends Error {}
const usage = (message: string): never => { throw new DeployUsage(`${message}\n${DEPLOYS_HELP}`) }
const selector = (value: string) => /^[A-Za-z0-9_-]+$/.test(value)

export function parseDeployArgs(group: string, args: string[]) {
  let parsed
  try {
    parsed = parseArgs({ args, options: {
      repo: { type: "string" }, name: { type: "string" }, branch: { type: "string" }, region: { type: "string" },
      project: { type: "string" }, ref: { type: "string" }, sha: { type: "string" }, env: { type: "string" },
      prod: { type: "boolean" }, follow: { type: "boolean" }, yes: { type: "boolean" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, allowPositionals: true, strict: true })
  } catch (error) { return usage((error as Error).message) }
  const { values, positionals } = parsed
  if (values.help) return parsed
  const [action, target] = positionals
  let allowed: string[]
  if (group === "projects") {
    if (action === "create") {
      if (positionals.length !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo ?? "")) usage("projects create requires --repo owner/name")
      allowed = ["repo", "name", "branch", "region"]
    } else if (action === "ls") {
      if (positionals.length !== 1) usage("projects ls takes no arguments")
      allowed = []
    } else if (action === "show") {
      if (positionals.length > 2 || (target !== undefined && !selector(target))) usage("projects show takes an optional project name or id")
      allowed = ["project"]
    } else if (action === "rm") {
      if (positionals.length !== 2 || !selector(target ?? "")) usage("projects rm requires a project name or id")
      allowed = ["yes"]
    } else return usage("choose projects create, ls, show or rm")
  } else if (group === "link") {
    if (positionals.length > 1 || (action !== undefined && !selector(action))) usage("link takes an optional project name or id")
    allowed = ["project"]
  } else if (group === "deploy") {
    if (positionals.length) usage("deploy takes no positional arguments")
    if (values.env !== undefined && values.env !== "production") usage("environments other than production are not yet available")
    if (values.ref !== undefined && values.sha !== undefined) usage("choose either --ref or --sha")
    if (values.sha !== undefined && !/^[a-f0-9]{40}$/.test(values.sha)) usage("--sha requires a full commit SHA")
    allowed = ["prod", "env", "ref", "sha", "project", "follow"]
  } else if (group === "deployments") {
    if (action === "ls") {
      if (positionals.length !== 1) usage("deployments ls takes no positional arguments")
      allowed = ["project"]
    } else if (action === "logs") {
      if (positionals.length > 2 || (target !== undefined && !/^dpl_[A-Za-z0-9_-]+$/.test(target))) usage("deployments logs takes an optional deployment id")
      allowed = ["project", "follow"]
    } else return usage("choose deployments ls or logs")
  } else return usage(`unknown command: ${group}`)
  for (const [key, value] of Object.entries(values)) {
    if (!["json", "help", ...allowed].includes(key)) usage(`--${key} is not valid for this command`)
    if (typeof value === "string" && (!value.trim() || value.includes("\0"))) usage(`--${key} must not be empty`)
  }
  if (values.project !== undefined && !selector(values.project)) usage("--project requires a project name or id")
  return parsed
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return code === 0 ? stdout.trim() : null
}

async function repositoryRoot(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "--show-toplevel"]) ?? usage("this directory is not in a git repository; run kyora link from a checkout, or use --project")
}

export function githubRepository(remote: string): string | null {
  const scp = /^git@github\.com:([^/]+\/[^/]+)\/?$/i.exec(remote)
  let path = scp?.[1]
  if (!path) {
    try {
      const url = new URL(remote)
      if (!["https:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return null
      path = url.pathname.replace(/^\//, "").replace(/\/$/, "")
    } catch { return null }
  }
  path = path.replace(/\.git$/i, "")
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : null
}

export async function resolveProject(project?: string, cwd = process.cwd()): Promise<string> {
  if (project !== undefined) return project
  const root = await repositoryRoot(cwd)
  const file = Bun.file(join(root, ".kyora", "project.json"))
  let linked: unknown
  try { linked = await file.json() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return usage("no project linked to this checkout; run kyora link or use --project")
    return usage("invalid .kyora/project.json; run kyora link again")
  }
  if (!linked || typeof linked !== "object" || !("project" in linked) || typeof linked.project !== "string" || !selector(linked.project)) return usage("invalid .kyora/project.json; run kyora link again")
  return linked.project
}

type DeployClient = Pick<VmsClient, "projectCreate" | "projects" | "project" | "projectRemove" | "deploymentCreate" | "deployments" | "deployment" | "deploymentLogs">
interface CommandContext { cwd?: string; stdinIsTTY?: boolean; confirm?: (message: string) => Promise<boolean> }

async function confirm(message: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try { return /^y(es)?$/i.test((await terminal.question(`${message} [y/N] `)).trim()) }
  finally { terminal.close() }
}

const projectLine = (project: ProjectView) => console.log(`${project.id}  ${project.name}  ${project.repoFullName}  ${project.url}`)

async function followDeployment(api: DeployClient, project: string, id: string, asJson: boolean, requireLive: boolean): Promise<number> {
  let lastState: string | undefined
  const status = async (): Promise<DeploymentView> => {
    const detail = await api.deployment(project, id)
    if (detail.state !== lastState) {
      if (asJson) console.log(JSON.stringify(detail))
      else note(`${id}: ${detail.state}`)
      lastState = detail.state
    }
    return detail
  }
  await status()
  const response = await api.deploymentLogs(project, id, true)
  if (!response.body) throw new Error("deployment log stream has no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let exit: ExitEvent | null = null
  let pollAt = Date.now() + 1000
  const consume = async (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line)
    if (asJson) console.log(JSON.stringify(event))
    else if (event.type === "stdout" || event.type === "stderr") await write(event.type === "stderr" ? process.stderr : process.stdout, event.data ?? "")
    if (event.type === "exit") exit = event as ExitEvent
  }
  try {
    let pending = reader.read()
    while (!exit) {
      if (Date.now() >= pollAt) { await status(); pollAt = Date.now() + 1000 }
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        pending,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, pollAt - Date.now())) }),
      ]).finally(() => clearTimeout(timer))
      if (next === null) { await status(); pollAt = Date.now() + 1000; continue }
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        await consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (next.done) {
        if (buffer) await consume(buffer)
        if (!exit) throw new Error("deployment log stream ended before its exit event")
        break
      }
      if (!exit) pending = reader.read()
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const detail = await status()
  if (!asJson) {
    if (detail.state === "live") console.log(detail.url)
    if (detail.error) note(detail.error.message)
  }
  const code = exitCodeOf(exit!)
  return requireLive && detail.state !== "live" ? (code || FAILED) : code
}

export async function deployCommand(api: DeployClient, group: string, args: string[], context: CommandContext = {}): Promise<number> {
  const { values, positionals } = parseDeployArgs(group, args)
  if (values.help) { console.log(DEPLOYS_HELP); return 0 }
  const cwd = context.cwd ?? process.cwd()
  const [action, target] = positionals
  try {
    if (group === "projects") {
      if (action === "create") {
        const body: ProjectCreate = { repo: values.repo!, ...(values.name ? { name: values.name } : {}), ...(values.branch ? { productionBranch: values.branch } : {}), ...(values.region ? { region: values.region } : {}) }
        const result = await api.projectCreate(body)
        if (values.json) printJson(result)
        else {
          projectLine(result)
          const first = (await api.deployments(result.id)).deployments.at(-1)
          if (first) console.log(`First deployment: ${first.id}`)
        }
      } else if (action === "ls") {
        const result = await api.projects()
        if (values.json) printJson(result)
        else if (!result.projects.length) console.log("No projects.")
        else result.projects.forEach(projectLine)
      } else if (action === "show") {
        const result = await api.project(await resolveProject(values.project ?? target, cwd))
        if (values.json) printJson(result)
        else { projectLine(result); console.log(`Production branch: ${result.productionBranch}\nLive deployment: ${result.liveDeployment ?? "none"}`) }
      } else {
        if (!values.yes) {
          if (!(context.stdinIsTTY ?? process.stdin.isTTY)) usage("projects rm requires --yes when stdin is not a TTY")
          if (!await (context.confirm ?? confirm)(`Delete project ${target} and its VMs and snapshots?`)) return 1
        }
        const result = await api.projectRemove(target!)
        if (values.json) printJson(result)
        else console.log(`Deleting project ${target}.`)
      }
      return 0
    }
    if (group === "link") {
      const root = await repositoryRoot(cwd)
      let project: ProjectView
      if (values.project ?? action) project = await api.project((values.project ?? action)!)
      else {
        const remote = await git(root, ["remote", "get-url", "origin"])
        const repo = remote ? githubRepository(remote) : null
        if (!repo) usage("origin must be a GitHub HTTPS or SSH URL; use kyora link N to select a project")
        const matches = (await api.projects()).projects.filter((p) => p.repoFullName.toLowerCase() === repo!.toLowerCase())
        if (!matches.length) usage(`no project matches origin (${repo}); create one with kyora projects create --repo ${repo}, or run kyora link N`)
        if (matches.length > 1) usage(`several projects match origin (${repo}): ${matches.map((p) => p.name).join(", ")}; run kyora link N`)
        project = matches[0]!
      }
      await mkdir(join(root, ".kyora"), { recursive: true })
      await Bun.write(join(root, ".kyora", "project.json"), JSON.stringify({ project: project.id, name: project.name }) + "\n")
      if (values.json) printJson(project)
      else console.log(`Linked ${project.name} (${project.id}).`)
      return 0
    }
    const project = await resolveProject(values.project, cwd)
    if (group === "deploy") {
      const body: DeploymentCreate = { environment: "production", ...(values.ref ? { ref: values.ref } : {}), ...(values.sha ? { sha: values.sha } : {}) }
      const result = await api.deploymentCreate(project, body)
      if (values.json) {
        if (values.follow) console.log(JSON.stringify(result))
        else printJson(result)
      } else console.log(result.id)
      return values.follow ? await followDeployment(api, project, result.id, Boolean(values.json), true) : 0
    }
    if (action === "ls") {
      const result = await api.deployments(project)
      if (values.json) printJson(result)
      else if (!result.deployments.length) console.log("No deployments.")
      else for (const d of result.deployments) console.log(`${d.id}  ${d.state}  ${d.sha}  ${d.ref}`)
      return 0
    }
    const id = target ?? (await api.deployments(project)).deployments[0]?.id
    if (!id) usage("this project has no deployments")
    if (values.follow) return await followDeployment(api, project, id!, Boolean(values.json), false)
    const text = await (await api.deploymentLogs(project, id!)).text()
    if (values.json) printJson(text)
    else await write(process.stdout, text)
    return 0
  } catch (error) {
    if (!(error instanceof ApiResponseError)) throw error
    if (values.json && error.body !== null) {
      if (values.follow) console.log(JSON.stringify(error.body))
      else printJson(error.body)
    } else {
      note(error.message)
      if (error.code === "not_installed" && error.body && typeof error.body === "object" && "installUrl" in error.body && typeof error.body.installUrl === "string") note(error.body.installUrl)
    }
    return FAILED
  }
}
