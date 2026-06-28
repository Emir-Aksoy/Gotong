# AipeHub — Charte du projet

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../../CHARTER.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

**Version 0.1** · adoptée le 2026-06-27 · ratifiée par le gardien fondateur
([`MAINTAINERS.md`](../../MAINTAINERS.md))

> Il s'agit de la constitution du projet : le document qui évolue le plus lentement dans le
> dépôt, celui auquel chaque autre doc, décision de conception et ligne de code doit
> répondre. Le README est une porte d'entrée et [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md)
> est une carte ; c'est l'ancre. Lorsque le code et cette charte divergent, soit le
> code est erroné, soit la charte nécessite un amendement — et §10 explique comment en faire un.
>
> L'anglais est la version canonique ; une traduction chinoise synchronisée se trouve à
> [`docs/zh/CHARTER.md`](../../docs/zh/CHARTER.md). En cas de divergence d'une traduction, l'anglais
> fait foi.

---

## 1. Ce qu'est AipeHub

**AipeHub est le substrat auto-hébergé pour les liens de l'ère de l'IA entre les personnes,
les agents et les organisations.** AI + Person + Hub.

Ce n'est pas un agent, et ce n'est pas un autre framework d'agents. C'est la couche
*en dessous* d'eux — un registre, un bus de messages, un routeur de tâches, un lien
de fédération gouverné, et une transcription en ajout seul. Un graphe LangGraph, un
équipe CrewAI, un agent de codage CLI (Claude Code, Codex), un agent A2A externe, et une
personne se connectent tous à la même salle via une seule abstraction : le `Participant`.
Le Hub maintient les signaux qui circulent et les frontières appliquées. Il n'exécute jamais
le modèle lui-même, donc chaque décision reste avec les participants.

Le modèle mental est assez petit pour tenir dans une main :

- **Un Hub qui est simple par conception.** Il route les messages, dispatch les tâches,
  persiste la transcription, émet des événements et applique les portails de gouvernance.
  Il ne possède pas les boucles d'agents et ne prend pas de décisions.
- **Un seul type de participant.** Une personne est un `Participant` exactement comme un agent
  l'est. Il n'y a pas d'"outil de demande d'entrée humaine" ; les personnes et les agents partagent la même
  tâche, la même transcription et les mêmes primitives d'exécution longue durée.
- **L'état n'est que des fichiers.** Un espace de travail est un répertoire sur le disque
  (`.aipehub/`). Supprimez-le et la salle est partie ; copiez-le et vous avez transmis
  toute la salle à quelqu'un ; redémarrez et rien n'est perdu.

Cette combinaison — pas un protocole intelligent quelconque — est ce qu'AipeHub *est*.

---

## 2. L'Étoile du Nord — trois non-négociables

Trois phrases définissent le projet. Ce ne sont pas des fonctionnalités ; ce sont
l'identité. Changer l'une d'entre elles ne produit pas un meilleur AipeHub — cela
produit quelque chose qui n'est plus AipeHub.

1. **Le framework n'exécute pas le LLM.** Le Hub route, dispatche, enregistre
   et contrôle. L'inférence et la prise de décision résident dans les participants. C'est
   pourquoi le système peut être simple, auditable et fiable en même temps.
2. **Une personne et un agent sont le même `Participant`.** L'humain dans la boucle n'est
   pas ajouté après coup ; un humain est un participant de première classe qui peut se voir dispatcher
   une tâche, la suspendre et la reprendre — la même machinerie qu'utilise un agent.
3. **L'état est des fichiers sur le disque.** La souveraineté n'est pas un paramètre. Votre salle, vos
   identifiants, votre transcription et votre historique sont un répertoire que vous possédez et
   pouvez copier. Les redémarrages sont transparents parce qu'il n'y a rien d'autre à restaurer.

Ces trois éléments sont les plus difficiles à changer dans le projet (§10). Tout
le reste est négociable à leur service.

---

## 3. Pourquoi il existe — les trois couches

