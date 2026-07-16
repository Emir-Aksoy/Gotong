# 阿同框架及恢复能力提升 track(AFR)— M0 计划

> 缘起:用户 2026-07-15 拍板三件事 ——
>
> ①「优化 atong 的设计,它的工具模块这些整合好都以目录的方式留给它调用,降低它的
> system prompt 认知负担。」
>
> ②「框架的随身向导+医生也是它的功能,但是不影响它本身就是一个拥有自动学习和执行
> 能力的智能体。benign 工具按需取才是对的。」+「这些能力应该在 atong 的预置知识内,
> 但是不要做成他每次都会调用的认知负担。」(指从配置一步步指导、出错快速修复、到
> 梳理它自身与其他 agent 在 gotong 框架里的功能。)
>
> ③「最好的是不建立任何中心化节点及恢复方式,由用户自行选择备份……在我们的 atong 里
> 增加一个备份功能,可以便捷地将所有关系一并打包并交给用户(档位可调整,可选哪些
> 信息打包),有需要的时候用户用它恢复就行了。」
>
> 本文是 M0:**纯计划,零代码**。track 名从用户原话:**阿同框架及恢复能力提升**,
> 代号 **AFR**。Last updated: 2026-07-15。

---

## 零、一句话

三条腿把阿同升成「轻装上阵的框架管家」:

- **腿 A 工具面目录化** —— 30+ 工具 schema 的每轮认知负担降下来,**能力一件不减**;
- **腿 B 随身向导+医生** —— 框架知识预置成**按需取用**的知识卡,不进每轮 prompt;
- **腿 C 恢复兜底** —— **零中央节点**,分档备份打包交给用户自持,阿同负责提醒与陪跑。

逐个完成,每腿可独立收口;三腿共享同一组不可破边界(§三)。

---

## 一、决策轨迹(2026-07-15,为什么是这个形状)

本 track 的形状是一轮完整辩论的产物,记录在此防止将来重开已裁决的岔口:

1. **用户初问**:能否有一个中央节点做 agent 身份的「最终归属」(以邮箱为准),换主机
   也凭它拿回身份?数据/工作流仍留本地,中央只做可选身份验证。
2. **辩论**:中心化恢复确实**更高效**(30 秒 vs 几小时;监护人集会会腐烂),但效率
   几乎全部来自「邮箱那条**流程**」,不来自「中央**拥有**身份」——拥有式为了加速
   罕见路径(恢复)而给常见路径(每次验证)上税,还带来单点故障/审查/永久运营负担;
   「数据在本地、身份被中央拿捏」=空心主权,砸的是 CHARTER 的护城河。
3. **用户拍板**:**不建任何中心化节点及恢复方式** —— 用户自行选择备份,阿同做便捷
   分档打包 + 提醒。一个自己攥着的档案不会腐烂:不需要法定人数、不依赖别人在线。
4. **随后扩容**:阿同不只提醒备份,还应是**框架的随身向导+医生**(配置指导/出错修复/
   框架梳理),知识**预置但按需取**;再定:**工具面整体目录化**,降 system prompt
   认知负担,且**不影响阿同是拥有自动学习和执行能力的智能体**。

已裁决、本 track 不再重开的岔口:中央身份锚点/邮箱恢复(将来若做,必须「背书非拥有 +
可自建可多实例 + 多因素时延否决」,见 §五);监护人 M-of-N 社交恢复(远期档)。

---

## 二、现状体检(2026-07-15,逐条对着代码核过)

### A 工具面(认知负担的真身)

- 管家工厂引 **20+ 个 toolset 模块**(`personal-butler-factory.ts:47-93`),benign 具名
  工具实数 **30 个**(`ask_my_agent`/`list_my_*` 家族/`plan_workflow`/`set_*` 家族/
  任务笔记本 4 件/`discover_llm_providers` 等),再叠 governed 动作工具 + MCP 连接器
  `<server>__<tool>`,与 NA-M0 实测「每轮 ~34+ 工具 schema、6–10K token」一致。
