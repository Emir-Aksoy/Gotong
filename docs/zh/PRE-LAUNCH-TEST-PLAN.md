# AipeHub 上线前测试计划（Pre-Launch Test Plan）

> 这份是「**放给真实用户之前**，系统性验证一遍」的测试计划。它**站在
> [`GO-LIVE.md`](GO-LIVE.md) 之上**：GO-LIVE 回答「怎么部署、配置项设对没有」，
> 本文回答「**怎么验证它真能用、过不过、谁来验、阻不阻塞上线**」。
>
> 核心判断：**自动化测试层已经很厚**（CI 每次 push 跑全量 `build+typecheck+test`
> 跨 OS/Node matrix、Python pytest、Docker 镜像 smoke；`live.yml` nightly 真 LLM；
> 41 个 e2e 验收门；备份/恢复/演练全套脚本 + hermetic drill 测试）。所以本计划的
> 重心**不是重造单测**，而是系统化覆盖「**hermetic 测试结构上碰不到的真实世界三块**」：
> ① 真实凭证联调　② 真实部署 / 周界　③ 真实灾备演练。
>
> Last updated: 2026-06-19

---

## 一、本次上线范围（已与项目 owner 确认）

| 维度 | 本次 | 影响 |
|---|---|---|
| **目标拓扑** | **T1 家用主机 + IM**、**T2 云服务器 + IM**（均 Telegram 出站，免穿透） | L3 部署冒烟测两档；L4 周界验证只对 T2 |
| **不含拓扑** | T3 云 + 直连 IP / PWA（域名 + TLS + 浏览器直连） | L4 的 Caddy/TLS/PWA-装机 子项**推迟**，不阻塞本次 |
| **联邦** | **暂不**——单 hub 先上线 | **L7 跨组织联邦真两机验证整层推迟**（机制已有 41 e2e + 真 ws 验收门兜底） |
| **IM 凭证** | Telegram 必测；QQ/Lark/Slack 仅在本次启用时才测 | L2 以 Telegram 为默认主路径 |
| **SSO** | 仅在本次启用 OIDC/SAML 时才测真 IdP | L2 的 SSO 子项按需 |

> 范围一旦变化（比如后续要上 T3 或开联邦），把对应推迟层拉回阻塞项重跑即可。

---

## 二、测试金字塔与原则

```
            ┌─────────────────────────┐
            │  L9 验收 sign-off / go   │  ← 人工拍板
            ├─────────────────────────┤
            │  L8 端到端用户旅程        │  ← 人工，以终为始
            │  L5 灾备演练 / L6 监控    │  ← 人工真跑一次（脚本辅助）
            │  L3 部署冒烟 / L4 周界    │  ← 人工，按拓扑
            │  L2 真实凭证联调          │  ← 人工，hermetic 碰不到
            ├─────────────────────────┤
            │  L1 真实 LLM 冒烟         │  ← 半自动（live.yml 手动触发）
            │  L0 自动化基线回归        │  ← 全自动（CI 每次 push）
            └─────────────────────────┘
```

**两条原则**

1. **自动化的归 CI（确认绿即可），人工的归 runbook（真跑一遍并记录结果）。**
   不重造 L0 已覆盖的东西；L5/L7 的人工演练是「真机复演已被 hermetic 钉死的不变量」，
   不是从零验证。
2. **每层有明确通过标准 + 是否阻塞上线。** 阻塞项不过 = 不上线；非阻塞项不过 =
   记 issue、可带病上线但限期修。

---

## 三、分层测试矩阵（本次）

| 层 | 目标 | 形态 | 本次状态 |
|---|---|---|---|
| **L0** 自动化基线回归 | 全 workspace 无回归 | 全自动 | **阻塞** |
| **L1** 真实 LLM 冒烟 | provider 契约 + 真 workflow 不漂 | 半自动 | **阻塞** |
| **L2** 真实凭证联调 | 真 IM token（+按需 SSO/KB） | 人工 | **阻塞** |
| **L3** 部署冒烟 | T1 + T2 真起得来 | 人工 | **阻塞** |
| **L4** 安全 / 周界 | T2 暴露面 fail-closed | 人工 | **阻塞（仅 T2）** |
| **L5** 灾备演练 | 出事能恢复 | 人工 + 脚本 | **阻塞** |
| **L6** 监控告警 | 看得见 + 拍得了肩 | 人工 | 推荐（非硬阻塞） |
| **L7** 联邦真网络 | 跨组织不串数据 | 人工 | **本次推迟** |
| **L8** 端到端用户旅程 | 成员真能用 | 人工 | **阻塞** |
| **L9** 验收 sign-off | go / no-go | 人工 | **阻塞** |

---

## 四、各层详细

> 每层统一结构：**目标 · 前置 · 步骤 · 预期 · 通过标准 · 资产**。

