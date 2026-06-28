# Panorama competitivo y del ecosistema: Integración en flujos de trabajo reales × Colaboración multi-persona multi-agente

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../COMPETITIVE-LANDSCAPE.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Fecha de estudio: 2026-05-29. Cubre 30+ proyectos/protocolos en cuatro pistas. Escrito tanto para agentes como para lectores humanos.
> Conclusión en una línea: **ningún competidor tiene los cuatro pilares de AipeHub a la vez** — un hub tonto (las decisiones viven en los participantes) / humano = agente como un único `Participant` unificado / archivos como estado / federación soberana por organización. El mercado está dividido en cuatro bloques, cada uno tiene uno o dos pilares y le faltan el resto.
>
> Lectura complementaria: [`PRODUCT-MATRIX.md`](../PRODUCT-MATRIX.md) (2026-06-21) — una matriz de comparación a nivel de producto (una tabla de fortalezas, una tabla de debilidades) + "qué usuario desatendido con una necesidad real nos queda mejor" + cómo la bajada de precios de DeepSeek desbloquea esa celda. Este documento es el mapa de pistas; ese es el juicio a nivel de producto sobre el usuario objetivo.

---

## 1. Mapa de pistas

| Pista | Actores representativos | Su postura común | Diferencia fundamental con nosotros |
|---|---|---|---|
| **① Frameworks de orquestación multi-agente** (nivel de biblioteca) | AutoGen→AG2 / MS Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, CAMEL, Semantic Kernel, Google ADK, LlamaIndex Workflows, Pydantic AI | **El framework es el cerebro** — la biblioteca ejecuta el LLM en sí, posee el bucle de control / turnos / SOP en sí | El hub es un enrutador tonto; las decisiones siempre permanecen en manos de los participantes |
| **② Protocolos de interoperabilidad de agentes** | MCP, A2A, (IBM ACP→integrado en A2A), AGNTCY/SLIM, NANDA, LMOS, Matrix, ANS/OIDC-A | Colectivamente absorbidos por la **Linux Foundation** en H2 2025, organizados en "capa de herramientas (MCP) + capa de agentes (A2A)" | MCP ya implementado; la capa de federación es propia y debería alinearse a A2A |
| **③ Plataformas de automatización de flujos de trabajo con IA** (low-code / nivel de producto) | n8n, Zapier Agents, Make, Activepieces, Windmill, Gumloop, Relay, Lindy, Sema4, Copilot Studio, Dify, Flowise | **LLM integrado en el lienzo** como un nodo; **el humano es un nodo "pausa / esperar-aprobación"** | El runner no tiene LLM (declarativo) + el humano es un Participant que recibe tareas |
| **④ Plataformas auto-alojadas / ejecución durable / chat-como-hub** | Dify, Flowise, Langflow, Rivet, LibreChat, Open WebUI, AnythingLLM; Temporal, Inngest, Restate, DBOS; Slack+Agentforce, Mattermost, Rocket.Chat, LangBot, Letta | Estado bloqueado en DB/nube; los motores durables son solo backends sin interfaz; los hubs de chat no tienen suspensión/reanudación | bridge+hub+agente+estado-en-archivos empaquetados en un único binario auto-alojado |

---

## 2. Posicionamiento

> Otros son "**el framework es el cerebro**" (①), o "**LLM integrado en el lienzo, humano como nodo de aprobación**" (③), o "**solo un motor backend / solo un puente de mensajes**" (④). AipeHub es "**hub tonto + humano como participante + archivos como estado + federación soberana por organización**" — un **sustrato de colaboración**, no otro orquestador en proceso.

---

## 3. Foso (ventajas arquitectónicas)

