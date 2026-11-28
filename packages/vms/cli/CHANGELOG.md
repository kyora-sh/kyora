# kyora

## 0.4.1

### Patch Changes

- 852e55b: A failed command names the command it was and prints the server's reference when one is available. `kyora vms run` waits and asks again when the platform refuses to start a command for now, and keeps the sandbox if the command never starts. A rate-limited request shows the server's own message, without the unrelated hint about concurrent sandboxes.
- 4d068f2: `kyora vms exec` and `kyora vms run` reattach to a command across a break of up to 10 minutes and say when they reattached. `vms run` retries downloads through a lost connection and keeps a sandbox whose outputs did not come down, printing the `kyora vms pull` command that fetches them; a sandbox that ended says so and why, and an internal error prints a reference.

## 0.4.0

### Minor Changes

- 197178f: Private networks on kyora cloud. The CLI gains `kyora vms networks create <name> --cidr <cidr>`, `ls`, `show <id|name>` and `rm <id|name>`, and `--private-network ID[:IP]` (repeatable) on `create`, `run` and `new` joins a sandbox to one or more networks, optionally at a fixed IPv4 address. Both SDKs gain `networks.list`, `create`, `get` and `delete`, and their create requests take `privateNetwork` / `privateNetworks` (Python: `private_network` / `private_networks`); a sandbox reports the networks it is a member of. Private networks are enabled per account: until then these calls fail with `privnet_not_enabled`, whose message says how to get them, and the CLI prints it as it comes.

## 0.3.0

### Minor Changes

- b5a3011: `kyora vms snapshot <sandbox>`, `kyora vms snapshot ls | show | rm` and `kyora vms restore <snap>` take, list, delete and restore snapshots; `kyora vms ls --label key=value` filters by label. `VmsClient` gains `snapshot`, `snapshots`, `getSnapshot`, `deleteSnapshot`, `restore`, `expose`, `ports`, `unexpose`, `releaseName`, and `list({ labels, limit, cursor })`, which follows `next_cursor`.

## 0.2.0

### Minor Changes

- eb60fb8: `kyora vms images check [dir]` reports what CI makes of `.github/kyora.yml` (each warning, exit 1 when it refuses an image), and `kyora vms images build <name> --from gha-runner` builds from a setup script or packages.

### Patch Changes

- 08fbe7d: Capacity notes speak of room in a region (`no room in us`), and `kyora vms nodes` is described as the admin view it is.
- 8ed782e: `kyora vms` takes the sandbox ids kyora cloud mints with the region only (`sb_eu_…`) as full ids.

## 0.1.1

### Patch Changes

- 9b777a7: Messages from `kyora` start with `[kyora]`; the `kyora-vms` alias keeps `[kyora-vms]`.
