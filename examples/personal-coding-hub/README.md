# personal-coding-hub — 一个个人 hub 同时管 Claude Code 和 Codex

> 5 个[上手案例 hub](../../docs/zh/HANDS-ON-HUBS.md) 之一(3 个人 + 2 组织)—— 对照总览 + 真 DeepSeek/Obsidian 上线指南见该索引。

> AipeHub **能承担的一个案例**(不是框架功能,代码全在 `examples/`)。一个**个人
> hub** 里:一个**路由 LLM** 主动决定把编码任务派给 Claude Code 还是 Codex —— **按
> 目标派合适的 agent**,而不是每次都跑同一条流水线;而两个 agent **操作同一个仓库**,
> 因此共享项目级文件 —— `AGENTS.md`(规范)+ `PROGRESS.md`(进度交接棒)。

这回答三个诉求:

| 诉求 | 怎么落地 |
|---|---|
| **整合 + 结合「任务 × 用户安排」分派** | 一个 `LlmAgent`(路由)带 `DispatchToolset`,**结合两件事**决定派给谁 ——「分析任务」(只审查 / 琐碎 / 需先设计)× 「用户的安排」(谁在岗、谁善长什么、预算限不限单)。所以**同一个目标在不同安排下派得不同**:Codex 在岗 → 功能交 claude-code 起草 + codex 实现;Codex 不在岗 → claude-code 一人包办。**派给谁是结合任务和安排的判断**,不是写死的顺序,也绝不派一个不在岗的 agent。 |
| **共享项目级规范** | 两个 `CliParticipant` 用**同一个 `cwd`**,所以 `AGENTS.md` 对它俩是同一份磁盘字节。(真实里 `CLAUDE.md` symlink 到 `AGENTS.md`,一份规范喂两个 CLI。) |
| **共享进度文件** | 同一个 `cwd` 下的 `PROGRESS.md` 是**交接棒**:每个 agent 动手前先读、做完追加一行。demo 里 codex 那一轮打印 `read progress log (1 prior entries)` —— 它**读到了 claude-code 刚写的那条**。 |

```
            ┌─────────── 个人 hub ───────────┐
   你 ──────▶  router (LlmAgent)              │
   一个目标   │   │  dispatch_task(agentId)    │
            │   ├──▶ claude-code (CliParticipant) ┐
            │   └──▶ codex       (CliParticipant) ┤ 同一个 cwd
            └─────────────────────────────────┘  │
                         共享仓库 ◀───────────────┘
                         ├─ AGENTS.md   (规范, 都读)
                         └─ PROGRESS.md (进度, 都读都写 = 交接棒)
```

## 跑起来

```bash
pnpm demo:personal-coding-hub            # 10 个路由剧情 + 安全闸:结合「任务 × 安排」分派 + 显式分派 + 大白话改分工 + 共享仓库(可跑+自断言)
pnpm demo:personal-coding-hub:template   # 载入「方法论大脑」模板 + 预览(见下)

# 真跑(MiniMax 当路由脑 + 真 Claude Code / Codex 各用自己的登录)—— 见「真跑」一节:
MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli              # 交互式命令行(推荐)
MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:real -- "<目标>"  # 单发一个目标

# 链条自检(无需任何 LLM key):真 Claude Code + Codex 跑通整条链, 末尾打印 ✅/❌ 判定:
pnpm demo:personal-coding-hub:real -- "<目标>"                        # 缺 key → 路由脑换确定性 stand-in(仍发真 dispatch)
```

`demo:personal-coding-hub` 不需要任何 API key —— 路由用一个**情境感知的
`LlmProvider`**(`src/router-provider.ts`,用用户安排 `RoutingPolicy` 构造、读目标、调纯
函数 `planRoute(goal, policy)` 决定派谁,真 LLM 从同一个目标 + 同一安排做同样的判断),
两个编码 agent 用确定性的 mock CLI(`src/mock-coder.mjs`,纯 node)。但**文件共享是真的**:
每个剧情起一个真临时仓库,写真 `AGENTS.md` + `PROGRESS.md`,mock CLI 真读真写它们。
`index.ts` 对**每个剧情**都断言「追加到共享 `PROGRESS.md` 的 agent 集合 == 这个目标 ×
这个安排该路由的集合」、且危险任务 fail-closed —— 所以这个 example 同时是一个情境路由
的 smoke 测试。

