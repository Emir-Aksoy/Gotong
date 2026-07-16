# 管家 LLM 自省与多模型自治（LSA）

> 让阿同（personal-butler）**看见自己有哪些模型可调、帮用户发现更多（免费）provider、
> 并能同时用多个模型综合出更好的答案**——但把「自主注册/抓取/写凭证」这条撞安全锚的
> 路，重设计成「阿同发现建议、人授权录入、使用走既有闸」。
>
> 缘起：用户 2026-07-14「我希望 atong 能用一个 skill 主动看自己有哪些 llm key 可以调用
> 以及 websearch 工具可以调用，而且学会自己去找各种免费的 api key 比如 openrouter 的
> 之类的。它得学会自己管理这些而且可以同时使用多个 llm，再根据结果综合一下使用」。
>
> Status: **M1→M5 全落**（M5 = WSE web 搜索 key 即用,2026-07-16 补刀:分级修正 +
> env 快路,「设 TAVILY/BRAVE_API_KEY ⇒ 阿同自己就能搜」）。

---

## 一、把五个诉求分三档（诚实边界）

| 诉求 | 判定 | 落法 |
|---|---|---|
| ① 自省「有哪些 LLM key/候选可调」 | ✅ 能做 | LSA-M1 benign 只读工具，脱敏列候选 provider+model+健康 |
| ② 自省 websearch 等工具 | ✅ 机制已有 + ⚠️ 前提缺 | 自省走 B1；但通用 web search 目前**根本不存在**，LSA-M2 先接一个 |
| ⑤ 同时用多个 LLM + 综合 | ✅ 能做 | LSA-M4 opt-in `EnsembleProvider`（并行 fan-out + 综合），MR 的兄弟 |
| ③ 自己去找免费 key（openrouter…） | ❌ 不能按字面做 → 重设计 | LSA-M3：阿同**发现+建议**候选 provider + 注册步骤；注册/拿 key 是**人**做 |
| ④ 自己管理这些凭证 | ❌ 不能按字面做 → 显式不做 | 凭证写入权永远留 owner + vault，阿同只读自省，绝不自主写/轮换 key |

### ③④ 为什么不能让阿同「自己搞」

- **注册账号是明令禁止的动作**——OpenRouter 等的免费 key 要注册账号，「创建账号/输密码
  认证」框架不能替用户做。
- **网上捡来的 key = 不可信 observed content**——Gotong 信任锚「永不锚在自报/observed
  content」。网页搜到的「免费 key」多半泄露/共享/违反 ToS，注入去花钱调用正是框架一贯拒绝
  的滥用。
- **让 LLM agent 自主写凭证 = 注入面爆炸**——personal-butler 是会被 prompt injection 的
  tool-loop。给它「写 key 进 vault」的权限，一次注入就能把 key 换成攻击者端点（流量全导走）
  或把现有 key 发出去。凭证写入权必须留在 **owner + vault**——这就是「接入≠授权」「发现≠信任」
  在 LLM 域的延伸。

**合法替代（角色分对）**：阿同做发现和建议，人做授权和录入，使用走既有闸。这与 C track
（接入现实生活「接入≠授权行动」）、NET track（管家出网走 governed 闸）完全同源。

---

## 二、四条不可破边界

1. **热路径零 LLM 决策**——自省（M1）是纯投影、发现（M3）是静态目录渲染，都零模型调用；
   多模型综合（M4）是 agent 层行为（阿同这个 participant 决定 fan-out），**不是框架 hub
   跑 LLM**——北极星「框架不跑 LLM」说的是 hub，agent 调模型天经地义。
2. **opt-in，未配字节不变**——M2/M3 的连接器、M4 的 ensemble 都默认关；不启用时逐字节
   与今天一致。
3. **凭证只读 + 数据离盒 opt-in**——阿同对 key **只读脱敏自省**，永不写；投影行结构性
   不含 key/完整 baseURL；远程 provider 离盒必须 opt-in + 披露。
