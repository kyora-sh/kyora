/**
 * One push, as its own process so its memory can be measured: what `kyora vms push` runs,
 * with the parts in flight settable (the benchmark's "before" row keeps them at two).
 *
 *   KYORA_TOKEN=… bun src/testing/bench-push.ts <url> <sandbox> <dir> <shards> [partsInFlight]
 */
import { VmsClient } from "../api"
import { push } from "../transfer"

const [url, id, dir, shards, parts] = process.argv.slice(2)
if (!url || !id || !dir || !shards) throw new Error("usage: bench-push.ts <url> <sandbox> <dir> <shards> [partsInFlight]")
const api = new VmsClient({ url, key: process.env.KYORA_TOKEN ?? null, keySource: "$KYORA_TOKEN", urlSource: "argv", credentials: "" })
const result = await push(api, id, { dir, git: false }, "/work", { shards: Number(shards), partsInFlight: parts ? Number(parts) : undefined })
console.log(JSON.stringify({ raw: result.listing.bytes, sent: result.sent, parts: result.parts, shards: result.shards, entries: result.server.entries, durationMs: result.durationMs }))
