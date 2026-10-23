/** Review regressions: explicit names use authoritative lookups, while ID prefixes still use lists. */
import { expect, test } from "bun:test"
import { ApiError, type Sandbox } from "./api"
import { selectSandbox } from "./ergonomics"
import { resolveTarget } from "./names"

for (const input of ["old-name", "-old-name"]) {
  test(`a missing authoritative name ${input} cannot resolve through a stale list`, async () => {
    const sandbox = { id: "sb_abcdef_AbCdEfGhIjKlMnOp", name: input } as Sandbox
    const missing = new ApiError(`no sandbox named ${input}`, 404, "not_found")
    let reads = 0
    const api = {
      get: async () => { throw missing },
      list: async () => { reads++; return [sandbox] },
    }
    await expect(resolveTarget(api, input)).rejects.toBe(missing)
    await expect(selectSandbox(api, input, false)).rejects.toBe(missing)
    expect(reads).toBe(0)
  })
}

test("full IDs and unique ID prefixes retain their direct and list paths", async () => {
  const sandbox = { id: "sb_abcdef_AbCdEfGhIjKlMnOp", name: "new-name" } as Sandbox
  const reads: string[] = []
  const api = {
    get: async (input: string) => { reads.push(input); return sandbox },
    list: async () => { reads.push("list"); return [sandbox] },
  }
  expect(await resolveTarget(api, sandbox.id)).toBe(sandbox.id)
  expect(reads).toEqual([])
  expect(await selectSandbox(api, sandbox.id, false)).toBe(sandbox)
  expect(reads).toEqual([sandbox.id])
  reads.length = 0
  expect(await resolveTarget(api, "sb_abcdef_")).toBe(sandbox.id)
  expect(await selectSandbox(api, "sb_abcdef_", false)).toBe(sandbox)
  expect(reads).toEqual(["list", "list"])
  expect(await selectSandbox(api, undefined, false)).toBe(sandbox)
})

test("a sealed id (region only, no machine) is a full id too; its prefix still lists", async () => {
  const sandbox = { id: `sb_eu_${"k".repeat(26)}`, name: "sealed" } as Sandbox
  const reads: string[] = []
  const api = {
    get: async (input: string) => { reads.push(input); return sandbox },
    list: async () => { reads.push("list"); return [sandbox] },
  }
  expect(await resolveTarget(api, sandbox.id)).toBe(sandbox.id)
  expect(reads).toEqual([])
  expect(await resolveTarget(api, "sb_eu_kkk")).toBe(sandbox.id)
  expect(reads).toEqual(["list"])
})
