/**
 * atong-librarian — LIB capstone: 知识自治全链路,四幕自断言。
 *
 * LIB track 的论点:阿同要管好**大量**知识文件,靠的不是更大的上下文,而是
 * 「进货区(每轮必付的记忆)搬到上架区(按需付费的文件树)+ 一张 ≤500tk 的
 * 自著索引卡当常驻导航」。本 demo 用**真件零重写**把四条承重承诺跑成断言:
 *
 *   幕1  进货→上架(M4):真 `knowledgeLibrarianReviewer` + 真 `MemoryFileHandle`
 *        ——主题事实写进 knowledge/ 文件后才双时态下架(validTo+promotedTo 一次
 *        补丁,条目还在盘上=可逆);第二 tick 候选掉下门槛,零模型调用(收敛)。
 *   幕2  百文件树导航(M2+M3+M1 尺):树长 25×(→100+ 文件),策展层级索引不动
 *        ⇒ 真 `buildButlerKnowledgeIndexCard` 渲染的常驻卡**逐字节不变**
 *        (M1 尺 `estimateTokens` 量的)——常驻段不随知识总量长;胖索引病态
 *        也被 ≤500tk 顶封死(响亮 N/M 标记,no silent caps);正文按需深读。
 *   幕3  归档不丢(M2):archive/ 挪走不真删,前缀照读逐字节同;INDEX 不可归档。
 *   幕4  知识≠授权:真 `PersonalButlerAgent` 靠常驻索引卡找到知识文件、读出
 *        「待办:发预算表」,对外发送照样 park 等审批——批准前零发送。
 *
 * No network, no API key, no LLM(summarize/provider 全是确定性脚本)。
 * Run:  pnpm demo:atong-librarian
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SuspendTaskError, type Logger, type Task } from '@gotong/core'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'
import {
  GovernedActionToolset,
  PersonalButlerAgent,
  createKnowledgeLibraryToolset,
  knowledgeLibrarianReviewer,
  META_PROMOTED_TO,
  openKnowledgeLibrary,
  readButlerGateState,
} from '@gotong/personal-butler'
import { closedMeta, isActive, validToOf, type MemorySummarizer } from '@gotong/personal-memory'
import { MemoryFileHandle, ownerDir } from '@gotong/service-memory-file'
import {
  buildButlerKnowledgeIndexCard,
  KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS,
} from '@gotong/host/butler-knowledge-index'
import { estimateTokens } from '@gotong/host/butler-toolface-report'

// ─── harness ──────────────────────────────────────────────────────────────────

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

const NOW = 2_000_000_000_000

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotong-librarian-demo-'))
  // 生产同款布局:<root>/user/alice/{semantic.jsonl, knowledge/} —— 记忆与
  // 图书馆同一屋檐,复制这个目录 = 搬走整个人(file-first)。
  const OWNER = { kind: 'user', id: 'alice' } as const
  const memory = new MemoryFileHandle({
    rootDir: root,
    owner: OWNER,
    config: { kinds: ['episodic', 'semantic', 'working'] },
    logger: silentLogger,
  })
  const kdir = join(ownerDir(root, OWNER), 'knowledge')
  const library = openKnowledgeLibrary({ dir: kdir })

  // ═══ 幕1 进货→上架:真图书馆员 reviewer,写前退后 + 双时态可逆 ═══
  console.log('━━━ 幕1 进货→上架:主题事实搬进 knowledge/,下架可逆 ━━━\n')

  await memory.remember({ kind: 'semantic', text: '老家厨房翻新预算敲定 1.2 万' })
  await memory.remember({ kind: 'semantic', text: '装修工头姓陈,周三来量尺' })
  for (const t of ['喜欢喝奶茶', '养了一只猫', '每天早上跑步', '生日是三月', '工作在软件公司', '会说三种语言', '喜欢看科幻电影', '住在槟城', '周末常去爬山', '对花生过敏']) {
    await memory.remember({ kind: 'semantic', text: t })
  }

  // 确定性「模型」:只替 LIBRARIAN prompt 说话,从 prompt 里读真实 id,把两条
  // 装修事实上架——主题判断做成脚本,管线全是真件。
  const counter = { calls: 0 }
  const summarize: MemorySummarizer = async ({ system, user }) => {
    if (!system.includes('LIBRARIAN')) return ''
    counter.calls++
    const ids = user
      .split('\n')
      .filter((l) => l.startsWith('- ') && (l.includes('厨房') || l.includes('工头')))
      .map((l) => l.slice(2, l.indexOf(':')).trim())
    return JSON.stringify({
      promotions: [
        { path: 'projects/装修.md', title: '装修', append: '- 厨房翻新预算 1.2 万\n- 工头姓陈,周三来量尺', factIds: ids },
      ],
      index: '# 我的知识库\n- projects/装修.md — 老家厨房翻新台账\n',
    })
  }
  // 上架写者 = 生产 host wrapper 同款一次补丁:CLOSE(validTo)+出处(promotedTo)。
  const patchMeta = memory.patchMeta!.bind(memory)
  const shelve = (e: MemoryEntry, path: string, validTo: number) =>
    patchMeta(e.id, { ...closedMeta(undefined, validTo), [META_PROMOTED_TO]: path }).then(() => undefined)

  const reviewer = knowledgeLibrarianReviewer({ library, summarize, shelve })
  const out1 = await reviewer({ memory, episodic: [], now: NOW })
  assert(out1.summary?.includes('shelved 2 facts into 1 file'), `幕1 上架小结不对: ${out1.summary}`)

  const reno = (await library.read('projects/装修.md')).text
  assert(reno.includes('# 装修') && reno.includes('厨房翻新预算 1.2 万') && reno.includes('工头姓陈'), '幕1 上架正文应完整落盘')
  assert((await library.read('INDEX.md')).text.includes('- projects/装修.md'), '幕1 INDEX 应指到新文件')

  const all1 = await memory.recall({ kinds: ['semantic'], k: 50 })
  const kitchen = all1.find((e) => e.text.includes('厨房'))!
  assert(kitchen !== undefined, '幕1 下架的事实必须还在盘上(可逆,不是 forget)')
  assert(validToOf(kitchen) === NOW && !isActive(kitchen, NOW), '幕1 下架 = CLOSE 区间(activeOnly 读侧不再浮出)')
  assert(kitchen.meta?.[META_PROMOTED_TO] === 'projects/装修.md', '幕1 出处标记应指向书架路径')
  assert(isActive(all1.find((e) => e.text.includes('奶茶'))!, NOW), '幕1 身份类事实留在记忆,不上架')

  // 收敛:再跑一 tick——剩 10 条活跃候选 < 门槛 12,零模型调用、盘上不漂移。
  const out2 = await reviewer({ memory, episodic: [], now: NOW + 6 * 3600_000 })
  assert(counter.calls === 1 && out2.summary === undefined, '幕1 第二 tick 应自门控空转(零 LLM)')
  assert(validToOf((await memory.recall({ kinds: ['semantic'], k: 50 })).find((e) => e.text.includes('厨房'))!) === NOW, '幕1 关闭时刻不漂移')
  console.log('  [证] 2 条主题事实上架(文件先落盘才下架),条目仍在盘上可翻案;第二 tick 零模型调用\n')

  // ═══ 幕2 百文件树:树长 25×,常驻卡逐字节不变;胖索引被顶封死 ═══
  console.log('━━━ 幕2 百文件树:常驻段不随知识总量长(M1 尺) ━━━\n')

  // 阿同把索引重排成**策展层级**:总索引只放热文件 + 分区指针,细目住各区
  // 索引文件里——这正是「自己编排层级」的纪律,常驻成本从此与货架体量解耦。
  const CURATED_INDEX = [
    '# 我的知识库',
    '- projects/装修.md — 老家厨房翻新台账',
    '- projects/搬家.md — 搬家台账(预算/待办)',
    '- projects/索引.md — 其余项目细目',
    '- people/索引.md — 亲友档案细目',
    '- ref/索引.md — 参考资料细目',
    '- self/索引.md — 我的教训与流程细目',
    '',
  ].join('\n')
  await library.write('INDEX.md', CURATED_INDEX)
  await library.write('projects/搬家.md', '# 搬家\n\n- 预算:搬家公司报价 RM 2,800\n- 待办:把搬家预算表发给陈师傅确认\n')

  const card = buildButlerKnowledgeIndexCard({ library })
  const cardA = (await card())!
  assert(cardA !== null && cardA.includes('【知识库索引】'), '幕2 常驻卡应渲染')
  assert(!cardA.includes('超出注入预算'), '幕2 策展索引应整卡放进预算(无截断)')
  const tokensA = estimateTokens(cardA)
  assert(tokensA <= KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS, `幕2 卡 ${tokensA}tk 应 ≤ ${KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS}tk`)
  const small = await library.list()

  // 树长 25×:四个分区各 25 篇正文 + 各自的分区索引——全程不碰总索引。
  for (const section of ['projects', 'people', 'ref', 'self'] as const) {
    const pointers: string[] = [`# ${section} 细目`]
    for (let i = 1; i <= 25; i++) {
      const path = `${section}/${section}-${String(i).padStart(3, '0')}.md`
      await library.write(path, `# ${section} 第 ${i} 篇\n\n这里是第 ${i} 篇的正文:预算票据、交接记录、联系人与来龙去脉,写全了给下一轮的自己按需来读。\n`)
      pointers.push(`- ${path} — 第 ${i} 篇的一句话摘要`)
    }
    await library.write(`${section}/索引.md`, `${pointers.join('\n')}\n`)
  }
  const grown = await library.list()
  assert(grown.activeCount >= 100, `幕2 树应长到 100+ 文件(实际 ${grown.activeCount})`)

  const cardB = (await card())!
  assert(cardB === cardA, '幕2 承重:树长 25×,常驻卡必须逐字节不变(索引没动=缓存照命中)')
  console.log(`  [证] 树 ${small.activeCount} 份/${small.activeBytes}B → ${grown.activeCount} 份/${grown.activeBytes}B,常驻卡 ${tokensA}tk 逐字节不变`)

  // 正文按需深读:常驻只付索引,细节从分区索引一跳到正文。
  assert((await library.read('ref/索引.md')).text.includes('- ref/ref-007.md'), '幕2 分区索引应指到细目')
  assert((await library.read('ref/ref-007.md')).text.includes('ref 第 7 篇'), '幕2 深读应拿到整篇正文')

  // 病态兜底:哪天索引写胖了(每文件一行),顶也把常驻段封死 + 响亮标记。
  const fat = grown.files.filter((f) => !f.archived).map((f) => `- ${f.path} — 这一行是给它写的说明文字`).join('\n')
  assert(estimateTokens(fat) > KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS, '幕2 胖索引 fixture 应真的超预算')
  await library.write('INDEX.md', fat)
  const cardC = (await card())!
  assert(estimateTokens(cardC) <= KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS, '幕2 胖索引渲染出的卡仍须 ≤ 预算')
  assert(/只显示前 \d+\/\d+ 行/.test(cardC), '幕2 截断必须响亮(N/M 标记),绝不静默')
  await library.write('INDEX.md', CURATED_INDEX) // 阿同精简回层级式
  assert((await card())! === cardA, '幕2 精简回来 → 卡回到原字节(重算≠变更)')
  console.log(`  [证] 胖索引(${grown.activeCount} 行)也被 ≤${KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS}tk 顶封死,标记响亮;精简回来卡字节复原\n`)

  // ═══ 幕3 归档不丢:挪进 archive/ 照读,INDEX 不可归档 ═══
  console.log('━━━ 幕3 归档不丢:archive/ 不是回收站,是书库地下层 ━━━\n')

  const before = (await library.read('ref/ref-003.md')).text
  const moved = await library.archive('ref/ref-003.md')
  assert(moved.to === 'archive/ref/ref-003.md', `幕3 归档落点不对: ${moved.to}`)
  const after = await library.list()
  assert(after.activeCount === grown.activeCount - 1 && after.archivedCount === 1, '幕3 上架区 -1,归档区 +1')
  assert((await library.read('archive/ref/ref-003.md')).text === before, '幕3 归档件必须逐字节还在、照读')
  let indexArchiveRefused = false
  try {
    await library.archive('INDEX.md')
  } catch (e) {
    indexArchiveRefused = e instanceof Error && e.message.includes('不归档')
  }
  assert(indexArchiveRefused, '幕3 INDEX.md 归档 = 自断导航,必须响亮拒')
  console.log('  [证] 归档件逐字节可读;INDEX.md 拒绝归档\n')

  // ═══ 幕4 知识≠授权:靠索引卡导航到待办,对外发送照样 park ═══
  console.log('━━━ 幕4 知识≠授权:知识文件里的「待办:发出去」也要主人点头 ━━━\n')

  let budgetSent = false
  const systems: string[] = []

  class ScriptedProvider implements LlmProvider {
    readonly name = 'scripted-librarian-demo'
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
      const last = lastUserMessage(req)
      const content = last?.content
      if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
        const blob = content.map((b) => String((b as { content?: unknown }).content ?? '')).join('\n')
        if (blob.includes('待办:把搬家预算表发给陈师傅')) {
          // 知识文件里读到了待办 → 动手发送:governed,必 park。
          yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'send-1', name: 'send_budget_to_contact', input: { to: '陈师傅', doc: 'projects/搬家.md' } } }
          yield { type: 'end', stopReason: 'tool_use' }
          return
        }
        if (blob.includes('预算表已发给')) {
          yield { type: 'text', text: '预算表发给陈师傅了,他确认后我再更新搬家台账。' }
          yield { type: 'end', stopReason: 'end_turn' }
          return
        }
        yield { type: 'text', text: '好。' }
        yield { type: 'end', stopReason: 'end_turn' }
        return
      }
      // 新轮:常驻索引卡(req.system 尾)就是导航——不背正文,按路径去读。
      systems.push(req.system ?? '')
      yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'read-1', name: 'read_knowledge_file', input: { path: 'projects/搬家.md' } } }
      yield { type: 'end', stopReason: 'tool_use' }
    }
  }

  const agent = new PersonalButlerAgent({
    id: 'butler',
    provider: new ScriptedProvider(),
    memory: inertMemory(),
    captureTurns: false,
    system: '你是这位成员的管家阿同。',
    benign: createKnowledgeLibraryToolset(library),
    governed: new GovernedActionToolset({
      tools: [
        {
          name: 'send_budget_to_contact',
          description: '把文件内容发给联系人(对外发送)',
          inputSchema: { type: 'object', properties: { to: { type: 'string' }, doc: { type: 'string' } } },
        },
      ],
      classify: async (name) =>
        name === 'send_budget_to_contact'
          ? { decision: 'approve', reason: '对外发送 — 需要主人确认' }
          : { decision: 'allow' },
      execute: async () => {
        budgetSent = true
        return { text: '预算表已发给陈师傅。' }
      },
    }),
    stableContext: buildButlerKnowledgeIndexCard({ library }), // M3 真缝,真卡
    maxToolRounds: 4,
  })

  const t: Task = { id: 'demo-t1', from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: '搬家的事推进一下。', createdAt: 1 }
  let parked: { state: unknown } | undefined
  try {
    await agent.onTask(t)
  } catch (e) {
    assert(e instanceof SuspendTaskError, '幕4 应抛 SuspendTaskError(park)')
    parked = { state: e.state }
  }
  assert(parked, '幕4 对外发送应 park,而不是内联完成')
  assert(systems[0]!.includes('【知识库索引】') && systems[0]!.includes('projects/搬家.md'), '幕4 开口前 system 就带索引卡(导航在常驻段)')
  const gate = readButlerGateState(parked.state)
  assert(gate?.pending?.approval.toolName === 'send_budget_to_contact', '幕4 park 的应是对外发送')
  assert(!budgetSent, '幕4 审批前绝不能已发送 — 知识文件写了待办也不是授权!')
  console.log(`  成员> 搬家的事推进一下。`)
  console.log(`  [/me 收件箱] 需要确认: ${gate!.pending!.approval.title}(原因: ${gate!.pending!.approval.reason})`)

  const resumed = await agent.onResume(t, { ...(parked.state as object), answer: { approved: true } })
  assert(resumed.kind === 'ok', '幕4 批准后 resume 应完成')
  assert(budgetSent, '幕4 批准后才真发送')
  console.log(`  [主人批准 ✅]\n  管家> ${(resumed.output as { text: string }).text}\n`)

  // ═══ 收官 ═══
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ 知识自治论点成立:')
  console.log('   幕1 主题事实上架:文件先落盘才双时态下架(可逆,带出处);第二 tick 零模型调用')
  console.log(`   幕2 树 ${small.activeCount}→${grown.activeCount} 份(25×),常驻卡 ${tokensA}tk 逐字节不变;胖索引被 ≤${KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS}tk 顶封死`)
  console.log('   幕3 归档不真删:archive/ 前缀照读逐字节同;INDEX 不可归档')
  console.log('   幕4 知识≠授权:索引卡导航 → 读待办 → 对外发送照样 park,批准前零发送')
  rmSync(root, { recursive: true, force: true })
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

function inertMemory(): MemoryHandle {
  return {
    recall: async () => [],
    remember: async (ne: NewMemoryEntry): Promise<MemoryEntry> => ({ id: 'x', kind: ne.kind, text: ne.text, ts: 0 }),
    list: async () => [],
    forget: async () => {},
    clear: async () => {},
  }
}

main().catch((err) => {
  console.error('[atong-librarian] fatal:', err)
  process.exit(1)
})
