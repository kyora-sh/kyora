# shellcheck shell=bash
# Stage kyora, sourced by chroot-install.sh in the chroot: kyora's
# own steps, which change often and are cheap, so they come last and are never cached. A
# change here, to build-image.sh (kyora-init, the agent, /etc/kyora) or to the pack reuses
# every cached stage. Plan: IMAGE_ID, IMAGE_HASH and PROFILE_NAME, profile.json and
# stages.json (for the manifest). Env: AGENT_VERSION, and SOURCE_DATE_EPOCH, the time the
# cached stages under this one were built, so what this stage dates (a user's last password
# change in /etc/shadow) comes out the same over a cached tree as over a fresh one.

# delta mode (stages/delta.sh) sources this file for write_manifest and strip_image, with no IMAGE_ID
if [[ $MODE != delta ]]; then : "${IMAGE_ID:?IMAGE_ID is required}"; fi

# A live view's x11vnc, of any display but the owner's own control, runs as this user in a jail of its own
# (kyora-vm-agent's JailedStreamer): a system user with no home, no shell, no
# password and no sudo, which owns nothing in the image.
create_screen_user() {
  getent group kyora-screen >/dev/null || groupadd --system kyora-screen
  id kyora-screen >/dev/null 2>&1 ||
    useradd --system --gid kyora-screen --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kyora-screen
  passwd --lock kyora-screen >/dev/null
}

# The owner's overlay feed (screen broadcasts): kyora-vm-agent makes each screen broadcast's socket
# writable by this group, which has no members until the sandbox's owner adds one (sudo usermod -aG).
create_overlay_group() {
  getent group kyora-overlay >/dev/null || groupadd --system kyora-overlay
}

# Chrome for Testing where Google Chrome goes, so Playwright's `channel: "chrome"` (on Linux it looks only at
# /opt/google/chrome/chrome) and whatever runs google-chrome find it: in every profile whose playwright
# installed one (its chromium is Chrome for Testing since 1.57: chrome-linux64), linked here at build time,
# since the root fs is read-only at runtime. A real Google Chrome is never linked over.
link_chrome_for_testing() {
  local browsers chrome="" candidate
  browsers=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["resolved"]["env"].get("PLAYWRIGHT_BROWSERS_PATH", ""))' "$BUILD/profile.json")
  [[ -n $browsers ]] || return 0
  for candidate in "$browsers"/chromium-*/chrome-linux64/chrome; do
    if [[ -x $candidate ]]; then chrome=$candidate; fi
  done
  [[ -n $chrome ]] || return 0
  if [[ -e /opt/google/chrome/chrome && ! -L /opt/google/chrome/chrome ]]; then
    log "Google Chrome is installed: Chrome for Testing is not linked over it"
    return 0
  fi
  log "Chrome for Testing ($chrome) as /opt/google/chrome/chrome and /usr/bin/google-chrome"
  mkdir -p /opt/google/chrome
  ln -sfn "$chrome" /opt/google/chrome/chrome
  ln -sfn /opt/google/chrome/chrome /usr/bin/google-chrome
  /usr/bin/google-chrome --version >/dev/null || die "Chrome for Testing does not start as google-chrome"
}

configure_system() {
  git config --system safe.directory '*'
  git config --system init.defaultBranch main
  # /Users: the mount point kyora session puts a macOS laptop's repo path under (kyora-init overlays it)
  mkdir -p /work /mnt/scratch /etc/kyora /Users
  chmod 0755 /work /mnt/scratch
}

# fleet: the profile's manifest. delta: the base's, with `id` naming this version (the
# agent's ping reports it) and `image` saying what it is and what its tools are.
write_manifest() {
  local args=(fleet "$IMAGE_ID" "${AGENT_VERSION:-}" "$BUILD/profile.json" "$BUILD/stages.json")
  if [[ $MODE == delta ]]; then args=(delta "$BUILD/base-manifest.json" "$BUILD/image.json"); fi
  python3 - "${args[@]}" >"$BUILD/manifest.json" <<'PY'
import datetime, json, subprocess, sys

env = {
    "PATH": "/opt/rust/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
    "RUSTUP_HOME": "/opt/rust", "CARGO_HOME": "/opt/rust", "HOME": "/root",
    "COREPACK_HOME": "/opt/corepack", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
    "UV_PYTHON_INSTALL_DIR": "/opt/uv/python",
}

def version(*cmd: str) -> str | None:
    try:
        out = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60).stdout
        return out.strip().splitlines()[0] if out.strip() else None
    except (OSError, subprocess.TimeoutExpired):
        return None

