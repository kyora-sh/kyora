"""Against a real kyora: runs only with KYORA_E2E=1 and KYORA_TOKEN (KYORA_BASE_URL optional)."""

import os

import pytest

from kyora import Kyora

pytestmark = pytest.mark.skipif(
    os.environ.get("KYORA_E2E") != "1" or not os.environ.get("KYORA_TOKEN"), reason="KYORA_E2E=1 and KYORA_TOKEN"
)


@pytest.fixture
def kyora():
    with Kyora(base_url=os.environ.get("KYORA_BASE_URL")) as client:
        yield client


def test_a_sandbox_runs_a_command_and_moves_files(kyora):
    assert kyora.health().ok is True
    sandbox = kyora.sandboxes.create(
        {"vcpus": 1, "memory_mb": 1024, "ttl_seconds": 600, "labels": {"sdk": "python-e2e"}}
    )
    try:
        kyora.sandboxes.wait_until_running(sandbox, timeout=300)
        kyora.files.upload(sandbox.id, {"in.txt": "hello"})
        result = kyora.exec.run(sandbox.id, {"cmd": ["sh", "-c", "tr a-z A-Z < in.txt > out.txt"], "cwd": "/work"})
        assert result.exit_code == 0, result.stderr
        assert kyora.files.read(sandbox.id, "/work/out.txt") == b"HELLO"
        assert any(s.id == sandbox.id for s in kyora.sandboxes.iterate(labels={"sdk": "python-e2e"}))
    finally:
        kyora.sandboxes.delete(sandbox.id)
