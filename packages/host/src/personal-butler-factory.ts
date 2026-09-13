/**
 * personal-butler-factory.ts — assembly of the per-user resident butler
 * (BF-M4 fold-in): the `ButlerFactory` the `LocalAgentPool` consults when it
 * spawns a `chat`-capable managed LLM row as a per-user `ButlerRouter`.
 *
 * Everything here is WIRING — which benign / governed toolsets a member's
 * butler gets, each gated on the same flag + surface-presence rules main.ts
 * established milestone by milestone (BF-M7 / BE-M1..M5 / S1..S3 / WIZ-M4c).
 * The design story for each toolset lives in its own module; the factory only
 * decides "offered or not" and composes them.
 *
 * Exists as a module (not inline in main.ts) for the GUARD-M2 line budget:
 * the factory closure was ~200 assembly lines of main.ts whose only content
 * was passing refs through (the fourth such extraction, after server-types /
 * main-cli / me-routes-types).
 *
 * The late-binding contract: most member surfaces (workflow controller,
 * observe projections, wizard, …) are constructed AFTER the agent pool in
 * main.ts, so the factory cannot capture them by value. `deps.refs()` reads
 * the CURRENT forward-declared refs at butler-build time — safe because a
 * per-user butler is built LAZILY on that member's first task, well after
 * boot. An absent ref ⇒ that toolset simply isn't offered (same graceful
 * degradation as before the extraction).
 */

import { dirname, join } from 'node:path'

