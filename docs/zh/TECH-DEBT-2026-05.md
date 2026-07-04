# 技术债审计 — 扩展前还债清单（2026-05-29）

> 在动 A2A 对齐 / MCP-as-integration / dispatch 编排模板 / 持久化强后端 这几个扩展
> （见 `COMPETITIVE-LANDSCAPE.md` 第六节）之前，对现有代码做的一次只读审计。
> 方法：5 个并行只读审计 agent（巨石 / 重复死代码 / 联邦+MCP 就绪度 / 工作流+持久化
> 就绪度 / 测试覆盖）+ 2 项来自真机浏览器测试的确认 bug。
>
> **总判定**：代码库整体**健康**——标记型债几乎为零（全仓仅 12 个 TODO/FIXME 类标记，
> 且多为测试里的 eslint-disable）；测试 2676 例 / 201 文件；server.ts 拆分无死代码遗留；
> 模块边界（protocol 零运行时、web 零 llm dep）成立。债集中在三块：**① 3 个确认 bug、
> ② 4 个扩展各自的"重构前置"、③ 几个巨石文件**。下面按优先级排。

---

## P0 / 确认 bug — 先修（都很小）

### B1. [P0] 一条损坏的 `suspended_tasks.state` 会永久毒死整个 resume sweep
- **位置**：`packages/identity/src/store.ts:3744-3762`（`rowToSuspendedTask` 急切
  `JSON.parse(r.state)`）+ 爆炸半径 `packages/host/src/main.ts:628-669`
- **机理**：`listDueSuspendedTasks` 对每条到期行 map 过 `rowToSuspendedTask`，一条
  截断/损坏的 `state` 在 list 调用内就抛错 → 被 `main.ts:668` 外层 catch 吞 → 每行的
  损坏丢弃逻辑（`main.ts:636-641`，只处理 `task_json`）**根本没机会跑**。因 `ORDER BY
  resume_at ASC`，坏行卡在队头，**每个 sweep tick 都重抛**，无限饿死所有其他到期任务。
  讽刺的是 `task_json` 损坏被逐行优雅处理，而最容易损坏的 `state`（装大块
  `__llmMessages` 工作记忆）反而不被保护。
- **修法**：`state` 改惰性/防御解析——返回原始字符串在 sweep 循环内逐行 parse（命中
  现有逐行 try/catch 丢单行），或在 `rowToSuspendedTask` 包 try 返回 `{__corrupt:true}`
  哨兵让 sweep 检测后 `removeSuspendedTask`。**先于任何持久化强化做**——这正是竞品说的
  "弱保证"失效模式。
- **工作量**：S　**无测试覆盖**（suspended-tasks.test.ts 仅 happy-path）

### B2. [P0] admin SPA 客户端 init 在真浏览器里从不执行（admin 控制台死）
- **位置**：`packages/web/admin-src/main.js:1944`（init 全包在 `DOMContentLoaded`
  监听里，无 readyState 守卫）+ `packages/web/static/app.js`（在 DOMContentLoaded
  已触发后才动态注入 admin.js）
- **机理**：admin.js 由 app.js 动态注入，注入时真实 DOMContentLoaded 早已 fire →
  监听器永不触发 → 整个 admin CRUD（managed agents / workflows / services / dispatch /
  cap chips / 列表 fetch）不初始化。app.js 自带的 tab + 个人模式路径还能用，所以个人模式
  半可用、admin 操作不可用。已用合成事件 `dispatchEvent(new Event('DOMContentLoaded'))`
  验证修复方向有效。预存（c961500^ 同模式），非本轮回归。
- **修法**：把 main.js:1944 的 handler body 抽成 `boot()`，`if (readyState==='loading')
  addEventListener else boot()`。
- **工作量**：S　**测试结构上抓不到**（见 T1）

### B3. [P1] `#login-shell` 登录表单盖在已登录的控制台上
- **位置**：`packages/web/static/styles.css:1822`（`#login-shell{display:flex}` 缺
  `#login-shell[hidden]{display:none}` 守卫；同文件 `.join-overlay`/`.modal` 都有）
