# 三种装法：框架、Atong、还是两样一起

> 常被问到的一个问题:「我能不能**只装 gotong 框架、用自己的智能体**?能不能**只要阿同
> (Atong)、不要框架**?还是**两样一起**?」
>
> 一句话:**框架和 Atong 在代码里本来就是分开的两层**——框架(`@gotong/core` 一系)对
> Atong 零依赖,Atong(`@gotong/personal-butler`)是消费框架的下游叶子。所以三种装法里,
> 前两种是**真的两条路**,第三种是默认。下面一页说清每种「装什么、怎么开、看哪」。

这三种装法正好对到宪章的**三层**用途:

```
   第 1 层  人 ↔ 自己的 AI          →  「Atong 桌面」  一个人的管家
   第 2 层  人/agent ↔ 别人/机构     →  联邦(两样一起里的跨 hub 部分)
   第 3 层  框架本身                 →  「框架-only」  自带 agent 的协作底座
```

## 一眼选

| 你想要 | 装法 | 你装什么 | 关键开关 | 看哪 |
|---|---|---|---|---|
| 只要协作底座,自己带 agent | **框架-only** | `@gotong/core`(+ `transport-ws` 如需联网) | 无需 LLM(走官方 host 才用 `GOTONG_BUTLER=off`) | [`framework-only-hub`](../../examples/framework-only-hub) |
| 一个人 + 自己的管家 | **Atong 桌面** | `gotong` 元包(host 默认带 Atong) | `gotong model` 配 LLM | [`SOLO-COMPANY-HUB.md`](SOLO-COMPANY-HUB.md) |
| 全都要(多 agent + 多人 + 联邦 + 管家) | **两样一起** | `gotong` 元包,`gotong start` 默认 | 默认全开 | [`GO-LIVE.md`](GO-LIVE.md) |

---

## 装法一：框架-only（自带 agent，零 Atong）

**你要的是那个「dumb on purpose」的 hub**:它只路由消息 / 派 task / 写 transcript /
发事件,决策权全在你自己的 agent 手里。人和 agent 是同一个 `Participant`,走同一套派发。

有两条子路,按你想要多少「电池」选:

**① 自己写一个瘦 host(最纯)。** 装 `@gotong/core`,写你自己的 `Participant`,
`Hub.inMemory()` 起一个 hub 就能跑;要跨机联网再加 `@gotong/transport-ws`。你不碰
`@gotong/host` 那三千行装配,自己拼一个几十行的启动脚本。

```bash
npm install @gotong/core
# 20 行写一个 Participant,注册进 Hub —— 见 PARTICIPANT.md
```

跑得通的最短证明就是 [`examples/framework-only-hub`](../../examples/framework-only-hub):
只依赖 `@gotong/core`,一个你自己的分诊 agent + 一个值班的人。**「没有 Atong」的硬证明是
依赖图**——本进程只 import `@gotong/core`、core 只依赖 `@gotong/protocol`,依赖闭包里根本没有
`@gotong/personal-butler`;示例里再加一道运行时哨兵(断言花名册里没有任何带 `chat` 能力的
参与者)。想学怎么写 Participant,读 [`PARTICIPANT.md`](PARTICIPANT.md);想懂 host↔web 的注入
模式,读 [`SURFACE-PATTERN.md`](SURFACE-PATTERN.md)。

**② 用官方 host,但把 Atong 关掉(要电池又不要管家)。** 你想要 `@gotong/host` 自带的
web 后台 / 身份 / 金库 / 工作流那一整套,只是不想要管家:

```bash
GOTONG_BUTLER=off gotong start
```

`GOTONG_BUTLER=off` 把**默认策略**改成关闭。Atong 只会「站在」一个带 `chat` 能力、`kind:'llm'`
的会话 agent 前面(见 `butlerEnabledFor`);要**彻底零 Atong**,还要确保没有哪个 agent 显式写了
`butler: true`——那会覆盖 `off` 单独把自己开回来。反过来也成立:你可以**不关全局**,只在某个
agent 上写 `butler: false` 让它单独退出、变回纯 LLM agent。(注:新装的 hub `agents.json` 本就是
空的,「默认开」说的是策略,不是开箱就凭空有一个 Atong。)

