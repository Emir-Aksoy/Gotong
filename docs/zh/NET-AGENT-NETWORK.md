# NET — agent 网络 track:管家出网 + hub 名片/发现

> 北极星第 2 层(人/agent ↔ 别的人/agent/机构)的**管道已全通**(federation、
> A2A 入+出、ACP、信任契约、跨 hub 工作流、配额 fail-closed),但**故事是薄的**:
> 普通成员今天没有任何一条对话式入口能让自己的 AI 代表自己跟对端 hub 打交道;
> 两台 hub 互联唯一入口是场外换 token(`mint-peer-token` + `connect`),撑不起
> 「网络」。NET track 补这两块:**A = 管家出网**(先),**B = hub 名片/发现**(后)。
>
> 用户拍板(2026-07-06):「先 A(管家出网)再 B(名片/发现)」。
>
> **进展**:A track 全完 —— NET-M1 `list_peers`(`e9f9844`)、NET-M2
> `ask_peer` governed 出网(`322f90d`,双 hub e2e 四场景)、NET-M3 capstone
> (`af48654`,`examples/butler-cross-hub` demo + FEDERATION-RUNBOOK「管家
> 出网」节 + 双闸回传显式推迟)。B track 全完:NET-M4 名片 ✅(A2A v1.0
> 升卡 + owner 策展文件,`2be8a38`);NET-M5 发现 preflight ✅
> (`gotong peer-card <url>`,本 commit)。**NET track 收官**;远期项
> (签名卡 keypair/结算/多跳/目录站)显式不做,见 B track 末尾。
>
> Last updated: 2026-07-07(NET-M5 收口,track 全完)

---

## 一、两条不可破的边界

1. **管家做不出成员自己做不到的事,也绝不绕过任何既有闸。**
   出网派发走的就是 `installPeerLink` 装好的那个 wrapper participant——
   outboundCaps 白名单(P4-M1)、数据类契约(P4-M4)、owner 出站审批
   (B-M3 `ApprovalGatedParticipant`)、对端入站 ACL/配额,一道都不少。
   NET 只是给这条既有通路加一个**对话式入口 + 成员级确认**,不加任何新特权。

2. **发现 ≠ 信任。**(B track)名片只是「可读的自我介绍」,永不自动建边;
   建立信任仍走既有 peer onboarding(token/邀请)。名片上登什么由 owner
   策展,默认什么都不登——主权 hub 的缺省是沉默。

零新 env 旋钮预期:A track 全程骑既有开关(`GOTONG_BUTLER_GOVERNED` 治理主闸、
peer 行内 `requireApprovalOutbound`);节律/上限如需一律常量。B track 若需
「名片开关」再按注册表纪律登记。

---

## 二、A track:管家出网(NET-M1 → M3)

### 现状(2026-07-06 核实)

- 管家治理动作全部 hub 内;`set_peer_policy` 是管信任**设置**,不是跟对端**打交道**;
  WFEDIT 明确锁死成员改跨 hub 边。管家工具面没有任何 peer 向动作。
- 跨 hub 机制(全部既有,零改动即可骑):
  - `PeerRegistry` 拨号 + `installPeerLink` → `RemoteHubViaLink` wrapper 注册进
    本地 hub,**id = 对端 peerId**。**寻址只有 capability 一条路**(M2 e2e
    证实):wrapper 把 task 连 strategy 原样转发,对端按同一 strategy 重派——
    explicit 指向我方 wrapper id 的 task 过线后在对端无人认领,必死
    `no_participant`;而 wrapper 的广告能力 = `row.outboundCaps`(G-M1
    advertise=authorize),所以**只有策展过的边才路由得出去**。
  - wrapper `onTask` 是**真 round trip**(`await link.dispatch`),回来的就是
    对端的 `TaskResult`。
  - origin 盖章:task 未带 origin 时 wrapper 经 originResolver 盖
    `{orgId: selfHubId, userId}`——所以出网派发**不要预盖 origin**(预盖会被
    「多跳直传」分支原样透传,把 `local` 传出去)。
  - owner 级出站审批已在:`requireApprovalOutbound` 的 peer,wrapper 被
    `ApprovalGatedParticipant` 装饰,send 先停 owner `/me`。
- 成员侧回传:S1-M3 `butlerPushRef`(inbox resolve 推回)+ CARE-M8 outbox
  (短暂失联不丢),管家 governed 动作「批完把结果推回 IM」这条缝已经可靠。

### NET-M1 — 管家的「网络眼睛」:`list_peers`(benign 只读)✅ `e9f9844`

对齐 BE-M1 三只读的姿态:读投影、绝不动作、脱敏。

- 新模块 `packages/host/src/personal-butler-peers.ts`:
  `buildButlerPeersToolset({userId, peers, logger})`,单工具 `list_peers`。
