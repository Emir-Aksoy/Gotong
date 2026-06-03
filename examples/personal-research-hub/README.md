# personal-research-hub — 一个个人 hub 把源材料编译成可问的知识库

> AipeHub **能承担的一个案例**(不是框架功能,代码全在 `examples/`)。承接
> personal-coding-hub 里那套 Karpathy「LLM-as-compiler」方法论:一个**个人 hub** 把
> raw 源材料(剪藏 / PDF / 笔记)用 agent **编译**成互链的 Obsidian wiki,再
> **ask-your-wiki** —— agent 研究自己的笔记、综合答案、归档回去,知识复利增长。
> 最贴北极星第 1 层「我的 AI 桌面」。

这把 Karpathy 的知识库循环落成三段:

| 段 | 怎么落地 |
|---|---|
| **raw → 编译 wiki**(LLM-as-compiler) | 一个 `CompilerAgent` 读一篇 raw 源材料,写一条互链 wiki 笔记(标题 + 摘要 + `[[index]]` backlink),并在 index 追加一行。LLM 是把 raw「编译」成互链 markdown 的编译器。 |
| **ask-your-wiki**(知识复利) | 一个 `ResearcherAgent` 按关键词检索已编译笔记,综合答案、**标注引用的笔记**,再把答案**归档回 `wiki/answers/`** —— 下一个问题就能找到它。 |
| **主动 ingest-vs-retrieve** | 一个 `LlmAgent`(librarian 馆员)带 `DispatchToolset`,按 `agentId` 决定「先编译新源材料还是从已编译笔记答问」—— **派给谁是模型的决策**,不是写死的顺序。 |

```
            ┌──────────── 个人 hub ────────────┐
   你 ──────▶  librarian (LlmAgent)             │
   一个目标   │   │  dispatch_task(agentId)      │
            │   ├──▶ compiler   (raw → wiki 笔记 + backlink)
            │   └──▶ researcher (ask-your-wiki: 检索 → 综合 → 归档)
            └──────────────────────────────────┘
                         共享知识库(磁盘真目录)
                         ├─ raw/        源材料(只增不改)
                         └─ wiki/       编译层(agent 写)
                            ├─ index.md          互链首页
                            ├─ <note>.md         一条 raw 一条笔记, 都 backlink index
                            └─ answers/<q>.md    ask 结果归档(知识复利)
```

## 跑起来

```bash
pnpm demo:personal-research-hub            # [A] raw → 编译 wiki → ask-your-wiki(可跑+自断言)
pnpm demo:personal-research-hub:template   # [B] 载入「研究团队」模板 + 预览(见下)
```

[A] 不需要任何 API key —— librarian 路由用脚本化的 `MockLlmProvider`,compiler /
researcher 是确定性的 stand-in。但**文件 I/O 是真的**:demo 起一个真临时知识库,种
两篇 raw 源材料,agent 真读真写 `wiki/`。`index.ts` 会**自断言**每篇 raw 都编译出一
条 backlink 到 index 的笔记、且 ask 结果归档回 `wiki/answers/` 并引用来源 —— 所以这
个 example 同时是一个 smoke 测试。

## demo 故事(三段)

| 段 | 演示 | 机制 |
|---|---|---|
| **[1] 主动管理** | 你把**一个目标**交给 librarian;它先把 raw 编译进 wiki(派 compiler ×2),再从 wiki 答问(派 researcher) | `LlmAgent` tool-use loop → `DispatchToolset.dispatch_task({agentId})` |
| **[2] 互链 wiki** | 编译后**每篇 raw 一条笔记**,各自 `[[index]]` backlink;`index.md` 列出它们 —— Karpathy 描述的互链 wiki | `CompilerAgent` 真写 `wiki/<slug>.md` + 追加 index 行 |
| **[3] 知识复利** | researcher 的答案作为**新笔记**归档回 `wiki/answers/`,引用用到的笔记 —— 下一个问题能找到它 | `ResearcherAgent` 关键词检索 + 写 `answers/<q>.md` |

## 可载入「研究团队」模板

这个案例的研究团队是一个**可载入文件**,不是写死在 `index.ts` 里的 TS 字面量 ——
`template/personal-research-hub.template.yaml`(`aipehub.template/v1`)。它声明:

- **3 个托管 LLM agent**:`librarian`(路由)/ `compiler`(编译)/ `researcher`(检索),
  三个都挂 `mcp-obsidian` 接到你的 Obsidian wiki。
- **一个可寻址知识库槽位**(`research_wiki`):经 `mcp-obsidian` 接到你的 vault;
  `presetData` 是一个指向种子 wiki 快照的**指针**。

```
  template/personal-research-hub.template.yaml   (aipehub.template/v1 — 可载入)
  ├─ agents:          librarian / compiler / researcher  ──┐ 各自带 mcpServers (obsidian)
  │                                                        │  → 路由 / 编译 / ask-your-wiki
  ├─ knowledgeBases:  research_wiki ── mcp-obsidian (你的 Obsidian wiki)
  │                    └─ presetData:  指针(不是内容!)──┐
  └─ defaults.apiKeyPrompt: DeepSeek                       │
                                                           ▼
            知识**内容**住在模板之外(决策 #4)= 你自己的 Obsidian wiki
            (可跑 demo 在临时目录里种 2 篇 raw 演示整个循环;真用时接你的 vault)
```

