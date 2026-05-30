/* AipeHub admin — MCP integration tab (#2-M4).
 *
 * Hub-level MCP server registry. Install an external MCP server here and
 * any agent that opts in by name (`useMcpServers`, set on its Edit form)
 * gets that server's tools — at spawn, or live for an already-running
 * agent (M2 propagation). This tab is the "5-minute, no-code" entry point:
 * list / install / uninstall, no YAML.
 *
 * Factory mirrors services.js: createMcp() closes over its own little
 * state bag and returns just the entry points main.js wires (refreshMcp +
 * the form submit + the transport-field toggle). Shared helpers come off
 * the window.AipeHub namespace that app-core.js installs.
 */

const { t, escapeHtml, fetchJson } = window.AipeHub

export function createMcp() {
  const mcp = {
    servers: [],     // HubMcpServerRecord[] — [{ spec, createdAt, description? }]
    disabled: false, // host didn't wire the registry surface (GET → 503)
  }

  async function refreshMcp() {
    const tableEl = document.getElementById('mcp-table')
    const tbodyEl = document.getElementById('mcp-tbody')
    const emptyEl = document.getElementById('mcp-empty')
    const disabledEl = document.getElementById('mcp-disabled')
    if (!tableEl || !tbodyEl) return

    let servers
    try {
      const r = await fetch('/api/admin/mcp-servers')
      if (r.status === 503) {
        // Registry not enabled on this host — hide everything but the note.
        mcp.disabled = true
        if (disabledEl) disabledEl.hidden = false
        tableEl.hidden = true
        if (emptyEl) emptyEl.hidden = true
        const form = document.getElementById('mcp-form')
        if (form) form.hidden = true
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      servers = j.servers || []
    } catch (err) {
      console.warn('mcp: list fetch failed', err)
      return
    }
    mcp.disabled = false
    if (disabledEl) disabledEl.hidden = true
    mcp.servers = servers
    if (servers.length === 0) {
      tableEl.hidden = true
      if (emptyEl) emptyEl.hidden = false
    } else {
      if (emptyEl) emptyEl.hidden = true
      tableEl.hidden = false
    }
    renderMcpTable()
  }

  // stdio is the implicit transport when none is declared (R4 union).
  function transportOf(spec) {
    return spec.transport || 'stdio'
  }

  // One-line "what does this connect to" for the table.
  function targetOf(spec) {
    if (transportOf(spec) === 'stdio') {
      const args = Array.isArray(spec.args) ? spec.args.join(' ') : ''
      return `${spec.command || ''}${args ? ' ' + args : ''}`.trim()
    }
    return spec.url || ''
  }

  function renderMcpTable() {
    const tbodyEl = document.getElementById('mcp-tbody')
    if (!tbodyEl) return
    tbodyEl.innerHTML = ''
    for (const rec of mcp.servers) {
      const spec = rec.spec || {}
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><code>${escapeHtml(spec.name || '')}</code></td>
        <td>${escapeHtml(transportOf(spec))}</td>
        <td><code>${escapeHtml(targetOf(spec))}</code></td>
        <td>${escapeHtml(rec.description || '')}</td>
        <td class="mcp-share-cell"><label><input type="checkbox" data-action="share"${rec.shared ? ' checked' : ''} title="${escapeHtml(t.mcpSharedHint)}" /></label></td>
        <td><button type="button" class="danger-btn" data-action="uninstall">${escapeHtml(t.mcpUninstall)}</button></td>
      `
      tr.querySelector('[data-action="share"]').addEventListener('change', (e) => setShared(rec, e.target))
      tr.querySelector('[data-action="uninstall"]').addEventListener('click', () => uninstallServer(spec.name))
      tbodyEl.appendChild(tr)
    }
  }

  // Flip the cross-hub federation flag (#2-M3.4a). POST is upsert, so we
  // re-send the stored spec/description and only `shared` changes; the
  // server preserves createdAt. Optimistic toggle, revert on failure.
  async function setShared(rec, checkboxEl) {
    const next = checkboxEl.checked
    checkboxEl.disabled = true
    try {
      await fetchJson('/api/admin/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spec: rec.spec,
          ...(rec.description ? { description: rec.description } : {}),
          shared: next,
        }),
      })
      rec.shared = next // keep the local model in sync without a full re-render
    } catch (err) {
      checkboxEl.checked = !next
      alert(t.failedAlert(err?.message || String(err)))
    } finally {
      checkboxEl.disabled = false
    }
  }

  async function uninstallServer(name) {
    if (!name) return
    if (!confirm(t.mcpConfirmUninstall(name))) return
    try {
      await fetchJson(`/api/admin/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshMcp()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  // "KEY=value" lines → { KEY: value } (or undefined when empty). Split on
  // the FIRST '=' so values may themselves contain '=' (e.g. a base64 token
  // or a `${ENV}` ref). Blank / key-less lines are skipped, not errors.
  function parseKvLines(text) {
    const out = {}
    for (const raw of (text || '').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      if (k) out[k] = v
    }
    return Object.keys(out).length ? out : undefined
  }

  // Build the union-shaped spec from the form, POST it, refresh on success.
  // Server-side validateMcpServersArray is the source of truth — we only
  // shape the object; a bad spec comes back as a 400 we surface inline.
  async function submitMcpForm(e) {
    e.preventDefault()
    const msgEl = document.getElementById('mcp-form-msg')
    if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('ok', 'err') }

    const name = document.getElementById('mcp-name').value.trim()
    const transport = document.getElementById('mcp-transport').value
    const description = document.getElementById('mcp-desc').value.trim() || undefined

    let spec
    if (transport === 'http' || transport === 'sse') {
      const url = document.getElementById('mcp-url').value.trim()
      const headers = parseKvLines(document.getElementById('mcp-headers').value)
      spec = { name, transport, url }
      if (headers) spec.headers = headers
    } else {
      const command = document.getElementById('mcp-command').value.trim()
      const argsRaw = document.getElementById('mcp-args').value.trim()
      const env = parseKvLines(document.getElementById('mcp-env').value)
      // transport omitted → stdio (terse form stays the default).
      spec = { name, command }
      if (argsRaw) spec.args = argsRaw.split(/\s+/)
      if (env) spec.env = env
    }

    try {
      await fetchJson('/api/admin/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec, description }),
      })
      if (msgEl) { msgEl.textContent = t.mcpInstalled; msgEl.classList.add('ok') }
      const form = document.getElementById('mcp-form')
      if (form) form.reset()
      syncMcpTransportFields()
      await refreshMcp()
    } catch (err) {
      if (msgEl) { msgEl.textContent = err?.message || String(err); msgEl.classList.add('err') }
    }
  }

  // Show the stdio field group vs the remote (http/sse) group based on the
  // transport <select>. Called on change + after a successful install reset.
  function syncMcpTransportFields() {
    const sel = document.getElementById('mcp-transport')
    if (!sel) return
    const remote = sel.value === 'http' || sel.value === 'sse'
    document.querySelectorAll('.mcp-stdio-only').forEach((el) => { el.hidden = remote })
    document.querySelectorAll('.mcp-remote-only').forEach((el) => { el.hidden = !remote })
  }

  return { refreshMcp, submitMcpForm, syncMcpTransportFields, state: mcp }
}
