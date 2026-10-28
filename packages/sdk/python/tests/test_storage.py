import httpx
import pytest
from fakes import BASE, Fake, error, json

from kyora import Kyora, KyoraError, ObjectInfo, Retry

pytestmark = pytest.mark.anyio
KiB = 1024


@pytest.fixture
def small(monkeypatch):
    """objects past 256 KiB go up in parts, so a multipart upload needs no large copies"""
    from kyora import _client

    monkeypatch.setattr(_client, "SINGLE_UPLOAD_BYTES", 256 * KiB)


def bucket(name):
    return {"name": name, "region": "eu", "createdAt": "2026-01-01T00:00:00Z"}


def obj(key):
    return {"key": key, "size": 1, "etag": "e", "lastModified": "x"}


def route(request):
    query = request.url.query.decode()
    return f"{request.method} {request.url.raw_path.decode().split('?')[0]}{'?' + query if query else ''}"


def cors(origins):
    return {
        "bucket": "site",
        "origins": origins,
        "methods": [],
        "allowedHeaders": [],
        "exposeHeaders": [],
        "maxAgeSeconds": 0,
    }


def key(**extra):
    return {
        "id": "sk_1",
        "hint": "h",
        "bucket": "site",
        "prefix": "",
        "access": "read",
        "createdAt": "2026-01-01T00:00:00Z",
        "expiresAt": "2026-02-01T00:00:00Z",
        "lastUsedAt": None,
        **extra,
    }


async def test_buckets_cors_keys_audit_and_presign_reach_their_operations(client):
    def answer(r, i):
        path = r.url.path
        if path.endswith("/cors"):
            return json(200, cors(["https://example.com"] if r.method == "PUT" else []))
        if path.endswith("/presign"):
            signed = {"url": "https://signed.example.test/o", "method": "PUT", "key": "a.txt"}
            return json(201, {**signed, "expiresAt": "2026-01-01T00:00:00Z", "headers": {}})
        if path == "/v1/storage/keys":
            return json(200, {"keys": [key()]}) if r.method == "GET" else json(201, key(key="secret"))
        if path.startswith("/v1/storage/keys/"):
            return json(200, {"id": "sk_1", "revoked": True})
        if path == "/v1/storage/audit":
            return json(200, {"events": []})
        if path == "/v1/storage/buckets":
            return (
                json(200, {"buckets": [bucket("site")], "limit": 10})
                if r.method == "GET"
                else json(201, bucket("site"))
            )
        return json(200, bucket("site"))

    kyora, requests = client(answer)
    assert [b.name for b in await kyora.storage.buckets.list()] == ["site"]
    await kyora.storage.buckets.create("site", region="eu")
    await kyora.storage.buckets.get("site")
    await kyora.storage.buckets.cors("site")
    assert (await kyora.storage.buckets.set_cors("site", ["https://example.com"])).origins == ["https://example.com"]
    await kyora.storage.buckets.clear_cors("site")
    signed = await kyora.storage.objects.presign("site", {"key": "a.txt", "method": "PUT", "ttl_seconds": 60})
    assert str(signed.url) == "https://signed.example.test/o"
    assert [k.id for k in await kyora.storage.keys.list()] == ["sk_1"]
    assert (await kyora.storage.keys.create({"bucket": "site", "prefix": "build/", "access": "read"})).key == "secret"
    assert (await kyora.storage.keys.revoke("sk_1")).revoked is True
    assert await kyora.storage.audit(limit=5) == []
    assert [route(r) for r in requests] == [
        "GET /v1/storage/buckets",
        "POST /v1/storage/buckets",
        "GET /v1/storage/buckets/site",
        "GET /v1/storage/buckets/site/cors",
        "PUT /v1/storage/buckets/site/cors",
        "DELETE /v1/storage/buckets/site/cors",
        "POST /v1/storage/buckets/site/presign",
        "GET /v1/storage/keys",
        "POST /v1/storage/keys",
        "DELETE /v1/storage/keys/sk_1",
        "GET /v1/storage/audit?limit=5",
    ]
    assert requests[1].json == {"name": "site", "region": "eu"}
    assert requests[4].json == {"origins": ["https://example.com"]}
    assert requests[6].json == {"key": "a.txt", "method": "PUT", "ttlSeconds": 60}
    assert requests[8].json == {"bucket": "site", "prefix": "build/", "access": "read"}


