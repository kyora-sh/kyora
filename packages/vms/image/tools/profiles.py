#!/usr/bin/env python3
"""kyora vms image profiles: load, resolve, validate, hash, and plan an image build.

A profile (profiles/<name>.json) says what goes into a guest image on top of Ubuntu
24.04 minbase. `extends` layers profiles on each other. This file holds the format,
the merge rules and how an image id is derived. build-image.sh drives this file:

  profiles.py list                               names and descriptions
  profiles.py validate [NAME...]                 every profile, or the named ones
  profiles.py resolve NAME                       the resolved profile as JSON
  profiles.py id NAME [--no-pins] [--salt S]     the content-addressed image id
  profiles.py plan NAME --out DIR [...]          the build plan build-image.sh reads
  profiles.py extra NAME                         a profile's extra lines as a script (check.sh shellchecks it)
  profiles.py manifest --base F --image F --sha256 HEX --out F

Extra profile directories: --profiles DIR[:DIR...] or KYORA_VMS_PROFILES, searched
before the built-in profiles/. Python 3 stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import shlex
import sys
import urllib.request
from typing import Any, Callable

FORMAT = 1
HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_ROOT = os.path.dirname(HERE)
BUILTIN_DIR = os.path.join(IMAGE_ROOT, "profiles")
# Everything that decides what ends up in an image besides the profile itself. A change
# to any of them is a new image, so their content goes into the image hash.
SCRIPT_INPUTS = (
    "build-image.sh",
    "rootfs/stage.sh",
    "rootfs/chroot-install.sh",
    "rootfs/stages/apt.sh",
    "rootfs/stages/toolchains.sh",
    "rootfs/stages/extras.sh",
    "rootfs/stages/kyora.sh",
    "rootfs/stages/delta.sh",
    "rootfs/kyora.env",
    "rootfs/profile.sh",
    "rootfs/tmux.conf",
    "init/kyora-init",
    "agent/kyora_vm_agent.py",
    "tools/profiles.py",
    "tools/buildcache.py",
    # the image builder every fleet image carries (build-image.sh, install_kyora_files)
    "builder/kyora-image-build",
    "tools/imagespec.py",
)
# kyora-screencast's crate (built into the desktop profiles' images): every file of it the build copies
SCREENCAST_DIRS = ("screencast/src", "screencast/openh264")
SCREENCAST_FILES = ("screencast/Cargo.toml", "screencast/Cargo.lock")


def script_inputs(root: str | None = None) -> tuple[str, ...]:
    """SCRIPT_INPUTS and the screencast crate's files, relative to the image root."""
    root = root or IMAGE_ROOT
    found = list(SCRIPT_INPUTS) + list(SCREENCAST_FILES)
    for rel in SCREENCAST_DIRS:
        for directory, dirs, names in os.walk(os.path.join(root, rel)):
            dirs.sort()
            found += [os.path.relpath(os.path.join(directory, name), root) for name in sorted(names)]
    return tuple(found)

KNOWN_KEYS = {
    "name", "description", "extends", "apt", "rustup", "cargo", "node", "bun", "uv", "python", "uvTools",
    "files", "extra", "env", "caches",
}
RUSTUP_KEYS = {"toolchains", "default", "targets", "components"}
CACHE_KEYS = {"name", "path", "scope"}
FILE_KEYS = {"path", "source", "mode"}
# the fields that shape the image; description and lineage are documentation. `files`
# joins them only when a profile has any (see content()), so ids without files keep their scheme.
CONTENT_KEYS = ("name", "apt", "rustup", "cargo", "node", "bun", "uv", "python", "uvTools", "extra", "env", "caches")

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ID_SUFFIX_RE = re.compile(r"-[0-9a-f]{12}$")
RESERVED_NAMES = {"default", "rootfs"}  # default.ext4 and the legacy rootfs-<date> builds
APT_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$")
TOOLCHAIN_RE = re.compile(r"^(stable|beta|nightly|\d+\.\d+(\.\d+)?)(-\d{4}-\d{2}-\d{2})?$")
TARGET_RE = re.compile(r"^[a-z0-9_]+(-[a-z0-9_.]+){1,4}$")
COMPONENT_RE = re.compile(r"^[a-z][a-z0-9-]*$")
CRATE_RE = re.compile(r"^([A-Za-z0-9_-]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")
NODE_RE = re.compile(r"^(lts|v?\d+|v?\d+\.\d+\.\d+)$")
VERSION_RE = re.compile(r"^v?\d+\.\d+\.\d+$")
PYTHON_RE = re.compile(r"^3\.\d+(\.\d+)?$")
UV_TOOL_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._-]+\])?==([A-Za-z0-9.!+-]+)$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# /etc/kyora/env is read by kyora-init and sourced by sh: no quoting, spaces or expansion
ENV_VALUE_RE = re.compile(r"^[A-Za-z0-9_./:,@%+=-]*$")
# the volume label is cache-<name> and ext4 labels hold 16 bytes
CACHE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,9}$")
CACHE_PATH_RE = re.compile(r"^/work/[A-Za-z0-9._/-]+$")
CACHE_SCOPES = ("user", "repo")
# files a profile puts into the image: a file of this package (source), installed root-owned
# at path with mode. Only under /usr/local, /etc and /opt, never over what the build writes itself.
FILE_PATH_RE = re.compile(r"^/(usr/local|etc|opt)(/[A-Za-z0-9._@+-]+)+$")
FILE_PATH_RESERVED = ("/etc/kyora/", "/etc/kyora-image.json", "/usr/local/bin/kyora-vm-agent")
FILE_SOURCE_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$")
FILE_MODE_RE = re.compile(r"^0[0-7]{3}$")
DEFAULT_FILE_MODE = "0644"
# a profile declares caches; a sandbox attaches some of them (each is a drive)
MAX_CACHES = 16
MAX_DEPTH = 8
# the guest (init, agent, transfers, snapshots) and the build steps rely on these
REQUIRED_APT = (
    "python3", "sudo", "iproute2", "e2fsprogs", "procps", "zstd", "tar", "gzip",
    "git", "curl", "ca-certificates", "jq", "xz-utils", "unzip",
)
# the pre-profile build's env pins, still honoured as an overlay on top of the profile
LEGACY_ENV = ("NODE_VERSION", "BUN_VERSION", "UV_VERSION", "RUST_TOOLCHAIN", "EXTRA_PACKAGES")

