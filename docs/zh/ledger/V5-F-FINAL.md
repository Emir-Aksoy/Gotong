# v5 · Stream F — 控制面历史趋势 + 告警阈值（E5 day-2 收口）小结

> 状态: **F 完**（M1 identity v24 `peer_summary_snapshots` 表 + Store;M2 host 快照捕获 +
> 保留 + 趋势查询;M3 web `GET /api/admin/peer-summaries/history` 路由;M4 告警规则底座
> identity v25 + 纯求值器;M5 host 告警 surface + web 规则 CRUD/告警路由;M6 admin UI 趋势
> sparkline + 告警配置/徽章 + 重建;M7 双 hub E2E 验收门 + 本文档）。
>
> **day-3 完**（告警通知投递 + 触发历史持久化, 见 §十二）: M1 identity v28
> `peer_summary_alert_firings`（open→resolve 边沿触发, 部分唯一索引把「一对 rule+source 至多
> 一条未解决」钉进 schema）;M2 identity v29 `peer_summary_alert_channels`（无密钥行, `headerEnv`
> 存环境变量名）;M3 host `peer-summary-alert-delivery.ts` 纯模块（differ + webhook dispatcher,
> 可注入 fetch）;M4 surface `evaluateAndDeliver` + opt-in sweep;M5 web firing 历史/channel
> CRUD/test-delivery 路由;M6 admin UI 触发历史 + 通知渠道面板;M7 双 hub 投递验收门。
>
> **多通道完**（im / email + 重试·退避·去重窗, 见 §十三）: MC-M1~M7。
>
> **跨 hub 告警聚合完**（见 §十四）: AGG-M1~M5——把告警状态折进 counts-only 摘要的
> `alerts.openFirings` 计数族, 联邦聚合 + 趋势 + 元告警从既有摘要管线**免费**掉出, 零新 schema。
>
> 接 [`V5-E5-FINAL.md`](./V5-E5-FINAL.md)（控制面 point-in-time 聚合）。E5 文档 §十明确把
> 「控制面历史趋势 + 告警阈值」列为 day-2 sanctioned 后续——Stream F 就是把它做实。
>
> Last updated: 2026-06-07

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
  重算。存的是**规则**(阈值配置), 不是 firings。〔**day-3 更新**: firings 现在持久化了——但只作为
  open→resolve 的**边沿触发记账**(让每个 breach 只通知一次), 仍是 counts-only, 见 §十二。〕

> 一句话: E5 是望远镜的「当下一瞥」, Stream F 给它加上「时间轴回放」+「越线时拍你肩膀」——
> 但镜头里永远只有计数, 望远镜永远不变成缰绳。

**显式推迟**(day-1/2 时, 见 §九): 告警通知投递(webhook/email/IM)、触发历史持久化、跨 hub
告警聚合、快照采样/降采样策略、趋势预测。其中**告警通知投递(webhook) + 触发历史持久化已在
day-3 做实**(见 §十二), 余下仍推迟。

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

- **告警通知投递**(webhook / email / IM bridge): ✅ **day-3 已做**(webhook kind; email/IM kind 仍
  推迟)——admin UI 之外现在能主动 POST。见 §十二。
- **触发历史持久化**: ✅ **day-3 已做**——`peer_summary_alert_firings`(identity v28)存 open→resolve
  生命周期, 边沿触发让每个 breach 只通知一次。趋势化告警(「这条规则本周触发 N 次」)的聚合查询仍可后续叠。
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
  schema.ts                            迁移 v24(snapshots)+v25(rules) | day-3: v28(firings)+v29(channels)
  peer-summary-snapshot-store.ts       [新] append-only 历史 store
  peer-summary-alert-rule-store.ts     [新] 规则 CRUD store (asr_<hex> id, rowid tiebreak)
  peer-summary-alert-firing-store.ts   [新, day-3] open→resolve 生命周期 (部分唯一索引钉边沿不变量)
  peer-summary-alert-channel-store.ts  [新, day-3] 投递通道 (无密钥行, headerEnv = 环境变量名)
  types.ts / store.ts / index.ts       类型 + 委托 + 导出
  errors.ts                            + alert_rule_*  | day-3: alert_firing_*/alert_channel_*

