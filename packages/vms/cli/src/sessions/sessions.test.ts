/** Session import, checkpoint, export and credential handling against local fakes and temporary homes. */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises"
import { join } from "node:path"
import { VmsClient } from "../api"
import { GIT_ENV, sh, tempDir, write } from "../testing/fixtures"
import { KEY, startFakeVmd } from "../testing/fake-vmd"
import { fileHash, restoreConversation, sha256 } from "./agents"
import { renderEvent } from "./attach"
import { SESSION_HELP, sessionMain, SessionUsage } from "./cli"
import { approvedMcp, claudeAdapter, localPaths, mergeSettings, portableMcp, secretInPath } from "./claude"
import { codexAdapter } from "./codex"
import { credsList, credsRemove, credsReturn, credsSync, DEFAULT_PERMISSION_MODE, pullSession, treeListing, untrackedFiles } from "./commands"
import { branchRef, CHECKPOINT_REF, createBranch, importBundle, remoteRef, revParse, snapshotWorktree } from "./git"
import { claudeProjectName, javaHash, mountablePath, rebase, toLocal, toRemote } from "./paths"
import { parseState, SCRIPTS, verifyExport } from "./remote"
import { claudeKeychainAccount, claudeKeychainService, fingerprintOf, liveClaudeFingerprint, readSlot, slotCredential, writeBackSlot } from "./slots"
import { drivenFromCloud, repoKey, resolveState, saveState, type SessionState, uploadOf } from "./state"

// Real git and supervisor round trips can outlast Bun's 5 s default on a shared CPU.
setDefaultTimeout(30_000)

// every git call of the code under test sees none of the developer's config
beforeAll(() => {
  Object.assign(process.env, GIT_ENV)
})

const dirs: string[] = []
const temp = async (prefix: string) => {
  const dir = await tempDir(prefix)
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

const status = (repo: string) => sh(["git", "status", "--porcelain=v1", "--untracked-files=all"], repo)
const indexOf = (repo: string) => sh(["git", "ls-files", "--stage"], repo)

async function repoWithChanges(): Promise<string> {
  const repo = await temp("session-repo")
  sh(["git", "init", "-q", "-b", "main", repo])
  await write(repo, ".gitignore", "secret.env\nbuild/\n")
  await write(repo, "src/app.ts", "export const a = 1\n")
  await write(repo, "README.md", "hello\n")
  await write(repo, "gone.txt", "to be deleted\n")
  sh(["git", "add", "-A"], repo)
  sh(["git", "commit", "-q", "-m", "first"], repo)
  // a dirty worktree: modified, partly staged, untracked, ignored, deleted
  await write(repo, "src/app.ts", "export const a = 2\n")
  await write(repo, "README.md", "hello, staged\n")
  sh(["git", "add", "README.md"], repo)
  await write(repo, "README.md", "hello, staged and then edited\n")
  await write(repo, "notes/todo.md", "untracked\n")
  await write(repo, "secret.env", "TOKEN=nope\n")
  await write(repo, "build/out.js", "ignored\n")
  await rm(join(repo, "gone.txt"))
  return repo
}

describe("paths", () => {
  test("Claude Code's project directory names", () => {
    expect(claudeProjectName("/Users/me/src/kyora")).toBe("-Users-me-src-kyora")
    expect(claudeProjectName("/home/me/my_repo.v2")).toBe("-home-me-my-repo-v2")
    // Java's String.hashCode, as Claude Code uses it
    expect(javaHash("hello")).toBe(99162322)
    expect(javaHash("")).toBe(0)
    const long = `/home/me/${"very-long-directory-name/".repeat(12)}repo`
    const name = claudeProjectName(long)
    expect(name.length).toBeGreaterThan(200)
    expect(name.slice(0, 200)).toBe(long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200))
    expect(name.slice(200)).toBe(`-${Math.abs(javaHash(long)).toString(36)}`)
  })

  test("mapping between the laptop and the VM", () => {
    const map = { local: "/Users/me/repo", remote: "/work" }
    expect(toRemote(map, "/Users/me/repo")).toBe("/work")
    expect(toRemote(map, "/Users/me/repo/packages/api")).toBe("/work/packages/api")
    expect(toRemote(map, "/Users/me/repository")).toBe("/Users/me/repository")
    expect(toLocal(map, "/work/src")).toBe("/Users/me/repo/src")
    expect(rebase("/a/b", "/a/b/", "/c")).toBe("/c")
    expect(mountablePath("/Users/me/repo")).toBe(true)
    expect(mountablePath("/home/me/repo")).toBe(true)
    for (const bad of ["/", "/work/x", "/tmp/repo", "/etc/x", "relative/path", "/a/../b", "/a\nb"]) expect(mountablePath(bad)).toBe(false)
  })
})

describe("branch mechanics", () => {
  test("up's snapshot takes the whole working tree and leaves it, the index and HEAD exactly as they were", async () => {
    const repo = await repoWithChanges()
    const before = { status: status(repo), index: indexOf(repo), head: sh(["git", "rev-parse", "HEAD"], repo), readme: await readFile(join(repo, "README.md"), "utf8") }
    const snap = await snapshotWorktree(repo, "snapshot")
    expect(snap.changed).toBe(true)
    expect(snap.parent).toBe(before.head)
    expect({ status: status(repo), index: indexOf(repo), head: sh(["git", "rev-parse", "HEAD"], repo), readme: await readFile(join(repo, "README.md"), "utf8") }).toEqual(before)

    const files = sh(["git", "ls-tree", "-r", "--name-only", snap.commit], repo).split("\n")
    expect(files).toContain("notes/todo.md")
    expect(files).not.toContain("secret.env")
    expect(files).not.toContain("build/out.js")
    expect(files).not.toContain("gone.txt")
    // the working tree's content, not the staged one
    expect(sh(["git", "show", `${snap.commit}:README.md`], repo)).toBe("hello, staged and then edited")
    expect(sh(["git", "show", `${snap.commit}:src/app.ts`], repo)).toBe("export const a = 2")

    await createBranch(repo, "s1", snap.commit)
    expect(await revParse(repo, branchRef("s1"))).toBe(snap.commit)
    expect(sh(["git", "symbolic-ref", "HEAD"], repo)).toBe("refs/heads/main")
    await expect(createBranch(repo, "s1", snap.commit)).rejects.toThrow(/exist/)
  })

  test("a clean tree and a repo without commits", async () => {
    const repo = await temp("session-empty")
    sh(["git", "init", "-q", "-b", "main", repo])
    await write(repo, "a.txt", "a\n")
    const first = await snapshotWorktree(repo, "snapshot")
    expect(first.parent).toBeNull()
    expect(sh(["git", "ls-tree", "-r", "--name-only", first.commit], repo)).toBe("a.txt")
    expect(status(repo)).toBe("?? a.txt")
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "-q", "-m", "a"], repo)
    const clean = await snapshotWorktree(repo, "snapshot")
    expect(clean.changed).toBe(false)
  })

  /** a VM's clone of the session branch, which commits and bundles what is new */
  async function vm(repo: string, name: string, base: string): Promise<{ dir: string; commit: (file: string, text: string) => Promise<string>; bundle: () => string }> {
    const dir = await temp("session-vm")
    sh(["git", "clone", "-q", "--branch", `kyora/${name}`, repo, dir])
    return {
      dir,
      commit: async (file, text) => {
        await write(dir, file, text)
        sh(["git", "add", "-A"], dir)
        sh(["git", "commit", "-q", "-m", `vm: ${file}`], dir)
        return sh(["git", "rev-parse", "HEAD"], dir)
      },
      bundle: () => {
        const path = join(dir, "..", `${name}-${Date.now()}-${Math.random()}.bundle`)
        sh(["git", "bundle", "create", "-q", path, `${base}..refs/heads/kyora/${name}`], dir)
        dirs.push(path)
        return path
      },
    }
  }

  test("down fast-forwards an untouched kyora/<name> and leaves main and the worktree alone", async () => {
    const repo = await repoWithChanges()
    const snap = await snapshotWorktree(repo, "snapshot")
    await createBranch(repo, "ff", snap.commit)
    const box = await vm(repo, "ff", snap.commit)
    await box.commit("vm.txt", "from the vm\n")
    const tip = await box.commit("vm2.txt", "more\n")
    const before = { status: status(repo), main: sh(["git", "rev-parse", "main"], repo) }
    const outcome = await importBundle(repo, box.bundle(), "ff")
    expect(outcome).toMatchObject({ kind: "fast-forward", commit: tip, commits: 2 })
    expect(await revParse(repo, branchRef("ff"))).toBe(tip)
    expect(await revParse(repo, remoteRef("ff"))).toBeNull()
    expect({ status: status(repo), main: sh(["git", "rev-parse", "main"], repo) }).toEqual(before)
    // nothing new the second time
    expect((await importBundle(repo, box.bundle(), "ff")).kind).toBe("unchanged")
  })

  test("a kyora/<name> that moved here meanwhile is kept, and the VM's tip waits beside it", async () => {
    const repo = await repoWithChanges()
    const snap = await snapshotWorktree(repo, "snapshot")
    await createBranch(repo, "dv", snap.commit)
    const box = await vm(repo, "dv", snap.commit)
    const tip = await box.commit("vm.txt", "from the vm\n")
    // the laptop commits onto kyora/dv in a worktree of its own
    const side = await temp("session-side")
    await rm(side, { recursive: true, force: true })
    sh(["git", "worktree", "add", "-q", side, "kyora/dv"], repo)
    await write(side, "laptop.txt", "from the laptop\n")
    sh(["git", "add", "-A"], side)
    sh(["git", "commit", "-q", "-m", "laptop"], side)
    const mine = sh(["git", "rev-parse", "HEAD"], side)
    const outcome = await importBundle(repo, box.bundle(), "dv")
    expect(outcome).toMatchObject({ kind: "kept-remote", reason: "diverged", commit: tip, ref: remoteRef("dv") })
    expect(await revParse(repo, branchRef("dv"))).toBe(mine)
    expect(await revParse(repo, remoteRef("dv"))).toBe(tip)
  })

  test("a kyora/<name> checked out somewhere is never moved under it", async () => {
    const repo = await repoWithChanges()
    const snap = await snapshotWorktree(repo, "snapshot")
    await createBranch(repo, "co", snap.commit)
    const box = await vm(repo, "co", snap.commit)
    const tip = await box.commit("vm.txt", "from the vm\n")
    const side = await temp("session-co")
    await rm(side, { recursive: true, force: true })
    sh(["git", "worktree", "add", "-q", side, "kyora/co"], repo)
    const outcome = await importBundle(repo, box.bundle(), "co")
    expect(outcome).toMatchObject({ kind: "kept-remote", reason: "checked-out", commit: tip })
    expect(await revParse(repo, branchRef("co"))).toBe(snap.commit)
  })
})

