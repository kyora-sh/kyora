import { createInterface } from "node:readline/promises"
import type { CreateSpec, ExecRequest, Sandbox, VmsClient } from "./api"
import { exec } from "./session"
import { Interrupt } from "./interrupt"
import { note, printJson } from "./output"
import { destroyQuietly } from "./run"
import { shell, type ShellOptions } from "./shell"
import { remotePath } from "./transfer"
import { parseSeconds } from "./units"
import { isFullId, namedSandbox, resolveSandbox, resolveDestructiveTarget, sandboxArgument, sandboxLabel, validName } from "./names"

export const SIZES: Record<string, { vcpus: number; memoryMb: number }> = {
  s: { vcpus: 2, memoryMb: 4096 }, m: { vcpus: 4, memoryMb: 8192 },
  l: { vcpus: 8, memoryMb: 16384 }, xl: { vcpus: 16, memoryMb: 32768 },
}

export async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await readline.question(question)
  } finally {
    readline.close()
  }
}

export async function selectSandbox(api: Pick<VmsClient, "list" | "get">, input?: string, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask = prompt): Promise<Sandbox> {
  if (input && isFullId(input)) return api.get(input)
  if (input !== undefined) {
    const named = await namedSandbox(api, input)
    if (named) return named
  }
  const sandboxes = await api.list()
  if (input !== undefined) return resolveSandbox(sandboxes, input)
  if (!sandboxes.length) throw new Error("no sandboxes running; start one with kyora-vms new")
  if (sandboxes.length === 1) return sandboxes[0]!
  if (!tty) throw new Error("several sandboxes running; give a name from kyora-vms ls")
  sandboxes.forEach((s, i) => note(`${i + 1}) ${sandboxLabel(s)}  ${s.id}  ${s.vcpus}/${s.memoryMb / 1024}G`))
  const answer = (await ask("attach to [1]: ")).trim() || "1"
  if (/^\d+$/.test(answer)) {
    const chosen = sandboxes[Number(answer) - 1]
    if (chosen) return chosen
    throw new Error("no sandbox at that number")
  }
  return resolveSandbox(sandboxes, answer)
}

export async function attachSandbox(api: VmsClient, sandbox: Sandbox, options: Partial<ShellOptions> = {}, open = shell): Promise<number> {
  return open(api, sandbox.id, { name: "main", control: true, ...options, sandboxName: sandboxLabel(sandbox) })
}

export async function newSandbox(api: VmsClient, spec: CreateSpec, wait: number, options: Partial<ShellOptions> = {}, open = shell): Promise<number> {
  const tty = options.io?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!tty && !options.cmd) throw new Error("new needs a terminal; use new -- <cmd…> or create")
  const interrupt = new Interrupt()
  let sandbox: Sandbox
  try {
    note(`starting ${spec.name ?? "a fresh sandbox"}…`)
    sandbox = await api.create({ network: "registries", idleSeconds: 3600, ...spec }, { wait, signal: interrupt.signal })
    if (interrupt.interrupted) {
      await destroyQuietly(api, sandbox.id)
      return interrupt.code!
    }
  } catch (error) {
    if (interrupt.interrupted) return interrupt.code!
    throw error
  } finally {
    interrupt.dispose()
  }
  if (!tty && options.cmd) {
    const request: ExecRequest = { cmd: options.cmd, cwd: options.cwd, env: options.env }
    const code = await exec(api, sandbox.id, request, false)
    const argument = sandboxArgument(sandboxLabel(sandbox))
    note(`back in: kyora-vms attach ${argument} · gone: kyora-vms rm ${argument}`)
    return code
  }
  return attachSandbox(api, sandbox, options, open)
}

export async function confirmAll(count: number, ask = prompt): Promise<boolean> {
  if (!count) return true
  return /^(y|yes)$/i.test((await ask(`destroy all ${count} sandboxes? [y/N] `)).trim())
}

interface CommandContext {
  verb: string
  positionals: string[]
  tail: string[] | null
  json: boolean
  values: { name?: string; view?: boolean; clipboard?: boolean; cwd?: string; env?: string[] }
  spec(): CreateSpec
  wait(): number
  env(): Record<string, string> | undefined
  usage(message: string): never
}

/** Kept out of index.ts so other command additions need only a dispatch hook. */
export async function ergonomicCommand(api: VmsClient, context: CommandContext): Promise<number | undefined> {
  const { verb, positionals, tail, json, values, usage } = context
  const clipboard = Boolean(values.clipboard) || process.env.KYORA_VMS_CLIPBOARD === "1"
  switch (verb) {
    case "attach": {
      if (positionals.length > 1 || json) usage("attach takes at most one sandbox name and needs a terminal")
      return attachSandbox(api, await selectSandbox(api, positionals[0]), { control: !values.view, clipboard })
    }
    case "new": {
      if (positionals.length > 1 || (positionals.length > 0 && values.name !== undefined) || json) usage("usage: kyora-vms new [name] [options] [-- cmd…]")
      if (tail !== null && !tail.length) usage("nothing after --; give a command")
      if ((values.env || values.cwd) && tail === null) usage("--env and --cwd need a command after --")
      const spec = context.spec()
      if (positionals.length) spec.name = validName(positionals[0]!)
      return newSandbox(api, spec, context.wait(), { ...(tail ? { cmd: tail } : {}), cwd: values.cwd ? remotePath(values.cwd) : undefined, env: context.env(), clipboard })
    }
    case "rename":
    case "ttl": {
      if (positionals.length !== 2) usage(`usage: kyora-vms ${verb} <x> <${verb === "rename" ? "name" : "duration"}>`)
      const change = verb === "rename" ? { name: validName(positionals[1]!) } : { ttlSeconds: positionals[1] === "none" ? 0 : parseSeconds(positionals[1]!, "duration") }
      const sandbox = await api.update(await resolveDestructiveTarget(api, positionals[0]!), change)
      if (json) printJson(sandbox)
      else console.log(verb === "rename" ? `${sandbox.name ?? positionals[1]} (${sandbox.id})` : `${sandbox.name ?? sandbox.id} ${sandbox.expiresAt === null ? "has no expiry" : `expires ${sandbox.expiresAt}`}`)
      return 0
    }
  }
}