### L0 — 自动化基线回归　【阻塞 · 全自动】

- **目标**：确认当前代码全 workspace 无回归，拿到精确基线数字当对照锚。
- **前置**：干净工作树（`git status` clean）；Node v20、pnpm；可选 Docker（镜像 smoke）。
- **步骤**：
  ```bash
  pnpm -r build          # web 测试依赖编译后的 core dist，先 build
  pnpm -r typecheck
  pnpm -r test           # 全 workspace vitest
  cd python-sdk && pytest -q && cd -        # Python SDK（CI 的 python job）
  ```
- **预期 / 通过标准**：全绿。基线测试数（**2026-06-19 本地实测**，vitest「Test Files」维度）：
  - **host**：121 passed | 1 skipped（122）—— skip = `live-workflow.test.ts`（缺 LLM key 自动跳，见 L1）
  - **web**：66 passed（66）　·　**identity**：36 passed（36）　·　**core**：36 passed（36）
  - **其余 29 包**：143 文件全 passed（含 `llm-openai` / `llm-anthropic` 各 1 个 live skip）
  - **合计：33 包 · 403 个测试文件全 passed · 3 个 live skip · `L0_EXIT=0`**
  - 注：host 日志里 2 行 `✖` 是 `recovery-drill` **负例**测试的预期 stderr（torn-transcript 本应 drill RED），host 仍 121 passed 无 failed，非回归。
- **资产**：`.github/workflows/ci.yml`（每次 push 已自动跑同样三步 + Docker smoke）。
- **备注**：CI 已经在每次 push 跑这套；本地这一遍是**释放前最后一次确认 + 取精确数字**。

### L1 — 真实 LLM 冒烟　【阻塞 · 半自动】

- **目标**：provider 工具调用契约 + 一条完整 workflow 在**真模型**上不漂移（mock
  的 wire 翻译可能和真 vendor 静默偏离）。
- **前置**：配好 `ANTHROPIC_API_KEY` 和/或 `OPENAI_API_KEY`(+`OPENAI_BASE_URL` 指
  DeepSeek 走最便宜路径)。
- **步骤**：
  - CI 侧：`live.yml` → Actions 手动 `workflow_dispatch` 触发一次（释放前）。
  - 本地侧（可选复核）：
    ```bash
    pnpm -C packages/llm-anthropic exec vitest run tests/live.test.ts
    pnpm -C packages/llm-openai    exec vitest run tests/live.test.ts
    pnpm -C packages/host          exec vitest run tests/live-workflow.test.ts
    ```
- **预期 / 通过标准**：provider 往返绿 + 一条真 workflow 端到端跑通。缺 key →
  skip（绿，非红），但**本次上线既然要用 LLM，必须配 key 真跑一次、不能靠 skip 蒙混**。
- **资产**：`.github/workflows/live.yml`、`docs/zh/V6-ROUTE-B-P1-M13-LIVE-GATE.md`。

### L2 — 真实凭证联调　【阻塞 · 人工】

> hermetic 测试用 FakeBridge / 注入 fetch，**碰不到真 token / 真平台**。这一层就是补这个。

- **目标**：真实外部凭证（IM、按需 SSO/KB）在真平台上能握手、能收发。
- **前置**：真 Telegram bot token（@BotFather）；按需真 QQ/Lark/Slack app 凭证、真 IdP、真 KB。
- **步骤 / 通过标准**：
  - **Telegram（必）**：填 `AIPE_TELEGRAM_BOT_TOKEN` 启动 → 自己私信机器人
    `/help` 有响应 → 完成 §六 绑定流程（出码 → `/bind` → 发消息收到 agent 回复）。
    通过 = 双向通、绑定落库、消息按真实成员归属。
  - **QQ/Lark/Slack（按需）**：仅本次启用时测。QQ 走官方 webhook 需公网 + 反代
    （必上 T2/云），按 [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md) 联调；Lark
    长连接 / Slack Socket Mode 免穿透。通过 = 各自平台能收发、被动回复正常。
  - **SSO（按需）**：启用 OIDC/SAML 则用真 IdP（Google/Azure/Okta）跑一次登录往返，
    确认 sub/email → user 联结、铸出 session。
  - **KB（按需）**：启用 Obsidian/Elasticsearch/RAG 则真起 MCP server，确认 agent 能读写。
- **资产**：`docs/zh/IM-OFFICIAL-REARCH.md`、`IM-BRIDGES.md`、`V6-ROUTE-B-P1-M4-OIDC.md`/
  `M5-SAML.md`、`KB-CONNECTORS.md`。**真凭证人工联调，永不入 CI、不 commit。**

### L3 — 部署冒烟（T1 + T2）　【阻塞 · 人工】

