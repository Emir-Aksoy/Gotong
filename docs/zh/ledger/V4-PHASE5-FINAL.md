# v4 Phase 5 收尾

> Status: **完成**。23 个 commits,15 个模块,无回归,无 P1/P2 安全洞,
> 1844 个单测全过(+2 LLM provider 集成跳过,要网络凭据)。
>
> Last updated: 2026-05-25
>
> 本文是 Phase 5 的 release-notes / hand-off 文档。读完应该能:
>   - 知道 Phase 5 加了什么 + 没加什么
>   - 知道每个新 feature 在代码 / docs 里的入口
>   - 把 Phase 6 的 backlog 接续起来
>
> **GitHub 状态**:本次 Phase 5 全部 commit **未 push**(操作员明确
> 要求"github 额度超了"),本地 `main` 分支领先 origin 47 commits。
> 后续解禁后一次 push,无需 squash(每个 commit 都是有意义的小步)。

---

## 一、commit 时序

按写入顺序,共 23 个 commit:

| # | sha | 内容 |
|---|---|---|
| 1 | `5429f45` | feat(identity): vault — AES-256-GCM 加密凭证存储 (A1) |
| 2 | `97c12c1` | feat(identity): AUDIT_ACTIONS 枚举 + 类型化 audit helpers (A2.1) |
| 3 | `84d2c4a` | refactor(identity): 删 v3-admin 兼容层 (A2.2) |
| 4 | `633dbf6` | feat(services-sdk): OwnerKind 扩 user/org/peer (A3) |
| 5 | `773fa59` | feat(host): OrgApiPool — vault 读 org-owned LLM keys (B1.1) |
| 6 | `24c2a10` | feat(host): LocalAgentPool 走 OrgApiPool 解 LLM key (B1.2) |
| 7 | `6475849` | feat(identity): usage_counters 表 + quota API (B2.1) |
| 8 | `1184d77` | feat(llm,host): LlmAgent preCallHook + quota gate factory (B2.2) |
| 9 | `0a6f551` | feat(host,workflow,web): 接 org LLM quota gate 端到端 (B2.2.2) |
| 10 | `2afdd46` | feat(identity,host): 周期性 usage sweep (B2.3) |
| 11 | `9acdc2c` | docs(rag): RAG via MCP 设计 + 决议 (B3+B4) |
| 12 | `3bdb3ff` | feat(web): 统一 SPA shell + role-aware tabs (C1.1) |
| 13 | `82dcf2a` | feat(web): first-time setup wizard (A2.3 / C1.2) |
| 14 | `4b5f338` | refactor(web): 删 /me legacy surface (C1.3) |
| 15 | `eff683c` | feat(identity): peers 表 + CRUD APIs (D1.1) |
| 16 | `82ec208` | feat(host,web,core,transport-ws): peer registry + admin routes (D1.2) |
| 17 | `2480ae5` | feat(identity,host): per-org soft caps + 80/100% warnings (E1) |
| 18 | `1c51866` | feat(core,host): 跨 hub HITL 路由 + 软 timeout (D2) |
| 19 | `b9b2169` | docs(rag): 跨 hub knowledge 推迟到共享 MCP server (D3) |
| 20 | `ac9b782` | feat(web): 组织配额管理 UI (C2) |
| 21 | `63e6221` | docs(reputation): E2 routing — done by M5b+D1 composition |
| 22 | `a12a66e` | docs(audit): v4 Phase 5 全量审计 (F1) |
| 23 | `a0275d9` | docs(examples): v4 Phase 5 demo recipes (F2) |
| 24 | (this) | docs: V4-PHASE5-FINAL.md (F3) |

代码量:**59 files changed, +11605 / -808**。

---

## 二、新增 + 修改的关键资产

### 新表

| schema 版本 | 表 | 用途 |
|---|---|---|
| v=4 | `vault` | A1 — 应用层加密凭证(LLM provider key / MCP token / peer-mutual token) |
| v=5 | `usage_counters` | B2.1 — per-(user, metric, period) 累计 + 软上限 cap |
| v=6 | `peers` | D1.1 — 动态 peer 拓扑(endpoint / label / enabled flag + 软 FK 到 vault) |
| v=7 | `org_quotas` | E1 — per-(metric, period) 组织软上限 + last_state |

每个 migration 都附带详细的 schema 注释,解释 PK 选择 / FK 决定 /
nullable rationale,见 `packages/identity/src/schema.ts`。

### 新 IdentityStore APIs

