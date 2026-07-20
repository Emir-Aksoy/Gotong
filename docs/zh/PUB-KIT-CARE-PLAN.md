# PUB·KIT·CARE + FDE-M3 —— 下一轮优化计划（设计 / 实施 / 验收）

> 用户圈定六项（2026-07-05）：**发布 npm/PyPI**、**自运维命令化**（把 2026-07-05
> 生产迁移那天手工做的事变成命令）、**FDE-M3 按方案开荒一条命令**、管家侧
> **开箱陪跑**、**主动巡检 + 失败翻译官（懒加载 LLM）**、**断供不失联**。
> 本文把每项钉成：里程碑 + 实施要点 + 决策默认（inline，可 redirect）+ 会红的
> 验收门。逐里程碑一 commit 执行；收口后按惯例登记 CLAUDE.md 与账本。
>
> 三关校准（这六项从哪来）：常驻上线三关 = 一台常开的机器（**硬**）/ 模型端点
> （**半硬**，key 可绕）/ IM（**软**，可绕）。六项分别压：装（PUB）、养（KIT）、
> 开荒（FDE-M3）、陪（CARE-M4）、看（CARE-M3）、稳（CARE-M2）。
>
> Last updated: 2026-07-05 · **计划态（未开工）**

---

## 〇、总原则（所有 track 共守）

- **三句话守则不动摇**：新增的巡检 / 播报 / 翻译 / 断供回复**全部零 LLM**；
  LLM 只在管家自己的回合懒加载（用户追问「为什么」才烧 token）。
- **file-first**：新状态（巡检 diff 基线、断供标记、陪跑完成标记、调度建议）
  都是 space 下的 JSON 文件；意图 / 事实分文件惯例照 LIFE。
- **每里程碑一 commit** + 至少一条**会红的自动验收**；四门
  （`pnpm check:guards`）全程绿。
- **main.ts 棘轮只剩 3 行余量**（3247/3250）：CARE 任何 host 接线之前，先做
  前置腾挪抽取（惯例同 LIFE 的 `armButlerSweeps` / FDE 的三抽取）。
- **新旋钮尽量零**；非加不可则登记 env-registry（GUARD 门会红）。
- **transcript.jsonl 是不可变审计日志**：任何 track（尤其 KIT-M2 migrate）
  永不改写。同理 secrets.enc.json / identity.sqlite / master key 家族只由
  各自既有代码路径碰。

---

## 一、Track PUB —— 发布 npm（+PyPI）

**北极星贡献**：上手第 0 关从「clone → install → build」变 `npx gotong` 一行；
npm 包自带 prebuilt dist，用户机上**零编译**（2026-07-05 实测串行构建峰值
417MB——发布后这件事不再发生在用户机上）。

**现状盘点（2026-07-05 核实）**：
- cli 已叫好名：`@gotong/cli`，`bin: gotong`，`publishConfig: public`，描述里
  写着 `npx @gotong/cli`——发布故事早有伏笔；host 亦有 `bin: gotong-host`，
  protocol / web / sdk-node / services-sdk 发布字段齐全。
- **真正的活**：18 个包标着 `private: true`（identity / evals / a2a / acp-agent /
  cli-agent / hub-steward / im-adapter / im-{lark,telegram,slack,qq,discord,matrix} /
  inbox / personal-memory / personal-butler / saml / workflow-assistant），其中
  **15 个在 host 的依赖闭包内**——不翻公开，`npm i @gotong/host` 装上即断链。
- 版本各包自持（protocol 3.1.0 / host 3.2.0 / cli 1.0.0…），**不搞 lockstep**：
  `pnpm -r publish` 自动把 `workspace:*` 转真实版本。
  > **2026-07-20 修正**：这条盘点的理由不成立，已改为 lockstep（全部 4.0.0）。
  > `pnpm` 确实会转 `workspace:*`，但转成的是**精确钉版**而不是范围——npm 上
  > `@gotong/core@3.1.0` 的 deps 里躺着 `"@gotong/protocol": "3.1.0"`。于是「各包
  > 自持」在这张依赖图下并不成立：改了 protocol 不升 core，装 core 的人永远拿到旧
  > protocol。实际后果也已发生——此后两个月没再定版，web 攒了 327 次提交、host
  > 220 次，而 36 个包以完全相同的号躺在 npm 上。见 [`VERSIONING.md`](VERSIONING.md)。
