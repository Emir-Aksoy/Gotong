# Atong Owned Git History Purge Implementation Plan

> **For agentic workers:** Use test-driven-development and independent review. Continue the approved temporal-memory design; this is one internal managed-copy cleanup step, not the full correction coordinator.

**Goal:** 方向 M。在持久隔离和共享活动排空之后，严格清除本用户自有的 Git 历史，保留当前记忆文件。

**Architecture:** 新增 host 叶模块 `butler-memory-git-purge.ts`，暴露内部 `purgeButlerMemoryGitHistory({ rootDir, userId, userActivity })`。先校验磁盘用户目录与身份精确对应，再通过真实同根登记器关闭/落盘/排空，之后预检全部 Git 树并逐文件删除/同步。没有生产调用方、路由、LLM 工具或 reopen。保留现有 best-effort snapshotter，不混用其宽松路径判断。

**Tech Stack:** TypeScript ESM, Node fs/promises, ButlerUserActivity, FileButlerUserIsolation, ownerDir, Vitest, synthetic real Git repositories.

## Scope And Safety

- 基线 `c9d74453`，沿用当前 `codex/atong-temporal-memory` 分支。只本地提交，不推送、部署或读取真实凭据/记忆；不动历史备份。
- 已批准硬删除不保留旧版本。本步骤删除整个用户自有 `.git` 历史，不改当前 JSONL、知识文件、其他用户、项目仓库或外部备份。
- 磁盘标记先可靠落盘，才允许退休资源；共享排空必须真正完成。函数只能由未来可信协调器在目标用户活动外调用，不能从其自己的工具/退休回调中等待。
- 不是跨进程锁；调用方须保证其他进程没有写者。调用同路径但不共享登记器不能排空其他实例。绝不根据 stop 返回值宣称排空完成。
- 从配置根到 user/id/.git 均做静态 lstat 检查，拒绝符号链接、非目录 Git 入口、硬链接文件、特殊文件、跨设备树。
- 已存在 user/id/.git 名称必须在父目录 readdir 中原样出现，拒绝大小写和 Unicode 等价路径别名；用户目录检查在 quiesce 之前，防退休回调先碰错目录，删除前重检。可信祖先允许系统别名，配置根不接受链接。只有 ENOENT 算缺失，目录读取失败拒绝。
- `FileButlerUserIsolation.isForRoot` 只按 resolve 后的配置根严格比较；`ButlerUserActivity.quiesceMemoryRoot` 拒绝裸/错根登记器，再用现有 quiesce 保证同步闭门和先持久化后退休。每次清理前再次同步标记，不能只凭 quiesce 的缓存成功。无需另造登记器或传可伪造的 bypass 标志。
- `.git` 内已知共享布局 `commondir`、`gitdir`、`worktrees`、`modules`、`objects/info/alternates`、`objects/info/http-alternates` 一旦存在就拒绝；不跟随到外部目录。不执行 Git 命令或钩子，不依赖环境变量/仓库配置来决定删除位置。
- 预检整棵树后才开始删；100000 节点和 64 层深度硬限防无界遍历。删除中途失败不回滚原文，保留隔离，重试可清理不完整仓库。不会因缺 HEAD/config 等认不出半删树。
- 自底向上逐文件/空目录删除并同步，最后同步用户目录、确认 `.git` 不存在；缺失时仍同步最近存在的受控目录，以覆盖上次删完但同步失败的重试。错误只含固定代码，不保留路径/原文/cause。
- 外部克隆/备份、不可识别的外部引用、介质安全擦除不在承诺内；不解析 config/core.worktree/配置包含文件，不证明 Git 仓库独占所有权。外部项目若反向引用这个 .git，清理可能使其失效；不能承诺外部项目必然不受影响。只声称本受管路径内逻辑删除并同步，不声称完整用户硬删除。

## Task 1: Contract And Failing Tests

Files: new `packages/host/tests/butler-memory-git-purge.test.ts`.

```ts
const userActivity = new ButlerUserActivity(new FileButlerUserIsolation(rootDir))
await purgeButlerMemoryGitHistory({ rootDir, userId: 'alice', userActivity })
await expect(fs.lstat(ownerDir(rootDir, { kind: 'user', id: 'alice' }) + '/.git'))
  .rejects.toMatchObject({ code: 'ENOENT' })
```

