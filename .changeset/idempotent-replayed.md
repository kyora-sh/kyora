---
"@kyora-sh/sdk": minor
---

`sandboxes.create` and `snapshots.restore` take `onReplayed` (Python: `on_replayed`), called with the create answer's `Idempotent-Replayed` header. It is `true` when the answer is a create that an earlier request under the same key started, `false` when this call's request made it, and `null` (Python: `None`) when kyora doesn't say. A restore under your own `idempotencyKey` (Python: `idempotency_key`) now destroys a sandbox whose wait fails when kyora says this call made it. It still never destroys one that is replayed or one kyora says nothing about. In TypeScript, an `onQueued` that throws now takes the create out of line, as it already did in Python. The vendored API spec is synced: it adds the `Idempotent-Replayed` response header and the `image_pulling`, `org_unbilled` and `org_usage_unavailable` error codes. The same changes land in the Python SDK.
