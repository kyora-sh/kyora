from __future__ import annotations

import asyncio
import inspect
import math
import os
import time
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import IO, Any, Literal, TypeVar

import httpx
from pydantic import BaseModel, ValidationError
from typing_extensions import Unpack

from ._errors import KyoraError, make_error
from ._exec import Exec
from ._http import (
    CLEANUP_TIMEOUT,
    DEFAULT_BASE_URL,
    DEFAULT_RETRY,
    USER_AGENT,
    CallOptions,
    RequestParts,
    Retry,
    Transport,
    WaitOptions,
    caller_key,
    end_of,
    left,
    read_json,
    timeout_error,
)
from ._models import (
    Bucket,
    BucketCors,
    BucketList,
    CreateBucketRequest,
    CreateSandboxRequest,
    CreateSnapshotRequest,
    CreateStorageKeyRequest,
    CreateStorageKeyResponse,
    CreateTokenRequest,
    CreateTokenResponse,
    CreateUploadResponse,
    DeleteBucketProgress,
    DeleteBucketResponse,
    Event,
    ExposePortRequest,
    Health,
    HeldPortList,
    LoginResponse,
    Me,
    MultipartStartResponse,
    NetworkUpdateRequest,
    NetworkUpdateResponse,
    Object,
    ObjectList,
    Port,
    PortList,
    PortWithSandbox,
    PresignRequest,
    PresignResponse,
    PushFilesResponse,
    PutObjectResponse,
    PutPartResponse,
    QueueTicket,
    RegionList,
    ResolveResponse,
    RevokeStorageKeyResponse,
    Sandbox,
    SandboxList,
    SandboxStats,
    SetRegionResponse,
    Snapshot,
    SnapshotList,
    StorageAudit,
    StorageKey,
    StorageKeyList,
    Token,
    TokenList,
    UpdateSandboxRequest,
    UploadPartResponse,
    Usage,
)
from ._operations import OPERATIONS
from ._paging import ListOptions, ListPage, follow, label_query, matching
from ._tar import FileInputs, TarEntry, pack_files, unpack

M = TypeVar("M", bound=BaseModel)

CREATE_TIMEOUT = 120.0
QUEUE_POLL = 25
QUEUE_GRACE = 60.0
QUEUE_RETRIES = 8
"""failed polls in a row before the wait in line gives up"""
POLL_TIMEOUT = 3600.0
SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024
"""an archive up to this size goes up in one PUT; a larger one in parts"""
TRANSFER_TIMEOUT = 600.0
"""one request per part of a large upload may take this long"""
MIN_PART_BYTES = 64 * 1024
MAX_PART_BYTES = 256 * 1024 * 1024

Archive = bytes | bytearray | memoryview | IO[bytes] | Iterable[bytes] | AsyncIterable[bytes]


def dump(model: type[BaseModel], value: BaseModel | Mapping[str, Any] | None) -> dict[str, Any]:
    """a request body as the wire has it: only the fields set, by their wire names"""
    if value is None:
        return {}
    if not isinstance(value, BaseModel):
        value = model.model_validate(dict(value))
    return value.model_dump(mode="json", by_alias=True, exclude_unset=True)


def load(model: type[M], data: Any, operation: str) -> M:
    try:
        return model.model_validate(data)
    except ValidationError as error:
        raise make_error(
            f"{operation}: the answer does not match the API's schema ({error.error_count()} errors)",
            code="bad_response",
            status=0,
            operation=operation,
            body=data,
        ) from error


def without(options: Mapping[str, Any], *names: str) -> dict[str, Any]:
    return {name: value for name, value in options.items() if name not in names}


def wait_options(options: Mapping[str, Any]) -> CallOptions:
    """the options of `options` a transport call takes"""
    return {name: options[name] for name in ("timeout", "deadline", "retry", "headers") if name in options}  # type: ignore[return-value]


def lost_on_the_way(error: KyoraError) -> bool:
    """a poll that failed on the way, not with the create's outcome: nothing answered, a gateway, or a restart"""
    return error.code != "timeout" and (
        error.status in (0, 502, 504) or error.code == "do_reset" or error.code.startswith("http_")
    )


def is_ticket(body: Any) -> bool:
    return isinstance(body, dict) and body.get("status") == "queued" and isinstance(body.get("ticket"), str)


async def notify(callback: Callable[[Any], Any] | None, value: Any) -> None:
    if callback is not None:
        answer = callback(value)
        if inspect.isawaitable(answer):
            await answer


async def poll(
    transport: Transport,
    operation: str,
    current: M,
    fetch: Callable[[CallOptions], Awaitable[M]],
    done: Callable[[M], bool],
    options: Mapping[str, Any],
) -> M:
    """asks `fetch` again, backing off from 1 s to 5 s, until `done`; a deadline that passes is a timeout"""
    until = end_of(options, POLL_TIMEOUT)  # type: ignore[arg-type]
    delay = options.get("interval", 1.0)
    on_progress = options.get("on_progress")
    await transport.within(notify(on_progress, current), until, operation)
    while not done(current):
        if time.time() + delay >= until:
            raise timeout_error(operation)
        await asyncio.sleep(delay)
        delay = min(5.0, delay * 2)
        current = await fetch({"deadline": until})
        await transport.within(notify(on_progress, current), until, operation)
    return current


async def deleted(transport: Transport, operation: str, id: str, options: CallOptions) -> bool:
    """a DELETE that is False when the thing was already gone, unless an earlier try may have deleted it"""

    async def read(response: httpx.Response, attempt: int) -> bool:
        return response.status_code != 404 or attempt > 1

    return await transport.read(operation, RequestParts(path={"id": id}, accept=(404,)), options, read)