- **机理**：app.js 给 login-shell 设 `hidden=true` 被 `display:flex` 压过 → 登录表单
  在 owner 视图照显。引入于 commit 3bdb3ffb。
- **修法**：加一行 `#login-shell[hidden]{display:none;}`。
- **工作量**：S

---

## P1 / 扩展前置 — 不先做，扩展就得做丑陋手术

### 🅐 A2A 对齐的前置

**R1. [P1] `peerToken` 焊死在 wire path，没有 auth-scheme 抽象**
- `packages/transport-ws/src/hub-link.ts:53-64`（frame 字面量带 `peerToken?:string`）、
  `:293-348`（`verifyPeerToken`）、`:776-867`（factory options）
- auth 就是一个预共享字符串塞进 `MESH_HELLO` 帧、`constantTimeStringEquals` 比对。没有
  `AuthScheme`/`Credential` 接口；wire frame、link 字段、两个 factory、PeerRegistry、
  identity vault 全把它 typed 成 `string`。A2A 要求**声明** scheme（Bearer/OAuth2/OIDC/
  mTLS）；加 OAuth2 得同时改帧形状 + verifyPeerToken + 两 factory + resolver 签名。且
  mTLS/OIDC 是 TLS/HTTP 层的事，根本塞不进当前"auth=帧内字段"模型。
- **前置重构**：引入 `PeerAuthScheme` 接口（`presentCredential()`/`verifyInbound()`），把
  帧里 `peerToken?:string` 换成 `auth?:{scheme,credential}` 信封；`verifyPeerToken` 保持
  唯一校验 choke point（这点本来就好），按 `scheme.kind` 分派。**好消息**：入向身份模型
  （peerToken+Task.origin+ACL）本身是**内聚的**——已汇于 `verifyPeerToken` + 一个
  `peerTokenResolver` 闭包 + 单个 `evaluateAcl` 门（`core/src/peer-link-install.ts`），
  正是 auth 抽象该挂的位置。重构是局部的，不发散。
- **工作量**：L

**R2. [P3→并入 R1] resolver 签名 `(peerId)=>string|null` 假设凭证是可比字符串**
- `host/src/peer-registry.ts:591-626`（`buildPeerTokenResolver`）。OAuth2/OIDC 返回 claims
  不是字符串。随 R1 一起把签名拓宽成 `(peerId, presented)=>AuthVerdict`。

**R3. [P2] 没有给 Agent Card 用的能力聚合源**
- 端点本身好加（在 `.webmanifest` handler 旁丢一个 `/.well-known/agent-card.json`）；
  缺的是数据源：能力散在 `hub.registry` participants / 各 agent `ManagedAgentSpec` /
  `RemoteHubViaLink.capabilities`，没有"本 hub 对外能做什么"聚合器，也没有 auth-scheme
  声明对象（依赖 R1）。先建 `buildAgentCard(hub, schemes)` 再加端点。别复用 `/api/state`
  （admin-gated、内部形状、泄漏 worker id）。**排在 R1 之后**。
- **工作量**：M

### 🅑 MCP-as-integration 的前置

**R4. [P1] MCP client 只支持 stdio，连不上远程/HTTP MCP server**
- `packages/mcp-client/src/toolset.ts:31,377`（无条件 `new StdioClientTransport`）；
  `types.ts:19` 的 `McpServerConfig` 只有 `{command,args,env,cwd}`，没有 `url/transport/
  headers`。而你要"借力"的托管 MCP 生态绝大多数是 HTTP/SSE/Streamable——**今天根本连不上**。
  这是 MCP-integration 最大的拦路石。
- **前置重构**：`McpServerConfig` 改判别联合（`{transport:'stdio',...}` |
  `{transport:'http',url,headers?}` | `{transport:'sse',url}`），`startOne()` switch；
  同步穿过 `McpServerSpec`（`core/space.ts:1126`）和 `validateMcpServersArray`
  （`web/manifest.ts:481`）。
