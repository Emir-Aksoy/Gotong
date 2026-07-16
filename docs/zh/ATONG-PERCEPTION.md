# 阿同感知力 track（SEN）— 对自己与对所在 hub 的感知增强

> Status: **M0 计划 + M1、M2 已落**（M1 hub 红灯感知 ✅ / M2 peers 信任投影 ✅）
> Last updated: 2026-07-16
>
> 用户诉求（2026-07-16 原话）：「怎么能增加 atong 的感知力，包括对自己和对它
> 所在的 hub」。本文是 SEN track 的 M0 计划：先盘「我们自己有没有」（侦察清单
> 第一条），钉出真缺口，再按最小刀阶梯逐个补。**除 M1 外的里程碑都是方向性
> 规划，实现前按 M0 惯例重新细化。**

---

## 一、判断：感知骨架已在，缺的是几块具体盲区

阿同的感知不是从零建——三条管道早已成型，本 track 只是往管道里补器官：

| 管道 | 机制 | 已装的感知器官 |
|---|---|---|
| **每轮尾卡**（`composeContextProbes` → `systemVolatile`，NA-M3 隔离出缓存段，冻结块字节不变） | 开口前自动知道 | 时钟（恒注入）、A1 待批提醒、A2 时段/间隔、A3 语言偏好、A4 来源渠道、任务笔记本复述、CARE-M4 开箱现状卡 |
| **按需工具**（benign 只读，AFR-M3 后分一等/目录两层） | 被问才去看 | observe 三读（runs/agents/usage）、diagnose、list_peers、list_my_llms（候选链+健康）、backup_status、list_my_capabilities、show_my_memory、gotong_guide |
| **阈值推送**（零 LLM sweep，边沿播报） | 出事主动说 | CARE-M3 巡检（10 分钟）、CARE-M2/M5/M6 断供三线、BE-M5 运行播报、TN-M2 任务卡壳提醒、AFR-M7 备份陈旧提醒 |

这个格局本身是对的（分频：高频进尾卡、低频进目录、事件走推送）。缺口全是
「某个具体事实没有投影到管道里」，不是管道缺失。

## 二、侦察记录（2026-07-16，全部对代码核过）

关键既有件（file:line 为侦察时点）：

- **`HealthSnapshot`**（`packages/host/src/admin-health.ts:59`）：hub 体检的唯一
  权威投影——agents 逐台（missingKey/online）、mcpServers（wired）、
  spaceWritable、workflowCount/runCount、imBridges、connectorSlots、
  llmOutage（CARE-M7 三态）、routing（MR-M3 降级行）。**全部零成本静态检查**
  （文件头设计注释明说：no LLM ping, no network round-trip），
  `snapshot()` 安全到「每次面板打开都可调」。
- **`derivePatrolCards`**（`personal-butler-patrol.ts:78`）：快照 → 红/黄牌面的
  唯一判定（空间不可写=红；缺 key/IM 全无/MCP 未接线/连接器槽位未接=黄），
  「判据与 admin 面板同源」。巡检 sweeper 每 10 分钟把牌面落盘
  **`<space>/butler/patrol-state.json`**（main.ts:1895），格式
  `{cards: {id: {severity, label, since}}}`，损坏当空。
- **巡检的披露面**：`ButlerPatrolSweeper.runOnce` 把牌面细节（agent id、MCP 名、
  spacePath）推给**所有开了运行播报的成员**（`listConsentingUserIds` 不过滤
  角色）——「成员可见 hub 级牌面细节」是既有披露面。
- **探针缝**：factory 的 `composeContextProbes(...)`（`personal-butler-factory.ts:555`），
  探针签名 `() => Promise<string | null>`（A1 先例
  `buildButlerPendingProbe`，`personal-butler-pending.ts:92`：lazy source、
  一切失败路径 → null → prompt 字节不变）。路径推导先例：A2 presence 用
  `dirname(memoryRoot)` 拿 `<space>/butler/` 兄弟目录（factory:257）。
