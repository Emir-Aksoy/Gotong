# Gotong — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-07-09

---

## 一、本项目存在的意义（北极星）

Gotong 要做的是 **AI 时代「人-智能体-机构」三层链接的工作底座**：

```
   第 1 层  人 ↔ 自己的 AI / agent
            「我的 AI 桌面」: 一个人的 hub, 私人 workflow, 凭证只在本机
            目标: 5 分钟跑起来, 不写代码, AI 帮我做实际的事

   第 2 层  人 / agent ↔ 别的人 / agent / 机构
            「跨组织协作」: 多 user, role, 邀请, 跨 hub federation
            目标: 工作流可跨边界, 但凭证/数据/计费各归各家

   第 3 层  框架本身
            「清晰 + 稳定 + 适配」: Hub is dumb on purpose, file-first,
            participant 是统一抽象, 协议 / 凭证 / 配额都有显式边界
            目标: 工作流能实际落地, 跟得上 AI 快速发展
```

**三句话守则**:

1. **框架不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件,
   决策权永远在参与者(agent / 人 / 外部服务)手里。这是从 v0 到现在
   不变的设计立场, 改了就不是 Gotong。

2. **人和 agent 是同一个 `Participant`**。不要把人当 "request_human_input
   tool"。一切跨人 / 跨 agent 的协作都走同一套消息 + task + transcript。

3. **状态都是磁盘文件**。`.gotong/` 目录里能看到 transcript / agents /
   sessions / secrets / vault。复制目录 = 搬走房间。重启透明。

---

## 二、现在在哪一段

> **完整进展账本（v1.x → RES 全部里程碑、每个 Phase/Stream 的 commit 与设计决策、
> 验收门、显式推迟）已整体移到 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)。**
> 那里逐字保留历次收口记录；本节只留最近三个里程碑的指针。要查任何历史
> Phase/Stream（v1.x → v5 全部「完」）的落地细节、commit、设计权衡，**读账本**。

最近的里程碑（倒序,最新在上）：

- **管家 LLM 自省与多模型自治 track（LSA）全完：M0 计划 + M1 自省 + M2 web 搜索 + M3 发现引导 + M4 并行综合封顶
  （2026-07-14，`5a5fd45`→本 commit 共 5 commit）** — 用户诉求「我希望 atong 能用一个 skill 主动看自己有哪些 llm key
  可以调用以及 websearch 工具可以调用,而且学会自己去找各种免费的 api key 比如 openrouter 的之类的。它得学会自己
  管理这些而且可以同时使用多个 llm,再根据结果综合一下使用」。**M0 把五诉求分三档**(`5a5fd45`,纯 docs
  `docs/zh/LLM-STEWARDSHIP.md`):①自省 key/候选(能做→M1)、②自省 websearch(机制有但通用 web search 根本不存在→M2
  先补)、⑤同时用多 LLM+综合(能做→M4);**③「自己去找免费 key」④「自己管理」按字面撞安全锚 → 重设计**——注册
  账号是禁止动作、网上捡的 key=不可信 observed content、给会被 prompt injection 的 tool-loop 写 vault 权=注入面
  爆炸(一次注入把 key 换成攻击者端点/把现有 key 发出去),故重设计成「阿同**发现+建议** provider+注册步骤 → **人**
  注册/录入 key → 使用走既有闸」(与 C track「接入≠授权」、NET track「发现≠信任」同源);用户拍板「按重设计走」。
  **四条不可破边界**:①热路径零 LLM 决策(自省纯投影、发现静态目录、综合是 agent 层行为非 hub 跑 LLM);②opt-in
  未配字节不变;③凭证只读+数据离盒 opt-in(阿同对 key 只读脱敏,投影行结构性不含 key/完整 baseURL);④内核零改动
  (全在 host/personal-butler/llm 层,EnsembleProvider 是 `packages/llm` 平级件)。**M1 自省**(`12f7dfa`)benign 只读
  `list_my_llms`:候选链(butler `ManagedAgentSpec` 主+`fallbacks[]`,标签走 `routingLabel` 天然脱敏)join 健康叠加
  (`RoutingHealthTracker.snapshot()` 按 agentId+index),脱敏红线结构性(镜像 list_peers,投影行 `ButlerLlmRow` 根本没
  apiKey 字段)+ 窄 surface `ButlerLlmSurface`;10 单测(含带 key spec 渲染零泄露)。**M2 web 搜索**(`b4e2c8a`)填补预留
  但空着的 `web` 分类两条厂商官方连接器:`tavily-web-search`(官方托管 http+Bearer `https://mcp.tavily.com/mcp/`,
  为 LLM 优化返回干净正文)+ `brave-web-search`(官方 stdio `npx @brave/brave-search-mcp-server`);传输形状 2026-07-14
  WebFetch 核官方 repo 非凭记忆;**隐私红线结构性钉进防腐测试**——Tavily key 只走 `Authorization` 头绝不进 URL query
  (即便官方支持 `?tavilyApiKey=` 也不走,安全铁律「敏感值永不放查询串」),两条都 `dataLeavesBox:true`;23 防腐测试。
  **M3 发现引导**(`4b90135`,③④重设计落地)benign 只读 `discover_llm_providers`:渲染**静态策展目录**——五家 provider
  (OpenRouter/Groq/Cerebras 免费额度 + Together 试用 + DeepSeek 低价),每条含 OpenAI 兼容 base URL/免费额度真相/注册
  链接/拿 key 三步/环境变量名(2026-07-14 WebFetch 逐一核官方文档——成员照 base URL 配 agent 写错即害人,宁少列也
  核准;Google Gemini 因文档 URL 连报错显式推迟);**角色分对**——`ButlerLlmProviderOption` 结构上无 key 字段,渲染卡
  **每次都印两条红线**(①不替你注册、绝不网上捡 key;②对 key 只读不写)+ 工具描述钉同铁律防模型漂移成「我帮你注册」;
  目录是代码内静态常量(不让 LLM 上网搜=不把 observed content 当凭证来源);8 防腐测试(base URL 逐条钉+渲染必含两红线)。
  **M4 并行综合封顶**(本 commit)opt-in `EnsembleProvider`(`packages/llm`,RoutingProvider 兄弟)——**routing 顺序选一个,
  ensemble 并行用全部**:同一请求 fan-out 到 N 成员,收齐 N 份草稿按策略综合(`concat` 确定性拼接零额外 LLM /
  `synthesize` 综合器折成一份);**tool_use 不可综合正确性红线**(领头成员想调工具则整轮原样透传,两个工具调用没法取
  平均);`sumUsage` 成本诚实 ×N;韧性(部分失败丢弃存活/全失败抛 `EnsembleExhaustedError`/综合器空 fail-soft 退回
  concat/主动 abort 一路抛出);**并发安全**(synthesize 返回 `{text,usage}` 非存实例字段,同实例并发 stream() 不串);
  13 单测(**并行计数 ×3** 钉死 fan-out 全调[routing 只调一个]+ synthesize 收全草稿 + usage ×N + tool_use 透传 +
  sumUsage×3)+ capstone `examples/model-ensemble`(真 EnsembleProvider 零重写只 stub 成员,五幕自断言,三家成员借 M3
  目录 OpenRouter/Groq/Cerebras;`pnpm demo:model-ensemble` exit 0)。**M4 显式推迟**(轻量封顶只落纯核+capstone):
  `ManagedAgentSpec.ensemble` 配置字段 + pool 装配缝 + admin 面板 + 成本披露徽章=独立配置里程碑(镜像 MR:M1 纯核→M2
  才配置面),纯核+capstone 已把「并行综合能不能成、边界对不对」证死,配置面按需再起不预造。验收:llm 245(232→13)/
  host 2095/web 1375 全绿,demo exit 0,四门 PASS(**旋钮 114 全程零新增**——连接器是常量 catalog、EnsembleProvider 是
  provider,均非 env 旋钮;main.ts 3000/3000 全程未触碰)。见 [`docs/zh/LLM-STEWARDSHIP.md`](docs/zh/LLM-STEWARDSHIP.md)。
- **分级信任 track（GT）全完：M1→M7 + capstone（2026-07-13，`fad38e0`→本 commit）** — 用户战略问「探索跨 hub
  协议,我希望它不仅是标准化的,而且可以是多层级的,不一定每级都同一安全标准,应分几级,安全性逐步提高、易用性
  相对逐步降低……再深度思考未来 agent 和人之间网络的实际需求」。开工前 5 路子代理 + 4 处一手核实体检出**四条已解耦
  的信任轴**(只第一条成熟):动作风险轴(park 分级)成熟、**peer 信任轴扁平**(12 字段一刀切无梯度)、身份确证轴
  (pinnedKid)狭窄、审批摩擦轴不看信任只看动作。且揪出**真矛盾**:`peer-acl.ts` 的 `outboundCaps=null` 是
  accept-all,与 runbook §4 白纸黑字的 fail-closed **直接打架**。**七决策(用户拍板)**:核心=**选 A**(trustTier=
  **人选的信任档**,非从行为自动推断的分数);岔口 1=**新增独立 `trustTier` 字段**(不复用 PeerKind——「对方是什么」
  与「我多信任」两正交轴);岔口 2=**改代码 fail-closed**(反转 null→deny,破坏性);岔口 3=**纯软连接**(身份确证
  ↔ 授权档只 advisory 提示,绝不自动改权限);岔口 4=**做信任引荐**;岔口 5+地基=**分级作为 wire 协议一等公民 +
  标准化 mesh 层 + A2A 卡保持纯净**(两层不混)。**四条不可破边界**:①热路径零 LLM(选路 / 裁决全靠纯函数查矩阵 +
  比档位);②fail-closed 地板(新边默认 T1、未知动作/未知档一律 deny);③纯软连接(PIN / 引荐只产出 owner 面板
  建议,升降档永远人点头);④声明 ≠ 信任(信任锚在**结构不可伪造处**=bearer token / owner PIN 公钥 / owner 打的
  trust_tier,**永不**锚在 wire 自报)。**四档**:T0 `discoverable`(未握手,零 mesh)/ T1 `token`(双边令牌握手=
  今天联邦门槛,**默认地板**)/ T2 `verified`(owner 显式 PIN 签名公钥)/ T3 `trusted`(owner 显式提升)。**决策矩阵**
  (动作风险 × 档 → 审批摩擦):同动作档越高摩擦越低、同档动作越危险摩擦越高;**信任只降摩擦永不去底线**——dangerous
  即使 T3 仍要 member_notify(可追责),forbidden 任何档拒,T0 任何动作拒。**七刀**:M1(`fad38e0` 前)trustTier 纯核
  `core/trust-tier.ts`(枚举 + tierRank + DECISION_MATRIX + `decideTrust`/`decisionRequiresHuman`,50 单测);M2
  (`fad38e0`)**fail-closed 破坏性反转** `peer-acl.ts` null→deny + 修 runbook §4 矛盾;M3(`3134740`)schema **v37**
  `ALTER TABLE peers ADD COLUMN trust_tier`(additive nullable,null=未分级回落 T1)+ peer-store 读写 + web admin
  策略编辑器落档/显示(镜像 STD-M2b-2 pinnedKid 同款,identity peers 62 / web identity-routes-peers 47);M4
  (`7c4d85d`)纯软连接 `suggestTierFromIdentity`(pin_verified 且 <T2→建议升 T2、pin_mismatch 且 >T1→建议降 T1;
  **PIN 只证身份=T2 门槛,证不了 T3;建议 ≠ 自动改档**);M5(`62fa219`)信任引荐 `suggestTierFromReferral`(引荐人
  ≥T2 才算数→建议初始档=**地板 T1**;**信任不传递**钉进函数形状:哪怕引荐人 T3 也只建议 T1);M6(`13ff07d`)**mesh
  wire trustTier 声明**——`MESH_HELLO`/`MESH_HELLO_ACK` 加**可选** advisory `trustTier` 字段 + `declaredTrustTier`
  选项 + `peerDeclaredTrustTier` getter(**link 内 auth/gating/routing 一处不读它**);「声明 ≠ 信任」铁律钉进结构:
  捕获**只在认证通过后**(被拒握手零记录)、未知值落 null、`MESH_PROTOCOL_VERSION` 保持 '1' 不跳(=此字段不承重的
  证明);6 例单测含**铁律**(错 token 声明 T3 仍 peer_token_invalid 关闭、onLink 永不触发、零捕获);同刀把 mesh 标准化
  成公开 wire 规范 `docs/zh/MESH-PROTOCOL.md`(三层协议地图 / 握手裁决序 / 全 `MESH_*` 帧目录 / §6 分级声明 / §7 A2A
  纯净,164 单测 +6);M7(`cc34967`)公网协议写明分级——MESH-PROTOCOL §10「公网分级信任模型与协商语义」(四档 + 摩擦
  矩阵 + 四种协商语义**逐条标 `[当前实现]`/`[未来公网预留]`**:(a) 单向 advisory 声明已落、(b) 最低档要求 / (c) 双向
  协商[有效档=min 只更严] / (d) 引荐凭证上 wire 三者预留 + 贯穿铁律「协商承载声明永不承载信任赋予」+ 外部实现自洽性
  检查 + **成熟度诚实声明**)。**capstone** `examples/graded-trust`:真 `decideTrust`/`suggestTierFrom*` 纯函数零重写、
  零网络零 key 零 LLM,四幕自断言——新 peer 落地板 T1(全动作要人)→ PIN 建议 T2(**建议 ≠ 自动升**:owner 点头前
  生效档仍 T1、矩阵仍按 T1 裁决)→ owner 提升 T3(付款审批从 owner_approve 一路降到 member_notify 但**永不 auto**,
  底线守住)→ T3 伙伴引荐 hub-Z 建议**地板 T1 非 T3**(信任不传递)+ 不够格引荐人产出 null;`pnpm demo:graded-trust`
  exit 0。验收:core trust-tier 50 / transport-ws 164(+6)/ identity peers 62 / web identity-routes-peers 47 全绿,
  四门 PASS(**旋钮 109 零新增**——trustTier 是 schema 字段 + wire 可选字段,纯函数非旋钮;kernel-deps 不破,core 仍
  只依赖 protocol、transport-ws→core 方向正确;main.ts 3000/3000)。显式推迟:§10 (b)(c)(d) 公网协商语义(尚无 wire
  字段、尚无跨实现评审,钉方向 + 铁律不预造)、面板实时「匹配/不符」徽章(STD-M2b-3 同款理由收口,验证能力已由 CLI
  交付)。见 [`docs/zh/GRADED-TRUST.md`](docs/zh/GRADED-TRUST.md) + [`docs/zh/MESH-PROTOCOL.md`](docs/zh/MESH-PROTOCOL.md)。
