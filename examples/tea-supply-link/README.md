# tea-supply-link — 奶茶店 ↔ 供货商 (跨组织供货链接)

> 北极星 **第 2 层「跨组织协作」**的一个组织 hub 案例:一家奶茶店的补货工作流,把一张
> 补货单**编排到另一个组织(供货商)的 hub** 上;凭证 / 数据 / 计费各归各家。Hub 网络是
> **自由图,不是层级树**——奶茶店不拥有供货商,只是有一条**经过策划的**链接到供货商的
> 某个能力。
>
> 这是前两个组织模板(cafe-ops 管理面 / warband-club 协作面)之后的**第一个跨组织
> (cross-org)** 案例,直接吃 Stream G 的跨 hub 编排 + 出站审批闸。

```
        奶茶店 (org A, 下单)                                供货商 (org B, 履约)
  ┌────────────────────────────────┐               ┌──────────────────────────┐
  │ workflow: tea-shop-restock     │               │  supplier-fulfillment     │
  │   draft  → cap[teashop.         │               │  cap: supplier.           │
  │            draft-order] (本地)  │               │       confirm-order       │
  │   place  → cap[supplier.        │               │  (按自家目录定价 + 货期)  │
  │            confirm-order] ──────┼───────────────┼─▶                         │
  │   record → cap[teashop.         │               └──────────────────────────┘
  │            record-order] (本地) │                          ▲
  └────────────────────────────────┘                          │ ④ 店长批准后才跨界
            │  ① place 步派 capability                         │
            ▼                                                  │
  ┌────────────────────────────────┐    installPeerLink        │
  │ peer wrapper (advertises        │───────────────────────────┘
  │   [supplier.confirm-order])     │      ② 出站审批闸挂起
  │   wrapped in approval gate      │      ③ 店长在 /me 批准
  └────────────────────────────────┘
            │  回流: 供货商的价格 / 货期 → place.output → record 步 (本地建档)
            ▼
  ┌────────────────────────────────┐
  │ shop-desk  cap: teashop.        │  ⑤ 本地建档采购单 (PO)
  │            record-order         │
  └────────────────────────────────┘
```

## 两个交付物

| 交付物 | 是什么 | 跑 |
|---|---|---|
| **可跑 demo** | 两个 in-proc hub(奶茶店 + 供货商),内联出站审批闸 + 两步恢复,确定性自断言 | `pnpm demo:tea-supply-link` |
| **可载入模板** | 奶茶店一侧的 `aipehub.template/v1`(1 agent + 1 跨组织工作流 + KB 槽位) | `pnpm demo:tea-supply-link:template` |

## ★ 模版和框架是分离关系(本案例的教学点)★

模板(`template/tea-shop.template.yaml`)**只**带「奶茶店一侧的编排骨架」:采购助手
agent、补货工作流、供货商目录 KB 槽位、一次性 key 提示。

它**不**带、也**不能**带「跨组织的链接」本身:

| 这件事 | 住在哪 |
|---|---|
| 哪个 peer 是你的供货商 | **运行时** peer 配置(host `installPeerLink` / admin「联邦」tab) |
| 出站放行哪些 capability(`outboundCaps`) | **运行时** per-link 信任契约 |
| 订单外发是否需要店长审批(`requireApprovalOutbound`) | **运行时** per-link 信任契约 |
| 工作流的 `place` 步 | 只写一个 **capability 名**(`supplier.confirm-order`),**从不点名某个 peer** |

换句话说:**模板是「可搬走的骨架」,链接是「落地时各自配的运行时契约」**。两个奶茶店
导入同一个模板,各自连各自的供货商,凭证 / 数据 / 计费互不串线。这正是「自由图,不是
层级树」落到一个具体的 B2B 场景。

## ★ 跨组织审批 ≠ 工作流里的 `human:` 步 ★

对比 cafe-ops(店内加班审批用工作流 `human:` 步,店长在同一个 hub 里批):

- 这里订单「是否准予跨出组织」由**出站审批闸**决定 —— 供货商 peer 标了
  `requireApprovalOutbound`,host 把出站任务挂起在店长的收件箱,批准了才越过边界。
- 这一层是**框架运行时**的事(Phase 18 / Stream G),对工作流**透明**,所以这条工作流
  里**没有** `human:` 步。它是 Phase 16 human-inbox broker 的**跨 hub 孪生**——同一套
  suspend/resume,只是批准时它**转发**给远端,而不是把决定当输出返回。

## 这个 demo 证明了什么(确定性,无需 API key)

| 剧情 | 结果 |
|---|---|
| **[A] 批准** | 工作流先**本地**起草补货单 → `place` 步派给供货商 → 运行**挂起**在审批闸(什么都还没跨界)→ 店长在收件箱批准 → 订单终于跨到供货商 → 供货商**确定性定价**(珍珠 18×20 + 红茶叶 45×10 + 全脂牛奶 6×30 = **¥990**)回流成步骤输出 → 下一步(**本地**)`record` 建档采购单 → 运行完成。 |
| **[B] 拒绝** | 一张可疑的超量大单;店长拒绝。供货商**从未**被联系,本地 `record` 步**从未**运行,运行 **fail-closed**。 |

