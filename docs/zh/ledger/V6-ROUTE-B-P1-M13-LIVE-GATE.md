# Route B P1-M13 — 真实 LLM 冒烟门进 CI 收口

> 路线 B P1 「分发 + 验证可信度」(P1-D) 的一刀: 把对真实 LLM 的验证从
> 「两个各发一句话的 `live.test` + 没人定时跑」推到「**工具调用往返 + 一条
> 完整工作流, 夜间/按需在 CI 里花真 token 跑, 没 key 自动跳过永不变红**」。
>
> 拆 3 个里程碑 (M13a→M13c) 落地, 一个里程碑一个小 commit。本文是收口。
> Last updated: 2026-06-03

---

## 一句话

`ci.yml` 把所有 LLM 线都 mock 掉、必须确定性且免费 —— 这意味着「provider 的
流式翻译 / 工具调用契约对真实厂商悄悄漂了」这类事它**永远抓不到**。M13 加一条
**独立的 live 门** (`live.yml`): 跑那批 `ci.yml` 故意跳过的 `live.test.ts` /
`live-workflow.test.ts`, key 从 repo secrets 注入, 夜间定时 + 可手动触发。

两层覆盖:① **provider 层** —— 真实工具调用往返 (声明 tool → 模型真的选它 →
喂回 `tool_result` → 模型把结果叠进最终答复); ② **整栈层** —— Hub + 真
`LlmAgent` + `WorkflowRunner` 跑一条两步工作流, 证 runner 把 step-1 的输出
穿进 step-2 的活提示词。

## 北极星对齐

- **「框架不跑 LLM」不等于「不验证 LLM 接得通」**: 三守则说 hub 自己不做决策,
  但 provider 适配层 (Anthropic vision / OpenAI tool_calls / DeepSeek 兼容) 是
  框架的责任边界 —— 它跟真实厂商对不上, 整个产品就是坏的。mock 测试钉**形状**,
  live 门钉**对真厂商仍成立**。
- **诚实**: 没 key 时**跳过而非假绿**也不是假红 —— `skipIf(!key)` 让缺 secret
  的 fork / 加 secret 之前的本仓永远绿, 只有**真的** live 失败才变红。这跟 P3
  「文档诚实化」「业务指标 best-effort 永不 500」同一种立场: 不制造假信号。
- **成本是一等约束**: 个人 hub 北极星意味着这套东西要能被一个人养着 —— 默认
  廉价模型 (Haiku / gpt-4o-mini)、tiny 提示、小 token 上限、DeepSeek 兼容路径。

---

## 二、关键决策

### live 门独立于 `ci.yml`, 不混进主 CI (M13c)

`ci.yml` 必须**确定性 + 免费 + 每次 push 都跑**。把花钱、非确定、依赖第三方
可用性的 live 测试塞进去会污染这三条。所以 live 门是**单独的 workflow**, 自己的
触发器、自己的并发组、自己的预算。主 CI 仍 `pnpm -r test` 全跑 —— 那批 live 文件
在主 CI 里因无 key 而 `skipIf` 跳过, 零成本。

### 夜间 + 手动, **不**做自动硬释放闸 (M13c)

plan 写的是「nightly/release gate」。但把一个**付费、非确定、第三方** API 测试
做成自动卡释放的硬闸是坏实践 —— 厂商一抖动 / 限流 / 欠费就发不了版。诚实的折中:
`schedule` (夜间信号, 漂了一天内变红) + `workflow_dispatch` (切版前想要信号就手动
跑一次)。把红当「去查」, 不当「禁止发布」。理由写进 `live.yml` 头注释, 不留误解。

### Skip-clean by construction —— 空 secret = 空串 = 跳过 (M13c)

