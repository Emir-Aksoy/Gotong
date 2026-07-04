# GitHub Discussions — le « salon » communautaire (zéro calcul, activation unique)

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../COMMUNITY-DISCUSSIONS.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Point de contrôle pré-lancement 8. En une ligne : **Issues = le guichet de tickets, Discussions = le salon** — poser des questions, montrer des résultats et proposer des idées se passent ici ; GitHub l'héberge gratuitement, **zéro calcul** tout comme la page de destination / le classement.

---

## 1. Pourquoi Discussions (et pas encore un autre service)

Même posture que [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) : pour un projet file-first dont le hub ne fait pas tourner le LLM lui-même, **l'infrastructure communautaire ne devrait pas non plus avoir besoin d'un serveur**. GitHub Discussions héberge tout le « salon » — fils, catégories, @mentions, Markdown, recherche — tout est du ressort de GitHub, sans une ligne de backend de notre côté.

- **Issues** = le guichet de tickets pour « quelque chose est cassé / manquant » (fermable, assignable, avec état).
- **Discussions** = le salon pour « je veux demander / montrer / discuter » (ouvert, votable, peut marquer une meilleure réponse).

Ces deux entrées sont déjà routées dans [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) — lors de l'ouverture d'une issue, le lien de contact « 💬 Question ou discussion » envoie les gens vers Discussions. **Donc avant que Discussions soit activé, ce lien est une 404** ; une fois activé, il prend vie immédiatement.

---

## 2. ⚠️ La seule action manuelle : activer Discussions (Claude ne peut pas aider)

**Activer Discussions est un bouton dans les paramètres du dépôt, pas un fichier — ni Claude ni la CI ne peuvent l'activer.** Cette étape doit être effectuée par le propriétaire du dépôt dans l'interface web :

1. Ouvrez `https://github.com/Emir-Aksoy/Gotong/settings` (**Paramètres** du dépôt).
2. Faites défiler jusqu'à la section **Features**, cochez **Discussions**.
3. GitHub **créera automatiquement les catégories par défaut** : Announcements / General / **Ideas** / Polls / **Q&A** / **Show and tell**. Les trois modèles de formulaires livrés avec ce dépôt (voir §4) ciblent les trois en gras et s'attachent **au moment** où vous activez, sans besoin de créer des catégories manuellement au préalable.

> Voilà ce que signifie « l'échafaudage est prêt, il ne manque qu'un interrupteur » : les fichiers de modèles, le brouillon du message de bienvenue, le lien de routage d'issues, et les docs sont tous dans le dépôt ; vous cliquez sur Features → Discussions et le salon s'ouvre.

Après activation, deux choses supplémentaires sont recommandées (quelques clics dans l'interface web, optionnelles mais conseillées) :

- **Épingler un message de bienvenue** : postez le brouillon §5 comme Discussion dans la catégorie General et cliquez sur « Pin ».
- **(Optionnel) ajouter une catégorie personnalisée « Templates »** : si le partage de modèles dépasse Show and tell, créez-en une séparée ; mais le Show and tell par défaut suffit au début — ne l'ajoutez pas prématurément.

---

## 3. Carte des catégories (les trois prêtes avec le framework)

| Catégorie | slug | Formulaire | À quoi ça sert |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../../.github/DISCUSSION_TEMPLATE/q-a.yml) | Aide, questions. Peut marquer une « meilleure réponse ». |
| **Ideas** | `ideas` | [`ideas.yml`](../../.github/DISCUSSION_TEMPLATE/ideas.yml) | Proposer des fonctionnalités / directions. Le formulaire encourage l'alignement avec la boussole nord (le hub ne fait pas tourner le LLM / file-first / fédération pair à pair). |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | Montrer votre hub / workflow / modèle. **Guide pratiquement la soumission du modèle dans la galerie** + l'écriture de `derivedFrom` pour que le crédit revienne en amont. |
| Announcements | `announcements` | — | Mainteneurs uniquement (releases, changements majeurs). Pas de formulaire. |
| General | `general` | — | Le message de bienvenue + discussions non catégorisées. Pas de formulaire. |

