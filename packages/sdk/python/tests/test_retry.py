import asyncio
import re
import time

import httpx
import pytest
from fakes import error, hang, json, sandbox

from kyora import AsyncKyora, KyoraError, Retry

pytestmark = pytest.mark.anyio

TICKET = {
    "status": "queued",
    "position": 1,
    "ahead": 0,
    "depth": 1,
    "enqueuedAt": "2026-01-01T00:00:00Z",
    "waitUntil": "2026-01-01T00:05:00Z",
}


def ticket(name, **extra):
    return {**TICKET, "ticket": name, "poll": f"/v1/queue/{name}", **extra}


async def test_a_read_is_repeated_after_the_retry_after_kyora_asks_for(client):
    kyora, requests = client(
        lambda r, i: (
            error(503, "waking", {"retryable": True, "retryAfterMs": 30}) if i == 0 else json(200, sandbox("sb_1"))
        )
    )
    started = time.monotonic()
    assert (await kyora.sandboxes.get("sb_1")).id == "sb_1"
    assert len(requests) == 2
    assert time.monotonic() - started >= 0.025


async def test_a_retry_after_past_the_deadline_is_raised_at_once(client):
    kyora, requests = client(lambda r, i: error(503, "waking", {"retryable": True, "retryAfterMs": 10_000}))
    started = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        await kyora.sandboxes.get("sb_1", timeout=2)
    assert time.monotonic() - started < 0.5
    assert (caught.value.code, caught.value.retry_after) == ("waking", 10)
    assert len(requests) == 1


async def test_a_retry_after_past_max_retry_after_is_raised_too(client):
    kyora, requests = client(
        lambda r, i: error(429, "rate_limited", {}, {"retry-after": "60"}), retry=Retry(max_retry_after=1)
    )
    with pytest.raises(KyoraError) as caught:
        await kyora.me()
    assert (caught.value.code, caught.value.retry_after) == ("rate_limited", 60)
    assert len(requests) == 1


async def test_a_non_retryable_error_is_never_repeated(client):
    kyora, requests = client(lambda r, i: error(409, "name_taken"))
    with pytest.raises(KyoraError) as caught:
        await kyora.sandboxes.update("sb_1", {"name": "x"})
    assert (caught.value.code, caught.value.class_, caught.value.retryable) == ("name_taken", "conflict", False)
    assert len(requests) == 1


async def test_gives_up_after_max_attempts(client):
    kyora, requests = client(
        lambda r, i: error(503, "node_offline"), retry=Retry(max_attempts=3, base_delay=0.001, max_delay=0.002)
    )
    with pytest.raises(KyoraError, match="node_offline"):
        await kyora.sandboxes.get("sb_1")
    assert len(requests) == 3


async def test_no_answer_at_all_is_retried_for_a_read(client):
    def handler(r, i):
        if i == 0:
            raise httpx.ConnectError("connection reset")
        return json(200, sandbox("sb_1"))

    kyora, requests = client(handler)
    assert (await kyora.sandboxes.get("sb_1")).id == "sb_1"
    assert len(requests) == 2


async def test_an_unkeyed_write_is_repeated_on_a_429_only(client):
    port = {"label": "web", "port": 80, "private": True, "trusted": False, "url": "https://x.test"}
    kyora, requests = client(
        lambda r, i: error(429, "rate_limited", {}, {"retry-after": "0"}) if i == 0 else json(201, port)
    )
    assert (await kyora.ports.expose("sb_1", 80)).label == "web"
    assert len(requests) == 2


async def test_an_unkeyed_write_is_never_repeated_after_a_503_that_may_have_run_it(client):
    kyora, requests = client(lambda r, i: error(503, "do_reset", {"retryable": True, "retryAfterMs": 1}))
    with pytest.raises(KyoraError, match="do_reset"):
        await kyora.ports.expose("sb_1", 80)
    assert len(requests) == 1


async def test_retry_false_makes_one_try(client):
    kyora, requests = client(lambda r, i: error(503, "waking"), retry=False)
    with pytest.raises(KyoraError):
        await kyora.sandboxes.get("sb_1")
    assert len(requests) == 1


async def test_a_cancelled_call_is_cancelled(client):
    kyora, _ = client(lambda r, i: error(503, "waking", {"retryAfterMs": 5_000}), retry=Retry(max_retry_after=60))
    task = asyncio.ensure_future(kyora.sandboxes.get("sb_1"))
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_call_past_its_timeout_is_a_timeout_error(client):
    kyora, _ = client(lambda r, i: hang())
    with pytest.raises(KyoraError) as caught:
        await kyora.me(timeout=0.03)
    error_ = caught.value
    assert (error_.code, error_.status, error_.class_, error_.retryable) == ("timeout", 0, "transient", True)


