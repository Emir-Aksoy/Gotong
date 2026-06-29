# butler-vector-recall — 给个人管家做语义召回

个人管家的 `recall`(回忆)默认走 **lexical 召回**(C-M2 `lexicalRetriever`):中文按
CJK 二元组、英文按 token 算**字符重叠**。它能在「卖奶茶的店」里找到「奶茶店」(共享字符),
但它仍是**字面**的——查询「饮料」**找不到**「奶茶 / 咖啡」,因为它们和「饮料」一个字都不共享。

**语义召回**补这个口子:把文本变成向量,按**含义**而不是字符匹配。这个 example 演示两条路,
**都不让框架算向量**——模型 / 向量库是**注入**的(北极星:embedding 不进框架)。

```
pnpm demo:butler-vector-recall
```

确定性、无网络、无模型下载、无向量服务:一个**极小的本地 embedder**(关键词→概念轴)替身让语义
精确可断言,毫秒级跑完,7 条断言全过。

---

## 两条路

| | `embeddingRetriever`(本地 embed) | `chromaRetriever`(chroma-mcp) |
|---|---|---|
| 谁排序 | 框架:拉一段近窗 → 调注入的 embedder → 进程内算 cosine | 向量库:服务端 embed + ANN,框架只转发查询 |
| 算向量的地方 | 注入的 `Embedder`(本地模型 / API),框架只做 cosine | chroma-mcp 服务端,框架**完全不碰向量** |
| 适合 | 已蒸馏、预算受限的管家(近窗即全量) | 无界语料 |
| 每次召回成本 | N 次 embed(query + 候选,**一次批量调用**) | 一次 MCP 工具调用 |
| 接缝 | 同一个 `MemoryRetriever` 接口——recall 可插拔,**冻结块不可插拔** | 同上 |

两条路都是同一个 `MemoryRetriever` 接缝(只在 `recall` 上,**冻结块字节稳定不受影响**——
相关性是查询相关的,永不进 prompt-cache 前缀)。

### Scene 1 — `embeddingRetriever`

```ts
import { embeddingRetriever, type Embedder } from '@aipehub/personal-memory'

// 注入你的文本→向量函数(本地 sentence-transformers 子进程 / ONNX / embedding API)。
// 批量:retriever 把 query + 所有候选放一次调用里,所以托管 embedding API 每次召回只命中一次。
const embed: Embedder = async (texts) => myModel.embedBatch(texts)

const retriever = embeddingRetriever({ memory, embed })
// new MemoryToolset({ memory, retriever })  ——  recall 现在走语义
```

查询「饮料」→ 命中 `奶茶`/`咖啡`(cosine 同向);正交的「篮球」被丢掉。同一个查询给
`lexicalRetriever` 返回**空**——这就是 C 补的口子。

### Scene 2 — `chromaRetriever`(chroma-mcp 接缝)

真向量库**自己持有索引、服务端做 embed + ANN**。所以你直接实现 `MemoryRetriever.retrieve`
打到库上——**没有进程内 cosine、没有近窗、不 import 任何向量库**。库经 `chroma-mcp`
(一个 MCP server)够到,和 `examples/rag-mcp` 一模一样。

```ts
import { chromaRetriever, type ChromaQuery } from './chroma-retriever.js'

// 生产里这个注入函数转发到 chroma-mcp 工具调用(见 chroma-retriever.ts 顶部
// PRODUCTION_WIRING_DOC);这里注入是为了 hermetic——真 chroma 要起服务。
const query: ChromaQuery = async ({ text, k, kinds }) => callChromaMcp(text, k, kinds)
const retriever = chromaRetriever({ query })
```

写入仍然走 `MemoryHandle`;一个小钩子把每次 `remember` 镜像进 chroma(upsert)保持索引同步。
**磁盘上的真相源永远是 handle**,chroma 是可重建的派生索引——和 RAG 同一个北极星立场:
框架不存向量。

### Scene 3 — parity

无查询的 `recall` 仍然是 importance-then-recency(和别的 retriever 完全一致),
所以换上语义 retriever 对「给我最近的」这种无查询列举零行为变化。

---

## 框架不算向量

`embeddingRetriever` 只做 cosine(几行无依赖的数学)和排序;向量从注入的 `Embedder` 来。
`chromaRetriever` 连 cosine 都不做——库来排。两条路框架都不 import embedding 库、不在磁盘存
向量。要语义召回,你接一个本地模型或一个 chroma-mcp server——**框架提供接缝,不提供向量**。

相关源码:
- `packages/personal-memory/src/embedding-retriever.ts` —— `embeddingRetriever` + `cosineSimilarity` + `Embedder` 接缝
- `packages/personal-memory/src/relevance.ts` —— C-M1 中文 lexical scorer(对照)
- `examples/rag-mcp/` —— chroma-mcp 起服务的完整配置(RAG)
- `docs/zh/MEMORY-ADVANCED-FINAL.md` —— C/F/E/G/D 五个记忆增强方向收口
