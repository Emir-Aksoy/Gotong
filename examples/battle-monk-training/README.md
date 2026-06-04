# battle-monk-training — 战斗修士锻炼:一个为冷峻者而设的个人成长 hub

> 5 个[上手案例 hub](../../docs/zh/HANDS-ON-HUBS.md) 之一(3 个人 + 2 组织)—— 对照总览 + 真 DeepSeek/Obsidian 上线指南见该索引。

> AipeHub **能承担的一个案例**(不是框架功能,代码全在 `examples/`)。一个**个人
> 成长 hub**:督修(路由 LLM)**结合修士今日的处境**(时间 / 精力 / 伤病 / 专攻),把
> 今日操练**合适地**派给三柱 —— **肉身 / 心志 / 学识** —— 而不是不顾状态把三柱全压
> 上;每柱把状态写进一个持久的修士档案 **Codex**(Obsidian-style vault)。冷峻、不留
> 情面的 grimdark-monastic 风格,面向战锤 40k 风格的冷淡型男性用户。

> **原创同人致敬声明**:本案例的所有文案均为原创,旨在呈现一种「战斗修士」的美学
> 氛围,**不含任何受版权保护的文本或专有名词**,与 Games Workshop 或任何版权方
> **无官方关联**。它只是一个带主题皮肤的自律/健身/学习成长 hub。

这把「身 → 心 → 学」的成长指引落成三段:

| 段 | 怎么落地 |
|---|---|
| **肉身**(body) | `body-drill` 读档案前序状态,给下一阶体能指令(负重 / 耐力 / 力量 / 节制),写回 `codex/body.md`。 |
| **心志**(mind) | `mind-forge` 给下一阶精神戒律(专注 / 自省 / 抗动摇),写回 `codex/mind.md`。 |
| **学识**(lore) | `lore-scribe` 给下一阶研习指引(典籍 / 法则 / 复述检验),写回 `codex/lore.md`。 |
| **结合状态 + 路由** | 督修(`LlmAgent` + `DispatchToolset`)读修士**今日状态** + 档案前序阶,**只派合适的柱**(不盲目全压);每柱再**按状态调节强度**。 |

**新东西(对比前两个上手案例)**:这里的知识库存的不是参考资料,而是**用户自己的
演进状态**。每次操练各柱追加一条 rank 记录、读上一阶续推 —— 连续性(「承前 N 阶」)
是设计核心,Codex 就是修士的持久档案。

## ★ 结合修士状态分派(本次强化)★

督修**不再不顾状态把三柱全压上**。它先读修士今日的处境(时间 / 精力 / 伤病 / 专攻)
与档案各柱阶次,再用一个**纯函数**`planSession`(`src/situation.ts`)算出今日**派哪几
柱、各自多重**。这就是「**结合使用者的情况,能力分派要合适**」落到代码:

| 剧情 | 今日状态 | 分派(能力) | 强度 |
|---|---|---|---|
| **[A] 满日** | 60 分钟 / 精力高 | 三柱全开:肉身 + 心志 + 学识 | 满负荷 |
| **[B] 瘦日** | 15 分钟 / 精力低 | **只取最落后一柱**(学识) | 轻负荷·恢复 |
| **[C] 伤病** | 45 分钟 / 扭伤脚踝 | **停肉身**,转练心志 + 学识 | 常规 |
| **[D] 专攻** | 40 分钟 / 点名学识 | **学识优先**,挤掉次要(心志顺延) | 常规 |

规则(`planSession` 纯函数,可断言、确定性):**容量**按时间 × 精力(低/紧 → 1 柱;
高且长 → 3 柱;其余 2 柱);**伤病**停 `body`;**专攻**那柱排首位;其余按**最落后**
(rank 最低)先补;超容量的柱顺延。`drillIntensity` 用同样阈值把强度分
恢复 / 常规 / 满负荷,各柱据此调节负荷。

**为什么是纯函数**:路由决策必须可检查、可复现。督修的 provider(确定性 stand-in)
读 prompt 里注入的状态 + 档案阶次后调 `planSession` —— **一个真 LLM 督修从同样的上下文
(修士的消息 + 经 `mcp-obsidian` 读到的档案)会做出同样的判断**,只是少了确定性。

