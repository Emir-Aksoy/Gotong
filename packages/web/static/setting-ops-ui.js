/**
 * setting-ops M4 — the unified deterministic "运维 / 设置" console (admin 设置
 * tab, panel #setting-ops-panel). The WEB surface of the one host `ops-core`
 * engine (CLI + admin web + IM command-mode all consume the same engine).
 * Self-contained module; same activation pattern as the federation panels
 * (owner/admin, MutationObserver on <body data-active-tab>, targets its own
 * panel by id). DEPLOY-B3 moved it from the overview tab onto the admin 设置
 * page, next to the 体检 panel + IM channel status it belongs with.
 *
 *   GET  /api/admin/setting/commands   the full ops catalog, annotated for THIS
 *                                      actor (every tier LISTED so the operator
 *                                      sees the whole lifecycle; `runnableHere`
 *                                      flags which can run from here).
 *   POST /api/admin/setting/run        run ONE read / safe-mutate / config-write
 *                                      (owner) command. `{ id, args? }`.
 *
 * The boundary, made visible: destructive-offline commands (cold-start / restore /
 * rotate-master-key) are LISTED with a "去服务器 CLI 跑" hint and NO run button —
 * they happen when the hub is down or being replaced, so the web process that
 * would run them isn't up. Even if a button existed, the host `runOpsCommand`
 * chokepoint throws for any destructive id. config-write commands show a run
 * control only when `runnableHere` (the host maps owner → allowConfigWrite); a
 * non-owner admin sees the owner hint instead. So this panel can DISPLAY the full
 * lifecycle while only ever executing the safe online subset.
 *
 * When the host didn't wire the surface the routes 503 and the panel stays hidden
 * (like #hub-health) rather than render a console that can't run anything.
 *
 * i18n: reads the live dict off window.Gotong.t at call time (app-core.js runs
 * before this panel is injected). Panel chrome + tier labels + hints are
 * `settingOps*` keys; per-command labels come from the localized `settingOpsCmd`
 * map, falling back to the backend's (English) title/summary for an unknown id.
 */