1. **Hub tonto / decisiones en los participantes** — ninguno de ① es un enrutador pasivo; todos ejecutan el LLM en proceso y toman la decisión. Solo el espíritu "tú posees el bucle" de LlamaIndex Workflows se acerca, pero sigue siendo un motor de eventos en proceso. No está bloqueado a ningún SDK de proveedor único — la rotación en serie de Swarm→Agents SDK y AutoGen→MAF es exactamente lo que demuestra el riesgo del "acoplamiento al tiempo de ejecución."
2. **El humano y el agente son el mismo `Participant`** — cada competidor modela al humano como un caso especial: UserProxyAgent (AutoGen) / interrupt (LangGraph) / deferred-tool (Pydantic) / nodo de grafo (ADK) / nodo "Human Input" (Dify) / formulario de aprobación de Outlook (Copilot). **Ninguno hace que el humano y el agente sean pares iguales en el mismo bus de mensajes+tareas+transcript.**
3. **Archivos como estado, portátil y auditable** — el estado de los competidores vive en memoria / SQLite / Postgres / Redis / Mongo / nube de proveedor. Los más cercanos son meramente un único archivo SQLite (Flowise/Open WebUI), filas de Postgres consultables (DBOS) o una definición de grafo YAML (Rivet). **Ninguno almacena transcript+agentes+sesiones+secretos+vault todos como archivos planos que puedes grep/diff/rsync/editar a mano.** "Copiar el directorio = mover la sala" es el diferenciador más fuerte.
4. **Almacén cifrado por organización + cuota de API por organización como ciudadanos de primera clase** — Windmill (cifrado de clave de espacio de trabajo) y Copilot (Key Vault) son los más cercanos, pero ninguno modela "almacén de credenciales aislado por organización + cuota de LLM por organización" como un límite consciente de federación. La capa de protocolo (A2A/MCP) solo llega hasta "declarar un esquema de autenticación," sin nada sobre almacenamiento de secretos o cuotas.
5. **Federación entre organizaciones + credenciales/datos/facturación se quedan en casa** — el espacio en blanco más claro. ③ es todo SaaS de un solo inquilino o de un solo proveedor, donde equipo/espacio de trabajo solo particiona dentro de un único despliegue; los motores de ④ son solo backends. **Ninguno ofrece federación P2P abierta que permita que un flujo de trabajo cruce un límite organizativo mientras cada organización mantiene sus propias credenciales/datos/cuota.** Y **"HITL entre hubs" (un humano en la org B satisface una tarea iniciada por la org A) ni siquiera está cubierto por A2A (el estándar de 150+ organizaciones)** — A2A solo tiene un estado de tarea `input-required`, sin modelo de participante humano entre organizaciones.

---

## 4. Debilidades (la lista honesta)

1. **Amplitud de integración/conectores** — el foso más grande del mundo real está en el otro lado: Zapier 8000+, Make 3000+, Lindy 4000+, n8n 1200+. Actualmente tenemos casi cero.
2. **Pulido de UX + orquestación NL** — el Panel de Razonamiento de Make, el "Gummie" de Gumloop NL→flujo de trabajo, la experiencia HITL de Relay son todos mucho más maduros que YAML-first (incluso con un asistente NL→YAML).
3. **Madurez de durabilidad** — Temporal (señal + esperas indefinidas de cero recursos + repetición de eventos) / DBOS (suspensión durable por semanas) / Inngest / Restate están **años por delante** en suspensión/reanudación. Nuestro `SuspendTaskError`+barrido SQLite es conceptualmente lo mismo, pero joven, de un solo nodo, con garantías más débiles.
4. **Gobernanza empresarial** — las historias de SSO/auditoría/cumplimiento de Copilot (Entra ID+Key Vault+RBAC de grano fino), Windmill (5 roles+ACL de carpetas) y Lindy/Sema4 (SOC2/HIPAA) son cosas que no hemos construido.
5. **UX de orquestación multi-agente** — Flowise Agentflow (supervisor/trabajador, resolución de conflictos, roles dinámicos), Lindy Agent Swarms, la llamada agente a agente de Zapier son todas UIs de producto terminadas; solo tenemos primitivos de dispatch.
6. **La amplitud de IM no es única** — LangBot ya conecta más plataformas (+DingTalk/LINE/KOOK/WeChat Official Accounts) y es independiente del backend. "6 bridges" no es un foso en amplitud bruta — el foso es "un hub con estado en archivos y un modelo de participante, donde el hub es solo un enrutador."
7. **Ecosistema / cuota de mente** — el otro lado tiene 50k–110k estrellas (CrewAI 52k, MetaGPT 68k, Dify 110k+); somos tempranos.

