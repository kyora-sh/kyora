from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypedDict, TypeVar
from urllib.parse import quote, urlencode

import httpx

from ._error_codes import SPEC_VERSION
from ._errors import KyoraError, from_response, make_error
from ._operations import OPERATIONS

DEFAULT_BASE_URL = "https://cloud.kyora.sh"
USER_AGENT = f"kyora-sdk-python (api {SPEC_VERSION})"

T = TypeVar("T")


@dataclass(frozen=True)
class Retry:
    """How a call repeats a request that failed in a way that can succeed later."""

    max_attempts: int = 4
    """tries in all, the first included"""
    base_delay: float = 0.25
    """seconds: the first backoff when kyora sends no Retry-After; doubled per try"""
    max_delay: float = 5.0
    """seconds: the longest backoff"""
    max_retry_after: float = 30.0
    """seconds: a Retry-After longer than this is never waited out; the error is raised instead"""


DEFAULT_RETRY = Retry()


class WaitOptions(TypedDict, total=False):
    """Bounds on how long a call may take. Both bound the whole call, waits and retries included; a
    Retry-After that would end past them is raised as the error it came with instead of waited out.
    Cancel the task to stop a call."""

    timeout: float
    """seconds from the start of the call"""
    deadline: float | datetime
    """an absolute end: epoch seconds or an aware datetime"""


class CallOptions(WaitOptions, total=False):
    retry: Retry | Literal[False]
    """False: one try only"""
    headers: Mapping[str, str]


QueryValue = str | int | float | bool | Sequence[str] | None
Body = Any


@dataclass
class RequestParts:
    path: Mapping[str, str | int] | None = None
    query: Mapping[str, QueryValue] | None = None
    body: Body = None
    """a JSON body, or the raw body (bytes or an async iterable of bytes) of an operation that takes bytes"""
    content_type: str | None = None
    idempotency_key: str | None = None
    """an explicit Idempotency-Key; an operation that takes one gets a fresh key otherwise"""
    keyed: bool = False
    """the request carries its own idempotency (an exec `key`), so it repeats safely"""
    accept: tuple[int, ...] = ()
    """statuses besides 2xx to hand back instead of raising"""
    headers_timeout: float | None = None
    """for streamed answers: how long the response may take to start"""


REPEATABLE_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "PATCH"})
TOKEN = re.compile(r"^[\x21-\x7e]+$")
SEGMENT = re.compile(r"\{([A-Za-z0-9_]+)\}")
INF = math.inf


def end_of(options: WaitOptions, fallback: float | None = None) -> float:
    """the epoch seconds a call must end by, or inf"""
    now = time.time()
    timeout = options.get("timeout", fallback)
    by_timeout = INF if timeout is None else now + timeout
    deadline = options.get("deadline")
    by_deadline = INF if deadline is None else deadline.timestamp() if isinstance(deadline, datetime) else deadline
    return min(by_timeout, by_deadline)


def timeout_error(operation: str) -> KyoraError:
    return make_error(f"{operation}: the deadline passed", code="timeout", status=0, operation=operation)


def random_key(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4()}"


def left(until: float) -> float | None:
    """seconds to `until`, None for no bound"""
    return None if until == INF else until - time.time()


async def within(awaitable: Awaitable[T], until: float, operation: str) -> T:
    """`awaitable`, or a timeout error at `until`"""
    remaining = left(until)
    if remaining is None:
        return await awaitable
    try:
        return await asyncio.wait_for(awaitable, max(0.0, remaining))
    except asyncio.TimeoutError:
        raise timeout_error(operation) from None


Reader = Callable[[httpx.Response, int], Awaitable[T]]


