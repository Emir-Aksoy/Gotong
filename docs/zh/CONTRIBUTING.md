# 为 AipeHub 做贡献

<!-- doc-version: 1.0 -->
> **文档版本 1.0** · 中文译本 · 最后更新 2026-06-27 · 权威源：[English](../../CONTRIBUTING.md)。如译文与英文版冲突，以英文版为准。

感谢你考虑参与贡献。AipeHub 还处于早期阶段，我们很乐意接受补丁、缺陷报告、设计反馈和文档改进。

## 基本规矩

- **友善。** 对待 issue 跟踪器 / PR 里的任何人，请用你希望一位资深工程师在他状态糟糕的一天里对待你的方式。
- **小 PR。** 相互独立的改动比超大 PR 落地更快。如果一个特性能干净地拆开，请分别提交各部分。
- **Hub 故意保持「笨」。** AipeHub 的整个设计理念是：Hub 只做路由 / 持久化，**不**拥有 agent 逻辑。把 LLM 调用、agent 循环或业务规则塞进 Hub 的补丁会被引导改向。
- **Wire 协议是版本化的。** 任何改变协议层消息形状的东西，都要走 `docs/PROTOCOL.md` 并伴随一次协议版本号提升。纯本地的改动则不必。
- **不要有意料之外的依赖。** 增加一个运行时依赖（尤其是原生依赖）是一个真实的决定——请先开一个 issue。

## 工作流

```bash
# 先在 GitHub 上 fork，然后：
git clone git@github.com:<you>/AipeHub.git
cd AipeHub
pnpm install
pnpm build

# 进行修改…

pnpm -r typecheck      # 全部 19+ 个包类型检查通过
pnpm -r test           # 跨包运行 vitest
pnpm test:python       # python-sdk pytest
```

约定：

- TypeScript 严格模式，ESM，相对导入加 `.js` 扩展名（TypeScript 的 "node16/nodenext" 解析方式要求如此）。
- 测试与其覆盖的代码放在一起（`packages/*/tests/`）。
- 目前还没有工具强制 lint；请匹配现有文件的风格。
- Commit message：用祈使语气（"add foo"，而非 "added foo"）。非平凡的 commit 欢迎写一段说明。

## 仓库布局

```
packages/
  core/           Hub + 注册表 + 调度器 + transcript + Space
  protocol/       Wire 协议类型（零运行时）
  transport-ws/   Hub 侧 WebSocket 适配器
  sdk-node/       远程 agent 的 Node SDK（connect + AgentParticipant）
  web/            可嵌入的 web 服务器 + 静态 SPA
  host/           生产二进制（env 驱动，无 demo 状态）
  llm/            LlmAgent 基类 + LlmProvider 接口
  llm-anthropic/  Anthropic provider
  llm-openai/     OpenAI provider
python-sdk/       Python SDK（sdk-node 的镜像）
examples/         可运行的 demo
docs/             长篇架构 / 协议 / 部署文档
```

## 可以着手的方向

如果你想要一个低上下文的入门任务，找标了 `good-first-issue` 标签的 issue。一些一直欢迎的主题：

- **文档**：错别字、更清晰的示例、翻译（项目有讲中文的维护者；纯英文文档目前仍较薄）。
- **测试覆盖**：尤其是调度器的边界情况和 Space 的磁盘迁移路径。
- **更多 LLM provider**：照着 `packages/llm-anthropic` 的形状抄。
- **admin UI 的无障碍 / 国际化**：纯 JS，无框架，改动面小。

## 贡献一个模板

你不必写 TypeScript 也能贡献。AipeHub 附带**模板**——自包含的 YAML，别人导入即可得到一个能跑的 hub（agents + 工作流 + 知识库引用，**永不**含密钥或知识内容）。

- 单个改写过的 prompt → [`templates/community/`](../../templates/community/)。
- 一整个可导入的 hub（多 agent + 工作流）→ [`templates/community/templates/`](../../templates/community/templates/)——那里的 README 讲了 5 步流程：复制一个旗舰示例、改写它、声明溯源（`derivedFrom`）、用 `pnpm check:templates` 在本地校验、开 PR。

被**合并为社区模板**的门槛（license 清楚、能解析、无字面密钥）低于被**作为旗舰发布**的门槛（确定性 demo、声明治理立场、有人维护）。见 [`GOVERNANCE.md`](GOVERNANCE.md)。

## 报告缺陷

一份有用的缺陷报告包含：

- 你做了什么（完整命令行、完整环境变量）
- 你期待什么
- 实际发生了什么（如有，完整的错误输出；如果缺陷在路由 / 持久化里，附 `transcript.jsonl` 片段）
- 版本：`node --version`、`pnpm --version`、操作系统

对于网络形态的缺陷（worker 掉线、agent 没被路由到），请附上 `/api/state` 快照——它是「hub 认为正在发生什么」的权威说法。

## 安全

安全问题**不**应进入公开的 issue 跟踪器。见 [`SECURITY.md`](SECURITY.md)。

## License

贡献即表示你同意你的工作以本项目使用的 [MIT license](../../LICENSE) 提供。无 CLA。