## demo 故事(10 个路由剧情 + 安全闸)

核心证明:**同一个目标在不同安排下派得不同**。开头几个剧情只有两个目标 —— 一个功能、
一个琐碎修复 —— 但换了「用户的安排」,路由就把活派给不同的人。这正是「合理地调度」:
分派 = 分析任务 ×结合用户安排,不是固定流水线,也绝不派一个不在岗的 agent。后面两组剧情
是**让用户说了算的两条路**:[F]/[F2] 在目标里**点名**(显式分派),[G]/[G2] 用**大白话改
总分工层**(写回 `routing-policy.json`)。

| 剧情 | 目标 | 安排(`RoutingPolicy`) | 分派 | 为什么 |
|---|---|---|---|---|
| **[A] 功能 · 默认 roster** | `Add OAuth login…`(需先设计) | 都在岗 | claude-code → codex | 要先设计 → Claude Code 起草、Codex 据 `PROGRESS.md` 实现 |
| **[A2] 功能 · Codex 不在岗** | *同上* | `unavailable: ['codex']` | 只 claude-code | 同一目标,Codex 登出 / 限流 → 在岗的 Claude Code 一人包办设计+实现 |
| **[A3] 功能 · 预算限单** | *同上* | `singleCoder: true` | 只 claude-code | 同一目标,预算只允许一个 coder → 主理 Claude Code 独立完成 |
| **[B] 琐碎 · 默认 roster** | `Fix the typo…` | 都在岗 | 只 codex | 改动琐碎、无需设计 → 直接交快手 Codex,跳过规划回合 |
| **[B2] 琐碎 · Codex 不在岗** | *同上* | `unavailable: ['codex']` | 只 claude-code | 同一目标,Codex 不在岗 → 小修也得有人接,交在岗的 Claude Code |
| **[C] 只审查不改** | `Review auth.ts…; do not change code.` | 默认 roster | 只 claude-code | 只审查 / 解释、不改代码 → 交善于分析的 Claude Code,不派实现 |
| **[F] 显式分派 · 点名 codex** | `交给 codex 直接实现这个登录按钮` | 用户在目标里点名 | 只 codex | 目标里点了名 → **覆盖**角色填充,直接派被点名的 Codex |
| **[F2] 显式分派 · 两人各司其职** | `让 claude-code 设计、codex 实现 OAuth 刷新令牌` | 用户点名两人 | claude-code → codex | 点名「谁设计、谁实现」→ 按点名派两人 |
| **[G] 大白话改分工 · codex 不在岗** | `Add OAuth login…`(同 [A]) | 大白话 `codex 今天限流, 先不在岗` | 只 claude-code | 同一 feature,用**大白话**把 codex 改成不在岗(写回 `routing-policy.json`)→ 只派在岗的 |
| **[G2] 大白话改分工 · 主理 + 限单** | *同上* | 大白话 `让 claude-code 主理, 这周预算限单` | 只 claude-code | 一句大白话改两项(主理 + 预算)→ 主理一人包办 |
| **[D] 安全闸** | `rm -rf build && git push --force` | — | (挂起→拒绝) | 危险命令在 CLI **还没 spawn 前**就挂起等人批;拒绝 → fail-closed,CLI 从未跑 |

`index.ts` 对**每个剧情**断言「追加到共享 `PROGRESS.md` 的 agent 集合 == 该 goal × 安排
应路由的集合」—— [A] 与 [A2]/[A3]/[G]/[G2] 是同一行目标却断言不同的分派集合,这就是「合理
调度」的可断言证据;[G]/[G2] 还额外把大白话编辑写回策略文件再读回,断言往返无损。

**两个输入,就是用户点名的两件事**(都在 `src/routing.ts`):

- **分析任务** —— `analyzeTask(goal) → { reviewOnly, trivial, needsDesign }`。关键词分类器
  在 demo 里**替身**一个路由模型的判断(让 demo 无需真 LLM 也能断言);真跑时一个真模型做
  同样的分析。