UV_PYTHON_DIR = "/opt/uv/python"
NODE_INDEX = "https://nodejs.org/dist/index.json"
RUST_CHANNEL = "https://static.rust-lang.org/dist/channel-rust-{}.toml"
# what a channel manifest's [pkg.rustc] version says, and `rustc --version` prints after "rustc "
RUSTC_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)? \([0-9a-f]+ \d{4}-\d{2}-\d{2}\)$")
GITHUB_LATEST = "https://github.com/{}/releases/latest"

Loader = Callable[[str], dict[str, Any]]
Fetch = Callable[[str], tuple[str, bytes]]


class ProfileError(Exception):
    pass


# --------------------------------------------------------------------------- loading


def search_dirs(extra: str | None) -> list[str]:
    return [d for d in (extra or "").split(":") if d] + [BUILTIN_DIR]


def profile_names(dirs: list[str]) -> list[str]:
    names: set[str] = set()
    for d in dirs:
        try:
            names.update(f[:-5] for f in os.listdir(d) if f.endswith(".json") and not f.startswith("."))
        except FileNotFoundError:
            continue
    return sorted(names)


def dir_loader(dirs: list[str]) -> Loader:
    """Load and validate profiles/<name>.json, the first directory that has it wins."""
    cache: dict[str, dict[str, Any]] = {}

    def load(name: str) -> dict[str, Any]:
        if name in cache:
            return cache[name]
        if not NAME_RE.match(name):
            raise ProfileError(f"invalid profile name {name!r}")
        for d in dirs:
            path = os.path.join(d, f"{name}.json")
            try:
                with open(path) as f:
                    raw = json.load(f)
            except FileNotFoundError:
                continue
            except ValueError as e:
                raise ProfileError(f"{path}: not valid JSON: {e}") from None
            errors = validate_raw(raw, name)
            if errors:
                raise ProfileError(f"{path}:\n  " + "\n  ".join(errors))
            cache[name] = raw
            return raw
        raise ProfileError(f"no profile {name!r} (looked in {', '.join(dirs)})")

    return load


def dict_loader(profiles: dict[str, dict[str, Any]]) -> Loader:
    """For tests: profiles from a dict, validated like files."""

    def load(name: str) -> dict[str, Any]:
        if name not in profiles:
            raise ProfileError(f"no profile {name!r}")
        errors = validate_raw(profiles[name], name)
        if errors:
            raise ProfileError(f"{name}:\n  " + "\n  ".join(errors))
        return profiles[name]

    return load


# --------------------------------------------------------------------------- validation


def _strings(value: Any, where: str, pattern: re.Pattern[str] | None, errors: list[str]) -> None:
    if not isinstance(value, list):
        errors.append(f"{where} must be a list of strings")
        return
    for i, item in enumerate(value):
        if not isinstance(item, str) or (pattern is not None and not pattern.match(item)):
            errors.append(f"{where}[{i}] is invalid: {item!r}")


def _tool_spec(value: Any, where: str, errors: list[str]) -> None:
    if value is None or isinstance(value, bool):
        return
    if not isinstance(value, str) or not VERSION_RE.match(value):
        errors.append(f"{where} must be true, false, null or an exact version like 1.2.3: {value!r}")