describe("the conversation's round trip", () => {
  const SESSION = "0f2b3c4d-1111-4222-8333-944455556666"

  beforeEach(async () => {
    await rm(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true })
    await rm(process.env.CODEX_HOME!, { recursive: true, force: true })
  })

  async function claudeSession(cwd: string, id = SESSION, lines?: object[]): Promise<string> {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", claudeProjectName(cwd))
    const entries = lines ?? [
      { type: "user", sessionId: id, cwd, version: "2.1.287", message: { role: "user", content: "build the thing" } },
      { type: "assistant", sessionId: id, cwd, version: "2.1.287", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "on it" }] } },
    ]
    await write(dir, `${id}.jsonl`, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
    await write(dir, `${id}/subagents/agent-1.jsonl`, `${JSON.stringify({ sessionId: id, cwd: `${cwd}/sub` })}\n`)
    return join(dir, `${id}.jsonl`)
  }

  test("finds a Claude Code session by id and the newest one, with its cwd, model and version", async () => {
    const repo = await repoWithChanges()
    const top = sh(["git", "rev-parse", "--show-toplevel"], repo)
    const file = await claudeSession(top)
    const older = "1a2b3c4d-1111-4222-8333-944455556666"
    const olderFile = await claudeSession(top, older)
    await utimes(olderFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const found = await claudeAdapter.find({ cwd: top, top })
    expect(found).toMatchObject({ id: SESSION, cwd: top, file, model: "claude-opus-5-5", version: "2.1.287" })
    expect(found.extra).toBe(join(file.slice(0, -".jsonl".length)))
    expect((await claudeAdapter.find({ cwd: top, top, id: older })).id).toBe(older)
    await expect(claudeAdapter.find({ cwd: top, top, id: "not-a-uuid" })).rejects.toThrow(/UUID/)
    const elsewhere = await temp("elsewhere")
    await expect(claudeAdapter.find({ cwd: elsewhere, top: elsewhere, id: SESSION })).rejects.toThrow(/not inside/)
  })

  test("a mapped session's paths move to /work on the way up and back on the way down", async () => {
    const top = "/Users/me/repo"
    const file = await claudeSession(top)
    const session = { agent: "claude" as const, id: SESSION, cwd: top, file, extra: file.slice(0, -".jsonl".length), model: null, version: null }
    const map = { local: top, remote: "/work" }
    const staged = await claudeAdapter.stage(session, map)
    expect(staged.map((f) => f.rel)).toEqual([`.claude/projects/-work/${SESSION}.jsonl`, `.claude/projects/-work/${SESSION}/subagents/agent-1.jsonl`])
    const up = String(staged[0]!.contents)
    expect(up).toContain('"cwd":"/work"')
    expect(up).not.toContain(top)
    expect(String(staged[1]!.contents)).toContain('"cwd":"/work/sub"')
    // the same path needs no rewriting at all
    const same = await claudeAdapter.stage(session, { local: top, remote: top })
    expect(same[0]!.rel).toBe(`.claude/projects/-Users-me-repo/${SESSION}.jsonl`)
    expect(String(same[0]!.contents)).toBe(await readFile(file, "utf8"))
  })

  async function exportFrom(vmText: string): Promise<{ file: string; extra: string }> {
    const dir = await temp("session-export")
    await write(dir, "t.jsonl", vmText)
    await write(dir, "extra/subagents/agent-2.jsonl", `${JSON.stringify({ sessionId: SESSION, cwd: "/work" })}\n`)
    return { file: join(dir, "t.jsonl"), extra: join(dir, "extra") }
  }

  test("pull replaces an untouched transcript with the VM's, its paths mapped back", async () => {
    const top = "/Users/me/repo"
    const file = await claudeSession(top)
    const uploaded = (await fileHash(file))!
    const session = { agent: "claude" as const, id: SESSION, cwd: top, file, extra: file.slice(0, -".jsonl".length), model: null, version: null }
    const grown = `${(await readFile(file, "utf8")).replaceAll(top, "/work")}${JSON.stringify({ type: "assistant", sessionId: SESSION, cwd: "/work", message: { content: "done in the vm" } })}\n`
    const outcome = await restoreConversation(claudeAdapter, { session, file, extra: session.extra, id: SESSION }, uploaded, await exportFrom(grown), { local: top, remote: "/work" })
    expect(outcome.kind).toBe("updated")
    const text = await readFile(file, "utf8")
    expect(text).toContain("done in the vm")
    expect(text).not.toContain('"cwd":"/work"')
    expect(text).toContain(`"cwd":"${top}"`)
    expect(outcome.hash).toBe(sha256(text))
    expect(await readFile(join(session.extra, "subagents", "agent-2.jsonl"), "utf8")).toContain(`"cwd":"${top}"`)
    // a second pull of the same export changes nothing
    const again = await restoreConversation(claudeAdapter, { session, file, extra: session.extra, id: SESSION }, outcome.hash, await exportFrom(grown), { local: top, remote: "/work" })
    expect(again.kind).toBe("unchanged")
  })

  test("a transcript resumed here meanwhile is kept, and the VM's comes back beside it under a new id", async () => {
    const top = "/Users/me/repo"
    const file = await claudeSession(top)
    const uploaded = (await fileHash(file))!
    const session = { agent: "claude" as const, id: SESSION, cwd: top, file, extra: file.slice(0, -".jsonl".length), model: null, version: null }
    // resumed on the laptop
    const mine = `${await readFile(file, "utf8")}${JSON.stringify({ type: "user", sessionId: SESSION, cwd: top, message: { content: "local turn" } })}\n`
    await write(file.slice(0, file.lastIndexOf("/")), `${SESSION}.jsonl`, mine)
    const grown = `${(await readFile(file, "utf8")).replace("local turn", "vm turn")}`
    const fork = "9f9f9f9f-1111-4222-8333-944455556666"
    const outcome = await restoreConversation(claudeAdapter, { session, file, extra: session.extra, id: SESSION }, uploaded, await exportFrom(grown), { local: top, remote: top }, () => fork)
    expect(outcome).toMatchObject({ kind: "forked", id: fork, from: SESSION })
    expect(await readFile(file, "utf8")).toBe(mine)
    const forked = await readFile(join(file.slice(0, file.lastIndexOf("/")), `${fork}.jsonl`), "utf8")
    expect(forked).toContain("vm turn")
    expect(forked).not.toContain(`"sessionId":"${SESSION}"`)
    expect(forked).toContain(`"sessionId":"${fork}"`)
    expect(await readFile(join(file.slice(0, file.lastIndexOf("/")), fork, "subagents", "agent-2.jsonl"), "utf8")).toContain(fork)
  })

  test("Codex sessions: found by id or cwd, renamed in their session_meta", async () => {
    const repo = await temp("codex-repo")
    const id = "2b2b2b2b-1111-4222-8333-944455556666"
    const rel = `sessions/2026/10/02/rollout-2026-10-02T01-02-03-${id}.jsonl`
    const text = `${JSON.stringify({ type: "session_meta", payload: { id, cwd: repo, cli_version: "0.50.0" } })}\n${JSON.stringify({ type: "turn_context", payload: { cwd: repo } })}\n`
    await write(process.env.CODEX_HOME!, rel, text)
    const found = await codexAdapter.find({ cwd: repo, top: repo })
    expect(found).toMatchObject({ id, cwd: repo, version: "0.50.0" })
    expect(codexAdapter.exportPaths(found, { local: repo, remote: repo }).file).toBe(`.codex/${rel}`)
    const renamed = codexAdapter.rename(text, id, "3c3c3c3c-1111-4222-8333-944455556666")
    expect(renamed).toContain('"id":"3c3c3c3c-1111-4222-8333-944455556666"')
    expect(codexAdapter.rewriteCwd(text, repo, "/work").match(/"cwd":"\/work"/g)?.length).toBe(2)
    expect(codexAdapter.forkFile(found, "3c3c3c3c-1111-4222-8333-944455556666").file).toEndWith("rollout-2026-10-02T01-02-03-3c3c3c3c-1111-4222-8333-944455556666.jsonl")
    const plan = codexAdapter.launch(found, { local: repo, remote: repo }, { prompt: "go on", permissionMode: "x", broker: null, configArgs: [] })
    expect(plan.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", id])
  })
})

describe("project config for the VM", () => {
  const root = "/Users/me/repo"

  test("names a path outside the project only when it is this laptop's", () => {
    expect(localPaths("bun $CLAUDE_PROJECT_DIR/scripts/check.ts", root)).toEqual([])
    expect(localPaths("/Users/me/repo/scripts/lint.sh", root)).toEqual([])
    expect(localPaths("/usr/bin/env node x.js", root)).toEqual([])
    expect(localPaths("~/bin/notify --done", root)).toEqual(["~"])
    expect(localPaths("python3 /Users/me/tools/hook.py", root)).toEqual(["/Users/me/tools/hook.py"])
    expect(localPaths("cat $HOME/.secrets", root)).toEqual(["$HOME"])
  })

  test("hooks and helpers that point at the laptop are dropped and said so; the rest stays", () => {
    const dropped: string[] = []
    const merged = mergeSettings(
      {
        permissions: { allow: ["Bash(bun test:*)"] },
        hooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun $CLAUDE_PROJECT_DIR/scripts/fmt.ts" }, { type: "command", command: "/Users/me/bin/notify" }] }],
          Stop: [{ hooks: [{ type: "command", command: "~/.claude/stop.sh" }] }],
        },
        env: { NODE_OPTIONS: "--max-old-space-size=4096", ANTHROPIC_API_KEY: "sk-ant-nope" },
        apiKeyHelper: "/Users/me/bin/key",
        enabledPlugins: { "x@y": true },
      },
      { permissions: { allow: ["Bash(git log:*)"] }, env: { GITHUB_TOKEN: "ghp_nope" } },
      root,
      dropped,
    )
    expect(merged.hooks).toEqual({ PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun $CLAUDE_PROJECT_DIR/scripts/fmt.ts" }] }] })
    // permission rules are command lines, and carry tokens: they never go
    expect(merged.permissions).toBeUndefined()
    expect(merged.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" })
    expect(merged.apiKeyHelper).toBeUndefined()
    expect(merged.enabledPlugins).toBeUndefined()
    expect(JSON.stringify(merged)).not.toContain("nope")
    expect(dropped.join("\n")).toContain("apiKeyHelper")
    expect(dropped.join("\n")).toContain("/Users/me/bin/notify")
    expect(dropped.join("\n")).toContain("Stop hook")
    expect(dropped.join("\n")).toContain("env ANTHROPIC_API_KEY")
    expect(dropped.join("\n")).toContain("settings.local.json: env (1 variable")
    expect(dropped.join("\n")).toContain("settings.json: permissions")
  })

  test("MCP servers that start a laptop-only program or talk to its localhost stay behind", () => {
    const dropped: string[] = []
    const kept = portableMcp(
      {
        mcpServers: {
          docs: { command: "npx", args: ["-y", "@acme/docs-mcp"] },
          local: { command: "/Users/me/tools/mcp-server" },
          dev: { type: "http", url: "http://localhost:3000/mcp" },
          remote: { type: "http", url: "https://mcp.example.com/mcp" },
          repo: { command: "bun", args: ["/Users/me/repo/tools/mcp.ts"] },
        },
      },
      root,
      dropped,
    )
    expect(Object.keys(kept).sort()).toEqual(["docs", "remote", "repo"])
    expect(dropped).toHaveLength(2)
  })

  test("the VM's agent gets the broker, never a credential, and a seeded config", async () => {
    const project = await temp("session-project")
    await write(project, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "~/x" }] }] } }))
    await write(project, "CLAUDE.local.md", "my private notes\n")
    const session = { agent: "claude" as const, id: "0f2b3c4d-1111-4222-8333-944455556666", cwd: project, file: "/dev/null", extra: null, model: "claude-opus-5-5", version: "2.1.287" }
    const config = await claudeAdapter.config(session, { local: project, remote: project }, { ignored: async () => true })
    expect(config.files.map((f) => f.rel).sort()).toEqual([".claude.json", ".claude/CLAUDE.md", ".claude/settings.json", ".kyora-session/mcp.json"])
    expect(JSON.parse(String(config.files.find((f) => f.rel === ".claude.json")!.contents)).projects[project].hasTrustDialogAccepted).toBe(true)
    expect(config.dropped).toHaveLength(1)
    expect(config.args).toContain("--setting-sources")
    const plan = claudeAdapter.launch(session, { local: project, remote: project }, { prompt: "carry on", permissionMode: "bypassPermissions", broker: { baseUrl: "https://cloud.kyora.sh/v1/broker/anthropic", token: "kys_session" }, configArgs: config.args })
    expect(plan.argv).toEqual(expect.arrayContaining(["claude", "-p", "--resume", session.id, "--output-format", "stream-json", "--model", "claude-opus-5-5", "carry on"]))
    expect(plan.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://cloud.kyora.sh/v1/broker/anthropic", ANTHROPIC_AUTH_TOKEN: "kys_session", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })
    expect(Object.keys(plan.env).some((key) => key === "ANTHROPIC_API_KEY" || key === "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false)
    expect(plan.install).toEqual({ bin: "claude", pkg: "@anthropic-ai/claude-code", version: "2.1.287" })
  })
})

