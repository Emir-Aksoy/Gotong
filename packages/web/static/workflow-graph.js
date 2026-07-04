// Shared read-only workflow-graph SVG renderer (workflow-architect ARCH-M4).
//
// A WorkflowDefinition is ALREADY a DAG (trigger → steps → parallel branches
// → output). The host returns a PURE { nodes, edges } projection
// (projectWorkflowGraph) and this lays it out + hand-draws SVG — no chart
// library, mirroring the peer-summary sparkline. Pure visibility: it never
// touches the YAML, which stays the governance / version-control root.
//
// Why standalone (not inside the admin esbuild bundle): the same renderer is
// used by TWO independently-loaded front-ends —
//   1. the admin console (admin-src/* → static/admin.js, a classic IIFE that
//      app.js injects at runtime), and
//   2. the member SPA (static/app.js, hand-written, loaded directly).
// Neither shares a module graph with the other, so the seam is a tiny global
// attached here and consumed by both. `t` (i18n) and `escapeHtml` are passed
// IN as parameters so this file stays pure and couples to neither side's
// translation object.
//
// Loaded via <script src="/workflow-graph.js" defer> in app.html, BEFORE
// app-core.js / app.js — so window.GotongWorkflowGraph exists before either
// front-end (and before admin.js, which app.js injects later) ever calls it.
;(function () {
  'use strict'

  // Pure: a { nodes, edges } graph → a hand-drawn SVG string. The node array
  // out of projectWorkflowGraph is already a renderable vertical stack
  // (trigger, [parallel container, its branches...], step, ..., output): every
  // node gets its own row; backbone nodes sit in column 0 and a parallel step's
  // branch nodes indent to column 1.
  //
  // opts: { t, escapeHtml } — the caller's i18n table + HTML escaper.
  function renderWorkflowGraphSvg(graph, opts) {
    const t = opts.t
    const escapeHtml = opts.escapeHtml
    const MARGIN_X = 92, MARGIN_Y = 30, ROW_H = 100, COL_W = 250
    const BOX_W = 224, BRANCH_W = 198, BOX_H = 62, RIGHT_PAD = 56
    const boxW = (node) => (node.kind === 'branch' ? BRANCH_W : BOX_W)

    const pos = new Map()
    let row = 0, maxCol = 0
    for (const node of graph.nodes) {
      const col = node.kind === 'branch' ? 1 : 0
      if (col > maxCol) maxCol = col
      pos.set(node.id, { col, row, node })
      row++
    }
    const left = (p) => MARGIN_X + p.col * COL_W
    const cx = (p) => left(p) + boxW(p.node) / 2
    const top = (p) => MARGIN_Y + p.row * ROW_H
    const bottom = (p) => top(p) + BOX_H
    const midY = (p) => top(p) + BOX_H / 2
    const width = MARGIN_X + maxCol * COL_W + BOX_W + RIGHT_PAD
    const height = MARGIN_Y * 2 + row * ROW_H

    const clip = (s, n) => {
      s = String(s == null ? '' : s)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    const destText = (node) => {
      const d = node.destination
      if (!d) return ''
      if (d.kind === 'explicit') return t.workflowGraphDestExplicit(d.to || '')
      if (d.kind === 'broadcast') return t.workflowGraphDestBroadcast((d.capabilities || []).join(', '))
      return t.workflowGraphDestCapability((d.capabilities || []).join(', '))
    }

    // Edges. Data edges draw FIRST (under the boxes — boxes are opaque, so a
    // data edge passing behind an intervening box is occluded, reading as a
    // clean connector). Sequence (backbone + fan-out) draws on top of them;
    // boxes draw last.
    const dataEdges = [], seqEdges = []
    for (const e of graph.edges || []) {
      const a = pos.get(e.from), b = pos.get(e.to)
      if (!a || !b) continue
      if (e.kind === 'data') {
        // Dashed bow into the LEFT gutter, anchored on both boxes' left edge —
        // off the solid backbone (which runs down the box centers).
        const x1 = left(a), y1 = midY(a), x2 = left(b), y2 = midY(b)
        const apex = Math.min(x1, x2) - 30
        const my = (y1 + y2) / 2
        dataEdges.push(
          `<path d="M ${x1} ${y1} Q ${apex} ${my}, ${x2} ${y2}" class="wf-graph-edge-data" marker-end="url(#wf-graph-arrow-data)" />`,
        )
      } else if (b.node.kind === 'branch') {
        // Container (col 0) → branch (col 1): bottom-center of the container,
        // elbow into the LEFT-center of the branch box.
        const x1 = cx(a), y1 = bottom(a), x2 = left(b), y2 = midY(b)
        seqEdges.push(
          `<path d="M ${x1} ${y1} C ${x1} ${y1 + 26}, ${x2 - 40} ${y2}, ${x2} ${y2}" class="wf-graph-edge-seq" marker-end="url(#wf-graph-arrow)" />`,
        )
      } else {
        // Backbone vertical (col 0 → col 0): straight down (may visually skip
        // the rows a parallel step's branches occupy in column 1).
        seqEdges.push(
          `<path d="M ${cx(a)} ${bottom(a)} L ${cx(b)} ${top(b)}" class="wf-graph-edge-seq" marker-end="url(#wf-graph-arrow)" />`,
        )
      }
    }

    const boxes = graph.nodes
      .map((node) => {
        const p = pos.get(node.id)
        const w = boxW(node), x = left(p), y = top(p)
        const cls = 'wf-graph-box wf-graph-box-' + node.kind + (node.crossHub ? ' wf-graph-box-xhub' : '')
        const title = node.kind === 'output' ? t.workflowGraphOutput : node.label
        const tag =
          node.kind === 'parallel' ? t.workflowGraphParallel
          : node.kind === 'branch' ? t.workflowGraphBranch
          : node.kind === 'trigger' ? t.workflowGraphTrigger
          : ''
        const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${BOX_H}" rx="8" class="${cls}" />`]
        if (tag) {
          parts.push(`<text x="${x + w - 8}" y="${y + 15}" text-anchor="end" class="wf-graph-tag">${escapeHtml(tag)}</text>`)
        }
        parts.push(`<text x="${x + 12}" y="${y + 25}" class="wf-graph-title">${escapeHtml(clip(title, 26))}</text>`)
        if (node.kind === 'step' || node.kind === 'branch') {
          let sub = destText(node)
          const extras = []
          if (node.readsTrigger) extras.push(t.workflowGraphReadsTrigger)
          if (Array.isArray(node.dataClasses) && node.dataClasses.length) extras.push(node.dataClasses.join('/'))
          if (extras.length) sub = sub ? sub + ' · ' + extras.join(' · ') : extras.join(' · ')
          if (sub) parts.push(`<text x="${x + 12}" y="${y + 43}" class="wf-graph-sub">${escapeHtml(clip(sub, 36))}</text>`)
        }
        let ay = bottom(p) + 14
        if (node.when) {
          parts.push(`<text x="${x + 2}" y="${ay}" class="wf-graph-when">${escapeHtml(clip(t.workflowGraphWhen(node.when), 42))}</text>`)
          ay += 14
        }
        if (node.crossHub) {
          const dest = node.crossHub.peerLabel || node.crossHub.peer
          parts.push(`<text x="${x + 2}" y="${ay}" class="wf-graph-xhub-tag">${escapeHtml(clip(t.workflowGraphCrossHub(dest), 42))}</text>`)
        }
        return parts.join('')
      })
      .join('')

    const defs =
      `<defs>` +
      `<marker id="wf-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-graph-arrowhead" /></marker>` +
      `<marker id="wf-graph-arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-graph-arrowhead-data" /></marker>` +
      `</defs>`

    return (
      `<svg class="wf-graph-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="workflow graph">` +
      defs + dataEdges.join('') + seqEdges.join('') + boxes +
      `</svg>`
    )
  }

  // opts: { t, escapeHtml }
  function graphLegend(opts) {
    const t = opts.t
    const escapeHtml = opts.escapeHtml
    return (
      `<div class="wf-graph-legend">` +
      `<span class="wf-graph-legend-seq">${escapeHtml(t.workflowGraphLegendSeq)}</span>` +
      `<span class="wf-graph-legend-data">${escapeHtml(t.workflowGraphLegendData)}</span>` +
      `</div>`
    )
  }

  // The inline render leans on the page's wf-graph-* rules in styles.css. A
  // downloaded file has no page, so the same class names resolve to nothing and
  // the .svg opens blank. Mirror the on-page rules into an embedded <style> so
  // the standalone file is legible on its own (box fills, text, edges, arrows).
  const STANDALONE_STYLE =
    'svg{background:#fcfcfa}' +
    '.wf-graph-box{stroke-width:1.5}' +
    '.wf-graph-box-trigger,.wf-graph-box-output{fill:#d6ecdb;stroke:#9cc9ab}' +
    '.wf-graph-box-step{fill:#f9f9f5;stroke:#d8d8cf}' +
    '.wf-graph-box-parallel{fill:#e0e8f4;stroke:#aac1e0}' +
    '.wf-graph-box-branch{fill:#f4f6fb;stroke:#cdd8ec}' +
    '.wf-graph-box-xhub{stroke:#1d5fa8;stroke-width:2}' +
    '.wf-graph-title{font-size:13px;font-weight:600;fill:#1a1a1a}' +
    '.wf-graph-sub{font-size:11px;fill:#555}' +
    '.wf-graph-tag{font-size:9.5px;font-weight:700;letter-spacing:.04em;fill:#2a5a85}' +
    '.wf-graph-when{font-size:10.5px;fill:#9a6700}' +
    '.wf-graph-xhub-tag{font-size:10.5px;font-weight:600;fill:#1d5fa8}' +
    '.wf-graph-edge-seq{fill:none;stroke:#8a8a82;stroke-width:1.6}' +
    '.wf-graph-edge-data{fill:none;stroke:#b58acb;stroke-width:1.3;stroke-dasharray:4 3}' +
    '.wf-graph-arrowhead{fill:#8a8a82}' +
    '.wf-graph-arrowhead-data{fill:#b58acb}'

  // A downloadable href for an SVG string. data: URL keeps it client-side —
  // the host renders nothing (the architect plan's "inline SVG + downloadable,
  // host zero render burden"). Inject the xmlns (so it opens as a real file)
  // and the embedded style block (so it carries its own colors). `<defs>` is
  // always emitted by renderWorkflowGraphSvg, so it's a stable anchor.
  function svgDownloadHref(svgString) {
    const standalone = svgString
      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace('<defs>', `<defs><style>${STANDALONE_STYLE}</style>`)
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(standalone)
  }

  window.GotongWorkflowGraph = { renderWorkflowGraphSvg, graphLegend, svgDownloadHref }
})()
