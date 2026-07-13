# Hub-Mesh — Peer-to-Peer 网状架构设计

> **文档地位**:设计文档(design doc),非实现。
> 它把 `FEDERATION.md` 描述的 v1 单向桥模式(`TeamBridgeAgent`),
> 升级为 v2 的**对称 peer mesh**。
>
> **写于** 2026-05-22
> **状态** 草案 — 待评审后转为 MVP 实施计划
>
> ⚠️ **本文是「为什么」的设计动机,不是 wire 真相。** 这套设计落地后**在网线上
> 实际跑的字节契约**已抽成公开 wire 规范 [`MESH-PROTOCOL.md`](MESH-PROTOCOL.md)
> (GT-M6):`MESH_HELLO`/`MESH_TASK`/`MESH_RESULT`… 全部帧、握手裁决序、per-edge
> 认证、以及分级信任 advisory 声明字段都在那里 normative 描述。要**实现**一个兼容
> 的 mesh peer,读那篇;要理解**当初为什么这么设计**(feedback ledger、reputation
> §3.5),读本篇。

---

## 0. 设计起点 — 用户的六条原话

```
1. 每个人的 agent 是一个 hub
2. 每个人和自己的 agent 也是 hub
3. 每个人员和团队含有的 agent 组成的 team 也是 hub
4. 以 hub 组成更大的节点,可以继续上升
5. 工作信息可以相互传输
6. 结果评价反馈及时
```

随后的关键澄清:

> "hub 间的通信并没有什么子节点、父节点这样的关系,**相互的联系是自由扩展的**。"
>
> "不仅有评价,而且**及时对被评价方反馈**,被评价方可查看关于一整个 task 自己所做部分的贡献和评价。
> 因为**没有服务器**,这些信息只能以**本地文件**的形式存放,
> 被评价方**连接进来时自己读取**,并**反馈已读取**。"

把第二段拆成五个硬约束:

| 约束 | 含义 |
|------|------|
| C1 无服务器 | 不能有中心 broker 持有评价数据 |
| C2 本地文件 | 评价方在自己机器上落盘,持有原本 |
| C3 Pull-on-connect | 被评价方下次连上时自己来取(对端不必时刻在线) |
| C4 Read receipt | 被评价方收到后回执"已读取",评价方在本地标记 |
| C5 可查询贡献 | 被评价方能 list 自己在某个 task 里的全部评价 |

第一段拆成三个拓扑约束:

| 约束 | 含义 |
|------|------|
| T1 无层级 | 不假设根、不假设父子,任何拓扑都合法 |
| T2 自由扩展 | 任一 hub 跟任一 hub 拉一条边,无须中央许可 |
| T3 身份对称 | 一条边的两端是平等 peer,没有"上游 / 下游" |

---

## 1. 跟当前实现的差距(对账)

| 维度 | 现状 | 目标 | 改造类型 |
|------|------|------|---------|
| Hub 是否实现 Participant | ❌ `Hub` 类不实现 `Participant`,无 `id`/`onTask`/`onMessage` | ✅ 实现(或写 `HubAsParticipant` 包装器) | 类型扩展 |
| Hub 间连接 | ⚠️ 只有 `TeamBridgeAgent`(非对称,把本地 hub 当上游的 Agent) | ✅ 对称 `HubLink`(两端平等) | 协议替换 |
| 跨 hub 路由 | ⚠️ 必须手工配置 bridge | ✅ 已连接的 peer 中按 capability 自动查找 | 路由扩展 |
| 反馈系统 | ⚠️ `Hub.evaluate()` 单向(admin → work),信息只留在评价方的 transcript | ✅ 写入本地 ledger,pull-on-connect 分发,带 read receipt | 新模块 |
| 被评价方查询 | ❌ 被评价方无法主动查询"别人给我的评价" | ✅ 被评价方有 `myFeedback()` API | 新 API |
| ParticipantKind | `'agent' \| 'human'` | `'agent' \| 'human' \| 'hub'` 或通过包装类共用 `'agent'` | 类型选择 |

---

## 2. 核心抽象

### 2.1 Hub 升级为 first-class Participant

两种实现路径,推荐 **B**:

**A. 让 `Hub` 直接 implement `Participant`**
- 优点:类型最干净
- 缺点:`Hub` 类要长出 `id`、`onTask`、`onMessage` 字段/方法,破坏现有"hub 是路由器,participant 是行动者"的关注点分离

