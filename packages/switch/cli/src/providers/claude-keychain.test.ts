import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
let env: Record<string, string | undefined>
const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: token, expiresAt: 1 } })
const disk = () => join(dir, "claude", ".credentials.json")
const keychain = () => join(dir, "keychain.json")
const slot = (name: string) => join(dir, "switch", "claude", name, "credentials.json")

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-keychain-"))
  await mkdir(join(dir, "claude"))
  await Bun.write(join(dir, "platform.ts"), 'Object.defineProperty(process, "platform", { value: "darwin" })')
  await Bun.write(join(dir, "security"), `#!${process.execPath}
const args = process.argv.slice(2)
const file = Bun.file(process.env.FAKE_KEYCHAIN)
if (args[0] === "find-generic-password") {
  if (process.env.FAKE_READ_FAILURE) process.exit(36)
  if (!await file.exists()) process.exit(44)
  process.stdout.write(await file.text())
} else if (args[0] === "-i" || args[0] === "add-generic-password") {
  if (process.env.FAKE_WRITE_FAILURE) process.exit(0)
  const input = args[0] === "-i" ? await Bun.stdin.text() : ""
  if (input && process.env.FAKE_STDIN_FAILURE) process.exit(0)
  const hex = input ? input.match(/-X ([0-9a-f]+)/)[1] : args[args.indexOf("-X") + 1]
  await Bun.write(file, Buffer.from(hex, "hex"))
} else process.exit(1)
`)
  await chmod(join(dir, "security"), 0o700)
  env = {
    ...process.env,
    PATH: dir,
    NODE_ENV: "production",
    KYORA_SWITCH_NO_KEYCHAIN: "0",
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    KYORA_SWITCH_DIR: join(dir, "switch"),
    FAKE_KEYCHAIN: keychain(),
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function cli(...args: string[]) {
  const proc = Bun.spawn([
    process.execPath, "--no-env-file", "--config=/dev/null", "--preload", join(dir, "platform.ts"),
    join(import.meta.dir, "../index.ts"), "claude", ...args,
  ], { env, cwd: dir, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, output: stdout + stderr }
}

/** a `pgrep` that finds Claude Code running (it renews its own live login then), or finds none; a `ps` that finds no node */
async function claude(running: boolean): Promise<void> {
  await Bun.write(join(dir, "pgrep"), running ? "#!/bin/sh\necho 4242\n" : "#!/bin/sh\nexit 1\n")
  await Bun.write(join(dir, "ps"), "#!/bin/sh\n")
  await chmod(join(dir, "pgrep"), 0o700)
  await chmod(join(dir, "ps"), 0o700)
}

/** a token endpoint that renews every refresh token it is sent, and a usage endpoint */
function tokenServer(refreshed: string[]) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return Response.json({ five_hour: { utilization: 10 } })
      const body = await request.json() as { refresh_token: string }
      refreshed.push(body.refresh_token)
      return Response.json({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 })
    },
  })
  env.KYORA_CLAUDE_TOKEN_URL = server.url.href
  env.KYORA_CLAUDE_USAGE_URL = server.url.href
  return server
}

async function seed(token: string) {
  await Bun.write(keychain(), credentials(token))
  await Bun.write(disk(), credentials("stale-file"))
  await Bun.write(join(dir, "claude", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `${token}@example.test` } }))
}

test("save and sync use keychain rotations even when the credentials file is stale", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  expect(await Bun.file(slot("work")).text()).toBe(credentials("work"))
  await Bun.write(keychain(), credentials("rotated"))
  expect((await cli("sync")).code).toBe(0)
  expect(await Bun.file(slot("work")).text()).toBe(credentials("rotated"))
})

test("load updates both stores and protects the credentials file", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  await seed("home")
  await chmod(disk(), 0o644)
  expect((await cli("load", "work")).code).toBe(0)
  expect(await Bun.file(keychain()).text()).toBe(credentials("work"))
  expect(await Bun.file(disk()).text()).toBe(credentials("work"))
  expect((await stat(disk())).mode & 0o777).toBe(0o600)
})

test("loading the active slot keeps the token Claude rotated into the keychain", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  await Bun.write(keychain(), credentials("rotated"))
  expect((await cli("load", "work")).code).toBe(0)
  expect(await Bun.file(keychain()).text()).toBe(credentials("rotated"))
  expect(await Bun.file(disk()).text()).toBe(credentials("rotated"))
  expect(await Bun.file(slot("work")).text()).toBe(credentials("rotated"))
})

