# Deploying Gotong

This guide is for running Gotong somewhere other than your laptop —
LAN, a single VPS, or a small fleet. The intended scale is **dozens of
users, single-node**, not a global SaaS. If you outgrow that, the file-
first storage is the first thing you'll want to replace.

There are three deployment shapes. Pick the smallest that fits your need
— each later shape is a strict superset.

| Shape | When | Effort | TLS | Off-machine clients |
|---|---|---|---|---|
| **A. Local** | Solo dev / single user | seconds — `pnpm host` | no | localhost only |
| **B. LAN** | Trusted office / WiFi | minutes — change `host` | no | LAN-only |
| **C. Public** | Small体验版 over the internet | ~1 h — Caddy + systemd | yes | anywhere |

The same `@gotong/host` binary is used for all three. Only environment
variables change.

> **Going beyond first-run?** Once your host is up, the day-2 playbook
> — backups, disaster recovery drill, secret-key handling, monitoring
> — lives in [`docs/OPERATIONS.md`](OPERATIONS.md). The performance
> baseline (sizing guidance + headroom) is in
> [`docs/PERFORMANCE.md`](PERFORMANCE.md).

---

## 0. The production binary

Built from `packages/host`. Runs the Hub, WebSocket transport, and Web
UI together. **No demo agent is registered.** Configuration is read
exclusively from environment variables, so you can promote the same
build across environments by changing only the env.

```bash
# from the repo root:
pnpm install
pnpm build                  # produces packages/*/dist
pnpm host                   # runs packages/host with defaults

# or, after publishing:
pnpm install -g @gotong/host
gotong-host
```

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `GOTONG_SPACE` | `.gotong` | Workspace directory (created on first run) |
| `GOTONG_HOST` | `127.0.0.1` | Bind address (loopback is correct behind a reverse proxy) |
| `GOTONG_WEB_PORT` | `3000` | HTTP port for browser + admin API |
| `GOTONG_WS_PORT` | `4000` | WebSocket port for remote agents |
| `GOTONG_GATING` | `admin-approval` | `open` skips admission gating (do **not** use on the public internet) |
| `GOTONG_COOKIE_SECURE` | `0` | `1` to add `Secure`+`SameSite=Strict`. Required when fronted by HTTPS |
| `GOTONG_ALLOWED_HOSTS` | (unset) | Comma list. Reject POST/DELETE if `Host:` or `Origin:` is off-list. Set this in production. |
| `GOTONG_ADMIN_RATE_MAX` | `10` | Admin-token attempts per IP per window (0 disables) |
| `GOTONG_ADMIN_RATE_SEC` | `60` | Window for the rate limit in seconds |
| `GOTONG_DEFAULT_LANG` | `zh` | `zh` or `en` |
| `GOTONG_HEARTBEAT_MS` | `30000` | Transport heartbeat interval |
| `GOTONG_SPACE_NAME` | `Gotong` | Label written into `space.json` on first init |
| `GOTONG_ADMIN_DISPLAY_NAME` | `Operator` | First admin's display name (on first init only) |

On first boot the binary mints one admin token and writes the URL to
`<GOTONG_SPACE>/runtime/admin-link.txt` (mode `0600`). It is **never
printed** — stdout from a daemon ends up in `journalctl` / `docker
logs`, and the token is secret-grade. The boot banner only tells you
the path. Read the file once, then delete it. Subsequent boots mint
nothing new — the admin's token already lives (hashed) in
`admins.json`.

---

## 0.5 Single-file binary (no Node required)

`gotong-host` is also distributed as a self-contained executable built
with `bun build --compile`. Use this when you want to spin up a hub on
a fresh box without installing Node.js, pnpm, or the workspace.

```bash
# Linux x64 — substitute -darwin-arm64 / -darwin-x64 / -windows-x64.exe
# / -linux-arm64 for the matching platform.
curl -L -o gotong-host \
  https://github.com/Emir-Aksoy/Gotong/releases/latest/download/gotong-host-linux-x64
chmod +x gotong-host
./gotong-host
```

The binary reads the same `GOTONG_*` environment variables as the npm
build, so every recipe later in this document (A / B / C) works
unmodified — just substitute `./gotong-host` for `pnpm host` or
`gotong-host` (npm-installed).

What's **inside** the binary:
- The entire `@gotong/host` workspace — Hub, WebSocket transport,
  Web UI (HTML/CSS/JS assets are embedded at build time, not read off
  disk), and the LLM adapters.
