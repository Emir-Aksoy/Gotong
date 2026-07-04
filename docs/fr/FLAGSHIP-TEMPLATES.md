# Modèles phares — des hubs qu'une personne ordinaire peut importer et utiliser

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../FLAGSHIP-TEMPLATES.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Il s'agit d'une liste de modèles **approuvés**. « Phare » ne signifie pas « le meilleur », cela signifie « nous le cautionnons » : chacun livre une **démo déterministe** (une commande, sans clé, qui asserte son propre comportement), chacun expose sa **posture de gouvernance** (ce qu'il peut toucher, ce qu'il ne peut pas, où un humain fait office de porte) au grand jour, et chacun **est maintenu**.
>
> Vous voulez voir tous les modèles (y compris le niveau communautaire) ? La galerie de modèles de l'UI admin « Workflows → Template Gallery ». Vous voulez en soumettre un vous-même : [`templates/community/templates/`](../../templates/community/templates/). Les critères de sélection pour cette liste sont écrits dans [`GOVERNANCE.md`](../../GOVERNANCE.md).

---

## Pourquoi ceux-là

Le différenciateur d'Gotong n'est pas « peut appeler l'IA » — c'est partout. C'est que **vous osez pointer l'IA vers votre maison, votre famille, votre argent**, parce que les limites sont réelles et elles vous appartiennent :

- **Un humain fait office de porte pour les actions critiques.** Les actions réversibles (éteindre une lumière) se font simplement ; les irréversibles (verrouiller une porte, dépenser de l'argent, envoyer les données d'un enfant) se suspendent et attendent qu'un humain confirme dans la boîte de réception — le workflow **ne peut pas passer outre** cette porte.
- **Les clés et les données sont sur votre propre disque.** Les identifiants sont chiffrés dans votre répertoire `.gotong/`. La fédération avec un autre hub partage une **capacité**, pas votre coffre.
- **Aucune décision en boîte noire.** Chaque dispatch et résultat est un transcript lisible et en lecture seule. Le framework ne fait jamais tourner le modèle ; il n'y a pas de jugements cachés.

Chaque modèle ci-dessous représente ces trois principes **appliqués à une chose concrète**.

---

## En un coup d'œil

| Modèle | Pour qui | Où un humain fait office de porte (posture de gouvernance) | Le lancer (sans clé) |
|---|---|---|---|
| **smart-home-hub** Maison connectée | personnes avec des appareils domotiques | lumières/climatisation se font directement ; **verrouiller la porte, activer la sécurité** attendent la confirmation de la boîte de réception du résident | `pnpm demo:smart-home-hub` |
| **family-learning-hub** Apprentissage familial | parents ouvrant l'IA aux enfants | les sujets hors liste blanche et les données d'un enfant qui sortent **nécessitent tous deux l'approbation parentale** ; l'abonnement et les données restent chacun à la maison | `pnpm demo:family-learning-hub` |
| **cafe-ops** Opérations de commerce | propriétaire / gérant de petit commerce | paie des heures supplémentaires : **l'assistant ne fait que suggérer, le gérant décide de l'argent** ; le planning a besoin de la confirmation du gérant | `pnpm demo:cafe-ops` |
| **personal-coding-hub** Programmation personnelle | personnes voulant que l'IA aide à écrire du code | les commandes dangereuses (rm -rf / push --force) se suspendent pour votre approbation ; la division du travail est à vous de définir | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** Programmation (Codex+DeepSeek) | idem, ensemble de modèles différent | idem | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** Recherche personnelle | personnes avec une pile de matériaux à démêler | compilation en lecture seule, transformant les matériaux bruts en un wiki interconnecté | `pnpm demo:personal-research-hub` |
| **battle-monk-training** Croissance personnelle | personnes voulant un plan d'entraînement quotidien | écrit uniquement votre propre dossier de croissance ; ne donne aucun conseil médical/psychologique | `pnpm demo:battle-monk-training` |
| **warband-club** Club de loisirs | communauté d'intérêts / warband | l'archive partagée est en lecture/écriture par tous ; les décisions importantes passent par la confirmation du chef | `pnpm demo:warband-club` |
| **tea-supply-link** Approvisionnement inter-org | commerces traitant avec un fournisseur | la commande **nécessite une approbation humaine avant de traverser les lignes org** ; le fournisseur cite le montant, un humain décide | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** QG de chaîne | QG gérant des franchises | une directive de réajustement des prix **nécessite l'approbation du directeur régional avant déploiement** ; la boutique est une partie souveraine, pas un subordonné | `pnpm demo:tea-chain-hq` |

