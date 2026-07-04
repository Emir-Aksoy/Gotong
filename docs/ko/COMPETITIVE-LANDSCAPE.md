# 경쟁 및 생태계 지형: 실제 워크플로우 임베딩 × 다인 다중 에이전트 협업

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../COMPETITIVE-LANDSCAPE.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

> 조사 날짜 2026-05-29. 네 개 트랙에 걸쳐 30개 이상의 프로젝트/프로토콜을 다룹니다. 에이전트와 인간 독자 모두를 위해 작성되었습니다.
> 한 줄 결론: **어떤 단일 경쟁자도 Gotong의 네 가지 기둥을 동시에 갖추고 있지 않습니다** — 멍청한 허브(의사 결정은 참여자에게 있음) / 인간 = 에이전트(통합된 `Participant`) / 상태로서의 파일 / 조직 주권 연합. 시장은 네 블록으로 나뉘어, 각각 하나 또는 두 개의 기둥을 보유하고 나머지는 결여하고 있습니다.
>
> 함께 읽을 자료: [`PRODUCT-MATRIX.md`](../PRODUCT-MATRIX.md) (2026-06-21) — 제품 수준의 일대일 비교 매트릭스 (강점 표 하나, 약점 표 하나) + "실제 필요를 가진 어떤 미충족 사용자에게 맞는가" + DeepSeek의 가격 인하가 그 셀을 어떻게 열어주는지. 이 문서는 트랙 맵이고; 저것은 제품 수준의 타깃 사용자 판단입니다.

---

## 1. 트랙 맵

| 트랙 | 대표 플레이어 | 공유 입장 | 우리와의 근본적 차이 |
|---|---|---|---|
| **① 다중 에이전트 오케스트레이션 프레임워크** (라이브러리 수준) | AutoGen→AG2 / MS Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, CAMEL, Semantic Kernel, Google ADK, LlamaIndex Workflows, Pydantic AI | **프레임워크가 두뇌** — 라이브러리가 LLM을 직접 실행하고, 제어 루프 / 순서 / SOP를 자체적으로 보유 | 허브는 멍청한 라우터; 의사 결정은 항상 참여자의 손에 있음 |
| **② 에이전트 상호운용 프로토콜** | MCP, A2A, (IBM ACP→A2A에 통합), AGNTCY/SLIM, NANDA, LMOS, Matrix, ANS/OIDC-A | 2025년 하반기에 집단적으로 **리눅스 재단**에 흡수, "도구 계층(MCP) + 에이전트 계층(A2A)"으로 계층화 | MCP는 이미 구현; 연합 계층은 자체 개발이며 A2A에 정렬해야 함 |
| **③ AI 워크플로우 자동화 플랫폼** (로우코드 / 제품 수준) | n8n, Zapier Agents, Make, Activepieces, Windmill, Gumloop, Relay, Lindy, Sema4, Copilot Studio, Dify, Flowise | LLM이 캔버스의 노드로 **용접**; **인간은 "일시 중지 / 승인 대기" 노드** | 러너는 LLM 없음(선언적) + 인간은 태스크를 받는 참여자 |
| **④ 자체 호스팅 플랫폼 / 내구성 있는 실행 / 채팅 허브** | Dify, Flowise, Langflow, Rivet, LibreChat, Open WebUI, AnythingLLM; Temporal, Inngest, Restate, DBOS; Slack+Agentforce, Mattermost, Rocket.Chat, LangBot, Letta | DB/클라우드에 상태 잠금; 내구성 엔진은 단순한 헤드리스 백엔드; 채팅 허브에는 suspend/resume 없음 | 브리지+허브+에이전트+파일 상태를 하나의 자체 호스팅 바이너리로 패키지 |

---

## 2. 포지셔닝

> 다른 것들은 "**프레임워크가 두뇌**" (①), 또는 "**LLM이 캔버스에 용접, 인간이 승인 노드**" (③), 또는 "**단순한 백엔드 엔진 / 단순한 메시지 브리지**" (④)입니다. Gotong는 "**멍청한 허브 + 인간을 참여자로 + 상태로서의 파일 + 조직 주권 연합**" — 또 다른 인프로세스 오케스트레이터가 아닌 **협업 기반**입니다.

---

## 3. 해자 (아키텍처적 우위)

