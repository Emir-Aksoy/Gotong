# 旗舰模板 —— 普通人导入就能用的 hub

<!-- doc-version: 1.0 -->
> **文档版本 1.0** · 中文译本 · 最后更新 2026-06-27 · 权威源：[English](../FLAGSHIP-TEMPLATES.md)。如译文与英文版冲突，以英文版为准。


> 这是一份**经过背书的**模板清单。「旗舰」不是「最多」，是「我们替它担保」：
> 每一个都带一条 **确定性 demo**（一条命令、不要 key、自己验证自己），都把
> **治理姿态**（能碰什么、不能碰什么、人在哪把关）摆在明面上，都**有人维护**。
>
> 想看全部模板（含社区档）：admin UI 的「工作流 → 模板画廊」。想自己提交一个：
> [`templates/community/templates/`](../../templates/community/templates/)。
> 这份清单的评选标准写在 [`GOVERNANCE.md`](../../GOVERNANCE.md)。

---

## 为什么是这几个

Gotong 的差异点不是「能调 AI」——满大街都能。是**你敢把 AI 指向家、家人、钱**，
因为边界是真的、且是你自己的：

- **关键动作上有人把关。** 可逆的（关灯）直接做；不可逆的（锁门、花钱、把孩子的
  数据发出去）挂起等人在收件箱确认 —— 工作流**跳不过**这道闸。
- **钥匙和数据在你自己盘上。** 凭证加密存在你的 `.gotong/` 目录里。跟另一个 hub
  联邦，分享的是一个**能力**，不是你的金库。
- **没有暗箱决策。** 每一次派发和结果都是一条可读的只读 transcript。框架从不跑模型，
  没有藏起来的判断。

下面这些模板，每一个都是这三条原则**落到一件具体的事**上。

---

## 一览

| 模板 | 给谁 | 人在哪把关（治理姿态） | 跑一下（无需 key） |
|---|---|---|---|
| **smart-home-hub** 智能家居 | 有智能家居的人 | 关灯/空调直接做；**锁门、布防**等住户在收件箱确认 | `pnpm demo:smart-home-hub` |
| **family-learning-hub** 家庭学习 | 给孩子开 AI 的家长 | 白名单外的课题、孩子的数据外流，**都要家长批**；订阅、数据各归各家 | `pnpm demo:family-learning-hub` |
| **cafe-ops** 门店运营 | 小店店主 / 店长 | 加班费**助手只建议、店长定钱**；排班要店长确认 | `pnpm demo:cafe-ops` |
| **personal-coding-hub** 个人编码 | 想让 AI 帮写代码的人 | 危险命令（rm -rf / push --force）挂起等你批；分工你说了算 | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** 编码（Codex+DeepSeek） | 同上，换一套模型 | 同上 | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** 个人研究 | 攒了一堆资料想理清的人 | 只读编译，把原始资料编成互链 wiki | `pnpm demo:personal-research-hub` |
| **battle-monk-training** 个人成长 | 想要日常操练计划的人 | 只写你自己的成长档案；不给医疗/心理建议 | `pnpm demo:battle-monk-training` |
| **warband-club** 同好会 | 兴趣社群 / 战团 | 共享档案库谁都能读写；重大决策走会长确认 | `pnpm demo:warband-club` |
| **tea-supply-link** 跨组织供货 | 要跟供货商对接的店 | 下单**跨组织前要人批**；钱供货商报价、人定 | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** 连锁总部 | 管加盟店的总部 | 调价指令**下发前区域经理批**；门店是主权方不是下属 | `pnpm demo:tea-chain-hq` |

每个还配一个 `pnpm demo:<名字>:template` —— 把那个模板文件读进来、解析、预览它声明的
架构（不起子进程、不要 key），让你看清「模板里装了什么、什么住在模板外」。

---

## 家与家庭

### ⭐ smart-home-hub —— 智能家居（小米经 Home Assistant）

**给谁 / 干什么。** 一个家居管家经 Home Assistant 控制你的小米（或任何有 HA 集成的）
设备，跑一条「晚安例程」。

**它能碰什么。** 关公共区域的灯、把卧室空调切睡眠 —— 这些**可逆**，直接做。

**人在哪把关（治理姿态）。** 锁大门、布防是**不可逆的物理 / 安防**动作 —— 工作流
跑到这一步会**挂起**，等住户在 `/me` 收件箱点「确认」才执行。拒绝 → 那一步被
`when:` 闸跳过 → **门保持不锁**（fail-closed，拦下一个动作，不外溢）。这正是「可逆
直接做、不可逆要人确认」落到一个家里的样子。