- **用户的安排** —— 一个声明式的 `RoutingPolicy`:
  - `profiles` —— roster + 每个 coder 善长什么(strength 标签);
  - `unavailable` —— 此刻不在岗的 coder(登出 / 限流 / 不想用),**绝不派**;
  - `singleCoder` —— 预算把一次分派**封顶到一个 coder**(不派规划+实现两人);
  - `preferLead` —— 多个 coder 都能主理设计时,优先谁。

`planRoute(goal, policy)` **合并这两者**:先算任务需要哪些角色(一个 reviewer / 一个
implementer / 一个 lead+implementer),再从**在岗** roster 按 strength 填每个角色 —— 理想
coder 不在岗就**优雅降级**给在岗的顶上,而不是硬失败。所以同一个目标在不同安排下路由不同,
且**永远派给一个真能干这活、又确实在岗的 coder**。全是纯函数,所以路由可断言。

机制:所有路由剧情都是 `LlmAgent` tool-use loop → `DispatchToolset.dispatch_task({agentId})`,
派几个、派谁由 `planRoute(goal, policy, override)` 决定;路由脑是一个**情境感知的 `LlmProvider`**
(`src/router-provider.ts`,用 `policy` 构造、读目标、调 `planRoute` —— 真 LLM 从同一目标 +
同一安排做同样的判断);[A] 里 codex 读到 `1 prior entries` = 看到了 claude-code 写的交接
(同 `cwd` + `SharedWorkspaceCli` 在 hub 边界注入「先读后写」约定);[D] 是
`dangerousCommandGate()`(Phase E2 的 T2 动作闸)。

## 让用户说了算:点名(显式分派)+ 大白话改总分工层

前面的路由是「自动按任务 × 安排判断」。但用户随时可以**直接接管**,两条路:

**① 显式分派 —— 在目标里点名**(每次,临时)。在目标句子里点谁的名,就**覆盖**这一次的
角色填充:

```
coding-hub> 交给 codex 直接实现这个登录按钮          # → 只派 codex
coding-hub> 让 claude-code 设计、codex 实现刷新令牌   # → claude-code 设计 → codex 实现
```

`parseExplicitAssignment(goal)`(`src/routing.ts`)只在**既点了名、又有派活动词**(交给 /
派给 / 让 / 用 …)时才认作显式分派,把它当 `planRoute` 的 `override` —— 仍然尊重「不在岗」
(点了一个不在岗的 coder 不会硬派)。这只影响**这一次**,不改 standing 分工。

**② 大白话改总分工层 —— OpenClaw 式自然语言编辑**(持久,写回文件)。「总分工层」是一个
`RoutingPolicy`(roster / 谁在岗 / 谁主理 / 预算),它住在工作区旁的 `routing-policy.json`,
是**单一真相源**——两种运行模式都从它派生。在 CLI 里用大白话改它:

```
coding-hub> :roster                              # 打印当前总分工层
coding-hub> :policy codex 今天限流, 先不在岗       # → codex 标记不在岗(写回文件)
coding-hub> :policy 让 claude-code 主理, 这周预算限单   # → 一句改两项
coding-hub> :roster                              # 改动持久, 重启仍在
```

`:policy <大白话>` 走 `applyPolicyEdit(policy, 大白话)`(`src/policy.ts`):把一句话拆成
子句、各应用一个意图(下线/上线、主理、预算限单/放开),**写回 `routing-policy.json`**,再
**重注册 router**(它的 system prompt 由策略文件渲染,改了即时生效)。没听懂就提示换个说法,
不乱改。`applyPolicyEdit` 里的中英关键词解析在 demo 里是个**确定性替身**——真 LLM 扮的就是同
一个角色(一句话 → 一个策略编辑 → 写回文件),换成 LLM 调用文件契约不变。

> **临时 vs 持久**:点名(①)只管这一次派发;大白话改总分工层(②)落到文件、之后每次都按新
> 安排走。复制工作区目录 = 把这套分工一起带走(策略是文件,不是代码)。

## 方法论知识库(Karpathy 工作流)+ 可载入模板