def validate_raw(raw: Any, name: str) -> list[str]:
    """Problems with one profile file on its own (not its parents)."""
    if not isinstance(raw, dict):
        return ["a profile must be a JSON object"]
    errors: list[str] = []
    for key in sorted(set(raw) - KNOWN_KEYS):
        errors.append(f"unknown key {key!r} (known: {', '.join(sorted(KNOWN_KEYS))})")
    if raw.get("name") != name:
        errors.append(f"name must be {name!r}, the file's name")
    if not NAME_RE.match(name):
        errors.append("names are lowercase letters, digits and dashes, starting with a letter, at most 32")
    elif name in RESERVED_NAMES:
        errors.append(f"{name!r} is reserved")
    elif ID_SUFFIX_RE.search(name):
        errors.append("a name must not end in -<12 hex>, which is how image ids look")
    if "description" in raw and not isinstance(raw["description"], str):
        errors.append("description must be a string")
    extends = raw.get("extends")
    if extends is not None:
        parents = [extends] if isinstance(extends, str) else extends
        if not (isinstance(parents, list) and parents and all(isinstance(p, str) and NAME_RE.match(p) for p in parents)):
            errors.append("extends must be a profile name or a non-empty list of them")
        elif name in parents:
            errors.append("a profile cannot extend itself")
    for key, pattern in (("apt", APT_RE), ("cargo", CRATE_RE), ("python", PYTHON_RE), ("uvTools", UV_TOOL_RE)):
        if key in raw:
            _strings(raw[key], key, pattern, errors)
    if "extra" in raw:
        _strings(raw["extra"], "extra", None, errors)
        if isinstance(raw["extra"], list) and any(isinstance(x, str) and "\x00" in x for x in raw["extra"]):
            errors.append("extra lines must not contain NUL")
    rustup = raw.get("rustup")
    if rustup is not None:
        if not isinstance(rustup, dict):
            errors.append("rustup must be an object or null")
        else:
            for key in sorted(set(rustup) - RUSTUP_KEYS):
                errors.append(f"rustup: unknown key {key!r}")
            for key, pattern in (("toolchains", TOOLCHAIN_RE), ("targets", TARGET_RE), ("components", COMPONENT_RE)):
                if key in rustup:
                    _strings(rustup[key], f"rustup.{key}", pattern, errors)
            default = rustup.get("default")
            if "default" in rustup and not (isinstance(default, str) and TOOLCHAIN_RE.match(default)):
                errors.append(f"rustup.default is invalid: {default!r}")
    node = raw.get("node")
    if node is not None and node is not False and not (isinstance(node, str) and NODE_RE.match(node)):
        errors.append(f'node must be "lts", a major ("24"), an exact version ("24.1.0"), false or null: {node!r}')
    for key in ("bun", "uv"):
        if key in raw:
            _tool_spec(raw[key], key, errors)
    env = raw.get("env")
    if env is not None:
        if not isinstance(env, dict):
            errors.append("env must be an object")
        else:
            for key, value in env.items():
                if not ENV_KEY_RE.match(key):
                    errors.append(f"env: invalid name {key!r}")
                elif value is not None and not (isinstance(value, str) and ENV_VALUE_RE.match(value)):
                    errors.append(f"env.{key}: values are plain words (no spaces, quotes or $) or null: {value!r}")
    caches = raw.get("caches")
    if caches is not None:
        if not isinstance(caches, list):
            errors.append("caches must be a list")
        else:
            seen: set[str] = set()
            for i, cache in enumerate(caches):
                errors.extend(f"caches[{i}]: {e}" for e in _cache_errors(cache))
                if isinstance(cache, dict) and isinstance(cache.get("name"), str):
                    if cache["name"] in seen:
                        errors.append(f"caches[{i}]: duplicate name {cache['name']!r}")
                    seen.add(cache["name"])
    files = raw.get("files")
    if files is not None:
        if not isinstance(files, list):
            errors.append("files must be a list")
        else:
            paths: set[str] = set()
            for i, entry in enumerate(files):
                errors.extend(f"files[{i}]: {e}" for e in _file_errors(entry))
                if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                    if entry["path"] in paths:
                        errors.append(f"files[{i}]: duplicate path {entry['path']!r}")
                    paths.add(entry["path"])
    return errors


def _file_errors(entry: Any) -> list[str]:
    if not isinstance(entry, dict):
        return ["must be an object {path, source, mode}"]
    errors = [f"unknown key {k!r}" for k in sorted(set(entry) - FILE_KEYS)]
    path, source, mode = entry.get("path"), entry.get("source"), entry.get("mode", DEFAULT_FILE_MODE)
    if not (isinstance(path, str) and FILE_PATH_RE.match(path) and posixpath.normpath(path) == path):
        errors.append(f"path must be a normalized absolute path under /usr/local, /etc or /opt: {path!r}")
    elif any(path == r.rstrip("/") or (r.endswith("/") and path.startswith(r)) for r in FILE_PATH_RESERVED):
        errors.append(f"path {path!r} is written by the build itself")
    if not (isinstance(source, str) and FILE_SOURCE_RE.match(source)):
        errors.append(f"source must be a relative path inside the image sources, without . or .. parts: {source!r}")
    if not (isinstance(mode, str) and FILE_MODE_RE.match(mode)):
        errors.append(f'mode must be an octal string like "0644" or "0755": {mode!r}')
    return errors


