"""P5: pyproject.version, __init__.__version__, and the
HELLO.client.version emitted by `aipehub.protocol.hello` must all
match. Pre-3.1 each lived as a hand-baked literal and they drifted
between releases.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import aipehub
from aipehub.protocol import hello


def _pyproject_version() -> str:
    root = Path(__file__).resolve().parent.parent
    with (root / "pyproject.toml").open("rb") as f:
        data = tomllib.load(f)
    return str(data["project"]["version"])


def test_pyproject_and_dunder_match() -> None:
    assert _pyproject_version() == aipehub.__version__


def test_hello_default_client_version_matches_dunder() -> None:
    # No explicit client_version → builder picks up `aipehub.__version__`.
    frame = hello(agents=[{"id": "a", "capabilities": []}])
    assert frame["client"]["version"] == aipehub.__version__


def test_hello_explicit_client_version_overrides() -> None:
    # An explicit pin still wins (e.g. test scenarios that want to
    # spoof an older client).
    frame = hello(
        agents=[{"id": "a", "capabilities": []}],
        client_version="0.0.0-test",
    )
    assert frame["client"]["version"] == "0.0.0-test"