- 窄鸭子面 `ButlerPeerSurface`(host 侧由 `PeerRegistry.status()` +
  `identity.listPeers()` 拼):每行只出 `{peerId, label, connected,
  lastSeenAt, allowedCaps}`。**脱敏红线**:endpointUrl / token / ACL /
  配额细节永不进投影(成员该看拓扑存在性,不该看运维细节)。
- 出站姿态按**真实语义**渲染(peer-acl.ts + peer-registry G-M1;M1 侦察改过
  一次、M2 e2e 又证伪一次,教训:别按直觉猜,读装配处):
  `outboundCaps === null` = **未策展**(ACL 层放行一切,但 wrapper 广告为空,
  本地按能力派发选不中这条边——「未限制」是 allowlist 真相不是可路由真相,
  渲染成「可以直接发」会误导成员)/ `[]` = **锁死**(什么都不能发)/
  非空列表 = **白名单**(advertise=authorize:同一份列表既是广告又是授权,
  这是唯一派得出去的姿态)。
- factory 接线:refs 加 `peerRoster`,surface 缺席 → 工具不出现(既有惯例)。
- **会红的门**:单测——脱敏(投影里字符串化后不含 endpointUrl/token 字样)/
  connected 与 offline 双态 / allowedCaps null 诚实文案 / surface 缺席不供工具。

### NET-M2 — `ask_peer`(governed,成员确认后出网,主里程碑)✅ `322f90d`

「问一下爸爸的 hub 今晚有没有空」——管家转述、成员确认、出网、答案带回。

- 新模块 `packages/host/src/personal-butler-ask-peer.ts`,**镜像 ask_my_agent
  的形状 + workflowCreateGov 的治理姿态**(独立 tool 名、独立 executor、同一
  个 governed 主闸):
  - 工具 `ask_peer{peerId, message}`,进 factory 的 `governed` 集。
  - **为什么 governed 而 ask_my_agent 是 benign**:问自己的助手 = 成员自助;
    出网 = 离开 hub、花对端资源、跨数据边界——对齐 steward 分级里 cross_hub
    要**二次确认**的既有姿态。approve → SuspendTaskError → 成员自己的 /me
    收件箱(+ 既有 IM 审批推送),批准后才派发。
  - **no-leak / 反幻觉**:目标 peerId 必须在 roster(NET-M1 同一面)里,否则
    拒绝并列出真实可选项(同 ask_my_agent 对 agentId 的处理)。
  - 派发(**只有策展过的边可问**——初版计划里「null 边 explicit 直达」是
    虚构,双 hub e2e 抓的现行:explicit 过线后对端路由不了,死
    `no_participant`;跨界寻址只有 capability 一条路,管家骑工作流跨 hub 步
    同一套 mesh 语义,零私有寻址):
    - `outboundCaps === null`(新配对边默认)→ **诚实拒 + 指路策展**
      (「这条边还没策展可出网的能力,请管理员配 outboundCaps,策展即授权」);
    - 白名单边 → `{kind:'capability', capabilities:[cap]}`,cap 从该边白名单里
      选(唯一→自动,多个→让成员挑);**派前预检**:本地无人服务该 cap 且仅此
      一条边 advertise 它,否则诚实拒绝并指路(「本地也有人做/两条边都认,
      让管理员给这条边策展一个专属能力名」)——预检只读,真正的闸仍在 wrapper;
    - `[]` 锁死边 → 直接诚实拒绝。
    统一:`from: userId`、**不带 origin**(让 wrapper 盖真章)、payload =
    message 大白话。AWAIT 结果,`TaskResult` 五种 kind 逐一映射诚实文案:
    - `ok` → 「对端回复:…」(replyText 两形状:string / {text})
    - `no_participant` → 「对端不在线/这条边没接通」
    - `failed: outbound_capability_denied:*` → 「这条边没开这个能力,找管理员策展」
    - `suspended` → 「已发出,但这条边还要 owner 审批」(见下)
    - `failed / cancelled` → 原样大白话
- **双闸各守其主,顺序诚实**:成员闸(governed approve,守「这个成员真的要
  发这句话」)在前;owner 闸(peer 行 `requireApprovalOutbound`,守「这条 org
  边允不允许出站」)在后且不可绕——成员批完若 owner 闸又停,executor 收到
  `suspended`,如实告诉成员「还差 owner 一道」。**owner 批完后的最终答案回传
  到原提问成员**这半截,M2 只钉「诚实告知」,完整回传在 M3 评估(现有 resolve
  推回推给的是审批人=owner,不是提问者;若一步到位需要新缝,宁可显式推迟)。
