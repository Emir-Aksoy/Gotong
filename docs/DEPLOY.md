# Deploying AipeHub

This guide is for running AipeHub somewhere other than your laptop —
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

The same `@aipehub/host` binary is used for all three. Only environment
variables change.

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
pnpm install -g @aipehub/host
aipehub-host
```

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `AIPE_SPACE` | `.aipehub` | Workspace directory (created on first run) |
| `AIPE_HOST` | `127.0.0.1` | Bind address (loopback is correct behind a reverse proxy) |
| `AIPE_WEB_PORT` | `3000` | HTTP port for browser + admin API |
| `AIPE_WS_PORT` | `4000` | WebSocket port for remote agents |
| `AIPE_GATING` | `admin-approval` | `open` skips admission gating (do **not** use on the public internet) |
| `AIPE_COOKIE_SECURE` | `0` | `1` to add `Secure`+`SameSite=Strict`. Required when fronted by HTTPS |
| `AIPE_ALLOWED_HOSTS` | (unset) | Comma list. Reject POST/DELETE if `Host:` or `Origin:` is off-list. Set this in production. |
| `AIPE_ADMIN_RATE_MAX` | `10` | Admin-token attempts per IP per window (0 disables) |
| `AIPE_ADMIN_RATE_SEC` | `60` | Window for the rate limit in seconds |
| `AIPE_DEFAULT_LANG` | `zh` | `zh` or `en` |
| `AIPE_HEARTBEAT_MS` | `30000` | Transport heartbeat interval |
| `AIPE_SPACE_NAME` | `AipeHub` | Label written into `space.json` on first init |
| `AIPE_ADMIN_DISPLAY_NAME` | `Operator` | First admin's display name (on first init only) |

When the binary boots it **prints the first-run admin URL exactly
once**. Save it. Subsequent boots only print the `/admin` URL, since the
admin's token already lives (hashed) in `admins.json`.

---

## A. Local (default)

```bash
pnpm host
# Web       : http://127.0.0.1:3000
# WebSocket : ws://127.0.0.1:4000
# (first-run admin URL printed here)
```

Open the admin URL once, the cookie is set, you're in. Stop with
`Ctrl-C`. Your space lives in `./.aipehub/`.

This is functionally identical to `pnpm demo:open-space`, just without
the demo agent — useful when you want to start with a clean room and
plug in your own agents.

---

## B. LAN — share the room with people on the same network

Stay on HTTP, but bind to all interfaces and open the firewall.

```bash
AIPE_HOST=0.0.0.0 \
AIPE_WEB_PORT=3000 \
AIPE_WS_PORT=4000 \
AIPE_ALLOWED_HOSTS=192.168.1.42:3000 \
pnpm host
```

> Why `AIPE_ALLOWED_HOSTS` even on a LAN? Defence in depth: a colleague
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

The pattern: AipeHub still binds `127.0.0.1` so nothing can reach it
except through Caddy, which terminates TLS on `:443` and proxies inward.
Everything that follows assumes Debian/Ubuntu; adjust paths for other
distros.

### C.1 Prerequisites

- Linux VPS (1 vCPU / 1 GB RAM handles dozens of users comfortably)
- A domain you control with DNS pointed at the VPS. Example:
  `hub.example.com` and `hub-ws.example.com`.
- Node 20 LTS + pnpm 9
- Caddy 2 (`apt install caddy`)
- A non-root system user (`aipehub`) that owns `/srv/aipehub-data`

### C.2 Lay out the filesystem

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin aipehub
sudo mkdir -p /srv/aipehub-data
sudo chown aipehub:aipehub /srv/aipehub-data
sudo mkdir -p /opt/aipehub && sudo chown aipehub:aipehub /opt/aipehub

# as the aipehub user
sudo -u aipehub -H git clone https://github.com/Emir-Aksoy/AipeHub.git /opt/aipehub
sudo -u aipehub -H bash -lc 'cd /opt/aipehub && pnpm install && pnpm build'
```

### C.3 Environment file

`/etc/aipehub.env` (chmod 640, owned by `aipehub:aipehub`):

