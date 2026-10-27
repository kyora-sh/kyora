import asyncio
import time

import pytest
from fakes import error, hang, json, sandbox

from kyora import FileInput, KyoraError
from kyora._tar import pack_files, unpack

pytestmark = pytest.mark.anyio
MiB = 1024 * 1024
KiB = 1024


@pytest.fixture
def small(monkeypatch):
    """archives past 256 KiB go up in parts, so a multipart upload needs no large copies"""
    from kyora import _client

    monkeypatch.setattr(_client, "SINGLE_UPLOAD_BYTES", 256 * KiB)


def test_packs_files_with_their_parent_directories_and_reads_them_back():
    archive = pack_files([FileInput("a/b/c.txt", "hi"), FileInput("run.sh", b"#!/bin/sh\n", 0o755)])
    entries = unpack(archive)
    assert [(e.name, e.type) for e in entries] == [
        ("a", "dir"),
        ("a/b", "dir"),
        ("a/b/c.txt", "file"),
        ("run.sh", "file"),
    ]
    assert entries[2].data == b"hi"
    assert entries[3].mode == 0o755


def test_long_and_non_ascii_names_survive():
    name = "deep/" + "x" * 150 + "/ü.txt"
    assert unpack(pack_files({name: "u"}))[-1].name == name


def test_refuses_a_path_that_leaves_the_destination():
    with pytest.raises(ValueError):
        pack_files({"../etc/passwd": "x"})
    with pytest.raises(ValueError):
        pack_files({"./": "x"})


def test_a_truncated_archive_is_an_error():
    archive = pack_files({"a.txt": "x" * 2000})
    with pytest.raises(ValueError):
        unpack(archive[:1024])
    with pytest.raises(ValueError):
        unpack(archive[:700])


async def test_upload_sends_one_tar_to_the_destination(client):
    kyora, requests = client(lambda r, i: json(200, {"bytes": 2048, "entries": 2, "durationMs": 5}))
    result = await kyora.files.upload("sb_1", {"inbox/contract.pdf": b"%PDF"}, dest="/work/job")
    assert result.entries == 2
    request = requests[0]
    assert (request.method, request.url.path) == ("PUT", "/v1/sandboxes/sb_1/files")
    assert request.url.params["dest"] == "/work/job"
    assert request.headers["content-type"] == "application/x-tar"
    file = next(e for e in unpack(request.body) if e.type == "file")
    assert (file.name, file.data) == ("inbox/contract.pdf", b"%PDF")


def multipart(part_size, delay=0.0, hang_delete=False, stall=None):
    """`stall`: the part that never gets an answer; `.aborted` is set once the abort arrives"""
    aborted = asyncio.Event()

    async def answer(r, i):
        if delay and "/parts/" in r.url.path:
            await asyncio.sleep(delay)
        path = r.url.path
        if "/parts/" in path and int(path.rsplit("/", 1)[1]) == stall:
            await hang()
        if path.endswith("/uploads"):
            return json(
                201,
                {
                    "uploadId": "up_1",
                    "partSize": part_size,
                    "maxPartBytes": part_size,
                    "expiresAt": "2026-01-02T00:00:00Z",
                },
            )
        if "/parts/" in path:
            n = int(path.rsplit("/", 1)[1])
            return json(200, {"n": n, "etag": f"e{n}"})
        if r.method == "DELETE":
            aborted.set()
            if hang_delete:
                await hang()
            return json(204)
        return json(200, {"bytes": 1, "entries": 1, "durationMs": 1})

    answer.aborted = aborted
    return answer


async def test_a_large_archive_goes_up_in_parts_and_is_completed(client):
    kyora, requests = client(multipart(32 * MiB))
    await kyora.files.upload_tar("sb_1", bytes(65 * MiB + 1))
    assert [f"{r.method} {r.url.path}" for r in requests] == [
        "POST /v1/sandboxes/sb_1/uploads",
        "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/1",
        "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/2",
        "PUT /v1/sandboxes/sb_1/uploads/up_1/parts/3",
        "POST /v1/sandboxes/sb_1/uploads/up_1/complete",
    ]
    assert requests[-1].json == {"parts": [{"n": 1, "etag": "e1"}, {"n": 2, "etag": "e2"}, {"n": 3, "etag": "e3"}]}