- The two first-party plugins that don't need native code:
  `@gotong/service-memory-file` and `@gotong/service-artifact-file`.

What's **not** included:
- `@gotong/service-datastore-sqlite` — depends on `better-sqlite3`,
  which ships native `.node` bindings the bundler can't embed. The
  binary detects its own runtime and writes a default `plugins.json`
  *without* sqlite, so first-run is warning-free. If you need
  SQL-backed datastore plugins, use the npm or docker install path.
- Third-party plugins installed into your space — the binary cannot
  resolve packages outside its embedded module graph. Plugin
  development belongs to the npm path.

Binary size is roughly 60 MB across all platforms. Startup is ~5x faster
than `tsx src/main.ts` because there's no module loader walk.

---

## A. Local (default)

```bash
pnpm host
# Web       : http://127.0.0.1:3000
# WebSocket : ws://127.0.0.1:4000
# → the banner points you at the setup wizard (no token needed on loopback)
```

Locally the friendly path in is the **setup wizard** at the web root —
the banner prints that URL and, unless `GOTONG_OPEN_BROWSER=0`, opens
your browser for you. The token-bearing `/admin` URL is the backup path
and lives in `./.gotong/runtime/admin-link.txt` (mode `0600`). Stop with
`Ctrl-C`. Your space lives in `./.gotong/`.

This is functionally identical to `pnpm demo:open-space`, just without
the demo agent — useful when you want to start with a clean room and
plug in your own agents.

---

## B. LAN — share the room with people on the same network

Stay on HTTP, but bind to all interfaces and open the firewall.

```bash
GOTONG_HOST=0.0.0.0 \
GOTONG_WEB_PORT=3000 \
GOTONG_WS_PORT=4000 \
GOTONG_ALLOWED_HOSTS=192.168.1.42:3000 \
pnpm host
```

> Why `GOTONG_ALLOWED_HOSTS` even on a LAN? Defence in depth: a colleague
> who visits `evil.com` while signed in to your hub cannot forge admin
> POSTs because your hub will reject the foreign `Origin:`.

macOS first run will pop up "node wants to receive incoming connections"
— click Allow. Other devices on the same WiFi reach:

```
http://192.168.1.42:3000/         ← worker entry
http://192.168.1.42:3000/admin    ← admin (token first time)
ws://192.168.1.42:4000            ← remote agents
```

> ⚠️ HTTP. No encryption. Session cookies, dispatched task payloads,
> and admin tokens all travel in clear text. Fine for a trusted LAN,
> **never** for anything that traverses the public internet.

---

## C. Public — Caddy + systemd on a VPS

The pattern: Gotong still binds `127.0.0.1` so nothing can reach it
except through Caddy, which terminates TLS on `:443` and proxies inward.
Everything that follows assumes Debian/Ubuntu; adjust paths for other
distros.

### C.1 Prerequisites

- Linux VPS (1 vCPU / 1 GB RAM handles dozens of users comfortably)
- A domain you control with DNS pointed at the VPS. Example:
  `hub.example.com` and `hub-ws.example.com`.
- Node 20 LTS + pnpm 9
- Caddy 2 (`apt install caddy`)
- A non-root system user (`gotong`) that owns `/srv/gotong-data`

### C.2 Lay out the filesystem

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin gotong
sudo mkdir -p /srv/gotong-data
sudo chown gotong:gotong /srv/gotong-data
sudo mkdir -p /opt/gotong && sudo chown gotong:gotong /opt/gotong

# as the gotong user
sudo -u gotong -H git clone https://github.com/Emir-Aksoy/Gotong.git /opt/gotong
sudo -u gotong -H bash -lc 'cd /opt/gotong && pnpm install && pnpm build'
```

### C.3 Environment file

`/etc/gotong.env` (chmod 640, owned by `gotong:gotong`):

```bash
GOTONG_SPACE=/srv/gotong-data
GOTONG_HOST=127.0.0.1
GOTONG_WEB_PORT=3000
GOTONG_WS_PORT=4000
GOTONG_GATING=admin-approval
GOTONG_COOKIE_SECURE=1
GOTONG_ALLOWED_HOSTS=hub.example.com,hub-ws.example.com
GOTONG_ADMIN_RATE_MAX=10
GOTONG_ADMIN_RATE_SEC=60
GOTONG_SPACE_NAME=Hub Beta
GOTONG_ADMIN_DISPLAY_NAME=Operator
```

> ⚠️ List **every** hostname that will reach the box — Caddy uses Host
> rewriting, so the upstream sees the original Host header. Both the web
> domain and the WS domain (if different) must be listed. Caddy
> reformats the Host header to what the client sent (`hub.example.com`),
> not `127.0.0.1`, so the allow-list compares against the user-facing
> name.

### C.4 systemd unit

`/etc/systemd/system/gotong.service`:

```ini
[Unit]
Description=Gotong host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gotong
Group=gotong
WorkingDirectory=/opt/gotong
EnvironmentFile=/etc/gotong.env
# Run the built host. `pnpm build` (step C.2) produced dist/. This is
# the recommended path: zero runtime transpile, fewer moving parts, no
# Node-version sensitivity.
ExecStart=/usr/bin/env node /opt/gotong/packages/host/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/gotong-data
ProtectHome=true
PrivateTmp=true
MemoryMax=512M
TasksMax=200
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

