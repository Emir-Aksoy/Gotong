#!/usr/bin/env node
// Generate the community storefront — a static landing page + template gallery
// + citation leaderboard — into the repo-root `site/` directory.
//
// Why (pre-launch checklist item 7): AipeHub's whole design stance is "the hub
// is dumb / the framework doesn't run an LLM / state is files / credentials stay
// local / federation is peer-to-peer". That means the COMMUNITY needs zero
// compute to run. GitHub already hosts the substance (a template is just a
// file; submissions are PRs). All that's missing is a storefront — and a
// storefront for a file-first project is itself a pile of static files. This
// generator renders that pile: one self-contained `index.html` (no framework, no
// runtime, inline CSS) plus a machine-readable `templates.json` feed. Drop the
// `site/` dir on any free static host (GitHub Pages / Cloudflare Pages / Netlify)
// and the storefront is live for $0. The 2c2G box stays in reserve.
//
// The corpus IS the validated set: this sweeps the exact two roots the
// repo-wide gate (tests/all-templates-parse.test.ts, `pnpm check:templates`)
// validates — examples/*/template (flagship) and templates/community/templates
// (community submissions). So "every template that passes CI appears in the
// storefront" holds by construction; a manifest that wouldn't parse never makes
// it onto a card.
//
// The leaderboard reads the additive `template.provenance.derivedFrom` citation
// edges (checklist item 6). Count = in-degree = "how many templates derive from
// this one". Edges reference a template's SLUG (its examples/<dir> basename,
// which is also its gallery id), so a fork can cite its ancestor by a stable
// handle.
//
// DETERMINISTIC by design (no timestamp, stable sort): same inputs → byte-identical
// output, so a rebuilt `site/` doesn't churn. Single source of truth stays in
// examples/ and templates/community/ (模版与框架分离); `site/` is a derived,
// gitignored, build-on-demand artifact (same stance as dist-portable/).
//
// Re-run: `pnpm build:site` (root) or `pnpm -C packages/web build:site`.

import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'site')

// ── Pure helpers (exported for tests/build-site.test.ts) ────────────────────

/** Escape text for safe interpolation into HTML — a community name/description
 * is untrusted, so `<`, `&`, quotes must never break out into markup. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** First non-empty paragraph of a (possibly multi-line block) description,
 * collapsed to a single line and clipped — cards want a teaser, not the essay. */
export function teaser(description, max = 220) {
  if (!description) return ''
  const firstPara = String(description).trim().split(/\n\s*\n/)[0] ?? ''
  const oneLine = firstPara.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}

