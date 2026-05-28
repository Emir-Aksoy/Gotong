# Code Quality

## 正向信号

- TypeScript 严格度较高: `strict: true`, `noUncheckedIndexedAccess: true`, `isolatedModules: true`。
- 测试覆盖面大: `packages/` 下约 198 个 TS 测试文件。
- 当前 Node 侧质量门通过:
  - `pnpm -r test`
  - `pnpm -r typecheck`
- Python SDK 本体测试可通过:
  - `PYTHONPATH=src .venv/bin/python -m pytest -q`
  - 结果: `57 passed`
- 安全审计痕迹较多: size guard, host/origin checks, token redaction, rate limits, CSRF / host cookie 测试等都有对应实现和测试。

## 负向信号

### 根级 Python 测试脚本失败

`pnpm test:python` 当前失败, 因为 `python-sdk/src` 没进 import path。

这不是 SDK 逻辑失败, 但它是质量门失败。对项目协作来说, "脚本能不能一键跑"和"代码本身是否能测过"一样重要。

### 测试日志噪音较大

`pnpm -r test` 中有大量故意触发的 `error` / `warn` 日志, 例如 transcript observer、scheduler persist failure、local agent auth failure 等异常路径测试。

这些日志来自通过的测试, 但会让真实失败更难在长输出中定位。建议在测试环境提供 test logger sink, 或对预期错误日志做捕获断言, 降低正常测试输出噪音。

### 大文件风险

审计中看到几个维护热点:

- `packages/web/src/server.ts`: 约 3563 行。
- `packages/web/static/admin.js`: 约 3265 行。
- `packages/core/src/space.ts`: 约 1325 行。
- `packages/host/src/main.ts`: 约 1099 行。
- `packages/host/src/local-agent-pool.ts`: 约 1101 行。

这类文件不是立即 bug, 但会提高后续安全审查、冲突解决和边界维护成本。

## 质量建议

1. 修正 `test:python`。
2. 给 dependency boundary 加自动检查:
   - protocol 不得依赖 core / llm / host / web。
   - core 不得依赖 llm / workflow / host / web。
   - workflow 不得依赖 provider 包。
3. 给测试日志加静默/捕获机制。
4. 拆 `server.ts` route groups。
5. 把 Phase 13 的 assistant 验证引入 route 层, 不让空 YAML 以成功状态流入导入路径。
