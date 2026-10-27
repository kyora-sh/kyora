# kyora

The kyora API for Python: create sandboxes, run commands in them, move files in and out, snapshot and restore them, expose their ports and manage tokens. Typed from the API's OpenAPI document (pydantic models), with typed errors, retries that honour `Retry-After`, automatic idempotency keys and a deadline on every call that waits. A blocking client, `Kyora`, and an asyncio one, `AsyncKyora`, with the same methods.

## Install

```bash
pip install kyora
# or
uv add kyora
```

Python 3.10 or later. Depends on `httpx` and `pydantic`.

```python
from kyora import Kyora

kyora = Kyora(token="kyora_...", region="eu")
```

`token` defaults to `KYORA_TOKEN`. `base_url` defaults to `https://cloud.kyora.sh`. `region` is where creates and restores go when they name none; without it kyora picks. A scoped token (see `tokens.create`) is the usual choice for a service: it can be limited to labels, regions, sizes and a number of sandboxes. Close a client with `close()` (`aclose()` for `AsyncKyora`) or use it as a context manager.

## Example: a document agent sandbox

An agent gets a fresh sandbox per document: the document goes in, a command processes it, the result comes out, and the sandbox is destroyed.

```python
from pathlib import Path

from kyora import Kyora, KyoraError, LimitError

kyora = Kyora()


def process_document(name: str, document: bytes) -> str:
    sandbox = kyora.sandboxes.create(
        {"vcpus": 2, "memory_mb": 4096, "network": "none", "ttl_seconds": 900, "labels": {"app": "doc-agent"}},
        timeout=60,
    )
    try:
        kyora.files.upload(
            sandbox.id,
            {
                f"inbox/{name}": document,
                "extract.sh": "#!/bin/sh\nset -e\nmkdir -p out\nwc -w inbox/* > out/summary.txt\n",
            },
        )
        result = kyora.exec.run(
            sandbox.id, {"cmd": ["sh", "extract.sh"], "cwd": "/work", "timeout_seconds": 300}, timeout=330
        )
        if result.exit_code != 0:
            raise RuntimeError(f"extract failed ({result.exit_code}): {result.stderr.decode()}")
        return kyora.files.read(sandbox.id, "/work/out/summary.txt").decode()
    finally:
        kyora.sandboxes.delete(sandbox.id)


try:
    print(process_document("contract.pdf", Path("contract.pdf").read_bytes()))
except LimitError as error:
    print("over a quota or token limit; try later:", error.code)
except KyoraError as error:
    if not error.retryable:
        raise
    print(f"try again in {error.retry_after or 1} s:", error.code)
```

The same with `AsyncKyora`:

```python
import asyncio

from kyora import AsyncKyora


async def main() -> None:
    async with AsyncKyora() as kyora:
        sandbox = await kyora.sandboxes.create({"vcpus": 2, "labels": {"app": "doc-agent"}})
        try:
            result = await kyora.exec.run(sandbox.id, {"cmd": ["uname", "-a"]})
            print(result.stdout.decode())
        finally:
            await kyora.sandboxes.delete(sandbox.id)


asyncio.run(main())
```

Request bodies are a model from `kyora.models` (`CreateSandboxRequest(...)`) or a dict, with snake_case or wire (camelCase) keys; only the fields you set are sent, and a field the API doesn't know is refused before anything is sent. Answers are models (`Sandbox`, `Snapshot`, ...) with snake_case attributes. Files upload under `/work` unless `dest` says otherwise.

## Errors

Every failure is a `KyoraError`, of the subclass its class names (`TransientError`, `LimitError`, `ConflictError`, `NotFoundError`, `AuthError`, `InvalidRequestError`, `UnavailableError`):

| field | |
| --- | --- |
| `code` | the API's error code (`no_capacity`, `quota_exceeded`, `name_taken`, ...), or one of the SDK's own: `timeout`, `network_error`, `bad_response`, `stream_lost`, `exec_error` |
| `status` | the HTTP status, 0 when nothing answered |
| `class_` | `transient`, `limit`, `conflict`, `not_found`, `auth`, `invalid` or `unavailable` |
| `retryable` | the same request can succeed later |
| `retry_after` | the least wait kyora asked for, in seconds, when it did |

