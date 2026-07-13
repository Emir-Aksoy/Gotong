# GT — 分级信任(Graded Trust)

> **文档地位**:M0 计划文档(计划 + 侦察实录 + 决策固化 + 落地路线)。
> 本文是 GT track 的北极星,写码前先读它。
> **写于** 2026-07-13　**状态** 计划待审(方案门)→ 用户拍板后进 M1

---

## 一、这个 track 要解决什么(北极星定位)

北极星第 3 层「框架 = 清晰 + 稳定 + **适配**」里,"适配 = 跟得上 AI 发展"的最实抓手,
就是把 hub 对外的**信任表面**从"能连 / 不能连"的二元,升级成一条**安全性逐步提高、
易用性相对逐步降低的连续阶梯**。

用户的原话(2026-07-13):

> "探索下我们的跨 hub 协议,我希望它不仅是标准化的,而且可以是多层级的,不一定
> 每一级都要相同的安全标准,应该分为几级,安全性逐步提高,易用性相对就逐步降低。
> 从这个角度研究我们的协议,再深度思考未来 agent 和人之间的网络的实际需求。"

一句话概括 GT:**把"我有多信任这条跨 hub 的边"做成一个显式的、可分级的、
能上协议的一等公民,让稀缺的人类注意力只花在"低信任 × 高风险"的格子里。**

---

## 二、现状:四条信任轴的体检

开工前先侦察(5 路子代理 + 4 处一手核实)。结论:Gotong **已经有四条相互解耦的
信任轴**,但只有第一条成熟,其余三条要么扁平、要么狭窄。

| 轴 | 现状 | 成熟度 | 一手证据 |
|---|---|---|---|
| ① **动作风险**(safe/dangerous/cross_hub/forbidden) | 成熟,服务端权威分级,危险动作强制二次确认 | ✅ 成熟 | `hub-steward/src/classify.ts:82-123`;`personal-butler-ask-peer.ts` 出站分级 |
| ② **peer 信任**(每条边的授权) | **12+ 个扁平 per-link 字段**,无梯度——要么全配要么不配 | ⚠️ 扁平 | `identity/src/types.ts:1545-1626` PeerRegistration |
| ③ **渠道 / 原则信任**(IM<web、agent<human) | 已有雏形但狭窄(imApprovable 白名单、operator 边界) | ⚠️ 狭窄 | `classify.ts:38-43` operator;IMA 的 `imApprovable` |
| ④ **控制粒度 Tier**(agent 接管) | 成熟但**正交**——讲的是"接管一个 agent 有多细",不是"信任一条边多深" | ✅ 正交,不并入 | `AGENT-ADAPTER-CONTRACT.md` Tier 1/2 |

**GT 主要在轴 ② 上做文章**,顺带把轴 ③ 的雏形系统化(见第八节 GT 与 IMA 的连续性)。
轴 ① 直接复用(它是决策矩阵的一维),轴 ④ 完全不碰(不同维度,并入会丢信息)。

### 2.1 轴 ② 内部还要再分两个正交子轴

这是最容易被做错的地方:**"我确信这条边是谁"** 和 **"我授权这条边能做什么"** 是
**两个正交的子轴**,绝不能揉成一个"信任分数":

- **身份确证**(identity confidence):`pinnedKid`——owner 是否 PIN 了对端的签名
  公钥。已由 STD track 落地(`types.ts:1603-1613`,schema v35)。它回答"我确信
  对端是我认识的那个 hub 吗"。**advisory,永不硬阻断联邦**(STD 的既有姿态)。
- **行为授权**(behavioral authorization):`outboundCaps` / `allowedDataClasses` /
  `requireApprovalOutbound`——这条边能派什么活、能带什么数据出盒、要不要审批。
  它回答"我允许这条边替我做多危险的事"。

