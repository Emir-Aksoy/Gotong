# 版本号怎么管 —— lockstep

> 一句话：**37 个可发布包共用一个版本号，根 `package.json` 是唯一真相源，
> 改版本只能走 `scripts/bump-version.mjs`，`pnpm check:version` 盯着。**
>
> Last updated: 2026-07-20

---

## 一、为什么是 lockstep

不是因为它优雅，是因为这张依赖图逼出来的。

包间依赖 **89 处全部写作 `workspace:*`**。pnpm 在发布时把它改写成真实版本——
关键在于改写成的是**精确钉版，不是范围**。去 npm 上看已发布的 `@gotong/core`：

```console
$ npm view @gotong/core@3.1.0 dependencies
{ "@gotong/protocol": "3.1.0" }
```

不是 `^3.1.0`。是死死钉住的 `3.1.0`。

于是「每个包各升各的」这条路在这里走不通：

> 改了 `protocol`、升成 3.2.0，但 `core` 自己的源码没动所以不升号 →
> npm 上的 `@gotong/core@3.1.0` **永远钉着 `protocol@3.1.0`** →
> 装 `core` 的人拿到的还是旧 protocol。

要修就得把 core 也升一号，好让它重新钉。而 core 有下游，下游又有下游——
一路传到根。**独立版本在这张图下会退化成近似 lockstep，只是多背一层
「哪些包要跟着升」的仪式。** 既然结果一样，就直说。

## 二、这道门在防什么（已经发生过的事）

2026-07-20 的体检：

| 事实 | 数字 |
|---|---|
| 本地版本号与 npm 上**完全相同**的包 | 36 / 37 |
| npm 那批发布于 | 2026-07-06/07 |
| 上次真正**定版**（`0e5c249 cut v3.1.0`） | **2026-05-20** |
| 定版后 `@gotong/web` 改动 | **327 次提交** |
| `@gotong/host` | 220 次 |
| `@gotong/identity`（扛 SQLite schema 那个） | 96 次 |
| `@gotong/core` | 62 次 |

两个月、几百次提交，版本号一动没动，还照着老号发上了 npm。结果是版本号
**不再承载任何信息**：`npm i @gotong/core@3.1.0` 和 `git clone` 拿到的是两套
代码，顶着同一个数字。

这不是谁偷懒——是没有任何东西会因此变红。所以补一道门。

## 三、规矩

### 唯一真相源

根 `package.json` 的 `version`。`packages/*` 里每个 `private !== true` 的包
必须等于它。`examples/*` 全是 private，不参与。

### 改版本只走一个入口

```bash
node scripts/bump-version.mjs 4.1.0 --dry   # 先看会改什么
node scripts/bump-version.mjs 4.1.0         # 改
pnpm check:version                          # 确认 lockstep 成立
pnpm build                                  # dist 跟着走
```

它只改 `version` 那一行（不重排 JSON、不制造无关 diff），**不碰 `workspace:*`**
（那是 pnpm 发布时的活，手动同步纯属白写还容易漏），**不 commit、不打 tag、
不发布**。

**定版单独一个 commit**，别和功能改动混在一起——将来 `git log` 里那一行就是
「这个号从这里开始」，混进功能改动会让这条线索作废。

### 升 major 时还有一处要手动跟

`packages/cli/src/templates/ts-agent.ts` 里 `gotong new ts-agent` 脚手架出来的
`package.json` 硬钉着 `"@gotong/sdk-node": "^N.0.0"`。**不用记**——
`packages/cli/tests/templates.test.ts` 从 sdk-node 的 package.json 现算 major，
对不上就红。（这个坑真踩过：v3.0 发布后模板还钉着 `^2.0.0`，新用户
`gotong new ts-agent foo && pnpm install` 一上来就 ERESOLVE；那次之后才补的
这个测试。3→4 这次它又如期红了一回。）

### 什么时候升，升哪一档

lockstep 下，档位描述的是**整套 Gotong**，不是单个包：

| 档 | 什么时候 |
|---|---|
| major `x.0.0` | 破坏性变更：协议 wire 改了、schema 迁移不兼容、公开 API 删了 |
| minor `4.x.0` | 加能力，向后兼容 |
| patch `4.0.x` | 只修 bug |

因为是 lockstep，「im-qq 改了一个字」也会让 37 个包一起升号。**这是有意接受
的代价**：npm 不按版本数收费，也没人单独钉着 `@gotong/im-qq`。换来的是
drift 结构性不可能。

## 四、起点为什么是 4.0.0

- `@gotong/host` 已在 3.2.0，`core` / `web` 等在 3.1.0。
- 与 npm 上那批的差距是两个月、几百次提交——**那确实是一个大版本**，
  不是 patch。
- `0.1.0` 的包（`im-lark` 扛着生产飞书桥、`identity` 扛着 schema）跳到 4.0.0，
  比继续假装自己是实验品更诚实。

## 五、门与工具

| 东西 | 干什么 |
|---|---|
| `scripts/version-gate.mjs` | 断言 37 个包 == 根版本。挂在 `pnpm check:version`，也进 `pnpm check:guards` |
| `scripts/bump-version.mjs` | 一次改全部。门的对偶：门说「不许不一致」，它保证「一次改全」 |
| `scripts/publish-readiness-gate.mjs` | 发布前的另一组断言（无 private / 字段齐 / 无断链），`pnpm check:publish` |

`check:version` **刻意不联网**——它只管「号一致」这件离线可判定的事。
「号该不该往前走」要跟 npm 比对，属于发布前的活，见
[`PUBLISH-RUNBOOK.md`](PUBLISH-RUNBOOK.md)。

## 六、显式不做

- **不引 changesets**。它解决的是「谁该升、升多少」，而 lockstep 下这两个问题
  都没了。对单维护者来说，每个 PR 多写一个 changeset 文件是持续的仪式负担，
  换不回等价的信息。
- **不自动打 git tag / 不自动发布**。定版、提交、发布是三件事，各自要人点头。
- **不做 per-package 版本**。理由见第一节；将来真有人只想装
  `@gotong/protocol` 且介意跟着升号，再按那时的实际需求重开这个岔口，
  现在不预造。

---

**相关**：[`PUBLISH-RUNBOOK.md`](PUBLISH-RUNBOOK.md)（发布流程）·
[`UPGRADE-RUNBOOK.md`](UPGRADE-RUNBOOK.md)（升级已部署的 hub）·
[`CONVENTIONS.md`](CONVENTIONS.md)（护栏总表）
