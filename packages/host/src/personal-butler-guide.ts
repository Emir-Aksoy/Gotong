/**
 * personal-butler-guide.ts — AFR-M4. 阿同的「随身向导+医生」:一个 benign
 * `gotong_guide` 工具,按 topic 取策展知识卡;不带 topic = 目录页。
 *
 * 为什么长这样(AFR-M0 腿 B):
 * - **一个工具,不是 N 个** —— 工具面刚目录化瘦身(AFR-M3),再撒十个 guide_*
 *   工具就是回头路;目录页让模型不加载全量也知道有什么。
 * - **卡 = 手写常量随包出货** —— 生产机上没有 docs/zh/(npm 包不含仓库文档),
 *   模型的框架知识必须策展成卡随代码走;LSA-M3 纪律:**宁少列也核准**,卡里
 *   每条命令/env/工具名都对实仓核过,并由防腐测试钉死(pins)。
 * - **热路径零 LLM** —— 纯常量渲染,零 surface 零依赖;知识以工具结果进上下文,
 *   用完即走,不碰缓存前缀(AFR 边界①③)。
 * - **知识 ≠ 授权** —— 卡教「怎么做」,真动手(改配置/花钱/对外)照过既有闸;
 *   每张卡渲染尾都带这句红线(AFR 边界④)。
 *
 * 本工具进目录长尾(butler-tool-tiers.ts):它正是 AFR-M0 说的「第一个长尾
 * 租户」—— 低频、按需、说明书型。卡内点名目录工具时随手标「经 use_tool」。
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** 一张策展知识卡。pins 是防腐测试逐条核对的载重事实清单。 */
export interface ButlerGuideCard {
  /** topic id(模型传给 gotong_guide 的键)。 */
  id: string
  /** 卡标题(目录页与整卡首行)。 */
  title: string
  /** 目录页一句话。 */
  oneLiner: string
  /** 卡正文(静态常量,防腐测试钉 ≤500 估 token)。 */
  body: string
  /** 载重事实钉:测试断言每条真出现在 body 里且对得上实仓。 */
  pins?: {
    /** `gotong <子命令>` —— 必须存在 packages/cli/src/commands/<名>.ts。 */
    commands?: readonly string[]
    /** GOTONG_* 环境变量 —— 必须在 scripts/gotong-env-registry.txt 登记。 */
    envs?: readonly string[]
    /** 阿同工具名 —— 必须在分层名单(一等/目录)或 governed/memory 已知集里。 */
    tools?: readonly string[]
    /** IM 斜杠动词(不带斜杠) —— 必须是 im-adapter 命令解析器的 case。 */
    imVerbs?: readonly string[]
  }
}

