# 荣誉激励制度（Recognition System）

> 这套制度只发**荣誉**，不发钱、不发币、不发赏金。它的「货币」是诚实的溯源、
> 看得见的署名、和一条通向话语权的明路。
>
> Last updated: 2026-06-27

---

## 一、为什么只做荣誉

AipeHub 的长期形态是一个**受治理的、可复用组件的市场** —— 模板、适配器、
知识库连接器，做到让人敢把自己的家、家人、钱托付给它（见
[`GOVERNANCE.md`](../../GOVERNANCE.md) §「Path to a component committee」）。
一个市场要活，贡献者得有动力把好东西交出来、并维护下去。

我们权衡过四个候选，**只做前两个**：

| 候选 | 是什么 | 决定 |
|---|---|---|
| **A 引用排行榜进 FLAGSHIP** | 把「谁被改得最多」的排行榜渲染进 checked-in 文档，不依赖部署静态站就能在仓库里看见 | ✅ 做 |
| **B 量化的维护者晋升门槛** | 给 `GOVERNANCE.md` 的晋升路径加一个**轻量、可衡量**的标尺 + 一份 `MAINTAINERS.md` | ✅ 做 |
| **C 经济/奖励层** | 赏金、代币、分成 | ❌ 放弃 |
| **D 什么都不做** | 维持现状 | ❌ 放弃 |

**放弃 C 是刻意的，不是省事**。北极星说「框架不跑 LLM、状态是磁盘文件、
凭证只在本机、联邦点对点」——一套引入金钱的激励层会立刻把信任模型搅浑：
谁来托管账本？分成怎么跨 hub 结算？谁有权调价？这些都把「框架是 dumb 的、
决策权在参与者手里」往回拽。**纯荣誉制度天然 file-first、天然去中心**：
署名是模板文件里的一行 `provenance`，排行榜是一段确定性计算，晋升是一个
公开 issue 上的 lazy consensus —— 没有一处需要中心化的钱袋子。

所以这套制度的「货币」是三样东西，全都不花钱：

1. **诚实的溯源** —— `provenance.derivedFrom` 让信用回流到上游。
2. **看得见的署名** —— 排行榜 + 旗舰索引把你的名字摆在最显眼处。
3. **一条通向话语权的明路** —— 持续的好贡献换来维护者身份，而不是奖金。

---

## 二、四根支柱

这套制度由四件**已经存在并接好线**的东西组成。它们不是新机制，是把已有的
零件命名成一个系统。

### 支柱 ①：引用排行榜（署名回流）

> 「谁被改得最多」就是「谁最有用」。

每个模板的 manifest 里有 `provenance.derivedFrom` —— fork 一个模板时，你在
自己的 `derivedFrom` 里写上它的 slug。排行榜按 **in-degree**（有多少模板声明
派生自你）排名。

- **机制**：`packages/web/scripts/build-site.mjs` 的纯函数 `loadCorpus` +
  `buildModel` 从校验过的语料算 in-degree。
- **两个落点，一份计算**：
  - 静态店面（[`COMMUNITY-SITE.md`](COMMUNITY-SITE.md)）渲染它；
  - **checked-in 文档**（[`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) 的
    「引用排行榜」节）也渲染它 —— 这是**支柱 A**，由
    `pnpm build:leaderboard`（`build-leaderboard-doc.mjs`）写进一段
    `<!-- LEADERBOARD:START -->` 标记区。不部署静态站，也能在仓库里看见排名。
- **防漂移**：`packages/web/tests/build-leaderboard-doc.test.ts` 拿真实语料
  重渲染，断言 checked-in 区块逐字节一致 —— 加一条 `derivedFrom` 边却忘了
  重跑 `pnpm build:leaderboard`，CI 会**指名**报错，而不是让表悄悄烂掉。
- **排的是模板，不是人**。这是关键的诚实边界：排行榜衡量「这个组件被复用了
  多少」，不搞个人崇拜、不造可刷的人头分。

### 支柱 ②：维护者晋升路径（通向话语权）

> 好贡献的终点是**信任 + 责任**，不是奖金。

[`GOVERNANCE.md`](../../GOVERNANCE.md) 的「Becoming a maintainer」给出一条
**刻意轻量、可衡量**的标尺（这是**支柱 B**）：

- **是履历，不是计数**：大致 ~5 个非平凡的合并 PR —— 或等价物（一个你持续
  维护的旗舰模板、一个像样的适配器、持续的 review/triage），跨越约莫两个月。
  这个数字是「我们看够了你的判断力」的**地板**，永远不是用 drive-by PR 去
  刷的**指标**。
- **对设计线有感觉**：你的 PR 和 review 显示你在该让逻辑安家时伸手去找
  *participant*，而不是 Hub（见 `GOVERNANCE.md` §「The one non-negotiable」）。
- **公开提名**：一个现任维护者在公开 issue 上提名你（自荐也行），lazy
  consensus 通过、steward 确认，你的名字在同一个 PR 里落进
  [`MAINTAINERS.md`](../../MAINTAINERS.md)。

`MAINTAINERS.md` 现在只有创始维护者一人。这份文件存在的全部意义，就是让
**第二个**维护者走一条**写下来的路**加入，而不是靠拍肩膀 —— 责任线永远不该
是不成文的习惯。当贡献量大到策展成为一份常态工作时，`GOVERNANCE.md` 已经
写好了 standing up 一个 **component committee** 的预案。

### 支柱 ③：便捷化的共享（让交出来不费劲）

> 摩擦是激励的天敌。装一个模板要一次点击；交一个模板要五步。

- **一键装**：admin「工作流」面板的**模板画廊**（[`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md)）
  列出随框架附带的精选模板，一键安装复用现成的 `POST /templates/import`。
