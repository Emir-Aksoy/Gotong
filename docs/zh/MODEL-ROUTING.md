# 模型路由 track(MR)—— 多 provider 有序降级 + 熔断 + 逐 provider 健康

> 北极星第 1 层「我的 AI 桌面」的可靠性抓手:管家(以及所有 managed agent)每轮
> 只持有**一个** LLM provider 实例、一辈子不重建;那个 provider 的厂商一限流 / 一
> 掉线 / 一鉴权失败,整条对话就断。这个 track 给 provider 调用加一层**确定性**的
> 有序降级 + 熔断 + 逐 provider 健康监测,让「一个厂商挂了」不等于「管家哑了」。
> 全程 opt-in、零内核行为改动、预计零新 env 旋钮。
>
> Last updated: 2026-07-09 · 状态:**全完 M0→M5**(计划 `c4a3c63` → 纯核 `b5d85de` →
> opt-in 配置+接线 `52a66c5` → per-provider 健康上面板 `9e37634` → capstone `7a4eecd` →
> **手动测试路由** M5a `cb43413` / M5b `8019254` / M5c `e0aaa0f` / M5d 本 commit)。
> 四条边界全程守住,旋钮仍 **107**(零新增),`main.ts` 顶格 3000/3000。

---

## 一、为什么(缺口)

管家是**纯反应式的有界 tool-loop**:一条 IM = 一个 Task = 一轮 `provider.stream()`。
侦察两条链路后的现状地图:

**已有的零件**(CARE track 攒下的半套,可复用,不重造):

- **单 provider 流式抽象** `LlmProvider.stream()`(`packages/llm/src/types.ts:504`)——
  唯一方法,`readonly name`。**硬失败(auth / transport / vendor 5xx)在吐第一个 chunk
  之前同步 throw**,软失败走 `'error'` chunk。这条契约是本 track 的关键切点(见三)。
- **错误分类纯函数** `classifyLlmError → LlmErrorKind`(`packages/llm/src/errors.ts:66`),
  7 类:`auth / quota / rate_limited / network / model_not_found / timeout / unknown`。
  **降级判据现成**,provider-neutral(鸭子读 status/name/code,不依赖任何 SDK)。
- **反应式断供边沿检测器** `LlmOutageTracker`(`packages/host/src/llm-outage.ts:55`,
  file-backed `runtime/llm-outage.json`)+ **主动恢复探针** `checkOutageRecovery` +
  **30min 升级红牌** `outageEscalationCard`(`personal-butler-patrol.ts`)。
- **web 体检快照** `HealthSnapshot.llmOutage`(`packages/host/src/admin-health.ts:108`)
  红条 + 每 agent `missingKey / online / provider` roster(`admin.js` 已渲染)。

**缺的零件**(本 track 要新建):

- **零多 provider 路由 / fallback / failover / 熔断**(core/llm/host grep 干净)。一个
  agent 在 spawn 时构造**一个** provider,存进 `LlmAgent.provider`(`agent.ts:249`),
  活一辈子,交互链路永不重建 —— **今天没有第二个 provider 可以 failover 过去**。
- **provider 内部零 retry**:两个 provider 都裸建 SDK client,不设 `maxRetries` /
  `timeout`(OpenAI 有 `isTransientError` 分类器但**流式路径显式不用**,只导出给外部)。
- **断供 tracker 只挂在 IM 自由文本一个点**(`im-bridge.ts:1133`),provider 调用层
  本身除 `onAuthFailure` 外没有健康钩子;web 等其它入口的失败不喂 tracker。
- **面板只有「断供 or 不断供」二元**,没有 per-provider 健康、没有重试/熔断状态。

对**弱模型 / 便宜 provider** 尤其疼:它们更容易限流 / 波动,而管家恰恰想用它们省钱。
没有降级 = 省钱的代价是可靠性塌方。

## 二、四条不可破边界(全程守住)

1. **热路径零 LLM**。路由 / 降级 / 熔断的决策**全是确定性**的:错误码(复用
   `classifyLlmError`)+ 计时器 / 计数器(熔断状态)+ 配置好的候选顺序。**零模型调用
   来决定路由**。这条硬线直接决定了本 track 不做「看内容选模型」(见三)。
2. **opt-in 默认字节不变**。未配 `fallbacks` 的 agent,`buildProvider` 返回**今天那个
   单 provider**、根本不包 `RoutingProvider` —— 逐字节和今天一致。「能力」不是「行为分叉」。