1. **멍청한 허브 / 참여자에게 의사 결정** — ①의 어느 것도 수동 라우터가 아닙니다; 모두 LLM을 인프로세스로 실행하고 의사 결정을 보유합니다. LlamaIndex Workflows의 "루프를 소유한다" 정신만이 가깝지만, 여전히 인프로세스 이벤트 엔진입니다. 어느 단일 벤더 SDK에도 종속되지 않음 — Swarm→Agents SDK, AutoGen→MAF의 연속적인 변화가 "런타임 결합"의 위험을 정확히 증명합니다.
2. **인간과 에이전트가 동일한 `Participant`** — 모든 경쟁자는 인간을 특수 케이스로 모델링합니다: UserProxyAgent(AutoGen) / interrupt(LangGraph) / deferred-tool(Pydantic) / 그래프 노드(ADK) / "Human Input" 노드(Dify) / Outlook 승인 양식(Copilot). **어느 것도 인간과 에이전트를 동일한 메시지+태스크+트랜스크립트 버스의 동등한 피어로 만들지 않습니다.**
3. **상태로서의 파일, 이동 가능하고 감사 가능** — 경쟁자 상태는 인메모리 / SQLite / Postgres / Redis / Mongo / 벤더 클라우드에 있습니다. 가장 가까운 것은 단일 SQLite 파일(Flowise/Open WebUI), 쿼리 가능한 Postgres 행(DBOS), 또는 YAML 그래프 정의(Rivet)뿐입니다. **트랜스크립트+에이전트+세션+시크릿+볼트를 grep/diff/rsync/수동 편집이 가능한 일반 파일로 저장하는 것은 없습니다.** "디렉토리를 복사 = 방을 이동"이 가장 강력한 차별화 요소입니다.
4. **일급 시민으로서의 조직별 암호화 볼트 + 조직별 API 할당량** — Windmill(워크스페이스 키 암호화)과 Copilot(Key Vault)이 가장 가깝지만, 어느 것도 "조직별 격리 자격증명 저장소 + 조직별 LLM 할당량"을 연합 인식 경계로 모델링하지 않습니다. 프로토콜 계층(A2A/MCP)은 "인증 체계를 선언"까지만 가며, 비밀 저장이나 할당량에 대한 내용은 없습니다.
5. **교차 조직 연합 + 자격증명/데이터/청구가 각각 집에** — 가장 명확한 공백입니다. ③은 모두 단일 테넌트 또는 단일 벤더 SaaS이며, 팀/워크스페이스는 하나의 배포 내에서만 분할됩니다; ④의 엔진들은 단순한 백엔드입니다. **어느 것도 각 조직이 자체 자격증명/데이터/할당량을 유지하면서 워크플로우가 조직 경계를 넘을 수 있는 개방형 P2P 연합을 제공하지 않습니다.** 그리고 **"교차 허브 HITL"(조직 B의 인간이 조직 A가 시작한 태스크를 충족)은 A2A(150+ 조직 표준)조차 다루지 않습니다** — A2A는 `input-required` 태스크 상태만 있으며, 교차 조직 인간 참여자 모델이 없습니다.

---

## 4. 약점 (솔직한 목록)

1. **통합/커넥터 폭** — 가장 큰 실세계 해자는 반대편에 있습니다: Zapier 8000+, Make 3000+, Lindy 4000+, n8n 1200+. 현재 우리는 거의 없습니다.
2. **UX 세련도 + NL 오케스트레이션** — Make의 Reasoning Panel, Gumloop의 "Gummie" NL→워크플로우, Relay의 HITL 경험은 모두 YAML-first보다 훨씬 성숙합니다(NL→YAML 어시스턴트가 있더라도).
3. **내구성 성숙도** — Temporal(시그널 + 무한 제로 리소스 대기 + 이벤트 재실행) / DBOS(몇 주간의 내구성 있는 슬립) / Inngest / Restate는 suspend/resume에서 **수년 앞서** 있습니다. 우리의 `SuspendTaskError`+SQLite 스윕은 개념적으로 동일하지만, 젊고 단일 노드이며 보장이 약합니다.
4. **엔터프라이즈 거버넌스** — Copilot(Entra ID+Key Vault+세밀한 RBAC), Windmill(5 역할+폴더 ACL), Lindy/Sema4(SOC2/HIPAA)의 SSO/감사/컴플라이언스 이야기는 우리가 아직 구축하지 않은 것들입니다.
5. **다중 에이전트 오케스트레이션 UX** — Flowise Agentflow(슈퍼바이저/워커, 충돌 해결, 동적 역할), Lindy Agent Swarms, Zapier 에이전트 간 호출은 모두 완성된 제품 UI입니다; 우리는 디스패치 프리미티브만 있습니다.
6. **IM 폭이 독특하지 않음** — LangBot은 이미 더 많은 플랫폼(+DingTalk/LINE/KOOK/위챗 공식 계정)을 연결하고 백엔드 불가지론적입니다. "6개 브리지"는 순수한 폭에서 해자가 아닙니다 — 해자는 "파일 상태와 참여자 모델을 가진 허브이며, 허브가 단순한 라우터"입니다.
7. **생태계 / 마인드 쉐어** — 반대편에는 5만~11만 별이 있습니다(CrewAI 52k, MetaGPT 68k, Dify 110k+); 우리는 초기입니다.

