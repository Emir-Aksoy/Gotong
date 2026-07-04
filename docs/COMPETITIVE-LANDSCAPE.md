# Competitive & Ecosystem Landscape: Real-Workflow Embedding × Multi-Person Multi-Agent Collaboration

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/COMPETITIVE-LANDSCAPE.md) · [日本語](ja/COMPETITIVE-LANDSCAPE.md) · [Русский](ru/COMPETITIVE-LANDSCAPE.md) · [Français](fr/COMPETITIVE-LANDSCAPE.md) · [Español](es/COMPETITIVE-LANDSCAPE.md) · [한국어](ko/COMPETITIVE-LANDSCAPE.md). If a translation conflicts with this English version, the English version governs.

> Survey date 2026-05-29. Covers 30+ projects/protocols across four tracks. Written for both agent and human readers.
> One-line conclusion: **no single competitor has all four of Gotong's pillars at once** — a dumb hub (decisions live in the participants) / human = agent as one unified `Participant` / files as state / org-sovereign federation. The market is sliced into four blocks, each holding one or two pillars and missing the rest.
>
> Companion reading: [`PRODUCT-MATRIX.md`](PRODUCT-MATRIX.md) (2026-06-21) — a product-level head-to-head matrix (one strengths table, one weaknesses table) + "which under-served user with a real need we fit best" + how DeepSeek's price cut unlocks that cell. This doc is the track map; that one is the product-level target-user judgment.

---

## 1. Track map

| Track | Representative players | Their shared stance | Fundamental difference from us |
|---|---|---|---|
| **① Multi-agent orchestration frameworks** (library-level) | AutoGen→AG2 / MS Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, CAMEL, Semantic Kernel, Google ADK, LlamaIndex Workflows, Pydantic AI | **The framework is the brain** — the library runs the LLM itself, holds the control loop / turn-taking / SOP itself | The hub is a dumb router; decisions always stay in the participants' hands |
| **② Agent interop protocols** | MCP, A2A, (IBM ACP→folded into A2A), AGNTCY/SLIM, NANDA, LMOS, Matrix, ANS/OIDC-A | Collectively absorbed into the **Linux Foundation** in H2 2025, layered into "tool layer (MCP) + agent layer (A2A)" | MCP already implemented; the federation layer is home-grown and should align to A2A |
| **③ AI workflow automation platforms** (low-code / product-level) | n8n, Zapier Agents, Make, Activepieces, Windmill, Gumloop, Relay, Lindy, Sema4, Copilot Studio, Dify, Flowise | **LLM welded into the canvas** as a node; **the human is a "pause / wait-for-approval" node** | The runner has zero LLM (declarative) + the human is a Participant who receives tasks |
| **④ Self-hosted platforms / durable execution / chat-as-hub** | Dify, Flowise, Langflow, Rivet, LibreChat, Open WebUI, AnythingLLM; Temporal, Inngest, Restate, DBOS; Slack+Agentforce, Mattermost, Rocket.Chat, LangBot, Letta | State locked in DB/cloud; durable engines are just headless backends; chat hubs have no suspend/resume | bridge+hub+agent+file-state packaged into one self-hosted binary |

---

## 2. Positioning

> Others are either "**the framework is the brain**" (①), or "**LLM welded into the canvas, human as an approval node**" (③), or "**just a backend engine / just a message bridge**" (④). Gotong is "**dumb hub + human as participant + files as state + org-sovereign federation**" — a **collaboration substrate**, not yet another in-process orchestrator.

---

## 3. Moat (architectural advantages)

1. **Dumb hub / decisions in the participants** — none of ① is a passive router; all run the LLM in-process and hold the decision. Only LlamaIndex Workflows' "you own the loop" spirit comes close, but it's still an in-process event engine. Not locked to any single vendor SDK — the serial churn of Swarm→Agents SDK and AutoGen→MAF is exactly what proves the risk of "runtime coupling."
2. **The human and the agent are the same `Participant`** — every competitor models the human as a special case: UserProxyAgent (AutoGen) / interrupt (LangGraph) / deferred-tool (Pydantic) / graph node (ADK) / "Human Input" node (Dify) / Outlook approval form (Copilot). **None of them makes the human and the agent equal peers on the same message+task+transcript bus.**
3. **Files as state, portable and auditable** — competitor state lives in in-mem / SQLite / Postgres / Redis / Mongo / vendor cloud. The closest are merely a single SQLite file (Flowise/Open WebUI), queryable Postgres rows (DBOS), or a YAML graph definition (Rivet). **None stores transcript+agents+sessions+secrets+vault all as plain files you can grep/diff/rsync/hand-edit.** "Copy the directory = move the room" is the strongest differentiator.
4. **Per-org encrypted vault + per-org API quota as first-class citizens** — Windmill (workspace-key encryption) and Copilot (Key Vault) come closest, but none models "per-org isolated credential store + per-org LLM quota" as a federation-aware boundary. The protocol layer (A2A/MCP) only goes as far as "declare an auth scheme," with nothing about secret storage or quota.
5. **Cross-org federation + credentials/data/billing each stays home** — the clearest blank space. ③ is all single-tenant or single-vendor SaaS, where team/workspace only partition within one deployment; ④'s engines are just backends. **None offers open P2P federation that lets a workflow cross an org boundary while each org keeps its own credentials/data/quota.** And **"cross-hub HITL" (a human in org B satisfying a task initiated by org A) isn't even covered by A2A (the 150+ org standard)** — A2A only has an `input-required` task state, with no cross-org human-participant model.

