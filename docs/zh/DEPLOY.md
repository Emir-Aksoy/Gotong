# 部署 AipeHub

> 同步自英文版 [`docs/DEPLOY.md`](../DEPLOY.md) @ 2026-05-17

本文是部署 AipeHub 到你笔记本之外的指南 —— LAN、单台 VPS、或一个小型机群。目标规模是**几十个用户、单节点**，不是全球 SaaS。一旦超出这个规模，第一个你会想替换的就是 file-first 存储。

部署形态有三种。挑能满足你需求的最小那一档 —— 后面每一档都是前一档的严格超集。

| 形态 | 何时用 | 工夫 | TLS | 跨机器客户端 |
|---|---|---|---|---|
| **A. 本机** | 单人开发 / 单用户 | 几秒 —— `pnpm host` | 无 | 仅 localhost |
| **B. LAN** | 可信办公室 / WiFi | 几分钟 —— 改 `host` | 无 | 仅局域网 |
| **C. 公网** | 公网体验版（小规模） | ~1 小时 —— Caddy + systemd | 是 | 任意位置 |

三种形态用的是同一个 `@aipehub/host` 二进制，区别只在环境变量。

---

## 0. 生产二进制

从 `packages/host` 构建。一个进程跑 Hub、WebSocket transport、Web UI 三合一。**没有任何 demo agent 自动注册**。配置完全靠环境变量读，所以同一个 build 可以靠改 env 直接 promote 到不同环境。

```bash
# 在仓根：
pnpm install
pnpm build                  # 生成 packages/*/dist
pnpm host                   # 用默认配置跑 packages/host

# 或者发布后：
pnpm install -g @aipehub/host
aipehub-host
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIPE_SPACE` | `.aipehub` | 工作区目录（首次运行自动创建） |
| `AIPE_HOST` | `127.0.0.1` | 绑定地址（在反向代理之后保持 loopback 是对的） |
| `AIPE_WEB_PORT` | `3000` | 浏览器 + admin API 的 HTTP 端口 |
| `AIPE_WS_PORT` | `4000` | remote agent 的 WebSocket 端口 |
| `AIPE_GATING` | `admin-approval` | `open` 跳过准入审核（**绝对不要**在公网用） |
| `AIPE_COOKIE_SECURE` | `0` | `1` 加 `Secure`+`SameSite=Strict`。HTTPS 前置时必须 |
| `AIPE_ALLOWED_HOSTS` | (未设) | 逗号列表。`Host:` 或 `Origin:` 不在列表里的 POST/DELETE 直接 reject。生产必设。 |
| `AIPE_ADMIN_RATE_MAX` | `10` | admin token 校验的每 IP 每窗口尝试次数上限（0 关闭） |
| `AIPE_ADMIN_RATE_SEC` | `60` | 速率窗口长度（秒） |
| `AIPE_DEFAULT_LANG` | `zh` | `zh` 或 `en` |
| `AIPE_HEARTBEAT_MS` | `30000` | transport 心跳间隔 |
| `AIPE_SPACE_NAME` | `AipeHub` | 写入 `space.json` 的工作区标签（仅首次初始化） |
| `AIPE_ADMIN_DISPLAY_NAME` | `Operator` | 第一个 admin 的显示名（仅首次初始化） |

二进制启动时**仅一次**打印首启 admin URL。务必存下来。后续启动只打印 `/admin` URL，因为 admin 的 token（hash 形式）已经写在 `admins.json` 里。

---

## A. 本机（默认）

```bash
pnpm host
# Web       : http://127.0.0.1:3000
# WebSocket : ws://127.0.0.1:4000
# （首启 admin URL 在这里打印）
```

打开 admin URL，cookie 写入浏览器，你就进去了。`Ctrl-C` 停止。工作区在 `./.aipehub/`。

这个跟 `pnpm demo:open-space` 功能上等价，只是没有 demo agent —— 想从干净的房间开始、自己挂 agent 的场景用它。

---

## B. LAN —— 把房间分享给同一网段的人

继续走 HTTP，但绑定到所有网卡 + 开防火墙。

```bash
AIPE_HOST=0.0.0.0 \
AIPE_WEB_PORT=3000 \
AIPE_WS_PORT=4000 \
AIPE_ALLOWED_HOSTS=192.168.1.42:3000 \
pnpm host
```

> 为什么 LAN 上也要 `AIPE_ALLOWED_HOSTS`？纵深防御：一个同事在登录你的 Hub 同时访问了 `evil.com`，你的 Hub 会拒绝伪造的 admin POST，因为外来 `Origin:` 不在 allow-list 里。

macOS 首次运行会弹「node 想接收外来连接」—— 点 Allow。同 WiFi 上的其他设备访问：

