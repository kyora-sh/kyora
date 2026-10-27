import re
from pathlib import Path

import yaml

from kyora import COVERAGE, AsyncKyora, Kyora
from kyora._operations import OPERATIONS

TYPESCRIPT = Path(__file__).resolve().parents[2] / "typescript"
SPEC = yaml.safe_load((TYPESCRIPT / "openapi.yaml").read_text())
SPEC_OPERATIONS = [
    operation["operationId"]
    for item in SPEC["paths"].values()
    for operation in item.values()
    if isinstance(operation, dict) and "operationId" in operation
]


def snake(name: str) -> str:
    return ".".join(re.sub(r"(?<!^)([A-Z])", lambda m: "_" + m.group(1).lower(), part) for part in name.split("."))


def typescript_coverage() -> dict[str, tuple[str, str]]:
    """coverage.ts as {operationId: ("method", name) | ("notYet", reason constant or text)}"""
    text = (TYPESCRIPT / "src" / "coverage.ts").read_text()
    body = text[text.index("export const COVERAGE") :]
    entries = re.findall(r"^\s+(\w+): \{ (method|notYet): (\"[^\"]*\"|\w+) \},?$", body, re.M)
    assert len(entries) == body.count("{ method:") + body.count("{ notYet:")
    return {op: (kind, value.strip('"')) for op, kind, value in entries}


def test_every_operation_of_the_spec_has_a_method_or_a_reason_it_has_none_yet():
    assert SPEC_OPERATIONS
    assert [op for op in SPEC_OPERATIONS if op not in COVERAGE] == []


def test_no_entry_outlives_its_operation():
    assert [op for op in COVERAGE if op not in SPEC_OPERATIONS] == []


def test_every_named_method_exists_on_both_clients():
    sync = Kyora(token="kyora_test")
    try:
        for root in (AsyncKyora(token="kyora_test"), sync):
            missing = []
            for op, entry in COVERAGE.items():
                if "method" not in entry:
                    assert entry["not_yet"].strip(), f"{op}: a not-yet entry needs a reason"
                    continue
                target = root
                for part in entry["method"].split("."):
                    target = getattr(target, part, None)
                if not callable(target):
                    missing.append(f"{op}: {entry['method']}")
            assert missing == [], type(root).__name__
    finally:
        sync.close()


def test_the_generated_table_holds_exactly_the_specs_operations():
    assert sorted(OPERATIONS) == sorted(SPEC_OPERATIONS)


def test_the_split_matches_the_typescript_sdk():
    typescript = typescript_coverage()
    assert sorted(typescript) == sorted(COVERAGE)
    for op, (kind, value) in typescript.items():
        if kind == "method":
            assert COVERAGE[op].get("method") == snake(value), op
        else:
            assert "not_yet" in COVERAGE[op], op
