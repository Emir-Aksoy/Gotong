# v4 Phase 19 / P3 — 生产级安全与运维收口（FINAL）

> 把「能跑的系统」推到「能上线运维的系统」：业务指标能从 `/metrics` 看见、
> 备份能一键证明可恢复、对外宣称的安全/分发渠道跟现实一致（不再挂占位符）。
>
> 三个里程碑 + 一个收口文档，纯本地 `main`，**未 push**。
>
> Last updated: 2026-06-01

---

## 一、缺口（开工前已用真代码核实）

- **指标只有基础设施层**：`metrics.ts renderMetrics()` 现有 8 条 series
  （protocol / participants / tasks / pending_apps / service_calls + duration
  histogram + http_responses），全是 hub 进程自省，**没有一条业务指标** —— admin
  看不到「跑了多少 workflow run / 多少 task 挂起 / LLM 烧了多少 token·成本」。
- **备份脚本齐但无自动验证**：`scripts/backup/{backup,restore,verify}.sh` +
  `drill-init.example.mjs` 种子都在，但 **没有一个测试证明这条链真能往返** ——
  一个坏 tar flag 或过严的 verify 检查，只会在真灾难恢复时（最糟的时刻）才暴露。
- **文档挂着不存在的渠道**：`security@aipehub.dev` 是占位符（域名没注册、邮箱没激活），
  却在 SECURITY.md 里以「Backup — email」的形式呈现成可用后备；`security.txt` 还有
  一行 `Contact: mailto:` 指向这个死信箱，会误导自动扫描器。分发渠道（Docker+source
  为主，binary/npm 状态）、supported-versions 文案也悬而未决。
- **GitHub push 暂停** → 发布渠道的活只能落到 checklist 与文档诚实化，不真发布。

---

## 二、各里程碑

### P3-M1 — Prometheus 业务指标（`117294e`）

**纯读现有状态，不加表、不加写路径。** web 保持零运行时依赖：采集与渲染分离。

- 新 `packages/web/src/business-metrics.ts` —— `collectBusinessMetrics(sources)`
  异步采集器，从 host 注入的窄鸭子接口（`MetricsWorkflowSource.listRuns` /
  `MetricsIdentitySource.countSuspendedTasks?` / `aggregateLedger?`）取数：
  - workflow run 按 status 计数（seed 四个零值 running/done/failed/cancelled），
    run-file 扫描 **封顶 `RUN_SCAN_CAP=2000`** + `workflowRunsCapped` 标志（10 万+
    run 的 host 不会让 `/metrics` 变慢，且诚实告诉 dashboard「这是抽样」）
  - 挂起任务数 `countSuspendedTasks()`（identity 同步 better-sqlite3，`COUNT(*)`）
  - LLM 用量 `aggregateLedger({groupBy:'model'})` → 4 类 token 求和 + 成本
  - **best-effort 逐族**：host 没接的 source / 老 host 缺的方法 / 抛错的调用 → 该族
    静默省略，hub 自省指标照常渲染。`/metrics` 抓取**永不**因为某个计数器读不到而 500。
- `metrics.ts` 扩 `BusinessMetrics` 类型 + `renderBusinessMetrics(w,b)`（纯同步格式化），
  emit 6 条新 series：
  - `aipehub_workflow_runs{status}`        gauge
  - `aipehub_workflow_runs_scan_capped`    gauge（1 = 抽样而非全量）
  - `aipehub_suspended_tasks`              gauge
  - `aipehub_llm_calls_total{model}`       counter
  - `aipehub_llm_tokens_total{model}`      counter
  - `aipehub_llm_cost_micros_total{model}` counter（整数 micro-USD，1e6=$1）
- identity 加 `SuspendedTaskStore.countSuspendedTasks()`（数全部 parked 行，含
  `NEVER_RESUME_AT` 的 inbox/审批挂起）+ facade 透传。
- `/metrics` handler 先 `await collectBusinessMetrics(...)`（`.catch(()=>({}))` 兜底）
  再 `renderMetrics(hub, {httpStats, business})`。
- **测**：web +6（render 三族 / 缺失即省略 / capped+空账本 / 采集器 tally+map+suspended /
  逐族抛错隔离 / 空 sources）；identity +1（count 0→2 含永不恢复行→replace 不变→remove）。

