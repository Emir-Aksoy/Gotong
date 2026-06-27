# 统一确定性「setting」运维控制台 — 一个命名空间, 三个入口, 零大模型

> 用户原话:「串到一起, 用一个 setting 再下面的命令全串一起可行吗? 从服务器内冷启动到
> 后续崩溃救援到新读取工作流/agent 检测。如果还有其他的设置方面的管理也一起。它既可以
> 支持命令行操作, 也可以在服务器本地网页操作, 还可以在 im 通道(使用一个指令进入命令行
> 模式)操作, 这些不依赖大模型。」
>
> Last updated: 2026-06-26 · setting-ops M1–M7

---

## 一、它是什么 / 不是什么

确定性运维能力**早就全有, 但散成互不相干的入口**: `aipehub doctor`(启动前体检) /
`aipehub check`(定义语法校验) / boot 横幅(坏定义跳过提示)——没有一条线把
「冷启动 → 崩溃救援 → 新读取定义检测 → 其他配置管理」串起来, 也没有统一的网页/IM 入口。

`setting` 控制台把这些**聚合**进一个命名空间, 经**一个确定性 ops-core**(`@aipehub/host` 的
`packages/host/src/ops-core.ts`, 零 LLM)铺到**三个入口**: CLI / 服务器本地网页 / IM 命令模式。

- **是**: 单一真相(ops-core)+ 三个薄适配器。跟已 ship 两次的同一套路 ——
  VALID 定义校验(`@aipehub/host/check`)/ 管家(`HubStewardSurface` 三 transport)。
- **不是**: 通用运行时热重载子系统。host 仍只读 `process.env` + `pricing.json`, 配置写只
  写「下次启动会读的文件」, **全程诚实标注「重启后生效」**, 不发明热重载。

**爆炸半径**: ops-core + CLI/web/IM 三个薄适配器 + launcher source 一行。
`core/protocol/identity/runner` 运行时源码**零改** —— 唯一一处 identity 触碰是加了**一个**
审计动作常量 `setting_config_write`(零 schema/零迁移)。生产 `handleImMessage` 现有分支
**逐字节不变**(只前置加了一个 `/setting` 分支)。

---

## 二、tier 模型(整个设计的脊柱)

ops-core 每条命令带一个 `OpsTier`; tier **就是**跨 surface 的边界闸。
`OpsSurface = 'cli' | 'web' | 'im'`; `OpsCaller = { surface, allowConfigWrite }`。

| tier | 含义 | CLI | 网页(admin) | IM 命令模式(operator) |
|---|---|---|---|---|
| `read` | 状态快照 / 定义校验 / 配置体检 / 恢复清单 / 列资源 | ✓ | ✓ | ✓ |
| `safe-mutate` | 唯一一条: 建缺失目录(`fix-dirs`, 可逆幂等) | ✓ | ✓ | ✓ |
| `config-write` | **owner-gated + 审计** 确定性配置写(见 §四) | ✓ | ✓(owner) | ✗ 列出+提示「owner 在网页/CLI 改」 |
| `destructive-offline` | 冷启动 / restore / rotate-master-key | ✓(确认后) | ✗ 列出+提示去 CLI | ✗ 列出+提示去 CLI |

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

---

## 三、命令目录

| id | tier | 干什么 |
|---|---|---|
| `status` | read | hub 此刻在哪 —— 定义计数 + 配置体检结论 +(hub 在跑时)实时健康 |
| `check` | read | 确定性 配置 + 工作流 + agent 校验(同 `aipehub check` / boot 那批) |
| `list` | read | 每条 setting 命令 + 它的 tier + 能在哪跑 |
| `inventory` | read | 备份目录里的恢复候选(只读列, 最新在前) |
| `config` | read | 托管 env 旋钮 + 密钥 env 变量(只显示 已设/未设)+ pricing 覆盖状态 |
| `fix-dirs` | safe-mutate | 确保工作区目录存在(`mkdir -p`; 幂等可逆) |
| `config-set` | config-write | 在 `<space>/aipehub.env` 写一个白名单非密钥 env 旋钮(重启生效) |
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
(`process.env.AIPE_*`, 启动时读, host **不**自己读 `.env`)② `<AIPE_SPACE>/pricing.json`
(host 真读的唯一配置文件)③ `org_mode`(identity 持久, 已有升级流)。据此 config-write
**严格限定**为(owner-gated + 校验 + 审计, CLI + web, **不**上 IM):

