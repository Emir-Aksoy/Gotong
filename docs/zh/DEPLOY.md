# 部署 Gotong

> 同步自英文版 [`docs/DEPLOY.md`](../DEPLOY.md) @ 2026-05-17

本文是部署 Gotong 到你笔记本之外的指南 —— LAN、单台 VPS、或一个小型机群。目标规模是**几十个用户、单节点**，不是全球 SaaS。一旦超出这个规模，第一个你会想替换的就是 file-first 存储。

部署形态有三种。挑能满足你需求的最小那一档 —— 后面每一档都是前一档的严格超集。

| 形态 | 何时用 | 工夫 | TLS | 跨机器客户端 |
|---|---|---|---|---|
| **A. 本机** | 单人开发 / 单用户 | 几秒 —— `pnpm host` | 无 | 仅 localhost |
| **B. LAN** | 可信办公室 / WiFi | 几分钟 —— 改 `host` | 无 | 仅局域网 |
| **C. 公网** | 公网体验版（小规模） | ~1 小时 —— Caddy + systemd | 是 | 任意位置 |

三种形态用的是同一个 `@gotong/host` 二进制，区别只在环境变量。

---

## 0. 生产二进制

从 `packages/host` 构建。一个进程跑 Hub、WebSocket transport、Web UI 三合一。**没有任何 demo agent 自动注册**。配置完全靠环境变量读，所以同一个 build 可以靠改 env 直接 promote 到不同环境。

```bash
# 在仓根：
pnpm install
pnpm build                  # 生成 packages/*/dist
pnpm host                   # 用默认配置跑 packages/host

# 或者发布后：
pnpm install -g @gotong/host
gotong-host
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GOTONG_SPACE` | `.gotong` | 工作区目录（首次运行自动创建） |
| `GOTONG_HOST` | `127.0.0.1` | 绑定地址（在反向代理之后保持 loopback 是对的） |
| `GOTONG_WEB_PORT` | `3000` | 浏览器 + admin API 的 HTTP 端口 |
| `GOTONG_WS_PORT` | `4000` | remote agent 的 WebSocket 端口 |
| `GOTONG_GATING` | `admin-approval` | `open` 跳过准入审核（**绝对不要**在公网用） |
| `GOTONG_COOKIE_SECURE` | `0` | `1` 加 `Secure`+`SameSite=Strict`。HTTPS 前置时必须 |
| `GOTONG_ALLOWED_HOSTS` | (未设) | 逗号列表。`Host:` 或 `Origin:` 不在列表里的 POST/DELETE 直接 reject。生产必设。 |
| `GOTONG_ADMIN_RATE_MAX` | `10` | admin token 校验的每 IP 每窗口尝试次数上限（0 关闭） |
| `GOTONG_ADMIN_RATE_SEC` | `60` | 速率窗口长度（秒） |
| `GOTONG_DEFAULT_LANG` | `zh` | `zh` 或 `en` |
| `GOTONG_HEARTBEAT_MS` | `30000` | transport 心跳间隔 |
| `GOTONG_SPACE_NAME` | `Gotong` | 写入 `space.json` 的工作区标签（仅首次初始化） |
| `GOTONG_ADMIN_DISPLAY_NAME` | `Operator` | 第一个 admin 的显示名（仅首次初始化） |

首次启动时二进制铸一个 admin token，把 URL 写进 `<GOTONG_SPACE>/runtime/admin-link.txt`（mode `0600`）。它**从不打印**——守护进程的 stdout 会进 `journalctl` / `docker logs`，而这个 token 是凭证级的。启动横幅只告诉你文件路径。读一次，然后删掉。后续启动不会再铸新的——admin 的 token（hash 形式）已经写在 `admins.json` 里。

---

## 0.5 单文件二进制（无需 Node 运行时）

`gotong-host` 也以 `bun build --compile` 产出的自包含可执行文件形式分发。当你想在一台干净机器上跑 hub、不想装 Node.js / pnpm / 整个 workspace 时，用这个。