### P3-M2 — restore smoke（`d1171fd`，测试即交付物）

把 `docs/OPERATIONS.md` 的灾难恢复 runbook 写成可执行测试：
`packages/host/tests/backup-restore-smoke.test.ts`。

- **种子**：`Space.init` + provider key + 2 agent（writer/reviewer）+ worker（mirror
  `drill-init.example.mjs`），首次写 secret 时懒生成 `runtime/secret.key`（跟真部署一致）。
- **链路**（全经 `child_process` 跑真 bash 脚本，**不改脚本**）：
  1. `backup.sh` 打包 → `tar -tzf` 断言归档里**没有** master key（泄露的备份不能 = 满盘皆输）
     但**有** `secrets.enc.json`
  2. `restore.sh` 解包 + 内部跑 `verify.sh`；断言输出含 verify 的 `0 errors` 标记
     （证明这步真跑了，不只是 restore 退 0）
  3. 结构不变量：space.json / admins.json / agents.json 在；`secrets.enc.json` 在；
     `runtime/secret.key` **不在**
- **boot 恢复后的 space**：`Space.open` + `Hub` + `serveWeb` →
  - `/healthz` → 200
  - `Space.init` 留下的 v3 admin token 仍能认证（admins.json 存的是 hash，往返后照旧）
  - 两个种子 agent 完整穿过 → `GET /api/admin/agents` 返 `[reviewer, writer]`
- 两条不变量钉死：**加密 secrets 随备份走、master key 不走**（host boot 懒生成新 key，
  旧加密 secrets 故意不可恢复）；**admin token 经往返仍有效**。
- 确定性：无网络、无 LLM、~90ms in-process。bash/tar/jq 缺失（Windows 无 bash）则 skip。
- **测**：host +3。

### P3-M3 — 安全/分发文档诚实化（`35fe949`，doc-only 决策点）

决策点已与维护者预先拍板，本里程碑把决定落进文档，**不再用占位符冒充可用渠道**。

- **安全联系方式**：GitHub Private Vulnerability Reporting 是 pre-1.0 **唯一**渠道，
  **不设邮箱**。`security@aipehub.dev` 域名没注册、邮箱没激活，挂成「Backup — email」
  会让报告者把真漏洞托付给一个死信箱。
  - `SECURITY.md`：「Backup — email」→「No email channel (pre-1.0)」，直说没有邮箱、
    advisory 唯一，并给「实在用不了 GitHub」的逃生口（开一个**不含**漏洞细节的
    Discussion 请维护者私下联系）。
  - `.well-known/security.txt`：**删掉** `Contact: mailto:` 行 —— security.txt 指向死
    信箱比没有更糟（扫描器会去发那个死邮箱）；注释说明原因。
- **分发**：Docker + source 是主（且唯一*受支持*）路径；JS registry / PyPI / 预编译
  binary 留作 post-1.0 选项，任一可无限期「不做」而不阻塞发布。
- **supported-versions**：仅 `main`、无 LTS —— 本就是 SECURITY.md 既定政策，现记录成
  决定而非待解问题。
- `RELEASE-CHECKLIST.md`：三个决定都带日期记录，邮箱项降为可选 post-1.0 跟进，
  supported-versions 项打勾，分发重申，复审日期更新到 2026-06-01。

---

## 三、关键设计决策（横切）

1. **采集 / 渲染分离，web 维持零依赖**：`business-metrics.ts`（异步采集，从 host
   surface 取数）与 `metrics.ts`（同步格式化）分两文件，`BusinessMetrics` 类型住在
   渲染侧、采集侧单向 import（无环）。host 注入的是结构满足的窄鸭子接口，web 不 import
   `@aipehub/workflow` / `@aipehub/identity`。
2. **指标 best-effort + 永不 500**：`/metrics` 是运维生命线，一个读不到的计数器不能
   掀翻整个抓取。逐族 try/catch、缺即省略，是「可观测性自身要高可用」的体现。
