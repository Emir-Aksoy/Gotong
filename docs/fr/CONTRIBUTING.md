# Contribuer à Gotong

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../../CONTRIBUTING.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

Merci de considérer une contribution. Gotong est un projet en phase précoce
et nous sommes heureux d'accepter des correctifs, des rapports de bugs, des retours de
conception et des améliorations de documentation — **et nous entendons chaque type de
contribution, grande ou petite.** Construire quelque chose de nouveau *et porter le
projet vers les gens* comptent tous les deux : une correction de faute de frappe sur
une ligne, un hub entier importable, une traduction, une vidéo tutoriel, une
conférence qui amène des gens. Tout est reconnu — voir
[`CONTRIBUTORS.md`](../../CONTRIBUTORS.md), la vitrine d'apprentissage
[`LEARN.md`](../../LEARN.md), et pourquoi nous le faisons dans
[`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md).

## Règles de base

- **Soyez bienveillant.** Traitez quiconque dans le traqueur d'issues / PRs de la façon dont vous
  voudriez qu'un ingénieur senior vous traite un mauvais jour.
- **Petites PRs.** Les changements indépendants livrent plus vite que les méga-PRs. Si une
  fonctionnalité se divise proprement, envoyez les parties séparément.
- **Le Hub reste simple.** L'idée de conception entière d'Gotong est que le Hub
  route / persiste et ne possède pas de logique d'agent. Les correctifs qui mettent des appels LLM,
  des boucles d'agents ou des règles métier dans le Hub seront redirigés.
- **Le protocole wire est versionné.** Tout ce qui change les formes de messages au niveau
  du protocole passe par `docs/PROTOCOL.md` et un incrément de version du protocole. Les
  changements locaux uniquement ne le font pas.
- **Pas de dépendances surprises.** Ajouter une dépendance runtime (surtout les
  natives) est une vraie décision — ouvrez d'abord une issue.

## Workflow

```bash
# forkez sur GitHub, puis :
git clone git@github.com:<vous>/Gotong.git
cd Gotong
pnpm install
pnpm build

# effectuez des changements…

pnpm -r typecheck      # tous les 19+ packages typechecks propres
pnpm -r test           # vitest sur tous les packages
pnpm test:python       # python-sdk pytest
```

Conventions :

- Mode strict TypeScript, ESM avec extensions d'import `.js` sur les imports relatifs
  (la résolution "node16/nodenext" de TypeScript le requiert).
- Les tests vivent à côté du code qu'ils couvrent (`packages/*/tests/`).
- Lint n'est pas encore appliqué par un outil ; correspondez au style des fichiers existants.
- Messages de commit : impératifs ("add foo", pas "added foo"). Un
  paragraphe pour les commits non triviaux est le bienvenu.

## Structure du dépôt

```
packages/
  core/           Hub + registre + scheduler + transcription + Space
  protocol/       Types de protocole wire (zéro runtime)
  transport-ws/   Adaptateur WebSocket côté Hub
  sdk-node/       SDK Node pour les agents distants (connect + AgentParticipant)
  web/            Serveur web embarquable + SPA statique
  host/           Binaire de production (piloté par l'env, pas d'état de démo)
  llm/            Classe de base LlmAgent + interface LlmProvider
  llm-anthropic/  Fournisseur Anthropic
  llm-openai/     Fournisseur OpenAI
python-sdk/       SDK Python (miroir de sdk-node)
examples/         Démos exécutables
docs/             Architecture / protocole / docs de déploiement long format
```

## Domaines à entamer

Si vous voulez une tâche de démarrage avec peu de contexte, cherchez des issues étiquetées
`good-first-issue`. Quelques thèmes toujours bienvenus :

- **Documentation** : fautes de frappe, exemples plus clairs, traductions (le projet
  a des mainteneurs sinophones ; les docs en anglais uniquement sont encore minces).
- **Couverture de tests** : surtout pour les cas limites du scheduler et les
  chemins de migration sur disque du Space.
- **Fournisseurs LLM supplémentaires** : copiez la forme de `packages/llm-anthropic`.
- **A11y / i18n dans l'interface admin** : JS vanilla, pas de framework, petite
  surface.

## Contribuer un modèle

Vous n'avez pas à écrire du TypeScript pour contribuer. Gotong livre des **modèles** —
du YAML autonome que quelqu'un importe pour obtenir un hub fonctionnel (agents +
workflows + références de base de connaissances, jamais de secrets ou de contenu de connaissances).

- Un seul prompt adapté → [`templates/community/`](../../templates/community/).
- Un hub importable entier (multi-agents + workflows) →
  [`templates/community/templates/`](../../templates/community/templates/) — ce
  README décrit le flux en 5 étapes : copiez un exemple phare, adaptez-le, déclarez
  la provenance (`derivedFrom`), validez localement avec `pnpm check:templates`,
  ouvrez une PR.

La barre pour être *fusionné comme modèle communautaire* (la licence est claire, ça se parse,
pas de secrets littéraux) est plus basse que la barre pour être *livré comme phare*
(démo déterministe, posture de gouvernance déclarée, maintenu). Voir
[`GOVERNANCE.md`](../../GOVERNANCE.md).

## Diffuser le projet compte aussi

Vous n'avez pas besoin de livrer du code *ni* un modèle pour contribuer. Porter Gotong
vers les gens — un billet de blog, un tutoriel, une conférence, une vidéo, une
traduction, répondre aux nouveaux dans les Discussions — est un vrai travail, et dans
notre expérience la plupart des projets open source le sous-créditent. **Nous non.**
Un bon produit ne s'améliore que s'il atteint les gens, et reconnaître les personnes
qui font ce travail d'atteindre est le **pilier ⑤** du système de reconnaissance
(voir [`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md)).

- **Chaque effort est enregistré, grand ou petit.** Ouvrez une PR en vous ajoutant (ou
  en ajoutant quelqu'un d'autre) à [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md) avec
  l'emoji correspondant — 📹 vidéo, 📢 conférence, 📝 blog, 🌍 traduction, 💬
  communauté. Un effort de diffusion significatif atterrit dans le registre GitHub au
  même titre qu'une fonctionnalité fusionnée ; aucun effort n'est trop petit pour être
  enregistré.
- **Vous avez fait une bonne vidéo ou un tutoriel ? C'est une PR conforme au format.**
  Ajoutez une entrée à [`LEARN.md`](../../LEARN.md) dans le format listé et ouvrez la
  PR — c'est tout le flux. Si c'est fidèle et vraiment utile, un maintainer le met en
  valeur sur la page dont les nouveaux apprennent, et vous êtes crédité.

Nous reconnaissons le *travail d'atteindre*, pas un nombre d'audience — il n'y a pas
de classement par vues ou abonnés. Voir la limite honnête dans
[`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md).

## Signaler des bugs

Un rapport de bug utile contient :

- Ce que vous avez essayé (ligne de commande complète, variables d'env complètes)
- Ce que vous attendiez
- Ce qui s'est passé (sortie d'erreur complète si applicable, extrait de `transcript.jsonl`
  si le bug est dans le routage / la persistance)
- Versions : `node --version`, `pnpm --version`, OS

Pour les bugs de forme réseau (workers se déconnectant, agents non routés
vers eux), incluez le snapshot `/api/state` — c'est le "que pense le hub
qu'il se passe" canonique.

## Sécurité

Les problèmes de sécurité n'appartiennent **pas** au traqueur d'issues public. Voir
[`SECURITY.md`](../../SECURITY.md).

## Licence

En contribuant, vous acceptez que votre travail soit offert sous la
[licence MIT](../../LICENSE) utilisée par le projet. Pas de CLA.