**B. 写 `HubAsParticipant` 适配器(推荐)**
- `Hub` 类不变
- 新增 `class HubAsParticipant implements Participant { constructor(private inner: Hub, public id: string) {} }`
- 它的 `onTask(task)` 调用 `inner.dispatch(task)`,把结果原样返回
- 它的 `capabilities` 是 `inner` 内部所有 participant 的 capability 集合(可缓存,可订阅 `inner` 的 register 事件刷新)
- 它的 `kind` 仍然是 `'agent'`(无需扩 `ParticipantKind`),但 `metadata` 里标 `{ isHubAdapter: true, peerHubId: '...' }`

```ts
// packages/core/src/participants/hub-adapter.ts (新)
export class HubAsParticipant implements Participant {
  readonly kind = 'agent'    // 对外形态等同 agent
  readonly metadata = { isHubAdapter: true as const, peerHubId: this.id }

  constructor(
    readonly id: string,         // peer hub 的稳定 id
    private readonly inner: Hub, // 本地或远端代理
  ) {}

  get capabilities(): string[] {
    return this.inner.aggregateCapabilities()  // 实时聚合或缓存
  }

  async onTask(task: Task): Promise<TaskResult> {
    // 把外部 task 注入到 inner hub 的 dispatch
    return this.inner.dispatch(task)
  }

  async onMessage(msg: ChannelMessage): Promise<void> {
    await this.inner.publish(msg)
  }
}
```

### 2.2 HubLink — 对称双向管道

`HubLink` 替代非对称的 `TeamBridgeAgent`。两端平等,谁都可以发起任务、回应任务、推送反馈。

```
┌─────────────────────┐                       ┌─────────────────────┐
│  Hub A              │                       │  Hub B              │
│  ┌────────────────┐ │   ◄── HubLink ──►    │ ┌────────────────┐  │
│  │ peer adapter   │ │  对称 WebSocket /     │ │ peer adapter   │  │
│  │ HubAsPart('B') │ │  本地 in-process      │ │ HubAsPart('A') │  │
│  └────────────────┘ │  channel              │ └────────────────┘  │
│  ┌────────────────┐ │                       │ ┌────────────────┐  │
│  │ local agents   │ │                       │ │ local agents   │  │
│  │ local humans   │ │                       │ │ local humans   │  │
│  └────────────────┘ │                       │ └────────────────┘  │
└─────────────────────┘                       └─────────────────────┘

   A 看 B 就是一个普通 participant(HubAsPart('B'))
   B 看 A 也是一个普通 participant(HubAsPart('A'))
   完全对称,没有上游 / 下游
```

接口骨架:

```ts
// packages/core/src/hub-link.ts (新)
export interface HubLink {
  readonly peerId: string             // 对端 hub 的 id
  readonly direction: 'in' | 'out' | 'inproc'
                                      // 谁发起的连接;inproc = 同进程嵌套
  readonly status: 'connecting' | 'open' | 'closed'

  // 发任务给对端
  dispatch(task: Task): Promise<TaskResult>

  // 推 / 拉 反馈(详见 §4)
  pullFeedbackFor(myId: string): Promise<FeedbackEntry[]>
  pushReadReceipt(entryIds: string[]): Promise<void>

  close(): Promise<void>

  // 事件
  on(event: 'task', handler: (t: Task) => Promise<TaskResult>): void
  on(event: 'message', handler: (m: ChannelMessage) => void): void
  on(event: 'closed', handler: () => void): void
}
```

**三种物理实现**(同一接口):
1. **inproc** — 同进程两个 hub,直接函数调用
2. **out (WebSocket client)** — 本端是连接发起方
3. **in (WebSocket server upgrade)** — 本端被动接受连接

### 2.3 Capability Mesh Routing — 无中心拓扑

每个 hub 只知道**自己直接连接的 peer**(peer table),**不维护全局拓扑表**。

任务派发流程:

```
hub.dispatch(task, strategy='capability:X')
   │
   ├─ 1. 查本地 participant: 有 capability X 的?
   │      ├─ 有 → 直接分配,完
   │      └─ 没 → 继续
   │
   ├─ 2. 查本地 peer table 的 capability 缓存:
   │      ├─ 哪个 peer 声明有 X?候选集合 P
   │      ├─ P 为空 → 完(返回 capability_unavailable)
   │      └─ P 非空 → 继续
   │
   └─ 3. 选一个 peer:**按本地 reputation 评分降序**(MVP 默认,可关)
          同分 round-robin。reputation 从 feedback ledger 派生,
          完整定义见 §3.5。新 peer(score=0)不歧视。
          调 peerLink.dispatch(task) → 返回结果给原 caller
```

**关键设计**:
- **不**做 2 跳以上的转发(避免环路 + 心智负担)。如果 peer 自己也找不到,它返回 `capability_unavailable`,原 hub 就直接失败
- 如果用户想要多跳,自己手动多拉几条边(显式优于隐式)
- 这是**故意保守**的——mesh 的力量在于"任何两个 hub 可以拉边",而不是"自动 transitive 查找"

**Capability 同步**:连接握手时,peer 互相通报 capability 列表;后续本地 capability 变更时主动 push 增量(实现简单,失败可忍——下次握手会全量重对账)。

### 2.4 Feedback Ledger — 反馈本地账本

详见 §3 完整设计。简述:

- 每个 hub 维护一个 **本地 ledger**,记录所有"我对别人的评价"
- 每条记录有三态:`created` → `delivered` → `read`
- 被评价方上线时主动 `pullFeedbackFor(myId)`,拿走属于自己的未读条目
- 被评价方处理完后 `pushReadReceipt(ids)`,评价方在本地把 `readAt` 填上

---

## 3. Feedback Ledger 详细设计

### 3.1 数据结构

```ts
export interface FeedbackEntry {
  id: string                  // uuid,本地生成
  toHub: string               // 被评价方 hub id
  toParticipant: string       // 被评价的具体 agent/human id
  taskRunId: string           // 对应的 task / workflow run
  scope: 'whole-task'         // 评价范围:整个 task
        | 'step'              //          某个 workflow step
        | 'contribution'      //          某条具体贡献(message/result)
  scopeRef?: string           // 当 scope=step|contribution 时的 ref id

  rating: number              // 例如 1-5 或 -1..+1,具体范围在配置里定
  comment?: string            // 自由文本
  tags?: string[]             // 例如 ['accurate', 'slow']

  evaluatorHub: string        // 评价方 hub id(写入时填自己)
  evaluatorParticipant: string // 评价方具体身份(admin / agent / 自动评估器)

  createdAt: number           // 写入本地的时间
  deliveredAt?: number        // 被评价方 hub 把它从 ledger 拉走的时间
  readAt?: number             // 被评价方回执"已读取"的时间
}
```

### 3.2 文件布局(评价方)

```
<space-root>/feedback/
  outbound.jsonl              # append-only,所有"我写的评价"
  outbound.index.sqlite       # 索引:by toHub / by status / by taskRunId
  state/
    by-hub/
      hubB.json               # { lastDeliveredAt, pendingIds: [...] }
      hubC.json
```

- `outbound.jsonl` 是 **不可变 append-only**(无 update,只 append 新的 receipt 行)
- `outbound.index.sqlite` 是从 jsonl 重建出来的索引,**真相在 jsonl**(可以删了重建)
- 状态变化(delivered / read)以**新行**追加(`{type: 'delivered', entryId, at}` / `{type: 'read', entryId, at}`),不修改老行 → 整个账本是 event-sourced

### 3.3 文件布局(被评价方)

```
<space-root>/feedback/
  inbound.jsonl               # append-only,所有"别人评价我的"
  inbound.index.sqlite        # 索引:by taskRunId / by evaluatorHub / by participant
```

被评价方收到 feedback 后,**复制一份到自己的 inbound.jsonl**。即使评价方那边的 outbound 丢了,自己手里还有副本。

### 3.4 同步协议(pull + receipt)

```
        Hub A (评价方)                              Hub B (被评价方)
        ─────────────                              ─────────────
        ledger.append({                            (B 刚连上 A)
          toHub: 'B',
          toParticipant: 'agentX',
          rating: 5, ...
        })                                         link.pullFeedbackFor('B')
                                                   ──────────────────────►
        ◄──────────────────────
        scan outbound where
          toHub='B' AND deliveredAt=null
        → 返回 [entry1, entry2]
        mark deliveredAt = now (append receipt row)

                                                   foreach entry:
                                                     inbound.append(entry)
                                                     trigger UI / event
                                                     (B 的 admin 看到了)

                                                   link.pushReadReceipt(
                                                     ['entry1', 'entry2']
                                                   )
                                                   ──────────────────────►
        ◄──────────────────────
        foreach id:
          outbound.append({type:'read', entryId:id, at:now})
        (B 那边的 ledger 里 readAt 也记上)
```

