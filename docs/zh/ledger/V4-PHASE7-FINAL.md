# v4 Phase 7 收尾

> Status: **完成**. 7 个 commit, 涵盖 Phase 6 backlog 全清 + 个人模式
> first-class 落地 + 北极星修正.
>
> Last updated: 2026-05-26
>
> 本文是 Phase 7 的 release-notes / hand-off. 读完应该能:
>   - 知道 Phase 7 加了什么 + 没加什么
>   - 知道每个新 feature 在代码 / docs 里的入口
>   - 把 Phase 8 (LLM streaming) 顺利接续起来
>
> GitHub 状态: 本次 Phase 7 全部 commit **未 push** (操作员指令 "github
> 额度超了"), 本地 `main` 分支领先 origin 60 commits (53 之前 + 7 本期).
> 后续解禁后一次 push, 无需 squash — 每个 commit 都是有意义的小步.

---

## 一、commit 时序

按写入顺序, 共 7 个 commit (不算 4bdc18b Phase 6 P0+P1 已 commit):

| # | sha | 内容 |
|---|---|---|
| 1 | `136a3b8` | docs: project root CLAUDE.md + Phase 7-13 plan |
| 2 | `3b7c5d9` | fix(host,web): Phase 6 P2 audit batch (#148-#152) |
| 3 | `3fa2ba1` | fix(identity,host,core,web): Phase 6 P3 audit batch (#153-#157) |
| 4 | `43c0524` | docs: personal-hub RFC (Phase 7 M3) |
| 5 | `b1f5ef7` | feat(identity,host): personal-hub bootstrap mode (Phase 7 M4) |
| 6 | `85e8342` | feat(web): SPA shell mode-aware + upgrade flow (Phase 7 M5) |
| 7 | `d88e8df` | docs: personal-mode quickstart + dedicated doc (Phase 7 M6) |
| 8 | (this) | docs: V4-PHASE7-FINAL.md (Phase 7 M7) |

代码量: **17 files changed, +1456 / -45** (跨 commit 累加; 实际 LOC
要去 git diff 4bdc18b..HEAD 看具体).

---

## 二、Phase 7 解决了什么 (按 milestone)

### M1 — Phase 6 P2 audit batch (#148-152)
5 项 P2 小修. 半小时 → 1 commit. 详见 commit message of 3b7c5d9.

### M2 — Phase 6 P3 audit batch (#153-157)
5 项 P3 修复. 重点几项:
- #153 invitations cap 从 DEFERRED 升 IMMEDIATE 关闭 TOCTOU
- #154 peerTokenResolver 4 个 silent reject 路径加结构化日志
- #155 PeerReputation 从 core 公开导出, web 用 extends 消除 drift
- #157 revokeVaultEntry 返回 boolean → onAuthFailure 用之 dedup
  concurrent 401 的 audit (N 次 401 → 1 行 audit)

### M3 — Personal Hub Mode RFC (`docs/zh/PERSONAL-HUB-RFC.md`)
5 个关键决策走 AskUserQuestion. 用户拍板:
- A: mode auto-detect (用户数 ≤ 1 → personal)
- B: personal 模式下隐藏 role chip
- C: **所有 admin tab (users/peers/quota/audit) 在 personal 模式
  下也保留可见** (与 RFC 推荐相反, 用户偏好"成人版"个人模式)
- D: 显式升级按钮 + 首次邀请自动升级双轨

### M4 — `personal-hub` bootstrap 实现
- 新 schema v=8 `org_meta(key, value, updated_at)` 通用 kv bag
- 新 IdentityStore API: `getOrgMeta` / `setOrgMeta` / `getOrgMode` /
  `setOrgMode`
- bootstrap 写默认 `org_mode='personal'`
- 自动 promote (3 处触发): `createInvitation` / `createUser>1` /
  `acceptInvitation`
- host main.ts 读 env `GOTONG_MODE=personal | team` pin

### M5 — SPA 首屏分流 (web UI)
- 新 endpoint `GET /api/me/mode` → `{ mode, canUpgrade }`
- 新 endpoint `POST /api/admin/identity/org-mode` (owner-gated, audit)
- app.js boot → fetch mode → 设 body class `mode-personal`/`mode-team`
- 个人模式 CSS: 隐藏 role chip, 改副标题"我的 AI 桌面",
  显示 settings 区"升级到团队"按钮
- 用户决策 C: tab 可见性不动 — mode 只切风格不切功能

### M6 — README + docs 更新
- README 加「个人模式」段 (与 5-min personal growth workflow 并列)
- 新 `docs/zh/PERSONAL-MODE.md` — 5 分钟 walkthrough + API/UI
  差异表 + 自动/显式升级流程 + env 语义 + 从 Phase 6 hub 升级路径

### M7 — Phase 7 收尾 (本文)
全量 build/test 验证 + release notes.

---

## 三、新增 + 修改的关键资产

### 新表

| schema 版本 | 表 | 用途 |
|---|---|---|
| v=8 | `org_meta` | M4 — 通用 kv (org_mode + 未来 org 级 scalar) |

### 新 IdentityStore APIs

```
org_meta:  getOrgMeta(key) / setOrgMeta(key, value)
org_mode:  getOrgMode() / setOrgMode('personal' | 'team')
```

`getOrgMode` 有 auto-detect fallback (无 row → countUsers ≤ 1 →
'personal'), 兼容 pre-Phase-7 db.

### 新 IdentityStore 行为

- `bootstrap` 写 `org_mode='personal'` 当首次创建用户
- `createInvitation` 自动 flip personal → team (operator intent)
- `createUser` 自动 flip 当 countUsers > 1
- `acceptInvitation` 防御性 re-flip (manual pin back 边缘)
- `revokeVaultEntry` 返回 `boolean` (true = revoke 实际发生)

### 新 web routes

```
GET  /api/me/mode                           (signed-in)
POST /api/admin/identity/org-mode           (owner-gated, audit)
GET  /api/admin/identity/invites/count      (owner-gated, M156)
```

### 新 audit actions

- `'org_set_mode'` — `{ from: OrgMode | null, to: OrgMode }`
- `'api_quota_denied'` — `{ metric, period, used, quota, exceededBy }` (#151)

### 新 SPA 行为

- `body.mode-personal` / `body.mode-team` 类
- `#role-badge` 在 personal 模式下 `display: none`
- `.settings-upgrade` 默认隐藏, personal 模式可见
- 副标题"我的 AI 桌面" (personal) vs "管理员控制台" (team)
- 升级按钮 + 二次确认 + audit + reload

### 新文档

- `CLAUDE.md` — 项目根级 agent 北极星
- `docs/zh/ledger/V4-PHASE7-13-PLAN.md` — Phase 7-13 路线图 (51 milestone)
- `docs/zh/PERSONAL-HUB-RFC.md` — M3 设计决策
- `docs/zh/PERSONAL-MODE.md` — 终端用户文档
- `docs/zh/ledger/V4-PHASE7-FINAL.md` — 本文

---

## 四、测试统计

**Phase 6 结束**: 19 包 / 1925 tests / 0 failures
**Phase 7 结束**: 19 包 / **1958 tests** / 0 failures (+33)

新增测试细分:
- `identity-routes-audit-vocab.test.ts` — 2 (#148)
- `identity-routes-reputation.test.ts` — 1 (#152 NaN sort)
- `org-api-pool.test.ts` — 1 (#151 quota denied audit)
- `invitation-cap.test.ts` — 1 (#153 BEGIN IMMEDIATE white-box)
- `peer-token-resolver.test.ts` — 6 (#154)
- `identity-routes.test.ts` — 1 (#156 count endpoint)
- `local-agent-pool-auth-failure.test.ts` — 1 (重写; #157 dedup)
- `org-mode.test.ts` — 14 (M4)
- `org-mode-routes.test.ts` — 7 (M5)

跳过 (无变化): `llm-anthropic` / `llm-openai` 各 1 个真凭据集成测试.

---

## 五、Phase 7 没做的事

下面这些在 Phase 7 路线里被推到 Phase 8+:
- LLM streaming 全链路 (Phase 8)
- 多模态 content blocks (Phase 9)
- Agent-to-agent dispatch (Phase 10)
- Long-running agent suspend/resume (Phase 11)
- 协议外通路 IM bridges + PWA + REPL (Phase 12)
- AI 辅助 workflow 编辑器 (Phase 13)

详见 `docs/zh/ledger/V4-PHASE7-13-PLAN.md`.

Phase 7 RFC 段末尾的 3 个 open 问题留给后续:
1. **Multi-personal-hub federation** — 个人 hub 之间互联的 IM-style
   onboarding, Phase 12 IM bridges 后再决定
2. **个人模式默认 system prompt** — 未来"我的 AI 桌面"自由对话框
   用什么 prompt, Phase 8/13 涉及
3. **凭证 UI 简化** — personal 模式下 vault 是否只显示 LLM key
   (隐藏 mcp/peer_token), 暂保持完整显示, 后续按 UX 反馈调整

---

## 六、给 Phase 8 的交接

**Phase 8 主题**: LLM streaming 全链路 (破坏性 — 删 `LlmProvider.complete`).

**预备工作**:
- `CLAUDE.md` § "现在在哪段" 更新 Phase 7 状态为完成
- `docs/zh/ledger/V4-PHASE7-13-PLAN.md` Phase 8 段已有详细 M1-M8 milestone
- 用户决策已拍板: "直接全部改 stream, complete 删除"

**Phase 8 开工时建议**:
1. 先从 M1 (新接口 `LlmProvider.stream(req): AsyncIterable<LlmStreamChunk>`)
   起步, 让所有 provider / agent / workflow / test 在一次 RFC 商议后
   一起改, 避免双轨期太长
2. Anthropic provider 改完直接做端到端 SSE 透传 demo, 把"完整链路
   能工作"先证明出来, 再补 OpenAI/Mock 等其他 provider
3. 个人模式"我的 AI 桌面"的自由对话框可以在 Phase 8 一并落地 —
   streaming + 对话框是天然搭配, 不要拆成两个 Phase 做

---

## 七、build / test 命令速查

```bash
# 全量
pnpm -r build
pnpm -r test

# 单包
pnpm --filter @gotong/identity test
pnpm --filter @gotong/host test
pnpm --filter @gotong/web test

# 个人模式 smoke
docker compose up
# 看 admin URL → 设置 wizard → 浏览器开 admin 看 body class
```

Phase 7 全绿. Phase 8 可以开工.
