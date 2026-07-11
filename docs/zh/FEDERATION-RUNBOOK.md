# 跨组织联邦 — 两机操作员 runbook

> 把两台**不同机器上**的 Gotong（org A 与 org B）通过真 WebSocket 连成联邦，让
> 一个 hub 的工作流能编排另一个 hub 的能力——而**凭证 / 数据 / 计费各归各家**。这是
> 北极星 **第 2 层「跨组织协作」** 的上线手册：面向运维人员，从铸 token 到看见跨 hub
> 工作流跑通，一步一步。
>
> 想先在一个进程里看清机制？跑 `pnpm demo:cross-hub-federation`
> （`examples/cross-hub-federation/`）——两个真 hub 过真 ws + bearer auth，确定性、无 key。
> 本文是把那个 demo 拆到两台真机器上。
>
> English version: [`docs/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md)
>
> Last updated: 2026-06-06

---

## 0. 心智模型（先读这 4 条）

1. **联邦是对称的，一个 token 两边各登记一次。** 不是「客户端 / 服务端」——两边都是
   主权 hub。org A 铸一个 token，两台机器各把**同一个字符串**登记进自己的 peer 记录：
   org A 用它出站到 org B，org B 用它验证「期望 org A 出示」的凭证。

2. **endpoint = 对方的 ws 地址。** 每一侧 peer 记录里的 `endpointUrl` 指向**对方** hub
   可达的 WebSocket 端点（`wss://partner.example.com:4000` 或反代后的 `wss://…/`）。联邦
   端口跟远程 agent 共用同一个 `GOTONG_WS_PORT`（默认 4000）——HELLO 帧自己分流。

3. **框架不替你做信任决策。** 链路只是管子。能放什么能力出站（`outboundCaps`）、要不
   要人工批准（`requireApprovalOutbound`）、能带什么数据类（`allowedDataClasses`）、每窗口
   多少配额（`perLinkQuotaBudget`）——全是你在 peer 记录上**显式**配的 per-link 契约，
   默认 fail-closed。

4. **自由图，不是层级树。** org A 连 org B **不等于** org A 拥有 org B。每条链路是一份
   双边契约；撤销、配额、数据类都是 per-link 的，互不外溢。

> 安全模型的「为什么」（token 写入即加密进 vault、对称登记、撤销语义）见
> [`V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](./ledger/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md)；
> per-link data-class / 配额 / 撤销的设计见
> [`V4-PHASE19-P4-FINAL.md`](./ledger/V4-PHASE19-P4-FINAL.md)。本文不重复那些，只讲操作。

---

## 1. 前置条件

两台机器各自：

- 跑起生产 host（`gotong-host`，即 `@gotong/host` 的 bin；源码仓里用 `pnpm host`），
  **接了 identity store**（联邦记录住在 identity 的 `peers` 表 + vault）。如何本地起一个
  带 identity 的生产 host，见 [`DEPLOY.md`](DEPLOY.md)。
- 有一个 **owner** 账号（peer CRUD 与出站审批都需要 owner 权限）。
- 网络互通：org B 的机器能拨到 org A 暴露的 ws 端点，反之亦然（双向，因为联邦对称）。
- **强烈建议 TLS**：跨公网时用 `wss://`（反向代理 Caddy / nginx 终止 TLS → 转发到本机
  `GOTONG_WS_PORT`）。明文 `ws://` 只在可信内网 / 同机演示用。

相关环境变量（host 侧，`gotong-host` 读）：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `GOTONG_HOST` | `127.0.0.1` | HTTP 与 ws 服务器绑定地址。公网暴露要设成 `0.0.0.0` 或具体网卡（建议只让反代连本机，hub 仍绑 `127.0.0.1`）。 |
| `GOTONG_WS_PORT` | `4000` | WebSocket 端口——**远程 agent 与入站 peer HELLO 共用**。这就是对方 `endpointUrl` 要指的端口。 |
| `GOTONG_WEB_PORT` | `3000` | 管理 UI + API（owner 在这上面配 peer、批审批）。**不要**把这个端口当 peer endpoint。 |
| `GOTONG_PEERS_DISABLED` | （未设） | 设 `1` 彻底关掉联邦（既不出站拨号也不接受入站）。 |
| `GOTONG_PEER_POLL_MS` | `5000` | 出站拨号重连 tick（ms）。改了 peer 记录后，最迟下一个 tick 生效。 |
| `GOTONG_TRUST_PROXY` | （未设） | 设 `1` 让入站限流读 `X-Forwarded-For`——**只在 hub 真的坐在反向代理后面时设**。 |
| `GOTONG_PEER_INBOUND_RATE_MAX` | `60` | 每 IP 每窗口最大 HELLO 次数（防 token 爆破）。 |
| `GOTONG_PEER_INBOUND_RATE_WINDOW_MS` | `60000` | 上面那个限流窗口（ms）。 |
| `GOTONG_PEER_LINK_QUOTA_WINDOW_MS` | `60000` | per-link 入站配额计数窗口（ms）；配额额度本身在 peer 记录的 `perLinkQuotaBudget`。 |

---

## 2. 步骤

下面以 **org A 发起、编排 org B 的一个能力**为主线。联邦对称，所以两边的登记动作镜像
对称——文中标 “「A 机」/「B 机」” 区分。

### Step 0（可选）— 先看对方名片（NET-M5 发现 preflight）

```bash
gotong peer-card https://hub-b.example.com
```

换 token 之前想先知道「对方是谁 / 怎么认证 / 登了什么能力」，用这条只读命令取对方的
A2A agent card（`/.well-known/agent-card.json`）翻成人话。**发现 ≠ 信任**：看名片永不
建边；对端没挂名片（404）也不影响——名片是增强不是前置，照 Step 1-3 直连即可。

### Step 1 — 铸 token（在 A 机，一次）

```bash
gotong mint-peer-token --peer-id=org-b --endpoint=wss://hub-b.example.com:4000
```

- 输出：**一行 256-bit base64url token** 打到 **stdout**（可 `> token.txt` / 管道）；一段
  中文配对提示打到 **stderr**（不污染 stdout）。
- `--bytes=N`（16–64，默认 32）调熵；`--peer-id` / `--endpoint` 只是写进 stderr 提示里
  帮你记，不影响 token 本身。
- **token 是 secret**：走安全信道（密管 / 加密消息）交给 org B 的管理员，**不要**提交进
  git、不要贴公开频道。

> 谁铸不重要——联邦对称，A 铸或 B 铸都行，关键是**同一个字符串两边各登记一次**。

### Step 2 — 暴露 ws 端点（两机）

确保对方能拨到你的 `GOTONG_WS_PORT`：

- 生产建议：反向代理把 `wss://hub-a.example.com/` 终止 TLS → 转发到本机
  `127.0.0.1:4000`，并设 `GOTONG_TRUST_PROXY=1`。
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
| `perLinkQuotaBudget` | `number` \| `null` | 每 `GOTONG_PEER_LINK_QUOTA_WINDOW_MS` 窗口的**入站**任务上限。`null` = 不限。越界 fail-closed。 |
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
schema: gotong.workflow/v1
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

### 变体 — 管家出网（成员对话驱动，NET-M2/M3）

上面 Step 6–7 的驱动方是工作流；同一条边也能由**成员对管家的一句大白话**驱动：

```
成员(IM)> 帮我问一下爸爸的 hub 今晚有没有空。
管家    > （ask_peer 停进成员自己的 /me —— 未批前零字节出网）
成员批准 ✅
管家    > 对端「hub-dad(爸爸的 hub)」回复:有空,回来吃饭。
```

- **前提**：Step 4 里这条边已策展 `outboundCaps`（**只有策展过的边可问**——
  未策展边管家会当场诚实拒绝并指路；这不是限制而是事实：跨 hub 寻址只有
  capability 一条路，未策展的边路由不出去）+ 对端有服务该能力的参与者 +
  本侧管家 governed 面开着（`GOTONG_BUTLER_GOVERNED` 默认开）。
- **两道闸各守其主**：成员闸（「我真的要发这句话吗」，停成员自己的 `/me`）
  永远在前；这条边若还开了 `requireApprovalOutbound`，owner 闸照常在后、
  不可绕——成员批完 owner 闸又停时，管家如实说「还差 hub 管理员一道」。
- **双闸场景的最终答案回传——显式推迟（NET-M3 决定）**：owner 批准后任务
  照常送达对端并执行完（transcript 有记录、owner 的批准响应里有结果），但
  该结果**当前不会自动回推给原提问成员**。一步到位需要给「owner 批准的
  结果按 task.from 回推成员 IM」开一条新缝，按「复用既有缝优先、新缝最小」
  纪律首版不开；日常用法是给管家常问的边**不开** `requireApprovalOutbound`
  （成员闸已经挡了一道），需要 owner 双闸的高敏边则由 owner 转达结果。
- 成员先问管家「咱们连着谁」（`list_peers`，NET-M1）就能看到每条边的
  出站姿态：未策展 / 锁死 / 可请求能力列表。
- 单机看肌理：`pnpm demo:butler-cross-hub`（[`examples/butler-cross-hub`](../../examples/butler-cross-hub)）。

---

## 3. 安全清单

- [ ] **token 走安全信道**，写入即加密进 vault，从不回显；轮换就 PATCH 新值。
- [ ] 跨公网**只用 `wss://`**；坐反代后设 `GOTONG_TRUST_PROXY=1`，防火墙按源 IP 收口。
- [ ] **`outboundCaps` 最小化**——只列真要用的能力；`null`/`[]` = 锁死。
- [ ] **敏感外发开 `requireApprovalOutbound`**——人在环，owner 收件箱拍板。
- [ ] **`allowedDataClasses` 收口**敏感数据类，按节点判。
- [ ] **`perLinkQuotaBudget`** 给入站封顶，防被对方刷爆。
- [ ] 入站限流 `GOTONG_PEER_INBOUND_RATE_MAX` 别设太大（默认 60/分钟够防爆破）。
- [ ] 出问题或终止合作：把 peer 的 `revocationState` 设 `revoked`（三闸齐落），或直接 delete。
- [ ] `shareSummary` / `shareTranscript` 默认关——只在你愿意让对方控制面看到计数 / 轨迹时才开。

---

## 4. 故障排查

| 症状 | 多半原因 / 处理 |
|---|---|
| `GET …/peers` 一直 `connected: false`、`backoffAttempts` 涨 | endpoint 不可达：核 `endpointUrl`（对方 ws 主机 + `GOTONG_WS_PORT`）、防火墙、TLS 证书。从本机 `curl`/`wscat` 对方端点验网络。 |
| 握手被关、日志 `closed during handshake` / `peer_disconnected` | **token 不符**（两边不是同一个字符串）或 `expectedPeerId` 对不上。注意：拒绝方**不回失败原因**（anti-enumeration），拨号方只看到「链接被关」——去**被拨**那侧的日志看精确原因。重新对齐 token（Step 1/3）。 |
| 工作流步骤报 `no_participant` / 选不中 peer | org B 没通告该能力：检查 B 侧没把它放进可达能力集、A 侧 `outboundCaps` 没列它（通告=授权，没列就既不通告也不授权）。`peer-manifests/refresh` 后再看。 |
| 出站报 `outbound_capability_denied:<cap>` | 该能力不在 A 侧 `outboundCaps` 白名单——加进去（Step 4）。 |
| 入站被拒、对方报配额 | 命中 `perLinkQuotaBudget`：调大额度或加宽 `GOTONG_PEER_LINK_QUOTA_WINDOW_MS`。 |
| run 一直挂着不动 | 大概率是出站审批闸在等人批：owner 去 `/me` 收件箱（Step 7）。admin 运行详情的琥珀「等待你批准」徽章 + 深链能直接跳过去。 |
| 改了 peer 记录没生效 | 出站拨号按 `GOTONG_PEER_POLL_MS`（默认 5s）tick；最迟下一拍生效。撤销/契约变更即时穿三个 install 点。 |

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
| 管家出网（问 → 成员确认 → 跨界 → 答案回同轮 + 双闸顺序） | `pnpm demo:butler-cross-hub`（`examples/butler-cross-hub/`）+ `packages/host/tests/butler-ask-peer-e2e.test.ts`（双真 Hub 四场景） |
| **真·两进程整链（各自 vault/端口 + 工作流状态机 + 重启自愈，三拓扑）** | `pnpm check:cross-hub`（`scripts/test-cross-hub-e2e.mjs`，见下 §5.1） |

### 5.1 测试金字塔与 L3/L4「真·两进程」门（`pnpm check:cross-hub`）

上面那些 `*-ws-e2e` 测试都是 **L2**：两个真 `Hub` 对象过一个真 `WebSocketServer`，
但两个 Hub 跑在**同一个 Node 进程、共享内存**。它们证明了联邦「逻辑」，却证明不了
真实部署形态——两个独立进程、各自独立的 `GOTONG_SPACE`、各自加密 vault、真占两个端口、
其中一个断电重启后从磁盘恢复 peer 记录并自动重拨。`scripts/test-cross-hub-e2e.mjs`
补的就是 **L3/L4**：驱动两个真的 `packages/host/dist/main.js`（生产二进制），五幕硬断言——

- **幕 A** 握手 + 派活 + 回传（能力解析到对端 wrapper，跨 socket 落到对端 agent，结果真回传）；
- **幕 D** 多组织隔离（未在 `outboundCaps` 授权的能力跨 hub 派活被拒，一条边的授权不外溢）；
- **幕 E** 跨 hub 工作流状态机：真 YAML 工作流的步落在对端——顺跑 `run=done` + 步 `output`
  真来自对端 + `executedBy=对端 id`；未授权能力步 `run=failed`（工作流层的隔离，不止裸派活层）；
- **幕 C** 重启自动重拨：重启**可控的那一侧**——重启 B 证 A 退避重拨自愈；只有 A 可控时重启 A
  证「本地电脑重启后从磁盘恢复 peer 行、开机自动重拨」；两侧都不可控则**显式 SKIP** 绝不静默；
- **幕 B** 出站审批闸（PATCH 边走面板同款 `refreshPolicy` 热重装，**不重启进程**）：裸派活
  park 到 owner 收件箱批准前零字节出门；工作流 run 停在 `running`+步 `status='suspended'`，
  批准后 `run=done`；再跑一发拒绝，`run=failed`+步错误 `outbound_approval_denied`。

工作流 run 的「通用状态」全谱因此都有硬断言：`done` / `failed`(无参与者) /
`running`+步`suspended`(挂起) / 批准续跑→`done` / 拒绝→`failed` / 对端宕机派活失败→重启自愈。

**三种拓扑，同一份脚本**（每侧独立 attach-or-spawn，`XHUB_X_URL` 设了就贴上已在跑的 hub）：

| 拓扑 | 怎么跑 | 覆盖的现实形态 |
|---|---|---|
| 本机双 spawn（默认，零变量） | `pnpm check:cross-hub` | L3 回归门；也即「**同一台 vps 上两个 hub**」（在那台 vps 上跑即是） |
| 双 attach | `XHUB_A_URL/TOKEN + XHUB_B_URL/TOKEN/WS_URL` | 「**不同 vps 之间**」（或同 vps 已跑的两个 systemd 实例）；脚本零 spawn 纯 HTTP 驱动 |
| A spawn × B attach | 只设 `XHUB_B_URL/TOKEN/WS_URL` | 「**本地电脑 × vps**」——A 主动拨出，本地在 NAT 后零入站端口也通 |

attach 侧要点：token 用该侧 owner 的 `aipk_` key；幕 C 在 attach 侧走可选命令钩子
`XHUB_X_STOP_CMD`/`XHUB_X_START_CMD`（如 `ssh vps 'systemctl stop/start gotong'`）或单条
`XHUB_X_RESTART_CMD`（只验重启后自愈）；脚本造的 peer 边 / mock agent / 工作流全带时间戳
唯一化，结束 **best-effort 删除并还原改过的开关**（复用已存在的边时要求它已授权 `xhub-review`，
且不动它的 token）。本机彩排 attach 拓扑：`XHUB_PROVISION=1 pnpm check:cross-hub` 起两台
驻留 host 并打印整套 attach 变量（也可当 L4 演练夹具）。

零真实 LLM：对端 worker 走 `provider: 'mock'`，回确定的 `[mock reply to: …]`，每幕都能硬断言。

> **这道门是靠自己挣来的**：写它的过程里，它一次性揪出两个 L2 结构性照不到的**真生产 bug**，
> 都已随本 track 修掉并各配防回归门——
> 1. **共享端口握手互杀**：生产 `main.ts` 让 agent 协议与联邦 mesh 共用一个 `GOTONG_WS_PORT`，
>    两个 `'connection'` 监听器都无 peek 地抢每个 socket；agent `Session` 先注册，把对端的
>    `MESH_HELLO` 当非法首帧 `terminate()`，真单端口联邦**从来没握手成功过**。修法=`serveWebSocket`
>    首帧 peek 分流（`MESH_HELLO`→mesh / 否则→agent Session），`routeMeshTo` opt-in 注册，未接
>    mesh acceptor 时字节不变。防回归：`packages/transport-ws/tests/shared-port-demux.test.ts`。
> 2. **重启重拨 participant 泄漏**：`PeerRegistry` 的 link `'closed'` handler 只 `installed.delete()`
>    没调 `install.uninstall()`，peer 死后 wrapper participant（稳定 peer hubId）在 hub registry
>    泄漏；下次重拨 `installPeerLink`→`hub.register()` 抛「already registered」，派活路由到死 wrapper
>    →`link_closed`，**联邦无法从 peer 重启恢复**。修法=抽 `onLinkClosed` 助手（带 `cur.link===link`
>    守卫 + `uninstall()`），出/入站两个 close handler 都走它，永不再各自漂移。防回归：幕 C 本身。

---

## 6. 延伸阅读

- [`V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](./ledger/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md) — peer onboarding 的安全模型 + CLI/UI 由来。
- [`V4-PHASE18-FINAL.md`](./ledger/V4-PHASE18-FINAL.md) — 联邦能力 manifest + 入站 ACL + 出站审批闸 + A2A。
- [`V4-PHASE19-P4-FINAL.md`](./ledger/V4-PHASE19-P4-FINAL.md) — per-link data-class / 配额 / 撤销契约。
- [`V5-G-FINAL.md`](./ledger/V5-G-FINAL.md) — 跨 hub 工作流编排（北极星第 2 层；通告=授权 + 两步恢复 + 三不变量）。
- [`V5-E5-FINAL.md`](./ledger/V5-E5-FINAL.md) / [`V5-F-FINAL.md`](./ledger/V5-F-FINAL.md) — 控制面摘要 + 历史趋势 + 告警。
