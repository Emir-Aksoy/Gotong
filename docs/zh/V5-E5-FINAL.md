# v5 · Stream E5 — 中央多 hub 控制面（自由图「控制面」收口）小结

> 状态: **E5 完**（M1 identity v23 `share_summary` 列;M2 `peer.summary` RPC + `buildLocalSummary`
> + 出站 client + per-link 闸;M3 host `peerSummaryFederation` 聚合 surface + web 鸭子 + admin 路由;
> M4 admin「控制面」UI + share-summary 开关;M5 双 hub 摘要聚合 E2E 验收门 + 本文档）。
> **Stream E 五缺口全清**（E1 单用户糙点 / E2 出站 CLI adapter / E3 KB 连接器 / E4 agent RBAC /
> E5 控制面）。
>
> Last updated: 2026-06-03

---

## 一、为什么做（缺口定位 + 北极星红线）

Stream E 是「交付力五缺口，按杠杆排序逐个做」。E5 标题写的是「中央多 hub 控制面（org-wide
资产/审计/跨 hub 工作流）」——但这个标题**藏着一个会撞北极星的陷阱**:

> 北极星 §一: **Hub 网络是自由图，不是层级树**。每个 hub 主权自治, 凭证/数据/计费各归各家。

一个「中央控制面」最自然的实现方式是 SaaS 控制台:把每个 hub 注册成平台的一个 tenant, 中央
拉取它的全量资产/审计/run 明细。**那恰恰是把自由图压成层级树**——hub 不再主权, 被吸进平台。
所以 E5 的真问题不是「怎么造控制台」, 而是「**在不破坏主权的前提下, 运维者怎么同时看一眼多
个 hub 的健康**」。

锁定的设计（2026-06-03 拍板）: 一个**精简的自由图「控制面」**——

- **只观察, 不接管**(observe, never own)。控制面不持有任何 hub 的数据, 不发号施令。
- 每个主权 peer **自愿**通过新的 `peer.summary` RPC 暴露**隐私安全的计数**(资产/活动/健康),
  **永不暴露原始行**(名字/id/payload/凭证)。
- **opt-in per-link + fail-closed**: 默认不共享;hub 在某条 link 上勾选 `share_summary` 才暴露。
- **复用 Phase 18 联邦机制**(认证 mesh link + `rpcResponder` 多路复用 + in-mem 缓存), 零新表
  存对端数据。

**显式推迟**(见 §十): 托管 SaaS 控制面(那是 Route B P2 单独 track)、**跨 hub 工作流启动器**
(控制面只读, 不下指令)。

> 一句话: E5 把「中央控制面」从「平台吸 tenant」**重定义**成「自由图里每个主权 hub 自愿亮一
> 个隐私安全的计数仪表盘」。控制面是望远镜, 不是缰绳。

---

## 二、E5-M1 — identity v23 `share_summary` 列（`914f306`）

per-link 共享开关落在 `peers` 表(就像 P4-M4 的 data-class 列、C-M1a 的 KB allowlist 列):

- `schema.ts` 迁移 **v23**: `ALTER TABLE peers ADD COLUMN share_summary INTEGER NOT NULL DEFAULT 0`
  ——加性、**默认 0**(fail-closed: 老行、没勾的行一律不共享)。版本常量→23。
- `peer-store.ts`: `PeerRow` 加列;INSERT/`addPeer` 写入;UPDATE 沿用「undefined→保留」targeted
  write(改 `share_summary` 不碰 token, 反之亦然);`rowToPeerRegistration` 投影 `shareSummary: row.share_summary === 1`。
- `types.ts`: `PeerRegistration.shareSummary: boolean`(必有), `AddPeerInput`/`UpdatePeerInput.shareSummary?: boolean`(可选)。
- **测**(`peers.test.ts`, +4): 带 `shareSummary:true` round-trip;不带→默认 false;`updatePeer` 改
  `shareSummary` 不轮换 token;**v22→v23 迁移老行 `shareSummary===false`**(legacy 默认断言)。

一个维度一个加性列, 不复用 `acl_json` 之类的复合 blob——共享开关是个布尔, 没有「null 状态」,
独立列最诚实。

---

## 三、E5-M2 — `peer.summary` RPC：计数即隐私契约 + fail-closed 闸（`397ffc9`）

核心新文件 `packages/host/src/peer-summary.ts`。三件事:

