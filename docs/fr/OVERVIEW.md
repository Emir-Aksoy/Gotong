# Aperçu d'Gotong · Carte en 5 minutes

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../OVERVIEW.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Vous cherchez la version chinoise ? → [`docs/zh/OVERVIEW.md`](../zh/OVERVIEW.md)
>
> Ceci est la **carte en une page** du projet. À la fin, vous saurez ce qu'est
> Gotong, ce qui se passe sous quoi, comment les participants se branchent, d'où
> viennent les modèles, comment quelques personnes collaborent ensemble, et comment
> les organisations fédèrent sans abandonner leurs clés. Chaque section se termine
> par un lien → vers la prochaine lecture quand vous voulez aller plus loin.

---

## En une phrase

**Gotong** est un **espace de collaboration auto-hébergé pour TypeScript et
Python** : les personnes et les agents IA partagent une « salle », et un Hub
délibérément simple répartit les tâches, collecte les résultats et enregistre
l'ensemble de l'exécution.

Ce n'est **pas un framework d'agent** (il ne fait pas tourner le LLM) — c'est un
**substrat pour la collaboration multi-participant**, où les organisations peuvent
fédérer **sans remettre leurs clés, leurs données ou leur facturation**.

---

## Ce qu'il est — et ce sous quoi il se trouve

La plupart des projets « agent » sont un agent, ou un framework pour écrire la
boucle d'un agent (LangGraph, CrewAI, AutoGen). Gotong n'est **ni l'un ni
l'autre** — c'est la couche dans laquelle ils se branchent. Un graphe LangGraph,
un crew CrewAI, un agent de codage CLI (Claude Code, Codex), un agent A2A externe,
et un humain rejoignent tous la même salle en tant que même `Participant`. Le Hub
route leurs messages, répartit les tâches, enregistre la transcription et applique
les frontières — il **ne fait jamais tourner le LLM**, donc chaque décision reste
avec le participant.

Trois choses en font plus qu'un bus de messages :

- **Participants égaux** — un humain est un `Participant`, exactement comme un agent.
  Il n'y a pas d'« outil request-human-input » ; les personnes et les agents
  collaborent à travers les mêmes tâches + transcription, et les mêmes primitives
  asynchrones / longue durée.
- **Gouvernance** — les actions sensibles et inter-organisations ne se déclenchent
  pas simplement. Elles peuvent nécessiter qu'un humain les approuve depuis une
  boîte de réception (proposer → examiner → confirmer), avec un audit trail complet.
- **Souveraineté** — chaque espace de travail est un répertoire sur disque que vous
  possédez. Quand deux organisations fédèrent, les credentials, les données et la
  facturation restent chacun chez soi ; ce qui franchit la ligne est contraint par
  un **contrat de confiance par lien**.

Cette combinaison — pas un seul protocole intelligent — est ce qu'est Gotong.
C'est le premier substrat à mettre l'égalité humain-agent, la fédération
inter-organisations gouvernée, et la souveraineté auto-hébergée dans un seul
package exécutable, axé sur les fichiers.

---

## Une image

```
        ┌──────────────────────────────────────────────────────────┐
        │                       One Space (.gotong/)              │
        │  ─────────────────────────────────────────────────────── │
        │                                                          │
        │   👤 admin       👤 worker      👤 worker                │
        │      Alice          Bob            Carol                 │
        │       │              │              │                    │
        │       │              │              │                    │
        │   ┌───┴──────────────┴──────────────┴───┐                │
        │   │       Hub  (routing only)            │                │
        │   │  · dispatch                          │                │
        │   │  · transcript (append-only)          │                │
        │   │  · scheduler (3 strategies)          │                │
        │   │  · governance gates (approval ·       │                │
        │   │    trust contracts · audit)           │                │
        │   └───┬──────────────┬──────────────┬───┘                │
        │       │              │              │                    │
        │   🤖 host-managed   🤖 external SDK  🪢 another Hub         │
        │      LLM agent       (Node / Py)     (HubLink federation) │
        │   (templates/      (your code)      (its keys stay home) │
        │    community/)                                            │
        └──────────────────────────────────────────────────────────┘
                                  ↑
                          all state is files
                       (.gotong/transcript.jsonl
                        .gotong/agents.json
                        .gotong/secrets.enc.json …)
```

…et les trois colonnes montrées ne sont que des exemples. Le même slot `Participant`
accueille aussi les **agents de codage CLI / ACP** (Claude Code, Codex), les
**agents A2A externes**, et les **adaptateurs LangGraph / CrewAI** — tous
transparents pour le planificateur.

---

## Les quatre bords — comment Gotong se connecte au monde

Gotong atteint le reste de l'écosystème par quatre bords. Il **parle des protocoles
ouverts là où ils existent** — il ne les réinvente pas :

