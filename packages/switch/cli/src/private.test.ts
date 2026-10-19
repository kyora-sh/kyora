import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { writeSnapshot } from "./store"
import { MASK, scrub, scrubDeep, setPrivate } from "./types"

const entry = join(import.meta.dir, "index.ts")
let root = ""
let env: Record<string, string> = {}

/** the CLI against throwaway stores only: every directory a provider or the slots live in is under `root` */
function cli(args: string[], extra: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env, ...extra } })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kyora-switch-private-"))
  env = {
    HOME: join(root, "home"), KYORA_SWITCH_DIR: join(root, "switch"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CONFIG_HOME: join(root, "xdg-config"),
    KYORA_SWITCH_NO_KEYCHAIN: "1", KYORA_CLAUDE_TOKEN_URL: "",
  }
  const previous = process.env.KYORA_SWITCH_DIR
  process.env.KYORA_SWITCH_DIR = env.KYORA_SWITCH_DIR
  await writeSnapshot("work", { provider: "claude", identity: { account: "alice@example.com", org: "Acme Inc", plan: "max" }, files: {}, capturedAt: 1 })
  process.env.KYORA_SWITCH_DIR = previous
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("private mode", () => {
  test("off by default: the list is what it always was", () => {
    const plain = cli(["claude", "list"])
    expect(plain.code).toBe(0)
    expect(plain.out).toContain("alice@example.com · Acme Inc · max")
    expect(cli(["private"]).out).toContain("private mode is off")
  })

  test("--private and KYORA_SWITCH_PRIVATE=1 hide the email and org for one command, leaving the plan", () => {
    for (const run of [cli(["claude", "list", "--private"]), cli(["claude", "list"], { KYORA_SWITCH_PRIVATE: "1" })]) {
      expect(run.out).toContain("work     ••• · max")
      expect(run.out + run.err).not.toContain("alice")
      expect(run.out + run.err).not.toContain("Acme")
    }
    const json = cli(["claude", "list", "--json", "--private"])
    expect(json.out).not.toContain("alice")
    expect(JSON.parse(json.out)[0].identity).toEqual({ account: "•••", plan: "max" })
    expect(cli(["claude", "list"]).out).toContain("alice@example.com")
  })

  test("`private on` persists (0600 settings), --reveal shows once, `private off` restores the old output exactly", () => {
    const before = cli(["claude", "list"]).out
    expect(cli(["private", "on"]).out).toContain("private mode on")
    const settings = join(env.KYORA_SWITCH_DIR!, "settings.json")
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ private: true })
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    for (const args of [["claude", "list"], ["status"], ["usage"], ["claude", "usage"]]) expect(cli(args).out + cli(args).err).not.toContain("alice")
    expect(cli(["claude", "list"]).out).toContain("••• · max")
    expect(cli(["claude", "list", "--reveal"]).out).toBe(before)
    expect(cli(["claude", "list"], { KYORA_SWITCH_PRIVATE: "0" }).out).toBe(before)
    expect(cli(["claude", "list", "--private", "--reveal"]).code).toBe(2)
    expect(cli(["private", "maybe"]).code).toBe(2)
    expect(cli(["private", "off"]).out).toContain("private mode off")
    expect(cli(["claude", "list"]).out).toBe(before)
  }, 30_000)

  test("a rejected slot name is not echoed in private mode (it is often an email)", () => {
    const run = cli(["claude", "rm", "alice@example.com", "--private", "--yes"])
    expect(run.code).toBe(2)
    expect(run.out + run.err).not.toContain("alice")
    expect(cli(["claude", "rm", "alice@example.com", "--yes"]).err).toContain("alice@example.com")
  })

  test("provider free text (quota labels and details) loses emails, orgs and account ids in private mode only", () => {
    const identity = { account: "alice@example.com", org: "Acme Inc", plan: "max" }
    const quota = { remainingPct: 40, detail: "Acme Inc · alice@example.com", windows: [{ label: "acct 123e4567-e89b-12d3-a456-426614174000 bob@corp.io", usedPct: 60 }] }
    setPrivate(true)
    try {
      const shown = JSON.stringify(scrubDeep(quota, identity))
      for (const secret of ["alice", "Acme", "bob@corp.io", "123e4567"]) expect(shown).not.toContain(secret)
      expect(scrub("5h window, alice@example.com", identity)).toBe(`5h window, ${MASK}`)
    } finally {
      setPrivate(false)
    }
    expect(scrubDeep(quota, identity)).toBe(quota)
  })

  test("settings that can't be read fail closed, and `private on|off` replaces them", () => {
    const settings = join(env.KYORA_SWITCH_DIR!, "settings.json")
    rmSync(settings, { force: true, recursive: true })
    mkdirSync(settings)
    const broken = cli(["claude", "list"])
    expect(broken.out).not.toContain("alice")
    expect(broken.err).toContain("private mode assumed")
    // an empty directory in its place is replaced by `private on|off`; one with files is explained, never deleted
    expect(cli(["private", "on"]).code).toBe(0)
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ private: true })
    rmSync(settings)
    mkdirSync(settings)
    writeFileSync(join(settings, "keep"), "x")
    const full = cli(["private", "off"])
    expect(full.code).toBe(2)
    expect(full.err).toContain("move it away")
    expect(readFileSync(join(settings, "keep"), "utf8")).toBe("x")
    rmSync(settings, { recursive: true })
    writeFileSync(settings, "{not json")
    expect(cli(["claude", "list"]).out).not.toContain("alice")
    expect(cli(["private", "off"]).code).toBe(0)
    expect(cli(["claude", "list"]).out).toContain("alice@example.com")
  })
})
