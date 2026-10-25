import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { generate, OUT, ROOT } from "../scripts/generate.js"
import { problems } from "../scripts/sync-spec.js"
import { COVERAGE } from "./coverage.js"
import { OPERATIONS } from "./generated/operations.js"
import { client } from "./testing/fake.js"

const source = await Bun.file(join(ROOT, "openapi.yaml")).text()
const spec = Bun.YAML.parse(source) as { paths: Record<string, Record<string, { operationId?: string }>> }
const specOperations = Object.values(spec.paths).flatMap((item) => Object.values(item).flatMap((operation) => (operation?.operationId ? [operation.operationId] : [])))

describe("spec coverage", () => {
  test("every operation of the spec has an SDK method or a reason it has none yet", () => {
    const covered = new Set(Object.keys(COVERAGE))
    expect(specOperations.filter((id) => !covered.has(id))).toEqual([])
    expect(specOperations.length).toBeGreaterThan(0)
  })

  test("no entry outlives its operation", () => {
    const present = new Set(specOperations)
    expect(Object.keys(COVERAGE).filter((id) => !present.has(id))).toEqual([])
  })

  test("every named method exists", () => {
    const { kyora } = client(() => new Response(null, { status: 204 }))
    const missing = Object.entries(COVERAGE).flatMap(([id, entry]) => {
      if (!("method" in entry)) return entry.notYet.trim() ? [] : [`${id}: a not-yet entry needs a reason`]
      let target: unknown = kyora
      let owner: unknown = undefined
      for (const part of entry.method.split(".")) {
        owner = target
        target = (target as Record<string, unknown> | undefined)?.[part]
      }
      return typeof target === "function" && owner !== undefined ? [] : [`${id}: ${entry.method}`]
    })
    expect(missing).toEqual([])
  })

  test("the generated table holds exactly the spec's operations", () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual([...specOperations].sort())
  })
})

describe("the vendored spec", () => {
  test("src/generated is up to date (bun run generate)", async () => {
    for (const [name, text] of Object.entries(generate(source))) expect(await Bun.file(join(OUT, name)).text()).toBe(text)
  })

  test("holds only public paths", () => {
    expect(problems(source)).toEqual([])
  })

  test("sync-spec refuses a path outside the public prefixes", () => {
    const other = source.replace("  /v1/health:", "  /v1/unlisted:")
    expect(problems(other)).toEqual(["/v1/unlisted: not under a public prefix"])
    const internal = source.replace('description: "The sandbox\'s id', 'description: "Internal; the sandbox\'s id')
    expect(problems(internal).some((problem) => problem.endsWith("described as internal"))).toBe(true)
  })
})
