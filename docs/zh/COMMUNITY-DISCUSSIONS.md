# GitHub Discussions — 社区「客厅」（零算力，一次性开启）

> 上线前清单 item 8。一句话:**Issues 是工单台,Discussions 是客厅**——问问题、
> 晒成果、提想法都在这里,GitHub 免费托管,跟落地页/排行榜一样**零算力**。

---

## 一、为什么是 Discussions(而不是又一个服务)

跟 [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md) 同一条立场:一个 file-first、hub 自己不
跑大模型的项目,**社区基础设施也不该需要服务器**。GitHub Discussions 把「客厅」整个
托管了——线程、分类、@提及、Markdown、搜索,全是 GitHub 的事,我们一行后端都不写。

- **Issues** = 「有个东西坏了 / 缺了」的工单台(可关闭、可指派、有状态)。
- **Discussions** = 「我想问 / 我想晒 / 我想聊」的客厅(开放式、可投票、可标记最佳答案)。

这两个入口已经在 [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)
里分流好了——开 issue 时,「💬 Question or discussion」那条 contact link 就把人引到
Discussions。**所以开启 Discussions 之前,那条链接是个 404**;开启之后它立刻活。

---

## 二、⚠️ 唯一的人工动作:开启 Discussions(Claude 帮不了)

**开启 Discussions 是一个仓库设置开关,不是文件,Claude / CI 都翻不动它。** 这一步
必须仓库 owner 在网页上点:

1. 打开 `https://github.com/Emir-Aksoy/AipeHub/settings`(仓库 **Settings**)。
2. 往下滚到 **Features** 区,勾上 **Discussions**。
3. GitHub 会**自动建好默认分类**:Announcements / General / **Ideas** / Polls /
   **Q&A** / **Show and tell**。本仓库随附的三个表单模板(见 §四)就对着加粗的那三个,
   开启的**那一刻**就自动挂上,无需再建分类。

> 这就是这一项「脚手架已就绪、就差一个开关」的意思:模板文件、欢迎帖草稿、issue
> 分流链接、文档全在仓库里等着;你点一下 Features → Discussions,客厅就开门了。

开启后建议再做两件事(都是网页上点几下,可选但推荐):

- **置顶欢迎帖**:把 §五 的草稿贴成 General 分类的一篇 Discussion,点「Pin」。
- **(可选)加一个「模板 / Templates」自定义分类**:如果模板分享多到 Show and tell
  装不下,再单建一个;但一开始用默认的 Show and tell 就够,别过早加。

---

## 三、分类地图(随框架就绪的那三个)

| 分类 | slug | 表单 | 用来干嘛 |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../../.github/DISCUSSION_TEMPLATE/q-a.yml) | 求助、提问。可标记「最佳答案」。 |
| **Ideas** | `ideas` | [`ideas.yml`](../../.github/DISCUSSION_TEMPLATE/ideas.yml) | 提功能 / 方向。表单引着对齐北极星(hub 不跑大模型 / 文件优先 / 联邦点对点)。 |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | 晒你做的 hub / 工作流 / 模板。**顺手引导把模板提交进画廊** + 写 `derivedFrom` 让信用回流。 |
| Announcements | `announcements` | — | 只有维护者能发(发版、重要变更)。无表单。 |
| General | `general` | — | 放欢迎帖 + 不归类的闲聊。无表单。 |

**slug 即文件名**:GitHub 按 `.github/DISCUSSION_TEMPLATE/<slug>.yml` 把表单挂到同名
分类。这三个 slug 是 GitHub 开启时**自动建**的默认分类,所以模板「开箱即用」,不需要
先手动建分类再对名字。

---

## 四、表单模板(`.github/DISCUSSION_TEMPLATE/`)

跟 [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/) 一个套路——结构化表单,
让发帖的人一开始就给到能帮上忙的信息。三个模板各有侧重:

- **`q-a.yml`** —— 引导给出「你想做什么」(不只是报错)+「试过什么」+ 版本 + 运行形态;
  并把 **bug 推回 Issues、安全问题推到 SECURITY.md**,客厅不收这两类。
- **`ideas.yml`** —— 先问「问题是什么」再问「你想要什么」,并让提案人**对照北极星三层**
  自己掂量契合度(要 hub 跑大模型 / 藏状态 / 集中凭证的,诚实说出来——不是一票否决,
  但影响讨论走向)。
- **`show-and-tell.yml`** —— 晒成果之余,**把「这能不能进一键画廊」的引导前置**:链到
  [社区模板提交流程](../../templates/community/templates/README.md),收 `slug` 和
  `derivedFrom`(喂引用排行榜),并把画廊的两条硬规矩(凭证只能 `${ENV}`、不带知识
  内容/人员)做成勾选项。

> 表单字段是英文的——跟 `.github/ISSUE_TEMPLATE/` 的既有约定一致;每个表单开头的
> 说明块加了一句中文提示,照顾中文为主的用户。欢迎帖(§五)则是中文在前、英文在后。

---

## 五、欢迎 / 置顶帖草稿(复制即用)

开启 Discussions 后,把下面这段**整段复制**,在 **General** 分类发一篇新 Discussion,
标题 `👋 欢迎来到 AipeHub 客厅 / Welcome`,发完点 **Pin**。中文在前(社区主受众),
英文在后。

