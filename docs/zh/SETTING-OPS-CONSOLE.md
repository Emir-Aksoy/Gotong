# 统一确定性「setting」运维控制台 — 一个命名空间, 三个入口, 零大模型

> 用户原话:「串到一起, 用一个 setting 再下面的命令全串一起可行吗? 从服务器内冷启动到
> 后续崩溃救援到新读取工作流/agent 检测。如果还有其他的设置方面的管理也一起。它既可以
> 支持命令行操作, 也可以在服务器本地网页操作, 还可以在 im 通道(使用一个指令进入命令行
> 模式)操作, 这些不依赖大模型。」
>
> Last updated: 2026-08-28 · setting-ops M1–M7 · UXCFG-M1/M2/M3

---

## 一、它是什么 / 不是什么

确定性运维能力**早就全有, 但散成互不相干的入口**: `gotong doctor`(启动前体检) /
`gotong check`(定义语法校验) / boot 横幅(坏定义跳过提示)——没有一条线把
「冷启动 → 崩溃救援 → 新读取定义检测 → 其他配置管理」串起来, 也没有统一的网页/IM 入口。

`setting` 控制台把这些**聚合**进一个命名空间, 经**一个确定性 ops-core**(`@gotong/host` 的
`packages/host/src/ops-core.ts`, 零 LLM)铺到**三个入口**: CLI / 服务器本地网页 / IM 命令模式。

- **是**: 单一真相(ops-core)+ 三个薄适配器。跟已 ship 两次的同一套路 ——
  VALID 定义校验(`@gotong/host/check`)/ 管家(`HubStewardSurface` 三 transport)。
- **不是**: 通用运行时热重载子系统。host 仍只读 `process.env` + `pricing.json`, 配置写只
  写「下次启动会读的文件」, **全程诚实标注「重启后生效」**, 不发明热重载。

**爆炸半径**: ops-core + CLI/web/IM 三个薄适配器 + launcher source 一行。
`core/protocol/identity/runner` 运行时源码**零改** —— 唯一一处 identity 触碰是加了**一个**
审计动作常量 `setting_config_write`(零 schema/零迁移)。生产 `handleImMessage` 现有分支
**逐字节不变**(只前置加了一个 `/setting` 分支)。

---

## 二、tier 模型(整个设计的脊柱)

ops-core 每条命令带一个 `OpsTier`; tier **就是**跨 surface 的边界闸。
`OpsSurface = 'cli' | 'web' | 'im' | 'butler'`; `OpsCaller = { surface, allowConfigWrite }`。
(第四个值 `butler` 是 HANDS-M3c 加的,见本节末。)

| tier | 含义 | CLI | 网页(admin) | IM `/setting` 命令模式 | 阿同(手机对话) |
|---|---|---|---|---|---|
| `read` | 状态快照 / 定义校验 / 配置体检 / 恢复清单 / 列资源 | ✓ | ✓ | ✓ | ✓(经工具) |
| `safe-mutate` | 唯一一条: 建缺失目录(`fix-dirs`, 可逆幂等) | ✓ | ✓ | ✓ | — |
| `config-write` | **owner-gated + 审计** 确定性配置写(见 §四) | ✓ | ✓(owner) | ✗ 列出+提示「跟阿同说,或 owner 去网页/CLI 改」 | ✓ **两步**: 阿同 park → `/approve <短码>` |
| `destructive-offline` | 冷启动 / restore / rotate-master-key | ✓(确认后) | ✗ 列出+提示去 CLI | ✗ 列出+提示去 CLI | ✗ 同左 |

`listOpsCommands(caller)` **列出全部 tier**(含 destructive / config-write 当**描述**:
tier + 标题 + summary + `whereToRun`「去哪跑」),让三个 surface 都能**展示**完整生命周期;
每条带 `runnableHere` 旗标说这个 surface 能不能真跑。

`runOpsCommand(id, args, caller, deps)` 是**唯一在线 chokepoint**:

```
destructive-offline  → 永远抛 OpsTierError('destructive_offline_cli_only')
config-write         → caller.allowConfigWrite 为假则抛 OpsTierError('config_write_not_permitted')
read / safe-mutate    → 跑
```

CLI/web/IM 全部漏斗到这一个 `runOpsCommand`。所以 web/IM **逻辑上**够不着破坏性操作。

### 2.1 HANDS-M3c 改口 —— config-write 上了手机, 但**不是**经这个命令台

