# AipeHub

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../../README.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

[English](../../README.md) · [中文文档](../../docs/zh/README.md)

**AI + Person + Hub** — un substrat auto-hébergé où les personnes et les agents IA collaborent en tant que participants égaux, et les organisations se fédèrent sans remettre leurs clés, leurs données ou leur facturation.

AipeHub n'est pas un agent — et n'est pas un autre framework d'agents. C'est la **couche en dessous d'eux** : un registre, un bus de messages, un routeur de tâches, un lien de fédération gouverné, et une transcription en ajout seul. Les agents LangGraph / CrewAI, les agents de codage CLI (Claude Code, Codex), et les humains se connectent tous comme le même `Participant`. Le Hub maintient les signaux qui circulent et les frontières appliquées — il n'exécute jamais le LLM, donc chaque décision reste avec les participants.

### IA à laquelle vous pouvez réellement faire confiance avec les choses importantes

La plupart des outils IA vous donnent deux options : tout remettre à un cloud que vous ne contrôlez pas, ou tout connecter vous-même. AipeHub est la troisième option — **une IA que vous pouvez pointer vers votre maison, votre famille ou votre argent, parce que les frontières sont réelles et les vôtres :**

- **Un humain est dans la boucle là où ça compte.** Les actions réversibles (éteindre les lumières) se produisent simplement ; les irréversibles (verrouiller la porte, dépenser de l'argent, envoyer les données d'un enfant via un lien) attendent qu'une personne confirme dans une boîte de réception. Le workflow ne peut pas contourner le portail.
- **Vos clés et données restent sur votre disque.** Les identifiants vivent chiffrés dans votre propre répertoire `.aipehub/`. La fédération avec un autre hub partage une capacité, pas votre coffre-fort.
- **Rien ne décide dans l'obscurité.** Chaque dispatch et résultat est une transcription en ajout seul que vous pouvez lire. Le framework n'exécute jamais le modèle, donc il n'y a pas de jugement caché.