- **NA-M1 之后 schema 已进缓存前缀**(带工具的请求自动下 cache_control 断点),所以
  负担的真身**不是每轮美元**,而是:① **选工具注意力稀释**(30+ 候选里挑 1 个,弱模型
  尤其伤);② **上下文占用**(6–10K token 永驻);③ **工具集一变缓存前缀全失效**
  (装/卸一个 MCP 连接器,整段前缀重写)。
- NA track 显式推迟过「**工具面瘦身先度量后动**」—— 腿 A 就是这根接力棒。
- llm 层已有组合原语:`ComposedToolset` / `DispatchToolset`(`packages/llm/src/`),
  两层化的新纯件是它们的兄弟,不动内核。

### B 知识面(向导+医生的地基)

- grep 零命中 `playbook/_guide/lookup_` 类工具 —— **知识卡系统是全新地**。
- 已有的是**活状态投影**:`list_my_capabilities`(UX-B1,从真实装的工具派生)、
  observe 三只读 + `diagnose_my_agents`(BE track)、`list_my_llms`(LSA-M1)、
  `list_peers`(NET-M1)、`discover_llm_providers`(LSA-M3)。
- 分界干净:**已有工具答「我现在什么状态」,缺的知识卡答「这东西怎么用 / 坏了怎么修」**。
- 部署硬事实:**生产机上没有 `docs/zh/`**(npm 包不含仓库文档),且那些文档是写给人
  看的,整篇喂给模型会撑爆上下文 → 知识必须**随包出货、策展成卡**。
- 已验证两次的先例:LSA-M3 静态策展目录(常量 + benign 工具 + 防腐钉事实)、
  UX-B1 现场派生 —— 腿 B 是把这个已验证模式推广成系统。

### C 恢复面(备份的地基)

- `gotong backup <space> <dir> [--include-master-key]` + `restore`(先验 sha256 清单)
  已在(`packages/cli/src/commands/backup.ts:106`、`backup-core.ts:55`);master key
  两世代**默认排除**,带上=「**档案即凭证**」(`backup-core.ts:7-10`,at-rest 加密对
  这份拷贝形同虚设),现有命令已印密级警示。
- 身份钥 = `.gotong/agent-card-signing.key`(ES256 PKCS#8,kid = RFC 7638 指纹,
  **跨重启跨主机稳定** —— 带着钥文件走,天下照认)。金库主钥 = `identity-master.key`。
- `peers` 表 = 持久通讯录(endpoint_url / pinned_kid / trust_tier;**peer 令牌在金库**,
  这条事实决定了「关系档」的诚实边界,见 M6)。
- THREAT-MODEL 已写死:「**没演练过的备份等于没有备份**」。
- 缺的正是用户点的三样:**分档** / **提醒**(备份的真实失败模式是「没人提醒你做」,
  不是「不会做」)/ **普通人入口**(家庭档不会开终端)+ 恢复演练便道。

---

## 三、五条不可破边界(三腿共享)

1. **热路径零 LLM 决策**:目录渲染=纯常量,分发=查表转发,面包屑=拼静态字符串;
   **绝不做「按消息内容现场选工具集」**(哪怕关键词启发式也先不做 —— 那是通往内容
   感知路由的滑坡,M1 数据先说话)。
2. **能力零阉割、治理闸零绕过**:今天可调的每个工具改造后仍可调(防腐门钉死
   「目录 ∪ 一等 = 全集」);**governed/park 类工具永远保留一等 schema**(风险面最需要
   参数精度和描述里的红线,不进目录长尾);dispatcher 服务端按真 schema 校验,**绝不
   成为闸旁路**。阿同的记忆/学习(MU 全套)与执行(governed tool-loop、工作流、
   ask_peer)零变化 —— 目录化只动「工具怎么呈现」,不动「工具是什么」。
3. **缓存前缀稳定**:会话内工具集静态 —— 两层化 ≠ 运行中动态装载 schema;NA-M1
   「轮内复用结构性保证」假设不破。长尾工具的知识以**工具结果**(会话消息)形式进
   上下文,用完即走,不碰稳定前缀。
4. **零中央节点 + 用户自持**(腿 C):不建身份锚点、不建恢复服务;档案交给用户自己
   保管;**带主钥档案必须显式确认**(沿用现有「档案即凭证」话术);知识卡静态策展、
   事实逐条核准(LSA-M3 纪律:**宁少列也核准** —— 卡里一条错命令是真伤害)。
   阿同只建议/提醒/指导,**授权动作(真打包、真改配置、真修复)人点**(与 LSA ③④
   重设计、C track「接入≠授权」同源)。
