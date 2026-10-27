from __future__ import annotations

import asyncio
import base64
import inspect
import json
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from typing_extensions import Unpack

from ._errors import KyoraError, make_error
from ._http import CallOptions, RequestParts, Transport, WaitOptions, end_of, left, random_key
from ._models import ExecCancelResponse, ExecRequest

Stream = Literal["stdout", "stderr"]
OnOutput = Callable[[Stream, bytes], None | Awaitable[None]]
ExecInput = ExecRequest | Mapping[str, Any]


class ExecOptions(WaitOptions, total=False):
    on_output: OnOutput
    """each chunk of output as it arrives; may be async"""
    max_output_bytes: int
    """bytes of each stream kept in the result; output past it still streams to on_output (default 16 MiB)"""
    reattach_window: float
    """seconds a broken stream is reattached to before the call gives up (default 120)"""
    idle: float
    """seconds a stream may say nothing, not even a keepalive, before it counts as broken (default 60)"""
    cancel_on_cancel: bool
    """cancelling the call's task also cancels the command (default True); the deadline never does"""


@dataclass
class ByteOffsets:
    stdout: int = 0
    stderr: int = 0


@dataclass
class Truncated:
    stdout: bool = False
    stderr: bool = False


@dataclass
class ExecResult:
    exit_code: int | None
    """the command's exit code; None when a signal ended it"""
    signal: str | int | None
    """the signal that ended the command (a Linux name or number), or None"""
    timed_out: bool
    """the exec's timeout_seconds stopped the command"""
    duration_ms: float
    stdout: bytes
    stderr: bytes
    truncated: Truncated
    """output the result is missing, per stream: past max_output_bytes, dropped while nothing was attached
    (the sandbox keeps the latest output of each stream), or short of the totals the exit reports"""
    exec_id: str | None
    """the command's id, for attach and cancel"""
    key: str | None
    """the exec key the command ran under"""


class ExecDetachedError(KyoraError):
    """The call stopped waiting while the command may still run: its deadline passed (`timeout`), or the
    stream broke and could not be reattached in time (`stream_lost`). Reattach with
    `exec.attach(sandbox, exec_id, from_=offsets)`, or rerun the same request with the same key."""

    def __init__(
        self, message: str, *, exec_id: str | None, key: str | None, offsets: ByteOffsets, **fields: Any
    ) -> None:
        super().__init__(message, **fields)
        self.exec_id = exec_id
        self.key = key
        self.offsets = offsets
        """bytes of each stream read so far"""


DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024
DEFAULT_WINDOW = 120.0
DEFAULT_IDLE = 60.0
BASE_DELAY = 0.25
MAX_DELAY = 10.0
START_TIMEOUT = 120.0
"""how long the first line of an exec may take: the machine gets 60 s to start the command"""
ATTACH_TIMEOUT = 30.0
"""how long a reattach's first line may take"""
KEEPALIVE_HEADER = "x-kyora-keepalive-ms"
CANCEL_TIMEOUT = 5.0


class OutputCallbackError(Exception):
    """an exception of the caller's on_output: it ends the call as it is, never taken for a broken stream"""

    def __init__(self, error: BaseException) -> None:
        super().__init__()
        self.error = error


class Collector:
    """the command's output so far, and where a reattach carries on"""

    def __init__(self, limit: int, on_output: OnOutput | None, key: str | None) -> None:
        self.limit = limit
        self.on_output = on_output
        self.key = key
        self.offsets = ByteOffsets()
        self.truncated = Truncated()
        self.kept: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
        self.kept_bytes = {"stdout": 0, "stderr": 0}
        self.exec_id: str | None = None
        self.started = False
        """a started or attached frame came: the command runs, whether or not kyora named it"""

    async def output(self, stream: Stream, data: bytes) -> None:
        setattr(self.offsets, stream, getattr(self.offsets, stream) + len(data))
        room = self.limit - self.kept_bytes[stream]
        if len(data) > room:
            setattr(self.truncated, stream, True)
        keep = data if room >= len(data) else data[: max(0, room)]
        if keep:
            self.kept[stream].append(keep)
            self.kept_bytes[stream] += len(keep)
        if self.on_output is None:
            return
        try:
            answer = self.on_output(stream, data)
            if inspect.isawaitable(answer):
                await answer
        except Exception as error:
            raise OutputCallbackError(error) from error

    @property
    def untouched(self) -> bool:
        """nothing of the command was seen yet: sending it again under its key can only find it"""
        return not self.started and self.offsets.stdout == 0 and self.offsets.stderr == 0

    def gap(self, stream: Stream, to: int) -> None:
        """output up to `to` left the sandbox's buffer before it was read"""
        if to <= getattr(self.offsets, stream):
            return
        setattr(self.offsets, stream, to)
        setattr(self.truncated, stream, True)

    def result(self, exit: Mapping[str, Any]) -> ExecResult:
        totals = exit.get("bytes") or {}
        for stream in ("stdout", "stderr"):
            total = totals.get(stream)
            if isinstance(total, int) and total > getattr(self.offsets, stream):
                setattr(self.truncated, stream, True)
        return ExecResult(
            exit_code=exit.get("code"),
            signal=exit.get("signal"),
            timed_out=exit.get("timedOut") is True,
            duration_ms=exit.get("durationMs", 0),
            stdout=b"".join(self.kept["stdout"]),
            stderr=b"".join(self.kept["stderr"]),
            truncated=Truncated(self.truncated.stdout, self.truncated.stderr),
            exec_id=self.exec_id,
            key=self.key,
        )


