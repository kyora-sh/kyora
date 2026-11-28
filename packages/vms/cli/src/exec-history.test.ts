import { expect, test } from "bun:test"
import { ApiError, type VmsClient } from "./api"

/** vms exec, vms new -- cmd (both session.exec) and image builds name the exec by kyora cloud's history id when it gave one */

const HISTORY = "r_AbCdEfGh-_123456"
const answering = (headers: Record<string, string>, started: Record<string, unknown>) =>
  ({
    exec: async () => new Response([{ type: "started", id: "a".repeat(32), resumable: true, ...started }, { type: "error", message: "boom" }].map((event) => `${JSON.stringify(event)}\n`).join(""), { headers }),
    attach: async () => {
      throw new ApiError("gone", 404, "exec_not_found")
    },
    execExited: () => {},
  }) as unknown as VmsClient

async function stderrOf(work: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const stderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split("\n").filter(Boolean).map((line) => line.replace(/^\[[^\]]+\] /, "")))
    return true
  }) as typeof process.stderr.write
  try {
    await work()
  } finally {
    process.stderr.write = stderr
  }
  return lines
}

test("vms exec and vms new -- cmd: the history id from the header only, else the command's id", async () => {
  const { exec } = await import("./session")
  expect(await stderrOf(() => exec(answering({ "x-kyora-exec-history": HISTORY }, {}), "sb_test", { cmd: ["true"] }, false))).toContain(`exec ${HISTORY}: remote error: boom`)
  expect(await stderrOf(() => exec(answering({}, { historyId: HISTORY }), "sb_test", { cmd: ["true"] }, false))).toContain(`exec ${"a".repeat(32)}: remote error: boom`)
  expect(await stderrOf(() => exec(answering({}, {}), "sb_test", { cmd: ["true"] }, false))).toContain(`exec ${"a".repeat(32)}: remote error: boom`)
})

test("an image build's exec failure names the history id the same way", async () => {
  const { apiBackend } = await import("./image-build")
  const named = await apiBackend(answering({ "x-kyora-exec-history": HISTORY }, {})).stream("sb_test", { cmd: ["true"] }, () => {})
  expect(named.error).toBe(`exec ${HISTORY}: remote error: boom`)
  const forged = await apiBackend(answering({}, { historyId: HISTORY })).stream("sb_test", { cmd: ["true"] }, () => {})
  expect(forged.error).toBe(`exec ${"a".repeat(32)}: remote error: boom`)
})
