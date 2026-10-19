import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanRemoteUrl, gitMax, GIT_MAX, IMPORT, prepareHistory, verifyBundle, withHistory, type History } from "./history"
import { listFiles, tarStream } from "./pack"
import { planShards } from "./shard"
import { readTar } from "./tar"
import { KEY, startFakePlatform, startFakeVmd, TOKEN, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, GIT_ENV, platformEnv, sh, tempDir, transcripts, write } from "./testing/fixtures"

// each test runs git and the CLI for real, several times
setDefaultTimeout(60_000)

/** what a careless .git holds: every one must stay on this machine */
const SECRETS = {
  token: "ghp_T0kenInTheRemoteUrl0000000000000000",
  header: "hdr-SECRET-4f2a91c0",
  scopedHeader: "scoped-hdr-SECRET-7e11",
  helper: "helper-SECRET-9b1c33",
  insteadOf: "insteadof-SECRET-77aa20",
  ssh: "sshkey-SECRET-3e3e55",
  include: "include-SECRET-5d5d66",
  hook: "hook-SECRET-6c6c77",
  module: "module-SECRET-8a8a88",
  lfs: "lfs-SECRET-1f1f99",
  worktree: "worktree-SECRET-0b0b11",
  env: "dotenv-SECRET-2b2b22",
}
const secretValues = Object.values(SECRETS)

let root: string
let vmd: FakeVmd

beforeEach(async () => {
  root = await tempDir("history")
  vmd = await startFakeVmd()
})

afterEach(async () => {
  await vmd.stop()
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  expect(transcripts.length).toBeGreaterThan(0)
  for (const text of transcripts) {
    for (const secret of [KEY, TOKEN, ...secretValues]) expect(text).not.toContain(secret)
  }
})

const env = (extra: Record<string, string | undefined> = {}) => baseEnv(vmd.url, extra)

/** stdout of a command as it is, trailing newline and all */
function run(cmd: string[], cwd: string, extra: Record<string, string> = {}): string {
  const result = Bun.spawnSync(cmd, { cwd, env: { ...GIT_ENV, ...extra }, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/**
 * main: m1..m4; feature (checked out) branches off m3 with f1, f2; main then gets m5.
 * The config and .git carry every kind of secret, and the worktree every kind of
 * change git status tells apart.
 */
async function makeHistoryRepo(parent: string): Promise<string> {
  const repo = join(parent, "hist")
  await mkdir(repo, { recursive: true })
  sh(["git", "init", "--quiet", "-b", "main"], repo)
  await write(repo, ".gitignore", ".env\ntarget/\n")
  for (let i = 1; i <= 4; i++) {
    await write(repo, `src/m${i}.txt`, `main ${i}\n`)
    await write(repo, "src/shared.txt", `${"shared\n".repeat(i)}`)
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "--quiet", "-m", `m${i}`], repo)
  }
  sh(["git", "checkout", "--quiet", "-b", "feature", "HEAD~1"], repo)
  for (let i = 1; i <= 2; i++) {
    await write(repo, `feature${i}.txt`, `feature ${i}\n`)
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "--quiet", "-m", `f${i}`], repo)
  }
  sh(["git", "checkout", "--quiet", "main"], repo)
  await write(repo, "src/m5.txt", "main 5\n")
  sh(["git", "add", "-A"], repo)
  sh(["git", "commit", "--quiet", "-m", "m5"], repo)
  sh(["git", "checkout", "--quiet", "feature"], repo)
  sh(["git", "update-ref", "refs/remotes/origin/main", "main"], repo)
  sh(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo)

  const config = (key: string, value: string) => sh(["git", "config", key, value], repo)
  config("remote.origin.url", `https://x-access-token:${SECRETS.token}@github.com/acme/widgets.git`)
  config("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
  config("http.extraheader", `Authorization: Bearer ${SECRETS.header}`)
  config("http.https://github.com/.extraheader", `AUTHORIZATION: basic ${SECRETS.scopedHeader}`)
  config("credential.helper", `!f() { echo password=${SECRETS.helper}; }; f`)
  config(`url.https://${SECRETS.insteadOf}@github.com/.insteadOf`, "https://github.com/")
  config("core.sshCommand", `ssh -i /keys/${SECRETS.ssh}`)
  await write(repo, ".git/secret.inc", `[user]\n\tsigningkey = ${SECRETS.include}\n`)
  config("include.path", "secret.inc")
  await write(repo, ".git/hooks/pre-push", `#!/bin/sh\necho ${SECRETS.hook}\n`, 0o755)
  await write(repo, ".git/modules/vendored/config", `[http]\n\textraheader = X-Token: ${SECRETS.module}\n`)
  await write(repo, `.git/lfs/objects/ab/cd/abcd${"0".repeat(60)}`, `${SECRETS.lfs}\n`)
  await write(repo, ".env", `API_KEY=${SECRETS.env}\n`)

  // one of each: modified, untracked, staged new (with a name pathspecs would misread),
  // staged modified, staged and then edited again, staged deletion, deleted in the worktree only
  await write(repo, "src/m1.txt", "main 1, edited here\n")
  await write(repo, "notes/todo.txt", "untracked\n")
  await write(repo, "staged [x]*.txt", "staged new\n")
  await write(repo, "src/m2.txt", "main 2, staged edit\n")
  await write(repo, "src/shared.txt", "shared, staged\n")
  sh(["git", "add", "--", "staged [x]*.txt", "src/m2.txt", "src/shared.txt"], repo)
  await write(repo, "src/shared.txt", "shared, staged\nand then edited\n")
  sh(["git", "rm", "--quiet", "src/m3.txt"], repo)
  await rm(join(repo, "feature1.txt"))
  return repo
}