@dataclass
class Ending:
    kind: Literal["exit", "error", "break"]
    exit: Mapping[str, Any] = field(default_factory=dict)
    message: str = ""
    progressed: bool = False


async def read_stream(response: httpx.Response, collector: Collector, idle: float) -> Ending:
    """Reads one exec stream to its end or its break, and closes it. A stream counts as broken when it
    ends without an exit, says `detached`, or goes silent past `idle` once the server has shown it sends
    keepalives; and when it carries only kyora cloud's own keepalives, nothing from the machine, that long."""
    armed = KEEPALIVE_HEADER in response.headers or collector.exec_id is not None
    heard = machine = time.monotonic()
    cloud_marks = False
    progressed = False
    ending: Ending | None = None
    buffer = b""

    async def handle(line: bytes) -> None:
        nonlocal armed, cloud_marks, machine, progressed, ending
        if not line.strip():
            return
        try:
            frame = json.loads(line)
        except ValueError:
            return
        if not isinstance(frame, dict):
            return
        kind = frame.get("type")
        if kind in ("ping", "started", "attached"):
            armed = True
        if kind == "ping" and frame.get("from") == "cloud":
            cloud_marks = True
        else:
            machine = time.monotonic()
        if kind in ("stdout", "stderr"):
            if isinstance(frame.get("b64"), str):
                data = base64.b64decode(frame["b64"])
            else:
                data = (frame.get("data") if isinstance(frame.get("data"), str) else "").encode()
            if data:
                progressed = True
            await collector.output(kind, data)
        elif kind == "started":
            collector.started = True
            if frame.get("resumable") is True and isinstance(frame.get("id"), str):
                collector.exec_id = frame["id"]
            if isinstance(frame.get("key"), str):
                collector.key = frame["key"]
        elif kind == "attached":
            collector.started = True
            if isinstance(frame.get("id"), str):
                collector.exec_id = frame["id"]
        elif kind == "gap":
            if frame.get("stream") in ("stdout", "stderr") and isinstance(frame.get("to"), int):
                collector.gap(frame["stream"], frame["to"])
            progressed = True
        elif kind == "ping":
            if frame.get("from") != "cloud":
                progressed = progressed or collector.exec_id is not None
        elif kind == "exit":
            ending = Ending("exit", exit=frame)
        elif kind == "error":
            ending = Ending("error", message=frame["message"] if isinstance(frame.get("message"), str) else "unknown")
        elif kind == "detached":
            reason = frame["reason"] if isinstance(frame.get("reason"), str) else "the server let go of the stream"
            ending = Ending("break", message=reason, progressed=progressed)

    chunks = response.aiter_bytes()
    try:
        while ending is None:
            limits = []
            if armed:
                limits.append(heard + idle)
            if cloud_marks:
                limits.append(machine + idle)
            try:
                if limits:
                    chunk = await asyncio.wait_for(chunks.__anext__(), max(0.0, min(limits) - time.monotonic()))
                else:
                    chunk = await chunks.__anext__()
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                return Ending("break", message=f"nothing from the sandbox for {idle:g} s", progressed=progressed)
            heard = time.monotonic()
            buffer += chunk
            while ending is None and b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                await handle(line)
        if ending is None and buffer.strip():
            await handle(buffer)
    except OutputCallbackError:
        raise
    except (httpx.HTTPError, httpx.StreamError, OSError) as error:
        # an exit that arrived stands, whatever stopped the reading after it
        if ending is None:
            return Ending("break", message=str(error), progressed=progressed)
    finally:
        await response.aclose()
    return ending or Ending("break", message="the stream ended without an exit status", progressed=progressed)


def ambiguous(error: KyoraError) -> bool:
    """a failure that leaves open whether kyora started the command: no answer, a gateway, an internal
    error, a restart"""
    return error.status in (0, 500, 502, 504) or error.code == "do_reset"


def reattachable(error: KyoraError) -> bool:
    """worth another reattach: no answer, a retryable error, or a key whose start kyora can't tell yet"""
    return error.retryable or error.code == "exec_key_unknown"


