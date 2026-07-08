# Gotong — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-07-06

---

## 一、本项目存在的意义（北极星）

Gotong 要做的是 **AI 时代「人-智能体-机构」三层链接的工作底座**：

```
   第 1 层  人 ↔ 自己的 AI / agent
            「我的 AI 桌面」: 一个人的 hub, 私人 workflow, 凭证只在本机
            目标: 5 分钟跑起来, 不写代码, AI 帮我做实际的事

   第 2 层  人 / agent ↔ 别的人 / agent / 机构
            「跨组织协作」: 多 user, role, 邀请, 跨 hub federation
            目标: 工作流可跨边界, 但凭证/数据/计费各归各家

   第 3 层  框架本身
            「清晰 + 稳定 + 适配」: Hub is dumb on purpose, file-first,
            participant 是统一抽象, 协议 / 凭证 / 配额都有显式边界
            目标: 工作流能实际落地, 跟得上 AI 快速发展
```

**三句话守则**:

1. **框架不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件,
   决策权永远在参与者(agent / 人 / 外部服务)手里。这是从 v0 到现在
   不变的设计立场, 改了就不是 Gotong。

2. **人和 agent 是同一个 `Participant`**。不要把人当 "request_human_input
   tool"。一切跨人 / 跨 agent 的协作都走同一套消息 + task + transcript。

3. **状态都是磁盘文件**。`.gotong/` 目录里能看到 transcript / agents /
   sessions / secrets / vault。复制目录 = 搬走房间。重启透明。

---

## 二、现在在哪一段

> **完整进展账本（v1.x → RES 全部里程碑、每个 Phase/Stream 的 commit 与设计决策、
> 验收门、显式推迟）已整体移到 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)。**
> 那里逐字保留历次收口记录；本节只留最近三个里程碑的指针。要查任何历史
> Phase/Stream（v1.x → v5 全部「完」）的落地细节、commit、设计权衡，**读账本**。

最近的里程碑（倒序,最新在上）：

- **记忆升级 track（MU）全完：M0→M5 + capstone（2026-07-08，`1955bc3`→本 commit 共 7 commit）** — 用户问
  「如何把管家记忆追上前沿」,答案=**骨架已赌对**(file-first + 双时态 + 睡眠期整理 = 前沿 Letta MemFS /
  OpenClaw / Zep 正朝这收敛),差距只在**检索质量**(多信号/图谱)与**可测性**(零 benchmark)。用户拍板
  「列个计划把这五项都纳入升级」+ 岔口「A=(a) 轻量;B、C 用推荐」。**四条不可破边界**:①框架仍不跑 LLM
  (所有模型调用只在 **6h 后台维护**,每轮热路径零 LLM);②字节不变 binds 冻结块 + 有门槛项(真 embedder/
  外部 provider opt-in;**零门槛本地重排作管家默认发**);③数据边界(外部 provider 离盒必须 opt-in + 凭证
  vault + 面板披露);④管家层优先,**内核 core/workflow/protocol 零改动**。**M1**(`3ba3f5a`)立尺:
  `packages/personal-memory` 召回 benchmark 纯 harness(`scoreRetriever` recall@k/MRR,14 例双语 fixture,
  `semantic` 类 recall 恒 0 是**设计出来的**诚实天花板)+ `pnpm check:memory-recall` 承重门,准确率棘轮
  地板只升(镜像 line-budget 反号)。**M2**(`5fac3d2`)融合召回:`fusedRetriever`(keyword coverage ⊕ 本地
  TF cosine,relative-score 融合非 RRF)+ 零依赖 `localBigramEmbedder`,**作管家默认发零新旋钮**(用户法则
  「有门槛才可选」+ MR1 先例);MRR 0.548→0.738(cross-session 0.333→1.0 聚焦金标提到第 1),recall 不变、
  semantic 仍 0(本地天花板,embedder 注入缝=M4 opt-in 入口)。**M3**(`2ba4508`)原子事实抽取:6h 维护里
  `composeReviewers(tieredReviewer, atomicFactsReviewer)` 并列一个 Mem0 式单遍抽取,写**自包含事实**
  (「用户最爱的饮料是珍珠奶茶」含类别词+具体值)→ semantic 类 recall 0→100%(**改库不改检索器**);
  relevanceScore 去重(跨 pass + pass 内)、`meta.atomicFact` 出处标记、6h 背景每轮零 LLM。**M4**(`0849cf8`)
  外部 provider:先查市面抓到市场真相(Mem0 官方 MCP 已迁**托管远程 HTTP + Bearer**、静态 stdio 随
  OpenMemory 退场,同 C-M2 同源)→ 走**连接器目录路径**(边界③「全走 MCP 不存数据」最具体约束,只有它干净
  满足)接 `mem0-memory`(http 托管 `Bearer ${MEM0_API_KEY}`)+ 新 **`dataLeavesBox` 披露原语**(面板对 flag
  无条件印「数据离开本机」,顺手补标 notion/todoist 云 SaaS);opt-in 未装字节不变、`MEM0_API_KEY` 是连接器
  凭证非旋钮**仍 106**;真 embedder 走 embed 缝 + 外部当主 backend 显式推迟。**M5**(`9a6df14`)记忆树 git
  快照(用户拍板 **A=a 轻量**):`butler-memory-git.ts` 新叶子 `snapshotMemoryTree` per-user `.git`、status
  无变化即 no-op(非每写即 commit)、best-effort **never-throws**(缺 git/init 失败 → `'skipped'`)、commit 带
  `-c commit.gpgsign=false`(后台 commit 绝不触发 gpg 卡 passphrase);6h 维护里 `gitSnapshot` opt-in
  **`GOTONG_BUTLER_MEMORY_GIT`(106→107,MU 唯一新旋钮**——它在盘上造 `.git` 有门槛,正落边界②),未开逐
  字节不变;可注入 GitRunner+now(测试无需真 git);main.ts +6 行 line-budget 2990→2996。**capstone**
  `examples/memory-upgrade`:真 MU 代码零重写,两幕各隔离一个里程碑用 M1 尺子量——Act 1 keyword vs fused
  MRR 0.583→1.0(改检索器)、Act 2 真 atomicFactsReviewer 抽取前后 answer-recall 0→100%(改库,检索器固定
  基线隔离 M3);末尾账本把 M4/M5 摆成 opt-in 侧面(故意不动召回数)。排错记:初版 Act 2 用 fusedRetriever,
  `饮料` 案掉出 top-5(所有诱饵含「饮料」coverage 全平,更长桥接事实 bigram TF 被稀释 cosine 反低)→ 修正=
  Act 2 检索器固定基线 keyword(MU-M3 承重门同手法),**每幕只改一个变量**;`pnpm demo:memory-upgrade`
  exit 0 零 key。验收:personal-memory 400 / host 1930 全绿,四门 PASS(旋钮 107,main.ts 2996/2996)。见
  [`docs/zh/MEMORY-UPGRADE.md`](docs/zh/MEMORY-UPGRADE.md)。