- **惰性体检面已经进了 factory**：`deps.onboarding.health = () => patrolHealthRef`
  （main.ts:1099），且 `onboarding` dep **无条件构造**——复用它 = main.ts 零新
  接线（行数预算 3000/3000 顶格，这点很关键）。
- **工具面登记链**（AFR）：新 benign 工具必须 ① `butler-tool-tiers.ts` 名单
  落层（一等 vs 目录，动名单前过三条理由）② `butler-toolface-report.test.ts`
  的 `MEASURED_BUILDERS` + `buildFullFace()` 登记（AFR-M1 tripwire，漏登记门红）
  ③ AFR-M3 防腐门结构性断言：一等/内建 schema 里不得点名目录工具。
- **`ButlerPeerRow`**（`personal-butler-peers.ts`）：只有 peerId/label/connected/
  liveness——**GT 的 trustTier / STD 的 pinnedKid 落库在它之后，投影从没补**。
  identity `PeerRow` 已有 `trustTier`（null=未分级回落 T1）与 `pinnedKid`，
  都是非密字段。

### 确认的缺口（八项）

**对所在 hub：**

| # | 缺口 | 证据 |
|---|---|---|
| ① | 「hub 现在健康吗」答不上来——体检投影只喂面板与巡检推送，没有按需工具 | HealthSnapshot 的三个消费者：admin 面板、patrol、onboarding 卡；无 benign 工具 |
| ② | 看不见定时工作流（「每天早上自动跑什么」） | schedules 只有 admin CRUD 面 |
| ③ | 看得见 peer、看不见信任分档 | ButlerPeerRow 无 trustTier/pinnedKid |
| ④ | 不知道 hub 里有谁（成员/角色） | 仅 backup ops 的 privileged 判定读 membershipRole |
| ⑤ | 不在场时的事件盲区（run 完成/失败、审批 resolve、成员进出） | transcript 是事件日志但无成员向有界投影 |

**对自己：**

| # | 缺口 | 证据 |
|---|---|---|
| ⑥ | 碎片全有、没有一张「我的状态」汇总（模型链+断供+今日用量+记忆树+备份） | 各在 list_my_llms / my_usage / backup_status 等五个工具里 |
| ⑦ | hub 有红灯时**开口前不知道**——巡检只推 owner 向播报，不进阿同的每轮意识 | contextProbes 里无 hub 状态探针 |
| ⑧ | 没有行动史（「我这周帮你做了什么」） | 无 transcript/笔记本的 episodic 投影 |

## 三、边界（五条，与 AFR/UX 同源，全程不可破）

1. **热路径零 LLM**：所有感知都是纯投影/纯读事实文件；判定不新写——hub 红灯
   判定复用 `derivePatrolCards` 唯一权威（三处同源，永不各说各话）。
2. **缓存前缀稳定**：尾卡只走 `composeContextProbes` → volatile 段；**无信号 =
   null = prompt 字节不变**（A1/A3 同款）。冻结块一个字节不动。
3. **披露分级结构性**：工具/探针的投影面 ⊆ 既有披露面（例：hub 牌面细节已由
   巡检推给成员，hub_health 给成员看同样内容 = 零新披露）；越过既有披露面的
   信息（如成员名单细节）必须走 role 判定，服务端权威（backup ops 先例）。
4. **知识 ≠ 授权**：感知工具全是 benign 只读；看见问题不等于能修——修复动作
   仍走既有 governed 闸/diagnose 路径。
5. **内核零改动、零新旋钮**：全在 host/personal-butler 层；新常量（如探针
   新鲜度门）走常量非 env；main.ts 行数预算不越线。

分层纪律（AFR-M3）：新感知工具默认落**目录层**（低频按需自省），除非被一等
工具描述点名或成为每日动词;尾卡文案**不点名任何目录工具**（指路指空原则——
说人话「问我」，模型自然经 use_tool 取用）。

