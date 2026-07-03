# 个人模式 (Personal Mode)

> Phase 7 落地。把"一个人用 AI 干活"做成 first-class, 不需要先学组织 / 角色概念。
>
> Last updated: 2026-05-26
> RFC: `docs/zh/PERSONAL-HUB-RFC.md`

---

## 一句话

**个人模式 = 单用户的 AipeHub. 主页是"我的 AI 桌面"而不是"管理员控制台",
role chip 隐藏, 设置里有"升级到团队"按钮. 其他 admin 功能全部保留,
只是不占主屏幕注意力.**

---

## 5 分钟从零开始

### Step 1 — 跑起 host

任选一种 (docker 推荐):

```bash
# A. Docker
docker compose up
# 等 ~10 秒, 看终端最后一行 admin URL
#   http://127.0.0.1:3000/admin?token=eyJhbG...

# B. 源码
pnpm install && pnpm build && pnpm host
```

### Step 2 — 打开 admin URL

浏览器打开. host 第一次启动时:
- 创建一个 owner 用户 (`admin@local`, 显示名 `Operator`)
- `org_mode` 自动写 `'personal'`
- 走 setup wizard (设置密码) — wizard 完成后落地登录

之后 SPA 加载:
- 顶部 **不显示** `OWNER` chip
- 副标题写 **"我的 AI 桌面"** (不是"管理员控制台")
- 主页是 "我的工作流" 直接派发

### Step 3 — 配 LLM key 跑第一个工作流

走"agents"/"凭证"任一入口给你的 hub 加 LLM API key. 最低门槛是 DeepSeek
(中国大陆可达, 新用户送 10 元额度).

跑 personal-growth workflow 或者直接派任意 capability 给已有 agent.
详见 [`README.md` 5-minute personal growth workflow](../../README.md#5-minute-personal-growth-workflow-新).

---

## 个人模式的边界

### 哪些 UI 元素变了

| 元素 | personal | team |
|---|---|---|
| 顶部 role chip (`OWNER`) | 隐藏 | 显示 |
| 副标题 | "我的 AI 桌面" | "管理员控制台" |
| 设置 → 升级按钮 | 显示 | 隐藏 |
| Users / Peers / Quota / Audit tab | **全部保留** | 全部保留 |
| 工作流 / Agents / Vault | 保留 | 保留 |

### 哪些 API 变了

| API | personal | team |
|---|---|---|
| `GET /api/me/mode` | `{ mode: 'personal', canUpgrade: true }` | `{ mode: 'team', canUpgrade: false }` |
| `POST /api/admin/identity/org-mode` | owner 可 flip 双向 | 同 |
| 所有其他 admin API | 完全可用 | 完全可用 |

**没有任何 admin API 在个人模式下被禁用**。模式只影响 UI 呈现, 不影响功能。

---

## 自动 / 显式升级到团队

### 自动触发

只要发生以下任一事件, mode 自动从 personal flip 到 team:

1. **创建邀请**: `IdentityStore.createInvitation()` 或 admin UI 的 "邀请用户" 按钮
2. **创建第 2 个用户**: 任何路径 (邀请接受 / admin createUser / API)
3. **接受邀请**: 防御性的 second-line, 应对 mode 被手动 pin 回 personal 的边缘

### 显式触发

owner 在设置 tab 点 **[升级到团队模式]** 按钮:

```
POST /api/admin/identity/org-mode
{ "mode": "team" }
```

回执:

```json
{ "mode": "team" }
```

audit log 写一行:

```json
{ "action": "org_set_mode", "metadata": { "from": "personal", "to": "team" } }
```

### 回退 (personal → team → personal)

owner 也可以 flip 回 personal:

```
POST /api/admin/identity/org-mode
{ "mode": "personal" }
```

注意: **下一次 createInvitation / createUser 会再次自动 flip 到 team**。
所以 "flip 回 personal" 只有这些场景有意义:
- 团队解散了, 现在只剩你一个人, 想清爽点
- 你正在测试个人模式 UI

不会丢数据 — invitations / peers / quota 数据全保留, 只是 UI 风格切回。

---

## env 强制覆盖

启动时 `AIPE_MODE` 可 pin 一个模式:

| env | 行为 |
|---|---|
| 未设置 / 空 | 走数据库 `org_mode` (自动模式) |
| `AIPE_MODE=personal` | 启动时把 `org_mode` pin 到 `'personal'` |
| `AIPE_MODE=team` | 启动时把 `org_mode` pin 到 `'team'` |
| 其他值 (如 `weird`) | warn log + 忽略, 走自动模式 |

注意: env 只在启动那一次 pin. 之后用 createInvitation / 显式 flip
仍然能改变 mode. env 不是"硬锁"。

如果你想让生产环境永远是 team (即使临时回到 1 个用户), 把 `AIPE_MODE=team`
写进 docker-compose.yml 即可。

---

## 升级 (从已有 hub 加进来)

如果你的 hub 是从 v4 Phase 6 或之前升级来的, `org_mode` 行在 `org_meta`
表里**不存在**, 走自动 fallback:

- `users.count <= 1` → 视作 `personal`
- 否则 → 视作 `team`

第一次 createInvitation / createUser 会写入 `org_meta.org_mode = 'team'`,
之后就是正常的存储模式判定。

不需要任何 migration 动作。schema migration v=8 已经创建空表。

---

## 跟其他文档的关系

- **设计 RFC**: `docs/zh/PERSONAL-HUB-RFC.md` — 5 个决策的讨论
- **整体 v4 路线**: `docs/zh/ledger/V4-PHASE7-13-PLAN.md` — Phase 7 是路线的第 1 步
- **北极星**: `CLAUDE.md` — 三层链接哲学, 个人模式实现"第 1 层 (人 ↔ 自己 AI)"
- **5 min workflow demo**: `README.md` § "5-minute personal growth workflow"

---

## 已知 / 待补

- **首页"我的 AI 桌面" UI 第一版**: 现在的主页就是 workflow 派发表 + 历史. 后续 (Phase 8/13) 会加自由对话框 + 实时 streaming. 详见 V4-PHASE7-13-PLAN.md
- **多用户回 personal 流程**: 现在没有"team → personal 一键回退" UI, 必须先 revoke 所有邀请 / remove 所有用户. 罕见场景, 推到有需求再做
- **个人 hub 之间的 peer mesh**: 设计上支持, 但 onboarding (token 协商) 还是要走和团队 hub 一样的流程. Phase 12 IM bridge 可能提供更轻的 onboarding 替代
