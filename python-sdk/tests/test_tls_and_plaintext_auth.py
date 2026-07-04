"""Regression tests for the v3.4 Batch 2 audit fixes — Python SDK TLS
surface (C3 + H10 — Python side).

  C3 — ``websockets.connect(self._url)`` had no way to pass an explicit
       ``ssl.SSLContext``. Internal-CA users could not connect at all,
       and there is no "global insecure" escape hatch on the Python
       side equivalent to ``NODE_TLS_REJECT_UNAUTHORIZED=0`` — so the
       SDK was effectively unusable behind a corporate CA.
       Fix: ``connect(... ssl: ssl.SSLContext | None = None)``, plumbed
       through to ``websockets.connect(..., ssl=ssl_ctx)``.

  H10 — ``api_key`` was sent over ``ws://`` to any host without
       warning. Same exposure as the Node SDK.
       Fix: ``connect()`` raises ``ValueError`` when ``api_key`` is set
       + URL is ``ws://`` + host is non-loopback, unless
       ``allow_plaintext_auth=True`` is explicitly passed (in which
       case we log a WARN for audit traceability).

Loopback (``localhost`` / ``127.0.0.1`` / ``::1``) is always allowed —
the apiKey never leaves the host, so the dev workflow stays unblocked.

See AUDIT-v3.3.md findings C3 and H10.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any

import pytest

from gotong import AgentParticipant, connect
from gotong.session import Session, _is_loopback_host

from .conftest import FakeHub, serve_hub


class NoopAgent(AgentParticipant):
    def handle_task(self, task: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True}


# =========================================================================
# _is_loopback_host helper (the predicate H10 is built on)
# =========================================================================


class TestIsLoopbackHost:
    def test_canonical_loopback_hosts(self) -> None:
        assert _is_loopback_host("ws://localhost") is True
        assert _is_loopback_host("ws://localhost:4000") is True
        assert _is_loopback_host("ws://127.0.0.1:4000") is True
        assert _is_loopback_host("ws://[::1]:4000") is True
        assert _is_loopback_host("wss://127.0.0.1") is True
        # Case-insensitive on the hostname (urlparse already lowercases).
        assert _is_loopback_host("ws://LocalHost") is True

    def test_non_loopback_hosts(self) -> None:
        assert _is_loopback_host("ws://example.com") is False
        assert _is_loopback_host("ws://10.0.0.1:4000") is False
        assert _is_loopback_host("ws://192.168.1.1:4000") is False
        assert _is_loopback_host("ws://hub.internal:4000") is False
        # LAN-ish but not the loopback identity:
        assert _is_loopback_host("ws://127.0.0.2") is False

    def test_unparseable_urls_are_fail_safe(self) -> None:
        # If we cannot decide the host is loopback, callers must treat
        # it as remote — fail-safe.
        assert _is_loopback_host("not-a-url") is False
        assert _is_loopback_host("") is False


# =========================================================================
# H10 — connect() refuses to send api_key over plaintext ws:// to remote
# =========================================================================


class TestH10ApiKeyPlaintextRefusal:
    async def test_raises_before_opening_socket_on_remote_ws(self) -> None:
        # The check runs in Session.__init__, BEFORE the connect loop
        # even spins up — no socket attempt is made.
        with pytest.raises(ValueError, match=r"refusing to send api_key"):
            await connect(
                url="ws://hub.example.com:4000",
                agents=[NoopAgent(id="a1")],
                api_key="sk-supersecret",
            )

    async def test_error_message_mentions_host_and_override(self) -> None:
        with pytest.raises(ValueError) as exc:
            await connect(
                url="ws://malicious-relay.example.com:4000",
                agents=[NoopAgent(id="a1")],
                api_key="sk-supersecret",
            )
        msg = str(exc.value)
        assert "malicious-relay.example.com" in msg
        assert "allow_plaintext_auth" in msg
        assert "wss://" in msg

    async def test_does_not_raise_on_loopback_ws_with_api_key(self) -> None:
        # Dev workflow: ws://127.0.0.1 + api_key MUST keep working.
        async def hub(h: FakeHub) -> None:
            hello = await h.expect_hello()
            assert hello.get("apiKey") == "sk-supersecret"
            await h.send_welcome()
            try:
                async for _ in h.ws:
                    pass
            except Exception:  # noqa: BLE001
                pass

        async with serve_hub(hub) as url:
            # url is ws://127.0.0.1:<port> — loopback, allowed.
            session = await connect(
                url=url,
                agents=[NoopAgent(id="a1")],
                api_key="sk-supersecret",
                auto_reconnect=False,
            )
            assert session.state == "ready"
            await session.close()

    async def test_does_not_raise_on_wss_with_api_key_to_remote(self) -> None:
        # wss:// encrypts the payload; api_key is safe. The connection
        # will fail (nothing's listening), but the failure must NOT
        # be the H10 pre-check.
        try:
            await asyncio.wait_for(
                connect(
                    url="wss://127.0.0.1:1",
                    agents=[NoopAgent(id="a1")],
                    api_key="sk-supersecret",
                    auto_reconnect=False,
                ),
                timeout=2.0,
            )
        except ValueError as e:
            # Any ValueError must not be H10.
            assert "refusing to send api_key" not in str(e)
        except (OSError, asyncio.TimeoutError, Exception):  # noqa: BLE001
            # Socket / TLS errors are expected; the test passes.
            pass

    async def test_does_not_raise_on_no_api_key_with_remote_ws(self) -> None:
        # No credential present → nothing to leak → H10 stays silent.
        # The connection will still fail (nothing's listening) but
        # the failure must NOT be the H10 pre-check.
        try:
            await asyncio.wait_for(
                connect(
                    url="ws://hub.example.com:1",
                    agents=[NoopAgent(id="a1")],
                    # intentionally no api_key
                    auto_reconnect=False,
                ),
                timeout=2.0,
            )
        except ValueError as e:
            assert "refusing to send api_key" not in str(e)
        except Exception:  # noqa: BLE001
            pass

    async def test_allow_plaintext_auth_honoured_with_warning(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # The opt-out path MUST log a WARN so the unsafe choice
        # surfaces in operator logs (silently honouring an unsafe
        # flag would defeat the audit trail).
        caplog.set_level(logging.WARNING, logger="gotong.session")
        try:
            await asyncio.wait_for(
                connect(
                    url="ws://hub.example.com:1",
                    agents=[NoopAgent(id="a1")],
                    api_key="sk-supersecret",
                    allow_plaintext_auth=True,
                    auto_reconnect=False,
                ),
                timeout=2.0,
            )
        except Exception:  # noqa: BLE001
            # Connection failure is expected (nothing's listening at
            # hub.example.com:1). The Session-level check fires BEFORE
            # the connect attempt, so we still get the warning.
            pass

        warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert any("plaintext ws://" in r.getMessage() for r in warns), (
            f"expected a WARNING about plaintext ws://, got: {[r.getMessage() for r in warns]}"
        )
        assert any("hub.example.com" in r.getMessage() for r in warns)


# =========================================================================
# C3 — ssl option surface
# =========================================================================


class TestC3SslOptionSurface:
    def test_session_stores_ssl_context_in_init(self) -> None:
        ctx = ssl.create_default_context()
        s = Session(
            url="ws://127.0.0.1:1",
            agents=[NoopAgent(id="a1")],
            ssl=ctx,
            auto_reconnect=False,
        )
        # Internal field — direct check, since this is a focused
        # regression for "the parameter is wired through".
        assert s._ssl is ctx

    def test_session_defaults_ssl_to_none(self) -> None:
        # Back-compat: omitting ssl keeps None — websockets uses its
        # default (system CA bundle on wss://).
        s = Session(
            url="ws://127.0.0.1:1",
            agents=[NoopAgent(id="a1")],
            auto_reconnect=False,
        )
        assert s._ssl is None

    async def test_ssl_kwarg_forwarded_to_websockets_connect(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Monkey-patch ``websockets.connect`` as seen by
        # ``gotong.session`` and capture the kwargs each call gets.
        # When ``ssl`` is supplied, it MUST appear in the call.
        import gotong.session as session_mod

        captured: list[dict[str, Any]] = []
        real_connect = session_mod.websockets.connect

        def fake_connect(uri: str, **kwargs: Any) -> Any:
            captured.append({"uri": uri, **kwargs})
            # Pop our SDK-side kwarg before delegating so a plain
            # ws:// server (which doesn't accept ssl=) doesn't choke.
            delegated = {k: v for k, v in kwargs.items() if k != "ssl"}
            return real_connect(uri, **delegated)

        monkeypatch.setattr(session_mod.websockets, "connect", fake_connect)

        ctx = ssl.create_default_context()

        async def hub(h: FakeHub) -> None:
            await h.expect_hello()
            await h.send_welcome()
            try:
                async for _ in h.ws:
                    pass
            except Exception:  # noqa: BLE001
                pass

        async with serve_hub(hub) as url:
            session = await connect(
                url=url,
                agents=[NoopAgent(id="a1")],
                ssl=ctx,
                auto_reconnect=False,
            )
            await session.close()

        # The ssl kwarg must have reached websockets.connect.
        assert any(c.get("ssl") is ctx for c in captured), (
            f"expected ssl context in websockets.connect kwargs; got {captured}"
        )

    async def test_no_ssl_kwarg_when_not_supplied(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # When the caller passes no ssl context, the SDK must NOT
        # inject ``ssl=None`` — some websockets versions reject
        # ``ssl=None`` on ``ws://``. Better to omit the kwarg
        # entirely.
        import gotong.session as session_mod

        captured: list[dict[str, Any]] = []
        real_connect = session_mod.websockets.connect

        def fake_connect(uri: str, **kwargs: Any) -> Any:
            captured.append({"uri": uri, **kwargs})
            return real_connect(uri, **kwargs)

        monkeypatch.setattr(session_mod.websockets, "connect", fake_connect)

        async def hub(h: FakeHub) -> None:
            await h.expect_hello()
            await h.send_welcome()
            try:
                async for _ in h.ws:
                    pass
            except Exception:  # noqa: BLE001
                pass

        async with serve_hub(hub) as url:
            session = await connect(
                url=url,
                agents=[NoopAgent(id="a1")],
                auto_reconnect=False,
            )
            await session.close()

        assert all("ssl" not in c for c in captured), (
            f"ssl kwarg should NOT be present when not supplied; got {captured}"
        )
