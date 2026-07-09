# 2026-07 战略盘点：市场再核 · 管家异同 · 未来框架 · 基础设施路径

> 调研日期 **2026-07-09**。方法：5 路并行研究代理（①多 agent/多人协作网络格局 ②互操作
> 标准现状 ③主流个人管家横评 ④开源基础设施成长路径 ⑤中国生态），合计约 190 次
> 检索/抓取，事实均为当日核实；标注惯例：**【证实】**=一手/多源印证，**【推断】**=基于
> 证据的判断。
>
> 本文是 [`COMPETITIVE-LANDSCAPE.md`](COMPETITIVE-LANDSCAPE.md)（2026-05-29 赛道地图）与
> [`PRODUCT-MATRIX.md`](PRODUCT-MATRIX.md)（2026-06-21 产品矩阵）的 **7 月增量再核 + 战略
> 合成**；结论冲突时以本篇为准，那两篇的分析框架仍有效。
>
> 触发：用户四问——①市面有没有同类（标准化可扩展的多 agent 多人实际协作网络）？
> ②管家智能体与主流异同？③面向未来的社会协作框架应长什么样？④本项目能否发展为
> 开源基础设施、往哪个方向走？

---

## 一、市面扫描：四角有人，中心无人

### 1.1 全球四集群（2026-07 实况）

| 集群 | 代表 | 实况【证实】 | 结构性缺口 |
|---|---|---|---|
| **企业 agent 平台** | Microsoft（Copilot Studio + Agent 365 + Entra Agent ID GA）、Google Gemini Enterprise（Agentspace 已并入）、AWS AgentCore（Policy/Harness 2026 GA）、Salesforce Agentforce、ServiceNow、OpenAI Frontier（2026-02 新入局，HP/Intuit/Oracle 首批） | 采用真实：Agentforce+Data 360 ARR 近 $1.4B（+114%）、29,000+ 客户；Entra Agent ID 2026-04 GA | 全是**租户墙内花园**——SaaS、单组织；人类=管理员/审批 UI，不是协议内对等参与者 |
| **开源开发框架** | LangGraph/LangChain 1.0、CrewAI（47.8k★）、MS Agent Framework 1.0 GA（AutoGen+SK 合并）、AgentScope 2.0、OpenAI Agents SDK、n8n（SAP 战投后 $5.2B 估值）、Dify（148k★、$30M Pre-A） | HITL 审批已成框架标配（EU AI Act 2026-08-02 第 14 条强制人类监督在推动） | 全是**库不是网络**——人是 interrupt 回调；无常驻多人多 agent 协作底座 |
| **「agent 互联网」** | A2A（LF，150+ 组织）、AGNTCY（65+ 公司）、MIT NANDA（研究）、Coral、Fetch.ai/Olas/Virtuals（币圈）、Moltbook（纯 agent 社交，被 Meta 收购，注册数严重掺水） | 标准层真实收敛；网络层要么研究、要么代币经济（人=持币者非协作者） | 做的是「电话簿和电话线」，**不是节点本身** |
| **个人主权 hub** | OpenClaw（**382k★**，GitHub 史上最快登顶；基金会接管但治理文件至 4 月中未公布）、Hermes Agent（Nous，~200k★、9 万技能） | 品类爆发，「自托管管家」完成用户教育 | **明文单用户设计**——多用户 RBAC 是开放 issue（openclaw#8081）；无联邦、无成员治理 |

联邦胚胎仅两个：**MindRoom**（agent 原生活在 Matrix 联邦房间、人机混居——理念最接近本项目，
但 1 个开发者、约 100 试用者、无审批闸无能力策展、未用 MCP/A2A）；**crosscast**（NATS mesh
跨组织 agent 通信，0★ 概念验证）。

### 1.2 中国生态：同一个空位，另一套结构