- **会红的门**:
  - 单测:未知 peerId 拒绝并列真名单 / 空 message 拒 / 五种 kind 文案映射 /
    roster 缺席不供工具。
  - e2e(hermetic,**双真 Hub 进程内互联**——`installPeerLink` 真 wrapper,
    非 mock;边的装法逐字镜像 peer-registry 的 advertise=authorize):
    ① 策展边全环:管家 park(未批前零字节出网)→ 成员 /me approve →
    capability 出网 → 对端 agent 答 → 结果回到成员同一轮;断言对端收到的
    task **origin.orgId = 本方 hubId**(不是 'local'、不是空);② 未策展
    null 边 classify 就拒(文案含「策展」指路),不 park 零出网;③ 锁死边
    同拒;④ `requireApprovalOutbound` 边上成员批后拿到「还差 owner 一道」
    诚实文案 + owner `/me` 里真躺着一条 approval,owner 批完任务才真跨界。

### NET-M3 — 双 hub capstone:demo + 双闸回传收尾 + 文档 ✅

- `examples/butler-cross-hub/` ✅:一进程两台真 Hub + 真 `installPeerLink`
  (装法逐字镜像 peer-registry 的 advertise=authorize),真 PersonalButlerAgent
  (确定性 mock provider,零 API key)。四幕:问→park(零字节出网)/ 批准→
  capability 跨界→wrapper 盖真 origin→答案回同轮 / 拒绝→fail-closed 对端
  永不被联系 / 未策展边 classify 当场拒+指路。demo 自带 7 条自断言 + exit 0
  即冒烟门;host-free(cross-hub-workflow 先例),内联 ~50 行教学镜像并指路
  host 真件。`pnpm demo:butler-cross-hub`;进 EXAMPLES.md ④ 级(零前置)。
- 双闸最终答案回传:**定夺 = ③ 显式推迟**。① 按 task.from 推回需在
  inbox-service/im-bridge 之间开新缝且要辨别任务类别;② BE-M5 面只覆盖工作流
  run,不覆盖裸 dispatch——都不小,按「复用既有缝优先、新缝最小」推迟。行为
  已钉进 FEDERATION-RUNBOOK「管家出网」节:owner 批准后任务照常送达执行
  (transcript 有记录),结果不自动回推原提问成员;日常用法是管家常问的边
  不开 `requireApprovalOutbound`(成员闸已挡一道),高敏边由 owner 转达。
- 文档 ✅:FEDERATION-RUNBOOK「变体 — 管家出网」节(前提/两闸顺序/回传推迟
  /排障入口)+ §5 验收表加行;PARTICIPANT「接着读哪」+ OVERVIEW HubLink 行
  各一指针;本文档滚动记账。
- **会红的门**:demo 自断言 + exit 0(对端恰被联系一次/origin 真章/答案回
  同轮/拒绝与未策展边零出网);双闸回传的推迟决定钉进 runbook(门=文档一致)。

---

## 三、B track:hub 名片/发现(NET-M4/M5,2026-07-06 侦察后定稿)

