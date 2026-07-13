import { describe, it, expect } from 'vitest'

import {
  TRUST_TIERS,
  TRUST_TIER_CODENAMES,
  DEFAULT_TRUST_TIER,
  tierRank,
  isTrustTier,
  isUpgrade,
  isDowngrade,
  decideTrust,
  decisionRequiresHuman,
  suggestTierFromIdentity,
  suggestTierFromReferral,
  type TrustTier,
  type OutboundActionRisk,
  type TrustDecision,
  type IdentityConfidence,
} from '../src/trust-tier.js'

describe('GT-M1 trust-tier 纯核', () => {
  describe('decideTrust 决策矩阵(GRADED-TRUST.md 第七节)', () => {
    // 逐格快照 —— 改矩阵必改这里,防止悄悄漂移。
    const EXPECT: Record<OutboundActionRisk, Record<TrustTier, TrustDecision>> = {
      read_only: { T0: 'deny', T1: 'member_notify', T2: 'auto', T3: 'auto' },
      benign: { T0: 'deny', T1: 'member_approve', T2: 'member_notify', T3: 'auto' },
      dangerous: { T0: 'deny', T1: 'owner_approve', T2: 'owner_approve', T3: 'member_notify' },
      forbidden: { T0: 'deny', T1: 'deny', T2: 'deny', T3: 'deny' },
    }
    for (const risk of Object.keys(EXPECT) as OutboundActionRisk[]) {
      for (const tier of TRUST_TIERS) {
        it(`${risk} × ${tier} → ${EXPECT[risk][tier]}`, () => {
          expect(decideTrust(tier, risk)).toBe(EXPECT[risk][tier])
        })
      }
    }
  })

  describe('结构性纪律(信任只降摩擦、永不去底线)', () => {
    const RISKS: OutboundActionRisk[] = ['read_only', 'benign', 'dangerous', 'forbidden']
    // 摩擦序:deny 视作最紧(4),用于单调性检验。
    const friction: Record<TrustDecision, number> = {
      auto: 0,
      member_notify: 1,
      member_approve: 2,
      owner_approve: 3,
      deny: 4,
    }

    it('T0 任何动作都 deny(未联邦 = 零 mesh 通信)', () => {
      for (const risk of RISKS) expect(decideTrust('T0', risk)).toBe('deny')
    })

    it('forbidden 任何档都 deny(白名单外永不放行)', () => {
      for (const tier of TRUST_TIERS) expect(decideTrust(tier, 'forbidden')).toBe('deny')
    })

    it('dangerous 即使 T3 也不 auto(信任不去确认底线)', () => {
      expect(decideTrust('T3', 'dangerous')).not.toBe('auto')
      expect(decisionRequiresHuman(decideTrust('T3', 'dangerous'))).toBe(true)
    })

    it('固定动作:档越高摩擦非增(易用性随信任升)', () => {
      for (const risk of RISKS) {
        for (let i = 1; i < TRUST_TIERS.length; i++) {
          const lo = friction[decideTrust(TRUST_TIERS[i - 1], risk)]
          const hi = friction[decideTrust(TRUST_TIERS[i], risk)]
          expect(hi).toBeLessThanOrEqual(lo)
        }
      }
    })

    it('固定档:动作越危险摩擦非减(安全性守底线)', () => {
      for (const tier of TRUST_TIERS) {
        for (let i = 1; i < RISKS.length; i++) {
          const lo = friction[decideTrust(tier, RISKS[i - 1])]
          const hi = friction[decideTrust(tier, RISKS[i])]
          expect(hi).toBeGreaterThanOrEqual(lo)
        }
      }
    })
  })

  describe('fail-closed', () => {
    it('未知档 → deny', () => {
      expect(decideTrust('T9' as TrustTier, 'read_only')).toBe('deny')
    })
    it('未知动作风险 → deny', () => {
      expect(decideTrust('T3', 'nuke' as OutboundActionRisk)).toBe('deny')
    })
  })

  describe('档序 / 升降档', () => {
    it('TRUST_TIERS 低到高', () => {
      expect(TRUST_TIERS).toEqual(['T0', 'T1', 'T2', 'T3'])
    })
    it('tierRank 单调,未知 = -1', () => {
      expect(tierRank('T0')).toBe(0)
      expect(tierRank('T3')).toBe(3)
      expect(tierRank('T9' as TrustTier)).toBe(-1)
    })
    it('DEFAULT_TRUST_TIER = T1(fail-closed 地板)', () => {
      expect(DEFAULT_TRUST_TIER).toBe('T1')
    })
    it('isUpgrade / isDowngrade', () => {
      expect(isUpgrade('T1', 'T2')).toBe(true)
      expect(isUpgrade('T2', 'T1')).toBe(false)
      expect(isUpgrade('T2', 'T2')).toBe(false)
      expect(isDowngrade('T3', 'T1')).toBe(true)
      expect(isDowngrade('T1', 'T3')).toBe(false)
    })
  })

  describe('值域守卫 / 代号', () => {
    it('isTrustTier', () => {
      expect(isTrustTier('T0')).toBe(true)
      expect(isTrustTier('T4')).toBe(false)
      expect(isTrustTier(1)).toBe(false)
      expect(isTrustTier(null)).toBe(false)
    })
    it('每档有代号', () => {
      expect(TRUST_TIER_CODENAMES.T1).toBe('token')
      expect(TRUST_TIER_CODENAMES.T3).toBe('trusted')
      for (const t of TRUST_TIERS) expect(TRUST_TIER_CODENAMES[t]).toBeTruthy()
    })
  })
})

