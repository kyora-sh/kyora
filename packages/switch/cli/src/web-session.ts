import { vendorUrl } from "@kyora-sh/usage"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { readTextIfExists, writeFileAtomic } from "./fsx"
import { KeychainTooLarge, keychainDelete, keychainRead, keychainSupported, keychainWrite } from "./keychain"
import { assertName, rootDir } from "./store"
import type { ProviderId } from "./types"

/**
 * A site whose browser session a provider can use where its CLI login is not accepted. Any
 * provider plugs in with config alone: `kyora-switch <provider> web-login <slot>` opens
 * `origin` in a throwaway browser profile, waits until `probe` answers with the cookies the
 * browser holds for `cookieDomains`, and keeps those cookies for that slot.
 */
export interface WebSessionConfig {
  /** the site, https only, e.g. https://dev.meta.ai; cookies are matched against it */
  origin: string
  /** the page the browser opens, relative to origin (default "/") */
  startPath?: string
  /** a loopback-only override of origin for requests (tests), read with vendorUrl */
  originEnv?: string
  /** the cookie domains kept, exactly (a leading dot is ignored); every other cookie is dropped */
  cookieDomains: string[]
  /** the cookie names kept, when set: the ones the site's own requests carry */
  cookieNames?: string[]
  /** cookies that must be present and unexpired before the probe runs, and for a stored session to count */
  sessionCookies?: string[]
  /** a request that succeeds only for a logged-in session: a 2xx, and `field` truthy in its JSON when set */
  probe: { path: string; field?: string }
}

export interface WebCookie {
  name: string
  value: string
  domain: string
  path: string
  /** epoch seconds; absent for a session cookie */
  expires?: number
  secure?: boolean
}

export interface WebSession {
  cookies: WebCookie[]
  /** the browser's user agent, sent along so requests look like the browser that logged in */
  userAgent?: string
  savedAt: number
}

/** a session's cookies only ever go to an https origin; a test reaches a loopback server through originEnv alone */
export function assertHttpsOrigin(config: WebSessionConfig): void {
  if (new URL(config.origin).protocol !== "https:") throw new Error(`web session origin ${config.origin} is not https`)
}

const bareDomain = (domain: string) => domain.replace(/^\./, "").toLowerCase()

function domainMatch(cookieDomain: string, host: string): boolean {
  const domain = bareDomain(cookieDomain)
  return cookieDomain.startsWith(".") ? host === domain || host.endsWith(`.${domain}`) : host === domain
}

/** the cookies of a CDP cookie list that belong to the configured domains and that the browser sends to the origin, in the stored shape */
export function keepCookies(config: WebSessionConfig, cookies: unknown[]): WebCookie[] {
  const domains = new Set(config.cookieDomains.map(bareDomain))
  const host = new URL(config.origin).hostname.toLowerCase()
  const names = config.cookieNames ? new Set(config.cookieNames) : null
  const kept: WebCookie[] = []
  for (const raw of cookies) {
    if (raw === null || typeof raw !== "object") continue
    const c = raw as Record<string, unknown>
    if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") continue
    if (!domains.has(bareDomain(c.domain)) || !domainMatch(c.domain, host) || (names && !names.has(c.name))) continue
    const session = c.session === true || typeof c.expires !== "number" || c.expires <= 0
    kept.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === "string" && c.path ? c.path : "/",
      ...(session ? {} : { expires: c.expires as number }),
      ...(c.secure === true ? { secure: true } : {}),
    })
  }
  return kept
}

const live = (cookie: WebCookie, now: number) => cookie.expires === undefined || cookie.expires * 1000 > now

/** the cookies the browser would send to `url` */
function sendable(cookies: WebCookie[], url: URL, now: number): WebCookie[] {
  const host = url.hostname.toLowerCase()
  return cookies.filter((cookie) => {
    const pathMatch = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)
    return domainMatch(cookie.domain, host) && pathMatch && live(cookie, now) && (!cookie.secure || url.protocol === "https:")
  })
}

/** the Cookie header the browser would send to `url` (matched against the configured origin, not an override) */
export function cookieHeader(cookies: WebCookie[], url: URL, now = Date.now()): string {
  return sendable(cookies, url, now).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}