| Bord | Protocole | Direction | Ce qu'il transporte |
|---|---|---|---|
| Outils & données | **MCP** | les deux | Les agents appellent des outils MCP externes ; les clients externes (Claude Desktop, Cursor) pilotent le Hub. |
| Agent ↔ agent | **A2A** | les deux | Un `message/send` entrant devient une répartition ; un appel sortant pilote un agent A2A distant. |
| Agents de codage | **ACP** | sortant | Le Hub lance et maintient une session avec Claude Code / Codex et le pilote tour par tour. |
| Hub ↔ hub | **HubLink** | les deux | Le lien de fédération propre d'Gotong entre deux hubs — où vivent les contrats de confiance par lien, le transfert de tâches inter-organisations, et les portes d'approbation. |

Les trois premiers sont des standards de l'écosystème qu'Gotong implémente.
HubLink est la seule pièce qu'il possède — **pas** comme un format wire intelligent
(c'est WebSocket + bearer token + JSON-RPC en dessous) mais comme le **contrat pour
ce que deux hubs gouvernés échangent** : un manifeste de capacités, le transfert de
tâches préservant l'ascendance, et le contrat de confiance par lien ci-dessous.

→ Plus en profondeur : [`MCP.md`](../MCP.md) · [`FEDERATION.md`](../FEDERATION.md) · [`PROTOCOL.md`](../PROTOCOL.md)

---

## Commencer — qui êtes-vous ?

| Vous êtes… | Première étape | En savoir plus |
|---|---|---|
| **Développeur solo / voulez le lancer en 5 min** | `docker compose up` (ou depuis la source : `pnpm install && pnpm build && pnpm host`) → ouvrez l'URL admin du premier démarrage dans votre navigateur | [`README.md` Démarrage rapide](../../README.md#quick-start) |
| **Voulez juste *essayer un vrai hub*** | Importez un hub personnel / équipe / inter-organisations prêt à l'emploi et lancez-le | [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh) |
| **Opérateur de petite équipe / ouverture d'un hub pour une équipe** | Mode LAN (bind `0.0.0.0`) ou VPS + Caddy + systemd | [`DEPLOY.md`](../DEPLOY.md) |
| **Un utilisateur régulier invité dans une salle** | Ouvrez l'URL d'invitation → choisissez un pseudonyme → vérifiez vos capacités → vous êtes dedans | [`HUMAN.md`](../HUMAN.md) |
| **Voulez comprendre l'ensemble de la conception** | Cette page → `ARCHITECTURE.md` → `PROTOCOL.md` | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |

---

## Licence — MIT, compatible commercial

L'ensemble du projet est sous **licence MIT**. Réponse courte :

- ✅ L'**usage commercial** est autorisé, y compris SaaS à source fermée / outils internes / revente
- ✅ Vous pouvez **modifier** la source, la renommer et la republier
- ⚠️ Vous devez **conserver le fichier LICENSE + la ligne de copyright**

Les modèles adaptés de tiers sous `templates/community/` portent leurs propres
licences en amont (CC0 / MIT), toutes compatibles avec MIT et **toutes permettant
un usage commercial**.

FAQ complète dans [`LICENSE-FAQ.md`](../LICENSE-FAQ.md) — elle répond aux questions
typiques : « Puis-je intégrer Gotong dans mon propre produit à source fermée ? / Dois-je
attribuer ces modèles lorsque je les utilise commercialement ? / Puis-je changer la
LICENCE et reconditionner ? »

---

## Comment les participants se branchent

Le chemin principal consiste en **deux façons d'ajouter un agent LLM** :

| Chemin A · Géré par l'hôte | Chemin B · SDK externe |
|---|---|
| Remplissez un formulaire / importez du YAML / collez un modèle dans l'interface admin → l'hôte lance un `LlmAgent` dans son propre processus | Écrivez du code (Node / Python) implémentant `AgentParticipant.handleTask`, puis `connect(url, agents)` vers le port WebSocket du Hub |
| **0 lignes de code** | Vous écrivez du code |
| Agents LLM uniquement (Anthropic / OpenAI / Mock enveloppés) | **N'importe quel type** (LLMs, scrapers, outils locaux, logique privée, modèles ML Python) |
| La clé du fournisseur est chiffrée sur disque dans `secrets.enc.json` (par agent ou défaut workspace), ou lue depuis l'env | Vous gérez la clé API ; l'agent tourne sur votre propre machine |
| Relancé automatiquement quand l'hôte redémarre | Vous gérez son cycle de vie ; le SDK a une reconnexion automatique intégrée |
| Idéal pour : utilisateurs réguliers / rôles LLM standard / en ligne en 60 secondes | Idéal pour : développeurs / données privées / ne pas exposer votre code |

→ Chemin A : [`HUMAN.md §1 Agents`](../HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](../TEMPLATES.md)
→ Chemin B : [`AGENT.md`](../AGENT.md)

…et parce que tout est le même `Participant`, la même salle accueille aussi :

- **Agents de codage CLI / ACP** — le Hub pilote Claude Code / Codex via une session
  ACP maintenue (vérifiée sur machine réelle), avec une porte d'action dangereuse qui
  peut parquer les commandes destructives pour approbation humaine.
- **Agents A2A externes** — enregistrez un agent distant sous une capacité ; une étape
  de workflow y route comme n'importe quelle autre.
- **Adaptateurs de framework** — enveloppez un graphe LangGraph ou un crew CrewAI
  comme `Participant` via le SDK Python ; le framework lui-même n'est jamais importé
  par le Hub.

Ils se **mélangent librement** — une salle peut contenir un `writer-zh` géré par
l'hôte, votre propre `rag-agent` connecté par SDK, et une session de codage Codex,
entièrement transparents pour le planificateur.

---

## D'où viennent les modèles

```
                  templates/
                  ├── agents/           modèles officiels originaux
                  ├── teams/            équipes officielles originales
                  └── community/        adaptés de tiers (CC0 + MIT)
```

Trois façons de les obtenir, choisissez selon vos préférences :

1. **Galerie de modèles, en un clic** — l'interface admin est livrée avec une galerie
   de hubs prêts à l'emploi (personnel / org / inter-organisations) ; choisissez-en
   un → installez → il pose ses agents + workflows + slots KB dans votre Space.
2. **Copier-coller** — sur GitHub, cliquez sur **Raw** sur un `.yaml` → copiez →
   interface admin « Agents → Importer », collez.
3. **Téléchargez le fichier** — sauvegardez le `.yaml` localement → interface admin
   « Télécharger un fichier ».

Chaque fichier a un commentaire d'en-tête `# Source` / `# Upstream` / `# License` /
`# Adapted`, donc **la provenance en amont n'est jamais perdue**. Le texte intégral
des licences tierces se trouve dans
[`../templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

> **Les modèles et le framework sont séparés par conception.** Un modèle transporte
> *la structure et les références* — agents, workflows, slots KB — jamais le contenu
> de connaissance lui-même, et jamais vos personnes ou secrets. L'installation d'un
> modèle câble les connexions ; il ne restaure jamais les données d'une autre org.

→ Flux complet : [`TEMPLATES.md`](../TEMPLATES.md)
→ Hubs prêts à installer : [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh)

---

## Quelques personnes dans une salle

Gotong modélise une « équipe » comme **une salle** = un répertoire `.gotong/`.
Trois niveaux de rôles :

| Rôle | URL | Ce que vous pouvez faire dans cette salle |
|---|---|---|
| **admin** | `/admin` | Configurer la salle, approuver/rejeter les demandes d'agents, répartir les tâches, évaluer le travail, inviter d'autres admins |
| **worker** | `/` (le poste de travail `/me`) | Choisir un pseudonyme + le travail que vous pouvez faire, lancer des workflows pour les membres pour vous-même, gérer votre boîte de réception, compléter ou décliner des tâches |
| **agent** | port WS | Recevoir automatiquement les tâches réparties, retourner les résultats |

### Un workflow typique de petite équipe (avec script)

```
0  Alice (admin) démarre le hub → au lancement le navigateur affiche une URL
   admin à usage unique ; elle la stocke dans 1Password.
1  Alice configure une clé de fournisseur dans l'interface admin → la clé
   par défaut du workspace est chiffrée sur disque.
2  Alice installe un modèle (ou importe storyteller.yaml) → l'hôte lance
   immédiatement un agent LLM, affiché comme en ligne.
3  Alice envoie des URLs d'invitation à Bob et Carol. Ils choisissent des
   pseudonymes, vérifient les capacités qu'ils peuvent faire (rédiger /
   réviser) → ils sont dans la salle.
4  Alice répartit une tâche : « écrire une histoire pour enfants sur la
   persévérance », stratégie = capability:[story] → le storyteller géré par
   l'hôte la prend → 30 secondes plus tard une histoire de 600 mots revient.
5  Une étape de workflow nécessite une approbation → elle se parque dans la
   boîte de réception de Bob ; Bob l'approuve depuis son poste de travail /me,
   et l'exécution reprend — un humain dans la boucle, pas un appel d'outil.
6  Alice évalue le travail ; le classement des contributions se rafraîchit ;
   chaque événement est dans transcript.jsonl, donc un crash + redémarrage
   récupère complètement.
```

**Concepts clés** (détails dans HUMAN.md) :

- **Trois stratégies de répartition** : `direct` (par nom), `capability` (par compétence), `broadcast` (le premier à revendiquer gagne)
- **Humain dans la boucle** : une étape de workflow peut envoyer dans la boîte de réception d'une personne et attendre l'approbation / le choix / la modification avant de continuer
- **Le poste de travail `/me`** : les membres lancent leurs propres workflows pour membres, voient leurs exécutions récentes, gèrent leurs propres agents (BYO key), tous limités à eux-mêmes
- **Clé API, trois niveaux** : privée par agent → défaut workspace → variable d'environnement

→ Description complète : [`HUMAN.md`](../HUMAN.md)

---

## À travers les organisations — fédération gouvernée

**Deux significations différentes de « multi-équipe » — ne les confondez pas :**

### Une salle, plusieurs rôles (= la section ci-dessus)

Tout le monde est dans le même répertoire `.gotong/`, le même processus hub. C'est
la valeur par défaut.

### Plusieurs salles, fédérées (= vraie inter-organisations)

Chaque org gère son propre hub indépendant (son propre `.gotong/`, ses propres
personnes et agents, **ses propres clés API et sa propre facturation**). Deux hubs
se connectent via **HubLink**, et ce que l'un peut demander à l'autre est fixé par
un **contrat de confiance par lien** :

- **liste blanche de capacités** — exactement quelles capacités le pair peut invoquer
- **porte de classe de données** — quelles classes de données sont autorisées à traverser le lien (fail-closed)
- **quota** — un plafond de débit / budget par lien, maintenu entre les reconnexions
- **révocation** — coupez le lien à tout moment
- **liste blanche de bases de connaissances** — quelles KB partagées le pair peut atteindre

Le modèle le plus simple est `TeamBridgeAgent` : un sous-hub entier apparaît en amont
comme **un seul agent**, ses membres internes / clés / sous-tâches invisibles pour le
parent.

```
   Company Hub (Bob is admin)
       │
       ├── agent · alice-team   ←─┐
       │                          │  TeamBridgeAgent  (over HubLink)
       │                  ┌───────┴────────┐
       │                  │ Alice's Hub    │ (Alice is admin)
       │                  │  · writer-bot  │   keys / people / billing
       │                  │  · reviewer-bot│   all stay on Alice's hub
       │                  └────────────────┘
       └── agent · david-team   ←── another team, same idea
```

Au-delà de la mise en pont, **un workflow sur un hub peut prendre une étape sur la
capacité d'un autre hub**. Si ce pair nécessite une approbation, l'étape se parque
dans la boîte de réception d'un humain jusqu'à ce que quelqu'un l'approuve — l'appel
inter-organisations est gouverné, en deux étapes, et entièrement auditable, et le
YAML du workflow ne nomme même pas le pair (il nomme juste une capacité ; le lien est
une configuration d'exécution).

**Pourquoi c'est important — la souveraineté reste intacte :**

- L'amont voit les *résultats agrégés* (« alice-team a complété N tâches »), jamais les clés ou les données brutes du pair
- Chaque hub garde son **propre vault de credentials** et son **propre ledger d'usage / coût** — la facturation est par hub
- Vous voulez un PoC interne privé ? Lancez un hub local — zéro coût d'onboarding
- Vous voulez que toute l'entreprise collabore ? Accrochez un lien gouverné par-dessus — **sans toucher la structure d'équipe existante**

→ Une machine : [`FEDERATION.md`](../FEDERATION.md)
→ Deux machines / deux orgs, étape par étape : [`zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md) (zh)

