# Gotong 交付物信封的 WorkBuddy 规范包（SKILL.md + 纯 Python 脚本）

让腾讯 WorkBuddy 用户与 Gotong hub 用户互发**标准交付物信封**（`gotong.envelope/v1`，
一份 `.json` 文件 = 一件事）。**转发靠人**：agent 只生成/解析文件，你自己在微信里把
文件发给对方——不需要公网、不需要电脑常开、没有任何自动转发。

与 pi 包（原生扩展工具）、dsh 包（Node 脚本）平行，本包为 WorkBuddy 的运行环境选了
**SKILL.md + 纯 Python 标准库脚本**的形状（零 pip 依赖，Python ≥ 3.9 即跑）：

| 资源 | 说明 |
|---|---|
| 技能 `gotong-envelope` | 信封规范、目录约定、安全边界（宿主按 description 路由，按需加载） |
| 脚本 `scripts/validate.py` | **唯一入口**：组装 + 完整 schema 校验（fail-closed）+ 写出/解析/`validate` 只读子命令；纯 stdlib |
| `references/gotong.envelope.v1.schema.json` | 权威 schema 的逐字节拷贝 |

**结构性校验住在脚本里**：信封只能经 `validate.py` 产出，手写 JSON 没过校验对方 hub
会拒收。SKILL.md 是跨工具通用形状——任何能跑 `python3` 的 agent 都能用本技能。

**签名的诚实边界**：纯 stdlib Python 做不了 ES256 数学验签。脚本仍会做 RFC 7638
kid 绑定核验（从 `sig.jwk` **重算**指纹并与 `sig.kid`、`from.kid` 对拍——撒谎-JWK
会被判 `✗ 无效`），但最强的正向结论只有「◐ 结构完好、kid 绑定一致」。签名本就只证
完整性不证发件人，发件人一律以聊天来源为准，所以这个降级不损失信任模型里的任何承重件。

## 安装

WorkBuddy 支持**技能包 zip 本地导入**（官方明文兼容 Claude Code 技能/插件规范）。
zip 不进仓库（二进制不入 git），用时现打：

```bash
cd packs/workbuddy/skills && zip -r gotong-envelope.zip gotong-envelope
```

然后在 WorkBuddy 的技能管理界面把 `gotong-envelope.zip` 拖进去导入。

> **成色说明（诚实标注）**：「zip 拖拽导入 + 兼容 Claude Code 技能规范 + 微信助理可收
> 文件消息」来自 2026-08-13 官方文档侦察（二手来源）；本包在 WorkBuddy 实机上的识别与
> 运行**尚未验证**——这正是下方「四步实机验证」的目的。若拖拽导入不认，备选路径：
> ① 把 `skills/gotong-envelope/` 整目录拷进 WorkBuddy 的技能目录（如 `~/.workbuddy/skills/`，
> 具体以实机为准）；② 按 Claude Code 插件规范补一个 `.claude-plugin/` 清单再打包。
> 实机验证后本节会按事实改写。

脚本本身不依赖宿主，随时可直接手跑（不经 agent）：

```bash
python3 skills/gotong-envelope/scripts/validate.py validate 某份信封.json
```

## 用法

1. **发任务**：对助理说「帮我给阿同的 hub 发个行情分析请求」。助理按技能指引调
   `validate.py emit` 生成 `gotong-out/exg-xxxx.json`，你在微信里把文件发给对方。
2. **收任务/收结果**：把微信里收到的 `.json` 文件保存下来，放进项目的 `gotong-in/`，
   对助理说「看看收件箱」。
3. 对方是 Gotong hub 用户时，TA 在 hub 网页「我的 → 导入交付物文件」两段确认导入，
   跑完后把 result 信封发回给你。

## 四步实机验证清单（用户门，需装 WorkBuddy 的机器）

1. 技能导入后 WorkBuddy 认不认（zip 拖拽为主路；不认则试上面两条备选路径）。
2. 让助理按 schema 产出一份信封,并跑通 `python3 …/validate.py validate <文件>`（exit 0）。
3. 微信里把 `.json` 信封文件发给 WorkBuddy 助理,看它能否读入内容。
4. 助理产出的信封文件能否投回微信（官方文档回避此点,不实测不定案）。

## 多宿主说明

- 同一份技能目录 pi（≥ 0.84）与 dsh 也认（两者都扫 `~/.agents/skills/`）。
- 但 **pi 用户请用 `packs/pi/`、dsh 用户请用 `packs/dsh/`**——那两个包分别为各自宿主
  做了原生适配；不要在同一台机器上给同名技能装两份，同名并存时的选择行为未定义。

## 刻意不做

- **不内嵌 Node 版脚本**（`envelope.mjs`）：WorkBuddy 环境不保证 Node 在场，Python
  是更普适的分母；两份脚本同仓并存会各自漂移，防漂移门只钉一份。
- **不做微信自动收发**：转发靠人是本 track 的边界（协议不降级只降传输层），任何
  自动转发都撞「人是传输层」的设计立场。

## 防漂移

`references/gotong.envelope.v1.schema.json` 是主仓库权威副本的逐字节拷贝；
主仓库的 `packages/host/tests/exchange-pack-workbuddy.test.ts` 用 `python3` 真跑本包
脚本,钉住 schema 文本一致、Python 校验器与 hub 侧**整错误数组对拍**（错误串逐字节同,
仅 JSON 解析器的引擎附注按前缀对拍）、kid 绑定判定（撒谎-JWK → invalid）、
emit 产物被 hub 校验器逐字节接受、CLI stdin/exit-code 契约,以及 SKILL.md 卫生。

规范全文：主仓库 `docs/zh/EXCHANGE-ENVELOPE.md`。
