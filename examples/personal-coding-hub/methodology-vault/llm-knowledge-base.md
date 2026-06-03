# LLM 知识库 —— 把 LLM 当编译器

> 源:[[raw/sources]] · 上级:[[index]]

## 模式:raw → 编译 wiki

Karpathy 描述的个人知识 wiki 工作流,有**两层**:

```
   raw/                          编译 wiki
   ├─ 讲座转录.md      ──LLM──▶   ├─ 概念A.md  (摘要 + [[backlink]])
   ├─ 论文.pdf         编译       ├─ 概念B.md  (摘要 + [[backlink]])
   └─ 剪藏文章.md                 └─ index.md  (互链导航)
```

- **raw 层**:原始源材料(转录、PDF、剪藏)。只进不改。
- **编译层**:LLM **当编译器**,把 raw 写成摘要、建 backlink、归类,生成互相链接的
  markdown 笔记。**「wiki 的数据几乎全由 agent 写和维护」**。

## Obsidian 当 IDE / 前端

markdown-native 是关键:Obsidian 提供 backlink、图谱、双链浏览,raw 与编译层都能看。
markdown 既是人读的,也是 LLM 最顺的「lingua franca」。

## Ask-your-wiki(不是传统 RAG)

到了一定规模(Karpathy 提到约百篇文章、几十万字),wiki 变成一个**问答引擎**:
不是切块向量召回,而是 **agent「研究自己的 wiki」、跟着 `[[链接]]` 走、综合出答案**,
再把答案当**新笔记归档**回去。知识因此**复利增长**。

## 健康检查

- 定期 lint 不一致(死链、矛盾、重复)。
- 这本身可以是一个 agent 任务([[agentic-engineering]] 的小步活)。

## 这个 vault 就是一个实例

你正在读的方法论 vault,就是这个模式的小样:[[raw/sources]] 是 raw 指针,其余编译笔记
是蒸馏,[[index]] 是互链首页。**想扩**:把新材料丢进 `raw/`,让编码 agent 编译成新笔记。

## 落到本 hub

- mentor 用 `obsidian__search` 查这个方法论 wiki,正是「ask-your-wiki」。
- `PROGRESS.md` 是同一模式的**极小实例**:append-only、每个 agent 读了再写,知识(进度)
  在交接中累积。细节:[[coding-with-agents]]。