### 5.1 托管 env 文件 `<AIPE_SPACE>/aipehub.env`(`config-set`)

给**非密钥**确定性 env 旋钮的**白名单**写器。每写**写前**确定性校验, 落盘, 审计。

| 旋钮 | 校验 | 默认 |
|---|---|---|
| `AIPE_MODE` | 必须 `personal` 或 `team` | `personal`(未设→自动检测) |
| `AIPE_WEB_PORT` | 整数 1–65535 | `3000` |
| `AIPE_WS_PORT` | 整数 1–65535 | `4000` |
| `AIPE_OPEN_BROWSER` | 闭集 `0/1/true/false/on/off/yes/no/auto` | `auto` |

**密钥硬排除**: `isSecretKey()` 拒任何 `*_TOKEN` / `*_SECRET` / `*_KEY` / `*_PASSWORD` 结尾,
或含 `MASTER_KEY` / `PASSWORD` 的键 —— 返回 `secret_key_refused`, **不写不审计成功**。
镜像管家「只存环境变量名永不携明文」纪律。凭证仍走既有 vault / setup-owner-llm-key /
rotate-master-key 专用流, **绝不**进这个编辑器。

### 5.2 pricing.json 编辑器(`config-price`)

host 真读的那一个配置文件。写前确定性校验形状(畸形→拒, 不留到 boot 才炸), 审计。

### 5.3 effective-config 只读视图(`config`)

