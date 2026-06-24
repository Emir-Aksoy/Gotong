# 易用性深化 — 运行时失败修复入口 + 配置体检 + 启动兜底 + 真机走查

> 用户问:「进一步提升易用性,能快速上手、配置、修复的提升在哪里?」
>
> 诚实结论:onboarding 的「功能清单」几乎做满了(首启向导 / doctor / 测试连接
> 9 类根因 / 快聊 / 模板画廊 / 架构师 / 管家 / MCP 目录),真正的提升不在「再加
> 功能」,而在**错误处理的粒度**和**真机验证**两条缝。四块全部是「把已存在的
> 能力接到还没接的地方」,**不是造新东西**。
>
> 本文随四个阶段逐步收口。✅ = 已落地;⏳ = 进行中。
>
> Last updated: 2026-06-23(❹ 收口 —— 四块全清)

---

## 一、四块总览

| 阶段 | 缺口 | 做法 | 状态 |
|---|---|---|---|
| ❶ 运行时失败给修复入口 | 工作流 run 跑挂 / `/me` 最近运行只有一个红 pill,都没过 `describeError` | admin run-detail 失败 step + `/me` 最近运行接现成 `describeError` → 人话 + 「去补 key」 | ✅ |
| ❷ 配置体检总览面板 | 配置散落、无常驻体检,「我的 hub 现在哪里红了」看不见 | host `/api/admin/health` 只读聚合 + admin 总览「hub 体检」面板 + 一键测连接 | ✅ |
| ❸ 启动兜底 + doctor 自动修 | `friendlyBootError` 只认 `EADDRINUSE`;`doctor` 只报告不修 | 扩三类友好启动错误 + `doctor --fix` 只自动建缺失目录(安全可逆) | ✅ |
| ❹ 真机端到端走查 | onboarding 只有 hermetic/mock 测试,从没真 key 走一遍 `testLlmKey` 自救路径 | 本地新手自检脚本 + `live.yml` onboarding 往返 gate(`skipIf` 无 key) | ✅ |

**三句话守则**(贯穿四块):
1. **复用不重造** —— 接现成 `window.AipeHub.describeError()`、现成 `testLlmKey` /
   quick-chat 路由、现成 `doctor` 检查原语,不写新分类器。
2. **零 schema 倾向** —— `failureHint`、`/api/admin/health` 都是加性 + 只读投影,
   无 identity 迁移。
3. **爆炸半径锁住** —— web(前端 + 路由)+ host launcher 层 + cli(doctor)+ docs;
   **core/protocol/identity/runner 零改,host 路由 `handleImMessage` 逐字节不变**。

---

## 二、❶ 运行时失败给修复入口 ✅

**缺口**:provider 原始错误串**确实能流到前端**(`llm/agent.ts` → `TaskResult.error`
→ `workflow/step-executors.ts` `describeFailure` 取原文 → `StepRecord.error`),但
**工作流 run 跑挂时** run 详情的失败 step 是裸渲染,`/me` 最近运行只显示一个红状态
pill —— 都没过前端早就有的 `describeError(raw)`(`app-core.js`,把任意 error 字符串 →
`{code,text,fix,fixIsKey}`,快聊已在用)。所以这是**接线**,不是透出错误。

**做法**:
- **admin run-detail**(`admin.js` `run.steps.map`,纯前端):失败 step 的 `s.error`
  过 `describeError()` → 渲染人话 + `fix` 提示;`fixIsKey` 真时给「去 API Key 管理」
  跳转(同快聊 ③TC-ADMIN 模式)。run 顶部整体 failed 时显示一行失败摘要。
- **`/me` 最近运行**(host 投影 + 前端):host `RunSummary` 加 `failureHint?`(失败 run
  取末个失败 step error,**scrub key** 复用 `llm-key-test.ts` `scrubKey` 同款),web
  鸭子 surface verbatim echo;前端 failed 行用 `describeError(failureHint)` 显示原因 +
  「去补 key」入口(`/me` 凭证面板)。**不**新增 `/me` run 详情路由(列表行直接显示
  原因,最轻)。