async def test_a_bucket_goes_to_the_clients_region_unless_the_create_names_one(client):
    kyora, requests = client(lambda r, i: json(201, bucket("site")), region="eu")
    await kyora.storage.buckets.create("site")
    await kyora.storage.buckets.create("site", region="us")
    assert [r.json for r in requests] == [{"name": "site", "region": "eu"}, {"name": "site", "region": "us"}]


async def test_a_forced_bucket_delete_is_called_again_until_kyora_answers_it_deleted_counting_every_object(client):
    progress = {"name": "site", "deleted": False, "objectsDeleted": 1000, "done": False, "message": "more"}
    finished = {"name": "site", "deleted": True, "objectsDeleted": 7, "done": True}
    kyora, requests = client(lambda r, i: json(202, progress) if i < 2 else json(200, finished))
    answer = await kyora.storage.buckets.delete("site", force=True)
    assert answer.model_dump(by_alias=True) == {**finished, "objectsDeleted": 2007}
    assert [route(r) for r in requests] == ["DELETE /v1/storage/buckets/site?force=true"] * 3


async def test_a_bucket_delete_without_force_sends_no_force_and_a_non_empty_bucket_is_an_error(client):
    kyora, requests = client(lambda r, i: error(409, "bucket_not_empty"))
    with pytest.raises(KyoraError) as caught:
        await kyora.storage.buckets.delete("site")
    assert caught.value.code == "bucket_not_empty"
    assert [route(r) for r in requests] == ["DELETE /v1/storage/buckets/site"]


async def test_objects_are_listed_page_by_page_keys_with_slashes_kept(client):
    def answer(r, i):
        if r.url.params.get("cursor"):
            return json(200, {"objects": [obj("b/2")], "prefixes": [], "cursor": None})
        return json(200, {"objects": [obj("b/1")], "prefixes": ["b/c/"], "cursor": "c1"})

    kyora, requests = client(answer)
    page = await kyora.storage.objects.list("site", prefix="b/", limit=1)
    assert ([o.key for o in page.items], page.next_cursor, page.prefixes) == (["b/1"], "c1", ["b/c/"])
    assert [o.key async for o in kyora.storage.objects.iterate("site", prefix="b/")] == ["b/1", "b/2"]
    assert [route(r) for r in requests] == [
        "GET /v1/storage/buckets/site/o?prefix=b%2F&limit=1",
        "GET /v1/storage/buckets/site/o?prefix=b%2F",
        "GET /v1/storage/buckets/site/o?prefix=b%2F&cursor=c1",
    ]


async def test_get_get_stream_head_and_delete_reach_the_object(client):
    info = {"content-length": "5", "etag": '"abc"', "content-type": "text/plain", "last-modified": "Wed, 28 Oct 2026"}

    def answer(r, i):
        if r.method == "HEAD":
            return httpx.Response(200, headers=info)
        if r.method == "DELETE":
            return json(204)
        return httpx.Response(200, content=b"hello", headers={"content-type": "text/plain"})

    kyora, requests = client(answer)
    assert await kyora.storage.objects.get("site", "dir/a b.txt") == b"hello"
    async with await kyora.storage.objects.get_stream("site", "dir/a b.txt") as stream:
        assert b"".join([chunk async for chunk in stream]) == b"hello"
    assert await kyora.storage.objects.head("site", "dir/a b.txt") == ObjectInfo(
        5, '"abc"', "text/plain", info["last-modified"]
    )
    assert await kyora.storage.objects.delete("site", "dir/a b.txt") is None
    assert [route(r) for r in requests] == [
        f"{method} /v1/storage/buckets/site/o/dir/a%20b.txt" for method in ("GET", "GET", "HEAD", "DELETE")
    ]


async def test_a_missing_object_is_a_not_found_error_on_get_and_on_head(client):
    kyora, _ = client(lambda r, i: httpx.Response(404) if r.method == "HEAD" else error(404, "not_found"))
    for read in (kyora.storage.objects.get, kyora.storage.objects.head):
        with pytest.raises(KyoraError) as caught:
            await read("site", "gone")
        assert (caught.value.code, caught.value.status) == ("not_found", 404)