- **五步交**：社区模板提交流程在
  [`templates/community/templates/README.md`](../../templates/community/templates/README.md)
  —— 复制一个旗舰 → 改成你的 → 声明溯源 → 本地 `pnpm check:templates` → 开 PR。
- **门槛是安全与诚实，不是品味**：社区档只要求「许可清晰、能解析、零明文密钥、
  有溯源」（`GOVERNANCE.md` §「Community templates」），过了就合。我们在这一层
  策展的是*安全和诚实*，不是替你的品味背书。

便捷化本身就是激励：交出来越省事，越多人愿意把私下攒的好 workflow 公开。
而每一次公开 + 诚实溯源，都给上游喂一次支柱 ① 的引用。

### 支柱 ④：共享范本（值得被改的东西）

> 排行榜要有人引用，先得有值得引用的范本。

- **旗舰档**：[`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) 一小撮被项目
  背书、推荐给非技术用户的模板。旗舰的门槛更高（确定性 demo + 明示治理姿态 +
  有人维护，见 `GOVERNANCE.md` §「Flagship templates」）。
- **内置画廊**：10 个随框架嵌入、admin UI 一键可装的模板。
- **examples/**：45 个端到端 demo，每个都是一份可以 fork 的起点。

范本是这套循环的**种子**：没有好范本，便捷共享没东西可共享，排行榜没东西可
排名。范本写得好、治理姿态摆得明，就有人 fork、有人引用、有人在它之上长出
自己的东西。

---

## 三、四根支柱怎么互相加固

四根支柱不是四件孤立的事，是一个**自我强化的循环**：

```
   ④ 共享范本  ──fork──▶  ③ 便捷共享  ──PR + 诚实溯源──▶  ① 引用排行榜
        ▲                                                      │
        │                                                  被引用 = 看得见的署名
        │                                                      │
        └──────────  持续的好贡献  ◀──②  维护者晋升路径  ◀──────┘
                    （新范本 / 维护旧范本 / review 别人的）
```

1. 你从一个**旗舰范本（④）**出发；
2. 改成你的，走**便捷共享（③）**交回来，在 `provenance` 里**诚实署上**上游；
3. 你的诚实溯源给上游加一次**引用（①）**，上游爬上排行榜 —— 信用回流；
4. 你自己的模板也开始被别人 fork、被引用，你的名字摆上排行榜和旗舰索引；
5. 持续的好贡献（新范本、维护旧范本、review 别人的）让你走上**维护者晋升
   路径（②）**，拿到信任和话语权 —— 而你作为维护者背书新的旗舰范本（④），
   循环再起一轮。

**没有一步需要发钱**。驱动整个循环的是「我的东西有用、有人在用、署名摆在
明处、我说话开始算数」—— 纯荣誉，刚好够。

---

## 四、不做什么（诚实边界）

- **不发钱 / 不发币 / 不发赏金**（候选 C 已放弃）。
- **排行榜不排人头**：它排模板的被复用度，不造可刷的个人积分。
- **晋升不是自动的**：~5 个 PR 是地板不是开关，最终是公开 issue 上的人判断 +
  lazy consensus，不是计数器到点解锁。
- **不向前兼容地发明新机制**：这套制度的四根支柱全是**已存在并接好线**的
  东西，本文是把它们命名成一个系统，不是新增子系统。

---

## 五、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 旗舰索引 + 引用排行榜（支柱 ①④） | [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) |
| 决策流程 + 维护者晋升路径（支柱 ②） | [`GOVERNANCE.md`](../../GOVERNANCE.md) |
| 现任维护者名册（支柱 ②） | [`MAINTAINERS.md`](../../MAINTAINERS.md) |
| 模板画廊一键安装（支柱 ③） | [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md) |
| 社区模板提交流程（支柱 ③） | [`templates/community/templates/README.md`](../../templates/community/templates/README.md) |
| 零算力社区站（排行榜的另一个落点） | [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md) |
| 社区客厅（Discussions） | [`COMMUNITY-DISCUSSIONS.md`](COMMUNITY-DISCUSSIONS.md) |