async def test_a_failed_part_aborts_the_upload(client):
    base = multipart(32 * MiB)

    async def handler(r, i):
        if "/parts/" in r.url.path:
            return error(400, "upload_rejected")
        return await base(r, i)

    kyora, requests = client(handler)
    with pytest.raises(KyoraError, match="upload_rejected"):
        await kyora.files.upload_tar("sb_1", bytes(65 * MiB))
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/sandboxes/sb_1/uploads/up_1")


async def chunks(total, size=MiB):
    sent = 0
    while sent < total:
        part = min(size, total - sent)
        sent += part
        yield bytes(part)


async def test_a_large_stream_goes_up_in_parts_never_as_one_put(client):
    kyora, requests = client(multipart(32 * MiB))
    await kyora.files.upload_tar("sb_1", chunks(65 * MiB))
    assert [len(r.body) for r in requests if "/parts/" in r.url.path] == [32 * MiB, 32 * MiB, MiB]
    assert not any(r.url.path.endswith("/files") for r in requests)


async def test_a_small_stream_or_file_goes_up_as_one_put(client, tmp_path):
    kyora, requests = client(multipart(32 * MiB))
    await kyora.files.upload_tar("sb_1", chunks(3 * MiB))
    path = tmp_path / "a.tar"
    path.write_bytes(bytes(2 * MiB))
    with path.open("rb") as file:
        await kyora.files.upload_tar("sb_1", file)
    assert [f"{r.method} {r.url.path}" for r in requests] == ["PUT /v1/sandboxes/sb_1/files"] * 2
    assert [len(r.body) for r in requests] == [3 * MiB, 2 * MiB]


async def test_timeout_bounds_the_whole_multipart_upload_not_each_part(client, small):
    answer = multipart(128 * KiB, delay=0.3)
    kyora, requests = client(answer)
    with pytest.raises(KyoraError) as caught:
        await kyora.files.upload_tar("sb_1", bytes(320 * KiB), timeout=0.5)
    assert caught.value.code == "timeout"
    await asyncio.wait_for(answer.aborted.wait(), 5)
    assert requests[-1].method == "DELETE"


async def test_a_part_size_out_of_bounds_is_refused_and_the_upload_aborted(client):
    kyora, requests = client(multipart(1024))
    with pytest.raises(KyoraError) as caught:
        await kyora.files.upload_tar("sb_1", bytes(65 * MiB))
    assert caught.value.code == "bad_response"
    assert requests[-1].method == "DELETE"


async def test_a_cleanup_that_hangs_never_holds_the_caller_past_its_deadline(client, small):
    from kyora._http import CLEANUP_TIMEOUT

    answer = multipart(128 * KiB, hang_delete=True, stall=2)
    kyora, requests = client(answer)
    begun = time.monotonic()
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.files.upload_tar("sb_1", bytes(320 * KiB), timeout=0.3)
    assert time.monotonic() - begun < 1.3 < CLEANUP_TIMEOUT
    await asyncio.wait_for(answer.aborted.wait(), 5)
    assert requests[-1].method == "DELETE"


async def test_a_stalled_stream_ends_at_the_deadline_and_is_closed(client):
    closed = []

    async def stalled():
        try:
            yield bytes(MiB)
            await hang()
        finally:
            closed.append(True)

    kyora, requests = client(lambda r, i: json(200, {}))
    begun = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        await kyora.files.upload_tar("sb_1", stalled(), timeout=0.1)
    assert caught.value.code == "timeout"
    assert time.monotonic() - begun < 1
    await kyora.aclose()
    assert closed == [True]
    assert requests == []


