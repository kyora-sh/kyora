# kyora

## 0.2.0

### Minor Changes

- eb60fb8: `kyora vms images check [dir]` reports what CI makes of `.github/kyora.yml` (each warning, exit 1 when it refuses an image), and `kyora vms images build <name> --from gha-runner` builds from a setup script or packages.

### Patch Changes

- 08fbe7d: Capacity notes speak of room in a region (`no room in us`), and `kyora vms nodes` is described as the admin view it is.
- 8ed782e: `kyora vms` takes the sandbox ids kyora cloud mints with the region only (`sb_eu_…`) as full ids.

## 0.1.1

### Patch Changes

- 9b777a7: Messages from `kyora` start with `[kyora]`; the `kyora-vms` alias keeps `[kyora-vms]`.
