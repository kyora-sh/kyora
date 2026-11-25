import pytest
from fakes import BASE, Fake, error, json, sandbox
from pydantic import ValidationError

from kyora import AuthError, ConflictError, Kyora, Retry
from kyora._models import (
    CreateSecretBindingRequest,
    CreateSecretDeliveryRequest1,
    SecretInjectionRequest1,
    SecretInjectionRequest3,
)

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


def answer(r, i):
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


def test_an_injection_is_the_variant_its_type_names():
    query = {"host": "api.example.com", "injection": {"type": "query", "name": "token"}, "scope": SCOPE}
    assert isinstance(CreateSecretBindingRequest.model_validate(query).injection, SecretInjectionRequest3)
    header = {**query, "injection": {"type": "header", "name": "authorization"}}
    assert isinstance(CreateSecretBindingRequest.model_validate(header).injection, SecretInjectionRequest1)


@pytest.mark.parametrize(
    "injection",
    [{"type": "header", "name": "bad_name"}, {"type": "query", "name": "token", "template": "{{secret}}"}],
)
def test_an_injection_that_fits_no_variant_is_refused(injection):
    with pytest.raises(ValidationError):
        CreateSecretBindingRequest.model_validate({"host": "api.example.com", "injection": injection, "scope": SCOPE})


def test_the_blocking_client_reaches_the_same_operations(respx_mock):
    fake = Fake(answer)
    respx_mock.route(url__startswith=BASE).mock(side_effect=fake)
    with Kyora(token="kyora_test", base_url=BASE, retry=Retry(base_delay=0.001, max_delay=0.005)) as kyora:
        assert kyora.secrets.list()[0].id == "sec_1"
        assert kyora.secrets.get("example").name == "example"
        kyora.secrets.create({"name": "example", "value": "example-value", "hosts": ["api.example.com"]})
        kyora.secrets.rotate("sec_1", {"value": "example-value-2"})
        kyora.secrets.create_binding(
            "sec_1", {"host": "api.example.com", "injection": {"type": "query", "name": "token"}, "scope": SCOPE}
        )
        kyora.secrets.update_binding("sec_1", "sb1", {"enabled": True})
        kyora.secrets.delete_binding("sec_1", "sb1")
        kyora.secrets.create_delivery("sec_1", {"env": "API_KEY", "scope": SCOPE})
        kyora.secrets.update_delivery("sec_1", "sd1", {"enabled": False})
        kyora.secrets.delete_delivery("sec_1", "sd1")
        kyora.secrets.delete("sec_1")
    assert [f"{r.method} {r.url.path}" for r in fake.requests] == [
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
    assert fake.requests[4].json["injection"] == {"type": "query", "name": "token"}


@pytest.mark.anyio
async def test_a_delivery_goes_out_from_a_mapping_or_a_model(client):
    kyora, requests = client(answer)
    await kyora.secrets.create_delivery("sec_1", {"env": "API_KEY", "scope": SCOPE})
    await kyora.secrets.create_delivery("sec_1", CreateSecretDeliveryRequest1(env="API_KEY", scope=SCOPE))
    assert [r.json for r in requests] == [{"env": "API_KEY", "scope": SCOPE}] * 2


@pytest.mark.anyio
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


@pytest.mark.anyio
async def test_a_create_that_names_deliveries_sends_them_and_proxy_secrets(client):
    kyora, requests = client(lambda r, i: json(201, sandbox("sb_1")))
    secrets = [{"secret": "example", "env": "API_KEY"}, {"secret": "sec_2", "file": "api-key"}]
    await kyora.sandboxes.create({"secrets": secrets, "proxy_secrets": True})
    assert requests[0].json["secrets"] == secrets
    assert requests[0].json["proxySecrets"] is True


@pytest.mark.anyio
async def test_a_create_whose_secret_has_no_delivery_for_it_is_an_auth_error(client):
    kyora, _ = client(lambda r, i: error(403, "secret_not_delivered"))
    with pytest.raises(AuthError) as raised:
        await kyora.sandboxes.create({"secrets": [{"secret": "example", "env": "API_KEY"}]})
    assert raised.value.code == "secret_not_delivered"


@pytest.mark.anyio
async def test_a_rotation_that_lost_the_race_is_a_conflict(client):
    kyora, _ = client(lambda r, i: error(409, "secret_changed"))
    with pytest.raises(ConflictError) as raised:
        await kyora.secrets.rotate("sec_1", {"value": "example-value", "version": 1})
    assert raised.value.code == "secret_changed"
