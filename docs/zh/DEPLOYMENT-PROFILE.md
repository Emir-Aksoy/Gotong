# 部署视角 · `AIPE_PROFILE`

> 一句话：AipeHub 真正的分界是**「hub 内 vs 跨 hub」**，不是「个人 vs 组织」。
> `AIPE_PROFILE` 只是让入口先讲哪一套心智——它是**呈现视角，不是行为开关**。

---

## 为什么要这个

「个人版 vs 企业版」是别的产品的分法。在 AipeHub 里，节点单位是 **hub**：

- **一个人 + 自己的 agent = 主权 hub**（sovereign hub）——主权在你手里，凭证只在本机；
- **一簇 agent 也能组成非主权 hub**（主权在外部）；
- 工作流**既可以在一个 hub 内完成，也可以跨 hub 完成**。

所以真正要问的不是「你是个人还是组织」，而是「你现在关心的是**一个 hub 内**的事，
还是**多个 hub 相连**的事」。**团队和组织其实都归「跨 hub」**——它们只是 hub 数量更多、
边界更多，不是另一个物种。

`AIPE_PROFILE` 把这个分界摆到首屏，让新用户不用先读完架构文档就知道自己站在哪一档。

---

## 两档 + 默认

| `AIPE_PROFILE` | 视角 | 入口先展示什么 | 深读 |
|---|---|---|---|
| `hub` | **hub 内（单节点）** | 个人管家 · 模板画廊一键装 · hub 内工作流 · `/me` 收件箱 · MCP 连接器 | [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) |
| `federation` | **跨 hub（多节点相连）** | peer 注册与信任契约 · 跨 hub 工作流编排 · 出站 A2A · 联邦能力 manifest · 两机操作员 runbook | [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) |
| *（不设）* | — | **与今天字节完全一致**：不加视角行、不重排任何东西 | — |

设置方式就是一个环境变量：

```bash
AIPE_PROFILE=hub         aipehub start      # 先看 hub 内
AIPE_PROFILE=federation  aipehub start      # 先看跨 hub
aipehub start                               # 不设 = 今天的样子
```

大小写、首尾空格、下划线都不敏感（`Single_Node`、`CROSS_HUB` 都认）。几个常见同义词
也收：`hub` 收 `node`/`single`/`local`/`personal`；`federation` 收 `fed`/`cross-hub`/
`team`/`org`/`organization`。设了但**认不出**的值（比如拼错成 `enterprais`）会打一行
警告然后**忽略**，退回默认——不会静默改行为。

启动时（`hub`/`federation` 档）会在「host ready」摘要后多印一小段双语视角：

```text
=== AipeHub host ready ===
...
HostCheck : disabled (loopback only is safe)

视角 / Profile:  跨 hub（多节点相连）  ·  cross-hub (many nodes linked)
  多个 hub 相连：团队 / 组织都是「跨 hub」，凭证与数据各归各家。
  Many hubs linked: teams and orgs are both "cross-hub"; credentials and data stay with each.
  先看 / leads with:  peer 注册与信任契约 · 跨 hub 工作流编排 · 出站 A2A · 联邦能力 manifest · 两机操作员 runbook
  读 / read:  docs/zh/FEDERATION-RUNBOOK.md
```

不设 `AIPE_PROFILE` 时这一段**完全不出现**——`HostCheck` 之后直接是设置向导横幅，和以前一模一样。

---

## 一条硬边界：视角 ≠ 行为分叉

**`AIPE_PROFILE` 不启用、也不禁用任何代码路径。** 联邦相关代码（peer registry、
出站 A2A、HubLink）在 `hub` 档下照常运行；单 hub 的一切在 `federation` 档下也照常运行。
profile 只决定**先展示什么、文档先读哪**，不碰运行时。

这么设计有两个理由：

1. **可逆、零风险**：换 profile 只换首屏叙事，不改任何数据或行为。写错了、想切回来，
   删掉环境变量即可，什么都不会坏。
2. **诚实**：一个 hub 随时可能长出跨 hub 的需求（今天自己用，明天要和别人的 hub 对接）。
   把联邦能力藏在「企业版」后面是假的边界；它们一直都在，profile 只是决定**现在**把谁摆前面。

对应的两条只读实现（都是纯函数、可单测、不碰 core/protocol/identity）：
`packages/host/src/profile.ts`（解析 + 描述符 + 横幅行）、`packages/host/tests/profile.test.ts`
（钉死「unset 不产生任何视角行」这条承重承诺）。

---

## 接着读哪

- 概念 5 分钟总览：[`OVERVIEW.md`](OVERVIEW.md)
- hub 内怎么玩：[`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md)（五个开箱 hub）
- 跨 hub 怎么玩：[`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)（两机操作员）+
  [`V5-G-FINAL.md`](V5-G-FINAL.md)（跨 hub 工作流编排，北极星第 2 层）
- 为什么这么建：[`CHARTER.md`](../../CHARTER.md) · [`CHARTER.md`](CHARTER.md)
