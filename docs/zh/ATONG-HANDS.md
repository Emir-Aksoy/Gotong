# 阿同执行能力 track（HANDS）— 给阿同一双关在监狱里的手，配置动作搬到手机上

> Status: **M0 计划落档（2026-08-15）**——侦察 + 威胁模型 + 四档策略 + 五岔口拍板 +
> 里程碑 M1→M7。**除 M1/M2 外的里程碑都是方向性规划，实现前按 M0 惯例重新细化。**
> Last updated: 2026-08-15
>
> 用户诉求（2026-08-15 原话）：「我们要增强 atong 的执行能力，比如说增加手机可执行
> 命令。理想形态是在服务器里一键镜像完成部署，完成 im 通道后包括配 api-key 这种指令也
> 可以手机用 `/`+xxx 指令配置，拥有自行检测所在环境（根据服务器资源及用户批准决定后续
> 配置方案）、配脚手架能力、增强修复能力。将指令等级升级，涉及到 atong 自身运行基础设施
> 及凭证的文件需要人参与管理至少要确认，其他的分级自行写文件以 obsidian 类似的方式来管理
> 自己的任务和记忆和任务，甚至配开发环境、是否可行？」
>
> 前置：2026-08-14 顶级智能体对标（Manus / OpenAI Agent / Genspark 等）结论——阿同的
> 差距在**执行肢体**（沙箱、浏览器、交付物形态、多小时自治），不在神经系统（记忆 / 治理 /
> 多用户 / 联邦 / IM 原生）。本 track 只补「肢体」里与北极星相容的那一半：**关在监狱里的
> 手 + 手机上的配置面**；浏览器自动化与每任务云 VM 显式不做（见 §七）。

---

## 一、结论先行：可行，且七成是装配

用户问的六件事逐条对到仓里**已经有**的东西（file:line 都是 2026-08-15 一手核）：

| 诉求 | 今天有什么 | 差什么 |
|---|---|---|
| ① 手机 `/` 指令配置 | IM 命令面 `/help /bind /inbox /approve /deny /setting`（`packages/im-adapter/src/command-parser.ts:69-107`，`host/src/im-bridge.ts:319-471`）；`setting` 运维台三入口一个咽喉 `runOpsCommand`（`host/src/ops-core.ts:536-562`），四档 `OpsTier = read \| safe-mutate \| config-write \| destructive-offline`（`:84`），**IM 只开 read+safe-mutate，config-write 在 IM 上刻意 ✗**（`docs/zh/SETTING-OPS-CONSOLE.md:33-60`） | 配 key / 换模型这类 config-write 在手机上的**两步确认**路径；`/setkey` 的凭证录入路径 |
| ② 配 api-key | 三条既有录入路：admin 面板 / `gotong model` 走 `PUT /api/admin/agents/:id`（key 进金库）/ 向导；一次性链接机制先例（`?token=` 固定攻击防御 `web/src/server.ts:1078-1100`、设备配对码 80-bit 单次 10min、IM 绑定 6 位码、邀请令牌只显示一次 `identity-routes.ts:1378,1522`） | 手机端的**凭证录入口**（岔口 2 已拍：保留现方式 + 允许聊天直贴 + 告知优劣） |
| ③ 自行检测环境→按资源和用户批准定方案 | RES track 只读探测→提案→人批准应用（`docs/zh/RES-RESOURCE-ADAPTATION.md:27-56`，`applicable` 两态、apply 走 admin 路由）；`detectFsJail` 功能性探针（`core/src/workspace-jail-detect.ts:64`）；SEN `my_status`/`hub_health` | 探测面从「LLM 资源」推广到「机器资源 + 工具链」；方案应用走分级闸 |
| ④ 配脚手架 / 配开发环境 | 文件系统监狱纯核 `wrapWithFsJail`（`core/src/workspace-jail.ts:246`，bwrap/sandbox-exec 两内核，`buildBwrapArgs` `:299`：`--ro-bind / /`、`--tmpfs /tmp`、可写根逐个 `--bind`）；两个消费者 = `cli-agent/src/cli-runner.ts:102`、`acp-agent/src/acp-session.ts:428` | **阿同自己没有手**——没有任何工具能在监狱里跑命令 / 写工作区；监狱今天只护外驱 CLI agent |
| ⑤ 增强修复能力 | 诊断闭环 BE-M4、`fix-dirs`/`cold-start` 运维命令、AFR 医生卡、RES apply | 「能诊断」到「能动手修」之间缺分级的修复动作目录 |
| ⑥ 指令分级：基础设施/凭证文件人参与、其余自行写 | 治理闸 `GovernedActionToolset` 服务端权威 allow/approve/refuse，`classify` 可注入（`personal-butler/src/governed-toolset.ts:54,90-95,146`）；IMA 手机可批白名单按名字形状 fail-closed（`host/src/personal-butler-escalation.ts:89-96`）；LIB 知识树 `.md` 已是 Obsidian 可直接打开的目录（`knowledge/`，200 文件/32KB/4MB/6 深） | 一张**统一的写目标/命令四档表**把散落的分级（OpsTier / governed / IMA）收成一个策略；Obsidian 投影层 |
| 一键镜像部署 | `Dockerfile` + `docker-compose.yml`（env `:43`）+ `docker-compose.prod.yml`（`:67,:146`）+ `deploy/`（Caddyfile / systemd / watchdog / cloud-quickstart） | IM token 作为部署期 env 一次到位（手机优先的鸡生蛋）；e2e 门 |