## 四、里程碑阶梯

### SEN-M1 hub 红灯感知（第一刀：尾卡一行 + hub_health 按需卡）✅ 设计如下

一刀两件，同一份数据源（体检投影），补缺口 ⑦ + ①：

**M1a 尾卡探针 `buildButlerHubSenseProbe`**（新文件
`packages/host/src/personal-butler-hub-sense.ts`）：

- 数据源 = **纯读 `<space>/butler/patrol-state.json`**（patrol 每 10 分钟写好的
  牌面事实；路径走 `dirname(memoryRoot)` 推导，A2 presence 同款先例）——每轮
  **零计算零 key 解析零网络**，判定天然与巡检/面板同源。
- 新鲜度门：文件 mtime 超过 `3 × BUTLER_PATROL_INTERVAL_MS`（30 分钟，常量非
  旋钮）→ 当「巡检不在班」→ null。**不拿死巡检的旧牌面当现状**（诚实的未知）；
  重启后 10 分钟内的短暂陈旧可接受（牌面是持续状态非事件，下一 tick 修正）。
- 渲染：红牌逐张点名、黄牌计数点前 2；文案带「成员问起异常时这可能是原因」
  提示；**不点名 hub_health**（目录工具指路指空原则）。
- 一切失败路径（无文件/损坏/空牌面）→ null → prompt 字节不变。
- 探针插在 A1 待办探针之后、onboarding 现状卡之前（环境意识排个人待办后）。

**M1b 目录 benign 工具 `hub_health`**（同文件）：

- 面 = 复用 `deps.onboarding.health`（惰性 `AdminHealthSurface`，与巡检/面板
  同一份活体投影）——**main.ts 零新接线**。onboarding 缺席 → 工具不装（诚实
  降级，与 diagnose/llms refs 缺席同姿态）。
- 渲染（纯投影零 LLM 决策，导出 `renderHubHealth` 给测试直打）：
  - 牌面：`derivePatrolCards(snapshot)` 逐行（红先黄后，判定零新写）；
  - 断供：`snapshot.llmOutage` 即时显示（面板 CARE-M7 同款**无阈值**姿态——
    工具要当下真相，30 分钟阈值只属于巡检的「别刷 IM」）；
  - 路由降级：`snapshot.routing` 非空 → 「N 个候选被熔断/降级中」+ 指路
    list_my_llms（同在目录层，互相点名合规）;
  - 正面统计：managed N 台（在线 M）、MCP X 台（Y 未接线）、工作流/run 计数、
    IM 通道平台、空间可写——全部 snapshot 既有字段。
- 披露论证：牌面细节（agent id/MCP 名/spacePath）已由巡检推送给开播报的成员，
  工具投影 ⊆ 既有披露面，**零新披露、不分级**（诚实一份牌面）。
- 登记三件套：`BUTLER_DIRECTORY_BENIGN` 加 `hub_health`（低频按需自省，无一等
  点名）+ `MEASURED_BUILDERS`/`buildFullFace` 登记 + tiers 防腐门自动盖。

**验收门**：新单测（探针五态：无文件/损坏/空牌面/有牌/mtime 陈旧;渲染各分支;
builder 形状）+ host 全套 + `pnpm check:guards` 四门 + AFR-M1 tripwire 绿。

### SEN-M2 peers 投影补信任分档（第二刀，小刀补旧账）

`ButlerPeerRow` 增 `trustTier`（null 如实报「未分级（按 T1 对待）」）与
`pinnedKid` **有无**（布尔化「已锚定签名公钥」，指纹本身不进投影——脱敏红线
结构性姿态延续）。`list_peers` 渲染行尾带档位。identity 字段都是非密的，
但投影只放渲染需要的最小集。

### SEN-M3 `my_status` 自我状态一卡（第三刀，「对自己」主菜）

