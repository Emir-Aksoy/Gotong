# v5 · Stream F — 控制面历史趋势 + 告警阈值（E5 day-2 收口）小结

> 状态: **F 完**（M1 identity v24 `peer_summary_snapshots` 表 + Store;M2 host 快照捕获 +
> 保留 + 趋势查询;M3 web `GET /api/admin/peer-summaries/history` 路由;M4 告警规则底座
> identity v25 + 纯求值器;M5 host 告警 surface + web 规则 CRUD/告警路由;M6 admin UI 趋势
> sparkline + 告警配置/徽章 + 重建;M7 双 hub E2E 验收门 + 本文档）。
>
> 接 [`V5-E5-FINAL.md`](V5-E5-FINAL.md)（控制面 point-in-time 聚合）。E5 文档 §十明确把
> 「控制面历史趋势 + 告警阈值」列为 day-2 sanctioned 后续——Stream F 就是把它做实。
>
> Last updated: 2026-06-04

---

## 一、为什么做（E5 留的 day-2 缺口 + 北极星红线）

E5 的控制面是 **point-in-time** 的: 一个 hub 向某条已连接 link 的 peer 要一份隐私安全的
**计数快照**（`peer.summary` RPC, opt-in + fail-closed），聚合成「此刻各 hub 健康」的一张表。
in-mem 缓存**重启即丢, 这是设计**——「未刷新前 unknown」比「端上重启前的陈旧谎言」诚实。

但运维真正要的是两件 point-in-time 给不了的事:

1. **趋势**: 这个 hub 的挂起任务/LLM 成本/run 数, 是在涨还是在跌? 一张当下数字看不出方向。
2. **告警**: 我不想盯着看——某个计数越线时主动告诉我。

Stream F 把这两件事**叠在 E5 之上**, 严守同一条北极星红线:

> 北极星 §一: **Hub 网络是自由图, 不是层级树**。控制面**只观察, 不接管**(observe, never own)。

所以 Stream F 的两条铁律(从 E5 继承, 一寸不让):

- **只存计数, 永不存原始行**。历史快照存的就是 E5 那份 counts-only 的 `PeerSummary` blob,
  只是钉上时间戳落了盘——多一个字段都没有(形状本身没地方放名字/id/payload)。
- **告警是「此刻」的事实, 不持久化触发记录**(MVP)。规则求值是 live 的, 每次请求按当前摘要
  重算。存的是**规则**(阈值配置), 不是 firings。

> 一句话: E5 是望远镜的「当下一瞥」, Stream F 给它加上「时间轴回放」+「越线时拍你肩膀」——
> 但镜头里永远只有计数, 望远镜永远不变成缰绳。

**显式推迟**(见 §九): 告警通知投递(webhook/email/IM)、触发历史持久化、跨 hub 告警聚合、
快照采样/降采样策略、趋势预测。

---

## 二、F-M1 — identity v24 `peer_summary_snapshots` 表 + Store

历史的存储后端。一张**只追加**的快照表, 与 `usage_ledger` / `audit_log` 同构(append-only,
无 FK——删 peer 行仍留历史):

- `schema.ts` 迁移 **v24**: `peer_summary_snapshots(id INTEGER PK AUTOINCREMENT, captured_at,
  source, summary_json)` + 索引 `idx_pss_source_captured (source, captured_at)`。版本常量→24。
- 新 `peer-summary-snapshot-store.ts`: `append(input)` / `list(query)` / `prune({before})`。
  - `source` = `'local'` | peer id（同 E5 的 source 键约定）。
  - `summary_json` 是 **opaque blob**——identity 只校验它是非空字符串, **从不 parse**（哪些
    指标存在是 host 的事, identity 保持 domain-agnostic）。
  - `list` 走半开窗 `[since, until)`, 结果 `captured_at ASC`（趋势从左到右读）, clamp 到
    `PEER_SUMMARY_SNAPSHOT_MAX_LIMIT=10_000`。
  - `prune` 是保留策略原语（host 默认不调——默认全量保留, 见 F-M2）。
- 类型 `PeerSummarySnapshot` / `AppendPeerSummarySnapshotInput` / `PeerSummarySnapshotQuery`。

**为什么 append-only 无 FK**: 跟账本同理——历史是观测层, billing/forensics 要的是「即使
peer 被删, 它过去的足迹仍在」。

---

## 三、F-M2 — host 快照捕获 + 趋势查询（`peer-summary-metrics.ts`）

两件事: 谁来落快照, 怎么从快照算趋势。