- **目标**：选定的两档拓扑真能从零起来、拿到 admin、健康检查通。
- **T1 家用主机 + IM**：
  ```bash
  cp deploy/.env.home .env.local   # 填 AIPE_TELEGRAM_BOT_TOKEN
  set -a; . ./.env.local; set +a
  pnpm host
  ```
  通过 = 启动 banner 打印一次性 admin URL（loopback）→ 本机浏览器进 admin →
  `GET /healthz` 200 → 建一个服务 `chat` 的 agent。
- **T2 云服务器 + IM**：按 [`GO-LIVE.md`](GO-LIVE.md) §七 + [`DEPLOY.md`](DEPLOY.md) §C
  用 `deploy/.env.cloud`（web 可封 loopback，IM 出站）→ 用 §八
  `mint-admin-token` 远程拿 admin URL（不启 listener、不信 XFF）→ `/healthz` 通。
  通过 = systemd 起得来、`Restart=always`、admin 可达、IM 出站连通。
- **通过标准**：两档都能起、都能拿到 admin、`/healthz` 都 200、都有 ≥1 个 `chat` agent。
- **资产**：`deploy/.env.home`、`deploy/.env.cloud`、`deploy/README.md`、`DEPLOY.md` §C。

### L4 — 安全 / 周界验证（仅 T2）　【阻塞 · 人工】

> T1 家用天然 NAT/loopback 后面，周界≈0；**这一层只对 T2 云档**。T3 的 Caddy/TLS/
> PWA-装机 子项本次**推迟**（不上 T3）。

- **目标**：云主机暴露面 fail-closed，照 GO-LIVE §七 风险表逐项过线。
- **步骤 / 通过标准**：
  - **boot 自检负例**：故意非 loopback bind 且不设 `AIPE_ALLOWED_HOSTS`/
    `AIPE_COOKIE_SECURE` → 确认**拒绝启动**（`boot-security.ts`）。通过 = 真的起不来。
  - **加固脚本**：`scripts/cloud-harden.sh` 跑完**无红项**（核对绑定/防火墙/过线开关/备份）。
  - **过线三件套**：`AIPE_COOKIE_SECURE=1` + `AIPE_ALLOWED_HOSTS` + `AIPE_TRUST_PROXY=1`。
  - **master key 挪出数据盘**：`AIPE_MASTER_KEY_PROVIDER=env` + key 从 secret 注入、
    **单独离线备份**、不落数据盘、不进 git/journal。
  - **防火墙**：只开 SSH（T2 不开 443，因走 IM 出站；若也开直连才需 443）。
  - **注册闸**：`AIPE_GATING=admin-approval`（**绝不** `open`）。
  - **限速**：`AIPE_ADMIN_RATE_*` 生效 + 按真客户端 IP（`TRUST_PROXY`）。
- **资产**：`scripts/cloud-harden.sh`、`packages/host/src/boot-security.ts`、`GO-LIVE.md` §七、
  `DEPLOY.md` §B/§C.6。

### L5 — 灾备演练（真跑一次）　【阻塞 · 人工 + 脚本】

- **目标**：出事前先证明能恢复——「需要那天之前」就发现坏 DR。
- **步骤 / 通过标准**：
  - **备份→恢复→校验→不变量 diff**：`scripts/backup/drill.sh <数据目录>` → **exit 0 +
    "DRILL PASSED"**（admins 保住 / 加密 secrets 随备份走 / **master key 正确缺席**——
    v3 `runtime/secret.key` + v4 `identity-master.key` 都不进备份）。
  - **master key 轮换**：`aipehub-host rotate-master-key` 跑一次 + 重启采纳新 key、
    vault 仍解得开（崩溃中途可 boot 自动恢复）。
  - **崩溃不丢 / 不重复扣费**：`crash-resume-ledger-e2e` 已 hermetic 钉死；真机做一次
    kill -9 → 重启 → 确认 parked 任务恢复、账本恰扣一次。
  - **单 admin 锁死恢复**：模拟丢 admin → `mint-admin-token` 拿回控制。确认 ≥2 admin。
- **资产**：`scripts/backup/{backup,restore,verify,prune,drill}.sh`、
  `packages/host/tests/{recovery-drill,crash-resume-ledger-e2e,backup-restore-smoke}.test.ts`、
  `docs/OPERATIONS.md`。

### L6 — 监控告警验证　【推荐 · 人工】

- **目标**：上线后看得见状态、越线能拍肩。
- **步骤 / 通过标准**：
  - `/metrics` 用 `AIPE_METRICS_TOKEN` bearer 抓得到（无 token → 404，错 token → 401）。
  - `monitoring/docker-compose.yml` 起 Prometheus + Alertmanager + Grafana，dashboard
    自动 provision，抓到 `/metrics`。
  - `/healthz` 接入监控（systemd/uptime）。
  - 造一条 breach → 告警**真投递**到一个通道（webhook 或 IM），确认 counts-only 不泄漏。
