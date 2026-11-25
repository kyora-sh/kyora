# @kyora-sh/sdk

## 0.2.0

### Minor Changes

- 197178f: Private networks on kyora cloud. The CLI gains `kyora vms networks create <name> --cidr <cidr>`, `ls`, `show <id|name>` and `rm <id|name>`, and `--private-network ID[:IP]` (repeatable) on `create`, `run` and `new` joins a sandbox to one or more networks, optionally at a fixed IPv4 address. Both SDKs gain `networks.list`, `create`, `get` and `delete`, and their create requests take `privateNetwork` / `privateNetworks` (Python: `private_network` / `private_networks`); a sandbox reports the networks it is a member of. Private networks are enabled per account: until then these calls fail with `privnet_not_enabled`, whose message says how to get them, and the CLI prints it as it comes.
- 33b4ed1: Account secrets in the TypeScript and the Python SDK: `kyora.secrets` lists, gets, creates, rotates and deletes secrets (never their values), and creates, updates and deletes their bindings (code in a sandbox created with `proxySecrets` sends its request to kyora's egress broker at `$KYORA_EGRESS_URL/<binding id>/<path>`, which adds the secret and passes it on to the binding's host; a request sent straight to the host gets nothing added) and deliveries (sandboxes receive it as an env variable or a file). A sandbox create takes `secrets` (the deliveries it receives) and `proxySecrets` (Python: `proxy_secrets`), and the error catalog gains `delivery_exists`, `not_deliverable`, `secret_changed`, `secret_exists` and `secret_not_delivered`.

### Patch Changes

- 8b3a594: The README spells out the exec output callback's contract, in the TypeScript and the Python SDK alike: `onOutput(stream, chunk)` (Python: `on_output`), on `run` and on `exec.attach`, gets `"stdout"` or `"stderr"` and the bytes as they arrive; an async callback is awaited before the next chunk; output past `maxOutputBytes` (Python: `max_output_bytes`) still reaches it; a reattach never hands a chunk over twice, and output dropped while nothing was attached is marked in `truncated`; a throw ends the call at once while the command keeps running.

## 0.1.1

### Patch Changes

- 2893bcf: `snapshots.restore` no longer destroys a sandbox it may not own: with your own `idempotencyKey` (Python: `idempotency_key`) the create can answer a sandbox an earlier restore under that key made, so when the wait for it fails (a failed sandbox, the deadline, an abort) the sandbox is left running and the error carries its id in `sandboxId` (Python: `sandbox_id`). A restore under the SDK's own key still destroys a sandbox whose wait fails. A key given as an `Idempotency-Key` header, in any casing, now counts as yours on every create and is sent once, instead of next to a generated one; a header and `idempotencyKey` that disagree are a usage error (TypeError; Python: ValueError) before anything is sent. The same fix lands in the Python SDK.

## 0.1.0

### Minor Changes

- 2748e8b: `@kyora-sh/sdk`, the first kyora SDK for TypeScript (Node 20.3+ and Bun, no runtime dependencies), generated from the kyora API's OpenAPI document: a `Kyora` client with a token, base URL and default region; `sandboxes` (create with automatic idempotency keys and the create queue, get, list and iterate by labels with cursors, update, delete), `exec` (run with a typed result, reattach by id or key, cancel), `files` (upload and download as tar, multipart above 64 MiB), `snapshots` (create, list, restore), `ports` and `tokens`; one `KyoraError` with `code`, `status`, `class`, `retryable` and `retryAfterMs` from the API's error catalog; retries that honour Retry-After within each call's deadline or AbortSignal; and `call()` for any other operation.
