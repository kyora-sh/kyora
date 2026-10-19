import { expect, test } from "bun:test"
import { needsRelease, publishOutcome, publishedCommit, vcsInfoCommit, withGitHead } from "./release"

const sha = "0123456789abcdef0123456789abcdef01234567"

test("a published version missing its tag or its GitHub release still has release work", () => {
  expect(needsRelease({ published: false, tagged: false, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: false, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: true, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: true, released: true })).toBe(false)
})

test("the packed manifest records the commit as gitHead and keeps every other field", () => {
  const original = `${JSON.stringify({ name: "kyora", version: "1.2.3", bin: { kyora: "./dist/kyora.js" } }, null, 2)}\n`
  const packed = JSON.parse(withGitHead(original, sha))
  expect(packed).toEqual({ name: "kyora", version: "1.2.3", bin: { kyora: "./dist/kyora.js" }, gitHead: sha })
  expect(JSON.parse(withGitHead(withGitHead(original, "f".repeat(40)), sha)).gitHead).toBe(sha)
})

test("the commit comes from cargo's .cargo_vcs_info.json", () => {
  expect(vcsInfoCommit(JSON.stringify({ git: { sha1: sha }, path_in_vcs: "crates/cli" }))).toBe(sha)
  expect(vcsInfoCommit(JSON.stringify({ path_in_vcs: "crates/cli" }))).toBeUndefined()
  expect(vcsInfoCommit("not json")).toBeUndefined()
})

test("a version with no recorded commit is never tagged on a guess", () => {
  expect(publishedCommit("kyora@1.2.3", sha, "npm's gitHead")).toBe(sha)
  for (const missing of [undefined, "", "HEAD", sha.slice(0, 12)]) {
    expect(() => publishedCommit("kyora@1.2.3", missing, "npm's gitHead")).toThrow("kyora@1.2.3: npm's gitHead names no commit")
  }
})

test("npm publish exiting 0 is a finished publish from this run, whatever the registry shows yet", () => {
  for (const state of [undefined, "published", "free", "new"]) expect(publishOutcome(0, state)).toBe("ours")
  expect(publishOutcome(1, "published")).toBe("theirs")
  for (const state of [undefined, "free", "new"]) expect(publishOutcome(1, state)).toBe("failed")
})
