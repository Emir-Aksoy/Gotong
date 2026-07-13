/**
 * graded-trust — 一条边的信任是长出来的,审批摩擦随它变.
 *
 * 分级信任 track(GT)的 capstone。北极星第 2 层「跨组织协作」要 scale 到公网,就不能
 * 「连了 = 全信 / 没连 = 全不信」二元一刀切。GT 把这条本就连续的信任光谱**如实建模**成
 * 四档 T0-T3,再用一张「动作风险 × 档」矩阵当**注意力节流器**:人只在「低信任 × 高危」
 * 的少数格子里被打扰,其余交给档位预设自动裁决。这条链已整条落地——M1 纯核矩阵 → M2
 * fail-closed 地板 → M3 落库 + 面板 → M4 纯软连接 → M5 引荐 → M6/M7 上 wire 规范。缺的是
 * 把它们串成一个故事:一条边从陌生到信任,同一个动作的审批重量怎么随档一路变轻——就是
 * 这个 demo。
 *
 * 全程确定性、零网络、零 API key、零 LLM。底下是真的框架件:
 *   - 真 @gotong/core 的 `decideTrust`(矩阵裁决)、`decisionRequiresHuman`(分流)、
 *     `suggestTierFromIdentity`(纯软连接建议)、`suggestTierFromReferral`(引荐建议)、
 *     `DEFAULT_TRUST_TIER`(地板)。全是生产纯函数,这个 demo 一行没重写它们。
 *
 * 这个 demo 端到端证的事(GT 的四条不可破边界都看得见):
 *
 *   [幕1] 新 peer 落地板 T1(fail-closed):一条刚握手的边默认落 `DEFAULT_TRUST_TIER`=T1,
 *         矩阵在 T1 上对每个动作都要人——这就是「默认拒绝、步步审批」的安全地板.
 *   [幕2] PIN 验证 → 建议升 T2(纯软连接,岔口 3):owner PIN 了对端签名钥、复验 pin_verified,
 *         `suggestTierFromIdentity` 建议升 T2——但**建议 ≠ 自动升**:owner 点头前,生效档仍是
 *         T1、矩阵仍按 T1 裁决。owner 确认后才落 T2,同一个动作的审批**这才**变轻.
 *   [幕3] owner 显式提升 T3(信任伙伴):矩阵摩擦进一步降——但**信任只降摩擦,永不去掉
 *         确认底线**:最危险的动作(付款)即使对 T3 仍要「成员一键确认」留痕,绝不静默自动;
 *         forbidden 任何档恒拒;T0 任何动作恒拒.
 *   [幕4] 引荐建立初始档(信任不传递,岔口 4):现在 T3 的伙伴引荐一个全新 hub-Z,
 *         `suggestTierFromReferral` 建议的初始档是**地板 T1 而非 T3**——哪怕引荐人是我给的
 *         最高档,信任也传不过来;而一个不够格(< T2)的引荐人,其引荐根本不产出信号.
 *
 * 四条边界在这里都看得见:
 *   ① 热路径零 LLM:每一格裁决全靠纯函数查矩阵 + 比档位,零模型调用.
 *   ② fail-closed 地板:新边默认 T1、未知动作/未知档一律 deny——不因不认识而放行.
 *   ③ 纯软连接:身份确证 / 引荐都只产出 owner 面板上的**建议**,升降档永远是人点头的另一步.
 *   ④ 声明 ≠ 信任:信任的根锚在 owner 亲手做的 PIN / 提升,不在任何自报数据(wire 侧的
 *      「声明买不过认证」由 transport-ws 的 GT-M6 单测另证,这里证的是「建议买不过 owner」).
 *
 * Run:  pnpm demo:graded-trust
 */

import {
  decideTrust,
  decisionRequiresHuman,
  suggestTierFromIdentity,
  suggestTierFromReferral,
  DEFAULT_TRUST_TIER,
  TRUST_TIER_CODENAMES,
  type TrustTier,
  type OutboundActionRisk,
  type TrustDecision,
} from '@gotong/core'

// ── 一条 mesh 边的最小模型 ───────────────────────────────────────────────────
// 真实里 trustTier 落在 identity 的 peers 表(GT-M3 schema v37);这里用一个纯内存
// 对象代表「owner 对这条边打的档」。它只被 owner 的显式动作改写(applyTier),
// 任何 advisory 建议都碰不到它——这正是「纯软连接」的形状.
interface PeerEdge {
  peerId: string
  tier: TrustTier
}

// 三个贯穿全程的出站动作,风险类各异。同一组动作在每一幕重新裁决,看审批重量怎么变.
const ACTIONS: ReadonlyArray<{ label: string; risk: OutboundActionRisk }> = [
  { label: '查看对端是否在线（inspect）', risk: 'read_only' },
  { label: '读取共享日历（读类 capability）', risk: 'benign' },
  { label: '替我付款 200 元（花钱／对外）', risk: 'dangerous' },
  { label: '调用未授权的能力', risk: 'forbidden' },
]

