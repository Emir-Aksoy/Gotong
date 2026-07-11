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

  it('falls back to a clipped prompt when there is no title', async () => {
    const { svc } = service([
      item({ itemId: 'cccccccc-3333', prompt: 'p'.repeat(200), imApprovable: true }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title.length).toBeLessThanOrEqual(80)
    expect(rows[0]!.title.endsWith('…')).toBe(true)
  })

  it('renders imApprovable=false for unflagged items AND for non-approval kinds', async () => {
    const { svc } = service([
      item({ itemId: 'dddddddd-4444' }), // no flag — web only
      item({ itemId: 'eeeeeeee-5555', kind: 'choice', imApprovable: true } as never),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows.every((r) => r.imApprovable === false)).toBe(true)
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