一手证据证明这两个子轴在代码里已经解耦:`web/src/identity-routes.ts:2410-2416`——
`gatingChanged = Object.keys(policy.value).some(k => k !== 'pinnedKid')`,改 PIN
不触发 gating 重算,两轴各走各的。**GT 保持这个解耦**:trustTier 是主档(决定
矩阵行为),pinnedKid 是**升档的建议信号**(想升 T2 建议先 PIN,但不自动升),
outboundCaps 是**档位的预设展开**(选了档预填,可精修)。

---

## 三、三个地基问题

侦察挖出三个必须在 GT 里一并处理的地基问题:

### 问题 1:`outboundCaps=null` 是 accept-all,和 runbook 说的 fail-closed **直接矛盾**

一手核实:

- `core/src/peer-acl.ts:67`:`if (outboundCaps === null || undefined) return { ok: true }`
  —— null = **放行一切**。
- `docs/zh/FEDERATION-RUNBOOK.md` §4 表(line 161):outboundCaps null =
  "不放任何东西出站(fail-closed)"。

**代码和文档说的是反的。** 今天新建一条边、忘了配 outboundCaps,结果是**默许放行
一切出站**——这与"每条边是显式契约、fail-closed"的设计立场违背。GT 的岔口 2 就是
**改代码把这个默认反转成 fail-closed**(用户已拍板)。

### 问题 2:peer 信任无梯度——扁平的 12 个字段

轴 ② 的 12+ 个字段是平铺的开关/白名单,没有"档位"概念。想表达"这是我家人的
hub,基本全放行"vs"这是刚握手的陌生 hub,只读且步步审批",今天要**逐字段手配两
套**,没有一个"选个档,预设自动铺开"的快捷方式。GT 的核心提案 A 就是补这个档。

### 问题 3:审批摩擦一刀切——不看信任只看动作

今天 `requireApprovalOutbound` 是 per-peer 的布尔,`personal-butler-ask-peer.ts:199-216`
的 classify() **永远返回 approve**(每次 ask_peer 都问成员,无 allow 分支)。摩擦只
按"动作是什么"定,不看"对端多可信"。结果:对最信任的家人 hub 派个只读活,和对
陌生 hub 花钱,摩擦一样重。**稀缺的人类注意力没有花在刀刃上。**

---

## 四、未来公网 agent 网络为什么结构性需要分级

用户要我"深度思考未来 agent 和人之间的网络的实际需求"。我的判断:

1. **规模决定必须分级。** 一个人手动 PIN 三五个 hub 可行;当 agent 网络长到成百上
   千个 hub、每个 hub 背后有人和 agent,"逐条边手配 12 个字段"结构性不可扩展。
   必须有"档位 + 预设"把常见信任形态压成一次选择。

2. **信任本就是连续的,不是二元的。** 现实里"我完全信任配偶 / 有点信任同事 /
   基本不信任陌生人"是一条光谱。把它压成"连了 = 信 / 没连 = 不信"是信息损失。
   分级是把这条本就存在的光谱**如实建模**。

3. **公网需要可协商的信任声明,但声明 ≠ 信任。** 两个陌生 hub 在公网相遇,需要一
   种标准方式**声明**"我支持到哪一档""我要求你至少到哪一档才跟你交互"。但——这是
   GT 的铁律——**协议承载的是声明和协商,不是信任赋予**。对端在 wire 上说"我支持
   T3"绝不等于我就把它当 T3。信任的根永远锚定在**结构不可伪造处**(bearer token、
   已注册的 participant 身份、owner 亲手 PIN 的公钥),永不锚定在 wire 自报数据。
   这是"发现 ≠ 信任"在协议层的落地。

4. **人的注意力是网络里最稀缺的资源。** agent 能 7×24 跑,人不能。一个可扩展的
   人-agent 网络,必须让人只在"低信任 × 高风险"的少数格子里被打扰,其余交给档位
   预设自动裁决(自动放行 / 自动拒绝 / 降级成一键确认)。分级就是这台"注意力节流器"。

**结论:分级不是锦上添花,是 agent 网络从"几个熟人 hub"走向"公网规模"的结构性
前提。** 这就是为什么用户第 5 点要"把分级写进未来的公网协议"——它是地基,不是特性。