async def test_a_failed_create_upload_closes_the_stream(client):
    closed = []

    async def source():
        try:
            for _ in range(70):
                yield bytes(MiB)
            await hang()
        finally:
            closed.append(True)

    kyora, _ = client(lambda r, i: error(403, "insufficient_scope"))
    with pytest.raises(KyoraError, match="insufficient_scope"):
        await kyora.files.upload_tar("sb_1", source())
    assert closed == [True]


async def test_download_and_read_unpack_what_the_sandbox_sends(client):
    import httpx

    archive = pack_files([FileInput("out/summary.json", '{"ok":true}')])
    kyora, requests = client(
        lambda r, i: httpx.Response(200, content=archive, headers={"content-type": "application/x-tar"})
    )
    assert await kyora.files.read("sb_1", "/work/out/summary.json") == b'{"ok":true}'
    assert requests[0].url.params.get_list("path") == ["/work/out/summary.json"]
    entries = await kyora.files.download("sb_1", ["/work/out"])
    assert [e.name for e in entries] == ["out", "out/summary.json"]
    streamed = b"".join([chunk async for chunk in await kyora.files.download_tar("sb_1", ["/work/out"])])
    assert streamed == archive


async def test_a_download_closed_before_reading_frees_its_connection(client):
    import httpx
    from fakes import Lines

    streams = []

    def handler(r, i):
        stream = Lines(["tar bytes"], hang=True, broken=False)
        streams.append(stream)
        return httpx.Response(200, stream=stream)

    kyora, _ = client(handler)
    download = await kyora.files.download_tar("sb_1", ["/work"])
    await download.aclose()
    async with await kyora.files.download_tar("sb_1", ["/work"]) as second:
        assert await second.__anext__() == b"tar bytes"
    assert [stream.closed for stream in streams] == [True, True]


async def test_a_broken_archive_is_fetched_again(client):
    import httpx

    archive = pack_files({"a.txt": "hello"})
    kyora, requests = client(lambda r, i: httpx.Response(200, content=archive[:700] if i == 0 else archive))
    assert await kyora.files.read("sb_1", "a.txt") == b"hello"
    assert len(requests) == 2


def snap(status, id="snap_1"):
    return {
        "id": id,
        "kind": "fs",
        "status": status,
        "name": None,
        "sandbox": "sb_1",
        "bytes": None,
        "logicalBytes": None,
        "dataBytes": None,
        "image": None,
        "resumable": False,
        "createdAt": "2026-01-01T00:00:00Z",
        "expiresAt": "2026-02-01T00:00:00Z",
    }


async def test_a_snapshot_is_polled_until_ready(client):
    kyora, requests = client(lambda r, i: json(202 if i == 0 else 200, snap("creating" if i < 2 else "ready")))
    states = []
    ready = await kyora.snapshots.create(
        "sb_1", {"name": "base"}, interval=0.005, on_progress=lambda current: states.append(current.status)
    )
    assert ready.status == "ready"
    assert states == ["creating", "creating", "ready"]
    assert requests[0].json == {"name": "base"}
    assert "idempotency-key" not in requests[0].headers


async def test_a_restore_that_fails_is_destroyed(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, sandbox("sb_r", status="starting"))
        if r.method == "DELETE":
            return json(204)
        return json(200, sandbox("sb_r", status="failed"))

    kyora, requests = client(handler)
    with pytest.raises(KyoraError) as caught:
        await kyora.snapshots.restore("snap_1", {"vcpus": 2}, interval=0.005)
    assert caught.value.code == "sandbox_ended"
    assert requests[0].json == {"vcpus": 2, "fromSnapshot": "snap_1"}
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/sandboxes/sb_r")
    assert requests[0].headers["idempotency-key"].startswith("sdk-")
    assert caught.value.sandbox_id is None


