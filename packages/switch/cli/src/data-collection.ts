import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { agyDir } from "./providers/agy"
import { claudeDir } from "./providers/claude"
import { grokHome, grokSession, parseStore } from "./providers/grok"
import { museConfigDir } from "./providers/muse"
import type { ProviderId, Snapshot } from "./types"

/**
 * What a CLI's data collection is set to, read only from local files and the environment: whether
 * the account's interactions may train models, and whether the CLI sends telemetry. "unknown" is a
 * setting kept on the vendor's side, which kyora-switch never asks for.
 */
export interface DataCollection {
  training: "opted-out" | "opted-in" | "unknown"
  telemetry: "on" | "off" | "unknown"
  /** the line `status` prints, every value with where it came from */
  line: string
}

type Doc = Record<string, unknown>

function record(value: unknown): Doc | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : undefined
}

/** a settings file: its document, `{}` when there is none, or null when it is there and cannot be read */
function readSettings(path: string, parse: (text: string) => unknown): Doc | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : null
  }
  try {
    return record(parse(text)) ?? null
  } catch {
    return null
  }
}

const readJson = (path: string) => readSettings(path, JSON.parse)
const readToml = (path: string) => readSettings(path, (text) => Bun.TOML.parse(text))

/** a path as `status` prints it, the home directory as `~` */
const shown = (path: string): string => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path)

/** an environment switch as these CLIs read one: set and not "0" or "false" */
const envOn = (value: string | undefined): boolean => value !== undefined && value !== "" && !/^(0|false)$/i.test(value)

function claude(env: NodeJS.ProcessEnv): DataCollection {
  const path = join(claudeDir(), "settings.json")
  const settings = readJson(path)
  const settingsEnv = record(settings?.env) ?? {}
  const off = ["DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].find((name) => envOn(env[name]) || envOn(typeof settingsEnv[name] === "string" ? (settingsEnv[name] as string) : undefined))
  const telemetry = off ? `telemetry off (${off})` : settings === null ? `telemetry unknown (${shown(path)} unreadable)` : "telemetry on (default; DISABLE_TELEMETRY unset)"
  return {
    training: "unknown",
    telemetry: off ? "off" : settings === null ? "unknown" : "on",
    line: `${telemetry} · training: account setting, not readable locally`,
  }
}

function grok(env: NodeJS.ProcessEnv, snapshot: Snapshot | null): DataCollection {
  let training: DataCollection["training"] = "unknown"
  let trainingText = snapshot ? "training: not recorded in this login" : "training: no login"
  try {
    const entry = snapshot ? grokSession(parseStore(snapshot.files["auth.json"] ?? "", "auth.json"), env)?.entry : undefined
    if (entry?.is_zdr === true) {
      training = "opted-out"
      trainingText = "ZDR (account, auth.json)"
    } else if (typeof entry?.coding_data_retention_opt_out === "boolean") {
      training = entry.coding_data_retention_opt_out ? "opted-out" : "opted-in"
      trainingText = `training opted ${entry.coding_data_retention_opt_out ? "out" : "in"} (account, auth.json)`
    }
  } catch {}
  const config = readToml(join(grokHome(env), "config.toml"))
  const setting = record(config?.features)?.telemetry
  let telemetry: string
  if (typeof setting === "boolean") telemetry = `telemetry ${setting ? "on" : "off"} ([features] telemetry)`
  else if (config === null) telemetry = "telemetry unknown (config.toml unreadable)"
  else if (env.GROK_TELEMETRY_ENABLED !== undefined && env.GROK_TELEMETRY_ENABLED !== "") telemetry = `telemetry ${envOn(env.GROK_TELEMETRY_ENABLED) ? "on" : "off"} (GROK_TELEMETRY_ENABLED)`
  else if (envOn(env.DISABLE_TELEMETRY)) telemetry = "telemetry off (DISABLE_TELEMETRY)"
  else telemetry = "telemetry on (default; [features] telemetry unset)"
  const state = telemetry.startsWith("telemetry on") ? "on" : telemetry.startsWith("telemetry off") ? "off" : "unknown"
  return { training, telemetry: state, line: `${trainingText} · ${telemetry}` }
}

function agy(env: NodeJS.ProcessEnv): DataCollection {
  const path = join(agyDir(env), "settings.json")
  const settings = readJson(path)
  const setting = settings?.enableTelemetry
  const telemetry = typeof setting === "boolean" ? `telemetry ${setting ? "on" : "off"} (enableTelemetry in ${shown(path)})`
    : settings === null ? `telemetry unknown (${shown(path)} unreadable)`
    : setting !== undefined ? `telemetry unknown (unexpected value; enableTelemetry in ${shown(path)})`
    : `telemetry on (default; enableTelemetry unset in ${shown(path)})`
  return {
    training: "unknown",
    telemetry: setting === false ? "off" : settings === null || (setting !== undefined && typeof setting !== "boolean") ? "unknown" : "on",
    line: `${telemetry} · interactions per the Antigravity terms, toggle: /config in agy`,
  }
}

function muse(): DataCollection {
  const path = join(museConfigDir(), "settings.json")
  const settings = readJson(path)
  const enabled = settings?.contributor_mode_enabled
  return {
    training: enabled === true ? "opted-in" : enabled === false ? "opted-out" : "unknown",
    telemetry: "unknown",
    line: typeof enabled === "boolean" ? `contributor mode ${enabled ? "on" : "off"} (${shown(path)})`
      : settings === null ? `contributor mode unknown (${shown(path)} unreadable)`
      : `contributor mode unset, Muse's default (${shown(path)})`,
  }
}

/** a provider's data collection, for `status`; `snapshot` is the login it is read for (Grok Build keeps it per account) */
export function dataCollection(provider: ProviderId, snapshot: Snapshot | null, env: NodeJS.ProcessEnv = process.env): DataCollection {
  switch (provider) {
    case "claude":
      return claude(env)
    case "codex":
      return { training: "unknown", telemetry: "unknown", line: "training: account setting (chatgpt.com data controls), not readable locally" }
    case "opencode":
      return { training: "unknown", telemetry: "unknown", line: "no local setting: the model provider's terms apply" }
    case "muse":
      return muse()
    case "grok":
      return grok(env, snapshot)
    case "agy":
      return agy(env)
  }
}