→ Consultez les [**modèles phares**](../../docs/zh/FLAGSHIP-TEMPLATES.md) pour des hubs qu'une personne non technique peut importer et exécuter aujourd'hui (maison intelligente, gestion de café, hub d'apprentissage familial, hub de codage personnel), chacun avec le portail de gouvernance clairement montré et une démo en une commande. Vous voulez partager le vôtre ? [`templates/community/templates/`](../../templates/community/templates/).

## Idées fondamentales

- **Le Hub est simple par conception.** Il n'exécute pas de LLM et ne possède pas de boucles d'agents. Il route les messages, dispatche les tâches, persiste la transcription et émet des événements. Les décisions restent avec les participants.
- **Les humains sont de première classe.** Un humain est un `Participant` comme un agent l'est. Les primitives async / longue durée du Hub s'appliquent aux deux.
- **Une interface, deux formes de déploiement.** Les agents implémentent le même contrat `Participant` qu'ils fonctionnent en cours de processus ou sur le réseau. Les agents locaux et distants partagent le même registre et le même scheduler.
- **Scheduling enfichable.** Trois stratégies de routage de tâches par défaut : affectation explicite, correspondance de capacités, et revendication par diffusion.
- **Apportez votre propre LLM.** Une petite classe de base `LlmAgent` + une interface neutre `LlmProvider` permettent de soutenir un agent avec Claude, GPT, ou tout autre modèle sans toucher le Hub.

## Statut

**Auto-hébergé, priorité aux fichiers, et gouverné pour une utilisation multi-organisation.** Un espace de travail est un répertoire sur le disque (`.aipehub/`) — supprimez le répertoire et l'espace est parti ; copiez-le et vous avez transmis la salle à un coéquipier ; les redémarrages sont transparents. En plus de cela : un coffre-fort d'identifiants par organisation, la fédération inter-organisations avec des contrats de confiance par lien (liste blanche de capacités · portail de classe de données · quota · révocation), des boîtes de réception d'approbation humains-dans-la-boucle, et un registre d'utilisation / coûts. Le Hub n'exécute toujours jamais un LLM — chaque décision reste avec les participants.

Les packages npm ont le scope `@aipehub/*` ; le SDK Python est `aipehub` sur PyPI. Licence : [MIT](../../LICENSE).

## Choisissez votre porte

> **Perdu ?** Commencez par [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) — une seule page qui relie l'utilisation, la licence, l'intégration d'agents, les téléchargements de modèles, les équipes multi-utilisateurs et la fédération multi-équipes dans un seul récit. Le tableau ci-dessous est la ventilation par rôle.

| Vous êtes… | Lisez ceci | En bref |
|---|---|---|
| 🧭 **Première visite** | [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) | Carte de 5 minutes de chaque concept + un parcours "workflow pour petite équipe". |
| 🧑 **Un travailleur / admin rejoignant une salle** | [`docs/HUMAN.md`](../../docs/HUMAN.md) | Ouvrez l'URL que l'opérateur vous a donnée ; choisissez un pseudo ; vous êtes dedans. |
| 🤖 **Écrire un agent pour se connecter** | [`docs/AGENT.md`](../../docs/AGENT.md) | `@aipehub/sdk-node` ou Python `aipehub`. Sous-classez `AgentParticipant`. |
| 🧩 **Intégrer un agent LLM sans écrire de code** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) + [`templates/`](../../templates/) | Manifest YAML → coller / uploader dans l'interface admin → l'hôte le génère pour vous. Deux ensembles : originaux du projet (`templates/agents/`) et adaptés par la communauté CC0/MIT (`templates/community/`). |
| ⭐ **Vous voulez juste un hub qui fait quelque chose d'utile** | [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md) (zh) | Galerie organisée et encadrée de confiance — importez-en un et ça marche. Maison intelligente, gestion de café, apprentissage familial, codage personnel. Chacun montre ce qu'il peut/ne peut pas toucher + une démo sans clé. |
| 🔧 **Exécuter le serveur** | [`docs/DEPLOY.md`](../../docs/DEPLOY.md) | `pnpm host` pour le local, Caddy + systemd pour le public. |
| 🚀 **Mise en production (3 topologies)** | [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) + [`deploy/`](../../deploy/) | Hôte maison + IM, hôte cloud + IM, ou cloud + IP direct. Copiez `deploy/.env.home` / `.env.cloud`, suivez le runbook. Le pont IM est un long-poll sortant → une box domestique derrière NAT n'a pas besoin de tunnel. (Runbook en zh ; anglais en attente.) |
| 🪢 **Fédérer deux hubs (équipe → org)** | [`docs/FEDERATION.md`](../../docs/FEDERATION.md) | `TeamBridgeAgent` fait apparaître un sous-Hub entier en amont comme un seul agent — garde les membres internes / clés / sous-tâches privés. |
| 🔌 **Piloter un Hub depuis Claude Desktop / Cursor / Cline** | [`docs/MCP.md`](../../docs/MCP.md) | `@aipehub/mcp-server` est un pont MCP — 5 outils (liste / dispatch / évaluation / classement / tâches). Ajoutez 5 lignes à votre config MCP client. |
| 🧰 **Donner à vos agents l'écosystème d'outils MCP** | [`docs/MCP.md`](../../docs/MCP.md#6-outbound--using-third-party-mcp-tools-from-your-agent) | `@aipehub/mcp-client` permet à vos agents AipeHub de s'attacher à Filesystem / GitHub / Slack / Postgres / n'importe quel serveur MCP. `LlmAgent` exécute une boucle d'utilisation d'outils multi-tours par défaut (v0.3+) — passez simplement `tools: toolset` et Claude / GPT décident quand appeler quel outil. |
| ⚖️ **Inquiet à propos de la licence / usage commercial** | [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md) | MIT partout. Intégrable dans du code source fermé / SaaS. Les modèles communautaires sont CC0 + MIT. |
| 🧠 **Concevoir dessus** | [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) | Le Hub est simple par conception ; le protocole wire est v1.0. |
| 📊 **Dimensionner un déploiement** | [`docs/PERFORMANCE.md`](../../docs/PERFORMANCE.md) + [`docs/zh/CLOUD-RESOURCE-FOOTPRINT.md`](../../docs/zh/CLOUD-RESOURCE-FOOTPRINT.md) | Chiffres de référence pré-lancement + comment relancer le test de charge sur votre propre matériel. Le doc zh ajoute une **mesure de production réelle** (Feishu + MiMo, hub unique sur une box 2 vCPU / 2 GiB) avec des estimations de capacité par charge et des déclencheurs de mise à niveau — l'état stable est ~110–160 MiB de RAM et ~0 CPU car l'inférence s'exécute sur le fournisseur LLM, pas sur l'hôte. |
| 🛟 **Opérer en production** | [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) | Playbook de sauvegarde/restauration, exercice de reprise après sinistre, gestion de `secret.key`, dépannage. |
| 📡 **Surveillance + alertes** | [`docs/MONITORING.md`](../../docs/MONITORING.md) | Config de scrape Prometheus, 7 règles d'alerte avec runbooks, JSON du tableau de bord Grafana. |

### Ajouter un agent — deux chemins

|  | Géré par l'hôte (sans code) | SDK externe (votre code) |
|---|---|---|
| **Vous faites** | Coller / uploader un manifest YAML dans l'interface admin | Écrire `AgentParticipant.handleTask`, appeler `connect(url, agents)` |
| **Où ça fonctionne** | Dans le processus Hub (LocalAgentPool) | N'importe où sur le réseau |
| **Ce qu'il peut faire** | Tâches LLM via les fournisseurs Anthropic / OpenAI / Mock | Tout — LLMs, scrapers, données privées, modèles ML, scripts |
| **Clé API réside** | Chiffrée dans `.aipehub/secrets.enc.json` (par agent ou défaut de l'espace de travail) | Où votre code la lit |
| **Au redémarrage** | Re-générés automatiquement par `LocalAgentPool` | Votre code se reconnecte (le SDK a un auto-retry intégré) |
| **Idéal pour** | Utilisateurs finaux • rôles standard • modèles en un clic | Développeurs • logique privée • workers multi-langages |
| **Lisez** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) | [`docs/AGENT.md`](../../docs/AGENT.md) |

Les deux chemins se connectent au même Hub. Mélangez librement — une salle peut avoir `writer-zh` géré par l'hôte à côté de votre `rag-agent` privé connecté par SDK.

Ce qu'est ce projet — et ce qu'il refuse de devenir : [`CHARTER.md`](../../CHARTER.md). Contribuer ? Voir [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Problèmes de sécurité : [`SECURITY.md`](../../SECURITY.md). Historique des versions : [`CHANGELOG.md`](../../CHANGELOG.md).

## Démarrage rapide

### Utilisateur non technique ? Double-clic, zéro Node/Docker

Le chemin qui ne nécessite **ni terminal, ni Node, ni Docker** sur la machine qui le fait tourner. Un mainteneur construit un bundle portable autonome une fois :

```bash
node scripts/build-portable.mjs        # → dist-portable/AipeHub-macos-arm64/
```

Ensuite, remettez le dossier complet `AipeHub-macos-arm64/` à n'importe qui. Ils **double-cliquent
sur `AipeHub.command`** → le navigateur ouvre l'assistant de configuration de 5 minutes. Le bundle
embarque son propre runtime Node épinglé + l'hôte compilé + un vrai
`node_modules` sur disque (incluant la liaison native SQLite), donc il exécute l'hôte
**complet** soutenu par l'identité sur une machine sans rien d'installé. Les données vivent dans
`~/.aipehub` (en dehors du dossier), donc remplacer le bundle ne perd jamais de données.

Construit à la demande, pas encore un téléchargement validé/publié (c'est le plan post-1.0)
— pour l'instant "télécharger et exécuter" signifie *construire le dossier une fois, partager le dossier*.
macOS arm64 pour cette version. Description complète : [`docs/zh/PORTABLE-BUNDLE.md`](../../docs/zh/PORTABLE-BUNDLE.md).

### Démarrer en 30 secondes — choisissez un

```bash
# A. Docker (recommandé — pas de configuration Node, fonctionne sur macOS / Windows / Linux)
docker compose up
# → http://127.0.0.1:3000  + URL admin affichée dans les logs
# → l'état persiste sous ./data

# B. Depuis les sources (dépôt cloné, ensemble de démos complet disponible)
pnpm install
pnpm build
pnpm host
```

Les deux démarrent le même binaire. Ouvrez l'URL admin affichée → sauvegardez le token → vous êtes dedans.

**Comportement au premier démarrage (nouveau).** Après le démarrage, l'hôte affiche une bannière de prochaine étape prominente pointant vers l'assistant de configuration en loopback, et lors d'un premier démarrage local (loopback) il ouvre votre navigateur là pour vous :

```text
┌─ 下一步 / Next step ──────────────────────────

  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:

      →  http://127.0.0.1:3000

  设置向导在本机回环 (loopback) 上运行。
  The setup wizard runs on loopback only.
└───────────────────────────────────────────────
  (已自动打开浏览器 / browser opened — AIPE_OPEN_BROWSER=0 关闭)
```

`AIPE_OPEN_BROWSER` contrôle l'ouverture automatique : non défini = `auto` (premier démarrage local
uniquement), `1`/`always` = à chaque démarrage, `0`/`never` = désactivé. Il est également forcé désactivé
chaque fois que l'hôte est exposé sur le réseau — un serveur headless n'ouvre jamais un navigateur,
et l'assistant n'y est de toute façon pas accessible (ce chemin utilise le fichier token admin). La bannière elle-même s'affiche toujours.

> 💡 **Distribution.** Pas de `npm publish` à ce stade — Docker (A) et source (B)
> sont les deux chemins d'installation supportés. Le plan npm "en file pour v2.1" antérieur a
> été **déscoped** ; le choix du registre (npm / JSR / source-uniquement) est une décision
> ouverte suivie dans [RELEASE-CHECKLIST](../../.github/RELEASE-CHECKLIST.md). Les binaires
> précompilés en fichier unique pour macOS / Windows sont un élément planifié mais non bloquant —
> Docker couvre déjà le cas "cliquer et exécuter" multiplateforme.

Drapeaux CLI (depuis un dépôt construit) :

```bash
pnpm exec aipehub-host --help       # référence complète des variables d'environnement
pnpm exec aipehub-host --version    # version actuelle de l'hôte
```

Après le démarrage, suivez [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) pour le parcours "et maintenant".

**Ça ne démarre pas ?** Exécutez une vérification pré-vol avant de démarrer — elle inspecte exactement
l'env `AIPE_*` que l'hôte lit (version Node, ports réellement libres pour l'écoute, répertoire de données
accessible en écriture, clé master) et affiche, par vérification, ✓ / ⚠ / ✖ avec un correctif en une ligne :

```bash
pnpm exec aipehub doctor          # rapport seulement
pnpm exec aipehub doctor --fix    # crée aussi automatiquement un répertoire de données manquant (la seule réparation sûre et réversible)
```

Et si un démarrage *échoue*, l'hôte transforme les pannes courantes et récupérables
(port déjà utilisé, pas de permission pour écouter un port, clé master manquante/invalide,
répertoire de données non accessible en écriture, disque plein) en un message humain d'une ligne nommant quelle
variable `AIPE_*` changer — pas une trace de pile. Voir la section de dépannage dans
[`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) §十一.

**Vérifiez que la sonde de clé fonctionne (aucune clé réelle nécessaire).** Le piège le plus courant au premier démarrage
est une clé LLM collée qui ne fonctionne pas silencieusement. L'assistant de configuration attrape
cela avec un chemin de secours "aller ajouter une clé" en un clic ; cette commande parcourt cette même sonde
de bout en bout pour que vous sachiez que le chemin de secours est câblé avant l'intégration :

```bash
pnpm check:onboarding          # hermétique — prouve une mauvaise/vide clé → "allez ajouter une clé", une erreur réseau → "vérifiez l'URL"
ANTHROPIC_API_KEY=… pnpm check:onboarding   # aussi un aller-retour avec une VRAIE clé sur le wire (opt-in ; ignoré sans une)
```

C'est hermétique par défaut (pas de réseau, pas de dépense) et ne journalise jamais votre clé.
Exit 0 = chaque vérification qui a été exécutée a réussi. La vérification de clé réelle opt-in reflète
le contrat env du portail live (`OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.deepseek.com`
+ `AIPE_LIVE_OPENAI_MODEL=deepseek-chat` pour le chemin DeepSeek).

### Déployer sur un serveur cloud (VPS)

Vous avez une nouvelle box Ubuntu/Debian ? Mettez le checkout dessus (`git clone` avec votre
clé, ou `scp` — le dépôt est privé, donc pas de pull public), puis
provisionnez un service systemd en une commande :

```bash
# depuis l'intérieur du checkout, sur le VPS
sudo bash deploy/cloud-quickstart.sh        # installer Node+pnpm → construire → user+unit
#   aperçu d'abord, ne mute rien :  bash deploy/cloud-quickstart.sh --dry-run
```

Il installe Node + pnpm, construit, crée l'utilisateur de service `aipehub` et le répertoire
de données, dépose `/etc/aipehub.env` (depuis [`deploy/.env.cloud`](../../deploy/.env.cloud)),
et installe une unité systemd qui reflète [`docs/zh/DEPLOY.md`](../../docs/zh/DEPLOY.md)
§C.4. Il **s'arrête un pas avant de démarrer** — le fichier env est livré avec le
domaine / clé master / liste blanche d'hôtes vide, et exposer une box non configurée est
dangereux. Il affiche le dernier kilomètre sûr : remplissez l'env, exécutez
[`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) (vérification du périmètre), mettez Caddy
+ un pare-feu devant, puis `systemctl enable --now aipehub`.

> Il n'y a **pas de bouton "déploiement en un clic" de navigateur** tant que le dépôt est privé
> (ceux-là nécessitent un dépôt public ou un compte fournisseur pré-lié à votre git). Ce
> bootstrap copier-coller est l'équivalent réel et testable. Runbook complet —
> topologie, risques d'exposition IP, intégration de membres IM : [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md).

### 个人模式 (新, v4 Phase 7) — 一个人用 AI 干活, 0 配置

如果你就一个人, 想把 AipeHub 当成"我的 AI 桌面"用 (不是给团队开 hub),
直接 `docker compose up` 就行 — host 第一次启动检测到只有你一个用户,
**自动进入个人模式**:

```bash
docker compose up
# → http://127.0.0.1:3000/admin?token=<打印出来>
# → 首屏顶部不显示 "owner" 角色 chip (个人用户不需要看见组织角色)
# → 副标题写"我的 AI 桌面"(不是"管理员控制台")
# → 设置 tab 出现 [升级到团队模式] 按钮 — 哪天想拉人就点一下
```

个人模式与团队模式的差别就两点:
- 主页副标题文案不同 / role chip 隐藏
- 设置里多个升级按钮

**所有 admin tab 都还在**(用户管理 / peer / 配额 / audit 全可见),
但你不会被这些概念占满屏幕。需要时再用。

`AIPE_MODE=team` 可以强制 pin 团队模式(即使只有一个用户);
`AIPE_MODE=personal` 反过来——多用户时也强制 pin 个人模式(罕见,
通常给 dev / 测试场景)。

升级到团队后, 自动出现"邀请用户"流程, 跟着导出 admin URL 给团队成员;
路径见下一节 5-min personal growth workflow 或 [`docs/zh/OVERVIEW.md`](../../docs/zh/OVERVIEW.md)。

### Workflow de croissance personnelle de 5 minutes (nouveau)

La première expérience prête à l'emploi livrée. 7 coachs (entretien + corps / psychologie / objectifs / ressources / relations + planificateur de synthèse) s'exécutent une fois → un plan mural markdown de 12 semaines est déposé sur le disque. Le LLM par défaut est **DeepSeek** (accessible en Chine continentale, bon marché).

```text
1. Installer l'hôte (Docker ou source, voir ci-dessus)
2. Ouvrir l'URL admin affichée → entrer dans l'admin
3. Demander une clé API DeepSeek : https://platform.deepseek.com (les nouveaux utilisateurs reçoivent 10 CNY de crédit, suffisant pour des dizaines d'exécutions)
4. Admin → onglet workflow → cliquer [Importer l'équipe (bundle)] → cliquer [🎁 Utiliser le modèle intégré : croissance personnelle]
   → coller la clé DeepSeek → [Importer]
   (7 agents créés en un clic, workflow enregistré automatiquement)
5. Cliquer [Démarrer] sur la carte de workflow → formulaire à 4 sections (situation actuelle / souhaits / blocages / ce que vous voulez le plus clarifier)
6. Dispatcher → attendre ~3,5 minutes (7 appels API DeepSeek)
7. Onglet workflow → faire défiler vers le bas → panneau "Rapport de croissance" → cliquer [Télécharger]
   ou : <space>/services/artifact/file/agent/growth-synthesist/reports/<caseId>/<date>.md
```

Le rapport contient : portrait + 5 analyses dimensionnelles (corps/psychologie/objectifs/ressources/relations) + un chemin de développement en une phrase + **un plan mural de 12 semaines** (ligne principale + secondaire, quoi faire chaque semaine) + **5 jugements d'arbitrage** + plans de repli "que faire si je n'y arrive pas" + "5 questions de départ recommandées pour la prochaine fois" (pour la prochaine exécution).

> 🙏 **À propos de la confidentialité / données** : vos 4 sections d'auto-description seront envoyées à DeepSeek (serveurs en Chine continentale) pour l'inférence. Une fois le workflow terminé, tous les résultats atterrissent dans le répertoire `.aipehub-*/services/` de votre propre ordinateur, aucun cloud n'est impliqué. Chaque coach est conçu comme un compagnon avec des limites — le coach corps orientera vers un médecin pour des signaux d'alerte (douleur thoracique persistante / saignement inexpliqué, etc.) ; le coach psychologie donnera une ligne de crise 24h pour les signaux de risque (nationale 400-161-9995 / Malaisie Befrienders 03-7956 8144). **Cela ne remplace pas un médecin / psychologue / conseiller financier / thérapeute relationnel.**

Vous voulez passer à Anthropic Claude ou OpenAI ? Éditez `templates/teams/personal-growth-team.yaml`, changez `provider` / `baseURL` / `model` de chaque agent — les invites système sont indépendantes du fournisseur.

### Journalisation

La journalisation structurée est **activée par défaut** — une ligne JSON par événement lorsque stdout est acheminé (pour `jq` / Loki / ELK / Datadog), imprimée en joli format lorsque stdout est un terminal. Trois variables d'environnement la contrôlent :

```bash
AIPE_LOG_LEVEL=info       # silent | trace | debug | info (défaut) | warn | error | fatal
AIPE_LOG_FORMAT=json      # json | pretty (défaut : auto selon TTY)
AIPE_LOG_DISABLED=1       # sortie de secours hard-off
```

Filtrez par composant avec `jq` une fois que vous avez la sortie JSON :

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### Démos (dépôt cloné)

Une fois que vous avez `pnpm install && pnpm build`-é, chaque pattern de collaboration dans le framework a une démo exécutable :

```bash
# démos en processus (pas de réseau)
pnpm demo                # deux agents mock + un humain mock
pnpm demo:broadcast      # trois reviewers en course, les perdants annulés

# démos de persistance
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# agents distants
pnpm demo:remote         # hôte + worker dans des processus séparés
pnpm demo:remote:python  # hôte Node + worker Python (multi-langage)
pnpm demo:cli-human      # terminal-en-tant-qu'humain boucle d'approbation

# agents soutenus par LLM
pnpm demo:llm            # LlmAgent + fournisseur mock (pas de clé API nécessaire)
pnpm demo:llm:real       # vrai Claude/GPT (nécessite ANTHROPIC_API_KEY/OPENAI_API_KEY)

# v2.0 full stack — interface web + admission d'agents + panneau de tâches
pnpm demo:open-space
pnpm demo:federated-team # un Hub rejoint un autre Hub comme un seul agent
```

### 上手案例 — 5 个开箱即用的 hub (Hubs prêts à l'emploi)

Au-delà des démos de patterns ci-dessus, cinq cas `examples/` sont des **hubs complets et copiables** —
chacun livre une démo déterministe sans clé *et* un modèle chargeable en un fichier (agents + workflows
+ câblage KB). Trois personnels ("Mon bureau IA"), deux d'organisation (mode équipe) :

```bash
# hubs personnels (LLM routeur orchestre sous-agents / CLIs)
pnpm demo:personal-coding-hub      # route Claude Code + Codex sur un dépôt partagé
pnpm demo:personal-research-hub    # compile les sources brutes dans un wiki Obsidian lié
pnpm demo:battle-monk-training     # un coach de croissance écrivant l'état dans un Codex persistant

# hubs d'organisation (workflows déclaratifs + self-service surface.me + approbation HITL human:)
pnpm demo:cafe-ops                 # boutique thé/café : intégration / quarts / heures sup, le manager approuve
pnpm demo:warband-club             # un fan club collaborant sur une archive partagée
```

Choisissez-en un, voyez la démo déterministe, puis passez en production avec DeepSeek + Obsidian réels —
le catalogue complet et le runbook de mise en production est **[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)**.

## Embarqué — tout dans un processus

```ts
import { Hub, Space } from '@aipehub/core'

// v2.0 : lier à un répertoire ; admins, workers, transcription tous vivent ici
const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`URL admin une fois : http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'pourquoi TypeScript' },
})

