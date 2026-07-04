# 准备上线 — 三种拓扑 + IM 接入 + 云端风险

> 这份是「准备上线」的**决策与接入** runbook，回答三个问题：
> ① 家里电脑还是云服务器当 hub 本体？② 成员怎么连进来 —— IM 还是直连 IP？
> ③ 云服务器 IP 暴露有什么风险、怎么先准备好？
>
> 它**站在 [`DEPLOY.md`](DEPLOY.md) 之上**：Caddy / systemd / 防火墙 / 备份这些
> 通用机制 DEPLOY.md §C 已经写全，本文只**引用章节号**不重抄。配置模板在
> [`deploy/`](../../deploy/)（`.env.home` / `.env.cloud`）。
>
> Last updated: 2026-06-17

---

## 一、三种拓扑速览

用户要兼容三种部署形态。先看决策表，再按你选的那一档往下走。

| | **T1 家用主机 + IM** | **T2 云服务器 + IM** | **T3 云服务器 + 直连 IP** |
|---|---|---|---|
| **hub 本体在哪** | 家里电脑（MacBook 等） | 云 VPS | 云 VPS |
| **成员怎么连** | 私信 Telegram 机器人 | 私信 Telegram 机器人 | 浏览器开 `https://域名`（PWA） |
| **需要公网 IP / 端口转发** | **不需要** | 不需要（IM 出站） | 需要（域名 + TLS） |
| **需要 TLS / 域名** | 不需要 | 不需要 | **需要**（Caddy 自动签发） |
| **公网暴露面** | **零**（只有出站长轮询） | 零（只有出站长轮询） | 443（受 Caddy 保护） |
| **配置模板** | [`deploy/.env.home`](../../deploy/.env.home) | [`deploy/.env.cloud`](../../deploy/.env.cloud)（去掉直连） | [`deploy/.env.cloud`](../../deploy/.env.cloud) |
| **加固脚本** | 不需要 | [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) | [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) |
| **适合谁** | 个人 / 几个朋友、不想买服务器 | 想要 7×24 在线、但不想暴露 IP | 要手机 PWA、移动端原生体验 |

> **三者可叠加。** 同一个云主机可以**同时**开 IM 桥（T2）和直连 IP（T3）——
> `deploy/.env.cloud` 默认就两者都给。家里主机（T1）想加 LAN 直连也行（见 §五）。

三种形态用的是**同一个 `aipehub-host` 二进制、同一套 `AIPE_*` 环境变量、同一个
数据目录**。区别只在「绑哪个地址 + 有没有反向代理 + 有没有填 IM token」。

---

## 二、关键洞察：IM 接入 = 不需要内网穿透

这是 T1/T2 能成立的核心，也是很多人没意识到的：

> **IM 桥是「出站长轮询」。** hub 主动去 Telegram 的服务器拉新消息
> （`getUpdates` 长轮询），消息处理完再主动发回去。**Telegram 的服务器是中继**，
> hub 从不监听任何入站端口。

引自源码注释（`packages/host/src/im-bridge.ts:274`）：

> "outbound long-poll → no public endpoint needed, so a home box behind NAT
> works without a tunnel."

所以家里路由器 NAT 后面的电脑、或者把 web 端口完全封死在 loopback 的云主机，
**照样能服务全世界的成员** —— 成员发的是 Telegram，不是你的 IP。你不需要：

- ❌ 端口转发 / 内网穿透（frp / ngrok / Cloudflare Tunnel）
- ❌ 公网 IP / 域名 / TLS 证书
- ❌ 在防火墙上开任何入站端口

成员要的只是：你的**机器人用户名**（如 `@my_hub_bot`）+ 一个**绑定码**。

### 2.1 例外：QQ 官方 webhook 需要公网（其余五桥免穿透）

上面这套「出站、免穿透」对 Telegram / Lark / Slack / Discord / Matrix 全成立——它们
都主动拨向平台云端（Telegram / Matrix 长轮询，Discord / Lark / Slack 持久 WS）。
**唯一的例外是 QQ**：官方 Bot API 在 2024 底把 WebSocket 判死、只推**入站 webhook**，
所以 QQ 桥必须有公网域名 + TLS + 反代，跑 T2/T3 云主机，家用 NAT 后面收不到。理由与
取舍见 [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)。

| 桥 | 方向 | 免穿透 | 需公网入口 | 主动推送 |
|---|---|---|---|---|
| Telegram / Discord / Matrix | 出站 | ✅ | ❌ | ✅ |
| Lark（官方长连接） | 出站 | ✅ | ❌ | ✅ |
| Slack（Socket Mode） | 出站 | ✅ | ❌ | ✅ |
| **QQ（官方 webhook）** | **入站** | **❌** | **✅（域名 + TLS + 反代）** | **❌（仅被动回复）** |

