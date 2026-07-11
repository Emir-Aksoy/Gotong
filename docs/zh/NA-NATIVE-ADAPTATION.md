# NA — 阿同/框架原生适配增强(提示词缓存 + 调用韧性 + 缓存深化)

> Track 代号 **NA**(native adaptation)。用户问题原文:「目前我们的助理atong和框架gotong
> 是否能加强原生适配?以便有更强的稳定性和更高的效率?」
>
> 本文 = M0 体检报告 + M1–M5 设计/落地 + M6 流式(侦察 + M6a/M6b 落地)。先体检后
> 开工:每个缺口都有 file:line 证据,不做想象中的优化。
>
> Last updated: 2026-07-11

---

## 一、体检结论(一句话)

**骨架层已经高度原生**——常驻实例、记忆冻结块、治理闸、hub 派发、配额、账本全走框架
自己的缝;真实短板集中在 **LLM 调用层**:提示词缓存的下游管道(计价/账本/用量类型/
响应解析)五个月前就建好了,但**请求侧从没下过 `cache_control` 断点**,所以全链路
恒零;调用无看门狗、单 provider 用户无瞬态重试。

## 二、已经原生、本 track 不动的部分

| 面 | 证据 |
|---|---|
| 每成员管家常驻缓存(不是每消息重建) | `packages/host/src/butler-router.ts:85` `Map<userId, Participant>`,首任务懒建后复用 |
| 冻结记忆块为缓存前缀设计 | 人设+冻结块领头,变量探针(时钟/待办/语言/渠道)只追加 system 尾部 |
| 工具循环有界 + park/resume fail-closed | `maxToolRounds` 默认 8(`packages/llm/src/agent.ts:320`);治理闸服务端权威 |
| 断供/降级闭环 | CARE 断供追踪 + MR RoutingProvider 三态熔断 failover(opt-in `fallbacks`) |
| 缓存的**下游**管道 | `LlmUsage.cacheCreationTokens/cacheReadTokens`(`llm/types.ts`)+ anthropic 响应解析(`llm-anthropic/provider.ts:197`)+ 计价含写 1.25×/读 0.1×(`host/pricing.ts:37`)+ 账本列(`identity/ledger-store.ts:151`)——**全部已存在,只是恒零** |

## 三、缺口(证据链)

### E1 · 提示词缓存请求侧全缺(效率,最大杠杆)

- `packages/llm-anthropic/src/provider.ts` `buildBody()` 只下 `model/max_tokens/messages/
  system/tools`;全仓 grep `cache_control` 零命中。Anthropic 缓存是显式 opt-in,不下断点
  = 全额付费。
- 管家每轮背的工具面(逐模块数过):记忆 5 + 笔记本 4 + 观察 3 + 工作流 2 + onboarding 2
  + 诊断/问自己人/问对端/看对端/整理/提醒/晨报/播报/画像/语言/能力卡/向导各 1 + 治理 5
  (create/edit/delete_agent、edit_workflow、create_workflow)≈ **基础约 34 个工具**;
  挂生活连接器(Notion/日历/Gmail)再加 10–30 个。工具 schema 估 6–10K token,
  加人设+冻结块 2–3K。
- **循环内也在重付**:`PersonalButlerAgent.runToolLoop`(`personal-butler/src/agent.ts:201`)
  每一轮全量重发工具+system+历史。一次 3 轮的消息,同一段 ~10K 前缀付 3 次全价。
  下断点后第 2、3 轮读缓存打 1 折——**轮内节省是结构性保证的**,不赌用户 5 分钟内回消息;
  首 token 延迟同步缩短。
- OpenAI/DeepSeek 是服务端自动前缀缓存,不受此害(但响应里的缓存命中字段我们也没解析,
  见 M1b)。**这个洞是 Anthropic 通道专属的。**

### S1 · 调用无看门狗(稳定)

`llm-anthropic/provider.ts:151` 与 `llm-openai/provider.ts:181` 的 `stream(req, signal?)`
都支持 AbortSignal,但**没有任何调用方传过**——管家/llm 基类 grep `AbortController` 零命中。
一条挂死或涓滴的流会把该成员的轮无限期卡住。MR failover 只救「首 chunk 前**抛错**」,
救不了「不抛错光挂着」。

