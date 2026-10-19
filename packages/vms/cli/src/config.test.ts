import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_URL, loadConfig, VMD_DEFAULT_URL } from "./config"
import { readCredentials, removeLogin, saveLogin } from "./credentials"
import { tempDir, write } from "./testing/fixtures"

const VMD_KEY = "kvms_unit_0000000000000000000000000000000000"
const TOKEN = "kyora_unit_1111111111111111111111111111111111"
const STORED = "kyora_unit_2222222222222222222222222222222222"

let home: string
let cwd: string

beforeEach(async () => {
  home = await tempDir("config")
  cwd = join(home, "project")
  await mkdir(cwd)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const env = (extra: Record<string, string | undefined> = {}) => ({ HOME: home, ...extra })
const credentials = () => join(home, ".config", "kyora", "credentials.json")

/** the owner's setup: a kyora-vmd behind an SSH tunnel, its key in the env file */
const ownersEnvFile = () => write(home, ".config/kyora-vms/env", `KYORA_VMS_URL=http://127.0.0.1:7070\nKYORA_VMS_KEY=${VMD_KEY}\n`)

const login = (url: string, token = STORED) => saveLogin(credentials(), new URL(url).origin, { token, login: "octo", url })

describe("which server and which credential", () => {
  test("nothing configured is kyora cloud, not logged in", async () => {
    const config = await loadConfig(env(), cwd)
    expect(config).toMatchObject({ url: DEFAULT_URL, urlSource: "default", key: null, keySource: null })
  })

  test("a kvms_ key on its own still goes where it always went", async () => {
    expect((await loadConfig(env({ KYORA_VMS_KEY: VMD_KEY }), cwd)).url).toBe(VMD_DEFAULT_URL)
    await write(home, ".config/kyora-vms/env", `KYORA_VMS_KEY=${VMD_KEY}\n`)
    expect((await loadConfig(env(), cwd)).url).toBe(VMD_DEFAULT_URL)
    expect((await loadConfig(env({ KYORA_TOKEN: TOKEN }), cwd)).url).toBe(DEFAULT_URL)
  })

  test("the vmd env file keeps winning over a login, even one stored for its own URL", async () => {
    await ownersEnvFile()
    await login(DEFAULT_URL)
    await login("http://127.0.0.1:7070")
    const config = await loadConfig(env(), cwd)
    expect(config).toMatchObject({ url: "http://127.0.0.1:7070", key: VMD_KEY, keySource: join(home, ".config/kyora-vms/env") })
  })

  test("a login is used for its own origin only, when nothing else gives a key", async () => {
    await login(DEFAULT_URL)
    const cloud = await loadConfig(env(), cwd)
    expect(cloud).toMatchObject({ url: DEFAULT_URL, key: STORED, keySource: credentials() })
    // a path or trailing slash on the URL is still the same origin
    expect((await loadConfig(env({ KYORA_VMS_URL: `${DEFAULT_URL}/` }), cwd)).key).toBe(STORED)
    const elsewhere = await loadConfig(env({ KYORA_VMS_URL: "https://staging.kyora.sh" }), cwd)
    expect(elsewhere).toMatchObject({ key: null, keySource: null })
  })

  test("the shell beats the env file: KYORA_VMS_KEY, then KYORA_TOKEN", async () => {
    await ownersEnvFile()
    await login(DEFAULT_URL)
    const token = await loadConfig(env({ KYORA_TOKEN: TOKEN, KYORA_VMS_URL: DEFAULT_URL }), cwd)
    expect(token).toMatchObject({ url: DEFAULT_URL, urlSource: "$KYORA_VMS_URL", key: TOKEN, keySource: "$KYORA_TOKEN" })
    const both = await loadConfig(env({ KYORA_TOKEN: TOKEN, KYORA_VMS_KEY: "kvms_shell" }), cwd)
    expect(both).toMatchObject({ key: "kvms_shell", keySource: "$KYORA_VMS_KEY", url: "http://127.0.0.1:7070" })
  })

  test("KYORA_TOKEN works in the env file too", async () => {
    await write(home, ".config/kyora-vms/env", `KYORA_TOKEN=${TOKEN}\n`)
    expect(await loadConfig(env(), cwd)).toMatchObject({ url: DEFAULT_URL, key: TOKEN, keySource: join(home, ".config/kyora-vms/env") })
  })

  test("XDG_CONFIG_HOME moves both files", async () => {
    const xdg = join(home, "xdg")
    await saveLogin(join(xdg, "kyora", "credentials.json"), new URL(DEFAULT_URL).origin, { token: STORED, login: "octo", url: DEFAULT_URL })
    expect(await loadConfig(env({ XDG_CONFIG_HOME: xdg }), cwd)).toMatchObject({ key: STORED, keySource: join(xdg, "kyora", "credentials.json") })
  })

  test("a KYORA_TOKEN that the checkout's .env planted is refused", async () => {
    await write(cwd, ".env", `KYORA_TOKEN=${TOKEN}\n`)
    await expect(loadConfig(env({ KYORA_TOKEN: TOKEN }), cwd)).rejects.toThrow("refusing KYORA_TOKEN from")
  })
})

describe("credentials.json", () => {
  test("is written 0600 in a 0700 directory, keyed by origin, and keeps what it does not know", async () => {
    await write(home, ".config/kyora/credentials.json", JSON.stringify({ "https://other.example": { note: "not a login" } }))
    await chmod(join(home, ".config/kyora"), 0o755)
    await login(DEFAULT_URL)
    await login("http://127.0.0.1:8787", TOKEN)

    expect((await stat(credentials())).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, ".config/kyora"))).mode & 0o777).toBe(0o700)
    const raw = JSON.parse(await Bun.file(credentials()).text())
    expect(Object.keys(raw).sort()).toEqual(["http://127.0.0.1:8787", "https://cloud.kyora.sh", "https://other.example"])
    expect(raw["https://cloud.kyora.sh"]).toEqual({ token: STORED, login: "octo", url: DEFAULT_URL })
    expect(Object.keys(await readCredentials(credentials())).sort()).toEqual(["http://127.0.0.1:8787", "https://cloud.kyora.sh"])
  })

  test("removing the last login removes the file; removing a missing one says so", async () => {
    await login(DEFAULT_URL)
    expect(await removeLogin(credentials(), "https://staging.kyora.sh")).toBe(false)
    expect(await removeLogin(credentials(), new URL(DEFAULT_URL).origin)).toBe(true)
    expect(await Bun.file(credentials()).exists()).toBe(false)
  })

  test("a damaged file counts as no logins rather than failing every command", async () => {
    await write(home, ".config/kyora/credentials.json", "{ not json")
    expect(await readCredentials(credentials())).toEqual({})
    expect((await loadConfig(env(), cwd)).key).toBeNull()
  })
})