def _cache_errors(cache: Any) -> list[str]:
    if not isinstance(cache, dict):
        return ["must be an object {name, path, scope}"]
    errors = [f"unknown key {k!r}" for k in sorted(set(cache) - CACHE_KEYS)]
    name, path, scope = cache.get("name"), cache.get("path"), cache.get("scope")
    if not (isinstance(name, str) and CACHE_NAME_RE.match(name)):
        errors.append(f"name must be 1-10 of [a-z0-9-] (the volume label is cache-<name>): {name!r}")
    if not (isinstance(path, str) and CACHE_PATH_RE.match(path) and posixpath.normpath(path) == path):
        errors.append(f"path must be a normalized absolute path under /work: {path!r}")
    if scope not in CACHE_SCOPES:
        errors.append(f"scope must be one of {', '.join(CACHE_SCOPES)}: {scope!r}")
    return errors


def _overlaps(a: str, b: str) -> bool:
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def validate_resolved(resolved: dict[str, Any]) -> list[str]:
    """Problems that only show once the layers are merged."""
    errors: list[str] = []
    names = {_apt_name(p) for p in resolved["apt"]}
    missing = [p for p in REQUIRED_APT if p not in names]
    if missing:
        errors.append(f"apt is missing what the guest and the build need: {', '.join(missing)} (extend base)")
    rustup = resolved["rustup"]
    if rustup is not None and not rustup["toolchains"]:
        errors.append("rustup needs at least one toolchain")
    if resolved["cargo"] and rustup is None:
        errors.append("cargo crates need rustup")
    if (resolved["python"] or resolved["uvTools"]) and resolved["uv"] is None:
        errors.append("python versions and uvTools need uv")
    caches = resolved["caches"]
    if len(caches) > MAX_CACHES:
        errors.append(f"at most {MAX_CACHES} caches")
    for i, a in enumerate(caches):
        for b in caches[i + 1 :]:
            if _overlaps(a["path"], b["path"]):
                errors.append(f"caches {a['name']} and {b['name']} overlap: {a['path']}, {b['path']}")
    return errors


# --------------------------------------------------------------------------- resolving


def _extends(raw: dict[str, Any]) -> list[str]:
    value = raw.get("extends")
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def lineage(name: str, load: Loader) -> list[str]:
    """Every profile `name` builds on, each once, parents before children, in declared order."""
    order: list[str] = []

    def visit(current: str, stack: tuple[str, ...]) -> None:
        if current in stack:
            raise ProfileError(f"extends cycle: {' -> '.join(stack + (current,))}")
        if len(stack) >= MAX_DEPTH:
            raise ProfileError(f"extends is nested deeper than {MAX_DEPTH}: {' -> '.join(stack + (current,))}")
        raw = load(current)
        for parent in _extends(raw):
            visit(parent, stack + (current,))
        if current not in order:
            order.append(current)

    visit(name, ())
    return order


def _apt_name(spec: str) -> str:
    return spec.split("=", 1)[0]


def _crate_name(spec: str) -> str:
    return spec.split("@", 1)[0]


def _uv_tool_name(spec: str) -> str:
    return re.split(r"[\[=]", spec, maxsplit=1)[0].lower()


def _union(base: list[str], layer: list[str], key: Callable[[str], str] = lambda s: s) -> list[str]:
    """base then layer, one entry per key; a later entry replaces an earlier one with the same key."""
    merged = {key(x): x for x in base}
    for item in layer:
        merged.pop(key(item), None)
        merged[key(item)] = item
    return list(merged.values())


def empty_profile() -> dict[str, Any]:
    return {
        "apt": [], "rustup": None, "cargo": [], "node": None, "bun": None, "uv": None,
        "python": [], "uvTools": [], "files": [], "extra": [], "env": {}, "caches": [],
    }


def _tool(value: Any) -> str | None:
    if value is None or value is False:
        return None
    if value is True:
        return "latest"
    return str(value).removeprefix("v")


