# tea-chain-hq — 连锁奶茶店总部 → 加盟门店 (跨组织指令下发)

> 北极星 **第 2 层「跨组织协作」**的一个组织 hub 案例,也是三层链条的**最上一层**:
> 连锁总部把一条指令(如调价)**下发到另一个组织(加盟门店)的 hub** 上;凭证 / 数据 /
> 计费各归各家。Hub 网络是**自由图,不是层级树**——总部和加盟门店是两个**主权组织**,
> 总部不「拥有」门店的 hub,只是有一条**经过策划的**、可被门店一侧**审批**的链接。
>
> 这是 `tea-supply-link` 的 **MIRROR、方向相反**:那个案例编排**朝上**(门店 → 供货商),
> 这个案例编排**朝下**(总部 → 门店),复用同一套出站审批闸。

```
     连锁总部 (org HQ) ──下发指令──▶ 加盟门店 (org shop) ──下补货单──▶ 供货商 (org supplier)
        [本案例: HQ → shop]                [tea-supply-link: shop → supplier]

  门店在三层链条的中间:对上**接收**总部的指令(总部朝下编排 = 本案例),
  对下**发出**给供货商的订单(门店朝上编排 = tea-supply-link)。两条都是跨组织。
```

本案例的跨组织数据流(approve 剧情):

```
        连锁总部 (org HQ, 下发)                            加盟门店 (org shop, 执行)
  ┌────────────────────────────────┐               ┌──────────────────────────┐
  │ workflow: chain-directive-      │               │  shop-execution           │
  │           rollout               │               │  cap: shop.               │
  │   draft   → cap[chainhq.        │               │       apply-directive     │
  │             draft-directive](本地)│              │  (按本店菜单应用调价 +    │
  │   rollout → cap[shop.            │               │   算差额 + 回执)          │
  │             apply-directive]─────┼───────────────┼─▶                         │
  │   record  → cap[chainhq.         │               └──────────────────────────┘
  │             record-rollout](本地) │                         ▲
  └────────────────────────────────┘                          │ ④ 区域经理批准后才跨界
            │  ① rollout 步派 capability                       │
            ▼                                                  │
  ┌────────────────────────────────┐    installPeerLink        │
  │ peer wrapper (advertises        │───────────────────────────┘
  │   [shop.apply-directive])       │      ② 出站审批闸挂起
  │   wrapped in approval gate      │      ③ 区域经理在 /me 批准
  └────────────────────────────────┘
            │  回流: 门店的现价 / 新价 / 差额 → rollout.output → record 步 (本地建档)
            ▼
  ┌────────────────────────────────┐
  │ hq-desk    cap: chainhq.        │  ⑤ 本地建档下发记录 (DIR)
  │            record-rollout       │
  └────────────────────────────────┘
```

## 两个交付物

| 交付物 | 是什么 | 跑 |
|---|---|---|
| **可跑 demo** | 两个 in-proc hub(总部 + 门店),内联出站审批闸 + 两步恢复,确定性自断言 | `pnpm demo:tea-chain-hq` |
| **可载入模板** | 总部一侧的 `gotong.template/v1`(1 agent + 1 跨组织工作流 + KB 槽位) | `pnpm demo:tea-chain-hq:template` |

## ★ 模版和框架是分离关系(本案例的教学点,同 tea-supply-link)★

模板(`template/chain-hq.template.yaml`)**只**带「总部一侧的编排骨架」:下发协调员
agent、下发工作流、连锁运营手册 KB 槽位、一次性 key 提示。

它**不**带、也**不能**带「跨组织的链接」本身:

| 这件事 | 住在哪 |
|---|---|
| 下发给**哪家 / 哪些**加盟门店 | **运行时** peer 配置(host `installPeerLink` / admin「联邦」tab) |
| 出站放行哪些 capability(`outboundCaps`) | **运行时** per-link 信任契约 |
| 指令外发是否需要区域经理审批(`requireApprovalOutbound`) | **运行时** per-link 信任契约 |
| 工作流的 `rollout` 步 | 只写一个 **capability 名**(`shop.apply-directive`),**从不点名某个门店 peer** |