> host 的 `startImBridges()` 按 env 起桥（Telegram / Lark / Slack / QQ 已 env-gate，
> Discord / Matrix 走示例 router）。本文以 Telegram 作 T1/T2 的默认 IM——它最省事、零
> 公网面；要接其他桥按上表的方向选合适拓扑（QQ → 必上云 + 反代）。

---

## 三、家用主机 vs 云服务器：差异有多大？

> 用户原话：「云服务器版的部署和家里主机的部署有多大差异？」

**结论先行：二进制、数据目录、配置方式、IM 接入 —— 全都一样。差异 100% 在「周界
（perimeter）」。** 家用主机天然在 NAT/loopback 后面，周界是 0；云主机一旦把 IP
亮在公网，就得把下面这一排过线防御补上。换句话说，**云部署 = 家用部署 + 一层周界**。

| 维度 | 家用主机（T1） | 云服务器（T2/T3） | 差异来源 |
|---|---|---|---|
| 二进制 | `aipehub-host` | `aipehub-host` | **无差异** |
| 数据目录 | `.aipehub/`（整目录搬走=搬走房间） | `/srv/aipehub-data` | 仅路径 |
| 配置 | `AIPE_*` 环境变量 | `AIPE_*` 环境变量 | **无差异** |
| IM 接入 | 填 `AIPE_TELEGRAM_BOT_TOKEN` | 同左 | **无差异** |
| 成员绑定流程 | `/me` 出码 → `/bind` | 同左 | **无差异** |
| 绑定地址 | `127.0.0.1`（loopback） | `127.0.0.1`（Caddy 反代） | 都是 loopback |
| **反向代理 + TLS** | 不需要 | **Caddy + 域名 + 证书** | ← 周界 |
| **`AIPE_COOKIE_SECURE`** | `0`（admin 只本机开） | **`1`**（cookie 过线） | ← 周界 |
| **`AIPE_ALLOWED_HOSTS`** | 不需要 | **必设**（CSRF/DNS-rebinding） | ← 周界 |
| **`AIPE_TRUST_PROXY`** | 不需要 | **`1`**（限速按真客户端 IP） | ← 周界 |
| **master key 位置** | 默认 `local-file`（盘上即可） | **`env` provider**（挪出数据盘） | ← 周界 |
| **防火墙** | 不需要 | **只开 443 + SSH** | ← 周界 |
| **异地备份 + 监控 + ≥2 admin** | 可选 | **必须** | ← 周界 |

**周界这一列就是 [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) 要替你
检查/落地的东西**（见 §七 + GL-4）。家用主机这一列全空，所以 T1 几分钟就能跑起来。

一个**反直觉但重要**的点：本框架的 boot 安全自检（`boot-security.ts`）只在主机绑
**非 loopback**（`0.0.0.0` / 域名）时才强制要求 `AIPE_ALLOWED_HOSTS` + `AIPE_COOKIE_SECURE=1`，
否则**拒绝启动**。而推荐的云端姿态是让主机仍绑 `127.0.0.1`、由 Caddy 反代 —— 这时
自检无条件通过，但**你仍然要手动设那三个过线开关**，因为真正过线的是 Caddy↔客户端
那一段。`deploy/.env.cloud` 已经把它们设好了。

---

## 四、拓扑 T1 — 家用主机 + IM（最省事，先验这个）

家里电脑当 hub，成员私信机器人。零公网暴露、零 TLS、零穿透。

### T1.1 建 Telegram 机器人

1. Telegram 里找 **@BotFather** → `/newbot` → 起名字 → 拿到 **token**（形如 `123456789:AAH...`）。
2. 记下机器人用户名（`@your_hub_bot`），等下发给成员。

### T1.2 配置 + 启动

```bash
cp deploy/.env.home .env.local          # .env.local 已 gitignore，放真 token 安全
$EDITOR .env.local                      # 填 AIPE_TELEGRAM_BOT_TOKEN=<你的 token>
set -a; . ./.env.local; set +a
pnpm host                               # 或 ./aipehub-host（单文件二进制）
```

启动日志里会打印一次性 admin URL（`http://127.0.0.1:3000/admin?token=...`），
**在这台机器的浏览器里打开**就进 admin 了（loopback，别人开不了）。

> macOS 上想关掉终端也让它跑：用 `launchd` 写一个 user agent（`~/Library/LaunchAgents/`），
> `ProgramArguments` 指向 `node .../packages/host/dist/main.js`、`EnvironmentVariables`
> 喂 `AIPE_*`。或者最简单：`tmux` / `screen` 里跑着。家用场景不必上 systemd。