test("save falls back to the file when the keychain item is absent", async () => {
  await seed("work")
  await rm(keychain())
  expect((await cli("save", "work")).code).toBe(0)
  expect(await Bun.file(slot("work")).text()).toBe(credentials("stale-file"))
})

test("load accepts a file-backed slot with trailing JSON whitespace", async () => {
  await seed("work")
  await rm(keychain())
  const value = `${credentials("work")}\n`
  await Bun.write(disk(), value)
  expect((await cli("save", "work")).code).toBe(0)
  expect((await cli("load", "work")).code).toBe(0)
  expect(await Bun.file(keychain()).text()).toBe(value)
  expect(await Bun.file(disk()).text()).toBe(value)
})

test("a locked keychain does not sync stale file credentials into a slot", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  env.FAKE_READ_FAILURE = "1"
  const result = await cli("sync")
  expect(result.code).not.toBe(0)
  expect(result.output).toContain("keychain read failed")
  expect(await Bun.file(slot("work")).text()).toBe(credentials("work"))
})

test("load retries a silent interactive keychain failure through argv", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  await seed("home")
  env.FAKE_STDIN_FAILURE = "1"
  expect((await cli("load", "work")).code).toBe(0)
  expect(await Bun.file(keychain()).text()).toBe(credentials("work"))
  expect(await Bun.file(disk()).text()).toBe(credentials("work"))
})

test("credentials too long for `security -i` load through argv", async () => {
  await seed("work")
  const long = JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(2800), refreshToken: "work", expiresAt: 1 } })
  await Bun.write(keychain(), long)
  expect((await cli("save", "work")).code).toBe(0)
  await seed("home")
  expect((await cli("load", "work")).code).toBe(0)
  expect(await Bun.file(keychain()).text()).toBe(long)
  expect(await Bun.file(disk()).text()).toBe(long)
})

test("load reports an unverified keychain write and leaves the file and account alone", async () => {
  await seed("work")
  expect((await cli("save", "work")).code).toBe(0)
  await seed("home")
  env.FAKE_WRITE_FAILURE = "1"
  const result = await cli("load", "work")
  expect(result.code).not.toBe(0)
  expect(result.output).toContain("keychain write verification failed")
  expect(await Bun.file(disk()).text()).toBe(credentials("stale-file"))
  expect(await Bun.file(join(dir, "claude", ".claude.json")).json()).toEqual({ oauthAccount: { emailAddress: "home@example.test" } })
  // the switch that never happened ends on the login still live, which is in no slot
  const lines = async (file: string) => (await Bun.file(join(dir, "switch", file)).text()).trim().split("\n").map((line) => JSON.parse(line))
  const gap = (await lines("switch-history.gaps.jsonl")).at(-1)
  const ended = (await lines("switch-history.jsonl")).at(-1)
  expect(ended.slot).toBeNull()
  expect(ended.at).toBeGreaterThanOrEqual(gap.at)
})

test("refresh renews an inactive slot and load writes its rotated token to both stores", async () => {
  const refreshed: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const body = await request.json() as { refresh_token: string }
        refreshed.push(body.refresh_token)
        return Response.json({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 })
      }
      return Response.json({ five_hour: { utilization: 10 } })
    },
  })
  try {
    env.KYORA_CLAUDE_TOKEN_URL = server.url.href
    env.KYORA_CLAUDE_USAGE_URL = server.url.href
    await seed("work")
    expect((await cli("save", "work")).code).toBe(0)
    await seed("home")
    expect((await cli("save", "home")).code).toBe(0)
    await claude(true)
    expect((await cli("refresh")).code).toBe(0)
    expect(refreshed).toEqual(["work"])
    const renewed = await Bun.file(slot("work")).text()
    expect(JSON.parse(renewed).claudeAiOauth.refreshToken).toBe("renewed-refresh")
    expect(await Bun.file(keychain()).text()).toBe(credentials("home"))
    expect((await cli("load", "work")).code).toBe(0)
    expect(await Bun.file(keychain()).text()).toBe(renewed)
    expect(await Bun.file(disk()).text()).toBe(renewed)
  } finally {
    server.stop(true)
  }
})