async def test_a_redirect_is_refused_so_the_token_never_follows_it(client):
    kyora, requests = client(lambda r, i: httpx.Response(302, headers={"location": "https://elsewhere.test/"}))
    with pytest.raises(KyoraError) as caught:
        await kyora.me()
    assert (caught.value.code, caught.value.status) == ("bad_response", 302)
    assert len(requests) == 1


async def test_a_body_that_is_not_json_is_bad_response(client):
    kyora, _ = client(lambda r, i: httpx.Response(200, text="<html>"))
    with pytest.raises(KyoraError, match="not JSON"):
        await kyora.me()


async def test_an_answer_that_does_not_match_the_schema_is_bad_response(client):
    kyora, _ = client(lambda r, i: json(200, {"id": "sb_1"}))
    with pytest.raises(KyoraError) as caught:
        await kyora.sandboxes.get("sb_1")
    assert caught.value.code == "bad_response"


async def test_a_create_carries_a_fresh_idempotency_key_the_same_on_every_retry(client):
    kyora, requests = client(
        lambda r, i: (
            error(503, "no_capacity", {"retryable": True, "retryAfterMs": 1}) if i < 2 else json(201, sandbox("sb_new"))
        )
    )
    assert (await kyora.sandboxes.create({"vcpus": 2})).id == "sb_new"
    keys = [r.headers.get("idempotency-key") for r in requests]
    assert len(keys) == 3
    assert re.fullmatch(r"sdk-[0-9a-f-]{36}", keys[0])
    assert len(set(keys)) == 1
    await kyora.sandboxes.create()
    assert requests[3].headers["idempotency-key"] != keys[0]


async def test_an_explicit_key_is_sent_as_given(client):
    kyora, requests = client(lambda r, i: json(201, sandbox("sb_1")))
    await kyora.sandboxes.create({}, idempotency_key="job-42")
    assert requests[0].headers["idempotency-key"] == "job-42"


async def test_operations_without_a_key_in_the_spec_get_none(client):
    kyora, requests = client(lambda r, i: json(200, sandbox("sb_1")))
    await kyora.sandboxes.get("sb_1")
    assert "idempotency-key" not in requests[0].headers


async def test_create_sends_only_the_fields_set_by_their_wire_names(client):
    kyora, requests = client(lambda r, i: json(201, sandbox("sb_1")))
    await kyora.sandboxes.create({"memory_mb": 4096, "ttlSeconds": 60, "labels": {"app": "x"}})
    assert requests[0].json == {"memoryMb": 4096, "ttlSeconds": 60, "labels": {"app": "x"}}
    with pytest.raises(ValueError):
        await kyora.sandboxes.create({"no_such_field": 1})


async def test_the_clients_region_goes_on_creates_that_name_none(client):
    kyora, requests = client(lambda r, i: json(201, sandbox("sb_1")), region="eu")
    await kyora.sandboxes.create({"vcpus": 2})
    await kyora.sandboxes.create({"region": "us"})
    assert [r.json["region"] for r in requests] == ["eu", "us"]
    assert requests[0].headers["authorization"] == "Bearer kyora_test"
    assert requests[0].headers["user-agent"].startswith("kyora-sdk-python (api ")


async def test_a_queued_create_long_polls_its_ticket_until_the_sandbox_is_placed(client):
    seen = []

    def handler(r, i):
        if i == 0:
            return json(202, ticket("q_1"))
        if i == 1:
            return json(202, ticket("q_1", position=0))
        return json(201, sandbox("sb_placed"))

    kyora, requests = client(handler)
    placed = await kyora.sandboxes.create({"wait": 30}, on_queued=lambda current: seen.append(current.position))
    assert placed.id == "sb_placed"
    assert seen == [1, 0]
    assert requests[1].url.path == "/v1/queue/q_1"
    assert int(requests[1].url.params["wait"]) > 0