/** git's view, printed in sections, the same way here and in the sandbox */
const VIEW = [
  "echo '== status'; git status --porcelain=v1 --untracked-files=all",
  "echo '== diff HEAD'; git diff HEAD",
  "echo '== unstaged'; git diff",
  "echo '== staged'; git diff --cached",
  "echo '== head'; git rev-parse HEAD; git symbolic-ref -q HEAD || echo detached",
].join("; ")
const BASE_VIEW = [
  VIEW,
  "echo '== diff base'; git diff origin/main",
  "echo '== three dots'; git diff origin/main...HEAD",
  "echo '== log'; git log --format='%H %s' origin/main..HEAD",
  "echo '== merge base'; git merge-base origin/main HEAD",
].join("; ")

/** every byte of every file under dir, and every object git can read there, as one string */
async function everything(dir: string): Promise<string> {
  const parts: string[] = []
  const walk = async (path: string) => {
    for (const name of await readdir(path)) {
      const abs = join(path, name)
      const stats = await lstat(abs)
      if (stats.isDirectory()) await walk(abs)
      else if (stats.isFile()) parts.push(await readFile(abs, "latin1"))
    }
  }
  await walk(dir)
  if (await lstat(join(dir, ".git")).catch(() => null)) parts.push(run(["git", "cat-file", "--batch-all-objects", "--batch"], dir))
  return parts.join("\n")
}

function expectNoSecrets(text: string): void {
  for (const secret of secretValues) expect(text).not.toContain(secret)
}

describe("cleanRemoteUrl", () => {
  test("takes credentials, queries and fragments out, and keeps only transports that name a server", () => {
    const cases: [string, string | null][] = [
      [`https://x-access-token:${SECRETS.token}@github.com/acme/widgets.git`, "https://github.com/acme/widgets.git"],
      [`https://${SECRETS.token}@github.com/acme/widgets.git`, "https://github.com/acme/widgets.git"],
      [`https://github.com/acme/widgets.git?access_token=${SECRETS.token}#frag`, "https://github.com/acme/widgets.git"],
      ["http://localhost:8080/r.git", "http://localhost:8080/r.git"],
      ["ssh://git@github.com:2222/acme/widgets.git", "ssh://git@github.com:2222/acme/widgets.git"],
      [`ssh://deploy:${SECRETS.token}@git.example.com/w.git`, "ssh://git.example.com/w.git"],
      ["git://git.example.com/w.git", "git://git.example.com/w.git"],
      ["git@github.com:acme/widgets.git", "git@github.com:acme/widgets.git"],
      [`${SECRETS.token}@github.com:acme/widgets.git`, "github.com:acme/widgets.git"],
      ["gitlab.example.com:group/w.git", "gitlab.example.com:group/w.git"],
      // what git would read as host "user", with the token in the path: an @ left over means no origin
      [`user:${SECRETS.token}@github.com:acme/widgets.git`, null],
      [`https://github.com/${SECRETS.token}@acme/widgets.git`, null],
      ["/Users/me/src/widgets", null],
      ["./widgets", null],
      ["../widgets", null],
      ["file:///Users/me/src/widgets", null],
      [`ext::ssh -i ${SECRETS.ssh} host %S 'repo'`, null],
      ["fd::17", null],
      ["https://github.com/acme/w .git", null],
      ["", null],
    ]
    for (const [raw, clean] of cases) expect([raw, cleanRemoteUrl(raw)]).toEqual([raw, clean])
  })
})

describe("gitMax", () => {
  test("1 GiB unless KYORA_VMS_GIT_MAX says otherwise", () => {
    expect(gitMax({})).toBe(GIT_MAX)
    expect(gitMax({ KYORA_VMS_GIT_MAX: "200M" })).toBe(200 * 1024 ** 2)
    expect(gitMax({ KYORA_VMS_GIT_MAX: "2" })).toBe(2 * 1024 ** 3)
    expect(() => gitMax({ KYORA_VMS_GIT_MAX: "lots" })).toThrow("KYORA_VMS_GIT_MAX")
  })
})

