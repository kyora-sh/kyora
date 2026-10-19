# shellcheck shell=bash
# Stage toolchains, sourced by chroot-install.sh in the chroot:
# rustup, cargo crates, node, bun, uv, uv's pythons and uv tools, at the versions the plan
# pinned. An empty plan value skips its step.
# Plan: RUST_DEFAULT RUST_TOOLCHAINS RUST_TARGETS RUST_COMPONENTS CARGO_CRATES NODE_SPEC
# BUN_SPEC UV_SPEC PYTHON_VERSIONS UV_TOOLS (lists are space-separated) and RUST_RESOLVED:
# `channel=<rustc version>` entries separated by `;`, what the plan resolved.

rustup() { CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust /opt/rust/bin/rustup "$@"; }

install_rust() {
  [[ -n ${RUST_DEFAULT:-} ]] || return 0
  local url=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init
  local toolchains targets=() components toolchain target
  words "${RUST_TOOLCHAINS:-}"
  toolchains=("${WORDS[@]}")
  words "${RUST_TARGETS:-}"
  for target in "${WORDS[@]}"; do targets+=(--target "$target"); done
  words "${RUST_COMPONENTS:-}"
  components=("${WORDS[@]}")
  if [[ $MODE == delta && -x /opt/rust/bin/rustup ]]; then
    log "rust ($RUST_DEFAULT) into the base's /opt/rust"
    rustup toolchain install "$RUST_DEFAULT" --profile default "${targets[@]}"
    rustup default "$RUST_DEFAULT"
  else
    log "rust ($RUST_DEFAULT) into /opt/rust"
    fetch "$url" "$DL/rustup-init"
    verify_sha256 "$DL/rustup-init" "$(fetch_text "$url.sha256" | cut -d' ' -f1)"
    chmod +x "$DL/rustup-init"
    CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust "$DL/rustup-init" -y --no-modify-path \
      --profile default --default-toolchain "$RUST_DEFAULT" "${targets[@]}"
  fi
  for toolchain in "${toolchains[@]}"; do
    if [[ $toolchain != "$RUST_DEFAULT" ]]; then
      log "rust toolchain $toolchain"
      rustup toolchain install "$toolchain" --profile default "${targets[@]}"
    fi
    if ((${#components[@]})); then rustup component add --toolchain "$toolchain" "${components[@]}"; fi
    # rust-docs is ~600 MB of HTML; nobody reads it in a sandbox
    rustup component remove --toolchain "$toolchain" rust-docs || true
  done
  check_rust_resolved
  rm -rf /opt/rust/downloads /opt/rust/tmp /opt/rust/registry /opt/rust/git
  # the sandbox user may `rustup target add` (writes land in the /opt overlay on scratch)
  own_by_sandbox /opt/rust
}

# Each channel installed the release the plan resolved it to, which is in the image id: a
# channel that moved during the build would make the id lie. Nothing to check with --no-pins.
check_rust_resolved() {
  local entries=() entry actual
  IFS=';' read -r -a entries <<<"${RUST_RESOLVED:-}"
  ((${#entries[@]})) || return 0
  for entry in "${entries[@]}"; do
    actual=$(rustup run "${entry%%=*}" rustc --version)
    [[ $actual == "rustc ${entry#*=}" ]] ||
      die "rust ${entry%%=*} installed $actual, but the plan resolved it to rustc ${entry#*=} (the channel moved during the build; build again)"
    log "rust ${entry%%=*}: $actual, as resolved"
  done
}

# crate@version from crates.io, built with its own lockfile, into /opt/rust/bin
install_cargo_crates() {
  words "${CARGO_CRATES:-}"
  ((${#WORDS[@]})) || return 0
  local spec
  for spec in "${WORDS[@]}"; do
    log "cargo install ${spec%@*} ${spec##*@}"
    CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust CARGO_TARGET_DIR=$DL/cargo-target \
      /opt/rust/bin/cargo install --locked "${spec%@*}" --version "${spec##*@}"
  done
  rm -rf /opt/rust/registry /opt/rust/git "$DL/cargo-target"
  own_by_sandbox /opt/rust
}

# NODE_SPEC: lts (the newest LTS), a major (its newest release) or an exact version
node_version() {
  case $1 in
    lts) fetch_text https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version' ;;
    *.*.*) printf 'v%s\n' "${1#v}" ;;
    *) fetch_text https://nodejs.org/dist/index.json |
      jq -r --arg p "v${1#v}." '[.[] | select(.version | startswith($p))][0].version' ;;
  esac
}

install_node() {
  [[ -n ${NODE_SPEC:-} ]] || return 0
  local version asset sums
  version=$(node_version "$NODE_SPEC")
  [[ $version =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]] || die "no node release matches $NODE_SPEC"
  asset="node-$version-linux-x64.tar.xz"
  log "node $version into /opt/node"
  fetch "https://nodejs.org/dist/$version/$asset" "$DL/$asset"
  sums=$(fetch_text "https://nodejs.org/dist/$version/SHASUMS256.txt")
  verify_sha256 "$DL/$asset" "$(awk -v f="$asset" '$2 == f {print $1}' <<<"$sums")"
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "$DL/$asset" -C /opt/node --strip-components=1 --no-same-owner
  rm -rf /opt/node/share/doc /opt/node/share/man /opt/node/CHANGELOG.md /opt/node/README.md

  export PATH=/opt/node/bin:$PATH COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if [[ ! -x /opt/node/bin/corepack ]]; then  # node >= 25 no longer bundles corepack
    npm install -g --no-fund --no-audit corepack
  fi
  mkdir -p /opt/corepack
  corepack enable  # pnpm / yarn shims in /opt/node/bin
  corepack install -g pnpm@latest
  corepack install -g yarn@stable
  own_by_sandbox /opt/corepack
  rm -rf /root/.npm
}

# BUN_SPEC and UV_SPEC: latest, or an exact version
install_bun() {
  [[ -n ${BUN_SPEC:-} ]] || return 0
  local base asset=bun-linux-x64.zip version
  if [[ $BUN_SPEC != latest ]]; then
    version=${BUN_SPEC#bun-}
    base="https://github.com/oven-sh/bun/releases/download/bun-v${version#v}"
  else
    base=https://github.com/oven-sh/bun/releases/latest/download
  fi
  log "bun from $base"
  fetch "$base/$asset" "$DL/$asset"
  verify_sha256 "$DL/$asset" "$(fetch_text "$base/SHASUMS256.txt" | awk -v f="$asset" '$2 == f {print $1}')"
  unzip -q -o "$DL/$asset" -d "$DL"
  install -m 0755 "$DL/bun-linux-x64/bun" /usr/local/bin/bun
  ln -sf bun /usr/local/bin/bunx
}

install_uv() {
  [[ -n ${UV_SPEC:-} ]] || return 0
  local base asset=uv-x86_64-unknown-linux-gnu.tar.gz
  if [[ $UV_SPEC != latest ]]; then
    base="https://github.com/astral-sh/uv/releases/download/${UV_SPEC#v}"
  else
    base=https://github.com/astral-sh/uv/releases/latest/download
  fi
  log "uv from $base"
  fetch "$base/$asset" "$DL/$asset"
  verify_sha256 "$DL/$asset" "$(fetch_text "$base/$asset.sha256" | cut -d' ' -f1)"
  tar -xzf "$DL/$asset" -C "$DL"
  install -m 0755 "$DL/uv-x86_64-unknown-linux-gnu/uv" "$DL/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/
}

# CPython builds managed by uv in /opt/uv/python (the image env points uv there), with
# python3.X on PATH through /usr/local/bin
install_python_versions() {
  words "${PYTHON_VERSIONS:-}"
  ((${#WORDS[@]})) || return 0
  log "python ${WORDS[*]} (uv) into /opt/uv/python"
  UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_BIN_DIR=/usr/local/bin uv python install "${WORDS[@]}"
  own_by_sandbox /opt/uv
}

# name==version, each in its own venv under /opt/uv/tools, entry points in /usr/local/bin
install_uv_tools() {
  words "${UV_TOOLS:-}"
  ((${#WORDS[@]})) || return 0
  local tool
  for tool in "${WORDS[@]}"; do
    log "uv tool install $tool"
    UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin \
      UV_CACHE_DIR=$DL/uv-cache uv tool install "$tool"
  done
}

if [[ $MODE == delta ]]; then return 0; fi  # stages/delta.sh: the functions only
install_rust
install_cargo_crates
install_node
install_bun
install_uv
install_python_versions
install_uv_tools