AipeHub construit le substrat de travail pour trois couches de liens, dans l'ordre où
un utilisateur les atteint :

**Couche 1 — une personne et sa propre IA.** "Mon bureau IA." Le hub d'une personne,
des workflows privés, des identifiants qui ne quittent jamais la machine. L'objectif est cinq
minutes pour avoir quelque chose qui fonctionne, sans code, l'IA faisant un vrai travail pour vous.

**Couche 2 — les personnes et les agents à travers les frontières.** Collaboration inter-organisations :
plusieurs utilisateurs, rôles, invitations, fédération pair-à-pair. Un
workflow peut traverser une ligne organisationnelle, mais les identifiants, les données et la
facturation restent chacun à la maison. Ce qui traverse la frontière est contraint par un contrat de confiance
explicite par lien, et les passages conséquents attendent un humain.

**Couche 3 — le framework lui-même.** Clair, stable et adaptable. Le Hub reste
simple par conception ; le `Participant` reste la seule abstraction ; les protocoles, les identifiants
et les quotas ont tous des bords explicites et visibles. Le propre travail du framework est de suivre
la rapidité avec laquelle l'IA évolue sans trahir les couches 1 et 2.

L'IA, les agents et les frameworks multi-agents qui arrivent maintenant vont s'intégrer dans la vie quotidienne
à une vitesse remarquable. Les plus grands fournisseurs de modèles, les plateformes de communication et
d'autres acteurs existants bougent tout aussi vite pour occuper ce terrain comme un monopole — une
position dont toute la valeur est le levier pour extraire de quiconque vient à en dépendre. AipeHub existe pour
garder une alternative sur la table : pour émousser ce levier en intégrant l'IA, les agents et les workflows
dans une seule pile et en la publiant en open-source, afin que n'importe qui puisse l'obtenir, la déployer et
la faire fonctionner lui-même — pas de portier, pas de loyer, pas de permission à demander.

Il existe pour la personne qui veut que l'IA *fasse quelque chose qui compte* — gérer la
maison, aider la famille, s'occuper de l'argent, coordonner l'équipe — et qui n'est pas
prête à remettre à un cloud qu'elle ne contrôle pas les clés pour le faire.

---

## 4. Le coin de confiance — pourquoi vous pouvez lui confier les choses importantes

La plupart des outils IA offrent deux options : tout donner à un cloud que vous ne contrôlez pas,
ou tout connecter vous-même. AipeHub est la troisième option — une IA que vous pouvez pointer
vers votre maison, votre famille ou votre argent, parce que les frontières sont réelles et
elles vous appartiennent. Trois propriétés le rendent vrai, et elles sont le fossé du projet :

- **Gouverné.** Les actions réversibles se produisent simplement ; les irréversibles — verrouiller la
  porte, dépenser de l'argent, envoyer les données d'un enfant via un lien — attendent qu'une personne
  confirme dans une boîte de réception, et le workflow ne peut pas contourner le portail. Les actions dangereuses et
  inter-frontières sont fail-closed par construction.
- **Local.** Les identifiants vivent chiffrés dans votre propre répertoire `.aipehub/`.
  La fédération avec un autre hub partage une *capacité*, jamais votre coffre-fort. Chaque hub
  garde son propre magasin d'identifiants et son propre registre d'utilisation/coûts.
- **Dans l'ouvert.** Chaque dispatch et chaque résultat est une transcription en ajout seul
  que vous pouvez lire. Parce que le framework n'exécute jamais le modèle, il n'y a pas de jugement caché
  à prendre sur la foi.

Et l'autorité vous appartient, pas à nous. AipeHub fournit le mécanisme — le portail,
le coffre-fort, la transcription — mais la politique est définie et détenue par celui qui gère le hub,
pas par ce projet. Quelles actions comptent comme conséquentes, ce qu'une liste blanche autorise,
qui répond à la boîte de réception : l'opérateur décide, et l'opérateur détient la décision. Dans
le hub d'apprentissage familial, c'est le parent — pas AipeHub — qui définit le portail et
confirme à celui-ci. Nous ne gardons pas un siège de fournisseur à vos décisions ; le framework vous
remet les commandes et s'écarte.

