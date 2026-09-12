# Atong User Quiescence Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans; follow the checklist and run red-green tests before implementation.

**Goal:** 方向 M。执行已批准硬删除链路的下一阶段：宿主进程内按用户拒绝新工作，排空已登记工作，再退役该用户的旧实例。

**Architecture:** 一个宿主共享 `ButlerUserActivity`，路由和维护在它登记完整异步工作，实例登记严格退休回调。`quiesce(userId)` 同步封闭用户，等待工作结束再清理资源；失败保持封闭并可重试。不增加跨进程锁或新服务，不将进程内屏障冒充可恢复的完整纠正事务。

**Tech Stack:** TypeScript ESM、现有 Participant、Promise、Vitest、现有 recall-index.retire()。

## Scope And Decisions

- 继承设计及上一轮专题的接入顺序；不是重新选择记忆架构。不恢复/回填旧记忆，不启用纠正路由。
- 继续当前 `codex/atong-temporal-memory` 分支原地开发。只合成测试，本地提交，不推送、不部署、不读取凭据。
- 排空采用等待真实 Promise 结束，不把取消通知或超时当作工作已结束。挂住时保持隔离，绝不提前清理或重新开放。
- 隔离期间已登记工作可能继续读写，必须等它们结束后才允许修改原文件。返回结果在隔离后丢弃，异常（包括暂停状态）不携旧内容向外传播。
- 只覆盖通过 router 的任务/恢复及生命周期回调、逐用户定时维护（含 Git/投影）及任务内按需整理。
  直接记忆服务、会话交付、暂停任务存储、spaceUpkeep/retention 等独立写者尚未覆盖。
- 本轮不提供 reopen；跨重启持久化屏障与最终清理成功后的新代际开放属于下一阶段。没有调用 quiesce 的生产入口。

## Task 1: User Activity And Router

Files: new `packages/host/src/butler-user-activity.ts`, new `packages/host/tests/butler-user-activity.test.ts`; modify `butler-router.ts`, add `tests/butler-router-quiescence.test.ts`.

API contract:
```ts
const activity = new ButlerUserActivity()
await activity.run(userId, async () => work())
activity.register(userId, async () => retireOwnedInstance())
await activity.quiesce(userId)
```

- [x] 写失败测试：同用户并发任务/恢复及多个 router 一起封闭，其他用户继续；封闭后不得调用 factory。
- [x] `run` 在调用工作之前同步登记，完整 await 工作后才退登记；同步 throw、异步 reject 均不漏计数。
  隔离后的结果和异常变成不含原文/路径/cause 的类型化错误 `BUTLER_USER_QUIESCED`。
- [x] `quiesce` 同步阻止新工作/资源登记；同用户并发调用共享一次排空；等待所有工作结束后调用所有资源回调。
  回调失败仍尝试其他资源，成功者不重复，失败者保留供重试；失败只抛 `BUTLER_USER_RETIRE_FAILED`，永不自动开放。
- [x] router 接收可选共享 activity；默认自建以保留独立用法；onTask/onResume 全链在 run 中，factory 和 memoization 都在屏障内。
  每个新实例登记生命周期回调：先调用实例 onShutdown，再从 map 移除；失败保留重试。不改 public Participant 类型。
- [x] 取消通知与正常 onShutdown 中的逐用户异步回调也登记；隔离退休回调直接调用实例，避免再次进入已封闭的 run。
- [x] 核验慢任务、迟到成功/失败/暂停、资源退休在排空后执行、重复 quiesce、另一用户正常、factory 异常、异常不泄露内容。
- [x] 收束正常关闭后的引用：本 router 停止接收新工作并等待自身在途工作，成功关闭的实例注销退休回调并移出 map；
  已被用户隔离接管的回调不得注销。多个 router 不相互封闭，成功 shutdown 不重复，失败保留重试。

## Task 2: Production Wiring And Maintenance

Files: `personal-butler-factory.ts`, `personal-butler-maintenance.ts`, `main.ts`, `local-agent-pool.ts`; new focused host tests for factory, maintenance and real pool shutdown wiring.