const CARDS = [
  {
    id: 'framework-map',
    title: '框架一张图:这些东西怎么组合',
    oneLiner: 'agent/工作流/定时/连接器/联邦分别是什么、怎么拼在一起',
    body: [
      '骨架:hub 只路由消息、派任务、记 transcript —— 决策永远在参与者手里(人和 agent 是同一种 Participant,同权)。',
      '- **agent**:一个常驻助手(模型 + 人设 + 工具)。面板 Agents 卡建;我也能替成员建/改(要成员确认)。',
      '- **工作流**:多步流程(YAML),步可以是 agent、真人审批(human 步)、甚至对端 hub。跑一次=一个 run,状态 done/failed/suspended(停在等人批)。',
      '- **定时**:schedules 给工作流上闹钟(如每早 7 点晨报),零模型参与的调度环。',
      '- **连接器**:MCP 接外部工具(笔记/日历/搜索…);框架不存外部数据,凭证进金库。',
      '- **联邦**:hub 之间策展互联(peer),跨 hub 派活走双边令牌 + 白名单 + 审批闸。',
      '- **状态都是磁盘文件**:`.gotong/` 目录就是整个房间,复制目录=搬走房间。',
      '想知道我现在真实能干什么,用 list_my_capabilities(一等工具)看清单。',
    ].join('\n'),
    pins: { tools: ['list_my_capabilities'] },
  },
  {
    id: 'backup',
    title: '备份怎么做(给自己留一条回家的路)',
    oneLiner: '整空间或分档(身份/+关系)打包;主钥默认不进档案,带上=档案即凭证',
    body: [
      '在部署机上跑:`gotong backup <space目录> <备份目录>`(例:`gotong backup .gotong ~/backups`)。产出 .tar.gz 归档 + sha256 清单,WAL 安全。',
      '- **三档可选**:`--tier=identity` 只打包签名钥+公开名片(最小「我还是我」,小到可打印);`--tier=relations` 再加 peers 非密投影(恢复「认识谁」——令牌在金库**不随档**,重连要对端重新发令牌);不带 --tier = 全空间。子集档绝不含金库/主钥。',
      '- **主钥默认不进档案**:金库仍是密文,档案丢了也不泄密;但恢复后要读回金库需要你另存的主钥。',
      '- `--include-master-key` 会把主钥打进去 —— **档案即凭证**:谁拿到这份档案谁就能解开金库,只放你完全信任的地方(不可与 --tier 同用)。',
      '- 备份的真实失败模式是「没人提醒你做」:定个日子,或让我提醒你。',
      '- 铁律:**没演练过的备份等于没有备份** —— 演练步骤看 restore-drill 卡。',
    ].join('\n'),
    pins: { commands: ['backup'] },
  },
  {
    id: 'restore-drill',
    title: '恢复演练(证明备份真的能回来)',
    oneLiner: '五步在新目录把备份跑起来,不碰生产空间',
    body: [
      '1. 先做一份新备份:`gotong backup .gotong ~/backups`,记下打印的归档名。',
      '2. 恢复到**演练目录**(不是生产目录):`gotong restore ~/backups/<归档>.tar.gz --space /tmp/drill-space` —— restore 会先验 sha256 清单再落盘,清单不对当场拒。',
      '3. `gotong doctor` 对演练空间做体检(端口/空间/钥匙)。',
      '4. 起一个临时 host 指向演练目录,确认成员/工作流/记忆都在。',
      '5. 删掉演练目录。全程生产空间一个字节没动。',
      '主钥注意:默认备份不含主钥,演练时金库读不开是**预期行为**(数据结构都在);要连金库一起演练,得用带 `--include-master-key` 的档案(档案即凭证,小心存放)。',
    ].join('\n'),
    pins: { commands: ['backup', 'restore', 'doctor'] },
  },
  {
    id: 'workflow-failed',
    title: '工作流跑失败了,怎么查',
    oneLiner: '先看 run 状态,三种最常见原因逐个排',
    body: [
      '先用 list_my_runs(一等工具)看最近的 run:状态是 failed 还是 suspended。',
      '- **suspended 不是失败**:流停在等人批(human 步 / 出站审批),去 /me 收件箱处理,批完自动续跑。',
      '- **failed 常见三因**:①某步的参与者不在(agent 被删/没接上,错误常带 no_participant);②出站审批被拒(outbound_approval_denied);③上游步出错,下游没跑。',
      '- 看细节:/me「我的工作流」里点开那次 run,每步的输出与错误都在。',
      '- 想让我体检你的助手(模型 key 健不健康、有没有能调优的),经 use_tool 调 diagnose_my_agents。',
      '- 改流程:直接用大白话跟我说要改什么(改动会先给你过目再落盘)。',
    ].join('\n'),
    pins: { tools: ['list_my_runs', 'diagnose_my_agents'] },
  },
  {
    id: 'connector-down',
    title: '连接器(MCP)挂了,怎么查',
    oneLiner: '面板健康区看槽位,凭证占位在金库,重装即自愈',
    body: [
      '连接器 = 外接的 MCP 服务器(笔记/日历/搜索…)。排查顺序:',
      '1. 管理面板健康区看连接器槽位:没接=灰、健康=绿、挂了=红,红的会带原因。',
      '2. 凭证问题最常见:连接器配置里写的是 `${名字}` 占位,真值在金库 —— 面板金库页确认那个名字的行还在、值没过期(平台 token 会过期/被吊销)。',
      '3. 面板 MCP 服务器卡重装/重连一次 —— 连接是「连一次永续」,重生即新鲜。',
      '4. 标了「数据离开本机」(dataLeavesBox)的连接器,数据会发给外部服务商,挂了先看对方服务状态页。',
      '红线:占位换真值只发生在服务端;把 key 明文贴给我是不行的,我对凭证只读。',
    ].join('\n'),
  },
  {
    id: 'llm-outage',
    title: 'LLM 断供(大脑连不上),怎么办',
    oneLiner: '看病名对症:key 问题换 key,额度问题充值/换模型,网络问题等自愈',
    body: [
      '断供时我会主动播报病名(auth=key 不对/quota=额度用尽/rate_limited=限流/network·timeout=网络),面板健康页也有红条,恢复后我会再说一声。',
      '- **只读活体校验**:check_llm_key(一等工具)拉模型列表验 key,不生成内容不花 token。',
      '- **备用链**:面板 Agents 卡给 agent 配 fallbacks(最多 5 个候选),主模型挂了自动顺位降级,面板黄条=正在靠备用顶着。',
      '- **测试路由**按钮逐候选发一个最小提问报 ok/病(这个会花一点点 token,手动才跑)。',
      '- 想看我现在用哪条候选链、健不健康:经 use_tool 调 list_my_llms。',
      '- 想找免费/低价的新 provider:经 use_tool 调 discover_llm_providers(注册和录 key 永远是你来,我不代办)。',
    ].join('\n'),
    pins: { tools: ['check_llm_key', 'list_my_llms', 'discover_llm_providers'] },
  },
  {
    id: 'peer-offline',
    title: '对端 hub 连不上,怎么查',
    oneLiner: '先看名片,再查令牌与白名单;重启后会自动退避重拨',
    body: [
      '1. **预检名片**:`gotong peer-card <对端 https 地址>` 取对端公开名片,连 404 都是正常答案(名片是增强不是前置);签了名会验完整性。',
      '2. 面板联邦页看那条边:令牌失效就让对端重发一个(对端跑 `gotong mint-peer-token`),粘回边上。',
      '3. **白名单 fail-closed**:能力白名单空着=一律拒(这是设计不是故障);要跨 hub 派活,先把允许的能力写进白名单。',
      '4. 一方重启后会自动退避重拨,不用手动;两边都在 NAT 后时,至少一边要有公网入站端口(agent 协议与联邦可共用 GOTONG_WS_PORT,同端口自动分流)。',
      '5. 新边默认最低信任档,审批更勤是预期;owner 在面板逐档提升。',
      '看互联清单:list_peers(一等工具);跨 hub 发问走 ask_peer,发出前要你点头。',
    ].join('\n'),
    pins: {
      commands: ['peer-card', 'mint-peer-token'],
      envs: ['GOTONG_WS_PORT'],
      tools: ['list_peers', 'ask_peer'],
    },
  },
  {
    id: 'im-bridge',
    title: '把我接进你的聊天软件(IM 桥)',
    oneLiner: 'token 进金库,/me 出 6 位码,聊天窗里 /bind 绑定',
    body: [
      '支持 Telegram/Matrix/飞书/Slack/Discord/QQ/微信(iLink)。以 Telegram 为例:',
      '1. 平台侧建 bot 拿 token(Telegram 找 @BotFather)。',
      '2. token 给 host:环境变量 GOTONG_TELEGRAM_BOT_TOKEN,或面板向导粘贴(落金库)。重启 host 生效。',
      '3. 成员在 /me「绑定 IM」卡生成 6 位码,去聊天窗对 bot 发 `/bind <码>` —— 绑定后那个聊天窗就是你和我的专线。',
      '4. 待办也能在聊天窗批:`/inbox` 看等你确认的事,`/approve <短码>` 批准、`/deny <短码>` 拒绝(普通事项;跨 hub/花钱/对外类仍要去网页确认)。',
      '注意:IM 平台方能看到经它服务器的消息,敏感内容建议走网页端。',
    ].join('\n'),
    pins: { envs: ['GOTONG_TELEGRAM_BOT_TOKEN'], imVerbs: ['bind', 'inbox', 'approve', 'deny'] },
  },
  {
    id: 'federation-edge',
    title: '策展一条联邦边(和另一个 hub 互联)',
    oneLiner: '令牌换令牌 + 能力白名单 + 信任分档,三样都是显式的',
    body: [
      '联邦=两个 hub 显式互认,不存在「自动发现就自动信任」。',
      '1. **预检**(可选但推荐):`gotong peer-card <对端地址>` 先看对端名片是谁、开了什么。',
      '2. **令牌**:每边各自签发:`gotong mint-peer-token --peer-id=<对方 id>`,把令牌交给对方;对方在面板联邦页添加这条边(地址 + 令牌)。',
      '3. **能力白名单**:边上写明允许对方用哪些能力 —— 空着=一律拒(fail-closed 是默认地板)。',
      '4. **信任分档**:新边默认最低档(动作全要人批);处久了 owner 在面板显式提升,档越高审批越少,但危险动作任何档都要留痕。',
      '5. 跨 hub 出站动作(如 ask_peer)发出前要成员点头;边上还可以再加 owner 出站审批,双闸。',
      '看现状:list_peers(一等工具)列互联与各边允许的能力。',
    ].join('\n'),
    pins: { commands: ['peer-card', 'mint-peer-token'], tools: ['list_peers', 'ask_peer'] },
  },
] as const satisfies readonly ButlerGuideCard[]

