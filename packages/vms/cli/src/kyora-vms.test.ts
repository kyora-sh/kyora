import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { FAILED } from "./output"
import { KEY, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, KYORA_ENTRY, makeRepo, tempDir, transcripts } from "./testing/fixtures"

// `kyora vms <args…>` and `kyora-vms <args…>` are one command: same output, same exit code
setDefaultTimeout(30_000)

let root: string
let vmd: FakeVmd

beforeEach(async () => {
  root = await tempDir("kyora-vms")
  vmd = await startFakeVmd()
})

afterEach(async () => {
  await vmd.stop()
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  for (const text of transcripts) expect(text).not.toContain(KEY)
})

const kyora = (args: string[], cwd?: string) => cli(args, { cwd, env: baseEnv(vmd.url), entry: KYORA_ENTRY })
const alias = (args: string[], cwd?: string) => cli(args, { cwd, env: baseEnv(vmd.url) })

test("kyora vms runs the command with its arguments and exits with its exit code", async () => {
  const repo = await makeRepo(root)
  const args = ["run", "--", "sh", "-c", "echo \"$1 $2\"; echo err >&2; exit 7", "sh", "two words", "--json"]
  const direct = await kyora(["vms", ...args], repo)
  expect(direct.code).toBe(7)
  expect(direct.stdout).toBe("two words --json\n")
  expect(direct.stderr).toContain("err\n")
  expect(direct.stderr).toMatch(/^\[kyora\] sb_\w+: create /m)
  const viaAlias = await alias(args, repo)
  expect(viaAlias.code).toBe(7)
  expect(viaAlias.stdout).toBe(direct.stdout)
  expect(viaAlias.stderr).toMatch(/^\[kyora-vms\] sb_\w+: create /m)
})

test("kyora vms help is kyora-vms help, and names kyora vms", async () => {
  const help = await kyora(["vms", "--help"])
  expect(help.code).toBe(0)
  expect(help.stderr).toBe("")
  expect(help.stdout).toStartWith("kyora vms: run commands in disposable VMs")
  expect(help.stdout).toContain("kyora vms create [name] [options]")
  expect(help.stdout).not.toContain("kyora-vms ")
  expect(await alias(["--help"])).toEqual(help)
  expect(await kyora(["vms", "help"])).toEqual(help)
})

test("unknown commands exit 125 and point at the right help", async () => {
  const vms = await kyora(["vms", "frobnicate"])
  expect(vms.code).toBe(FAILED)
  expect(vms.stderr).toContain("unknown command \"frobnicate\"; run `kyora vms --help`")
  const top = await kyora(["frobnicate"])
  expect(top.code).toBe(FAILED)
  expect(top.stderr).toBe("[kyora] unknown command \"frobnicate\"\n[kyora] run `kyora --help` for usage\n")
})

test("kyora vms completion completes kyora, kyora vms and kyora-vms", async () => {
  const script = await kyora(["vms", "completion", "bash"])
  expect(script.code).toBe(0)
  expect(script.stdout).toContain("complete -F _kyora kyora kyora-vms")
  expect(await alias(["completion", "bash"])).toEqual(script)
  for (const shell of ["zsh", "fish"]) expect((await kyora(["vms", "completion", shell])).stdout).toContain("kyora vms __complete")
})
