# Gotong 交付物信封的 dsh 规范包（共享技能目录形状）

让 [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 用户与 Gotong hub
用户互发**标准交付物信封**（`gotong.envelope/v1`，一份 `.json` 文件 = 一件事）。**转发靠人**：
agent 只生成/解析文件，你自己在微信/飞书/Telegram 里把文件发给对方——不需要公网、
不需要电脑常开、没有任何自动转发。

与 pi 包（`packs/pi/`，原生扩展工具）不同，本包走 **SKILL.md + 零依赖脚本**的共享技能形状：

| 资源 | 说明 |
|---|---|
| 技能 `gotong-envelope` | 信封规范、目录约定、安全边界（dsh 按 description 路由，按需加载） |
| 脚本 `scripts/envelope.mjs` | **唯一入口**：组装 + 完整 schema 校验（fail-closed）+ 写出/解析/验签；零第三方依赖，Node ≥ 18 |
| `references/gotong.envelope.v1.schema.json` | 权威 schema 的逐字节拷贝 |

**结构性校验住在脚本里**：信封只能经 `envelope.mjs` 产出，手写 JSON 没过校验对方 hub 会拒收。
这也意味着任何能跑 shell 的 agent（不止 dsh）都能用本技能——SKILL.md 是跨工具通用形状。

## 安装

**本包对 `@deepseek-ai/dsh` 0.1.0-rc.6 验证（2026-08-14）。** dsh 处于 developer preview，
官方 README 明言 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"（4 天内发了 6 个 rc）；
dsh 大版本更新后请先在本地重新验证识别与脚本行为再继续使用。

安装 = 一次拷贝（dsh 扫 `~/.agents/skills/` 用户级共享目录）：

```bash
cp -r packs/dsh/skills/gotong-envelope ~/.agents/skills/
```

三个硬约束（dsh 0.1.0-rc.6 源码核实）：

- **必须一层扁平**：`~/.agents/skills/gotong-envelope/SKILL.md`。dsh 只扫一层不递归，
  嵌套目录里的技能会**静默不可见**（连警告都没有）。
- frontmatter 的 `name` + `description` 都是硬必填，缺任一 dsh 会 warn 后静默跳过。
- 项目级 `.agents/skills/`（含 `.dsh/skills/`）的**同名技能会压过用户级**——若某项目里
  另有一份 `gotong-envelope`，在那个项目里生效的是项目级那份。

## 用法

1. **发任务**：对 dsh 说「帮我给阿同的 hub 发个行情分析请求」。dsh 按技能指引调
   `envelope.mjs emit` 生成 `gotong-out/exg-xxxx.json`，你在 IM 里把文件发给对方。
2. **收任务/收结果**：把 IM 里收到的 `.json` 文件放进项目的 `gotong-in/`，
   对 dsh 说「看看收件箱」。
3. 对方是 Gotong hub 用户时，TA 在 hub 网页「我的 → 导入交付物文件」两段确认导入，
   跑完后把 result 信封发回给你。

脚本也可以直接手跑（不经 agent）：

```bash
node ~/.agents/skills/gotong-envelope/scripts/envelope.mjs ingest
```

> dsh 真跑（`dsh --profile headless "..."`）需要 `DEEPSEEK_API_KEY`。

## 多宿主说明

- 同一份技能目录 pi（≥ 0.84）也认（pi 同样扫 `~/.agents/skills/`，且把用户级目录视为可信）。
- 但 **pi 用户建议用 `packs/pi/`**（原生 `gotong_emit`/`gotong_ingest` 工具，体验更好）；
  已装 pi 包的机器**不要**再把本包拷进 `~/.agents/skills/`——两边技能同名，
  同名并存时的选择行为未定义。

## 刻意不做：dsh Cordis 插件

dsh 有插件级 `ctx.tools.register`（per-tool `output.schema` 强约束）。本包 v1 **刻意不做**：
插件 API 随 developer preview 高频变动（写了就腐），而结构性校验已由脚本边界完整达成——
插件只会重复同一道闸。dsh 出 1.0 后若插件形状稳定，可另起里程碑补原生工具版。

## 防漂移

`references/gotong.envelope.v1.schema.json` 是主仓库权威副本的逐字节拷贝；
主仓库的 `packages/host/tests/exchange-pack-dsh.test.ts` 同时钉住 schema 文本一致、
本包校验器与 hub 侧**整错误数组对拍**、签名互通、脚本 CLI 契约（spawn 真跑）、
以及 SKILL.md 对 dsh frontmatter 契约的遵守（kebab 名 / description ≤500 / 无 camelCase 调用键）。

规范全文：主仓库 `docs/zh/EXCHANGE-ENVELOPE.md`。
