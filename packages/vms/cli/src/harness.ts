/** The Rust agent harness (crates/cli); `kyora run` and `kyora tui` hand off to it. */
export const HARNESS = "kyora-harness"
export const HARNESS_COMMANDS: ReadonlySet<string> = new Set(["run", "tui"])
export const HARNESS_INSTALL = "cargo install --locked --git https://github.com/kyora-sh/kyora kyora-cli"

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never

/**
 * Becomes `kyora-harness <command> <args…>`: the process is replaced, so the harness gets this
 * process's terminal, signals and exit code as if it had been run directly. Called before anything
 * touches process.stdout or process.stderr: that makes their descriptors nonblocking, which the
 * harness would inherit. When it cannot hand off, it says why and exits.
 */
export async function runHarness(command: string, args: string[]): Promise<never> {
  const bin = Bun.which(HARNESS)
  const execve = (process as unknown as { execve?: Execve }).execve
  if (bin && typeof execve === "function") execve.call(process, bin, [bin, command, ...args], process.env)
  const { exitFlushed, FAILED, note } = await import("./output")
  note(bin
    ? `kyora ${command} needs Bun 1.3.14 or later (process.execve); run \`bun upgrade\``
    : `kyora ${command} runs the kyora agent harness (${HARNESS}), which is not on your PATH; install it with: ${HARNESS_INSTALL}`)
  return exitFlushed(FAILED)
}