### T1.3 准备一个能聊天的 agent

成员发的自由文本会派给 `AIPE_IM_CHAT_CAPABILITY`（默认 `chat`）这个 capability。
**所以你得有至少一个 agent 服务 `chat`**，否则成员发消息会收到「没人接」。在 admin UI
建一个托管 LLM agent（capability 填 `chat`，配好 provider/key），或导入任意带 `chat`
能力的模板。`/workflow <名字>` 走工作流派发，需要你先发布对应工作流。

### T1.4 成员接入

把这两样发给成员：① 机器人用户名 `@your_hub_bot`；② 让他们照 §六 出码绑定。

---

## 五、T1 变体 — LAN 直连（同网段开 admin UI）

想让同一个 WiFi 下的另一台设备也能开 admin/worker 网页（不止本机）：

```bash
# 在 .env.local 里改：
AIPE_HOST=0.0.0.0                       # 绑所有网卡
AIPE_ALLOWED_HOSTS=192.168.1.42:3000    # 你的局域网 IP
AIPE_ALLOW_INSECURE=1                   # ★ 必须 ★ 见下
```

> ⚠️ 绑 `0.0.0.0` 触发 boot 安全自检：它要求 `AIPE_COOKIE_SECURE=1`，但 LAN 是明文
> HTTP、开了 Secure cookie 反而发不出去 → 死锁。可信 LAN 的正解是设 `AIPE_ALLOW_INSECURE=1`
> 把自检从「拒绝启动」降为「响亮警告」。**这只在可信局域网用，明文流量经过公网就绝对不行。**
> 详见 [`DEPLOY.md`](DEPLOY.md) §B。

---

## 六、成员 IM 绑定流程（T1/T2 通用）

这是成员从「装了 Telegram」到「能用 hub」的完整路径。绑定把
`平台 + 平台用户ID → AipeHub userId` 对上，之后每条消息都按真实成员记账/审计。

```
成员 (在 /me 网页)           成员 (在 Telegram)              hub
     │                            │                          │
     │ 1. 点「绑定 IM」            │                          │
     │  POST /api/me/im/binding-code ───────────────────────►│  生成 6 位码
     │◄───────────────────────────────────  { code, expiresAt }  （10 分钟有效，
     │   屏幕显示 6 位码           │                          │   一人同时只一个活码）
     │                            │                          │
     │       2. 私信机器人  /bind <码> ───────────────────────►│  claimImBindingCode
     │                            │◄──────  "✓ 已绑定 / Bound"  │   平台ID → userId 落库
     │                            │                          │
     │                       3. 直接发消息（自由文本）─────────►│  派给 chat capability
     │                            │◄──────────  agent 的回复    │   origin.userId = 成员
```

**机器人命令**（`packages/host/src/im-bridge.ts`）：

| 命令 | 作用 | 绑定前可用？ |
|---|---|---|
| `/help` | 列命令 | ✅ |
| `/bind <码>` | 绑定本 IM 身份到 AipeHub 账户 | ✅ |
| `/unbind` | 解绑 | 需先绑定 |
| `/agents` | 列你能聊的 agent | 需先绑定 |
| `/workflow <名> <参数>` | 启动一个具名工作流 | 需先绑定 |
| `<任意文本>` | 聊天，派给你的默认 agent | 需先绑定 |

绑定前发普通消息，机器人会提示：「你还没有绑定 AipeHub 账户。在管理界面 / 我的
生成 6 位绑定码，然后私信我 `/bind <code>`。」

**绑定码的性质**（`packages/host/src/me-im-service.ts`，本次上线刚补的成员自助口）：
- 6 位数字，默认 **10 分钟**有效；
- **一人同时只有一个活码** —— 再点一次出新码，旧码立刻失效（轮换）；
- 绑定**按会话归属** —— `/me` 里你只看到自己的绑定，解绑也只能解自己的（别人的返回
  404，连「存不存在」都探测不到）。

> 出码的网页入口：成员登录后的 `/me`（「我的」）面板里的「绑定 IM」。这条路由
> （`POST /api/me/im/binding-code`）就是为了让**没有服务器 shell 的普通成员**也能
> 自助出码 —— 在此之前只有 admin 能在后台造码。

---

## 七、拓扑 T2/T3 — 云服务器

云端的 Caddy / systemd / 防火墙 / 首启仪式，[`DEPLOY.md`](DEPLOY.md) §C 已经逐行写全，
**这里不重抄**。本文只给「云端独有」的三件事：模板、风险、加固。

### T2/T3.1 用云端模板

