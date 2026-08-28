/**
 * UXCFG-M3 —— 设置台前端的防腐门。
 *
 * `packages/web/static/setting-ops-ui.js` 里的 `KNOB_UI` 把 `ENV_KNOBS` 的键
 * 又抄了一遍(每个键配上人话标题、说明、控件类型、所属分组)。**手抄的名单会漂**:
 * host 加一个旋钮而渲染器没跟上,那个旋钮就在设置页上凭空不存在——不会有任何
 * 东西变红,而这正是「一个网页上完成所有配置」这句承诺静默破掉的方式。
 *
 * 门放在 host 而不是 web,是因为 host 是**唯一**同时够得着两边的包:它可以真的
 * `import { ENV_KNOBS }`,同时把 web 的静态文件当文本读。反过来不行——web 运行时
 * 不许 import host(kernel-deps 方向)。这比 `sdui-ui-contract` 那道「文本 vs 文本」
 * 的先例更强一档:那边两侧都是文本,这边有一侧是真值。
 *
 * 除了名单对拍,这里还钉住三类**性质**:
 *   - 危险区**结构上开不了火**(`renderDanger` 里不许出现 `apiRun(`)。它渲染的是
 *     停机才跑的三条命令,页面上给它一个按钮就是在给一条自己都跑不起来的路留门。
 *   - 全文件零 `innerHTML`(这个面板把 hub 的配置值渲染进 DOM,值可以被别的写入方
 *     写进来)。
 *   - 中英两份文案的键**逐键相等**。历史上 `sduiShapeInstallBtn` 少一个词条,界面
 *     上直接把 key 名渲染给了用户;那种 bug 只有对拍抓得住。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENV_KNOB_KEYS, SECRET_ENV_VARS } from '../src/ops-config-write.js'
import { listOpsCommands } from '../src/ops-core.js'

const RENDERER = fileURLToPath(new URL('../../web/static/setting-ops-ui.js', import.meta.url))
const APP_HTML = fileURLToPath(new URL('../../web/static/app.html', import.meta.url))
const SW_JS = fileURLToPath(new URL('../../web/static/sw.js', import.meta.url))
const MAIN_TS = fileURLToPath(new URL('../src/main.ts', import.meta.url))

const src = readFileSync(RENDERER, 'utf8')

/**
 * 取出 `const NAME = { … }` 那一块并求值。
 *
 * 靠的是这个文件统一的 2 空格 IIFE 缩进:声明行之后第一条恰好 `  }` 的行就是它的
 * 闭合。不数花括号是刻意的——文案里有 `{`/`}` 的话数括号会静默数错,而缩进锚点
 * 数错的时候是**响亮**的(求值当场抛)。
 */
function literalOf(name: string): any {
  const head = `  const ${name} = {`
  const at = src.indexOf(head)
  expect(at, `${name} 的声明形状变了`).toBeGreaterThan(-1)
  const rest = src.slice(at + head.length)
  const end = rest.indexOf('\n  }')
  expect(end, `${name} 的闭合形状变了`).toBeGreaterThan(-1)
  // eslint-disable-next-line no-new-func
  return new Function(`return {${rest.slice(0, end)}}`)()
}

function arrayLiteralOf(name: string): string[] {
  const m = new RegExp(`  const ${name} = (\\[[^\\]]*\\])`).exec(src)
  expect(m, `${name} 的声明形状变了`).not.toBeNull()
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m![1]}`)()
}

/** 只取 provenance 那一小段来跑真值——两个标记之间。 */
function provenanceSlice(): { provenanceOf: (k: any) => string; shownValue: (k: any) => string } {
  const a = src.indexOf('  // ── provenance')
  const b = src.indexOf('  // ── DOM 助手')
  expect(a, 'provenance 段的起始标记不见了').toBeGreaterThan(-1)
  expect(b, 'provenance 段的结束标记不见了').toBeGreaterThan(a)
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(a, b)}\nreturn { provenanceOf, shownValue }`)() as any
}

function bodyOf(fn: string): string {
  let at = src.indexOf(`  function ${fn}(`)
  if (at < 0) at = src.indexOf(`  async function ${fn}(`)
  expect(at, `${fn} 不见了`).toBeGreaterThan(-1)
  const rest = src.slice(at)
  const end = rest.indexOf('\n  }')
  return rest.slice(0, end)
}

