# Système de reconnaissance

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../RECOGNITION-SYSTEM.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Ce système distribue uniquement de la **reconnaissance** — pas d'argent, pas de
> jeton, pas de prime. Sa « monnaie » est une provenance honnête, une attribution
> visible, et un chemin documenté vers un vrai mot à dire sur la direction du projet.
>
> 中文版 / Chinese: [`zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) ·
> Dernière mise à jour : 2026-06-27

---

## 1. Pourquoi la reconnaissance seulement

La forme à long terme d'Gotong est un **marché gouverné de composants réutilisables**
— modèles, adaptateurs, connecteurs de bases de connaissances — construit pour que les
gens lui fassent suffisamment confiance pour le pointer vers leur maison, leur famille
ou leur argent (voir [`GOVERNANCE.md`](../../GOVERNANCE.md) § « Vers un comité des
composants »). Pour qu'un marché vive, les contributeurs ont besoin d'une raison de
remettre leur bon travail — et de continuer à le maintenir.

Nous avons pesé quatre candidats et **ne faisons que les deux premiers** :

| Candidat | Ce que c'est | Décision |
|---|---|---|
| **A — classement des citations dans FLAGSHIP** | Rendre le classement « qui est le plus forké » dans un doc intégré, visible dans le dépôt sans déployer un site statique. | ✅ faire |
| **B — une échelle de mainteneur quantifiée** | Donner au chemin de promotion de `GOVERNANCE.md` un critère **léger et mesurable** + un `MAINTAINERS.md`. | ✅ faire |
| **C — une couche économique / de récompense** | Primes, jetons, partage des revenus. | ❌ abandonner |
| **D — ne rien faire** | Maintenir le statu quo. | ❌ abandonner |

**Abandonner C est délibéré, pas paresseux.** L'Étoile du Nord dit que le framework
ne fait pas tourner le LLM, l'état est des fichiers sur disque, les credentials
restent locaux, la fédération est pair-à-pair — et une couche d'incitation qui
introduit de l'argent brouillerait immédiatement ce modèle de confiance : qui garde
le registre ? comment un partage des revenus est-il réglé entre les hubs ? qui a
l'autorité pour fixer un prix ? Chacun d'eux attirerait le projet vers un centre,
loin de « le Hub est simple et les décisions vivent avec les participants. »
**Un système de pure reconnaissance est nativement axé sur les fichiers et nativement
décentralisé :** l'attribution est une ligne `provenance` dans un fichier de modèle,
le classement est un calcul déterministe, la promotion est un consensus paresseux sur
une issue publique — aucun d'eux n'a besoin d'un pot d'argent central.

Donc la « monnaie » de ce système est trois choses, et aucune d'elles ne coûte rien :

1. **Provenance honnête** — `provenance.derivedFrom` fait remonter le crédit en amont.
2. **Attribution visible** — le classement et l'index phare mettent votre nom à
   l'endroit le plus visible.
3. **Un chemin documenté vers un mot à dire** — un bon travail soutenu gagne un
   statut de mainteneur et une vraie voix, pas un paiement.

Ces trois éléments sont aussi le test pour tout ce que nous *ajoutons* au système :
cela doit ne rien coûter et tirer vers les fichiers et les personnes, pas vers un
centre. **Le pilier ⑤ ci-dessous — reconnaître la diffusion — est la seule extension
délibérée.** Il élargit *l'attribution visible* pour couvrir le travail de porter le
projet vers les gens, que les quatre premiers piliers, tous ancrés dans des artefacts
du dépôt, ne peuvent structurellement pas voir. Il n'introduit ni argent ni backend de
suivi ; ce sont deux fichiers markdown.

---

## 2. Les piliers

Ce système est constitué de cinq piliers. Les quatre premiers (①–④) **existent déjà et
sont déjà câblés** — ce document nomme les parties existantes comme un seul système
plutôt que d'inventer un sous-système. Le cinquième (⑤) est **la seule addition
délibérée** : deux artefacts légers, axés sur les fichiers, qui reconnaissent le travail
de *porter le projet vers les gens* — le travail que les quatre premiers ne peuvent
structurellement pas voir.

### Pilier ① — le classement des citations (le crédit remonte)

> « Qui est le plus remixé » = « qui est le plus utile. »

Chaque manifeste de modèle porte un `provenance.derivedFrom`. Quand vous forkez un
modèle, vous écrivez le slug en amont dans votre propre `derivedFrom`. Le classement
classe par **in-degree** — combien de modèles se déclarent dérivés de vous.

- **Mécanisme** : les fonctions pures `loadCorpus` + `buildModel` dans
  `packages/web/scripts/build-site.mjs` calculent l'in-degree à partir du corpus validé.
- **Deux cibles de rendu, un seul calcul** :
  - Le site statique ([`zh/COMMUNITY-SITE.md`](../zh/COMMUNITY-SITE.md)) le rend ;
  - Le **doc intégré** (la section « classement des citations » de
    [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md)) le rend aussi — c'est le
    **pilier A**, écrit dans un bloc marqueur `<!-- LEADERBOARD:START -->` par
    `pnpm build:leaderboard` (`build-leaderboard-doc.mjs`). Vous pouvez voir le
    classement dans le dépôt sans jamais déployer un site statique.
- **Garde contre la dérive** : `packages/web/tests/build-leaderboard-doc.test.ts`
  refait le rendu à partir du corpus réel et affirme que le bloc intégré est identique
  octet par octet — ajoutez une arête `derivedFrom` mais oubliez de relancer
  `pnpm build:leaderboard`, et CI nomme l'échec plutôt que de laisser le tableau pourrir
  silencieusement.
- **Il classe les modèles, pas les personnes.** C'est la frontière honnête qui compte :
  le classement mesure combien un *composant* est réutilisé ; il ne fait pas tourner
  un culte de la personnalité ni ne frappe des points de headcount gamifiables.

### Pilier ② — l'échelle des mainteneurs (un chemin vers un mot à dire)

> Le point d'aboutissement d'une bonne contribution est la **confiance + la
> responsabilité**, pas un prix.

Le « Devenir mainteneur » de `GOVERNANCE.md` donne un critère **délibérément léger
et mesurable** (c'est le **pilier B**) :

- **Un historique, pas un décompte** : de l'ordre de ~5 PRs non triviales fusionnées —
  ou l'équivalent (un modèle phare que vous maintenez, un adaptateur substantiel, de la
  relecture / du tri soutenu) — sur quelques mois. Le nombre est un **plancher** pour
  « nous avons vu suffisamment de votre jugement », jamais une **cible** à atteindre
  avec des PRs de passage.
- **Une compréhension de la ligne de conception** : vos PRs et revues montrent que
  vous cherchez un *participant*, pas le Hub, quand la logique a besoin d'un endroit
  (voir `GOVERNANCE.md` § « L'unique non-négociable »).
- **Nommé publiquement** : un mainteneur existant vous nomme sur une issue publique
  (l'auto-nomination est acceptable) ; le consensus paresseux passe, le garant confirme,
  et votre nom arrive dans [`MAINTAINERS.md`](../../MAINTAINERS.md) dans cette même PR.

`MAINTAINERS.md` ne contient aujourd'hui que le mainteneur fondateur. Tout le propos
de ce fichier est que le **deuxième** mainteneur rejoigne par un chemin **écrit**, pas
un geste — une ligne de responsabilité ne devrait jamais être une habitude non écrite.
Quand le volume de contribution sera assez grand pour que la curation soit un travail
permanent, `GOVERNANCE.md` enregistre déjà le plan pour mettre en place un **comité
des composants**.

### Pilier ③ — partage sans friction (rendre le transfert bon marché)

> La friction est l'ennemi de l'incitation. Installer un modèle est un clic ; le
> soumettre ne devrait pas nécessiter vingt étapes.

- **Installation en un clic** : la **galerie de modèles** dans le panneau admin
  « Workflows » ([`zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)) liste les
  modèles soignés livrés avec le framework, installation en un clic réutilisant le
  `POST /templates/import` existant.