// 裁决的中文说法(演示叙事用;真实 i18n 在 web 层,core 只给稳定代号).
const DECISION_ZH: Readonly<Record<TrustDecision, string>> = {
  auto: '自动放行（零打扰）',
  member_notify: '成员一键确认（最轻，留痕可追责）',
  member_approve: '成员审批（web 式，重）',
  owner_approve: 'owner 审批（最重，高敏）',
  deny: '拒绝',
}

/**
 * 「审批路径」的入口:给定一条边 + 一个出站动作,矩阵裁决该走哪种确认。
 * 这就是 GT 把 decideTrust 接进审批闸的形状——host 的 outbound-approval 用的是
 * 同一个纯函数。返回值同时带「要不要人介入」的分流(decisionRequiresHuman).
 */
function evaluateOutbound(
  edge: PeerEdge,
  action: { label: string; risk: OutboundActionRisk },
): { decision: TrustDecision; needsHuman: boolean } {
  const decision = decideTrust(edge.tier, action.risk)
  return { decision, needsHuman: decisionRequiresHuman(decision) }
}

/** 打印当前边对全部动作的裁决表(一幕一张,看阈值随档变). */
function showMatrix(edge: PeerEdge): void {
  console.log(
    `  当前边 ${edge.peerId} 档位 = ${edge.tier}（${TRUST_TIER_CODENAMES[edge.tier]}）—— 逐动作裁决:`,
  )
  for (const a of ACTIONS) {
    const { decision } = evaluateOutbound(edge, a)
    console.log(`    · ${a.label.padEnd(24)} → ${DECISION_ZH[decision]}`)
  }
}

/** owner 的显式动作:落档。这是**唯一**能改 edge.tier 的路径(建议永远碰不到它). */
function applyTier(edge: PeerEdge, to: TrustTier, why: string): void {
  const from = edge.tier
  edge.tier = to
  console.log(`  ★ owner 落档:${from} → ${to}（${why}）`)
}