```
vault:        createVaultEntry / readVaultSecret / listVaultEntries /
              revokeVaultEntry
usage:        setQuota / listUsage / checkAndIncrement / resetUsage /
              sweepUsageCounters
peers:        addPeer / getPeer / getPeerByPeerId / listPeers /
              updatePeer / removePeer / getPeerToken
orgQuotas:    setOrgQuota / getOrgQuota / listOrgQuotas /
              deleteOrgQuota / sumUsage / checkOrgQuotaThreshold
```

每个都有完整 JSDoc 解释 + 错误码契约,见
`packages/identity/src/store.ts`。

### 新 Hub 钩子

```
HubConfig.crossHubResolver  — D2 cross-hub explicit dispatch
DefaultScheduler 同名参数    — 4th 构造参数,可选
```

`@gotong/core` 暴露的新 type:`CrossHubExplicitResolver` +
`CrossHubDispatcher`。

### 新 host 子系统

```
packages/host/src/
├── org-api-pool.ts        — B1 OrgApiPool
├── peer-registry.ts       — D1 PeerRegistry(包括 inbound accept /
│                            outbound dial / 5s reconcile / backoff
│                            ladder / linkForHub for D2)
└── main.ts(改动)
    ├── usageSweepTimer    — B2.3 1h tick
    ├── orgQuotaSweepTimer — E1 1h tick + state transition audit
    └── PeerRegistry wire-up + crossHubResolver hook
```

### 新 web admin 路由

```
GET    /api/setup/needs-bootstrap            (anonymous;loopback-only)
POST   /api/setup/owner-password             (loopback-only;A2.3)
GET    /api/admin/identity/peers             (D1.2)
POST   /api/admin/identity/peers             (D1.2)
PATCH  /api/admin/identity/peers/:id         (D1.2)
DELETE /api/admin/identity/peers/:id         (D1.2)
GET    /api/admin/identity/org-quotas        (E1 + C2)
POST   /api/admin/identity/org-quotas        (E1 + C2)
DELETE /api/admin/identity/org-quotas/:metric/:period
```

### 新 SPA 资源

```
packages/web/static/
├── app.html              — 统一 SPA shell(取代 admin.html + me.html)
├── app.js                — orchestrator(role meta + setup wizard + home tab)
├── quotas-ui.js          — C2 配额管理面板
└── (deleted) admin.html, me.html, me.js
```

### 新文档

```
docs/zh/
├── RAG-VIA-MCP.md            — B3/B4/D3 设计决议
├── REPUTATION-ROUTING.md     — E2 done-by-composition 说明
├── AUDIT-v4-phase5.md        — F1 全量安全审计
├── EXAMPLES-V4-PHASE5.md     — F2 demo recipes 速查
└── V4-PHASE5-FINAL.md        — 本文 F3
```

---

## 三、Phase 5 的"小巧"哲学(回顾)

**没做的事**(都是清醒拒绝,不是漏):

1. **knowledge service** — RAG 走 MCP,不在 gotong 写。
2. **跨 hub knowledge ACL** — 走 MCP server 自身权限,不在 gotong。
3. **sparkline 历史图** — usage 不持久化历史(sweep 直接 roll),需要
   新时间序列表,不值当。
4. **reputation admin UI** — 只读 dashboard,cat 文件即可,延后。
5. **per-capability reputation 拆分** — EWMA 切碎抖动反而差,保持总分。
6. **D2 跨 hub task 撤销** — 软 timeout 已经够;真撤销要协议扩展,
   占用 risk 可接受。
7. **personal-rag / org-handbook example dir** — agent json 一行配置
   就行,docs 速查表更清楚。
8. **org cap 硬阻断** — 软上限刻意,操作员要硬阻断用 per-user sum-up。

---

## 四、env vars 新增

| 变量 | 默认 | 作用 |
|---|---|---|
| `GOTONG_PEER_POLL_MS` | 5000 | D1 PeerRegistry tick 间隔 |
| `GOTONG_PEER_INBOUND_TOKEN` | (空) | D1 入方共享 HELLO secret |
| `GOTONG_PEERS_DISABLED` | — | 设 `1` 跳过 PeerRegistry 启动 |
| `GOTONG_HITL_TIMEOUT_MS` | 300000 | D2 HITL 软 timeout(5min),0 = 关 |

每个变量在第一次使用代码段都有解释注释。

---

## 五、Phase 6 backlog(优先级排)

从 F1 audit 的 §"已知非阻塞 limitation"摘抄,加少量 phase-5 期间冒
出来的新想法:

