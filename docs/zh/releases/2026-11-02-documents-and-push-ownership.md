# 2026-11-02 阿同生成文档与后台推送修复部署

方向：**T**（`write_document`）；后台推送的两处修复、依赖告警和部署属**维护**。
运行提交 `cc1d00e9`，上一版 `b3afc46a`。

## 用户指令

2026-11-01：「推送，然后部署」。

## 上线内容

| 提交 | 内容 |
|---|---|
| `0679ebbc` | 阿同生成 PPT 和 Word，发到本人飞书私聊，见 [`ATONG-DOCUMENTS.md`](../ATONG-DOCUMENTS.md) |
| `cd70a287` | 后台推送和发文件前核对账号绑定，解绑或换绑后不再发给账号的新主人 |
| `cc1d00e9` | 投递失败已排队时，后台扫描按已交出处理，不再重复生成和入队 |
| `51a0b8fb` | 依赖告警补修：vite 8.3.5、qs 6.16.1 |
| `04b3061c`、`ba7f7d75`、`2312d0c1` | 只改文档 |

没有数据结构迁移（`identity`、`core`、`protocol` 零改动），没有新环境变量，`agents.json`、`gotong.env` 和凭据库全程未读未写。

## 本地验证

`cc1d00e9` 上：全量测试 10813 项通过、0 失败、9 项跳过；构建、`pnpm -r typecheck`、四门、发布门都通过。

评审范围不一样：`write_document` 和 `cd70a287` 都经过独立子代理审查；`cc1d00e9` 只有自审和 12 发变异，没有开子代理。

## 部署（2026-11-02 CST）

- 上线前只读核对：唯一成员的飞书路由和账号绑定一致，绑定核对不会误拦后台推送。
- 10:04 预部署数据快照：`~/backups/gotong-data-predeploy-cc1d00e9-20261102-100456.tar.gz`（7.1MB，1863 条目）。
- thin bundle `b3afc46a..cc1d00e9` 快进；工作区干净。`pnpm install --frozen-lockfile --prefer-offline` RC=0。
- 构建 RC=0，内存峰值 476MB，没用 swap。新生成的 24 个 dist 文件属主为 root，已定点改回 ubuntu。
- 重启前用构建产物复测文档生成上限，14 个场景都生成成功（其中 1 个超出页数上限，真实工具会拒绝），最高 212MB，最慢 1.32 秒，都是合法 zip 文件头。真实 runner 生成 PPT 和 Word 各一份，通过。

  | 场景 | 峰值 | 耗时 |
  |---|---|---|
  | Word，上限处单列长单元格 | 212MB | 1.32 秒 |
  | Word，上限处长单元格 | 205MB | 1.32 秒 |
  | Word，17 个最大图表 | 195MB | 1.27 秒 |
  | Word，上限处短单元格 | 194MB | 1.28 秒 |
  | PPT，上限处短单元格 | 161MB | 1.05 秒 |
  | PPT，小图表 120 页 | 149MB | 1.13 秒 |

- 10:08:40 重启：healthz 200；本次启动 73 行日志，没有 error，唯一 warn 是早已存在的「workflow-assistant 无 API key 跳过注册」；三个 agent 拉起；8 个扫描器和推送闸全部 armed，和上次启动一致；自愈台账 boot 行 `prev:"clean"`、downMs 2650；看门狗 `fails:0`。
- 飞书长连接已建立（进程有到 `msg-frontier.feishu.cn` 的已建立连接）。进程常驻内存 186MB。
- 生产 `node_modules`：`docx` 9.15.1、`pptxgenjs` 4.0.1、`image-size` 2.0.4、axios 1.20.0、qs 6.16.1。

**回滚**：停服务 → `git checkout b3afc46a` → `pnpm install --frozen-lockfile --prefer-offline` → 重新构建 → 定点改回新文件属主 → 重启。本次不涉及数据结构和配置，快照只作保险；未发送的文档草稿留在 `butler/documents/` 无害，旧代码不读。

## 尚未验证

- **真实飞书发送**：要等成员发一次「做个三页 PPT，带一张图表」。这也会验证生产用的应用确实有文件权限：后台确认过权限，但没有核对生产用的是不是那个应用，因为应用 ID 在生产凭证里。
- **PowerPoint / WPS / Word 的实际显示**：包括图表和字体，见 [`ATONG-DOCUMENTS.md`](../ATONG-DOCUMENTS.md) 第六节。
- **真实的换绑和补投**：只在端到端测试里走过，生产上没有触发过。

## 已知限制

- 成员有多个账号时，要从现有账号说一句话才恢复路由；这期间文件工具会提示「还没绑定飞书」。
- 免打扰闸的早晨合并发送、生活档案的告警和周回顾不看投递结果，outbox 写盘也失败时这条消息会丢。
- GitHub 上还有 20 条开放告警：根锁 5 条（`zod`、`body-parser`、`follow-redirects` 高危，`@hono/node-server`、`minimatch` 中危），`shell/` 15 条。这次没有处理。