/** The file basename with the template/yaml suffix stripped. */
function fileStem(relPath) {
  return basename(relPath).replace(/\.template\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}

/** Assign each source its stable PUBLIC HANDLE (slug) — the same handle the
 * gallery (builtin-templates.ts) and FLAGSHIP-TEMPLATES.md use, so a fork's
 * `derivedFrom` can cite an ancestor by the name everyone knows it by:
 *   - flagship, single template in its examples/<dir> → the <dir> basename
 *     (e.g. examples/tea-supply-link ships tea-shop.template.yaml → slug
 *     `tea-supply-link`, NOT the filename);
 *   - flagship, MULTIPLE templates in one dir → the file stem disambiguates
 *     (examples/family-learning-hub ships family-tutor + child-desk);
 *   - community → the file stem.
 * Throws on a collision so an ambiguous handle is loud at build, never a
 * silently-overwritten card. Input order is preserved. */
export function assignSlugs(sources) {
  // How many flagship template files share each examples/<dir>? A dir with one
  // gets the dir name; a dir with several falls back to per-file stems.
  const perDir = new Map()
  for (const s of sources) {
    if (s.origin !== 'flagship') continue
    const dir = s.rel.split('/').slice(0, 2).join('/')
    perDir.set(dir, (perDir.get(dir) ?? 0) + 1)
  }
  const seen = new Set()
  return sources.map((s) => {
    let slug
    if (s.origin === 'flagship') {
      const parts = s.rel.split('/')
      const dir = `${parts[0]}/${parts[1]}`
      slug = (perDir.get(dir) ?? 0) > 1 ? fileStem(s.rel) : parts[1]
    } else {
      slug = fileStem(s.rel)
    }
    if (seen.has(slug)) {
      throw new Error(`duplicate template slug '${slug}' (${s.rel}) — ambiguous public handle`)
    }
    seen.add(slug)
    return { ...s, slug }
  })
}

/** Extract the storefront card data from one raw manifest, given its
 * pre-assigned slug. Mirrors what parseTemplate reads (root.template.*), but
 * lightweight — the gate already proved the file parses through the REAL
 * parser, so this only needs the display surface. Throws on a manifest it
 * can't read so a broken file is loud. */
export function extractTemplate(rawText, relPath, origin, slug) {
  const doc = parseYaml(rawText)
  if (!doc || typeof doc !== 'object') throw new Error(`${relPath}: not an object`)
  if (doc.schema !== 'aipehub.template/v1') throw new Error(`${relPath}: wrong schema ${doc.schema}`)
  const t = doc.template
  if (!t || typeof t !== 'object') throw new Error(`${relPath}: missing template block`)
  if (typeof t.name !== 'string' || t.name.trim().length === 0) {
    throw new Error(`${relPath}: missing template.name`)
  }
  const prov = t.provenance && typeof t.provenance === 'object' ? t.provenance : {}
  const derivedFrom = Array.isArray(prov.derivedFrom)
    ? prov.derivedFrom.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : []
  return {
    slug,
    name: t.name.trim(),
    description: typeof t.description === 'string' ? t.description : '',
    source: relPath,
    origin, // 'flagship' | 'community'
    agents: Array.isArray(t.agents) ? t.agents.length : 0,
    workflows: Array.isArray(t.workflows) ? t.workflows.length : 0,
    knowledgeBases: Array.isArray(t.knowledgeBases) ? t.knowledgeBases.length : 0,
    apiKeyPrompt: !!(t.defaults && typeof t.defaults === 'object' && t.defaults.apiKeyPrompt),
    derivedFrom,
    author: typeof prov.author === 'string' ? prov.author : '',
    notes: typeof prov.notes === 'string' ? prov.notes : '',
  }
}

/** Build the rendered model: enrich each template with its inbound citation
 * count, compute the leaderboard, and surface any derivedFrom edge that points
 * at an unknown slug (a typo'd citation is a build warning, never a silent
 * miscount). Stable-sorted so the output is deterministic. */
export function buildModel(templates) {
  const bySlug = new Map(templates.map((t) => [t.slug, t]))
  const citations = new Map() // slug -> inbound count
  const unresolved = [] // { from, to } edges that don't resolve

  for (const t of templates) {
    for (const target of t.derivedFrom) {
      if (bySlug.has(target)) {
        citations.set(target, (citations.get(target) ?? 0) + 1)
      } else {
        unresolved.push({ from: t.slug, to: target })
      }
    }
  }

  const enriched = templates
    .map((t) => ({ ...t, citationCount: citations.get(t.slug) ?? 0 }))
    .sort((a, b) => {
      // flagship before community, then name — a stable, locale-independent order.
      if (a.origin !== b.origin) return a.origin === 'flagship' ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })

  const leaderboard = enriched
    .filter((t) => t.citationCount > 0)
    .sort((a, b) => b.citationCount - a.citationCount || (a.name < b.name ? -1 : 1))
    .map((t) => ({ slug: t.slug, name: t.name, citationCount: t.citationCount }))

  return { templates: enriched, leaderboard, unresolved }
}

const REPO_URL = 'https://github.com/Emir-Aksoy/AipeHub'

function originBadge(origin) {
  return origin === 'flagship'
    ? '<span class="badge badge-flagship">官方旗舰</span>'
    : '<span class="badge badge-community">社区</span>'
}

function cardHtml(t, bySlug) {
  const counts = [
    t.agents ? `${t.agents} 智能体` : '',
    t.workflows ? `${t.workflows} 工作流` : '',
    t.knowledgeBases ? `${t.knowledgeBases} 知识库槽位` : '',
  ].filter(Boolean)
  const meta = counts.length ? counts.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('') : ''
  const keyChip = t.apiKeyPrompt ? '<span class="chip chip-key">需自带 API Key</span>' : ''
  // Attribution: show what this template was forked from, linking the ancestor
  // card on the same page when it resolves.
  const derived = t.derivedFrom.length
    ? `<p class="derived">基于 ${t.derivedFrom
        .map((s) => {
          const anc = bySlug.get(s)
          return anc
            ? `<a href="#tpl-${escapeHtml(s)}">${escapeHtml(anc.name)}</a>`
            : `<span class="ghost">${escapeHtml(s)}</span>`
        })
        .join('、')}</p>`
    : ''
  const cited = t.citationCount > 0 ? `<span class="chip chip-cited">被 ${t.citationCount} 个模板引用</span>` : ''
  const author = t.author ? `<p class="author">作者 ${escapeHtml(t.author)}</p>` : ''
  return `      <article class="card" id="tpl-${escapeHtml(t.slug)}">
        <header>
          <h3>${escapeHtml(t.name)} ${originBadge(t.origin)}</h3>
          <code class="slug">${escapeHtml(t.slug)}</code>
        </header>
        <p class="desc">${escapeHtml(teaser(t.description))}</p>
        <div class="chips">${meta}${keyChip}${cited}</div>
        ${derived}
        ${author}
        <a class="src" href="${REPO_URL}/tree/main/${escapeHtml(dirname(t.source))}">查看源码与 README →</a>
      </article>`
}

function leaderboardHtml(leaderboard) {
  if (leaderboard.length === 0) {
    return `      <p class="empty">还没有派生模板 —— 第一个「基于某模板改的」社区提交会出现在这里。
      在你的模板里写 <code>provenance.derivedFrom: [被引用模板的 slug]</code> 即可署名传承。</p>`
  }
  const rows = leaderboard
    .map(
      (e, i) =>
        `        <tr><td class="rank">${i + 1}</td><td><a href="#tpl-${escapeHtml(e.slug)}">${escapeHtml(
          e.name,
        )}</a></td><td class="count">${e.citationCount}</td></tr>`,
    )
    .join('\n')
  return `      <table class="leaderboard">
        <thead><tr><th>#</th><th>模板</th><th>被引用次数</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>`
}

/** Render the self-contained storefront page. One file, inline CSS, no JS —
 * the leanest possible "deploy anywhere" artifact. */
export function renderIndexHtml(model) {
  const bySlug = new Map(model.templates.map((t) => [t.slug, t]))
  const flagship = model.templates.filter((t) => t.origin === 'flagship')
  const community = model.templates.filter((t) => t.origin === 'community')
  const cards = (list) => list.map((t) => cardHtml(t, bySlug)).join('\n')
  const communitySection = community.length
    ? `    <h2 id="community">社区模板</h2>
    <div class="grid">
${cards(community)}
    </div>`
    : `    <h2 id="community">社区模板</h2>
    <p class="empty">还没有社区提交。第一个会在这里 —— 提交流程见
      <a href="${REPO_URL}/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>。</p>`

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AipeHub — 可信的 AI 工作底座 · 模板画廊</title>
<meta name="description" content="本地、可治理、人在环里的 AI 工作底座。一键装一整套：智能体 + 工作流 + 知识库槽位。">
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #2b3441; --fg: #e6edf3;
    --muted: #8b949e; --accent: #4493f8; --accent-2: #3fb950; --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px; }
  header.hero { padding: 72px 0 48px; border-bottom: 1px solid var(--border); }
  .hero .tag { color: var(--muted); letter-spacing: .12em; text-transform: uppercase;
    font-size: 13px; margin: 0 0 12px; }
  .hero h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.15; margin: 0 0 16px; }
  .hero h1 .accent { color: var(--accent); }
  .hero p.lead { font-size: 19px; color: var(--fg); max-width: 720px; margin: 0 0 24px; }
  .hero .pillars { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 28px; }
  .hero .pillars span { background: var(--panel); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 14px; font-size: 14px; color: var(--muted); }
  .cta { display: inline-block; background: var(--accent); color: #fff; border-radius: 8px;
    padding: 11px 20px; font-weight: 600; margin-right: 12px; }
  .cta.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
  section { padding: 48px 0; }
  h2 { font-size: 26px; margin: 0 0 8px; }
  h2 + p.sub { color: var(--muted); margin: 0 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; display: flex; flex-direction: column; }
  .card header { margin-bottom: 8px; }
  .card h3 { font-size: 18px; margin: 0 0 4px; }
  .card .slug { color: var(--muted); font-size: 12px; }
  .card .desc { color: var(--fg); font-size: 14px; flex: 1; margin: 8px 0 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { background: #1f2630; border: 1px solid var(--border); border-radius: 6px;
    padding: 2px 9px; font-size: 12px; color: var(--muted); }
  .chip-key { color: var(--warn); border-color: #463a1a; }
  .chip-cited { color: var(--accent-2); border-color: #1c3a25; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; vertical-align: middle; }
  .badge-flagship { background: #16301f; color: var(--accent-2); border: 1px solid #1c3a25; }
  .badge-community { background: #1a2740; color: var(--accent); border: 1px solid #1f3a5c; }
  .derived { font-size: 13px; color: var(--muted); margin: 0 0 6px; }
  .derived .ghost { color: var(--warn); }
  .author { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
  .card .src { font-size: 13px; margin-top: auto; }
  .leaderboard { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .leaderboard th, .leaderboard td { text-align: left; padding: 12px 16px;
    border-bottom: 1px solid var(--border); }
  .leaderboard th { color: var(--muted); font-size: 13px; font-weight: 600; }
  .leaderboard tr:last-child td { border-bottom: 0; }
  .leaderboard .rank { color: var(--muted); width: 48px; }
  .leaderboard .count { color: var(--accent-2); font-weight: 600; width: 120px; }
  .empty { color: var(--muted); background: var(--panel); border: 1px dashed var(--border);
    border-radius: 12px; padding: 24px; }
  footer { border-top: 1px solid var(--border); padding: 40px 0; color: var(--muted); font-size: 14px; }
  footer a { color: var(--muted); text-decoration: underline; }
</style>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <p class="tag">AI + Person + Hub</p>
    <h1>可以放心交给 AI 的事，<br>交给一个<span class="accent">你自己的</span> hub。</h1>
    <p class="lead">AipeHub 是一个本地优先、可治理、人始终在环里的 AI 工作底座。框架自己不跑大模型 ——
      它只路由消息、派任务、写下可审计的轨迹；决策权永远在参与者（你的 agent、你、或外部服务）手里。
      凭证留在本机，状态都是磁盘文件，跨组织协作点对点。所以家、家人、钱这类事，它配得上你的信任。</p>
    <div class="pillars">
      <span>🏠 本地优先 · 凭证不出本机</span>
      <span>🧾 每一步可审计</span>
      <span>🙋 危险/跨组织动作人工确认</span>
      <span>🔗 点对点联邦 · 各管各家</span>
    </div>
    <a class="cta" href="#gallery">浏览模板画廊 ↓</a>
    <a class="cta ghost" href="${REPO_URL}#quickstart">5 分钟跑起来</a>
  </div>
</header>

<section id="gallery">
  <div class="wrap">
    <h2>模板画廊</h2>
    <p class="sub">一个文件装一整套：智能体 + 声明式工作流 + 知识库槽位。在 admin 控制台「模板画廊」一键安装，
      或 <code>POST /api/admin/templates/import</code>。知识内容与人员从不随模板走（模版与框架分离）。</p>
    <h2 id="flagship" style="font-size:20px">官方旗舰</h2>
    <div class="grid">
${cards(flagship)}
    </div>
${communitySection}
  </div>
</section>

<section id="leaderboard" style="border-top:1px solid var(--border)">
  <div class="wrap">
    <h2>引用排行榜</h2>
    <p class="sub">谁被改得最多 —— 按「有多少模板声明 derivedFrom 它」排名。传承是署名的：fork 一个模板时，
      在你的 <code>provenance.derivedFrom</code> 里写上它的 slug。</p>
${leaderboardHtml(model.leaderboard)}
  </div>
</section>

<footer>
  <div class="wrap">
    <p>共 ${model.templates.length} 个模板（${flagship.length} 旗舰 · ${community.length} 社区）。
      此页由 <code>packages/web/scripts/build-site.mjs</code> 从校验过的模板语料确定性生成 ——
      每个出现在这里的模板都通过了 <code>pnpm check:templates</code> 的真解析门。</p>
    <p><a href="${REPO_URL}">GitHub 仓库</a> ·
      <a href="${REPO_URL}/blob/main/CONTRIBUTING.md">贡献模板</a> ·
      <a href="${REPO_URL}/blob/main/docs/zh/FLAGSHIP-TEMPLATES.md">旗舰模板索引</a> ·
      <a href="${REPO_URL}/blob/main/GOVERNANCE.md">治理</a></p>
  </div>
</footer>
</body>
</html>
`
}

/** Machine-readable feed — the storefront is also data (file-first). Stable key
 * order + no timestamp keeps it diff-friendly. */
export function renderTemplatesJson(model) {
  const payload = {
    schema: 'aipehub.site/v1',
    note: 'Derived from validated aipehub.template/v1 manifests by scripts/build-site.mjs. Deterministic, no timestamp.',
    templateCount: model.templates.length,
    templates: model.templates.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: teaser(t.description, 400),
      source: t.source,
      origin: t.origin,
      agents: t.agents,
      workflows: t.workflows,
      knowledgeBases: t.knowledgeBases,
      apiKeyPrompt: t.apiKeyPrompt,
      derivedFrom: t.derivedFrom,
      author: t.author,
      citationCount: t.citationCount,
    })),
    leaderboard: model.leaderboard,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

// ── IO shell (only runs when invoked directly, not when imported by a test) ──

async function safeReaddir(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function collectSources() {
  const out = [] // { abs, rel, origin }
  // Flagship: examples/*/template/*.template.ya?ml
  const examplesDir = join(REPO_ROOT, 'examples')
  for (const ex of await safeReaddir(examplesDir)) {
    const tdir = join(examplesDir, ex, 'template')
    for (const f of await safeReaddir(tdir)) {
      if (/\.template\.ya?ml$/i.test(f)) {
        const abs = join(tdir, f)
        out.push({ abs, rel: relative(REPO_ROOT, abs), origin: 'flagship' })
      }
    }
  }
  // Community: templates/community/templates/** (recursive *.ya?ml)
  const communityRoot = join(REPO_ROOT, 'templates', 'community', 'templates')
  async function walk(dir) {
    for (const name of await safeReaddir(dir)) {
      const abs = join(dir, name)
      if (await isDir(abs)) await walk(abs)
      else if (/\.ya?ml$/i.test(name) && !/readme/i.test(name)) {
        out.push({ abs, rel: relative(REPO_ROOT, abs), origin: 'community' })
      }
    }
  }
  await walk(communityRoot)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** Sweep the validated corpus (flagship examples/ + community submissions),
 * assign each its public slug, and extract the display + provenance record.
 * Exported so the leaderboard-doc generator (build-leaderboard-doc.mjs) reads
 * the EXACT same corpus and edges as the storefront — one source of truth, so
 * the checked-in FLAGSHIP table and the generated site can never disagree about
 * who is cited how often. Does IO; only runs when called (the test importing
 * this module must not sweep the filesystem). */
export async function loadCorpus() {
  const sources = assignSlugs(await collectSources())
  const templates = []
  for (const s of sources) {
    const text = await readFile(s.abs, 'utf8')
    templates.push(extractTemplate(text, s.rel, s.origin, s.slug))
  }
  return templates
}

async function main() {
  const templates = await loadCorpus()
  const model = buildModel(templates)

  for (const u of model.unresolved) {
    process.stderr.write(
      `build-site: WARNING ${u.from} derivedFrom '${u.to}' — no template with that slug (typo'd citation?)\n`,
    )
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'index.html'), renderIndexHtml(model), 'utf8')
  await writeFile(join(OUT_DIR, 'templates.json'), renderTemplatesJson(model), 'utf8')

  process.stdout.write(
    `build-site: ${model.templates.length} templates → ${relative(REPO_ROOT, OUT_DIR)}/ ` +
      `(index.html + templates.json), ${model.leaderboard.length} on the leaderboard\n`,
  )
}

// Only run the IO when executed directly — importing this module (the test) must
// not sweep the filesystem or write files.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`build-site: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
}