5. **内核零改动 + 零新 env 旋钮目标**:全部落 host / personal-butler / cli / llm 层
   (llm 层新件是 ComposedToolset 平级纯件,非内核);sweeper 节律、陈旧阈值走常量
   (镜像 TN-M2);打包档位 = 命令/工具参数,不是 env。

---

## 四、里程碑(逐个完成,每 M 一 commit)

### 腿 A — 工具面目录化

- **M1 度量先行**(承接 NA 推迟项「先度量后动」):纯函数盘点管家最终 toolset ——
  每工具 schema 字节/估 token、按模块归类、governed/benign 标注、(可得则)从近期
  transcript 抽调用频次;产出报告脚本挂 pnpm,把基线数字钉进本文档。
  **门** = 脚本可跑 + 基线落档;零行为改动。**分层阈值由这里的数据定,M0 不预判。**

  **✅ M1 已落(2026-07-15,`pnpm report:atong-toolface`)— 基线**:
  **35 工具 / 21,134 字节 / ~6,038 token**(CJK 感知估算:CJK≈1 token/字、其余≈4 字/token;
  MCP 连接器 `<server>__<tool>` 与 pool base 工具随部署变化按 0 计,装了只会更大 ——
  正落 NA-M0「~34+ 工具 6–10K token」区间下沿)。kind 小计:**benign 24 工具 ~3,790tk /
  governed 6 工具 ~1,197tk / memory 5 工具 ~1,051tk**。最重单工具:`set_daily_brief`
  ~383tk、`edit_agent` ~274tk、`create_workflow` ~273tk、`plan_workflow` ~232tk;
  最重模块:memory 5 工具 ~1,051tk(高频,必留一等)、task-notebook 4 工具 ~578tk。
  纯核 `packages/host/src/butler-toolface-report.ts`(M3 防腐门复用件)+ 报告测试
  `tests/butler-toolface-report.test.ts` 6 例含**防漂移 tripwire**:工厂 builder
  callsite 集合 ≡ 报告度量集合(± 显式排除的 `buildButlerMcpToolsets`),往工厂新增
  toolset 不登记进报告就红。transcript 调用频次:本地无有意义样本,如实跳过 ——
  M2 分层先按「一次性配置类 vs 常用类」的工具性质切,生产机可跑同一脚本复核。
- **M2 两层化纯核**(llm 层,ComposedToolset 兄弟):`list_tool_directory`(benign,
  渲染长尾目录:名字 + 一句话 + 紧凑参数说明)+ `use_tool(name, args)`(查表转发到
  真 toolset,**服务端按真 schema 校验**,校验失败的错误信息指回目录条目)。分层规则:
  高频核心 + **全部 governed** = 一等;低频 benign 长尾 = 目录。代价诚实:长尾工具
  多一跳(先查目录/直接 use_tool),低频天然摊薄。
  **门** = 单测:目录 ∪ 一等 = 今天全集(无静默丢)/ governed 全在一等 / 转发结果与
  直调逐字节一致 / 不启用两层化 = 字节不变。

  **✅ M2 已落(2026-07-15)— `packages/llm/src/two-tier-toolset.ts`**:`TwoTierToolset
  implements LlmAgentToolset`,构造项 `benignLongTail`(名字即红线:governed 永不进
  长尾,llm 层类型上挡不住,由 M3 装配处 + 防腐门钉死)。四个关键落法:①**快照静止**
  (首次 listTools 时快照长尾,此后目录/`use_tool` enum/路由表全静止 —— 边界③缓存
  前缀稳定;会动态长工具的 toolset 不适合进长尾,测试钉「事后长出的工具不可见」为
  设计而非缺陷);②**转发逐字节一致**(`hit.owner.callTool` 结果对象同引用返回、
  isError 原样、异常原样上抛,不包不改不 catch —— 边界②能力零阉割);③**礼貌校验
  fail-open**(只校验认识的关键字 type/required/properties/enum/items,不认识的特性
  一律放行 —— 绝不比一等暴露更严,参数权威永远是工具自身;校验失败回 isError 带该
  工具紧凑参数签名,不转发);④**runForTask 全转发**(reduceRight 镜像 ComposedToolset,
  依赖 per-task 作用域的长尾工具照常工作)+ 目录渲染 description **全文保留**(长尾
  工具的「何时调用/红线」都在里面,截断=丢红线)。冲突大声抛 `TwoTierToolNameCollisionError`
  (跨 child 重名 + 遮蔽保留名两路,保留名冲突以 childIndices 含 -1 标记)。
  **门已过**:15 单测(enum=全集无静默丢 / 转发同引用+isError+异常三态 / 快照静止 /
  冲突两路 / fail-open 放行 / runForTask 嵌套顺序 / 空长尾)+ llm 全套 260 绿 +
  typecheck 干净;不启用=没人构造它,字节不变按构造成立。旋钮 114 零新增。