---

## 5. 상호운용 프로토콜 계층 (가장 실행 가능한 정렬 대상)

2025년 하반기에 상호운용 프로토콜이 집단적으로 리눅스 재단에 흡수되어 두 계층으로 나뉘었으며, Gotong는 두 계층 모두에 걸쳐 있습니다:

- **도구 계층(에이전트↔도구): MCP가 완전히 승리.** 2025년 12월 Anthropic이 LF가 호스팅하는 **Agentic AI Foundation(AAIF)**(OpenAI/Block과 공동 구축)에 기증, 월간 다운로드 ~9700만, ~10k 서버.
- **에이전트 계층(에이전트↔에이전트 교차 조직): A2A가 완전히 승리.** 2025년 6월 LF 가입; **IBM ACP 흡수** 2025년 8월; 1주년에 **150+ 조직**이 프로덕션 사용.
- 나머지는 위아래로 스택됩니다: **AGNTCY/SLIM** = 인프라/전송 계층; **NANDA** = 연구 수준의 신원 신뢰(DID+AgentFacts); **Matrix** = 우리의 철학적 사촌(연합, 주권, 자체 서버의 상태).

| 프로토콜 | 계층 | 거버넌스 | 교차 조직 신원 | 전송/시맨틱 | 도입 |
|---|---|---|---|---|---|
| **MCP** | 도구 호출 | Anthropic→AAIF/LF | OAuth2.1+PKCE+RFC8707 (클라이언트↔서버) | 둘 다 (JSON-RPC/stdio/Streamable HTTP) | 지배적 |
| **A2A** | 에이전트↔에이전트 | Google→LF | Agent Card가 OAuth2/OIDC/API-key/mTLS 선언 | 둘 다 (JSON-RPC/HTTPS+SSE) | 150+ 조직 |
| ACP (IBM) | 에이전트↔에이전트 | →A2A에 통합 (2025-08) | (통합됨) | — | 중단 |
| AGNTCY+SLIM | 디스커버리+신원+**전송** | Cisco→LF | 분산형 Agent Identity Service | SLIM=전송 (gRPC/H2/H3), A2A/MCP 운반 | 75+ 회사 |
| NANDA | 디스커버리+신원+경제 | MIT Media Lab | DID+검증 가능한 자격증명+AgentFacts | 시맨틱 (레지스트리) | 연구/미라이브 |
| Matrix | 연합 메시지 **전송** | Matrix.org | 홈서버 연합 MXID | 전송 | 6000만+ 사용자 |

**Gotong 연합 프리미티브 → 표준 매핑:**

| 우리의 프리미티브 | 정렬된 표준 | 결론 |
|---|---|---|
| `peerToken` | A2A 인증 체계 (Bearer/OAuth2/OIDC/mTLS) | **정렬** — A2A 선언 체계로 재표현 |
| `Task.origin` | A2A Task 메타데이터 / OIDC-A 위임 체인 | **앞서 있음** — 유지, A2A Task 메타데이터에 매핑 |
| 인바운드 ACL | A2A "불투명 에이전트" + 선택적 공개 | 유지, 시맨틱으로 정렬 |
| 조직별 볼트 | (표준이 다루지 않음) | **독자적, 유지** |
| 조직별 할당량 (OrgApiPool) | (표준 없음; 연구 중인 NANDA의 경제 계층에 근접) | **독자적, 유지** |
| 피어 레지스트리 + 평판 | A2A 레지스트리 / NANDA Index / ANS | 장기적으로 정렬, NANDA 검증 가능 방향 추적 |
| 교차 허브 HITL | **어느 프로토콜도 다루지 않음** | **독자적 + 북극성 달성** |

---

## 6. 강화 방향 (「레버리지 / 북극성 기여도」 순으로 정렬)

