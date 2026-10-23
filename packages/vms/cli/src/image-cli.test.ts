import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { BUILDER_HASH } from "./image-builder-assets"
import { toImageJson } from "../../shared/ci-image-spec"
import { checkSpec, contentKey, loadSpec } from "./image-spec"
import { startFakePlatform, type FakeAccountImage, type FakeVmd } from "./testing/fake-vmd"
import { cli, platformEnv, tempDir, write } from "./testing/fixtures"

/**
 * The image commands end to end against the fake kyora cloud: `image build --json` (a cached build
 * needs no sandbox; a bad spec exits 2 naming the field), `image lock`, `create --image <name>`
 * pinned by the lock, `image ls`, `image versions` and `image rm name@N`, and `images build <name> --from`.
 */

setDefaultTimeout(60_000)

let root: string
let cloud: FakeVmd

const BUILD = "full-0123"
const SPEC = { name: "platform", base: "default", apt: ["jq"], node: "24.11.1", pnpm: "10.33.2" }

beforeEach(async () => {
  root = await tempDir("image-cli")
  const regions = [{ region: "eu", available: true, building: false, unknown: false, builds: [BUILD] }]
  cloud = await startFakePlatform({ images: [{ name: "default", regions }, { name: "gha-runner", regions }] })
})

afterEach(async () => {
  await cloud.stop()
  await rm(root, { recursive: true, force: true })
})

const env = () => platformEnv(cloud.url)
const loggedOut = () => platformEnv(cloud.url, { KYORA_TOKEN: undefined })

function seed(version: number, fields: Partial<FakeAccountImage> = {}): FakeAccountImage {
  const image: FakeAccountImage = {
    id: `img_seeded${String(version).padStart(6, "0")}`,
    name: "platform",
    version,
    specKey: null,
    base: null,
    status: "ready",
    region: "eu",
    sha256: String(version).repeat(64).slice(0, 64),
    bytes: 4 * 1024 * 1024,
    chunks: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    readyAt: "2026-10-06T00:00:01.000Z",
    ...fields,
  }
  cloud.accountImages.set(image.id, image)
  return image
}

test("image build --json: the same spec on the same base is the version that has its key, at once, as one JSON line", async () => {
  await write(root, "kyora.image.json", JSON.stringify(SPEC))
  const key = contentKey(await loadSpec(join(root, "kyora.image.json")), BUILD, BUILDER_HASH)
  seed(1)
  seed(2, { specKey: key, base: `default@${BUILD}` })
  const built = await cli(["image", "build", "--json"], { cwd: root, env: env() })
  expect(built.code).toBe(0)
  const result = JSON.parse(built.stdout) as Record<string, unknown>
  expect(result).toMatchObject({ ref: "platform@2", name: "platform", version: 2, digest: `sha256:${"2".repeat(64)}`, region: "eu", sizeBytes: 4 * 1024 * 1024, cached: true, key })
  expect(typeof result.durationMs).toBe("number")
  expect(built.stdout.trim().split("\n")).toHaveLength(1)
  expect(built.stderr).toContain("reusing it (cached)")
  // nothing booted for it
  expect(cloud.created).toHaveLength(0)

  // plain: the ref on stdout, for scripts
  const plain = await cli(["image", "build", join(root, "kyora.image.json")], { cwd: "/", env: env() })
  expect([plain.code, plain.stdout.trim()]).toEqual([0, "platform@2"])
})

test("image build with a bad spec exits 2 and names every field; no spec at all says what to write", async () => {
  await write(root, "kyora.image.json", JSON.stringify({ ...SPEC, node: "24", apt: ["Bad"] }))
  const bad = await cli(["image", "build", "--json"], { cwd: root, env: env() })
  expect(bad.code).toBe(2)
  expect(bad.stdout).toBe("")
  expect(bad.stderr).toContain('node: must be an exact version like "24.11.1"')
  expect(bad.stderr).toContain("apt[0]")
  expect(cloud.created).toHaveLength(0)
  const none = await cli(["image", "build"], { cwd: join(root, ".."), env: env() })
  expect(none.code).toBe(2)
  expect(none.stderr).toContain("kyora.image.json")
})