describe('GT-M4 纯软连接 suggestTierFromIdentity(建议 ≠ 自动改档)', () => {
  describe('pin_verified → 建议升到 T2(仅当前 < T2)', () => {
    it('T1 → 建议升 T2', () => {
      expect(suggestTierFromIdentity('T1', 'pin_verified')).toEqual({
        kind: 'upgrade', from: 'T1', to: 'T2', reason: 'pin_verified',
      })
    })
    it('T0 → 建议升 T2(from 记真实当前)', () => {
      expect(suggestTierFromIdentity('T0', 'pin_verified')).toEqual({
        kind: 'upgrade', from: 'T0', to: 'T2', reason: 'pin_verified',
      })
    })
    it('T2 → null(已锚定,不重复建议)', () => {
      expect(suggestTierFromIdentity('T2', 'pin_verified')).toBeNull()
    })
    it('T3 → null(已高于 T2,不建议降)', () => {
      expect(suggestTierFromIdentity('T3', 'pin_verified')).toBeNull()
    })
  })

  describe('pin_mismatch → 建议降到 T1 地板(仅当前 > T1)', () => {
    it('T3 → 建议降 T1', () => {
      expect(suggestTierFromIdentity('T3', 'pin_mismatch')).toEqual({
        kind: 'downgrade', from: 'T3', to: 'T1', reason: 'pin_mismatch',
      })
    })
    it('T2 → 建议降 T1', () => {
      expect(suggestTierFromIdentity('T2', 'pin_mismatch')).toEqual({
        kind: 'downgrade', from: 'T2', to: 'T1', reason: 'pin_mismatch',
      })
    })
    it('T1 → null(已在地板,无处可降)', () => {
      expect(suggestTierFromIdentity('T1', 'pin_mismatch')).toBeNull()
    })
    it('T0 → null(已在地板下,不建议)', () => {
      expect(suggestTierFromIdentity('T0', 'pin_mismatch')).toBeNull()
    })
  })

  it('pin_absent → 恒 null(没有身份信号,不动)', () => {
    for (const t of TRUST_TIERS) {
      expect(suggestTierFromIdentity(t, 'pin_absent')).toBeNull()
    }
  })

  it('无效当前档 → null(基线不可信不建议,fail-closed)', () => {
    expect(suggestTierFromIdentity('T9' as TrustTier, 'pin_verified')).toBeNull()
    expect(suggestTierFromIdentity('' as TrustTier, 'pin_mismatch')).toBeNull()
  })

  it('未知信号 → null(保守)', () => {
    expect(suggestTierFromIdentity('T1', 'bogus' as IdentityConfidence)).toBeNull()
  })

  // 核心纪律 1:PIN 只证身份(=T2 门槛),永远给不了 T3(那是 owner 显式提升)。
  // 无论从哪档、无论信号,建议的目标档绝不是 T3。
  it('建议目标绝不为 T3(PIN 证不了「值得做危险事」)', () => {
    for (const t of TRUST_TIERS) {
      for (const s of ['pin_verified', 'pin_mismatch', 'pin_absent'] as IdentityConfidence[]) {
        const sug = suggestTierFromIdentity(t, s)
        if (sug) expect(sug.to).not.toBe('T3')
      }
    }
  })

  // 核心纪律 2:mismatch 是「请重新确认」的软提示,退回令牌地板 T1,绝不 deny /
  // 绝不 T0(不是「断交」)。所有降级建议的目标恒为 T1。
  it('降级建议目标恒为 T1(重新确认,非断交)', () => {
    for (const t of TRUST_TIERS) {
      const sug = suggestTierFromIdentity(t, 'pin_mismatch')
      if (sug) expect(sug.to).toBe('T1')
    }
  })

  // 核心纪律 3(建议 ≠ 自动改档):这个函数是纯的 —— 同输入同输出,且返回的是一条
  // 「描述」(kind/from/to/reason)而不是一个「直接拿去写库的新档」。它没有任何
  // 副作用,升降档要 owner 另点头(capstone 里证全链路)。这里钉死纯度 + 形状。
  it('纯函数:同输入同输出、返回描述而非可直接落库的裁决', () => {
    const a = suggestTierFromIdentity('T1', 'pin_verified')
    const b = suggestTierFromIdentity('T1', 'pin_verified')
    expect(a).toEqual(b) // 幂等
    // 返回值带完整出处(from + reason),证明它是「给人看的建议」而非裸档值。
    expect(a).toMatchObject({ kind: 'upgrade', from: 'T1', reason: 'pin_verified' })
    // from ≠ to:建议永远描述一个「变化」,不是「保持」。
    if (a) expect(a.from).not.toBe(a.to)
  })
})