GitHub Actions 里未配置的 `${{ secrets.X }}` 注入成**空字符串**, `process.env.X`
就是 `''`, `Boolean('')` 为 false, `skipIf(!key)` 跳过, vitest 把全跳过的文件记
**exit 0**。于是「没配 secret 的 live 门」是绿的 (跳过≠失败)。只有配了 key 且
真失败才红。无需在 workflow 里写「if secret exists」的条件分支 —— 跳过逻辑天然在
测试侧, workflow 只管把 env 递进去。

### 工具调用往返用一个「模型本来不可能知道」的 token (M13a)

光断言 `stopReason==='tool_use'` 只证了「模型会调工具」, 没证「喂回的结果真被
读进去」。所以第二轮喂一个模型无从编造的值 (`OPALINE-7`), 再断言它**大小写不敏感
地**出现在最终文本里 —— 这才钉死了完整往返。两个 provider 都带这条, 因为
Anthropic 走 `tool_result` block、OpenAI 走独立 `role:'tool'` 消息, 是**两条不同
的翻译路径**, 冗余是故意的。

### workflow live 测是 mock E2E 的「换 provider」拷贝, 不重造轮子 (M13b)

`industry-consultation-flow.test.ts` 已经用 `MockLlmProvider` 证了 Hub + LlmAgent
+ WorkflowRunner + `$ref` 穿透 + output map 这套接线**对**。M13b 是它的忠实拷贝,
**只把 provider 换成真的** —— 所以「接线对不对」已被 mock E2E 证, live 测只补
「对真模型仍成立」这唯一增量, 不重复覆盖 suspend/resume 之类。

### 模型与端点全 env 可覆盖, 默认最便宜 (M13a/M13b)

`GOTONG_LIVE_ANTHROPIC_MODEL` / `GOTONG_LIVE_OPENAI_MODEL` + `OPENAI_BASE_URL`。
provider 说 OpenAI 协议, 所以最省的路径是把它指向 DeepSeek (`OPENAI_API_KEY`=
deepseek key + `OPENAI_BASE_URL=https://api.deepseek.com` + 模型 `deepseek-chat`)。
两个 key 都配时 host workflow 测优先 Anthropic Haiku。

---

## 三、各里程碑

| M | commit | 内容 |
|---|---|---|
| M13a | `357d684` | 两个 provider `live.test.ts` 加工具调用往返 (声明→tool_use→喂 tool_result→断言 token 叠进答复); 廉价模型默认 + env 覆盖; 仍 `skipIf(no key)`。anthropic 44 过/2 跳, openai 68 过/2 跳。 |
| M13b | `a56f57f` | host `live-workflow.test.ts`: Hub + 真 `LlmAgent` + `parseWorkflow` + `WorkflowRunner` 跑两步流 (`echo`→`wrap` 吃 `$echo.output`); env 建 provider (Anthropic/OpenAI-compat); `skipIf(no key)`, 一次运行/两句话/64 token 上限。无 key 时 1 跳过, host typecheck 净。 |
| M13c | (本提交) | `.github/workflows/live.yml` (夜间 cron + workflow_dispatch, 跑三个 live 文件, key 从 secrets, skip-clean) + 本收口文档 + CLAUDE.md。 |

---

## 四、数据流 (端到端)

```
nightly cron / 手动 dispatch
   │
   ▼
live.yml  ──setup-workspace + pnpm -r build──▶  dist 就绪
   │
   │  env: ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENAI_BASE_URL  (来自 secrets)
   ▼
┌─ pnpm -C packages/llm-anthropic exec vitest run tests/live.test.ts
│     skipIf(!ANTHROPIC_API_KEY)
│       ├─ 无 key → 跳过 (绿)
│       └─ 有 key → tiny-text + 工具调用往返 ──▶ api.anthropic.com
├─ pnpm -C packages/llm-openai     exec vitest run tests/live.test.ts
│     skipIf(!OPENAI_API_KEY)  ──▶ api.openai.com / api.deepseek.com
└─ pnpm -C packages/host          exec vitest run tests/live-workflow.test.ts
      skipIf(!ANTHROPIC && !OPENAI)
        └─ Hub.dispatch(capability: live-smoke)
             └─ WorkflowRunner: echo step ──▶ 真模型 ──▶ {text:'PONG'}
                                  wrap step (吃 $echo.output) ──▶ 真模型 ──▶ {text:'PONG'}
                          断言 out.echo.text & out.wrap.text 含 'pong'
```

