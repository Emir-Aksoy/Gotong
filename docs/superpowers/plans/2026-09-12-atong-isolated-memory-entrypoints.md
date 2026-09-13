# Atong Isolated Memory Entrypoints Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans, TDD first, independent review before completion.

**Goal:** 方向 M。将已批准的共享用户隔离覆盖到记忆面板服务、独立记忆整理与成员内容保留阶梯。

**Architecture:** 复用 `ButlerUserActivity` 和持久标记，不新增屏障或开关。服务每个完整公开操作登记，用户级资源退休后丢弃服务缓存；保留阶梯按用户登记候选读取到删除/审计结束；独立整理公开入口默认检查持久隔离，宿主调用传入共享登记器。已在 sweeper 完整登记里的实现走模块内私有函数，避免将 Git 留在登记之外。

**Tech Stack:** TypeScript ESM, existing host surfaces, FileButlerUserIsolation, Vitest synthetic files and deferred Promises.

## Boundaries

- 基线 `47623b5d`，继续当前分支原地开发。仅本地提交，不推送、部署、读取真实记忆或凭据，不操作历史备份。
- 不开放纠正或 reopen，不改变 forget/forgetAll 的现有删除范围，不把它们升级宣传为完整硬删除。
- main 创建的同一个 registry 必须在启动 spaceUpkeep 前就位，传到 service、retention ladder、factory/sweeper。
- 独立创建者默认接磁盘标记，只有显式传同一个 registry 才能相互排空；没有跨进程锁。
- 空间根/runtime 的死物清扫不进入 butler 目录，不修改它。全局只读空间丈量、transcript/identity/workflow retention、备份及会话交付不是本轮覆盖范围。
- 已进入的工作可继续到真实完成，再退休；新工作拒绝。异常不能导致尚未结束的并行读写从排空计数消失。
- 对话内的整理工具也须通过独立整理入口：对话已入场、但模型在隔离后才请求开始整理时，拒绝这个新操作。
  不扩展通用重入机制或绕过标志；已在运行的整理仍完整排空。sweeper 的私有实现不重复登记。

## Task 1: Direct Memory Service

Files: `packages/host/src/butler-memory-service.ts`; new `packages/host/tests/butler-memory-service-isolation.test.ts`.

```ts
const service = new HostButlerMemoryService({ rootDir, logger, userActivity })
await service.read(userId)
await service.export(userId)
await service.forget(userId, entryId)
await service.forgetAll(userId)
```

- [x] 新测试先红：已有持久标记时四个操作都拒绝，另一用户不受影响；不打开记忆/日记/投影。
- [x] opts 添加可选 `userActivity`，默认真实持久化 registry。四个 public 方法用 `activity.run` 包完整操作，私有实现不重复入门。
- [x] 每用户首次操作登记一次资源退休，排空后移除该用户 handles/diaries/skillFiles/statusFiles 缓存，登记集合同时收束，不触碰其他用户。
- [x] 先红：慢 export/read、forget 后投影、forgetAll 多个派生物删除期间 quiesce 等真实完成，迟到结果/异常拒绝。
- [x] `read` 的并行 Promise 必须全部结算后才抛任一错误，防止 Promise.all 提前失败漏出仍在工作的日记/状态读取；补延迟失败/成功回归。
- [x] 修正已经过时的“仅本 service 写/每句柄独立队列”注释；不扩大导出限制或修改无关投影语义。

## Task 2: Member Content Retention

Files: `packages/host/src/space-retention.ts`; new `packages/host/tests/space-retention-isolation.test.ts`.

```ts
const ladder = buildRetentionLadder({ spaceDir, logger, userActivity })
await retentionLadderOnce({ spaceDir, actionsFile, policy, liveUserIds, userActivity })
```

- [x] 先红：关闭 alice 后不访问其归档内容/Git、不删除其长任务/会话，bob 正常；真实标记在新 ladder 中仍生效。
- [x] options/deps 添加可选 `userActivity`；default 绑定 `<space>/butler/memory`，build thunk 复用自己的 registry。
- [x] 归档及长任务每用户全链在 run 内；会话按现有文件名解析得到用户后，将该用户的策略判断/删除/审计放入 run。
  顶层目录枚举与元数据候选枚举不读取记忆正文，不被当作用户内容访问。