test("refresh renews an idle Claude Code's expired live login into the keychain and the file", async () => {
  const refreshed: string[] = []
  const server = tokenServer(refreshed)
  try {
    await claude(false)
    await seed("home")
    expect((await cli("save", "home")).code).toBe(0)
    const result = await cli("refresh")
    expect(result.code).toBe(0)
    expect(result.output).toContain('claude "home": renewed the live login')
    expect(refreshed).toEqual(["home"])
    const renewed = await Bun.file(keychain()).text()
    expect(JSON.parse(renewed).claudeAiOauth.refreshToken).toBe("renewed-refresh")
    expect(await Bun.file(disk()).text()).toBe(renewed)
    expect(await Bun.file(slot("home")).text()).toBe(renewed)
  } finally {
    server.stop(true)
  }
})

test.skipIf(process.getuid?.() === 0)("a live renewal written to the keychain but not the file says which store holds what", async () => {
  const refreshed: string[] = []
  using _server = tokenServer(refreshed)
  await claude(false)
  await seed("home")
  expect((await cli("save", "home")).code).toBe(0)
  await chmod(join(dir, "claude"), 0o500)
  try {
    const result = await cli("refresh")
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(`the keychain holds the renewal, which Claude Code reads first, but ${disk()} could not be written (`)
    expect(result.output).toContain(") and still holds the spent token. The renewal is in ")
    expect(result.output).not.toContain("renewed-refresh")
  } finally {
    await chmod(join(dir, "claude"), 0o700)
  }
  expect(JSON.parse(await Bun.file(keychain()).text()).claudeAiOauth.refreshToken).toBe("renewed-refresh")
  expect(await Bun.file(disk()).text()).toBe(credentials("stale-file"))
})

test("a live renewal the keychain did not take says both stores still hold the spent token", async () => {
  const refreshed: string[] = []
  using _server = tokenServer(refreshed)
  await claude(false)
  await seed("home")
  expect((await cli("save", "home")).code).toBe(0)
  env.FAKE_WRITE_FAILURE = "1"
  const result = await cli("refresh")
  expect(result.code).not.toBe(0)
  expect(result.output).toContain(`the keychain could not be written (keychain write verification failed); it and ${disk()} still hold the spent token`)
  expect(await Bun.file(keychain()).text()).toBe(credentials("home"))
  expect(await Bun.file(disk()).text()).toBe(credentials("stale-file"))
})

test.skipIf(process.getuid?.() === 0)("a slot a live renewal could not be written into is reported on its row, every provider is still shown, and the run fails", async () => {
  const refreshed: string[] = []
  using _server = tokenServer(refreshed)
  await claude(false)
  await seed("home")
  expect((await cli("save", "home")).code).toBe(0)
  await mkdir(join(dir, "switch", "claude", "copy"))
  for (const file of ["credentials.json", "account.json", "slot.json"]) {
    await Bun.write(join(dir, "switch", "claude", "copy", file), await Bun.file(join(dir, "switch", "claude", "home", file)).text())
  }
  await Bun.write(join(dir, "switch", "claude", "copy", "slot.json"), JSON.stringify({ ...(await Bun.file(join(dir, "switch", "claude", "home", "slot.json")).json()), name: "copy" }))
  await chmod(join(dir, "switch", "claude", "copy"), 0o500)
  try {
    const proc = Bun.spawn([
      process.execPath, "--no-env-file", "--config=/dev/null", "--preload", join(dir, "platform.ts"),
      join(import.meta.dir, "../index.ts"), "usage", "--refresh",
    ], { env, cwd: dir, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(code).toBe(1)
    expect(stderr).toContain('claude "home": renewed the live login')
    expect(stdout).toMatch(/renewed the live login; "copy" could not be written \(.+\) and still holds a spent token: `kyora-switch claude save <slot>` writes the live login in/)
    expect(stdout).toContain("codex: nothing logged in and no slots saved")
    expect(stdout).not.toContain("unreadable")
  } finally {
    await chmod(join(dir, "switch", "claude", "copy"), 0o700)
  }
  expect(refreshed).toEqual(["home"])
  expect(JSON.parse(await Bun.file(slot("home")).text()).claudeAiOauth.refreshToken).toBe("renewed-refresh")
})
