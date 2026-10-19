# shellcheck shell=bash
# Delta mode (image specs), sourced by chroot-install.sh in a builder VM's chroot
# of an overlay over a finished kyora image: one phase of an image spec per call,
# `chroot-install.sh <phase> [step]`, in the order tools/imagespec.py's phases() gives. The
# fleet stages' files are sourced first for their functions (each returns before its own steps
# in delta mode); what only a spec has (npm, pip, run steps, the merged /etc/kyora) is here.
# kyora-image-build copies rootfs/stages/ into the plan next to chroot-install.sh.

for lib in apt toolchains extras kyora; do
  [[ -f $BUILD/stages/$lib.sh ]] || die "no $lib.sh in $BUILD/stages (kyora-image-build copies them)"
  # shellcheck source=/dev/null
  source "$BUILD/stages/$lib.sh"
done

# Delta mode: npm packages (name@x.y.z) for the whole image, in /usr/local: modules in
# /usr/local/lib/node_modules, commands in /usr/local/bin. Needs node in /opt/node.
install_npm_packages() {
  words "${NPM_PACKAGES:-}"
  ((${#WORDS[@]})) || return 0
  [[ -x /opt/node/bin/npm ]] || die "npm packages need node in /opt/node"
  log "npm install -g ${WORDS[*]}"
  PATH=/opt/node/bin:$PATH npm_config_cache=$DL/npm-cache npm_config_update_notifier=false \
    npm install -g --prefix /usr/local --no-fund --no-audit "${WORDS[@]}"
}

# Delta mode: pip packages (name==x.y.z) into one venv, $VENV (/opt/venv), that uv makes
# from the image's python3. Not into the system python: Ubuntu marks it externally managed,
# and the agent runs on it. Bytecode is compiled now, hash-checked (SOURCE_DATE_EPOCH is set).
install_pip_packages() {
  words "${PIP_PACKAGES:-}"
  ((${#WORDS[@]})) || return 0
  [[ -n ${VENV:-} ]] || die "the plan has pip packages but no VENV"
  command -v uv >/dev/null || die "pip packages need uv"
  if [[ ! -x $VENV/bin/python ]]; then
    log "venv $VENV from /usr/bin/python3"
    UV_PYTHON_DOWNLOADS=never uv venv --python /usr/bin/python3 "$VENV"
  fi
  log "pip install ${WORDS[*]} into $VENV"
  UV_CACHE_DIR=$DL/uv-cache UV_PYTHON_DOWNLOADS=never \
    uv pip install --python "$VENV/bin/python" --compile-bytecode "${WORDS[@]}"
  own_by_sandbox "$VENV"
}

# Delta mode: run step $1 of the spec (run/<n>.sh) as `bash -euo pipefail`, as root or as
# the sandbox user with a throwaway HOME. fetch, verify_sha256, log, die and $DL are at
# hand, the toolchains (and the spec's venv) are on PATH, and the spec's env is exported.
run_step() {
  local index=$1 script=$BUILD/run/$1.sh user home
  words "${RUN_USERS:-}"
  user=${WORDS[index - 1]:-}
  [[ -f $script && -n $user ]] || die "the plan has no run step $index"
  step_env
  if [[ -n ${VENV:-} ]]; then export VIRTUAL_ENV=$VENV PATH=$VENV/bin:$PATH; fi
  export -f log die fetch fetch_text verify_sha256
  if [[ $user == sandbox ]]; then
    home=$BUILD/home/$index
    mkdir -p "$home/dl"
    chown -R sandbox:sandbox "$home"
    cd "$home" || exit 1
    HOME=$home DL=$home/dl USER=sandbox LOGNAME=sandbox \
      exec setpriv --reuid=sandbox --regid=sandbox --init-groups -- /bin/bash -euo pipefail "$script"
  fi
  cd "$DL" || exit 1
  DL=$DL exec /bin/bash -euo pipefail "$script"
}

# Delta mode: the image's /etc/kyora/env and caches.json as kyora-image-build merged them
# (the base's with the spec's). Left alone when they come out the same.
install_image_config() {
  local name
  for name in env caches.json; do
    if ! cmp -s "$BUILD/kyora/$name" "/etc/kyora/$name"; then
      log "/etc/kyora/$name"
      install -o root -g root -m 0644 "$BUILD/kyora/$name" "/etc/kyora/$name"
    fi
  done
}

# Delta mode: one phase per call, in the order tools/imagespec.py's phases() gives.
delta_phase() {
  case ${1:-} in
    apt) install_packages ;;
    rustup) install_rust ;;
    cargo) install_cargo_crates ;;
    node) install_node ;;
    bun) install_bun ;;
    uv) install_uv ;;
    python) install_python_versions ;;
    npm) install_npm_packages ;;
    pip) install_pip_packages ;;
    uvTools) install_uv_tools ;;
    files) install_files ;;
    run) run_step "${2:?run needs a step number}" ;;
    config) install_image_config ;;
    manifest) write_manifest ;;
    strip) strip_image ;;
    *) die "unknown delta phase: ${1:-(none)}" ;;
  esac
}

delta_phase "$@"
