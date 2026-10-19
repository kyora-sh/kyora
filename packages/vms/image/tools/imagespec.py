#!/usr/bin/env python3
"""kyora vms image specs: validate, canonicalize, hash and plan a user image build.

An image spec is the fleet profile format
of profiles.py with `base` in place of `extends`, `run` in place of `extra`, `files` with
inline content, and `npm` and `pip`. Toolchains take exact versions only: floating ones
come from the base. kyora-image-build applies a spec on top of its base inside the
builder VM; the Worker implements the same rules, and both are held to
tools/testdata/imagespec-vectors.json.

  imagespec.py validate SPEC [--base-manifest F]       the canonical spec, or the problems
  imagespec.py digest SPEC --base-digest sha256:...    the version digest

Python 3 stdlib only.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import posixpath
import re
import shlex
import stat
import sys
from typing import Any, NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import profiles  # noqa: E402

FORMAT = 1
SPEC_MAX_BYTES = 256 * 1024
FILES_MAX = 64
FILES_MAX_BYTES = 64 * 1024
RUN_MAX = 64
RUN_TIMEOUT_MAX = 24 * 3600
EGRESS_MAX = 32
SALT_MAX = 256
VENV = "/opt/venv"
CHUNK_SIZE = 4 * 1024 * 1024

KNOWN_KEYS = {
    "name", "description", "base", "apt", "npm", "pip", "uvTools", "cargo", "node", "bun", "uv", "python",
    "rustup", "files", "env", "caches", "run", "salt", "build",
}
FILE_KEYS = {"path", "content", "encoding", "mode"}
RUN_KEYS = {"run", "user", "timeoutSeconds"}
BUILD_KEYS = {"network", "egressAllow", "resources", "timeoutSeconds"}
RESOURCE_KEYS = {"vcpus", "memoryMb", "diskGb"}
RUN_USERS = ("root", "sandbox")
NETWORKS = ("none", "registries")
ENCODINGS = ("utf8", "base64")
# what goes into the digest; name, description, base (hashed as its digest) and build are not
CONTENT_KEYS = ("apt", "npm", "pip", "uvTools", "cargo", "python", "node", "bun", "uv", "rustup", "env", "caches")

IMAGE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
# ref = name [":" tag] | name "@sha256:" 64hex | "kyora/" name [":" tag | "@sha256:" 64hex]
REF_RE = re.compile(
    r"^(?:kyora/)?[a-z0-9][a-z0-9._-]{0,63}(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,63}|@sha256:[0-9a-f]{64})?$"
)
NPM_RE = re.compile(
    r"^((?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$"
)
# exact rust releases and dated channels; a bare channel or a minor floats
TOOLCHAIN_RE = re.compile(r"^(\d+\.\d+\.\d+|(?:stable|beta|nightly)-\d{4}-\d{2}-\d{2})$")
FILE_PATH_RE = re.compile(r"^(/[A-Za-z0-9._@+,:~=-]+)+$")
# never in the image: runtime mounts, and kyora-init binds /work and /tmp from the scratch disk
FORBIDDEN_ROOTS = ("/work", "/tmp", "/mnt", "/run", "/proc", "/sys", "/dev")
# what the build writes itself, and what boots the guest
KYORA_OWNED = ("/etc/kyora", "/etc/kyora-image.json", "/usr/sbin/kyora-init", "/usr/local/bin/kyora-vm-agent")
# merged /usr: a path through /sbin is the /usr/sbin path, and so on
USR_MERGED = (("/bin", "/usr/bin"), ("/sbin", "/usr/sbin"), ("/lib", "/usr/lib"), ("/lib32", "/usr/lib32"),
              ("/lib64", "/usr/lib64"), ("/libx32", "/usr/libx32"))
HOST_RE = re.compile(r"^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


class Problem(NamedTuple):
    field: str
    message: str
    code: str = "invalid_spec"


class SpecError(Exception):
    """A spec the builder refuses: `code` is invalid_spec or too_large, `field` names the first problem."""

    def __init__(self, problems: list[Problem]) -> None:
        self.problems = problems
        self.code = "too_large" if any(p.code == "too_large" for p in problems) else "invalid_spec"
        self.field = problems[0].field
        super().__init__("; ".join(f"{p.field}: {p.message}" for p in problems))


# --------------------------------------------------------------------------- validation


def canonical_json(obj: Any) -> bytes:
    return profiles.canonical_json(obj)


def _list(
    raw: dict[str, Any], key: str, pattern: re.Pattern[str], what: str, out: list[Problem], prefix: str = ""
) -> None:
    value = raw.get(key)
    if value is None:
        return
    if not isinstance(value, list):
        out.append(Problem(f"{prefix}{key}", "must be a list of strings"))
        return
    for i, item in enumerate(value):
        if not isinstance(item, str) or not pattern.fullmatch(item):
            out.append(Problem(f"{prefix}{key}[{i}]", f"must be {what}: {item!r}"))


def _exact_tool(raw: dict[str, Any], key: str, out: list[Problem]) -> None:
    if key not in raw:
        return
    value = raw[key]
    if not (isinstance(value, str) and profiles.VERSION_RE.fullmatch(value)):
        out.append(Problem(key, f'must be an exact version like "1.2.3" (floating versions come from the base): {value!r}'))


def file_path_problem(path: Any) -> str | None:
    """Why a `files` path is refused, or None."""
    if not (isinstance(path, str) and FILE_PATH_RE.fullmatch(path) and posixpath.normpath(path) == path):
        return f"must be a normalized absolute path of [A-Za-z0-9._@+,:~=-] parts: {path!r}"
    real = path
    for alias, target in USR_MERGED:
        if path == alias or path.startswith(alias + "/"):
            real = target + path[len(alias):]
    for root in FORBIDDEN_ROOTS:
        if real == root or real.startswith(root + "/"):
            return f"{path!r} is under {root}, which is not part of the image"
    for owned in KYORA_OWNED:
        if real == owned or real.startswith(owned + "/"):
            return f"{path!r} is kyora's own ({owned})"
    return None


def _file_bytes(entry: dict[str, Any]) -> bytes | None:
    content, encoding = entry.get("content"), entry.get("encoding", "utf8")
    if not isinstance(content, str) or encoding not in ENCODINGS:
        return None
    if encoding == "utf8":
        try:
            return content.encode("utf-8")
        except UnicodeEncodeError:
            return None
    try:
        return base64.b64decode(content, validate=True)
    except (binascii.Error, ValueError):
        return None


def _files(raw: dict[str, Any], out: list[Problem]) -> None:
    files = raw.get("files")
    if files is None:
        return
    if not isinstance(files, list):
        out.append(Problem("files", "must be a list"))
        return
    if len(files) > FILES_MAX:
        out.append(Problem("files", f"at most {FILES_MAX} files", "too_large"))
    total = 0
    paths: dict[str, int] = {}
    for i, entry in enumerate(files):
        where = f"files[{i}]"
        if not isinstance(entry, dict):
            out.append(Problem(where, "must be an object {path, content, encoding, mode}"))
            continue
        for key in sorted(set(entry) - FILE_KEYS):
            out.append(Problem(f"{where}.{key}", "unknown key"))
        problem = file_path_problem(entry.get("path"))
        if problem:
            out.append(Problem(f"{where}.path", problem))
        else:
            path = entry["path"]
            if path in paths:
                out.append(Problem(f"{where}.path", f"duplicate path {path!r}"))
            for other in paths:
                if other.startswith(path + "/") or path.startswith(other + "/"):
                    out.append(Problem(f"{where}.path", f"{path!r} and {other!r} can't both be files"))
            paths[path] = i
        mode = entry.get("mode", profiles.DEFAULT_FILE_MODE)
        if not (isinstance(mode, str) and profiles.FILE_MODE_RE.fullmatch(mode)):
            out.append(Problem(f"{where}.mode", f'must be an octal string like "0644" or "0755", without setuid: {mode!r}'))
        if entry.get("encoding", "utf8") not in ENCODINGS:
            out.append(Problem(f"{where}.encoding", f"must be one of {', '.join(ENCODINGS)}: {entry.get('encoding')!r}"))
            continue
        data = _file_bytes(entry)
        if data is None:
            out.append(Problem(f"{where}.content", f"must be a string in its encoding ({entry.get('encoding', 'utf8')})"))
            continue
        total += len(data)
    if total > FILES_MAX_BYTES:
        out.append(Problem("files", f"at most {FILES_MAX_BYTES // 1024} KiB of content in all (got {total} bytes)", "too_large"))


def _run(raw: dict[str, Any], out: list[Problem]) -> None:
    steps = raw.get("run")
    if steps is None:
        return
    if not isinstance(steps, list):
        out.append(Problem("run", "must be a list of steps"))
        return
    if len(steps) > RUN_MAX:
        out.append(Problem("run", f"at most {RUN_MAX} steps"))
    for i, step in enumerate(steps):
        where = f"run[{i}]"
        if isinstance(step, dict):
            for key in sorted(set(step) - RUN_KEYS):
                out.append(Problem(f"{where}.{key}", "unknown key"))
            command = step.get("run")
            if step.get("user", "root") not in RUN_USERS:
                out.append(Problem(f"{where}.user", f"must be one of {', '.join(RUN_USERS)}: {step.get('user')!r}"))
            timeout = step.get("timeoutSeconds")
            if timeout is not None and not (
                isinstance(timeout, int) and not isinstance(timeout, bool) and 1 <= timeout <= RUN_TIMEOUT_MAX
            ):
                out.append(Problem(f"{where}.timeoutSeconds", f"must be a whole number of seconds, 1-{RUN_TIMEOUT_MAX}"))
            where = f"{where}.run"
        else:
            command = step
        if not isinstance(command, str) or not command.strip():
            out.append(Problem(where, "must be a non-empty shell command"))
        elif "\x00" in command:
            out.append(Problem(where, "must not contain NUL"))


def _build(raw: dict[str, Any], out: list[Problem]) -> None:
    build = raw.get("build")
    if build is None:
        return
    if not isinstance(build, dict):
        out.append(Problem("build", "must be an object"))
        return
    for key in sorted(set(build) - BUILD_KEYS):
        out.append(Problem(f"build.{key}", "unknown key"))
    if "network" in build and build["network"] not in NETWORKS:
        out.append(Problem("build.network", f"must be one of {', '.join(NETWORKS)}: {build['network']!r}"))
    hosts = build.get("egressAllow")
    if hosts is not None:
        if not isinstance(hosts, list) or len(hosts) > EGRESS_MAX:
            out.append(Problem("build.egressAllow", f"must be a list of at most {EGRESS_MAX} hostnames"))
        else:
            for i, host in enumerate(hosts):
                if not (isinstance(host, str) and len(host) <= 253 and HOST_RE.fullmatch(host.lower())):
                    out.append(Problem(f"build.egressAllow[{i}]", f"must be a hostname or *.suffix: {host!r}"))
    resources = build.get("resources")
    if resources is not None:
        if not isinstance(resources, dict):
            out.append(Problem("build.resources", "must be an object {vcpus, memoryMb, diskGb}"))
        else:
            for key in sorted(set(resources) - RESOURCE_KEYS):
                out.append(Problem(f"build.resources.{key}", "unknown key"))
            for key in sorted(RESOURCE_KEYS & set(resources)):
                value = resources[key]
                if not (isinstance(value, int) and not isinstance(value, bool) and value >= 1):
                    out.append(Problem(f"build.resources.{key}", f"must be a positive whole number: {value!r}"))
    timeout = build.get("timeoutSeconds")
    if timeout is not None and not (isinstance(timeout, int) and not isinstance(timeout, bool) and 1 <= timeout <= RUN_TIMEOUT_MAX):
        out.append(Problem("build.timeoutSeconds", f"must be a whole number of seconds, 1-{RUN_TIMEOUT_MAX}"))


def _rustup(raw: dict[str, Any], out: list[Problem]) -> None:
    if "rustup" not in raw:
        return
    rustup = raw["rustup"]
    if not isinstance(rustup, dict):
        out.append(Problem("rustup", "must be an object {toolchains, default, targets, components}"))
        return
    for key in sorted(set(rustup) - profiles.RUSTUP_KEYS):
        out.append(Problem(f"rustup.{key}", "unknown key"))
    toolchains = rustup.get("toolchains")
    if not isinstance(toolchains, list) or not toolchains:
        out.append(Problem("rustup.toolchains", "must list at least one toolchain"))
    else:
        exact = 'an exact release ("1.90.0") or a dated channel ("nightly-2026-09-01"); channels float'
        _list(rustup, "toolchains", TOOLCHAIN_RE, exact, out, "rustup.")
    _list(rustup, "targets", profiles.TARGET_RE, "a target triple", out, "rustup.")
    _list(rustup, "components", profiles.COMPONENT_RE, "a component name", out, "rustup.")
    default = rustup.get("default")
    if default is not None and not (isinstance(default, str) and TOOLCHAIN_RE.fullmatch(default)):
        out.append(Problem("rustup.default", f"must be an exact release or a dated channel: {default!r}"))


def _duplicates(raw: dict[str, Any], key: str, name: Any, out: list[Problem]) -> None:
    """Two entries for one package that disagree (an exact repeat is just deduplicated)."""
    value = raw.get(key)
    if not isinstance(value, list):
        return
    seen: dict[str, str] = {}
    for i, item in enumerate(value):
        if not isinstance(item, str):
            continue
        k = name(item)
        if k in seen and seen[k] != item:
            out.append(Problem(f"{key}[{i}]", f"{item!r} conflicts with {seen[k]!r}"))
        seen.setdefault(k, item)


def npm_name(spec: str) -> str:
    return spec.rsplit("@", 1)[0]


def validate(raw: Any) -> list[Problem]:
    """Every problem with a spec on its own (the base is checked by check_dependencies)."""
    if not isinstance(raw, dict):
        return [Problem("spec", "must be a JSON object")]
    out: list[Problem] = []
    if len(canonical_json(raw)) > SPEC_MAX_BYTES:
        out.append(Problem("spec", f"at most {SPEC_MAX_BYTES // 1024} KiB", "too_large"))
    for key in sorted(set(raw) - KNOWN_KEYS):
        hint = {"extends": "base", "extra": "run"}.get(key)
        out.append(Problem(key, "unknown key" + (f" (a spec says {hint!r})" if hint else "")))
    if "name" in raw and not (isinstance(raw["name"], str) and IMAGE_NAME_RE.fullmatch(raw["name"])):
        out.append(Problem("name", f"must be [a-z0-9][a-z0-9._-]{{0,63}}: {raw['name']!r}"))
    if "description" in raw and not isinstance(raw["description"], str):
        out.append(Problem("description", "must be a string"))
    base = raw.get("base")
    if not (isinstance(base, str) and REF_RE.fullmatch(base)):
        out.append(Problem("base", f"must be an image ref (kyora/<profile>, name[:tag] or name@sha256:...): {base!r}"))
    _list(raw, "apt", profiles.APT_RE, "a package name, or name=version", out)
    _list(raw, "npm", NPM_RE, "name@x.y.z (an exact version)", out)
    _list(raw, "pip", profiles.UV_TOOL_RE, "name==x.y.z (an exact version)", out)
    _list(raw, "uvTools", profiles.UV_TOOL_RE, "name==x.y.z (an exact version)", out)
    _list(raw, "cargo", profiles.CRATE_RE, "crate@x.y.z (an exact version)", out)
    _list(raw, "python", profiles.PYTHON_RE, 'a CPython version like "3.13" or "3.13.1"', out)
    _duplicates(raw, "apt", profiles._apt_name, out)
    _duplicates(raw, "npm", npm_name, out)
    _duplicates(raw, "pip", profiles._uv_tool_name, out)
    _duplicates(raw, "uvTools", profiles._uv_tool_name, out)
    _duplicates(raw, "cargo", profiles._crate_name, out)
    for key in ("node", "bun", "uv"):
        _exact_tool(raw, key, out)
    _rustup(raw, out)
    env = raw.get("env")
    if env is not None:
        if not isinstance(env, dict):
            out.append(Problem("env", "must be an object"))
        else:
            for key, value in env.items():
                if not profiles.ENV_KEY_RE.fullmatch(key):
                    out.append(Problem(f"env.{key}", "invalid variable name"))
                elif value is not None and not (isinstance(value, str) and profiles.ENV_VALUE_RE.fullmatch(value)):
                    out.append(Problem(f"env.{key}", f"values are plain words (no spaces, quotes or $) or null: {value!r}"))
    caches = raw.get("caches")
    if caches is not None:
        if not isinstance(caches, list):
            out.append(Problem("caches", "must be a list"))
        else:
            names: set[str] = set()
            for i, cache in enumerate(caches):
                out.extend(Problem(f"caches[{i}]", e) for e in profiles._cache_errors(cache))
                # profiles.py's patterns end in $, which lets a trailing newline through
                if isinstance(cache, dict) and any(isinstance(v, str) and ("\n" in v or "\r" in v) for v in cache.values()):
                    out.append(Problem(f"caches[{i}]", "no newlines"))
                if isinstance(cache, dict) and isinstance(cache.get("name"), str):
                    if cache["name"] in names:
                        out.append(Problem(f"caches[{i}]", f"duplicate name {cache['name']!r}"))
                    names.add(cache["name"])
    _files(raw, out)
    _run(raw, out)
    if "salt" in raw and not (isinstance(raw["salt"], str) and len(raw["salt"]) <= SALT_MAX and "\x00" not in raw["salt"]):
        out.append(Problem("salt", f"must be a string of at most {SALT_MAX} characters"))
    _build(raw, out)
    return out


# --------------------------------------------------------------------------- canonical form and digest


def _sorted_unique(items: list[str], key: Any) -> list[str]:
    return sorted(dict.fromkeys(items), key=lambda s: (key(s), s))


def _python_key(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in version.split("."))


def resolve(raw: Any) -> dict[str, Any]:
    """The spec validated and fully spelled out: lists sorted and deduplicated, files with the
    sha256 of their bytes, run steps as {run, user, timeoutSeconds}. Raises SpecError."""
    problems = validate(raw)
    if problems:
        raise SpecError(problems)
    rustup = None
    if "rustup" in raw:
        r = raw["rustup"]
        toolchains = list(dict.fromkeys(r["toolchains"]))
        default = r.get("default") or toolchains[0]
        rest = sorted(t for t in toolchains if t != default)
        rustup = {
            "default": default,
            "toolchains": [default, *rest],
            "targets": sorted(set(r.get("targets", []))),
            "components": sorted(set(r.get("components", []))),
        }
    files = []
    for entry in raw.get("files") or []:
        data = _file_bytes(entry)
        assert data is not None
        files.append({
            "path": entry["path"],
            "mode": entry.get("mode", profiles.DEFAULT_FILE_MODE),
            "sha256": hashlib.sha256(data).hexdigest(),
            "content": base64.b64encode(data).decode(),
        })
    steps = []
    for step in raw.get("run") or []:
        if isinstance(step, str):
            step = {"run": step}
        steps.append({"run": step["run"], "user": step.get("user", "root"), "timeoutSeconds": step.get("timeoutSeconds")})
    return {
        "name": raw.get("name"),
        "description": raw.get("description", ""),
        "base": raw["base"],
        "apt": _sorted_unique(raw.get("apt", []), profiles._apt_name),
        "npm": _sorted_unique(raw.get("npm", []), npm_name),
        "pip": _sorted_unique(raw.get("pip", []), profiles._uv_tool_name),
        "uvTools": _sorted_unique(raw.get("uvTools", []), profiles._uv_tool_name),
        "cargo": _sorted_unique(raw.get("cargo", []), profiles._crate_name),
        "python": sorted(set(raw.get("python", [])), key=_python_key),
        "node": raw["node"].removeprefix("v") if "node" in raw else None,
        "bun": raw["bun"].removeprefix("v") if "bun" in raw else None,
        "uv": raw["uv"].removeprefix("v") if "uv" in raw else None,
        "rustup": rustup,
        "files": sorted(files, key=lambda f: f["path"]),
        "env": dict(sorted((raw.get("env") or {}).items())),
        "caches": sorted(({k: c[k] for k in ("name", "path", "scope")} for c in raw.get("caches") or []),
                         key=lambda c: c["name"]),
        "run": steps,
        "salt": raw.get("salt") or None,
        "build": raw.get("build") or {},
    }


def content(spec: dict[str, Any]) -> dict[str, Any]:
    """What a version is made of, from a resolved spec: no name, description, base or build,
    files as {path, mode, sha256}, run steps as {run, user}, salt only when set."""
    doc: dict[str, Any] = {key: spec[key] for key in CONTENT_KEYS}
    doc["files"] = [{"path": f["path"], "mode": f["mode"], "sha256": f["sha256"]} for f in spec["files"]]
    doc["run"] = [{"run": s["run"], "user": s["user"]} for s in spec["run"]]
    if spec["salt"]:
        doc["salt"] = spec["salt"]
    return doc


def digest(spec: dict[str, Any], base_digest: str) -> str:
    """The version digest: sha256 over the canonical {format, base, spec}."""
    if not DIGEST_RE.fullmatch(base_digest):
        raise SpecError([Problem("base", f"the base digest must be sha256:<64 hex>: {base_digest!r}")])
    doc = {"format": FORMAT, "base": base_digest, "spec": content(spec)}
    return "sha256:" + hashlib.sha256(canonical_json(doc)).hexdigest()


# --------------------------------------------------------------------------- the base


def base_profile(manifest: dict[str, Any]) -> dict[str, Any]:
    """The resolved profile of a base, from its /etc/kyora-image.json: an image built from a
    spec records its own (image.resolved), a fleet build the profile's (resolved)."""
    image = manifest.get("image")
    resolved = image.get("resolved") if isinstance(image, dict) else None
    if not isinstance(resolved, dict):
        resolved = manifest.get("resolved")
    if not isinstance(resolved, dict):
        raise SpecError([Problem("base", "the base's /etc/kyora-image.json has no resolved profile (not a kyora image?)")])
    acc = {**profiles.empty_profile(), "npm": [], "pip": []}
    for key in acc:
        if key in resolved:
            acc[key] = resolved[key]
    return acc


