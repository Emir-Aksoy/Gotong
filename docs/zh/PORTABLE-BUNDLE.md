# 嵌入式运行时便携包 — 下载双击即跑，零 Node / 零 Docker

> 给完全没有技术背景的小白：拿到一个文件夹、双击一个文件、Gotong 就跑起来了，
> 不用装 Node、不用装 Docker、不用开终端。
>
> 给维护者 / 分发者：跑一条命令产出这个文件夹，分给任何人。
>
> Last updated: 2026-06-25

---

## 一、为什么做这个（三道墙）

把「假设用户基本没有 AI 常识、也不具备技术背景，他怎么完成开始使用本项目」
整条上手链从第一步走一遍，会发现我们之前打磨的全是**「启动之后」**——首启向导、
配置体检、运行时失败修复入口、实时进度……但小白其实**死在「启动之前」**，连
那些打磨都看不到。启动之前有三道墙：

| 墙 | 小白卡在哪 | 我们的应对 |
|---|---|---|
| **认知** | 不知道这是个什么、能干嘛 | README / OVERVIEW / 上手案例（已有） |
| **获取** | 不知道去哪下、下什么 | 便携包 = 一个文件夹，发给他就行（本文） |
| **装运行时** | 「装 Node」「装 Docker」「开终端跑命令」直接劝退 | **本文：把运行时打进包里，双击即跑** |

第三道墙最根本。前两道墙就算你写得再好，只要第一步是「先去 nodejs.org 装个
Node」或「先装 Docker Desktop」，小白就走了。**嵌入式运行时便携包**把这道墙拆掉：
运行时（Node 二进制）和已编译好的 host、依赖全部打进一个文件夹，双击 launcher
就用包内运行时跑，宿主机上**有没有 Node / Docker 都无所谓**。

---

## 二、为什么是「文件夹」不是「单文件」

直觉上「单个 .exe / 单个二进制」最干净。但我们亲手 spike 验证过，单文件这条路
**交付不了全部能力**，根因是一个原生模块：

`better-sqlite3` —— 它是整个运行时依赖树里**唯一**的原生 addon（native `.node`），
而且它**承载整个 v4 identity 层**（用户 / 凭证 / 会话 / vault / 配额 / 联邦 peer
/ 挂起任务……全是 SQLite）。任何想把它塞进单文件的方案都会在这里翻车：

| 路线 | 真单文件 | 原生 sqlite / identity | 结论 |
|---|---|---|---|
| **Node SEA**（官方单文件） | ✓ | ✗ 嵌不了 `.node`；Node 20 也没有内置 `node:sqlite` | 死路 |
| **bun `--compile`**（裸跑） | ✓ ~65MB | ✗ `better-sqlite3` 从嵌入式 FS `/$bunfs/` 里 `dlopen` 不到 → **identity 整层 + SQLite 数据存储插件静默失效** | 不可用 |
| **嵌入式运行时包（本文）** | ✗（一个文件夹） | ✓ 真 Node 标准磁盘解析，一切正常 | **唯一交付全能力** |

bun 编译版**起得来 web 服务器**，看着像成功了，但 identity 静默掉线——它去
嵌入式虚拟文件系统里找 `better_sqlite3.node` 的预编译产物，找不到，于是只 seed
`memory` / `artifact` 两个不依赖原生模块的插件（见
`packages/host/src/services/builtin-plugins.ts` 的 `BINARY_SAFE_PLUGINS`，
**故意排除** `datastore-sqlite`）。对一个把「人 / 凭证 / 数据都是磁盘文件」当
北极星的项目，丢掉 identity 不是降级，是换了个产品。

**真 Node 没有这个问题**：它从磁盘上的 `node_modules` 正常 `dlopen` 原生模块。
而 host 里那个 `isCompiledBinary()` 判定（用 `import.meta.url` 是否含 `/$bunfs/`）
在真 Node 下返 `false` → host 直接走**全能力路径**：`better-sqlite3` + 三个
service 插件 + 整个 identity 全从磁盘 `node_modules` 解析。所以嵌入式运行时包是
**唯一一条既不跟原生模块搏斗、又交付全能力**的路。

---

## 三、承重机制（这包凭什么能跑）

三块拼出来，每块都简单：

### 1. 真实 prod 依赖闭包 = `pnpm deploy --prod`

```
pnpm --filter @gotong/host deploy --prod <bundle>/app
```

这条命令产出一个**去符号链接、真实**的 prod `node_modules`：原生 addon
（含预编译 `better_sqlite3.node`）+ 全部 `@gotong/*` workspace 包 + 动态按名加载
的 service 插件 + IM 桥，一个不少，零枚举、零手工 curation。对「小白绝不能撞坏包」
这是最稳的——没有打包器去猜哪些文件要带，pnpm 自己知道。

