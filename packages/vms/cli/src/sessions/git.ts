import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { git, type SpawnOptions } from "../pack"

/**
 * A session's history lives on its own branch, `kyora/<name>`. Going up, the working tree as it
 * is (staged or not, untracked files .gitignore doesn't exclude included) becomes one commit on
 * top of HEAD, made through a throwaway index so the user's own index and files are never
 * touched. Coming back, the VM's commits on that branch are fetched from a bundle, and only that
 * branch is ever moved, and only forward: the user's checked-out branch and main are never.
 */

export class SessionGitError extends Error {}

/** files that never go up untracked (Claude Code's personal settings) */
export const PERSONAL_FILE = /(^|\/)\.claude\/settings\.local\.json$/

/** git with no hooks of the user's (reference-transaction runs on update-ref) and no prompts */
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", "-c", "commit.gpgSign=false"]

async function run(args: string[], cwd: string, what: string, options?: SpawnOptions): Promise<string> {
  const result = await git([...QUIET, ...args], cwd, options)
  if (!result.ok) throw new SessionGitError(`${what}: ${result.stderr.split("\n").find((line) => line.trim()) ?? `git ${args[0]} failed`}`)
  return result.stdout
}

/** variables that would send git somewhere other than the repo at hand */
const REDIRECTS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"])

export const branchRef = (name: string): string => `refs/heads/kyora/${name}`
/** where `down` leaves the VM's tip when it can't move the branch: diverged, or checked out somewhere */
export const remoteRef = (name: string): string => `refs/kyora/${name}-remote`

/** a session name as it goes into a branch: what git check-ref-format takes, kept short and plain */
export const SESSION_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/

export async function repoTop(dir: string): Promise<string> {
  return (await run(["rev-parse", "--show-toplevel"], dir, `${dir} is not in a git repository`)).trim()
}

export async function revParse(top: string, rev: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], top)
  return result.ok ? result.stdout.trim() || null : null
}

export interface Snapshot {
  /** the commit holding the working tree */
  commit: string
  /** HEAD it sits on; null in a repo without commits */
  parent: string | null
  tree: string
  /** whether it differs from HEAD at all */
  changed: boolean
}

/** whoever the repo says commits; a fallback when nobody configured one, so commit-tree can't fail on that */
async function identityEnv(top: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [kind, prefix] of [["GIT_AUTHOR_IDENT", "GIT_AUTHOR"], ["GIT_COMMITTER_IDENT", "GIT_COMMITTER"]] as const) {
    if ((await git(["var", kind], top)).ok) continue
    env[`${prefix}_NAME`] = "kyora session"
    env[`${prefix}_EMAIL`] = "session@kyora.invalid"
  }
  return env
}

/**
 * The working tree as a commit on top of HEAD, like `git stash create` but with untracked files
 * (not ignored ones, nor the untracked paths in `leaveOut`) in it too. The index it is built in is a copy of the user's, in a temp dir
 * (the copy only saves re-hashing unchanged files); the user's index, files and refs stay as
 * they were. The commit's objects land in the repo's object store, nothing else does.
 */
export async function snapshotWorktree(top: string, message: string, leaveOut: string[] = []): Promise<Snapshot> {
  const tmp = await mkdtemp(join(tmpdir(), "kyora-session-index-"))
  try {
    const index = join(tmp, "index")
    const real = resolve(top, (await run(["rev-parse", "--git-path", "index"], top, "finding the index")).trim())
    await copyFile(real, index).catch(() => {})
    const parent = await revParse(top, "HEAD")
    const env: Record<string, string | undefined> = {}
    // nothing pointing git at another repository or index than the throwaway one
    for (const [key, value] of Object.entries(process.env)) if (!REDIRECTS.has(key)) env[key] = value
    const options: SpawnOptions = { env: { ...env, GIT_INDEX_FILE: index, ...(await identityEnv(top)) } }
    // `add --all` records what changed, what's new and what's gone; skip-worktree entries (a sparse
    // checkout) keep what the index has, so paths outside the sparse cone don't count as deleted
    // except what is named to stay here (untracked personal settings), exactly those paths: a tracked file is never one
    await run(["add", "--all", "--", ":/", ...leaveOut.map((path) => `:(top,exclude,literal)${path}`)], top, "adding the working tree", options)
    const tree = (await run(["write-tree"], top, "writing the tree", options)).trim()
    const headTree = parent ? (await run(["rev-parse", `${parent}^{tree}`], top, "reading HEAD's tree")).trim() : null
    const commit = (await run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], top, "committing the working tree", options)).trim()
    return { commit, parent, tree, changed: tree !== headTree }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** creates refs/heads/kyora/<name> at `commit`; refuses one that exists */