describe("the supervisor, run here", () => {
  /**
   * A VM as `up` leaves it, here: the repo cloned at kyora/<name>, SETUP run over it for real (the
   * excludes, the committer), HOME inside the repo as kyora-init has it (/work/.home), and the
   * VM's own files there: what a checkpoint must never take.
   */
  async function vmBox(name: string) {
    const repo = await repoWithChanges()
    const snap = await snapshotWorktree(repo, "snapshot")
    await createBranch(repo, name, snap.commit)
    const box = await temp("session-box")
    const work = join(box, "work")
    sh(["git", "clone", "-q", "--branch", `kyora/${name}`, repo, work])
    const home = join(work, ".home")
    const dir = join(box, "kyora-session")
    const transcript = ".claude/projects/x/t.jsonl"
    await write(home, transcript, '{"sessionId":"t"}\n')
    await write(home, ".claude/settings.json", "{}\n")
    await write(work, ".cargo/registry/x", "cache\n")
    await write(work, ".kyora-session/mcp.json", "{}\n")
    const env = { ...GIT_ENV, HOME: home, KYORA_SESSION_DIR: dir, KYORA_SESSION_WORK: work }
    const setup = Bun.spawnSync(["bash", "-c", SCRIPTS.SETUP, "kyora-session-setup", work, "git", "git", "", ""], { cwd: work, env, stdout: "pipe", stderr: "pipe" })
    expect(setup.stderr.toString()).toBe("")
    expect(setup.stdout.toString().trim()).toBe("mode=same-path")
    expect(sh(["git", "config", "user.name"], work)).toBe("kyora session")
    const supervise = (agent: string, extra: Record<string, string> = {}) =>
      Bun.spawn(["bash", "-c", SCRIPTS.SUPERVISOR, "kyora-session", "bash", "-c", agent], {
        cwd: work,
        env: { ...env, KYORA_SESSION_CWD: work, KYORA_SESSION_BRANCH: `refs/heads/kyora/${name}`, KYORA_SESSION_BASE: snap.commit, KYORA_SESSION_FILE: transcript, KYORA_CHECKPOINT_S: "1", ...extra },
        stdout: "pipe",
        stderr: "pipe",
      })
    /** the current export, as a reader finds it: the generation the status state names (null before the first) */
    const exported = async () => {
      const status = parseState(await readFile(join(dir, "status", "state"), "utf8").catch(() => ""))
      return status.export === null ? null : join(dir, `export.${status.export}`)
    }
    const stateOf = async (where: "export" | "status" = "export") => {
      const at = where === "status" ? join(dir, "status") : await exported()
      return parseState(at ? await readFile(join(at, "state"), "utf8").catch(() => "") : "")
    }
    /** the first state that satisfies `done` (the very one it checked), or the last one read */
    const until = async (done: (state: ReturnType<typeof parseState>) => boolean, where: "export" | "status" = "export") => {
      const deadline = Date.now() + 20_000
      let state = await stateOf(where)
      while (!done(state) && Date.now() < deadline) {
        await Bun.sleep(150)
        state = await stateOf(where)
      }
      return state
    }
    return { repo, snap, work, home, dir, transcript, supervise, stateOf, until, exported }
  }

  test("starts the agent, checkpoints its work without touching the agent's branch or index, exports it, and stops cleanly; the laptop fast-forwards from the export", async () => {
    const { repo, snap, work, dir, transcript, supervise, stateOf, until, exported: current } = await vmBox("sv")
    // the "agent": stages one change, leaves another unstaged, appends to its transcript, finishes
    const agent = `echo working; echo 'export const a = 3' > src/app.ts; git add src/app.ts; echo 'more' >> README.md; echo '{"more":1}' >> "$HOME/${transcript}"; sleep 1; echo done`
    const proc = supervise(agent)
    const exported = await until((state) => state.agent === "exited")
    expect(exported).toMatchObject({ agent: "exited", agentExit: 0, supervisor: "running", base: snap.commit })
    expect(exported.checkpoint).not.toBe(snap.commit)
    // the checkpoint has the working tree, staged or not
    expect(sh(["git", "show", `${exported.checkpoint}:src/app.ts`], work)).toBe("export const a = 3")
    expect(sh(["git", "show", `${exported.checkpoint}:README.md`], work)).toEndWith("more")
    expect(sh(["git", "log", "-1", "--format=%s", CHECKPOINT_REF], work)).toContain("kyora checkpoint")
    // the VM's own files never go into one: HOME (/work/.home), cargo, the session's config
    const files = sh(["git", "ls-tree", "-r", "--name-only", exported.checkpoint!], work).split("\n")
    expect(files.filter((file) => /^\.(home|cargo|kyora-session)\//.test(file))).toEqual([])
    // and the agent's branch, HEAD and index are exactly as the agent left them: its staged change staged, nothing committed for it
    expect(sh(["git", "rev-parse", "kyora/sv"], work)).toBe(snap.commit)
    expect(sh(["git", "symbolic-ref", "HEAD"], work)).toBe("refs/heads/kyora/sv")
    expect(sh(["git", "diff", "--cached", "--name-only"], work)).toBe("src/app.ts")
    expect(sh(["git", "diff", "--name-only"], work)).toBe("README.md")
    expect(await readFile(join((await current())!, "home", transcript), "utf8")).toContain('"more":1')
    // a sync request is answered with its sequence number
    await write(dir, "control/sync-41", "")
    expect((await until((state) => state.seq === 41)).seq).toBe(41)
    // stop: the supervisor finishes and exits 0
    await write(dir, "control/stop", "")
    expect(await proc.exited).toBe(0)
    // the status says so; nothing changed since the sync, so the export it answered with is the last one too
    expect(await stateOf("status")).toMatchObject({ supervisor: "stopped", final: "done", export: (await until(() => true)).export })
    expect(new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer())).toContain("working")

    const outcome = await importBundle(repo, join((await current())!, "history.bundle"), "sv")
    expect(outcome).toMatchObject({ kind: "fast-forward", commit: exported.checkpoint })
    expect(sh(["git", "symbolic-ref", "HEAD"], repo)).toBe("refs/heads/main")
  }, 60_000)

  test("a checkpoint never concludes a merge the agent is in the middle of (P10)", async () => {
    const { snap, work, dir, supervise, stateOf, until } = await vmBox("mg")
    // a branch that conflicts with kyora/mg on README.md
    sh(["git", "checkout", "-q", "-b", "other"], work)
    await write(work, "README.md", "theirs\n")
    sh(["git", "commit", "-q", "-am", "theirs"], work)
    sh(["git", "checkout", "-q", "kyora/mg"], work)
    await write(work, "README.md", "ours\n")
    sh(["git", "commit", "-q", "-am", "ours"], work)
    const ours = sh(["git", "rev-parse", "HEAD"], work)
    // the agent starts the merge, hits the conflict, and is still thinking about it when checkpoints come round
    const proc = supervise("git merge other >/dev/null 2>&1; echo 'resolved by hand' > README.md; echo 'more work during the merge' > during.txt; sleep 4")
    const waiting = await until((state) => (state.note ?? "").includes("merge"), "status")
    expect(waiting.note).toBe("a merge is in progress; checkpoints wait for it")
    // the periodic ones wait: nothing yet
    expect(await revParse(work, CHECKPOINT_REF)).toBeNull()
    await write(dir, "control/stop", "")
    await proc.exited
    // the last one is taken anyway (M2), through the throwaway index: the work in the middle of the merge is in it
    const final = await stateOf("status")
    expect(final).toMatchObject({ supervisor: "stopped", final: "done" })
    const checkpoint = (await revParse(work, CHECKPOINT_REF))!
    expect(final.checkpoint).toBe(checkpoint)
    expect(sh(["git", "show", `${checkpoint}:during.txt`], work)).toBe("more work during the merge")
    expect(sh(["git", "show", `${checkpoint}:README.md`], work)).toBe("resolved by hand")
    expect(sh(["git", "log", "-1", "--format=%s", checkpoint], work)).toContain("in the middle of a merge")
    // and nothing was concluded for the agent: its branch where it left it, the merge still open, the conflict unresolved
    expect(sh(["git", "rev-parse", "kyora/mg"], work)).toBe(ours)
    expect(sh(["git", "rev-parse", `${checkpoint}^1`], work)).toBe(ours)
    expect(existsSync(join(work, ".git", "MERGE_HEAD"))).toBe(true)
    expect(sh(["git", "ls-files", "-u"], work)).not.toBe("")
    expect(snap.commit).not.toBe(ours)
  }, 90_000)

  test("a last checkpoint that can't be taken says so (final=skipped), and pull keeps the sandbox for it (M2)", async () => {
    const { work, dir, supervise, stateOf, until } = await vmBox("dt")
    // the agent leaves its branch for a detached HEAD (a rebase does), with work in the tree
    const proc = supervise("git checkout -q --detach; echo wip > wip.txt; sleep 4")
    await until((state) => (state.note ?? "").includes("not on"), "status")
    await write(dir, "control/stop", "")
    await proc.exited
    const final = await stateOf("status")
    expect(final.supervisor).toBe("stopped")
    expect(final.final).toBe("skipped: HEAD is not on refs/heads/kyora/dt")
    expect(existsSync(join(work, "wip.txt"))).toBe(true)
  }, 90_000)

  test("the first checkpoint builds on the snapshot the laptop has, even after the agent undid it (m1)", async () => {
    const { repo, snap, work, dir, supervise, until, exported: current } = await vmBox("rs")
    const proc = supervise("git reset -q --soft HEAD~1; echo more >> src/app.ts; sleep 3")
    const done = await until((state) => state.agent === "exited")
    expect(sh(["git", "merge-base", "--is-ancestor", snap.commit, done.checkpoint!], work)).toBe("")
    await write(dir, "control/stop", "")
    await proc.exited
    expect((await importBundle(repo, join((await current())!, "history.bundle"), "rs")).kind).toBe("fast-forward")
  }, 90_000)

  test("checkpoints made before the agent's own commits still fast-forward on the laptop", async () => {
    const { repo, work, dir, supervise, until, exported: current } = await vmBox("ff2")
    // uncommitted work (checkpointed), then, once the laptop pulled that, a commit of its own on top, then more uncommitted work
    const go = join(dir, "..", "go")
    const agent = `echo one > a.txt; while [ ! -e "${go}" ]; do sleep 0.2; done; git add -A; git commit -qm "agent: one"; echo two > b.txt; sleep 2`
    const proc = supervise(agent)
    const first = await until((state) => state.checkpoint !== null && state.agent === "running")
    await write(dir, "control/sync-1", "")
    await until((state) => state.seq === 1)
    const one = await importBundle(repo, join((await current())!, "history.bundle"), "ff2")
    expect(one.kind).toBe("fast-forward")
    await write(go, "", "")
    const second = await until((state) => state.agent === "exited")
    expect(second.checkpoint).not.toBe(first.checkpoint)
    await write(dir, "control/stop", "")
    await proc.exited
    const two = await importBundle(repo, join((await current())!, "history.bundle"), "ff2")
    expect(two).toMatchObject({ kind: "fast-forward" })
    const tip = await revParse(repo, branchRef("ff2"))
    expect(sh(["git", "show", `${tip}:a.txt`], repo)).toBe("one")
    expect(sh(["git", "show", `${tip}:b.txt`], repo)).toBe("two")
    expect(sh(["git", "log", "--format=%s", `kyora/ff2`], repo)).toContain("agent: one")
    expect(sh(["git", "rev-parse", "kyora/ff2"], work)).not.toBe(tip)
  }, 90_000)

  test("a reader never sees a missing or half-swapped export, however fast exports come", async () => {
    const { dir, transcript, supervise, until: waitForState } = await vmBox("hammer")
    // an agent that keeps changing files and talking, so every export differs from the last
    const agent = `trap 'exit 130' INT; for i in $(seq 1 3000); do echo "$i" > churn.txt; echo "{\\"n\\":$i}" >> "$HOME/${transcript}"; sleep 0.03; done`
    // generations a status state named go 2 s after it moved on: pruning runs all through the test
    const proc = supervise(agent, { KYORA_EXPORT_KEEP_S: "2", KYORA_SESSION_TICK_S: "0.2" })
    expect((await waitForState((state) => state.export !== null, "status")).export).not.toBeNull()
    const failures: string[] = []
    const seen = new Set<number>()
    let reads = 0
    let syncs = 0
    const started = Date.now()
    const deadline = started + 30_000
    const sampling = () => Date.now() < deadline && (Date.now() < started + 8_000 || reads <= 20 || seen.size <= 2)
    const out = await temp("session-reader")
    // the laptop asks for a fresh export every 100 ms
    const signaller = (async () => {
      while (sampling()) {
        await write(dir, `control/sync-${++syncs}`, "")
        await Bun.sleep(100)
      }
    })()
    // and reads, as a pull does: the status state, then the generation it names, packed the way the host serves a download
    const reader = (async () => {
      while (sampling()) {
        const status = parseState(await readFile(join(dir, "status", "state"), "utf8").catch(() => ""))
        if (status.export === null) {
          await Bun.sleep(20)
          continue
        }
        const name = `export.${status.export}`
        const packed = Bun.spawnSync(["tar", "-cf", "-", "-C", dir, name], { stdout: "pipe", stderr: "pipe" })
        if (packed.exitCode !== 0) failures.push(`${name}: ${packed.stderr.toString().trim()}`)
        else {
          await rm(join(out, name), { recursive: true, force: true })
          Bun.spawnSync(["tar", "-xf", "-", "-C", out], { stdin: packed.stdout, stdout: "pipe", stderr: "pipe" })
          if (!(await verifyExport(join(out, name), status.export))) failures.push(`${name}: not whole`)
          seen.add(status.export)
          reads++
        }
      }
    })()
    await Promise.all([signaller, reader])
    const stopping = Date.now()
    await write(dir, "control/stop", "")
    await proc.exited
    expect(Date.now() - stopping).toBeLessThan(15_000)
    expect(failures).toEqual([])
    expect(reads).toBeGreaterThan(20)
    expect(seen.size).toBeGreaterThan(2)
    // older generations did go meanwhile
    const left = (await readdir(dir)).filter((entry) => /^export\.\d+$/.test(entry)).map((entry) => Number(entry.slice("export.".length)))
    expect(Math.min(...left)).toBeGreaterThan(1)
    expect(left.length).toBeLessThan(Math.max(...left))
  }, 90_000)

  test("an export that can't be made whole is no export: the stop says final=skipped, nothing incomplete is kept or reported (third review)", async () => {
    const { dir, supervise, stateOf, work } = await vmBox("nb")
    // a git that can't write a bundle (as on a full disk), and is git for everything else
    const bin = await temp("session-fakebin")
    const real = sh(["sh", "-c", "command -v git"])
    await write(bin, "git", `#!/bin/sh\nfor a in "$@"; do [ "$a" = bundle ] && { echo "no space left on device" >&2; exit 128; }; done\nexec "${real}" "$@"\n`, 0o755)
    const sink = reportSink()
    try {
      const proc = supervise("echo work > feature.txt; git add feature.txt; git commit -qm feature; sleep 1", {
        PATH: `${bin}:${process.env.PATH}`,
        KYORA_SESSION_API: sink.api,
        KYORA_SESSION_TOKEN: "kys_fake",
      })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && (await stateOf("status")).agent !== "exited") await Bun.sleep(150)
      await write(dir, "control/stop", "")
      await proc.exited
      const final = await stateOf("status")
      expect(final.supervisor).toBe("stopped")
      expect(final.final).toBe("skipped: the export failed (the bundle of its commits could not be written)")
      // no generation without its bundle was ever made, and none reached kyora cloud
      expect(final.export).toBeNull()
      expect((await readdir(dir)).filter((entry) => entry.startsWith("export.") || entry.startsWith("tmp-export"))).toEqual([])
      expect(sink.puts).toEqual([])
      expect(sh(["git", "log", "-1", "--format=%s", "kyora/nb"], work)).toBe("feature")
    } finally {
      sink.stop()
    }
  }, 90_000)

  test("a sync with nothing new is answered by the generation there is; generations are capped by count, kept for keep_s, the newest two always (third review)", async () => {
    const { dir, supervise, stateOf } = await vmBox("gen")
    const statusNow = () => stateOf("status")
    const generations = async () => (await readdir(dir)).filter((entry) => /^export\.\d+$/.test(entry)).map((entry) => Number(entry.slice(7))).sort((a, b) => a - b)
    const ask = async (n: number) => {
      await write(dir, `control/sync-${n}`, "")
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (await statusNow()).seq !== n) await Bun.sleep(50)
      return statusNow()
    }
    // an agent that changes nothing until told to, then a file per `touch`
    const go = join(dir, "..", "go")
    const proc = supervise(`trap 'exit 130' INT; n=0; while [ $n -lt 2400 ]; do n=$((n+1)); if [ -e "${go}" ]; then rm -f "${go}"; date +%s%N >> churn.txt; fi; sleep 0.05; done`, { KYORA_SESSION_TICK_S: "0.1", KYORA_CHECKPOINT_S: "3600", KYORA_EXPORT_KEEP_S: "3600", KYORA_EXPORT_KEEP_MAX: "4" })
    try {
      const first = await ask(1)
      expect(first.export).not.toBeNull()
      // nothing changed: the same generation answers, however many times the laptop asks
      for (let n = 2; n <= 5; n++) expect((await ask(n)).export).toBe(first.export)
      expect(await generations()).toEqual([first.export!])
      // something changes before each: a generation each, and every one the state named within keep_s stays, cap or not (fourth review)
      let named = first.export!
      const told: number[] = [named]
      for (let n = 6; n <= 11; n++) {
        await write(go, "", "")
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && existsSync(go)) await Bun.sleep(20)
        const state = await ask(n)
        expect(state.export).toBeGreaterThan(named)
        named = state.export!
        told.push(named)
      }
      expect(await generations()).toEqual(told)
    } finally {
      await write(dir, "control/stop", "")
      await proc.exited
    }
  }, 60_000)

  test("past the count cap, the oldest generations nobody was told about lately go: those a supervisor before this one left (fourth review)", async () => {
    const { dir, supervise, stateOf } = await vmBox("cap")
    // a supervisor before this one left five generations, the state naming the last
    for (let k = 1; k <= 5; k++) await write(dir, `export.${k}/state`, `export=${k}\n`)
    await write(dir, "status/state", "seq=0\nexport=5\n")
    await write(dir, "tmp-export.999/half", "x")
    const go = join(dir, "..", "go")
    const proc = supervise(`trap 'exit 130' INT; n=0; while [ $n -lt 2400 ]; do n=$((n+1)); if [ -e "${go}" ]; then rm -f "${go}"; date +%s%N >> churn.txt; fi; sleep 0.05; done`, { KYORA_SESSION_TICK_S: "0.1", KYORA_CHECKPOINT_S: "3600", KYORA_EXPORT_KEEP_S: "3600", KYORA_EXPORT_KEEP_MAX: "3" })
    try {
      await write(go, "", "")
      const settle = Date.now() + 5_000
      while (Date.now() < settle && existsSync(go)) await Bun.sleep(20)
      await write(dir, "control/sync-1", "")
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (await stateOf("status")).seq !== 1) await Bun.sleep(50)
      expect((await stateOf("status")).export).toBe(6)
      const kept = (await readdir(dir)).filter((entry) => /^export\.\d+$/.test(entry)).map((entry) => Number(entry.slice(7))).sort((a, b) => a - b)
      // 5 was named a moment ago (kept for keep_s), 6 is the newest; the leftovers go oldest first down to the cap
      expect(kept).toEqual([4, 5, 6])
      expect(existsSync(join(dir, "tmp-export.999"))).toBe(false)
    } finally {
      await write(dir, "control/stop", "")
      await proc.exited
    }
  }, 60_000)

  test("a sync answers with a new generation when only the subagents' transcripts moved (fourth review)", async () => {
    const { dir, home, transcript, supervise, stateOf } = await vmBox("extra")
    const extra = transcript.replace(/\.jsonl$/, "")
    await write(home, `${extra}/subagents/agent-1.jsonl`, '{"n":0}\n')
    const go = join(dir, "..", "go")
    const proc = supervise(`trap 'exit 130' INT; n=0; while [ $n -lt 2400 ]; do n=$((n+1)); if [ -e "${go}" ]; then rm -f "${go}"; echo '{"n":1}' >> "$HOME/${extra}/subagents/agent-1.jsonl"; fi; sleep 0.05; done`, { KYORA_SESSION_TICK_S: "0.1", KYORA_CHECKPOINT_S: "3600", KYORA_SESSION_EXTRA: extra })
    try {
      const ask = async (n: number) => {
        await write(dir, `control/sync-${n}`, "")
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && (await stateOf("status")).seq !== n) await Bun.sleep(50)
        return (await stateOf("status")).export
      }
      const first = await ask(1)
      expect(await ask(2)).toBe(first)
      await write(go, "", "")
      const settle = Date.now() + 5_000
      while (Date.now() < settle && existsSync(go)) await Bun.sleep(20)
      const next = await ask(3)
      expect(next).toBeGreaterThan(first!)
      expect(await readFile(join(dir, `export.${next}`, "home", extra, "subagents", "agent-1.jsonl"), "utf8")).toContain('"n":1')
    } finally {
      await write(dir, "control/stop", "")
      await proc.exited
    }
  }, 60_000)

  test("a stop whose export fails keeps the newest whole generation, and the state names one that exists; nothing changed since it: final=done (fourth review)", async () => {
    // the agent commits and exits; its export goes out; the conversation moves on (the report's answer appends to it here),
    // and then the stop's export fails (a git that can write one bundle and no more: a disk filling up)
    const { dir, home, transcript, supervise, stateOf } = await vmBox("mr")
    const bin = await temp("session-fakebin")
    const real = sh(["sh", "-c", "command -v git"])
    const counter = join(bin, "bundles")
    await write(bin, "git", `#!/bin/sh\nfor a in "$@"; do if [ "$a" = bundle ]; then n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n + 1)) > "${counter}"; [ "$n" -ge 1 ] && { echo "no space left on device" >&2; exit 128; }; fi; done\nexec "${real}" "$@"\n`, 0o755)
    let reported!: () => void
    const answered = new Promise<void>((resolve) => reported = resolve)
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.arrayBuffer()
        await Bun.write(join(home, transcript), `${await Bun.file(join(home, transcript)).text()}{"after":"the export"}\n`)
        reported()
        return Response.json({ ok: true })
      },
    })
    try {
      const proc = supervise("echo result > result.txt; git add result.txt; git commit -qm result; exit 0", {
        PATH: `${bin}:${process.env.PATH}`,
        KYORA_CHECKPOINT_S: "3600",
        KYORA_SESSION_API: `http://127.0.0.1:${server.port}/v1/sessions/ses_x`,
        KYORA_SESSION_TOKEN: "kys_fake",
      })
      // the stop comes after the agent's exit was exported and reported: a stop the supervisor sees first takes that export itself
      await Promise.race([answered, proc.exited])
      await write(dir, "control/stop", "")
      await proc.exited
      const final = await stateOf("status")
      expect(final.final).toBe("skipped: the export failed (the bundle of its commits could not be written)")
      expect(final.export).toBe(1)
      expect(await verifyExport(join(dir, "export.1"), 1)).toBe(true)
    } finally {
      server.stop(true)
    }
    // and with nothing changed after the agent's own export, the stop takes that one: no second bundle needed
    const again = await vmBox("mr2")
    const bin2 = await temp("session-fakebin")
    const counter2 = join(bin2, "bundles")
    await write(bin2, "git", `#!/bin/sh\nfor a in "$@"; do if [ "$a" = bundle ]; then n=$(cat "${counter2}" 2>/dev/null || echo 0); echo $((n + 1)) > "${counter2}"; [ "$n" -ge 1 ] && { echo "no space left on device" >&2; exit 128; }; fi; done\nexec "${real}" "$@"\n`, 0o755)
    const proc2 = again.supervise(`echo result > result.txt; git add result.txt; git commit -qm result; touch "${again.dir}/control/stop"; exit 0`, { PATH: `${bin2}:${process.env.PATH}`, KYORA_CHECKPOINT_S: "3600" })
    await proc2.exited
    const final2 = await again.stateOf("status")
    expect(final2).toMatchObject({ supervisor: "stopped", final: "done", export: 1 })
    expect(await verifyExport(join(again.dir, "export.1"), 1)).toBe(true)
  }, 60_000)

  test("generations out of date for keep_s go, but never the newest two (third review)", async () => {
    const { dir, supervise, stateOf } = await vmBox("keep")
    const go = join(dir, "..", "go")
    const proc = supervise(`trap 'exit 130' INT; n=0; while [ $n -lt 2400 ]; do n=$((n+1)); if [ -e "${go}" ]; then rm -f "${go}"; date +%s%N >> churn.txt; fi; sleep 0.05; done`, { KYORA_SESSION_TICK_S: "0.1", KYORA_CHECKPOINT_S: "3600", KYORA_EXPORT_KEEP_S: "0", KYORA_EXPORT_KEEP_MAX: "100" })
    try {
      let named = 0
      for (let n = 1; n <= 6; n++) {
        await write(go, "", "")
        const settle = Date.now() + 5_000
        while (Date.now() < settle && existsSync(go)) await Bun.sleep(20)
        await write(dir, `control/sync-${n}`, "")
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && (await stateOf("status")).seq !== n) await Bun.sleep(50)
        named = (await stateOf("status")).export!
      }
      await Bun.sleep(300)
      const kept = (await readdir(dir)).filter((entry) => /^export\.\d+$/.test(entry)).map((entry) => Number(entry.slice(7))).sort((a, b) => a - b)
      // out of date at once (keep_s 0): only the newest two are left, the named one among them
      expect(kept).toEqual([named - 1, named])
    } finally {
      await write(dir, "control/stop", "")
      await proc.exited
    }
  }, 60_000)

  /** a kyora cloud that records each checkpoint report and answers with `status(req)` */
  function reportSink(status: (body: number, url: URL) => number = () => 200) {
    const puts: Array<{ search: string; bytes: number; at: number }> = []
    const t0 = Date.now()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const bytes = (await request.arrayBuffer()).byteLength
        puts.push({ search: url.search, bytes, at: Date.now() - t0 })
        return Response.json({ ok: true }, { status: status(bytes, url) })
      },
    })
    return { puts, api: `http://127.0.0.1:${server.port}/v1/sessions/ses_x`, stop: () => server.stop(true) }
  }

  test("a conversation that moves on without new commits is reported too (P11)", async () => {
    const { transcript, dir, supervise, stateOf } = await vmBox("tx")
    const sink = reportSink()
    try {
      // it only talks, for a long while: the transcript grows, no file changes, the agent never exits during the test
      const agent = `trap 'exit 130' INT; for i in $(seq 1 60); do echo "{\\"n\\":$i}" >> "$HOME/${transcript}"; sleep 0.5; done`
      const proc = supervise(agent, { KYORA_SESSION_API: sink.api, KYORA_SESSION_TOKEN: "kys_fake", KYORA_REPORT_MIN_S: "1", KYORA_SESSION_TICK_S: "0.2" })
      // generous under load: the agent talks for 30 s, and three reports come long before that on an idle machine
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline && sink.puts.length < 3) await Bun.sleep(200)
      // three reports while it still talks: one for the first checkpoint, the rest for the transcript alone
      expect(sink.puts.length).toBeGreaterThanOrEqual(3)
      expect((await stateOf("status")).agent).toBe("running")
      expect(sink.puts.every((put) => put.bytes > 0 && !put.search.includes("tooLarge"))).toBe(true)
      await write(dir, "control/stop", "")
      await proc.exited
    } finally {
      sink.stop()
    }
  }, 60_000)

  test("a checkpoint over kyora cloud's limit is measured as the tar it is, reported as too large, and status says so; a 413 is never swallowed", async () => {
    const { dir, transcript, supervise, stateOf } = await vmBox("big")
    const sink = reportSink()
    try {
      // a limit below one tar block: the tar's own size (headers, padding) is what counts
      const proc = supervise(`echo x > big.txt; echo '{"n":1}' >> "$HOME/${transcript}"; sleep 2`, { KYORA_SESSION_API: sink.api, KYORA_SESSION_TOKEN: "kys_fake", KYORA_CHECKPOINT_MAX_BYTES: "4096" })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && !sink.puts.some((put) => put.search.includes("tooLarge=1"))) await Bun.sleep(200)
      await write(dir, "control/stop", "")
      await proc.exited
      expect(sink.puts.length).toBeGreaterThan(0)
      expect(sink.puts.every((put) => put.search.includes("tooLarge=1") && put.bytes === 0)).toBe(true)
      expect((await stateOf("status")).report).toContain("too large for kyora cloud to keep")
    } finally {
      sink.stop()
    }
    // kyora cloud's own 413 (its limit, whatever the VM measured) turns into a tooLarge report too
    const second = await vmBox("big2")
    const refusing = reportSink((bytes) => (bytes > 0 ? 413 : 200))
    try {
      const proc = second.supervise(`echo y > y.txt; sleep 2`, { KYORA_SESSION_API: refusing.api, KYORA_SESSION_TOKEN: "kys_fake" })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && !refusing.puts.some((put) => put.search.includes("tooLarge=1"))) await Bun.sleep(200)
      await write(second.dir, "control/stop", "")
      await proc.exited
      expect(refusing.puts.some((put) => put.bytes > 0)).toBe(true)
      expect(refusing.puts.some((put) => put.search.includes("tooLarge=1"))).toBe(true)
      expect((await second.stateOf("status")).report).toContain("too large")
    } finally {
      refusing.stop()
    }
  }, 90_000)
})