**为什么模板里有 3 个 agent**(对比 personal-coding-hub 模板只有 1 个):coding-hub 的
claude-code / codex 是 `CliParticipant`,不能当托管 agent,所以那边模板只带导师。这里
librarian / compiler / researcher **本来就都是托管 LLM agent**,所以模板把**整支研究队
一起搬走**(Stream B「一个文件装 N agent」)。编排(librarian → compiler / researcher 的
dispatch 图)是 `DispatchToolset`(Phase 10)代码级接线,模板 schema 不承载 —— 留给
example 代码或一条工作流去串(同 coding-hub 口径,`workflows: []`)。

**为什么知识内容不在模板里**(Stream B 决策 #4):模板只带「结构 + 引用」,永不带知识
内容。模板用 `presetData` 指针引用一份种子 wiki 快照,不内联。可跑 demo 在运行时种两
篇 tiny raw fixtures(见 `src/knowledge-base.ts`)只为把循环演完整 —— 真用时把 KB 槽位
接到你自己的 Obsidian wiki。

**预览(载入演示)**:`pnpm demo:personal-research-hub:template` 把模板从磁盘读出来、
解析、打印研究团队 + KB 槽位 + 指针(config-preview,不起 mcp-obsidian 子进程 —— 同
`examples/obsidian-kb` 策略)。严格的「过真 schema + 真导入」证明在
`packages/web/tests/personal-research-hub-template.test.ts`(读实文件过真 `parseTemplate`
+ 真 import 路由,改坏即红)。

**真用起来**:① 装 Obsidian「Local REST API」社区插件;② `export OBSIDIAN_API_KEY=…`;
③ 用 README 末尾的 `curl` 把 `template.yaml` 导入真 host;④ librarian / compiler /
researcher 就能 `obsidian__search` / `obsidian__get_file_contents` 在你真实的 wiki 上跑
raw → 编译 → ask 循环。

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' \
    examples/personal-research-hub/template/personal-research-hub.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

## 关键设计:文件机制确定性,LLM 只管「判断」

compiler / researcher 在 demo 里是**确定性 stand-in**:编译 = 读 raw 抽首段 + 建
backlink;检索 = ASCII 关键词重叠打分。**文件机制不需要 LLM**,所以 demo 零 key 可跑、
能当 smoke 测。中文问句用 ASCII 关键词(len≥3)打分,绕开 CJK 分词 —— 技术英文术语
(`llm` / `compiler` / `software`)足以命中。

真用时把这两个换成**真 `LlmAgent`**(一个 provider 写摘要 / 答案),把 librarian 的
mock provider 换成真的 —— **hub 接线一字不改**。判断(编译成什么、答案引哪些笔记)就
成了模型的事;文件读写、backlink、归档这些机制照旧。

## 指到真 Obsidian wiki

把 worker agent 换成挂 `mcp-obsidian` 的真 `LlmAgent`,wiki 就从临时目录换成你的
Obsidian vault(同 `examples/obsidian-kb` 的 Local REST API 接线):

```ts
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { McpClientToolset } from '@aipehub/mcp-client'

const compiler = new LlmAgent({
  id: 'compiler',
  capabilities: ['compile'],
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  system: '读 raw 源材料,写一条互链 wiki 笔记(摘要 + [[backlink]]),写回 vault。',
  tools: await McpClientToolset.connect({              // obsidian__search / __get_file_contents…
    name: 'obsidian',
    command: 'uvx',
    args: ['mcp-obsidian'],
    env: { OBSIDIAN_API_KEY: process.env.OBSIDIAN_API_KEY! },
  }),
})
```

## 安全须知(真接时务必看)

- **读 vs 写治理**:检索(只读)默认放开;编译 / 归档(写 vault)是显式动作,不可逆的
  改动(删笔记 / 覆盖)应走人闸。详见 `docs/zh/KB-CONNECTORS.md` 的读写治理一节。
- **凭证**:`OBSIDIAN_API_KEY` 走 `env` 显式注入,模板里是 `${OBSIDIAN_API_KEY}` 占位,
  绝不字面 secret。
- **跨 hub 两层闸**:把这个 wiki 共享给别的 hub 时,MCP server 自身 ACL + AipeHub
  per-link KB allowlist(Stream C `gateKnowledgeBaseRpc`)两层都管。

## 相关

- `examples/personal-coding-hub/` —— 同源的「个人 hub + 路由 LLM」案例(管 Claude Code
  + Codex);它的方法论 vault 正是本 case ask-your-wiki 的知识来源。
- `examples/obsidian-kb/` —— Obsidian vault 当知识库(`mcp-obsidian`)的最小样例;本
  case 的 wiki KB 复用同一套 Local REST API 接线。
- `examples/oneclick-template/` —— `aipehub.template/v1` 可载入模板格式的范本(本 case
  的 `template/` 照它的字段写)。
- `examples/architect-team/` —— 路由 LLM 派子 agent 的 `DispatchToolset` 原型。
- `examples/rag-mcp/` —— 向量检索 RAG(`chroma-mcp`);同「框架不存知识」模式的另一形态。
- `docs/zh/KB-CONNECTORS.md` —— 知识库连接器(Obsidian / ES / 向量 RAG)+ 读写治理
  + 跨 hub 两层闸 + 模板带引用不带内容。