```
            ┌──────────── 个人成长 hub ────────────┐
   修士 ─────▶  preceptor 督修 (LlmAgent)           │
   今日操练   │   │  dispatch_task(agentId)         │
            │   ├──▶ body-drill  (肉身 → codex/body.md)
            │   ├──▶ mind-forge  (心志 → codex/mind.md)
            │   └──▶ lore-scribe (学识 → codex/lore.md)
            └─────────────────────────────────────┘
                         修士档案 Codex(磁盘真目录,存用户状态)
                         ├─ index.md   三柱互链首页
                         ├─ body.md    肉身状态(逐阶追加)
                         ├─ mind.md    心志状态(逐阶追加)
                         └─ lore.md    学识状态(逐阶追加)
```

## 跑起来

```bash
pnpm demo:battle-monk-training            # 4 种状态 → 4 种分派 → Codex(可跑+自断言)
pnpm demo:battle-monk-training:template   # 载入「修士团」模板 + 预览(见下)
```

不需要任何 API key —— 督修是一个**确定性的情境感知 provider**(读 prompt 里的状态 +
档案阶次,调 `planSession`),三柱是确定性的 stand-in。但**文件 I/O 是真的**:每个剧情
起一个真临时 Codex,种三柱 baseline,agent 真读真写。`index.ts` 跑完上面 4 个剧情,每个
都**快照 `priorSteps` 前后、自断言被派的「柱集合」与强度标签** —— 一柱不该练却练了、
或该练却没练,集合就变、断言就红。所以这个 example 同时是一个 smoke 测试。

## demo 故事(4 个剧情,见上「结合状态分派」表)

| 关注点 | 演示 | 机制 |
|---|---|---|
| **结合状态分派** | 督修读今日状态 + 档案阶次,**只派合适的柱**(满日 3 柱 / 瘦日 1 柱 / 伤病停肉身 / 专攻优先) | `planSession` 纯函数 → `DispatchToolset.dispatch_task({agentId})` 逐柱派 |
| **按状态调强度** | 各柱条目带强度标签(`[第N阶·满负荷/常规/轻负荷·恢复]`),枯竭日写恢复指令 | `PillarAgent` 从 payload 读 situation → `drillIntensity` |
| **状态持久 + 续阶** | 被派的柱**多出一条 rank 记录**,读上一阶续推(「承前 N 阶」) | `priorSteps` + 写 `codex/<pillar>.md` |

## 可载入「修士团」模板

这个案例的修士团是一个**可载入文件**,不是写死在 `index.ts` 里的 TS 字面量 ——
`template/battle-monk-training.template.yaml`(`aipehub.template/v1`)。它声明:

- **4 个托管 LLM agent**:`preceptor`(督修 / 路由)+ `body-drill` / `mind-forge` /
  `lore-scribe`(三柱),四个都挂 `mcp-obsidian` 接到你的修士档案 Codex,各带冷峻
  persona system prompt。
- **一个可寻址知识库槽位**(`acolyte_codex`):经 `mcp-obsidian` 接到你的 vault;
  `presetData` 是一个指向种子档案快照的**指针**。

```
  template/battle-monk-training.template.yaml   (aipehub.template/v1 — 可载入)
  ├─ agents:          preceptor / body-drill / mind-forge / lore-scribe ──┐ 各挂 obsidian
  │                                                                       │  → 读档案、给指令、写回
  ├─ knowledgeBases:  acolyte_codex ── mcp-obsidian (你的 Obsidian Codex)
  │                    └─ presetData:  指针(不是内容!)──┐
  └─ defaults.apiKeyPrompt: DeepSeek                       │
                                                           ▼
            修士的**状态档案**住在模板之外(决策 #4)= 你自己的 Obsidian Codex
            (可跑 demo 在临时目录种 baseline 演示整个循环;真用时接你的 vault)
```

**为什么模板里有 4 个 agent**:督修 + 三柱本来就都是托管 LLM agent,所以模板把**整支
修士团一起搬走**(Stream B「一个文件装 N agent」)。编排(督修 → 三柱的 dispatch 图)
是 `DispatchToolset`(Phase 10)代码级接线,模板 schema 不承载 —— 留给 example 代码去
串(`workflows: []`,同 personal-research-hub / personal-coding-hub 口径)。

