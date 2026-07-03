# v4 Phase 5 安全审计

> Status: 全部子模块在写代码时已遵循 Phase 3/4 既有的安全 baseline,
> 本文是闭环总览;无新发现的高危项(P1 / P2)需要紧急修复。
>
> Last updated: 2026-05-25
>
> 审计范围(v4 Phase 5 全部改动):
>   - **A1** vault 加密凭证存储 — `packages/identity/src/{crypto.ts,store.ts}`
>     vault 段 + schema v=4
>   - **A2.2/A2.3** 删 v3-admin 兼容 + setup wizard — `web/src/server.ts`
>     setup 路由 + `static/app.{html,js}` setup-wizard 段
>   - **A3** 统一 OwnerRef — `services-sdk/src/types/owner.ts` + 各 service
>     plugin 接入
>   - **B1.1/B1.2** OrgApiPool + LlmAgent resolveApiKey 改造 —
>     `host/src/org-api-pool.ts` + `local-agent-pool.ts` resolveApiKey
>   - **B2.1/B2.2/B2.2.2/B2.3** usage_counters + quota gate +
>     workflow runner origin 透传 + 后台 sweep — identity store usage 段 +
>     `host/src/main.ts` sweep timer + `workflow/src/runner.ts` origin stamp
>   - **B3/B4** RAG via MCP — `docs/zh/RAG-VIA-MCP.md`(决定不实现)
>   - **C1.1/C1.2/C1.3** 统一 SPA + setup wizard + 删 /me —
>     `web/static/app.{html,js}` + 删 `static/me.{html,js}` + `admin.html`
>   - **D1.1/D1.2** Peer Registry — `identity/src/store.ts` peers 段 +
>     `host/src/peer-registry.ts` + `web/src/identity-routes.ts` peer handlers
>   - **D2** 跨 hub HITL — `core/src/{scheduler.ts,hub.ts}`
>     crossHubResolver + `host/src/{main.ts,peer-registry.ts}` wire-up
>   - **D3** 跨 hub Knowledge — 取消(走共享 MCP server,见 RAG-VIA-MCP.md §6-bis)
>   - **E1** org soft quotas — identity store org-quotas 段 + `host/main.ts`
>     orgQuotaSweep + `web` org-quota handlers
>   - **E2** Reputation routing — done by M5b+D1 composition,见
>     `docs/zh/REPUTATION-ROUTING.md`
>
> 审计方法:每个子模块作者写完代码后,以 Phase 3 audit 文件的 10 个
> 维度(Auth / AuthZ / Input validation / SQL injection / Information
> disclosure / DoS / Race / Crypto / Logic / CSRF)在写代码同时 self-
> check。本文汇总每个模块的安全决策、剩余风险、未做项。

---

## 总览矩阵