| # | 项 | 估时 | 类别 |
|---|---|---|---|
| 1 | reputation admin UI 只读 dashboard | ~2h | UI |
| 2 | LLM provider 返 401 自动 revoke vault entry | ~3h | 容错 |
| 3 | per-org OrgApiPool 分流(host=多 org) | ~4h | 多租户 |
| 4 | inbound peer per-peer token(替代 shared) | ~3h | 安全 |
| 5 | cross-hub task 撤销协议 | ~8h | 协议 |
| 6 | 严格 CSP(去 inline handler) | ~6h | 安全 |
| 7 | per-capability reputation 拆分 | ~6h | routing |
| 8 | growthReports list 接口下沉 caseId filter | ~3h | 性能 |
| 9 | invitations 总数硬上限 | ~2h | DoS |
| 10 | usage 时间序列表 + sparkline | ~6h | UI / 数据 |
| 11 | quotas-ui:bulk edit / 历史告警 | ~4h | UI |
| 12 | PeerRegistry inbound accept 加 rate limit | ~2h | 安全 |
| 13 | identity bootstrap 支持外部 KMS 包 master.key | ~10h | 安全/集成 |

**总估时**:~60h(顶 1.5 周专职);可以分批进 Phase 6 的多个小迭代。

---

## 六、验证清单(F3 release gate)

- [x] `pnpm -r build` clean (19 packages)
- [x] `pnpm -r test`  clean (1844 passed + 2 skipped + 0 failed)
- [x] git status clean
- [x] git log 23 个 commit 每个都有 conventional commit format
- [x] 无新 P1/P2 安全洞(F1 闭环)
- [x] 4 个新表的 migration 都加 schema 注释
- [x] 4 个新 env var 都在 V4-PHASE5-FINAL.md 列表
- [x] 5 个新 docs 文件覆盖所有重大决策
- [x] (本地)main 领先 origin 47 commit;未 push(GitHub 限制)

---

## 七、最关键的 5 个 cherry-pick(给 reviewer / hand-off)

如果只读 5 个文件就要理解 Phase 5 整体,顺序是:

1. **`packages/identity/src/schema.ts`** — 4 个新表的 migration 注释,
   每条 PK/FK/INDEX 都解释为什么。读完知道整个数据模型。
2. **`docs/zh/RAG-VIA-MCP.md`** — B3/B4/D3 的决议:为什么不在
   gotong 写 knowledge subsystem,以及怎么用 MCP server 替代。
   读完知道 RAG 全栈思路。
3. **`packages/host/src/peer-registry.ts`** — D1 PeerRegistry,从持久
   化的 peer 表派生活的 HubLink 集。读完知道 federation 启停 + 重连
   语义。
4. **`packages/core/src/scheduler.ts`**(D2 部分) +
   **`packages/host/src/main.ts`** crossHubResolver wire-up — D2 跨
   hub HITL 的最小集成模式:scheduler 不依赖任何 transport / link 类
   型,host 用 closure 桥接 PeerRegistry。读完知道核心 vs 集成的分层
   决策。
5. **`docs/zh/ledger/AUDIT-v4-phase5.md`** — F1 全量 audit 的总览矩阵 + 4 个
   高优先级 called-out concern。读完知道安全 baseline。

---

## 八、给下一位维护者

**Phase 5 是个相对小的 phase**(对比 Phase 4 的 federation):没有
新 protocol,没有新的 hub-level 抽象,主要是把"identity / quota /
peer registry"几个独立子系统从代码上各自完整化、UI 上接出来。

**心智上要注意**:
- v4 identity 现在是**唯一**的用户身份源(`createUser/listUsers/
  setRole`),v3 admin token 只是 host-only 操作的 backwards-compat
  flap,不会再扩。
- vault 是**唯一**的应用层加密凭证存储,新 secret kind 添加进
  `VaultKind` enum 后,创建 / 读取 / 撤销三件套自动支持。
- peer 拓扑是**动态**的(不要再 hardcode env var connect list),改
  peer 配置走 admin UI 的"Peers" tab 或直接 `identity.addPeer/...`。
- quota 系统是**两层**:per-user 硬 cap(B2.1)+ per-org 软 cap(E1)。
  跑代码前先想清楚是哪一层。
- cross-hub explicit dispatch 走 **task.origin.orgId** 判定,而不是
  解析 participant id 里的 hub 前缀。orgId 是 federation 的 ground truth。

**Phase 6 第一步建议**:挑 backlog #1(reputation UI)起手,体量小、
端到端可看到效果,适合验证整个 dev flow 没退化。

---

**END Phase 5**。
