"""Kyora, the blocking client: AsyncKyora run on an event loop of its own, in a daemon thread."""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Iterable, Iterator, Mapping
from typing import Any, Literal, TypeVar

import httpx
from typing_extensions import Unpack

from ._client import Archive, AsyncKyora, ByteStream
from ._exec import ByteOffsets, ExecInput, ExecOptions, ExecResult, ExecStream, Output
from ._http import DEFAULT_RETRY, CallOptions, Retry, WaitOptions
from ._models import (
    CreateSandboxRequest,
    CreateSnapshotRequest,
    CreateTokenRequest,
    CreateTokenResponse,
    ExecCancelResponse,
    Health,
    LoginResponse,
    Me,
    NetworkUpdateRequest,
    NetworkUpdateResponse,
    Port,
    PortWithSandbox,
    PushFilesResponse,
    QueueTicket,
    RegionList,
    ResolveResponse,
    Sandbox,
    SandboxStats,
    Snapshot,
    Token,
    UpdateSandboxRequest,
    Usage,
)
from ._paging import ListOptions, ListPage
from ._tar import FileInputs, TarEntry

T = TypeVar("T")
SETTLE = 5.0
"""seconds a cancelled call, or the client's close, waits for cleanups to finish"""


class Portal:
    """an event loop in a thread of its own, and a way to run coroutines on it and wait"""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="kyora", daemon=True)
        self.thread.start()

    def run(self, coroutine: Coroutine[Any, Any, T]) -> T:
        if threading.current_thread() is self.thread:
            coroutine.close()
            raise RuntimeError("a blocking Kyora call from inside one of its own callbacks; use AsyncKyora there")
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            return future.result()
        except BaseException:
            # an interrupt (Ctrl-C) cancels the call as cancelling its task would, and lets its cleanup run
            future.cancel()
            concurrent.futures.wait([future], timeout=SETTLE)
            raise

    def iterate(self, iterator: AsyncIterator[T], close: Callable[[], Awaitable[None]] | None = None) -> Iterator[T]:
        try:
            while True:
                try:
                    yield self.run(_next(iterator))
                except StopAsyncIteration:
                    return
        finally:
            closer = close or getattr(iterator, "aclose", None)
            if closer is not None and self.loop.is_running():
                self.run(_await(closer()))

    def close(self) -> None:
        if self.loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(_settle(), self.loop).result(3 * SETTLE)
            except Exception:
                pass
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join()
        if not self.loop.is_closed():
            self.loop.close()


async def _settle() -> None:
    """lets the loop's other tasks (cleanups, calls cancelled on the way out) finish, then cancels the rest"""
    tasks = asyncio.all_tasks() - {asyncio.current_task()}
    if not tasks:
        return
    _, pending = await asyncio.wait(tasks, timeout=SETTLE)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=SETTLE)


async def _next(iterator: AsyncIterator[T]) -> T:
    return await iterator.__anext__()


async def _await(awaitable: Awaitable[T]) -> T:
    return await awaitable