def merge(acc: dict[str, Any], layer: dict[str, Any]) -> dict[str, Any]:
    """Lay one profile over the merged result of its parents (the merge rules)."""
    out = dict(acc)
    out["apt"] = _union(acc["apt"], layer.get("apt", []), _apt_name)
    out["cargo"] = _union(acc["cargo"], layer.get("cargo", []), _crate_name)
    out["python"] = _union(acc["python"], layer.get("python", []))
    out["uvTools"] = _union(acc["uvTools"], layer.get("uvTools", []), _uv_tool_name)
    out["extra"] = acc["extra"] + list(layer.get("extra", []))
    env = dict(acc["env"])
    for key, value in (layer.get("env") or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    out["env"] = env
    caches = {c["name"]: c for c in acc["caches"]}
    for cache in layer.get("caches") or []:
        caches[cache["name"]] = {k: cache[k] for k in ("name", "path", "scope")}
    out["caches"] = list(caches.values())
    files = {f["path"]: f for f in acc["files"]}
    for entry in layer.get("files") or []:
        files[entry["path"]] = {"path": entry["path"], "source": entry["source"], "mode": entry.get("mode", DEFAULT_FILE_MODE)}
    out["files"] = list(files.values())
    if "rustup" in layer:
        rustup = layer["rustup"]
        if rustup is None:
            out["rustup"] = None
        else:
            prev = acc["rustup"] or {"toolchains": [], "default": None, "targets": [], "components": []}
            out["rustup"] = {
                "toolchains": _union(prev["toolchains"], rustup.get("toolchains", [])),
                "default": rustup.get("default", prev["default"]),
                "targets": _union(prev["targets"], rustup.get("targets", [])),
                "components": _union(prev["components"], rustup.get("components", [])),
            }
    if "node" in layer:
        node = layer["node"]
        out["node"] = None if node is None or node is False else str(node).removeprefix("v")
    for key in ("bun", "uv"):
        if key in layer:
            out[key] = _tool(layer[key])
    return out


def apply_overrides(acc: dict[str, Any], overrides: dict[str, str]) -> dict[str, Any]:
    """The old build-rootfs.sh env pins (LEGACY_ENV), laid over the merged profile."""
    out = dict(acc)
    if overrides.get("NODE_VERSION"):
        value = overrides["NODE_VERSION"]
        if not NODE_RE.match(value):
            raise ProfileError(f"NODE_VERSION is invalid: {value!r}")
        out["node"] = value.removeprefix("v")
    for env_key, key, prefix in (("BUN_VERSION", "bun", "bun-"), ("UV_VERSION", "uv", "")):
        if overrides.get(env_key):
            value = overrides[env_key].removeprefix(prefix).removeprefix("v")
            if not VERSION_RE.match(value):
                raise ProfileError(f"{env_key} must be an exact version: {overrides[env_key]!r}")
            out[key] = value
    if overrides.get("RUST_TOOLCHAIN"):
        value = overrides["RUST_TOOLCHAIN"]
        if not TOOLCHAIN_RE.match(value):
            raise ProfileError(f"RUST_TOOLCHAIN is invalid: {value!r}")
        prev = acc["rustup"] or {"toolchains": [], "default": None, "targets": [], "components": []}
        old_default = prev["default"] or (prev["toolchains"][0] if prev["toolchains"] else None)
        others = [t for t in prev["toolchains"] if t != old_default and t != value]
        out["rustup"] = {**prev, "toolchains": [value, *others], "default": value}
    if overrides.get("EXTRA_PACKAGES"):
        extra = overrides["EXTRA_PACKAGES"].split()
        bad = [p for p in extra if not APT_RE.match(p)]
        if bad:
            raise ProfileError(f"EXTRA_PACKAGES has invalid package names: {' '.join(bad)}")
        out["apt"] = _union(acc["apt"], extra, _apt_name)
    return out


def canonical(name: str, description: str, parents: list[str], acc: dict[str, Any]) -> dict[str, Any]:
    """Sorted, deduplicated, fully spelled out: two profiles that mean the same resolve the same."""
    rustup = acc["rustup"]
    if rustup is not None:
        toolchains = list(rustup["toolchains"])
        default = rustup["default"] or (toolchains[0] if toolchains else None)
        if default is not None and default not in toolchains:
            toolchains.insert(0, default)
        rest = sorted(t for t in toolchains if t != default)
        rustup = {
            "default": default,
            "toolchains": ([default] if default else []) + rest,
            "targets": sorted(set(rustup["targets"])),
            "components": sorted(set(rustup["components"])),
        }
    return {
        "name": name,
        "description": description,
        "extends": parents,
        "apt": sorted(acc["apt"], key=_apt_name),
        "rustup": rustup,
        "cargo": sorted(acc["cargo"], key=_crate_name),
        "node": acc["node"],
        "bun": acc["bun"],
        "uv": acc["uv"],
        "python": sorted(set(acc["python"]), key=lambda v: tuple(int(x) for x in v.split("."))),
        "uvTools": sorted(acc["uvTools"], key=_uv_tool_name),
        "files": sorted(acc["files"], key=lambda f: f["path"]),
        "extra": list(acc["extra"]),
        "env": dict(sorted(acc["env"].items())),
        "caches": sorted(acc["caches"], key=lambda c: c["name"]),
    }


def file_digests(files: list[dict[str, str]], root: str) -> tuple[list[dict[str, str]], list[str]]:
    """Each file entry with the sha256 of its source (relative to root, a regular file inside it),
    so an edit to a file is a new image id like an edit to the profile."""
    out: list[dict[str, str]] = []
    errors: list[str] = []
    real_root = os.path.realpath(root)
    for entry in files:
        path = os.path.realpath(os.path.join(root, entry["source"]))
        if not path.startswith(real_root + os.sep) or not os.path.isfile(path):
            errors.append(f"file {entry['path']}: source {entry['source']!r} is not a file in {root}")
            continue
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        out.append({**entry, "sha256": digest})
    return out, errors


def resolve(name: str, load: Loader, overrides: dict[str, str] | None = None, root: str = IMAGE_ROOT) -> dict[str, Any]:
    """The profile with every parent merged in, normalized and validated. `root` is where
    `files` sources live (this package)."""
    order = lineage(name, load)
    acc = empty_profile()
    for layer in order:
        acc = merge(acc, load(layer))
    if overrides:
        acc = apply_overrides(acc, overrides)
    resolved = canonical(name, load(name).get("description", ""), order[:-1], acc)
    resolved["files"], errors = file_digests(resolved["files"], root)
    errors += validate_resolved(resolved)
    if errors:
        raise ProfileError(f"{name} (resolved):\n  " + "\n  ".join(errors))
    return resolved


# --------------------------------------------------------------------------- hashing


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def content(resolved: dict[str, Any]) -> dict[str, Any]:
    doc = {key: resolved[key] for key in CONTENT_KEYS}
    if resolved.get("files"):  # with each file's sha256, so its bytes are part of the id
        doc["files"] = resolved["files"]
    return doc


def profile_hash(resolved: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(content(resolved))).hexdigest()


def scripts_hash(root: str = IMAGE_ROOT, files: tuple[str, ...] | None = None) -> str:
    """The build script version: a digest of every file that shapes an image besides the profile."""
    files = script_inputs(root) if files is None else files
    digest = hashlib.sha256()
    for rel in sorted(files):
        with open(os.path.join(root, rel), "rb") as f:
            data = f.read()
        digest.update(rel.encode() + b"\0" + len(data).to_bytes(8, "big") + data)
    return digest.hexdigest()


def image_hash(
    resolved: dict[str, Any], *, scripts: str, pins: dict[str, str], build: dict[str, Any], salt: str = ""
) -> str:
    """The content address: resolved profile + build script version + pinned versions + build parameters."""
    doc: dict[str, Any] = {
        "format": FORMAT, "profile": content(resolved), "scripts": scripts, "pins": pins, "build": build,
    }
    if salt:
        doc["salt"] = salt
    return hashlib.sha256(canonical_json(doc)).hexdigest()


def image_id(name: str, digest: str) -> str:
    return f"{name}-{digest[:12]}"


# --------------------------------------------------------------------------- pins


def http_fetch(url: str) -> tuple[str, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "kyora-vms-image-build"})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed https URLs
        return response.geturl(), response.read()


