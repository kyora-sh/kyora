import pytest
from fakes import BASE, ID, domain, error, json, ndjson, page, sandbox

from kyora import Kyora, KyoraError, Retry


@pytest.fixture
def sync(respx_mock):
    made = []

    def make(handler, **options):
        from fakes import Fake

        fake = Fake(handler)
        respx_mock.route(url__startswith=BASE).mock(side_effect=fake)
        options.setdefault("retry", Retry(base_delay=0.001, max_delay=0.005))
        kyora = Kyora(token="kyora_test", base_url=BASE, **options)
        made.append(kyora)
        return kyora, fake.requests

    yield make
    for kyora in made:
        kyora.close()


def test_calls_block_and_answer_models(sync):
    kyora, requests = sync(lambda r, i: json(200, sandbox("sb_1")))
    assert kyora.sandboxes.get("sb_1").id == "sb_1"
    assert requests[0].headers["authorization"] == "Bearer kyora_test"


def test_idempotency_key_headers_go_out_once_on_creates_and_as_given_elsewhere(sync):
    kyora, requests = sync(lambda r, i: json(201 if r.method == "POST" else 200, sandbox("sb_1")))
    kyora.sandboxes.create({}, headers={"idempotency-KEY": "job-42"})
    kyora.sandboxes.get("sb_1", headers={"IdemPotency-key": "job-43"})
    assert [r.headers.get_list("idempotency-key") for r in requests] == [["job-42"], ["job-43"]]


def test_errors_raise_as_they_are(sync):
    kyora, _ = sync(lambda r, i: error(409, "name_taken"))
    with pytest.raises(KyoraError) as caught:
        kyora.sandboxes.update("sb_1", {"name": "x"})
    assert caught.value.code == "name_taken"


def test_iterate_is_a_plain_iterator(sync):
    pages = {None: {"sandboxes": [sandbox("sb_1")], "next_cursor": "p2"}, "p2": {"sandboxes": [sandbox("sb_2")]}}
    kyora, _ = sync(lambda r, i: json(200, pages[r.url.params.get("cursor")]))
    assert [s.id for s in kyora.sandboxes.iterate()] == ["sb_1", "sb_2"]


def test_exec_runs_and_streams(sync):
    frames = [
        {"type": "started", "id": ID, "resumable": True},
        {"type": "stdout", "data": "hi"},
        {"type": "exit", "code": 0, "signal": None, "durationMs": 1, "timedOut": False},
    ]
    kyora, _ = sync(lambda r, i: ndjson(frames))
    seen = []
    assert kyora.exec.run("sb_1", {"cmd": ["echo"]}, on_output=lambda s, d: seen.append(d)).stdout == b"hi"
    assert seen == [b"hi"]
    with kyora.exec.stream("sb_1", {"cmd": ["echo"]}) as stream:
        assert [(c.stream, c.data) for c in stream] == [("stdout", b"hi")]
    assert stream.result.exit_code == 0


def test_files_go_both_ways(sync):
    import httpx

    from kyora._tar import pack_files

    archive = pack_files({"a.txt": "hello"})

    def handler(r, i):
        if r.method == "PUT":
            return json(200, {"bytes": 1, "entries": 1, "durationMs": 1})
        return httpx.Response(200, content=archive)

    kyora, _ = sync(handler)
    assert kyora.files.upload("sb_1", {"a.txt": "hello"}).entries == 1
    assert kyora.files.read("sb_1", "a.txt") == b"hello"
    assert b"".join(kyora.files.download_tar("sb_1", ["a.txt"])) == archive


def test_a_blocking_call_from_a_callback_is_refused_not_deadlocked(sync):
    kyora, _ = sync(
        lambda r, i: ndjson(
            [
                {"type": "stdout", "data": "x"},
                {"type": "exit", "code": 0, "signal": None, "durationMs": 1, "timedOut": False},
            ]
        )
    )
    with pytest.raises(RuntimeError, match="AsyncKyora"):
        kyora.exec.run("sb_1", {"cmd": ["x"]}, on_output=lambda s, d: kyora.me())