本文原文写的是「config-write **不**上 IM」「破坏性 / config-write 在 IM 上执行(物理 + 安全双拒,
**永不**上 IM)」。前半句现在要改口, 后半句一个字不改, 因为它们说的是两件事:

- **不变的**: `/setting` 这个**确定性命令台**在 IM 上仍然只能跑 `read` / `safe-mutate`, 遇到
  config-write 仍然当场拒。理由不是「怕」, 是**结构性的**: 待批项的 `itemId` **就是**那个被挂起
  的 Task 的 id, 而这条零 LLM 的命令行**根本没有一个 task 可挂**。要让它 park, 就得再造一个
  与 `HostInboxService.resolve` 平行的第二套裁决权威 —— 一道闸有两个执法点, 迟早各说各话。
- **新增的**: 手机上改设置走的是**另一条既有的路** —— 阿同的 governed 动作面。你对阿同说
  「把网页端口改成 8080」, 它调 `set_hub_config`(tier 2「每次 park」, 零 blanket grant), 动作进
  `/inbox`, 你回 `/approve <短码>` 才落盘。**一句话**: 命令台仍是一步式的, 手机多的是一条两步式
  的路; 参与裁决的仍然只有 `HostInboxService.resolve` 一个执法点。

那条路本身没有绕开任何闸: 它写的是**同一个** `runOpsCommand('config-set', …)`(同一份白名单、
同一套校验、同一条 `setting_config_write` 审计动作), 只是 caller 的 `surface` 是第四个值
`butler`。为什么不复用 `'im'`: **同一个 park 项既可能在手机上批, 也可能在网页 `/me` 上批** ——
写死任何一个渠道名, 都有一半的时候在撒谎; 渠道由收件箱 resolve 自己的审计行记(`metadata.via`,
见 IM-APPROVAL.md)。闸也不挂在这个名字上, 挂在 `allowConfigWrite` 旗标上(单测钉死: 同样是
`surface:'butler'`, 不带旗标照样抛 `OpsTierError`)。

IM 面对 config-write 的那句拒绝文案因此也改口了 —— 从「owner 在网页/CLI 改」改成先指阿同这条
路(`IM_CONFIG_WRITE_HINT`), 因为手机上现在真的有得改。设计与四档表见
[`ATONG-HANDS.md`](ATONG-HANDS.md) §十四。

---

## 三、命令目录

| id | tier | 干什么 |
|---|---|---|
| `status` | read | hub 此刻在哪 —— 定义计数 + 配置体检结论 +(hub 在跑时)实时健康 |
| `check` | read | 确定性 配置 + 工作流 + agent 校验(同 `gotong check` / boot 那批) |
| `list` | read | 每条 setting 命令 + 它的 tier + 能在哪跑 |
| `inventory` | read | 备份目录里的恢复候选(只读列, 最新在前) |
| `config` | read | 托管 env 旋钮 + 密钥 env 变量(只显示 已设/未设)+ pricing 覆盖状态 |
| `fix-dirs` | safe-mutate | 确保工作区目录存在(`mkdir -p`; 幂等可逆) |
| `config-set` | config-write | 在 `<space>/gotong.env` 写一个白名单非密钥 env 旋钮(重启生效) |
| `config-unset` | config-write | 把一个旋钮从 `<space>/gotong.env` **删掉**, 交还给默认值(UXCFG-M3; 见 §5.1a) |
| `config-price` | config-write | 在 `<space>/pricing.json` upsert 一个模型价格(落盘前校验, 重启生效) |
| `cold-start` | destructive-offline | 预检 → 校验定义 → 启动 host。**CLI-only** |
| `restore` | destructive-offline | 把备份 tar 解进全新工作区(跑 verify.sh)。**CLI-only** |
| `rotate-master-key` | destructive-offline | 轮换 identity-vault master key。**CLI-only** |

---

## 四、为什么破坏性操作 CLI 独占 —— 物理论证(关键)

冷启动 / restore 崩溃恢复 / 换 master key 这类**破坏性·离线**操作, 发生在 hub **宕机**
或正被**替换**的时候 —— 那个本该跑它们的 web/IM 进程**自己就没起来或正被换掉**, **物理上跑不动**。

所以命名空间覆盖完整生命周期, 但**三个入口故意不对称**:

- **CLI** 是完整面。它的破坏性路径**直接**调真脚本/host 子命令(`execFile bash restore.sh` /
  host `rotate-master-key` 子命令 / 编排 doctor→check→start 当 cold-start),
  **绕过** `runOpsCommand` 这个在线 runner —— 因为 runner 本来就拒绝它们。
- **web / IM** 只做在线的「只读诊断 + 安全建目录 +(owner)配置写」, 并**列出**破坏性命令
  配「去服务器 CLI 跑」提示。

这条边界做成了**代码层不可绕过**的闸:

- web 这边**根本没有**破坏性路由。`POST /api/admin/setting/run {id:'restore'}` 唯一能到达
  host chokepoint 的下场是 `OpsTierError → 403`; 手搓一个 `POST /api/admin/setting/restore`
  会落到 `404`(setting 前缀我们 own, 不 fall-through)。
- IM 命令模式跑 `restore` / `config-set` 时, 同一个 `runOpsCommand` 抛 `OpsTierError`,
  IM 面回 `✗` + 消息里**已经写明**该去哪跑(CLI / owner 在网页)。

承重证明在 `packages/host/tests/setting-ops-boundary-e2e.test.ts`(M6): 真跑
`backup.sh → restore.sh → verify.sh "0 errors"` **只**经 CLI/shell 路径成功, 恢复后
`Space.open` + Hub + `serveWeb` 起来, `/healthz` 200, admin token 仍验 —— 证「破坏操作
真能用, 只是只在 hub 宕的地方(CLI)」。

---

## 五、config-write 的 grounded 范围(严守诚实边界)

事实核查: host **没有**通用运行时可热改的 `config.json`。配置只有三处 —— ① env-driven
(`process.env.GOTONG_*`, 启动时读, host **不**自己读 `.env`)② `<GOTONG_SPACE>/pricing.json`
(host 真读的唯一配置文件)③ `org_mode`(identity 持久, 已有升级流)。据此 config-write
**严格限定**为(owner-gated + 校验 + 审计; CLI + web, 以及 HANDS-M3c 之后经阿同两步确认的
手机路 —— 见 §2.1, 白名单/校验/审计三件与这里逐字一致):

### 5.1 托管 env 文件 `<GOTONG_SPACE>/gotong.env`(`config-set`)

给**非密钥**确定性 env 旋钮的**白名单**写器。每写**写前**确定性校验, 落盘, 审计。
**这份名单同时也是**「手机上能改什么」的名单 —— `set_hub_config` 的 `key` 枚举就是从
`ENV_KNOBS` 派生的(HANDS-M3c「一份定义四处执法」), 加一项进来, IM 那条路当天就多一项。

**收进来的判据三条(缺一不可)**:

1. **值域封闭或有界** —— 闭集 / 布尔 / 有界时长 / 有长度与字符集约束的标识符。
   这同时是 `set_hub_config` 当初能进 `IM_APPROVABLE_TOOLS` 的理由: 审批卡那一行
   **结构上就长不了**(见 §2.1)。
2. **改错了不删数据、不放松安全闸、不把人锁在外面。**
3. **改回去等于没发生过** —— 写回默认值(或对五个感官旋钮写空串)即复原。

| 旋钮 | 校验 | 默认 |
|---|---|---|
| `GOTONG_MODE` | 闭集 `personal` / `team` | `personal`(未设→自动检测) |
| `GOTONG_WEB_PORT` | 整数 1–65535 | `3000` |
| `GOTONG_WS_PORT` | 整数 1–65535 | `4000` |
| `GOTONG_OPEN_BROWSER` | 闭集 `0/1/true/false/on/off/yes/no/auto` | `auto` |
| `GOTONG_DEFAULT_LANG` | 闭集 `zh` / `en` | `zh` |
| `GOTONG_PROFILE` | 闭集 `hub` / `federation`(**呈现视角, 不改行为**) | `hub` |
| `GOTONG_BUTLER_MAINTENANCE` | 布尔 | `true` |
| `GOTONG_BUTLER_PROACTIVE` | 布尔 | `true` |
| `GOTONG_BUTLER_RUN_BROADCAST` | 布尔 | `true` |
| `GOTONG_BUTLER_MEMORY_GIT` | 布尔(级联在维护之下) | `false` |
| `GOTONG_BUTLER_MEMORY_LIBRARIAN` | 布尔(级联在维护之下) | `false` |
| `GOTONG_BUTLER_MEMORY_RECONCILE` | 布尔(级联在维护之下) | `false` |
| `GOTONG_BUTLER_MEMORY_LINKS` | 布尔(**刻意不级联** —— 召回扩一跳不需要扫描先跑过) | `false` |
| `GOTONG_BUTLER_MAINTENANCE_MS` | 时长 1m–24h | `6h` |
| `GOTONG_BUTLER_PROACTIVE_MS` | 时长 5m–1h | `15m` |
| `GOTONG_BUTLER_RUN_BROADCAST_MS` | 时长 1m–1h | `1m` |
| `GOTONG_BUTLER_VOICE_MODEL` | 标识符 ≤96 码点、无控制字符 | 空(=不开口) |
| `GOTONG_BUTLER_VOICE_VOICE` | 同上(**只接厂商官方系统音色**) | 空 |
| `GOTONG_BUTLER_ASR_MODEL` | 同上 | 空(=不开耳) |
| `GOTONG_BUTLER_VISION_MODEL` | 同上 | 空(=不开眼) |
| `GOTONG_BUTLER_EMBEDDER_MODEL` | 同上 | 空(=不开语义召回) |
| `GOTONG_UPDATE_CHECK` | 布尔 | `false` |
| `GOTONG_A2A_SIGN_CARD` | 布尔 | `false` |