class Kyora:
    """The kyora API, blocking. `token` defaults to KYORA_TOKEN, `base_url` to https://cloud.kyora.sh;
    `region` is where creates and restores go when they name none (unset, kyora picks). Callbacks
    (on_output, on_queued, on_progress) run on the client's own thread. Close it with `close()` or `with`."""

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
        self.aio = AsyncKyora(
            token=token,
            base_url=base_url,
            region=region,
            timeout=timeout,
            retry=retry,
            user_agent=user_agent,
            http_client=http_client,
        )
        """the async client underneath"""
        self._portal = Portal()
        self.region = region
        self.sandboxes = Sandboxes(self.aio, self._portal)
        self.exec = Exec(self.aio, self._portal)
        self.files = Files(self.aio, self._portal)
        self.snapshots = Snapshots(self.aio, self._portal)
        self.ports = Ports(self.aio, self._portal)
        self.tokens = Tokens(self.aio, self._portal)

    def __repr__(self) -> str:
        return f"Kyora(base_url={self.aio.transport.base_url!r}, region={self.region!r})"

    def close(self) -> None:
        if self._portal.loop.is_running():
            self._portal.run(self.aio.aclose())
        self._portal.close()

    def __enter__(self) -> Kyora:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def health(self, **options: Unpack[CallOptions]) -> Health:
        """kyora's health and free capacity; needs no token"""
        return self._portal.run(self.aio.health(**options))

    def regions(self, **options: Unpack[CallOptions]) -> RegionList:
        return self._portal.run(self.aio.regions(**options))

    def me(self, **options: Unpack[CallOptions]) -> Me:
        """the account the token acts for, with its limits"""
        return self._portal.run(self.aio.me(**options))

    def usage(self, month: str | None = None, **options: Unpack[CallOptions]) -> Usage:
        """usage and its estimated cost, for `month` (YYYY-MM, default this one)"""
        return self._portal.run(self.aio.usage(month, **options))

    def set_default_region(self, region: str | None, **options: Unpack[CallOptions]) -> str | None:
        """where the account's creates go when they name no region; None: kyora picks"""
        return self._portal.run(self.aio.set_default_region(region, **options))

    def call(
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
        """Any HTTP operation of the API by its operationId. JSON operations answer their parsed body; streamed,
        binary and HEAD ones the httpx.Response, its body read whole."""

        async def call() -> Any:
            answer = await self.aio.call(
                operation, path=path, query=query, body=body, headers=headers, content_type=content_type, **options
            )
            if isinstance(answer, httpx.Response):
                try:
                    await answer.aread()
                finally:
                    await answer.aclose()
            return answer

        return self._portal.run(call())


class _Resource:
    def __init__(self, kyora: AsyncKyora, portal: Portal) -> None:
        self._aio = kyora
        self._portal = portal


class Sandboxes(_Resource):
    def create(
        self,
        spec: CreateSandboxRequest | Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        on_queued: Callable[[QueueTicket], Any] | None = None,
        **options: Unpack[CallOptions],
    ) -> Sandbox:
        """Creates a sandbox under an Idempotency-Key, so a retry never creates a second one; with `wait`
        in the spec, waits in line for room. See AsyncKyora.sandboxes.create."""
        return self._portal.run(
            self._aio.sandboxes.create(spec, idempotency_key=idempotency_key, on_queued=on_queued, **options)
        )

    def ticket(self, ticket: str, wait: int | None = None, **options: Unpack[CallOptions]) -> QueueTicket | Sandbox:
        return self._portal.run(self._aio.sandboxes.ticket(ticket, wait, **options))

    def cancel_ticket(self, ticket: str, **options: Unpack[CallOptions]) -> None:
        return self._portal.run(self._aio.sandboxes.cancel_ticket(ticket, **options))

    def get(self, id: str, **options: Unpack[CallOptions]) -> Sandbox:
        """a sandbox by its id, its name, or a unique prefix of its id"""
        return self._portal.run(self._aio.sandboxes.get(id, **options))

    def list(self, **options: Unpack[ListOptions]) -> ListPage[Sandbox]:
        """one page, newest first"""
        return self._portal.run(self._aio.sandboxes.list(**options))

    def iterate(self, **options: Unpack[ListOptions]) -> Iterator[Sandbox]:
        """every sandbox matching `labels`, following next_cursor from `cursor` on"""
        return self._portal.iterate(self._aio.sandboxes.iterate(**options))

    def stats(self, **options: Unpack[CallOptions]) -> SandboxStats:
        return self._portal.run(self._aio.sandboxes.stats(**options))

    def update(
        self, id: str, change: UpdateSandboxRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> Sandbox:
        """rename, change the TTL, grow the disk, or resize"""
        return self._portal.run(self._aio.sandboxes.update(id, change, **options))

    def resolve(self, id: str, **options: Unpack[CallOptions]) -> ResolveResponse:
        return self._portal.run(self._aio.sandboxes.resolve(id, **options))

    def set_network(
        self, id: str, change: NetworkUpdateRequest | Mapping[str, Any], **options: Unpack[CallOptions]
    ) -> NetworkUpdateResponse:
        return self._portal.run(self._aio.sandboxes.set_network(id, change, **options))

    def delete(self, id: str, **options: Unpack[CallOptions]) -> bool:
        """destroys a sandbox; False when it was already gone"""
        return self._portal.run(self._aio.sandboxes.delete(id, **options))

    def wait_until_running(
        self,
        sandbox: str | Sandbox,
        *,
        on_progress: Callable[[Sandbox], Any] | None = None,
        interval: float = 1.0,
        **options: Unpack[WaitOptions],
    ) -> Sandbox:
        return self._portal.run(
            self._aio.sandboxes.wait_until_running(sandbox, on_progress=on_progress, interval=interval, **options)
        )


class SyncExecStream:
    """A running command's output as it arrives, Output by Output; `.result` once it ends. Use it as
    `with kyora.exec.stream(...) as stream: for chunk in stream: ...`."""

    def __init__(self, stream: ExecStream, portal: Portal) -> None:
        self._stream = stream
        self._portal = portal

    @property
    def result(self) -> ExecResult | None:
        return self._stream.result

    def __iter__(self) -> Iterator[Output]:
        return self

    def __next__(self) -> Output:
        try:
            return self._portal.run(_next(self._stream))
        except StopAsyncIteration:
            raise StopIteration from None

    def close(self) -> None:
        self._portal.run(self._stream.aclose())

    def __enter__(self) -> SyncExecStream:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class SyncByteStream:
    """An open answer's body, chunk by chunk; `close` frees the connection."""

    def __init__(self, stream: ByteStream, portal: Portal) -> None:
        self._stream = stream
        self._portal = portal

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        try:
            return self._portal.run(_next(self._stream))
        except StopAsyncIteration:
            raise StopIteration from None

    def close(self) -> None:
        self._portal.run(self._stream.aclose())

    def __enter__(self) -> SyncByteStream:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class Exec(_Resource):
    def run(self, sandbox: str, request: ExecInput, **options: Unpack[ExecOptions]) -> ExecResult:
        """Runs a command and collects its output, reattaching when the stream breaks. See AsyncKyora.exec.run."""
        return self._portal.run(self._aio.exec.run(sandbox, request, **options))

    def stream(self, sandbox: str, request: ExecInput, **options: Unpack[ExecOptions]) -> SyncExecStream:
        """`run`, with the output as an iterator of Output(stream, data); `.result` once it ends"""

        async def make() -> ExecStream:
            return self._aio.exec.stream(sandbox, request, **options)

        return SyncExecStream(self._portal.run(make()), self._portal)

    def attach(
        self, sandbox: str, exec_id: str, *, from_: ByteOffsets | None = None, **options: Unpack[ExecOptions]
    ) -> ExecResult:
        """The rest of a running or finished command's output, from `from_` (default the start), to its exit."""
        return self._portal.run(self._aio.exec.attach(sandbox, exec_id, from_=from_, **options))

    def cancel(self, sandbox: str, exec_id: str, **options: Unpack[CallOptions]) -> ExecCancelResponse:
        """stops a resumable command"""
        return self._portal.run(self._aio.exec.cancel(sandbox, exec_id, **options))


class Files(_Resource):
    def upload(
        self, sandbox: str, files: FileInputs, *, dest: str | None = None, **options: Unpack[CallOptions]
    ) -> PushFilesResponse:
        """writes files into the sandbox, as one archive unpacked at `dest` (default /work)"""
        return self._portal.run(self._aio.files.upload(sandbox, files, dest=dest, **options))

    def upload_tar(
        self,
        sandbox: str,
        archive: Archive,
        *,
        dest: str | None = None,
        content_type: Literal["application/x-tar", "application/zstd"] = "application/x-tar",
        **options: Unpack[CallOptions],
    ) -> PushFilesResponse:
        """Unpacks a tar (or a tar.zst) at `dest`; past 64 MiB it goes up in parts. See AsyncKyora.files.upload_tar."""
        return self._portal.run(
            self._aio.files.upload_tar(sandbox, archive, dest=dest, content_type=content_type, **options)
        )

    def download_tar(self, sandbox: str, paths: Iterable[str], **options: Unpack[CallOptions]) -> SyncByteStream:
        """the tar of `paths` as it streams in. Read it to its end or close it (`close`, or `with`)."""
        return SyncByteStream(self._portal.run(self._aio.files.download_tar(sandbox, paths, **options)), self._portal)

    def download(self, sandbox: str, paths: Iterable[str], **options: Unpack[CallOptions]) -> list[TarEntry]:
        """the entries of `paths`, read whole into memory; for large trees, use download_tar"""
        return self._portal.run(self._aio.files.download(sandbox, paths, **options))

    def read(self, sandbox: str, path: str, **options: Unpack[CallOptions]) -> bytes:
        """one file's bytes"""
        return self._portal.run(self._aio.files.read(sandbox, path, **options))


class Snapshots(_Resource):
    def create(
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
        return self._portal.run(
            self._aio.snapshots.create(
                sandbox, request, wait=wait, on_progress=on_progress, interval=interval, **options
            )
        )

    def get(self, id: str, **options: Unpack[CallOptions]) -> Snapshot:
        return self._portal.run(self._aio.snapshots.get(id, **options))

    def list(self, **options: Unpack[ListOptions]) -> ListPage[Snapshot]:
        return self._portal.run(self._aio.snapshots.list(**options))

    def iterate(self, **options: Unpack[ListOptions]) -> Iterator[Snapshot]:
        return self._portal.iterate(self._aio.snapshots.iterate(**options))

    def delete(self, id: str, **options: Unpack[CallOptions]) -> bool:
        """False when it was already gone"""
        return self._portal.run(self._aio.snapshots.delete(id, **options))

    def restore(
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
        """A new sandbox from a snapshot, polled until it runs (unless `wait=False`); destroyed on failure."""
        return self._portal.run(
            self._aio.snapshots.restore(
                snapshot,
                spec,
                wait=wait,
                idempotency_key=idempotency_key,
                on_queued=on_queued,
                on_progress=on_progress,
                interval=interval,
                **options,
            )
        )


class Ports(_Resource):
    def expose(
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
        return self._portal.run(
            self._aio.ports.expose(sandbox, port, name=name, public=public, trusted=trusted, **options)
        )

    def list(self, sandbox: str, **options: Unpack[CallOptions]) -> list[Port]:
        return self._portal.run(self._aio.ports.list(sandbox, **options))

    def held(self, **options: Unpack[CallOptions]) -> list[PortWithSandbox]:
        """every name the account holds, with the sandbox it points at"""
        return self._portal.run(self._aio.ports.held(**options))

    def unexpose(self, sandbox: str, label: str, **options: Unpack[CallOptions]) -> None:
        return self._portal.run(self._aio.ports.unexpose(sandbox, label, **options))

    def release(self, label: str, **options: Unpack[CallOptions]) -> None:
        """gives a held name up"""
        return self._portal.run(self._aio.ports.release(label, **options))

    def login(self, sandbox: str, label: str, **options: Unpack[CallOptions]) -> LoginResponse:
        """a one-time login URL for a private port"""
        return self._portal.run(self._aio.ports.login(sandbox, label, **options))


class Tokens(_Resource):
    """Your own tokens, or with `org` an organization's."""

    def list(self, *, org: str | None = None, **options: Unpack[CallOptions]) -> list[Token]:
        return self._portal.run(self._aio.tokens.list(org=org, **options))

    def create(
        self, request: CreateTokenRequest | Mapping[str, Any], *, org: str | None = None, **options: Unpack[CallOptions]
    ) -> CreateTokenResponse:
        """a new token; its secret is in the answer only"""
        return self._portal.run(self._aio.tokens.create(request, org=org, **options))

    def delete(self, id: str, *, org: str | None = None, **options: Unpack[CallOptions]) -> None:
        """revokes a token"""
        return self._portal.run(self._aio.tokens.delete(id, org=org, **options))