3. **数据离盒 opt-in**。降级到另一个 provider = 把对话发给另一个厂商。候选链是**成员
   亲手编排**的(他自己挑哪些 provider 进链),所以按构造就是 opt-in;默认单 provider =
   没有任何新的数据外发。
4. **内核零行为改动**。`RoutingProvider` 放 `packages/llm`(peer 包,非 core/workflow/
   protocol),kernel-deps 门绿。配置字段是给 `ManagedAgentSpec`(core) **additive 的
   可选 `fallbacks`**——**Hub 不解释它**,只有 host 在 spawn 时读,不改任何 Hub 调度 /
   路由 / scheduler 行为(用户 2026-07-08 拍板此落点:admin 面板已在编辑该 spec,最易发现,
   且 CLAUDE.md 明确「大胆改 schema」)。熔断阈值走**常量**(照 CARE 惯例),预计零新旋钮。

## 三、设计(确定性路由 + 两段式接缝)

### 3.1 为什么是「确定性」而非「内容感知智能路由」

市场上的「内容感知智能路由」(OpenRouter 的 Pareto Code Router;2026-07-17 更正——
早先误记为「Hermes 的 Pareto Router / 8 个槽」,实际 Hermes 只把 `extra_body` 原样转发给
OpenRouter,它自家机制是 ~13 个**按任务类型静态分配**的 Auxiliary Models 槽,那不需要
现场分类)本质要先**判断这条消息是什么类型**才能选模型 —— 那需要一次 LLM 分类,
**落在热路径 = 违反边界 1**。所以 Gotong 版做**确定性路由**:

> 有序候选链 + 熔断器 + 健康感知跳过(熔断开着的候选直接绕过)。「智能」体现在**策略**
> (链序、熔断态、探活),不体现在「用大模型现场决定」。

这不缩水,因为**候选链的顺序本身就编码策略**:

- 便宜 / 本地模型排第一、强模型排第二 = Hermes 的「本地打头、失败升级到云端」(**失败
  触发**升级,不是内容触发,确定性)。
- 同能力不同 vendor 并排 = 纯可靠性 failover(顺序 = 偏好)。

一个机制,用排序表达「省钱」还是「保命」。(确定性的**元数据**路由 —— 按 `task.from`
渠道 / agent id / 时段选链 —— 也在边界内,但非本 track 高价值核心,按需再加。)

### 3.2 两段式接缝(侦察结论)

管家一辈子只持有一个 provider 实例、无法在一轮中途重建 agent,**所以降级必须发生在
provider 内部**:

1. **机制层放 `packages/llm`**:新增 `RoutingProvider implements LlmProvider`。因为
   `LlmProvider` 接口极窄(只有 `name` + `stream()`),包一组**有序候选**,`.stream()`
   抛错时用现成 `classifyLlmError` 判类 → failover 到下一候选 + 记熔断状态。
   - **只在吐第一个 chunk 之前的 throw 上 failover**。一旦产出任何 chunk,就锁定该候选
     (流式契约 —— 已吐的 token 收不回);mid-stream 的 `'error'` chunk / throw **原样
     透传**,不重试。这对应 Hermes「换 provider 是针对**新请求**、不是生成中途」。
   - **per-candidate 熔断器**(Closed → 窗口内失败达阈值 → Open 快速跳过 cooldown 内的
     调用 → Half-Open 放一个试探 → 成功关 / 失败重开)。防止对已知挂掉的 provider 每轮
     硬敲。阈值 / 窗口 / cooldown 全是**常量**(可注入以便测试)。
   - **全候选耗尽 / 全熔断** → 抛最后一个(最有信息量的)错误,让既有 IM-bridge 断供
     机制照常分类播报。
   - 零依赖(只吃 `packages/llm` 内部 types/errors),可注入 `now()` / `onEvent`(M3 健康
     钩子用)。
