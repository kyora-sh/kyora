import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ApiError, type ExecRequest, type VmsClient } from "./api"
import { collectExec, timeoutGraceMs } from "./exec"
import { git, type Listing, type PackEntry, type SpawnOptions } from "./pack"
import { formatBytes, formatMs, parseSize } from "./units"

/**
 * `--git`: the repo's history goes up with the tree, as a git bundle, and a command
 * run in the sandbox right after the upload builds `.git` around it. The local `.git`
 * itself never goes up: not its config (remotes with tokens, credential helpers,
 * extraheaders, insteadOf rewrites, sshCommand, includes), not its hooks, not
 * `.git/modules`, worktrees or LFS objects. What goes up, under IMPORT, is
 *
 * - a bundle: commits, trees and blobs only. It is made in a repository of our own in
 *   a temp dir (no template, none of the user's global or system config) that borrows
 *   the source's objects and is told exactly which commits to hold: refs at HEAD and
 *   the base, a shallow list cut where the selection (selectCommits) ends. Plus the
 *   blobs staged here, so the sandbox's index can be exactly this one. Every commit in
 *   the finished bundle is checked against the selection before anything goes up;
 * - its shallow list, when that history stops short of the root;
 * - `commit ref` lines for the refs to set: HEAD's branch, the base;
 * - the index where it differs from HEAD: staged entries (mode, blob, path), paths
 *   deleted from it, and skip-worktree paths;
 *
 * and, on the setup command's own command line, the object format, HEAD's commit and
 * branch, and `origin`'s URL with any credentials taken out.
 */

/** where the history travels inside the upload; the setup command removes it */
export const IMPORT = ".git/kyora-import"

/**
 * Every file that goes up under IMPORT, each every time (empty when there is nothing to
 * say): the upload replaces whatever a push whose setup never finished left there.
 */
const IMPORT_FILES = ["history.bundle", "shallow", "refs", "index", "unstage", "skip-worktree"] as const

/** history over this size is refused before a sandbox is created; KYORA_VMS_GIT_MAX changes it */
export const GIT_MAX = 1024 ** 3

export interface HistoryOptions {
  /** --git-depth: the last N commits of HEAD (at least, with --git-base) */
  depth?: number
  /** --git-base: this commit too, and every commit between it, HEAD and their merge base */
  base?: string
  /** the bundle may be at most this big */
  maxBytes: number
  /**
   * kyora session: send this commit as HEAD, on this branch, with an index that is exactly its
   * tree, instead of the repo's own HEAD and index (the session's snapshot commit, which already
   * holds every local change)
   */
  at?: { commit: string; branch: string }
}

export interface History {
  /** the commit HEAD is at */
  head: string
  /** the branch HEAD is on (refs/heads/…), null when it is detached */
  branch: string | null
  /** what --git-base named, the commit it is, and the ref it gets in the sandbox */
  base: { rev: string; sha: string; ref: string } | null
  /** remote.origin.url without credentials; null when there is none, or none worth sending */
  origin: string | null
  objectFormat: string
  /** commits in the bundle */
  commits: number
  /** the history stops short of the root: --git-depth, --git-base, or a shallow clone */
  shallow: boolean
  /** paths staged in the sandbox as they are here, and paths taken out of its index */
  staged: number
  /** the bundle's size */
  bytes: number
  /** what goes up with the tree, under IMPORT */
  entries: PackEntry[]
  cleanup: () => Promise<void>
}

/** KYORA_VMS_GIT_MAX (`2G`, `500M`; a bare number is GiB), else GIT_MAX */
export function gitMax(env: Record<string, string | undefined> = process.env): number {
  const text = env.KYORA_VMS_GIT_MAX?.trim()
  return text ? parseSize(text, "KYORA_VMS_GIT_MAX") : GIT_MAX
}

/**
 * remote.origin.url as it may go into the sandbox: no userinfo (tokens sit there, as in
 * https://x-access-token:…@github.com/…), no query or fragment, and only transports that
 * name a server. Local paths, file:// and remote helpers (ext::…) stay here. ssh keeps
 * the conventional `git@` and nothing else.
 */
