# model-routing — 主模型挂了,管家不断线(模型路由 MR capstone）

北极星第 1 层「我的 AI 桌面」要能实际帮人做事,就不能厂商一抖对话就断。
模型路由(MR track)整条路——**确定性多 provider 有序降级 + per-candidate 熔断 +
per-provider 健康监测**——在一个确定性脚本里跑通:

```
[1] 主 provider 首-token-前挂 → 降级到备用      （答案照到,调用方完全无感）
[2] 主连续失败到阈值(3) → 断路器打开            （第 4 次调用快速跳过死掉的主,不再浪费一次尝试）
[3] 同一串路由事件喂进健康 tracker              （snapshot() 正是体检面板 snap.routing 的行:哪个 provider 在抖）
[4] 主自愈 + 冷却期过 → half-open 探针成功 → 关  （断路器关,路由弹回主——连一次、永续、恢复即回归）
```

底下是**真的**框架件:真 `@gotong/llm` `RoutingProvider`(有序候选 + 首-chunk-前
failover + 三态熔断,注入时钟 + onEvent 都是生产件)+ 真 `@gotong/host`
`RoutingHealthTracker`(体检面板读的那份 per-provider 健康投影)。零网络、零 API
key——唯一被 stub 的是两个 provider(一个会抖的主、一个稳的备),薄到不可能和真
provider 跑偏。一条共享时钟同时驱动熔断计时和健康时间窗,故每一步都可复现。

```bash
pnpm demo:model-routing
```

## 它证明什么

1. **failover 只发生在首-chunk-前**。主 provider 在吐出第一个 token **之前**抛错
   (网络挂),RoutingProvider 顺次降级到备用——答案照样到。一旦某候选产出了第一个
   chunk 就锁定它(已吐给用户的 token 收不回,中途换 provider = 把半句话接成另半句)。
2. **连续失败 → 熔断快速跳过**。同一主 provider 三次首-chunk-前失败(阈值)后
   per-candidate 断路器打开,第 4 次调用**直接跳过**死掉的主(不发请求、不产生新的
   失败),直奔备用——不对已知挂掉的 provider 每轮硬敲。
3. **健康投影 = 面板看得见哪个在抖**。同一串路由事件喂进 MR-M3 tracker,
   `snapshot()` 吐的正是体检面板 `snap.routing` 的行:你看得见**哪个** provider
   在抖(病名 network + 状态 open),面板把它渲染成**黄条**(agent 靠备用仍工作),
   而不是 CARE-M7 那个二元红色「大脑挂了」。
4. **恢复即回归**。主 provider 自愈,冷却期(默认 30s)过后 half-open 探针成功,
   断路器关闭(`breaker_close`),路由弹回主,健康投影清空——面板不再有黄条。

## 三条不可破边界(在这里都看得见)

- **① 热路径零 LLM**:选下一候选 / 开断路器全靠 `classifyLlmError` + 计时器 +
  候选顺序,零模型调用。「智能」在候选**排序**(便宜/本地打头、强模型兜底,或同能力
  并排),不在「现场用大模型选路」——那需要 LLM 分类器,是被禁的热路径 LLM。
- **② opt-in 字节不变**:不声明 `fallbacks` 就是今天的单 provider,逐字节一致;
  降级是**显式声明候选链**才有的行为。这个 demo 是配了两候选才有的路径。
- **③ 内核零改动**:`RoutingProvider` 在 `@gotong/llm` 平级包(只依赖同包
  errors/types),Hub 不认识 `fallbacks` 字段;健康投影在 host 层。
  core/workflow/protocol **零改动、零新 env 旋钮**。

## 对照生产件

本 demo 刻意只引**公共包** `@gotong/llm` + `@gotong/host/routing-health`(host
主 index 会跑 main.ts 副作用,故走子路径导出,同 [`reallife-oauth`](../reallife-oauth)
只引公共包的先例):真 M1 核 + 真 M3 tracker 在底下跑,只把装配缝摊平在一个文件里。
它们薄到不可能和 host 真件跑偏;host 真件另有自己的单测把关。

| demo 内联件 | 生产真件 |
|---|---|
| 两个 stub provider(会抖的主 / 稳的备) | 真 `@gotong/llm-anthropic` / `@gotong/llm-openai` provider(vendor SDK 翻译) |
| 手搭 `new RoutingProvider({candidates})` | `packages/host/src/local-agent-pool.ts` 的 `buildRoutedProvider`(M2:从成员 `fallbacks` 配置派生候选链,覆盖全 managed agent,不配 = 单 provider 字节不变) |
| `tracker.record('butler', ev)` | 同一行装配缝在 pool 的 `new RoutingProvider({onEvent})` 里(M3:每 agent 每候选折叠事件) |
| `tracker.snapshot()` 打印 | `packages/host/src/admin-health.ts` 的 `HealthSnapshot.routing` → 面板 `admin-src/main.js` 黄条渲染(M3) |

## 更多

- 计划 / 侦察 / 逐里程碑设计:[`docs/zh/MODEL-ROUTING.md`](../../docs/zh/MODEL-ROUTING.md)
- 错误分类地基(CARE-M1):`packages/llm/src/errors.ts`
- 二元断供播报(CARE-M7,本 track 超越的对照物):`packages/host/src/admin-health.ts` 的 `llmOutage`
