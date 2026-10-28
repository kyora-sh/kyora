# @kyora-sh/sdk

The kyora API for TypeScript: create sandboxes, run commands in them, move files in and out, snapshot and restore them, expose their ports and manage tokens. Typed from the API's OpenAPI document, with typed errors, retries that honour `Retry-After`, automatic idempotency keys and a deadline on every call that waits.

## Install

```bash
npm install @kyora-sh/sdk
# or
bun add @kyora-sh/sdk
```

Node 20.3 or later, or Bun. ESM only, no runtime dependencies.

```ts
import { Kyora } from "@kyora-sh/sdk"

const kyora = new Kyora({ token: process.env.KYORA_TOKEN, region: "eu" })
```

`token` defaults to `KYORA_TOKEN`. `baseUrl` defaults to `https://cloud.kyora.sh`. `region` is where creates and restores go when they name none; without it kyora picks. A scoped token (see `tokens.create`) is the usual choice for a service: it can be limited to labels, regions, sizes and a number of sandboxes.

## Example: a document agent sandbox

An agent gets a fresh sandbox per document: the document goes in, a command processes it, the result comes out, and the sandbox is destroyed.

```ts
import { readFile } from "node:fs/promises"
import { Kyora, isKyoraError } from "@kyora-sh/sdk"

const kyora = new Kyora()

async function processDocument(name: string, document: Uint8Array): Promise<string> {
  const sandbox = await kyora.sandboxes.create(
    { vcpus: 2, memoryMb: 4096, network: "none", ttlSeconds: 900, labels: { app: "doc-agent" } },
    { timeoutMs: 60_000 },
  )
  try {
    await kyora.files.upload(sandbox.id, {
      [`inbox/${name}`]: document,
      "extract.sh": "#!/bin/sh\nset -e\nmkdir -p out\nwc -w inbox/* > out/summary.txt\n",
    })

    const result = await kyora.exec.run(sandbox.id, { cmd: ["sh", "extract.sh"], cwd: "/work", timeoutSeconds: 300 }, { timeoutMs: 330_000 })
    if (result.exitCode !== 0) throw new Error(`extract failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`)

    return new TextDecoder().decode(await kyora.files.read(sandbox.id, "/work/out/summary.txt"))
  } finally {
    await kyora.sandboxes.delete(sandbox.id)
  }
}

try {
  console.log(await processDocument("contract.pdf", new Uint8Array(await readFile("contract.pdf"))))
} catch (error) {
  if (isKyoraError(error, "limit")) console.error("over a quota or token limit; try later:", error.code)
  else if (isKyoraError(error) && error.retryable) console.error(`try again in ${error.retryAfterMs ?? 1000} ms:`, error.code)
  else throw error
}
```

Files upload under `/work` unless `dest` says otherwise.

## Errors

Every failure is a `KyoraError`:

| field | |
| --- | --- |
| `code` | the API's error code (`no_capacity`, `quota_exceeded`, `name_taken`, ...), or one of the SDK's own: `timeout`, `network_error`, `bad_response`, `stream_lost`, `exec_error` |
| `status` | the HTTP status, 0 when nothing answered |
| `class` | `transient`, `limit`, `conflict`, `not_found`, `auth`, `invalid` or `unavailable` |
| `retryable` | the same request can succeed later |
| `retryAfterMs` | the least wait kyora asked for, when it did |