- **超级 App 闭环 vs 协议互操作**：入口由微信/支付宝/钉钉/飞书/手机 OS 控制。但 2026 上半年
  历史性开门：**微信 iLink/ClawBot（2026-03，十余年来首个官方个人号 Bot API**，标准 HTTP/JSON、
  官方条款、定位纯消息通道不代操作账号）+ **微信×华为/荣耀/小米/OPPO/vivo 用 A2A 打通**
  （2026-06，荣耀 YOYO 首个量产）。
- **国家队定标准**：2026-06 三部委《人工智能 智能体互联》**8 项国标（AIP 协议，GB/Z 185-2026）**
  ——身份编码、能力发现、互联协作、**结算、审计**，100+ 企业试点、有开源参考实现。这几乎是
  本项目联邦层关心问题的「国家版清单」。监管面：《智能体实施意见》（2026-05）抓手在开发/分发
  平台，**个人自托管处于「低风险自律」区间**。
- **「Claw 家族」现象**：腾讯 QClaw、字节 ArkClaw、月暗 KimiClaw、智谱 AutoClaw、阿里 QwenPaw……
  全部**闭源**收割「数据不出本机」需求（QClaw 主打卖点正是本地主权）——证明该需求在中国消费
  市场真实成立，而开源自托管空间留给了 OpenClaw/AstrBot（28.4k★，中国原创多平台 bot）。
- **「龙虾经济」**：OpenClaw 场景 token 消耗为 OpenRouter 第二名的 3.6 倍，消耗榜前三全是中国
  模型；智谱 39 元/月「龙虾套餐」、MiMo 百万亿 token 计划——**智能体运行成本曲线由多厂商价格战
  决定**（对确定性模型路由 = 直接红利）。
- **同位者**：没有。multica（39.6k★，人机混合团队看板）限 coding 场景；Coze 2.5「Agent World」
  （agent 数字身份 + 跨 agent 社交）愿景最像但是**平台全托管闭环**，与自托管正相反。

### 1.3 裁决

对四判据逐项核对 30+ 玩家：(a) 自持个人 hub——OpenClaw/Hermes 等有人做；(b) hub 间联邦 +
能力策展——**无人完整做到**；(c) 人与 agent 同为协议参与者——**无人做到**（A2A 协议本身没有
「人类参与者」实体；企业平台人=审批 UI、框架人=interrupt）；(d) 真实世界动作的治理审批闸——
企业侧有、个人侧几乎无（Hermes Tool Guard 最接近，仍是单主人会话级）。

> **四项合一者在全球与中国都不存在。** 这把本仓库 2026-05-29 的判断（「没有任何单一竞品同时
> 具备四根支柱」）用 7 月数据重新验证了一遍，且当时没有的新玩家（OpenAI Frontier、Coze 2.5
> Agent World、CHAP 草案）依然没有站进那个格子。

---

## 二、管家智能体 vs 主流：异同

### 2.1 已收敛的基线（我们同步、且多项独立走到同一答案）

1. **file-first Markdown 记忆 + 睡眠期整理**——OpenClaw（`MEMORY.md` + Dreaming）与本项目
   双时态 + 6h 维护**同构**；MU track 的「骨架已赌对」再次证实。
2. **MCP 作为工具总线**——ChatGPT Apps SDK 直接建在 MCP 上、Claude 554 连接器、Hermes 原生
   client、OpenClaw 兼容。
3. **多渠道 IM 桥**（OpenClaw 23 条 / Hermes 17 条 / 本项目 6 条——原始广度不是护城河，带治理
   的桥才是）。
4. **显式排程赢了黑箱推送**——**ChatGPT Pulse（主动推送晨报）2026 年中被砍**，迁到 Scheduled
   Tasks。本项目「零 LLM 定时工作流 + 成员闸派发」路线被 OpenAI 亲手背书。