4. **内核零改动**——全在 host/personal-butler/llm 层。M4 的 EnsembleProvider 是
   `packages/llm` 平级件（RoutingProvider 兄弟），core/workflow/protocol 零触碰。

---

## 三、里程碑

### LSA-M1 自省（本 track 起点，benchmark-first）— ✅ 已落

阿同 benign 只读工具 `list_my_llms`：回答「我阿同现在能调用哪些模型」。

- **数据源（两部分 join）**：①候选链清单 = butler 的 `ManagedAgentSpec`（主 provider+model
  + `spec.fallbacks[]`），标签走既有 `routingLabel`（provider 类型/host，**天然脱敏无 key**）；
  ②健康叠加 = `RoutingHealthTracker.snapshot()` 按 butler agentId+index 匹配，给降级候选标
  open/half_open/degraded + errorKind，其余默认健康。
- **脱敏红线（结构性）**：镜像 `list_peers` —— 投影行 `ButlerLlmRow` 根本没有 apiKey/完整
  baseURL 字段，渲染器只读它认识的字段。喂一个带 key 的 spec，渲染文本里不可能出现 key。
- **窄 surface**：`ButlerLlmSurface { listForButler() }` + duck-typed deps（pool 的候选链
  投影 + health snapshot），host/identity 零 import，单测无需真 pool。
- **失败用例（它独有能解）**：不接自省时，成员问「你能用哪些模型/哪个挂了」阿同只能瞎编；
  单测断言 = 有主+2备时准确列 3 行（provider 类型+model+role 对）、index=1 降级时那行标
  「配额」其余健康、**带 key 的 spec 渲染文本零 key 泄露**、单候选诚实说「就一个」。
- **边界**：benign 无旋钮（同 list_peers/list_my_capabilities）、热路径零 LLM、内核零改动。
- **已落**：`personal-butler-llms.ts`（镜像 `personal-butler-peers.ts`）+ pool `butlerLlmRoster()`
  抽 `providerLabelBase`（`routingLabel` 逐字节等价重构）+ factory/main.ts 装配（压注释净零守
  main.ts 3000/3000）；10 单测（渲染/健康三态/**脱敏红线结构性**/单候选诚实/agentId 过滤/空/
  错误/未知工具），host 2087 全绿，四门 PASS（旋钮 114 零新增）。已知边界：健康按声明 `index`
  叠加，某 fallback 构建失败被 router 跳过时后续健康标注可能贴邻行（罕见配置错误，非安全问题）。

### LSA-M2 web search 接入（②的前提）— ✅ 已落

给阿同接一个**通用 web search** MCP 连接器（Tavily / Brave Search，opt-in 走既有连接器目录
`builtin-mcp-connectors.ts`）。凭证走 `${NAME}` 占位 + vault，接入≠授权（搜索是 benign 读，
但「拿搜索结果去对外发」仍过 governed 闸）。接上后 M1 的自省清单里就真有 websearch 了。

- **两条厂商官方连接器**填补预留但一直空着的 `web` 分类：`tavily-web-search`（Tavily 官方
  **托管远程 HTTP + Bearer**，`https://mcp.tavily.com/mcp/`，专为 LLM 优化返回干净正文而非
  一堆链接，工具 `tavily__tavily-search` 等）+ `brave-web-search`（Brave 官方 **stdio**
  `npx @brave/brave-search-mcp-server`，独立索引注重隐私，工具 `brave__brave_web_search` 等）。
- **传输形状按厂商真相走**（2026-07-14 WebFetch 核官方 repo，非凭记忆）：Tavily 有官方托管
  remote → 走 mem0 同款 http+Bearer 头；Brave 无 remote 端点 → 走 todoist 同款 stdio+`${PATH}`。