**Slug = nom de fichier** : GitHub attache le formulaire à `.github/DISCUSSION_TEMPLATE/<slug>.yml` à la catégorie du même nom. Ces trois slugs sont des catégories par défaut que GitHub **crée automatiquement** à l'activation, donc les modèles sont « prêts à l'emploi » sans besoin de créer manuellement les catégories et de faire correspondre les noms d'abord.

---

## 4. Modèles de formulaires (`.github/DISCUSSION_TEMPLATE/`)

Même approche que [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/) — des formulaires structurés qui incitent l'auteur à donner des informations utiles d'emblée. Les trois modèles ont chacun un focus :

- **`q-a.yml`** — guide pour donner « ce que vous essayez de faire » (pas seulement l'erreur) + « ce que vous avez essayé » + la version + le mode d'exécution ; et renvoie **les bugs vers Issues, les problèmes de sécurité vers SECURITY.md** — le salon ne prend pas ces deux-là.
- **`ideas.yml`** — demande « quel est le problème » avant « ce que vous voulez », et demande au proposant de **peser l'adéquation par rapport à la boussole nord à trois couches** lui-même (tout ce qui nécessite que le hub fasse tourner un LLM / cache l'état / centralise les identifiants, dites-le honnêtement — pas un veto, mais cela oriente la discussion).
- **`show-and-tell.yml`** — au-delà de montrer des résultats, **met en avant le guide « peut-on l'intégrer à la galerie en un clic »** : lie au [flux de soumission de modèles communautaires](../../templates/community/templates/README.md), collecte `slug` et `derivedFrom` (alimentant le classement des citations), et transforme les deux règles strictes de la galerie (les identifiants doivent être des `${ENV}`, pas de contenu de connaissance/personnel) en cases à cocher.

> Les champs des formulaires sont en anglais — cohérent avec la convention `.github/ISSUE_TEMPLATE/` existante ; le bloc d'introduction de chaque formulaire ajoute un indice chinois d'une ligne pour accueillir les utilisateurs principalement chinois. Le message de bienvenue (§5) est d'abord en chinois, ensuite en anglais.

---

## 5. Brouillon du message de bienvenue / épinglé (prêt à copier-coller)

