/**
 * Replaces the vendored openapi.yaml with the kyora API's published OpenAPI document and
 * regenerates src/generated/:
 *
 *   bun run sync-spec <path to openapi.yaml>
 *
 * The document is checked first: OpenAPI 3.1, every path under a prefix in PUBLIC_PREFIXES, and
 * nothing it describes as internal. A path outside the prefixes is refused until it is added there
 * on purpose, in the same change.
 */
import { join } from "node:path"
import { generate, OUT, ROOT } from "./generate.js"

export const PUBLIC_PREFIXES = [
  "/v1/health",
  "/v1/regions",
  "/v1/me",
  "/v1/tokens",
  "/v1/orgs/{org}/tokens",
  "/v1/usage",
  "/v1/sandboxes",
  "/v1/queue",
  "/v1/ports",
  "/v1/domains",
  "/v1/pages",
  "/v1/shares",
  "/v1/snapshots",
  "/v1/images",
  "/v1/storage",
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/** the problems that keep a document from being vendored */
export function problems(source: string): string[] {
  const spec = Bun.YAML.parse(source) as { openapi?: unknown; paths?: Record<string, unknown> }
  const found: string[] = []
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.1")) found.push(`openapi ${String(spec.openapi)}: expected 3.1`)
  for (const path of Object.keys(spec.paths ?? {})) {
    if (!PUBLIC_PREFIXES.some((prefix) => under(path, prefix))) found.push(`${path}: not under a public prefix`)
  }
  if (/[\u2013\u2014]/.test(source)) found.push("the document has en or em dashes")
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null) return
    const description = (node as { description?: unknown }).description
    if (typeof description === "string" && /^internal\s*[;:]/i.test(description.trim())) found.push(`${path}: described as internal`)
    for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`)
  }
  walk(spec, "#")
  return found
}

if (import.meta.main) {
  const from = process.argv[2]
  if (!from) {
    console.error("usage: bun run sync-spec <path to openapi.yaml>")
    process.exit(2)
  }
  const source = await Bun.file(from).text()
  const found = problems(source)
  if (found.length > 0) {
    console.error(`refusing ${from}:\n${found.map((problem) => `  ${problem}`).join("\n")}`)
    process.exit(1)
  }
  await Bun.write(join(ROOT, "openapi.yaml"), source)
  for (const [name, text] of Object.entries(generate(source))) await Bun.write(join(OUT, name), text)
  console.log("openapi.yaml and src/generated/ updated")
}
