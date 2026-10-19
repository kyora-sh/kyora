import { userInfo } from "node:os"

export const KEYCHAIN_SERVICE = "Claude Code-credentials"

const STDIN_LIMIT = 4096

/** a blob too long for `security -i`, which a write without the argv fallback refuses */
export class KeychainTooLarge extends Error {}

export function keychainAccount(): string {
  return userInfo().username
}

/**
 * Set KYORA_SWITCH_NO_KEYCHAIN=1 to keep credentials in files only. A test run is
 * refused outright, because reaching the real login keychain from one signs the
 * developer out of their own CLI.
 */
export function keychainSupported(): boolean {
  if (process.env.KYORA_SWITCH_NO_KEYCHAIN === "1") return false
  if (process.env.NODE_ENV === "test") return false
  return process.platform === "darwin"
}

/**
 * Reads the blob back, decoding the hex form `security` falls back to whenever the
 * value holds a non-ASCII or control byte. A JSON credential document is never all-hex.
 */
export async function keychainRead(service = KEYCHAIN_SERVICE, account = keychainAccount()): Promise<string | null> {
  const result = await Bun.$`security find-generic-password -a ${account} -w -s ${service}`.quiet().nothrow()
  if (result.exitCode === 44) return null
  if (result.exitCode !== 0) throw new Error(`keychain read failed (exit ${result.exitCode})`)

  const value = result.stdout.toString().trim()
  if (value.length === 0) return null
  if (value.length % 2 === 0 && /^[0-9a-f]+$/.test(value)) return Buffer.from(value, "hex").toString("utf8")
  return value
}

export async function keychainDelete(service = KEYCHAIN_SERVICE, account = keychainAccount()): Promise<void> {
  const result = await Bun.$`security delete-generic-password -a ${account} -s ${service}`.quiet().nothrow()
  if (result.exitCode !== 0 && !/could not be found/i.test(result.stderr.toString())) {
    throw new Error(`keychain delete failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
  }
}

async function run(command: string[], input?: string): Promise<{ ok: boolean; exitCode: number }> {
  const proc = Bun.spawn(command, {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "ignore",
    stderr: "ignore",
  })
  const exitCode = await proc.exited
  return { ok: exitCode === 0, exitCode }
}

/**
 * Stores the blob the way Claude Code does: hex-encoded through `security -i`
 * (`ascii`: as plain text with -w, the way go-keyring writes agy's login),
 * which keeps the secret out of the process arguments, falling back to argv
 * because `security -i` truncates any command line past 4096 characters.
 * With `argv: false` there is no fallback: a blob too long for stdin is refused.
 */
export async function keychainWrite(secret: string, service = KEYCHAIN_SERVICE, account = keychainAccount(), options: { argv?: boolean; ascii?: boolean } = {}): Promise<void> {
  if (/["\\]/.test(account) || /["\\]/.test(service)) {
    throw new Error(`cannot quote keychain account "${account}" or service "${service}"`)
  }
  if (options.ascii && !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(secret)) throw new Error("keychain value is not plain ASCII")

  const value = options.ascii ? ["-w", secret] : ["-X", Buffer.from(secret, "utf8").toString("hex")]
  const command = `add-generic-password -U -a "${account}" -s "${service}" ${options.ascii ? `-w "${secret}"` : value.join(" ")}\n`

  if (command.length <= STDIN_LIMIT && (await run(["security", "-i"], command)).ok) {
    if ((await keychainRead(service, account))?.trim() === secret.trim()) return
  }
  if (options.argv === false) {
    if (command.length > STDIN_LIMIT) throw new KeychainTooLarge(`too large for the keychain's stdin (${secret.length} bytes)`)
    throw new Error("keychain write failed")
  }

  // argv is visible only to this user's processes, which can read this keychain item through `security` anyway
  const argv = await run(["security", "add-generic-password", "-U", "-a", account, "-s", service, ...value])
  if (!argv.ok) throw new Error(`keychain write failed (exit ${argv.exitCode})`)
  if ((await keychainRead(service, account))?.trim() !== secret.trim()) throw new Error("keychain write verification failed")
}
