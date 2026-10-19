import { isAbsolute, relative, sep } from "node:path"

/**
 * Where a session's repo lives on each side. Claude Code keys its sessions by the directory it
 * was started in (`~/.claude/projects/<that path, encoded>/<id>.jsonl`), and the conversation
 * itself is full of absolute paths, so the VM checks the repo out at the laptop's own path when
 * it can: /work bind-mounted there. Where it can't (an image without that top-level directory),
 * the repo stays at /work and the session file's `cwd` fields are rewritten on the way in and
 * back out ("mapped").
 */
export interface PathMap {
  /** the repo's top level on the laptop */
  local: string
  /** the same directory in the VM: `local` itself (same-path), or /work (mapped) */
  remote: string
}

/** the repo root in the VM; a same-path session bind-mounts it at the laptop's path */
export const REMOTE_WORK = "/work"
/** HOME of every exec in the VM (kyora-init) */
export const REMOTE_HOME = "/work/.home"

/** how far Claude Code keeps an encoded project path before it cuts it and appends a hash */
export const CLAUDE_PROJECT_NAME_MAX = 200

/** Java's String.hashCode, which Claude Code uses for long project paths: UTF-16 code units, 32-bit */
export function javaHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/**
 * The directory name Claude Code gives a working directory under `projects/`: every character
 * that isn't an ASCII letter or digit becomes `-`; past 200 characters it is cut there and
 * `-<|hash| in base 36>` appended. Read out of Claude Code 2.1.287's own code.
 */
export function claudeProjectName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (name.length <= CLAUDE_PROJECT_NAME_MAX) return name
  return `${name.slice(0, CLAUDE_PROJECT_NAME_MAX)}-${Math.abs(javaHash(cwd)).toString(36)}`
}

/** `path` with `from` swapped for `to` when it is `from` or under it, else null */
export function rebase(path: string, from: string, to: string): string | null {
  const root = from.length > 1 ? from.replace(/\/+$/, "") : from
  if (path === root) return to
  const prefix = root.endsWith("/") ? root : `${root}/`
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  return to.endsWith("/") ? `${to}${rest}` : `${to}/${rest}`
}

export const toRemote = (map: PathMap, path: string): string => rebase(path, map.local, map.remote) ?? path
export const toLocal = (map: PathMap, path: string): string => rebase(path, map.remote, map.local) ?? path

/** true when `path` is `root` or inside it */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

/**
 * A same-path session needs the laptop's path to be a sane absolute directory the VM can
 * create: no `..`, no control characters, nothing the guest treats specially.
 */
export function mountablePath(path: string): boolean {
  if (!path.startsWith("/") || path === "/") return false
  if (/[\x00-\x1f\x7f]/.test(path)) return false
  if (path.split("/").some((part) => part === "." || part === "..")) return false
  // the guest's own trees: binding over them would hide what the VM runs on
  return !["/work", "/tmp", "/proc", "/sys", "/dev", "/run", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var/lib"].some(
    (reserved) => path === reserved || path.startsWith(`${reserved}/`),
  )
}
