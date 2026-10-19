import { afterAll, expect, test } from "bun:test"
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprintOf } from "./sync"

/**
 * Old build against new: every command that existed before prints, byte for byte, what the base
 * revision prints, and leaves the same files behind (bytes and permissions), on the same fixture
 * slots. The base is KYORA_SWITCH_DIFF_BASE, else this checkout's merge base with origin/main, so a
 * plain `bun test` runs it wherever origin/main is there to compare with, and has kyora-switch to
 * compare; KYORA_SWITCH_DIFF_REQUIRED=1 makes a missing base a failure:
 *
 *   KYORA_SWITCH_DIFF_BASE=origin/main bun test src/differential.test.ts
 *
 * Both builds run against throwaway dirs only, with no keychain, a local stand-in for every vendor
 * route, and a `pgrep`, `ps` and `security` that find nothing, so nothing on the machine reaches the output.
 */
function mergeBase(): string | undefined {
  const git = Bun.spawnSync(["git", "-C", import.meta.dir, "merge-base", "HEAD", "origin/main"], { stdout: "pipe", stderr: "ignore" })
  const sha = git.exitCode === 0 ? git.stdout.toString().trim() : ""
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
}
/** a base from before kyora-switch was in this repository has nothing to compare with */
function hasSwitch(revision: string | undefined): string | undefined {
  if (!revision) return undefined
  const git = Bun.spawnSync(["git", "-C", import.meta.dir, "cat-file", "-e", `${revision}:packages/switch/cli/src/index.ts`], { stdout: "ignore", stderr: "ignore" })
  return git.exitCode === 0 ? revision : undefined
}
const base = process.env.KYORA_SWITCH_DIFF_BASE || hasSwitch(mergeBase())
const required = process.env.KYORA_SWITCH_DIFF_REQUIRED === "1"
const bundled = process.env.KYORA_SWITCH_DIFF_BUNDLED === "1"
let root = ""
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

test.skipIf(Boolean(base) || !required)("a base revision to compare with is there (fetch origin/main)", () => {
  throw new Error("no base revision: set KYORA_SWITCH_DIFF_BASE, or fetch origin/main (actions/checkout with fetch-depth: 0)")
})

/** what kyora-switch only writes since `tokens`: the switch history, its gaps, the token cache and the slot lock */
const NEW_FILES = /^(switch-history|token-cache-v1\.sqlite|\.switch\.lock$)/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const TIMES = /("(?:createdAt|updatedAt|capturedAt)"\s*:\s*)-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi

/**
 * The next build may know providers the base does not (muse, grok): shared commands
 * gain their lines, headers and JSON entries, which the base cannot print. Dropping
 * exactly those additions leaves every pre-existing byte to be compared as before;
 * each provider's own behaviour is covered by its provider tests, not by this file.
 */
const NEW_PROVIDERS = [
  { id: "muse", header: "muse: Muse" },
  { id: "grok", header: "grok: Grok Build" },
  { id: "agy", header: "agy: Antigravity" },
]
const NEW_IDS = new Set(NEW_PROVIDERS.map((provider) => provider.id))
const NEW_HEADERS = new Set(NEW_PROVIDERS.map((provider) => provider.header))
const NEW_ROW = new RegExp(`^(?:${NEW_PROVIDERS.map((provider) => provider.id).join("|")})(\\s|:)`)
const NEW_HELP = NEW_PROVIDERS.map((provider) => `  kyora-switch ${provider.id} `)
const MULTI_COMMANDS = new Set(["status", "sync", "usage", "refresh", "doctor"])

