# Hub-Mesh Wire 协议规范（v1）

> **文档地位**:**公开 wire 规范**(normative)——描述两个 Gotong hub 之间那条
> 对称 mesh 边**在网线上实际跑的字节契约**。任何第三方实现只要遵此规范,就能
> 与 Gotong hub 的 mesh 面互通。
>
> 与它相关但**不是**它的两篇:
> - [`HUB-MESH.md`](HUB-MESH.md) 是 2026-05 的**设计文档**(为什么要对称 mesh、
>   feedback ledger、reputation 的动机),本规范是它落地后的 **wire 真相**。
> - [`../PROTOCOL.md`](../PROTOCOL.md) 是 **agent ↔ hub** 的 wire 协议(一个
>   participant 怎么接进一个 hub)。本规范是 **hub ↔ hub**,是**另一层**、
>   另一套帧、另一条版本线。两者不混。
>
> **实现** `packages/transport-ws/src/hub-link.ts`(`MeshFrame` 联合类型 +
> `WebSocketHubLinkImpl` 状态机)。
> **Last updated** 2026-07-13(GT-M6:加入分级信任 advisory 声明字段)

---

## 1. 三层协议地图 —— 本规范在哪一层

Gotong 对外有三个**互不混淆**的协议表面。理解分层是理解本规范的前提:

| 层 | 谁 ↔ 谁 | 规范 | 版本语义 | 信任锚 |
|---|---|---|---|---|
| **Agent 接入** | participant ↔ hub | [`PROTOCOL.md`](../PROTOCOL.md) v1.2 | SemVer 容忍(minor 前后兼容) | hub 的准入闸(admission) |
| **Hub Mesh(本规范)** | hub ↔ hub | 本文 v1 | **精确字符串** `'1'`,不匹配即拒 | **per-edge bearer token**(`auth` 信封) |
| **A2A 名片发现** | 任意 ↔ hub 的 `.well-known` | A2A v1.0 + [`STD-STANDARDS-ALIGNMENT.md`](STD-STANDARDS-ALIGNMENT.md) | A2A 标准自带 | **纯发现,零信任**(见 §7) |

**为什么 mesh 用精确字符串版本、agent 层用 SemVer**:agent 层要容忍大量异构
client 长期共存(手机、CLI、第三方 SDK),故容忍 minor 差异;mesh 层是**受控的
hub↔hub 边**,两端都是 Gotong 二进制或声称兼容的实现,协议演进走显式握手协商而非
「猜」,故 `MESH_PROTOCOL_VERSION` 是精确 `'1'`,任何不等一律 `protocol_version_mismatch`
拒绝握手。这条纪律很重要:**mesh 版本号是否需要跳到 '2',是判断某个新字段是否
「承重」的试金石**——见 §6 分级信任声明为什么**不**跳版本。

---

## 2. 传输与编码

- **传输**:WebSocket(`ws://` 或 `wss://`;生产必须 `wss://` + TLS)。
- **帧编码**:每个 WebSocket message 是**一个 JSON 对象**,即一个 `MeshFrame`。
  UTF-8 文本帧。无分片、无二进制。
- **对称**:一条边建立后,**两端平等**。谁都能 `dispatch` 任务给对方、`publish`
  消息、`pull` 反馈。没有「上游 / 下游」「客户端 / 服务端」的语义不对称——只有
  握手期有**发起方**(OUT,发第一帧)和**接受方**(IN,回 ACK)的角色区分,握手一
  完成角色即消失。
- **共享端口 demux**:生产 host 让 agent 协议与 mesh 协议**共用一个 WebSocket
  端口**。接受方对每个新 socket **peek 第一帧**:若是 `MESH_HELLO` → 交给 mesh
  握手;否则 → 交给 agent `Session`。(历史:FED-1 修复了两个 `'connection'`
  监听器无 peek 抢 socket、把对端 `MESH_HELLO` 首帧当非法帧 `terminate()` 掐死
  握手的 bug——单端口联邦从此才真正握手成功。未接 mesh 的纯 agent host 走
  byte-identical 快路径。)

---

## 3. 版本

```
MESH_PROTOCOL_VERSION = '1'   // 精确字符串常量
```

握手两帧(`MESH_HELLO` / `MESH_HELLO_ACK`)都**必带** `protocolVersion`。接受方与
发起方各自校验:`frame.protocolVersion !== '1'` → `rejectHandshake` +
`transitionToClosed('protocol_version_mismatch')`,不回任何解释帧。