```
http://192.168.1.42:3000/         ← worker 入口
http://192.168.1.42:3000/admin    ← admin（首次带 token）
ws://192.168.1.42:4000            ← remote agent
```

> ⚠️ HTTP，没有加密。session cookie、dispatch 出去的 Task payload、admin token 全部明文传输。可信 LAN 没事，**经过公网就绝对不行**。

---

## C. 公网 —— VPS 上的 Caddy + systemd

模式：AipeHub 仍然绑 `127.0.0.1`，所有外部请求只能通过 Caddy。Caddy 在 `:443` 做 TLS 终结然后反向代理到内部。下面假设 Debian/Ubuntu，其他发行版自行调整路径。

### C.1 前置条件

- Linux VPS（1 vCPU / 1 GB RAM 撑得住几十个用户）
- 你能控的域名，DNS 指向 VPS。比如 `hub.example.com` 和 `hub-ws.example.com`。
- Node 20 LTS + pnpm 9
- Caddy 2（`apt install caddy`）
- 一个非 root 的系统用户（`aipehub`）持有 `/srv/aipehub-data`

### C.2 文件系统布局

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin aipehub
sudo mkdir -p /srv/aipehub-data
sudo chown aipehub:aipehub /srv/aipehub-data
sudo mkdir -p /opt/aipehub && sudo chown aipehub:aipehub /opt/aipehub

# 切换到 aipehub 用户
sudo -u aipehub -H git clone https://github.com/Emir-Aksoy/AipeHub.git /opt/aipehub
sudo -u aipehub -H bash -lc 'cd /opt/aipehub && pnpm install && pnpm build'
```

### C.3 环境配置文件

`/etc/aipehub.env`（chmod 640，归属 `aipehub:aipehub`）：

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

> ⚠️ **每一个**会被用到的主机名都要列出来 —— Caddy 用 Host 改写，上游看到的是原始 Host header。Web 域名和 WS 域名（如果分开）都必须在列表里。Caddy 把 Host header 重写成客户端发来的那个（`hub.example.com`），不是 `127.0.0.1`，所以 allow-list 对的是用户看到的那个名字。

### C.4 systemd unit

`/etc/systemd/system/aipehub.service`：

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
# 跑构建产物 dist/main.js。`pnpm build`（步骤 C.2）已经生成 dist/。
# 这是推荐路径：零运行时转换、组件最少、不挑 Node 版本。
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

> 三种**可选**的 ExecStart —— 上面的默认是推荐项，下面这些有特殊场景才用：
>
> ```ini
> # 如果你 `pnpm install -g @aipehub/host`（或将来发布到 registry 之后）：
> ExecStart=/usr/bin/env aipehub-host
>
> # 想完全跳过构建步骤 —— 要求 Node 22+：
> ExecStart=/usr/bin/env node --experimental-strip-types /opt/aipehub/packages/host/src/main.ts
>
> # 走 tsx 从源码跑（兼容 Node 20，但多一个全局依赖）：
> ExecStart=/usr/bin/env tsx /opt/aipehub/packages/host/src/main.ts
> ```
>
> `--experimental-strip-types` 要求 **Node 22+** —— 在 Node 20 上启动就 `bad option: --experimental-strip-types`，除非你已经部署了 Node 22 否则别选它。

### C.5 Caddyfile

`/etc/caddy/Caddyfile`：

```caddy
# 全局 —— 日志写 journal、sane timeouts
{
    admin off
    log {
        output stderr
        format console
    }
}

# hub.example.com 上的 Web（HTTP/HTTPS）
hub.example.com {
    encode zstd gzip

    # Caddy 自动加 X-Forwarded-*；我们用它作为 rate limiter 的客户端 IP 源，
    # 不需要额外配置。
    reverse_proxy 127.0.0.1:3000 {
        # 宽松超时：SSE 流是 long-poll
        transport http {
            read_timeout 60s
            write_timeout 60s
        }
        flush_interval -1   # SSE chunk 立刻 flush
    }

    # 标准 hardening
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        # AipeHub 在应用层已经设了 X-Frame-Options + CSP；这里再加一次
        # 是纵深防御。
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        # 别泄露 Caddy 版本号
        -Server
    }
}

# WebSocket 走独立子域名（运维更干净、每个服务一张证书）
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

`sudo systemctl reload caddy` 重载配置。DNS 正确的话首次访问会自动签发证书。

### C.6 防火墙

只开 **80**（Caddy 自动 80 → 443 跳转）和 **443**。3000 / 4000 是 loopback，所以防火墙再宽松也没坏处，但最小化是好习惯：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

### C.7 首启仪式

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aipehub
sudo systemctl enable --now caddy
sudo journalctl -u aipehub -f
```

在日志里找这一行：

```
First-run admin URL (shown ONCE — save it):
  http://127.0.0.1:3000/admin?token=<HEX>