- **Soumission en cinq étapes** : le flux de soumission de modèle communautaire vit
  dans [`templates/community/templates/README.md`](../../templates/community/templates/README.md)
  — copiez un phare → faites-en le vôtre → déclarez la provenance → lancez
  `pnpm check:templates` localement → ouvrez une PR.
- **La barre est la sécurité et l'honnêteté, pas le goût** : le niveau communautaire
  demande seulement « licence claire, se parse, zéro secret en clair, provenance
  déclarée » (`GOVERNANCE.md` § « Modèles communautaires ») ; atteignez-le et ça
  fusionne. À ce niveau nous sélectionnons la *sécurité et l'honnêteté*, pas votre goût.

La commodité est en elle-même une incitation : moins il est coûteux de transférer un
modèle, plus les gens publieront les bons workflows qu'ils gardent en privé — et chaque
publication honnête et attribuée donne à l'amont une citation de pilier ① de plus.

### Pilier ④ — exemplaires partagés (des choses qui valent la peine d'être remixées)

> Un classement a besoin de choses à citer ; d'abord il doit y avoir des exemplaires
> qui valent la peine d'être cités.

- **Niveau phare** : [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md) — un
  petit ensemble soigneusement sélectionné que le projet garantit et recommande à un
  utilisateur non technique. La barre est plus haute (démo déterministe + posture de
  gouvernance claire + un mainteneur, voir `GOVERNANCE.md` § « Modèles phares »).