### 3.1 `PeerSummary` 形状 = 结构性隐私契约

```
PeerSummary {
  hubId, protocolVersion, generatedAt,      // 身份 + 唯一新鲜度信号
  assets:  { agents, workflows, publishedWorkflows, peers },
  runs:    { total, byStatus },              // 当下活跃集 tally(非窗口)
  llm:     { windowDays, calls, tokens, costMicros },  // 近 30 天滚动
  health:  { suspendedTasks },
}
```

**每个字段都是 number 或 number 的 map——这个形状故意没有任何地方能放一个名字 / id / payload /
per-row 数据。** 那就是隐私不变量: 生产者**没法**意外漏一行, 因为 wire 类型里压根没有「行」这
个槽位。`generatedAt` 是唯一的新鲜度信号(不发 per-row 时间戳)。

### 3.2 `buildLocalSummary` — best-effort 逐族采集

镜像 `collectBusinessMetrics`(P3-M1): 每个计数族独立 try/catch, 某个源没接线/老 host 缺方法/调
用抛错 → 该族留 0 默认, **绝不让整个 summary 失败**。稳定形状(无省略键)让消费侧聚合无需 per-peer
守卫。`assets.agents` = `hub.participants()` 减去 peer wrapper(用 `peerWrapperIds()` thunk, 反映
当前注册表)。

### 3.3 `denyPeerSummaryRpc` — fail-closed by omission

```
peer-registry.gatedRpcResponder(row):
  responder = base rpcResponder
  if (row.allowedKnowledgeBases) responder = gateKnowledgeBaseRpc(...)   // C-M1
  if (!row.shareSummary)         responder = denyPeerSummaryRpc(responder) // E5  ← 没勾就拒
```

把 `kbGatedResponder` 重命名 `gatedRpcResponder`(诚实反映它现在组合两道闸)。summary 闸是二元的
(没 opt-in 就 throw `peer summary is not shared by this peer`), 比 KB 过滤器简单。**默认 fail-closed**:
任何从不翻这个 flag 的 link 一点不漏。

> 为什么 summary 要闸而 `peer.manifest` 不要: manifest 只暴露**能力名**(一个认证 peer 本就能
> 派发的东西, 学不到新信息);summary 暴露**活动量**。所以共享是 opt-in。

`rpcResponder` 多路复用(`main.ts`): `startsWith('mcp.')`→MCP 代理 / `===peer.summary`→summary host
/ 否则→manifest host。一条 link 一个 responder, 按 method 分流。

---

## 四、E5-M3 — 聚合 surface + 控制面路由（`4745940`）

消费侧聚合, 镜像 `createPeerManifestFederation`:

- `createPeerSummaryFederation(registry, {buildLocal})`: in-process 缓存(重启即丢, **by design**——
  重启后诚实 `unknown` 好过端上陈旧谎言)。`local()` 按需建本 hub 自己的 summary;`refresh(peerId?)`
  对 connected peer `fetchPeerSummary(link)`→缓存;**fetch 出错保留旧缓存 + 记 `lastError`**。
- `PeerSummaryRow.lastError`: 关键设计——控制面要分清「peer 离线」vs「peer 没 opt-in 共享」(闸拒
  `not shared by this peer`)。opt-in 是整个特性的根, 所以拒绝必须诚实 surface, 不能假装成 0。
- web `peer-summary-routes.ts`(鸭子 `PeerSummaryFederationSurface`, 零 host dep): `GET /api/admin/
  peer-summaries`→`{local, peers}`;`POST /api/admin/peer-summaries/refresh`→`{ok, local, peers}`。
  requireAdmin + 503-when-unwired + 400 坏 peerId + 405 + 500-on-throw。
- **测**: host federation 21 测(14 M2 + 7 M3, 含缓存/lastError/保留旧值);web 8 测(503/401/GET/
  refresh/peerId 穿线/400/405/500)。

---

## 五、E5-M4 — admin「控制面」UI + share-summary 开关（`7973027`）

两侧:**让运维者看见聚合**, **让 owner 翻开关**。

- **`identity-routes.ts` 穿线 `shareSummary`**: E5-M1 只动了 identity 列 + store, web 的 peer CRUD
  路由从没带这个字段——owner 没法翻。M4 把它接进 `IdentityPeerDTO` 投影(GET 自动带出: TS 类型擦
  除, 运行时 JSON 本就枚举它)、`parsePeerPolicyFields` 校验块(布尔, 无 null 态)、`addPeer`/`updatePeer`
  两个 surface 输入类型(让解析后的 value typecheck 进 host store)。