**模版 / 框架分离。** 模板里设备的 MCP 接线是 `${HA_MCP_SSE_URL}` / `${HA_TOKEN}`
占位符 —— 你接哪个 Home Assistant、用哪个令牌，是导入后填的运行时配置。工作流只点名
能力（`home.apply-scene` / `home.secure`），从不点名某一台设备。换一套设备、换一个家，
工作流一个字不用改。这个模板**没有 KB 槽位**（设备状态就是实时 HA，不需要单独知识库）。

- 跑一下：`pnpm demo:smart-home-hub`（两个剧情：批准 → 门锁；拒绝 → 门不锁）
- 模板：[`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- 真接 Home Assistant：见 [README](../../examples/smart-home-hub/README.md)

### ⭐ family-learning-hub —— 家庭学习（家长给孩子开 AI）

**给谁 / 干什么。** 家长出钱开 AI 订阅，孩子用一个**独立的** hub 学习；孩子的 hub
靠授权调用家长这边的订阅，一个 AI 导师（复刻 Matt Pocock 的 `/teach`：先立使命、
一小步、先知识后技能、引一手来源）带孩子探索。这是这份清单里**生产硬化程度最高**的一个
（真 ws 联邦 + IM 监督 + 真 DeepSeek 都跑通过）。

**它能碰什么。** 在白名单主题内，导师直接教；学习记录的**主副本在孩子的 hub** 上。

**人在哪把关（治理姿态）—— 四道闸。**

1. **主题白名单 + 内容自评** → 白名单外的课题、自评标了 `flagged` 的内容，**挂起等
   家长批**。
2. **数据分类闸**：孩子的数据标 `child-learning`，发不到没被授权这类数据的第三方
   （fail-closed）。
3. **管辖权**：家长持订阅（经济咽喉）+ 每条联邦链路一份信任契约 + 全程 transcript
   fork（家长拿一份监督副本）。
4. **凭证 / 数据各归各家**：两个主权 hub，孩子的数据从孩子这边发一份给家长，但
   订阅和金库不交叉。

**模版 / 框架分离。** 跨组织的链接（哪个孩子 peer、出站放行哪些能力、审批策略、
`allowedDataClasses`）是**运行时 peer 配置**，既不在模板也不在工作流。两个模板：
家长侧 `family-tutor`（带导师 + 白名单/审批工作流）、孩子侧 `child-desk`（零订阅 +
学习记录主副本）。

- 跑一下：`pnpm demo:family-learning-hub`（六个剧情，含白名单外→家长批 / 家长拒→课不教）
- 模板：[`family-tutor`](../../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../../examples/family-learning-hub/template/child-desk.template.yaml)
- 真部署（两台主权机）：[`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](FAMILY-LEARNING-GO-LIVE.md) · 设计：[`FAMILY-LEARNING-HUB-DESIGN.md`](FAMILY-LEARNING-HUB-DESIGN.md)

---

## 个人生产力

### personal-coding-hub —— 个人编码（Claude Code + Codex 分工）

**给谁 / 干什么。** 一个路由「模型」分析任务 + 结合你的安排，决定把活派给 Claude Code
还是 Codex；两个编码 agent 共享同一个工作目录，靠 `AGENTS.md`（规范）+ `PROGRESS.md`
（交接棒）协作。还有**对抗式会诊**：出问题时多个 agent 一起读代码、先盲诊再质证，
投票收敛到真实根因。

**人在哪把关（治理姿态）。** 危险命令（`rm -rf`、`git push --force`、`sudo`、
`curl | sh` …）在执行**前挂起**等你批，拒绝 → fail-closed，命令从未跑。分工**你说了
算**：临时点名（「这个交给 codex」）或用大白话改总分工层（OpenClaw 式，写回
`routing-policy.json`）。

**模版 / 框架分离。** 模板带 1 个导师 agent（`coding-mentor`，DeepSeek + 内联
mcp-obsidian）+ 1 个可寻址 KB 槽位（方法论库，`presetData` 指针）。两个 CLI 编码
agent 是**运行时接的**（CliParticipant 不进托管 agent 名单），知识**内容**住模板外。