5. **模型降级链**是开源侧标配（OpenClaw fallbacks + 冷却探针、Hermes fallback_providers +
   Pareto Router）——MR track（2026-07-09 收口）与之对齐且熔断 + 手动逐候选探针更完整；
   Hermes 硬拒 <64K 上下文模型，本项目反向面向弱模型稳定性设计（任务笔记本 + 复述）。

### 2.2 逐项核实后仍然稀缺的差异

| 差异点 | 市场现状【证实】 | 判定 |
|---|---|---|
| **服务端权威审批闸 + 可落盘恢复的停靠任务**（park→/me→批准续跑，重启幸存、可换人批） | 云厂=会话内弹窗（Claude 跨端送达是最近似形态，仍是活会话提示）；OpenClaw=per-exec 拦截 + main 会话默认全权 + 官方 YOLO 模式 | **稀缺，成立** |
| **多成员治理**（成员身份/角色/各自审批收件箱/RBAC） | OpenClaw 官方立场「为恰好一个用户设计」（RBAC=开放 issue #8081）；Hermes 单操作者；Alexa+ 只有消费级声纹档案 | **稀缺，成立** |
| **确定性零 LLM 主动调度** | OpenClaw heartbeat **每跳都是 LLM 轮**（文档自承 token 成本）；唯 Home Assistant 本地意图引擎同思想（仅限家居命令） | **稀缺，成立** |
| **管家出网过治理闸**（ask_peer 跨 hub + 成员/owner 双闸） | 无人做——单人管家没有「代表我跟别的组织打交道」的概念 | **独有** |
| file-first 状态 | ⚠️ **记忆文件已不再独有**（OpenClaw 就是纯 Markdown 无隐藏状态） | **诚实收窄**：差异点=「**整 hub 可搬**」（含多成员记录/审计/凭证 vault），非记忆文件本身 |
| **默认安全姿态** | OpenClaw 2026 上半年安全危机：CVE-2026-25253、最高 13.5 万暴露实例、ClawHub 供应链投毒（1,184 恶意技能 24.7 万次安装、$2.3M 被盗）、Meta 等企业明令封禁 | 事实上的强差异化——事故替「**带治理的**自托管」完成了需求教育 |

**一句话**：管家的「助理功能面」与主流已收敛（不落后），差异全部集中在「治理面」——而治理面
恰好是市场空位本身。

### 2.3 最大引力威胁

**OpenClaw**（382k★、OpenAI 出资赞助基金会、AWS Lightsail 一键部署、官方支持微信/QQ/飞书）。
若其基金会治理落定并补上多用户 + A2A，品类心智会被瞬间吸走。对策不是比规模，而是占稳
「治理 + 多成员 + 联邦」组合位——并保留互操作可能（OpenClaw 可以作为一个 Participant 接进
Gotong hub，正如 cli-agent/acp-agent 适配器先例）。

---

## 三、面向未来的社会协作框架——八条性质（每条带 2026 证据）

1. **节点归人，不归平台**。EU AI Act 2026-08-02 全面执法、主权云市场 $1953 亿、61% 西欧 CIO
   优先本地化、QClaw 拿「数据不出本机」当主打卖点、73.8% 职场 ChatGPT 是个人账号（影子使用）
   ——主权不是怀旧，是合规刚需 + 消费共识。
2. **人和 agent 是同一种协议公民**。全市场最深的结构性缺失：企业平台把人建模成审批 UI、框架
   把人建模成 interrupt、A2A 没有人类实体。2026-06 出现的 **CHAP 协议草案**（arXiv:2606.09751，
   「MCP 管 agent-工具、A2A 管 agent-agent，没有协议标准化人与 agent 共同完成可问责工作」）
   几乎是本项目 `Participant` 立场的学术孪生——同时也是窗口收窄的信号。