**最快路径 —— 裸 VPS 一条命令**（仓库已公开，机器上不需要先有 checkout）：

```bash
curl -fsSL https://raw.githubusercontent.com/Emir-Aksoy/AipeHub/main/deploy/cloud-quickstart.sh \
  | sudo bash -s -- --clone
```

它把「取码 → Node/pnpm → 建服务用户 → build → 落 `/etc/aipehub.env`（就是下面这份模板）→
装 systemd unit」一次做完，**不自动 start**（最后打印安全的收尾步骤：填 token → `cloud-harden.sh`
→ `systemctl start`）。重跑 = `git fetch` + fast-forward 更新，绝不重置本地改动。先看不动手：
加 `--dry-run`。以下是等价的手动步骤（或 quickstart 跑完后回来核对）：

```bash
sudo cp deploy/.env.cloud /etc/aipehub.env
sudo chown aipehub:aipehub /etc/aipehub.env && sudo chmod 640 /etc/aipehub.env
sudo $EDITOR /etc/aipehub.env            # 改域名；master key 从 secret 注入（见下）
```

模板已设好过线防御三件套（`AIPE_COOKIE_SECURE=1` / `AIPE_ALLOWED_HOSTS` /
`AIPE_TRUST_PROXY=1`）+ master key `env` provider + 保留策略。
- **T2（云 + IM）**：填 `AIPE_TELEGRAM_BOT_TOKEN`，成员走 IM。Web 端口可以完全
  封在 loopback，连 Caddy/域名都不需要（admin 用 §八的 `mint-admin-token` 进）。
  **注意**：模板三件套是按 T3（有域名）预填的 —— 纯 loopback 档要按 §T2/T3.1b
  「步 2 开关分流」调整，否则你经 ssh 隧道做的一切写操作都会被 CSRF 闸 403。
  token 也可以不进 env：留空走首启向导落**密钥库**（§T2/T3.1b 向导变体；换 token
  时设回环境变量重启即可，env 永远优先于密钥库）。
- **T3（云 + 直连）**：留空 IM token（或两者都要也行），按 [`DEPLOY.md`](DEPLOY.md)
  §C.4（systemd）+ §C.5（Caddyfile）+ §C.6（防火墙）起反向代理，成员浏览器开
  `https://hub.example.com`（PWA 可装到手机桌面）。

> **托管 env 文件（`setting` 控制台写的那一个）**：[`setting` 运维控制台](SETTING-OPS-CONSOLE.md)
> 的 `config-set`（owner 在网页 / CLI 改）把 `AIPE_MODE` / `AIPE_WEB_PORT` / `AIPE_WS_PORT` /
> `AIPE_OPEN_BROWSER` 这类**非密钥**旋钮写进 `<AIPE_SPACE>/aipehub.env`。让它生效 = host 启动前
> 有人 source 它；systemd 用 `EnvironmentFile=` 干这件事（host 自己仍只读 `process.env`，boot
> 读路径逐字节不变）。在 `[Service]` 段加一行（前缀 `-` = 文件缺失不报错）：
>
> ```ini
> EnvironmentFile=-/var/lib/aipehub/.aipehub/aipehub.env   # 路径 = <AIPE_SPACE>/aipehub.env
> ```
>
> 它和上面那份 `/etc/aipehub.env`（操作员手填的过线防御 + master key provider）是**两份不同的
> 文件**：`/etc/aipehub.env` 是你部署时一次写好的基线，`<space>/aipehub.env` 是 owner 之后经
> 控制台调过的旋钮。`setting` 白名单**按构造拒一切密钥键**，所以 `<space>/aipehub.env` 里永远不会
> 有 token / master key —— 密钥仍走 §T2/T3.2 的 systemd secret。便携双击 launcher
> （`deploy/AipeHub.command` / `.sh`）已自带同款 source，云端只需补这一行 systemd 配置。

### T2/T3.1a 另一条快路 —— Docker Compose（宿主机零 Node/pnpm）

不想在宿主机装 Node 工具链？仓库根目录自带完整容器化三件，等价于 quickstart 的
另一条路（build 在容器里发生）：

```bash
git clone https://github.com/Emir-Aksoy/AipeHub.git && cd AipeHub
docker compose up -d --build
```

- [`Dockerfile`](../../Dockerfile) —— 多阶段 build；运行时非 root（`node` 用户）、
  默认 `AIPE_SPACE=/data`、内建 `/healthz` HEALTHCHECK。
