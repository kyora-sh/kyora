import type { PackEntry } from "./pack"
import { BLOCK } from "./tar"

const MiB = 1024 * 1024

/** about this much raw data per shard when the count is picked for you */
export const SHARD_BYTES = 256 * MiB
/** the most shards picked for you */
export const AUTO_SHARDS = 8
/** the most `--shards` takes */
export const MAX_SHARDS = 16

/** one per 256 MiB of files, 1 to 8: a small upload stays a single stream */
export function autoShards(bytes: number): number {
  return Math.min(AUTO_SHARDS, Math.max(1, Math.ceil(bytes / SHARD_BYTES)))
}

/** what an entry adds to the tar: its header and its data padded to whole blocks */
export function tarWeight(entry: PackEntry): number {
  const size = entry.stats.isFile() ? entry.stats.size : 0
  return BLOCK + Math.ceil(size / BLOCK) * BLOCK
}

export interface Shard {
  /** in listing order, with the directory entries above them (see planShards) */
  entries: PackEntry[]
  /** tar bytes before compression */
  bytes: number
}

const sum = (entries: PackEntry[]) => entries.reduce((total, entry) => total + tarWeight(entry), 0)

/**
 * Splits a listing into at most `count` archives of about the same size, the same way
 * every time. An entry worth a fair share on its own gets an archive to itself (the
 * share is worked out again as those come off, since what is left gets smaller). The
 * rest is cut into contiguous runs of the sorted listing, so files that sit together
 * (and compress well together) stay in one stream. Biggest shard first, so it starts
 * first. Nothing in one shard depends on another: each is a whole tar the guest
 * unpacks on its own, side by side with the others and in no particular order. So
 * each carries the listing's directory entries above its own, ahead of them, and
 * unpacks as that part of one whole archive would: a directory replaces the file or
 * symlink in its way before anything goes in under it (without its entry the guest
 * would write through such a symlink, or fail on the file), whichever shard gets
 * there first. Those few headers go up with every shard that needs them.
 */
export function planShards(entries: PackEntry[], count: number): Shard[] {
  if (count <= 1 || entries.length <= 1) return [{ entries, bytes: sum(entries) }]

  const alone: PackEntry[] = []
  let rest = entries
  let restBytes = sum(entries)
  let slots = Math.min(count, entries.length)
  while (slots > 1 && rest.length > 0) {
    const share = restBytes / slots
    let big = rest.filter((entry) => tarWeight(entry) >= share)
    if (big.length === 0) break
    // only possible when every entry left is big; otherwise some room must stay for the rest
    if (big.length >= slots && big.length < rest.length) {
      big = [...big].sort((a, b) => tarWeight(b) - tarWeight(a) || compare(a.rel, b.rel)).slice(0, slots - 1)
    }
    const taken = new Set(big)
    alone.push(...big)
    rest = rest.filter((entry) => !taken.has(entry))
    restBytes -= sum(big)
    slots -= big.length
  }

  const runs: PackEntry[][] = Array.from({ length: Math.max(1, slots) }, () => [])
  let before = 0
  for (const entry of rest) {
    const weight = tarWeight(entry)
    // the run an entry's midpoint falls in: contiguous, and each run within one entry of its share
    const index = Math.min(runs.length - 1, Math.floor(((before + weight / 2) * runs.length) / Math.max(restBytes, 1)))
    runs[index]!.push(entry)
    before += weight
  }

  const dirs = new Map(entries.filter((entry) => entry.stats.isDirectory()).map((entry) => [entry.rel, entry]))
  const order = new Map(entries.map((entry, index) => [entry, index]))
  const shards = [...alone.map((entry) => [entry]), ...runs.filter((run) => run.length > 0)].map((run) => {
    const shardEntries = withParents(run, dirs, order)
    return { entries: shardEntries, bytes: sum(shardEntries) }
  })
  return shards.sort((a, b) => b.bytes - a.bytes || compare(a.entries[0]!.rel, b.entries[0]!.rel))
}

/** `run` with the listed directories above its entries that it lacks, all in listing order */
function withParents(run: PackEntry[], dirs: Map<string, PackEntry>, order: Map<PackEntry, number>): PackEntry[] {
  const has = new Set(run)
  const seen = new Set<string>()
  const parents: PackEntry[] = []
  for (const entry of run) {
    for (let slash = entry.rel.lastIndexOf("/"); slash > 0; slash = entry.rel.lastIndexOf("/", slash - 1)) {
      const parent = entry.rel.slice(0, slash)
      // and everything above it, when it was seen
      if (seen.has(parent)) break
      seen.add(parent)
      const dir = dirs.get(parent)
      if (dir && !has.has(dir)) parents.push(dir)
    }
  }
  return parents.length === 0 ? run : [...run, ...parents].sort((a, b) => order.get(a)! - order.get(b)!)
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
