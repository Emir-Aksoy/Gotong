# Community Landing Page + Template Gallery + Citation Leaderboard (zero-compute static site)

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/COMMUNITY-SITE.md) · [日本語](ja/COMMUNITY-SITE.md) · [Русский](ru/COMMUNITY-SITE.md) · [Français](fr/COMMUNITY-SITE.md) · [Español](es/COMMUNITY-SITE.md) · [한국어](ko/COMMUNITY-SITE.md). If a translation conflicts with this English version, the English version governs.

> Pre-launch checklist item 7. One line: **the community needs zero compute** — build it as a pile of static files, drop it on any free static host, and it's live; the cloud box stays as backup.

---

## 1. Why "zero compute"

AipeHub's whole design stance is **the hub doesn't run the LLM itself / state is all disk files / credentials stay on your machine / federation is peer-to-peer**. Follow that stance through and **the community infrastructure doesn't need a server either**:

- **GitHub already hosts the substance** — a template is a file, a submission is a PR.
- **The only thing missing is a storefront** — and the storefront for a file-first project is itself a pile of static files.

So this storefront = one generator + the static files it produces. The generator is [`packages/web/scripts/build-site.mjs`](../packages/web/scripts/build-site.mjs), producing `site/` (repo root, gitignored):

- `index.html` — a self-contained single file (no framework, no runtime, inline CSS): the trust-narrative hero + a template-gallery card grid + the citation-leaderboard table.
- `templates.json` — a machine-readable `aipehub.site/v1` feed (the storefront is also data, file-first).

Drop `site/` on any free tier of GitHub Pages / Cloudflare Pages / Netlify and the storefront is live at **$0**. The Tencent Cloud 2c2G box keeps idling as backup.

---

## 2. How to build

```bash
pnpm build:site          # root script, delegates to packages/web
# or
pnpm -C packages/web build:site
```

Output:

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/` is a derived artifact that's **built on demand and not checked in** (same stance as `dist-portable/`, see `.gitignore`). The single source of truth stays in `examples/` and `templates/community/` (template/framework separation); the storefront is their read-only projection — change a template and re-run the generator.

**Determinism**: the generator writes no timestamps and sorts stably → the same inputs produce a **byte-for-byte identical** `site/`, so rebuilds don't generate meaningless diffs.

---

## 3. Corpus = the same set that's validated

The generator scans **exactly** the same two roots that the repo-level validation gate (`pnpm check:templates` / [`tests/all-templates-parse.test.ts`](../packages/web/tests/all-templates-parse.test.ts)) validates:

| origin | path | note |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | flagship templates shipped with the framework |
| `community` | `templates/community/templates/**/*.ya?ml` | where community submissions land |

So "every template that passes CI appears on the storefront" holds **by construction** — a manifest that doesn't parse can never reach a card (it fails `check:templates` and never gets in).

---

## 4. Citation leaderboard = in-degree of `provenance.derivedFrom`

The leaderboard reads the additive provenance field `template.provenance.derivedFrom` (pre-launch checklist item 6):

- One `derivedFrom` entry is one **citation edge**: it declares "this template is adapted from whom."
- Ranking = **in-degree** = "how many templates derive from me."
- An edge references the target template's **slug** (its public handle, see below), so when you fork a template, writing the **upstream's slug** in your `provenance.derivedFrom` completes the attribution lineage.

The two real citation edges shipped with the framework (also written in `CLAUDE.md`):

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # sister example, same dispatch skeleton

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # MIRROR, the reverse-direction cross-org orchestration
```

→ On the leaderboard `personal-coding-hub` and `tea-supply-link` each get 1 vote.

**Typos aren't silently swallowed**: when `derivedFrom` points to a non-existent slug, the generator prints a `WARNING … no template with that slug` to stderr (`buildModel` collects it into `unresolved`), never quietly skipping it as 0 votes.

---

## 5. Slug (public handle) scheme

A slug is a template's **stable public identity** — the gallery (`builtin-templates.ts`), `FLAGSHIP-TEMPLATES.md`, and this storefront use the same handle, so a fork's `derivedFrom` can reference the upstream by "the name everyone knows." `assignSlugs` rules:

| Source | slug |
|---|---|
| flagship, with **exactly one** template file under `examples/<dir>` | basename of `<dir>` (e.g. `examples/tea-supply-link` holds `tea-shop.template.yaml` → slug `tea-supply-link`, **not** the filename) |
| flagship, with **multiple** template files under the same dir | filename-stem disambiguation (e.g. `examples/family-learning-hub` holds `family-tutor` + `child-desk`) |
| community | filename stem |

**A conflict is a build failure**: two templates computing the same slug → `assignSlugs` throws. An ambiguous public handle must error loudly at build time, never be a quietly-overwritten card / an edge pointing at the wrong template. (This uniqueness guard is a real pothole hit: `family-tutor` and `child-desk` are in the same dir and earlier both took the dir name `family-learning-hub` and collided.)

---

## 6. Deployment (free static hosting)

`site/` is a pure static artifact; any free tier works. Take **GitHub Pages** as an example (no Actions quota needed — build locally, manually push the `gh-pages` branch or use the Pages `/docs` convention):

```bash
pnpm build:site
# then publish the contents of site/ to the static host of your choice:
#   · Cloudflare Pages / Netlify: drag site/ in, or wire a "build: pnpm build:site,
#     output: site" hook (their free tier has its own build quota, unrelated to this repo's Actions quota);
#   · GitHub Pages: build locally then push site/ to the gh-pages branch.
```

> ⚠️ This repo's **GitHub Actions quota is exhausted**, so the store's build does **not** rely on this repo's CI. The generator runs locally (free); the static host's own build quota is a separate matter. `site/` is not checked in, so it adds no repo bloat.

---

## 7. Anti-rot test

[`tests/build-site.test.ts`](../packages/web/tests/build-site.test.ts) pins the generator's pure logic (its IO shell is guarded, so `import` triggers no file scan and writes no files):

- `assignSlugs` — the three slug rules + the uniqueness guard (the regression fence for that real pothole);
- `extractTemplate` — reads the display surface + `provenance.derivedFrom` (filtering empty entries) from a raw manifest, throws loudly on bad schema;
- `buildModel` — citation in-degree counting + leaderboard sort + surfacing a typo'd reference as `unresolved`;
- `escapeHtml` / `render*` — community-supplied names/descriptions are **untrusted**, the XSS cases pin that `<script>` can never escape the markup.

---

## 8. Boundaries (honest)

- The storefront is **not** a template editor, nor does it install anything — it's a read-only display window. Installation goes through the admin console's "Template Gallery" one-click install / `POST /api/admin/templates/import` (see [`TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md)).
- **Template/framework separation** is not broken: the storefront only reads a manifest's **structure + references**, never displaying or carrying knowledge content or personnel (decisions #4/#5).
- `site/` is a build-time snapshot: after changing `examples/*/template/` or adding a community template, you must **re-run** `pnpm build:site`; the anti-rot test is the sentinel.

---

## Related

- [`TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md) — the one-click install gallery inside the admin console (another consumer of the same corpus).
- [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) — the curated index of flagship templates.
- [`HANDS-ON-HUBS.md`](zh/HANDS-ON-HUBS.md) — the out-of-box hub example comparison + go-live runbook.
- `../CONTRIBUTING.md` — the community template submission flow (license-clear + passes `pnpm check:templates`).