3. **扫描封顶 + 诚实标志优于静默截断**：run-file 扫描封 2000 并 emit
   `workflow_runs_scan_capped`，而不是悄悄只数前 N 条 —— 跟 CLAUDE.md「no silent caps」
   一致，dashboard 知道这是抽样。
4. **测试即交付物**：P3-M2 没有「产物」可交，restore smoke **本身**就是交付物 ——
   把 prose runbook 变成一道会变红的闸；脚本是被测对象，测试绝不碰它们。
5. **诚实 > 占位符**：宁可文档写「现在没有这个渠道」，也不挂一个不存在的邮箱/域名
   让人误信。security.txt 的死 `mailto:` 比缺失更有害，所以直接删。
6. **决策落进 checklist 带日期**：每个 1.0 前的待定项要么打勾要么记成「Decided
   YYYY-MM-DD」，让 `RELEASE-CHECKLIST.md` 始终是「还差什么」的诚实清单。

---

## 四、测试矩阵（+10，零回归）

| 包 | 新增 | 总数 |
|---|---|---|
| web | +6（metrics render 三族 / 省略 / capped / 采集器 / 逐族隔离 / 空 sources） | 530 |
| identity | +1（countSuspendedTasks 生命周期） | 308 |
| host | +3（backup→restore→verify→boot 往返） | 428 |
| 文档 | P3-M3 doc-only，无测试 | — |

`pnpm -C packages/{web,identity,host} test` 全绿。

---

## 五、运维须知

- **`/metrics` 仍 admin-gated**：业务指标经现有 `/metrics` handler 出，鉴权不变；
  Prometheus 抓取需带 admin 凭证（见 `docs/MONITORING.md`）。
- **成本指标是 micro-USD 整数**：`aipehub_llm_cost_micros_total` 除以 1e6 得美元；
  PromQL 里直接 `/ 1e6`。未定价模型在账本里记 `unpriced`（成本 0），仍计 calls/tokens。
- **run 扫描封顶 2000**：超过会 emit `aipehub_workflow_runs_scan_capped 1`，此时
  `aipehub_workflow_runs{status}` 是抽样下界而非精确值 —— 大 host 想要精确计数得另接
  RunStore 聚合（本期未做，显式推迟）。
- **灾难恢复**：restore 后的 space **缺 `runtime/secret.key`**（备份故意排除）。host
  首启会懒生成一把新 key，但旧 `secrets.enc.json` 里的 provider key **解不开** ——
  恢复加密凭证必须**单独**把原 `secret.key`（或 `AIPE_SECRET_KEY`）放回去。这正是
  smoke 测试钉死的不变量。
- **安全报告**：只走
  `https://github.com/Emir-Aksoy/AipeHub/security/advisories/new`。没有邮箱。

---

## 六、显式推迟（保持精简）

- `aipehub_upload_bytes_total`（plan 列过）—— 需要 web handler 走文件系统统计 uploads
  目录，当前 handler 没有这条路径；要做得给 host 加一个上传用量 surface。
- workflow run 精确计数（去掉 2000 封顶）—— 需 RunStore 出一个 `countByStatus` 聚合，
  避免逐文件扫。
- `/metrics` 的 per-user / per-org 维度拆分 —— 账本有归因列，但 Prometheus 高基数标签
  要克制，留到真有需求再加。
- 真安全邮箱 / PGP / 自定义域名 —— 全是 post-1.0 选项，`RELEASE-CHECKLIST.md` 跟踪。
- 真发布（npm/JSR/PyPI/binary）—— GitHub push 暂停期不做。

---

## 七、验收对照

| 验收门 | 状态 |
|---|---|
| admin 能从指标看到 workflow run / suspended / LLM calls·tokens·成本 | ✓ 6 条新 series |
| restore smoke 一键证明「备份能恢复成可用系统」 | ✓ host 往返测试（含 boot + admin 鉴权 + agents 完整） |
| 对外宣称的安全/分发渠道跟现实一致，无占位符冒充 | ✓ SECURITY.md / security.txt / RELEASE-CHECKLIST 诚实化 |
| 全链路零回归 | ✓ web 530 / identity 308 / host 428 |

---

**P3 commits**：`117294e`（M1）→ `d1171fd`（M2）→ `35fe949`（M3）→ 本文档（M4）。