**关键性质**:
- 评价方**不知道**被评价方什么时候上线;被评价方上线后自己来 pull
- 整个流程**幂等**:重复 pull 同一批 entry 没副作用(deliveredAt 已有就不再 append)
- 整个流程**断连安全**:任何一步中断,信息留在两端本地不丢,下次接续

### 3.5 Peer Reputation — 从 feedback 派生(Q1 决议引入)

> 由 Q1 评审决定:**reputation 系统 MVP 就上**,跟 feedback ledger 同期上线。
> 整个机制是**每个 hub 本地视角**——没有全局 reputation 服务,完全符合"无服务器"约束。

**核心原则**:
- 每个 hub 在本地维护"**我看每个 peer 的分数**"(per-link,不是全局)
- 分数从**自己写出去的评价**自动派生(我评 5 星 → 我对该 peer 评分 +;反之 -)
- 分数**只影响自己的路由决策**——不传播、不共识、不广播
- 别人怎么看这个 peer 我**不知道也不关心**(自由扩展拓扑的代价 = 自治判断)

**数据结构**:

```ts
export interface PeerReputation {
  peerHubId: string
  score: number              // -1.0 到 +1.0,初始 0(中性,新 peer 不歧视)
  sampleCount: number        // 参与计算的 entry 数(被 reject 的不算)
  lastUpdatedAt: number
  byCapability?: Record<     // 同 peer 不同 capability 表现可能差很多
    string,
    { score: number; n: number }
  >
}
```

**文件布局**:

```
<space-root>/feedback/
  reputation/
    {peerHubId}.json         # 每个 peer 一个文件,无 jsonl,直接 overwrite
                             # 真相在 outbound.jsonl,这里是派生缓存
```

reputation 文件**可以删了重建**——遍历 `outbound.jsonl`,跳过 rejected 和被覆盖的老评价,跑一遍 EWMA 就重建出来。

**计算公式(MVP 用最简单的)**:

```
EWMA(指数加权移动平均):
  score_new = α × score_old + (1 - α) × rating_normalized
  α = 0.7    (老评价占 70%,新评价占 30%)

rating_normalized:把原 rating 映射到 [-1, +1]
  例如 1-5 制:(rating - 3) / 2  →  1→-1, 3→0, 5→+1
```

**更新时机**:
| 事件 | 动作 |
|------|------|
| 写入 outbound entry(新评价) | **立即**更新本地 reputation(不等 deliver) |
| 收到 rejected receipt | **回滚**那条 entry 对 reputation 的贡献(简单做法:整体重算) |
| 收到 read receipt | 不更新(reputation 已经在写入时算过了) |
| Q3 的覆盖评价 | 老的不算,只算最新——重算 |

**对路由的影响(§2.3 第 3 步的修订)**:
- 多个 peer 都声明有 capability X 时,**按 reputation 排序**选;同分 round-robin
- 用户可配置关掉(`router.useReputation: false`),回退到 pure round-robin
- 新 peer(score=0)跟"未被评分的老 peer"打平,**不歧视新人**

**对原 §5 MVP 切片的影响**:
- M4 路由实现要带 reputation lookup(不能事后补)
- **新增 M5b**:reputation 派生 + 持久化 + 路由集成 ——见 §5 修订表

---

### 3.6 被评价方的查询 API(C5)

```ts
// 在 hub B 上
hub.feedback.myInbound({
  taskRunId?: string         // 限定某个 task
  scope?: 'whole-task' | 'step' | 'contribution'
  fromHub?: string           // 限定某个评价方
  unreadOnly?: boolean
}): FeedbackEntry[]

// 例如:看自己在 runId=xxx 这个 workflow 里所有评价
hub.feedback.myInbound({ taskRunId: 'xxx' })
// → [
//     {evaluatorHub: 'A', scope: 'step', scopeRef: 'portrait', rating: 5, ...},
//     {evaluatorHub: 'A', scope: 'step', scopeRef: 'body',     rating: 3, comment: '太啰嗦', ...},
//     {evaluatorHub: 'A', scope: 'whole-task',                 rating: 4, ...},
//   ]
```