test("image lock pins the newest version; create --image <name> here boots it and says so; elsewhere it is the newest", async () => {
  await write(root, "kyora.image.json", JSON.stringify(SPEC))
  seed(1)
  seed(2)
  const locked = await cli(["image", "lock"], { cwd: root, env: env() })
  expect(locked.code).toBe(0)
  const lock = JSON.parse(await Bun.file(join(root, "kyora.image.lock")).text())
  expect(lock.images.platform).toMatchObject({ ref: "platform@2", version: 2, digest: `sha256:${"2".repeat(64)}`, id: "img_seeded000002" })

  seed(3)
  const pinned = await cli(["create", "--image", "platform"], { cwd: root, env: env() })
  expect(pinned.code).toBe(0)
  expect((cloud.created.at(-1) as { image?: string }).image).toBe("platform@2")
  expect(pinned.stderr).toContain("pinned by kyora.image.lock")
  const anywhere = await cli(["create", "--image", "platform"], { cwd: join(root, ".."), env: env() })
  expect((cloud.created.at(-1) as { image?: string }).image).toBe("platform")
  expect(anywhere.code).toBe(0)
  // a pinned ref is taken as it is, the lock or not
  await cli(["create", "--image", `platform@sha256:${"1".repeat(64)}`], { cwd: root, env: env() })
  expect((cloud.created.at(-1) as { image?: string }).image).toBe(`platform@sha256:${"1".repeat(64)}`)
  const relocked = await cli(["image", "lock", "--json"], { cwd: root, env: env() })
  expect(JSON.parse(relocked.stdout)).toMatchObject({ ref: "platform@3" })
})

test("image ls by name, image versions, image rm name@N", async () => {
  seed(1)
  seed(2, { region: "us" })
  seed(1, { id: "img_seededrunner1", name: "runner" })
  const listed = await cli(["image", "ls"], { cwd: root, env: env() })
  expect(listed.code).toBe(0)
  expect(listed.stdout).toContain("platform  platform@2  2 versions  4.0 MB  eu,us")
  expect(listed.stdout).toContain("runner  runner@1  1 version")
  const versions = await cli(["image", "versions", "platform"], { cwd: root, env: env() })
  expect(versions.stdout.trim().split("\n").map((line) => line.split("  ")[0])).toEqual(["platform@2", "platform@1"])
  const removed = await cli(["image", "rm", "platform@1", "--json"], { cwd: root, env: env() })
  expect(removed.code).toBe(0)
  expect(JSON.parse(removed.stdout)).toEqual({ deleted: "img_seeded000001", ref: "platform@1" })
  expect(cloud.accountImages.get("img_seeded000001")!.status).toBe("deleted")
  const gone = await cli(["image", "rm", "platform@1"], { cwd: root, env: env() })
  expect(gone.code).not.toBe(0)
  expect(gone.stderr).toContain("no such image")
  const bare = await cli(["image", "rm", "platform"], { cwd: root, env: env() })
  expect(bare.code).not.toBe(0)
  expect(bare.stderr).toContain("name@N")
})

test("images build <name> --from: a setup script and packages on gha-runner, the version with that spec's key at once", async () => {
  await write(root, "setup.sh", "curl -fsSL https://example.com/x.sh | sh\n")
  const spec = toImageJson({ packages: ["protobuf-compiler", "jq"], setup: "curl -fsSL https://example.com/x.sh | sh\n" }, "gha-runner", { name: "ci-web" })
  const key = contentKey(await checkSpec(spec, "spec"), BUILD, BUILDER_HASH)
  seed(4, { name: "ci-web", specKey: key, base: `gha-runner@${BUILD}` })
  const built = await cli(["images", "build", "ci-web", "--from", "gha-runner", "--file", "setup.sh", "--package", "protobuf-compiler", "--package", "jq", "--json"], { cwd: root, env: env() })
  expect(built.code).toBe(0)
  expect(JSON.parse(built.stdout)).toMatchObject({ ref: "ci-web@4", name: "ci-web", cached: true, key })
  expect(cloud.created).toHaveLength(0)
  // `image` and --name are the same command
  const again = await cli(["image", "build", "--name", "ci-web", "--from", "gha-runner", "--package", "jq", "--package", "protobuf-compiler", "--file", join(root, "setup.sh")], { cwd: "/", env: env() })
  expect([again.code, again.stdout.trim()]).toEqual([0, "ci-web@4"])
})

test("images build --from: a bad base, a bad package, a missing file or a Dockerfile costs no sandbox", async () => {
  const notFleet = await cli(["images", "build", "ci-web", "--from", "acme", "--package", "jq"], { cwd: root, env: env() })
  expect(notFleet.code).toBe(2)
  expect(notFleet.stderr).toContain("--from acme: base: must be one of kyora's images")
  for (const [args, message] of [
    [["--from", "gha-runner", "--package", "Bad_Name"], "--package takes an Ubuntu package name"],
    [["--from", "gha-runner", "--file", "missing.sh"], "--file missing.sh: no such file"],
    [["--from", "gha-runner", "--dockerfile", "Dockerfile"], "--dockerfile"],
    [["--from", "gha-runner"], "needs what to add to the base"],
    [["--package", "jq"], "go with --from <base>"],
  ] as Array<[string[], string]>) {
    const result = await cli(["images", "build", "ci-web", ...args], { cwd: root, env: env() })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(message)
  }
  const nameless = await cli(["images", "build", "--from", "gha-runner", "--package", "jq"], { cwd: root, env: env() })
  expect(nameless.stderr).toContain("needs the image's name")
  expect(cloud.created).toHaveLength(0)
})