;(function () {
  'use strict'

  const AH = window.Gotong
  function t() {
    return AH.t
  }

  const API = '/api/admin/setting'

  // Tier display order (lifecycle order) + the inline badge palette. read = info
  // blue, safe-mutate = green, config-write = amber (owner write), destructive =
  // red (CLI-only). Mirrors the steward tier idiom but inline like the federation
  // panels, so no CSS-file rebuild dependency.
  const TIER_ORDER = ['read', 'safe-mutate', 'config-write', 'destructive-offline']
  const TIER_PALETTE = {
    read: ['#e7f0fb', '#1c5fb0'],
    'safe-mutate': ['#e6f4ea', '#1e7e34'],
    'config-write': ['#fdf3e3', '#9a6a12'],
    'destructive-offline': ['#fdecea', '#c0392b'],
  }

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function tierLabel(tier) {
    const d = t()
    return (
      {
        read: d.settingOpsTierRead,
        'safe-mutate': d.settingOpsTierSafe,
        'config-write': d.settingOpsTierConfig,
        'destructive-offline': d.settingOpsTierDestructive,
      }[tier] || tier
    )
  }

  function tierBadge(tier) {
    const pair = TIER_PALETTE[tier] || TIER_PALETTE.read
    return (
      '<span style="display:inline-block;padding:0.1rem 0.45rem;border-radius:0.25rem;font-size:0.72rem;' +
      'white-space:nowrap;background:' +
      pair[0] +
      ';color:' +
      pair[1] +
      ';">' +
      escHtml(tierLabel(tier)) +
      '</span>'
    )
  }

  // Localized command title/summary, falling back to the backend's verbatim text
  // (English ops vocabulary) for an id the dict doesn't carry yet.
  function cmdText(c) {
    const map = t().settingOpsCmd || {}
    const local = map[c.id]
    return {
      title: (local && local.title) || c.title || c.id,
      summary: (local && local.summary) || c.summary || '',
    }
  }

  // The argv-usage placeholder for a runnable config-write command's args input.
  function usagePlaceholder(id) {
    const d = t()
    if (id === 'config-set') return d.settingOpsUsageConfigSet
    if (id === 'config-price') return d.settingOpsUsageConfigPrice
    return ''
  }

  // ---- API --------------------------------------------------------------

  async function readJson(r) {
    let json = null
    try {
      json = await r.json()
    } catch (_) {
      /* */
    }
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || 'http ' + r.status
      const err = new Error(msg)
      err.status = r.status
      throw err
    }
    return json || {}
  }

  async function apiCommands() {
    return (await readJson(await fetch(API + '/commands'))).commands || []
  }
  async function apiRun(id, args) {
    return readJson(
      await fetch(API + '/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, args: args || [] }),
      }),
    )
  }

  // ---- render -----------------------------------------------------------

  function setStatus(root, msg, kind) {
    const el = $('#setting-ops-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.style.color = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e7e34' : '#555'
  }

  function buildShell(root) {
    const d = t()
    root.innerHTML =
      '<div style="padding:1rem;max-width:60rem;">' +
      '<h2 style="margin-top:0;">' + escHtml(d.settingOpsTitle) + '</h2>' +
      '<p style="color:#555;font-size:0.88rem;margin:0 0 0.75rem;">' + escHtml(d.settingOpsHint) + '</p>' +
      '<div id="setting-ops-status" style="min-height:1.2em;font-size:0.88rem;color:#555;margin-bottom:0.75rem;"></div>' +
      '<div id="setting-ops-groups"></div>' +
      '</div>'
  }

  // One command row. read / safe-mutate → a no-arg run button. config-write that
  // is runnableHere → an args input + run button (host validates). Anything not
  // runnableHere (destructive-offline always; config-write for a non-owner) → the
  // localized where-to-run hint and NO control.
  function commandRow(c) {
    const text = cmdText(c)
    const head =
      '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
      tierBadge(c.tier) +
      '<strong style="font-size:0.92rem;">' + escHtml(text.title) + '</strong>' +
      '<code style="color:#999;font-size:0.78rem;">' + escHtml(c.id) + '</code>' +
      '</div>'
    const summary = '<p style="color:#555;font-size:0.84rem;margin:0.3rem 0;">' + escHtml(text.summary) + '</p>'

    let control = ''
    if (c.runnableHere) {
      if (c.tier === 'config-write') {
        control =
          '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;">' +
          '<input type="text" class="setting-ops-args" placeholder="' + escHtml(usagePlaceholder(c.id)) + '"' +
          ' autocomplete="off" style="flex:1;min-width:16rem;padding:0.35rem 0.5rem;font-family:monospace;font-size:0.82rem;" />' +
          '<button type="button" class="setting-ops-run" style="padding:0.35rem 0.8rem;">' + escHtml(t().settingOpsRun) + '</button>' +
          '</div>'
      } else {
        control =
          '<button type="button" class="setting-ops-run" style="padding:0.35rem 0.8rem;">' + escHtml(t().settingOpsRun) + '</button>'
      }
    } else {
      const hint = c.tier === 'destructive-offline' ? t().settingOpsWhereCli : t().settingOpsWhereOwner
      control = '<p style="color:#9a6a12;font-size:0.82rem;margin:0.2rem 0 0;">→ ' + escHtml(hint) + '</p>'
    }

    return (
      '<div class="setting-ops-cmd" data-id="' + escHtml(c.id) + '" data-tier="' + escHtml(c.tier) + '"' +
      ' style="border:1px solid #eee;border-radius:0.4rem;padding:0.6rem 0.75rem;margin-bottom:0.55rem;background:#fff;">' +
      head +
      summary +
      control +
      '<pre class="setting-ops-result" hidden style="white-space:pre-wrap;word-break:break-word;background:#f7f7f8;' +
      'border-radius:0.3rem;padding:0.5rem;margin:0.5rem 0 0;font-size:0.8rem;max-height:18rem;overflow:auto;"></pre>' +
      '</div>'
    )
  }

  function renderGroups(root, commands) {
    const d = t()
    const groups = $('#setting-ops-groups', root)
    if (!groups) return
    if (!commands.length) {
      groups.innerHTML = '<p style="color:#888;">' + escHtml(d.settingOpsEmpty) + '</p>'
      return
    }
    const byTier = {}
    for (const c of commands) (byTier[c.tier] || (byTier[c.tier] = [])).push(c)
    // Stable tier order; tolerate an unknown tier by appending it last.
    const tiers = TIER_ORDER.filter(function (x) {
      return byTier[x]
    }).concat(
      Object.keys(byTier).filter(function (x) {
        return TIER_ORDER.indexOf(x) < 0
      }),
    )
    groups.innerHTML = tiers
      .map(function (tier) {
        const rows = byTier[tier].map(commandRow).join('')
        return (
          '<section style="margin-bottom:1.1rem;">' +
          '<h3 style="font-size:0.92rem;margin:0 0 0.5rem;border-bottom:1px solid #eee;padding-bottom:0.25rem;">' +
          escHtml(tierLabel(tier)) +
          '</h3>' +
          rows +
          '</section>'
        )
      })
      .join('')
    // Wire run buttons (event delegation on the groups container).
    groups.addEventListener('click', onGroupsClick)
  }

  function onGroupsClick(ev) {
    const btn = ev.target.closest && ev.target.closest('.setting-ops-run')
    if (!btn) return
    const card = btn.closest('.setting-ops-cmd')
    if (!card) return
    runCommand(card, btn)
  }

  // POST /run with the card's id + (config-write) the args input, render the
  // result lines into the card's <pre>. The host re-checks the tier, so a hand
  // tweak can't reach a destructive op here.
  async function runCommand(card, btn) {
    const id = card.dataset.id
    const input = card.querySelector('.setting-ops-args')
    const args = input ? String(input.value || '').trim().split(/\s+/).filter(Boolean) : []
    const resultEl = card.querySelector('.setting-ops-result')
    const prev = btn.textContent
    btn.disabled = true
    btn.textContent = t().settingOpsRunning
    try {
      const j = await apiRun(id, args)
      const lines = (j && j.result && Array.isArray(j.result.lines) ? j.result.lines : []).join('\n')
      if (resultEl) {
        resultEl.hidden = false
        resultEl.style.color = '#222'
        resultEl.textContent = lines || t().settingOpsOk
      }
    } catch (err) {
      if (resultEl) {
        resultEl.hidden = false
        resultEl.style.color = '#c0392b'
        resultEl.textContent = t().settingOpsRunFailed(err && err.message ? err.message : err)
      }
    } finally {
      btn.disabled = false
      btn.textContent = prev
    }
  }

  // ---- load / activation ------------------------------------------------

  async function load(root) {
    setStatus(root, t().settingOpsLoading, 'loading')
    try {
      const commands = await apiCommands()
      root.hidden = false
      renderGroups(root, commands)
      const here = commands.filter(function (c) {
        return c.runnableHere
      }).length
      setStatus(root, t().settingOpsLoaded(commands.length, here), 'ok')
    } catch (err) {
      // 503 = host didn't wire the surface → keep the panel hidden (no console
      // that can't run anything), exactly like #hub-health self-hides.
      if (err && err.status === 503) {
        root.hidden = true
        return
      }
      root.hidden = false
      setStatus(root, t().settingOpsLoadFailed(err && err.message ? err.message : err), 'error')
    }
  }

  function isActive() {
    // DEPLOY-B3 — the panel moved from the overview tab onto the admin 设置
    // page (its data-tab in app.html changed in lockstep).
    return document.body.dataset.activeTab === 'settings'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }

  function init() {
    const root = document.querySelector('#setting-ops-panel')
    if (!root) return
    buildShell(root)
    new MutationObserver(function () {
      maybeLoad(root).catch(function () {
        /* setStatus reported it */
      })
    }).observe(document.body, { attributes: true, attributeFilter: ['data-active-tab'] })
    // Re-render the shell on language switch; reload when the tab is showing so
    // the catalog picks up the new dict too (mirrors the federation panels).
    AH.onLangChange(function () {
      buildShell(root)
      if (isActive()) load(root).catch(function () {})
    })
    if (isActive()) {
      maybeLoad(root).catch(function () {})
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
