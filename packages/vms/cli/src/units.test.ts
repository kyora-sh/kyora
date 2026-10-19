import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, readlink, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { parseEnvFile } from "./config"
import { exitCodeOf } from "./exec"
import { extractTar, linkOrCopy } from "./extract"
import { listFiles, uploadBody } from "./pack"
import { END_OF_ARCHIVE, headerBlocks, padding, readTar, TarTruncated, type TarHeader } from "./tar"
import { makeRepo, tempDir, write } from "./testing/fixtures"
import { layoutFor, remotePath } from "./transfer"
import { diskGb, formatBytes, formatMs, memoryMb, parseSeconds } from "./units"
import { decompressIfZstd, zstdAvailable } from "./zstd"

let root: string

beforeEach(async () => {
  root = await tempDir("unit")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function archive(entries: { header: TarHeader; data?: string }[]): ReadableStream<Uint8Array> {
  const parts: BlobPart[] = []
  for (const { header, data } of entries) {
    parts.push(...headerBlocks(header))
    if (data !== undefined) {
      const bytes = new TextEncoder().encode(data)
      parts.push(bytes, padding(bytes.length))
    }
  }
  parts.push(END_OF_ARCHIVE)
  return new Blob(parts).stream()
}

const file = (name: string, data: string, mode = 0o644): { header: TarHeader; data: string } => ({
  header: { name, type: "file", mode, size: Buffer.byteLength(data), mtime: 1_700_000_000 },
  data,
})

describe("flags", () => {
  test("sizes and durations", () => {
    expect(memoryMb("8G")).toBe(8192)
    expect(memoryMb("512M")).toBe(512)
    expect(memoryMb("16")).toBe(16384)
    expect(memoryMb("1.5GiB")).toBe(1536)
    expect(diskGb("30G")).toBe(30)
    expect(diskGb("1500M")).toBe(2)
    expect(() => memoryMb("lots")).toThrow("--memory")
    expect(parseSeconds("90", "--ttl")).toBe(90)
    expect(parseSeconds("30m", "--ttl")).toBe(1800)
    expect(parseSeconds("1h30m", "--ttl")).toBe(5400)
    expect(parseSeconds("500ms", "--ttl")).toBe(1)
    expect(() => parseSeconds("1h fifteen", "--timeout")).toThrow("--timeout")
    expect(() => parseSeconds("0s", "--timeout")).toThrow("more than zero")
  })

  test("timings and sizes never print an impossible value at a rounding boundary", () => {
    expect(formatMs(0)).toBe("0ms")
    expect(formatMs(999.4)).toBe("999ms")
    expect(formatMs(999.6)).toBe("1.0s")
    expect(formatMs(59_949)).toBe("59.9s")
    expect(formatMs(59_950)).toBe("1m00s")
    expect(formatMs(59_999)).toBe("1m00s")
    expect(formatMs(119_600)).toBe("2m00s")
    expect(formatMs(119_400)).toBe("1m59s")
    expect(formatMs(3_725_000)).toBe("62m05s")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(99.96 * 1024)).toBe("100 KB")
    expect(formatBytes(1023.97 * 1024)).toBe("1.0 MB")
    expect(formatBytes(3.35 * 1024 ** 2)).toBe("3.4 MB")
  })

  test("sandbox paths resolve under /work and stay there", () => {
    expect(remotePath("target/release/app")).toBe("/work/target/release/app")
    expect(remotePath("/work/out/")).toBe("/work/out")
    expect(remotePath("/tmp/log")).toBe("/tmp/log")
    expect(() => remotePath("../etc/passwd")).toThrow("under /work")
    expect(() => remotePath("/work/../etc")).toThrow("under /work")
    expect(() => remotePath("/workshop")).toThrow("under /work")
  })

  test("download entries land as under /work whichever way the guest names them", () => {
    const names = (path: string, entries: string[]) => {
      const map = layoutFor(path)
      return entries.map(map)
    }
    expect(names("/work/target/release/app", ["target/release/app"])).toEqual(["target/release/app"])
    expect(names("/work/target/release", ["work/target/release", "work/target/release/app"])).toEqual(["target/release", "target/release/app"])
    expect(names("/work/target/release", ["release/", "release/app"])).toEqual(["target/release/", "target/release/app"])
    expect(names("/work/app", ["app"])).toEqual(["app"])
    expect(names("/work", ["./src/main.rs", "Cargo.toml"])).toEqual(["./src/main.rs", "Cargo.toml"])
    expect(names("/tmp/log.txt", ["tmp/log.txt"])).toEqual(["tmp/log.txt"])
    // never a way around the safety checks: a hostile name stays hostile
    expect(names("/work/target/app", ["../escape", "target/app"])).toEqual(["../escape", "target/app"])
    expect(names("/work/target/release", ["release", "/etc/passwd"])).toEqual(["target/release", "/etc/passwd"])
  })

  test("env file lines", () => {
    const parsed = parseEnvFile("# comment\nexport KYORA_VMS_KEY=\"kvms_a\"\n\nKYORA_VMS_URL = 'https://x.example'\nBROKEN\n")
    expect(parsed).toEqual({ KYORA_VMS_KEY: "kvms_a", KYORA_VMS_URL: "https://x.example" })
  })
})

describe("exit codes", () => {
  test("follow shell conventions for the Linux guest", () => {
    expect(exitCodeOf({ type: "exit", code: 0, signal: null })).toBe(0)
    expect(exitCodeOf({ type: "exit", code: 101, signal: null })).toBe(101)
    expect(exitCodeOf({ type: "exit", code: null, signal: "SIGKILL" })).toBe(137)
    expect(exitCodeOf({ type: "exit", code: null, signal: "USR1" })).toBe(138)
    expect(exitCodeOf({ type: "exit", code: null, signal: 15 })).toBe(143)
    expect(exitCodeOf({ type: "exit", code: -9, signal: null })).toBe(137)
    expect(exitCodeOf({ type: "exit", code: null, signal: "SIGKILL", timedOut: true })).toBe(124)
    expect(exitCodeOf({ type: "exit", code: null, signal: null })).toBe(125)
  })
})

describe("tar", () => {
  test("round-trips long, unicode and huge-size headers through pax", async () => {
    const long = `${"a/".repeat(80)}ünïcode.txt`
    const entries = [file(long, "x"), { header: { name: "l", type: "symlink" as const, linkname: `${"../".repeat(40)}t`, mode: 0o777, size: 0, mtime: 0 } }]
    const seen = []
    for await (const { entry } of readTar(archive(entries))) seen.push([entry.name, entry.type, entry.linkname])
    expect(seen).toEqual([
      [long, "file", ""],
      ["l", "symlink", `${"../".repeat(40)}t`],
    ])

    const blocks = headerBlocks({ name: "big", type: "file", mode: 0o644, size: 10 * 1024 ** 3, mtime: 0 })
    const header = new Blob([...blocks, END_OF_ARCHIVE]).stream()
    for await (const { entry } of readTar(header)) {
      expect(entry.size).toBe(10 * 1024 ** 3)
      break
    }
  })

  test("reads what the system tar writes, long names included", async () => {
    const src = join(root, "src")
    const long = `${"deep-directory/".repeat(10)}file.txt`
    await write(src, long, "content")
    await write(src, "run.sh", "#!/bin/sh\n", 0o755)
    const tar = Bun.spawn({ cmd: ["tar", "-cf", "-", "-C", src, "."], env: { PATH: process.env.PATH!, COPYFILE_DISABLE: "1" }, stdout: "pipe" })
    const result = await extractTar(tar.stdout, join(root, "out"))
    expect(result.refused).toEqual([])
    expect(await Bun.file(join(root, "out", long)).text()).toBe("content")
    expect((await stat(join(root, "out", "run.sh"))).mode & 0o777).toBe(0o755)
  })

  test("the system tar reads what the packer writes", async () => {
    const repo = await makeRepo(root)
    const listing = await listFiles(repo)
    expect(listing.mode).toBe("git")
    const warnings: string[] = []
    const body = uploadBody(listing.entries, (message) => warnings.push(message))
    const out = join(root, "unpacked")
    await mkdir(out)
    const stream = await decompressIfZstd(body.stream)
    const tar = Bun.spawn({ cmd: ["tar", "-xpf", "-", "-C", out], stdin: stream, stderr: "pipe" })
    expect(await tar.exited).toBe(0)
    expect(await Bun.file(join(out, "src/main.rs")).text()).toContain("println")
    expect((await stat(join(out, "build.sh"))).mode & 0o777).toBe(0o755)
    expect(await readlink(join(out, "link.rs"))).toBe("src/main.rs")
    expect(await lstat(join(out, "escape")).catch(() => null)).toBeNull()
    expect(await lstat(join(out, "secret.env")).catch(() => null)).toBeNull()
    expect(warnings).toEqual(["skipped symlink escape -> ../../outside-secret: it points outside the upload"])
    if (zstdAvailable) expect(body.contentType).toBe("application/zstd")
  })
})

describe("safe extraction", () => {
  test("strips setuid and group/other write, keeps exec, skips devices", async () => {
    const result = await extractTar(
      archive([
        file("bin/tool", "#!/bin/sh\n", 0o6777),
        file("data.txt", "d", 0o666),
        { header: { name: "dev/null", type: "other", typeflag: "3", mode: 0o666, size: 0, mtime: 0 } },
      ]),
      join(root, "out"),
    )
    expect((await stat(join(root, "out/bin/tool"))).mode & 0o7777).toBe(0o755)
    expect((await stat(join(root, "out/data.txt"))).mode & 0o7777).toBe(0o644)
    expect(result.skipped).toEqual(['dev/null (tar type "3")'])
    expect(await lstat(join(root, "out/dev/null")).catch(() => null)).toBeNull()
  })

  test("a symlink from earlier in the archive cannot carry a later write out", async () => {
    const outside = join(root, "outside")
    await mkdir(outside)
    const result = await extractTar(
      archive([
        { header: { name: "a", type: "symlink", linkname: ".", mode: 0o777, size: 0, mtime: 0 } },
        { header: { name: "a/b", type: "symlink", linkname: "..", mode: 0o777, size: 0, mtime: 0 } },
        file("a/b/escaped.txt", "evil"),
        { header: { name: "dir/up", type: "symlink", linkname: "../../outside", mode: 0o777, size: 0, mtime: 0 } },
        file("dir/up/escaped.txt", "evil"),
      ]),
      join(root, "out"),
    )
    // the escaping links are refused, so the later writes land in plain directories inside
    expect(result.refused.map((entry) => entry.split(" ")[0])).toEqual(["a/b", "dir/up"])
    expect(await Bun.file(join(root, "out/b/escaped.txt")).text()).toBe("evil")
    expect(await Bun.file(join(root, "escaped.txt")).exists()).toBe(false)
    expect(await Bun.file(join(outside, "escaped.txt")).exists()).toBe(false)
  })

  test("replaces an existing file or symlink instead of writing through it", async () => {
    const out = join(root, "out")
    const victim = join(root, "victim.txt")
    await write(root, "victim.txt", "untouched")
    await mkdir(out)
    await symlink(victim, join(out, "result.txt"))
    await extractTar(archive([file("result.txt", "fresh")]), out)
    expect(await Bun.file(victim).text()).toBe("untouched")
    expect((await lstat(join(out, "result.txt"))).isSymbolicLink()).toBe(false)
    expect(await Bun.file(join(out, "result.txt")).text()).toBe("fresh")
  })

  test("hard links resolve to files extracted inside the destination", async () => {
    const result = await extractTar(
      archive([file("target/release/deps/app-1234", "elf"), { header: { name: "target/release/app", type: "hardlink", linkname: "target/release/deps/app-1234", mode: 0o755, size: 0, mtime: 0 } }]),
      join(root, "out"),
    )
    expect(result.refused).toEqual([])
    expect(await Bun.file(join(root, "out/target/release/app")).text()).toBe("elf")
  })

  test("an entry that cannot be written costs only that entry", async () => {
    const out = join(root, "out")
    await write(out, "blocker", "a file where a directory should be")
    await mkdir(join(out, "taken"))
    const result = await extractTar(archive([file("blocker/inner.txt", "x"), file("taken", "a file over a directory"), file("after.txt", "still here")]), out)
    expect(result.failed.map((entry) => entry.split(" ")[0])).toEqual(["blocker/inner.txt", "taken"])
    expect(result.refused).toEqual([])
    expect(result.written).toEqual(["after.txt"])
    expect(await Bun.file(join(out, "after.txt")).text()).toBe("still here")
  })

  test("a hard link that falls back to a copy keeps the exec bit", async () => {
    await write(root, "tool", "#!/bin/sh\n", 0o755)
    const crossDevice = async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
    }
    await linkOrCopy(join(root, "tool"), join(root, "copy"), 0o755, crossDevice)
    expect((await stat(join(root, "copy"))).mode & 0o777).toBe(0o755)
    expect(await Bun.file(join(root, "copy")).text()).toBe("#!/bin/sh\n")
    expect((await stat(join(root, "copy"))).ino).not.toBe((await stat(join(root, "tool"))).ino)
  })

  test("a truncated archive is an error, not a silent partial success", async () => {
    const whole = new Uint8Array(await new Response(archive([file("big.bin", "x".repeat(5000))])).arrayBuffer())
    const cut = new Blob([whole.subarray(0, 2048)]).stream()
    await expect(extractTar(cut, join(root, "out"))).rejects.toThrow("truncated")
  })

  test("an archive cut where an entry ends, before its end-of-archive marker, is truncated too", async () => {
    const whole = new Uint8Array(await new Response(archive([file("a.txt", "first"), file("big.bin", "x".repeat(5000))])).arrayBuffer())
    // a.txt: header + one data block; big.bin: header + ten: the cut falls on a block boundary, after both entries
    const end = whole.length - END_OF_ARCHIVE.length
    expect(whole.subarray(end).every((byte) => byte === 0)).toBe(true)
    const cut = new Blob([whole.subarray(0, end)]).stream()
    const error = await extractTar(cut, join(root, "cut")).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(TarTruncated)
    expect((await extractTar(new Blob([whole]).stream(), join(root, "whole"))).written.sort()).toEqual(["a.txt", "big.bin"])
  })
})

describe("packing", () => {
  test("a subdirectory of a repo packs only that subtree, relative to it", async () => {
    const repo = await makeRepo(root)
    const listing = await listFiles(join(repo, "src"))
    expect(listing.entries.map((entry) => entry.rel)).toEqual(["main.rs"])
  })
})
