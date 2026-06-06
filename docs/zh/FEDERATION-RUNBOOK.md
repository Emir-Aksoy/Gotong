# 跨组织联邦 — 两机操作员 runbook

> 把两台**不同机器上**的 AipeHub（org A 与 org B）通过真 WebSocket 连成联邦，让
> 一个 hub 的工作流能编排另一个 hub 的能力——而**凭证 / 数据 / 计费各归各家**。这是
> 北极星 **第 2 层「跨组织协作」** 的上线手册：面向运维人员，从铸 token 到看见跨 hub
> 工作流跑通，一步一步。
>
> 想先在一个进程里看清机制？跑 `pnpm demo:cross-hub-federation`
> （`examples/cross-hub-federation/`）——两个真 hub 过真 ws + bearer auth，确定性、无 key。
> 本文是把那个 demo 拆到两台真机器上。
>
> Last updated: 2026-06-06

---

## 0. 心智模型（先读这 4 条）

1. **联邦是对称的，一个 token 两边各登记一次。** 不是「客户端 / 服务端」——两边都是
   主权 hub。org A 铸一个 token，两台机器各把**同一个字符串**登记进自己的 peer 记录：
   org A 用它出站到 org B，org B 用它验证「期望 org A 出示」的凭证。

2. **endpoint = 对方的 ws 地址。** 每一侧 peer 记录里的 `endpointUrl` 指向**对方** hub
   可达的 WebSocket 端点（`wss://partner.example.com:4000` 或反代后的 `wss://…/`）。联邦
   端口跟远程 agent 共用同一个 `AIPE_WS_PORT`（默认 4000）——HELLO 帧自己分流。

3. **框架不替你做信任决策。** 链路只是管子。能放什么能力出站（`outboundCaps`）、要不
   要人工批准（`requireApprovalOutbound`）、能带什么数据类（`allowedDataClasses`）、每窗口
   多少配额（`perLinkQuotaBudget`）——全是你在 peer 记录上**显式**配的 per-link 契约，
   默认 fail-closed。

4. **自由图，不是层级树。** org A 连 org B **不等于** org A 拥有 org B。每条链路是一份
   双边契约；撤销、配额、数据类都是 per-link 的，互不外溢。

