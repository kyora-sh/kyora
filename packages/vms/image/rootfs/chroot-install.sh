#!/usr/bin/env bash
# The part of a build stage that runs INSIDE the root being built, as root, with network
# access: chroot-install.sh <stage>, for the stages apt, toolchains, extras and kyora.
# rootfs/stage.sh runs it; not meant to be run by hand.
#
# /tmp/kyora-build holds the stage's plan, which tools/buildcache.py wrote for this stage
# alone (plan.env with only its variables, and its files), and stages/<stage>.sh, the stage's
# steps. This file is what every stage shares: the environment, the plan, the download dir
# $DL and the helpers fetch, fetch_text, verify_sha256, log, die and words. It is in the cache
# key of every cached stage, so what a stage does belongs in rootfs/stages/, not here.
#
# Delta mode (plan.env BUILD_MODE=delta): kyora-image-build runs it inside a builder VM,
# chrooted into an overlay of a finished kyora image, once per phase: `chroot-install.sh
# <phase> [step]` (stages/delta.sh). It adds only what an image spec asks for, on top of
# that base: no debootstrap, no dist-upgrade, no sandbox user or system config. The plan
# is tools/imagespec.py's: plan.env, run/<n>.sh (the spec's run steps), kyora/ (the merged
# /etc/kyora files), image.json and base-manifest.json (for the manifest), and stages/.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

BUILD=/tmp/kyora-build
DL=$BUILD/dl
# shellcheck source=/dev/null
source "$BUILD/plan.env"
MODE=${BUILD_MODE:-fleet}
STAGE=${1:-}
if [[ $MODE == delta ]]; then STAGE="delta"; fi
[[ -n $STAGE ]] || { printf 'which stage? (apt, toolchains, extras or kyora)\n' >&2; exit 2; }

log() { printf '[chroot %s] %s\n' "$STAGE" "$*" >&2; }
die() { printf '[chroot %s] error: %s\n' "$STAGE" "$*" >&2; exit 1; }

fetch() { curl -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch_text() { curl -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 "$1"; }

verify_sha256() {
  local file=$1 expected=$2 actual
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "no published sha256 found for $(basename "$file")"
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [[ $actual == "$expected" ]] || die "sha256 mismatch for $(basename "$file"): got $actual, want $expected"
  log "verified $(basename "$file") sha256 $actual"
}

# shellcheck disable=SC2034  # the stages read WORDS
words() { read -r -a WORDS <<<"${1:-}"; }  # a plan list into the WORDS array

# chown -R sandbox:sandbox, but only what isn't the sandbox's yet: in delta mode, changing
# an inherited file's owner would copy all of it up into the new image.
own_by_sandbox() {
  [[ -e $1 ]] || return 0
  find "$1" \( ! -user sandbox -o ! -group sandbox \) -exec chown -h sandbox:sandbox {} +
}

# What a profile's extra lines and a spec's run steps run with: the toolchains on PATH and
# the plan's env (the profile's or the spec's) exported.
step_env() {
  export PATH=/opt/rust/bin:/opt/node/bin:$PATH CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust
  export COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  set -a
  # shellcheck source=/dev/null
  source "$BUILD/env"
  set +a
}

[[ -f $BUILD/stages/$STAGE.sh ]] || die "no steps for stage $STAGE in $BUILD/stages"
mkdir -p "$DL"
# shellcheck source=/dev/null
source "$BUILD/stages/$STAGE.sh" "$@"
log "done"