async def test_a_restore_under_the_callers_key_that_fails_is_left_running_its_id_on_the_error(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, sandbox("sb_r", status="starting"))
        return json(200, sandbox("sb_r", status="failed"))

    kyora, requests = client(handler)
    with pytest.raises(KyoraError) as caught:
        await kyora.snapshots.restore("snap_1", idempotency_key="job-42", interval=0.005)
    assert (caught.value.code, caught.value.sandbox_id) == ("sandbox_ended", "sb_r")
    assert requests[0].headers["idempotency-key"] == "job-42"
    assert "DELETE" not in [r.method for r in requests]


async def test_a_restore_under_the_callers_key_that_is_cancelled_is_left_running(client):
    calls = []
    kyora, requests = client(lambda r, i: json(201 if r.method == "POST" else 200, sandbox("sb_r", status="starting")))
    calls.append(
        asyncio.ensure_future(
            kyora.snapshots.restore(
                "snap_1", idempotency_key="job-42", interval=0.005, on_progress=lambda current: calls[0].cancel()
            )
        )
    )
    with pytest.raises(asyncio.CancelledError):
        await calls[0]
    await kyora.aclose()
    assert "DELETE" not in [r.method for r in requests]


async def test_a_restore_that_replays_anothers_sandbox_under_the_same_key_never_destroys_it(client):
    gets = []

    def handler(r, i):
        if r.method == "POST":
            return json(201, sandbox("sb_r", status="starting"))
        if r.method == "DELETE":
            return json(204)
        gets.append(r)
        return json(200, sandbox("sb_r", status="running" if len(gets) == 1 else "starting"))

    kyora, requests = client(handler)
    first = await kyora.snapshots.restore("snap_1", idempotency_key="job-42", interval=0.005)
    assert first.status == "running"
    with pytest.raises(KyoraError, match="deadline") as caught:
        await kyora.snapshots.restore("snap_1", idempotency_key="job-42", interval=0.005, timeout=0.05)
    assert caught.value.sandbox_id == "sb_r"
    assert [r.headers["idempotency-key"] for r in requests if r.method == "POST"] == ["job-42", "job-42"]
    assert "DELETE" not in [r.method for r in requests]


async def test_wait_until_runnings_first_request_is_inside_its_deadline(client):
    kyora, _ = client(lambda r, i: hang())
    begun = time.monotonic()
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.sandboxes.wait_until_running("sb_1", timeout=0.1)
    assert time.monotonic() - begun < 1


async def test_ports_and_tokens_reach_their_operations(client):
    token = {
        "id": "tok_1",
        "userId": "u_1",
        "name": "ci",
        "hint": "kyora_ab",
        "scopes": ["vms:exec"],
        "constraints": None,
        "source": "dashboard",
        "createdAt": "2026-01-01T00:00:00Z",
        "lastUsedAt": None,
        "expiresAt": None,
        "revokedAt": None,
        "scoped": False,
    }

    def handler(r, i):
        if r.url.path.endswith("/ports") and r.method == "GET":
            return json(200, {"ports": []})
        if "/tokens" in r.url.path and r.method == "GET":
            return json(200, {"tokens": [token], "capabilities": []})
        if r.method == "DELETE":
            return json(204)
        return json(201, {"token": "kyora_new", "record": token})

    kyora, requests = client(handler)
    assert await kyora.ports.list("sb_1") == []
    await kyora.ports.unexpose("sb_1", "web")
    assert (await kyora.tokens.list(org="acme"))[0].id == "tok_1"
    created = await kyora.tokens.create(
        {"name": "ci", "scopes": ["vms:exec"], "constraints": {"labels": {"ci": "1"}, "max_sandboxes": 2}}
    )
    assert created.token == "kyora_new"
    await kyora.tokens.delete("tok_1")
    assert [f"{r.method} {r.url.path}" for r in requests] == [
        "GET /v1/sandboxes/sb_1/ports",
        "DELETE /v1/sandboxes/sb_1/ports/web",
        "GET /v1/orgs/acme/tokens",
        "POST /v1/tokens",
        "DELETE /v1/tokens/tok_1",
    ]
    assert requests[3].json["constraints"] == {"labels": {"ci": "1"}, "maxSandboxes": 2}


