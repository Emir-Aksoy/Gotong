# 轻量文件围栏 — 不用 Docker 把编码 agent 关进允许的文件夹

> Last updated: 2026-06-29 · commit `6649e62`（JAIL-M1 第 1 层）→ `bd50178`（JAIL-M2
> 第 2 层）→ 本提交（JAIL-M3 接线 + 真机 e2e + 文档）
>
> 仅本地开发阶段，未 push。

---

## 一句话

hub 会驱动外部命令（cli-agent 一次性 shell-out、acp-agent 长连接编码 agent、未来管家的
shell 工具）。我们要把它们关在**允许的文件夹**里，避免它们误改服务器 / 电脑上别的目录——
但**不背 Docker 的重量**。做法是**两层围栏**叠在一起：

```
   待 spawn 的命令
        │
   ┌────▼─────────────────────────────────────────┐
   │ 第 1 层  argv 路径围栏 (jailArgv)              │  纯 JS / 词法 / 100% 便携
   │  解释器? shell 元字符? 路径逃出 roots?        │  → { park } 挂起到 /me 人工批
   │  「策略闸 + UX」, 不是安全边界                  │  (证不了就问人 = fail-closed)
   └────┬─────────────────────────────────────────┘
        │ allow
   ┌────▼─────────────────────────────────────────┐
   │ 第 2 层  OS 内核围栏 (wrapWithFsJail)          │  真边界
   │  mac → sandbox-exec (Seatbelt)                │  内核把进程树的「写」
   │  linux → bwrap (bubblewrap)                   │  钉死在 roots 内
   │  none → 透传 + 调用方降级 (人工闸 + 告警)       │
   └──────────────────────────────────────────────┘
```

**第 1 层是策略 + 体验**（看得懂的命令就放行，看不懂的就请人确认）；**第 2 层才是真边界**
（内核强制）。两层职责分明，谁都不冒充对方。

> 北极星对齐：框架不跑 LLM、人是 Participant。围栏证不了安全时，**挂起任务进 `/me`
> 收件箱让人拍板**（复用 Phase 11 suspend → Phase 16 inbox），不静默裸跑。

---

## 二、为什么不用 Docker

Docker 能隔离，但对「我就想让 Codex 别动我家目录」这件事太重：要装 daemon、拉镜像、挂卷、
管网络、加几百 MB。用户的原话是「做一个执行命令前的参数检查……起到类似 docker 的作用但是轻量化
得多」。

我们把它拆成两件**各自轻量**的事：

| | 第 1 层 argv 围栏 | 第 2 层 OS 内核围栏 |
|---|---|---|
| 实现 | 纯 JS，零依赖，词法 | 调系统自带 / `apt` 装一个小工具 |
| 便携 | Mac / Linux / Windows 全同 | Mac（系统自带）/ Linux（`apt install bubblewrap`）|
| 性质 | 策略闸 + UX | **真边界**（内核强制）|
| 能不能绕 | 能（符号链接 / 自由文本 prompt）| 不能（内核管的就是 syscall）|
| 失败模式 | 证不了 → 挂起问人 | 没装 enforcer → 透传 + 调用方降级 |
| 开销 | 一次字符串检查 | 一次 `exec` 包一层，无 daemon / 镜像 |

合起来 ≈ Docker 的「关进文件夹」效果，但没有 daemon、没有镜像、没有卷管理。

---

## 三、第 1 层 — argv 路径围栏（`jailArgv`，便携、纯词法）

住在 `packages/core/src/workspace-jail.ts`。给它**结构化的 argv**（命令 + flag + 显式路径
参数），它按顺序检查（**首个失败即停**）：

| 拒绝码 | 含义 |
|---|---|
| `no_allowed_roots` | 没配 roots（whitespace-only 也算没配）→ 一律不放行 |
| `interpreter_command` | 命令是解释器 / shell（`bash` / `sh` / `python` / `node` / `sudo` / `env` …，含 `python3.11` 这种带版本号）——它能在 argv 之外再起命令，词法推理失效 |
| `shell_metacharacter` | 命令或参数里有 `;` `&` `\|` `$` 反引号 `<` `>` 换行——能串第二条命令 |
| `path_escape` | 某个路径参数 `path.resolve` 后落在 roots 之外（`/work/../etc/passwd` 这种词法逃逸也抓）|

通过 → `{ allow: true }`；否则 → `{ park: true, reason, code }`。这个 verdict 喂进**和
`dangerousCommandGate` 同一条 spawn 前的缝**，`{ park }` 就挂起任务进 `/me` 等人批。

**为什么是词法 / 纯函数**：`path.resolve` 词法地折叠 `..`，零 fs 访问就能抓逃逸，确定性、
可测、各 OS 行为一致。解析符号链接（`realpath`）会把它绑死到文件系统，且**仍不是**真边界——
那是第 2 层的事。