class AsyncKyora:
    """The kyora API, async. `token` defaults to KYORA_TOKEN, `base_url` to https://cloud.kyora.sh;
    `region` is where creates and restores go when they name none (unset, kyora picks)."""

    def __init__(
        self,
        *,
        token: str | None = None,
        base_url: str | None = None,
        region: str | None = None,
        timeout: float = 30.0,
        retry: Retry | Literal[False] = DEFAULT_RETRY,
        user_agent: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """`timeout`: seconds a call that does not stream may take, retries included. `retry=False` never
        repeats a call. `http_client`: an httpx.AsyncClient of your own (a proxy, a test double); it is
        not closed with this client."""
        self._owned = http_client is None
        self.transport = Transport(
            base_url=(base_url or DEFAULT_BASE_URL).rstrip("/"),
            token=token if token is not None else os.environ.get("KYORA_TOKEN") or None,
            client=http_client or httpx.AsyncClient(timeout=None, follow_redirects=False),
            timeout=timeout,
            retry=retry,
            user_agent=user_agent or USER_AGENT,
        )
        self.region = region
        self.sandboxes = Sandboxes(self)
        self.exec = Exec(self.transport)
        self.files = Files(self.transport)
        self.snapshots = Snapshots(self)
        self.ports = Ports(self.transport)
        self.storage = Storage(self)
        self.tokens = Tokens(self.transport)

    def __repr__(self) -> str:
        return f"AsyncKyora(base_url={self.transport.base_url!r}, region={self.region!r})"

    async def aclose(self) -> None:
        """waits for background cleanups (at most a few seconds), then closes the connections"""
        await self.transport.drain()
        if self._owned:
            await self.transport.client.aclose()

    async def __aenter__(self) -> AsyncKyora:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def health(self, **options: Unpack[CallOptions]) -> Health:
        """kyora's health and free capacity; needs no token"""
        return load(Health, await self.transport.json("getHealth", None, options), "getHealth")

    async def regions(self, **options: Unpack[CallOptions]) -> RegionList:
        return load(RegionList, await self.transport.json("listRegions", None, options), "listRegions")

    async def me(self, **options: Unpack[CallOptions]) -> Me:
        """the account the token acts for, with its limits"""
        return load(Me, await self.transport.json("getMe", None, options), "getMe")

    async def usage(self, month: str | None = None, **options: Unpack[CallOptions]) -> Usage:
        """usage and its estimated cost, for `month` (YYYY-MM, default this one)"""
        answer = await self.transport.json("getUsage", RequestParts(query={"month": month}), options)
        return load(Usage, answer, "getUsage")

    async def set_default_region(self, region: str | None, **options: Unpack[CallOptions]) -> str | None:
        """where the account's creates go when they name no region; None: kyora picks"""
        answer = await self.transport.json("setDefaultRegion", RequestParts(body={"region": region}), options)
        return load(SetRegionResponse, answer, "setDefaultRegion").region

    async def call(
        self,
        operation: str,
        *,
        path: Mapping[str, str | int] | None = None,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        content_type: str | None = None,
        **options: Unpack[CallOptions],
    ) -> Any:
        """Any HTTP operation of the API by its operationId, for what the SDK has no helper for yet. Errors,
        retries and idempotency keys work as for every other call. JSON operations answer their parsed
        body; streamed, binary and HEAD ones the open httpx.Response, to read and `aclose`."""
        if operation not in OPERATIONS:
            raise ValueError(f"{operation}: no such operation")
        parts = RequestParts(path=path, query=query, body=body, content_type=content_type)
        merged = {**(options.get("headers") or {}), **(headers or {})}
        call: CallOptions = {**options, "headers": merged}
        spec = OPERATIONS[operation]
        if spec["method"] != "HEAD" and spec["response"] in ("json", "none"):
            return await self.transport.json(operation, parts, call)
        return await self.transport.send(operation, parts, call)


class Sandboxes:
    def __init__(self, kyora: AsyncKyora) -> None:
        self._kyora = kyora

    @property
    def _transport(self) -> Transport:
        return self._kyora.transport

    async def create(
        self,
        spec: CreateSandboxRequest | Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        on_queued: Callable[[QueueTicket], Any] | None = None,
        **options: Unpack[CallOptions],
    ) -> Sandbox:
        """Creates a sandbox under an Idempotency-Key (a fresh one unless given, the same for every retry of
        this call), so a retry never creates a second one. A create cut short by its deadline may still have
        made its sandbox: the same create with the same key answers that sandbox. With `wait` (seconds) in
        the spec, a create kyora has no room for waits in line: this long-polls its ticket until the sandbox
        is placed, calling `on_queued` with each ticket, and takes it out of line at the deadline or on
        cancellation."""
        body = dump(CreateSandboxRequest, spec)
        if self._kyora.region is not None and "region" not in body:
            body["region"] = self._kyora.region
        wait = body.get("wait")
        until = end_of(options, wait + QUEUE_GRACE if wait else CREATE_TIMEOUT)
        parts = RequestParts(body=body, idempotency_key=idempotency_key)

        queued: str | None = None

        async def read(response: httpx.Response, _: int) -> tuple[int, Any]:
            nonlocal queued
            # read inside the call: a body that breaks off is asked again, under the same Idempotency-Key
            answer = read_json("createSandbox", response.status_code, await response.aread())
            if response.status_code == 202 and is_ticket(answer):
                # in line from here on, even when the call ends before the answer reaches it
                queued = answer["ticket"]
            return response.status_code, answer

        call: CallOptions = {**options, "timeout": math.inf, "deadline": until}
        try:
            _, answer = await self._transport.read("createSandbox", parts, call, read)
            if queued is None:
                return load(Sandbox, answer, "createSandbox")
            ticket = load(QueueTicket, answer, "createSandbox")
        except BaseException:
            if queued is not None:
                await self._leave_line(queued)
            raise
        return await self._wait_in_line(ticket, until, on_queued)

    async def _leave_line(self, ticket: str) -> None:
        """out of line, so kyora never places a sandbox nobody waits for"""
        try:
            await self._transport.race(self.cancel_ticket(ticket), CLEANUP_TIMEOUT)
        except (KyoraError, asyncio.TimeoutError):
            pass

    async def _wait_in_line(
        self, ticket: QueueTicket, until: float, on_queued: Callable[[QueueTicket], Any] | None
    ) -> Sandbox:
        failures = 0

        async def read(response: httpx.Response, _: int) -> tuple[int, Any]:
            return response.status_code, read_json("getQueueTicket", response.status_code, await response.aread())

        try:
            await self._transport.within(notify(on_queued, ticket), until, "createSandbox")
            while True:
                remaining = until - time.time()
                if remaining <= 1:
                    raise timeout_error("createSandbox")
                wait = max(1, min(QUEUE_POLL, math.floor(remaining) - 1))
                parts = RequestParts(path={"ticket": ticket.ticket}, query={"wait": wait})
                try:
                    # never repeated as is: an error the ticket answers is the create's own outcome
                    status, answer = await self._transport.read(
                        "getQueueTicket", parts, {"timeout": wait + 30, "deadline": until, "retry": False}, read
                    )
                except KyoraError as error:
                    failures += 1
                    if not lost_on_the_way(error) or failures > QUEUE_RETRIES:
                        raise
                    await asyncio.sleep(min(5.0, 0.25 * 2**failures, max(0.0, until - time.time())))
                    continue
                failures = 0
                if status != 202 or not is_ticket(answer):
                    return load(Sandbox, answer, "getQueueTicket")
                queued = load(QueueTicket, answer, "getQueueTicket")
                await self._transport.within(notify(on_queued, queued), until, "createSandbox")
        except BaseException:
            await self._leave_line(ticket.ticket)
            raise

    async def ticket(
        self, ticket: str, wait: int | None = None, **options: Unpack[CallOptions]
    ) -> QueueTicket | Sandbox:
        """a queued create's ticket; `wait` long-polls up to that many seconds (at most 30)"""
        parts = RequestParts(path={"ticket": ticket}, query={"wait": wait})
        answer = await self._transport.json("getQueueTicket", parts, options)
        return (
            load(QueueTicket, answer, "getQueueTicket")
            if is_ticket(answer)
            else load(Sandbox, answer, "getQueueTicket")
        )

    async def cancel_ticket(self, ticket: str, **options: Unpack[CallOptions]) -> None:
        await self._transport.json("cancelQueueTicket", RequestParts(path={"ticket": ticket}), options)

    async def get(self, id: str, **options: Unpack[CallOptions]) -> Sandbox:
        """a sandbox by its id, its name, or a unique prefix of its id"""
        return load(
            Sandbox, await self._transport.json("getSandbox", RequestParts(path={"id": id}), options), "getSandbox"
        )

    async def list(self, **options: Unpack[ListOptions]) -> ListPage[Sandbox]:
        """one page, newest first"""
        labels = options.get("labels")
        query = {"label": label_query(labels), "limit": options.get("limit"), "cursor": options.get("cursor")}
        answer = load(
            SandboxList,
            await self._transport.json("listSandboxes", RequestParts(query=query), wait_options(options)),
            "listSandboxes",
        )
        return ListPage(matching(answer.sandboxes, labels), answer.next_cursor or None)

    def iterate(self, **options: Unpack[ListOptions]) -> AsyncIterator[Sandbox]:
        """every sandbox matching `labels`, following next_cursor from `cursor` on"""
        rest = without(options, "cursor")
        return follow(
            "listSandboxes",
            lambda cursor: self.list(**rest, **({} if cursor is None else {"cursor": cursor})),  # type: ignore[arg-type]
            options.get("cursor"),
        )

    async def stats(self, **options: Unpack[CallOptions]) -> SandboxStats:
        """live resource samples of every running sandbox"""
        answer = await self._transport.json("listSandboxes", RequestParts(query={"stats": "1"}), options)
        return load(SandboxStats, answer, "listSandboxes")

    async def update(
        self, id: str, change: UpdateSandboxRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> Sandbox:
        """rename, change the TTL, grow the disk, or resize"""
        parts = RequestParts(path={"id": id}, body=dump(UpdateSandboxRequest, change))
        return load(Sandbox, await self._transport.json("updateSandbox", parts, options), "updateSandbox")

    async def resolve(self, id: str, **options: Unpack[CallOptions]) -> ResolveResponse:
        """the id a name or prefix stands for"""
        answer = await self._transport.json("resolveSandbox", RequestParts(path={"id": id}), options)
        return load(ResolveResponse, answer, "resolveSandbox")

    async def set_network(
        self, id: str, change: NetworkUpdateRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> NetworkUpdateResponse:
        parts = RequestParts(path={"id": id}, body=dump(NetworkUpdateRequest, change))
        return load(
            NetworkUpdateResponse, await self._transport.json("setSandboxNetwork", parts, options), "setSandboxNetwork"
        )

    async def delete(self, id: str, **options: Unpack[CallOptions]) -> bool:
        """destroys a sandbox; False when it was already gone (a retry that finds it gone counts as this call's)"""
        return await deleted(self._transport, "deleteSandbox", id, options)

    async def wait_until_running(
        self,
        sandbox: str | Sandbox,
        *,
        on_progress: Callable[[Sandbox], Any] | None = None,
        interval: float = 1.0,
        **options: Unpack[WaitOptions],
    ) -> Sandbox:
        """polls until the sandbox runs (default for up to an hour); one that failed, was lost or destroyed is
        an error"""
        until = end_of(options, POLL_TIMEOUT)
        first = await self.get(sandbox, deadline=until) if isinstance(sandbox, str) else sandbox

        def done(current: Sandbox) -> bool:
            if current.status in ("failed", "lost", "destroyed"):
                raise make_error(
                    f"sandbox {first.id} is {current.status}",
                    code="sandbox_ended",
                    status=0,
                    operation="getSandbox",
                    class_="conflict",
                    retryable=False,
                )
            return current.status == "running"

        return await poll(
            self._transport,
            "getSandbox",
            first,
            lambda call: self.get(first.id, **call),
            done,
            {"deadline": until, "on_progress": on_progress, "interval": interval},
        )


class Snapshots:
    def __init__(self, kyora: AsyncKyora) -> None:
        self._kyora = kyora

    @property
    def _transport(self) -> Transport:
        return self._kyora.transport

    async def create(
        self,
        sandbox: str,
        request: CreateSnapshotRequest | Mapping[str, Any] | None = None,
        *,
        wait: bool = True,
        on_progress: Callable[[Snapshot], Any] | None = None,
        interval: float = 1.0,
        **options: Unpack[CallOptions],
    ) -> Snapshot:
        """Takes a snapshot of a sandbox and, unless `wait=False`, polls until it is ready."""
        until = end_of(options, POLL_TIMEOUT)
        parts = RequestParts(path={"id": sandbox}, body=dump(CreateSnapshotRequest, request))
        call: CallOptions = {**options, "timeout": CREATE_TIMEOUT, "deadline": until}
        snapshot = load(Snapshot, await self._transport.json("createSnapshot", parts, call), "createSnapshot")
        if not wait:
            return snapshot

        def done(current: Snapshot) -> bool:
            if current.status == "failed":
                raise make_error(
                    f"snapshot {current.id} failed: {current.error or 'no reason given'}",
                    code="snapshot_failed",
                    status=0,
                    operation="getSnapshot",
                )
            if current.status == "deleted":
                raise make_error(
                    f"snapshot {current.id} was deleted", code="not_found", status=404, operation="getSnapshot"
                )
            return current.status == "ready"

        return await poll(
            self._transport,
            "getSnapshot",
            snapshot,
            lambda call: self.get(snapshot.id, **call),
            done,
            {"deadline": until, "on_progress": on_progress, "interval": interval},
        )

    async def get(self, id: str, **options: Unpack[CallOptions]) -> Snapshot:
        return load(
            Snapshot, await self._transport.json("getSnapshot", RequestParts(path={"id": id}), options), "getSnapshot"
        )

    async def list(self, **options: Unpack[ListOptions]) -> ListPage[Snapshot]:
        query = {
            "label": label_query(options.get("labels")),
            "limit": options.get("limit"),
            "cursor": options.get("cursor"),
        }
        answer = load(
            SnapshotList,
            await self._transport.json("listSnapshots", RequestParts(query=query), wait_options(options)),
            "listSnapshots",
        )
        return ListPage(answer.snapshots, answer.next_cursor or None)

    def iterate(self, **options: Unpack[ListOptions]) -> AsyncIterator[Snapshot]:
        rest = without(options, "cursor")
        return follow(
            "listSnapshots",
            lambda cursor: self.list(**rest, **({} if cursor is None else {"cursor": cursor})),  # type: ignore[arg-type]
            options.get("cursor"),
        )

    async def delete(self, id: str, **options: Unpack[CallOptions]) -> bool:
        """False when it was already gone (a retry that finds it gone counts as this call's)"""
        return await deleted(self._transport, "deleteSnapshot", id, options)

    async def restore(
        self,
        snapshot: str,
        spec: CreateSandboxRequest | Mapping[str, Any] | None = None,
        *,
        wait: bool = True,
        idempotency_key: str | None = None,
        on_queued: Callable[[QueueTicket], Any] | None = None,
        on_progress: Callable[[Sandbox], Any] | None = None,
        interval: float = 1.0,
        **options: Unpack[CallOptions],
    ) -> Sandbox:
        """A new sandbox from a snapshot, polled until it runs (unless `wait=False`). One that fails or runs
        out of time is destroyed, so nothing half restored is left behind, unless you passed your own
        `idempotency_key` (or Idempotency-Key header): the same key answers the sandbox an earlier restore
        made, which may be someone else's, so it is never destroyed. The wait's KyoraError then carries its
        `sandbox_id` (a cancellation propagates as it is; `on_progress` has seen the sandbox by then)."""
        until = end_of(options, POLL_TIMEOUT)
        body = {**dump(CreateSandboxRequest, spec), "fromSnapshot": snapshot}
        call: CallOptions = {**without(options, "timeout"), "deadline": until}  # type: ignore[typeddict-item]
        key = caller_key("createSandbox", idempotency_key, options.get("headers"))
        sandbox = await self._kyora.sandboxes.create(body, idempotency_key=key, on_queued=on_queued, **call)
        if not wait:
            return sandbox
        try:
            return await self._kyora.sandboxes.wait_until_running(
                sandbox, on_progress=on_progress, interval=interval, deadline=until
            )
        except BaseException as error:
            if key:
                if isinstance(error, KyoraError):
                    error.sandbox_id = sandbox.id
                raise
            try:
                await self._kyora.sandboxes.delete(sandbox.id)
            except KyoraError:
                pass
            raise


class PartSource:
    """an archive read in parts of a given size; `unread` puts a part back"""

    def __init__(self, archive: Archive) -> None:
        self._bytes: memoryview | None = None
        self._offset = 0
        self._held: list[bytes] = []
        self._held_bytes = 0
        self._done = False
        self._chunks: AsyncIterator[bytes] | None = None
        if isinstance(archive, (bytes, bytearray, memoryview)):
            view = memoryview(archive)
            self._bytes = view.cast("B") if view.c_contiguous else memoryview(view.tobytes())
        elif isinstance(archive, AsyncIterable):
            self._chunks = archive.__aiter__()
        elif hasattr(archive, "read"):
            self._chunks = _file_chunks(archive)  # type: ignore[arg-type]
        else:
            self._chunks = _iter_chunks(archive)

    async def next(self, size: int) -> bytes:
        if self._bytes is not None:
            part = self._bytes[self._offset : self._offset + size]
            self._offset += len(part)
            return bytes(part)
        assert self._chunks is not None
        while self._held_bytes < size and not self._done:
            try:
                chunk = await self._chunks.__anext__()
            except StopAsyncIteration:
                self._done = True
                break
            if chunk:
                self._held.append(bytes(chunk))
                self._held_bytes += len(chunk)
        data = b"".join(self._held)
        out, rest = data[:size], data[size:]
        self._held = [rest] if rest else []
        self._held_bytes = len(rest)
        return out

    async def close(self) -> None:
        closer = getattr(self._chunks, "aclose", None)
        if closer is not None:
            try:
                await closer()
            except Exception:
                pass

    def unread(self, part: bytes) -> None:
        if self._bytes is not None:
            self._offset -= len(part)
        else:
            self._held.insert(0, part)
            self._held_bytes += len(part)


async def _file_chunks(file: IO[bytes], size: int = 1024 * 1024) -> AsyncIterator[bytes]:
    while chunk := await asyncio.to_thread(file.read, size):
        yield chunk


async def _iter_chunks(chunks: Iterable[bytes]) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


class ByteStream:
    """An open answer's body, chunk by chunk, within the call's deadline; `aclose` frees the connection."""

    def __init__(self, response: httpx.Response, transport: Transport, until: float, operation: str) -> None:
        self._response = response
        self._transport = transport
        self._chunks = response.aiter_bytes()
        self._until = until
        self._operation = operation

    def __aiter__(self) -> ByteStream:
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self._transport.within(self._chunks.__anext__(), self._until, self._operation)
        except BaseException:
            await self._transport.closing(self._response.aclose(), self._until)
            raise

    async def aclose(self) -> None:
        await self._transport.closing(self._response.aclose())

    async def __aenter__(self) -> ByteStream:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()


class Files:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def upload(
        self, sandbox: str, files: FileInputs, *, dest: str | None = None, **options: Unpack[CallOptions]
    ) -> PushFilesResponse:
        """writes files into the sandbox, as one archive unpacked at `dest` (default /work)"""
        return await self.upload_tar(sandbox, pack_files(files), dest=dest, **options)

    async def upload_tar(
        self,
        sandbox: str,
        archive: Archive,
        *,
        dest: str | None = None,
        content_type: Literal["application/x-tar", "application/zstd"] = "application/x-tar",
        **options: Unpack[CallOptions],
    ) -> PushFilesResponse:
        """Unpacks a tar (or, with content_type application/zstd, a tar.zst) at `dest`. Up to 64 MiB it goes
        up in one PUT, past that in parts; a stream (an iterable of bytes or a binary file) is read part by
        part, never held whole. `timeout` and `deadline` bound the whole upload."""
        until = end_of(options)
        call: CallOptions = {**without(options, "timeout", "deadline"), "timeout": TRANSFER_TIMEOUT}  # type: ignore[typeddict-item]
        if until != math.inf:
            call["deadline"] = until
        source = PartSource(archive)
        upload_id: str | None = None

        async def opened(response: httpx.Response, _: int) -> Any:
            nonlocal upload_id
            answer = read_json("createUpload", response.status_code, await response.aread())
            if isinstance(answer, dict) and isinstance(answer.get("uploadId"), str):
                # aborted on failure from here on, even when the call ends before the answer reaches it
                upload_id = answer["uploadId"]
            return answer

        try:
            # a first part that is the whole archive goes up as it is
            first = await self._transport.within(source.next(SINGLE_UPLOAD_BYTES + 1), until, "uploadTar")
            if len(first) <= SINGLE_UPLOAD_BYTES:
                parts = RequestParts(path={"id": sandbox}, query={"dest": dest}, body=first, content_type=content_type)
                return load(PushFilesResponse, await self._transport.json("pushFiles", parts, call), "pushFiles")
            create = {**({"dest": dest} if dest else {}), "contentType": content_type}
            answer = await self._transport.read(
                "createUpload", RequestParts(path={"id": sandbox}, body=create), call, opened
            )
            upload = load(CreateUploadResponse, answer, "createUpload")
            size = min(upload.part_size, upload.max_part_bytes)
            if size < MIN_PART_BYTES or size > MAX_PART_BYTES:
                raise make_error(
                    f"createUpload: kyora asked for {size}-byte parts",
                    code="bad_response",
                    status=0,
                    operation="createUpload",
                )
            source.unread(first)
            done: list[dict[str, Any]] = []
            n = 0
            while True:
                n += 1
                part = await self._transport.within(source.next(size), until, "uploadTar")
                if not part:
                    break
                path = {"id": sandbox, "upload": upload.upload_id, "n": n}
                sent = await self._transport.json("uploadPart", RequestParts(path=path, body=part), call)
                done.append({"n": n, "etag": load(UploadPartResponse, sent, "uploadPart").etag})
            parts = RequestParts(path={"id": sandbox, "upload": upload.upload_id}, body={"parts": done})
            return load(PushFilesResponse, await self._transport.json("completeUpload", parts, call), "completeUpload")
        except BaseException as error:
            # best effort, each bounded on its own; the caller hears back by its deadline, at once on cancellation
            cleanups = {self._transport.cleanup(source.close())}
            if upload_id is not None:
                path = {"id": sandbox, "upload": upload_id}
                cleanups.add(
                    self._transport.cleanup(
                        self._transport.json("abortUpload", RequestParts(path=path), {"retry": False})
                    )
                )
            remaining = left(until)
            if not isinstance(error, asyncio.CancelledError) and (remaining is None or remaining > 0):
                await asyncio.wait(cleanups, timeout=remaining)
            raise

    async def download_tar(self, sandbox: str, paths: Iterable[str], **options: Unpack[CallOptions]) -> ByteStream:
        """the tar of `paths` as it streams in; the deadline bounds the whole download. Read it to its end
        or close it (`aclose`, or `async with`)."""
        until = end_of(options)
        parts = RequestParts(path={"id": sandbox}, query={"path": list(paths)})
        response = await self._transport.send("pullFiles", parts, options)
        return ByteStream(response, self._transport, until, "pullFiles")

    async def download(self, sandbox: str, paths: Iterable[str], **options: Unpack[CallOptions]) -> list[TarEntry]:
        """the entries of `paths`, read whole into memory; for large trees, use download_tar"""

        async def read(response: httpx.Response, _: int) -> list[TarEntry]:
            # read inside the call, so a download that breaks off is fetched again
            archive = await response.aread()
            try:
                return unpack(archive)
            except ValueError as error:
                raise make_error(
                    f"pullFiles: {error}",
                    code="bad_response",
                    status=response.status_code,
                    operation="pullFiles",
                    retryable=True,
                ) from error

        parts = RequestParts(path={"id": sandbox}, query={"path": list(paths)})
        return await self._transport.read("pullFiles", parts, options, read)

    async def read(self, sandbox: str, path: str, **options: Unpack[CallOptions]) -> bytes:
        """one file's bytes"""
        for entry in await self.download(sandbox, [path], **options):
            if entry.type == "file":
                return entry.data
        raise make_error(f"pullFiles: {path} is not a file", code="not_found", status=404, operation="pullFiles")


class Ports:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def expose(
        self,
        sandbox: str,
        port: int,
        *,
        name: str | None = None,
        public: bool | None = None,
        trusted: bool | None = None,
        **options: Unpack[CallOptions],
    ) -> Port:
        """a URL for a port of the sandbox; `public` needs no login"""
        fields = {"port": port, "name": name, "public": public, "trusted": trusted}
        body = dump(ExposePortRequest, {key: value for key, value in fields.items() if value is not None})
        answer = await self._transport.json("exposePort", RequestParts(path={"id": sandbox}, body=body), options)
        return load(Port, answer, "exposePort")

    async def list(self, sandbox: str, **options: Unpack[CallOptions]) -> list[Port]:
        answer = await self._transport.json("listSandboxPorts", RequestParts(path={"id": sandbox}), options)
        return load(PortList, answer, "listSandboxPorts").ports

    async def held(self, **options: Unpack[CallOptions]) -> list[PortWithSandbox]:
        """every name the account holds, with the sandbox it points at"""
        return load(HeldPortList, await self._transport.json("listPorts", None, options), "listPorts").ports

    async def unexpose(self, sandbox: str, label: str, **options: Unpack[CallOptions]) -> None:
        await self._transport.json("unexposePort", RequestParts(path={"id": sandbox, "label": label}), options)

    async def release(self, label: str, **options: Unpack[CallOptions]) -> None:
        """gives a held name up"""
        await self._transport.json("deletePort", RequestParts(path={"label": label}), options)

    async def login(self, sandbox: str, label: str, **options: Unpack[CallOptions]) -> LoginResponse:
        """a one-time login URL for a private port"""
        answer = await self._transport.json(
            "createPortLogin", RequestParts(path={"id": sandbox, "label": label}), options
        )
        return load(LoginResponse, answer, "createPortLogin")


@dataclass
class ObjectPage(ListPage[Object]):
    """one page of a bucket's objects; `prefixes` as kyora answers them"""

    prefixes: list[str] = field(default_factory=list)


@dataclass
class ObjectInfo:
    """an object's headers, as a HEAD answers them"""

    size: int
    etag: str | None
    content_type: str | None
    last_modified: str | None


class Storage:
    """Object storage: buckets, their objects and CORS, S3 keys, and the audit trail."""

    def __init__(self, kyora: AsyncKyora) -> None:
        self._transport = kyora.transport
        self.buckets = Buckets(kyora)
        self.objects = Objects(kyora.transport)
        self.keys = StorageKeys(kyora.transport)

    async def audit(self, *, limit: int | None = None, **options: Unpack[CallOptions]) -> list[Event]:
        """the account's storage events, newest first"""
        answer = await self._transport.json("getStorageAudit", RequestParts(query={"limit": limit}), options)
        return load(StorageAudit, answer, "getStorageAudit").events


class Buckets:
    def __init__(self, kyora: AsyncKyora) -> None:
        self._kyora = kyora
        self._transport = kyora.transport

    async def list(self, **options: Unpack[CallOptions]) -> list[Bucket]:
        return load(BucketList, await self._transport.json("listBuckets", None, options), "listBuckets").buckets

    async def create(self, name: str, *, region: str | None = None, **options: Unpack[CallOptions]) -> Bucket:
        """a bucket in `region`, else the client's region, else where kyora picks"""
        region = region if region is not None else self._kyora.region
        body = dump(CreateBucketRequest, {"name": name, **({"region": region} if region is not None else {})})
        return load(
            Bucket, await self._transport.json("createBucket", RequestParts(body=body), options), "createBucket"
        )

    async def get(self, name: str, **options: Unpack[CallOptions]) -> Bucket:
        answer = await self._transport.json("getBucket", RequestParts(path={"name": name}), options)
        return load(Bucket, answer, "getBucket")

    async def delete(self, name: str, *, force: bool = False, **options: Unpack[CallOptions]) -> DeleteBucketResponse:
        """Deletes a bucket. Without `force` one that holds objects is a `bucket_not_empty` error; with it
        its objects go first, a call at a time until kyora answers it deleted. `objects_deleted` sums what each
        answer reports, so a call retried after its answer was lost leaves that batch uncounted: take it as a
        lower bound. `timeout` and `deadline` bound the whole delete."""
        until = end_of(options)
        call: CallOptions = without(options, "timeout", "deadline")  # type: ignore[assignment]
        if until != math.inf:
            call["deadline"] = until
        parts = RequestParts(path={"name": name}, query={"force": True if force else None})
        deleted = 0
        while True:
            answer = await self._transport.json("deleteBucket", parts, call)
            if isinstance(answer, dict) and answer.get("done") is True:
                done = load(DeleteBucketResponse, answer, "deleteBucket")
                return done.model_copy(update={"objects_deleted": deleted + done.objects_deleted})
            deleted += load(DeleteBucketProgress, answer, "deleteBucket").objects_deleted

    async def cors(self, name: str, **options: Unpack[CallOptions]) -> BucketCors:
        answer = await self._transport.json("getBucketCors", RequestParts(path={"name": name}), options)
        return load(BucketCors, answer, "getBucketCors")

    async def set_cors(self, name: str, origins: Iterable[str], **options: Unpack[CallOptions]) -> BucketCors:
        """the origins browsers may reach the bucket's objects from"""
        parts = RequestParts(path={"name": name}, body={"origins": list(origins)})
        return load(BucketCors, await self._transport.json("setBucketCors", parts, options), "setBucketCors")

    async def clear_cors(self, name: str, **options: Unpack[CallOptions]) -> BucketCors:
        answer = await self._transport.json("deleteBucketCors", RequestParts(path={"name": name}), options)
        return load(BucketCors, answer, "deleteBucketCors")


class Objects:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def list(
        self,
        bucket: str,
        *,
        prefix: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        **options: Unpack[CallOptions],
    ) -> ObjectPage:
        """one page of the bucket's objects, those under `prefix` only when it is set"""
        parts = RequestParts(path={"name": bucket}, query={"prefix": prefix, "cursor": cursor, "limit": limit})
        answer = load(ObjectList, await self._transport.json("listObjects", parts, options), "listObjects")
        return ObjectPage(answer.objects, answer.cursor or None, answer.prefixes)

    def iterate(
        self, bucket: str, *, prefix: str | None = None, limit: int | None = None, **options: Unpack[CallOptions]
    ) -> AsyncIterator[Object]:
        """every object under `prefix`, page after page"""
        return follow(
            "listObjects", lambda cursor: self.list(bucket, prefix=prefix, limit=limit, cursor=cursor, **options)
        )

    async def get(self, bucket: str, key: str, **options: Unpack[CallOptions]) -> bytes:
        """the object's bytes, read whole into memory; for large objects, use get_stream"""

        async def read(response: httpx.Response, _: int) -> bytes:
            return await response.aread()

        return await self._transport.read(
            "getObject", RequestParts(path={"name": bucket, "objectKey": key}), options, read
        )

    async def get_stream(self, bucket: str, key: str, **options: Unpack[CallOptions]) -> ByteStream:
        """the object as it streams in; the deadline bounds the whole download. Read it to its end or close
        it (`aclose`, or `async with`)."""
        until = end_of(options)
        parts = RequestParts(path={"name": bucket, "objectKey": key})
        return ByteStream(await self._transport.send("getObject", parts, options), self._transport, until, "getObject")

    async def head(self, bucket: str, key: str, **options: Unpack[CallOptions]) -> ObjectInfo:
        """the object's size, etag, type and last change; a missing object is a not_found error"""

        async def read(response: httpx.Response, _: int) -> ObjectInfo:
            if response.status_code == 404:
                raise make_error(
                    f"headObject: {bucket}/{key} does not exist", code="not_found", status=404, operation="headObject"
                )
            headers = response.headers
            return ObjectInfo(
                int(headers.get("content-length", 0)),
                headers.get("etag"),
                headers.get("content-type"),
                headers.get("last-modified"),
            )

        parts = RequestParts(path={"name": bucket, "objectKey": key}, accept=(404,))
        return await self._transport.read("headObject", parts, options, read)

    async def put(
        self,
        bucket: str,
        key: str,
        data: Archive | str,
        *,
        content_type: str | None = None,
        **options: Unpack[CallOptions],
    ) -> PutObjectResponse:
        """Stores `data` at `key`. Up to 64 MiB it goes up in one PUT, past that in parts (a failed one
        aborts the upload); a stream (an iterable of bytes or a binary file) is read part by part, never
        held whole. `timeout` and `deadline` bound the whole upload."""
        until = end_of(options)
        call: CallOptions = {**without(options, "timeout", "deadline"), "timeout": TRANSFER_TIMEOUT}  # type: ignore[typeddict-item]
        if until != math.inf:
            call["deadline"] = until
        path = {"name": bucket, "objectKey": key}
        source = PartSource(data.encode() if isinstance(data, str) else data)
        upload_id: str | None = None

        async def opened(response: httpx.Response, _: int) -> Any:
            nonlocal upload_id
            answer = read_json("multipartObject", response.status_code, await response.aread())
            if isinstance(answer, dict) and isinstance(answer.get("uploadId"), str):
                upload_id = answer["uploadId"]
            return answer

        try:
            first = await self._transport.within(source.next(SINGLE_UPLOAD_BYTES + 1), until, "putObject")
            if len(first) <= SINGLE_UPLOAD_BYTES:
                parts = RequestParts(path=path, body=first, content_type=content_type or "application/octet-stream")
                return load(PutObjectResponse, await self._transport.json("putObject", parts, call), "putObject")
            start: CallOptions = {
                **call,
                "headers": {**(call.get("headers") or {}), **({"content-type": content_type} if content_type else {})},
            }
            answer = await self._transport.read(
                "multipartObject", RequestParts(path=path, query={"uploads": ""}), start, opened
            )
            upload = load(MultipartStartResponse, answer, "multipartObject")
            size = min(SINGLE_UPLOAD_BYTES, upload.max_part_bytes)
            if size < MIN_PART_BYTES or size > MAX_PART_BYTES:
                raise make_error(
                    f"multipartObject: kyora allows {size}-byte parts",
                    code="bad_response",
                    status=0,
                    operation="multipartObject",
                )
            source.unread(first)
            done: list[dict[str, Any]] = []
            n = 0
            while True:
                n += 1
                part = await self._transport.within(source.next(size), until, "putObject")
                if not part:
                    break
                if n > upload.max_parts:
                    raise make_error(
                        f"putObject: more than {upload.max_parts} parts of {size} bytes",
                        code="invalid_request",
                        status=0,
                        class_="invalid",
                        retryable=False,
                        operation="putObject",
                    )
                query = {"uploadId": upload.upload_id, "partNumber": n}
                sent = await self._transport.json("putObject", RequestParts(path=path, query=query, body=part), call)
                done.append({"partNumber": n, "etag": load(PutPartResponse, sent, "putObject").etag})
            parts = RequestParts(path=path, query={"uploadId": upload.upload_id}, body={"parts": done})
            return load(
                PutObjectResponse, await self._transport.json("multipartObject", parts, call), "multipartObject"
            )
        except BaseException as error:
            cleanups = {self._transport.cleanup(source.close())}
            if upload_id is not None:
                aborting = RequestParts(path=path, query={"uploadId": upload_id})
                cleanups.add(self._transport.cleanup(self._transport.json("deleteObject", aborting, {"retry": False})))
            remaining = left(until)
            if not isinstance(error, asyncio.CancelledError) and (remaining is None or remaining > 0):
                await asyncio.wait(cleanups, timeout=remaining)
            raise

    async def delete(self, bucket: str, key: str, **options: Unpack[CallOptions]) -> None:
        """deletes an object; one that is not there is no error"""
        await self._transport.json("deleteObject", RequestParts(path={"name": bucket, "objectKey": key}), options)

    async def presign(
        self, bucket: str, request: PresignRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> PresignResponse:
        """a URL that GETs or PUTs one object without a token, until it expires"""
        parts = RequestParts(path={"name": bucket}, body=dump(PresignRequest, request))
        return load(PresignResponse, await self._transport.json("presignObject", parts, options), "presignObject")


class StorageKeys:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def list(self, **options: Unpack[CallOptions]) -> list[StorageKey]:
        return load(
            StorageKeyList, await self._transport.json("listStorageKeys", None, options), "listStorageKeys"
        ).keys

    async def create(
        self, request: CreateStorageKeyRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> CreateStorageKeyResponse:
        """an S3 key for a bucket (or a prefix of it); its secret is in the answer only"""
        parts = RequestParts(body=dump(CreateStorageKeyRequest, request))
        return load(
            CreateStorageKeyResponse, await self._transport.json("createStorageKey", parts, options), "createStorageKey"
        )

    async def revoke(self, id: str, **options: Unpack[CallOptions]) -> RevokeStorageKeyResponse:
        answer = await self._transport.json("deleteStorageKey", RequestParts(path={"id": id}), options)
        return load(RevokeStorageKeyResponse, answer, "deleteStorageKey")


class Tokens:
    """Your own tokens, or with `org` an organization's."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def list(self, *, org: str | None = None, **options: Unpack[CallOptions]) -> list[Token]:
        if org:
            answer = await self._transport.json("listOrgTokens", RequestParts(path={"org": org}), options)
        else:
            answer = await self._transport.json("listTokens", None, options)
        return load(TokenList, answer, "listTokens").tokens

    async def create(
        self, request: CreateTokenRequest | Mapping[str, Any], *, org: str | None = None, **options: Unpack[CallOptions]
    ) -> CreateTokenResponse:
        """a new token; its secret is in the answer only"""
        body = dump(CreateTokenRequest, request)
        if org:
            answer = await self._transport.json("createOrgToken", RequestParts(path={"org": org}, body=body), options)
        else:
            answer = await self._transport.json("createToken", RequestParts(body=body), options)
        return load(CreateTokenResponse, answer, "createToken")

    async def delete(self, id: str, *, org: str | None = None, **options: Unpack[CallOptions]) -> None:
        """revokes a token"""
        if org:
            await self._transport.json("deleteOrgToken", RequestParts(path={"org": org, "id": id}), options)
        else:
            await self._transport.json("deleteToken", RequestParts(path={"id": id}), options)