export function withoutNewProviders(output: string, args: string[] = []): string {
  const multi = args.length === 0 || MULTI_COMMANDS.has(args[0]!)
  const trimmed = output.trim()
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && multi) {
    try {
      const parsed = JSON.parse(output) as unknown
      const cleaned = Array.isArray(parsed)
        ? parsed.filter((row) => !NEW_IDS.has((row as { provider?: string })?.provider ?? ""))
        : parsed !== null && typeof parsed === "object"
          ? Object.fromEntries(Object.entries(parsed).filter(([key]) => !NEW_IDS.has(key)))
          : parsed
      return `${JSON.stringify(cleaned, null, 2)}\n`
    } catch {
      // not JSON after all: fall through to the line-wise drop
    }
  }
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && !multi) {
    try {
      JSON.parse(output)
      return output
    } catch {
      // not JSON after all: fall through to the line-wise drop
    }
  }
  const trailingNewline = output.endsWith("\n")
  const lines = output.split("\n")
  if (trailingNewline) lines.pop()
  const kept: string[] = []
  let dropping = false
  let droppedHelp = false
  for (const line of lines) {
    if (NEW_HEADERS.has(line)) {
      if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
      dropping = true
      continue
    }
    if (dropping) {
      if (line === "") {
        dropping = false
        kept.push(line)
      }
      continue
    }
    if (NEW_HELP.some((prefix) => line.startsWith(prefix))) {
      droppedHelp = true
      continue
    }
    if (droppedHelp && line === "") {
      droppedHelp = false
      continue
    }
    droppedHelp = false
    if (multi && NEW_ROW.test(line)) continue
    kept.push(line)
  }
  if (kept.length === 0) return ""
  return `${kept.join("\n")}${trailingNewline ? "\n" : ""}`
}

const APPROVED_COPY_CHANGES = [
  [
    "  kyora-switch claude refresh           renew the tokens of stale slots, then show usage\n",
    "  kyora-switch claude refresh           renew the live login and stale slots, then show usage\n",
  ],
  [
    "  kyora-switch refresh                  renew stale slot tokens, then show usage\n",
    "  kyora-switch refresh                  renew the live logins and stale slots, then show usage\n",
  ],
  [
    "status, list, usage and load update the slot for the current local login.\n",
    "status, list, usage and load update the slot for the current local login.\nOnly refresh renews logins: usage reads quota and never calls a token server.\nA renewal that failed is retried after an hour, or at once by\n`kyora-switch <cli> refresh`; a refused refresh token only after a new save.\n",
  ],
  [
    "  --refresh      renew a stale slot's token before reading its quota\n  --no-renew     usage only reads: the live login is not renewed either\n  --force        load or save a slot in use by kyora cloud anyway\n",
    "  --refresh      usage: run refresh first\n  --no-renew     accepted and ignored: usage never renews a login\n  --force        load or save a slot in use by kyora cloud, or load agy while it runs\n",
  ],
  [
    "kyora-switch: hot-swap Claude Code, Codex, OpenCode, Muse and Grok Build logins",
    "kyora-switch: hot-swap Claude Code, Codex, OpenCode, Muse, Grok Build and Antigravity logins",
  ],
  [
    "  kyora-switch status                   which account each CLI is logged into\n",
    "  kyora-switch status                   which account each CLI is logged into, and its data collection\n",
  ],
  [
    "kyora-switch: hot-swap Claude Code, Codex and OpenCode logins",
    "kyora-switch: hot-swap Claude Code, Codex, OpenCode, Muse, Grok Build and Antigravity logins",
  ],
  [
    "kyora-switch: hot-swap Claude Code, Codex, OpenCode and Muse logins",
    "kyora-switch: hot-swap Claude Code, Codex, OpenCode, Muse, Grok Build and Antigravity logins",
  ],
  [
    "Every read (status, list, usage) and every load syncs the live login into its\nslot first, so the CLI's own token refreshes never leave a slot behind.",
    "status, list, usage and load update the slot for the current local login.",
  ],
  [
    "A slot `kyora session creds sync` uploaded to kyora cloud is the broker's until\n`kyora session creds return`: kyora-switch never syncs into it or refreshes it,",
    "A slot uploaded with `kyora session creds sync` is in use by kyora cloud until\n`kyora session creds return`: local sync and refresh skip it,",
  ],
  ["  --force        load or save a slot kyora cloud's broker owns anyway", "  --force        load or save a slot in use by kyora cloud anyway"],
  [
    '"cloud" is owned by kyora cloud\'s broker: loading it hands the broker\'s login to Claude Code, which refreshes it and signs the broker out (or is signed out itself). `kyora session creds return --slot cloud` takes it back first; --force loads it anyway',
    '"cloud" is in use by kyora cloud. `kyora session creds return --slot cloud` takes it back first; --force loads it anyway and may sign out the cloud session',
  ],
  [
    '"cloud" is owned by kyora cloud\'s broker: saving over it leaves the slot and the broker with different logins. `kyora session creds return --slot cloud` takes it back first; --force saves anyway',
    '"cloud" is in use by kyora cloud. `kyora session creds return --slot cloud` takes it back first; --force saves anyway',
  ],
  [
    '"cloud" is owned by kyora cloud\'s broker, which knows it by that name; `kyora session creds return --slot cloud` takes it back first',
    '"cloud" is in use by kyora cloud; `kyora session creds return --slot cloud` takes it back first',
  ],
  [
    "kyora cloud's broker owns this slot; `kyora session creds return --slot cloud` takes it back",
    "in use by kyora cloud; `kyora session creds return --slot cloud` takes it back",
  ],
] as const