def node_version(spec: str, fetch: Fetch) -> str:
    if VERSION_RE.match(spec):
        return spec.removeprefix("v")
    _, body = fetch(NODE_INDEX)
    releases = json.loads(body)
    for release in releases:
        version = str(release.get("version", ""))
        if (spec == "lts" and release.get("lts")) or (spec != "lts" and version.startswith(f"v{spec}.")):
            return version.removeprefix("v")
    raise ProfileError(f"no node release matches {spec!r}")


def github_latest(repo: str, tag_prefix: str, fetch: Fetch) -> str:
    final_url, _ = fetch(GITHUB_LATEST.format(repo))
    tag = final_url.rstrip("/").rsplit("/tag/", 1)[-1] if "/tag/" in final_url else ""
    version = tag.removeprefix(tag_prefix).removeprefix("v")
    if not VERSION_RE.match(version):
        raise ProfileError(f"cannot tell the latest release of {repo} from {final_url}")
    return version


def rust_channel_version(channel: str, fetch: Fetch) -> str:
    _, body = fetch(RUST_CHANNEL.format(channel))
    match = re.search(r'^\[pkg\.rustc\]\s*\nversion = "([^"]+)"', body.decode(errors="replace"), re.M)
    if not match:
        raise ProfileError(f"no rustc version in the {channel} channel manifest")
    if not RUSTC_VERSION_RE.match(match.group(1)):
        raise ProfileError(f"unexpected rustc version in the {channel} channel manifest: {match.group(1)!r}")
    return match.group(1)


