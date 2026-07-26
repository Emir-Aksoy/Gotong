# 阿同对话连续性 — 每成员滚动会话窗（SESS）

> Status: 全落（纯核 + IM 腿 + 推送缝 + web 腿 + 装配）。
> Last updated: 2026-07-24

一句话:管家从「每轮全新失忆」变成「一场对话内记得自己刚说过什么」——
成员答「查一下」,模型看得见自己上一轮问的「要不要查天气」。

---

## 一、病与证据链

用户报告:阿同上一轮问「要不要查一个内容」,回它「查一下」,它反问「查什么」。

诊断出**三个叠加病因**,每个都在独立地制造失忆:

1. **transcript 层零历史**。每条 IM 消息派发成全新 task,模型的 `messages`
   数组只有当前一句。连续性此前全押在检索式记忆(episodic 捕获 → 冻结块
   再召回)上——那回答的是「关于这个成员我知道什么」,不是「我刚说了什么、
   在等什么答复」。
2. **`{text}` payload 不被认识**。IM 桥自由文本原来派 `payload: { text }`,
   而 `LlmAgent.buildRequest`(`packages/llm/src/agent.ts:496`)只认
   `prompt` / `topic` / `messages` / 字符串 payload——认不出就把**整个
   JSON 字符串化**给模型看;同时 episodic 捕获也认不出成员原话,记成
   `User: im:lark` 占位符(task title),长期记忆同步被污染。
3. **双脑转派黑洞**。DUO escalate 的专家结果走 `pushToMember` 推回成员,
   但从不进任何对话记录——下一轮模型完全不知道「专家办完了 X」这句话
   自己说过。

**语音疑点排除**(用户提出「会不会是引入语音后输出被忘了」):出站 TTS
是纯渲染层——`voiceClipFor` 在回复文本定稿**之后**才合成语音条,窗记录的
就是合成前的那份文本(`im-bridge.ts` free case 里 append 在 `reply(...)`
之前)。语音无罪;真凶是与语音同期上线的 DUO 黑洞 + `{text}` 捕获病,
时间上撞在一起造成了「引入语音后变傻」的观感。

## 二、市面参照(Hermes)

Hermes 的做法:每用户跨平台**持久会话**,完整 transcript 每轮全量喂回。
行业共识的分工是——**会话内连续性 = 上下文里的近期轮次;跨会话连续性 =
检索式记忆**。我们的骨架本来就有后一半(episodic 捕获 + 6h 蒸馏),缺的
只是前一半。

## 三、设计(方案 A,用户拍板)

**滚动会话窗骑既有 `payload.history` 缝**——`LlmAgent.buildRequest` 从
Phase 9 起就支持 history 前置(`agent.ts:505`),零内核改动。

### 纯核 `packages/personal-butler/src/session-window.ts`

- `ButlerSessionWindow`:file-first 每成员一个
  `<space>/butler/sessions/<userId>.json`(`encodeURIComponent` 防路径
  穿越;tmp+rename 原子写;坏文件隔离 `.corrupt-<ts>` 永不销毁)。
- **常量即合同,零新旋钮**:静默 60 分钟(`SESSION_IDLE_MS`)开新对话;
  窗保最近 12 条(`SESSION_MAX_TURNS`);单条截 2000 字
  (`SESSION_TURN_MAX_CHARS`)。
- `history()` 渲染保证 provider-safe:同角色连续条目合并(严格交替的
  provider 拒绝背靠背同角色);**尾部 user 条目丢弃**——当前句由
  buildRequest 紧随 history 追加,不丢会出现两条连续 user。
- `append()` **永不抛**(丢一条窗记录不能弄死这一轮),per-user promise
  链串行化写(IM 桥、web 路由、推送缝都在 host 单进程里)。

### IM 腿(`packages/host/src/im-bridge.ts`)

自由文本 case 的纪律:**读 history → 记 user 轮(派发前,说了就是说了)
→ 派发 → 记 assistant 轮(回复文本定稿后、发送前)**。payload 同时完成
**`{text}`→`{prompt}` 改名**——一个改名同时治好病因 ② 的两半(模型看到
纯文本;episodic 捕获记到成员原话)。

`deliverToMember` 咽喉(转派结果 / 运行播报 / 提醒 / 审批回推 / 断供恢复
播报的唯一出口)包一层:每次推送同时记 assistant 轮——**病因 ③ 的修复**,
「专家办完了」从此是管家「说过的话」。

### web 腿(`packages/web/src/me-routes.ts` + `main.ts` 适配器)

/me quick-chat 与 IM 共用**同一个窗实例**(im-bridge-wiring 构造,
`ImBridgesHandle.sessions` 再暴露,main.ts 适配成 `meChatSession`
surface)——飞书里聊到一半,网页上接着聊,是同一场对话(Hermes 的跨平台
模型)。

main.ts 适配器按 `localAgents.isButlerAgent(agentId)` 门控:**只有管家行
有窗**;quick-chat 也能对专家等其他 agent 说话,它们读到空、写入被弃
(fail-closed,`agents()` 读失败也归 false)——别的 agent 永远看不到、也
污染不了管家的对话。

## 四、记与不记(刻意的不对称)

