# 管家 LLM 自省与多模型自治（LSA）

> 让阿同（personal-butler）**看见自己有哪些模型可调、帮用户发现更多（免费）provider、
> 并能同时用多个模型综合出更好的答案**——但把「自主注册/抓取/写凭证」这条撞安全锚的
> 路，重设计成「阿同发现建议、人授权录入、使用走既有闸」。
>
> 缘起：用户 2026-07-14「我希望 atong 能用一个 skill 主动看自己有哪些 llm key 可以调用
> 以及 websearch 工具可以调用，而且学会自己去找各种免费的 api key 比如 openrouter 的
> 之类的。它得学会自己管理这些而且可以同时使用多个 llm，再根据结果综合一下使用」。

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

### LSA-M1 自省（本 track 起点，benchmark-first）

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

### LSA-M2 web search 接入（②的前提）

给阿同接一个**通用 web search** MCP 连接器（Tavily / Brave Search，opt-in 走既有连接器目录
`builtin-mcp-connectors.ts`）。凭证走 `${NAME}` 占位 + vault，接入≠授权（搜索是 benign 读，
但「拿搜索结果去对外发」仍过 governed 闸）。接上后 M1 的自省清单里就真有 websearch 了。

### LSA-M3 免费 provider 发现 + 引导录入（③的合法替代）

阿同 benign 只读工具 `discover_llm_providers`：渲染一张**静态策展目录**——可选免费/低价
provider（OpenRouter 免费档、Groq、Together 试用、DeepSeek 低价…），每个含：能力、免费额度
真相、**注册链接 + 三步指引**、录入到哪。产出「给你的建议卡」。**阿同绝不自己注册/抓取/写
key**；你注册、拿自己的 key、录进 vault（复用现成连接器/OAuth 凭证流），之后阿同就能用。
目录是**代码内静态常量**（同 builtin-mcp-connectors 策展），不是让 LLM 上网搜——避免把不可信
内容当凭证来源。

### LSA-M4 多 LLM 并行综合（⑤）

opt-in `EnsembleProvider`（`packages/llm`，RoutingProvider 兄弟）：并行 fan-out 到 N 个候选，
按策略综合——择优 / 投票 / 让一个模型 synthesize N 份草稿。
- **成本 ×N + opt-in + 披露**：默认关；开了每轮多花 N 倍（+ 综合若用模型再 +1）。
- **热路径**：这是 agent 层选择（阿同带工具的轮次可选走 ensemble），不违反「框架 hub 零 LLM」。
- **失败用例**：构造 N 个 stub provider 给不同答案 + 一个综合器，断言 ensemble 输出综合了
  多份而非单份；与 RoutingProvider（顺序 failover）的区别用测试钉死（ensemble 并行、routing
  顺序）。

---

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
