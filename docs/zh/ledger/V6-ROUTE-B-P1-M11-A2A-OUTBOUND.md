# Route B P1-M11 — 出站 A2A agent 持久化配置 收口

> 路线 B P1 「跨组织协作」(P1-C) 的又一刀: 把出站 A2A agent 从「**只能
> `AIPE_A2A_AGENTS` 环境变量 JSON blob 配, 无 UI、无持久化、改一个要重启
> 进程**」推到「**owner 在 admin UI 里登记、即时生效、诚实显示在跑/未激活**」。
>
> 拆 4 个里程碑 (M11a→M11d) 落地, 一个里程碑一个小 commit。本文是收口。
> Last updated: 2026-06-03

---

## 一句话

出站 A2A agent 是一个**本地 participant**: 派发它声明的 capability 时, 把任务转成
对外部 agent 的 A2A `message/send` 调用 (Phase 18 C-M4 的 `A2aRemoteParticipant`)。
M11 把这套配置从一坨**启动期环境变量 blob** 搬进 identity (`a2a_outbound_agents`,
v22), 让 host 从库里**开机物化 + 运行时即时重物化**到 hub 上, 并给 owner 一个
CRUD 面板。**令牌 (bearer) 永不进库也永不进 HTTP body** —— 库里只存 `tokenEnv`
(host 读 bearer 的环境变量**名**), 这维持了 C-M4 的「token 从 `process.env` 读、
绝不内联」不变量。

## 北极星对齐

- **状态都是磁盘文件**: 出站 agent 配置从「进程环境」变成 SQLite 行, 跟 transcript /
  agents / vault 一样 —— 复制 `.aipehub/` = 搬走房间, 重启透明。环境变量 blob 做不到
  (它在进程外、不随 workspace 走、改一个要重启)。
- **凭证只在本机**: 跟 peer token 进 vault 不同, A2A bearer **连库都不进** —— 它留在
  环境变量里, 库只记变量名。这是比 vault 更轻的一档: secret 既不落 DB 也不过浏览器,
  CRUD 面板只能写「变量名」, 永远碰不到密钥本身。
- **Hub is dumb on purpose**: host 不决定 agent 该不该在跑 —— 它**机械地**把库里
  `enabled` 且环境变量已设的行物化成 participant。某行环境变量没设 ⇒「持久化但未激活」,
  诚实地不注册 (记一条日志), 而不是假装在跑或静默吞掉。

---

## 二、关键决策

### 镜像 `SamlProviderStore` (无 vault), 不并进 `ManagedAgentSpec` (M11a)

出站 A2A agent **看起来**像个 agent, 诱惑是把它塞进中央的 `ManagedAgentSpec` /
`LocalAgentPool`。但那是全仓**耦合最重**的类型 —— LLM / `/me` / 心跳 / dispatch /
按 key 解析全挂在它上面, 加一条 `if (kind === 'a2a')` 分支会穿过一堆热路径。出站
A2A 本质是**联邦式集成配置** (跟 peers / OIDC / SAML 同类), 所以照搬那条线: 一张
独立小表 + 一个独立 store。`a2a_outbound_agents` 列 `tokenEnv` 不进 vault, 完全镜像
`saml_providers` 的「无 secret 列」形状 (SAML 的 `idp_cert` 是公钥, A2A 的 `tokenEnv`
是变量名 —— 都不是机密)。

### token 留在环境变量, 不进 vault (M11a)

OIDC 把 `client_secret` 进 vault, M11 偏偏**不**学它。原因: C-M4 已经立了「bearer
从 `process.env[tokenEnv]` 读、绝不内联」的不变量, 顺着它最省 —— 库只多存一个变量
**名** (`tokenEnv` 列), bearer 既不进 DB 也不进任何 HTTP 请求体。比 vault 更轻 (无
加密/解密往返), 且攻击面更小 (DB 泄漏、HTTP 抓包都拿不到 token)。代价: 配 token 要
两步 (库里登记 + host 上设环境变量), 但这正好对齐「持久化但未激活」的诚实状态。

### 彻底删环境变量 blob, 不留 shim (M11b)

照「删旧代码优先于 deprecation shim」: `AIPE_A2A_AGENTS` 整个删掉, 不做「库为空时
回退读 env」的兼容垫片。库是**唯一真相源**, 跟 peers / OIDC / SAML 一致 (它们也都
是 store + admin API、没有 env blob)。留 shim 反而会制造脚枪 —— 「我在 UI 里删了一个
agent、重启后它又从 env 冒出来」。

