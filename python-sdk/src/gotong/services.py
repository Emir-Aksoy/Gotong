"""Client-side Hub Services support over WebSocket (protocol v1.2).

Mirrors the TypeScript ``@gotong/sdk-node``'s ``ServiceClient`` surface so
a Python agent can issue ``self.services.memory_for(...)`` calls and get
the same handle semantics an in-process agent would have. Handle methods
serialise into SERVICE_CALL frames and await the matching SERVICE_RESULT.

This module is **client-side only**. The TypeScript host SDK exposes
``register_service_methods`` / ``unregister_service_methods`` (runtime
wire-method allowlist for third-party plugins) — there is no Python
equivalent because Gotong hosts run on Node. A Python sidecar's job is
to call into a Hub, not to host one.

# Why this exists

The promise in `docs/AGENT.md` is that you can move an agent from
in-process to remote "without changing its logic". For Python agents
that's the same promise — drop your agent class into a process, declare
the services you need, and call ``self.services.memory.recall(...)``
identically to an in-process LlmAgent (in TypeScript).

# Wire shape (mirrors TS)

* ``ServiceUseRequest`` — public form callers pass to ``connect()``.
* ``ServiceCallError`` — raised on SERVICE_RESULT.ok == False.
* ``ServiceClient`` — facade with ``memory_for`` / ``artifact_for`` /
  ``datastore_for`` / ``custom_for`` factories.
* Per-type handles (``MemoryHandle``, ``ArtifactHandle``,
  ``DatastoreHandle``) — typed wrappers that build SERVICE_CALL frames
  for the methods listed in ``BUILTIN_SERVICE_METHODS``.

The handles are async — every method is ``await``-able and returns the
plain dict / list / str the host plugin returned. We don't try to
re-create the rich TS types in Python; callers introspect dicts.
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from . import protocol


# --- public types -----------------------------------------------------------


@dataclass(frozen=True)
class ServiceOwner:
    """An owner concrete value. ``id`` may be ``'self'`` or ``'*'`` in a
    *declaration*; in actual SERVICE_CALL frames ``id`` is always concrete
    (the client resolves ``'self'`` before sending).
    """

    kind: str
    id: str


@dataclass(frozen=True)
class ServiceUseRequest:
    """One entry in HELLO.services. Passed to ``connect(services=[...])``.

    Mirror of TS ``ServiceUseRequest``:

      - ``type`` — service category (``'memory'`` / ``'artifact'`` /
        ``'datastore'`` / a third-party string).
      - ``impl`` — implementation discriminator (e.g. ``'file'``).
      - ``owner`` — pattern. Use ``ServiceOwner('agent', 'self')`` for
        the calling agent's id; ``ServiceOwner('workflow-run', '*')`` to
        accept any case id; or a literal id.
      - ``config`` — opaque; admins see it, server forwards it to
        ``plugin.attach``.
      - ``methods`` (v1.2) — optional per-method ACL. When set, restricts
        the connection to a subset of the type's wire-callable methods.
        E.g. ``methods=['recall', 'list']`` to declare a read-only memory
        scope. Names follow ``'method'`` or ``'namespace.method'``.
    """

    type: str
    impl: str
    owner: ServiceOwner
    config: dict[str, Any] | None = None
    methods: list[str] | None = None


class ServiceCallError(RuntimeError):
    """Raised when SERVICE_RESULT.ok is False, or the session closes with
    a pending call. ``code`` matches the wire ``ServiceErrorCode`` enum.
    """

    def __init__(self, code: str, message: str, context: Any | None = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.context_data = context


# --- per-handle wrappers ----------------------------------------------------


_Caller = Callable[[str, list[Any]], Awaitable[Any]]


class MemoryHandle:
    """Async wrapper around a ``memory:<impl>`` handle on the host."""

    def __init__(self, call: _Caller) -> None:
        self._call = call

    async def recall(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        return await self._call("recall", [query])

    async def remember(self, entry: dict[str, Any]) -> dict[str, Any]:
        return await self._call("remember", [entry])

    async def list(self, opts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        args = [] if opts is None else [opts]
        return await self._call("list", args)

    async def forget(self, id: str) -> None:
        await self._call("forget", [id])

    async def clear(self, kind: str | None = None) -> None:
        args = [] if kind is None else [kind]
        await self._call("clear", args)


class ArtifactHandle:
    def __init__(self, call: _Caller) -> None:
        self._call = call

    async def write(self, path: str, content: str | bytes, opts: dict[str, Any] | None = None) -> dict[str, Any]:
        # bytes are not JSON-serialisable; encode as base64 if a caller really
        # needs binary. Most agents pass text, so we keep the API ergonomic.
        if isinstance(content, (bytes, bytearray)):
            import base64
            payload = {"__bin__": base64.b64encode(bytes(content)).decode("ascii")}
            args = [path, payload] if opts is None else [path, payload, opts]
        else:
            args = [path, content] if opts is None else [path, content, opts]
        return await self._call("write", args)

    async def read(self, ref_or_path: str) -> dict[str, Any]:
        return await self._call("read", [ref_or_path])

    async def list(self, opts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        args = [] if opts is None else [opts]
        return await self._call("list", args)

    async def exists(self, ref_or_path: str) -> bool:
        return bool(await self._call("exists", [ref_or_path]))

    async def remove(self, ref_or_path: str) -> None:
        await self._call("remove", [ref_or_path])


class KvHandle:
    def __init__(self, call: _Caller) -> None:
        self._call = call

    async def get(self, key: str) -> Any:
        return await self._call("kv.get", [key])

    async def set(self, key: str, value: Any) -> None:
        await self._call("kv.set", [key, value])

    async def delete(self, key: str) -> None:
        # Avoid shadowing the builtin ``del`` in the public API; the wire
        # method is still ``kv.del``.
        await self._call("kv.del", [key])

    async def keys(self, prefix: str | None = None) -> list[str]:
        args = [] if prefix is None else [prefix]
        return await self._call("kv.keys", args)


class SqlHandle:
    def __init__(self, call: _Caller) -> None:
        self._call = call

    async def exec(self, sql: str, params: list[Any] | None = None) -> dict[str, Any]:
        args = [sql] if params is None else [sql, params]
        return await self._call("sql.exec", args)

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        args = [sql] if params is None else [sql, params]
        return await self._call("sql.query", args)


class DatastoreHandle:
    """Aggregate ``kv`` + ``sql`` namespaces, with the ``name`` field
    resolved eagerly from the matching declaration's ``config.name`` (no
    RPC needed for that).
    """

    def __init__(self, name: str, call: _Caller) -> None:
        self.name = name
        self.kv = KvHandle(call)
        self.sql = SqlHandle(call)


class CustomServiceHandle:
    """Dynamic-dispatch handle for third-party service types. The plugin
    on the host must have called ``registerServiceMethods`` for any name
    you pass here, else SERVICE_CALL returns ``unknown_method``.
    """

    def __init__(self, call: _Caller) -> None:
        self._call = call

    async def call(self, method: str, *args: Any) -> Any:
        return await self._call(method, list(args))


# --- ServiceClient ----------------------------------------------------------


@dataclass
class _PendingCall:
    future: asyncio.Future[Any]
    timer: asyncio.TimerHandle | None = None


class ServiceClient:
    """Facade exposed on ``Session.services``. Routes SERVICE_CALL frames
    out through the session's send callback and awaits SERVICE_RESULT
    frames the session feeds in via :meth:`attach_result`.
    """

    def __init__(
        self,
        *,
        declarations: list[ServiceUseRequest],
        send_call: Callable[[dict[str, Any]], None],
        default_agent_id: Callable[[], str],
        call_timeout_ms: int = protocol.DEFAULT_SERVICE_CALL_TIMEOUT_MS,
    ) -> None:
        self._declarations = declarations
        self._send_call = send_call
        self._default_agent_id = default_agent_id
        self._timeout_ms = call_timeout_ms
        self._pending: dict[str, _PendingCall] = {}
        self._handle_cache: dict[str, Any] = {}
        self._call_counter = 0
        self._closed = False

        # Pre-build the convenience top-level attributes for the **first**
        # matching declaration of each type, mirroring TS:
        self.memory: MemoryHandle | None = None
        self.artifact: ArtifactHandle | None = None
        self.datastore: dict[str, DatastoreHandle] | None = None

        mem = self._find_decl("memory")
        if mem is not None:
            self.memory = self._build_memory("memory", mem.impl, self._resolve_static_owner(mem))
        art = self._find_decl("artifact")
        if art is not None:
            self.artifact = self._build_artifact("artifact", art.impl, self._resolve_static_owner(art))
        ds_entries: dict[str, DatastoreHandle] = {}
        for d in declarations:
            if d.type != "datastore":
                continue
            name = (d.config or {}).get("name") or d.impl
            ds_entries[name] = self._build_datastore(
                "datastore", d.impl, self._resolve_static_owner(d), name
            )
        if ds_entries:
            self.datastore = ds_entries

    # --- public surface -----------------------------------------------------

    def memory_for(self, impl: str, owner: ServiceOwner) -> MemoryHandle:
        return self._cached("memory", impl, owner, lambda: self._build_memory("memory", impl, owner))

    def artifact_for(self, impl: str, owner: ServiceOwner) -> ArtifactHandle:
        return self._cached("artifact", impl, owner, lambda: self._build_artifact("artifact", impl, owner))

    def datastore_for(self, impl: str, owner: ServiceOwner, *, name: str | None = None) -> DatastoreHandle:
        return self._cached(
            "datastore", impl, owner,
            lambda: self._build_datastore("datastore", impl, owner, name or impl),
        )

    def custom_for(self, service_type: str, impl: str, owner: ServiceOwner) -> CustomServiceHandle:
        return self._cached(service_type, impl, owner, lambda: self._build_custom(service_type, impl, owner))

    # --- session integration -----------------------------------------------

    def attach_result(self, frame: dict[str, Any]) -> None:
        call_id = frame.get("callId")
        if not isinstance(call_id, str):
            return
        pending = self._pending.pop(call_id, None)
        if pending is None:
            return
        if pending.timer is not None:
            pending.timer.cancel()
        if frame.get("ok"):
            pending.future.set_result(frame.get("value"))
        else:
            err = frame.get("error") or {}
            pending.future.set_exception(
                ServiceCallError(
                    str(err.get("code", "internal_error")),
                    str(err.get("message", "")),
                    err.get("context"),
                )
            )

    def fail_all_pending(self, reason: str) -> None:
        self._closed = True
        for cid, pending in list(self._pending.items()):
            if not pending.future.done():
                pending.future.set_exception(
                    ServiceCallError("session_not_ready", reason)
                )
            if pending.timer is not None:
                pending.timer.cancel()
        self._pending.clear()

    # --- internals ----------------------------------------------------------

    def _find_decl(self, t: str) -> ServiceUseRequest | None:
        for d in self._declarations:
            if d.type == t:
                return d
        return None

    def _resolve_static_owner(self, decl: ServiceUseRequest) -> ServiceOwner:
        if decl.owner.id == "self":
            return ServiceOwner(decl.owner.kind, self._default_agent_id())
        if decl.owner.id == "*":
            # static-handle access can't address a wildcard concretely; emit
            # a sentinel that will get `forbidden_owner` from the server,
            # mirroring the TS behaviour.
            return ServiceOwner(decl.owner.kind, "__wildcard_misuse__")
        return ServiceOwner(decl.owner.kind, decl.owner.id)

    def _cached(self, t: str, impl: str, owner: ServiceOwner, build: Callable[[], Any]) -> Any:
        key = f"{t}:{impl}:{owner.kind}/{owner.id}"
        existing = self._handle_cache.get(key)
        if existing is not None:
            return existing
        fresh = build()
        self._handle_cache[key] = fresh
        return fresh

    def _build_memory(self, t: str, impl: str, owner: ServiceOwner) -> MemoryHandle:
        return MemoryHandle(self._caller_for(t, impl, owner))

    def _build_artifact(self, t: str, impl: str, owner: ServiceOwner) -> ArtifactHandle:
        return ArtifactHandle(self._caller_for(t, impl, owner))

    def _build_datastore(self, t: str, impl: str, owner: ServiceOwner, name: str) -> DatastoreHandle:
        return DatastoreHandle(name, self._caller_for(t, impl, owner))

    def _build_custom(self, t: str, impl: str, owner: ServiceOwner) -> CustomServiceHandle:
        return CustomServiceHandle(self._caller_for(t, impl, owner))

    def _caller_for(self, t: str, impl: str, owner: ServiceOwner) -> _Caller:
        async def call(method: str, args: list[Any]) -> Any:
            return await self._send_one(t, impl, owner, method, args)
        return call

    async def _send_one(
        self,
        service_type: str,
        impl: str,
        owner: ServiceOwner,
        method: str,
        args: list[Any],
    ) -> Any:
        if self._closed:
            raise ServiceCallError("session_not_ready", "service client closed")
        self._call_counter += 1
        call_id = f"c{self._call_counter:x}_{_rand_id()}"
        frame = protocol.service_call(
            call_id=call_id,
            from_agent=self._default_agent_id(),
            service_type=service_type,
            impl=impl,
            owner={"kind": owner.kind, "id": owner.id},
            method=method,
            args=args,
        )
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()

        def _timeout() -> None:
            entry = self._pending.pop(call_id, None)
            if entry is None or entry.future.done():
                return
            entry.future.set_exception(
                ServiceCallError(
                    "session_not_ready",
                    f"service call '{method}' timed out after {self._timeout_ms}ms",
                )
            )

        timer = loop.call_later(self._timeout_ms / 1000, _timeout)
        self._pending[call_id] = _PendingCall(future=fut, timer=timer)
        try:
            self._send_call(frame)
        except Exception as err:  # noqa: BLE001
            self._pending.pop(call_id, None)
            timer.cancel()
            raise ServiceCallError(
                "session_not_ready", f"failed to send SERVICE_CALL: {err}"
            ) from err
        return await fut


# --- helpers ----------------------------------------------------------------


def _rand_id() -> str:
    """Return a 12-char hex token for use as a SERVICE_CALL ``callId`` suffix.

    H8 — uses :mod:`secrets` (a CSPRNG) rather than :mod:`random` (a
    Mersenne Twister with a process-level seed). Today the pending-call
    table matches on ``callId`` locally, so the worst a collision could
    cause is a stale frame resolving the wrong handler within a single
    session. But two issues bite once SERVICE_RESULT is multiplexed
    across sessions (next protocol bump):

      * collisions become a routing security boundary;
      * after ``os.fork()`` the Mersenne Twister carries the parent's
        seed into every child, so identical callIds pop out in lockstep
        until the child happens to reseed.

    ``secrets.token_hex(6)`` gives 48 bits of high-quality entropy and
    stays the same 12 characters wide as the pre-3.4 form. See
    AUDIT-v3.3.md finding H8.
    """
    return secrets.token_hex(6)


def to_wire_decls(reqs: list[ServiceUseRequest]) -> list[dict[str, Any]]:
    """Convert SDK-public ``ServiceUseRequest`` to wire ``ServiceUseDecl`` dicts."""
    out: list[dict[str, Any]] = []
    for r in reqs:
        d: dict[str, Any] = {
            "type": r.type,
            "impl": r.impl,
            "owner": {"kind": r.owner.kind, "id": r.owner.id},
        }
        if r.config is not None:
            d["config"] = r.config
        if r.methods:
            d["methods"] = list(r.methods)
        out.append(d)
    return out
