#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { runKyora } from "./kyora-main"

// kyora-vms, the deprecated name: `kyora-vms <args…>` is `kyora vms <args…>`
runKyora(["vms", ...Bun.argv.slice(2)])