- [`docker-compose.yml`](../../docker-compose.yml) —— 本地 / 内网档：数据 bind-mount 到
  `./data`，旋钮在 `environment:` 里加 `AIPE_*`。端口**只发布到 loopback**
  （`127.0.0.1:3000:3000`），配 `AIPE_ALLOW_INSECURE=1` 出厂即起（容器内必绑
  `0.0.0.0`，网络暴露闸由 loopback-only 发布兜真，闸降级为警告）。要 LAN/公网
  直连别改这份——换 prod 档正经过闸。
- [`docker-compose.prod.yml`](../../docker-compose.prod.yml) —— 公网档一条命令
  （`docker compose -f docker-compose.prod.yml up -d`）：Caddy 自动 TLS + 容器只读
  文件系统 + 每日备份 sidecar（`./backups/`，14 天保留）。域名 / 邮箱在文件头注释里改。

首启 admin 入口与裸机一致（§八）：banner 会提示一次性 URL 写在
`<AIPE_SPACE>/runtime/admin-link.txt`（容器内 `/data/runtime/…` = 宿主 `./data/runtime/…`），
**故意不进 `docker logs`**。打开这个 URL 登录后**直接落进首启向导**（操作员会话是
向导的第二信任锚，§八）——owner 密码 / LLM key / IM token 三步在浏览器里走完，
不必 env。要走 env 注入 IM token / master key 也照旧可用；下面的 TTFR 分钟账
同样适用，只是步 1 的 build 换成镜像构建。

### T2/T3.1b 部署 TTFR —— 裸 VPS → 首条 IM 回复的分钟账

「部署有多简单」的可测口径：**从一台裸 VPS 到你在 Telegram 里收到第一条回复，预算
15 分钟**（build 占一半）。每步都给「看到什么才算过」，卡住直接跳 §十一排查。

| # | 做什么 | 典型耗时 | 看到什么才算过 |
|---|---|---|---|
| 0 | Telegram 找 `@BotFather` 发 `/newbot` 拿 token | ~1 分钟 | 拿到 `123456:ABC…` 一串 |
| 1 | §T2/T3.1 的 quickstart 一条命令（`--clone`） | 5–10 分钟 | 结尾打印收尾三步，无红字 |
| 2 | 编辑 `/etc/aipehub.env`：填 token + master key + **按拓扑调开关（见下）** | 1–2 分钟 | — |
| 3 | 跑 [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) | <1 分钟 | 无红项（纯 T2 档见下方注） |
| 4 | `sudo systemctl start aipehub` | <1 分钟 | `curl -s 127.0.0.1:3000/healthz` 回 `ok`；journalctl 里出现 `IM bridge enabled`（`"platform":"telegram"`） |
| 5 | §八 `mint-admin-token` → 本地 `ssh -L 3000:127.0.0.1:3000 <vps>` → 浏览器开一次性 URL → `/me` 领绑定码 | 1–2 分钟 | 页面出 6 位绑定码 |
| 6 | Telegram 私信机器人 `/bind <码>`，再随便发一句 | ~1 分钟 | 机器人先确认绑定，然后**回答了你那句话** |

**步 2 的开关按拓扑分流**（`.env.cloud` 模板是按 T3 预填的）：

- **T3（有域名 + Caddy）**：照模板 —— `AIPE_ALLOWED_HOSTS` 填真域名，三件套全开。
- **T2（无域名，web 全封 loopback、只经 ssh 隧道进）**：`AIPE_ALLOWED_HOSTS=127.0.0.1:3000`，
  `AIPE_COOKIE_SECURE` / `AIPE_TRUST_PROXY` 留空不设。为什么：CSRF 闸按 Host/Origin
  精确匹配、**没有 loopback 豁免** —— 留着 `hub.example.com` 白名单 + 强制 https Origin，
  你经隧道做的一切写操作（admin UI / `/me` 出码 / 首启向导）都会 403。隧道档的传输加密
  由 ssh 承担。代价：`cloud-harden.sh` 会红 cookie/hosts 两项 —— 它按「只要 loopback 之外
  有人够得着」的最坏假设判，纯隧道档这两项是已知取舍，**其余项仍必须全绿**。

**token 不想进 env？走首启向导（落密钥库）**：步 2 留空 token → 步 4 起服后 ——
T3 直接开 `https://hub.example.com`（首启窗口内根路径就是向导），T2 开隧道后访问
`http://127.0.0.1:3000` —— 设 owner 密码 → LLM key 可跳过 → IM 步选平台粘 token →
页面报「机器人已上线!」、journalctl 出现 `"credSource":"vault"`。这条路顺带把步 5 的
admin 认领也做了（向导本身就是 owner 认领）。**T3 注意**：同机反代的连接在 host 看来
就是 loopback，首启向导在窗口期对公网可见 —— 起了 Caddy 就立刻走完认领，别把窗口晾着。
之后换 token：设回对应环境变量重启即可，**env 永远优先于密钥库**。

