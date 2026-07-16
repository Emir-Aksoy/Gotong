/**
 * AFR-M4 防腐门 — 知识卡的每条载重事实钉死对实仓(镜像 LSA-M3 EXPECTED_* 纪律:
 * 宁少列也核准 —— 卡里一条错命令是真伤害)。
 *
 * 四层钉:
 *   ① pins 正向核:每条 command 真存在于 packages/cli/src/commands/、每个 env
 *      真登记在 scripts/gotong-env-registry.txt、每个工具名真在分层名单/已知集、
 *      每个 IM 动词真是 command-parser 的 case;且每条 pin 真出现在卡正文
 *      (防 pins 台账烂掉)。
 *   ② 反向扫描:正文里任何 `gotong <子命令>` / `GOTONG_*` 字样都必须被 pin ——
 *      没核准的命令/env 根本进不了卡。
 *   ③ 目录 ∪ 卡 = 全集;未知 topic 诚实退目录;每卡 ≤500 估 token(M1 同尺)。
 *   ④ 卡内点名目录工具必须带 use_tool 提示(镜像 M3「指路不指空」,落在卡文本层)。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUTLER_GUIDE_CARDS,
  BUTLER_GUIDE_TOOL,
  buildButlerGuideToolset,
  renderGuideCard,
  renderGuideDirectory,
} from '../src/personal-butler-guide.js'
import {
  BUTLER_DIRECTORY_BENIGN,
  BUTLER_FIRST_CLASS_BENIGN,
} from '../src/butler-tool-tiers.js'
import { estimateTokens } from '../src/butler-toolface-report.js'

const CLI_COMMANDS_DIR = join(__dirname, '../../cli/src/commands')
const ENV_REGISTRY = readFileSync(join(__dirname, '../../../scripts/gotong-env-registry.txt'), 'utf8')
const IM_PARSER_SRC = readFileSync(
  join(__dirname, '../../im-adapter/src/command-parser.ts'),
  'utf8',
)

/** 卡内可点名的工具全集:分层名单 + governed + agent 内建 memory。 */
const KNOWN_TOOLS = new Set<string>([
  ...BUTLER_FIRST_CLASS_BENIGN,
  ...BUTLER_DIRECTORY_BENIGN,
  'create_agent',
  'edit_agent',
  'delete_agent',
  'edit_workflow',
  'create_workflow',
  'ask_peer',
  'remember',
  'remember_procedure',
  'refine_procedure',
  'recall',
  'forget',
])