---

## 五、七个决策(已拍板,2026-07-13)

| # | 决策 | 内容 |
|---|---|---|
| **核心** | **选 A** | trustTier = **人选的信任档**(而非从行为自动推断的分数)。人显式选"我多信任这条边",档位把 12 个字段的常见组合压成一次选择。 |
| **岔口 1** | **新增 `trustTier` 字段** | 独立的新枚举字段,**不复用** PeerKind(PeerKind = "对方是什么",trustTier = "我多信任",两个正交轴,复用会丢信息)。 |
| **岔口 2** | **改代码 fail-closed** | 把 `peer-acl.ts:67` 的 null=accept-all **反转成 fail-closed**,同步修 runbook §4 的矛盾。新 peer 默认落最低有效档。(破坏性行为变更,见第十一节。) |
| **岔口 3** | **纯软连接** | 身份确证(pinnedKid)↔ 授权档 只做 **advisory 提示**,**绝不自动改权限**。PIN 成功 → 建议"可升 T2";PIN mismatch → 建议"考虑降档"。升降档永远是人的决定。 |
| **岔口 4** | **做信任引荐 / 传递** | 可信 peer 可以**引荐**一个新 peer;系统据引荐关系**建议一个初始档**,owner 确认才落档。**引荐只降发现成本 + 建议初始档,绝不自动赋予信任**(守岔口 3)。 |
| **岔口 5 + 地基** | **分级上协议 + 写进公网协议 + 标准化 mesh 层** | 把 trustTier 做成 **mesh wire 协议的一等公民**(可声明 / 可协商 / advisory);把 mesh 层从"私有实现"提升为**公开 wire 规范**;A2A 卡**保持纯净**只做发现,不掺 Gotong 私有信任语义;两层不混。 |

这七条咬合成一条链:独立 trustTier 轴(1)让档位成为可上协议的实体(5);fail-closed(2)
让最低档成为真正的地板;纯软连接(3)保证哪怕上了协议升档仍是人的决定;引荐(4)是
scale 到公网的传递机制;上协议(5)把前四条从"我一个 hub 的私事"变成"任意两个 Gotong
hub 能互认的标准"。

---

## 六、trustTier 分档定义(草案)

四档 + 一条引荐路径。**每升一档,要么更多验证,要么更多人工确认**——这就是"安全性
逐步提高、易用性相对逐步降低"的具体形状。

| 档 | 代号 | 门槛 | 语义 |
|---|---|---|---|
| **T0** | `discoverable` | 只能经公开 A2A 摸到,**未完成 mesh 握手** | 可发现 / 未联邦。零 mesh 通信。 |
| **T1** | `token` | 完成**双边 token 握手** = 今天的联邦门槛 | 令牌联邦(**默认地板**)。fail-closed:授权窄、步步审批。 |
| **T2** | `verified` | T1 + owner **显式 PIN 了签名公钥**(pinnedKid 验过) | 身份锚定。确信"对端是我认识的那个 hub"。 |
| **T3** | `trusted` | T2 + owner **显式提升**(家人 / 长期合作) | 信任伙伴。矩阵里享最低摩擦(但仍不去确认,见第十节)。 |

**引荐(岔口 4)不是单独一档**,而是一条**快速建立初始档**的路径:

```
可信伙伴 X(我给的档 = T3)引荐了 hub-Y
   → 系统提示 owner:"你的 T3 伙伴 X 引荐了 hub-Y,建议给 T1"
   → owner 确认才落档(可改成别的档,也可拒绝)
   → 信任的根仍是 owner 单边决定;X 的引荐只降低了"发现 + 初始配置"的成本
```

**升降档规律**:
- 升档:T1→T2 加 PIN 验证;T2→T3 owner 显式提升。**pinnedKid 成功只"建议"升 T2,
  不自动升**(岔口 3 纯软连接)。
- 降档:pinnedKid mismatch / 长期无交互 时**软提示**"考虑降档",**不自动降**(岔口 3)。
- fail-closed:新 peer 默认落 T1(未握手前概念上是 T0),outboundCaps 默认锁死。

