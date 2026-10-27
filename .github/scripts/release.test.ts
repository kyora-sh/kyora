import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  lockVersion,
  metadataProblems,
  needsRelease,
  npmPublished,
  pep440,
  publishOutcome,
  publishedCommit,
  pypiProgress,
  pypiRelease,
  pypiTag,
  pyprojectVersion,
  sourceCommit,
  vcsInfoCommit,
  withGitHead,
  withLockVersion,
  withPyprojectVersion,
  withSourceCommit,
} from "./release"

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

test("a tagged version counts as published while npm does not show it yet", () => {
  expect(npmPublished("published", false)).toBe(true)
  for (const state of ["free", "new"]) {
    expect(npmPublished(state, true)).toBe(true)
    expect(npmPublished(state, false)).toBe(false)
  }
})

const root = join(import.meta.dir, "../..")

test("the Python SDK's version is @kyora-sh/sdk's, in pyproject.toml and uv.lock", async () => {
  const ts = await Bun.file(join(root, "packages/sdk/typescript/package.json")).json()
  expect(pyprojectVersion(await Bun.file(join(root, "packages/sdk/python/pyproject.toml")).text())).toBe(pep440(ts.version))
  expect(lockVersion(await Bun.file(join(root, "packages/sdk/python/uv.lock")).text(), "kyora")).toBe(pep440(ts.version))
})

test("semver versions map to PEP 440, and a prerelease with no PEP 440 form is refused", () => {
  expect(pep440("1.2.3")).toBe("1.2.3")
  expect(pep440("1.2.3-alpha.0")).toBe("1.2.3a0")
  expect(pep440("1.2.3-beta.2")).toBe("1.2.3b2")
  expect(pep440("1.2.3-rc.10")).toBe("1.2.3rc10")
  for (const version of ["1.2.3-next.0", "1.2.3-rc", "1.2.3+build", "1.2"]) expect(() => pep440(version)).toThrow(`${version} has no PEP 440 form`)
})

test("the Python SDK's tag never collides with the npm package kyora's", () => {
  expect(pypiTag("0.2.0")).toBe("pypi/kyora@0.2.0")
  expect(pypiTag("0.2.0")).not.toBe("kyora@0.2.0")
})

const pyproject = `[project]
name = "kyora"
version = "0.0.0"
dependencies = ["httpx>=0.27"]

[project.urls]
Homepage = "https://kyora.sh"
Repository = "https://github.com/kyora-sh/kyora"

[tool.hatch.version]
version = "ignored"
`

test("the version sync rewrites only the [project] version", () => {
  expect(pyprojectVersion(pyproject)).toBe("0.0.0")
  const synced = withPyprojectVersion(pyproject, "1.2.3rc1")
  expect(pyprojectVersion(synced)).toBe("1.2.3rc1")
  expect(synced).toBe(pyproject.replace('version = "0.0.0"', 'version = "1.2.3rc1"'))
  expect(() => withPyprojectVersion('[tool.x]\nversion = "1"\n', "1.2.3")).toThrow("no [project] version")
})

test("the version sync rewrites only the project's own uv.lock entry", () => {
  const lock = `version = 1

[[package]]
name = "httpx"
version = "0.28.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "kyora"
version = "0.0.0"
source = { editable = "." }
dependencies = [
    { name = "httpx" },
]
`
  const synced = withLockVersion(lock, "kyora", "1.2.3")
  expect(lockVersion(synced, "kyora")).toBe("1.2.3")
  expect(synced).toBe(lock.replace('version = "0.0.0"', 'version = "1.2.3"'))
  expect(() => lockVersion(lock, "httpx")).toThrow("uv.lock has 0 editable entries for httpx")
})

