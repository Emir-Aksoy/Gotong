/**
 * `approval-text.ts` 的门。
 *
 * 这个文件本来只服务管家的审批卡,Codex 四轮 H3 之后成了**三个审批入口共用的
 * 唯一标准**(管家 governed park / steward 配置动作 / 联邦出站)。共用就意味着
 * 它一旦漏,三处一起漏——所以它自己要有门,而不是只被三处间接测到。
 *
 * 源码里刻意不出现真的控制字符(Edit/Write 工具写 \uXXXX 会落成裸字节,本仓踩过
 * 多次),测试同样纪律:一律 `String.fromCharCode` / `codePointAt` 构造与比较。
 */

import { describe, expect, it } from 'vitest'

import {
  APPROVAL_CLOSE,
  APPROVAL_OPEN,
  clipApprovalText,
  hasVisibleContent,
  sanitizeApprovalText,
} from '../src/approval-text.js'

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

  it('角括号族也降级:NFKC 不等价,但屏幕上就是同一根直角(九轮 L)', () => {
    // ⌜⌝⌞⌟(U+231C-F)与 ⸢⸣⸤⸥(U+2E22-5)规范化之后不等于「」,所以上一条那个
    // 判据放它们过去。但这里要挡的从来不是等价关系,是「人一眼读成框架引号」:
    // `⌟。原因:『无害』` 在手机上就能把框架那对引号视觉上关掉。
    for (const [open, close] of [
      [ch(0x231c), ch(0x231d)],
      [ch(0x231e), ch(0x231f)],
      [ch(0x2e22), ch(0x2e23)],
      [ch(0x2e24), ch(0x2e25)],
    ]) {
      // 先记下事实:它们**不是** NFKC 等价的,所以名单必须自己列出来。
      expect(open.normalize('NFKC')).not.toBe(APPROVAL_OPEN)
      expect(sanitizeApprovalText(`说${open}已批准${close}`)).toBe('说『已批准』')
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

  it('按码点切,不把增补平面的字劈成半个代理项(六轮 L)', () => {
    // U+1F4A3 是两个 UTF-16 码元;按码元 slice(0,5) 会切在第三个字中间,
    // 渲染出来多一个原文里没有的 U+FFFD——而这行字的全部意义就是「它和真正
    // 要跑的动作是同一件事」。
    const BOMB = String.fromCodePoint(0x1f4a3)
    const out = clipApprovalText(BOMB.repeat(20), 5)
    // 半个代理项在字符串里仍是一个孤立码元(渲染时才变 U+FFFD),所以按码点扫。
    const lone = Array.from(out).filter((c) => {
      const cp = c.codePointAt(0) ?? 0
      return cp >= 0xd800 && cp <= 0xdfff
    })
    expect(lone).toHaveLength(0)
    expect(Array.from(out.slice(0, out.indexOf('…')))).toHaveLength(5)
    expect(out).toContain('共 20 字符') // 总长也按码点数,不按码元数(20 不是 40)
  })
})

describe('hasVisibleContent — 判据收窄成「有没有字或数」(八轮 H3)', () => {
  it('有一个字母 / 数字就算有内容', () => {
    for (const t of ['删', 'a', '7', '  x  ', '删除 mailer']) {
      expect(hasVisibleContent(t)).toBe(true)
    }
  })

  it('纯空白 / 空串没有内容', () => {
    for (const t of ['', ' ', '   ', String.fromCharCode(9, 32, 10)]) {
      expect(hasVisibleContent(t)).toBe(false)
    }
  })

  it('**空白字形点不完**:所以判据不再收标点与符号', () => {
    // 七轮把判据写成「字母/数字/标点/符号」,于是拉黑一个 U+2800 就得拉黑下一个:
    // U+1D159(MUSICAL SYMBOL NULL NOTEHEAD)同样是 So、同样在屏幕上不占一撇,而且
    // 在增补平面。这类字形有几百个,名单永远追不完。收窄到「必须有字或数」之后,
    // 整个类别一次性关掉 —— 剩下的代价只是「一行纯标点」也算不完整(降级去网页,
    // fail-closed,这个方向是对的)。
    for (const cp of [0x2800, 0x1d159, 0x1d173, 0x2062]) {
      expect(hasVisibleContent(ch(cp))).toBe(false)
    }
    // 纯标点 / 纯符号的一行同样落网页,而不是被当成一个读得懂的动作。
    for (const t of ['.', '¥', '...', '· ·']) {
      expect(hasVisibleContent(t)).toBe(false)
    }
  })

  it('**顺序仍然承重**:白名单自己会被骗,先洗后问才拦得住', () => {
    // U+3164(谚文填充)的分类是**字母**(Lo)——白名单单独看它会答「有内容」,而它
    // 在屏幕上是空白。两道各兜一半:名单先把它洗成空格,白名单再问洗完还剩什么。
    const sneaky = ch(0x3164) + ch(0x3164)
    expect(hasVisibleContent(sneaky)).toBe(true) // ← 白名单自己被骗了
    expect(hasVisibleContent(sanitizeApprovalText(sneaky))).toBe(false) // ← 洗完才是真话
  })

  it('每一个都真的被洗成了空格(名单与白名单各兜一半)', () => {
    for (const c of [0x2800, 0xfff9, 0xfffa, 0xfffb, 0x2060, 0x206f, 0xd800, 0xdfff]) {
      expect(sanitizeApprovalText(String.fromCharCode(c))).toBe(' ')
    }
  })
})
