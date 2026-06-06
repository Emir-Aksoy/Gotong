# 上手案例 — 5 个开箱即用的 hub

> 单一入口:这 5 个 `examples/` 案例不是「片段」,而是**能搬走的完整 hub**。每个都带
> 一个**确定性可跑 demo**(无需 API key,`pnpm` 一行跑通自断言)和一个**可载入模板**
> (`aipehub.template/v1`,一个文件装走 agent + 工作流 + KB 接线)。本文帮你 ① 选一个、
> ② 先跑确定性 demo 看清骨架、③ 接真 LLM(DeepSeek)+ 真知识库(Obsidian)上线。
>
> 北极星:**框架永不跑 LLM**。这些 hub 里所有 LLM 决策都在 agent(参与者)手里,Hub 只
> 路由消息 / 派 task / 写 transcript。所以 demo 能用确定性 stand-in 替掉 LLM 跑通同一套
> 接线 —— 「换上 DeepSeek,别的不变」。
>
> Last updated: 2026-06-04

---

## 一、这 5 个 hub 是什么

| hub | 类型 | 一句话 | 编排方式 | 模板装了什么 |
|---|---|---|---|---|
| [`personal-coding-hub`](../../examples/personal-coding-hub) | 个人 | 一个路由 LLM 调度 Claude Code + Codex 两个 CLI,共享同一仓库(`cwd`),靠 `AGENTS.md`/`PROGRESS.md` 交接 | 运行时 DispatchToolset(代码) | 1 导师 agent + `coding_methodology` KB |
| [`personal-research-hub`](../../examples/personal-research-hub) | 个人 | librarian 把 raw 源材料**编译**成互链 Obsidian wiki(LLM-as-compiler),再 ask-your-wiki | 运行时 DispatchToolset(代码) | 3 agent(librarian/compiler/researcher)+ `research_wiki` KB |
| [`battle-monk-training`](../../examples/battle-monk-training) | 个人 | 督修把今日操练派给「身/心/学」三柱,各自把成长**状态**写进持久 Codex | 运行时 DispatchToolset(代码) | 4 agent(督修 + 三柱)+ `acolyte_codex` KB |
| [`cafe-ops`](../../examples/cafe-ops) | **组织** | 奶茶/咖啡店:新员工上手 / 排班 / 加班,走「成员自助 → 店长审批」正式流程 | **声明式工作流**(模板里) | 2 agent + **3 工作流** + `store_ops_manual` KB |
| [`warband-club`](../../examples/warband-club) | **组织** | 战团同好会:全团共读共写一个**共享档案库**,贡献 / 问询 / 集结(战团长确认) | **声明式工作流**(模板里) | 2 agent + **3 工作流** + `warband_archive` KB |

**怎么选:**

- **想要个人 AI 桌面**(我自己用,私人 workflow,凭证只在本机)→ 三个 `personal-*` / `battle-monk`。
  它们的编排是**运行时** `DispatchToolset`(Phase 10):一个路由 agent 用 tool-use 主动决定派给谁。
  模板因此 `workflows: []` 留空 —— 价值在 agent 阵容 + KB,不在声明式流程。
- **想要组织协作**(多成员,正式流程,要「等人拍板」的步骤)→ `cafe-ops`(管理面)/ `warband-club`(协作面)。
  它们的价值在**声明式工作流**,所以模板 `workflows[]` 非空,用上两件组织能力:
  - **`surface.me`**(Phase 14)—— 成员在 `/me` **为自己**发起一条工作流。
  - **`human:`**(Phase 16)—— 一个步骤**挂起**,直到某个人(店长 / 战团长)在 `/me` 收件箱拍板。

> `cafe-ops`(自上而下审批)和 `warband-club`(围绕共享资源协作)是组织的两张面,建议对照着读。

---

## 二、先跑确定性 demo(无需任何 API key)

每个 hub 都有两条命令:`demo:<hub>` 跑可跑 demo(自断言),`demo:<hub>:template` 预览可载入模板。
全部用**确定性 stand-in** 替掉真 LLM,所以离线、无 key、秒级跑完,且每条都自带断言(= 烟雾测试)。

```bash
# 个人 hub
pnpm demo:personal-coding-hub            # 路由 → Claude Code/Codex 共享 cwd + PROGRESS.md 交接
pnpm demo:personal-research-hub          # raw → 编译成 wiki 笔记 → ask-your-wiki 引来源
pnpm demo:battle-monk-training           # 督修派三柱 → 各写持久 Codex(承前 N 阶)

# 组织 hub
pnpm demo:cafe-ops                       # 新员工上手(无审批)+ 加班申报(HITL 店长审批)
pnpm demo:warband-club                   # 两兄弟贡献 → 第三人问询命中别人的贡献(合作)+ 集结 HITL

# 任一模板的载入预览(config-preview,不起 mcp-obsidian)
pnpm demo:<hub>:template                  # 例:pnpm demo:cafe-ops:template
```