describe('AFR-M4 — gotong_guide 知识卡防腐门', () => {
  it('卡量 6–10、id 唯一且 kebab、标题/一句话非空', () => {
    expect(BUTLER_GUIDE_CARDS.length).toBeGreaterThanOrEqual(6)
    expect(BUTLER_GUIDE_CARDS.length).toBeLessThanOrEqual(10)
    const ids = BUTLER_GUIDE_CARDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of BUTLER_GUIDE_CARDS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/)
      expect(c.title.length).toBeGreaterThan(0)
      expect(c.oneLiner.length).toBeGreaterThan(0)
      expect(c.body.length).toBeGreaterThan(0)
    }
  })

  it('每张整卡渲染 ≤500 估 token(M1 同一把尺),且尾带「知识≠授权」红线', () => {
    for (const c of BUTLER_GUIDE_CARDS) {
      const rendered = renderGuideCard(c.id)
      const tokens = estimateTokens(rendered)
      expect(tokens, `${c.id} 超预算:~${tokens}tk > 500tk`).toBeLessThanOrEqual(500)
      expect(rendered).toContain(c.title)
      expect(rendered).toContain('不代表「已授权」')
    }
  })

  it('目录 ∪ 卡 = 全集:目录页列出每张卡 id + 总数如实;未知 topic 诚实退目录', () => {
    const dir = renderGuideDirectory()
    expect(dir).toContain(`共 ${BUTLER_GUIDE_CARDS.length} 张`)
    for (const c of BUTLER_GUIDE_CARDS) expect(dir).toContain(`- ${c.id} — `)
    const miss = renderGuideCard('no-such-card')
    expect(miss).toContain('没有叫「no-such-card」的卡')
    expect(miss).toContain('【框架向导目录】')
  })

  it('pins 正向核:command/env/tool/imVerb 逐条对实仓 + 真出现在正文', () => {
    for (const c of BUTLER_GUIDE_CARDS) {
      for (const cmd of c.pins?.commands ?? []) {
        expect(
          existsSync(join(CLI_COMMANDS_DIR, `${cmd}.ts`)),
          `${c.id}:CLI 子命令 ${cmd} 不存在 packages/cli/src/commands/${cmd}.ts`,
        ).toBe(true)
        expect(c.body, `${c.id}:pin 的命令 ${cmd} 没出现在正文`).toContain(`gotong ${cmd}`)
      }
      for (const env of c.pins?.envs ?? []) {
        expect(ENV_REGISTRY, `${c.id}:env ${env} 未在注册表登记`).toContain(env)
        expect(c.body, `${c.id}:pin 的 env ${env} 没出现在正文`).toContain(env)
      }
      for (const tool of c.pins?.tools ?? []) {
        expect(KNOWN_TOOLS.has(tool), `${c.id}:工具名 ${tool} 不在分层名单/已知集`).toBe(true)
        expect(c.body, `${c.id}:pin 的工具 ${tool} 没出现在正文`).toContain(tool)
      }
      for (const verb of c.pins?.imVerbs ?? []) {
        expect(
          IM_PARSER_SRC.includes(`case '${verb}'`),
          `${c.id}:IM 动词 /${verb} 不是 command-parser 的 case`,
        ).toBe(true)
        expect(c.body, `${c.id}:pin 的动词 /${verb} 没出现在正文`).toContain(`/${verb}`)
      }
    }
  })

  it('反向扫描:正文里任何 gotong 子命令 / GOTONG_* 都必须被 pin(没核准进不了卡)', () => {
    for (const c of BUTLER_GUIDE_CARDS) {
      const cmds = new Set(c.pins?.commands ?? [])
      for (const m of c.body.matchAll(/`gotong ([a-z][a-z-]*)/g)) {
        expect(cmds.has(m[1]!), `${c.id}:正文提了 gotong ${m[1]} 但没 pin(未核准)`).toBe(true)
      }
      const envs = new Set(c.pins?.envs ?? [])
      for (const m of c.body.matchAll(/GOTONG_[A-Z0-9_]+/g)) {
        expect(envs.has(m[0]!), `${c.id}:正文提了 ${m[0]} 但没 pin(未核准)`).toBe(true)
      }
    }
  })

  it('卡内点名目录工具必须带 use_tool 提示(卡文本层的「指路不指空」)', () => {
    // gotong_guide 自己也在目录 —— 模型读到这张卡时刚经 use_tool 取的卡,豁免。
    const tail = BUTLER_DIRECTORY_BENIGN.filter((n) => n !== 'gotong_guide')
    for (const c of BUTLER_GUIDE_CARDS) {
      for (const name of tail) {
        if (!c.body.includes(name)) continue
        expect(
          c.body.includes('use_tool'),
          `${c.id}:点名了目录工具 ${name} 却没带 use_tool 提示 —— 模型会直调落空`,
        ).toBe(true)
      }
    }
  })

  it('工具面:单工具 gotong_guide;无参=目录、带 topic=整卡、未知外层名=isError', async () => {
    const ts = buildButlerGuideToolset()
    const defs = await ts.listTools()
    expect(defs.map((d) => d.name)).toEqual(['gotong_guide'])
    expect(defs[0]).toEqual(BUTLER_GUIDE_TOOL)

    const dir = await ts.callTool('gotong_guide', {})
    expect(dir.isError).toBeUndefined()
    expect((dir.content[0] as { text: string }).text).toContain('【框架向导目录】')

    const card = await ts.callTool('gotong_guide', { topic: 'backup' })
    expect((card.content[0] as { text: string }).text).toContain('备份怎么做')

    const bad = await ts.callTool('nope', {})
    expect(bad.isError).toBe(true)
  })
})