```bash
# Linux x64 —— 换成 -darwin-arm64 / -darwin-x64 / -windows-x64.exe
# / -linux-arm64 即可对应其它平台。
curl -L -o gotong-host \
  https://github.com/Emir-Aksoy/Gotong/releases/latest/download/gotong-host-linux-x64
chmod +x gotong-host
./gotong-host
```

二进制读的还是同样那套 `GOTONG_*` 环境变量，所以下面（A / B / C）的所有方案都直接适用 —— 把 `pnpm host` 或 `gotong-host`（npm 安装版）替换成 `./gotong-host` 就行。

二进制**里面**有什么：
- 整个 `@gotong/host` workspace —— Hub、WebSocket transport、Web UI（HTML/CSS/JS 静态资源在 build 时已经 embed 进二进制，不再从磁盘读）、各 LLM 适配器。
- 两个不依赖 native 代码的 first-party plugin：`@gotong/service-memory-file` 和 `@gotong/service-artifact-file`。

二进制**没有**包含的：
- `@gotong/service-datastore-sqlite` —— 依赖 `better-sqlite3`，后者带 native `.node` binding，bundler 没办法 embed。二进制运行时会自我识别身份，写出一份**不含 sqlite** 的默认 `plugins.json`，首启零 warning。要 SQL 后端的 datastore，请走 npm 或 docker 安装路径。
- 安装到 space 里的第三方 plugin —— 二进制无法解析自己 embedded module graph 外的包。要做 plugin 开发，走 npm 路径。

二进制大小约 60 MB（所有平台都差不多）。启动比 `tsx src/main.ts` 快 5 倍左右，因为没有 module loader walk。

---

## A. 本机（默认）

```bash
pnpm host
# Web       : http://127.0.0.1:3000
# WebSocket : ws://127.0.0.1:4000
# → 横幅指向设置向导（回环上无需 token）
```

本机上友好的入口是 web 根路径的**设置向导**——横幅会打印那个 URL，并且除非 `GOTONG_OPEN_BROWSER=0`，还会替你打开浏览器。带 token 的 `/admin` URL 是备用路径，在 `./.gotong/runtime/admin-link.txt`（mode `0600`）里。`Ctrl-C` 停止。工作区在 `./.gotong/`。

这个跟 `pnpm demo:open-space` 功能上等价，只是没有 demo agent —— 想从干净的房间开始、自己挂 agent 的场景用它。

---

## B. LAN —— 把房间分享给同一网段的人

继续走 HTTP，但绑定到所有网卡 + 开防火墙。

```bash
GOTONG_HOST=0.0.0.0 \
GOTONG_WEB_PORT=3000 \
GOTONG_WS_PORT=4000 \
GOTONG_ALLOWED_HOSTS=192.168.1.42:3000 \
pnpm host
```

> 为什么 LAN 上也要 `GOTONG_ALLOWED_HOSTS`？纵深防御：一个同事在登录你的 Hub 同时访问了 `evil.com`，你的 Hub 会拒绝伪造的 admin POST，因为外来 `Origin:` 不在 allow-list 里。

macOS 首次运行会弹「node 想接收外来连接」—— 点 Allow。同 WiFi 上的其他设备访问：

```
http://192.168.1.42:3000/         ← worker 入口
http://192.168.1.42:3000/admin    ← admin（首次带 token）
ws://192.168.1.42:4000            ← remote agent
```

> ⚠️ HTTP，没有加密。session cookie、dispatch 出去的 Task payload、admin token 全部明文传输。可信 LAN 没事，**经过公网就绝对不行**。

---

## C. 公网 —— VPS 上的 Caddy + systemd

模式：Gotong 仍然绑 `127.0.0.1`，所有外部请求只能通过 Caddy。Caddy 在 `:443` 做 TLS 终结然后反向代理到内部。下面假设 Debian/Ubuntu，其他发行版自行调整路径。