def test_a_download_closed_before_reading_frees_its_connection(sync):
    import httpx
    from fakes import Lines

    streams = []

    def handler(r, i):
        stream = Lines(["tar bytes"], hang=True, broken=False)
        streams.append(stream)
        return httpx.Response(200, stream=stream)

    kyora, _ = sync(handler)
    kyora.files.download_tar("sb_1", ["/work"]).close()
    with kyora.files.download_tar("sb_1", ["/work"]) as download:
        assert next(download) == b"tar bytes"
    assert [stream.closed for stream in streams] == [True, True]


def test_a_token_that_is_refused_leaves_no_thread_behind():
    import threading

    before = threading.active_count()
    with pytest.raises(ValueError):
        Kyora(token="bad token")
    assert threading.active_count() == before


def test_an_interrupted_call_lets_its_cleanup_run_before_raising():
    import asyncio
    import os
    import signal
    import threading

    from kyora._sync import Portal

    portal = Portal()
    cleaned = []

    async def call():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0.1)
            cleaned.append(True)
            raise

    timer = threading.Timer(0.05, os.kill, (os.getpid(), signal.SIGINT))
    timer.start()
    try:
        with pytest.raises(KeyboardInterrupt):
            portal.run(call())
        assert cleaned == [True]
    finally:
        timer.cancel()
        portal.close()


def test_close_lets_pending_cleanups_finish():
    import asyncio

    from kyora._sync import Portal

    portal = Portal()
    finished = []

    async def cleanup():
        await asyncio.sleep(0.1)
        finished.append(True)

    portal.loop.call_soon_threadsafe(lambda: portal.loop.create_task(cleanup()))
    portal.close()
    assert finished == [True]


def test_close_and_context_manager():
    with Kyora(token="kyora_test") as kyora:
        assert "kyora_test" not in repr(kyora)
    assert not kyora._portal.thread.is_alive()


def test_a_streamed_call_keeps_its_deadline_through_the_body(sync):
    import time

    import httpx
    from fakes import Lines

    kyora, _ = sync(lambda r, i: httpx.Response(200, stream=Lines(["partial"], hang=True, broken=False)))
    begun = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        kyora.call("pullFiles", path={"id": "sb_1"}, query={"path": ["/work"]}, timeout=0.05)
    assert caught.value.code == "timeout"
    assert time.monotonic() - begun < 0.5


def test_close_waits_for_an_upload_abort_still_running(sync, monkeypatch):
    import asyncio

    from test_files import KiB, multipart

    from kyora import _client

    monkeypatch.setattr(_client, "SINGLE_UPLOAD_BYTES", 256 * KiB)
    deleted = []
    base = multipart(128 * KiB, stall=2)

    async def handler(r, i):
        if r.method == "DELETE":
            await asyncio.sleep(0.2)
            deleted.append(r.url.path)
            return json(204)
        return await base(r, i)

    kyora, _ = sync(handler)
    with pytest.raises(KyoraError, match="deadline"):
        kyora.files.upload_tar("sb_1", bytes(320 * KiB), timeout=0.3)
    kyora.close()
    assert deleted == ["/v1/sandboxes/sb_1/uploads/up_1"]


def test_what_an_interrupted_call_answers_anyway_is_closed():
    import os
    import signal
    import time

    from kyora._sync import Portal

    portal = Portal()
    closed = []

    class Stream:
        async def aclose(self):
            closed.append(True)

    async def call():
        os.kill(os.getpid(), signal.SIGINT)
        time.sleep(0.2)
        return Stream()

    try:
        with pytest.raises(KeyboardInterrupt):
            portal.run(call())
        time.sleep(0.1)
        assert closed == [True]
    finally:
        portal.close()


def test_pages_and_domains_block_and_pass_their_arguments(sync):
    def handler(r, i):
        if r.url.path.startswith("/v1/domains"):
            return json(204) if r.method == "DELETE" else json(201, domain("docs.example.com", page="docs-site"))
        return error(404, "not_found") if r.method == "DELETE" else json(201, page("docs-site", "build/42/"))

    kyora, requests = sync(handler)
    assert kyora.pages.publish({"name": "docs-site", "bucket": "site", "prefix": "build/42/"}).name == "docs-site"
    assert kyora.domains.create("docs.example.com", page="docs-site", dcv="txt", timeout=5).page == "docs-site"
    assert kyora.domains.delete("docs.example.com") is True
    assert kyora.pages.delete("docs-site") is False
    assert requests[1].json == {"hostname": "docs.example.com", "page": "docs-site", "dcv": "txt"}
