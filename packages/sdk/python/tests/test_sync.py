import pytest
from fakes import BASE, ID, error, json, ndjson, sandbox

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


def test_close_and_context_manager():
    with Kyora(token="kyora_test") as kyora:
        assert "kyora_test" not in repr(kyora)
    assert not kyora._portal.thread.is_alive()