一句话:**一个失败的 step 不再是裸 stack trace,而是「这个 key 可能失效了 → 去补」的
反向链接。**

---

## 三、❷ 配置体检总览面板 ✅

### 3.1 为什么

`postInstallChecklist`(模板导入后派生 `agentsMissingKey` / `kbSlotsToWire`)只在导入后
渲染一次;没有「我的 hub 现在哪里红了」的常驻总览,agent 列表无健康徽章,MCP server 无
「起来了吗」状态。

### 3.2 host `/api/admin/health` 只读聚合(❷-M1)

`packages/host/src/admin-health.ts` `createAdminHealthService(deps)` 返回 `{ snapshot() }`,
注入 `serveWeb({ adminHealth })`,web 零 host 运行时依赖(鸭子 `AdminHealthSurface`)。
`requireAdmin` 闸;surface 没接时路由返 **503**(面板**隐藏**而非报错)。

**快照形状**(`HealthSnapshot`,只读投影,全部零成本静态信号):

```
{
  agents: [{ id, provider, missingKey, online }],   // 逐 agent
  agentsMissingKey, managedCount, onlineCount,        // 头部计数
  mcpServers: [{ name, wired }], mcpUnwired,           // MCP 接没接
  spaceWritable, spacePath,                            // space 可写
  checkedAt,
}
```

**故意不做**的事:打开面板**不**自动对每个 agent 跑 LLM ping —— 个人用户在意成本
(DeepSeek/MiMo 廉价模型),自动全 ping 烧钱且慢。`missingKey` 走 try/catch **fail-open**
(探测失败按「缺 key」标红,宁可多提醒)。

### 3.3 admin 总览「hub 体检」面板 + 一键测(❷-M2)

总览 tab 常驻区块(`#hub-health`),吃 `GET /api/admin/health` → 渲染:

- **头部**:`🩺 hub 体检` + `刷新` 按钮 + 副标题(全绿 / `发现 N 项需要处理`)。
- **红信号**:`智能体「<id>」(<provider>) 缺少可用的模型密钥` + 「去补 key →」
  → 复用 ❶ 的 `describeError` 心智,直接打开 API Key 管理 modal(`maKeysBtn.click()`)。
- **黄信号**:`MCP 服务「<name>」已配置,但还没有智能体接入` + 「去 MCP 集成 →」
  → 跳到 mcp tab(`gotoTab('mcp')`)。
- **roster**:`智能体(<online>/<total> 在线)`,每行一个手动「测连接」按钮。

**「测连接」的诚实修正**(Auto-Mode 决策,代码内联注释记录):计划原文说复用
`testLlmKey` 路由,但那条路由要请求体里带**明文 key**,而已存 agent 的 key 在 vault 里
浏览器**永远拿不到**。诚实改用 **quick-chat** —— `openAgentChat(id)` 派一条真消息给该
agent(`explicit→to`,`wait:true`),失败经 `describeError(...)` 映射成人话 + 修复入口。
这才是「这个已存 agent 现在通不通」的真测试(③TC-ADMIN 同款路径)。

面板与 `#start-here`(全新 hub 首启引导)**共用总览槽位,生产里互斥**:start-here 在
全新 hub,hub-health 在有 agent 之后;`managedCount===0` 时面板不渲染。

### 3.4 一处 CSS bug(grid item overflow 塌行)

通用 `section { overflow: auto }` 命中本 banner。在 CSS grid item 上 `overflow:auto`
会把**自动最小尺寸归零**(`min-height:auto` 只在 `overflow:visible` 时生效),grid 高度
有压力时(总览满是 agent / 活动)那一行塌到 36px 把面板裁掉。`#start-here` 只在全新
hub 不过载时侥幸躲过,一旦总览有内容也会塌。修法:本 banner 是静态内容,`.hub-health`
显式 `overflow: visible` 让行按内容撑开。preview 验证:缺 key agent 标红 + 点测连接开
快聊框,面板从 36px 修到 298px,控制台零报错。