- **M3 装配 + 防腐门**:factory 接线,按「零门槛默认发」法则(MU-M2 / NA-M1 先例)
  **默认启用**(行为不变、只有 schema 变少,无门槛;构造项保留一刀切回旧形态供测试,
  不是 env 旋钮);防腐门:每新增 butler 工具必须显式登记落一等或目录,漏登记就红
  (镜像 env-registry 门形状)。
  **门** = host 全绿 + 每轮 schema token 前后对比数字(目标幅度由 M1 基线定)。

  **✅ M3 已落(2026-07-15)— 数字:单层 35 工具 ~6,038tk → 两层 29 工具
  ~4,765tk,省 ~1,273tk(-21%);benign 面 3,790→~2,517tk(-34%)**(M1 同一把尺,
  单层数与基线逐字吻合=交叉验证)。**名单契约** `packages/host/src/butler-tool-tiers.ts`:
  一等 benign 16(高频核心 + 三类钉一等理由逐条记档:①每轮/每天在用[任务笔记本 4 件、
  set_reminder、观察三读、派活、跑流];②**被一等工具描述或探针卡点名**——`list_peers`
  ←ask_peer 描述 4 处、`plan_workflow`←create_workflow 描述、onboarding 两工具←开箱
  陪跑卡正文,模型会照名直调,不在脸上=指路指空;③发现门面 list_my_capabilities 不藏
  在发现背后)+ 目录 benign 8(diagnose_my_agents / list_my_llms / discover_llm_providers /
  consolidate_my_memory / set_reply_language / set_daily_brief / set_run_broadcast /
  show_my_memory —— 一次性配置/低频自省/按需诊断)。**工厂接线**:`benignFlat` 保持
  平铺全集(B1 能力清单的来源 —— 目录化只改 schema 呈现,不改「能干什么」),脸按
  名单折长尾进 TwoTierToolset;动态 toolset(pool base / MCP read)永远一等(边界③);
  `singleTierToolFace` 构造项=一刀切回旧形态(测试对照/回退用,**不是 env 旋钮**,
  main.ts 不设)。**防腐门** `tests/butler-tool-tiers.test.ts` 5 例全走**真工厂**:
  ①两层脸=一等名单+两把门,目录名单零上脸,governed 6+memory 5 全一等;②登记门=
  单层脸 benign 名字集合 ≡ 名单两表之并(双向,新增工具漏登记就红)+ 目录渲染真含
  全部 8 名;③**指路不指空**结构门=留在脸上的每个工具 schema 序列化不得点名任何
  目录工具(两把门除外)——将来谁把「先用 set_daily_brief」写进一等描述,门当场红;
  ④能力不减端到端=目录里的 set_reply_language 经 use_tool 真执行真落盘 + B1 能力
  清单两层/单层**逐字节一致**(B1 是策展话术目录,等价断言比找原始名更强);⑤token
  账本打印前后对比。验收:host 2106 全绿(TN 接线/B1/M1 tripwire 零涟漪)+ typecheck
  干净 + 四门 PASS(旋钮 114 零新增,main.ts 3000/3000 零触碰)。

### 腿 B — 随身向导+医生