export function cleanRemoteUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url || /[\s\x00-\x1f\x7f]/.test(url)) return null
  // what is left may name git@ as the ssh user, and nothing else: an @ anywhere else could be the end of a credential
  const clean = (text: string) => (text.replace(/^(ssh:\/\/)?git@/, "$1").includes("@") ? null : text)
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    if (!["https", "http", "ssh", "git"].includes(protocol)) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (!parsed.hostname) return null
    const user = protocol === "ssh" && parsed.username === "git" && !parsed.password ? "git@" : ""
    return clean(`${protocol}://${user}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`)
  }
  // a remote helper (ext::, fd::, …) or a local path
  if (url.includes("::") || url.startsWith("/") || url.startsWith(".")) return null
  // scp-like: [user@]host:path, no slash before the colon
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(url)
  if (!scp) return null
  const [, user, host, path] = scp
  return clean(`${user === "git" ? "git@" : ""}${host}:${path}`)
}

export class HistoryError extends Error {}

/**
 * git for the repository the bundle is made in: none of the user's global or system
 * config (their hooksPath, templateDir or fetch settings do not apply to it), no GIT_*
 * variable pointing it elsewhere, no prompts.
 */
function isolated(tmp: string, signal?: AbortSignal): SpawnOptions {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value
  return { env: { ...env, HOME: tmp, XDG_CONFIG_HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" }, signal }
}

async function gitOut(args: string[], cwd: string, what: string, options?: SpawnOptions): Promise<string> {
  const result = await git(args, cwd, options)
  if (!result.ok) throw new HistoryError(`--git: ${what} failed: ${result.stderr.split("\n").find((line) => line.trim()) ?? `git ${args[0]} failed`}`)
  return result.stdout
}

/** the commit `rev` names, or null */
async function commitOf(rev: string, cwd: string, options?: SpawnOptions): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd, options)
  return result.ok ? result.stdout.trim() || null : null
}

/** a ref the sandbox can have for `rev`: its own when it is one (followed, for origin/HEAD), else refs/kyora/base */
async function refFor(rev: string, cwd: string, options?: SpawnOptions): Promise<string> {
  let ref = (await git(["rev-parse", "--symbolic-full-name", rev], cwd, options)).stdout.trim()
  if (!ref.startsWith("refs/")) return "refs/kyora/base"
  const target = (await git(["symbolic-ref", "--quiet", ref], cwd, options)).stdout.trim()
  if (target.startsWith("refs/")) ref = target
  return ref
}

interface IndexState {
  /** entries staged here (added, modified, type-changed): the sandbox's index gets them as they are */
  staged: { mode: string; blob: string; path: string }[]
  /** HEAD has them, the index does not */
  unstaged: string[]
  /** what a sparse checkout left out of the worktree, which would otherwise show as deleted there */
  skip: string[]
}

/** the index where it differs from HEAD */
async function indexState(top: string, options?: SpawnOptions): Promise<IndexState> {
  // plumbing: no renames, no external diff, whatever diff.* says; submodule pointers are left alone.
  // `:srcmode dstmode srcblob dstblob status` NUL path NUL, per entry
  const out = await gitOut(["diff-index", "--cached", "--raw", "--no-abbrev", "--ignore-submodules=all", "-z", "HEAD", "--"], top, "reading the index", options)
  const fields = out.split("\0")
  const state: IndexState = { staged: [], unstaged: [], skip: [] }
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , blob, status] = fields[i]!.split(" ")
    const path = fields[i + 1]!
    if (!path || !mode || !blob || !status) continue
    if (status === "D") state.unstaged.push(path)
    else if (status === "A" || status === "M" || status === "T") state.staged.push({ mode, blob, path })
  }
  const tagged = await gitOut(["ls-files", "-z", "-t"], top, "reading the index", options)
  for (const entry of tagged.split("\0")) if (entry.startsWith("S ")) state.skip.push(entry.slice(2))
  return state
}

