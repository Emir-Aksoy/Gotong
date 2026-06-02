# v5 · Stream C — 联邦授权细化（小结）

> 状态: **Stream C 完**（C-M1 ~ C-M3）。接在 Stream B（模板系统）之后——B 把「可寻址
> 知识库槽位」立起来，C 给这些槽位 + 工作流节点接上**联邦授权维度**。**Stream C 完即
> v5 全部完**（D / 0 / A / B / C 五条流全部落地）。
>
> Last updated: 2026-06-02

---

## 一、为什么做（北极星缺口）

北极星第 2 层是「人 / agent ↔ 别的人 / agent / 机构」，关键约束:**Hub 网络是自由图，
不是层级树——每条 link 各带各的信任契约，限制一个 peer 绝不外溢到另一个**。

到 Phase 19 P4，per-link 契约已有三维:**入站 ACL**、**出站 capability 白名单**、
**出站 data-class + 配额 + 撤销**。但用户改口（2026-05-31 拍板）把授权粒度再细化两刀:

> **不**按「对面具体某个人」授权（撤掉跨 hub per-user 设想）；授权给**具体 hub**，
> scope 到「**可调用的知识库**」+「**workflow 节点的输入 / 输出**」。

两个缺口，正是 Stream C 两个执行里程碑:

- **C.1 可调用知识库** — peer 能 reach 本 hub 的共享 MCP server（B 的 KB 槽位模型:
  一个 KB == 一个共享 MCP server）。但今天**任何**受信 peer 看得见 + 调得动**每一个**
  共享 server。契约缺「这个 peer 能调哪些 KB（按名）」这一维。
- **C.2 节点级 I/O** — P4-M4 给每条 link 装了出站 data-class 闸，但**工作流 runner
  从不 stamp `Task.dataClasses`**，所以工作流的联邦派发对那个闸**隐形**。capability
  白名单是 link 级的，缺「**具体某个工作流节点**的 I/O 携带哪些 data-class」这一更细维。

不变量（贯穿）:

- **自由图，限制不外溢**:每条 link 的 KB 允许集、data-class 契约都**per-link 独立**，
  夹紧 orgX 绝不动 orgY。
- **闸是闸，不是 redaction**:KB 闸过滤 discovery + 拒 off-list call；node-I/O 闸在过
  wire 前拒，从不改写内容。
- **零新挂起 / 零新执行设施**:C-M1 复用现有 rpc responder 多路复用；C-M2 复用 P4-M4
  的出站 data-class 闸（零新闸），只补 runner 那一行 stamp。

---

## 二、动了什么（逐里程碑）

| M | commit | 干了啥 |
|---|---|---|
| **C-M1a** | `b5338aa` | identity 地基。schema **v17** `peer-link-knowledge-bases`:加性可空 `allowed_knowledge_bases_json TEXT`（NULL=全可调，legacy 默认；`[]`=锁死；`[names]`=白名单），完全镜像 P4-M4 data-class 列。`PeerStore`（PeerRow + addPeer + updatePeer undefined-保留/null-清空 + INSERT/UPDATE SQL + rowToPeerRegistration）+ 类型（`PeerRegistration`/`AddPeerInput`/`UpdatePeerInput`）。另导出 `MIGRATION_VERSIONS` 让 v16-isolation 测试「除 16 外全标已应用」免疫后续迁移。 |
| **C-M1b** | `dc6eadd` | 执行 + CRUD。新 `host/src/peer-kb-gate.ts`(纯函数,`core/peer-acl.ts` 形状):`gateKnowledgeBaseRpc(inner, allowed)` 包共享 rpc responder——`mcp.listShared`→**过滤**到白名单（peer 连别的 server 存在都不知道）/`mcp.listTools`+`mcp.callTool`→off-list **拒**（throw→rpc rejection）/其余方法（`peer.manifest` …）→直透。`peer-registry.kbGatedResponder(row)` 把它穿进 `dialOne` + `installInboundLink` 两条 install 路径（null→不包/全可调；显式 list→包）。web peer CRUD 收 + 校验 `allowedKnowledgeBases` 镜像 data-class。 |
| **C-M2** | `77daf00` | 节点级 I/O 授权。`DispatchSpec.dataClasses?: string[]`(执行词汇,自由 tag,1:1 比 link 的 `allowedDataClasses`;区别于 workflow 级 `governance.dataSensitivity` 枚举=人看的风险摘要)。schema `validateDispatchSpec` 解析+校验;runner `dispatchOne` **stamp** 到派发 opts→活 `Hub.dispatch` 带到 `Task.dataClasses`→P4-M4 出站闸**按节点**判。本地派发无闸（闸在联邦 wrapper 上）。**零新闸**——只补 runner 那一行。 |
| **C-M3** | （本提交） | Stream C 合并验收门 + 本文。`host/tests/stream-c-isolation-e2e.test.ts`:一 home 连两 peer（orgX 两维都夹紧、orgY 全开），一次证两条新维**跨 peer 互不污染**——KB 轴（orgX listShared 只见 kb-a、callTool kb-b 拒;orgY 见+调俩）+ node-I/O 轴（同一 pii 节点发 orgX 拒、发 orgY 通;orgX 只收到 public 任务）。+ `docs/zh/V5-C-FINAL.md` + CLAUDE.md 收口。 |

