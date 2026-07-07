# STD — 面向未来·标准对齐 track

> 北极星第 3 层「适配 = 跟得上 AI 快速发展」的具体抓手:把 Gotong 对外
> 表面(先从 hub 名片起)逐一接上**开放标准的可选强化项**,让它能被任意
> 标准生态的 verifier 直接验证 / 消费,不锁死自家格式。
>
> 每一项都 **opt-in**(默认字节不变),每一项都守 **发现≠信任**。
>
> Last updated: 2026-07-07

---

## 一、为什么这个 track

北极星第 2 层(跨组织协作)与第 3 层(框架适配)交汇处:hub 要跨边界工
作,它的**对外表面**——名片 / 身份 / 能力声明——越贴近开放标准,别人接
入的成本越低、越经得起生态演进。

现状(NET track 收口后):A2A v1.0 的 hub 名片已经在了——`NET-M4` 把名片
升成一张真 A2A v1.0 `AgentCard`(挂 `/.well-known/agent-card.json`),
`NET-M5` 的 `gotong peer-card <url>` 能拉对端名片做发现 preflight。但名片
是**对端给的不可信输入**:发现≠信任那道线,目前只靠建边时 token 握手兜
底(名片被篡改 = 读到假介绍,建边时 token 对不上就拆穿)。

A2A v1.0 给了更强的一环:**Signed Agent Cards**——名片自带 JWS 签名 +
一个 JWKS 公钥端点,让「这张卡没被篡改」可被**任意 A2A verifier 独立验
证**,不必先跟我方建边。这个 track 就是把这类强化项逐一接上。

---

## 二、两条不可破边界(与 NET 同源)

1. **opt-in = 默认字节不变**。每个强化项一个开关,unset 时对外表面与今
   天逐字节一致。标准对齐是「能力」不是「行为分叉」:没开的 hub 照旧跑,
   开了的 hub 只是多一层可验证性。每轮都回归这条(unsigned 路径单测钉死)。

2. **发现≠信任**。签名只证明「这张卡由持有某私钥者签发、未被篡改」。它
   **不**证明「这个私钥真的属于 hub X」。身份锚定(把公钥 / kid PIN 到
   某个已知 peer)是**消费侧 + onboarding** 的活(M2),永不因为「卡有签
   名」就自动建边或自动信任。签名给**完整性**,不给**身份**。

---

## 三、标准依据(2026-07-06 侦察,实施前重核)

权威源:`a2aproject/A2A` repo —— `specification/a2a.proto`(`signatures`
= `AgentCard` 的 repeated field 13)+ `docs/specification.md §8.4 Signing
and Verifying Agent Cards`。要点:

- **签名结构** `AgentCardSignature { protected(REQUIRED, base64url 的 JWS
  protected header)、signature(REQUIRED, base64url)、header(可选,
  unprotected) }`;`signatures[]` 是名片顶层字段。
- **detached-payload flattened JWS**。签名输入 =
  `ASCII( BASE64URL(protected) || '.' || BASE64URL( JCS(名片去掉 signatures 字段) ) )`。
  签名不把 payload 塞进自己(卡本体就是 payload),故 detached。
- **规范化 = RFC 8785 JCS**:对象 key 字典序、无空白、**排除 signatures
  字段**、省略默认值非必填字段。名片本身没有数字字段,JCS 对我们退化成
  「递归 key 排序 + `JSON.stringify`」;为稳妥仍防御性拒绝非有限数字。
- **protected header**:MUST 有 `alg` + `kid`,SHOULD 有 `typ:"JOSE"`,
  MAY 有 `jku`(JWKS URL,让 verifier 自己去取公钥)。
- **kid = RFC 7638 JWK thumbprint**:SHA-256 over 规范 EC JWK
  `{"crv":..,"kty":..,"x":..,"y":..}`(成员字典序),base64url 无填充。
  钥不变则 kid 不变,天然稳定标识。
- **算法选 ES256**(不是 EdDSA):verifier 支持面最广、是 spec 的首个示
  例。Node `crypto.sign('sha256', input, {dsaEncoding:'ieee-p1363'})` 出
  raw `r‖s`(JWS 要求的定长拼接,不是 DER)。**零外部依赖**,全走
  `node:crypto`。
