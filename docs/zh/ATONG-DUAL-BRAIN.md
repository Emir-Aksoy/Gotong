# 阿同双脑 track(DUO)— 轻量接待 + 异步转派专家

> 状态:M0 计划(2026-07-17)。用户拍板:形态 **A(单管家双脑)**,接待模型
> **DeepSeek V4 Flash**(官方直连 `deepseek-v4-flash` @ `https://api.deepseek.com`,
> 缓存命中入价 ¥0.2/M;OpenRouter 亦有同款做备选)。
> 姊妹 track:[`ATONG-VOICE.md`](ATONG-VOICE.md)(飞书语音回复,同轮拍板)。

---

## 一、诉求与拍板记录

用户原话(2026-07-17):「多个模型配置而且具有动态路由能力,即由一个较轻量的模型
处理输入,获得一个即时的回复(主要是表示收到、打招呼、告诉准备怎么处理之类的)和
后续处理方式(包括使用高级的模型甚至多步工作流)。」形态三选一摆出后拍板 **A**。

**与边界①(热路径零 LLM)的关系,先钉死**:MODEL-ORCHESTRATION-STRATEGY.md 否掉的
是「**框架**在选路时现场用 LLM 判断消息类型」;本 track 的分诊决策者是**轻量模型
自己**(它是参与者,在治理 tool-loop 里决定要不要调 escalate 工具)——决策权在参与
者手里,框架只提供确定性的转派管道。这恰是北极星第一守则的正用,不是违例。

## 二、侦察结论(2026-07-17,file:line 一手核实)

**直接可复用(零新缝)**:
- per-task 模型覆盖缝已在:`llm/agent.ts:525` `req.model = payload.model`;
  maintenanceModel 五处 additive 先例(`space.ts:1176` → manifest 校验/导出回显 →
  agents-routes capture/echo → host reader `local-agent-pool.ts:1719`)可逐字节照抄;
- fire-and-forget 黄金先例:`workflow-schedule-sweeper.ts:355`
  `void this.hub.dispatch({...}).catch((err) => log.error(...))` —— 不 await、
  `.catch` 防 unhandledRejection,结果恒落 transcript(`hub.ts:978/993`);
- 回推管道开箱即用:`pushToMember`(`im-bridge.ts:827`)+ `ButlerOutbox.deliver`
  (file-first 重投),六个 sweeper 已是同一调用形状;
- 新工具样板:ask_peer/pack_backup = 1 个新 builder 文件 + factory 三行
  (import / build / push 进工具集);
- `ask_my_agent` 是 explicit dispatch 到自己名下 agent 的**语法先例**
  (`personal-butler-ask-agent.ts:127`,含 roster.listOwned 归属校验),但它是
  **同步 await** 的一问一答,escalate 不能直接复用,要另写异步版。

**硬约束(设计必须绕开)**:
- **IM 无中途流式**:`chatChunkSinks` 只服务 web /me SSE(`local-agent-pool.ts:428`),
  IM free 分支是整轮 `await dispatch` 后一次性 reply(`im-bridge.ts:440-455`)——
  「先回执后转派」**不能**靠流式吐第一段,必须做成**轮内 fire-and-forget 起重活、
  轮本身快速结束返回回执**,两条消息(回执→稍后结果)是 IM 的自然形态;
- **回推方向不对称**:pushToMember 只盖 IM 成员;web-only 成员的转派结果落
  transcript(/me 可见),拿不到主动推 —— v1 如实接受,不新开 web 推送缝;
- **跨 provider 事实**:接待 Flash(DeepSeek)与专家(生产现 LongCat)是两家 ——
  「行内换模型名」(maintenanceModel 同构)盖不住,**专家必须是独立 managed
  agent**;这反而更干净:专家自动获得完整既有机制(候选链/熔断/面板/测试路由/
  per-agent key),零新造。

## 三、设计定型

