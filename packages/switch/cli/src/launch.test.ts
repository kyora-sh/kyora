import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// kyora-switch runs in whatever directory the user is in. Bun reads a .env and a bunfig.toml
// (whose `preload` runs code first) from there unless the shebang says not to: a repository
// could otherwise plant env that redirects credentials, or run code before the CLI does.
test("the shebang keeps a directory's .env and bunfig.toml out of the CLI", async () => {
  const entry = join(import.meta.dir, "index.ts")
  const shebang = (await Bun.file(entry).text()).split("\n")[0]!
  expect(shebang).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null")
  const repo = await mkdtemp(join(tmpdir(), "kyora-switch-launch-"))
  await writeFile(join(repo, ".env"), "KYORA_CLAUDE_TOKEN_URL=http://127.0.0.1:9/planted\n")
  await writeFile(join(repo, "bunfig.toml"), 'preload = ["./planted.ts"]\n')
  await writeFile(join(repo, "planted.ts"), 'console.log("PLANTED CODE RAN")\n')
  const flags = shebang.split(/\s+/).slice(3)
  const run = Bun.spawnSync([process.execPath, ...flags, entry, "--help"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, KYORA_CLAUDE_TOKEN_URL: "" } })
  const out = run.stdout.toString() + run.stderr.toString()
  expect(out).not.toContain("PLANTED CODE RAN")
  expect(out).toContain("kyora-switch")
})