packages/host/src/
  peer-summary-metrics.ts              [新] 指标注册表 + projectMetric + buildTrend
  peer-summary-alerts.ts               [新] 纯求值器 evaluatePeerSummaryAlerts
  peer-summary-alert-delivery.ts       [新, day-3] differ diffAlertFirings + webhook dispatcher (可注入 fetch, best-effort)
  peer-summary.ts                      + snapshots/alertRules sink + history/alert 方法 | day-3: firings/channels sink + evaluateAndDeliver/testAlertChannel
  main.ts                              createPeerSummaryFederation({...}) | day-3: + opt-in alert sweep (GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS)

packages/web/src/
  peer-summary-routes.ts               + history 路由 + 告警 CRUD/evaluate | day-3: + firing 历史 GET + channel CRUD + test-delivery POST
  server.ts                            dispatch 接线 + day-3 类型 re-export

packages/web/static/
  peer-summary-ui.js                   + 趋势 sparkline + 告警徽章 + 规则配置(F-M6) | day-3: + 触发历史表 + 通知渠道面板
  styles.css                           + .peer-summary-panel scope | day-3: + ps-firing-open / ps-channels
  admin.js / static-assets.ts          (经 build:assets 重建)

packages/host/tests/
  stream-f-control-plane-e2e.test.ts     [新] 双 hub 验收门 (趋势 + 告警 + no-leak)
  peer-summary-alert-delivery.test.ts    [新, day-3] 纯 differ + dispatcher 单测
  peer-summary-alert-delivery-e2e.test.ts[新, day-3] 双 hub 投递验收门 (open/幂等/resolve + best-effort + no-leak)