---

## 4. 关键流程示例

### 4.1 个人 hub + 团队 hub 拉边

```
小明:
  - 他笔记本上跑 personalHub(里面有 1 个 HumanParticipant=他自己 + 5 个 agent)
  - 他加入了某个写作团队 → 在 teamHub.example.org 拉一条边

执行:
  $ gotong link add wss://teamhub.example.org --as-id 'xiaoming-personal'

效果:
  personalHub ←──── HubLink ────► teamHub
       │                              │
       内部 5 个 agent          内部 admin + 30 个 agent

  小明在 personalHub 派一个任务,strategy=capability:'long-form-research'
  → 本地查:5 个 agent 没人有 long-form-research
  → peer table:teamHub 有 long-form-research(3 个 agent 候选)
  → link.dispatch 出去
  → teamHub 在自己内部分配,跑完,结果回流

  小明在 personalHub 上看到结果 → 给评价(rating 5)
  → personalHub.feedback.outbound.append(...)
  → 等 teamHub 那个 agent 下次连进来时,自己来 pull
```

### 4.2 三个 hub 的非层级拓扑

```
        hubA ◄──link──► hubB
          ▲                ▲
          │                │
        link             link
          │                │
          ▼                ▼
                hubC

   三条边、三个 peer,没有"谁是根"。
   hubA 派任务找 capability X:本地没,问 B、问 C(并发 / 串行可配),谁有谁接。
   hubA 不知道也不关心 B 跟 C 之间有没有边。
```

### 4.3 离线评价 → 上线收回执

```
T0:  hubA 完成 hubB 派的任务,hubB 写评价 → outbound.jsonl(deliveredAt=null)
T1:  hubA 关机
T2:  hubB 反复试图推 → 失败,无所谓,数据在 outbound.jsonl 等着
T3:  3 天后 hubA 重新上线,主动连 hubB
T4:  握手完成,hubA 主动 link.pullFeedbackFor('A') → 拿到 T0 那条评价
T5:  hubA 内部 UI / 通知用户:"你 3 天前的工作有评价了:rating=4,comment='...'"
T6:  用户在 hubA 看了 → link.pushReadReceipt([entryId])
T7:  hubB 的 outbound.jsonl 追加 {type:'read', entryId, at:T7}
```

---

## 5. MVP 切片 — 最小可跑通版本

按依赖顺序,每一刀都能独立验证、独立回滚:

| 切片 | 内容 | 验证标准 | 估计工作量 |
|------|------|---------|----------|
| M1 | `HubAsParticipant` 适配器 + 单测 | 同进程嵌套两个 hub,外层 hub.dispatch 能命中内层 hub 里的 agent | 0.5 天 |
| M2 | `HubLink` 接口 + inproc 实现 | 两个 in-memory hub 通过 HubLink 互发 task,结果对称回流 | 0.5 天 |
| M3 | `HubLink` 的 WebSocket 实现(对称版,不是 TeamBridge) | 两个进程的 hub 用 ws 互连,跨进程 dispatch 跑通 | 1 天 |
| M4 | Capability mesh routing(本地优先,peer 候选 1 跳) | 三个 hub 拉成三角,只在 hub C 上有 cap X 的 agent,hub A 派 X 能命中 | 1 天 |
| M5 | Feedback ledger 写入端(append-only jsonl + 索引重建) | hub B 评价 → outbound.jsonl 落盘,索引能查 | 0.5 天 |
| **M5b** | **Peer reputation 派生 + 路由集成**(Q1 决议引入) | 写 feedback 时同步更新 `reputation/{peerId}.json`;M4 的路由从 round-robin 升级到 reputation 排序;rejected entries 不算分;reputation 文件可从 jsonl 重建 | **1 天** |
| M6 | Pull-on-connect 协议 | hub A 上线 → 主动 pull → inbound.jsonl 落盘 | 0.5 天 |
| M7 | Read receipt 协议(含 'rejected' 类型,Q4) | hub A 标记已读 → outbound.jsonl 出现 read 行;拒收时出现 rejected 行,reputation 回滚那条贡献 | 0.5 天 |
| M8 | `hub.feedback.myInbound()` 查询 API + 简单 UI | 在 hub A 的 admin 页能看到"别人给我的评价"列表 | 0.5 天 |
| M9 | E2E: 完整三 hub mesh + 跨 hub 评价 + 离线/上线回执 + reputation 影响路由 | 一个集成测试覆盖 §4 三个场景 + 一个"评分低的 peer 在下一轮路由优先级降低"的场景 | 1 天 |