### 「持久化但未激活」是一等状态 (M11b)

一行 `enabled=1` 但其 `tokenEnv` 指向的环境变量没设 ⇒ **保留在库、显示在 UI、但
不注册到 hub** (记一条 warn)。这是诚实状态: 配好了, 只是运维还没把 secret 喂进来。
对比之下, 静默丢弃 (装作没这行) 或假装在跑 (注册一个会在第一次派发时炸的 participant)
都是说谎。

### 管理器只动「自己注册的那批 id」(M11b)

`A2aOutboundManager` 持一个 `live: Set<string>` —— 只记**它**注册上 hub 的 id。
`refresh(id)` 是「先 unregister 旧 wrapper、再 register 新的」(改配置后避免 hub
`register` 撞 id 抛「already registered」); `remove(id)` 只在该 id 属于这个 Set 时才
`hub.unregister` —— 绝不误删一个**同名的 managed agent / broker**。id 撞上已存在的
participant 时 (managed agent 抢先占了名), `register` 抛错被 catch → 报 `id_conflict`
而非崩 boot。

### `statusOf` 只读探针 → UI 诚实 liveness (M11c)

admin 列表要为每行显示「在跑 / 为什么没在跑」。新增 `statusOf(id)` 是个**不动 hub**
的纯读探针, 返回与 `tryRegister` 同样的理由 (`disabled` / `token_env_unset` /
`id_conflict` / `not_found`), 但什么都不注册。`add`/`update` 走 `refresh` 顺带拿到
结果, `list` 走 `statusOf` —— UI 因此能把「存了但环境变量没设的挂起行」跟「真在跑」
区分开。

### web 鸭子 surface 带非密钥的 `tokenEnv` + 运行时 liveness (M11c)

`a2a-admin-routes.ts` 照 `oidc-admin-routes` / `saml-admin-routes` 的鸭子 surface
模式 (web 零 `@aipehub/identity` 运行时依赖)。与 OIDC 的 write-only `client_secret`
**关键差**: `tokenEnv` 是非密钥 (环境变量名), 照 SAML cert 模式**整段进 view** ——
owner 必须看到该设哪个变量。view **另带** host 侧 join 的 `active` + `inactiveReason`,
路由原样 echo。add/update 在 host 侧 surface 里 join identity facade + manager:
`refresh` 把改动推到运行中的 hub, `remove` 反注册 —— admin 编辑**即时生效, 无需重启**
(同 MCP registry R5 的运行时同步缝)。

---

## 三、各里程碑

| M | commit | 做了什么 |
|---|---|---|
| **M11a** | `7787993` | identity **v22** `a2a_outbound_agents` 表 (`id` PK / `capabilities` JSON / `url` / `token_env` / `peer_id` / `target_skill` / `enabled` / `label` / 时间戳) + `A2aAgentStore` (镜像 `SamlProviderStore`, 无 vault, 重用 id→`a2a_agent_exists`, capabilities 非空规范化, id 不可变) + 类型 + 9 store 测试 |
| **M11b** | `f4ab6cc` | host `A2aOutboundManager`: 开机 `registerAllFromStore` + 运行时 `refresh(id)` / `remove(id)` / `isLive(id)`; bearer 从注入式 `readEnv` 读 (默认 `process.env`, '' → undefined); 持久化但未激活 / id 冲突报告不崩; main.ts 删 `registerOutboundA2aAgents` env-blob 函数; 9 测试 (真 Hub + 真内存 identity + 注入 env) |
| **M11c** | `090134e` | web `a2a-admin-routes.ts` 鸭子 surface + `/api/admin/a2a-agents[/:id]` CRUD (requireAdmin + 503-when-unwired + `.code`→HTTP); `tokenEnv` 进 view (非密钥), view 带 `active`/`inactiveReason`; manager 加只读 `statusOf`; main.ts inline surface join identity + manager (即时生效); +15 测 (web 12 + host statusOf 3) |
| **M11d** | `a1e0119` | admin UI `static/a2a-ui.js` 自包含面板, 挂「联邦」tab `#a2a-outbound-panel` (复用既有 tab 按钮 → 无新 i18n key); 诚实 liveness 徽章 (在跑 / 未激活·环境变量未设/id 冲突/已停用); 令牌不在 UI 填 (变量名而非 bearer); inline 样式零 CSS 依赖; 静态重建 24 文件 |

---

## 四、数据流 (端到端)