- **隐私红线（结构性钉进防腐测试）**：Tavily 的 key **只走 `Authorization` 头，绝不进 URL
  query**——即便官方也支持 `?tavilyApiKey=`，我们不走（安全铁律「敏感值永不放查询串」）；
  测试断言 URL 里既无 `${` 占位也无 `apikey` 参数。
- **两条都标 `dataLeavesBox: true` + caveat**：搜索词 + key 都发往第三方云，面板无条件印
  「数据离开本机」。**接入≠授权**：搜索是 benign 读，但「拿搜到的东西去对外发」仍过 governed 闸。
- **已落**：`builtin-mcp-connectors.ts` 加两条 spec（category `web`）+ 防腐测试扩到 23 例
  （`EXPECTED_IDS`/`DATA_LEAVES_BOX_IDS` 各 +2 + 3 条针对性断言：web 分类集/Tavily http+Bearer
  key 不进 query/Brave stdio+PATH）+ 目录文档 `MCP-CONNECTOR-DIRECTORY.md` 加表行与说明块；
  web 1375 全绿，tsc 0，四门 PASS（**旋钮仍 114 零新增**——连接器是常量 catalog 非 env 旋钮；
  main.ts 未触碰 3000/3000）。**opt-in**：不装即字节不变；装了要人在 host 环境填 `TAVILY_API_KEY`
  / `BRAVE_API_KEY`（框架只存 `${NAME}` 占位，密钥不入库）。

### LSA-M3 免费 provider 发现 + 引导录入（③的合法替代）— ✅ 已落

阿同 benign 只读工具 `discover_llm_providers`：渲染一张**静态策展目录**——可选免费/低价
provider（OpenRouter 免费档、Groq、Cerebras、Together 试用、DeepSeek 低价），每个含：能力、免费额度
真相、**注册链接 + 拿 key 三步 + base URL + 环境变量名**。产出「给你的建议卡」。**阿同绝不自己注册/抓取/写
key**；你注册、拿自己的 key、录进 vault（复用现成连接器/OAuth 凭证流），之后阿同就能用。
目录是**代码内静态常量**（同 builtin-mcp-connectors 策展），不是让 LLM 上网搜——避免把不可信
内容当凭证来源。

- **六家 provider（内容全核实，非凭记忆）**：2026-07-14 逐一核官方文档的 OpenAI 兼容 base URL /
  key 页 / 免费额度真相——成员会照着 base URL 去配 agent，写错就是害人，所以宁可少列也要核准。谱系齐：
  免费额度（OpenRouter `:free` 限 50 次/天、Groq RPM/TPM 限流、Cerebras 100 万 token/天、**Gemini
  Flash-Lite ~1000 次/天免信用卡**）+ 试用额度（Together 新号额度）+ 低价（DeepSeek 便宜但非免费）。
  **Gemini 于 2026-07-14 补入（第 6 家）**：M3 首发时它因官方 `docs/openai` URL WebFetch 连报错被显式
  推迟，本次改走 WebSearch 交叉核准 base URL `https://generativelanguage.googleapis.com/v1beta/openai/`
  + 免费额度后补上；`costTruth` 如实写明**免费档输入/输出可能被 Google 用于改进产品**（隐私真相，非营销）
  + 额度以 AI Studio 实时为准。（那个 `docs/openai` URL 已在项目 CLAUDE.md §4.1 列为禁止 WebFetch。）
- **角色分对（③④ 重设计的落点）**：工具**只渲染建议**——`ButlerLlmProviderOption` 结构上**没有 key
  字段**，注册/拿 key/填 key 全是人做。渲染的卡**每次都印两条红线**：① 我不替你注册、绝不去网上「捡」
  别人的 key（那种多半泄露/违规）；② 我对 key 只读不写（配好后能看「用哪个 provider、健不健康」=
  list_my_llms，但改/存 key 永远是你 + 金库的事）。工具描述里也钉了同样的铁律，防模型漂移成「我帮你注册」。
