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
> Last updated: 2026-06-23

---

## 一、四块总览

| 阶段 | 缺口 | 做法 | 状态 |
|---|---|---|---|
| ❶ 运行时失败给修复入口 | 工作流 run 跑挂 / `/me` 最近运行只有一个红 pill,都没过 `describeError` | admin run-detail 失败 step + `/me` 最近运行接现成 `describeError` → 人话 + 「去补 key」 | ✅ |
| ❷ 配置体检总览面板 | 配置散落、无常驻体检,「我的 hub 现在哪里红了」看不见 | host `/api/admin/health` 只读聚合 + admin 总览「hub 体检」面板 + 一键测连接 | ✅ |
| ❸ 启动兜底 + doctor 自动修 | `friendlyBootError` 只认 `EADDRINUSE`;`doctor` 只报告不修 | 扩三类友好启动错误 + `doctor --fix` 只自动建缺失目录(安全可逆) | ⏳ |
| ❹ 真机端到端走查 | onboarding 只有 hermetic/mock 测试,从没真 key + 真浏览器走一遍 | 本地新手自检脚本 + `live.yml` onboarding 往返 gate(`skipIf` 无 key) | ⏳ |

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

## 四、❸ 启动兜底 + doctor 自动修 ⏳

> 进行中(③-M1 ~ ③-M3)。`friendlyBootError` 扩 `EACCES` / `ENOSPC` / master key
> 缺失或损坏三类友好提示;`doctor --fix` 只自动建缺失目录(可逆安全),端口占用 / 权限
> **只提示不自动改**(危险)。落地后补本节。

---

## 五、❹ 真机端到端走查 ⏳

> 进行中(④-M1 ~ ④-M2)。本地新手自检脚本(启动 → 建 agent → 试聊 → 故意错 key →
> 断言看到 `describeError` 自救路径,真 key 走 env、缺 key 优雅跳过)+ `live.yml`
> onboarding 往返 gate(`skipIf` 无 key、nightly、非阻塞)。落地后补本节。

---

## 六、显式推迟

1. 凭证**主动**过期倒计时告警(需凭证带过期元数据,可能 schema)—— 本轮只做「运行时
   失败 → 这个 key 可能失效 → 去补」的反向链接;
2. MCP server **实时日志流**(本轮只做「起来了吗」布尔状态,不做 stderr 流);
3. doctor 自动改端口 / 自动 chmod(危险,只提示);
4. 体检面板**自动**全 agent LLM ping(成本,按需手动测);
5. 体检信号接告警投递(复用控制面 F day-3 通道是独立决策)。
