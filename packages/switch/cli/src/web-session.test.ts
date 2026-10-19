import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rootDir } from "./store"
import {
  cookieHeader,
  deleteWebSession,
  findBrowser,
  keepCookies,
  moveWebSession,
  assertHttpsOrigin,
  NO_BROWSER,
  readWebSession,
  webHeaders,
  sessionLive,
  sweepProfiles,
  webLogin,
  webSessionPath,
  writeWebSession,
  type KeychainStore,
  type WebSessionConfig,
} from "./web-session"
import { KeychainTooLarge } from "./keychain"

let dir: string
const previousRoot = process.env.KYORA_SWITCH_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyora-switch-webtest-"))
  process.env.KYORA_SWITCH_DIR = join(dir, "slots")
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.KYORA_SWITCH_DIR
  else process.env.KYORA_SWITCH_DIR = previousRoot
  delete process.env.KYORA_TEST_SITE_URL
  await rm(dir, { recursive: true, force: true })
})

const FAR = Math.floor(Date.now() / 1000) + 86_400
const SITE: WebSessionConfig = {
  origin: "https://dev.example.test",
  originEnv: "KYORA_TEST_SITE_URL",
  cookieDomains: ["dev.example.test", "example.test"],
  sessionCookies: ["site_sess"],
  probe: { path: "/api/auth/me" },
}

const session = { name: "site_sess", value: "fake-session-value", domain: "dev.example.test", path: "/", expires: FAR, session: false, secure: true, httpOnly: true }

test("only the configured domains' cookies that reach the origin are kept, in the stored shape", () => {
  const kept = keepCookies(SITE, [
    session,
    { name: "wide", value: "w", domain: ".example.test", path: "/", expires: -1, session: true },
    { name: "apex_only", value: "a", domain: "example.test", path: "/" },
    { name: "billing", value: "b", domain: "billing.dev.example.test", path: "/" },
    { name: "other", value: "o", domain: ".facebook.test", path: "/" },
    { name: 7, value: "x", domain: "dev.example.test" },
  ])
  expect(kept).toEqual([
    { name: "site_sess", value: "fake-session-value", domain: "dev.example.test", path: "/", expires: FAR, secure: true },
    { name: "wide", value: "w", domain: ".example.test", path: "/" },
  ])
})

test("a cookie allowlist keeps only the named cookies, and the origin must be https", async () => {
  const cookies = [session, { name: "wide", value: "w", domain: ".example.test", path: "/" }, { name: "tracker", value: "t", domain: ".example.test", path: "/" }]
  expect(keepCookies({ ...SITE, cookieNames: ["site_sess", "wide"] }, cookies).map((cookie) => cookie.name)).toEqual(["site_sess", "wide"])
  expect(() => assertHttpsOrigin({ ...SITE, origin: "http://dev.example.test" })).toThrow("is not https")
  expect(() => webHeaders({ ...SITE, origin: "http://127.0.0.1:1" }, { cookies: [], savedAt: 0 }, "/")).toThrow("is not https")
  await expect(webLogin({ ...SITE, origin: "http://dev.example.test" }, { browser: "/nonexistent" })).rejects.toThrow("is not https")
})

test("the Cookie header follows domain, path, expiry and the secure flag", () => {
  const cookies = [
    { name: "a", value: "1", domain: ".example.test", path: "/" },
    { name: "b", value: "2", domain: "dev.example.test", path: "/api/portal" },
    { name: "c", value: "3", domain: "dev.example.test", path: "/", expires: Math.floor(Date.now() / 1000) - 1 },
    { name: "d", value: "4", domain: "dev.example.test", path: "/", secure: true },
    { name: "e", value: "5", domain: "other.test", path: "/" },
  ]
  expect(cookieHeader(cookies, new URL("https://dev.example.test/api/portal/teams"))).toBe("a=1; b=2; d=4")
  expect(cookieHeader(cookies, new URL("https://dev.example.test/api/portalx"))).toBe("a=1; d=4")
  expect(cookieHeader(cookies, new URL("http://dev.example.test/"))).toBe("a=1")
  expect(sessionLive(SITE, { cookies: [{ ...session }], savedAt: 0 })).toBe(true)
  expect(sessionLive(SITE, { cookies: [{ ...session, expires: 1 }], savedAt: 0 })).toBe(false)
  expect(sessionLive(SITE, { cookies: [{ ...cookies[0]! }], savedAt: 0 })).toBe(false)
  expect(sessionLive(SITE, { cookies: [{ ...session, path: "/elsewhere" }], savedAt: 0 })).toBe(false)
  expect(sessionLive(SITE, { cookies: [{ ...session, path: "/api/portal/teams" }], savedAt: 0 }, "/api/portal/teams/1/subscription-quota")).toBe(true)
})