> 概设阶段的「实施前再侦察」已做(2026-07-06,A track 收口当天):
> **A2A v1.0(2026 年初定稿)**把 agent card 钉在
> `/.well-known/agent-card.json`(早期 `agent.json` 已被替代),必填字段
> name/description/url/version/capabilities/securitySchemes/
> defaultInputModes/defaultOutputModes/skills[]{id,name,description,tags};
> v1.0 重头是 **Signed Agent Cards**(JWS + canonicalization,可选)与
> authenticated extended card(`capabilities.extendedAgentCard` +
> 认证后取详卡)。本方 `/a2a` 入站(message/send + tasks/get,bearer
> peer-token,`metadata.skill`→capability)早已在——缺的只是发现面。
> 出处:[A2A spec](https://a2a-protocol.org/latest/specification/) ·
> [AgentCard concept](https://agent2agent.info/docs/concepts/agentcard/)。

- **NET-M4 名片 = 一张真 A2A AgentCard ✅(as-built)**(定稿:概设里的自造
  `gotong-hub.json` **放弃**——生态互认优先于自造格式,咱们本来就有 A2A
  入站,名片就该是外部 A2A caller 拿了能直接用的那张卡):
  - **侦察修正:卡早已存在**——R3(A2A alignment)就落了
    `host/src/agent-card.ts` + main.ts 闭包 + web 路由
    (`GET /.well-known/agent-card.json`,请求推导 baseUrl、405/404/
    cache-control 齐全)+ `GOTONG_A2A_ADVERTISE_SKILLS`(默认关,开=自动
    枚举全部本地 capability)。外部标准侦察做了、自家仓库没 grep,差点重
    造——教训记下:**侦察清单里「我们自己有没有」排第一**。M4 因此收敛为
    两件事:**升 v1.0 卡形 + 加 owner 策展层**,web 路由零改动。
  - **v1.0 卡形,0.2.x 过渡字段双写**:新增必填 `supportedInterfaces[]`
    (首项=首选;url=`<base>/a2a`、protocolBinding=JSONRPC、**接口级
    protocolVersion 诚实写 '0.2'**——方法面真的是 0.2.x 的阻塞
    message/send + tasks/get 子集,卡形升级不冒领方法面)+
    `securityRequirements`(v1.0 改名,与旧 `security` 双写);旧顶层
    `url`/`protocolVersion` 留给 0.2.x 读者;`provider` 删(v1.0 要求
    url+organization 成对,hub 给不出 organization URL,半个 provider 违
    规范);v1.0 把 AgentSkill 的 description/tags 变必填 →
    `buildAgentCard` 统一归一(description 缺省=id,tags 缺省=[])。
  - **owner 策展文件 = `<space>/agent-card.json`,file-first 零新 env
    旋钮**:owner 只填人话字段(displayName/description/skills[]
    {id,name?,description?,tags?},id=可被入站 message/send 请求的
    capability 名),路由翻成规范卡——owner 永不手写协议结构。每请求
    `readFileSync` 现读,改完即生效不用重启。**优先级:策展 > env 枚举 >
    无**;概设「文件不存在→404」修正为:卡本就默认 serve 身份最小卡
    (身份+怎么认证,这是发现面的正当缺省),缺省沉默指的是 **skills 一个
    不登**——策展文件管的是「登什么」,不是「有没有卡」。
  - **损坏=整文件拒,绝不半张卡**:坏 JSON/非对象/skills 非数组/skill 缺
    string id → warn(每文件 60s 节流,公网端点防扫描刷日志)+ 回落到无
    策展;重复 skill id → warn 留首个;非字符串 tag 丢弃。
  - **签名 keypair:首版不签,单独拍板**(spec 里签名可选;发现≠信任,
    信任仍走 token onboarding,名片被篡改的后果=读到假介绍,建边时 token
    握手会拆穿)。引入长期 keypair 牵动备份/轮换/vault 姿态,值得单独一轮。
  - 会红的门(19 条单测):supportedInterfaces 指向 /a2a 且接口版本 '0.2' /
    provider 不在卡上 / security 双写 / skills 归一(description←id、
    tags←[])/ 策展缺省沉默 null 不 warn / 5 种损坏各 warn+null 整文件拒 /
    重复 id 留首 / 策展 skills 逐字上卡绝不自动扩。
- **NET-M5 发现 preflight ✅(as-built:命令叫 `gotong peer-card <url>`)**:
  概设写的 `gotong connect <url>` 落不下——`connect` 早被「主流 coding
  agent 的 MCP quick-connect 配置打印」占用(positional 是 agent id),
  两个语义挤一个命令会撞旗标撞帮助文本;peer 登记动作本身也不在 CLI
  (在管理 UI「联邦」面板 / POST /api/admin/identity/peers)。落点改为
  与 `mint-peer-token` 同家族的平铺新命令:
  - `gotong peer-card <url>`:取对端 `/.well-known/agent-card.json` →
    打印人话(名字/介绍/版本/端点/认证/开放能力)→ 尾部固定指回既有
    token onboarding(mint-peer-token + 双边登记 + runbook Step 1-3)。
    接受裸 base 或整条 well-known URL(不重复拼);10s 超时常量非旋钮。
  - **只读不写**:看名片永不建边、不碰 identity 状态。对端没挂名片
    (404)是规范内的正常答案——如实说没有,下一步指引照给(名片是增强
    不是前置)。名片是对端给的不可信输入:字段缺/类型错逐项降级
    「(未声明)」绝不炸;skills `[]` 如实说「缺省沉默,不代表没有能力」。
  - 出码脚本可依赖:0=明确答案(有卡或明确没卡)/ 1=没得出结论(网络
    不通/超时/HTTP 错/卡无效)/ 2=用法错。
  - 会红的门:17 条单测(URL 归一/防御渲染/注入 fetch 全分支/出码)+
    真 HTTP 冒烟(真 server + 真 bin:有卡/404/坏 JSON/连不上 9 断言)。
- 远期(显式不做,只记账):Signed Agent Cards(等 keypair 拍板)、跨 hub
  结算(x402/AP2 类支付协议只观察)、多跳路由/gossip(点对点对当前规模是
  对的)、名片聚合目录站(等社区真有多 hub 再说,零算力社区站生成器是现成
  底座)。

---

## 四、验收纪律(每个 M 一致)

- 一个 M = 一个 commit;规划→开发→测试→commit→下一项。
- 每个 M 至少一道**会红的门**(单测/e2e/冒烟),红过再绿才算数。
- `pnpm check:guards` 四门全绿(kernel 依赖方向 / env 注册表 / 行数棘轮);
  main.ts 预算内接线,超了先抽取腾预算(factory 先例)。
- 全量 host 测试零红;动到 web 面时 web 也零红。