describe('UXCFG-M3 设置台前端契约', () => {
  const KNOB_UI = literalOf('KNOB_UI')
  const L = literalOf('L')
  const GROUPS = arrayLiteralOf('GROUPS')
  const CONSUMED = arrayLiteralOf('CONSUMED')

  it('渲染器认得的旋钮 ≡ 写入方允许写的旋钮 —— 两个方向都对', () => {
    // 这一条就是整道门的理由。少一个 = 那个旋钮在网页上不存在;多一个 = 页面上
    // 有一格永远也写不下去的控件。
    const ui = Object.keys(KNOB_UI).sort()
    const real = [...ENV_KNOB_KEYS].sort()
    expect(ui).toEqual(real)
  })

  it('每个旋钮都落进一个真实分组,而且「其他」这个兜底桶一直在', () => {
    expect(GROUPS).toContain('other')
    for (const [key, ui] of Object.entries<any>(KNOB_UI)) {
      expect(GROUPS, `${key} 的分组`).toContain(ui.group)
    }
    // 兜底那行本身也钉住:没登记的旋钮宁可丑地出现在「其他」里,也不许消失。
    expect(bodyOf('renderKnobs')).toContain(`: 'other'`)
  })

  it('每个旋钮中英各有标题和说明 —— 不许有一半是空的', () => {
    for (const [key, ui] of Object.entries<any>(KNOB_UI)) {
      for (const lang of ['zh', 'en'] as const) {
        expect(Array.isArray(ui[lang]), `${key}.${lang}`).toBe(true)
        expect(ui[lang]).toHaveLength(2)
        expect(String(ui[lang][0]).trim(), `${key}.${lang} 标题`).not.toBe('')
        expect(String(ui[lang][1]).trim(), `${key}.${lang} 说明`).not.toBe('')
      }
    }
  })

  it('「要先打开 X」指的 X 是真旋钮 —— 级联提示不许指空', () => {
    for (const [key, ui] of Object.entries<any>(KNOB_UI)) {
      if (!ui.needs) continue
      expect(ENV_KNOB_KEYS, `${key} 的 needs`).toContain(ui.needs)
    }
  })

  it('每个分组都有中英两份标题与说明', () => {
    for (const g of GROUPS) {
      const cap = 'g' + g[0].toUpperCase() + g.slice(1)
      for (const lang of ['zh', 'en'] as const) {
        expect(L[lang][cap], `${lang}.${cap}`).toBeTruthy()
        expect(L[lang][cap + 'Note'], `${lang}.${cap}Note`).toBeTruthy()
      }
    }
  })

  it('中英两份文案的键逐键相等', () => {
    expect(Object.keys(L.zh).sort()).toEqual(Object.keys(L.en).sort())
  })

  it('被面板自己消化掉的命令,都是目录里真有的命令', () => {
    // 这三条不以按钮形式出现(config 是数据源、config-set 是保存键、config-price
    // 是那张表单)。名字写错的话它们会**重新长回**动作区,变成一个 argv 输入框。
    const ids = listOpsCommands({ surface: 'cli', allowConfigWrite: true }).map((c) => c.id)
    for (const id of CONSUMED) expect(ids, `CONSUMED 里的 ${id}`).toContain(id)
  })

  it('危险区结构上开不了火', () => {
    const body = bodyOf('renderDanger')
    expect(body).toContain('destructive-offline')
    expect(body).not.toContain('apiRun(')
    expect(body).toContain('gotong setting ')
  })

  it('全文件零 innerHTML —— 配置值是要渲染进 DOM 的', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
      expect(new RegExp(`${sink}\\s*=|\\.${sink}\\(`).test(src), sink).toBe(false)
    }
  })

  it('凭证名单不在前端抄一份 —— 它只能来自 wire', () => {
    for (const name of SECRET_ENV_VARS) expect(src, name).not.toContain(name)
    expect(src).toContain('state.cfg.secrets')
  })

  it('页面把真实的配置文件路径印出来', () => {
    // 「你改的东西落在这个文件里」是这个页面的全部论点。
    expect(src).toContain('envFilePath')
  })

  it('源码里没有裸控制字节', () => {
    const bad = [...src].filter((ch) => {
      const c = ch.charCodeAt(0)
      return c < 32 && c !== 9 && c !== 10 && c !== 13
    })
    expect(bad).toHaveLength(0)
  })

  it('「改回默认」暂存的是一个不可能与任何值相撞的哨兵,不是默认值本身', () => {
    // 真机 round-trip 抓到的那个单向门:把默认值写回去,盘上仍然留着一行,页面于是
    // 继续对着一个刚被要求「别再设了」的旋钮说「这是你设的」——而且把今天的默认值
    // 冻在了那儿。空串也当不了哨兵:它对五个感官旋钮已经是「显式清空」的意思。
    expect(src).toContain("Symbol('unset')")
    const body = bodyOf('knobRow')
    expect(body).toContain('state.pending.set(k.key, UNSET)')
    expect(body, '暂存默认值 = 那个单向门本身').not.toContain('state.pending.set(k.key, k.default)')
  })

  it('按钮出现的条件是「盘上真有一行」,不是「当前值不等于默认值」', () => {
    // 后者在有人把默认值显式写进文件时会让按钮凭空消失,而那正是最需要它的那一刻。
    const body = bodyOf('knobRow')
    expect(body).toContain("prov === 'file'")
    expect(body).not.toContain('shownValue(k) !== k.default')
  })

  it('保存走的是 config-unset 这条删除路径', () => {
    // config-set <KEY> <default> 只会再写一行,不会让那一行消失。
    expect(bodyOf('saveAll')).toContain("'config-unset'")
  })
})

