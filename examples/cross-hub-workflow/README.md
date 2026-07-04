# cross-hub-workflow — 跨 hub 工作流编排

> 北极星 **第 2 层「跨组织协作」**: 一个 hub 上的声明式工作流，编排一步到**另一个
> hub** 的能力；凭证 / 数据 / 计费各归各家。Hub 网络是**自由图，不是层级树**——
> org A 不拥有 org B，只是有一条**经过策划的**链接到 org B 的某个能力。

```
        org A (消费 hub)                                  org B (提供 hub)
  ┌───────────────────────────────┐                ┌────────────────────────┐
  │ workflow: cross-hub-contract  │                │  b-counsel             │
  │   review  → cap[legal.        │                │  cap: legal.           │
  │             contract-review]  │                │       contract-review  │
  │   archive → cap[legal.archive]│                │                        │
  └───────────────────────────────┘                └────────────────────────┘
            │  ① review 步派 capability                         ▲
            ▼                                                   │ ④ 批准后才跨界
  ┌───────────────────────────────┐    installPeerLink         │
  │ peer wrapper (advertises       │────────────────────────────┘
  │   [legal.contract-review])     │      ② 出站审批闸挂起
  │   wrapped in approval gate     │      ③ owner 在 /me 批准
  └───────────────────────────────┘
            │  回流: org B 的裁决 → review.output → archive 步 (本地)
            ▼
  ┌───────────────────────────────┐
  │ a-registry  cap: legal.archive │  ⑤ 本地归档对端裁决
  └───────────────────────────────┘
```

## 这个 demo 证明了什么（确定性，无需 API key）

跨 hub 编排**不是新机制**——它是「能力调度」，只不过那个能力住在另一个 hub 上。工作流
那一步只写 `{kind: capability, capabilities: [legal.contract-review]}`，**从不点名某个
peer**；hub 的路由 + 联邦链路把它带过组织边界。把这件事变可能的两块拼图都已经 ship：

1. **能力通告 = 授权（G-M1）**：per-link 策划的 `outboundCaps` 白名单**同时**是 peer
   wrapper 对外**通告**的能力集。`outboundCaps ['legal.contract-review']` → wrapper 通告
   `['legal.contract-review']` → 工作流那一步能**路由**到这个 peer，**而且**同一份白名单
   **授权**这次跨界。没策划 → 不通告 → 不可被能力编排（安全默认）。

2. **出站审批闸（Phase 18 B）**：标了 `requireApprovalOutbound` 的 peer 被包一层，出站
   任务**挂起在 owner 的收件箱**，批准后才真正越过组织边界。这个闸是 Phase 16
   human-inbox broker 的**跨 hub 孪生**——同一套 suspend/resume，只是批准时它**转发**给
   远端，而不是把决定当输出返回。

两条剧情：

| 剧情 | 结果 |
|---|---|
| **[A] 批准** | 工作流 `review` 步派给 org B 法务 → 运行**挂起**在审批闸（什么都还没跨界）→ owner 在收件箱批准 → 任务终于跨到 org B → org B 的裁决回流成步骤输出 → 下一步（**本地**）`archive` 归档那份裁决 → 运行完成。 |
| **[B] 拒绝** | 同样的开局；owner 拒绝。org B **从未**被联系，本地 `archive` 步**从未**运行，运行 **fail-closed**。 |

## 为什么 host-free（同 cafe-ops / warband-club 先例）

这个示例只依赖 `@gotong/core` + `@gotong/workflow` + `@gotong/inbox`，把宿主机的两个
组件**内联成可见的 ~40 行**，让机制不被埋在 host 二进制里：

- `OutboundApprovalGate` = `packages/host/src/outbound-approval.ts` 的最小镜像
  （`ApprovalGatedParticipant`）。生产里它由 `installPeerLink` 的 `wrapOutbound` 钩子
  装上。
- `resolveApproval` = `packages/host/src/inbox-service.ts` `HostInboxService.resolve`
  两步恢复的手写镜像（**子闸严格先于父 workflow**）。生产里它由 `/me` 收件箱点一下
  批准触发。

真正的跨 hub 链路是真的：`createInprocHubLinkPair` + `installPeerLink`（都来自
`@gotong/core`），两个真 `Hub`，真 `parseWorkflow` + `WorkflowRunner`。

## 跑

```bash
pnpm demo:cross-hub-workflow
```

11 条自断言全绿即闭环成立。这个 demo 同时是一个冒烟测试。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/contract-review.yaml` | 声明式工作流：`review`（跨 hub 能力）→ `archive`（本地能力）。**YAML 里没有任何 peer 的名字。** |
| `src/demo.ts` | 两个 in-proc hub + 内联审批闸 + 两步恢复镜像 + 确定性自断言。 |

## 对应的生产组件

| demo 内联 | 生产真东西 |
|---|---|
| `OutboundApprovalGate` | `host/src/outbound-approval.ts` `ApprovalGatedParticipant`（`installPeerLink({wrapOutbound})`） |
| `resolveApproval` 两步恢复 | `host/src/inbox-service.ts` `HostInboxService.resolve` + `/me` 收件箱点批准 |
| `parked` Map（suspendNotifier） | identity `suspended_tasks` 表 + resume sweep |
| `remoteCapabilities` / `outboundCaps` 手动穿线 | `host/src/peer-registry.ts` 从 per-link 信任契约自动穿（admin「联邦」tab 编辑） |

## 进阶可叠加（本 demo 故意不做，保持聚焦）

- **节点级数据分类闸（C-M2）**：给 `review` 步加 `dataClasses: [confidential]`，配 per-link
  `allowedDataClasses` → 越界的数据分类在出站闸被拦（同一个 chokepoint）。
- **per-link 配额（P4-M4）**：给链路配 `perLinkQuotaBudget` → 跨 hub 调用计入预算，
  超额 fail-closed。
- **可调用 KB 白名单（C-M1）**：若 org B 还共享一个 MCP 知识库，per-link `allowedKnowledgeBases`
  决定 org A 能不能查。

详见 [`docs/zh/ledger/V5-G-FINAL.md`](../../docs/zh/ledger/V5-G-FINAL.md)。
