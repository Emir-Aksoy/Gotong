# Atong Correction File Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 方向 M。将已确认的“不留旧版本”规则推进到可恢复的记忆文件替换；未完成缓存/历史清理前不接自动纠正入口。

**Architecture:** 沿用 JSONL 和进程内 owner 队列，新增版本比较后的批量修改和只包含修改后文件内容的恢复记录。所有文件句柄读写检查恢复状态及持久化代际，旧句柄拒绝操作，防止旧维护任务回写。宿主只增加内部文件纠正函数，不挂 Web、模型工具或对话入口。

**Tech Stack:** TypeScript ESM, node fs/crypto, Vitest, existing snapshot/evidence helpers.

## 边界

- 不建立另一套记忆库，不改 JSONL 主文件布局，不增加 LLM 调用或环境开关。
- 只创建修改后的内容，不创建旧文件备份；恢复只能完成修改，不能恢复旧原文。
- 文件层保证同进程、同 owner 的受管句柄一致性；不承诺抵御外部进程直接修改目录或文件。
- 恢复标记最后解除，解除后不执行可能失败的 I/O。标记删除本身不承诺掉电持久化；重启重现时保守阻断并核验恢复。
- 不增加跨进程锁协议。本轮不处理直接读磁盘的索引、Git/投影、已经生成的提示词、外部备份；因此不启用真实用户纠正。
- 仅合成测试，本地提交，不推送、不部署、不读取生产数据/凭据。

## Task 1: Recoverable File Mutation

**Files:** `packages/service-memory-file/src/handle.ts`, `snapshot.ts`, `mutation.ts`, related small internal helpers if needed, `index.ts`, `tests/mutation.test.ts`.

```ts
interface MemorySnapshotMutation {
  expectedRevision: string
  remove: readonly { id: string; kind: MemoryKind }[]
  rewrite: readonly MemoryEntry[]
  append: readonly NewMemoryEntry[]
  maxEntryBytes: number
}
// Concrete file handle only, not the general MemoryHandle or an LLM tool.
handle.applySnapshotMutation(input): Promise<MemoryFileSnapshot>
handle.recoverMutation(): Promise<MemoryFileSnapshot>
```

- [x] 写失败测试：跨两个 kind 的删除/重建/新增，保留无关记录；旧 revision/未知目标/重复目标/非法 kind/超限在改盘前拒绝。
- [x] 按 owner 队列读取严格快照、检查 revision、生成新记录 id/ts、检查完整 entry 与 kind 文件上限。拒绝重复 ID，不调用 maybeTruncate 删除无关条目。
- [x] 对输入先做独立 JSON 数据复制，防止排队期间调用方改变目标。kind/owner 配置固定，不让外部对象改变作用域。
- [x] 完整读取与解析复用 snapshot 的已有严格校验，不增加宽松旁路；未改的行/种类保持原字节，路径只能从已验证 kind 得到。
- [x] 原子发布恢复记录后才写主文件。记录含 owner、种类、修改前/后指纹、修改后内容、新/旧代际，不含修改前内容。
- [x] 每个新文件使用 exclusive create、0600、写入同步和 rename；目录同步；不覆盖或跟随不明符号链接。发布前失败保持主文件原样；发布后失败保留恢复标记并拒绝所有普通读写。
- [x] `recoverMutation()` 显式恢复：先验证所有受影响文件均匹配修改前或后指纹，再统一向前完成；外部漂移/坏记录拒绝，不覆盖未知新数据。prepare-only 可安全丢弃，因为主文件尚未开始修改。
- [x] 代际文件只含随机版本号；成功修改后既有读写过的其它句柄不能静默换代。正常方法捕获一次代际，之后不匹配时拒绝；新句柄获得新代际。显式恢复属于可信宿主维护，不暴露给模型。
- [x] list/recall/snapshot/remember/patchMeta/forget/clear 都遵守恢复屏障与代际校验；不改变 list/recall 条数上限。
- [x] 失败注入覆盖发布前、首个主文件后、代际切换、清理标记；新句柄恢复；恢复重复调用幂等；恢复记录中无被删原文；旧句柄回写拒绝；其它 owner 正常。
- [x] 审查补强：事务临时文件纳入归属和恢复清理；二次删除不留先前临时后像；完整快照支持 150,000 条；after 代际下只接受 after 文件，拒绝重现标记覆盖后续写。
- [x] 运行文件包全测/typecheck；独立规格与质量审查，修复再复验。

```ts
const before = await handle.snapshot()
await handle.applySnapshotMutation({ expectedRevision: before.revision,
  remove: [{ id: old.id, kind: old.kind }], rewrite: [],
  append: [{ kind: 'semantic', text: 'corrected user statement' }], maxEntryBytes: 4096 })
await expect(staleHandle.remember(old)).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
```

## Task 2: Internal Butler File Executor

**Files:** `packages/host/src/butler-memory-correction.ts`, `packages/host/tests/butler-memory-correction.test.ts`.

- [x] 写失败测试：真实文件 capture + 多份证据容器，正确替换后旧源不在 JSONL，其他来源保持原时间和日历；另一个用户不变。
- [x] 新增 `correctButlerMemoryFiles({rootDir,userId,logger,correction,now?})`，自己从 userId 开具作用域，不接受任意调用方 plan。
- [x] 复用 `prepareEvidenceCorrection`，not_found/ambiguous 不写；任何 untraced 记录均拒绝执行，不能将不明派生内容当成已清理。
- [x] 只将当前 plan 的 remove/rewrite/replacement 交给文件批量修改；由后端在队列内重核 revision、补 id/ts 并核预算。
- [x] 返回状态 `memory_files_updated`，不使用“全部删除成功”；不记录旧原文，不增加路由/模型工具，缓存与历史清理仍是启用前置条件。
- [x] 合成测试覆盖唯一源、重复源、歧义、损坏、无来源、跨成员隔离、完整条目预算、旧 handle 回写失败。

Task 2 首轮联调 10 项通过，host 静态规格审查通过。Task 1 独立审查发现临时后像残留、
清理屏障的二次 I/O 故障和大快照参数展开上限；修复后须重跑集成，不沿用修复前全测结果。

## Task 3: Verification And Local Record

**Files:** `docs/zh/ATONG-TEMPORAL-MEMORY.md`, `docs/zh/PROGRESS-LEDGER.md`, ignored local `CLAUDE.md`.

- [x] 相关构建、四包测试、全仓类型检查、框架与记忆门通过；宿主用 `exec vitest run --maxWorkers=4` 并保留完整报告。
- [x] 如实记录文件层可执行与用户入口仍未启用的差别；不宣称索引/历史/缓存已经清理。
- [x] 显式路径本地提交，body `方向: M`；不推送、不部署。

## 收口结果

- 文件事务 `fb2e9aa4`，宿主内部执行器 `29060ddc`，均仅本地。
- 四包 4868 项通过，host 5 原有跳过；全仓类型检查、依赖构建、约束与四道记忆门通过。
- 两项独立文件审查修复后通过，宿主规格审查通过。原始失败与补测结果见时间记忆专题的文件提交验证。
- 未开放用户纠正、未读写真实记忆、未推送部署；宿主缓存/历史/上下文协调及 M3 仍待做。