- 跑一下：`pnpm demo:personal-coding-hub`（10 剧情：分工 / 显式分派 / 大白话改分工 / 安全闸）
- 会诊：`pnpm demo:personal-coding-hub:consult`
- 模板：[`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub —— 编码（Codex + DeepSeek TUI）

personal-coding-hub 的**姊妹**：换一套模型 —— Codex（快手实现）+ DeepSeek TUI
（推理主理）。同样的路由 + 大白话改分工 + 显式分派 + 安全闸，自成一体不碰
personal-coding-hub。

- 跑一下：`pnpm demo:codex-deepseek-hub`
- 模板：[`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub —— 个人研究 / 知识中枢

**给谁 / 干什么。** 一个馆员（librarian）把你的原始源材料**编译**成互链的 Obsidian
wiki（LLM-as-compiler），再让你「问你的 wiki」。三个托管 LLM agent（馆员 / 编译器 /
研究员）整队搬走。

**治理姿态。** 编译是**只读**地把 raw 编成笔记 + backlink；答问引用来源、归档到
`wiki/answers/`。

- 跑一下：`pnpm demo:personal-research-hub`
- 模板：[`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training —— 个人成长（身 / 心 / 学三柱）

**给谁 / 干什么。** 一个督修把今日操练派给三柱（体能 / 心智 / 学识），每柱按你档案里
的已练阶推下一阶，连续性是设计核心 —— Obsidian KB **存的是你的状态**（不是参考资料）。
冷峻的 grimdark-monastic 风格（原创同人致敬，面向战锤 40k 风格用户）。

**治理姿态 / 安全边界。** 它**只写你自己的成长档案**；这是个人数据，**不是医疗 / 心理
建议**，别拿它当唯一依据。

- 跑一下：`pnpm demo:battle-monk-training`
- 模板：[`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## 组织与跨组织

### cafe-ops —— 门店运营（奶茶 / 咖啡店）

**给谁 / 干什么。** 一个小店的正式流程：新员工上手（学岗位 SOP，成员自助）、排班
（店长确认）、加班费（店长审批）。第一个 `workflows[]` 非空的模板 —— 组织的价值在
正式流程。

**人在哪把关（治理姿态）。** 加班费**助手只建议金额、店长定钱**：助手按日别算倍率
（工作日 1.5 / 休息日 2 / 法定节假日 3），但工作流跑到审批步会挂起，店长在收件箱批了
才落实。**钱是确定性算的，不是 LLM 算的；人定。**

- 跑一下：`pnpm demo:cafe-ops`（含加班 HITL 两步恢复）
- 模板：[`examples/cafe-ops/template/cafe-ops.template.yaml`](../../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club —— 同好会（共享档案库）

**给谁 / 干什么。** 一个兴趣社群 / 战团的**协作面**（对比 cafe-ops 的管理面）：一个
全团共读共写的共享档案库 —— 你交进去的涂装方案 / 战报，别人都能查到；你问的答案可能
来自别人早先的贡献 = 合作。

**治理姿态。** 共享档案库谁都能读写；重大决策（集结）走会长 `human:` 确认。单 hub 内
共享，无联邦。

- 跑一下：`pnpm demo:warband-club`
- 模板：[`examples/warband-club/template/warband-club.template.yaml`](../../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link —— 跨组织供货（奶茶店 ↔ 供货商）

**给谁 / 干什么。** 第一个**跨组织**模板：奶茶店的补货工作流编排一步到**供货商的
hub**。

**人在哪把关（治理姿态）。** 下单跨组织那一步走**出站审批闸**（对工作流透明，所以
工作流里**没有** `human:` 步）—— 店长批了才跨界，供货商按目录 + 实时库存逐行定价，
回执回流本地建档。钱供货商算、人定外发。

**模版 / 框架分离（教学点）。** 跨组织的链接（哪个 peer 是供货商、出站放行哪些能力、
审批策略）是**运行时 peer 配置**，既不在模板也不在工作流 —— `place` 步只写能力
`supplier.confirm-order`，从不点名 peer。

- 跑一下：`pnpm demo:tea-supply-link`
- 模板（店一侧）：[`examples/tea-supply-link/template/tea-shop.template.yaml`](../../examples/tea-supply-link/template/tea-shop.template.yaml)
- 两机操作员 runbook：[`docs/zh/FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)

### tea-chain-hq —— 连锁总部（总部 → 加盟门店）

**给谁 / 干什么。** tea-supply-link 的**镜像、方向相反**：那个朝上（门店→供货商），
这个朝下（总部→加盟门店）。三层链条 `总部 → 门店 → 供货商` 里，门店在中间。

**人在哪把关（治理姿态）。** 调价指令下发跨组织那一步走出站审批闸 —— 区域经理批了才
跨界，门店按本店菜单确定性应用调价、回执回流。**门店是主权组织，不是下属对象。**

- 跑一下：`pnpm demo:tea-chain-hq`
- 模板（总部一侧）：[`examples/tea-chain-hq/template/chain-hq.template.yaml`](../../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## 一条命令跑任意一个（确定性，不要 key）

每个旗舰都有一个**确定性 demo**：用确定性替身跑通全流程，自己断言自己的行为，无需
API key、无需真设备 / 真账号。这就是「我们替它担保」的可验证那一半 —— 一条命令就能
证明它真能跑：

```bash
pnpm demo:smart-home-hub          # 家：批准→门锁 / 拒绝→门不锁
pnpm demo:family-learning-hub     # 家庭：白名单外→家长批 / 家长拒→课不教
pnpm demo:cafe-ops                # 门店：加班 HITL，店长定钱
pnpm demo:personal-coding-hub     # 编码：分工 + 安全闸
pnpm demo:personal-research-hub   # 研究：raw → 互链 wiki
pnpm demo:battle-monk-training    # 成长：身/心/学三柱
pnpm demo:warband-club            # 同好会：共享档案库 + 会长确认
pnpm demo:tea-supply-link         # 跨组织：下单跨界要人批
pnpm demo:tea-chain-hq            # 连锁：调价下发要人批
pnpm demo:codex-deepseek-hub      # 编码（Codex + DeepSeek）
```

看模板本身怎么被解析的（载入预览，同样不要 key）：把上面任意一个换成
`pnpm demo:<名字>:template`。

---

## 真用起来

确定性 demo 证明逻辑通；真用一个旗舰，走这几条：

- **一键安装**：admin UI 的「工作流 → 模板画廊」点一个就装进你的 hub
  （详见 [`docs/zh/TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md)）。
- **个人 / 组织 hub 对照 + 真 DeepSeek/Obsidian 上手**：[`docs/zh/HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md)。
- **上线（三种拓扑）**：[`docs/zh/GO-LIVE.md`](GO-LIVE.md)。
- **跨组织联邦两机 runbook**：[`docs/zh/FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)。
- **家庭学习两台主权机部署**：[`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](FAMILY-LEARNING-GO-LIVE.md)。

---

## 引用排行榜（谁被改得最多）

诚实的溯源是这个社区唯一的货币。fork 一个模板时，在你的 `provenance.derivedFrom`
里写上它的 slug —— 信用就回流到上游。下面这张表按「有多少模板声明 `derivedFrom`
它」（被引用次数 = in-degree）排名，由
[`pnpm build:leaderboard`](../../packages/web/scripts/build-leaderboard-doc.mjs)
从校验过的模板语料**确定性生成**，跟[静态店面](COMMUNITY-SITE.md)的排行榜是同一份
计算（绝不打架）：

<!-- LEADERBOARD:START — generated by `pnpm build:leaderboard`; do not edit by hand -->

| # | 模板 | 被引用次数 | 谁基于它改的 |
|---|---|---|---|
| 1 | **个人编码导师(Karpathy 工作流)** (`personal-coding-hub`) | 1 | 配对编码导师(Codex × DeepSeek TUI) |
| 2 | **奶茶店(跨组织供货链接)** (`tea-supply-link`) | 1 | 连锁奶茶店总部(跨组织指令下发) |

<!-- LEADERBOARD:END -->

> 这张表是**生成**的：加一条 `derivedFrom` 边后跑 `pnpm build:leaderboard` 重渲染。
> `packages/web/tests/build-leaderboard-doc.test.ts` 会盯着它跟真实语料同步 —— 手改
> 或忘了重渲染都会被测试逮住。排行榜排的是**模板**，不是人 —— 这是一套**荣誉**激励，
> 不是奖励或经济激励（见 [`docs/zh/RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md)）。

---

## 想贡献一个

旗舰是少数、被背书的。绝大多数模板应该是**社区档** —— 门槛是「许可清晰、能解析、
零明文密钥、有溯源」，不是「替你的品味背书」。流程在
[`templates/community/templates/README.md`](../../templates/community/templates/README.md)：
复制一个旗舰 → 改成你的 → 声明溯源（`derivedFrom`）→ 本地 `pnpm check:templates` →
开 PR。

诚实的溯源是这个社区的货币：`derivedFrom` 让信用回流到上游，静态引用排行榜就是数
「有多少模板从你这儿衍生」。从社区档晋升到旗舰档，是维护者在公开 issue 上的决定 ——
标准见 [`GOVERNANCE.md`](../../GOVERNANCE.md)。