- **工作量**：M

**R5. [P2] MCP toolset 在构造时定死，无运行时增删**
- `mcp-client/src/toolset.ts:155-188`（仅构造器填充，无 addServer/removeServer）；
  每 agent 一份、spawn 时建、stop 时拆（`local-agent-pool.ts:395`）。"安装一个集成"
  作为一等 onboarding 动作，意味着在 hub/workspace 级装一个 MCP server 并即时可用，
  最好不必重启每个 agent。今天唯一办法是改每个 agent manifest 再 respawn。
- **修法**：加 `McpToolset.addServer/removeServer`（幂等，起/杀一个子进程）；是否做 hub 级
  共享 MCP 注册表（agent 按名 opt-in，类比 `uses:` services）是个设计决策，需与用户拍板。
- **工作量**：M（toolset 可变）/ L（共享注册表）

**R6. [P2] `${ENV_VAR}` 凭证展开埋在 host 里，集成安装器复用不了**
- `host/src/local-agent-pool.ts:1043-1077`（`buildToolset`/`expandEnvRefs`）。直接读
  `process.env`，没走 v4 的 vault/secrets。抽成 `resolveMcpServerConfig(spec, secretSource)`
  让 agent-spawn 和未来集成安装器共用一条凭证路径（且能从 vault 取）。
- **工作量**：S

### 🅒 dispatch → 编排模板 的前置

**R7. [P1] 工作流 runner 编排方法全 `private` + step 联合封闭**
- `packages/workflow/src/runner.ts:279-550`（`runStep`/`runSimpleStep`/`runParallelStep`/
  `runBranch`/`executeStartingAt` 全 private）；step 联合 `SimpleStep|ParallelStep` 在
  `runStep:365` 硬分支 `'parallel' in step`，parser 按封闭联合校验。要加 supervisor/debate/
  swarm 这些**新执行策略**，得同步改 runStep + 类型联合 + validateStep，且没有 protected
  让子类复用 `dispatchOne`/`persist`/解析上下文。factoring 本身干净，只是封死了。
- **前置重构**：引入 `StepExecutor` 策略接口（按 `step.kind` 判别，把 `parallel:true`
  布尔换成 `kind`），`dispatchOne`/`persist`/`now`/`idGen` 改 `protected`。之后 debate/
  swarm/supervisor = 新 `StepExecutor` + schema validator + 可复用 YAML 模板，runner 核心
  不动，零 LLM 性质保持。
- **工作量**：M　**好消息**：dispatch 层（DispatchToolset/ComposedToolset/ALS `.run()` 作用域
  +并发回归测试/ancestry/cycle/depth 门）**健全，可直接在上面建模板**。

**R8. [P2] `ComposedToolset` 名字冲突是 first-match-wins，无检测**
- `packages/llm/src/composed-toolset.ts:47-79`。模板组合多个 DispatchToolset / 多个 MCP
  server 时，重名静默路由到错误 child。构造器加一次性 duplicate-name 检查（抛类型化错误
  列出冲突名+归属），wiring 时大声失败而非运行时误路由。
- **工作量**：S

### 🅓 持久化强后端 的前置

**R9. [P1] resume 无幂等/原子认领，崩溃中途 = 重跑，多节点 = 双跑**
- `core/src/hub.ts:674-687`（`resumeTask` 先重入参与者，sweep 事后才 `removeSuspendedTask`）。
  无 claim/lease：(a) 重入后、删行前进程崩 → 重启全量重跑（at-least-once，而 onResume
  不要求幂等）；(b) resume 与同 task id 的 live dispatch 无锁竞争。`sweepInflight` 只串行
  单进程内的 tick。多节点/DBOS 模式下是硬阻塞（两 host 共享 store 会都认领同一到期行）。
