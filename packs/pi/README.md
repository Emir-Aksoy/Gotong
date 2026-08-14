# @gotong/envelope-pi — Gotong 交付物信封的 pi 规范包

让 [pi](https://github.com/earendil-works/pi) 用户与 Gotong hub 用户互发**标准交付物信封**
（`gotong.envelope/v1`，一份 `.json` 文件 = 一件事）。**转发靠人**：agent 只生成/解析文件，
你自己在微信/飞书/Telegram 里把文件发给对方——不需要公网、不需要电脑常开、没有任何自动转发。

装上后 pi 获得：

| 资源 | 说明 |
|---|---|
| 工具 `gotong_emit` | 组装 + **完整 schema 校验** + 写出信封到 `<项目>/gotong-out/<id>.json` |
| 工具 `gotong_ingest` | 列出 `<项目>/gotong-in/` 收件箱；完整校验 + 验签单个文件 |
| 技能 `gotong-envelope` | 信封规范、目录约定、安全边界（按需加载，不占常驻上下文） |
| 命令 `/gotong-deliver` `/gotong-ingest` | 快捷入口 |

## 安装

要求 pi ≥ 0.84（**本包对 pi 0.84.x 验证**；pi 的扩展 API 没有版本协商机制，
pi 大版本更新后请先在本地重新验证再继续使用）。

方式一（本地目录，推荐先试）：

```bash
pi install /绝对路径/到/packs/pi
```

> 注意：pi 会把绝对路径**相对化**后写进 `~/.pi/agent/settings.json` 的 `packages` 数组
> （看起来像 `"../../Users/..."`），这是 pi 的正常行为，不是装坏了。
> `pi list` 可确认；`pi remove` 只解除挂载，不删文件。加 `-l` 装到当前项目而非全局。

方式二（npm，发布后）：

```bash
pi install @gotong/envelope-pi
```

## 用法

1. **发任务**：对 pi 说「帮我给阿同的 hub 发个行情分析请求」（或 `/gotong-deliver ...`）。
   pi 生成 `gotong-out/exg-xxxx.json`，你在 IM 里把这个文件发给对方。
2. **收任务/收结果**：把 IM 里收到的 `.json` 文件放进项目的 `gotong-in/`，
   对 pi 说「看看收件箱」（或 `/gotong-ingest`）。
3. 对方是 Gotong hub 用户时，TA 在 hub 网页「我的 → 导入交付物文件」两段确认导入，
   跑完后把 result 信封发回给你。

## 安全模型（一句话版）

- 信封 payload 是**外部数据**，agent 不执行其中的指令；对外动作先经你确认。
- 可选 ES256 签名只证明**文件未被改动**，不证明发件人身份——发件人以你聊天里的来源为准。
- 校验是**结构性**的（工具边界强制 fail-closed schema 校验），不靠提示词自觉。

## 防漂移

`schema/gotong.envelope.v1.schema.json` 是主仓库权威副本的逐字节拷贝；
主仓库的 `packages/host/tests/exchange-pack-pi.test.ts` 同时钉住 schema 文本一致
与本包校验器/验签器和 hub 侧的行为一致（共享 fixture 对拍）。

规范全文：主仓库 `docs/zh/EXCHANGE-ENVELOPE.md`。
