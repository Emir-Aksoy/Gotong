# IMA — IM 审批闭环(手机 IM 单端跑完日常动线的最后一块)

> Track 代号 **IMA**(IM approval)。用户拍板:「先做 IM 审批闭环,安全姿态选 b」
> (b = 分级——普通 park 项 IM 可批,cross_hub / 花钱 / 对外类仍要 web)。
>
> Last updated: 2026-07-11

---

## 一、为什么(纯 IM 场景唯一的「每天都撞上」断点)

管家的治理闸(governed park)、工作流 `human:` 步都会把待批项写进 `/me` 收件箱;
UX-A1 还会在 IM 里提醒「有 N 件事等你批」。但**批准动作只在 web /me**——纯 IM 用户
被叫醒了却干不了活,必须换端。修完这一刀,「手机 IM 单端」即可覆盖日常九成动线:
聊、建、跑、**批**、收播报全闭环(凭证与低频管理留给浏览器,本来就该在那)。

## 二、侦察记录(file:line 证据)

| 事实 | 证据 |
|---|---|
| web 审批走鸭子 `InboxSurface.resolve({itemId,userId,decision})`,ownership/race guard/审计都在 surface 内 | `packages/web/src/me-routes.ts` handleMeResolveInbox → `packages/host/src/inbox-service.ts` resolve(markResolved 先行=race guard;`InboxError.code` 映射 HTTP) |
| **审批结果推回 IM 的管道早已在**(S1-M3 `onResolved` hook → butlerResolvePushback → reachable push) | `inbox-service.ts:149` + `personal-butler-escalation.ts:113` — IM 缺的只有「决定」方向 |
| `InboxItem` 有 `source?`('butler'=管家 park;human 步/ACP/steward 均 unset)、`kind`(approval/choice/edit 交互形状)、`parentKind`——**没有风险级字段** | `packages/inbox/src/types.ts:102` |
| park 时能拿到被批工具的确切名字 | `ButlerGateState.pending.toolUses` + `approvedId`(`packages/personal-butler/src/checkpoint.ts:77`) |
| host 喂的 governed 名单天然两类:hub 内配置动作(create/edit/delete_agent、create/edit_workflow)vs 出盒动作(`ask_peer`、MCP `<server>__<tool>`) | `personal-butler-governed.ts:101` / `personal-butler-ask-peer.ts` / `personal-butler-mcp.ts` |
| IM 命令消费点:`handleImMessage` switch + `HostImConfig` 可选鸭子;「未接=回未启用」有先例(`resolveWorkflow`) | `packages/host/src/im-bridge.ts:249` |
| IM 身份:`im_bindings` → `config.resolver.resolveUserId(platform, platformUserId)`,与 web session 同一 userId 语义 | `im-bridge.ts:295` |

## 三、设计(安全姿态 b 的三道钉子)

### 钉子① `imApprovable` 白名单,fail-closed

`InboxItem` 加 **additive 可选** `imApprovable?: true`。**只有显式标了的项才能在
IM 里批**;未标 = web-only。谁标:

- `HumanInboxParticipant`(工作流 `human:` 步 broker)——human 步本来就指派给这个
  人批,IM 与 web 是同一人,**无条件标**。这个标志断言的是**收件人**,不是「那行字
  够不够说清楚」;后者归渲染层(见下「一行放不下就不许批」)。曾按「有没有 `title`」
  收窄过一版(HANDS-M2 Codex 六轮 H2 想挡 `title: 排班确认` + `prompt: 整张排班表`
  这种盲签形状),七轮核出它误伤 21 条本来短小、本来该能在手机上批的画廊 human 步
  ——标题在场 ≠ 正文被藏起来,真正的修法是**两段一起渲染**。
- `butlerApprovalItemFor`(管家 governed park)——按钉子②的规则标。
- 其余来源(ACP 权限升级、steward park、未来新来源)**什么都不用做**,天然
  web-only。新来源默认安全,不存在「忘了登记就 fail-open」。

### 钉子② web-only 逐条列举(2026-08 改口:原为按名字形状排除)

管家 governed park 标不标 `imApprovable`,看被批工具名(park 时从
`pending.toolUses`+`approvedId` 拿)在不在
`personal-butler-escalation.ts` 的 **`IM_APPROVABLE_TOOLS`** 里:建/改/删 agent、
建/改工作流,加 HANDS-M3c 的 `set_hub_config`(改 hub 基础设置)——六件 hub 内配置
动作。**不在名单上 = web-only**,新工具的默认答案是「没表态」。名单与真实 governed
工具面的双向核对在 `butler-tool-tiers.test.ts`:新增一个 governed 工具而两边都不
表态,门就红。

> `set_hub_config` 进名单的理由,与下面那条「不能当安全属性用」的观察正好互为反面:
> 它的参数空间是**封闭的**(4 个具名键的 `enum` + 枚举/端口值 + `additionalProperties:
> false`),那一行**结构上就长不了**,不是「今天恰好短」。这条推理由一道门守着
> (`枚举 ≡ ENV_KNOBS`),见 [`ATONG-HANDS.md`](ATONG-HANDS.md) §14.4。

