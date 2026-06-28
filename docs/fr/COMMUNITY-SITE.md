# Page de destination communautaire + Galerie de modèles + Classement des citations (site statique zéro calcul)

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../COMMUNITY-SITE.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Point de contrôle pré-lancement 7. En une ligne : **la communauté a besoin de zéro calcul** — construisez-la comme un ensemble de fichiers statiques, déposez-la sur n'importe quel hébergeur statique gratuit, et elle est en ligne ; la machine cloud reste en réserve.

---

## 1. Pourquoi « zéro calcul »

La posture de conception globale d'AipeHub est **le hub ne fait pas tourner le LLM lui-même / l'état est entièrement sur disque / les identifiants restent sur votre machine / la fédération est pair à pair**. Suivez cette posture jusqu'au bout et **l'infrastructure communautaire n'a pas non plus besoin d'un serveur** :

- **GitHub héberge déjà la substance** — un modèle est un fichier, une soumission est une PR.
- **La seule chose manquante est une vitrine** — et la vitrine d'un projet file-first est elle-même un ensemble de fichiers statiques.

Cette vitrine = un générateur + les fichiers statiques qu'il produit. Le générateur est [`packages/web/scripts/build-site.mjs`](../../packages/web/scripts/build-site.mjs), produisant `site/` (racine du dépôt, ignoré par git) :

- `index.html` — un fichier unique autonome (sans framework, sans runtime, CSS intégré) : le héros narratif de confiance + une grille de cartes de la galerie de modèles + le tableau du classement des citations.
- `templates.json` — un flux `aipehub.site/v1` lisible par machine (la vitrine est aussi de la donnée, file-first).

Déposez `site/` sur n'importe quel niveau gratuit de GitHub Pages / Cloudflare Pages / Netlify et la vitrine est en ligne à **0 €**. La machine Tencent Cloud 2c2G reste inactive en réserve.

---

## 2. Comment construire

```bash
pnpm build:site          # script racine, délègue à packages/web
# ou
pnpm -C packages/web build:site
```

Sortie :

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/` est un artefact dérivé qui est **construit à la demande et non versionné** (même posture que `dist-portable/`, voir `.gitignore`). La source de vérité unique reste dans `examples/` et `templates/community/` (séparation modèle/framework) ; la vitrine est leur projection en lecture seule — modifiez un modèle et relancez le générateur.

**Déterminisme** : le générateur n'écrit aucun horodatage et trie de façon stable → les mêmes entrées produisent un `site/` **identique octet pour octet**, de sorte que les reconstructions ne génèrent pas de diffs sans signification.

---

## 3. Corpus = le même ensemble qui est validé

Le générateur analyse **exactement** les deux mêmes racines que la porte de validation au niveau du dépôt (`pnpm check:templates` / [`tests/all-templates-parse.test.ts`](../../packages/web/tests/all-templates-parse.test.ts)) :

| origine | chemin | note |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | modèles phares livrés avec le framework |
| `community` | `templates/community/templates/**/*.ya?ml` | là où atterrissent les soumissions de la communauté |

Ainsi « chaque modèle qui passe la CI apparaît dans la vitrine » tient **par construction** — un manifest qui ne se parse pas ne peut jamais atteindre une carte (il échoue à `check:templates` et n'entre jamais).

---

## 4. Classement des citations = degré entrant de `provenance.derivedFrom`

Le classement lit le champ de provenance additif `template.provenance.derivedFrom` (point de contrôle pré-lancement 6) :

- Une entrée `derivedFrom` est une **arête de citation** : elle déclare « ce modèle est adapté de qui. »
- Le classement = **degré entrant** = « combien de modèles dérivent de moi. »
- Une arête référence le **slug** du modèle cible (sa poignée publique, voir ci-dessous), donc quand vous forkez un modèle, écrire le **slug de l'amont** dans votre `provenance.derivedFrom` complète la lignée d'attribution.

Les deux vrais arêtes de citation livrées avec le framework (aussi écrites dans `CLAUDE.md`) :

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # sister example, same dispatch skeleton

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # MIRROR, the reverse-direction cross-org orchestration
```

→ Sur le classement `personal-coding-hub` et `tea-supply-link` obtiennent chacun 1 vote.

**Les fautes de frappe ne sont pas silencieusement ignorées** : quand `derivedFrom` pointe vers un slug inexistant, le générateur affiche un `WARNING … no template with that slug` sur stderr (`buildModel` le collecte dans `unresolved`), sans jamais le ignorer silencieusement comme 0 vote.

---

## 5. Schéma de slug (poignée publique)

