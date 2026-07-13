# graded-trust — 分级信任 track（GT）capstone

> 一条边的信任是**长出来的**,审批摩擦随它变。整条 GT 链一个确定性脚本跑完:
> **零网络、零 API key、零 LLM**。

```bash
pnpm demo:graded-trust
```

## 它证的事(四幕)

一条刚跟对端 `hub-B` 完成 token 握手的边,从陌生走到信任;同一组出站动作
(只读 / 读日历 / 付款 / 未授权能力)在每一幕重新裁决,看审批重量怎么一路变轻——
**但最危险那格的确认底线,任何档都不塌**。

| 幕 | 发生什么 | 证的边界 |
|---|---|---|
| **1** | 新 peer 落 `DEFAULT_TRUST_TIER` = **T1**;矩阵在 T1 对每个动作都要人 | **fail-closed 地板**:默认拒绝、步步审批 |
| **2** | owner PIN 签名钥、复验 `pin_verified` → `suggestTierFromIdentity` 建议 **T2**;**但建议 ≠ 自动升**——owner 点头前生效档仍是 T1、矩阵仍按 T1 裁决;点头后才落 T2,「读日历」审批 `member_approve → member_notify` 变轻 | **纯软连接**(岔口 3):升降档永远是人的决定 |
| **3** | owner 显式提升 **T3**;摩擦进一步降,但「付款」即使 T3 仍要 `member_notify` 留痕、**永不 auto**;forbidden 恒拒 | **信任只降摩擦,永不去掉确认底线** |
| **4** | 现在 T3 的 `hub-B` 引荐全新 `hub-Z` → `suggestTierFromReferral` 建议初始档 = **地板 T1 而非 T3**;不够格(< T2)的引荐人则产出 `null` | **信任不传递**(岔口 4) |

## 底下是真的框架件

`@gotong/core` 的五个生产纯函数,一行没重写:

- `decideTrust(tier, risk)` —— 矩阵裁决(GT-M1)。就是决策矩阵那张表,逐格。
- `decisionRequiresHuman(decision)` —— 把裁决分流成「要不要人介入」。
- `suggestTierFromIdentity(current, 'pin_verified')` —— 纯软连接建议(GT-M4)。
- `suggestTierFromReferral(referrerTier)` —— 引荐建议(GT-M5)。
- `DEFAULT_TRUST_TIER` —— fail-closed 地板 T1(GT-M2)。

**什么都没 stub**:这四幕的每一个断言,都是真函数的真返回值。

## 关键洞

- **矩阵审批阈值随档变**:同一个「读日历」,T1=成员审批(重)→ T2=成员一键(轻)→
  T3=自动。同一个「付款」,T1=owner 审批 → T3=成员一键——但**不是** auto。信任调的
  是「确认的重量」,动作风险定的是「是否需要确认」的底线。
- **建议买不过 owner**:PIN 成功 / 引荐都只产出**建议**,`edge.tier` 只被 owner 的
  显式落档改写。这是「声明 ≠ 信任」在**本地**的证明;它在 **wire** 上的孪生证明
  (「错 token 声明 T3 仍零捕获」)由 `packages/transport-ws` 的 GT-M6 单测另给。
- **信任不传递**:哪怕引荐人是我给的最高档 T3,新边也只建议地板 T1——「X 是 T3 所以
  Z 也 T3」被结构性禁止。

## 深入

- 计划 + 七决策 + 分档 + 矩阵 + 边界:[`docs/zh/GRADED-TRUST.md`](../../docs/zh/GRADED-TRUST.md)
- 分级上 wire(声明字段 + 公网协商语义):[`docs/zh/MESH-PROTOCOL.md`](../../docs/zh/MESH-PROTOCOL.md) §6 / §10
