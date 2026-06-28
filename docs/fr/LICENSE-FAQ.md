# FAQ Licence

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../LICENSE-FAQ.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> **AipeHub dans son ensemble est sous licence [MIT](../../LICENSE).**
> Cette page répond aux questions courantes « puis-je / dois-je / à quoi
> faire attention » sous forme de FAQ. Ce n'est pas un conseil juridique —
> pour un vrai travail de conformité en entreprise, consultez votre propre
> conseil.
>
> 中文版见 [`docs/zh/LICENSE-FAQ.md`](../zh/LICENSE-FAQ.md)。

---

## 1. Puis-je intégrer AipeHub dans mon produit à source fermée / SaaS / outil interne ?

**Oui.** MIT est parmi les licences OSS les plus permissives. Elle autorise :

- ✅ L'usage commercial, y compris le repackaging intégral d'AipeHub et sa vente
- ✅ La modification du source, le renommage (si vous renommez, veuillez mentionner « basé sur AipeHub »)
- ✅ Les dérivés à source fermée — vos modifications **n'ont pas** à être open-sourcées
- ✅ L'inclusion de `@aipehub/core` dans un SaaS à source fermée comme dépendance npm

**La seule exigence impérative** : conserver le fichier LICENSE + la notice de copyright
(lister AipeHub sur la page NOTICE / Third-Party-Licenses de votre produit suffit).

---

## 2. J'ai modifié le source — dois-je contribuer les changements en retour ?

**Non.** MIT n'est pas du copyleft. Vous pouvez :

- Conserver vos modifications en privé
- Les livrer dans le cadre d'un produit commercial
- Ne jamais envoyer de PR en amont — c'est tout à fait acceptable

Cela dit, nous accueillons les PRs — mieux le projet évolue, moins cher est votre
prochain upgrade. Voir [`CONTRIBUTING.md`](../../CONTRIBUTING.md) pour le processus.

---

## 3. À quoi faire attention lorsque j'utilise les modèles de prompts tiers de `templates/community/` à des fins commerciales ?

`templates/community/` rassemble deux sources en amont :

| Source | Licence | Usage commercial | Note |
|---|---|---|---|
| [`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) | **CC0 1.0** (domaine public) | ✅ tout usage | L'attribution n'est légalement **pas requise** ; nous conservons la ligne source par respect |
| [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) | **MIT** | ✅ tout usage | Vous **devez conserver** la notice de copyright + licence |

Comment la notice est-elle conservée ? `templates/community/` la porte déjà à
trois niveaux :

1. Un **commentaire d'en-tête de 4 lignes** dans chaque fichier yaml : `# Source` /
   `# Upstream` / `# License` / `# Adapted`
2. Le fichier agrégat
   [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md)
   conserve le texte MIT complet + un résumé CC0 + les URLs des dépôts en amont
3. Le [`README.md`](../../templates/community/README.md) du répertoire explique les
   règles d'adaptation et la matrice de licences

Tant que vous redistribuez `templates/community/` **avec ces trois niveaux intacts**
(fork git / URL cloud raw / CDN interne — tout convient), vous êtes pleinement en
conformité.

> « J'ai collé le contenu d'un modèle dans l'interface admin et il s'est retrouvé
> dans mon `secrets.enc.json` / `agents.json` — est-ce une distribution ? » —
> **Non.** Vous l'utilisez simplement au sein de votre propre déploiement, sans le
> transmettre à des tiers. Aucune action d'attribution n'est nécessaire.

---

## 4. Puis-je modifier la LICENSE et republier ceci comme « notre » produit ?

Vous pouvez **changer le nom du produit et ajouter votre propre ligne de licence**,
mais vous **ne pouvez pas supprimer le texte MIT d'origine** :

- ✅ Votre dérivé peut s'appeler `BobHub`, et être sous Apache-2.0 /
  propriétaire / quelque chose que vous avez écrit vous-même
- ✅ Vous pouvez mettre votre propre copyright dans votre propre fichier LICENSE
- ⚠️ Mais vous **devez conserver, quelque part** (p.ex. NOTICE.md ou
  THIRD-PARTY.md), le texte MIT original d'AipeHub + la ligne de copyright en amont
- ❌ Vous **ne pouvez pas** prétendre « AipeHub est notre œuvre originale » — c'est
  une fraude, quelle que soit la licence

---

## 5. J'ai importé un prompt privé qu'un collègue a écrit avec GPT comme agent — y a-t-il un risque de licence ?

**Aucun du côté d'AipeHub.** Les prompts que vous ou votre entreprise écrivez sont
les propres actifs de votre entreprise ; AipeHub n'est que le conteneur d'exécution.
Vous devriez cependant vérifier :

- Si la production GPT de votre collègue est conforme aux conditions d'utilisation
  d'OpenAI (la politique d'OpenAI sur la « propriété » des sorties du modèle a varié
  dans le temps — demandez à votre service juridique)
