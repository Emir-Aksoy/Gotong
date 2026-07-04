# Route B P1-M7 — 联邦 peer onboarding 收口

> 路线 B P1 「跨组织协作」(P1-C) 的落地一刀: 把联邦 peer 从「**只能 curl
> 配**」推到「**owner 在 admin UI 里铸 token、登记对端、编辑 per-link 信任
> 契约**」。后端 (路由 + 存储 + 信任契约执行) 早在 Phase 18/P4/v5-C 全做完,
> M7 补的是**运维入口** —— 一个铸 token 的 CLI + 一个 onboarding 面板。
>
> 拆 4 个里程碑 (M7a→M7d) 落地, 一个里程碑一个小 commit。本文是 M7d 收口。
> Last updated: 2026-06-03

---

## 一句话

联邦认证是**对称**的: 两个 hub 共享**一个** bearer token —— A 把它存成「发往
B 的出站 token」, B 把**同一个串**存成「来自 A 的入站期望 token」, 在
`@gotong/transport-ws` 里 `timingSafeEqual` 比对。M7 给这条「最后一公里」配齐
工具: `gotong mint-peer-token` 铸高熵 token, 「联邦」标签页的 onboarding 面板
登记对端 + 编辑每条 link 独立的信任契约 (入站 ACL / 出站 capability 白名单 /
数据类 / 可调用 KB / 配额 / 撤销)。**token 是 secret, 加密存 vault, 永不回显**。

## 北极星对齐

- **Hub 网络是自由图, 不是层级树**: 每条 peer link 各持独立的 trust/policy/
  capability 契约 (P4-M4 的 per-link 列), 一个个人 hub 可同时连多个组织而权限互
  不串线。M7c 的策略编辑器就是把这张「自由图的每条边」做成可视化可编辑。
- **凭证只在本机**: peer token 进 vault (信封加密 + master key 轮换自动覆盖),
  list 路由从不返回它 (`rowToPeerRegistration` 无 token 字段), 面板只能写入/轮换,
  永不读回。
- **Hub is dumb on purpose**: 铸 token (M7a) 与登记 token (M7b) 是**两件分开的
  事** —— mint 命令纯无状态, 不碰 workspace / master key / running hub, 它只产一
  个强随机串; 信任与执行的决策权在 owner 配的契约 + transport 层的常量时间比对。

---

## 二、关键决策

### token = 256-bit base64url, mint 与 register 解耦 (M7a)

`crypto.randomBytes(32).toString('base64url')` —— 256-bit 熵, base64url 在
URL / HTTP header / JSON 里都安全无需转义 (无 `+` `/` `=` padding)。token 对
transport 层是**不透明**的, 任何强随机串都行, 选 base64url 只为「贴到配置/header
里不踩转义坑」。`mint-peer-token` **纯无状态**: 不写 workspace、不读 master key、
不连 running hub —— 铸一个 token 跟「把它登记成一条 link」是两件事, 混在一起会让
「我只想要个随机串」的运维被迫先起一个 hub。坏参数 (bytes 越界 / 未知 flag /
多余位置参数) fail-closed `exit 2` 且**零 stdout** —— 绝不吐半成品 token 让人误用。

### 输出纪律照 `connect`: token 独占 stdout, 提示走 stderr (M7a)

token 单独一行写 stdout (可 `gotong mint-peer-token > peer-token.txt` 直接重定
向), 对称配对的 setup 说明 (`--peer-id` / `--endpoint` 槽进「两边各登记一次」的
提示) 走 stderr。这样 `> file` 拿到的是纯 token, 终端里仍看得到人类可读的下一步。

### onboarding 面板复用既有路由, 零新后端 (M7b/M7c)

peer CRUD 路由 (`/api/admin/identity/peers` GET/POST/PATCH/DELETE) + 全套 policy
字段在 Phase 18 (B-M2 入站 ACL / B-M3 出站审批) + P4-M4 (data-class / quota /
revocation) + v5 C-M1 (可调用 KB) **早已存在并各有测试钉死执行**。M7b/M7c 是**纯
前端胶水**: 自包含 IIFE 模块 (`peer-admin-ui.js`), 镜像 `peer-manifest-ui.js` /
`oidc-ui.js` / `saml-ui.js` 的 `MutationObserver` 激活模式, 对这些路由做 list /
add / 生命周期 / 策略 PATCH。**P4 行明写「admin=API 配置, peer-policy 编辑器推
迟」—— M7 就是这笔显式欠债的收口。**

