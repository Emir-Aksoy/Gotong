# Paysage concurrentiel et écosystème : Intégration de flux de travail réels × Collaboration multi-personnes multi-agents

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../COMPETITIVE-LANDSCAPE.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Date de l'enquête : 2026-05-29. Couvre 30+ projets/protocoles sur quatre pistes. Rédigé pour les lecteurs agents et humains.
> Conclusion en une ligne : **aucun concurrent ne possède en même temps les quatre piliers d'AipeHub** — un hub simple (les décisions restent chez les participants) / humain = agent en tant que `Participant` unifié / fichiers comme état / fédération souveraine par organisation. Le marché est découpé en quatre blocs, chacun détenant un ou deux piliers et manquant les autres.
>
> Lecture complémentaire : [`PRODUCT-MATRIX.md`](../PRODUCT-MATRIX.md) (2026-06-21) — une matrice de comparaison produit (une table de forces, une table de faiblesses) + « quel utilisateur sous-servi avec un vrai besoin nous convient le mieux » + comment la baisse de prix de DeepSeek débloque cette case. Ce doc est la carte des pistes ; l'autre est le jugement sur l'utilisateur cible au niveau produit.

---

## 1. Carte des pistes

| Piste | Acteurs représentatifs | Leur position commune | Différence fondamentale avec nous |
|---|---|---|---|
| **① Frameworks d'orchestration multi-agents** (niveau bibliothèque) | AutoGen→AG2 / MS Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, CAMEL, Semantic Kernel, Google ADK, LlamaIndex Workflows, Pydantic AI | **Le framework est le cerveau** — la bibliothèque fait tourner le LLM elle-même, détient la boucle de contrôle / tour de parole / SOP elle-même | Le hub est un routeur simple ; les décisions restent toujours entre les mains des participants |
| **② Protocoles d'interopérabilité des agents** | MCP, A2A, (IBM ACP→fusionné dans A2A), AGNTCY/SLIM, NANDA, LMOS, Matrix, ANS/OIDC-A | Collectivement absorbés par la **Linux Foundation** au H2 2025, structurés en « couche outil (MCP) + couche agent (A2A) » | MCP déjà implémenté ; la couche de fédération est maison et devrait s'aligner sur A2A |
| **③ Plateformes d'automatisation de flux de travail IA** (low-code / niveau produit) | n8n, Zapier Agents, Make, Activepieces, Windmill, Gumloop, Relay, Lindy, Sema4, Copilot Studio, Dify, Flowise | **LLM soudé dans le canvas** en tant que nœud ; **l'humain est un nœud « pause / attente d'approbation »** | Le runner n'a aucun LLM (déclaratif) + l'humain est un Participant qui reçoit des tâches |
| **④ Plateformes auto-hébergées / exécution durable / chat-as-hub** | Dify, Flowise, Langflow, Rivet, LibreChat, Open WebUI, AnythingLLM ; Temporal, Inngest, Restate, DBOS ; Slack+Agentforce, Mattermost, Rocket.Chat, LangBot, Letta | État bloqué en DB/cloud ; les moteurs durables ne sont que des backends sans interface ; les hubs chat n'ont pas de suspend/resume | bridge+hub+agent+état-fichier packagés en un seul binaire auto-hébergé |

---

## 2. Positionnement

> Les autres sont soit « **le framework est le cerveau** » (①), soit « **LLM soudé dans le canvas, humain comme nœud d'approbation** » (③), soit « **juste un moteur backend / juste un pont de messages** » (④). AipeHub est « **hub simple + humain comme participant + fichiers comme état + fédération souveraine par organisation** » — un **substrat de collaboration**, pas encore un autre orchestrateur en-processus.

---

## 3. Fossé défensif (avantages architecturaux)