### 3.5 测试

- host `admin-health.test.ts`(8):聚合形状 + `missingKey` fail-open + `spaceWritable`。
- web `admin-health-route.test.ts`(3):401 未授权 / 503 surface 未接(面板隐藏)/
  200 verbatim echo。

---

## 四、❸ 启动兜底 + doctor 自动修 ✅

### 4.1 为什么

两个边界事件最容易把新手挡在门外:**host 真启动失败** 和 **启动前环境没配对**。两者
原来都不够友好——`friendlyBootError`(`boot-error.ts`)自认「Today it recognises
EADDRINUSE」,权限拒绝 / 磁盘满 / master key 缺失全是裸 stack trace;`doctor`
(`cli/src/commands/doctor.ts`)7 项预检**只报告不修**,缺目录也得手动 `mkdir`。本块把
这两条缝补齐,但**只做安全可逆的自动修**(D3):危险动作一律只提示。

### 4.2 `friendlyBootError` 扩成 5 类(❸-M1)

`boot-error.ts` 从「只认 `EADDRINUSE`」扩成**有序 5 分支**,每类打出
`✖ AipeHub could not start — …` + 该改哪个 env + `Run aipehub doctor`,纯函数零副作用
(调用点 `main.ts` 顶层 boot catch 已接线,零改):

| # | 触发(errno / 特征) | 提示 |
|---|---|---|
| 1 | `EADDRINUSE` | 哪个口被占(admin UI / agent WS)、对应 `AIPE_WEB_PORT` / `AIPE_WS_PORT`(body 与原 ⑥-M2 逐字节不变) |
| 2 | `EACCES`/`EPERM` **on `listen`** | <1024 特权端口提示,改 `AIPE_*_PORT` ≥1024 或挂反代 |
| 3 | message 含 `"master key"` | vault key 缺失/损坏,默认 file 从备份恢复 `<space>/identity-master.key` / env provider 设 `AIPE_MASTER_KEY` |
| 4 | `EACCES`/`EPERM`/`EROFS`(fs) | 数据目录不可写,列出具体路径;`EROFS` 显式说「只读挂载」 |
| 5 | `ENOSPC`/`EDQUOT` | 盘满 / 超配额,清空间或提配额 |

**两处歧义靠硬信号区分,不靠猜**:

- **特权端口 vs 数据目录没权限**:`EACCES`/`EPERM` 两边都会抛,用 `e.syscall === 'listen'`
  把「绑端口没权限」分支(2)提到「数据目录没权限」分支(4)**之前**——绑 80 口的用户
  绝不会被错误地叫去 chmod 数据盘。
- **master key 缺失 vs key 文件 fs 权限错**:identity 抛的是 `IdentityError`,message 必含
  `"master key"`(带空格);而 key **文件**自身的 fs 权限错 message 里是 `"identity-master.key"`
  (无空格),**不**匹配 `/master key/i`,正确落到分支 4「数据目录不可写」(修权限才是对的)。
  分支 3 排在 fs 分支(4)之前,所以 key-config 错不会被当成泛 `EACCES`。

> ⚠️ 一处 TS 坑(已修):`isMasterKeyError` 原写成 `e is Error` 类型谓词,但 `ErrnoLike`
> 本身 extends `Error`,**收窄谓词会把否定分支(后面的 fs/disk 检查)塌成 `never`**。改回
> 普通 `boolean` 返回值,`e` 在后续分支保持有类型。21 个纯函数单测钉死全部 5 类 + null 透传。

### 4.3 `doctor --fix` 只自动建缺失目录(❸-M2)

`doctor` 加 `--fix` flag。`applyFixes()`(纯函数 given seams)**只对一件安全可逆的事
自动修**:数据目录(`AIPE_SPACE`)缺失时 `mkdir -p`——可逆(`rmdir`)、host 首启本来也会建,
提前建出来好让 doctor 当场复检确认可写。`--fix` 跑在 `collectChecks` **之前**,复检反映刚建
的目录(creatable → writable ✓)。