/** Every provider's usage block now shares one slot column: the padding before it may differ, the text may not. */
function sharedColumn(args: string[]): (output: string) => string {
  if (!["usage", "refresh"].includes(args[0] ?? "")) return (output) => output
  return (output) => output.replace(/^([* ] \S*) {2,}/gm, "$1  ").replace(/^ {4,}/gm, "    ")
}

/** `status` now names each provider's data collection: a line under each row, a field in each JSON row */
export function withoutDataCollection(output: string, args: string[]): string {
  if ((args.find((arg) => !arg.startsWith("-")) ?? "status") !== "status") return output
  if (args.includes("--json")) {
    try {
      const rows = JSON.parse(output) as Record<string, unknown>[]
      return `${JSON.stringify(rows.map(({ dataCollection: _dropped, ...row }) => row), null, 2)}\n`
    } catch {
      return output
    }
  }
  return output.split("\n").filter((line) => !line.startsWith("         data collection: ")).join("\n")
}

function approvedCopy(output: string): string {
  for (const [before, after] of APPROVED_COPY_CHANGES) {
    if (output.includes(after)) continue
    output = output.replaceAll(before, after)
    output = output.replaceAll(JSON.stringify(before).slice(1, -1), JSON.stringify(after).slice(1, -1))
  }
  return output
}

test("withoutNewProviders drops only the new providers' additions", () => {
  expect(withoutNewProviders("claude: Claude Code\n* work  a@b.dev\n\nmuse: Muse\nmuse: nothing logged in and no slots saved\n", ["usage"])).toBe(
    "claude: Claude Code\n* work  a@b.dev\n",
  )
  expect(withoutNewProviders("slots: /tmp/slots\n\nclaude: Claude Code\n  status:  a@b.dev\n\nmuse: Muse\n  /tmp/auth.json\n  status:  not logged in\n  slots:   0\n", ["doctor"])).toBe(
    "slots: /tmp/slots\n\nclaude: Claude Code\n  status:  a@b.dev\n",
  )
  expect(withoutNewProviders('  kyora-switch opencode load <slot>\n\n  kyora-switch muse save <slot>\n  kyora-switch muse load <slot>\n\n  kyora-switch status\n', ["--help"])).toBe(
    "  kyora-switch opencode load <slot>\n\n  kyora-switch status\n",
  )
  expect(withoutNewProviders('muse    not logged in: run `muse login`\nclaude   a@b.dev  (no slot)\n', ["status"])).toBe("claude   a@b.dev  (no slot)\n")
  expect(withoutNewProviders(JSON.stringify([{ provider: "claude" }, { provider: "muse" }], null, 2) + "\n", ["status", "--json"])).toBe(
    JSON.stringify([{ provider: "claude" }], null, 2) + "\n",
  )
  expect(withoutNewProviders(JSON.stringify({ claude: [1], muse: [] }, null, 2) + "\n", ["usage", "--json"])).toBe(JSON.stringify({ claude: [1] }, null, 2) + "\n")
  expect(withoutNewProviders("nothing about the new provider\n", ["status"])).toBe("nothing about the new provider\n")
  expect(withoutNewProviders("muse     a@b.dev · pro  (active)\nwork     c@d.dev · pro\n", ["claude", "list"])).toBe("muse     a@b.dev · pro  (active)\nwork     c@d.dev · pro\n")
  expect(withoutNewProviders('[{"name":"muse","provider":"claude"}]\n', ["claude", "list", "--json"])).toBe('[{"name":"muse","provider":"claude"}]\n')
  expect(withoutNewProviders("claude   a@b.dev  (no slot)\n\n", ["status"])).toBe("claude   a@b.dev  (no slot)\n\n")
  expect(withoutNewProviders("claude   a@b.dev  (no slot)\n\n\n", ["claude", "list"])).toBe("claude   a@b.dev  (no slot)\n\n\n")
  expect(withoutNewProviders("claude: Claude Code\n* work  a@b.dev\n\nmuse: Muse\nmuse: nothing\n\ngrok: Grok Build\ngrok: nothing logged in and no slots saved\n", ["usage"])).toBe(
    "claude: Claude Code\n* work  a@b.dev\n",
  )
  expect(withoutNewProviders("  kyora-switch muse load <slot>\n\n  kyora-switch grok save <slot>         and for Grok Build\n  kyora-switch grok load <slot>\n\n  kyora-switch status\n", ["--help"])).toBe("  kyora-switch status\n")
  expect(withoutNewProviders("grok     not logged in: run `grok login`\nclaude   a@b.dev  (no slot)\n", ["sync"])).toBe("claude   a@b.dev  (no slot)\n")
  expect(withoutNewProviders(JSON.stringify({ claude: [1], muse: [], grok: [] }, null, 2) + "\n", ["refresh", "--json"])).toBe(JSON.stringify({ claude: [1] }, null, 2) + "\n")
  expect(withoutNewProviders("grok     a@b.dev  (active)\n", ["claude", "list"])).toBe("grok     a@b.dev  (active)\n")
})

