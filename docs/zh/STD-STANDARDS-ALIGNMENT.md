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

### STD-M2a 消费侧验签:`gotong peer-card` 打 ✓/✗ ✅(as-built)

发现≠信任在这里长第一颗牙——建边前先能验一验对方名片的完整性。

- **前置抽取**(使能这一步的架构动作):纯 JWS/JCS/verify 核从 host 的
  `agent-card-signing.ts` 移到 **`@gotong/a2a`** 新 `card-signature.ts`
  (`jcsCanonicalize` / `signAgentCard` / `attachSignature` / `buildJwks` /
  `verifyAgentCardSignature` / `readCardSignatureHeader` / `es256Sign` /
  `ecThumbprint`);host 只留 file-backed `FileAgentCardSigner` 并回引 +
  re-export(既有 import 面零改)。这样 **cli 复用验证器而不依赖 host 装配
  层**——cli 加 `@gotong/a2a`(kernel)依赖是合法方向,kernel-deps 门绿。
- **`gotong peer-card <url>` 验签**:取到带 `signatures[]` 的卡时,读
  protected 头的 `jku`(缺则回落 `<对端源>/.well-known/jwks.json`)拉 JWKS,
  调 `verifyAgentCardSignature` 打印 **✓ 完整性已验证** / **✗ 验证失败** /
  **⚠ 无法验证**(拿不到 JWKS/jku 非 http)/ **未签名**。✓ 永远带一句
  **「只证明没被篡改、与自报公钥一致,不代表签发者就是对方本人」**。
- **签名裁决是 advisory,不改出码**:出码仍只反映 preflight 有没有完成(取
  到卡即算),✗ 是「发现」不是「preflight 失败」——契约稳定,不把信任判决
  塞进出码;真要严格可留 `--require-valid-signature` 旗标日后加。
- **会红的门**:a2a 12 单测(含独立 node:crypto round-trip、篡改即失败、
  `readCardSignatureHeader` 解 jku/kid)+ cli 5 单测(✓/未签名/✗/JWKS 不可
  达/jku 回落,URL 路由 fetch 注入)+ 真 bin×真签名 host e2e 冒烟 5 断言。

### STD-M2b 信任锚定:owner 显式 PIN 公钥

**信任姿态(已定默认)**:走 **owner 显式确认才 PIN、永不自动信任**(贴合
发现≠信任),而非 TOFU 首见即锁。没 PIN 的 peer 照旧靠 token 握手(今天的
兜底不退化)。PIN 永远是显式动作。分两步落地:

#### STD-M2b-1 a2a 硬化 + cli `--expect-kid` 独立复验 ✅(as-built,无 schema)

先把「拿名片对锚定公钥」的能力做成**不依赖 identity 状态的独立断言**——
owner 手上有锚定 kid(带外记的),就能随时 `peer-card <url> --expect-kid <k>`
复验对端签名钥有没有换。

- **a2a 侧硬化(pin 绑真实指纹,不认可伪造的 header 标签)**:
  `verifyAgentCardSignature` 成功时多返回 `keyThumbprint`(**重算**的验签
  密钥 RFC 7638 指纹);新 `verifyCardKidMatches(card, jwks, pinnedKid)` 返回
  `match | mismatch | unsigned`,比的是 `keyThumbprint === pinnedKid`,**绝不**
  信 protected 头里那个可被撒谎 JWKS 伪造的 `kid` 标签。载重测:**撒谎 JWKS
  防御**——攻击者用受害者 kid 当标签签卡、JWKS 里把自己的钥也标成那个 kid,
  签名能验过,但重算指纹是攻击者的,`verifyCardKidMatches` 如实报 mismatch。