// pour les tests / démos en processus sans persistance :
const tmp = Hub.inMemory()
```

## Distribué — les agents se connectent depuis un autre processus / machine

Processus hôte (le Hub) :

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

Processus worker (n'importe quel agent, n'importe où) :

```ts
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

Le `dispatch(...)` du Hub atteint l'agent distant de manière identique à un local. Voir [docs/PROTOCOL.md](../../docs/PROTOCOL.md) pour le format wire et [examples/remote-agent](../../examples/remote-agent) pour une démo exécutable en deux processus.

## Agents soutenus par LLM

Le Hub n'appelle pas de LLMs. `LlmAgent` le fait — c'est une fine classe de base qui câble une tâche dans un `LlmProvider` et transforme la réponse en `TaskResult`. Changer de fournisseur est un changement d'une ligne.

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

const hub = new Hub()
await hub.start()

// Claude écrit des brouillons
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // lit ANTHROPIC_API_KEY
  system: 'Tu écris une phrase concise.',
}))

// GPT les révise
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // lit OPENAI_API_KEY
  system: 'Tu retournes une suggestion de révision.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'agents distribués' },
})
```

Surchargez `buildRequest(task)` pour personnaliser l'assemblage du prompt (contexte récupéré, exemples few-shot) ou `parseResponse(response, task)` pour post-traiter (extraction JSON, re-prompt de validation). Surchargez `handleTask(task)` pour un contrôle total — raisonnement multi-étapes, reprises, sorties structurées. Voir [`packages/llm`](../../packages/llm/src/agent.ts) et les deux démos dans [`examples/llm-mock`](../../examples/llm-mock) et [`examples/llm-real`](../../examples/llm-real).

## Espace Ouvert — admins, workers et agents dans une salle (v2.0)

Ancrez le hub à un répertoire `.aipehub/` ; l'identité admin, les comptes worker, et les admissions d'agents contrôlées vivent tous là. L'interface web se divise en deux vues (`/` worker, `/admin` admin). Les redémarrages du Hub sont transparents — les cookies fonctionnent toujours, les admins sont toujours admins, les transcriptions grandissent plutôt que de redémarrer.

```ts
import { Hub, Space } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`URL admin une fois : http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   worker = /
```

