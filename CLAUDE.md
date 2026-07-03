# AipeHub — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-06-03

---

## 一、本项目存在的意义（北极星）

AipeHub 要做的是 **AI 时代「人-智能体-机构」三层链接的工作底座**：

```
   第 1 层  人 ↔ 自己的 AI / agent
            「我的 AI 桌面」: 一个人的 hub, 私人 workflow, 凭证只在本机
            目标: 5 分钟跑起来, 不写代码, AI 帮我做实际的事

   第 2 层  人 / agent ↔ 别的人 / agent / 机构
            「跨组织协作」: 多 user, role, 邀请, 跨 hub federation
            目标: 工作流可跨边界, 但凭证/数据/计费各归各家

   第 3 层  框架本身
            「清晰 + 稳定 + 适配」: Hub is dumb on purpose, file-first,
            participant 是统一抽象, 协议 / 凭证 / 配额都有显式边界
            目标: 工作流能实际落地, 跟得上 AI 快速发展
```

**三句话守则**:

1. **框架不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件,
   决策权永远在参与者(agent / 人 / 外部服务)手里。这是从 v0 到现在
   不变的设计立场, 改了就不是 AipeHub。

2. **人和 agent 是同一个 `Participant`**。不要把人当 "request_human_input
   tool"。一切跨人 / 跨 agent 的协作都走同一套消息 + task + transcript。

3. **状态都是磁盘文件**。`.aipehub/` 目录里能看到 transcript / agents /
   sessions / secrets / vault。复制目录 = 搬走房间。重启透明。

---

## 二、现在在哪一段

> **完整进展账本（v1.x → RES 全部里程碑、每个 Phase/Stream 的 commit 与设计决策、
> 验收门、显式推迟）已整体移到 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)。**
> 那里逐字保留历次收口记录；本节只留最近三个里程碑的指针。要查任何历史
> Phase/Stream（v1.x → v5 全部「完」）的落地细节、commit、设计权衡，**读账本**。

最近三个里程碑（倒序）：

