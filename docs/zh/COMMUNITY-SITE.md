# 社区落地页 + 模板画廊 + 引用排行榜（零算力静态站）

<!-- doc-version: 1.0 -->
> **文档版本 1.0** · 中文译本 · 最后更新 2026-06-27 · 权威源：[English](../COMMUNITY-SITE.md)。如译文与英文版冲突，以英文版为准。


> 上线前清单 item 7。一句话:**社区需要零算力**——把它做成一堆静态文件,
> 丢到任意免费静态托管上就活了,云盒留作备用。

---

## 一、为什么是「零算力」

Gotong 的整套设计立场是 **hub 自己不跑大模型 / 状态都是磁盘文件 /
凭证留本机 / 联邦点对点**。这条立场顺下来,**社区基础设施也不需要服务器**:

- **GitHub 已经托管了实质内容** —— 一个模板就是一个文件,提交就是一个 PR。
- **缺的只是一个店面** —— 而一个 file-first 项目的店面,本身就是一堆静态文件。

所以这个店面 = 一个生成器 + 它产出的静态文件。生成器叫
[`packages/web/scripts/build-site.mjs`](../../packages/web/scripts/build-site.mjs),
产出 `site/`(仓库根,gitignored):

- `index.html` —— 自包含单文件(无框架、无运行时、内联 CSS):信任叙事首屏
  + 模板画廊卡片网格 + 引用排行榜表格。
- `templates.json` —— 机器可读的 `gotong.site/v1` feed(店面也是数据,file-first)。

把 `site/` 丢到 GitHub Pages / Cloudflare Pages / Netlify 任意一个免费档,店面
就以 **¥0** 上线了。腾讯云那台 2c2G 盒子继续躺着备用。

---

## 二、怎么构建

```bash
pnpm build:site          # 根脚本,委托到 packages/web
# 或
pnpm -C packages/web build:site
```

输出:

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/` 是**按需构建、不入库**的派生物(跟 `dist-portable/` 同一立场,见
`.gitignore`)。单一真相留在 `examples/` 和 `templates/community/`(模版与框架
分离);店面是它们的只读投影,改了模板重跑生成器即可。

**确定性**:生成器不写时间戳、稳定排序 → 同样的输入产出**逐字节相同**的
`site/`,重建不产生无意义 diff。

---

## 三、语料 = 被校验过的那一套

生成器扫的**正是**仓库级校验门(`pnpm check:templates` /
[`tests/all-templates-parse.test.ts`](../../packages/web/tests/all-templates-parse.test.ts))
校验的同两个根:

| origin | 路径 | 说明 |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | 随框架附带的旗舰模板 |
| `community` | `templates/community/templates/**/*.ya?ml` | 社区提交落的地方 |

所以「每个通过 CI 的模板都出现在店面上」是**按构造成立**的——一个解析不过
的 manifest 永远上不了卡片(它过不了 `check:templates`,根本进不来)。

---

## 四、引用排行榜 = `provenance.derivedFrom` 的入度

排行榜读的是加性溯源字段 `template.provenance.derivedFrom`(上线前清单 item 6):

- 一条 `derivedFrom` 项是一条**引用边**:声明「本模板基于谁改的」。
- 排名 = **入度** = 「有多少模板 derive 自我」。
- 边引用的是目标模板的 **slug**(它的公开把手,见下),所以 fork 一个模板时,
  在你的 `provenance.derivedFrom` 里写上**上游的 slug** 就完成了署名传承。

随框架附带的两条真实引用边(也写在 `CLAUDE.md` 里):

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # 姊妹案例,同一套分派骨架

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # MIRROR,方向相反的跨组织编排
```

→ 排行榜上 `personal-coding-hub` 和 `tea-supply-link` 各得 1 票。

**typo 不会被静默吞掉**:`derivedFrom` 指向一个不存在的 slug 时,生成器在
stderr 打一条 `WARNING … no template with that slug`(`buildModel` 把它收进
`unresolved`),绝不当 0 票悄悄略过。

