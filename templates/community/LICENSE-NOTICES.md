# 第三方许可声明（Third-Party License Notices）

本目录（`templates/community/`）收录的 agent / team 模板**改造自下列第三方 prompt 库**。每个改造文件头部的 `# Source` / `# License` 注释指向其原始来源；下面是各来源完整的许可声明，按要求集中保留。

下游再分发本目录内容时（无论是 fork 主仓、迁到独立模板仓 `AipeHub/aipehub-templates`、还是放到云端 CDN 给用户直接下载）**请保留本文件**。

---

## 1. f/awesome-chatgpt-prompts

- **仓库**：<https://github.com/f/awesome-chatgpt-prompts>
- **作者**：Fatih Kadir Akın 及社区贡献者
- **代码许可**：MIT（仓库本身）
- **Prompt 内容许可**：**CC0 1.0 Universal**（公有领域，[Creative Commons Zero v1.0](https://creativecommons.org/publicdomain/zero/1.0/)）

> "Prompt content and data" 在该仓库内被作者明确 **dedicated to the public domain under CC0 1.0**。这意味着：
>
> - ✅ **可商用** —— 包括把改造结果集成进 AipeHub 这种 MIT 软件并商业部署
> - ✅ **可任意修改** —— 改 prompt 文字、改格式、合并、拆分都行
> - ✅ **无需署名** —— CC0 法律上 *waive 了所有权利*；我们的来源标注是出于**礼貌**，不是义务
> - ✅ **可再许可** —— 改造后的产物可以放到任何许可下（我们保持 MIT + CC0 标注）

**适用于本目录中以下文件**：

```
agents/linux-terminal.yaml
agents/javascript-console.yaml
agents/sql-terminal.yaml
agents/english-improver.yaml
agents/storyteller.yaml
agents/math-tutor.yaml
agents/tech-writer.yaml
agents/career-counselor.yaml
agents/statistician.yaml
agents/prompt-engineer.yaml
teams/tech-content-team.yaml   (基于上述文件组合)
```

### CC0 1.0 摘要（非法律建议）

> "The person who associated a work with this deed has dedicated the work to the public domain by waiving all of his or her rights to the work worldwide under copyright law, including all related and neighboring rights, to the extent allowed by law. You can copy, modify, distribute and perform the work, even for commercial purposes, all without asking permission."

完整全文见 <https://creativecommons.org/publicdomain/zero/1.0/legalcode>。

---

## 2. PlexPt/awesome-chatgpt-prompts-zh

- **仓库**：<https://github.com/PlexPt/awesome-chatgpt-prompts-zh>
- **作者**：PlexPt 及社区贡献者
- **许可**：**MIT License**

```
MIT License

Copyright (c) 2023 PlexPt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING OUT OF
OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF THE SOFTWARE IN THE
SOFTWARE.
```

**适用于本目录中以下文件**：

```
agents/interviewer-zh.yaml
```

### 关于 MIT 与本目录的关系

MIT 允许商用 + 修改，但**要求保留 copyright notice + license 文本**。我们的做法：

- 改造文件**头部注释**保留 `# Source` + `# License: MIT` + `# Copyright (c) 2023 PlexPt`
- **本文件**集中保留 MIT 完整全文
- AipeHub 主项目本身也是 MIT，许可证兼容

---

## 3. 关于 AipeHub 自身（包括本目录的改造劳动）

AipeHub 主仓和本目录中**我们的改造劳动**（重组结构、AipeHub-specific 字段、capabilities 设计、模型选择、weightDefault、目录组织）按 **MIT License** 发布。完整文本见仓根 [`LICENSE`](../../LICENSE)。

## 4. 不收什么

明确**拒收**的许可类型（避免下游商用陷阱）：

- ❌ CC-BY-NC（非商用）
- ❌ CC-BY-ND（禁止改）
- ❌ "Research use only" / "Personal use only"
- ❌ 未声明许可的 prompt 库（默认 *all rights reserved*，社区习惯但法律上没保护）
- ❌ "Open source" 但实际是 BUSL / Commons Clause 这种伪开源
- ❌ 含有色情、暴力、prompt injection 攻击模板的 prompt

PR 含上述任一类来源的会被关闭并说明理由。

---

最后更新：2026-05-12
