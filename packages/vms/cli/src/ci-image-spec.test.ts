import { expect, test } from "bun:test"
import { join } from "node:path"
import { ciImageKey, choiceFor, MAX_LABELS, MAX_WARNINGS, parseKyoraYml, toImageJson, type CiImageSpec } from "../../shared/ci-image-spec"
import { checkSpec } from "./image-spec"

/**
 * packages/vms/shared/ci-image-spec.ts: the shared vectors and what
 * toImageJson hands `kyora vms image build`.
 */

interface Vector {
  name: string
  yml: string
  base: string
  expect: unknown
  keys: Record<string, string | null>
}

const { vectors } = (await Bun.file(join(import.meta.dir, "../../shared/ci-image-spec.vectors.json")).json()) as { vectors: Vector[] }

test.each(vectors.map((vector) => [vector.name, vector] as const))("vector: %s", async (_name, vector) => {
  const parsed = parseKyoraYml(vector.yml)
  expect(parsed).toEqual(vector.expect as typeof parsed)
  const keys: Record<string, string | null> = {}
  keys[""] = parsed.spec ? await ciImageKey(parsed.spec, vector.base) : null
  for (const [label, choice] of Object.entries(parsed.labels)) keys[label] = choice.spec ? await ciImageKey(choice.spec, vector.base) : null
  expect(keys).toEqual(vector.keys)
})

test("the key changes with the base build, packages and setup, not their order", async () => {
  const spec: CiImageSpec = { packages: ["jq", "git"], setup: "make\n" }
  const key = await ciImageKey(spec, "b1")
  expect(key).toMatch(/^cik_[0-9a-f]{64}$/)
  expect(await ciImageKey({ ...spec, packages: ["git", "jq", "jq"] }, "b1")).toBe(key)
  for (const other of [
    ciImageKey(spec, "b2"),
    ciImageKey({ ...spec, packages: ["jq"] }, "b1"),
    ciImageKey({ ...spec, setup: "make all\n" }, "b1"),
    ciImageKey({ ...spec, setup: null }, "b1"),
  ]) expect(await other).not.toBe(key)
})

test("a job's labels pick their own entry, the first that has one, else the top level", () => {
  const parsed = parseKyoraYml("image: acme-ci\nlabels:\n  big: {image: {packages: [clang]}}\n  none: {image: null}\n")
  expect(choiceFor(parsed, ["ubuntu-latest"])).toEqual({ spec: null, ref: "acme-ci" })
  expect(choiceFor(parsed, ["self-hosted", "big"]).spec?.packages).toEqual(["clang"])
  expect(choiceFor(parsed, ["none", "big"])).toEqual({ spec: null, ref: null })
})

test("a file over 64 KiB is no image", () => {
  const parsed = parseKyoraYml(`packages: [jq]\n#${"x".repeat(64 << 10)}\n`)
  expect(parsed.packages).toEqual([])
  expect(parsed.warnings).toEqual(["kyora.yml: larger than 64 KiB"])
})

test("64 KiB is parsed in linear time and never too deep for the stack", () => {
  const started = performance.now()
  expect(parseKyoraYml(`packages: [\n${"a1,\n".repeat(16000)}]\n`).packages).toEqual(["a1"])
  expect(parseKyoraYml(`packages: ${"[".repeat(30000)}${"]".repeat(30000)}\n`).warnings).toEqual(["kyora.yml: line 1: nested deeper than 32"])
  const deep = Array.from({ length: 300 }, (_, i) => `${" ".repeat(i)}k:`).join("\n")
  expect(parseKyoraYml(deep).warnings).toEqual(["kyora.yml: line 34: nested deeper than 32"])
  expect(performance.now() - started).toBeLessThan(2000)
})

test("warnings are capped in number and size, and made only while there is room", () => {
  const started = performance.now()
  const parsed = parseKyoraYml(`labels:\n  ${"l".repeat(32700)}:\n    packages: [${"X,".repeat(16300)}]\n`)
  expect(performance.now() - started).toBeLessThan(1000)
  expect(parsed.warnings.length).toBe(65)
  expect(parsed.warnings[0]).toBe(`labels.${"l".repeat(505)}...`)
  expect(parsed.warnings[64]).toBe("at most 64 warnings (the rest not shown)")
})

test("toImageJson: a kyora.image.json image build checks", async () => {
  const spec: CiImageSpec = { packages: ["protobuf-compiler", "jq"], setup: "curl -fsSL https://example.com/x.sh | sh\n" }
  const json = toImageJson(spec, "gha-runner", { name: "ci-web", salt: "r1" })
  expect(json).toEqual({
    name: "ci-web",
    base: "gha-runner",
    apt: ["jq", "protobuf-compiler"],
    run: ["curl -fsSL https://example.com/x.sh | sh\n"],
    salt: "r1",
  })
  const checked = await checkSpec(json, "/nonexistent/kyora.image.json")
  expect(checked.base).toBe("gha-runner")
  expect(checked.compiled.run).toEqual(json.run)
  expect(toImageJson({ packages: [], setup: null }, "gha-runner")).toEqual({ base: "gha-runner" })
})

test("parseKyoraYml names what it refuses: a Dockerfile anywhere or the whole file, never a bad value, past the warnings cap too", () => {
  const refusedBy = (yml: string) => {
    const refused: string[] = []
    return { parsed: parseKyoraYml(yml, refused), refused }
  }
  const top = refusedBy("image:\n  dockerfile: ci.Dockerfile\n")
  expect(top.refused).toEqual(["image.dockerfile"])
  expect(top.parsed.warnings).toEqual(["image.dockerfile is not supported yet; use image.setup"])
  const label = "x".repeat(600)
  expect(refusedBy(`labels:\n  big:\n    image: {dockerfile: ci.Dockerfile, packages: [jq]}\n  ${label}:\n    image: {dockerfile: a}\n`).refused).toEqual(["labels.big.image.dockerfile", `labels.${label}.image.dockerfile`])
  expect(refusedBy("packages: [jq\n").refused).toEqual(["kyora.yml"])
  const many = refusedBy(`packages: [${Array.from({ length: 80 }, () => "Bad_Name").join(", ")}]\nimage: {dockerfile: a}\n`)
  expect(many.parsed.warnings.at(-1)).toBe(`at most ${MAX_WARNINGS} warnings (the rest not shown)`)
  expect(many.refused).toEqual(["image.dockerfile"])
  const capped = refusedBy(`labels:\n${Array.from({ length: MAX_LABELS }, (_, i) => `  l${i}: {packages: [jq]}\n`).join("")}  late: {image: {dockerfile: a}}\n`)
  expect(capped.refused).toEqual(["labels.late"])
  const soft = refusedBy("packages: [jq, Bad_Name]\nflavour: x\nimage: {packages: [clang]}\n")
  expect(soft.parsed.warnings).toHaveLength(2)
  expect(soft.refused).toEqual([])
})
