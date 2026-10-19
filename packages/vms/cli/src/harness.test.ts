import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FAILED } from "./output"

setDefaultTimeout(30_000)
const entry = join(import.meta.dir, "kyora.ts")
const alias = join(import.meta.dir, "index.ts")
const temps: string[] = []
let without: string

const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** a directory holding a fake kyora-harness with this shell script as its body */
async function harness(script: string): Promise<string> {
  const dir = await temp("kyora-harness-bin-")
  await writeFile(join(dir, "kyora-harness"), `#!/bin/sh\n${script}`)
  await chmod(join(dir, "kyora-harness"), 0o755)
  return dir
}

beforeAll(async () => {
  without = await temp("kyora-harness-none-")
})

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function kyora(args: string[], path: string, bin = entry) {
  const child = Bun.spawn([process.execPath, "--no-env-file", bin, ...args], { env: { HOME: without, PATH: path }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

test("kyora run and kyora tui hand their arguments to kyora-harness and exit with its code", async () => {
  const dir = await harness('printf "%s|" "$@"\nexit 7\n')
  expect(await kyora(["run", "fix the build", "--model", "anthropic/x"], dir)).toEqual({ stdout: "run|fix the build|--model|anthropic/x|", stderr: "", code: 7 })
  expect(await kyora(["tui", "--demo"], dir)).toEqual({ stdout: "tui|--demo|", stderr: "", code: 7 })
})

test("the harness writes through a slow pipe without losing output", async () => {
  const dir = await harness('head -c 2097152 /dev/zero\necho "head $?" >&2\n')
  const path = `${dir}:/usr/bin:/bin`
  const pipeline = `"$KYORA_BUN" --no-env-file "$KYORA_ENTRY" run task | (sleep 1; wc -c)`
  const child = Bun.spawn(["/bin/sh", "-c", pipeline], { env: { HOME: without, PATH: path, KYORA_BUN: process.execPath, KYORA_ENTRY: entry }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ bytes: stdout.trim(), stderr, code }).toEqual({ bytes: "2097152", stderr: "head 0\n", code: 0 })
})

test("a SIGINT sent to kyora's own pid reaches the harness, which kyora has become", async () => {
  const dir = await harness("trap 'echo interrupted; exit 3' INT\necho ready\nwhile :; do sleep 0.1; done\n")
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "run", "task"], { env: { HOME: without, PATH: `${dir}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("ready\n")) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    child.kill("SIGINT")
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) seen += decoder.decode(chunk.value)
    const code = await child.exited
    expect({ seen, code, stderr: await new Response(child.stderr).text() }).toEqual({ seen: "ready\ninterrupted\n", code: 3, stderr: "" })
  } finally {
    clearTimeout(deadline)
    child.kill("SIGKILL")
    await child.exited
  }
})

test("without kyora-harness on PATH, kyora run says how to install it", async () => {
  const result = await kyora(["run", "task"], without)
  expect(result.code).toBe(FAILED)
  expect(result.stdout).toBe("")
  expect(result.stderr).toStartWith("[kyora] kyora run runs the kyora agent harness (kyora-harness)")
  expect(result.stderr).toContain("cargo install --locked --git https://github.com/kyora-sh/kyora kyora-cli")
  expect(await kyora(["run", "--help"], without)).toEqual(result)
})

test("kyora --help lists the harness commands, kyora vms and the account commands", async () => {
  const { stdout, code } = await kyora(["--help"], without)
  expect(code).toBe(0)
  for (const line of ["kyora run …", "kyora tui …", "kyora vms …", "kyora login [--url URL]", "kyora-vms is deprecated"]) expect(stdout).toContain(line)
  expect(stdout).not.toMatch(/[\u2013\u2014]/)
})

test("kyora-vms <args> is kyora vms <args>, with nothing added to its output", async () => {
  const dir = await harness('echo harness\nexit 7\n')
  const help = await kyora(["--help"], dir, alias)
  expect(help).toEqual(await kyora(["vms", "--help"], dir))
  expect(help.stdout).toStartWith("kyora vms: run commands in disposable VMs")
  expect(help.stderr).toBe("")
  // run is the sandbox run here: no command after -- is a usage error, not the harness
  const run = await kyora(["run"], dir, alias)
  const direct = await kyora(["vms", "run"], dir)
  expect(run).toEqual({ ...direct, stderr: direct.stderr.replaceAll("[kyora] ", "[kyora-vms] ") })
  expect(run.stdout).not.toContain("harness")
  expect(run.stderr).toContain("[kyora-vms] no command: put it after --")
  expect(direct.stderr).toContain("[kyora] no command: put it after --")
  expect(run.code).toBe(FAILED)
})

test("kyora login is kyora vms login", async () => {
  const { stdout, code } = await kyora(["vms", "--help"], without)
  expect(code).toBe(0)
  const top = await kyora(["login", "extra"], without)
  expect(top).toEqual(await kyora(["vms", "login", "extra"], without))
  expect(top.stderr).toContain("login takes no arguments")
  expect(stdout).toContain("kyora vms login [--url URL]")
})
