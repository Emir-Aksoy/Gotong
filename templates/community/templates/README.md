# 社区 Hub 模板（`aipehub.template/v1`）

> 这个目录收**整套 hub 模板** —— 一个文件装下「N 个智能体 + N 条工作流 + 知识库
> 接线 + 一键填 key 提示」，导入即得一个能干活的 hub。
>
> 它跟隔壁 [`../agents/`](../agents/)、[`../teams/`](../teams/) 不是一回事：那两个是
> **单个 prompt / 单个小队**的改造；这里是**一整套架构**的搬运（决策 #4：模板带
> 结构 + 引用，**永不带知识内容、永不带人员**）。

如果你只想贡献一个单 agent prompt，去 [`../README.md`](../README.md)。如果你想把
「一个完整的、别人照着导入就能跑的 hub」分享出来，你来对地方了。

---

## 什么是 hub 模板

一个 `aipehub.template/v1` YAML 文件，自包含地描述：

- **agents** —— 托管 LLM 智能体（provider / model / system prompt / 能力 / 挂哪些
  MCP server）。
- **workflows** —— 声明式工作流（步骤、`human:` 人工确认闸、`when:` 条件、
  `surface.me` 成员自助入口）。
- **knowledgeBases** —— 知识库**槽位**（只带「接哪个 MCP server」的引用 + 一个
  `presetData` 指针，**绝不带知识内容本身**）。
- **defaults.apiKeyPrompt** —— 导入时一次性提示填 key，自动应用到带 provider 的 agent。
- **provenance**（可选但鼓励）—— 溯源块：`author` / `derivedFrom` / `notes`。见下。

导入路径就是 admin UI 的「工作流 / 模板画廊 → 导入」，或
`POST /api/admin/templates/import`。导入时框架用**真的** `parseTemplate` +
`parseWorkflow` 重新校验每一块 —— 所以一个能合并进来的模板，必然是一个真能导入的模板。

---

## 三个「照着改」的范例

不要从空文件开始。挑一个最接近你想法的旗舰模板，复制它的 `template/*.yaml`，改成你的：

| 范例 | 形态 | 你照着学什么 |
|---|---|---|
| [`examples/cafe-ops`](../../../examples/cafe-ops/template/cafe-ops.template.yaml) | **组织 · 管理面** | 多 agent + 多条声明式工作流 + `human:` 审批闸（店长定钱）+ `surface.me` 成员自助。最典型的「正式流程」模板。 |
| [`examples/smart-home-hub`](../../../examples/smart-home-hub/template/smart-home-hub.template.yaml) | **个人 · 小而完整** | 单 agent + 挂一个 MCP server（Home Assistant）+ 一条带 `human:` 安防确认 + `when:` 闸的工作流。**没有 KB 槽位**（设备状态就是实时 MCP，不需要单独知识库）—— 学「最小可用模板长什么样」。 |
| [`examples/personal-coding-hub`](../../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml) | **个人 · 知识库** | 1 个导师 agent + 1 个可寻址 KB 槽位（`presetData` 指针指向 Obsidian 库）。学「带知识库引用、但知识内容住模板外」怎么写。 |

每个范例旁边都有一个 `pnpm demo:<name>:template` 的载入演示（config-preview，不起子
进程、不要 key），你可以先跑一遍看模板怎么被解析的：

```bash
pnpm demo:cafe-ops:template
pnpm demo:smart-home-hub:template
pnpm demo:personal-coding-hub:template
```

---

## 提交流程（5 步）

```
  1. 复制范例 ──▶ 2. 改成你的 ──▶ 3. 声明溯源 ──▶ 4. 本地校验 ──▶ 5. 开 PR
```

### 1 · 复制一个范例

把上面三个里最接近的那个 `template/*.yaml` 复制到本目录，重命名，例如
`templates/community/templates/my-bakery-ops.template.yaml`。

### 2 · 改成你的

改 agent 的 `system` prompt、能力、工作流步骤。**两条硬规矩**：

- **凭证只能是 `${ENV}` 占位符。** 任何写死的 key / token / 密码 —— 直接拒收。
  令牌以**环境变量名**的形式存在（如 `${HA_TOKEN}`），导入时才填真值。
- **不带知识内容、不带人员。** KB 槽位只写「接哪个 MCP server」+ `presetData`
  指针；不要把你的笔记、你团队的成员名单塞进模板。

### 3 · 声明溯源（`provenance`）

如果你的模板是**从另一个模板改来的**，在顶层 `template:` 下加一个 `provenance` 块：

```yaml
schema: aipehub.template/v1
template:
  name: 我的面包店运营
  version: 1
  provenance:
    author: 你的名字 / handle
    derivedFrom:
      - cafe-ops            # 你照着改的那个模板的 id / slug
    notes: 在 cafe-ops 的排班 + 加班审批之上，加了一条「烘焙备料清单」工作流。
  agents: [ ... ]
  workflows: [ ... ]
```

`derivedFrom` 是**引用边** —— 它让信用回流到上游。静态引用排行榜（见
[`docs/zh/FLAGSHIP-TEMPLATES.md`](../../../docs/zh/FLAGSHIP-TEMPLATES.md)）就是数
「有多少模板 `derivedFrom` 你」。**别为了显得原创就删掉它** —— 诚实的溯源是这个
社区的货币。原创模板可以省略 `provenance`，或只写 `author`。

### 4 · 本地校验（不依赖大模型、不需要 CI）

跑社区模板校验器 —— 它把本目录每个 `*.template.yaml` 喂给**真的** `parseTemplate`
和 `parseWorkflow`，一个语法/结构错误都漏不掉：

```bash
pnpm check:templates
```

绿了就说明你的模板能被真 host 导入。这跟合并时跑的是**同一个**校验，所以本地绿 =
PR 绿（详见
[`packages/web/tests/community-templates.test.ts`](../../../packages/web/tests/community-templates.test.ts)）。

### 5 · 开 PR

- 文件头部注释写清楚：这个模板是干什么的、要填哪些 `${ENV}`、对应哪条工作流。
- 如果改造了有许可的上游材料，按
  [`../README.md`](../README.md) 的规矩补 `LICENSE-NOTICES.md`（只收
  CC0 / MIT / Apache-2.0 / BSD，不收 non-commercial / 未声明许可）。
- PR 描述里说一句「跑过 `pnpm check:templates`，绿」。

---

## 合并标准（社区档）

参考 [`GOVERNANCE.md`](../../../GOVERNANCE.md)「How a template enters the official
gallery」。社区档的承诺是 **「我们查了许可、它能解析」**，不是 「我们替你的品味背书」：

1. ✅ 过 `parseTemplate` + 每条内嵌工作流过 `parseWorkflow`（自动校验，非人眼）。
2. ✅ 凭证全是 `${ENV}` 占位符，零明文密钥。
3. ✅ 改造的上游材料许可清晰且允许商用。
4. ✅ 有溯源（若是衍生）。

满足这四条就合并。想更进一步、被框架**主动推荐**给小白用户（进一键画廊 + 公开站点），
那是**旗舰档**，门槛更高（要带确定性 demo、要讲清治理姿态、要有人维护）——
见 [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../../docs/zh/FLAGSHIP-TEMPLATES.md)。

---

## 将来搬去独立仓

跟 [`../README.md`](../README.md) 说的一样：这些社区模板现在跟主代码同仓只为早期迭代
方便，将来会和 `templates/` 一起迁到独立仓 **`AipeHub/aipehub-templates`**，迁仓后放
云端 raw URL 直接给用户下载。届时 `provenance` / `derivedFrom` 这套溯源数据会一起搬走，
排行榜继续算。