**判定**：真正要新造的只有三件——(a) 关在监狱里的手（工具面 + 上限 + opt-in），(b) 统一四档策略
（一个纯核，所有写/执行动作都问它），(c) 手机端凭证录入路径 + config-write 两步确认。其余是把
既有件按同一张表接线。

---

## 二、五岔口拍板记录（2026-08-15，用户原话「1=两者；2=保留目前方式，允许聊天直贴，告知用户两种方式优劣；3=每次park；4=md 投影层、JSON 仍是真相；5=hub 同机监狱」）

| # | 岔口 | 拍板 | 落地含义 |
|---|---|---|---|
| 1 | 手的形态：原生确定性执行工具（阿同做脑） vs 外驱 CLI coding agent（cli-agent 五缝） | **两者** | M2 先做原生手（零新依赖、阿同直接用）；M2b 把 Claude Code / Codex / Aider 经 `@gotong/cli-agent` 接成兄弟参与者干重活，**共用同一个成员工作区**，阿同经 escalate 同型转派 |
| 2 | api-key 录入：只走网页/一次性链接 vs 允许 IM 直贴 | **保留目前方式，允许聊天直贴，告知优劣** | `/setkey` 双路径：(a) 直贴 `/setkey <目标> <key>`；(b) `/setkey link` 出一次性链接。**每次回复都附优劣文案**（直贴=快、零跳转，但 IM 平台服务器可见你的 key 且聊天记录留底；链接=key 只走 TLS 到你自己的 hub，平台看不见，多一步跳转） |
| 3 | 阿同自身基础设施（tier 2）动作：每次 park vs 项目级一次授权 | **每次 park** | tier 2 动作一律 approve，无 blanket grant；批准走 IMA 手机短码（hub 内配置动作本就 `imApprovable`） |
| 4 | Obsidian：重写记忆引擎成 md 库 vs md 投影 | **md 投影层，JSON 仍是真相** | tasks.json / semantic.jsonl 等真相不动；投影 `tasks.md`、`memory/*.md`（frontmatter + `[[wikilink]]` 指知识笔记），标「自动生成，改了会被覆盖」 |
| 5 | 执行位置：hub 同机监狱 vs 独立容器/云 VM | **hub 同机监狱** | 复用 `wrapWithFsJail`（bwrap / sandbox-exec），可写根=成员工作区 + tmp，`<space>/` 配置区**结构性不在可写根**；监狱缺席=手不装（fail-closed） |

---

## 三、威胁模型：为什么「手」必须先关起来

阿同是被注入面最宽的参与者：IM 消息、搜索结果、信封 payload、连接器返回、群聊里别人的话
全是 observed content，都能进它的上下文。今天最坏后果是「park 一个坏动作等人批」；一旦给它
`run_command`，**注入即 RCE**：读 vault / 外传 key / 装后门 / 填盘 / 挖矿。四道防线缺一不可：

1. **监狱**（结构性）：可写根只有成员工作区（`<space>/butler/hands/user/<userId>/workspace/`，
   `assertSafeOwnerId` 先于任何拼接）与 tmpfs；`<space>/`（agents.json / vault / 钥 / gotong.env /
   identity.sqlite）以只读 bind 进监狱**都不行**——它们含凭证，读了就等于泄。故 M2 监狱 **不 bind
   `<space>`**（bwrap `--ro-bind / /` 是全盘只读——`<space>` 在盘上，须显式 `--tmpfs` 盖掉或改成
   最小可读根白名单；M2 细化时以「进程 `cat <space>/gotong.env` 必须失败」为门）。网络默认
   `--unshare-net`（`buildBwrapArgs` 今天不隔网，`:276` 注释「network, and exec stay allowed」是给
   外驱 coding agent 留的——**手 A 的默认与之相反**）。