- **资产**：`monitoring/`、`MONITORING.md`、`docs/zh/V5-F-FINAL.md`、`web/src/*metrics*`。
- **备注**：非硬阻塞——可带「监控待补」上线，但限期补齐。

### L7 — 联邦真网络　【本次推迟】

- **本次不做**（单 hub 先上线）。机制兜底：41 个 e2e 验收门 +
  `cross-hub-*-ws-e2e`（真 ws）+ `peer-isolation-ws-e2e` 已覆盖信任契约 / 出站审批 /
  data-class / 配额 / 隔离。**首发即开联邦时**再按 [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)
  两机真跑（铸 token → 对称登记 peer → per-link 契约 → 跨 hub 工作流 → 出站审批 → 隔离核验）
  并把本层拉回阻塞项。

### L8 — 端到端用户旅程　【阻塞 · 人工】

> 以终为始：站在**真实成员**视角，把上线后最常走的路各走一遍。

- **关键旅程（T1/T2 IM 默认）**：
  1. **成员入会**：拿到机器人用户名 → `/me` 出码 → 私信 `/bind <码>` → 发自由文本 →
     收到 agent 回复（按真实成员归属/记账）。
  2. **发起工作流**：`/workflow <名>` 或 `/me` 面板发起一个已发布工作流 → 跑通 / 看到结果。
  3. **HITL 审批**（若上线工作流含 `human:` 步）：步骤挂起 → 审批人 `/me` 收件箱
     批/拒 → 工作流恢复并按裁决继续。
  4. **管家改 agent**（若启用）：成员/operator 用大白话让管家建/改 agent →
     危险/跨 hub 动作走收件箱二次确认。
- **通过标准**：每条旅程从成员视角真能走通，无「没人接」「卡住不动」「报错」。
- **资产**：`GO-LIVE.md` §六、`packages/host/src/im-bridge.ts`、`docs/zh/V5-STEWARD-FINAL.md`。

### L9 — 验收 sign-off / go-no-go　【阻塞 · 人工】

- **目标**：汇总各层结论，做上线 / 不上线决定。
- **步骤**：逐项确认 L0–L6 + L8 的阻塞项全部通过 → 走一遍 [`GO-LIVE.md`](GO-LIVE.md)
  §十「上线前检查清单」（T1 / T2 两份）打勾 → 记录 go/no-go + 遗留 issue + 负责人。
- **通过标准**：所有**阻塞**层通过；非阻塞层（L6）若不过，记 issue + 限期，可 go。

---

## 五、本次显式推迟（范围外，变更范围时拉回）

| 项 | 何时拉回 |
|---|---|
| **L7 跨组织联邦真两机验证** | 首发即开联邦，或上线后接第一个 peer 前 |
| **T3 直连 IP / TLS / 域名 / PWA 装机**（L3/L4 的 T3 子项） | 决定上 T3 浏览器直连时 |
| **QQ / Lark / Slack 真凭证联调**（L2 子项） | 启用对应 IM 桥时（QQ 需公网 + 反代） |
| **真 SSO IdP / 真 KB 联调**（L2 子项） | 启用 OIDC/SAML 或 Obsidian/ES/RAG 时 |

---

## 六、对应资产索引

| 主题 | 位置 |
|---|---|
| 部署决策 + 三拓扑 + IM 接入 + 上线前检查清单 | [`GO-LIVE.md`](GO-LIVE.md) |
| 通用部署（Caddy/systemd/防火墙/备份） | [`DEPLOY.md`](DEPLOY.md) §C |
| 运维（数据目录、备份/恢复/校验） | [`OPERATIONS.md`](../OPERATIONS.md) |
| 监控 / 指标 | [`MONITORING.md`](../MONITORING.md)、`monitoring/` |
| IM 官方化（QQ/Lark/Slack transport + 方向表） | [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)、[`IM-BRIDGES.md`](IM-BRIDGES.md) |
| 真 LLM 冒烟门 | `.github/workflows/live.yml`、[`V6-ROUTE-B-P1-M13-LIVE-GATE.md`](V6-ROUTE-B-P1-M13-LIVE-GATE.md) |
| 联邦两机 runbook（L7 拉回时） | [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) |
| 配置模板 | `deploy/.env.home`、`deploy/.env.cloud`、`deploy/README.md` |
| 灾备 / 加固脚本 | `scripts/backup/`、`scripts/cloud-harden.sh` |
| CI（L0 全自动） | `.github/workflows/ci.yml` |
| e2e 验收门（41 个，机制兜底） | `packages/host/tests/*e2e*.test.ts` 等 |
