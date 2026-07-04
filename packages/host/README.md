# @gotong/host

Production-ready binary for [Gotong](https://github.com/Emir-Aksoy/Gotong). Boots a Hub + WebSocket transport + Web UI in one process, configured entirely from environment variables. No demo agents, no test traffic, no scaffolding state.

## Quick start

```bash
# From source (the only supported path right now — npm publish is descoped,
# see .github/RELEASE-CHECKLIST.md "Distribution decision")
git clone https://github.com/Emir-Aksoy/Gotong.git && cd Gotong
pnpm install && pnpm build
pnpm host

# Or cross-platform via Docker (no Node setup)
docker compose up
```

On first launch:

1. Creates `./.gotong/` in the current directory (your **workspace**).
2. Mints a one-time admin token.
3. Prints **one URL** containing the token — save it now, it isn't shown again.

Visit the URL once; an HttpOnly cookie sticks for subsequent restarts.

```
=== Gotong host ready ===
Space     : .gotong
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
gotong-host             # boot the host
gotong-host --help      # full env-var reference + examples
gotong-host --version   # package version
```

Runtime config is **env-only by design** — same binary promoted across dev / staging / prod by changing the environment. No CLI flags beyond help / version.

## Environment variables

See `gotong-host --help` for the authoritative reference. Most commonly:

| Variable | Default | Purpose |
|---|---|---|
| `GOTONG_SPACE` | `.gotong` | Workspace directory |
| `GOTONG_HOST` | `127.0.0.1` | Bind address (loopback when behind a proxy) |
| `GOTONG_WEB_PORT` | `3000` | HTTP port |
| `GOTONG_WS_PORT` | `4000` | WebSocket port |
| `GOTONG_GATING` | `admin-approval` | `open` skips admission gating (dev only!) |
| `GOTONG_COOKIE_SECURE` | `0` | Set to `1` when fronted by HTTPS |
| `GOTONG_ALLOWED_HOSTS` | (unset) | Comma list — CSRF defence; set in production |
| `ANTHROPIC_API_KEY` | (unset) | Fallback for managed LLM agents that don't carry their own key |
| `OPENAI_API_KEY` | (unset) | Same, for OpenAI |
| `GOTONG_SECRET_KEY` | (unset) | Optional master key for `secrets.enc.json` (64 hex chars). Falls back to `<space>/runtime/secret.key` |

## Docker

The repo root ships a `Dockerfile` and a `docker-compose.yml`:

```bash
# One command, ports 3000 + 4000 exposed, data persisted in ./data
docker compose up
```

See [the Docker section of DEPLOY.md](https://github.com/Emir-Aksoy/Gotong/blob/main/docs/DEPLOY.md) for production patterns (TLS via Caddy, systemd, backups).

## What's inside

`packages/host` is a **thin wrapper** that wires together pieces from the rest of the workspace:

```
@gotong/host
  ├── @gotong/core              Hub, Space, registry, scheduler, transcript
  ├── @gotong/transport-ws      WebSocket port for remote agents
  ├── @gotong/web               HTTP + SSE + admin/worker SPA
  ├── @gotong/llm               LlmAgent base + LlmProvider interface
  ├── @gotong/llm-anthropic     Anthropic provider
  ├── @gotong/llm-openai        OpenAI provider
  │
  └── LocalAgentPool             host-side: walks agents.json, spawns LLM
                                 agents in-process, decrypts API keys
                                 from secrets.enc.json
```

Embed mode — use `@gotong/core` + `@gotong/web` directly if you want to compose a custom binary. `packages/host` is the **reference assembly**, not the only path.

## License

MIT — see [LICENSE](../../LICENSE).