三条与直觉相反、但承重的细节:

- **布尔一律归一成 `'true'` / `'false'` 两个字面量**。读侧有**四个互不兼容**的布尔解析器
  (`onUnlessDisabled` 认 opt-out、`onlyIfEnabled` 认 opt-in、`envBool` **不认 `on`**、
  版本探针自带一份), 只有 `'true'`/`'false'` 这一对四个都读对。收下 `on` 却写进
  `envBool` 管的旋钮, 就是界面说开了、进程没开。
- **五个感官旋钮的空串 = 显式清除**, 不是错误。它们的读侧全是 `(env.X ?? '').trim()`
  再判真值, 所以 `X=` 与「从没设过」逐字节同义 —— 少了这一条, 人能在网页上把音色打开却
  再也关不掉, 判据 3 当场失效。
- **标识符禁控制字符是安全要求不是洁癖**: 值里夹一个换行, `serializeEnvFile` 会把它
  写成第二行 `KEY=`, 下次 `parseEnvFile` 就读出一个没人写过的旋钮。故意**不**限 ASCII
  —— 音色 id 本来就是中文(`茉莉`)。

**刻意留在名单外的(每条都有具体原因, 不是"以后再说")**:

| 拒收 | 因为 |
|---|---|
| `GOTONG_BUTLER` | **把人锁在外面**: 关掉管家就等于关掉手机上唯一能把它开回来的路(`/setting` 在 IM 上恒 `allowConfigWrite:false`) |
| `GOTONG_BUTLER_GOVERNED` | 那是审批闸**本身**。让一个要过审批的动作去关掉审批, 是把门的钥匙挂在门上 |
| `GOTONG_HOST` | `auditBootSecurity` 对它有两条 `fatal` ⇒ 改错直接**拒启**。闭集救不了它: `0.0.0.0` 本身就是那把锁, 不是打错的字。它属于将来一个带引导的「开放到公网」复合动作 |
| `GOTONG_SPACE_NAME` | `openOrInit` 对**已存在**的空间忽略 `opts.name` ⇒ 写了不生效, 界面会替旋钮撒谎 |
| `GOTONG_LOG_LEVEL` / `_FORMAT` | 让它们生效的那个模块级求值顺序**只差一行就会失效**, 从设置页改会长期悄悄没反应 |
| 各 `*_KEEP_DAYS` / `_ARCHIVE_DAYS` / `RUN_KEEP` | **删历史**, 违反判据 2 |
| `GOTONG_GATING` / `_TRUST_PROXY` / `_COOKIE_SECURE` / `_ALLOW_INSECURE` / `_ALLOWED_HOSTS` / `_PROTOCOL_STRICT` | 放松安全闸, 违反判据 2 |
| `GOTONG_SPACE` / `_BACKUP_DIR` / `_WORKFLOWS_DIR` | 路径 = 无界自由文本, 违反判据 1 |
| 一切凭证 | 已被 `isSecretKey()` 兜住(见下), 且各有专用流 |
| 各 IM 桥 | 它们**根本没有开关旋钮** —— host 按「凭证在不在」决定起不起桥, 关桥的正路是 `/setkey` 那条线 |

