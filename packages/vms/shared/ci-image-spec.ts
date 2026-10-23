/**
 * `.github/kyora.yml`'s CI image: what a repository's jobs boot, built on the CI base from the repo's
 * packages and a setup script. kyora reads it at check time and again in the job's VM, and every reader
 * parses the same YAML subset to the same spec and key: ci-image-spec.vectors.json holds the cases they
 * are tested against.
 *
 * The subset: block mappings and lists, flow lists and mappings (`[a, b]`, `{k: v}`), `|` block scalars
 * (with `-` or `+`), plain and quoted scalars, comments. Anchors, aliases, tags, folded scalars and lists
 * of mappings are refused. A file that doesn't parse is no image: the job boots the base and installs
 * in the VM, so nothing here ever fails a job.
 */

export interface CiImageSpec {
  /** Ubuntu packages, sorted, once each: the top level's and the image's (and a label's) */
  packages: string[]
  /** run as root with bash -euo pipefail */
  setup: string | null
}

/** an image to build from a spec, or an account image by name or id, or neither */
export interface CiImageChoice {
  spec: CiImageSpec | null
  ref: string | null
}

export interface KyoraYml extends CiImageChoice {
  /** the top level's `packages:`, what the job's VM installs when it has no image with them */
  packages: string[]
  /** per runs-on label, with the top level's packages folded in */
  labels: Record<string, CiImageChoice>
  /** what was ignored and why: logged, never a failure */
  warnings: string[]
}

export interface KyoraImageJson {
  name?: string
  base: string
  apt?: string[]
  run?: string[]
  salt?: string
}

export const CI_IMAGE_KEY_FORMAT = 1
export const KYORA_YML_PATHS = [".github/kyora.yml", ".github/kyora.yaml"] as const
export const KYORA_YML_MAX_BYTES = 64 << 10
/** per list, and runs-on labels: generous, and what keeps a 64 KiB file's spec small */
export const MAX_PACKAGES = 512
export const MAX_LABELS = 256
/** warnings per file, and code points per warning: what a 64 KiB file can make them come to */
export const MAX_WARNINGS = 64
export const WARNING_MAX = 512
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
export const PACKAGE = /^[a-z0-9][a-z0-9.+-]+$/
const IMAGE_REF = /^(?:[a-z][a-z0-9-]{0,63}(?:@[1-9][0-9]{0,8})?|img_[A-Za-z0-9_-]{8,64})$/
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_./-]*)[ ]*:(?:[ ]+|$)/
/** mappings and lists inside each other, at most */
const MAX_DEPTH = 32

/** a mapping keeps its keys in the file's order, numeric ones too (as an insertion-ordered dict does) */
type Value = string | null | Value[] | Mapping
type Mapping = Map<string, Value>

class YmlError extends Error {}

const isMapping = (value: Value | undefined): value is Mapping => value instanceof Map
const indentOf = (line: string) => line.length - line.replace(/^ +/, "").length
const isSeq = (text: string) => text === "-" || text.startsWith("- ")
const isContent = (line: string) => {
  const text = line.trim()
  return text !== "" && !text.startsWith("#")
}

/** `text` up to a comment: a # at the start or after a space, outside quotes */
function stripComment(text: string): string {
  let quote = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === '"' && c === "\\") i++
    else if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return text.slice(0, i)
  }
  return text
}

/** brackets opened and not closed, outside quotes */
function depth(text: string): number {
  let quote = ""
  let open = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === '"' && c === "\\") i++
    else if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === "[" || c === "{") open++
    else if (c === "]" || c === "}") open--
  }
  return open
}

const ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', "/": "/", n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", f: "\f" }

/** a quoted scalar at `text[at]`: its value and where it ends */
function quoted(text: string, at: number): [string, number] {
  const q = text[at]!
  let out = ""
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]!
    if (q === "'" && c === "'") {
      if (text[i + 1] === "'") {
        out += "'"
        i++
        continue
      }
      return [out, i + 1]
    }
    if (q === '"' && c === '"') {
      if (LONE_SURROGATE.test(out)) throw new YmlError("an unpaired surrogate in a quoted string")
      return [out, i + 1]
    }
    if (q === '"' && c === "\\") {
      const e = text[i + 1] ?? ""
      if (e === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
        i += 5
      } else if (e in ESCAPES) {
        out += ESCAPES[e]
        i++
      } else throw new YmlError(`unknown escape \\${e} in a quoted string`)
      continue
    }
    out += c
  }
  throw new YmlError("a quoted string is not closed")
}