- **修法**：重入前原子认领 `UPDATE suspended_tasks SET claimed_at=? WHERE task_id=? AND
  claimed_at IS NULL`，仅 `changes===1` 才进；终态清除 + 陈旧认领回收器。这是让该路径
  多节点就绪的最关键一步。
- **工作量**：M

**R10. [P1] resume 携带过期 wall-clock `deadlineMs`；`resume_at` 非单调 wall-clock**
- `host/src/main.ts:595`（`JSON.stringify(task)` 原样存）+ `hub.ts:929-946`（task 带
  deadlineMs）+ `suspend.ts:23`/`store.ts:3739`（resume_at = epoch ms）。长时挂起后
  resume 的 task 可能带已过期 deadline；今天 `invoke` 不强制 deadline 故潜伏，但
  DispatchToolset 已向 LLM 广告 deadlineMs，一旦加 deadline-enforcing 调度/模板，所有
  resume 的长任务立刻 `deadline_expired`。且 wall-clock 回拨（NTP/手动/DST）会让行提前
  到期或卡住，无单调下限。
- **修法**：resume 时按 resume 时刻重算/延长 deadlineMs（或从信封剔除让 resumed run 重设）；
  文档标注 resume_at 为 best-effort，加持久化模式时钳制到期选择防回拨。
- **工作量**：S

**R11. [P2] 挂起 state blob 无强制版本门，部署后 schema drift 静默错恢复**
- `llm/src/agent.ts:585-593`（`extractRestoredMessages` 直接 `as LlmMessage[]`，**从不
  检查** `__llmAgentMemVersion`）+ `:602-610`（写入 version:1）。版本字段是装饰性的。
  多模态内容块形状一变（Phase 9 常变），旧形状挂起的任务在新代码下 resume 会把畸形
  messages 喂给 `provider.stream`。
- **修法**：`extractRestoredMessages` gate `__llmAgentMemVersion===CURRENT`，不匹配则
  回退 `handleTask(task)` 或抛类型化错误；考虑给非 LLM agent 的 row 加顶层 stateVersion。
- **工作量**：S

**R12. [P2] suspend 时 `JSON.stringify(task)` 可能丢/胀负载 + 写放大**
- `host/src/main.ts:583-597`。整 task 信封（含 Phase 9 可达 ~1MB inline 的多模态
  file_ref/base64）每次 suspend 全量 stringify 进 task_json：循环负载抛错→整个 suspend
  变 `failed`（长任务永远挂不起）；大负载每次 suspend-again 被 INSERT OR REPLACE 重写
  （单节点 SQLite 写放大）。
- **修法**：文档约束"可挂起负载须 JSON-safe 且适度"+ task_json 大小护栏快速失败；持久化
  强化时把不可变 task 信封（写一次）与可变 state（每次重写）分离。
- **工作量**：S

### 🅔 代码健康（巨石 / 重复，影响多个扩展的可维护性）

**R13. [P1] `IdentityStore` 是 11 域 3806 行巨石**
- `packages/identity/src/store.ts:379-3557`（单 `IdentityStore` 类融合 users/membership/
  credentials/auth/sessions/audit/invitations/vault/peers/usage/org-quota/suspended-tasks/
  im-bindings；构造器 511-818 急切 prepare 62 条语句）。新域（vault/peers）已改惰性
  per-domain getter，证明 seam 已知、急切块是 legacy。SSO/RBAC、持久化、A2A 三个扩展都
  动到埋在中段的域。
- **修法**：`IdentityStore` 留薄 facade，逐域抽 `vault-store/peer-store/quota-store/
  suspended-task-store/...`（各自惰性语句）。跨域耦合低（~3 audit 写 + ~7 user 查）。
  外部用 flat `identity.method()`，facade 委托即可，调用方签名不变。**一域一 PR**，
  vault 或 suspended-tasks 是最干净的第一刀。
- **工作量**：L