async def test_a_deadline_in_line_takes_the_create_out_of_line(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_2"))
        if r.method == "DELETE":
            return json(204)
        return hang()

    kyora, requests = client(handler)
    with pytest.raises(KyoraError) as caught:
        await kyora.sandboxes.create({"wait": 60}, timeout=1.5)
    assert caught.value.code == "timeout"
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/queue/q_2")


async def test_an_outcome_error_of_the_ticket_is_the_creates_answer(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_3"))
        if r.method == "DELETE":
            return json(204)
        return error(503, "no_capacity", {"retryable": True, "retryAfterMs": 1})

    kyora, requests = client(handler)
    with pytest.raises(KyoraError, match="no_capacity"):
        await kyora.sandboxes.create({"wait": 30})
    assert len([r for r in requests if r.method == "GET"]) == 1


async def test_a_poll_lost_on_the_way_is_asked_again(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_4"))
        if i == 1:
            return httpx.Response(502, text="bad gateway")
        return json(201, sandbox("sb_q"))

    kyora, _ = client(handler)
    assert (await kyora.sandboxes.create({"wait": 30})).id == "sb_q"


async def test_dot_segments_are_refused_before_anything_is_sent(client):
    kyora, requests = client(lambda r, i: json(200, sandbox("sb_1")))
    for bad in ("..", "."):
        with pytest.raises(KyoraError) as caught:
            await kyora.sandboxes.get(bad)
        assert caught.value.code == "invalid_request"
    assert requests == []


async def test_encoded_dots_and_other_characters_stay_inside_their_segment(client):
    kyora, requests = client(lambda r, i: json(200, sandbox("sb_1")))
    await kyora.sandboxes.get("a/b?c#%2E%2E")
    assert requests[0].url.raw_path == b"/v1/sandboxes/a%2Fb%3Fc%23%252E%252E"


def test_a_token_a_header_cant_carry_is_refused_without_echoing_it():
    with pytest.raises(ValueError) as caught:
        AsyncKyora(token="kyora_bad token\n")
    assert "kyora_bad" not in str(caught.value)


async def test_the_token_is_taken_out_of_wrapped_errors(client):
    def handler(r, i):
        raise httpx.ConnectError("refused for kyora_test")

    kyora, _ = client(handler, retry=False)
    with pytest.raises(KyoraError) as caught:
        await kyora.me()
    assert caught.value.code == "network_error"
    assert "kyora_test" not in str(caught.value)
    assert "[token]" in str(caught.value)


def test_the_token_never_shows_in_repr():
    kyora = AsyncKyora(token="kyora_secret")
    assert "kyora_secret" not in repr(kyora) + repr(kyora.transport)


def test_the_token_defaults_to_kyora_token(monkeypatch):
    monkeypatch.setenv("KYORA_TOKEN", "kyora_env")
    assert AsyncKyora().transport._token == "kyora_env"
    assert AsyncKyora(token="kyora_arg").transport._token == "kyora_arg"
    assert AsyncKyora().transport.base_url == "https://cloud.kyora.sh"


async def test_a_read_whose_body_fails_is_retried(client):
    from fakes import Lines

    def handler(r, i):
        if i == 0:
            return httpx.Response(200, stream=Lines(['{"id":'], hang=False, broken=True))
        return json(200, sandbox("sb_1"))

    kyora, requests = client(handler)
    assert (await kyora.sandboxes.get("sb_1")).id == "sb_1"
    assert len(requests) == 2


async def test_a_404_on_a_retry_counts_as_deleted(client):
    kyora, _ = client(
        lambda r, i: error(503, "waking", {"retryable": True, "retryAfterMs": 1}) if i == 0 else error(404, "not_found")
    )
    assert await kyora.sandboxes.delete("sb_1") is True


async def test_call_reaches_any_operation(client):
    kyora, requests = client(lambda r, i: json(200, {"domains": []}))
    assert await kyora.call("listDomains") == {"domains": []}
    await kyora.call("createSandbox", body={}, headers={"Idempotency-Key": "mine"})
    assert requests[1].headers["idempotency-key"] == "mine"
    with pytest.raises(ValueError):
        await kyora.call("noSuchOperation")


async def test_a_stalled_on_queued_is_bounded_by_the_deadline_and_takes_the_create_out_of_line(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_5"))
        return json(204)

    async def stalled(current):
        await hang()

    kyora, requests = client(handler)
    begun = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        await kyora.sandboxes.create({"wait": 60}, on_queued=stalled, timeout=0.3)
    assert caught.value.code == "timeout"
    assert time.monotonic() - begun < 1
    assert [(r.method, r.url.path) for r in requests] == [("POST", "/v1/sandboxes"), ("DELETE", "/v1/queue/q_5")]


async def test_an_on_queued_that_raises_takes_the_create_out_of_line(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_6"))
        return json(204)

    def refuse(current):
        raise RuntimeError("no queueing")

    kyora, requests = client(handler)
    with pytest.raises(RuntimeError, match="no queueing"):
        await kyora.sandboxes.create({"wait": 30}, on_queued=refuse)
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/queue/q_6")


async def test_cancelling_during_on_queued_takes_the_create_out_of_line(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, ticket("q_7"))
        return json(204)

    async def stalled(current):
        await hang()

    kyora, requests = client(handler)
    task = asyncio.ensure_future(kyora.sandboxes.create({"wait": 30}, on_queued=stalled))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/queue/q_7")