test("the build records its commit as the Source project URL, which PyPI keeps", () => {
  const stamped = withSourceCommit(pyproject, sha)
  expect(stamped).toContain(`[project.urls]\nSource = "https://github.com/kyora-sh/kyora/tree/${sha}"\nHomepage = "https://kyora.sh"`)
  expect(withSourceCommit(withSourceCommit(pyproject, "f".repeat(40)), sha)).toBe(stamped)
  expect(withSourceCommit('[project]\nname = "kyora"\n', sha)).toBe(`[project]\nname = "kyora"\n\n[project.urls]\nSource = "https://github.com/kyora-sh/kyora/tree/${sha}"\n`)
  expect(sourceCommit({ Source: `https://github.com/kyora-sh/kyora/tree/${sha}` })).toBe(sha)
  for (const urls of [null, undefined, {}, { Source: "https://github.com/kyora-sh/kyora" }, { Source: `https://github.com/someone/kyora/tree/${sha}` }]) {
    expect(sourceCommit(urls)).toBeUndefined()
  }
})

test("a wheel is checked for its name, version, commit and repository", () => {
  const metadata = (fields: string[]) => `Metadata-Version: 2.4\n${fields.join("\n")}\n\n# kyora\n\nName: kyora\n`
  const good = ["Name: kyora", "Version: 1.2.3", `Project-URL: Source, https://github.com/kyora-sh/kyora/tree/${sha}`, "Project-URL: Repository, https://github.com/kyora-sh/kyora"]
  expect(metadataProblems(metadata(good), "1.2.3", sha)).toEqual([])
  expect(metadataProblems(metadata(good.slice(1)), "1.2.3", sha)).toEqual(["not named kyora"])
  expect(metadataProblems(metadata(good), "1.2.4", sha)).toEqual(["not version 1.2.4"])
  expect(metadataProblems(metadata(good), "1.2.3", "f".repeat(40))).toEqual([`no Source project URL for ${"f".repeat(40)}`])
  expect(metadataProblems(metadata([...good.slice(0, 3), "Project-URL: Repository, https://github.com/kyora-sh/kyora-platform"]), "1.2.3", sha)).toEqual([
    "Repository project URL is not github.com/kyora-sh/kyora",
  ])
})

const pypiJson = (files: string[]) => ({
  info: { project_urls: { Source: `https://github.com/kyora-sh/kyora/tree/${sha}` } },
  urls: files.map(filename => ({ filename, packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist" })),
})

test("an upload interrupted after the wheel is not published: the sdist is rebuilt from the wheel's commit, and nothing is tagged yet", () => {
  const release = pypiRelease(pypiJson(["kyora-1.2.3-py3-none-any.whl"]))
  expect(pypiProgress("1.2.3", false, release)).toEqual({ uploaded: ["kyora-1.2.3-py3-none-any.whl"], missing: ["kyora-1.2.3.tar.gz"], published: false, partial: true })
  expect(sourceCommit(release.projectUrls)).toBe(sha)
  expect(pypiProgress("1.2.3", false, pypiRelease(pypiJson(["kyora-1.2.3.tar.gz"])))).toMatchObject({ missing: ["kyora-1.2.3-py3-none-any.whl"], published: false, partial: true })
})

test("a version is published only with both files on PyPI, or once tagged", () => {
  const both = pypiRelease(pypiJson(["kyora-1.2.3-py3-none-any.whl", "kyora-1.2.3.tar.gz"]))
  expect(pypiProgress("1.2.3", false, both)).toEqual({ uploaded: ["kyora-1.2.3-py3-none-any.whl", "kyora-1.2.3.tar.gz"], missing: [], published: true, partial: false })
  expect(pypiProgress("1.2.3", false, undefined)).toEqual({ uploaded: [], missing: ["kyora-1.2.3-py3-none-any.whl", "kyora-1.2.3.tar.gz"], published: false, partial: false })
  expect(pypiProgress("1.2.3", false, pypiRelease(pypiJson(["kyora-1.2.2.tar.gz"])))).toMatchObject({ published: false, partial: false })
  expect(pypiProgress("1.2.3", true, undefined)).toMatchObject({ missing: [], published: true, partial: false })
})
