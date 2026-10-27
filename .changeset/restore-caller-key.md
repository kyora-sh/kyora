---
"@kyora-sh/sdk": patch
---

`snapshots.restore` no longer destroys a sandbox it may not own: with your own `idempotencyKey` (Python: `idempotency_key`) the create can answer a sandbox an earlier restore under that key made, so when the wait for it fails (a failed sandbox, the deadline, an abort) the sandbox is left running and the error carries its id in `sandboxId` (Python: `sandbox_id`). A restore under the SDK's own key still destroys a sandbox whose wait fails. The same fix lands in the Python SDK.