- **IM 审批闭环 track（IMA）全完：M0 计划 + M1 纯核 + M2 host + M3 e2e（2026-07-11，`105dabd`→本 commit 共 4 commit）** —
  用户战略问「假设用户只使用手机端,哪些功能受限?能否整合进手机 IM?」,评估结论=管家工具面已比直觉宽
  (IM 里早能聊/建改 agent/建改跑工作流/查状态用量诊断),**唯一每天撞上的硬断点=审批闭环断在半路**(UX-A1
  在 IM 提醒「N 件事等你批」但批准动作只在 web /me,纯 IM 用户被叫醒了干不了活);用户拍板「开工,先做 IM
  审批闭环,安全姿态选 b」(b=分级:普通 park 项 IM 可批,cross_hub/花钱/对外类仍要 web)。**三道钉子**:
  ①`InboxItem.imApprovable?: true` **白名单 fail-closed**——只有写入方显式标了的项才能 IM 批,未标(ACP 升级/
  steward park/未来新来源)天然 web-only 零登记,风险裁决钉在写入时一个权威点,IM 面只做只读复核;标的两处
  =human 步 broker(本就指派给这个人)+ 管家 governed park(按钉子②);②**web-only 按名字形状结构性判定,
  不逐工具枚举**——park 时从 `pending.toolUses`+`approvedId` 锚定被批工具(绝不看兄弟工具,找不到=不标
  fail-closed):`ask_peer`(跨 hub 出网)不标、名含 `__`(MCP `<server>__<tool>`=dataLeavesBox 方向)不标、
  其余 hub 内配置动作(建/改/删 agent、建/改工作流)标——未来任何新连接器 WRITE 动作自动落保守侧;③**审计
  如实记通道**——resolve 加可选 `via`,actorSource 走闭集新值 `'im'`(FED-M4 'federated' 同款;实现修正=计划
  的「actorSource 直写 im:telegram」会被读侧钳制守卫压成 system **恰好丢掉要记的事实**,故枚举一个值+细节入
  `metadata.via`,identity 类型/写入白名单/web 镜像联合三处同步),web 路径 via 缺省 'v4-session' 字节不变。
  **命令面**:`/inbox`(短码+标题,web-only 项标「需在网页处理」)+`/approve <id>`+`/deny <id>`(别名
  /reject);短码=itemId 前 8 字符**无状态前缀匹配**(不发序号——序号随新项漂移),≥4 位、本人 listPending
  范围内(前缀永远够不到别人的项)、歧义列全码拒绝绝不 first-match-wins。**执行链全复用零新权威点**:桥三
  case→`HostImConfig.approvals` 鸭子(未接=回「未启用」,resolveWorkflow 姿态)→`ImApprovalService`(投影+
  五道闸)→既有 `HostInboxService.resolve`(ownership/race guard/两步续跑/审计/S1-M3 onResolved 回推);
  **回推方向零新代码**(S1-M3 管道早在,IMA 只补「决定」方向),park 回执在接了审批面时改指 /inbox——park→
  提醒→批→回推四步全在同一聊天窗。装配:wiring 构造服务,main.ts 一行 spread 压注释净零。e2e 三幕(真 Hub/
  store/controller/resolve,只桥假):工作流 human 步 IM 批→run done+审计 im 行/管家 park 批→回推完成话术+
  挂起行清/ask_peer 拒批 fail-closed(pending 仍在零审计行)。验收:host 2058/identity 654/inbox 24/
  im-adapter 33/web 1365 全绿,四门 PASS(**旋钮 109 零新增**——approvals surface 接不接就是开关;main.ts
  3000/3000)。显式不做:choice/edit 的 IM 应答(v1 只批 approval 二值)、owner 面(steward dangerous/联邦
  出站/ACP 升级仍 web-only)、平台 inline 按钮(六桥纯文本同款)、IM 二次确认短语(分级已挡高危)。见
  [`docs/zh/IM-APPROVAL.md`](docs/zh/IM-APPROVAL.md)。
- **原生适配 track（NA）全完：M0 体检 + M1 提示词缓存 + M2 调用韧性 + M3 分块缓存 + M4 命中率可见化 + M5 维护低价模型 + M6 流式侦察 + M6a/M6b 两张成员脸流式落地（2026-07-10/11，`aef7ee2`→`eb246a8` 共 9 commit）** —
  用户问「阿同/框架能否加强原生适配以获更强稳定性更高效率」,先体检后开工(每缺口 file:line 证据):**骨架层已
  高度原生**(常驻实例/冻结块/治理闸/派发/配额全走框架缝),真缺口全在 **LLM 调用层**。最大发现=**缓存下游管道
  五个月前就全建好**(LlmUsage 字段/anthropic 响应解析/pricing 1.25×·0.1× 计价/ledger 列)但请求侧从没下过
  `cache_control`——Anthropic 缓存显式 opt-in,不下断点全链路恒零;管家每轮 ~34+ 工具 schema(6–10K token)+
  工具循环每 round 全量重付同一段前缀。用户拍板 **A+B 都做**。**M1 缓存原生化**(`c503335`):anthropic buildBody
  尾三断点(工具尾/system 尾[字符串升格 text 块语义等价]/末消息尾块[逐 round 移动增量缓存,thinking 块不可挂故
  walk-back])+ **auto 规则=带工具的请求才下**(循环形状轮内复用结构性保证,1.25× 写溢价必被 0.1× 读赚回;无工具
  单发字节不变,key 探针天然免特判),`promptCaching` 构造项强制两向,零 env 旋钮,按「零门槛默认发」法则默认开;
  **轮内节省结构性保证**(不赌用户 5 分钟内回消息),首 token 延迟同步缩短;M1b=OpenAI 侧自动缓存命中如实入账
  (`prompt_tokens_details.cached_tokens`/DeepSeek `prompt_cache_hit_tokens` 填 cacheReadTokens 并从 inputTokens
  扣除守文档不变量)。**M2 调用韧性**(`2771f15`):体检抓到两 provider 都支持 AbortSignal 但装配层**从没传过**——
  挂死流卡成员轮,RoutingProvider 只救「首 chunk 前抛错」救不了「光挂着」;新 `packages/llm/resilience.ts` 纯核
  `withCallWatchdog`(双表首 chunk 前/间隙各 120s 常量;超时双保险=abort 内层+Promise.race 弹出,无视 signal 的
  provider 也困不住;`LlmCallTimeoutError.name` 带 Timeout 走 classifyLlmError 既有判据归 'timeout',播报/熔断/
  重试全免认识新类)+ `withTransientRetry`(仅首 chunk 前/仅瞬态类 network·timeout·rate_limited/同 provider 单次/
  退避 2s;吐过 chunk 一律不重试=MR 同条纪律;主动取消绝不重试);装配缝 pool `buildRoutedProvider` 咽喉一处盖全:
  看门狗包**每个叶子**(含路由每候选——挂死折算该候选 timeout,failover 因此能接手),重试只包**无 fallbacks 单
  provider 形态**(有候选链时 failover 就是重试故事不叠加)。用户追问「还有没有能进一步做的」拍板四项全做。
  **M3 system 分块缓存**(`3a1efbc`):UX 时钟卡(分钟级变)让 system 每轮变,M1 的 system 尾断点**恒失效**,
  人设+冻结块白写缓存——新 `LlmRequest.systemVolatile`,**全 provider 逐字节拼接** `(system??'')+(systemVolatile??'')`
  (分隔符随 volatile 走,不启用缓存路径与拆分前逐字节一致),只有 cache-aware anthropic 挂标时拆两块:稳定块挂
  cache_control、volatile 作第二个**不挂标** text 块(给每轮变的块挂标=写了永不读);butler `composeContextProbes`
  探针卡(时钟/待办/间隔/渠道/复述)整体走 volatile,人设+冻结块留稳定段,断点从恒失效变恒命中;教训=三处断言
  `req.system` 的既有测试要改断拼接视图。**M4 命中率可见化**(`b82f3b7`):侦察发现后端零工作(usage-routes
  DTO/CSV/聚合从 M1 起就带 cache 两列只是没渲染),纯前端 usage-ui.js 加「缓存读/缓存命中率」两列——命中率
  =cacheRead/(input+cacheCreation+cacheRead)(M1b 后 input 只计新鲜段,三段互斥和=提示词全量分母才诚实),
  无流量 '—' 非 0%,**合计行从合计数算**(57.7%)绝不各行平均(37.5% 是错的);真浏览器 round-trip 验收。
  **M5 维护低价模型**(`b5d4d96`):6h 记忆蒸馏是后台摘要活不需对话档模型,侦察发现 override 管道早已在
  (`butlerSummarizer(provider,{model})`→`req.model`)只缺配置面——core additive `ManagedAgentSpec.maintenanceModel`
  (Hub 不解释,同 provider 同 key 同计费只换模型名,数据边界不动,未设=字节不变)+ **per-tick 解析**缝
  `resolveModel`(每 tick 调 `pool.butlerMaintenanceModel()`,面板改完下 tick 生效;resolver 抛错降级无 override
  绝不失败 tick)+ 配置面走 MR-M2 三缝先例(manifest 共享校验器 round-trip/agents-routes/admin 表单
  capture-echo 防 PUT 整体替换静默丢);sweep e2e 3 例+web 9 例。**M6 /me 流式侦察**(只侦察不实现,岔口
  摆给用户):流式管道其实已铺九成——`onStreamChunk` 三装配点全 append transcript,`hub.onEvent===
  transcript.onAppend` 故 admin `/api/stream` SSE 今天就在广播每个 chunk(admin 面板已消费实时打字),成员侧
  工作流编辑/新建/讲解三路由已流式(WFEDIT-D4 NDJSON `stream:true`+`__streamSinkKey` 一次性私钥,成员安全按
  构造成立);没流式的两张成员脸=①steward 管家框(host 缝已备从未被 web 用,差路由分支+SPA ~80 行,半天,
  **推荐先做**)②quick-chat/阿同(pool 无 sink 分流+路由从 web 直接 hub.dispatch 是孤例,~1 天);诚实性要点
  =管家带工具 `runToolLoop` 只返回最后一轮文本,「拼接 chunk=最终回复」契约只对无工具单轮成立,管家流式必须
  预览+result 终行整体替换;IM 桥结构性不能流式收益 web-only;成员级 SSE(按 userId 过滤 firehose)**显式不
  推荐**(过滤正确性=新安全面,per-request NDJSON 正是为避开它选的形状)。用户拍板**先 A 后 B**,两段落地:
  **M6a steward 管家框流式**(`63aae42`,web-only):`/api/me/steward/plan` 加 `stream:true` NDJSON 分支逐字
  镜像 WFEDIT-D4 形状(`application/x-ndjson`+`no-store`+`x-accel-buffering:no`,chunk 行+result 终行,头已
  出 200 后的失败**骑 result 行**绝不半截挂断;无 stream 纯 JSON 原路不动),host 零改动(chunkSinks 缝早备),
  SPA `readNdjsonStream`+`.me-steward-typing` 打字预览(管家带工具故预览用 `extractPartialReply` 增量提取),
  result 到达整体替换为终版提案。**M6b quick-chat/阿同流式**(`eb246a8`):pool 加 per-call `chatChunkSinks`
  (steward 同款纪律推广到 pool 作用域——register 发一次性随机 key 骑 `payload.__streamSinkKey`,spawn 时
  `onStreamChunk` 只把 text 类 chunk 喂对应 sink;sink 抛错绝不断回复/未知 key no-op/transcript 原样=sink
  是额外 tap,admin SSE 打字照旧);web `handleMeChatAgent` 加 stream 分支,鸭子 `MeChatStreamSurface`(只
  register/release 两方法)——**刻意比侦察预估更浅的缝**:dispatch 仍在 me-routes(Promise.race 超时不动),
  孤例保留不迁,无 surface ⇒ `stream:true` 静默回落纯 JSON 双向兼容;main.ts 接线 2 行压 2 行注释净零;SPA
  读流器通用化复用。验收:llm-anthropic 55/llm-openai 73/llm 232/personal-butler 70/host **2029**(chunk-sink
  4 例:keyed 分流/无 key 零喂/sink 抛错回复完好/两并发 key 不串)/web **1365**(M6a、M6b 各 4 例路由测试)/
  core 395 全绿,两段各真浏览器 round-trip(mock:MutationObserver 抓预览先现 result 后替换/NDJSON 头形/
  console 零错误),四门 PASS(旋钮 109 全程零新增——maintenanceModel 是 spec 字段非 env 旋钮;main.ts
  3000/3000 压注释净零×2)。显式推迟:工具面瘦身先度量后动/每轮 token 构成面板/1h 长 TTL/hub-steward·
  workflow-assist 独立 new provider 的包装接线(M1 缓存在 provider 内部它们天然已享受)。见
  [`docs/zh/NA-NATIVE-ADAPTATION.md`](docs/zh/NA-NATIVE-ADAPTATION.md)。
- **跨 hub 测试机制 track（XHT+XHT-2）+ 联邦握手/重拨两 bug 修（FED）全落（2026-07-10，本 commit）** — 用户令
  「建立跨 hub 测试机制，要能完整测试的？」拍板 **B 完整版**，随后追加「要具备检测各种通用状态的跨 hub
  工作流的能力，尽量包括不同 vps 之间/同 vps 之间/vps 与本地电脑之间」：真·两进程 L3/L4 门
  `scripts/test-cross-hub-e2e.mjs`（`pnpm check:cross-hub`，镜像 `check:first-result` 形状挂进 pnpm）——不是
  同进程双 Hub（那是**已有 12 个 `*-ws-e2e` 的 L2**，共享内存证不了真部署形态），而是驱动两个真生产二进制
  `host/dist/main.js`、各自独立 `GOTONG_SPACE`/加密 vault/占两端口，**五幕**硬断言：**A** 握手+派活+回传
  （能力解析到对端 wrapper→跨 socket 落到对端 agent→结果真回传，`executedBy=orgB`）/ **D** 多组织隔离
  （未在 `outboundCaps` 授权的能力跨 hub 派活被拒，一条边授权不外溢）/ **E 跨 hub 工作流状态机**（真 YAML
  流的步落对端：顺跑 `run=done`+步 output 真来自对端+`executedBy=对端 id`；未授权能力步 `run=failed`=工作流
  层隔离）/ **C** 重启自动重拨（重启**可控侧**：重启 B 证 A 退避重拨自愈，只有 A 可控时重启 A 证「本地电脑
  重启从磁盘恢复 peer 行开机重拨」，两侧都不可控显式 SKIP 绝不静默；attach 侧支持 `XHUB_X_STOP/START/
  RESTART_CMD` 命令钩子=真 vps 上接 `ssh systemctl`）/ **B** 出站审批闸（PATCH 边走**面板同款 `refreshPolicy`
  热重装不重启进程**：裸派活 park 到 owner 收件箱批准前零字节出门；工作流 run 停 `running`+步
  `status='suspended'`，批准后 `run=done`；再跑一发拒绝 `run=failed`+步错 `outbound_approval_denied`）——
  工作流「通用状态」全谱 done/failed(无参与者)/挂起/批准续跑/拒绝/宕机自愈全有硬断言。**三拓扑同一份脚本**
  （每侧独立 attach-or-spawn，`XHUB_X_URL` 设了就贴已在跑的 hub，hubId 走 `GET /api/federation/self`）：
  本机双 spawn=L3 回归门/同 vps 两 hub；双 attach=**不同 vps 之间**（零 spawn 纯 HTTP 驱动，结束 best-effort
  删测试行+还原开关，复用已有边要求已授权测试 cap 且不动 token）；只设 B=**本地电脑×vps**（A 拨出，NAT 后
  零入站端口也通）。`XHUB_PROVISION=1`=夹具模式（起两台驻留 host 打印整套 attach 变量，本机彩排 attach 拓扑
  /L4 演练用）。零真实 LLM（对端 worker `provider:'mock'` 回确定 `[mock reply to:…]`）。**四跑验证矩阵全绿**：
  ①本机双 spawn（幕 C 重启 B）②attach×attach 无钩子（幕 C 显式 SKIP）③hybrid A-spawn×B-attach（幕 C 重启 A
  =laptop 重启故事，同时从入站方向复证 FED-4）④attach×attach+STOP/START 钩子（幕 C cmds 分支），全部 exit 0。**这道门写的过程一次性揪出两个 L2 结构性
  照不到的真生产 bug，均已修 + 各配防回归**（岔口=用户拍板「立即修:补 peek 分流」）：**FED-1/2/3 共享端口握手
  互杀**——生产 `main.ts` 让 agent 协议与联邦 mesh 共用一个 `GOTONG_WS_PORT`，`serveWebSocket` 的 `ws.wss`
  同时交给 `PeerRegistry`，两个 `'connection'` 监听器都**无 peek** 地抢每个 socket；agent `Session` 先注册，把对端
  首帧 `MESH_HELLO` 当非法帧 `terminate()` 掐死握手（`peer-registry.ts:53` 那句 peek 分流注释**从没实现过**），
  **真单端口联邦从来没握手成功过**。修法=`serveWebSocket` 首帧 peek 分流（`MESH_HELLO`→mesh acceptor / 否则→
  agent Session，replay 首帧走 `ws.emit('message')`），新 `routeMeshTo(acceptor)` **opt-in** 注册（未接 mesh
  acceptor 走 byte-identical 快路径，agent-only host/测试零改动），`PeerRegistry` 加 `acceptInbound`、`main.ts`
  从 `wss: ws.wss` 改走 `acceptInbound: ws.routeMeshTo`；防回归=`transport-ws/tests/shared-port-demux.test.ts`
  5 例（双协议同端口任意顺序）。**FED-4 重启重拨 participant 泄漏**——`PeerRegistry` 出/入站两个 link `'closed'`
  handler 都只 `installed.delete()` 没调 `install.uninstall()`（唯 `teardown` 做对），peer 死后 wrapper participant
  （稳定 peer hubId）在 hub registry 泄漏；下次重拨 `installPeerLink`→`hub.register()` 抛「already registered」，
  派活路由到死 wrapper→`link_closed`，**联邦无法从 peer 重启恢复**（正是幕 C 该抓的）。修法=抽 `onLinkClosed`
  私有助手（`cur.link===link` 守卫防误踢新重连 + `uninstall()` 解注册），两个 close handler 都走它永不再各自漂移。
  验收：transport-ws 153 / host 2022 全绿，四门 PASS（旋钮 **109 零新增**——`routeMeshTo` 是能力不是旋钮；
  main.ts **3000/3000** 顶格，D1/D2 注释压 4 行净零补回 FED-2 接线），**L3 四幕全绿 exit 0**。docs：
  [`FEDERATION-RUNBOOK.md §5.1`](docs/zh/FEDERATION-RUNBOOK.md) 测试金字塔 L1→L4 + 两 bug 逐条；
  NET-AGENT-NETWORK 验收纪律加 L3 门指针。