describe('UXCFG-M3 provenance 判定', () => {
  const { provenanceOf, shownValue } = provenanceSlice()
  const knob = (fileValue: string | null, envValue: string | null) => ({
    key: 'GOTONG_WEB_PORT', default: '3000', summary: '', fileValue, envValue,
  })

  it('文件写过、环境没设 ⇒ 来自文件', () => {
    expect(provenanceOf(knob('4000', null))).toBe('file')
    expect(shownValue(knob('4000', null))).toBe('4000')
  })

  it('两处都没有 ⇒ 默认值', () => {
    expect(provenanceOf(knob(null, null))).toBe('default')
    expect(shownValue(knob(null, null))).toBe('3000')
  })

  it('只有环境有 ⇒ env-only', () => {
    expect(provenanceOf(knob(null, '9000'))).toBe('env-only')
    expect(shownValue(knob(null, '9000'))).toBe('9000')
  })

  it('环境与文件不一致 ⇒ 环境赢,而且如实说是环境赢', () => {
    // 这一条守的是那句诚实话:页面上那个值不是你在这里填的,改它得去 systemd。
    expect(provenanceOf(knob('4000', '9000'))).toBe('env')
    expect(shownValue(knob('4000', '9000'))).toBe('9000')
  })

  it('UXCFG-M1 把文件值注进了环境 ⇒ 仍然算「来自文件」', () => {
    // 承重:M1 之后 `envValue` 非空**不再**意味着「在这个页面之外设过」。两边一样
    // 的时候按文件算,于是页面对自己刚写下的那一行不会反过来说「这是环境设的、
    // 你改不了」。
    expect(provenanceOf(knob('4000', '4000'))).toBe('file')
  })

  it('空串永远不算环境设过 —— 跟 env() 与 loadManagedEnv 同一套语义', () => {
    expect(provenanceOf(knob('4000', ''))).toBe('file')
    expect(provenanceOf(knob(null, ''))).toBe('default')
  })
})

describe('UXCFG-M3 装配', () => {
  it('app.html 真的加载了这张样式表', () => {
    expect(readFileSync(APP_HTML, 'utf8')).toContain('/setting-ui.css')
  })

  it('渲染器与它的样式表,要么都预缓存、要么都不 —— 不许一半陈旧', () => {
    // SHELL-M3 的「一对文件各自陈旧」陷阱:一个走预缓存、一个走运行时缓存,
    // 就会出现新渲染器配旧样式(或反过来)的那种没人能复现的界面。
    const sw = readFileSync(SW_JS, 'utf8')
    const pre = sw.slice(sw.indexOf('const PRECACHE = ['), sw.indexOf(']', sw.indexOf('const PRECACHE = [')))
    expect(pre.includes('setting-ui.css')).toBe(pre.includes('setting-ops-ui.js'))
  })

  it('装配层真的把「这些键是我们自己注进去的」告诉了设置台', () => {
    // 服务端那半的承重接线。`readEffectiveConfig` 的减法是可选参数,漏传不会有
    // 任何类型错误——而漏传的后果是:任何人保存一次之后,页面把 hub 自己写的
    // 那份文件读回来当成「环境设的」,于是**每一个**旋钮都变成灰的、不可编辑,
    // 直到下次重启。没有别的测试够得着 main.ts,所以这道文本门就是那道保险。
    //
    // 锚在 `createSettingOpsService({ … })` 那一块之内,不是整份文件——`main.ts` 里
    // 现在有三个消费者(网页台/IM 台/管家的 `set_hub_config`),对着全文 `toContain`
    // 的话,任何一处还留着就够它绿,而漏的偏偏可能是网页那处。
    const main = readFileSync(MAIN_TS, 'utf8')
    const at = main.indexOf('createSettingOpsService({')
    expect(at, 'createSettingOpsService 的装配形状变了').toBeGreaterThan(-1)
    const block = main.slice(at, main.indexOf('\n  })', at))
    expect(block).toContain('envInjectedKeys: managedEnv.applied')
  })
})