import type { Hub, Logger, Participant } from '@gotong/core'
import { TwoTierToolset, type LlmProvider } from '@gotong/llm'
import { VerifiedSkills, type Embedder } from '@gotong/personal-memory'
import { buildSkillSandboxRunner, buildSkillTestApproval, skillEvaluationTask } from './personal-butler-verified-skills.js'
import {
  BUTLER_MAX_TOOL_ROUNDS,
  PersonalButlerAgent,
  buildButlerClockLabel,
  buildButlerClockProbe,
  buildButlerSessionHintProbe,
  buildMemorySheetProbe,
  composeContextProbes,
  createKnowledgeLibraryToolset,
  createTaskNotebookToolset,
  openKnowledgeLibrary,
  openLongRunDossierStore,
  openTaskNotebook,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import { butlerLongRunRoot } from './butler-space-dirs.js'

import type { AdminHealthSurface } from './admin-health.js'
import { createButlerRouter } from './butler-router.js'
import { ButlerUserActivity } from './butler-user-activity.js'
import { FileButlerUserIsolation } from './butler-user-isolation.js'
import type { HostButlerMemoryService } from './butler-memory-service.js'
import { openButlerRecallIndex, type FileBackedInvertedIndex } from './butler-recall-index.js'
import { openButlerObsidianProjector } from './butler-obsidian.js'
import type { FailureLang } from './failure-translator.js'
import type { ButlerFactory } from './local-agent-pool.js'
import type { StewardAgentDirectory, StewardWorkflowEditor } from './hub-steward-service.js'
import { buildButlerKnowledgeIndexCard } from './butler-knowledge-index.js'
import { buildButlerAskAgentToolset, type ButlerAskRosterSource } from './personal-butler-ask-agent.js'
import { buildButlerEscalateToolset, type ButlerEscalatePush } from './personal-butler-escalate.js'
import {
  buildButlerLongRunControlToolset,
  buildButlerLongRunSegmentToolset,
} from './personal-butler-longrun.js'
import {
  buildButlerBackupPackToolset,
  buildButlerBackupStatusToolset,
  type ButlerBackupOps,
} from './personal-butler-backup.js'
import { buildButlerCapabilitiesToolset } from './personal-butler-capabilities.js'
import { buildButlerConfigToolset, type ButlerConfigOps } from './personal-butler-config.js'
import { buildButlerRetentionToolset, type ButlerRetentionOps } from './personal-butler-retention.js'
import { buildButlerConsolidateToolset } from './personal-butler-consolidate.js'
import { buildButlerDailyBriefToolset } from './personal-butler-daily-brief.js'
import {
  buildButlerDiagnoseToolset,
  type ButlerOwnedAgentSource,
  type ButlerAdaptationSource,
} from './personal-butler-diagnose.js'
import { buildButlerGovernedToolset } from './personal-butler-governed.js'
import { buildButlerMcpToolsets } from './personal-butler-mcp.js'
import { classifyButlerMcpTool } from './butler-web-search.js'
import { readButlerMemoryHealth } from './butler-memory-health.js'
import { openButlerMemory } from './personal-butler-memory.js'
import {
  buildButlerObserveToolset,
  type ButlerRunSurface,
  type ButlerAgentSurface,
  type ButlerUsageSurface,
} from './personal-butler-observe.js'
import { buildButlerAskPeerToolset } from './personal-butler-ask-peer.js'
import {
  buildButlerLanguageProbe,
  buildButlerLanguageToolset,
} from './personal-butler-language.js'
import { buildButlerLastSeenProbe, readLastSeen } from './personal-butler-last-seen.js'
import { buildButlerMemoryNetProvider } from './personal-butler-memory-net.js'
import { buildButlerSourceProbe } from './personal-butler-source.js'
import { buildButlerPendingProbe, type ButlerPendingSource } from './personal-butler-pending.js'
import { buildButlerPeersToolset, type ButlerPeerSurface } from './personal-butler-peers.js'
import { buildButlerLlmsToolset, type ButlerLlmSurface } from './personal-butler-llms.js'
import { buildButlerLlmCatalogToolset } from './personal-butler-llm-catalog.js'
import { buildButlerGuideToolset } from './personal-butler-guide.js'
import {
  buildButlerHubSenseProbe,
  buildButlerHubHealthToolset,
  buildButlerRestartHistoryToolset,
} from './personal-butler-hub-sense.js'
import type { SelfHealLog } from './self-heal-log.js'
import { buildButlerPanelToolset, type ButlerPanelSurface } from './personal-butler-panel.js'
import {
  buildButlerEnvironmentToolset,
  defaultHubEnvProbe,
} from './personal-butler-environment.js'
import { buildButlerSelfStatusToolset } from './personal-butler-self-status.js'
import { buildButlerSpaceReportToolset, readSpaceLedger } from './space-ledger.js'
import { buildButlerHandsToolset, type ButlerHands } from './personal-butler-hands.js'
import {
  buildButlerOnboardingProbe,
  buildButlerOnboardingToolset,
  type ButlerOnboardingKeyCheck,
} from './personal-butler-onboarding.js'
import { buildButlerProfileToolset } from './personal-butler-profile.js'
import { buildButlerRemindersToolset } from './personal-butler-reminders.js'
import { buildButlerRunBroadcastToolset } from './personal-butler-run-broadcast.js'
import {
  buildButlerWorkflowCreateToolset,
  type ButlerWorkflowCreateSource,
} from './personal-butler-workflow-create.js'
import {
  buildButlerWorkflowWizardToolset,
  type ButlerWizardSource,
} from './personal-butler-workflow-wizard.js'
import {
  buildButlerMembersToolset,
  buildButlerMemberSurface,
  type ButlerMemberSurfaceDeps,
} from './personal-butler-members.js'
import {
  buildButlerSchedulesToolset,
  type ButlerScheduleSurface,
} from './personal-butler-schedules.js'
import {
  buildButlerWorkflowsToolset,
  type ButlerWorkflowSurface,
} from './personal-butler-workflows.js'

/**
 * The forward-declared member surfaces, snapshotted by `deps.refs()` at
 * butler-build time. Every field is explicitly `| undefined` — absence means
 * "that host capability isn't wired", and the factory drops the toolset.
 */
export interface ButlerFactoryRefs {
  /** BF-M7 — steward action executor (member-agent service). */
  governedAgents: StewardAgentDirectory | undefined
  /** BF-M7 — governed `edit_workflow` executor (needs workflowAssist). */
  workflowEditor: StewardWorkflowEditor | undefined
  /** BE-M3 — governed `create_workflow` executor (member 工作流架构师). */
  workflowCreate: ButlerWorkflowCreateSource | undefined
  /** S1-M1 — published member-facing workflow catalog. */
  workflows: ButlerWorkflowSurface | undefined
  /** BE-M1 — the three read-only "eyes" projections. */
  observeRuns: ButlerRunSurface | undefined
  observeAgents: ButlerAgentSurface | undefined
  observeUsage: ButlerUsageSurface | undefined
  /** BE-M2 — owned-agent lister + RES adaptation service. */
  diagnoseOwned: ButlerOwnedAgentSource | undefined
  diagnoseAdapt: ButlerAdaptationSource | undefined
  /** BE-M4 — owned-agent roster for `ask_my_agent`. */
  askRoster: ButlerAskRosterSource | undefined
  /**
   * DUO-M2 — best-effort member push for the escalate result (IM bridges'
   * `pushToMember`, lazy in main.ts). Absent = web-only: results stay in
   * transcript / /me; the escalate tool still works, delivery is just passive.
   */
  memberPush: ButlerEscalatePush | undefined
  /** NET-M1 — sanitized mesh roster for the `list_peers` network eye. */
  peerRoster: ButlerPeerSurface | undefined
  /** LSA-M1 — sanitized model chain for the `list_my_llms` self-awareness eye. */
  llmRoster: ButlerLlmSurface | undefined
  /** SEN-M4 — member-scoped schedules projection for `list_schedules`. */
  schedules: ButlerScheduleSurface | undefined
  /** A1 — the member's pending /me inbox, for the待办 reminder card (read-only). */
  pendingInbox: ButlerPendingSource | undefined
  /** WIZ-M4c — six-phase wizard compose service. */
  wizard: ButlerWizardSource | undefined
  /** S2-M2 — fresh-per-call distillation provider (assigned after pool start). */
  providerBuilder: (() => Promise<LlmProvider | null>) | undefined
  /** S2-M1 — the /me butler-memory privacy service (`show_my_memory` 同源). */
  memoryView: HostButlerMemoryService | undefined
}

export interface ButlerFactoryDeps {
  hub: Hub
  logger: Logger
  /** Butler memory root (`<space>/butler/memory`) — per-user namespaces live under it. */
  memoryRoot: string
  /** Shared with every router and the maintenance sweeper for this memory root. */
  userActivity?: ButlerUserActivity
  /** BF-M7 governed master switch (`GOTONG_BUTLER_GOVERNED`). */
  governedOn: boolean
  /** BF-M8 maintenance switch — gates the on-demand consolidate tool too. */
  maintenanceOn: boolean
  /** S3-M2 proactive switch — gates the `set_daily_brief` opt-in tool. */
  proactiveOn: boolean
  /** BE-M5 run-broadcast switch — gates the `set_run_broadcast` opt-in tool. */
  runBroadcastOn: boolean
  /** Read the CURRENT forward-declared refs (called at butler-build time). */
  refs: () => ButlerFactoryRefs
  /**
   * M-EMB1 — opt-in REAL semantic embedder for fusion recall. Present ⇒ each
   * per-user recall index fuses keyword + this embedder (bridges synonyms the
   * local lexical embedder can't reach). Absent ⇒ `fusion: {}` (local default,
   * byte-identical). Fail-soft: a throwing embedder degrades to keyword ranking.
   */
  embedder?: Embedder
  /**
   * M-GRAPH — opt-in associative graph mode (GOTONG_BUTLER_MEMORY_LINKS). When on,
   * each per-user butler's `recall` expands ONE hop along `meta.links` (the 6h
   * maintenance sweep writes those links). Off ⇒ no linkLookup wired ⇒ recall never
   * expands (byte-identical). The frozen block is untouched either way.
   */
  memoryLinks?: boolean
  /**
   * CARE-M4 — 开箱陪跑. When present, every per-user butler gets (a) the
   * zero-LLM context probe that injects the 现状卡 while key gaps exist and
   * `onboarding-state.json` isn't done, and (b) the benign
   * `set_onboarding_done` / `check_llm_key` tools. Both surfaces are LAZY
   * getters — adminHealth and the agent pool are built after the factory in
   * main.ts, resolved well before a butler's first task.
   */
  onboarding?: {
    stateFile: string
    health: () => AdminHealthSurface | undefined
    keyCheck: () => ButlerOnboardingKeyCheck | undefined
    lang: FailureLang
  }
  /**
   * AFR-M3 — 一刀切回单层旧形态(全部 benign 直接上脸,不折目录)。默认 undefined
   * = 两层化开(零门槛默认发:能力一件不减,只有 schema 变少)。这是构造项不是
   * env 旋钮 —— 只供测试对照与万一的回退;main.ts 不设它。
   */
  singleTierToolFace?: boolean
  /**
   * AFR-M7 — 恢复层 ops(identity 在时 main.ts 构造;缺席 ⇒ backup_status /
   * pack_backup 都不装)。打包是凭证级动作(身份档含 hub 签名钥),owner/admin
   * 判定钉在 ops.privileged —— 服务端权威,绝不信模型自报。
   */
  backupOps?: ButlerBackupOps
  /**
   * SEN-M5 — 成员名单投影源(identity 窄切片,main.ts 传两个 getter;缺席 ⇒
   * list_members 不装)。岔口 A(用户拍板):全员见「名+角色+id」;email 结构性
   * 不进投影——切片类型根本没有 email 字段,surface join 只挑声明的列。
   */
  members?: ButlerMemberSurfaceDeps
  /**
   * SDUI-M4 — 面板店面(main.ts 传 buildMePanelSurface 的同一实例——与 web
   * 路由/模板 sink 共享,per-user 串行链才真正串行)。缺席 ⇒ get_my_panel /
   * set_panel_layout 都不装。写路径带 by:'butler' 归因 = 横幅播报的数据源。
   */
  panel?: ButlerPanelSurface
  /**
   * HEAL-M1 — 自愈台账切片(main.ts 传 selfHealLog 的 recent;缺席 ⇒
   * restart_history 不装)。hub 级只读事实同 hub_health,台账无密可泄。
   * getter 只为镜像兄弟面姿态——main.ts 里它先于 factory 构造。
   */
  selfHeal?: () => Pick<SelfHealLog, 'recent'> | undefined
  /**
   * HANDS-M2 — 阿同的手(main.ts `armButlerHands` 的结果)。`host` 在 ⇒ 装五个
   * governed 工具(监狱工作区里写/读/列/删/跑);只有 status ⇒ 不装,`my_status`
   * 「手」行如实印原因。缺席 ⇒ 字节不变(hands.json 缺席 = 手不存在)。
   */
  hands?: ButlerHands
  /**
   * HANDS-M3c — 基础设置写面(main.ts 在 identity 在场时构造;缺席 ⇒
   * `set_hub_config` 不装)。四档表的 tier 2:阿同自身基础设施,**每次 park**。
   * owner/admin 判定钉在 `ops.privileged` —— 与 pack_backup 同姿态,服务端权威。
   */
  configOps?: ButlerConfigOps
  /**
   * STOR-M3 — 内容保留策略写面(main.ts 在 identity 在场时构造;缺席 ⇒
   * `set_retention` 不装)。会删成员内容的策略与端口同档:**每次 park**,
   * owner/admin 判定钉在 `ops.privileged`,写只走 retention.json 那一个咽喉。
   */
  retentionOps?: ButlerRetentionOps
  /**
   * HANDS-M4 — 空间根,**只用来 statfs 量那块盘还剩多少**(环境卡的一个数字),
   * 路径本身永不进任何输出。缺席 ⇒ 磁盘那格如实「未知」,不猜 cwd:
   * 猜错分区会给出一个看起来很确定的错数字,比诚实的「不知道」坏得多。
   */
  spaceRoot?: string
  /**
   * M-HEALTH — 记忆维护台账路径(`butler/memory-health.json`)。给了它,`my_status`
   * 的记忆行在后台维护连续出错 / 长时间没跑成时多说一句。缺席 ⇒ 不说那半句
   * (pre-M-HEALTH 调用点逐字节不变)。传路径不传 thunk:读者只有一个,让它留在
   * `butler-memory-health.ts` 里,装配层不必也认识那份 JSON 的形状。
   */
  memoryHealthFile?: string
  /**
   * STOR-M1 — 空间账本路径(`runtime/space-ledger.json`)。给了它,目录层多一件
   * `space_report` 只读工具 + `my_status` 多一行「空间」。缺席 ⇒ 都不装
   * (pre-STOR 调用点逐字节不变)。传路径不传 thunk,与 memoryHealthFile 同理:
   * 读者留在 `space-ledger.ts`,装配层不必认识账本 JSON 的形状。工具只读
   * 落盘账本、不现场丈量——丈量骑 6h 节律,归 main.ts 接的那条线管。
   */
  spaceLedgerFile?: string
  /**
   * STOR-M4 — `space_report` 尾部的提案节 thunk(`storageProposalsAt(...)`
   * 结构性满足)。缺席 ⇒ 报告与 M1 形态逐字节不变。只在 spaceLedgerFile
   * 在场时有意义(没有 space_report 这件工具,节无处可挂)。
   */
  storageProposals?: () => Promise<string>
}

/**
 * Keep this closure outside the factory: stopped routers/agents/providers/indexes
 * must not be retained by the process-lifetime disk cleanup responsibility.
 * Caches never registered in this process still need the future durable coordinator.
 */
function diskCacheRetirement(rootDir: string, userId: string, logger: Logger): () => Promise<void> {
  return async () => { await openButlerRecallIndex({ rootDir, userId, logger }).retire() }
}

export function buildButlerFactory(deps: ButlerFactoryDeps): ButlerFactory {
  const { hub, logger: log, memoryRoot } = deps
  const userActivity = deps.userActivity ?? new ButlerUserActivity(new FileButlerUserIsolation(memoryRoot))
  const indexes = new WeakMap<Participant, FileBackedInvertedIndex>()
  const cacheUsers = new Set<string>()
  // SEN-M5 — 成员 roster 无 per-user 态,工厂级构造一次全员共享。
  const membersSurface = deps.members ? buildButlerMemberSurface(deps.members) : undefined
  // M-HEALTH — 提到局部 const 才窄得住:闭包里读 `deps.x` 拿不到窄化结果。
  const memoryHealthFile = deps.memoryHealthFile
  // STOR-M1 — 同上;账本读者/工具无 per-user 态,工厂级构造一次全员共享。
  const spaceLedgerFile = deps.spaceLedgerFile
  const spaceReportToolset = spaceLedgerFile
    ? buildButlerSpaceReportToolset({
        ledger: () => readSpaceLedger(spaceLedgerFile),
        proposals: deps.storageProposals,
        logger: log,
      })
    : undefined
  return (base, mcp, extras) => {
    // S1-M2 — split the row's attached MCP (notes / calendar / …) into a benign
    // READ proxy (runs inline) and a governed WRITE toolset (parks for a /me
    // approval). Partitioned ONCE per agent (the toolset is per-agent, not
    // per-user) and captured in the closure below; both halves are stateless
    // (they just delegate to the connected `callTool`), so every per-user butler
    // reuses them. Absent MCP → both undefined → no behaviour change.
    const mcpSplit = mcp
      ? buildButlerMcpToolsets({
          tools: mcp.tools,
          callTool: (name, args) => mcp.toolset.callTool(name, args),
          // WSE — 官方搜索 server(tavily/brave)没标 readOnlyHint、名字又不含
          // read 动词,默认分级会把每次搜索都 park;这层加 server 级只读知识
          // (显式 annotations 声明的 write 仍尊重,见 classifyButlerMcpTool)。
          classifyTool: classifyButlerMcpTool,
        })
      : undefined
    return createButlerRouter({
      id: base.id,
      // The pool only consults this factory for a `chat`-capable row, so
      // `capabilities` is always set + includes 'chat'; `?? []` only satisfies
      // the optional `LlmAgentOptions.capabilities` type.
      capabilities: base.capabilities ?? [],
      logger: log,
      userActivity,
      retireForUser: (_userId, participant) => indexes.get(participant)!.retire(),
      onUserCreated: userId => {
        if (cacheUsers.has(userId)) return
        // Survives normal instance disposal without retaining the instance. The
        // finalizer phase waits for every shutdown retry that might recreate caches.
        userActivity.registerFinalizer(userId, diskCacheRetirement(memoryRoot, userId, log))
        cacheUsers.add(userId)
      },
      createForUser: (userId) => {
        // Late-bound surfaces, read NOW (first task of this member, post-boot).
        const refs = deps.refs()
        // Per-user memory namespace + recall index (whole-store inverted index,
        // active-only) — the no-leak boundary is the `<rootDir>/user/<userId>/`
        // tree itself. The base toolset the pool built (dispatch / remote MCP; the
        // row's own MCP arrives via `mcp` and is split above) moves to `benign` so
        // those tools still run inline; the governed gates below are the only path
        // that can park the task for a /me approval.
        const memory = openButlerMemory({ rootDir: memoryRoot, userId, logger: log })
        const verifiedSkills = new VerifiedSkills({ memory, userId,
          lookup: (ids) => recallIndex.lookupByIds(ids), runner: buildSkillSandboxRunner({
          buildProvider: async () => base.provider, hooks: base,
          task: () => skillEvaluationTask(base.id, userId),
        }) })
        const skillTestsGov = deps.governedOn ? buildSkillTestApproval({ skills: verifiedSkills, userId }) : undefined
        // MU-M2 — recall fuses the keyword arm with a focus-aware local embedder
        // (dependency-free, no network / key / data movement), so the on-demand
        // `recall` tool surfaces the on-topic fact FIRST instead of the newest
        // passing mention — what a weak model needs. `fusion: {}` = local default
        // embedder. M-EMB1: when `deps.embedder` is configured (opt-in env), the
        // semantic arm becomes a REAL embedder that bridges synonyms char-overlap
        // can't; unset ⇒ `fusion: {}` (byte-identical). The byte-stable frozen
        // block is untouched either way (fusion only rides the recall path).
        const recallIndex = openButlerRecallIndex({
          rootDir: memoryRoot,
          userId,
          logger: log,
          fusion: deps.embedder ? { embed: deps.embedder } : {},
        })
        // TN-M1 — the member's task notebook: cross-turn mission ledger, file
        // next to the user's jsonl (same `ownerDir` safety as STATUS.md). The
        // 4 list-editing tools are benign (same class as `set_reminder` —
        // editing your own list touches nobody else); its per-turn digest joins
        // the CARE-M4 probe below so each turn the model reads "where we are"
        // instead of holding the plan in its own context.
        // HANDS-M5 — 只读投影器(用户拍板的第 4 条岔口:md 投影层、JSON 仍是真相)。
        // 和 6h 维护那条兜底路走**同一个**工厂,两条路投出来的字节因此不可能不同。
        const obsidian = openButlerObsidianProjector({ rootDir: memoryRoot, userId, logger: log })
        const taskNotebook = openTaskNotebook({
          file: join(ownerDir(memoryRoot, { kind: 'user', id: userId }), 'tasks.json'),
          logger: log,
          // 投影跟在**真相落盘之后**,而且只往一个方向流:没有任何一条读路径会去
          // 解析那份 .md。人改了它,下次写笔记本时被改回来——这就是它的全部语义。
          onSaved: (tasks) => obsidian.projectTasks(tasks),
        })
        const taskNotebookToolset = createTaskNotebookToolset(taskNotebook)
        // LIB-M2 — the member's knowledge library (上架区): a `knowledge/` tree
        // under the SAME ownerDir. Benign by the notebook's argument (organizing
        // your own files touches nobody else); actions READ from a knowledge
        // file still hit their own governed gates. Low-frequency filing → the
        // AFR directory tier below, not the per-turn face. The handle also
        // feeds the LIB-M3 INDEX card (stableContext) below.
        const knowledgeLibrary = openKnowledgeLibrary({
          dir: join(ownerDir(memoryRoot, { kind: 'user', id: userId }), 'knowledge'),
          logger: log,
        })
        const knowledgeToolset = createKnowledgeLibraryToolset(knowledgeLibrary)
        // A2 — per-user 上次见面 timestamp for the 时段问候/间隔 card. Lives in a
        // `presence/` sibling of the memory tree (NOT under it) so the opt-in
        // memory git snapshot (MU-M5) isn't churned by a per-turn write.
        const presenceFile = join(
          ownerDir(join(dirname(memoryRoot), 'presence'), { kind: 'user', id: userId }),
          'last-seen.json',
        )
        // A3 — per-user pinned reply language (set_reply_language). Same `prefs/`
        // sibling-of-memory placement; the benign tool writes it, the probe below
        // injects "用<语言>回复" while it's set.
        const languageFile = join(
          ownerDir(join(dirname(memoryRoot), 'prefs'), { kind: 'user', id: userId }),
          'reply-language.json',
        )
        const languageToolset = buildButlerLanguageToolset({ file: languageFile, logger: log })
        // 段任务结构性跳过 contextProbe(agent.handleTask 走驱动器通道),所以接力
        // 提示得自己带钟。两处共用**同一个** label 构造器 ⇒ 同一次时区解析,
        // 「每轮的钟」与「段里的钟」结构上不可能各说各话。
        const clockLabel = buildButlerClockLabel()
        const { tools, ...rest } = base
        // BF-M7 — the per-user governed action set, scoped to THIS member (the
        // executor's RBAC keys off `userId`). Built only when the flag is on AND
        // the member-agent service exists; the workflow editor is optional (a hub
        // with no workflowAssist gets the agent tools but no `edit_workflow`).
        const steward =
          deps.governedOn && refs.governedAgents
            ? buildButlerGovernedToolset({
                userId,
                agents: refs.governedAgents,
                ...(refs.workflowEditor ? { workflowEditor: refs.workflowEditor } : {}),
              })
            : undefined
        // BE-M3 — the governed "用大白话建一个工作流" gate. A SEPARATE governed
        // toolset (create_workflow isn't a StewardAction) composed alongside the
        // steward gate; disjoint tool name, its own executor → the member service
        // (cross-hub reject + draft-never-live live there). Same governed master
        // switch; needs the member create service, else it isn't offered.
        const workflowCreateGov =
          deps.governedOn && refs.workflowCreate
            ? buildButlerWorkflowCreateToolset({
                userId,
                create: refs.workflowCreate,
                logger: log,
              })
            : undefined
        // S1-M1 — benign "run my workflow" tools (list + run), scoped to THIS
        // member. Runs one of their OWN published, member-facing workflows via the
        // same gate as /me (published + surface.me + forced userScopeField). Runs
        // inline (not governed): it's a member self-service action, and any risky
        // step INSIDE the workflow gates itself downstream. Composed alongside the
        // pool's base tools (`tools`) in the benign set.
        const workflowsToolset = refs.workflows
          ? buildButlerWorkflowsToolset({ userId, workflows: refs.workflows, hub, logger: log })
          : undefined
        // BE-M1 — benign read-only "eyes" (recent runs / helper roster / own
        // usage), each scoped to THIS member (agents is hub-wide but sanitized).
        // Composed into `benign` so they run inline; the WRITE counterparts (fix
        // an agent, create a workflow) stay governed. A tool whose surface is
        // absent is dropped from `listTools` — never offered.
        const observeToolset =
          refs.observeRuns || refs.observeAgents || refs.observeUsage
            ? buildButlerObserveToolset({
                userId,
                ...(refs.observeRuns ? { runs: refs.observeRuns } : {}),
                ...(refs.observeAgents ? { agents: refs.observeAgents } : {}),
                ...(refs.observeUsage ? { usage: refs.observeUsage } : {}),
                logger: log,
              })
            : undefined
        // BE-M2 — benign "体检我的助手": run the RES-M2 engine over THIS member's
        // owned agents. Read-only; the enactable fix is the existing governed
        // `edit_agent` (park → /me approve). Needs both the owned-agent lister and
        // the adaptation service, else the tool isn't offered.
        const diagnoseToolset =
          refs.diagnoseOwned && refs.diagnoseAdapt
            ? buildButlerDiagnoseToolset({
                userId,
                ownedAgents: refs.diagnoseOwned,
                adaptation: refs.diagnoseAdapt,
                logger: log,
              })
            : undefined
        // BE-M4 — benign "问我自己的助手": one-shot dispatch to an agent THIS member
        // owns (no-leak via listOwned), awaiting the reply. Inline (a member asking
        // their own agent), scoped by userId. Needs the owned-agent roster, else off.
        const askAgentToolset = refs.askRoster
          ? buildButlerAskAgentToolset({ userId, roster: refs.askRoster, hub, logger: log })
          : undefined
        // DUO-M2 — benign fire-and-forget escalate to the owner-configured
        // expert (`spec.escalateTo`, via extras). Needs the SAME owned-agent
        // roster as ask_my_agent (call-time no-leak gate); the push handle is
        // best-effort (absent = web-only, results land in transcript / /me).
        // Unset escalateTo ⇒ the toolset is never built ⇒ byte-identical face.
        const escalateToolset =
          extras?.escalateTo && refs.askRoster
            ? buildButlerEscalateToolset({
                userId,
                escalateTo: extras.escalateTo,
                roster: refs.askRoster,
                hub,
                ...(refs.memberPush ? { push: refs.memberPush } : {}),
                // EFF-M2 — 转派事实行落 memory 的兄弟目录(presence/prefs 同款
                // 落位理由:不进记忆树,MU-M5 git 快照不被它搅动)。
                factDir: join(dirname(memoryRoot), 'escalate'),
                logger: log,
              })
            : undefined
        // LONG-M2 — 长期任务:per-user dossier store(memory 的兄弟目录,
        // presence/prefs/escalate 同款落位理由——不进记忆树,MU-M5 git 快照
        // 不被它搅动)+ 段三件(接力提示逐字点名 = 一等)+ 控制三件(低频
        // 生命周期 = 目录长尾)+ 接力驱动器。三个消费者共享**同一个** store
        // 实例 = 同一条 per-store 串行写链;store 构造零副作用(mkdir 只在
        // create 里)。永远在(remindersToolset 同款):分段长跑是管家的地板,
        // 不是开关——没人用时盘上零字节。
        const longRunStore = openLongRunDossierStore({
          dir: ownerDir(butlerLongRunRoot(memoryRoot), { kind: 'user', id: userId }),
          now: Date.now,
          logger: log,
        })
        // M3 — the segment face carries spawn too, so it needs the dispatch
        // deps the control trio already has: child turns are self-dispatches
        // at this same butler (child lane; spend meters into the dossier).
        const longRunSegmentToolset = buildButlerLongRunSegmentToolset({
          userId,
          butlerId: base.id,
          store: longRunStore,
          hub,
          now: Date.now,
          logger: log,
        })
        const longRunPush = refs.memberPush
        const longRunControlToolset = buildButlerLongRunControlToolset({
          userId,
          butlerId: base.id,
          store: longRunStore,
          hub,
          ...(longRunPush ? { push: longRunPush } : {}),
          logger: log,
        })
        // NET-M1 — benign "看看互联了哪些 hub": org-level mesh roster, sanitized
        // (no endpoint/token/ACL detail). Read-only; the outbound ACTION arrives
        // in NET-M2 as a governed gate resolving targets against this same surface.
        const peersToolset = refs.peerRoster
          ? buildButlerPeersToolset({ peers: refs.peerRoster, logger: log })
          : undefined
        // LSA-M1 — benign "你(阿同)自己能调哪些模型": sanitized candidate chain +
        // live health. Read-only; drops out when the pool roster surface is absent.
        const llmsToolset = refs.llmRoster
          ? buildButlerLlmsToolset({ llms: refs.llmRoster, logger: log })
          : undefined
        // NET-M2 — the governed "替我问对端 hub" doorway OUT. Same governed master
        // switch as every consequential butler verb; targets resolve against the
        // SAME roster as the eye above (no drift). The dispatch rides the mesh
        // wrapper untouched, so the owner outbound gate + edge allowlists still
        // apply downstream — the butler adds a member confirmation, not a bypass.
        const askPeerGov =
          deps.governedOn && refs.peerRoster
            ? buildButlerAskPeerToolset({ userId, peers: refs.peerRoster, hub, logger: log })
            : undefined
        // AFR-M7 — 恢复层两件:benign backup_status(读上次备份事实 + 新增
        // 关系数;org-level 只读同 list_peers,全员可读)+ governed pack_backup
        // (身份档含 hub 签名钥 = 凭证级,owner/admin 之外 classify 直接拒,
        // 批准后才真打包,档案落 <space>/backups/)。identity 未接 ⇒ 都不装。
        const backupStatusToolset = deps.backupOps
          ? buildButlerBackupStatusToolset({ ops: deps.backupOps, logger: log })
          : undefined
        const backupPackGov =
          deps.governedOn && deps.backupOps
            ? buildButlerBackupPackToolset({ userId, ops: deps.backupOps, logger: log })
            : undefined
        // HANDS-M2 — governed 五工具「阿同的手」:分级是 M1 策略(服务端权威),
        // 执行在监狱工作区(userId 闭包 = 只够到本成员自己的工作区)。hands.json
        // 缺席/监狱缺席 ⇒ host 不在 ⇒ 不装;governed 总开关关着同样不装。
        //
        // `allowed(userId)` 在这里问一次是**工具面**的事(不够格的人不该看见五个
        // 永远拒绝他的工具,那既费 schema token 又像个 bug);真正的闸在 toolset
        // 内部,classify 与 execute 各问一遍——常驻管家活得比一次角色变更长,
        // 这里的判断是 spawn 那一刻的。同一个谓词,两处各管各的事。
        const handsGov =
          deps.governedOn && deps.hands?.host && deps.hands.host.allowed(userId)
            ? buildButlerHandsToolset({ userId, hands: deps.hands.host, logger: log })
            : undefined
        // HANDS-M3c — governed `set_hub_config`:配置写从「网页/命令行才行」变成
        // 手机上也走得通的两步(说要改 → park → `/approve <短码>` → 落盘)。
        //
        // 与手(HANDS-M2)刻意不同:那里工具面也问一遍 `allowed(userId)`,因为五件
        // 工具的 schema 对一个永远被拒的人是白付的 token;这里只有一件、参数是封闭
        // 枚举,省不出什么,**故工具面不问**——让 classify 的拒绝把「只对 owner/admin
        // 开放」当着人的面说出来,好过一件工具凭空不存在。闸一点没少:classify 与
        // execute 各问一遍(常驻管家活得比一次角色变更长,park 到批准也能隔几小时)。
        const configGov =
          deps.governedOn && deps.configOps
            ? buildButlerConfigToolset({ userId, ops: deps.configOps, logger: log })
            : undefined
        // STOR-M3 — governed `set_retention`:与 set_hub_config 同一形状(一件
        // 工具、封闭参数、工具面不问角色,让 classify 把「只对 owner/admin 开放」
        // 说出来);写的是 retention.json,阶梯每轮维护新读 ⇒ 批准后下一轮生效。
        const retentionGov =
          deps.governedOn && deps.retentionOps
            ? buildButlerRetentionToolset({ userId, ops: deps.retentionOps, logger: log })
            : undefined
        // SEN-M1 — benign hub 体检:骑 onboarding 的惰性 adminHealth getter
        // (与巡检/面板同一份投影,main.ts 零新接线);牌面判定复用
        // derivePatrolCards 不另写判据。hub 级只读事实同 backup_status。
        const hubHealthToolset = deps.onboarding
          ? buildButlerHubHealthToolset({ health: deps.onboarding.health, logger: log })
          : undefined
        // HANDS-M4 — benign 环境卡:机器事实 + 工具链 + 手/监狱 + 被动出网 +
        // 四个旋钮,再折出提案。`config` 借的就是 M3c 那份 ops(读写两半看同一个
        // 投影);`hands` 直接复用 boot 那次功能探针的结论,这张卡自己不判监狱。
        const environmentToolset = buildButlerEnvironmentToolset({
          ...(deps.spaceRoot ? { probe: defaultHubEnvProbe(deps.spaceRoot) } : {}),
          ...(deps.hands ? { hands: deps.hands.status } : {}),
          ...(deps.configOps ? { config: deps.configOps } : {}),
          ...(deps.onboarding ? { health: deps.onboarding.health } : {}),
          logger: log,
        })
        // HEAL-M1 — benign 重启历史:自愈台账只读投影(开机分类+看门狗记录)。
        const restartHistoryToolset = deps.selfHeal
          ? buildButlerRestartHistoryToolset({ selfHeal: deps.selfHeal, logger: log })
          : undefined
        // SEN-M4 — benign "我名下有哪些定时工作流": admin list 同源投影 filter
        // 归属本人(sweeper 就按这个 userId 走成员闸派发,自见自的行零新披露);
        // inputs/id 结构性不进投影。surface 未接(sweeper 没起)⇒ 不装。
        const schedulesToolset = refs.schedules
          ? buildButlerSchedulesToolset({ userId, schedules: refs.schedules, logger: log })
          : undefined
        // SEN-M5 — benign "hub 里有谁": 名+角色+id 目录投影(岔口 A 全员可
        // 见;assignee 断点靠 id 收口)。identity 未接 ⇒ 不装。
        const membersToolset = membersSurface
          ? buildButlerMembersToolset({ members: membersSurface, logger: log })
          : undefined
        // SDUI-M4 — benign 面板编排一对(E1 直改+三重安全网)。userId 闭包
        // = 只够到本成员自己的面板;写路径全走店面 setPanel 同一校验咽喉。
        const panelToolset = deps.panel
          ? buildButlerPanelToolset({ userId, surface: deps.panel, logger: log })
          : undefined
        // SEN-M3 — benign 自我状态一卡:大脑链/断供/累计用量/记忆规模/任务数/
        // 备份六块既有投影拼成「我现在怎么样」(零新权威点)。碎片 dep 缺席
        // 该行「(未接)」逐行降级,工具本身无条件装(笔记本永远在)。
        const selfStatusToolset = buildButlerSelfStatusToolset({
          userId,
          ...(refs.llmRoster ? { llms: refs.llmRoster } : {}),
          ...(deps.onboarding ? { health: deps.onboarding.health } : {}),
          ...(refs.observeUsage ? { usage: refs.observeUsage } : {}),
          ...(refs.memoryView ? { memory: refs.memoryView } : {}),
          notebook: taskNotebook,
          ...(deps.backupOps ? { backup: deps.backupOps } : {}),
          ...(memoryHealthFile ? { memoryHealth: () => readButlerMemoryHealth(memoryHealthFile) } : {}),
          // STOR-M1 — 「空间」行读同一份落盘账本(不现场丈量,自检是只读动作)。
          ...(spaceLedgerFile ? { space: () => readSpaceLedger(spaceLedgerFile) } : {}),
          // 「手」那一行是**说给这个成员听的**:手装在 hub 上、但没开给他的时候,
          // 印「已装,工作区里写/读/跑」就是在许一个他这边兑现不了的承诺。三种
          // 「没有」各自说各自的话——不装、总开关关着、装了但你没有。
          ...(deps.hands
            ? {
                hands: !deps.hands.host
                  ? deps.hands.status
                  : !deps.governedOn
                    ? { armed: false as const, reason: 'governed 总开关关着' }
                    : handsGov
                      ? deps.hands.status
                      : {
                          armed: false as const,
                          reason: `手装着,但没开给你——只开给 ${deps.hands.host.config.allowRoles.join('/')}`,
                        },
              }
            : {}),
          logger: log,
        })
        // WIZ-M4c — benign "帮我规划一个工作流": wizard compose, proposal-only
        // (explanation + gap checklist + validated YAML), persists nothing. Saving
        // goes through the governed create_workflow above with the proposal's YAML.
        const planWizardToolset = refs.wizard
          ? buildButlerWorkflowWizardToolset({ userId, wizard: refs.wizard, logger: log })
          : undefined
        // S2-M2 — benign "整理一下记忆": run BF-M8's per-member maintenance pass
        // (蒸馏 + STATUS.md) on demand. Gated on the SAME `butlerMaintenanceOn`
        // flag as the 6h sweep — if distillation is off, the tool isn't offered.
        // The provider is resolved fresh at call time via the pool ref; a null
        // model is a friendly refusal, not a crash.
        const consolidateToolset =
          deps.maintenanceOn && refs.providerBuilder
            ? buildButlerConsolidateToolset({
                userActivity,
                userId,
                rootDir: memoryRoot,
                buildProvider: refs.providerBuilder,
                logger: log,
              })
            : undefined
        // S3-M1 — benign "set a reminder" tool, scoped to THIS member. Dispatches to
        // the ReminderParticipant broker (registered on the same butler-on gate),
        // which parks a one-shot task with a finite resumeAt; the Phase 11 sweep
        // fires it and pushes the text back to the member's IM. Only needs `hub`
        // (static broker capability), so no forward-ref — built unconditionally.
        const remindersToolset = buildButlerRemindersToolset({ userId, hub, logger: log })
        // S3-M2 — benign "每天早上跟我说声早" tool. Writes THIS member's daily-brief
        // opt-in file; the ButlerProactiveSweeper polls it and sends. Gated on the
        // SAME `butlerProactiveOn` flag as the sweep — if the proactive feature is
        // off the tool isn't offered (writing a config that never fires would be a lie).
        const dailyBriefToolset = deps.proactiveOn
          ? buildButlerDailyBriefToolset({ userId, rootDir: memoryRoot, logger: log })
          : undefined
        // BE-M5 — benign "工作流跑完了主动告诉我" opt-in. Writes THIS member's
        // run-broadcast opt-in file; the ButlerRunBroadcastSweeper polls it and
        // pushes a notice per finished run. Gated on the SAME `butlerRunBroadcastOn`
        // flag as the sweep — if the feature is off the tool isn't offered (a config
        // that never fires would be a lie). Benign: flipping your OWN notices
        // consequences nobody else.
        const runBroadcastToolset = deps.runBroadcastOn
          ? buildButlerRunBroadcastToolset({ userId, rootDir: memoryRoot, logger: log })
          : undefined
        // S2-M1 — benign "你记得我什么": the structured memory snapshot, read
        // through the SAME HostButlerMemoryService that backs the /me privacy
        // panel (同源 — never the model improvising from the frozen block).
        const profileToolset = refs.memoryView
          ? buildButlerProfileToolset({ userId, view: refs.memoryView, logger: log })
          : undefined
        // CARE-M4 — 开箱陪跑: the done/decline marker + the read-only key
        // 活体校验. Always offered while wired (a key re-check stays useful
        // after onboarding); the injected CARD is gated per turn by the probe.
        const onboardingToolset = deps.onboarding
          ? buildButlerOnboardingToolset({
              stateFile: deps.onboarding.stateFile,
              keyCheck: deps.onboarding.keyCheck,
              lang: deps.onboarding.lang,
              logger: log,
            })
          : undefined
        // B1 — benign "你能帮我做什么" list, DERIVED from the tools actually
        // composed below (never a hard-coded lie). The getter reads the FINAL
        // benign + governed sets, assigned just after they're built — a plain
        // forward binding, resolved lazily at call time (long post-boot), so it
        // always reflects exactly what THIS member's butler has wired.
        let composedToolNames: () => Promise<readonly string[]> = async () => []
        const capabilitiesToolset = buildButlerCapabilitiesToolset({
          toolNames: () => composedToolNames(),
        })
        // LSA-M3 — benign "有没有(免费的)模型我可以加": a static curated shortlist of
        // free/low-cost OpenAI-compatible providers (signup link + get-a-key steps +
        // base URL + env var). Pure constant render, no surface/deps. The role split
        // is the whole point — 阿同 suggests, the HUMAN registers + enters the key;
        // credential WRITE stays owner+vault (the tool's own text carries the red lines).
        const llmCatalogToolset = buildButlerLlmCatalogToolset()
        // AFR-M4 — 随身向导+医生:一个 gotong_guide 工具按 topic 取策展知识卡
        // (纯常量渲染零依赖);进目录长尾 —— 说明书型低频,正是长尾的第一租户。
        const guideToolset = buildButlerGuideToolset()
        // AFR-M3 — 工具面两层化。benignFlat 保持今天的平铺全集(B1 能力清单的
        // 来源:两层化只改「schema 怎么呈现」,不改「能干什么」);上脸的 benign
        // 按 butler-tool-tiers.ts 名单把低频长尾折进 TwoTierToolset,经
        // list_tool_directory / use_tool 按需取用。动态 toolset(pool base /
        // MCP read)与被一等描述点名的工具永远留一等(名单文件逐条记了理由);
        // governed / memory 不碰 —— 风险面必须保留一等 schema。
        const benignFlat = [
          ...(tools ? [tools] : []),
          // S1-M2 — the READ half of the row's MCP servers (search notes, list
          // events, …) runs inline; the WRITE half goes into `governed` below.
          ...(mcpSplit ? [mcpSplit.readBenign] : []),
          ...(workflowsToolset ? [workflowsToolset] : []),
          ...(observeToolset ? [observeToolset] : []),
          ...(diagnoseToolset ? [diagnoseToolset] : []),
          ...(askAgentToolset ? [askAgentToolset] : []),
          ...(escalateToolset ? [escalateToolset] : []),
          longRunSegmentToolset,
          longRunControlToolset,
          ...(peersToolset ? [peersToolset] : []),
          ...(llmsToolset ? [llmsToolset] : []),
          ...(backupStatusToolset ? [backupStatusToolset] : []),
          ...(hubHealthToolset ? [hubHealthToolset] : []),
          ...(restartHistoryToolset ? [restartHistoryToolset] : []),
          ...(spaceReportToolset ? [spaceReportToolset] : []),
          ...(schedulesToolset ? [schedulesToolset] : []),
          ...(membersToolset ? [membersToolset] : []),
          ...(panelToolset ? [panelToolset] : []),
          selfStatusToolset,
          environmentToolset,
          ...(planWizardToolset ? [planWizardToolset] : []),
          ...(consolidateToolset ? [consolidateToolset] : []),
          remindersToolset,
          taskNotebookToolset,
          knowledgeToolset,
          languageToolset,
          capabilitiesToolset,
          llmCatalogToolset,
          guideToolset,
          ...(dailyBriefToolset ? [dailyBriefToolset] : []),
          ...(runBroadcastToolset ? [runBroadcastToolset] : []),
          ...(profileToolset ? [profileToolset] : []),
          ...(onboardingToolset ? [onboardingToolset] : []),
        ]
        const longTail = [
          // LONG-M2 — 控制三件折进目录(低频生命周期);段三件**刻意留一等**:
          // 接力提示逐字点名它们(AFR「指路不指空」),折进目录会指空。
          longRunControlToolset,
          ...(diagnoseToolset ? [diagnoseToolset] : []),
          ...(llmsToolset ? [llmsToolset] : []),
          ...(backupStatusToolset ? [backupStatusToolset] : []),
          ...(hubHealthToolset ? [hubHealthToolset] : []),
          ...(restartHistoryToolset ? [restartHistoryToolset] : []),
          ...(spaceReportToolset ? [spaceReportToolset] : []),
          ...(schedulesToolset ? [schedulesToolset] : []),
          ...(membersToolset ? [membersToolset] : []),
          ...(panelToolset ? [panelToolset] : []),
          selfStatusToolset,
          environmentToolset,
          knowledgeToolset,
          ...(consolidateToolset ? [consolidateToolset] : []),
          languageToolset,
          llmCatalogToolset,
          guideToolset,
          ...(dailyBriefToolset ? [dailyBriefToolset] : []),
          ...(runBroadcastToolset ? [runBroadcastToolset] : []),
          ...(profileToolset ? [profileToolset] : []),
        ]
        const longTailSet = new Set(longTail)
        const benign =
          deps.singleTierToolFace === true || longTail.length === 0
            ? benignFlat
            : [
                ...benignFlat.filter((t) => !longTailSet.has(t)),
                new TwoTierToolset({ benignLongTail: longTail }),
              ]
        // Self-contained gates: the steward action set (BF-M7) + the governed
        // create_workflow (BE-M3) + the MCP write half (S1-M2). Tool names are
        // disjoint (steward verbs vs `create_workflow` vs `<server>__<tool>`), and
        // the agent gates each call via whichever toolset governs that name.
        const governed = [
          ...(skillTestsGov ? [skillTestsGov] : []),
          ...(steward ? [steward] : []),
          ...(workflowCreateGov ? [workflowCreateGov] : []),
          ...(askPeerGov ? [askPeerGov] : []),
          ...(backupPackGov ? [backupPackGov] : []),
          ...(handsGov ? [handsGov] : []),
          ...(configGov ? [configGov] : []),
          ...(retentionGov ? [retentionGov] : []),
          ...(mcpSplit?.writeGoverned ? [mcpSplit.writeGoverned] : []),
        ]
        // B1 — now that both sets exist, point the capability getter at their
        // live tool names (includes MCP `<server>__<tool>` so connectors show up).
        // `listTools` may be async on some toolsets, so resolve them all.
        // AFR-M3:能力清单从 benignFlat(拆层前的平铺全集)派生 —— 成员问的是
        // 「能干什么」不是「schema 面长什么样」;目录里的每个名字仍真实可调
        // (经 use_tool),清单与单层时代同一份,漏报虚报都不可能。
        composedToolNames = async () => {
          const lists = await Promise.all([...benignFlat, ...governed].map((ts) => ts.listTools()))
          return lists.flat().map((t) => t.name)
        }

        const participant = new PersonalButlerAgent({
          ...rest,
          // AFTER the spread on purpose: `rest` comes from the pool's spec-derived
          // options, and `ManagedAgentSpec` carries no round cap — so this can't be
          // shadowing an operator's setting, it's filling a gap. See the constant
          // for why the butler needs more headroom than the generic default of 8.
          maxToolRounds: BUTLER_MAX_TOOL_ROUNDS,
          memory,
          verifiedSkills,
          memoryRetriever: recallIndex.retriever({ activeOnly: true }),
          // M-GRAPH — graph mode on ⇒ recall expands one hop along links the 6h
          // sweep wrote (by-id lookup over the whole-store recall index). Off ⇒
          // omitted ⇒ MemoryToolset.expand() no-ops (byte-identical recall).
          ...(deps.memoryLinks
            ? { memoryLinkLookup: (ids: readonly string[]) => recallIndex.lookupByIds(ids) }
            : {}),
          // Keep BOTH kinds in the frozen block even though BF-M8 now runs
          // consolidation (episodic→semantic) in the background: the curated
          // `semantic` profile gives durable long-term facts, but a member's
          // MOST RECENT captures (since the last 6h maintenance tick) only live
          // in `episodic` — including it means the butler remembers what it
          // heard minutes ago without waiting on the next sweep. Consolidation
          // ADDS the distilled profile on top; it doesn't replace fresh recall.
          frozenMemoryKinds: ['semantic', 'episodic'],
          // An always-on butler instance serves many independent, history-less IM
          // messages — re-recall per message so it remembers what it just captured
          // (without this the block freezes at the first message's contents and the
          // bot "forgets" mid-conversation). See MemorySession.refresh().
          frozenRefreshPerTask: true,
          captureMeta: { userId },
          // LONG-M2 — 接力驱动器:带 marker 的段任务在 handleTask/handleResume
          // 被截获走冷启动接力(渲染档案成唯一 user 消息,不重放 messages);
          // push 是 best-effort 成员通知(缺席 = web-only,结果留 transcript)。
          longRun: {
            store: longRunStore,
            now: Date.now,
            ...(longRunPush ? { push: (text: string) => longRunPush(userId, text) } : {}),
            // LONG-M4b — 工种×模型槽:pool 从行的 longRunModels 建的解析器,缺席 =
            // 两个角色都骑主链(逐字节 M2/M3)。
            ...(extras?.longRunSlots ? { slotProvider: extras.longRunSlots } : {}),
            clockLabel,
            // M6.2 — 待命唤醒的「成员开口」信号,读的就是每轮问候探针写的那份
            // presence 戳。这一点是结构性的:段任务跳过 contextProbe,所以段
            // 自己永远动不了这个戳——「成员开口」不可能被后台自己伪造出来。
            memberLastSeenMs: () => readLastSeen(presenceFile),
            logger: log,
          },
          ...(benign.length > 0 ? { benign } : {}),
          ...(governed.length > 0 ? { governed } : {}),
          // CARE-M4 probe slot, composed: the current-time card LEADS (a butler
          // must always know "now" — pure Date, zero LLM, rides the variable
          // prompt tail so the byte-stable frozen block is untouched; timezone
          // honors the deployment's `TZ`, pin `TZ=Asia/Kuala_Lumpur` for a KL
          // user), then the A2 时段问候/间隔 (greet after a real gap away), the A3
          // 语言偏好 (reply in the member's pinned language), the A4 来源渠道 (shape
          // the reply for the IM chat bubble it came from), the A1 待办提醒 (parked
          // /me approvals the member forgot), the onboarding 现状卡 (when wired),
          // then the task-notebook recitation digest. All but the clock self-gate
          // per turn (null → not injected → byte-identical prompt).
          contextProbe: composeContextProbes(
            buildButlerClockProbe({ label: clockLabel }),
            buildButlerLastSeenProbe({ file: presenceFile, logger: log }),
            buildButlerLanguageProbe({ file: languageFile, logger: log }),
            buildButlerSourceProbe(),
            // SESS — 带窗的轮子附一行「更早的对话用 recall 查」:窗让可见对话
            // 看起来像全部,不指路模型会把「不在窗里」当「没说过」。纯 payload
            // 探查,无 history=null=字节不变。
            buildButlerSessionHintProbe(),
            refs.pendingInbox
              ? buildButlerPendingProbe({ userId, pending: () => refs.pendingInbox, logger: log })
              : undefined,
            // SEN-M1 — hub 红灯意识:纯读巡检落盘的牌面(dirname(memoryRoot)
            // 推导 = <space>/butler/patrol-state.json,A2 presence 同款);无
            // 文件/损坏/陈旧/空牌面 → null → prompt 字节不变。
            buildButlerHubSenseProbe({
              stateFile: join(dirname(memoryRoot), 'patrol-state.json'),
              logger: log,
            }),
            deps.onboarding
              ? buildButlerOnboardingProbe({
                  stateFile: deps.onboarding.stateFile,
                  health: deps.onboarding.health,
                  logger: log,
                })
              : undefined,
            () => taskNotebook.digest(),
            // M2c 记忆经济 —— 记忆单:按这一问跨四个店联想,每行带出处。骑的是
            // 这条易变尾巴而不是 stableContext,因为它随**问题**变(问什么召回
            // 什么),塞进稳定段等于每轮打碎前缀缓存;冻结块与人设因此逐字节不动。
            // 召不到 / 建网失败 ⇒ null ⇒ 提示词字节不变。会话窗不在这个作用域
            // (住 im-bridge-wiring),少那一面的代价见 personal-butler-memory-net.ts。
            buildMemorySheetProbe({
              net: buildButlerMemoryNetProvider({
                userId,
                recallIndex,
                knowledge: knowledgeLibrary,
                notebook: taskNotebook,
                dossiers: longRunStore,
                logger: log,
              }),
              logger: log,
            }),
          ),
          // LIB-M3 — the INDEX card rides the STABLE segment (fork 1a): state,
          // not advice, so it refreshes on resume too and caches at 0.1× while
          // unchanged. No INDEX.md ⇒ null ⇒ byte-identical prompt.
          stableContext: buildButlerKnowledgeIndexCard({ library: knowledgeLibrary, logger: log }),
        })
        indexes.set(participant, recallIndex)
        return participant
      },
    })
  }
}
