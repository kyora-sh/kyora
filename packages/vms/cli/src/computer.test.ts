import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { computerAction, parseDisplay, parseRegion } from "./computer"
import { FAKE_PNG, startFakePlatform, startFakeVmd, type FakeVmd } from "./testing/fake-vmd"
import { baseEnv, cli, platformEnv, tempDir } from "./testing/fixtures"

setDefaultTimeout(30_000)

let root: string
let vmd: FakeVmd

beforeEach(async () => {
  root = await realpath(await tempDir("desk"))
  vmd = await startFakeVmd()
})

afterEach(async () => {
  await vmd.stop()
  await rm(root, { recursive: true, force: true })
})

const env = () => baseEnv(vmd.url)

async function sandbox(extra: string[] = []): Promise<string> {
  const created = await cli(["create", "--image", "desktop", ...extra], { cwd: root, env: env() })
  expect(created.code).toBe(0)
  return created.stdout.trim()
}

describe("kyora vms create --display", () => {
  test("sends the size with the spec, and refuses what isn't WxH", async () => {
    await sandbox(["--display", "1024x768"])
    expect(vmd.created.at(-1)).toMatchObject({ image: "desktop", display: { width: 1024, height: 768 } })
    const bad = await cli(["create", "--display", "big"], { cwd: root, env: env() })
    expect(bad.code).toBe(125)
    expect(bad.stderr).toContain("--display takes WIDTHxHEIGHT")
  })
})