/**
 * Makes the bundle for `--git` and what goes up with it. Everything is decided here,
 * before a sandbox exists: not a repo, not its top level, no commits yet, a base that
 * is not a commit, or more history than `maxBytes` all fail now, with nothing created.
 */
export async function prepareHistory(dir: string, listing: Listing, options: HistoryOptions, signal?: AbortSignal): Promise<History> {
  if (listing.mode !== "git") throw new HistoryError(`--git: ${dir} is not in a git repo, so there is no history to send`)
  const top = (await gitOut(["rev-parse", "--show-toplevel"], dir, "finding the repo", { signal })).trim()
  if ((await realpath(top)) !== (await realpath(dir))) {
    throw new HistoryError(`--git: .git goes at the top of the upload, so the directory must be the repo's top level (${top}), not ${dir}`)
  }
  const mine = { signal }
  const head = options.at ? await commitOf(options.at.commit, top, mine) : await commitOf("HEAD", top, mine)
  if (!head) throw new HistoryError(`--git: ${top} has no commits yet, so there is no history to send`)
  const branch = options.at ? options.at.branch : (await git(["symbolic-ref", "--quiet", "HEAD"], top, mine)).stdout.trim() || null
  const objectFormat = (await git(["rev-parse", "--show-object-format"], top, mine)).stdout.trim() || "sha1"

  let base: History["base"] = null
  if (options.base !== undefined) {
    const sha = await commitOf(options.base, top, mine)
    if (!sha) throw new HistoryError(`--git-base ${options.base}: not a commit in ${top}`)
    base = { rev: options.base, sha, ref: await refFor(options.base, top, mine) }
  }

  if (!base && options.depth === undefined) await refuseEarly(top, head, options.maxBytes, mine)
  const selection = await selectCommits(top, head, base?.sha ?? null, options.depth, mine)
  if (selection.orphaned.length > 0) throw new HistoryError(await cannotCut(top, head, base, options, selection, mine))
  const index: IndexState = options.at ? { staged: [], unstaged: [], skip: [] } : await indexState(top, mine)
  const tmp = await mkdtemp(join(tmpdir(), "kyora-vms-git-"))
  const cleanup = () => rm(tmp, { recursive: true, force: true })
  try {
    const repo = join(tmp, "history.git")
    const own = isolated(tmp, signal)
    const format = objectFormat === "sha1" ? [] : [`--object-format=${objectFormat}`]
    await gitOut(["init", "--quiet", "--bare", "--template=", ...format, repo], tmp, "making a repository for the history", own)
    // the source's objects, borrowed rather than copied; the refs and the shallow list decide what gets packed
    await writeFile(join(repo, "objects", "info", "alternates"), `${selection.objects}\n`)
    const headRef = branch ?? "refs/kyora/head"
    // the staged blobs, which no commit may have: a ref each keeps them in the bundle
    const blobs = [...new Set(index.staged.map((entry) => entry.blob))]
    const refs = new Map([[headRef, head], ...(base ? [[base.ref, base.sha] as [string, string]] : []), ...blobs.map((blob, n) => [`refs/kyora/index/${n}`, blob] as [string, string])])
    await gitOut(["--git-dir", repo, "update-ref", "--stdin"], tmp, "setting the history's refs", { ...own, stdin: lines([...refs].map(([ref, id]) => `update ${ref} ${id}`)) })
    if (selection.shallow.length > 0) await writeFile(join(repo, "shallow"), lines(selection.shallow))

    const importDir = join(tmp, "import")
    await mkdir(importDir)
    const bundle = join(importDir, "history.bundle")
    await gitOut(["--git-dir", repo, "bundle", "create", bundle, "--all"], tmp, "bundling the history", own)
    const bytes = (await lstat(bundle)).size
    if (bytes > options.maxBytes) throw new HistoryError(tooBig(`the history ${scope(options, base)}`, bytes, options.maxBytes, "is"))
    const commits = await verifyBundle(bundle, selection, new Set(blobs), { objectFormat, dir: tmp, signal })

    const paths = (list: string[]) => list.map((path) => `${path}\0`).join("")
    const contents: Record<(typeof IMPORT_FILES)[number], string> = {
      "history.bundle": "",
      shallow: lines(selection.shallow),
      refs: lines(sandboxRefs(head, branch, base)),
      // `git update-index -z --index-info`: mode SP blob TAB path NUL
      index: index.staged.map((entry) => `${entry.mode} ${entry.blob}\t${entry.path}\0`).join(""),
      unstage: paths(index.unstaged),
      "skip-worktree": paths(index.skip),
    }
    const entries: PackEntry[] = []
    for (const name of IMPORT_FILES) {
      const abs = join(importDir, name)
      if (name !== "history.bundle") await writeFile(abs, contents[name])
      entries.push({ rel: `${IMPORT}/${name}`, abs, stats: await lstat(abs) })
    }

    const origin = (await git(["config", "--get", "remote.origin.url"], top, mine)).stdout
    return {
      head,
      branch,
      base,
      origin: origin.trim() ? cleanRemoteUrl(origin) : null,
      objectFormat,
      commits,
      shallow: selection.shallow.length > 0,
      staged: index.staged.length + index.unstaged.length,
      bytes,
      entries,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const scope = (options: HistoryOptions, base: History["base"]) =>
  base ? `back to the merge base with ${base.rev}` : options.depth !== undefined ? `of the last ${options.depth} commits` : "of HEAD"

/** the refs the sandbox gets, as `commit ref` lines: the branch HEAD is on, and the base */
function sandboxRefs(head: string, branch: string | null, base: History["base"]): string[] {
  const refs: string[] = []
  if (branch) refs.push(`${head} ${branch}`)
  if (base && base.ref !== branch) refs.push(`${base.sha} ${base.ref}`)
  return refs
}

function tooBig(what: string, bytes: number, max: number, verb: string): string {
  return `--git: ${what} ${verb} ${formatBytes(bytes)}, over the ${formatBytes(max)} --git sends; send less with --git-depth N or --git-base REF, or raise KYORA_VMS_GIT_MAX`
}

/**
 * All of HEAD's history: the objects' size on disk says early (and cheaply) when the
 * bundle could not fit, before any of it is copied. Twice the limit, since loose objects
 * weigh more there than in a pack; the bundle itself is held to the limit exactly.
 */
async function refuseEarly(top: string, head: string, max: number, options: SpawnOptions): Promise<void> {
  const usage = await git(["rev-list", "--objects", "--disk-usage", head], top, options)
  const bytes = Number(usage.stdout.trim())
  if (usage.ok && Number.isFinite(bytes) && bytes > 2 * max) throw new HistoryError(tooBig("HEAD's history", bytes, max, "is about"))
}

const lines = (items: string[]) => items.map((item) => `${item}\n`).join("")

export interface Selection {
  /** the source's object directory, which the bundle's repository borrows from */
  objects: string
  /** every commit the bundle may hold, and nothing else */
  commits: Set<string>
  /** where the history is cut: a commit with a parent outside it, or one the source itself is shallow at */
  shallow: string[]
  /** the tips: HEAD, and the base */
  tips: string[]
  /** each commit's parents as the source has them (left empty for all of HEAD's history, which needs none) */
  parents: Map<string, string[]>
  /**
   * Commits of the selection that HEAD and the base no longer reach once the cut is
   * made: git cuts all of a shallow commit's parents, so a commit with one parent in the
   * selection and another outside it takes the one inside, and what is behind it, away
   * too. Empty unless that happens; prepareHistory refuses when it does.
   */
  orphaned: string[]
  /** the shallow commits with a parent kept and a parent cut: what orphans the rest */
  split: { commit: string; kept: string[]; cut: string[] }[]
}

/**
 * Exactly which commits go up, worked out in the source itself (as git sees it there:
 * its shallow list applies, replace refs do not, so the parents are the ones the
 * commits name):
 *
 * - all of HEAD's history, when nothing bounds it;
 * - with --git-depth N, the commits fewer than N parent steps from HEAD, as
 *   `git fetch --depth N` counts them;
 * - with --git-base, every commit HEAD or the base reaches that none of their merge
 *   bases does, and the merge bases themselves (git merge-base --all): the two sides
 *   down to where they meet, however they merged on the way, and not one commit older.
 *   Unrelated histories: the two tips.
 *
 * Its shallow list is then every commit of those with a parent outside them, and every
 * one the source is shallow at. git leaves out all of a shallow commit's parents, so
 * where one of them is in the selection and another is not, whatever only that commit
 * leads to is lost (see `orphaned`). Never widened to take the other parent in: that
 * commit is older than the boundary, which is the point of having one.
 */
export async function selectCommits(top: string, head: string, base: string | null, depth: number | undefined, options: SpawnOptions = {}): Promise<Selection> {
  const where = async (path: string) => resolve(top, (await gitOut(["rev-parse", "--git-path", path], top, "finding the repo", options)).trim())
  const objects = await where("objects")
  const sourceShallow = new Set((await readFile(await where("shallow"), "utf8").catch(() => "")).split("\n").filter(Boolean))

  const parents = new Map<string, string[]>()
  const add = (found: Map<string, string[]>) => {
    for (const [commit, of] of found) parents.set(commit, of)
  }
  if (base === null && depth === undefined) {
    // everything HEAD reaches: all of its parents are in it, so only the source's own cut can apply
    const all = await gitOut(["--no-replace-objects", "rev-list", head], top, "listing the history", options)
    for (const commit of all.split("\n")) if (commit) parents.set(commit, [])
  }
  if (depth !== undefined) add(await withinDepth(top, head, depth, options))
  if (base !== null) {
    const bases = (await git(["--no-replace-objects", "merge-base", "--all", head, base], top, options)).stdout.split("\n").filter(Boolean)
    if (bases.length > 0) add(await withParents(top, [head, base, "--not", ...bases], options))
    add(await withParents(top, ["--no-walk", head, base, ...bases], options))
  }

  const commits = new Set(parents.keys())
  const shallow = [...commits].filter((commit) => sourceShallow.has(commit) || parents.get(commit)!.some((parent) => !commits.has(parent))).sort()
  const tips = base === null ? [head] : [head, base]
  // all of HEAD's history reaches all of itself; a bounded one is walked as the cut leaves it
  if (base === null && depth === undefined) return { objects, commits, shallow, tips, parents, orphaned: [], split: [] }
  const cut = new Set(shallow)
  const reached = new Set<string>()
  const stack = tips.filter((tip) => commits.has(tip))
  while (stack.length > 0) {
    const commit = stack.pop()!
    if (reached.has(commit)) continue
    reached.add(commit)
    if (!cut.has(commit)) for (const parent of parents.get(commit)!) if (commits.has(parent) && !reached.has(parent)) stack.push(parent)
  }
  const orphaned = [...commits].filter((commit) => !reached.has(commit)).sort()
  const split = shallow
    .map((commit) => ({ commit, kept: parents.get(commit)!.filter((parent) => commits.has(parent)), cut: parents.get(commit)!.filter((parent) => !commits.has(parent)) }))
    .filter((entry) => entry.kept.length > 0 && entry.cut.length > 0)
  return { objects, commits, shallow, tips, parents, orphaned, split }
}

/** parent steps from `head` to each commit of the selection it reaches through the selection, the cut aside */
function stepsFrom(head: string, commits: Set<string>, parentsOf: (commit: string) => string[]): Map<string, number> {
  const steps = new Map([[head, 0]])
  let level = [head]
  while (level.length > 0) {
    const next: string[] = []
    for (const commit of level) {
      for (const parent of parentsOf(commit)) {
        if (!commits.has(parent) || steps.has(parent)) continue
        steps.set(parent, steps.get(commit)! + 1)
        next.push(parent)
      }
    }
    level = next
  }
  return steps
}

/**
 * Why the selection cannot go up as it is, and what would: which commit merges something
 * from before the boundary, what would go missing behind it, and the --git-depth that
 * takes HEAD's side of the range in whole (checked, not guessed), or else --git.
 */
async function cannotCut(top: string, head: string, base: History["base"], options: HistoryOptions, selection: Selection, spawn: SpawnOptions): Promise<string> {
  const short = (id: string) => id.slice(0, 12)
  const orphaned = new Set(selection.orphaned)
  const culprit = selection.split.find((entry) => entry.kept.some((parent) => orphaned.has(parent))) ?? selection.split[0]
  const lost = culprit?.kept.find((parent) => orphaned.has(parent)) ?? selection.orphaned[0]!
  const more = selection.orphaned.length - 1
  const missing = `${short(lost)}${more > 0 ? ` and ${more} more commit${more === 1 ? "" : "s"}` : ""} would go missing`
  const where = base ? `where HEAD and ${base.rev} meet` : "where the history stops"
  const why = culprit
    ? `${short(culprit.commit)} merges ${short(culprit.cut[0]!)}, which is older than ${where}, and git cannot cut off one parent of a commit and keep the other, so ${missing}`
    : `the history would be cut so that ${missing}`

  // a depth that covers every commit of the range HEAD reaches: does it leave nothing out?
  const steps = stepsFrom(head, selection.commits, (commit) => selection.parents.get(commit) ?? [])
  const depth = Math.max(options.depth ?? 0, Math.max(...steps.values()) + 1)
  const wider = await selectCommits(top, head, base?.sha ?? null, depth, spawn)
  const fix = wider.orphaned.length === 0 ? `Add --git-depth ${depth} to send HEAD's last ${depth} steps as well (older commits along with them), or send` : "Send"
  return `${base ? `--git-base ${base.rev}` : "--git"}: ${why}. ${fix} all of HEAD's history with --git`
}

/** `commit parent…` per commit rev-list lists for `revs` */
async function withParents(top: string, revs: string[], options: SpawnOptions): Promise<Map<string, string[]>> {
  const out = await gitOut(["--no-replace-objects", "rev-list", "--parents", ...revs], top, "listing the history", options)
  const found = new Map<string, string[]>()
  for (const line of out.split("\n")) {
    const [commit, ...of] = line.trim().split(" ")
    if (commit) found.set(commit, of)
  }
  return found
}

/**
 * The commits fewer than `depth` parent steps from `head` (its nearest path, as git's
 * own --depth counts), read off `rev-list --topo-order`, which lists no commit before
 * its children, so a commit's distance is settled when it comes. The walk stops as soon
 * as nothing still to come can be close enough.
 */
async function withinDepth(top: string, head: string, depth: number, options: SpawnOptions): Promise<Map<string, string[]>> {
  const kept = new Map<string, string[]>()
  const distance = new Map<string, number>([[head, 0]])
  const open = new Set([head])
  await streamLines(["--no-replace-objects", "rev-list", "--parents", "--topo-order", head], top, "walking the history", options, (line) => {
    const [commit, ...of] = line.trim().split(" ")
    if (!commit) return open.size > 0
    open.delete(commit)
    const steps = distance.get(commit)
    if (steps !== undefined && steps < depth) {
      kept.set(commit, of)
      for (const parent of of) {
        if (steps + 1 >= (distance.get(parent) ?? Number.POSITIVE_INFINITY)) continue
        distance.set(parent, steps + 1)
        if (steps + 1 < depth) open.add(parent)
      }
    }
    return open.size > 0
  })
  return kept
}

/** a git command's stdout line by line, until `onLine` says stop (the process is killed then) */
async function streamLines(args: string[], cwd: string, what: string, options: SpawnOptions, onLine: (line: string) => boolean): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", "-c", "core.fsmonitor=false", ...args],
    cwd,
    env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })
  const stderr = new Response(proc.stderr).text()
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let going = true
  while (going) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const parts = buffer.split("\n")
    buffer = done ? "" : parts.pop()!
    for (const line of parts) if (going && line) going = onLine(line)
    if (done) break
  }
  if (going) {
    const code = await proc.exited
    if (code !== 0) throw new HistoryError(`--git: ${what} failed: ${(await stderr).split("\n").find((line) => line.trim()) ?? `git exited ${code}`}`)
    return
  }
  proc.kill()
  await reader.cancel().catch(() => {})
  await proc.exited
}

