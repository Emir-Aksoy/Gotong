# AipeHub 中文文档 · 阅读金字塔

<!-- doc-version: 2.0 -->
> **文档版本 2.0** · 2026-07-02 重排为「教程 → 理解 → 动手 → 上线 → 社区 → 出处」六级金字塔。
> 逐里程碑账本（52 篇 `*-FINAL` / `V4-PHASE*` / `AUDIT-*`）已下沉到 [`ledger/`](ledger/README.md)，
> 顶层只留当前该读的。**从上往下读**：越靠前越是新人先看的，越靠后越是深潜 / 历史。

---

## ① 从这里开始（先跑起来）

> 目标：5 分钟从零到屏幕上一个真实的多方协作结果。

- [`../../QUICKSTART.md`](../../QUICKSTART.md) — **do-this → see-that 上手漏斗**（零 key 先跑 `pnpm demo`）
- [`OVERVIEW.md`](OVERVIEW.md) — 5 分钟读懂这是什么、为什么这么设计
- [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) — 五个开箱即抄的 hub 对照
- [`EXAMPLES.md`](EXAMPLES.md) — **50 个 demo 的分级索引**（先跑哪个 → 深到哪；绝大多数零前置）
- [`LEARN.md`](LEARN.md) — 社区精选视频 / 教程

## ② 理解为什么这么建（设计心智）

> 目标：读完知道 AipeHub 的立场，改代码不跑偏。

- [`CHARTER.md`](CHARTER.md) — 项目宪章（北极星三不可破 · 信任护城河；与代码冲突时宪章为源）
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 框架设计哲学 + 模块边界
- [`SURFACE-PATTERN.md`](SURFACE-PATTERN.md) — 给框架加能力而不加耦合（host↔web 鸭子 surface 注入；web 不依赖 host）
- [`CONVENTIONS.md`](CONVENTIONS.md) — 让 AipeHub 保持轻的惯例 + GUARD 承重门（依赖方向 / 旋钮登记 / 行数预算）
- [`PROTOCOL.md`](PROTOCOL.md) — Wire 协议规约（写自己语言的 SDK 看这）
- [`DEPLOYMENT-PROFILE.md`](DEPLOYMENT-PROFILE.md) — 部署视角 `AIPE_PROFILE=hub|federation`（hub 内 vs 跨 hub；呈现视角非行为开关）
- [`PERSONAL-MODE.md`](PERSONAL-MODE.md) — 个人 / 主权 hub 心智
- [`COMPETITIVE-LANDSCAPE.md`](COMPETITIVE-LANDSCAPE.md) · [`PRODUCT-MATRIX.md`](PRODUCT-MATRIX.md) — 赛道地图 + 产品级矩阵

## ③ 动手用 / 建（能力 how-to）

> 目标：把 agent / 工作流 / 模板 / 连接器真正接起来。

**Agent 接入**
- [`PARTICIPANT.md`](PARTICIPANT.md) — **20 行写一个 Participant**（框架的唯一扩展面：agent / 人 / 服务同一个契约）
- [`AGENT.md`](AGENT.md) — 把它接进已在跑的 hub（in-process vs remote SDK）
- [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md) — 主流 agent 适配器契约（双向 + 可快速接管验收门）
- [`QUICK-CONNECT.md`](QUICK-CONNECT.md) — 入站快捷接入

**工作流**
- [`WORKFLOW-ARCHITECT.md`](WORKFLOW-ARCHITECT.md) — 大白话 → YAML + 讲解 + 配图
- [`WORKFLOW-WIZARD.md`](WORKFLOW-WIZARD.md) — 六段建流向导（盘点组件 → 组装 → 衡量缺口 → 用户同意 → 校验闭环）
- [`AI-WORKFLOW-EDITOR.md`](AI-WORKFLOW-EDITOR.md) — 成员大白话改工作流
- [`WORKFLOW-DAG-VIZ.md`](WORKFLOW-DAG-VIZ.md) — 只读 DAG 可视化

**模板 / 连接器 / 知识库**
- [`TEMPLATES.md`](TEMPLATES.md) · [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md) · [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) — 不写代码导入 / 分享模板
- [`MCP.md`](MCP.md) · [`MCP-CONNECTOR-DIRECTORY.md`](MCP-CONNECTOR-DIRECTORY.md) — MCP client + server + 连接器目录
- [`KB-CONNECTORS.md`](KB-CONNECTORS.md) · [`RAG-VIA-MCP.md`](RAG-VIA-MCP.md) — 知识库 / RAG（全走 MCP，框架不存知识）

