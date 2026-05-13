# AipeHub 中文文档

> 这里是 AipeHub 主要文档的中文镜像。**最新内容以
> [英文版](../)为准**——当中英文出现不一致时，以英文版为准，并欢迎 PR
> 同步中文版。

## 文档导航

| 你想知道… | 看这一篇 |
|---|---|
| 🧭 项目整体概览（5 分钟读懂） | [`OVERVIEW.md`](OVERVIEW.md) |
| 🧑 加入一个 room（admin 或 worker 视角） | [`HUMAN.md`](HUMAN.md) |
| 🧩 不写代码导入 / 分享 LLM 智能体模板 | [`TEMPLATES.md`](TEMPLATES.md) |
| 🧪 **真机测试指南**（本机 / 局域网 / 公网 VPS） | [`REAL-WORLD-TESTING.md`](REAL-WORLD-TESTING.md) |
| 🤖 自己写 agent 接入 | [`../AGENT.md`](../AGENT.md)（英文，待翻译） |
| 🔧 在自己机器 / 服务器部署 | [`../DEPLOY.md`](../DEPLOY.md)（英文，待翻译） |
| 🪢 多团队 hub 联合 | [`../FEDERATION.md`](../FEDERATION.md)（英文，待翻译） |
| ⚖️ MIT 协议 / 商用 / 模板 license | [`../LICENSE-FAQ.md`](../LICENSE-FAQ.md)（英文，待翻译） |
| 🧠 整体架构 + 设计取舍 | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（英文） |
| 📡 Wire 协议（写自己的语言 SDK） | [`../PROTOCOL.md`](../PROTOCOL.md)（英文） |

## 翻译状态

| 文档 | 中文版状态 |
|---|---|
| OVERVIEW | ✅ 完整翻译 |
| HUMAN | ✅ 完整翻译（原本就部分中文） |
| TEMPLATES | ✅ 完整翻译 |
| REAL-WORLD-TESTING | ✅ 中文原创（暂无英文版，欢迎 PR 翻译） |
| AGENT | ⏳ 待翻译 |
| DEPLOY | ⏳ 待翻译 |
| FEDERATION | ⏳ 待翻译 |
| LICENSE-FAQ | ⏳ 待翻译 |
| ARCHITECTURE | ⏸️ 内部架构文档，优先级低 |
| PROTOCOL | ⏸️ Wire 协议，原文够精确 |

## 想贡献翻译？

非常欢迎。对照英文版翻译时请注意：

1. **保留专业术语原文**：`Hub` / `Participant` / `Task` / `capability` /
   `transcript` / `dispatch` 这些不翻译（代码里就这么写的）。
2. **保留所有代码块和命令原样**。
3. **保留所有链接路径**，相对路径用 `../FOO.md` 指向英文版即可。
4. **加文件头注明同步版本**：`> 同步自英文版 docs/FOO.md @ <commit-sha 或日期>`，
   方便下次同步知道差量。

PR 流程见仓根的 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