test("withoutDataCollection drops only the data collection status adds", () => {
  const row = "claude   a@b.dev  (no slot)\n"
  expect(withoutDataCollection(`${row}         data collection: telemetry on\n`, ["status"])).toBe(row)
  expect(withoutDataCollection(`${row}         data collection: telemetry on\n`, ["--private"])).toBe(row)
  expect(withoutDataCollection(`${row}         data collection: telemetry on\n`, ["claude", "list"])).toBe(`${row}         data collection: telemetry on\n`)
  expect(withoutDataCollection(`${JSON.stringify([{ provider: "claude", slot: null, dataCollection: { telemetry: "on" } }], null, 2)}\n`, ["status", "--json"])).toBe(`${JSON.stringify([{ provider: "claude", slot: null }], null, 2)}\n`)
})

test("approved copy changes preserve every other output byte", () => {
  for (const [before, after] of APPROVED_COPY_CHANGES) {
    expect(approvedCopy(`prefix\n${before}\nsuffix\n`)).toBe(`prefix\n${after}\nsuffix\n`)
    expect(approvedCopy(JSON.stringify({ note: before }))).toBe(JSON.stringify({ note: after }))
  }
  const other = 'unknown error: "cloud" is owned elsewhere\n'
  expect(approvedCopy(other)).toBe(other)
})

/**
 * Every file and directory under `dir`: its path, kind, permissions and bytes. Backup dirs, named by
 * the time they were made, are numbered in order instead, and slot.json's times are masked: both
 * runs take them from the clock. What only the new build writes (NEW_FILES) is left out.
 */
async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  const names = (await readdir(dir)).sort()
  const stamps = names.filter(name => STAMP.test(name))
  for (const name of names) {
    if (NEW_FILES.test(name)) continue
    const path = join(dir, name)
    const shown = `${prefix}${STAMP.test(name) ? `<backup ${stamps.indexOf(name)}>` : name}`
    const info = await lstat(path)
    const mode = (info.mode & 0o7777).toString(8)
    if (info.isSymbolicLink()) out.push(`${shown} -> ${await readlink(path)}`)
    else if (info.isDirectory()) out.push(`${shown}/ ${mode}`, ...await tree(path, `${shown}/`))
    else {
      let bytes = await readFile(path, "utf8")
      if (name === "slot.json") bytes = bytes.replace(TIMES, '$1"<time>"')
      out.push(`${shown} ${mode} ${bytes}`)
    }
  }
  return out
}