- **签名是可选的**;但 spec 明说:客户端 **SHOULD** 在信任前验证至少一个
  签名——这正是 M2 消费侧要做的。

出处:[A2A spec](https://a2a-protocol.org/latest/specification/) ·
`a2aproject/A2A` `docs/specification.md §8.4`。

---

## 四、路线图

### STD-M1 生产侧:名片签名 + JWKS ✅(as-built)

opt-in `GOTONG_A2A_SIGN_CARD`(默认关;第 106 个旋钮,已登记)。

- **`packages/host/src/agent-card-signing.ts`**(新,crypto 核):
  - `jcsCanonicalize` = 递归 key 排序 + `JSON.stringify`,非有限数字 /
    不支持类型当场抛(绝不静默签出错的 payload)。
  - `FileAgentCardSigner`:ES256,`.gotong/agent-card-signing.key` 存
    0600 PKCS#8;首用生成、重载复用(kid 跨重启稳定);非 EC / 坏钥文件
    当场拒——**MasterKeyProvider 同姿态,fail-closed 绝不静默换钥**。
    `kid()` = RFC 7638 thumbprint。
  - `signAgentCard` / `attachSignature` / `buildJwks` + **可复用
    `verifyAgentCardSignature`**(M2 消费侧现成拿来用)。
- **`createAgentCardSurface` 工厂**(从 `main.ts` 名片闭包抽出,顺手把
  行数预算腾出 7 行):signer 非空则 `attachSignature` + `jku` 指向
  `/.well-known/jwks.json`;signer 为 null 则名片**根本没有 signatures 字
  段**(字节不变路径,单测钉死)。
- **web:`GET /.well-known/jwks.json`**(鸭子 surface `jwks()` 注入,web
  零 host 运行时依赖;405 非 GET / 404 未签 / 200 + `cache-control:
  public, max-age=300`)。
- **会红的门**:
  - host 14 单测,重头是**独立 node:crypto verifier round-trip**——只用
    `node:crypto` + 文档算法从头重建签名输入并验签通过,证明「一个从没碰
    过咱代码的 A2A verifier 能验到咱的字节」,这才是「标准对齐」的硬定
    义;外加篡改任一字段即失败、JCS 确定性、kid 稳定、unsigned 字节不变。
  - web 9 单测(jwks 路由 404/200/405 全分支)。
  - 真 HTTP e2e 冒烟(`scripts` 外的 scratch 不入库):真 `serveWeb` + 真
    `FileAgentCardSigner` + 真 `createAgentCardSurface`(逐字复刻
    `main.ts` 接线),curl 两端点 + 独立验签 + 改名验签失败,9 断言全过。

### STD-M2 消费侧:验签 + 信任锚定(下一步)

发现≠信任在这里长牙:

- **`gotong peer-card <url>` 验签**:取到带 `signatures[]` 的卡时,按
  `jku` 拉 JWKS,调 `verifyAgentCardSignature` 打印 ✓/✗——但**明说**「✓
  只代表这张卡没被篡改,**不代表**签发者就是对端本人」。
- **peer onboarding 可选 PIN 公钥 / kid**:`mint-peer-token` + 双边登记
  时,把首次见到的 kid 记进 peer 记录(TOFU 或 owner 手动确认);之后名
  片若换了 kid / 签名对不上 PIN → warn / 拒。**这才是「这真的是 hub
  X」的身份锚**。
- **边界**:PIN 是**显式动作**,永不自动;没 PIN 的 peer 照旧靠 token 握
  手(今天的兜底不退化)。

### 远期(观察不做,只记账)

名片之外的签名表面(如 signed task result)、其他标准生态强化项——按真需
求牵引,不预造。

---

## 五、验收纪律(同 NET)

- 一个 M = 一个 commit;规划→开发→测试→commit→下一项。
- 每个 M 至少一道**会红的门**(单测 / e2e / 冒烟),红过再绿才算数。
- **opt-in 默认字节不变**每轮回归(unsigned 路径单测 + guards 旋钮登记门)。
