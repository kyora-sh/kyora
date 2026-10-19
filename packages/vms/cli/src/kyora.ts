#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { HARNESS_COMMANDS, runHarness } from "./harness"

// the harness takes over this process before anything touches stdout or stderr
const [command, ...args] = Bun.argv.slice(2)
if (command && HARNESS_COMMANDS.has(command)) await runHarness(command, args)
await import("./kyora-main")