/** whether a session sends every session cookie, unexpired, to `path` (default: the probe's) */
export function sessionLive(config: WebSessionConfig, session: WebSession, path = config.probe.path, now = Date.now()): boolean {
  const sent = sendable(session.cookies, new URL(path, config.origin), now)
  return sent.length > 0 && (config.sessionCookies ?? []).every((name) => sent.some((cookie) => cookie.name === name))
}

/** where requests for `path` go: the origin, or its loopback override */
export function webUrl(config: WebSessionConfig, path: string): URL {
  assertHttpsOrigin(config)
  return new URL(path, config.originEnv ? vendorUrl(config.originEnv, config.origin) : config.origin)
}

/** the headers a request to `path` carries: the cookies the browser would send there, and its user agent */
export function webHeaders(config: WebSessionConfig, session: WebSession, path: string): Record<string, string> {
  assertHttpsOrigin(config)
  return {
    cookie: cookieHeader(session.cookies, new URL(path, config.origin)),
    ...(session.userAgent ? { "user-agent": session.userAgent } : {}),
  }
}

export type ProbeResult = "ok" | "refused" | "failed"

/** asks the site whether the session is logged in */
export async function probeSession(config: WebSessionConfig, session: WebSession): Promise<ProbeResult> {
  try {
    const response = await fetch(webUrl(config, config.probe.path), {
      headers: { ...webHeaders(config, session, config.probe.path), accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400) ? "refused" : "failed"
    if (!config.probe.field) return "ok"
    const body = (await response.json()) as Record<string, unknown> | null
    return body && typeof body === "object" && body[config.probe.field] ? "ok" : "refused"
  } catch {
    return "failed"
  }
}

const SESSIONS_DIR = "web-sessions"

export const webSessionService = (provider: ProviderId, slot: string) => `kyora-switch.${provider}-web.${assertName(slot)}`

/**
 * Outside the slot directory on purpose: a slot directory is rewritten whole on every save and
 * sync, and its files are what `kyora session creds sync` uploads.
 */
export const webSessionPath = (provider: ProviderId, slot: string) => join(rootDir(), SESSIONS_DIR, provider, `${assertName(slot)}.json`)

/** the keychain as the store sees it; tests stand in a fake one, since the real keychain is off under test */
export interface KeychainStore {
  supported: boolean
  read(service: string): Promise<string | null>
  write(service: string, text: string): Promise<void>
  delete(service: string): Promise<void>
}

export const systemKeychain = (): KeychainStore => ({
  supported: keychainSupported(),
  read: (service) => keychainRead(service),
  write: (service, text) => keychainWrite(text, service, undefined, { argv: false }),
  delete: (service) => keychainDelete(service),
})

function parseSession(text: string | null): WebSession | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<WebSession>
    if (!Array.isArray(parsed.cookies)) return null
    return {
      cookies: parsed.cookies.filter((c): c is WebCookie => typeof c?.name === "string" && typeof c?.value === "string" && typeof c?.domain === "string" && typeof c?.path === "string"),
      ...(typeof parsed.userAgent === "string" ? { userAgent: parsed.userAgent } : {}),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    }
  } catch {
    return null
  }
}

/** the keychain where there is one, else (or for a session too long for the keychain's stdin) the 0600 file; returns where */
async function store(provider: ProviderId, slot: string, text: string, keychain: KeychainStore): Promise<string> {
  const service = webSessionService(provider, slot)
  const path = webSessionPath(provider, slot)
  if (keychain.supported) {
    try {
      await keychain.write(service, text)
      await rm(path, { force: true })
      return `macOS keychain: ${service}`
    } catch (error) {
      if (!(error instanceof KeychainTooLarge)) throw error
      await writeFileAtomic(path, `${text}\n`, 0o600)
      await keychain.delete(service)
      return path
    }
  }
  await writeFileAtomic(path, `${text}\n`, 0o600)
  return path
}

export async function readWebSession(provider: ProviderId, slot: string, keychain = systemKeychain()): Promise<WebSession | null> {
  const stored = keychain.supported ? await keychain.read(webSessionService(provider, slot)) : null
  return parseSession(stored ?? (await readTextIfExists(webSessionPath(provider, slot))))
}

/** stores a slot's session and returns where it went */
export async function writeWebSession(provider: ProviderId, slot: string, session: WebSession, keychain = systemKeychain()): Promise<string> {
  return await store(provider, slot, JSON.stringify(session), keychain)
}

