/**
 * trust-tier.ts — GT-M1 分级信任纯核(Graded Trust)。
 *
 * 一条 mesh 边的信任档 `TrustTier`,由 owner 显式选择(核心提案 A),不是从
 * 行为自动推断的分数。它把「我多信任这条边」做成一个可分级、可上协议的一等
 * 公民,让稀缺的人类注意力只花在「低信任 × 高风险」的格子里。
 *
 * 四条边界(与 docs/zh/GRADED-TRUST.md 一致):
 *   - 信任只降摩擦、永不去确认底线:最高危动作即使 T3 也留可追责确认,
 *     forbidden 任何档都拒。
 *   - 与 reputation(干活质量,路由用)、pinnedKid(身份确证)、PeerKind
 *     (对方是什么)全部正交——绝不揉成一个「信任分数」。
 *   - 纯函数、零依赖、热路径零 LLM:分级裁决全是查表。
 *   - fail-closed:未知档 / 未知动作一律按最保守处理(deny)。
 *
 * 见 docs/zh/GRADED-TRUST.md 第六、七节。
 */

/**
 * 信任档(T0 最低 … T3 最高)。每升一档:要么更多验证,要么更多人工确认。
 *   T0 discoverable — 只经公开 A2A 可见,未完成 mesh 握手。零 mesh 通信。
 *   T1 token        — 完成双边 token 握手(今天的联邦门槛)。默认地板。
 *   T2 verified     — T1 + owner 显式 PIN 了签名公钥(身份锚定)。
 *   T3 trusted      — T2 + owner 显式提升(家人 / 长期合作)。
 */
export type TrustTier = 'T0' | 'T1' | 'T2' | 'T3'

/** 档从低到高的权威顺序(升降档比较、面板渲染)。 */
export const TRUST_TIERS: readonly TrustTier[] = ['T0', 'T1', 'T2', 'T3'] as const

/** 每档的英文代号(面板 i18n 在 web 层,core 只给稳定代号)。 */
export const TRUST_TIER_CODENAMES: Readonly<Record<TrustTier, string>> = {
  T0: 'discoverable',
  T1: 'token',
  T2: 'verified',
  T3: 'trusted',
}

/**
 * 默认地板:一条边完成 token 握手后落这一档(fail-closed,岔口 2)。未握手
 * (仅公开可发现)概念上是 T0;真正建了 peer 行的边至少 T1。
 */
export const DEFAULT_TRUST_TIER: TrustTier = 'T1'

/** 档的序号(T0=0 … T3=3);未知档 → -1,天然低于一切有效档 = fail-closed。 */
export function tierRank(tier: TrustTier): number {
  return (TRUST_TIERS as readonly string[]).indexOf(tier)
}

/** 有效档?(值域守卫,存储 / wire 读入时用) */
export function isTrustTier(v: unknown): v is TrustTier {
  return typeof v === 'string' && (TRUST_TIERS as readonly string[]).includes(v)
}

/** `to` 是否比 `from` 高(升档)。未知档按 rank=-1 处理。 */
export function isUpgrade(from: TrustTier, to: TrustTier): boolean {
  return tierRank(to) > tierRank(from)
}

/** `to` 是否比 `from` 低(降档)。 */
export function isDowngrade(from: TrustTier, to: TrustTier): boolean {
  return tierRank(to) < tierRank(from)
}

/**
 * 出站动作的风险类 —— 决策矩阵的另一维。调用方(host / personal-butler)把
 * 真实出站动作映射到这四类;本纯核只定义「类」与「矩阵」,不管映射(那是接入
 * 时的事,GT-M2/M3)。
 *   read_only — 只读:list_peer / inspect,不改对端也不派活。
 *   benign    — benign 派活:读类 capability。
 *   dangerous — 危险派活:花钱 / 对外 / 数据出盒。
 *   forbidden — 未授权 capability(白名单外)。
 */
export type OutboundActionRisk = 'read_only' | 'benign' | 'dangerous' | 'forbidden'

/**
 * 一格裁决:人要不要确认 + 确认多重(从松到紧)。
 *   auto           — 自动放行,零确认。
 *   member_notify  — 成员一键确认(最轻,可追责留痕)。IM /approve 式。
 *   member_approve — 成员审批(web 式,重)。
 *   owner_approve  — owner 审批(最重,高敏)。
 *   deny           — 拒绝。
 *
 * 注意:deny 不是「摩擦最大」的连续端点,而是独立终态;
 * auto→member_notify→member_approve→owner_approve 才是摩擦递增的谱。
 */
export type TrustDecision =
  | 'auto'
  | 'member_notify'
  | 'member_approve'
  | 'owner_approve'
  | 'deny'

/**
 * 决策矩阵(GT 核心):trustTier × 出站动作风险 → 裁决。就是
 * docs/zh/GRADED-TRUST.md 第七节那张表,逐格对应:
 *
 *   动作 \ 档     T0     T1              T2              T3
 *   read_only    deny   member_notify   auto            auto
 *   benign       deny   member_approve  member_notify   auto
 *   dangerous    deny   owner_approve   owner_approve    member_notify
 *   forbidden    deny   deny            deny            deny
 *
 * 读法:同一动作档越高摩擦越低(易用性升);同一档动作越危险摩擦越高(安全性
 * 守)。信任只降摩擦不去底线——dangerous 即使 T3 仍要 member_notify(可追责),
 * forbidden 任何档都 deny,T0 任何动作都 deny。
 */
