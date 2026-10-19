// Release steps for .github/workflows/release.yml.
//   npm-preflight    public workspace packages whose version is not on npm: build, pack, check, npm publish --dry-run
//   npm-publish      the same packages: pack, publish with provenance, tag and create a GitHub release
//   crates-preflight publishable crates whose version is not on crates.io: cargo publish --dry-run
//   crates-publish   the same crates: cargo publish, then tag
// Preflights write the pending count to $GITHUB_OUTPUT. Publish steps check every package before publishing any.
// A version published by an earlier run but left without its tag or GitHub release is finished on the next run:
// its tag goes on the commit the registry says it was built from (npm's gitHead, crates' .cargo_vcs_info.json).
import { $ } from "bun"
import { appendFile, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "../..")
$.cwd(root)

type Pkg = { dir: string; name: string; version: string; isNew: boolean; published: boolean }

/** a version still has release work: unpublished, or published without its tag or (npm only) its GitHub release */
export const needsRelease = (state: { published: boolean; tagged: boolean; released: boolean }) => !state.published || !state.tagged || !state.released

/** npm publish exiting 0 means npm took the version from this run; after a failure only a registry that already shows it counts */
export function publishOutcome(exitCode: number, state?: string): "ours" | "theirs" | "failed" {
  if (exitCode === 0) return "ours"
  return state === "published" ? "theirs" : "failed"
}

/** package.json text with the commit it is packed from as gitHead, which npm keeps in the registry's metadata */
export function withGitHead(packageJson: string, commit: string): string {
  return `${JSON.stringify({ ...JSON.parse(packageJson), gitHead: commit }, null, 2)}\n`
}

/** the commit cargo recorded in a .crate's .cargo_vcs_info.json */
export function vcsInfoCommit(text: string): string | undefined {
  try {
    const sha = JSON.parse(text)?.git?.sha1
    return typeof sha === "string" ? sha : undefined
  } catch {
    return undefined
  }
}

/** a full commit sha, or an error saying how to tag by hand: never a guess */
export function publishedCommit(name: string, commit: string | undefined, source: string): string {
  if (commit && /^[0-9a-f]{40}$/.test(commit)) return commit
  throw new Error(`${name}: ${source} names no commit, so its tag cannot be placed; tag the commit it was published from by hand: git tag ${name} <sha> && git push origin refs/tags/${name}`)
}

const head = async () => (await $`git rev-parse HEAD`.quiet().text()).trim()

async function output(key: string, value: string) {
  if (Bun.env.GITHUB_OUTPUT) await appendFile(Bun.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  console.log(`${key}=${value}`)
}

async function summary(line: string) {
  if (Bun.env.GITHUB_STEP_SUMMARY) await appendFile(Bun.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  console.log(line)
}

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`${what} failed (attempt ${attempt}), retrying: ${error instanceof Error ? error.message : error}`)
      await Bun.sleep(5_000 * attempt)
    }
  }
}

/** "published", "free" (the package exists, this version doesn't) or "new" (no such package) */
async function npmState(name: string, version: string) {
  return retry(`npm view ${name}`, async () => {
    const view = await $`npm view ${`${name}@${version}`} version --prefer-online`.quiet().nothrow()
    if (view.exitCode === 0 && view.stdout.toString().trim()) return "published"
    if (view.exitCode !== 0 && !/E404/.test(view.stderr.toString())) throw new Error(view.stderr.toString().trim() || `npm view exited ${view.exitCode}`)
    // the version is missing (npm answers that with an empty result or E404): does the package exist?
    const pkg = await $`npm view ${name} name --prefer-online`.quiet().nothrow()
    if (pkg.exitCode === 0 && pkg.stdout.toString().trim()) return "free"
    if (pkg.exitCode !== 0 && /E404/.test(pkg.stderr.toString())) return "new"
    throw new Error(pkg.stderr.toString().trim() || `npm view exited ${pkg.exitCode}`)
  })
}

