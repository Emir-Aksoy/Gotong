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
  人批,IM 与 web 是同一人,标。
- `butlerApprovalItemFor`(管家 governed park)——按钉子②的规则标。
- 其余来源(ACP 权限升级、steward park、未来新来源)**什么都不用做**,天然
  web-only。新来源默认安全,不存在「忘了登记就 fail-open」。

### 钉子② web-only 按名字形状结构性判定,不逐工具枚举

管家 governed park 标不标 `imApprovable`,看被批工具名(park 时从
`pending.toolUses`+`approvedId` 拿):

- `ask_peer`(cross_hub 出网)→ **不标**;
- 名字含 `__`(MCP 连接器动作 `<server>__<tool>`——发消息/改日历/一切 dataLeavesBox
  方向的对外动作)→ **不标**;
- 其余(hub 内配置动作:建/改/删 agent、建/改工作流)→ 标。

规则是**形状**不是名单:将来接入任何新 MCP 连接器,其 WRITE 动作自动落 web-only,
无需维护枚举。误差方向永远朝保守(多要一次 web,不放行高危)。

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

短码 = itemId 前 8 字符,**无状态**(不发序号,序号会随新项漂移)。服务端在本人
`listPending` 范围内前缀匹配;歧义(≥2 项同前缀)→ 拒绝并列全码;`choice`/`edit`
类项 v1 不支持 IM 应答,列表里标「需在网页处理」。

### 执行链(全复用,零新权威点)

```
IM 消息 → parseImCommand → handleImMessage 新 case
  → config.approvals(鸭子 ImApprovalSurface,host 的 ImApprovalService)
    → listForIm(userId)             只读投影:短码/标题/imApprovable/kind
    → resolveByShortId({userId, shortId, approved})
        前缀匹配 → imApprovable 服务端复核(不信桥层) → inbox.resolve(既有:
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