test("a stored session is a 0600 file outside the slot directory, moved by a rename and gone after a delete", async () => {
  const stored = { cookies: keepCookies(SITE, [session]), userAgent: "FakeChrome/1.0", savedAt: 1 }
  expect(await readWebSession("muse", "work")).toBeNull()
  expect(await writeWebSession("muse", "work", stored)).toBe(join(rootDir(), "web-sessions", "muse", "work.json"))
  expect(webSessionPath("muse", "work")).toBe(join(rootDir(), "web-sessions", "muse", "work.json"))
  expect((await stat(webSessionPath("muse", "work"))).mode & 0o777).toBe(0o600)
  expect((await stat(join(rootDir(), "web-sessions"))).mode & 0o777).toBe(0o700)
  expect(await readWebSession("muse", "work")).toEqual(stored)
  expect(await readWebSession("grok", "work")).toBeNull()

  await writeWebSession("muse", "stale", stored)
  await moveWebSession("muse", "work", "job")
  expect(await readWebSession("muse", "work")).toBeNull()
  expect(await readWebSession("muse", "job")).toEqual(stored)
  await moveWebSession("muse", "gone", "stale")
  expect(await readWebSession("muse", "stale")).toBeNull()

  expect(await deleteWebSession("muse", "job")).toBe(true)
  expect(await deleteWebSession("muse", "job")).toBe(false)
  expect(() => webSessionPath("muse", "../x")).toThrow("invalid slot name")
})

