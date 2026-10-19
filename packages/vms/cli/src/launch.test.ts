import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// kyora-vms runs inside the repositories it uploads, untrusted ones included. Bun reads a .env and
// a bunfig.toml (whose `preload` runs code first) from the working directory unless the shebang
// says not to: running `kyora-vms run` in a repository must never run that repository's code here.
for (const name of ["index.ts", "kyora.ts"]) {
  test(`${name}'s shebang keeps a directory's .env and bunfig.toml out of the CLI`, async () => {
    const entry = join(import.meta.dir, name)
    const shebang = (await Bun.file(entry).text()).split("\n")[0]!
    expect(shebang).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null")
    const repo = await mkdtemp(join(tmpdir(), "kyora-vms-launch-"))
    await writeFile(join(repo, ".env"), "KYORA_VMS_URL=http://127.0.0.1:9/planted\n")
    await writeFile(join(repo, "bunfig.toml"), 'preload = ["./planted.ts"]\n')
    await writeFile(join(repo, "planted.ts"), 'console.log("PLANTED CODE RAN")\n')
    const flags = shebang.split(/\s+/).slice(3)
    const run = Bun.spawnSync([process.execPath, ...flags, entry, "--help"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: repo } })
    const out = run.stdout.toString() + run.stderr.toString()
    expect(out).not.toContain("PLANTED CODE RAN")
    expect(out).not.toContain("127.0.0.1:9")
    expect(out).toContain("kyora")
  })
}
