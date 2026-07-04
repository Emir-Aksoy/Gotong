# Gotong 目标达成度审计

审计日期: 2026-05-31
审计方: Codex
审计对象: `main` at `a495d11`
审计目标: 判断项目是否已经达成“为个人管理人和多个智能体，为组织管理多个人 / agent / 集合节点的框架，并建立深度嵌入 AI 的灵活可扩展的个人和集体工作流”。

## 总体结论

结论: **主体架构已经达成，产品闭环还未完全达成**。

Gotong 的核心抽象、包边界和运行模型基本符合设计目标:

- Hub 仍然是路由 / transcript / scheduler，不直接拥有智能；人和 agent 统一为 `Participant`。
- 单机个人模式、v4 identity、roles / invitations / sessions / audit / vault / quota 已形成可用组织层。
- Host-managed LLM agent、streaming、多模态、MCP tool、agent dispatch toolset、workflow assistant 已经把 AI 深度嵌入工作流创建和执行链路。
- Federation 把另一个 hub 包成 `RemoteHubViaLink`，支持 origin / ACL / ancestry 透传，具备“集合节点”模型。
- IM bridge、REPL、PWA/mobile shell 让入口不只限于浏览器 admin。

但要说“已经完整达成设计目标”，还差几个高优先级缺口。最重要的是: v4 登录身份没有真正接到旧 admin 操作面，导致多用户组织管理 agent/workflow 的权限链断裂；workflow 安全与长期任务语义还没有跟 Phase 10/11 的能力完全对齐；AI workflow assistant 的 deepCheck 与运行时 scheduler 语义存在不一致，可能把运行时不可执行的 workflow 标成 OK。

我的判断是:

- 架构达成度: **高**
- 单人个人 hub 达成度: **中高**
- 多人组织管理达成度: **中高，但被 v4/admin auth 断点拖住**
- 集合节点 / federation 达成度: **中高**
- AI 嵌入工作流达成度: **高，但 workflow runner 对 suspend/循环边界仍需补齐**
- 面向真实用户的完整产品达成度: **中**

## 审计范围

本次读了以下关键层:

- `packages/protocol`, `packages/core`: Participant、Task、dispatch、scheduler、transcript、ancestry、suspend/resume。
- `packages/identity`, `packages/host`, `packages/web`: v4 用户 / 组织 / admin API / personal mode / vault / quota / host-managed agents。
- `packages/llm`, `packages/workflow`, `packages/workflow-assistant`, `packages/evals`: LLM agent、tool loop、workflow runner、AI workflow draft 和 deepCheck。
- federation / IM / CLI 相关包和文档: peer link、remote hub、IM bridge shared model、REPL、PWA/个人模式文档。

工作区规模快照:

- `packages`: 27 个包
- `examples`: 24 个示例包
- TypeScript test/spec 文件: 214 个
- Python SDK test 文件: 7 个

## 关键证据

设计目标已有坚实实现证据:

- `ParticipantKind = 'agent' | 'human'`: `packages/protocol/src/types.ts:15`
- `Participant` 统一抽象和 resume hook: `packages/core/src/types.ts:34`
- `HumanParticipant` 作为一等参与者: `packages/core/src/participants/human.ts:33`
- `AgentParticipant` 和 suspend 控制流: `packages/core/src/participants/agent.ts:24`
- Hub 注释明确“不拥有 agent intelligence”: `packages/core/src/hub.ts:127`
- Hub 必须显式选择 disk space 或 storage: `packages/core/src/hub.ts:191`
- personal mode bootstrap / auto-detect / team flip: `packages/identity/src/store.ts:635`, `packages/identity/src/store.ts:722`, `packages/identity/src/store.ts:743`, `packages/identity/src/store.ts:1441`
- `/me` route 强制 user scope 和 per-user origin: `packages/web/src/me-routes.ts:1`, `packages/web/src/me-routes.ts:241`
- Org-level LLM key pool 和 quota gate: `packages/host/src/org-api-pool.ts:191`, `packages/host/src/org-api-pool.ts:297`
- LLM stream / tool / quota / auth-failure hook: `packages/llm/src/agent.ts:63`
- Agent 调度子 agent 的 `DispatchToolset`: `packages/llm/src/dispatch-toolset.ts:1`, `packages/llm/src/dispatch-toolset.ts:241`
- Federation ACL 和 origin/ancestry 透传: `packages/core/src/peer-link-install.ts:32`, `packages/core/src/peer-link-install.ts:248`
- Remote hub 作为普通 `Participant`: `packages/core/src/participants/remote-hub.ts:103`

详细问题见 [findings.md](findings.md)。验证记录见 [verification.md](verification.md)。
本轮 4 个高优先级问题的修复追踪见 [remediation.md](remediation.md)。

## 结论性建议

建议下一轮只做一组“目标闭环修复”，不要先扩新入口:

1. 统一 v4 identity 和 legacy admin auth，让 owner/admin 的 v4 session 能访问 agent/workflow/services/vault 等 admin 操作面。
2. 补齐 workflow runner 的 ancestry / cycle / deepCheck enforcement 策略，至少让 admin import 能跑同一套 runtime-aware check。
3. 明确 workflow 遇到 suspended child task 的语义: 要么 workflow run 自身 suspended 并可 resume，要么显式不支持并给出清晰错误，而不是 `unexpected ok in failure path`。
4. 修正 workflow deepCheck 对多 capability 的判定，和 `Registry.byCapabilities(required.every)` 保持一致。

完成这四项后，再审计一次“个人和组织工作流是否端到端闭环”，项目会更接近可对外宣称达成北极星。
