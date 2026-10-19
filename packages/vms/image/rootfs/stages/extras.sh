# shellcheck shell=bash
# Stage extras, sourced by chroot-install.sh in the chroot: the
# profile's files, then its extra lines, which may use them. A profile with neither has no
# extras stage. Plan: files.list and files/<n> (the profile's files), extra.sh (its lines)
# and env (its env, exported for extra.sh).

# The profile's files (image sources copied into the plan), root-owned, checked
# against the sha256 the image id was computed with. Before extra, so its lines can use them.
install_files() {
  [[ -s $BUILD/files.list ]] || return 0
  local mode sha index path
  while read -r mode sha index path; do
    verify_sha256 "$BUILD/files/$index" "$sha"
    log "file $path ($mode)"
    install -D -o root -g root -m "$mode" "$BUILD/files/$index" "$path"
  done <"$BUILD/files.list"
}

# The screen broadcast's encoder, for the desktop profiles' extra lines:
# Cisco's OpenH264 binary, fetched from Cisco (its patent licence covers the binary only as Cisco ships it) and
# checked against its pinned sha256, under /usr/lib/kyora/openh264 with Cisco's licence; and kyora-screencast,
# built here from its crate's sources (the extras stage's plan carries it as $BUILD/screencast, in its cache key) with a pinned
# Rust toolchain of its own and the crates its Cargo.lock pins by checksum, installed as
# /usr/lib/kyora/kyora-screencast. Both live under /usr, the only part of the image the screen jail mounts, and
# not under /usr/local, which it masks. The toolchain and the build go once it is installed, and its
# --self-test (an encode and a decode through OpenH264) must pass.
SCREENCAST_OPENH264_VERSION=2.6.0
SCREENCAST_OPENH264_URL=https://ciscobinary.openh264.org/libopenh264-2.6.0-linux64.8.so.bz2
SCREENCAST_OPENH264_BZ2_SHA256=27ab53323c110b76214c1c72222f459d17febbcd1e252136cadc292b0308d75b
SCREENCAST_OPENH264_SHA256=2f0cde7c6a6abcf5cae76942894ea42897fa677bce4ed6c91a24dd1b041d5f04
SCREENCAST_RUST=1.99.0
# rustup-init, pinned: an archived release and its sha256 here, never a checksum fetched beside the binary
SCREENCAST_RUSTUP_VERSION=1.29.1
SCREENCAST_RUSTUP_URL=https://static.rust-lang.org/rustup/archive/$SCREENCAST_RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init
SCREENCAST_RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
install_screencast() {
  local src=$BUILD/screencast lib=/usr/lib/kyora rust=$DL/screencast-rust target=$DL/screencast-target
  [[ -f $src/Cargo.lock ]] || die "no screencast crate at $src (tools/buildcache.py plans it for a profile whose extra lines call install_screencast)"
  command -v cc >/dev/null || die "kyora-screencast needs a C linker (cc): the profile installs none"
  log "OpenH264 $SCREENCAST_OPENH264_VERSION (Cisco's binary) into $lib/openh264"
  fetch "$SCREENCAST_OPENH264_URL" "$DL/openh264.so.bz2"
  verify_sha256 "$DL/openh264.so.bz2" "$SCREENCAST_OPENH264_BZ2_SHA256"
  bunzip2 -f "$DL/openh264.so.bz2"
  verify_sha256 "$DL/openh264.so" "$SCREENCAST_OPENH264_SHA256"
  install -D -o root -g root -m 0644 "$DL/openh264.so" "$lib/openh264/libopenh264.so"
  install -D -o root -g root -m 0644 "$src/openh264/BINARY_LICENSE.txt" "$lib/openh264/BINARY_LICENSE.txt"
  printf 'OpenH264 %s, %s\nsha256 %s\n' "$SCREENCAST_OPENH264_VERSION" "$SCREENCAST_OPENH264_URL" "$SCREENCAST_OPENH264_SHA256" >"$lib/openh264/VERSION"
  log "kyora-screencast, built with Rust $SCREENCAST_RUST"
  # rustup-init goes by its name: it keeps it, in a directory of its own
  mkdir -p "$DL/screencast-rustup"
  fetch "$SCREENCAST_RUSTUP_URL" "$DL/screencast-rustup/rustup-init"
  verify_sha256 "$DL/screencast-rustup/rustup-init" "$SCREENCAST_RUSTUP_SHA256"
  chmod +x "$DL/screencast-rustup/rustup-init"
  CARGO_HOME=$rust RUSTUP_HOME=$rust "$DL/screencast-rustup/rustup-init" -y -q --no-modify-path --profile minimal \
    --default-toolchain "$SCREENCAST_RUST"
  cp -R "$src" "$DL/screencast-src"
  (
    cd "$DL/screencast-src" || exit 1
    # --locked: exactly the crates Cargo.lock names, each checked against its checksum there
    CARGO_HOME=$rust RUSTUP_HOME=$rust CARGO_TARGET_DIR=$target \
      "$rust/bin/cargo" build --release --locked --quiet
  )
  install -D -o root -g root -m 0755 "$target/release/kyora-screencast" "$lib/kyora-screencast"
  rm -rf "$rust" "$target" "$DL/screencast-src" "$DL/screencast-rustup" "$DL/openh264.so"
  "$lib/kyora-screencast" --self-test || die "kyora-screencast's self-test failed"
}

# The profile's own lines, sourced in a subshell, so fetch, verify_sha256, log, die and
# $DL are at hand, with the toolchains on PATH and the profile's env exported. apt's lists
# are refreshed first: the apt stage under them may come from the build cache, up to an apt
# epoch old, and the archive drops superseded packages.
run_extra() {
  grep -qv '^[[:space:]]*\(#.*\)\{0,1\}$' "$BUILD/extra.sh" || return 0
  log "profile extra steps"
  apt-get update -q
  (
    step_env
    cd "$DL" || die "no $DL"
    # shellcheck source=/dev/null
    source "$BUILD/extra.sh"
  )
}

# shellcheck disable=SC2153  # chroot-install.sh sets MODE
if [[ $MODE == delta ]]; then return 0; fi  # stages/delta.sh: the functions only
install_files
run_extra