### 数组策略字段统一 idiom: 留空=null, 逗号列=白名单 (M7c)

七个策略字段里五个是数组 (acl.capabilities / outboundCaps / allowedDataClasses /
allowedKnowledgeBases) 或可空标量 (perLinkQuotaBudget)。编辑器统一: **输入框留
空 ⇒ `null`** (路由读作「默认 / 全放」), **逗号或空格分隔列 ⇒ 显式白名单**。三态
里的第三态 `[]`=单轴锁死 (该维度全拒) 故意**不**给 UI 入口 —— 它罕见且危险, 留
API-only; 要整体拒发一条 link 用「撤销」(`revocationState='revoked'`) 更直白。配额
非负整数客户端先校验, 与路由 `parsePeerPolicyFields` 的服务端校验双保险。

### onboarding 在 manifest 浏览之上, by-id 选择器消除耦合 (M7b)

「联邦」标签页此前只有只读的 manifest 浏览 (`#peer-federation-panel`)。M7b 把
onboarding 面板 (`#peer-admin-panel`) 插在**它上面** (先配置后浏览的自然顺序)。
两个 section 同属 `data-tab="federation"` —— 原 `peer-manifest-ui.js` 用泛
`section[data-tab="federation"]` **第一匹配**选根, 加了兄弟 section 后会抓错。
M7b 顺手把它硬化成 `#peer-federation-panel` by-id, 两模块都 id-targeted, 零耦合。

---

## 三、4 个里程碑

| M | commit | 包 | 做了什么 |
|---|---|---|---|
| **M7a** | `5510f18` | cli | `gotong mint-peer-token` 子命令。`randomBytes(32)→base64url` (256-bit), 纯无状态 (不碰 workspace/master key/hub)。输出纪律照 `connect`: token 独占 stdout (可 `> file`), 配对提示走 stderr。`--bytes` 16–64 / `--peer-id` / `--endpoint`; 坏参数 fail-closed `exit 2` 零 token。纯 helper (`generatePeerToken`/`renderPairingHint`) 导出供直接断言 + runCli smoke。cli 98→110。 |
| **M7b** | `4d25974` | web | admin peer onboarding UI (生命周期基础)。owner-only `#peer-admin-panel` + 自包含 `peer-admin-ui.js`: list / add (peerId+endpoint+token+label+kind) / 启停 / 轮换 token / 删除。**peerToken write-only** (vault 加密, list 不返回, 面板永不回显)。硬化 `peer-manifest-ui.js` 选择器 `section[data-tab=federation]`→`#peer-federation-panel` by-id (联邦 tab 现两 section)。静态重建 (22→23 文件, admin.js 字节不变) + 2 c1-app-shell 哨兵。web 725→727。 |
| **M7c** | `c204eb1` | web | peer 信任契约策略编辑器 (P4 显式推迟的收口)。每行加「策略」按钮展开行内编辑器, 从 list 响应预填**七个字段** (全在 GET 里): 入站 ACL capabilities + requireOrigin / 出站 capability 白名单 / 出站需审批 / 允许数据类 / 可调用 KB / 每链路入站配额 / 撤销状态。全 PATCH 同一 `/api/admin/identity/peers/:id`。数组字段统一 idiom (留空=null / 逗号列=白名单 / `[]`=单轴锁死 API-only)。配额非负整数客户端先校验。styles `.pa-policy-grid` 自适应网格; +1 c1-app-shell 哨兵。web 727→728。 |
| **M7d** | (本提交) | docs | M7 收口文档 + CLAUDE.md 目录注解。 |

---

## 四、数据流 — 配一条对称 peer link