describe("kyora-switch slots", () => {
  test("read as kyora-switch writes them, fingerprinted, and handed back in the same format", async () => {
    const root = process.env.KYORA_SWITCH_DIR!
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-a", refreshToken: "sk-ant-ort01-r", expiresAt: 1, scopes: ["user:inference"] } })
    await write(root, "claude/work/slot.json", JSON.stringify({ name: "work", provider: "claude", identity: { account: "me@example.com" }, createdAt: 1, updatedAt: 2 }))
    await write(root, "claude/work/credentials.json", blob)
    await write(root, "claude/work/account.json", "{}\n")
    const slot = (await readSlot("claude", "work"))!
    expect(slot.identity.account).toBe("me@example.com")
    const credential = slotCredential(slot)
    expect(credential).toMatchObject({ kind: "oauth", credential: blob, fingerprint: fingerprintOf("sk-ant-ort01-r") })
    expect(credential.fingerprint).not.toContain("sk-ant")
    const rotated = blob.replace("ort01-r", "ort01-r2")
    await writeBackSlot("claude", "work", "credentials.json", rotated, 99)
    expect(await readFile(join(root, "claude/work/credentials.json"), "utf8")).toBe(rotated)
    expect(JSON.parse(await readFile(join(root, "claude/work/slot.json"), "utf8"))).toEqual({ name: "work", provider: "claude", identity: { account: "me@example.com" }, createdAt: 1, updatedAt: 99 })
    expect((await stat(join(root, "claude/work/credentials.json"))).mode & 0o777).toBe(0o600)
    await expect(readSlot("claude", "../etc")).rejects.toThrow(/invalid slot name/)
  })
})