上线后复核：登录 admin 后开「设置」页（`/#settings`），「IM 通道」卡片会列出活着的
平台 + 凭证来源（`环境变量` / `密钥库`）—— 没看到你配的平台 = 桥没起来，回 §十一。

### T2/T3.2 master key 挪出数据盘（云端关键）

云盘会被快照、可能被盗。把凭证库主密钥（KEK）从数据盘挪到环境里，盘的镜像里就
**不含密钥**：

```bash
openssl rand -hex 32            # 生成一次，64 hex
```

把它通过 systemd secret（`systemd-creds` 或 `Environment=` 注入，**别**写进
`/etc/aipehub.env` 明文、**别**提交 git）喂给 `AIPE_MASTER_KEY`，并保持
`AIPE_MASTER_KEY_PROVIDER=env`。丢了这个 key = 解不开 vault，所以**单独离线备份它**
（跟数据备份分开放）。

### T2/T3.3 ★ 云服务器 IP 暴露风险（用户点名「要先准备好」）★

一旦云主机的 IP/域名上了公网，它就会被**持续扫描**。准备清单：

| 风险 | 后果 | 缓解 |
|---|---|---|
| 端口扫描 / 直连明文端口 | 绕过 TLS 拿明文 cookie/payload | 主机绑 `127.0.0.1`，**只**让 Caddy 对外；防火墙只开 443+SSH（§C.6） |
| admin token 暴力破解 | 撞库进 admin | `AIPE_ADMIN_RATE_MAX/SEC` 限速 + `AIPE_TRUST_PROXY=1` 按真 IP 限 |
| CSRF / DNS-rebinding | 诱导你的浏览器发伪造 admin 请求 | `AIPE_ALLOWED_HOSTS` 精确列白名单（不设 = 此防御关闭） |
| cookie 明文泄露 | 会话劫持 | `AIPE_COOKIE_SECURE=1` + 全程 HTTPS |
| 数据盘/快照被盗 | 直接解开 vault | master key 走 `env` provider，不落数据盘（§T2/T3.2） |
| 开放注册被滥用 | 陌生 agent 涌入 | `AIPE_GATING=admin-approval`（**绝不** `open`） |
| 无人值守崩溃 / 无备份 | 数据丢失、无人发现 | systemd `Restart=always`（§C.4）+ 异地备份（§九）+ 监控 `/healthz`（§C.12） |
| 单 admin 被锁死 | 永久失去控制 | 至少 2 个 admin（§C.8）+ `mint-admin-token` 恢复路径（§八） |

**最危险的反模式**：图省事让主机直接绑 `0.0.0.0` 跑明文 HTTP。boot 自检会拒绝启动，
逼你要么补好 TLS（正解），要么 `AIPE_ALLOW_INSECURE=1` 强行放行（**别这么干**——
等于把明文 cookie 亮在公网）。**永远在主机前面摆一个终结 TLS 的反向代理。**

上面这张表的检查/落地，交给 [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh)
（见 GL-4）—— 它会核对绑定、防火墙、过线开关、备份是否到位，缺一项就响亮提示。

---

## 八、远程 bootstrap（云主机上怎么拿到第一个 admin）

初始的 owner-password / 首启认领只认**两个信任锚**，而且**不信任
`X-Forwarded-For`** —— 哪怕开了 `AIPE_TRUST_PROXY`：

1. **loopback**：只看真实 socket 地址（`packages/web/src/setup-routes.ts` 的
   `isLoopbackReq`）。这是故意的：不让任何反代把外部请求伪装成本机来抢 owner。
2. **已验证的操作员会话**：请求带着能过 admin 闸的会话（`admin-link.txt` /
   `mint-admin-token` 换来的一次性 URL 登录后就有）。token 铸在 `0600` 的
   `runtime/` 里、与 master key 同一信任边界 —— 证明的是「有主机文件系统权限的
   操作员」，不是网络位置；比匿名 loopback（本机任意进程都算）**只紧不松**。

锚 2 就是 **Docker compose 的官方向导入口**：端口转发到容器的请求源 IP 是
bridge 网关、永远不是 loopback（锚 1 必不成立），`cat data/runtime/admin-link.txt`
打开一次性 URL 登录后，首启窗口没关的话向导直接出现，三步（owner 密码 / LLM key /
IM token）照走。网关 IP / XFF 声明仍然一概不信。

所以在云主机上（你 SSH 进去、但浏览器在本地、够不着它的 loopback），用**不启动
listener** 的恢复命令拿 admin URL：