- **管家任务笔记本 track（TN）全完：M0→M3（2026-07-08，`0d1c507`→`74d513d` 共 7 commit）** — 用户问
  「管家怎么规划执行任务队列?hermas/openclaw 怎么做?写个任务笔记本会不会让弱模型也稳?」,答案
  =市场已收敛(Hermes 内建 todo 工具集且 <64K 上下文硬拒、OpenClaw 长出 tasks 台账/Inferred
  Commitments、Manus recitation 复述防漂移):**显式任务台账是长任务稳定性地板**;我们的差异化
  =推进分诊**零 LLM**(纯时间戳)+ 跨会话 file-first。用户拍板关键边界:**「放到管家智能体里,
  不是框架里」** —— 纯核全在 `packages/personal-butler`(host-free),装配只动 host
  `personal-butler-*` 家族,内核(core/workflow/protocol/identity)**零改动、零新 env 旋钮
  (仍 106)**。**M1**(`7169d13`)纯核+复述缝:`task-notebook.ts` file-first 每成员 `tasks.json`
  (坏文件隔离改名不炸轮、tmp+rename、nextId 落盘 id 永不复用、上限显式拒)+ 4 个 benign 工具
  (open/update/close/list_task_notes,与 set_reminder 同类不设开关,描述内嵌指路
  create_workflow/set_reminder 防拿笔记本硬凑工作流)+ `digest()` 复述卡经 `composeContextProbes`
  走 CARE-M4 既有 contextProbe 缝注 system prompt 尾(冻结块缓存前缀不动,**无任务 = null =
  prompt 字节不变**);factory 接线走 ownerDir 与 STATUS.md 同安全边界;21+1 单测。**M2**
  (`fb177ba`)卡壳零 LLM 提醒:纯分诊(open && 停 3d && 每任务冷却 3d 外)+ 只读快照(坏文件
  跳过**绝不隔离** —— 隔离权归管家轮唯一写者)+ 模板文案只问不做;host `ButlerTaskNudgeSweeper`
  镜像 proactive 形状 6h 常量节律,**只写自己的 fact 文件** `tasks-nudges.json`(intent/fact
  分文件双写者结构性不打架),投递走懒 pushToMember(CARE-M8 outbox),**送达才记标记**、单条信
  最多列 3 件超出显式说;armButlerSweeps 加可选门,main.ts 压 2 行注释**净零行**(预算 2990/2990
  顶格不动);7+7 单测。**M3**(`74d513d`)capstone `examples/butler-task-notebook`:故意失忆
  provider 驱动真 PersonalButlerAgent(每轮全新构造 + captureTurns:false + 结构性断言新轮首调用
  恒 1 条消息),仅靠注入摘要 5 步使命跨 6 独立轮完成;第 4 步对外发送照 park,批准前断言未发送
  未勾步(**笔记本≠授权**);`pnpm demo:butler-task-notebook` exit 0。排错记:digest 模板括号是
  ASCII `(`,初版正则 `((\d+)…)` 被当分组吞 → hexdump 定位显式 `\(` 修正 —— 对模板文本写解析器
  先 hexdump 核标点码位。验收:personal-butler 59 / host 1919 全绿,四门 PASS。见
  [`docs/zh/BUTLER-TASK-NOTEBOOK.md`](docs/zh/BUTLER-TASK-NOTEBOOK.md)。
- **接入现实生活 track（C）：C-M1 静态 token 首批 + C-M2 出站 OAuth 全完（2026-07-07/08，`6cd0a17`→`c71d7f0`）** — 用户在
  「还差多少」战略盘点里拍板走 **C（接入现实生活）**:不加框架功能,而是把触达日常工具的连接器面
  **做宽 + 做可信**,抬「深度辅助」天花板。开工前按「先查市面」核官方 MCP 注册站,抓到**改路线的
  市场真相**:现代生活连接器生态**已整体迁到「托管远程 HTTP + OAuth」**（Notion/Todoist/GitHub/
  Google 官方全是托管+OAuth）、静态 token stdio 在退场、日历按 `google calendar` 搜直接**空** ——
  故**日历/邮件/记账铁定是 OAuth 域**。好消息:出站 http/sse + `${TOKEN}` header 管道早通
  （`host/src/mcp-config.ts`）、OAuth2 原语（`oidc-client.exchangeCode` + `buildAuthorizationUrl`）
  也在（现只入站用），整个 track 只缺**出站令牌获取流**。**C-M1** 先把**厂商官方 + 静态 token**的
  少数干净选择接上:`packages/web/src/builtin-mcp-connectors.ts` 加 `notion-notes`（Notion 官方
  `@notionhq/notion-mcp-server`,`NOTION_TOKEN` 内部集成密钥,非 OAuth）+ `todoist-tasks`（Doist
  官方 `@doist/todoist-mcp`,`TODOIST_API_KEY` 个人 token,本地 stdio 走静态、托管才 OAuth）+ 新
  `tasks` 分类;两条都对**官方 GitHub README 逐字核过**命令/env（不硬编造),带凭证故显式
  `PATH: '${PATH}'`。**三条不可破边界**:①全走 MCP 框架不存数据（搬走 `.gotong/` 无连接器数据尾巴）
  ②凭证只 `${NAME}` 占位/vault,绝不明文（防腐测试钉死）③**接入≠授权行动**（挂上工具能读写,但替你
  发/花钱仍过 personal-butler 的 governed 审批闸 —— 发现≠信任在生活域的延伸）。零后端/路由/schema
  改:一键装走既有 `POST /api/admin/mcp-servers`、catalog 路由从常量派生、面板 `admin-src/mcp.js`
  通用循环渲染,新条目自动出卡;爆炸半径锁 web 常量 + 防腐测试 + 文档。验收:防腐测试
  `builtin-mcp-connectors.test.ts` 扩 15 例（两新 spec 各过真 `validateMcpServersArray` + 无明文
  密钥 + id/名唯一 + 分类合法）+ catalog 真 HTTP 路由测试 + web 全绿。**C-M2 出站 OAuth 是主菜**
  （解锁日历/邮件/记账 + 托管 Notion/Todoist),已按 opt-in 法则(用户拍板「有门槛的动作都设为可选」)
  分 5 子里程碑起手:**C-M2-M1**（`identity/oauth-outbound.ts` 出站 OAuth2 纯核:授权URL/交换/刷新
  体/响应解析,复用 PKCE·vault·`mcp-config` 可插拔 SecretSource,新建仅纯 OAuth2 变体 + refresh
  grant——`exchangeCode` 强制 id_token、`buildAuthorizationUrl` 强塞 openid 都不适用;19 单测,无人调=
  零行为变)+ **C-M2-M2**（`fae971d` 存储层:schema **v36** `oauth_connectors` 表[非密配置 + 两个 vault
  指针 + 非密 `access_token_expires_at` 列让 M4 不解密就能判过期]+ 两新 `VaultKind`[`oauth_client_secret`
  /`oauth_token`,令牌集作单个 JSON blob 进 vault 信封加密]+ `OAuthConnectorStore` 全复刻 OIDC 崩溃安全
  机密轮换[行改指后才撤旧]+ 出站独有 `setTokenSet`/`getTokenSet`/`clearTokenSet`;空 registry 逐字节不变,
  纯存储无路由读它;19 单测 + identity 654 全绿 + host tsc 零 ripple)+ **C-M2-M3**(连接流两单元:M3a
  `0e5b4e4` host 编排 `oauth-connect-service.ts` 镜像 OidcLoginService 反方向[begin mint state+PKCE 暂存·
  complete 单 POST 换码→setOAuthTokenSet,无 discovery/JWKS/id_token 故 fetch 直接注入];M3b `5648f2a` web
  路由[`POST /api/admin/oauth/start` **管理员门控**防令牌固定攻击 + `GET /api/oauth/callback` **公开靠单用
  state**,main.ts 走 factory +5 行、server.ts 棘轮显式 2350→2370];opt-in 未接 identity 逐字节不变;host
  1892/web 1289 全绿)+ **C-M2-M4**(令牌全链路打通,拆两单元:M4a `5e1ac79` 注入缝——新 `oauth-secret-source.ts`
  出站版 `${ENV}` 展开,固定保留 ref `${OAUTH_ACCESS_TOKEN}` 按 M2 `mcpServerName` **承重连接键**解析成「喂
  该 server 的连接器」活令牌[per-server 源故两 oauth server 不撞名·ref 名不带 `GOTONG_` 免误报 env 门·坏 blob
  fail-soft 不连累 spawn];pool 对 oauth **完全无感**注入 `mcpSecretSource?:(serverName)=>SecretSource`、
  `buildToolset`/`resolveRegistryConfig` 走 `secretSourceFor`、省缺=`envSecretSource` **代码级逐字节今天**;
  M4b `e6fcd33` 保活——`oauth-token-refresh.ts` `OAuthTokenRefresher` 后台计时器用 refresh_token grant 保活
  已存令牌[**读非密过期戳投影分诊不解密**·60s tick/到期前 5min 刷/start() 补 tick 恢复停机期过期令牌/
  逐连接器 fail-soft warn 一次/缺新 refresh 前推旧的];**冻结头边界**=刷新不更新运行中 toolset 活头[连接时
  焊进 requestInit.headers],会话活过令牌 mid-session 401 下次重生自愈,活连接热替 pool install/uninstall 或
  per-request 动态头**显式推迟**——「连一次永续+重生即新鲜」90% 已落;main.ts 2 行接线棘轮 2980→2986;
  8+1+10 单测 + host 1911 全绿)均已落。**M5 收尾四单元全落**:**M5a**（`b976dfb` admin OAuth 连接器 CRUD
  后端 `/api/admin/oauth/connectors[/:id[/disconnect]]` 镜像 oidc-admin,17 路由测试）+ **M5b**（`a29ebde`
  目录预设:Google 日历 + Gmail 端点/scope/托管 MCP 内置、admin 只填三件套 + `GET /catalog` 永不 503；
  先查市面抓到 **Notion 令牌端点要 HTTP Basic 而 M1 核只做 client_secret_post** → 诚实收窄只发对 M1 端到端
  可信的两条 Google 预设、Notion-OAuth 显式推迟;11 防腐测试）+ **M5c**（`4400d5d` admin 新「连接现实生活」
  标签页镜像 MCP 目录:目录卡 + 连接表单[回调预填] + 已装表 + 连接/断开打 M3b start；纯静态资产零逻辑改、
  真浏览器双语 + 连接→回跳→横幅 round-trip 验证)+ **M5d**（`c71d7f0` capstone `examples/reallife-oauth`:
  出站 OAuth 全链路一个确定性脚本[begin→换码进 vault→注入→到期刷→再注入],真 M1+M2 只 mock 网络,硬断言
  明文令牌不落盘 + per-server 隔离 + opt-in 透明 + 连一次永续;self-assert exit 0/1)。**C-M2 出站 OAuth 全完**
  —— 普通人面板里「用 Google 登录」把日历/邮件接给自己的 AI、令牌进 vault 自动保鲜、真发信/改日程仍过审批闸;
  **opt-in 全程零新 env 旋钮仍 106**。显式推迟:Notion-OAuth(待 M1 加 basic 认证)、活连接热替令牌(冻结头
  边界重生自愈)、更多 provider 预设(按需再加)。见 [`docs/zh/REAL-LIFE-CONNECTORS.md`](docs/zh/REAL-LIFE-CONNECTORS.md)。