- **Admin** se connecte une fois avec le token, puis pilote la salle : approuver / rejeter les admissions d'agents en attente, dispatcher des tâches via l'une des trois stratégies, voir toutes les tâches dans un panneau filtrable avec un bouton **Réessayer** sur les lignes échouées, écrire des évaluations attachées à des tâches spécifiques.
- **Worker** choisit un pseudo + des capacités sur `/`, devient un `HumanParticipant`. Une ligne `workers.json` + un cookie HttpOnly les mémorisent à travers les rechargements et redémarrages.
- **Agent** se connecte au port WebSocket ; avec `gating: 'admin-approval'` ils restent en attente jusqu'à ce qu'un admin agisse.

Démo exécutable complète dans [`examples/open-space`](../../examples/open-space). `pnpm demo:open-space` lance l'hôte + l'agent dans un terminal, puis pointez un navigateur vers les deux URLs qu'il affiche.

## Services Hub — mémoire d'agents, artefacts, datastores (v2.2)

Un agent peut déclarer quel état il veut que l'hôte maintienne en son
nom. Trois "services" tiers embarqués sont disponibles aujourd'hui ; la plomberie est
enfichable dès le premier jour, donc ajouter un quatrième est un package npm séparé.

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: aipehub.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Utilisez memory.recall avant de répondre ; artifact.write le rapport
    ensuite ; cases.sql pour les comparaisons sectorielles structurées.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

