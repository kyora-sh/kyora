#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { HARNESS_COMMANDS, runHarness } from "./harness"

// the harness takes over this process before anything touches stdout or stderr
const argv = Bun.argv.slice(2)
const [command, ...args] = argv
if (command && HARNESS_COMMANDS.has(command)) await runHarness(command, args)
const { runKyora } = await import("./kyora-main")
runKyora(argv)