**运维 / 易用 / IM / 人在环**
- [`SETTING-OPS-CONSOLE.md`](SETTING-OPS-CONSOLE.md) — 统一 `setting` 运维控制台
- [`EASE-OF-USE-DEEPENING.md`](EASE-OF-USE-DEEPENING.md) — 失败修复入口 / 配置体检 / 启动兜底
- [`RES-RESOURCE-ADAPTATION.md`](RES-RESOURCE-ADAPTATION.md) — 资源适配（只读探测 → 人批准）
- [`IM-BRIDGES.md`](IM-BRIDGES.md) · [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md) — IM 桥接
- [`HUMAN.md`](HUMAN.md) · [`HITL-GLOSSARY.md`](HITL-GLOSSARY.md) — 人作为 Participant / HITL 术语
- [`WORKSPACE-JAIL.md`](WORKSPACE-JAIL.md) · [`SIDECAR.md`](SIDECAR.md) — 文件围栏 / sidecar

## ④ 上线 / 运维（把它跑到生产）

> 目标：从本机走到真实部署，三拓扑 + 联邦。

- [`GO-LIVE.md`](GO-LIVE.md) — 上线 runbook（T1 家用 / T2 云 / T3 联邦）
- [`DEPLOY.md`](DEPLOY.md) · [`PORTABLE-BUNDLE.md`](PORTABLE-BUNDLE.md) — 部署 / 便携包分发
- [`PROD-HARDENING-RUNBOOK.md`](PROD-HARDENING-RUNBOOK.md) · [`PRE-LAUNCH-TEST-PLAN.md`](PRE-LAUNCH-TEST-PLAN.md) · [`REAL-WORLD-TESTING.md`](REAL-WORLD-TESTING.md) — 生产加固 / 上线前测试 / 真机测试
- [`CLOUD-RESOURCE-FOOTPRINT.md`](CLOUD-RESOURCE-FOOTPRINT.md) — 云资源占用
- [`FEDERATION.md`](FEDERATION.md) · [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) · [`HUB-MESH.md`](HUB-MESH.md) — 跨 hub 联邦（两机操作员）
- [`REPUTATION-ROUTING.md`](REPUTATION-ROUTING.md) · [`SECURITY.md`](SECURITY.md) — 信誉路由 / 安全

**跟练一个完整场景**：[`FAMILY-LEARNING-HUB-DESIGN.md`](FAMILY-LEARNING-HUB-DESIGN.md) → [`FAMILY-LEARNING-GO-LIVE.md`](FAMILY-LEARNING-GO-LIVE.md)（家庭学习 hub，从设计到上线）

## ⑤ 社区 / 治理

- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`GOVERNANCE.md`](GOVERNANCE.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) · [`MAINTAINERS.md`](MAINTAINERS.md) — 贡献 / 治理 / 行为准则 / 维护者
- [`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md) · [`CONTRIBUTORS.md`](CONTRIBUTORS.md) — 荣誉激励 + 贡献者名册
- [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md) · [`COMMUNITY-DISCUSSIONS.md`](COMMUNITY-DISCUSSIONS.md) — 零算力社区站 / Discussions
- [`LICENSE-FAQ.md`](LICENSE-FAQ.md) · [`I18N-PLAN.md`](I18N-PLAN.md) — 协议 FAQ / i18n

## ⑥ 设计出处 · 深潜 · 历史

> 读这些是为了解「怎么建的 / 当时怎么想的」，不是为了学怎么用。

- **设计出处（建之前的 RFC / DESIGN）**：[`PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md) · [`MEMORY-DREAMING-SKILLS-DESIGN.md`](MEMORY-DREAMING-SKILLS-DESIGN.md) · [`PERSONAL-HUB-RFC.md`](PERSONAL-HUB-RFC.md) · [`TECH-DEBT-2026-05.md`](TECH-DEBT-2026-05.md)
- **逐里程碑账本（52 篇）** → [`ledger/`](ledger/README.md)（v4 phases / v5 streams / v6 route-B / 审计 / 能力深潜）
- **全部里程碑逐字散文索引** → [`PROGRESS-LEDGER.md`](PROGRESS-LEDGER.md)

---

## 关于中英双语

本仓文档以中文为主。少数文档镜像 `../` 下的英文原文（`OVERVIEW` / `HUMAN` / `AGENT` /
`DEPLOY` / `FEDERATION` / `LICENSE-FAQ` 等）——**这几篇以英文版为权威**，中英冲突以英文为准，
欢迎 PR 同步。翻译约定：`Hub` / `Participant` / `Task` / `capability` / `transcript` /
`dispatch` 保留原文不译；代码块 / 命令 / 链接路径原样保留。PR 流程见
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)。