/**
 * The backstop, both ways. The bundle is unpacked into a scratch repository. Every
 * commit in it, reachable or not, must be one of the selection, and every ref it
 * carries must name one of those or a staged blob. Then, with the shallow list the
 * sandbox gets, what the bundle's refs reach must be the whole selection: a commit
 * that would be missing there fails as loudly as one too many. Either way nothing goes
 * up. Returns how many commits it holds.
 */
export async function verifyBundle(
  bundle: string,
  selection: Pick<Selection, "commits" | "shallow">,
  blobs: Set<string>,
  options: { objectFormat: string; dir: string; signal?: AbortSignal },
): Promise<number> {
  const { commits } = selection
  const scratch = await mkdtemp(join(options.dir, "verify-"))
  const some = (ids: string[]) => `${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""}`
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`
  const refuse = (why: string) => new HistoryError(`--git: refusing to send the history: ${why}; nothing was uploaded`)
  try {
    const own = isolated(options.dir, options.signal)
    const format = options.objectFormat === "sha1" ? [] : [`--object-format=${options.objectFormat}`]
    await gitOut(["init", "--quiet", "--bare", "--template=", ...format, scratch], options.dir, "checking the bundle", own)
    const heads = await gitOut(["--git-dir", scratch, "bundle", "unbundle", bundle], options.dir, "checking the bundle", own)
    const objects = await gitOut(["--git-dir", scratch, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectname)"], options.dir, "checking the bundle", own)
    const held = objects.split("\n").filter((line) => line.startsWith("commit ")).map((line) => line.slice("commit ".length))
    const outside = held.filter((commit) => !commits.has(commit))
    const targets = heads
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .filter(Boolean)
    const strays = targets.filter((id) => !commits.has(id) && !blobs.has(id))
    const tags = objects.split("\n").filter((line) => line.startsWith("tag ")).length
    if (outside.length > 0 || strays.length > 0 || tags > 0) {
      const what = [
        outside.length > 0 ? `${count(outside.length, "commit")} outside the history asked for (${some(outside)})` : "",
        strays.length > 0 ? `refs to ${some(strays)}` : "",
        tags > 0 ? count(tags, "tag object") : "",
      ].filter(Boolean)
      throw refuse(`the bundle holds ${what.join(" and ")}`)
    }

    // the other way: the sandbox's view, its shallow list and all, must reach every commit asked for
    if (selection.shallow.length > 0) await writeFile(join(scratch, "shallow"), lines(selection.shallow))
    const tips = [...new Set(targets.filter((id) => commits.has(id)))]
    const listed = tips.length === 0 ? "" : await gitOut(["--git-dir", scratch, "rev-list", "--stdin"], options.dir, "checking the bundle", { ...own, stdin: lines(tips) })
    const reached = new Set(listed.split("\n").filter(Boolean))
    const missing = [...commits].filter((commit) => !reached.has(commit)).sort()
    if (missing.length > 0) throw refuse(`${count(missing.length, "commit")} of the history asked for would not be reachable in the sandbox (${some(missing)})`)
    return held.length
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** the listing with the history's files in it, still sorted, so shards and counts include them */
export function withHistory(listing: Listing, history: History): Listing {
  const entries = [...listing.entries, ...history.entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { ...listing, entries, bytes: listing.bytes + history.entries.reduce((sum, entry) => sum + entry.stats.size, 0) }
}

/**
 * Run in the sandbox, in the directory the tree went to, once the upload is in. A new
 * repository, then the bundle's objects into it (the shallow list first, so git knows
 * where the history stops), the refs, HEAD, `origin`, and the index: HEAD's, with what
 * is staged here staged there (the same blobs, so a partly staged file stays partly
 * staged), what was removed from it removed, skip-worktree set, and refreshed against
 * the tree that went up. `git status` and `git diff` then see the local changes and
 * untracked files as they are here. Whatever an earlier .git in that directory held
 * goes: a push with --git leaves exactly its own history.
 *
 * $1 object format, $2 HEAD's commit, $3 its branch or "", $4 origin's URL or ""; the
 * refs to set come as `commit ref` lines in $import/refs.
 */
const SETUP = `set -eu
format=$1 head=$2 branch=$3 origin=$4
shift 4
import=${IMPORT}
test -f "$import/history.bundle" || { echo "the history is not in $PWD/$import" >&2; exit 1; }
find .git -mindepth 1 -maxdepth 1 ! -name kyora-import -exec rm -rf {} +
if [ "$format" = sha1 ]; then set --; else set -- "--object-format=$format"; fi
git -c advice.defaultBranchName=false init --quiet --template= "$@" .
if [ -s "$import/shallow" ]; then cp "$import/shallow" .git/shallow; fi
git bundle unbundle "$import/history.bundle" >/dev/null
while read -r commit ref; do git update-ref "$ref" "$commit"; done <"$import/refs"
if [ -n "$branch" ]; then git symbolic-ref HEAD "$branch"; else git update-ref -m "checkout: moving from kyora-vms to $head" --no-deref HEAD "$head"; fi
if [ -n "$origin" ]; then git remote add origin "$origin"; fi
git read-tree HEAD
if [ -s "$import/index" ]; then git update-index -z --index-info <"$import/index"; fi
if [ -s "$import/unstage" ]; then git update-index -z --force-remove --stdin <"$import/unstage"; fi
if [ -s "$import/skip-worktree" ]; then git update-index -z --skip-worktree --stdin <"$import/skip-worktree"; fi
git update-index -q --refresh >/dev/null || true
rm -rf "$import"
`

export function setupRequest(history: History, cwd: string): ExecRequest {
  return {
    cmd: ["sh", "-c", SETUP, "kyora-vms-git", history.objectFormat, history.head, history.branch ?? "", history.origin ?? ""],
    cwd,
    // the sandbox user's own git config has no say in how .git is set up
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    timeoutSeconds: 20 * 60,
  }
}

/** after the upload: builds .git in the sandbox; throws with the setup's own words when it fails */
export async function installHistory(api: VmsClient, id: string, history: History, cwd: string, signal?: AbortSignal): Promise<number> {
  const started = Date.now()
  const request = setupRequest(history, cwd)
  // its own timeout, and the grace: a stream that never ends is given up on (dropping it kills the setup)
  const limit = AbortSignal.timeout(request.timeoutSeconds! * 1000 + timeoutGraceMs())
  let outcome: Awaited<ReturnType<typeof collectExec>>
  try {
    outcome = await collectExec(await api.exec(id, request, signal ? AbortSignal.any([signal, limit]) : limit))
  } catch (error) {
    if (signal?.aborted || !limit.aborted) throw error
    throw new Error(`--git: setting up ${cwd}/.git in the sandbox never finished; gave up on it ${formatMs(timeoutGraceMs())} after its ${formatMs(request.timeoutSeconds! * 1000)} timeout`)
  }
  // the command comes right after it: a sandbox still freeing this exec's slot is waited out
  if (outcome.exit) api.execExited(id)
  if (outcome.code !== 0) {
    const said = outcome.error ?? outcome.stderr.trim().split("\n").slice(-3).join(" / ")
    throw new Error(`--git: setting up ${cwd}/.git in the sandbox failed (exit ${outcome.code})${said ? `: ${said}` : ""}`)
  }
  return Date.now() - started
}

/** a 413 with history in the upload says how much of it that was */
export function historyHint(error: unknown, history: History | null): string | null {
  if (!history || !(error instanceof ApiError) || error.status !== 413) return null
  return `the upload carried ${formatBytes(history.bytes)} of git history (--git); --git-depth N or --git-base REF send less`
}

/** "812 KB (37 commits, shallow)" */
export function describeHistory(history: History): string {
  return `${formatBytes(history.bytes)} (${history.commits.toLocaleString("en-US")} commit${history.commits === 1 ? "" : "s"}${history.shallow ? ", shallow" : ""})`
}