---

## 七、决策矩阵(草案):出站动作风险 × 信任档

把轴 ①(出站动作风险)和 trustTier 交叉,得到一张**注意力分配表**。格子里是"人要不
要确认 + 确认多重":

| 出站动作 \ 信任档 | T0 | T1 `token` | T2 `verified` | T3 `trusted` |
|---|---|---|---|---|
| **只读**(list_peer / inspect) | 拒 | 成员一键确认 | 自动放行 | 自动放行 |
| **benign 派活**(读类 capability) | 拒 | 成员审批 | 成员一键确认 | 自动放行 |
| **危险派活**(花钱 / 对外 / 数据出盒) | 拒 | owner 审批 | owner 审批 | 成员一键确认 |
| **forbidden**(未授权 capability) | 拒 | 拒 | 拒 | 拒 |

读法:
- **同一动作,档越高摩擦越低**(只读:T1 要确认 → T2/T3 自动)。← 易用性逐步提高。
- **同一档,动作越危险摩擦越高**(T3:只读自动 → 危险派活仍要成员确认)。← 安全性守住。
- **稀缺的人类注意力**集中在左下的"低档 × 高危"格子。
- **信任只降摩擦,永不去掉确认的底线**:最危险的动作即使 T3 也要"成员一键确认"
  (可追责留痕),绝不变成"静默自动"。forbidden 任何档都拒。

> 矩阵是草案;具体格子的阈值 M1 落地时按既有 `classify` / `outbound-approval` 精调。
> 关键是**结构**:档位调的是"确认的重量"(web 强审批 → IM 一键 → 可追责通知),
> 动作风险定的是"是否需要确认"的底线。这与 IMA 的 imApprovable 哲学一脉相承(见下节)。

---

## 八、和既有机制的关系(五个"不要混")

GT 最大的风险是概念污染。五条边界钉死:

1. **trustTier ≠ reputation**(HUB-MESH §3.5)。reputation = "这个 peer 干活好不好"
   (从 feedback 派生、影响**路由选择**);trustTier = "我多信任它能对我做多危险的事"
   (owner 设定、影响**审批阈值**)。正交。一个高 reputation 但低 trustTier 的 peer =
   "活干得好但我只让它做只读"——完全合理,不矛盾。

2. **trustTier ≠ pinnedKid**。pinnedKid 是**身份确证**(升 T2 的门槛条件之一),
   trustTier 是**授权档**。PIN 了不自动升档(岔口 3)。

3. **trustTier ≠ outboundCaps**。outboundCaps 是**档位的预设展开**——选了档预填一套
   caps,可再精修。档是快捷方式,caps 是可覆盖的细节。

4. **trustTier ≠ PeerKind**。PeerKind(`personal|organization|project|service`)=
   "对方是什么组织形态",trustTier = "我多信任它"。一个 `organization` 可以是 T1 也
   可以是 T3。(岔口 1 拍板新字段正是为守住这个正交。)

5. **trustTier ≠ 控制粒度 Tier**(AGENT-ADAPTER-CONTRACT 的 Tier 1/2)。后者讲"接管
   一个 agent 有多细",与"信任一条 hub 边多深"是不同维度。不并入。

**GT 与 IMA 的连续性**:IMA(IM 审批闭环)已经做了"把 web 强审批降级成 IM `/approve`
一键"这**一档**摩擦降级。GT 是把"降到什么重量"和"peer 信任档"绑定,**系统化、分级化**。
IMA 的 imApprovable 白名单哲学(fail-closed、写入时钉死、声明 ≠ 授权)是 GT 矩阵的
直接先例。GT 可以看作 IMA 的自然延伸:IMA 定了"确认可以多轻"的一个点,GT 定了整条曲线。

---

## 九、里程碑划分(M1 → capstone)

按依赖顺序,每刀独立可验、独立可回滚。参考既有 track 的 M0→capstone 节奏。