3. **授权链是一等公民**。「用户→管家→对端组织的 agent→其工具」的跨域委托链（权限随链衰减、
   审计、问责）**被证实为全行业最大未解缺口**：AAIF 把 Identity & Trust 列为七工作组之首、
   IETF 三线草案（identity-chaining / identity-assertion-authz-grant / WIMSE）零 RFC、已发货
   的 Entra Agent ID 与 Okta XAA 全部**不跨信任域**。标准真空期内，「显式 PIN + 人在环审批 +
   双 hub 各自持凭证」就是业界最佳实践本身。
4. **控制面确定性，智能在边缘**。Pulse 之死、OpenClaw 心跳烧 token、Home Assistant「prefer
   handling commands locally」三个独立证据同向：调度/路由/健康/提醒必须零 LLM；模型只在
   参与者边缘说话。
5. **边界讲开放标准，屋内保持主权**。MCP（工具，注意 2026-07-28 新版转无状态核、Roots/Sampling/
   Logging 进弃用）+ A2A v1.0.x（agent 间；OpenAI 与 Anthropic 缺席是最大阵营分界）+ OAuth
   （现实服务）+ JWS/JWKS（身份完整性）。**工作流定义层被证实不会收敛**（无跨厂商规范、AAIF
   工作组 2026 Q1 才立）——自有 YAML 不违背任何趋势，出入口对齐任务语义即可。
6. **状态是可搬走的文件**。LangChain 教训：框架无护城河，**运行时状态才是**（其收入全靠闭源
   LangSmith）。对协作底座，等价物=transcript/审计/治理记录。「复制目录=搬走房间」既是产品
   性质也是防锁定承诺。
7. **信任靠显式锚点，不靠中央目录**。注册表大战（MCP Registry/AWS Agent Registry/ARD/NANDA/
   AIP 注册平台）是巨头游戏；节点侧只需「验签 + PIN + owner 亲手策展边」。发现≠信任。
8. **对模型价格战开放**。中国「龙虾经济」意味着 agent 成本曲线由多厂商竞争决定——确定性
   fallback 链（MR track）让框架直接吃下这条曲线，不押注任何单一厂商。

> 这八条里，1/2/4/5/6/7/8 已是本项目代码，3 已做缺口正确一侧的保守实现。**宪章 2026 年初写下
> 的立场，正在被 2026 年中的市场逐条验证。**

---

## 四、基础设施路径

### 4.1 「热门项目 vs 基础设施」九判据体检

判据源自案例机制提炼（Kubernetes/CNCF、Matrix 资金危机、Home Assistant/Open Home Foundation、
n8n fair-code、Ollama/vLLM、LangChain、RethinkDB 之死、Redis→Valkey 分叉终局）：

| # | 判据 | Gotong 现状 |
|---|---|---|
| 1 | 杀手楔子场景 | ⚠️ 有但未命名——**OpenClaw issue #8081 已替我们写好**：「给家人不同权限、凭证互不可见、对外动作要有人批」；单用户架构做这个要推倒重来，恰是本项目既有骨架 |
| 2 | 核心小 + 扩展点 | ✅ 内核 11% 零依赖、Participant 唯一扩展面、连接器全走 MCP（免费继承别人花钱养的生态） |
| 3 | 标准对齐 | ✅ 且领先——A2A v1.0 签名名片属公网**最早一批实现**（研究确认「规范就绪、公网真实签名卡极少」） |
| 4 | 许可规则恒定 | ✅ 已开源；需补一句「永不改证」显式承诺（n8n 教训：规则不变 > 更开放；Redis 反悔→Valkey 分叉进发行版默认） |
| 5 | 第三方生产部署 | ❌ **0 个非作者部署**——与基础设施之间最大的一段距离 |
| 6 | Bus factor | ❌ =1（对照 RethinkDB 之死；OpenClaw 创始人离场后基金会治理文件至今未公布） |
| 7 | 安全审计 | ⚠️ 有内部审计纪律（`audits/`），无第三方审计——OpenClaw 危机证明该品类用户会拿放大镜看 |
| 8 | 资金模型 | ❌ 无（Matrix 教训：写出最好的 spec，12 年后为 10 万美元求生；Automattic 一家占其收入 50%） |
| 9 | 中立治理 | ⚠️ GOVERNANCE.md 框架在，无真实多方 |