- **`peer-admin-ui.js`**: per-link 信任契约编辑器加一个 `pa-pol-sharesummary` 复选框, `onSavePolicy`
  读进 body → 走现有 `apiPatch`。
- **`peer-summary-ui.js`**(新, ~280 行, 复用 `pf-*` class 零新 CSS): 联邦 tab 新面板, 表格渲染**本
  hub footprint(钉首行)** + 各 peer 的计数行;没有 summary 的 peer 行显示**原因**(「未共享」/「离线·
  未知」)而非编造 0;每行「刷新」+ 顶部「刷新全部」。经 app.js 既有 admin-bundle inject 链加载。
- 联邦子面板沿用硬编码中文约定(只有 tab label `tabFederation` 走 i18n)。

---

## 六、E5-M5 — 双 hub 摘要聚合 E2E 验收门（`8976eae`）+ 本文档

`packages/host/tests/peer-summary-e2e.test.ts`(3 测), 镜像 stream-c / peer-isolation 验收门形状:
**一个真 provider Hub**(+ 真 identity store 种真 footprint)对**两个消费控制面**(一个共享、一个不),
真 in-proc HubLink + 真聚合 surface(`createPeerSummaryFederation`)+ 真 per-link 闸(`denyPeerSummaryRpc`,
按 PeerRegistry `gatedRpcResponder` 一字不差的方式穿)。一次证三件事:

1. **opt-in**: 共享方聚合到 provider 真计数(agents 2 / workflows 2 / published 1 / peers 2 /
   runs 3 / llm 1 call 150 tok $0.007 / suspended 1);不共享方 **fail-closed 被拒**, 带诚实
   `not shared` 原因, **绝非编造 0**(否则控制面会把「未共享」误读成「一个空但健康的 hub」)。
2. **no leak**: 共享方收到的 summary **只有计数**——provider 的 agent id / capability / parked
   task id / model 名(全在它 store 里)**没有一个**出现在过 wire 的 JSON 里。
3. **per-link 隔离**: 拒了一条 edge 绝不影响另一条(自由图「夹紧一条不外溢」)。

**一个 gotcha 钉死**: `buildLocalSummary` 把 ledger 窗口算成 `now - 30d`, 而 `aggregateLedger` 拒
负 `since`——所以注入的时钟必须超过 30 天窗口(生产真 epoch 永远满足), 否则 llm 族会被 best-effort
静默吞成 0。测试用固定真实时钟 + 同刻 stamp 种子行。

---

## 七、关键设计决策

1. **计数形状即结构性隐私**(§3.1): wire 类型没有放「行」的槽位 → 生产者无法漏行。比「记得脱敏」
   强, 因为它是编译期不变量, 不靠纪律。
2. **fail-closed by omission**(§3.3): 闸只在**没 opt-in 时**套上 `denyPeerSummaryRpc`。默认 = 拒,
   从不翻 flag 的 link = 永不漏。共享是主动动作, 不共享是静默默认。
3. **in-mem 缓存, 诚实 unknown**(§4): 不加表存对端 summary。重启后 `unknown` 好过端陈旧谎言。
   持久化对端数据=把别人的状态搬进自己库, 违背「只观察不接管」。
4. **`lastError` 分离「离线」vs「未共享」**(§4): opt-in 是根, 所以闸的拒绝必须能被控制面诚实显
   示, 不能塌成「无数据」。
5. **复用 `rpcResponder` 多路复用 + Phase 18 联邦**(§3.3): summary 不发明新传输, 蹭认证 mesh link
   的同一个 method-switch responder。一条新 method, 零新连接设施。
6. **观察 ≠ 接管**(§一): 控制面只读。**跨 hub 工作流启动器显式推迟**——下指令是另一个信任层级,
   不在「看一眼健康」的范围里。

---

## 八、数据流（端到端）