- **web 界面 track（UI）A 动线修复全落 + /me IM 绑定卡（2026-07-10，本 commit）** — WX-M3b 真机测试撞出
  两级断裂后用户令「全面检查 web 界面是否过时需重构」：全面审计结论=**骨架健康**（角色门控正确
  [member/viewer 不加载 14 个 admin bundle]/i18n 1642 键双语对齐/PWA network-first/admin-src 已模块化），
  病灶在**动线**不在架构；三档方案 A 动线修/B 家庭档首屏/C 重写，用户拍板 **A+B（C 不做）**，本 commit=A。
  四件套：**A1** 根路径永远 `serveAppHtml`（登录态得角色壳/匿名得登录表单/首跑向导走 `x-gotong-bootstrap`
  hint——**向导写入仍 loopback 门控在 setup-routes 不放宽**），v3 工人页迁 **`/room`**；**A2** 匿名 `/admin`
  → 302 `/`（删硬编码英文 401 死循环页——旧动线:匿名 /→零登录入口工人页→「→ 管理员」→401 又指回 /；
  `?token=` 一次性链接流原样保留含 409 fixation 防御）；**A3** 工人页按钮改「→ 登录」指 `/`；**A4**「我的」
  重排 whoami→**管家**→**待处理任务**→绑定 IM，十张工具卡收进 `<details class="me-advanced">` 折叠（DOM
  仍在,app.js getElementById 零改动照常加载;手机档首屏从 5 张工具卡变成管家对话框）。**IM 绑定卡**（后端
  `/api/me/im*` 三路由 GO-LIVE §六早成文但 UI 从未长出=真机测试暴露的缺口）：生成 6 位码/列绑定/解绑,
  hint 走 `data-i18n-html`（纯 data-i18n 会把 `<code>` 按 textContent 露标签——真浏览器截图抓出后改）。
  验收：server.ts 2381→**2362**（预算门内省 19 行）,c1-app-shell/setup-wizard 测试改写断 hint 三态 + /room,
  web 1348 全绿,四门 PASS;**真浏览器 round-trip**（launch.json `ui-a-verify` 全新空间）：/→向导→设密→
  登录表单→登录→主页新序→真出码→折叠开合→手机档,console 零错误。**B（#48）待做**：member 对话式首屏/
  CSS 设计 token（styles.css 3647 行零 CSS 变量）/admin 17 标签分组/移动审批直达。
- **家庭 hub 垂直 track（FAM）M0 杀手场景钉死（2026-07-09，本 commit）** — 战略盘点「先 A 后 B」的 B 段
  （产品先行主轴）开工：OpenClaw #8081 用户原话「给家人不同权限/凭证互不可见/对外动作有人批」翻成一页
  非技术家长首屏叙事 [`docs/zh/FAMILY-HUB.md`](docs/zh/FAMILY-HUB.md)——三痛点逐条对到**已做实**机制
  （Role 四级 `owner|admin|member|viewer`+`requireAdmin` 服务端门 / vault 信封加密+`${NAME}` 占位防腐
  测试钉死 / governed park→收件箱→批准续跑重启幸存），写前逐一 grep 核实不撒谎。**「开箱 15 分钟」验收
  标准**对照 FUN TTFR 门形状（spawn 确切命令/剥作弊路径/逐条语义断言/限预算）定家庭版：分段预算 5/5/5
  + 三个 DISTINCT 可见时刻（A 权限分离=孩子 /me 无管理入口 / B 凭证不可见=孩子端无 key 明文 / C 对外
  有人批=卡先出现批后才执行）+ 试点家庭 A1–A8 checklist（A6 含重启幸存、A7 全程零代码零手改配置）。
  **诚实差距表**：0→10 分钟段已可跑（compose+向导+成员+/me 均既有承重墙）；10→15 分钟「配出带 governed
  工具的管家」今天手动建 agent 超预算=**FAM-M1 家庭 bundle 的确切工作清单**；真人实测=M2（需 1–3 试点
  家庭）。纯 docs 零代码零旋钮；挂链 docs/zh/README.md ① 区 + 本文档地图。M0 交付=尺子本身，M1 照尺子做。
  **M1 家庭模板 bundle 同日落地**：`examples/family-hub/template/family-hub.template.yaml`（gotong.template/v1）
  把 10→15 分钟段压成画廊一键装——2 托管 agent（家庭帮手 prepare/carry_out 双步一人担 + 家庭晨报员诚实模式）
  + 2 工作流（`family-approval-demo`：/me 发起→AI 整理一页申请→**`human:` 步 assignee 骑 `$trigger.payload.
  approver_id`**=发起人指定哪位家长批、`user_scope_field: requester_id` 由 /me 闸钉死发起人;`family-brief`
  家庭晨报）+ requires.connectors 3 生活槽位（calendar/notes/tasks **全 optional**=诚实模式即合格线）+
  acceptance **只放无人值守的晨报流**（带 human 步的流按设计停在审批步,它的验收就是 M0 checklist A5/A6 人工
  时刻 C——机器替不了「家长真批一次」）+ schedules 每早 7 点只带节奏不带人 + apiKeyPrompt 一次填。CURATED
  画廊 12→13（build:templates 重生成）;会红的门=既有 builtin-templates it.each 自动盖新模板 + 新
  `family-hub-template.test.ts` 6 例镜像 cafe-ops 先例（真 parseTemplate/真 parseWorkflow 逐块[human sugar
  desugar 到 gotong.human/v1 + `$carry-out.output` 连字符步 id 引用]/真 POST import 端到端 2 agent+2 流落地
  /零密钥断言）。**诚实边界**：演示流批准后产出=方案+家庭记录**不真对外**（模板零出站凭证,接入≠授权行动）,
  真对外动作走管家 governed 闸逐次过审。web 1346 全绿,四门 PASS（旋钮 109 零新增,main.ts 3000/3000 零触碰）。
  **M3 信任基建同轮落地（M2 需用户找试点家庭,故先落 M3）**——判据 4/7 补课四件套,纯 docs 零代码：
  ①[`docs/zh/THREAT-MODEL.md`](docs/zh/THREAT-MODEL.md) 威胁模型页,**部署者/家庭视角**与 SECURITY.md
  报告者视角互补不重写（资产清单/信任边界矩阵[admin 是锚点框架不防 admin·连接器 dataLeavesBox 披露·IM 桥
  平台方可见共性]/防住什么逐条对机制/「防不住什么」诚实节[物理访问·恶意 admin·LLM 厂商侧·**供应链无
  provenance 无第三方审计如实自曝**]/家庭必做三件/备份恢复演练带真命令[backup 默认主钥不进档案·
  --include-master-key=档案即凭证·restore 先验 sha256 清单后落盘·「没演练过的备份等于没有备份」]）;
  ②GOVERNANCE **双语**新「License permanence/许可恒定」节:MIT 永不改证显式承诺（no BSL/SSPL/CLA 伏笔,
  Redis→Valkey 教训,「恒定的规则比慷慨的规则更重要」）,修订规则升级为与 The one non-negotiable **同级
  steward sign-off**,README License 行加指针;③PUBLISH-RUNBOOK §六 npm provenance 调研结论（**先查市面**:
  官方要求云 CI 构建,本机手动发布**结构性拿不到**;启用三步=开 Actions+trusted publishing[provenance 自动
  生成免旗标]+36 包 workflow;显式推迟成 PUB 待办,现阶段介意者从源码构建）;④挂链 docs/zh/README ④ 区 +
  FAMILY-HUB 深水区指针。**M4 传播面 docs 部分同轮落地**：README by-role 表加家庭行（👨‍👩‍👧 一句话卖点=全家一个
  管家/角色分权/金库不可读/家长批 + 15 分钟 checklist + 威胁模型指针）+ README License 行加「permanently:
  commit to never relicensing」指针;`docs/OVERVIEW.md`（英文权威源）Getting-started 表加家庭行 + License 节
  尾加恒定句,`docs/zh/OVERVIEW.md` 镜像同步两处（家庭行 + 「而且它会一直是 MIT」指 GOVERNANCE#许可恒定）。
  **M4 对外运营两件（GitHub Discussions「部署展示」板 + 自愿登记式部署计数）= 对外动作不擅自做,列给用户拍板**。
  下一步 M2 部署摩擦清零（需用户找 1–3 试点家庭）。
- **微信 iLink 桥 track（WX）M0→M2 全落，M3a 登录流真机已证（2026-07-09，`22e9cac`→本 commit）** — 战略盘点
  「先 A 后 B」的 A 段落地：第 7 座 IM 桥 `packages/im-wechat` 走**腾讯官方 iLink 协议**（2026-03 首条合法
  个人微信通道，HTTP/JSON + Bearer + 35s 长轮询,形状同构 Telegram），华人成员在微信里直接跟管家「阿同」说话。
  **M0**（`22e9cac`）侦察 + 计划 [`docs/zh/WECHAT-ILINK-BRIDGE.md`](docs/zh/WECHAT-ILINK-BRIDGE.md)：后台侦察
  agent 卡死被用户手动终止后，从其 transcript 抢救全部 45 次抓取自行综合成文（教训=长跑 agent 的最终消息
  不可依赖,原始 transcript 可抢救）；实现前 `gh api` 逐字拉官方插件 5 源文件核 wire 真相,纠社区讹传 3 处
  （get_bot_qrcode 是 **POST** 非 GET / `-14` 在 **`errcode`** 字段非 `ret` / `iLink-App-Id: "bot"` 是官方
  package.json 公开常量非私密凭证）;海外可用性从未知降级为「2026-06 起国际灰度中（HK 已证）,马来西亚 M3 实测」;
  **用户拍板止损线**：桥若开发失败（M3 不通/灰度不放开/协议面变卦）**放弃路径退飞书**,沉没成本 ≤3 天,包留作
  休眠等灰度。**五边界**：①只走官方 iLink 绝不灰产协议 ②opt-in 未配=字节不变 ③接入≠授权行动（governed 闸不动）
  ④内核零改动（新叶子包+host im-bridge.ts 缝）⑤被动回复诚实（推不出去=诚实抛错走 outbox 补投,绝不静默）。
  **M1**（`26e15b7`+`2ed938d`）协议纯核：`types.ts` 官方逐字字段 + `client.ts`（QR 登录/长轮询/发消息/notify,
  强制查 `ret`=官方 #197 静默失败之反面,`X-WECHAT-UIN` 随机防重放头,外部 abort 折叠空页）+ `message.ts`
  （`message_type:2` 回显过滤承重、GENERATING 帧丢弃、语音走服务端转写、媒体=诚实无字节 stub）,21 fixture 单测
  零真实凭证。**M2a**（`6820885`）`bridge.ts` 镜像 TelegramBridge 循环 + 四个 iLink 差异：字符串游标
  `get_updates_buf`;**per-peer `context_token` 台账**（回复必须原样回带的会话窗口证,容量逐出**无本地 TTL**——
  token 新旧服务器裁决,发失败走 outbox 补投,比计划的 TTL 更诚实）;被动回复无台账=诚实抛错;`errcode=-14`
  **60min 冷却**（镜像官方 session-guard,报一次自愈恢复）;stop() abort 在飞长轮询不等 35s;10 单测含注入时钟
  冷却往返。**M2b**（`1b5aab0`）host 装配：`ImVaultPlatform` 扩三元 `wechat`（env 先行 `GOTONG_WECHAT_BOT_TOKEN`
  +可选 `_BASE_URL`,vault 行 secret=token/`metadata.baseUrl` 非密随行绝不混源,hot-start 缝免费覆盖,web 向导
  白名单仍 telegram|lark 不外泄）+ factory 块 + A4 `PLATFORM_NAMES` 加微信;**旋钮 107→109**（本 track 仅有的
  两个,均登记）。**M2c** CLI `gotong wechat-login`：官方登录状态机全镜像（IDC redirect 换轮询主机/配对数字
  stdin 输错重问/刷码上限 3/binded_redirect 指路解绑）,stdout 只打 env 两行可 `>> host.env`、二维码+引导走
  stderr（mint-peer-token 纪律）,qrcode-terminal 渲染+链接兜底;**CLI 刻意无状态不写 vault**（无 master-key
  解析面,复制会漂移;vault 读取留给将来面板扫码卡）;15 单测 + 真 bin 冒烟。验收：im-wechat 31 / host 2022 /
  cli 269 全绿,四门 PASS（main.ts 3000/3000 零触碰——factory 在 im-bridge.ts 不占预算）。**M3 待做**（需用户
  微信号）：真机 round-trip + 马来西亚号可用性最终答案 + GO-LIVE runbook 节。同轮顺手落**管家命名「阿同
  (Atong)」**（`7529ba2`,词源 Go**tong**/共同/同伴）：纯品牌层零代码标识符改动,只在框架自声处用名
  （`BUTLER_BRIEF_SYSTEM` 晨报——框架唯一自写人设 prompt）,成员自配人设永远优先,文档荐默认 system prompt;
  README + PERSONAL-BUTLER-DESIGN 命名节。
