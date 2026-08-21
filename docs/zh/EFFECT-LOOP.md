# 效果回路（EFF）——可用率随模型档的曲线，与生产里的三个效果信号

> Status: **M0 计划落档（2026-08-20）**。方向 A「LLM 自适应」的证据端，
> [`STRATEGY-2026-08.md`](STRATEGY-2026-08.md) §十 行动序第 1 项。
> 先有证据端，再谈调节——§五 HAL 教训（21/36 例调高推理反降分）在此执法。

---

## 一、为什么（口径）

**不立标准，不测分数。** 榜单成绩深受任务难度与所调 LLM 影响，是别人家的温度计。
效果回路是自己的恒温器：一套内部反馈回路，回答两个只有我们自己能回答的问题——

1. **同一副骨架，接不同档的模型，可用率曲线长什么样？**（golden-run × 模型档矩阵）
   `acceptance[]` 的题已在生产里——七个模板 11 条黄金验收用例就是真实工作流的真实断言，
   不用造题。矩阵量的不是「哪个模型强」，是「**骨架在每一档补位补得够不够**」：曲线平 =
   骨架把档位差扛住了；曲线陡 = 补位件（笔记本/复述/拆步/预算/转派）还有活可干。
2. **生产里成员的真实体验在变好还是变坏？**（三个效果信号的零 LLM 投影）
   返工率（显式打回）、park 被拒率、转派率——全部从既有落盘数据折出来，不新开采集面。

数字**只与自己比**（棘轮/趋势，MU-M1 先例：地板只升，永不为过而降），绝不搬绝对分与
别家对比。

## 二、侦察事实（2026-08-20，全部一手 file:line）

### 2.1 golden-run 机制已完整，缺的只是「换刀」与「留痕」

- `acceptance[]` 解析：`packages/web/src/template-manifest.ts:684-738`；条目形状
  `packages/host/src/template-acceptance.ts:64-75`（`id` / `workflowId` 必须是本模板自带 /
  `trigger` 字段袋 / `assert.{sections,contains,forbid,maxBytes}` 至少一条真断言）。
- 执行器：`createTemplateAcceptanceService.run()` → `runCase()`
  （`template-acceptance.ts:168-276`）——走成员闸 `evaluateRunnable`、payload 只取
  `inputFieldIds` 声明字段并强制 `userScopeField`、`hub.dispatch` 与 120s 竞速、
  `checkStructure` 零 LLM 判定（`packages/evals/src/checkers/structure.ts:59`）、用例串行。
- 三条触发入口全在：HTTP `POST /api/admin/templates/acceptance/:pack/run`
  （`packages/web/src/template-acceptance-routes.ts:29-30`）、`gotong provision` 装完自动跑
  （`packages/cli/src/commands/provision.ts:243`，纯 HTTP 客户端 `--url --token`）、模板导入
  时记录意图（`packages/web/src/agents-routes.ts:1086-1089`）。
- 存量题库：7 个模板 11 条用例（morning-brief 1 / family 1 / agri 1 / solo 2 / pro-firm 2 /
  cafe 2 / bar 2，全在 `examples/*/template/*.template.yaml`），断言套路一致=「开箱诚实模式
  必须绿 + forbid 推诿话术」。
- **空洞①**：`AcceptanceRunReport` 只走 HTTP 返回不落盘（`template-acceptance.ts:99-106`），
  `<space>/template-acceptance.json` 只存意图——没有历史、没有趋势。

### 2.2 换模型档的杠杆在 spec 级，per-task 杠杆到不了验收路径

- 模型字段全家：`packages/core/src/space.ts:1166-1255`（`provider/model/baseURL/apiKeyEnv/
  fallbacks/maintenanceModel/thinking`）。
- per-task 覆盖机制存在（`LlmTaskPayload.model`，`packages/llm/src/agent.ts:511`）但验收
  执行器的 payload 只取 `inputFieldIds` 声明字段——**`model` 键结构性进不了验收派发**。
  这是对的：验收量的是「这台 hub 现在这套配置」的真相，不该被调用方悄悄换刀。