```
 运维 (双方各一台)            hub A (本地)                    hub B (对端)
   │                            │                                │
   │ 1. gotong mint-peer-token │                                │
   │   → stdout: <256-bit b64url token>                          │
   │     stderr: 「两边各登记一次」提示                          │
   │   (走安全信道把同一 token 交给 B 的运维)                    │
   │                            │                                │
   │ 2. A 的 owner: 「联邦」tab → #peer-admin-panel              │
   │    add peer { peerId:B, endpoint:wss://B, peerToken:<同一串>, kind }
   │                       POST /api/admin/identity/peers        │
   │                       token → vault (信封加密)              │
   │                       存出站: 「发往 B 用这个 bearer」       │
   │                            │                                │
   │ 3. B 的 owner: 同样 add peer { peerId:A, peerToken:<同一串> }│
   │                            │      存入站: 「来自 A 期望这个」 │
   │                            │                                │
   │ 4. 链路建立, transport 层 timingSafeEqual(出站, 入站期望)    │
   │                            │ ◀──── HELLO + bearer ─────────▶ │
   │                            │                                │
   │ 5. (可选) A 的 owner: 行内「策略」→ 编辑 per-link 契约       │
   │    入站 ACL / 出站白名单 / 数据类 / KB / 配额 / 撤销         │
   │                       PATCH /api/admin/identity/peers/:id   │
   │                       每条 link 独立, 自由图的一条边         │
```

token 在面板里**永不回显** (步骤 2 录入后即 `form.reset()` 清空密码框); 轮换走
`prompt` 再 PATCH `{peerToken}`, 两边必须换成同一新值。

---

## 五、安全不变量 (各有测试 / 路由校验钉死)

1. **token write-only**: `rowToPeerRegistration` (list 响应形状) **无 token 字段**,
   只 `getPeerToken` 读 vault。面板用密码框录入、`form.reset()` 清空、轮换走
   `prompt` —— **永不读回**。
2. **mint fail-closed**: 坏参数 (bytes <16 或 >64 / 未知 flag / 多余位置参数) →
   `exit 2` 且**零 stdout 写入** —— 绝不吐半成品 token。(cli 测试钉死。)
3. **token 高熵**: `randomBytes(32)` = 256-bit, base64url 编码。非确定性 (两次
   mint 必不同, 测试钉死)。
4. **策略字段服务端权威**: 面板只是表单, `parsePeerPolicyFields` (kind enum /
   acl 对象逐字段 / 数组类型 / 配额非负整数 / revocationState enum) 在路由侧再校
   验一遍 —— 前端校验是 UX, 不是闸。
5. **per-link 契约真执行** (非本里程碑新增, M7 只配它): 入站 ACL 拒越权
   capability (`cross_org_acl_denied`); 出站 capability 白名单在 `RemoteHubViaLink`
   碰链路前最后 chokepoint 强制; 数据类 / 配额 / 撤销三闸 (P4-M4); 可调用 KB 闸
   (v5 C-M1)。M7c 编辑器写的就是这些已被 E2E 隔离验收门钉死的字段。
6. **撤销 ≥ 单轴锁死**: 整体拒发一条 link 用 `revocationState='revoked'` (三闸:
   tick 拆链 / install 拒 / 线缆层拒), 比给每个数组轴填 `[]` 更直白可审计。
7. **owner-only + 503 降级**: 面板路由 requireAdmin; host 未接 identity (个人模式)
   → 503, 面板内联「host 未启用 identity / peer」不崩。

---

## 六、测试矩阵

| 包 | 文件 | 覆盖 |
|---|---|---|
| cli | `mint-peer-token.test.ts` | 12 — 32-byte 默认 base64url / 自定义 bytes / 非确定性 / pairing-hint 措辞 / runCli (单行 stdout + hint→stderr / `--bytes=48` / `--help` exit 0 / `--bytes=8` exit 2 零 stdout / `--wat` exit 2 / 多余位置参数 exit 2) |
| web | `c1-app-shell.test.ts` | M7b: `#peer-admin-panel` + `#peer-federation-panel` 共存于 served shell / `/peer-admin-ui.js` 带 pa-add-form + `/api/admin/identity/peers` 可服务。M7c: `/peer-admin-ui.js` 带 `pa-pol-save` + `allowedKnowledgeBases` + `revocationState` |
| web | `identity-routes.test.ts` | (既有, Phase 18/P4/C-M1) peer CRUD + parsePeerPolicyFields 全字段校验 + per-link 契约 round-trip |