- **模型路由 track（MR）全完：M0→M5（2026-07-09，`c4a3c63`→本 commit 共 9 commit）** — 用户拍板「管家参考
  hermas/openclaw 做多模型智能路由 + 模型调用降级 + API 健康监测」+ 两处架构岔口（AskUserQuestion 定）：①配置落点
  =**扩 `ManagedAgentSpec`**（core 加 additive 可选 `fallbacks` 字段）；②覆盖面=**全 managed agent, opt-in**（共享
  `providerFactory` 缝盖住全部,未配=字节不变）。开工前先查市面抓到**改路线的市场真相**：Hermes 的「智能路由」
  (Pareto Router 按任务类型分 8 槽)本质要先**用 LLM 判断这条消息是什么**才能选模型 —— 那是热路径 LLM,**被边界①
  禁**;故 Gotong 版做**确定性路由**(有序候选链 + 熔断,「智能」在候选**排序**不在现场用大模型选路)。**四条不可破
  边界**:①热路径零 LLM(选路 / 开断路器全靠 `classifyLlmError` + 计时器 + 候选顺序);②opt-in 字节不变(未配
  fallbacks=今天单 provider 逐字节一致,根本不包 RoutingProvider);③数据离盒 opt-in(降级到另一 provider=发另一
  厂商,候选链成员亲手编排故按构造 opt-in);④内核零行为改动(RoutingProvider 在 `packages/llm` 平级包,`fallbacks`
  是 core additive 字段 **Hub 不解释**,熔断阈值走常量)。**M1**(`b5d85de`)`RoutingProvider implements LlmProvider`
  纯核:有序候选 + **首-chunk-前 failover**(硬失败在吐第一个 chunk 前抛=可安全换下一候选;一旦产出 chunk 就锁定
  该候选,mid-stream 错误原样透传不重试——已吐 token 收不回)+ **per-candidate 三态熔断**(Closed 窗口内失败达阈值
  3→Open 快速跳过 cooldown 30s 内调用→Half-Open 放一个探针成功即关/失败重开,阈值/窗口/cooldown 全常量可注入)+
  复用 `classifyLlmError`;零依赖、可注入 `now`/`onEvent`,16 单测。**M2**(`52a66c5`)配置面 + 装配缝:core 加
  `FallbackCandidate` + `ManagedAgentSpec.fallbacks`;pool `buildRoutedProvider` 在 `spec.fallbacks?.length` 时把
  主+各候选包成 RoutingProvider 否则返回单 provider(**一个咽喉点覆盖管家 + 全 managed agent + 三类后台 sweep +
  工作流 step**);per-candidate `model?` 覆盖(不同 vendor 认不同模型名,主候选不带覆盖以保 per-task override);
  web `manifest`+`agents-routes` 校验 `MAX_FALLBACKS=5`;admin 结构化表单 capture-on-load/echo-on-save 防 PUT 整体
  替换悄悄丢 fallbacks(镜像 useMcpServers 先例,创作路径=manifest 导入导出);13 单测。**M3**(`9e37634`)per-provider
  健康监测:新 `RoutingHealthTracker`(host 层,`onEvent` 折叠成每 agent 每候选健康;**刻意 in-memory**——寿命对齐
  RoutingProvider 那份同样 in-memory、重启即重建的熔断器,持久化会比它描述的东西活得久=说谎,与 CARE `llm-outage.json`
  持久化正相反因为断供真能扛过重启)+ `breaker_close 即恢复`(close 只从 recordSuccess 即探针成功发出,故 tracker 当
  完全恢复清错误态)；`HealthSnapshot.routing` 是**list**(absent=未接线/[]=健康/rows=降级,同 connectorSlots 三态,
  非 llmOutage 的单行三态)+ 面板**黄条**渲染(agent 靠备用仍工作,超越 CARE-M7 二元红色「大脑挂了」);走
  `@gotong/host/routing-health` 子路径导出(避 main.js 副作用);37 单测,main.ts 压注释净零守 3000。**M4**(`7a4eecd`)
  capstone `examples/model-routing`:确定性四幕(failover 续跑→连续失败熔断快速跳过→健康投影=面板 `snap.routing`
  确切数据→主自愈探针弹回)用真 RoutingProvider + 真 RoutingHealthTracker(只 stub 两 provider,共享注入时钟),
  12 自断言 + `pnpm demo:model-routing` exit 0。**M5 手动测试路由**(用户实测「怎么测 api 是否健康」后拍板
  「手动测试连接:面板一个按钮,逐候选各发一个 `2+2` 式最小提问报 ok/病」——AskUserQuestion 定,选**手动**非后台
  自主):补上 M1→M3 **被动健康**(只从真实流量折叠,没走到过的备用=未知)之外的**主动逐候选探针**。关键洞=CARE 的
  免费 `GET /models` 证不了「能生成」(限流/配额耗尽/模型名错在列表端点看不出),M5 探针走**真 spawn 链**
  (`resolveApiKey→providerFactory→provider.stream()`,与真跑同路)故「过=真能顶」;代价是花钱/占配额/「框架不主动跑
  LLM」立场→**必须 opt-in 手动**,稳钉边界①手动侧。判定=**「能不能生成」非「答得对不对」**(`ping`/`maxTokens:1` 只图
  最短,弱模型乱答只要非空产出=健康)。**M5a**(`cb43413`)共享探针核:抽 `probeProvider`(探 already-constructed
  provider)出 `llm-key-test.ts`、`testLlmKey` delegate(逐字节等价,既有测试守重构);pool `probeRoutingCandidates`
  逐候选走真 spawn 链(mock 短路 ok 不调 factory、**刻意不喂熔断器**——手动测试不拨线上路由态);判类复用
  `classifyKeyError`(与「测试连接」按钮同套错误码)。**M5b**(`8019254`)web `POST /api/admin/agents/:id/probe-routing`
  (**admin 门控** + viewer-scoped 镜像 `:id/export`):鸭子 `RoutingProbeSurface` 注入(镜像 `llmKeyProbe`,web 零
  host dep);无 surface→503、未知→404、外接→400、否则 200 `{agentId,candidates}`;`main.ts` 接 `routingProbe:
  localAgents`(+2 注释净零)。**M5c**(`e0aaa0f`)面板「测试路由」按钮(**仅配了 fallbacks 的行显示**——无路由无可测,
  镜像服务端 400/503 姿态)+ 逐候选内联渲染复用 `describeKeyTest`(路由面板与 key-test 按钮永不各说各话)+
  Primary/Fallback N 标签 + `N of M candidates OK` 汇总(zh+en);已存 agent 的 key 在金库浏览器拿不到,故逐候选探针
  用 **host 侧 `resolveApiKey`**——正是它能测**已保存 agent 备用链**的原因(绕开「测试连接」按钮必须手打 key 的限制)。
  验收:llm 16 / host routing 40 / web 1338 全绿 + **真浏览器(mock host 零 key)round-trip**:2 mock 备用→3/3 绿、
  无 fallback 无按钮、死端点备用→1/2 红,控制台零错误;四门 PASS(旋钮**仍 107 零新增**——surface 在不在**就是**开关,
  main.ts 3000/3000)。显式推迟:软失败内容校验 / 语义缓存层 / hub-steward·workflow-assist 各自 new provider 单独接线 /
  **后台自主**逐候选探活(边界①手动侧刻意不做,要自动化按需再议)。见 [`docs/zh/MODEL-ROUTING.md`](docs/zh/MODEL-ROUTING.md)。
- **管家使用感受增强 track（UX）全完：时钟 + A1→A4 + B1 + B2（2026-07-08，`21ae15f`→`04776b0` 共 7 commit）** —
  用户实测「管家不知道现在几点」后问「如何让它能自动确定这些」+「还有没有类似的能增强使用感受的功能可扩展」+
  拍板「A+B,一个一个完成」。缺口=管家每轮开口时对「当下」几乎全盲(几点/多久没聊/用哪种语言/从哪个渠道来/
  自己能帮啥/早报能否带真实天气日程)。**四条不可破边界全程守住**:①热路径零 LLM(A 系列全是纯拼字符串尾卡,
  B1 纯目录渲染,B2 复用早报本就唯一的模型调用且只读不写硬上限 3 轮);②冻结块字节不变(变量内容只走
  `composeContextProbes` 尾缝,不注入=返回 null=prompt 逐字节一致);③数据离盒 opt-in(B2 默认关);④内核零改动
  (全在 host/personal-butler 层,旋钮**仍 107**,main.ts 顶格 3000/3000,每次增行靠压注释净零)。**时钟**
  (`21ae15f` `packages/personal-butler/butler-clock.ts`):每轮注入当前时间卡(Intl `longOffset`+UTC 锚点,
  永远非空——知道「现在」是助手底线),时区跟部署 `TZ`(生产机 Asia/Shanghai=马来西亚正确,故不加 TZ 旋钮)。
  **A1 待办提醒**(`ba5aecb`):读 /me 收件箱**还等本人确认**的 park 项注入「N 件事等你批」,只读投影空则 null,
  最多列 3。**A2 时段问候+间隔**(`ee1c4ef` `presence/last-seen.json`):首次接触=无卡(归 onboarding)、活跃
  <3h 不重复招呼、≥3h 才注入时段+间隔+招呼提示。**A3 语言偏好**(`cdf4c09` `set_reply_language`+
  `prefs/reply-language.json`):设了才注入「用<语言>回复」,空=跟输入语言走,三语用户不再每轮猜。**A4 来源渠道**
  (`889b09e`):从 `task.from`=`im:<平台>` 解析平台(第一个真读 task 的探针)注入「聊天窗别甩 Markdown 墙」——
  六桥全纯文本送达是硬事实;web /me 无 im: 任务=无卡=完整格式照旧。**B1 能力发现**(`dde3355`
  `list_my_capabilities`):清单**从真实已装工具派生**(工厂懒喂最终 benign+governed 工具名),漏报是安全失败、
  虚报不可能,MCP 连接器按 `<server>__<tool>` 前缀点名,governed 标「需你确认」。**B2 晨报增强**(`04776b0`):
  给 `composeBrief` 加 `enrichWithConnectors` 开关(**默认关**——用户拍板「早报每天自动外呼比按需查更强的授权,
  单设一道开关」),开了跑有界只读 tool-loop 调管家 benign 读连接器把真实天气/日程融进问候;WRITE 半是会 park
  的 governed 闸绝不交给无人 sweep(能看不能动),连接器挂/解析不到/开关关全退回历史单次路径逐字节一致;pool 缝
  `butlerMcpReadToolset()` 镜像 `buildButlerProvider`。验收:personal-butler 全绿 + host 1993 全绿,四门 PASS。
  见 [`docs/zh/BUTLER-UX-ENHANCEMENTS.md`](docs/zh/BUTLER-UX-ENHANCEMENTS.md)。
- **记忆升级 track（MU）全完：M0→M5 + capstone（2026-07-08，`1955bc3`→本 commit 共 7 commit）** — 用户问
  「如何把管家记忆追上前沿」,答案=**骨架已赌对**(file-first + 双时态 + 睡眠期整理 = 前沿 Letta MemFS /
  OpenClaw / Zep 正朝这收敛),差距只在**检索质量**(多信号/图谱)与**可测性**(零 benchmark)。用户拍板
  「列个计划把这五项都纳入升级」+ 岔口「A=(a) 轻量;B、C 用推荐」。**四条不可破边界**:①框架仍不跑 LLM
  (所有模型调用只在 **6h 后台维护**,每轮热路径零 LLM);②字节不变 binds 冻结块 + 有门槛项(真 embedder/
  外部 provider opt-in;**零门槛本地重排作管家默认发**);③数据边界(外部 provider 离盒必须 opt-in + 凭证
  vault + 面板披露);④管家层优先,**内核 core/workflow/protocol 零改动**。**M1**(`3ba3f5a`)立尺:
  `packages/personal-memory` 召回 benchmark 纯 harness(`scoreRetriever` recall@k/MRR,14 例双语 fixture,
  `semantic` 类 recall 恒 0 是**设计出来的**诚实天花板)+ `pnpm check:memory-recall` 承重门,准确率棘轮
  地板只升(镜像 line-budget 反号)。**M2**(`5fac3d2`)融合召回:`fusedRetriever`(keyword coverage ⊕ 本地
  TF cosine,relative-score 融合非 RRF)+ 零依赖 `localBigramEmbedder`,**作管家默认发零新旋钮**(用户法则
  「有门槛才可选」+ MR1 先例);MRR 0.548→0.738(cross-session 0.333→1.0 聚焦金标提到第 1),recall 不变、
  semantic 仍 0(本地天花板,embedder 注入缝=M4 opt-in 入口)。**M3**(`2ba4508`)原子事实抽取:6h 维护里
  `composeReviewers(tieredReviewer, atomicFactsReviewer)` 并列一个 Mem0 式单遍抽取,写**自包含事实**
  (「用户最爱的饮料是珍珠奶茶」含类别词+具体值)→ semantic 类 recall 0→100%(**改库不改检索器**);
  relevanceScore 去重(跨 pass + pass 内)、`meta.atomicFact` 出处标记、6h 背景每轮零 LLM。**M4**(`0849cf8`)
  外部 provider:先查市面抓到市场真相(Mem0 官方 MCP 已迁**托管远程 HTTP + Bearer**、静态 stdio 随
  OpenMemory 退场,同 C-M2 同源)→ 走**连接器目录路径**(边界③「全走 MCP 不存数据」最具体约束,只有它干净
  满足)接 `mem0-memory`(http 托管 `Bearer ${MEM0_API_KEY}`)+ 新 **`dataLeavesBox` 披露原语**(面板对 flag
  无条件印「数据离开本机」,顺手补标 notion/todoist 云 SaaS);opt-in 未装字节不变、`MEM0_API_KEY` 是连接器
  凭证非旋钮**仍 106**;真 embedder 走 embed 缝 + 外部当主 backend 显式推迟。**M5**(`9a6df14`)记忆树 git
  快照(用户拍板 **A=a 轻量**):`butler-memory-git.ts` 新叶子 `snapshotMemoryTree` per-user `.git`、status
  无变化即 no-op(非每写即 commit)、best-effort **never-throws**(缺 git/init 失败 → `'skipped'`)、commit 带
  `-c commit.gpgsign=false`(后台 commit 绝不触发 gpg 卡 passphrase);6h 维护里 `gitSnapshot` opt-in
  **`GOTONG_BUTLER_MEMORY_GIT`(106→107,MU 唯一新旋钮**——它在盘上造 `.git` 有门槛,正落边界②),未开逐
  字节不变;可注入 GitRunner+now(测试无需真 git);main.ts +6 行 line-budget 2990→2996。**capstone**
  `examples/memory-upgrade`:真 MU 代码零重写,两幕各隔离一个里程碑用 M1 尺子量——Act 1 keyword vs fused
  MRR 0.583→1.0(改检索器)、Act 2 真 atomicFactsReviewer 抽取前后 answer-recall 0→100%(改库,检索器固定
  基线隔离 M3);末尾账本把 M4/M5 摆成 opt-in 侧面(故意不动召回数)。排错记:初版 Act 2 用 fusedRetriever,
  `饮料` 案掉出 top-5(所有诱饵含「饮料」coverage 全平,更长桥接事实 bigram TF 被稀释 cosine 反低)→ 修正=
  Act 2 检索器固定基线 keyword(MU-M3 承重门同手法),**每幕只改一个变量**;`pnpm demo:memory-upgrade`
  exit 0 零 key。验收:personal-memory 400 / host 1930 全绿,四门 PASS(旋钮 107,main.ts 2996/2996)。见
  [`docs/zh/MEMORY-UPGRADE.md`](docs/zh/MEMORY-UPGRADE.md)。