```ts
// main constructs one registry for this memoryRoot and passes the SAME object.
const butlerUserActivity = new ButlerUserActivity()
buildButlerFactory({ ...deps, userActivity: butlerUserActivity })
new ButlerMaintenanceSweeper({ ...opts, userActivity: butlerUserActivity })
```

- [x] 工厂将共享 activity 传给每个 router；不新增 env 开关。实例生命周期保留原 onShutdown 语义并严格 await recallIndex.retire()。
  正常 host shutdown 不应无故把“硬删除缓存”变成额外默认行为；若需区分，用 router 现有 options 增加仅 quiesce 调用的退休钩子。
- [x] 维护将每用户完整 maintainOne（包括写回、Git）和无模型 projectOnly 包在同一个 activity.run 中。
  不能只包模型调用，不能只 stop 定时器。默认独立使用允许自建 registry；生产明确共享。
- [x] 使用确定性延迟、合成临时存储和假 Git：隔离等待在途维护/投影/快照，不触碰另一用户，隔离后不启动新维护。
- [x] 工厂联调证明同一用户两个 agent 的旧实例/真实索引均退役，新任务不能创建第三个实例；另一用户正常。
- [x] 工厂每用户仅保留一份不捕获 agent/provider/index 的轻量磁盘缓存清理责任，正常关闭实例注销后，quiesce 仍清理缓存。
  这一责任不覆盖本进程从未登记的历史用户，未来持久化协调器不能只依赖运行实例清单。
- [x] 共享缓存收尾单独用 `registerFinalizer(userId, cleanup)` 登记：仅当全部实例资源退休成功后才执行，
  资源退休失败时不消耗收尾责任；两阶段各自成功删除、失败保留。覆盖 shutdown 重试再生成同名缓存，
  旧 index.retire 已完成而不会再次删除时，最终 fresh-index 清理仍必须使磁盘缓存消失。
- [x] 真实管理器停止接线：`LocalAgentPool.stop` 的 `hub.unregister` 不会调用 shutdown，需对品牌校验的真 butler router
  同步发起关闭、异步排空并接住失败。不能 await 在途任务，否则阿同调用停止自身会自等。
  原 service/MCP detach 行为不扩改；用真实 Pool 回归验证停止/重启/在途任务以及非 router 不受新 hook 影响。

## Task 3: Verify And Record

- [x] 聚焦红绿测试，独立规格及质量审查，修复后复核。
- [x] host 全测（4 workers），file/memory/butler 回归，全仓 typecheck、host 依赖 build、框架及四道记忆门。
  `pnpm -C packages/host exec vitest run --maxWorkers=4`；全量本地端口测试按需申请沙箱权限。
- [x] 显式路径提交代码，方向 M；更新时间记忆专题/账本/本地 CLAUDE 指针和本计划。
  如实写明进程内、登记入口和未连接的持久化/会话边界；不宣称完整硬删除启用。

## Progress

- 基线 `79e99385`，工作区干净；上一阶段 4939 项通过、5 原有跳过。本轮需独立复验，不沿用旧测试作为完成证据。
- 第一轮 Task1 17 项先红，工厂/维护 8 项先红，串行资源退休 1 项先红；主线程 36 专项通过、host 类型检查通过。
  规格复核通过基本登记路径，随后发现正常 stop/restart 的强引用保留，增加关闭排空与轻量清理责任，继续红绿验证。
- 关闭重试再次写入的判据先红；共享缓存改为最后的 finalizer 阶段，真实重建缓存最终为 ENOENT。
  两阶段及引用收束后六文件专项 59 项通过；真实 Pool 停止/直接替换的六项同样先红后绿。
- 最终 file 190 / memory 753 / butler 418 / host 3627，共 4988 项通过、5 项原有跳过；新增 49 项。
  全仓类型检查、host 依赖构建、框架与四道记忆门通过，独立规格与质量复核无剩余问题。
- 代码本地提交 `8c192e67`。未操作真实记忆，不推送或部署；后续继续持久化用户隔离及未登记入口/历史副本清理。