```bash
AIPE_SPACE=/srv/aipehub-data
AIPE_HOST=127.0.0.1
AIPE_WEB_PORT=3000
AIPE_WS_PORT=4000
AIPE_GATING=admin-approval
AIPE_COOKIE_SECURE=1
AIPE_ALLOWED_HOSTS=hub.example.com,hub-ws.example.com
AIPE_ADMIN_RATE_MAX=10
AIPE_ADMIN_RATE_SEC=60
AIPE_SPACE_NAME=Hub Beta
AIPE_ADMIN_DISPLAY_NAME=Operator
```

> ⚠️ List **every** hostname that will reach the box — Caddy uses Host
> rewriting, so the upstream sees the original Host header. Both the web
> domain and the WS domain (if different) must be listed. Caddy
> reformats the Host header to what the client sent (`hub.example.com`),
> not `127.0.0.1`, so the allow-list compares against the user-facing
> name.

### C.4 systemd unit

`/etc/systemd/system/aipehub.service`:

```ini
[Unit]
Description=AipeHub host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aipehub
Group=aipehub
WorkingDirectory=/opt/aipehub
EnvironmentFile=/etc/aipehub.env
# Run the built host. `pnpm build` (step C.2) produced dist/. This is
# the recommended path: zero runtime transpile, fewer moving parts, no
# Node-version sensitivity.
ExecStart=/usr/bin/env node /opt/aipehub/packages/host/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/aipehub-data
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
> # If you `pnpm install -g @aipehub/host` (or once it's on a registry):
> ExecStart=/usr/bin/env aipehub-host
>
> # Skip the build step entirely — requires Node 22+:
> ExecStart=/usr/bin/env node --experimental-strip-types /opt/aipehub/packages/host/src/main.ts
>
> # Run from source via tsx (Node 20 friendly, extra global dep):
> ExecStart=/usr/bin/env tsx /opt/aipehub/packages/host/src/main.ts
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
        # AipeHub already sets X-Frame-Options + CSP at the application
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
sudo systemctl enable --now aipehub
sudo systemctl enable --now caddy
sudo journalctl -u aipehub -f
```

In the log, find the line:

```
First-run admin URL (shown ONCE — save it):
  http://127.0.0.1:3000/admin?token=<HEX>
```

Replace `http://127.0.0.1:3000` with `https://hub.example.com` and open
it in your browser. The cookie sticks because `AIPE_COOKIE_SECURE=1`
and the page is served over TLS. Subsequent restarts of the service do
not re-print the token — admins persist in `admins.json`.

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
import { connect, AgentParticipant } from '@aipehub/sdk-node'

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

The entire state is one directory tree (`/srv/aipehub-data`). A nightly
`rsync` is enough:

```cron
30 03 * * * /usr/bin/rsync -a --delete /srv/aipehub-data/ \
  backup-host:/srv/aipehub-backup/$(date +\%F)/
```

To restore: stop systemd, replace the directory, start systemd. Cookies
issued before the restore continue working as long as
`runtime/admin-sessions.json` is included in the backup.

### C.11 Log rotation

`transcript.jsonl` is append-only and will grow forever. For a体验版
this is rarely an issue (KB/day per active user), but at some volume
configure `logrotate`:

`/etc/logrotate.d/aipehub`:

```
/srv/aipehub-data/transcript.jsonl {
    monthly
    rotate 24
    missingok
    notifempty
    compress
    delaycompress
    create 640 aipehub aipehub
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
sudo -u aipehub -H bash -lc 'cd /opt/aipehub && git pull && pnpm install && pnpm build'
sudo systemctl restart aipehub
```

`hub.stop()` drains gracefully on SIGTERM, so in-flight tasks settle and
SSE clients disconnect cleanly before the new process starts.

---

## Production checklist

Before pointing users at the URL:

- [ ] `AIPE_COOKIE_SECURE=1` set
- [ ] `AIPE_ALLOWED_HOSTS` lists exactly the user-facing hostnames
- [ ] `AIPE_GATING=admin-approval` (never `open` on the public internet)
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
