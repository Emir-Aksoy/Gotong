# @aipehub/hub-steward — the hub steward (管家)

An **LlmAgent** that lets a member manage **their own** hub resources by talking
to it in plain language — the OpenClaw / Hermes "tell it and it configures things"
experience, made safe by AipeHub's North Star.

```
member 大白话指令
   │  「给我建一个总结邮件的助手」 / 「把工单工作流改得更礼貌些」 / 「删掉那个助手」
   ▼
HubStewardAgent (LLM)  ──►  StewardProposal { reply, actions: StewardAction[] }   ← 只提议，不执行
   ▼
host classify (server-authoritative)
   ├─ safe       → 内联执行（复用 HostMeAgentService / MeWorkflowEditService）
   ├─ dangerous  → 收件箱二次确认（delete_agent）          ┐ 用户硬约束:
   ├─ cross_hub  → 收件箱二次确认（跨 hub 工作流）          ┘ 危险 + 跨 hub 都再次确认
   └─ forbidden  → 拒绝执行，指路设置（凭证 / peer / 安全 / RBAC）
```

## What's in the box

- `types.ts` — the action vocabulary (`StewardAction`, `StewardActionTier`,
  `StewardProposal`, `ClassifiedProposal`). Pure data, no runtime deps.
- `classify.ts` — `classifyStewardAction(action, ctx)`: the server-authoritative,
  conservative risk tiering where the two hard constraints live. Reuses
  `authorizeAgentAction` (`@aipehub/identity`) as a forward-looking backstop for
  the highest-blast-radius verbs.
- `agent.ts` (SW-M2) — `HubStewardAgent extends LlmAgent`: the prompt + JSON
  extraction that produces a `StewardProposal`.

## North Star

The steward **proposes**; a **human reviews + executes**. It never silently
self-modifies the hub (unlike OpenClaw's "Developer Mode"). Dangerous and
cross-hub actions always route through a person via the Phase 16 inbox — the
framework runs no autonomous decision, and the person is a `Participant`. The
steward also cannot exceed what the member could do by hand: execution reuses the
member services, which carry the `resource_grants` RBAC + member limits.

> Host wiring (the plan / apply orchestration + the approval broker) lives in
> `@aipehub/host`; this package is just the agent + the shared vocabulary.