- **STD 标准对齐 track：名片签名 M0→M2b-2 · STD-M2 全完（2026-07-07，`c6ceab4`→`ac9abc0` 共 7 commit）**
  — 用户战略问「如何继续往面向未来的简单易上手的多智能体多人协作网络基础框架方向推进」，拍板
  方向「面向未来·标准对齐」+ 姿态「opt-in 开关」。北极星第 3 层「适配=跟得上 AI 发展」的抓手：
  把 hub 对外表面逐一接**开放标准的可选强化项**。两条不可破边界（与 NET 同源）：**opt-in=默认
  字节不变**（unset 名片根本没有 signatures 字段，与今天逐字节一致——「能力」不是「行为分叉」）、
  **发现≠信任**（签名给完整性不给身份，身份锚定留 M2 PIN 公钥，永不因「卡有签名」自动建边）。
  **M0**（`c6ceab4`）计划 [`docs/zh/STD-STANDARDS-ALIGNMENT.md`](docs/zh/STD-STANDARDS-ALIGNMENT.md)
  + 实施前重核 A2A v1.0 §8.4 Signed Agent Cards 权威源（a2aproject/A2A `a2a.proto` field 13
  `signatures` + spec §8.4）。**M1**（`68a1c97`）生产侧签名+JWKS：opt-in `GOTONG_A2A_SIGN_CARD`
  （第 106 旋钮已登记）；`agent-card-signing.ts` **零外部依赖走 node:crypto**——jcsCanonicalize
  （RFC 8785，名片无数字故退化为递归 key 排序，非有限数当场抛绝不静默签错 payload）+
  FileAgentCardSigner（ES256，`.gotong/agent-card-signing.key` 0600 PKCS#8，kid=RFC 7638
  thumbprint 跨重启稳定，非 EC/坏钥当场拒——**MasterKeyProvider 同姿态 fail-closed 绝不静默换
  钥**）+ signAgentCard/attachSignature/buildJwks + **可复用 verifyAgentCardSignature**（M2 现
  成拿来用）；`createAgentCardSurface` 工厂从 main.ts 名片闭包抽出（顺手腾 7 行预算 2980→2973），
  signer 非空则 attach 签名+jku 指 jwks / null 则名片无 signatures 字段；web 新增
  `GET /.well-known/jwks.json`（鸭子 surface `jwks()` 注入，web 零 host 依赖，405/404/200+cache
  300s）。会红的门重头=**独立 node:crypto verifier round-trip**（只用 node:crypto+文档算法从头验
  签通过=外部 A2A verifier 不碰咱代码就能验咱字节，这才是标准对齐硬定义）+ 篡改任一字段即失败
  + JCS 确定性 + kid 稳定 + unsigned 字节不变；host 14 单测 + web 9 jwks 路由单测 + 真 HTTP e2e
  冒烟（真 serveWeb+真 signer，外部验签+改名失败 9 断言全过）。NET 文档「签名卡显式不做」旧注记
  同轮修正（deferred→STD-M1 done）。验收：host 1882/web 1271 全绿，四门 PASS（旋钮 106，main.ts
  2973/2980，server.ts 2345/2350）。**M2a** 消费侧验签：纯 JWS/JCS/verify 核抽到 `@gotong/a2a`
  新 `card-signature.ts`（host 只留 file-backed signer 回引+re-export，cli 加 a2a kernel 依赖
  复用验证器不碰装配层，kernel-deps 门绿）；`gotong peer-card` 读 jku（缺则回落
  `<源>/.well-known/jwks.json`）拉 JWKS 验签，打 ✓完整性/✗失败/⚠无法验/未签名，✓ 永远带
  「不代表签发者本人」——签名裁决 advisory 不改出码（契约稳定）。会红门：a2a 12+cli 5 单测
  （含独立 node:crypto round-trip、篡改即败、URL 路由 fetch）+ 真 bin×真签名 host e2e 冒烟 5
  断言 ALL PASS；a2a 55/cli 248/host 1882 全绿，四门 PASS。**M2b-1** a2a 硬化 + cli `--expect-kid`
  独立复验（无 schema，信任姿态=owner 显式确认才 PIN 永不 TOFU）：`verifyAgentCardSignature` 成功
  多返回 `keyThumbprint`（**重算**的验签钥 RFC 7638 指纹），新 `verifyCardKidMatches(card,jwks,
  pinnedKid)` 比 `keyThumbprint===pinnedKid`——**绝不信 protected 头里可被撒谎 JWKS 伪造的 `kid`
  标签**；载重测=**撒谎 JWKS 防御**（攻击者拿受害者 kid 当标签签卡 + JWKS 里把自钥也标成该 kid，
  签名验得过但重算指纹是攻击者的，如实报 mismatch 不误判 match）。`gotong peer-card <url>
  --expect-kid <kid>` 验签外多打 `锚定` 行:一致 ✓ / 不符·未签名·拿不到 JWKS（无法确认）一律
  ⚠,**这是显式断言改出码**——不符 = 出码 3（区别 preflight 未完成的 1，好让脚本
  `peer-card <url> --expect-kid <k> && 重连` 卡在钥变了时），不带旗标时与 M2a 逐字节一致
  （advisory 出码不变）。会红门:a2a `verifyCardKidMatches` 4 单测（含撒谎 JWKS 防御）+ cli 6 单测
  （一致 exit0 / 不符 exit3 / `=` 形式 / 未签名 / JWKS 不可达 / 缺值 usage）+ 真 bin×真签名 host
  e2e 冒烟加 3 断言（一致 exit0、不符 exit3、打印「不符」）ALL PASS；a2a 59/cli 254/host 1882 全绿，
  四门 PASS（旋钮仍 106）。**M2b-2** identity 落 PIN + web 捕获/显示：`peers` 表加可空 `pinned_kid`
  列（schema **v35** additive；公钥指纹非密钥故进列不进 vault）+ PeerRow/AddPeerInput/UpdatePeerInput/
  PeerRegistration 全线穿 `pinnedKid`（undefined 保留 / null 清除，同 `label` 契约）；web `POST/PATCH
  /api/admin/identity/peers` 捕获 pinnedKid（校验 **RFC 7638 43 字符 base64url shape** 防粘贴错 typo
  永久假性不符 / null 清除）+ list DTO 暴露 + admin 联邦面板策略编辑器加「锚定签名公钥」输入（预填/
  编辑/保存，空=清除）；**pin 是 advisory**——pin-only 编辑走 invalidate **不重拨**（从不碰 mesh 门
  控），单测钉死。会红门:identity peers.test 4 例（默认 null/round-trip/保留-替换-清除/与策略独立）+
  web 5 例（POST 持久化+list 暴露 / 默认 null / 坏 shape→400 / PATCH set→clear / pin-only 不
  refreshPolicy）；identity 616/web 1276/host 1882 全绿，四门 PASS（旋钮仍 106）。**M2b-3 面板内实时
  「匹配/不符」徽章 = 用户拍板显式不做**:它需服务端取对端 HTTP 名片复验,但 peer 的 `endpointUrl` 是
  wss mesh 地址、名片在另一端口/协议的 well-known,**无法从 wss 稳妥推导 card URL**——补它要给 web 开
  新出站 fetch 面（含 SSRF）+ 定 card URL 来源,是真架构岔口;按 4.4 把三选项（收 M2 / 加 `card_url`
  列常显徽章 / 按需验证）摆给用户,**用户选「就此收 STD-M2」**——验证能力已由 M2b-1
  `peer-card <https 地址> --expect-kid <kid>`（一致 exit0/不符 exit3）交付,面板已显示 pin,徽章纯便利
  不值这层新出站面;将来联邦规模大到 CLI 逐个跑嫌烦再按岔口选型重启,不预造。**STD-M2 消费侧验签 +
  信任锚至此全完**（M2a 验签 advisory + M2b-1 CLI 锚定断言 + M2b-2 面板落 PIN/显示）。