`class_` and `retryable` come from the API's error catalog (`ERROR_CODES`), per status where a code's retryability depends on it. A code newer than the SDK is classed by its status. Branch on `code` or the class, never on the message. A `limit` error (a quota, a token's constraints, a full queue) is its own class so a caller can park the work instead of retrying it. An answer that doesn't match the API's schema is a `bad_response`. `ExecDetachedError` (below) is a `KyoraError` of its own.

## Retries and deadlines

A call that fails with a retryable error is repeated, up to 4 tries, after the `Retry-After` kyora sends (or a backoff from 0.25 s). Only requests that are safe to repeat are: reads, `PUT`, `PATCH` and `DELETE`, and creates, which carry an `Idempotency-Key` (a fresh one per call unless you pass `idempotency_key`) so a repeat never creates twice. Other writes are repeated only after a 429.

Every call takes `timeout` (seconds) and `deadline` (epoch seconds or an aware `datetime`). The bound covers the whole call, waits and retries included. A `Retry-After` that would end past it is not slept: the call raises that error at once, with its `retry_after`, so a caller with a few seconds to spare can decide for itself. Calls that don't stream default to 30 s (`timeout` on the client changes it), creates to 2 min, and the helpers that wait for a state (a snapshot ready, a restore running) to an hour. `retry=False` makes one try; `retry=Retry(max_attempts=..., base_delay=..., max_delay=..., max_retry_after=...)` tunes it, per client or per call. To stop an `AsyncKyora` call, cancel its task; a blocking call stops on Ctrl-C. A create cut short by its deadline or a cancellation may still have made its sandbox: pass your own `idempotency_key`, and the same create with the same key answers that sandbox instead of making another.

## Sandboxes

```python
sandbox = kyora.sandboxes.create({"vcpus": 4, "labels": {"run": "42"}})
kyora.sandboxes.get(sandbox.id)
kyora.sandboxes.update(sandbox.id, {"ttl_seconds": 7200})
kyora.sandboxes.delete(sandbox.id)  # False when it was already gone

# one page at a time
page = kyora.sandboxes.list(labels={"run": "42"}, limit=100)
more = kyora.sandboxes.list(labels={"run": "42"}, cursor=page.next_cursor) if page.next_cursor else None

# or every match (`async for` on AsyncKyora)
for found in kyora.sandboxes.iterate(labels={"run": "42"}):
    kyora.sandboxes.delete(found.id)
```

With `wait` (seconds) in the create, a create kyora has no room for right now waits in line instead of failing with `no_capacity`; `on_queued` sees each ticket, and the deadline or a cancellation takes it out of line.

## Exec

```python
import sys

result = kyora.exec.run(
    sandbox.id,
    {"cmd": ["pytest", "-q"], "cwd": "/work", "env": {"CI": "1"}},
    on_output=lambda stream, chunk: getattr(sys, stream).buffer.write(chunk),
)
result.exit_code  # None when a signal ended it, see result.signal
result.timed_out  # the exec's timeout_seconds stopped it
result.stdout  # bytes; result.stderr too
result.truncated  # .stdout, .stderr: output the result is missing

# or the output as it arrives
with kyora.exec.stream(sandbox.id, {"cmd": ["make"]}) as stream:  # `async with` / `async for` on AsyncKyora
    for chunk in stream:
        print(chunk.stream, chunk.data)
print(stream.result.exit_code)
```

Every command runs resumable under an exec key (`key`, a fresh one unless you pass it). When the stream breaks, the command keeps running and `run` reattaches from the bytes it already has, for up to `reattach_window` (2 min). At its deadline `run` stops waiting and raises an `ExecDetachedError` with the command's `exec_id`, `key` and `offsets`; the command keeps running. Get the rest with `exec.attach(sandbox, exec_id, from_=offsets)`, or run the same request with the same `key` again, from another process too: kyora rejoins the running command instead of starting it twice. A stream that breaks before kyora named the command is found again by its key; one that started without an id is never sent again, so a command never runs twice. Cancelling the call cancels the command (`cancel_on_cancel=False` keeps it). An exception from `on_output` ends the call as it is. `result.stdout` keeps the first 16 MiB of each stream (`max_output_bytes`); `on_output` sees all of it. On `Kyora`, callbacks run on the client's own thread, so they must not call the blocking client back.

## Files

```python
kyora.files.upload(sandbox.id, {"src/main.py": source, "data.bin": data}, dest="/work/job")
kyora.files.upload_tar(sandbox.id, tar_bytes_or_file_or_chunks)  # above 64 MiB it goes up in parts
data = kyora.files.read(sandbox.id, "/work/out/report.json")
entries = kyora.files.download(sandbox.id, ["/work/out"])  # [TarEntry(name, type, mode, data, ...)]
with kyora.files.download_tar(sandbox.id, ["/work/out"]) as tar:  # the raw tar as it streams in
    for chunk in tar:
        ...
```

## Snapshots, ports and tokens

```python
snapshot = kyora.snapshots.create(sandbox.id, {"name": "deps-installed"})  # waits until ready
copy = kyora.snapshots.restore(snapshot.id, {"labels": {"run": "43"}})  # waits until running
for old in kyora.snapshots.iterate(labels={"run": "42"}):
    kyora.snapshots.delete(old.id)

port = kyora.ports.expose(sandbox.id, 8080, public=True)  # port.url
kyora.ports.unexpose(sandbox.id, port.label)

created = kyora.tokens.create(
    {
        "name": "doc-agent",
        "scopes": ["vms:read", "vms:write", "vms:exec"],
        "constraints": {"labels": {"app": "doc-agent"}, "max_sandboxes": 10},
    }
)
created.token  # the secret, shown once
```

## Everything else

`kyora.call(operation_id, path=..., query=..., body=...)` sends any operation of the API with the same errors, retries and idempotency keys. JSON operations answer their parsed body; streamed, binary and HEAD ones the `httpx.Response` (on `AsyncKyora` still open: read it and `aclose()` it). Operations without a helper yet, the same as the TypeScript SDK's (`COVERAGE` lists every operation and its method or reason):

- custom domains and static pages: `kyora.call()` until a helper lands
- computer use and live views: a later release
- interactive terminals (they need a WebSocket client): a later release
- account images, built with the kyora CLI: a later release
- object storage, which speaks S3 too: `kyora.call()` until a helper lands

## Versions

The SDK follows the API's `/v1` stability promise: additive changes only. `SPEC_VERSION` is the API version it was generated from, the same document as `@kyora-sh/sdk`'s, and both SDKs are released with the same version.

## Developing

```bash
uv run pytest
uv run ruff check && uv run ruff format --check
uv run scripts/generate.py          # src/kyora/_models.py, _error_codes.py, _operations.py from ../typescript/openapi.yaml
uv run scripts/generate.py --check  # fails when they are out of date
```

The generated files are committed. `tests/test_coverage.py` fails when an operation of the spec has neither a method nor an entry in `src/kyora/_coverage.py` saying why not yet, and when that split differs from the TypeScript SDK's `coverage.ts`. `tests/e2e` runs against a real kyora only with `KYORA_E2E=1` and `KYORA_TOKEN`.