/** whether there was one to delete */
export async function deleteWebSession(provider: ProviderId, slot: string, keychain = systemKeychain()): Promise<boolean> {
  let had = false
  if (keychain.supported && (await keychain.read(webSessionService(provider, slot))) !== null) {
    await keychain.delete(webSessionService(provider, slot))
    had = true
  }
  const path = webSessionPath(provider, slot)
  if (existsSync(path)) {
    await rm(path, { force: true })
    had = true
  }
  return had
}

/** moves a slot's session along with a rename; whatever was stored under the new name is dropped */
export async function moveWebSession(provider: ProviderId, from: string, to: string, keychain = systemKeychain()): Promise<void> {
  await deleteWebSession(provider, to, keychain)
  const text = keychain.supported ? await keychain.read(webSessionService(provider, from)) : null
  if (text !== null) {
    await store(provider, to, text, keychain)
    await deleteWebSession(provider, from, keychain)
  } else if (existsSync(webSessionPath(provider, from))) await rename(webSessionPath(provider, from), webSessionPath(provider, to))
}

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
]
const MAC_LATER = [
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
]
const LINUX_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
const LINUX_LATER = ["microsoft-edge", "microsoft-edge-stable", "brave-browser"]

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return undefined
}

/** the newest Chromium a Playwright install downloaded, never its headless shell */
export function playwrightChromium(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string | undefined {
  const root = env.PLAYWRIGHT_BROWSERS_PATH || (platform === "darwin" ? join(home, "Library", "Caches", "ms-playwright") : join(home, ".cache", "ms-playwright"))
  let revisions: string[]
  try {
    revisions = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name))
  } catch {
    return undefined
  }
  revisions.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  const inside = platform === "darwin"
    ? ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"].flatMap((dir) => [
        join(dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(dir, "Chromium.app", "Contents", "MacOS", "Chromium"),
      ])
    : [join("chrome-linux64", "chrome"), join("chrome-linux", "chrome")]
  for (const revision of revisions) {
    for (const path of inside) if (existsSync(join(root, revision, path))) return join(root, revision, path)
  }
  return undefined
}

function usableOverride(path: string): string | undefined {
  try {
    return statSync(path).isFile() && ![path, realpathSync(path)].some((name) => /firefox/i.test(basename(name))) ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * A Chromium-family browser to log in with: `KYORA_SWITCH_BROWSER`, else Chrome or Chromium,
 * else Playwright's Chromium, else Edge or Brave. Firefox has no DevTools protocol to read the
 * session back with, so it is never used.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
  appDirs = ["/Applications", join(home, "Applications")],
): string | undefined {
  if (env.KYORA_SWITCH_BROWSER) return usableOverride(env.KYORA_SWITCH_BROWSER)
  if (platform === "darwin") {
    const apps = (names: string[]) => names.flatMap((name) => appDirs.map((dir) => join(dir, name))).find((path) => existsSync(path))
    return apps(MAC_APPS) ?? playwrightChromium(env, platform, home) ?? apps(MAC_LATER)
  }
  const bins = (names: string[]) => names.map((name) => onPath(name, env)).find(Boolean)
  return bins(LINUX_BINS) ?? playwrightChromium(env, platform, home) ?? bins(LINUX_LATER)
}

export const NO_BROWSER =
  "web-login needs Google Chrome or Chromium (Firefox cannot hand the session back): install one, or run `bunx playwright install chromium`, or point KYORA_SWITCH_BROWSER at a Chromium-family browser's executable"

/** the DevTools protocol over --remote-debugging-pipe: Chrome reads fd 3 and writes fd 4, one NUL-terminated JSON message each */
class Cdp {
  private next = 1
  private closed = false
  private buffer = ""
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()

  constructor(private input: Writable, output: Readable, private timeoutMs: number) {
    output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8")
      let end: number
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const text = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        this.receive(text)
      }
    })
    const close = () => {
      this.closed = true
      for (const waiter of this.pending.values()) waiter.reject(new Error("the browser was closed before the login finished"))
      this.pending.clear()
    }
    output.on("close", close)
    output.on("error", close)
    input.on("error", close)
  }

  private receive(text: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const waiter = message.id === undefined ? undefined : this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id!)
    if (message.error) waiter.reject(new Error(`browser refused: ${message.error.message ?? "unknown error"}`))
    else waiter.resolve(message.result ?? {})
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.next++
    if (this.closed) return Promise.reject(new Error("the browser was closed before the login finished"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.input.write(`${JSON.stringify({ id, method, params })}\0`)
    })
  }

  close(): void {
    this.input.destroy()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const PROFILE_PREFIX = "kyora-switch-web-"
const OWNER_FILE = "kyora-switch.pid"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** deletes the throwaway profiles of web-logins that died before their own cleanup (their kyora-switch is gone) */
export async function sweepProfiles(root = tmpdir()): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names.filter((entry) => entry.startsWith(PROFILE_PREFIX))) {
    const dir = join(root, name)
    try {
      if ((await lstat(dir)).uid !== process.getuid?.()) continue
      const owner = Number((await readTextIfExists(join(dir, OWNER_FILE)))?.trim())
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) continue
      if (!Number.isInteger(owner) && Date.now() - (await lstat(dir)).mtimeMs < 60 * 60_000) continue
      await rm(dir, { recursive: true, force: true })
    } catch {}
  }
}

