import { randomInt } from "node:crypto"
import { ApiError, type Sandbox } from "./api.js"

export function validName(name: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error("name must be 1-32 characters of a-z, 0-9 and -")
  return name
}

const adjectives = "brisk calm clever cozy crisp eager fair fast fresh gentle glad golden green happy jolly keen kind lively lucky merry nimble quiet rapid rosy shy silver sleek smart sunny swift tidy warm wild witty young zippy".split(" ")
const nouns = "badger bear bee bison crane deer dove duck eagle elk falcon finch fox frog gecko hare hawk heron koala lark lynx moth mouse newt otter owl panda pony quail raven robin seal snail sparrow swan tiger trout turtle whale wolf wren yak zebra".split(" ")

export function friendlyName(): string {
  return `${adjectives[randomInt(adjectives.length)]}-${nouns[randomInt(nouns.length)]}`
}

export const sandboxLabel = (sandbox: Sandbox): string => sandbox.name ?? sandbox.id

export function resolveSandbox(sandboxes: Sandbox[], input: string): Sandbox {
  if (!input) throw new Error("sandbox name or id must not be empty")
  const exact = sandboxes.find((s) => s.id === input || s.name === input)
  if (exact) return exact
  const candidates = sandboxes.filter((s) => s.id.startsWith(input))
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1) throw new Error(`ambiguous sandbox prefix ${input}:\n${candidates.map((s) => `  ${sandboxLabel(s)}  ${s.id}`).join("\n")}`)
  throw new Error(`no sandbox named ${input}; run kyora vms ls`)
}

export const isFullId = (input: string): boolean => /^(?:sb_[0-9a-f]{16}|sb_(?:[a-z][a-z0-9-]{1,23}_)?[a-z0-9]{6}_[A-Za-z0-9_-]{16}|sb_(?:[a-z][a-z0-9-]{1,23}_)?[a-z2-7]{26})$/.test(input)

/** Names resolve only on the server; a stale list cannot resurrect a missing alias. */
export async function namedSandbox(api: { get(input: string): Promise<Sandbox> }, input: string): Promise<Sandbox | null> {
  if (!/^[a-z0-9-]{1,32}$/.test(input)) return null
  return api.get(input)
}

/** Full ids retain the old direct path, including DELETE's already-gone behavior. */
export async function resolveTarget(api: { list(): Promise<Sandbox[]>; get(input: string): Promise<Sandbox> }, input: string): Promise<string> {
  if (!input) throw new Error("sandbox name or id must not be empty")
  if (isFullId(input)) return input
  const named = await namedSandbox(api, input)
  if (named) return named.id
  const sandboxes = await api.list()
  if (!sandboxes.some((s) => s.id.startsWith(input)) && /^sb_[A-Za-z0-9_-]{16}$/.test(input)) return input
  return resolveSandbox(sandboxes, input).id
}

export function shortIds(sandboxes: Sandbox[]): string[] {
  return sandboxes.map((s) => {
    let length = Math.min(11, s.id.length)
    while (length < s.id.length && sandboxes.some((other) => other.id !== s.id && other.id.startsWith(s.id.slice(0, length)))) length++
    return s.id.slice(0, length)
  })
}

export const sandboxArgument = (name: string): string => name.startsWith("-") ? `-- ${name}` : name

/** `--` can escape a sandbox name as well as mark a remote command. */
export function sandboxArgs(verb: string, positionals: string[], tail: string[] | null): { positionals: string[]; tail: string[] | null } {
  if (tail === null) return { positionals, tail }
  if (["create", "attach", "ls", "rm", "rename", "ttl", "network", "push", "pull", "screenshot", "share", "snapshot", "snapshots", "restore"].includes(verb)) return { positionals: [...positionals, ...tail], tail: null }
  if (!positionals.length && ["exec", "shell", "computer"].includes(verb)) {
    const count = verb === "computer" ? 2 : 1
    const args = tail.slice(count)
    if (args[0] === "--") args.shift()
    return { positionals: tail.slice(0, count), tail: verb === "shell" && !args.length ? null : args }
  }
  return { positionals, tail }
}

/** Destructive references must not turn an incomplete list into a full-id deletion. */
export async function resolveDestructiveTarget(api: { resolve(input: string): Promise<{ id: string }>; get(input: string): Promise<Sandbox> }, input: string): Promise<string> {
  if (!input) throw new Error("sandbox name or id must not be empty")
  if (isFullId(input)) return input
  if (/^sb_[A-Za-z0-9_-]{16}$/.test(input)) {
    try {
      if ((await api.get(input)).id === input) return input
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }
  }
  return (await api.resolve(input)).id
}