- 故矩阵换刀 = **spec 级、走既有 capture-echo 路**：`GET /:id/export` → 改 model/provider/
  apiKeyEnv → `PUT`（LSA-M6/MR-M6 建好的全字段 echo 纪律，`packages/web/src/agents-routes.ts:315`），
  换完 spawn 即生效。矩阵 runner 对每档都这么换，执行仍走同一条验收链——零第二执行器。

### 2.3 三个效果信号的既有数据源

- **park 决定**（最干净）：inbox item 文件 resolve 后原地改写不删
  （`packages/inbox/src/file-inbox-store.ts:204-216`，`decision.approved` / `history[]`），
  且 `inbox_resolve` 审计行已在（`packages/host/src/inbox-service.ts:238-262`，
  `metadata.outcome` + `actorSource 'im'|'v4-session'` + `metadata.via`）。两处可互证。
- **显式返工**：`InboxDecision.changesRequested`（`packages/inbox/src/types.ts:58-65`）=
  成员显式打回，是最干净的返工信号。隐式「N 分钟内重问同一件事」的原文数据在 episodic
  （`<space>/butler/memory/user/<id>/episodic.jsonl`，`packages/personal-memory/src/capture.ts`）
  ——但判定要文本相似度，v1 显式不做（见 §六）。
- **转派**：**空洞②**——`escalate_to_expert` 执行时唯一落盘痕迹是 transcript 一条
  `转派专家「…」` 标题 task（`packages/host/src/personal-butler-escalate.ts:113-120`），
  没有结构化字段可切；usage_ledger 按 `agent_id` 切分不清「转派」与「工作流正常派发」。
- **用量分母**：`aggregateLedger` 可按 `user/agent/workflow/model/day/peer` 切
  （`packages/identity/src/ledger-store.ts:192-234`、`packages/web/src/usage-routes.ts:62-70`）。

### 2.4 可抄的形状

- 棘轮门先例（MU-M1）：`packages/personal-memory/tests/memory-recall-bench.test.ts`
  ——常量地板 + `toBeGreaterThanOrEqual` + 「永不为过而降」纪律写在文件头。
- 零 LLM 投影先例：`packages/host/src/me-panel-data.ts`（三态合同 =
  未接线 null / 接了没数据 [] / 有数据 rows；探针抛错折 [] + warn 绝不 500；披露论证逐源
  写文件头）。
- 双进程真 hub 驱动先例：`scripts/test-cross-hub-e2e.mjs`（XHT——spawn 真 `host/dist/main.js`
  + fresh space + HTTP 驱动 + mock provider 确定性回复）。

## 三、设计

### 3.1 半边一：golden-run × 模型档矩阵（`scripts/effect-matrix.mjs`）

一个 scripts 层 runner，对「档位表 × 模板包」逐格跑：

```
for 每档 tier（来自档位表文件）:
  fresh space → spawn 真 host → 导入模板包
  → 对包内每个 managed agent: export → 换 tier 的 provider/model/apiKeyEnv → PUT（echo 全字段）
  → POST acceptance run → 收 AcceptanceRunReport
→ 汇总成一张「用例 × 档位 → 绿/红 + 违规类型」矩阵，写 JSON + Markdown 报告
```

- **档位表是输入文件不是代码**（如 `{tier: 'weak', provider: 'openai-compatible',
  model: 'xxx', apiKeyEnv: 'XXX_API_KEY'}[]`），key 值永远走 env 名，报告里零 key 字节。
- **mock 档常绿门**：档位表含 `provider:'mock'` 一档时全链零网络零 key 可跑——这档进 CI
  （证 runner 本身不腐），真档烧钱=用户门。
- 报告落 runner 参数指定的输出路径（默认 scratch），**不进 `<space>`、不进 git**；结论性
  的曲线快照人工摘进本文档或 releases/。