const DECISION_MATRIX: Readonly<
  Record<OutboundActionRisk, Readonly<Record<TrustTier, TrustDecision>>>
> = {
  read_only: { T0: 'deny', T1: 'member_notify', T2: 'auto', T3: 'auto' },
  benign: { T0: 'deny', T1: 'member_approve', T2: 'member_notify', T3: 'auto' },
  dangerous: { T0: 'deny', T1: 'owner_approve', T2: 'owner_approve', T3: 'member_notify' },
  forbidden: { T0: 'deny', T1: 'deny', T2: 'deny', T3: 'deny' },
}

/**
 * 裁决一个出站动作:给定这条边的信任档 + 动作风险类,返回该走哪种确认。
 * fail-closed:未知风险类或未知档一律 deny(绝不因不认识而放行)。
 */
export function decideTrust(tier: TrustTier, risk: OutboundActionRisk): TrustDecision {
  const row = DECISION_MATRIX[risk]
  if (!row) return 'deny' // 未知动作风险 → 保守拒绝
  return row[tier] ?? 'deny' // 未知档 → 保守拒绝
}

/**
 * 这个裁决要不要人介入?(auto / deny 之外都要人)。便于调用方分流:auto 直接
 * 放行,deny 直接拒,其余落审批闸(轻重由具体值定)。
 */
export function decisionRequiresHuman(d: TrustDecision): boolean {
  return d === 'member_notify' || d === 'member_approve' || d === 'owner_approve'
}

// ---------------------------------------------------------------------------
// GT-M4 — 纯软连接(岔口 3):身份确证 ↔ 授权档 只做 advisory 提示。
//
// 一条铁律:**身份确证只提示,升降档永远是 owner 的决定**。这里的函数产出的是
// 「给 owner 看的建议」,绝不改任何存储、绝不自动改 trust_tier。装配层(host /
// web / CLI)拿到建议只负责「显示」,落不落档是 owner 点头才发生的另一步。
// ---------------------------------------------------------------------------

/**
 * 身份确证信号 —— 纯软连接的输入。它是 STD 层 pinnedKid 复验结果的抽象:core
 * 只认「结果类」,不认怎么验的(取活名片、算签名、比指纹都是 a2a / host 的事)。
 *   pin_verified — 活名片签名钥的 RFC 7638 指纹 == owner PIN 的 pinnedKid。身份锚定成立。
 *   pin_mismatch — 复验出的指纹 != PIN 值(钥换了 / 可能根本是别的 hub)。身份存疑。
 *   pin_absent   — owner 没 PIN(无锚点),或对端没签名卡:没有身份信号。
 */
export type IdentityConfidence = 'pin_verified' | 'pin_mismatch' | 'pin_absent'

/**
 * 一条 advisory 升降档建议。**永远只是建议**(纯软连接铁律,岔口 3):系统绝不
 * 拿它自动改 trust_tier;它只是喂给 owner 面板 / CLI 的一行提示。`reason` 是稳定
 * 代号(面板 i18n 在 web 层,core 只给代号)。
 */
export interface TierSuggestion {
  kind: 'upgrade' | 'downgrade'
  from: TrustTier
  to: TrustTier
  reason: 'pin_verified' | 'pin_mismatch'
}

/**
 * 纯软连接(GT-M4):从身份确证信号 + 当前档,产出一条 advisory 升降档建议
 * (或 null = 无建议)。**此函数是纯的,不碰任何存储**——返回值是提示,落档是
 * owner 另点头的事。
 *
 *   pin_verified 且当前 < T2 → 建议升到 **T2**(身份锚定成立,可考虑「已验证」)。
 *     当前已 ≥ T2 → null(已经锚定过,不重复建议)。
 *   pin_mismatch 且当前 > T1 → 建议降到 **T1**(钥变了,身份存疑,退回令牌地板)。
 *     当前已 ≤ T1 → null(已在地板,无处可降)。
 *   pin_absent / 无效当前档 → null(没有信号 / 基线不可信,不动 = fail-closed)。
 *
 * 为什么升只到 T2、降只到 T1:PIN 只证明**身份**(=T2 门槛),证明不了「值得信任
 * 做危险事」(那是 T3,owner 显式提升,pinnedKid 给不了);mismatch 是「请重新
 * 确认」的软提示,退回令牌地板 T1,不是「断交」(不 deny、不 T0)。
 */
export function suggestTierFromIdentity(
  current: TrustTier,
  signal: IdentityConfidence,
): TierSuggestion | null {
  // 基线不可信就不建议(不拿垃圾当当前档去推升降),保守方向。
  if (!isTrustTier(current)) return null
  if (signal === 'pin_verified') {
    if (tierRank(current) < tierRank('T2')) {
      return { kind: 'upgrade', from: current, to: 'T2', reason: 'pin_verified' }
    }
    return null
  }
  if (signal === 'pin_mismatch') {
    if (tierRank(current) > tierRank('T1')) {
      return { kind: 'downgrade', from: current, to: 'T1', reason: 'pin_mismatch' }
    }
    return null
  }
  return null // pin_absent(或任何未知信号)→ 无建议
}