describe("kyora vms screenshot", () => {
  test("saves the PNG, prints its path, says its size", async () => {
    const id = await sandbox()
    const result = await cli(["screenshot", id, "-o", "shot.png"], { cwd: root, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(join(root, "shot.png"))
    expect(new Uint8Array(await readFile(join(root, "shot.png")))).toEqual(FAKE_PNG)
    expect(result.stderr).toContain("1280x800 PNG")
    expect(vmd.computer.at(-1)).toEqual({ id, action: { action: "screenshot" }, accept: "image/png" })
  })

  test("without -o it names the file after the sandbox; --region is a zoom, --scale goes along", async () => {
    const id = await sandbox()
    const result = await cli(["screenshot", id, "--region", "10,20,400,300", "--scale", "0.5"], { cwd: root, env: env() })
    expect(result.code).toBe(0)
    const files = (await readdir(root)).filter((name) => name.endsWith(".png"))
    expect(files).toHaveLength(1)
    expect(files[0]).toStartWith(`${id}-`)
    expect(vmd.computer.at(-1)!.action).toEqual({ action: "zoom", region: [10, 20, 410, 320], scale: 0.5 })
  })

  test("-o - writes the PNG to stdout; --json says where it went", async () => {
    const id = await sandbox()
    const piped = await cli(["screenshot", id, "-o", "-"], { cwd: root, env: env() })
    expect(piped.code).toBe(0)
    expect(piped.stdout).toContain("PNG")
    expect(piped.stdout).toContain("IHDR")
    const json = await cli(["screenshot", id, "-o", "a.png", "--json"], { cwd: root, env: env() })
    expect(JSON.parse(json.stdout)).toEqual({ path: join(root, "a.png"), width: 1280, height: 800, bytes: FAKE_PNG.byteLength, screen: { width: 1280, height: 800 } })
  })

  test("refuses a bad region before asking", async () => {
    const id = await sandbox()
    for (const region of ["1,2,3", "a,b,c,d", "0,0,0,10"]) {
      const result = await cli(["screenshot", id, "--region", region], { cwd: root, env: env() })
      expect(result.code).toBe(125)
      expect(result.stderr).toContain("--region")
    }
    expect(vmd.computer).toEqual([])
  })
})

describe("kyora vms computer", () => {
  test("each action goes out as the tool says it", async () => {
    const id = await sandbox()
    const cases: Array<[string[], Record<string, unknown>]> = [
      [["left_click", "640", "400"], { action: "left_click", coordinate: [640, 400] }],
      [["right_click"], { action: "right_click" }],
      [["double_click", "1", "2", "--modifiers", "shift"], { action: "double_click", coordinate: [1, 2], text: "shift" }],
      [["left_click_drag", "1", "2", "30", "40"], { action: "left_click_drag", start_coordinate: [1, 2], coordinate: [30, 40] }],
      [["mouse_move", "5", "6"], { action: "mouse_move", coordinate: [5, 6] }],
      [["left_mouse_down"], { action: "left_mouse_down" }],
      [["scroll", "down", "5", "100", "200"], { action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [100, 200] }],
      [["type", "hello", "world"], { action: "type", text: "hello world" }],
      [["type", "--", "-n x"], { action: "type", text: "-n x" }],
      [["key", "ctrl+l"], { action: "key", text: "ctrl+l" }],
      [["key", "Return", "--repeat", "3"], { action: "key", text: "Return", repeat: 3 }],
      [["hold_key", "shift", "0.5"], { action: "hold_key", text: "shift", duration: 0.5 }],
      [["wait", "2"], { action: "wait", duration: 2 }],
    ]
    for (const [args, action] of cases) {
      const result = await cli(["computer", id, ...args], { cwd: root, env: env() })
      expect({ args, code: result.code, stderr: result.stderr }).toEqual({ args, code: 0, stderr: "" })
      expect(vmd.computer.at(-1)).toMatchObject({ id, action })
      expect(vmd.computer.at(-1)!.accept).not.toContain("image/png")
    }
  })

  test("cursor_position prints x y; info prints the desktop", async () => {
    const id = await sandbox()
    expect((await cli(["computer", id, "cursor_position"], { cwd: root, env: env() })).stdout).toBe("640 400\n")
    expect((await cli(["computer", id, "info"], { cwd: root, env: env() })).stdout).toBe("a desktop on :1, 1280x800\n")
  })

  test("--screenshot saves the screen after the action; --json gives the answer with the path", async () => {
    const id = await sandbox()
    const result = await cli(["computer", id, "left_click", "1", "1", "--screenshot", "-o", "after.png"], { cwd: root, env: env() })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(join(root, "after.png"))
    expect(new Uint8Array(await readFile(join(root, "after.png")))).toEqual(FAKE_PNG)
    expect(vmd.computer.at(-1)!.action).toEqual({ action: "left_click", coordinate: [1, 1], screenshot: true })
    const json = await cli(["computer", id, "key", "Escape", "--screenshot", "--scale", "0.5", "-o", "b.png", "--json"], { cwd: root, env: env() })
    expect(JSON.parse(json.stdout)).toEqual({
      action: "key",
      content: [{ type: "text", text: "OK" }, { type: "image", path: join(root, "b.png") }],
      image: { width: 1280, height: 800, bytes: FAKE_PNG.byteLength },
      screen: { width: 1280, height: 800 },
    })
  })

  test("usage mistakes fail before anything is sent", async () => {
    const id = await sandbox()
    const bad = [
      ["fly"],
      ["left_click", "1"],
      ["left_click", "-1", "2"],
      ["mouse_move"],
      ["scroll", "sideways", "1"],
      ["type"],
      ["wait", "soon"],
      ["key", "ctrl+s", "--modifiers", "shift"],
      ["left_click", "--repeat", "2"],
      ["left_click", "--scale", "0.5"],
    ]
    for (const args of bad) {
      const result = await cli(["computer", id, ...args], { cwd: root, env: env() })
      expect({ args, code: result.code }).toEqual({ args, code: 125 })
    }
    expect(vmd.computer).toEqual([])
    expect((await cli(["computer", id], { cwd: root, env: env() })).code).toBe(125)
  })

  test("the server's refusal is the message, exit 125", async () => {
    await vmd.stop()
    vmd = await startFakeVmd({ computerFailure: { status: 501, error: "unsupported", message: "this sandbox's image has no desktop; create it with a desktop image (--image desktop)" } })
    const id = await sandbox()
    const result = await cli(["computer", id, "left_click"], { cwd: root, env: env() })
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("no desktop")
  })

  test("kyora cloud takes the same calls", async () => {
    await vmd.stop()
    vmd = await startFakePlatform()
    const created = await cli(["create", "--image", "desktop", "--no-wait"], { cwd: root, env: platformEnv(vmd.url) })
    const id = created.stdout.trim()
    const result = await cli(["screenshot", id, "-o", "p.png"], { cwd: root, env: platformEnv(vmd.url) })
    expect(result.code).toBe(0)
    expect(new Uint8Array(await readFile(join(root, "p.png")))).toEqual(FAKE_PNG)
  })
})

describe("parsing", () => {
  test("display, region and actions", () => {
    expect(parseDisplay("1280x800")).toEqual({ width: 1280, height: 800 })
    expect(parseRegion("0,0,640,400")).toEqual([0, 0, 640, 400])
    expect(computerAction("zoom", ["10", "20", "30", "40"])).toEqual({ action: "zoom", region: [10, 20, 30, 40] })
    expect(computerAction("screenshot", [], { scale: 0.5 })).toEqual({ action: "screenshot", scale: 0.5 })
    expect(computerAction("screenshot", [], { screenshot: true })).toEqual({ action: "screenshot" })
  })
})