**它不管什么**：喂给编码 agent 的**自由文本 prompt**（`codex exec "<一段中文>"`）不是结构化
argv——拿正则扫散文里的分号会把每句带分号的话都挂起。调用方只把**结构化 argv** 交给
`jailArgv`；自由文本由第 2 层（内核）兜底，破坏性意图由 `dangerousCommandGate` 管。

```ts
import { jailArgv } from '@gotong/core'

const v = jailArgv({
  command: 'cp',
  args: ['/work/a.txt', '/work/b.txt'],
  allowedRoots: ['/work'],
  cwd: '/work',
})
// v = { allow: true }   ——  改成 ['/etc/passwd'] → { park, code: 'path_escape' }
```

---

## 四、第 2 层 — OS 内核围栏（`wrapWithFsJail`，真边界）

同一文件里的**纯 argv/profile 构造器**（永不 spawn）。把待跑的命令裹进 OS 内核沙箱，让进程树
**只能写** roots 内：

- **macOS → `sandbox-exec`（Seatbelt）**：`buildSeatbeltProfile(roots)` 生成 SBPL profile：
  `(allow default)` → `(deny file-write*)` → 按 `subpath` 重新放行 roots。读 / 网络 / exec 照常，
  只钉「写」周界（SBPL 后匹配胜出，所以重新放行盖过 blanket deny）。Apple 标了 deprecated 但仍可用。
- **Linux → `bwrap`（bubblewrap）**：`buildBwrapArgs(roots, cwd)` = `--ro-bind / /`（全盘只读）
  → 每个 root `--bind`（读写，后绑定覆盖子树）+ 新 `--dev` / `--proc` / tmpfs `/tmp` +
  `--die-with-parent`。靠**非特权 user namespace**（`apt install bubblewrap` 即得，无需 root）。
- **none → 透传**：返回 `{ jailed: false }` 原样命令，**调用方负责降级**（第 1 层 + 人工闸 + 响亮告警），
  绝不静默裸跑。

`MAC_ESSENTIAL_WRITABLE`（`/dev` `/tmp` `/var/folders` …）保证普通进程不被围死——macOS 列进
profile 的可写 subpath，Linux 用 `--dev` / `--tmpfs` / `--proc` 等价提供。

```ts
import { wrapWithFsJail } from '@gotong/core'

const w = wrapWithFsJail({
  command: 'codex', args: ['exec', '--sandbox', 'workspace-write'],
  allowedRoots: ['/work/repo'], cwd: '/work/repo', kind: 'sandbox-exec',
})
// w.command = 'sandbox-exec'；w.args = ['-p', '<profile>', 'codex', 'exec', …]
//   linux 同理 → command='bwrap'，args 前缀是 --ro-bind 等
```

### 能力探测 `detectFsJail`（唯一会 spawn 的部分）

住在 `packages/core/src/workspace-jail-detect.ts`（独立成文件，让 `workspace-jail.ts` 保持
零副作用）。它是**功能性探测**而非 `which` 查找：装了 `bwrap` 但内核禁 user namespace（加固
内核 / 某些容器）就是没用；所以它真拿 `true` 跑一遍 enforcer，退出 0 才信。结果缓存（同进程内
host 能力不变），探针 / 平台可注入供测试。

### 一调到位 `prepareFsJail`（host 接线缝）

把「探测 → 拼 spec → 没有就告警降级」三件事折进一次调用：

```ts
import { prepareFsJail } from '@gotong/core'

const jail = await prepareFsJail({ allowedRoots: ['/work/repo'] })
if (!jail.jailed) log.warn(jail.warning)   // none → 必须记日志 + 配人工闸
// jail.spec 直接喂适配器（见下）
```

---

## 五、接线（JAIL-M3）

围栏在**和 `dangerousCommandGate` / `dangerousToolGate` 同一条 spawn 前的缝**接进来。两个真正
会起子进程、且会自由读写文件的适配器各加了一个**可选** `fsJail` 选项（缺省 = 旧行为逐字节不变）：

| 适配器 | spawn 点 | 接线 |
|---|---|---|
| **cli-agent** | `cli-runner.ts` `runCliCommand` | `CliRunOptions.fsJail` → 第 2 层包裹；`CliParticipant.fsJail` 透传 |
| **acp-agent** | `acp-session.ts` `spawnChild` | `AcpSpawnOptions.fsJail` → 包**长生命周期** bridge（整个 session 的写都被关住）；`AcpParticipant.fsJail` 透传 |

host / example 侧组合（一次 `prepareFsJail` → 把 `spec` 交给 participant）：