2. **接线层放 pool 的 `providerFactory` 接缝**:`buildProvider`(`local-agent-pool.ts:1779`)
   在 `spec.fallbacks?.length` 时构造主 + 各候选 provider 包成 `RoutingProvider`,否则
   返回单 provider(今天,字节不变)。这一个咽喉点同时覆盖**管家 + 所有 managed agent +
   管家三类后台 sweep + 以 managed agent 承载的工作流 step**,agent 循环零改动。
   - **不覆盖**(各自 new provider,需要时单独接线):`hub-steward-service.ts`、
     `workflow-assist-agent.ts`。
   - **401 auto-revoke 语义**:既有 `onAuthFailure`(`local-agent-pool.ts:1493`)在 401 时
     软删金库 key。降级时某候选抛 401 → 该候选 key 确实是坏的,吊销它 + failover 到下一
     候选是正确语义(M2 文档钉死)。

### 3.3 手动测试路由(M5):被动健康之外的主动逐候选探针

**M1→M3 的健康是「被动」的**:`RoutingHealthTracker` 只从**真实用户流量**流过
`RoutingProvider` 时的成败折叠出来。一个候选**没被走到过**(前面的候选一直健康、从没
failover 到它),它的健康就是**未知** —— 面板上根本没有它的行。半开探针也是拿**下一条
真实请求**当探针,不主动发。这对热路径零 LLM(边界 1)是对的:被动 = 不额外花钱、不自
己造流量。

但它留了一个洞:**成员配了 3 个备用,怎么在真出事**之前**知道这 3 个都真能顶上?** 被动
健康答不了 —— 备用没被走到就没数据。M5 补的就是这个:一个**手动触发**的逐候选探针。

**为什么必须手动、必须逐候选**(对照 CARE 的两种既有探测):

| 层 | 触发 | 探什么 | 内容 | 能测出 |
|---|---|---|---|---|
| CARE 断供恢复探针 | 后台 60s 定时(**仅断供期间**) | 只读 `GET /models`(零 token) | —— | network/timeout/auth 是否恢复 |
| MR 被动健康(M1→M3) | 真实用户流量 | 用户真消息 | 用户真消息 | 走到过的候选的实时成败 |
| **MR-M5 手动测试路由** | 面板/操作员**手点** | **一次最小 completion** | 固定极短 prompt(`ping`,`maxTokens:1`) | **每个**候选(含没走到的备用)能否**真生成** —— 含限流 / 余额不足 / 模型不存在 |

关键差异:CARE 的免费 `GET /models` 证不了「能生成」(限流 / 配额耗尽 / 模型名错在**列表
端点上看不出来**,得真走一遍生成路径才暴露)。M5 探针走的正是**真 spawn 链**
(`resolveApiKey → providerFactory → provider.stream()`,与真跑逐字节同路),所以「探针过」
= 那个候选真能顶。代价是**花钱 / 占配额 / 可能触发限流**,还有「框架不主动跑 LLM」的立场 ——
所以它**必须 opt-in、必须手动**:操作员亲手点一下才发,绝无后台自主外呼。这条把 M5 稳稳
钉在边界 1 的**手动侧**,不越「框架热路径零 LLM」线。

判定口径:**「能不能生成」不是「答得对不对」**。`ping` / `maxTokens:1` 只图最短最省;哪怕
弱模型不听话乱答,只要**成功产出非空** = 健康。判类完全复用 `classifyKeyError`(与「测试
连接」按钮同一套错误码 → 人话表),路由面板和 key-test 按钮永不各说各话。

**接缝**(三段,与 M1→M3 同姿态):共享探针核 `probeProvider`(host `llm-key-test.ts`,
`testLlmKey` 也 delegate 给它,逐字节等价)→ pool `probeRoutingCandidates(agentId)` 对每个
候选走真 spawn 链探一次(**mock 候选短路 ok 不调 factory,零花费**;**探针刻意不喂熔断器**
—— 手动测试不该拨动线上路由态)→ web 鸭子 `RoutingProbeSurface` 注入(镜像 `llmKeyProbe`,
web 零 host 运行时依赖)→ 面板「测试路由」按钮(**只在配了 fallbacks 的行显示**,无路由 =
无按钮 = 无可测)逐候选渲染。已存 agent 的 key 在金库、浏览器拿不到,所以**逐候选探针用
host 侧 `resolveApiKey` 解析**,绕开「测试连接」按钮「必须手打 key」的限制 —— 这正是它能
测**已保存 agent 的备用链**的原因。

### 3.4 per-candidate env 凭证(M6):补 MR-M2 显式推迟的「候选链共享一把 key」盲区