```markdown
## 👋 欢迎来到 AipeHub 客厅

这里是 AipeHub 的客厅——问问题、晒成果、聊想法的地方。先认认门:

- **🙋 有问题?** 去 **Q&A** 开一帖。说清楚你想做什么、试过什么,有人会帮你。
- **🛠 做了东西?** 去 **Show & Tell** 晒出来。如果是一个**别人能照着导入就跑**的
  模板,顺手按 [提交流程](../../tree/main/templates/community/templates) 提进一键画廊。
- **💡 有想法?** 去 **Ideas** 提。AipeHub 有一条明确的脊梁,对着它提更容易被采纳:
  **框架不跑大模型 · 人和 agent 是同一种参与者 · 状态都是磁盘文件 · 联邦点对点
  (工作流能跨边界,但凭证/数据/计费各归各家)**。
- **🐞 发现 bug?** 那个去 [Issues](../../issues/new/choose),不在这里。
- **🔐 安全问题?** **千万别**公开发——走 [SECURITY.md](../../blob/main/SECURITY.md)
  里的私密上报通道。

新来的,从这两篇开始:
- [5 分钟总览](../../blob/main/docs/zh/OVERVIEW.md) —— 一页地图看懂所有概念。
- [开箱即用的 hub 案例](../../blob/main/docs/zh/HANDS-ON-HUBS.md) —— 挑一个最像你
  需求的,5 分钟跑起来。

一条公约:对人客气、对事较真。完整版见
[行为准则](../../blob/main/CODE_OF_CONDUCT.md)。玩得开心 🎉

---

## 👋 Welcome to the AipeHub living room

This is where the AipeHub community hangs out — ask, show, and talk shop. The map:

- **🙋 A question?** Open one in **Q&A**. Say what you're trying to do and what you
  tried; someone will help.
- **🛠 Built something?** Show it in **Show & Tell**. If it's a template others can
  import-and-run, submit it to the one-click gallery via the
  [submit flow](../../tree/main/templates/community/templates).
- **💡 An idea?** Pitch it in **Ideas**. AipeHub has a deliberate spine — aiming with
  it lands better: **the hub never runs an LLM · people and agents are the same
  Participant · state is files on disk · federation is peer-to-peer (workflows can
  cross org lines, but credentials/data/billing each stay home)**.
- **🐞 A bug?** That goes to [Issues](../../issues/new/choose), not here.
- **🔐 A security issue?** Please do **not** post it publicly — use the private
  channel in [SECURITY.md](../../blob/main/SECURITY.md).

New here? Start with the [5-minute overview](../../blob/main/docs/OVERVIEW.md) and the
[hands-on hubs](../../blob/main/docs/zh/HANDS-ON-HUBS.md). One house rule: be kind to
people, rigorous about ideas — full text in the
[Code of Conduct](../../blob/main/CODE_OF_CONDUCT.md). Have fun 🎉
```

> 上面草稿里的链接用的是 GitHub 仓库相对路径(`../../tree/main/…`、`../../blob/main/…`),
> 贴进一篇 Discussion 后能正确解析到仓库文件。发帖前可以预览一眼确认链接没断。

---

## 六、它怎么跟其余几件串起来

这一项不是孤立的——它把上线前清单已经铺好的几条线接上了客厅:

- **Issue 分流**:[`ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)
  的「💬 Question or discussion」link 早就指向 `/discussions`;开启后这条链接就不再 404。
- **模板画廊 / 排行榜**:Show & Tell 表单把模板作者引去
  [社区模板提交流程](../../templates/community/templates/README.md),提交合并后就出现在
  一键画廊([`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md))和静态店面
  ([`COMMUNITY-SITE.md`](COMMUNITY-SITE.md))上;表单收的 `derivedFrom` 喂引用排行榜。
- **治理**:[`GOVERNANCE.md`](../../GOVERNANCE.md) 把 Discussions 列为贡献者的入口之一;
  Ideas 里成型的方向,走 GOVERNANCE 的决策流程落地。

`.github/RELEASE-CHECKLIST.md` 里「Enable GitHub Discussions」那一项,现在指向本文。

---

## 七、边界(诚实)

- **Claude 开不了 Discussions**:那是仓库 Settings 里的一个开关(§二),只能 owner 在
  网页点。本仓库能做的「脚手架」——表单模板、欢迎帖草稿、分流链接、文档——全部就绪了。
- **表单不是审核**:Discussion 模板只是**引导发帖**,不拦人、不校验。模板进画廊的真校验
  在 [`pnpm check:templates`](../../templates/community/templates/README.md)(过真
  `parseTemplate`),那是另一回事。
- **不强求迁移历史**:今天散在各处文档里指向 `/discussions` 的链接(REAL-WORLD-TESTING、
  LICENSE-FAQ 等)开启后自然变活,不需要回头改。

---

## 相关

- [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md) —— 零算力静态店面(同一立场的另一半)。
- [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md) —— admin 控制台内的一键安装画廊。
- [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) —— 旗舰模板策展索引 + 引用排行榜。
- `../../CONTRIBUTING.md` · `../../GOVERNANCE.md` · `../../CODE_OF_CONDUCT.md` —— 社区根文件。
- [`templates/community/templates/README.md`](../../templates/community/templates/README.md) —— 模板提交 5 步流程。
