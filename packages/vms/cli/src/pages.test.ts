import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { VmsClient } from "./api"
import { contentType, MAX_FILES, pageFiles, pagesMain, PagesUsage, publishedPrefix, publishId, publishPage, removePage, type PagesDeps } from "./pages"
import { StorageClient } from "./storage"
import { startFakeCloud, type FakeCloud } from "./testing/fake-cloud"
import { TOKEN } from "./testing/fake-vmd"
import { tempDir, write } from "./testing/fixtures"

let cloud: FakeCloud
let root: string
let deps: PagesDeps
let notes: string[]

beforeEach(async () => {
  cloud = startFakeCloud()
  root = await tempDir("pages")
  notes = []
  deps = { api: new VmsClient({ url: cloud.url, key: TOKEN }), storage: new StorageClient(cloud.url, TOKEN), progress: (message) => notes.push(message) }
})
afterEach(async () => {
  cloud.stop()
  await rm(root, { recursive: true, force: true })
})
afterAll(() => cloud?.stop())

const site = async (dir = "site") => {
  await write(root, `${dir}/index.html`, "<h1>report</h1>")
  await write(root, `${dir}/assets/app.js`, "console.log(1)")
  await write(root, `${dir}/assets/style.css`, "h1{}")
  await write(root, `${dir}/shot.png`, "png")
  await write(root, `${dir}/data.bin`, "\0")
  await write(root, `${dir}/.git/HEAD`, "ref: refs/heads/main")
  return join(root, dir)
}
const keys = (prefix = "") => [...cloud.objects.keys()].filter((key) => key.startsWith(prefix)).sort()