- npm 未注册（REN 核过 `gotong` 名 npm/PyPI 均空闲）——**抢注风险真实存在，
  用户动作越早越好**。

### PUB-M1 发布就绪（纯仓库侧，一个 commit）

- 翻 18 个 private → public，补齐 `publishConfig` / `files` / `repository` /
  `license` 缺项；`files` 必含 `dist`（含 `prepack` build，装到即用）。
- 新增薄壳包 `packages/gotong`（unscoped 名 `gotong`，bin 转发 `@gotong/cli`，
  依赖 cli + host）——让 `npx gotong` 五个字成立。
  - 决策默认：**加薄壳而非把 @gotong/cli 改名**——保住 REN 刚统一的
    `@gotong/*` 命名面；npx 首跑要拉 host 闭包（一次性，约 160MB），可接受，
    完全不能接受的人有便携包。
  - `gotong up` 新命令 = 起完整 host（转发 `gotong-host` bin）；既有 `start`
    的 sidecar 语义**不动**（M1 先核实 start.ts 现状再定措辞）。
- **会红的门** `scripts/publish-readiness-gate.mjs`（挂 `pnpm check:publish`）：
  从 {gotong, @gotong/cli, @gotong/host, sdk-node, services-sdk} 走依赖闭包，
  断言闭包内无 private / 无缺字段 / `pnpm pack` 产物无 `workspace:*` 泄漏 /
  dist 在包里。

### PUB-M2 本地全链路彩排（零外网 registry）

- devDep 引 verdaccio，脚本起本地 registry → `pnpm -r publish --registry
  local` → 干净临时目录 `npx --registry local gotong up`，剥掉所有 key，断言
  host-ready 横幅在预算内出现（TTFR 姿态同 first-result-smoke）。
- 挂 `pnpm check:npx-smoke`（会红：任何包漏发 / bin 断链 / dist 缺文件都在
  这里现形，而不是在真 npm 上）。
- PyPI 侧：python-sdk `python -m build` + `twine check` 过即绿（不真传）。

### PUB-M3 真发布（用户动作 + 半天收尾）

- **用户动作清单**（越早越好，防抢注）：
  1. npm 注册账号 + 建 org `gotong`（scope `@gotong` 归属）+ 占 unscoped 名；
  2. PyPI 注册 + 占 `gotong` 名；
  3. 发布时刻在场（npm 2FA/OTP 不宜自动化）。
- 我方：发布 runbook（拓扑序发包、`--provenance` 可选、失败回滚=deprecate 不
  unpublish）；发完真机 `npx gotong@latest up` 冒烟；QUICKSTART / GO-LIVE /
  README 增 npx 首选路径。
- 验收：干净机器（服务器上开临时目录即可）`npx gotong up` 到 host-ready；
  `pip install gotong` 导入冒烟。

---

## 二、Track KIT —— 自运维命令化 `gotong backup / restore / migrate / update`

**北极星贡献**：「复制目录 = 搬走房间」从哲学变成命令；2026-07-05 生产迁移的
手工剧本（env 前缀转换 / 数据标识符改名 / 受限构建）固化成一等公民。

**现状盘点**：`scripts/backup/{backup,restore,verify,prune,drill}.sh` 已是全套
且语义讲究（master key 两个世代全排除、会话文件排除、sqlite3 `.backup` WAL
安全、无 sqlite3 时大声降级）；缺的是（a）CLI 化（Windows 便携包跑不了 bash）
（b）migrate / update 两个新动词。identity 的驱动是 better-sqlite3（peer，
host 提供）。

### KIT-M1 `gotong backup` / `gotong restore`（TS 原生，.sh 原样保留给服务器）

- 语义**逐字对齐** backup.sh：默认在线备份；排除
  `runtime/secret.key`、`identity-master.key*`、`runtime/{admin,worker}-sessions.json`；
  identity.sqlite 走 WAL 安全快照，**诚实阶梯**：better-sqlite3 可解析（装在
  host 旁）→ 驱动 backup API；否则 sqlite3 CLI；否则原样拷贝 + 大声警告。