**密钥硬排除**: `isSecretKey()` 拒任何 `*_TOKEN` / `*_SECRET` / `*_KEY` / `*_PASSWORD` 结尾,
或含 `MASTER_KEY` / `PASSWORD` 的键 —— 返回 `secret_key_refused`, **不写不审计成功**。
镜像管家「只存环境变量名永不携明文」纪律。凭证仍走既有 vault / setup-owner-llm-key /
rotate-master-key 专用流, **绝不**进这个编辑器。

### 5.1a 「恢复默认」是一个动作, 不是一个值(`config-unset`, UXCFG-M3)

判据 3 说「改回去等于没发生过」。**写默认值做不到这件事**: 盘上会留下一行钉子,
而那一行钉的是**今天这个版本的默认值** —— 哪天默认改了(它们本来就该能改), 这台
hub 会带着一个谁也没决定过的旧值继续跑, 而设置页会理直气壮地显示「你设的」。

所以「恢复默认」走一条**自己的动词** `config-unset <KEY>`: 把那一行从文件里删掉,
让这个旋钮重新落回代码里的默认。三条细节:

- **`''` 不能当"未设"的哨兵** —— 它对五个感官旋钮已经是「显式清除」的合法值
  (§5.1 第二条)。同一个字符串没法同时表示两件事, 所以必须是另一个动词。
- **键本来就不在文件里 = 零字节写入**, 也不留审计"成功写入"。什么都没发生就是
  什么都没发生, 不假装做过一次。
- **白名单与密钥硬拒照旧** —— 删也只能删 `ENV_KNOBS` 里的键, 走同一个 `isSecretKey()`。

### 5.2 pricing.json 编辑器(`config-price`)

host 真读的那一个配置文件。写前确定性校验形状(畸形→拒, 不留到 boot 才炸), 审计。

### 5.3 effective-config 只读视图(`config`)

不在白名单的 env(令牌/区间等)只**读**: 一组 `SECRET_ENV_VARS`(`GOTONG_MASTER_KEY` /
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / 各 IM 桥 token…)只显示
**已设 / 未设**, 绝不回显明文。配 `generateEnvTemplate()` 生成一份校验过的 env 模板供
operator 手动应用(不静默改 live systemd)。

### 5.4 审计

走既有 `audit_log` + `AUDIT_ACTIONS`, **加一个** `setting_config_write` 动作(identity
`types.ts`)——这是**唯一**一处 identity 触碰, 且是**加性常量**(零 schema / 零迁移),
与前例 `workflow_*`(P2-M2)/ `TEMPLATE_EXPORT`(B-M3)加审计动作**同构**。actor 上下文
由 surface 绑(CLI = system, web owner = 其 session), ops-core 只供 per-write metadata;
sink 缺席→写仍发生, 不审计(全离线 CLI 无 identity store 的情形)。

---

## 六、三个入口

### 6.1 CLI —— `gotong setting`

```
gotong setting <subcmd>          一发即走 —— 跑一条 ops 命令然后退出
gotong setting                   裸命令 → 进交互式子 shell(复用 ReplIo + SIGINT→AbortController)
```

- read: `setting status|check|config|list|inventory`
- safe-mutate: `setting fix-dirs`
- destructive-offline(**CLI-only, 确认后才跑**):
  - `setting cold-start [--force]` —— 预检(doctor)→ 校验定义(check)→ 干净 / `--force` 则启动。
    **故意无 y/N 提示**: 体检结论 IS the gate。
  - `setting restore <file> <target> [--force] [--yes]` —— `execFile bash restore.sh`。
  - `setting rotate-master-key` —— 委托 host 自己的 `rotate-master-key` 子命令。

CLI 走**变量动态 import** `@gotong/host/ops`(逐字镜像 `check.ts` host-absent 分支),
保持 cli 零 host 构建期依赖; host 不在场→印安装提示返非零。

### 6.2 服务器本地网页 —— admin「运维 / 设置」tab

```
GET  /api/admin/setting/commands   全 tier 目录, 按 caller 标 runnableHere
POST /api/admin/setting/run        跑一条 read / safe-mutate / config-write(owner)
```

`serveWeb(hub, { settingOps })` 注入鸭子 surface `SettingOpsSurface`(web 零 host 运行时依赖,
端到端先例 = adminHealth)。每 handler `await ctx.requireAdmin`(未认证→401); `!ctx.settingOps`→503
让 tab 隐藏。**无破坏性路由**(根本不存在; 即便伪造也 404)。错误码: 两个 `OpsTierError`→403,
`unknown_command`→404。