- **cli `gotong peer-card <url> --expect-kid <kid>`**:验签之外多打一行 `锚定`
  —— 一致 `✓ 与你锚定的公钥一致`;不符 / 没签名 / 拿不到 JWKS(无法确认)一律
  `⚠`。**这是显式断言,改出码**:不符 = 出码 **3**(区别于 preflight 未完成的
  1),好让脚本 `peer-card <url> --expect-kid <k> && 重连` 卡在钥变了的时候。不
  带 `--expect-kid` 时行为与 M2a 逐字节一致(advisory、出码不变)。
- **会红的门**:a2a `verifyCardKidMatches` 4 单测(含撒谎 JWKS 防御)+ cli 6
  单测(一致/不符 exit 3/`=` 形式/未签名/JWKS 不可达/缺值 usage)+ 真 bin×真
  签名 host e2e 冒烟加 3 断言(一致 exit 0、不符 exit 3、打印「不符」)。

#### STD-M2b-2 identity 落 PIN + web admin 捕获/显示 ✅(as-built)

把锚定 kid 从「owner 脑子里带外记的」落成 hub 状态的一部分:owner 在联邦
面板 **显式** 填,存进 peer 记录,列表 + 面板显示。

- **identity**:`peers` 表加可空 `pinned_kid` 列(schema **v35** additive 迁
  移;公钥指纹 **不是密钥**,故进列不进 vault,续「凭证进 vault 不进列」纪
  律)。PeerRow / `AddPeerInput` / `UpdatePeerInput` / `PeerRegistration` 全
  线穿 `pinnedKid`——**undefined 保留、显式 null 清除**(同 `label` 契约)。
  NULL = 无锚,identity 靠 token 握手,与今天逐字节一致。
- **web**:`POST/PATCH /api/admin/identity/peers` 捕获 `pinnedKid`——校验
  **RFC 7638 43 字符 base64url shape**(防粘贴错:一个 typo'd pin 会永久假
  性不符),`null` 清除;list DTO 暴露(面板可显示)。admin 联邦面板策略编辑
  器加「锚定签名公钥」输入(预填现值 / 显示 / 编辑 / 保存,空=清除)。**pin
  是 advisory**:pin-only 编辑走 `invalidate` **不重拨**(它从不碰 mesh 门
  控),这条被单测钉死。
- **会红的门**:identity `peers.test` 4 例(默认 null / round-trip / 保留-替
  换-清除 / 与策略字段独立)+ web 5 例(POST 持久化 + list 暴露 / 默认 null /
  坏 shape→400 / PATCH set→clear / **pin-only 不 `refreshPolicy`**)。identity
  616 / web 1276 / host 1882 全绿,四门 PASS(旋钮仍 106,无新增)。

#### STD-M2b-3 面板内实时「匹配/不符」徽章(显式推迟,待定 card URL 来源)

面板内实时徽章需**服务端**取对端 HTTP 名片 + JWKS,用 `verifyCardKidMatches`
对存下的 pin 复验。但 peer 存的 `endpointUrl` 是 **wss mesh 地址**,名片却在
另一端口/协议的 well-known —— 无法从 wss 稳妥推导 card URL。补它要么给 web 开
**新的出站 fetch 面**(含 SSRF 面)+ 决定 card URL 从哪来(admin 粘贴 / 另存
一列),是真架构岔口,不擅自拍。**验证能力其实已交付**:M2b-1 的 `gotong
peer-card <url> --expect-kid <kid>` 就是这颗徽章的 CLI 形态——面板现已显示
pin,owner 复制去 CLI 即可复验。是否要面板内一键徽章、card URL 怎么来,待用户
拍板再上。

### 远期(观察不做,只记账)

名片之外的签名表面(如 signed task result)、其他标准生态强化项——按真需
求牵引,不预造。

---

## 五、验收纪律(同 NET)

- 一个 M = 一个 commit;规划→开发→测试→commit→下一项。
- 每个 M 至少一道**会红的门**(单测 / e2e / 冒烟),红过再绿才算数。
- **opt-in 默认字节不变**每轮回归(unsigned 路径单测 + guards 旋钮登记门)。