describe("the refresh-rotation guard, on the laptop", () => {
  const blob = (refresh: string) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-${refresh}`, refreshToken: `sk-ant-ort01-${refresh}`, expiresAt: 1 } })

  /** kyora cloud's credential routes, in memory: what was uploaded, and what `return` hands back; `refuse` plays its 409 credential_owned */
  function fakePlatform(returned: (name: string) => string, refuse: (name: string, body: Record<string, unknown>) => boolean = () => false) {
    const uploads = new Map<string, Record<string, unknown>>()
    const bodies: Array<Record<string, unknown>> = []
    const versions = new Map<string, number>()
    const handedBack = new Set<string>()
    const view = (name: string, body: Record<string, unknown>) => ({ provider: "claude", name, kind: body.kind ?? "oauth", fingerprint: body.fingerprint, identity: {}, version: versions.get(name) ?? 1, cloudOwned: !handedBack.has(name), state: "ok" })
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/v1/health") return Response.json({ ok: true, version: "kyora-cloud" })
        if (url.pathname === "/v1/credentials") return Response.json({ credentials: [...uploads].map(([name, body]) => view(name, body)) })
        const match = /^\/v1\/credentials\/claude\/([\w.-]+)(\/return)?$/.exec(url.pathname)
        if (!match) return Response.json({ error: "not_found" }, { status: 404 })
        if (match[2]) {
          handedBack.add(match[1]!)
          return Response.json({ credential: view(match[1]!, { kind: "oauth" }), value: returned(match[1]!) })
        }
        if (request.method === "DELETE") {
          uploads.delete(match[1]!)
          return new Response(null, { status: 204 })
        }
        const body = (await request.json()) as Record<string, unknown>
        bodies.push({ name: match[1], ...body })
        if (refuse(match[1]!, body)) return Response.json({ error: "credential_owned", message: `kyora cloud's broker owns claude/${match[1]}` }, { status: 409 })
        versions.set(match[1]!, (versions.get(match[1]!) ?? 0) + 1)
        uploads.set(match[1]!, body)
        handedBack.delete(match[1]!)
        return Response.json(view(match[1]!, body))
      },
    })
    const api = new VmsClient({ url: `http://localhost:${server.port}`, key: "kyora_test", keySource: "test", urlSource: "test", credentials: "" })
    return { api, uploads, bodies, versions, stop: () => server.stop(true) }
  }

  test("an unchanged slot is skipped only while kyora cloud still holds it: deleted elsewhere, it goes up again (third review)", async () => {
    const platform = fakePlatform(() => "")
    try {
      await slot("work", "A")
      await credsSync(platform.api, { provider: "claude", slots: ["work"], allowLive: false, json: true })
      const sent = platform.bodies.length
      expect(await credsSync(platform.api, { provider: "claude", slots: ["work"], allowLive: false, json: true })).toBe(0)
      expect(platform.bodies).toHaveLength(sent)
      // removed on another laptop (or from the dashboard): the same slot is uploaded again
      platform.uploads.clear()
      expect(await credsSync(platform.api, { provider: "claude", slots: ["work"], allowLive: false, json: true })).toBe(0)
      expect(platform.bodies).toHaveLength(sent + 1)
      expect([...platform.uploads.keys()]).toEqual(["work"])
    } finally {
      platform.stop()
    }
  })

  test("a login whose cloud copy moved on after it was taken back is flagged by creds list (third review)", async () => {
    const platform = fakePlatform(() => blob("ROTATED"))
    try {
      await slot("work", "ORIGINAL")
      await credsSync(platform.api, { provider: "claude", slots: ["work"], allowLive: false, json: true })
      expect(await credsReturn(platform.api, "claude", ["work"], false, true)).toBe(0)
      const notes: string[] = []
      const write_ = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string) => (notes.push(String(chunk)), true)) as typeof process.stderr.write
      const lines: string[] = []
      const log = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(" "))
      try {
        await credsList(platform.api, false)
        expect(notes.join("")).not.toContain("a newer login is available in kyora cloud")
        // the broker's refresh lands after the hand-back: kyora cloud's copy is a version ahead of what came back
        platform.versions.set("work", (platform.versions.get("work") ?? 1) + 1)
        await credsList(platform.api, false)
      } finally {
        process.stderr.write = write_
        console.log = log
      }
      expect(notes.join("")).toContain("claude/work: a newer login is available in kyora cloud")
    } finally {
      platform.stop()
    }
  })

  const meta = async (name: string) => JSON.parse(await readFile(join(process.env.KYORA_SWITCH_DIR!, `claude/${name}/slot.json`), "utf8")) as Record<string, unknown>

  test("sync uploads only the slots it is told to, marks each the broker's as it goes, and a refusal leaves the rest recorded (finding 3, 4)", async () => {
    const platform = fakePlatform(() => "", (name) => name === "b")
    try {
      await slot("a", "A")
      await slot("b", "B")
      await slot("c", "C")
      // no slot named, no --all: nothing goes
      await expect(credsSync(platform.api, { provider: "claude", slots: [], allowLive: false, json: true })).rejects.toThrow(/--slot NAME .* or --all/)
      expect(platform.bodies).toHaveLength(0)
      // every slot: b is refused (the broker owns it and refreshed it), a and c still went, and say so
      expect(await credsSync(platform.api, { provider: "claude", slots: [], all: true, allowLive: false, json: true })).toBe(125)
      expect([...platform.uploads.keys()].sort()).toEqual(["a", "c"])
      expect(await uploadOf("claude/a")).toEqual({ fingerprint: fingerprintOf("sk-ant-ort01-A"), version: 1 })
      expect(await uploadOf("claude/b")).toBeNull()
      expect(await uploadOf("claude/c")).toMatchObject({ version: 1 })
      // the mark kyora-switch goes by: on the slots that went up, not on the refused one; the login itself untouched
      expect((await meta("a")).cloudOwned).toMatchObject({ by: "kyora session creds sync", fingerprint: fingerprintOf("sk-ant-ort01-A") })
      expect((await meta("b")).cloudOwned).toBeUndefined()
      expect((await readSlot("claude", "a"))!.files["credentials.json"]).toBe(blob("A"))
      // once more, the slot unchanged: nothing is sent at all (M1: a re-send could land mid-refresh)
      const sent = platform.bodies.length
      expect(await credsSync(platform.api, { provider: "claude", slots: ["a"], allowLive: false, json: true })).toBe(0)
      expect(platform.bodies).toHaveLength(sent)
      // a new login in the slot: over the version it put there, and --force says so
      await slot("a", "A2")
      await credsSync(platform.api, { provider: "claude", slots: ["a"], allowLive: false, json: true })
      expect(platform.bodies.at(-1)).toMatchObject({ name: "a", expectVersion: 1 })
      expect(platform.bodies.at(-1)!.force).toBeUndefined()
      await credsSync(platform.api, { provider: "claude", slots: ["a"], allowLive: false, force: true, json: true })
      expect(platform.bodies.at(-1)).toMatchObject({ name: "a", expectVersion: 2, force: true })
    } finally {
      platform.stop()
    }
  })

  test("return and rm take the broker's mark off the slot", async () => {
    const platform = fakePlatform(() => blob("ROTATED"))
    try {
      await slot("work", "ORIGINAL")
      await slot("gone", "G")
      await credsSync(platform.api, { provider: "claude", slots: ["work", "gone"], allowLive: false, json: true })
      expect((await readSlot("claude", "work"))!.cloudOwned).not.toBeNull()
      expect(await credsReturn(platform.api, "claude", ["work"], false, true)).toBe(0)
      expect((await meta("work")).cloudOwned).toBeUndefined()
      expect((await readSlot("claude", "work"))!.cloudOwned).toBeNull()
      expect(await credsRemove(platform.api, "claude", ["gone"])).toBe(0)
      expect((await meta("gone")).cloudOwned).toBeUndefined()
      expect(await uploadOf("claude/gone")).toBeNull()
    } finally {
      platform.stop()
    }
  })

  async function slot(name: string, refresh: string) {
    const root = process.env.KYORA_SWITCH_DIR!
    await write(root, `claude/${name}/slot.json`, JSON.stringify({ name, provider: "claude", identity: { account: `${name}@example.com` }, createdAt: 1, updatedAt: 1 }))
    await write(root, `claude/${name}/credentials.json`, blob(refresh))
  }

  beforeEach(async () => {
    for (const dir of [process.env.KYORA_SWITCH_DIR!, process.env.CLAUDE_CONFIG_DIR!, join(process.env.XDG_STATE_HOME!, "kyora")]) await rm(dir, { recursive: true, force: true })
  })

  test("sync refuses the slot this laptop's Claude Code is logged into, and uploads the others read-only", async () => {
    const platform = fakePlatform(() => "")
    try {
      await slot("laptop", "LIVE")
      await slot("cloud", "SEPARATE")
      // the live login: Claude Code's credentials file (the keychain is never read in tests)
      await write(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json", blob("LIVE"))
      const before = await readFile(join(process.env.KYORA_SWITCH_DIR!, "claude/cloud/credentials.json"), "utf8")
      await expect(credsSync(platform.api, { provider: "claude", slots: ["laptop"], allowLive: false, json: true })).rejects.toThrow(/may sign this laptop out/)
      expect(platform.uploads.size).toBe(0)
      expect(await credsSync(platform.api, { provider: "claude", slots: ["cloud"], allowLive: false, json: true })).toBe(0)
      expect(platform.uploads.get("cloud")).toMatchObject({ kind: "oauth", credential: blob("SEPARATE"), fingerprint: fingerprintOf("sk-ant-ort01-SEPARATE") })
      // read only: the slot is as it was
      expect(await readFile(join(process.env.KYORA_SWITCH_DIR!, "claude/cloud/credentials.json"), "utf8")).toBe(before)
    } finally {
      platform.stop()
    }
  })

  test("return writes the broker's rotated login back, unless the slot moved on here meanwhile", async () => {
    const platform = fakePlatform(() => blob("ROTATED-BY-BROKER"))
    try {
      await slot("work", "ORIGINAL")
      await credsSync(platform.api, { provider: "claude", slots: ["work"], allowLive: false, json: true })
      expect(await credsReturn(platform.api, "claude", ["work"], false, true)).toBe(0)
      expect(await readFile(join(process.env.KYORA_SWITCH_DIR!, "claude/work/credentials.json"), "utf8")).toBe(blob("ROTATED-BY-BROKER"))

      // again, but this time the laptop refreshed the slot while the cloud had it: both copies may be spent
      await slot("other", "ORIGINAL")
      await credsSync(platform.api, { provider: "claude", slots: ["other"], allowLive: false, json: true })
      await write(process.env.KYORA_SWITCH_DIR!, "claude/other/credentials.json", blob("REFRESHED-ON-LAPTOP"))
      expect(await credsReturn(platform.api, "claude", ["other"], false, true)).toBe(125)
      expect(await readFile(join(process.env.KYORA_SWITCH_DIR!, "claude/other/credentials.json"), "utf8")).toBe(blob("REFRESHED-ON-LAPTOP"))
      expect(await credsReturn(platform.api, "claude", ["other"], true, true)).toBe(0)
      expect(await readFile(join(process.env.KYORA_SWITCH_DIR!, "claude/other/credentials.json"), "utf8")).toBe(blob("ROTATED-BY-BROKER"))
    } finally {
      platform.stop()
    }
  })
})

