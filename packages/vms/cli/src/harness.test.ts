import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FAILED } from "./output"

setDefaultTimeout(30_000)
const entry = join(import.meta.dir, "kyora.ts")
let withHarness: string
let without: string

beforeAll(async () => {
  withHarness = await mkdtemp(join(tmpdir(), "kyora-harness-bin-"))
  without = await mkdtemp(join(tmpdir(), "kyora-harness-none-"))
  const fake = join(withHarness, "kyora-harness")
  await writeFile(fake, '#!/bin/sh\nprintf "%s|" "$@"\nexit 7\n')
  await chmod(fake, 0o755)
})

afterAll(async () => {
  await Promise.all([withHarness, without].map((dir) => rm(dir, { recursive: true, force: true })))
})

async function kyora(args: string[], path: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { env: { HOME: without, PATH: path }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

test("kyora run and kyora tui hand their arguments to kyora-harness and exit with its code", async () => {
  expect(await kyora(["run", "fix the build", "--model", "anthropic/x"], withHarness)).toEqual({ stdout: "run|fix the build|--model|anthropic/x|", stderr: "", code: 7 })
  expect(await kyora(["tui", "--demo"], withHarness)).toEqual({ stdout: "tui|--demo|", stderr: "", code: 7 })
})

test("without kyora-harness on PATH, kyora run says how to install it", async () => {
  const result = await kyora(["run", "task"], without)
  expect(result.code).toBe(FAILED)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("kyora-harness")
  expect(result.stderr).toContain("cargo install --locked --git https://github.com/kyora-sh/kyora kyora-cli")
})

test("kyora --help lists the harness commands", async () => {
  const { stdout, code } = await kyora(["--help"], without)
  expect(code).toBe(0)
  expect(stdout).toContain("kyora run …")
  expect(stdout).toContain("kyora tui …")
})