C'est le coin : pas "plus capable que les autres", mais *digne de confiance avec
les choses que vous ne remettriez jamais à une boîte noire.*

---

## 5. Vision — où cela va

L'état final est un **graphe libre, pas un arbre.** Pas une plateforme centrale dans laquelle
les locataires louent de l'espace, mais de nombreux hubs souverains qui s'interconnectent pair-à-pair —
chacun appartenant à la personne ou à l'organisation qui le gère, aucun d'eux ne possédant la
confiance des autres. Un plan de contrôle peut *observer* (avec des résumés optionnels, préservant la vie privée,
uniquement les comptages), mais il ne *prend jamais le contrôle*. Un graphe comme celui-ci ne peut pas être
accaparé : il n'y a pas de centre à capturer, pas de propriétaire pour percevoir un loyer, et pas de partie unique
dont vous avez besoin de la permission pour continuer à fonctionner.

Les participants sur ce graphe ne sont pas seulement des personnes et des agents logiciels. L'intelligence
incarnée — robots, capteurs, les machines qui agissent dans le monde physique — arrive
sur le même calendrier, et AipeHub est construit pour l'accueillir : partout où un tel système
parle **MCP**, il rejoint en tant qu'un autre `Participant` derrière la même frontière gouvernée —
les tâches dispatchées, soumises aux mêmes portails, écrites dans la même
transcription que tout le reste. Le framework est naturellement adapté pour gérer les personnes,
les agents et les systèmes incarnés sous un même toit, parce qu'il les traite déjà comme un
seul type de chose.

Au-dessus de ce graphe se développe un **marché gouverné de composants réutilisables** —
des modèles, des adaptateurs, des connecteurs de base de connaissances — construits de sorte que vous puissiez remettre
toute une architecture fonctionnelle à quelqu'un dans un seul fichier, et ils peuvent lui faire confiance
parce que la posture de gouvernance voyage avec lui et le contenu de connaissances ne le fait
pas. La provenance est honnête : un modèle porte la structure et les références, jamais
les données ou les personnes d'une autre organisation.

La monnaie de cet écosystème est la **reconnaissance, pas le loyer** (§7). Ce qui
fait que les contributeurs continuent de contribuer est une attribution honnête et un chemin vers
l'autorité — pas un paiement. Le graphe libre reste décentralisé précisément parce que
aucune partie centrale n'est nécessaire pour régler un registre.

---

## 6. Comment l'utiliser

AipeHub rencontre les personnes à la surface qui leur convient, et le même Hub se trouve derrière
toutes :

- **Mode personnel** — cinq minutes, sans code. Importez un modèle phare ou construisez
  un agent à partir d'un formulaire ; l'hôte le génère pour vous. Les identifiants restent sur votre disque.
- **Mode équipe** — une salle, plusieurs rôles (admin / travailleur / agent), invitations,
  RBAC au niveau des ressources, self-service des membres sur `/me`.
- **Fédération** — chaque organisation gère son propre hub ; un `HubLink` en connecte deux
  sous un contrat de confiance par lien (liste blanche de capacités · portail de classe de données
  · quota · révocation · liste blanche de base de connaissances). Les workflows peuvent traverser
  le lien ; la souveraineté reste intacte des deux côtés.

