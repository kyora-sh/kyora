#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { runKyora } from "./kyora-main"
import { setNoteName } from "./output"

// kyora-vms, the deprecated name: `kyora-vms <args…>` is `kyora vms <args…>`
setNoteName("kyora-vms")
runKyora(["vms", ...Bun.argv.slice(2)])
