# @kyora-sh/sdk

## 0.1.1

### Patch Changes

- 2893bcf: `snapshots.restore` no longer destroys a sandbox it may not own: with your own `idempotencyKey` (Python: `idempotency_key`) the create can answer a sandbox an earlier restore under that key made, so when the wait for it fails (a failed sandbox, the deadline, an abort) the sandbox is left running and the error carries its id in `sandboxId` (Python: `sandbox_id`). A restore under the SDK's own key still destroys a sandbox whose wait fails. A key given as an `Idempotency-Key` header, in any casing, now counts as yours on every create and is sent once, instead of next to a generated one; a header and `idempotencyKey` that disagree are a usage error (TypeError; Python: ValueError) before anything is sent. The same fix lands in the Python SDK.

## 0.1.0

### Minor Changes

- 2748e8b: `@kyora-sh/sdk`, the first kyora SDK for TypeScript (Node 20.3+ and Bun, no runtime dependencies), generated from the kyora API's OpenAPI document: a `Kyora` client with a token, base URL and default region; `sandboxes` (create with automatic idempotency keys and the create queue, get, list and iterate by labels with cursors, update, delete), `exec` (run with a typed result, reattach by id or key, cancel), `files` (upload and download as tar, multipart above 64 MiB), `snapshots` (create, list, restore), `ports` and `tokens`; one `KyoraError` with `code`, `status`, `class`, `retryable` and `retryAfterMs` from the API's error catalog; retries that honour Retry-After within each call's deadline or AbortSignal; and `call()` for any other operation.