2. **四档策略**（服务端权威，fail-closed）：见 §四。未知一律不 allow。
3. **凭证结构性缺席**：阿同没有任何工具能读/写凭证**值**（只见名字/槽位/有无）；`/setkey` 直贴
   由桥层截获直接进金库，**不进阿同上下文、不进 SESS 会话窗、不进 transcript**，回复不回显。
4. **审计 + 上限**：每次执行落审计行（argv/cwd/出码/时长/字节数，不落 stdout 全文）；单命令
   时长 ≤120s、输出尾巴 ≤32KB、工作区总量 ≤512MB、并发 1/成员；超限响亮拒。

**残余（如实）**：监狱内资源滥用靠上限兜（bwrap 不做 cgroup）；bwrap 依赖非特权 userns
（Ubuntu 23.10+ 默认 AppArmor 限制非特权 userns，部署时可能要 `sysctl
kernel.apparmor_restrict_unprivileged_userns=0` 或 setuid bwrap——M2 探针须能诊断并说人话）；
macOS `sandbox-exec` 已弃用但可用；hub 非 root ⇒ `apt`/`systemctl` 结构性做不了（这是**特性**：
系统级动作留给人，阿同只能「指路」）。

---

## 四、设计

### 4.1 统一四档表（所有写目标 / 命令都问同一个策略）

| 档 | 对象 | 判定 | 谁批 | 说明 |
|---|---|---|---|---|
| **0 自留地** | 知识树 `knowledge/`、面板内容、任务笔记本、记忆、Obsidian 投影 | allow（经**各自既有工具**） | 无 | 只写本人展示/自用数据；**JSON 真相文件只经各自工具写**（TN/记忆的 schema、上限、id 保证都在工具里），raw 文件写这些路径 = refuse |
| **1 工作区** | 成员工作区内 `hands_write/read/list/rm`；监狱内 `hands_run`（**断网**） | allow | 无 | 装脚手架 / 写脚本 / 跑测试 / 建项目；监狱 + 上限兜底 |
| **2 阿同自身运行基础设施** | 联网执行（装依赖/拉代码）、`setting` config-write（`config-set/config-price`）、建改 agent/工作流（既有 governed 工具）、RES 方案应用、桥重连、模板安装 | approve（**每次 park**） | 本人（IM 短码 `/approve` 或 /me） | 走**类型化动作**不走 raw 文件写：agents.json / workflows/ 有校验器在工具里，raw 写它们 = refuse + 指路 |
| **3 凭证材料** | vault / master key / 签名钥 / bot token / gotong.env 值 / identity 库 / systemd unit / Caddyfile | refuse（结构性缺席 + 分类兜底） | 人亲手（`/setkey` 双路径 / 网页 / CLI） | 阿同只能「声明需要哪个变量名」（`request_env_var(NAME)` 出一张给人的卡），值永不经它 |

判定纯函数 `classifyHandsAction(action, ctx) → {tier, verdict:'allow'|'approve'|'refuse', reason}`
（`packages/personal-butler/src/hands-policy.ts`，host-free）：`write` 看解析后的绝对路径是否在
工作区内（`isInsideRoots` 同型，realpath 防符号链接逃逸）；`run` 看 `net` 标志（false→1，
true→2）+ 一小张 argv 前缀拒绝表（`sudo su apt apt-get systemctl docker mount` 与 `curl|sh`
形状——**做不了或不该做的直接拒，别浪费一次审批**）；其余一律按 fail-closed 落保守侧。
`verdict` 直接喂 `GovernedActionToolset.classify` 缝（`governed-toolset.ts:90`）。

### 4.2 手 A：原生确定性执行工具（M2）

`buildButlerHandsToolset(userId, opts)`（host `personal-butler-hands.ts`，AFR 注册三件套）：
`hands_run {argv, cwd?, stdin?, timeoutSec?, net?}` / `hands_write {path, content}` /
`hands_read {path}` / `hands_list {path?}` / `hands_rm {path}`。全部相对成员工作区解析；
执行 = `wrapWithFsJail({writableRoots:[workspace, tmp], cwd, unshareNet:!net})` → spawn。
监狱探针 `detectFsJail` 结果 `kind:'none'` ⇒ **整套手不装**（fail-closed，B1 能力清单如实不列），
`my_status` 多一行「手：已装(bwrap)/未装(原因)」。opt-in file-first `<space>/hands.json`
`{enabled:true, maxRunSec?, maxOutputBytes?, maxWorkspaceBytes?}`（apns.json/fcm.json 同族三态
合同：缺席 OFF 字节不变 / 形状不对 warn+OFF / 开了但监狱缺席 boot warn+OFF 并说明装法），
**零新旋钮（116 冻结）**。审计行 + 每命令回执给模型只带出码/尾巴/字节数。