class Transport:
    def __init__(
        self,
        *,
        base_url: str,
        token: str | None,
        client: httpx.AsyncClient,
        timeout: float,
        retry: Retry | Literal[False],
        user_agent: str,
    ) -> None:
        if token is not None and not TOKEN.match(token):
            raise ValueError(
                "the kyora token has characters an HTTP header can't carry (spaces, line breaks or non-ASCII)"
            )
        self.base_url = base_url
        self._token = token
        self.client = client
        self.timeout = timeout
        self.retry = retry
        self.user_agent = user_agent

    def __repr__(self) -> str:
        return f"Transport(base_url={self.base_url!r}, token={'[token]' if self._token else None})"

    def redact(self, text: str) -> str:
        """an error text with the token taken out"""
        return text.replace(self._token, "[token]") if self._token else text

    def url(self, operation: str, parts: RequestParts | None = None) -> str:
        """the URL of an operation with its path and query parameters filled in"""
        parts = parts or RequestParts()
        spec = OPERATIONS[operation]

        def invalid(message: str) -> KyoraError:
            return make_error(
                f"{operation}: {message}",
                code="invalid_request",
                status=0,
                class_="invalid",
                retryable=False,
                operation=operation,
            )

        def fill(match: re.Match[str]) -> str:
            name = match.group(1)
            value = (parts.path or {}).get(name)
            if value is None or value == "":
                raise invalid(f"{name} is required")
            # an object key takes the rest of the path, its slashes included
            segments = str(value).split("/") if name == "objectKey" else [str(value)]
            if any(segment in (".", "..") for segment in segments):
                raise invalid(f'{name} may not have "." or ".." segments')
            return "/".join(quote(segment, safe="") for segment in segments)

        path = SEGMENT.sub(fill, spec["path"])
        pairs: list[tuple[str, str]] = []
        for name, value in (parts.query or {}).items():
            if value is None:
                continue
            if isinstance(value, (list, tuple)):
                pairs.extend((name, str(item)) for item in value)
            elif isinstance(value, bool):
                pairs.append((name, "true" if value else "false"))
            else:
                pairs.append((name, str(value)))
        text = urlencode(pairs, quote_via=quote)
        return f"{self.base_url}{path}{'?' + text if text else ''}"

    async def send(
        self, operation: str, parts: RequestParts | None = None, options: CallOptions | None = None
    ) -> httpx.Response:
        """a call whose open response the caller reads (a stream) and closes"""
        return await self._request(operation, parts or RequestParts(), options or {}, None)

    async def json(self, operation: str, parts: RequestParts | None = None, options: CallOptions | None = None) -> Any:
        """a call whose answer is JSON (or None, on a 204)"""

        async def read(response: httpx.Response, _: int) -> Any:
            return read_json(operation, response.status_code, await response.aread())

        return await self._request(operation, parts or RequestParts(), options or {}, read)

    async def read(self, operation: str, parts: RequestParts, options: CallOptions, reader: Reader[T]) -> T:
        """a call whose response `reader` reads, inside the call's retries and deadline"""
        return await self._request(operation, parts, options, reader)

    async def _request(self, operation: str, parts: RequestParts, options: CallOptions, reader: Reader[Any] | None):
        """One call: retried while the error is retryable and the request is safe to repeat (a read, a
        PUT, PATCH or DELETE, or a request carrying an idempotency key), honouring Retry-After within
        the call's deadline."""
        spec = OPERATIONS[operation]
        streamed = spec["response"] in ("ndjson", "binary")
        until = end_of(options, None if streamed else self.timeout)
        override = options.get("retry")
        retry = None if override is False or self.retry is False else override or self.retry
        headers = dict(options.get("headers") or {})
        keyed = parts.keyed
        if spec["idempotency_key"]:
            headers["Idempotency-Key"] = parts.idempotency_key or random_key("sdk-")
            keyed = True
        replayable = not isinstance(parts.body, AsyncIterable)

        def repeatable(error: KyoraError) -> bool:
            if not replayable or not error.retryable:
                return False
            if keyed or spec["method"] in REPEATABLE_METHODS:
                return True
            # an unkeyed write is repeated only when kyora refused it outright
            return error.status == 429

        attempt = 0
        while True:
            attempt += 1
            try:
                return await self._answer(operation, parts, headers, until, reader, attempt)
            except KyoraError as caught:
                error = caught
            if retry is None or attempt >= retry.max_attempts or not repeatable(error) or error.code == "timeout":
                raise error
            backoff = min(retry.max_delay, retry.base_delay * 2 ** (attempt - 1))
            wait = error.retry_after if error.retry_after is not None else backoff
            if wait > retry.max_retry_after or time.time() + wait >= until:
                raise error
            await asyncio.sleep(wait)

    async def _answer(
        self,
        operation: str,
        parts: RequestParts,
        headers: Mapping[str, str],
        until: float,
        reader: Reader[Any] | None,
        attempt: int,
    ):
        """one try: the response read by `reader`, the open response without one, or a KyoraError"""
        response = await self._once(operation, parts, headers, until)
        keep = False
        try:
            if response.is_success or response.status_code in parts.accept:
                if reader is None:
                    keep = True
                    return response
                return await within(reader(response, attempt), until, operation)
            text = (await within(response.aread(), until, operation)).decode("utf-8", "replace")
            raise from_response(operation, response.status_code, text, response.headers.get("retry-after"), time.time())
        except (httpx.HTTPError, OSError) as caught:
            raise self._wrap(operation, "the answer broke off", caught) from None
        finally:
            if not keep:
                await response.aclose()

    def _wrap(self, operation: str, what: str, error: BaseException) -> KyoraError:
        detail = self.redact(str(error) or type(error).__name__)
        return make_error(f"{operation}: {what} ({detail})", code="network_error", status=0, operation=operation)

    async def _once(
        self, operation: str, parts: RequestParts, extra: Mapping[str, str], until: float
    ) -> httpx.Response:
        """one request and its answer's headers; never retried. Failures are KyoraErrors."""
        try:
            return await self._attempt(operation, parts, extra, until)
        except KyoraError:
            raise
        except (httpx.HTTPError, OSError) as error:
            raise self._wrap(operation, f"can't reach {self.base_url}", error) from None

    async def _attempt(self, operation: str, parts: RequestParts, extra: Mapping[str, str], until: float):
        spec = OPERATIONS[operation]
        headers = {"user-agent": self.user_agent, **extra}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        content: Any = None
        if parts.body is not None and spec["body"] == "json":
            headers["content-type"] = "application/json"
            content = json.dumps(parts.body, separators=(",", ":")).encode()
        elif parts.body is not None and spec["body"] == "binary":
            headers["content-type"] = parts.content_type or next(
                iter(spec["content_types"]), "application/octet-stream"
            )
            content = parts.body
        url = self.url(operation, parts)
        remaining = left(until)
        if remaining is not None and remaining <= 0:
            raise timeout_error(operation)
        bound = min(x for x in (remaining, parts.headers_timeout, INF) if x is not None)
        request = self.client.build_request(spec["method"], url, headers=headers, content=content)
        try:
            sending = self.client.send(request, stream=True, follow_redirects=False)
            response = await (asyncio.wait_for(sending, bound) if bound != INF else sending)
        except asyncio.TimeoutError:
            raise timeout_error(operation) from None
        if 300 <= response.status_code < 400:
            await response.aclose()
            # a redirect would carry the token to wherever it points
            raise make_error(
                f"{operation}: {self.base_url} redirected to {response.headers.get('location', '?')}; check base_url",
                code="bad_response",
                status=response.status_code,
                operation=operation,
            )
        return response


def read_json(operation: str, status: int, data: bytes) -> Any:
    if status == 204 or not data:
        return None
    try:
        return json.loads(data)
    except ValueError:
        raise make_error(
            f"{operation}: the answer is not JSON", code="bad_response", status=status, operation=operation
        ) from None
