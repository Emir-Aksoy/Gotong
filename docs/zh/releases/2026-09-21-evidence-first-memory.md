# 2026-09-21 证据优先记忆本地交付

方向：M。开发分支 `codex/memory-evidence-retrieval`，基线 `ae84532c`。

## 已交付

| 提交 | 内容 |
|---|---|
| `8d05d970` | 原始证据/时间呈现，默认有效性，筛选先于 top-k，历史查询 |
| `1c498f11` | 完整扫描及导出，降温与事实失效分离 |
| `516d53a0` | 有预算的跨库搜索和版本核验读取，可信用户原话写入，审批恢复保留原时间 |

行为与限制见 [ATONG-MEMORY-RETRIEVAL.md](../ATONG-MEMORY-RETRIEVAL.md)，实施清单见 [ATONG-MEMORY-UPGRADE-PLAN.md](../ATONG-MEMORY-UPGRADE-PLAN.md)。

## 验证

- `pnpm --filter @gotong/host... build` 通过；最后的预算选配调整另经 personal-memory 构建通过。
- `pnpm -r typecheck` 全工作区通过。
- personal-memory：763 项通过。
- personal-butler：428 项通过。
- service-memory-file：191 项通过。
- host：3761 项通过、5 项原有跳过；共 5143 项通过、5 项跳过。
- `pnpm check:guards` 四门通过，环境变量仍为 114 个，热点文件预算不变。
- 记忆 recall/write/integration/eviction 四项专门验收通过。
- `git diff --check` 通过。

新回归覆盖：失效种子挤掉有效记录、来源时间丢失、关联筛选绕过、500 条以外去重/预算/导出、缺全量能力拒绝维护、降温仍保持事实有效、旧来源复活、模型伪造确认、任务共享字节预算、Unicode 片段、陈旧版本拒绝、fresh 读取更新搜索缓存、审批后重建 agent 仍保留原话时间与成员绑定。

独立只读代码审查发现两项 P2：fresh 读取未更新搜索缓存、审批恢复丢失当前用户证据。均补失败回归后修复并复核关闭；审查不是对整个项目的全面安全背书。

验证过程如实记录：初次 host 全量运行被沙箱禁止本机监听（`listen EPERM`），允许本机测试端口后重跑；升级引起的旧 list 拦截和假后端缺 scan 已调整为等价行为测试。并发构建/类型检查期间另遇交换状态短暂为 running，以及家庭工作流测试清理目录 `ENOTEMPTY` 的时序失败；未修改这些无关业务代码，相关定向测试和最终无并行构建的完整 host 回归通过。

## 发布边界

本轮只完成本地开发与提交。**未合并 main、未推送 GitHub、未部署服务器**，服务器仍是此前发布版本。没有读写生产凭据、迁移/删除真实记忆或恢复暂停的纠正入口。

本地忽略的 `CLAUDE.md` 已加导航指针，未强制纳入 Git。旧事实不回填，旧 `validTo` 不自动修正。线上真实模型对记忆工具的使用效果尚未验证。
