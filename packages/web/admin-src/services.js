/* AipeHub admin — Hub Services tab (plugins / per-agent data / trash / audit).
 *
 * Extracted from main.js as the first ES-module split of the admin console
 * (P3 admin.js split, Phase 2). Factory shape mirrors admin-wf-assist.js:
 * `createServices(ma)` closes over the shared managed-agent state (it reads
 * `ma.agents` to know which owners to probe) and returns just the entry
 * points the rest of the console calls. The six render/mutate helpers stay
 * private to the closure.
 *
 * Shared utilities (t / escapeHtml / fetchJson) are pulled off the global
 * window.AipeHub namespace that app-core.js installs — same source the
 * hand-written file used, so no behavior changes.
 */

const { t, escapeHtml, fetchJson, formatBytes } = window.AipeHub

export function createServices(ma) {
  const svc = {
    plugins: [],     // [{type, impl, version, description?}]
    rows: [],        // [{type, impl, owner: {kind,id}, snapshot}]
    trash: [],       // ServiceTrashRef[]
    audit: [],       // [{ts, from, type, impl, ownerKind, ownerId, method, outcome, durationMs}]
    disabled: false, // host didn't supply services
  }

  async function refreshServices() {
    const tableEl = document.getElementById('services-table')
    const tbodyEl = document.getElementById('services-tbody')
    const emptyEl = document.getElementById('services-plugins-empty')
    const disabledEl = document.getElementById('services-disabled')
    const trashTableEl = document.getElementById('services-trash-table')
    const trashTbodyEl = document.getElementById('services-trash-tbody')
    const trashEmptyEl = document.getElementById('services-trash-empty')
    if (!tableEl || !tbodyEl) return

    // Plugin list (or 503 → disabled).
    let plugins
    try {
      const r = await fetch('/api/admin/services/plugins')
      if (r.status === 503) {
        svc.disabled = true
        disabledEl.hidden = false
        tableEl.hidden = true
        emptyEl.hidden = true
        trashTableEl.hidden = true
        trashEmptyEl.hidden = true
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      plugins = j.plugins || []
    } catch (err) {
      console.warn('services: plugins fetch failed', err)
      return
    }
    svc.disabled = false
    disabledEl.hidden = true
    svc.plugins = plugins
    if (plugins.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
    } else {
      emptyEl.hidden = true
      tableEl.hidden = false
    }

    // Per-agent snapshots. We use the cached `ma.agents` list to know
    // which owners to ask about — same agents the "Agents" tab uses.
    const rows = []
    for (const plugin of plugins) {
      for (const agent of ma.agents || []) {
        try {
          const url = `/api/admin/services/owners/${encodeURIComponent(plugin.type)}/${encodeURIComponent(plugin.impl)}/agent/${encodeURIComponent(agent.id)}`
          const r = await fetchJson(url)
          if (r.snapshot) {
            rows.push({
              type: plugin.type, impl: plugin.impl,
              owner: { kind: 'agent', id: agent.id },
              snapshot: r.snapshot,
            })
          }
        } catch (err) {
          // 404 / 500 — skip and keep going. The user sees the
          // rows that DID resolve; partial-success beats nothing.
        }
      }
    }
    svc.rows = rows
    renderServicesTable()

    // Trash list.
    try {
      const r = await fetchJson('/api/admin/services/trash')
      svc.trash = r.trash || []
      renderServicesTrash()
    } catch (err) {
      console.warn('services: trash fetch failed', err)
    }

    // SERVICE_CALL audit (v1.1 services-over-ws). Best-effort; if the
    // endpoint 503s on a v1.0-only host the table just stays hidden.
    try {
      const r = await fetchJson('/api/admin/transcript/service-calls?limit=200')
      svc.audit = r.calls || []
      renderServicesAudit()
    } catch (err) {
      console.warn('services: audit fetch failed', err)
    }
  }

  function renderServicesAudit() {
    const tableEl = document.getElementById('services-audit-table')
    const tbodyEl = document.getElementById('services-audit-tbody')
    const emptyEl = document.getElementById('services-audit-empty')
    if (!tableEl || !tbodyEl) return
    tbodyEl.innerHTML = ''
    const calls = svc.audit || []
    if (calls.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
      return
    }
    emptyEl.hidden = true
    tableEl.hidden = false
    // calls already arrive newest-first from the API.
    for (const c of calls) {
      const tr = document.createElement('tr')
      const okClass = c.outcome === 'ok' ? '' : ' bad'
      tr.className = `audit-row${okClass}`
      tr.innerHTML = `
        <td>${new Date(c.ts).toLocaleString()}</td>
        <td><code>${escapeHtml(c.from)}</code></td>
        <td><code>${escapeHtml(c.type)}:${escapeHtml(c.impl)}</code></td>
        <td>${escapeHtml(c.ownerKind)}/${escapeHtml(c.ownerId)}</td>
        <td><code>${escapeHtml(c.method)}</code></td>
        <td>${escapeHtml(c.outcome)}</td>
        <td>${c.durationMs}ms</td>
      `
      tbodyEl.appendChild(tr)
    }
  }

  function renderServicesTable() {
    const tbodyEl = document.getElementById('services-tbody')
    if (!tbodyEl) return
    tbodyEl.innerHTML = ''
    for (const row of svc.rows) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><code>${escapeHtml(row.type)}:${escapeHtml(row.impl)}</code></td>
        <td>${escapeHtml(row.owner.kind)}/${escapeHtml(row.owner.id)}</td>
        <td>${formatBytes(row.snapshot.sizeBytes)}</td>
        <td>${row.snapshot.itemCount ?? ''}</td>
        <td>${row.snapshot.lastAccess ? new Date(row.snapshot.lastAccess).toLocaleString() : ''}</td>
        <td>
          <button type="button" class="secondary-btn" data-action="detail">${escapeHtml(t.servicesDetail)}</button>
          <button type="button" class="danger-btn" data-action="delete">${escapeHtml(t.servicesDelete)}</button>
        </td>
      `
      tr.querySelector('[data-action="detail"]').addEventListener('click', () => openServicesDetail(row))
      tr.querySelector('[data-action="delete"]').addEventListener('click', () => softDeleteRow(row))
      tbodyEl.appendChild(tr)
    }
  }

  function renderServicesTrash() {
    const tableEl = document.getElementById('services-trash-table')
    const tbodyEl = document.getElementById('services-trash-tbody')
    const emptyEl = document.getElementById('services-trash-empty')
    if (!tableEl || !tbodyEl) return
    tbodyEl.innerHTML = ''
    if (svc.trash.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
      return
    }
    emptyEl.hidden = true
    tableEl.hidden = false
    for (const ref of svc.trash) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><code>${escapeHtml(ref.type)}:${escapeHtml(ref.impl)}</code></td>
        <td>${escapeHtml(ref.ownerKind)}/${escapeHtml(ref.ownerId)}</td>
        <td>${new Date(ref.deletedAt).toLocaleString()}</td>
        <td>${new Date(ref.expiresAt).toLocaleString()}</td>
        <td>${escapeHtml(ref.reason || '')}</td>
        <td>
          <button type="button" class="secondary-btn" data-action="restore">${escapeHtml(t.servicesTrashRestore)}</button>
          <button type="button" class="danger-btn" data-action="hard">${escapeHtml(t.servicesTrashHardDelete)}</button>
        </td>
      `
      tr.querySelector('[data-action="restore"]').addEventListener('click', () => restoreTrash(ref))
      tr.querySelector('[data-action="hard"]').addEventListener('click', () => hardDeleteTrash(ref))
      tbodyEl.appendChild(tr)
    }
  }

  async function softDeleteRow(row) {
    try {
      await fetchJson(`/api/admin/services/owners/${encodeURIComponent(row.type)}/${encodeURIComponent(row.impl)}/agent/${encodeURIComponent(row.owner.id)}`, {
        method: 'DELETE',
      })
      // Toast comes from the SSE event handler so we don't double-fire.
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  async function restoreTrash(ref) {
    try {
      await fetchJson(`/api/admin/services/trash/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.impl)}/${encodeURIComponent(ref.id)}/restore`, {
        method: 'POST',
      })
      showServicesToast(t.servicesToastRestored)
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  async function hardDeleteTrash(ref) {
    if (!confirm(t.servicesConfirmHardDelete)) return
    try {
      await fetchJson(`/api/admin/services/trash/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.impl)}/${encodeURIComponent(ref.id)}`, {
        method: 'DELETE',
      })
      showServicesToast(t.servicesToastHardDeleted)
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  function openServicesDetail(row) {
    const modal = document.getElementById('services-detail-modal')
    const title = document.getElementById('services-detail-title')
    const body = document.getElementById('services-detail-body')
    const img = document.getElementById('services-detail-image')
    if (!modal || !title || !body) return
    title.textContent = `${row.type}:${row.impl} — ${row.owner.kind}/${row.owner.id}`
    const p = row.snapshot.preview
    if (p && p.base64) {
      img.src = `data:${p.mime};base64,${p.base64}`
      img.alt = title.textContent
      img.hidden = false
      body.textContent = ''
    } else if (p && p.text) {
      img.hidden = true
      body.textContent = p.text + (p.truncated ? '\n… (truncated)' : '')
    } else {
      img.hidden = true
      body.textContent = `${formatBytes(row.snapshot.sizeBytes)} • ${row.snapshot.itemCount ?? 0} items`
    }
    modal.hidden = false
  }

  function closeServicesDetail() {
    const modal = document.getElementById('services-detail-modal')
    if (modal) modal.hidden = true
  }

  /**
   * Tiny ephemeral toast. Lives 4 seconds, then fades. The container
   * is lazy-created on first use so a page that never touches the
   * Services tab pays no DOM cost.
   */
  function showServicesToast(msg) {
    let container = document.getElementById('services-toast-container')
    if (!container) {
      container = document.createElement('div')
      container.id = 'services-toast-container'
      container.className = 'toast-container'
      document.body.appendChild(container)
    }
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = msg
    container.appendChild(el)
    setTimeout(() => el.classList.add('fade'), 3000)
    setTimeout(() => el.remove(), 4000)
  }

  return { refreshServices, renderServicesAudit, closeServicesDetail, showServicesToast }
}