> 安全模型的「为什么」（token 写入即加密进 vault、对称登记、撤销语义）见
> [`V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md)；
> per-link data-class / 配额 / 撤销的设计见
> [`V4-PHASE19-P4-FINAL.md`](V4-PHASE19-P4-FINAL.md)。本文不重复那些，只讲操作。

---

## 1. 前置条件

两台机器各自：

- 跑起生产 host（`aipehub start`），**接了 identity store**（联邦记录住在 identity 的
  `peers` 表 + vault）。如何本地起一个带 identity 的生产 host，见 `aipehub start --help`
  与 [`DEPLOY.md`](DEPLOY.md)。
- 有一个 **owner** 账号（peer CRUD 与出站审批都需要 owner 权限）。
- 网络互通：org B 的机器能拨到 org A 暴露的 ws 端点，反之亦然（双向，因为联邦对称）。
- **强烈建议 TLS**：跨公网时用 `wss://`（反向代理 Caddy / nginx 终止 TLS → 转发到本机
  `AIPE_WS_PORT`）。明文 `ws://` 只在可信内网 / 同机演示用。

相关环境变量（host 侧，`aipehub start` 读）：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `AIPE_HOST` | `127.0.0.1` | HTTP 与 ws 服务器绑定地址。公网暴露要设成 `0.0.0.0` 或具体网卡（建议只让反代连本机，hub 仍绑 `127.0.0.1`）。 |
| `AIPE_WS_PORT` | `4000` | WebSocket 端口——**远程 agent 与入站 peer HELLO 共用**。这就是对方 `endpointUrl` 要指的端口。 |
| `AIPE_WEB_PORT` | `3000` | 管理 UI + API（owner 在这上面配 peer、批审批）。**不要**把这个端口当 peer endpoint。 |
| `AIPE_PEERS_DISABLED` | （未设） | 设 `1` 彻底关掉联邦（既不出站拨号也不接受入站）。 |
| `AIPE_PEER_POLL_MS` | `5000` | 出站拨号重连 tick（ms）。改了 peer 记录后，最迟下一个 tick 生效。 |
| `AIPE_TRUST_PROXY` | （未设） | 设 `1` 让入站限流读 `X-Forwarded-For`——**只在 hub 真的坐在反向代理后面时设**。 |
| `AIPE_PEER_INBOUND_RATE_MAX` | `60` | 每 IP 每窗口最大 HELLO 次数（防 token 爆破）。 |
| `AIPE_PEER_INBOUND_RATE_WINDOW_MS` | `60000` | 上面那个限流窗口（ms）。 |
| `AIPE_PEER_LINK_QUOTA_WINDOW_MS` | `60000` | per-link 入站配额计数窗口（ms）；配额额度本身在 peer 记录的 `perLinkQuotaBudget`。 |

---

## 2. 步骤

下面以 **org A 发起、编排 org B 的一个能力**为主线。联邦对称，所以两边的登记动作镜像
对称——文中标 “「A 机」/「B 机」” 区分。

### Step 1 — 铸 token（在 A 机，一次）

```bash
aipehub mint-peer-token --peer-id=org-b --endpoint=wss://hub-b.example.com:4000
```

- 输出：**一行 256-bit base64url token** 打到 **stdout**（可 `> token.txt` / 管道）；一段
  中文配对提示打到 **stderr**（不污染 stdout）。
- `--bytes=N`（16–64，默认 32）调熵；`--peer-id` / `--endpoint` 只是写进 stderr 提示里
  帮你记，不影响 token 本身。
- **token 是 secret**：走安全信道（密管 / 加密消息）交给 org B 的管理员，**不要**提交进
  git、不要贴公开频道。

> 谁铸不重要——联邦对称，A 铸或 B 铸都行，关键是**同一个字符串两边各登记一次**。

### Step 2 — 暴露 ws 端点（两机）

确保对方能拨到你的 `AIPE_WS_PORT`：

- 生产建议：反向代理把 `wss://hub-a.example.com/` 终止 TLS → 转发到本机
  `127.0.0.1:4000`，并设 `AIPE_TRUST_PROXY=1`。
- 防火墙放行对方源 IP 到该端口。
- 自检：从对方机器 `curl -i http://<你的ws主机>:4000/`（或 `wscat`）能连上即可——
  HELLO 握手由 hub 自己做，这步只验网络可达。

### Step 3 — 双边登记 peer（对称，各一次）

两种入口，等价（admin UI 底层就是调这些 API）：

- **管理 UI**：登录 owner → 「联邦」tab → peer onboarding 面板（`#peer-admin-panel`）→
  「添加 peer」，填 peerId / endpointUrl / peerToken + per-link 契约。
- **API**：`POST /api/admin/identity/peers`（owner 鉴权）。

**A 机**（出站到 org B）请求体：

```json
POST /api/admin/identity/peers
{
  "peerId":      "org-b",
  "endpointUrl": "wss://hub-b.example.com:4000",
  "label":       "Organization B (prod)",
  "peerToken":   "<Step 1 铸的同一个 token>",
  "outboundCaps": ["legal.contract-review"],
  "requireApprovalOutbound": true
}
```

**B 机**（入站接受 org A）镜像登记同一个 token：

```json
POST /api/admin/identity/peers
{
  "peerId":      "org-a",
  "endpointUrl": "wss://hub-a.example.com:4000",
  "label":       "Organization A (prod)",
  "peerToken":   "<同一个 token>",
  "acl": { "capabilities": ["legal.contract-review"] }
}
```

要点：

- **`peerToken` 是 write-only**：写入即加密进 vault，任何 GET 响应里都**不回**它。改 token
  就 PATCH 一次新值。
- **`endpointUrl` 指对方**：A 机填 B 的 ws 地址，B 机填 A 的。
- 在「联邦」面板把 peer **启用**（lifecycle：enable / revoke / delete）。

### Step 4 — 配 per-link 信任契约

这些字段在 POST / PATCH `/api/admin/identity/peers[/:id]` 上，也在「联邦」面板的 per-link
契约编辑器里。**全是 per-link 的，互不外溢。**

| 字段 | 类型 | 语义 / 默认 |
|---|---|---|
| `acl` | `{capabilities?, requireOrigin?, requireOriginRole?}` \| `null` | **入站** ACL。`null` = 接受全部入站能力；设 `capabilities` 白名单则只放行这些。`requireOrigin` 要求带发起人。 |
| `outboundCaps` | `string[]` \| `null` | **出站**能力白名单。`null` = **不放任何东西出站**（fail-closed）；`[]` 同样锁死；列出的能力既被**通告**给本侧工作流（能路由到 peer）也被**授权**外发——通告=授权。 |
| `requireApprovalOutbound` | `boolean` | 出站命中时**挂起到 owner 的 `/me` 收件箱**，批准后才真的过 socket。敏感外发务必开。 |
| `allowedDataClasses` | `string[]` \| `null` | 出站任务允许携带的数据类。`null` = 全允许；`[]` = 锁死。按节点 `dataClasses` 在出站闸判。 |
| `perLinkQuotaBudget` | `number` \| `null` | 每 `AIPE_PEER_LINK_QUOTA_WINDOW_MS` 窗口的**入站**任务上限。`null` = 不限。越界 fail-closed。 |
| `allowedKnowledgeBases` | `string[]` \| `null` | 对方可调用的共享 KB（MCP server 名）白名单。`null` = 全部共享的可调；`[]` = 锁死。 |
| `revocationState` | `'active'` \| `'revoked'` | 撤销开关。设 `revoked` → 拆链 + 拒入站 + 线缆层拒，三闸齐落。**不会**被清成 null。 |
| `shareSummary` | `boolean` | opt-in 把**隐私安全的计数摘要**（资产/活动/健康，永不原始行）经 `peer.summary` RPC 共享给对方控制面。默认关。 |
| `shareTranscript` | `boolean` | opt-in 把跨 hub 步骤的 transcript 切片经 `peer.transcript` RPC 共享，让对方运行详情能看到这一步在你这边的轨迹。默认关。 |

**最小权限起步**：`outboundCaps` 只列真要用的那几个能力；敏感外发开
`requireApprovalOutbound`；不确定就 `null`（= 锁死 / fail-closed），按需放开。

### Step 5 — 验证链路 up

- `GET /api/admin/identity/peers` → 找到该 peer，看 `connected: true`、`backoffAttempts: 0`。
- 「联邦」tab 应显示 peer 在线。
- 刷一次能力发现：`POST /api/admin/peer-manifests/refresh` 然后
  `GET /api/admin/peer-manifests` → 该 peer 的 `online: true` + `capabilities` 列出
  org B 通告的（受 `outboundCaps` 策划的）能力，比如 `legal.contract-review`。

链路不通的排查见 §4。

### Step 6 — 跑一条跨 hub 工作流（在 A 机）

在 org A 导入一个工作流，其中某一步派一个**只有 org B 提供**的能力。YAML **不点名 peer**——
就是普通 capability dispatch：

```yaml
schema: aipehub.workflow/v1
workflow:
  id: cross-org-contract-review
  trigger: { capability: legal:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [legal.contract-review] }  # 住在 org B
        payload: { doc: $trigger.payload.doc }
    - id: archive
      dispatch:
        strategy: { kind: capability, capabilities: [legal.archive] }           # 本地
        payload: { doc: $trigger.payload.doc, verdict: $review.output.verdict }
```

导入 → 发布 → 触发（admin UI 工作流面板「开始」，或派 `legal:start`）。因为 Step 4 开了
`requireApprovalOutbound`，run 会**挂起在出站审批闸**——此刻**没有任何帧过 socket**，org B
还不知情。admin 运行详情会把这一步标成「⏸ 等待你批准 — 出站到对等 hub org-b」并给收件箱深链。

### Step 7 — 从 `/me` 收件箱批准（owner）

owner 打开 `/me` → 收件箱 → 看到一条 approval 待办「批准把出站任务发给对端 org-b?」→
**批准**。这一刻任务才真的过 socket 到 org B → org B 跑它的 `legal.contract-review` →
裁决经 ws 回流当作 `review` 步输出 → 本地 `archive` 步归档 → 工作流完成。

**拒绝**则 fail-closed：org B 永不被联系，socket 上零帧，本地 archive 步不执行。

### Step 8 — 在控制面观察

- **能力发现**：`GET /api/admin/peer-manifests` —— 对方通告了哪些能力、在线/陈旧。
- **footprint 控制面**（需对方 `shareSummary: true`）：`GET /api/admin/peer-summaries` ——
  本地 + 各 peer 的隐私安全计数（资产/活动/健康，**永不**原始行）。
- **趋势 + 告警**（v5 F）：`GET /api/admin/peer-summaries/history?source=&metric=` 画时间轴；
  `GET /api/admin/peer-summary-alerts` 看越线，`POST /api/admin/peer-summary-alerts/rules`
  配阈值。「控制面」UI 有 sparkline + 告警徽章。
- **用量归属**：跨 hub 调用在 `usage_ledger` 带 `peer_id`，admin「用量」可按「联邦对端」维度汇总。

---

## 3. 安全清单

- [ ] **token 走安全信道**，写入即加密进 vault，从不回显；轮换就 PATCH 新值。
- [ ] 跨公网**只用 `wss://`**；坐反代后设 `AIPE_TRUST_PROXY=1`，防火墙按源 IP 收口。
- [ ] **`outboundCaps` 最小化**——只列真要用的能力；`null`/`[]` = 锁死。
- [ ] **敏感外发开 `requireApprovalOutbound`**——人在环，owner 收件箱拍板。
- [ ] **`allowedDataClasses` 收口**敏感数据类，按节点判。
- [ ] **`perLinkQuotaBudget`** 给入站封顶，防被对方刷爆。
- [ ] 入站限流 `AIPE_PEER_INBOUND_RATE_MAX` 别设太大（默认 60/分钟够防爆破）。
- [ ] 出问题或终止合作：把 peer 的 `revocationState` 设 `revoked`（三闸齐落），或直接 delete。
- [ ] `shareSummary` / `shareTranscript` 默认关——只在你愿意让对方控制面看到计数 / 轨迹时才开。

---

## 4. 故障排查

| 症状 | 多半原因 / 处理 |
|---|---|
| `GET …/peers` 一直 `connected: false`、`backoffAttempts` 涨 | endpoint 不可达：核 `endpointUrl`（对方 ws 主机 + `AIPE_WS_PORT`）、防火墙、TLS 证书。从本机 `curl`/`wscat` 对方端点验网络。 |
| 握手被关、日志 `closed during handshake` / `peer_disconnected` | **token 不符**（两边不是同一个字符串）或 `expectedPeerId` 对不上。注意：拒绝方**不回失败原因**（anti-enumeration），拨号方只看到「链接被关」——去**被拨**那侧的日志看精确原因。重新对齐 token（Step 1/3）。 |
| 工作流步骤报 `no_participant` / 选不中 peer | org B 没通告该能力：检查 B 侧没把它放进可达能力集、A 侧 `outboundCaps` 没列它（通告=授权，没列就既不通告也不授权）。`peer-manifests/refresh` 后再看。 |
| 出站报 `outbound_capability_denied:<cap>` | 该能力不在 A 侧 `outboundCaps` 白名单——加进去（Step 4）。 |
| 入站被拒、对方报配额 | 命中 `perLinkQuotaBudget`：调大额度或加宽 `AIPE_PEER_LINK_QUOTA_WINDOW_MS`。 |
| run 一直挂着不动 | 大概率是出站审批闸在等人批：owner 去 `/me` 收件箱（Step 7）。admin 运行详情的琥珀「等待你批准」徽章 + 深链能直接跳过去。 |
| 改了 peer 记录没生效 | 出站拨号按 `AIPE_PEER_POLL_MS`（默认 5s）tick；最迟下一拍生效。撤销/契约变更即时穿三个 install 点。 |

---

## 5. 对应的 example 与验收门

本 runbook 的每一条主张，代码里都有对应的可跑物料 / 自动化验收门把守：

| 想验证 | 跑什么 / 看哪 |
|---|---|
| 整条故事（握手 + 审批 + 跨 socket + 错 token 拒） | `pnpm demo:cross-hub-federation`（`examples/cross-hub-federation/`，确定性自断言） |
| 跨 hub 工作流 + 出站审批闸过真 ws | `packages/host/tests/cross-hub-workflow-ws-e2e.test.ts`（approve / reject / no-approval） |
| transcript chain 过真 ws + opt-in 闸 | `packages/host/tests/cross-hub-transcript-chain-ws-e2e.test.ts` |
| 断链 + 重拨韧性（挂起不丢、重拨后批准跑完） | `packages/host/tests/cross-hub-redial-resilience-e2e.test.ts` |
| 多组织隔离（夹紧一条不外溢） | `packages/host/tests/peer-isolation-ws-e2e.test.ts` |

---

## 6. 延伸阅读

- [`V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md) — peer onboarding 的安全模型 + CLI/UI 由来。
- [`V4-PHASE18-FINAL.md`](V4-PHASE18-FINAL.md) — 联邦能力 manifest + 入站 ACL + 出站审批闸 + A2A。
- [`V4-PHASE19-P4-FINAL.md`](V4-PHASE19-P4-FINAL.md) — per-link data-class / 配额 / 撤销契约。
- [`V5-G-FINAL.md`](V5-G-FINAL.md) — 跨 hub 工作流编排（北极星第 2 层；通告=授权 + 两步恢复 + 三不变量）。
- [`V5-E5-FINAL.md`](V5-E5-FINAL.md) / [`V5-F-FINAL.md`](V5-F-FINAL.md) — 控制面摘要 + 历史趋势 + 告警。