> Three alternative `ExecStart` lines you might use **instead** of the
> default above — pick one of these only if you have a specific reason:
>
> ```ini
> # If you `pnpm install -g @gotong/host` (or once it's on a registry):
> ExecStart=/usr/bin/env gotong-host
>
> # Skip the build step entirely — requires Node 22+:
> ExecStart=/usr/bin/env node --experimental-strip-types /opt/gotong/packages/host/src/main.ts
>
> # Run from source via tsx (Node 20 friendly, extra global dep):
> ExecStart=/usr/bin/env tsx /opt/gotong/packages/host/src/main.ts
> ```
>
> `--experimental-strip-types` requires **Node 22+** — on Node 20 the
> process exits immediately with `bad option: --experimental-strip-types`,
> so don't pick it unless you've actually deployed Node 22.

### C.5 Caddyfile

`/etc/caddy/Caddyfile`:

```caddy
# Global options — log to journal, sane timeouts
{
    admin off
    log {
        output stderr
        format console
    }
}

# Web (HTTP/HTTPS) on hub.example.com
hub.example.com {
    encode zstd gzip

    # Caddy adds X-Forwarded-* headers automatically; we use them for
    # client IP in the rate limiter. No additional config needed.
    reverse_proxy 127.0.0.1:3000 {
        # Generous timeouts: SSE stream is long-poll
        transport http {
            read_timeout 60s
            write_timeout 60s
        }
        flush_interval -1   # stream SSE chunks immediately
    }

    # Standard hardening
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        # Gotong already sets X-Frame-Options + CSP at the application
        # layer; these don't hurt but are kept here as defence in depth.
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        # Don't leak Caddy version
        -Server
    }
}

# WebSocket on a separate subdomain (cleaner ops, one cert per service)
hub-ws.example.com {
    reverse_proxy 127.0.0.1:4000 {
        transport http {
            read_timeout 600s
            write_timeout 600s
        }
    }
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        -Server
    }
}
```

`sudo systemctl reload caddy` reloads the config. Cert provisioning is
automatic on first hit if DNS is correct.

### C.6 Firewall

Open **only** 80 (Caddy redirects 80 → 443 automatically) and 443.
3000/4000 are loopback-only, so nothing punishes you for a permissive
firewall, but minimal is good hygiene:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

### C.7 First boot ritual

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gotong
sudo systemctl enable --now caddy
sudo journalctl -u gotong -f
```

**The admin URL is NOT in the log.** Since v3.4 (H20) the token never
touches stdout — `journalctl` / `docker logs` / any log shipper would
otherwise capture secret material. The log only points at the file:

```
备用 admin token URL 已写入 (读后即焚) / backup admin link saved:
  /srv/gotong-data/runtime/admin-link.txt
  mode 0o600 — only the user running this host can read it.
```

Read it (mode `0600`, owned by the service user — so `sudo`), then
**delete it**:

```bash
sudo cat /srv/gotong-data/runtime/admin-link.txt
sudo rm  /srv/gotong-data/runtime/admin-link.txt
```

The file holds `http://127.0.0.1:3000/admin?token=<HEX>` — replace the
`http://127.0.0.1:3000` prefix with `https://hub.example.com` and open
it in your browser. The cookie sticks because `GOTONG_COOKIE_SECURE=1`
and the page is served over TLS. Subsequent restarts of the service do
not re-mint a token — admins persist in `admins.json`.