> 动态按名加载的只有 services 插件（`bootstrap.ts` 的 `hostAnchoredImport` →
> `import.meta.resolve(pkg)`）：`datastore-sqlite` / `memory-file` /
> `artifact-file`。真 Node + 磁盘 `node_modules` 全部正常解析。IM 桥是静态
> import（已是 host 直接依赖），host build 是纯 `tsc`（无打包步）——所以这条路
> 没有任何「打包器看不见的动态 import」风险。

### 2. Pinned Node 运行时 = 复制一个 `node` 二进制

把一个 Node v20 可执行文件复制进 `<bundle>/runtime/bin/node`。macOS 的官方 Node
二进制是自包含的（ICU 等都在里面），复制单个文件即可。默认复制**构建机当前的
`node`**（免下载，避开跨国 CDN 下载不稳）；也可以 `--node <path>` 指定官方
tarball 解出来的二进制。

### 3. 全能力路径 = `isCompiledBinary()` 在真 Node 下返 false

不需要改任何运行时源码。host 已经为单文件二进制写好了降级路径，真 Node 天然
走另一条——全能力那条。便携包白嫖这个既有判定。

---

## 四、怎么用

### 维护者 / 分发者：产出便携包（一条命令）

```bash
node scripts/build-portable.mjs          # 构建 + 真机启动证明（默认）
node scripts/build-portable.mjs --tar    # 额外打一个 .tar.gz 方便传输
```

产物落在 `dist-portable/Gotong-<平台>-<架构>/`（本机 macOS arm64 →
`Gotong-macos-arm64/`）。脚本末尾会**用包内 pinned node 真机启动一遍**已部署的
host，断言 `/healthz` 返回 200、identity 已 bootstrap、SQLite 数据存储插件已就绪
——跑不过就直接报错、不产出一个坏包。

把整个 `Gotong-macos-arm64/` 文件夹（或 `.tar.gz`）发给任何人即可。

### 小白：双击即跑

1. 拿到 `Gotong-macos-arm64` 文件夹（解压如果是 .tar.gz）。
2. 双击里面的 **`Gotong.command`**。
   - 首次双击 macOS 可能拦截（「未识别的开发者」）→ 右键点它 → 打开 → 打开。
     一次性信任提示，之后双击就行。我们**故意不做签名 .app**（签名重，数据路径
     完全一样）。
3. 浏览器自动打开 `http://127.0.0.1:3000` 的 5 分钟设置向导。完事。

数据存在 `~/.gotong`（**在包外**）——删掉 / 换一个新版本的包，数据不丢。

---

## 五、目录布局

```
Gotong-macos-arm64/                  ← 发给小白的就是这个文件夹
├── Gotong.command                   ← 双击它（来自 deploy/Gotong.command，含 tier-0 分支）
├── BUNDLE-INFO.txt                   ← 平台 / Node 版本 / 构建时间戳
├── runtime/bin/node                  ← pinned Node 二进制（~86MB，自包含）
└── app/                              ← pnpm deploy --prod 的输出 = host 包根
    ├── package.json
    ├── dist/main.js                  ← host 入口（launcher exec 它）
    ├── bin/gotong-host.js
    └── node_modules/                 ← 完整 prod 闭包：@gotong/*、better-sqlite3(预编译)、ws、im-*
```

体积：整包约 **220MB**（app ≈ 133MB + node ≈ 86MB）。比单文件 bun 包（~65MB）大，
但那个丢 identity；这个是全能力的代价，一次下载。（app 目录里 pnpm deploy 顺带
带了 `src/` / `scripts/`，可进一步瘦身，属优化，本轮不做。）

---

## 六、launcher 的 tier-0 分支怎么工作

便携包不另起一个 launcher——给**现有**的 `deploy/Gotong.command`（+ 双胞
`deploy/Gotong.sh`）**加性前置**一个最高优先级的「tier-0 自包含」分支：

```bash
# Tier 0 — 自包含便携包：旁边有 pinned node + 已部署 host 就直接用
if [ -x "$SCRIPT_DIR/runtime/bin/node" ] && [ -f "$SCRIPT_DIR/app/dist/main.js" ]; then
  export GOTONG_SPACE="${GOTONG_SPACE:-$HOME/.gotong}"
  launch "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/dist/main.js"
fi
```

- **在便携包里** → `SCRIPT_DIR` 旁边就有 `runtime/bin/node` 和 `app/dist/main.js`
  → 命中 → 用包内 node 跑包内 host。零系统 Node。