def request_body(request: ExecInput) -> dict[str, Any]:
    model = request if isinstance(request, ExecRequest) else ExecRequest.model_validate(dict(request))
    return model.model_dump(mode="json", by_alias=True, exclude_unset=True)


First = Callable[[float], Awaitable[httpx.Response]]
Rejoin = Callable[[float], Awaitable[httpx.Response]]


@dataclass
class Output:
    stream: Stream
    data: bytes


class ExecStream:
    """A running command's output as it arrives, Output(stream, data) by Output; `.result` once it ends.
    Use it as `async with kyora.exec.stream(...) as stream: async for chunk in stream: ...`. Leaving early
    cancels the call, and with it the command unless cancel_on_cancel=False."""

    def __init__(self, start: Callable[[OnOutput], Awaitable[ExecResult]], buffer: int = 64) -> None:
        self._queue: asyncio.Queue[Output] = asyncio.Queue(buffer)
        self._start = start
        self._task: asyncio.Task[ExecResult] | None = None
        self.result: ExecResult | None = None

    def __aiter__(self) -> ExecStream:
        return self

    async def __anext__(self) -> Output:
        if self._task is None:
            self._task = asyncio.ensure_future(self._start(lambda stream, data: self._queue.put(Output(stream, data))))
        while True:
            if not self._queue.empty():
                return self._queue.get_nowait()
            if self._task.done():
                self.result = self._task.result()
                raise StopAsyncIteration
            getter = asyncio.ensure_future(self._queue.get())
            try:
                await asyncio.wait({getter, self._task}, return_when=asyncio.FIRST_COMPLETED)
                if getter.done():
                    return getter.result()
            finally:
                if not getter.done():
                    getter.cancel()

    async def __aenter__(self) -> ExecStream:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