- **管家任务笔记本 track（TN）全完：M0→M3（2026-07-08，`0d1c507`→`74d513d` 共 7 commit）** — 用户问
  「管家怎么规划执行任务队列?hermas/openclaw 怎么做?写个任务笔记本会不会让弱模型也稳?」,答案
  =市场已收敛(Hermes 内建 todo 工具集且 <64K 上下文硬拒、OpenClaw 长出 tasks 台账/Inferred
  Commitments、Manus recitation 复述防漂移):**显式任务台账是长任务稳定性地板**;我们的差异化
  =推进分诊**零 LLM**(纯时间戳)+ 跨会话 file-first。用户拍板关键边界:**「放到管家智能体里,
  不是框架里」** —— 纯核全在 `packages/personal-butler`(host-free),装配只动 host
  `personal-butler-*` 家族,内核(core/workflow/protocol/identity)**零改动、零新 env 旋钮
  (仍 106)**。**M1**(`7169d13`)纯核+复述缝:`task-notebook.ts` file-first 每成员 `tasks.json`
  (坏文件隔离改名不炸轮、tmp+rename、nextId 落盘 id 永不复用、上限显式拒)+ 4 个 benign 工具
  (open/update/close/list_task_notes,与 set_reminder 同类不设开关,描述内嵌指路
  create_workflow/set_reminder 防拿笔记本硬凑工作流)+ `digest()` 复述卡经 `composeContextProbes`
  走 CARE-M4 既有 contextProbe 缝注 system prompt 尾(冻结块缓存前缀不动,**无任务 = null =
  prompt 字节不变**);factory 接线走 ownerDir 与 STATUS.md 同安全边界;21+1 单测。**M2**
  (`fb177ba`)卡壳零 LLM 提醒:纯分诊(open && 停 3d && 每任务冷却 3d 外)+ 只读快照(坏文件
  跳过**绝不隔离** —— 隔离权归管家轮唯一写者)+ 模板文案只问不做;host `ButlerTaskNudgeSweeper`
  镜像 proactive 形状 6h 常量节律,**只写自己的 fact 文件** `tasks-nudges.json`(intent/fact
  分文件双写者结构性不打架),投递走懒 pushToMember(CARE-M8 outbox),**送达才记标记**、单条信
  最多列 3 件超出显式说;armButlerSweeps 加可选门,main.ts 压 2 行注释**净零行**(预算 2990/2990
  顶格不动);7+7 单测。**M3**(`74d513d`)capstone `examples/butler-task-notebook`:故意失忆
  provider 驱动真 PersonalButlerAgent(每轮全新构造 + captureTurns:false + 结构性断言新轮首调用
  恒 1 条消息),仅靠注入摘要 5 步使命跨 6 独立轮完成;第 4 步对外发送照 park,批准前断言未发送
  未勾步(**笔记本≠授权**);`pnpm demo:butler-task-notebook` exit 0。排错记:digest 模板括号是
  ASCII `(`,初版正则 `((\d+)…)` 被当分组吞 → hexdump 定位显式 `\(` 修正 —— 对模板文本写解析器
  先 hexdump 核标点码位。验收:personal-butler 59 / host 1919 全绿,四门 PASS。见
  [`docs/zh/BUTLER-TASK-NOTEBOOK.md`](docs/zh/BUTLER-TASK-NOTEBOOK.md)。
- **接入现实生活 track（C）：C-M1 静态 token 首批 + C-M2 出站 OAuth 全完（2026-07-07/08，`6cd0a17`→`c71d7f0`）** — 用户在
  「还差多少」战略盘点里拍板走 **C（接入现实生活）**:不加框架功能,而是把触达日常工具的连接器面
  **做宽 + 做可信**,抬「深度辅助」天花板。开工前按「先查市面」核官方 MCP 注册站,抓到**改路线的
  市场真相**:现代生活连接器生态**已整体迁到「托管远程 HTTP + OAuth」**（Notion/Todoist/GitHub/
  Google 官方全是托管+OAuth）、静态 token stdio 在退场、日历按 `google calendar` 搜直接**空** ——
  故**日历/邮件/记账铁定是 OAuth 域**。好消息:出站 http/sse + `${TOKEN}` header 管道早通
  （`host/src/mcp-config.ts`）、OAuth2 原语（`oidc-client.exchangeCode` + `buildAuthorizationUrl`）
  也在（现只入站用），整个 track 只缺**出站令牌获取流**。**C-M1** 先把**厂商官方 + 静态 token**的
  少数干净选择接上:`packages/web/src/builtin-mcp-connectors.ts` 加 `notion-notes`（Notion 官方
  `@notionhq/notion-mcp-server`,`NOTION_TOKEN` 内部集成密钥,非 OAuth）+ `todoist-tasks`（Doist
  官方 `@doist/todoist-mcp`,`TODOIST_API_KEY` 个人 token,本地 stdio 走静态、托管才 OAuth）+ 新
  `tasks` 分类;两条都对**官方 GitHub README 逐字核过**命令/env（不硬编造),带凭证故显式
  `PATH: '${PATH}'`。**三条不可破边界**:①全走 MCP 框架不存数据（搬走 `.gotong/` 无连接器数据尾巴）
  ②凭证只 `${NAME}` 占位/vault,绝不明文（防腐测试钉死）③**接入≠授权行动**（挂上工具能读写,但替你
  发/花钱仍过 personal-butler 的 governed 审批闸 —— 发现≠信任在生活域的延伸）。零后端/路由/schema
  改:一键装走既有 `POST /api/admin/mcp-servers`、catalog 路由从常量派生、面板 `admin-src/mcp.js`
  通用循环渲染,新条目自动出卡;爆炸半径锁 web 常量 + 防腐测试 + 文档。验收:防腐测试
  `builtin-mcp-connectors.test.ts` 扩 15 例（两新 spec 各过真 `validateMcpServersArray` + 无明文
  密钥 + id/名唯一 + 分类合法）+ catalog 真 HTTP 路由测试 + web 全绿。**C-M2 出站 OAuth 是主菜**
  （解锁日历/邮件/记账 + 托管 Notion/Todoist),已按 opt-in 法则(用户拍板「有门槛的动作都设为可选」)
  分 5 子里程碑起手:**C-M2-M1**（`identity/oauth-outbound.ts` 出站 OAuth2 纯核:授权URL/交换/刷新
  体/响应解析,复用 PKCE·vault·`mcp-config` 可插拔 SecretSource,新建仅纯 OAuth2 变体 + refresh
  grant——`exchangeCode` 强制 id_token、`buildAuthorizationUrl` 强塞 openid 都不适用;19 单测,无人调=
  零行为变)+ **C-M2-M2**（`fae971d` 存储层:schema **v36** `oauth_connectors` 表[非密配置 + 两个 vault
  指针 + 非密 `access_token_expires_at` 列让 M4 不解密就能判过期]+ 两新 `VaultKind`[`oauth_client_secret`
  /`oauth_token`,令牌集作单个 JSON blob 进 vault 信封加密]+ `OAuthConnectorStore` 全复刻 OIDC 崩溃安全
  机密轮换[行改指后才撤旧]+ 出站独有 `setTokenSet`/`getTokenSet`/`clearTokenSet`;空 registry 逐字节不变,
  纯存储无路由读它;19 单测 + identity 654 全绿 + host tsc 零 ripple)+ **C-M2-M3**(连接流两单元:M3a
  `0e5b4e4` host 编排 `oauth-connect-service.ts` 镜像 OidcLoginService 反方向[begin mint state+PKCE 暂存·
  complete 单 POST 换码→setOAuthTokenSet,无 discovery/JWKS/id_token 故 fetch 直接注入];M3b `5648f2a` web
  路由[`POST /api/admin/oauth/start` **管理员门控**防令牌固定攻击 + `GET /api/oauth/callback` **公开靠单用
  state**,main.ts 走 factory +5 行、server.ts 棘轮显式 2350→2370];opt-in 未接 identity 逐字节不变;host
  1892/web 1289 全绿)+ **C-M2-M4**(令牌全链路打通,拆两单元:M4a `5e1ac79` 注入缝——新 `oauth-secret-source.ts`
  出站版 `${ENV}` 展开,固定保留 ref `${OAUTH_ACCESS_TOKEN}` 按 M2 `mcpServerName` **承重连接键**解析成「喂
  该 server 的连接器」活令牌[per-server 源故两 oauth server 不撞名·ref 名不带 `GOTONG_` 免误报 env 门·坏 blob
  fail-soft 不连累 spawn];pool 对 oauth **完全无感**注入 `mcpSecretSource?:(serverName)=>SecretSource`、
  `buildToolset`/`resolveRegistryConfig` 走 `secretSourceFor`、省缺=`envSecretSource` **代码级逐字节今天**;
  M4b `e6fcd33` 保活——`oauth-token-refresh.ts` `OAuthTokenRefresher` 后台计时器用 refresh_token grant 保活
  已存令牌[**读非密过期戳投影分诊不解密**·60s tick/到期前 5min 刷/start() 补 tick 恢复停机期过期令牌/
  逐连接器 fail-soft warn 一次/缺新 refresh 前推旧的];**冻结头边界**=刷新不更新运行中 toolset 活头[连接时
  焊进 requestInit.headers],会话活过令牌 mid-session 401 下次重生自愈,活连接热替 pool install/uninstall 或
  per-request 动态头**显式推迟**——「连一次永续+重生即新鲜」90% 已落;main.ts 2 行接线棘轮 2980→2986;
  8+1+10 单测 + host 1911 全绿)均已落。**M5 收尾四单元全落**:**M5a**（`b976dfb` admin OAuth 连接器 CRUD
  后端 `/api/admin/oauth/connectors[/:id[/disconnect]]` 镜像 oidc-admin,17 路由测试）+ **M5b**（`a29ebde`
  目录预设:Google 日历 + Gmail 端点/scope/托管 MCP 内置、admin 只填三件套 + `GET /catalog` 永不 503；
  先查市面抓到 **Notion 令牌端点要 HTTP Basic 而 M1 核只做 client_secret_post** → 诚实收窄只发对 M1 端到端
  可信的两条 Google 预设、Notion-OAuth 显式推迟;11 防腐测试）+ **M5c**（`4400d5d` admin 新「连接现实生活」
  标签页镜像 MCP 目录:目录卡 + 连接表单[回调预填] + 已装表 + 连接/断开打 M3b start；纯静态资产零逻辑改、
  真浏览器双语 + 连接→回跳→横幅 round-trip 验证)+ **M5d**（`c71d7f0` capstone `examples/reallife-oauth`:
  出站 OAuth 全链路一个确定性脚本[begin→换码进 vault→注入→到期刷→再注入],真 M1+M2 只 mock 网络,硬断言
  明文令牌不落盘 + per-server 隔离 + opt-in 透明 + 连一次永续;self-assert exit 0/1)。**C-M2 出站 OAuth 全完**
  —— 普通人面板里「用 Google 登录」把日历/邮件接给自己的 AI、令牌进 vault 自动保鲜、真发信/改日程仍过审批闸;
  **opt-in 全程零新 env 旋钮仍 106**。显式推迟:Notion-OAuth(待 M1 加 basic 认证)、活连接热替令牌(冻结头
  边界重生自愈)、更多 provider 预设(按需再加)。见 [`docs/zh/REAL-LIFE-CONNECTORS.md`](docs/zh/REAL-LIFE-CONNECTORS.md)。
- **STD 标准对齐 track：名片签名 M0→M2b-2 · STD-M2 全完（2026-07-07，`c6ceab4`→`ac9abc0` 共 7 commit）**
  — 用户战略问「如何继续往面向未来的简单易上手的多智能体多人协作网络基础框架方向推进」，拍板
  方向「面向未来·标准对齐」+ 姿态「opt-in 开关」。北极星第 3 层「适配=跟得上 AI 发展」的抓手：
  把 hub 对外表面逐一接**开放标准的可选强化项**。两条不可破边界（与 NET 同源）：**opt-in=默认
  字节不变**（unset 名片根本没有 signatures 字段，与今天逐字节一致——「能力」不是「行为分叉」）、
  **发现≠信任**（签名给完整性不给身份，身份锚定留 M2 PIN 公钥，永不因「卡有签名」自动建边）。
  **M0**（`c6ceab4`）计划 [`docs/zh/STD-STANDARDS-ALIGNMENT.md`](docs/zh/STD-STANDARDS-ALIGNMENT.md)
  + 实施前重核 A2A v1.0 §8.4 Signed Agent Cards 权威源（a2aproject/A2A `a2a.proto` field 13
  `signatures` + spec §8.4）。**M1**（`68a1c97`）生产侧签名+JWKS：opt-in `GOTONG_A2A_SIGN_CARD`
  （第 106 旋钮已登记）；`agent-card-signing.ts` **零外部依赖走 node:crypto**——jcsCanonicalize
  （RFC 8785，名片无数字故退化为递归 key 排序，非有限数当场抛绝不静默签错 payload）+
  FileAgentCardSigner（ES256，`.gotong/agent-card-signing.key` 0600 PKCS#8，kid=RFC 7638
  thumbprint 跨重启稳定，非 EC/坏钥当场拒——**MasterKeyProvider 同姿态 fail-closed 绝不静默换
  钥**）+ signAgentCard/attachSignature/buildJwks + **可复用 verifyAgentCardSignature**（M2 现
  成拿来用）；`createAgentCardSurface` 工厂从 main.ts 名片闭包抽出（顺手腾 7 行预算 2980→2973），
  signer 非空则 attach 签名+jku 指 jwks / null 则名片无 signatures 字段；web 新增
  `GET /.well-known/jwks.json`（鸭子 surface `jwks()` 注入，web 零 host 依赖，405/404/200+cache
  300s）。会红的门重头=**独立 node:crypto verifier round-trip**（只用 node:crypto+文档算法从头验
  签通过=外部 A2A verifier 不碰咱代码就能验咱字节，这才是标准对齐硬定义）+ 篡改任一字段即失败
  + JCS 确定性 + kid 稳定 + unsigned 字节不变；host 14 单测 + web 9 jwks 路由单测 + 真 HTTP e2e
  冒烟（真 serveWeb+真 signer，外部验签+改名失败 9 断言全过）。NET 文档「签名卡显式不做」旧注记
  同轮修正（deferred→STD-M1 done）。验收：host 1882/web 1271 全绿，四门 PASS（旋钮 106，main.ts
  2973/2980，server.ts 2345/2350）。**M2a** 消费侧验签：纯 JWS/JCS/verify 核抽到 `@gotong/a2a`
  新 `card-signature.ts`（host 只留 file-backed signer 回引+re-export，cli 加 a2a kernel 依赖
  复用验证器不碰装配层，kernel-deps 门绿）；`gotong peer-card` 读 jku（缺则回落
  `<源>/.well-known/jwks.json`）拉 JWKS 验签，打 ✓完整性/✗失败/⚠无法验/未签名，✓ 永远带
  「不代表签发者本人」——签名裁决 advisory 不改出码（契约稳定）。会红门：a2a 12+cli 5 单测
  （含独立 node:crypto round-trip、篡改即败、URL 路由 fetch）+ 真 bin×真签名 host e2e 冒烟 5
  断言 ALL PASS；a2a 55/cli 248/host 1882 全绿，四门 PASS。**M2b-1** a2a 硬化 + cli `--expect-kid`
  独立复验（无 schema，信任姿态=owner 显式确认才 PIN 永不 TOFU）：`verifyAgentCardSignature` 成功
  多返回 `keyThumbprint`（**重算**的验签钥 RFC 7638 指纹），新 `verifyCardKidMatches(card,jwks,
  pinnedKid)` 比 `keyThumbprint===pinnedKid`——**绝不信 protected 头里可被撒谎 JWKS 伪造的 `kid`
  标签**；载重测=**撒谎 JWKS 防御**（攻击者拿受害者 kid 当标签签卡 + JWKS 里把自钥也标成该 kid，
  签名验得过但重算指纹是攻击者的，如实报 mismatch 不误判 match）。`gotong peer-card <url>
  --expect-kid <kid>` 验签外多打 `锚定` 行:一致 ✓ / 不符·未签名·拿不到 JWKS（无法确认）一律
  ⚠,**这是显式断言改出码**——不符 = 出码 3（区别 preflight 未完成的 1，好让脚本
  `peer-card <url> --expect-kid <k> && 重连` 卡在钥变了时），不带旗标时与 M2a 逐字节一致
  （advisory 出码不变）。会红门:a2a `verifyCardKidMatches` 4 单测（含撒谎 JWKS 防御）+ cli 6 单测
  （一致 exit0 / 不符 exit3 / `=` 形式 / 未签名 / JWKS 不可达 / 缺值 usage）+ 真 bin×真签名 host
  e2e 冒烟加 3 断言（一致 exit0、不符 exit3、打印「不符」）ALL PASS；a2a 59/cli 254/host 1882 全绿，
  四门 PASS（旋钮仍 106）。**M2b-2** identity 落 PIN + web 捕获/显示：`peers` 表加可空 `pinned_kid`
  列（schema **v35** additive；公钥指纹非密钥故进列不进 vault）+ PeerRow/AddPeerInput/UpdatePeerInput/
  PeerRegistration 全线穿 `pinnedKid`（undefined 保留 / null 清除，同 `label` 契约）；web `POST/PATCH
  /api/admin/identity/peers` 捕获 pinnedKid（校验 **RFC 7638 43 字符 base64url shape** 防粘贴错 typo
  永久假性不符 / null 清除）+ list DTO 暴露 + admin 联邦面板策略编辑器加「锚定签名公钥」输入（预填/
  编辑/保存，空=清除）；**pin 是 advisory**——pin-only 编辑走 invalidate **不重拨**（从不碰 mesh 门
  控），单测钉死。会红门:identity peers.test 4 例（默认 null/round-trip/保留-替换-清除/与策略独立）+
  web 5 例（POST 持久化+list 暴露 / 默认 null / 坏 shape→400 / PATCH set→clear / pin-only 不
  refreshPolicy）；identity 616/web 1276/host 1882 全绿，四门 PASS（旋钮仍 106）。**M2b-3 面板内实时
  「匹配/不符」徽章 = 用户拍板显式不做**:它需服务端取对端 HTTP 名片复验,但 peer 的 `endpointUrl` 是
  wss mesh 地址、名片在另一端口/协议的 well-known,**无法从 wss 稳妥推导 card URL**——补它要给 web 开
  新出站 fetch 面（含 SSRF）+ 定 card URL 来源,是真架构岔口;按 4.4 把三选项（收 M2 / 加 `card_url`
  列常显徽章 / 按需验证）摆给用户,**用户选「就此收 STD-M2」**——验证能力已由 M2b-1
  `peer-card <https 地址> --expect-kid <kid>`（一致 exit0/不符 exit3）交付,面板已显示 pin,徽章纯便利
  不值这层新出站面;将来联邦规模大到 CLI 逐个跑嫌烦再按岔口选型重启,不预造。**STD-M2 消费侧验签 +
  信任锚至此全完**（M2a 验签 advisory + M2b-1 CLI 锚定断言 + M2b-2 面板落 PIN/显示）。
