import pytest
from fakes import error, json

from kyora import ConflictError

pytestmark = pytest.mark.anyio

SCOPE = {"labels": {"team": "docs"}}
BINDING = {
    "id": "sb1",
    "secretId": "sec_1",
    "host": "api.example.com",
    "pathPrefix": "/",
    "methods": ["GET"],
    "injection": {"type": "header", "name": "authorization", "template": "Bearer {{secret}}"},
    "scope": SCOPE,
    "enabled": True,
    "expiresAt": None,
    "createdAt": 1,
    "updatedAt": 1,
    "lastUsedAt": None,
}
DELIVERY = {
    "id": "sd1",
    "secretId": "sec_1",
    "kind": "file",
    "target": "api-key",
    "mode": 256,
    "scope": SCOPE,
    "enabled": True,
    "expiresAt": None,
    "createdAt": 1,
    "updatedAt": 1,
    "lastDeliveredAt": None,
    "visibleToCode": True,
}
SECRET = {
    "id": "sec_1",
    "name": "example",
    "description": "",
    "hosts": ["api.example.com"],
    "sandbox": True,
    "version": 1,
    "createdAt": 1,
    "updatedAt": 1,
    "bindings": [BINDING],
    "deliveries": [DELIVERY],
}


async def test_every_secrets_method_reaches_its_operation_with_its_body(client):
    def handler(r, i):
        path = r.url.path
        status = 201 if r.method == "POST" else 200
        if r.method == "DELETE":
            return json(200, {"deleted": path.rsplit("/", 1)[-1]})
        if path == "/v1/secrets" and r.method == "GET":
            return json(200, {"secrets": [SECRET]})
        if "/bindings" in path:
            return json(status, BINDING)
        if "/deliveries" in path:
            return json(status, DELIVERY)
        return json(status, SECRET)

    kyora, requests = client(handler)
    assert (await kyora.secrets.list())[0].bindings[0].host == "api.example.com"
    assert (await kyora.secrets.get("example")).id == "sec_1"
    await kyora.secrets.create({"name": "example", "value": "example-value", "hosts": ["api.example.com"]})
    await kyora.secrets.rotate("sec_1", {"value": "example-value-2", "version": 1})
    binding = {"host": "api.example.com", "injection": {"type": "basic", "username": "ci"}, "scope": SCOPE}
    await kyora.secrets.create_binding("sec_1", binding)
    await kyora.secrets.update_binding("sec_1", "sb1", {"enabled": False})
    await kyora.secrets.delete_binding("sec_1", "sb1")
    delivered = await kyora.secrets.create_delivery("sec_1", {"file": "api-key", "scope": SCOPE})
    assert delivered.mode == 256
    await kyora.secrets.update_delivery("sec_1", "sd1", {"expires_at": None})
    await kyora.secrets.delete_delivery("sec_1", "sd1")
    await kyora.secrets.delete("sec_1")
    assert [f"{r.method} {r.url.path}" for r in requests] == [
        "GET /v1/secrets",
        "GET /v1/secrets/example",
        "POST /v1/secrets",
        "PUT /v1/secrets/sec_1/value",
        "POST /v1/secrets/sec_1/bindings",
        "PATCH /v1/secrets/sec_1/bindings/sb1",
        "DELETE /v1/secrets/sec_1/bindings/sb1",
        "POST /v1/secrets/sec_1/deliveries",
        "PATCH /v1/secrets/sec_1/deliveries/sd1",
        "DELETE /v1/secrets/sec_1/deliveries/sd1",
        "DELETE /v1/secrets/sec_1",
    ]
    bodies = [r.json for r in requests]
    assert bodies[3] == {"value": "example-value-2", "version": 1}
    assert bodies[4] == binding
    assert bodies[5] == {"enabled": False}
    assert bodies[7] == {"file": "api-key", "scope": SCOPE}
    assert bodies[8] == {"expiresAt": None}


async def test_a_rotation_that_lost_the_race_is_a_conflict(client):
    kyora, _ = client(lambda r, i: error(409, "secret_changed"))
    with pytest.raises(ConflictError) as raised:
        await kyora.secrets.rotate("sec_1", {"value": "example-value", "version": 1})
    assert raised.value.code == "secret_changed"