拼既有投影碎片成一张卡：模型候选链健康（ButlerLlmSurface 同源）+ 断供态
（outage 文件）+ 今日用量（ButlerUsageSurface）+ 记忆树规模/上次蒸馏
（memoryView/维护事实）+ 备份事实（ButlerBackupOps.lastBackup）。目录层
benign;各碎片 dep 缺席逐项降级「(未接)」绝不炸。

### SEN-M4+ 按需再起（方向钉住，不预造）

- ② `list_schedules`：定时工作流只读投影（成员向）；
- ④ `list_members`：成员/角色投影——**越过既有披露面**，必须先做 role 分级
  设计（member 见「有谁+角色」还是仅 owner/admin，实现前摆岔口）;
- ⑤ `recent_hub_events`：transcript 有界事件投影（run 完成/失败、审批
  resolve）;需先定披露规则（成员只见自己相关 vs hub 级），实现前摆岔口;
- ⑧ 行动史：「我这周做了什么」episodic 投影（transcript + 任务笔记本），
  与 ⑤ 共享披露设计。

## 五、显式不做 / 已裁决

- **不做后台自主 LLM 探活**：感知永远是纯投影;「能不能生成」的主动探针已有
  MR-M5 手动测试路由（opt-in 手动），边界①手动侧不重开。
- **不做新的健康判定**：红/黄判据只认 `derivePatrolCards` 一个权威;工具/探针/
  面板/巡检四处永远同源。
- **不做感知数据的新存储**：全部读既有事实文件/内存投影;不为感知落新台账
  （patrol-state/llm-outage/last-backup 都是别人写的事实，探针只读）。
- **尾卡不膨胀**：每轮尾卡只加「红灯一行」这一个新探针;M2/M3 的信息量走
  目录工具，绝不挤进每轮 prompt（AFR 工具面瘦身的反方向教训）。

## 六、验收纪律

每刀：实现 → 包测试 + `pnpm -r typecheck`（动到的包）+ `pnpm check:guards`
四门 → 本文档追加 ✅ 块 → commit（显式列文件，绝不 `git add -A`）→ 汇报。
AFR-M1 工具面基线报告若因新工具变化，按 tripwire 指引重跑登记。

---

## ✅ SEN-M1 hub 红灯感知（2026-07-16）

**落地形状**（新文件 `packages/host/src/personal-butler-hub-sense.ts`，探针+工具
同文件，镜像 backup 的 status/pack 同居先例）：

- **M1a 尾卡探针 `buildButlerHubSenseProbe`**：纯读
  `<space>/butler/patrol-state.json`（factory 里 `dirname(memoryRoot)` 推导，
  A2 presence 同款；牌面解析**复用 patrol 的 `loadPatrolState`**——只给它加了
  `export` 一个词，解析/判定永不两份）。新鲜度门
  `PATROL_STATE_FRESH_MS = 3 × BUTLER_PATROL_INTERVAL_MS`（30 分钟常量）：
  mtime 落后于它 = 巡检不在班 → null（旧牌面不当现状，诚实的未知）。渲染：
  红牌逐张 label、黄牌计数点前 2 带「等」、规则行钉「别把这卡说成用户说的话」;
  **不点名任何目录工具**（防漂移断言钉进单测）。无文件/损坏/空牌面/陈旧
  一律 null → prompt 字节不变。插位:A1 待办探针之后、onboarding 现状卡之前。