换句话说:**模板是「可搬走的骨架」,链接是「落地时各自配的运行时契约」**。多个连锁
体系导入同一个模板,各自连各自的加盟门店,凭证 / 数据 / 计费互不串线。

**单店 vs 多店都是运行时的事,工作流一字不改**:

- **单店**:`rollout` 步的 capability 解析到那一条链接的加盟门店;
- **多店**:总部连多条加盟门店链路(或用 broadcast 策略)→ 同一条工作流下发到全部
  门店。要不要给某条链路单独配审批 / 出站放行,也都是 per-link 的运行时契约。

## ★ 跨组织审批 ≠ 工作流里的 `human:` 步 ★

对比 cafe-ops(店内加班审批用工作流 `human:` 步,店长在同一个 hub 里批):

- 这里指令「是否准予跨出总部」由**出站审批闸**决定 —— 加盟门店 peer 标了
  `requireApprovalOutbound`,host 把出站任务挂起在区域经理的收件箱,批准了才越过边界。
- 这一层是**框架运行时**的事(Phase 18 / Stream G),对工作流**透明**,所以这条工作流
  里**没有** `human:` 步。它是 Phase 16 human-inbox broker 的**跨 hub 孪生**——同一套
  suspend/resume,只是批准时它**转发**给远端门店,而不是把决定当输出返回。

## 这个 demo 证明了什么(确定性,无需 API key)

| 剧情 | 结果 |
|---|---|
| **[A] 批准** | 工作流先**本地**起草下发单 → `rollout` 步派给门店 → 运行**挂起**在审批闸(指令还没离开总部)→ 区域经理在收件箱批准 → 指令终于跨到门店 → 门店**确定性应用调价**(珍珠奶茶 ¥14 → ¥15 = **Δ+1**)回执回流成步骤输出 → 下一步(**本地**)`record` 建档下发记录 → 运行完成。 |
| **[B] 拒绝** | 一条可疑的激进翻倍涨价;区域经理拒绝。门店**从未**被联系,本地 `record` 步**从未**运行,运行 **fail-closed**。 |

**调价是门店确定性算的,不是 LLM 算的**:下发协调员只起草下发单不替门店应用;现价 /
新价 / 差额由门店在自己的 hub 上**按本店菜单**应用并回执(门店拥有自己的现价,总部提出
新价,门店应用并报回)。区域经理只定「这条指令准不准外发」。

## 为什么 host-free(同 tea-supply-link / cross-hub-workflow 先例)

这个 demo 只依赖 `@gotong/core` + `@gotong/workflow` + `@gotong/inbox`,把宿主机的两个
组件**内联成可见的 ~40 行**,让机制不被埋在 host 二进制里:

- `OutboundApprovalGate` = `packages/host/src/outbound-approval.ts` 的最小镜像
  (`ApprovalGatedParticipant`)。生产里它由 `installPeerLink` 的 `wrapOutbound` 钩子装上。
- `resolveApproval` = `packages/host/src/inbox-service.ts` `HostInboxService.resolve`
  两步恢复的手写镜像(**子闸严格先于父 workflow**)。生产里它由 `/me` 收件箱点一下批准触发。

