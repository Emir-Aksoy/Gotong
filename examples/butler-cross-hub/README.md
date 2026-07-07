# butler-cross-hub — 管家出网(北极星第 1+2 层握手)

个人管家(「我的 AI」)把「我」接进 mesh(跨 hub 协作):

```
成员> 帮我问一下爸爸的 hub 今晚有没有空。
[/me 收件箱] 出网询问对端「hub-dad」:今晚有空吗?   ← 先停成员自己的确认闸
[成员批准 ✅]
管家> 帮你问到了 — 对端「hub-dad(爸爸的 hub)」回复:有空,回来吃饭。
```

一进程起两台真 hub(`hub-me` 有管家和成员,`hub-dad` 有一个应答
agent),中间是**真 `installPeerLink`**(真 RemoteHubViaLink wrapper:
出站白名单闸 + origin 盖章都是生产件,不是 mock)。确定性 mock LLM,
无需 API key。

```bash
pnpm demo:butler-cross-hub
```

## 它证明什么

1. **问 → park**:出网是 cross_hub 级动作,管家的 governed `ask_peer`
   永远先停成员自己的 `/me`——**未批前零字节出网**(demo 里对端计数
   为 0 是硬断言)。
2. **批准 → 跨界 → 答案回同一轮**:capability 派发穿过真 wrapper,
   wrapper 给 task 盖**真 origin**(`{orgId:'hub-me', userId:'user_me'}`,
   不是 `'local'` 不是空)——对端知道是「哪台 hub 的哪个人」在问。
3. **拒绝 → fail-closed**:成员拒了,对端永不被联系,管家如实说没发。
4. **未策展边 → classify 当场拒**:跨 hub 寻址只有 capability 一条路
   (wrapper 原样转发 strategy,对端按同一 strategy 重派;explicit 指
   我方 wrapper id 过线后无人认领)。未策展(`outboundCaps=null`)的边
   广告为空、根本路由不出去,诚实答案是当轮拒绝 + 指路「请管理员策展」
   ——不浪费一次审批,也不假装有路。

## 双闸各守其主

本 demo 演的是**成员闸**(「我真的要把这句话发出去吗」)。生产里若这条
边还配了 `requireApprovalOutbound`,wrapper 会再被 owner 审批闸装饰
(「这条 org 边允不允许出站」)——成员批完 owner 闸又停时,管家如实
告诉成员「还差 hub 管理员一道」。那半截见
`packages/host/tests/butler-ask-peer-e2e.test.ts` 场景 ④,以及
[`cross-hub-workflow`](../cross-hub-workflow) 里 owner 闸本体的演法。

## 对照生产件

本 demo 刻意 host-free(与 `cross-hub-workflow` / `personal-butler`
同先例),把肌理摊开在一个文件里:

| demo 内联件 | 生产真件 |
|---|---|
| ~50 行 `askPeerToolset` | `packages/host/src/personal-butler-ask-peer.ts`(完整派发阶梯:capability 参数选择、本地抢路/多边歧义只读预检、execute 姿态重解析、六种 TaskResult 诚实文案) |
| 常量 `ROSTER` | NET-M1 `buildButlerPeerSurface` 的脱敏投影(`list_peers` 同一份名单,不漂移) |
| `catch SuspendTaskError` + `onResume` | host `suspendNotifier` → `/me` 收件箱 → `HostInboxService.resolve` |
| `installPeerLink({outboundCaps, remoteCapabilities})` | `peer-registry` 逐字同款(G-M1 advertise = authorize:策展列表既是广告又是授权) |

两台真机复刻:照 [`docs/zh/FEDERATION-RUNBOOK.md`](../../docs/zh/FEDERATION-RUNBOOK.md)
配平 peer + 策展 `outboundCaps`,成员在 IM 里对管家说同一句话即可。