| 里程碑 | 内容 | 验收门 |
|---|---|---|
| **M0** | 本计划文档(侦察 + 决策固化 + 分档 + 矩阵 + 边界 + 路线) | 用户审方案(方案门) |
| **M1** | **trustTier 纯核**:枚举 + 分档定义 + 升降档规则 + 决策矩阵函数(identity/core 层纯函数,零 host 依赖,可单测) | 矩阵函数逐格单测;升降档规则单测 |
| **M2** | **fail-closed 默认反转**:改 `peer-acl.ts:67` null→deny + 修 runbook §4 矛盾 + 迁移策略。**破坏性,单独一刀 + 防回归** | 既有 peer-acl 测试改断 fail-closed;迁移不静默改变已配 peer 行为 |
| **M3** | **schema v37 + 落库 + 面板**:`ALTER TABLE peers ADD COLUMN trust_tier`(additive,pinnedKid 同款模板)+ peer-store 读写 + web admin 落档/显示 | identity peers 测试;web 面板 round-trip |
| **M4** | **纯软连接**:pinnedKid 成功 → 建议升 T2;mismatch → 建议降档。**只提示,不自动改权限** | 单测钉死"建议 ≠ 自动改档" |
| **M5** | **信任引荐 / 传递**:可信 peer 引荐 → 建议初始档 → owner 确认。最新颖的一刀 | 单测钉死"引荐 = 建议初始档,不自动赋信;owner 确认才落档" |
| **M6** | **mesh wire trustTier 声明**:`MESH_HELLO` 加可选 trustTier 声明字段(advisory、接收方裁决,复用 auth 信封同款姿态)+ **把 mesh 规范化成公开 wire spec**(升级 HUB-MESH.md / 新 spec) | 声明字段单测;接收方永不因 wire 自报值改档(advisory 铁律) |
| **M7** | **公网协议写明分级**:把 T0-T3 分级 + 协商语义写进面向公网的协议规范文档,标注"当前实现 vs 未来公网预留" | 规范文档评审;外部可据规范实现的自洽性检查 |
| **capstone** | `examples/graded-trust` 确定性 demo:新 peer 落 T1 → PIN 升 T2 建议 → owner 提升 T3 → 矩阵审批阈值随档变 → 引荐建立初始档,全链路一个脚本自断言 | `pnpm demo:graded-trust` exit 0 |

**最重的两刀**:M2(fail-closed 破坏性反转)和 M6+M7(协议标准化)。建议 M1→M5 先把
本地分级模型跑通、有 capstone 兜底,再动 M6/M7 的协议标准化(协议一旦对外规范化,
改动成本上升)。

---

## 十、不可破的边界(GT 全程守)

与 NET / STD 同源的两条,加 GT 特有的两条:

1. **信任只降摩擦,永不去确认**。矩阵**行** = "是否要人确认"(动作风险定底线),
   **列** = "确认多重"(信任档调重量:web 强审批 → IM 一键 → 可追责通知)。最高危险
   动作即使 T3 也留可追责确认,forbidden 任何档都拒。**信任降的是易用性的摩擦,
   不是安全性的底线。**

2. **信任锚定在结构不可伪造处,声明 ≠ 信任**。trustTier 上协议后,对端 wire 自报
   "我支持 T3" 是 **advisory**,绝不自动被当 T3。信任的根永远是 bearer token /
   已注册 participant 身份 / owner 亲手 PIN 的公钥。这是"发现 ≠ 信任"的协议层落地,
   与 pinnedKid / manifest 的既有姿态一致。

3. **纯软连接**(岔口 3):身份确证 ↔ 授权档 只做 advisory 提示,升降档永远是人的
   决定,系统绝不自动改权限。

4. **内核边界**:trustTier 落 `identity` 的 peers 表 + `core/peer-acl` 消费矩阵;
   mesh wire 声明在 `transport-ws`。core/workflow/protocol 不因 GT 长出 LLM 调用,
   分级裁决全是**纯函数 + 查表**(热路径零 LLM)。web 运行时不依赖 host(鸭子 surface)。

