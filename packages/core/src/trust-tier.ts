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
