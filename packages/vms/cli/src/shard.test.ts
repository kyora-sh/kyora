import { describe, expect, test } from "bun:test"
import type { Stats } from "node:fs"
import type { PackEntry } from "./pack"
import { autoShards, planShards, tarWeight } from "./shard"

const MiB = 1024 * 1024

function file(rel: string, size: number): PackEntry {
  return { rel, abs: `/src/${rel}`, stats: { size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as Stats }
}

function dir(rel: string): PackEntry {
  return { rel, abs: `/src/${rel}`, stats: { size: 4096, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false } as Stats }
}

/** a sorted listing, as listFiles returns it */
const listing = (entries: PackEntry[]) => [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

/** a deterministic mix: a few big files, a mid layer, and a long tail of small ones */
function tree(): PackEntry[] {
  let seed = 7
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const entries: PackEntry[] = [dir("assets"), dir("src"), file("assets/model.bin", 300 * MiB), file("assets/video.mp4", 120 * MiB)]
  for (let i = 0; i < 40; i++) entries.push(file(`vendor/lib-${String(i).padStart(2, "0")}.a`, Math.round(random() * 20 * MiB)))
  for (let i = 0; i < 3000; i++) entries.push(file(`src/mod-${String(i % 50).padStart(2, "0")}/file-${String(i).padStart(4, "0")}.rs`, Math.round(random() * 64 * 1024)))
  return listing(entries)
}

describe("autoShards", () => {
  test("one per 256 MiB of files, at least 1 and at most 8", () => {
    expect(autoShards(0)).toBe(1)
    expect(autoShards(3 * MiB)).toBe(1)
    expect(autoShards(256 * MiB)).toBe(1)
    expect(autoShards(256 * MiB + 1)).toBe(2)
    expect(autoShards(1024 * MiB)).toBe(4)
    expect(autoShards(1800 * MiB)).toBe(8)
    expect(autoShards(40 * 1024 * MiB)).toBe(8)
  })
})

describe("planShards", () => {
  test("every entry lands in a shard, every file in exactly one, in listing order within it", () => {
    const entries = tree()
    for (const count of [2, 3, 4, 8, 16]) {
      const shards = planShards(entries, count)
      expect(shards.length).toBeLessThanOrEqual(count)
      const all = shards.flatMap((shard) => shard.entries)
      expect(new Set(all).size).toBe(entries.length)
      const files = all.filter((entry) => !entry.stats.isDirectory())
      expect(files).toHaveLength(entries.filter((entry) => !entry.stats.isDirectory()).length)
      expect(new Set(files).size).toBe(files.length)
      for (const shard of shards) {
        const order = shard.entries.map((entry) => entries.indexOf(entry))
        expect(order).toEqual([...order].sort((a, b) => a - b))
        expect(shard.bytes).toBe(shard.entries.reduce((sum, entry) => sum + tarWeight(entry), 0))
      }
    }
  })

  test("is the same every time, biggest shard first", () => {
    const entries = tree()
    const plan = (list: PackEntry[]) => planShards(list, 4).map((shard) => shard.entries.map((entry) => entry.rel))
    expect(plan(entries)).toEqual(plan(tree()))
    const bytes = planShards(entries, 4).map((shard) => shard.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a))
  })

  test("a file worth a fair share goes alone; the rest is cut into contiguous runs of about equal size", () => {
    const entries = tree()
    const shards = planShards(entries, 4)
    expect(shards).toHaveLength(4)
    // 300 MiB of ~1 GB is more than a quarter: alone (with its directory). 120 MiB is not.
    expect(shards[0]!.entries.map((entry) => entry.rel)).toEqual(["assets", "assets/model.bin"])
    const runs = shards.slice(1)
    expect(runs.some((shard) => shard.entries.length <= 2)).toBe(false)
    // each run's files are contiguous in the listing: no file of another run in between
    const rest = entries.filter((entry) => entry.rel !== "assets/model.bin" && !entry.stats.isDirectory())
    for (const shard of runs) {
      const indexes = shard.entries.filter((entry) => !entry.stats.isDirectory()).map((entry) => rest.indexOf(entry))
      expect(indexes.at(-1)! - indexes[0]! + 1).toBe(indexes.length)
    }
    // within one entry (at most the 120 MiB video) of an equal share of the rest
    const share = runs.reduce((sum, shard) => sum + shard.bytes, 0) / runs.length
    for (const shard of runs) expect(Math.abs(shard.bytes - share)).toBeLessThanOrEqual(120 * MiB + 1024)
  })

  test("the fair share is worked out again once the big files are out", () => {
    // 3 × 100 MiB + a 60 MiB file + 40 MiB of small ones = 400 MiB; 4 shards: share 100
    // takes the three, then 100 MiB is left for one shard, so the 60 MiB file shares it
    const entries = listing([file("a.bin", 100 * MiB), file("b.bin", 100 * MiB), file("c.bin", 100 * MiB), file("d.bin", 60 * MiB), ...Array.from({ length: 40 }, (_, i) => file(`s/${i}.txt`, MiB))])
    const shards = planShards(entries, 4)
    expect(shards.map((shard) => shard.entries.length).sort((a, b) => a - b)).toEqual([1, 1, 1, 41])
    // with 8, the 60 MiB file is over the share of what is left (100 / 5) and goes alone too
    expect(planShards(entries, 8).filter((shard) => shard.entries.length === 1).map((shard) => shard.entries[0]!.rel).sort()).toEqual(["a.bin", "b.bin", "c.bin", "d.bin"])
  })

  test("fewer entries than shards, one entry, an empty listing, and count 1", () => {
    expect(planShards(listing([file("a", 10), file("b", 2000)]), 8).map((shard) => shard.entries.map((entry) => entry.rel))).toEqual([["b"], ["a"]])
    expect(planShards([file("only", 5 * MiB)], 8)).toHaveLength(1)
    expect(planShards([], 4)).toEqual([{ entries: [], bytes: 0 }])
    const entries = tree()
    expect(planShards(entries, 1)[0]!.entries).toBe(entries)
  })

  test("each shard carries the listed directories above its entries, ahead of them, so it unpacks on its own", () => {
    // d/ is worth nothing, so it goes with z.bin; without it, d/new.bin's shard would unpack
    // through whatever sits at d (a symlink, a file) when it happens to go first
    const split = listing([dir("d"), file("d/new.bin", 4 * MiB), file("z.bin", 4 * MiB - 4096)])
    const shards = planShards(split, 2)
    expect(shards.map((shard) => shard.entries.map((entry) => entry.rel))).toEqual([["d", "d/new.bin"], ["d", "z.bin"]])
    expect(shards[0]!.bytes).toBe(tarWeight(split[0]!) + tarWeight(split[1]!))

    // every level above, and only what is above: a/b/c stays with the shard that has what is in it
    const deep = listing([dir("a"), dir("a/b"), dir("a/b/c"), file("a/b/c/big.bin", 8 * MiB), file("a/b/x.txt", MiB), file("a/y.txt", MiB), file("z.bin", 6 * MiB)])
    expect(planShards(deep, 2).map((shard) => shard.entries.map((entry) => entry.rel))).toEqual([
      ["a", "a/b", "a/b/x.txt", "a/y.txt", "z.bin"],
      ["a", "a/b", "a/b/c", "a/b/c/big.bin"],
    ])

    // sets and one assertion: a lookup per entry and an expect() per parent made this quadratic,
    // past bun's 5 s on a loaded CI runner
    const entries = tree()
    const listed = new Set(entries.map((entry) => entry.rel))
    const misplaced: string[] = []
    for (const count of [2, 3, 4, 8, 16]) {
      for (const shard of planShards(entries, count)) {
        const first = new Map<string, number>()
        shard.entries.forEach((entry, index) => first.has(entry.rel) || first.set(entry.rel, index))
        shard.entries.forEach((entry, index) => {
          const rel = entry.rel
          for (let slash = rel.indexOf("/"); slash > 0; slash = rel.indexOf("/", slash + 1)) {
            const parent = rel.slice(0, slash)
            if (listed.has(parent) && !((first.get(parent) ?? Infinity) < index)) misplaced.push(`${count}: ${parent} after ${rel}`)
          }
        })
      }
    }
    expect(misplaced).toEqual([])
  })

  test("a git listing names no directories, so there is nothing to carry", () => {
    const entries = tree().filter((entry) => !entry.stats.isDirectory())
    for (const count of [2, 4, 8]) expect(planShards(entries, count).reduce((total, shard) => total + shard.entries.length, 0)).toBe(entries.length)
  })

  test("equal files split evenly", () => {
    const entries = listing(Array.from({ length: 64 }, (_, i) => file(`f/${String(i).padStart(2, "0")}`, MiB)))
    expect(planShards(entries, 8).map((shard) => shard.entries.length)).toEqual([8, 8, 8, 8, 8, 8, 8, 8])
    expect(planShards(entries, 3).map((shard) => shard.entries.length).sort()).toEqual([21, 21, 22])
  })
})