**R14. [P1] app.js 绕开它自己加载的 `window.Gotong` 共享层 → tab/escape 逻辑脑裂**
- `packages/web/static/app.js`：仅 2 处 Gotong 引用且都在注释（471/473）；自带
  `escape()`（488）`formatBytes()`（493），而 app-core.js 已导出 `escapeHtml`（648）且
  先加载；又用裸 `fetch()` 而非导出的 `fetchJson`（带 401/JSON 处理）。`formatBytes` 现
  3 份源拷贝（app.js:493 / services.js:263 / main.js:1361）。`setActiveTab`+tab-nav 实现
  两遍（app.js:212 / main.js:1909），两个 hashchange 监听每次都 fire（注释自承）。这是
  B2 那个 duplicate setActiveTab 的根因——app.js 当初没接进 window.Gotong。
- **修法**：app.js 从 `window.Gotong` 解构 `escapeHtml/fetchJson/t`，删本地副本；把
  `formatBytes/formatTs` 提进 app-core.js 的导出（3 份塌成 1）；抽
  `createTabRouter({adminTabs,c1Tabs,...})` 进共享层，两 shell 各传自己 tab 集，全局
  一个 hashchange。（这是 CLAUDE.md 提到"故意留 main.js 的 workflow-start 共享渲染层"
  的干净可拆兄弟。）
- **工作量**：S（escape/fetch/formatBytes）+ M（tab router）

---

## P2 / 有价值的清理（非扩展前置）

- **C1. server.ts 半拆**：`handle()`（`web/src/server.ts:943-1936`）仍内联 ~40 条路由
  （admins/secrets/feedback/growth/applications/metrics/dispatch/workers/tasks）+ 213 行
  `renderMetrics`（2451-2664）。续抽 `admin-routes.ts`/`ops-routes.ts`/`metrics.ts`。M
- **C2. 构建产物双重入库**：`static/admin.js`(121KB) 与 `src/static-assets.ts`(598KB) 都
  git-tracked，且 admin.js 的字节又被 base64 嵌进 static-assets.ts（同内容存两遍）；
  27 次 artifact commit vs 4 次源 commit。有合理动因（`bun --compile` 单文件无 fs 需
  内嵌 + CI clean-tree 检查）。**(a)** 最省：停止 tracking `static/admin.js`（它只是
  `STATIC_ASSETS_BASE64` 空时的 dev 回退，static-assets.ts 已带其字节），gitignore + build
  生成。**(b)** 若 clean-tree 是 static-assets.ts 入库的唯一理由，可一并 gitignore 在
  CI 生成断言一致——这是更大行为变化，**需用户拍板**。S（a）/ M（b）
- **C3. 无共享 http-helpers**：`sendJson`×8、`readJsonBody`×7、`readCookie/readBearer`×2
  在各 route 文件复制。抽 `web/src/http-helpers.ts`，机械、零行为变化。S
- **C4. `Space` 8 域 JSON-CRUD**（`core/src/space.ts:114-888`）：admin/worker session 近
  copy-paste。抽 `JsonFileStore<T>` + 折叠 session 重复 + 类型移 `space-types.ts`。M
- **C5. `LocalAgentPool.spawn()` 264 行**（`local-agent-pool.ts:354-618`）：抽
  `assembleAgent(record,deps)`（toolset+provider+ctx 组装，构造 helper 已是底部自由函数）。
  正好是 R4/R6/R7 都要碰的 toolset 组装路径。M
- **C6. 删死 `@deprecated` shim**：`protocol/src/constants.ts:222-230`
  `SERVICE_METHOD_ALLOWLIST` **零 src 调用方**（仅 3 个测试引用）。按"DELETE>deprecate"
  直接删 + 清理对应测试断言。S　**最易的一分**
- **C7. `services-sdk/owner.ts` 14 处裸 `throw new Error`**（120-236）+ loader.ts 5 处，
  而同包有 `ServiceConfigError` 等 6 个类型化错误。走类型化错误。（core/host 的裸 throw
  多为内部不变式/env 解析，合理，**不要**群改。）M
- **C8. state 版本门**（=R11）；**C9. ComposedToolset 重名检测**（=R8）