async def test_a_small_object_goes_up_in_one_put_with_its_content_type(client):
    kyora, requests = client(lambda r, i: json(200, {"key": "a.txt", "size": 5, "etag": "e"}))
    answer = await kyora.storage.objects.put("site", "a.txt", "hello", content_type="text/plain")
    assert (answer.key, answer.size, answer.etag) == ("a.txt", 5, "e")
    assert [route(r) for r in requests] == ["PUT /v1/storage/buckets/site/o/a.txt"]
    assert requests[0].headers["content-type"] == "text/plain"
    assert requests[0].body == b"hello"


def multipart(max_part_bytes=128 * KiB, max_parts=10000, fail_parts=False):
    def answer(r, i):
        params = r.url.params
        if r.method == "POST" and "uploads" in params:
            start = {"key": "big", "uploadId": "up_1", "maxPartBytes": max_part_bytes, "maxParts": max_parts}
            return json(201, start)
        if r.method == "PUT":
            if fail_parts:
                return error(400, "invalid_request")
            return json(200, {"partNumber": int(params["partNumber"]), "etag": f"e{params['partNumber']}"})
        if r.method == "DELETE":
            return json(204)
        return json(200, {"key": "big", "size": 1, "etag": "e-3"})

    return answer


async def test_a_large_object_goes_up_in_parts_and_is_completed(client, small):
    kyora, requests = client(multipart())
    chunks = [b"x" * (100 * KiB)] * 2 + [b"y" * (56 * KiB + 1)]
    assert (await kyora.storage.objects.put("site", "big", iter(chunks), content_type="video/mp4")).etag == "e-3"
    assert [route(r) for r in requests] == [
        "POST /v1/storage/buckets/site/o/big?uploads=",
        "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=1",
        "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=2",
        "PUT /v1/storage/buckets/site/o/big?uploadId=up_1&partNumber=3",
        "POST /v1/storage/buckets/site/o/big?uploadId=up_1",
    ]
    assert requests[0].headers["content-type"] == "video/mp4"
    assert [len(r.body) for r in requests[1:4]] == [128 * KiB, 128 * KiB, 1]
    assert requests[-1].json == {"parts": [{"partNumber": n, "etag": f"e{n}"} for n in (1, 2, 3)]}


async def test_a_view_of_wider_items_goes_up_byte_for_byte(client, small):
    kyora, requests = client(multipart())
    data = bytes(range(256)) * 1025
    await kyora.storage.objects.put("site", "big", memoryview(bytearray(data)).cast("I"))
    assert b"".join(r.body for r in requests if r.method == "PUT") == data


async def test_a_failed_part_aborts_the_multipart_upload(client, small):
    kyora, requests = client(multipart(fail_parts=True))
    with pytest.raises(KyoraError) as caught:
        await kyora.storage.objects.put("site", "big", bytes(512 * KiB))
    assert caught.value.code == "invalid_request"
    assert route(requests[-1]) == "DELETE /v1/storage/buckets/site/o/big?uploadId=up_1"


async def test_an_upload_past_kyoras_part_count_is_refused_and_aborted(client, small):
    kyora, requests = client(multipart(max_part_bytes=64 * KiB, max_parts=2))
    with pytest.raises(KyoraError) as caught:
        await kyora.storage.objects.put("site", "big", bytes(512 * KiB))
    assert (caught.value.code, caught.value.status) == ("invalid_request", 0)
    assert len([r for r in requests if r.method == "PUT"]) == 2
    assert route(requests[-1]) == "DELETE /v1/storage/buckets/site/o/big?uploadId=up_1"


def test_the_blocking_client_reaches_storage_too(respx_mock):
    def answer(r, i):
        if r.method == "HEAD":
            return httpx.Response(200, headers={"content-length": "2"})
        if r.url.path.endswith("/o"):
            return json(200, {"objects": [obj("a")], "prefixes": [], "cursor": None})
        return httpx.Response(200, content=b"hi")

    fake = Fake(answer)
    respx_mock.route(url__startswith=BASE).mock(side_effect=fake)
    with Kyora(token="kyora_test", base_url=BASE, retry=Retry(base_delay=0.001, max_delay=0.005)) as kyora:
        assert [o.key for o in kyora.storage.objects.iterate("site")] == ["a"]
        assert kyora.storage.objects.get("site", "a") == b"hi"
        with kyora.storage.objects.get_stream("site", "a") as stream:
            assert b"".join(stream) == b"hi"
        assert kyora.storage.objects.head("site", "a").size == 2