- **最简缝**：benign always-on（同 `list_my_capabilities`——纯静态常量渲染，零 surface / 零 deps /
  零 main.ts 改动 / 零新旋钮）。factory 无条件构建 + 进 benign 数组一行。它和 M1 天然咬合：M1
  `list_my_llms` 说「只有 1 个模型没退路」→ 成员问「那能加啥」→ M3 `discover_llm_providers` 答。
- **已落**：`personal-butler-llm-catalog.ts`（`CURATED_LLM_PROVIDERS` 常量 + `renderProviderCatalog`
  + 工具）+ factory 装配（import + 无条件构建 + benign 一行）；防腐测试 8 例（**目录集 + base URL 逐条
  钉**[成员照着操作、写错即害人]+ 每条完整性 + https/env 名形状 + **渲染必含两条红线**[承重安全断言]+
  工具行为/未知工具拒绝），host 2095 全绿，四门 PASS（旋钮仍 114 零新增，main.ts 3000/3000 未触碰）。

### LSA-M4 多 LLM 并行综合（⑤，本 track 封顶）— ✅ 已落（纯核 + capstone；配置面显式推迟）

opt-in `EnsembleProvider`（`packages/llm`，RoutingProvider 兄弟）：并行 fan-out 到 N 个成员，
收齐 N 份草稿后按策略综合成一份——这是用户诉求⑤「同时用多个 llm 再综合」。两者都实现
`LlmProvider`，对上游（LlmAgent）完全透明，区别只在内部：**routing 顺序选一个，ensemble
并行用全部**。

- **两种综合策略**：`concat`（确定性拼接 N 份草稿，零额外 LLM 调用，可测免费）/ `synthesize`
  （让一个综合器模型把 N 份草稿折成一份最终答案，+1 次调用，内置中文综合指令可覆盖）。
- **tool_use 不可综合（正确性红线）**：「综合」只对纯文本答案成立。若领头成员想调工具
  （`stopReason==='tool_use'`），两个不同工具调用没法「取平均」——ensemble 把它的 response
  **原样透传**（passthrough），绝不综合。故工具循环里选工具的轮次退化为「跟第一个成员走」，
  只有最终纯文本答案那轮才真 fan-out + 综合。
- **诚实成本记账**：`sumUsage` 把 N 份成员 usage（+ 综合器那次）加总，成本 ×N 一分不藏（面板
  用量列如实显示）。
- **韧性**：部分成员失败被丢弃，存活成员照常综合（`member_failed` 事件如实记 errorKind）；
  全失败抛 `EnsembleExhaustedError`；综合器空产出 fail-soft 退回 concat，绝不让综合失败连累整轮；
  主动 abort 一路抛出不当「成员失败」吞掉。**并发安全**：`synthesize` 返回 `{text,usage}` 而非存
  实例字段，同一 provider 实例并发 `stream()` 不互相串。
- **四条边界**：① 热路径零 LLM 决策——开不开 ensemble 是装配层 opt-in 配置（像 routing 的
  fallbacks），fan-out 本身确定性（永远发全部 N 个），没有模型在现场决定发给谁；② opt-in 字节
  不变——不配 ensemble 根本不包这个 provider；③ 数据离盒 opt-in——同一 prompt 发 N 个厂商由装配者
  亲手编排；④ 内核零改动——本类在 `packages/llm`（RoutingProvider 平级），成本/阈值全无 env 旋钮。
- **失败用例（钉死两件事）**：① **并行 fan-out**——计数 provider 证明 ensemble 调了**全部** N 个成员
  （routing 只调到第一个成功的）；② **真综合而非透传单份**——synthesize 下综合器**收到全部 N 份草稿
  + 原问题**（recording provider 断言），concat 下 N 份都在输出里。外加 usage 聚合 ×N、部分失败存活、
  全失败抛错、tool_use 透传、abort、`sumUsage` 三例。
