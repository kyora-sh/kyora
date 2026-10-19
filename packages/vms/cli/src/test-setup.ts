import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The opt-in e2e tests (src/e2e, KYORA_E2E=1) are the one exception to the rule below: they run against the real kyora cloud with
// your own config, so they keep a copy of the environment as it was. Without KYORA_E2E=1 nothing is kept.
if (process.env.KYORA_E2E === "1") (globalThis as Record<symbol, unknown>)[Symbol.for("kyora.e2e.env")] = Object.freeze({ ...process.env })

/**
 * No test may read the developer's real ~/.config/kyora-vms/env or reach the real
 * host with the real key: HOME and XDG_CONFIG_HOME point at a throwaway, and the
 * shell's KYORA_VMS_* and KYORA_TOKEN are dropped before any test builds a child env from ours.
 */
const home = mkdtempSync(join(tmpdir(), "kyora-vms-test-home-"))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, ".config")
// kyora session reads agents' logins and kyora-switch's slots: every one of those locations is the throwaway's too
process.env.XDG_STATE_HOME = join(home, ".local", "state")
process.env.XDG_DATA_HOME = join(home, ".local", "share")
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude")
process.env.CODEX_HOME = join(home, ".codex")
process.env.KYORA_SWITCH_DIR = join(home, ".kyora", "switch")
process.env.KYORA_SWITCH_NO_KEYCHAIN = "1"
delete process.env.KYORA_VMS_KEY
delete process.env.KYORA_VMS_URL
delete process.env.KYORA_TOKEN
process.on("exit", () => rmSync(home, { recursive: true, force: true }))