/** public packages whose version is not on npm, or is but has no tag or GitHub release yet (a run that stopped after publishing) */
async function pendingPackages(): Promise<Pkg[]> {
  const pending: Pkg[] = []
  for await (const file of new Bun.Glob("packages/*/*/package.json").scan({ cwd: root })) {
    const pkg = await Bun.file(join(root, file)).json()
    if (pkg.private) continue
    const state = await npmState(pkg.name, pkg.version)
    const entry = { dir: join(root, dirname(file)), name: pkg.name, version: pkg.version, isNew: state === "new", published: state === "published" }
    const name = `${pkg.name}@${pkg.version}`
    const isTagged = entry.published && (await tagged(name))
    const isReleased = isTagged && (await released(name))
    if (needsRelease({ published: entry.published, tagged: isTagged, released: isReleased })) pending.push(entry)
  }
  return pending.sort((a, b) => a.name.localeCompare(b.name))
}

/** builds the package with turbo and packs it with bun, which rewrites workspace: ranges; the manifest records this commit as gitHead */
async function pack(pkg: Pkg, commit: string) {
  await $`bunx turbo run build --filter=${pkg.name}`
  const out = await mkdtemp(join(tmpdir(), "kyora-pack-"))
  const manifestFile = join(pkg.dir, "package.json")
  const original = await Bun.file(manifestFile).text()
  await Bun.write(manifestFile, withGitHead(original, commit))
  try {
    await $`bun pm pack --destination ${out}`.cwd(pkg.dir)
  } finally {
    await Bun.write(manifestFile, original)
  }
  const tarballs = (await readdir(out)).filter(file => file.endsWith(".tgz"))
  if (tarballs.length !== 1) throw new Error(`${pkg.name}: expected one tarball, found ${tarballs.length}`)
  const tarball = join(out, tarballs[0]!)
  const manifest = JSON.parse(await $`tar -xOzf ${tarball} package/package.json`.text())
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error(`${pkg.name}: packed ${manifest.name}@${manifest.version}`)
  if (manifest.gitHead !== commit) throw new Error(`${pkg.name}: the packed package.json does not record gitHead ${commit}`)
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${pkg.name}: the packed package.json still has workspace: ranges`)
  // provenance needs the package to name this public repository
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
  if (!/github\.com[/:]kyora-sh\/kyora(\.git)?$/.test(repository ?? "")) throw new Error(`${pkg.name}: repository must point at github.com/kyora-sh/kyora for provenance`)
  return tarball
}

const prerelease = (version: string) => version.includes("-")
const distTag = (version: string) => (prerelease(version) ? "next" : "latest")

async function npmPreflight() {
  const pending = await pendingPackages()
  const commit = await head()
  for (const pkg of pending) {
    if (pkg.published) {
      await summary(`- npm: ${pkg.name}@${pkg.version} is published but its tag or GitHub release is missing`)
      continue
    }
    const tarball = await pack(pkg, commit)
    await $`npm publish ${tarball} --dry-run --access public --tag ${distTag(pkg.version)}`
    await summary(`- npm: ${pkg.name}@${pkg.version} ready${pkg.isNew ? " (new package: the first publish needs NPM_TOKEN)" : ""}`)
  }
  if (!pending.length) await summary("- npm: nothing to publish")
  await output("npm", String(pending.length))
}

/** the CHANGELOG.md section for one version, for the GitHub release */
async function changelogSection(pkg: Pkg) {
  const file = Bun.file(join(pkg.dir, "CHANGELOG.md"))
  if (!(await file.exists())) return `${pkg.name}@${pkg.version}`
  const lines = (await file.text()).split("\n")
  const start = lines.findIndex(line => line.trim() === `## ${pkg.version}`)
  if (start < 0) return `${pkg.name}@${pkg.version}`
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() || `${pkg.name}@${pkg.version}`
}