```
成员消息 → 阿同(接待脑,spec.model=deepseek-v4-flash)
             ├─ 小事:直接答(大多数消息,快而便宜)
             ├─ 重活:调 escalate(task_summary)
             │        └─ void hub.dispatch({strategy:{kind:'explicit',
             │             to: spec.escalateTo}, payload:{text}, origin:{userId}})
             │               .then(result → pushToMember(userId, 结果))
             │               .catch(log + pushToMember 失败话术)
             │        工具立即返回「已转派」→ 模型接着输出回执 → 轮结束
             └─ 多步:既有 create_workflow / 工作流工具(已有,不新造)
专家 agent(spec.escalateTo 指向,如 LongCat 配置)跑完 → 结果回推同一聊天窗
```

- **`escalateTo?: string`**(agent id)= 本 track 唯一 spec 新字段,additive,
  照 maintenanceModel 五处。**owner 配置转派目标**,不让模型自由填 target ——
  权限面最窄(模型只有「转/不转」一个决定,转给谁是人定的);
- **escalate 是 benign**:与 ask_my_agent 同权限面(explicit dispatch 到自己
  名下 agent,hub 内零出网),花的是 owner 自己配的 key,与管家自己跑 LLM 同性质;
  执行前仍做 roster 归属校验(ask_my_agent 同款,fail-closed);
- **回执纪律钉在 persona**(spec.system 追加静态文案,NA-M3 稳定段缓存友好,
  一次性重缓存)——不硬编码进框架,文档给推荐文案,工具描述里同步钉
  「先告诉成员你收到了、准备怎么办,再调本工具」;
- **转派结果回推**是本 track 唯一新编排:escalate 工具在 `.then` 回调里持有
  userId 调注入的 push 句柄;push 不可达(web-only/桥断)→ 结果已在 transcript,
  warn 一次不重试(outbox 重投是 push 内建的,不另造)。

## 四、不可破边界

1. **热路径零框架 LLM** —— 分诊决策在轻量模型(参与者)手里,框架只提供
   escalate 管道(确定性 dispatch + 回推),永不替模型判断「该不该转」;
2. **opt-in 字节不变** —— `escalateTo` 未设 = escalate 工具根本不注册,
   工具面/prompt/行为与今天逐字节一致;
3. **治理闸零绕过** —— 专家 agent 跑的是普通 managed agent 轮;若将来专家也
   带 governed 工具,park/审批照旧 —— 转派不是提权;escalate 本体 benign 但
   归属校验 fail-closed(target 不在自己名下 = 拒);
4. **内核零改动** —— core 只加 additive 可选字段(Hub 不解释 `escalateTo`),
   protocol/workflow 零触碰;零新 env 旋钮(spec 字段非旋钮,MR-M2 先例);
5. **诚实回执** —— 回执话术不承诺送达方式细节;转派失败(no_participant/
   spawn 失败)必须回推失败话术,绝不静默丢活。

## 五、里程碑

- **M1 配置面 ✅(2026-07-17 落地)**:core `ManagedAgentSpec.escalateTo?: string`
  + web manifest 校验/导入/导出回显 + agents-routes capture/adapt-echo +
  admin-src `_editingEscalateTo` capture-echo(五处照抄 maintenanceModel;CLI
  `buildPutBody` 走 `/:id/export` manifest 全字段 echo,零改动自动带上)。
  **设计修正(与本节原计划的偏差)**:原计划的 host 异步 reader
  `butlerEscalateTarget()`(call-time 解析)**没有建** —— 侦察证实 PUT 编辑走
  `applyAgentEdit` → lifecycle 重启整行,spawn 时快照永不过期,故改为 pool 在
  spawn 时把 `record.managed.escalateTo` 经 factory 第三参 `ButlerRowExtras`
  传入(改完配置=行重启=新值生效,语义与 reader 等价但少一条异步缝)。