- Si le prompt **cite** les extraits de code / articles de quelqu'un d'autre, si la
  licence de cette citation propre le permet

Aucun de ces points n'est régi par le projet AipeHub — MIT licence le logiciel
lui-même, pas le contenu que vous générez avec.

---

## 6. Je déploie AipeHub dans l'intranet d'un client — quels fichiers de licence dois-je lui remettre ?

Au minimum :

- Le fichier `LICENSE` à la racine du dépôt AipeHub
- Si vous utilisez `templates/community/` : apportez également `LICENSE-NOTICES.md`
- Si vous intégrez le package npm `@aipehub/core` : le package livre sa propre licence
  à l'installation ; la redistribution en aval doit juste conserver
  `node_modules/@aipehub/*/LICENSE` non supprimé

Un schéma courant est une page « Licences tierces » dans votre produit listant chaque
texte de licence OSS en amont. Ajoutez-y le MIT d'AipeHub et vous êtes prêt.

---

## 7. Les dépendances d'exécution d'AipeHub contiennent-elles du copyleft GPL/AGPL ?

Actuellement non. Les principales dépendances :

| Dépendance | Licence |
|---|---|
| `ws` (WebSocket) | MIT |
| `yaml` | ISC |
| `better-sqlite3` (optionnel) | MIT |
| `@anthropic-ai/sdk` (peer dep optionnel) | MIT |
| `openai` (peer dep optionnel) | Apache-2.0 |
| `vitest` (dev only) | MIT |
| `tsx` (dev only) | MIT |

Toutes permissives. Si une dépendance GPL/AGPL était jamais proposée nous ouvririons
d'abord une issue ; notre parti pris est d'**éviter** les dépendances copyleft pour
préserver la flexibilité en aval.

---

## 8. Le protocole wire d'AipeHub fait-il partie de la licence ?

Non. Le format de trame JSON décrit dans `docs/PROTOCOL.md` est une **spécification
de facto** — n'importe qui peut implémenter son propre serveur de hub ou SDK **sans
aucune autorisation**. Nous encourageons les portages vers d'autres écosystèmes de
langages (Go / Rust / SDKs navigateur etc.) ; chacun choisit sa propre licence.

---

## 9. Comment signaler une vulnérabilité ?

Via **GitHub Security Advisory** (soumission privée) sur le dépôt du projet —
c'est le seul canal de sécurité ; il n'y a délibérément pas d'email de sécurité
(voir [`SECURITY.md`](../../SECURITY.md)). Publier des détails de vulnérabilité dans
une issue publique n'est **pas acceptable** — même si la licence le permettrait.

---

## 10. Mon entreprise peut-elle forker AipeHub en interne sans open-sourcer le fork ?

**Absolument.** MIT ne se propage pas. Vous pouvez :

- Forker dans votre Git privé → modifier librement → déployer sur l'intranet
- Renommer le fork et le déployer en privé pour les clients
- Vendre les artefacts de build du fork comme binaire à source fermée

Tant que **le livrable final conserve quelque part la licence MIT originale d'AipeHub**
(typiquement une page « notices open source »), vous êtes prêt.

---

## En résumé

> **« Utilisez-le simplement. »** — 99 % des usages ordinaires n'ont besoin d'aucune
> action supplémentaire au-delà de la conservation du fichier LICENSE + la ligne de
> copyright. `templates/community/` ajoute une étape : conserver `LICENSE-NOTICES.md`.
> Tout le reste ne se déclenche que si vous faites une des actions spéciales
> ci-dessus.

> Encore incertain ? Ouvrez une GitHub Discussion et nous ferons de notre mieux ;
> pour de vraies décisions de conformité, demandez au conseil de votre entreprise.