全跳过 → exit 0 → workflow 绿。任一真失败 → 红 → 夜间信号。

---

## 五、测试矩阵 (+5 gated)

| 包 | 文件 | 测试 | 门控 |
|---|---|---|---|
| llm-anthropic | `tests/live.test.ts` | 2 (tiny-text + 工具往返) | `ANTHROPIC_API_KEY` |
| llm-openai | `tests/live.test.ts` | 2 (tiny-text + 工具往返) | `OPENAI_API_KEY` |
| host | `tests/live-workflow.test.ts` | 1 (两步工作流) | 任一 key |

无 key 本地/CI: 全 5 跳过, 零回归 (anthropic 44 / openai 68 / host typecheck 净)。

---

## 六、运维须知

- **加 CI secret**: 仓库 Settings → Secrets and variables → Actions → 加
  `ANTHROPIC_API_KEY` 和/或 `OPENAI_API_KEY` (DeepSeek 则 `OPENAI_API_KEY`=
  deepseek key + 加 `OPENAI_BASE_URL` secret = `https://api.deepseek.com`)。
  模型覆盖用 **Variables** (非 secret): `GOTONG_LIVE_OPENAI_MODEL=deepseek-chat`。
- **不配也行**: 没 secret 时夜间门全跳过保持绿 —— 它只在你想要真实信号时才需要 key。
- **成本**: 每次 ~5 个 tiny 调用, 默认 Haiku/gpt-4o-mini/deepseek-chat + 小 token
  上限, 一次运行成本约几分钱级。`schedule` 一天一次。
- **本地手动跑一次**: `ANTHROPIC_API_KEY=... pnpm -C packages/host exec vitest run tests/live-workflow.test.ts`
  (或对应 provider 包)。

## 七、显式推迟 / P1-D 状态 (诚实记录)

- **P1-M12 跑通一次 release**: 需统一全包版本号 (决策 D-4) + 打 tag + `git push` +
  启用 GitHub PVR。push 冻结已于 2026-06-16 解除、仓库已于 2026-06-28 公开, 原「上传暂停」
  约束**已不复存在**; 剩下只是版本统一 + 实际打 tag/发版那一步 (Actions 需先重新启用)。本地
  `release.yml` 五平台产物逻辑已就绪 (bun --compile)。
- **P1-M14 代码签名 (可选)**: 需付费证书 (Apple $99/yr + Authenticode $200-500/yr,
  决策 D-5)。属财务采购, 需用户拍板, **暂不投**。`release.yml` 尾注释已记录配方。
- **M13 自身推迟**: 多轮工具链 (multi-tool-call loop) 的 live 覆盖; 多模态 (vision)
  live 测; 把 live 门做成 `workflow_call` 供 release 显式调用 (现 dispatch 已够)。

> 结论: **P1-D 三刀里 M13 是唯一不依赖外部前置 (push 解禁 / 付费证书) 的, 已收口。**
> M12 / M14 待用户解除对应约束后再推。

---

## 关联

- CI 主门: `.github/workflows/ci.yml` (mock, 确定性, 免费, 每 push)
- live 门: `.github/workflows/live.yml` (真模型, 夜间/手动, 付费, skip-clean)
- 工具调用 wire 类型: `packages/llm/src/types.ts` (`LlmToolDefinition` / `LlmToolUseBlock` / `LlmToolResultBlock`)
- mock 对照 E2E: `packages/host/tests/industry-consultation-flow.test.ts`