### 3.1 指标注册表 = 趋势/告警的单一真相源

新 `packages/host/src/peer-summary-metrics.ts`: `PEER_SUMMARY_METRICS` 一张 dotted-key →
extractor 的表（9 个标量计数）:

```
assets.agents / assets.workflows / assets.publishedWorkflows / assets.peers
runs.total
llm.calls / llm.tokens / llm.costMicros
health.suspendedTasks
```

`runs.byStatus`(动态 map) 和 `llm.windowDays`(配置常量非测量) **故意不是指标**——只有定长
标量计数能 trend/alert。**趋势投影(F-M2)和告警求值器(F-M4)读的是同一张表**, 所以「能画的指标
就是能告警的指标」, 两个特性的可测维度永不漂移。

- `projectPeerSummaryMetric(summary, key)`: 未知 key / 非有限值 → `undefined`(调用方跳过该点,
  不画一个洞), **从不抛**。
- `buildPeerSummaryTrend(snapshots, metricKey)`: 逐快照 parse + project, 损坏 blob / 缺字段 →
  丢该点(best-effort——控制面趋势不能因一条坏行炸掉)。

### 3.2 捕获接到 `refresh`

E5 的 `createPeerSummaryFederation` 加可选 `snapshots?: PeerSummarySnapshotSink`(鸭子, host
用 `IdentityStore` 满足):

- 每次 `refresh`: 对每个**成功拉到摘要的 peer** capture 一次 + **本 hub local 总 capture 一次**
  (local 不需网络, 是最有用的趋势)。
- capture 是 **best-effort**: 快照 store 打嗝绝不能弄垮一次用户发起的 refresh——包 try/catch +
  log, 不抛。
- `history(query)`: 无 `snapshots` 接线 → `[]`（point-in-time only, 即 E5 行为）；有 → 读快照过
  `buildPeerSummaryTrend`。

---

## 四、F-M3 — web `GET /api/admin/peer-summaries/history` 路由

web 鸭子层(零 host dep, 镜像 host 形状):

- `PeerSummaryFederationSurface` 加 `history(query)` + `metricKeys()`。
- `GET /api/admin/peer-summaries/history?source=&metric=&since=&until=&limit=` → `{source,
  metric, points:[{capturedAt,value}], metrics: metricKeys()}`。
  - `source` + `metric` 必填(缺→400)；`since`/`until`/`limit` 可选非负整数(非法→400)。
  - 顺带回 `metrics`(规范指标键列表), 让 UI 下拉单一真相源还是 host。
- requireAdmin(owner 闸) + 503-when-unwired(镜像 E5 的 list/refresh)。

---

## 五、F-M4 — 告警规则底座（identity v25）+ 纯求值器

### 5.1 identity v25 `peer_summary_alert_rules` 表

- `schema.ts` 迁移 **v25**: `peer_summary_alert_rules(id PK, source, metric, comparator,
  threshold REAL, label, enabled, created_at, updated_at)` + 索引 `idx_psar_source_metric`。
- 新 `peer-summary-alert-rule-store.ts`: `add` 生成 `asr_<hex>` id（规则无自然身份）, `enabled`
  默认 true, UNIQUE 撞 → `alert_rule_exists`；`get`/`list`/`update`/`remove`。
  - **决策: identity 只校验通用结构位**(comparator 枚举 / threshold 有限数), `metric`/`source`
    保持 **opaque 字符串**——哪些指标存在是 host 的事(同 §3.1 的 domain-agnostic 立场)。
  - **threshold 是 REAL 列**(规则可能盯一个分数边界)。
  - **list 排序 `created_at ASC, rowid ASC`**: 同毫秒插入的两行靠 SQLite 单调 rowid(插入序)
    tiebreak, **不靠随机 `asr_<hex>` id** 排（否则同毫秒两规则会按 hex 乱序）。
- `IdentityErrorCode` 加 `alert_rule_exists` / `alert_rule_not_found`。

### 5.2 纯求值器 `peer-summary-alerts.ts`

`evaluatePeerSummaryAlerts(sources, rules): PeerSummaryAlertBreach[]`——纯函数, 无 I/O 无时钟
无持久化:

- 跳过 disabled 规则；`source==='*'`(`SOURCE_ANY`) 对所有 source 求值, 否则按 source 过滤。
- `projectPeerSummaryMetric` 返 undefined → 跳过该 source(永不抛——控制面检查不能因一条怪读数炸)。
- breach 携带 **ACTUAL source**(永不 `'*'`) + 投影出的 value——`'*'` 是规则的通配, breach 报的
  是它真正在哪条 source 上触发的。

