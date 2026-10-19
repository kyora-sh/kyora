import { parseArgs } from "node:util"
import type { VmsClient } from "./api.js"
import { printJson } from "./output"

export const SUPPORT_HELP = `usage:
  kyora support new --subject TEXT --category general|billing|spend_limit|abuse|bug --message TEXT
  kyora support ls [--json]
  kyora support show <id> [--before CURSOR] [--json]
  kyora support reply <id> --message TEXT [--json]`

export interface SupportTicket {
  id: string
  subject: string
  category: string
  status: string
  createdAt: string
  messages?: Array<{ authorId: string | null; authorKind: string; body: string; createdAt: string }>
  nextMessageBefore?: number | null
}

export function parseSupportArgs(args: string[]) {
  const parsed = parseArgs({ args, options: { subject: { type: "string" }, category: { type: "string" }, message: { type: "string" }, before: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true })
  const { values, positionals } = parsed
  if (values.help) return parsed
  const [action, id] = positionals
  const fail = () => { throw new Error(SUPPORT_HELP) }
  if (!["new", "ls", "show", "reply"].includes(action ?? "")) fail()
  if (positionals.length !== (action === "show" || action === "reply" ? 2 : 1)) fail()
  if ((action === "show" || action === "reply") && !/^sup_[A-Za-z0-9_-]+$/.test(id ?? "")) fail()
  if (values.before !== undefined && (action !== "show" || !/^\d+$/.test(values.before) || Number(values.before) < 1 || Number(values.before) > 2_147_483_647)) fail()
  if (action === "new") {
    if (!values.subject?.trim() || values.subject.length > 200 || !["general", "billing", "spend_limit", "abuse", "bug"].includes(values.category ?? "general")) fail()
  } else if (values.subject !== undefined || values.category !== undefined) fail()
  if (action === "new" || action === "reply") {
    if (!values.message?.trim() || values.message.length > 10_000 || values.message.includes("\0")) fail()
  } else if (values.message !== undefined) fail()
  return parsed
}

export async function supportCommand(api: Pick<VmsClient, "supportRequest">, args: string[]): Promise<number> {
  const { values, positionals } = parseSupportArgs(args)
  if (values.help) { console.log(SUPPORT_HELP); return 0 }
  const [action, id] = positionals
  const result = await api.supportRequest(action === "new" || action === "reply" ? "POST" : "GET", id, action === "new" ? { subject: values.subject!, category: values.category ?? "general", message: values.message! } : action === "reply" ? { message: values.message! } : undefined, values.before)
  if (values.json) { printJson(result); return 0 }
  if ("tickets" in result) {
    if (!result.tickets.length) console.log("No support tickets.")
    for (const ticket of result.tickets) console.log(`${ticket.id}  ${ticket.status}  ${ticket.category}  ${ticket.subject}`)
  } else {
    const ticket = result.ticket
    console.log(`${ticket.id}  ${ticket.status}  ${ticket.category}  ${ticket.subject}`)
    if (action === "show") {
      for (const message of ticket.messages ?? []) console.log(`\n${message.authorKind} (${message.authorId ?? "deleted user"}), ${message.createdAt}\n${message.body}`)
      if (ticket.nextMessageBefore) console.log(`Older messages: kyora support show ${ticket.id} --before ${ticket.nextMessageBefore}`)
    }
  }
  return 0
}
