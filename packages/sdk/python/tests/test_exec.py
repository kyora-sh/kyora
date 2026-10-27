import asyncio
import base64
import re
import time

import httpx
import pytest
from fakes import ID, error, hang, json, ndjson

from kyora import ByteOffsets, ExecDetachedError, KyoraError, Retry

pytestmark = pytest.mark.anyio


def exit(code, **extra):
    return {"type": "exit", "code": code, "signal": None, "durationMs": 12, "timedOut": False, **extra}


def started(**extra):
    return {"type": "started", "id": ID, "resumable": True, **extra}


def attached(running=False):
    return {"type": "attached", "id": ID, "running": running}


async def test_collects_stdout_and_stderr_as_bytes_text_and_base64_across_split_chunks(client):
    kyora, requests = client(
        lambda r, i: ndjson(
            [
                started(key="k1"),
                '{"type":"stdout","da',
                'ta":"hello "}\n',
                {"type": "ping", "from": "cloud"},
                {"type": "stdout", "b64": base64.b64encode(b"\xff\x00A").decode()},
                {"type": "stderr", "data": "warn\n"},
                exit(3, bytes={"stdout": 9, "stderr": 5}),
            ]
        )
    )
    chunks = []
    result = await kyora.exec.run(
        "sb_1",
        {"cmd": ["sh", "-c", "work"], "key": "k1"},
        on_output=lambda stream, chunk: chunks.append(f"{stream}:{len(chunk)}"),
    )
    assert (result.exit_code, result.signal, result.timed_out, result.duration_ms) == (3, None, False, 12)
    assert result.stdout == b"hello \xff\x00A"
    assert result.stderr == b"warn\n"
    assert (result.truncated.stdout, result.truncated.stderr) == (False, False)
    assert (result.exec_id, result.key) == (ID, "k1")
    assert chunks == ["stdout:6", "stdout:3", "stderr:5"]
    assert requests[0].json == {"cmd": ["sh", "-c", "work"], "key": "k1", "resumable": True}


async def test_a_timeout_and_a_signal_come_through_as_they_are(client):
    kyora, _ = client(lambda r, i: ndjson([started(), exit(None, signal="SIGKILL", timedOut=True)]))
    result = await kyora.exec.run("sb_1", {"cmd": ["sleep", "99"], "timeout_seconds": 1})
    assert (result.exit_code, result.signal, result.timed_out) == (None, "SIGKILL", True)


async def test_every_exec_is_resumable_under_a_fresh_key_unless_it_names_one(client):
    kyora, requests = client(lambda r, i: ndjson([exit(0)]))
    await kyora.exec.run("sb_1", {"cmd": ["true"]})
    await kyora.exec.run("sb_1", {"cmd": ["true"]})
    keys = [r.json["key"] for r in requests]
    assert re.match(r"^sdk-", keys[0])
    assert keys[0] != keys[1]
    assert all(r.json["resumable"] is True for r in requests)


async def test_truncation_past_max_output_bytes_a_gap_or_short_of_the_totals(client):
    kyora, _ = client(
        lambda r, i: ndjson(
            [
                started(),
                {"type": "stdout", "data": "0123456789"},
                {"type": "gap", "stream": "stderr", "from": 0, "to": 4},
                {"type": "stderr", "data": "tail"},
                exit(0, bytes={"stdout": 10, "stderr": 8}),
            ]
        )
    )
    result = await kyora.exec.run("sb_1", {"cmd": ["x"]}, max_output_bytes=4)
    assert (result.stdout, result.stderr) == (b"0123", b"tail")
    assert (result.truncated.stdout, result.truncated.stderr) == (True, True)


async def test_short_of_the_exits_totals_is_truncated(client):
    kyora, _ = client(
        lambda r, i: ndjson([started(), {"type": "stdout", "data": "ab"}, exit(0, bytes={"stdout": 5, "stderr": 0})])
    )
    result = await kyora.exec.run("sb_1", {"cmd": ["x"]})
    assert (result.truncated.stdout, result.truncated.stderr) == (True, False)


async def test_an_error_frame_is_a_kyora_error(client):
    kyora, _ = client(lambda r, i: ndjson([started(), {"type": "error", "message": "the machine went away"}]))
    with pytest.raises(KyoraError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]})
    assert caught.value.code == "exec_error"


async def test_a_refused_exec_is_the_refusal_after_retrying_one_that_never_started(client):
    kyora, requests = client(
        lambda r, i: (
            error(503, "exec_not_started", {"retryable": True, "retryAfterMs": 1})
            if i == 0
            else error(409, "not_running")
        )
    )
    with pytest.raises(KyoraError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "same"})
    assert (caught.value.code, caught.value.status) == ("not_running", 409)
    assert [r.json["key"] for r in requests] == ["same", "same"]


