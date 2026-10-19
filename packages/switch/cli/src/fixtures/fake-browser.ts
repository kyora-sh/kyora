/**
 * A stand-in for Chrome in web-login tests: it speaks the DevTools protocol over
 * --remote-debugging-pipe (requests on fd 3, replies on fd 4, NUL-terminated) and answers the few
 * calls web-login makes. FAKE_BROWSER_COOKIES are the cookies it holds once "logged in", after
 * FAKE_BROWSER_LOGIN_AFTER cookie reads; FAKE_BROWSER_QUIT_AFTER reads make it quit on its own, as
 * a user closing the window would. FAKE_BROWSER_STUBBORN makes it answer nothing and ignore SIGTERM.
 * Every argv and CDP method goes to FAKE_BROWSER_LOG.
 */
import { appendFileSync, createReadStream, mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const log = (entry: unknown) => process.env.FAKE_BROWSER_LOG && appendFileSync(process.env.FAKE_BROWSER_LOG, `${JSON.stringify(entry)}\n`)
log({ argv: args, pid: process.pid })
if (process.env.FAKE_BROWSER_STUBBORN) {
  process.on("SIGTERM", () => log({ ignored: "SIGTERM" }))
  setInterval(() => {}, 1000)
}

const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
if (!profile) process.exit(3)
mkdirSync(join(profile, "Default"), { recursive: true })
writeFileSync(join(profile, "Default", "Cookies"), "profile data")

const cookies = JSON.parse(process.env.FAKE_BROWSER_COOKIES ?? "[]") as unknown[]
const before = [{ name: "datr", value: "fake-datr", domain: ".meta.ai", path: "/", expires: -1, session: true, secure: true }]
const loginAfter = Number(process.env.FAKE_BROWSER_LOGIN_AFTER ?? "0")
const quitAfter = Number(process.env.FAKE_BROWSER_QUIT_AFTER ?? "0")
let reads = 0

function handle(id: number, method: string): void {
  log({ method })
  if (process.env.FAKE_BROWSER_STUBBORN) return
  const reply = (result: unknown) => void writeSync(4, `${JSON.stringify({ id, result })}\0`)
  if (method === "Browser.getVersion") return reply({ product: "FakeChrome/1.0", userAgent: "FakeChrome/1.0 (fixture)" })
  if (method === "Storage.getCookies") {
    reads++
    if (quitAfter && reads >= quitAfter) process.exit(0)
    return reply({ cookies: reads > loginAfter ? [...before, ...cookies] : before })
  }
  if (method === "Browser.close") {
    reply({})
    return void setTimeout(() => process.exit(0), 20)
  }
  writeSync(4, `${JSON.stringify({ id, error: { message: `unknown method ${method}` } })}\0`)
}

let buffer = ""
const input = createReadStream("", { fd: 3 })
input.on("data", (chunk) => {
  buffer += chunk.toString()
  let end: number
  while ((end = buffer.indexOf("\0")) >= 0) {
    const { id, method } = JSON.parse(buffer.slice(0, end)) as { id: number; method: string }
    buffer = buffer.slice(end + 1)
    handle(id, method)
  }
})
input.on("end", () => { if (!process.env.FAKE_BROWSER_STUBBORN) process.exit(0) })