describe("local state", () => {
  const state = (name: string, repo: string, driver: "cloud" | "local", agentSession = "a"): SessionState => ({
    version: 1,
    name,
    id: `ses_${name}`,
    url: "https://cloud.kyora.sh",
    repo,
    agent: "claude",
    agentSession,
    local: { id: agentSession, file: "/x", extra: null, hash: "h" },
    remoteFiles: { file: "x", extra: null },
    map: { local: repo, remote: repo },
    mode: "same-path",
    base: "b",
    head: null,
    upstream: "main",
    sandbox: "sb_1",
    exec: null,
    driver,
    createdAt: new Date().toISOString(),
    pulledAt: null,
    stoppedAt: null,
  })

  test("names the one session the cloud drives for a repo, refuses to guess between several", async () => {
    await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
    await saveState(state("one", "/r", "cloud", "conv-1"))
    await saveState(state("two", "/r", "local"))
    expect((await resolveState(undefined, "/r")).name).toBe("one")
    expect((await resolveState("kyora/two", null)).name).toBe("two")
    expect((await drivenFromCloud("conv-1"))?.name).toBe("one")
    expect(await drivenFromCloud("conv-2")).toBeNull()
    await saveState(state("three", "/r", "cloud"))
    await expect(resolveState(undefined, "/r")).rejects.toThrow(/name one/)
    await expect(resolveState("nope", null)).rejects.toThrow(/no session/)
    expect((await stat(join(process.env.XDG_STATE_HOME!, "kyora", "sessions", `one@${repoKey("/r")}.json`))).mode & 0o777).toBe(0o600)
  })
})

describe("attach's rendering", () => {
  test("Claude Code's stream-json, as text", () => {
    expect(renderEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5" }))).toBe("── s · claude-opus-5-5")
    expect(renderEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixing it." }, { type: "tool_use", name: "Bash", input: { command: "bun test\nmore" } }] } }))).toBe("Fixing it.\n▸ Bash: bun test")
    expect(renderEvent(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom\nstack" }] } }))).toBe("  ✗ boom")
    expect(renderEvent(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "fine" }] } }))).toBeNull()
    expect(renderEvent(JSON.stringify({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 1.234, result: "All green." }))).toBe("── done · 3 turns · $1.23\nAll green.")
    expect(renderEvent("plain text")).toBe("plain text")
  })
})

test("the state file the supervisor writes", () => {
  expect(parseState("seq=3\nagent=exited\nagent_exit=0\nsupervisor=running\ncheckpoint=abc\ncheckpoint_at=2026-10-02T00:00:00Z\ntranscript_bytes=10\nnote=\n")).toMatchObject({ seq: 3, agent: "exited", agentExit: 0, checkpoint: "abc", transcriptBytes: 10, note: null })
  expect(parseState("")).toMatchObject({ seq: 0, agentExit: null, agent: "unknown" })
})



// ── review findings (PR #74): each of these failed before its fix ─────────────

describe("what reaches the VM's config (finding 5)", () => {
  const root = "/Users/me/app"

  test("no permission rules, no literal MCP secrets, no personal hooks; ${VAR} references stay (P8)", () => {
    const dropped: string[] = []
    const merged = mergeSettings(
      { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/check.sh" }] }] } },
      {
        permissions: { allow: ["Bash(GITHUB_TOKEN=ghp_FAKEFAKEFAKE gh pr create:*)", "Bash(curl -H 'Authorization: Bearer sk-live-FAKE' api.example.com/*)"] },
        env: { STRIPE_KEY: "sk_live_FAKE" },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "SLACK_TOKEN=xoxb-FAKE notify done" }] }] },
      },
      root,
      dropped,
    )
    const mcp = portableMcp(
      {
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_FAKEFAKE", GITHUB_HOST: "${GITHUB_HOST}" } },
          linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_FAKE", "X-Team": "${LINEAR_TEAM}" } },
        },
      },
      root,
      dropped,
      { all: true, enabled: new Set(), disabled: new Set() },
    )
    const everything = JSON.stringify({ merged, mcp })
    expect(everything).not.toContain("FAKE")
    expect(merged.hooks).toEqual({ PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/check.sh" }] }] })
    expect(mcp.github!.env).toEqual({ GITHUB_HOST: "${GITHUB_HOST}" })
    expect(mcp.linear!.headers).toEqual({ "X-Team": "${LINEAR_TEAM}" })
    const said = dropped.join("\n")
    expect(said).toContain("settings.local.json: permissions")
    expect(said).toContain("settings.local.json: hooks")
    expect(said).toContain("github env GITHUB_PERSONAL_ACCESS_TOKEN")
    expect(said).toContain("linear headers Authorization")
    // the names are listed, never the values
    expect(said).not.toContain("FAKE")
  })

  test("only the servers this user approved go; a repo can't approve its own, and a rejection wins", () => {
    const approval = approvedMcp(
      { enabledMcpjsonServers: ["docs", "remote"] },
      { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["sneaky"], disabledMcpjsonServers: ["remote"] },
      { enabledMcpjsonServers: ["local-ok"] },
    )
    expect(approval.all).toBe(false)
    const dropped: string[] = []
    const kept = portableMcp(
      { mcpServers: { docs: { command: "npx", args: ["@acme/docs"] }, remote: { url: "https://mcp.example.com" }, sneaky: { command: "npx", args: ["x"] }, "local-ok": { command: "npx", args: ["y"] } } },
      root,
      dropped,
      approval,
    )
    expect(Object.keys(kept).sort()).toEqual(["docs", "local-ok"])
    expect(dropped.join("\n")).toContain("remote (disabled")
    expect(dropped.join("\n")).toContain("sneaky (not approved")
    expect(approvedMcp({ enableAllProjectMcpServers: true }, null, null).all).toBe(true)
  })

  test("config reads the approvals from the user's settings, and leaves a gitignored .mcp.json behind", async () => {
    await rm(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true })
    const project = await temp("session-mcp")
    await write(project, ".mcp.json", JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["@acme/docs"] }, other: { command: "npx", args: ["@acme/other"] } } }))
    await write(process.env.CLAUDE_CONFIG_DIR!, "settings.json", JSON.stringify({ enabledMcpjsonServers: ["docs"] }))
    const session = { agent: "claude" as const, id: "0f2b3c4d-1111-4222-8333-944455556666", cwd: project, file: "/dev/null", extra: null, model: null, version: null }
    const tracked = await claudeAdapter.config(session, { local: project, remote: project }, { ignored: async () => false })
    expect(JSON.parse(String(tracked.files.find((f) => f.rel === ".kyora-session/mcp.json")!.contents)).mcpServers).toEqual({ docs: { command: "npx", args: ["@acme/docs"] } })
    const ignored = await claudeAdapter.config(session, { local: project, remote: project }, { ignored: async (rel) => rel === ".mcp.json" })
    expect(JSON.parse(String(ignored.files.find((f) => f.rel === ".kyora-session/mcp.json")!.contents)).mcpServers).toEqual({})
    expect(ignored.dropped.join("\n")).toContain(".mcp.json (gitignored")
  })
})

describe("the project's instructions in the VM (finding 6)", () => {
  async function project() {
    const root = await temp("session-instructions")
    await write(root, "CLAUDE.md", "# root instructions\n@docs/style.md\n")
    await write(root, ".claude/CLAUDE.md", "more instructions\n")
    await write(root, "docs/style.md", "style\n")
    await write(root, ".claude/rules/testing.md", "---\npaths:\n  - \"src/**\"\n---\nuse bun test\n")
    await write(root, "packages/api/CLAUDE.md", "api instructions\n")
    await write(root, ".claude/skills/release/SKILL.md", "---\nname: release\n---\nhow to release\n")
    await write(root, ".claude/skills/release/scripts/tag.sh", "git tag\n")
    await write(root, ".claude/skills/notify/SKILL.md", "---\nname: notify\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: /Users/me/bin/notify\n---\nnotify\n")
    await write(root, ".claude/agents/reviewer.md", "---\nname: reviewer\n---\nreview\n")
    await write(root, ".claude/commands/ship.md", "ship it\n")
    await write(root, ".claude/output-styles/terse.md", "terse\n")
    await write(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "~/notify" }] }] }, env: { ANTHROPIC_BASE_URL: "https://elsewhere" } }))
    const files = (await walkAll(root)).sort()
    return { root, files }
  }

  async function walkAll(root: string, prefix = ""): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...(await walkAll(root, rel)))
      else out.push(rel)
    }
    return out
  }

  test("CLAUDE.md files imported from user memory, rules, nested ones, skills, agents, commands and styles copied; the repo's settings still only filtered", async () => {
    const { root, files } = await project()
    const session = { agent: "claude" as const, id: "0f2b3c4d-1111-4222-8333-944455556666", cwd: root, file: "/dev/null", extra: null, model: null, version: null }
    const config = await claudeAdapter.config(session, { local: root, remote: root }, { ignored: async () => false, files: async () => files })
    const staged = Object.fromEntries(config.files.map((file) => [file.rel, String(file.contents)]))
    // read in place from the repo, imports inside them as they are
    expect(staged[".claude/CLAUDE.md"]).toContain(`@${root}/CLAUDE.md`)
    expect(staged[".claude/CLAUDE.md"]).toContain(`@${root}/.claude/CLAUDE.md`)
    expect(staged[".claude/rules/kyora-project/root/testing.md"]).toContain('paths:\n  - "src/**"')
    // a nested CLAUDE.md loads when the agent works under it
    expect(staged[".claude/rules/kyora-project/nested/packages-api-CLAUDE-md.md"]).toBe(`---\npaths:\n  - "packages/api/**"\n---\n@${root}/packages/api/CLAUDE.md\n`)
    expect(staged[".claude/skills/release/SKILL.md"]).toContain("how to release")
    expect(staged[".claude/skills/release/scripts/tag.sh"]).toBe("git tag\n")
    expect(staged[".claude/agents/reviewer.md"]).toContain("review")
    expect(staged[".claude/commands/ship.md"]).toBe("ship it\n")
    expect(staged[".claude/output-styles/terse.md"]).toBe("terse\n")
    // a skill whose hooks run a laptop-only program stays behind, whole
    expect(Object.keys(staged).filter((rel) => rel.includes("notify"))).toEqual([])
    expect(config.dropped.join("\n")).toContain(".claude/skills/notify/ (a hook names /Users/me/bin/notify")
    // the repo's own settings, hooks and env never apply as they are: only the filtered copy, and project sources stay off
    expect(config.args.slice(0, 2)).toEqual(["--setting-sources", "user"])
    expect(staged[".claude/settings.json"]).not.toContain("elsewhere")
    expect(staged[".claude/settings.json"]).not.toContain("~/notify")
  })

  test("a mapped session imports the repo at /work", async () => {
    const { root, files } = await project()
    const session = { agent: "claude" as const, id: "0f2b3c4d-1111-4222-8333-944455556666", cwd: root, file: "/dev/null", extra: null, model: null, version: null }
    const config = await claudeAdapter.config(session, { local: root, remote: "/work" }, { ignored: async () => false, files: async () => files })
    const memory = String(config.files.find((file) => file.rel === ".claude/CLAUDE.md")!.contents)
    expect(memory).toContain("@/work/CLAUDE.md")
    expect(memory).not.toContain(root)
  })
})