test("findBrowser prefers Chrome or Chromium, then Playwright's newest Chromium, then Edge or Brave, and never Firefox", async () => {
  const home = join(dir, "home")
  const apps = join(dir, "Applications")
  const touch = async (path: string) => {
    await mkdir(join(path, ".."), { recursive: true })
    await Bun.write(path, "")
    await chmod(path, 0o755)
  }
  const mac = () => findBrowser({}, "darwin", home, [apps])
  await touch(join(apps, "Firefox.app/Contents/MacOS/firefox"))
  expect(mac()).toBeUndefined()
  await touch(join(apps, "Brave Browser.app/Contents/MacOS/Brave Browser"))
  expect(mac()).toBe(join(apps, "Brave Browser.app/Contents/MacOS/Brave Browser"))
  const playwright = join(home, "Library/Caches/ms-playwright")
  await mkdir(join(playwright, "chromium_headless_shell-1300/chrome-mac-arm64"), { recursive: true })
  await touch(join(playwright, "chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
  await touch(join(playwright, "chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
  expect(mac()).toBe(join(playwright, "chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
  await touch(join(apps, "Chromium.app/Contents/MacOS/Chromium"))
  expect(mac()).toBe(join(apps, "Chromium.app/Contents/MacOS/Chromium"))
  await touch(join(apps, "Google Chrome.app/Contents/MacOS/Google Chrome"))
  expect(mac()).toBe(join(apps, "Google Chrome.app/Contents/MacOS/Google Chrome"))

  const bin = join(dir, "bin")
  expect(findBrowser({ PATH: bin }, "linux", home)).toBeUndefined()
  await touch(join(home, ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome"))
  expect(findBrowser({ PATH: bin }, "linux", home)).toBe(join(home, ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome"))
  await touch(join(bin, "chromium"))
  expect(findBrowser({ PATH: bin }, "linux", home)).toBe(join(bin, "chromium"))
  expect(findBrowser({ PATH: bin, KYORA_SWITCH_BROWSER: join(bin, "missing") }, "linux", home)).toBeUndefined()
  expect(findBrowser({ PATH: bin, KYORA_SWITCH_BROWSER: join(bin, "chromium") }, "darwin", home, [apps])).toBe(join(bin, "chromium"))
  expect(findBrowser({ KYORA_SWITCH_BROWSER: join(apps, "Firefox.app/Contents/MacOS/firefox") }, "darwin", home, [apps])).toBeUndefined()
  expect(findBrowser({ KYORA_SWITCH_BROWSER: bin }, "linux", home)).toBeUndefined()
  await symlink(join(apps, "Firefox.app/Contents/MacOS/firefox"), join(bin, "chrome"))
  expect(findBrowser({ KYORA_SWITCH_BROWSER: join(bin, "chrome") }, "linux", home)).toBeUndefined()
  expect(NO_BROWSER).toContain("Firefox")
})

/** a launcher script for the fake browser, so the test needs no executable bit in git */
async function fakeBrowser(env: Record<string, string>): Promise<{ path: string; log: () => Promise<Record<string, unknown>[]> }> {
  const logPath = join(dir, "browser.log")
  const path = join(dir, "fake-chrome")
  const exports = Object.entries({ ...env, FAKE_BROWSER_LOG: logPath }).map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'`)
  await Bun.write(path, `#!/bin/sh\n${exports.join("\n")}\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures", "fake-browser.ts")}' "$@"\n`)
  await chmod(path, 0o755)
  return {
    path,
    log: async () => (await Bun.file(logPath).text()).trim().split("\n").map((line) => JSON.parse(line)),
  }
}

function site() {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const cookie = request.headers.get("cookie") ?? ""
      seen.push(`${new URL(request.url).pathname} ${cookie} ${request.headers.get("user-agent")}`)
      return cookie.includes("site_sess=fake-session-value") ? Response.json({ id: "fixture" }) : Response.json({ error: "login" }, { status: 401 })
    },
  })
  process.env.KYORA_TEST_SITE_URL = server.url.href
  return { seen, [Symbol.dispose]: () => server.stop(true) }
}

const profileOf = (argv: string[]) => argv.find((arg) => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length)

test("web-login opens a headful browser on a throwaway profile, waits for the login, keeps the session cookies and cleans up", async () => {
  using server = site()
  const browser = await fakeBrowser({ FAKE_BROWSER_COOKIES: JSON.stringify([session, { name: "x", value: "y", domain: ".other.test", path: "/" }]), FAKE_BROWSER_LOGIN_AFTER: "2" })
  const messages: string[] = []
  const result = await webLogin(SITE, { browser: browser.path, pollMs: 20, timeoutMs: 20_000, log: (message) => messages.push(message) })

  expect(result.cookies).toEqual([{ name: "site_sess", value: "fake-session-value", domain: "dev.example.test", path: "/", expires: FAR, secure: true }])
  expect(result.userAgent).toBe("FakeChrome/1.0 (fixture)")
  expect(server.seen).toEqual(["/api/auth/me site_sess=fake-session-value FakeChrome/1.0 (fixture)"])
  expect(messages.join("\n")).not.toContain("fake-session-value")

  const log = await browser.log()
  const argv = log[0]!.argv as string[]
  const profile = profileOf(argv)
  expect(profile.startsWith(join(tmpdir(), "kyora-switch-web-"))).toBe(true)
  expect(argv).toContain("--remote-debugging-pipe")
  expect(argv.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false)
  expect(argv.at(-1)).toBe("https://dev.example.test/")
  expect(argv.some((arg) => arg.includes("headless"))).toBe(false)
  expect(existsSync(profile)).toBe(false)
  expect(log.map((entry) => entry.method).filter(Boolean)).toEqual(["Browser.getVersion", "Storage.getCookies", "Storage.getCookies", "Storage.getCookies", "Browser.close"])
})

test("a browser closed before the login, and a login that never comes, end with nothing kept and the profile deleted", async () => {
  using server = site()
  const closed = await fakeBrowser({ FAKE_BROWSER_QUIT_AFTER: "2" })
  await expect(webLogin(SITE, { browser: closed.path, pollMs: 20, timeoutMs: 20_000 })).rejects.toThrow("the browser was closed before the login finished")
  expect(existsSync(profileOf((await closed.log())[0]!.argv as string[]))).toBe(false)

  await rm(join(dir, "browser.log"))
  const never = await fakeBrowser({ FAKE_BROWSER_COOKIES: JSON.stringify([{ ...session, value: "not-accepted" }]) })
  await expect(webLogin(SITE, { browser: never.path, pollMs: 20, timeoutMs: 1500 })).rejects.toThrow("no login within")
  const log = await never.log()
  expect(log.at(-1)).toEqual({ method: "Browser.close" })
  expect(existsSync(profileOf(log[0]!.argv as string[]))).toBe(false)
  expect(server.seen).toHaveLength(1)
})

test("a browser that exits at once fails fast", async () => {
  const path = join(dir, "not-chrome")
  await Bun.write(path, "#!/bin/sh\nexit 0\n")
  await chmod(path, 0o755)
  await expect(webLogin(SITE, { browser: path, timeoutMs: 5000 })).rejects.toThrow("the browser was closed before the login finished")
})

/** the keychain as `security -i` behaves: anything past a length is refused as too large */
function fakeKeychain(limit: number): KeychainStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    supported: true,
    read: async (service) => items.get(service) ?? null,
    write: async (service, text) => {
      if (text.length > limit) throw new KeychainTooLarge("too large")
      items.set(service, text)
    },
    delete: async (service) => void items.delete(service),
  }
}

test("on macOS a session goes into the keychain, and one too long for its stdin into the 0600 file instead, never both", async () => {
  const keychain = fakeKeychain(600)
  const small = { cookies: keepCookies(SITE, [session]), savedAt: 1 }
  const large = { cookies: keepCookies(SITE, [{ ...session, value: "v".repeat(800) }]), savedAt: 2 }

  expect(await writeWebSession("muse", "work", small, keychain)).toBe("macOS keychain: kyora-switch.muse-web.work")
  expect([...keychain.items.keys()]).toEqual(["kyora-switch.muse-web.work"])
  expect(existsSync(webSessionPath("muse", "work"))).toBe(false)
  expect(await readWebSession("muse", "work", keychain)).toEqual(small)

  expect(await writeWebSession("muse", "work", large, keychain)).toBe(webSessionPath("muse", "work"))
  expect(keychain.items.size).toBe(0)
  expect((await stat(webSessionPath("muse", "work"))).mode & 0o777).toBe(0o600)
  expect(await readWebSession("muse", "work", keychain)).toEqual(large)

  await writeWebSession("muse", "home", small, keychain)
  await moveWebSession("muse", "home", "job", keychain)
  await moveWebSession("muse", "work", "spare", keychain)
  expect([...keychain.items.keys()]).toEqual(["kyora-switch.muse-web.job"])
  expect(await readWebSession("muse", "spare", keychain)).toEqual(large)
  expect(await readWebSession("muse", "work", keychain)).toBeNull()

  expect(await deleteWebSession("muse", "job", keychain)).toBe(true)
  expect(await deleteWebSession("muse", "spare", keychain)).toBe(true)
  expect(keychain.items.size).toBe(0)
  expect(existsSync(webSessionPath("muse", "spare"))).toBe(false)
})

test("Ctrl+C, SIGTERM or SIGHUP during the login stops the browser and deletes the profile, saving nothing", async () => {
  using _server = site()
  const listeners = () => ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal))
  const baseline = listeners()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    await rm(join(dir, "browser.log"), { force: true })
    const browser = await fakeBrowser({})
    const login = webLogin(SITE, { browser: browser.path, pollMs: 20, timeoutMs: 20_000 })
    while (!(await Bun.file(join(dir, "browser.log")).exists()) || !(await Bun.file(join(dir, "browser.log")).text()).includes("Storage.getCookies")) await Bun.sleep(20)
    process.emit(signal)
    await expect(login).rejects.toThrow("interrupted; nothing saved")
    const log = await browser.log()
    expect(log.at(-1)).toEqual({ method: "Browser.close" })
    expect(existsSync(profileOf(log[0]!.argv as string[]))).toBe(false)
    expect(listeners()).toEqual(baseline)
  }
}, 30_000)

test("stale throwaway profiles of a web-login whose kyora-switch died are swept, live ones and others kept", async () => {
  const root = join(dir, "tmp")
  const make = async (name: string, owner?: number) => {
    await mkdir(join(root, name, "Default"), { recursive: true })
    if (owner !== undefined) await Bun.write(join(root, name, "kyora-switch.pid"), `${owner}\n`)
  }
  const dead = Bun.spawn(["true"])
  await dead.exited
  await make("kyora-switch-web-dead", dead.pid)
  await make("kyora-switch-web-live", process.pid)
  await make("kyora-switch-web-fresh")
  await make("kyora-switch-other", dead.pid)
  await sweepProfiles(root)
  expect(existsSync(join(root, "kyora-switch-web-dead"))).toBe(false)
  for (const name of ["kyora-switch-web-live", "kyora-switch-web-fresh", "kyora-switch-other"]) expect(existsSync(join(root, name))).toBe(true)
})

test("a browser that answers nothing and ignores SIGTERM is killed, and its profile still deleted", async () => {
  const browser = await fakeBrowser({ FAKE_BROWSER_STUBBORN: "1" })
  await expect(webLogin(SITE, { browser: browser.path, pollMs: 20, timeoutMs: 20_000, graceMs: 300 })).rejects.toThrow("the browser did not answer Browser.getVersion")
  const log = await browser.log()
  expect(log.some((entry) => entry.ignored === "SIGTERM")).toBe(true)
  expect(() => process.kill(log[0]!.pid as number, 0)).toThrow()
  expect(existsSync(profileOf(log[0]!.argv as string[]))).toBe(false)
})
