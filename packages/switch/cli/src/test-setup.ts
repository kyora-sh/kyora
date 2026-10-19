import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Belt for the NODE_ENV guard in `keychainSupported`. Preloaded from both the root
 * and the app bunfig, so no working directory can miss it the way the app-only one did.
 */
process.env.KYORA_SWITCH_NO_KEYCHAIN = "1"

/**
 * Every directory a provider reads a live login from starts out as an empty
 * throwaway, overriding the shell's, so a test that forgets to set its own can
 * never reach the real accounts. HOME reaches the CLI processes tests spawn; Bun
 * reads it once at startup, so `os.homedir()` in this process stays the shell's,
 * which is why every location also gets its own variable here.
 */
const sandbox = mkdtempSync(join(tmpdir(), "kyora-switch-sandbox-"))
for (const name of ["HOME", "XDG_CONFIG_HOME", "KYORA_SWITCH_DIR", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "ANTIGRAVITY_GEMINI_DIR"]) {
  process.env[name] = join(sandbox, name.toLowerCase())
  if (!process.env[name]?.startsWith(`${sandbox}/`)) throw new Error("test sandbox was not applied")
}
// a developer shell's Muse override must never point a test at the real login
delete process.env.META_API_KEY
// nor Grok Build's: an inline login, a relocated auth file, an API key or another sign-in scope
for (const name of ["GROK_AUTH", "GROK_AUTH_PATH", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID", "GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID"]) delete process.env[name]
// nor agy's sign-in overrides
for (const name of ["AGY_LLM_GATEWAY_API_KEY", "AGY_LLM_GATEWAY_URL", "AGY_ADC_AUTH", "GOOGLE_CLOUD_PROJECT", "KYORA_AGY_OAUTH_CLIENT_SECRET"]) delete process.env[name]
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }))