- **M4 `gotong_guide(topic)` + 首批知识卡**:**一个** benign 工具(不是 N 个 ——
  30+ 工具再加十个伤选工具准确率;无参调用 = 返回目录页,模型不加载全量也知道有什么)。
  首批卡 ≈ 6–10 张、每张 ≤500 token:备份分档怎么选 / 恢复演练步骤 / 常见错误 top-N
  (工作流 failed / 连接器挂 / LLM 断供 / peer 连不上)/ 框架概念图(agent·工作流·
  定时·连接器·联邦怎么组合)/ 接 IM 桥 / 策展一条联邦边。卡 = 手写常量随包出货。
  **门** = 防腐测试钉卡内命令与 env 名(镜像 LSA-M3 `EXPECTED_*`),命令对实仓核对。

  **✅ M4 已落(2026-07-16)— `packages/host/src/personal-butler-guide.ts`**:一个
  benign `gotong_guide(topic?)`,纯常量渲染零 surface 零依赖;无参/未知 topic=
  目录页(id+标题+一句话,模型不取整卡也知道有什么;拼错不炸轮诚实退目录)。
  **首批 9 张卡**(framework-map / backup / restore-drill / workflow-failed /
  connector-down / llm-outage / peer-offline / im-bridge / federation-edge),
  写前逐条核实仓:CLI 用法对 help 表(`gotong backup <space> <dir>
  [--include-master-key]`、`restore <tgz> --space <dir>`、`peer-card <url>`、
  `mint-peer-token --peer-id=…`)、IM 动词对 command-parser 的 case
  (bind/inbox/approve/deny)、env 对注册表、工具名对分层名单;backup 卡只写
  **今天的真话**(M6 分档落地后由 M6 更新卡,不预写未来命令)。每卡渲染尾固定
  「知识≠授权」红线;卡内点名目录工具一律带「经 use_tool」提示。**工具自身进
  目录长尾**(butler-tool-tiers.ts 登记 + factory longTail)——「第一个长尾租户」
  兑现:单层脸涨到 36 工具 ~6,220tk,**两层脸仍 29 工具 ~4,769tk(-23%)**,新
  说明书型工具的脸面成本 ≈ 只有 enum 一个词条。**防腐门**
  `tests/butler-guide.test.ts` 7 例:pins 正向核(command 文件存在/env 已登记/
  工具在已知集/动词是 parser case,且每条 pin 真出现在正文)+ **反向扫描**
  (正文任何 `gotong <子命令>`/`GOTONG_*` 字样必须被 pin —— 未核准的命令根本
  进不了卡)+ 每卡 ≤500 估 token(M1 同尺)+ 目录∪卡=全集 + 目录工具点名必带
  use_tool 提示 + 工具面三态。排错记:导出常量初名 `GOTONG_GUIDE_TOOL` 撞
  env-registry 门的 `GOTONG_*` 识别模式 → 改名 `BUTLER_GUIDE_TOOL`(教训:host
  层常量别用 GOTONG_ 前缀,那是 env 旋钮的保留字形)。验收:guide 7 + tiers 5 +
  toolface 6 全绿,host 2113 全绿,四门 PASS(旋钮 114 零新增)。