---

## 三、两条新维的执行点（一图说清）

```
  Peer (orgX, 夹紧)                         Home Hub
  ┌──────────────────┐                      ┌─────────────────────────────────┐
  │                  │                      │ identity.peers[orgX]:           │
  │  KB discovery    │  link.rpc(           │   allowedKnowledgeBases:['kb-a']│
  │  + call          │   'mcp.listShared')  │   allowedDataClasses:  ['public']│
  │     ────────────────────────────────►   │                                 │
  │                  │                      │ ① C-M1 rpc 闸 (peer-kb-gate):   │
  │  ◄── [kb-a] only │  ◄────────────────── │   listShared 过滤 / callTool 拒  │
  │                  │                      │   off-list → 共享 McpProxyHost   │
  │                  │                      │                                 │
  │  ◄── 工作流派发   │   RemoteHubViaLink   │ ② C-M2 dispatch 闸 (P4-M4):     │
  │      (svc-x)     │   .onTask 过 wire 前 │   workflow node.dataClasses     │
  │  public 任务到达 │  ◄────────────────── │   → Task.dataClasses             │
  │  pii 任务被拒    │  outbound_data_class │   vs allowedDataClasses          │
  │                  │  _denied:pii         │                                 │
  └──────────────────┘                      └─────────────────────────────────┘
        orgY (全开): 两维 NULL → rpc 不包闸 / 派发不带 dataClasses 闸 → 全通
```

一句话:**KB 维走 rpc（discovery + call），node-I/O 维走 dispatch（Task.dataClasses）；
两维都 per-link，夹紧一条不外溢。**

---

## 四、关键设计决策

1. **诚实的执行点:KB 闸在 rpc responder，不在 dispatch。** 侦察草稿曾建议在
   `RemoteHubViaLink.onTask` 加 `task.requestedKnowledgeBases` 字段判——但 KB 调用过的是
   `mcp.callTool` rpc，**从不**走 task dispatch，那字段永不被设。读真代码后定:闸必须包
   per-link 的 `rpcResponder`（`dialOne` + `installInboundLink` 里 `row` 在作用域内），
   匹配的标识 = 共享 MCP server **名**（KB 模板里就等于 KB 槽位名）。

2. **KB 闸是纯函数,放 `peer-kb-gate.ts`。** 跟 `core/peer-acl.ts` 同形状——无 hub /
   identity / io,单测隔离。peer-registry 决定**何时**用（仅当 row 带显式白名单）;null
   走「不包」分支。三态:null=全可调（legacy）/`[]`=锁死/`[names]`=白名单。

3. **discovery 过滤 > 只拒 call。** `listShared` 直接滤掉 off-list server——peer 连它们
   存在都不知道,无从探测;`callTool` 的拒是「猜名」的 fail-closed 兜底。两层都有。

4. **node-I/O 复用 P4-M4 出站闸,零新闸。** C-M2 不发明新执行设施——P4-M4 的
   `checkOutboundDataClasses` 早在 `RemoteHubViaLink` 里;缺的只是 runner 把节点声明的
   data-class **stamp** 到 task。补一行 `if (spec.dataClasses) opts.dataClasses = ...`,
   闸自然按节点 fire。这把 P5 governance 那个「声明非执行」的 data 维，对**联邦派发**变成
   真闸。

5. **两套 data 词汇,故意分开。** 节点 `dataClasses: string[]` = 执行词汇（自由 tag,
   1:1 比 link 的 `allowedDataClasses`）;workflow 级 `governance.dataSensitivity` 枚举
   （public/internal/confidential/pii）= 人看的风险摘要,import 前在 admin UI 渲染。前者
   gate,后者 doc,不缠在一起。

