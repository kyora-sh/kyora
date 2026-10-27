from __future__ import annotations

import json
from typing import Any

from ._error_codes import ERROR_CODES, ErrorClass

TRANSIENT_STATUSES = frozenset({0, 429, 502, 503, 504})


CLIENT_CODES: dict[str, tuple[ErrorClass, bool]] = {
    "timeout": ("transient", True),
    "network_error": ("transient", True),
    "bad_response": ("unavailable", False),
    "stream_lost": ("transient", True),
    "exec_error": ("unavailable", False),
}


class KyoraError(Exception):
    """Every failure of a call, as the TypeScript SDK's KyoraError.

    Branch on `code` (or `class_` for a family of codes), never on `message`. `status` is the HTTP
    status, or 0 when nothing answered. `retry_after` is the least wait kyora asked for, in seconds.
    `sandbox_id` is the sandbox a restore under your own `idempotency_key` made or answered, left
    running when its wait failed.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int = 0,
        retryable: bool | None = None,
        retry_after: float | None = None,
        class_: ErrorClass | None = None,
        operation: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        known_class, known_retryable = classify(code, status)
        self.message = message
        self.code = code
        self.status = status
        self.class_: ErrorClass = class_ or known_class
        self.retryable = known_retryable if retryable is None else retryable
        self.retry_after = retry_after
        self.operation = operation
        self.body = body
        self.sandbox_id: str | None = None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status}, message={self.message!r})"


class AuthError(KyoraError):
    pass


class ConflictError(KyoraError):
    pass


class InvalidRequestError(KyoraError):
    pass


class LimitError(KyoraError):
    pass


class NotFoundError(KyoraError):
    pass


class TransientError(KyoraError):
    pass


class UnavailableError(KyoraError):
    pass


CLASSES: dict[ErrorClass, type[KyoraError]] = {
    "auth": AuthError,
    "conflict": ConflictError,
    "invalid": InvalidRequestError,
    "limit": LimitError,
    "not_found": NotFoundError,
    "transient": TransientError,
    "unavailable": UnavailableError,
}


def status_class(status: int) -> ErrorClass:
    if status in (401, 403):
        return "auth"
    if status in (402, 413):
        return "limit"
    if status in (404, 410):
        return "not_found"
    if status == 409:
        return "conflict"
    if status in TRANSIENT_STATUSES:
        return "transient"
    if status >= 500:
        return "unavailable"
    return "invalid"


def classify(code: str, status: int) -> tuple[ErrorClass, bool]:
    """A code's class and retryability at a status; a code newer than this SDK goes by its status."""
    if code in CLIENT_CODES:
        return CLIENT_CODES[code]
    entry = ERROR_CODES.get(code)
    if entry is None:
        return status_class(status), status in TRANSIENT_STATUSES
    retryable = entry["retryable"]
    return entry["error_class"], retryable if isinstance(retryable, bool) else status in retryable


def make_error(
    message: str, *, code: str, status: int = 0, class_: ErrorClass | None = None, **fields: Any
) -> KyoraError:
    """A KyoraError of the subclass its class names."""
    cls = class_ or classify(code, status)[0]
    return CLASSES[cls](message, code=code, status=status, class_=cls, **fields)


def retry_after_seconds(header: str | None, now: float) -> float | None:
    """Retry-After as seconds: delay-seconds or an HTTP date; None when absent or unreadable."""
    if header is None or not header.strip():
        return None
    try:
        seconds = float(header)
    except ValueError:
        from email.utils import parsedate_to_datetime

        try:
            return max(0.0, parsedate_to_datetime(header).timestamp() - now)
        except (TypeError, ValueError):
            return None
    return None if seconds < 0 or seconds != seconds else round(seconds, 3)


def from_response(operation: str, status: int, text: str, retry_after_header: str | None, now: float) -> KyoraError:
    """The KyoraError a non-2xx answer stands for (errors.ts errorFromResponse)."""
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    fields = body if isinstance(body, dict) else {}
    code = fields.get("error") if isinstance(fields.get("error"), str) and fields.get("error") else f"http_{status}"
    message = fields.get("message") if isinstance(fields.get("message"), str) and fields.get("message") else None
    if message is None:
        message = text.strip()[:200] if text.strip() and not text.lstrip().startswith("<") else f"HTTP {status}"
    ms = fields.get("retryAfterMs")
    if isinstance(ms, (int, float)) and not isinstance(ms, bool) and ms >= 0 and ms == ms and ms != float("inf"):
        after: float | None = round(ms) / 1000
    else:
        after = retry_after_seconds(retry_after_header, now)
    retryable = fields.get("retryable") if isinstance(fields.get("retryable"), bool) else None
    return make_error(
        f"{operation}: {message}",
        code=code,
        status=status,
        retryable=retryable,
        retry_after=after,
        operation=operation,
        body=body,
    )