- **M5 面包屑接线**:BE-M5 运行播报 / CARE 断供卡 / 腿 C 备份提醒的尾部**静态附
  topic 指针**(「想要修法,问我 ×× 就行」)—— 下一轮模型天然知道拉哪张卡;热路径
  仍零 LLM(拼静态串不是决策)。
  **门** = 相关单测 + 播报文案含指针断言。
  **✅ 已落(2026-07-16)**。核心是把「指针不指空」做成**结构性**:
  `personal-butler-guide.ts` 新纯函数 `guideBreadcrumb(topic, lead?)`,topic 是
  **编译期字面量联合** `ButlerGuideTopic`(卡常量数组改 `as const satisfies` 派生,
  宽类型导出不动既有消费者)—— 卡改名/删卡,三个引用处 tsc 当场红,不靠人记得。
  面包屑机制想清楚了才接:播报走 IM 直推**不经对话轮**,模型下一轮看不到自己
  "说过"什么;真正的锚是**成员照抄问句**——问句(=卡标题)出现在成员自己的
  消息里,模型对目录即拉对卡。所以指针必须是自然问话,**绝不甩生工具名**
  (gotong_guide/use_tool 是模型的事,不是成员的话)。三处接线:①BE-M5
  `runBroadcastMessage` **仅失败分支**附 workflow-failed 指针(done/cancelled
  没有修法可指,不附——面包屑不是口头禅);②CARE-M2 `llmOutageAnnouncement`
  zh 尾附 llm-outage 指针且**诚实标「到时」**(断供期大脑拉不了卡——卡是工具,
  工具要大脑调,不许假装能答),en 附自然英语同义指路;③CARE-M6
  `outageEscalationCard` fact 尾附同卡指针标「恢复后」。恢复播报不附(没有
  修法可指)。腿 C 备份提醒的第三出口待 M7 sweeper 落地时用同一助手指
  backup 卡(机制本刀已就位)。**防腐门** `tests/butler-breadcrumbs.test.ts`
  4 例:问句=真实卡标题(从卡常量现查,查不到就地失败)/失败分支带指针而
  done/cancelled 不带/断供 zh 含「到时」en 含同义句、恢复播报不带/升级卡
  fact 含「恢复后」+指针;并断言面包屑文本永不含 gotong_guide/use_tool。
  既有三模块测试全是 toContain,尾部追加零破坏。验收:5 文件 63 例全绿,
  host 2117 全绿,typecheck 干净,四门 PASS(旋钮 114 零新增,main.ts
  3000/3000 零触碰——三出口全在既有模块内,无新装配)。

### 腿 C — 恢复兜底(零中央节点)

- **M6 分档打包纯核**:三档,复用 backup-core 不重造,cli 加档位参数 ——
  - **身份档**:签名钥(± 公开名片)。恢复「我还是我」(kid 不变,钉过你 kid 的
    peer 照认);小到可打印/二维码(演示后置)。泄露爆炸半径极小。
  - **身份+关系档**:+ `peers` **非密投影**导出(endpoint / pinned_kid / trust_tier,
    JSON)。**诚实边界:peer 令牌在金库 —— 不带主钥,恢复的是「认识谁」不是
    「连得上」,重连要对端 re-mint。** 这条边界必须印在档案清单里,不许含糊。
  - **搬家档**:全空间 + 主钥(= 现 `--include-master-key`),档案即凭证,警示照旧。
  **门** = cli 单测:三档内容清单钉死 / 身份档与关系档**绝不含**金库·主钥字节 /
  搬家档警示必现。
  **✅ 已落(2026-07-16)**。`gotong backup` 加 `--tier=identity|relations`
  (两种写法都收:`--tier=X` / `--tier X`);不带 --tier = 今天的全空间路径
  **逐字节不变**(清单不写 tier 字段,旧档案形状不动)。核心姿态是**白名单
  式过滤**:`isIdentityTierPath` 只放行三个 leaf 根文件(space.json /
  agent-card-signing.key / agent-card.json),`shouldSkipForStaging(rel, imk,
  tier)` 在 tier 存在时改走白名单 —— 新文件默认落保守侧,金库密文
  (identity.sqlite / secrets.enc.json)、主钥两代、会话文件**结构性**进不来;
  sqlite 快照阶梯在分档时整个不跑。`--tier` 与 `--include-master-key` 组合
  当场拒(子集档的全部意义就是不含钥)。**relations 档**:`SELECT * FROM
  peers` 经诚实阶梯读出(better-sqlite3 readonly → sqlite3 CLI `-json` →
  **exit 3 响亮失败**,投影是这档的主要载荷,静默降成身份档就是说谎;peers
  表不存在的极老库 = 真·零 peer 如实空投影),纯函数 `buildPeersProjection`
  **挑列不是滤列**(白名单只取 peer_id/endpoint_url/label/enabled/
  pinned_kid/trust_tier/outbound_caps_json 七列,vault_entry_id 连字段名都
  不出现在投影里;坏 JSON 列 fail-soft 成 null),产出
  `gotong-peers-projection.json` 落归档 leaf 根、进 sha256 清单。**诚实边界
  印进档案本体**:投影自带 note「令牌在金库,恢复的是『认识谁』不是『连得
  上』,重连需对端 re-mint」,不只印终端。没签名钥的空间照打包但响亮说明
  「没有密码学身份」(不假装)。收尾提示按档分支:子集档不再复述全档的
  「密文要另存主钥解」故事,并提醒**恢复进全新目录、别 --force 盖全空间**。
  同刀兑现 M4 承诺:backup 向导卡补三档真话(令牌不随档红线进卡),过
  ≤500 token + 反向扫描门。**防腐门** `packages/cli/tests/backup-tiers.test.ts`
  10 例:两档内容清单 `toEqual` 钉死(恰好 N 个文件,一个不多)/ 解出的
  **每个文件逐一扫五个哨兵串**(主钥两代/金库密文/vault 指针/会话 sid)/
  投影字段与 fail-soft / 阶梯两级 + 全挂 exit 3 不留半截归档 / 组合与非法
  档位拒 / 子集档 restore 进全新目录清单闭环 / 纯核直测(shouldSkip 缺省
  语义不变 + 老库缺列 + parseManifest tier 校验)。验收:cli 279(269→+10)
  全绿,host 向导门 18 例全绿,typecheck 干净,四门 PASS(**--tier 是 CLI
  参数不是 env 旋钮,114 零新增**;main.ts 3000/3000 零触碰)。
