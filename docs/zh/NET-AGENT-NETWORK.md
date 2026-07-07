# NET — agent 网络 track:管家出网 + hub 名片/发现

> 北极星第 2 层(人/agent ↔ 别的人/agent/机构)的**管道已全通**(federation、
> A2A 入+出、ACP、信任契约、跨 hub 工作流、配额 fail-closed),但**故事是薄的**:
> 普通成员今天没有任何一条对话式入口能让自己的 AI 代表自己跟对端 hub 打交道;
> 两台 hub 互联唯一入口是场外换 token(`mint-peer-token` + `connect`),撑不起
> 「网络」。NET track 补这两块:**A = 管家出网**(先),**B = hub 名片/发现**(后)。
>
> 用户拍板(2026-07-06):「先 A(管家出网)再 B(名片/发现)」。
>
> Last updated: 2026-07-06(NET-M0 计划)

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
    本地 hub,**id = 对端 peerId**;`hub.dispatch({strategy:{kind:'explicit',
    to: peerId}})` 即达。
  - wrapper `onTask` 是**真 round trip**(`await link.dispatch`),回来的就是
    对端的 `TaskResult`。
  - origin 盖章:task 未带 origin 时 wrapper 经 originResolver 盖
    `{orgId: selfHubId, userId}`——所以出网派发**不要预盖 origin**(预盖会被
    「多跳直传」分支原样透传,把 `local` 传出去)。
  - owner 级出站审批已在:`requireApprovalOutbound` 的 peer,wrapper 被
    `ApprovalGatedParticipant` 装饰,send 先停 owner `/me`。
- 成员侧回传:S1-M3 `butlerPushRef`(inbox resolve 推回)+ CARE-M8 outbox
  (短暂失联不丢),管家 governed 动作「批完把结果推回 IM」这条缝已经可靠。

### NET-M1 — 管家的「网络眼睛」:`list_peers`(benign 只读)

对齐 BE-M1 三只读的姿态:读投影、绝不动作、脱敏。

- 新模块 `packages/host/src/personal-butler-peers.ts`:
  `buildButlerPeersToolset({userId, peers, logger})`,单工具 `list_peers`。
- 窄鸭子面 `ButlerPeerSurface`(host 侧由 `PeerRegistry.status()` +
  `identity.listPeers()` 拼):每行只出 `{peerId, label, connected,
  lastSeenAt, allowedCaps}`。**脱敏红线**:endpointUrl / token / ACL /
  配额细节永不进投影(成员该看拓扑存在性,不该看运维细节)。
- 出站姿态按 `peer-acl.ts` 的**真实语义**渲染(M1 侦察修正,别按直觉猜):
  `outboundCaps === null` = **未限制**(legacy send-all,explicit 可直达)/
  `[]` = **锁死**(什么都不能发)/ 非空列表 = **白名单**(advertise=authorize,
  G-M1;此时 explicit 派发会被 `strategy_not_allowlisted` 拒——是设计不是 bug,
  跨界寻址哲学是 capability 不是 id)。
- factory 接线:refs 加 `peerRoster`,surface 缺席 → 工具不出现(既有惯例)。
- **会红的门**:单测——脱敏(投影里字符串化后不含 endpointUrl/token 字样)/
  connected 与 offline 双态 / allowedCaps null 诚实文案 / surface 缺席不供工具。

### NET-M2 — `ask_peer`(governed,成员确认后出网,主里程碑)

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
  - 派发(**阶梯按边的出站姿态定**,M1 侦察后修正——白名单边 explicit 会被
    `strategy_not_allowlisted` 拒,是 mesh 的 capability 寻址设计):
    - `outboundCaps === null`(新配对边默认)→ `{kind:'explicit', to: peerId}`
      直达 wrapper;
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
    非 mock):管家 park → 成员 /me approve → 出网 → 对端 echo agent 答 →
    结果回到成员(走既有 resolve 推回);断言对端收到的 task **origin.orgId =
    本方 hubId**(不是 'local'、不是空);outboundCaps 不含所需能力时
    `outbound_capability_denied` 诚实文案;`requireApprovalOutbound` 边上
    成员批后拿到 `suspended` 文案 + owner `/me` 里真躺着一条 approval。

### NET-M3 — 双 hub capstone:demo + 双闸回传收尾 + 文档

- `examples/butler-cross-hub/`:一进程起两台真 hub(A 有管家 + 成员,B 有一个
  echo/助理 agent),脚本走完「问 → 确认 → 出网 → 带回」,README 对照
  FEDERATION-RUNBOOK 讲两台真机怎么复刻。对齐 EXAMPLES.md 分级索引(标前置)。
- 双闸(owner 也要批)场景的最终答案回传:评估三条路——① inbox resolve 推回
  按 task.from 追加通知原提问成员;② 骑 BE-M5 run-broadcast 面;③ 显式推迟
  (文档写清行为)。按「复用既有缝优先、新缝最小」定夺,做不小就 ③。
- 文档:FEDERATION-RUNBOOK 加「管家出网」一节;PARTICIPANT/OVERVIEW 各一指针;
  本文档滚动记账。
- **会红的门**:examples 冒烟(demo 脚本 exit 0 + 输出含对端答案)+ 双闸回传
  按选定方案的回归测试(或推迟决定钉进文档,门=文档一致性)。

---

## 三、B track:hub 名片/发现(NET-M4 →,概设,实施前再侦察)

> ⚠️ 本节是**概设不是承诺**:agent 发现类惯例(A2A agent-card、well-known
> 路径、签名格式)演进很快,动工前必须重新侦察一轮当时的标准现状,再定稿
> 细分里程碑。

- **NET-M4 名片**:`GET /.well-known/gotong-hub.json`——hub id、显示名、
  **owner 策展的**可被请求 capability 白名单(默认空=只报身份不报能力)、
  联邦/A2A 端点、格式版本。对读 A2A agent-card 生态,能对齐就对齐(生态互认
  优先于自造格式)。签名/身份证明机制随侦察定(现有 peer auth 是 bearer
  token,无长期 keypair——是否引入签名密钥是这一步最大的设计决定,单独拍板)。
- **NET-M5 发现 preflight**:`gotong connect <url>` 先取名片 → 打印人类可读
  的「对方是谁/开了什么」→ 人确认 → 走既有 token/邀请流。名片永不自动建边。
- 远期(显式不做,只记账):跨 hub 结算(x402/AP2 类支付协议只观察)、
  多跳路由/gossip(点对点对当前规模是对的)、名片聚合目录站(等社区真有
  多 hub 再说,零算力社区站生成器是现成底座)。

---

## 四、验收纪律(每个 M 一致)

- 一个 M = 一个 commit;规划→开发→测试→commit→下一项。
- 每个 M 至少一道**会红的门**(单测/e2e/冒烟),红过再绿才算数。
- `pnpm check:guards` 四门全绿(kernel 依赖方向 / env 注册表 / 行数棘轮);
  main.ts 预算内接线,超了先抽取腾预算(factory 先例)。
- 全量 host 测试零红;动到 web 面时 web 也零红。