test("slot comparisons preserve indentation and final newlines while masking timestamp values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kyora-switch-diff-bytes-"))
  try {
    const path = join(dir, "slot.json")
    await writeFile(path, '{\n  "createdAt": 1,\n  "name": "work"\n}\n')
    const original = await tree(dir)
    await writeFile(path, '{\n  "createdAt": 2,\n  "name": "work"\n}\n')
    expect(await tree(dir)).toEqual(original)
    await writeFile(path, '{\n    "createdAt": 2,\n    "name": "work"\n}\n')
    expect(await tree(dir)).not.toEqual(original)
    await writeFile(path, '{\n  "createdAt": 2,\n  "name": "work"\n}')
    expect(await tree(dir)).not.toEqual(original)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

async function clockPreload(dir: string): Promise<string> {
  const path = join(dir, "clock.js")
  await writeFile(path, `const OriginalDate = Date
const now = Number(process.env.KYORA_SWITCH_DIFF_NOW)
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])) }
  static now() { return now }
}
`)
  return path
}

function fixtureCommand(entry: string, dir: string, args: string[], env: Record<string, string>, preload: string, now: number) {
  return Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--preload", preload, entry, ...args], {
    cwd: dir, env: { ...env, KYORA_SWITCH_DIFF_NOW: String(now) }, stdout: "pipe", stderr: "pipe",
  })
}

