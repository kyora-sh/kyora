# shellcheck shell=bash
# Stage apt, sourced by chroot-install.sh in the chroot: dpkg's
# path excludes, the profile's apt packages after a dist-upgrade, and the sandbox user, whom
# the toolchains and the profile's extra lines give their files to (so it exists before them).
# Plan: APT_PACKAGES, space-separated. APT_EPOCH and SALT are only there to key the stage:
# a new epoch or salt is a fresh dist-upgrade.

SANDBOX_UID=1000

# Keep docs, man pages and translations out of every package installed from here on.
configure_dpkg() {
  cat >/etc/dpkg/dpkg.cfg.d/01-kyora-nodoc <<'EOF'
path-exclude=/usr/share/doc/*
path-include=/usr/share/doc/*/copyright
path-exclude=/usr/share/man/*
path-exclude=/usr/share/info/*
path-exclude=/usr/share/lintian/*
path-exclude=/usr/share/locale/*
path-include=/usr/share/locale/locale.alias
EOF
  cat >/etc/apt/apt.conf.d/01-kyora <<'EOF'
APT::Install-Recommends "false";
APT::Install-Suggests "false";
Acquire::Retries "3";
EOF
}

install_packages() {
  local packages=()
  read -r -a packages <<<"${APT_PACKAGES:-}"
  if [[ $MODE == delta ]]; then
    # the spec's packages and what they need, nothing else: the base's are not upgraded
    ((${#packages[@]})) || return 0
    apt-get update -q
    apt-get -y -q install "${packages[@]}"
    return
  fi
  ((${#packages[@]})) || die "the plan has no apt packages"
  apt-get update -q
  apt-get -y -q dist-upgrade
  apt-get -y -q install "${packages[@]}"
}

create_sandbox_user() {
  local other
  other=$(getent passwd "$SANDBOX_UID" | cut -d: -f1 || true)
  if [[ -n $other && $other != sandbox ]]; then userdel "$other"; fi
  other=$(getent group "$SANDBOX_UID" | cut -d: -f1 || true)
  if [[ -n $other && $other != sandbox ]]; then groupdel "$other"; fi
  getent group sandbox >/dev/null || groupadd --gid "$SANDBOX_UID" sandbox
  id sandbox >/dev/null 2>&1 ||
    useradd --uid "$SANDBOX_UID" --gid "$SANDBOX_UID" --home-dir /work/.home --no-create-home --shell /bin/bash sandbox

  # passwordless sudo inside the VM: it is the VM's own root, the VM is the boundary
  cat >/etc/sudoers.d/kyora-sandbox <<'EOF'
Defaults:sandbox !requiretty, !lecture
Defaults secure_path="/opt/rust/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Defaults env_keep += "HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy"
Defaults env_keep += "DEBIAN_FRONTEND RUSTUP_HOME CARGO_HOME COREPACK_HOME"
sandbox ALL=(ALL:ALL) NOPASSWD: ALL
EOF
  chmod 0440 /etc/sudoers.d/kyora-sandbox
  visudo -cf /etc/sudoers.d/kyora-sandbox >/dev/null
}

if [[ $MODE == delta ]]; then return 0; fi  # stages/delta.sh: the functions only
configure_dpkg
log "packages"
install_packages
create_sandbox_user