---

## P3 / 次要

- `host/src/main.ts` `main()` 740 行组合根（330-1070）：抽 `startResumeSweep`/
  `installHitlResolver` 进 `runtime-loops.ts`（sweep loop 正是持久化模式要替换的东西）。S-M
- `web/src/me-routes.ts:321` 孤立 `console.error`（兄弟都用 `createLogger`）。S
  （附：logger 实际在 `@gotong/core` 的 `createLogger`，CLAUDE.md §4.2 写成 `@gotong/host`
  是笔误；host/src 自身零非 banner console。）
- `protocol/src/types.ts:51` `TaskOrigin` 是 Gotong 内部 orgId/userId 形状，A2A 互操作
  需入向边缘加翻译 shim（verifyPeerToken 成功 → 由 A2A principal 合成 TaskOrigin）。随 R1 后做。
- `resumeTask` 重入绕开调度器 load shaping（`hub.ts:689-765`，按设计，记录在模板文档即可）。
- 过度 export：`identity-routes.ts:61 roleAtLeast`、`me-routes.ts:448
  listAllowedWorkflowsForMe`（仅自文件用，去掉 export 关键字）。S

---

## 测试缺口（类别，非数量）

- **T1. [P1] 无任何浏览器/DOM/集成测试 harness**：全仓无 jsdom/playwright/puppeteer/
  testing-library，vitest 跑 node env。`web/tests/admin-bundle.smoke.test.ts` 等 2 个是
  node-env bundle smoke（验证 bundle 能 build/parse），**结构上够不到 DOM 启动**——B2 那类
  DOMContentLoaded 时序 bug 在当前体系下永远抓不到。建议引入 jsdom 级别的 boot 测试
  （加载 app-core+app.js，断言 admin bundle 注入后 init 真的跑），覆盖 admin SPA 启动 /
  tab 切换 / agent-workflow CRUD round-trip / SW 注册。M
- **T2. [P1] suspend/resume sweep 的 corrupt/reentrancy/claim 全无测试**：
  `suspended-tasks.test.ts` 仅 happy-path round-trip——B1(P0) 正因此存在。core 有
  `suspend.test.ts`/`hub-resume.test.ts`/`scheduler-suspend.test.ts` 测机制，但 host 侧
  sweep（毒行爆炸半径）无测试。补：毒行隔离、双 resume 幂等、claim 竞争。S-M
- **好消息**：identity 敏感路径覆盖不薄（vault 148 / quota 132 / credentials 50 /
  expir 36 / peer 36 / suspend 57 行测试引用）；workflow resolver 有
  prototype-pollution 测试、predicate 是干净封闭文法；server.ts 拆分无死代码遗留。

---

## 推荐还债顺序

1. **确认 bug 批**（半天）：B1(P0 毒行) + B2(admin init) + B3(login CSS) + C6(删死 shim)
   + T2 的毒行隔离测试。全是 S，高确定性，立即降风险。
2. **廉价健康批**（半天）：C3(http-helpers) + R14 的 escape/fetch/formatBytes 收敛 +
   P3 console.error/over-export。机械、零行为变化。
3. **扩展前置**（按你接下来要做哪个扩展挑）：
   - 要做 **MCP-integration** → R4(transport 联合) + R6(凭证抽取) + R5(运行时增删)
   - 要做 **A2A** → R1(auth-scheme 抽象，含 R2) → R3(Agent Card)
   - 要做 **dispatch 模板** → R7(StepExecutor seam) + R8/C9
   - 要做 **持久化强后端** → R9(原子认领) + R10(时钟) + R11(版本门) + T1/T2
4. **巨石**（穿插，一域/一组一 PR）：R13(IdentityStore 逐域拆，vault 先) + C1(server.ts 续拆)
   + C4(Space) + C5(LocalAgentPool.spawn)。

> C2（构建产物入库）和 R5 共享注册表是**需要你拍板**的决策点，其余可按上序推进。
