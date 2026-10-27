from __future__ import annotations

import asyncio
import inspect
import json as jsonlib
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import respx

from kyora import AsyncKyora, Retry

BASE = "https://kyora.test"
ID = "0123456789abcdef0123456789abcdef"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@dataclass
class Recorded:
    method: str
    url: httpx.URL
    headers: httpx.Headers
    body: bytes
    json: Any


Handler = Callable[[Recorded, int], Any]


class Fake:
    """answers every request from `handler` and records it"""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[Recorded] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        try:
            parsed = jsonlib.loads(body) if body else None
        except ValueError:
            parsed = None
        recorded = Recorded(request.method, request.url, request.headers, body, parsed)
        self.requests.append(recorded)
        answer = self.handler(recorded, len(self.requests) - 1)
        if inspect.isawaitable(answer):
            answer = await answer
        return answer


def json(status: int, body: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
    if status == 204:
        return httpx.Response(204, headers=headers)
    return httpx.Response(status, json=body, headers=headers)


def error(status: int, code: str, extra: dict[str, Any] | None = None, headers: dict[str, str] | None = None):
    return json(status, {"error": code, "message": f"{code} happened", **(extra or {})}, headers)


class Lines(httpx.AsyncByteStream):
    def __init__(self, chunks: list[Any], hang: bool, broken: bool) -> None:
        self.chunks = chunks
        self.hang = hang
        self.broken = broken
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield (chunk if isinstance(chunk, str) else jsonlib.dumps(chunk) + "\n").encode()
        if self.broken:
            raise httpx.ReadError("connection reset")
        if self.hang:
            await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.closed = True


def ndjson(chunks: list[Any], *, hang: bool = False, broken: bool = False, headers: dict[str, str] | None = None):
    """an NDJSON stream, one chunk per entry (a string is sent as is); `hang`: stays open after the last"""
    return httpx.Response(
        200,
        headers={"content-type": "application/x-ndjson", **(headers or {})},
        stream=Lines(chunks, hang, broken),
    )


def hang() -> Any:
    return asyncio.Event().wait()


def sandbox(id: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": id,
        "status": "running",
        "shareable": True,
        "network": "none",
        "egressAllow": [],
        "vcpus": 2,
        "allocatedVcpus": 2,
        "memoryMb": 4096,
        "diskGb": 30,
        "image": "default",
        "labels": {},
        "ttlSeconds": 3600,
        "idleSeconds": 0,
        "createdAt": "2026-01-01T00:00:00Z",
        "expiresAt": None,
        **extra,
    }


@pytest.fixture
def client(respx_mock: respx.MockRouter):
    made: list[AsyncKyora] = []

    def make(handler: Handler, **options: Any) -> tuple[AsyncKyora, list[Recorded]]:
        fake = Fake(handler)
        respx_mock.route(url__startswith=BASE).mock(side_effect=fake)
        options.setdefault("retry", Retry(base_delay=0.001, max_delay=0.005))
        kyora = AsyncKyora(token="kyora_test", base_url=BASE, **options)
        made.append(kyora)
        return kyora, fake.requests

    return make