**钱是供货商确定性算的,不是 LLM 算的**(同 cafe-ops 的加班金额):采购助手只起草不
定价,价格 / 货期由供货商在另一个 hub 上返回。

## 为什么 host-free(同 cafe-ops / cross-hub-workflow 先例)

这个 demo 只依赖 `@aipehub/core` + `@aipehub/workflow` + `@aipehub/inbox`,把宿主机的两个
组件**内联成可见的 ~40 行**,让机制不被埋在 host 二进制里:

- `OutboundApprovalGate` = `packages/host/src/outbound-approval.ts` 的最小镜像
  (`ApprovalGatedParticipant`)。生产里它由 `installPeerLink` 的 `wrapOutbound` 钩子装上。
- `resolveApproval` = `packages/host/src/inbox-service.ts` `HostInboxService.resolve`
  两步恢复的手写镜像(**子闸严格先于父 workflow**)。生产里它由 `/me` 收件箱点一下批准触发。

真正的跨 hub 链路是真的:`createInprocHubLinkPair` + `installPeerLink`(都来自
`@aipehub/core`),两个真 `Hub`,真 `parseWorkflow` + `WorkflowRunner`。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/tea-shop-restock.yaml` | 声明式工作流:`draft`(本地)→ `place`(跨组织能力)→ `record`(本地)。**YAML 里没有任何 peer 的名字,也没有 `human:` 步。** |
| `src/standins.ts` | 两个确定性 stand-in:奶茶店 `ShopDeskStandin`(起草 + 建档)+ 供货商 `SupplierStandin`(按目录定价)。 |
| `src/index.ts` | 两个 in-proc hub + 内联审批闸 + 两步恢复镜像 + 确定性自断言。 |
| `template/tea-shop.template.yaml` | 奶茶店一侧的可载入模板(1 agent + 1 跨组织工作流 + KB 槽位)。**链接不在里面。** |
| `src/load-template.ts` | 载入演示(config-preview,不起 mcp-obsidian、不开 peer 链接)。 |

## 对应的生产组件

| demo 内联 | 生产真东西 |
|---|---|
| `OutboundApprovalGate` | `host/src/outbound-approval.ts` `ApprovalGatedParticipant`(`installPeerLink({wrapOutbound})`) |
| `resolveApproval` 两步恢复 | `host/src/inbox-service.ts` `HostInboxService.resolve` + `/me` 收件箱点批准 |
| `parked` Map(suspendNotifier) | identity `suspended_tasks` 表 + resume sweep |
| `remoteCapabilities` / `outboundCaps` 手动穿线 | `host/src/peer-registry.ts` 从 per-link 信任契约自动穿(admin「联邦」tab 编辑) |
| `SupplierStandin`(另一个 hub) | 供货商自己的 AipeHub,服务 `supplier.confirm-order`(可以是 LlmAgent、CLI、或又一条工作流) |

## 决策 #4 / #5 框定

- **#4(模板带结构 + 引用,永不带知识内容)**:KB 槽位 `supplier_catalog` 只带「MCP 接线
  + presetData 指针」。供货商目录(可订物料 / 规格 / 起订量)是你自己的 Obsidian vault,
  不在模板里。
- **#5 + 本案例新增的一条**:**跨组织的链接也不在模板里**。链接是运行时 per-link 信任
  契约(peer + outboundCaps + 审批策略),导入模板后到 admin「联邦」tab 配。

## 安全边界

- **钱供货商算,人定外发**:价格 / 货期由供货商在自己的 hub 上确定性返回(采购助手只
  起草不定价);订单跨出组织前必须店长在出站审批闸批准。
- **拒绝即 fail-closed**:店长拒绝时供货商从未被联系,本地建档步从未运行。
- **跨组织隔离**:链接是 per-link 的;一个奶茶店连多个供货商时,每条链路的出站放行 /
  数据分类 / 配额互不串线(见下「进阶可叠加」)。

## 进阶可叠加(本 demo 故意不做,保持聚焦)

- **节点级数据分类闸(C-M2)**:给 `place` 步加 `dataClasses: [...]`,配 per-link
  `allowedDataClasses` → 越界的数据分类在出站闸被拦(同一个 chokepoint)。
- **per-link 配额(P4-M4)**:给供货商链路配 `perLinkQuotaBudget` → 跨 hub 下单计入预算,
  超额 fail-closed。
- **可调用 KB 白名单(C-M1)**:若供货商还共享一个 MCP 目录,per-link
  `allowedKnowledgeBases` 决定奶茶店能不能查。

详见 [`docs/zh/V5-G-FINAL.md`](../../docs/zh/V5-G-FINAL.md)(跨 hub 工作流编排)与
[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)(上手 hub 目录)。