```ts
const jail = await prepareFsJail({ allowedRoots: [repoDir] })
if (!jail.jailed) log.warn(`[fs-jail] ${jail.warning}`)   // 降级：人工闸兜底

const cli = new CliParticipant({
  id: 'codex', capabilities: ['code'],
  command: 'codex', args: ['exec', '{prompt}'], promptVia: 'arg', cwd: repoDir,
  gate: dangerousCommandGate(),        // 第 1 层 / 破坏意图（已有）
  fsJail: jail.spec,                    // 第 2 层 / 内核写周界（新）
})
```

### 管家（butler）为什么暂不接第 1 层

`GovernedActionToolset` 的动作是**结构化的**（create_agent / delete_agent / edit_workflow…），
不是自由 shell / argv，而且早已被 `classify → approve → /me 收件箱`门控。**没有 argv 可以喂给
`jailArgv`**，所以现在接第 1 层是给一个不存在的调用者写代码。等管家真加了「跑 shell 命令」工具，
`jailArgv` 就是那个工具的 gate（结构化命令 → park 到收件箱）；在那之前，管家的约束是它自己的
治理闸。

---

## 六、真机验收（不是单测能给的）

单测用注入探针 + 词法构造器，证不了「生成的 profile / argv 在**这台机器**上真的关住一个子进程」。
所以补了**真机功能测**（自动 skip 当 `detectFsJail` → none）：

- `packages/core/tests/workspace-jail-real.test.ts` — 直接用 `wrapWithFsJail` 包 `node -e <写文件>`，
  真 spawn：**root 内写成功 / HOME 里的兄弟路径写被内核拒（非零退出 + 文件没生成）**。
- `packages/cli-agent/tests/cli-runner.test.ts`（`fsJail` 段）— 同样的证明走**完整的
  `runCliCommand` 管线**（不只是 `wrapWithFsJail`），证适配器接线端到端真生效。

> **关键陷阱**：root 和「禁止目标」都放在 **HOME 下的临时目录**，不能放 `/tmp` 或
> `/var/folders`——那些在 `MAC_ESSENTIAL_WRITABLE` 里，会让「禁止」的兄弟路径反而可写，证明就废了。
> HOME 在两种 enforcer 下都是只读，唯有显式 `--bind` / `subpath` 的 root 可写。

在开发机（macOS 26.3，Apple M5）上这两个真机测**实跑通过**（Seatbelt 真把子进程关住了），不是
skip。

---

## 七、平台矩阵 + 降级

| 平台 | enforcer | 怎么来 | 状态 |
|---|---|---|---|
| macOS | `sandbox-exec`（Seatbelt）| 系统自带 | ✅ 真机验证 |
| Linux | `bwrap`（bubblewrap）| `apt install bubblewrap`（非特权 userns）| ✅ 构造器 + 探测就绪，等 Ubuntu 真机复验 |
| 其它 / Windows | 无 | — | ⚠️ `kind: 'none'` → 降级 |

**降级语义**（`kind: 'none'`）：第 2 层透传不裹，`prepareFsJail` 返 `jailed: false` + `warning`。
调用方**必须**：① 记下告警；② 配人工闸（cli 的 `gate` / acp 的 `gate` + 收件箱）。绝不当作
「已经关住了」静默裸跑——这正是「证不了就问人」的 fail-closed 立场。

---

## 八、测试矩阵

| 包 | 文件 | 测试 |
|---|---|---|
| core | `workspace-jail.test.ts`（M1）| 23 — 第 1 层 allow / park / 顺序 / `isInsideRoots` |
| core | `workspace-jail-os.test.ts`（M2）| 18 — Seatbelt / bwrap 构造器 + `detectFsJail` 注入探针 + 平台覆盖 |
| core | `workspace-jail-real.test.ts`（M3）| 2 — **真机**内核确实关住（skip-if-none）|
| cli-agent | `cli-runner.test.ts`（M3 段）| +2 — **真机**走 `runCliCommand` 全管线 |

core 395 全绿 / cli-agent 38 / acp-agent 60，零回归（`fsJail` 全程可选，缺省字节不变）。

---

## 九、显式推迟

- **Windows 内核围栏**（无对等的非特权用户态沙箱；`kind: 'none'` 降级覆盖）。
- **符号链接逃逸**：第 1 层故意词法、不碰 fs，所以 root 内一个指向外面的软链不归它管——**第 2 层
  内核才是真周界**（bwrap / Seatbelt 按真实路径判）。
- **管家 shell 工具 + 第 1 层 gate**：等真有「跑 shell」工具再接（现无调用者）。
- **fold 进 host main.ts 一等公民**：现为适配器可选项 + example/host 组合（example-first），
  等使用模式稳定再决定默认开 + admin 配置 roots。
- **per-root 细粒度（只读 vs 读写分别声明）**：现 `allowedRoots` 一律读写 + `extraWritableRoots`；
  更细的「这个 root 只读」可按需加。