> **原设计是排除法,它错了**(HANDS-M2 Codex 九轮 H1a)。原文写「规则是形状不是
> 名单……将来接入任何新 MCP 连接器,其 WRITE 动作自动落 web-only,无需维护枚举」
> ——判据是「不是 `ask_peer`、名字里没有 `__`」。这句话只对**连接器**成立:它们
> 的名字天生带 `__`。HANDS-M2 一次挂上五件 `hands_*`(在监狱里跑命令、写文件),
> 一个字没改就全部落进了「手机上可以批」的一侧,`pack_backup`(身份档带 hub 签名
> 钥)同罪——**没有人做过这个决定**。「白名单」约束的是新的**写入方**,约束不了
> 一个既有写入方后面新长出来的**工具族**;而白名单的默认值只有在它真的是列举时
> 才是「否」。
>
> 顺带记一条**不能当安全属性用**的观察:`hands_*` 今天即使标了也大多在渲染层被
> `title_truncated` 挡回网页(argv 只渲染前 4 段各 60 字,而一行的预算是 80 码
> 点)。那是**显示长度**,不是授权判断——把 agent id 改短、把框架那句话缩一缩,
> 这道门就静默打开了。安全属性必须挂在名单上。

### 钉子③ 审计如实记通道

`HostInboxService.resolve` 加可选 `via?: string`;IM 批的审计行 `actorSource`
写闭集新值 **`'im'`**、渠道细节(`im:telegram`)入 **`metadata.via`**,web 路径
不传 = `'v4-session'` 字节不变。「谁在哪个通道批的」在 audit_log 里可查——IM
通道弱于 web session 是已知事实,诚实入账而不是抹平。

> 实现修正(M2 落地时发现):`AuditActorSource` 是**闭集联合**且读侧有钳制守卫
> (`rowToAuditLog` 认不出的值一律压成 `'system'`)——把 `im:telegram` 整串写进
> `actorSource` 会在读出时被抹成 system,**恰好丢掉要记的事实**。故走 FED-M4
> `'federated'` 同款先例:枚举只加一个值 `'im'`(identity 类型 + 写入白名单 +
> web 镜像联合三处),平台细节走 metadata——闭集保持小而封闭,细节不丢。

### 命令面(六桥同款,动词英文镜像 /bind 惯例)

```
/inbox               — 列出等你处理的事项(短码 + 标题;web-only 项标「需在网页处理」)
/approve <短码>      — 批准(仅 approval 类、已标 imApprovable 的项)
/deny <短码>         — 拒绝(别名 /reject)
```

短码 = **内容指纹**(HMAC-SHA256 over itemId‖createdAt‖title‖prompt,各段带长度前缀,
取前 8 位十六进制),**无状态**(不发序号,序号会随新项漂移)。**带密钥**(八轮 M2):
32 bit 不带密钥就是阿同自己能算的东西——它知道自己那次 park 的标题与正文、
`createdAt` 就在它调用工具的几十毫秒内,而 HANDS-M2 之后它**有手**(tier 1 命令免
审批、监狱里能跑磨哈希的脚本),于是「磨一个新动作撞上你手里那串旧码」把下面这
道代际闸整个绕过去。密钥 32 字节存 `<space>/runtime/im-shortcode.key`(0600,缺了
就生成、短了就抛——静默重建会让所有在飞的短码一起失效,而且密钥被人动过本身
就是要说出来的事),永不出 hub、永不进模型上下文。不用 itemId 前缀是因为同一个
task.id 会**反复 park**(管家 tool-loop 批一个跑一个,store 直接覆盖)——那样从聊天
记录里往上翻抄下来的旧短码今天仍匹配得上,批的却是另一个动作(HANDS-M2 Codex 六轮
H1)。动作一变短码就变,旧短码落 `not_found`。

**必须打全 8 位**(七轮 M4):指纹抄一半不是任何东西的名字,4 位只有 16 bit,同一个人
手上几件待办撞一次的概率并不小;而且下面那道代际闸比的是**完整**指纹,短码打不全
就永远对不上。下限等于全长后前缀匹配退化成相等,`ambiguous` 只在真的 32 bit 撞车时
才可能出现。服务端仍只在本人 `listPending` 范围内匹配;`choice`/`edit` 类项 v1 不
支持 IM 应答,以及**一行看不全的项**(标题与正文两段拼起来洗完超 80 字符、或洗完
读不出可见内容),列表里标「需在网页处理」。

**批准落笔前再验一次代际**(七轮 H1):`resolveByShortId` 重算指纹只证「列表拿到手时
它是那个动作」,而重算与写盘之间同一个 id 还能被重新 park 成另一个——store 的
pending-only 闸看不见这次掉包(新一代同样 `pending`)。所以指纹作为谓词
(`InboxExpectation`)一路传到 `FileInboxStore`,在**同一把 per-item 锁内、紧挨着写
之前**求值,不符 ⇒ `stale_item`,一个字节都不写,IM 回「这条已经变成另一个动作了,
没有帮你批」。放在调用方检查治不好——窗口正是在调用方检查之后。

