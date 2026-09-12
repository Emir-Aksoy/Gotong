# Atong Correction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 方向 M。为用户明确纠正建立完整读取与按来源替换的底座，不将计算成功误报成磁盘硬删除完成。

**Architecture:** 文件后端提供受同一进程 owner 写队列保护的完整严格快照。记忆引擎提供无 I/O 的纠正计划计算器，只接受调用方已鉴权的用户作用域、精确旧原话和新用户证据；识别全部结构化副本，保留共享容器内无关来源，不保留被纠正原文。此阶段不接模型工具或对话入口。

**Tech Stack:** TypeScript ESM, node:fs/promises, node:crypto, Vitest.

## 已确认的产品规则

- 明确纠正且唯一定位时直接替换，不额外审批；目标含糊才询问。
- 被纠正内容硬删除，不使用 validTo/supersedes 留原文历史。
- 不按相似度删除，不迁移/回填历史，不清空无关记忆。
- 仅计算计划不构成授权，不代表索引、快照或磁盘已经删除。
- 用户于本轮选择“不保留前面的”，覆盖旧设计中纠正保留原记录的设想。

## Task 1: Strict Whole-Owner Snapshot

**Files:** `packages/service-memory-file/src/handle.ts`, `snapshot.ts`, `index.ts`, `tests/snapshot.test.ts`.

- [x] 测试先行：超过 500 / 1000 / 10000 条仍完整；kind/owner 隔离；空目录；损坏 JSON、形状错误、读失败均拒绝而不是忽略；同 owner 排队写入先于快照。
- [x] 新增 `MemoryFileHandle.snapshot(): Promise<MemoryFileSnapshot>`，返回 `{ entries, revision }`。内部用既有 `serializeWrite` 调用严格读取器。
- [x] `revision` 用规范化 kind 集合和文件原字节的 SHA-256 指纹；不是跨进程事务，也不授权后来用过期快照删除。
- [x] 保持 `list()` 和 recall 的交互式上限不变；本轮不宣称旧预算/导出调用已经全量化。
- [x] 运行 `pnpm -C packages/service-memory-file exec vitest run tests/snapshot.test.ts`，再全包测试和类型检查。

规格/质量审查完成：同配置比较 missing/empty 指纹；构造时复制 owner，三条回归先红后绿，阻塞 Bob 队列也无法通过 Alice 句柄读 Bob。快照 46 项、全包 120 项通过。

```ts
const snapshot = await handle.snapshot()
expect(snapshot.entries).toHaveLength(10001)
expect(snapshot.entries.some(e => e.id === 'oldest')).toBe(true)
```

## Task 2: Pure Evidence Replacement Plan

**Files:** `packages/personal-memory/src/correction.ts`, `evidence.ts`, `errors.ts`, `index.ts`, `tests/correction.test.ts`, `tests/evidence.test.ts`.

- [x] 测试先行：精确原话唯一匹配；相同来源多容器不算歧义；不同来源同一句话必须澄清；显式 sourceId 可消歧但仍核对原话。
- [x] 新证据含新的 sourceId、原始用户正文与当前纠正轮的可信时间锚；拒绝复用已有 ID、跨作用域、非法/缺失时间、超预算。
- [x] 所有结构化副本中剔除目标来源；无剩余来源的容器删除，有剩余来源的容器重新打包。重建受影响容器元数据，不把旧摘要标签、步骤、反例或自由文本带入结果。
- [x] 新用户证据单独打包为 semantic；无关来源的原文、来源 ID、日历范围和告知时间不变；输入对象不变。
- [x] 来源冲突或损坏证据 fail-closed；返回值只包含删除 ID、重建记录和新记录，不包含旧原话或 supersession 历史。无关旧无结构记忆不猜测来源、不擅自删除。
- [x] 运行定向测试、personal-memory 全包测试与类型检查；独立规格/质量审查后修复问题。

审查补测先红后绿：合法助手-only时间记录归 untraced；packed/raw表示互斥；`complete` 存在时必须严格为 true，
非法标记在共享证据读取器拒绝；重建容器保持原 kind，补回 id/ts 后再次计算完整 UTF-8 大小。
新条目仍为 NewMemoryEntry 载荷，未来执行器生成 id/ts 后必须再验完整预算。纠正 45 项、证据读取 20 项通过。

```ts
const plan = prepareEvidenceCorrection(entries, {
  userId: 'alice', target: { quote: 'I ate barbecue yesterday' },
  replacement: { sourceId: 'new-turn', text: 'I ate barbecue on 2026-08-29',
    temporal: { v: 1, observedAt: 1789171200000, timeZone: 'UTC', basis: 'turn-start' } },
  maxEntryBytes: 4096,
})
expect(JSON.stringify(plan)).not.toContain('I ate barbecue yesterday')
```

## Task 3: Local Verification And Handoff

**Files:** `packages/host/src/personal-butler-memory.ts`, `packages/host/tests/butler-correction-foundation.test.ts`, `docs/zh/ATONG-TEMPORAL-MEMORY.md`, `docs/zh/PROGRESS-LEDGER.md`, ignored local `CLAUDE.md`.

- [x] 宿主开库函数显露已有具体文件句柄的 snapshot 能力；合成万条记录验证快照能定位 list 上限之外的旧来源、读取不跨用户、计算不修改磁盘。
- [x] 记录实测结果与能力边界，明确尚未启用用户纠正、未删除真实历史。
- [x] 运行相关构建、全仓类型检查、`pnpm check:guards` 与 `git diff --check`。
- [x] 显式路径暂存并本地提交，body 含 `方向: M`，不推送、不部署。代码提交：`2d660145`。

最终验证：file 120 / memory 753 / butler 418 / host 3512，通过 4803 项、5 项既有跳过；全仓类型检查、相关构建、约束门、记忆写侧/召回/集成门通过。首次宿主子进程意外退出未计通过，Web Push 9 项独立通过，随后两次完整宿主通过；未定位退出根因，不改无关代码。

## 后续接线验收边界（不属于本底座提交）

下一阶段必须在启用入口前完成：持久化版本比较和并发写屏障；中断恢复且不得重放旧明文；磁盘索引及存活 agent 缓存失效；投影重建；含旧原文的用户内 Git 历史处理；会话窗刷新和纠正轮捕获去旧文；从可信成员上下文取得用户纠正意图。无来源的派生技能/历史摘要不能宣称已精确清除。外部备份和 OS 快照不在应用可控删除范围；不得触碰 `~/Backups/AipeHub/`。