**「此刻」语义**: MVP 不存 breach 历史。一次触发是关于 NOW 的事实, 每次请求按当前摘要重算。

---

## 六、F-M5 — host 告警 surface + web 规则 CRUD/告警路由

把 F-M4 的底座接到 E5 的 federation surface 上(扩现有 surface 而非新建——更轻的接线, 一个
web 注入点 `ctx.peerSummaries`)。

- `peer-summary.ts`: `PeerSummaryFederation` 加 `listAlertRules` / `addAlertRule` /
  `updateAlertRule` / `removeAlertRule` / `evaluateAlerts(): Promise<Breach[]>`；
  可选 `alertRules?: PeerSummaryAlertRuleSink`(鸭子, IdentityStore 满足)。
  - `evaluateAlerts` 建 live source 集: 本 hub **新鲜 build 的 local** + 每个 peer 的
    **last-cached 摘要**(告警按 last-known reading 触发——`stale` 标志是 UI 诚实信号, 不是跳过
    理由)。未接 `alertRules` → list/evaluate 返 `[]`, add/update 抛 `alert rules not enabled`。
- `main.ts`: `createPeerSummaryFederation({snapshots: identity, alertRules: identity})`(两个
  鸭子都用同一个 IdentityStore 满足)。
- web `peer-summary-routes.ts` 加告警路由:
  - `GET /api/admin/peer-summary-alerts` → `{alerts: 实时 breaches, rules, metrics}`(一次读
    给 UI 渲染整个面板要的全部)。
  - `POST /api/admin/peer-summary-alerts/rules` → 201 `{rule}`。
  - `PATCH /api/admin/peer-summary-alerts/rules/:id` → `{rule}`。
  - `DELETE /api/admin/peer-summary-alerts/rules/:id` → `{ok}` / 404。
  - typed `.code` → HTTP(`alert_rule_exists` 409 / `alert_rule_not_found` 404 / `invalid_input`
    400), 镜像 a2a-admin-routes 先例。

---

## 七、F-M6 — admin UI 趋势 sparkline + 告警配置/徽章（`4d8ad42`）

扩 E5-M4 的「控制面」面板(`static/peer-summary-ui.js`), 加三段(都读 F 的 host/route 侧已做好
的数据):

- **告警徽章**: `GET .../peer-summary-alerts` 的 `alerts` 渲染成红色 breach 徽章列表(无触发→
  绿色「✓ 当前没有触发的告警」)。
- **趋势 sparkline**: source 下拉(本 hub | 各 peer) × metric 下拉(9 个键) → `GET
  .../history` → **内联 SVG polyline**(无图表库依赖) + 最新/最小/最大标注。单点画一个点, 平
  序列画中线。
- **告警规则配置**: 一张 CRUD 表(source/metric/comparator/threshold/label 添加 + 启停 toggle +
  删除)。`'*'`(任意来源)只在规则下拉出现(history 是单 source)。

**两个收尾**: ① 该面板此前**没有自己的 CSS scope**(E5-M4 借了 `pf-*`, 而那是 scope 到
`.peer-federation-panel` 的)——补一段聚焦的 `.peer-summary-panel` block, 让既有聚合表 + 新趋势/
告警段一起渲染连贯。② metric 标签镜像 host registry(`peer-summary-metrics.ts`), host 仍是校验
权威。硬编码中文, 跟 sibling 联邦面板(`peer-admin-ui.js` 等)一致(无 i18n 字典——同既有约定)。
静态资产重建(`build:assets` → `static/admin.js` + `src/static-assets.ts`)。

---

## 八、F-M7 — 双 hub E2E 验收门（`stream-f-control-plane-e2e.test.ts`）

照 E5-M5 验收门的真栈形状(ONE 真 provider Hub + 真 identity store 种真足迹, 消费侧走真聚合
surface 过真 in-proc HubLink), 但消费侧的历史 + 规则存储接**真 IdentityStore**(消费者自己的——
provider 的 store 是另一个 hub 的)。三件事一次证清:

1. **趋势**: 两次 refresh 产两个**按时间排序**的历史点; provider 真足迹变化(中途加一个 agent)
   时趋势反映 2 → 3; **本 hub local 每次也捕获**; 未知 metric 返 `[]` 不抛。
2. **告警**: 规则对当前摘要 **live 求值**——breaching 规则在 **ACTUAL source** 触发(永不 `'*'`),
   non-breaching 规则静默, disabled 规则停火, 规则 CRUD 经 surface 落到消费者 store。