def resolve_pins(resolved: dict[str, Any], fetch: Fetch) -> dict[str, str]:
    """Floating versions (lts, latest, stable) resolved to what a build today installs.

    They go into the image hash, so a new node LTS or rust stable is a new image id,
    and the plan installs exactly these (rust channels stay channels, and the build checks
    that each installed the release pinned here).
    """
    pins: dict[str, str] = {}
    if resolved["node"]:
        pins["node"] = node_version(resolved["node"], fetch)
    for tool, repo, prefix in (("bun", "oven-sh/bun", "bun-v"), ("uv", "astral-sh/uv", "")):
        spec = resolved[tool]
        if spec == "latest":
            pins[tool] = github_latest(repo, prefix, fetch)
        elif spec:
            pins[tool] = spec
    rustup = resolved["rustup"]
    for toolchain in rustup["toolchains"] if rustup else []:
        if toolchain in ("stable", "beta", "nightly"):
            pins[f"rust:{toolchain}"] = rust_channel_version(toolchain, fetch)
    return pins


# --------------------------------------------------------------------------- plan


def image_env(resolved: dict[str, Any]) -> dict[str, str]:
    """What the image's /etc/kyora/env gets on top of rootfs/kyora.env."""
    env = dict(resolved["env"])
    if resolved["python"]:
        env.setdefault("UV_PYTHON_INSTALL_DIR", UV_PYTHON_DIR)
    return dict(sorted(env.items()))


def plan_values(info: dict[str, Any]) -> dict[str, str]:
    """The plan's variables for build-image.sh and the build stages. Lists are space-separated
    (every item is validated to be a single word), except RUST_RESOLVED: `channel=<rustc
    version>` entries, separated by `;`, for the toolchains stage to check what it installed.
    tools/buildcache.py hands each stage only its own (STAGE_VARS)."""
    resolved, pins = info["resolved"], info["pins"]
    rustup = resolved["rustup"] or {"default": "", "toolchains": [], "targets": [], "components": []}
    values = {
        "PROFILE_NAME": resolved["name"],
        "IMAGE_ID": info["id"],
        "IMAGE_HASH": info["hash"],
        "APT_PACKAGES": " ".join(resolved["apt"]),
        "RUST_DEFAULT": rustup["default"] or "",
        "RUST_TOOLCHAINS": " ".join(rustup["toolchains"]),
        "RUST_TARGETS": " ".join(rustup["targets"]),
        "RUST_COMPONENTS": " ".join(rustup["components"]),
        "RUST_RESOLVED": ";".join(f"{t}={pins[f'rust:{t}']}" for t in rustup["toolchains"] if f"rust:{t}" in pins),
        "CARGO_CRATES": " ".join(resolved["cargo"]),
        "NODE_SPEC": pins.get("node") or resolved["node"] or "",
        "BUN_SPEC": pins.get("bun") or resolved["bun"] or "",
        "UV_SPEC": pins.get("uv") or resolved["uv"] or "",
        "PYTHON_VERSIONS": " ".join(resolved["python"]),
        "UV_TOOLS": " ".join(resolved["uvTools"]),
    }
    return values


def env_assignments(values: dict[str, str]) -> str:
    return "".join(f"{key}={shlex.quote(value)}\n" for key, value in values.items())


def plan_env(info: dict[str, Any]) -> str:
    """plan.env: every plan variable as a shell assignment (plan_values)."""
    return env_assignments(plan_values(info))


def extra_script(resolved: dict[str, Any]) -> str:
    head = f"# profile {resolved['name']}: extra steps, sourced by chroot-install.sh as root in the chroot\n"
    return head + "".join(line + "\n" for line in resolved["extra"])


def env_file(env: dict[str, str]) -> str:
    return "".join(f"{key}={value}\n" for key, value in env.items())


def build_info(
    name: str,
    load: Loader,
    *,
    pins: dict[str, str] | None = None,
    fetch: Fetch | None = None,
    scripts: str | None = None,
    build: dict[str, Any] | None = None,
    salt: str = "",
    overrides: dict[str, str] | None = None,
    root: str = IMAGE_ROOT,
) -> dict[str, Any]:
    """Everything a build needs to know, id included. pins=None with a fetch resolves them."""
    resolved = resolve(name, load, overrides, root)
    if pins is None:
        pins = resolve_pins(resolved, fetch) if fetch else {}
    scripts = scripts if scripts is not None else scripts_hash()
    build = build or {}
    digest = image_hash(resolved, scripts=scripts, pins=pins, build=build, salt=salt)
    info: dict[str, Any] = {
        "id": image_id(name, digest),
        "profile": name,
        "hash": digest,
        "profileHash": profile_hash(resolved),
        "scriptsHash": scripts,
        "pins": pins,
        "build": build,
        "resolved": resolved,
    }
    if salt:
        info["salt"] = salt
    return info


def files_list(resolved: dict[str, Any]) -> str:
    """One line per profile file for chroot-install.sh: `<mode> <sha256> <n> <path>`, where
    files/<n> is the copy in the plan. Every field is a single word (validated)."""
    return "".join(f"{f['mode']} {f['sha256']} {i} {f['path']}\n" for i, f in enumerate(resolved["files"]))