### 执行链(全复用,零新权威点)

```
IM 消息 → parseImCommand → handleImMessage 新 case
  → config.approvals(鸭子 ImApprovalSurface,host 的 ImApprovalService)
    → listForIm(userId)             只读投影:短码/标题/imApprovable/kind
    → resolveByShortId({userId, shortId, approved})
        全码相等匹配 → imApprovable 服务端复核(不信桥层) → inbox.resolve(既有:
        ownership/race guard/decision 校验/两步 resume/审计/onResolved 回推)
```

批准后的结果回推**零新代码**——S1-M3 的 `onResolved` → pushback 已经会把管家的
完成话术推回成员 IM。

## 四、里程碑(全完,2026-07-11)

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 本计划文档 | ✅ `105dabd` |
| M1 | 纯核:im-adapter 三命令解析 + inbox `imApprovable` 字段 + human broker 标记(各带单测) | ✅ `4edce68` |
| M2 | host:escalation 按形状标记 + `im-approval-service.ts` + im-bridge 三 case + `via` 审计 + main.ts 接线(压注释守 3000) | ✅ `5a9bc3b` |
| M3 | hermetic e2e(假桥全链路:列表→短码批→resume→回推;webOnly 拒批指路)+ 文档收口 | ✅ 本 commit |

### 落地实录(与计划的差异点)

- **审计通道走枚举+metadata**(见钉子③的实现修正)——比计划的「actorSource 直写
  `im:<platform>`」更对:闭集守卫本会抹掉它。
- **park 回执顺手闭环**:`summariseResult` 的 suspended 文案在接了审批面时改指
  「发 /inbox 看,再 /approve <id>」而非「到网页 我的 → 收件箱」——park→提醒→批
  →回推四步全在同一个聊天窗,不再中途赶人去浏览器。未接审批面时旧文案字节不变。
- **装配零 main.ts 膨胀**:`ImApprovalService` 在 `im-bridge-wiring.ts` 构造
  (`approvals: { store: inboxStore, inbox: inboxService }` 双依赖),main.ts 只加
  一行 spread + 一行注释,压既有注释净零,3000/3000 顶格不动。
- **e2e 三幕**(`packages/host/tests/im-approval-e2e.test.ts`,真 Hub/真
  FileInboxStore/真 WorkflowController/真 HostInboxService/真 ImApprovalService,
  只有桥是假的):幕1 工作流 `human:` 步 IM 批准→run done+决定流入下游步+审计行
  `actorSource='im'`+`metadata.via='im:telegram'`;幕2 管家 governed park
  (delete_agent)IM 批准→child resume→**S1-M3 回推把管家完成话术推回同一成员**
  +挂起行清干净;幕3 `ask_peer` park 列表标「需在网页处理」→`/approve` 被
  `web_only` 拒,item 仍 pending、挂起行仍在、零回推零审计行(fail-closed 全程)。
- 验收:host 2058(im-approval-service 12 + escalation 白名单 5 + 桥三动词 8 +
  inbox-service via 1 + e2e 3 新增)/ identity 654 / inbox 24 / im-adapter 33 /
  web 1365 全绿;四门 PASS(旋钮 109 零新增,main.ts 3000/3000)。

## 五、边界与显式不做

- **零新 env 旋钮**:`approvals` surface 接不接就是开关(镜像 llmKeyProbe 先例)。
- **v1 只做 approval 二值**:`choice`/`edit` 项 IM 里只列不批(带选项/自由文本的
  应答值得独立设计,不硬塞)。
- **owner 面不动**:steward dangerous/cross_hub、联邦出站审批(outbound-approval)、
  ACP 权限升级仍 web-only——它们是管理面/编码代理面,不是成员日常动线。
- **不做各平台 inline 按钮**(Telegram inline keyboard 等):各桥能力不一,v1 纯
  文本命令六桥同款;按钮属平台增强,将来按需在单桥叠加,不进共享层。
- **不做 IM 二次确认短语**:方案 b 的分级已把高危挡在 web;低危项再加确认短语=
  双重摩擦,不值。
- **IM 那一行没有不可伪造的定界符**(诚实残余)。网页/审批正文里,框架用「」把不
  可信文本包起来,而写入方已把文本里的「」降级成『』,所以**正文里的框架定界符
  只可能是框架放的**——伪造一句「看起来是 hub 说的话」结构上不成立(见
  `approval-text.ts`)。`/inbox` 的一行**没有这层结构**:它就是标题/正文本身,前
  后只有一个 `[短码]`。清洗(不可见字符、双向覆盖、定界符相似字)照做,读不全就
  降级去网页也照做,但「这一行里哪一段是框架说的」在 IM 里**没有结构性答案**。
  真要补,得让每一行都带一个框架自己的、文本侧伪造不出来的边框——那会改动六座桥
  共用的渲染层,且对纯文本 IM 收益有限。现状:高危动作本来就不在名单上(钉子②),
  这条残余的影响面限于「名单内五件配置动作的标题被拼出一句像框架的话」。