### S2 · 单 provider 用户零瞬态重试(稳定)

provider fetch 层 grep `retry/429/backoff` 零命中。配了 `fallbacks` 的用户有 MR 兜底;
没配的(默认态)撞一次 429/5xx 抖动,这条消息直接失败报错给成员。

## 四、边界(照旧四条,一条不破)

1. **热路径零 LLM** — 断点位置、看门狗、重试判类全是确定性代码(复用 `classifyLlmError`)。
2. **默认行为语义等价** — 缓存断点改变请求字节但不改变任何语义/输出;看门狗阈值宽到只抓
   真挂死;M1 提供关闭开关(构造项,非 env 旋钮)供逐字节对照。
3. **数据边界不动** — 缓存发生在已经在收内容的同一家 API 侧,零新数据面。
4. **内核零改动,旋钮 109 零新增** — 全部落在 `packages/llm*` + host 装配缝;
   阈值/次数全常量(注入时钟可测)。

## 五、里程碑

### NA-M1 · Anthropic 提示词缓存原生化(默认发,零旋钮)

按「零门槛默认发」法则(MU-M2 融合召回先例):缓存无门槛、纯省钱省延迟,默认开。

**断点方案(Anthropic 上限 4,我们用 3)**:

1. **工具尾** — `tools[last]` 挂 `cache_control:{type:'ephemeral'}`:工具面(最大最稳的
   一段)独立成缓存段,system 再怎么变它都命中。
2. **system 尾** — `system` 从字符串升格为 `[{type:'text',text,cache_control}]`
   (语义等价):盖住 人设+冻结块+探针;跨消息可能因探针变化 miss,但**同轮多 round 恒中**。
3. **末消息尾块** — 每 round 移动到最新一条消息的最后一个内容块:增量会话缓存,round N
   写到的前缀 round N+1 直接读。`thinking/redacted_thinking` 块不可挂(API 限制),
   从尾往前找第一个可挂块;纯字符串 content 升格为单 text 块;找不到就跳过该断点。

**auto 规则(何时下断点)**:`req.tools` 非空才下(工具循环形状 = 轮内复用结构性保证,
写缓存的 1.25× 溢价必被后续 round 的 0.1× 读回赚回);无工具的单发调用(如部分 6h 维护、
晨报纯撰写)不下,避免「写了永不读」的纯溢价。构造项 `promptCaching?: boolean` 强制
两个方向(true=永远下 / false=永远不下,供测试与逐字节对照);缺省 = auto。

**M1b 顺手**:OpenAI 兼容响应解析 `usage.prompt_tokens_details.cached_tokens`
(DeepSeek: `prompt_cache_hit_tokens`)→ `cacheReadTokens`——OpenAI 侧缓存是自动的,
我们只是把已发生的命中**如实入账**(计价/面板已能消费该字段)。

**会红的门**:单测断言 ①三断点确切位置(工具尾/system 块/末消息尾块)②thinking 尾块
walk-back ③无工具请求不带任何 `cache_control`(auto 规则)④`promptCaching:false` 与
今天请求体逐字节一致 ⑤openai cached_tokens 入账。验收另含:真机(有 key 时)
`cache_read_input_tokens > 0` 冒烟(可选,不进 CI)。

### NA-M2 · 调用韧性(看门狗 + AbortSignal 贯穿 + 瞬态单次重试)

新纯核 `packages/llm/src/resilience.ts`(与 RoutingProvider 同包同姿态,零依赖、
注入时钟):

- **看门狗** `withCallWatchdog(provider)`:两只表,全常量——首 chunk 前 `TTFC_MS=120s`、
  chunk 间隙 `GAP_MS=120s`(抓挂死,不是延迟 SLO,故意宽);超时 → `AbortController.abort()`
  贯穿到 provider fetch + 抛 timeout 类错误(进 `classifyLlmError` 既有病名体系)。
  调用方原有 signal 与看门狗 signal 合并转发。
