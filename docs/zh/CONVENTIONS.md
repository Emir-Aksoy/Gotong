# 惯例 · 让 Gotong 保持轻的那几条规矩

> 这个仓库唯一还在退的指标是「易上手 / 好扩展」（缺口 2）：内核干净，但装配层重、
> 旋钮多、文档考古层厚。膨胀不是一次搞砸的，是一个个「就多加这一点」攒出来的。
> 这一页把**防它再膨胀的惯例**写下来，并把其中能机器检查的钉成会红的门。
>
> 人写的惯例靠自觉，容易忘；所以关键几条另配了 GUARD 承重门（见文末总表），
> `pnpm check:guards` 一把过。惯例是「为什么」，门是「忘了就红」。

---

## 一、不可破的三条（北极星，改了就不是 Gotong）

1. **框架不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件，决策权永远在
   参与者手里。→ 由 `workflow` 包**零 LLM 依赖**这条机器不变量兜底（kernel-deps 门）。
2. **人和 agent 是同一个 `Participant`**。别把人做成 "request_human_input tool"。一切
   跨人 / 跨 agent 协作走同一套消息 + task + transcript。→ 见 [`PARTICIPANT.md`](PARTICIPANT.md)。
3. **状态都是磁盘文件**。`.gotong/` 里能看到全部；复制目录 = 搬走房间，重启透明。

宪章正文：[`CHARTER.md`](CHARTER.md)。与代码冲突时**宪章为源**。

## 二、依赖方向：箭头只能朝内

内核干净是 Gotong 还能快速接新东西的根本原因，靠的就是依赖方向：

```
protocol (零依赖, wire root)  ←  core  ←  workflow / inbox / a2a  ←  … 叶子 …  ←  host / web (装配层)
```

- `protocol` 永远零 `@gotong` 依赖；`core` 只看 `protocol`；`workflow` 不碰任何 `llm` 包；
  `inbox` / `a2a` 只到 `core`。
- **装配层（`host` / `web` / `cli`）在最外圈**——内核任何包都不许反向依赖它们。
- `web` **永不依赖 `host`**：host 的能力经注入的鸭子 `*Surface` 过来，web 保持哑。
  见 [`SURFACE-PATTERN.md`](SURFACE-PATTERN.md)。

→ 这一整段由 `pnpm check:kernel-deps` 钉死：加一条反向边就红。

## 三、旋钮：加一个就得登记一个

`GOTONG_*` 环境旋钮已经 100+ 个——每一个都是系统能悄悄换行为的暗门。惯例：

- **能不加就不加**。先问「这能不能是默认值 / 探测出来 / 从已有旋钮推出来」。
- 真要加，**必须登记**进 [`../../scripts/gotong-env-registry.txt`](../../scripts/gotong-env-registry.txt)。
- 呈现视角这类「先展示什么」的开关，走 `GOTONG_PROFILE` 那种**纯映射、不分叉行为**的形态，
  别做成第 N 个行为开关（见 [`DEPLOYMENT-PROFILE.md`](DEPLOYMENT-PROFILE.md)）。

→ `pnpm check:env-registry`：代码里出现没登记的 `GOTONG_*` 就红，登记了却没用也红。

## 四、装配层：行数是有预算的

`host/src/main.ts`、`web/src/server.ts`、`web/src/me-routes.ts` 是反复长大的热点文件。
它们有**行数预算**，且预算是个**只降不升的棘轮**：

- 拆文件时，在同一个 commit 里把它的预算**调低**。
- 确实要加行、且无法在文件内腾出，才**显式抬高预算**，并在 commit 里说明为什么。
- 抬预算是可见的一行改动——这点摩擦就是护栏本身。你**没法悄悄把 main.ts 吹大**。

→ `pnpm check:line-budget`：越预算就红。`--report` 看当前用量 / 余量。

## 五、写代码时的日常惯例

来自根 `CLAUDE.md` §4.2，逐条都是「防攒膨胀」：

- **删旧优先于加 shim**。还没上线，**不需要向前兼容**——大胆改 schema / API，删死代码
  比加 deprecation 包袱好。（不可逆的 drop schema 例外：停下来问一句要不要留迁移脚本。）
- **一个 PR 一个小目标**，别一次塞五个 feature；**一个任务一个任务**：规划→开发→测试→
  commit→下一个。
- **每个新 feature 配回归测试**（vitest）。关键承诺配**承重门**（E2E / smoke），不是只写文档。
- **叶包尽量薄**：新能力优先做成**零 host / 零 identity 依赖**的叶包 + 注入接缝，别往 `host`
  里再堆。（记忆引擎 `personal-memory`、围栏 `workspace-jail` 都是这么长出来的。）
- 类型化错误（`IdentityError` 之类），不抛裸 `Error`；结构化 logger，不 `console.log` 乱撒。
- 注释写**为什么**，不写是什么；不无故加 emoji 到文件 / commit。
- 接主流 agent 适配器，先过 [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md) 的
  双向 + 五控制缝验收门。

## 六、文档：教程在上，考古在下

- `docs/zh/` 顶层只放**当前该读的**教程 / 参考；逐里程碑的 `*-FINAL` / `PHASE` / `AUDIT`
  账本沉到 [`ledger/`](ledger/README.md)。加新账本进 `ledger/`，别堆回顶层。
- 顶层文档的组织是 [`README.md`](README.md) 的六级金字塔；加新文档时挂到对的层。

---

## 护栏总表（惯例 → 门 → 命令）

| 惯例 | 承重门 | 跑 |
|---|---|---|
| 依赖方向朝内 · `workflow` 零 LLM · `web` ∌ `host` | `scripts/kernel-deps-gate.mjs` | `pnpm check:kernel-deps` |
| `GOTONG_*` 旋钮加一个登记一个 | `scripts/env-registry-gate.mjs` + `gotong-env-registry.txt` | `pnpm check:env-registry` |
| 装配层热点文件行数棘轮 | `scripts/line-budget-gate.mjs` | `pnpm check:line-budget` |
| 上手第一步「5 分钟见结果」不退 | `scripts/first-result-smoke.mjs` | `pnpm check:first-result` |
| 以上结构护栏一把过 | — | `pnpm check:guards` |

> GUARD 门只覆盖**能机器判定**的那几条；其余惯例靠 review 与本页。门红了不是「绕过它」，
> 是「要么改回来，要么在门的定义里显式、可见地放宽并说明为什么」——那点摩擦是故意留的。

**接着读**：[`ARCHITECTURE.md`](ARCHITECTURE.md)（模块边界）· [`SURFACE-PATTERN.md`](SURFACE-PATTERN.md)
（加能力不加耦合）· [`PARTICIPANT.md`](PARTICIPANT.md)（扩展面）· 根 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
