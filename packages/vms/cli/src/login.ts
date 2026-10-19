import { hostname } from "node:os"
import { ApiError, type DevicePoll, type VmsClient } from "./api"
import { DEFAULT_URL, originOf, type Config } from "./config"
import { readCredentials, removeLogin, saveLogin } from "./credentials"
import { note, printJson } from "./output"

type Env = Record<string, string | undefined>

/**
 * `$BROWSER` when set ("none" for never), else `open` on macOS and `xdg-open` on a
 * Linux desktop. Best effort: the URL is printed either way.
 */
export function openBrowser(url: string, env: Env = process.env): boolean {
  if (!/^https?:\/\//.test(url)) return false
  let cmd: string[] | null = null
  if (env.BROWSER !== undefined) cmd = env.BROWSER && env.BROWSER !== "none" ? [env.BROWSER, url] : null
  else if (process.platform === "darwin") cmd = ["open", url]
  else if (process.platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) cmd = ["xdg-open", url]
  if (!cmd) return false
  try {
    Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
    return true
  } catch {
    return false
  }
}

/** the network or the server having a moment is no reason to give up on a code that is still good */
const transient = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status >= 500)

/**
 * The device flow: kyora cloud hands out a code, the person approves it in the
 * browser (signing in with GitHub if need be), and polling picks up the token.
 * Only the token's hash is kept on the server; here it goes into credentials.json.
 */
/**
 * `org` (`--org`): the token acts as that org, which the person approving it must be in (an org's
 * member with no vms access of their own signs in this way). It is kept beside the personal one
 * and put in use; `kyora-vms org use` switches.
 */
export async function login(api: VmsClient, config: Config, asJson: boolean, org?: string): Promise<number> {
  if ((await api.kind()) !== "platform") {
    throw new Error(`${api.url} requires an API key (KYORA_VMS_KEY). To sign in to kyora cloud: kyora-vms login --url ${DEFAULT_URL}`)
  }
  const start = await api.deviceStart(hostname(), org)
  const expires = Date.now() + start.expiresIn * 1000
  note(`to sign in, open ${start.verifyUrl}`)
  note(`and check that it shows the code ${start.userCode} (good for ${Math.max(1, Math.round(start.expiresIn / 60))} min)`)
  note(openBrowser(start.verifyUrl) ? "opened it in your browser; waiting for you to approve…" : "waiting for you to approve…")

  const expired = (why: string) => new Error(`the code ${start.userCode} ran out before it was approved${why}; run \`kyora-vms login\` again`)
  let interval = Math.max(1, start.interval) * 1000
  let lastError = ""
  let approved: Extract<DevicePoll, { status: "approved" }> | null = null
  while (!approved) {
    await Bun.sleep(interval)
    let poll: DevicePoll
    try {
      poll = await api.devicePoll(start.deviceCode)
    } catch (error) {
      if (!transient(error)) throw error
      lastError = ` (last try: ${(error as Error).message})`
      if (Date.now() >= expires) throw expired(lastError)
      continue
    }
    switch (poll.status) {
      case "approved":
        approved = poll
        break
      case "pending":
        if (Date.now() >= expires) throw expired("")
        break
      case "slow_down":
        interval += 5000
        break
      case "denied":
        throw new Error(`login denied: ${poll.message}`)
      case "expired":
        throw new Error(`login failed: ${poll.message}`)
    }
  }

  const origin = originOf(api.url)
  const stored = (await readCredentials(config.credentials))[origin]
  if (approved.org) {
    // an org's token goes beside the personal one (if any) and is put in use
    const orgs = { ...stored?.orgs, [approved.org.login]: { token: approved.token, id: approved.org.id, login: approved.org.login, actor: approved.actor ?? "?", expiresAt: approved.expiresAt } }
    await saveLogin(config.credentials, origin, { token: stored?.token ?? "", login: stored?.login ?? approved.actor ?? "?", url: api.url, expiresAt: stored?.expiresAt ?? null, orgs, use: approved.org.login })
  } else {
    // a personal login keeps the org tokens, and acts as the person again
    await saveLogin(config.credentials, origin, { token: approved.token, login: approved.login, url: api.url, expiresAt: approved.expiresAt, ...(stored?.orgs && Object.keys(stored.orgs).length ? { orgs: stored.orgs } : {}) })
  }
  if (asJson) printJson({ url: api.url, login: approved.login, expiresAt: approved.expiresAt, credentials: config.credentials, ...(approved.org ? { org: approved.org, actor: approved.actor } : {}) })
  else console.log(approved.org ? `logged in to ${api.url} as ${approved.actor ?? "you"}, acting as the org ${approved.org.login}` : `logged in to ${api.url} as ${approved.login}`)

  // a login is only the last resort, so say when something else still decides
  if (originOf(config.url) !== origin) {
    note(`commands go to ${config.url} (KYORA_VMS_URL from ${config.urlSource}), not here; set KYORA_VMS_URL=${api.url} to use this login`)
  } else if (config.key && config.keySource !== config.credentials) {
    note(`the key from ${config.keySource} still comes first; unset it to use this login`)
  }
  return 0
}

export async function logout(url: string, config: Config, asJson: boolean): Promise<number> {
  const origin = originOf(url)
  const removed = await removeLogin(config.credentials, origin)
  if (asJson) printJson({ url, removed })
  else if (removed) {
    console.log(`logged out of ${url}`)
    note(`the token is gone from ${config.credentials} but stays valid until it expires; revoke it at ${origin}/dashboard/vms/tokens`)
  } else console.log(`not logged in to ${url}`)
  if (config.key && config.keySource !== config.credentials && originOf(config.url) === origin) note(`commands still use the key from ${config.keySource}`)
  return 0
}

export async function whoami(api: VmsClient, config: Config, asJson: boolean): Promise<number> {
  if ((await api.kind()) !== "platform") {
    throw new Error(`${api.url} requires an API key. Run \`kyora-vms health\` to check the key`)
  }
  const me = await api.me()
  if (asJson) {
    printJson({ ...me, url: api.url, source: config.keySource })
    return 0
  }
  if (me.kind === "org") console.log(`the org ${me.login} at ${api.url}, as ${me.actor?.login ?? "?"}${me.actor?.role ? ` (${me.actor.role})` : ""}`)
  else console.log(`${me.login}${me.role ? ` (${me.role})` : ""} at ${api.url}`)
  const details = [`from ${config.keySource}`]
  if (me.token?.name) details.unshift(`"${me.token.name}"`)
  if (me.token?.expiresAt) details.push(`expires ${me.token.expiresAt.slice(0, 10)}`)
  console.log(`token: ${details.join(", ")}`)
  return 0
}