tools = {
    "rustc": ("rustc", "--version"), "cargo": ("cargo", "--version"), "node": ("node", "--version"),
    "pnpm": ("pnpm", "--version"), "yarn": ("yarn", "--version"), "bun": ("bun", "--version"),
    "uv": ("uv", "--version"), "python3": ("python3", "--version"), "gcc": ("gcc", "--version"),
    "clang": ("clang", "--version"), "mold": ("mold", "--version"), "git": ("git", "--version"),
    "cmake": ("cmake", "--version"), "zstd": ("zstd", "--version"),
}
# reported only when the profile installed them
optional = {
    "wasm-pack": ("wasm-pack", "--version"), "wasm-bindgen": ("wasm-bindgen", "--version"),
    "wasm-opt": ("wasm-opt", "--version"), "maturin": ("maturin", "--version"),
    "gh": ("gh", "--version"), "git-lfs": ("git-lfs", "--version"),
    # the desktop profiles (computer use)
    "xdotool": ("xdotool", "--version"), "imagemagick": ("import", "-version"), "x11vnc": ("x11vnc", "-version"),
    "chromium": ("/usr/local/bin/chromium", "--version"), "libreoffice": ("soffice", "--version"),
    # Chrome for Testing linked where Playwright's channel "chrome" looks (link_chrome_for_testing)
    "google-chrome": ("/opt/google/chrome/chrome", "--version"),
    # the screen broadcast's encoder and the OpenH264 it loads (desktop profiles)
    "kyora-screencast": ("/usr/lib/kyora/kyora-screencast", "--version"),
    "openh264": ("/usr/lib/kyora/kyora-screencast", "--openh264-version"),
}
found = {name: v for name, cmd in optional.items() if (v := version(*cmd))}
try:  # the GitHub Actions runner (profile gha-runner) records its pinned release
    with open("/etc/kyora/gha-runner.json") as f:
        found["actions-runner"] = json.load(f)["version"]
except (OSError, ValueError, KeyError):
    pass
try:  # CPython builds uv manages (the profile's `python`)
    listing = subprocess.run(
        ("uv", "python", "list", "--only-installed", "--python-preference", "only-managed", "--output-format", "json"),
        env=env, capture_output=True, text=True, timeout=60,
    ).stdout
    managed = sorted({p["version"] for p in json.loads(listing or "[]")})  # an install and its minor alias
    if managed:
        found["uv-python"] = " ".join(managed)
except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
    pass
if sys.argv[1] == "delta":
    with open(sys.argv[2]) as f:
        base = json.load(f)
    with open(sys.argv[3]) as f:
        image = json.load(f)
    image["tools"] = {name: version(*cmd) for name, cmd in tools.items()} | found
    print(json.dumps({**base, "id": f"{image['name']}@{image['digest']}", "image": image}, indent=2))
    sys.exit(0)
with open(sys.argv[4]) as f:
    plan = json.load(f)
with open(sys.argv[5]) as f:
    stages = json.load(f)
manifest = {
    "id": sys.argv[2],
    "profile": plan["profile"],
    "hash": plan["hash"],
    "profileHash": plan["profileHash"],
    "scriptsHash": plan["scriptsHash"],
    "pins": plan["pins"],
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "agentVersion": sys.argv[3] or None,
    "ubuntu": "24.04 (noble)",
    "tools": {name: version(*cmd) for name, cmd in tools.items()} | found,
    "caches": plan["resolved"]["caches"],
    "resolved": plan["resolved"],
    # the build's cached stages and their keys: the same whether a stage
    # came from the cache or was built
    "aptEpoch": stages["aptEpoch"],
    "stages": {stage["name"]: stage["key"] for stage in stages["stages"] if stage["key"]},
    # build-image.sh installs kyora-image-build: a VM booted from this image can be a builder
    "builder": 1,
}
print(json.dumps(manifest, indent=2))
PY
  install -o root -g root -m 0644 "$BUILD/manifest.json" /etc/kyora-image.json
}

strip_image() {
  apt-get -y -q autoremove --purge
  apt-get clean
  rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/cache/debconf/*-old /var/lib/dpkg/*-old
  # docs of the packages debootstrap installed before the dpkg excludes existed
  find /usr/share/doc -mindepth 1 ! -type d ! -name copyright -delete
  find /usr/share/doc -mindepth 1 -type d -empty -delete
  rm -rf /usr/share/man/* /usr/share/info/* /usr/share/lintian/*
  find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name locale.alias -exec rm -rf {} +
  rm -rf /root/.cache /root/.npm /root/.rustup /root/.cargo /var/tmp/*
  # ldconfig's stat cache: it only speeds ldconfig up, and it differs on every build
  rm -f /var/cache/ldconfig/aux-cache
  # only what isn't empty yet: in delta mode, truncating an empty inherited file copies it up
  find /var/log -type f -size +0 -exec truncate -s 0 {} +
  if [[ ! -f /etc/machine-id || -s /etc/machine-id ]]; then : >/etc/machine-id; fi
  rm -f /etc/ssh/ssh_host_*
}

if [[ $MODE == delta ]]; then return 0; fi  # stages/delta.sh: the functions only
create_screen_user
create_overlay_group
configure_system
link_chrome_for_testing
write_manifest
strip_image