`class` and `retryable` come from the API's error catalog (`ERROR_CODES`), per status where a code's retryability depends on it. A code newer than the SDK is classed by its status. Branch on `code` or `class`, never on `message`. A `limit` error (a quota, a token's constraints, a full queue) is its own class so a caller can park the work instead of retrying it.

## Retries and deadlines

A call that fails with a retryable error is repeated, up to 4 tries, after the `Retry-After` kyora sends (or a backoff from 250 ms). Only requests that are safe to repeat are: reads, `PUT`, `PATCH` and `DELETE`, and creates, which carry an `Idempotency-Key` (a fresh one per call unless you pass `idempotencyKey`) so a repeat never creates twice. Other writes are repeated only after a 429.

Every call takes `{ signal, timeoutMs, deadline }`. The bound covers the whole call, waits and retries included. A `Retry-After` that would end past it is not slept: the call throws that error at once, with its `retryAfterMs`, so a caller with a few seconds to spare can decide for itself. Calls that don't stream default to 30 s (`timeoutMs` on the client changes it), creates to 2 min, and the helpers that wait for a state (a snapshot ready, a restore running) to an hour. `retry: false` makes one try; `retry: { maxAttempts, baseDelayMs, maxDelayMs, maxRetryAfterMs }` tunes it. A create cut short by its deadline or an abort may still have made its sandbox: pass your own `idempotencyKey`, and the same create with the same key answers that sandbox instead of making another.

## Sandboxes

```ts
const sandbox = await kyora.sandboxes.create({ vcpus: 4, labels: { run: "42" } })
await kyora.sandboxes.get(sandbox.id)
await kyora.sandboxes.update(sandbox.id, { ttlSeconds: 7200 })
await kyora.sandboxes.delete(sandbox.id) // false when it was already gone

// one page at a time
const page = await kyora.sandboxes.list({ labels: { run: "42" }, limit: 100 })
const next = page.nextCursor ? await kyora.sandboxes.list({ labels: { run: "42" }, cursor: page.nextCursor }) : null

// or every match
for await (const found of kyora.sandboxes.iterate({ labels: { run: "42" } })) await kyora.sandboxes.delete(found.id)
```

With `wait` (seconds) in the create, a create kyora has no room for right now waits in line instead of failing with `no_capacity`; `onQueued` sees each ticket, and the deadline or an abort takes it out of line.

## Exec

```ts
const result = await kyora.exec.run(sandbox.id, { cmd: ["pytest", "-q"], cwd: "/work", env: { CI: "1" } }, {
  onOutput: (stream, chunk) => process[stream].write(chunk),
})
result.exitCode // null when a signal ended it, see result.signal
result.timedOut // the exec's timeoutSeconds stopped it
result.stdout // bytes; result.stderr too
result.truncated // { stdout, stderr }: output the result is missing
```

Every command runs resumable under an exec key (`key`, a fresh one unless you pass it). When the stream breaks, the command keeps running and `run` reattaches from the bytes it already has, for up to `reattachWindowMs` (2 min). At its deadline `run` stops waiting and throws an `ExecDetachedError` with the command's `execId`, `key` and `offsets`; the command keeps running. Get the rest with `exec.attach(sandbox, execId, { from: offsets })`, or run the same request with the same `key` again, from another process too: kyora rejoins the running command instead of starting it twice. A stream that breaks before kyora named the command is found again by its key; one that started without an id is never sent again, so a command never runs twice. Aborting `signal` cancels the command (`cancelOnAbort: false` keeps it). An exception from `onOutput` ends the call as it is. `result.stdout` keeps the first 16 MiB of each stream (`maxOutputBytes`); `onOutput` sees all of it.

## Files

```ts
await kyora.files.upload(sandbox.id, { "src/main.py": source, "data.bin": bytes }, { dest: "/work/job" })
await kyora.files.uploadTar(sandbox.id, tarBytesOrStream) // above 64 MiB it goes up in parts
const bytes = await kyora.files.read(sandbox.id, "/work/out/report.json")
const entries = await kyora.files.download(sandbox.id, ["/work/out"]) // [{ name, type, mode, data, ... }]
const stream = await kyora.files.downloadTar(sandbox.id, ["/work/out"]) // the raw tar
```

## Snapshots, ports and tokens

```ts
const snapshot = await kyora.snapshots.create(sandbox.id, { name: "deps-installed" }) // waits until ready
const copy = await kyora.snapshots.restore(snapshot.id, { labels: { run: "43" } }) // waits until running
for await (const old of kyora.snapshots.iterate({ labels: { run: "42" } })) await kyora.snapshots.delete(old.id)

const port = await kyora.ports.expose(sandbox.id, 8080, { public: true }) // port.url
await kyora.ports.unexpose(sandbox.id, port.label)

const { token } = await kyora.tokens.create({ name: "doc-agent", scopes: ["vms:read", "vms:write", "vms:exec"], constraints: { labels: { app: "doc-agent" }, maxSandboxes: 10 } })
```

A restore whose sandbox fails or runs out of time destroys it. Under your own `idempotencyKey` (or `Idempotency-Key` header) the same key answers the sandbox an earlier restore with that key made, which may be another caller's, so the SDK destroys it only when kyora's `Idempotent-Replayed` header says this call's request made it (`onReplayed` gets `false`), never when the answer is replayed (`true`) or kyora doesn't say (`null`). Otherwise the error carries the sandbox's id in `sandboxId` (an abort throws the signal's reason as it is; `onProgress` has seen the sandbox by then), and destroying it is up to you.

## Everything else

`kyora.call(operationId, { path, query, body })` sends any operation of the API, typed from the spec, with the same errors, retries and idempotency keys. JSON operations answer their parsed body; streamed, binary and HEAD ones the `Response`. Operations without a helper yet: custom domains, pages, computer use and live views, terminals, account images and object storage. `OPERATIONS` lists every operation; the generated types (`Sandbox`, `Snapshot`, `ExecFrame`, ...) are exported too.

## Versions

The SDK follows the API's `/v1` stability promise: additive changes only. `SPEC_VERSION` is the API version it was generated from, and the package ships that document as `@kyora-sh/sdk/openapi.yaml`.

## Developing

```bash
bun test
bun run check-types
bun run generate                        # src/generated/ from openapi.yaml
bun run sync-spec path/to/openapi.yaml  # take a newer API document, then generate
```

`src/generated/` is committed; a test fails when it is out of date, and another when an operation of the spec has neither an SDK method nor an entry in `src/coverage.ts` saying why not yet.