- **瞬态重试** `withTransientRetry(provider)`:仅**首 chunk 前**、仅瞬态类
  (network/timeout/rate_limited/server)、同 provider **单次**、固定退避 2s;
  吐过 chunk 一律不重试(token 收不回,与 MR 首-chunk-前 failover 同一条纪律)。
- **装配缝**(pool 的 providerFactory 咽喉,一处盖全):看门狗包**每个叶子** provider
  (含 RoutingProvider 的每个候选——挂死变成该候选的 timeout,failover 因此能接手);
  瞬态重试**只在无 fallbacks 的单 provider 形态**外包(有 fallbacks 时重试让位
  RoutingProvider——候选间 failover 就是它的重试故事,不叠加双倍延迟)。

**会红的门**:注入时钟单测 ①TTFC 超时 abort+抛 timeout ②间隙超时 ③正常流零干预
逐 chunk 透传 ④瞬态错误重试一次成功 ⑤非瞬态不重试 ⑥吐过 chunk 不重试 ⑦有 fallbacks
时不包重试层(装配测试)。

### NA-M3 · system 分块缓存(稳定块挂断点,探针尾隔离出缓存段)

M1 的 system 尾断点把整个 system 当**一块**挂标——但 UX track 的时钟卡(分钟级变)
让管家 system 每轮都变,断点每轮失效:人设+冻结块(缓存大头)白写。修法=把「语义上
是 system、但每轮变」的部分拆出去:

- **`LlmRequest.systemVolatile?: string`**(llm/types.ts):**全部 provider** 逐字节拼
  `(req.system ?? '') + (req.systemVolatile ?? '')`——分隔符字节随 volatile 走,所以
  不启用缓存的路径(mock/openai/anthropic promptCaching:false/无工具 auto-off)与拆分
  前**逐字节一致**;只有 cache-aware 的 anthropic 在挂标时拆两块:稳定块挂
  `cache_control`,volatile 作第二个**不挂标**的 text 块(给每轮都变的块挂标=写了
  永不读,纯赔 1.25× 溢价)。
- **personal-butler 接线**:`composeContextProbes` 的探针卡(时钟/A1 待办/A2 间隔/
  A4 渠道/TN 复述)整体走 `systemVolatile`;人设+冻结块留 `system` 稳定段。管家每轮
  的缓存断点从「恒失效」变「恒命中」。

**会红的门**:anthropic 拆分形状/稳定块跨轮字节一致(volatile 变、稳定块不变)/
promptCaching:false 回落拼接字符串且全 body 无 cache_control/无工具 auto-off 拼接/
仅 volatile 单块不挂标;openai 侧拼进首条 system 消息逐字节;butler 探针卡落
volatile 段、人设不动。教训:三处断言 `req.system` 的既有测试(agent/onboarding/
notebook)要改断「模型眼前的完整拼接」,不是只看 system 字段。

### NA-M4 · 缓存命中率可见化(用量面板两新列)

M1 让缓存真实发生,M4 让它**看得见**——不可见的优化等于没做。侦察发现后端零工作:
usage-routes 的 DTO/CSV/聚合从 M1 入账起就带 `cacheCreationTokens`/`cacheReadTokens`,
只是面板从没渲染。纯前端:

- `usage-ui.js` 加「缓存读」「缓存命中率」两列;命中率 = `cacheRead / (input +
  cacheCreation + cacheRead)`——NA-M1b 之后 inputTokens 只计「新鲜段」,三段互斥之和
  =模型实际看到的提示词全量,这个分母才诚实。无提示词流量显示 '—' 而非 0%(没数据
  ≠命中为零);**合计行命中率从合计数算**(7500/13000=57.7%),绝不做各行平均(那是
  37.5%,错的)。
- i18n zh/en 双语;真浏览器 round-trip 验收(播种三行 75.0%/0.0%/合计 57.7%,
  console 零错误)。

### NA-M5 · 6h 维护低价模型 override(opt-in `maintenanceModel`)

管家 6h 维护 sweep(记忆蒸馏/原子事实抽取)是纯后台摘要活,不需要对话档模型。侦察
发现 override 管道**早已存在**(`butlerSummarizer(provider,{model})` → `req.model`),
缺的只是配置面+每 tick 解析:

- **`ManagedAgentSpec.maintenanceModel?: string`**(core additive 字段,Hub 不解释):
  设了,蒸馏调用带 `model:<此值>`——**同 provider 同 key 同计费,只换模型名**,数据
  边界不动;对话热路径完全不受影响;未设=字节不变。
- **per-tick 解析**:sweeper 开机装一次,但 spec 面板可随时改——`resolveModel` 缝
  每 tick 调 `pool.butlerMaintenanceModel()`(镜像 `buildProvider` 的 per-tick 纪律),
  改完下个 tick 生效不用重启;resolver 抛错降级为无 override,**绝不让维护 tick 失败**。
- **配置面走 MR-M2 fallbacks 三缝先例**:manifest 共享校验器 `validateMaintenanceModel`
  (import/export round-trip 不漂移)+ agents-routes POST/PUT + admin 表单
  capture-echo(`_editingMaintenanceModel`——PUT 整体替换,无控件字段不回显就静默丢)。

**会红的门**:sweep e2e 三例(override 全程落每次蒸馏 `req.model` / 未设恒 undefined
/ resolver 抛错 tick 照常完成)+ web 路由 4 例(持久化+回显/省缺 undefined/坏形状
400/PUT 回显保留·省略即丢)+ manifest 5 例(解析裁剪/省缺/拒空串非串/round-trip/
render 省略)。旋钮仍 109(spec 字段非 env 旋钮);main.ts 3000/3000(压 BF-M8 注释
净零)。

### NA-M6 · /me 网页聊天流式(M6a+M6b 已落;侦察结论存档)

先侦察后实现。四条侦察结论(M6a/M6b 的设计依据,保留存档):

1. **流式管道其实已铺九成**:`LlmAgent.onStreamChunk` 逐 chunk 钩子(Phase 8 M5)
   在三处装配点(pool / hub-steward / workflow-assist)都把 chunk append 进
   transcript(`llm_stream_chunk`);`hub.onEvent === transcript.onAppend`,所以
   `/api/stream` SSE(admin/worker 门控)**今天就在广播每个 chunk**,admin 面板已
   消费实时打字(Phase 8 M7)。成员侧也已有三条流式路由:工作流**编辑/新建/讲解**
   (WFEDIT-D4 NDJSON `stream:true` + per-request `onChunk` + `__streamSinkKey`
   一次性私钥,成员安全按构造成立——chunk 只流进本人 request/response 对)。
2. **没流式的是两张成员脸**:①`/api/me/steward/plan`(「我的」首屏管家框)——host
   缝**已备**(`HubStewardPlanInput.onChunk` + `chunkSinks` 机制都在,从未被 web 用),
   只差 web 路由 stream 分支 + SPA 渲染;②`/api/me/agents/:id/chat`(quick-chat,
   含跟阿同聊)——pool 的 `onStreamChunk` 只进 transcript 无 sink 分流,且该路由从
   web 直接 `hub.dispatch`(其他流式路由都走 host 服务 surface,它是孤例)。
3. **诚实性要点**:管家带工具,`runToolLoop` 只返回**最后一轮**文本——「拼接 chunk
   =最终回复」契约(WFEDIT-D4 注释)只对无工具单轮调用成立;管家流式必须把 chunk 流
   当**打字预览**、以终行 `result` 整体替换(NDJSON 协议本就是 chunk…+result 终行,
   SPA 照做即可,不新增协议)。
4. **IM 桥(管家主通道)结构性不能流式**(整条消息投递),流式收益 web-only。

**岔口拍板与落地**(用户定「先 A 后 B」,两段均已落):

- **M6a · steward 管家框流式**(`63aae42`,web-only)——host 零改动(侦察结论②:
  `HubStewardPlanInput.onChunk` + `chunkSinks` 缝早就在,只是从未被 web 用)。
  `/api/me/steward/plan` 加 `stream:true` NDJSON 分支,逐字镜像 WFEDIT-D4 形状:
  200 + `application/x-ndjson` + `no-store` + `x-accel-buffering:no`,逐行
  `{kind:'chunk',text}`、终行 `{kind:'result',…}`,头已出后的失败**骑 result 行**
  (`ok:false`+code)绝不半截挂断;body 无 `stream:true` 纯 JSON 原路不动。SPA 加
  `readNdjsonStream` 读流器 + `.me-steward-typing` 打字预览面板(chunk 累积渲染,
  管家带工具故预览用 `extractPartialReply` 增量提取部分 reply),result 到达**整体
  替换**为终版提案(诚实性要点③照做,拼接 chunk 从不冒充回复)。