**结论：架构资本充足且稀缺（判据 1-4 强），社会资本几乎为零（判据 5-9 弱）。** 这个组合比
反过来好——架构是最难补的。

### 4.2 窗口判断

空位是真的，但**窗口估计 12–24 个月**：CHAP 已在为同一空白写 spec、Google 牵头 ARD 草案
（Microsoft/Cisco/GitHub/HF/Nvidia 参与）、AIP 国标带参考实现、OpenClaw 基金会一旦补上多用户，
品类心智被瞬间吸走。

### 4.3 路径裁决：产品先行，标准为姿态，生态为放大器

- **① 协议先行 = 对 solo 开发者已被证伪**。协议赢家（MCP/A2A/K8s API）背后全站着有分发权的
  巨头；没有分发权的 spec 先行者下场是 Matrix。现行做法已是正确姿态：**消费标准、对齐标准、
  让联邦层「可以在需要时被抽成 spec」，但绝不先卖 spec**。
- **② 产品先行（主轴）**。Home Assistant 是本利基唯一完整成功先例，初始条件几乎一致（单人
  起步、本地优先身份认同、杀手楔子是云厂商无法提供的东西）。机制链条**顺序不可颠倒**：
  杀手场景 → 部署基数 → 订阅收入 → 基金会 → 标准影响力。北极星指标=**第 100 个非作者部署**
  ——分界不在 star 数，而在陌生人敢把真实家庭数据放进 `.gotong/` 并复制着搬家。
- **③ 生态先行 = ② 的飞轮部件**。无安装基数的 marketplace 是鬼城；模板画廊/一键装是转化率
  放大器（Home Assistant Blueprints 机制），不是独立战略。

### 4.4 面向华人市场的三个缝

1. **微信 iLink 桥**（详见 §五方向 A）——十余年来首条合法个人微信通道，且「只做消息通道、
   不代操作账号」红线与「接入≠授权行动」立场天然同构。
2. **连接器目录中国版**——ModelScope MCP 广场 2900+ 服务是现成策展来源（高德/支付宝/12306 类），
   接入成本≈目录条目（C-M1 同款玩法）。
3. **AIP 国标对齐 = STD track 第二章**（详见 §五方向 C）——AIP 六大问题与既有联邦设计逐项
   对应；模型层国产 fallback 候选链 MR track 已提前造好。

---

## 五、下一步方向候选（细化规划，待用户拍板）

### 方向 A：微信 iLink 桥（第 7 座桥）——工程量最小、传播杠杆最大

**为什么**：华人个人用户的默认 IM 是微信，不是现有 6 桥中任何一个；且方向 B 的目标家庭
也都在微信上——A 是 B 的前置渠道。iLink 是官方通道（有《微信 ClawBot 功能使用条款》背书），
终结十几年 hook/iPad 协议灰产的封号风险。

| 里程碑 | 内容 | 交付门 |
|---|---|---|
| **WX-M0 侦察 + 计划**（0.5-1 天） | 对官方文档逐字核 iLink API 面（鉴权流/消息类型/限速/条款红线）；**核清马来西亚 WeChat（海外版）账号能否用 iLink**（研究只证实大陆微信）；参考独立协议实现 x1ah/wechat-ilink-demo；定包形 `packages/im-wechat` | 计划文档 + 岔口（若有）摆给用户 |
| **WX-M1 协议纯核**（1 天） | iLink client（HTTP/JSON）+ 入站消息解析成 im-adapter SDK 形状；wire fixture 单测，零真实凭证 | 单测全绿 |
| **WX-M2 桥接入**（1-1.5 天） | `packages/im-wechat` 实现 ImBridge（镜像 im-qq/im-telegram）；凭证走 vault/env 双源；A4 渠道感知自动覆盖 `im:wechat`；outbox/pushToMember 复用 | host 全绿；未配=字节不变 |
| **WX-M3 真机验证 + runbook**（1 天） | 真实账号 round-trip（**需要你提供一个微信号**）；GO-LIVE 加节；显式边界钉死（纯消息通道、写操作照过 governed 闸） | 真机收发 + 管家对话成功 |