```bash
sudo -u aipehub -H AIPE_SPACE=/srv/aipehub-data \
  AIPE_HOST=hub.example.com AIPE_COOKIE_SECURE=1 \
  node /opt/aipehub/packages/host/dist/main.js mint-admin-token "Operator"
```

它只 open 工作区、往 `admins.json` 加一个 admin、按 `AIPE_HOST`/`AIPE_WEB_PORT`/
`AIPE_COOKIE_SECURE` 打印一次性 URL（公网域名直接对得上），然后退出。一次性 URL
写到 `<AIPE_SPACE>/runtime/admin-link.txt`（权限 `0600`）而非 stdout，**防止 token
进 journalctl/docker logs**。已存在的 admin/cookie/session 都不动。

（首次在本机直接跑、或 docker 首启时，banner 也会告诉你去哪读这个文件。完整说明见
[`DEPLOY.md`](DEPLOY.md) §C.7。）

另一条路：空间还**没认领过 owner**（全新盒子）时，首启向导本身就是 admin 入口 ——
T3 起了反代后直接开 `https://域名`，T2 经 `ssh -L` 隧道开 `http://127.0.0.1:3000`，
设完 owner 密码就有 admin 了（还能顺路把 IM token 落密钥库）。适用条件与 CSRF 开关
的坑见 §T2/T3.1b 的向导变体。

---

## 九、配置模板与脚本索引

| 要做什么 | 用哪个 |
|---|---|
| T2/T3 裸 VPS 一条命令 provision | [`deploy/cloud-quickstart.sh`](../../deploy/cloud-quickstart.sh)（`--clone` 取码 + `--dry-run` 预览，§T2/T3.1） |
| 容器化整套（宿主机零 Node） | 根目录 [`Dockerfile`](../../Dockerfile) + [`docker-compose.yml`](../../docker-compose.yml)（本地/内网）+ [`docker-compose.prod.yml`](../../docker-compose.prod.yml)（Caddy TLS + 每日备份，§T2/T3.1a） |
| T1 家用 env | [`deploy/.env.home`](../../deploy/.env.home) |
| T2/T3 云端 env | [`deploy/.env.cloud`](../../deploy/.env.cloud) |
| 模板说明 | [`deploy/README.md`](../../deploy/README.md) |
| Caddyfile（docker） | [`caddy/Caddyfile`](../../caddy/Caddyfile) |
| Caddyfile（VPS 裸机）+ systemd + 防火墙 | [`DEPLOY.md`](DEPLOY.md) §C.4–C.6 |
| 云盒加固检查 | [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh)（GL-4） |
| 备份 / 恢复 / 校验 | `scripts/backup/{backup,restore,verify,prune,drill}.sh`（[`OPERATIONS.md`](../OPERATIONS.md)） |
| 监控 / 指标 | [`MONITORING.md`](../MONITORING.md) + §C.12 `/healthz` |

---

## 十、上线前检查清单

### T1 家用主机 + IM
- [ ] IM token 已配：env（真 token 放 `.env.local`，不进 git）**或**首启向导落密钥库（env 优先）
- [ ] 至少一个 agent 服务 `chat` capability（否则成员发消息没人接）
- [ ] `AIPE_HOST=127.0.0.1`（或确认走了 §五 LAN 变体）
- [ ] `AIPE_GATING=admin-approval`
- [ ] 测过一遍：自己用 Telegram 出码 → `/bind` → 发消息收到回复
- [ ] 机器人用户名 + 出码指引已发给成员

### T2/T3 云服务器（在 T1 清单基础上 +）
- [ ] `AIPE_COOKIE_SECURE=1` + `AIPE_ALLOWED_HOSTS=<所有域名>` + `AIPE_TRUST_PROXY=1` 三件套
- [ ] master key 走 `env` provider，key 从 secret 注入、**单独离线备份**
- [ ] 主机绑 `127.0.0.1`，Caddy 终结 TLS（T3）；防火墙只开 443 + SSH
- [ ] 跑过 [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh)，无红项（纯 T2 隧道档：cookie/hosts 两红是已知取舍，§T2/T3.1b）
- [ ] admin「设置」页（`/#settings`）「IM 通道」卡片列出了所配平台 + 凭证来源
- [ ] 部署 TTFR 达标：裸 VPS → 首条 IM 回复 ≤ 15 分钟（§T2/T3.1b 分钟账）
- [ ] 异地备份在跑（`scripts/backup/` + cron）+ `/healthz` 被监控
- [ ] ≥2 个 admin；确认 `mint-admin-token` 恢复路径可用
- [ ] 证书签发跑通（谨慎先用 Let's Encrypt staging）
- [ ] 确认知道怎么从备份恢复（出事前先演练一次：`scripts/backup/drill.sh`）

---