- **NET agent 网络 track 全完：A 管家出网 M0→M3 + B 名片/发现 M4→M5（2026-07-06/07，`d105712`→`73dad88` 共 6 commit）**
  — 用户拍板「先 A（管家出网）再 B（名片/发现），开工吧」：北极星第 2 层管道厚故事薄——成员
  没有一条对话式入口能让自己的 AI 代表自己跟对端 hub 打交道。两条不可破边界全程守住：管家
  绝不绕既有闸（出网走 installPeerLink 装好的 wrapper，outboundCaps/数据类/owner 审批/对端
  ACL 一道不少，零私有寻址零新特权）、发现≠信任（B track 名片永不自动建边）。**M0**（`d105712`）
  计划 [`docs/zh/NET-AGENT-NETWORK.md`](docs/zh/NET-AGENT-NETWORK.md)。**M1**（`e9f9844`）benign
  只读 `list_peers`：`buildButlerPeerSurface` 窄鸭子拼 PeerRegistry.status()+identity.listPeers()
  （disabled/revoked 边剔除），脱敏红线结构性成立（投影行根本没有 endpoint/token 字段）。
  **M2**（`322f90d`）governed `ask_peer` 主里程碑：出网=cross_hub 级动作必须成员 /me 点头
  （ask_my_agent 问自己人才 benign）；classify 在 park 前服务端权威分级（未知对端/空话/未策展
  /锁死/歧义当场拒，绝不浪费成员一次审批），execute 批准后姿态重解析（边变了诚实「情况变了」，
  绝不按旧快照盲发也绝不静默重拦）；派发阶梯被双 hub e2e 证伪一次——初版「null 边 explicit
  直达」是虚构（wrapper 连 strategy 原样转发、对端按同一 strategy 重派，explicit 指我方 wrapper
  id 过线后无人认领必死 no_participant；且 wrapper 广告能力=row.outboundCaps，G-M1
  advertise=authorize），**只有策展过的边可问**：null→诚实拒+指路策展 / []→锁死拒 / 白名单→
  capability 路由+只读预检（本地抢路/多边歧义拒）；NET-M1 的 null 姿态文案同罪同修；e2e 四场景
  双真 Hub 进程内互联（策展边全环 origin 真章/未策展拒/锁死拒/owner 双闸——成员批后诚实「还差
  一道」，owner 批完才真跨界）；零新 env 旋钮、main.ts 零行（factory 闭包已有 hub+peerRoster）。
  **M3**（`af48654`）capstone：`examples/butler-cross-hub`（host-free 四幕 demo：问→park 零字节
  出网/批准→跨界→origin 真章→答案回同轮/拒绝 fail-closed/未策展当场拒；7 自断言+exit 0 即冒烟门，
  `pnpm demo:butler-cross-hub`）+ FEDERATION-RUNBOOK「变体—管家出网」节 + 双闸最终答案回传
  **显式推迟**（①按 task.from 推回要开 inbox-service/im-bridge 间新缝还得辨任务类别 ②BE-M5 面
  只盖工作流 run——都不小，按「复用既有缝优先、新缝最小」推迟钉文档：管家常问的边不开
  requireApprovalOutbound，高敏边 owner 转达）+ PARTICIPANT/OVERVIEW 指针。A 段验收：host 1861
  全绿（15 单测+4 e2e 新增），四门 PASS（main 2973/2980 不动）。**B track（07-07 收口）动工前
  重侦察 A2A 标准**（v1.0 早 2026 定稿，authoritative=a2a.proto：supportedInterfaces 必填、
  security→securityRequirements、provider 要 url+organization 成对、skill 四字段全必填）——
  且抓到侦察盲区：外部标准查了、自家仓库没 grep，R3 早落了 agent-card.ts+路由+
  GOTONG_A2A_ADVERTISE_SKILLS，差点重造；教训钉进计划文档「侦察清单里『我们自己有没有』排
  第一」（M5 同病：概设的 `connect <url>` 早被 MCP quick-connect 占用）。**M4**（`2be8a38`）
  名片=升 v1.0 卡形+owner 策展：supportedInterfaces[]（接口级 protocolVersion 诚实写 '0.2'，
  卡形升级不冒领方法面）+ securityRequirements 与旧字段双写、provider 删（半个违规范）、
  skills 归一 description←id/tags←[]；策展文件 `<space>/agent-card.json` 人话字段翻规范卡
  （每请求现读改完即生效，优先级 策展>env 枚举>无；损坏=60s 节流 warn+整文件拒绝不半张卡）；
  概设「缺文件→404」修正——卡本就默认 serve 身份最小卡，缺省沉默指 skills 一个不登；web 路由
  零改动零新旋钮，19 单测。**M5**（`73dad88`）发现 preflight=平铺新命令 `gotong peer-card <url>`
  （与 mint-peer-token 同家族）：取对端 well-known 卡翻人话+尾部固定指回既有 token onboarding，
  只读不写看名片永不建边；404=规范内正常答案 exit 0（名片是增强不是前置），对端字段缺/类型错
  逐项降级「(未声明)」绝不炸；出码 0 明确/1 没结论/2 用法错脚本可依赖；runbook 加 Step 0；
  17 单测+真 HTTP 冒烟 9 断言（真 server+真 bin 四分支）。收官验收：cli 243/host 1868 全绿
  （途中顺手修 CARE-M8 outbox e2e 缺有界等待的并发 flake，`10db1e8`），四门 PASS
  （main 2980/2980 顶格）。当初钉「显式不做」的签名卡 keypair 已另起 STD 标准对齐 track 落地
  （见上 STD bullet）；其余（结算/多跳/目录站）仍显式不做。
