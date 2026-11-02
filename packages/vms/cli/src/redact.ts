/** what `kyora mcp` keeps out of everything it sends and logs: the credentials it holds, and anything shaped like a kyora token */

const SHAPES = /(kyora|kvms|kysk|kshare|kys)_[A-Za-z0-9_-]{12,}/g

/** credentials a tool call loaded (a stored login's token, a storage key), kept for the life of the process */
const loaded = new Set<string>()

export function rememberSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) loaded.add(value)
}

/** every credential known: the environment's and the ones loaded */
export function knownSecrets(env: Record<string, string | undefined> = process.env): string[] {
  return [env.KYORA_TOKEN, env.KYORA_VMS_KEY, env.KYORA_STORAGE_KEY].map((value) => value?.trim() ?? "").filter((value) => value.length >= 8).concat([...loaded])
}

export function redact(text: string, secrets: Array<string | null | undefined> = knownSecrets()): string {
  let out = text
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]")
  return out.replace(SHAPES, "$1_[redacted]")
}