3. **no-leak**: 持久化的快照 blob **和** breach payload 只携计数——provider 的 agent id /
   capability / parked task id / model 名一个都不出现(F 路径继承 E5 的 counts-only 形状, 在
   **持久化路径**上再钉一遍)。

`+3 测试`(host 696→699 绿)。

---

## 九、测试矩阵 + 显式推迟

### 9.1 测试矩阵

| 包 | F 新增测试 | 覆盖 |
|---|---|---|
| identity | snapshot-store + alert-rule-store + 迁移 v24/v25 | append-only 历史、规则 CRUD、comparator/threshold 校验、rowid tiebreak |
| host | `peer-summary-metrics` 纯函数 + `peer-summary-alerts` 求值器 + `peer-summary.test.ts` 扩 + **F-M7 E2E ×3** | 指标投影/趋势构建、告警求值(disabled/`*`/skip)、surface CRUD/evaluate 接线、真栈双 hub |
| web | `peer-summary-routes.test.ts` 扩(history + alerts CRUD) | 路由形状、400/404/409/503、coerce 校验 |

host 全量 **699 passed / 1 skipped**, web 全量 **806 passed**, 零回归。

### 9.2 显式推迟

- **告警通知投递**(webhook / email / IM bridge): 当前只在 admin UI 展示 live breaches, 不主动
  推送。是 day-3。
- **触发历史持久化**: MVP 告警是「此刻」, 不存 firings。要趋势化告警(「这条规则本周触发 5 次」)
  需另起一张表。
- **跨 hub 告警聚合 / 中央告警面板**: 控制面只观察, 每个 hub 自管自己的规则。
- **快照采样 / 降采样 / 自动保留窗**: `prune` 原语已在(F-M1), 但 host 默认不调(全量保留)。生产
  化时再接一个定时 prune + 保留窗配置。
- **趋势预测 / 异常检测**: sparkline 是裸 polyline, 不做平滑/预测。

---

## 十、北极星对账

| 红线 | Stream F 怎么守 |
|---|---|
| 自由图非层级树 | 控制面只读各 hub **自愿共享**(E5 `share_summary` opt-in)的计数; F 只是给这份计数加时间轴 + 阈值, 不新增任何拉取权。 |
| 只观察不接管 | 趋势是回放、告警是拍肩——都不向任何 hub 下指令。规则存在**观察者本地**(消费者 store), 不下发到 peer。 |
| 计数即隐私契约 | 历史快照 = E5 那份 counts-only blob 钉时间戳; F-M7 no-leak 门在**持久化路径**上再证一遍(agent id/model/task id 不入库)。 |
| 框架不存知识/不跑 LLM | F 只读已聚合的计数 + 存阈值规则; 无 LLM, 无原始数据, 无知识。 |
| 节点尽量轻量 | 告警接现有 federation surface(不新建 surface); 求值器是纯函数; sparkline 是内联 SVG(无图表库); UI 复用 E5 面板。 |

---

## 十一、文件地图（Stream F 动了什么）

```
packages/identity/src/
  schema.ts                          迁移 v24(snapshots) + v25(alert_rules)
  peer-summary-snapshot-store.ts     [新] append-only 历史 store
  peer-summary-alert-rule-store.ts   [新] 规则 CRUD store (asr_<hex> id, rowid tiebreak)
  types.ts / store.ts / index.ts     类型 + 委托 + 导出
  errors.ts                          + alert_rule_exists / alert_rule_not_found

packages/host/src/
  peer-summary-metrics.ts            [新] 指标注册表 + projectMetric + buildTrend
  peer-summary-alerts.ts             [新] 纯求值器 evaluatePeerSummaryAlerts
  peer-summary.ts                    + snapshots/alertRules sink + history/metricKeys/alert 方法
  main.ts                            createPeerSummaryFederation({snapshots, alertRules})

packages/web/src/
  peer-summary-routes.ts             + history 路由 + 告警 CRUD/evaluate 路由
  server.ts                          dispatch 接线

packages/web/static/
  peer-summary-ui.js                 + 趋势 sparkline + 告警徽章 + 规则配置(F-M6)
  styles.css                         + .peer-summary-panel scope
  admin.js / ...                     (经 build:assets 重建)

packages/host/tests/
  stream-f-control-plane-e2e.test.ts [新] 双 hub 验收门 (趋势 + 告警 + no-leak)

docs/zh/V5-F-FINAL.md                [新] 本文档
```