def effective(base: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """The base's resolved profile with the spec laid over it (profiles.py's merge rules):
    what the new image has, recorded as image.resolved for images built on it."""
    layer: dict[str, Any] = {key: spec[key] for key in ("apt", "cargo", "python", "uvTools", "env", "caches")}
    for key in ("node", "bun", "uv", "rustup"):
        if spec[key] is not None:
            layer[key] = spec[key]
    out = profiles.merge(base, layer)
    out["npm"] = profiles._union(base.get("npm", []), spec["npm"], npm_name)
    out["pip"] = profiles._union(base.get("pip", []), spec["pip"], profiles._uv_tool_name)
    return out


def check_dependencies(spec: dict[str, Any], base: dict[str, Any]) -> list[Problem]:
    """What a spec needs from its base (or sets itself): npm needs node, pip, uvTools and
    python need uv, cargo needs rustup. Then the merged caches."""
    out: list[Problem] = []
    merged = effective(base, spec)
    if spec["npm"] and merged["node"] is None:
        out.append(Problem("npm", "npm packages need node: the base has none, so set node"))
    for key in ("pip", "uvTools", "python"):
        if spec[key] and merged["uv"] is None:
            out.append(Problem(key, f"{key} needs uv: the base has none, so set uv"))
    if spec["cargo"] and merged["rustup"] is None:
        out.append(Problem("cargo", "cargo crates need rustup: the base has none, so set rustup"))
    caches = merged["caches"]
    if len(caches) > profiles.MAX_CACHES:
        out.append(Problem("caches", f"at most {profiles.MAX_CACHES} caches with the base's"))
    for i, a in enumerate(caches):
        for b in caches[i + 1:]:
            if profiles._overlaps(a["path"], b["path"]):
                out.append(Problem("caches", f"caches {a['name']} and {b['name']} overlap: {a['path']}, {b['path']}"))
    return out


# --------------------------------------------------------------------------- /etc/kyora


def parse_env(text: str) -> dict[str, str]:
    """/etc/kyora/env as kyora-init reads it: KEY=VALUE lines, '#' comments, the last one wins."""
    env: dict[str, str] = {}
    for raw in text.splitlines():
        key = _env_key(raw)
        if key is not None:
            env[key] = raw.strip().partition("=")[2]
    return env


def _env_key(line: str) -> str | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    key, sep, _ = line.partition("=")
    return key if sep and key.replace("_", "a").isalnum() and not key[0].isdigit() else None


def image_env_updates(spec: dict[str, Any], base_env: dict[str, str]) -> dict[str, str | None]:
    """What the spec changes in /etc/kyora/env: its env, UV_PYTHON_INSTALL_DIR with python
    versions (as for profiles), and the venv first on PATH with pip."""
    updates: dict[str, str | None] = dict(spec["env"])
    if spec["python"]:
        updates.setdefault("UV_PYTHON_INSTALL_DIR", profiles.UV_PYTHON_DIR)
    if spec["pip"]:
        updates["VIRTUAL_ENV"] = VENV
        path = updates.get("PATH") or base_env.get("PATH") or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        if f"{VENV}/bin" not in path.split(":"):
            path = f"{VENV}/bin:{path}"
        updates["PATH"] = path
    return updates


def merge_env(base_text: str, updates: dict[str, str | None]) -> str:
    """The base's /etc/kyora/env with the updates applied in place: a changed key keeps its
    line, null drops it, new keys follow at the end. Unchanged text when there is nothing to do."""
    if not updates:
        return base_text
    lines: list[str] = []
    seen: set[str] = set()
    for raw in base_text.splitlines():
        key = _env_key(raw)
        if key is None or key not in updates:
            lines.append(raw)
            continue
        if key in seen:
            continue  # a later line for a key the spec sets: the spec's value is the one
        seen.add(key)
        if updates[key] is not None:
            lines.append(f"{key}={updates[key]}")
    added = [key for key in sorted(updates) if key not in seen and updates[key] is not None]
    if added:
        lines += ["", "# image spec"] + [f"{key}={updates[key]}" for key in added]
    return "\n".join(lines) + "\n"


def merge_caches(base_text: str, spec: dict[str, Any]) -> str:
    """The base's /etc/kyora/caches.json with the spec's caches (by name, the spec's wins)."""
    if not spec["caches"]:
        return base_text
    try:
        caches = {c["name"]: c for c in json.loads(base_text or "{}").get("caches", [])}
    except (ValueError, AttributeError, TypeError, KeyError):
        caches = {}
    for cache in spec["caches"]:
        caches[cache["name"]] = cache
    return json.dumps({"caches": sorted(caches.values(), key=lambda c: c["name"])}, indent=2) + "\n"


# --------------------------------------------------------------------------- reading the base safely


def read_in_root(root: str, path: str, limit: int = 16 * 1024 * 1024) -> bytes | None:
    """A regular file of the tree at `root`, never through a symlink (the base is the
    account's own bytes). None when it is missing or not a plain file."""
    parts = [p for p in path.strip("/").split("/") if p]
    current = root
    for part in parts[:-1]:
        current = os.path.join(current, part)
        try:
            if not stat.S_ISDIR(os.lstat(current).st_mode):
                return None
        except OSError:
            return None
    try:
        fd = os.open(os.path.join(current, parts[-1]), os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        chunks = []
        size = 0
        while chunk := os.read(fd, 1 << 20):
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


# --------------------------------------------------------------------------- the plan


def phases(spec: dict[str, Any]) -> list[tuple[str, int | None]]:
    """The chroot-install.sh delta phases a spec needs, in order: (phase, run step or None)."""
    out: list[tuple[str, int | None]] = []
    for phase, needed in (
        ("apt", spec["apt"]), ("rustup", spec["rustup"]), ("cargo", spec["cargo"]), ("node", spec["node"]),
        ("bun", spec["bun"]), ("uv", spec["uv"]), ("python", spec["python"]), ("npm", spec["npm"]),
        ("pip", spec["pip"]), ("uvTools", spec["uvTools"]), ("files", spec["files"]),
    ):
        if needed:
            out.append((phase, None))
    out += [("run", i) for i in range(1, len(spec["run"]) + 1)]
    return out + [("config", None), ("manifest", None), ("strip", None)]


def plan_env(spec: dict[str, Any], image_id: str) -> str:
    rustup = spec["rustup"] or {"default": "", "toolchains": [], "targets": [], "components": []}
    values = {
        "BUILD_MODE": "delta",
        "IMAGE_ID": image_id,
        "APT_PACKAGES": " ".join(spec["apt"]),
        "RUST_DEFAULT": rustup["default"],
        "RUST_TOOLCHAINS": " ".join(rustup["toolchains"]),
        "RUST_TARGETS": " ".join(rustup["targets"]),
        "RUST_COMPONENTS": " ".join(rustup["components"]),
        "RUST_RESOLVED": "",
        "CARGO_CRATES": " ".join(spec["cargo"]),
        "NODE_SPEC": spec["node"] or "",
        "BUN_SPEC": spec["bun"] or "",
        "UV_SPEC": spec["uv"] or "",
        "PYTHON_VERSIONS": " ".join(spec["python"]),
        "UV_TOOLS": " ".join(spec["uvTools"]),
        "NPM_PACKAGES": " ".join(spec["npm"]),
        "PIP_PACKAGES": " ".join(spec["pip"]),
        "VENV": VENV if spec["pip"] else "",
        "RUN_USERS": " ".join(s["user"] for s in spec["run"]),
    }
    return "".join(f"{key}={shlex.quote(value)}\n" for key, value in values.items())


def write_plan(
    out_dir: str,
    spec: dict[str, Any],
    *,
    name: str,
    version: str,
    base_ref: str,
    base_digest: str,
    base_manifest: bytes,
    base_env: str,
    base_caches: str,
    built_at: str,
) -> dict[str, str]:
    """The plan chroot-install.sh reads in delta mode, under `out_dir` (/tmp/kyora-build in
    the chroot). Returns the /etc/kyora files it plans, by name, for the build's own check."""
    manifest = json.loads(base_manifest)
    base = base_profile(manifest)
    kyora = {
        "env": merge_env(base_env, image_env_updates(spec, parse_env(base_env))),
        "caches.json": merge_caches(base_caches, spec),
    }
    image = {
        "name": name,
        "digest": version,
        "base": {"ref": base_ref, "digest": base_digest, "id": manifest.get("id")},
        "builtAt": built_at,
        "resolved": effective(base, spec),
    }
    run_env = {k: v for k, v in spec["env"].items() if v is not None}
    texts = {
        "plan.env": plan_env(spec, f"{name}@{version}"),
        "env": "".join(f"{k}={v}\n" for k, v in run_env.items()),
        "files.list": "".join(f"{f['mode']} {f['sha256']} {i} {f['path']}\n" for i, f in enumerate(spec["files"])),
        "image.json": json.dumps(image, indent=2) + "\n",
        "spec.json": json.dumps(spec, indent=2) + "\n",
    }
    os.makedirs(os.path.join(out_dir, "kyora"), exist_ok=True)
    for filename, text in texts.items():
        with open(os.path.join(out_dir, filename), "w") as f:
            f.write(text)
    for filename, text in kyora.items():
        with open(os.path.join(out_dir, "kyora", filename), "w") as f:
            f.write(text)
    with open(os.path.join(out_dir, "base-manifest.json"), "wb") as f:
        f.write(base_manifest)
    if spec["files"]:
        os.makedirs(os.path.join(out_dir, "files"), exist_ok=True)
    for i, entry in enumerate(spec["files"]):
        with open(os.path.join(out_dir, "files", str(i)), "wb") as f:
            f.write(base64.b64decode(entry["content"]))
    os.makedirs(os.path.join(out_dir, "run"), exist_ok=True)
    for i, step in enumerate(spec["run"], start=1):
        with open(os.path.join(out_dir, "run", f"{i}.sh"), "w") as f:
            f.write(step["run"] + "\n")
    return kyora


# --------------------------------------------------------------------------- rootfs digest


def rootfs_digest(path: str, length: int, chunk_size: int = CHUNK_SIZE) -> dict[str, Any]:
    """What vmd computes for a published rootfs: the
    sha256 of every chunk of the first `length` bytes, all-zero chunks recorded as absent,
    and sha256 over the canonical {format, chunkSize, bytes, chunks}."""
    chunks: list[list[Any]] = []
    zero = bytes(chunk_size)
    with open(path, "rb") as f:
        index = 0
        remaining = length
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                raise OSError(f"{path} ends before {length} bytes")
            if data != zero[: len(data)]:
                chunks.append([index, hashlib.sha256(data).hexdigest()])
            remaining -= len(data)
            index += 1
    doc = {"format": FORMAT, "chunkSize": chunk_size, "bytes": length, "chunks": chunks}
    return {
        "digest": "sha256:" + hashlib.sha256(canonical_json(doc)).hexdigest(),
        "bytes": length,
        "dataBytes": sum(min(chunk_size, length - i * chunk_size) for i, _ in chunks),
        "chunks": len(chunks),
    }


# --------------------------------------------------------------------------- CLI


def load(path: str) -> Any:
    with open(path, "rb") as f:
        data = f.read(SPEC_MAX_BYTES + 1)
    if len(data) > SPEC_MAX_BYTES:
        raise SpecError([Problem("spec", f"at most {SPEC_MAX_BYTES // 1024} KiB", "too_large")])
    try:
        return json.loads(data)
    except ValueError as e:
        raise SpecError([Problem("spec", f"not valid JSON: {e}")]) from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="imagespec.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_validate = sub.add_parser("validate")
    p_validate.add_argument("spec")
    p_validate.add_argument("--base-manifest", help="the base's /etc/kyora-image.json, for the dependency checks")
    p_digest = sub.add_parser("digest")
    p_digest.add_argument("spec")
    p_digest.add_argument("--base-digest", required=True)
    args = parser.parse_args(argv)
    try:
        spec = resolve(load(args.spec))
        if args.cmd == "validate":
            if args.base_manifest:
                with open(args.base_manifest) as f:
                    problems = check_dependencies(spec, base_profile(json.load(f)))
                if problems:
                    raise SpecError(problems)
            print(json.dumps(spec, indent=2))
        else:
            print(digest(spec, args.base_digest))
    except SpecError as e:
        print(json.dumps({"error": {"code": e.code, "field": e.field, "message": str(e)}}), file=sys.stderr)
        return 2
    except (OSError, ValueError) as e:
        print(f"imagespec: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
