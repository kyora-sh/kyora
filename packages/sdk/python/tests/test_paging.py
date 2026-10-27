import pytest
from fakes import json, sandbox
from test_files import snap

from kyora import KyoraError

pytestmark = pytest.mark.anyio


async def test_list_sends_labels_limit_and_cursor_and_returns_the_next_cursor(client):
    kyora, requests = client(
        lambda r, i: json(200, {"sandboxes": [sandbox("sb_1", labels={"team": "docs"})], "next_cursor": "c2"})
    )
    page = await kyora.sandboxes.list(labels={"team": "docs", "agent.kind": "reader"}, limit=50, cursor="c1")
    params = requests[0].url.params
    assert params.get_list("label") == ["team=docs", "agent.kind=reader"]
    assert (params["limit"], params["cursor"]) == ("50", "c1")
    assert page.next_cursor == "c2"
    assert page.items == []


async def test_the_last_page_has_no_cursor(client):
    kyora, _ = client(lambda r, i: json(200, {"sandboxes": [sandbox("sb_1")]}))
    assert (await kyora.sandboxes.list()).next_cursor is None


async def test_iterate_follows_next_cursor_to_the_end(client):
    pages = {
        None: {"sandboxes": [sandbox("sb_1"), sandbox("sb_2")], "next_cursor": "p2"},
        "p2": {"sandboxes": [sandbox("sb_3")], "next_cursor": "p3"},
        "p3": {"sandboxes": [sandbox("sb_4")]},
    }
    kyora, requests = client(lambda r, i: json(200, pages[r.url.params.get("cursor")]))
    assert [s.id async for s in kyora.sandboxes.iterate(limit=2)] == ["sb_1", "sb_2", "sb_3", "sb_4"]
    assert [r.url.params.get("cursor") for r in requests] == [None, "p2", "p3"]
    assert all(r.url.params["limit"] == "2" for r in requests)


async def test_iterate_stops_early_without_fetching_further_pages(client):
    kyora, requests = client(
        lambda r, i: json(200, {"sandboxes": [sandbox("sb_1"), sandbox("sb_2")], "next_cursor": "more"})
    )
    async for found in kyora.sandboxes.iterate():
        if found.id == "sb_1":
            break
    assert len(requests) == 1


async def test_a_cursor_that_comes_back_again_is_an_error_not_a_loop(client):
    kyora, _ = client(lambda r, i: json(200, {"sandboxes": [sandbox("sb_1")], "next_cursor": "same"}))
    ids = []
    with pytest.raises(KyoraError) as caught:
        async for found in kyora.sandboxes.iterate():
            ids.append(found.id)
    assert caught.value.code == "bad_response"
    assert ids == ["sb_1", "sb_1"]


async def test_snapshots_page_the_same_way(client):
    kyora, requests = client(
        lambda r, i: (
            json(200, {"snapshots": [snap("ready", "snap_2")]})
            if r.url.params.get("cursor")
            else json(200, {"snapshots": [snap("ready", "snap_1")], "next_cursor": "n"})
        )
    )
    assert [s.id async for s in kyora.snapshots.iterate(labels={"run": "7"})] == ["snap_1", "snap_2"]
    assert requests[0].url.path == "/v1/snapshots"
    assert requests[1].url.params.get_list("label") == ["run=7"]
