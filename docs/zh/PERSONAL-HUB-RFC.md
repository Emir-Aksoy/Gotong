# Personal Hub Mode — RFC

> Phase 7 M3 of `docs/zh/V4-PHASE7-13-PLAN.md`.
>
> Status: 待用户拍板。M4 (实施) / M5 (SPA 分流) 都依赖本 RFC 的决议。
>
> Last updated: 2026-05-26

---

## 一、为什么需要

`CLAUDE.md` 北极星第 1 层「人 ↔ 自己的 AI / agent」目前被「组织」叙事
盖住了。`V4-ARCH.md` 第一条决策就是「单 host = 单 organization」, 整
套权限模型 owner/admin/member/viewer 全是组织角色。

实际后果:
- 新用户跑 `pnpm host` → 看到 admin URL → 进入「管理员控制台」(users
  tab, peers tab, quota tab, invitations tab, audit log tab)
- 一个想"我就一个人用 AI 干活"的用户被迫学一堆组织概念才能开始
- 个人成长 workflow 是亮点, 但它在 UI 里仍然是"组织内一个 workflow",
  入口隐蔽

目标: 让"个人模式"成为 first-class 入口, 让一个用户 5 秒内进入"我的
AI 桌面", **不需要看到任何组织概念**(除非他主动升级)。

---

## 二、范围 + 非范围

**范围**:
1. bootstrap 时检测/选择 personal mode
2. personal mode 下的角色简化(单 user 即 owner)
3. SPA 首屏分流: personal → 我的 AI 桌面; team → admin 控制台
4. 升级路径: personal → team (邀请第一个人时自动)

**非范围**:
- 个人 ↔ 个人 hub 的 peer mesh(Phase 12 IM bridges 替代, 或留 v4 后续)
- 个人模式专属 workflow 模板(走现有 templates 即可)
- 多模态 / 长跑 agent 等 AI 新范式(Phase 9-11)

---

## 三、关键决策

### 决策 A: mode 检测 — auto vs explicit

**选项 A1: explicit flag** — env `AIPE_MODE=personal` 触发, 默认 team

**选项 A2: auto-detect** — 启动时查 identity:
  - users.count === 1 && memberships.count === 1 → personal
  - 否则 → team
  - operator 可用 `AIPE_MODE=team` 强制覆盖(永远是 team, 即使只有 1 个用户)

**推荐 A2** 理由:
- 0 配置体验: 第一次跑就是个人模式; 邀请第二个人后自动升级
- env override 仍然保留, 偏好 explicit 的运维不被牺牲
- 检测代价低: identity bootstrap 已经读 users.count, 顺手返回

**留给用户拍板**: A2 / A1 / 都要(双轨)?

### 决策 B: personal mode 下 role 怎么算

**选项 B1: 强制 owner** — personal mode 的单 user 永远 role=owner

**选项 B2: 单 user 模型, 不显示 role** — UI 不显示 role chip; 内部
  仍然是 'owner'(为了 audit + 升级时一致), 但用户看不到

**推荐 B2** 理由:
- B1 内部行为, B2 是 UI 行为, 二者不冲突 — 实际上 B2 = B1 + UI 隐藏
- 个人用户根本不关心"我是 owner 还是 admin", 显示是噪音
- 升级到 team mode 时 UI 自然显示 role(因为多人了)

**留给用户拍板**: 默认 B2, 还是想保留显示?

### 决策 C: 哪些 UI 在 personal mode 下隐藏

| Tab / 功能 | personal | team | 备注 |
|---|---|---|---|
| 我的对话(workflow 启动 + 我的 AI 桌面) | ✅ 主页 | 副选 | personal 默认 |
| 我的 agents | ✅ | ✅ | 双模都重要 |
| 我的 workflow(模板浏览 / 启动 / 历史) | ✅ | ✅ | 双模都重要 |
| Transcript / 历史 | ✅ | ✅ | 双模都重要 |
| Vault / secrets | ✅(简化版) | ✅ | personal 只显示 LLM key |
| Users / 邀请 | ❌ | ✅ | personal 没人可邀请, 隐藏 |
| Peers / federation | ❌ | ✅ | personal 没 peer, 隐藏 |
| Org quota | ❌ | ✅(可选) | personal 单用户, quota 无意义 |
| Audit log | ❌ | ✅ | personal 自己看自己审计太怪 |
| Reputation | ❌ | ✅ | personal 没 peer 没 reputation |
| 设置 → 升级到团队 | ✅ | n/a | personal 专有按钮 |

**留给用户拍板**: 这个表对不对? 有想加 / 删的?

### 决策 D: 升级路径

personal → team 触发条件:
- 用户在"设置 → 升级到团队"显式点按钮
- 或者: 用户首次创建 invitation(自动升级)

**推荐: 触发条件 1 + 2 都生效**(2 是兜底, 防止 user 困惑)

