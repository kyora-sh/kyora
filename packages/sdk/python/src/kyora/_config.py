"""Where the client goes and which token it sends, resolved as the kyora CLI does (packages/vms/cli/src/config.ts).

Explicit arguments win. Then the shell's environment, then ~/.config/kyora-vms/env, then a stored
`kyora vms login` in ~/.config/kyora/credentials.json for the URL's origin. Read-only: nothing is written.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_URL = "https://cloud.kyora.sh"
VMD_DEFAULT_URL = "https://vms.kyora.sh"
PLATFORM_TOKEN_PREFIX = "kyora_"
LOOPBACK = frozenset({"localhost", "127.0.0.1", "[::1]", "::1"})


@dataclass(frozen=True)
class Config:
    url: str
    token: str | None
    token_source: str | None
    url_source: str
    org: str | None = None


def config_base(env: Mapping[str, str]) -> Path:
    xdg = env.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg)
    return Path(env.get("HOME") or Path.home()) / ".config"


def parse_env_file(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("export ") or line.startswith("export\t"):
            line = line[6:].lstrip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq <= 0:
            continue
        value = line[eq + 1 :].strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        values[line[:eq].strip()] = value
    return values


def check_url(value: str, what: str) -> str:
    parts = urlsplit(value)
    if not parts.scheme or not parts.netloc:
        raise ValueError(f"{what} is not a URL")
    host = (parts.hostname or "").lower()
    if parts.scheme == "https" or (parts.scheme == "http" and (host in LOOPBACK or f"[{host}]" in LOOPBACK)):
        return value.rstrip("/")
    raise ValueError(f"{what} must be https:// (plain http only to localhost)")


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    default = {"https": 443, "http": 80}.get(parts.scheme)
    return f"{parts.scheme}://{host}{f':{port}' if port and port != default else ''}"


def read_text(path: Path) -> str | None:
    try:
        return path.read_text()
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return None


def stored_login(path: Path, origin: str, org: str | None) -> tuple[str, str | None] | None:
    """The token a stored login means: `org`'s (or the org in use), else the personal one."""
    try:
        parsed = json.loads(read_text(path) or "{}")
    except ValueError:
        return None
    login = parsed.get(origin) if isinstance(parsed, dict) else None
    if not isinstance(login, dict):
        return None
    orgs = login.get("orgs") if isinstance(login.get("orgs"), dict) else {}
    wanted = org if org is not None else login.get("use")
    entry = orgs.get(wanted) if isinstance(wanted, str) else None
    if isinstance(entry, dict) and isinstance(entry.get("token"), str) and entry["token"]:
        return entry["token"], entry.get("login") if isinstance(entry.get("login"), str) else wanted
    if org is not None:
        return None
    token = login.get("token")
    return (token, None) if isinstance(token, str) and token else None


def load_config(
    token: str | None = None,
    url: str | None = None,
    org: str | None = None,
    env: Mapping[str, str] | None = None,
) -> Config:
    env = os.environ if env is None else env
    base = config_base(env)
    file = base / "kyora-vms" / "env"
    from_file = parse_env_file(read_text(file) or "")

    def pick(name: str) -> tuple[str, str] | None:
        value = (env.get(name) or "").strip()
        if value:
            return value, f"${name}"
        value = from_file.get(name, "").strip()
        return (value, str(file)) if value else None

    def pick_env(name: str) -> tuple[str, str] | None:
        value = (env.get(name) or "").strip()
        return (value, f"${name}") if value else None

    def pick_file(name: str) -> tuple[str, str] | None:
        value = from_file.get(name, "").strip()
        return (value, str(file)) if value else None

    key: tuple[str, str] | None
    if token is not None:
        key = (token, "argument")
    elif org is not None:
        key = None
    else:
        key = (
            pick_env("KYORA_VMS_KEY")
            or pick_env("KYORA_TOKEN")
            or pick_file("KYORA_VMS_KEY")
            or pick_file("KYORA_TOKEN")
        )
    fallback = VMD_DEFAULT_URL if key and not key[0].startswith(PLATFORM_TOKEN_PREFIX) else DEFAULT_URL
    chosen_url = (url, "argument") if url is not None else pick("KYORA_VMS_URL") or (fallback, "default")
    resolved = check_url(chosen_url[0], f"KYORA_VMS_URL from {chosen_url[1]}")

    stored_org: str | None = None
    if key is None:
        credentials = base / "kyora" / "credentials.json"
        login = stored_login(credentials, origin_of(resolved), org)
        if login is not None:
            key = (login[0], str(credentials))
            stored_org = login[1]
        elif org is not None:
            raise ValueError(f"no stored login for the org {org} at {origin_of(resolved)} in {credentials}")
    return Config(
        url=resolved,
        token=key[0] if key else None,
        token_source=key[1] if key else None,
        url_source=chosen_url[1],
        org=stored_org,
    )
