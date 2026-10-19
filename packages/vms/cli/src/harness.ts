import { constants } from "node:os"
import { FAILED, note } from "./output"

/** The Rust agent harness (crates/cli); `kyora run` and `kyora tui` hand off to it. */
export const HARNESS = "kyora-harness"
export const HARNESS_COMMANDS: ReadonlySet<string> = new Set(["run", "tui"])
export const HARNESS_INSTALL = "cargo install --locked --git https://github.com/kyora-sh/kyora kyora-cli"

/**
 * Runs `kyora-harness <command> <args…>` in this terminal and returns its exit code. Ctrl-C reaches
 * the harness through the terminal's process group, so this process only outlives it; SIGTERM and
 * SIGHUP sent to `kyora` alone are passed on.
 */
export async function runHarness(command: string, args: string[]): Promise<number> {
  const bin = Bun.which(HARNESS)
  if (!bin) {
    note(`kyora ${command} runs the kyora agent harness (${HARNESS}), which is not on your PATH; install it with: ${HARNESS_INSTALL}`)
    return FAILED
  }
  const child = Bun.spawn([bin, command, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const ignore = () => {}
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const handlers = { SIGINT: ignore, SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP") } as const
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler)
  try {
    const code = await child.exited
    const signal = child.signalCode
    return signal ? 128 + (constants.signals[signal] ?? 0) : code
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler)
  }
}