/** a plain scalar's value: ~ and null are null, everything else a string */
function plain(text: string): string | null {
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null
  if ("&*!".includes(text[0]!)) throw new YmlError("anchors, aliases and tags are not supported")
  if ("%@`".includes(text[0]!)) throw new YmlError(`a plain value can't start with ${text[0]}`)
  return text
}

function scalar(text: string): string | null {
  if (text[0] === '"' || text[0] === "'") {
    const [value, end] = quoted(text, 0)
    if (text.slice(end).trim() !== "") throw new YmlError("text after a quoted string")
    return value
  }
  return plain(text)
}

/** `[a, b]` and `{k: v}`, nested, on what may have been several lines */
function flow(text: string): Value {
  let at = 0
  let level = 0
  const space = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t")) at++
  }
  const word = (stops: string) => {
    const from = at
    while (at < text.length && !stops.includes(text[at]!)) at++
    return text.slice(from, at).trim()
  }
  const value = (stops: string): Value => {
    space()
    const c = text[at]
    if ((c === "[" || c === "{") && ++level > MAX_DEPTH) throw new YmlError(`nested deeper than ${MAX_DEPTH}`)
    if (c === "[") {
      at++
      const items: Value[] = []
      for (;;) {
        space()
        if (text[at] === "]") break
        if (text[at] === ",") throw new YmlError("an empty item in a [ ] list")
        items.push(value(",]"))
        space()
        if (text[at] === ",") at++
        else if (text[at] !== "]") throw new YmlError("expected , or ] in a [ ] list")
      }
      at++
      level--
      return items
    }
    if (c === "{") {
      at++
      const map: Mapping = new Map()
      for (;;) {
        space()
        if (text[at] === "}") break
        let key: string
        if (text[at] === '"' || text[at] === "'") [key, at] = quoted(text, at)
        else key = word(":,}")
        space()
        if (!key || text[at] !== ":") throw new YmlError("expected key: value in a { } mapping")
        if (key === "__proto__") throw new YmlError("__proto__ is not a key")
        if (map.has(key)) throw new YmlError(`duplicate key ${JSON.stringify(key)}`)
        at++
        space()
        map.set(key, text[at] === "," || text[at] === "}" ? null : value(",}"))
        space()
        if (text[at] === ",") at++
        else if (text[at] !== "}") throw new YmlError("expected , or } in a { } mapping")
      }
      at++
      level--
      return map
    }
    if (c === '"' || c === "'") {
      const [out, end] = quoted(text, at)
      at = end
      return out
    }
    const raw = word(stops)
    if (/[[\]{}]/.test(raw)) throw new YmlError("brackets inside a plain value in a [ ] or { }")
    return plain(raw)
  }
  const out = value("")
  space()
  if (at !== text.length) throw new YmlError("text after a closing bracket")
  return out
}

class Parser {
  level = 0

  constructor(readonly lines: string[]) {}

  /** the next content line at or after `i` */
  next(i: number): number {
    while (i < this.lines.length && !isContent(this.lines[i]!)) i++
    if (i < this.lines.length && this.lines[i]![indentOf(this.lines[i]!)] === "\t") this.fail(i, "tabs can't indent")
    return i
  }

  fail(i: number, message: string): never {
    throw new YmlError(`line ${i + 1}: ${message}`)
  }

  text(i: number): string {
    return this.lines[i]!.slice(indentOf(this.lines[i]!))
  }

  node(i: number, indent: number): [Value, number] {
    if (++this.level > MAX_DEPTH) this.fail(i, `nested deeper than ${MAX_DEPTH}`)
    const out = isSeq(this.text(i)) ? this.seq(i, indent) : this.map(i, indent)
    this.level--
    return out
  }

