---
"kyora": patch
---

`kyora vms exec` and `kyora vms run` reattach to a command across a break of up to 10 minutes and say when they reattached. `vms run` retries downloads through a lost connection and keeps a sandbox whose outputs did not come down, printing the `kyora vms pull` command that fetches them; a sandbox that ended says so and why, and an internal error prints a reference.
