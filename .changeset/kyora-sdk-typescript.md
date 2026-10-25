---
"@kyora-sh/sdk": minor
---

`@kyora-sh/sdk`, the first kyora SDK for TypeScript (Node 20.3+ and Bun, no runtime dependencies), generated from the kyora API's OpenAPI document: a `Kyora` client with a token, base URL and default region; `sandboxes` (create with automatic idempotency keys and the create queue, get, list and iterate by labels with cursors, update, delete), `exec` (run with a typed result, reattach by id or key, cancel), `files` (upload and download as tar, multipart above 64 MiB), `snapshots` (create, list, restore), `ports` and `tokens`; one `KyoraError` with `code`, `status`, `class`, `retryable` and `retryAfterMs` from the API's error catalog; retries that honour Retry-After within each call's deadline or AbortSignal; and `call()` for any other operation.