6. **撤掉跨 hub per-user（C.3 不做）。** 上一轮提过 `requireUserId` 跨 hub 设想——
   本 Stream **明确不做**。principal id 是 hub 本地的,跨 hub per-user 授权语义不成立
   （hub A 的 alice ≠ hub B 的 alice,跟 B-M4「人员永不还原」同源）。授权落在「具体 hub
   + KB + 节点 I/O」三个 hub-local 可判的维度上。

7. **加性、可空、不破现有行。** schema v17 是加性 ALTER（可空列）,符合「不需要向前
   兼容」但不破坏现有 peer 行(NULL=legacy 全放)。runner 的 `dataClasses` 可选,现有
   ~30 处 DispatchSpec 构造零改动。

8. **合并验收门证「组合」,不重测单维。** 单维已各有 E2E（peer-kb-isolation /
   workflow-node-io）;C-M3 专证**两维 × 两 peer**的组合不变量——夹紧 orgX 两维都不碰
   orgY。这是任何单边 / 单维测试给不出的隔离保证。

---

## 五、测试 / 验证

| 包 | 新增 | 覆盖 |
|---|---|---|
| `identity` (peers) | 4 (C-M1a) | callable-KB 白名单默认 null / round-trip 含 `[]` 锁死 / undefined-保留·null-清空 / 不碰 data-class |
| `host` (peer-kb-gate) | 9 (C-M1b) | 纯闸:listShared 过滤 / `[]` 锁死 / 非数组直透 / call 放行 on-list / call 拒 off-list（inner 不被调）/ 缺 server 参数拒 / `peer.manifest` 直透 |
| `host` (peer-kb-isolation-e2e) | 2 (C-M1b) | 真 inproc link:夹紧 orgX 到 [kb-a]、orgY 全开;`[]` 锁死一 peer、兄弟全开 |
| `web` (identity-routes-peers) | 5 (C-M1b) | `allowedKnowledgeBases` 持久 / null 默认 / `[]` 锁死不被强转 null / 非数组 400 / PATCH null 清空 |
| `workflow` (schema + runner) | 6 (C-M2) | parse 带 / 不带 / 非数组拒 / 非字串元素拒;runner stamp 单节点 + 多节点各异（bare 节点不 stamp）|
| `host` (workflow-node-io-e2e) | 2 (C-M2) | 真 runner 过夹紧 link:public 节点通、pii 节点拒（同工作流两判）;全 public 工作流整体通 |
| `host` (stream-c-isolation-e2e) | 2 (C-M3) | **合并门**:KB 轴 + node-I/O 轴各自跨 orgX/orgY 隔离 |

全量绿:`identity` 352 / `host` 521 / `web` 639 / `workflow` 224。各包 `build`（tsc）干净,
无静态资源漂移。

---

## 六、不做 / 后续

- **per-node KB 维 admin UI 编辑器**:`allowedKnowledgeBases` 今天经 web peer CRUD 路由
  （API）配置,admin UI 富编辑器（勾选共享 server 名）沿用 P4 B-M2 先例推迟。
- **节点级 dataClasses 的 admin UI 呈现**:governance 面板已显示 workflow 级
  `dataSensitivity`;per-node `dataClasses` 的可视化推迟（数据已透传,补渲染即可）。
- **KB 闸的入站审计**:off-list call 被拒今天是 rpc rejection,没单独写审计行。要的话
  接 `audit_log`（同 `cross_org_acl_denied` 形状）。
- **data-class redaction**:闸是「拒整个 task」,不做「擦掉敏感字段后放行」。出站
  redaction hook 仍是 P4 推迟项。
- **per-link 配额按 KB / 按节点细分**:配额仍是 per-link 总量（P4-M4）;按 KB / 按节点
  分桶推迟。

---

## 七、一句话

**Stream C 给 per-link 契约补上最后两维:peer 能调哪些知识库（rpc 路径,discovery 过滤
+ off-list 拒）、工作流节点的 I/O 携带哪些 data-class（dispatch 路径,Task.dataClasses
按节点判）。两维都 per-link 独立,夹紧一条 link 绝不外溢到另一条——合并验收门钉死。
至此 v5 五条流（心跳 / hub 收敛 / 归属泛化 / 模板 / 联邦授权）全部落地。**
