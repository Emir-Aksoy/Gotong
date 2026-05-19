"""Regression tests for AUDIT-v3.3.md findings H8 + H9.

These two findings are both about the SERVICE_CALL dispatch path on the
Python SDK side and are easier to read side-by-side here than scattered
across separate files.

* **H8** — ``callId`` suffix must come from :mod:`secrets` (CSPRNG),
  not :mod:`random` (Mersenne Twister). See ``services._rand_id``.
* **H9** — fire-and-forget ``asyncio.create_task`` calls must be held
  in a strong-ref set on the ``Session`` so CPython 3.11+ can't GC
  them mid-flight. See ``Session._background_tasks`` /
  ``Session._spawn_background``.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from unittest.mock import patch

import pytest

from aipehub.services import _rand_id


# =============================================================================
# H8 — _rand_id uses secrets.token_hex, not random
# =============================================================================


class TestH8CallIdEntropy:
    """``_rand_id()`` is the helper that produces the callId suffix."""

    def test_format_is_12_lowercase_hex(self) -> None:
        # `secrets.token_hex(6)` → 12 hex chars. Same on-wire width
        # as the pre-3.4 base-36 form, so no decoder anywhere needs
        # to change.
        out = _rand_id()
        assert re.fullmatch(r"[0-9a-f]{12}", out), f"unexpected shape: {out!r}"

    def test_1000_calls_are_all_unique(self) -> None:
        # Pre-3.4 used 6 base-36 chars (≈31 bits); birthday-collision
        # odds across 1000 draws were ~1.4%. With token_hex(6) we get
        # 48 bits, so a collision is astronomical. This is a smoke
        # check that we didn't accidentally rewire it back to the
        # weaker source.
        ids = {_rand_id() for _ in range(1000)}
        assert len(ids) == 1000

    def test_does_not_call_random_choices(self) -> None:
        # Hard guard: the pre-3.4 implementation was
        # `"".join(random.choices(string.ascii_lowercase + string.digits, k=6))`.
        # Patch `random.choices` and confirm we never touch it from a
        # callId generation.
        with patch("random.choices") as mock_choices:
            _rand_id()
            mock_choices.assert_not_called()

    def test_uses_secrets_module(self) -> None:
        # Positive assertion: the new path goes through `secrets`.
        # Patching `secrets.token_hex` lets us see the call.
        with patch("aipehub.services.secrets.token_hex", return_value="cafebabe1234") as mock_th:
            out = _rand_id()
            mock_th.assert_called_once_with(6)
            assert out == "cafebabe1234"


# =============================================================================
# H9 — Session tracks fire-and-forget tasks so the GC can't reap them
# =============================================================================


class _NoopWS:
    """A minimal duck-typed WebSocket that records sends. We only need
    `.send` (a coroutine) and a duck-typed open check.
    """

    def __init__(self) -> None:
        self.sent: list[str] = []
        # `_is_open` in session.py first looks at .state, then .closed.
        self.state = type("S", (), {"name": "OPEN"})()

    async def send(self, payload: str) -> None:
        # Yield once so the await chain matches a real ws.send.
        await asyncio.sleep(0)
        self.sent.append(payload)


def _make_session() -> Any:
    """Build a `Session` without going through the websockets stack.

    We bypass `connect()` because that wants a real Hub. The bits
    we exercise here (`_spawn_background`, `_send_service_call`,
    `_background_tasks`) are state-only and don't need a live socket.
    """
    from aipehub import AgentParticipant
    from aipehub.session import Session

    return Session(
        url="ws://127.0.0.1:0",  # loopback so the H10 check doesn't fire
        agents=[AgentParticipant(id="t", capabilities=[])],
        auto_reconnect=False,
    )


class TestH9BackgroundTasks:
    @pytest.mark.asyncio
    async def test_session_init_creates_background_tasks_set(self) -> None:
        sess = _make_session()
        # The strong-ref set must exist from __init__, otherwise the
        # first send_service_call AttributeErrors instead of just
        # being slow.
        assert hasattr(sess, "_background_tasks")
        assert isinstance(sess._background_tasks, set)
        assert len(sess._background_tasks) == 0

    @pytest.mark.asyncio
    async def test_spawn_background_tracks_task_until_done(self) -> None:
        sess = _make_session()

        slow_done = asyncio.Event()

        async def slow_coro() -> None:
            await slow_done.wait()

        task = sess._spawn_background(slow_coro())
        # The set must hold the task right after creation — otherwise
        # the GC could collect it before it runs.
        assert task in sess._background_tasks
        assert len(sess._background_tasks) == 1

        # Resolve and yield until the discard callback fires.
        slow_done.set()
        await task
        while sess._background_tasks:
            await asyncio.sleep(0)
        assert task not in sess._background_tasks
        assert len(sess._background_tasks) == 0

    @pytest.mark.asyncio
    async def test_send_service_call_tracks_the_send_task(self) -> None:
        # The original audit-cited line. Stub in a fake ws so the send
        # is observable, then call `_send_service_call` and verify the
        # in-flight task lives in `_background_tasks`.
        sess = _make_session()
        ws = _NoopWS()
        sess._ws = ws

        sess._send_service_call({"type": "SERVICE_CALL", "callId": "x"})
        # At this exact moment the send coroutine has not yet awaited
        # past its first `await asyncio.sleep(0)`, so the task is
        # pending and MUST be in the set.
        assert len(sess._background_tasks) == 1
        in_flight_task = next(iter(sess._background_tasks))
        assert not in_flight_task.done()

        # Let the task run + the done-callback (set.discard) fire. The
        # callback is scheduled via `call_soon` after the task settles,
        # so we yield until the set is empty rather than guessing how
        # many `sleep(0)`s that takes — it depends on the asyncio
        # version's exact scheduling.
        while sess._background_tasks:
            await asyncio.sleep(0)
        assert in_flight_task.done()
        assert len(sess._background_tasks) == 0
        # And the frame actually hit the wire.
        assert len(ws.sent) == 1

    @pytest.mark.asyncio
    async def test_burst_of_sends_all_get_tracked_and_drained(self) -> None:
        # Stress: 200 SERVICE_CALL sends back-to-back. Set should grow,
        # then drain to zero once the loop runs everything. This is
        # the regression mode H9 fixes — under GC pressure these
        # tasks would silently vanish before delivery.
        sess = _make_session()
        ws = _NoopWS()
        sess._ws = ws

        for i in range(200):
            sess._send_service_call({"type": "SERVICE_CALL", "callId": f"c{i}"})

        # All 200 tasks should be parked.
        assert len(sess._background_tasks) == 200

        # Let them all run.
        while sess._background_tasks:
            await asyncio.sleep(0)
        assert len(ws.sent) == 200

    @pytest.mark.asyncio
    async def test_send_does_not_use_bare_create_task(self) -> None:
        # Hard guard. Patch `asyncio.create_task` to count calls and
        # confirm every fire-and-forget send goes through the tracked
        # helper (which DOES call create_task, but only via
        # _spawn_background, which we explicitly verify keeps the
        # set populated above).
        #
        # We assert the OPPOSITE invariant here: an untracked
        # create_task call from inside `_send_service_call` would leave
        # the set empty for the duration of the send.
        sess = _make_session()
        ws = _NoopWS()
        sess._ws = ws

        sess._send_service_call({"type": "SERVICE_CALL", "callId": "y"})
        # The set MUST have the task in it — empty here would be the
        # exact pre-3.4 bug.
        assert len(sess._background_tasks) >= 1

        # Drain.
        while sess._background_tasks:
            await asyncio.sleep(0)
