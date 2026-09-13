# Atong Durable User Isolation Implementation Plan

> **For agentic workers:** Use executing-plans or subagent-driven-development. Follow red-green tests and independent review.

**Goal:** 方向 M。将已批准的用户隔离延伸到宿主重启，保持未完成纠正的用户关闭。

**Architecture:** 在 memoryRoot 下、用户 Git 树外建立 `.user-isolation/<sha256(userId)>` 空目录标记。只表达关闭，不存原文、用户 ID 或纠正内容；存在即拒绝，不提供 reopen。`ButlerUserActivity` 可注入持久化接口；生产 main、独立 factory/sweeper 默认接真实存储。入场及返回检查落在已登记活动内部，隔离先同步闭门，再可靠落盘，再排空清理。

**Tech Stack:** TypeScript ESM, node fs/promises, SHA256, Vitest, existing user activity registry.

## Scope

- 延续当前分支，仅本地提交。无真实记忆读写、无迁移/回填、无 push/deploy。
- 不增加纠正公开入口；Git/投影/会话、直接记忆服务、全局 retention 等未接入者仍待后续。
- 不是跨进程锁；另一进程已运行的工作无法在本 registry 排空。只承诺重启/新实例读取屏障和共享实例内的排空。
- root 是宿主可信配置，检查 root 及控制目录的静态符号链接/类型，不承诺抵御恶意进程并发替换目录。
- 任意访问检查失败，目标用户本实例保持关闭；固定错误不保留路径、用户内容和 cause。正常开放检查只读文件元数据，不创建目录。
- 标记用独占 mkdir 建立，无半写 JSON、临时文件或旧内容。重试须重做目录同步；同步失败不清理。创建树的祖先也同步，覆盖新根目录的持久性。

## Task 1: Admission And Persistence Ordering

Files: `packages/host/src/butler-user-activity.ts`, new `packages/host/tests/butler-user-activity-durable.test.ts`.

```ts
interface ButlerUserIsolation {
  assertOpen(userId: string): Promise<void>
  close(userId: string): Promise<void>
}
const activity = new ButlerUserActivity(store)
await activity.run('alice', work)
await activity.quiesce('alice')
```

- [x] 写测试先红：入场检查等待时 quiesce 不漏计数、不启动 work；返回成功/错误/暂停前复查，关闭后不泄露旧内容。
- [x] 实现：同步登记 latch，再 await assertOpen，检查本地 closed 后调用 work；结束无论成功失败都复查，再释放 latch。无 store 时保留同步启动语义。
- [x] 持久化失败先红：close 在 cleanup 前、失败不执行 retire/finalizer、保持关闭且可重试、并发 quiesce 共享 Promise。
- [x] 实现：quiesce 同步关闭，close 成功后才等待 active 和清理；新增固定 `BUTLER_USER_ISOLATION_FAILED`，不转交底层错误。

## Task 2: Filesystem Marker And Wiring

Files: new `packages/host/src/butler-user-isolation.ts`, new `packages/host/tests/butler-user-isolation.test.ts`; modify `main.ts`, `personal-butler-factory.ts`, `personal-butler-maintenance.ts`; integration tests in new durable activity test file and existing factory/maintenance test files.

```ts
const activity = new ButlerUserActivity(new FileButlerUserIsolation(memoryRoot))
```

- [x] 先红：全新 store/registry 仍拒绝 alice、bob 正常；预存空标记也阻断；用户 ID 无路径穿越/不原样落盘；控制目录/marker symlink 和非目录 fail closed，不触碰目标。
- [x] 空目录 marker 独占建立；已有合法 marker 可重试 fsync；根和控制目录逐层校验，错误统一固定类型。正常读取无 mkdir/readdir/内容读取。
- [x] 故障注入：目录 fsync 失败后不清理，标记保留；重试实际重新 sync，重建 store 仍关闭。
- [x] 生产 main 的共享 registry 与独立 factory/sweeper 都默认使用持久化 store；裸 router 无根路径，保持显式注入语义。
- [x] 真实 router/factory/sweeper 重启回归，证明标记不是未接入的被动文件。

## Task 3: Verify And Record

- [x] 专项红绿、独立规格/质量复核；修复真实问题并补回归。
- [x] host 全量、file/memory/butler 回归、全仓 typecheck、host 依赖 build、框架及四道记忆门。
- [x] 更新专题、账本、本地 CLAUDE 指针和计划；显式路径本地提交，方向 M，明确未连接独立入口和完整纠正仍未启用。

## Progress

- 基线 `9bc7a3a3`，工作区干净。上轮 4988 测试通过、5 原有跳过，本轮重新验证。
- Task 1 八项测试先红后绿；额外微任务竞态先红，证明磁盘检查完成到 callback admission 间仍需同步复查。本轮该文件九项与旧活动/router 三文件共 39 项通过。
- factory/sweeper 三项重建实例的持久标记测试先红，接线已改，等待文件层实现后复验。未将中间验证视为阶段完成。
- 文件层空实现 34 项失败、1 项通过，实现后 35 项通过。主线程最终六文件专项 90 项通过，包含真实默认 factory 隔离后新建 factory 的拒绝与另一用户正常。
- file 190、memory 753、butler 418 通过；全仓类型检查、host 依赖构建、框架及四道记忆门通过。
- 首次 host 全量两项既有 personal-butler-escalate 测试失败（两轮 0ms 定时等待不保证异步文件完成）；该模块未经过新隔离代码，单跑 16 项通过。未修改生产或这组测试，停止并行构建后重新全跑验证。
- 最终 host 全量 3674 通过、5 原有跳过，合计 5035 通过；本轮新增 47 项。独立 Task1 审查及完整质量复核均无具体问题。
- 代码本地提交 `11ba3ee3`；专题/账本/本地指针与执行记录同步，不推送、不部署。未开展真实断电或真实模型日期评测，未删除真实记忆。
