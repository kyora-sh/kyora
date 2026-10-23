import { mkdtempSync, rmSync } from "node:fs"
import { chmod, mkdir, mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { KEY, TOKEN } from "./fake-vmd"

export const ENTRY = join(import.meta.dir, "..", "index.ts")
/** the `kyora` bin; `kyora vms <args…>` is what ENTRY (`kyora-vms`) runs */
export const KYORA_ENTRY = join(import.meta.dir, "..", "kyora.ts")

/**
 * The CLI under test gets a HOME of its own even when the package's test preload
 * did not run (a `bun test` from the repo root), so it can never find the
 * developer's real ~/.config/kyora-vms/env.
 */
export const TEST_HOME = mkdtempSync(join(tmpdir(), "kyora-vms-cli-home-"))
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }))

/** git that can never see the developer's own gitconfig, global excludes or hooks */
export const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

export function sh(cmd: string[], cwd?: string): string {
  const result = Bun.spawnSync(cmd, { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `kyora-vms-test-${prefix}-`))
}

export async function write(root: string, path: string, contents: string, mode?: number): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await Bun.write(join(root, path), contents)
  if (mode !== undefined) await chmod(join(root, path), mode)
}

export const LONG_NAME = `deep/${"nested-directory-name/".repeat(6)}naïve-ünïcode-file.txt`

/**
 * A repo with every case the packer must get right: ignored build output and
 * secrets, an untracked file, an executable script, an in-tree and an escaping
 * symlink, a file deleted from the worktree but still in the index, a nested
 * repo with its own .gitignore, and a path too long for plain ustar.
 */
export async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo")
  await mkdir(repo, { recursive: true })
  sh(["git", "init", "--quiet", "-b", "main"], repo)
  await write(repo, ".gitignore", "target/\n*.log\nsecret.env\n")
  await write(repo, "src/main.rs", 'fn main() { println!("hi") }\n')
  await write(repo, "build.sh", "#!/bin/sh\necho built-ok\n", 0o755)
  await write(repo, "gone.txt", "deleted after commit\n")
  await write(repo, LONG_NAME, "long\n")
  await symlink("src/main.rs", join(repo, "link.rs"))
  await symlink("../../outside-secret", join(repo, "escape"))
  sh(["git", "add", "-A"], repo)
  sh(["git", "commit", "--quiet", "-m", "init"], repo)
  sh(["rm", "gone.txt"], repo)

  await write(repo, "notes.txt", "untracked but not ignored\n")
  await write(repo, "secret.env", "TOKEN=hunter2\n")
  await write(repo, "debug.log", "noise\n")
  await write(repo, "target/debug/big.bin", "x".repeat(1024))

  const nested = join(repo, "nested")
  await mkdir(nested)
  sh(["git", "init", "--quiet", "-b", "main"], nested)
  await write(nested, ".gitignore", "cache/\n")
  await write(nested, "lib.txt", "nested repo file\n")
  await write(nested, "cache/junk.bin", "junk\n")
  return repo
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface CliOptions {
  cwd?: string
  /** replaces the default URL/key env entirely when given */
  env?: Record<string, string | undefined>
  stdin?: string
  /** run without --no-env-file, the way `bun src/index.ts` would */
  loadDotenv?: boolean
  /** the script to run instead of ENTRY */
  entry?: string
}

/** every stdout and stderr any test saw, checked for the key at the end */
export const transcripts: string[] = []

/** BROWSER=none: nothing a test runs may open a real browser on the developer's desktop */
export function baseEnv(url: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...GIT_ENV, HOME: TEST_HOME, XDG_CONFIG_HOME: undefined, KYORA_VMS_URL: url, KYORA_VMS_KEY: KEY, BROWSER: "none", NO_COLOR: "1", ...extra }
}

/** the same, pointed at a fake kyora cloud with a personal token */
export function platformEnv(url: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return baseEnv(url, { KYORA_VMS_KEY: undefined, KYORA_TOKEN: TOKEN, ...extra })
}

export function spawnCli(args: string[], options: CliOptions & { env: Record<string, string | undefined> }) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ...(options.loadDotenv ? [] : ["--no-env-file"]), options.entry ?? ENTRY, ...args],
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    stdin: options.stdin !== undefined ? Buffer.from(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let stdout = ""
  let stderr = ""
  const read = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) append(decoder.decode(chunk, { stream: true }))
  }
  const reading = Promise.all([read(proc.stdout, (text) => (stdout += text)), read(proc.stderr, (text) => (stderr += text))])
  const done = (async (): Promise<CliResult> => {
    const [code] = await Promise.all([proc.exited, reading])
    transcripts.push(stdout, stderr)
    return { code, stdout, stderr }
  })()
  return { proc, done, stdout: () => stdout, stderr: () => stderr }
}

export async function cli(args: string[], options: CliOptions & { env: Record<string, string | undefined> }): Promise<CliResult> {
  return spawnCli(args, options).done
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** resident memory of a process in bytes, 0 once it is gone */
export function rssOf(pid: number): number {
  const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  return (Number.parseInt(result.stdout.toString().trim(), 10) || 0) * 1024
}