---

## Lectures complémentaires — choisissez un chemin

Choisissez le « ce que je veux le plus comprendre maintenant » qui s'applique :

| Je veux… | Lire ceci |
|---|---|
| Démarrer en cinq minutes | [`README.md` Démarrage rapide](../../README.md#quick-start) |
| Essayer un hub prêt à l'emploi (personnel / org / inter-organisations) | [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh) |
| Être admin / être worker | [`HUMAN.md`](../HUMAN.md) |
| Écrire un agent externe | [`AGENT.md`](../AGENT.md) |
| Mettre en place un agent LLM sans code | [`HUMAN.md §1`](../HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](../TEMPLATES.md) |
| Donner à vos agents l'écosystème d'outils MCP | [`MCP.md`](../MCP.md) |
| Fédérer deux hubs (une machine) | [`FEDERATION.md`](../FEDERATION.md) |
| Fédérer sur deux machines / orgs | [`zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md) (zh) |
| Déployer pour une équipe / aller en production | [`DEPLOY.md`](../DEPLOY.md) + [`zh/GO-LIVE.md`](../zh/GO-LIVE.md) (zh) |
| L'architecture complète / pourquoi c'est conçu ainsi | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Le protocole wire / écrire un SDK dans une autre langue | [`PROTOCOL.md`](../PROTOCOL.md) |
| Usage commercial / dérivés / limites de licence | [`LICENSE-FAQ.md`](../LICENSE-FAQ.md) |
| Signaler un problème de sécurité | [`SECURITY.md`](../../SECURITY.md) |
| Contribuer du code | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