#### UXCFG-M3 —— 这一页重写过(2026-08-28)

改之前它是一个**命令控制台的网页版**: 一个命令下拉 + 一个自由文本参数框, 你得先知道
`config-set` 这个动词、再知道旋钮叫 `GOTONG_BUTLER_MEMORY_LIBRARIAN`、再知道它收什么值。
那是给写过这套东西的人用的。现在它是**一页有名字的设置**:

- **23 个旋钮各自一行**, 按人关心的事分九组(访问与界面 / 阿同在后台做什么 / 多久做一次 /
  阿同的感官 / 对外 / 凭证 / 模型价格 / 维护动作 / 危险区)。控件形状**跟着校验器走** ——
  闭集出下拉、布尔出开关、时长与标识符出输入框, 于是「打错值」这件事在多数行上根本
  发生不了。每行配一句人话说明, 键名 `GOTONG_*` 缩成一枚小 code 标签留在旁边(照着改
  systemd 或写文档的人仍然找得到它, 但它不再是这一行的主语)。
- **每行如实标出这个值是谁定的**: 默认 / 你设的 / 被环境覆盖。被环境覆盖的行**控件禁用**
  并附一句「这个值只存在于启动环境里, 在这里写会被它盖住, 所以先去那边改」 —— 这正是
  §七不变量 2 在界面上的样子。让人在一个注定不生效的框里打字, 是设置页最坏的一种谎。
  - 这里有一处**必须**做的减法: UXCFG-M1 之后 host 自己会把 `gotong.env` 注进
    `process.env`, 于是**这台 hub 自己写的文件会以"外部环境覆盖"的身份回头把控件锁上**
    —— 人改了一次, 就再也改不了第二次。判定因此要减掉 `loadManagedEnv()` 亲口说
    **它写进去的那些键**(`applied`)。这个减法是安全的: 真实环境里已经有的键会落进
    `shadowed` 而不是 `applied`, 所以它**结构上**藏不掉一条真的 `Environment=` / `export`。
- **改动先攒着, 一次保存**。底部出现「有 N 项改动还没保存 / 放弃改动 / 保存」的条; 保存
  逐条走 `config-set`(或 `config-unset`), **停在第一个失败上** —— 后面的没写, 页面接着
  显示它们仍未保存, 而不是留下一半写了一半没写、人还以为全成了。
- **「恢复默认」是一个按钮**(见 §5.1a), 按下先变成「将恢复默认 / 撤销」的**待保存**状态,
  保存了才真删。
- **危险区隔离**: 破坏性命令仍然**列在页面上**(人得知道它们存在、知道该去哪跑), 但那一
  区只有说明和一行可复制的 `gotong setting <id>`, **没有任何按钮**。
- **回执跟着语言走**: 保存/失败那句话存的是「怎么说这句话」而不是「说好的那句话」 ——
  切语言会整块重画, 一句冻在旧语言里的回执会跟旁边每一个字都换了语言的界面对不上。

样式落在**自己的** `static/setting-ui.css`(不塞进 3.6K 行的 `styles.css`), 与
`setting-ops-ui.js` **成对**走 service worker 的运行时 stale-while-revalidate 路径、
**刻意都不进 PRECACHE** —— 一进一不进就会出现 SHELL-M3 那种「一对文件各自陈旧」。

### 6.3 IM 通道 —— `/setting` 命令模式(加性接进生产 `im-bridge.ts`)

env-gate 跑着的飞书 / Telegram 桥直接多一个 `/setting` 命令, 登录即用:

- operator 发 `/setting` → 进命令模式(回 read/safe-mutate 命令清单 + 「输 exit 退出」)
- 模式中每行当 ops 子命令(`/status` ≡ `status`)→ `runOpsCommand({surface:'im',…})`
- config-write / 破坏性 → 拒, 带「owner 在网页/CLI 改」/「去服务器 CLI 跑」指引
- **非 operator** 发 `/setting` → 「命令模式仅限管理员」(D3)
- 未绑定用户 → 先让 `/bind`(绑定 IS the gate)
- `exit` 退出