---

## 4. Weaknesses (the honest list)

1. **Integration/connector breadth** — the biggest real-world moat is on the other side: Zapier 8000+, Make 3000+, Lindy 4000+, n8n 1200+. We currently have nearly zero.
2. **UX polish + NL orchestration** — Make's Reasoning Panel, Gumloop's "Gummie" NL→workflow, Relay's HITL experience are all far more mature than YAML-first (even with an NL→YAML assistant).
3. **Durability maturity** — Temporal (signal + indefinite zero-resource waits + event replay) / DBOS (durable sleep for weeks) / Inngest / Restate are **years ahead** on suspend/resume. Our `SuspendTaskError`+SQLite sweep is conceptually the same, but young, single-node, with weaker guarantees.
4. **Enterprise governance** — the SSO/audit/compliance stories of Copilot (Entra ID+Key Vault+fine-grained RBAC), Windmill (5 roles+folder ACL), and Lindy/Sema4 (SOC2/HIPAA) are things we haven't built.
5. **Multi-agent orchestration UX** — Flowise Agentflow (supervisor/worker, conflict resolution, dynamic roles), Lindy Agent Swarms, Zapier agent-to-agent calling are all finished product UIs; we only have dispatch primitives.
6. **IM breadth isn't unique** — LangBot already bridges more platforms (+DingTalk/LINE/KOOK/WeChat Official Accounts) and is backend-agnostic. "6 bridges" isn't a moat on raw breadth — the moat is "a hub with file state and a participant model, where the hub is just a router."
7. **Ecosystem / mind share** — the other side has 50k–110k stars (CrewAI 52k, MetaGPT 68k, Dify 110k+); we're early.

---

## 5. Interop protocol layer (the most actionable alignment target)

In H2 2025, interop protocols were collectively absorbed into the Linux Foundation and split into two layers, with Gotong straddling both:

- **Tool layer (agent↔tool): MCP wins outright.** 2025-12 Anthropic donated it to the LF-hosted **Agentic AI Foundation (AAIF)** (co-built with OpenAI/Block), ~97M monthly downloads, ~10k servers.
- **Agent layer (agent↔agent cross-org): A2A wins outright.** Joined LF 2025-06; **absorbed IBM ACP** 2025-08; at its one-year mark, **150+ organizations** in production use.
- The rest stack above and below: **AGNTCY/SLIM** = infrastructure/transport plane; **NANDA** = research-grade identity trust (DID+AgentFacts); **Matrix** = our philosophical cousin (federation, sovereignty, state on your own server).

| Protocol | Layer | Governance | Cross-org identity | Transport/semantics | Adoption |
|---|---|---|---|---|---|
| **MCP** | tool calls | Anthropic→AAIF/LF | OAuth2.1+PKCE+RFC8707 (client↔server) | both (JSON-RPC/stdio/Streamable HTTP) | dominant |
| **A2A** | agent↔agent | Google→LF | Agent Card declares OAuth2/OIDC/API-key/mTLS | both (JSON-RPC/HTTPS+SSE) | 150+ orgs |
| ACP (IBM) | agent↔agent | →folded into A2A (2025-08) | (folded) | — | deprecated |
| AGNTCY+SLIM | discovery+identity+**transport** | Cisco→LF | decentralized Agent Identity Service | SLIM=transport (gRPC/H2/H3), carries A2A/MCP | 75+ companies |
| NANDA | discovery+identity+economy | MIT Media Lab | DID+verifiable credentials+AgentFacts | semantic (registry) | research/not live |
| Matrix | federated message **transport** | Matrix.org | homeserver-federated MXID | transport | 60M+ users |