- **不在便携包里**（比如从源码 checkout 里双击）→ 这两个文件不存在 → 分支不命中
  → fall-through 到既有的 repo-checkout / `gotong` CLI / `npx` 逻辑，**对源码
  用户逐字节不变**。

一份 launcher 同时服务两种场景，免分叉，复用既有的健壮 `SCRIPT_DIR` 解析
（Finder 双击时工作目录是 `$HOME`，这段也能正确定位文件自身位置）、
`GOTONG_OPEN_BROWSER=always` 默认（host 监听后自己开浏览器，无竞态）、以及
`launch()` 里的 `GOTONG_LAUNCH_DRY_RUN` 可测缝。

---

## 七、平台扩展

本轮只做 **macOS arm64**（用户本机 + 桌面小白主场景）。脚本按平台参数化，扩到
其他平台是**在那个平台的机器上**跑同一条命令：

| 平台 | 怎么做 | 状态 |
|---|---|---|
| macOS arm64 | `node scripts/build-portable.mjs` | ✅ 本轮 |
| macOS x64 | 在 Intel Mac 上跑同一脚本 | 推迟 |
| Linux x64 | 在 Linux 上跑（launcher 用 `Gotong.sh`） | 推迟 |
| Windows x64 | 需 `.cmd`/`.ps1` launcher 变体 + Windows node | 推迟 |

**关键约束：原生 `better-sqlite3` 预编译产物不能跨平台。** 必须在目标平台的机器上
构建——脚本会断言构建机平台 = 目标平台，不让你误产一个跑不起来的包。

---

## 八、诚实边界

- **产物不入库 / 不挂 Release（本轮）。** 本轮交付的是**能生产便携包的脚本 + 文档**，
  不把 ~220MB 产物 commit 进 git（`dist-portable/` 已进 `.gitignore`）。真正的
  「下载页 / GitHub Release 二进制」是 1.0 之后的事（见
  `.github/RELEASE-CHECKLIST.md` 的「Pre-built binaries」项，gated on 仓库公开）。
  在那之前，「下载即用」= 维护者构建一次、把文件夹分出去。
- **运行时源码零改。** 便携包是打包 / launcher / 脚本 / 文档层。`core` / `protocol`
  / `identity` / `runner` / `web` / `host` 运行时源码一行没动——host 早就有
  `isCompiledBinary` 的全能力路径，真 Node 直接吃。
- **不做签名 `.app` / notarization。** Gatekeeper 首次右键「打开」一次即可，
  数据路径与签名版完全相同（沿 `deploy/Gotong.command` 既定立场）。
- **跨平台 / 体积优化 / 自动更新**：见上表与第五节，均显式推迟。便携包升级 =
  整包替换（数据在 `~/.gotong` 包外，不受影响）。

---

## 九、验证（承重门）

`scripts/build-portable.mjs` 默认在构建末尾跑**真机启动证明**（不是 mock）：

1. 用**包内 pinned node** 跑**已 deploy 的 host**，临时 `GOTONG_SPACE` + 随机端口 +
   `GOTONG_OPEN_BROWSER=0`。
2. 轮询 `/healthz` 断言 **200**。
3. 断言 boot log 有 `bootstrapped owner`（identity 活了）+ `datastore:sqlite`
   （动态原生插件加载了）+ **无** `bootstrap failed` / `fatal`。
4. 跑完清临时 space。

= 真机证明 deploy 出来的 `node_modules` 让 identity + 原生 sqlite + 动态插件
**全部解析成功**。这是整条路成败的复核点。

launcher 那一层另有 dry-run smoke（`GOTONG_LAUNCH_DRY_RUN=1`）覆盖四例：
`.command` / `.sh` × tier-0 命中 / 未命中——命中走包内 node，未命中 fall-through
到 repo-checkout 不变。外加一遍真机端到端：经 launcher 引导 → tier-0 → 包内 node
→ host `/healthz` 200。

---

## 相关

- 构建脚本：[`scripts/build-portable.mjs`](../../scripts/build-portable.mjs)
- 双击 launcher：[`deploy/Gotong.command`](../../deploy/Gotong.command) ·
  [`deploy/Gotong.sh`](../../deploy/Gotong.sh)
- 单文件二进制（降级路径）的判定：`packages/host/src/services/builtin-plugins.ts`
- 上线三拓扑（家用 / 云）：[`docs/zh/GO-LIVE.md`](GO-LIVE.md)
- 发布清单里的二进制项：[`.github/RELEASE-CHECKLIST.md`](../../.github/RELEASE-CHECKLIST.md)