**权限闸 = 仅 owner/operator**。「谁在命令模式里」per-user Map 由 host IM 编排层持有, 经
`HostImConfig.setting`(`isOperator` 谓词 + 命令模式 Map + ops 运行器)注入。生产路由只前置
加**一个** `/setting` 分支 + 读这些可选字段, 现有 `/help /bind /unbind /agents /workflow /free`
分支**逐字节不变**。

---

## 七、这个文件是怎么生效的(UXCFG-M1 起: host 自己读)

config-write 写的是 host 下次启动会读的文件。**host 在 boot 的最前面自己读它**
(`packages/host/src/managed-env.ts` 的 `loadManagedEnv`), 于是「重启生效」这句话在
**每一种起法**上都成立 —— 包括 compose 那种宿主根本够不到具名卷里那个路径的形态。

> **为什么这条修在 host 里, 而不是逐条去补启动器。** 在 UXCFG-M1 之前, 那句「下次
> 重启生效」在四条已发货的启动路径里**只有一条是真的**: 桌面启动器真的 source 它,
> 而 `deploy/gotong.service` 与 `cloud-quickstart.sh` 读的是 `/etc/gotong.env`、prod
> compose 结构上够不到。也就是说在最主流的 VPS 部署上, 人在网页上改完、重启、
> 什么都没变 —— 而界面刚刚亲口说这次会生效。**一个改不动东西的设置页比没有设置页
> 更坏**, 它把「我配好了」变成幻觉。补启动器要改三个文件, 而 compose 那条根本补不了;
> host 自己读, 一处覆盖全部形态, 也覆盖将来任何一种新的起法。

三条承重的不变量:

1. **只认白名单** —— 认的键恰好是 §5.1 那份 `ENV_KNOBS`, 也就是**写入方允许写的
   那一份**。一份定义两处执法: 能写什么, 就认什么。这是安全性质不只是整洁 —— 有人
   (或一个被注入的模型)往这个文件里写 `GOTONG_MASTER_KEY=…`, 读路径**结构上看不见
   它**。凭证搬不进来, 不是因为我们记得挡, 而是因为没有那条路。
2. **`process.env` 永远赢** —— systemd `Environment=` / compose `environment:` /
   shell export 一律压过盘上的值; 反过来会让几个月前在网页上点过的旧值, 悄悄盖掉
   运维今天写在 unit 文件里的那一行。「已设」按 `env()` 的语义判: **空串 = 未设**。
3. **值要过写入方同一个校验器** —— 人手改成非法值时**不注入**比注入更诚实(注入了
   要么让下游当场抛, 要么被静默回落成默认, 两种都是「我照你说的做了」的谎)。被拒的
   键走 warn + 启动横幅, 不静默。

读不动的时候: ENOENT = 诚实的「没有这个文件」(绝大多数部署本来就没有), 零噪音;
其它错(EACCES / EISDIR / EIO)**必须说出来** —— 读不动意味着这个人在网页上改的每一个
旋钮都不生效, 而 hub 看起来一切正常。**不拒启**: 为一个配置便利层拒启, 会让唯一能修
它的那个界面也够不着。

下面 7.1 / 7.2 那层外部 source **仍然保留且仍然有效**(两者叠加是幂等的 —— 环境里
已经有的值, host 侧按不变量 2 让位), 但它不再是「生效」的前提条件。

### 7.1 便携 launcher(已接线)

`deploy/Gotong.command`(macOS 双击)+ `deploy/Gotong.sh`(Linux/通用)在算出 `GOTONG_SPACE`
后、`exec` host 前, source `<space>/gotong.env`:

```bash
source_managed_env() {
  local space="$1"
  local envfile="$space/gotong.env"
  [ -f "$envfile" ] || return 0     # 文件不存在 = no-op(零行为变化)
  set -a; . "$envfile"; set +a
}
```

四条 fall-through 分支(tier-0 便携包 / 源码 checkout / 装好的 CLI / npx)各 source 一次。
没碰过控制台的人这文件不存在, **零行为变化**。

### 7.2 systemd(云端)

`/etc/systemd/system/gotong.service` 的 `[Service]` 段可以加一行, 让 host 启动前也
source 它(**UXCFG-M1 后不再是必需** —— host 自己会读; 这行的用处是让 `systemctl show`
一眼看得见, 以及让非 host 的同 unit 子进程也拿到):

```ini
[Service]
EnvironmentFile=-/var/lib/gotong/.gotong/gotong.env   # 路径 = <GOTONG_SPACE>/gotong.env; 前缀 - = 文件缺失不报错
ExecStart=/usr/bin/node /opt/gotong/dist/main.js
```

