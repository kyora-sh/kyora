"""Tar archives to send files into a sandbox and to read the ones it sends back."""

from __future__ import annotations

import io
import re
import tarfile
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal

BLOCK = 512
GUEST_UID = 1000
"""the uid of the guest's `sandbox` user, so the files are its own"""

EntryType = Literal["file", "dir", "symlink", "hardlink", "other"]


@dataclass
class TarEntry:
    name: str
    """the name as the archive has it"""
    type: EntryType
    mode: int
    size: int
    mtime: int
    """unix seconds"""
    linkname: str
    data: bytes = b""
    """a regular file's bytes; empty for anything else"""


@dataclass
class FileInput:
    path: str
    """relative to the upload's destination; parent directories are created"""
    data: str | bytes
    mode: int = 0o644


FileInputs = Iterable[FileInput] | Mapping[str, str | bytes]


def relative(path: str) -> str:
    """a clean relative path, or a ValueError for one that leaves its root"""
    parts: list[str] = []
    for part in path.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError(f"{path}: a path may not leave the destination")
        parts.append(part)
    if not parts:
        raise ValueError(f"{path!r} names no file")
    return "/".join(parts)


def _info(name: str, kind: bytes, mode: int, size: int, mtime: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = mode & 0o7777
    info.size = size
    info.mtime = mtime
    info.uid = info.gid = GUEST_UID
    info.uname = info.gname = ""
    return info


def pack_files(files: FileInputs) -> bytes:
    """a tar of `files`, with an entry for every parent directory"""
    items = [FileInput(path, data) for path, data in files.items()] if isinstance(files, Mapping) else list(files)
    mtime = int(time.time())
    out = io.BytesIO()
    dirs: set[str] = set()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for item in items:
            name = relative(item.path)
            parts = name.split("/")
            for i in range(1, len(parts)):
                folder = "/".join(parts[:i])
                if folder in dirs:
                    continue
                dirs.add(folder)
                archive.addfile(_info(folder + "/", tarfile.DIRTYPE, 0o755, 0, mtime))
            data = item.data.encode() if isinstance(item.data, str) else bytes(item.data)
            archive.addfile(_info(name, tarfile.REGTYPE, item.mode, len(data), mtime), io.BytesIO(data))
    return out.getvalue()


TYPES: dict[bytes, EntryType] = {
    tarfile.REGTYPE: "file",
    tarfile.AREGTYPE: "file",
    tarfile.CONTTYPE: "file",
    tarfile.LNKTYPE: "hardlink",
    tarfile.SYMTYPE: "symlink",
    tarfile.DIRTYPE: "dir",
}
LEADING_DOTS = re.compile(r"^(\./)+")


def unpack(archive: bytes) -> list[TarEntry]:
    """the entries of a whole archive in memory; a truncated or broken one is a ValueError"""
    entries: list[TarEntry] = []
    if len(archive) >= BLOCK and not any(archive[:BLOCK]):
        return entries
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as reader:
            for member in reader:
                kind = TYPES.get(member.type, "other")
                data = b""
                if kind == "file":
                    source = reader.extractfile(member)
                    data = source.read() if source else b""
                    if len(data) != member.size:
                        raise ValueError("the archive is truncated")
                entries.append(
                    TarEntry(
                        name=LEADING_DOTS.sub("", member.name),
                        type=kind,
                        mode=member.mode,
                        size=member.size,
                        mtime=int(member.mtime),
                        linkname=member.linkname,
                        data=data,
                    )
                )
            end = reader.offset
    except tarfile.TarError as error:
        raise ValueError(f"not a tar archive ({error})") from None
    if len(archive) < end + BLOCK or any(archive[end : end + BLOCK]):
        raise ValueError("the archive is truncated: it ends without its end-of-archive marker")
    return entries