- **NET agent 网络 track 全完：A 管家出网 M0→M3 + B 名片/发现 M4→M5（2026-07-06/07，`d105712`→`73dad88` 共 6 commit）**
  — 用户拍板「先 A（管家出网）再 B（名片/发现），开工吧」：北极星第 2 层管道厚故事薄——成员
  没有一条对话式入口能让自己的 AI 代表自己跟对端 hub 打交道。两条不可破边界全程守住：管家
  绝不绕既有闸（出网走 installPeerLink 装好的 wrapper，outboundCaps/数据类/owner 审批/对端
  ACL 一道不少，零私有寻址零新特权）、发现≠信任（B track 名片永不自动建边）。**M0**（`d105712`）
  计划 [`docs/zh/NET-AGENT-NETWORK.md`](docs/zh/NET-AGENT-NETWORK.md)。**M1**（`e9f9844`）benign
  只读 `list_peers`：`buildButlerPeerSurface` 窄鸭子拼 PeerRegistry.status()+identity.listPeers()
  （disabled/revoked 边剔除），脱敏红线结构性成立（投影行根本没有 endpoint/token 字段）。
  **M2**（`322f90d`）governed `ask_peer` 主里程碑：出网=cross_hub 级动作必须成员 /me 点头
  （ask_my_agent 问自己人才 benign）；classify 在 park 前服务端权威分级（未知对端/空话/未策展
  /锁死/歧义当场拒，绝不浪费成员一次审批），execute 批准后姿态重解析（边变了诚实「情况变了」，
  绝不按旧快照盲发也绝不静默重拦）；派发阶梯被双 hub e2e 证伪一次——初版「null 边 explicit
  直达」是虚构（wrapper 连 strategy 原样转发、对端按同一 strategy 重派，explicit 指我方 wrapper
  id 过线后无人认领必死 no_participant；且 wrapper 广告能力=row.outboundCaps，G-M1
  advertise=authorize），**只有策展过的边可问**：null→诚实拒+指路策展 / []→锁死拒 / 白名单→
  capability 路由+只读预检（本地抢路/多边歧义拒）；NET-M1 的 null 姿态文案同罪同修；e2e 四场景
  双真 Hub 进程内互联（策展边全环 origin 真章/未策展拒/锁死拒/owner 双闸——成员批后诚实「还差
  一道」，owner 批完才真跨界）；零新 env 旋钮、main.ts 零行（factory 闭包已有 hub+peerRoster）。
  **M3**（`af48654`）capstone：`examples/butler-cross-hub`（host-free 四幕 demo：问→park 零字节
  出网/批准→跨界→origin 真章→答案回同轮/拒绝 fail-closed/未策展当场拒；7 自断言+exit 0 即冒烟门，
  `pnpm demo:butler-cross-hub`）+ FEDERATION-RUNBOOK「变体—管家出网」节 + 双闸最终答案回传
  **显式推迟**（①按 task.from 推回要开 inbox-service/im-bridge 间新缝还得辨任务类别 ②BE-M5 面
  只盖工作流 run——都不小，按「复用既有缝优先、新缝最小」推迟钉文档：管家常问的边不开
  requireApprovalOutbound，高敏边 owner 转达）+ PARTICIPANT/OVERVIEW 指针。A 段验收：host 1861
  全绿（15 单测+4 e2e 新增），四门 PASS（main 2973/2980 不动）。**B track（07-07 收口）动工前
  重侦察 A2A 标准**（v1.0 早 2026 定稿，authoritative=a2a.proto：supportedInterfaces 必填、
  security→securityRequirements、provider 要 url+organization 成对、skill 四字段全必填）——
  且抓到侦察盲区：外部标准查了、自家仓库没 grep，R3 早落了 agent-card.ts+路由+
  GOTONG_A2A_ADVERTISE_SKILLS，差点重造；教训钉进计划文档「侦察清单里『我们自己有没有』排
  第一」（M5 同病：概设的 `connect <url>` 早被 MCP quick-connect 占用）。**M4**（`2be8a38`）
  名片=升 v1.0 卡形+owner 策展：supportedInterfaces[]（接口级 protocolVersion 诚实写 '0.2'，
  卡形升级不冒领方法面）+ securityRequirements 与旧字段双写、provider 删（半个违规范）、
  skills 归一 description←id/tags←[]；策展文件 `<space>/agent-card.json` 人话字段翻规范卡
  （每请求现读改完即生效，优先级 策展>env 枚举>无；损坏=60s 节流 warn+整文件拒绝不半张卡）；
  概设「缺文件→404」修正——卡本就默认 serve 身份最小卡，缺省沉默指 skills 一个不登；web 路由
  零改动零新旋钮，19 单测。**M5**（`73dad88`）发现 preflight=平铺新命令 `gotong peer-card <url>`
  （与 mint-peer-token 同家族）：取对端 well-known 卡翻人话+尾部固定指回既有 token onboarding，
  只读不写看名片永不建边；404=规范内正常答案 exit 0（名片是增强不是前置），对端字段缺/类型错
  逐项降级「(未声明)」绝不炸；出码 0 明确/1 没结论/2 用法错脚本可依赖；runbook 加 Step 0；
  17 单测+真 HTTP 冒烟 9 断言（真 server+真 bin 四分支）。收官验收：cli 243/host 1868 全绿
  （途中顺手修 CARE-M8 outbox e2e 缺有界等待的并发 flake，`10db1e8`），四门 PASS
  （main 2980/2980 顶格）。当初钉「显式不做」的签名卡 keypair 已另起 STD 标准对齐 track 落地
  （见上 STD bullet）；其余（结算/多跳/目录站）仍显式不做。
- **CARE 可靠性深化 M5→M8（2026-07-06 一轮四连，`0ab8b01`→`d1a7a4a`）** — 用户指令「做管家
  可靠性深化」+「A+B 都做」：断供生命周期在上轮只有「坏了/好了」的反应式边沿（M2）+ 不看
  断供的巡检（M3），本轮补成全闭环——好了（主动·M5）/持续坏（升级·M6）/web 可见（M7）/投递
  可靠（M8），四里程碑**零新 env 旋钮**（节律/阈值/上限全常量）。**M5**（`0ab8b01`）主动恢复
  探活：`checkOutageRecovery` 纯函数，诚实边界只探「只读探针能证伪」的 kind（network/timeout/
  auth；quota/rate_limited/model_not_found 留反应式）；60s 常量节律定时器复用 CARE-M4
  onboarding key check 只读活体链——provider 半夜恢复无人说话也播「好了」。**M6**（`84d21ca`）
  长断供升级卡：`outageEscalationCard` 30 分钟阈值红牌进巡检（仍 provider-blind 只读
  `{kind,since}`，病名走 CARE-M1 翻译表）；恢复静默气密——断供文件只被 onProviderSuccess 清
  且它必播恢复，巡检再播恒冗余，按 OUTAGE_CARD_ID 滤掉；抽 `readOutageSnapshotFile` 无缓存
  新读（旁观者不能借 tracker 的内存缓存）。**M7**（`4b540fe`）断供上 web 体检面板：
  `HealthSnapshot.llmOutage` 三态（absent=host 未接/null=正常/行=断供中；读盘故障降级 null
  绝不误报红）；面板**无阈值**即时显示（30min 只为不刷 IM，不是面板的事），置顶最严重红条，
  分钟数/病名双语呈现层现算。**M8**（`d1a7a4a`）投递可靠：`ButlerOutbox` file-first 每成员
  队列——push 失败入盘仍返回原始失败、flush FIFO 停在第一个失败保序、上限 50 丢最旧 warn +
  TTL 24h 丢过期 info（no silent caps）、每成员 promise 链锁防双投；`deliverToMember` 一处缝
  盖住 pushToMember + 断供 announce，onReachable 成员一说话即 flush + 2min cadence 兜「桥好
  了人没吭声」；不给 outboxDir 字节不变。验收：host 1835 全绿，四门 PASS（main 2961/2980，
  105 旋钮不变）。真发布进度：**npm 36/36 全发布**（2026-07-07：首发卡 E429 的 11 包因新号新包
  配额窗口自然放开，单包探针后补齐）+ **PyPI `gotong` 1.1.0 已上**；待办=提醒用户 revoke 首发临时
  Automation/account-scoped token。