Au moment de la génération, l'hôte résout chaque entrée `uses:` en un handle typé
que l'agent lit depuis `ctx.memory`, `ctx.artifact`, `ctx.datastore.<name>`.
L'isolation basée sur le propriétaire est la valeur par défaut — deux agents demandant `memory:file`
obtiennent deux magasins différents. La disposition des données vit sous `<space>/services/` :

```
<space>/services/
├─ plugins.json                    # quels plugins charger (auto-ensemencé)
├─ memory/file/agent/<agentId>/    # un répertoire par (plugin, propriétaire)
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

La suppression douce est un clic dans l'onglet admin "服务 / Services" ; les données se déplacent
vers `.trash/` par plugin, vivent 30 jours, puis un sweeper de fond les
supprime définitivement. La restauration est un POST jusqu'alors. La conception complète est dans
[`docs/services-rfc.md`](../../docs/services-rfc.md).

| Package | Ce qu'il fournit |
|---|---|
| `@aipehub/services-sdk` | Contrat `ServicePlugin`, registre, chargeur. Le joint que les auteurs de plugins implémentent. |
| `@aipehub/service-memory-file` | Premier parti `memory:file` — épisodique / sémantique / travail en JSONL. |
| `@aipehub/service-artifact-file` | Premier parti `artifact:file` — répertoires par propriétaire avec gardes MIME + taille. |
| `@aipehub/service-datastore-sqlite` | Premier parti `datastore:sqlite` — KV + SQL brut sur un `.sqlite` par nom déclaré. |

### Écrire votre propre plugin

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@aipehub/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* ouvrir le pool redis */ }
  async validateConfig(raw) { /* analyser + rejeter les mauvaises formes */ }
  async attach(owner, config) { /* retourner un MemoryHandle */ }
  async detach(owner) { /* fermer le cache par propriétaire */ }
  async softDelete(owner) { /* retourner un TrashRef ; l'hôte le stocke */ }
  async restore(ref) { /* lance TrashRestoreConflictError en cas de collision */ }
  async hardDelete(ref) { /* irréversible */ }
  async describe(owner) { /* snapshot de l'interface admin — sizeBytes, aperçu */ }
  async shutdown() { /* drainer + fermer */ }
}

export default () => new MyPlugin()
```