> **懒人路径**：§C.1–C.4 的机械部分（取码 → Node/pnpm → 服务用户 → build → env 模板 →
> systemd unit）有脚本一次做完——裸机 `curl -fsSL https://raw.githubusercontent.com/Emir-Aksoy/Gotong/main/deploy/cloud-quickstart.sh | sudo bash -s -- --clone`
> （先看不动手加 `--dry-run`）。unit 与本节 §C.4 逐字一致；跑完回来做 §C.5 Caddy + §C.6 防火墙。
>
> **容器路径**：宿主机不想装 Node 工具链的话，仓库根目录自带 `Dockerfile` +
> `docker-compose.yml`（本地/内网）+ `docker-compose.prod.yml`（Caddy TLS + 每日备份），
> 见 [`GO-LIVE.md`](GO-LIVE.md) §T2/T3.1a——本节的 systemd/Caddy 细节在容器档里由 compose 承担。

### C.1 前置条件

- Linux VPS（1 vCPU / 1 GB RAM 撑得住几十个用户）
- 你能控的域名，DNS 指向 VPS。比如 `hub.example.com` 和 `hub-ws.example.com`。
- Node 20 LTS + pnpm 9
- Caddy 2（`apt install caddy`）
- 一个非 root 的系统用户（`gotong`）持有 `/srv/gotong-data`

### C.2 文件系统布局

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin gotong
sudo mkdir -p /srv/gotong-data
sudo chown gotong:gotong /srv/gotong-data
sudo mkdir -p /opt/gotong && sudo chown gotong:gotong /opt/gotong

# 切换到 gotong 用户
sudo -u gotong -H git clone https://github.com/Emir-Aksoy/Gotong.git /opt/gotong
sudo -u gotong -H bash -lc 'cd /opt/gotong && pnpm install && pnpm build'
```

### C.3 环境配置文件

`/etc/gotong.env`（chmod 640，归属 `gotong:gotong`）：

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

> ⚠️ **每一个**会被用到的主机名都要列出来 —— Caddy 用 Host 改写，上游看到的是原始 Host header。Web 域名和 WS 域名（如果分开）都必须在列表里。Caddy 把 Host header 重写成客户端发来的那个（`hub.example.com`），不是 `127.0.0.1`，所以 allow-list 对的是用户看到的那个名字。

### C.4 systemd unit

`/etc/systemd/system/gotong.service`：

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
# 跑构建产物 dist/main.js。`pnpm build`（步骤 C.2）已经生成 dist/。
# 这是推荐路径：零运行时转换、组件最少、不挑 Node 版本。
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

> 三种**可选**的 ExecStart —— 上面的默认是推荐项，下面这些有特殊场景才用：
>
> ```ini
> # 如果你 `pnpm install -g @gotong/host`（或将来发布到 registry 之后）：
> ExecStart=/usr/bin/env gotong-host
>
> # 想完全跳过构建步骤 —— 要求 Node 22+：
> ExecStart=/usr/bin/env node --experimental-strip-types /opt/gotong/packages/host/src/main.ts
>
> # 走 tsx 从源码跑（兼容 Node 20，但多一个全局依赖）：
> ExecStart=/usr/bin/env tsx /opt/gotong/packages/host/src/main.ts
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

    # Caddy 自动加 X-Forwarded-*，而且在**没配 trusted_proxies**（就像这里）
    # 时会**忽略客户端自带的 XFF**，所以 host 用来给限流器分桶的那个 IP 伪造
    # 不了。这条车道到此为止，不需要额外配置。
    #
    # 但你若以后加了 trusted_proxies（比如前面挂 CDN），必须同时在本块里加
    # `header_up -X-Forwarded-For`——否则一个来自受信网段的客户端可以在 XFF
    # 前面塞个假 IP，绕开按 IP 的限流。compose 车道的 `caddy/Caddyfile` 正是
    # 这么做的，可作参照。
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
        # Gotong 在应用层已经设了 X-Frame-Options + CSP；这里再加一次
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
sudo systemctl enable --now gotong
sudo systemctl enable --now caddy
sudo journalctl -u gotong -f
```

**admin URL 不在日志里。** 从 v3.4 (H20) 起 token 永不进 stdout —— 否则 `journalctl` / `docker logs` / 任何 log shipper 都会把凭证抄走。日志只给你文件路径：

```
备用 admin token URL 已写入 (读后即焚) / backup admin link saved:
  /srv/gotong-data/runtime/admin-link.txt
  mode 0o600 — only the user running this host can read it.