**边界**：新包零内核改动；iLink「不代操作账号」红线=我们本来的立场。
**风险**：iLink 对海外 WeChat 账号的可用性未证实（M0 首要核点）；腾讯条款单方变动。
**总工作量**：约 3.5-4.5 天。

### 方向 B：家庭 hub 垂直（产品先行主轴）——对准 12-24 个月窗口

**为什么**：§4.3 的裁决主轴。杀手场景已被 OpenClaw 用户亲口说出（#8081）；家庭学习 hub
设计（FAMILY-LEARNING-HUB-DESIGN/GO-LIVE）+ 模板 bundle + cloud-quickstart + 便携包全部
已有，缺的是「把它们串成一个非技术家长 15 分钟能跑通的垂直产品」。

| 里程碑 | 内容 | 交付门 |
|---|---|---|
| **FAM-M0 杀手场景钉死**（0.5 天） | 把「家人不同权限/凭证互不可见/对外动作有人批」翻成一页首屏叙事；定义「开箱 15 分钟」验收（对照 FUN TTFR 门的家庭版） | 叙事页 + 验收标准 |
| **FAM-M1 家庭模板 bundle**（1-2 天） | templates/bundles 一键装：管家 + 晨报 schedule + 审批闸演示 + 2-3 个生活连接器槽位（天气/日历/待办）；golden-run 验收（FDE-M2 机制现成） | `pnpm` 一条命令装完 + golden-run 绿 |
| **FAM-M2 部署摩擦清零**（1-2 天） | cloud-quickstart + 便携包按「非技术家长」视角重测；中文 onboarding 精修；瞄准「第 1-3 个非作者部署」（**需要你找 1-3 个亲友家庭试点**） | 一个真实外部家庭跑通 |
| **FAM-M3 信任基建**（1-2 天） | 威胁模型页 + 许可恒定声明（判据 4/7 补课）+ backup/restore 家庭演练文档 + npm provenance 签名调研——家庭敢托付凭证的前提 | 文档 + 承诺落 repo |
| **FAM-M4 传播面**（1 天） | README/OVERVIEW 首屏加「家庭/小单位」入口叙事（GOTONG_PROFILE 机制现成）；Discussions 开「部署展示」板；自愿登记式部署计数（主权立场：绝不遥测） | 首屏改版 + 板块开张 |

**边界**：几乎全是 docs/templates/ops 层，内核零改动。
**风险**：这是运营+产品活，北极星（第 100 个部署）不由代码决定——需要你参与找试点、收反馈。
**总工作量**：首轮 M0-M4 约 5-8 天，之后转入持续迭代。

### 方向 C：AIP 国标对齐侦察（STD track 第二章前置）——成本最低、紧迫最低

**为什么**：AIP（GB/Z 185-2026）的六大问题（可信接入/身份/发现/协作/结算/审计）与既有联邦
原语逐项对应，opt-in 对齐是面向中国市场的标准期权；但国标 6 月才发布、试点刚启动，**可以等
半年看落地再动**——先侦察把地形摸清，代价极小。