describe("prepareHistory", () => {
  test("the archive carries the tree and a bundle, and nothing of .git's config, hooks, modules or LFS", async () => {
    const repo = await makeHistoryRepo(root)
    const listing = await listFiles(repo)
    const history = await prepareHistory(repo, listing, { maxBytes: GIT_MAX })
    try {
      const merged = withHistory(listing, history)
      // every one of them every time, empty or not
      expect(merged.entries.filter((entry) => entry.rel.startsWith(".git/")).map((entry) => entry.rel)).toEqual(
        ["history.bundle", "index", "refs", "shallow", "skip-worktree", "unstage"].map((name) => `${IMPORT}/${name}`),
      )
      expect(merged.bytes).toBe(listing.bytes + history.entries.reduce((sum, entry) => sum + entry.stats.size, 0))

      // the archive as it goes up, read back entry by entry
      const names: string[] = []
      const bytes: Uint8Array[] = []
      for await (const item of readTar(tarStream(merged.entries, () => {}))) {
        names.push(item.entry.name)
        for await (const chunk of item.body()) bytes.push(chunk)
      }
      expect(names.filter((name) => name.startsWith(".git"))).toEqual(merged.entries.filter((entry) => entry.rel.startsWith(".git")).map((entry) => entry.rel))
      expect(names).not.toContain(".env")
      const raw = Buffer.concat(bytes).toString("latin1")
      expectNoSecrets(raw)
      expect(raw).not.toContain("x-access-token")

      // and what the bundle holds, every object of it
      const scratch = join(root, "scratch")
      await mkdir(scratch)
      sh(["git", "init", "--quiet", "--bare", scratch])
      sh(["git", "bundle", "unbundle", join(history.entries[0]!.abs)], scratch)
      expectNoSecrets(run(["git", "cat-file", "--batch-all-objects", "--batch"], scratch))
      // with the staged blobs, which no commit has
      const blob = (path: string) => sh(["git", "rev-parse", `:${path}`], repo)
      for (const path of ["src/m2.txt", "src/shared.txt", "staged [x]*.txt"]) expect(sh(["git", "cat-file", "-t", blob(path)], scratch)).toBe("blob")

      expect(history).toMatchObject({
        branch: "refs/heads/feature",
        base: null,
        origin: "https://github.com/acme/widgets.git",
        objectFormat: "sha1",
        // m1..m3, f1, f2: all of HEAD's history and nothing of main's m4, m5
        commits: 5,
        shallow: false,
        staged: 4,
      })
      expect(history.head).toBe(sh(["git", "rev-parse", "HEAD"], repo))
      const file = (name: string) => readFile(history.entries.find((entry) => entry.rel === `${IMPORT}/${name}`)!.abs, "utf8")
      expect(await file("index")).toBe(["src/m2.txt", "src/shared.txt", "staged [x]*.txt"].map((path) => `100644 ${blob(path)}\t${path}\0`).join(""))
      expect(await file("unstage")).toBe("src/m3.txt\0")
      expect(await file("refs")).toBe(`${history.head} refs/heads/feature\n`)
      expect(await file("shallow")).toBe("")
      expect(await file("skip-worktree")).toBe("")
    } finally {
      await history.cleanup()
    }
    expect(await lstat(join(history.entries[0]!.abs)).catch(() => null)).toBeNull()
  })

  test("a big bundle goes up as a shard of its own", async () => {
    const repo = await makeHistoryRepo(root)
    const listing = await listFiles(repo)
    const history = await prepareHistory(repo, listing, { maxBytes: GIT_MAX })
    try {
      const shards = planShards(withHistory(listing, history).entries, 64)
      const bundle = shards.find((shard) => shard.entries.some((entry) => entry.rel.endsWith("history.bundle")))!
      expect(bundle.entries.map((entry) => entry.rel)).toEqual([`${IMPORT}/history.bundle`])
    } finally {
      await history.cleanup()
    }
  })

  test("--git-depth and --git-base bound the history; the shallow list goes along", async () => {
    const repo = await makeHistoryRepo(root)
    const listing = await listFiles(repo)
    const shallowList = async (options: { depth?: number; base?: string }) => {
      const history = await prepareHistory(repo, listing, { maxBytes: GIT_MAX, ...options })
      try {
        const shallow = history.entries.find((entry) => entry.rel.endsWith("/shallow"))
        return { commits: history.commits, shallow: history.shallow, list: (await readFile(shallow!.abs, "utf8")).split("\n").filter(Boolean), base: history.base }
      } finally {
        await history.cleanup()
      }
    }
    const m3 = sh(["git", "rev-parse", "main~2"], repo)
    expect(await shallowList({ depth: 1 })).toMatchObject({ commits: 1, shallow: true, list: [sh(["git", "rev-parse", "HEAD"], repo)] })
    expect(await shallowList({ depth: 2 })).toMatchObject({ commits: 2, shallow: true })
    // f1, f2, m4, m5 and the merge base m3, where it stops: nothing of m1, m2
    expect(await shallowList({ base: "origin/main" })).toEqual({
      commits: 5,
      shallow: true,
      list: [m3],
      base: { rev: "origin/main", sha: sh(["git", "rev-parse", "main"], repo), ref: "refs/remotes/origin/main" },
    })
    // origin/HEAD is where it points; a commit id has no name, so it gets one
    expect((await shallowList({ base: "origin/HEAD" })).base!.ref).toBe("refs/remotes/origin/main")
    expect((await shallowList({ base: m3 })).base!.ref).toBe("refs/kyora/base")
    // at least N of HEAD's, with a base
    expect((await shallowList({ base: "origin/main", depth: 4 })).commits).toBe(6)
    // deeper than the history: all of it, not shallow
    expect(await shallowList({ depth: 50 })).toMatchObject({ commits: 5, shallow: false, list: [] })
  })

  test("refuses what it cannot send, before anything else", async () => {
    const repo = await makeHistoryRepo(root)
    const listing = await listFiles(repo)
    await expect(prepareHistory(join(repo, "src"), await listFiles(join(repo, "src")), { maxBytes: GIT_MAX })).rejects.toThrow("must be the repo's top level")
    await expect(prepareHistory(repo, listing, { maxBytes: GIT_MAX, base: "nope/nope" })).rejects.toThrow("--git-base nope/nope: not a commit")
    await expect(prepareHistory(repo, listing, { maxBytes: 64 })).rejects.toThrow(/--git: (HEAD's history is about|the history of HEAD is) \S+ \S+, over the 64 B --git sends/)

    const empty = join(root, "empty")
    await mkdir(empty)
    sh(["git", "init", "--quiet", empty])
    await write(empty, "a.txt", "a\n")
    await expect(prepareHistory(empty, await listFiles(empty), { maxBytes: GIT_MAX })).rejects.toThrow("has no commits yet")

    const plain = join(root, "plain")
    await write(plain, "a.txt", "a\n")
    await expect(prepareHistory(plain, await listFiles(plain), { maxBytes: GIT_MAX })).rejects.toThrow("is not in a git repo")
  })
})

/** the commits in a history's bundle, every one of them (reachable or not), and all its objects' contents */
async function bundled(history: History): Promise<{ commits: string[]; contents: string }> {
  const scratch = await tempDir("bundled")
  try {
    sh(["git", "init", "--quiet", "--bare", scratch])
    sh(["git", "bundle", "unbundle", history.entries.find((entry) => entry.rel.endsWith("history.bundle"))!.abs], scratch)
    const objects = run(["git", "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectname)"], scratch)
    const commits = objects.split("\n").filter((line) => line.startsWith("commit ")).map((line) => line.slice("commit ".length))
    return { commits: commits.sort(), contents: run(["git", "cat-file", "--batch-all-objects", "--batch"], scratch) }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** subject → commit, for every commit in the repo */
const commitsBySubject = (repo: string) => Object.fromEntries(sh(["git", "log", "--all", "--format=%s %H"], repo).split("\n").map((line) => [line.slice(0, line.lastIndexOf(" ")), line.slice(line.lastIndexOf(" ") + 1)]))

const OLD_SECRET = "committed-then-deleted-SECRET-9f9f"

/** r1 commits a secret, B deletes it and is main: whatever branches off B must not carry r1 along */
async function baseRepo(parent: string): Promise<string> {
  const repo = join(parent, "graph")
  await mkdir(repo, { recursive: true })
  sh(["git", "init", "--quiet", "-b", "main"], repo)
  await write(repo, "app.txt", "app\n")
  await write(repo, "old.env", `TOKEN=${OLD_SECRET}\n`)
  sh(["git", "add", "-A"], repo)
  sh(["git", "commit", "--quiet", "-m", "r1"], repo)
  sh(["git", "rm", "--quiet", "old.env"], repo)
  sh(["git", "commit", "--quiet", "-m", "B"], repo)
  return repo
}

async function commitOn(repo: string, branch: string, from: string, subject: string): Promise<void> {
  sh(["git", "checkout", "--quiet", "-B", branch, from], repo)
  await write(repo, `${subject}.txt`, `${subject}\n`)
  sh(["git", "add", "-A"], repo)
  sh(["git", "commit", "--quiet", "-m", subject], repo)
}

describe("--git-base keeps to its boundary in a merge graph", () => {
  const bounded = async (repo: string, base: string, allowed: string[]) => {
    const history = await prepareHistory(repo, await listFiles(repo), { maxBytes: GIT_MAX, base })
    try {
      const { commits, contents } = await bundled(history)
      const names = commitsBySubject(repo)
      expect(commits).toEqual(allowed.map((subject) => names[subject]!).sort())
      expect(history.commits).toBe(allowed.length)
      expect(contents).not.toContain(OLD_SECRET)
      return history
    } finally {
      await history.cleanup()
    }
  }

  test("HEAD merges two one-commit branches off the base: the base's parent stays home", async () => {
    // three commits in B..HEAD, but B is only two parent steps away: a depth of 4 would reach r1
    const repo = await baseRepo(root)
    await commitOn(repo, "a", "main", "a1")
    await commitOn(repo, "b", "main", "b1")
    sh(["git", "checkout", "--quiet", "a"], repo)
    sh(["git", "merge", "--quiet", "--no-ff", "-m", "merge", "b"], repo)
    const history = await bounded(repo, "main", ["merge", "a1", "b1", "B"])
    expect(history.shallow).toBe(true)
  })

  test("an octopus merge off the base", async () => {
    const repo = await baseRepo(root)
    for (const name of ["o1", "o2", "o3"]) await commitOn(repo, name, "main", name)
    sh(["git", "checkout", "--quiet", "-b", "head", "main"], repo)
    sh(["git", "merge", "--quiet", "--no-ff", "-m", "octopus", "o1", "o2", "o3"], repo)
    await bounded(repo, "main", ["octopus", "o1", "o2", "o3", "B"])
  })

  test("criss-cross merges: both merge bases, and nothing below them", async () => {
    const repo = await baseRepo(root)
    await commitOn(repo, "x", "main", "x1")
    await commitOn(repo, "y", "main", "y1")
    const names = commitsBySubject(repo)
    sh(["git", "checkout", "--quiet", "x"], repo)
    sh(["git", "merge", "--quiet", "--no-ff", "-m", "x2", "y"], repo)
    sh(["git", "checkout", "--quiet", "y"], repo)
    sh(["git", "merge", "--quiet", "--no-ff", "-m", "y2", names.x1!], repo)
    await commitOn(repo, "y", "y", "y3")
    await commitOn(repo, "x", "x", "x3")
    expect(sh(["git", "merge-base", "--all", "x", "y"], repo).split("\n").sort()).toEqual([names.x1!, names.y1!].sort())
    await bounded(repo, "y", ["x3", "x2", "x1", "y1", "y2", "y3"])

    // and in the sandbox, git finds the same two merge bases and the same three-dot diff
    const view = "git merge-base --all y HEAD | sort; git diff y...HEAD; git log --format=%s y..HEAD"
    const result = await cli(["run", "--git-base", "y", "--", "sh", "-c", view], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(run(["sh", "-c", view], repo))
  })
})

describe("--git-base refuses a cut git cannot make", () => {
  /**
   * main: root, M1 (commits a secret), M2 (deletes it), base. The feature branches at
   * root: F1, then F2 = merge(F1, M1) unless `once`, then H = merge(F2 or F1, M2). The
   * merge base with main is M2; F2 keeps F1 and would cut M1, which git cannot do.
   */
  async function repeatedMerges(parent: string, once = false): Promise<{ repo: string; names: Record<string, string> }> {
    const repo = join(parent, "merges")
    await mkdir(repo)
    sh(["git", "init", "--quiet", "-b", "main"], repo)
    await write(repo, "root.txt", "root\n")
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "--quiet", "-m", "root"], repo)
    await commitOn(repo, "main", "main", "M1")
    await write(repo, "old.env", `TOKEN=${OLD_SECRET}\n`)
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "--quiet", "--amend", "--no-edit"], repo)
    sh(["git", "rm", "--quiet", "old.env"], repo)
    await commitOn(repo, "main", "main", "M2")
    await commitOn(repo, "main", "main", "base")
    const names = commitsBySubject(repo)
    await commitOn(repo, "feature", names.root!, "F1")
    if (!once) sh(["git", "merge", "--quiet", "--no-ff", "-m", "F2", names.M1!], repo)
    sh(["git", "merge", "--quiet", "--no-ff", "-m", "H", names.M2!], repo)
    return { repo, names: commitsBySubject(repo) }
  }

  const short = (id: string) => id.slice(0, 12)

  test("a merge of something older than the merge base, with history behind it: refused, naming the commit and what to do", async () => {
    const { repo, names } = await repeatedMerges(root)
    const message = [
      `--git-base main: ${short(names.F2!)} merges ${short(names.M1!)}, which is older than where HEAD and main meet`,
      `git cannot cut off one parent of a commit and keep the other, so ${short(names.F1!)} would go missing`,
      "Add --git-depth 3 to send HEAD's last 3 steps as well (older commits along with them), or send all of HEAD's history with --git",
    ]
    const refused = prepareHistory(repo, await listFiles(repo), { maxBytes: GIT_MAX, base: "main" })
    for (const part of message) await expect(refused).rejects.toThrow(part)

    const result = await cli(["run", "--git-base", "main", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain(message[0]!)
    expect(vmd.created).toHaveLength(0)
  })

  test("with the --git-depth it suggests, all of the range goes up", async () => {
    const { repo, names } = await repeatedMerges(root)
    const history = await prepareHistory(repo, await listFiles(repo), { maxBytes: GIT_MAX, base: "main", depth: 3 })
    try {
      expect((await bundled(history)).commits).toEqual(["H", "F2", "F1", "M2", "M1", "base"].map((subject) => names[subject]!).sort())
    } finally {
      await history.cleanup()
    }
    const view = "git log --format=%s main..HEAD; git merge-base main HEAD"
    const result = await cli(["run", "--git-base", "main", "--git-depth", "3", "--", "sh", "-c", view], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(run(["sh", "-c", view], repo))
    expect(result.stdout).toContain("F1\n")
  })

  test("a single merge of the base's side, no parent cut in two: goes up, and nothing older", async () => {
    const { repo, names } = await repeatedMerges(root, true)
    const history = await prepareHistory(repo, await listFiles(repo), { maxBytes: GIT_MAX, base: "main" })
    try {
      const { commits, contents } = await bundled(history)
      expect(commits).toEqual(["H", "F1", "M2", "base"].map((subject) => names[subject]!).sort())
      expect(contents).not.toContain(OLD_SECRET)
    } finally {
      await history.cleanup()
    }
    const view = "git log --format=%s main..HEAD; git diff main...HEAD --stat"
    const result = await cli(["run", "--git-base", "main", "--", "sh", "-c", view], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(run(["sh", "-c", view], repo))
    expect(result.stdout).toStartWith("H\nF1\n")
  })
})

describe("a shallow checkout as the source", () => {
  /** main m1..m6, feature (checked out) with f1, f2 off m4; cloned --depth 3, every branch */
  async function shallowClone(parent: string): Promise<string> {
    const source = join(parent, "source")
    await mkdir(source)
    sh(["git", "init", "--quiet", "-b", "main"], source)
    for (let i = 1; i <= 6; i++) {
      await write(source, `m${i}.txt`, `m${i}\n`)
      sh(["git", "add", "-A"], source)
      sh(["git", "commit", "--quiet", "-m", `m${i}`], source)
    }
    for (const name of ["f1", "f2"]) await commitOn(source, "feature", name === "f1" ? "main~2" : "feature", name)
    sh(["git", "checkout", "--quiet", "main"], source)
    const clone = join(parent, "clone")
    sh(["git", "clone", "--quiet", "--depth", "3", "--no-single-branch", `file://${source}`, clone])
    sh(["git", "checkout", "--quiet", "feature"], clone)
    await write(clone, "m1.txt", "not in the clone's history\n")
    expect(sh(["git", "rev-parse", "--is-shallow-repository"], clone)).toBe("true")
    return clone
  }

  const prepared = async (clone: string, options: { depth?: number; base?: string }) => {
    const history = await prepareHistory(clone, await listFiles(clone), { maxBytes: GIT_MAX, ...options })
    try {
      const names = commitsBySubject(clone)
      const shallowFile = await readFile(history.entries.find((entry) => entry.rel.endsWith("/shallow"))!.abs, "utf8")
      const subjects = (ids: string[]) => ids.map((id) => Object.keys(names).find((subject) => names[subject] === id)).sort()
      return { commits: subjects((await bundled(history)).commits), shallow: subjects(shallowFile.split("\n").filter(Boolean)) }
    } finally {
      await history.cleanup()
    }
  }

  test("--git, --git-depth and --git-base stop where the clone does, or sooner", async () => {
    const clone = await shallowClone(root)
    // the clone has f2, f1, m4 of feature's history, cut at m4
    expect(await prepared(clone, {})).toEqual({ commits: ["f1", "f2", "m4"], shallow: ["m4"] })
    expect(await prepared(clone, { depth: 2 })).toEqual({ commits: ["f1", "f2"], shallow: ["f1"] })
    expect(await prepared(clone, { depth: 10 })).toEqual({ commits: ["f1", "f2", "m4"], shallow: ["m4"] })
    expect(await prepared(clone, { base: "origin/main" })).toEqual({ commits: ["f1", "f2", "m4", "m5", "m6"], shallow: ["m4"] })
  })

  test("run --git from it: the sandbox's git sees what git sees here", async () => {
    const clone = await shallowClone(root)
    const view = `${VIEW}; git log --format=%s; git rev-parse --is-shallow-repository`
    const result = await cli(["run", "--git", "--", "sh", "-c", view], { cwd: clone, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(run(["sh", "-c", view], clone))
    expect(result.stdout).toEndWith("f2\nf1\nm4\ntrue\n")
  })
})

describe("verifyBundle", () => {
  test("refuses a bundle with a commit outside the selection, or a ref to anything else", async () => {
    const repo = await baseRepo(root)
    const bundle = join(root, "all.bundle")
    sh(["git", "bundle", "create", bundle, "main"], repo)
    const names = commitsBySubject(repo)
    const options = { objectFormat: "sha1", dir: root }
    const both = new Set([names.B!, names.r1!])
    expect(await verifyBundle(bundle, { commits: both, shallow: [] }, new Set(), options)).toBe(2)
    await expect(verifyBundle(bundle, { commits: new Set([names.B!]), shallow: [names.B!] }, new Set(), options)).rejects.toThrow(
      `--git: refusing to send the history: the bundle holds 1 commit outside the history asked for (${names.r1}); nothing was uploaded`,
    )
    await expect(verifyBundle(bundle, { commits: new Set([names.r1!]), shallow: [] }, new Set(), options)).rejects.toThrow(`refs to ${names.B}`)
  })

  test("refuses a bundle in which a selected commit cannot be reached, as the sandbox's shallow repository would see it", async () => {
    const repo = await baseRepo(root)
    const bundle = join(root, "all.bundle")
    sh(["git", "bundle", "create", bundle, "main"], repo)
    const names = commitsBySubject(repo)
    // r1 is in the bundle, but B is cut there: nothing reaches r1
    await expect(verifyBundle(bundle, { commits: new Set([names.B!, names.r1!]), shallow: [names.B!] }, new Set(), { objectFormat: "sha1", dir: root })).rejects.toThrow(
      `--git: refusing to send the history: 1 commit of the history asked for would not be reachable in the sandbox (${names.r1}); nothing was uploaded`,
    )
  })
})

describe("kyora vms run --git", () => {
  test("the sandbox's git sees what git sees here: status, staged changes, diff against HEAD", async () => {
    const repo = await makeHistoryRepo(root)
    const here = run(["sh", "-c", VIEW], repo)
    const result = await cli(["run", "--git", "--keep", "--", "sh", "-c", `${VIEW}; echo '== remote'; git remote -v; echo '== shallow'; git rev-parse --is-shallow-repository; git rev-list --count HEAD`], { cwd: repo, env: env() })

    expect(result.code).toBe(0)
    const [view, extra] = result.stdout.split("== remote\n")
    expect(view).toBe(here)
    // the sandbox shows the local changes, so there are some
    expect(here).toContain(" M src/m1.txt\n")
    expect(here).toContain('A  "staged [x]*.txt"\n')
    expect(here).toContain("M  src/m2.txt\n")
    expect(here).toContain("MM src/shared.txt\n")
    expect(here).toContain("D  src/m3.txt\n")
    expect(here).toContain(" D feature1.txt\n")
    expect(here).toContain("?? notes/todo.txt\n")
    expect(extra).toBe("origin\thttps://github.com/acme/widgets.git (fetch)\norigin\thttps://github.com/acme/widgets.git (push)\n== shallow\nfalse\n5\n")
    expect(result.stderr).toMatch(/upload .* · git history \S+ \S+ \(5 commits\) \S+ · exec \S+ · exit 0/)

    // nothing of the local .git in the sandbox, and nothing left of the import
    const [id] = [...vmd.sandboxes.keys()]
    const work = vmd.work(id!)
    expectNoSecrets(await everything(work))
    expect(await lstat(join(work, IMPORT)).catch(() => null)).toBeNull()
    const config = await readFile(join(work, ".git/config"), "utf8")
    for (const key of ["extraheader", "credential", "insteadOf", "sshCommand", "include", "x-access-token"]) expect(config).not.toContain(key)
    expect(await readdir(join(work, ".git"))).not.toContain("modules")
    expect(await readdir(join(work, ".git"))).not.toContain("lfs")
    expect(await lstat(join(work, ".git/hooks")).catch(() => null)).toBeNull()
    expect(await lstat(join(work, ".env")).catch(() => null)).toBeNull()
  })

  test("--git-base: diff against the base, its log and merge base, and no further back", async () => {
    const repo = await makeHistoryRepo(root)
    const here = run(["sh", "-c", BASE_VIEW], repo)
    const result = await cli(["run", "--git-base", "origin/main", "--", "sh", "-c", `${BASE_VIEW}; echo '== count'; git rev-list --count --all; git rev-parse --is-shallow-repository`], {
      cwd: repo,
      env: env(),
    })
    expect(result.code).toBe(0)
    const [view, count] = result.stdout.split("== count\n")
    expect(view).toBe(here)
    expect(here).toContain("== log\n")
    expect(here.split("== log\n")[1]!.split("\n== merge base")[0]!.trim().split("\n")).toHaveLength(2)
    // f1, f2, m3, m4, m5
    expect(count).toBe("5\ntrue\n")
    expect(result.stderr).toMatch(/git history \S+ \S+ \(5 commits, shallow\)/)
  })

  test("run --git with the command's stream cut twice: git's view is the same, the output whole", async () => {
    const repo = await makeHistoryRepo(root)
    const here = run(["sh", "-c", VIEW], repo)
    const tail = Array.from({ length: 30 }, (_, i) => `tail ${i + 1}\n`).join("")
    // the cuts fall in the command's own stream (the history's setup is kyora'ss, and not resumable)
    vmd.options.cutAfter = [Math.floor(here.length / 2), 60]
    const result = await cli(["run", "--git", "--", "sh", "-c", `${VIEW}; for i in $(seq 1 30); do echo tail $i; sleep 0.01; done`], {
      cwd: repo,
      env: env({ KYORA_VMS_REATTACH_BASE_MS: "40" }),
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(here + tail)
    expect(result.stderr.split("\n").filter((line) => line === "[kyora-vms] reconnecting…")).toHaveLength(2)
    expect(vmd.cuts).toBe(2)
  })

  test("--git-depth 1: HEAD alone, shallow, still diffable", async () => {
    const repo = await makeHistoryRepo(root)
    const here = run(["sh", "-c", VIEW], repo)
    const result = await cli(["run", "--git-depth", "1", "--json", "--", "sh", "-c", `${VIEW}; git rev-list --count HEAD`], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    const types = events.map((event) => event.type)
    expect(types.filter((type) => type !== "stdout")).toEqual(["sandbox", "upload", "git", "started", "exit", "summary"])
    expect(types.indexOf("git")).toBeLessThan(types.indexOf("stdout"))
    const git = events.find((event) => event.type === "git")
    expect(git).toMatchObject({ commits: 1, shallow: true, branch: "refs/heads/feature", base: null, staged: 4, head: sh(["git", "rev-parse", "HEAD"], repo) })
    expect(git.bytes).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ type: "summary", git: { commits: 1, shallow: true }, exitCode: 0 })
    expect(events.at(-1).timings.gitMs).toBeGreaterThanOrEqual(0)
    const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("")
    expect(stdout).toBe(`${here}1\n`)
  })

  test("a sparse checkout: what it leaves out of the worktree is not shown as deleted", async () => {
    const repo = await makeHistoryRepo(root)
    sh(["git", "sparse-checkout", "set", "--no-cone", "/*", "!/feature2.txt"], repo)
    expect(await lstat(join(repo, "feature2.txt")).catch(() => null)).toBeNull()
    const here = run(["sh", "-c", VIEW], repo)
    expect(here).not.toContain("feature2.txt")
    const result = await cli(["run", "--git", "--", "sh", "-c", `${VIEW}; git ls-files -t feature2.txt`], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${here}S feature2.txt\n`)

    // src/ out as well, with a staged edit in it that has no file here any more: still staged
    sh(["git", "sparse-checkout", "set", "--no-cone", "/*", "!/feature2.txt", "!/src/"], repo)
    expect(await lstat(join(repo, "src/m2.txt")).catch(() => null)).toBeNull()
    const sparser = run(["sh", "-c", VIEW], repo)
    expect(sparser).toContain("M  src/m2.txt\n")
    const again = await cli(["run", "--git", "--", "sh", "-c", VIEW], { cwd: repo, env: env() })
    expect(again.code).toBe(0)
    expect(again.stdout).toBe(sparser)
  })

  test("a SHA-256 repository stays one", async () => {
    const repo = join(root, "sha256")
    await mkdir(repo)
    sh(["git", "init", "--quiet", "-b", "main", "--object-format=sha256"], repo)
    await write(repo, "a.txt", "a\n")
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "--quiet", "-m", "a"], repo)
    await write(repo, "a.txt", "a, edited\n")
    const view = "git rev-parse --show-object-format; git rev-parse HEAD; git status --porcelain"
    const result = await cli(["run", "--git", "--", "sh", "-c", view], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(run(["sh", "-c", view], repo))
    expect(result.stdout).toStartWith("sha256\n")
  })

  test("a detached HEAD stays detached", async () => {
    const repo = await makeHistoryRepo(root)
    sh(["git", "checkout", "--quiet", "--detach"], repo)
    const view = "git rev-parse HEAD; git symbolic-ref -q HEAD || echo detached; git branch --list; git status | head -n 1"
    const result = await cli(["run", "--git", "--", "sh", "-c", view], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    const short = sh(["git", "rev-parse", "--short", "HEAD"], repo)
    expect(result.stdout).toBe(`${sh(["git", "rev-parse", "HEAD"], repo)}\ndetached\n* (HEAD detached at ${short})\nHEAD detached at ${short}\n`)
  })

  test("a linked worktree: its own HEAD and history, nothing of the main .git it points into", async () => {
    const repo = await makeHistoryRepo(root)
    const worktree = join(root, "wt")
    sh(["git", "worktree", "add", "--quiet", "-b", "wt-branch", worktree, "main"], repo)
    await write(repo, ".git/worktrees/wt/secret", SECRETS.worktree)
    await write(worktree, "src/m5.txt", "main 5, edited in the worktree\n")
    expect((await readFile(join(worktree, ".git"), "utf8")).startsWith("gitdir: ")).toBe(true)

    const here = run(["sh", "-c", VIEW], worktree)
    const result = await cli(["run", "--git", "--keep", "--", "sh", "-c", VIEW], { cwd: worktree, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(here)
    expect(here).toContain("refs/heads/wt-branch")
    expect(here).toContain(" M src/m5.txt")
    const work = vmd.work([...vmd.sandboxes.keys()][0]!)
    expect((await lstat(join(work, ".git"))).isDirectory()).toBe(true)
    expectNoSecrets(await everything(work))
  })

  test("a submodule's files go up as today; its .git/modules and history do not", async () => {
    const sub = join(root, "sub")
    await mkdir(sub)
    sh(["git", "init", "--quiet", "-b", "main"], sub)
    await write(sub, "lib.txt", "library\n")
    sh(["git", "add", "-A"], sub)
    sh(["git", "commit", "--quiet", "-m", "lib"], sub)
    const parent = join(root, "parent")
    await mkdir(parent)
    sh(["git", "init", "--quiet", "-b", "main"], parent)
    await write(parent, "app.txt", "app\n")
    sh(["git", "add", "-A"], parent)
    sh(["git", "commit", "--quiet", "-m", "app"], parent)
    sh(["git", "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "vendor/sub"], parent)
    sh(["git", "commit", "--quiet", "-m", "sub"], parent)
    sh(["git", "config", "http.extraheader", `X-Token: ${SECRETS.module}`], join(parent, "vendor/sub"))
    await write(parent, "app.txt", "app, edited\n")

    const here = run(["sh", "-c", VIEW], parent)
    const result = await cli(["run", "--git", "--keep", "--", "sh", "-c", `${VIEW}; cat vendor/sub/lib.txt`], { cwd: parent, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${here}library\n`)
    const work = vmd.work([...vmd.sandboxes.keys()][0]!)
    expect(await lstat(join(work, "vendor/sub/.git")).catch(() => null)).toBeNull()
    expect(await readdir(join(work, ".git"))).not.toContain("modules")
    expectNoSecrets(await everything(work))
  })

  test("what cannot go up stops the run before a sandbox exists", async () => {
    const repo = await makeHistoryRepo(root)
    const tooBig = await cli(["run", "--git", "--", "true"], { cwd: repo, env: env({ KYORA_VMS_GIT_MAX: "1K" }) })
    expect(tooBig.code).toBe(125)
    expect(tooBig.stderr).toMatch(/--git: .* over the 1\.0 KB --git sends; send less with --git-depth N or --git-base REF, or raise KYORA_VMS_GIT_MAX/)

    const sub = await cli(["run", "--git", "--dir", "src", "--", "true"], { cwd: repo, env: env() })
    expect(sub.code).toBe(125)
    expect(sub.stderr).toContain("must be the repo's top level")

    const both = await cli(["run", "--git", "--no-git", "--", "true"], { cwd: repo, env: env() })
    expect(both.code).toBe(125)
    expect(both.stderr).toContain("does not go with --no-git")

    const depth = await cli(["run", "--git-depth", "0", "--", "true"], { cwd: repo, env: env() })
    expect(depth.stderr).toContain("--git-depth must be a whole number above zero")
    const flag = await cli(["run", "--git-base=--all", "--", "true"], { cwd: repo, env: env() })
    expect(flag.stderr).toContain("--git-base takes a commit or ref")
    expect((await cli(["push", "sb_x", "--git-base", "nope"], { cwd: repo, env: env() })).stderr).toContain("--git-base nope: not a commit")
    expect(vmd.created).toHaveLength(0)
  })

  test("a 413 says how much of the upload was history", async () => {
    const repo = await makeHistoryRepo(root)
    vmd.options.uploadLimit = 256
    const result = await cli(["run", "--git", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/the upload carried \S+ \S+ of git history \(--git\); --git-depth N or --git-base REF send less/)
    expect(vmd.destroyed).toHaveLength(1)
    expect(vmd.execs).toHaveLength(0)
  })

  test("a setup that fails in the sandbox fails the run, with its reason", async () => {
    const repo = await makeHistoryRepo(root)
    // an exec that says no, as a guest without git would
    vmd.options.exec = () => new Response(`${JSON.stringify({ type: "stderr", data: "sh: git: not found\n" })}\n${JSON.stringify({ type: "exit", code: 127, signal: null })}\n`)
    const result = await cli(["run", "--git", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("--git: setting up /work/.git in the sandbox failed (exit 127): sh: git: not found")
    expect(vmd.destroyed).toHaveLength(1)
  })
})

describe("kyora vms push --git", () => {
  test("sets up .git where it pushed to, and a second push replaces it", async () => {
    const repo = await makeHistoryRepo(root)
    const id = (await cli(["create"], { cwd: root, env: env() })).stdout.trim()
    const first = await cli(["push", id, repo, "--git-depth", "1", "--dest", "/work/app"], { cwd: root, env: env() })
    expect(first.code).toBe(0)
    expect(first.stdout).toMatch(/to \/work\/app with git history \S+ \S+ \(1 commit, shallow\) in /)
    const shallow = await cli(["exec", id, "--cwd", "app", "--", "sh", "-c", "git rev-list --count HEAD; git rev-parse --is-shallow-repository"], { cwd: root, env: env() })
    expect(shallow.stdout).toBe("1\ntrue\n")

    const second = await cli(["push", id, repo, "--git", "--dest", "/work/app", "--json"], { cwd: root, env: env() })
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout).git).toMatchObject({ commits: 5, shallow: false })
    const here = run(["sh", "-c", VIEW], repo)
    const full = await cli(["exec", id, "--cwd", "app", "--", "sh", "-c", `${VIEW}; git rev-list --count HEAD; git rev-parse --is-shallow-repository`], { cwd: root, env: env() })
    expect(full.stdout).toBe(`${here}5\nfalse\n`)
    expectNoSecrets(await everything(vmd.work(id)))
  })

  test("what a push whose setup never ran left behind does not leak into the next one", async () => {
    const repo = await makeHistoryRepo(root)
    const id = (await cli(["create"], { cwd: root, env: env() })).stdout.trim()
    // the setup is cut off: the shallow list and the index files of --git-depth 1 stay in the sandbox
    vmd.options.exec = () => new Response(`${JSON.stringify({ type: "error", message: "guest agent vanished" })}\n`)
    const cut = await cli(["push", id, repo, "--git-depth", "1"], { cwd: root, env: env() })
    expect(cut.code).toBe(125)
    expect(cut.stderr).toContain("--git: setting up /work/.git in the sandbox failed")
    expect((await readFile(join(vmd.work(id), IMPORT, "shallow"), "utf8")).trim()).toBe(sh(["git", "rev-parse", "HEAD"], repo))

    // meanwhile nothing is staged any more here, and all of the history goes up
    sh(["git", "reset", "--quiet"], repo)
    vmd.options.exec = undefined
    const pushed = await cli(["push", id, repo, "--git"], { cwd: root, env: env() })
    expect(pushed.code).toBe(0)
    const here = run(["sh", "-c", VIEW], repo)
    const view = await cli(["exec", id, "--", "sh", "-c", `${VIEW}; git rev-list --count HEAD; git rev-parse --is-shallow-repository`], { cwd: root, env: env() })
    expect(view.stdout).toBe(`${here}5\nfalse\n`)
  })
})

describe("the fixture", () => {
  test("holds every secret where a careless .git would", async () => {
    const repo = await makeHistoryRepo(root)
    const dotGit = await everything(join(repo, ".git"))
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (name === "env" || name === "worktree") continue
      expect([name, dotGit.includes(secret)]).toEqual([name, true])
    }
    expect(await Bun.file(join(repo, ".env")).text()).toContain(SECRETS.env)
    // and git reads them: a GitHub URL is rewritten to carry a token
    expect(sh(["git", "ls-remote", "--get-url", "https://github.com/acme/widgets.git"], repo)).toContain(SECRETS.insteadOf)
    expect(sh(["git", "config", "user.signingkey"], repo)).toBe(SECRETS.include)
  })
})