### 4.3 手 B：外驱 CLI coding agent（M2b，opt-in）

owner 用既有 `@gotong/cli-agent` 把 Claude Code / Codex / Aider 接成兄弟参与者
（`docs/zh/ledger/V5-E2-CLI-ADAPTER.md` 五缝 + 动作闸），**可写根指到同一个成员工作区**（阿同写
需求文件、coder 改代码、阿同跑测试验收——文件就是接口）；阿同经 `escalate_to_expert` 同型
fire-and-forget 转派（`personal-butler-escalate.ts:118` explicit 直达），结果 pushToMember 推回。
需要机器上有该 CLI 及**用户自己的** key（M3 `/setkey` 也能录）；没有=不装。

### 4.4 手机配置面（M3）

- **`/setkey`**：`/setkey <provider|agentId> <key>` 直贴（桥层截获 → 金库，与 admin API 同一写入
  服务；回复固定「已存入 · 请手动删除刚才那条消息」+ 优劣文案，平台支持时 best-effort 撤回原消
  息）/ `/setkey link` 出单次 10min 链接（设备配对码同族：`hands_credential_codes` 单用户单码，
  链接打开极简页 POST key + token，**不建会话**）。**发送方必须是绑定了 owner/admin 用户的 IM 身份**
  （im_bindings → userId → role），否则同 IM 命令面其他门一样「未启用」。
- **config-write 上手机 = 两步确认**：`/model set <agent> <model>`、`/setting config-set K V`
  等先回「将改 X→Y，回 `/approve <短码>` 确认」，短码走 IMA 同一 pending 面；`destructive-offline`
  仍 CLI-only。这是对 `SETTING-OPS-CONSOLE` 表「config-write ✗ IM」的**显式改口**——当年 ✗ 的理由
  是 IM 单步无确认，两步确认后理由消失；文档同刀改。
- **`/keys`** 列 key 有无（名字/槽位/有无/最后测试结果），永不列值。

### 4.5 环境探测 → 部署方案 → 人批（M4）

零 LLM 探针（cpu/mem/disk/node/ffmpeg/bwrap 或 sandbox-exec/docker/GPU/出网可达）折成
`hub_environment` benign 工具 + RES 同型**提案卡**（每条 `applicable` 两态：可自动应用的走 tier 2
approve，不能的写「你要做什么」指路）。典型：内存 <4GB ⇒ 建议关 embedder/单管家；无 ffmpeg ⇒
语音腿不可用 + 装法；无监狱 ⇒ 手不可用 + 装法；无出网 ⇒ 搜索/推送退化。**探针每轮零 LLM，
方案由阿同渲染，应用经闸**。

### 4.6 Obsidian 投影（M5）

`<ownerDir>/` 本就可被 Obsidian 当 vault 打开（`knowledge/` 是 md 树）。补三块只读投影：
`tasks.md`（从 tasks.json，含 `[[knowledge/...]]` 链）/ `memory/<tier>.md`（事实摘要 + 出处）/
`STATUS.md` 已在。生成时机=各自写路径末尾 + 6h 维护兜底；frontmatter `generated: true`；
真相仍 JSON，投影被人改了下次覆盖（并在 STATUS 里提一句）。零 LLM。

### 4.7 一键镜像（M6）与修复接手（M7）

M6：compose 加 IM token / provider key 的部署期 env 透传（`GOTONG_TELEGRAM_BOT_TOKEN` /
`GOTONG_LARK_*` / `GOTONG_WECHAT_BOT_TOKEN` 既有旋钮，零新增），一次 `docker compose up` 后
IM 通道即在；**至少一次网页触碰不可避免也不该避免**（owner 设密 + `/bind` 出码 = 身份锚），此后
配置全在手机。镜像发布到 GHCR = 用户门。M7：修复动作目录按四档挂——`fix-dirs`/清缓存(1) /
重拉桥、重连 MCP、应用 RES 提案(2) / 「换钥/改 unit」指路人(3)；AFR-M5 面包屑在失败分支多一句
「阿同能修的直接提议修」。

---

## 五、五条不可破边界

1. **手在监狱里，配置区结构性不在可写根；监狱缺席=手不装。** 绝不「没监狱先裸跑将来再关」。
2. **分级服务端权威、fail-closed。** 未知路径/未知形状永不 allow；JSON 真相文件只经各自工具写；
   tier 2 每次 park（岔口 3）。
