# @aipehub/host

Production-ready binary for [AipeHub](https://github.com/AipeHub/AipeHub). Boots a Hub + WebSocket transport + Web UI in one process, configured entirely from environment variables. No demo agents, no test traffic, no scaffolding state.

## Quick start

```bash
# One-liner (no install)
npx @aipehub/host

# Or install + run
npm i -g @aipehub/host
aipehub-host
```

On first launch:

1. Creates `./.aipehub/` in the current directory (your **workspace**).
2. Mints a one-time admin token.
3. Prints **one URL** containing the token — save it now, it isn't shown again.

Visit the URL once; an HttpOnly cookie sticks for subsequent restarts.

```
=== AipeHub host ready ===
Space     : .aipehub
Web       : http://127.0.0.1:3000
WebSocket : ws://127.0.0.1:4000
Gating    : admin-approval
CookieSec : off (HTTP / dev)
HostCheck : disabled (loopback only is safe)

First-run admin URL (shown ONCE — save it):
  http://127.0.0.1:3000/admin?token=<HEX>
```

## CLI

```bash
aipehub-host             # boot the host
aipehub-host --help      # full env-var reference + examples
aipehub-host --version   # package version
```

Runtime config is **env-only by design** — same binary promoted across dev / staging / prod by changing the environment. No CLI flags beyond help / version.

## Environment variables

See `aipehub-host --help` for the authoritative reference. Most commonly:

| Variable | Default | Purpose |
|---|---|---|
| `AIPE_SPACE` | `.aipehub` | Workspace directory |
| `AIPE_HOST` | `127.0.0.1` | Bind address (loopback when behind a proxy) |
| `AIPE_WEB_PORT` | `3000` | HTTP port |
| `AIPE_WS_PORT` | `4000` | WebSocket port |
| `AIPE_GATING` | `admin-approval` | `open` skips admission gating (dev only!) |
| `AIPE_COOKIE_SECURE` | `0` | Set to `1` when fronted by HTTPS |
| `AIPE_ALLOWED_HOSTS` | (unset) | Comma list — CSRF defence; set in production |
| `ANTHROPIC_API_KEY` | (unset) | Fallback for managed LLM agents that don't carry their own key |
| `OPENAI_API_KEY` | (unset) | Same, for OpenAI |
| `AIPE_SECRET_KEY` | (unset) | Optional master key for `secrets.enc.json` (64 hex chars). Falls back to `<space>/runtime/secret.key` |

## Docker

The repo root ships a `Dockerfile` and a `docker-compose.yml`:

```bash
# One command, ports 3000 + 4000 exposed, data persisted in ./data
docker compose up
```

See [the Docker section of DEPLOY.md](https://github.com/AipeHub/AipeHub/blob/main/docs/DEPLOY.md) for production patterns (TLS via Caddy, systemd, backups).

## What's inside

`packages/host` is a **thin wrapper** that wires together pieces from the rest of the workspace:

```
@aipehub/host
  ├── @aipehub/core              Hub, Space, registry, scheduler, transcript
  ├── @aipehub/transport-ws      WebSocket port for remote agents
  ├── @aipehub/web               HTTP + SSE + admin/worker SPA
  ├── @aipehub/llm               LlmAgent base + LlmProvider interface
  ├── @aipehub/llm-anthropic     Anthropic provider
  ├── @aipehub/llm-openai        OpenAI provider
  │
  └── LocalAgentPool             host-side: walks agents.json, spawns LLM
                                 agents in-process, decrypts API keys
                                 from secrets.enc.json
```

Embed mode — use `@aipehub/core` + `@aipehub/web` directly if you want to compose a custom binary. `packages/host` is the **reference assembly**, not the only path.

## License

MIT — see [LICENSE](../../LICENSE).
