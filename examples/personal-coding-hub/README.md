# personal-coding-hub — 一个个人 hub 同时管 Claude Code 和 Codex

> AipeHub **能承担的一个案例**(不是框架功能,代码全在 `examples/`)。一个**个人
> hub** 里:一个**路由 LLM** 主动决定把编码任务派给 Claude Code 还是 Codex,而两个
> agent **操作同一个仓库**,因此共享项目级文件 —— `AGENTS.md`(规范)+ `PROGRESS.md`
> (进度交接棒)。

这回答三个诉求:

| 诉求 | 怎么落地 |
|---|---|
| **整合 + 主动管理/激活** | 一个 `LlmAgent`(路由)带 `DispatchToolset`,按 `agentId` 决定每一步派给谁 —— claude-code 起草 → codex 实现。**派给谁是模型的决策**,不是写死的顺序。 |
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
pnpm demo:personal-coding-hub
```

不需要任何 API key —— 路由用脚本化的 `MockLlmProvider`,两个编码 agent 用确定性的
mock CLI(`src/mock-coder.mjs`,纯 node)。但**文件共享是真的**:demo 起一个真临时
仓库,写真 `AGENTS.md` + `PROGRESS.md`,mock CLI 真读真写它们。`index.ts` 会**自断言**
两个 agent 都写进了同一个 `PROGRESS.md`、且危险任务 fail-closed —— 所以这个 example
同时是一个 smoke 测试。

## demo 故事(三段)

| 段 | 演示 | 机制 |
|---|---|---|
| **[1] 路由主动管理** | 你把**一个目标**交给路由;它派 claude-code 起草、再派 codex 实现 | `LlmAgent` tool-use loop → `DispatchToolset.dispatch_task({agentId})` |
| **[2] 共享文件证明** | 最终 `PROGRESS.md` 里**两个 agent 各一条** —— 证明它俩共享同一个文件;codex 读到 `1 prior entries` = 看到了 claude-code 的交接 | 同 `cwd` + `SharedWorkspaceCli` 在 hub 边界注入「先读后写」约定 |
| **[3] 安全闸** | 一条 `rm -rf` / `git push --force` 的任务在 CLI **还没 spawn 前**就挂起等人批;拒绝 → 任务 fail-closed,CLI 从未跑 | `dangerousCommandGate()`(Phase E2 的 T2 动作闸) |

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

## 指到真 Claude Code / Codex

把 mock 换成 `@aipehub/cli-agent` 的 `CLI_PRESETS` 预设,给各自的 key,换一个真
provider 即可 —— hub 接线一模一样:

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

路由的 `provider` 换成真 LLM 后,**派给谁、怎么反馈**就成了模型的判断;脚本里写死的
两个派发会被模型按你的目标动态生成。

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
- `packages/cli-agent/` —— `CliParticipant` + `CLI_PRESETS` + 动作闸(core-only 叶包)。
- `docs/zh/AGENT-ADAPTER-CONTRACT.md` —— 主流 agent 适配器「双向 + 可快速接管」契约。
- `docs/zh/V5-E2-CLI-ADAPTER.md` —— 出站 CLI shell-out adapter 设计。