async def test_a_stream_that_breaks_is_reattached_from_the_bytes_already_read(client):
    def handler(r, i):
        if r.method == "POST":
            return ndjson([started(), {"type": "stdout", "data": "abc"}, {"type": "stderr", "data": "e"}], broken=True)
        return ndjson([attached(True), {"type": "stdout", "data": "def"}, exit(0, bytes={"stdout": 6, "stderr": 1})])

    kyora, requests = client(handler)
    result = await kyora.exec.run("sb_1", {"cmd": ["x"]})
    assert (result.stdout, result.stderr) == (b"abcdef", b"e")
    assert (result.truncated.stdout, result.truncated.stderr) == (False, False)
    assert requests[1].method == "GET"
    assert requests[1].url.path == f"/v1/sandboxes/sb_1/execs/{ID}/stream"
    assert requests[1].url.params["from"] == "3,1"


async def test_detached_ends_a_stream_too_and_the_reattach_follows(client):
    kyora, requests = client(
        lambda r, i: (
            ndjson([started(), {"type": "detached", "reason": "deploy"}])
            if r.method == "POST"
            else ndjson([attached(), exit(0)])
        )
    )
    assert (await kyora.exec.run("sb_1", {"cmd": ["x"]})).exit_code == 0
    assert len(requests) == 2


async def test_a_stream_that_broke_before_naming_its_command_is_found_again_by_its_key(client):
    def handler(r, i):
        if i == 0:
            return ndjson([])
        if r.method == "POST":
            return ndjson([started(key="job-7", existing=True), {"type": "detached", "reason": "rejoin"}])
        return ndjson([attached(), {"type": "stdout", "data": "done"}, exit(0)])

    kyora, requests = client(handler)
    result = await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "job-7"})
    assert result.stdout == b"done"
    assert [r.method for r in requests] == ["POST", "POST", "GET"]
    assert requests[1].json["key"] == "job-7"
    assert requests[2].url.params["from"] == "0,0"


async def test_a_silent_stream_is_given_up_on_and_reattached(client):
    streams = []

    def handler(r, i):
        if r.method == "POST":
            response = ndjson([started()], hang=True)
            streams.append(response.stream)
            return response
        return ndjson([attached(), exit(0)])

    kyora, requests = client(handler)
    assert (await kyora.exec.run("sb_1", {"cmd": ["x"]}, idle=0.05)).exit_code == 0
    assert streams[0].closed
    assert len(requests) == 2


async def test_attach_by_id_reads_the_rest_of_a_commands_output(client):
    kyora, requests = client(lambda r, i: ndjson([attached(True), {"type": "stdout", "data": "rest"}, exit(1)]))
    result = await kyora.exec.attach("sb_1", ID, from_=ByteOffsets(stdout=10, stderr=2))
    assert (result.stdout, result.exit_code) == (b"rest", 1)
    assert requests[0].url.params["from"] == "10,2"


async def test_a_break_that_cant_be_reattached_within_the_window_is_stream_lost(client):
    kyora, _ = client(
        lambda r, i: (
            ndjson([started(), {"type": "stdout", "data": "ab"}]) if r.method == "POST" else error(503, "node_offline")
        )
    )
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "k"}, reattach_window=0.1)
    failure = caught.value
    assert (failure.code, failure.exec_id, failure.key) == ("stream_lost", ID, "k")
    assert failure.offsets == ByteOffsets(2, 0)


async def test_a_reattach_that_is_refused_for_good_is_that_refusal(client):
    kyora, _ = client(lambda r, i: ndjson([started()]) if r.method == "POST" else error(404, "exec_not_found"))
    with pytest.raises(KyoraError, match="exec_not_found"):
        await kyora.exec.run("sb_1", {"cmd": ["x"]})


async def test_the_deadline_stops_waiting_and_leaves_the_command_running(client):
    kyora, requests = client(lambda r, i: ndjson([started(), {"type": "stdout", "data": "partial"}], hang=True))
    begun = time.monotonic()
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["sleep", "60"], "key": "k9"}, timeout=0.1)
    assert time.monotonic() - begun < 1
    failure = caught.value
    assert (failure.code, failure.retryable, failure.exec_id, failure.key) == ("timeout", True, ID, "k9")
    assert failure.offsets == ByteOffsets(7, 0)
    assert not any(r.url.path.endswith("/cancel") for r in requests)


async def test_a_retry_after_past_the_deadline_is_the_error_itself(client):
    kyora, requests = client(lambda r, i: error(503, "waking", {"retryable": True, "retryAfterMs": 8_000}))
    with pytest.raises(KyoraError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, timeout=1)
    assert (caught.value.code, caught.value.retry_after) == ("waking", 8)
    assert len(requests) == 1