Un slug est l'**identité publique stable** d'un modèle — la galerie (`builtin-templates.ts`), `FLAGSHIP-TEMPLATES.md`, et cette vitrine utilisent la même poignée, de sorte que le `derivedFrom` d'un fork peut référencer l'amont par « le nom que tout le monde connaît. » Règles d'`assignSlugs` :

| Source | slug |
|---|---|
| flagship, avec **exactement un** fichier modèle sous `examples/<dir>` | basename de `<dir>` (p.ex. `examples/tea-supply-link` contient `tea-shop.template.yaml` → slug `tea-supply-link`, **pas** le nom du fichier) |
| flagship, avec **plusieurs** fichiers modèles sous le même répertoire | désambiguïsation par stem de nom de fichier (p.ex. `examples/family-learning-hub` contient `family-tutor` + `child-desk`) |
| community | stem du nom de fichier |

**Un conflit est un échec de construction** : deux modèles calculant le même slug → `assignSlugs` lève une exception. Une poignée publique ambiguë doit échouer bruyamment au moment de la construction, ne jamais être une carte silencieusement écrasée / une arête pointant vers le mauvais modèle. (Ce garde d'unicité est un vrai nid-de-poule rencontré : `family-tutor` et `child-desk` sont dans le même répertoire et prenaient autrefois tous deux le nom du répertoire `family-learning-hub` et entraient en collision.)

---

## 6. Déploiement (hébergement statique gratuit)

`site/` est un artefact purement statique ; n'importe quel niveau gratuit fonctionne. Prenons **GitHub Pages** comme exemple (pas de quota Actions nécessaire — construire localement, pousser manuellement la branche `gh-pages` ou utiliser la convention Pages `/docs`) :

```bash
pnpm build:site
# puis publiez le contenu de site/ sur l'hébergeur statique de votre choix :
#   · Cloudflare Pages / Netlify: glissez site/ dedans, ou branchez un hook "build: pnpm build:site,
#     output: site" (leur niveau gratuit a son propre quota de construction, sans rapport avec le quota Actions de ce dépôt) ;
#   · GitHub Pages: construire localement puis pousser site/ vers la branche gh-pages.
```

> ⚠️ Le **quota GitHub Actions de ce dépôt est épuisé**, donc la construction de la vitrine ne **dépend pas** de la CI de ce dépôt. Le générateur s'exécute localement (gratuit) ; le quota de construction propre à l'hébergeur statique est une question séparée. `site/` n'est pas versionné, donc il n'ajoute pas de gonflement au dépôt.

---

## 7. Test anti-dégradation

[`tests/build-site.test.ts`](../../packages/web/tests/build-site.test.ts) fixe la logique pure du générateur (son enveloppe d'E/S est gardée, donc `import` ne déclenche aucun scan de fichiers et n'écrit aucun fichier) :

- `assignSlugs` — les trois règles de slug + le garde d'unicité (la clôture de régression pour ce vrai nid-de-poule) ;
- `extractTemplate` — lit la surface d'affichage + `provenance.derivedFrom` (filtrant les entrées vides) depuis un manifest brut, lève une exception bruyante sur un schema incorrect ;
- `buildModel` — comptage du degré entrant des citations + tri du classement + mise en évidence d'une référence mal orthographiée comme `unresolved` ;
- `escapeHtml` / `render*` — les noms/descriptions fournis par la communauté sont **non fiables**, les cas XSS fixent que `<script>` ne peut jamais s'échapper du balisage.

---

## 8. Limites (honnêtes)

- La vitrine n'est **pas** un éditeur de modèles, et n'installe rien — c'est une fenêtre d'affichage en lecture seule. L'installation passe par la galerie de modèles de la console admin avec l'installation en un clic / `POST /api/admin/templates/import` (voir [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)).
- La **séparation modèle/framework** n'est pas brisée : la vitrine lit uniquement la **structure + les références** d'un manifest, n'affichant ni transportant jamais du contenu de connaissance ou du personnel (décisions #4/#5).
- `site/` est un snapshot au moment de la construction : après avoir modifié `examples/*/template/` ou ajouté un modèle communautaire, vous devez **relancer** `pnpm build:site` ; le test anti-dégradation est le sentinelle.

---

## Connexe

- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — la galerie d'installation en un clic dans la console admin (un autre consommateur du même corpus).
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — l'index organisé des modèles phares.
- [`HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) — la comparaison d'exemples de hub prêts à l'emploi + le runbook de mise en ligne.
- `../../CONTRIBUTING.md` — le flux de soumission de modèles communautaires (libre de droits + passe `pnpm check:templates`).