这个案例的「方法论大脑」是一个**可载入文件**,不是写死在 `index.ts` 里的 TS 字面量
—— `template/personal-coding-hub.template.yaml`(`aipehub.template/v1`)。它声明:

- 一个**编码导师 agent**(`coding-mentor`):派活前先查「Karpathy 编程方法论」知识
  库(`obsidian__search`),再决定怎么把任务拆给规划编码 agent(claude-code)与实现
  编码 agent(codex)。
- 一个**可寻址知识库槽位**(`coding_methodology`):经 `mcp-obsidian` 接到你的
  Obsidian vault;`presetData` 是一个指向方法论快照的**指针**。

```
  template/personal-coding-hub.template.yaml   (aipehub.template/v1 — 可载入)
  ├─ agents:          coding-mentor  ──┐ 自带 mcpServers (obsidian)
  │                                    │  →「ask-your-wiki」查方法论再路由
  ├─ knowledgeBases:  coding_methodology ── mcp-obsidian (你的 Obsidian vault)
  │                    └─ presetData:  指针(不是内容!)──┐
  └─ defaults.apiKeyPrompt: DeepSeek                      │
                                                          ▼
  methodology-vault/   ← 知识**内容**住在模板之外(决策 #4),= 指针指向的东西
  ├─ index.md                  方法论 wiki 首页
  ├─ software-3.0.md           规范即程序
  ├─ vibe-coding.md            凭感觉写的边界
  ├─ agentic-engineering.md    把 agent 拴住小步走
  ├─ llm-knowledge-base.md     LLM-as-compiler / raw→编译 wiki
  ├─ coding-with-agents.md     落到本 hub(AGENTS.md / PROGRESS.md)的手册
  └─ raw/sources.md            Karpathy 原文指针
```

**为什么模板里只有导师、没有 claude-code/codex**:模板的 `agents` 是**托管 LLM
agent**(过 `parseManifest` 校验);claude-code / codex 是 `CliParticipant`(shell-out
到外部 CLI),由 `index.ts` 在运行时接线。模板携带「方法论导师 + KB 接线」,example
在它周围接上两个 CLI 编码 agent。