/** 全部知识卡(宽类型导出;字面量 id 联合见 {@link ButlerGuideTopic})。 */
export const BUTLER_GUIDE_CARDS: readonly ButlerGuideCard[] = CARDS

/** 卡 id 的编译期字面量联合:跨模块引用(面包屑等)卡改名/删卡当场红。 */
export type ButlerGuideTopic = (typeof CARDS)[number]['id']

/** 目录页:全部卡的 id + 一句话(模型不取整卡也知道有什么)。 */
export function renderGuideDirectory(): string {
  const lines: string[] = [`【框架向导目录】共 ${BUTLER_GUIDE_CARDS.length} 张知识卡:`]
  for (const c of BUTLER_GUIDE_CARDS) lines.push(`- ${c.id} — ${c.title}:${c.oneLiner}`)
  lines.push('取整卡:再调一次 gotong_guide,topic 传上面的卡 id。')
  return lines.join('\n')
}

const CARD_FOOTER =
  '(红线:这张卡是静态策展知识,教「怎么做」不代表「已授权」——真动手改配置/花钱/对外,照常走审批闸。)'

/** 整卡渲染;未知 topic 诚实退回目录页(不报错,不让一轮死在拼写上)。 */
export function renderGuideCard(topic: string): string {
  const card = BUTLER_GUIDE_CARDS.find((c) => c.id === topic)
  if (!card) return `没有叫「${topic}」的卡。\n${renderGuideDirectory()}`
  return `【${card.title}】\n${card.body}\n${CARD_FOOTER}`
}