1. **Hub simple / décisions chez les participants** — aucun acteur de ① n'est un routeur passif ; tous font tourner le LLM en-processus et détiennent la décision. Seul l'esprit « vous possédez la boucle » de LlamaIndex Workflows s'en approche, mais c'est quand même un moteur d'événements en-processus. Non lié à un seul SDK fournisseur — le cycle Swarm→Agents SDK et AutoGen→MAF prouve exactement le risque du « couplage au runtime ».
2. **L'humain et l'agent sont le même `Participant`** — chaque concurrent modélise l'humain comme un cas spécial : UserProxyAgent (AutoGen) / interrupt (LangGraph) / deferred-tool (Pydantic) / nœud de graphe (ADK) / nœud « Human Input » (Dify) / formulaire d'approbation Outlook (Copilot). **Aucun d'eux ne fait de l'humain et de l'agent des pairs égaux sur le même bus message+tâche+transcription.**
3. **Fichiers comme état, portable et auditable** — l'état des concurrents vit en mémoire / SQLite / Postgres / Redis / Mongo / cloud fournisseur. Les plus proches ne sont qu'un seul fichier SQLite (Flowise/Open WebUI), des lignes Postgres interrogeables (DBOS), ou une définition de graphe YAML (Rivet). **Aucun ne stocke transcription+agents+sessions+secrets+vault comme de simples fichiers que l'on peut grep/diff/rsync/éditer à la main.** « Copier le répertoire = déménager la salle » est le différenciateur le plus fort.
4. **Vault chiffré par organisation + quota API par organisation en tant que citoyens de premier rang** — Windmill (chiffrement par workspace-key) et Copilot (Key Vault) s'en approchent le plus, mais aucun ne modélise « dépôt de credentials isolé par organisation + quota LLM par organisation » comme une frontière consciente de la fédération. La couche protocole (A2A/MCP) ne va que jusqu'à « déclarer un schéma d'auth », rien sur le stockage des secrets ou les quotas.
5. **Fédération inter-organisations + credentials/données/facturation restent chez eux** — l'espace blanc le plus clair. ③ est tout mono-locataire ou SaaS mono-fournisseur, où équipe/workspace ne partitionnent qu'au sein d'un seul déploiement ; les moteurs de ④ ne sont que des backends. **Aucun n'offre une fédération P2P ouverte permettant à un flux de travail de franchir une frontière d'organisation pendant que chaque organisation conserve ses propres credentials/données/quotas.** Et **le « HITL inter-hubs » (un humain de l'organisation B satisfaisant une tâche initiée par l'organisation A) n'est même pas couvert par A2A (le standard de 150+ organisations)** — A2A n'a qu'un état de tâche `input-required`, sans modèle de participant humain inter-organisations.

---

## 4. Faiblesses (la liste honnête)