---

## 5. Capa de protocolo de interoperabilidad (el objetivo de alineación más accionable)

En H2 2025, los protocolos de interoperabilidad fueron colectivamente absorbidos por la Linux Foundation y divididos en dos capas, con AipeHub abarcando ambas:

- **Capa de herramientas (agente↔herramienta): MCP gana claramente.** 2025-12 Anthropic lo donó a la **Agentic AI Foundation (AAIF)** alojada en LF (co-construida con OpenAI/Block), ~97M descargas mensuales, ~10k servidores.
- **Capa de agentes (agente↔agente entre organizaciones): A2A gana claramente.** Se unió a LF en 2025-06; **absorbió IBM ACP** en 2025-08; en su primer aniversario, **150+ organizaciones** en uso en producción.
- El resto se apila por encima y por debajo: **AGNTCY/SLIM** = plano de infraestructura/transporte; **NANDA** = confianza de identidad a nivel de investigación (DID+AgentFacts); **Matrix** = nuestro primo filosófico (federación, soberanía, estado en tu propio servidor).

| Protocolo | Capa | Gobernanza | Identidad entre organizaciones | Transporte/semántica | Adopción |
|---|---|---|---|---|---|
| **MCP** | llamadas a herramientas | Anthropic→AAIF/LF | OAuth2.1+PKCE+RFC8707 (cliente↔servidor) | ambas (JSON-RPC/stdio/Streamable HTTP) | dominante |
| **A2A** | agente↔agente | Google→LF | Agent Card declara OAuth2/OIDC/API-key/mTLS | ambas (JSON-RPC/HTTPS+SSE) | 150+ orgs |
| ACP (IBM) | agente↔agente | →integrado en A2A (2025-08) | (integrado) | — | obsoleto |
| AGNTCY+SLIM | descubrimiento+identidad+**transporte** | Cisco→LF | Servicio de Identidad de Agente descentralizado | SLIM=transporte (gRPC/H2/H3), lleva A2A/MCP | 75+ empresas |
| NANDA | descubrimiento+identidad+economía | MIT Media Lab | DID+credenciales verificables+AgentFacts | semántica (registro) | investigación/no en producción |
| Matrix | **transporte** de mensajes federado | Matrix.org | MXID federado por homeserver | transporte | 60M+ usuarios |

**Mapeo de primitivos de federación de AipeHub → estándares:**

| Nuestro primitivo | Estándar alineado | Conclusión |
|---|---|---|
| `peerToken` | esquema de autenticación A2A (Bearer/OAuth2/OIDC/mTLS) | **Alinear** — re-expresar como esquema declarado por A2A |
| `Task.origin` | metadatos de tarea A2A / cadena de delegación OIDC-A | **Por delante** — mantener, mapear a metadatos de tarea A2A |
| ACL entrante | "agentes opacos" A2A + divulgación selectiva | mantener, alineado semánticamente |
| almacén por organización | (ningún estándar lo cubre) | **único, mantener** |
| cuota por organización (OrgApiPool) | (ningún estándar; aproxima la capa económica de NANDA, en investigación) | **único, mantener** |
| registro de pares + reputación | registro A2A / NANDA Index / ANS | alinear a largo plazo, seguir la dirección verificable de NANDA |
| HITL entre hubs | **ningún protocolo lo cubre** | **único + golpea la estrella del norte** |

---

## 6. Direcciones de mejora (ordenadas por "apalancamiento / contribución a la estrella del norte")