```

把 `http://127.0.0.1:3000` 替换成 `https://hub.example.com`，在浏览器里打开。`AIPE_COOKIE_SECURE=1` 加 TLS，cookie 黏住。后续重启 systemd service 不会重新打印 token —— admin 已经持久化在 `admins.json` 里。

> **URL 丢了？** 如果错过 bootstrap 那行日志（终端关掉、log shipper 过滤掉、scrollback 翻过去），用下面这条**不启动 listener** 的恢复命令：
>
> ```bash
> sudo -u aipehub -H AIPE_SPACE=/srv/aipehub-data \
>   AIPE_HOST=hub.example.com AIPE_COOKIE_SECURE=1 \
>   /opt/aipehub/packages/host/bin/aipehub-host.js mint-admin-token
> ```
>
> 它不启动 Hub / WebSocket / Web listener，只 open `AIPE_SPACE`，往 `admins.json` 加一个新 admin，按 `AIPE_HOST` / `AIPE_WEB_PORT` / `AIPE_COOKIE_SECURE` 打印一次性 URL（公网 hostname 直接对得上），然后退出。已存在的 admin、cookie、session 都不动。可选传 display name 给新 admin 加标签：`mint-admin-token "Carol"`。

### C.8 邀请更多 admin

进入 admin UI 后，邀请其他 admin 是服务器端流程：

```bash
# 任意一台带 token 的机器
curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"displayName":"Carol"}' \
     https://hub.example.com/api/admin/admins
```

响应里有 `token` —— 这是给 Carol 的一次性明文 token。通过 Signal / 1Password / 密封信封发给 Carol。她打开 `https://hub.example.com/admin?token=<her-token>` 就进去了。

（admin.html 里有这个流程的 UI 按钮。程序化路径就是上面的 API。）

### C.9 Remote agent

```ts
import { connect, AgentParticipant } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'my-agent', capabilities: ['draft'] }) }
  protected handleTask(task) { return { ok: true } }
}

await connect({
  url: 'wss://hub-ws.example.com',   // TLS，独立子域名
  agents: [new MyAgent()],
})
```

它们会在 pending 状态挂着，直到 admin 在 `https://hub.example.com/admin` 里批准。

### C.10 备份

整个状态就是一棵目录树（`/srv/aipehub-data`）。每晚一次 `rsync` 就够：

```cron
30 03 * * * /usr/bin/rsync -a --delete /srv/aipehub-data/ \
  backup-host:/srv/aipehub-backup/$(date +\%F)/
```

恢复：停 systemd，替换目录，启 systemd。备份里包含 `runtime/admin-sessions.json` 的话，恢复前签发的 cookie 仍然能用。

### C.11 日志轮转

`transcript.jsonl` 是 append-only 的，会一直涨。体验版规模通常不是问题（每个活跃用户每天 KB 量级），但量大了配 `logrotate`：

`/etc/logrotate.d/aipehub`：

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

> `copytruncate` 是故意的 —— Hub 持有写入 fd 不松手，也不 reload SIGHUP。轮转后的旧文件下次启动时仍然作为 transcript 重放的一部分被加载。

### C.12 健康检查

`/healthz` 返回 `200 ok`，无 body 无 auth。给任何 uptime 监控接上。systemd 不需要它 —— 进程存活就够了 —— 但负载均衡 / Cloudflare 健康检查会用：

```bash
curl -fsS https://hub.example.com/healthz
# ok
```

### C.13 更新部署

```bash
sudo -u aipehub -H bash -lc 'cd /opt/aipehub && git pull && pnpm install && pnpm build'
sudo systemctl restart aipehub
```

`hub.stop()` 在 SIGTERM 上 drain 当前 inflight Task + 让 SSE 客户端断开干净，再启动新进程。

---

## 生产 checklist

把 URL 给用户之前：

- [ ] `AIPE_COOKIE_SECURE=1` 已设
- [ ] `AIPE_ALLOWED_HOSTS` 精确列出所有面向用户的 hostname
- [ ] `AIPE_GATING=admin-approval`（公网**绝不**用 `open`）
- [ ] Caddy 已签发 TLS 并发送 HSTS
- [ ] systemd 自动重启已开（`Restart=always`）
- [ ] 3000 / 4000 是 loopback；防火墙只开 80 / 443
- [ ] 每日 `rsync` 备份在跑
- [ ] `transcript.jsonl` 配了 logrotate
- [ ] `/healthz` 可达且被监控
- [ ] 至少 2 个 admin 账号（一个被锁出去另一个能重新 mint）
- [ ] 派发 admin 邀请 token 的带外通道（out-of-band channel）
- [ ] 证书流程跑通过（谨慎的话用 Let's Encrypt staging 先试）
- [ ] 你确认知道怎么从备份恢复（出事前确认）
