import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { note } from "./output"

/** an org token (`kyora-vms org use` or `login --org`): it acts as the org, minted by `actor` */
export interface StoredOrgLogin {
  token: string
  id: string
  login: string
  actor: string
  expiresAt?: string | null
}

/** one `kyora-vms login`, keyed by origin in credentials.json */
export interface StoredLogin {
  /** the personal token; empty when this origin only has org logins */
  token: string
  login: string
  url: string
  expiresAt?: string | null
  /** org tokens, by the org's handle */
  orgs?: Record<string, StoredOrgLogin>
  /** the org (handle) the CLI acts as here; absent: the personal token */
  use?: string
}

export type Credentials = Record<string, StoredLogin>

const isOrgLogin = (value: unknown): value is StoredOrgLogin =>
  typeof value === "object" && value !== null && typeof (value as StoredOrgLogin).token === "string" && (value as StoredOrgLogin).token.length > 0 && typeof (value as StoredOrgLogin).login === "string"

/** the token a login means: the org in use (when its token is stored), else the personal one; null: neither */
export function activeLogin(login: StoredLogin): { token: string; org: StoredOrgLogin | null } | null {
  const org = login.use ? login.orgs?.[login.use] : undefined
  if (org) return { token: org.token, org }
  return login.token ? { token: login.token, org: null } : null
}

/** meant for any kyora client that signs in to kyora cloud, hence not under kyora-vms/ */
export const credentialsPath = (configBase: string) => join(configBase, "kyora", "credentials.json")

/** a personal token, or at least one org token (an org's member with no access of their own has only those) */
const isLogin = (value: unknown): value is StoredLogin =>
  typeof value === "object" && value !== null && typeof (value as StoredLogin).token === "string" &&
  ((value as StoredLogin).token.length > 0 || Object.values((value as StoredLogin).orgs ?? {}).some(isOrgLogin))

/** the file as it is, so entries this CLI does not understand survive a rewrite */
async function readRaw(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    // a damaged file is ignored, loudly, rather than failing every command
    note(`ignoring ${path}: it is not valid JSON (\`kyora-vms login\` writes a fresh one)`)
    return {}
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

export async function readCredentials(path: string): Promise<Credentials> {
  const logins: Credentials = {}
  for (const [origin, value] of Object.entries(await readRaw(path))) {
    if (!isLogin(value)) continue
    const orgs = Object.fromEntries(Object.entries(value.orgs ?? {}).filter(([, org]) => isOrgLogin(org)))
    logins[origin] = { ...value, login: typeof value.login === "string" ? value.login : "?", orgs, ...(typeof value.use === "string" && orgs[value.use] ? { use: value.use } : { use: undefined }) }
    if (logins[origin]!.use === undefined) delete logins[origin]!.use
  }
  return logins
}

/**
 * Written to a temp file created 0600 and renamed over the old one, in a 0700
 * directory, so the token is never readable by anyone else, not even half-written.
 */
async function writeRaw(path: string, content: Record<string, unknown>): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  if (Object.keys(content).length === 0) {
    await rm(path, { force: true })
    return
  }
  const temp = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`)
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function saveLogin(path: string, origin: string, login: StoredLogin): Promise<void> {
  const content = await readRaw(path)
  content[origin] = login
  await writeRaw(path, content)
}

/** false when there was nothing stored for that origin */
export async function removeLogin(path: string, origin: string): Promise<boolean> {
  const content = await readRaw(path)
  if (!(origin in content)) return false
  delete content[origin]
  await writeRaw(path, content)
  return true
}