**MR-M2 当时的已知边界**:整条候选链(主 + 全部 fallbacks)共享**同一把 per-agent key**
(`space.ts` fallbacks 注释原话「候选沿用该 agent 的 provider 凭证解析链……需要 per-candidate
凭证时再扩」)。同厂商换模型(anthropic 主 + anthropic 备)没问题;但**两个不同厂商的
openai-compatible**(比如 LongCat 主 + MiMo 备,各自的 key)结构性配不出来 —— per-agent key
只有一格,org pool 又按 provider 字符串一 tag 一行,`openai-compatible` 撞名。M6 就是那句
「再扩」。

**设计:`apiKeyEnv` = env 变量名,不是 key 本身**。`ManagedAgentSpec` 与 `FallbackCandidate`
各加可选 `apiKeyEnv?: string`(存 NAME 如 `LONGCAT_API_KEY`;key 值只活在部署环境
`gotong.env`,与 MCP `${NAME}` 占位、TAVILY/MEM0 同一凭证纪律 —— **配置文件里永不出现明文
key**,manifest 校验器按标识符形状拒掉「长得像 key」的值,粘错当场 400 而不是落盘)。

**排他语义(不回落)**:设了 `apiKeyEnv` ⇒ key **只**从 `process.env[名字]` 取;变量缺失 / 空
= 无 key —— 主 spawn 响亮失败、候选被跳过(warn),**绝不静默回落**到存量 per-agent/org 链。
理由:那条链里存的可能是**另一家厂商的 key**(正是 M6 要解的场景),静默借用会拿 MiMo 的 key
打 LongCat 的端点,得到一个**撒谎的 401**(病因看起来是「key 无效」,真相是「借错了钱包」)。
不设 = 走既有解析链,逐字节不变(opt-in 法则)。

**同源探针**:`probeRoutingCandidates`(M5 测试路由)与 `resolveLlmProbeTarget`(CARE 断供
探活)都穿过同一个 `apiKeyEnv` —— 探针必须测**路由真会用的那把 key**,否则「测试路由」按钮
在测另一个钱包,CARE 会拿旧 key 打新端点每轮误报。一处口径:`resolveApiKey(agentId, provider,
apiKeyEnv?)` 咽喉收口,七个调用点(spawn / 路由候选 / 两探针 / 管家 provider / key 有无判定)
全走它。

**面板生存**:admin 表单没有 apiKeyEnv 编辑器(按需再起),但 PUT 是整体替换 —— 镜像
maintenanceModel 的 capture-echo 先例(`_editingApiKeyEnv` 捕获回显),fallback 级的随
`_editingFallbacks` 整数组回显免费生存。**admin-only**:成员 me-routes 结构性没有这个面;
admin 本就能配 MCP `${NAME}` 占位,不是新威胁面。

## 四、里程碑