| 模块 | 主要风险面 | 关键防御 | 测试 | 剩余风险 |
|---|---|---|---|---|
| **A1** vault | 加密凭证泄漏 / 弱密码恢复 | master.key 0o600 + AES-256-GCM + tag verify; 解密失败统一返回 `vault_decrypt_failed`(不区分 wrong-key vs tampered) | identity/tests/vault.test.ts 37 项 | master.key 备份策略外置 |
| **A2.2** 删 v3-admin | 兼容代码留 hole / 失效用户被审计漏 | rowToAuditLog clamp 未知 `actor_source` → 'system'; 旧 admin token surfaces 改走 IdentityStore | identity 全套 + web 路由测 | v3 token 永久兼容(host-only admin 操作不依赖 IdentityStore) |
| **A2.3** setup wizard | 任意人创建 owner | `/api/setup/owner-password` loopback-only(127.0.0.1 / ::1);bootstrap-check 只读不写 | web/tests/setup-wizard.test.ts 11 项 | 暴露端口给公网仍需操作员先 ban /api/setup/* |
| **A3** 统一 OwnerRef | 跨 service 类型断裂 | services-sdk 单一 enum + 'self' 是 org 的唯一别名 sentinel | services-sdk 83 项 | — |
| **B1.1** OrgApiPool | 凭据混用 | per-provider 独立 vault key + ownerKind/ownerId tuple 强校验 | host/tests OrgApiPool 测 | per-org pool 还没分流(host=单 org) |
| **B1.2** resolveApiKey | LlmAgent 拿到错的 key | preCallHook 调 OrgApiPool 而非读 env;mock provider 默认 free-pass | host LocalAgentPool 测 | LLM provider 返回 401 时只 log,不退 vault entry |
| **B2.1/B2.2/B2.3** usage / quota | 用户超额耗资源 / sweep 漏跑 | per-(user,metric,period) atomic UPSERT;sweep `period_start < ?` 严格 < 防 NTP 回拨;sweep 1h 心跳 + checkAndIncrement 即时 roll | identity/tests/usage.test.ts 33 项 | sweep 间隔可调但默认 1h —— 极端"用户深夜烧光配额,凌晨过期"场景里 admin 看 dashboard 会看到过期数字 ≤59 分钟 |
| **B2.2.2** origin 透传 | task.origin 用户身份伪造 | web /me dispatch 从 session 取 userId,workflow runner 仅 forward 不 mutate | web me-routes 测 + workflow runner 测 | task.from 仍可被 admin 任意 set(管理员特权;不视为漏洞) |
| **B3/B4** RAG | RAG 子系统漏洞面 | 走 MCP,不写 knowledge service —— 无新代码面 | — | MCP server 自身漏洞外置 |
| **C1.1/C1.2/C1.3** SPA | XSS / role 绕过 | server-side meta 注入 role + ALLOWED_ROLES Set 验白名单;`<meta name="x-aipehub-role">` 注入前 escapeHTML | web/tests/c1-app-shell.test.ts 10 项 | client 端 role 显示仍是 hint —— 真正的 owner-only API 在后端 reauth |
| **D1.1/D1.2** Peer Registry | 假冒 peer / token 泄漏 | inbound shared token 验证(可选);outbound per-peer vault token;refuse duplicate peerId(防 routing 二义) | identity peers.test.ts 21 + web peers 测 11 | inbound shared token 模式下,任一 peer 凭据泄漏 = 全部入方失守 |
| **D2** 跨 hub HITL | 跨 hub 任务路由滥用 | resolver 仅在 task.origin.orgId 匹配 link 时返回 dispatcher;否则 fall through;exception swallow → no_participant | core/tests/cross-hub-{resolver,hitl}.test.ts 9 项 | 软 timeout (5min) 不取消远端 task — 资源占用风险但有 audit 闭环 |
| **D3** 跨 hub knowledge | — | 取消;走共享 MCP server,不在 aipehub 攻击面 | — | MCP server 拓扑安全外置 |
| **E1** org soft quotas | 跨阈值告警风暴 | last_state 记录 + transitioned 标志保证 idempotency(同一状态不重复 audit) | identity/tests/org-quotas.test.ts 23 项 | quota=0 是合法但 degenerate(任何 usage=over) — 文档已明示 |
| **E2** Reputation | 路由偏好被 game | EWMA alpha=0.3 抵抗单次刷分;持久化 `<space>/feedback/reputation/*.json` + rebuild from ledger | core/tests/reputation.test.ts 15 项 | 低分 peer 不被永久排除(graceful degradation;非黑名单) |

总计 **15 个子模块、~2900 LOC 新代码、~250 个新测试、无回归**。
跑 `pnpm -r test`: 1844 passed + 2 skipped(provider 集成,需网络凭据)。

---

## 高优先级关注点(写代码时主动避免的反模式)

### 1. setup wizard 必须 loopback-only

`POST /api/setup/owner-password` 是无前置 auth 的密码设置端点,**绝不能**
对公网开放。host 拒绝条件:

- `req.socket.remoteAddress` 不在 `['127.0.0.1', '::1', '::ffff:127.0.0.1']`
- bootstrap 已完成(`identity.listUsers().length > 0`)

两个 condition **任一**满足就 403。

**残留风险**:运维如果用反向代理(nginx)且没 `proxy_set_header
X-Forwarded-For ...`,真实 client IP 看不到。所以 wizard 文档强烈
推荐操作员在 setup 完成后立即把 `/api/setup/*` 加进 nginx deny 列表
作为 defense-in-depth。

### 2. vault master.key 是 BLAST RADIUS = 全部加密凭证

`loadOrCreateMasterKey` 写文件时 chmod 0o600;读时校验 mode 不能更宽松
(`db-permissions.test.ts` 直接断 mode == 0o600)。

但 host 进程一启动就把 32B key 读进内存,任何 RCE / debug heap dump
都能拿到所有 LLM provider key / peer shared token。

**残留措施**(写在 docs/zh/ledger/V4-ARCH.md 已记):
- 操作员要把 master.key 排除在备份外(否则备份磁盘是新攻击面)
- 用 HSM / KMS 的话需要自己 wrap `loadOrCreateMasterKey`

### 3. 跨 hub HITL 软 timeout 不撤销远端 task

D2 的设计取舍:`Promise.race([dispatch, timeout])` 当 timeout 触发,
本地 agent 拿到 `kind: 'failed', error: 'hitl_timeout'`,继续往下走。
但 dispatch 仍然在 hub.dispatch 队列里 — admin 后来回答的话,response
被 race 已经 resolve 掉了,**没有取消机制**。

**为什么这样**:取消 task 跨 hub 需要 D2 之外的协议扩展(原 hub 通知
对方 hub "撤销 task X"),且 admin 已经看到的 task 在 UI 上撤销也会
confuse 用户("我刚回答了你又说不要了?")。当前设计接受短期 task 残留
的代价,换 90% 路径的简洁。

### 4. org quota 是 SOFT cap,不是 deny

E1 / C2 配额跨 100% 时**不阻断** LLM 调用,只写 audit warn。真正阻断
靠 per-user `checkAndIncrement`(B2.1)的 hard cap。

这是 deliberate 设计 — 一个用户的 call 因为"组织总额超了"被拒绝,UX
非常糟糕(用户看到自己用了 10/100 怎么会 reject)。操作员要的是
"早发现早调"的告警,不是 outage。

**怎么做硬 org cap**:操作员设 per-user quota 让 sum 等于想要的 org
cap,例如 5 个用户每人 100/day → 实际 org cap = 500/day。aipehub 不再
做"软上限自动转硬上限",由操作员显式配。

---

## 已知非阻塞 limitation(Phase 6 backlog)

按优先级排序:

| # | 项 | 估时 | 说明 |
|---|---|---|---|
| 1 | reputation admin UI(只读 dashboard) | ~2h | 目前要 cat `<space>/feedback/reputation/*.json`;C2 同类型小 UI |
| 2 | per-capability reputation 拆分 | ~6h | 现在 per-peer 一个总分;peer 可能"写好/总结烂",per-cap 更准但样本量小抖动大 |
| 3 | LLM provider 返 401 时自动 revoke vault entry | ~3h | 现在只 log;自动 revoke 减少操作员手工诊断,但要小心 transient 401 误伤 |
| 4 | per-org OrgApiPool 分流 | ~4h | host=单 org 假设下不紧迫;federation 多 org 时再要 |
| 5 | inbound peer per-peer token | ~3h | 替代 shared token;泄漏面缩小到单 peer |
| 6 | cross-hub task 撤销协议 | ~8h | D2 软 timeout 的进化;需要 frame 扩展 + 两端 task lifecycle 同步 |
| 7 | 严格 CSP(去掉 inline handler) | ~6h | Phase 3 backlog #3 滚雪球进 Phase 5;admin/identity/quotas-ui 都有 inline event handler |
| 8 | growthReports list 接口下沉 caseId filter | ~3h | Phase 3 backlog #1 滚雪球;现在 /me 路由层 filter+rate limit;DB 层做更省 |
| 9 | invitations 总数硬上限 | ~2h | Phase 3 backlog #2 滚雪球;真实部署没人提 |

---

## 闭环检查清单

- [x] 所有新表加 schema migration 注释,解释 PK 选择 + FK 决定 + 索引意图
- [x] 所有 web 路由的 auth gate 显式 (owner / admin / member / viewer)
- [x] 所有 mutation 路径写 audit log (action 名 in AUDIT_ACTIONS 枚举)
- [x] 所有新 env var 文档化(README.md 或 V4-ARCH.md)
- [x] 所有跨包 import 走 `@aipehub/*` 包名,不走相对路径(monorepo workspace)
- [x] 所有新文件首行 JSDoc 注释,说明用途 + 关键决策原因
- [x] `pnpm -r build` clean
- [x] `pnpm -r test` clean (1844/2)
- [x] 无新 P1/P2 安全洞需要 hotfix

---

**另见**:
- `docs/zh/ledger/AUDIT-v4.md` — v4 Phase 1-2 审计
- `docs/zh/ledger/AUDIT-v4-phase3.md` — v4 Phase 3(/me + invitations)审计
- `docs/zh/ledger/V4-ARCH.md` — v4 整体架构
- `docs/zh/REPUTATION-ROUTING.md` — E2 单独 deep-dive
- `docs/zh/RAG-VIA-MCP.md` — B3/B4/D3 设计决议
