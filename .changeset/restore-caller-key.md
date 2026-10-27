---
"@kyora-sh/sdk": patch
---

`snapshots.restore` no longer destroys a sandbox it may not own: with your own `idempotencyKey` (Python: `idempotency_key`) the create can answer a sandbox an earlier restore under that key made, so when the wait for it fails (a failed sandbox, the deadline, an abort) the sandbox is left running and the error carries its id in `sandboxId` (Python: `sandbox_id`). A restore under the SDK's own key still destroys a sandbox whose wait fails. A key given as an `Idempotency-Key` header, in any casing, now counts as yours on every create and is sent once, instead of next to a generated one; a header and `idempotencyKey` that disagree are a usage error (TypeError; Python: ValueError) before anything is sent. The same fix lands in the Python SDK.