async function main(): Promise<void> {
  console.log('\n═══ graded-trust — 一条边的信任是长出来的,审批摩擦随它变 ═══')
  console.log('（真 @gotong/core decideTrust / suggestTierFrom* 纯函数;零网络零 key 零 LLM）')

  // 一条刚跟对端 hub-B 完成 token 握手的新边.
  const edge: PeerEdge = { peerId: 'hub-B', tier: DEFAULT_TRUST_TIER }

  // ── 幕 1:新 peer 落地板 T1(fail-closed) ─────────────────────────────────
  section('幕 1 — 新 peer 落地板 T1（fail-closed:默认拒绝、步步审批）')
  assert(edge.tier === 'T1', `新边默认落 DEFAULT_TRUST_TIER = T1,实际 ${edge.tier}`)
  showMatrix(edge)
  {
    const readOnly = evaluateOutbound(edge, ACTIONS[0]!)
    const benign = evaluateOutbound(edge, ACTIONS[1]!)
    const dangerous = evaluateOutbound(edge, ACTIONS[2]!)
    const forbidden = evaluateOutbound(edge, ACTIONS[3]!)
    assert(readOnly.needsHuman && readOnly.decision === 'member_notify', 'T1 只读:要人(成员一键)')
    assert(benign.decision === 'member_approve', 'T1 benign:成员审批(重)')
    assert(dangerous.decision === 'owner_approve', 'T1 危险:owner 审批(最重)')
    assert(forbidden.decision === 'deny', 'T1 forbidden:拒(任何档都拒)')
    console.log('  ↳ 陌生边地板:除 forbidden 直接拒,其余动作**全要人**——安全性拉满,易用性最低.')
  }

  // ── 幕 2:PIN 验证 → 建议升 T2(纯软连接;建议 ≠ 自动升) ───────────────────
  section('幕 2 — owner PIN 了签名钥,复验 pin_verified → 建议升 T2(但建议 ≠ 自动升)')
  const suggestion = suggestTierFromIdentity(edge.tier, 'pin_verified')
  assert(suggestion !== null, 'pin_verified 且当前 < T2 → 有一条升档建议')
  assert(
    suggestion!.kind === 'upgrade' && suggestion!.to === 'T2' && suggestion!.reason === 'pin_verified',
    `建议是「升到 T2、因 pin_verified」,实际 ${JSON.stringify(suggestion)}`,
  )
  console.log(`  面板提示 owner:「身份已验证,建议把 ${edge.peerId} 从 ${suggestion!.from} 升到 ${suggestion!.to}」`)
  // 关键:此刻**还没点头**。生效档仍是 T1,矩阵仍按 T1 裁决——建议碰不到 edge.tier.
  assert(edge.tier === 'T1', '收到建议但 owner 未点头:生效档仍是 T1(建议不自动改档)')
  {
    const benignBefore = evaluateOutbound(edge, ACTIONS[1]!)
    assert(benignBefore.decision === 'member_approve', '未点头前:读日历仍按 T1 = 成员审批(重)')
    console.log('  ↳ 建议在,档没变:读日历此刻仍是「成员审批」——纯软连接铁律,升降档是人的决定.')
  }
  // owner 点头 → 这才落 T2.
  applyTier(edge, suggestion!.to, '接受身份验证建议')
  showMatrix(edge)
  {
    const readOnly = evaluateOutbound(edge, ACTIONS[0]!)
    const benignAfter = evaluateOutbound(edge, ACTIONS[1]!)
    assert(readOnly.decision === 'auto', 'T2 只读:自动放行(从 T1 的成员一键降到零打扰)')
    assert(benignAfter.decision === 'member_notify', 'T2 读日历:成员一键(从 T1 的成员审批变轻)')
    console.log('  ↳ 落 T2 后,同一个「读日历」审批从 member_approve → member_notify:阈值随档变轻了.')
  }

  // ── 幕 3:owner 显式提升 T3(信任伙伴;但底线不塌) ─────────────────────────
  section('幕 3 — owner 显式提升 T3(信任伙伴)—— 信任只降摩擦,永不去掉确认底线')
  applyTier(edge, 'T3', '长期合作,owner 显式提升')
  showMatrix(edge)
  {
    const benign = evaluateOutbound(edge, ACTIONS[1]!)
    const dangerous = evaluateOutbound(edge, ACTIONS[2]!)
    const forbidden = evaluateOutbound(edge, ACTIONS[3]!)
    assert(benign.decision === 'auto', 'T3 读日历:自动放行(信任伙伴,读类零打扰)')
    // 底线:最危险的动作即使 T3 也**不**自动,仍要成员一键留痕.
    assert(
      dangerous.decision === 'member_notify' && dangerous.needsHuman,
      'T3 付款:仍要成员一键确认(可追责)——绝不因 T3 就静默自动',
    )
    assert(dangerous.decision !== 'auto', '铁律:最危险动作即使 T3 也永不 auto')
    assert(forbidden.decision === 'deny', 'T3 forbidden:仍拒(未授权能力任何档都不放行)')
    console.log('  ↳ 付款从 T1 的 owner_approve 一路降到 T3 的 member_notify,但**没有**降到 auto——底线守住.')
  }

  // ── 幕 4:引荐建立初始档(信任不传递) ─────────────────────────────────────
  section('幕 4 — T3 伙伴引荐全新 hub-Z → 建议初始档 = 地板 T1(信任不传递)')
  const referral = suggestTierFromReferral(edge.tier) // 引荐人 = 现在 T3 的 hub-B
  assert(referral !== null, '引荐人 ≥ T2(这里 T3)→ 引荐产出一条初始档建议')
  assert(
    referral!.to === DEFAULT_TRUST_TIER && referral!.to === 'T1',
    `建议初始档 = 地板 T1(不是引荐人的 T3),实际 ${referral!.to}`,
  )
  assert(referral!.referrerTier === 'T3', '建议带出处:引荐人档 = T3')
  console.log(
    `  面板提示 owner:「你的 ${referral!.referrerTier} 伙伴 ${edge.peerId} 引荐了 hub-Z,建议给 ${referral!.to}」`,
  )
  console.log('  ↳ 引荐人是我给的最高档 T3,可 hub-Z 也只建议地板 T1——「X 是 T3 所以 Z 也 T3」被结构性禁止.')
  // 不够格的引荐人(< T2)其引荐不产出信号.
  const weakReferral = suggestTierFromReferral('T1')
  assert(weakReferral === null, '不够格引荐人(T1 < T2):引荐不产出信号(null)')
  console.log('  ↳ 反过来:一个我自己都只给 T1 的边,它的「介绍」不构成信任信号——fail-closed.')
  // owner 确认才为 hub-Z 建边落档(信任的根仍是 owner 对 Z 的单边决定).
  const hubZ: PeerEdge = { peerId: 'hub-Z', tier: referral!.to }
  assert(hubZ.tier === 'T1', 'owner 确认后 hub-Z 落 T1:引荐省了发现成本,信任的根仍是 owner 单边决定')

  // ── 收尾 ─────────────────────────────────────────────────────────────────
  section('四条边界回顾')
  console.log('  ① 热路径零 LLM:每格裁决全靠纯函数查矩阵 + 比档位,零模型调用.')
  console.log('  ② fail-closed 地板:新边默认 T1、未知动作/未知档一律 deny.')
  console.log('  ③ 纯软连接:PIN / 引荐只产出 owner 面板上的**建议**,升降档永远是人点头的另一步.')
  console.log('  ④ 声明 ≠ 信任:信任的根锚在 owner 亲手的 PIN / 提升,不在任何自报或引荐.')
  console.log('\n一句话:信任是长出来的——地板起步 → 验证建议升 → owner 提升 → 引荐传播;')
  console.log('        同一个动作的审批一路变轻,但最危险那格的确认底线,任何档都不塌.\n')
  process.exit(0)
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