---

## 十一、破坏性变更与迁移

**岔口 2 的 fail-closed 反转是一个破坏性行为变更**,不是 opt-in 字节不变——这与
其他 track 的"默认不变"法则不同,要专门处理:

- **为什么可以破坏**:项目未上线,CLAUDE.md 4.1 "不需要向前兼容,大胆改 schema"。
  且当前 accept-all 默认本身是个**与设计立场违背的 bug**(问题 1),修它是纠错。
- **迁移策略**(M2 定稿):现有 `outboundCaps=null` 的 peer,迁移时**不静默改变其运行
  行为**——要么显式迁成"保留当前放行集",要么在启动横幅**警告**"这些 peer 曾依赖
  accept-all 默认,请复核授权"。绝不让一次升级悄悄掐断生产中的边,也绝不让它悄悄
  维持不安全默认。具体二选一在 M2 落地时定,先钉"不静默"原则。
- **schema v37**:`ALTER TABLE peers ADD COLUMN trust_tier TEXT`(additive,可空,
  NULL = 按 fail-closed 视作 T1)。公钥指纹类 pinnedKid 进列不进 vault 的先例适用。
- **生产核实**:M2/M3 落地前,核实腾讯云生产机(43.136.130.171)现有 peer 配置——
  若有依赖 accept-all 的边,迁移前先跟用户对齐。(现在不查生产,M2 时查。)

---

## 十二、显式不做(本 track 边界)

- **不做全局 reputation / 信任共识**:trustTier 是 per-link owner 单边视角,不传播、
  不广播、不共识(和 HUB-MESH reputation 的"本地视角"约束一致)。
- **不做多跳信任传递的自动 transitive 计算**:引荐(M5)是"一跳、建议、owner 确认",
  不是"A 信 B、B 信 C ⇒ A 自动信 C"。多跳自动传递是拜占庭雷区,显式不做。
- **不做 A2A 卡塞私有信任语义**:守地基 A,A2A 保持纯净只做发现。
- **不做 discovery / DHT**:延续 HUB-MESH §8,用户仍负责连边;引荐只降发现成本,
  不是自动发现网络。
- **不做 IM 里的信任档编辑**:改档是 owner 级配置动作,留 web(和 IMA 分级姿态一致——
  高敏配置 web-only)。

---

## 十三、术语与参考

**术语**:trustTier(信任档,T0-T3)/ reputation(声誉,干活质量,正交)/ pinnedKid
(身份确证)/ outboundCaps(行为授权,档的预设展开)/ advisory(声明,非授权)/
fail-closed(默认拒绝)/ 引荐(referral,建议初始档不赋信)。

**参考**:
- `docs/zh/FEDERATION-RUNBOOK.md` — §0 心智模型 + §4 授权表(§4 的 fail-closed 矛盾 GT-M2 修)
- `docs/zh/HUB-MESH.md` — mesh 设计文档(reputation §3.5 与 trustTier 正交)+ GT-M6/M7 规范化对象
- `docs/zh/NET-AGENT-NETWORK.md` — 两边界"不绕既有闸、发现 ≠ 信任"同源
- `docs/zh/STD-STANDARDS-ALIGNMENT.md` — pinnedKid / 名片签名(身份确证轴,advisory 先例)
- `docs/zh/IM-APPROVAL.md` — imApprovable 白名单哲学(GT 矩阵"确认重量"的直接先例)
- `docs/PROTOCOL.md` — agent↔hub wire(与 mesh wire 分离;GT 只碰 mesh 层)
- `packages/core/src/peer-acl.ts` — 轴 ② 消费点(fail-closed 反转落点)
- `packages/identity/src/types.ts` `peer-store.ts` `schema.ts` — trustTier 落库
- `packages/transport-ws/src/hub-link.ts` — `MESH_HELLO` auth 信封(trustTier 声明挂载点)

---

**M0 交付 = 这份计划本身(尺子 + 路线)。用户审方案后进 M1。**