- [x] 先红：真实两代快照（含打包对象）、重复调用、没有历史、当前文件/其他用户/祖先 Git 保留。
- [x] 先红：共享慢任务、资源退休/最终清理阻塞时不动历史，隔离失败/退休失败不删；新实例仍拒绝且另一用户可用。
- [x] 先红：根/owner 层/用户/.git/树内链接，gitfile、共享布局、硬链接、特殊文件、深度/节点上限，全预检拒绝零 Git 文件删除。
- [x] 先红：unlink/rmdir/fsync 故障后重试，错误无路径/原文/cause；并发两次同用户清理不互相误报或提前完成。

## Task 2: Internal Filesystem Operation

Files: new `packages/host/src/butler-memory-git-purge.ts`.

Also modify `packages/host/src/butler-user-isolation.ts` and `packages/host/src/butler-user-activity.ts` for the concrete same-root quiescence precondition; their existing ordinary admission/quiescence behavior is unchanged.

```ts
export interface ButlerMemoryGitPurgeOptions {
  rootDir: string
  userId: string
  userActivity: ButlerUserActivity
}
export async function purgeButlerMemoryGitHistory(opts: ButlerMemoryGitPurgeOptions): Promise<void>
```

- [x] 复用 ownerDir 校验与真实隔离器；固定错误类，所有底层异常脱离原文。
- [x] 同路径调用合流/串行；各调用仍等待自己的共享登记器排空，不能拿别的实例的排空当自己的许可。
- [x] 磁盘操作先严格预检所有元数据，后按完整清单逐项删除；不执行 Git，不递归 force 删除，不读取文件正文。
- [x] 同步失败可重试，检查缺失路径不偷偷创建 Git 或解除隔离；所有 Task1 测试转绿。

## Task 3: Verification And Record

- [x] 独立规格和质量复核，发现具体缺陷先补回归再修。
- [x] host 全量（四 workers）及 file/memory/butler 回归；全仓 typecheck、host 依赖 build、框架门、四道记忆门。
- [x] 精确路径代码提交（方向 M），专题/账本/本地 CLAUDE 指针和本计划同步。下一步仍为投影/会话清理和可恢复协调，不开放完整纠正。

## Progress

- 已核对批准设计、共享隔离/排空、既有 Git snapshotter 与索引删除惯例；工作树干净。旧 snapshotter 的 gitfile/symlink 识别不适合作为硬删除授权，故不复用。
- 初始 35 项红测确认缺少删除/隔离/拒绝行为（无操作函数契约桩）；先修复夹具漏括号再跑，语法错误不计红测证据。补根绑定与身份别名 4 项均先红。真实任务等待夹具改为等 quiesce 明确信号，而不是假定一个事件循环就已完成路径检查。
- 独立规格复核发现大小写/Unicode 路径别名可关闭错身份；已加入先于退休的精确目录核对。同时明确根绑定 quiesce，拒绝裸/错根 registry；审查确认修订方案可覆盖这两项边界。
- 四文件专项 105 项通过；继续补齐真正的部分 unlink、Git 目录同步失败、父目录缺失后同步与缓存 quiesce 后再同步失败。当前新专项 44 项通过；WORKTREES 大小写变体先红后绿。正在进行最终规格复核和完整回归。
- 独立规格和质量复核均通过，新专项独立复跑 44 项通过；文档点名 config/core.worktree 与外部反向引用不在独占性证明内。
- 首次 host 全量遇到既有 WorkBuddy oversize Python 子进程阻塞超过三分钟；确认 PID/父子关系后只终止该测试子进程，框架以 1 失败/3758 通过/5 跳过收尾。该测试不调用新清理代码，单独重跑 30 项通过；未修改此模块，未声称定位或修复偶发阻塞根因。正在完整重跑。
- 完整重跑 3759 通过/5 原有跳过，正常退出；file 190 / memory 753 / butler 418 合计 5120 通过。全仓 typecheck、host 依赖 build、框架门和四道记忆门通过。
- 代码本地提交 `88371bc8`；专题、账本、计划及本地 CLAUDE 指针同步。没有真实数据操作、推送或部署，未开放用户纠正/解封。