全链路绿: **cli 110 / web 728** (host 614 / identity 519 / saml 22 自 M5 未动)。

UI 层是自包含静态 IIFE, 无新 web seam 可单测 —— 靠 c1-app-shell 服务端 markup
哨兵 (剥 marker 重建→RED) + 全 web 套件静态 re-embed 后仍绿钉死。`node --check`
双 UI 模块语法过。

---

## 七、运维须知

- **铸 token**: `gotong mint-peer-token --peer-id partner-hub --endpoint wss://partner/federation`
  —— token 印到 stdout, 对称配对提示印到 stderr。默认 256-bit; `--bytes 16..64` 可调。
- **对称登记**: **同一个 token 串**两边各登记一次 —— A 在「联邦」标签页 add peer B,
  B add peer A, peerToken 填同一串。走**安全信道**交换 (别贴聊天/邮件明文)。
- **token 轮换**: 行内「轮换 token」→ 粘贴新值 → 两边**同时**换成同一新串 (不同步会
  断链, 重连即恢复)。旧值立即失效。
- **信任契约**: 行内「策略」编辑 per-link 契约。**留空=默认/全放, 逗号列=白名单**。
  收紧一条 link 不影响别的 link (自由图各边独立)。整体停发用「停用」(可逆) 或
  「撤销」(revocationState)。
- **个人模式**: host 没接 identity / peer → 面板 503 内联提示, 不影响其他功能。
- **配额持久化注意** (沿 P4-M4 记录): per-link 入站配额是内存 `FixedWindowLimiter`,
  跨重连保留防刷新, **重启归零**。长期持久化是后续 backlog。

---

## 八、显式推迟 (保持精简)

- **M6 SCIM 自动 provisioning** —— **跳过** (可选 + 与立场冲突)。M6 在计划里标
  「可选」, 且 SCIM 的本质是**让外部 IdP 自动创建/停用本地账号**, 直接违背 OIDC
  (M4) / SAML (M5) 一路强调并测试钉死的「**绝不自动开户**」安全立场。本版坚持「owner
  先建账号 / 发邀请, 外部身份只能联结到已存在用户」。要做 SCIM 须先和用户确认是否
  放松这条立场 —— **此推迟值得显式 sign-off**。
- **per-link 配额持久化** —— 现为内存 limiter, 重启归零 (P4-M4 既有边界)。
- **专门的 peer-policy 编辑器富 UI** —— M7c 是行内紧凑编辑器; 若策略维度继续增长,
  可拆独立 modal (沿 OIDC/SAML admin tab 先例)。
- **token 强度策略 / 过期** —— 当前 mint 一个高熵串永不过期, 轮换是手动。自动轮换
  / 到期提醒是运维增强, 非安全硬伤。
- **manifest 经 WS-HELLO 协商** —— 仍是 on-demand RPC (Phase 18 A 既有边界)。
- **真实外部 (非 Gotong) 联邦对端的 wire 级互操作测试** —— federation mesh 是
  Gotong↔Gotong 自有通路; 对外生态可达性走 A2A (Phase 18 C), 是另一套信任模型。

---

## 九、下一步

M7 收口后, P1 「跨组织协作」的运维入口齐了。Route B P1 剩余里程碑 (M8 A2A task
lifecycle / M9 真 socket 隔离 E2E / M10 数据类 redaction / M11 出站 A2A 持久化
配置) 按计划顺序逐里程碑推进 —— M12 (分发/发布) 受 GitHub 暂停阻塞, M13 需真 key,
M14 需付费证书, 三者留到解禁/有资源时。企业治理 umbrella (task #22) 的 SSO 支柱
已随 M4 (OIDC) + M5 (SAML) 收口, 剩审计日志增强与细粒度 RBAC 深化。
