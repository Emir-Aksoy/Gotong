# NA — 阿同/框架原生适配增强(提示词缓存 + 调用韧性)

> Track 代号 **NA**(native adaptation)。用户问题原文:「目前我们的助理atong和框架gotong
> 是否能加强原生适配?以便有更强的稳定性和更高的效率?」
>
> 本文 = M0 体检报告 + M1/M2 设计。先体检后开工:每个缺口都有 file:line 证据,
> 不做想象中的优化。
>
> Last updated: 2026-07-10

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

每里程碑:vitest 全绿 + `pnpm check:guards` 四门 PASS(旋钮 109 零新增、main.ts
3000/3000 零触碰——M1 全在 llm-anthropic/llm-openai,M2 装配在 pool 不占 main 预算)+
独立 commit。真机验证(生产机 Anthropic 通道)属 L4,待用户侧窗口。
