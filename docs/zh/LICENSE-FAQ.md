# License FAQ

> **AipeHub 整体使用 [MIT License](../LICENSE)**。这一页用 FAQ 形式回答
> "我能不能 / 我必须做 / 我注意什么" 几个常见问题。不是法律意见，
> 真有公司级合规要走，请咨询自己的法务。

---

## 1. 我能不能把 AipeHub 嵌进我的闭源产品 / SaaS / 内部工具？

**能。** MIT 是最宽松的几个 OSS 协议之一。允许：

- ✅ 商业使用，包括把整个 AipeHub 重新打包卖钱
- ✅ 改源码、改名（虽然改名后请说明"基于 AipeHub"）
- ✅ 闭源派生 — 你的修改**不需要**开源回来
- ✅ 把 `@aipehub/core` 当 npm dep 拉进闭源 SaaS

**唯一硬要求**：保留 LICENSE 文件 + copyright notice（在你的产品的
NOTICE / Third-Party-Licenses 之类的页面里列出 AipeHub 即可）。

---

## 2. 我修改了源码，必须把改动开源回来吗？

**不必须。** MIT 不是 copyleft。你可以：

- 自留修改不公开
- 把修改作为商业产品的一部分
- 不向上游 PR 也完全可以

但我们当然欢迎你 PR 改进回上游 —— 项目越好，下次升级你越省事。
PR 流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## 3. `templates/community/` 里的第三方 prompt 模板我商用要注意什么？

`templates/community/` 收录两类来源：

| 来源 | 许可 | 商用 | 注意 |
|---|---|---|---|
| [`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) | **CC0 1.0**（公有领域） | ✅ 任意商用 | 法律上**完全无需署名**；我们保留来源行只是出于尊重 |
| [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) | **MIT** | ✅ 任意商用 | **必须保留** copyright + license notice |

具体怎么保留？我们已经在 `templates/community/` 做了三层保留：

1. 每个 yaml 文件**头部 4 行注释**：`# Source` / `# Upstream` /
   `# License` / `# Adapted`
2. 集中文件 [`templates/community/LICENSE-NOTICES.md`](../templates/community/LICENSE-NOTICES.md)
   保留 MIT 全文 + CC0 摘要 + 来源仓 URL
3. 本目录 [`README.md`](../templates/community/README.md)
   说明改造原则和许可矩阵

只要你**保留这三层不动**地把 `templates/community/` 整个分发出去
（git fork / 云端 raw URL / 内部 CDN 都行），就完全合规。

> 关于"我把模板内容粘贴进 admin UI 落到我的 `secrets.enc.json` /
> `agents.json` 里 — 这算分发吗？" — **不算分发**。你只是在自己的
> deployment 里使用，不向第三方传播。无需任何 attribution 行动。

---

## 4. 我能不能改 LICENSE 重新打包成"我们的"产品发布？

可以**改产品名 + 加你自己的 license 行**，但**不能删 MIT 原文**：

- ✅ 你的派生品可以叫 `BobHub`，可以是 Apache-2.0 / proprietary / 你自己写一个
- ✅ 你可以在自己的 LICENSE 文件里写自己的版权
- ⚠️ 但你**必须在某个地方**（比如 NOTICE.md 或 THIRD-PARTY.md）
  保留 AipeHub 的 MIT 原文 + 上游 copyright 行
- ❌ **不能**说"AipeHub 是我们的原创" — 那是欺诈，跟 license 无关

---

## 5. 我导入了一个公司同事用 GPT 写的私有 prompt 当 agent，这有 license 风险吗？

**没有 AipeHub 这一侧的风险。** 你写的 / 公司内部的 prompt 是你们
公司自己的资产，AipeHub 只是个运行容器。但你应该确认：

- 那位同事用的 GPT 输出是否符合 OpenAI 的服务条款（OpenAI 历史上
  对模型输出的"所有权"政策松紧不一，问问法务）
- 如果同事在 prompt 里**引用了**别人的代码 / 文章片段，该引用本身
  的 license 是否允许

这两条都不是 AipeHub 项目要管的事 —— MIT 给的是软件本身的许可，
不是你用它生成的内容的许可。

---

## 6. 我把 AipeHub 嵌进客户的内网部署，要给客户什么 license 文件？

最低限度：

- AipeHub 仓库根目录的 `LICENSE` 文件
- 如果你用了 `templates/community/`：也把 `LICENSE-NOTICES.md` 一起带上
- 如果你嵌的是 `@aipehub/core` npm 包：npm 安装时该包自带 license，
  下游再分发时只要保留 `node_modules/@aipehub/*/LICENSE` 不删就行

一个常见做法是产品里有一个 "Third-Party Licenses" 页面，
列出所有上游 OSS 包的 license 文本。AipeHub 的 MIT 加进去即可。

---

## 7. AipeHub 用到的运行时依赖有 GPL/AGPL 这种 copyleft 病毒吗？

目前没有。主要依赖：

| 依赖 | License |
|---|---|
| `ws` (WebSocket) | MIT |
| `yaml` | ISC |
| `better-sqlite3` (可选) | MIT |
| `@anthropic-ai/sdk` (可选 peer dep) | MIT |
| `openai` (可选 peer dep) | Apache-2.0 |
| `vitest` (dev only) | MIT |
| `tsx` (dev only) | MIT |

全部是宽松许可。如果未来加入 GPL/AGPL 依赖会先开 issue 讨论，
我们的偏向是**避免引入** copyleft 依赖以保持下游的灵活度。

---

## 8. AipeHub 的 wire protocol 算不算 license 的一部分？

不算。`docs/PROTOCOL.md` 描述的 JSON 帧格式是**事实标准**，任何人
都可以实现一个自己的 hub server 或自己的 SDK，**不需要任何许可**。
我们鼓励语言生态扩展（Go / Rust / 浏览器 SDK 等），各自挑各自的
license 即可。

---

## 9. 我看到 `SECURITY.md` 里的邮箱是 placeholder，怎么发 vuln 报告？

那个文件**就是给将来公开发布前替换用的**。在那一刻之前，请通过
项目仓库的私有渠道（GitHub Security Advisory 私下提交）联系。
直接在 public issue 里发漏洞细节是**不可以**的 — 哪怕 license 允许。

---

## 10. 我能否在公司内部 fork 一份 AipeHub 但不开源 fork 内容？

**完全可以**。MIT 不传染。你可以：

- fork 进公司私有 Git → 任意修改 → 内网部署
- 把 fork 改名后给客户私有部署
- 把 fork 编译产物作为闭源 binary 卖钱

只要**最终交付物里某处保留 AipeHub 原始 MIT license**（一般放在
"开源声明"页面里），就齐活了。

---

## 简短总结

> "**用就完了**" —— 99% 的常规用法不需要任何额外动作，保留 LICENSE
> 文件 + copyright 行就够。`templates/community/` 多一步：保留
> `LICENSE-NOTICES.md` 文件。其他细节都是"你想做哪种特殊事"才会触发的边界。

> 仍有疑问？开 GitHub Discussion，我们尽量回；涉及具体合规的找你公司法务。