  map(i: number, indent: number): [Value, number] {
    const map: Mapping = new Map()
    for (;;) {
      i = this.next(i)
      if (i >= this.lines.length || indentOf(this.lines[i]!) < indent) return [map, i]
      if (indentOf(this.lines[i]!) > indent) this.fail(i, "unexpected indentation")
      const text = this.text(i)
      let key: string
      let rest: string
      if (text[0] === '"' || text[0] === "'") {
        let end: number
        try {
          ;[key, end] = quoted(text, 0)
        } catch (error) {
          this.fail(i, (error as Error).message)
        }
        const after = /^[ ]*:(?:[ ]+|$)/.exec(text.slice(end))
        if (!after) this.fail(i, "expected key: value")
        rest = text.slice(end + after[0].length)
      } else {
        const match = KEY.exec(text)
        if (!match) this.fail(i, isSeq(text) ? "a list where a key: value was expected" : "expected key: value")
        key = match[1]!
        rest = text.slice(match[0].length)
      }
      if (key === "__proto__") this.fail(i, "__proto__ is not a key")
      if (map.has(key)) this.fail(i, `duplicate key ${JSON.stringify(key)}`)
      let value: Value
      ;[value, i] = this.value(rest, i, indent, true)
      map.set(key, value)
    }
  }

  seq(i: number, indent: number): [Value, number] {
    const items: Value[] = []
    for (;;) {
      i = this.next(i)
      if (i >= this.lines.length || indentOf(this.lines[i]!) < indent) return [items, i]
      if (indentOf(this.lines[i]!) > indent) this.fail(i, "unexpected indentation")
      const text = this.text(i)
      if (!isSeq(text)) return [items, i]
      const rest = text.slice(1).replace(/^ +/, "")
      if (isSeq(rest)) this.fail(i, "nested lists are not supported")
      if (KEY.test(rest) || /^["'][^"']*["'][ ]*:(?:[ ]+|$)/.test(rest)) this.fail(i, "lists of mappings are not supported")
      let value: Value
      ;[value, i] = this.value(rest, i, indent, false)
      items.push(value)
    }
  }

  /** what follows `key:` or `- ` on line `i`, and the lines it takes */
  value(rest: string, i: number, indent: number, inMap: boolean): [Value, number] {
    const text = stripComment(rest).trim()
    if (text === "") {
      const j = this.next(i + 1)
      if (j < this.lines.length) {
        const at = indentOf(this.lines[j]!)
        if (at > indent) return this.node(j, at)
        if (inMap && at === indent && isSeq(this.text(j))) return this.node(j, at)
      }
      return [null, i + 1]
    }
    if (text[0] === "|" || text[0] === ">") {
      if (text[0] === ">") this.fail(i, "folded scalars (>) are not supported: use |")
      if (!/^\|[+-]?$/.test(text)) this.fail(i, `a block scalar header is |, |- or |+, not ${text}`)
      return this.block(i + 1, indent, text[1] ?? "")
    }
    if (text[0] === "[" || text[0] === "{") {
      // brackets counted a line at a time: once over the text, however many lines
      const parts = [text]
      let open = depth(text)
      let j = i
      while (open > 0) {
        j++
        if (j >= this.lines.length) this.fail(i, `${text[0]} is not closed`)
        const more = stripComment(this.lines[j]!).trim()
        open += depth(more)
        parts.push(more)
      }
      const all = parts.join(" ")
      try {
        return [flow(all), j + 1]
      } catch (error) {
        this.fail(i, (error as Error).message)
      }
    }
    try {
      return [scalar(text), i + 1]
    } catch (error) {
      this.fail(i, (error as Error).message)
    }
  }

  block(i: number, parent: number, chomp: string): [string, number] {
    const taken: string[] = []
    let at = -1
    let j = i
    for (; j < this.lines.length; j++) {
      const line = this.lines[j]!
      if (line.trim() === "") {
        taken.push(line)
        continue
      }
      const indent = indentOf(line)
      if (indent <= parent) break
      if (at === -1) at = indent
      else if (indent < at) this.fail(j, "less indented than the block's first line")
      taken.push(line)
    }
    if (at === -1) return ["", j]
    const lines = taken.map((line) => (line.length > at ? line.slice(at) : ""))
    if (chomp === "+") return [`${lines.join("\n")}\n`, j]
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return [chomp === "-" ? lines.join("\n") : `${lines.join("\n")}\n`, j]
  }
}