- **M6b · quick-chat/阿同流式**(`eb246a8`,pool 缝 + web 缝)——pool 加 per-call
  `chatChunkSinks`(steward 同款纪律推广到 pool 作用域):`registerChatChunkSink`
  发一次性随机 key,key 骑 `payload.__streamSinkKey`,spawn 时 `onStreamChunk` 只把
  text 类 chunk 喂对应 sink——sink 抛错绝不断 agent 回复、未知/缺失 key = no-op、
  transcript append 原样不动(sink 是**额外的 tap** 不是替代,admin SSE 打字照旧)。
  web 侧 `handleMeChatAgent` 加 `stream:true` 分支,鸭子 `MeChatStreamSurface`
  (只 register/release 两方法)注入——**刻意选了比侦察预估更浅的缝**:dispatch 仍在
  me-routes(`Promise.race` 超时逻辑不动),孤例(web 直 `hub.dispatch`)保留不迁,
  surface 只暴露 sink 注册面;无 surface ⇒ `stream:true` 静默回落纯 JSON(旧 host/
  旧 SPA 双向兼容)。main.ts 接线 2 行压 2 行注释净零(3000/3000 顶格)。SPA 复用
  M6a 读流器(`readStewardStream` 通用化为 `readNdjsonStream`),chunk 直贴
  `data-chat-reply` 当打字预览、result 整体替换。
- **C · 成员级 SSE(按 origin userId 过滤 firehose)** —— **仍显式不推荐**:过滤
  正确性=新安全面(滤错=看见别人的 chunk),per-request NDJSON 正是为避开它选的形状。

验收:host 2029 全绿(chunk-sink 4 例:keyed 分流拼接===回复且 transcript 照旧/
无 key·释放后 key 零喂/sink 抛错回复完好/两并发 key 各回各家)+ web 1365 全绿
(M6a、M6b 各 4 例路由测试:NDJSON 行序/超时骑 result 行/无 stream 纯 JSON/无
surface 回落)+ 两段各真浏览器 round-trip(mock provider:MutationObserver 抓到
预览先现、result 后替换;网络层头齐全 chunk/result 两行;console 零错误)。

## 六、显式推迟

- **C · 工具面瘦身/按来源裁剪** — 先度量后动:M1 落地后缓存把此项收益打薄;若将来
  数据显示工具 schema 仍是大头,再议确定性裁剪(绝不能引入热路径 LLM 选工具)。
- **hub-steward / workflow-assist 各自 new provider 的韧性接线** — 与 MR-M5 同一条
  推迟(它们不走 pool 咽喉);M2 装配缝盖住 管家+全 managed agent+后台 sweep+工作流步。
  M1 缓存断点在 provider 内部,这两处**天然已享受**,只有 M2 的包装层未及。
- **每轮输入 token 构成打点面板** — ledger 已记 cache 四列,面板聚合视图按需再加。
- **1h 长 TTL 缓存(beta)** — 5min 默认 TTL 先跑;IM 对话节奏数据出来后再评估。
- **llm-key-test/probe 路径的缓存** — 探针是单发最小请求,auto 规则天然不下断点,无需特判。

## 七、验收纪律

每里程碑:vitest 全绿 + `pnpm check:guards` 四门 PASS(旋钮 109 全程零新增——
`maintenanceModel` 是 spec 字段非 env 旋钮;main.ts 3000/3000——M1/M3 在 provider 层、
M2 装配在 pool、M4 纯前端,M5/M6b 的 main.ts 接线各靠压注释净零)+ 独立 commit。
M6a/M6b 另各过一道真浏览器 round-trip(mock provider,打字预览时序 + NDJSON 头形 +
console 零错误)。真机验证(生产机 Anthropic 通道)属 L4,待用户侧窗口。
