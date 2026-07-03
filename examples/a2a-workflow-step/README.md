# a2a-workflow-step — 外部 A2A agent 当工作流步

> 一个 hub 上的声明式工作流，其中一步**调用一个外部 A2A agent**（第三方服务，走
> A2A `message/send` 协议），下一步在本地消费它的回复。这是 [`cross-hub-workflow`](../cross-hub-workflow)
> 的**姊妹**：那个把一步跨到 **mesh 对等 hub**（走出站审批闸，可挂起等人批）；这个把
> 一步派给**外部 A2A agent**（**无审批闸，立即外发**）。两者是**同一套能力调度**。

```
                    本 hub (运行工作流)
  ┌─────────────────────────────────────────────┐
  │ workflow: a2a-translate-and-file            │
  │   translate → cap[external.translate]       │
  │   archive   → cap[docs.archive]             │
  └─────────────────────────────────────────────┘
        │ ① translate 步派 capability
        ▼
  ┌─────────────────────────────────────────────┐      A2A message/send        ┌──────────────────────┐
  │ ext-translator                              │ ───────────────────────────▶ │  外部 A2A 翻译 agent   │
  │   A2aRemoteParticipant                      │      ② 立即外发(无闸)         │  (第三方, 自有 bearer) │
  │   cap: external.translate                   │ ◀─────────────────────────── │                      │
  └─────────────────────────────────────────────┘      ③ 译文回流(agent Message) └──────────────────────┘
        │ 回流: 译文 → translate.output.text → archive 步 (本地)
        ▼
  ┌─────────────────────────────────────────────┐
  │ doc-archive  cap: docs.archive              │  ④ 本地归档译文
  └─────────────────────────────────────────────┘
```

## 这个 demo 证明了什么（确定性，无需 API key，无 socket）

调外部 A2A agent**不是新机制**——它是「能力调度」，只不过那个能力由一条**出站 A2A
边**来服务。`A2aRemoteParticipant` 就是一个**本地参与者**，注册在某个 capability 下；
被派发时它把任务转发到那个 agent 的 HTTP 端点，再把回复变成任务的 `ok` 输出。所以工作流
那一步只写 `{kind: capability, capabilities: [external.translate]}`，**runner 零改、YAML
零新关键字**就能路由到它。

**和跨 mesh 对等 hub 的关键区别（诚实点）：外部 A2A 步没有审批闸——它立即外发。**
mesh 对等 hub 那一步若对方设了 `requireApprovalOutbound`，会**挂起在 owner 收件箱**等人批；
外部 A2A 步是裸注册的出站边，**一调就走**。admin 启动工作流前（Stream H-M3）能在卡片和
启动对话框看到这条区别（「→ 外部 A2A agent: X」+「这类步骤无审批闸，会立即发出」）。

两条剧情：

| 剧情 | 结果 |
|---|---|
| **[A] happy** | 工作流 `translate` 步派给外部 A2A agent → 运行**不挂起，一步到底**（无闸）→ agent 走 A2A 协议翻译 → 译文回流成步骤输出 → 下一步（**本地**）`archive` 归档译文 → 运行 `ok`。 |
| **[B] failure** | 外部 agent 对无法处理的输入返回 JSON-RPC error → `a2aSend` 抛错 → `translate` 步**失败** → 工作流在 `archive` 前**halt** → 运行 fail-closed。 |

## 为什么用注入的 `fetchImpl` 而不是真 socket

「外部 A2A agent」由一个注入的 `fetchImpl` 来扮演（和 `@aipehub/a2a` 单测同一个手法），
不起真 socket。它**解析出站的 JSON-RPC body 并断言协议形状**（method `message/send`、
bearer 鉴权、`metadata.skill`），所以这个 demo 同时是一个 **A2A 协议冒烟**。

真正的 host 用 `global fetch` 调真端点；**验收门** `host/tests/a2a-workflow-step-e2e.test.ts`
用一个真 loopback A2A server 跑同一条流程。

## 跑

```bash
pnpm demo:a2a-workflow-step
```

8 条自断言全绿即闭环成立。这个 demo 同时是一个冒烟测试。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/translate-and-file.yaml` | 声明式工作流：`translate`（外部 A2A 能力）→ `archive`（本地能力）。**YAML 里没有任何 agent 端点 / token。** |
| `src/demo.ts` | 一个 hub + `A2aRemoteParticipant`（注入 fetch 扮外部 agent）+ 本地归档 worker + 确定性自断言。 |

## 对应的生产组件

| demo 用的 | 生产真东西 |
|---|---|
| `A2aRemoteParticipant` + 注入 `fetchImpl` | 同一个 `A2aRemoteParticipant`（`@aipehub/a2a`），`fetchImpl` 用 `global fetch` 调真端点 |
| `EXTERNAL_URL` / `EXTERNAL_TOKEN` 常量 | identity `a2a_outbound_agents` 表（url + `tokenEnv` 从环境变量读 bearer，永不入库）+ admin「联邦」tab 出站 A2A agent 面板（Route B P1-M11） |
| `external.translate` 路由到本地 participant | hub 能力调度（与调任何本地能力同一条路径） |

## 对比：cross-hub-workflow vs a2a-workflow-step

| 维度 | cross-hub-workflow（姊妹） | a2a-workflow-step（本例） |
|---|---|---|
| 目的地 | mesh 对等 hub（AipeHub↔AipeHub，联邦链路） | 外部 A2A agent（第三方 HTTP 端点） |
| 协议 | mesh RPC over HubLink | A2A `message/send` over HTTP |
| 审批闸 | 可有（peer 设 `requireApprovalOutbound` → 挂起等人批） | **无**（裸注册的出站边，立即外发） |
| 出站参与者 | peer wrapper（`installPeerLink`） | `A2aRemoteParticipant`（本地参与者） |
| 启动前可见性（H-M3） | 「→ 对等 hub: X」+「若对方设了审批闸，需在收件箱批准」 | 「→ 外部 A2A agent: X」+「无审批闸，会立即发出」 |
| 共同点 | **都是 capability dispatch；工作流那一步都不点名目的地；runner / YAML 零改。** | 同左 |

## 进阶可叠加（本 demo 故意不做，保持聚焦）

- **A2A task 生命周期（Route B P1-M8）**：若远端 agent 是会**挂起**的 AipeHub（返回 Task
  而非 Message），`a2aSend` 会抛带 `.taskId` 的错；改用 `a2aSendRaw` + `a2aGetTask` 轮询。
- **per-agent 持久配置（Route B P1-M11）**：把 `EXTERNAL_URL`/`tokenEnv` 落 identity
  `a2a_outbound_agents` 表，admin「联邦」tab 管理出站 agent。

详见 [`docs/zh/ledger/V5-H-FINAL.md`](../../docs/zh/ledger/V5-H-FINAL.md)。
