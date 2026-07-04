/**
 * Deterministic stand-in participants for the tea-supply-link runnable demo.
 *
 * Two hubs, two orgs:
 *   - 奶茶店 (org A) runs the restock workflow. `ShopDeskStandin` serves its two
 *     LOCAL capabilities: drafting the order and recording the supplier's reply.
 *   - 供货商 (org B) fulfills. `SupplierStandin` serves the ONE capability the
 *     shop reaches across the boundary: `supplier.confirm-order`.
 *
 * In the loadable template the shop's worker is a KB-backed `LlmAgent` (a
 * procurement assistant on DeepSeek + mcp-obsidian). Here we substitute
 * deterministic stand-ins that serve the SAME capabilities with real, assertable
 * logic — so the demo runs with no API key and the hub wiring is identical to
 * production. The supplier lives on a SEPARATE hub; in production that's another
 * org's Gotong, reached over a federation link (the link is runtime peer config,
 * never part of the template — that's the whole point of this example).
 *
 * The little price book below stands in for the supplier's own inventory /
 * pricing system the real fulfillment agent would read — it is NOT the shop's
 * KB. Money is computed DETERMINISTICALLY by the supplier (the headline reason
 * pricing is not an LLM's job, same as cafe-ops's overtime math): the assistant
 * only drafts, the supplier prices.
 */

import { AgentParticipant, type Task } from '@gotong/core'

// --- supplier-side inventory / price book (lives on org B, not in any template) ---

interface CatalogEntry {
  unitPrice: number // ¥ per unit — integers on purpose (no float money)
  unit: string
  stock: number
}

/** The supplier's catalog: what it sells, the unit price, and how much is on hand. */
const SUPPLIER_CATALOG: Record<string, CatalogEntry> = {
  珍珠: { unitPrice: 18, unit: 'kg', stock: 500 },
  红茶叶: { unitPrice: 45, unit: 'kg', stock: 200 },
  全脂牛奶: { unitPrice: 6, unit: '盒', stock: 1000 },
  果糖: { unitPrice: 12, unit: '瓶', stock: 300 },
  椰果: { unitPrice: 22, unit: 'kg', stock: 150 },
}

// --- shared shapes flowing between the steps -------------------------------------

interface OrderLine {
  item: string
  qty: number
}

interface OrderDraft {
  lines: OrderLine[]
  requestedBy?: string
  note: string
}

/**
 * Parse the low-stock list into order lines. Accepts the textarea form a member
 * submits from /me ("珍珠 20\n红茶叶 10") OR a pre-structured array — the real
 * LlmAgent would do the same normalization from free text.
 */
function parseItems(items: unknown): OrderLine[] {
  if (Array.isArray(items)) {
    return items
      .map((it) => {
        const o = (it ?? {}) as { item?: string; qty?: number }
        return { item: String(o.item ?? '').trim(), qty: typeof o.qty === 'number' ? o.qty : 0 }
      })
      .filter((l) => l.item.length > 0)
  }
  return String(items ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((line) => {
      const m = line.match(/^(.*?)\s+(\d+)\s*$/)
      if (m) return { item: m[1]!.trim(), qty: Number(m[2]) }
      return { item: line, qty: 1 }
    })
}

// --- stand-in participants -------------------------------------------------------

/**
 * 奶茶店 (org A) front desk. Serves the shop's two LOCAL capabilities:
 *   - `teashop.draft-order`  — turn the low-stock list into a purchase order draft
 *   - `teashop.record-order` — file the supplier's confirmation locally
 * It never prices anything — that's the supplier's job, across the boundary.
 */
export class ShopDeskStandin extends AgentParticipant {
  constructor() {
    super({ id: 'shop-desk', capabilities: ['teashop.draft-order', 'teashop.record-order'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
    if (cap === 'teashop.record-order') return this.recordOrder(task)
    return this.draftOrder(task)
  }

  private draftOrder(task: Task): OrderDraft {
    const { items, requested_by } = (task.payload ?? {}) as { items?: unknown; requested_by?: string }
    const lines = parseItems(items)
    return {
      lines,
      requestedBy: requested_by,
      note: `补货单已起草:${lines.length} 项物料,待向供货商确认价格与货期。`,
    }
  }

  private recordOrder(task: Task): unknown {
    const { order, confirmation } = (task.payload ?? {}) as {
      order?: OrderDraft
      confirmation?: { total?: number; etaDays?: number; allAvailable?: boolean }
    }
    const lineCount = order?.lines?.length ?? 0
    const total = confirmation?.total ?? 0
    // Deterministic PO id from the order shape so the demo is assertable.
    const po = `PO-${lineCount}L-${total}`
    return {
      recorded: true,
      po,
      lineCount,
      total,
      etaDays: confirmation?.etaDays ?? 0,
      allAvailable: confirmation?.allAvailable ?? false,
      requestedBy: order?.requestedBy,
      note: `已建档采购单 ${po}:${lineCount} 项,合计 ¥${total}。`,
    }
  }
}

/**
 * 供货商 (org B) fulfillment desk. Serves the ONE capability the shop reaches
 * across the federation boundary: `supplier.confirm-order`. Prices each line off
 * its own catalog, checks stock, and returns a confirmation with a total + ETA.
 * This runs on a SEPARATE hub — the only thing org A knows is the capability name.
 */
export class SupplierStandin extends AgentParticipant {
  /** Records the orders that actually crossed the boundary (so the demo can assert "0 before approval"). */
  readonly confirmed: Task[] = []

  constructor() {
    super({ id: 'supplier-fulfillment', capabilities: ['supplier.confirm-order'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    this.confirmed.push(task)
    const order = ((task.payload ?? {}) as { order?: OrderDraft }).order ?? { lines: [], note: '' }
    const lines = (order.lines ?? []).map((l) => {
      const entry = SUPPLIER_CATALOG[l.item]
      if (!entry) {
        return { item: l.item, qty: l.qty, unitPrice: 0, available: false, lineTotal: 0, note: '未在供货目录' }
      }
      const available = l.qty <= entry.stock
      return {
        item: l.item,
        qty: l.qty,
        unit: entry.unit,
        unitPrice: entry.unitPrice,
        available,
        lineTotal: available ? entry.unitPrice * l.qty : 0,
      }
    })
    const total = lines.reduce((sum, l) => sum + l.lineTotal, 0)
    const allAvailable = lines.length > 0 && lines.every((l) => l.available)
    return {
      lines,
      total,
      currency: '¥',
      etaDays: allAvailable ? 2 : 5,
      allAvailable,
      supplierNote: allAvailable
        ? `全部有货,合计 ¥${total},预计 2 天到货。`
        : `部分缺货,可供部分合计 ¥${total},预计 5 天补齐。`,
    }
  }
}
