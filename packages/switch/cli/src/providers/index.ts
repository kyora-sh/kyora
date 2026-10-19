import type { Provider, ProviderId } from "../types"
import { agyProvider } from "./agy"
import { claudeProvider } from "./claude"
import { codexProvider } from "./codex"
import { grokProvider } from "./grok"
import { museProvider } from "./muse"
import { opencodeProvider } from "./opencode"

export const PROVIDERS: Provider[] = [claudeProvider, codexProvider, opencodeProvider, museProvider, grokProvider, agyProvider]

export function providerById(id: ProviderId): Provider {
  const provider = PROVIDERS.find((candidate) => candidate.id === id)
  if (!provider) throw new Error(`unknown provider "${id}"`)
  return provider
}

/** how many processes hold a CLI's login in memory, or why that could not be told */
export type Sessions = { count: number } | { unknown: string }

export const isIdle = (sessions: Sessions): boolean => "count" in sessions && sessions.count === 0

export const isRunning = (sessions: Sessions): boolean => "count" in sessions && sessions.count > 0

async function output(command: string[]): Promise<{ exitCode: number; stdout: string } | { unknown: string }> {
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    return { exitCode, stdout }
  } catch {
    return { unknown: `${command[0]} could not be run` }
  }
}

/** the pid of a `ps` line that is node (or bun) running `script`, never this process */
function runsScript(line: string, script: RegExp): string | undefined {
  const match = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line)
  if (!match || Number(match[1]) === process.pid) return undefined
  const executable = match[2]!.split("/").pop()
  if (executable !== "node" && executable !== "nodejs" && executable !== "bun") return undefined
  return script.test(match[3]!) ? match[1] : undefined
}

/**
 * Counts processes still holding this login in memory, matched on executable name, and for a CLI
 * that may run as a Node.js script, on node or bun processes running it. `pgrep -f` would also hit every
 * process that merely mentions `.claude/` in its arguments. Only `pgrep`'s exit 1 means none: any
 * other failure is unknown, never idle.
 */
export async function runningSessions(provider: Provider): Promise<Sessions> {
  const pgrep = await output(["pgrep", "-x", provider.processName])
  if ("unknown" in pgrep) return pgrep
  if (pgrep.exitCode !== 0 && pgrep.exitCode !== 1) return { unknown: `pgrep failed (exit ${pgrep.exitCode})` }
  const pids = new Set(pgrep.exitCode === 0 ? pgrep.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [])
  if (provider.nodeScript) {
    const ps = await output(["ps", "-A", "-o", "pid=,args="])
    if ("unknown" in ps) return ps
    if (ps.exitCode !== 0) return { unknown: `ps failed (exit ${ps.exitCode})` }
    for (const line of ps.stdout.split("\n")) {
      const pid = runsScript(line, provider.nodeScript)
      if (pid !== undefined) pids.add(pid)
    }
  }
  pids.delete(String(process.pid))
  return { count: pids.size }
}
