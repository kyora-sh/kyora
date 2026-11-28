---
"kyora": patch
---

A failed command names the command it was and prints the server's reference when one is available. `kyora vms run` waits and asks again when the platform refuses to start a command for now, and keeps the sandbox if the command never starts. A rate-limited request shows the server's own message, without the unrelated hint about concurrent sandboxes.
