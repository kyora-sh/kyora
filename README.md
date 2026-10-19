# kyora

The kyora command line: disposable VMs for builds and coding agents, sessions you can move to a VM and back, deploys, and logins you can swap between accounts. TypeScript on [Bun](https://bun.sh).

Status: early development.

## Install

Requires Bun 1.2.19 or later on your PATH, and 1.3.14 or later for `kyora run` and `kyora tui` (`npx` will not work).

```sh
bun add -g kyora
kyora login
```

This installs `kyora`:

- `kyora vms`: disposable VMs. `kyora vms run -- cargo build` uploads your worktree, runs the command, streams its output and exits with its code; `new`, `ls`, `shell`, `exec`, `push`, `pull` and `images` cover the rest. See [packages/vms/cli](packages/vms/cli/README.md).
- `kyora detach` moves this repo's coding-agent conversation to a kyora VM and `kyora back` brings its commits and conversation home.
- `kyora image`, `kyora deploy` and `kyora top` manage images, deploys and live usage; `kyora login` signs in to kyora cloud.
- `kyora switch` hot-swaps coding-agent logins between accounts. See [packages/switch/cli](packages/switch/cli/README.md).
- `kyora run` and `kyora tui` start the kyora agent harness (below).

`kyora --help` lists them all. `kyora-vms`, the earlier name, is deprecated and still works: `kyora-vms <args>` is `kyora vms <args>`.

## The agent harness

kyora also ships its own agent harness: a recursive agent runtime in Rust whose Python REPL lets the model call itself from code, so one agent can fan a task out to many. On kyora VMs each of those agents gets its own machine, which takes recursive runs from a laptop to fleet scale. Design notes are in docs/.

Its binary is `kyora-harness`; `kyora run` and `kyora tui` hand off to it. Install it with:

```sh
cargo install --locked --git https://github.com/kyora-sh/kyora kyora-cli
```

Connect MCP servers through `[mcp.servers.<name>]` in `$KYORA_HOME/config.toml` (see docs/mcp.md). The TUI demo: `kyora tui --demo` (see docs/tui.md).

## Layout

- `packages/vms/cli`: `kyora` (and the deprecated `kyora-vms`);
- `packages/switch/cli`: `kyora-switch`;
- `packages/shared/usage` and `packages/shared/hostnames`: libraries the CLIs bundle;
- `crates/`: the agent harness (`crates/cli` builds `kyora-harness`).

## Build and test

The CLIs (Bun 1.4 or later):

```sh
bun install --frozen-lockfile
bunx turbo run build
bunx turbo run check-types
bunx turbo run test
```

The harness (Rust stable, see rust-toolchain.toml; Python 3.9+ for the REPL tests):

```sh
cargo build
cargo test
cargo clippy --workspace --all-targets --locked -- -D warnings
```

From a checkout, `CARGO_BUILD_JOBS=4 cargo run -p kyora-cli -- tui --demo` runs the TUI demo.

License: Apache-2.0, see LICENSE. `packages/vms/cli/NOTICE` names what the CLI bundles.