**🔴 높은 레버리지**
1. **A2A 정렬 (단일 최고 가치 움직임)** — `/.well-known/agent-card.json` 노출, `peerToken`을 A2A 선언 Bearer/OAuth2/mTLS 체계로 재표현하여, Gotong 허브가 Gotong↔Gotong만이 아닌 150+ 조직 A2A 생태계와 연합할 수 있도록. 엔드투엔드 `Task.origin` 출처는 실제로 A2A의 현재 사양보다 앞서 있습니다.
2. **MCP 생태계를 통한 통합 폭 채우기** — 자체 커넥터 구축보다는. MCP는 이미 LF가 호스팅하며 ~10k 서버가 있습니다. "통합 능력 = MCP 서버 설치"를 일급 온보딩으로 만들어, 반대편의 "8000 커넥터" 해자를 "개방형 표준 수용"으로 전환.
3. **디스패치 프리미티브를 재사용 가능한 오케스트레이션 템플릿으로 업그레이드** — 슈퍼바이저/워커, 토론, 스웜 병렬을 `templates/`에 빌드하여, Flowise Agentflow / Lindy Swarms의 완성된 경험에 맞추기(architect-team이 이미 기반을 마련).

**🟡 중간 레버리지**
4. **내구성: 솔직한 보정 + 선택적 강력한 백엔드** — 우리 대 Temporal/DBOS 보장 경계의 진실한 비교를 문서화; suspend/resume를 수행할 선택적 **DBOS/Temporal 백엔드 모드** 고려 (DBOS는 자체 Postgres에 상태를 가진 라이브러리로, "상태가 사용자에게 보인다" 정신에 가장 잘 맞음).
5. **HITL 핸드오프 UX 폴리싱** — 개념적으로 Slack/Rocket.Chat보다 낫지만 완성된 탈출 해치가 부족합니다: "전체 컨텍스트 / 다인 승인 / 타임아웃 에스컬레이션과 함께 인간에게 핸드오프"를 기본 제공 템플릿으로 구축.
6. **엔터프라이즈 거버넌스 채우기** — SSO(OIDC/SAML), 감사 로그, 세밀한 RBAC, 조직 시나리오의 기준 통과를 위해.

**🟢 관찰 / 장기**
7. **신원 신뢰 계층 관찰** — NANDA(DID+AgentFacts) / ANS / OIDC-A 위임 체인은 "피어 레지스트리 + 평판"의 검증 가능한 미래 버전이며, 아직 표준으로 승인되지 않았으므로 **지금 도입하지 말고**, 추적할 것.
8. **포지셔닝 내러티브** — 외부적으로 "**엣지-A2A/MCP 네이티브이지만, 와이어 프로토콜이 의도적으로 무시하는 조직 경계 프리미티브(볼트 / 할당량 / 교차 조직 HITL / 출처 출처)를 운반**"을 명확히.

**순 결론**: 내구성에서 Temporal/DBOS와 경쟁하거나, 통합 폭에서 Dify/n8n과 경쟁하지 마세요. 방어적 쐐기는 **그 조합**입니다: 파일 우선 이동성 + 참여자로서의 인간 + 여러 IM 네이티브 브리지 + 충분한 suspend/resume, 모두 하나의 자체 호스팅 OSS 바이너리에 패키지. 가장 채울 가치가 있는 두 가지: **A2A 정렬** (생태계 도달을 위해) + **MCP 경로를 통한 통합**.

---

## 7. 주요 참조

**프로토콜**
- MCP→AAIF/LF: anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ; linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- A2A→LF: linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project... ; 150+ 조직: linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations...
- ACP→A2A: lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a...
- A2A 디스커버리/Agent Card: a2a-protocol.org/dev/topics/agent-discovery/
- AGNTCY/SLIM: outshift.cisco.com/blog/building-the-internet-of-agents-introducing-the-agntcy ; datatracker.ietf.org/doc/draft-mpsb-agntcy-slim
- NANDA: arxiv.org/abs/2507.07901 ; media.mit.edu (Beyond DNS / AgentFacts)

**프레임워크**
- AG2: github.com/ag2ai/ag2 ; MS Agent Framework: github.com/microsoft/agent-framework
- CrewAI: github.com/crewAIInc/crewAI ; LangGraph: github.com/langchain-ai/langgraph
- OpenAI Agents SDK: openai.github.io/openai-agents-python ; MetaGPT: github.com/FoundationAgents/MetaGPT
- Google ADK + A2A: google.github.io/adk-docs/a2a/ ; Pydantic AI: github.com/pydantic/pydantic-ai

**플랫폼 / 엔진**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify (Human Input 노드: releases/tag/1.13.0) ; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