- **M1b `hub_health` 工具**：`health` 面**骑 `deps.onboarding.health`**（main.ts
  里 onboarding dep 无条件构造、getter 指向与巡检/面板同一个 `patrolHealthRef`）
  ——**main.ts 零改动零新行**（2999/3000 预算原地不动）。`renderHubHealth`
  纯投影：问题牌面走 `derivePatrolCards(snapshot)` 同源 fact;断供走面板
  CARE-M7 **无阈值**姿态（工具要当下真相）,病名经 `outageHeadline` 安全翻译
  （未知 kind 如实印原码不炸——面板 DTO 的 kind 是宽 string）;路由降级计数 +
  指路 list_my_llms（同在目录层,互相点名合规）;可选字段（workflow/IM/断供/
  routing）缺席 = 整行跳过（诚实未知,三态语义与面板一致）。惰性面未就绪/
  snapshot 抛错 → 诚实话术 isError,绝不连累对话。
- **登记三件套**：`BUTLER_DIRECTORY_BENIGN` 加 `hub_health`（低频按需自省,
  带理由注释）+ tripwire `MEASURED_BUILDERS['hub-sense']` + `buildFullFace`
  条目;AFR-M3 tiers 门（真工厂双向核对）与指路不指空结构性断言自动盖新工具。

**验收**：新单测 17 例全绿（探针六态:无文件/损坏/空牌面/有牌/陈旧 vs 新鲜
对照/黄牌 ≤2 无「等」;渲染六分支:全绿可选行全跳/红牌同源/缺 key/断供三态含
未知病名/路由两态/IM+工作流行;工具四态:listTools/未就绪/抛错+warn/正常）;
host 全套 **2151** 通过（tiers 门 + tripwire + factory 家族全绿）;host tsc
零错;四门 PASS（kernel-deps 6 不变式/**旋钮 114 零新增**——新常量
`PATROL_STATE_FRESH_MS` 非 env/行数预算 main.ts 2999/3000 **零触碰**）。

**边界复核**：热路径零 LLM（探针纯读文件、工具纯投影）✓;无信号 = null =
prompt 字节不变 ✓;披露 ⊆ 巡检既有推送面（零新披露）✓;知识 ≠ 授权（两张嘴
全只读）✓;内核零改动、零新旋钮、零新存储（读的都是别人写的事实文件）✓。

---

## ✅ SEN-M2 peers 投影补信任分档（2026-07-16）

**旧账**：`ButlerPeerRow`（NET-M1 时代）只有 peerId/label/connected/liveness/
outboundCaps——GT 的 trustTier 与 STD-M2b 的 pinnedKid 落库在它之后，投影
从没补。阿同知道「认识谁」，不知道「多信任」。

**落地**（全在 `personal-butler-peers.ts`，additive）：

- `ButlerPeerRow` 增 `trustTier: string | null`（null = owner 未分级）与
  `pinned: boolean`——**pinnedKid 在 join 时折成布尔**，43 字符指纹结构性
  不进投影（endpoint/token 红线的延伸：最小投影，成员要的是「锚没锚」）。
- `ButlerPeerSurfaceDeps.rows` 鸭子切片加两字段;identity `listPeers()` 行
  本就带它们（读侧已钳:未知 trust_tier 值 → null），结构类型直接满足——
  **main.ts 零改动**。
- 渲染行尾插 `tierLine`：`信任档 T2·已锚定签名公钥` / `信任档 T3` /
  null → `信任档未分级(按 T1 对待)`——**GT 真语义**（null 回落地板 T1
  绝不发明档位;PIN 是事实后缀不是档位——GT-M4「PIN 证身份证不了档」）。
- `ask_peer`（NET-M2）读同一 surface 但只认 outboundCaps 路由——新字段
  additive 对它零影响（出网授权仍由 caps 白名单裁决,信任档只是转述）。

**验收**：butler-peers 测试 8 例（+2:渲染三态 T2·锚定/未分级回落/T3 无
后缀;**脱敏结构性**——投影行 `'pinnedKid' in row === false`、43 字符指纹
样例绝不出现在渲染文本）;两处手写 row 的 ask-peer 测试工厂补新字段;host
全套 **2152** 全绿;tsc 零错;四门 PASS（旋钮 114 零新增,main.ts 2999/3000
零触碰）。