## 十一、启动失败排查（先 `doctor`，启动失败也有人话）

两道防线：**启动前**用 `aipehub doctor` 预检环境；**真启动失败**时 host 把常见、可恢复
的失败翻成一句话 + 指向 `doctor` 的人话（`friendlyBootError`），而不是甩一坨 stack trace。

### 11.1 `aipehub doctor` —— 启动前预检（不启动 host）

```bash
aipehub doctor          # 逐项 ✓/⚠/✖ + 修复建议；退出码 0=无 blocker，1=有，2=用法错
aipehub doctor --fix    # 先做「安全可逆」的自动修，再复检
```

预检 7 项：Node ≥ 20 / `@aipehub/host` 可解析 / `AIPE_WEB_PORT`、`AIPE_WS_PORT` 真能 bind /
`AIPE_SPACE` 可写（或首启可建）/ `provider=env` 时 `AIPE_MASTER_KEY` 在 / env 里有没有 LLM
key。**只报告 env 变量名，绝不打印值**。

`--fix` **只自动建缺失的数据目录**（`mkdir -p AIPE_SPACE`，可逆、host 首启本来也会建——
提前建出来好让 doctor 当场确认可写）。**危险项一律只提示不自动改**：端口被占（可能是你
正跑着的 hub）、目录只读 / 是文件（chmod、rm 有破坏性）、master key、特权端口（<1024）——
这些 doctor 报出来让你手动处理。

### 11.2 host 真启动失败 —— 人话提示

host 启动要绑两个端口 + 开数据目录 + 解密 vault，任一失败时 `friendlyBootError` 认得这几
类，打出「`✖ AipeHub could not start — …`」+ 该改哪个 env + `Run aipehub doctor`：

| 症状（errno） | 人话提示讲什么 | 你要做什么 |
|---|---|---|
| 端口被占（`EADDRINUSE`） | 哪个口被占（admin UI 还是 agent WS）、对应哪个 env | 关掉占口的进程，或把 `AIPE_WEB_PORT` / `AIPE_WS_PORT` 改到空闲口 |
| 没权限绑端口（`EACCES`/`EPERM` on `listen`） | <1024 是特权端口（**不会**误导你去 chmod 数据目录） | `AIPE_*_PORT` 改到 ≥1024，前面挂反代转 80/443 |
| master key 缺失 / 损坏 | vault 用 master key 加密 secrets；附上底层原因 | 默认 file：从备份恢复 `<space>/identity-master.key`（新 key 解不开旧 secrets）；env provider：设 `AIPE_MASTER_KEY` + `AIPE_MASTER_KEY_PROVIDER=env` |
| 数据目录不可写（`EACCES`/`EPERM`/`EROFS`） | 列出写不进的具体路径；只读挂载会显式说 | 修目录属主/权限，或把 `AIPE_SPACE` 指到能写的目录（只读挂载则重挂 rw） |
| 磁盘满 / 超配额（`ENOSPC`/`EDQUOT`） | 写 `AIPE_SPACE` 时盘满 / 超 quota | 清空间或提配额后重启 |

> 两处区分靠的不是猜：**特权端口**靠 `listen` syscall 跟「数据目录没权限」分开——绑 80 口
> 的用户不会被错误地叫去 chmod 数据盘；**master key 缺失**靠错误信息里 "master key" 字样
> 识别——key **文件**自身的 fs 权限错（信息里是 "identity-master.key"，无空格）不会误判成
> key 配置错，正确落到「数据目录不可写」那条。

---

## 十二、对应的代码 / 文档

| 主题 | 位置 |
|---|---|
| 启动失败人话提示（`friendlyBootError`） | `packages/host/src/boot-error.ts` |
| 启动前预检 + `--fix`（`aipehub doctor`） | `packages/cli/src/commands/doctor.ts` |
| IM 桥（出站长轮询、`/bind` 路由） | `packages/host/src/im-bridge.ts` |
| 成员自助出码口 | `packages/host/src/me-im-service.ts` + `/api/me/im/*`（`packages/web/src/me-routes.ts`） |
| boot 安全自检（暴露即 fail-closed） | `packages/host/src/boot-security.ts` |
| 首启认领双锚：loopback 或操作员会话（都不信 XFF） | `packages/web/src/setup-routes.ts`（`isLoopbackReq` / `setupTrustAnchor`） |
| 通用部署（三形态 + Caddy + systemd + 备份） | [`DEPLOY.md`](DEPLOY.md) |
| 日常运维（数据目录、备份/恢复/校验） | [`OPERATIONS.md`](../OPERATIONS.md) |
| 监控 / 指标 | [`MONITORING.md`](../MONITORING.md) |