- 空洞①（验收结果生产落盘历史）**不在本刀**：矩阵 runner 自己收 HTTP 返回即可；生产 hub
  的验收趋势台账等真实需求（§六）。

### 3.2 半边二：生产效果信号（M2 事实层 + M3 投影层）

- **M2 转派事实行**（补空洞②）：`personal-butler-escalate.ts` 唯一咽喉处 append 一行
  `<space>/butler/escalate/<userId>.jsonl`（`{at, expert, ok}`；outbox/sessions 同族
  per-user 布局），fire-and-forget——append 失败 warn 绝不连累转派本身。park 决定与显式
  返工**零新落盘**（2.3 已有）。
- **M3 效果信号投影**：me-panel-data 形状新投影（三态合同同款），窗口期（30 天）内：
  park 批准/拒绝/打回计数、转派行数、以 usage calls 为分母的比率。落点 = admin 体检面板
  一张卡为主；阿同 `my_status` 扩行与否 M3 开工时按 token 预算与六行合同定。
- 判定全确定性零 LLM；投影披露 ⊆ 既有面（inbox/audit/usage 全是 admin 已见数据）。

## 四、里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 本篇计划落档 | 文档 + 导航钩 |
| M1 ✅ | `scripts/effect-matrix.mjs` + `pnpm effect:matrix`；mock 档全链 CI 门（`pnpm check:effect-matrix`） | 已落：mock 档零 key 跑绿；换刀走 cli 真件 `buildPutBody`（export→PUT echo 纪律免复刻）+ 换刀后 export 复核 provider；冒烟包死端点设计使「绿=换刀的证据」；两道变异（摘换刀/粉饰红判定）各红在该红断言上 |
| M2 ✅ | 转派事实行（host 层：escalate 咽喉 + factory 接 `<space>/butler/escalate`——memory 兄弟目录，presence/prefs 同款落位理由） | 已落：5 单测（append 形状含 pre-flight 失败臂 / 失败 warn 不连累转派 / 缺席零 fs / 敌意 id 穿不出**沙箱套层才看得见**）；两道变异各红在该红例；host 3160 + 全仓 typecheck 净 |
| M3 | 效果信号零 LLM 投影 + admin 面板卡 | 三态合同测试；真机 round-trip |
| M4 | 首次真档矩阵报告（**用户门**：用户给档位表与 key） | 曲线快照记档，指出补位件的下一刀 |

## 五、边界（不可破）

1. **不立标准不追榜**——数字只与自己比（棘轮/趋势），报告不搬绝对分对外排名。
2. **零内核改动、零新旋钮（116 冻结）**——runner 在 scripts/，事实行在 host 层，投影骑
   既有 surface；档位表是 runner 的输入文件不是 env。
3. **热路径零 LLM**——信号采集是 append 纯事实，判定是确定性扫描；矩阵的 LLM 调用只发生
   在显式跑矩阵那一刻。
4. **真档烧钱=用户门**——CI 只跑 mock 档；真模型矩阵只在用户令下执行。
5. **治理不随档松、矩阵只量不调**——任何「按档自动调节骨架」等证据端出数后另起
   RES 扩展刀（§十 行动序第 3 项），本 track 不预支。

## 六、显式不做 / 推迟

- **自动调节回路**——等 M1-M4 出数（先证据端后调节）。
- **文本相似的隐式返工判定**——判定质量存疑且有滑向 LLM 判卷的坡；v1 只认显式信号
  （`changesRequested`）。
- **生产 hub 验收结果落盘历史**（空洞①的生产侧）——等真实趋势需求，不预造台账。
- **对外发布任何榜单/对比**。

## 相关文档

[`STRATEGY-2026-08.md`](STRATEGY-2026-08.md) §十 · [`FORWARD-DEPLOY.md`](FORWARD-DEPLOY.md)
（acceptance 出处）· [`MEMORY-UPGRADE.md`](MEMORY-UPGRADE.md)（棘轮先例）·
[`MODEL-ROUTING.md`](MODEL-ROUTING.md)（可用性自适应，与本篇的质量自适应互补）
