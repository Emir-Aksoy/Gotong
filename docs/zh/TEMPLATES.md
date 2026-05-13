# Agent / 团队模板

> 同步自英文版 [`docs/TEMPLATES.md`](../TEMPLATES.md) @ 2026-05-12。
>
> ⚠️ **模板存放位置**
>
> **初始参考集**在主仓 [`templates/`](../../templates/) 目录下。等项目
> 稳定后，**公网模板库**会拆到独立仓 ——
> **`AipeHub/aipehub-templates`**。届时社区 PR 收到那里，
> 主仓只保留一个"CI 冻结子集"供解析器测试用。
>
> 拆仓之前：主仓 `templates/` 的 PR 我们仍然收，到时候和你一起整体迁过去。

AipeHub 自带一小批**标准 agent 和团队模板**在
[`templates/`](../../templates/) 下。任何人都可以通过 admin UI 一键导入，
也可以 PR 新的。

主仓目前有**两套并行的模板集**：

- [`templates/agents/`](../../templates/agents/) + [`templates/teams/`](../../templates/teams/) —— **项目原创**，专为 AipeHub 设计。整体 MIT。
- [`templates/community/`](../../templates/community/) —— **改造自第三方 prompt 库**（[`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts)(CC0) 和 [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh)(MIT)）。每个文件头部记录上游来源 + 许可；[`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md) 聚合保留完整许可证文本。两类许可证都**允许商用**。我们已经**拒绝**了上游标注 "non-commercial"、"research only"、未声明许可的来源。

本文档讲解：

1. 模板的**文件格式**（你想自己写）
2. **导入流程**端到端是什么
3. 怎么**贡献**一份新模板

如果你只是想用现成模板，简化版在 [`templates/README.md`](../../templates/README.md)。

---

## 1. 文件格式

模板是 YAML 或 JSON。导入时两种都接受；推荐 YAML，因为有注释 + 易读。

### schema 字符串

每份 manifest 第一行声明版本和形态：

```yaml
schema: aipehub.agent/v1    # 单个 agent
# 或者
schema: aipehub.team/v1     # 多个 agent 打包成团队
```

未知 schema 在解析时会被拒绝并给出明确错误。等到需要破坏性升级时，
版本号会升到 `/v2`。

### 单 agent（`aipehub.agent/v1`）

```yaml
schema: aipehub.agent/v1
agent:
  id: writer-zh                   # 必填，全工作区唯一
  displayName: 中文写作助手        # 可选，UI 上显示在 id 旁边
  capabilities: [draft]           # 必填，非空字符串数组
  kind: llm                       # 目前只有 'llm'（不写则默认 llm）
  provider: anthropic             # 'anthropic' | 'openai' | 'mock'
  model: claude-opus-4-7          # 可选，原样传给 provider
  weightDefault: 2.0              # 可选，admin 派任务到他时的默认 Task.weight
  system: |                       # 必填，系统提示词
    你是一个简洁的中文写作助手。
    - 200-400 字。
    - 不要废话。
```

### 团队（`aipehub.team/v1`）

```yaml
schema: aipehub.team/v1
team:
  name: 中文编辑团队              # 可选
  description: 写作 + 审稿        # 可选
  agents:
    - id: writer-zh
      capabilities: [draft]
      kind: llm
      provider: anthropic
      model: claude-opus-4-7
      system: |
        你写得简洁。
    - id: reviewer-zh
      capabilities: [review]
      kind: llm
      provider: anthropic
      model: claude-opus-4-7
      system: |
        你审稿并返回一条改进建议。
```

`team.agents` 里每一项的字段和单 agent schema 的 `agent` 节完全一样。
同一个团队里 id 重复会被拒绝。

### 字段级规则

| 字段 | 规则 |
|---|---|
| `id` | 必填。模式 `[a-zA-Z0-9_.:-]+`，最长 80。URL 和 JSON 安全 —— 会出现在 URL 路径和 cookie 里。 |
| `displayName` | 可选，自由文本，最长 80。 |
| `capabilities` | 必填，**非空**字符串数组。`dispatch({ strategy: { kind: 'capability', capabilities: [...] } })` 就是按这个匹配的。 |
| `kind` | 默认 `llm`。目前只支持 `llm`。 |
| `provider` | 必填。必须是 `anthropic`、`openai`、`mock` 之一。 |
| `model` | 可选。原样透传给 provider —— 你负责让字符串能被 provider 接受。 |
| `system` | 必填，非空。agent 的系统提示词。 |
| `weightDefault` | 可选。范围 [0.1, 10.0]，Hub 在任何情况下都会再做范围 clamp。 |