- **已落**：`packages/llm/src/ensemble-provider.ts`（`EnsembleProvider` + `EnsembleMember` /
  `EnsembleStrategy` / `EnsembleEvent` 类型 + `EnsembleExhaustedError` + 导出 `sumUsage` 助手）+
  index.ts 导出块；13 单测（concat 标签全在 / **并行计数 ×3** / synthesize 收全草稿 / usage ×N /
  丢失败成员 / 全失败抛错 / tool_use 透传 / 综合器空 fail-soft / 预 abort / 需 ≥1 成员 / sumUsage×3）+
  capstone `examples/model-ensemble`（真 `EnsembleProvider` 零重写，只 stub 几个成员，五幕自断言：
  并行 fan-out+concat / synthesize 收全草稿 / usage 聚合 ×N / 部分失败存活 / tool_use 透传；三家成员
  借 M3 目录里 OpenRouter/Groq/Cerebras；`pnpm demo:model-ensemble` exit 0）。验收：llm 245 全绿
  （232→245）、demo exit 0、四门 PASS（**旋钮仍 114 零新增**——EnsembleProvider 是 provider 不是旋钮；
  main.ts 3000/3000 未触碰）。
- **显式推迟（本 M 只落纯核 + capstone，轻量封顶）**：`ManagedAgentSpec.ensemble` 配置字段 +
  pool 装配缝（`buildRoutedProvider` 同款咽喉点把成员包成 EnsembleProvider）+ admin 面板编辑器 +
  面板成本披露徽章——这是**独立配置里程碑**（镜像 MR track：M1 纯核 → M2 才是配置面 + providerFactory
  接线）。纯核 + capstone 已把「并行综合能不能成、边界对不对」证死；配置面按需再起（要真让某个 agent 走
  ensemble 时，加 additive 字段 + 一处 opt-in 装配缝即可，不预造）。

---

### LSA-M5 web 搜索 key 即用（WSE，②的收口）— ✅ 已落（2026-07-16）

用户回头问「工具包里有没有 web-search?没有就整合成一类能力,**给它加上 key 自己就能
使用那种**」。侦察发现 M2 接了目录之后,「阿同自己就能搜」其实还剩**两道断点**,本刀
一次收口（新模块 `packages/host/src/butler-web-search.ts` + factory/pool/main.ts 三缝）:

- **断点 1:分级 —— 这才是真阻断点**。2026-07-16 对两家官方 server 源码逐字核过
  （`gh api` 拉 tavily-ai/tavily-mcp 与 brave/brave-search-mcp-server）:**都没标
  `readOnlyHint`**（Tavily 工具定义零 annotations;Brave 只有 title+openWorldHint）,
  工具名（`tavily_search`/`brave_web_search`）又不以 read 动词开头 → 按
  `defaultMcpToolClass` 的 fail-safe **全落 governed = 每搜一次 park 一次等审批**。
  修法 = `classifyButlerMcpTool`:server 级只读知识兜底（这两台 server 的工具面全是
  「读外部世界」,不存在「写用户数据」的对象）。优先级钉死:**server 显式 annotations >
  read 动词启发 > 搜索 server 名单 > fail-safe write**——未来官方真加了
  `destructiveHint` 的工具照 govern,名单只接「毫无信号」的兜底段。这半刀同时修好
  面板路径（手动装 + 挂管家的部署也不再每搜必批）。
- **断点 2:装配 —— 目录路径要面板两步**（装连接器 + 编辑管家行 `useMcpServers`）。
  补 env 快路:`TAVILY_API_KEY` / `BRAVE_API_KEY` 在 host 环境里 ⇒
  `detectButlerWebSearchSpecs` 取**目录同一条 spec**（原样引用零复刻,key 只以
  `${NAME}` 占位存在,明文结构性进不来）⇒ pool 新构造项 `butlerBonusMcpSpecs`
  只对**管家行**在 spawn 时并入（`mergeButlerBonusMcpSpecs` **同名让位**——成员/
  管理员自己配的 server 永远赢,bonus 只补缺）。挂上后搜索工具走 S1-M2 的 MCP read
  半边直接进 benign 面,B1 能力清单按 `<server>__` 前缀自动长出来。