export async function createBranch(top: string, name: string, commit: string): Promise<string> {
  const ref = branchRef(name)
  // the empty old value makes update-ref refuse a ref that is already there
  await run(["update-ref", "-m", `kyora session ${name}: snapshot of the working tree`, ref, commit, ""], top, `creating ${ref.slice("refs/heads/".length)} (it may exist already)`)
  return ref
}

/** deletes the branch only while it still points where we put it */
export async function deleteBranch(top: string, name: string, commit: string): Promise<boolean> {
  return (await git([...QUIET, "update-ref", "-d", branchRef(name), commit], top)).ok
}

/** every branch some worktree of this repo has checked out (moving one would leave that worktree dirty) */
export async function checkedOut(top: string): Promise<Set<string>> {
  const out = await run(["worktree", "list", "--porcelain"], top, "listing worktrees")
  return new Set(out.split("\n").filter((line) => line.startsWith("branch ")).map((line) => line.slice("branch ".length).trim()))
}

export type ImportOutcome =
  /** the VM made no commits since the last sync */
  | { kind: "unchanged"; ref: string; commit: string }
  /** kyora/<name> moved forward to the VM's tip */
  | { kind: "fast-forward"; ref: string; from: string; commit: string; commits: number }
  /** kyora/<name> was moved here meanwhile (or is checked out): the VM's tip waits in refs/kyora/<name>-remote */
  | { kind: "kept-remote"; ref: string; branch: string; commit: string; commits: number; reason: "diverged" | "checked-out" }

/** the ref the VM's supervisor makes its checkpoints on (remote.ts CHECKPOINT_REF), which its export's bundle carries */
export const CHECKPOINT_REF = "refs/kyora/checkpoint"

/**
 * Takes the VM's work out of a bundle and decides where it goes: its checkpoint (the VM's
 * kyora/<name> plus whatever wasn't committed yet), or the branch itself from a bundle of an
 * older supervisor. Fetched into refs/kyora/<name>-remote first (objects only, no hooks); then
 * kyora/<name> is fast-forwarded when it is still an ancestor of that tip and no worktree has it
 * checked out. Otherwise the branch stays, and the tip stays under refs/kyora/<name>-remote for
 * the user to merge.
 */
export async function importBundle(top: string, bundle: string, name: string): Promise<ImportOutcome> {
  const branch = branchRef(name)
  const holding = remoteRef(name)
  const heads = (await run(["bundle", "list-heads", bundle], top, "reading the session's bundle")).split("\n").map((line) => line.split(" ")[1])
  const source = heads.includes(CHECKPOINT_REF) ? CHECKPOINT_REF : branch
  await run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundle, `+${source}:${holding}`], top, "fetching the session's commits from the bundle")
  const tip = (await revParse(top, holding))!
  const local = await revParse(top, branch)
  const count = async (from: string | null) => Number((await run(["rev-list", "--count", from ? `${from}..${tip}` : tip], top, "counting commits")).trim())
  if (local === tip) {
    await git([...QUIET, "update-ref", "-d", holding, tip], top)
    return { kind: "unchanged", ref: branch, commit: tip }
  }
  const forward = local === null || (await git(["merge-base", "--is-ancestor", local, tip], top)).ok
  const busy = (await checkedOut(top)).has(branch)
  if (forward && !busy) {
    const commits = await count(local)
    // compare-and-swap: a branch moved between the check and here is left alone
    await run(["update-ref", "-m", `kyora session ${name}: fast-forward to the VM's commits`, branch, tip, local ?? ""], top, `moving ${branch.slice("refs/heads/".length)}`)
    await git([...QUIET, "update-ref", "-d", holding, tip], top)
    return { kind: "fast-forward", ref: branch, from: local ?? "", commit: tip, commits }
  }
  return { kind: "kept-remote", ref: holding, branch, commit: tip, commits: await count(local), reason: busy && forward ? "checked-out" : "diverged" }
}

/** what to tell the user once the commits are in */
export function describeImport(outcome: ImportOutcome, name: string): string {
  const short = (sha: string) => sha.slice(0, 12)
  const plural = (n: number) => `${n} commit${n === 1 ? "" : "s"}`
  switch (outcome.kind) {
    case "unchanged":
      return `kyora/${name}: no new commits (at ${short(outcome.commit)})`
    case "fast-forward":
      return `kyora/${name}: fast-forwarded ${plural(outcome.commits)} to ${short(outcome.commit)}`
    case "kept-remote": {
      const why =
        outcome.reason === "checked-out"
          ? `kyora/${name} is checked out, so it was left alone`
          : `kyora/${name} has commits the VM doesn't`
      return `${why}; the VM's ${plural(outcome.commits)} are at ${outcome.ref} (${short(outcome.commit)}). Merge them with: git merge ${outcome.ref}`
    }
  }
}