/** the YAML subset's value of `text`: a mapping at the top. Throws YmlError */
function parseYml(text: string): Mapping {
  if (text.startsWith("\uFEFF")) text = text.slice(1)
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const parser = new Parser(lines)
  let i = parser.next(0)
  if (i < lines.length && /^---[ ]*(#[\s\S]*)?$/.test(lines[i]!)) i = parser.next(i + 1)
  if (i >= lines.length) return new Map()
  if (indentOf(lines[i]!) !== 0) parser.fail(i, "unexpected indentation")
  if (isSeq(parser.text(i))) parser.fail(i, "the file must be a mapping (packages:, image:, labels:)")
  return parser.map(i, 0)[0] as Mapping
}

const sortedUnique = (items: string[]) => [...new Set(items)].sort()

/** a warning, made only while there is room for it and cut at WARNING_MAX code points */
function warn(warnings: string[], make: () => string): void {
  if (warnings.length > MAX_WARNINGS) return
  if (warnings.length === MAX_WARNINGS) {
    warnings.push(`at most ${MAX_WARNINGS} warnings (the rest not shown)`)
    return
  }
  const text = make()
  if (text.length <= WARNING_MAX) {
    warnings.push(text)
    return
  }
  let cut = ""
  let points = 0
  for (const point of text) {
    if (points++ === WARNING_MAX) {
      warnings.push(`${cut}...`)
      return
    }
    cut += point
  }
  warnings.push(text)
}

/** `packages:` as a list of package names; anything else is a warning */
function packagesOf(value: Value | undefined, where: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warn(warnings, () => `${where}: must be a list of package names`)
    return []
  }
  const out: string[] = []
  let capped = false
  value.forEach((item, i) => {
    if (typeof item !== "string") warn(warnings, () => `${where}[${i}]: must be a package name`)
    else if (!PACKAGE.test(item)) warn(warnings, () => `${where}: not a package name: ${JSON.stringify(item)}`)
    else if (out.length < MAX_PACKAGES) out.push(item)
    else capped = true
  })
  if (capped) warn(warnings, () => `${where}: at most ${MAX_PACKAGES} packages (the rest ignored)`)
  return out
}

interface ImageField {
  ref: string | null
  packages: string[]
  setup: string | null
  object: boolean
}

function imageOf(value: Value | undefined, where: string, warnings: string[], refused: string[]): ImageField | null {
  if (value === undefined || value === null) return null
  if (typeof value === "string") {
    if (IMAGE_REF.test(value)) return { ref: value, packages: [], setup: null, object: false }
    warn(warnings, () => `${where}: not an image name or id: ${JSON.stringify(value)}`)
    return null
  }
  if (!isMapping(value)) {
    warn(warnings, () => `${where}: must be an image name, or a mapping of packages and setup`)
    return null
  }
  if (value.has("dockerfile")) {
    warn(warnings, () => `${where}.dockerfile is not supported yet; use ${where}.setup`)
    refused.push(`${where}.dockerfile`)
    return null
  }
  for (const key of value.keys()) if (!["packages", "setup"].includes(key)) warn(warnings, () => `${where}: unknown key ${JSON.stringify(key)} (ignored)`)
  let setup: string | null = null
  const rawSetup = value.get("setup")
  if (rawSetup !== undefined && rawSetup !== null) {
    if (typeof rawSetup !== "string" || rawSetup.trim() === "") warn(warnings, () => `${where}.setup: must be a script`)
    else setup = rawSetup
  }
  return { ref: null, packages: packagesOf(value.get("packages"), `${where}.packages`, warnings), setup, object: true }
}

/** an image by name wins; else a spec from the image's mapping, or from the packages alone */
function choose(image: ImageField | null, packages: string[]): CiImageChoice {
  if (image && !image.object) return { spec: null, ref: image.ref }
  if (!image) return packages.length > 0 ? { spec: { packages: sortedUnique(packages), setup: null }, ref: null } : { spec: null, ref: null }
  return {
    spec: { packages: sortedUnique([...packages, ...image.packages]), setup: image.setup },
    ref: null,
  }
}

/**
 * `.github/kyora.yml`: the image to boot (a spec to build, or an account image's name or id), per
 * runs-on label too, and the packages the job's VM installs. A file that doesn't parse is no image, with
 * the reason as a warning. `refused` gets what CI ignores whole: `kyora.yml`, an image's `dockerfile`, or the first label past the cap.
 */
export function parseKyoraYml(text: string, refused: string[] = []): KyoraYml {
  const warnings: string[] = []
  const none: KyoraYml = { spec: null, ref: null, packages: [], labels: {}, warnings }
  let root: Mapping
  try {
    if (new TextEncoder().encode(text).length > KYORA_YML_MAX_BYTES) throw new YmlError(`larger than ${KYORA_YML_MAX_BYTES >> 10} KiB`)
    root = parseYml(text)
  } catch (error) {
    warn(warnings, () => `kyora.yml: ${error instanceof YmlError ? error.message : `can't be read (${String(error)})`}`)
    refused.push("kyora.yml")
    return none
  }
  for (const key of root.keys()) if (!["packages", "image", "labels"].includes(key)) warn(warnings, () => `unknown key ${JSON.stringify(key)} (ignored)`)
  const packages = packagesOf(root.get("packages"), "packages", warnings)
  const image = imageOf(root.get("image"), "image", warnings, refused)
  const labels: Record<string, CiImageChoice> = {}
  const rawLabels = root.get("labels")
  if (rawLabels !== undefined && rawLabels !== null) {
    if (!isMapping(rawLabels)) warn(warnings, () => "labels: must be a mapping of runs-on labels")
    else for (const [n, [label, entry]] of [...rawLabels].entries()) {
      if (n === MAX_LABELS) {
        warn(warnings, () => `labels: at most ${MAX_LABELS} labels (the rest ignored)`)
        refused.push(`labels.${label}`)
        break
      }
      const where = `labels.${label}`
      if (entry === null) continue
      if (!isMapping(entry)) {
        warn(warnings, () => `${where}: must be a mapping of image and packages`)
        continue
      }
      for (const key of entry.keys()) if (key !== "image" && key !== "packages") warn(warnings, () => `${where}: unknown key ${JSON.stringify(key)} (ignored)`)
      const own = packagesOf(entry.get("packages"), `${where}.packages`, warnings)
      const labelImage = entry.has("image") ? imageOf(entry.get("image"), `${where}.image`, warnings, refused) : image
      labels[label] = choose(labelImage, [...packages, ...own])
    }
  }
  return { ...choose(image, packages), packages: sortedUnique(packages), labels, warnings }
}

/** what a job with these runs-on labels boots: the first label that has its own entry, else the top level */
export function choiceFor(parsed: KyoraYml, runsOn: string[]): CiImageChoice {
  for (const label of runsOn) if (Object.hasOwn(parsed.labels, label)) return parsed.labels[label]!
  return { spec: parsed.spec, ref: parsed.ref }
}

const encoder = new TextEncoder()

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** JSON with sorted keys and no spaces: one text for one value */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The image's key: what decides its bytes (the base image's build, the packages, the setup script), so a
 * change to any of them is a new image and the same inputs are the same one.
 */
export async function ciImageKey(spec: CiImageSpec, baseBuildId: string): Promise<string> {
  const doc = {
    format: CI_IMAGE_KEY_FORMAT,
    base: baseBuildId,
    packages: sortedUnique(spec.packages),
    setup: spec.setup,
  }
  return `cik_${await sha256Hex(canonicalJson(doc))}`
}

/**
 * The spec as a kyora.image.json (packages/vms/cli/src/image-spec.ts) on `base`: its packages as apt, then
 * setup.
 */
export function toImageJson(spec: CiImageSpec, base: string, options: { name?: string; salt?: string } = {}): KyoraImageJson {
  const out: KyoraImageJson = { ...(options.name ? { name: options.name } : {}), base }
  if (spec.packages.length > 0) out.apt = sortedUnique(spec.packages)
  if (spec.setup) out.run = [spec.setup]
  if (options.salt) out.salt = options.salt
  return out
}