async def test_a_streamed_call_keeps_its_deadline_through_the_body(client):
    import httpx
    from fakes import Lines

    streams = []

    def handler(r, i):
        stream = Lines(["partial"], hang=True, broken=False)
        streams.append(stream)
        return httpx.Response(200, stream=stream)

    kyora, _ = client(handler)
    response = await kyora.call("pullFiles", path={"id": "sb_1"}, query={"path": ["/work"]}, timeout=0.05)
    begun = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        await response.aread()
    assert caught.value.code == "timeout"
    assert time.monotonic() - begun < 0.5
    assert streams[0].closed


async def test_closing_the_client_waits_for_an_upload_abort_still_running(client, small):
    deleted = []
    base = multipart(128 * KiB, stall=2)

    async def handler(r, i):
        if r.method == "DELETE":
            await asyncio.sleep(0.2)
            deleted.append(r.url.path)
            return json(204)
        return await base(r, i)

    kyora, _ = client(handler)
    with pytest.raises(KyoraError, match="deadline"):
        async with kyora:
            await kyora.files.upload_tar("sb_1", bytes(320 * KiB), timeout=0.3)
    assert deleted == ["/v1/sandboxes/sb_1/uploads/up_1"]


async def test_a_failed_upload_aborts_at_once_while_its_source_closes(client, small):
    closed = []
    big = bytes(160 * KiB)

    async def source():
        try:
            yield big
            yield big
        finally:
            await asyncio.sleep(1)
            closed.append(True)

    answer = multipart(128 * KiB, stall=1)
    kyora, requests = client(answer)
    begun = time.monotonic()
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.files.upload_tar("sb_1", source(), timeout=0.3)
    assert time.monotonic() - begun < 1.2
    await asyncio.wait_for(answer.aborted.wait(), 0.8)
    assert requests[-1].method == "DELETE"
    assert closed == []
    await kyora.aclose()
    assert closed == [True]


async def test_a_stalled_on_progress_is_bounded_by_the_deadline(client):
    kyora, _ = client(lambda r, i: json(200, sandbox("sb_1", status="starting")))

    async def stalled(current):
        await hang()

    begun = time.monotonic()
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.sandboxes.wait_until_running("sb_1", on_progress=stalled, timeout=0.1)
    assert time.monotonic() - begun < 1


async def test_a_restore_whose_on_progress_stalls_is_destroyed_at_the_deadline(client):
    def handler(r, i):
        if r.method == "POST":
            return json(202, sandbox("sb_r", status="starting"))
        if r.method == "DELETE":
            return json(204)
        return json(200, sandbox("sb_r", status="starting"))

    async def stalled(current):
        await hang()

    kyora, requests = client(handler)
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.snapshots.restore("snap_1", on_progress=stalled, timeout=0.2)
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/sandboxes/sb_r")


async def test_a_source_whose_finalizer_awaits_never_delays_the_error_or_the_abort(client, small):
    big = bytes(160 * KiB)

    async def source():
        try:
            yield big
            yield big
            await hang()
        finally:
            await asyncio.sleep(1)

    deleted = []
    base = multipart(128 * KiB)

    async def handler(r, i):
        if r.method == "DELETE":
            deleted.append(time.monotonic())
        return await base(r, i)

    kyora, _ = client(handler)
    begun = time.monotonic()
    with pytest.raises(KyoraError, match="deadline"):
        await kyora.files.upload_tar("sb_1", source(), timeout=0.3)
    assert time.monotonic() - begun < 1.2
    await asyncio.wait_for(base.aborted.wait(), 5)
    assert len(deleted) == 1 and deleted[0] - begun < 1.2
    await kyora.aclose()