**总计** ~7 天 MVP(Q1 决议加了 M5b ~1 天),跑完后六条想法全部 first-class 落地。

每一刀都有可执行的测试,失败了 revert 一刀就能回到上一稳定态。

---

## 6. 跟现有代码的兼容

- **`TeamBridgeAgent` 不删**,标记为 deprecated。已有的非对称桥继续工作,文档引导新用户用 `HubLink`
- **`Hub.evaluate()` 不删**,内部增加"同时 append 到 outbound ledger"的副作用。老调用者无感
- **`Hub` 类不动**,新增 `HubAsParticipant` 在外层包装。`packages/core` 不破坏 ABI
- **`ParticipantKind` 不扩**,保持 `'agent' | 'human'`,hub adapter 对外是 `'agent'`(用 `metadata.isHubAdapter` 区分)
- **`Space` 不动**,但增加 `<space>/feedback/` 子目录(空目录 OK,首次写入时创建)

---

## 7. 开放问题 — 评审决议(2026-05-22)

| # | 问题 | **决议** |
|---|------|---------|
| Q1 | 信任模型:peer 声称有 capability X,但实际乱搞,怎么办? | ✅ **Reputation 系统 MVP 就上**(超出原推荐)。本地维护对每个 peer 的评分,从 feedback 自动派生,影响路由选择。详见 §3.6 |
| Q2 | 评价里可能含敏感信息(comment),要不要加密? | ✅ MVP 不加密。ledger 在用户本机,跨机传输走 wss(TLS);后期按需加 |
| Q3 | 同一个 task,evaluator 改主意了,允许覆盖评价吗? | ✅ 允许 — append 一条新 entry,inbound 端取最新一条(latest wins);reputation 也只看最新值;老的留 jsonl 审计 |
| Q4 | 被评价方不想接受评价(拒收),怎么办? | ✅ 允许 + 通知评价方 — receipt 类型扩 `'rejected'`;评价方 outbound 标 rejected;**rejected 不计入 reputation**(跟 Q1 联动) |
| Q5 | hub id 怎么稳定? | ✅ Space 创建时生成 uuid(存 `space.json`),迁移走 space 目录拷贝;用户可取 alias 作可读别名;丢 space 就丢身份 |
| Q6 | 一个 hub 想"消失"(注销 + 撤回所有评价) | ✅ 接受设计代价 — append-only ledger 在各家本地有副本,做不到强制删除。可以 close 链接、不再接收新评价,跟 git 一个道理 |
| Q7 | 评价能不能匿名? | ✅ MVP 不支持 — `evaluatorHub` + `evaluatorParticipant` 都必填。问责明确,reputation 能跑通。后期可加"模糊化" |

---

## 8. 不在本设计内的事(明确排除)

- **Discovery / DHT**:hub 怎么找到别的 hub?**不解决** — 用户自己 `gotong link add wss://...`。"自由扩展"的代价就是用户负责连边
- **多跳路由**:已说明 §2.3,故意保守
- **强一致性**:整个系统是 eventually consistent,不追求 CAP 中的 C
- **拜占庭容错**:假设连进来的 peer 是用户认可的,不防恶意

---

## 9. 参考

- `docs/FEDERATION.md` — v1 单向桥(本设计的前身)
- `docs/ARCHITECTURE.md` — Participant 抽象、Hub 哲学
- `docs/zh/PROTOCOL.md` — wire protocol(HubLink 的 ws 实现复用其大部分)
- `packages/sdk-node/src/bridge.ts` — `TeamBridgeAgent` 现有实现
- `packages/core/src/hub.ts` — `Hub` 类、`evaluate()` 方法

---

**评审已完成(2026-05-22)**。§7 七题决议落定,§5 修订版含 9 刀(M1-M9,~7 天)。
**下一步**:等用户授权拉 task,逐刀实施。
**状态**:草案 → **MVP 待启动**