```
登记 (admin)                            物化 (host)                        派发 (runtime)
─────────────                          ────────────                       ──────────────
owner 在「联邦」tab 填表                 boot: registerAllFromStore()       workflow / agent 派发
  id / caps / url / tokenEnv             └ 逐行 tryRegister:                  capability "draft"
        │ POST /api/admin/a2a-agents       enabled? token env set?            │
        ▼                                    ├ 是 → hub.register(             ▼
  web a2a-admin-routes                       │      A2aRemoteParticipant)    hub 选中本地
   coerceAdd → surface.add ────────┐        └ 否 → 持久化但未激活            A2aRemoteParticipant
        │                          │                                          │
        ▼                          ▼                                          ▼ handleTask
  identity.addA2aAgent       a2aOutbound.refresh(id)                    a2aSend(url, token, text)
   (写 a2a_outbound_agents)    └ unregister 旧 + tryRegister 新          token = process.env[tokenEnv]
        │                          │  (即时生效, 无需重启)                     │ POST
        ▼                          ▼                                          ▼
   row 落库                   live Set 更新 + statusOf 反映           远端 A2A agent message/send
        └──────────────────────────┴─→ view { …, active, inactiveReason } ─→ admin UI 徽章
```

**令牌边界** (贯穿全链): bearer 只在最右一步 `process.env[tokenEnv]` 出现一次。库里、
HTTP body 里、admin UI 里, 全程只有 `tokenEnv` 这个**变量名**。

---

## 五、测试矩阵

| 包 | 新增 | 钉死什么 |
|---|---|---|
| identity | +9 (`a2a-agent-store.test.ts`) | 全列 round-trip、token 永不入库、重用 id 拒、空字段拒、targeted update、id 不可变、remove 幂等 |
| host | +12 (`a2a-outbound.test.ts`: 9 manager + 3 statusOf) | 开机选择性注册、refresh 重注册不撞 id、持久化但未激活、disable→反注册、remove 不误删同名 participant、id 冲突报告不崩、statusOf 只读不动 hub |
| web | +12 (`a2a-admin-routes.test.ts`) | 503-when-unwired、401、list 带 tokenEnv + liveness、POST 全字段转发、缺必填/空 capabilities → 400、重复 id → 409、PATCH、DELETE 404、405 |

合计 **+33**。web **740 绿** / host a2a-outbound **12 绿** / identity **绿** / 全 typecheck 净, 零回归。

---

## 六、运维须知

- **配一个出站 A2A agent 两步**: ① 在「联邦」tab 登记 (填 id/caps/url/tokenEnv); ②
  在 host 上 `export <TOKENENV>=<bearer>`。② 没做 ⇒ 该行显示「未激活·环境变量未设」。
- **设好 env 后让它上线**: 把该行**停用→启用** (一次 PATCH) ⇒ host 重读环境变量并
  注册, 无需重启进程。
- **`AIPE_A2A_AGENTS` 已删**: 旧的环境变量 JSON blob 不再读。迁移 = 把每条目在 UI
  里重新登记一遍 (token 仍走各自的环境变量, 照旧 `export`)。
- **入站 A2A 不受影响**: M11 只动**出站** (本 hub 调别人)。入站 (`A2aServer`, 别人调
  本 hub) 仍由 `AIPE_A2A_INBOUND_ENABLED` 开关控制, 与本 milestone 无关。

## 七、显式推迟

- **per-agent vault token 选项**: 当前只支持 `tokenEnv` (环境变量)。若将来要让 token
  随 workspace 走, 可加一个 vault-backed 备选 (像 OIDC), 但那放弃了「secret 不进库」
  的轻量优势, 暂不做。
- **PATCH 改 capabilities/url 的 UI 入口**: 面板目前 inline 只做停用/启用 + 删除
  (改其它字段 = 删了重登记)。路由 PATCH 全字段已支持, UI 富编辑推迟。
- **出站 A2A 与 mesh peer 的统一视图**: 出站 A2A agent 和联邦 peer 都在「联邦」tab,
  但各是独立面板。若两者概念收敛 (都是「我连出去的对端」), 可做统一拓扑视图, 推迟。

---

## 关联

- 出站 participant 本体: `@aipehub/a2a` `A2aRemoteParticipant` (Phase 18 C-M4)
- 入站对侧: host `a2a-server.ts` (`AIPE_A2A_INBOUND_ENABLED`) + Route B P1-M8 task lifecycle
- 同模式的联邦配置收口: [`V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](./V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md)