更早里程碑（PUB·KIT·CARE 发布/自运维/管家可靠 + FDE-M3 一轮 13 commit `e015808`→`2c121a5`
（36 包翻公开 + unscoped `gotong` 薄壳 + 发布/npx 彩排门 + backup/restore/migrate/update TS 原生
+ CARE 断供不失联 M1→M4 + provision 开荒一条命令），已滚动归档见账本末尾；
FDE 前置部署 track M0→M2（playbook 五段流水线 + 连接器槽位 name-identity +
golden-run 验收 `acceptance[]`；M3 开荒一条命令已于 PUB·KIT·CARE 轮收口 `aa51c51`）见
[`docs/zh/FORWARD-DEPLOY.md`](docs/zh/FORWARD-DEPLOY.md) 与账本末尾逐字归档、REN 全仓改名
AipeHub → Gotong 2026-07-04 一次收口 `5645b9a`（词源 *gotong-royong*，
33 包 @gotong/* + 105 旋钮 GOTONG_* + `.gotong/` 状态目录 + GitHub 仓库改名推送完成；生产机
迁移三件事）见账本末尾逐字归档、LIFE 定时工作流 L1 M1→M3 + L2① 晨报 bundle 全完（零 LLM 调度环 + 成员闸派发 +
开箱晨报；L4 生产 dogfooding 用户操作项在途）见 [`docs/zh/WORKFLOW-SCHEDULES.md`](docs/zh/WORKFLOW-SCHEDULES.md)
与账本末尾逐字归档、DEPLOY 部署简易性 A→C 全完（cloud-quickstart 一条命令 + IM token 落 vault + 向导
粘 token + 设置页缝合 + compose 真机验证 + setup 双信任锚）见 [`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md)
与账本末尾逐字归档、WIZ 六段建流向导 M1→M5 见 [`docs/zh/WORKFLOW-WIZARD.md`](docs/zh/WORKFLOW-WIZARD.md)
与账本末尾逐字归档、BE 管家增强 M1→M6（眼睛三只读 + 诊断闭环 + 零 LLM 运行播报）见
[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)、RES 资源适配
M1→M4 见 [`docs/zh/RES-RESOURCE-ADAPTATION.md`](docs/zh/RES-RESOURCE-ADAPTATION.md)、常驻管家
fold 进 IM 通道 BF-M1→M8、呈现/打包 = 只读 DAG 可视化 + 模板画廊一键装，等）：见账本。

阶段总览（v1.x → v5 全部「完」）与每个里程碑的 commit / 设计细节：见账本。

---

## 三、当前真实缺口（短期修）

> 历史「微偏」清单（协议外通路：PWA / IM / CLI / 桌面分发；AI 范式：streaming / 多模态 /
> 子 agent / 出站驱动外部 agent / long-running / HITL / 联邦…）**绝大多数已落地**——完整
> 能力矩阵与每项的 commit / 落地细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)
> 与第五节文档地图。本节只留**现在仍是缺口**的东西。

### ~~缺口 1：hub / 跨 hub 心智未在入口体现~~ ✅ 已收口

hub 是节点单位：一个人 + 自己的 agent = **主权 hub**；多 agent 也能组成**非主权 hub**（主权
在外部）；工作流既可 hub 内也可跨 hub 完成。原问题：UX 入口 / 文档按「个人 vs 组织」老框架
讲，没把真正的分界「**hub 内 vs 跨 hub**」摆到首屏。PRO + DOC 两 track 已收口：

- **PRO track（PRO-M1→M2 全完，默认 unset=字节不变）** ✅ — `GOTONG_PROFILE=hub|federation`
  呈现视角落地：纯映射层（`packages/host/src/profile.ts`，解析 + 描述符 + 双语横幅行，零
  依赖可单测）+ host 启动横幅接线（`main.ts` 在 host-ready 摘要后印视角块，认不出的值警告后
  忽略）。一条硬边界：**视角 ≠ 行为分叉**——联邦代码在 hub 档照跑、单 hub 代码在 federation
  档照跑，profile 只决定「先展示什么」；不设 = 与今天字节完全一致（运行时验证过）。详见
  [`docs/zh/DEPLOYMENT-PROFILE.md`](docs/zh/DEPLOYMENT-PROFILE.md)。
- **DOC track（DOC-M2→M3 全完）** ✅ — 文档侧：52 篇 `*-FINAL`/`V4-PHASE*`/`AUDIT-*` 账本
  git mv 进 [`docs/zh/ledger/`](docs/zh/ledger/README.md)（顶层 117→65，坏链引入 0，解析器按
  direction+depth 重算链接）+ `docs/zh/README.md` 重排成「① 上手 → ② 理解 → ③ 动手 → ④ 上线 →
  ⑤ 社区 → ⑥ 出处/历史」六级金字塔（61 篇顶层零 orphan）。这同时也收口缺口 2 的 DOC track。

### ~~缺口 2：「易于上手 / 好扩展」是唯一在退的指标~~ ✅ 已收口（FUN / DOC / EXT / GUARD 四 track 全完）

功能面已把立项目标（开源 / 多人 / 多智能体 / 协同 / 工作流 / 框架）做满；真差距在**体感上手
速度**与**扩展门槛**：装配层重（`host/src/main.ts` ~3.2K 行 / host 32 依赖）、旋钮多（~107 个
`GOTONG_*`）、文档考古层压过教程层（docs/zh 里 40+ 篇是 FINAL/PHASE/AUDIT 账本）。**内核本身干净**
（protocol 零依赖 → core → workflow / inbox，依赖方向正确，约占全仓 11%）——问题在打包 / 默认值 /
文档层，不在骨架。→ FUN（5 分钟漏斗 + TTFR 承重门）/ DOC（账本外移 + 金字塔）/ EXT（Participant
一页 + example 索引）/ GUARD（防再膨胀护栏）四 track 收口。

- **FUN track（FUN-M1→M2 全完）** ✅ — 官方 5 分钟上手漏斗 [`QUICKSTART.md`](QUICKSTART.md)（clone →
  首个可见结果的 do-this→see-that 阶梯）+ TTFR 承重门 `scripts/first-result-smoke.mjs`（spawn
  文档第一步那条 `pnpm demo`、剥掉所有 key、断言多方首个结果在预算内到达，`pnpm check:first-result`，
  会红的门）。
- **DOC track（DOC-M2→M3 全完）** ✅ — 见缺口 1（账本外移 ledger/ + docs/zh/README.md 六级金字塔）。
- **EXT track（EXT-M1→M2 全完）** ✅ — 扩展面 + 例子从「一堆」变「梯子」：
  [`docs/zh/PARTICIPANT.md`](docs/zh/PARTICIPANT.md)（20 行写一个 Participant，裸接口 +
  `AgentParticipant` 基类两写法，每个片段的 import 符号对着 `@gotong/core` 实导出核过）+
  [`docs/zh/SURFACE-PATTERN.md`](docs/zh/SURFACE-PATTERN.md)（host↔web 鸭子 `*Surface` 注入，
  web 运行时不依赖 host，加能力配方）+ [`docs/zh/EXAMPLES.md`](docs/zh/EXAMPLES.md)（50 个 demo
  按上手台阶分七级，每行标前置，绝大多数零前置）。
- **GUARD track（GUARD-M1→M2 全完，默认全绿）** ✅ — 防再膨胀护栏，四道会红的承重门
  （`pnpm check:guards` 聚合）：内核依赖方向（`scripts/kernel-deps-gate.mjs`：protocol 零依赖 /
  workflow 零 LLM / web∌host / kernel↛装配层）+ `GOTONG_*` 旋钮注册表（`scripts/env-registry-gate.mjs`
  + `scripts/gotong-env-registry.txt`，核出真实 **103** 个，加一个不登记就红）+ 装配层行数预算棘轮
  （`scripts/line-budget-gate.mjs`：main.ts≤3500 等，只降不升）+ 惯例成文
  [`docs/zh/CONVENTIONS.md`](docs/zh/CONVENTIONS.md)（惯例→门→命令总表）。

### ~~缺口 3：管家作为「用户 ↔ 框架」中间层还缺眼睛~~ ✅ 已收口

BE track（BE-M1→M6）已补齐：管家的观察面（三只读）+ 诊断闭环 + `create_workflow` + `ask_my_agent`
+ 运行结果零 LLM 主动播报，全复用既有成员向只读投影 / 审批闸。详见
[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)。


## 四、工作守则(开发指令)

### 4.1 与用户约定(会话级反复强调, 不要违反)

- **GitHub 已公开 + push 已解冻 (repo 2026-06-28 转 PUBLIC)**: 仓库 `Emir-Aksoy/Gotong` 已公开, push 解冻。（2026-07-04 用户授权后已完成 GitHub 仓库改名 `Emir-Aksoy/Gotong` + 推送, 旧 URL/旧克隆自动 redirect。）推送纪律: **只推 `main`**, fast-forward only, **绝不强推**; 推前 `git fetch` 校验 `git merge-base --is-ancestor origin/main main`。远端有 dependabot 分支 + PR, 不动它们。Actions 仍仓库级禁用 (公开后重新启用免费)。具体哪次该不该 push 仍按用户指令, 不擅自 push。
- **不要动备份**: `~/Backups/AipeHub/` 是历史快照, 只读
- **临时/测试产物清理阈值 (2026-06-19 用户指令)**: agent 自己产生的临时 / scratch / 测试文件 (如 `/tmp/gotong-e2e-*` 测试空间、`/tmp/gotong-*.log`、临时 host 数据目录) 占用 **≤ 10 GB 时不必清理**, 超过阈值才清。清理前先 `du -sh` 核实大小。注: harness 会拦截破坏性 `rm -rf` 大范围通配 + 前台 `sleep`, 真要清就 `rm` 具体目录、逐项删, 别用 `rm -rf` 通配。
- **不需要向前兼容**: 还没上线, 大胆改 schema / API。删旧代码比加 deprecation shim 优先
- **代码尽量简化, 节点尽量轻量**: 每个 PR 一个小目标, 别一次塞 5 个 feature
- **一个任务一个任务**: 规划完一项 → 开发 → 测试 → commit → 下一项
- **主流 agent 接入标准**: 以后每个主流 agent 适配器都必须过《`docs/zh/AGENT-ADAPTER-CONTRACT.md`》的「双向 + 可快速接管」验收门 —— ① 双向连通 (入站 MCP/A2A + 出站 shell-out/A2A/鸭子 adapter); ② 五控制缝 (可观测/可拦截/可移交/可续跑/可终止); ③ 接管粒度至少 Tier 1, 能改文件·花钱·对外发的到 Tier 2, 黑盒 agent 的副作用面在 hub 边界钉 Tier 2。新写 adapter 先对表。
- **Auto Mode bias**: 不要每步都问; 不清楚的地方留 inline 注释说明默认选择, 用户会 redirect

### 4.2 代码风格

- TypeScript ES modules(`type: "module"`), `.js` 后缀 import path
- pnpm workspace, 包间引用走 workspace protocol
- 测试用 vitest, 每个新 feature 配回归测试
- 错误用 `IdentityError` / 类似类型化错误码, 不抛裸 Error
- 日志用 `@gotong/host` 的结构化 logger(JSON / pretty 自适应)
- 注释写「为什么」, 不写「是什么」。代码自身能读出"是什么"
- 不要无故添 emoji 到文件 / commit message。除非用户明说

### 4.3 commit message 风格

参考最近 commit:
```
feat(transport-ws,host): inbound peer rate limit (Phase 6 #12)
fix(security,host,identity): Audit Phase 6 P0+P1 batch (#141-147)
docs(audit): v4 Phase 5 full audit — 15 modules, no P1/P2 hotfixes (F1)
```

- 前缀 `feat / fix / docs / refactor / chore / test`
- 括号里列动到的包名
- 短描述 + 阶段号 / issue 号
- body 写"为什么"
- 末尾固定 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### 4.4 何时停下来问

- **schema 不可逆变动**(drop column, drop table): 哪怕"不需要向前兼容",
  也确认一下是否要保留迁移脚本
- **删除现有 public API surface**: 即使没人在用, 也描述影响面再删
- **架构 fork 选择**(比如 "streaming 走 SSE 还是 long-poll"): 把选项列出
  来, 推荐其一, 等用户拍板
- **生产凭证 / .env**: 永远不读不写不 commit

---

## 五、关键文档地图(agent 用)

> 单元格里的历史落地细节已移到各文档自身正文与
> [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)；这里只留「想知道什么 → 读哪」的路标。
>
> **逐里程碑账本已归档到 [`docs/zh/ledger/`](docs/zh/ledger/README.md)**（DOC-M2）：52 篇
> `*-FINAL` / `V4-PHASE*` / `AUDIT-*` 从 `docs/zh/` 顶层搬进去，顶层只留当前教程 / 参考。
> 下面凡指向 `docs/zh/ledger/…` 的都是那一档深潜 / 历史；内容一字未改，只挪了位置。

**根 / 定位**

| 想知道什么 | 读哪 |
|---|---|
| 项目宪章（认知 / 北极星三不可破 / 三层用途 / 信任护城河 / 愿景；与代码冲突时宪章为源） | `CHARTER.md` · `docs/zh/CHARTER.md` |
| 5 分钟总览 | `docs/zh/OVERVIEW.md` |
| 框架设计哲学 + 模块边界 | `docs/zh/ARCHITECTURE.md` |
| 给框架加能力而不加耦合（host↔web 鸭子 `*Surface` 注入；web 运行时不依赖 host；加新能力配方） | `docs/zh/SURFACE-PATTERN.md` |
| 防再膨胀惯例 + GUARD 承重门（依赖方向 / 旋钮登记 / 行数预算；`pnpm check:guards`） | `docs/zh/CONVENTIONS.md` |
| 协议规约（v1.2） | `docs/PROTOCOL.md` |
| 产品定位（赛道地图 + 产品级矩阵 + 目标用户） | `docs/zh/COMPETITIVE-LANDSCAPE.md` · `docs/zh/PRODUCT-MATRIX.md` |
| 2026-07 战略盘点（5 路市场再核：主权 hub×联邦×人机同权×治理闸四项合一全球+中国均无人占 / 管家差异全在治理面 / 未来框架八性质 / 基础设施九判据体检 + 12-24 个月窗口 + 产品先行路径裁决 + 微信 iLink·家庭 hub·AIP 三方向细化规划 + 命名/可持续性两岔口） | `docs/zh/STRATEGY-2026-07.md` |
| 部署视角（`GOTONG_PROFILE=hub\|federation` 入口先讲 hub 内 vs 跨 hub；呈现视角非行为开关；unset=字节不变） | `docs/zh/DEPLOYMENT-PROFILE.md` |

**上手 / 打包 / 案例**

| 想知道什么 | 读哪 |
|---|---|
| 上手案例（5 个开箱 hub 对照 + 确定性 demo + go-live） | `docs/zh/HANDS-ON-HUBS.md` |
| 20 行写一个 Participant（框架唯一扩展面：agent / 人 / 服务同一契约；裸接口 + 基类两写法） | `docs/zh/PARTICIPANT.md` |
| 50 个 example 的分级索引（先跑哪个 → 深到哪；每行标前置，绝大多数零前置） | `docs/zh/EXAMPLES.md` |
| 模板画廊一键安装 | `docs/zh/TEMPLATE-GALLERY.md` |
| 只读 DAG 可视化 | `docs/zh/WORKFLOW-DAG-VIZ.md` |
| 工作流架构师（大白话→YAML + 讲解 + 配图 + 成员 `/me` 新建） | `docs/zh/WORKFLOW-ARCHITECT.md` |
| 六段建流向导（确认→盘点→组装→衡量缺口→提议→校验闭环；三入口 + 同闸落盘 + 评测基线） | `docs/zh/WORKFLOW-WIZARD.md` |
| 定时工作流（零 LLM 调度环：意图/事实分文件 + 成员闸派发 + BE-M5 播报免费；admin CRUD + 试跑） | `docs/zh/WORKFLOW-SCHEDULES.md` |
| 易用性深化（失败修复入口 / 配置体检 / 启动兜底 / VALID 定义校验） | `docs/zh/EASE-OF-USE-DEEPENING.md` |
| 统一 `setting` 运维控制台（一命名空间 + 三入口 + 零大模型 + tier 边界） | `docs/zh/SETTING-OPS-CONSOLE.md` |
| MCP 接入（client + server） · 连接器目录 | `docs/zh/MCP.md` · `docs/zh/MCP-CONNECTOR-DIRECTORY.md` |
| 接入现实生活 track（C：把连接器目录伸向日历/邮件/消息/笔记/任务；C-M1 静态 token 首批 Notion/Todoist，**C-M2 出站 OAuth 全完**=纯核+存储+连接流+注入+刷新+admin CRUD+目录预设+「连接现实生活」面板+`reallife-oauth` capstone；三边界=全走 MCP 不存数据、凭证纪律、接入≠授权行动） | `docs/zh/REAL-LIFE-CONNECTORS.md` |
| 微信 iLink 桥 track（WX：第 7 座 IM 桥走官方 iLink 协议[2026-03 首条合法个人号通道，HTTP/JSON 长轮询同构 Telegram]；**M0 侦察 + M1 协议纯核 + M2 桥/host 装配/CLI 扫码登录已全落；M3a 登录流真机已证=马来西亚号在国际灰度内、凭证到手、止损线不触发；M3b 消息 round-trip 待用户回微信侧**；五边界=只走官方、opt-in 字节不变、接入≠授权、内核零改动、被动回复诚实） | `docs/zh/WECHAT-ILINK-BRIDGE.md` |
| 知识库连接器 / RAG（全走 MCP，框架不存知识） | `docs/zh/KB-CONNECTORS.md` · `docs/zh/RAG-VIA-MCP.md` |

**社区 / 上线**

| 想知道什么 | 读哪 |
|---|---|
| 荣誉激励制度（引用排行榜 / 晋升路径 / 便捷共享 / 共享范本，纯荣誉） | `docs/zh/RECOGNITION-SYSTEM.md` |
| 社区贡献 + 模板提交流程 | `CONTRIBUTING.md` · `templates/community/templates/README.md` |
| 治理 + 行为准则 + 维护者名册 | `GOVERNANCE.md` · `CODE_OF_CONDUCT.md` · `MAINTAINERS.md` |
| 旗舰模板策展索引 + 引用排行榜 | `docs/zh/FLAGSHIP-TEMPLATES.md` |
| 零算力社区站生成器 · GitHub Discussions | `docs/zh/COMMUNITY-SITE.md` · `docs/zh/COMMUNITY-DISCUSSIONS.md` |
| 前置部署 playbook（FDE 五段流水线：发现→构建→对接→部署验收→观察移交 + 两边界守则；M1a/b 连接器槽位 + M2 golden-run 验收 + M3 schedules/provision 已落地） | `docs/zh/FORWARD-DEPLOY.md` |
| agent 网络 track（NET 全完：A=管家出网 M1 眼睛/M2 ask_peer 治理/M3 双 hub capstone + B=M4 A2A v1.0 名片+owner 策展/M5 `gotong peer-card` 发现 preflight；两边界=不绕既有闸、发现≠信任） | `docs/zh/NET-AGENT-NETWORK.md` |
| 标准对齐 track（STD：对外表面接开放标准可选强化项；M1 名片签名生产侧=opt-in ES256 JWS+JWKS，M2 消费侧验签+PIN 公钥；两边界=opt-in 默认字节不变、发现≠信任） | `docs/zh/STD-STANDARDS-ALIGNMENT.md` |
| 上线 runbook（三拓扑 T1/T2/T3） | `docs/zh/GO-LIVE.md` |
| 发布 runbook（npm 36 包 + PyPI；发布前门 / OTP / 回滚=deprecate 纪律） | `docs/zh/PUBLISH-RUNBOOK.md` |
| 便携包分发（下载双击即跑，零 Node/Docker） | `docs/zh/PORTABLE-BUNDLE.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md` · `docs/OPERATIONS.md` · `docs/MONITORING.md` |

**能力专题（正文有全链路细节）**

| 主题 | 读哪 |
|---|---|
| v4 整体架构 + Phase 路线 · 跨 org federation 模型 | `docs/zh/ledger/V4-ARCH.md` · `docs/zh/ledger/V4-PHASE4.md` · `docs/zh/ledger/V4-PHASE5-FINAL.md` |
| 工作流生命周期 + 版本化（防漂移） | `docs/zh/ledger/V4-PHASE15-FINAL.md` |
| 成员任务 inbox（human-in-the-loop） | `docs/zh/ledger/V4-PHASE16-FINAL.md` |
| 用量·成本账本 + 配额 fail-closed + 审计导出 | `docs/zh/ledger/V4-PHASE17-FINAL.md` |
| 联邦能力 manifest + 跨组织 policy + A2A 闭环 | `docs/zh/ledger/V4-PHASE18-FINAL.md` |
| `/me` 成员工作台 · workflow 治理 · 安全运维 · 联邦信任契约 · 生态接入 | `docs/zh/V4-PHASE19-P1..P5-FINAL.md` |
| 控制面历史趋势 + 告警阈值 + 跨 hub 聚合 | `docs/zh/ledger/V5-F-FINAL.md` |
| 跨 hub 工作流编排（北极星 第 2 层） · 两机操作员 runbook | `docs/zh/ledger/V5-G-FINAL.md` · `docs/zh/FEDERATION-RUNBOOK.md` |
| A2A 外部 agent 当工作流步（+ 会挂起的 H2） | `docs/zh/ledger/V5-H-FINAL.md` |
| 成员大白话改工作流（OpenClaw 式）+ 跨 hub 出入口锁 | `docs/zh/ledger/V5-WFEDIT-FINAL.md` |
| 成员大白话管理 hub 设置（管家 Stream SW） | `docs/zh/ledger/V5-STEWARD-FINAL.md` |
| 常驻个人管家（记忆 + 治理 tool-loop + fold 进 host；建之前设计见 DESIGN） | `docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md` · `docs/zh/ledger/PERSONAL-BUTLER-FINAL.md` · `docs/zh/PERSONAL-BUTLER-DESIGN.md` |
| 管家增强（观察面三读 + 诊断闭环 + create_workflow + ask_my_agent + 运行零 LLM 播报；五缝复用既有成员 surface） | `docs/zh/ledger/BUTLER-EMPOWER-FINAL.md` |
| 管家任务笔记本（TN 全完：file-first 每成员 tasks.json + 4 benign 工具 + digest 复述缝 + 卡壳零 LLM 提醒 + 失忆模型 capstone；管家层不进内核、笔记本≠授权、≠第二工作流引擎） | `docs/zh/BUTLER-TASK-NOTEBOOK.md` |
| 管家使用感受增强（UX 全完：时钟 + A1 待办提醒 + A2 时段/间隔 + A3 语言偏好 + A4 来源渠道 + B1 能力发现 + B2 晨报增强；四边界=热路径零 LLM / 冻结块字节不变 / 数据离盒 opt-in / 内核零改动） | `docs/zh/BUTLER-UX-ENHANCEMENTS.md` |
| IM 审批闭环（IMA 全完：`/inbox` `/approve <短码>` `/deny` 三动词把 /me 待批项搬进绑定 IM 聊天窗;安全姿态 b=`imApprovable` 写入时白名单 fail-closed + web-only 按名字形状判[ask_peer/`__` MCP 名不标] + 审计 actorSource='im'+metadata.via;执行链全复用 HostInboxService.resolve 零新权威点,S1-M3 回推补上「决定」方向后 park→提醒→批→回推同窗闭环） | `docs/zh/IM-APPROVAL.md` |
| 模型路由（MR 全完：M1 RoutingProvider 纯核=有序候选+首-chunk-前 failover+per-candidate 三态熔断 + M2 opt-in `fallbacks` 配置面+providerFactory 装配缝 + M3 per-provider **被动**健康 in-memory 投影上面板黄条 + M4 capstone + M5 **手动测试路由**=逐候选主动探针[面板按钮→真 spawn 链发最小 completion→复用 describeKeyTest 逐候选渲染]补被动健康的洞;四边界=热路径零 LLM 走确定性路由非内容感知/opt-in 字节不变/数据离盒 opt-in/内核零改动） | `docs/zh/MODEL-ROUTING.md` |
| 原生适配（NA 全完：M0 体检报告[骨架已原生,缺口全在 LLM 调用层] + M1 提示词缓存原生化=anthropic 三断点[工具尾/system 尾/末消息增量]默认发+auto 规则[带工具才下]+OpenAI/DeepSeek 缓存命中如实入账 + M2 调用韧性=withCallWatchdog 挂死看门狗[双表 120s+abort/race 双保险]+withTransientRetry 瞬态单次重试[仅首 chunk 前],装配缝 pool 咽喉一处盖全:看门狗包每叶子含路由候选、重试只包单 provider 形态 + M3 system 分块缓存=`systemVolatile` 探针尾隔离出缓存段[稳定块挂标恒命中,不启用缓存路径逐字节一致] + M4 用量面板缓存读/命中率两列[合计行从合计数算] + M5 opt-in `maintenanceModel` 维护低价模型[per-tick 解析,resolver 抛错降级] + M6 /me 流式=侦察[管道已铺九成,成员级 SSE 显式不推荐]+M6a steward 框 NDJSON 打字预览[web-only,host chunkSinks 缝早备]+M6b quick-chat/阿同流式[pool per-call chatChunkSinks key 分流+鸭子 MeChatStreamSurface,无 surface 回落纯 JSON];零新旋钮全常量） | `docs/zh/NA-NATIVE-ADAPTATION.md` |
| 管家记忆增强（多级 / 重要性 / 召回索引 / dreaming / 技能 / 6h 维护） | `docs/zh/ledger/MEMORY-TIERS-FINAL.md` · `docs/zh/ledger/MEMORY-ADVANCED-FINAL.md` · `docs/zh/ledger/MEMORY-DREAMING-SKILLS-FINAL.md` |
| 记忆升级（MU 全完：M1 recall benchmark 承重门 + M2 融合召回默认 + M3 原子事实抽取 + M4 外部 Mem0 provider/dataLeavesBox 披露 + M5 记忆树 git 快照 opt-in + capstone；四边界=框架不跑 LLM / 字节不变 / 数据离盒 opt-in / 内核零改动） | `docs/zh/MEMORY-UPGRADE.md` |
| 家庭 hub 垂直（FAM：#8081 杀手场景首屏叙事一页纸 + 开箱 15 分钟验收标准 + `examples/family-hub` 画廊一键装 bundle[审批演示流 human 步指派家长 + 家庭晨报 + 3 可选生活槽位 + golden-run] + M3 信任基建[威胁模型页 + GOVERNANCE 许可恒定双语节 + provenance 调研] + M4 传播面 docs[README/OVERVIEW 双语首屏家庭入口 + 许可恒定指针；Discussions 板/部署计数待用户拍板]；M0+M1+M3+M4(docs) 已落，M2 试点家庭在途） | `docs/zh/FAMILY-HUB.md` · `docs/zh/THREAT-MODEL.md` |
| 家庭学习 hub（联邦设计 + go-live；FAM 的深水区双主权形态） | `docs/zh/FAMILY-LEARNING-HUB-DESIGN.md` · `docs/zh/FAMILY-LEARNING-GO-LIVE.md` |
| 资源适配（RES 只读探测 → 人批准应用） | `docs/zh/RES-RESOURCE-ADAPTATION.md` |
| UI 国际化（中英双语，检测 / 切换） | `docs/zh/I18N-PLAN.md` |
| 企业 SSO（OIDC · SAML） · 联邦 peer onboarding | `docs/zh/ledger/V6-ROUTE-B-P1-M4-OIDC.md` · `M5-SAML.md` · `M7-PEER-ONBOARDING.md` |
| 出站 A2A 持久化配置 · A2A 任务生命周期 · 真实 LLM 冒烟门 | `docs/zh/V6-ROUTE-B-P1-M11 / M8 / M13`（同目录） |
| 主流 agent 适配器契约 · 快捷接入（入站） | `docs/zh/AGENT-ADAPTER-CONTRACT.md` · `docs/zh/QUICK-CONNECT.md` |
| 出站 CLI shell-out adapter · 出站 ACP 长连接 adapter | `docs/zh/ledger/V5-E2-CLI-ADAPTER.md` · `docs/zh/ledger/V5-ACP-ADAPTER.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 完整审计报告 · 全量审计 2026-06-10 | `docs/zh/ledger/AUDIT-v4-phase5.md` · `docs/zh/ledger/AUDIT-2026-06-10-FULL.md` |
| 历史 commit 流水账 · 历史外部审计 | `CHANGELOG*.md` · `audits/`（`audits/README.md` 索引） |
| **全部里程碑逐字账本** | [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) |

---

## 六、目录结构速查

> 每个包的 per-Phase 演进细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) 与各包 `src/*` 顶注。

```
packages/                       36 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, 零 runtime
├── core/                       Hub / Scheduler / Storage / Participant (仅依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   users/credentials/sessions/vault/quota/peers/im_bindings/
│                               suspended_tasks/usage_ledger/totp/oidc/saml/a2a·acp_outbound
│                               (SQLite, 迁移到 v26+; SSO cert/token 走公钥或环境变量名, 不进 vault)
├── host/                       生产 host 二进制 (main.ts ~3.2K 行) — 装配层, 把所有包接成一个进程
│   └── src/                    local-agent-pool / org-api-pool / pricing / peer-registry /
│                               peer-manifest / outbound-approval / a2a-server / workflow-versioning /
│                               inbox-service / hub-steward-service / steward-approval /
│                               personal-butler-* / a2a-outbound / acp-outbound / oidc·saml-login …
├── web/                        admin UI HTTP + SSE + SPA; 鸭子 surface 注入, 零 host 运行时依赖;
│                               src/*-routes.ts + static/*.js (admin.js/app-core.js 经 esbuild bundle)
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML 工作流 runner — parseWorkflow / WorkflowRunner / RunStore /
│                               predicate / resolver / lifecycle 状态机 + 修订防漂移, 零 LLM dep
├── workflow-assistant/         WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow+llm
├── inbox/                      成员任务 inbox — InboxStore / FileInboxStore / HumanInboxParticipant
│                               broker (cap gotong.human/v1), 只依赖 core
├── hub-steward/                管家 (大白话管理 hub 设置) — HubStewardAgent + 纯分类器 classifyStewardAction
│                               (四级 safe/dangerous/cross_hub/forbidden), 依赖 core+identity
├── personal-memory/            记忆引擎 — 冻结块护缓存 + 自动捕获 + 强制蒸馏 + 可换检索; 零 host/identity dep
├── personal-butler/            有界治理 tool-loop — PersonalButlerAgent + GovernedActionToolset
│                               (allow/approve/refuse 服务端权威, approve→SuspendTaskError→/me 收件箱)
├── a2a/                        A2A interop — message/send wire + a2aSend client + A2aRemoteParticipant
│                               (出站) + task lifecycle; 入站 A2aServer 在 host; 依赖 core
├── cli-agent/                  出站 CLI shell-out (hub 驱动 Claude Code/Codex/Aider…) — 五缝 + 动作闸
├── acp-agent/                  出站 ACP 长连接 (hub spawn 一次 hold session 反复派) — 五缝 + 逐动作权限闸
├── saml/                       SAML 2.0 SP 协议核 (DSig 交成熟库, 自写 SP 胶水 + XSW 防御, XML 隔离本包)
├── mcp-server/                 MCP server (Claude Desktop / Cursor 调 hub)
├── mcp-client/                 MCP client (agent 调外部 MCP tools)
├── services-sdk/               services plugin contract
├── service-memory-file/        memory(jsonl) · service-artifact-file/ artifact · service-datastore-sqlite/ sqlite
├── im-adapter/                 IM bridge 共享 SDK (ImBridge / parseImCommand)
├── im-telegram/ im-matrix/     长轮询 / Client-Server sync
├── im-lark/ im-slack/          官方长连接 / Socket Mode (免穿透)
├── im-discord/ im-qq/          Gateway WSS / 官方 Bot API webhook (入站需公网)
├── cli/                        gotong CLI (start / repl / check / doctor / setting / connect / mint-peer-token /
│                               peer-card / provision / update / backup / restore / migrate)
└── evals/                      workflow / prompt 评测
python-sdk/                     PyPI `gotong` (含 adapters/ LangGraph/CrewAI participant adapter)
templates/                      agents / teams / workflows / bundles / community
examples/                       55 个端到端 demo (上手 hub / 组织 hub / 跨 hub 编排 / adapter 桥…)
docs/  docs/zh/                 双语文档 (顶层=当前教程/参考; docs/zh/ledger/=52 篇逐里程碑账本;
                                docs/zh/PROGRESS-LEDGER.md = 全部里程碑逐字散文索引)
audits/ scripts/ monitoring/    审计快照 / backup·restore·verify·prune / prometheus+grafana
```


## 七、下一步建议清单(供 agent 起步时挑)

按"对北极星贡献度 / 工作量"排:

| 优先 | 任务 | 工作量 |
|---|---|---|
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/src/server.ts` (3563 行) 的 route groups~~ | **2026-05-28 三批完成** — batch 1 `workflow-routes.ts` (3701→3578); batch 2 `agents-routes.ts`/`services-routes.ts`/`uploads-routes.ts` (3578→2780); batch 3 `setup-routes.ts` (2780→2690) |
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/static/admin.js`~~ | **2026-05-29 完成** — esbuild bundler + 三 ES module (`services.js`/`managed-agents.js`/`workflows.js`); admin-src/main.js 3103→2344; workflow-start 共享渲染层故意留 main.js |
| ~~进行中~~ | ~~Phase 12 M9-M11 PWA + mobile responsive + 移动简化 shell~~ | **2026-05-29 完成** — PWA app-shell (manifest + sw.js + offline + icon, `/api/*` 不缓存) + 响应式 admin SPA (`@media` 720/420 单列 + 横滚表格 + 触控目标) + 5 PWA 测试; commit 7fe8a27 + c9dd395 |
| ~~中期~~ | ~~默认 RAG MCP server 推荐 + setup 文档~~ | **2026-05-28 完成** — `examples/rag-mcp/` (chroma-mcp) + `docs/zh/RAG-VIA-MCP.md` |
| 长期 | 微信小程序 / 其他原生入口 | 2-3 周 |

不要把这张表当 backlog 死磕 — 它只是"如果用户问'下面做什么'时, agent
不至于卡住"的备选。**用户指令 > 这张表**。