| 里程碑 | 内容 | 交付门 |
|---|---|---|
| **AIP-M0 一手资料**（1-2 天） | 获取全 8 份 GB/Z 185-2026 文件 + AIP 开源参考实现；逐份读身份编码/描述发现/交互/工具调用章节；输出差距矩阵（AIP 概念 ↔ Gotong 原语：peerToken/名片/能力白名单/transcript 审计） | 差距矩阵文档 |
| **AIP-M1 岔口报告**（0.5 天） | 三分类：opt-in 可对齐（身份编码格式/描述字段映射）/ 违反边界（结算层=宪章不做、中心注册 vs 发现≠信任）/ 可 leapfrog；按 4.4 摆选项等拍板是否开 STD-M3 | 岔口摆给用户 |

**风险**：国标全文获取渠道（GB/Z 指导性文件通常公开，但可能要注册）；AIP 实际采用度未知。
**总工作量**：约 1.5-2.5 天，纯侦察零代码。

### 推荐序

**先 A 后 B**：A 小而快（约 4 天）且是 B 的前置渠道（目标家庭在微信上）；B 是战略主轴持续推进；
C 后置（半年内找个空档做侦察即可）。

---

## 六、不做什么（负面清单，与宪章一致）

- **不进 spec 军备竞赛**（CHAP/ARD/AIP 各写各的，我们做「可以被抽成 spec 的实现」）；
- **不做代币/结算层**（x402 被核出日真实量仅 ~$2.8 万、刷量三个数量级；Stripe/OpenAI 的
  chat 内结账已被亲手证伪一次）；
- **不变成托管 SaaS**（主权是护城河；控制面只观察不接管——宪章 §8）；
- **不追自主 agent 炫技**（Moltbook 140 万 agent 里 50 万是一个人注册的，终局是被收购的
  注意力生意）。

---

## 七、岔口登记（待用户拍板）

1. **管家命名**（品牌/传播层，代码标识符不改）：候选 Royong（gotong-royong 的另一半，框架与
   管家合成完整的「互助」，重名碰撞近乎零，中文昵称可作「阿融」）/ Wakil（马来语/阿拉伯语
   「受托代理人」，土耳其语 vekil 同根，语义最准但在马来语市场是常用名词）/ Atong·阿同（华人
   市场最亲切，全球传播力弱）。
2. **可持续性收入**（判据 8 的解药）：Home Assistant 的 Nabu Casa 模式=商业实体卖「与主权
   立场兼容的便利服务」（托管联邦中继/异地备份/远程访问订阅），利润供养项目。宪章 §7「没有钱、
   没有币」针对的是**贡献激励层**，与项目可持续性收入不是同一件事——但这是宪章级边界，
   属 owner 决定；Matrix 的教训是这一步不能永远等「以后」。

---

## 八、总结一句话

市场用 2026 上半年验证了 Gotong 的全部架构赌注（file-first、零 LLM 控制面、显式排程、审批闸、
标准对齐、弱模型稳定），而它押注的组合位——**主权 hub × 联邦 × 人机同权 × 治理闸**——全球和
中国都还空着；差距不在架构（最强项）在社会资本（部署数/bus factor/审计/资金）；窗口 12–24
个月；最佳路径是 Home Assistant 式「家庭/小单位垂直产品先行」，微信 iLink 桥与 AIP 对齐是
面向华人市场的最短杠杆。

---

## 附录：关键来源（按主题，检索/抓取日 2026-07-09）

**协作网络格局**
- OpenAI Frontier：openai.com/index/introducing-openai-frontier/（2026-02-05）
- Agentforce ARR：salesforceben.com/agentforce-customers-are-doubling-down-60-of-q4-bookings-came-from-expansions/
- Copilot Studio A2A/CUA GA：microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/（2026-05）
- AWS AgentCore Harness GA：aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-harness-generally-available/
- MS Agent Framework 1.0：devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/（2026-04-03）
- n8n $5.2B：bloomberg.com/news/articles/2026-05-12/sap-invests-in-ai-automation-startup-n8n-at-5-2-billion-value
- MindRoom：nijho.lt/post/mindroom/ · crosscast：github.com/crosscast/crosscast
- Moltbook 被 Meta 收购：axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network

