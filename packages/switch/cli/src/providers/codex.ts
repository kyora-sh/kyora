import { codexCredentials, codexUsage, type LiveUsage } from "@kyora-sh/usage"
import { homedir } from "node:os"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { readTextIfExists, writeFileAtomic } from "../fsx"
import { codexIdentity, jwtPayload } from "../identity"
import type { Provider, Snapshot } from "../types"

const AUTH_FILE = "auth.json"

export function codexDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex")
}

function authPath(): string {
  return join(codexDir(), AUTH_FILE)
}

export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  processName: "codex",
  loginHint: "run `codex login`",

  locations() {
    return [authPath()]
  },

  async capture(): Promise<Snapshot | null> {
    const text = await readTextIfExists(authPath())
    if (text === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${authPath()} is not valid JSON`)
    }
    return { provider: "codex", identity: codexIdentity(parsed), files: { [AUTH_FILE]: text }, capturedAt: Date.now() }
  },

  async forget(): Promise<void> {
    await rm(authPath(), { force: true })
  },

  credentialExpiry(snapshot: Snapshot): number | undefined {
    const token = codexCredentials(snapshot.files[AUTH_FILE] ?? "")?.token
    const exp = token ? jwtPayload(token)?.exp : undefined
    return typeof exp === "number" ? exp * 1000 : undefined
  },

  grant(snapshot: Snapshot): string | undefined {
    try {
      // the order kyora session's fingerprint uses (packages/vms/cli/src/sessions/slots.ts)
      const auth = JSON.parse(snapshot.files[AUTH_FILE] ?? "{}") as { OPENAI_API_KEY?: unknown; tokens?: { refresh_token?: unknown } }
      if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return auth.OPENAI_API_KEY
      const refresh = auth.tokens?.refresh_token
      return typeof refresh === "string" && refresh ? refresh : undefined
    } catch {
      return undefined
    }
  },

  async quota(snapshot: Snapshot): Promise<LiveUsage | null> {
    const credentials = codexCredentials(snapshot.files[AUTH_FILE] ?? "")
    return credentials ? await codexUsage(credentials.token, credentials.account) : null
  },

  async restore(snapshot: Snapshot): Promise<void> {
    const auth = snapshot.files[AUTH_FILE]
    if (auth === undefined) throw new Error("slot has no Codex credentials")
    await writeFileAtomic(authPath(), auth, 0o600)
  },
}