Déposez le nom du package dans `<space>/services/plugins.json` et redémarrez
l'hôte — `loadPlugins` importe dynamiquement l'entrée, appelle `init`, et
le plugin est disponible pour le `uses:` yaml de chaque agent. Les échecs de chargement de plugin
ne sont pas fatals : un mauvais plugin apparaît dans le log de démarrage mais
ne plante pas l'hôte.

> **Note de déploiement** : l'hôte résout les packages de plugins depuis son propre
> `node_modules/`, donc les plugins tiers doivent être installés là où
> l'hôte peut les voir — `pnpm add my-org/aipehub-redis-memory` dans
> l'espace de travail hôte, ou une dépendance `package.json` sur l'image de déploiement.
> Mettre le nom du package dans `plugins.json` seul ne suffit pas
> si le package lui-même n'est pas sur disque.

## Packages

| Package | Objectif |
|---|---|
| `@aipehub/core` | Hub, registre, scheduler, transcription, stockage, classes de base Participant |
| `@aipehub/web` | Interface de référence embarquable (HTTP + SSE + SPA vanilla) |
| `@aipehub/host` | Binaire de production — piloté par l'env, pas d'état de démo, livre `aipehub-host` |
| `@aipehub/protocol` | Types de protocole wire + codec (zéro runtime) |
| `@aipehub/transport-ws` | Transport WebSocket côté Hub |
| `@aipehub/sdk-node` | SDK Node pour les agents distants (exporte aussi `TeamBridgeAgent`) |
| `@aipehub/llm` | Classe de base `LlmAgent` + interface `LlmProvider` + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Fournisseur Anthropic Claude (dep pair : `@anthropic-ai/sdk`) |
| `@aipehub/llm-openai` | Fournisseur OpenAI (dep pair : `openai`) |
| `@aipehub/services-sdk` | Contrat de plugin Hub Services (v2.2) — voir la section ci-dessus |
| `@aipehub/service-memory-file` | Plugin `memory:file` premier parti (JSONL sur disque) |
| `@aipehub/service-artifact-file` | Plugin `artifact:file` premier parti (répertoires par propriétaire, contrôlé MIME) |
| `@aipehub/service-datastore-sqlite` | Plugin `datastore:sqlite` premier parti (KV + SQL) |
| `@aipehub/mcp-server` | Pont MCP (Model Context Protocol) — laisser Claude Desktop / Cursor piloter un Hub |
| `aipehub` (PyPI, dans `python-sdk/`) | SDK Python — connecter des agents Python à un Hub via le même protocole wire |

## Licence

**MIT** pour le projet lui-même — voir [`LICENSE`](../../LICENSE).

- ✅ Usage commercial, dérivés en code source fermé, intégration SaaS interne — tous autorisés.
- ⚠️ Conserver le fichier LICENSE + la notice de copyright dans votre distribution.
- Les modèles de prompts tiers sous [`templates/community/`](../../templates/community/) portent leurs propres licences (compatibles) — CC0 1.0 et MIT — agrégées verbatim dans [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

Les questions courantes ("puis-je intégrer dans du code source fermé", "dois-je attribuer les modèles communautaires", "fork+renommage autorisé") sont répondues dans [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md).