Les surfaces sont plurielles par conception : une interface administrateur de navigateur, le bureau membre `/me`,
des ponts IM (Telegram, Lark, Slack et QQ aujourd'hui ; Discord et Matrix prévus), un
CLI/REPL interactif,
MCP pour les outils et les clients externes, et une PWA installable. AipeHub parle les
protocoles ouverts de l'écosystème là où ils existent — **MCP** (outils et données, les deux
directions), **A2A** (agent-à-agent, les deux directions), **ACP** (piloter une session
d'agent de codage maintenue) — et possède exactement l'un des siens : **HubLink**, le
lien de fédération gouverné entre deux hubs.

Et les modèles portent des hubs entiers : un fichier contient N agents, N workflows, des créneaux de
base de connaissances adressables, et une configuration de clé en une seule invite — structure et câblage, jamais
la connaissance elle-même et jamais vos personnes ou vos secrets.

→ Commencez par [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) · exécutez un hub prêt à l'emploi via
[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md) · connectez un agent via
[`docs/AGENT.md`](../../docs/AGENT.md).

---

## 7. Comment nous décidons — gouvernance et reconnaissance

Les décisions sont prises ouvertement, par des personnes qui ont acquis une sensibilité à la ligne de conception.
L'échelle d'autorité, la règle de conception qu'un mainteneur doit intérioriser
("le framework n'exécute pas le LLM"), et le chemin du contributeur au
mainteneur au gardien vivent dans [`GOVERNANCE.md`](../../GOVERNANCE.md) ; le
registre actuel est [`MAINTAINERS.md`](../../MAINTAINERS.md).

La contribution est récompensée par la **reconnaissance uniquement** — provenance honnête, attribution visible,
et un chemin documenté vers une voix réelle dans le projet. Il n'y a pas
d'argent, pas de jeton, et pas de couche de primes, parce qu'une couche économique brouille
le modèle de confiance décentralisé et priorité aux fichiers sur lequel repose tout le projet. Les quatre
piliers de ce système — le classement des citations, l'échelle des mainteneurs,
le partage sans friction, et les exemples partagés — sont consolidés dans
[`docs/RECOGNITION-SYSTEM.md`](../../docs/RECOGNITION-SYSTEM.md).

Comment contribuer, et le seuil qu'un modèle communautaire doit franchir (licence claire,
analyse, zéro secrets en clair, provenance déclarée), se trouvent dans
[`CONTRIBUTING.md`](../../CONTRIBUTING.md). La conduite est dans
[`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md). Les rapports de sécurité passent par
[`SECURITY.md`](../../SECURITY.md).

---

## 8. Non-objectifs — ce qu'il refuse de devenir

Une charte ancre autant par ce qu'elle exclut que par ce qu'elle promet. AipeHub n'est
délibérément **pas** :

- **Un hôte de modèle.** Il ne fera pas croître une boucle d'inférence LLM dans le Hub. Apportez
  votre propre modèle derrière l'interface neutre `LlmProvider`.
- **Un SaaS central qui possède votre confiance.** Il ne deviendra pas une plateforme qui
  détient vos clés, vos données ou votre facturation comme prix de son utilisation. Le
  plan de contrôle observe ; il ne prend pas la garde.
- **Un arbre d'organisation hiérarchique.** La fédération est un graphe libre de pairs souverains,
  pas des locataires nichés à l'intérieur d'un propriétaire. Aucun hub n'est structurellement au-dessus d'un autre.
- **Une économie de monnaie / jeton / prime.** La couche d'incitation est la reconnaissance (§7) ;
  introduire une monnaie centraliserait la confiance même que le projet décentralise.
- **Une boucle autonome qui agit dans l'obscurité.** Il ne permettra pas à un agent de prendre
  une action irréversible ou inter-frontières sans un portail humain. "Proactif" ne signifie jamais
  "non supervisé sur les choses qui comptent."

Lorsqu'une fonctionnalité proposée nécessite de briser l'une d'entre elles, c'est une conversation au niveau
de la charte (§10), pas une pull request.

---

## 9. Comment c'est ouvert

Le framework est **sous licence MIT** partout — intégrable dans des produits fermés et
SaaS, modifiable, redistribuable, avec le fichier de licence et la ligne de copyright
préservés ([`LICENSE`](../../LICENSE), [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md)).
Les modèles communautaires portent leur propre provenance CC0/MIT, tous compatibles avec l'usage commercial.

Les formats qu'AipeHub a inventés sont ouverts en tant que spécifications, pas seulement comme code en cours d'exécution.
Le langage de définition de workflow et d'agent (`aipehub.workflow/v1` et les manifests d'agent,
d'équipe et de modèle) et **HubLink** — le protocole de fédération entre deux
hubs — sont notre propre conception, et ils appartiennent à tout le monde : n'importe qui peut les lire,
les implémenter, construire un runtime concurrent sur eux, et les distribuer dans des logiciels commerciaux,
sans frais et sans permission demandée. Un format est un langage partagé, pas
une propriété ; ce sont simplement les spécifications du projet, et nous ne faisons aucune revendication sur eux
au-delà d'avoir été ceux qui les ont écrits. Leurs formes sont exposées dans
**l'Annexe A** (HubLink) et **l'Annexe B** (les formats de définition).

L'ouverture ici n'est pas seulement une licence ; c'est l'architecture. Votre espace de travail est un
répertoire que vous pouvez lire, copier, sauvegarder et emporter. Il n'y a pas de verrouillage à
échapper parce qu'il n'y avait jamais de garde au départ.

---

## 10. Amender cette charte

C'est un document vivant, mais il n'est pas édité à la légère. Plus un changement
atteint profondément, plus la barre est haute :

- **L'Étoile du Nord (§2)** n'est amendable que par consensus explicite et délibéré des
  mainteneurs et du gardien, ouvertement, avec le raisonnement enregistré. Elle
  devrait presque ne jamais changer. Si c'est le cas, le projet est devenu un projet différent,
  et cela devrait être dit à haute voix.
- **Tout le reste** évolue comme le reste du dépôt le fait : une pull request
  qui argumente le *pourquoi*, revue par rapport à l'Étoile du Nord, fusionnée par lazy
  consensus selon [`GOVERNANCE.md`](../../GOVERNANCE.md).

Chaque amendement accepté incrémente la version enregistrée en haut de ce document
(qui est distincte de la version du logiciel) : un incrément mineur pour un changement ordinaire,
et un incrément majeur réservé à un changement de l'Étoile du Nord — le seul changement
qui signifie que le projet est devenu autre chose. La version est la façon dont un lecteur
sait quelle constitution il tient.

Si vous n'êtes pas sûr que quelque chose que vous voulez construire s'inscrit dans le cadre, cette charte est le
document avec lequel argumenter. C'est à ça qu'elle sert.

---

## 11. Domicile, et une invitation ouverte

Le domicile canonique de ce projet est son dépôt GitHub,
**[github.com/Emir-Aksoy/AipeHub](https://github.com/Emir-Aksoy/AipeHub)** — l'
original, et l'enregistrement de vérité. Les forks sont les bienvenus et encouragés, mais c'est
là que la ligne de conception est maintenue et où la charte, le protocole et les modèles phares
sont faisant autorité.

Ramenez vos workflows. Un workflow que vous avez construit pour votre maison, votre boutique ou votre
équipe — aussi petit, aussi brut soit-il — vaut la peine d'être partagé : le hack d'après-midi d'une personne
est le départ en cinq minutes d'une autre. Ouvrez une pull request, déposez-le comme modèle communautaire,
ou montrez-le simplement dans les Discussions. La barre est la sécurité et l'honnêteté, pas
le polissage ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).

**Tout le monde est le bienvenu pour rejoindre** — pour utiliser, contribuer, maintenir et gagner une
vraie voix sur la direction que cela prend ([`GOVERNANCE.md`](../../GOVERNANCE.md)). Et parce que l'état
final est un graphe libre de hubs souverains plutôt qu'une plateforme centrale, **nous
accueillons les chapitres régionaux** : des groupes locaux, ancrés dans une langue ou une communauté, qui gèrent
leurs propres hubs, organisent des modèles pour leurs communautés et aident les nouveaux venus dans leur propre
langue. Un chapitre possède sa propre salle et ne répond à aucun propriétaire central ; il se lie au
graphe plus large en tant que pair, exactement comme l'architecture le prévoit.

---

## Annexe A — HubLink, le protocole de fédération

*Ces annexes résument la forme actuelle de chaque format pour l'orientation. Les
spécifications faisant autorité et versionnées vivent dans les sources référencées et évoluent
plus vite que cette charte ; là où elles diffèrent, la spec référencée régit le wire
et la charte régit le principe (§9).*

**HubLink** est le lien gouverné entre deux hubs : un canal WebSocket symétrique, pair-à-pair
où l'un ou l'autre côté peut dispatcher une tâche à l'autre, publier un
message ou fermer le lien. Ce sont des frames JSON sur `ws://` / `wss://`, versionnées par
`MESH_PROTOCOL_VERSION`, et délibérément séparées du protocole wire agent↔Hub
([`docs/PROTOCOL.md`](../../docs/PROTOCOL.md)) — un lien pair n'a besoin d'aucun contrôle d'admission
ni registre d'agents de ce protocole.

Les frames, chacune étant un objet JSON autonome avec un discriminateur `type` :

| Frame | Direction | Signification |
|---|---|---|
| `MESH_HELLO` / `MESH_HELLO_ACK` | handshake | authentification mutuelle des pairs (identifiant par lien, fail-closed) |
| `MESH_TASK` / `MESH_RESULT` | dans les deux sens | dispatcher une tâche / retourner son résultat (apparié par id de tâche) |
| `MESH_MESSAGE` | dans les deux sens | message fire-and-forget |
| `MESH_PING` / `MESH_PONG` | dans les deux sens | keepalive |
| `MESH_GOODBYE` | dans les deux sens | fermeture coopérative |

Ce qui traverse le lien est délimité par un **contrat de confiance** par lien — liste blanche de capacités,
portail de classe de données, quota, révocation, liste blanche de base de connaissances — de sorte qu'un
workflow peut traverser une ligne organisationnelle tandis que les identifiants, les données et la
facturation restent à la maison des deux côtés.

HubLink est la propre conception d'AipeHub, offerte comme une spécification ouverte qui appartient à
tout le monde : implémentez-la dans n'importe quel langage ou produit, commercial ou non, sans frais et
sans permission nécessaire. L'implémentation de référence vit dans
`packages/transport-ws/`.

---

## Annexe B — les formats de définition de workflow et d'agent

Ces formats YAML sont la façon dont la structure d'un hub est écrite, gouvernée et partagée.
Tous sont la propre conception d'AipeHub, et tous sont offerts dans les mêmes conditions que HubLink : une
spécification ouverte qui appartient à tout le monde — implémentez-les n'importe où, commercial ou
non, sans frais et sans permission demandée.

- **`aipehub.workflow/v1`** — un workflow déclaratif : un `trigger`, une liste de `steps`
  qui dispatchent chacun à une *capacité* (pas un agent nommé), un graphe de dispatch câblé par
  `$ref`, et le sucre de flux de contrôle `when:` (conditionnel), `parallel:` (éventail),
  et `human:` (une étape humain dans la boucle). Un `surface.me` optionnel l'expose sur le
  bureau membre et `governance` déclare sa posture de risque. Le YAML est la
  racine gouvernée et versionnée d'un workflow — chaque exécution est épinglée à une révision immuable
  afin qu'elle ne dérive jamais.
- **`aipehub.agent/v1`** et **`aipehub.team/v1`** — un manifest d'agent, un agent ou
  une équipe entière dans un fichier : fournisseur, modèle, invite système, capacités, serveurs MCP,
  une liste blanche de dispatch de sous-agents, et un heartbeat optionnel.
- **`aipehub.template/v1`** — un modèle contient N agents, N workflows, des *créneaux* de base de
  connaissances adressables, et une configuration de clé en une seule invite dans un seul fichier partageable. Il
  porte uniquement la structure et les références — jamais le contenu de connaissances, vos personnes,
  ou vos secrets.

Implémentations de référence : `packages/workflow/` (le runner de workflow et le schéma) et
`packages/web/src/manifest.ts` / `template-manifest.ts` (les manifests d'agent, d'équipe et
de modèle).
