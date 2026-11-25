---
"kyora": minor
"@kyora-sh/sdk": minor
---

Private networks on kyora cloud. The CLI gains `kyora vms networks create <name> --cidr <cidr>`, `ls`, `show <id|name>` and `rm <id|name>`, and `--private-network ID[:IP]` (repeatable) on `create`, `run` and `new` joins a sandbox to one or more networks, optionally at a fixed IPv4 address. Both SDKs gain `networks.list`, `create`, `get` and `delete`, and their create requests take `privateNetwork` / `privateNetworks` (Python: `private_network` / `private_networks`); a sandbox reports the networks it is a member of. Private networks are enabled per account: until then these calls fail with `privnet_not_enabled`, whose message says how to get them, and the CLI prints it as it comes.
