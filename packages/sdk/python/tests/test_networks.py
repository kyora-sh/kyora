import pytest
from fakes import BASE, error, json, sandbox

from kyora import AuthError, Kyora, Retry

pytestmark = pytest.mark.anyio

NET = "net_0123456789abcdef0123"
NETWORK = {
    "id": NET,
    "name": "backend",
    "cidr": "10.20.0.0/24",
    "gateway": "10.20.0.1",
    "createdAt": "2026-11-04T00:00:00.000Z",
    "memberCount": 1,
}
MEMBER = {"sandboxId": "sb_1", "ip": "10.20.0.5", "state": "active"}


def handler(r, i):
    if r.method == "GET" and r.url.path == "/v1/networks":
        return json(200, {"networks": [NETWORK]})
    if r.method == "POST":
        return json(201, {**NETWORK, "memberCount": 0})
    if r.method == "GET":
        return json(200, {**NETWORK, "members": [MEMBER]})
    return json(204)


def paths(requests):
    return [f"{r.method} {r.url.path}" for r in requests]


EXPECTED = ["GET /v1/networks", "POST /v1/networks", f"GET /v1/networks/{NET}", f"DELETE /v1/networks/{NET}"]


async def test_list_create_get_and_delete_reach_their_operations(client):
    kyora, requests = client(handler)
    assert [n.id for n in await kyora.networks.list()] == [NET]
    created = await kyora.networks.create({"name": "backend", "cidr": "10.20.0.0/24"})
    assert (created.name, created.member_count) == ("backend", 0)
    assert (await kyora.networks.get(NET)).members[0].ip == "10.20.0.5"
    assert await kyora.networks.delete(NET) is None
    assert paths(requests) == EXPECTED
    assert requests[1].json == {"name": "backend", "cidr": "10.20.0.0/24"}


async def test_a_create_takes_one_private_network_or_several(client):
    answer = sandbox("sb_1", privateNetwork={"id": NET, "cidr": "10.20.0.0/24", "ip": "10.20.0.5"})
    kyora, requests = client(lambda r, i: json(201, answer))
    one = await kyora.sandboxes.create({"private_network": {"id": NET, "ip": "10.20.0.5"}})
    assert one.private_network.ip == "10.20.0.5"
    other = "net_fedcba9876543210fedc"
    await kyora.sandboxes.create({"private_networks": [{"id": NET}, {"id": other}]})
    assert requests[0].json["privateNetwork"] == {"id": NET, "ip": "10.20.0.5"}
    assert requests[1].json["privateNetworks"] == [{"id": NET}, {"id": other}]


async def test_an_account_without_private_networks_gets_privnet_not_enabled_once(client):
    kyora, requests = client(lambda r, i: error(403, "privnet_not_enabled"))
    with pytest.raises(AuthError) as caught:
        await kyora.networks.list()
    assert (caught.value.code, caught.value.retryable) == ("privnet_not_enabled", False)
    assert len(requests) == 1


def test_the_blocking_client_has_the_same_networks(respx_mock):
    from fakes import Fake

    fake = Fake(handler)
    respx_mock.route(url__startswith=BASE).mock(side_effect=fake)
    with Kyora(token="kyora_test", base_url=BASE, retry=Retry(base_delay=0.001, max_delay=0.005)) as kyora:
        assert [n.id for n in kyora.networks.list()] == [NET]
        assert kyora.networks.create({"name": "backend", "cidr": "10.20.0.0/24"}).member_count == 0
        assert kyora.networks.get(NET).members[0].sandbox_id == "sb_1"
        assert kyora.networks.delete(NET) is None
    assert paths(fake.requests) == EXPECTED