3. **凭证值结构性不经阿同。** `/setkey` 直贴由桥层截获，不进上下文/会话窗/transcript，不回显；
   双路径每次附优劣文案；阿同只能声明变量名。
4. **opt-in file-first `<space>/hands.json`，未装字节不变，零新旋钮（116 冻结）。**
5. **北极星不动**：hub 不跑 LLM（手是阿同这个参与者的工具，探针零 LLM）；人和 agent 同一
   Participant（手 B 是兄弟参与者不是特权后门）；file-first；内核除 `workspace-jail` 加可选
   `unshareNet`（additive，既有调用者字节不变）外零改动。

---

## 六、里程碑

| # | 里程碑 | 交付 | 会红的门 |
|---|---|---|---|
| M0 | 本文 | 侦察 + 威胁模型 + 四档表 + 五岔口 | — |
| M1 | 四档策略纯核 | `personal-butler/src/hands-policy.ts` 纯函数 + 拒绝表 + realpath 逃逸判定 | 单测：配置区/凭证路径永不 allow；符号链接逃逸 refuse；`net:true`→approve；未知→非 allow；拒绝表命中 refuse |
| M2 | 手 A 原生 | host `personal-butler-hands.ts` 执行器 + 五工具 + `hands.json` opt-in + `unshareNet` + 上限 + 审计 + factory 接线 + AFR 三件套 + main.ts 棘轮显式抬（现 2768/2770） | 真 spawn 门：`cat <space>/gotong.env` 在监狱内失败；写 `<space>/agents.json` 双拒；断网命令 `curl` 失败；超时/超输出响亮；`kind:'none'` 整套不装；缺席字节不变；**Codex 交叉审**（安全承重） |
| M2b | 手 B 外驱 | cli-agent 参与者 + 共用工作区 + escalate 转派配方 + docs | e2e：阿同写需求→coder 改文件→阿同 `hands_run` 跑测试 |
| M3 | 手机配置面 | `/setkey` 双路径 + 一次性链接 + 优劣文案 + config-write 两步确认 + `/keys` + SETTING-OPS-CONSOLE 改口 | 单测：直贴不进 SESS 窗/transcript、不回显；非 owner/admin 绑定拒；链接单次 10min；两步确认走 IMA；**Codex 交叉审** |
| M4 | 环境探测→方案→人批 | `hub_environment` + 提案卡 + tier 2 应用 | 探针零 LLM；不可应用项只指路 |
| M5 | Obsidian 投影 | tasks.md / memory/*.md 生成 + frontmatter + 覆盖语义 | 真相未动；投影可 Obsidian 解析 |
| M6 | 一键镜像 e2e | compose env 透传 + e2e 脚本 | `compose up` → IM 在 → 网页一次触碰 → 手机 `/setkey`→`/model` 全通 |
| M7 | 修复接手 + capstone | 修复动作目录 + `examples/atong-hands` 四幕（注入写配置双拒 / 联网 park 批后跑 / 工作区直写+监狱跑脚本 / `/setkey` 双路径文案 + 金库落值零回显） + 收口 | `pnpm demo:atong-hands` exit 0，零 key 零 LLM |

顺序按用户优先级：**M1→M2（手）→M3（手机）**先，M4/M7 次之，M5/M6 后置；M2b 在 M2 后按需。
每刀：新单测 + 四门 PASS（旋钮 116）+ 一刀一 commit；M2/M3 必过 Codex 交叉审。

---

## 七、显式不做

- 每任务云 VM / 独立容器（岔口 5 已拍同机监狱；行业形态在，但撞轻量与自托管）。
- 浏览器自动化 / computer use（独立 AI 浏览器形态 2026-08 已被行业判死；若要走 MCP 浏览器连接器
  另起 track，且仍在闸后）。
- 阿同自注册账号 / 自取 key / 自管凭证值（LSA-M0 立场不变：发现+建议，人录入）。
- 自动转发凭证、blanket grant、root 级动作（apt/systemctl）——结构性做不了，也不该做。
- 子代理 swarm / 多小时无人自治（一消息一任务 ≤16 轮不动；长活走工作流 + 定时）。

---

## 八、验收纪律

`packages/*` 只动 personal-butler（策略）/ host（执行器、桥命令、投影）/ core（`unshareNet` 一处
additive）；四门 PASS 全程；每个新 builder 过 AFR 注册三件套（tiers 名单 / toolface tripwire /
门）；真机 round-trip 以「盘上产物 + 审计行」为准；安全承重刀（M2/M3）Codex 交叉审后才 commit
收口。