| 里程碑 | 内容 | 交付门 | 状态 |
|---|---|---|---|
| **MR-M0** | 本计划文档 + 侦察记录 | 文档落地、链接自洽 | ✅ `c4a3c63` |
| **MR-M1** | `RoutingProvider` 纯核(`packages/llm`):有序候选 + 熔断 + 首-chunk-前 failover + 复用 `classifyLlmError`;零依赖、可注入 now/onEvent;单测 | packages/llm 全绿;不接线=零行为变;kernel-deps 门绿 | ✅ `b5d85de` |
| **MR-M2** | 配置面 + 接线(opt-in):扩 `ManagedAgentSpec.fallbacks`;`buildRoutedProvider` 有候选才包;admin `agents-routes`+`manifest` 校验;per-candidate `model` 覆盖;401 语义文档化 | host 全绿;未配 fallbacks 字节不变;旋钮不增 | ✅ `52a66c5` |
| **MR-M3** | per-provider 健康监测:`RoutingProvider.onEvent` → 新 `RoutingHealthTracker`(**in-memory**,寿命对齐 in-memory 熔断器,重启即清);`HealthSnapshot.routing` 逐候选健康行(list,同 connectorSlots 三态)+ 面板黄条渲染(超越 CARE-M7 二元断供) | host+web 全绿;面板真见 per-provider 健康 | ✅ `9e37634` |
| **MR-M4** | capstone `examples/model-routing`(主 provider 抛错→failover→续跑;连续失败→熔断快速跳过;健康投影=面板数据;主自愈→探针→弹回;self-assert exit 0)+ 文档收尾 + CLAUDE.md 账本 | `pnpm demo:model-routing` exit 0;四门 PASS | ✅ `7a4eecd` |
| **MR-M5a** | 共享探针核:抽 `probeProvider`(already-constructed provider 探一次)出 `llm-key-test.ts`,`testLlmKey` delegate 给它(逐字节等价,既有测试守重构);pool `probeRoutingCandidates(agentId)` 逐候选走真 spawn 链(`resolveApiKey → providerFactory → probeProvider`),mock 短路 ok 不调 factory、**刻意不喂熔断器** | host llm-key-test 31 + pool routing 单测全绿 | ✅ `cb43413` |
| **MR-M5b** | web `POST /api/admin/agents/:id/probe-routing`(**admin 门控** + viewer-scoped,镜像 `:id/export`):鸭子 `RoutingProbeSurface` 注入(镜像 `llmKeyProbe`,web 零 host dep);opt-in 无 surface → 503、未知 → 404、外接 agent → 400、否则 200 `{agentId,candidates}`;`main.ts` 接 `routingProbe: localAgents` | web agents-route 19(+4 新)+ host tsc 全绿 | ✅ `8019254` |
| **MR-M5c** | 面板「测试路由」按钮(**仅配了 fallbacks 的行显示**)+ 逐候选内联渲染:复用 `describeKeyTest`(与 key-test 按钮同一套人话)+ Primary/Fallback N 标签 + `N of M candidates OK` 汇总(zh+en i18n);`textContent`-only 无转义 | web 1338 全绿;真浏览器(mock host 零 key)3/3 绿 · 无 fallback 无按钮 · 死端点 1/2 红 round-trip | ✅ `e0aaa0f` |
| **MR-M5d** | 文档 M5 节(被动 vs 主动健康三层对照)+ CLAUDE.md 账本 + 四门收口 | 四门 PASS | ✅ `b5d4d96` 前后 |
| **MR-M6** | per-candidate env 凭证(§3.4):`ManagedAgentSpec.apiKeyEnv` + `FallbackCandidate.apiKeyEnv`(env **名**非 key 值);`resolveApiKey` 咽喉排他语义(设了只认 env,缺失=无 key 响亮失败,绝不借存量链);七调用点含 M5 探针 / CARE 探活同源;manifest/agents-routes 校验(标识符形状拒 key 样值)+ admin 表单 capture-echo 生存;**首个真实用例 = 生产 LongCat 主(env key)+ MiMo 兜底(存量 per-agent key 零迁移)** | host routing 11(+5:双厂商 key 分离 / 死候选跳过不借 key / 主 env 排他 / 探针同源 / CARE 目标 env key)+ web manifest 107(+7)/agents-route 28(+5)全绿;未设 = 字节不变;四门 PASS 旋钮 115 零新增 | ✅ 本 commit |

## 五、市场对照(先查市面 · 2026-07)

| 系统 | 做法 | 我们取 / 舍 |
|---|---|---|
| **Hermes**(Nous) | 主推理模型 + **~13 个 Auxiliary Models 槽**(compression/title/vision/approval…,各独立 provider/model/凭证,**按任务类型静态分配**;2026-07-17 更正:早先误记为「8 槽 + Hermes 的 Pareto Router」——Pareto Code Router 实为 **OpenRouter** 的内容感知路由,Hermes 仅把 `extra_body` 透传给它);三层降级 credential pools → `fallback_providers` → per-aux `fallback_chain`,限流/过载/认证失败中途换 backup 不丢会话 | **取**:有序降级链、失败换 backup、静态任务槽(NA-M5 `maintenanceModel` 即同型物)。**舍**:内容感知自动选路(OpenRouter Pareto 那类,需内容分类 = 热路径 LLM,违反边界 1)。注:Hermes 的静态槽本身**不**撞边界 1,当初否掉的对象搞错了 |
| **OpenClaw** | 内建**熔断器**:`failure_window` 内失败达 `failure_threshold` → 全转 fallback 持续 `recovery_timeout`;健康探针 probe `healthUrl`(或 `baseUrl + /models`);每 agent 显式 fallback 链;`models status --probe --all` 逐模型真实探活**仍是未完成的 open issue** | **取**:熔断三态 + 阈值/窗口/cooldown、每 agent 显式候选链。**leapfrog**:`models status --probe --all` 那条逐模型真实探活 = **MR-M5 手动测试路由**(它走真生成路径,证得了 `GET /models` 证不了的限流/配额/模型不存在),我们做完了它没做完的 |
| **2026 通行** | 三态熔断 Closed/Open/Half-Open;~60s 监测窗;多层降级 `主→更便宜→语义缓存→503`;软失败(格式错/幻觉/schema 不符)也纳入 fallback 判定 | **取**:三态熔断、监测窗。**暂舍**:语义缓存层、软失败内容校验(超出 provider-neutral 降级的范围,按需再议) |