1. **Étendue des intégrations/connecteurs** — le plus grand fossé concurrentiel réel est de l'autre côté : Zapier 8000+, Make 3000+, Lindy 4000+, n8n 1200+. Nous n'en avons actuellement presque aucun.
2. **Finition UX + orchestration en langage naturel** — le Reasoning Panel de Make, le « Gummie » NL→workflow de Gumloop, l'expérience HITL de Relay sont tous bien plus matures que YAML-first (même avec un assistant NL→YAML).
3. **Maturité de la durabilité** — Temporal (signal + attentes zéro-ressource indéfinies + rejeu d'événements) / DBOS (sleep durable pendant des semaines) / Inngest / Restate ont **des années d'avance** sur suspend/resume. Notre `SuspendTaskError`+sweep SQLite est conceptuellement le même, mais jeune, mono-nœud, avec des garanties plus faibles.
4. **Gouvernance d'entreprise** — les histoires SSO/audit/conformité de Copilot (Entra ID+Key Vault+RBAC fin), Windmill (5 rôles+ACL de dossier), et Lindy/Sema4 (SOC2/HIPAA) sont des choses que nous n'avons pas construites.
5. **UX d'orchestration multi-agents** — Flowise Agentflow (superviseur/travailleur, résolution de conflits, rôles dynamiques), Lindy Agent Swarms, l'appel agent-à-agent de Zapier sont tous des UIs produit terminées ; nous n'avons que des primitives de dispatch.
6. **L'étendue des bridges IM n'est pas unique** — LangBot bridgue déjà plus de plateformes (+DingTalk/LINE/KOOK/WeChat Official Accounts) et est agnostique au backend. « 6 bridges » n'est pas un fossé en termes de largeur brute — le fossé est « un hub avec état-fichier et un modèle de participant, où le hub n'est qu'un routeur ».
7. **Écosystème / mind share** — l'autre côté a 50k–110k étoiles (CrewAI 52k, MetaGPT 68k, Dify 110k+) ; nous sommes au début.

---

## 5. Couche de protocole d'interopérabilité (la cible d'alignement la plus actionnable)

Au H2 2025, les protocoles d'interopérabilité ont été collectivement absorbés par la Linux Foundation et divisés en deux couches, AipeHub chevauchant les deux :

- **Couche outil (agent↔outil) : MCP gagne nettement.** En décembre 2025, Anthropic l'a donné à l'**Agentic AI Foundation (AAIF)** hébergée par LF (co-construite avec OpenAI/Block), ~97M téléchargements mensuels, ~10k serveurs.
- **Couche agent (agent↔agent inter-organisations) : A2A gagne nettement.** A rejoint LF en juin 2025 ; **a absorbé IBM ACP** en août 2025 ; à sa première année, **150+ organisations** en production.
- Le reste se superpose dessus et dessous : **AGNTCY/SLIM** = plan d'infrastructure/transport ; **NANDA** = confiance d'identité de grade recherche (DID+AgentFacts) ; **Matrix** = notre cousin philosophique (fédération, souveraineté, état sur votre propre serveur).

| Protocole | Couche | Gouvernance | Identité inter-organisations | Transport/sémantique | Adoption |
|---|---|---|---|---|---|
| **MCP** | appels d'outils | Anthropic→AAIF/LF | OAuth2.1+PKCE+RFC8707 (client↔server) | les deux (JSON-RPC/stdio/Streamable HTTP) | dominant |
| **A2A** | agent↔agent | Google→LF | Agent Card déclare OAuth2/OIDC/API-key/mTLS | les deux (JSON-RPC/HTTPS+SSE) | 150+ orgs |
| ACP (IBM) | agent↔agent | →fusionné dans A2A (2025-08) | (fusionné) | — | déprécié |
| AGNTCY+SLIM | découverte+identité+**transport** | Cisco→LF | Agent Identity Service décentralisé | SLIM=transport (gRPC/H2/H3), véhicule A2A/MCP | 75+ entreprises |
| NANDA | découverte+identité+économie | MIT Media Lab | DID+credentials vérifiables+AgentFacts | sémantique (registre) | recherche/pas en prod |
| Matrix | **transport** de messages fédéré | Matrix.org | MXID fédéré par homeserver | transport | 60M+ utilisateurs |

**Primitives de fédération AipeHub → correspondance avec les standards :**

| Notre primitive | Standard aligné | Conclusion |
|---|---|---|
| `peerToken` | schéma d'auth A2A (Bearer/OAuth2/OIDC/mTLS) | **Aligner** — réexprimer comme un schéma déclaré A2A |
| `Task.origin` | métadonnées de tâche A2A / chaîne de délégation OIDC-A | **En avance** — conserver, mapper vers les métadonnées de tâche A2A |
| ACL entrante | « opaque agents » A2A + divulgation sélective | conserver, sémantiquement aligné |
| vault par organisation | (aucun standard ne le couvre) | **unique, conserver** |
| quota par organisation (OrgApiPool) | (aucun standard ; se rapproche de la couche économique de NANDA, en recherche) | **unique, conserver** |
| registre de pairs + réputation | registre A2A / NANDA Index / ANS | alignement à long terme, suivre la direction vérifiable de NANDA |
| HITL inter-hubs | **aucun protocole ne le couvre** | **unique + touche l'Étoile du Nord** |

---

## 6. Directions d'amélioration (triées par « levier / contribution à l'Étoile du Nord »)

**🔴 Levier élevé**
1. **S'aligner sur A2A (action à valeur unique la plus élevée)** — exposer `/.well-known/agent-card.json`, réexprimer `peerToken` comme un schéma Bearer/OAuth2/mTLS déclaré A2A, pour qu'un hub AipeHub puisse se fédérer avec l'écosystème A2A de 150+ organisations, pas seulement AipeHub↔AipeHub. La provenance end-to-end `Task.origin` est en réalité en avance sur la spec A2A actuelle.
2. **Combler l'étendue des intégrations via l'écosystème MCP**, plutôt que de construire nos propres connecteurs — MCP est déjà hébergé par LF avec ~10k serveurs. Faire de « capacité d'intégration = installer un serveur MCP » un onboarding de premier rang, transformant le fossé « 8000 connecteurs » de l'autre côté en « adopter un standard ouvert ».
3. **Transformer les primitives de dispatch en templates d'orchestration réutilisables** — construire superviseur/travailleur, débat, essaim-parallèle dans `templates/`, pour correspondre à l'expérience terminée de Flowise Agentflow / Lindy Swarms (architect-team pose déjà une base).

**🟡 Levier moyen**
4. **Durabilité : calibration honnête + backend solide optionnel** — documenter une comparaison véridique de nos garanties vs Temporal/DBOS ; envisager un **mode optionnel appuyé sur DBOS/Temporal** pour porter suspend/resume (DBOS est une bibliothèque avec état dans votre propre Postgres, le meilleur fit pour l'ethos « l'état est visible pour vous »).
5. **Finition UX du handoff HITL** — conceptuellement bat Slack/Rocket.Chat, mais manque de portes de sortie finies : construire « passer à un humain avec contexte complet / approbation multi-personnes / escalade par timeout » comme templates prêts à l'emploi.
6. **Remplissage de la gouvernance d'entreprise** — SSO (OIDC/SAML), journaux d'audit, RBAC fin, pour atteindre le niveau des scénarios org.

**🟢 À surveiller / long terme**
7. **Surveiller la couche de confiance d'identité** — NANDA (DID+AgentFacts) / ANS / chaîne de délégation OIDC-A sont la future version vérifiable de « registre de pairs + réputation », aucun encore approuvé comme standard, donc **ne pas adopter maintenant**, suivre.
8. **Narrative de positionnement** — communiquer clairement en externe « **edge-A2A/MCP-native, mais portant les primitives de frontière org que les protocoles wire délibérément ignorent (vault / quota / HITL inter-organisations / provenance d'origine)** ».

**Conclusion nette** : ne pas aller concurrencer Temporal/DBOS sur la durabilité, ou Dify/n8n sur l'étendue des intégrations. Le coin défensif est **cette combinaison** : portabilité file-first + humain comme participant + plusieurs bridges natifs IM + suspend/resume suffisamment bon, le tout empaqueté dans un seul binaire OSS auto-hébergé. Les deux choses les plus valables à combler : **alignement A2A** (pour la portée de l'écosystème) + **intégration via la route MCP**.

---

## 7. Références clés

**Protocoles**
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

**Plateformes / moteurs**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify (Human Input node: releases/tag/1.13.0) ; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
