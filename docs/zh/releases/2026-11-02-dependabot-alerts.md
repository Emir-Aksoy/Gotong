# 2026-11-02 处理 20 条 dependabot 告警

方向：**维护**（依赖安全修复，不加功能）。根锁提交 `05ada750`，`shell/` 提交 `c9ba2c08`，运行提交 `f0ae1305`，上一版 `cc1d00e9`。

## 用户指令

2026-11-01：「推送那个文档提交。然后处理github告警」。2026-10-21 用户说过 `shell/` 的告警先不动；这次告警里 3 条严重都在 `shell/`，所以理解为包含 `shell/`。APP-SHELL 仍搁置，这里只升依赖，不推进功能。

2026-11-02：「推送，#126 也关掉，并部署」。

## 结果

20 条里 19 条修复，1 条修不了。提交时已按受影响范围逐条比对新锁，只有 #126 还在范围内；它已按用户指令在 GitHub 上以「可接受风险」（`tolerable_risk`）关闭。推送后，GitHub 在 18:10（CST）把其余 19 条标为已修复，开放告警归零。

| 位置 | 告警 | 包 | 生产能不能碰到 | 处理 |
|---|---|---|---|---|
| 根锁 | #125 高危 | `follow-redirects` | 能：axios → 飞书 SDK | override `^1.16.2` |
| 根锁 | #122 高危 | `zod` | 能：MCP SDK | `^4.6.6`，解析到 4.6.7 |
| 根锁 | #121 高危 | `body-parser` | 不能：只在 MCP SDK 的 HTTP server 子模块 | 2.x 抬到 `^2.4.0`，并加 `body-parser@1` `^1.20.9` |
| 根锁 | #124 中危 | `@hono/node-server` | 不能：同上 | override `^2.1.3`，解析到 2.1.5 |
| 根锁 | #126 中危 | `minimatch` 7.4.9 | 不能：只在本地发包彩排 | **修不了**，见下 |
| `shell/` | #107、#108、#127 严重 | Capacitor（npm 包和 Swift 包） | 不涉及 hub | 8.4.2 → 8.4.3，钉 `~8.4.3` |
| `shell/` | 10 条（#60、#64–70、#73、#74） | `@xmldom/xmldom` | 不涉及 hub，只在 `@capacitor/cli` | override `^0.9.12` |
| `shell/` | #120、#129 中危 | `brace-expansion`、`minimatch` | 不涉及 hub | 由 `glob` override `^14.0.2` 带到修复版本 |

Capacitor 那条（GHSA-rvm3-566m-v7fv）：内部 HTTP 代理路径能把远程内容加载到应用源下。修复只在升级后重新构建的安装包里生效，之前装到设备上的旧调试包不会变。

`pnpm audit` 比开放告警列表多查出两处，都一起修了：根锁的 `body-parser` 1.20.8 和 `shell/` 的 `glob` 13.0.6（GHSA-3g3m-2fjr-6pw4）。

它们其实有告警（#123、#128），只是不在 `state=open` 的列表里。18:10 GitHub 把这两条连同 #48、#71、#72、#75、#89、#90 共 8 条一起标为已修复。这 8 条之前是什么状态，API 已经查不到了。`05ada750` 的提交信息说 `body-parser` 的告警「只写了 2.x」，这个说法不准确，以这里为准。所以修依赖要以 `pnpm audit` 为准，不能只看开放告警列表。

## #126 为什么修不了

唯一的修复版本是 `minimatch` 11，但 11 删了 `makeRe`，`@verdaccio/core` 8.1.2 要调它。verdaccio 不能升，因为 6.9 起要 Node 22，仓库声明 Node >= 20。

我最初 override 到了 11，单元测试、类型检查全部通过，到 `pnpm check:npx-smoke` 才发现 verdaccio 对所有 PUT 都返回 500。已撤销，`brace-expansion@2` 的 override 也恢复了。

实际影响：漏洞是模式串触发的拒绝服务，这条路径只在本地发包彩排里运行，模式串来自我们自己的配置，生产不加载。Node 22 成为基线、verdaccio 能升时，这条会自然解决。

## 验证

根工作区，提交前的最终依赖状态：

- `pnpm install --frozen-lockfile` 通过；构建、`pnpm -r typecheck`、四门、发布门都通过。
- 全量测试：35 个包，10813 项通过、0 失败、9 项跳过。
- `pnpm check:npx-smoke` 通过：36 个包逐一发布核验，`npx` 冷装 4.0.0，host healthz 正常。
- 冒烟：`follow-redirects` 1.16.2 在同主机重定向时保留凭证，跨主机时去掉；`@hono/node-server` 2.1.5 加 `zod` 4.6.7，MCP HTTP 服务端能调工具，也能拒绝错误入参。

`shell/`：

- `pnpm audit` 为 0；`cap sync` 只改了 `Package.swift` 一行。
- iOS 通用模拟器目标 `BUILD SUCCEEDED`，`capacitor-swift-pm` 解析到 8.4.3；Android `assembleDebug` 通过，生成调试 APK。
- 壳工程没有自己的测试，这次只验证到构建，没有在模拟器或设备上运行。

## 中途发现的无关问题

第一轮全量测试有一项失败（`peer-card` 的 `--expect-kid`，退出码 2）。原因和依赖无关：kid 以 `-` 开头时（概率 1/64）会被当成缺值。这是早就存在的问题，测试因此约有 3% 概率偶发失败。已确定性复现，单独修复（提交 `fix(cli): peer-card 接受以 - 开头的 kid`），没有混进这两个依赖提交。

## 部署（2026-11-02 CST）

- 18:07 预部署数据快照：`~/backups/gotong-data-predeploy-f0ae1305-20261102-180740.tar.gz`（6.5MB，1877 条目）。
- thin bundle `cc1d00e9..f0ae1305` 快进；工作区干净。`pnpm install --frozen-lockfile --prefer-offline` RC=0。
- 构建 RC=0，内存峰值 482MB，没用 swap，没有新增 root 属主文件。
- 18:09:35 重启：healthz 200；本次启动 78 行日志，没有 error，唯一 warn 是早已存在的「workflow-assistant 无 API key 跳过注册」；三个 agent 拉起，各挂 tavily；8 个扫描器和推送闸全部 armed，和上次启动一致；自愈台账 boot 行 `prev:"clean"`、downMs 1233；看门狗 `fails:0`。
- 飞书长连接已建立。进程常驻内存 180MB。
- 生产运行时解析到：`zod` 4.6.7（MCP SDK 用的也是它）、`follow-redirects` 1.16.2（飞书 SDK → axios 1.20.0）。
- 用生产的 CLI 对本机 hub 跑 `peer-card --expect-kid <以 - 开头的 kid>`：名片未签名，结果「无法确认」，退出码 3，不再是用法错误。`--expect-kid --help` 仍是退出码 2。

**回滚**：停服务 → `git checkout cc1d00e9` → `pnpm install --frozen-lockfile --prefer-offline` → 重新构建 → 重启。本次不涉及数据结构和配置，快照只作保险。

## 尚未验证

- **生产上的真实 MCP 调用**：tavily 挂载没有报错，但这次没有发起真实搜索，避免消耗额度。本地冒烟走过 MCP HTTP 服务端的工具调用和错误入参拒绝。
- **真实重定向链路**：`follow-redirects` 只在本地冒烟里验证过同主机和跨主机重定向。
- **带签名的真实 hub**：生产名片没有签名，`-` 开头 `kid` 一致时返回 0 这条只在测试里走过。