不在白名单的 env(令牌/区间等)只**读**: 一组 `SECRET_ENV_VARS`(`AIPE_MASTER_KEY` /
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

### 6.1 CLI —— `aipehub setting`

```
aipehub setting <subcmd>          一发即走 —— 跑一条 ops 命令然后退出
aipehub setting                   裸命令 → 进交互式子 shell(复用 ReplIo + SIGINT→AbortController)
```

- read: `setting status|check|config|list|inventory`
- safe-mutate: `setting fix-dirs`
- destructive-offline(**CLI-only, 确认后才跑**):
  - `setting cold-start [--force]` —— 预检(doctor)→ 校验定义(check)→ 干净 / `--force` 则启动。
    **故意无 y/N 提示**: 体检结论 IS the gate。
  - `setting restore <file> <target> [--force] [--yes]` —— `execFile bash restore.sh`。
  - `setting rotate-master-key` —— 委托 host 自己的 `rotate-master-key` 子命令。

CLI 走**变量动态 import** `@aipehub/host/ops`(逐字镜像 `check.ts` host-absent 分支),
保持 cli 零 host 构建期依赖; host 不在场→印安装提示返非零。

### 6.2 服务器本地网页 —— admin「运维 / 设置」tab

```
GET  /api/admin/setting/commands   全 tier 目录, 按 caller 标 runnableHere
POST /api/admin/setting/run        跑一条 read / safe-mutate / config-write(owner)
```

`serveWeb(hub, { settingOps })` 注入鸭子 surface `SettingOpsSurface`(web 零 host 运行时依赖,
端到端先例 = adminHealth)。每 handler `await ctx.requireAdmin`(未认证→401); `!ctx.settingOps`→503
让 tab 隐藏。**无破坏性路由**(根本不存在; 即便伪造也 404)。错误码: 两个 `OpsTierError`→403,
`unknown_command`→404。SPA tab 渲染 read 快照 + 安全建目录钮 +(owner)config 编辑表单 +
**列出**破坏性 / IM 命令配「去 CLI 跑」说明(无破坏性控件)。

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

## 七、运维须知 —— launcher / systemd source `aipehub.env`

config-write 写的是 host 下次启动会读的文件。要让它**生效**, host 启动前得有人 source 它。
**host 自己仍只读 `process.env`**(boot 读路径逐字节不变)—— 这层 source 跟 systemd 的
`EnvironmentFile=` 是同一回事。

### 7.1 便携 launcher(已接线)

`deploy/AipeHub.command`(macOS 双击)+ `deploy/AipeHub.sh`(Linux/通用)在算出 `AIPE_SPACE`
后、`exec` host 前, source `<space>/aipehub.env`:

```bash
source_managed_env() {
  local space="$1"
  local envfile="$space/aipehub.env"
  [ -f "$envfile" ] || return 0     # 文件不存在 = no-op(零行为变化)
  set -a; . "$envfile"; set +a
}
```

四条 fall-through 分支(tier-0 便携包 / 源码 checkout / 装好的 CLI / npx)各 source 一次。
没碰过控制台的人这文件不存在, **零行为变化**。

### 7.2 systemd(云端)

`/etc/systemd/system/aipehub.service` 的 `[Service]` 段加一行, 让 host 启动前 source 它:

```ini
[Service]
EnvironmentFile=-/var/lib/aipehub/.aipehub/aipehub.env   # 路径 = <AIPE_SPACE>/aipehub.env; 前缀 - = 文件缺失不报错
ExecStart=/usr/bin/node /opt/aipehub/dist/main.js
```

> ⚠️ **密钥不进这个文件**。`config-set` 白名单按构造拒一切密钥键 —— `aipehub.env` 只装
> `AIPE_MODE` / `AIPE_WEB_PORT` / `AIPE_WS_PORT` / `AIPE_OPEN_BROWSER` 这类非密钥旋钮。
> `AIPE_MASTER_KEY` 和各 provider/IM token 仍走 systemd secret(`systemd-creds` /
> `Environment=` 注入)/ vault, **别**写进 `aipehub.env` 明文、**别**提交 git。详见
> [`GO-LIVE.md`](GO-LIVE.md) §C 与 [`DEPLOY.md`](DEPLOY.md) §C.4。

---

## 八、显式推迟

1. 破坏性 / config-write 在 IM 上**执行**(物理 + 安全双拒, 永不上 IM)。
2. 通用运行时**热重载**配置子系统(host 仍只读 env + pricing.json, 本轮只做「写下次启动会读的文件」)。
3. `org_mode` 切换经 setting(沿用既有「升级到团队」流, 不重造)。
4. IM 命令模式升格独立 `@aipehub/im-ops-router` 包(D2 选生产加性, 第二个 caller 再升)。
5. 凭证 / 安全配置写经 setting(永远走既有 vault / rotate-master-key 专用流, 白名单硬拒)。

---

## 九、里程碑 / 测试矩阵

| M | 做了什么 | 验收门 |
|---|---|---|
| M1 | ops-core 模块 + `@aipehub/host/ops` 子路径(承重) | `ops-core.test.ts` —— tier chokepoint + read 透传 + `fixMissingDirs` 注入式纯测 |
| M2 | CLI `aipehub setting` + 子 shell + 破坏性 CLI-only | `setting.test.ts` —— dispatch 路由 / host-absent 提示 / 脚本化 ReplIo / 破坏性要确认拒则零跑 |
| M3 | config-write core(owner-gated + 审计 + 校验) | `ops-config-write.test.ts` —— 合法落盘+审计 / 畸形+密钥键拒 / pricing 写前拒 / 视图脱敏 |
| M4 | Web `SettingOpsSurface` + `/api/admin/setting/*` + admin tab | `setting-route.test.ts` —— 401/503/200 + **断言无破坏性路由** |
| M5 | IM 加性 `/setting` 命令模式(owner/operator 闸) | `setting-im-e2e.test.ts` —— hermetic FakeBridge, 进/拒/exit/help 字节不变 |
| M6 | 物理边界 + config-write E2E(承重 #2) | `setting-ops-boundary-e2e.test.ts` —— 真 restore 只经 CLI + 三面 read 一致 + config-write 三面边界 |
| M7 | launcher source env + 收口文档 + 登记 + 回归 | launcher dry-run smoke(`AIPE_LAUNCH_DRY_RUN=1`)+ `pnpm -r build` + host/web/cli vitest 全绿 |

---

## 十、一句话

**确定性运维全生命周期(冷启动→崩溃救援→定义校验→配置管理)聚合进一个 `setting` 命名空间, 经一个
零 LLM 的 ops-core 铺到 CLI / 网页 / IM 三个入口; tier 模型把「破坏性操作只能在 hub 宕掉的地方
(CLI)跑」做成代码层不可绕过的闸, config-write 严格 grounded 在 host 真读的文件上、owner-gated +
审计 + 密钥硬拒。**