- **Galerie intégrée** : les modèles embarqués avec le framework, installables en un
  clic depuis l'interface admin.
- **examples/** : démos de bout en bout, chacune un point de départ à forker.

Les exemplaires sont la **graine** de la boucle : sans bons exemplaires, le partage
sans friction n'a rien à partager et le classement n'a rien à classer. Écrivez bien
un exemplaire, énoncez clairement sa posture de gouvernance, et les gens le forkent,
le citent, et font grandir leur propre travail par-dessus.

<a id="pillar-5"></a>

### Pilier ⑤ — reconnaître la diffusion (la portée est un vrai travail)

> Un bon produit ne s'améliore que s'il atteint les gens. Les quatre piliers ci-dessus
> récompensent tous le travail qui laisse une trace *dans le dépôt* ; porter le projet
> *vers les gens* ne laisse pas d'arête `derivedFrom` — donc sans cinquième pilier il
> reste invisible.

Les quatre premiers piliers partagent un angle mort : ils s'ancrent dans des artefacts
du dépôt. Le classement compte les arêtes `provenance` ; l'échelle des mainteneurs
compte les PRs fusionnées ; les deux sont aveugles à la personne qui écrit le tutoriel
qui fait enfin comprendre la fédération, donne la conférence qui amène cinquante
personnes au projet, tient la salle où les nouveaux se débloquent, ou traduit la
documentation dans une langue que l'équipe centrale ne parle pas. **Ce travail est la
différence entre un bon framework que personne ne trouve et un bon framework que les
gens utilisent vraiment** — et la plupart des projets open source le sous-créditent. À
l'ère de l'IA, l'écart est plus marqué : construire est moins cher que jamais, donc le
travail rare et décisif est *la découverte et la confiance* — et c'est précisément le
travail que les quatre premiers piliers ne peuvent pas voir. Le reconnaître est une
différenciation délibérée, pas une réflexion après coup.

Le pilier ⑤ ajoute donc deux artefacts légers, axés sur les fichiers — et rien de plus
lourd :

- **Un registre typé des contributeurs — [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md).**
  Une table maintenue à la main qui enregistre *chaque* type de contribution, grande ou
  petite, à côté du code, en utilisant le vocabulaire emoji de
  [All Contributors](https://allcontributors.org) — 💻 code, 📖 docs, 🌍 traduction,
  📝 blog, 📹 vidéo, 📢 conférence, ✅ tutoriel, 💬 support communautaire,
  📋 organisation d'événements. C'est **un registre, pas un classement** : il indique
  *ce que vous avez fait*, au grand jour, avec votre nom dessus — il ne classe pas les
  gens selon un chiffre. Un effort de diffusion significatif atterrit dans le registre
  au même titre qu'une fonctionnalité fusionnée, et aucun effort n'est trop petit pour
  être enregistré. Nous utilisons la *taxonomie* All Contributors mais **pas** son bot
  ou GitHub Action (le dépôt ne dépense pas de budget Actions pour la comptabilité, et
  une table markdown est la chose la plus légère et honnête) ; vous êtes ajouté par un
  PR ordinaire.
- **Une vitrine d'apprentissage — [`LEARN.md`](../../LEARN.md).** Les meilleurs
  matériels communautaires pour apprendre Gotong — vidéos, conférences, tutoriels,
  articles — chacun crédité à son auteur et lié depuis le README. C'est **l'analogue de
  diffusion du pilier ④** : les templates phares sont les meilleures choses à *réutiliser* ;
  les entrées LEARN sont les meilleures choses dont *apprendre*. Mettre en valeur la
  vidéo de quelqu'un ici est un acte de reconnaissance concret et visible — et cela
  double comme l'endroit où un nouveau venu va apprendre du meilleur matériel que la
  communauté a produit.

**Ce que nous reconnaissons, c'est le travail d'atteindre — pas un score de portée.**
Nous ne construisons délibérément *pas* de « classement de diffusion » basé sur les
vues, abonnés ou comptes de référence : ceux-ci sont manipulables, ils nécessiteraient
un backend de suivi que le North Star ne veut pas (le Hub est simple ; l'état est des
fichiers), et ils tireraient le projet vers la vanité. Nous ne pouvons pas mesurer
honnêtement « combien de personnes votre vidéo a amenées », mais nous *pouvons*
enregistrer honnêtement « vous avez fait la vidéo » et *pouvons* sélectionner « cette
vidéo est assez bonne pour que nous envoyions les nouveaux vers elle ». Cela enregistre
la contribution et évite le piège des métriques en un seul mouvement — de la même façon
que le pilier ① **classe les templates, pas les personnes**, le pilier ⑤ **enregistre
et sélectionne le travail, pas la taille de l'audience**.

Et la diffusion confère un standing, pas seulement une ligne : l'échelle des mainteneurs
dans `GOVERNANCE.md` compte le travail de diffusion soutenu — la gestion de la
localisation, l'animation de la communauté, le matériel éducatif soutenu — comme un
**parcours équivalent** au code vers une vraie voix dans le projet (pilier ②). Une
personne qui n'écrit jamais une ligne de code du framework mais maintient la
documentation vivante dans trois langues et répond aux nouveaux chaque semaine contribue
exactement le type de jugement soutenu que l'échelle est censée reconnaître.

---

## 3. Comment les piliers se renforcent mutuellement

Les piliers ①–④ ne sont pas quatre choses isolées — ils forment une **boucle
d'auto-renforcement** qui se met en marche une fois qu'une personne est déjà dans le
dépôt :

```
   ④ exemplaires  ──fork──▶  ③ partage sans friction  ──PR + provenance honnête──▶  ① classement
        ▲                                                                                │
        │                                                             cité = attribution visible
        │                                                                                │
        └──────────────  bon travail soutenu  ◀──②  échelle mainteneur  ◀──────────────┘
                       (nouveaux exemplaires / maintenir les anciens / réviser ceux des autres)
```

1. Vous partez d'un **exemplaire phare (④)** ;
2. vous en faites le vôtre, vous le rendez à travers le **partage sans friction (③)**,
   et vous **attribuez honnêtement** l'amont dans `provenance` ;
3. votre provenance honnête ajoute une **citation (①)** à l'amont, qui grimpe dans le
   classement — le crédit remonte ;
4. votre propre modèle commence à être forké et cité, et votre nom arrive dans le
   classement et l'index phare ;
5. un bon travail soutenu (nouveaux exemplaires, maintenance des anciens, révision de
   ceux des autres) vous fait gravir l'**échelle des mainteneurs (②)** vers la confiance
   et une voix — et en tant que mainteneur vous garantissez de nouveaux exemplaires
   phares (④), et la boucle tourne à nouveau.

**Aucune étape n'a besoin d'argent.** Ce qui fait tourner toute la boucle est
« ma chose est utile, les gens l'utilisent, mon nom est visible, et ce que je dis
commence à compter » — pure reconnaissance, et exactement suffisant.

**Où le pilier ⑤ s'inscrit.** La boucle ci-dessus est le volant d'inertie *dans le
dépôt* — il tourne une fois qu'une personne est déjà là. Le pilier ⑤ élargit l'entrée
de l'entonnoir : le travail de diffusion (une conférence, une vidéo, une traduction, une
salle communautaire active) est la façon dont une personne *arrive* aux exemplaires en
premier lieu, et la façon dont le travail qu'elle publie ensuite trouve son propre
public. Il ne change pas la boucle à quatre piliers ; il y amène des gens et en porte
la production vers l'extérieur. Le reconnaître rend visibles les personnes qui font ce
travail, au lieu de traiter la distribution comme quelque chose qui arrive tout seul.

---

## 4. Ce que nous ne faisons pas (frontière honnête)

- **Pas d'argent / pas de jeton / pas de prime** (candidat C, abandonné).
- **Le classement ne classe pas les personnes** : il classe combien un modèle est
  réutilisé, pas des points personnels gamifiables.
- **Nous reconnaissons le travail de diffusion, pas un score de diffusion** : pas de
  classement vues / abonnés / références — ceux-ci sont manipulables et nécessiteraient
  un backend de suivi que le North Star refuse. [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md)
  enregistre *ce que vous avez fait* ; [`LEARN.md`](../../LEARN.md) sélectionne *ce qui
  vaut la peine d'apprendre* ; aucun des deux ne classe les gens par taille d'audience.
- **La promotion n'est pas automatique** : ~5 PRs est un plancher, pas un interrupteur ;
  la décision finale est un jugement humain + consensus paresseux sur une issue
  publique, pas un compteur qui se déverrouille.
- **Presque aucune nouvelle machinerie** : les piliers ①–④ sont des choses qui
  **existent déjà et sont déjà câblées**. Le pilier ⑤ ajoute exactement deux fichiers
  markdown maintenus à la main (`CONTRIBUTORS.md`, `LEARN.md`) — pas de bot, pas de
  GitHub Action, pas de service de suivi. C'est toute la surface « nouvelle », et c'est
  délibérément la chose la plus légère qui puisse fonctionner.

---

## 5. Docs connexes

| Je veux savoir | Lire |
|---|---|
| Index phare + classement des citations (piliers ①④) | [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md) |
| Processus de décision + échelle des mainteneurs (pilier ②) | [`GOVERNANCE.md`](../../GOVERNANCE.md) |
| Liste actuelle des mainteneurs (pilier ②) | [`MAINTAINERS.md`](../../MAINTAINERS.md) |
| Registre typé des contributeurs — tous les types de contributions (pilier ⑤) | [`CONTRIBUTORS.md`](CONTRIBUTORS.md) |
| Vitrine d'apprentissage / vidéos sélectionnées (pilier ⑤) | [`LEARN.md`](LEARN.md) |
| Installation en un clic de la galerie de modèles (pilier ③) | [`zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) |
| Flux de soumission de modèle communautaire (pilier ③) | [`templates/community/templates/README.md`](../../templates/community/templates/README.md) |
| Site communautaire zéro-calcul (l'autre cible de rendu du classement) | [`zh/COMMUNITY-SITE.md`](../zh/COMMUNITY-SITE.md) |
| Le salon communautaire (Discussions) | [`zh/COMMUNITY-DISCUSSIONS.md`](../zh/COMMUNITY-DISCUSSIONS.md) |
| 中文版 (Chinese) | [`zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) |