**🔴 Alto apalancamiento**
1. **Alinear a A2A (el movimiento de mayor valor único)** — exponer `/.well-known/agent-card.json`, re-expresar `peerToken` como esquema Bearer/OAuth2/mTLS declarado por A2A, para que un hub de AipeHub pueda federar con el ecosistema A2A de 150+ organizaciones, no solo AipeHub↔AipeHub. La procedencia de extremo a extremo `Task.origin` está realmente por delante de la especificación actual de A2A.
2. **Llenar la amplitud de integración a través del ecosistema MCP**, en lugar de construir nuestros propios conectores — MCP ya está alojado en LF con ~10k servidores. Hacer que "capacidad de integración = instalar un servidor MCP" sea un proceso de incorporación de primera clase, convirtiendo el foso "8000 conectores" del otro lado en "abrazar un estándar abierto."
3. **Actualizar los primitivos de dispatch en plantillas de orquestación reutilizables** — construir supervisor/trabajador, debate, enjambre paralelo en `templates/`, igualando la experiencia terminada de Flowise Agentflow / Lindy Swarms (architect-team ya sienta una base).

**🟡 Apalancamiento medio**
4. **Durabilidad: calibración honesta + backend fuerte opcional** — documentar una comparación veraz de nuestros vs los límites de garantía de Temporal/DBOS; considerar un **modo respaldado por DBOS/Temporal** opcional para llevar suspensión/reanudación (DBOS es una biblioteca con estado en tu propio Postgres, el mejor ajuste para el ethos de "el estado es visible para ti").
5. **Pulido de UX de transferencia HITL** — conceptualmente supera a Slack/Rocket.Chat, pero carece de salidas de emergencia terminadas: construir "transferir a un humano con contexto completo / aprobación multipersona / escalación por tiempo de espera" como plantillas listas para usar.
6. **Relleno de gobernanza empresarial** — SSO (OIDC/SAML), registros de auditoría, RBAC de grano fino, para superar el umbral de escenarios organizativos.

**🟢 Vigilar / largo plazo**
7. **Vigilar la capa de confianza de identidad** — NANDA (DID+AgentFacts) / ANS / cadena de delegación OIDC-A son la versión verificable futura de "registro de pares + reputación," ninguna aprobada todavía como estándar, por lo que **no adoptar ahora**, seguirlo.
8. **Narrativa de posicionamiento** — externamente dejar claro "**edge-A2A/MCP-nativo, pero llevando los primitivos de límite organizativo que los protocolos wire ignoran deliberadamente (almacén / cuota / HITL entre orgs / procedencia de origen)**."

**Conclusión neta**: no competir con Temporal/DBOS en durabilidad, ni con Dify/n8n en amplitud de integración. La cuña defensiva es **esa combinación**: portabilidad file-first + humano como participante + múltiples puentes nativos de IM + suspensión/reanudación suficientemente buena, todo empaquetado en un único binario OSS auto-alojado. Las dos cosas que más vale la pena rellenar: **alineación con A2A** (para alcance del ecosistema) + **integración a través de la ruta MCP**.

---

## 7. Referencias clave

**Protocolos**
- MCP→AAIF/LF: anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ; linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- A2A→LF: linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project... ; 150+ orgs: linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations...
- ACP→A2A: lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a...
- Descubrimiento A2A/Agent Card: a2a-protocol.org/dev/topics/agent-discovery/
- AGNTCY/SLIM: outshift.cisco.com/blog/building-the-internet-of-agents-introducing-the-agntcy ; datatracker.ietf.org/doc/draft-mpsb-agntcy-slim
- NANDA: arxiv.org/abs/2507.07901 ; media.mit.edu (Beyond DNS / AgentFacts)

**Frameworks**
- AG2: github.com/ag2ai/ag2 ; MS Agent Framework: github.com/microsoft/agent-framework
- CrewAI: github.com/crewAIInc/crewAI ; LangGraph: github.com/langchain-ai/langgraph
- OpenAI Agents SDK: openai.github.io/openai-agents-python ; MetaGPT: github.com/FoundationAgents/MetaGPT
- Google ADK + A2A: google.github.io/adk-docs/a2a/ ; Pydantic AI: github.com/pydantic/pydantic-ai

**Plataformas / motores**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify (Nodo Human Input: releases/tag/1.13.0) ; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