def write_plan(info: dict[str, Any], out_dir: str, root: str = IMAGE_ROOT) -> None:
    """The files build-image.sh copies into the chroot (and reads itself). The profile's
    files are copied to files/<n> and checked against the sha256 they were hashed with."""
    os.makedirs(out_dir, exist_ok=True)
    resolved = info["resolved"]
    files = {
        "profile.json": json.dumps(info, indent=2) + "\n",
        "plan.env": plan_env(info),
        "extra.sh": extra_script(resolved),
        "env": env_file(image_env(resolved)),
        "caches.json": json.dumps({"caches": resolved["caches"]}, indent=2) + "\n",
        "files.list": files_list(resolved),
    }
    for filename, text in files.items():
        with open(os.path.join(out_dir, filename), "w") as f:
            f.write(text)
    if resolved["files"]:
        os.makedirs(os.path.join(out_dir, "files"), exist_ok=True)
    for i, entry in enumerate(resolved["files"]):
        with open(os.path.join(root, entry["source"]), "rb") as f:
            data = f.read()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ProfileError(f"file {entry['path']}: {entry['source']} changed while planning")
        with open(os.path.join(out_dir, "files", str(i)), "wb") as f:
            f.write(data)


def final_manifest(
    base: dict[str, Any], image: str, sha256: str, content_mb: int | None = None, content_digest: str | None = None
) -> dict[str, Any]:
    """The host-side <id>.json: the image's own manifest plus what only exists after packing.
    `image` may still be the .partial file; the manifest names the final one. contentDigest
    (tools/buildcache.py digest) names the files, where sha256 names the bytes."""
    st = os.stat(image)
    manifest = {**base, "file": f"{base['id']}.ext4", "sha256": sha256, "bytes": st.st_size,
                "allocatedBytes": st.st_blocks * 512}
    if content_mb is not None:
        manifest["contentMb"] = content_mb
    if content_digest is not None:
        manifest["contentDigest"] = content_digest
    return manifest


# --------------------------------------------------------------------------- CLI


def _build_params(args: argparse.Namespace) -> dict[str, Any]:
    return {"suite": "noble", "arch": "amd64", "mirror": args.mirror, "headroomMb": args.headroom_mb}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="profiles.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--profiles", default=os.environ.get("KYORA_VMS_PROFILES"), help="more profile dirs (a:b)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_validate = sub.add_parser("validate")
    p_validate.add_argument("names", nargs="*")
    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("name")
    for cmd in ("id", "plan"):
        p = sub.add_parser(cmd)
        p.add_argument("name")
        p.add_argument("--no-pins", action="store_true", help="hash floating versions as written (offline)")
        p.add_argument("--salt", default="", help="extra hash input: a fresh id for the same profile")
        p.add_argument("--mirror", default=os.environ.get("MIRROR", "http://archive.ubuntu.com/ubuntu"))
        p.add_argument("--headroom-mb", type=int, default=int(os.environ.get("HEADROOM_MB", "512")))
        if cmd == "plan":
            p.add_argument("--out", required=True)
    p_extra = sub.add_parser("extra")
    p_extra.add_argument("name")
    p_manifest = sub.add_parser("manifest")
    p_manifest.add_argument("--base", required=True)
    p_manifest.add_argument("--image", required=True)
    p_manifest.add_argument("--sha256", required=True)
    p_manifest.add_argument("--content-mb", type=int)
    p_manifest.add_argument("--content-digest")
    p_manifest.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    dirs = search_dirs(args.profiles)
    load = dir_loader(dirs)
    try:
        if args.cmd == "list":
            for name in profile_names(dirs):
                print(f"{name:14} {load(name).get('description', '')}")
        elif args.cmd == "validate":
            names = args.names or profile_names(dirs)
            for name in names:
                resolve(name, load)
            print(f"profiles: {len(names)} valid ({', '.join(names)})")
        elif args.cmd == "resolve":
            print(json.dumps(resolve(args.name, load), indent=2))
        elif args.cmd in ("id", "plan"):
            overrides = {key: os.environ[key] for key in LEGACY_ENV if os.environ.get(key)}
            info = build_info(
                args.name, load, fetch=None if args.no_pins else http_fetch, pins={} if args.no_pins else None,
                build=_build_params(args), salt=args.salt, overrides=overrides,
            )
            if args.cmd == "id":
                print(info["id"])
            else:
                write_plan(info, args.out)
                print(info["id"])
        elif args.cmd == "extra":
            print(extra_script(resolve(args.name, load)), end="")
        elif args.cmd == "manifest":
            with open(args.base) as f:
                base = json.load(f)
            manifest = final_manifest(base, args.image, args.sha256, args.content_mb, args.content_digest)
            with open(args.out, "w") as f:
                f.write(json.dumps(manifest, indent=2) + "\n")
    except ProfileError as e:
        print(f"profiles: {e}", file=sys.stderr)
        return 1
    except OSError as e:  # network (pins) or files
        print(f"profiles: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
