/**
 * Deterministic stand-in participants for the tea-chain-hq runnable demo.
 *
 * Two hubs, two orgs — and the orchestration runs DOWNWARD (the mirror of
 * tea-supply-link, which ran upward shop→supplier):
 *   - 连锁总部 (org A) runs the directive-rollout workflow. `HqDeskStandin` serves
 *     its two LOCAL capabilities: drafting the directive and recording the shop's
 *     acknowledgment.
 *   - 加盟门店 (org B) executes. `ShopStandin` serves the ONE capability the HQ
 *     reaches across the boundary: `shop.apply-directive`.
 *
 * In the loadable template the HQ's worker is a KB-backed `LlmAgent` (a rollout
 * coordinator on DeepSeek + mcp-obsidian). Here we substitute deterministic
 * stand-ins that serve the SAME capabilities with real, assertable logic — so the
 * demo runs with no API key and the hub wiring is identical to production. The
 * shop lives on a SEPARATE hub; in production that's a franchisee's own Gotong,
 * reached over a federation link (the link is runtime peer config, never part of
 * the template — that's the whole point of this example).
 *
 * The little shop menu below stands in for the franchise's own POS / menu the
 * real shop agent would read — it is NOT the HQ's KB. The price delta is computed
 * DETERMINISTICALLY by the shop applying the directive against its own menu (the
 * shop owns its current prices; HQ proposes, the shop applies and reports back).
 */

import { AgentParticipant, type Task } from '@gotong/core'

// --- the directive that flows HQ → shop -----------------------------------------

interface Directive {
  type?: string
  sku?: string
  newPrice?: number
  effective?: string
  note?: string
}

// --- franchise-side menu (lives on org B, not in any template) ------------------

/** The shop's current menu prices (¥). The shop owns these; the directive proposes a change. */
const SHOP_MENU: Record<string, number> = {
  珍珠奶茶: 14,
  红豆奶茶: 15,
  椰果奶绿: 13,
}

// --- stand-in participants -------------------------------------------------------

/**
 * 连锁总部 (org A) rollout desk. Serves HQ's two LOCAL capabilities:
 *   - `chainhq.draft-directive`  — turn the operator's input into a directive doc
 *   - `chainhq.record-rollout`   — file the shop's acknowledgment locally
 * It does not apply anything to a shop — that crosses the boundary to the shop.
 */
export class HqDeskStandin extends AgentParticipant {
  constructor() {
    super({ id: 'rollout-coordinator', capabilities: ['chainhq.draft-directive', 'chainhq.record-rollout'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
    if (cap === 'chainhq.record-rollout') return this.recordRollout(task)
    return this.draftDirective(task)
  }

  private draftDirective(task: Task): unknown {
    const { sku, new_price, effective, note } = (task.payload ?? {}) as {
      sku?: string
      new_price?: number
      effective?: string
      note?: string
    }
    const directive: Directive = {
      type: 'price-change',
      sku,
      newPrice: typeof new_price === 'number' ? new_price : undefined,
      effective,
      note,
    }
    return { directive, note: `下发单已起草: ${sku} → ¥${directive.newPrice} (${effective} 生效), 待区域经理批准外发。` }
  }

  private recordRollout(task: Task): unknown {
    const { directive, ack } = (task.payload ?? {}) as {
      directive?: Directive
      ack?: { applied?: boolean; delta?: number; effectiveDate?: string; shopId?: string }
    }
    // Deterministic directive id from the directive shape so the demo is assertable.
    const directiveId = `DIR-${directive?.sku}-${directive?.newPrice}`
    return {
      rolledOut: ack?.applied ?? false,
      directiveId,
      sku: directive?.sku,
      delta: ack?.delta ?? 0,
      shopId: ack?.shopId,
      shopAck: ack,
      note: `已建档下发记录 ${directiveId}: 门店 ${ack?.shopId ?? '?'} ${ack?.applied ? '已应用' : '未应用'}。`,
    }
  }
}

/**
 * 加盟门店 (org B) execution desk. Serves the ONE capability HQ reaches across the
 * federation boundary: `shop.apply-directive`. Applies the directive against its
 * OWN menu (it owns its current prices), computes the delta, and acks with an
 * effective date. This runs on a SEPARATE hub — the only thing HQ knows is the
 * capability name.
 */
export class ShopStandin extends AgentParticipant {
  /** Records the directives that actually crossed the boundary (so the demo can assert "0 before approval"). */
  readonly applied: Task[] = []

  constructor() {
    super({ id: 'franchise-shop', capabilities: ['shop.apply-directive'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    this.applied.push(task)
    const directive = ((task.payload ?? {}) as { directive?: Directive }).directive ?? {}
    const sku = directive.sku ?? ''
    const oldPrice = SHOP_MENU[sku]
    if (oldPrice === undefined) {
      return { applied: false, sku, reason: '该商品不在本店菜单', shopId: 'shop-001' }
    }
    const newPrice = typeof directive.newPrice === 'number' ? directive.newPrice : oldPrice
    return {
      applied: true,
      sku,
      oldPrice,
      newPrice,
      delta: newPrice - oldPrice,
      effectiveDate: directive.effective,
      shopId: 'shop-001',
      shopNote: `已接受调价: ${sku} ¥${oldPrice} → ¥${newPrice} (${directive.effective} 生效)。`,
    }
  }
}