- **CARE 可靠性深化 M5→M8（2026-07-06 一轮四连，`0ab8b01`→`d1a7a4a`）** — 用户指令「做管家
  可靠性深化」+「A+B 都做」：断供生命周期在上轮只有「坏了/好了」的反应式边沿（M2）+ 不看
  断供的巡检（M3），本轮补成全闭环——好了（主动·M5）/持续坏（升级·M6）/web 可见（M7）/投递
  可靠（M8），四里程碑**零新 env 旋钮**（节律/阈值/上限全常量）。**M5**（`0ab8b01`）主动恢复
  探活：`checkOutageRecovery` 纯函数，诚实边界只探「只读探针能证伪」的 kind（network/timeout/
  auth；quota/rate_limited/model_not_found 留反应式）；60s 常量节律定时器复用 CARE-M4
  onboarding key check 只读活体链——provider 半夜恢复无人说话也播「好了」。**M6**（`84d21ca`）
  长断供升级卡：`outageEscalationCard` 30 分钟阈值红牌进巡检（仍 provider-blind 只读
  `{kind,since}`，病名走 CARE-M1 翻译表）；恢复静默气密——断供文件只被 onProviderSuccess 清
  且它必播恢复，巡检再播恒冗余，按 OUTAGE_CARD_ID 滤掉；抽 `readOutageSnapshotFile` 无缓存
  新读（旁观者不能借 tracker 的内存缓存）。**M7**（`4b540fe`）断供上 web 体检面板：
  `HealthSnapshot.llmOutage` 三态（absent=host 未接/null=正常/行=断供中；读盘故障降级 null
  绝不误报红）；面板**无阈值**即时显示（30min 只为不刷 IM，不是面板的事），置顶最严重红条，
  分钟数/病名双语呈现层现算。**M8**（`d1a7a4a`）投递可靠：`ButlerOutbox` file-first 每成员
  队列——push 失败入盘仍返回原始失败、flush FIFO 停在第一个失败保序、上限 50 丢最旧 warn +
  TTL 24h 丢过期 info（no silent caps）、每成员 promise 链锁防双投；`deliverToMember` 一处缝
  盖住 pushToMember + 断供 announce，onReachable 成员一说话即 flush + 2min cadence 兜「桥好
  了人没吭声」；不给 outboxDir 字节不变。验收：host 1835 全绿，四门 PASS（main 2961/2980，
  105 旋钮不变）。真发布进度：**npm 36/36 全发布**（2026-07-07：首发卡 E429 的 11 包因新号新包
  配额窗口自然放开，单包探针后补齐）+ **PyPI `gotong` 1.1.0 已上**；待办=提醒用户 revoke 首发临时
  Automation/account-scoped token。