describe("pages", () => {
  test("content types come from the extension", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8")
    expect(contentType("a/b/app.MJS")).toBe("text/javascript; charset=utf-8")
    expect(contentType("shot.png")).toBe("image/png")
    expect(contentType("report.pdf")).toBe("application/pdf")
    expect(contentType("font.woff2")).toBe("font/woff2")
    expect(contentType("dir.d/README")).toBe("application/octet-stream")
  })

  test("publish ids sort by time, and only prefixes a publish made are ever deleted", () => {
    const id = publishId(new Date("2026-10-22T02:40:05.123Z"), Uint8Array.from([1, 2, 3, 4]))
    expect(id).toBe("20261022t024005z-01020304")
    expect(publishedPrefix(`report/${id}/`)).toBe(true)
    expect(publishedPrefix(`${id}/`)).toBe(true)
    for (const prefix of ["", "/", "report/", `report/${id}`, `a/b/${id}/`, `Report/${id}/`, `report/${id}/x/`]) expect(publishedPrefix(prefix)).toBe(false)
  })

  test("a directory goes up without .git, each file with its content type, and the page points at it", async () => {
    const dir = await site()
    const result = await publishPage(deps, { source: dir, name: "report" })
    expect(result.page).toMatchObject({ name: "report", url: "https://report.kyora.page", private: true, bucket: "pages" })
    expect(publishedPrefix(result.page.prefix)).toBe(true)
    expect(result.page.prefix.startsWith("report/")).toBe(true)
    expect(result.files).toBe(5)
    expect(keys().map((key) => key.slice(`pages/${result.page.prefix}`.length))).toEqual(["assets/app.js", "assets/style.css", "data.bin", "index.html", "shot.png"])
    const type = (key: string) => cloud.objects.get(`pages/${result.page.prefix}${key}`)!.type
    expect(type("index.html")).toBe("text/html; charset=utf-8")
    expect(type("assets/app.js")).toBe("text/javascript; charset=utf-8")
    expect(type("assets/style.css")).toBe("text/css; charset=utf-8")
    expect(type("shot.png")).toBe("image/png")
    expect(type("data.bin")).toBe("application/octet-stream")
    // the bucket was made, in the default region
    expect(cloud.requests).toContain("POST /v1/storage/buckets")
    expect(result.replaced).toBeNull()
  })

  test("publishing to the same name switches the prefix, then deletes the old one", async () => {
    const dir = await site()
    const first = await publishPage(deps, { source: dir, name: "report", public: true })
    await writeFile(join(dir, "index.html"), "<h1>v2</h1>")
    const second = await publishPage(deps, { source: dir, name: "report", public: true })
    expect(second.page.prefix).not.toBe(first.page.prefix)
    expect(second.replaced).toEqual({ bucket: "pages", prefix: first.page.prefix, deleted: 5 })
    expect(keys(`pages/${first.page.prefix}`)).toEqual([])
    expect(keys(`pages/${second.page.prefix}`)).toHaveLength(5)
    expect(new TextDecoder().decode(cloud.objects.get(`pages/${second.page.prefix}index.html`)!.data)).toBe("<h1>v2</h1>")
    // the switch came before the delete: the page was never without files
    const create = cloud.requests.lastIndexOf("POST /v1/pages")
    const firstDelete = cloud.requests.findIndex((line) => line.startsWith(`DELETE /v1/storage/buckets/pages/o/${first.page.prefix}`))
    expect(firstDelete).toBeGreaterThan(create)
  })

  test("a prefix the page served that no publish made is kept", async () => {
    cloud.buckets.set("pages", "eu")
    cloud.objects.set("pages/index.html", { data: new Uint8Array(1), type: null })
    cloud.pages.set("report", { name: "report", url: "https://report.kyora.page", private: true, bucket: "pages", prefix: "", spa: false, createdAt: "", updatedAt: "" })
    const result = await publishPage(deps, { source: await site(), name: "report" })
    expect(result.replaced).toBeNull()
    expect(cloud.objects.has("pages/index.html")).toBe(true)
    expect(notes.join("\n")).toContain("not a prefix kyora publish made")
    // and rm leaves such files alone too
    cloud.pages.set("report", { ...result.page, prefix: "" })
    expect((await removePage(deps, "report")).files).toBeNull()
    expect(cloud.objects.has("pages/index.html")).toBe(true)
  })

  test("a refused publish deletes its own upload and leaves the page as it was", async () => {
    const dir = await site()
    const first = await publishPage(deps, { source: dir, name: "report" })
    cloud.pageFailure = { status: 429, error: "limit_reached", message: "you have 20 pages" }
    await expect(publishPage(deps, { source: dir, name: "report" })).rejects.toThrow("you have 20 pages")
    expect(keys("pages/")).toEqual(keys(`pages/${first.page.prefix}`))
    expect(cloud.pages.get("report")!.prefix).toBe(first.page.prefix)
  })

  test("without a name: kyora cloud names it from the directory's name, and each such publish is a new page", async () => {
    const dir = await site("Weekly Report")
    const first = await publishPage(deps, { source: dir })
    expect(cloud.hints).toEqual(["Weekly Report"])
    expect(cloud.requests.filter((line) => line.startsWith("GET /v1/pages/"))).toEqual([])
    expect(first.page.name).toMatch(/^weekly-report-[0-9a-f]{4}$/)
    expect(publishedPrefix(first.page.prefix)).toBe(true)
    expect(first.page.prefix).toMatch(/^\d{8}t\d{6}z-[0-9a-f]{8}\/$/)
    const second = await publishPage(deps, { source: dir })
    expect(second.page.name).not.toBe(first.page.name)
    expect(cloud.pages.get(first.page.name)!.prefix).toBe(first.page.prefix)
    // then by its name: the unnamed first publish's prefix is replaced and deleted like any other
    const third = await publishPage(deps, { source: dir, name: first.page.name })
    expect(third.replaced).toEqual({ bucket: "pages", prefix: first.page.prefix, deleted: 5 })
    expect(cloud.hints.at(-1)).toBeNull()
    // someone else's name is refused, and the upload goes again
    cloud.taken.add("mine")
    await expect(publishPage(deps, { source: dir, name: "mine" })).rejects.toThrow("held by another account")
    expect(keys("pages/mine/")).toEqual([])
  })

  test("a single file goes up with an index.html that redirects to it", async () => {
    await write(root, "out/Report Q3.pdf", "%PDF")
    const files = await pageFiles(join(root, "out/Report Q3.pdf"))
    expect(files.map((file) => [file.key, file.type])).toEqual([["Report Q3.pdf", "application/pdf"], ["index.html", "text/html; charset=utf-8"]])
    expect(files[1]!.data).toContain('url=./Report%20Q3.pdf')
    await write(root, "only/index.html", "<p>hi</p>")
    expect((await pageFiles(join(root, "only/index.html"))).map((file) => file.key)).toEqual(["index.html"])
  })

  test("limits: too many files or bytes fail before anything goes up", async () => {
    const many = join(root, "many")
    await mkdir(many)
    await Promise.all(Array.from({ length: MAX_FILES + 1 }, (_, i) => writeFile(join(many, `${i}.txt`), "")))
    await expect(publishPage(deps, { source: many, name: "many" })).rejects.toThrow(`more than ${MAX_FILES} files`)
    const big = join(root, "big.bin")
    await writeFile(big, "")
    await truncate(big, 501 * 1000 * 1000)
    await expect(publishPage(deps, { source: big, name: "big" })).rejects.toThrow("a page takes at most that")
    await expect(publishPage(deps, { source: join(root, "nothing"), name: "nope" })).rejects.toThrow("no such file or directory")
    expect(cloud.requests.filter((line) => line.startsWith("PUT "))).toEqual([])
  })

  test("rm releases the name and deletes its files; --keep-files keeps them", async () => {
    const dir = await site()
    const one = await publishPage(deps, { source: dir, name: "one" })
    const two = await publishPage(deps, { source: dir, name: "two" })
    expect(await removePage(deps, "one")).toEqual({ name: "one", removed: true, files: { bucket: "pages", prefix: one.page.prefix, deleted: 5 } })
    expect(keys(`pages/${one.page.prefix}`)).toEqual([])
    expect((await removePage(deps, "two", true)).files).toBeNull()
    expect(keys(`pages/${two.page.prefix}`)).toHaveLength(5)
    expect(cloud.pages.size).toBe(0)
  })

  test("the commands: publish prints the URL, ls, show, login, and usage errors", async () => {
    const dir = await site()
    const printed: string[] = []
    const log = console.log
    console.log = (line: unknown) => printed.push(String(line))
    try {
      expect(await pagesMain(["publish", dir, "--name", "report", "--public", "--spa"], deps)).toBe(0)
      expect(printed.pop()).toBe("https://report.kyora.page")
      expect(cloud.pages.get("report")).toMatchObject({ private: false, spa: true })
      await pagesMain(["ls"], deps)
      expect(printed.pop()).toStartWith("report\tpublic\thttps://report.kyora.page")
      await pagesMain(["login", "report", "--json"], deps)
      expect(JSON.parse(printed.pop()!)).toEqual({ loginUrl: "https://report.kyora.page/_kyora/login#signed" })
      await pagesMain(["show", "report"], deps)
      expect(printed.join("\n")).toContain("public · spa · pages/report/")
    } finally {
      console.log = log
    }
    await expect(pagesMain(["publish"], deps)).rejects.toThrow(PagesUsage)
    await expect(pagesMain(["ls", "--public"], deps)).rejects.toThrow("ls does not take --public")
    await expect(pagesMain(["publish", dir, "--name", "Not_A_Name"], deps)).rejects.toThrow("a page's name is")
    await expect(pagesMain(["rm", "report", "extra"], deps)).rejects.toThrow("usage: kyora pages rm")
  })
})
