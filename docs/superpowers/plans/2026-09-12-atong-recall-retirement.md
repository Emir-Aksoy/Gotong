# Atong Recall Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 方向 M。落实已批准硬删除链路中的检索缓存退役，防止文件纠正后从旧索引和联想网取回旧原文。

**Architecture:** 保留文件后端与当前索引，不增加外部服务。文件后端提供同 owner 队列内的轻量 watermark，经过已有 pending/代际/作用域检查；索引冷读改用完整严格快照。索引增加不可逆实例退役，先阻止返回旧结果，再等待在途持久化结束，最后严格删除受管磁盘缓存。联想网即使 TTL 命中也检查索引可用性。

**Tech Stack:** TypeScript ESM、node fs/crypto、现有 FileHandle、InvertedIndex 与 Vitest。

## 范围与不变条件

- 继承时间记忆设计及用户“不留被纠正旧版本”决定；不恢复、回填或批量迁移历史。
- 只接检索层的屏障和退役能力，不开放用户纠正入口，不宣称已清除 Git、投影、会话或在途模型请求。
- 实例退役不等于整个用户空间已隔离；最终宿主协调器必须先阻止新实例/任务，退役全部相关实例后才能改源文件。
- 文件 watermark 只读文件属性及很小的代际标记，不为每次 recall 全量读取/哈希 JSONL。不新增模型调用、环境变量或上下文预算。
- 保留既有 clear() 的非破坏性含义，新增 retire() 明确不可恢复使用；没有持久化清理能力时不得声称完整退役成功。
- 当前分支原地续接，仅合成临时文件测试；本地提交，不推送、不部署。

## Task 1: File Watermark

Files: `packages/service-memory-file/src/handle.ts`, `snapshot.ts`, `tests/watermark.test.ts`。

```ts
// Concrete file handle only, not a generic MemoryHandle capability.
await handle.watermark() // opaque string; scope/generation and file stat identity
```

- [x] 先红：稳定文件重复调用相同；写入/删除/种类/owner/代际改变时不同；pending/旧句柄/非法 scope 拒绝。
- [x] 在现有 owner 队列和 checkGeneration 后读取已配置文件属性，缺文件明确编码，非 ENOENT 错误拒绝；不读取 JSONL 正文。
- [x] 覆盖 150000 条时仍零 JSONL readFile、static symlink、I/O error、外部 config 修改隔离；包全测/typecheck/build，审查后本地提交。

## Task 2: Index Retirement

Files: `packages/host/src/butler-recall-index.ts`, small `butler-recall-index-io.ts` if separation helps, `tests/butler-recall-retirement.test.ts`。

```ts
await index.assertUsable() // guards even a caller's own TTL cache
await index.retire()       // reject new/late reads, drain refresh/persist, purge cache
```

- [x] 先红：retire during load/persist/fused retrieval，旧结果不得返回或复活；删除失败可重试且实例仍不可用。
- [x] RecallIndexIo 增加可用性检查与严格删除能力；刷新前后、异步排行返回前检查，retire 同步封闭并清空内存，等待在途持久化后清理。
- [x] real IO 使用固定 owner/config 的 MemoryFileHandle.watermark()/snapshot()，warm cache 前也过屏障，冷读不再宽松绕过损坏记录。
- [x] 持久化沿用 core 原子写并使用 0600；清理严格验证成员目录与 cache/已知临时文件为普通文件，先全量预检再删，拒绝未知相似文件和符号链接；失败不吞、不泄露原文。
- [x] 有真实缓存的纠正集成：退休旧索引→文件纠正→新索引仅召回新来源，其他用户缓存不动；无缓存时清理幂等。保留旧 keyword/fusion/clear 常规行为。

## Task 3: Memory Net Guard

Files: `packages/host/src/personal-butler-memory-net.ts`, `tests/butler-memory-net.test.ts`。

- [x] 先红：TTL 命中、重建进行中及失败回退遇到退休/屏障时不返回旧网。
- [x] 要求供给索引有 assertUsable()；每次使用前和异步建网后检查，失败即清空缓存并返回 null，阻断错误不作为普通失败回退旧网。
- [x] 正常可用时保留 TTL、并发合流和普通建网失败回退；只增加便宜检查，不每轮 allEntries/buildMemoryNet。

## Task 4: Verification And Record

- [x] 独立规格及质量审查，修复后复核。相关四包全测、全仓 typecheck、host 依赖 build、框架与四道记忆门。
- [x] 更新时间记忆专题、进展账本及本地 CLAUDE 指针；明确实例级保证与下一阶段协调器前置条件。
- [x] 显式路径本地提交，方向 M，无生产数据操作，无发布部署。

## 过程记录

- watermark 首轮 8 项通过；规格审查指出删除 generation 绑定、仅比较 size、额外直接读取正文三种变异仍绿。
  补充独立 stat 字段、generation-only、直接 readFile/open 和 EACCES 判据后，15 项通过；不修改生产逻辑来迎合判据。
- 联想网先复现 TTL/晚到建网/失败回退旧网，新增四项通过，既有八项保持通过。真实索引→纠正→新联想网联调等待 Task 2。
- Task 2 新增 40 项通过，真实联想网联调通过，三个宿主文件共 66 项通过；索引规格审查通过，质量复核进行中。
- watermark 三种变异复验均红，15 项正常用例通过，规格复核通过。全仓验证当前为 4928 通过、5 原有跳过。
- Task 1 质量复核通过，190 file 测试通过，本地提交 `2e8aaff0`。
- net 质量审查复现“已传播 guard 错误但之后检查恢复”仍返回旧网；保留原错误并复用索引访问错误分类器，
  四类错误先红后绿。net 17 项、宿主专项合计 70 项通过，最终全量与审查复验进行中。
- net 补固化“已清空缓存后普通失败不得回退”和“末次 guard 挂起时旧结果不得返回”，18 项通过，质量复核通过。
- index 最终质量审查复现 clear 后新读取加入失效旧刷新并误返回空结果；当前继续修复，不能将此前全测通过当作该并发语义已正确。
- 上述 clear 问题已补六项确定性回归并修复：新调用须等到当前 epoch 发布，重复 clear 与二次刷新退役也覆盖。
  主线程复验专项 77 项，file 190 / memory 753 / butler 418 / host 3578，共 4939 项通过、5 项原有跳过；
  全仓 typecheck、host 及依赖 build、框架门和四道记忆门通过。
- 最终只读复核无具体缺陷发现，宿主代码本地提交 `e40de2c2`；先前 file 提交 `2e8aaff0`。
  与退役重叠的已过检查读取可能在完成前交付，不承诺撤回已交付结果；没有证据显示退役完成后旧实例仍可读取。
  下一阶段从用户级隔离、多实例与后台维护排空开始，顺序已记录在时间记忆专题，尚未实现或启用。