来源:[Hermes Fallback Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers) ·
[OpenClaw Model failover](https://docs.openclaw.ai/concepts/model-failover) ·
[OpenClaw 逐模型探活 open issue](https://github.com/openclaw/openclaw/issues/63145) ·
[Circuit Breaker Patterns for AI Agent Reliability](https://brandonlincolnhendricks.com/research/circuit-breaker-patterns-ai-agent-reliability) ·
[Retries/Fallbacks/Circuit Breakers in LLM apps](https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/)

## 六、验收(四门)

- **热路径零 LLM**:路由决策全确定性,单测证 `RoutingProvider` 零 provider-外调用来选路。
- **opt-in 字节不变**:未配 `fallbacks` 的 agent,`buildProvider` 走单 provider 老路。
- **kernel-deps 门**:`RoutingProvider` 只依赖 `packages/llm` 内部;`fallbacks` 是 core
  additive 可选字段、Hub 不解释。
- **旋钮登记 / 行数预算**:零新 `GOTONG_*` 旋钮(阈值常量,M5 手动探针也零新旋钮 —— surface
  在不在**就是**开关);`main.ts` 顶格 3000/3000,M3/M5b 接线增行靠压注释净零。

**落地实证**(capstone [`examples/model-routing`](../../examples/model-routing)):一个确定性
脚本用真 `RoutingProvider` + 真 `RoutingHealthTracker`(只 stub 两个 provider)四幕跑通
failover → 熔断快速跳过 → 健康投影(= 面板 `snap.routing` 的确切数据)→ 主自愈弹回,
12 条自断言 + `pnpm demo:model-routing` exit 0。单测另有:`packages/llm` `routing-provider.test.ts`
(纯核:首-chunk-前 failover / 熔断三态 / per-candidate model 覆盖)、`packages/host`
`routing-health.test.ts`(9 例事件折叠 + `breaker_close` 即恢复)+ `admin-health.test.ts`
(routing 三态)+ `local-agent-pool-routing.test.ts`(opt-in 字节稳 + 真 failover 喂 tracker +
**M5 逐候选探针:每候选独立探 / mock 短路不调 factory / 未知 id → []**)、
`packages/web` `manifest.test.ts` / `agents-route.test.ts`(fallbacks 校验 + 往返 +
**M5 probe-routing:200 逐候选行 / 503 opt-in / 404 未知不探 / 401 无 token 不探**)+
`llm-key-test.test.ts`(`probeProvider` 共享核 5 例:无空 key 短路契约 / key 擦洗 / 注入时钟)。

**M5 手动测试路由真浏览器 round-trip**(mock host、零 key):配 2 个 mock 备用的 agent 点
「测试路由」→ **3/3 candidates OK** 三行全绿;无 fallback 的 agent **无按钮**;主 mock + 死端点
备用的 agent → **1/2 candidates OK**,主绿、备用红(`describeKeyTest` 映射的人话),控制台零错误。

## 七、相关文档

- 断供监测所在(本 track 的健康面复用它):CARE 可靠性深化,见
  [`docs/zh/PROGRESS-LEDGER.md`](PROGRESS-LEDGER.md) 的 CARE-M5→M8 段。
- 管家 provider 从配置到调用的链路:[`docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md`](ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md)。
- provider 抽象 + 兼容端点(DeepSeek/Qwen/Ollama 都走 `openai-compatible`):[`docs/zh/ARCHITECTURE.md`](ARCHITECTURE.md)。
- 加能力不加耦合的鸭子 `*Surface` 注入(M3 健康面走这条缝):[`docs/zh/SURFACE-PATTERN.md`](SURFACE-PATTERN.md)。
- 防再膨胀承重门(旋钮登记 / 行数预算 / 依赖方向):[`docs/zh/CONVENTIONS.md`](CONVENTIONS.md)。
