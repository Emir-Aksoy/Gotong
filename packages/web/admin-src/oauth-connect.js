/* Gotong admin — 连接现实生活 tab (C-M2-M5c).
 *
 * The "用 X 登录" front door for the C-track. Browse the built-in outbound
 * OAuth connector directory (Google 日历 / Gmail), fill your own registered
 * OAuth app's three fields (client_id / client_secret / redirect), and connect:
 * the panel creates the OAuth connector (POST /connectors) + its linked hosted
 * MCP server (POST /mcp-servers), then kicks the browser to the provider's
 * consent screen (POST /oauth/start → authorize URL). The provider redirects
 * back to /api/oauth/callback which bounces to /?oauth_connected=<id>; this tab
 * surfaces that on load.
 *
 * Mirrors mcp.js: a factory closing over its own state bag, returning just the
 * entry points main.js wires (refreshOAuth + the on-load banner check). Shared
 * helpers come off window.Gotong. The confidential client_secret only ever
 * travels UP (write-only); the connector list never returns it.
 */

const { t, escapeHtml, fetchJson } = window.Gotong

export function createOAuthConnect() {
  const oauth = {
    connectors: [], // OAuthConnectorView[] — never carries the secret/token
    catalog: null, // built-in presets, cached after first fetch
    disabled: false, // host didn't wire the connector store (GET → 503)
  }

  async function refreshOAuth() {
    const tableEl = document.getElementById('reallife-table')
    const tbodyEl = document.getElementById('reallife-tbody')
    const emptyEl = document.getElementById('reallife-empty')
    const disabledEl = document.getElementById('reallife-disabled')
    if (!tableEl || !tbodyEl) return

    let connectors
    try {
      const r = await fetch('/api/admin/oauth/connectors')
      if (r.status === 503) {
        // No identity store on this host — nothing to connect into. Hide the
        // table + directory, show the note. (The catalog route never 503s, but
        // there's nowhere to install a preset, so we hide it too.)
        oauth.disabled = true
        if (disabledEl) disabledEl.hidden = false
        tableEl.hidden = true
        if (emptyEl) emptyEl.hidden = true
        const dirEl = document.getElementById('reallife-directory')
        if (dirEl) dirEl.hidden = true
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      connectors = j.connectors || []
    } catch (err) {
      console.warn('reallife: connector list fetch failed', err)
      return
    }
    oauth.disabled = false
    if (disabledEl) disabledEl.hidden = true
    oauth.connectors = connectors
    if (connectors.length === 0) {
      tableEl.hidden = true
      if (emptyEl) emptyEl.hidden = false
    } else {
      if (emptyEl) emptyEl.hidden = true
      tableEl.hidden = false
    }
    renderConnectorTable()
    // Directory badges depend on the list we just fetched (installed vs not).
    refreshCatalog().catch((err) => console.warn('reallife: catalog refresh failed', err))
  }

  // —— installed connectors table (connect / disconnect / remove) ——
  function renderConnectorTable() {
    const tbodyEl = document.getElementById('reallife-tbody')
    if (!tbodyEl) return
    tbodyEl.innerHTML = ''
    for (const c of oauth.connectors) {
      const tr = document.createElement('tr')
      const status = c.connected
        ? `<span class="reallife-ok">${escapeHtml(t.reallifeConnected)}${expiryHint(c)}</span>`
        : `<span class="reallife-off">${escapeHtml(t.reallifeNotConnected)}</span>`
      // First connect vs re-consent read the same on the wire (POST /start).
      const connectLabel = c.connected ? t.reallifeReconnect : t.reallifeConnect
      tr.innerHTML = `
        <td><strong>${escapeHtml(c.displayName || c.id)}</strong><br /><code>${escapeHtml(c.id)}</code></td>
        <td><code>${escapeHtml(c.mcpServerName || '')}</code></td>
        <td class="reallife-scope"><code>${escapeHtml(c.scope || '')}</code></td>
        <td>${status}</td>
        <td class="reallife-actions">
          <button type="button" class="mcp-card-install" data-action="connect">${escapeHtml(connectLabel)}</button>
          <button type="button" data-action="disconnect"${c.connected ? '' : ' disabled'}>${escapeHtml(t.reallifeDisconnect)}</button>
          <button type="button" class="danger-btn" data-action="remove">${escapeHtml(t.reallifeRemove)}</button>
        </td>
      `
      tr.querySelector('[data-action="connect"]').addEventListener('click', () => startConnect(c.id))
      tr.querySelector('[data-action="disconnect"]').addEventListener('click', () => disconnect(c.id))
      tr.querySelector('[data-action="remove"]').addEventListener('click', () => removeConnector(c))
      tbodyEl.appendChild(tr)
    }
  }

  function expiryHint(c) {
    if (typeof c.accessTokenExpiresAt !== 'number') return ''
    const mins = Math.round((c.accessTokenExpiresAt - Date.now()) / 60000)
    if (!Number.isFinite(mins)) return ''
    return ` <span class="reallife-expiry">${escapeHtml(t.reallifeExpiryMins(mins))}</span>`
  }

  // —— built-in preset directory (browse + connect) ——
  async function refreshCatalog() {
    const sectionEl = document.getElementById('reallife-directory')
    if (!sectionEl) return
    if (oauth.disabled) { sectionEl.hidden = true; return }
    if (!oauth.catalog) {
      try {
        const j = await fetchJson('/api/admin/oauth/catalog')
        oauth.catalog = j.connectors || []
      } catch (err) {
        console.warn('reallife: catalog fetch failed', err)
        sectionEl.hidden = true
        return
      }
    }
    sectionEl.hidden = false
    renderCatalogCards()
  }

  function renderCatalogCards() {
    const cardsEl = document.getElementById('reallife-cards')
    if (!cardsEl) return
    const installed = new Set(oauth.connectors.map((c) => c.id))
    cardsEl.innerHTML = ''
    for (const preset of oauth.catalog || []) {
      const isInstalled = installed.has(preset.id)
      const catLabel = (t.reallifeCat && t.reallifeCat[preset.category]) || preset.category
      const home = preset.homepage
        ? `<a class="mcp-card-home" href="${escapeHtml(preset.homepage)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.mcpDirHomepage)}</a>`
        : ''
      const card = document.createElement('div')
      card.className = 'mcp-card'
      const foot = isInstalled
        ? `<span class="mcp-card-installed">${escapeHtml(t.reallifeAdded)}</span>`
        : `<button type="button" class="mcp-card-install" data-action="reveal">${escapeHtml(t.reallifeConnect)}</button>`
      // The credential form is inline + hidden until "连接" is clicked (mirrors
      // the stdio/remote field toggle in mcp.js). redirect prefilled with this
      // hub's callback so the admin registers the same URL at the provider.
      card.innerHTML = `
        <div class="mcp-card-head">
          <strong class="mcp-card-name">${escapeHtml(preset.name)}</strong>
          <span class="mcp-cat-badge">${escapeHtml(catLabel)}</span>
        </div>
        <p class="mcp-card-what">${escapeHtml(preset.whatFor)}</p>
        <div class="mcp-card-foot">${home}${foot}</div>
        <form class="reallife-connect-form" hidden>
          <label><span>${escapeHtml(t.reallifeClientId)}</span>
            <input type="text" autocomplete="off" data-field="clientId" required /></label>
          <label><span>${escapeHtml(t.reallifeClientSecret)}</span>
            <input type="password" autocomplete="off" data-field="clientSecret" required /></label>
          <label><span>${escapeHtml(t.reallifeRedirect)}</span>
            <input type="url" autocomplete="off" data-field="redirectUri" required /></label>
          <p class="reallife-card-msg form-msg" aria-live="polite"></p>
          <button type="submit" class="mcp-card-install">${escapeHtml(t.reallifeConnectBtn(preset.name))}</button>
        </form>
      `
      if (!isInstalled) {
        const form = card.querySelector('.reallife-connect-form')
        const redirectInput = form.querySelector('[data-field="redirectUri"]')
        redirectInput.value = `${window.location.origin}/api/oauth/callback`
        card.querySelector('[data-action="reveal"]').addEventListener('click', (e) => {
          e.target.hidden = true
          form.hidden = false
          form.querySelector('[data-field="clientId"]').focus()
        })
        form.addEventListener('submit', (e) => connectPreset(e, preset, form))
      }
      cardsEl.appendChild(card)
    }
  }

  // Create the connector + its linked hosted MCP server, then kick off consent.
  // Order matters: the connector first (it's the thing /start needs), then the
  // MCP server (best-effort — a duplicate name is fine, the registry upserts).
  async function connectPreset(e, preset, form) {
    e.preventDefault()
    const msgEl = form.querySelector('.reallife-card-msg')
    if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('ok', 'err') }
    const val = (f) => form.querySelector(`[data-field="${f}"]`).value.trim()
    const clientId = val('clientId')
    const clientSecret = val('clientSecret')
    const redirectUri = val('redirectUri')
    if (!clientId || !clientSecret || !redirectUri) return

    try {
      // 1) the OAuth connector — endpoints/scope/refresh params baked from the
      //    preset; mcpServerName = the linked server's name (M4a linkage key).
      await fetchJson('/api/admin/oauth/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: preset.id,
          displayName: preset.name,
          authorizationEndpoint: preset.authorizationEndpoint,
          tokenEndpoint: preset.tokenEndpoint,
          clientId,
          clientSecret,
          redirectUri,
          scope: preset.scope,
          extraAuthParams: preset.extraAuthParams || null,
          mcpServerName: preset.mcpServer.name,
        }),
      })
      // 2) the linked hosted MCP server (bearer header carries the fixed
      //    ${OAUTH_ACCESS_TOKEN} ref; M4a fills it from this connector's token).
      await fetchJson('/api/admin/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: preset.mcpServer, description: preset.whatFor }),
      })
    } catch (err) {
      if (msgEl) { msgEl.textContent = err?.message || String(err); msgEl.classList.add('err') }
      return
    }
    // 3) consent — navigate the top window to the provider's authorize URL.
    await startConnect(preset.id, msgEl)
  }

  // POST /start → { authorizationUrl } → navigate. Shared by the table's
  // connect/reconnect buttons and the just-created preset above.
  async function startConnect(connectorId, msgEl) {
    try {
      const j = await fetchJson('/api/admin/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId }),
      })
      if (j.authorizationUrl) {
        window.location.assign(j.authorizationUrl)
        return
      }
      throw new Error('no authorization url')
    } catch (err) {
      if (msgEl) { msgEl.textContent = err?.message || String(err); msgEl.classList.add('err') }
      else alert(t.failedAlert(err?.message || String(err)))
    }
  }

  async function disconnect(connectorId) {
    try {
      await fetchJson(`/api/admin/oauth/connectors/${encodeURIComponent(connectorId)}/disconnect`, { method: 'POST' })
      await refreshOAuth()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  // Remove tears down BOTH halves the connect flow created: the connector and
  // its linked MCP server (best-effort on the latter — a 404 is fine).
  async function removeConnector(c) {
    if (!confirm(t.reallifeConfirmRemove(c.displayName || c.id))) return
    try {
      await fetchJson(`/api/admin/oauth/connectors/${encodeURIComponent(c.id)}`, { method: 'DELETE' })
      if (c.mcpServerName) {
        await fetch(`/api/admin/mcp-servers/${encodeURIComponent(c.mcpServerName)}`, { method: 'DELETE' }).catch(() => {})
      }
      await refreshOAuth()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  // On-load banner: the callback bounced back with ?oauth_connected / ?oauth_error.
  // Surface it once, then strip the query so a refresh doesn't re-announce.
  function checkConnectBanner() {
    const bannerEl = document.getElementById('reallife-banner')
    if (!bannerEl) return
    const params = new URLSearchParams(window.location.search)
    const ok = params.get('oauth_connected')
    const err = params.get('oauth_error')
    if (!ok && !err) return
    bannerEl.hidden = false
    bannerEl.classList.remove('ok', 'err')
    if (ok) {
      bannerEl.textContent = t.reallifeConnectedBanner(ok)
      bannerEl.classList.add('ok')
    } else {
      bannerEl.textContent = t.reallifeErrorBanner(err)
      bannerEl.classList.add('err')
    }
    params.delete('oauth_connected')
    params.delete('oauth_error')
    const qs = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`)
  }

  return { refreshOAuth, checkConnectBanner, state: oauth }
}
