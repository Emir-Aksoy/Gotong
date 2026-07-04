# cross-hub-federation — 跨组织联邦跑在真 WebSocket 上

> 北极星 **第 2 层「跨组织协作」** 的真网络版。两个真 hub 在一个进程里，org A 经
> **真 `ws` socket** 拨号 org B，双方 `bearerAuth` 验 token，跑完整的跨 hub 工作流 +
> 出站审批闸。`cross-hub-workflow` 用 inproc 链路演 *机制*；这个用真套接字演 *上线后真实
> 长什么样*。确定性、无 API key。

```bash
pnpm demo:cross-hub-federation
```

## 跟 `cross-hub-workflow` 差在哪

两个 example **同一个工作流、同一个出站审批闸、同一套两步恢复**。唯一的差别是**链路**——
而那恰恰是真部署强加的那一块：

| | `cross-hub-workflow` | `cross-hub-federation`（本例） |
|---|---|---|
| 链路 | `createInprocHubLinkPair`（同进程，无 socket） | 真 `ws` `WebSocketServer` + `connectHubLink` |
| 鉴权 | 无（信任的同进程） | 双方 `bearerAuth({ token })`，握手期验证 |
| 跨边界时机 | inproc 调用 | 批准后第一帧才真的上线（`MESH_TASK`） |
| 拒绝坏 peer | 不涉及 | ✅ 错 token 握手期被拒（`[C]`） |
| 形态 | 机制可见 | 上线现实可见 |

机制本身一字未改：跨 hub 调度仍只是「能力住在 peer 上的能力调度」，工作流 YAML 既不点名
peer 也不知道有 socket。换句话说——**把 inproc 链路换成真网络链路，工作流层零感知**。这正是
框架想要的：网络是操作员的细节。

## demo 证明什么（三幕，自断言）

- **[A] 批准** — org A 的工作流把 `review` 步派给 org B 的法务（**跨真 socket**）。run 在
  审批闸**挂起**（此刻 socket 上零帧）。owner 在收件箱批准 → 任务才真的过 socket 到 org B →
  裁决经 ws 回流当作步输出 → 本地 `archive` 步归档 → 工作流完成。
- **[B] 拒绝** — 同样的出站，owner 拒。org B **永不被联系**，socket 上**零帧**，本地归档步
  从不执行，run fail-closed。
- **[C] 错 token** — 第三个冒名 hub 用**错的 bearer token** 拨号 org B。org B 握手期拒掉、
  socket 被关，拨号 `connectHubLink` 抛错；org B 上**没有**装上任何入站链路。鉴权是真的，不是
  摆设。（org B 关链路时**不回失败帧** = anti-enumeration：拨号方只看到「链接被关」，看不到
  「token 格式对但值不对」，无法探测。）

## 跟生产的对应关系

这个 example 是 host-free 的（同 `cross-hub-workflow` / `cafe-ops` 先例）：core + workflow +
inbox + transport-ws + 一段 ~40 行内联的出站审批闸 + 两步恢复镜像，好让机制*看得见*而不是埋在
host 二进制里。生产里它们是真的 host 组件：

| demo 里的内联件 | 生产里的真组件 |
|---|---|
| `OutboundApprovalGate` | `host/src/outbound-approval.ts` 的 `ApprovalGatedParticipant`（经 `installPeerLink({ wrapOutbound })` 装上） |
| `resolveApproval` 两步恢复 | `host/src/inbox-service.ts` 的 `HostInboxService.resolve` |
| 手动 `parked` Map | identity 的 `suspended_tasks` 表（`suspendNotifier`） |
| 固定 `PEER_TOKEN` 常量 | `gotong mint-peer-token` 铸 256-bit token + per-link 信任契约 |
| owner 在代码里批 | owner 在 `/me` 收件箱点「批准」 |

`connectHubLink` / `acceptHubLinks` / `bearerAuth` 用的就是生产同一套 `@gotong/transport-ws`
传输——`peer-registry.ts` 的 reconcile tick 在真机上拨的也是这几个函数。

## 两机落地

把这两个 hub 拆到两台机器（org A 一台、org B 一台），操作员从头到尾怎么做——铸 token、配
endpoint、wss/TLS、连接、配 per-link 契约、跑一条跨 hub 工作流、从收件箱批准、在控制面观察——
见 **[`docs/zh/FEDERATION-RUNBOOK.md`](../../docs/zh/FEDERATION-RUNBOOK.md)**。

## 相关验收门

这个 example 的真网络主张，在 `packages/host/tests/` 有对应的 E2E 验收门把守（真 `ws` 传输 +
真 host 组件）：

- `cross-hub-workflow-ws-e2e.test.ts`（P1-M1）— 跨 hub 工作流 + 出站审批闸过真 WS（approve /
  reject / no-approval 三剧情）。
- `cross-hub-transcript-chain-ws-e2e.test.ts`（P1-M2）— transcript chain 过真 WS（opt-in 闸）。
- `cross-hub-redial-resilience-e2e.test.ts`（P1-M3）— socket 断链 + 重拨后挂起仍在、批准后跑完。