describe("the live login's keychain item (finding 12)", () => {
  const hash8 = (dir: string) => createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)

  test("the service Claude Code 2.1.288 uses: suffixed by the config dir's hash when CLAUDE_CONFIG_DIR is set", () => {
    expect(claudeKeychainService({ HOME: "/Users/me" })).toBe("Claude Code-credentials")
    expect(claudeKeychainService({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" })).toBe(`Claude Code-credentials-${hash8("/Users/me/.claude-work")}`)
    // an empty one counts as unset, as in Claude Code
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "" })).toBe("Claude Code-credentials")
    // CLAUDE_SECURESTORAGE_CONFIG_DIR wins: its own hash, or none when empty
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/a", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/b" })).toBe(`Claude Code-credentials-${hash8("/b")}`)
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/a", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })).toBe("Claude Code-credentials")
    expect(claudeKeychainAccount({ USER: "me" })).toBe("me")
    expect(claudeKeychainAccount({ USER: "with space" })).toBe("claude-code-user")
  })

  test("liveClaudeFingerprint asks the keychain for that item (a reader handed in, never the real keychain)", async () => {
    const config = await temp("session-keychain")
    const asked: Array<[string, string]> = []
    const read = async (service: string, account: string) => {
      asked.push([service, account])
      return service.endsWith(hash8(config)) ? JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-LIVE" } }) : null
    }
    const found = await liveClaudeFingerprint({ HOME: "/nowhere", USER: "me", CLAUDE_CONFIG_DIR: config }, { platform: "darwin", read })
    expect(asked).toEqual([[`Claude Code-credentials-${hash8(config)}`, "me"]])
    expect(found).toBe(fingerprintOf("sk-ant-ort01-LIVE"))
    // its credentials file comes first, and no keychain is asked then
    await write(config, ".credentials.json", JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-FILE" } }))
    expect(await liveClaudeFingerprint({ HOME: "/nowhere", USER: "me", CLAUDE_CONFIG_DIR: config }, { platform: "darwin", read })).toBe(fingerprintOf("sk-ant-ort01-FILE"))
    expect(asked).toHaveLength(1)
    // not on Linux, and not without a reader under KYORA_SWITCH_NO_KEYCHAIN
    expect(await liveClaudeFingerprint({ HOME: "/nowhere", CLAUDE_CONFIG_DIR: "/missing" }, { platform: "linux", read })).toBeNull()
    expect(await liveClaudeFingerprint({ HOME: "/nowhere", CLAUDE_CONFIG_DIR: "/missing", KYORA_SWITCH_NO_KEYCHAIN: "1" }, { platform: "darwin" })).toBeNull()
  })
})

describe("untracked files going up (finding 13)", () => {
  test("listed, and the ones named like secrets singled out", async () => {
    const repo = await repoWithChanges()
    await write(repo, ".env.local", "TOKEN=x\n")
    await write(repo, "certs/server.pem", "pem\n")
    await write(repo, "deploy/id_ed25519", "key\n")
    await write(repo, "config/app.key", "key\n")
    const { files, secrets } = await untrackedFiles(repo)
    expect(files).toContain("notes/todo.md")
    // ignored ones (secret.env, build/) never went up
    expect(files).not.toContain("secret.env")
    expect(secrets.sort()).toEqual([".env.local", "certs/server.pem", "config/app.key", "deploy/id_ed25519"])
    expect(secrets).not.toContain("notes/todo.md")
  })
})

describe("session state per repo (finding 14)", () => {
  const state = (name: string, repo: string): SessionState => ({
    version: 1,
    name,
    id: `ses_${name}_${repo.length}`,
    url: "https://cloud.kyora.sh",
    repo,
    agent: "claude",
    agentSession: `conv-${repo}`,
    local: { id: `conv-${repo}`, file: "/x", extra: null, hash: "h" },
    remoteFiles: { file: "x", extra: null },
    map: { local: repo, remote: repo },
    mode: "same-path",
    base: "b",
    head: null,
    upstream: "main",
    sandbox: `sb_${repo.length}`,
    exec: null,
    driver: "cloud",
    createdAt: new Date().toISOString(),
    pulledAt: null,
    stoppedAt: null,
  })
  const dir = () => join(process.env.XDG_STATE_HOME!, "kyora", "sessions")

  test("one name in two repos: both kept, each found from its own repo", async () => {
    await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
    await saveState(state("s1", "/repo/one"))
    await saveState(state("s1", "/repo/two"))
    expect((await resolveState("s1", "/repo/one")).sandbox).toBe(`sb_${"/repo/one".length}`)
    expect((await resolveState("s1", "/repo/two")).id).toBe(`ses_s1_${"/repo/two".length}`)
    await expect(resolveState("s1", null)).rejects.toThrow(/2 repos/)
    expect((await readdir(dir())).sort()).toEqual([`s1@${repoKey("/repo/one")}.json`, `s1@${repoKey("/repo/two")}.json`].sort())
  })

  test("a state file from before (named by the session alone) is moved over", async () => {
    await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
    await write(dir(), "old.json", `${JSON.stringify(state("old", "/repo/legacy"))}\n`)
    expect((await resolveState("old", "/repo/legacy")).repo).toBe("/repo/legacy")
    expect(await readdir(dir())).toEqual([`old@${repoKey("/repo/legacy")}.json`])
  })
})

/** an export generation as the supervisor lays it out in a fake sandbox, and the status state naming it */
async function fakeExport(box: string, generation: number, state: string): Promise<void> {
  const text = `${state}export=${generation}\n`
  await write(box, `tmp/kyora-session/export.${generation}/state`, text)
  await write(box, `tmp/kyora-session/export.${generation}/manifest`, `${Buffer.byteLength(text)} state\n`)
  await write(box, "tmp/kyora-session/status/state", text)
}

test("verifyExport: the state names the generation, every listed file is there at its size, and commits past the snapshot come with their bundle (third review)", async () => {
  const dir = await temp("session-verify")
  const state = (extra: string) => `seq=1\nexport=3\nbase=${"a".repeat(40)}\n${extra}`
  const lay = async (stateText: string, files: Record<string, string>, sizes: Record<string, number> = {}) => {
    await rm(dir, { recursive: true, force: true })
    const all = { state: stateText, ...files }
    for (const [rel, text] of Object.entries(all)) await write(dir, rel, text)
    await write(dir, "manifest", Object.entries(all).map(([rel, text]) => `${sizes[rel] ?? Buffer.byteLength(text)} ${rel}`).join("\n") + "\n")
  }
  await lay(state(`checkpoint=${"a".repeat(40)}\n`), { "home/t.jsonl": "{}\n" })
  expect(await verifyExport(dir, 3)).toBe(true)
  expect(await verifyExport(dir, 4)).toBe(false)
  // a file shorter than its manifest says (a cut download, a copy that ran out of room)
  await lay(state(""), { "home/t.jsonl": "{}\n" }, { "home/t.jsonl": 99 })
  expect(await verifyExport(dir, 3)).toBe(false)
  // a checkpoint past the snapshot, and no bundle in it: not whole, whatever its manifest says
  await lay(state(`checkpoint=${"b".repeat(40)}\n`), { "home/t.jsonl": "{}\n" })
  expect(await verifyExport(dir, 3)).toBe(false)
  await lay(state(`checkpoint=${"b".repeat(40)}\n`), { "home/t.jsonl": "{}\n", "history.bundle": "bundle" })
  expect(await verifyExport(dir, 3)).toBe(true)
})

describe("pull --stop keeps a sandbox whose last checkpoint wasn't confirmed (finding 10)", () => {
  test("not confirmed: nothing destroyed, a failure and a hint; confirmed or --force: destroyed", async () => {
    await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
    const vmd = await startFakeVmd()
    try {
      const api = new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "" })
      const repo = await repoWithChanges()
      const sandbox = await api.create({ network: "registries" }, { wait: 0 })
      const box = vmd.sandboxes.get(sandbox.id)!.root
      // the export the supervisor made last; its status says it is still running (no answer to the stop yet)
      await fakeExport(box, 1, "seq=0\nagent=running\nsupervisor=running\n")
      const transcript = join(await temp("session-pull"), "t.jsonl")
      await write(transcript, "", "{}\n")
      await saveState({
        version: 1,
        name: "st",
        id: sandbox.id,
        url: vmd.url,
        repo,
        agent: "claude",
        agentSession: "0f2b3c4d-1111-4222-8333-944455556666",
        local: { id: "0f2b3c4d-1111-4222-8333-944455556666", file: transcript, extra: null, hash: "h" },
        remoteFiles: { file: ".claude/projects/x/t.jsonl", extra: null },
        map: { local: repo, remote: repo },
        mode: "same-path",
        base: "b",
        head: null,
        upstream: "main",
        sandbox: sandbox.id,
        exec: null,
        driver: "cloud",
        createdAt: new Date().toISOString(),
        pulledAt: null,
        stoppedAt: null,
      })
      expect(await pullSession(api, { name: "st", repo, stop: true, pr: false, json: true, confirmMs: 300 })).toBe(125)
      expect(vmd.destroyed).toEqual([])
      expect((await resolveState("st", repo)).driver).toBe("cloud")
      // the supervisor confirms: the next --stop destroys it
      // stopped, but its last checkpoint skipped: still kept (M2)
      await fakeExport(box, 2, "seq=0\nagent=stopped\nsupervisor=stopped\nfinal=skipped: HEAD is not on refs/heads/kyora/st\n")
      expect(await pullSession(api, { name: "st", repo, stop: true, pr: false, json: true, confirmMs: 300 })).toBe(125)
      expect(vmd.destroyed).toEqual([])
      await fakeExport(box, 3, "seq=0\nagent=stopped\nsupervisor=stopped\nfinal=done\n")
      expect(await pullSession(api, { name: "st", repo, stop: true, pr: false, json: true, confirmMs: 300 })).toBe(0)
      expect(vmd.destroyed).toEqual([sandbox.id])
      expect((await resolveState("st", repo)).driver).toBe("local")
      // --force destroys one that never confirmed
      const other = await api.create({ network: "registries" }, { wait: 0 })
      const otherBox = vmd.sandboxes.get(other.id)!.root
      await fakeExport(otherBox, 1, "seq=0\nagent=running\nsupervisor=running\n")
      await saveState({ ...(await resolveState("st", repo)), name: "st2", sandbox: other.id, id: other.id, driver: "cloud", stoppedAt: null })
      expect(await pullSession(api, { name: "st2", repo, stop: true, force: true, pr: false, json: true, confirmMs: 300 })).toBe(0)
      expect(vmd.destroyed).toEqual([sandbox.id, other.id])
      // a sandbox that is there but can't take the stop (409) has confirmed nothing: kept
      const third = await api.create({ network: "registries" }, { wait: 0 })
      await fakeExport(vmd.sandboxes.get(third.id)!.root, 1, "seq=0\nagent=stopped\nsupervisor=stopped\nfinal=done\n")
      await saveState({ ...(await resolveState("st", repo)), name: "st3", sandbox: third.id, id: third.id, driver: "cloud", stoppedAt: null })
      vmd.options.refuseUpload = () => Response.json({ error: "busy", message: "not now" }, { status: 409 })
      expect(await pullSession(api, { name: "st3", repo, stop: true, pr: false, json: true, confirmMs: 300 })).toBe(125)
      expect(vmd.destroyed).toEqual([sandbox.id, other.id])
      vmd.options.refuseUpload = undefined
    } finally {
      await vmd.stop()
    }
  }, 90_000)
})