升级动作:
1. 设 internal flag `org_mode=team` (新表 `org_meta` 或 vault metadata)
2. UI 切换到 team shell, 用户看到完整 tabs
3. 用户的 role 一直是 'owner'(不变), 现在 owner chip 出现在 UI

不可逆? **建议 v4 阶段做成单向不可逆**(team → personal 需要 manual
revoke 所有 invitations + remove all peers + remove all users 才能算
personal 状态, 复杂; 推迟到有需求再做)

### 决策 E: 个人模式下的"我的 AI 桌面" 长什么样

第一版最小化, 一个对话框 + workflow 卡片:

```
┌───────────────────────────────────────────────────────┐
│  我的 AI 桌面                            [设置] [日志]  │
├───────────────────────────────────────────────────────┤
│                                                       │
│   有什么想做的?                                         │
│   ┌─────────────────────────────────────┐             │
│   │  > 在这里输入...                    │             │
│   └─────────────────────────────────────┘             │
│                                                       │
│   或者从模板启动:                                       │
│   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                │
│   │ 个人 │ │ 编辑 │ │ 行业 │ │ 翻译 │  ...           │
│   │ 成长 │ │ 团队 │ │ 咨询 │ │ 团队 │                │
│   └──────┘ └──────┘ └──────┘ └──────┘                │
│                                                       │
│   ▾ 最近的对话                                         │
│      • 2 小时前 — 12 周计划 (个人成长)                  │
│      • 昨天 — 复盘 Q2 (个人成长)                       │
└───────────────────────────────────────────────────────┘
```

**最小可行版本**:
- 直接输入框 → 调 default agent (workspace LLM key + 通用 system prompt)
- 模板卡片 → 已有 workflow 启动表单
- 最近对话 → 已有 transcript 查询

**不做(M5 之后再说)**:
- streaming 实时显示(那是 Phase 8)
- 移动端响应式(那是 Phase 12)
- 自定义"我的 AI"角色(那是 Phase 13 AI 辅助 workflow 编辑器)

---

## 四、不破坏现状的承诺

- **现有 admin 用户体验 0 变化**: 第一次启动如果检测到已有多 user
  (从老版本升级来), 直接进 team mode, admin URL 不变。
- **个人模式不删任何 API**: invitations / peers / org-quotas 路由都
  保留, UI 只是不暴露入口。从命令行 / API 直接调仍然可用。
- **personal → team 升级不丢数据**: 单 user 变成多 user, 之前的所有
  transcript / vault / agents 都保留, role 还是 'owner'。

---

## 五、实施 milestones (M4 / M5)

### M4 — `personal-hub` bootstrap 实现

**文件**:
- `packages/identity/src/store.ts` — bootstrap 加 mode 检测 + auto
- `packages/host/src/main.ts` — env `AIPE_MODE` + 透传到 identity
- 新表 `org_meta(key TEXT PK, value TEXT)` 或 reuse 现有 secrets blob
  - 选 `org_meta` 比较干净, 给后续"org-wide config"留扩展

**测试**:
- bootstrap 空 db → users.count=1 → personal
- bootstrap 空 db + AIPE_MODE=team → team(即使单 user)
- bootstrap 现有多 user db → team(无论 env)
- bootstrap 现有单 user db (从老版本升级) → personal

### M5 — SPA 首屏分流

**文件**:
- `packages/web/src/identity-routes.ts` — 新 endpoint `GET /api/me/mode`
  返回 `{ mode: 'personal' | 'team', canUpgrade: boolean }`
- `packages/web/static/app.html` + 新 `personal-shell.js` — 检测 mode
  渲染不同 shell
- 已有 admin shell 不动

**测试**:
- `/api/me/mode` 返回正确 mode
- personal mode 用户看不到 users tab(DOM 不渲染)
- 升级到 team 后 reload → 看到完整 tabs

---

## 六、未解决的问题(留给后续)

1. **Multi-personal-hub federation**: 如果 Alice 和 Bob 各自一个个人 hub,
   他们俩之间能不能 hub-link? 答案应该是 yes(用 peer registry), 但
   "个人 hub 之间互联"是不是要走一个简化的 onboarding(不需要弄 peer
   token, 走 IM 协商)? 推迟到 Phase 12 IM bridges 后再说。

2. **个人模式默认 system prompt**: "我的 AI 桌面"输入框打字直接调 LLM
   时, 用什么 system prompt? 是空(纯 LLM 默认)还是"你是 Alice 的 AI
   助手"? 留给 M5 决策, 默认空。

3. **凭证简化 UI**: personal mode 下 vault 应该只显示"我的 LLM key",
   不显示 peer_token / mcp_server credentials(因为 personal mode 没
   peer 没 mcp)? 或者继续显示但分类? 留给 M5 决策。