test("images is image for every subcommand; bare images is still the fleet's", async () => {
  seed(1)
  const listed = await cli(["images", "ls"], { cwd: root, env: env() })
  expect(listed.stdout).toContain("platform  platform@1  1 version")
  const versions = await cli(["images", "versions", "platform"], { cwd: root, env: env() })
  expect(versions.stdout).toContain("platform@1")
  const fleet = await cli(["images"], { cwd: root, env: env() })
  expect(fleet.stdout).toContain("gha-runner  eu  available")
  const misplaced = await cli(["images", "rm", "platform@1", "--from", "gha-runner"], { cwd: root, env: env() })
  expect(misplaced.code).not.toBe(0)
  expect(misplaced.stderr).toContain("go with image build")
  expect(cloud.accountImages.get("img_seeded000001")!.status).toBe("ready")
})

test("images check: what CI makes of .github/kyora.yml, exit 1 when it refuses a construct, no sandbox and no login", async () => {
  const clean = join(root, "clean")
  await write(clean, ".github/kyora.yml", "packages: [jq]\nimage:\n  setup: make tools\n")
  const ok = await cli(["images", "check", clean], { cwd: "/", env: loggedOut() })
  expect([ok.code, ok.stdout.trim()]).toEqual([0, ".github/kyora.yml: ok"])

  const soft = join(root, "soft")
  await write(soft, ".github/kyora.yaml", "packages: [jq, Bad_Name]\n")
  const warned = await cli(["image", "check"], { cwd: soft, env: loggedOut() })
  expect(warned.code).toBe(0)
  expect(warned.stdout).toContain('.github/kyora.yaml: packages: not a package name: "Bad_Name"')

  await write(root, ".github/kyora.yml", "image:\n  dockerfile: ci.Dockerfile\nlabels:\n  big:\n    image: {dockerfile: big.Dockerfile}\n")
  const refused = await cli(["images", "check", "."], { cwd: root, env: loggedOut() })
  expect(refused.code).toBe(1)
  expect(refused.stdout).toContain(".github/kyora.yml: image.dockerfile is not supported yet; use image.setup")
  expect(refused.stdout).toContain(".github/kyora.yml: labels.big.image.dockerfile is not supported yet; use labels.big.image.setup")
  expect(refused.stdout).toContain(".github/kyora.yml: refused image.dockerfile, labels.big.image.dockerfile")
  const asJson = await cli(["images", "check", root, "--json"], { cwd: "/", env: loggedOut() })
  expect(asJson.code).toBe(1)
  expect(JSON.parse(asJson.stdout)).toMatchObject({ file: ".github/kyora.yml", ok: false, refused: ["image.dockerfile", "labels.big.image.dockerfile"], spec: null, ref: null })

  // bytes as CI reads them: a BOM counts toward 64 KiB, as every CI reader counts it
  const bom = join(root, "bom")
  await write(bom, ".github/kyora.yml", `\uFEFFpackages: [jq]\n#${"x".repeat((64 << 10) - 19)}\n`)
  expect((await Bun.file(join(bom, ".github/kyora.yml")).arrayBuffer()).byteLength).toBe((64 << 10) + 1)
  const big = await cli(["images", "check", bom, "--json"], { cwd: "/", env: loggedOut() })
  expect([big.code, JSON.parse(big.stdout).refused]).toEqual([1, ["kyora.yml"]])
  if (process.getuid?.() !== 0) {
    const locked = join(root, "locked")
    await write(locked, ".github/kyora.yml", "packages: [jq]\n", 0o000)
    const unreadable = await cli(["images", "check", locked, "--json"], { cwd: "/", env: loggedOut() })
    expect([unreadable.code, JSON.parse(unreadable.stdout).refused]).toEqual([1, ["kyora.yml"]])
  }

  const missing = await cli(["images", "check", join(root, "nowhere")], { cwd: "/", env: loggedOut() })
  expect(missing.code).toBe(2)
  expect(missing.stderr).toContain("no .github/kyora.yml or .github/kyora.yaml in")
  expect(cloud.created).toHaveLength(0)
})