> **诚实点**:即便走子路②、`@gotong/host` 的**安装依赖闭包**里仍然带着 Atong 的代码(host
> 依赖 `personal-butler`)。关掉它省的是**运行行为**,不是**安装体积**。真要一个不含 Atong 依赖的
> 瘦 host,那是打包层的活(见文末「还没做的」)。子路①不装 host,自然没这问题。

---

## 装法二：Atong 桌面（一个人的管家，第 1 层）

**你要的是「我的 AI 桌面」**:一个人、一个常驻管家阿同,跨会话记住你、benign 工具随手用、
敏感动作挡在 `/me` 审批后。这是 `gotong start` 的**默认**——Atong 默认就开
(`GOTONG_BUTLER` 不设 = on)。

```bash
npm install -g gotong     # 装 gotong 元包(它带 `gotong` 命令;@gotong/host 只带 `gotong-host`)
gotong start              # 起 host,Atong 默认策略是「开」
gotong model --token <admin-token> --agent <agent-id>   # 给一个已建的托管 chat agent 配 LLM(贴 key、现场探活)
```

`gotong model` 是给**已存在**的托管 agent 换/配模型的(不负责建 agent;建 agent 走向导或画廊),
`--token` 必填(与 `gotong provision` 同一种 admin token)。想让首屏叙事偏向「一个 hub 内」而不是
组织/联邦,可以加 `GOTONG_PROFILE=hub`——但要说清:**它只是启动时多印几行提示,不隐藏任何 web
面板、也不关闭联邦能力**(纯呈现视角,不设 = 字节不变,见
[`DEPLOYMENT-PROFILE.md`](DEPLOYMENT-PROFILE.md))。开箱样板见
[`SOLO-COMPANY-HUB.md`](SOLO-COMPANY-HUB.md)(一个人顶一个团队)、家庭场景见
[`FAMILY-HUB.md`](FAMILY-HUB.md);管家本身的设计见
[`PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md)。

> **诚实点**:**「只下 Atong、不要框架」在依赖上不成立**——Atong 是个 `Participant`,租客
> 离不开楼,它必然内嵌一个最小 hub。所谓「Atong 桌面」仍然跑在框架之上,今天只是让首屏叙事
> 偏向一个 hub 内(面板本身不隐藏)。这不是缺陷,是分层的必然。

---

## 装法三：两样一起（全栈）

**你要的是完整形态**:框架 + Atong + 多个 agent + 多人分角色 + 跨 hub 联邦全都在。这就是
`gotong start` 的默认全开状态,也是生产 hub 的样子。上线走 [`GO-LIVE.md`](GO-LIVE.md),
对照开箱 hub 走 [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md);企业向上兼容样板见
[`PRO-FIRM-HUB.md`](PRO-FIRM-HUB.md)。

---

## 为什么不用「优化代码结构」就能三选一

因为分层**已经**是对的,而且有承重门守着不让它烂:

- `@gotong/core` 只依赖 `@gotong/protocol`——**框架对 Atong 零反向依赖**。
- `@gotong/personal-butler` 依赖 `core`/`llm`/`personal-memory`,是**下游叶子**。
- `kernel-deps-gate`(见 [`CONVENTIONS.md`](CONVENTIONS.md))强制「内核 ↛ 装配层」,结构烂不了。
- 每个包都是**独立发布**的 public 包(`publishConfig.access=public`)——你现在就能
  `npm install @gotong/core` 而不装 `@gotong/personal-butler`。

**还没做的(打包层,不是结构层)**:一个不含 Atong 依赖的「瘦 host」二进制、以及一个把
组织/联邦面板整体隐藏的「Atong 桌面」预设。这些是**分发打包**的活,等真有独立发行需求再做;
今天三种装法靠上面的命令与旋钮就都跑得通。