```
   控制面 hub (运维者)                          主权 provider hub
   ┌──────────────────────┐                    ┌─────────────────────────────┐
   │ admin UI 联邦 tab     │                    │  share_summary=1 才放行       │
   │  peer-summary-ui.js   │                    │                             │
   │        │ GET/refresh  │                    │  rpcResponder(method-switch)│
   │        ▼              │                    │   mcp.* → MCP 代理           │
   │ /api/admin/           │                    │   peer.summary → ┐          │
   │   peer-summaries      │                    │   else → manifest │          │
   │        │              │                    │                   ▼          │
   │ createPeerSummary     │   peer.summary {}  │  gatedRpcResponder:          │
   │   Federation.refresh ─┼───authed mesh ────▶│   !shareSummary?             │
   │        │              │    HubLink rpc     │     → denyPeerSummaryRpc(拒) │
   │ fetchPeerSummary      │                    │     → 否则 buildLocalSummary  │
   │   → normalize         │◀───PeerSummary ────┤        (best-effort 逐族)     │
   │        │              │    (计数 only)      │         hub.participants()   │
   │ in-mem cache + lastErr│                    │         workflows.listAll()  │
   │        ▼              │                    │         identity.aggregate-  │
   │ 表格: 本地 + 各 peer   │                    │           Ledger/countSusp.  │
   │ (未共享→诚实原因)      │                    │                             │
   └──────────────────────┘                    └─────────────────────────────┘
```

---

## 九、测试矩阵（+36）

| 包 | 文件 | 数 | 覆盖 |
|---|---|---|---|
| identity | `peers.test.ts`(+4) | 4 | v23 round-trip / 默认 false / 改不轮换 token / v22→v23 迁移 |
| host | `peer-summary.test.ts` | 21 | buildLocalSummary 逐族 + 排 wrapper / 闸 deny+passthrough / normalize 防御 / federation 缓存+lastError |
| host | `peer-summary-e2e.test.ts` | 3 | **验收门**: opt-in 真计数 / no-leak / per-link 隔离 |
| web | `peer-summary-routes.test.ts` | 8 | 503/401/GET local+peers/refresh/peerId 穿线/400/405/500 |

全量 `pnpm -r test` 绿(host 669+1skip / web 764 / identity 360 区段)。

---

## 十、显式推迟（保持精简 + 守北极星）

- **托管 SaaS 控制面**: 把 hub 注册成平台 tenant、中央托管密钥/计费——那是 Route B P2 单独 track,
  且本质是另一种信任模型(平台持有), 不混进自由图控制面。
- **跨 hub 工作流启动器**: 控制面**只读**。从中央对某个 peer hub 下发 run = 下指令, 是另一个信任
  层级(出站审批闸 Phase 18 B 才是那条路), 不在「看一眼健康」范围。
- **持久化对端 summary**(peers 加 `last_summary_json` 列): 需要历史趋势时再加;现在重启诚实 unknown。
- **push / subscribe**(peer 主动推 summary 变化): 当前 on-demand pull;mesh HELLO 协商也推迟。
- **历史时间序列 / 告警阈值**: 控制面现在是即时快照;趋势图 + 「某 peer suspended>N 告警」是 day-2。
- **本地→对端 OUTBOUND redaction**: summary 本就只计数, 无需 redaction;data-class redaction hook
  (Route B P1-M10)是 dispatch 路径的事。

---

## 十一、Stream E 收官

| 缺口 | 状态 | 关键资产 |
|---|---|---|
| E1 单用户 no-code 糙点 | 完 | 成员 BYO key 点亮自助建 agent + 文案(`bc0c5ae`) |
| E2 出站 CLI shell-out adapter | 完 | `@aipehub/cli-agent` 五缝 + 动作闸 + §5 验收门([V5-E2-CLI-ADAPTER.md](V5-E2-CLI-ADAPTER.md)) |
| E3 知识库连接器 | 完 | Obsidian / Elasticsearch example + [KB-CONNECTORS.md](KB-CONNECTORS.md) |
| E4 agent 资源 RBAC | 完 | admin agent 路由接 grant ladder + UI + 验收门([V5-E4-FINAL.md](V5-E4-FINAL.md)) |
| **E5 中央多 hub 控制面** | **完** | 自由图控制面 `peer.summary` + opt-in 闸 + 聚合 UI + 双 hub 验收门(本文档) |

**Stream E 五缺口全清**。下一步候选(非承诺): Route B P2 托管控制面(单独 track) / 历史趋势 +
告警 / 跨 hub 工作流编排(出站审批路径)。按 `/goal` 全按推荐逐里程碑执行的开发计划在此收束。