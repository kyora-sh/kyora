import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const sources = { kyora: join(import.meta.dir, "kyora.ts"), standalone: join(import.meta.dir, "../../../switch/cli/src/index.ts") }
const built = { kyora: "", standalone: "" }
const temps: string[] = []

const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** both bins as `bun run build` makes them: the kyora bin bundles kyora-switch, which must not run itself there */
beforeAll(async () => {
  const out = await temp("kyora-switch-bundles-")
  const entries = { kyora: [join(import.meta.dir, "index.ts"), sources.kyora], standalone: [sources.standalone] }
  for (const name of ["kyora", "standalone"] as const) {
    const result = await Bun.build({ entrypoints: entries[name], outdir: join(out, name), target: "bun", minify: true })
    if (!result.success) throw new AggregateError(result.logs, `${name} did not build`)
    built[name] = result.outputs.find((output) => basename(output.path) === (name === "kyora" ? "kyora.js" : "index.js"))!.path
  }
})

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** a throwaway HOME where every login location is empty, the keychain is off and nothing of the shell's env reaches the CLIs */
async function sandbox(): Promise<Record<string, string>> {
  const home = await temp("kyora-switch-passthrough-")
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GROK_HOME: join(home, ".grok"),
    KYORA_SWITCH_DIR: join(home, ".kyora", "switch"),
    KYORA_SWITCH_NO_KEYCHAIN: "1",
  }
}

function run(entry: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", entry, ...args], { cwd: env.HOME, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

const builds = [["source", () => sources], ["bundle", () => built]] as const

for (const [kind, bins] of builds) {
  const both = (args: string[], env: Record<string, string>) => ({ kyora: run(bins().kyora, ["switch", ...args], env), standalone: run(bins().standalone, args, env) })

  test(`${kind}: kyora switch status --json prints what kyora-switch status --json does`, async () => {
    const env = await sandbox()
    for (const args of [["status", "--json"], ["claude", "list", "--json"], ["usage", "--json", "--no-renew"]]) {
      const { kyora, standalone } = both(args, env)
      expect(standalone.code).toBe(0)
      expect(kyora).toEqual(standalone)
      expect(() => JSON.parse(kyora.stdout)).not.toThrow()
    }
  })

  test(`${kind}: kyora switch writes and fails like kyora-switch`, async () => {
    const [mine, theirs] = [await sandbox(), await sandbox()]
    for (const args of [["private", "on"], ["status"], ["private", "off"]]) {
      const kyora = run(bins().kyora, ["switch", ...args], mine)
      expect(kyora).toEqual(run(bins().standalone, args, theirs))
      expect(kyora.code).toBe(0)
    }
    expect(await Bun.file(join(mine.KYORA_SWITCH_DIR!, "settings.json")).text()).toBe(await Bun.file(join(theirs.KYORA_SWITCH_DIR!, "settings.json")).text())
    await mkdir(join(mine.XDG_CONFIG_HOME!, "muse"), { recursive: true })
    await writeFile(join(mine.XDG_CONFIG_HOME!, "muse", "auth.json"), "{not json")
    const unreadable = both(["status"], mine)
    expect(unreadable.standalone.code).toBe(1)
    expect(unreadable.kyora).toEqual(unreadable.standalone)
  })

  test(`${kind}: kyora switch --help is kyora-switch's help, named kyora switch`, async () => {
    const env = await sandbox()
    for (const args of [["--help"], ["-h"], ["help"], ["claude", "--help"]]) {
      const { kyora, standalone } = both(args, env)
      expect(kyora.code).toBe(0)
      expect(standalone.stdout).toContain("kyora-switch claude save <slot>")
      expect(kyora.stdout).toBe(standalone.stdout.replaceAll("kyora-switch", "kyora switch"))
      expect(kyora.stdout).not.toContain("kyora-switch")
    }
    expect(run(bins().kyora, ["--help"], env).stdout).toContain("kyora switch …")
  })

  test(`${kind}: kyora switch passes every argument through and keeps kyora-switch's exit codes`, async () => {
    const env = await sandbox()
    const cases: Array<[string[], number, string]> = [
      [["bogus"], 2, 'unknown command "bogus"'],
      [["--nope"], 2, "Unknown option '--nope'"],
      [["refresh", "--no-renew"], 2, "--no-renew and refresh contradict each other"],
      [["--private", "--reveal", "status"], 2, "--private and --reveal contradict each other"],
      [["claude", "frobnicate"], 2, 'unknown claude command "frobnicate"'],
    ]
    for (const [args, code, message] of cases) {
      const { kyora, standalone } = both(args, env)
      expect(standalone.code).toBe(code)
      expect(kyora.code).toBe(code)
      expect(kyora.stderr).toContain(message)
      expect(kyora.stdout).toBe(standalone.stdout)
      expect(kyora.stderr).toBe(standalone.stderr.replaceAll("`kyora-switch ", "`kyora switch "))
    }
    const listed = both(["claude", "list"], env)
    expect(listed.standalone.stdout).toContain("`kyora-switch claude save <slot>`")
    expect(listed.kyora.stdout).toBe(listed.standalone.stdout.replace("`kyora-switch ", "`kyora switch "))
  })
}