> ⚠️ **密钥不进这个文件**。`config-set` 白名单按构造拒一切密钥键 —— `gotong.env` 只装
> §5.1 表里那些**值域封闭或有界**的非密钥旋钮。
> `GOTONG_MASTER_KEY` 和各 provider/IM token 仍走 systemd secret(`systemd-creds` /
> `Environment=` 注入)/ vault, **别**写进 `gotong.env` 明文、**别**提交 git。详见
> [`GO-LIVE.md`](GO-LIVE.md) §C 与 [`DEPLOY.md`](DEPLOY.md) §C.4。

---

## 八、显式推迟

1. 破坏性操作在 IM 上**执行**(物理 + 安全双拒, 永不上 IM)。
   ~~config-write 同罪~~ —— **HANDS-M3c 改口**: 经 `/setting` 这个确定性命令台仍然永不上 IM
   (理由是结构性的, 见 §2.1), 但手机上改设置有了另一条路 —— 对阿同说, 它 park, 你
   `/approve <短码>`。两句话不矛盾: 命令台没有 task 可挂, 阿同有。
2. 通用运行时**热重载**配置子系统(host 仍只读 env + pricing.json, 本轮只做「写下次启动会读的文件」)。
3. `org_mode` 切换经 setting(沿用既有「升级到团队」流, 不重造)。
4. IM 命令模式升格独立 `@gotong/im-ops-router` 包(D2 选生产加性, 第二个 caller 再升)。
5. 凭证 / 安全配置写经 setting(永远走既有 vault / rotate-master-key 专用流, 白名单硬拒)。

---

## 九、里程碑 / 测试矩阵

| M | 做了什么 | 验收门 |
|---|---|---|
| M1 | ops-core 模块 + `@gotong/host/ops` 子路径(承重) | `ops-core.test.ts` —— tier chokepoint + read 透传 + `fixMissingDirs` 注入式纯测 |
| M2 | CLI `gotong setting` + 子 shell + 破坏性 CLI-only | `setting.test.ts` —— dispatch 路由 / host-absent 提示 / 脚本化 ReplIo / 破坏性要确认拒则零跑 |
| M3 | config-write core(owner-gated + 审计 + 校验) | `ops-config-write.test.ts` —— 合法落盘+审计 / 畸形+密钥键拒 / pricing 写前拒 / 视图脱敏 |
| M4 | Web `SettingOpsSurface` + `/api/admin/setting/*` + admin tab | `setting-route.test.ts` —— 401/503/200 + **断言无破坏性路由** |
| M5 | IM 加性 `/setting` 命令模式(owner/operator 闸) | `setting-im-e2e.test.ts` —— hermetic FakeBridge, 进/拒/exit/help 字节不变 |
| M6 | 物理边界 + config-write E2E(承重 #2) | `setting-ops-boundary-e2e.test.ts` —— 真 restore 只经 CLI + 三面 read 一致 + config-write 三面边界 |
| M7 | launcher source env + 收口文档 + 登记 + 回归 | launcher dry-run smoke(`GOTONG_LAUNCH_DRY_RUN=1`)+ `pnpm -r build` + host/web/cli vitest 全绿 |
| UXCFG-M1 | host boot 自己读 `<space>/gotong.env`(§七) | `managed-env.test.ts` —— 白名单 / `process.env` 赢 / 非法值不注入 / 读不动响亮 |
| UXCFG-M2 | `ENV_KNOBS` 4 → 23(手机上能改的同步变宽) | `ops-config-write.test.ts` —— 逐旋钮校验 + 布尔归一 + 拒收名单 |
| UXCFG-M3 | 设置页重写 + `config-unset` + 出处判定减去自注入 | `setting-ui-contract.test.ts`(24) + `ops-config-write.test.ts`(70) + `setting-ops-boundary-e2e.test.ts`(6) |

---

## 十、一句话

**确定性运维全生命周期(冷启动→崩溃救援→定义校验→配置管理)聚合进一个 `setting` 命名空间, 经一个
零 LLM 的 ops-core 铺到 CLI / 网页 / IM 三个入口; tier 模型把「破坏性操作只能在 hub 宕掉的地方
(CLI)跑」做成代码层不可绕过的闸, config-write 严格 grounded 在 host 真读的文件上、owner-gated +
审计 + 密钥硬拒。**