- `--include-master-key`：搬家场景显式带钥匙，带就大声提示「这份备份能解开
  一切，落盘即密级」；默认不带（与生产 cron 同哲学：钥匙异地另存）。
- `gotong restore <tgz> --space <dir>`：拒绝写非空目录（`--force` 才覆盖）；
  校验 manifest（M1 给归档加 `manifest.json`：文件清单 + sha256）；恢复完自动
  跑 doctor 定义校验。
- 实现位置：`packages/cli/src/commands/{backup,restore}.ts` + 可单测纯函数核
  （排除规则 / 清单构建）。better-sqlite3 为 cli 的 **optionalDependency**。
- 验收（vitest）：备份→篡改→restore 拒绝（hash 不符）；活写中备份→恢复后
  `PRAGMA integrity_check` ok；默认包内**无 master key 断言** + 提示语断言；
  `--include-master-key` 才有。

### KIT-M2 `gotong migrate`（scan / apply 两段式——改名残留医生 + 搬家）

- `gotong migrate scan <space>`：只读，报告旧标识符残留（今天生产真实修过的
  四类）：`@aipehub/service-*`→`@gotong/*`（services/plugins.json）、
  `aipehub.*/v1`→`gotong.*/v1`（workflows 定义 + revisions 快照）、品牌串
  `AipeHub`→`Gotong`（space.json / agents.json，`--brand` 才动）、以及 env
  前缀 `AIPE_*`→`GOTONG_*`——**env 文件永不读**（生产凭证纪律），scan 只
  打印一条给用户自己跑的 `sed` 命令。
- `gotong migrate apply <space>`：白名单模式替换（只动 scan 认识的
  file×pattern 组合），逐文件先落 `*.premigrate` 副本，JSON 改后即时
  parse 校验；**transcript / secrets / sqlite / key 永不入白名单**。
- 搬家配方 = backup（--include-master-key）→ scp → restore → doctor，写进
  OPERATIONS.md，不另发明命令。
- 验收：fixture space 埋满四类残留 → scan 全数报告 → apply → 复用 host E2E
  启动器断言零 definition 错、services ready 非空；transcript 字节不变断言。

### KIT-M3 `gotong update`（探测安装形态，永不代跑重启）

- 形态探测：git checkout（有 .git）→ `git pull --ff-only`（纪律与人同）+
  构建默认 `--workspace-concurrency=1`（2026-07-05 实测串行峰值 417MB /
  零 swap，小内存机安全），构建前把现 dist 挪 `dist.prev`，构建红自动还原；
  global npm → `npm i -g gotong@latest`（依赖 PUB-M3）；便携包 → 指路下载新包。
- 更新完自动 `gotong check`，**打印**重启命令（systemd / 前台各一句），不代跑
  ——重启权在运维手里。
- 验收：fixture git 仓库（本地 bare remote）快进更新走通；非 ff 拒绝断言；
  构建失败回滚 dist.prev 断言。npm 形态在 PUB-M3 后补真测。

---

## 三、Track FDE-M3 —— 按方案开荒一条命令

**定义来自 playbook**（FORWARD-DEPLOY.md §四缺口表 + §五草案）：
「起 hub 之后装模板、建调度、跑验收全是手工续段」→ quickstart 续段一条命令；
`schedules[]` 是继 `requires` / `acceptance` 之后**第三个 `gotong.template/v1`
可选块**，落地姿态与前两块**完全同构**（无新 schema id，旧 host 整块忽略）。

### 交付一：`schedules[]` 块四段链路（镜像 M1a/M2 模式）

```yaml
schedules:                      # 调度建议（不带人员——userId 出现即拒，晨报先例）
  - workflowId: morning-brief   # 必须指向模板自带流（typo 装时就报）
    cadence: { kind: daily, hour: 8 }   # 复用 LIFE 归一化纯函数：半解析=装时报错
    note: 装完在「定时」卡选成员启用
```

1. 解析（`web/src/template-manifest.ts`）：大声校验——workflowId 指向自带流 /
   cadence 走 `@gotong` LIFE 既有归一化（归一失败=拒）/ **出现 userId 即拒**
   / id 去重；纯调度包仍按空模板拒。
2. 装时报告：`postInstallChecklist.scheduleSuggestions[]`。
3. 装后持久化：host `template-schedule-suggestions.json`——只存意图、按模板名
   last-install-wins、损坏 warn+当空，绝不拦装（姿态逐字同 M1b/M2 store）。
