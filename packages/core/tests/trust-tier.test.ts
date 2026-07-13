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
  type TrustTier,
  type OutboundActionRisk,
  type TrustDecision,
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