/**
 * AFR-M5 面包屑:零 LLM 播报(BE-M5 运行播报 / CARE 断供卡 / 腿 C 备份提醒)
 * 尾部的静态 topic 指针。播报走 IM 直推、不经对话轮,面包屑的机制是**让成员
 * 照抄问句**:问句(=卡标题)出现在成员下一条消息里,模型对目录即拉对卡 ——
 * 所以指针必须是成员会照抄的自然问话,绝不甩生工具名(gotong_guide/use_tool
 * 是模型的事,不是成员的话)。topic 是编译期字面量联合,卡改名/删卡时引用处
 * 当场红,面包屑结构性不指空。拼静态串不是决策,热路径仍零 LLM(AFR 边界①)。
 */
export function guideBreadcrumb(topic: ButlerGuideTopic, lead = '想看修法'): string {
  const card = BUTLER_GUIDE_CARDS.find((c) => c.id === topic)
  return `${lead},问我「${card?.title ?? topic}」就行。`
}

export const BUTLER_GUIDE_TOOL: LlmToolDefinition = {
  name: 'gotong_guide',
  description:
    '框架随身向导+医生:备份/恢复演练/工作流失败/连接器挂/LLM 断供/对端连不上/接 IM/联邦互联这些「怎么做」的策展知识卡。不带 topic = 先看目录页。成员问框架层面的「怎么弄/坏了怎么修」,先取对应卡再回答,别凭印象编命令。卡教做法不给授权:真动手照常走审批闸。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '目录里的卡 id(如 backup / restore-drill / im-bridge)。不带 = 返回目录页。',
      },
    },
    additionalProperties: false,
  },
}

class ButlerGuideToolset implements LlmAgentToolset {
  listTools(): LlmToolDefinition[] {
    return [BUTLER_GUIDE_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'gotong_guide') {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    const topic = typeof args.topic === 'string' && args.topic.trim() !== '' ? args.topic.trim() : null
    const text = topic ? renderGuideCard(topic) : renderGuideDirectory()
    return { content: [{ type: 'text', text }] }
  }
}

/** 工厂接线用:零依赖零 surface,纯常量渲染。 */
export function buildButlerGuideToolset(): LlmAgentToolset {
  return new ButlerGuideToolset()
}
