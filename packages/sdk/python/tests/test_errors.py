from email.utils import formatdate

import pytest
from fakes import error, json

from kyora import ConflictError, KyoraError, LimitError, TransientError
from kyora._errors import classify, from_response, retry_after_seconds

pytestmark = pytest.mark.anyio


def answer(response):
    return from_response(
        "op", response.status_code, response.content.decode(), response.headers.get("retry-after"), 1_000.0
    )


def test_class_and_retryability_come_from_the_catalog():
    assert classify("waking", 503) == ("transient", True)
    assert classify("quota_exceeded", 429) == ("limit", False)
    assert classify("name_taken", 409) == ("conflict", False)
    assert classify("unauthorized", 401) == ("auth", False)
    assert classify("not_found", 404) == ("not_found", False)
    assert classify("invalid_request", 400) == ("invalid", False)


def test_a_list_of_statuses_makes_a_code_retryable_only_after_those():
    assert classify("download_failed", 502)[1] is True
    assert classify("download_failed", 400)[1] is False
    assert classify("egress_unavailable", 503)[1] is True
    assert classify("egress_unavailable", 501)[1] is False


def test_a_code_newer_than_the_catalog_is_taken_by_its_status():
    assert classify("brand_new_code", 503) == ("transient", True)
    assert classify("brand_new_code", 429) == ("transient", True)
    assert classify("brand_new_code", 409) == ("conflict", False)
    assert classify("brand_new_code", 403) == ("auth", False)
    assert classify("brand_new_code", 500) == ("unavailable", False)


def test_reads_code_message_retryable_and_retry_after_from_the_body():
    failure = answer(error(503, "no_capacity", {"retryable": True, "retryAfterMs": 1500}, {"retry-after": "2"}))
    assert isinstance(failure, TransientError)
    assert (failure.code, failure.status, failure.class_, failure.retryable) == ("no_capacity", 503, "transient", True)
    assert failure.retry_after == 1.5
    assert failure.operation == "op"
    assert "no_capacity happened" in str(failure)


def test_falls_back_to_retry_after_then_to_the_catalog():
    assert answer(error(503, "rate_limited", {}, {"retry-after": "3"})).retry_after == 3
    assert answer(error(503, "waking", {"retryable": False})).retryable is False


def test_an_answer_without_a_json_body_is_still_an_error_with_a_status():
    import httpx

    failure = answer(httpx.Response(502, text="<html>bad gateway</html>"))
    assert (failure.code, failure.class_, failure.retryable) == ("http_502", "transient", True)
    assert failure.message == "op: HTTP 502"


def test_retry_after_as_an_http_date():
    assert retry_after_seconds(formatdate(10.0, usegmt=True), 4.0) == 6.0
    assert retry_after_seconds("soon", 0) is None
    assert retry_after_seconds(None, 0) is None


async def test_errors_are_subclasses_by_class(client):
    kyora, _ = client(lambda r, i: error(429, "sandbox_limit"))
    with pytest.raises(LimitError) as caught:
        await kyora.sandboxes.create()
    assert isinstance(caught.value, KyoraError)
    assert not isinstance(caught.value, ConflictError)


async def test_a_404_on_delete_is_false_not_an_error(client):
    kyora, _ = client(lambda r, i: error(404, "not_found") if r.url.path.endswith("/sb_gone") else json(204))
    assert await kyora.sandboxes.delete("sb_gone") is False
    assert await kyora.sandboxes.delete("sb_here") is True