4. 呈现：admin「定时」卡显示「建议」行 + 一键**补人**启用（写入真调度文件走
   M3 CRUD 既有 API，成员闸不可豁免）。

### 交付二：`gotong provision <pack> [--user <memberId>]` 一条命令

对着**本机在跑的 hub** 依次：装模板（templates/import 既有 API）→ 打印
`connectorsToWire` / `kbSlotsToWire` 接线清单（**绝不自动接线**，M1a 立场）→
有 `--user` 则把调度建议落成真调度（语义 = 该成员自己点了启用；没给则只列建议）
→ 跑 `acceptance`（M2 既有 run API，await 判卷）→ 出**开荒报告**：
绿（装了什么 + 验收绿）/ 黄（缺哪根线、哪条建议还没补人）/ 红（验收红 + 逐条
violation）。`deploy/cloud-quickstart.sh` 增 `--pack` 旗标接到 host-ready 之后。

- 验收：模板解析测试（schedules 三拒：坏 workflowId / 坏 cadence / 带 userId）；
  provision E2E——空 hub + morning-brief 包一条命令到报告，mock provider 下
  验收绿（诚实模式即合格线）+ 建议未补人黄；`--user` 后调度真落盘且 fire 走
  成员闸。dogfood：晨报包含 `schedules` 块重装。
- 收口时同步：FORWARD-DEPLOY.md §五 schedules 从草案改「已实现」，§四缺口表
  勾 M3。

---

## 四、Track CARE —— 管家可靠性（翻译表 → 断供 → 巡检 → 陪跑）

**接线点已核实**：体检核 `packages/host/src/admin-health.ts`；sweep 装配
`personal-butler-sweeps.ts`（armButlerSweeps）；IM 自由文本 `im-bridge.ts`。
播报同意面复用 BE-M5（成员 IM 说「打开运行播报」）——**巡检骑同一份同意，
零新旋钮**。

### CARE-M1 错误翻译表（共同地基，纯函数）

- `@gotong/llm` 出 `classifyLlmError(err)`：provider 错误 → 类型化 kind
  （auth / quota / rate_limited / network / model_not_found / timeout /
  unknown），纯函数可单测；llm-anthropic / llm-openai 的 HTTP 语义各自映射。
- host 侧 `failure-translator.ts`：kind → 大白话（zh/en 随 GOTONG_DEFAULT_LANG）
  + 修复指路（设置页锚点 / `setting` 控制台句式）。host 域病（IM token 失效 /
  端口占用 / 磁盘）由 admin-health 既有判定供事实，translator 只管文案。
- **unknown 必须落诚实兜底**（「我不认识这个错，原文如下」）——不装懂。
- 验收：表驱动单测全 kind 覆盖 + unknown 兜底断言 + 双语快照。

### CARE-M2 断供不失联

- seam：im-bridge 自由文本派发的错误路径。provider 错 → **canned 回复**
  （零 LLM）：翻译表文案 + 「命令面仍可用（/status /help …）」+ 修复指路。
- 边沿播报：断供首次 → 播一次「管家大脑不可用：<kind>」；恢复 → 播一次恢复。
  状态文件 `runtime/llm-outage.json`（kind + since + 已播标记），损坏当空。
- 验收：mock provider 定向 401 / timeout → IM 自由文本得 canned 回复不崩、
  含翻译文案断言；连续两条消息只播一次（dedup）；恢复后恢复播报恰一次；
  IM 命令面全程照常；mock LLM 调用计数 = 0（零 LLM 断言）。

### CARE-M3 主动巡检（管家的值班表）

- `personal-butler-sweeps.ts` 加 patrol sweep：默认 10 分钟（注入时钟可测，
  本轮不加旋钮）跑 admin-health 纯判定 → 与 `butler/patrol-state.json` diff →
  **新出现的黄 / 红牌**边沿播报：事实一句 + 「回『为什么』我展开」。
- 懒加载：播报零 LLM；用户追问才进管家正常 LLM 回合（管家眼睛 BE-M1/M2 已
  能读体检与诊断，无新工具）。