async def test_a_body_whose_close_is_slow_never_delays_the_timeout(client):
    import httpx
    from fakes import Lines

    class SlowClose(Lines):
        async def aclose(self) -> None:
            await asyncio.sleep(1)
            self.closed = True

    kyora, _ = client(lambda r, i: httpx.Response(200, stream=SlowClose(["partial"], hang=True, broken=False)))
    response = await kyora.call("pullFiles", path={"id": "sb_1"}, query={"path": ["/work"]}, timeout=0.3)
    begun = time.monotonic()
    with pytest.raises(KyoraError) as caught:
        await response.aread()
    assert caught.value.code == "timeout"
    assert time.monotonic() - begun < 0.8
    await kyora.aclose()


async def test_a_streamed_answer_nobody_reads_is_closed_at_its_deadline(client):
    import httpx
    from fakes import Lines

    streams = []

    def handler(r, i):
        stream = Lines(["partial"], hang=True, broken=False)
        streams.append(stream)
        return httpx.Response(200, stream=stream)

    kyora, _ = client(handler)
    response = await kyora.call("pullFiles", path={"id": "sb_1"}, query={"path": ["/work"]}, timeout=0.3)
    assert not streams[0].closed
    await asyncio.sleep(0.6)
    assert streams[0].closed and response.is_closed


async def test_closing_the_client_never_waits_on_a_cleanup_that_ignores_cancellation(client, monkeypatch):
    from kyora import _http

    monkeypatch.setattr(_http, "CLEANUP_TIMEOUT", 0.1)
    monkeypatch.setattr(_http, "SETTLE", 0.1)
    finished = []

    async def stubborn():
        try:
            await hang()
        except asyncio.CancelledError:
            await asyncio.sleep(0.4)
            finished.append(True)

    kyora, _ = client(lambda r, i: json(200, {}))
    kyora.transport.cleanup(stubborn())
    begun = time.monotonic()
    await kyora.aclose()
    assert time.monotonic() - begun < 0.4
    assert finished == []
    await asyncio.sleep(0.5)
    assert finished == [True]


class CancelsAtTheEnd:
    """a JSON body that cancels `calls[0]` as its last byte is read"""

    def __init__(self, calls, body):
        self.calls = calls
        self.body = body

    def __call__(self, status):
        import httpx

        calls, body = self.calls, self.body

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield body
                calls[0].cancel()

        return httpx.Response(status, headers={"content-type": "application/json"}, stream=Body())


async def test_an_upload_cancelled_as_kyora_opens_it_is_aborted(client):
    import json as jsonlib

    calls = []
    opened = CancelsAtTheEnd(
        calls,
        jsonlib.dumps(
            {"uploadId": "up_1", "partSize": 32 * MiB, "maxPartBytes": 32 * MiB, "expiresAt": "2026-01-02T00:00:00Z"}
        ).encode(),
    )

    def handler(r, i):
        if r.url.path.endswith("/uploads"):
            return opened(201)
        return json(204)

    kyora, requests = client(handler)
    calls.append(asyncio.ensure_future(kyora.files.upload_tar("sb_1", bytes(65 * MiB))))
    with pytest.raises(asyncio.CancelledError):
        await calls[0]
    await kyora.aclose()
    assert (requests[-1].method, requests[-1].url.path) == ("DELETE", "/v1/sandboxes/sb_1/uploads/up_1")


async def test_a_replayed_restore_cancelled_before_it_returns_never_destroys_the_sandbox(client):
    import json as jsonlib

    calls = []
    replay = CancelsAtTheEnd(calls, jsonlib.dumps(sandbox("sb_r", status="starting")).encode())

    def handler(r, i):
        if r.method == "POST":
            return json(201, sandbox("sb_r", status="starting")) if i == 0 else replay(201)
        return json(204)

    kyora, requests = client(handler)
    first = await kyora.snapshots.restore("snap_1", idempotency_key="job-42", wait=False)
    assert first.id == "sb_r"
    calls.append(asyncio.ensure_future(kyora.snapshots.restore("snap_1", idempotency_key="job-42", wait=False)))
    with pytest.raises(asyncio.CancelledError):
        await calls[0]
    await kyora.aclose()
    assert [r.method for r in requests] == ["POST", "POST"]