这些 demo 证明的是**hub 接线**(一个工作流 / 路由派出一个 capability,一个参与者应答,一个
`human:` 步骤挂起再恢复),不是模型质量。stand-in 做的是真活(岗位 SOP 查表、加班金额确定性
计算、Obsidian 风格 markdown 读写、CJK bigram 检索),所以断言是真的。

---

## 三、接真 LLM 上线(DeepSeek + Obsidian)

五个模板都默认 **DeepSeek**(`openai-compatible`,`baseURL https://api.deepseek.com/v1`)+ 内联
**mcp-obsidian** 做知识库。从确定性 demo 到真上线,**就这一条共享路径**:

### 步骤 1 — 准备 DeepSeek key

模板自带 `defaults.apiKeyPrompt`(provider `openai-compatible` / label `DeepSeek`):**导入时提示填一次**,
自动应用到模板里所有 agent。底层是 key 解析链(优先级:per-agent → org-pool → **user-pool(成员 BYO)**
→ workspace → env fallback),你也可以预先在 admin「凭证 / API 池」里配好。**框架永不把 key 写进模板文件**
—— 模板里 agent 的密钥位都是 `${ENV}` 占位,真值另填(决策 #5)。

### 步骤 2 — 连你自己的 Obsidian vault 到 KB 槽位

模板带的是 **KB 接线 + presetData 指针**,**不带知识内容**(决策 #4)。每个模板有一个可寻址 KB 槽位
(`coding_methodology` / `research_wiki` / `acolyte_codex` / `store_ops_manual` / `warband_archive`),
背后是 `uvx mcp-obsidian`。要它活起来:

1. 在 Obsidian 装 **Local REST API** 插件,拿到 `OBSIDIAN_API_KEY` / `HOST` / `PORT`。
2. 把这三个值作为环境变量给 host(模板里写的是 `${OBSIDIAN_API_KEY}` 等占位)。
3. host spawn agent 时拉起 `mcp-obsidian` 子进程,把 `obsidian__search` / `obsidian__get_file_contents`
   等工具暴露给该 agent 的 tool-use 循环。

详见 [`KB-CONNECTORS.md`](KB-CONNECTORS.md)(连接器分类 + 读写治理 + 跨 hub 两层闸)和
[`RAG-VIA-MCP.md`](RAG-VIA-MCP.md)。组织 hub 的共享档案库 = **一个 vault,全团共读共写**;个人 hub 的
KB = 你自己的笔记 / 方法论 vault。

### 步骤 3 — 导入模板

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' examples/<hub>/template/<hub>.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

导入会:解析模板 → upsert agent(把 `${ENV}` 占位替回真值)→ 逐条工作流过真 `parseWorkflow` 注册
(仅组织 hub)→ **上报** KB 槽位(**不自动接线** —— 你按步骤 2 接自己的 vault)。这条路径由防腐
验收测试逐字钉死(见第四节)。

### 步骤 4 — 用起来

- **组织 hub**(cafe-ops / warband-club):成员打开 `/me` → 看到 `surface.me` 暴露的工作流 → **为自己**
  发起(如新员工选岗位上手、店员报加班、兄弟贡献档案)。带 `human:` 的步骤会**挂起**,审批人
  (店长 / 战团长)在自己 `/me` 收件箱看到待办,批了才恢复跑完。
- **个人 hub**(coding / research / battle-monk):跟**路由 agent** 对话(chat capability),它用
  `DispatchToolset` 主动把活派给子 agent / CLI;或直接看 example 的 `src/index.ts` 怎么编排,照搬进
  你自己的 host。

---

## 四、验证锚点(哪些已测,哪些要你的 key)

诚实分层 —— 这条 go-live 路径里,**结构**全部已被自动化测试钉死,只有**真 LLM token 调用**这一步要你的 key:

| 环节 | 状态 | 锚点 |
|---|---|---|
| 5 个确定性 demo 跑通 + 自断言 | ✅ 已测(可跑) | `pnpm demo:<hub>` / `:template`,每个 `src/index.ts` 自断言 |
| 模板解析 + 逐条工作流 `parseWorkflow` 往返 | ✅ 已测 | `packages/web/tests/{cafe-ops,warband-club,...}-template.test.ts`(防腐门) |
| `POST /api/admin/templates/import` 落 agent + 注册工作流 + 上报 KB | ✅ 已测 | 同上防腐门:真 `Space`+`Hub`+`serveWeb`+真 import 路由,断言 200 + agent 落库 + 工作流逐条注册 |
| `human:` 挂起 → `/me` 收件箱 → 两步恢复 | ✅ 已测 | `pnpm demo:cafe-ops` / `demo:warband-club`(HITL 段);host `inbox-e2e` 无漂移验收门 |
| 真 provider tool-use 往返 + 整栈工作流 live | ✅ 已测(独立 live 门) | [`V6-ROUTE-B-P1-M13-LIVE-GATE.md`](V6-ROUTE-B-P1-M13-LIVE-GATE.md)(夜间/手动 CI,key 从 secrets,缺 key 跳过) |
| **你的模板 + 你的 DeepSeek key 真跑出答案** | ⏳ 需你的 key | 步骤 1–4;`AIPE_ASSISTANT_PROVIDER` 等 env 见各 example README |
| **你的 Obsidian vault 真被检索** | ⏳ 需你的 vault | 步骤 2;Local REST API 插件 + `mcp-obsidian` |

也就是说:**搬过去、导进去、注册成功、HITL 挂起恢复 —— 全都是测过的;接上你的 key 和 vault 出真答案
—— 是你这一步。** 框架本身不存知识(无 vectors/documents 表)、不连集群、不读你的 vault,全走 MCP 子进程。

---

## 五、模板带什么、不带什么(决策 #4 / #5)

五个模板统一遵守 Stream B 锁定:**带结构与引用,永不带内容或人员**。

- ✅ **agent** —— 只 config(provider / model / system / MCP 接线);密钥位是 `${ENV}` 占位,绝不字面量。
- ✅ **工作流**(仅组织 hub)—— 声明式流程定义(dispatch 图、`surface.me`、`human:` 闸、`governance` 元数据)。
- ✅ **KB 槽位** —— MCP 接线 + `presetData` **指针**。导入 = **上报**,**不自动接线**:你接自己的 vault。
- ❌ **知识内容** —— 你的笔记 / 方法论 / 运营手册 / 战团档案,住你自己的 Obsidian vault 后面。
- ❌ **人员** —— 无 owner / grant / member。谁在你店里 / 谁在你战团,不是可分享架构的一部分。

每个 hub 的细节、ASCII 数据流图、安全边界(如 cafe-ops「钱助手建议、人定」;battle-monk / warband-club
原创同人致敬声明)见各自 README。

---

## 六、情境感知:能力分派要结合使用者的情况

> 一个 hub 好不好用,看它**派活是不是看情况**。盲目扇出(不管你问什么、库里有什么,都把同一套
> 活全派一遍)既浪费又答非所问。这些案例统一遵守一条:**分派结合使用者的当前情况**,且**仍然
> 确定性可断言**(demo 不靠真 LLM 也能把「该派谁」钉死)。两个家族,两种落点:

**个人 hub(运行时路由)—— 把路由抽成一个纯函数 `planXxx()`。**

路由 agent 的「派给谁」不写死,而是从**当前情况**算出来。每个个人 hub 因此有一个**可单测的纯
规划函数**:

- `personal-coding-hub` → `planRoute(goal, policy)`:**结合「任务分析 × 用户安排」**两件事 ——
  `analyzeTask(goal)` 读出任务性质(只读审查 / 琐碎 / 需先设计)× 一个声明式 `RoutingPolicy`
  (谁在岗 `unavailable`、谁善长什么 `profiles`、预算是否限单 `singleCoder`)。所以**同一个目标在
  不同安排下派得不同**:Codex 在岗 → 功能交 `claude-code` 起草 + `codex` 实现;Codex 不在岗 →
  `claude-code` 一人包办。理想 coder 不在岗就优雅降级给在岗的顶上,**绝不派一个不在岗的 agent**。
- `personal-research-hub` → `planResearch(goal, wikiSnapshot)`:**只编译 wiki 里还缺的源**,已编译的
  不重编;纯答问跳过编译直接检索。
- `battle-monk-training` → `planSession(situation, priorCodex)`:按修士档案(各柱已练阶数)+ 今日意图,
  派「身 / 心 / 学」三柱的**子集** + 合适强度,而不是每次三柱全上。

demo 里把 mock provider 换成一个**情境感知的 `LlmProvider`**:它从 prompt 里读出情况 + 数已发生的
`tool_use` 轮次 → 调 `planXxx()` → 每个规划步派一个目标。于是「同样的 agent 阵容,不同的情况派出
不同的子集」这件事**离线就能断言**(demo 对**派出集合**做集合相等断言,既抓漏派也抓多派)。

**组织 hub(声明式工作流)—— dispatch 图是结构性的,情境落在 worker 的算账 + 闸上。**

声明式工作流的 dispatch 图**故意**是固定结构(这是它「可治理、可版本化」的根),所以情境感知不在
「派给谁」,而在两处:

1. **worker 从输入算结果**(不是返回一个静态答案):
   - `cafe-ops`:加班建议金额 = 基础时薪 × **日别倍率**(工作日 1.5 / 休息日 2 / 法定节假日 3)× 时长 ——
     同样 3 小时,因发生在哪天而给出 ¥99 / ¥132 / ¥198。
   - `warband-club`:司库用 bigram 检索**当前共享档案库**,你的答案可能命中**别人早先的贡献**(库变了
     答案就变)。
   - `tea-supply-link`:供货商按**自己的目录 + 实时库存**逐行定价、判有无货。
   - `tea-chain-hq`:门店拿总部下发的调价指令,对**自己的菜单**算 delta、判在不在售。
2. **闸结合情况拦人**:`when:` 条件分支、`human:` 审批(店长 / 战团长拍板)、跨组织**出站审批闸**
   (tea-supply-link / tea-chain-hq:跨边界发货 / 下发前必须有人批)。

**一张表对齐「结合什么情况 → 怎么分派 / 适配」:**

| 案例 | 家族 | 结合的「情况」 | 分派 / 适配机制 |
|---|---|---|---|
| `personal-coding-hub` | 个人·路由 | 任务性质(只读审查 / 琐碎 / 需先设计)**×** 用户安排(谁在岗 / 善长 / 预算限单) | `planRoute(goal, policy)` → 按角色从**在岗** roster 填,理想 coder 不在岗就降级给在岗的 |
| `personal-research-hub` | 个人·路由 | wiki 已编译哪些源 + 来意(入库 / 答问) | `planResearch` → 只补缺的源、纯答问跳过编译 |
| `battle-monk-training` | 个人·路由 | 修士档案(各柱已练阶)+ 今日意图 | `planSession` → 派三柱子集 + 强度 |
| `cafe-ops` | 组织·工作流 | 加班日别(工作日 / 休息日 / 节假日) | worker 算倍率 1.5/2/3;店长 `human:` 审批 |
| `warband-club` | 组织·工作流 | 问询 + 档案库已有贡献 | archivist bigram 检索命中别人的贡献;战团长 `human:` |
| `tea-supply-link` | 跨组织·工作流 | 订单明细 + 供货商目录 / 库存 | 供货商按目录定价 + 查库存;出站审批闸 |
| `tea-chain-hq` | 跨组织·工作流 | 下发指令 + 门店自有菜单 | 门店算 delta vs 自有菜单;出站审批闸 |

> **一句话**:个人 hub 把「看情况派谁」抽成纯函数 `planXxx()`(可单测);组织 hub 让 dispatch 图保持
> 结构性,把情境感知放进 worker 的确定性算账 + `when:` / `human:` / 出站审批闸。两条路都做到「结合
> 使用者的情况」,且都不靠真 LLM 就能断言。

---

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 知识库连接器(Obsidian / Elasticsearch / 向量 RAG,全走 MCP)+ 读写治理 | [`KB-CONNECTORS.md`](KB-CONNECTORS.md) |
| RAG 向量检索 via MCP(框架不存知识,`mcpServers` 完整 schema) | [`RAG-VIA-MCP.md`](RAG-VIA-MCP.md) |
| 一键模板格式(`aipehub.template/v1`,一个文件装走一整套架构) | [`V5-B-FINAL.md`](V5-B-FINAL.md) |
| 成员任务 inbox(`human:` HITL 工作流步骤) | [`V4-PHASE16-FINAL.md`](V4-PHASE16-FINAL.md) |
| `/me` 成员工作台(我的 AI 桌面) | [`V4-PHASE19-P1-FINAL.md`](V4-PHASE19-P1-FINAL.md) |
| 真 LLM 冒烟门进 CI(provider 往返 + 整栈工作流 live) | [`V6-ROUTE-B-P1-M13-LIVE-GATE.md`](V6-ROUTE-B-P1-M13-LIVE-GATE.md) |
| 出站驱动 CLI agent(hub → Claude Code/Codex,personal-coding-hub 用) | [`V5-E2-CLI-ADAPTER.md`](V5-E2-CLI-ADAPTER.md) |