> **Lost the file?** If you deleted the link file before using it (or
> the first boot predates your `GOTONG_HOST` being right), use the
> no-listener recovery subcommand:
>
> ```bash
> sudo -u gotong -H GOTONG_SPACE=/srv/gotong-data \
>   GOTONG_HOST=hub.example.com GOTONG_COOKIE_SECURE=1 \
>   /opt/gotong/packages/host/bin/gotong-host.js mint-admin-token
> ```
>
> Opens `GOTONG_SPACE` without starting the Hub or WebSocket / Web
> listeners, appends a new admin to `admins.json`, and **rewrites
> `runtime/admin-link.txt`** (same 0600 file, same H20 reason — never
> stdout). It respects `GOTONG_HOST` / `GOTONG_WEB_PORT` /
> `GOTONG_COOKIE_SECURE`, so with `GOTONG_HOST=hub.example.com` the URL
> inside the file already points at your public hostname — no prefix
> surgery needed. Existing admins, cookies, and sessions are untouched.
> Pass an optional display name to label the row:
> `mint-admin-token "Carol"`.

### C.8 Onboard more admins

Once you're in the admin UI, the **invite-admin** flow is server-side:

```bash
# from any machine with the token
curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"displayName":"Carol"}' \
     https://hub.example.com/api/admin/admins
```

The response includes `token` — that's the one-time plaintext token for
Carol. Send it to Carol via Signal / 1Password / sealed envelope. She
opens `https://hub.example.com/admin?token=<her-token>` and is in.

(A UI button for this lives in `admin.html`. Programmatically the API
above is what it calls.)

### C.9 Remote agents

```ts
import { connect, AgentParticipant } from '@gotong/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'my-agent', capabilities: ['draft'] }) }
  protected handleTask(task) { return { ok: true } }
}

await connect({
  url: 'wss://hub-ws.example.com',   // TLS, separate subdomain
  agents: [new MyAgent()],
})
```

They will hang in pending until an admin approves them in
`https://hub.example.com/admin`.

### C.10 Backups

The entire state is one directory tree (`/srv/gotong-data`). A nightly
`rsync` is enough:

```cron
30 03 * * * /usr/bin/rsync -a --delete /srv/gotong-data/ \
  backup-host:/srv/gotong-backup/$(date +\%F)/
```

To restore: stop systemd, replace the directory, start systemd. Cookies
issued before the restore continue working as long as
`runtime/admin-sessions.json` is included in the backup.

### C.11 Log rotation

`transcript.jsonl` is append-only and will grow forever. For a体验版
this is rarely an issue (KB/day per active user), but at some volume
configure `logrotate`:

`/etc/logrotate.d/gotong`:

```
/srv/gotong-data/transcript.jsonl {
    monthly
    rotate 24
    missingok
    notifempty
    compress
    delaycompress
    create 640 gotong gotong
    copytruncate
}
```

> `copytruncate` is intentional — the Hub keeps a write fd open and
> doesn't reload on SIGHUP. After rotation, the older rotated files are
> still loaded on next start as part of the transcript replay.

### C.12 Health check

`/healthz` returns `200 ok` with no body and no auth. Wire it into any
uptime monitor. systemd doesn't need it — process liveness is enough —
but a load balancer or Cloudflare health check will use it.

```bash
curl -fsS https://hub.example.com/healthz
# ok
```

### C.13 Updating the deployment

```bash
sudo -u gotong -H bash -lc 'cd /opt/gotong && git pull && pnpm install && pnpm build'
sudo systemctl restart gotong
```

`hub.stop()` drains gracefully on SIGTERM, so in-flight tasks settle and
SSE clients disconnect cleanly before the new process starts.

---

## Production checklist

Before pointing users at the URL:

- [ ] `GOTONG_COOKIE_SECURE=1` set
- [ ] `GOTONG_ALLOWED_HOSTS` lists exactly the user-facing hostnames
- [ ] `GOTONG_GATING=admin-approval` (never `open` on the public internet)
- [ ] Caddy has TLS issued and HSTS header sent
- [ ] systemd auto-restart enabled (`Restart=always`)
- [ ] 3000 / 4000 are loopback-only; only 80 / 443 in firewall
- [ ] Daily `rsync` backup running
- [ ] Logrotate configured for `transcript.jsonl`
- [ ] `/healthz` reachable, monitored
- [ ] At least 2 admin accounts (so one can re-mint the other if locked out)
- [ ] Out-of-band channel for distributing admin invite tokens
- [ ] You've smoke-tested the certificate flow (Let's Encrypt staging
      first if you're cautious)
- [ ] You know how to restore from backup before you need to