API key **绝不**写进模板。Key 来自三个来源（详见 [HUMAN.md "API Key 管理"](HUMAN.md#api-key-管理v21)）：

1. agent 创建表单里的「私有 API Key（可选）」（加密落盘 `<space>/secrets.enc.json`）
2. 工作区默认 key（同一个文件）
3. host 上的 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 环境变量

如果模板用 `provider: anthropic` 但**以上三个来源都没 key**，导入时
直接拒绝并给出明确提示。修复方式就是「打开 API Key 管理面板设一个
工作区 key，然后重新导入」。

---

## 2. 导入流程

端到端（admin UI 视角）：

```
templates/teams/editorial-zh.yaml          （GitHub 上的文件）
              │ 拷贝 raw URL → 粘贴
              ▼
Admin UI ─── 导入 ─── parseManifest()
              │
              ├── schema 检查              （未知则拒）
              ├── 每个 agent 字段校验      （id 模式、caps 非空…）
              ├── provider 可用性           （key 全缺则拒）
              │
              ▼
agents.json   ◀──── 每个 agent upsert 一行
              │
              ▼
LocalAgentPool.start(record)
              │
              ▼
hub.register(new LlmAgent({ ... })) ─────► transcript: participant_joined
              │
              ▼
SSE → admin UI → 「智能体列表」重渲染，online: true
```

可能失败的三个点，每个都对应 UI 上原样显示的 4xx：

- **schema / YAML 不合法** —— `400` 带 parser 报错
- **provider 不可用** —— `400 agent '<id>' uses provider '<x>' which is not available on this host`
- **id 重复** —— `409`（UI 提示改成「编辑」而不是「导入」）

如果 API 调用本身成功但**supervisor 启动失败**（比如 provider 库构造时
抛出），会得到 `200 OK` 但带 `spawnErrors: [{id, error}]` 数组。
agents.json 已经落盘，**不需要重新上传**，编辑 + 重试即可。

---

## 3. 贡献新模板

完整流程在 [`templates/CONTRIBUTING.md`](../../templates/CONTRIBUTING.md)。
TL;DR：

1. 选好文件名。单 agent → `templates/agents/<id>.yaml`。团队 →
   `templates/teams/<id>.yaml`。
2. 写 manifest，按上面的 schema。
3. **本地用真实 provider 测一下** —— 至少派一个任务过 `pnpm host` 看输出
   合不合理。
4. PR 这个文件。如果你放进了一个新子分类，把 `templates/README.md`
   的目录清单更新一下。

### 审稿人看什么

- 文件能干净解析（manifest 解析测试套件会在 CI 把所有模板都跑一遍）
- `system` prompt 和目标用户的语言一致（中文 agent 用中文 prompt；英文
  agent 用英文 prompt）
- `id` 不和已有模板冲突
- provider + model 的搭配真的能 work（CI 不能完全验证，审稿人抽检）
- capability 字符串遵守项目松散约定（动词式：`draft`、`review`、
  `translate`、…）

### 我们暂时不收什么

- 把 API key 写死在文件里的模板
- 含有"prompt 注入式"内容、目的是颠覆其他 agent 的模板
- 依赖私有 / 未发布 provider 模型的模板

---

## 4. 版本规则

模板和项目主仓同样 MIT。一旦合并：

- **编辑同一个 `id` 的 `system` prompt** 没问题 —— 之前导入旧版本的人
  本地副本不变；新 prompt 只影响未来的导入。
- **重命名**模板需要弃用期：原文件顶部加 `# DEPRECATED: see <new-id>`，
  保留 30 天，然后删除。已经导入的人不受影响（持久化记录在他们自己的
  磁盘上）。
- **破坏 manifest schema** 要升 `aipehub.agent/v2` —— parser 至少
  在下一个 minor 版本内继续接受 `/v1`。

---

## 5. 运维小贴士

- LocalAgentPool 每次 spawn 都会 log `[localpool] spawned <id>
  (provider=<x>)`，启动时 `journalctl -u aipehub | grep localpool`
  能一眼验证 agents.json 是否完整。
- `agents.json` 是纯 JSON，没人拦你在 git 里**单独 track** 你自己空间的
  这一个文件 —— 你团队精挑细选的 agent 集合可以独立于 AipeHub 仓库
  在跨机器迁移时保留下来。
- 测试 / CI 也可以**提前 seed** 一份 `agents.json` 再启动 host —— supervisor
  会像普通启动一样 replay 它。
