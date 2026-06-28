# Gouvernance d'AipeHub

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../../GOVERNANCE.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

Ce document décrit **comment les décisions sont prises** dans AipeHub : qui maintient
le projet, comment un changement aboutit, comment un modèle communautaire entre dans la
galerie officielle, et ce qui se passe en cas de désaccord. Il est délibérément court —
le projet est jeune, et une structure de gouvernance lourde sur un petit projet n'est
que de la cérémonie. Nous ferons évoluer ce document à mesure que la communauté grandit,
pas avant.

Ce document est placé sous la constitution du projet, [`CHARTER.md`](../../CHARTER.md) :
la charte dit *ce qu'*AipeHub est et ce qu'il refuse de devenir ; ce document dit *comment*
nous décidons. Là où les deux se rejoignent — par exemple « le framework ne fait pas tourner
le LLM » — la charte est la source et ce document est l'application.

Si vous ne devez lire qu'une chose : **la ligne de conception ne se négocie pas, mais
presque tout le reste si.** Voir [L'unique non-négociable](#lunique-non-négociable).

---

## Rôles

Nous maintenons trois rôles. Il n'y a pas de quatrième niveau secret.

| Rôle | Ce que cela signifie | Comment l'obtenir |
|---|---|---|
| **Contributeur** | Quiconque ouvre une issue, envoie une PR, dépose un modèle, ou aide dans les Discussions. | Il suffit de participer. Pas de candidature. |
| **Mainteneur** | Peut examiner et fusionner des PRs, trier les issues et publier des releases. Responsable d'un sous-système ou du projet dans son ensemble. | Un historique de contributions solides et alignées sur la conception, puis nommé publiquement — voir [Devenir mainteneur](#devenir-mainteneur). |
| **Garant** | Arbitre final en cas de décisions contestées et gardien de la ligne de conception. Aujourd'hui c'est le mainteneur fondateur. | Tenu par le fondateur jusqu'à ce que le projet soit assez grand pour élire des garants (voir [Comité des composants](#vers-un-comité-des-composants)). |

Les mainteneurs actuels sont listés dans [`MAINTAINERS.md`](../../MAINTAINERS.md) — aujourd'hui
il s'agit uniquement du mainteneur fondateur, qui est aussi le garant, le relecteur et le
gestionnaire de releases. Ce document existe précisément pour que cet arrangement soit
**temporaire et écrit**, pas une habitude, et la section suivante décrit le chemin que prendra
le deuxième mainteneur.

### Devenir mainteneur

L'échelle est délibérément légère — c'est un jeune projet, et l'objectif est de constituer
un groupe de personnes qui tiennent la ligne de conception, pas de faire du filtrage. Une
directive approximative, pas une liste à cocher :

- **Un historique, pas un décompte.** De l'ordre de ~5 PRs non triviales fusionnées —
  ou l'équivalent : un modèle phare que vous maintenez, un adaptateur substantiel, ou une
  aide soutenue à la relecture / au tri — sur quelques mois. Le nombre est un plancher
  signifiant « nous avons vu suffisamment de votre travail pour faire confiance à votre
  jugement », jamais une cible à atteindre avec des PRs de passage.
- **Une compréhension de la ligne de conception.** Vos PRs et revues montrent que vous
  cherchez un *participant*, pas le Hub, lorsque la logique a besoin d'un endroit
  (voir [L'unique non-négociable](#lunique-non-négociable)).
- **Nommé publiquement.** Un mainteneur existant vous nomme sur une issue publique — la
  auto-nomination est acceptable, expliquez simplement pourquoi. L'approbation se fait
  par consensus paresseux parmi les mainteneurs, le garant confirme ; votre nom arrive dans
  [`MAINTAINERS.md`](../../MAINTAINERS.md) dans cette même PR.

Ce que vous prenez en charge : la relecture des PRs des autres dans votre domaine,
l'application de la ligne de conception, et la réponse aux issues pour ce que vous
maintenez. C'est une responsabilité que vous pouvez aussi poser — retirez-vous à tout
moment et nous vous déplacerons vers le statut émérite dans `MAINTAINERS.md` plutôt que
de prétendre que vous êtes encore de garde.

Aujourd'hui il y a exactement un mainteneur — le garant fondateur — donc cette échelle est
**écrite mais dormante** : il n'y a encore personne pour faire des nominations. Elle est ici
pour que le *deuxième* mainteneur rejoigne par un chemin connu, pas par un geste ad-hoc.

---

## Comment un changement aboutit

La plupart des changements sont ordinaires, et c'est bien :

1. **Ouvrez d'abord une issue** pour tout ce qui est non trivial — une nouvelle dépendance,
   un changement de forme du protocole, un nouveau package, un changement comportemental de
   la planification ou de la fédération. Les PRs de correction de fautes de frappe et les
   petits correctifs de docs peuvent passer cette étape.
2. **Envoyez une petite PR.** Un changement, une PR. Voir [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
3. **Un mainteneur la révise.** Les revues vérifient trois choses, dans l'ordre :
   l'exactitude, la [ligne de conception](#lunique-non-négociable), et la simplicité.
4. **Fusion.** Consensus paresseux : si aucun mainteneur ne s'y oppose dans un délai
   raisonnable et que les vérifications CI / locales passent, la fusion a lieu. Les
   objections sont résolues par discussion ; une vraie impasse va au garant.

Nous n'exigeons pas de CLA. En contribuant, vous offrez votre travail sous la
[licence MIT](../../LICENSE) du projet.

### Décisions qui nécessitent plus qu'une PR

Quelques catégories reçoivent une attention supplémentaire, et un mainteneur les ralentira
délibérément :

- **Changements du protocole wire** — tout ce qui modifie les formes dans
  [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md). Ceux-ci reçoivent un incrément de version
  et une note de migration explicite.
- **Changements de schéma irréversibles** (suppression d'une colonne / table). Même si le
  projet ne promet pas la compatibilité ascendante avant la v1.0, nous discutons du rayon
  d'impact avant de supprimer des données persistées.
- **Nouvelles dépendances runtime**, surtout les natives. Ouvrez une issue.
- **Suppression d'une surface d'API publique.** Décrivez l'impact d'abord, même si vous
  pensez que personne ne l'utilise.

---

## Comment un modèle entre dans la galerie officielle

AipeHub livre des **modèles** (`aipehub.template/v1` — un YAML autonome qui transporte
une équipe d'agents + des workflows + des *références* de bases de connaissances, mais
jamais de secrets, de contenu de connaissance ou de personnel). La barre pour être *livré
avec le framework* — pour apparaître dans la galerie en un clic de l'interface admin et
sur le site public — est plus haute que la barre pour être *accepté comme modèle
communautaire*.

Il y a deux niveaux, et ce sont des promesses différentes :

### Modèles communautaires — « nous avons vérifié la licence et ça se parse »

Ils vivent sous [`templates/community/`](../../templates/community/). Pour être fusionné,
un modèle communautaire doit :

1. **Se parser.** Il passe le vrai `parseTemplate` (et chaque workflow embarqué passe le
   vrai `parseWorkflow`). Ceci est appliqué par un test de validation automatisé, pas par
   un œil humain — voir
   [`templates/community/templates/README.md`](../../templates/community/templates/README.md).
2. **Porter une provenance honnête.** S'il est dérivé d'un autre modèle ou d'une
   bibliothèque de prompts en amont, il le déclare dans le bloc `provenance`
   (`derivedFrom`, `author`, `notes`). La provenance est la façon dont le crédit de
   citation remonte — ne la supprimez pas.
3. **Ne porter aucun secret.** Toute credential est un placeholder `${ENV}`. Un modèle
   avec une clé littérale est rejeté, point final.
4. **Avoir une licence claire et commercialement compatible** pour tout matériel adapté en
   amont (CC0 / MIT / Apache-2.0 / BSD). Les sources non commerciales ou sans licence ne
   sont pas acceptées. Voir
   [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

C'est tout. Un modèle communautaire qui atteint la barre est fusionné. Nous ne faisons
pas de curation du goût à ce niveau — nous faisons de la curation de la *sécurité et
de l'honnêteté*.

### Modèles phares — « nous nous en portons garants »

Un petit ensemble soigneusement sélectionné (voir [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md))
que le projet recommande activement à un utilisateur non technique. En plus de la barre
communautaire, un modèle phare doit :

1. **Livrer une démo déterministe** qui tourne sans clé API et auto-affirme son propre
   comportement (la convention `examples/*`). Un relecteur peut prouver que ça fonctionne
   en une commande.
2. **Énoncer clairement sa posture de gouvernance** — ce qu'il peut toucher, ce qu'il ne
   peut pas, et où un humain est dans la boucle. Un modèle qui peut verrouiller une porte,
   dépenser de l'argent, ou envoyer les données d'un enfant via un lien de fédération doit
   montrer la porte de confirmation humaine, pas la cacher.
3. **Être maintenu.** Un modèle phare a un mainteneur qui répond aux issues à son sujet.
   S'il se dégrade et que personne ne le corrige, il retombe au niveau communautaire.

La promotion de communautaire → phare est une décision de mainteneur, prise publiquement
sur une issue. La rétrogradation se fait de la même façon.

---

## Quand les gens ne sont pas d'accord

Le désaccord est normal et bienvenu — c'est ainsi qu'une conception est mise à l'épreuve.
Le processus :

1. **Discutez-en sur l'issue / PR.** Énonciez le compromis, pas seulement la conclusion.
   « Je préfère X » est faible ; « X parce que Y, au coût de Z » est utile.
2. **Un mainteneur tranche** si la discussion s'enlise. Les mainteneurs doivent expliquer
   *pourquoi*, dans le compte rendu.
3. **Le garant est l'arbitre final** pour les décisions véritablement contestées, et
   l'autorité finale pour déterminer si un changement franchit la ligne de conception.
   C'est un filet de sécurité, pas une étape de routine — un garant qui doit souvent
   arbitrer des conflits est un garant qui n'a pas réussi à développer le groupe de
   mainteneurs.

Les conflits de conduite sont traités séparément — voir
[`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md).

---

## L'unique non-négociable

AipeHub a exactement un engagement architectural qu'une PR ne peut pas voter pour
supprimer, parce que le changer signifie que le projet n'est plus AipeHub :

> **Le framework ne fait pas tourner le LLM.** Le Hub route les messages, répartit
> les tâches, écrit la transcription, et émet des événements. Chaque décision reste
> avec les participants — agents, humains, services externes. L'état est des fichiers
> sur disque ; les credentials restent locaux ; la fédération est pair-à-pair avec des
> frontières explicites par lien.

Les correctifs qui mettent des appels LLM, des boucles d'agents ou des règles métier
*dans le Hub* seront redirigés — pas parce que l'idée est mauvaise, mais parce qu'elle
appartient à un participant, pas au substrat. Tout le reste — planificateurs, fournisseurs,
adaptateurs, transports, UI, modèles — est ouvert au changement.

---

## Vers un comité des composants

La forme à long terme de ce projet est un **marché de composants gouvernés et
réutilisables** — modèles, adaptateurs, connecteurs de bases de connaissances — auxquels
les gens font suffisamment confiance pour les pointer vers leur maison, leur famille ou
leur argent. La curation de ce marché est plus que ce qu'une personne peut faire, et plus
que ce qu'une personne *devrait* faire.

Lorsque la base de contributeurs sera assez grande pour que la curation de la galerie
soit un vrai travail récurrent, nous mettrons en place un **comité des composants** : un
petit groupe élu de mainteneurs responsable de ce qui est promu au statut de phare, de
la façon dont le crédit de citation est mis en valeur, et de la façon dont les conflits
entre auteurs de modèles sont résolus. Ce document sera amendé à ce moment-là pour
décrire comment les membres du comité sont nommés, élus et renouvelés.

Nous rédigeons ce paragraphe maintenant, alors que le projet est petit, pour que le
comité soit une **étape planifiée avec un mandat écrit** plutôt qu'une prise de pouvoir
ad-hoc plus tard. Le déclencheur est un volume de contribution soutenu, pas une date.

---

## Chapitres régionaux

L'état final est un graphe libre de hubs souverains, pas une plateforme centrale — et
le côté humain de ce graphe est constitué de **chapitres régionaux** : des groupes
locaux, ancrés dans une langue ou une communauté, qui gèrent leurs propres hubs,
sélectionnent des modèles pour leur communauté, et aident les nouveaux venus dans leur
propre langue. La charte ([`CHARTER.md`](../../CHARTER.md) §11) les accueille ; cette
section explique comment l'un d'eux fonctionne en pratique.

Un chapitre est **souverain, pas une franchise.** Il possède sa salle et ne rend de
comptes à aucun propriétaire central. La permission de personne n'est requise pour *en
démarrer un* — ce serait contraire à toute la prémisse « aucune partie unique dont vous
avez besoin de la permission pour continuer à fonctionner » sur laquelle repose le projet.
Vous pouvez lancer un hub, rassembler une communauté locale et sélectionner des modèles
pour elle aujourd'hui, et l'appeler un chapitre AipeHub.

Ce qu'un chapitre **n'est pas** :

- **Pas une voix officielle du projet.** Un chapitre parle pour sa propre communauté,
  pas pour AipeHub. Il ne fixe pas la ligne de conception, ne ratifie pas la charte, et
  ne décide pas de ce qui est promu au statut de phare — tout cela reste avec les
  mainteneurs et le garant dans le dépôt canonique ([`MAINTAINERS.md`](../../MAINTAINERS.md)).
- **Pas un fork qui tient la ligne.** Un chapitre peut faire tourner une version modifiée
  pour sa propre communauté, mais la charte, le protocole et l'ensemble des phares
  faisant autorité vivent dans le dépôt canonique. Un chapitre qui veut que ses
  changements soient *le* AipeHub les envoie en amont comme des pull requests, comme
  n'importe qui d'autre.

### La reconnaissance est optionnelle et légère

Gérer un chapitre ne nécessite aucune bénédiction. Être **répertorié** comme chapitre
reconnu — lié depuis le projet pour que les nouveaux venus puissent vous trouver — est
une petite étape opt-in, et elle fonctionne beaucoup comme la promotion d'un modèle :

1. **Annoncez-le dans Discussions** — qui vous êtes, la région / langue / communauté que
   vous servez, et où vit votre hub.
2. **Un mainteneur vous approuve sur une issue publique.** La barre est l'honnêteté, pas
   la taille : vous représentez le projet fidèlement, vous respectez le
   [`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md), et vous ne revendiquez pas un statut
   officiel que vous n'avez pas.
3. **La reconnaissance peut être retirée** de la même façon qu'elle a été accordée — sur
   une issue publique, avec des raisons — si un chapitre déforme le projet ou franchit la
   ligne de conduite. Le projet ne peut pas (et ne tentera pas de) fermer le hub d'un
   chapitre — c'est sa salle souveraine — mais il peut cesser de le répertorier et lui
   demander de cesser d'implicitement revendiquer une approbation qu'il n'a plus.

Lorsque le **comité des composants** sera en place (voir ci-dessus), la curation de la
liste des chapitres et la résolution des conflits entre chapitres deviendront une partie
naturelle de son mandat ; jusqu'alors c'est une décision légère de mainteneur.

---

## Utiliser le nom AipeHub

Le code est [MIT](../../LICENSE) — vous pouvez l'intégrer, le modifier et le livrer dans
des produits commerciaux ou à source fermée, avec la ligne de licence et de copyright
préservée. **La licence couvre le code ; elle ne cède pas le nom et l'identité du projet.**
Il n'y a pas de marque déposée ici, et nous ne prétendrons pas le contraire — ce qui suit
est une **norme communautaire**, demandée de bonne foi, pas une menace juridique :

- **L'utilisation descriptive est la bienvenue.** « Construit sur AipeHub », « un hub
  AipeHub », « le chapitre AipeHub Malaisie » — dites-le librement. C'est vrai, et nous
  sommes heureux que vous le disiez.
- **Ne laissez pas entendre une approbation que vous n'avez pas.** Ne nommez pas un
  produit, un fork ou un service d'une façon qui le présente *comme* AipeHub-le-projet ou
  comme officiellement approuvé par lui — pas de « AipeHub Officiel », pas d'imposteur
  qui se fait passer pour le téléchargement canonique.
- **Ne rebaptisez pas le projet canonique.** Une distribution modifiée vous appartient
  pour être livrée, mais le « AipeHub » faisant autorité — la charte, la ligne de
  conception, l'ensemble des phares — est celui du dépôt canonique. Si votre fork diverge
  en esprit, donnez-lui votre propre nom ; la licence MIT vous garantit que vous pouvez le
  faire, et un nom honnête sert mieux vos utilisateurs qu'un nom emprunté.

C'est la version la plus légère de protection du nom qui fonctionne : suffisamment pour
que « AipeHub » continue de signifier la chose gouvernée, axée sur les fichiers, humain
dans la boucle que décrit la charte, et rien de plus.

---

## Amender ce document

La gouvernance change de la même façon que le code : ouvrez une issue, envoyez une PR,
obtenez une revue de mainteneur. Les changements à [L'unique non-négociable](#lunique-non-négociable)
nécessitent l'approbation du garant et une déclaration claire de pourquoi la ligne de
conception devrait bouger. Nous nous attendons à ce que cette section ne change jamais.
Le reste est censé grandir.