async def test_cancelling_the_call_cancels_the_command(client):
    kyora, requests = client(
        lambda r, i: (
            json(200, {"cancelled": True}) if r.url.path.endswith("/cancel") else ndjson([started()], hang=True)
        )
    )
    task = asyncio.ensure_future(kyora.exec.run("sb_1", {"cmd": ["x"]}))
    await asyncio.sleep(0.03)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert requests[-1].url.path == f"/v1/sandboxes/sb_1/execs/{ID}/cancel"


async def test_cancel_on_cancel_false_leaves_it_running(client):
    kyora, requests = client(lambda r, i: ndjson([started()], hang=True))
    task = asyncio.ensure_future(kyora.exec.run("sb_1", {"cmd": ["x"]}, cancel_on_cancel=False))
    await asyncio.sleep(0.03)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(requests) == 1


async def test_a_stream_that_started_without_resumability_and_broke_is_not_sent_again(client):
    kyora, requests = client(
        lambda r, i: ndjson([{"type": "started", "resumable": False}, {"type": "stdout", "data": "half"}])
    )
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "k1"}, reattach_window=0.2)
    assert (caught.value.code, caught.value.exec_id, caught.value.key) == ("stream_lost", None, "k1")
    assert caught.value.offsets == ByteOffsets(4, 0)
    assert len(requests) == 1


async def test_output_from_a_server_that_never_sent_started_is_not_sent_again(client):
    kyora, requests = client(lambda r, i: ndjson([{"type": "stdout", "data": "old server"}]))
    with pytest.raises(ExecDetachedError, match="kyora never named"):
        await kyora.exec.run("sb_1", {"cmd": ["x"]})
    assert len(requests) == 1


async def test_no_answer_to_the_post_is_recovered_by_its_key(client):
    def handler(r, i):
        if i == 0:
            raise httpx.ConnectError("connection reset")
        if r.method == "POST":
            return ndjson([started(key="k5", existing=True), {"type": "detached", "reason": "rejoin"}])
        return ndjson([attached(), {"type": "stdout", "data": "ok"}, exit(0)])

    kyora, requests = client(handler, retry=Retry(max_attempts=1))
    result = await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "k5"})
    assert result.stdout == b"ok"
    assert [r.method for r in requests] == ["POST", "POST", "GET"]
    assert [r.json["key"] for r in requests[:2]] == ["k5", "k5"]


async def test_one_that_cant_be_recovered_in_time_carries_its_generated_key(client):
    def handler(r, i):
        raise httpx.ConnectError("connection reset")

    kyora, _ = client(handler, retry=Retry(max_attempts=1))
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, reattach_window=0.1)
    assert caught.value.key.startswith("sdk-")
    assert caught.value.code == "stream_lost"


async def test_waits_what_kyora_asks_between_reattaches(client):
    def handler(r, i):
        if r.method == "POST":
            return ndjson([started()])
        if i == 1:
            return error(503, "waking", {"retryable": True, "retryAfterMs": 120})
        return ndjson([attached(), exit(0)])

    kyora, _ = client(handler)
    begun = time.monotonic()
    assert (await kyora.exec.run("sb_1", {"cmd": ["x"]})).exit_code == 0
    assert time.monotonic() - begun >= 0.11


async def test_a_retry_after_past_the_window_or_deadline_is_raised_with_what_to_reattach_to(client):
    kyora, _ = client(
        lambda r, i: (
            ndjson([started()])
            if r.method == "POST"
            else error(503, "waking", {"retryable": True, "retryAfterMs": 60_000})
        )
    )
    begun = time.monotonic()
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "k6"}, timeout=5)
    assert time.monotonic() - begun < 2
    failure = caught.value
    assert (failure.code, failure.retry_after, failure.exec_id, failure.key) == ("waking", 60, ID, "k6")


async def test_an_exception_of_on_output_ends_the_call_as_it_is(client):
    kyora, requests = client(lambda r, i: ndjson([started(), {"type": "stdout", "data": "a"}, exit(0)]))
    mine = RuntimeError("sink full")

    def sink(stream, data):
        raise mine

    with pytest.raises(RuntimeError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, on_output=sink)
    assert caught.value is mine
    assert len(requests) == 1


async def test_the_unclear_starts_retry_after_is_the_first_recovery_delay(client):
    def handler(r, i):
        if i == 0:
            return error(503, "do_reset", {"retryable": True, "retryAfterMs": 300})
        if r.method == "POST":
            return ndjson([started(existing=True), {"type": "detached", "reason": "rejoin"}])
        return ndjson([attached(), exit(0)])

    kyora, requests = client(handler, retry=Retry(max_attempts=1))
    begun = time.monotonic()
    assert (await kyora.exec.run("sb_1", {"cmd": ["x"]})).exit_code == 0
    assert time.monotonic() - begun >= 0.29
    assert [r.method for r in requests] == ["POST", "POST", "GET"]