class Exec:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def run(self, sandbox: str, request: ExecInput, **options: Unpack[ExecOptions]) -> ExecResult:
        """Runs a command and collects its output. The command is resumable under its key: when the stream
        breaks it keeps running, and this reattaches from the bytes already read, so the output is
        continuous. At the deadline it stops waiting (ExecDetachedError) and the command keeps running."""
        body = request_body(request)
        key = body.get("key") or random_key("sdk-")
        body = {**body, "resumable": True, "key": key}
        collector = Collector(options.get("max_output_bytes", DEFAULT_MAX_OUTPUT), options.get("on_output"), key)
        stdin = len((body.get("stdin") or "").encode())
        start = START_TIMEOUT + math.ceil(stdin / 16) / 1000
        parts = RequestParts(path={"id": sandbox}, body=body, keyed=True, headers_timeout=start)

        def first(until: float) -> Awaitable[httpx.Response]:
            return self._transport.send("execCommand", parts, _deadline(until))

        def rejoin(window: float) -> Awaitable[httpx.Response]:
            again = RequestParts(
                path={"id": sandbox}, body=body, keyed=True, headers_timeout=min(START_TIMEOUT, window)
            )
            return self._transport.send("execCommand", again, {"retry": False})

        return await self._drive(sandbox, collector, options, first, rejoin)

    def stream(self, sandbox: str, request: ExecInput, **options: Unpack[ExecOptions]) -> ExecStream:
        """`run`, with the output as an async iterator of Output(stream, data); `.result` once it ends"""
        return ExecStream(lambda on_output: self.run(sandbox, request, **{**options, "on_output": on_output}))

    async def attach(
        self, sandbox: str, exec_id: str, *, from_: ByteOffsets | None = None, **options: Unpack[ExecOptions]
    ) -> ExecResult:
        """The rest of a running or finished command's output, from `from_` (default the start), to its exit."""
        collector = Collector(options.get("max_output_bytes", DEFAULT_MAX_OUTPUT), options.get("on_output"), None)
        collector.exec_id = exec_id
        if from_ is not None:
            collector.offsets = ByteOffsets(from_.stdout, from_.stderr)

        def first(until: float) -> Awaitable[httpx.Response]:
            return self._attach_once(sandbox, collector, _deadline(until))

        return await self._drive(sandbox, collector, options, first, None)

    async def cancel(self, sandbox: str, exec_id: str, **options: Unpack[CallOptions]) -> ExecCancelResponse:
        """stops a resumable command"""
        answer = await self._transport.json(
            "cancelExec", RequestParts(path={"id": sandbox, "execId": exec_id}), options
        )
        return ExecCancelResponse.model_validate(answer)

    def _attach_once(
        self, sandbox: str, collector: Collector, options: CallOptions, headers: float = ATTACH_TIMEOUT
    ) -> Awaitable[httpx.Response]:
        offsets = collector.offsets
        parts = RequestParts(
            path={"id": sandbox, "execId": collector.exec_id or ""},
            query={"from": f"{offsets.stdout},{offsets.stderr}"},
            headers_timeout=min(ATTACH_TIMEOUT, headers),
        )
        return self._transport.send("attachExec", parts, options)

    async def _drive(
        self, sandbox: str, collector: Collector, options: Mapping[str, Any], first: First, rejoin: Rejoin | None
    ) -> ExecResult:
        until = end_of(options)  # type: ignore[arg-type]
        idle = options.get("idle", DEFAULT_IDLE)
        window = options.get("reattach_window", DEFAULT_WINDOW)

        def detached(code: str, message: str) -> ExecDetachedError:
            return ExecDetachedError(
                f"exec in {sandbox}: {message}; the command may still be running",
                code=code,
                status=0,
                operation="execCommand",
                exec_id=collector.exec_id,
                key=collector.key,
                offsets=ByteOffsets(collector.offsets.stdout, collector.offsets.stderr),
            )

        def later(error: KyoraError) -> ExecDetachedError:
            """kyora asked to wait past the window or the deadline: its error, with what to reattach to"""
            return ExecDetachedError(
                f"{error.message}; the command may still be running",
                code=error.code,
                status=error.status,
                operation=error.operation or "execCommand",
                class_=error.class_,
                retryable=error.retryable,
                retry_after=error.retry_after,
                body=error.body,
                exec_id=collector.exec_id,
                key=collector.key,
                offsets=ByteOffsets(collector.offsets.stdout, collector.offsets.stderr),
            )

        def past_deadline() -> bool:
            return time.time() >= until

        async def loop() -> ExecResult:
            asked: tuple[float, KyoraError] | None = None
            try:
                ending = await read_stream(await first(until), collector, idle)
            except KyoraError as error:
                # no answer, or one that may have come after the command started: its key finds it, if it did
                if rejoin is None or past_deadline() or not ambiguous(error):
                    raise
                ending = Ending("break", message=str(error))
                if error.retry_after is not None:
                    asked = (error.retry_after, error)
            episode_end = 0.0
            delay = BASE_DELAY
            fresh = True
            while True:
                if ending.kind == "exit":
                    return collector.result(ending.exit)
                if ending.kind == "error":
                    raise make_error(
                        f"exec in {sandbox}: {ending.message}", code="exec_error", status=0, operation="execCommand"
                    )
                # a command that started without an id can't be reattached, and sending it again could run it twice
                if not collector.exec_id and not (rejoin is not None and collector.untouched):
                    raise detached(
                        "stream_lost",
                        f"the stream broke ({ending.message}) and kyora never named the command, "
                        "so it can't be reattached",
                    )
                if fresh or ending.progressed:
                    episode_end, delay, fresh = time.time() + window, BASE_DELAY, False
                last = ending.message
                response: httpx.Response | None = None
                while response is None:
                    if asked is not None and time.time() + asked[0] >= min(episode_end, until):
                        raise later(asked[1])
                    if time.time() >= episode_end:
                        raise detached(
                            "stream_lost", f"lost the stream ({last}) and could not reattach within {window:g} s"
                        )
                    await asyncio.sleep(min(asked[0] if asked else delay, episode_end - time.time()))
                    asked = None
                    delay = min(MAX_DELAY, delay * 2)
                    remaining = episode_end - time.time()
                    if remaining <= 0:
                        continue
                    try:
                        # without an id, the key finds the command again: kyora answers it with its id
                        if collector.exec_id:
                            response = await self._attach_once(sandbox, collector, {"retry": False}, remaining)
                        else:
                            assert rejoin is not None
                            response = await rejoin(remaining)
                    except KyoraError as failure:
                        if not reattachable(failure):
                            raise
                        last = str(failure)
                        if failure.retry_after is not None:
                            asked = (failure.retry_after, failure)
                ending = await read_stream(response, collector, idle)

        try:
            remaining = left(until)
            if remaining is None:
                return await loop()
            return await asyncio.wait_for(loop(), max(0.0, remaining))
        except OutputCallbackError as error:
            raise error.error from None
        except asyncio.CancelledError:
            if options.get("cancel_on_cancel", True) and collector.exec_id:
                try:
                    await asyncio.wait_for(self.cancel(sandbox, collector.exec_id), CANCEL_TIMEOUT)
                except (KyoraError, asyncio.TimeoutError):
                    pass
            raise
        except asyncio.TimeoutError:
            raise detached("timeout", "the deadline passed") from None
        except KyoraError as error:
            if not past_deadline() or isinstance(error, ExecDetachedError):
                raise
            # a Retry-After past the deadline comes back as its own error: the command never started
            if error.code != "timeout" and not collector.exec_id and error.status != 0:
                raise
            raise detached("timeout", "the deadline passed") from error


def _deadline(until: float) -> CallOptions:
    return {} if until == math.inf else {"deadline": until}