**Gotong federation primitives → standard mapping:**

| Our primitive | Aligned standard | Conclusion |
|---|---|---|
| `peerToken` | A2A auth scheme (Bearer/OAuth2/OIDC/mTLS) | **Align** — re-express as an A2A-declared scheme |
| `Task.origin` | A2A Task metadata / OIDC-A delegation chain | **Ahead** — keep, map to A2A Task metadata |
| inbound ACL | A2A "opaque agents" + selective disclosure | keep, semantically aligned |
| per-org vault | (no standard covers it) | **unique, keep** |
| per-org quota (OrgApiPool) | (no standard; approximates NANDA's economic layer, in research) | **unique, keep** |
| peer registry + reputation | A2A registry / NANDA Index / ANS | long-term align, track the NANDA verifiable direction |
| cross-hub HITL | **no protocol covers it** | **unique + hits the north star** |

---

## 6. Enhancement directions (sorted by "leverage / contribution to the north star")

**🔴 High leverage**
1. **Align to A2A (single highest-value move)** — expose `/.well-known/agent-card.json`, re-express `peerToken` as an A2A-declared Bearer/OAuth2/mTLS scheme, so an Gotong hub can federate with the 150+ org A2A ecosystem, not just Gotong↔Gotong. The end-to-end `Task.origin` provenance is actually ahead of A2A's current spec.
2. **Fill integration breadth via the MCP ecosystem**, rather than building our own connectors — MCP is already LF-hosted with ~10k servers. Make "integration capability = install an MCP server" a first-class onboarding, turning the other side's "8000 connectors" moat into "embracing an open standard."
3. **Upgrade dispatch primitives into reusable orchestration templates** — build supervisor/worker, debate, swarm-parallel into `templates/`, matching the finished experience of Flowise Agentflow / Lindy Swarms (architect-team already lays a base).

**🟡 Medium leverage**
4. **Durability: honest calibration + optional strong backend** — document a truthful comparison of our vs Temporal/DBOS guarantee boundaries; consider an optional **DBOS/Temporal-backed mode** to carry suspend/resume (DBOS is a library with state in your own Postgres, the best fit for the "state is visible to you" ethos).
5. **HITL handoff UX polish** — conceptually beats Slack/Rocket.Chat, but lacks finished escape hatches: build "hand off to a human with full context / multi-person approval / timeout escalation" as out-of-the-box templates.
6. **Enterprise governance fill-in** — SSO (OIDC/SAML), audit logs, fine-grained RBAC, to clear the bar for org scenarios.

**🟢 Watch / long-term**
7. **Watch the identity-trust layer** — NANDA (DID+AgentFacts) / ANS / OIDC-A delegation chain are the verifiable future version of "peer registry + reputation," none yet approved as a standard, so **don't adopt now**, track it.
8. **Positioning narrative** — externally make clear "**edge-A2A/MCP-native, but carrying the org-boundary primitives the wire protocols deliberately ignore (vault / quota / cross-org HITL / origin provenance)**."

**Net conclusion**: don't go compete with Temporal/DBOS on durability, or Dify/n8n on integration breadth. The defensive wedge is **that combination**: file-first portability + human as participant + multiple IM-native bridges + good-enough suspend/resume, all packed into one self-hosted OSS binary. The two things most worth filling: **A2A alignment** (for ecosystem reach) + **integration via the MCP route**.

---

## 7. Key references

**Protocols**
- MCP→AAIF/LF: anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ; linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- A2A→LF: linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project... ; 150+ orgs: linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations...
- ACP→A2A: lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a...
- A2A discovery/Agent Card: a2a-protocol.org/dev/topics/agent-discovery/
- AGNTCY/SLIM: outshift.cisco.com/blog/building-the-internet-of-agents-introducing-the-agntcy ; datatracker.ietf.org/doc/draft-mpsb-agntcy-slim
- NANDA: arxiv.org/abs/2507.07901 ; media.mit.edu (Beyond DNS / AgentFacts)

**Frameworks**
- AG2: github.com/ag2ai/ag2 ; MS Agent Framework: github.com/microsoft/agent-framework
- CrewAI: github.com/crewAIInc/crewAI ; LangGraph: github.com/langchain-ai/langgraph
- OpenAI Agents SDK: openai.github.io/openai-agents-python ; MetaGPT: github.com/FoundationAgents/MetaGPT
- Google ADK + A2A: google.github.io/adk-docs/a2a/ ; Pydantic AI: github.com/pydantic/pydantic-ai

**Platforms / engines**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify (Human Input node: releases/tag/1.13.0) ; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