**标准**
- MCP 2026-07-28 RC（无状态核/Extensions/弃用政策）：blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- MCP 捐 AAIF：anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation（2025-12-09）
- AAIF 七工作组（Identity & Trust 居首）：aaif.io/working-groups/
- A2A v1.0.0（2026-03-12）/v1.0.1：github.com/a2aproject/A2A/releases · 150+ 组织：linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations…（2026-04-09）
- 跨域委托缺口（IETF 草案群）：datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/ · draft-ni-wimse-ai-agent-identity · NIST NCCoE 2026-02 概念文件
- CHAP 草案：arxiv.org/html/2606.09751（2026-06）
- x402 真实量核账：coindesk.com/markets/2026/03/11/…-demand-is-just-not-there-yet · OpenAI 结账撤退：forbes.com/sites/jasongoldberg/2026/03/10/

**管家横评**
- OpenClaw：github.com/openclaw/openclaw（382k★）· 多用户 RBAC issue：github.com/openclaw/openclaw/issues/8081 · exec-approvals/memory/model-failover：docs.openclaw.ai
- OpenClaw 安全危机：unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/ · esecurityplanet.com（341 恶意技能）· microsoft.com/en-us/security/blog/2026/02/19/（身份隔离指引）
- Hermes Agent：hermes-agent.nousresearch.com/docs/ · fallback-providers 同站
- Pulse 之死→Scheduled Tasks：techjacksolutions.com/ai-brief/agentic-ai-news-openai-launches-scheduled-tasks…
- Claude in Chrome 双模式/跨端审批：support.claude.com/en/articles/12902446
- Home Assistant 零 LLM 意图引擎：home-assistant.io/blog/2025/09/11/ai-in-home-assistant/
- Vitalik 主权 LLM 指南：vitalik.eth.limo/general/2026/04/02/secure_llms.html

**基础设施路径**
- Matrix 2026 年报（Automattic 占收入 50%）：matrix.org/blog/2026/03/annual-report/ · 危机：matrix.org/blog/2025/02/crossroads/
- Open Home Foundation（200 万家庭/70 全职）：openhomefoundation.org/blog/building-whats-next-state-of-the-open-home-2026/
- RethinkDB postmortem：github.com/coffeemug/defstartup/…why-rethinkdb-failed.md
- Redis→Valkey 终局：buildmvpfast.com/blog/valkey-vs-redis-open-source-fork-migration-2026
- LangChain $1.25B（收入=闭源 LangSmith）：techcrunch.com/2025/10/21/…langchain-hits-1-25b-valuation/
- EU 主权栈：techplustrends.com/eu-sovereign-ai-infrastructure-stack-2026-guide/

**中国生态**
- 微信 iLink/ClawBot 协议拆解：cnblogs.com/informatics/p/19751397 · bytenote.net/article/wechat-ilink-bot-api · 独立 demo：github.com/x1ah/wechat-ilink-demo
- 微信×手机厂商 A2A：guancha.cn/economy/2026_06_04_819388.shtml（2026-06-04）
- AIP 八项国标：stdaily.com/web/gdxw/2026-06/09/content_529630.html · legaldaily.com.cn/index/content/2026-07/03/content_9417460.html
- 《智能体实施意见》：cac.gov.cn/2026-05/08/c_1779979789523320.htm
- 龙虾经济/国产模型霸榜：qbitai.com/2026/03/386183.html · 36kr.com/p/3701403165487494
- QClaw（本地数据主权卖点）：qclaw.qq.com/docs/205521621464268800.html
- Coze 2.5 Agent World：news.qq.com/rain/a/20260407A031A800 · AstrBot：github.com/AstrBotDevs/AstrBot · multica：github.com/multica-ai/multica
- ModelScope MCP 广场（2900+）：modelscope.cn/mcp · 支付宝 MCP：qbitai.com/2025/04/274863.html