更早里程碑（PUB·KIT·CARE 发布/自运维/管家可靠 + FDE-M3 一轮 13 commit `e015808`→`2c121a5`
（36 包翻公开 + unscoped `gotong` 薄壳 + 发布/npx 彩排门 + backup/restore/migrate/update TS 原生
+ CARE 断供不失联 M1→M4 + provision 开荒一条命令），已滚动归档见账本末尾；
FDE 前置部署 track M0→M2（playbook 五段流水线 + 连接器槽位 name-identity +
golden-run 验收 `acceptance[]`；M3 开荒一条命令已于 PUB·KIT·CARE 轮收口 `aa51c51`）见
[`docs/zh/FORWARD-DEPLOY.md`](docs/zh/FORWARD-DEPLOY.md) 与账本末尾逐字归档、REN 全仓改名
AipeHub → Gotong 2026-07-04 一次收口 `5645b9a`（词源 *gotong-royong*，
33 包 @gotong/* + 105 旋钮 GOTONG_* + `.gotong/` 状态目录 + GitHub 仓库改名推送完成；生产机
迁移三件事）见账本末尾逐字归档、LIFE 定时工作流 L1 M1→M3 + L2① 晨报 bundle 全完（零 LLM 调度环 + 成员闸派发 +
开箱晨报；L4 生产 dogfooding 用户操作项在途）见 [`docs/zh/WORKFLOW-SCHEDULES.md`](docs/zh/WORKFLOW-SCHEDULES.md)
与账本末尾逐字归档、DEPLOY 部署简易性 A→C 全完（cloud-quickstart 一条命令 + IM token 落 vault + 向导
粘 token + 设置页缝合 + compose 真机验证 + setup 双信任锚）见 [`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md)
与账本末尾逐字归档、WIZ 六段建流向导 M1→M5 见 [`docs/zh/WORKFLOW-WIZARD.md`](docs/zh/WORKFLOW-WIZARD.md)
与账本末尾逐字归档、BE 管家增强 M1→M6（眼睛三只读 + 诊断闭环 + 零 LLM 运行播报）见
[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)、RES 资源适配
M1→M4 见 [`docs/zh/RES-RESOURCE-ADAPTATION.md`](docs/zh/RES-RESOURCE-ADAPTATION.md)、常驻管家
fold 进 IM 通道 BF-M1→M8、呈现/打包 = 只读 DAG 可视化 + 模板画廊一键装，等）：见账本。

阶段总览（v1.x → v5 全部「完」）与每个里程碑的 commit / 设计细节：见账本。

---

## 三、当前真实缺口（短期修）

> 历史「微偏」清单（协议外通路：PWA / IM / CLI / 桌面分发；AI 范式：streaming / 多模态 /
> 子 agent / 出站驱动外部 agent / long-running / HITL / 联邦…）**绝大多数已落地**——完整
> 能力矩阵与每项的 commit / 落地细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)
> 与第五节文档地图。本节只留**现在仍是缺口**的东西。

### ~~缺口 1：hub / 跨 hub 心智未在入口体现~~ ✅ 已收口

hub 是节点单位：一个人 + 自己的 agent = **主权 hub**；多 agent 也能组成**非主权 hub**（主权
在外部）；工作流既可 hub 内也可跨 hub 完成。原问题：UX 入口 / 文档按「个人 vs 组织」老框架
讲，没把真正的分界「**hub 内 vs 跨 hub**」摆到首屏。PRO + DOC 两 track 已收口：

- **PRO track（PRO-M1→M2 全完，默认 unset=字节不变）** ✅ — `GOTONG_PROFILE=hub|federation`
  呈现视角落地：纯映射层（`packages/host/src/profile.ts`，解析 + 描述符 + 双语横幅行，零
  依赖可单测）+ host 启动横幅接线（`main.ts` 在 host-ready 摘要后印视角块，认不出的值警告后
  忽略）。一条硬边界：**视角 ≠ 行为分叉**——联邦代码在 hub 档照跑、单 hub 代码在 federation
  档照跑，profile 只决定「先展示什么」；不设 = 与今天字节完全一致（运行时验证过）。详见
  [`docs/zh/DEPLOYMENT-PROFILE.md`](docs/zh/DEPLOYMENT-PROFILE.md)。
- **DOC track（DOC-M2→M3 全完）** ✅ — 文档侧：52 篇 `*-FINAL`/`V4-PHASE*`/`AUDIT-*` 账本
  git mv 进 [`docs/zh/ledger/`](docs/zh/ledger/README.md)（顶层 117→65，坏链引入 0，解析器按
  direction+depth 重算链接）+ `docs/zh/README.md` 重排成「① 上手 → ② 理解 → ③ 动手 → ④ 上线 →
  ⑤ 社区 → ⑥ 出处/历史」六级金字塔（61 篇顶层零 orphan）。这同时也收口缺口 2 的 DOC track。

### ~~缺口 2：「易于上手 / 好扩展」是唯一在退的指标~~ ✅ 已收口（FUN / DOC / EXT / GUARD 四 track 全完）

功能面已把立项目标（开源 / 多人 / 多智能体 / 协同 / 工作流 / 框架）做满；真差距在**体感上手
速度**与**扩展门槛**：装配层重（`host/src/main.ts` ~3.2K 行 / host 32 依赖）、旋钮多（~107 个
`GOTONG_*`）、文档考古层压过教程层（docs/zh 里 40+ 篇是 FINAL/PHASE/AUDIT 账本）。**内核本身干净**
（protocol 零依赖 → core → workflow / inbox，依赖方向正确，约占全仓 11%）——问题在打包 / 默认值 /
文档层，不在骨架。→ FUN（5 分钟漏斗 + TTFR 承重门）/ DOC（账本外移 + 金字塔）/ EXT（Participant
一页 + example 索引）/ GUARD（防再膨胀护栏）四 track 收口。

- **FUN track（FUN-M1→M2 全完）** ✅ — 官方 5 分钟上手漏斗 [`QUICKSTART.md`](QUICKSTART.md)（clone →
  首个可见结果的 do-this→see-that 阶梯）+ TTFR 承重门 `scripts/first-result-smoke.mjs`（spawn
  文档第一步那条 `pnpm demo`、剥掉所有 key、断言多方首个结果在预算内到达，`pnpm check:first-result`，
  会红的门）。
- **DOC track（DOC-M2→M3 全完）** ✅ — 见缺口 1（账本外移 ledger/ + docs/zh/README.md 六级金字塔）。
- **EXT track（EXT-M1→M2 全完）** ✅ — 扩展面 + 例子从「一堆」变「梯子」：
  [`docs/zh/PARTICIPANT.md`](docs/zh/PARTICIPANT.md)（20 行写一个 Participant，裸接口 +
  `AgentParticipant` 基类两写法，每个片段的 import 符号对着 `@gotong/core` 实导出核过）+
  [`docs/zh/SURFACE-PATTERN.md`](docs/zh/SURFACE-PATTERN.md)（host↔web 鸭子 `*Surface` 注入，
  web 运行时不依赖 host，加能力配方）+ [`docs/zh/EXAMPLES.md`](docs/zh/EXAMPLES.md)（50 个 demo
  按上手台阶分七级，每行标前置，绝大多数零前置）。
- **GUARD track（GUARD-M1→M2 全完，默认全绿）** ✅ — 防再膨胀护栏，四道会红的承重门
  （`pnpm check:guards` 聚合）：内核依赖方向（`scripts/kernel-deps-gate.mjs`：protocol 零依赖 /
  workflow 零 LLM / web∌host / kernel↛装配层）+ `GOTONG_*` 旋钮注册表（`scripts/env-registry-gate.mjs`
  + `scripts/gotong-env-registry.txt`，核出真实 **103** 个，加一个不登记就红）+ 装配层行数预算棘轮
  （`scripts/line-budget-gate.mjs`：main.ts≤3500 等，只降不升）+ 惯例成文
  [`docs/zh/CONVENTIONS.md`](docs/zh/CONVENTIONS.md)（惯例→门→命令总表）。

### ~~缺口 3：管家作为「用户 ↔ 框架」中间层还缺眼睛~~ ✅ 已收口

BE track（BE-M1→M6）已补齐：管家的观察面（三只读）+ 诊断闭环 + `create_workflow` + `ask_my_agent`
+ 运行结果零 LLM 主动播报，全复用既有成员向只读投影 / 审批闸。详见
[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](docs/zh/ledger/BUTLER-EMPOWER-FINAL.md)。


## 四、工作守则(开发指令)

### 4.1 与用户约定(会话级反复强调, 不要违反)

- **GitHub 已公开 + push 已解冻 (repo 2026-06-28 转 PUBLIC)**: 仓库 `Emir-Aksoy/Gotong` 已公开, push 解冻。（2026-07-04 用户授权后已完成 GitHub 仓库改名 `Emir-Aksoy/Gotong` + 推送, 旧 URL/旧克隆自动 redirect。）推送纪律: **只推 `main`**, fast-forward only, **绝不强推**; 推前 `git fetch` 校验 `git merge-base --is-ancestor origin/main main`。远端有 dependabot 分支 + PR, 不动它们。Actions 仍仓库级禁用 (公开后重新启用免费)。具体哪次该不该 push 仍按用户指令, 不擅自 push。
- **不要动备份**: `~/Backups/AipeHub/` 是历史快照, 只读
- **临时/测试产物清理阈值 (2026-06-19 用户指令)**: agent 自己产生的临时 / scratch / 测试文件 (如 `/tmp/gotong-e2e-*` 测试空间、`/tmp/gotong-*.log`、临时 host 数据目录) 占用 **≤ 10 GB 时不必清理**, 超过阈值才清。清理前先 `du -sh` 核实大小。注: harness 会拦截破坏性 `rm -rf` 大范围通配 + 前台 `sleep`, 真要清就 `rm` 具体目录、逐项删, 别用 `rm -rf` 通配。
- **不需要向前兼容**: 还没上线, 大胆改 schema / API。删旧代码比加 deprecation shim 优先
- **代码尽量简化, 节点尽量轻量**: 每个 PR 一个小目标, 别一次塞 5 个 feature
- **一个任务一个任务**: 规划完一项 → 开发 → 测试 → commit → 下一项
- **主流 agent 接入标准**: 以后每个主流 agent 适配器都必须过《`docs/zh/AGENT-ADAPTER-CONTRACT.md`》的「双向 + 可快速接管」验收门 —— ① 双向连通 (入站 MCP/A2A + 出站 shell-out/A2A/鸭子 adapter); ② 五控制缝 (可观测/可拦截/可移交/可续跑/可终止); ③ 接管粒度至少 Tier 1, 能改文件·花钱·对外发的到 Tier 2, 黑盒 agent 的副作用面在 hub 边界钉 Tier 2。新写 adapter 先对表。
- **Auto Mode bias**: 不要每步都问; 不清楚的地方留 inline 注释说明默认选择, 用户会 redirect

### 4.2 代码风格

- TypeScript ES modules(`type: "module"`), `.js` 后缀 import path
- pnpm workspace, 包间引用走 workspace protocol
- 测试用 vitest, 每个新 feature 配回归测试
- 错误用 `IdentityError` / 类似类型化错误码, 不抛裸 Error
- 日志用 `@gotong/host` 的结构化 logger(JSON / pretty 自适应)
- 注释写「为什么」, 不写「是什么」。代码自身能读出"是什么"
- 不要无故添 emoji 到文件 / commit message。除非用户明说

### 4.3 commit message 风格

参考最近 commit:
```
feat(transport-ws,host): inbound peer rate limit (Phase 6 #12)
fix(security,host,identity): Audit Phase 6 P0+P1 batch (#141-147)
docs(audit): v4 Phase 5 full audit — 15 modules, no P1/P2 hotfixes (F1)
```

- 前缀 `feat / fix / docs / refactor / chore / test`
- 括号里列动到的包名
- 短描述 + 阶段号 / issue 号
- body 写"为什么"
- 末尾固定 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### 4.4 何时停下来问

- **schema 不可逆变动**(drop column, drop table): 哪怕"不需要向前兼容",
  也确认一下是否要保留迁移脚本
- **删除现有 public API surface**: 即使没人在用, 也描述影响面再删
- **架构 fork 选择**(比如 "streaming 走 SSE 还是 long-poll"): 把选项列出
  来, 推荐其一, 等用户拍板
- **生产凭证 / .env**: 永远不读不写不 commit

---

## 五、关键文档地图(agent 用)

> 单元格里的历史落地细节已移到各文档自身正文与
> [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md)；这里只留「想知道什么 → 读哪」的路标。
>
> **逐里程碑账本已归档到 [`docs/zh/ledger/`](docs/zh/ledger/README.md)**（DOC-M2）：52 篇
> `*-FINAL` / `V4-PHASE*` / `AUDIT-*` 从 `docs/zh/` 顶层搬进去，顶层只留当前教程 / 参考。
> 下面凡指向 `docs/zh/ledger/…` 的都是那一档深潜 / 历史；内容一字未改，只挪了位置。

**根 / 定位**

| 想知道什么 | 读哪 |
|---|---|
| 项目宪章（认知 / 北极星三不可破 / 三层用途 / 信任护城河 / 愿景；与代码冲突时宪章为源） | `CHARTER.md` · `docs/zh/CHARTER.md` |
| 5 分钟总览 | `docs/zh/OVERVIEW.md` |
| 框架设计哲学 + 模块边界 | `docs/zh/ARCHITECTURE.md` |
| 给框架加能力而不加耦合（host↔web 鸭子 `*Surface` 注入；web 运行时不依赖 host；加新能力配方） | `docs/zh/SURFACE-PATTERN.md` |
| 防再膨胀惯例 + GUARD 承重门（依赖方向 / 旋钮登记 / 行数预算；`pnpm check:guards`） | `docs/zh/CONVENTIONS.md` |
| 协议规约（v1.2） | `docs/PROTOCOL.md` |
| 产品定位（赛道地图 + 产品级矩阵 + 目标用户） | `docs/zh/COMPETITIVE-LANDSCAPE.md` · `docs/zh/PRODUCT-MATRIX.md` |
| 部署视角（`GOTONG_PROFILE=hub\|federation` 入口先讲 hub 内 vs 跨 hub；呈现视角非行为开关；unset=字节不变） | `docs/zh/DEPLOYMENT-PROFILE.md` |

**上手 / 打包 / 案例**

| 想知道什么 | 读哪 |
|---|---|
| 上手案例（5 个开箱 hub 对照 + 确定性 demo + go-live） | `docs/zh/HANDS-ON-HUBS.md` |
| 20 行写一个 Participant（框架唯一扩展面：agent / 人 / 服务同一契约；裸接口 + 基类两写法） | `docs/zh/PARTICIPANT.md` |
| 50 个 example 的分级索引（先跑哪个 → 深到哪；每行标前置，绝大多数零前置） | `docs/zh/EXAMPLES.md` |
| 模板画廊一键安装 | `docs/zh/TEMPLATE-GALLERY.md` |
| 只读 DAG 可视化 | `docs/zh/WORKFLOW-DAG-VIZ.md` |
| 工作流架构师（大白话→YAML + 讲解 + 配图 + 成员 `/me` 新建） | `docs/zh/WORKFLOW-ARCHITECT.md` |
| 六段建流向导（确认→盘点→组装→衡量缺口→提议→校验闭环；三入口 + 同闸落盘 + 评测基线） | `docs/zh/WORKFLOW-WIZARD.md` |
| 定时工作流（零 LLM 调度环：意图/事实分文件 + 成员闸派发 + BE-M5 播报免费；admin CRUD + 试跑） | `docs/zh/WORKFLOW-SCHEDULES.md` |
| 易用性深化（失败修复入口 / 配置体检 / 启动兜底 / VALID 定义校验） | `docs/zh/EASE-OF-USE-DEEPENING.md` |
| 统一 `setting` 运维控制台（一命名空间 + 三入口 + 零大模型 + tier 边界） | `docs/zh/SETTING-OPS-CONSOLE.md` |
| MCP 接入（client + server） · 连接器目录 | `docs/zh/MCP.md` · `docs/zh/MCP-CONNECTOR-DIRECTORY.md` |
| 接入现实生活 track（C：把连接器目录伸向日历/邮件/消息/笔记/任务；C-M1 静态 token 首批 Notion/Todoist，**C-M2 出站 OAuth 全完**=纯核+存储+连接流+注入+刷新+admin CRUD+目录预设+「连接现实生活」面板+`reallife-oauth` capstone；三边界=全走 MCP 不存数据、凭证纪律、接入≠授权行动） | `docs/zh/REAL-LIFE-CONNECTORS.md` |
| 知识库连接器 / RAG（全走 MCP，框架不存知识） | `docs/zh/KB-CONNECTORS.md` · `docs/zh/RAG-VIA-MCP.md` |

**社区 / 上线**

| 想知道什么 | 读哪 |
|---|---|
| 荣誉激励制度（引用排行榜 / 晋升路径 / 便捷共享 / 共享范本，纯荣誉） | `docs/zh/RECOGNITION-SYSTEM.md` |
| 社区贡献 + 模板提交流程 | `CONTRIBUTING.md` · `templates/community/templates/README.md` |
| 治理 + 行为准则 + 维护者名册 | `GOVERNANCE.md` · `CODE_OF_CONDUCT.md` · `MAINTAINERS.md` |
| 旗舰模板策展索引 + 引用排行榜 | `docs/zh/FLAGSHIP-TEMPLATES.md` |
| 零算力社区站生成器 · GitHub Discussions | `docs/zh/COMMUNITY-SITE.md` · `docs/zh/COMMUNITY-DISCUSSIONS.md` |
| 前置部署 playbook（FDE 五段流水线：发现→构建→对接→部署验收→观察移交 + 两边界守则；M1a/b 连接器槽位 + M2 golden-run 验收 + M3 schedules/provision 已落地） | `docs/zh/FORWARD-DEPLOY.md` |
| agent 网络 track（NET 全完：A=管家出网 M1 眼睛/M2 ask_peer 治理/M3 双 hub capstone + B=M4 A2A v1.0 名片+owner 策展/M5 `gotong peer-card` 发现 preflight；两边界=不绕既有闸、发现≠信任） | `docs/zh/NET-AGENT-NETWORK.md` |
| 标准对齐 track（STD：对外表面接开放标准可选强化项；M1 名片签名生产侧=opt-in ES256 JWS+JWKS，M2 消费侧验签+PIN 公钥；两边界=opt-in 默认字节不变、发现≠信任） | `docs/zh/STD-STANDARDS-ALIGNMENT.md` |
| 上线 runbook（三拓扑 T1/T2/T3） | `docs/zh/GO-LIVE.md` |
| 发布 runbook（npm 36 包 + PyPI；发布前门 / OTP / 回滚=deprecate 纪律） | `docs/zh/PUBLISH-RUNBOOK.md` |
| 便携包分发（下载双击即跑，零 Node/Docker） | `docs/zh/PORTABLE-BUNDLE.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md` · `docs/OPERATIONS.md` · `docs/MONITORING.md` |

**能力专题（正文有全链路细节）**

| 主题 | 读哪 |
|---|---|
| v4 整体架构 + Phase 路线 · 跨 org federation 模型 | `docs/zh/ledger/V4-ARCH.md` · `docs/zh/ledger/V4-PHASE4.md` · `docs/zh/ledger/V4-PHASE5-FINAL.md` |
| 工作流生命周期 + 版本化（防漂移） | `docs/zh/ledger/V4-PHASE15-FINAL.md` |
| 成员任务 inbox（human-in-the-loop） | `docs/zh/ledger/V4-PHASE16-FINAL.md` |
| 用量·成本账本 + 配额 fail-closed + 审计导出 | `docs/zh/ledger/V4-PHASE17-FINAL.md` |
| 联邦能力 manifest + 跨组织 policy + A2A 闭环 | `docs/zh/ledger/V4-PHASE18-FINAL.md` |
| `/me` 成员工作台 · workflow 治理 · 安全运维 · 联邦信任契约 · 生态接入 | `docs/zh/V4-PHASE19-P1..P5-FINAL.md` |
| 控制面历史趋势 + 告警阈值 + 跨 hub 聚合 | `docs/zh/ledger/V5-F-FINAL.md` |
| 跨 hub 工作流编排（北极星 第 2 层） · 两机操作员 runbook | `docs/zh/ledger/V5-G-FINAL.md` · `docs/zh/FEDERATION-RUNBOOK.md` |
| A2A 外部 agent 当工作流步（+ 会挂起的 H2） | `docs/zh/ledger/V5-H-FINAL.md` |
| 成员大白话改工作流（OpenClaw 式）+ 跨 hub 出入口锁 | `docs/zh/ledger/V5-WFEDIT-FINAL.md` |
| 成员大白话管理 hub 设置（管家 Stream SW） | `docs/zh/ledger/V5-STEWARD-FINAL.md` |
| 常驻个人管家（记忆 + 治理 tool-loop + fold 进 host；建之前设计见 DESIGN） | `docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md` · `docs/zh/ledger/PERSONAL-BUTLER-FINAL.md` · `docs/zh/PERSONAL-BUTLER-DESIGN.md` |
| 管家增强（观察面三读 + 诊断闭环 + create_workflow + ask_my_agent + 运行零 LLM 播报；五缝复用既有成员 surface） | `docs/zh/ledger/BUTLER-EMPOWER-FINAL.md` |
| 管家任务笔记本（TN 全完：file-first 每成员 tasks.json + 4 benign 工具 + digest 复述缝 + 卡壳零 LLM 提醒 + 失忆模型 capstone；管家层不进内核、笔记本≠授权、≠第二工作流引擎） | `docs/zh/BUTLER-TASK-NOTEBOOK.md` |
| 管家记忆增强（多级 / 重要性 / 召回索引 / dreaming / 技能 / 6h 维护） | `docs/zh/ledger/MEMORY-TIERS-FINAL.md` · `docs/zh/ledger/MEMORY-ADVANCED-FINAL.md` · `docs/zh/ledger/MEMORY-DREAMING-SKILLS-FINAL.md` |
| 记忆升级（MU 全完：M1 recall benchmark 承重门 + M2 融合召回默认 + M3 原子事实抽取 + M4 外部 Mem0 provider/dataLeavesBox 披露 + M5 记忆树 git 快照 opt-in + capstone；四边界=框架不跑 LLM / 字节不变 / 数据离盒 opt-in / 内核零改动） | `docs/zh/MEMORY-UPGRADE.md` |
| 家庭学习 hub（联邦设计 + go-live） | `docs/zh/FAMILY-LEARNING-HUB-DESIGN.md` · `docs/zh/FAMILY-LEARNING-GO-LIVE.md` |
| 资源适配（RES 只读探测 → 人批准应用） | `docs/zh/RES-RESOURCE-ADAPTATION.md` |
| UI 国际化（中英双语，检测 / 切换） | `docs/zh/I18N-PLAN.md` |
| 企业 SSO（OIDC · SAML） · 联邦 peer onboarding | `docs/zh/ledger/V6-ROUTE-B-P1-M4-OIDC.md` · `M5-SAML.md` · `M7-PEER-ONBOARDING.md` |
| 出站 A2A 持久化配置 · A2A 任务生命周期 · 真实 LLM 冒烟门 | `docs/zh/V6-ROUTE-B-P1-M11 / M8 / M13`（同目录） |
| 主流 agent 适配器契约 · 快捷接入（入站） | `docs/zh/AGENT-ADAPTER-CONTRACT.md` · `docs/zh/QUICK-CONNECT.md` |
| 出站 CLI shell-out adapter · 出站 ACP 长连接 adapter | `docs/zh/ledger/V5-E2-CLI-ADAPTER.md` · `docs/zh/ledger/V5-ACP-ADAPTER.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 完整审计报告 · 全量审计 2026-06-10 | `docs/zh/ledger/AUDIT-v4-phase5.md` · `docs/zh/ledger/AUDIT-2026-06-10-FULL.md` |
| 历史 commit 流水账 · 历史外部审计 | `CHANGELOG*.md` · `audits/`（`audits/README.md` 索引） |
| **全部里程碑逐字账本** | [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) |

---

## 六、目录结构速查

> 每个包的 per-Phase 演进细节见 [`docs/zh/PROGRESS-LEDGER.md`](docs/zh/PROGRESS-LEDGER.md) 与各包 `src/*` 顶注。

```
packages/                       36 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, 零 runtime
├── core/                       Hub / Scheduler / Storage / Participant (仅依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   users/credentials/sessions/vault/quota/peers/im_bindings/
│                               suspended_tasks/usage_ledger/totp/oidc/saml/a2a·acp_outbound
│                               (SQLite, 迁移到 v26+; SSO cert/token 走公钥或环境变量名, 不进 vault)
├── host/                       生产 host 二进制 (main.ts ~3.2K 行) — 装配层, 把所有包接成一个进程
│   └── src/                    local-agent-pool / org-api-pool / pricing / peer-registry /
│                               peer-manifest / outbound-approval / a2a-server / workflow-versioning /
│                               inbox-service / hub-steward-service / steward-approval /
│                               personal-butler-* / a2a-outbound / acp-outbound / oidc·saml-login …
├── web/                        admin UI HTTP + SSE + SPA; 鸭子 surface 注入, 零 host 运行时依赖;
│                               src/*-routes.ts + static/*.js (admin.js/app-core.js 经 esbuild bundle)
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML 工作流 runner — parseWorkflow / WorkflowRunner / RunStore /
│                               predicate / resolver / lifecycle 状态机 + 修订防漂移, 零 LLM dep
├── workflow-assistant/         WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow+llm
├── inbox/                      成员任务 inbox — InboxStore / FileInboxStore / HumanInboxParticipant
│                               broker (cap gotong.human/v1), 只依赖 core
├── hub-steward/                管家 (大白话管理 hub 设置) — HubStewardAgent + 纯分类器 classifyStewardAction
│                               (四级 safe/dangerous/cross_hub/forbidden), 依赖 core+identity
├── personal-memory/            记忆引擎 — 冻结块护缓存 + 自动捕获 + 强制蒸馏 + 可换检索; 零 host/identity dep
├── personal-butler/            有界治理 tool-loop — PersonalButlerAgent + GovernedActionToolset
│                               (allow/approve/refuse 服务端权威, approve→SuspendTaskError→/me 收件箱)
├── a2a/                        A2A interop — message/send wire + a2aSend client + A2aRemoteParticipant
│                               (出站) + task lifecycle; 入站 A2aServer 在 host; 依赖 core
├── cli-agent/                  出站 CLI shell-out (hub 驱动 Claude Code/Codex/Aider…) — 五缝 + 动作闸
├── acp-agent/                  出站 ACP 长连接 (hub spawn 一次 hold session 反复派) — 五缝 + 逐动作权限闸
├── saml/                       SAML 2.0 SP 协议核 (DSig 交成熟库, 自写 SP 胶水 + XSW 防御, XML 隔离本包)
├── mcp-server/                 MCP server (Claude Desktop / Cursor 调 hub)
├── mcp-client/                 MCP client (agent 调外部 MCP tools)
├── services-sdk/               services plugin contract
├── service-memory-file/        memory(jsonl) · service-artifact-file/ artifact · service-datastore-sqlite/ sqlite
├── im-adapter/                 IM bridge 共享 SDK (ImBridge / parseImCommand)
├── im-telegram/ im-matrix/     长轮询 / Client-Server sync
├── im-lark/ im-slack/          官方长连接 / Socket Mode (免穿透)
├── im-discord/ im-qq/          Gateway WSS / 官方 Bot API webhook (入站需公网)
├── cli/                        gotong CLI (start / repl / check / doctor / setting / connect / mint-peer-token /
│                               peer-card / provision / update / backup / restore / migrate)
└── evals/                      workflow / prompt 评测
python-sdk/                     PyPI `gotong` (含 adapters/ LangGraph/CrewAI participant adapter)
templates/                      agents / teams / workflows / bundles / community
examples/                       55 个端到端 demo (上手 hub / 组织 hub / 跨 hub 编排 / adapter 桥…)
docs/  docs/zh/                 双语文档 (顶层=当前教程/参考; docs/zh/ledger/=52 篇逐里程碑账本;
                                docs/zh/PROGRESS-LEDGER.md = 全部里程碑逐字散文索引)
audits/ scripts/ monitoring/    审计快照 / backup·restore·verify·prune / prometheus+grafana
```


## 七、下一步建议清单(供 agent 起步时挑)

按"对北极星贡献度 / 工作量"排:

| 优先 | 任务 | 工作量 |
|---|---|---|
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/src/server.ts` (3563 行) 的 route groups~~ | **2026-05-28 三批完成** — batch 1 `workflow-routes.ts` (3701→3578); batch 2 `agents-routes.ts`/`services-routes.ts`/`uploads-routes.ts` (3578→2780); batch 3 `setup-routes.ts` (2780→2690) |
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/static/admin.js`~~ | **2026-05-29 完成** — esbuild bundler + 三 ES module (`services.js`/`managed-agents.js`/`workflows.js`); admin-src/main.js 3103→2344; workflow-start 共享渲染层故意留 main.js |
| ~~进行中~~ | ~~Phase 12 M9-M11 PWA + mobile responsive + 移动简化 shell~~ | **2026-05-29 完成** — PWA app-shell (manifest + sw.js + offline + icon, `/api/*` 不缓存) + 响应式 admin SPA (`@media` 720/420 单列 + 横滚表格 + 触控目标) + 5 PWA 测试; commit 7fe8a27 + c9dd395 |
| ~~中期~~ | ~~默认 RAG MCP server 推荐 + setup 文档~~ | **2026-05-28 完成** — `examples/rag-mcp/` (chroma-mcp) + `docs/zh/RAG-VIA-MCP.md` |
| 长期 | 微信小程序 / 其他原生入口 | 2-3 周 |

不要把这张表当 backlog 死磕 — 它只是"如果用户问'下面做什么'时, agent
不至于卡住"的备选。**用户指令 > 这张表**。
