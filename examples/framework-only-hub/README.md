# framework-only-hub — 只装框架 + 自带 agent + 零 Atong

**回答一个常见问题:「我能不能只用 gotong 框架、配自己的智能体,不要你们的管家阿同?」**
——能,而且这就是框架的本来设计。这个 demo 是那句话的**最短可跑证明**。

整个进程**只依赖 `@gotong/core`**(见 [`package.json`](package.json))。没有
`@gotong/personal-butler`、没有 `@gotong/llm`、没有任何 Atong 模块,不联网、不需要 key。
它跑一个极简的值班支持台:

1. **你自己的 agent** `TriageAgent`(能力 `triage`)按关键词把告警分成 `urgent` / `routine`——
   纯规则、零 LLM。换成你的领域逻辑、甚至一个真 LLM agent,接法一模一样。
2. `urgent` 的告警**显式派**给值班工程师(一个 `HumanParticipant`);`routine` 的只记进
   transcript,不打扰人。

这两步分别演示了框架的两个核心机制:**能力派发**(派发方只说要什么能力,不点名 agent)+
**人在环**(人和 agent 是同一个 `Participant`,走同一套派发)。

## 跑

```bash
pnpm install && pnpm build     # 第一次:编译 workspace
cd examples/framework-only-hub && pnpm start
# 或根目录短别名:
pnpm demo:framework-only
```

`pnpm start` 会打印 transcript、跑自校验、成功则 `exit 0`。

## 它证明了什么(自校验断言)

- 数据库告警被判 `urgent` 并真的到了人手上被 ack(断言核到 `acked:true`);错别字告警被判
  `routine`、没惊动人;
- **「没有 Atong」的硬证明是依赖图**:本进程只 import `@gotong/core`、`package.json` 唯一依赖也是
  `@gotong/core`、而 core 只依赖 `@gotong/protocol`——依赖闭包里根本没有
  `@gotong/personal-butler`。示例再加一道**运行时哨兵**:断言整个 hub 里注册过的参与者恰好只有
  你注册的两个(`triage` + `oncall`),且没有任何一个带 `chat` 能力(Atong 站在会话 agent 前面的信号)。

## 这属于哪种「装法」

gotong 的能力分三层(见宪章),对应三种装法:

| 装法 | 你装什么 | 看哪 |
|---|---|---|
| **框架-only + 自带 agent**(本例,第 3 层) | `@gotong/core`(+ `@gotong/transport-ws` 如需联网) | 本 README + [`PARTICIPANT.md`](../../docs/zh/PARTICIPANT.md) |
| **Atong 桌面**(一个人的管家,第 1 层) | `@gotong/host` 默认带 Atong,配个 LLM key | [`SOLO-COMPANY-HUB.md`](../../docs/zh/SOLO-COMPANY-HUB.md) |
| **两样一起**(全栈) | `gotong start` 默认 | [`GO-LIVE.md`](../../docs/zh/GO-LIVE.md) |

三种装法怎么选、各自的确切命令与旋钮,一页说清:[`docs/zh/INSTALL-MODES.md`](../../docs/zh/INSTALL-MODES.md)。

## 一句诚实边界

「只有 Atong、不要框架」**在依赖上不成立**——Atong 是个 `Participant`,租客离不开楼,它必然
内嵌一个最小 hub。所以第 2 种装法(Atong 桌面)仍然跑在框架之上,只是把组织/联邦那套面板收起来。
本例证明的是反方向:**框架可以完全没有 Atong**。