- **前置腾挪**：main.ts 只剩 3 行——接线前先抽一块（候选：巡检装配并入
  personal-butler-sweeps 现有 arm 函数，main.ts 净增 0 行）。
- 验收：注入时钟 E2E——制造黄牌（拔 IM token 配置）→ 恰一次播报；不修→
  下轮不重播；修复→恢复播报一次；全程 mock LLM 计数 = 0；只有开了运行播报的
  成员收到（同意面断言）。

### CARE-M4 开箱陪跑（capstone）

- 触发：自由聊天入口处**零 LLM 判定**——admin-health 有关键缺口（无 LLM key /
  无 IM / 零模板）且 `butler/onboarding-state.json` 未完成 → 把「现状卡」
  （体检子集序列化）注入管家上下文 + 陪跑剧本指令；否则一字不注入。
- 剧本：逐关引导（IM → key → 装首个模板/晨报），key / token 写入走 steward
  既有审批写路径（服务端权威不变）；粘完**活体校验** = provider models-list
  只读诊断（RES 只读探测姿态，不生成、不烧 token），失败用 CARE-M1 翻译表
  回话。
- 完成态：缺口清零或用户说「不用了」→ 写 onboarding-state，从此不再注入。
- 验收：E2E——空配置 hub 首聊，mock LLM 收到的 prompt 含现状卡字段断言
  （零 LLM 判卷姿态：断言注入内容而非模型输出）；补齐配置后再聊无注入；
  「不用了」持久化断言；models-list 校验失败 → 翻译文案出现。

---

## 五、顺序 / 依赖 / 粗估

```
PUB-M1 ─→ PUB-M2 ──────────────→ PUB-M3(用户 npm/PyPI 账号就绪后)
                                      └→ KIT-M3 的 npm 路径补测
CARE-M1 ─→ CARE-M2 ─→ CARE-M3 ─→ CARE-M4
KIT-M1 ─→ KIT-M2 ─→ KIT-M3(git 路径不等 PUB)
FDE-M3 独立（复用 LIFE 归一化 + M1a/M2 链路模式）
```

建议节奏（每步一 commit，用户可随时改序）：
**PUB-M1 → PUB-M2**（同时用户去注册 npm org / PyPI，防抢注）→ **CARE-M1 →
CARE-M2** → **KIT-M1 → KIT-M2** → **CARE-M3 → CARE-M4** → **FDE-M3** →
**KIT-M3 + PUB-M3 收尾**。

粗估：PUB 2~2.5 天（M3 另需用户在场）；KIT 3~3.5 天；FDE-M3 1.5~2 天；
CARE 4 天。合计 **10~12 个工作日**（跨多会话，逐里程碑推进）。

## 六、验收门总表（track → 门 → 命令）

| Track | 会红的门 | 命令 |
|---|---|---|
| PUB | 发布就绪闭包门（无 private / 字段齐 / pack 无 workspace: 泄漏） | `pnpm check:publish`（新） |
| PUB | verdaccio 彩排 npx 冒烟（TTFR 姿态） | `pnpm check:npx-smoke`（新） |
| PUB | python-sdk 打包体检 | `python -m build` + `twine check` |
| KIT | 备份/恢复/迁移/更新 vitest 回归（密钥排除、hash、ff-only、回滚） | `pnpm -C packages/cli test` |
| KIT | migrate fixture 全环（apply 后 host 零 definition 错） | host E2E 套件 |
| FDE-M3 | schedules 三拒解析测试 + provision 空 hub E2E | web/host 测试套件 |
| CARE | 全链零 LLM 断言（mock 计数 = 0）+ 边沿 dedup + 注入时钟 E2E | host 测试套件 |
| 全局 | 四门 + 行数棘轮（CARE 接线前腾挪） | `pnpm check:guards` |

## 七、显式不做（本轮边界，防散焦）

- Web Push（PWA VAPID）与**邮件适配器**——上轮讨论提过但用户未圈定，留下轮；
- 云市场镜像 / WhatsApp 适配器 / 巡检静音时段（quiet hours）与巡检独立旋钮；
- 方案包**不是包管理器**：无版本依赖解析、无自动升级（三块共守的非目标不变）；
- npm / PyPI 的**真上传动作**永远由用户执行或在场授权（出站发布纪律）；
- `gotong update` 永不代跑 systemd 重启，只打印命令。
