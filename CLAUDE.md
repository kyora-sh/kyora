# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

The CI gate:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

One crate, one test target, or one test by name:

```bash
cargo test -p kyora-core
cargo test -p kyora-core --test runtime
cargo test -p kyora-core --test runtime first_final_answer_skips_remaining_tools
```

The TypeScript CLIs (Bun workspaces under `packages/`, run with turbo):

```bash
bun install --frozen-lockfile
bunx turbo run build --concurrency=2
bunx turbo run check-types --concurrency=2
bunx turbo run test --concurrency=1
```

One file, or one test by name, from the package directory:

```bash
cd packages/switch/cli && bun test src/store.test.ts
cd packages/vms/cli && bun test src/config.test.ts -t "login"
```

Full builds and test runs are heavy. Run them in CI or a kyora VM (`kyora-vms run -- cargo test --workspace --locked`) rather than on a laptop.

## Bun

Use Bun, not Node.js: `bun <file>`, `bun test`, `bun build`, `bun install`, `bun run <script>`. Bun loads .env by itself; the CLIs run with `--no-env-file` where a stray .env must not leak in.

## Architecture

```
crates/protocol    provider-neutral messages, content blocks, tool calls and stream events
crates/providers   the ModelProvider trait, the Anthropic Messages API, stream accumulation, retry policy, a deterministic fake
crates/tools       built-in file, shell and workspace tools
crates/core        the runtime loop, tools and toolsets, ledger and budgets, sessions, traces
crates/cli         the harness binary `kyora-harness` (`kyora run` and `kyora tui` hand off to it) and its config
crates/tui         the event-driven TUI with a live recursion tree

packages/vms/cli          `kyora-vms` and `kyora` (bins), plus a library export of the API client
packages/vms/shared       wire formats the CLI shares with kyora cloud: image chunks, deploy types, meter counters
packages/vms/image        the image builder the CLI uploads into a builder VM (`kyora-vms image build`)
packages/switch/cli       `kyora-switch`, also `kyora switch`
packages/shared/usage     engine quota state and live usage probing
packages/shared/hostnames egress hostname rules
packages/tooling          shared tsconfig
```

Tests live in `crates/<crate>/tests`. Provider-facing tests use the fake provider, so they are deterministic and need no API key; live API tests are `#[ignore]`d. TypeScript tests sit next to their sources (`src/*.test.ts`) and run against in-process fakes of kyora cloud; none needs a kyora account.