**故意不自动改**(只提示「需你手动」):

- 端口被占(可能是你正跑着的 hub);
- 目录**只读** / 是**文件**(`chmod` / `rm` 有破坏性);
- master key、特权端口(<1024,security)。

`blocked`(目录不存在且父目录也不可写)仍**尝试** `mkdir -p`(若某祖先可写能建出整条链),
建不出就如实报 `failed` + errno,不假装成功。8 个新单测(creatable→fixed、blocked+mkdirp
抛→failed、writable→skipped 不调 mkdirp、readonly/not-a-dir→skipped「not auto-changed」、
real-mechanism `mkdirpReal` 真建嵌套链)。

### 4.4 文档 + 回归(❸-M3)

- `docs/zh/GO-LIVE.md` 新增 **§十一 启动失败排查**:`doctor` / `--fix` 用法 + 预检 7 项 +
  `friendlyBootError` 5 类「症状→人话→你要做什么」表 + 两处歧义区分的设计说明;§十二 代码
  地图补 `boot-error.ts` / `doctor.ts` 两行。
- 根 `README.md` Quick start 加「Won't start?」小节:`pnpm exec aipehub doctor [--fix]` +
  指向 GO-LIVE §十一。
- 回归:host vitest(boot-error 21 + 全量)+ cli vitest(doctor 26)+ 两包 typecheck 全绿。

一句话:**启动前 `doctor` 预检 + 能修的(缺目录)就修;真启动失败 5 类有人话、危险的只提示
不乱动。**

---

## 五、❹ 真机端到端走查 ✅

### 5.1 为什么

前三块都是「把已存在的能力接到还没接的地方」,但**那些能力本身从没在真 key 上端到端
走过一遍**。onboarding 的核心承诺只有一句:**新手粘进一个静默不工作的 key 时,不会
盯着一个死掉的 agent,而是被分类成人话 + 一个一键「去补 key」**。这条路径的每一环都有
hermetic / mock 单测(`llm-key-test.test.ts` 注入假 401、快聊用 `buildProvider` 注入),
但**没人把整条探针对真厂商走过**。❹ 就是这一遍走查——分两层,按成本。

**关键复用点 = `testLlmKey`**(`packages/host/src/llm-key-test.ts`):首启向导的「测试
连接」按钮、建 agent 表单、成员 BYO key 面板调的是**同一个** `testLlmKey`;它构造**和真
agent 路径同款**的 provider 类,发一条最小 `stream()`,把厂商错误归一成 9 类 `code`。
所以「探针绿了」≈「真 agent 路径也通」,「探针把错 key 归类成 `invalid_key`」≈「UI 会
亮起救援按钮」。❹ 的两层都只是**驱动这个同款原语**,不造新东西。

**自救信号的权威集**(前端 `app-core.js` `ERROR_FIX_KEYS` 的镜像):`describeError(raw)`
把失败标成「加/换一个 LLM key 能修」(`fixIsKey:true` → 「去补 key →」按钮)**恰好**对
两个 code —— `invalid_key` / `insufficient_quota`。脚本与 live 测试都内联同一个
`KEY_FIX_CODES = {invalid_key, insufficient_quota}` 集合,断言**只有**这两类亮救援按钮,
传输错(`network` / `timeout`)**不**亮(死 Base URL 不该被叫去补 key)。

### 5.2 本地新手自检脚本(④-M1)

`scripts/local-onboarding-check.mjs`(`pnpm check:onboarding`)——零依赖、可在**任何**
开发机跑,从 `packages/host/dist` 导入编译好的 `testLlmKey`(相对 dist 导入绕开 host
`exports` 映射)。**三层**:

| 层 | 何时跑 | 做什么 | 断言 |
|---|---|---|---|
| 1 HERMETIC | **总是**(无网络、零花费) | 注入 401-形状 provider / 空 key / 网络错 provider | 401 + 空 key → `invalid_key` 且 ∈ `KEY_FIX_CODES`;网络错 → `network` 且 ∉ `KEY_FIX_CODES` |
| 2 真 key 往返 | opt-in(env 有 key) | 真 key 走真线 | `ok:true` |
| 3 错 key 走真线 | opt-in(同上) | 同款真端点 + 故意 garbage key | ∈ `KEY_FIX_CODES`(其它 code → soft-skip,1a 已钉分类器) |

第 1 层就是**零花费证明自救保证**:注入一个 `stream()` 抛 401 的假 provider,断言探针把它
送上「去补 key」,把网络错送上「检查网络」。第 2/3 层 env 契约**逐字镜像 `live.yml`**
(Anthropic 优先,否则 OpenAI 兼容路径覆盖 OpenAI / DeepSeek via `OPENAI_BASE_URL`)。
key 从 env 读、传给探针、**永不打印**(探针自身 `message` 已 scrub key,脚本只打 code /
model / latency)。缺 key 优雅跳过、**不假红**(镜像 DeepSeek demo 策略):退出码 0 = 跑了
的检查全过,1 = 跑了的检查失败。

README「Won't start?」之后加一小段「Verify the key probe works (no real key needed)」:
`pnpm check:onboarding` hermetic 证明坏/空 key → 「去补 key」、网络错 → 「检查 URL」;
`ANTHROPIC_API_KEY=… pnpm check:onboarding` 往返真 key(opt-in,缺则跳过)。

### 5.3 `live.yml` onboarding 往返 gate(④-M2)

`packages/host/tests/live-onboarding.test.ts`——`describe.skipIf(!HAS_KEY)`,镜像
`live-workflow.test.ts` 结构(同款 `liveProvider()` / 64-token cap / cheap 模型默认 /
30–60s 超时)。三个 `it`:

1. **建好的 agent 真答一条 dispatch**——真 `Space.init` → `Hub` → `LlmAgent`(一个
   capability、terse system、64-token cap)→ `hub.dispatch` → 断言 `kind==='ok'` 且
   `output.text` 非空。这就是「我建了个助手,它真能答」那一刻(不过度断言确切回复,真
   模型会漂)。
2. **探针对真线放行真 key**——`testLlmKey(realInput)` → `ok:true` + 无 code + 有 model。
   = 真「测试连接」按钮真能用。
3. **错 key 对真线归类成「去补 key」根因**——同款真端点 + garbage key →
   `testLlmKey` → `code ∈ KEY_FIX_CODES`。= 权威「断言根因分类」,厂商的 401 必须落进
   救援集 UI 才亮一键修复。

`live.yml` 的 run step 从「三个 gated 文件」扩成**四个**(provider round-trip ×2 +
workflow + onboarding),env 契约不变(secrets 缺 → 空串 → skipIf 跳过 → green-by-skip)。
**故意不是发布硬阻塞**——这些测真打付费、非确定的第三方 API,厂商抖动 / 限流绝不能挡发
布;nightly cron + workflow_dispatch 按需手动跑,红了当「去查」不当「禁发」(同 live gate
其余文件一贯立场)。

### 5.4 一句话

**自救路径(粘错 key → 分类成人话 → 一键去补)第一次被真 key 端到端走过**:本地零花费
hermetic 自检 + opt-in 真线往返,加 nightly live gate 对真厂商盯着,缺 key 永远 skip-clean
不假红。

---

## 六、显式推迟

1. 凭证**主动**过期倒计时告警(需凭证带过期元数据,可能 schema)—— 本轮只做「运行时
   失败 → 这个 key 可能失效 → 去补」的反向链接;
2. MCP server **实时日志流**(本轮只做「起来了吗」布尔状态,不做 stderr 流);
3. doctor 自动改端口 / 自动 chmod(危险,只提示);
4. 体检面板**自动**全 agent LLM ping(成本,按需手动测);
5. 体检信号接告警投递(复用控制面 F day-3 通道是独立决策)。