async function tagged(name: string) {
  return (await $`git ls-remote --tags origin ${`refs/tags/${name}`}`.quiet().text()).trim() !== ""
}

async function released(name: string) {
  return retry(`gh release view ${name}`, async () => {
    const view = await $`gh release view ${name} --json tagName`.quiet().nothrow()
    if (view.exitCode === 0) return true
    if (/release not found/i.test(view.stderr.toString())) return false
    throw new Error(view.stderr.toString().trim() || `gh release view exited ${view.exitCode}`)
  })
}

/** the commit npm recorded for a version this script published */
async function npmCommit(pkg: Pkg) {
  const name = `${pkg.name}@${pkg.version}`
  const gitHead = await retry(`npm view ${name} gitHead`, () => $`npm view ${name} gitHead --prefer-online`.quiet().text())
  return publishedCommit(name, gitHead.trim(), "npm's gitHead")
}

/** the commit cargo recorded in the published .crate */
async function crateCommit(crate: Crate) {
  const name = `${crate.name}@${crate.version}`
  const file = join(await mkdtemp(join(tmpdir(), "kyora-crate-")), `${crate.name}-${crate.version}.crate`)
  await retry(`download ${name}`, async () => {
    const response = await fetch(`https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`, { headers: { "user-agent": USER_AGENT } })
    if (!response.ok) throw new Error(`static.crates.io answered ${response.status}`)
    await Bun.write(file, response)
  })
  const info = await $`tar -xOzf ${file} ${`${crate.name}-${crate.version}/.cargo_vcs_info.json`}`.quiet().nothrow()
  return publishedCommit(name, info.exitCode === 0 ? vcsInfoCommit(info.stdout.toString()) : undefined, "the crate's .cargo_vcs_info.json")
}

/** tags the commit the version was published from (looked up only when the tag is missing), with a GitHub release when given notes */
async function tag(name: string, commit: () => Promise<string>, version: string, notes?: string) {
  if (!(await tagged(name))) {
    await $`git tag ${name} ${await commit()}`
    await $`git push origin ${`refs/tags/${name}`}`
  }
  if (notes === undefined || (await released(name))) return
  const flags = prerelease(version) ? ["--prerelease", "--latest=false"] : []
  await $`gh release create ${name} --title ${name} --notes ${notes} --verify-tag ${flags}`
}

async function npmPublish() {
  const pending = await pendingPackages()
  const needToken = pending.filter(pkg => pkg.isNew)
  const toPublish = pending.filter(pkg => !pkg.published)
  if (needToken.length && !Bun.env.NODE_AUTH_TOKEN) throw new Error(`new packages need NPM_TOKEN for their first publish: ${needToken.map(pkg => pkg.name).join(", ")}`)
  const commit = await head()
  const tarballs = new Map<string, string>()
  for (const pkg of toPublish) tarballs.set(pkg.name, await pack(pkg, commit))
  // published by this run's npm publish, so from this commit; anything else is looked up on npm
  const ours = new Set<string>()
  for (const pkg of toPublish) {
    await retry(`publish ${pkg.name}`, async () => {
      const publish = await $`npm publish ${tarballs.get(pkg.name)!} --access public --provenance --tag ${distTag(pkg.version)}`.nothrow()
      const outcome = publishOutcome(publish.exitCode, publish.exitCode === 0 ? undefined : await npmState(pkg.name, pkg.version))
      if (outcome === "failed") throw new Error(`npm publish exited ${publish.exitCode}`)
      if (outcome === "ours") ours.add(pkg.name)
    })
    await summary(`- npm: published ${pkg.name}@${pkg.version}`)
  }
  for (const pkg of pending) await tag(`${pkg.name}@${pkg.version}`, async () => (ours.has(pkg.name) ? commit : npmCommit(pkg)), pkg.version, await changelogSection(pkg))
  // nothing later in the release installs these packages, so registry lag (minutes at times) only warns
  for (const pkg of toPublish) {
    const visible = await retry(`npm view ${pkg.name}@${pkg.version}`, async () => {
      if ((await npmState(pkg.name, pkg.version)) !== "published") throw new Error("not visible yet")
    }, 3).then(() => true, () => false)
    if (!visible) console.log(`::warning::${pkg.name}@${pkg.version} is published and tagged but not visible on npm yet; npm can take several minutes`)
  }
  if (!pending.length) await summary("- npm: nothing to publish")
}