docs/zh/ledger/V5-F-FINAL.md                  [新] 本文档 (含 §十二 day-3)
```

---

## 十二、day-3 — 告警通知投递 + 触发历史持久化（`90f167a`→`94d16e3`）

> 状态: **完**（M1-M8）。E5 day-2 §一 把这两件事列为显式推迟; day-3 把它们做实, 仍严守
> counts-only + 只观察不接管。

### 12.1 为什么（day-1/2 只能「看」, day-3 能「拍肩 + 送信」）

F-M1~M7 的告警是 **point-in-time**: admin UI 打开时按当前摘要 live 求值, 把越线的规则标红。
但运维不会一直盯着屏幕——越线时得**主动**通知, 且**只通知一次**(不是每次求值都吵)。这要两样
point-in-time 给不了的东西:

1. **触发历史**: 一个 breach 从「开」到「解决」是一段**有状态**的生命周期, 不是一次快照。记下来
   才能边沿触发(只在「开」的那一刻通知一次, 在「解决」的那一刻再通知一次)。
2. **投递通道**: 把 firing POST 到一个 webhook。

> 一句话: day-1/2 是控制面**显示**越线, day-3 是控制面**送信**——但送出去的信仍只装计数。

### 12.2 M1/M2 — 两张 append-only 表（identity v28 / v29）

- **`peer_summary_alert_firings`（v28）**: 一条 breach 的 open→resolve 生命周期。**部分唯一索引**
  `(rule_id, source) WHERE resolved_at IS NULL` 把「一对(规则, 源)至多一条未解决 firing」钉进
  **schema**——边沿触发的不变量在数据库层, 不只靠调用方自觉。无 FK(同 ledger/audit), 删规则不删
  历史。`open` / `listOpen` / `list(query)` / `resolve` 原语。
- **`peer_summary_alert_channels`（v29）**: 投递目的地。**行里没有密钥**——`headerEnv` 存的是一个
  **环境变量名**(不是 bearer), host 在投递时现读现用(镜像 `a2a_outbound_agents` v22 的无密钥模式;
  store 的 `normHeaderEnv` 用 `/^[A-Za-z_][A-Za-z0-9_]*$/` 拒掉粘贴进来的真 bearer)。`kind` 列可扩
  (`'webhook'` 起步, `'im'`/`'email'` 后续不用迁移)。

两张表都 IdentityStore **鸭子类型**给 host(精确方法名匹配, host↔identity 零依赖)。

### 12.3 M3 — `peer-summary-alert-delivery.ts` 纯模块（differ + dispatcher）

整条投递路径的「纯中段」, 全部纯函数或可注入:

- **`diffAlertFirings(breaches, openFirings) → {toOpen, toResolve}`**: 确定性集合差, 按
  `ruleId+source` 关联键。已被未解决 firing 覆盖的 breach 是**稳定态**(两列表都不进)——这正是「每个
  breach 只通知一次」的来源。求值器对每个(规则, 源)至多产一个 breach, 故 `toOpen` 永不撞唯一索引。
- **`renderWebhookPayload(firing, event)`**: counts-only 载荷(`type`/`event`/`firingId`/`ruleId`/
  `source`/`metric`/`comparator`/`threshold`/`value`/`label`/`openedAt`/`resolvedAt`)——**结构性**
  no-leak: 载荷只从 firing 构造, firing 本身只装数字/比较符/metric 键/源 id/规则自己的标签。
- **`deliverToChannel` / `deliverToEnabledChannels`**: 可注入 `fetchImpl`(镜像 windmill-participant),
  **best-effort 永不抛**——传输错/非 2xx/超时都收敛成 `{ok:false}` 结果, 一个死 webhook 拖不垮扫描
  也挡不住下一个 firing。`headerEnv` 在这里现读环境变量当 `Authorization` 头(密钥永不落库)。disabled
  通道在投递前就被过滤掉。

无任何 identity I/O 住这——M4 才把它接到 store。

### 12.4 M4 — surface `evaluateAndDeliver` + opt-in sweep

- **`evaluateAndDeliver()`**: 先求值(复用 `evaluateAlerts` 读的**同一份缓存摘要**)再持久化 + 投递。
  `diffAlertFirings` 的 `toOpen` 每条 `open` firing + POST `opened` 一次; `toResolve` 每条 `resolve`
  firing + POST `resolved` 一次。返回 `{opened, resolved, deliveries}` 报告。**没接 firing sink 时是
  no-op**(`evaluateAlerts` 仍能 live 显示)——投递是叠加层, 不接就退回 day-1/2 行为。
- **`testAlertChannel(id)`**: 给一个合成 `opened` 载荷, 让运维在**真 breach 之前**验证可达性——**连
  disabled 通道也送**(你在打开它之前先测)。
- **opt-in sweep**(`main.ts`): `GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS`(0/未设 = **关**, 默认关), 设正值时
  clamp 到 `[10s, 1h]`。每拍先 `refresh`(让摘要最新; 单 peer 刷新失败留旧读不中止)再 `evaluateAndDeliver`。
  重入守卫防慢拍叠加, `.unref()` 不挡进程退出。无通道配置时即便开了也送不出东西(诚实空转)。

### 12.5 M5/M6 — web 路由 + admin UI

- **web**(`peer-summary-routes.ts`): `GET …/alerts/firings`(历史, source/ruleId/state/窗口过滤) +
  channel CRUD(`GET/POST …/alerts/channels`, `PATCH/DELETE …/alerts/channels/:id`) +
  `POST …/alerts/channels/:id/test`。错误码 `alert_channel_exists:409` / `alert_channel_not_found:404`。
  鸭子 surface verbatim echo, web 零 host/identity 运行时依赖。
- **admin UI**(`peer-summary-ui.js`, 手写 IIFE 同 sibling 面板, 硬编码中文): **触发历史**表(来源/指标/
  条件/触发值/状态/开启/解决, 🔴 开启中 / 已解决徽章) + **通知渠道**子面板(类型/URL/鉴权环境变量/标签
  表单 + 测试/启用·停用/删除 + `$NAME` 渲染 headerEnv + sweep 环境变量诚实提示)。

### 12.6 M7 — 双 hub 投递验收门（`peer-summary-alert-delivery-e2e.test.ts`）

day-3 存在的理由那一个测: 真 provider Hub 经真 in-proc HubLink 给真消费控制面, 消费侧 firing/channel
接**真 IdentityStore**, webhook 传输是**注入的捕获 fetch**(整条路径无 socket)。四件事一次证清:

1. **生命周期**: provider 真足迹变化(第 3 个 agent 加入)把 `assets.agents` 推过阈值 →
   `evaluateAndDeliver` **开** firing + 投 `opened` 一次; 仍 breaching 时重求值**幂等**(无第二条 firing,
   无第二次 POST——边沿触发); agent 离开 → firing **解决** + 投 `resolved` 一次。历史经消费 store 持久。
2. **best-effort**: disabled 通道永不被 POST; failing 通道传输错收敛成 `ok:false` 而**不挡**另一个通道
   的投递, 也不挡 firing 持久化。
3. **test-delivery**: `testAlertChannel` 连 disabled 通道也送达, 且把 `headerEnv` 环境变量名在投递时
   解析进 `Authorization` 头(bearer 从没在行里待过)。
4. **no-leak**: 每个 webhook body 只携计数/id/比较符/规则标签——provider 的 agent id / capability /
   parked task id / model 名一个都不过线(继承 E5 counts-only, 在**离开 host 的线缆**上再钉一遍)。

`+3 测试`(host 798 + 1 skipped 绿, 零回归)。另 M3 纯模块 `peer-summary-alert-delivery.test.ts` +14
单测(differ 边沿/payload counts-only/dispatcher best-effort)。

### 12.7 北极星对账（day-3 增量）

| 红线 | day-3 怎么守 |
|---|---|
| 只观察不接管 | 投递是控制面给**自己的运维**送信(webhook 出向自家), **不**向任何 peer 下指令; firing/规则/通道全住观察者本地。 |
| 计数即隐私契约 | webhook 载荷结构性 counts-only(只从 firing 构造); M7 no-leak 门在**出向线缆**上再证一遍。 |
| 无密钥落库 | 通道 `headerEnv` 存环境变量名非 bearer; 密钥投递时现读, 数据库里永远没有。 |
| 节点尽量轻量 | differ/dispatcher 是纯函数 + 可注入 fetch; 接现有 federation surface(不新建); sweep 复用 refresh; UI 复用 E5 面板。 |

### 12.8 仍显式推迟（day-3 之后）

- ~~**email / IM bridge 通道 kind**~~ → **多通道 pass 做实**(§十三): `kind` 扩 `'im'`/`'email'`,
  im 走 telegram/slack/discord/lark 平台 send。
- ~~**投递重试 / 退避 / 去重窗**~~ → **多通道 pass 做实**(§十三): `RetryOptions` 指数退避 + 进程内去重窗。
- **跨 hub 告警聚合 / 中央告警面板**: 同 day-2——控制面只观察, 每个 hub 自管规则与投递。
- **触发历史降采样 / 自动保留窗**: firing 表 append-only, 无自动 prune(同快照表)。
- **告警分组 / 静默窗 / 升级链**(Alertmanager 式): MVP 一规则一通道一次性投递。

---

## 十三、多通道投递 — im / email + 重试·退避·去重窗（MC-M1→M7）

> 状态: **完**(MC-M1~M7)。§12.8 把 email/IM 通道 + 重试/去重列为 day-3 之后的推迟; 本 pass 做实,
> 仍严守 counts-only + 只观察不接管。

### 13.1 为什么 + 两个锁定决策

day-3 只把 firing POST 到 `webhook`。运维真实的「拍肩」面是**IM 群**(Telegram/Slack/Discord/Lark)
和**邮箱**——把通道 kind 从单一 webhook 扩成多平台, 才算把「送信」收口。两个**用户拍板**的决策定了形态:

1. **IM 投递 = 「无状态平台 send」**(不是 stateful bridge): 通道存 `{platform + target chatId + 环境变量名}`
   或一个 incoming-webhook URL; 投递走**现有可注入 `fetchImpl`** POST 到平台 send-API / webhook。
   复用每个平台「怎么发一行文字」的最小契约, **但不建任何有状态的 bridge 连接**——投递模块保持纯,
   host `main.ts` 改动极小, 与 webhook 投递**同构**(都是「构请求 → 注入 fetch POST → best-effort 结果」)。
2. **MVP 范围 = 「渐进: email + 主流 IM 先行」**: email(HTTP email API form) + Slack/Discord/Lark
   (incoming-webhook, 无 token) + Telegram(bot API + token)。**Matrix / QQ 推迟**(平台 renderer 闭集可扩, 不迁移)。

### 13.2 MC-M1 — identity v30: `kind` 扩 + `platform`/`target` 两列

- `PeerSummaryAlertChannelKind` 从 `'webhook'` 扩成 `'webhook' | 'im' | 'email'`; v30 **加性可空**两列
  `platform`(im 选择器, 闭集 `telegram/slack/discord/lark`) + `target`(im chat/room id 或 email 收件人)。
  webhook 行两列都留 NULL, **不重建表**。
- store 跨字段校验**按 EFFECTIVE kind**: im → `platform` 必需且 ∈ 闭集; email → `target`(收件人)必需;
  webhook → 两列都不该有。update 时 kind 变更会重新派生(im→webhook 把 platform 归 null)。
  **telegram 的 `target` 在 store 层不强制**(incoming-webhook 平台不需要), 但 delivery 时 `buildImRequest`
  无 target 返 null → best-effort 失败(故意: 缺配置宁可失败也不发垃圾)。

### 13.3 MC-M2 — host delivery 分支 + per-platform 纯 renderer

`buildDeliveryRequest(channel, payload, secret)` 按 `kind` 分流, 全部纯函数(counts-only 由构造保证):

- **webhook**: `{url: channel.url, headers:{...JSON, authorization?}, body: JSON(payload)}`(day-3 不变)。
- **im** → `buildImRequest(channel, renderAlertText(payload), secret)`:
  - **telegram**: token(secret, 从 env)进 **path** `${base}/bot${secret}/sendMessage`, body `{chat_id: target, text}`。
  - **slack**: incoming-webhook, `{text}` POST 到 `channel.url`(token 是 URL 的一部分)。
  - **discord**: `{content: text}`。
  - **lark**: `{msg_type:'text', content:{text}}`。
- **email** → `buildEmailRequest`: `{to: target, subject, text}` POST 到 HTTP email API(`channel.url`),
  可选 API key 走 `headerEnv` → `Authorization`。
- **`renderAlertText(payload)`**: im/email 的一行人类可读告警, **只**从 counts-only 载荷渲染
  (`[gotong] alert {firing|resolved}: {label (ruleId)|ruleId} — {metric} {comparator} {threshold} (observed {value}) on source {source}`)——
  跟 webhook JSON 同源, 同一份计数**按平台再编码**, 永不碰任何底层 peer 行。

> **密钥诚实**: telegram bot token / email API key 是真密钥, 走 `headerEnv`(环境变量名)→ 投递时现读 →
> path / `Authorization`, **永不落库**。slack/discord/lark 的「密钥」就是那个 incoming-webhook URL 本身
> (平台设计如此), 跟 day-3 的 `webhook` kind **同构**——存在 `channel.url` 列, 没有额外 bearer。

### 13.4 MC-M3 — 重试·退避 + 去重窗（主次分明）

- **`RetryOptions`**{maxAttempts(默认 1=单发)/baseDelayMs(500)/maxDelayMs(10s)/sleepImpl(可注入)}:
  `deliverToChannel` 只重试**失败**的 attempt(传输错/非 2xx/超时), 指数退避; 配置不足的通道立即返回不睡。
- **`DeliveryDeduper`**(`createDeliveryDeduper(windowMs)`, `windowMs<=0` 关): 进程内 Map,
  `deliveryDedupKey(channelId, firingId, event)` 为键, 抑制窗内**相同**(通道, firing, 事件)的重复投递
  (返 `skipped:true` 不 POST); **只有成功发送才记录**(失败的留着下一拍重试)。
- **主次关系(诚实)**: firing 生命周期(唯一未解决索引 + 边沿触发 differ)是**主** once-guarantee;
  去重窗是**次**防——挡 overlapping 手动+sweep 调用导致的双发。re-open 拿**新** firingId, 故去重永不压住真信号。
- **`main.ts` env 旋钮**(`ed4f87b`): `GOTONG_PEER_SUMMARY_ALERT_RETRY_ATTEMPTS`(clamp [1,6]) /
  `_RETRY_BASE_MS`([50,30k]) / `_DEDUP_MS`([0,1h]), 默认值让行为**字节不变**(单发 + 60s 去重窗)。

### 13.5 MC-M4/M5 — web DTO + admin UI 按 kind 出字段

- **web**(`peer-summary-routes.ts`): `CHANNEL_KINDS` 扩 `webhook/im/email`, `IM_PLATFORMS` 闭集校验
  (platform 不在集 → 400, 跟 kind/comparator 同款纯枚举镜像, 快错); 跨字段规则(im 要 platform、email/telegram
  要 target)留给 store, 经既有 typed-error 映射成 HTTP。DTO 加 `platform`/`target` verbatim echo。
- **admin UI**(`peer-summary-ui.js`): kind `<select>` 扩 webhook/im/email; **platform 选择器仅 im 显示**;
  **target 输入 im+email 显示**(label email='收件人' 否则='目标 chat/room id'); 渠道表加**目的地**列
  (platform → target, 或 incoming-webhook 显「via url」)。`headerEnv` 仍是表单里**唯一**的密钥引用(环境变量名)。

### 13.6 MC-M6 — e2e 验收门扩多通道（`peer-summary-alert-delivery-e2e.test.ts`）

把 day-3 的「webhook-only」验收门扩到多通道。一个真 provider breach 扇出到经 federation surface 配置的
**telegram(bot-API) + slack(incoming-webhook) + email** 三通道, 门逐平台断言**确切线缆**:

- **telegram**: bot token 从 env 解析进 **URL path** `…/bot<secret>/sendMessage`, body `{chat_id, text}`。
- **slack**: `{text}` POST 到 incoming-webhook url **原样不变**。
- **email**: `{to, subject, text}` POST 到 email API。
- **同一 counts-only 行**按平台再编码(三个 body 的 `text` 相等)。
- **no-leak** 在每个平台 body 上再钉一遍(provider agent id / model / parked task id 一个都不过线);
  telegram bearer 被证**只活在 env**——通道行存环境变量名, slack/email body 永不见密钥值。
- 第二个测试驱动一个**抖动 webhook**(第一发 503 → 一拍注入退避 → 第二发 200)证 surface 把 retry 穿过
  `evaluateAndDeliver`。**去重留单测**(生命周期边沿触发已在门上证 notify-once, e2e 难确定性造 overlapping 调用)。

`peer-summary-alert-delivery.test.ts` 38 单测(differ/payload/per-platform builder/retry/dedup) +
e2e 5 测(webhook 生命周期 3 + 多通道 fan-out 1 + retry-through-surface 1)。host **824 + 1 skipped 绿** /
web **864 绿**, 零回归。

### 13.7 北极星对账（多通道增量）

| 红线 | 多通道怎么守 |
|---|---|
| 只观察不接管 | im/email 仍是控制面给**自己运维**送信(自家群/邮箱), **不**向任何 peer 下指令; 通道/规则/firing 全住观察者本地。 |
| 计数即隐私契约 | im/email 文本由 `renderAlertText` 从**同一份 counts-only 载荷**渲染(结构性无泄漏); M6 no-leak 门在每个平台 body 上再证。 |
| 无密钥落库 | telegram bot token / email API key 走 `headerEnv`(环境变量名)投递时现读; incoming-webhook URL 是平台密钥端点(同 webhook kind, 存 url 列)。 |
| 节点尽量轻量 | per-platform builder 是纯函数 + 复用注入 fetch(**无 stateful bridge**); host `main.ts` 仅加 env 旋钮解析; UI 复用 day-3 渠道面板。 |

### 13.8 仍显式推迟（多通道之后）

- **Matrix / QQ 平台 renderer**: `IM_PLATFORMS` 闭集现 telegram/slack/discord/lark, 加新平台只补一个 builder 分支不迁移。
- **直连 SMTP email**: 现走 HTTP email API form(`{to,subject,text}` POST), 不直连 SMTP。
- **死信队列 / 跨进程持久重试**: 重试在单次 `evaluateAndDeliver` 内, 不跨进程持久排队。
- **跨 hub 告警聚合**: **完**(AGG-M1~M5, 见 §14)——折进 counts-only 摘要的 `alerts.openFirings` 计数族, 自动得到联邦视图 + 趋势 + 元告警。
- **firing 降采样·保留 / Alertmanager 式分组·静默·升级链**: 沿用 day-3 推迟。

---

## 十四、跨 hub 告警聚合 — `alerts.openFirings` 计数族（AGG-M1→M5）

> 状态: **完**(AGG-M1~M5)。§13.8 把「跨 hub 告警聚合」列为推迟; 本 pass 做实,
> 严守 counts-only + 只观察不接管 + opt-in fail-closed。commit `816f407`→本提交。

### 14.1 为什么 + 那个让它「免费」的关键决策

day-3/多通道把**单个 hub 自己**的告警 firing 收口(求值 → firing 生命周期 → 投递)。但自由图控制面少了
一个联邦级问题:「**此刻我所有 peer 加起来有多少条告警开着?**」——一个观察者想一眼看到整片网格的告警体温,
而不是逐个 peer 点进去数。

**关键决策**: 不另起一套 `peer.alertSummary` RPC + opt-in 列 + 聚合 surface + UI(那会是 day-3 投递管线的
平行第二套)。而是把告警状态**当成 `PeerSummary` 里又一个 counts-only 字段**——`alerts: { openFirings: number }`。
就这一个标量。这样:

- **复用 E5 的 `share_summary`(v23) opt-in 闸**——不新增 schema、不新增迁移、不新增 RPC。
- **自动得到趋势**(F-M2 快照 + F-M3 history 按 metric registry 投影)。
- **自动得到元告警**(F-M4 求值器按 registry 投影任意 metric → 一条 `metric: 'alerts.openFirings'` 的规则
  就能在「某 peer 开着的告警 > N」时自己触发, 是告警之上的告警)。
- **自动得到 no-leak**——`openFirings` 是个**长度**, 摘要 shape 没地方塞 firing id / 规则标签 / 被它 breach
  的源 peer / 阈值。生产者**按构造**漏不了行。

一句话: **把告警状态折进既有 counts-only 摘要, 联邦聚合就从既有摘要聚合里掉出来了**, 不是新建管线。

### 14.2 AGG-M1 — `PeerSummary.alerts.openFirings` + buildLocalSummary + normalize（`816f407`）

- `PeerSummary` 接口在 `health` 块后加 `alerts: { openFirings: number }`(host `peer-summary.ts`)。
- `SummaryIdentitySource` 加可选鸭子 `listOpenPeerSummaryAlertFirings?(): unknown[]`——真 `IdentityStore`
  **零改**即满足(`store.ts:2757` 早有此方法, day-3 firing store 的)。
- `buildLocalSummary`(**生产者侧**, 答 `peer.summary` 时跑)best-effort 取 `…listOpenPeerSummaryAlertFirings().length`
  填进去; 这个数 = **本 hub 对它自己的 peer 们**当前开着的 firing 条数(本 hub 自己的告警活动, **只是个长度**)。
  取不到/抛错 → 留 0(逐族 best-effort, 同 llm/health)。
- `normalizePeerSummary`(消费者侧防御)对 `alerts.openFirings` 做 `num()` 强转。
- **零 `main.ts` 改**: `summaryDeps.identity` 本就是整个 `IdentityStore`, 字段自动 populate。

### 14.3 AGG-M2 — 注册成可趋势 + 可元告警的 metric（`9bea66f`）

`peer-summary-metrics.ts` 的 `PEER_SUMMARY_METRICS`(dotted-key → extractor, 趋势投影 + 告警求值器的**单一真相源**)
加一行 `'alerts.openFirings': (s) => s.alerts.openFirings`。注册**就是**让这个计数:

- 进 `metricKeys()` → admin 趋势下拉框多一项;
- 被 `projectPeerSummaryMetric` 投影 → 一条 `metric: 'alerts.openFirings'` 的告警规则**能 breach**(没注册的 key
  投影成 undefined, 永不 breach; 注册把它翻成「可触发」)。

> **诚实**: 字段诞生前拍的老快照里没有 `alerts` → extractor 在老快照上抛 → `projectPeerSummaryMetric` 跳过那个点
> (best-effort), 趋势线从字段出现那一刻起画。

### 14.4 AGG-M3 — admin 控制面 UI 浮出聚合（`9331096`）

**纯 UI 里程碑**——字段早已端到端流通(没有「消费者侧聚合函数」要打补丁: `createPeerSummaryFederation.listRows()`
返回整个 summary blob, `history`/`computeBreaches` 经 metric registry 泛化, 告警族顺流而下)。所以只需:

- web 鸭子 `PeerSummary` 镜像加 `alerts: { openFirings }`(verbatim echo 一个标量)。
- 手写 IIFE `peer-summary-ui.js`: `METRIC_LABELS` 加 `'告警·开启中'`(趋势下拉认得它); 每行 `healthText` 折进
  `· 告警 N`; 表格下新增 `renderAggregate()` 一行 = **本地 + 每个已共享 peer** 的 `openFirings` 求和,
  徽章 🔴/✓ + 「跨 K 个已共享 hub; U 个未共享/离线未计入」。
- **诚实按构造**: 没 opt-in 共享的 peer **不**当 0 计入(那会把联邦体温读低), 显式列为「未计入」。
- `styles.css` `.ps-agg`/`-firing`/`-calm` + `build:assets` 重嵌入 `static-assets.ts`。

### 14.5 AGG-M4 — 双 hub 聚合验收门（`4ced8dc`, `peer-summary-alert-aggregation-e2e.test.ts`）

逐字镜像 E5-M5 的 harness(一个真 provider Hub + 真 identity store, 消费者经**真**聚合 surface + **真** in-proc
HubLink + **真** per-link share 闸驱动), 聚焦告警族。一个测一次证四件事:

| claim | 怎么证 |
|---|---|
| 真计数 | provider 种 **3 开 + 1 已解决** firing → 共享消费者收到 `openFirings === 3`(证真采样非硬 0, 且**已解决的被排除**——是 `listOpen` 非全部)。 |
| 聚合 | 控制面联邦总数 = 自己的 `openFirings` **加** 每个已共享 peer 的 = 真求和(2 + 3 = 5), 即 UI `renderAggregate()` 那道算术。 |
| no-leak | 每条种下的 firing 带秘密金丝雀(规则 id / 被它 breach 的源 peer / metric 名 / 人类标签)。**一个都不过线**——只标量过。断言 `summary.alerts` deep-equal `{ openFirings: 3 }` 且序列化 wire 不含任何金丝雀。 |
| opt-in + 隔离 | 未共享消费者 fail-closed 被拒, 带「not shared」原因——**不是**伪造的 `openFirings:0`(那会悄悄少算); 诚实聚合只数真共享的(known=1, 被拒 peer 贡献 0)。夹一条边不外溢另一条。 |

### 14.6 北极星对账（聚合增量）

| 红线 | 怎么守 |
|---|---|
| 只观察不接管 | `openFirings` 是每个主权 hub **自愿**经 per-link `share_summary` 暴露的自己的告警计数; 控制面只**数**不**接管**任何 peer 的告警/规则/firing。 |
| 计数即隐私契约 | 折进 counts-only 摘要的就一个**长度**; 摘要 shape 没地方放 firing id / 标签 / 源 peer; M4 no-leak 门钉死。 |
| opt-in fail-closed | 复用 E5 `share_summary`(v23): 没共享 → 拒 + 诚实原因, 绝不伪造 0; 聚合只数真共享的。 |
| 自由图非层级树 | 聚合是**观察者本地**把自愿计数求和, **不**建中心化 SaaS 控制面、**不**向 peer 下指令(那是 Route B P2 的另一条 track, 北极星红线外)。 |
| 节点尽量轻量 | 零新 schema / 零迁移 / 零新 RPC; M1 一个字段 + M2 一行 registry + M3 纯 UI + M4 测试。趋势 + 元告警是既有 F 机制**免费**带出。 |

### 14.7 测试 + 仍显式推迟

- **测试**: host `peer-summary.test.ts`(+default-zero/normalize/best-effort/metricKeys ≥10) + `peer-summary-metrics.test.ts`
  (+投影/趋势跳老快照) + `peer-summary-alerts.test.ts`(+元告警 breach) + `peer-summary-alert-surface.test.ts` +
  E5/F/delivery e2e 的 `ownSummary` literal 补 `alerts` + **新 AGG-M4 双 hub 门 4 测**。host **833 + 1 skipped 绿** /
  web **864 绿**, 零回归。
- **仍显式推迟**: 跨 hub firing **明细**聚合(只聚合**计数**, 不把各 peer 的 firing 行拉过来——那会破 no-leak);
  联邦级**静默/升级链**(Alertmanager 式, 沿用 day-3 推迟); 把 `alerts.openFirings` 的**联邦元告警**自动接投递通道
  (现元告警规则能 breach + 显示, 投递沿用 day-3 single-hub firing 管线)。