---

## 五、slug(公开把手)方案

slug 是模板的**稳定公开身份**——画廊(`builtin-templates.ts`)、
`FLAGSHIP-TEMPLATES.md`、和这个店面用的是同一个把手,这样 fork 的
`derivedFrom` 能用「大家都认识的那个名字」引用上游。`assignSlugs` 的规则:

| 来源 | slug |
|---|---|
| 旗舰,且 `examples/<dir>` 下**只有一个**模板文件 | `<dir>` 的 basename(如 `examples/tea-supply-link` 装 `tea-shop.template.yaml` → slug `tea-supply-link`,**不是**文件名) |
| 旗舰,且**同一 dir 下多个**模板文件 | 文件名词干消歧(如 `examples/family-learning-hub` 装 `family-tutor` + `child-desk`) |
| 社区 | 文件名词干 |

**冲突即构建失败**:两个模板算出同一个 slug → `assignSlugs` 抛错。一个有歧义的
公开把手必须在构建时响亮报错,绝不能是一张被悄悄覆盖的卡片 / 一条指错模板的
引用边。(这条 uniqueness guard 是真踩过的坑:`family-tutor` 和 `child-desk`
同在一个 dir,早先都拿了 dir 名 `family-learning-hub` 撞了车。)

---

## 六、部署(免费静态托管)

`site/` 是纯静态产物,任意免费档都行。以 **GitHub Pages** 为例(无需 Actions
额度——本地构建,手动推 `gh-pages` 分支或用 Pages 的 `/docs` 约定):

```bash
pnpm build:site
# 然后把 site/ 的内容发布到你选的静态托管:
#   · Cloudflare Pages / Netlify:把 site/ 拖进去,或接一个「build: pnpm build:site,
#     output: site」的钩子(它们的免费档自带构建额度,跟本仓库的 Actions 额度无关);
#   · GitHub Pages:本地 build 后把 site/ 推到 gh-pages 分支。
```

> ⚠️ 本仓库的 **GitHub Actions 额度已耗尽**,store 的构建**不靠**本仓库 CI。
> 生成器在本地跑(免费),静态托管商自带的构建额度是另一回事。`site/` 不入库,
> 所以也不会因为它产生仓库体积。

---

## 七、防腐测试

[`tests/build-site.test.ts`](../../packages/web/tests/build-site.test.ts) 钉住
生成器的纯逻辑(它的 IO 外壳是 guarded 的,`import` 不触发文件扫描也不写文件):

- `assignSlugs` —— 三种 slug 规则 + uniqueness guard(那个真踩过的坑的回归栅栏);
- `extractTemplate` —— 从 raw manifest 读展示面 + `provenance.derivedFrom`(过滤
  空项),坏 schema 响亮抛错;
- `buildModel` —— 引用入度计数 + 排行榜排序 + 把 typo 的引用surfac成 `unresolved`;
- `escapeHtml` / `render*` —— 社区给的名字/描述是**不可信**的,XSS 用例钉死
  `<script>` 永远逃不出 markup。

---

## 八、边界(诚实)

- 店面**不是**模板编辑器,也不安装任何东西——它只是个只读橱窗。安装走
  admin 控制台的「模板画廊」一键装 / `POST /api/admin/templates/import`
  (见 [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md))。
- **模版与框架分离**不破:店面只读 manifest 的**结构 + 引用**,从不展示、也
  从不携带知识内容或人员(决策 #4/#5)。
- `site/` 是构建期快照:改了 `examples/*/template/` 或新增社区模板后要**重跑**
  `pnpm build:site`;防腐测试是那道哨兵。

---

## 相关

- [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md) —— admin 控制台内的一键安装画廊(同一语料的另一个消费者)。
- [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) —— 旗舰模板的人工策展索引。
- [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) —— 开箱即用 hub 案例对照 + go-live runbook。
- `../../CONTRIBUTING.md` —— 社区模板提交流程(license-clear + 过 `pnpm check:templates`)。