Chacun est accompagné d'un `pnpm demo:<name>:template` — lit ce fichier modèle, le parse, et prévisualise l'architecture qu'il déclare (pas de sous-processus, pas de clé), vous voyez ainsi « ce qui est empaqueté dans le modèle, ce qui vit en dehors ».

---

## Maison & famille

### ⭐ smart-home-hub — Maison connectée (Xiaomi via Home Assistant)

**Qui / quoi.** Un garant de la maison contrôle vos appareils Xiaomi (ou tout appareil intégré à HA) via Home Assistant, en exécutant une « routine de bonne nuit ».

**Ce qu'il peut toucher.** Éteindre les lumières des zones communes, passer la climatisation de la chambre en mode sommeil — ce sont des actions **réversibles**, qui se font simplement.

**Où un humain fait office de porte (posture de gouvernance).** Verrouiller la porte d'entrée et activer la sécurité sont des actions **physiques / de sécurité irréversibles** — le workflow, en atteignant cette étape, **se suspend** et attend que le résident clique sur « confirmer » dans la boîte de réception `/me` avant d'exécuter. Refuser → cette étape est ignorée par la porte `when:` → **la porte reste déverrouillée** (fail-closed, bloquant l'action suivante, sans débordement). C'est exactement ce à quoi ressemble « actions réversibles faites directement, actions irréversibles nécessitant confirmation humaine » appliqué à une maison.

**Séparation modèle/framework.** Le câblage MCP de l'appareil dans le modèle est composé de placeholders `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` — quel Home Assistant vous connectez et quel token vous utilisez est une configuration d'exécution renseignée après l'import. Le workflow ne nomme que des capacités (`home.apply-scene` / `home.secure`), jamais un appareil spécifique. Changez les appareils, changez la maison, et le workflow ne change pas d'un mot. Ce modèle **n'a pas de slot KB** (l'état des appareils est HA en direct, aucune base de connaissances séparée n'est nécessaire).

- Le lancer : `pnpm demo:smart-home-hub` (deux scénarios : approbation → porte verrouillée ; refus → porte reste déverrouillée)
- Modèle : [`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- Câblage du vrai Home Assistant : voir le [README](../../examples/smart-home-hub/README.md)

### ⭐ family-learning-hub — Apprentissage familial (parents ouvrant l'IA aux enfants)

**Qui / quoi.** Un parent paye pour un abonnement IA, l'enfant apprend sur un hub **séparé** ; le hub de l'enfant appelle l'abonnement du parent via autorisation, et un tuteur IA (une recréation du `/teach` de Matt Pocock : d'abord établir la mission, une petite étape, la connaissance avant la compétence, citer une source primaire) guide l'exploration de l'enfant. C'est le modèle le **plus durci pour la production** de la liste (vrai ws en fédération + supervision IM + vrai DeepSeek tous testés).

**Ce qu'il peut toucher.** Dans les sujets de la liste blanche, le tuteur enseigne directement ; la **copie principale** des dossiers d'apprentissage est sur le hub de l'enfant.

**Où un humain fait office de porte (posture de gouvernance) — quatre portes.**

1. **Liste blanche de sujets + auto-évaluation du contenu** → les sujets hors liste blanche, et le contenu que le tuteur a auto-signalé comme `flagged`, **se suspendent pour approbation parentale**.
2. **Porte de classification des données** : les données de l'enfant sont taguées `child-learning`, et ne peuvent pas être envoyées à un tiers non autorisé pour cette classe de données (fail-closed).
3. **Juridiction** : le parent détient l'abonnement (le verrou économique) + un contrat de confiance par lien de fédération + un fork de transcript tout au long (le parent obtient une copie de supervision).
4. **Identifiants / données restent chacun à la maison** : deux hubs souverains, les données de l'enfant envoient une copie au parent depuis le côté de l'enfant, mais l'abonnement et le coffre ne traversent pas.

**Séparation modèle/framework.** Le lien inter-org (quel pair enfant, quelles capacités sont autorisées en sortie, la politique d'approbation, `allowedDataClasses`) est une **configuration de pair d'exécution**, ni dans le modèle ni dans le workflow. Deux modèles : côté parent `family-tutor` (avec le tuteur + workflow de liste blanche/approbation), côté enfant `child-desk` (zéro abonnement + la copie principale du dossier d'apprentissage).

- Le lancer : `pnpm demo:family-learning-hub` (six scénarios, y compris hors liste blanche → le parent approuve / le parent refuse → la leçon n'est pas enseignée)
- Modèles : [`family-tutor`](../../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../../examples/family-learning-hub/template/child-desk.template.yaml)
- Déploiement réel (deux machines souveraines) : [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md) · Conception : [`FAMILY-LEARNING-HUB-DESIGN.md`](../zh/FAMILY-LEARNING-HUB-DESIGN.md)

---

## Productivité personnelle

### personal-coding-hub — Programmation personnelle (Claude Code + Codex, division du travail)

**Qui / quoi.** Un « modèle » de routage analyse la tâche + prend en compte votre arrangement, et décide de dispatcher le travail à Claude Code ou à Codex ; les deux agents de programmation partagent un répertoire de travail et collaborent via `AGENTS.md` (la spec) + `PROGRESS.md` (le bâton de relais). Il y a aussi une **consultation contradictoire** : quand un problème survient, plusieurs agents lisent le code ensemble, diagnostiquent à l'aveugle d'abord puis se contre-interrogent, et votent pour converger sur la vraie cause racine.

**Où un humain fait office de porte (posture de gouvernance).** Les commandes dangereuses (`rm -rf`, `git push --force`, `sudo`, `curl | sh` …) se suspendent **avant** l'exécution pour votre approbation ; refus → fail-closed, la commande n'a jamais été exécutée. La division du travail est **à vous de décider** : nommez-la ad hoc (« donne celui-là à codex ») ou changez la couche de division globale en langage naturel (style OpenClaw, réécrit dans `routing-policy.json`).

**Séparation modèle/framework.** Le modèle porte 1 agent mentor (`coding-mentor`, DeepSeek + mcp-obsidian intégré) + 1 slot KB adressable (la bibliothèque de méthodologie, un pointeur `presetData`). Les deux agents CLI de programmation sont **câblés à l'exécution** (CliParticipant n'entre pas dans le registre des agents gérés) ; le **contenu** de connaissance vit en dehors du modèle.

- Le lancer : `pnpm demo:personal-coding-hub` (10 scénarios : division du travail / assignment explicite / re-division en langage naturel / porte de sécurité)
- Consultation : `pnpm demo:personal-coding-hub:consult`
- Modèle : [`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub — Programmation (Codex + DeepSeek TUI)

La **sœur** de personal-coding-hub : un ensemble de modèles différent — Codex (le rapide implémenteur) + DeepSeek TUI (le raisonnement principal). Le même routage + re-division en langage naturel + assignment explicite + porte de sécurité, autonome et ne touchant pas personal-coding-hub.

- Le lancer : `pnpm demo:codex-deepseek-hub`
- Modèle : [`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub — Recherche personnelle / hub de connaissances

**Qui / quoi.** Un bibliothécaire **compile** vos matériaux sources bruts en un wiki Obsidian interconnecté (LLM-as-compiler), puis vous permet de « demander à votre wiki ». Trois agents LLM gérés (bibliothécaire / compilateur / chercheur) s'installent en équipe.

**Posture de gouvernance.** La compilation est une transformation **en lecture seule** des bruts en notes + backlinks ; les réponses citent les sources et sont archivées dans `wiki/answers/`.

- Le lancer : `pnpm demo:personal-research-hub`
- Modèle : [`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training — Croissance personnelle (corps / esprit / savoir, trois piliers)

**Qui / quoi.** Un précepteur dispatche le drill du jour aux trois piliers (corps / esprit / savoir), chacun avançant au rang suivant en fonction des rangs déjà entraînés dans votre dossier, avec la continuité comme cœur de conception — le KB Obsidian **stocke votre état** (pas du matériel de référence). Un style froid grimdark-monastique (un hommage fan original, visant les utilisateurs de style Warhammer 40k).

**Posture de gouvernance / limite de sécurité.** Il **écrit uniquement votre propre dossier de croissance** ; ce sont des données personnelles, **pas des conseils médicaux / psychologiques** — ne les traitez pas comme seule base pour quoi que ce soit.

- Le lancer : `pnpm demo:battle-monk-training`
- Modèle : [`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## Organisations & inter-organisations

### cafe-ops — Opérations de commerce (salon de thé à bulles / café)

**Qui / quoi.** Les processus formels d'un petit commerce : intégration des nouveaux employés (apprentissage du SOP du poste, libre-service membre), planning (confirmation du gérant), paie des heures supplémentaires (approbation du gérant). Le premier modèle avec un `workflows[]` non vide — la valeur d'une organisation est dans le processus formel.

**Où un humain fait office de porte (posture de gouvernance).** Paie des heures supplémentaires : **l'assistant ne suggère que le montant, le gérant décide de l'argent** : l'assistant calcule le multiplicateur selon le type de jour (jour ouvrable 1,5 / jour de repos 2 / jour férié légal 3), mais le workflow, en atteignant l'étape d'approbation, se suspend et n'est mis en œuvre qu'une fois que le gérant approuve dans la boîte de réception. **L'argent est calculé de façon déterministe, pas par un LLM ; un humain décide.**

- Le lancer : `pnpm demo:cafe-ops` (inclut la reprise en deux étapes HITL des heures supplémentaires)
- Modèle : [`examples/cafe-ops/template/cafe-ops.template.yaml`](../../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club — Club de loisirs (archive partagée)

**Qui / quoi.** La **face collaborative** d'une communauté d'intérêts / warband (par opposition à la face de gestion de cafe-ops) : une archive partagée que tout le groupe lit et écrit — le schéma de peinture / rapport de bataille que vous soumettez, les autres peuvent le consulter ; la réponse que vous obtenez peut venir de la contribution antérieure de quelqu'un d'autre = collaboration.

**Posture de gouvernance.** L'archive partagée est en lecture/écriture par tous ; les décisions importantes (un rassemblement) passent par la confirmation `human:` du chef. Partagé au sein d'un hub, pas de fédération.

- Le lancer : `pnpm demo:warband-club`
- Modèle : [`examples/warband-club/template/warband-club.template.yaml`](../../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link — Approvisionnement inter-org (salon de thé ↔ fournisseur)

**Qui / quoi.** Le premier modèle **inter-org** : le workflow de réapprovisionnement d'un salon de thé orchestre une étape vers **le hub du fournisseur**.

**Où un humain fait office de porte (posture de gouvernance).** L'étape de commande inter-org passe par une **porte d'approbation en sortie** (transparente pour le workflow, donc le workflow **n'a pas** d'étape `human:`) — ce n'est qu'après l'approbation du gérant qu'elle traverse la frontière, le fournisseur fixe les prix ligne par ligne par catalogue + inventaire en direct, et le reçu revient pour être archivé localement. Le fournisseur calcule l'argent, un humain décide de l'envoyer.

**Séparation modèle/framework (point pédagogique).** Le lien inter-org (quel pair est le fournisseur, quelles capacités sont autorisées en sortie, la politique d'approbation) est une **configuration de pair d'exécution**, ni dans le modèle ni dans le workflow — l'étape `place` n'écrit que la capacité `supplier.confirm-order`, sans jamais nommer un pair.

- Le lancer : `pnpm demo:tea-supply-link`
- Modèle (côté boutique) : [`examples/tea-supply-link/template/tea-shop.template.yaml`](../../examples/tea-supply-link/template/tea-shop.template.yaml)
- Runbook opérateur deux machines : [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md)

### tea-chain-hq — QG de chaîne (QG → boutiques franchisées)

**Qui / quoi.** Le **miroir, direction inverse** de tea-supply-link : celui-là va vers le haut (boutique→fournisseur), celui-ci va vers le bas (QG→boutique franchisée). Dans la chaîne à trois niveaux `QG → boutique → fournisseur`, la boutique est au milieu.

**Où un humain fait office de porte (posture de gouvernance).** L'étape inter-org de déploiement d'une directive de réajustement des prix passe par une porte d'approbation en sortie — ce n'est qu'après l'approbation du directeur régional qu'elle traverse la frontière, la boutique applique le réajustement des prix de façon déterministe selon son propre menu, et le reçu revient. **La boutique est une organisation souveraine, pas un objet subordonné.**

- Le lancer : `pnpm demo:tea-chain-hq`
- Modèle (côté QG) : [`examples/tea-chain-hq/template/chain-hq.template.yaml`](../../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## Lancer n'importe lequel avec une seule commande (déterministe, sans clé)

Chaque phare a une **démo déterministe** : exécute le flux entier avec des remplaçants déterministes, assertant son propre comportement, sans clé API, sans vrai appareil / vrai compte. C'est la moitié vérifiable de « nous le cautionnons » — une commande prouve qu'il tourne vraiment :

```bash
pnpm demo:smart-home-hub          # maison: approbation→porte verrouillée / refus→porte reste déverrouillée
pnpm demo:family-learning-hub     # famille: hors liste blanche→le parent approuve / le parent refuse→leçon non enseignée
pnpm demo:cafe-ops                # commerce: heures sup HITL, le gérant décide de l'argent
pnpm demo:personal-coding-hub     # programmation: division du travail + porte de sécurité
pnpm demo:personal-research-hub   # recherche: brut → wiki interconnecté
pnpm demo:battle-monk-training    # croissance: corps/esprit/savoir trois piliers
pnpm demo:warband-club            # club: archive partagée + confirmation du chef
pnpm demo:tea-supply-link         # inter-org: commande inter-frontière nécessite approbation humaine
pnpm demo:tea-chain-hq            # chaîne: déploiement de réajustement des prix nécessite approbation humaine
pnpm demo:codex-deepseek-hub      # programmation (Codex + DeepSeek)
```

Pour voir comment le modèle lui-même est parsé (un aperçu de chargement, aussi sans clé) : remplacez n'importe lequel des éléments ci-dessus par `pnpm demo:<name>:template`.

---

## Utilisation réelle

La démo déterministe prouve que la logique fonctionne ; pour utiliser réellement un phare, suivez ces voies :

- **Installation en un clic** : cliquez sur un dans la « Galerie de modèles » Workflows de l'UI admin et il est installé dans votre hub (voir [`docs/zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)).
- **Comparaison hub personnel / org + onboarding réel DeepSeek/Obsidian** : [`docs/zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md).
- **Mise en ligne (trois topologies)** : [`docs/zh/GO-LIVE.md`](../zh/GO-LIVE.md).
- **Runbook deux machines fédération inter-org** : [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md).
- **Déploiement deux machines souveraines apprentissage familial** : [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md).

---

## Classement des citations (qui a été le plus adapté)

La provenance honnête est la seule monnaie de cette communauté. Quand vous forkez un modèle, écrivez son slug dans votre `provenance.derivedFrom` — et le crédit remonte en amont. Le tableau ci-dessous classe par « combien de modèles déclarent `derivedFrom` lui » (fois cité = degré entrant), **généré de façon déterministe** par [`pnpm build:leaderboard`](../../packages/web/scripts/build-leaderboard-doc.mjs) depuis le corpus de modèles validé, le même calcul que le classement de la [vitrine statique](../COMMUNITY-SITE.md) (jamais en conflit) :

> Note : le générateur de classement écrit actuellement les marqueurs dans la source chinoise ([`docs/zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md)). Le snapshot ci-dessous est un miroir manuel de ce tableau généré ; le recâblage du générateur pour cibler ce document anglais est un suivi tracé.

| # | Modèle | Fois cité | Adapté par |
|---|---|---|---|
| 1 | **Mentor de programmation personnelle (workflow Karpathy)** (`personal-coding-hub`) | 1 | Mentor de programmation en pair (Codex × DeepSeek TUI) |
| 2 | **Salon de thé (lien d'approvisionnement inter-org)** (`tea-supply-link`) | 1 | QG de chaîne de salons de thé (déploiement de directives inter-org) |

> Le tableau est **généré** : après avoir ajouté une arête `derivedFrom`, exécutez `pnpm build:leaderboard` pour re-rendre la source. `packages/web/tests/build-leaderboard-doc.test.ts` surveille qu'elle reste synchronisée avec le vrai corpus — les modifications manuelles ou l'oubli de re-rendre sont détectés par le test. Le classement classe les **modèles**, pas les personnes — c'est une incitation à la **reconnaissance**, pas une récompense ou une incitation économique (voir [`docs/zh/RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md) / [`RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md)).

---

## Vous voulez en contribuer un

Les phares sont peu nombreux et approuvés. La grande majorité des modèles devrait être de **niveau communautaire** — la barre est « libre de droits, se parse, zéro secrets en clair, a une provenance », pas « nous cautionnons votre goût ». Le flux est dans [`templates/community/templates/README.md`](../../templates/community/templates/README.md) : copiez un phare → adaptez-le au vôtre → déclarez la provenance (`derivedFrom`) → `pnpm check:templates` localement → ouvrez une PR.

La provenance honnête est la monnaie de cette communauté : `derivedFrom` renvoie le crédit en amont, et le classement des citations statique compte simplement « combien de modèles dérivent de vous ». La promotion du niveau communautaire au niveau phare est une décision des mainteneurs sur une issue publique — les critères sont dans [`GOVERNANCE.md`](../../GOVERNANCE.md).