- **BE 管家增强（BE-M1→M6 全完，默认开）** — 补缺口 3「管家作为『用户↔框架』中间层还缺眼睛」：
  给常驻管家补**眼睛**（`list_my_runs`/`list_my_agents`/`my_usage` 三只读，scoped 本人）+ **闭环**
  （`diagnose_my_agents` 诊断 → 既有 `edit_agent` 修复 / governed `create_workflow` 大白话建流 /
  benign `ask_my_agent` 问自己的助手 / 运行跑完**零 LLM 主动播报**到 IM）。一条硬约束：**观察复用
  既有成员向只读投影，写永远落既有审批闸 / 成员 surface——管家结构上做不出成员自己动手做不到的
  事**。详见 [`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)。
- **RES 资源适配（RES-M1→M4 全完）** — 补「快速适配自身部署环境资源」缺口：确定性
  零 LLM **只读**探测本机资源（各 provider 密钥可否解析 / 本地 OpenAI 兼容端点是否活 /
  编码 CLI 是否在 PATH / 已装哪些 MCP）→ 纯函数适配提议 → **人逐项批准**才写（探测/提议
  只读，写只有一处 `POST /api/admin/resources/adapt`，服务端重校验 `applicable`，**绝不
  静默改任何东西**）。详见 [`docs/zh/RES-RESOURCE-ADAPTATION.md`](docs/zh/RES-RESOURCE-ADAPTATION.md)。
- **常驻管家 fold 进 IM 通道（BF-M1→M8 全完，默认开）** — 生产 `aipehub start` 注册的
  `chat` agent 现在是 per-user `ButlerRouter`（按 `task.origin.userId` 路由到各成员自己的
  记忆命名空间），跨会话记忆（`MemorySession.refresh()` 修复冻结块永久缓存 = 飞书机器人
  「记不住」真因）+ governed 动作集（成员大白话建/改/删自己助手 → `/me` 收件箱审批）+
  per-user 蒸馏/6h 维护。详见 [`docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md`](docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md)。

更早里程碑（呈现/打包 = 只读 DAG 可视化 + 模板画廊一键装，等）：见账本。

阶段总览（v1.x → v5 全部「完」）与每个里程碑的 commit / 设计细节：见账本。

---

## 三、当前真实缺口（短期修）

> 历史「微偏」清单（协议外通路：PWA / IM / CLI / 桌面分发；AI 范式：streaming / 多模态 /
> 子 agent / 出站驱动外部 agent / long-running / HITL / 联邦…）**绝大多数已落地**——完整
> 能力矩阵与每项的 commit / 落地细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)
> 与第五节文档地图。本节只留**现在仍是缺口**的东西。

### ~~缺口 1：hub / 跨 hub 心智未在入口体现~~ ✅ 已收口

hub 是节点单位：一个人 + 自己的 agent = **主权 hub**；多 agent 也能组成**非主权 hub**（主权
在外部）；工作流既可 hub 内也可跨 hub 完成。原问题：UX 入口 / 文档按「个人 vs 组织」老框架
讲，没把真正的分界「**hub 内 vs 跨 hub**」摆到首屏。PRO + DOC 两 track 已收口：

- **PRO track（PRO-M1→M2 全完，默认 unset=字节不变）** ✅ — `AIPE_PROFILE=hub|federation`
  呈现视角落地：纯映射层（`packages/host/src/profile.ts`，解析 + 描述符 + 双语横幅行，零
  依赖可单测）+ host 启动横幅接线（`main.ts` 在 host-ready 摘要后印视角块，认不出的值警告后
  忽略）。一条硬边界：**视角 ≠ 行为分叉**——联邦代码在 hub 档照跑、单 hub 代码在 federation
  档照跑，profile 只决定「先展示什么」；不设 = 与今天字节完全一致（运行时验证过）。详见
  [`docs/zh/DEPLOYMENT-PROFILE.md`](docs/zh/DEPLOYMENT-PROFILE.md)。
- **DOC track（DOC-M2→M3 全完）** ✅ — 文档侧：52 篇 `*-FINAL`/`V4-PHASE*`/`AUDIT-*` 账本
  git mv 进 [`docs/zh/ledger/`](docs/zh/ledger/README.md)（顶层 117→65，坏链引入 0，解析器按
  direction+depth 重算链接）+ `docs/zh/README.md` 重排成「① 上手 → ② 理解 → ③ 动手 → ④ 上线 →
  ⑤ 社区 → ⑥ 出处/历史」六级金字塔（61 篇顶层零 orphan）。这同时也收口缺口 2 的 DOC track。

### 缺口 2：「易于上手 / 好扩展」是唯一在退的指标

功能面已把立项目标（开源 / 多人 / 多智能体 / 协同 / 工作流 / 框架）做满；真差距在**体感上手
速度**与**扩展门槛**：装配层重（`host/src/main.ts` ~3.2K 行 / host 32 依赖）、旋钮多（~107 个
`AIPE_*`）、文档考古层压过教程层（docs/zh 里 40+ 篇是 FINAL/PHASE/AUDIT 账本）。**内核本身干净**
（protocol 零依赖 → core → workflow / inbox，依赖方向正确，约占全仓 11%）——问题在打包 / 默认值 /
文档层，不在骨架。→ FUN（5 分钟漏斗 + TTFR 承重门）/ DOC（账本外移 + 金字塔）/ EXT（Participant
一页 + example 索引）/ GUARD（防再膨胀护栏）四 track 收口。

- **FUN track（FUN-M1→M2 全完）** ✅ — 官方 5 分钟上手漏斗 [`QUICKSTART.md`](QUICKSTART.md)（clone →
  首个可见结果的 do-this→see-that 阶梯）+ TTFR 承重门 `scripts/first-result-smoke.mjs`（spawn
  文档第一步那条 `pnpm demo`、剥掉所有 key、断言多方首个结果在预算内到达，`pnpm check:first-result`，
  会红的门）。
- **DOC track（DOC-M2→M3 全完）** ✅ — 见缺口 1（账本外移 ledger/ + docs/zh/README.md 六级金字塔）。
- 剩 **EXT / GUARD** 两 track。

### ~~缺口 3：管家作为「用户 ↔ 框架」中间层还缺眼睛~~ ✅ 已收口

BE track（BE-M1→M6）已补齐：管家的观察面（三只读）+ 诊断闭环 + `create_workflow` + `ask_my_agent`
+ 运行结果零 LLM 主动播报，全复用既有成员向只读投影 / 审批闸。详见 §二 与
[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)。


## 四、工作守则(开发指令)

### 4.1 与用户约定(会话级反复强调, 不要违反)

- **GitHub 已公开 + push 已解冻 (repo 2026-06-28 转 PUBLIC)**: 仓库 `Emir-Aksoy/AipeHub` 已公开, push 解冻。推送纪律: **只推 `main`**, fast-forward only, **绝不强推**; 推前 `git fetch` 校验 `git merge-base --is-ancestor origin/main main`。远端有 dependabot 分支 + PR, 不动它们。Actions 仍仓库级禁用 (公开后重新启用免费)。具体哪次该不该 push 仍按用户指令, 不擅自 push。
- **不要动备份**: `~/Backups/AipeHub/` 是历史快照, 只读
- **临时/测试产物清理阈值 (2026-06-19 用户指令)**: agent 自己产生的临时 / scratch / 测试文件 (如 `/tmp/aipe-e2e-*` 测试空间、`/tmp/aipe-*.log`、临时 host 数据目录) 占用 **≤ 10 GB 时不必清理**, 超过阈值才清。清理前先 `du -sh` 核实大小。注: harness 会拦截破坏性 `rm -rf` 大范围通配 + 前台 `sleep`, 真要清就 `rm` 具体目录、逐项删, 别用 `rm -rf` 通配。
- **不需要向前兼容**: 还没上线, 大胆改 schema / API。删旧代码比加 deprecation shim 优先
- **代码尽量简化, 节点尽量轻量**: 每个 PR 一个小目标, 别一次塞 5 个 feature
- **一个任务一个任务**: 规划完一项 → 开发 → 测试 → commit → 下一项
- **主流 agent 接入标准**: 以后每个主流 agent 适配器都必须过《`docs/zh/AGENT-ADAPTER-CONTRACT.md`》的「双向 + 可快速接管」验收门 —— ① 双向连通 (入站 MCP/A2A + 出站 shell-out/A2A/鸭子 adapter); ② 五控制缝 (可观测/可拦截/可移交/可续跑/可终止); ③ 接管粒度至少 Tier 1, 能改文件·花钱·对外发的到 Tier 2, 黑盒 agent 的副作用面在 hub 边界钉 Tier 2。新写 adapter 先对表。
- **Auto Mode bias**: 不要每步都问; 不清楚的地方留 inline 注释说明默认选择, 用户会 redirect

### 4.2 代码风格

- TypeScript ES modules(`type: "module"`), `.js` 后缀 import path
- pnpm workspace, 包间引用走 workspace protocol
- 测试用 vitest, 每个新 feature 配回归测试
- 错误用 `IdentityError` / 类似类型化错误码, 不抛裸 Error
- 日志用 `@aipehub/host` 的结构化 logger(JSON / pretty 自适应)
- 注释写「为什么」, 不写「是什么」。代码自身能读出"是什么"
- 不要无故添 emoji 到文件 / commit message。除非用户明说

### 4.3 commit message 风格

参考最近 commit:
```
feat(transport-ws,host): inbound peer rate limit (Phase 6 #12)
fix(security,host,identity): Audit Phase 6 P0+P1 batch (#141-147)
docs(audit): v4 Phase 5 full audit — 15 modules, no P1/P2 hotfixes (F1)
```

- 前缀 `feat / fix / docs / refactor / chore / test`
- 括号里列动到的包名
- 短描述 + 阶段号 / issue 号
- body 写"为什么"
- 末尾固定 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### 4.4 何时停下来问

- **schema 不可逆变动**(drop column, drop table): 哪怕"不需要向前兼容",
  也确认一下是否要保留迁移脚本
- **删除现有 public API surface**: 即使没人在用, 也描述影响面再删
- **架构 fork 选择**(比如 "streaming 走 SSE 还是 long-poll"): 把选项列出
  来, 推荐其一, 等用户拍板
- **生产凭证 / .env**: 永远不读不写不 commit

---

## 五、关键文档地图(agent 用)

> 单元格里的历史落地细节已移到各文档自身正文与
> [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)；这里只留「想知道什么 → 读哪」的路标。
>
> **逐里程碑账本已归档到 [`docs/zh/ledger/`](docs/zh/ledger/README.md)**（DOC-M2）：52 篇
> `*-FINAL` / `V4-PHASE*` / `AUDIT-*` 从 `docs/zh/` 顶层搬进去，顶层只留当前教程 / 参考。
> 下面凡指向 `docs/zh/ledger/…` 的都是那一档深潜 / 历史；内容一字未改，只挪了位置。

**根 / 定位**

| 想知道什么 | 读哪 |
|---|---|
| 项目宪章（认知 / 北极星三不可破 / 三层用途 / 信任护城河 / 愿景；与代码冲突时宪章为源） | `CHARTER.md` · `docs/zh/CHARTER.md` |
| 5 分钟总览 | `docs/zh/OVERVIEW.md` |
| 框架设计哲学 + 模块边界 | `docs/zh/ARCHITECTURE.md` |
| 给框架加能力而不加耦合（host↔web 鸭子 `*Surface` 注入；web 运行时不依赖 host；加新能力配方） | `docs/zh/SURFACE-PATTERN.md` |
| 协议规约（v1.2） | `docs/PROTOCOL.md` |
| 产品定位（赛道地图 + 产品级矩阵 + 目标用户） | `docs/zh/COMPETITIVE-LANDSCAPE.md` · `docs/zh/PRODUCT-MATRIX.md` |
| 部署视角（`AIPE_PROFILE=hub\|federation` 入口先讲 hub 内 vs 跨 hub；呈现视角非行为开关；unset=字节不变） | `docs/zh/DEPLOYMENT-PROFILE.md` |

**上手 / 打包 / 案例**

| 想知道什么 | 读哪 |
|---|---|
| 上手案例（5 个开箱 hub 对照 + 确定性 demo + go-live） | `docs/zh/HANDS-ON-HUBS.md` |
| 20 行写一个 Participant（框架唯一扩展面：agent / 人 / 服务同一契约；裸接口 + 基类两写法） | `docs/zh/PARTICIPANT.md` |
| 50 个 example 的分级索引（先跑哪个 → 深到哪；每行标前置，绝大多数零前置） | `docs/zh/EXAMPLES.md` |
| 模板画廊一键安装 | `docs/zh/TEMPLATE-GALLERY.md` |
| 只读 DAG 可视化 | `docs/zh/WORKFLOW-DAG-VIZ.md` |
| 工作流架构师（大白话→YAML + 讲解 + 配图 + 成员 `/me` 新建） | `docs/zh/WORKFLOW-ARCHITECT.md` |
| 易用性深化（失败修复入口 / 配置体检 / 启动兜底 / VALID 定义校验） | `docs/zh/EASE-OF-USE-DEEPENING.md` |
| 统一 `setting` 运维控制台（一命名空间 + 三入口 + 零大模型 + tier 边界） | `docs/zh/SETTING-OPS-CONSOLE.md` |
| MCP 接入（client + server） · 连接器目录 | `docs/zh/MCP.md` · `docs/zh/MCP-CONNECTOR-DIRECTORY.md` |
| 知识库连接器 / RAG（全走 MCP，框架不存知识） | `docs/zh/KB-CONNECTORS.md` · `docs/zh/RAG-VIA-MCP.md` |

**社区 / 上线**

| 想知道什么 | 读哪 |
|---|---|
| 荣誉激励制度（引用排行榜 / 晋升路径 / 便捷共享 / 共享范本，纯荣誉） | `docs/zh/RECOGNITION-SYSTEM.md` |
| 社区贡献 + 模板提交流程 | `CONTRIBUTING.md` · `templates/community/templates/README.md` |
| 治理 + 行为准则 + 维护者名册 | `GOVERNANCE.md` · `CODE_OF_CONDUCT.md` · `MAINTAINERS.md` |
| 旗舰模板策展索引 + 引用排行榜 | `docs/zh/FLAGSHIP-TEMPLATES.md` |
| 零算力社区站生成器 · GitHub Discussions | `docs/zh/COMMUNITY-SITE.md` · `docs/zh/COMMUNITY-DISCUSSIONS.md` |
| 上线 runbook（三拓扑 T1/T2/T3） | `docs/zh/GO-LIVE.md` |
| 便携包分发（下载双击即跑，零 Node/Docker） | `docs/zh/PORTABLE-BUNDLE.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md` · `docs/OPERATIONS.md` · `docs/MONITORING.md` |

**能力专题（正文有全链路细节）**

| 主题 | 读哪 |
|---|---|
| v4 整体架构 + Phase 路线 · 跨 org federation 模型 | `docs/zh/ledger/V4-ARCH.md` · `docs/zh/ledger/V4-PHASE4.md` · `docs/zh/ledger/V4-PHASE5-FINAL.md` |
| 工作流生命周期 + 版本化（防漂移） | `docs/zh/ledger/V4-PHASE15-FINAL.md` |
| 成员任务 inbox（human-in-the-loop） | `docs/zh/ledger/V4-PHASE16-FINAL.md` |
| 用量·成本账本 + 配额 fail-closed + 审计导出 | `docs/zh/ledger/V4-PHASE17-FINAL.md` |
| 联邦能力 manifest + 跨组织 policy + A2A 闭环 | `docs/zh/ledger/V4-PHASE18-FINAL.md` |
| `/me` 成员工作台 · workflow 治理 · 安全运维 · 联邦信任契约 · 生态接入 | `docs/zh/V4-PHASE19-P1..P5-FINAL.md` |
| 控制面历史趋势 + 告警阈值 + 跨 hub 聚合 | `docs/zh/ledger/V5-F-FINAL.md` |
| 跨 hub 工作流编排（北极星 第 2 层） · 两机操作员 runbook | `docs/zh/ledger/V5-G-FINAL.md` · `docs/zh/FEDERATION-RUNBOOK.md` |
| A2A 外部 agent 当工作流步（+ 会挂起的 H2） | `docs/zh/ledger/V5-H-FINAL.md` |
| 成员大白话改工作流（OpenClaw 式）+ 跨 hub 出入口锁 | `docs/zh/ledger/V5-WFEDIT-FINAL.md` |
| 成员大白话管理 hub 设置（管家 Stream SW） | `docs/zh/ledger/V5-STEWARD-FINAL.md` |
| 常驻个人管家（记忆 + 治理 tool-loop + fold 进 host；建之前设计见 DESIGN） | `docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md` · `docs/zh/ledger/PERSONAL-BUTLER-FINAL.md` · `docs/zh/PERSONAL-BUTLER-DESIGN.md` |
| 管家增强（观察面三读 + 诊断闭环 + create_workflow + ask_my_agent + 运行零 LLM 播报；五缝复用既有成员 surface） | `docs/zh/ledger/BUTLER-EMPOWER-FINAL.md` |
| 管家记忆增强（多级 / 重要性 / 召回索引 / dreaming / 技能 / 6h 维护） | `docs/zh/ledger/MEMORY-TIERS-FINAL.md` · `docs/zh/ledger/MEMORY-ADVANCED-FINAL.md` · `docs/zh/ledger/MEMORY-DREAMING-SKILLS-FINAL.md` |
| 家庭学习 hub（联邦设计 + go-live） | `docs/zh/FAMILY-LEARNING-HUB-DESIGN.md` · `docs/zh/FAMILY-LEARNING-GO-LIVE.md` |
| 资源适配（RES 只读探测 → 人批准应用） | `docs/zh/RES-RESOURCE-ADAPTATION.md` |
| UI 国际化（中英双语，检测 / 切换） | `docs/zh/I18N-PLAN.md` |
| 企业 SSO（OIDC · SAML） · 联邦 peer onboarding | `docs/zh/ledger/V6-ROUTE-B-P1-M4-OIDC.md` · `M5-SAML.md` · `M7-PEER-ONBOARDING.md` |
| 出站 A2A 持久化配置 · A2A 任务生命周期 · 真实 LLM 冒烟门 | `docs/zh/V6-ROUTE-B-P1-M11 / M8 / M13`（同目录） |
| 主流 agent 适配器契约 · 快捷接入（入站） | `docs/zh/AGENT-ADAPTER-CONTRACT.md` · `docs/zh/QUICK-CONNECT.md` |
| 出站 CLI shell-out adapter · 出站 ACP 长连接 adapter | `docs/zh/ledger/V5-E2-CLI-ADAPTER.md` · `docs/zh/ledger/V5-ACP-ADAPTER.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 完整审计报告 · 全量审计 2026-06-10 | `docs/zh/ledger/AUDIT-v4-phase5.md` · `docs/zh/ledger/AUDIT-2026-06-10-FULL.md` |
| 历史 commit 流水账 · 历史外部审计 | `CHANGELOG*.md` · `audits/`（`audits/README.md` 索引） |
| **全部里程碑逐字账本** | [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) |

---

## 六、目录结构速查

> 每个包的 per-Phase 演进细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) 与各包 `src/*` 顶注。

```
packages/                       33 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, 零 runtime
├── core/                       Hub / Scheduler / Storage / Participant (仅依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   users/credentials/sessions/vault/quota/peers/im_bindings/
│                               suspended_tasks/usage_ledger/totp/oidc/saml/a2a·acp_outbound
│                               (SQLite, 迁移到 v26+; SSO cert/token 走公钥或环境变量名, 不进 vault)
├── host/                       生产 host 二进制 (main.ts ~3.2K 行) — 装配层, 把所有包接成一个进程
│   └── src/                    local-agent-pool / org-api-pool / pricing / peer-registry /
│                               peer-manifest / outbound-approval / a2a-server / workflow-versioning /
│                               inbox-service / hub-steward-service / steward-approval /
│                               personal-butler-* / a2a-outbound / acp-outbound / oidc·saml-login …
├── web/                        admin UI HTTP + SSE + SPA; 鸭子 surface 注入, 零 host 运行时依赖;
│                               src/*-routes.ts + static/*.js (admin.js/app-core.js 经 esbuild bundle)
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML 工作流 runner — parseWorkflow / WorkflowRunner / RunStore /
│                               predicate / resolver / lifecycle 状态机 + 修订防漂移, 零 LLM dep
├── workflow-assistant/         WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow+llm
├── inbox/                      成员任务 inbox — InboxStore / FileInboxStore / HumanInboxParticipant
│                               broker (cap aipehub.human/v1), 只依赖 core
├── hub-steward/                管家 (大白话管理 hub 设置) — HubStewardAgent + 纯分类器 classifyStewardAction
│                               (四级 safe/dangerous/cross_hub/forbidden), 依赖 core+identity
├── personal-memory/            记忆引擎 — 冻结块护缓存 + 自动捕获 + 强制蒸馏 + 可换检索; 零 host/identity dep
├── personal-butler/            有界治理 tool-loop — PersonalButlerAgent + GovernedActionToolset
│                               (allow/approve/refuse 服务端权威, approve→SuspendTaskError→/me 收件箱)
├── a2a/                        A2A interop — message/send wire + a2aSend client + A2aRemoteParticipant
│                               (出站) + task lifecycle; 入站 A2aServer 在 host; 依赖 core
├── cli-agent/                  出站 CLI shell-out (hub 驱动 Claude Code/Codex/Aider…) — 五缝 + 动作闸
├── acp-agent/                  出站 ACP 长连接 (hub spawn 一次 hold session 反复派) — 五缝 + 逐动作权限闸
├── saml/                       SAML 2.0 SP 协议核 (DSig 交成熟库, 自写 SP 胶水 + XSW 防御, XML 隔离本包)
├── mcp-server/                 MCP server (Claude Desktop / Cursor 调 hub)
├── mcp-client/                 MCP client (agent 调外部 MCP tools)
├── services-sdk/               services plugin contract
├── service-memory-file/        memory(jsonl) · service-artifact-file/ artifact · service-datastore-sqlite/ sqlite
├── im-adapter/                 IM bridge 共享 SDK (ImBridge / parseImCommand)
├── im-telegram/ im-matrix/     长轮询 / Client-Server sync
├── im-lark/ im-slack/          官方长连接 / Socket Mode (免穿透)
├── im-discord/ im-qq/          Gateway WSS / 官方 Bot API webhook (入站需公网)
├── cli/                        aipehub CLI (start / repl / check / doctor / setting / connect / mint-peer-token)
└── evals/                      workflow / prompt 评测
python-sdk/                     PyPI `aipehub` (含 adapters/ LangGraph/CrewAI participant adapter)
templates/                      agents / teams / workflows / bundles / community
examples/                       45 个端到端 demo (上手 hub / 组织 hub / 跨 hub 编排 / adapter 桥…)
docs/  docs/zh/                 双语文档 (顶层=当前教程/参考; docs/zh/ledger/=52 篇逐里程碑账本;
                                docs/zh/PROGRESS-LEDGER.md = 全部里程碑逐字散文索引)
audits/ scripts/ monitoring/    审计快照 / backup·restore·verify·prune / prometheus+grafana
```


## 七、下一步建议清单(供 agent 起步时挑)

按"对北极星贡献度 / 工作量"排:

| 优先 | 任务 | 工作量 |
|---|---|---|
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/src/server.ts` (3563 行) 的 route groups~~ | **2026-05-28 三批完成** — batch 1 `workflow-routes.ts` (3701→3578); batch 2 `agents-routes.ts`/`services-routes.ts`/`uploads-routes.ts` (3578→2780); batch 3 `setup-routes.ts` (2780→2690) |
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/static/admin.js`~~ | **2026-05-29 完成** — esbuild bundler + 三 ES module (`services.js`/`managed-agents.js`/`workflows.js`); admin-src/main.js 3103→2344; workflow-start 共享渲染层故意留 main.js |
| ~~进行中~~ | ~~Phase 12 M9-M11 PWA + mobile responsive + 移动简化 shell~~ | **2026-05-29 完成** — PWA app-shell (manifest + sw.js + offline + icon, `/api/*` 不缓存) + 响应式 admin SPA (`@media` 720/420 单列 + 横滚表格 + 触控目标) + 5 PWA 测试; commit 7fe8a27 + c9dd395 |
| ~~中期~~ | ~~默认 RAG MCP server 推荐 + setup 文档~~ | **2026-05-28 完成** — `examples/rag-mcp/` (chroma-mcp) + `docs/zh/RAG-VIA-MCP.md` |
| 长期 | 微信小程序 / 其他原生入口 | 2-3 周 |

不要把这张表当 backlog 死磕 — 它只是"如果用户问'下面做什么'时, agent
不至于卡住"的备选。**用户指令 > 这张表**。