- **env 名为什么不带 GOTONG_ 前缀**:探测名被目录 spec 的占位钉死——spec 里写的是
  `${TAVILY_API_KEY}`,`envSecretSource` 按这个名查 process.env,探测名 ≠ 占位名的话
  挂上也展不开;且这俩是 Tavily/Brave 生态惯例凭证名,与目录 `needsEnv`、面板提示
  一致,**一份 key 两条路径通用**（`MEM0_API_KEY` 先例:连接器凭证,非 GOTONG_* 行为
  旋钮,env-registry 不涉及）。
- **授权论证（为什么设 key 即挂管家）**:面板路径装连接器时 key 进 vault,env 里根本
  不需要有——env 出现 `TAVILY_API_KEY` 的唯一动机就是「让这台 hub 的 AI 能搜」,
  放 key 本身就是最粗粒度 opt-in;要精细控制（只给某台 agent 不给管家）走面板 vault
  路径,两路互不干扰。数据边界照旧:搜索词离盒是目录 `dataLeavesBox: true` 早已披露的
  既定事实;**接入≠授权**——拿搜到的东西对外发仍是 governed 动作。没设 key = `[]` =
  全链路字节不变。
- **顺手抓到的真缺口**:`@gotong/web` 的 **dist 陈旧**——LSA-M2 的两条连接器只在
  src,web 包一直没重 build,而 host 是第一个消费这个常量的包（M2 防腐测试在 web 包内
  直跑 src 所以一直绿）。已重 build;新增的「目录同源」防腐测试从 host 侧 import
  `BUILTIN_MCP_CONNECTORS` 断言两条目形状,**兼任 dist 新鲜度哨兵**（dist 再陈旧它就红）。

**验收**:新单测 16 例（目录同源 2/detect 5[含 key 明文防腐 + query 串红线]/classify
3[含显式 write 赢名单]/merge 3/pool 注入 3[butler 行挂上·非 butler 行零注入·同名恰一份,
死命令 spec 零网络零真凭证]）;host 全套 2183→**2199** 全绿;tsc 零错;四门 PASS
（**旋钮 114 零新增**,main.ts 3000/3000 压注释净零）。

## 四、显式不做

- **阿同自主注册账号 / 抓取网上的 key**（撞 prohibited action + 不可信来源）。
- **阿同自主写 / 轮换 / 管理 vault 里的凭证**（注入面 + 信任锚留 owner+vault）——④ 的硬边界。
- **让 LLM 上网搜「免费 key」**（把 observed content 当凭证来源）——M3 走静态策展目录代替。
- **跨 agent 枚举整个 hub 的所有 provider/key**——M1 收窄到 butler 自己的候选链（admin 面板
  已有 agents 配置页管全局）。

---

## 五、现状地基（2026-07-14 核实，非凭记忆）

- **通用 web search 目前不存在**：连接器目录只有 `mcp-registry-search`（搜 MCP 注册站）、
  `obsidian__search`（搜本地笔记）、chroma（RAG），没有一个搜互联网 → LSA-M2 补。
- **自省地基在 B1**：`list_my_capabilities`（personal-butler-capabilities.ts）已从真实已装工具
  派生「我能帮你做这些」，但不含 LLM provider/key 自省 → LSA-M1 补。
- **多模型现状是顺序 failover**：`RoutingProvider` 首选挂了才换下一个（省钱/容错），
  `RoutingHealthTracker` 折叠 per-candidate 健康 → LSA-M4 加并行综合（兄弟模式）。
- **镜像模板**：`list_peers`（personal-butler-peers.ts）= 脱敏投影行 + 窄 surface + duck-typed
  deps + 工厂在 surface 缺失时丢弃，LSA-M1 逐一照抄。