describe('GT-M5 信任引荐 suggestTierFromReferral(引荐 = 建议初始档,不自动赋信)', () => {
  it('T3 引荐人 → 建议初始档 T1(plan 第六节的确切例子)', () => {
    expect(suggestTierFromReferral('T3')).toEqual({
      to: 'T1', referrerTier: 'T3', reason: 'referral',
    })
  })
  it('T2 引荐人(已验证)→ 建议初始档 T1', () => {
    expect(suggestTierFromReferral('T2')).toEqual({
      to: 'T1', referrerTier: 'T2', reason: 'referral',
    })
  })
  it('T1 引荐人(仅令牌地板,不够可信)→ null 无建议', () => {
    expect(suggestTierFromReferral('T1')).toBeNull()
  })
  it('T0 引荐人 → null 无建议', () => {
    expect(suggestTierFromReferral('T0')).toBeNull()
  })
  it('无效引荐人档 → null(fail-closed)', () => {
    expect(suggestTierFromReferral('T9' as TrustTier)).toBeNull()
    expect(suggestTierFromReferral('' as TrustTier)).toBeNull()
  })

  // 核心纪律(信任不传递):无论引荐人多高档,建议的初始档恒为地板 —— 绝不「X 是 T3
  // 所以 Y 也 T3」。目标恒等于 fail-closed 地板常量,且永不高于 T1。
  it('信任不传递:任何够格引荐建议目标恒为地板 T1', () => {
    for (const referrer of TRUST_TIERS) {
      const sug = suggestTierFromReferral(referrer)
      if (sug) {
        expect(sug.to).toBe(DEFAULT_TRUST_TIER) // = 'T1'
        expect(tierRank(sug.to)).toBeLessThanOrEqual(tierRank('T1'))
      }
    }
  })

  // 核心纪律(引荐 = 建议,不自动赋信 + owner 确认才落):函数纯、无副作用,返回的是
  // 一条带出处(referrerTier + reason='referral')的「建议」,不是可直接写进 trust_tier
  // 的裸档。落档是 owner 另点头的另一步(capstone 证:引荐建议出现 → owner 确认 →
  // 才 addPeer,拒绝则那条边根本不建)。
  it('纯函数:同输入同输出、返回带出处的建议而非裸档值', () => {
    const a = suggestTierFromReferral('T3')
    const b = suggestTierFromReferral('T3')
    expect(a).toEqual(b) // 幂等
    expect(a).toMatchObject({ to: 'T1', referrerTier: 'T3', reason: 'referral' })
  })
})