- **M2 escalate 工具 ✅(2026-07-17 落地)**:`host/src/personal-butler-escalate.ts`
  (benign,11 单测):空摘要拒 → roster 归属校验(fail-closed,越权/漂移零派发)
  → `void dispatch({explicit → escalateTo, origin:{userId}}).then(逐 kind 诚实
  回推, 失败 log+回推「没能启动」)` → 立即返回「已转派」回执;push 句柄走
  `ButlerFactoryRefs.memberPush` 骑 main.ts 既有 lazy `butlerPushRef`(IM 桥
  未接=web-only 被动送达,结果仍在 transcript);工具进 AFR 一等 benign 面
  (接待模型日常动词)+ 三件套登记(tiers 名单/toolface 报告/防腐门)。
- **M3 capstone + 推荐文案 ✅(2026-07-17 落地)**:`examples/atong-dual-brain`
  四幕自断言(真 `buildButlerEscalateToolset` 走 `@gotong/host/butler-escalate`
  dist 子路径,deferred 控制专家完成时机,零网络零 key 零 LLM):幕1 权限面
  最窄(schema 只收 task_summary,无 target 参数)/幕2 回执先于结果(回执返回
  时专家仍在跑,完成后恰好一条推送回同一成员)/幕3 fail-closed(外人 target
  响亮拒+零派发)/幕4 诚实失败(派发炸了回推失败话术);
  `pnpm demo:atong-dual-brain` exit 0;接待 persona 推荐文案见下节。
- **M4 生产部署(需用户 DeepSeek key)**:建/改生产 agent 编排(阿同→Flash 接待
  + expert agent 承 LongCat 配置),`gotong model` 配 Flash,persona 更新,
  真机 round-trip。**部署取舍如实告知**:换接待模型影响所有走该 agent 的活
  (含晨报/工作流步)——重要定时活可改派专家 agent,M4 时按生产实况定。

## 六、接待 persona 推荐文案(M4 部署时贴进 spec.system 尾部)

> 这段是**推荐文案不是框架行为**:贴进接待 agent 的 `system`(NA-M3 稳定段,
> 改一次重缓存一次),工具描述里已同步钉了同一纪律,双保险。M4 部署时按生产
> 实况微调措辞;专家显示名会由工具回执自动带出,文案里不必硬编码。

```
【接待与转派纪律】
你是接待台:大多数消息(问候、小问题、状态查询、简短请求)直接回答,快而简洁。
遇到「重活」——需要深度分析、长文写作、多来源调研、复杂规划——按这个顺序做:
1. 先用一两句话回复成员:告诉 ta 你收到了、你准备怎么处理(比如「这个需要
   深入分析,我转给深度专家来做,结果出来我会发你」)。
2. 然后调 escalate_to_expert,把任务用 task_summary 完整自包含地描述清楚
   (背景、要求、期望产出——专家看不到你们的对话,只看得到这段摘要)。
3. 转派后本轮就结束,不要替专家编造答案,也不要承诺具体完成时间。
多步骤、需要定时或审批的事,用 create_workflow 而不是转派。
拿不准算不算重活时:先直接回答;成员表示需要更深入时再转派。
```

要点(为什么这么写):
- **「先回执再转派」**顺序钉死 —— 工具描述与 persona 双处一致,弱模型也稳;
- **task_summary 自包含**点明「专家看不到对话」—— fire-and-forget 派发只带
  摘要,不带会话历史,这是隐私边界也是提示词纪律;
- **「不替专家编造答案」**防接待模型抢答 —— 回执≠结果,结果由回推送达;
- **多步指路 create_workflow** —— 与工具描述互相印证,防拿转派硬凑工作流。

## 七、显式不做(本 track)

- 内容感知自动路由(框架判断消息类型选模型)—— 撞边界①,永不;
- 「质量不够自动升级」cascade —— 判质量=LLM 判断,同上(结构性失败即升已由
  MR 候选链盖住);
- 转派限频/冷却 —— 纪律先钉 prompt,乱转的真实信号出现再议;
- web 主动推送缝 —— web-only 成员结果落 /me,不对称如实接受;
- 多专家路由表(按任务类型选不同专家)—— v1 单 target,真需求出现再扩
  (escalate 参数面已留扩展余地)。