真正的跨 hub 链路是真的:`createInprocHubLinkPair` + `installPeerLink`(都来自
`@gotong/core`),两个真 `Hub`,真 `parseWorkflow` + `WorkflowRunner`。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/chain-directive-rollout.yaml` | 声明式工作流:`draft`(本地)→ `rollout`(跨组织能力)→ `record`(本地)。**YAML 里没有任何 peer 的名字,也没有 `human:` 步。** |
| `src/standins.ts` | 两个确定性 stand-in:总部 `HqDeskStandin`(起草 + 建档)+ 门店 `ShopStandin`(按本店菜单应用调价)。 |
| `src/index.ts` | 两个 in-proc hub + 内联审批闸 + 两步恢复镜像 + 确定性自断言。 |
| `template/chain-hq.template.yaml` | 总部一侧的可载入模板(1 agent + 1 跨组织工作流 + KB 槽位)。**链接不在里面。** |
| `src/load-template.ts` | 载入演示(config-preview,不起 mcp-obsidian、不开 peer 链接)。 |

## 对应的生产组件

| demo 内联 | 生产真东西 |
|---|---|
| `OutboundApprovalGate` | `host/src/outbound-approval.ts` `ApprovalGatedParticipant`(`installPeerLink({wrapOutbound})`) |
| `resolveApproval` 两步恢复 | `host/src/inbox-service.ts` `HostInboxService.resolve` + `/me` 收件箱点批准 |
| `parked` Map(suspendNotifier) | identity `suspended_tasks` 表 + resume sweep |
| `remoteCapabilities` / `outboundCaps` 手动穿线 | `host/src/peer-registry.ts` 从 per-link 信任契约自动穿(admin「联邦」tab 编辑) |
| `ShopStandin`(另一个 hub) | 加盟门店自己的 Gotong,服务 `shop.apply-directive`(可以是 LlmAgent、CLI、或又一条工作流) |

## 三层链条:本案例与 tea-supply-link 的对比

| | tea-supply-link | **tea-chain-hq(本案例)** |
|---|---|---|
| 编排方向 | 朝上:门店 → 供货商 | 朝下:总部 → 门店 |
| 本地 agent | 采购助手(起草补货单 + 建档) | 下发协调员(起草指令 + 建档) |
| 跨组织 capability | `supplier.confirm-order`(住供货商) | `shop.apply-directive`(住加盟门店) |
| 审批人 | 店长 | 区域经理 |
| 谁确定性算数 | 供货商按目录定价(¥990) | 门店按本店菜单应用调价(Δ+1) |
| 两案例共用 | 出站审批闸 + 两步恢复 + 三不变量 + 「链接是运行时,不在模板」 | 同 |

## 决策 #4 / #5 框定

- **#4(模板带结构 + 引用,永不带知识内容)**:KB 槽位 `chain_playbook` 只带「MCP 接线
  + presetData 指针」。连锁运营手册(调价规范 / 加盟商政策 / 区域沟通口径 / SOP)是总部
  自己的 Obsidian vault,不在模板里。
- **#5 + 本案例新增的一条**:**跨组织的链接也不在模板里**。链接是运行时 per-link 信任
  契约(peer + outboundCaps + 审批策略),导入模板后到 admin「联邦」tab 配。

## 安全边界

- **调价门店算,人定外发**:现价 / 新价 / 差额由门店在自己的 hub 上**按本店菜单**确定性
  应用(下发协调员只起草不应用);指令跨出总部前必须区域经理在出站审批闸批准。
- **拒绝即 fail-closed**:区域经理拒绝时门店从未被联系,本地建档步从未运行。
- **跨组织隔离**:链接是 per-link 的;总部连多个加盟门店时,每条链路的出站放行 / 数据
  分类 / 配额互不串线(见下「进阶可叠加」)。
- **门店是主权组织,不是总部的下属对象**:总部只能**提议**调价并**经门店一侧执行**;
  门店在自己的 hub 上应用并回执。这正是「自由图,不是层级树」——下发是一条经过策划、
  可被审批的链接,而不是总部对门店内部状态的直接写。

## 进阶可叠加(本 demo 故意不做,保持聚焦)

- **节点级数据分类闸(C-M2)**:给 `rollout` 步加 `dataClasses: [...]`,配 per-link
  `allowedDataClasses` → 越界的数据分类在出站闸被拦(同一个 chokepoint)。
- **per-link 配额(P4-M4)**:给加盟门店链路配 `perLinkQuotaBudget` → 跨 hub 下发计入预算,
  超额 fail-closed。
- **多店扇出**:总部连多条加盟门店链路 → 同一条工作流用 capability / broadcast 策略一次
  下发到全部门店,每条链路的审批 / 出站放行各自独立。

详见 [`docs/zh/ledger/V5-G-FINAL.md`](../../docs/zh/ledger/V5-G-FINAL.md)(跨 hub 工作流编排)与
[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)(上手 hub 目录)。