**为什么知识内容不在模板里**(Stream B 决策 #4):模板只带「结构 + 引用」,永不带
知识内容。`methodology-vault/` 那些 `.md` 才是内容 —— 模板用 `presetData` 指针引用
它,不内联。这套方法论 vault 本身按 Karpathy 的「raw → 编译 wiki」模式组织,既是方法
论也是该方法论的一个实例。

**预览(载入演示)**:`pnpm demo:personal-coding-hub:template` 把模板从磁盘读出来、
解析、打印导师 + KB 槽位 + 指针 + vault 笔记清单(config-preview,不起 mcp-obsidian
子进程 —— 同 `examples/obsidian-kb` 策略)。严格的「过真 schema + 真导入」证明在
`packages/web/tests/personal-coding-hub-template.test.ts`(读实文件过真 `parseTemplate`
+ 真 import 路由,改坏即红)。

**真用起来**:① 装 Obsidian「Local REST API」社区插件,把 `methodology-vault/` 的笔记
拷进你的 vault;② `export OBSIDIAN_API_KEY=…`;③ 用 README 末尾的 `curl` 把
`template.yaml` 导入真 host;④ 导师 agent 就能 `obsidian__search` 这套方法论来指导路由。

## 关键设计:hub 边界强制「共享」,不靠 LLM 记性

`SharedWorkspaceCli`(`src/shared-workspace-cli.ts`)在 prompt 到达 CLI 之前,把它
包成:

```
Project spec: AGENTS.md. Progress log: PROGRESS.md.
Read both before working, and append a one-line entry to PROGRESS.md when done.
TASK: <真正的任务>
```

所以**无论路由把任务派给谁**,两个 agent 都被同样地要求读同一份规范 + 写同一份进度
日志 —— 协同是 hub 保证的,不是寄希望于模型每次都记得。串行交接(一次一个)天然无
文件竞争:codex 起步时 claude-code 已经写完进度。

## 真跑:交互式命令行(MiniMax 路由 + 真 CLI)

上面的 demo 用 mock。要**真跑**——一个真路由 LLM 决定派活、真 Claude Code / Codex 真改
你的代码——用这两个入口(`src/cli.ts` 交互式 + `src/index.real.ts` 单发,共用
`src/real-agents.ts` 的接线):

```bash
# 交互式(推荐):开一个 readline 循环, 不停地敲目标
MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli
#   coding-hub> 给 utils.ts 加一个 debounce 函数
#   coding-hub> 审一下 auth.ts 有没有注入风险, 别改代码
#   coding-hub> :quit
# 指到你自己的真仓库(默认是一次性临时 git repo):
MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli -- --cwd /path/to/your/repo
# 只验路由不真跑 CLI(省钱的空跑, 编码 agent 换成进程内 mock):
STUB_CODERS=1 MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli

# 单发一个目标然后退出(脚本 / CI 友好):
MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:real -- "给 math.js 加 isEven(n)"

# 链条自检:不带 MINIMAX_API_KEY 也能跑——路由脑自动换成确定性 stand-in(仍发真 dispatch),
# 真 Claude Code + Codex 真跑, 末尾打印 ✅/❌「链条跑通」判定(只验整条链能跑到底, 不验派给谁):
pnpm demo:personal-coding-hub:real -- "给 mathx.js 加 add(a,b) 和 mul(a,b), 先写一行设计说明"
```

> **链条测试 vs 结果**:`:real` 的判定故意**只看链条**——router 返回 ok 且 `PROGRESS.md`
> 至少多了一条交接(`- [...]`),就算 ✅。它**不**断言派给了哪个 coder、或它写出了什么(真模型
> 这些是会抖的);那是「结果」。要断言确定的路由集合,看 mock 的 `pnpm demo:personal-coding-hub`
> ——它用确定性 mock coder,可以钉死「这个目标 × 这个安排 → 该派谁」。
>
> 注:从一个 Claude Code 会话里驱动真 `claude` 时,`makeCoder` 会替子进程剥掉 `CLAUDECODE`
> 等嵌套标记(否则子 `claude` 会拒跑「已在 Claude Code 内」);登录是文件/keychain 解析的,剥环境
> 变量不影响它各用各的登录。

交互里 `:` 开头是 meta 命令:`:help` `:files`(列工作区文件)`:progress`(打印
`PROGRESS.md` 交接日志)`:roster`(打印当前总分工层)`:policy <大白话>`(用大白话改总分工层,
见上节「让用户说了算」)`:quit`。其它任何输入都作为「编码目标」交给路由模型 —— 也可以在目标
里直接点名(显式分派)。

**三层独立认证,故意隔开**(这是「整合」的关键 —— 路由脑的 key 绝不漏进编码 agent):

| 层 | 是谁 | 认证 |
|---|---|---|
| ① 路由脑 | `LlmAgent` + MiniMax M2.1(`OpenAIProvider` 指向 `api.minimaxi.com`) | `MINIMAX_API_KEY`,**显式**传给 provider —— 绝不导成 `OPENAI_API_KEY`(codex 会读它) |
| ② claude-code | 真 `claude -p` CLI | 它**自己的登录**(`~/.claude.json`),hub **不注入任何 key** |
| ③ codex | 真 `codex exec` CLI | 它**自己的登录**(`~/.codex/auth.json`),hub **不注入任何 key** |

所以路由用你的 MiniMax 订阅,两个编码 CLI 各用自己的订阅 —— hub 居中调度,谁的凭证
都不串台。`MINIMAX_*` 可用 `MINIMAX_MODEL`(默认 `MiniMax-M2.1`)/ `MINIMAX_BASE_URL`
覆盖。MiniMax 是推理模型,最终一行总结里的 `<think>…</think>` 已被 `stripThink` 滤掉。

> **MiniMax 大陆版 vs 全球版**:本例默认 `api.minimaxi.com`(大陆版,
> [platform.minimaxi.com](https://platform.minimaxi.com) 拿 key、查 token-plan 余额)。
> 全球版是 `api.minimax.io`,把 `MINIMAX_BASE_URL` 改过去即可。

**安全默认**:临时一次性 `git init` 的工作区(`--cwd` 指真仓库时不动你已有的文件);
`dangerousCommandGate()` 常挂;claude 跑 `--permission-mode acceptEdits`、codex 跑
`--sandbox workspace-write`,都钉在工作区里。

## 指到真 Claude Code / Codex(接线细节)

上面的 `:cli` / `:real` 已经把这套接好了。想自己拼,把 mock 换成 `@aipehub/cli-agent`
的 `CLI_PRESETS` 预设、给各自的 key、换一个真 provider 即可 —— hub 接线一模一样:

```ts
import { CLI_PRESETS } from '@aipehub/cli-agent' // 或本仓库 coding-agent-bridge 的 presets
import { AnthropicProvider } from '@aipehub/llm-anthropic' // 路由的真 LLM

const claudeCode = CLI_PRESETS['claude-code'] // claude -p "{prompt}"
const codexCli = CLI_PRESETS['codex']        // codex exec "{prompt}"

const coder = new SharedWorkspaceCli({
  id: 'claude-code',
  capabilities: ['code'],
  command: claudeCode.command,
  args: claudeCode.args,
  promptVia: claudeCode.promptVia,
  cwd: '/path/to/your/repo',                 // ← 两个 agent 指同一个仓库 = 共享文件
  env: { [claudeCode.apiKeyEnv]: process.env[claudeCode.apiKeyEnv] },
  gate: dangerousCommandGate(),
  timeoutMs: 120_000,
})
```

路由的 `provider` 换成真 LLM 后,**派给谁、怎么反馈**就成了模型的判断 —— demo 里那个
`planRoute(goal, policy, override)` 的情境路由(琐碎只派 Codex、审查只派 Claude Code、功能两个
都派;点名则覆盖)正是真模型从你的目标 + 总分工层该做出的同一个判断,只是这里用纯函数钉死好
让 demo 能自断言。真跑时总分工层从 `routing-policy.json` 渲染进 router 的 system prompt
(`buildRouterSystem(policy)`),`:policy` 改了文件就即时生效。

## 安全须知(真接时务必看)

- **动作闸必挂**:真 agent 能改文件 / 花钱 / 对外发,`dangerousCommandGate()` 是默认
  推荐(命中 `rm -rf` / `git push` / `sudo` / `curl|sh` … 就挂起等人批)。
- **受限 cwd + 最小 env**:别让 agent 继承整个 `process.env`;cwd 钉到那一个项目仓库。
- **凭证**:每个 CLI 的 key 走 `env` 显式注入,Claude Code 用 `ANTHROPIC_API_KEY`,
  Codex 用 `OPENAI_API_KEY`。
- **接管缝可选**:`CliParticipant` 还带 `TakeoverController`(轮间接管)和续跑缝,本
  demo 没演,需要时见 `coding-agent-bridge`。

## 相关

- `examples/coding-agent-bridge/` —— 单个 CLI 的五条控制缝(observe/intercept/handoff/
  resume/terminate)逐个演示;本 case 在它之上加「路由 LLM + 多 agent 共享仓库」。
- `examples/architect-team/` —— 路由 LLM 派子 agent 的 `DispatchToolset` 原型。
- `examples/obsidian-kb/` —— Obsidian vault 当知识库(`mcp-obsidian`)的最小样例;本
  case 的方法论 KB 复用同一套 Local REST API 接线。
- `examples/oneclick-template/` —— `aipehub.template/v1` 可载入模板格式的范本(本 case
  的 `template/` 照它的字段写)。
- `packages/cli-agent/` —— `CliParticipant` + `CLI_PRESETS` + 动作闸(core-only 叶包)。
- `docs/zh/AGENT-ADAPTER-CONTRACT.md` —— 主流 agent 适配器「双向 + 可快速接管」契约。
- `docs/zh/V5-E2-CLI-ADAPTER.md` —— 出站 CLI shell-out adapter 设计。
- `docs/zh/KB-CONNECTORS.md` —— 知识库连接器(Obsidian / ES / 向量 RAG)+ 读写治理
  + 跨 hub 两层闸 + 模板带引用不带内容。
