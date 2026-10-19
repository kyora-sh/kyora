# kyora

kyora is a recursive agent runtime: a Rust harness whose Python REPL lets the model call itself from code, so one agent can fan a task out to many. On kyora vms each of those agents gets its own machine, which takes recursive runs from a laptop to fleet scale.

Status: early development. Design: docs/design.md.

This repository also holds the kyora CLIs, in TypeScript on Bun:

- `packages/vms/cli`: `kyora-vms` (disposable VMs: run, exec, push, pull, shell, images) and `kyora` (move a coding-agent session to a VM and back, images, deploys, `kyora switch`);
- `packages/switch/cli`: `kyora-switch`, which hot-swaps coding-agent logins between accounts;
- `packages/shared/usage` and `packages/shared/hostnames`: libraries the CLIs bundle.

## Build and test

The Rust workspace:

```sh
cargo build
cargo test
cargo clippy --workspace --all-targets --locked -- -D warnings
```

Requires Rust stable (see rust-toolchain.toml); Python 3.9+ for the REPL tests.

Run the TUI demo: `CARGO_BUILD_JOBS=4 cargo run -p kyora-cli -- tui --demo` (see docs/tui.md).

Connect MCP servers through `[mcp.servers.<name>]` in `$KYORA_HOME/config.toml` (see docs/mcp.md).

The CLIs (Bun 1.4 or later):

```sh
bun install --frozen-lockfile
bunx turbo run build
bunx turbo run check-types
bunx turbo run test
```

License: Apache-2.0, see LICENSE. A package's own LICENSE or NOTICE takes precedence for its files: `packages/vms/shared` is under the Elastic License 2.0, and `packages/vms/cli/NOTICE` names what the CLI bundles from it.
