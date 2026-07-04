"""H11 regression — REJECT.message scrubbed before landing in
:class:`ConnectionRejected`.

Mirrors `packages/sdk-node/tests/h11-reject-redaction.test.ts`. The
threat model is identical: a misconfigured Hub or upstream proxy puts
the client's own credentials back into the REJECT message body,
:class:`ConnectionRejected` carries the message into the user's
exception path, and from there it's typically logged. The redactor
scrubs `sk-...`, `Bearer ...`, and `gotong-...` token shapes before
the message is stored.

See AUDIT-v3.3.md finding H11.
"""

from __future__ import annotations

import pytest

from gotong.session import ConnectionRejected, _redact_secrets


class TestRedactSecrets:
    """The pure-string redactor."""

    def test_redacts_sk_api_key(self) -> None:
        out = _redact_secrets("apiKey 'sk-abc123XYZ_def-456' not recognised")
        assert "sk-abc123" not in out
        assert "<redacted>" in out

    def test_redacts_anthropic_style_long_key(self) -> None:
        out = _redact_secrets(
            "bad key: sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-something",
        )
        assert "sk-ant" not in out
        assert "<redacted>" in out

    def test_preserves_diagnostic_context(self) -> None:
        out = _redact_secrets(
            "auth_failed: apiKey 'sk-real-secret-12345' did not match any verifier",
        )
        assert "auth_failed" in out
        assert "did not match any verifier" in out

    def test_redacts_bearer_header(self) -> None:
        out = _redact_secrets(
            "upstream said 502: Authorization: Bearer gotong-tok-abc-xyz-def",
        )
        assert "gotong-tok-abc-xyz-def" not in out
        assert "<redacted>" in out

    def test_bearer_is_case_insensitive(self) -> None:
        out = _redact_secrets("bearer my-token-here")
        assert "my-token-here" not in out

    def test_redacts_gotong_admin_token(self) -> None:
        out = _redact_secrets("rejected: token gotong-admin-deadbeef invalid")
        assert "gotong-admin" not in out
        assert "<redacted>" in out

    def test_no_false_positive_on_prose(self) -> None:
        input_str = "auth_failed: apiKey 'redacted-on-our-side' not recognised"
        assert _redact_secrets(input_str) == input_str

    def test_no_false_positive_on_session_id(self) -> None:
        input_str = "session s_a1b2c3 from 192.168.1.1 rejected"
        assert _redact_secrets(input_str) == input_str

    def test_idempotent(self) -> None:
        once = _redact_secrets("bad apiKey 'sk-abc123' for you")
        twice = _redact_secrets(once)
        assert once == twice

    def test_non_string_passes_through_unchanged(self) -> None:
        # Defence in depth — the function is typed `str -> str` but
        # runtime guards still need to hold.
        assert _redact_secrets(None) is None  # type: ignore[arg-type]
        assert _redact_secrets(42) == 42  # type: ignore[arg-type]


class TestConnectionRejectedRedaction:
    """The integration point: any ConnectionRejected built from a
    server REJECT.message must hold the scrubbed text, both in the
    string representation AND in `.message` (which user code reads
    when surfacing the error)."""

    def test_str_representation_is_redacted(self) -> None:
        err = ConnectionRejected("auth_failed", "apiKey 'sk-leak123abc' bad")
        s = str(err)
        assert "sk-leak123abc" not in s
        assert "<redacted>" in s

    def test_message_attribute_is_redacted(self) -> None:
        # User code reads `.message` to surface the rejection into
        # higher-level error reporting — that path MUST see redacted
        # text too.
        err = ConnectionRejected("auth_failed", "Bearer gotong-tok-secret-xyz failed")
        assert "gotong-tok-secret-xyz" not in err.message
        assert "<redacted>" in err.message

    def test_code_field_is_NOT_redacted(self) -> None:
        # `code` is a constrained enum from the wire protocol; even if
        # an attacker controls REJECT.code (they don't — server picks
        # it), it can't carry secrets because the type doesn't allow
        # them. Verify we preserve it verbatim so callers can branch.
        err = ConnectionRejected("auth_failed", "bad")
        assert err.code == "auth_failed"

    def test_clean_messages_pass_through_unchanged(self) -> None:
        err = ConnectionRejected("duplicate_id", "agent 'alice' already registered")
        assert err.message == "agent 'alice' already registered"

    @pytest.mark.parametrize(
        "raw_message,must_not_contain",
        [
            ("apiKey 'sk-tok123abc' invalid", "sk-tok123abc"),
            ("Authorization: Bearer gotong-x-y-z bad", "gotong-x-y-z"),
            ("first sk-aaa then sk-bbb", "sk-aaa"),
        ],
    )
    def test_parametrised_redaction(self, raw_message: str, must_not_contain: str) -> None:
        err = ConnectionRejected("auth_failed", raw_message)
        assert must_not_contain not in str(err)
        assert must_not_contain not in err.message
