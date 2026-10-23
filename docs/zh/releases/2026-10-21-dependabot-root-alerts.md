# 2026-10-21 根锁 35 条 dependabot 告警清零与部署

方向：**维护**（依赖安全修复，不加功能）。提交 `b3afc46a`。

## 用户指令

2026-10-20 先做只读分诊；用户看完分诊表后：「执行修复，跑全量测试后部署，shell 那 12 条先不动」。

## 分诊结论

47 条开放告警：根锁 35 条，`shell/` 独立锁 12 条（APP-SHELL 已搁置，本次不动）。

| 包（条数） | 生产能不能碰到 | 处理 |
|---|---|---|
| axios 1.18.1（10） | 能：host → im-lark → 飞书 SDK，飞书桥每条消息都走 | override `^1.20.0`（锁复用，`pnpm up` 抬不动） |
| @xmldom/xmldom 0.8.13（10） | 启动即加载；生产没配 SAML provider，外部 XML 目前进不来 | 范围内升 0.8.15 |
| fast-uri 3.1.6（1） | 能：SDK client → ajv 运行时加载 | 旧 override 下限把锁卡在漏洞版，抬到 `^3.1.7` |
| MCP SDK / proxy-addr / hono / ip-address（5） | 不能：只经 SDK 的 HTTP server 子模块进来，我们只用 client 与 stdio | SDK 升 1.32.1，其余抬 override 下限 |
| verdaccio 链 4 包（6）、vitest（2）、source-map-js（1） | 不能：仅开发 / 测试 / 构建 | overrides 与 vitest 升级 |

## 两个踩坑（为什么 verdaccio 不升）

- verdaccio 6.9 起 `engines` 要求 Node >= 22，仓库声明 >= 20、本机就是 Node 20，升了发包演练门起不来。
  所以钉 `~6.8.0`，6.8.0 树内的漏洞包改走 overrides。
- 6.10 的 `@verdaccio/config` 精确依赖 js-yaml 5.4.1，会被既有的 `"js-yaml": "^4.3.1"` override
  压回 4.x 而崩（缺 `YAML11_SCHEMA`）。**将来升 verdaccio 时须同步把那条收窄为 `"js-yaml@4"`。**

## 本地验证

semver 逐条对 35 条告警的受影响范围，新锁零命中；`pnpm install --frozen-lockfile` 通过；build /
typecheck RC=0；35 包测试全绿（host 3788 + 5 skip、web 1713）；四门 PASS；发布就绪门 36 包通过。

## 部署（2026-10-21 CST）

- 11:06 预部署数据快照：`~/backups/gotong-data-predeploy-b3afc46a-20261021-110620.tar.gz`（4.8MB）。
- thin bundle `ebcc9754..b3afc46a` 快进；`pnpm install --frozen-lockfile --prefer-offline` RC=0
  （新版本从镜像拉取）；构建 RC=0，内存峰值 466MB，没有新增 root 属主文件。
- 11:08:52 重启：healthz 200；本次启动 78 行、error 0 条，唯一 warn 是老的「workflow-assistant
  无 anthropic key 跳过注册」；三个 agent 拉起、各扫描 armed；自愈 boot 行 `prev:"clean"`。
- 飞书长连接已建立（进程有到 `msg-frontier.feishu.cn:443` 的已建立连接）。SDK 先用 axios 换长连接
  地址再连，所以 axios 1.20.0 在生产链路上实际跑通。
- 生产 `node_modules`：axios 1.20.0、@xmldom/xmldom 0.8.15、fast-uri 3.1.9、MCP SDK 1.32.1、
  proxy-addr 2.0.8、hono 4.13.13、ip-address 10.7.4、verdaccio 6.8.0。

**回滚**：停服务 → `git checkout ebcc9754` → `pnpm install --frozen-lockfile --prefer-offline` →
重新构建 → 重启。本次不涉及数据结构和配置，快照只作保险。

## 后续

- 已推 GitHub（`ae15fb07..2312d0c1`），35 条告警已被 GitHub 自动标为已修复。
- 推送后新出 5 条，2026-10-23 按用户指令「修掉那5条告警，测试后推送」补修（未部署）：
  - vite 3 条（GHSA-698v-4r3x-3vcv / GHSA-587h-7wmj-h5pm / GHSA-r825-w8mm-5pxw，漏洞在 Windows 上的
    launch-editor）：根 devDep `^8.1.5` → `^8.1.6`，锁解析到 8.3.5。只有 vitest 用到 vite，不起 vite
    开发服务器。
  - qs 2 条（GHSA-4mjr-xmp4-gh2g / GHSA-x5fp-wj9c-mxmx）：override 下限 `^6.15.2` → `^6.16.0`，锁里只剩
    6.16.1。飞书 SDK 会在运行时加载 qs，但只调用 `qs.stringify` 拼出站请求参数，参数由我们的代码构造；
    另一条引入路径（body-parser）在 MCP SDK 不加载的 HTTP server 子模块里。生产在下次部署前仍是 6.15.3。
  - 验证：build / typecheck RC=0；35 包测试全绿（host 3788 + 5 skip、web 1713）；四门 PASS；发布就绪门 36 包通过。
- `shell/` 独立锁的告警（推送后变为 13 条）按用户指令不动。