| 场景 | 进窗? | 为什么 |
|---|---|---|
| IM 自由文本的直接回复(含失败行、park 回执) | ✅ | 发给成员的每个字都是「管家说过的话」,下轮必须知道 |
| `deliverToMember` 的一切推送 | ✅ | 同上(黑洞修复) |
| llmOutage 罐头大白话 | ❌ | 断供话术不是对话内容;user 轮已落但下轮渲染时被尾部-user-丢弃规则自然清掉 |
| web ok 且带文本的回复 | ✅ | `recordReply` 唯一记的形状 |
| web failed / suspended(park) | ❌ | route 拿不到 SPA 的渲染文本,不编造「说过」;待批意识由 A1 待办探针卡负责 |
| web 超时(504 后 dispatch 仍在飞) | ❌ | 成员没看到回复=管家没说出去;该 user 轮下轮被尾部丢弃,episodic 里仍有 |
| `/bind`、`/inbox` 等命令输出 | ❌ | 命令面不是对话,不走 free case |

## 五、边界(不可破)

- **窗 ≠ 记忆**:窗是短命的渲染辅助;长期记录仍走 episodic 捕获 + 6h
  蒸馏,`captureTurn` 一行未动。存量被污染的 `User: im:lark` 条目不清洗,
  留给蒸馏按相关性自然老化。
- **窗 ≠ 授权**:history 出现在 prompt 里不授予任何权限,governed 动作
  照 park。
- **管家层,不进内核**:纯核在 personal-butler,接线在 host/web 装配层;
  protocol/core/workflow 零改动。
- **无 surface = 字节不变**:不接 sessions,IM 派发 payload 与改造前逐字节
  一致(空 history 省略,不发 `[]`);web 同理。
- **零新旋钮**(env 注册表 114 冻结):三个阈值全是常量;surface 接不接
  就是开关。

## 六、群聊维度(GRP)

SESS 落地时窗只按 Gotong userId 归户——群里两个人跟阿同说话,各自一份
失忆窗,互相看不见对方刚说了什么。GRP 把群变成**一场对话**:

- **群窗键 `group:<platform>:<chatId>`**:群消息共享一个 room-scoped 窗,
  不再每说话人各一份。披露姿态保守——窗里只装群内本来人人可见的内容,
  =零新披露;群窗与私窗是两场对话,永不互串(e2e 钉死)。
- **说话人标注**:群轮次带 `名字: 文本` 前缀,且名字骑 **prompt 本身**
  (不是只进 history)——说话人自己的 episodic 捕获因此仍归户正确。
  名字来自 host wiring 注入的 `memberName`(identity displayName 同步读),
  缺省回落 Gotong userId。
- **记忆仍按说话人归户**:capture 只吃 `payload.prompt`,群友的话只以
  history 形式当上下文,绝不进别人的长期记忆。
- **群 ≠ 个人推送地址**(顺手修的既有披露洞):此前群消息会把成员的
  reachable 路线整行覆盖成群 chatId——审批提醒/转派结果会当众落在群里。
  修法=`recordReachable` 对群消息不记 chatId(仍记活跃度,freshness/outbox
  flush 照常),push 回落 `platformUserId` 直发 DM(飞书 open_id 是语义
  等价目的地);成员下次私聊即恢复 DM 路线。
- **桥边界**:im-adapter `ImMessage.chatKind?: 'direct' | 'group'`,缺席=
  按 direct 保守处理。飞书 DM 与群同用 `oc_` 前缀 chatId,`chat_type` 是
  唯一可靠判别,已映射(p2p→direct / group→group / 未知→缺席)。
- **触发策略在平台侧**:飞书标准 bot 权限本来只投递 @提及消息=天然
  @-mention 闸;桥内不做 bot-mention 判定(事件里拿不到 bot 自己的
  open_id,做了就是猜)。「读全群消息」权限不要求也不建议。命令面在群里
  也应答是既有行为,敏感命令(如 `/inbox`)建议私聊。

验收:im-lark 91(chat_type 映射)/ host 2467+5 skip(im-session-window-e2e
7=4+3:群共窗+标注 / 群窗私窗分离 / 群非推送地址+DM 回落)/ 四门 PASS,
零新旋钮(chatKind 是类型字段、memberName 是注入缝,均非 env)。

## 七、验收与已知场外

验收:personal-butler 112(纯核 14)/ host 2428+5skip(新 e2e 4:字节
不变 / 首条无 history + 派发前落 user / 第二条骑 history 且不含当前句 /
推送进窗)/ web 1464(新 SESS 路由测 5:无 surface 字节不变 / 空 history
省略 + 双向记录 / prior 轮原样上 payload / failed 不记 assistant / stream
分支同记)全绿;四门 PASS(main.ts 2713/2725、server.ts 2386/2395、
me-routes 2872/2885 三棘轮显式提额留余量)。

已知场外(同型 `{text}` 病,不在管家链路,已挂独立票):A2A 入站
`a2a-server.ts:223` 派 `{text}`(命中 LlmAgent 会看到 JSON);CLI repl
`loop.ts:174,184` 自闭环合同(repl 发、repl 示例 participant 读)。

Codex 交叉审:本轮额度耗尽(2026-07-28 恢复)未能执行;已按同一聚焦
清单完成自审(改名遗漏面全仓扫 / 双记漏记 / 竞态 / 穿越),用户可在额度
恢复后补一轮 `/codex-review`。
