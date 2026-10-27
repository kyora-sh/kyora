from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from ._errors import make_error
from ._http import WaitOptions

T = TypeVar("T")


@dataclass
class ListPage(Generic[T]):
    """One page of a listing. `next_cursor` is set while more rows follow; pass it as `cursor`."""

    items: list[T]
    next_cursor: str | None


class ListOptions(WaitOptions, total=False):
    labels: Mapping[str, str]
    """every pair must match (`label=key=value` on the wire)"""
    limit: int
    """the most rows a page holds, 1 to 1000 (kyora's default is 500)"""
    cursor: str
    """the next_cursor of the previous page"""


def label_query(labels: Mapping[str, str] | None) -> list[str] | None:
    """label pairs as the `label` query parameter repeats them"""
    return None if labels is None else [f"{key}={value}" for key, value in labels.items()]


def matching(rows: list[T], labels: Mapping[str, str] | None) -> list[T]:
    """rows that carry every pair: a server that ignored the filter never widens a listing"""
    if not labels:
        return rows

    def carries(row: Any) -> bool:
        have = getattr(row, "labels", None) or {}
        return all(have.get(key) == value for key, value in labels.items())

    return [row for row in rows if carries(row)]


async def follow(
    operation: str, fetch_page: Callable[[str | None], Awaitable[ListPage[T]]], cursor: str | None = None
) -> AsyncIterator[T]:
    """Every row of a listing, page by page, from `cursor` on. A cursor that comes back again ends it
    with an error instead of looping, so a partial listing is never passed off as the whole."""
    seen: set[str] = set()
    while True:
        page = await fetch_page(cursor)
        for item in page.items:
            yield item
        if not page.next_cursor:
            return
        if page.next_cursor in seen:
            raise make_error(
                f"{operation}: the server answered the same next_cursor twice",
                code="bad_response",
                status=0,
                operation=operation,
            )
        seen.add(page.next_cursor)
        cursor = page.next_cursor