- [x] 拒绝或活动失败沿用 `failed` 计数（文档说明含被隔离的用户处理单元），固定日志不附底层异常；后续用户继续，禁止降级无门执行。
- [x] 先红：延迟 Git/审计/删除时 quiesce 不提前完成；已有工作结束后才退休，后续同用户类别不得新启动。
- [x] 不改变安全网与先记账再删除的规则，不清除既有隔离标记，不涉及真正的硬删除历史清理。
- [x] 最终审查补真实目录回归：使用实际档案 store 与工厂的 ownerDir/butlerLongRunRoot，复现旧扫描缺 user 层。
  修正读取路径并同步旧单测与 storage 演示夹具；不兼容错误布局、不扫描其他 owner，不操作真实档案。

## Task 3: Standalone Maintenance And Host Wiring

Files: `packages/host/src/personal-butler-maintenance.ts`, `personal-butler-consolidate.ts`, `personal-butler-factory.ts`, `main.ts`; new `packages/host/tests/butler-maintenance-entry-isolation.test.ts`.

```ts
await runButlerMaintenanceOnce({ rootDir, userId, summarize, logger, userActivity })
```

- [x] 先红：独立调用发现标记即拒绝，不调用 summarize/投影；注入共享 registry 时，隔离等待正在运行的整理及其投影完成。
- [x] 导出入口只负责完整登记，现有实现移到模块私有 `maintainButlerMemory`；sweeper 已有外层登记则调用私有实现，Git 仍在同一活动内。
- [x] consolidate deps 增可选 userActivity，factory 显式传同一实例；调用完整公开整理入口，不提供 skipGuard 或可伪造已入场标志。
- [x] main 将 registry 移至 spaceUpkeep 启动前，传 retention ladder 与 HostButlerMemoryService，继续共享给原有入口。
- [x] 补真实跨入口测试：service 与 maintenance/retention 同用户一起排空、拒绝新调用，另用户正常；无模型扫投影与原本 self-stop 行为保持。

## Task 4: Validation And Local Record

- [x] 各子项红绿测试、独立规格/质量审查；发现问题补确定性回归。
- [x] host 全量四 workers，file/memory/butler 回归；全仓 typecheck、host 依赖 build、框架门、四道记忆门。
  全量 host 避免与构建竞争；上一阶段转派测试有既有时序不稳定，不伪报通过。
- [x] 显式路径本地代码提交（方向 M），专题/账本/计划与本地 CLAUDE 指针同步；明确 Git/投影/会话硬删除、交付屏障及可信纠正入口仍待做。

## Progress

- 已核对所有目标真实入口；空间死物清扫只看 root/runtime 两层，无需更改。无真实数据操作。
- service 23 项、standalone maintenance 4 项、retention 7 项先红后绿，跨三入口联合测试 1 项通过；新增共 35 项。
- 七文件聚焦 102 项、file 190 / memory 753 / butler 418 通过。全仓类型检查及 host 依赖构建通过；Task2/3 独立规格复核无具体问题，Task1/最终质量审查及宿主全量仍在进行。
- 首次宿主全量只有旧 factory 测试失败：它要求隔离后才收到的整理工具请求仍执行。明确采用新入口更严格的闭门语义，改钉不调用整理模型/投影、不生成 STATUS；不是让已在运行的整理脱离排空。
- Task1 独立规格复核通过后补齐 forgetAll 五阶段的延迟失败，共 28 项 service 专项。最终八文件 117 项通过，host 3714 通过、5 原有跳过，总计 5075 通过；本轮新增 40 项。框架及四道记忆门均通过，完整质量审查待回执。
- 最终审查发现既有长任务扫描路径与夹具少了 user 层，不能证明真实布局已被隔离。改用真实档案 store 后 6 红/1 绿；修正实际路径后转绿，并补第 8 项只处理规范 user 树的回归。保留策略两文件 60 项通过，重新运行完整验证及 storage 演示。
- 路径修复后完整重跑 file 190 / memory 753 / butler 418 / host 3715，共 5076 通过、5 原有跳过；新增 41 项。
  全仓 typecheck、host 依赖 build、框架门与四道记忆门通过，storage 演示 36 断言通过；演示首跑启动器管道 EPERM，授权后原命令通过。
- 最终独立质量复核确认真实布局缺口已关闭，两文件 60 项通过，无剩余阻塞问题。代码提交 `89d2201c`，仅本地，未触碰真实记忆。