async def test_an_unclear_start_whose_retry_after_passes_the_deadline_is_raised_with_the_key(client):
    kyora, _ = client(
        lambda r, i: error(503, "do_reset", {"retryable": True, "retryAfterMs": 30_000}), retry=Retry(max_attempts=1)
    )
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"], "key": "k8"}, timeout=2)
    assert (caught.value.code, caught.value.retry_after, caught.value.key) == ("do_reset", 30, "k8")


async def test_a_reattach_that_never_answers_is_bounded_by_the_window(client):
    kyora, _ = client(lambda r, i: ndjson([started()]) if r.method == "POST" else hang())
    begun = time.monotonic()
    with pytest.raises(ExecDetachedError, match="could not reattach"):
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, reattach_window=0.2)
    assert time.monotonic() - begun < 1


async def test_stream_yields_output_as_it_arrives_then_the_result(client):
    kyora, _ = client(
        lambda r, i: ndjson([started(), {"type": "stdout", "data": "a"}, {"type": "stderr", "data": "b"}, exit(0)])
    )
    async with kyora.exec.stream("sb_1", {"cmd": ["x"]}) as stream:
        seen = [(chunk.stream, chunk.data) async for chunk in stream]
    assert seen == [("stdout", b"a"), ("stderr", b"b")]
    assert stream.result is not None and stream.result.exit_code == 0


async def test_stream_raises_the_calls_error(client):
    kyora, _ = client(lambda r, i: ndjson([started(), {"type": "error", "message": "gone"}]))
    with pytest.raises(KyoraError, match="gone"):
        async with kyora.exec.stream("sb_1", {"cmd": ["x"]}) as stream:
            async for _ in stream:
                pass


async def test_cancel_stops_a_command(client):
    kyora, requests = client(lambda r, i: json(200, {"cancelled": True, "running": False}))
    assert (await kyora.exec.cancel("sb_1", ID)).cancelled is True
    assert (requests[0].method, requests[0].url.path) == ("POST", f"/v1/sandboxes/sb_1/execs/{ID}/cancel")


async def test_leaving_a_stream_early_cancels_the_command_unless_told_not_to(client):
    kyora, requests = client(
        lambda r, i: (
            json(200, {"cancelled": True})
            if r.url.path.endswith("/cancel")
            else ndjson([started(), {"type": "stdout", "data": "a"}], hang=True)
        )
    )
    async with kyora.exec.stream("sb_1", {"cmd": ["x"]}) as stream:
        assert (await stream.__anext__()).data == b"a"
    assert requests[-1].url.path == f"/v1/sandboxes/sb_1/execs/{ID}/cancel"
    async with kyora.exec.stream("sb_1", {"cmd": ["x"]}, cancel_on_cancel=False) as stream:
        assert (await stream.__anext__()).data == b"a"
    assert requests[-1].method == "POST" and requests[-1].url.path.endswith("/exec")


async def test_a_paused_stream_reader_never_loses_output_to_the_deadline(client):
    chunks = [{"type": "stdout", "data": "x" * 10} for _ in range(100)]
    kyora, _ = client(lambda r, i: ndjson([started(), *chunks], hang=True))
    got = b""
    with pytest.raises(ExecDetachedError) as caught:
        async with kyora.exec.stream("sb_1", {"cmd": ["x"]}, timeout=0.3, cancel_on_cancel=False) as stream:
            got += (await stream.__anext__()).data
            await asyncio.sleep(0.5)
            async for chunk in stream:
                got += chunk.data
    assert 0 < len(got) < 1000
    assert caught.value.offsets == ByteOffsets(len(got), 0)


async def test_an_on_output_whose_finalizer_awaits_never_holds_the_call_past_its_deadline(client):
    kyora, _ = client(lambda r, i: ndjson([started(), {"type": "stdout", "data": "a"}], hang=True))

    async def sink(stream, data):
        try:
            await hang()
        finally:
            await asyncio.sleep(1)

    begun = time.monotonic()
    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, on_output=sink, timeout=0.3)
    assert time.monotonic() - begun < 0.8
    assert (caught.value.code, caught.value.offsets) == ("timeout", ByteOffsets(1, 0))
    await kyora.aclose()


async def test_output_on_output_got_counts_though_the_deadline_hits_while_it_awaits(client):
    kyora, _ = client(lambda r, i: ndjson([started(), {"type": "stdout", "data": "hello"}], hang=True))
    written = []

    async def sink(stream, data):
        written.append(data)
        await hang()

    with pytest.raises(ExecDetachedError) as caught:
        await kyora.exec.run("sb_1", {"cmd": ["x"]}, on_output=sink, timeout=0.3)
    assert written == [b"hello"]
    assert caught.value.offsets == ByteOffsets(5, 0)
    await kyora.aclose()
