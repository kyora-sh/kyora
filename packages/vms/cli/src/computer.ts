import { resolve } from "node:path"
import type { ComputerAction, ComputerResult, Screenshot, VmsClient } from "./api"
import { note, printJson, write } from "./output"
import { formatBytes } from "./units"

/**
 * `kyora-vms screenshot` and `kyora-vms computer`: the sandbox's desktop through kyora cloud's
 * computer-use API. Actions and their arguments are the Anthropic computer-use tool's.
 */

export class ComputerUsage extends Error {}

const usage = (message: string): never => {
  throw new ComputerUsage(message)
}

const ACTIONS = `screenshot | zoom x0 y0 x1 y1 | left_click|right_click|middle_click|double_click|triple_click [x y]
  | left_click_drag x0 y0 x1 y1 | mouse_move x y | left_mouse_down|left_mouse_up [x y] | cursor_position
  | scroll up|down|left|right amount [x y] | type text… | key combo… | hold_key combo seconds | wait seconds | info`

/** `--display 1280x800` */
export function parseDisplay(value: string): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value.trim())
  if (!match) return usage(`--display takes WIDTHxHEIGHT, e.g. 1280x800, not ${JSON.stringify(value)}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** `--region x,y,w,h` → a zoom's region [x0, y0, x1, y1] */
export function parseRegion(value: string): [number, number, number, number] {
  const parts = value.split(",").map((part) => part.trim())
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return usage(`--region takes x,y,width,height, e.g. 0,0,640,400, not ${JSON.stringify(value)}`)
  const [x, y, w, h] = parts.map(Number) as [number, number, number, number]
  if (w === 0 || h === 0) return usage("--region needs a width and a height above 0")
  return [x, y, x + w, y + h]
}

export function parseScale(value: string): number {
  const scale = Number(value)
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 1) return usage(`--scale takes a factor from 0.1 to 1, not ${JSON.stringify(value)}`)
  return scale
}

function pixel(value: string | undefined, what: string): number {
  if (value === undefined || !/^\d+$/.test(value)) return usage(`${what} must be a whole number of pixels, not ${JSON.stringify(value ?? "")}`)
  return Number(value)
}

function seconds(value: string | undefined, what: string): number {
  const number = Number(value)
  if (value === undefined || value.trim() === "" || !Number.isFinite(number) || number < 0) return usage(`${what} takes seconds, e.g. 1.5, not ${JSON.stringify(value ?? "")}`)
  return number
}

function point(args: string[], at: number, name: string): [number, number] {
  return [pixel(args[at], `${name} x`), pixel(args[at + 1], `${name} y`)]
}

function count(args: string[], allowed: number[], action: string): void {
  if (!allowed.includes(args.length)) usage(`${action} takes ${allowed.map((n) => String(n)).join(" or ")} argument${allowed.at(-1) === 1 ? "" : "s"}, got ${args.length}`)
}

export interface ActionOptions {
  /** --modifiers: keys to hold for a click, drag or scroll (the tool's `text` there) */
  modifiers?: string
  repeat?: number
  /** --screenshot: one after the action */
  screenshot?: boolean
  scale?: number
}

/** `computer <id> <action> [args…]` as the action the API takes */
export function computerAction(name: string, args: string[], options: ActionOptions = {}): ComputerAction {
  const action: ComputerAction = { action: name }
  const clicks = ["left_click", "right_click", "middle_click", "double_click", "triple_click"]
  switch (name) {
    case "screenshot":
    case "cursor_position":
    case "info":
      count(args, [0], name)
      break
    case "zoom":
      count(args, [4], name)
      action.region = [...point(args, 0, "x0 y0"), ...point(args, 2, "x1 y1")]
      break
    case "left_click_drag":
      count(args, [4], name)
      action.start_coordinate = point(args, 0, "start")
      action.coordinate = point(args, 2, "end")
      break
    case "mouse_move":
      count(args, [2], name)
      action.coordinate = point(args, 0, "coordinate")
      break
    case "left_mouse_down":
    case "left_mouse_up":
      count(args, [0, 2], name)
      if (args.length === 2) action.coordinate = point(args, 0, "coordinate")
      break
    case "scroll":
      count(args, [2, 4], name)
      if (!["up", "down", "left", "right"].includes(args[0]!)) usage(`scroll goes up, down, left or right, not ${JSON.stringify(args[0])}`)
      action.scroll_direction = args[0]
      action.scroll_amount = pixel(args[1], "scroll amount")
      if (args.length === 4) action.coordinate = point(args, 2, "coordinate")
      break
    case "type":
      if (args.length === 0) usage("type needs the text to type, e.g. kyora-vms computer <id> type \"hello world\"")
      action.text = args.join(" ")
      break
    case "key":
      if (args.length === 0) usage("key needs a key or combination, e.g. ctrl+l or Return")
      action.text = args.join(" ")
      if (options.repeat !== undefined) action.repeat = options.repeat
      break
    case "hold_key":
      count(args, [2], name)
      action.text = args[0]
      action.duration = seconds(args[1], "hold_key")
      break
    case "wait":
      count(args, [1], name)
      action.duration = seconds(args[0], "wait")
      break
    default:
      if (!clicks.includes(name)) return usage(`unknown action ${JSON.stringify(name)}; one of\n  ${ACTIONS}`)
      count(args, [0, 2], name)
      if (args.length === 2) action.coordinate = point(args, 0, "coordinate")
  }
  if (options.modifiers !== undefined) {
    if (!clicks.includes(name) && name !== "left_click_drag" && name !== "scroll") usage("--modifiers goes with a click, a drag or a scroll")
    action.text = options.modifiers
  }
  if (options.repeat !== undefined && name !== "key") usage("--repeat goes with key")
  const capture = name === "screenshot" || name === "zoom"
  if (options.screenshot && !capture && name !== "info") action.screenshot = true
  if (options.scale !== undefined) {
    if (!capture && !action.screenshot) usage("--scale goes with a screenshot (screenshot, zoom or --screenshot)")
    action.scale = options.scale
  }
  return action
}

/** where a screenshot goes without -o: the current directory, named after the sandbox and the time */
function defaultPath(id: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  return resolve(`${id}-${stamp}.png`)
}

/** writes the PNG to `out` (`-` is stdout); returns where it went */
async function save(png: Uint8Array, out: string | undefined, id: string): Promise<string> {
  if (out === "-") {
    await write(process.stdout, png)
    return "-"
  }
  const path = out ? resolve(out) : defaultPath(id)
  await Bun.write(path, png)
  return path
}

function described(shot: { width: number; height: number; screen?: { width: number; height: number } }, bytes: number, path: string): string {
  const scaled = shot.screen && (shot.screen.width !== shot.width || shot.screen.height !== shot.height) ? ` (of a ${shot.screen.width}x${shot.screen.height} screen)` : ""
  return `${shot.width}x${shot.height} PNG${scaled}, ${formatBytes(bytes)}${path === "-" ? "" : ` → ${path}`}`
}

/** `kyora-vms screenshot <id> [-o file.png] [--region x,y,w,h] [--scale s]`: prints where it went */
export async function screenshot(api: VmsClient, id: string, options: { out?: string; region?: string; scale?: string; json: boolean }): Promise<number> {
  const action: ComputerAction = options.region ? { action: "zoom", region: parseRegion(options.region) } : { action: "screenshot" }
  if (options.scale !== undefined) action.scale = parseScale(options.scale)
  const shot: Screenshot = await api.screenshot(id, action)
  const path = await save(shot.png, options.out, id)
  if (options.json) {
    if (path !== "-") printJson({ path, width: shot.width, height: shot.height, bytes: shot.png.byteLength, screen: shot.screen })
  } else {
    if (path !== "-") console.log(path)
    note(described(shot, shot.png.byteLength, path))
  }
  return 0
}

/** `kyora-vms computer <id> <action> [args…]`: one action; prints what it says (the cursor, an image's path) */
export async function computer(api: VmsClient, id: string, action: ComputerAction, options: { out?: string; json: boolean }): Promise<number> {
  const result: ComputerResult = await api.computer(id, action)
  const image = result.content.find((block) => block.type === "image")
  let path: string | null = null
  if (image && image.type === "image") {
    const png = Uint8Array.from(Buffer.from(image.source.data, "base64"))
    path = await save(png, options.out, id)
    if (!options.json) note(described({ width: result.image?.width ?? 0, height: result.image?.height ?? 0, ...(result.screen ? { screen: result.screen } : {}) }, png.byteLength, path))
  } else if (options.out) note("-o: this action made no screenshot (add --screenshot)")
  if (options.json) {
    // the answer as the API gave it, a saved image's data swapped for where it went
    const content = result.content.map((block) => (block.type === "image" && path ? { type: "image", path } : block))
    printJson({ ...result, content })
    return 0
  }
  if (result.cursor) console.log(`${result.cursor.x} ${result.cursor.y}`)
  else if (result.desktop) console.log(result.content.find((block) => block.type === "text")?.text ?? JSON.stringify(result.desktop))
  if (path && path !== "-") console.log(path)
  return 0
}