type Crate = { name: string; version: string; published: boolean }

const USER_AGENT = "kyora-release (github.com/kyora-sh/kyora)"

/** crates.io answers 200 for a published version and 404 otherwise */
async function crateVersionPublished(crate: Crate) {
  return retry(`crates.io ${crate.name}`, async () => {
    const response = await fetch(`https://crates.io/api/v1/crates/${crate.name}/${crate.version}`, { headers: { "user-agent": USER_AGENT } })
    if (response.status === 200) return true
    if (response.status === 404) return false
    throw new Error(`crates.io answered ${response.status}`)
  })
}

async function pendingCrates() {
  const metadata = JSON.parse(await $`cargo metadata --no-deps --format-version 1 --locked`.quiet().text())
  // publish = false shows as an empty list; null means any registry
  const publishable: Crate[] = metadata.packages.filter((pkg: { publish: string[] | null }) => pkg.publish === null || pkg.publish.includes("crates-io"))
  if (!publishable.length) throw new Error("no crate is publishable: set publish and versions in Cargo.toml before turning crates on")
  // as with npm: unpublished, or published without a tag
  const pending: Crate[] = []
  for (const crate of publishable) {
    const published = await crateVersionPublished(crate)
    if (!published || !(await tagged(`${crate.name}@${crate.version}`))) pending.push({ name: crate.name, version: crate.version, published })
  }
  return pending
}

const packageArgs = (crates: Crate[]) => crates.flatMap(crate => ["-p", crate.name])

async function cratesPreflight() {
  const pending = await pendingCrates()
  const toPublish = pending.filter(crate => !crate.published)
  if (toPublish.length) await $`cargo publish --dry-run --locked ${packageArgs(toPublish)}`
  for (const crate of pending) await summary(`- crates: ${crate.name}@${crate.version} ${crate.published ? "is published but not tagged yet" : "ready"}`)
  if (!pending.length) await summary("- crates: nothing to publish")
  await output("crates", String(pending.length))
}

async function cratesPublish() {
  const pending = await pendingCrates()
  if (!pending.length) return summary("- crates: nothing to publish")
  const toPublish = pending.filter(crate => !crate.published)
  if (toPublish.length && !Bun.env.CARGO_REGISTRY_TOKEN) throw new Error("CARGO_REGISTRY_TOKEN is unset")
  const commit = await head()
  // when cargo succeeds it published every crate it was given from this commit; anything else is looked up on crates.io
  let ours = false
  try {
    // cargo publishes them in dependency order and waits for each to be available before the next
    if (toPublish.length) await $`cargo publish --locked ${packageArgs(toPublish)}`
    ours = true
  } finally {
    // tag whatever reached crates.io, also when cargo stopped part way
    for (const crate of pending) {
      if (!crate.published && !(await crateVersionPublished(crate))) continue
      await tag(`${crate.name}@${crate.version}`, async () => (ours && !crate.published ? commit : crateCommit(crate)), crate.version)
      await summary(`- crates: published ${crate.name}@${crate.version}`)
    }
  }
}

const steps: Record<string, () => Promise<unknown>> = {
  "npm-preflight": npmPreflight,
  "npm-publish": npmPublish,
  "crates-preflight": cratesPreflight,
  "crates-publish": cratesPublish,
}

if (import.meta.main) {
  const step = steps[Bun.argv[2] ?? ""]
  if (!step) {
    console.error(`usage: bun .github/scripts/release.ts <${Object.keys(steps).join("|")}>`)
    process.exit(2)
  }
  await step()
}