export interface WebLoginOptions {
  browser: string
  timeoutMs?: number
  pollMs?: number
  /** how long one DevTools call, and each step of stopping the browser, may take */
  graceMs?: number
  /** told once the browser is up, and on progress */
  log?: (message: string) => void
}

export const WEB_LOGIN_TIMEOUT_MS = 10 * 60_000

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * Opens `browser`, headful, on a fresh temporary profile at the site, waits while the user logs
 * in by hand, and returns the site's cookies once the probe accepts them. The DevTools protocol
 * runs over a pipe, never a port, so no other process or user can reach the browser. The
 * browser is closed and the profile deleted whatever happens. Nothing here types into the page.
 */
export async function webLogin(config: WebSessionConfig, options: WebLoginOptions): Promise<WebSession> {
  assertHttpsOrigin(config)
  const timeoutMs = options.timeoutMs ?? WEB_LOGIN_TIMEOUT_MS
  const pollMs = options.pollMs ?? 2000
  const graceMs = options.graceMs ?? 5000
  const deadline = Date.now() + timeoutMs
  await sweepProfiles()
  let interrupted = false
  const onSignal = () => { interrupted = true }
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal)
  const profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX))
  let child: ChildProcess | undefined
  let cdp: Cdp | undefined
  let exited = false
  let exit: Promise<void> = Promise.resolve()
  try {
    await writeFileAtomic(join(profile, OWNER_FILE), `${process.pid}\n`, 0o600)
    child = spawn(
      options.browser,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--new-window",
        new URL(config.startPath ?? "/", config.origin).href,
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    )
    exit = new Promise<void>((resolve) => {
      child!.once("exit", () => resolve())
      child!.once("error", () => resolve())
    }).then(() => { exited = true })
    cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable, graceMs)
    const userAgent = (await cdp.send("Browser.getVersion")).userAgent
    options.log?.(`log in to ${new URL(config.origin).host} in the browser window; kyora-switch never types into it and waits up to ${Math.round(timeoutMs / 60_000)} min`)

    const stillOpen = () => {
      if (interrupted) throw new Error("interrupted; nothing saved")
      if (exited) throw new Error("the browser was closed before the login finished")
    }
    let refused = ""
    while (Date.now() < deadline) {
      stillOpen()
      const { cookies } = await cdp.send("Storage.getCookies")
      stillOpen()
      const session: WebSession = {
        cookies: keepCookies(config, Array.isArray(cookies) ? cookies : []),
        ...(typeof userAgent === "string" ? { userAgent } : {}),
        savedAt: Date.now(),
      }
      const fingerprint = JSON.stringify(session.cookies.map((cookie) => [cookie.domain, cookie.path, cookie.name, cookie.value, cookie.expires, cookie.secure]).sort())
      if (sessionLive(config, session) && fingerprint !== refused) {
        const result = await probeSession(config, session)
        stillOpen()
        if (result === "ok") return session
        if (result === "refused") refused = fingerprint
      }
      await sleep(pollMs)
    }
    throw new Error(`no login within ${Math.round(timeoutMs / 1000)} s`)
  } finally {
    if (cdp && !exited) await cdp.send("Browser.close").catch(() => {})
    cdp?.close()
    if (child) {
      const stopped = (ms: number) => Promise.race([exit.then(() => true), sleep(ms).then(() => false)])
      if (!(await stopped(graceMs))) {
        child.kill("SIGTERM")
        if (!(await stopped(graceMs))) {
          child.kill("SIGKILL")
          await stopped(graceMs)
        }
      }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal)
  }
}
