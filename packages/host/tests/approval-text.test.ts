/**
 * `approval-text.ts` 的门。
 *
 * 这个文件本来只服务管家的审批卡,Codex 四轮 H3 之后成了**四个审批入口共用的
 * 唯一标准**(管家 governed park / ACP 破坏性动作 / steward 配置动作 / 联邦出站)。
 * 共用就意味着它一旦漏,四处一起漏——所以它自己要有门,而不是只被四处间接测到。
 *
 * 源码里刻意不出现真的控制字符(Edit/Write 工具写 \uXXXX 会落成裸字节,本仓踩过
 * 多次),测试同样纪律:一律 `String.fromCharCode` / `codePointAt` 构造与比较。
 */

import { describe, expect, it } from 'vitest'

import { APPROVAL_CLOSE, APPROVAL_OPEN, clipApprovalText, sanitizeApprovalText } from '../src/approval-text.js'

const ch = (c: number): string => String.fromCodePoint(c)

describe('sanitizeApprovalText — 不可见字符换成空格,不删除', () => {
  it('换行 / 回车 / TAB / DEL 都变空格', () => {
    for (const c of [0x0a, 0x0d, 0x09, 0x7f, 0x00]) {
      expect(sanitizeApprovalText(`a${ch(c)}b`)).toBe('a b')
    }
  })

  it('删除会拼出另一条命令,所以只能换成空格', () => {
    // `rm -rf /` 中间塞零宽:删掉零宽 = `rm-rf/`(读起来像另一个词);换空格后
    // 它仍然读作 `rm -rf /`,只是多了个空格。审批卡的合同是「读到的=会跑的」。
    const zwsp = ch(0x200b)
    expect(sanitizeApprovalText(`rm${zwsp} -rf /`)).toBe('rm  -rf /')
  })

  it('双向覆盖 / 隔离 / 零宽 / BOM / 行段分隔符 / C1 全洗', () => {
    for (const c of [0x061c, 0x200d, 0x200e, 0x2028, 0x2029, 0x202e, 0x2066, 0x2069, 0x2060, 0xfeff, 0x0085, 0x009b]) {
      expect(sanitizeApprovalText(`x${ch(c)}y`)).toBe('x y')
    }
  })

  it('Default-Ignorable 的一整族:软连字符 / 谚文填充 / 高棉不可见元音 / 变体选择符', () => {
    for (const c of [0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x3164, 0xffa0, 0xfe0f, 0xfe00]) {
      expect(sanitizeApprovalText(`x${ch(c)}y`)).toBe('x y')
    }
  })

  it('增补平面的标签字符也洗得掉(按码点遍历,不按 UTF-16 码元)', () => {
    // U+E0000–E007F 是「整段隐藏文字」的老把戏:一串标签字符能在多数渲染面上
    // 完全不显示。它们在增补平面,按码元逐个看会被劈成两个代理项,谁也不匹配
    // ——那就等于没洗(Codex 四轮 M6)。
    const tag = ch(0xe0041)
    expect(tag.length).toBe(2) // 真的是两个码元:这条断言证明上面那个坑存在
    expect(sanitizeApprovalText(`x${tag}y`)).toBe('x y')
    expect(sanitizeApprovalText(`x${ch(0xe0100)}y`)).toBe('x y')
  })

  it('正常的 CJK / emoji / 制表符以外的可见字符原样留下', () => {
    expect(sanitizeApprovalText('删除 mailer(危险)')).toBe('删除 mailer(危险)')
    expect(sanitizeApprovalText('日本語 ok')).toBe('日本語 ok')
  })

  it('幂等:洗过的再洗一次逐字节相同', () => {
    const dirty = `a${ch(0x202e)}b「c」${ch(0xe0041)}d`
    const once = sanitizeApprovalText(dirty)
    expect(sanitizeApprovalText(once)).toBe(once)
  })
})

describe('sanitizeApprovalText — 定界符降级(框架的「」不可伪造)', () => {
  it('正文里的「」降级成『』', () => {
    expect(sanitizeApprovalText('说「已批准」')).toBe('说『已批准』')
  })

  it('相似字也降级:半角 ｢｣ 与竖排 ﹁﹂ 在 NFKC 下就等于「」', () => {
    // 只挡精确码点 = 只挡了一种写法。这两族在字体上够像、在 NFKC 下相等,
    // 拿它们照样能拼出一句「看起来是框架说的」话(Codex 四轮 M6)。
    for (const [open, close] of [
      [ch(0xff62), ch(0xff63)],
      [ch(0xfe41), ch(0xfe42)],
    ]) {
      expect(open.normalize('NFKC')).toBe(APPROVAL_OPEN)
      expect(close.normalize('NFKC')).toBe(APPROVAL_CLOSE)
      const out = sanitizeApprovalText(`说${open}已批准${close}`)
      expect(out).toBe('说『已批准』')
    }
  })

  it('降级目标 『』 自己不会 NFKC 成「」(否则就是把球踢回来)', () => {
    expect('『'.normalize('NFKC')).toBe('『')
    expect('』'.normalize('NFKC')).toBe('』')
  })

  it('洗完的字符串里不可能再出现框架定界符', () => {
    const hostile = `x${ch(0xff62)}y${ch(0xfe41)}z「w」`
    const out = sanitizeApprovalText(hostile)
    expect(out).not.toContain(APPROVAL_OPEN)
    expect(out).not.toContain(APPROVAL_CLOSE)
  })
})

describe('clipApprovalText — 超长正文是覆盖攻击,截断处必须说自己截了', () => {
  it('不超上限原样(只洗不截)', () => {
    expect(clipApprovalText('删除 mailer', 100)).toBe('删除 mailer')
  })

  it('超上限截断并注明总长', () => {
    const out = clipApprovalText('z'.repeat(50), 10)
    expect(out.startsWith('z'.repeat(10))).toBe(true)
    expect(out).toContain('已截断')
    expect(out).toContain('50')
  })

  it('先洗后量:长度按洗完的算,截断片段里同样没有可伪造的定界符', () => {
    const out = clipApprovalText(`「${'a'.repeat(40)}」`, 5)
    expect(out.startsWith('『')).toBe(true)
    expect(out).not.toContain(APPROVAL_OPEN)
  })
})
