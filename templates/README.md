# AipeHub 模板（初始参考集）

> ⚠️ **这里是初始参考集**，跟主代码同仓便于早期迭代。
> **正式公网模板库**会迁到独立仓 **`AipeHub/aipehub-templates`**。
> 迁仓后社区 PR 都收去那里，主仓的这个目录只保留作为参考 / CI 解析检查的最小集合。
>
> 现阶段（迁仓未完成）：欢迎在这里看到的模板继续用；PR 也欢迎，但要做好"将来会和你一起搬到独立仓"的心理准备。

这里收集**标准 agent 和团队模板**，按 admin → 智能体 → 导入 即可使用。

## 怎么用

1. 进入对应文件夹，选一个 `.yaml` 文件
2. 点击 GitHub 右上的 **Raw** 按钮（或直接 [view raw]），全选 + 复制
3. 回到你的 AipeHub admin 控制台，点 **导入**，把内容粘贴进去
4. 点 **导入** 按钮 → agent 立刻出现在你的"智能体"列表里

> 也可以**下载文件**到本地，然后用 **上传文件** 按钮。两种方式效果一样。

## 目录

```
agents/                    单个智能体模板（项目原创）
  writer-zh.yaml           中文写作（draft）
  reviewer-zh.yaml         中文审稿（review）
  summarizer-zh.yaml       中文长文摘要（summarize）
  translator-zh-en.yaml    中英互译（translate）
  code-reviewer.yaml       代码审查（code-review）

teams/                     多智能体团队模板（项目原创，一次导入 N 个）
  editorial-zh.yaml        中文编辑流水线（writer + reviewer）
  translator-team.yaml     翻译团队（translate + proofread）
  code-review-team.yaml    代码审查团队（review + tests + docs）

community/                 改造自第三方主流 prompt 库（CC0 / MIT）
  README.md                来源、许可、改造原则
  LICENSE-NOTICES.md       聚合的第三方许可证全文
  agents/                  11 个通用单 agent（终端模拟、翻译润色、
                           故事、数学、技术写作、统计、prompt 工程等）
  teams/                   组合团队（如 tech-content-team）
```

> 📥 **`community/` 是社区改造集**：CC0 / MIT 授权可商用，每个文件头部
> 注明上游来源（[awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts) /
> [PlexPt 中文版](https://github.com/PlexPt/awesome-chatgpt-prompts-zh)）。
> 详情见 [`community/README.md`](./community/README.md)。

## 需要先准备什么

每个模板都用到 **LLM provider**，host 启动时要在环境变量里配好对应的 API key：

| Provider 字段 | 需要的环境变量 |
|---|---|
| `provider: anthropic` | `ANTHROPIC_API_KEY` |
| `provider: openai` | `OPENAI_API_KEY` |
| `provider: mock` | 不需要 key（仅用于试验流程） |

没配 key 的 provider 在 admin 导入时会被拒绝，并提示原因。如果你想换 provider，**直接打开 .yaml 把 `provider` 那一行改掉**即可（也可能要改 `model`）。

## 文件格式

[`docs/TEMPLATES.md`](../docs/TEMPLATES.md) 有完整说明。简化版：

**单 agent（`schema: aipehub.agent/v1`）**

```yaml
schema: aipehub.agent/v1
agent:
  id: writer-zh                   # 必填，全空间唯一
  displayName: 中文写作助手        # 可选
  capabilities: [draft]           # 必填，admin 用 "按能力" 派发就靠这个
  kind: llm                       # 当前只支持 llm
  provider: anthropic             # anthropic | openai | mock
  model: claude-opus-4-7          # 可选
  weightDefault: 2.0              # 可选，admin 派发到他时的默认权重
  system: |                       # 必填，系统提示词
    你是一个简洁的中文写作助手...
```

**团队（`schema: aipehub.team/v1`）**

```yaml
schema: aipehub.team/v1
team:
  name: 中文编辑团队              # 可选
  description: 写作 + 审稿        # 可选
  agents:
    - { id: writer-zh, ... }      # 同上面单 agent 的 agent 字段
    - { id: reviewer-zh, ... }
```

## 贡献新模板

欢迎 PR 新模板，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

MIT — 模板内容随项目主仓 license。
