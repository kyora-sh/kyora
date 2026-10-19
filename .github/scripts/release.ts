// Release steps for .github/workflows/release.yml.
//   npm-preflight    public workspace packages whose version is not on npm: build, pack, check, npm publish --dry-run
//   npm-publish      the same packages: pack, publish with provenance, tag and create a GitHub release
//   crates-preflight publishable crates whose version is not on crates.io: cargo publish --dry-run
//   crates-publish   the same crates: cargo publish, then tag
// Preflights write the pending count to $GITHUB_OUTPUT. Publish steps check every package before publishing any.
import { $ } from "bun"
import { appendFile, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "../..")
$.cwd(root)

type Pkg = { dir: string; name: string; version: string; isNew: boolean; published: boolean }

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

/** public packages whose version is not on npm, or is but has no tag yet (a run that stopped after publishing) */
async function pendingPackages(): Promise<Pkg[]> {
  const pending: Pkg[] = []
  for await (const file of new Bun.Glob("packages/*/*/package.json").scan({ cwd: root })) {
    const pkg = await Bun.file(join(root, file)).json()
    if (pkg.private) continue
    const state = await npmState(pkg.name, pkg.version)
    const entry = { dir: join(root, dirname(file)), name: pkg.name, version: pkg.version, isNew: state === "new", published: state === "published" }
    if (!entry.published || !(await tagged(`${pkg.name}@${pkg.version}`))) pending.push(entry)
  }
  return pending.sort((a, b) => a.name.localeCompare(b.name))
}

/** builds the package with turbo and packs it with bun, which rewrites workspace: ranges */
async function pack(pkg: Pkg) {
  await $`bunx turbo run build --filter=${pkg.name}`
  const out = await mkdtemp(join(tmpdir(), "kyora-pack-"))
  await $`bun pm pack --destination ${out}`.cwd(pkg.dir)
  const tarballs = (await readdir(out)).filter(file => file.endsWith(".tgz"))
  if (tarballs.length !== 1) throw new Error(`${pkg.name}: expected one tarball, found ${tarballs.length}`)
  const tarball = join(out, tarballs[0]!)
  const manifest = JSON.parse(await $`tar -xOzf ${tarball} package/package.json`.text())
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error(`${pkg.name}: packed ${manifest.name}@${manifest.version}`)
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
  for (const pkg of pending) {
    if (pkg.published) {
      await summary(`- npm: ${pkg.name}@${pkg.version} is published but not tagged yet`)
      continue
    }
    const tarball = await pack(pkg)
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

/** tags the commit that last changed the version file (so a later rerun tags the release, not main's head), with a GitHub release when given notes */
async function tag(name: string, versionFile: string, version: string, notes?: string) {
  if (!(await tagged(name))) {
    const commit = (await $`git log -1 --format=%H -- ${versionFile}`.text()).trim() || (Bun.env.GITHUB_SHA ?? "HEAD")
    await $`git tag ${name} ${commit}`
    await $`git push origin ${`refs/tags/${name}`}`
  }
  if (notes === undefined) return
  const release = await $`gh release view ${name}`.quiet().nothrow()
  if (release.exitCode === 0) return
  const flags = prerelease(version) ? ["--prerelease", "--latest=false"] : []
  await $`gh release create ${name} --title ${name} --notes ${notes} --verify-tag ${flags}`
}

async function npmPublish() {
  const pending = await pendingPackages()
  const needToken = pending.filter(pkg => pkg.isNew)
  const toPublish = pending.filter(pkg => !pkg.published)
  if (needToken.length && !Bun.env.NODE_AUTH_TOKEN) throw new Error(`new packages need NPM_TOKEN for their first publish: ${needToken.map(pkg => pkg.name).join(", ")}`)
  const tarballs = new Map<string, string>()
  for (const pkg of toPublish) tarballs.set(pkg.name, await pack(pkg))
  for (const pkg of toPublish) {
    await retry(`publish ${pkg.name}`, async () => {
      const publish = await $`npm publish ${tarballs.get(pkg.name)!} --access public --provenance --tag ${distTag(pkg.version)}`.nothrow()
      if (publish.exitCode !== 0 && (await npmState(pkg.name, pkg.version)) !== "published") throw new Error(`npm publish exited ${publish.exitCode}`)
    })
    await retry(`confirm ${pkg.name}`, async () => {
      if ((await npmState(pkg.name, pkg.version)) !== "published") throw new Error(`${pkg.name}@${pkg.version} is not visible on npm yet`)
    }, 6)
    await summary(`- npm: published ${pkg.name}@${pkg.version}`)
  }
  for (const pkg of pending) await tag(`${pkg.name}@${pkg.version}`, join(pkg.dir, "package.json"), pkg.version, await changelogSection(pkg))
  if (!pending.length) await summary("- npm: nothing to publish")
}

type Crate = { name: string; version: string; published: boolean }

/** crates.io answers 200 for a published version and 404 otherwise */
async function crateVersionPublished(crate: Crate) {
  return retry(`crates.io ${crate.name}`, async () => {
    const response = await fetch(`https://crates.io/api/v1/crates/${crate.name}/${crate.version}`, { headers: { "user-agent": "kyora-release (github.com/kyora-sh/kyora)" } })
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
  try {
    // cargo publishes them in dependency order and waits for each to be available before the next
    if (toPublish.length) await $`cargo publish --locked ${packageArgs(toPublish)}`
  } finally {
    // tag whatever reached crates.io, also when cargo stopped part way
    for (const crate of pending) {
      if (!crate.published && !(await crateVersionPublished(crate))) continue
      await tag(`${crate.name}@${crate.version}`, "Cargo.toml", crate.version)
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

const step = steps[Bun.argv[2] ?? ""]
if (!step) {
  console.error(`usage: bun .github/scripts/release.ts <${Object.keys(steps).join("|")}>`)
  process.exit(2)
}
await step()