test("corresponding commands read the same fixture clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kyora-switch-diff-clock-"))
  try {
    const preload = await clockPreload(dir)
    const entry = join(dir, "probe.js")
    await writeFile(entry, "console.log(JSON.stringify([Date.now(), new Date().getTime(), new Date(123).getTime()]))")
    const now = Date.parse("2026-01-01T00:00:00Z")
    for (let run = 0; run < 2; run++) {
      const child = fixtureCommand(entry, dir, [], { HOME: dir }, preload, now)
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      expect(JSON.parse(output)).toEqual([now, now, 123])
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const jwt = (payload: Record<string, unknown>) => `fixture.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`
const FAR = Date.parse("2099-01-01T00:00:00Z")

test.skipIf(!base)(`existing commands print and write exactly what ${base} does${bundled ? " (bundled)" : ""}`, async () => {
  root = await mkdtemp(join(tmpdir(), "kyora-switch-diff-"))
  const preload = await clockPreload(root)
  const repo = (await Bun.$`git -C ${import.meta.dir} rev-parse --show-toplevel`.quiet().text()).trim()
  const old = join(root, "base")
  await mkdir(old)
  await Bun.$`git -C ${repo} archive --format=tar -o ${join(root, "base.tar")} ${base!} packages/switch/cli/src packages/shared/usage`.quiet()
  await Bun.$`tar -xf ${join(root, "base.tar")} -C ${old}`.quiet()
  await mkdir(join(old, "packages/switch/cli/node_modules/@kyora-sh"), { recursive: true })
  await symlink(join(old, "packages/shared/usage"), join(old, "packages/switch/cli/node_modules/@kyora-sh/usage"))
  const builds = { base: join(old, "packages/switch/cli/src/index.ts"), next: join(import.meta.dir, "index.ts") }
  if (bundled) {
    for (const build of ["base", "next"] as const) {
      const output = join(root, `${build}.js`)
      const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "build", builds[build], "--outfile", output, "--target", "bun", "--minify"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw new Error(`bundling ${build} failed: ${out}${err}`)
      builds[build] = output
    }
  }

  const bin = join(root, "bin")
  await mkdir(bin)
  for (const tool of ["pgrep", "security"]) {
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 1\n")
    await chmod(join(bin, tool), 0o755)
  }
  await writeFile(join(bin, "ps"), "#!/bin/sh\n")
  await chmod(join(bin, "ps"), 0o755)

  const start = Date.now()
  const session = new Date(start + (150 * 60 + 30) * 1000).toISOString()
  const weekly = new Date(start + (73 * 60 + 30) * 60 * 1000).toISOString()
  const server = Bun.serve({ port: 0, fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/claude-usage":
        return Response.json({ limits: [{ kind: "session", percent: 50, resets_at: session }, { kind: "weekly_all", percent: 32, resets_at: weekly }, { kind: "weekly_scoped", percent: 62, resets_at: weekly, scope: { model: { display_name: "Fable" } } }] })
      case "/codex-usage":
        return Response.json({ rate_limit: { primary_window: { used_percent: 74, limit_window_seconds: 604_800, reset_at: Math.floor(Date.parse(weekly) / 1000) } } })
      case "/opencode-usage":
        return Response.json({ usage: { rolling: { percent: 12, status: "ok", resetsAt: session }, weekly: { percent: 41, status: "ok", resetsAt: weekly }, monthly: { percent: 63, status: "ok", resetsAt: weekly } } })
      default:
        return Response.json({ error: "fixture" }, { status: 400 })
    }
  } })
  const url = (path: string) => `http://127.0.0.1:${server.port}/${path}`

  const run = join(root, "run")
  const template = join(root, "template")
  const env = (dir: string): Record<string, string> => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config"), XDG_DATA_HOME: join(dir, "xdg-data"), XDG_STATE_HOME: join(dir, "xdg-state"),
    CODEX_HOME: join(dir, "codex"), CLAUDE_CONFIG_DIR: join(dir, "claude"), KYORA_SWITCH_DIR: join(dir, "switch"),
    KYORA_REVIEW_STATE_DIR: join(dir, "review-state"), KYORA_SWITCH_NO_KEYCHAIN: "1", NODE_ENV: "test",
    // Bun's own transpiler cache would land in HOME: not kyora-switch's files
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    KYORA_CLAUDE_USAGE_URL: url("claude-usage"), KYORA_CODEX_USAGE_URL: url("codex-usage"), KYORA_OPENCODE_USAGE_URL: url("opencode-usage"),
    KYORA_CLAUDE_TOKEN_URL: url("claude-token"), KYORA_CODEX_TOKENS_URL: url("codex-tokens"),
  })
  const cli = async (entry: string, dir: string, args: string[], now = start) => {
    const vars = env(dir)
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KYORA_SWITCH_DIR"]) expect(vars[key]!.startsWith(`${root}/`)).toBe(true)
    expect(vars.KYORA_SWITCH_NO_KEYCHAIN).toBe("1")
    const child = fixtureCommand(entry, root, args, vars, preload, now)
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    // a backup's path names the time it was made, and --json shows a slot's times
    const masked = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<backup>").replace(/"(createdAt|updatedAt|capturedAt)": \d+/g, '"$1": "<time>"')
    return { args: args.join(" "), code, out: masked(out), err: masked(err), files: await tree(dir) }
  }

  try {
    // fixture slots, saved by the base build from fake live logins
    const vars = env(template)
    const claude = async (email: string, refresh: string) => {
      await mkdir(vars.CLAUDE_CONFIG_DIR!, { recursive: true })
      await writeFile(join(vars.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `fixture-${refresh}`, refreshToken: refresh, expiresAt: FAR, scopes: ["user:inference"] } }))
      await writeFile(join(vars.CLAUDE_CONFIG_DIR!, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "Acme", seatTier: "max" }, userID: "fixture-install" }))
    }
    const codex = async (email: string, account: string, refresh: string) => {
      await mkdir(vars.CODEX_HOME!, { recursive: true })
      const idToken = jwt({ email, "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: account } })
      await writeFile(join(vars.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { id_token: idToken, access_token: jwt({ exp: FAR / 1000 }), refresh_token: refresh, account_id: account } }))
    }
    const opencode = async (key: string) => {
      await mkdir(join(vars.XDG_DATA_HOME!, "opencode"), { recursive: true })
      await writeFile(join(vars.XDG_DATA_HOME!, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key }, openai: { type: "api", key: "fixture-openai" } }, null, 2))
    }
    const save = async (...args: string[]) => expect((await cli(builds.base, template, [...args])).code).toBe(0)
    await claude("alice@work.example", "fixture-claude-work"); await save("claude", "save", "work")
    await claude("cloud@work.example", "fixture-claude-cloud"); await save("claude", "save", "cloud")
    const cloudMeta = join(vars.KYORA_SWITCH_DIR!, "claude", "cloud", "slot.json")
    await writeFile(cloudMeta, JSON.stringify({ ...JSON.parse(await readFile(cloudMeta, "utf8")), cloudOwned: { at: 2, by: "kyora session creds sync", fingerprint: fingerprintOf("fixture-claude-cloud") } }))
    await claude("alice@home.example", "fixture-claude-home"); await save("claude", "save", "home")
    await codex("alice@home.example", "acct-b", "fixture-codex-home"); await save("codex", "save", "home")
    await codex("alice@work.example", "acct-a", "fixture-codex-work"); await save("codex", "save", "work")
    await opencode("fixture-go-key-aaaa"); await save("opencode", "save", "work")
    await opencode("fixture-go-key-bbbb"); await save("opencode", "save", "home")

    const commands = [
      ["--help"], ["help"], ["-h"], [],
      ["status"], ["status", "--json"], ["status", "--private"],
      ["claude"], ["claude", "list"], ["codex", "list", "--json"], ["opencode", "ls"],
      ["usage"], ["usage", "--json"], ["claude", "usage"], ["usage", "--private"], ["codex", "usage", "--json", "--private"],
      ["private"], ["doctor"], ["sync"], ["claude", "sync"],
      ["claude", "load", "work"], ["claude", "save", "copy"], ["status"], ["claude", "load", "cloud"], ["claude", "save", "cloud"],
      ["codex", "clear"], ["status"], ["codex", "clear"], ["codex", "load", "home"], ["codex", "save", "spare"], ["codex", "save", "home"], ["usage"],
      ["opencode", "load", "work"], ["opencode", "list"], ["opencode", "save", "mirror"], ["opencode", "clear"], ["opencode", "clear"], ["opencode", "save", "none"], ["opencode", "load", "mirror"],
      ["claude", "clear"], ["claude", "clear"], ["claude", "save", "signed-out"], ["claude", "load", "copy"],
      ["claude", "rename", "home", "personal"], ["claude", "rename", "cloud", "x"], ["claude", "list"], ["claude", "rm", "personal", "-y"], ["claude", "list", "--json"],
      ["private", "on"], ["status"], ["usage"], ["claude", "list", "--reveal"], ["private", "off"], ["status"],
      ["bogus"], ["claude", "bogus"], ["--bogus"], ["claude", "load"], ["claude", "load", "missing"], ["claude", "save", "bad/name"], ["status", "--private", "--reveal"],
    ]
    const outputs: Record<keyof typeof builds, Awaited<ReturnType<typeof cli>>[]> = { base: [], next: [] }
    for (const build of ["base", "next"] as const) {
      await rm(run, { recursive: true, force: true })
      await cp(template, run, { recursive: true })
      for (const [index, args] of commands.entries()) outputs[build].push(await cli(builds[build], run, args, start + index * 1000))
    }
    for (const [index, result] of outputs.next.entries()) {
      const previous = outputs.base[index]!
      const columns = sharedColumn(commands[index]!)
      expect({ ...result, out: columns(withoutNewProviders(withoutDataCollection(result.out, commands[index]!), commands[index]!)), err: withoutNewProviders(result.err, commands[index]!) }).toEqual({
        ...previous,
        out: columns(withoutNewProviders(withoutDataCollection(approvedCopy(previous.out), commands[index]!), commands[index]!)),
        err: withoutNewProviders(approvedCopy(previous.err), commands[index]!),
      })
    }
    // the fixture really exercised the commands: quota came back, slots listed, errors errored, saves and clears went through
    const ran = (args: string) => outputs.base.find(result => result.args === args)
    expect(ran("usage")?.out).toContain("weekly Fable 62% used")
    expect(ran("claude list")?.out).toContain("(kyora cloud)")
    expect(ran("bogus")?.code).toBe(2)
    for (const [args, says] of [["claude save copy", 'saved claude "copy"'], ["codex save spare", 'saved codex "spare"'], ["codex save home", 'saved codex "home"'], ["opencode save mirror", 'saved opencode "mirror"']]) {
      expect(ran(args!)).toMatchObject({ code: 0, out: expect.stringContaining(says!) })
    }
    for (const provider of ["claude", "codex", "opencode"]) expect(ran(`${provider} clear`)?.out).toContain(`${provider} signed out locally`)
    expect(ran("claude save signed-out")?.code).not.toBe(0)
    expect(ran("claude save cloud")?.code).not.toBe(0)
    // a backup of each login a clear or load replaced, numbered: the files compared are real ones
    expect(outputs.base.at(-1)!.files.some(line => line.startsWith("switch/backups/claude/<backup 0>/"))).toBe(true)
    // the new build wrote its history alongside, and nothing else
    expect(await Bun.file(join(run, "switch", "switch-history.jsonl")).exists()).toBe(true)
  } finally {
    server.stop(true)
  }
}, 240_000)
