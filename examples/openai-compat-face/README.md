# OpenAI 兼容入站面 capstone

```bash
pnpm demo:openai-compat
```

**零 API key、确定性、几秒钟跑完。** hub 里挂的是写死答案的 stub agent，
一次 LLM 调用都没有 —— 所以它能进 CI。

---

## 它要证的一句话

> **「Gotong 里的一个 agent」变成任何 OpenAI 生态工具眼里的一个 model id，
> 对方零改动。**

`src/vanilla-client.ts` 就是那个「对方」。它只 import `openai`，全文不出现产品名，
连接方式是一行：

```ts
return new OpenAI({ apiKey, baseURL })
```

指向 Azure / Together / Ollama 时你也是这么写的。

---

## 三幕

| | 在证什么 | 判据 |
|---|---|---|
| **一** 零改动 | 客户端源码自证 | import 清单恰好 `['openai']`、全文零处产品名；然后用它列模型、问答 |
| **二** M2 判据 | SSE 流式没撒谎 | 真 SDK 两条路对拍：**delta 累加逐字节等于非流式答案** |
| **三** 差异清单 | 兼容到哪、故意不同在哪 | 十项行为逐个等于写定的标签 |

**第二幕为什么值得单独跑一遍**：仓内测试（`packages/web/tests/openai-compat-routes.test.ts`）
用的是**手写**的 SSE 解析器——那是刻意的，拿 SDK 去读等于让被测的流跟同族实现对表。
这里反过来，用 `openai` SDK 自己的解析器，是**独立**证据。被测正文专挑会咬人的形状：
正文里带 `\n\n`（SSE 的分帧符）、正文里就写着一条**伪造的** `data: [DONE]`、
前后带空白、末尾一个多字节字符。

---

## 第三幕那张表

跑完会打出一张 `一致 / 故意不同` 的对照表。**「判定」那一列是推出来的**
（量出来的标签 vs 写定的「真 OpenAI 在同一动作下的标签」），不是声明出来的。

如实说明：「真 OpenAI」那一列是**写定的文档事实，不是本机量出来的**
—— 这个 demo 零 key，没法真去打 `api.openai.com`。

跑出来是 4 项一致 / 6 项故意不同。那 6 条不是没做完：

- **`usage` 缺席** —— TaskResult 不带 token 数，报 0 会被读成「这次免费」。真账在 hub 用量账本。
- **`tools` 400** —— 接了就等于把执行权交到闸外面。
- **`system` 被丢掉** —— 人设配在 hub 里，一个调用方不该能改写别人 agent 的人设。
- **`n>1` 400** —— 返回 1 个 choice 却说好了 n 个，是撒谎。
- **`temperature` 一类被忽略** —— 那是 agent 主人配的。
- **治理闸挡下 → 200 + 一句「我得先问你一声」** —— 那不是错误，是岔口 a。

理由的完整版在 [`docs/zh/OPENAI-COMPAT-API.md`](../../docs/zh/OPENAI-COMPAT-API.md) §二。

### 判据为什么钉在标签上而不是表的形状上

第一版只断言了那张表的**形状**（哪几项一致、哪几项故意不同）。变异测试当场
证明它太粗：把 `tools` 从 400 改成**静默忽略**，标签从 `400:unsupported_parameter`
变成 `ok:stop`，可两者都不等于 `ok:tool_calls`，形状纹丝不动 —— 而「收下 tools
却不用它」恰恰是这条面最危险的回归，调用方会以为工具真的被执行了。

所以判据钉到了标签本身。形状仍然打印，但只是**报出来的结果**：标签一钉死，
4/6 就是算出来的，再 assert 一遍等于拿结论证明结论。

---

## 与生产的距离

被测的那一面（`packages/web/src/openai-compat-routes.ts`）是**同一份生产代码**。
demo 里手写的只是 `serveWeb` 需要的几个最小 surface stub —— 真实部署里它们由
`@gotong/host` 装配。这么做是为了让 demo 自明、且不依赖任何外部服务。