test("pull with no export to take says so, and keeps the sandbox (fourth review)", async () => {
  await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
  const vmd = await startFakeVmd()
  try {
    const api = new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "" })
    const repo = await repoWithChanges()
    const sandbox = await api.create({ network: "registries" }, { wait: 0 })
    // the state names a generation that isn't there (and nothing else is)
    await write(vmd.sandboxes.get(sandbox.id)!.root, "tmp/kyora-session/status/state", "seq=0\nagent=stopped\nsupervisor=stopped\nexport=7\nfinal=skipped: the export failed (no room)\n")
    const transcript = join(await temp("session-pull"), "t.jsonl")
    await write(transcript, "", "{}\n")
    await saveState({
      version: 1, name: "ne", id: sandbox.id, url: vmd.url, repo, agent: "claude", agentSession: "0f2b3c4d-1111-4222-8333-944455556666",
      local: { id: "0f2b3c4d-1111-4222-8333-944455556666", file: transcript, extra: null, hash: "h" }, remoteFiles: { file: ".claude/projects/x/t.jsonl", extra: null },
      map: { local: repo, remote: repo }, mode: "same-path", base: "b", head: null, upstream: "main", sandbox: sandbox.id, exec: null,
      driver: "cloud", createdAt: new Date().toISOString(), pulledAt: null, stoppedAt: null,
    })
    await expect(pullSession(api, { name: "ne", repo, stop: true, pr: false, json: true, confirmMs: 300 })).rejects.toThrow(/holds no export \(skipped: the export failed \(no room\)\).*the sandbox is kept/)
    expect(vmd.destroyed).toEqual([])
  } finally {
    await vmd.stop()
  }
}, 90_000)

test("the permission mode the VM's agent gets by default is one constant", () => {
  expect(DEFAULT_PERMISSION_MODE).toBe("bypassPermissions")
})

// ── second review (PR #74) ────────────────────────────────────────────────────

describe("nothing from outside the repo reaches the VM through a symlink in it (M3)", () => {
  test("symlinks out of the repo in .claude/, CLAUDE.md files and settings are left behind; the files themselves stay put", async () => {
    const base = await temp("session-symlinks")
    await write(base, "outside-secret", "-----BEGIN OPENSSH PRIVATE KEY----- LAPTOP-ONLY-SECRET\n")
    await write(base, "outside-rule.md", "LAPTOP-ONLY-RULE\n")
    await write(base, "outside-settings.json", JSON.stringify({ env: { STRIPE: "LAPTOP-ONLY-ENV" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo LAPTOP-ONLY-HOOK" }] }] } }))
    const repo = join(base, "repo")
    sh(["git", "init", "-q", "-b", "main", repo])
    await write(repo, ".claude/skills/helper/SKILL.md", "---\nname: helper\n---\nhelp\n")
    await write(repo, ".claude/skills/helper/inside.txt", "fine\n")
    await write(repo, "docs/real.md", "a real doc\n")
    const { symlink } = await import("node:fs/promises")
    await symlink(join(base, "outside-secret"), join(repo, ".claude/skills/helper/notes.txt"))
    await symlink(join(base, "outside-rule.md"), join(repo, ".claude/rules-link.md"))
    await write(repo, ".claude/rules/keep.md", "keep\n")
    await symlink(join(base, "outside-rule.md"), join(repo, ".claude/rules/style.md"))
    await write(repo, ".claude/commands/.keep", "")
    await symlink("../../../outside-secret", join(repo, ".claude/commands/deploy.md"))
    await symlink(join(base, "outside-secret"), join(repo, "CLAUDE.md"))
    await symlink(join(base, "outside-settings.json"), join(repo, ".claude/settings.json"))
    // a symlink that stays inside the repo is fine
    await write(repo, ".claude/agents/.keep", "")
    await symlink("../../docs/real.md", join(repo, ".claude/agents/doc.md"))
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "-q", "-m", "planted symlinks"], repo)
    const files = sh(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], repo).split("\0").filter(Boolean)
    const session = { agent: "claude" as const, id: "0f2b3c4d-1111-4222-8333-944455556666", cwd: repo, file: "/dev/null", extra: null, model: null, version: null }
    const config = await claudeAdapter.config(session, { local: repo, remote: repo }, { ignored: async () => false, files: async () => files })
    const staged = Object.fromEntries(config.files.map((file) => [file.rel, String(file.contents)]))
    expect(Object.values(staged).join("\n")).not.toContain("LAPTOP-ONLY")
    expect(staged[".claude/CLAUDE.md"]).toBeUndefined()
    expect(staged[".claude/skills/helper/inside.txt"]).toBe("fine\n")
    expect(staged[".claude/skills/helper/notes.txt"]).toBeUndefined()
    expect(staged[".claude/rules/kyora-project/root/keep.md"]).toBe("keep\n")
    expect(staged[".claude/agents/doc.md"]).toBe("a real doc\n")
    const said = config.dropped.join("\n")
    for (const rel of ["CLAUDE.md", ".claude/skills/helper/notes.txt", ".claude/rules/style.md", ".claude/commands/deploy.md"]) expect(said).toContain(`${rel} (a symlink out of the repo)`)
  })
})

describe("secrets in MCP command lines and URLs, and untracked personal files (m6)", () => {
  test("a server whose arguments carry a literal secret stays here; a URL loses its user, password and query", () => {
    const dropped: string[] = []
    const kept = portableMcp(
      {
        mcpServers: {
          flag: { command: "npx", args: ["-y", "srv", "--token", "ghp_ARGSECRET0000"] },
          assigned: { command: "npx", args: ["srv", "--api-key=abc123ARGSECRET"] },
          prefixed: { command: "npx", args: ["srv", "sk-ant-api03-ARGSECRET"] },
          variable: { command: "npx", args: ["srv", "--token", "${GITHUB_TOKEN}"] },
          plain: { command: "npx", args: ["-y", "@acme/docs", "--port", "3000"] },
          web: { type: "http", url: "https://user:URLSECRET@mcp.example.com/mcp?api_key=QSECRET#frag" },
        },
      },
      "/r",
      dropped,
      { all: true, enabled: new Set(), disabled: new Set() },
    )
    expect(Object.keys(kept).sort()).toEqual(["plain", "variable", "web"])
    expect(kept.web!.url).toBe("https://mcp.example.com/mcp")
    expect(JSON.stringify(kept)).not.toContain("SECRET")
    const said = dropped.join("\n")
    expect(said).not.toContain("SECRET")
    expect(said).toContain("flag (its command line carries a secret: --token …")
    expect(said).toContain("assigned (its command line carries a secret: api-key=…")
    expect(said).toContain("web url's user, password and query")
  })

  test("an untracked .claude/settings.local.json never goes up, not even with the snapshot; an untracked .mcp.json is warned about", async () => {
    const repo = await repoWithChanges()
    await write(repo, ".claude/settings.local.json", JSON.stringify({ env: { STRIPE_KEY: "sk_live_LOCALSECRET" } }))
    await write(repo, "packages/api/.claude/settings.local.json", "{}\n")
    await write(repo, ".mcp.json", JSON.stringify({ mcpServers: {} }))
    const { files, secrets, leftOut } = await untrackedFiles(repo)
    expect(leftOut.sort()).toEqual([".claude/settings.local.json", "packages/api/.claude/settings.local.json"])
    expect(files).not.toContain(".claude/settings.local.json")
    expect(secrets).toContain(".mcp.json")
    const snap = await snapshotWorktree(repo, "snapshot", leftOut)
    const tree = sh(["git", "ls-tree", "-r", "--name-only", snap.commit], repo).split("\n")
    expect(tree.filter((file) => file.endsWith("settings.local.json"))).toEqual([])
    expect(tree).toContain(".mcp.json")
    // and the push to the VM leaves them out the same way
    const pushed = (await treeListing(repo, leftOut)).entries.map((entry) => entry.rel)
    expect(pushed.filter((file) => file.endsWith("settings.local.json"))).toEqual([])
    expect(pushed).toContain(".mcp.json")
    // the user's own files are untouched
    expect(await readFile(join(repo, ".claude/settings.local.json"), "utf8")).toContain("LOCALSECRET")
  })

  test("only the untracked ones stay here, by exact path: a tracked settings.local.json goes as it is in the working tree, snapshot and push alike (third review)", async () => {
    const repo = await temp("session-personal")
    sh(["git", "init", "-q", "-b", "main", repo])
    await write(repo, "pkg/.claude/settings.local.json", '{"committed":"old"}\n')
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "-q", "-m", "base"], repo)
    await write(repo, "pkg/.claude/settings.local.json", '{"committed":"edited"}\n')
    await write(repo, "a b/.claude/settings.local.json", "{}\n")
    await write(repo, "[x]/.claude/settings.local.json", "{}\n")
    const { leftOut } = await untrackedFiles(repo)
    expect(leftOut.sort()).toEqual(["[x]/.claude/settings.local.json", "a b/.claude/settings.local.json"])
    const snap = await snapshotWorktree(repo, "snapshot", leftOut)
    const tree = sh(["git", "ls-tree", "-r", "--name-only", snap.commit], repo).split("\n")
    expect(tree.filter((file) => file.endsWith("settings.local.json"))).toEqual(["pkg/.claude/settings.local.json"])
    expect(sh(["git", "show", `${snap.commit}:pkg/.claude/settings.local.json`], repo)).toBe('{"committed":"edited"}')
    expect((await treeListing(repo, leftOut)).entries.map((entry) => entry.rel).filter((file) => file.endsWith("settings.local.json"))).toEqual(["pkg/.claude/settings.local.json"])
  })

  test("a credential in an MCP URL's path keeps the server here (third review)", () => {
    expect(secretInPath("https://actions.zapier.com/mcp/sk-ak-AbCdEf0123456789/sse")).toBe(true)
    expect(secretInPath("https://mcp.pipedream.net/9f3c2a1b-77aa-4e0e-9a3f-0123456789ab/github")).toBe(true)
    expect(secretInPath("https://mcp.example.com/v1/AbCdEf0123456789AbCdEf01/mcp")).toBe(true)
    expect(secretInPath("https://mcp.linear.app/mcp")).toBe(false)
    expect(secretInPath("https://api.example.com/v2/servers/github-mcp-server/sse")).toBe(false)
    const dropped: string[] = []
    const kept = portableMcp(
      { mcpServers: { zap: { type: "http", url: "https://actions.zapier.com/mcp/sk-ak-AbCdEf0123456789/sse" }, plain: { type: "http", url: "https://mcp.linear.app/mcp" } } },
      "/r",
      dropped,
      { all: true, enabled: new Set(), disabled: new Set() },
    )
    expect(Object.keys(kept)).toEqual(["plain"])
    expect(dropped.join("\n")).toContain("zap (its URL's path carries a credential")
    expect(dropped.join("\n")).not.toContain("sk-ak")
  })
})

describe("kyora detach / kyora back: the short pair", () => {
  test("detach is up with a leading name, back is pull --stop with --keep to stay; wrong shapes are usage errors", async () => {
    expect(SESSION_HELP).toContain("kyora detach [name]")
    expect(SESSION_HELP).toContain("kyora back [name]")
    for (const argv of [["detach", "a", "b"], ["detach", "a", "--name", "b"], ["back", "a", "b"], ["back", "--keep", "--force"], ["back", "--stop"], ["detach", "--stop"]]) {
      expect(sessionMain(argv)).rejects.toBeInstanceOf(SessionUsage)
    }
  })

  test("back ends the session once its last checkpoint is confirmed", async () => {
    await rm(join(process.env.XDG_STATE_HOME!, "kyora"), { recursive: true, force: true })
    const vmd = await startFakeVmd()
    const saved = { url: process.env.KYORA_VMS_URL, key: process.env.KYORA_VMS_KEY }
    try {
      process.env.KYORA_VMS_URL = vmd.url
      process.env.KYORA_VMS_KEY = KEY
      const api = new VmsClient({ url: vmd.url, key: KEY, keySource: "test", urlSource: "test", credentials: "" })
      const repo = await repoWithChanges()
      const sandbox = await api.create({ network: "registries" }, { wait: 0 })
      await fakeExport(vmd.sandboxes.get(sandbox.id)!.root, 1, "seq=0\nagent=stopped\nsupervisor=stopped\nfinal=done\n")
      const transcript = join(await temp("session-back"), "t.jsonl")
      await write(transcript, "", "{}\n")
      await saveState({
        version: 1,
        name: "bk",
        id: sandbox.id,
        url: vmd.url,
        repo,
        agent: "claude",
        agentSession: "0f2b3c4d-1111-4222-8333-944455556667",
        local: { id: "0f2b3c4d-1111-4222-8333-944455556667", file: transcript, extra: null, hash: "h" },
        remoteFiles: { file: ".claude/projects/x/t.jsonl", extra: null },
        map: { local: repo, remote: repo },
        mode: "same-path",
        base: "b",
        head: null,
        upstream: "main",
        sandbox: sandbox.id,
        exec: null,
        driver: "cloud",
        createdAt: new Date().toISOString(),
        pulledAt: null,
        stoppedAt: null,
      })
      expect(await sessionMain(["back", "bk", "--json"])).toBe(0)
      expect(vmd.destroyed).toEqual([sandbox.id])
      expect((await resolveState("bk", repo)).driver).toBe("local")
    } finally {
      for (const [name, value] of [["KYORA_VMS_URL", saved.url], ["KYORA_VMS_KEY", saved.key]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await vmd.stop()
    }
  }, 90_000)
})
