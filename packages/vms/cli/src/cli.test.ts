import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { lstat, mkdir, readdir, readlink, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { headerBlocks, END_OF_ARCHIVE, padding, type TarHeader } from "./tar"
import { KEY, startFakePlatform, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { alive, baseEnv, cli, LONG_NAME, makeRepo, platformEnv, spawnCli, tempDir, transcripts, waitFor, write } from "./testing/fixtures"

// every test spawns the CLI several times over real HTTP; bun's 5s default is too tight on a busy runner
setDefaultTimeout(30_000)

let root: string
let vmd: FakeVmd

beforeEach(async () => {
  root = await tempDir("e2e")
  vmd = await startFakeVmd()
})

afterEach(async () => {
  await vmd.stop()
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  // nothing any test printed, success or failure, may contain the key
  expect(transcripts.length).toBeGreaterThan(0)
  for (const text of transcripts) expect(text).not.toContain(KEY)
})

const env = (extra: Record<string, string | undefined> = {}) => baseEnv(vmd.url, extra)

/** API warnings stay on stderr so scripts can keep reading the sandbox id from stdout. */
test("prints API create warnings and still refuses explicit open --allow", async () => {
  vmd.options.createWarnings = ["egressAllow is ignored with network open", "another API warning"]
  for (const args of [["create", "--network", "open"], ["create", "--network", "open", "--name", "warned-box"], ["run", "--network", "open", "--", "echo", "ok"]]) {
    const made = await cli(args, { cwd: root, env: env() })
    expect(made.code).toBe(0)
    for (const warning of vmd.options.createWarnings) expect(made.stderr.split(`[kyora-vms] warning: ${warning}`).length).toBe(2)
    expect(made.stdout).not.toContain("warning")
  }
  const count = vmd.created.length
  const refused = await cli(["create", "--network", "open", "--allow", "example.com"], { cwd: root, env: env() })
  expect(refused.code).toBe(125)
  expect(refused.stderr).toContain("--allow requires --network none or registries")
  expect(vmd.created).toHaveLength(count)
})

test("prints warnings once when a queued API create finishes", async () => {
  await vmd.stop()
  vmd = await startFakePlatform({ queueAhead: 1, createWarnings: ["egressAllow is ignored with network open"] })
  const made = await cli(["create", "--network", "open"], { cwd: root, env: platformEnv(vmd.url) })
  expect(made.code).toBe(0)
  expect(made.stdout.trim()).toMatch(/^sb_/)
  expect(made.stderr).toContain("queued")
  expect(made.stderr.split("[kyora-vms] warning: egressAllow is ignored with network open").length).toBe(2)
})

describe("kyora vms run", () => {
  test("uploads the git worktree as git sees it, with exec bits and symlinks, and destroys the sandbox", async () => {
    const repo = await makeRepo(root)
    const listing = "find . \\( -type f -o -type l \\) -print | LC_ALL=C sort; ./build.sh; readlink link.rs"
    const result = await cli(["run", "--", "sh", "-c", listing], { cwd: repo, env: env() })

    expect(result.code).toBe(0)
    // macOS may hand the unicode name back decomposed
    const lines = result.stdout.normalize("NFC").trim().split("\n")
    expect(lines).toEqual([
      "./.gitignore",
      "./build.sh",
      `./${LONG_NAME}`,
      "./link.rs",
      "./nested/.gitignore",
      "./nested/lib.txt",
      "./notes.txt",
      "./src/main.rs",
      "built-ok",
      "src/main.rs",
    ])
    expect(result.stderr).toContain("skipped symlink escape -> ../../outside-secret")
    expect(result.stderr).toMatch(/\[kyora-vms\] sb_\w+: create \S+ · upload .* · exec \S+ · exit 0/)

    expect(vmd.uploads).toHaveLength(1)
    expect(vmd.uploads[0]!.contentType).toBe("application/zstd")
    expect(vmd.execs[0]!.cwd).toBe("/work")
    expect(vmd.destroyed).toEqual([vmd.uploads[0]!.id])
    expect(vmd.sandboxes.size).toBe(0)
  })

  test("outside a repo it uploads everything but .git, node_modules, target, .venv and dist", async () => {
    const dir = join(root, "plain")
    for (const path of ["a.txt", "sub/b.txt", "sub/.git/HEAD", "node_modules/x/index.js", "target/out", ".venv/bin/python", "dist/app.js", "sub/dist/c.js"]) {
      await write(dir, path, path)
    }
    await mkdir(join(dir, "empty"))
    const result = await cli(["run", "--dir", dir, "--", "sh", "-c", "find . -mindepth 1 -print | LC_ALL=C sort"], { cwd: root, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual(["./a.txt", "./empty", "./sub", "./sub/b.txt"])
  })

  test("inside a repo git cannot read it uploads nothing, rather than ignore .gitignore; --no-git walks on purpose", async () => {
    const repo = await makeRepo(root)
    // no git on PATH: the CLI itself is started by absolute path and needs nothing else
    const noGit = env({ PATH: join(root, "empty-bin") })
    await mkdir(join(root, "empty-bin"))

    const refused = await cli(["run", "--", "true"], { cwd: repo, env: noGit })
    expect(refused.code).toBe(125)
    expect(refused.stderr).toMatch(/is in the git repo at \S*\/repo, but git could not list its files \(.*git/)
    expect(refused.stderr).toContain("pass --no-git")
    expect(vmd.created).toHaveLength(0)

    const walked = await cli(["run", "--no-git", "--", "sh", "-c", "find . -name secret.env -o -name big.bin -o -name HEAD"], { cwd: repo, env: noGit })
    expect(walked.code).toBe(0)
    expect(walked.stdout.trim().split("\n")).toEqual(["./secret.env"])
  })

  test("keeps stdout and stderr apart and exits with the remote exit code", async () => {
    const repo = await makeRepo(root)
    const result = await cli(["run", "--", "sh", "-c", "echo out; echo err >&2; printf 'caf\\303\\251 \\377\\n'; exit 7"], { cwd: repo, env: env() })
    expect(result.code).toBe(7)
    expect(result.stdout).toBe(`out\ncafé ${"�"}\n`)
    expect(result.stderr).toContain("err\n")
    expect(result.stderr).toMatch(/exit 7$/m)
    expect(vmd.destroyed).toHaveLength(1)
  })

  test("--out downloads artifacts into the worktree, laid out as under /work", async () => {
    const repo = await makeRepo(root)
    const build = `mkdir -p target/release && printf binary > target/release/app && chmod 755 target/release/app && mkdir -p '${LONG_NAME.split("/").slice(0, -1).join("/")}' && echo copy > '${LONG_NAME}.out'`
    const result = await cli(["run", "--out", "target/release/app", "--out", `/work/${LONG_NAME}.out`, "--", "sh", "-c", build], { cwd: repo, env: env() })

    expect(result.code).toBe(0)
    const app = join(repo, "target/release/app")
    expect(await Bun.file(app).text()).toBe("binary")
    expect((await stat(app)).mode & 0o777).toBe(0o755)
    expect(await Bun.file(join(repo, `${LONG_NAME}.out`)).text()).toBe("copy\n")
    expect(result.stderr).toMatch(/download \S+ \S+ \S+ · exit 0/)
    expect(vmd.destroyed).toHaveLength(1)
  })

  test("a missing --out turns success into 125 but leaves a failing command's code alone", async () => {
    const repo = await makeRepo(root)
    const ok = await cli(["run", "--out", "target/nope", "--", "true"], { cwd: repo, env: env() })
    expect(ok.code).toBe(125)
    expect(ok.stderr).toContain("--out /work/target/nope: not found in the sandbox")

    const failed = await cli(["run", "--out", "target/nope", "--", "sh", "-c", "exit 3"], { cwd: repo, env: env() })
    expect(failed.code).toBe(3)
    expect(vmd.destroyed).toHaveLength(2)
  })

  test("refuses every entry of a hostile download that would land outside --to", async () => {
    const repo = await makeRepo(root)
    const outside = join(root, "outside")
    await mkdir(outside)
    const to = join(root, "dest", "to")
    await mkdir(to, { recursive: true })
    await symlink(outside, join(to, "planted"))

    vmd.options.download = () => new Response(hostileTar(), { headers: { "content-type": "application/x-tar" } })
    const result = await cli(["run", "--out", "target", "--to", to, "--", "true"], { cwd: repo, env: env() })

    expect(result.code).toBe(125)
    expect(result.stderr).toContain("refused 6 unsafe entries")
    expect(await Bun.file(join(to, "ok.txt")).text()).toBe("fine")
    expect((await stat(join(to, "ok.txt"))).mode & 0o7777).toBe(0o755)
    expect(await readlink(join(to, "inner"))).toBe("ok.txt")
    expect(await readdir(outside)).toEqual([])
    expect((await readdir(join(root, "dest"))).sort()).toEqual(["to"])
    expect(await Bun.file(join(root, "escape.txt")).exists()).toBe(false)
    expect(await lstat(join(to, "evil")).catch(() => null)).toBeNull()
    expect(await lstat(join(to, "abs-link")).catch(() => null)).toBeNull()
    expect(vmd.destroyed).toHaveLength(1)
  })

  test("--keep leaves the sandbox running and names it", async () => {
    const repo = await makeRepo(root)
    const result = await cli(["run", "--keep", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(0)
    const [id] = [...vmd.sandboxes.keys()]
    expect(id).toBeDefined()
    expect(result.stderr).toContain(`kept ${id}`)
    expect(vmd.destroyed).toEqual([])
    expect(await Bun.file(join(vmd.work(id!), "src/main.rs")).exists()).toBe(true)
  })

  test("destroys the sandbox when the upload is refused with 413", async () => {
    const repo = await makeRepo(root)
    vmd.options.uploadLimit = 16
    const result = await cli(["run", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("upload exceeds this key's limit of 16 bytes")
    expect(result.stderr).toContain("keep build output and caches out of the upload")
    expect(vmd.execs).toHaveLength(0)
    expect(vmd.created).toHaveLength(1)
    expect(vmd.destroyed).toHaveLength(1)
    expect(vmd.sandboxes.size).toBe(0)
  })

  test("explains a 503 from create and has nothing to destroy", async () => {
    const repo = await makeRepo(root)
    vmd.options.createFailure = { status: 503, error: "no_capacity", message: "no capacity: 2 vCPU free, 4 asked" }
    const result = await cli(["run", "--cpus", "4", "--", "true"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("create sandbox: no capacity: 2 vCPU free, 4 asked; the host is out of capacity or restarting")
    expect(vmd.created[0]).toMatchObject({ vcpus: 4 })
    expect(vmd.destroyed).toEqual([])
  })

  test("sends the sandbox and command options the contract names", async () => {
    const repo = await makeRepo(root)
    const args = ["run", "--network", "registries", "--cpus", "8", "--memory", "16G", "--disk", "60G", "--ttl", "2h", "--timeout", "45m"]
    args.push("--env", "FOO=bar", "--env", "FROM_HOST", "--cwd", "src", "--stdin", "--", "sh", "-c", "cat; echo \"$FOO $FROM_HOST\"; pwd")
    const result = await cli(args, { cwd: repo, env: env({ FROM_HOST: "passed" }), stdin: "piped input\n" })
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith("piped input\nbar passed\n")
    expect(vmd.created[0]).toEqual({ name: expect.stringMatching(/^[a-z]+-[a-z]+$/), network: "registries", vcpus: 8, memoryMb: 16384, diskGb: 60, ttlSeconds: 7200 })
    expect(vmd.execs[0]).toMatchObject({ cwd: "/work/src", timeoutSeconds: 2700, env: { FOO: "bar", FROM_HOST: "passed" }, stdin: "piped input\n" })
  })

  test("an infrastructure error mid-exec is reported once, exits 125, and still destroys", async () => {
    const repo = await makeRepo(root)
    const events = [{ type: "stdout", data: "partial\n" }, { type: "keepalive" }, { type: "error", message: "guest agent vanished" }]
    vmd.options.exec = () => new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } })
    const result = await cli(["run", "--", "cargo", "build"], { cwd: repo, env: env() })
    expect(result.code).toBe(125)
    expect(result.stdout).toBe("partial\n")
    expect(result.stderr.split("remote error: guest agent vanished")).toHaveLength(2)
    expect(vmd.destroyed).toHaveLength(1)
  })

  test("maps a timeout to 124 and a signal to 128+n", async () => {
    const repo = await makeRepo(root)
    const timeout = await cli(["run", "--timeout", "1s", "--", "sleep", "10"], { cwd: repo, env: env() })
    expect(timeout.code).toBe(124)
    const killed = await cli(["run", "--", "sh", "-c", "kill -TERM $$"], { cwd: repo, env: env() })
    expect(killed.code).toBe(143)
    expect(vmd.destroyed).toHaveLength(2)
  })

  test("Ctrl-C cancels the command by its id and drops the stream, the command dies, the sandbox is destroyed", async () => {
    const repo = await makeRepo(root)
    const running = spawnCli(["run", "--", "sh", "-c", "echo started; exec sleep 30"], { cwd: repo, env: env() })
    await waitFor(() => running.stdout().includes("started"), 15_000, "the remote command to start")
    running.proc.kill("SIGINT")
    const result = await running.done

    expect(result.code).toBe(130)
    expect(result.stderr).toContain("SIGINT: stopping the remote command")
    // dropping a resumable command's stream leaves it running: the explicit cancel is what kills it
    const [command] = [...vmd.commands.values()]
    expect(vmd.cancels).toEqual([{ id: command!.id, execId: command!.execId, pid: command!.pid }])
    expect(vmd.disconnects).toHaveLength(1)
    await waitFor(() => !alive(command!.pid), 5_000, "the remote process to die")
    expect(vmd.destroyed).toEqual([command!.id])
  })

  test("Ctrl-C against a server without resumable commands drops the stream, which is what kills there", async () => {
    vmd.options.resumable = false
    const repo = await makeRepo(root)
    const running = spawnCli(["run", "--", "sh", "-c", "echo started; exec sleep 30"], { cwd: repo, env: env() })
    await waitFor(() => running.stdout().includes("started"), 15_000, "the remote command to start")
    running.proc.kill("SIGINT")
    const result = await running.done

    expect(result.code).toBe(130)
    expect(vmd.cancels).toEqual([])
    expect(vmd.disconnects).toHaveLength(1)
    await waitFor(() => !alive(vmd.disconnects[0]!.pid), 5_000, "the remote process to die")
  })

  test("--json emits NDJSON: sandbox, upload, the exec events verbatim, then a summary", async () => {
    const repo = await makeRepo(root)
    const result = await cli(["run", "--json", "--", "sh", "-c", "echo hi; exit 2"], { cwd: repo, env: env() })
    expect(result.code).toBe(2)
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(events.map((event) => event.type)).toEqual(["sandbox", "upload", "started", "stdout", "exit", "summary"])
    // `from`: this machine marks its own keepalives
    expect(events[2]).toEqual({ type: "started", id: expect.stringMatching(/^[0-9a-f]{32}$/), resumable: true, from: "machine" })
    expect(events[3]).toEqual({ type: "stdout", data: "hi\n" })
    expect(events[4]).toMatchObject({ type: "exit", code: 2, signal: null, timedOut: false, bytes: { stdout: 3, stderr: 0 } })
    expect(events[5]).toMatchObject({ type: "summary", exitCode: 2, kept: false, id: events[0].id })
  })
})

describe("session verbs", () => {
  test("none is sent as zero and create/ls show no expiry; defaults come from the server", async () => {
    const created = await cli(["create", "--ttl", "none", "--idle", "none"], { cwd: root, env: env() })
    expect(created.code).toBe(0)
    expect(vmd.created[0]).toMatchObject({ ttlSeconds: 0, idleSeconds: 0 })
    expect(created.stderr).toContain("no expiry")
    expect((await cli(["ls"], { cwd: root, env: env() })).stdout).toContain("no expiry")
    expect(JSON.parse((await cli(["ls", "--json"], { cwd: root, env: env() })).stdout).sandboxes[0].expiresAt).toBeNull()
    expect((await cli(["create"], { cwd: root, env: env() })).code).toBe(0)
    expect(vmd.created[1]).not.toHaveProperty("ttlSeconds")
    expect((await cli(["rm", "--all", "--yes"], { cwd: root, env: env() })).code).toBe(0)
    const run = await cli(["run", "--ttl", "none", "--keep", "--", "true"], { cwd: root, env: env() })
    expect(run.code).toBe(0)
    expect(vmd.created[2]).toMatchObject({ ttlSeconds: 0 })
    expect(vmd.sandboxes.size).toBe(1)
    expect((await cli(["rm", "--all", "--yes"], { cwd: root, env: env() })).code).toBe(0)
  })

  test("an old Worker rejecting none is surfaced without retrying with a finite lifetime", async () => {
    vmd.options.createFailure = { status: 400, error: "invalid_request", message: "ttlSeconds must be between 60 and 28800" }
    const result = await cli(["create", "--ttl", "none"], { cwd: root, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("ttlSeconds must be between")
    expect(vmd.created).toHaveLength(1)
    expect(vmd.created[0]).toMatchObject({ ttlSeconds: 0 })
    expect(vmd.sandboxes.size).toBe(0)
  })
  test("create, ls, push, exec, pull, rm", async () => {
    const created = await cli(["create", "--network", "registries"], { cwd: root, env: env() })
    expect(created.code).toBe(0)
    const id = created.stdout.trim()
    expect(id).toMatch(/^sb_\w+$/)
    expect(created.stderr).toContain("network registries")

    const listed = await cli(["ls"], { cwd: root, env: env() })
    expect(listed.stdout).toContain(id.slice(0, 11))
    const listedJson = JSON.parse((await cli(["ls", "--json"], { cwd: root, env: env() })).stdout)
    expect(listedJson.sandboxes[0].id).toBe(id)

    const dir = join(root, "src")
    await write(dir, "input.txt", "hello from push\n")
    const pushed = await cli(["push", id, dir, "--dest", "/work/in"], { cwd: root, env: env() })
    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toContain("to /work/in")

    const ran = await cli(["exec", id, "--cwd", "in", "--", "sh", "-c", "cat input.txt; mkdir -p ../out && cp input.txt ../out/copy.txt; exit 4"], { cwd: root, env: env() })
    expect(ran.code).toBe(4)
    expect(ran.stdout).toBe("hello from push\n")

    const json = await cli(["exec", id, "--json", "--", "echo", "hi"], { cwd: root, env: env() })
    const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(events).toEqual([expect.objectContaining({ type: "started", resumable: true }), { type: "stdout", data: "hi\n" }, expect.objectContaining({ type: "exit", code: 0 })])

    const to = join(root, "pulled")
    const pulled = await cli(["pull", id, "out/copy.txt", "/work/in", "--to", to], { cwd: root, env: env() })
    expect(pulled.code).toBe(0)
    expect(await Bun.file(join(to, "out/copy.txt")).text()).toBe("hello from push\n")
    expect(await Bun.file(join(to, "in/input.txt")).text()).toBe("hello from push\n")

    const missing = await cli(["pull", id, "nope", "--to", to], { cwd: root, env: env() })
    expect(missing.code).toBe(125)
    expect(missing.stderr).toContain("/work/nope: not found in the sandbox")

    expect((await cli(["rm", id], { cwd: root, env: env() })).stdout).toBe(`removed ${id}\n`)
    expect((await cli(["rm", id], { cwd: root, env: env() })).stdout).toBe(`${id} was already gone\n`)
    expect(vmd.destroyed).toEqual([id])
  })

  for (const admission of ["legacy", "concurrent"] as const) test(`a second exec while one runs follows admission (${admission})`, async () => {
    vmd.options.oldAgent = admission === "legacy"
    const id = (await cli(["create"], { cwd: root, env: env() })).stdout.trim()
    const first = spawnCli(["exec", id, "--", "sh", "-c", "echo busy; exec sleep 30"], { cwd: root, env: env() })
    await waitFor(() => first.stdout().includes("busy"), 10_000, "the first exec")
    const second = await cli(["exec", id, "--", "echo", "next"], { cwd: root, env: env() })
    expect(second.code).toBe(admission === "legacy" ? 125 : 0)
    if (admission === "legacy") expect(second.stderr).toContain(`is already running a command; the sandbox is already running a command; it takes one exec at a time`)
    else expect(second.stdout).toBe("next\n")
    expect(first.stdout()).toBe("busy\n")
    expect(vmd.requests.filter((request) => request === `POST /v1/sandboxes/${id}/exec`)).toHaveLength(2)
    first.proc.kill("SIGTERM")
    expect((await first.done).code).toBe(143)
  })

  test("rm --all --yes clears every sandbox of the key", async () => {
    await cli(["create"], { cwd: root, env: env() })
    await cli(["create"], { cwd: root, env: env() })
    const result = await cli(["rm", "--all", "--yes", "--json"], { cwd: root, env: env() })
    expect(JSON.parse(result.stdout).removed).toHaveLength(2)
    expect(vmd.sandboxes.size).toBe(0)
  })
})

describe("config and credentials", () => {
  test("falls back to ~/.config/kyora-vms/env, and the shell's env wins over it", async () => {
    const home = join(root, "home")
    await write(home, ".config/kyora-vms/env", `# kyora vms\nexport KYORA_VMS_URL="${vmd.url}"\nKYORA_VMS_KEY='${KEY}'\n`)
    const fromFile = await cli(["ls"], { cwd: root, env: { ...env({ HOME: home }), KYORA_VMS_URL: undefined, KYORA_VMS_KEY: undefined } })
    expect(fromFile.code).toBe(0)
    expect(fromFile.stdout).toContain("no sandboxes running")

    const overridden = await cli(["ls"], { cwd: root, env: { ...env({ HOME: home }), KYORA_VMS_URL: undefined, KYORA_VMS_KEY: "kvms_wrong" } })
    expect(overridden.code).toBe(125)
    expect(overridden.stderr).toContain("list sandboxes: missing or unknown API key; the API key was not accepted")
    expect(vmd.unauthorized).toBe(1)
  })

  test("health reports where the key came from and whether it works, never the key", async () => {
    const ok = await cli(["health"], { cwd: root, env: env() })
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain("key: accepted (from $KYORA_VMS_KEY)")
    const json = JSON.parse((await cli(["health", "--json"], { cwd: root, env: env() })).stdout)
    expect(json).toMatchObject({ ok: true, url: vmd.url, key: { source: "$KYORA_VMS_KEY", accepted: true } })

    const bad = await cli(["health"], { cwd: root, env: env({ KYORA_VMS_KEY: "kvms_nope" }) })
    expect(bad.code).toBe(125)
    expect(bad.stdout).toContain("key: rejected")
    expect(bad.stdout).not.toContain("kvms_nope")

    const none = await cli(["ls"], { cwd: root, env: env({ KYORA_VMS_KEY: undefined }) })
    expect(none.stderr).toContain("no API key")
  })

  test("refuses a KYORA_VMS_URL that a checkout's .env slipped in", async () => {
    const attacker = await startFakeVmd()
    try {
      const repo = await makeRepo(root)
      await write(repo, ".env", `KYORA_VMS_URL=${attacker.url}\n`)
      const result = await cli(["run", "--", "true"], { cwd: repo, env: env({ KYORA_VMS_URL: undefined }), loadDotenv: true })
      expect(result.code).toBe(125)
      expect(result.stderr).toContain("refusing KYORA_VMS_URL from")
      expect(attacker.created).toHaveLength(0)
      expect(attacker.unauthorized).toBe(0)
    } finally {
      await attacker.stop()
    }
  })

  test("usage errors point at the fix before anything is created", async () => {
    const result = await cli(["run", "cargo", "build", "--release"], { cwd: root, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("options for the remote command go after --")
    const network = await cli(["create", "--network", "wide"], { cwd: root, env: env() })
    expect(network.stderr).toContain("--network must be one of none, registries, open")
    const image = await cli(["create", "--image", "Better Office"], { cwd: root, env: env() })
    expect(image.stderr).toContain("--image must be a short lowercase name")
    const fromEnv = await cli(["create"], { cwd: root, env: env({ KYORA_VMS_IMAGE: "../etc" }) })
    expect(fromEnv.stderr).toContain("KYORA_VMS_IMAGE must be a short lowercase name")
    expect(vmd.created).toHaveLength(0)
  })

  test("the image: --image, else KYORA_VMS_IMAGE, else none sent (the machine's default)", async () => {
    await cli(["create", "--name", "image-default"], { cwd: root, env: env() })
    await cli(["create", "--name", "image-flag", "--image", "office"], { cwd: root, env: env() })
    await cli(["create", "--name", "image-env"], { cwd: root, env: env({ KYORA_VMS_IMAGE: " office-ci " }) })
    await cli(["create", "--name", "image-override", "--image", "full"], { cwd: root, env: env({ KYORA_VMS_IMAGE: "office" }) })
    await cli(["create", "--name", "image-empty"], { cwd: root, env: env({ KYORA_VMS_IMAGE: "" }) })
    expect(vmd.created.map((spec) => (spec as { image?: string }).image)).toEqual([undefined, "office", "office-ci", "full", undefined])
  })
})

/** the archive a compromised guest could send back */
function hostileTar(): Blob {
  const entries: { header: TarHeader; data?: string }[] = [
    { header: { name: "../escape.txt", type: "file", mode: 0o644, size: 4, mtime: 0 }, data: "evil" },
    { header: { name: "/abs.txt", type: "file", mode: 0o644, size: 4, mtime: 0 }, data: "evil" },
    { header: { name: "evil", type: "symlink", linkname: "../../outside", mode: 0o777, size: 0, mtime: 0 } },
    { header: { name: "abs-link", type: "symlink", linkname: "/etc", mode: 0o777, size: 0, mtime: 0 } },
    { header: { name: "planted/pwned.txt", type: "file", mode: 0o644, size: 4, mtime: 0 }, data: "evil" },
    { header: { name: "hard", type: "hardlink", linkname: "../outside/x", mode: 0o644, size: 0, mtime: 0 } },
    { header: { name: "ok.txt", type: "file", mode: 0o4755, size: 4, mtime: 0 }, data: "fine" },
    { header: { name: "inner", type: "symlink", linkname: "ok.txt", mode: 0o777, size: 0, mtime: 0 } },
  ]
  const parts: BlobPart[] = []
  for (const { header, data } of entries) {
    parts.push(...headerBlocks(header))
    if (data) parts.push(new TextEncoder().encode(data), padding(data.length))
  }
  parts.push(END_OF_ARCHIVE)
  return new Blob(parts)
}

/** The CLI forwards repeated hosts, replaces policies and rejects incompatible flags locally. */
test("user egress create, run and network flags", async () => {
  const made = await cli(["create", "--network", "registries", "--allow", "one.kyora.run", "--allow", "BÜCHER.de"], { cwd: root, env: env() })
  expect(made.code).toBe(0)
  expect(vmd.created.at(-1)).toMatchObject({ network: "registries", egressAllow: ["one.kyora.run", "xn--bcher-kva.de"] })
  const id = made.stdout.trim()
  const tightened = await cli(["network", id, "--allow", "one.kyora.run", "--no-registries", "--json"], { cwd: root, env: env() })
  expect(tightened.code).toBe(0)
  expect(JSON.parse(tightened.stdout)).toEqual({ network: "none", egressAllow: ["one.kyora.run"] })
  const only = await cli(["network", id, "--none", "--allow", "two.kyora.run"], { cwd: root, env: env() })
  expect(only.code).toBe(0)
  expect(JSON.parse(only.stdout)).toEqual({ network: "none", egressAllow: ["two.kyora.run"] })
  const none = await cli(["network", id, "--none"], { cwd: root, env: env() })
  expect(none.code).toBe(0)
  expect(JSON.parse(none.stdout)).toEqual({ network: "none", egressAllow: [] })
  const run = await cli(["run", "--network", "none", "--allow", "one.kyora.run", "--", "true"], { cwd: root, env: env() })
  expect(run.code).toBe(0)
  expect(vmd.created.at(-1)).toMatchObject({ network: "none", egressAllow: ["one.kyora.run"] })
  const refused = await cli(["create", "--network", "open", "--allow", "example.com"], { cwd: root, env: env() })
  expect(refused.code).toBe(125)
  expect(refused.stderr).toContain("none or registries")
})

test("named sandboxes keep egress policy flags, unlimited TTL and network target resolution", async () => {
  const made = await cli(["create", "--ttl", "none", "--network", "registries", "--allow", "one.kyora.run", "--", "-egress"], { cwd: root, env: env() })
  expect(made.code).toBe(0)
  expect(vmd.created.at(-1)).toMatchObject({ name: "-egress", ttlSeconds: 0, network: "registries", egressAllow: ["one.kyora.run"] })
  const id = made.stdout.trim()
  const tightened = await cli(["network", "--no-registries", "--", "-egress"], { cwd: root, env: env() })
  expect(tightened.code).toBe(0)
  expect(JSON.parse(tightened.stdout)).toEqual({ network: "none", egressAllow: ["one.kyora.run"] })
  const cleared = await cli(["network", id.slice(0, -1), "--none"], { cwd: root, env: env() })
  expect(cleared.code).toBe(0)
  expect(JSON.parse(cleared.stdout)).toEqual({ network: "none", egressAllow: [] })
  expect(vmd.requests.filter((request) => request === `PATCH /v1/sandboxes/${id}/network`)).toHaveLength(2)
})

test("an old vmd refuses user policy flags before creating or updating anything", async () => {
  vmd.options.networkPolicy = false
  const made = await cli(["create", "--network", "registries", "--allow", "one.kyora.run"], { cwd: root, env: env() })
  expect(made.code).toBe(125)
  expect(made.stderr).toContain("policies are unavailable on this server; update the machine software")
  expect(vmd.created).toHaveLength(0)
  const update = await cli(["network", "sb_old", "--none"], { cwd: root, env: env() })
  expect(update.code).toBe(125)
  expect(update.stderr).toContain("network policy changes are unavailable on this server; update the machine software")
  expect(vmd.requests.filter((request) => request.startsWith("PATCH"))).toHaveLength(0)
})

test("an exact public suffix stays refused locally, on create and on network (review 2)", async () => {
  for (const host of ["s3.amazonaws.com", "github.io", "pages.dev"]) {
    const made = await cli(["create", "--network", "registries", "--allow", host], { cwd: root, env: env() })
    expect(made.code).toBe(125)
    expect(made.stderr).toContain("egressAllow")
  }
  expect(vmd.created).toHaveLength(0)
  const update = await cli(["network", "sb_any", "--allow", "github.io"], { cwd: root, env: env() })
  expect(update.code).toBe(125)
  expect(update.stderr).toContain("egressAllow")
  expect(vmd.requests.filter((request) => request.startsWith("PATCH"))).toHaveLength(0)
})

/** L1: a server that ignores `shareable: false` (from before the flag) never leaves an unconfirmed sandbox behind. */
test("--no-share fails closed when the server does not confirm it: the sandbox is destroyed and the command fails", async () => {
  vmd.options.ignoreShareable = true
  try {
    for (const args of [["create", "--no-share"], ["run", "--no-share", "--", "echo", "ok"], ["new", "--no-share", "--", "echo", "ok"]]) {
      const before = vmd.destroyed.length
      const result = await cli(args, { cwd: root, env: env() })
      expect([args[0], result.code]).toEqual([args[0], 125])
      expect(result.stderr).toContain("did not confirm it")
      expect(result.stderr).toContain("was destroyed")
      expect(vmd.destroyed.length).toBe(before + 1)
      expect(vmd.sandboxes.has(vmd.destroyed.at(-1)!)).toBe(false)
      // no command ran in it
      expect(result.stdout).not.toContain("ok")
    }
    // without --no-share nothing is asked, so nothing is checked
    expect((await cli(["create"], { cwd: root, env: env() })).code).toBe(0)
  } finally {
    vmd.options.ignoreShareable = false
  }
})

/** Every CLI creation verb sends the permanent sharing policy, and JSON listings retain it. */
test("create, run and new accept --no-share and ls --json shows the flag", async () => {
  for (const args of [["create", "--no-share"], ["run", "--no-share", "--", "echo", "ok"], ["new", "--no-share", "--", "echo", "ok"]]) {
    const result = await cli(args, { cwd: root, env: env() })
    expect(result.code, result.stderr).toBe(0)
    expect(vmd.created.at(-1)).toMatchObject({ shareable: false })
    if (args[0] === "create") expect(result.stderr).toContain("· sharing disabled ·")
  }
  // without the flag nothing is sent, and the server's default (shareable) holds
  expect((await cli(["create"], { cwd: root, env: env() })).code).toBe(0)
  expect(vmd.created.at(-1)).not.toHaveProperty("shareable")
  const listed = await cli(["ls", "--json"], { cwd: root, env: env() })
  expect(JSON.parse(listed.stdout).sandboxes).toContainEqual(expect.objectContaining({ shareable: false }))
  const invalid = await cli(["exec", "missing", "--no-share", "--", "echo", "ok"], { cwd: root, env: env() })
  expect(invalid.code).toBe(125)
})

test("resize accepts --disk, resolves a name, and prints the new size", async () => {
  const made = await cli(["create", "grow-box", "--disk", "10G"], { cwd: root, env: env() })
  expect(made.code).toBe(0)
  const grown = await cli(["resize", "grow-box", "--disk", "20G", "--json"], { cwd: root, env: env() })
  expect(grown.code).toBe(0)
  expect(JSON.parse(grown.stdout)).toMatchObject({ diskGb: 20 })
  expect((await cli(["resize", "grow-box"], { cwd: root, env: env() })).code).toBe(125)
  expect((await cli(["resize", "grow-box", "--disk", "5G"], { cwd: root, env: env() })).code).not.toBe(0)
})