Après avoir activé Discussions, **copiez tout le bloc ci-dessous**, postez une nouvelle Discussion dans la catégorie **General** avec le titre `👋 欢迎来到 Gotong 客厅 / Welcome`, et cliquez sur **Pin**. Le brouillon original commence par le chinois (l'audience principale de la communauté) puis l'anglais ; réordonnez selon votre public.

```markdown
## 👋 Welcome to the Gotong living room

This is where the Gotong community hangs out — ask, show, and talk shop. The map:

- **🙋 A question?** Open one in **Q&A**. Say what you're trying to do and what you
  tried; someone will help.
- **🛠 Built something?** Show it in **Show & Tell**. If it's a template others can
  import-and-run, submit it to the one-click gallery via the
  [submit flow](../../tree/main/templates/community/templates).
- **💡 An idea?** Pitch it in **Ideas**. Gotong has a deliberate spine — aiming with
  it lands better: **the hub never runs an LLM · people and agents are the same
  Participant · state is files on disk · federation is peer-to-peer (workflows can
  cross org lines, but credentials/data/billing each stay home)**.
- **🐞 A bug?** That goes to [Issues](../../issues/new/choose), not here.
- **🔐 A security issue?** Please do **not** post it publicly — use the private
  channel in [SECURITY.md](../../blob/main/SECURITY.md).

New here? Start with the [5-minute overview](../../blob/main/docs/OVERVIEW.md) and the
[hands-on hubs](../../blob/main/docs/zh/HANDS-ON-HUBS.md). One house rule: be kind to
people, rigorous about ideas — full text in the
[Code of Conduct](../../blob/main/CODE_OF_CONDUCT.md). Have fun 🎉

---

## 👋 欢迎来到 Gotong 客厅

这里是 Gotong 的客厅——问问题、晒成果、聊想法的地方。先认认门:

- **🙋 有问题?** 去 **Q&A** 开一帖。说清楚你想做什么、试过什么,有人会帮你。
- **🛠 做了东西?** 去 **Show & Tell** 晒出来。如果是一个**别人能照着导入就跑**的
  模板,顺手按 [提交流程](../../tree/main/templates/community/templates) 提进一键画廊。
- **💡 有想法?** 去 **Ideas** 提。Gotong 有一条明确的脊梁,对着它提更容易被采纳:
  **框架不跑大模型 · 人和 agent 是同一种参与者 · 状态都是磁盘文件 · 联邦点对点
  (工作流能跨边界,但凭证/数据/计费各归各家)**。
- **🐞 发现 bug?** 那个去 [Issues](../../issues/new/choose),不在这里。
- **🔐 安全问题?** **千万别**公开发——走 [SECURITY.md](../../blob/main/SECURITY.md)
  里的私密上报通道。

新来的,从这两篇开始:
- [5 分钟总览](../../blob/main/docs/zh/OVERVIEW.md) —— 一页地图看懂所有概念。
- [开箱即用的 hub 案例](../../blob/main/docs/zh/HANDS-ON-HUBS.md) —— 挑一个最像你
  需求的,5 分钟跑起来。

一条公约:对人客气、对事较真。完整版见
[行为准则](../../blob/main/CODE_OF_CONDUCT.md)。玩得开心 🎉
```

> Les liens dans le brouillon ci-dessus utilisent des chemins relatifs au dépôt GitHub (`../../tree/main/…`, `../../blob/main/…`), qui se résolvent correctement vers les fichiers du dépôt une fois collés dans une Discussion. Prévisualisez avant de poster pour confirmer qu'aucun lien n'est cassé.

---

## 6. Comment cela s'articule avec le reste

Cet élément n'est pas isolé — il relie le salon aux lignes que la liste de contrôle pré-lancement a déjà tracées :

- **Routage d'issues** : le lien « 💬 Question ou discussion » dans [`ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) pointe depuis longtemps vers `/discussions` ; une fois activé, ce lien cesse d'être une 404.
- **Galerie de modèles / classement** : le formulaire Show & Tell envoie les auteurs de modèles vers le [flux de soumission de modèles communautaires](../../templates/community/templates/README.md) ; après la fusion d'une soumission, elle apparaît dans la galerie en un clic ([`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)) et la vitrine statique ([`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md)) ; le `derivedFrom` que le formulaire collecte alimente le classement des citations.
- **Gouvernance** : [`GOVERNANCE.md`](../../GOVERNANCE.md) liste Discussions comme l'une des entrées des contributeurs ; les directions qui prennent forme dans Ideas atterrissent via le processus de décision de GOVERNANCE.

L'élément « Enable GitHub Discussions » dans `.github/RELEASE-CHECKLIST.md` pointe maintenant vers ce document.

---

## 7. Limites (honnêtes)

- **Claude ne peut pas activer Discussions** : c'est un bouton dans les paramètres du dépôt (§2), seul le propriétaire peut le cliquer dans l'interface web. Ce que ce dépôt peut faire — « l'échafaudage » : modèles de formulaires, brouillon du message de bienvenue, lien de routage, docs — est tout prêt.
- **Les formulaires ne sont pas une revue** : les modèles de Discussion **guident seulement la publication**, ils ne bloquent pas ni ne valident. La vraie validation pour qu'un modèle entre dans la galerie est [`pnpm check:templates`](../../templates/community/templates/README.md) (passant le vrai `parseTemplate`), ce qui est une question séparée.
- **Pas de migration forcée de l'historique** : les liens éparpillés dans les docs aujourd'hui pointant vers `/discussions` (REAL-WORLD-TESTING, LICENSE-FAQ, etc.) prennent vie naturellement une fois activés, sans besoin de revenir en arrière pour les modifier.

---

## Connexe

- [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) — la vitrine statique zéro calcul (l'autre moitié de la même posture).
- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — la galerie d'installation en un clic dans la console admin.
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — l'index organisé des modèles phares + classement des citations.
- `../../CONTRIBUTING.md` · `../../GOVERNANCE.md` · `../../CODE_OF_CONDUCT.md` — les fichiers racines de la communauté.
- [`templates/community/templates/README.md`](../../templates/community/templates/README.md) — le flux de soumission de modèles en 5 étapes.