```

读它（mode `0600`，属主是 service 用户，所以要 `sudo`），然后**删掉**：

```bash
sudo cat /srv/gotong-data/runtime/admin-link.txt
sudo rm  /srv/gotong-data/runtime/admin-link.txt
```

文件里是 `http://127.0.0.1:3000/admin?token=<HEX>` —— 把 `http://127.0.0.1:3000` 这段前缀换成 `https://hub.example.com`，在浏览器里打开。`GOTONG_COOKIE_SECURE=1` 加 TLS，cookie 黏住。后续重启 systemd service 不会再铸 token —— admin 已经持久化在 `admins.json` 里。

> **文件丢了？** 如果没用就删了（或者首启时 `GOTONG_HOST` 还没填对），用下面这条**不启动 listener** 的恢复命令：
>
> ```bash
> sudo -u gotong -H GOTONG_SPACE=/srv/gotong-data \
>   GOTONG_HOST=hub.example.com GOTONG_COOKIE_SECURE=1 \
>   /opt/gotong/packages/host/bin/gotong-host.js mint-admin-token
> ```
>
> 它不启动 Hub / WebSocket / Web listener，只 open `GOTONG_SPACE`，往 `admins.json` 加一个新 admin，然后**重写 `runtime/admin-link.txt`**（同一个 0600 文件、同一个 H20 理由——永不进 stdout），最后退出。它认 `GOTONG_HOST` / `GOTONG_WEB_PORT` / `GOTONG_COOKIE_SECURE`，所以带上 `GOTONG_HOST=hub.example.com` 时文件里的 URL 已经指向你的公网域名——不用再手动改前缀。已存在的 admin、cookie、session 都不动。可选传 display name 给新 admin 加标签：`mint-admin-token "Carol"`。

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
import { connect, AgentParticipant } from '@gotong/sdk-node'

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

整个状态就是一棵目录树（`/srv/gotong-data`）。每晚一次 `rsync` 就够：

```cron
30 03 * * * /usr/bin/rsync -a --delete /srv/gotong-data/ \
  backup-host:/srv/gotong-backup/$(date +\%F)/
```

恢复：停 systemd，替换目录，启 systemd。备份里包含 `runtime/admin-sessions.json` 的话，恢复前签发的 cookie 仍然能用。

### C.11 日志轮转

`transcript.jsonl` 是 append-only 的，会一直涨。体验版规模通常不是问题（每个活跃用户每天 KB 量级），但量大了配 `logrotate`：

`/etc/logrotate.d/gotong`：

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

> `copytruncate` 是故意的 —— Hub 持有写入 fd 不松手，也不 reload SIGHUP。轮转后的旧文件下次启动时仍然作为 transcript 重放的一部分被加载。

### C.12 健康检查

`/healthz` 返回 `200 ok`，无 body 无 auth。给任何 uptime 监控接上。systemd 不需要它 —— 进程存活就够了 —— 但负载均衡 / Cloudflare 健康检查会用：

```bash
curl -fsS https://hub.example.com/healthz
# ok
```

### C.13 更新部署

```bash
sudo -u gotong -H bash -lc 'cd /opt/gotong && git pull && pnpm install && pnpm build'
sudo systemctl restart gotong
```

`hub.stop()` 在 SIGTERM 上 drain 当前 inflight Task + 让 SSE 客户端断开干净，再启动新进程。

---

## 生产 checklist

把 URL 给用户之前：

- [ ] `GOTONG_COOKIE_SECURE=1` 已设
- [ ] `GOTONG_ALLOWED_HOSTS` 精确列出所有面向用户的 hostname
- [ ] `GOTONG_GATING=admin-approval`（公网**绝不**用 `open`）
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
