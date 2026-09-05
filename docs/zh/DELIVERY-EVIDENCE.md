# 交付物验收证据

方向: **C**。Gotong 是 agent 之间交互并治理 MCP/RAG 调用的网络；Atong 是高度适配它的原生 agent。本项把可复验的验收记录放进网络的交付物，而不要求参与者使用某个模型。

## 已实现的边界

`gotong.envelope/v1` 请求可带 `acceptance`；结果可带 `gotong.evidence/v1` 证据。既有 `/api/me/exchange/import` 的工作流/成员权限和人工确认不变。请求检查不作为新的工具参数注入工作流。

- `equals`：JSON Pointer 选中输出后，按规范化 JSON 精确比较。
- `contains`：检查输出字符串是否包含非空字面文本。
- `exists`：所指输出字段存在；不读取原型继承字段。
- `human`：明确标为 `untested`，交给人判断。

检查不执行 shell、正则、文件读取或网络访问。最多 32 项、16 KiB；缺字段、未知操作、重复 ID 拒绝。它能证明具体声明式条件，不能证明分析正确、事实真实或外部系统动作已经发生。

## 怎么用

在既有请求信封顶层添加（`path` 从结果的 `payload.output` 开始）：

```json
"acceptance": [
  { "id": "answer", "op": "equals", "path": "/text", "expected": "42" },
  { "id": "sources", "op": "exists", "path": "/sources" },
  { "id": "expert-review", "op": "human", "description": "复核结论是否适合实际业务" }
]
```

保留原始请求文件。在 `/me` 导入后下载结果：Host 会对**实际交付的输出**运行检查，附上请求和结果 payload 的 SHA-256/JCS 指纹、逐项状态与实际 taskId/by，再使用既有 ES256 信封签名。大输出先按既有机制裁剪，再验收；原文通过不能替裁剪后的文本背书。

收到结果后可在 `/me` 选择结果文件，并选择原始请求文件复验。也可在完成 `pnpm -r build` 的仓库执行：

```sh
node scripts/verify-delivery.mjs result.json original-request.json
```

退出 0 表示原请求匹配、执行成功、全部声明式检查通过且签名没有被判无效。无签名仍会明确显示 `unsigned`；它不会建立发件人身份或权限。有人审项未测试则退出 1，绝不把“尚未检查”计为通过。

外部 Node agent 可使用公开导出 `@gotong/host/exchange` 的 `parseExchangeEnvelope`、`buildResultEnvelope`、`verifyDeliveryEvidence`。构建带证据的结果时传入完整 request 和 `{ taskId, by }` 的 provenance。该调用本身不赋予可信身份，来源仍需结合本地执行链和已知签名钥核验。

## 接收方的独立判断

`consistent` 只表示证据与产物相符；`requestMatch` 区分 matched / mismatch / not_provided。没有原始请求，即使发送方自带的所有检查都通过，也不会得到 `accepted: true`。签名与验收判定分别呈现，任何结果都不会自动升级 peer 的信任档或绕过审批。

pi/dsh 使用从 Host 源码生成的相同只读核验器与 JCS 规范化器。WorkBuddy 的 Python 标准库读取器支持严格结构校验，但不实现通用 ECMAScript 数字的 JCS 重算，明确返回 `not_checked`，需转到上述 CLI/API 完成复核。生成器：`node scripts/build-delivery-evidence-packs.mjs`（先 build host）；`--check` 检查已生成代码是否与源码一致。

这是 v1 的显式可选扩展：无字段的旧信封保持原形；旧版 fail-closed 读取器会拒绝新字段，需要更新接入包。不会静默剥掉证据来冒充兼容。

本轮同时修正公共 JCS：保留 `__proto__` 自有字段，按词法而非整数顺序排列对象键，并拒绝非有限数与孤立 Unicode 代理项。带这些特殊对象键的旧错误签名可能不再通过；不为迁就旧错误而回退验证规则。Node 接入包需与 Host 同步更新。

## 验收

`delivery-evidence.test.ts` 检查真假判定、缺失/null/原型、指纹和错误请求；`exchange-envelope.test.ts` 检查裁剪后重算和签名篡改；`me-exchange-service.test.ts` 检查真实文件归档、重启读取、用户隔离与接收方复验；`delivery-packs.test.ts` 对拍三套独立接入包；`delivery-cli.test.ts` 真正执行上述命令，验证文件级正反例与退出码；`exchange-routes.test.ts` 验证会话身份和 HTTP 参数。