- **M7 阿同层**:benign `backup_status`(只读:上次备份时间 / 之后新增 peer·agent 数 /
  陈旧度)+ **真打包走 governed park**(产出凭证类档案 = 人点头才执行);陈旧提醒
  sweeper(镜像 TN-M2 形状:常量节律、只写自己的 fact 文件、送达才记标记),文案带
  M5 面包屑指向「备份怎么选档」卡。
  **门** = 单测:批准前零打包 / sweeper 冷却往返(注入时钟)/ 提醒文案含面包屑。
- **M8 capstone `examples/atong-recovery`** + 收口:确定性、零 LLM 零 key ——
  打包三档 → 新空间恢复 → 断言 kid 不变 / peers 行还在 / 身份档不含密 / 搬家档全量
  开机;`pnpm demo:atong-recovery` exit 0。+ 文档收口 + CLAUDE.md 账本 + 四门。

---

## 五、显式不做(边界外,记录在案)

- **按消息内容动态选工具集** —— 热路径决策,撞边界①;两层静态结构已拿走大头收益。
- **中央身份锚点 / 邮箱恢复** —— 本轮辩论已裁决(§一)。将来真要做,必须同时满足
  「背书非拥有 + 可自建可多实例 + 多因素时延否决」四不变量,且另起 track 重审。
- **监护人 / 社交恢复(M-of-N)** —— 远期档(它解「档案也丢了」的残余场景),等真实
  需求;本 track 只做用户自持档案。
- **把 docs/zh 原文喂给阿同** —— 卡是策展物,不是文档搬运;生产机也没有仓库文档。
- **医生自动执行修复** —— 诊断 + 指路;动手仍走 steward / governed 既有闸,向导不是
  特权。
- **换址再宣告**(换主机后通知 peer 更新 endpoint 的流程)—— 真实缺口,如实记,
  另起不塞本 track(它是联邦侧协议活,与本 track 的「用户自持档案」正交)。
- **on-demand 联邦连接态 / 非权威目录站** —— 同一轮对话聊过的联邦演进方向
  (`connection_mode` 第三态、发现≠信任的目录站),是**联邦 track 的活**,不塞这里。

---

## 六、验收纪律

- **逐个完成**(用户长期指令):每 M 独立 commit,全绿才走下一个。
- 四门 PASS:`pnpm check:guards`(kernel-deps 方向 / env 旋钮注册零新增目标 /
  line-budget 棘轮)+ 相关包 vitest 全绿。
- capstone `exit 0` = 冒烟门;动 web 面的里程碑才做真浏览器 round-trip。
- 顺序建议:**A(M1→M3)→ B(M4→M5)→ C(M6→M8)** —— A 先落是因为 B 的
  `gotong_guide` 恰好是「长尾 benign 工具」的第一个新住户,目录化先就位,B 天然长在
  正确的位置上;C 的 M7 文案又引用 B 的面包屑。三腿如需并行推进,以边界不冲突为准。
