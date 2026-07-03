# docs/zh/ledger/ — 开发档案层（历史记录，不是教程）

> 这里的文档是**逐里程碑的开发记录**：某个 Phase / Stream / Route 怎么建的、
> 审计发现了什么、当时的设计权衡。你**为了解历史与出处**读它们，**不是为了学怎么用**
> 系统。想上手 / 用，看上一层 `docs/zh/`（教程 + 参考），别从这里开始。

## 为什么单独一层

`docs/zh/` 顶层曾经平铺着 110+ 篇文档，其中 50+ 篇是 `*-FINAL` / `V4-PHASE*` /
`AUDIT-*` 这样的账本，把 `OVERVIEW` / `ARCHITECTURE` / `HANDS-ON-HUBS` 这些真正的
上手文档压在底下——新人打开 `docs/zh/` 先撞见一堵「V4-PHASE17-FINAL」的墙（缺口 2）。

DOC-M2 把这 52 篇账本挪进 `docs/zh/ledger/`，让顶层只剩当前该读的教程 / 参考。
每篇文档的内容一字未改，只搬了位置、修了指向它们的链接（搬动引入的坏链 = 0，验证过）。

- **想按时间线读全部里程碑的逐字账本** → 上一层的 [`../PROGRESS-LEDGER.md`](../PROGRESS-LEDGER.md)（散文式索引，带 commit）。
- **想知道「某能力现在怎么用」** → 上一层的对应文档，或根 `CLAUDE.md` §五 文档地图。

## 档案分组

**审计快照**
- [AUDIT-2026-06-10-FULL.md](AUDIT-2026-06-10-FULL.md) · [AUDIT-v4.md](AUDIT-v4.md) · [AUDIT-v4-phase3.md](AUDIT-v4-phase3.md) · [AUDIT-v4-phase5.md](AUDIT-v4-phase5.md)

**v4（组织化 + 联邦地基，Phase 4→19）**
- 架构 / 路线：[V4-ARCH.md](V4-ARCH.md) · [V4-PHASE4.md](V4-PHASE4.md) · [V4-PHASE7-13-PLAN.md](V4-PHASE7-13-PLAN.md) · [V4-PHASE19-PLAN.md](V4-PHASE19-PLAN.md)（PLAN 为 gitignore 草稿，可能不在仓库里）
- 各 Phase FINAL：[5](V4-PHASE5-FINAL.md) · [7](V4-PHASE7-FINAL.md) · [8](V4-PHASE8-FINAL.md) · [9](V4-PHASE9-FINAL.md) · [10](V4-PHASE10-FINAL.md) · [11](V4-PHASE11-FINAL.md) · [12](V4-PHASE12-FINAL.md) · [14](V4-PHASE14-FINAL.md) · [15](V4-PHASE15-FINAL.md) · [16](V4-PHASE16-FINAL.md) · [17](V4-PHASE17-FINAL.md) · [18](V4-PHASE18-FINAL.md) · [19-P1](V4-PHASE19-P1-FINAL.md) · [19-P2](V4-PHASE19-P2-FINAL.md) · [19-P3](V4-PHASE19-P3-FINAL.md) · [19-P4](V4-PHASE19-P4-FINAL.md) · [19-P5](V4-PHASE19-P5-FINAL.md)
- 专题：[EXAMPLES-V4-PHASE5.md](EXAMPLES-V4-PHASE5.md) · [PHASE9-MULTIMODAL-RFC.md](PHASE9-MULTIMODAL-RFC.md)

**v5（跨 hub 编排 + 管家 + 出站适配器，Stream 0→H）**
- 收口：[0](V5-0-FINAL.md) · [A](V5-A-FINAL.md) · [B](V5-B-FINAL.md) · [C](V5-C-FINAL.md) · [D](V5-D-FINAL.md) · [E4](V5-E4-FINAL.md) · [E5](V5-E5-FINAL.md) · [F](V5-F-FINAL.md) · [G](V5-G-FINAL.md) · [H](V5-H-FINAL.md) · [STEWARD](V5-STEWARD-FINAL.md) · [WFEDIT](V5-WFEDIT-FINAL.md)
- 出站适配器：[V5-E2-CLI-ADAPTER.md](V5-E2-CLI-ADAPTER.md) · [V5-ACP-ADAPTER.md](V5-ACP-ADAPTER.md)

**v6 Route-B（企业 SSO + A2A 出站生命周期，P1 M4→M13）**
- [M4-OIDC](V6-ROUTE-B-P1-M4-OIDC.md) · [M5-SAML](V6-ROUTE-B-P1-M5-SAML.md) · [M7-PEER-ONBOARDING](V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md) · [M8-A2A-LIFECYCLE](V6-ROUTE-B-P1-M8-A2A-LIFECYCLE.md) · [M11-A2A-OUTBOUND](V6-ROUTE-B-P1-M11-A2A-OUTBOUND.md) · [M13-LIVE-GATE](V6-ROUTE-B-P1-M13-LIVE-GATE.md)

**能力深潜（当前仍是该能力唯一全链路细节，但按开发记录风格写）**
- 记忆：[MEMORY-TIERS-FINAL.md](MEMORY-TIERS-FINAL.md) · [MEMORY-ADVANCED-FINAL.md](MEMORY-ADVANCED-FINAL.md) · [MEMORY-DREAMING-SKILLS-FINAL.md](MEMORY-DREAMING-SKILLS-FINAL.md)
- 管家：[PERSONAL-BUTLER-FINAL.md](PERSONAL-BUTLER-FINAL.md) · [PERSONAL-BUTLER-FOLD-IN-FINAL.md](PERSONAL-BUTLER-FOLD-IN-FINAL.md) · [BUTLER-EMPOWER-FINAL.md](BUTLER-EMPOWER-FINAL.md)

## 还没搬的

顶层 `docs/zh/` 仍留着几篇 `*-DESIGN` / `*-RFC` / `TECH-DEBT-*` —— 它们介于「设计出处」
与「当前参考」之间，**归类是判断题，留给 DOC-M3（主线金字塔重排）一起定**，不在本次
机械搬迁范围内。3 篇 `*-PLAN` / `*-ROADMAP` 草稿是 gitignore 的本地工作稿，不在仓库里。