**新增可选字段不跳版本**:一个 v1 peer 必须**忽略它不认识的字段**并继续互通。
因此**向后兼容的可选字段**(如 §6 的分级信任声明)**在 v1 内引入,不跳 '2'**。
反过来:任何要求对端**理解才能正确工作**的字段,才需要 bump 版本——这是判断一个
字段是否「承重」的结构性标准。

---

## 4. 握手

```
   OUT 侧(发起)                              IN 侧(接受)
   ────────────                              ────────────
   连上 ws
   sendHello() ──── MESH_HELLO ────────────►  校验(见下序)
                    {peerId, protocolVersion,
                     auth?, trustTier?}
                                              ◄──── MESH_HELLO_ACK ───
   校验(见下序)                                 {peerId, protocolVersion,
   link 状态 = open                              auth?, trustTier?}
                                              link 状态 = open
   ── 双向对称,任一方可 dispatch/publish/pull ──
```

### 4.1 IN 侧收到 `MESH_HELLO` 的裁决序(严格顺序)

1. **方向**:只有 IN 侧合法收 HELLO(`direction !== 'in'` → 静默 return)。
2. **状态**:必须 `connecting`。已 open 再来一个 HELLO = buggy peer 或攻击者想
   改写 `_peerId`,静默 drop(Audit #143)。
3. **版本**:`protocolVersion` 精确等于 `'1'`,否则拒(见 §3)。
4. **peerId**:若本端配了 `expectedPeerId`,`frame.peerId` 必须一致,否则
   `peer_id_mismatch` 拒;未配则接受对端自报的 peerId。
5. **认证**(`auth` 信封):`verifyPeerAuth(frame.auth, frame.peerId)`。**失败即拒,
   拒在回 ACK 之前**——错 token 的 peer 永远看不到我方 `selfId` / 我方 token
   (anti-enumeration:攻击者无法用「格式对 vs 值对」的错误文本差异探测有效凭证)。
   IN 侧内部记录精确原因供运维,但**不上线**。
6. **分级信任声明**(GT-M6,§6):**仅在认证通过后**,`_peerDeclaredTrustTier =
   isTrustTier(frame.trustTier) ? frame.trustTier : null`。未知值 → null。被拒的握手
   **永不**记录它。
7. **落定**:`_peerId = frame.peerId`,回 `MESH_HELLO_ACK`(带我方 `auth` 应答 +
   我方可选 `trustTier` 声明),`status = 'open'`,起 keepalive。

### 4.2 OUT 侧收到 `MESH_HELLO_ACK` 的裁决序

对称:状态必须 `connecting` → 版本精确 → `expectedPeerId`(若配)→ 验对端 `auth`
(闭合互认环:我方 token 已在 HELLO 发出且对端接受了,现在轮我验它的)→ 捕获对端
`trustTier` 声明(同 §4.1 步 6 纪律)→ `_peerId` + open。

### 4.3 认证信封 `auth`

`auth?: { scheme, credential }`(见 `peer-auth.ts`)。缺省 = 本端不出示凭证,且
**只有本端也没配 auth scheme 时才接受**对端无凭证;一旦本端配了 scheme,缺失或不
匹配的信封是**致命握手错误**(fail-closed)。两种构造:

- `bearerAuth({ token })` —— 共享预置密钥(FED-M1)。
- `bearerAuth({ resolver })` —— per-peer 查表(从 `identity.peers` + vault 解析
  每条边独立的密钥)。IN 侧两个都传时 resolver 赢。

**空字符串 token 在 scheme 构造时即抛**(防 `MY_TOKEN=` 环境变量误设成零长密钥)。

---

## 5. 帧目录(`MeshFrame` 全集)

| 帧 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `MESH_HELLO` | OUT→IN(握手首帧) | `peerId, protocolVersion, auth?, trustTier?` | 发起握手 |
| `MESH_HELLO_ACK` | IN→OUT(握手回帧) | 同上 | 接受握手 |
| `MESH_TASK` | 任一向 | `task` | 派一个 task 给对端 |
| `MESH_RESULT` | 回帧(按 `task.id` 配对) | `result` | task 结果回流 |
| `MESH_MESSAGE` | 任一向 | `message` | fire-and-forget 频道消息 |
| `MESH_PULL` | 任一向 | `callId, forPeerId` | 「把你写给 hub `forPeerId` 的反馈给我」 |
| `MESH_PULL_RESULT` | 回帧(按 `callId`) | `callId, entries[]` | 反馈条目(对端已标 delivered) |
| `MESH_RECEIPT` | 任一向 | `entryIds[], kind:'read'\|'rejected', reason?` | 回执:已读 / 拒收(拒收回滚 reputation) |
| `MESH_RPC_CALL` | 任一向 | `rpcId, method, params` | 细粒度请求(跨 hub MCP 代理等) |
| `MESH_RPC_RESULT` | 回帧(按 `rpcId`) | `rpcId, ok, value?, error?` | RPC 回复 |
| `MESH_PING` / `MESH_PONG` | 任一向 | `ts` | 对称 keepalive(REL-3) |
| `MESH_GOODBYE` | 任一向 | `reason?` | 协作式关闭 |

**keepalive**:任一方可 ping;**任何入站帧**(不只 pong)都算「活着」的证据,故忙碌
的边不会因迟到的 pong 而误关。半开 TCP(吞帧但不产生任何入站流量)在
`maxMissedPings` 个静默周期后被关,不再僵尸游荡。

---

## 6. 分级信任声明(GT-M6)—— advisory 字段与「声明 ≠ 信任」铁律

`MESH_HELLO` 与 `MESH_HELLO_ACK` 各带一个**可选** `trustTier?: 'T0'|'T1'|'T2'|'T3'`
字段。它是本规范里**唯一一个「纯 advisory」字段**,其语义纪律是整个分级信任
(见 [`GRADED-TRUST.md`](GRADED-TRUST.md))在 wire 层的落点,必须逐条守:

1. **它是自报,不是凭证。** 发送方声明「我认为这条边配得上 T3」。接收方把它捕获进
   `link.peerDeclaredTrustTier`(**仅**供该 hub 的 owner 作上下文参考),**永不**
   据此自动改变任何权限、路由或审批阈值。
2. **声明 ≠ 信任(铁律)。** 信任只锚定在**结构上不可伪造**的三个地方:`auth` 信封
   里的 bearer token(证明「你确实持有我发的密钥」)、owner 亲手 PIN 的公钥指纹
   (STD-M2)、owner 自己给这条边打的 trustTier(GT-M3 落库)。一个「我是 T3」的
   wire 自报,**永远**无法把一条边变成 T3。攻击者随便声明 T3 买不到任何东西:
   §4.1 已保证声明**在认证之后**才捕获,被拒的握手零记录。
3. **未知值 → null。** 不认识的档值(未来档、拼写错、敌意值)一律丢成 null,绝不
   当作某个已知档。fail-safe。
4. **缺省 = 与今天逐字节一致。** 不带 `trustTier` 的 HELLO / ACK 与引入本字段前
   完全相同。它是**能力**,不是行为分叉。
5. **不跳版本 = 它不承重的证明。** 正因为一个 v1 peer 忽略它仍能完整互通(§3),
   `MESH_PROTOCOL_VERSION` 保持 `'1'`。反过来说:如果哪天某个字段的正确处理成了
   互通的前提,那才需要 bump——分级声明**故意**不是那种字段。

**接收方拿它做什么?** 目前:只作 owner 上下文显示(「对端自称 T3,你给它评的是
T1」这类信息帮 owner 判断)。**它绝不作为升档的自动理由**——升到 T2 要 owner 亲自
PIN 公钥,升到 T3 要 owner 显式提升(见 GRADED-TRUST 决策矩阵与软连接 GT-M4)。
wire 声明与 owner 裁决之间**只有 advisory 提示,没有自动通路**(岔口 3「纯软连接」)。

> 单测(`packages/transport-ws/tests/hub-link.test.ts`,GT-M6 6 例)钉死全部五条:
> 双向 round-trip 捕获、未知值落 null、缺省落 null、以及**铁律**——错 token 却声明
> T3 的 HELLO 仍以 `peer_token_invalid` 关闭、`onLink` 永不触发、零捕获。

---

## 7. A2A 名片保持纯净(分层的另一半)

分级信任是 **mesh 层**的一等公民,**不下沉到 A2A 名片**。两层各司其职:

- **A2A 名片**(`/.well-known/agent-card.json`)= **发现**。「这个 hub 是谁、声明了
  哪些 skills、用什么接口」。它遵 A2A v1.0 标准,可选 ES256 签名(STD-M1)给
  **完整性**,可选 owner PIN 公钥(STD-M2)给**身份确证**。但它**不掺任何 Gotong
  私有的 trustTier 语义**——一个外部 A2A 消费者读咱的卡,看到的是标准 A2A,不是
  「Gotong 分级」。**发现 ≠ 信任**:名片有签名也永不自动建边。
- **Mesh wire**(本规范)= **协作 + 分级信任**。trustTier 声明只活在这里,且只作
  advisory。

**为什么分层**:让 A2A 卡纯净,咱的发现面就永远跟得上 A2A 标准演进、外部工具零摩擦
消费;让分级信任留在受控的 mesh 边,它的语义(fail-closed、owner 裁决、矩阵审批)
就不必塞进一个为「公开发现」设计的标准里去扭曲它。两层不混,是决策 5 的地基。

---

## 8. 安全模型小结

| 属性 | 机制 |
|---|---|
| **互认证** | per-edge bearer token,握手双向验,fail-closed |
| **anti-enumeration** | 错 token 拒在回 ACK 前,不泄露 selfId / token,错误文本不区分格式/值 |
| **anti-mutation** | 已 open 的 link 再收 HELLO/ACK 静默 drop,`_peerId` 不可被二次改写 |
| **rate-limit** | 握手前 per-IP `onConnectionAttempt` 钩子,失败计重,可挡 HELLO 洪水 / token 爆破 |
| **半开检测** | 对称 keepalive,`maxMissedPings` 静默周期后关僵尸边 |
| **信任锚** | token(持有证明)+ owner PIN 公钥(身份)+ owner trustTier(授权档);wire 自报**永不**是锚 |
| **fail-closed 默认** | `outboundCaps` 未授权即拒(GT-M2 反转);trustTier 未分级回落地板 T1 |

**不设防**(继承 HUB-MESH §8 的显式排除):Discovery/DHT(用户自己连边)、多跳路由
(故意保守,单跳)、拜占庭容错(假设连进来的 peer 是 owner 认可的——但**认可的粒度**
正是分级信任要细化的)。

---

## 9. 一致性检查清单(第三方实现自检)

一个声称兼容 Gotong mesh v1 的实现,至少要过:

1. 发 `MESH_HELLO` 带 `protocolVersion:'1'`;收到非 `'1'` 的 HELLO/ACK 必须拒。
2. 配了共享 token 时,HELLO/ACK 必带 `auth` 信封;验对端信封失败必须**拒在回帧前**。
3. 收到不认识的可选字段(如 `trustTier`)必须**忽略并继续**,不得中断握手。
4. **绝不**因对端 wire 自报的 `trustTier` 自动授予任何权限——它至多是给人看的提示。
5. `MESH_TASK`/`MESH_RESULT` 按 `task.id` 配对;`MESH_RPC_CALL`/`_RESULT` 按 `rpcId`;
   `MESH_PULL`/`_RESULT` 按 `callId`。
6. 对称 keepalive:任何入站帧刷新活性;能响应 `MESH_PING` 回 `MESH_PONG`。

> 面向**公网规模**的分级 + 协商语义(当前实现 vs 未来预留)见 §10。

---

## 10. 公网分级信任模型与协商语义(normative + 预留)

> **本节地位**:把 §6 的 advisory 声明**升格为一个面向公网 agent 网络的分级信任
> 模型**——四档 T0–T3、一张审批摩擦矩阵、以及 hub↔hub 之间「协商」这些档的 wire
> 语义。**每一小节都显式标注 `[当前实现]` 还是 `[未来公网预留]`**,好让第三方能据
> 此判断:哪些今天就能对着实现、哪些是为公网规模预留的、必须先评审再动的语义。
>
> **为什么要有这一节**:一个人手配三五条边可行;当 agent 网络长到成百上千个 hub,
> 「逐条边手配一堆授权字段」结构性不可扩展。必须有**可上协议的档位 + 可协商的声明**,
> 把常见信任形态压成标准化的一次选择。但——贯穿本节的**铁律**——协议承载的永远是
> **声明与协商,不是信任赋予**(§6 已在 wire 层钉死;本节把它推广到整个模型)。

### 10.1 四档 T0–T3 `[模型:当前实现 T0–T3 已落库;门槛见下]`

分级的形状是「**每升一档,要么更多验证,要么更多人工确认**」——即用户要的「安全性
逐步提高、易用性相对逐步降低」。

| 档 | 代号 | 门槛 | 语义 | 落地状态 |
|---|---|---|---|---|
| **T0** | `discoverable` | 只经公开 A2A 名片摸到,**未完成 mesh 握手** | 可发现 / 未联邦,零 mesh 通信 | `[当前实现]` 概念态(未握手的边) |
| **T1** | `token` | 完成**双边 token 握手**(§4 认证信封) | 令牌联邦(**默认地板**),fail-closed | `[当前实现]` = 今天的联邦门槛 |
| **T2** | `verified` | T1 + owner **显式 PIN 了签名公钥**(STD-M2,pinnedKid 验过) | 身份锚定,「确信对端是我认识的那个 hub」 | `[当前实现]` PIN 落库 + CLI 复验 |
| **T3** | `trusted` | T2 + owner **显式提升** | 信任伙伴,矩阵里享最低摩擦 | `[当前实现]` owner 打档落库 |

档值本身(`T0`/`T1`/`T2`/`T3`)是**稳定的公开枚举**,第三方实现可原样引用。

### 10.2 审批摩擦矩阵:动作风险 × 信任档 `[模型:当前实现,阈值精调中]`

分级的**用途**是当一台「注意力节流器」:让人只在「低信任 × 高风险」的少数格子里被
打扰。把**出站动作风险**与**信任档**交叉:

| 出站动作 \ 信任档 | T0 | T1 `token` | T2 `verified` | T3 `trusted` |
|---|---|---|---|---|
| **只读**(inspect / list) | 拒 | 成员一键确认 | 自动放行 | 自动放行 |
| **benign 派活**(读类 capability) | 拒 | 成员审批 | 成员一键确认 | 自动放行 |
| **危险派活**(花钱 / 对外 / 数据出盒) | 拒 | owner 审批 | owner 审批 | 成员一键确认 |
| **forbidden**(未授权 capability) | 拒 | 拒 | 拒 | 拒 |

两条读法凝成协议级不变量,第三方实现**必须**守:

- **同一动作,档越高摩擦越低**(易用性逐步提高);**同一档,动作越危险摩擦越高**
  (安全性守住)。
- **信任只降摩擦,永不去掉确认的底线**:最危险的动作即使对 T3 也要「成员一键确认」
  (可追责留痕),**绝不**变成静默自动;`forbidden` 任何档都拒;**T0 任何动作都拒**。

> 具体格子的阈值是 Gotong 实现细节(`classify` / `outbound-approval` 精调);**结构**
> ——「档调确认的重量,动作风险定是否需要确认的底线」——才是本规范要求外部对齐的部分。

### 10.3 协商语义:声明什么、怎么裁决

这是「把分级写进公网协议」的核心。分四种语义,状态各异:

**(a) 单向 advisory 档声明 `[当前实现,§6]`**
握手帧的可选 `trustTier` 字段:发送方声明「我认为这条边配得上哪一档」。接收方捕获
进 `link.peerDeclaredTrustTier` **仅作 owner 上下文**,永不自动应用。这是今天 wire
上**唯一**跑着的协商语义,也是下面三种预留语义的地基形状(声明 → 捕获 → 人裁决)。

**(b) 最低档要求声明 `[未来公网预留]`**
一个公网 hub 可能想在边上声明「**我要求你至少到 T2 才跟你交互**」(minimum-tier
gate)。预留形状:一个 `requiredTier?` 声明字段,接收方**若达不到**则这条边只能做
到「被要求方实际授予的档」允许的动作——即它是**发起方对自己的约束**(我不跟没验过
我的人做危险事),**不是**强加给对端的权限。当前实现无此字段:等价效果今天由每端
owner 各自的 `outboundCaps` + trust_tier 本地裁决,不上 wire。

**(c) 双向档协商 `[未来公网预留]`**
两个陌生 hub 各自声明「我支持到哪档 / 我要求你到哪档」,一条边的**有效交互档 =
min(A 授予 B 的档, B 授予 A 的档)**。关键——协商**只在两端各自 owner 已授权的范围
内取交集降摩擦**,**永远无法凭空制造授权**:min 只会更严,不会更松。当前实现:无
wire 协商,每端独立按本地 trust_tier 裁决(等价于「各自单边、不取交集」的保守退化)。

**(d) 引荐凭证上 wire `[未来公网预留]`**
GT-M4/M5 的引荐今天是**本地**函数(`suggestTierFromReferral`:可信 peer[≥T2] 引荐
→ 建议新 peer 初始档 = 地板 T1 → owner 确认才落)。公网规模下,预留形状是一个**可
携带的引荐凭证**(如引荐人签名的一小段声明:「我 X,在 T3 信任 Y」),新 peer 握手
时出示 → 接收方 owner 得到一个**预填的初始档建议**。铁律不变:凭证**只降发现 + 初始
配置成本**,**信任不传递**——哪怕引荐人给了 T3,建议初始档也只是地板 T1,升档仍是
接收方 owner 对 Y 的单边决定。当前实现:引荐不上 wire,只在同一 hub 内本地建议。

### 10.4 贯穿铁律:协商承载声明,永不承载信任赋予 `[规范级不变量]`

上面每一种协商语义——现在的和预留的——都**必须**遵守同一条不变量,它是整个公网
分级模型的安全根:

> **信任只锚定在结构上不可伪造处**:`auth` 里的 bearer token(持有证明)、owner
> 亲手 PIN 的公钥指纹(身份,STD-M2)、owner 自己打的 trust_tier(授权档)。**任何
> wire 上的自报、要求、引荐凭证,至多产生一个「给人看的建议」,永不自动改变权限。**

一个自洽的第三方实现,即便将来实现了 (b)(c)(d),也**必须**让「wire 声明 → 生效档」
之间**只有经过本端 owner 裁决的通路,没有自动通路**。这条一旦破,分级就从「注意力
节流器」退化成「攻击者自助升档表」。§6 的 6 例单测(错 token 声明 T3 仍零捕获)是这
条不变量在当前实现里的最小证明;任何预留语义落地时,都要带一条同形状的「声明买不过
owner 裁决」测试。

### 10.5 A2A 名片仍不掺分级 `[分层不变量,见 §7]`

无论公网分级模型演进到哪一步,T0–T3 与协商语义**都留在 mesh 层,不下沉到 A2A 名片**。
名片只做发现(谁、有哪些 skill、什么接口 + 可选签名/PIN 给完整性与身份);分级信任的
语义活在受控的 mesh 边。**发现 ≠ 信任**:这是决策 5「两层不混」的公网版重申。

### 10.6 外部实现自洽性检查 `[针对本节]`

一个声称兼容 Gotong 公网分级模型的实现,至少要能自洽回答:

1. 四档 T0–T3 的枚举值原样支持;T0 = 任何出站动作都拒;T1 = fail-closed 地板。
2. 审批摩擦随「动作风险 × 档」二维变化,且守 §10.2 两条不变量(档降摩擦不降底线、
   forbidden/T0 恒拒)。
3. 任何 wire 协商字段(当前的 `trustTier`,未来的 `requiredTier` / 协商 / 引荐凭证)
   一律**声明语义**:经本端 owner 裁决才生效,**无自动升权通路**(§10.4)。
4. 双向协商(若实现)取 min,**只更严不更松**;引荐(若实现)**信任不传递**,建议
   初始档恒为地板。
5. 分级语义不出现在 A2A 名片里(§10.5)。

> **成熟度声明(诚实边界)**:§10.1/10.2 的档与矩阵、§10.3(a) 的单向声明是 `[当前
> 实现]`;§10.3 的 (b)(c)(d) 是 `[未来公网预留]`,**尚无 wire 字段、尚无跨实现评审**,
> 列在此是为给公网演进钉一个**方向 + 不可破的铁律**,不是承诺的即用接口。动它们前
> 按 GRADED-TRUST 的「协议一旦对外规范化改动成本上升」纪律,先评审再落。

---

## 11. 参考

- [`GRADED-TRUST.md`](GRADED-TRUST.md) — 分级信任 track(trustTier 模型、决策矩阵、
  四条边界、M1→capstone)。
- [`HUB-MESH.md`](HUB-MESH.md) — mesh 的**设计文档**(动机、feedback ledger、
  reputation §3.5,与 trustTier 正交)。
- [`../PROTOCOL.md`](../PROTOCOL.md) — agent↔hub wire 协议(另一层)。
- [`STD-STANDARDS-ALIGNMENT.md`](STD-STANDARDS-ALIGNMENT.md) — A2A 名片签名 + PIN
  公钥(发现层信任锚,与 mesh 层不混)。
- [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) — 两机 / 跨 hub 操作 runbook +
  测试金字塔 L1→L4。
- 实现:`packages/transport-ws/src/hub-link.ts`。
