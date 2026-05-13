# 贡献新模板

> ⚠️ 正式公网模板库即将迁到独立仓 `AipeHub/aipehub-templates`。
> 在迁仓完成前，主仓这个目录仍接受 PR（迁仓时会一起搬过去）。
> 迁仓完成后此 README 会更新指引到新仓地址。

欢迎给 AipeHub 模板库提交新 agent / team。流程很简单。

## 一、决定放在哪里

- **单个智能体** → `templates/agents/<short-id>.yaml`
- **多智能体团队**（同一份文件创建 ≥2 个 agent） → `templates/teams/<short-id>.yaml`

文件名规则：

- 全小写，单词用 `-` 分隔
- 包含主要 capability（如 `translator-zh-en`）
- 中文/语种相关的加语言后缀（`-zh`、`-en`、`-zh-en`）

## 二、按 schema 写

参考 [README.md](./README.md) 顶部的 schema 速查。一个最小的合规 agent：

```yaml
schema: aipehub.agent/v1
agent:
  id: my-new-agent
  capabilities: [my-skill]
  kind: llm
  provider: anthropic
  system: |
    你是一个...
```

## 三、本地测一下

```bash
# 在你的开发空间里启动 host
pnpm host

# 浏览器开 /admin，导入你的新模板
# 派一个任务给它，看输出是否符合预期
```

通过的标准（reviewer 会用这套检查）：

1. ✅ 在 anthropic 或 openai 的实际 API 上至少**跑过一次任务**
2. ✅ 在 mock provider 下也能加载（即不依赖 provider 特有功能）
3. ✅ system prompt 用中文写**针对中文用户**，用英文写**针对英文/混合用户**——别混
4. ✅ 文件顶部有一行 `# <名称> — <一句话用途>` 注释
5. ✅ 文件无 BOM、行尾 LF（不要 CRLF）
6. ✅ ID 在现有 agents/ 和 teams/ 里**唯一**

## 四、写好 system prompt 的 5 条经验

1. **角色定义放第一行**：`你是一个 X`，让模型立刻 anchor
2. **规则用编号列表**：模型对 `1. 2. 3.` 的遵循比对自然语言段落好
3. **指定输出格式**：明示 JSON / markdown / 纯文本
4. **禁忌也写明**：例如 "不要写客套话、不要加 emoji"
5. **<400 字**：太长的 system 会挤压上下文，也会让模型抓不到重点

## 五、提交

1. fork 主仓
2. 在 `templates/agents/` 或 `templates/teams/` 加你的 `.yaml`
3. 必要时更新 `templates/README.md` 的目录清单
4. PR title 用 `templates: add <short-id>`
5. PR body 写：
   - 这个模板解决什么问题
   - 跑了哪些测试（贴上 1-2 段实际输出截图）
   - provider / model 选这个的原因

reviewer 会在 3-5 个工作日内回复。

## 六、移除 / 废弃模板

如果一个模板因为 provider 变更、prompt 过时等不再适用：

- 提 PR 改文件顶部加 `# DEPRECATED: <原因>`，保留 30 天
- 30 天后再提 PR 删除

直接删除会让已经用过它的用户没了 reference，所以走两步。
