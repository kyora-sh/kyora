import { homedir } from "node:os"
import { join } from "node:path"
import { activeLogin, credentialsPath, readCredentials } from "./credentials"
import { DEFAULT_URL, VMD_DEFAULT_URL, PLATFORM_TOKEN_PREFIX, VMD_KEY_PREFIX, originOf, type Config } from "./client-config"
export { DEFAULT_URL, VMD_DEFAULT_URL, PLATFORM_TOKEN_PREFIX, VMD_KEY_PREFIX, originOf, type Config } from "./client-config"

type Env = Record<string, string | undefined>

const configBase = (env: Env) => env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")

export function configPath(env: Env = process.env): string {
  return join(configBase(env), "kyora-vms", "env")
}

export function credentialsFile(env: Env = process.env): string {
  return credentialsPath(configBase(env))
}

/** KEY=VALUE lines; `#` comments, an optional `export ` and matching quotes are allowed */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "")
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    values[line.slice(0, eq).trim()] = value
  }
  return values
}

async function readText(path: string): Promise<string | null> {
  const file = Bun.file(path)
  return (await file.exists()) ? await file.text() : null
}

/**
 * Bun loads these from the working directory into process.env before any of our
 * code runs, unless started with --no-env-file (the bin's shebang does that).
 */
const DOTENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"]

async function plantedByDotenv(name: string, value: string, cwd: string): Promise<string | null> {
  for (const file of DOTENV_FILES) {
    const text = await readText(join(cwd, file))
    if (text !== null && parseEnvFile(text)[name] === value) return file
  }
  return null
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/** `what` names the value in errors: "KYORA_VMS_URL from ~/.config/kyora-vms/env", "--url" */
export function checkUrl(value: string, what: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${what} is not a URL`)
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return url.toString().replace(/\/+$/, "")
  }
  throw new Error(`${what} must be https:// (plain http only to localhost)`)
}

/**
 * The shell's env wins over the config file, which wins over a stored login. A value
 * a checkout's own .env planted is refused outright: the directory we are about to
 * upload must never get to pick which server our key is sent to, or whose account
 * our code lands in.
 */
export async function loadConfig(env: Env = process.env, cwd = process.cwd()): Promise<Config> {
  const file = configPath(env)
  const fromFile = parseEnvFile((await readText(file)) ?? "")

  async function fromEnv(name: string): Promise<{ value: string; source: string } | null> {
    const value = env[name]?.trim()
    if (!value) return null
    const planted = await plantedByDotenv(name, value, cwd)
    if (planted) {
      throw new Error(`refusing ${name} from ${join(cwd, planted)}: a checkout must not choose where your key goes; set it in your shell or ${file}`)
    }
    return { value, source: `$${name}` }
  }

  function stored(name: string): { value: string; source: string } | null {
    const value = fromFile[name]?.trim()
    return value ? { value, source: file } : null
  }

  const key = (await fromEnv("KYORA_VMS_KEY")) ?? (await fromEnv("KYORA_TOKEN")) ?? stored("KYORA_VMS_KEY") ?? stored("KYORA_TOKEN")
  // nothing configured at all means kyora cloud; a vmd key on its own keeps going where it always did
  const fallback = key && !key.value.startsWith(PLATFORM_TOKEN_PREFIX) ? VMD_DEFAULT_URL : DEFAULT_URL
  const picked = (await fromEnv("KYORA_VMS_URL")) ?? stored("KYORA_VMS_URL") ?? { value: fallback, source: "default" }
  const url = checkUrl(picked.value, `KYORA_VMS_URL from ${picked.source}`)
  const credentials = credentialsFile(env)

  let chosen = key
  let org: string | null = null
  if (!chosen) {
    const saved = (await readCredentials(credentials))[originOf(url)]
    // `kyora-vms org use`: the org's token when one is in use, else the personal one
    const active = saved ? activeLogin(saved) : null
    if (active) {
      chosen = { value: active.token, source: credentials }
      org = active.org?.login ?? null
    }
  }
  return {
    url,
    urlSource: picked.source,
    key: chosen?.value ?? null,
    keySource: chosen?.source ?? null,
    credentials,
    org,
  }
}