**为什么状态内容不在模板里**(Stream B 决策 #4):模板只带「结构 + 引用」,永不带你的
状态内容。模板用 `presetData` 指针引用一份种子档案快照,不内联。可跑 demo 在运行时种
三柱 baseline 只为把循环演完整 —— 真用时把 KB 槽位接到你自己的 Obsidian Codex。

**预览(载入演示)**:`pnpm demo:battle-monk-training:template` 把模板从磁盘读出来、
解析、打印修士团 + Codex 槽位 + 指针(config-preview,不起 mcp-obsidian 子进程 —— 同
`examples/obsidian-kb` 策略)。严格的「过真 schema + 真导入」证明在
`packages/web/tests/battle-monk-training-template.test.ts`(读实文件过真 `parseTemplate`
+ 真 import 路由,改坏即红)。

**真用起来**:① 装 Obsidian「Local REST API」社区插件;② `export OBSIDIAN_API_KEY=…`;
③ 用 README 末尾的 `curl` 把 `template.yaml` 导入真 host;④ 督修与三柱就能
`obsidian__search` / `obsidian__get_file_contents` 在你真实的 Codex 上跑评估 → 操练 →
记录循环。

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' \
    examples/battle-monk-training/template/battle-monk-training.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

## 关键设计:Codex 存状态,连续性是 hub 保证的

`PillarAgent`(`src/pillar-agent.ts`)在写新一阶之前,先 `priorSteps` 读档案里已有几阶,
据此算出**下一阶**并把「承前 N 阶」写进记录。所以**无论督修哪天派哪柱**,每柱都从上次
停的地方续推 —— 成长的连续性是 Codex(磁盘状态)+ hub 保证的,不是寄希望于模型记得。

**路由是真 provider 读输入做的判断,不是固定脚本**:`src/preceptor-provider.ts` 是一个
真 `LlmProvider`(不是固定 `MockLlmProvider` 脚本)—— 每次 `stream(req)` 读 prompt 里的
状态 + 档案阶次,调 `planSession` 决定派哪几柱,并靠**数消息里已有的 `tool_use` 块**
判断当前是第几个派发回合。真用时把三柱换成**真 `LlmAgent`**、把督修这个确定性 provider
换成真的 —— **hub 接线一字不改**。判断(读状态、推哪柱、给什么强度的指令)成了模型的
事;`planSession` 的规则就是给真督修的 system prompt 写明的分派原则;读档案、写状态、
续阶这些机制照旧。

## 安全 / 边界须知

- **状态是个人数据**:Codex 存的是用户的身体 / 心理 / 学习状态。真用时这是隐私数据 ——
  vault 留本机,别把 Codex 槽位共享给不该看的 peer(跨 hub 见 `docs/zh/KB-CONNECTORS.md`
  的 per-link KB allowlist)。
- **不是医疗 / 心理建议**:这是一个带主题皮肤的自律陪伴 demo,不替代专业的体能 / 心理
  指导;真接入时在 system prompt 里钉住边界。
- **凭证**:`OBSIDIAN_API_KEY` 走 `env` 显式注入,模板里是 `${OBSIDIAN_API_KEY}` 占位,
  绝不字面 secret。

## 相关

- `examples/personal-research-hub/` —— 同源的「路由 LLM + 多 agent + Obsidian KB」案例;
  那边 KB 存编译 wiki,这边 KB 存**用户状态** —— 同一套 mcp-obsidian 接线的两种用法。
- `examples/personal-coding-hub/` —— 第一个上手案例(路由 LLM 管 Claude Code + Codex)。
- `examples/obsidian-kb/` —— Obsidian vault 当知识库(`mcp-obsidian`)的最小样例;本
  case 的 Codex 复用同一套 Local REST API 接线。
- `examples/oneclick-template/` —— `aipehub.template/v1` 可载入模板格式的范本。
- `examples/architect-team/` —— 路由 LLM 派子 agent 的 `DispatchToolset` 原型。
- `docs/zh/KB-CONNECTORS.md` —— 知识库连接器 + 读写治理 + 跨 hub 两层闸 + 模板带引用
  不带内容。
