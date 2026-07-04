/* Gotong web UI — shared core (v2.0).
 *
 * "File-first" mindset extends to the browser: NO localStorage, NO
 * sessionStorage. The only state the browser keeps is HttpOnly cookies
 * set by the server (admin / worker session pointers, opaque to JS) — plus
 * one small NON-HttpOnly `lang` cookie this engine writes when the user
 * toggles language (see below). Everything else round-trips to the server.
 *
 * Language precedence (REL-9): explicit `lang` cookie (a prior toggle) >
 * navigator.language (first-visit seed) > server /api/state.config.defaultLang
 * (operator fallback) > 'zh'. The cookie persists the choice across reloads
 * AND is honored by the standalone invite/offline pages (which read the same
 * cookie without loading this engine), so a member's language choice follows
 * them everywhere. Precedence is resolved entirely client-side — there is no
 * SSR, so the client is the rendering authority and a server-side cookie read
 * would be redundant.
 */
(() => {
  const I18N = {
    zh: {
      subtitle: '通信空间',
      connecting: '连接中…',
      connected: '已连接',
      reconnecting: '重连中…',
      unreachable: '无法连接服务器',
      langButton: 'EN',
      langTitle: 'Switch to English',
      workerBadge: '工人',
      logout: '退出',
      switchToWorker: '→ 工作台',
      switchToAdmin: '→ 管理员',
      participants: '当前在场',
      noParticipants: '当前没人',
      noCaps: '无能力',
      load: '负载',
      pKind: { agent: '代理', human: '人类' },
      transcript: '消息流',
      pending: '待人类处理',
      noPending: '暂无待办任务',
      untitled: '（未命名）',
      approve: '批准',
      reject: '拒绝',
      retry: '重派',
      joinSpace: '加入通信空间',
      nickname: '昵称（ID）',
      capabilitiesLabel: '擅长能力（逗号分隔，可选）',
      capabilitiesPlaceholder: '如：review, translate',
      joinButton: '进入',
      leaveButton: '离开',
      myTasksLabel: '派给我的任务',
      noMyTasks: '暂无派给你的任务',
      adminTitle: '管理员控制台',
      // --- admin tab labels ---
      tabOverview: '总览',
      tabAgents: '智能体',
      tabWorkflows: '工作流',
      tabTasks: '任务',
      tabActivity: '活动',
      tabServices: '服务',
      tabMcp: 'MCP',
      tabFederation: '联邦',
      tabOidc: 'SSO',
      tabSaml: 'SAML',
      // --- MCP integration tab (#2-M4) ---
      mcpPanel: 'MCP 集成',
      mcpIntro: '把外部 MCP server 装进 hub，智能体在「编辑」表单里按名勾选即可调用其工具。凭证请用 ${ENV} 引用，别填明文。',
      mcpDisabled: '此主机未启用 MCP 注册表',
      mcpEmpty: '尚未安装任何 MCP server',
      mcpName: '名称',
      mcpTransport: '传输',
      mcpTarget: '目标',
      mcpDescriptionCol: '说明',
      mcpInstallTitle: '安装 MCP server',
      mcpCommand: '命令',
      mcpArgs: '参数（空格分隔）',
      mcpEnv: '环境变量（每行 KEY=值）',
      mcpUrl: 'URL',
      mcpHeaders: '请求头（每行 名称=值）',
      mcpDescriptionField: '说明（可选）',
      mcpInstallBtn: '安装',
      mcpUninstall: '卸载',
      mcpInstalled: '已安装',
      mcpConfirmUninstall: (name) => `确定卸载「${name}」？正在运行且勾选了它的智能体会失去其工具。`,
      mcpAgentOptIn: 'MCP 集成（勾选后本智能体可调用）',
      mcpAgentOptInEmpty: '还没有可用的 MCP 集成。去「MCP」标签页安装一个。',
      mcpAgentFedHeading: '来自 peer 的共享 server（跨 hub 调用）',
      mcpAgentOffline: '（当前不可达）',
      mcpShared: '共享给 peer',
      mcpSharedHint: '勾选后，peer hub 上的智能体可通过联邦链路调用此 server 的工具；凭证 / 子进程仍留在本机（凭证各归各家）。',
      // --- MCD-M3: built-in connector directory ---
      mcpDirTitle: '浏览内置连接器',
      mcpDirIntro: '从这些现成的 MCP 组件里挑一个一键装上。没有想要的？装上「MCP 注册站搜索」，让智能体去主流注册站实时找。',
      mcpDirHomepage: '官网',
      mcpDirNeedsEnv: (vars) => `需在 host 环境设 ${vars}（只填变量名，密钥不入库）`,
      mcpDirInstalledMsg: (name) => `已安装「${name}」。可在上方列表查看，或在智能体「编辑」表单里按名勾选。`,
      mcpDirCat: { discovery: '发现', rag: 'RAG', notes: '笔记', search: '搜索', files: '文件', web: '网络' },
      // --- services tab (v2.2) ---
      servicesPanel: 'Hub 服务',
      servicesEmpty: '尚未注册任何服务插件',
      servicesPlugin: '插件',
      servicesOwner: '归属',
      servicesSize: '大小',
      servicesItemCount: '条目',
      servicesLastAccess: '最近访问',
      servicesActions: '操作',
      servicesDelete: '软删',
      servicesDetail: '详情',
      servicesTrashTitle: '废纸篓',
      servicesTrashEmpty: '废纸篓为空',
      servicesTrashRestore: '恢复',
      servicesTrashHardDelete: '永久删除',
      servicesTrashedAt: '删除时间',
      servicesExpiresAt: '过期时间',
      servicesTrashReason: '原因',
      servicesSweepBtn: '立即清理过期项',
      servicesSweepResult: (s, p) => `扫描 ${s} 项，清理 ${p} 项`,
      servicesToastTrashed: '已移至废纸篓，30 天后自动清理',
      servicesToastRestored: '已从废纸篓恢复',
      servicesToastHardDeleted: '已永久删除',
      servicesConfirmHardDelete: '确认永久删除？此操作不可撤销。',
      servicesDisabled: '此主机未启用服务功能',
      // --- v1.1 services-over-ws additions ---
      appServicesRequested: '申请使用的服务',
      // v1.2: per-decl method ACL placeholder shown when client did not narrow
      appServicesMethodsAny: '（任意方法）',
      servicesAuditTitle: 'SERVICE_CALL 审计',
      servicesAuditEmpty: '尚未记录任何远程服务调用',
      refresh: '刷新',
      auditTime: '时间',
      auditAgent: '智能体',
      auditService: '服务',
      auditOwner: '归属',
      auditMethod: '方法',
      auditOutcome: '结果',
      auditDuration: '耗时',
      pendingAgents: '待批准的接入申请',
      noPendingAgents: '当前没有待批准的接入申请',
      remoteAddress: '远端地址',
      clientLabel: '客户端',
      pendingSince: '提交时间',
      rejectReason: '拒绝原因（可选）',
      dispatchPanel: '派发任务',
      strategyKind: '派发策略',
      strategyExplicit: '指定参与者',
      strategyCapability: '按能力匹配',
      strategyBroadcast: '广播',
      dispatchTo: '目标 ID',
      dispatchCaps: '能力（逗号分隔）',
      dispatchTitle: '标题（可选）',
      dispatchPayload: 'Payload (JSON)',
      dispatchPriority: '优先级（整数，可选）',
      dispatchButton: '派发',
      dispatchSuccess: '已派发，关注消息流获取结果',
      tasksPanel: '任务面板',
      tasksFilterAll: '全部',
      tasksFilterPending: '进行中',
      tasksFilterDone: '已完成',
      tasksFilterFailed: '失败',
      noTasks: '暂无任务',
      taskStatusPending: '进行中',
      taskStatusDone: '完成',
      taskStatusFailed: '失败',
      taskStatusCancelled: '取消',
      evaluatePanel: '任务评价',
      evaluateTaskId: 'task ID',
      evaluateRating: '评分（1-5，可选）',
      evaluateComment: '评语（可选）',
      evaluateButton: '提交评价',
      evaluateSuccess: '评价已记录',
      evaluateEmpty: '至少填一项再提交（评分或评语）',
      pickTaskHint: '点击下方消息流里 task_result 行可自动填入 task ID',
      // --- expandable task detail panel ---
      taskIdHint: '点击展开并填入评价表单',
      detailCreated: '创建',
      detailCompleted: '完成',
      detailDuration: '耗时',
      detailPayload: '请求载荷',
      detailOutput: '输出',
      detailUsage: 'token 用量',
      detailBy: '执行方',
      detailStopReason: '停止原因',
      detailEvaluations: '历史评价',
      detailEvaluate: '评价这个任务',
      detailCommentOnly: '仅评语',
      knownRoster: '空间档案',
      knownAdmins: '管理员',
      knownWorkers: '工人',
      // --- contribution system (v2.1) ---
      dispatchWeight: '权重（0.1-10，1 位小数，默认 1.0）',
      weightLabel: '权重',
      ratingLabel: '评分',
      contributionLabel: '贡献',
      unrated: '未评',
      leaderboardTitle: '贡献榜',
      lbWindowAll: '不限时段',
      lbWindowToday: '今天',
      lbWindowWeek: '近 7 天',
      lbWindowMonth: '近 30 天',
      lbEmpty: '本时段还没有已评价的贡献',
      lbColRank: '名次',
      lbColId: '参与者',
      lbColScore: '贡献分',
      lbColTasks: '任务数',
      lbColAvg: '平均评分',
      lbColLastSeen: '最近完成',
      lbColCaps: '能力侧重',
      lbSummary: (total, unrated) =>
        unrated > 0
          ? `本时段已完成 ${total} 条任务，其中 ${unrated} 条尚未评分`
          : `本时段已完成 ${total} 条任务，全部评分完毕`,
      contribToggleLabel: '我派发的任务计入贡献榜',
      contribToggleTitleOn: '已开启：我派发的任务会被计入贡献榜（不影响我接受的任务）',
      contribToggleTitleOff: '已关闭：我派发的任务不会计入贡献榜（不影响我接受的任务）',
      // --- room health banner (admin v2.1+) ---
      healthToday: '今日任务',
      healthTodaySub: '含已完成 / 进行中',
      healthOnline: '在线',
      healthOnlineSub: (agents, humans) => `${agents} 个智能体 · ${humans} 个人`,
      healthUnrated: '待评估',
      healthUnratedSub: '近 7 天',
      healthTop3: '本周 Top 3 贡献者',
      healthTop3Empty: '近 7 天暂无已评分贡献',
      commonCaps: '常用：',
      // --- managed agents (v2.1) ---
      managedAgentsTitle: '智能体（本地 + 云端）',
      newAgent: '+ 创建本地 agent',
      importAgent: '导入',
      localAgentBadge: '本地',
      cloudAgentBadge: '云端',
      workflowsTitle: '工作流',
      importWorkflow: '导入工作流',
      workflowsHint: '工作流把多个 agent 按顺序/并行串起来。admin 派一个任务到工作流的触发能力，整个流程自动跑完，结果一次性回来。模板：',
      workflowImportHint: '只支持 schema: gotong.workflow/v1 格式。导入后立刻在 Hub 注册为一个 workflow:<id> 参与者，并写入 .gotong/workflows/definitions/ 目录（host 重启自动加载）。',
      workflowsEmpty: '尚未加载任何工作流',
      workflowsSummary: (count) => `已加载 ${count} 个`,
      // LIFE-L1-M3 — 定时(零 LLM 工作流调度)卡
      wfSchedTitle: '定时',
      wfSchedHint: '到点替成员自动跑一条工作流（调度环零大模型）。run 归属该成员，跟成员自己在 /me 点「运行」完全同一道闸；成员在 IM 对管家说「打开运行播报」即可收到结果。',
      wfSchedSummary: (n) => `${n} 条`,
      wfSchedEmpty: '还没有定时。下面新建一条，比如给「我的晨报」配每天 8 点。',
      wfSchedWorkflow: '工作流（已发布 + 成员可跑）',
      wfSchedNoWorkflow: '（没有可定时的工作流 — 先发布一条 surface.me 开着的）',
      wfSchedUser: '成员 id',
      wfSchedKind: '频率',
      wfSchedKindDaily: '每天',
      wfSchedKindWeekly: '每周',
      wfSchedKindInterval: '每隔',
      wfSchedWeekday: '星期',
      wfSchedWeekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
      wfSchedHour: '几点（0-23，默认时区 UTC+8）',
      wfSchedMinutes: '间隔分钟（≥1）',
      wfSchedCreateBtn: '新建定时',
      wfSchedCadenceDaily: (h) => `每天 ${h}:00`,
      wfSchedCadenceWeekly: (wd, h) => `每${wd} ${h}:00`,
      wfSchedCadenceInterval: (min) => `每隔 ${min} 分钟`,
      wfSchedTz: (tz) => (tz === 480 ? '' : ` (UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz) / 60})`),
      wfSchedEnabled: '启用中',
      wfSchedDisabled: '已暂停',
      wfSchedInvalid: '配置无效',
      wfSchedLastFired: (mark) => `上次触发 ${mark}`,
      wfSchedNeverFired: '还没触发过',
      wfSchedFireBtn: '试跑',
      wfSchedPauseBtn: '暂停',
      wfSchedResumeBtn: '恢复',
      wfSchedRemoveBtn: '删除',
      wfSchedCreated: (id) => `已建定时 ${id}。到点自动跑；点「试跑」立即验证一次。`,
      wfSchedFired: (wfId, userId) => `已替 ${userId} 派出一次 ${wfId}（不看到点/暂停，只走成员闸）。结果看「历史」。`,
      wfSchedFireFail: (reason) =>
        ({
          not_found: '定时不存在（可能刚被删）。',
          invalid: '这行配置无效，改好再试。',
          unrunnable: '工作流现在不可跑：要「已发布」且 surface.me 开着、角色允许。',
          dispatch_failed: '派发失败，看 host 日志。',
        })[reason] || reason,
      confirmRemoveSchedule: (id) => `确定删除定时 "${id}"？已派出的运行不受影响。`,
      workflowStepsLabel: (n) => `${n} 步`,
      workflowTriggerLabel: '触发能力',
      workflowImportDone: (id) => `已导入 workflow:${id}，立刻可用。文件已写入 definitions/。`,
      workflowRemoveBtn: '移除',
      confirmRemoveWorkflow: (id) =>
        `确定要移除 workflow "${id}" 吗？runner 立刻下线，YAML 文件会被删除（不可恢复）。已派出未完成的任务会照常跑完。`,
      workflowRunsBtn: '历史',
      workflowRunsTitle: '运行历史',
      workflowRunsEmpty: '还没有跑过这条工作流。',
      workflowRunsPickHint: '从左侧点一行查看明细。',
      workflowRunStepCount: (n) => `${n} 步`,
      workflowRunDuration: '耗时',
      workflowRunStillRunning: '进行中',
      workflowRunLive: '实时刷新中…',
      workflowRunTriggeredBy: '触发任务',
      workflowRunTriggerPayload: '触发 payload',
      workflowRunFinal: '最终输出',
      workflowRunOutput: '输出',
      workflowRunSubTasks: '子任务',
      workflowRunNoSteps: '尚未开始任何步骤。',
      workflowRunErrorRaw: '原始错误',
      workflowRunAttempts: (n) => `${n} 次尝试`,
      // Phase 15 — workflow lifecycle (state badge on cards + revision history)
      workflowStateLabel: (s) =>
        ({ published: '已发布', deprecated: '已弃用', draft: '草稿', review: '待审核', archived: '已归档' }[s] || s),
      workflowRevTag: (n) => `rev ${n}`,
      // DAG-M4 — read-only flow chart (graph) viewer. Renders the trigger →
      // steps → branches → output DAG the runner already executes; pure
      // visibility, never edits the YAML.
      workflowGraphBtn: '流程图',
      // workflow-architect ARCH-M4 — explain an existing workflow at depth.
      workflowExplainBtn: '解释',
      workflowGraphHeading: '流程图',
      workflowGraphTrigger: '触发',
      workflowGraphOutput: '输出',
      workflowGraphParallel: '并行',
      workflowGraphBranch: '分支',
      workflowGraphReadsTrigger: '读触发',
      workflowGraphWhen: (pred) => `当 ${pred}`,
      workflowGraphDestCapability: (caps) => `能力: ${caps}`,
      workflowGraphDestExplicit: (to) => `指派: ${to}`,
      workflowGraphDestBroadcast: (caps) => (caps ? `广播: ${caps}` : '广播: 全体'),
      workflowGraphCrossHub: (dest) => `跨 hub → ${dest}`,
      workflowGraphLegendSeq: '实线 = 执行顺序',
      workflowGraphLegendData: '虚线 = 数据依赖',
      workflowGraphEmpty: '这条工作流没有可画的步骤。',
      workflowGraphError: (msg) => `取流程图失败：${msg}`,
      // Phase 19 P5 — governance / risk summary on workflow cards
      workflowGovSummary: '⚠️ 风险摘要',
      workflowGovSensitivity: '数据敏感级',
      workflowGovSensitivityLabel: (s) =>
        ({ public: '公开', internal: '内部', confidential: '机密', pii: '个人数据 (PII)' }[s] || s),
      workflowGovCredentials: '需要凭证',
      workflowGovCost: '预估成本/次',
      workflowGovHumanRoles: '需真人角色',
      workflowGovExternal: '触达外部系统',
      // Stream G day-2 / H — off-hub step indicator on workflow cards / start dialog.
      // Two destination kinds with different behavior: a mesh peer hub may pause
      // for inbox approval (if gated); an external A2A agent fires immediately.
      workflowCrossHubSummary: (n) => `🔗 跨 hub 步骤 (${n})`,
      workflowCrossHubPeer: (peer) => `→ 对等 hub: ${peer}`,
      workflowCrossHubA2a: (dest) => `→ 外部 A2A agent: ${dest}`,
      workflowCrossHubNote: (peerDests, a2aDests) => {
        const parts = []
        if (peerDests.length)
          parts.push(`${peerDests.length} 个步骤派到对等 hub (${peerDests.join(', ')});若对方设了审批闸,需在收件箱批准后才会真正发出`)
        if (a2aDests.length)
          parts.push(`${a2aDests.length} 个步骤派到外部 A2A agent (${a2aDests.join(', ')});这类步骤无审批闸,会立即发出`)
        return `注意:${parts.join('。')}。`
      },
      // Stream G day-3 — post-launch CONFIRMATION badge on a run-detail step:
      // where it ACTUALLY ran (resolved from the persisted executedBy), as
      // opposed to the pre-launch crossHubSteps PREDICTION on the card.
      workflowRunCrossHub: (dest, kind) =>
        kind === 'a2a' ? `🔗 由外部 A2A agent ${dest} 执行` : `🔗 在对等 hub ${dest} 上执行`,
      // PB — the parallel analog: ONE branch of a fan-out step ran off-hub. Names
      // the branch so a mixed local+off-hub fan-out reads unambiguously.
      workflowRunBranchCrossHub: (branchId, dest, kind) =>
        kind === 'a2a'
          ? `🔗 分支「${branchId}」由外部 A2A agent ${dest} 执行`
          : `🔗 分支「${branchId}」在对等 hub ${dest} 上执行`,
      // Stream G day-4 — post-launch APPROVAL LOOP: a step that is both
      // `suspended` and cross-hub is parked at the outbound-approval gate,
      // waiting for a human to approve the send in their inbox. The run-level
      // status stays `running` (RunStatus has no `suspended`), so this per-step
      // signal is the only way to tell a parked-needing-approval run apart from
      // one that is still genuinely executing.
      workflowRunAwaitingApproval: (dest) =>
        `⏸ 等待你批准 — 出站到对等 hub ${dest} 的请求需在收件箱确认后才会真正发出`,
      workflowRunGoToInbox: '去收件箱批准 →',
      workflowRunParkedApproval: (dests) =>
        `这个运行暂停了:有 ${dests.length} 个出站到对等 hub 的请求在等你批准 (${dests.join('、')})。批准后它会接着往下跑。`,
      // Stream G day-5 — the post-launch transcript CHAIN. A cross-hub step's
      // viewer pulls the FAR hub's trace of that one dispatched task (opt-in,
      // fail-closed: a peer that never set share_transcript yields fetch_failed).
      workflowRunPeerTranscriptBtn: '查看对方执行轨迹 ▾',
      workflowRunPeerTranscriptHead: (hubId, taskId) =>
        `对端 hub ${hubId} 对任务 ${taskId} 的执行轨迹`,
      workflowRunPeerTranscriptTruncated: '(已截断, 完整轨迹请直接到对端查看)',
      workflowRunPeerTranscriptEmpty: '对端返回了空轨迹 (该任务没有可见事件)。',
      workflowRunPeerTranscriptFail: (code) =>
        code === 'fetch_failed' ? '对端未开启轨迹共享, 或暂时取不到 (fail-closed)。'
        : code === 'no_link' ? '找不到通往该对端的链路。'
        : code === 'not_cross_hub' ? '该步骤不是跨 hub 执行的, 没有对端轨迹。'
        : code === 'unknown_step' ? '运行里找不到这个步骤。'
        : code === 'unknown_run' ? '找不到这个运行。'
        : `取对端轨迹失败 (${code})。`,
      workflowDeprecateBtn: '弃用',
      workflowRepublishBtn: '重新发布',
      workflowArchiveBtn: '归档',
      workflowRevisionsBtn: '修订历史',
      workflowSubmitReviewBtn: '提交审核',
      workflowBackToDraftBtn: '退回草稿',
      workflowPublishBtn: '发布',
      confirmDeprecateWorkflow: (id) =>
        `把 "${id}" 标记为已弃用？/me 成员入口会立刻隐藏它，但在跑的任务和 admin 重跑不受影响。`,
      confirmArchiveWorkflow: (id) =>
        `归档 "${id}"？runner 会下线、不再可跑（修订历史保留，可重新导入）。`,
      confirmPublishWorkflow: (id) =>
        `发布工作流「${id}」？发布后立即上线，/me 成员入口可见。`,
      confirmSubmitReview: (id) =>
        `把「${id}」提交审核？会把当前草稿冻结为候选，仍未上线。`,
      confirmBackToDraft: (id) => `把「${id}」退回草稿继续编辑？`,
      confirmRollback: (id, rev) =>
        `把 "${id}" 回滚到 rev ${rev} 的内容？会追加一个克隆自 rev ${rev} 的新修订并设为当前发布。在跑 / 挂起的任务仍按各自原修订跑完。`,
      workflowRevisionsTitle: '修订历史',
      workflowRevisionsEmpty: '还没有任何修订。',
      workflowRevRollbackBtn: '回滚到此',
      workflowRevCurrent: '当前',
      workflowRevOrigin: (o) => ({ import: '导入', publish: '发布', rollback: '回滚' }[o] || o),
      // Phase 19 P2-M4 — governance audit sub-section.
      workflowAuditTitle: '治理审计',
      workflowAuditActionAll: '全部动作',
      workflowAuditRefresh: '查询',
      workflowAuditEmpty: '没有审计记录。',
      workflowAuditExportCsv: '导出 CSV',
      workflowAuditExportJsonl: '导出 JSONL',
      workflowAuditOwnerOnly: '需要 owner 权限查看治理审计。',
      workflowAuditUnavailable: '此 host 未启用审计日志。',
      // Phase 19 P2-M5c — access control (resource RBAC grants).
      workflowGrantsTitle: '访问控制',
      workflowGrantsRefresh: '刷新',
      workflowGrantsEmpty: '还没有授权（仅 owner / 管理员可访问）。',
      workflowGrantsUserPh: '用户 ID',
      workflowGrantsAdd: '授权',
      workflowGrantsRemove: '撤销',
      workflowGrantsOwnerOnly: '需要 owner 权限管理此工作流的访问控制。',
      workflowGrantsUnavailable: '此 host 未启用资源级权限。',
      workflowGrantsNeedUser: '请填写用户 ID。',
      // v5 E4-M2 — agent access control (reuses the generic workflowGrants*
      // labels; only the manage button / modal title / owner-only notice need
      // agent-specific wording).
      agentAccessManage: '管理访问',
      agentAccessTitle: 'Agent 访问控制',
      agentGrantsOwnerOnly: '需要 owner 权限管理此 agent 的访问控制。',
      loading: '加载中…',
      doImport: '导入',
      editAgent: '编辑本地 agent',
      save: '保存',
      saveOk: '已保存',
      savedWithWarning: (err) => `已保存，但启动失败：${err}`,
      edit: '编辑',
      export_: '导出',
      remove: '移除',
      online: '在线',
      offline: '离线',
      externalAgent: '云端 agent（外部 SDK 接入）',
      providerDisabled: '未配置 API key',
      agentId: 'ID（唯一标识）',
      agentDisplayName: '显示名（可选）',
      agentCaps: '能力（逗号分隔）',
      agentProvider: 'Provider',
      agentModel: 'Model（可选）',
      agentSystem: '系统提示词（system prompt）',
      agentWeightDefault: '默认任务权重（可选，0.1-10）',
      agentHeartbeatLegend: '定时唤醒（心跳）',
      agentHeartbeatEnable: '启用定时唤醒',
      agentHeartbeatInterval: '唤醒间隔（分钟）',
      agentHeartbeatChecklist: '待办清单（可选）',
      agentHeartbeatHint: '勾选后此智能体按间隔自动醒来跑一轮；没事就保持安静。',
      editWarning: '⚠️ 修改已存在的智能体会重启它；建议先停止再修改。',
      templatesHint: '主仓库 templates/ 目录下有标准 agent / team / workflow 模板。打开任一 yaml，复制内容到「导入」即可：',
      importHint: '支持 YAML 或 JSON。可上传文件，或粘贴。',
      uploadFile: '上传文件',
      orPaste: '或粘贴内容',
      importEmpty: '请上传文件或粘贴内容',
      importDone: (created, skipped, errors) =>
        `导入完成：新建 ${created} 个${skipped ? `，跳过 ${skipped} 个（id 已存在）` : ''}${errors ? `，${errors} 个启动失败` : ''}`,
      // --- import menu + GitHub import ---
      importMenuLabel: '导入 ▾',
      importMenuFile: '上传 / 粘贴 YAML',
      importMenuGithub: '从 GitHub URL',
      ghImportTitle: '从 GitHub 导入',
      ghImportHint: '粘贴 GitHub 上 agent / team / workflow 的 yaml 链接（blob 或 raw 都行）。如果访问 GitHub 慢，可一键切换到国内镜像源。',
      ghImportUrlLabel: '文件 URL',
      ghImportSourceLabel: '下载源（可一键切换）',
      ghSourceJsdelivr: 'jsDelivr CDN（国内可达，推荐）',
      ghSourceGhproxy: 'ghproxy 镜像（国内备用）',
      ghSourceGithub: 'GitHub 原版（raw.githubusercontent.com）',
      ghResolvedLabel: '实际下载地址：',
      ghImportSubmit: '下载并导入',
      ghImportBadUrl: '无法解析这个 URL：请用 github.com/<owner>/<repo>/blob/<ref>/<path> 或 raw 链接',
      ghFetchFailed: (msg) => `下载失败：${msg}（试试切换其他下载源）`,
      confirmRemoveAgent: (id) => `确定要移除智能体 "${id}" 吗？此操作不可恢复。`,
      maEmpty: '尚未注册智能体（本地 / 云端均可）',
      maSummary: (managed, online, external) =>
        `本地 ${managed} 个（在线 ${online}）${external > 0 ? ` · 云端 ${external} 个` : ''}`,
      apiKeysBtn: 'API Key 管理',
      apiKeysModalTitle: '工作区 API Key',
      apiKeysHint: '这里设置的 key 会被加密存到 secrets.enc.json；明文不写回任何 GET 响应。每个 agent 也可在自己的「编辑」表单里配私有 key，会优先生效。',
      apiKeySet: '已配置',
      apiKeyEnv: '来自环境变量',
      apiKeyMissing: '未配置',
      apiKeyUpdated: (ts) => `· 更新于 ${new Date(ts).toLocaleString()}`,
      setKey: '设置',
      updateKey: '更新',
      clearKey: '清空',
      keyEnterHere: '粘贴 key，回车保存',
      keySetOk: '已保存（加密）',
      keyRemoved: '已移除',
      keyWarnRestart: '已保存。要让已运行 agent 生效，请编辑 agent 再保存（会重启）。',
      agentApiKey: '私有 API Key（可选，加密保存）',
      agentApiKeyHint: '留空 → 使用工作区默认；点「清空」可移除本 agent 的私有 key',
      agentApiKeyHintEdit: '已配私有 key。留空保持不变；输入新值会更新；点「清空」按钮可移除。',
      agentApiKeyHintCompat: '**必填**：openai-compatible 没有工作区默认 key（每个 baseURL 是不同厂商）。',
      // --- openai-compatible provider ---
      openaiCompatHint: 'DeepSeek / 通义 / 智谱 / Ollama / vLLM 等',
      agentBaseUrl: 'Base URL',
      agentBaseUrlHint: '指向任意 OpenAI 兼容的 /v1/chat/completions 端点：DeepSeek、通义、智谱、Moonshot、Ollama、vLLM 等',
      agentProviderLabel: 'Provider 显示名（可选）',
      failedAlert: (msg) => `失败：${msg}`,
      sumJoined: (id, kind, caps) =>
        `${id}（${(I18N.zh.pKind[kind] || kind)}）能力=[${caps}]`,
      sumLeft: (id) => id,
      sumMessage: (from, ch) => `${from} → #${ch}`,
      sumTask: (from, title, strategy, target) =>
        `${from} 「${title}」 走 ${strategy} ${target}`,
      sumStrategyTo: (to) => `指派=${to}`,
      sumStrategyCaps: (caps) => `能力=[${caps}]`,
      sumStrategyBroadcast: '广播',
      sumOk: (by) => `成功 · 由 ${by}`,
      sumFailed: (by, err) => `失败 · 由 ${by}：${err}`,
      sumCancelled: (reason) => `已取消：${reason}`,
      sumNoParticipant: (reason) => `无可用参与者：${reason}`,
      sumAgentPending: (ids) => `等待批准：${ids.join(',')}`,
      sumAgentApproved: (ids, by) => `已批准：${ids.join(',')}${by ? ` · 由 ${by}` : ''}`,
      sumAgentRejected: (ids, reason, by) =>
        `已拒绝：${ids.join(',')} · ${reason}${by ? ` · 由 ${by}` : ''}`,
      sumEvaluation: (taskId, rating, comment, by) =>
        `${by} 评价 ${taskId.slice(0, 8)}…${rating != null ? ` · ${rating}/5` : ''}${comment ? ` · "${comment}"` : ''}`,

      // --- /me member SPA (REL-7) ----------------------------------------
      // Shared/recurring
      meLoading: '加载中…',
      meLoadFailed: '加载失败',
      meLoadFailedHttp: (s) => `加载失败 (HTTP ${s})`,
      meLoadFailedErr: (e) => `加载失败: ${e}`,
      meSubmitting: '提交中…',
      meSavingDots: '保存中…',
      meSaved: '已保存',
      meCreated: '已创建',
      meFailedColon: (e) => `失败: ${e}`,
      meOpFailedHttp: (s) => `操作失败 (HTTP ${s})`,
      meOpFailedErr: (e) => `操作失败: ${e}`,
      meNone: '无',
      meOnline: '在线',
      meOffline: '离线',
      meEdit: '编辑',
      meDelete: '删除',
      meRevoke: '撤销',
      meDownload: '下载',
      meCancel: '取消',
      meManageAccess: '管理访问',
      meRoleWord: '角色',
      meDeleteFailedErr: (e) => `删除失败: ${e}`,
      // Role labels + subtitles
      meRoleOwner: '所有者',
      meRoleAdmin: '管理员',
      meRoleMember: '成员',
      meRoleViewer: '只读',
      meNotSignedIn: '未登录',
      meSubtitleAdmin: '管理员控制台',
      meSubtitleMember: '我的工作流',
      meSubtitlePersonal: '我的 AI 桌面',
      // Setup wizard
      meSetupSettingUp: '设置中…',
      meSetupPwMismatch: '两次密码不一致',
      meSetupPwTooShort: '密码至少 12 位',
      meSetupFailedHttp: (s) => `设置失败 (HTTP ${s})`,
      meSetupDone: '密码已设,现在去登录…',
      meSetupFailedErr: (e) => `设置失败: ${e}`,
      // Login
      meLoginLoggingIn: '登录中…',
      meLoginTotpWrong: '验证码错误,请重试',
      meLoginTotpNeeded: '请输入两步验证码',
      meLoginFailedHttp: (s) => `登录失败 (HTTP ${s})`,
      meLoginOk: '登录成功,正在加载…',
      meLoginFailedErr: (e) => `登录失败: ${e}`,
      meSsoFailed: (e) => `单点登录失败: ${e}`,
      meSsoButton: (n) => `用 ${n} 登录`,
      // Workflow catalog
      meNoWorkflows: '无可用工作流',
      meNoWorkflowsYet: '暂无可用工作流',
      meNoMemberWorkflowsPre: '还没有面向成员的工作流 — 管理员可在工作流定义里开启 ',
      meNoMemberWorkflowsPost: '。',
      meWfNoFields: '该工作流不需要额外字段。',
      // Dispatch
      meSelectWfFirst: '请先选择一个工作流',
      meDispatchFailedHttp: (s) => `派发失败 (HTTP ${s})`,
      meDispatched: (id) => `已派发,运行 id: ${id}`,
      meDispatchFailedErr: (e) => `派发失败: ${e}`,
      // Workflow edit (NL boundary)
      meWfEditTrigger: '入口(触发能力):',
      meWfEditDataClasses: (c) => `(数据分类 ${c})`,
      meWfEditEgressStep: '出口步骤 ',
      meWfEditEgressArrow: ' → 跨 hub 能力 ',
      meWfEditLockedTitle:
        '🔒 这个工作流连着别的 hub。下面这些跨 hub 的出入口锁定不可改,你只能改自己这边的步骤:',
      meWfEditLocalTitlePre: '✅ 这是只在本 hub 内运行的工作流,你可以自由修改步骤内容。',
      meWfEditLocalTitlePost: '(只有入口 ',
      meWfEditLocalTitleEnd: ' 锁定。)',
      meWfEditViewYaml: '查看当前工作流定义 (YAML)',
      meWfEditInstructionLabel: '用一句话说你想怎么改',
      meWfEditInstructionPlaceholder: '例如:把第一步的提示语改得更礼貌一些',
      meWfEditApplyBtn: '改',
      meWfEditNotEditable: '这个工作流当前状态不可改(审核中或已归档)。',
      meWfEditSelectFirst: '请先在上面选择一个工作流。',
      meWfEditOpenFirst: '请先打开一个工作流编辑器。',
      meWfEditDescribeFirst: '请用一句话描述你想怎么改。',
      meWfEditAiWorking: '正在让 AI 改…(可能要几秒)',
      meWfEditStreamBroken: '连接中断,没有收到结果。改动可能仍在后台保存,请刷新看看。',
      meWfEditPublished: '已发布上线',
      meWfEditDraftSaved: '已存为草稿',
      meWfEditSuccessLine: (applied, expl) => `✅ ${applied}。${expl}`,
      meWfEditChatSuccess: (applied, expl) => `${applied}。${expl}`,
      meWfEditChatFailure: (t, v) => `失败:${t}${v ? `(${v})` : ''}`,
      meWfEditSaveFailedErr: (e) => `保存失败: ${e}`,
      meWfEditAiTyping: '✨ AI 正在打字…',
      meWfEditViewDiff: '查看这次改动',
      meWfDiffSkip: (n) => `… ${n} 行未变 …`,
      meWfEditChatHistory: '这次会话的修改记录',
      meWfEditChatYou: '你:',
      meWfErrForbidden: '你没有这个工作流的编辑权限(需要 editor)。',
      meWfErrNotFound: '找不到这个工作流。',
      meWfErrNoSource: '这个工作流没有可编辑的源定义。',
      meWfErrUnderReview: '这个工作流正在审核中,暂不可改。',
      meWfErrArchived: '这个工作流已归档,不可改。',
      meWfErrBoundaryLocked: '这次修改动到了跨 hub 的出入口 — 只能改你自己这边的步骤。',
      meWfErrAssistantFailed: 'AI 没能生成一个有效的工作流,请换种说法再试。',
      meWfErrParseFailed: 'AI 生成的内容解析失败,请换种说法再试。',
      meWfErrIdChanged: '不能改工作流的 id。',
      meWfErrStructureFailed: '生成的工作流结构校验没通过。',
      meWfErrAssistantUnavailable: 'AI 助手当前不可用(管理员未配置)。',
      // ARCH-M7 — workflow architect: NL create + explain (member SPA).
      // Shares the meWfErr* codes above with the editor; only the architect-
      // specific chrome/headings/error-codes are new here.
      meWfExplainTitle: '看懂这个工作流',
      meWfExplainHint: '让「工作流架构师」用大白话讲讲上面选中的工作流是干什么的,并画出流程图。可以选讲得多细。',
      meWfDepthLabel: '讲解详细程度',
      meWfDepthOneliner: '一句话',
      meWfDepthBrief: '简要',
      meWfDepthDetailed: '详细',
      meWfExplainBtn: '讲讲这个工作流',
      meWfExplainSelectFirst: '请先在上面选择一个工作流。',
      meWfExplainResultHead: (id) => `工作流「${id}」`,
      meWfCreateTitle: '用大白话新建工作流',
      meWfCreateHint:
        '不用写 YAML — 用一句话描述你想要的自动化流程,「工作流架构师」会帮你起草一个,并画出流程图给你看。新建的工作流会先存成草稿(不会自动上线),且只在本 hub 内运行。',
      meWfCreatePlaceholder: '例如:每天早上把我邮箱里的新邮件总结成一段中文,再让我确认要不要回复',
      meWfCreateBtn: '帮我起草',
      meWfCreateDescribeFirst: '请用一句话描述你想要的工作流。',
      meWfCreateResultHead: (id) => `新工作流草稿「${id}」`,
      meWfCreateSuccessLine: (id) => `✅ 已起草并存为草稿:${id}(还没上线)`,
      meWfCreateChatHistory: '这次会话的新建记录',
      meWfCreateChatYou: '你:',
      meWfCreateChatSuccess: (id) => `已起草草稿:${id}`,
      meWfCreateChatFailure: (msg) => `失败:${msg}`,
      meWfArchDownloadSvg: '下载流程图 (SVG)',
      meWfArchViewYaml: '查看工作流定义 (YAML)',
      meWfArchWorking: '正在让「工作流架构师」处理…(可能要几秒)',
      meWfArchAiTyping: '✨ 工作流架构师正在打字…',
      meWfArchStreamBroken: '连接中断,没有收到结果。请刷新或重试。',
      meWfArchSaveFailedErr: (e) => `起草失败: ${e}`,
      meWfArchLoadFailedErr: (e) => `讲解失败: ${e}`,
      meWfArchBadRequest: '请求格式不对,请重试。',
      meWfArchCrossHub:
        '新建的工作流暂时不能跨 hub(只能在本 hub 内运行)。跨 hub 协作需要管理员先配置对端信任。',
      meWfArchIdExists: '已经有一个同名工作流了,请换个说法让它换个名字。',
      meWfArchDraftCap: '你的草稿数量已达上限,先清理一些草稿再新建。',
      meWfArchInternal: '出了点问题,请稍后重试。',
      // SW-M7 — hub steward ("管家") chat panel
      meStewardTitle: '管家',
      meStewardHint:
        '用大白话跟管家说你想做什么 — 它能帮你搭 / 改自己的 AI 助手,或按你的说法改你的工作流。管家只会「提议」,你预览后再决定执行;删除助手、跨 hub 的工作流改动会送到下面「待处理任务」里让你再确认一次。',
      meStewardPlaceholder: '例如:帮我建一个把每天工单总结成一段中文的助手',
      meStewardSend: '问管家',
      // ease-of-use ⑨-M1 (B1) — starter prompts (all "build an assistant" so a
      // fresh hub with no workflows still yields a real create_agent success).
      meStewardTryLabel: '试试这些：',
      meStewardEg1: '帮我建一个每天把新闻总结成一段中文的助手',
      meStewardEg2: '帮我建一个帮我回客户消息的客服小助手',
      meStewardEg3: '帮我建一个把英文邮件翻译成中文的助手',
      // ease-of-use ⑨-M2 (A2) — "how to get a key" guide chrome (per-provider
      // step content lives inline in app.js's KEY_PROVIDER_GUIDES).
      keyGuideSummary: '不知道怎么拿 Key？点开看图文步骤',
      keyGuideOpenLink: '打开官网，按步骤拿 Key →',
      meStewardThinking: '管家在想…',
      meStewardEmptyInput: '请先用一句话告诉管家你想做什么。',
      meStewardNoActions: '(管家这次只是回话,没有要执行的动作。)',
      meStewardApply: '执行',
      meStewardSubmitApproval: '提交审批',
      meStewardApplying: '处理中…',
      meStewardTierSafe: '可直接执行',
      meStewardTierDangerous: '危险·需再确认',
      meStewardTierCrossHub: '跨 hub·需再确认',
      meStewardTierForbidden: '超出管家范围',
      meStewardForbiddenNote: '管家不会做这个 — ',
      meStewardDone: '✅ 已完成。',
      meStewardCreated: (label) => `✅ 已为你建好助手「${label}」。`,
      meStewardEditedAgent: (label) => `✅ 已改好助手「${label}」。`,
      meStewardWorkflowEdited: (applied, expl) => `✅ ${applied}。${expl}`,
      meStewardPending: '已送你的收件箱待确认 — 在下面「待处理任务」里批准后才会真正执行。',
      meStewardNeedsApproval: '这个动作需要再确认一次,但当前没有接入收件箱,暂时无法提交。',
      meStewardGoInbox: '去收件箱',
      meStewardApplyFailed: (e) => `执行失败:${e}`,
      meStewardPlanFailed: (e) => `问管家失败:${e}`,
      // SW-M9 A-M8 — operator-console steward (site-wide twin of the member one)
      opStewardTitle: '站点管家',
      opStewardHint:
        '用大白话管理整个站点 — 建 / 改 / 删任意托管助手,或按你的说法改任意工作流。管家只会「提议」,你预览后再决定执行;删除助手、跨 hub 的工作流改动(以及后续的凭证 / 对端 / 安全设置)都会送到你「我的」收件箱里再确认一次。',
      opStewardPlaceholder: '例如:建一个把每天工单总结成一段中文的站点助手',
      opStewardPending: '已送你「我的」收件箱待确认 — 去那边批准后才会真正执行。',
      // setting-ops M4 — unified deterministic "运维 / 设置" console (overview tab)
      settingOpsTitle: '运维 / 设置 控制台',
      settingOpsHint:
        '在本机做确定性运维（不依赖大模型）：查看状态、校验定义、建缺失目录、改配置（所有者）。冷启动 / 从备份恢复 / 轮换主密钥这类破坏性操作只能在服务器命令行里跑 —— 这里只列出并指给你去哪跑。',
      settingOpsLoading: '正在加载运维命令…',
      settingOpsLoaded: (n, here) => `已加载 ${n} 条命令（其中 ${here} 条可在此运行）。`,
      settingOpsLoadFailed: (e) => `加载失败：${e}`,
      settingOpsEmpty: '没有可用的运维命令。',
      settingOpsTierRead: '只读',
      settingOpsTierSafe: '安全变更',
      settingOpsTierConfig: '配置写',
      settingOpsTierDestructive: '破坏性·离线',
      settingOpsRun: '运行',
      settingOpsRunning: '运行中…',
      settingOpsRunFailed: (e) => `运行失败：${e}`,
      settingOpsOk: '完成。',
      settingOpsWhereCli: '去服务器 CLI 跑：此操作期间 hub 已停机或正被替换，只有 CLI 能执行。',
      settingOpsWhereOwner: '由 hub 所有者在管理网页或服务器 CLI 修改。',
      settingOpsUsageConfigSet: 'KEY value，如 GOTONG_WEB_PORT 8080',
      settingOpsUsageConfigPrice: 'model inputPer1M outputPer1M [cacheWrite] [cacheRead]',
      settingOpsCmd: {
        status: {
          title: '状态快照',
          summary: '我的 hub 现在怎么样 — 定义数量、配置校验结论，以及（hub 在运行时）实时健康。',
        },
        check: {
          title: '校验工作区',
          summary: '确定性的配置 + 工作流 + 智能体校验（与 gotong check 和启动时同一套）。',
        },
        list: { title: '列出运维命令', summary: '每条 setting 命令、它的层级，以及能在哪里运行。' },
        inventory: { title: '备份清单', summary: '备份目录里的可恢复候选（只读列出，最新在前）。' },
        'fix-dirs': { title: '创建缺失目录', summary: '确保工作区目录都存在（mkdir -p；幂等、可逆）。' },
        config: {
          title: '当前生效配置',
          summary: '显示受管 env 旋钮、密钥 env 变量（只显示已设 / 未设）和价目覆盖状态。',
        },
        'config-set': {
          title: '设置一个 env 旋钮',
          summary: '在 <space>/gotong.env 写一个白名单内的非密钥 env 旋钮（下次启动生效）。',
        },
        'config-price': {
          title: '设置一个模型价格',
          summary: '在 <space>/pricing.json 更新一个模型价格 — 落盘前先校验（下次启动生效）。',
        },
        'cold-start': { title: '冷启动', summary: '预检 → 校验定义 → 启动 host。仅 CLI。' },
        restore: { title: '从备份恢复', summary: '把备份包解到一个全新工作区（会跑 verify.sh）。仅 CLI。' },
        'rotate-master-key': { title: '轮换主密钥', summary: '轮换身份保险库的主密钥。仅 CLI。' },
      },
      // File upload
      meUploadSelectFile: (k) => `请为「${k}」选择一个文件`,
      meUploading: '上传中…',
      meUploaded: (n, s) => `已上传:${n}(${s})`,
      meUploadFailed: (e) => `上传失败:${e}`,
      meUploadFailedFile: (e) => `文件上传失败:${e}`,
      meFieldMaxSize: (mb) => `（≤ ${mb} MB）`,
      // Runs
      meNoRuns: '还没有运行记录 — 上面发起一次工作流试试。',
      meInProgress: '进行中',
      meRunStatusRunning: '进行中',
      meRunStatusDone: '已完成',
      meRunStatusFailed: '失败',
      meRunStatusCancelled: '已取消',
      meRunStatusSuspended: '挂起',
      meRunFailReason: '失败原因：',
      // Inbox
      meInboxEmpty: '暂无待处理任务。',
      meInboxHandoff: (n) => `📨 交接说明：${n}`,
      meInboxCommentPlaceholder: '意见（退回修改时必填）',
      meInboxApprove: '批准',
      meInboxRequestChanges: '退回修改',
      meInboxReject: '拒绝',
      meInboxSubmit: '提交',
      meInboxDelegateToggle: '转派给他人…',
      meInboxDelegateEmail: '对方邮箱',
      meInboxDelegateNote: '交接说明（可选）',
      meInboxDelegateConfirm: '确认转派',
      meInboxChangesNeedComment: '退回修改需要填写意见',
      meInboxProcessFailedHttp: (s) => `处理失败 (HTTP ${s})`,
      meInboxProcessFailedErr: (e) => `处理失败: ${e}`,
      meInboxNeedEmail: '请填写对方邮箱',
      meInboxDelegating: '转派中…',
      meInboxDelegateFailedHttp: (s) => `转派失败 (HTTP ${s})`,
      meInboxDelegateFailedErr: (e) => `转派失败: ${e}`,
      // Growth reports
      meNoReports: '还没有报告 — 派发一次工作流试试。',
      // Agents (catalog + own)
      meNoAgents: '还没有可用的 AI 助手 — 管理员可在「智能体」里创建。',
      meHeartbeatTitle: '定时唤醒已开启',
      meHeartbeatBadge: '⏰ 定时',
      meNoOwnAgents: '你还没有搭过自己的助手。用上面的表单建一个吧。',
      meNoModels: '（暂无可用模型 — 在下方「我的 API 密钥」里加一把自己的 key）',
      meCreateAgent: '创建助手',
      meSaveChanges: '保存修改',
      meConfirmDeleteAgent: '确定删除这个助手？此操作不可撤销。',
      // Grants
      meCollapseAccess: '收起访问',
      meTryChat: '试聊',
      meChatClose: '收起',
      meChatGoAddKey: '去补 key →',
      // ②TC-NEXT-ME — after a quick-chat reply lands, the next-step card nudges
      // the member toward real work on the same home page (run a workflow / 问管家).
      meChatNextLead: '它能用了！接下来：',
      meChatNextRunWf: '去发起一个工作流 →',
      meChatNextAskSteward: '问管家帮我多做点 →',
      meConfirmRevokeGrant: '撤销这条访问授权？',
      meGrantKindUser: '用户',
      meGrantKindAgent: '助手',
      meGrantKindPeer: '对端 hub',
      meGrantKindHub: '本 hub',
      meGrantPermViewer: '只读',
      meGrantPermEditor: '可编辑',
      meGrantPermOwner: '共同所有者',
      meNoGrants: '还没有共享给任何人。',
      meGrantKindAria: '对方类型',
      meGrantPidPlaceholder: '对方 ID',
      meGrantPermAria: '权限',
      meGrantAdd: '授权',
      meGrantSelf: '（你）',
      meGrantNeedPid: '请填写对方 ID',
      meGranting: '授权中…',
      meRevokeFailedErr: (e) => `撤销失败: ${e}`,
      // Credentials
      meNoCreds: '你还没有保存自己的密钥。机构配了密钥的话不需要这步。',
      meNoProviders: '（暂无可选供应商）',
      meCredSavedTitle: '已保存',
      meConfirmDeleteCred: '确定删除这把密钥？依赖它的助手会改用机构密钥（如果有）。',
      // MFA
      meMfaNoCrypto: '此 Hub 未配置加密,无法使用两步验证。',
      meMfaLoadFailed: '无法加载两步验证状态。',
      meMfaStatusWord: '状态: ',
      meMfaStatusEnabled: '已启用 ✅',
      meMfaDisableLabel: '停用需输入当前验证码',
      meMfaCodePlaceholder: '6 位验证码',
      meMfaDisableBtn: '停用两步验证',
      meMfaDisabled: '已停用两步验证',
      meMfaStatusPending: '待确认',
      meMfaStatusPendingNote: ' — 有一个未完成的设置。',
      meMfaConfirmLabel: '输入认证器上的验证码以完成启用',
      meMfaConfirmBtn: '确认启用',
      meMfaRegenBtn: '重新生成密钥',
      meMfaEnabled: '两步验证已启用',
      meMfaSetupCancelled: '已取消设置',
      meMfaIntro: '两步验证用一次性验证码为你的账号再加一层保护。',
      meMfaEnrollBtn: '启用两步验证',
      meMfaGenerating: '生成中…',
      meMfaEnrollFailedHttp: (s) => `启用失败 (HTTP ${s})`,
      meMfaAddKey: '在认证器 App 里添加这个密钥 (手动输入):',
      meMfaOtpauthLink: 'otpauth 链接',
      meMfaQrTodo: ' · 二维码渲染待后续',
      meMfaEnterCode: '输入认证器生成的验证码',
      meMfaEnrollFailedErr: (e) => `启用失败: ${e}`,
      mePwChangeFailedHttp: (s) => `修改失败 (HTTP ${s})`,
      mePwUpdated: '密码已更新',
      mePwChangeFailedErr: (e) => `修改失败: ${e}`,
      // Upgrade to team
      meUpgradeBtn: '升级到团队模式',
      meUpgradeHint:
        '升级后 admin 控制台显示完整管理 tab。可以邀请其他用户/接入跨 hub peer/配额管理。不可一键回退。',
      meConfirmUpgrade: '确定升级到团队模式? 升级后部分 admin 控件会显示出来。',
      meUpgrading: '升级中…',
      meUpgradeOk: '升级成功,正在刷新…',
      meUpgradeFailed: (e) => `失败: ${e}`,
      // ── admin: main.js (REL-8) ──
      admAgentsWaiting: (n) => `${n} 个 agent 正在等你回答`,
      admReportsCount: (n) => `共 ${n} 份`,
      admView: '查看',
      admDownload: '下载',
      admGrowthReportTitle: (when) => `成长报告 · ${when}`,
      admLoading: '加载中...',
      admLoadFailedHttp: (s) => `加载失败:HTTP ${s}`,
      admLoadFailedErr: (e) => `加载失败:${e}`,
      admDispatchCap: (cap) => `派发能力:${cap}`,
      admNoPayloadSchema:
        '这条工作流没声明 payload_schema,要手填 JSON。看 workflow.yaml 的 trigger 段了解需要哪些字段。',
      admAgentAsksMore: (agent, n) => `🤖 ${agent} 想再问你 ${n} 件事`,
      admSubmitAnswer: '提交回答 (agent 会接着跑)',
      admSkip: '跳过',
      admSkipTitle: '跳过 — agent 会按它第一轮的判断继续',
      admSubmitting: '提交中…',
      admFieldRequired: (label) => `${label} 必填`,
      admSubmittedAgent: '已提交 — agent 收到了,正在继续',
      admSubmitFailedErr: (e) => `提交失败: ${e}`,
      admSkipping: '跳过中…',
      admSkipped: '已跳过 — agent 用了第一轮的判断',
      admSkipFailedErr: (e) => `跳过失败: ${e}`,
      admUnknownBlock: (type) => `未识别的 ${type} 块`,
      admMaxSize: (mb) => `最大 ${mb} MB`,
      admFileTooLarge: (label, mb) => `${label} 文件超过 ${mb} MB 上限`,
      admUploading: '上传中…',
      admUploaded: (size) => `已上传 (${size})`,
      admUploadFailedMsg: (msg) => `上传失败: ${msg}`,
      admFieldUploadFailed: (label, msg) => `${label} 上传失败: ${msg}`,
      admFieldMustBeNumber: (label) => `${label} 必须是数字`,
      admPayloadJsonInvalid: (e) => `Payload JSON 不合法:${e}`,
      admFailedReason: (reason) => `失败:${reason}`,
      admHttp: (s) => `HTTP ${s}`,
      admDispatched: '已派发 — 在「运行历史」面板看进度。',
      admBundleNeeded: '请上传或粘贴 bundle yaml',
      admCreatedAgents: (n) => `新增 ${n} 个 agent`,
      admSkippedAgents: (n) => `跳过 ${n} 个(已存在)`,
      admWorkflowRegistered: (id) => `workflow ${id} 已注册`,
      admWorkflowWarning: (e) => `(workflow 警告:${e})`,
      admSpawnFailed: (n) => `(${n} 个 spawn 失败:看 agent tab)`,
      admImportDone: '导入完成 — ',
      admListSep: '、',
      // Template gallery — one-click install of shipped templates (G-M3)
      templateGalleryBtn: '模板画廊',
      templateGalleryTitle: '模板画廊 — 一键安装',
      templateGalleryHint: '这些是随框架附带的开箱即用模板。模板只带结构(agent + 工作流接线 + 知识库槽位),不带知识内容或人员。安装后会创建其中的 agent、注册工作流;需要 API key 的 agent 安装后在「agent」面板填。',
      templateGalleryEmpty: '没有可用模板。',
      templateGalleryInstall: '安装',
      templateGalleryInstalling: '安装中…',
      templateGalleryCountAgents: (n) => `${n} 个 agent`,
      templateGalleryCountWorkflows: (n) => `${n} 条工作流`,
      templateGalleryCountKbs: (n) => `${n} 个知识库槽位`,
      templateGalleryNeedsKey: (label) => `需要 ${label} key`,
      templateGalleryWorkflowsLanded: (n) => `注册 ${n} 条工作流`,
      templateGalleryKbSlots: (n) => `${n} 个知识库槽位待接线`,
      // Post-install checklist (ease-of-use ③-M1): tell the operator what to do next.
      templateGalleryChecklistTitle: '接下来要做',
      templateGalleryKbSlotTodo: (name) => `知识库槽位「${name}」待接线 → 去「服务 / MCP」面板连一个 MCP server`,
      templateGalleryKbSlotTodoRef: (name, server) =>
        `知识库槽位「${name}」引用 MCP server「${server}」→ 去「服务 / MCP」面板确认它在线`,
      templateGalleryAgentNoKey: (id, provider) =>
        `agent「${id}」(${provider}) 还没有可用的 API key → 去「agent」面板或首启向导补`,
      // ⑧ — each checklist row carries a deep-link button to the panel that
      // resolves it (KB slot → MCP tab; missing key → API-key modal).
      templateGalleryTodoGotoMcp: '去 MCP 面板 →',
      templateGalleryTodoGotoKey: '去配密钥 →',
      // RES-M3 — resource-adaptation proposals in the post-install checklist. An
      // `applicable` proposal gets a one-click apply button (the operator's click
      // IS the approval — nothing is applied silently). Advisory proposals show a
      // hint only; the fix is a human action outside the hub.
      resAdaptApply: '一键应用',
      resAdaptApplying: '应用中…',
      resAdaptApplied: (agentId) => `已应用到「${agentId}」（重启或重连后生效，模型可能需在 agent 面板微调）`,
      resAdaptFailed: (e) => `应用失败:${e}`,
      resAdaptManual: '需手动处理',
      // RES-M4 — always-on resource-adaptation section in the hub-health panel.
      resAdaptPanelTitle: '本机资源适配',
      resAdaptPanelHint: '检测到本机资源，可一键让下面跑不起来的 agent 适配运行（点击即应用 — 这一步就是你的批准）:',
      admTemplateLoadFailedHttp: (s) => `加载内置模板失败:HTTP ${s}`,
      admGrowthBundleLoaded: '已加载个人成长 bundle。粘贴 DeepSeek key 后点"导入"。',
      admTemplateLoadFailedErr: (e) => `加载内置模板失败:${e}`,
      admWillClear: '(将清空)',
      admApiKeyClearHintSuffix: ': 保存后该 agent 的私有 key 会被移除',
      admStart: '开始',
      admOnboardPgPrompt: '第一次用?试试 5 分钟出一份"12 周个人成长计划":',
      admOnboardPgBtn: '🎁 装个人成长团队 (7 教练 · DeepSeek)',
      admOnboardDeepseekHint: (link) => `先去 ${link} 申请 API key (新用户送 10 元额度 ≈ 几十次跑工作流)。`,
      // --- ease-of-use ⑦-M1 — 首启「从这里开始」引导卡 (overview tab) ---
      startHereTitle: '从这里开始',
      startHereIntro: '欢迎!三步就能让你的 AI 桌面动起来 — 不用写代码。',
      startHereStep1Title: '① 创建我的 AI 助手',
      startHereStep1Desc: '几秒钟拥有一个能聊天、能帮你做事的助手。点一下,确认即建好。',
      startHereStep1Btn: '创建我的 AI 助手',
      startHereStep2Title: '② 或者,装一整套现成模板',
      startHereStep2Desc: '从个人 / 组织 hub 模板挑一个,一键装好整套 agent + 工作流。',
      startHereStep2Btn: '浏览模板画廊',
      startHereStep3Title: '③ 配置模型密钥',
      startHereStep3Desc: '助手要调用大模型才能回话。推荐 DeepSeek,性价比高。',
      startHereStep3Btn: '配置模型密钥',
      startHereKeyDone: '✓ 已配置模型密钥',
      startHereDismiss: '知道了,不再显示',
      startHereAssistantName: '我的 AI 助手',
      startHereAssistantSystem: '你是一个乐于助人、回答简洁的中文 AI 助手。',
      // --- ease-of-use ⑨-M3 — 价值先于 key (无 key 也能体验) ---
      startHereTryFreeLabel: '还没有云端 key?先免费体验 ↓',
      startHereNoKeyHelp: '本机装了 Ollama 就能零云端 key 跑真助手;没装也能先看一段演示。',
      startHereOllamaBtn: '⚡ 一键接入本地 Ollama',
      startHereOllamaDetected: (model) => `已检测到本机 Ollama(模型:${model})`,
      startHereOllamaName: '本地助手(Ollama)',
      startHereDemoBtn: '▶ 看管家演示(无需 key)',
      startHereDemoBanner: '演示 · 非真实 AI 输出',
      startHereDemoTitle: '管家演示:用大白话管理你的 hub',
      startHereDemoUser: '帮我建一个回答客户问题的客服助手',
      startHereDemoTier: '安全',
      startHereDemoProposal: '我会创建一个新助手「客服助手」(能力:chat)。这是一个安全动作,确认后立即生效。',
      startHereDemoApprove: '确认创建',
      startHereDemoDone: '✓ 已创建助手「客服助手」— 这就是用大白话管理 hub 的样子。',
      startHereDemoCta: '想真正用起来?配置一个模型密钥,或一键接入本地 Ollama(免费、零云端 key)。',
      startHereDemoClose: '关闭演示',
      // --- ease-of-use ❷-M2 — overview「hub 体检」health-check panel ---
      healthTitle: 'hub 体检',
      healthRefresh: '刷新',
      healthAllGreen: '一切正常 — 没有需要处理的问题。',
      healthHasIssues: (n) => `发现 ${n} 项需要处理`,
      healthAgentMissingKey: (id, provider) => `智能体「${id}」(${provider}) 缺少可用的模型密钥`,
      healthGoAddKey: '去补 key →',
      healthMcpUnwired: (name) => `MCP 服务「${name}」已配置,但还没有智能体接入`,
      healthGoMcp: '去 MCP 集成 →',
      healthSpaceUnwritable: (path) => `数据目录不可写:${path} — 请检查磁盘空间和目录权限`,
      healthRosterTitle: (online, total) => `智能体(${online}/${total} 在线)`,
      healthTest: '测连接',
      healthOffline: '未上线',
      healthTestTitle: (id) => `测试连接 — ${id}`,
      // --- EH-M2 — agents tab 每行「缺 key」健康徽章 (badge 本身即修复按钮) ---
      agentKeyWarnBadge: '缺 key',
      agentKeyWarnHint: '这个智能体的 API key 没配好,离线多半因此 — 点这里去补',
      // --- EH-M1 — 体检面板「下一步建议」配置进度引导 ---
      healthNextLabel: '下一步建议',
      healthNextNoWorkflow: '你已经有智能体了 — 接下来装一个工作流模板,或用架构师用大白话建一个。',
      healthNextNoPublished: '你有还没发布的草稿工作流 — 发布后成员才能在「我的」里用它。',
      healthNextNoRun: '工作流已就绪,还没跑过 — 跑一次看看效果。',
      healthNextNoMcp: '想让助手能查资料、连知识库?接一个 MCP 连接器试试。',
      healthGoWorkflows: '去工作流 →',
      healthGoPublish: '去发布 →',
      healthGoRun: '去运行 →',
      // --- DEPLOY-B3 — admin 设置页「Hub 运维」缝合区 (ops-quick + IM 通道状态) ---
      opsQuickTitle: 'Hub 运维',
      opsQuickHint: '部署相关的状态和配置都收在这一页:IM 通道 / 凭证 / 体检 / 运维控制台。',
      opsKeysBtn: 'API Key 管理',
      imStatusTitle: 'IM 通道',
      imStatusNone: '还没有已连接的 IM 通道。可用首次启动向导粘贴 bot token,或设环境变量 (如 GOTONG_TELEGRAM_BOT_TOKEN),重启 host 后生效。',
      imStatusHint: '换 token:设置对应环境变量后重启 host 即可 — 环境变量永远优先于密钥库里存的 token。',
      imSourceEnv: '环境变量',
      imSourceVault: '密钥库',
      // --- peer-manifest-ui.js (联邦 tab — peer capability manifest) ---
      pmTitle: 'Peer 能力清单(federation manifest)',
      pmDesc: '每个已连接 peer 通过认证 mesh 链路广播的能力(<code>peer.manifest</code> RPC)。' +
        '清单缓存在内存里 —— 刷新前显示<strong>未知</strong>而不是陈旧快照。本面板只读;' +
        '决定「接受 peer 什么」的入站信任契约在别处(policy 编辑器)。',
      pmRefreshAll: '刷新全部',
      pmColStatus: '状态',
      pmColCaps: '能力',
      pmColLastRefresh: '最近刷新',
      pmLoading: '加载中...',
      pmEmpty: '还没有已配置的 peer。在本页上方「对端」面板添加一个 peer 后,这里会列出它广播的能力。',
      pmStOnlineUnrefreshed: '在线·未刷新',
      pmStOnline: '在线',
      pmStStale: '离线·缓存',
      pmStUnknown: '离线·未知',
      pmCostPrefix: '成本:',
      pmDataPrefix: '数据:',
      pmCapUnknown: '未知(点刷新)',
      pmRefresh: '刷新',
      pmStatusLoading: '加载...',
      pmLoaded: (n) => `已加载 ${n} 个 peer`,
      pmHostNoFederation: 'host 未启用 peer 联邦',
      pmLoadFailed: (e) => `加载失败:${e}`,
      pmRefreshingOne: (id) => `刷新 ${id}...`,
      pmRefreshingAll: '刷新全部...',
      pmRefreshed: '已刷新',
      pmRefreshFailed: (e) => `刷新失败:${e}`,
      // --- peer-summary-ui.js (联邦 tab — cross-hub control plane / 控制面) ---
      psTitle: '控制面(cross-hub 摘要聚合)',
      psDesc: '本 hub 的隐私安全 footprint,加上每个已连接 peer <strong>自愿共享</strong>的摘要' +
        '(<code>peer.summary</code> RPC)。<strong>只有计数</strong> —— 资产 / 运行 / 近窗 LLM 用量 / 挂起任务,' +
        '绝不含原始记录。peer 必须在其 per-link 策略里勾选「向该对端共享摘要」才会出数字;否则只显示原因。' +
        '控制面只<strong>观察</strong>,不接管 —— 每个 hub 自主决定披露什么。',
      psRefreshAll: '刷新全部',
      psColStatus: '状态',
      psColAssets: '资产',
      psColRuns: '运行',
      psColHealth: '健康',
      psColLastRefresh: '最近刷新',
      psLoading: '加载中...',
      psAlertsTitle: '告警',
      psAlertsDesc: '规则对<strong>当前</strong>摘要实时求值,不保存历史触发记录 —— 触发是「此刻」的事实。' +
        '来源可选「本 hub」「某 peer」或「任意来源 (*)」。',
      psFiringsTitle: '触发历史',
      psFiringsDesc: '每条是一次<strong>开启 → 解决</strong>的完整生命周期(<strong>边沿触发</strong>:' +
        '越线时记一次、恢复时标记解决,不会每轮求值重复记)。仅计数 —— 阈值、触发值、时间,绝不含原始记录。',
      psColSource: '来源',
      psColMetric: '指标',
      psColCondition: '条件',
      psColFiredValue: '触发值',
      psColOpened: '开启',
      psColResolved: '解决',
      psTrendTitle: '趋势',
      psFieldSource: '来源',
      psFieldMetric: '指标',
      psPickSourceMetric: '选择来源与指标',
      psTrendDesc: '趋势读自持久化的<strong>计数快照</strong> —— 每次「刷新」采集一个数据点' +
        '(本 hub 总会采,peer 仅在成功拉取摘要时采)。',
      psRulesTitle: '告警规则',
      psFieldCompare: '比较',
      psFieldThreshold: '阈值',
      psFieldLabelOpt: '标签 (可选)',
      psRuleLabelPh: '如: 挂起过多',
      psAddRule: '添加规则',
      psColLabel: '标签',
      psColActions: '操作',
      psChannelsTitle: '通知渠道',
      psChannelsDesc: '告警越线时把<strong>计数摘要</strong>投递到 webhook / 即时通讯(IM) / 邮件(边沿触发:开启发一次、解决发一次)。' +
        '渠道只存<strong>环境变量名</strong>(headerEnv)与目的地,绝不存密钥本身 —— host 在投递时从该环境变量读取令牌。' +
        'IM 用<strong>无状态平台 send</strong>:slack/discord/lark 是 incoming-webhook(令牌在 URL 里),telegram 走 bot API(令牌从环境变量读、拼进路径)。' +
        '<strong>主动投递需开启轮询</strong>:设 <code>GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS</code>(≥10000)host 才会定期' +
        '求值并投递;未设时渠道仅在下方「测试」按钮触发时发出。',
      psFieldKind: '类型',
      psKindIm: 'IM (即时通讯)',
      psKindEmail: 'email (邮件)',
      psFieldPlatform: '平台',
      psFieldTarget: '目标',
      psTargetPh: '如: -1001234567890 或 ops@example.com',
      psFieldAuthEnvOpt: '鉴权环境变量 (可选)',
      psAuthEnvPh: '如: OPS_WEBHOOK_TOKEN',
      psChannelLabelPh: '如: 运维群',
      psAddChannel: '添加渠道',
      psColChannel: '渠道',
      psColDestination: '目的地',
      psColAuth: '鉴权',
      psCmpGt: '大于',
      psCmpGte: '大于等于',
      psCmpLt: '小于',
      psCmpLte: '小于等于',
      psMetricLabels: {
        'assets.agents': 'Agents 数',
        'assets.workflows': '工作流数',
        'assets.publishedWorkflows': '已发布工作流',
        'assets.peers': 'Peer 数',
        'runs.total': '运行总数',
        'llm.calls': 'LLM 调用数',
        'llm.tokens': 'LLM tokens',
        'llm.costMicros': 'LLM 成本 (µ$)',
        'health.suspendedTasks': '挂起任务',
        'alerts.openFirings': '告警·开启中',
      },
      psStOnline: '在线',
      psStOfflineCached: '离线·缓存',
      psStNotShared: '未共享',
      psStOnlineNoSummary: '在线·无摘要',
      psStOfflineUnknown: '离线·未知',
      psSourceAny: '任意来源',
      psSourceAnyOpt: '任意来源 (*)',
      psSourceLocal: '本 hub',
      psBadgeLocal: '本地',
      psLocalUnavailable: '本地 footprint 不可用',
      psNoPeers: '还没有已配置的 peer。在本页「对端」面板添加 peer,' +
        '并在其策略里勾选「向该对端共享摘要」后,这里会聚合它的计数。',
      psRefresh: '刷新',
      psNotRefreshedYet: '尚未刷新',
      psAssetsText: (agents, wf, pub, peers) =>
        `Agents ${agents} · 工作流 ${wf}(发布 ${pub}) · Peers ${peers}`,
      psRunsTotal: (n) => `总 ${n}`,
      psLlmText: (calls, tokens, cost) => `调用 ${calls} · ${tokens} tok · ${cost}`,
      psLlmWindow: (days) => `近 ${days} 天`,
      psHealthText: (suspended, firings) => `挂起 ${suspended} · 告警 ${firings}`,
      psAggLabel: (n) => `联邦告警聚合: ${n} 条开启中`,
      psAggDetail: (known, unknown) =>
        `(跨 ${known} 个已共享 hub${unknown > 0 ? `;${unknown} 个未共享/离线未计入` : ''})`,
      psTrendNoSnapshots: '暂无快照 —— 「刷新全部」以采集首个数据点',
      psTrendMeta: (n, from, to, last, min, max) =>
        `${n} 个数据点 · ${from} → ${to} · 最新 ${last} · 最小 ${min} · 最大 ${max}`,
      psTrendLoading: '加载趋势...',
      psTrendLoadFailed: (e) => `趋势加载失败: ${e}`,
      psHostNoFederation: 'host 未启用 peer 联邦',
      psNoBreaches: '当前没有触发的告警',
      psNoRules: '还没有告警规则。用上面的表单添加一条。',
      psEnabled: '启用',
      psDisabled: '停用',
      psEnable: '启用',
      psDisable: '停用',
      psDelete: '删除',
      psTest: '测试',
      psConfirmDeleteRule: '删除该告警规则?',
      psConfirmDeleteChannel: '删除该通知渠道?',
      psFiringOpen: '开启中',
      psFiringResolved: '已解决',
      psNoFirings: '还没有触发记录。规则越线时会在这里留下一条开启→解决的生命周期。',
      psNoChannels: '还没有通知渠道。用上面的表单添加一个 webhook / IM / 邮件渠道。',
      psTargetEmail: '收件人',
      psTargetChatRoom: '目标 chat/room id',
      psUrlRequired: 'URL 必填',
      psAddingChannel: '添加渠道...',
      psChannelAdded: '渠道已添加',
      psAddChannelFailed: (e) => `添加渠道失败: ${e}`,
      psSavingChannel: '保存渠道...',
      psChannelSaved: '渠道已保存',
      psSaveChannelFailed: (e) => `保存渠道失败: ${e}`,
      psDeletingChannel: '删除渠道...',
      psChannelDeleted: '渠道已删除',
      psDeleteChannelFailed: (e) => `删除渠道失败: ${e}`,
      psSendingTest: '发送测试...',
      psTestDeliverOk: (status) => `测试投递成功 (${status})`,
      psTestDeliverFailed: (e) => `测试投递失败: ${e}`,
      psTestFailed: (e) => `测试失败: ${e}`,
      psSourceMetricRequired: '来源 / 指标必填',
      psThresholdNumber: '阈值必须是数字',
      psAddingRule: '添加规则...',
      psRuleAdded: '规则已添加',
      psAddRuleFailed: (e) => `添加规则失败: ${e}`,
      psSavingRule: '保存规则...',
      psRuleSaved: '规则已保存',
      psSaveRuleFailed: (e) => `保存规则失败: ${e}`,
      psDeletingRule: '删除规则...',
      psRuleDeleted: '规则已删除',
      psDeleteRuleFailed: (e) => `删除规则失败: ${e}`,
      psLoadingStatus: '加载...',
      psLoaded: (n) => `已加载 ${n} 个 peer`,
      psLoadFailed: (e) => `加载失败:${e}`,
      psRefreshingOne: (id) => `刷新 ${id}...`,
      psRefreshingAll: '刷新全部...',
      psRefreshed: '已刷新',
      psRefreshFailed: (e) => `刷新失败:${e}`,
      // identity / user-management panel (tab "用户")
      idnConfirmPrompt: (phrase) => '要继续,请输入: ' + phrase,
      idnNoV4Binding: '(v3 admin · 无 v4 user 绑定)',
      idnMeLine: (who, display, role, source) =>
        '当前: ' + who + display + ' · 角色 ' + role + ' · 来源 ' + source,
      idnMeReadFailed: (msg) => '无法读取当前用户: ' + msg,
      idnLoading: '载入中…',
      idnUsersLoadFailed: (msg) => '用户列表加载失败: ' + msg,
      idnAuditLoadFailed: (msg) => '审计日志加载失败: ' + msg,
      idnAuditEmpty: '没有匹配的审计记录',
      idnUsersEmpty: '还没有用户',
      idnBtnCreds: '凭证',
      idnBtnCredsTitle: '查看 / 撤销凭证',
      idnBtnPw: '改密码',
      idnBtnPwTitle: '改密码',
      idnBtnKey: '发 API key',
      idnBtnKeyTitle: '发放 API key',
      idnGrantOwnerTitle: '⚠ 授予 owner 角色',
      idnGrantOwnerBody:
        '将会授予完整管理权 (可创建/删除用户、撤销凭证、修改任意用户密码)。\n' +
        '该操作会写入审计日志,但不会自动告警。',
      idnGrantOwnerCancelled: '已取消 owner 授予',
      idnRoleUpdated: (role) => '角色已更新为 ' + role,
      idnRoleUpdateFailed: (msg) => '改角色失败: ' + msg,
      idnPwPrompt: '新密码 (至少 8 个字符):',
      idnPwUpdated: '密码已更新',
      idnPwUpdateFailed: (msg) => '改密码失败: ' + msg,
      idnKeyLabelPrompt: 'API key 标签 (可选,便于以后识别):',
      idnKeyShowOnce: 'API key 仅显示一次,请立即复制保存 (Ctrl/Cmd+C):',
      idnKeyIssued: (id) => '已发放 API key, credentialId=' + id,
      idnKeyIssueFailed: (msg) => '发 API key 失败: ' + msg,
      idnNoCreds: '该用户没有任何凭证',
      idnCredKindLabel: (kind) => '(' + kind + ' 凭证)',
      idnCredListPrompt: '凭证列表 (输入要撤销的 credential id, 留空取消):\n\n',
      idnCredNotFound: '未找到匹配的 credential id',
      idnRevokePwTitle: '⚠ 撤销 password 凭证',
      idnRevokePwBody: (who) =>
        '该用户将立即无法用密码登录 (' + who + ').\n' +
        '该用户需 owner 重新设置密码或发放 token 才能恢复访问。',
      idnRevokePwCancelled: '已取消撤销密码凭证',
      idnConfirmRevokeCred: (kind, id) => '确认撤销 ' + kind + ' 凭证 ' + id + '?',
      idnCredRevoked: 'credential 已撤销',
      idnCredOpFailed: (msg) => '凭证操作失败: ' + msg,
      idnInvitesLoadFailed: (msg) => '邀请列表加载失败: ' + msg,
      idnInvitesEmpty: '没有匹配的邀请',
      idnBtnRevoke: '撤销',
      idnBtnRevokeTitle: '撤销邀请',
      idnConfirmRevokeInvite: (email) => '撤销给 ' + email + ' 的邀请?',
      idnInviteRevoked: '邀请已撤销',
      idnInviteRevokeFailed: (msg) => '撤销失败: ' + msg,
      idnEmailRequired: 'email 必填',
      idnTtlPositive: 'TTL 必须是正数小时',
      idnInviteShowOnce: (email) =>
        '邀请链接仅显示一次,请立即复制后通过私密渠道(Signal/1Password/纸条)发给 ' +
        email +
        '。\n\n链接 24 小时内 (或你设置的 TTL) 有效,点击后由受邀人设置自己的密码。',
      idnInviteCreated: (email) => '已为 ' + email + ' 创建邀请',
      idnInviteCreateFailed: (msg) => '创建邀请失败: ' + msg,
      idnCreateOwnerTitle: '⚠ 创建新 owner 用户',
      idnCreateOwnerBody: (email) =>
        '将创建一个拥有完整管理权的用户: ' + email + '\n' +
        '该用户可创建/删除任意用户、撤销凭证、修改任意密码。',
      idnCreateOwnerCancelled: '已取消创建 owner',
      idnUserCreated: (email) => '用户 ' + email + ' 已创建',
      idnUserCreateFailed: (msg) => '创建用户失败: ' + msg,
      idnHeading: '用户管理 / Users',
      idnNewUser: '新建用户',
      idnPhDisplayName: '显示名 (可选)',
      idnPhPassword: '密码 (可选, 8+ 字符)',
      idnBtnCreateUser: '创建用户',
      idnUserList: '用户列表',
      idnColDisplayName: '显示名',
      idnColRole: '角色',
      idnColCreated: '创建',
      idnColLastLogin: '上次登录',
      idnColActions: '操作',
      idnInvitations: '邀请 / Invitations',
      idnTtlTitle: '链接有效期 (小时); 最长 30 天',
      idnBtnCreateInvite: '创建邀请链接',
      idnInviteHint:
        '链接含一次性 token,创建后会弹窗显示请立即复制。owner 不能通过邀请创建,需先邀请普通角色再 setRole 提升。',
      idnBtnRefresh: '刷新',
      idnColStatus: '状态',
      idnColExpires: '过期',
      idnAuditLog: '审计日志 / Audit log',
      idnColTime: '时间',
      a2aTitle: '出站 A2A 智能体',
      a2aDesc:
        '注册本 hub 对外转发的 A2A 智能体。把某个本地能力 (capability) 派发出去时,会转成对外部智能体的 <code>message/send</code> 调用。替代旧的 <code>GOTONG_A2A_AGENTS</code> 环境变量,改为持久化 + 即时生效。',
      a2aTokenNote:
        '<strong>令牌不在这里填</strong> —— 「令牌环境变量」是 host 读取 bearer 的环境变量<strong>名</strong>,密钥本身永不进数据库或浏览器。某行环境变量未设置时显示「未激活」;在主机设好后把该行停用→启用即可让 host 重新读取并上线 (无需重启)。',
      a2aAddSummary: '注册出站智能体',
      a2aPhId: '本地 participant id (派发目标, 唯一)',
      a2aPhLabel: '显示名 (可选)',
      a2aPhCaps: '能力 capabilities (逗号分隔, 至少一个)',
      a2aPhUrl: '远端 A2A message/send URL',
      a2aPhTokenEnv: '令牌环境变量名 (如 WRITER_A2A_TOKEN)',
      a2aPhPeerId: 'X-Gotong-Peer-Id (Gotong↔Gotong 时, 可选)',
      a2aPhTargetSkill: '远端 skill (metadata.skill, 可选)',
      a2aLifecycleLabel:
        '长任务模式 (远端返回挂起任务时轮询 <code>tasks/get</code>; 不勾=阻塞, 远端必须一轮回完)',
      a2aPhPollInterval: '轮询间隔 ms (可选, 默认 3000)',
      a2aPhMaxAttempts: '最多轮询次数 (可选, 默认 20)',
      a2aEnabledLabel: '启用 (令牌环境变量已设则立即上线)',
      a2aBtnRegister: '注册',
      a2aRegisteredHeading: '已注册出站智能体',
      a2aColIdLabel: 'id / 显示名',
      a2aColCaps: '能力',
      a2aColUrl: 'URL',
      a2aColTokenEnv: '令牌环境变量',
      a2aColMode: '模式',
      a2aColStatus: '状态',
      a2aColActions: '操作',
      a2aLoading: '载入中…',
      a2aStRunning: '在跑',
      a2aStDisabled: '已停用',
      a2aStTokenUnset: '未激活·环境变量未设',
      a2aStIdConflict: '未激活·id 冲突',
      a2aStInactive: '未激活',
      a2aModeBlocking: '阻塞',
      a2aModeLongTitle: '远端返回挂起任务时轮询 tasks/get',
      a2aModeLong: (detail) => '长任务' + detail,
      a2aModeDefault: ' (默认)',
      a2aEmpty: '还没有注册出站 A2A 智能体。在上面表单注册一个 —— 之后派发它声明的能力就会转发到远端。',
      a2aBtnDisable: '停用',
      a2aBtnEnable: '启用',
      a2aBtnToBlocking: '改阻塞',
      a2aBtnToLong: '改长任务',
      a2aBtnDelete: '删除',
      a2aConfirmDelete: (name) =>
        '删除出站智能体「' + name + '」? 派发它能力的工作流将不再转发到远端。',
      a2aUnwired: '此主机未启用身份存储 (出站 A2A 不可用)',
      a2aLoadingStatus: '载入…',
      a2aLoadedStatus: (total, live) => '共 ' + total + ' 个 (在跑 ' + live + ')',
      a2aLoadFailed: (msg) => '载入失败:' + msg,
      a2aRegistering: '注册…',
      a2aRegistered: '已注册',
      a2aRegisterFailed: (msg) => '注册失败:' + msg,
      a2aSaving: '保存…',
      a2aSaved: '已保存',
      a2aSaveFailed: (msg) => '保存失败:' + msg,
      a2aDeleting: '删除…',
      a2aDeleted: '已删除',
      a2aDeleteFailed: (msg) => '删除失败:' + msg,
      a2aOkDisabled: '已停用',
      a2aOkEnabled: '已启用',
      a2aOkToBlocking: '已改为阻塞',
      a2aOkToLong: '已改为长任务',
      // Item 2 — outbound-edge gate (data-class / quota / approval).
      a2aPhDataClasses: '数据类许可清单 (逗号分隔; 留空=不限制)',
      a2aPhQuotaBudget: '出站配额/窗口 (可选; 留空或 0=不限)',
      a2aApprovalLabel: '出站需人工审批 (每次外发前在 /me 收件箱确认)',
      a2aColGate: '出站闸',
      a2aGateNone: '—',
      a2aGateDcLocked: '数据类·锁死',
      a2aGateDcList: (s) => '数据类: ' + s,
      a2aGateQuota: (n) => '配额: ' + n + '/窗口',
      a2aGateApproval: '需审批',
      a2aStApprovalUnconfigured: '未激活·审批未配置',
      a2aBtnToApproval: '改审批',
      a2aBtnToDirect: '改直发',
      a2aOkToApproval: '已改为需审批',
      a2aOkToDirect: '已改为直发',
      acpTitle: '出站 ACP 编码智能体',
      acpDesc:
        '注册本 hub 经 ACP 长连接驱动的编码智能体 (Claude Code / Codex)。派发某个本地能力 (capability) 时,会把它<strong>启动一次→保持 session→反复派任务</strong>(任务间上下文保留),由它在子进程里跑编码工作。替代旧的 example 胶水,改为持久化 + 即时生效。',
      acpKeyNote:
        '<strong>这里无需任何密钥</strong> —— ACP 桥接复用底层 agent <strong>自己的登录态</strong> (本机已 <code>claude</code> / <code>codex</code> 登录),所以命令 / 参数 / 工作目录都是非密配置,完整存储。某行停用时显示「已停用」;启用后 host 立即在运行的 hub 上注册 (无需重启)。破坏性动作 (改文件/删/push…) 默认 fail-closed 当场拒绝。',
      acpAddSummary: '注册出站编码智能体',
      acpPhId: '本地 participant id (派发目标, 唯一)',
      acpPhLabel: '显示名 (可选)',
      acpPhCaps: '能力 capabilities (逗号分隔, 至少一个)',
      acpPhCommand: '命令 command (如 npx 或 codex-acp)',
      acpPhArgs: '参数 args (空格分隔, 如 @zed-industries/claude-code-acp)',
      acpPhCwd: '工作目录 cwd (可选, 默认 host 进程目录)',
      acpEnabledLabel: '启用 (立即在 hub 上注册, 首个派发时才真正 spawn 子进程)',
      acpBtnRegister: '注册',
      acpRegisteredHeading: '已注册出站编码智能体',
      acpColIdLabel: 'id / 显示名',
      acpColCaps: '能力',
      acpColCmd: '命令 + 参数',
      acpColCwd: '工作目录',
      acpColStatus: '状态',
      acpColActions: '操作',
      acpLoading: '载入中…',
      acpStRunning: '在跑',
      acpStDisabled: '已停用',
      acpStIdConflict: '未激活·id 冲突',
      acpStNotFound: '未激活·未找到',
      acpStInactive: '未激活',
      acpEmpty:
        '还没有注册出站 ACP 编码智能体。在上面表单注册一个 —— 之后派发它声明的能力就会启动并驱动 Claude Code / Codex。',
      acpBtnDisable: '停用',
      acpBtnEnable: '启用',
      acpBtnDelete: '删除',
      acpConfirmDelete: (name) =>
        '删除出站编码智能体「' + name + '」? 派发它能力的工作流将不再驱动该 agent。',
      acpUnwired: '此主机未启用身份存储 (出站 ACP 不可用)',
      acpLoadingStatus: '载入…',
      acpLoadedStatus: (total, live) => '共 ' + total + ' 个 (在跑 ' + live + ')',
      acpLoadFailed: (msg) => '载入失败:' + msg,
      acpRegistering: '注册…',
      acpRegistered: '已注册',
      acpRegisterFailed: (msg) => '注册失败:' + msg,
      acpSaving: '保存…',
      acpSaved: '已保存',
      acpSaveFailed: (msg) => '保存失败:' + msg,
      acpDeleting: '删除…',
      acpDeleted: '已删除',
      acpDeleteFailed: (msg) => '删除失败:' + msg,
      acpOkDisabled: '已停用',
      acpOkEnabled: '已启用',
      // Item 2 — outbound-edge gate (data-class allowlist / quota; no approval, D5).
      acpPhDataClasses: '数据类许可清单 (逗号分隔; 留空=不限制; 治理控制)',
      acpPhQuotaBudget: '出站配额/窗口 (可选; 留空或 0=不限; 跑飞护栏)',
      acpColGate: '出站闸',
      acpGateNone: '—',
      acpGateDcLocked: '数据类·锁死',
      acpGateDcList: (s) => '数据类: ' + s,
      acpGateQuota: (n) => '配额: ' + n + '/窗口',
      // peer-admin-ui.js — 联邦 tab peer onboarding 面板 (Route B P1-M7b/c)
      padmTitle: '对端 / Peers (联邦)',
      padmDesc:
        '登记本 hub 信任的联邦对端。认证是<strong>对称</strong>的:' +
        '同一 bearer token 两边各登记一次 —— 用 <code>gotong mint-peer-token</code> 生成,' +
        '走安全信道交换。token 是 secret, 加密存 vault, <strong>永不回显</strong>(只能写入 / 轮换)。',
      padmLabelOptional: '标签 (可选)',
      padmLabelPlaceholder: '合作方 hub',
      padmKind: '类型',
      padmAddBtn: '添加 peer',
      padmColPeer: '对端',
      padmColKind: '类型',
      padmColState: '状态',
      padmColActions: '操作',
      padmLoadingCell: '加载中...',
      padmEmpty: '还没有已登记的 peer。用上面的表单添加一个。',
      padmStateEnabled: '已启用',
      padmStateDisabled: '已停用',
      padmStateOnline: '在线',
      padmStateOffline: '离线',
      padmStateRevoked: '已撤销',
      padmBtnPolicy: '策略',
      padmBtnEnable: '启用',
      padmBtnDisable: '停用',
      padmBtnRotate: '轮换 token',
      padmBtnRemove: '删除',
      padmPolAclCaps: '入站 ACL capabilities',
      padmPolAclCapsHint: '(逗号分隔, 留空=接受全部)',
      padmPolRequireOrigin: '入站要求带 origin',
      padmPolOutCaps: '出站 capability 白名单',
      padmPolOutCapsHint: '(留空=全放)',
      padmPolApprove: '出站需人工审批',
      padmPolDataClasses: '允许的数据类',
      padmPolDataClassesHint: '(留空=全放)',
      padmPolKb: '可调用知识库',
      padmPolKbHint: '(留空=全部可调)',
      padmPolQuota: '每链路入站配额',
      padmPolQuotaHint: '(非负整数, 留空=无限)',
      padmPolRevState: '撤销状态',
      padmPolShareSummary: '向该对端共享本 hub 摘要',
      padmPolShareSummaryHint: '(仅计数, 控制面用)',
      padmPolShareTranscript: '向该对端共享跨 hub 任务轨迹',
      padmPolShareTranscriptHint: '(逐步 transcript, 比摘要更敏感)',
      padmPolSave: '保存策略',
      padmQuotaMustBeInt: '每链路配额必须是非负整数',
      padmSavingPolicy: '保存策略...',
      padmPolicySaved: '策略已保存',
      padmPolicySaveFailed: (e) => `保存策略失败: ${e}`,
      padmRotatePrompt:
        '粘贴新的 peer token (用 `gotong mint-peer-token` 生成)。\n两边都要换成同一新值。',
      padmTokenEmpty: 'token 不能为空',
      padmTokenRotated: 'token 已轮换',
      padmConfirmRemove: (name) => `删除 peer ${name}? 链路会断开。`,
      padmFieldsRequired: 'Peer ID / Endpoint / Token 都必填',
      padmAdding: '添加中...',
      padmAdded: (id) => `已添加 ${id}`,
      padmAddFailed: (e) => `添加失败: ${e}`,
      padmSaving: '保存中...',
      padmSaved: '已保存',
      padmSaveFailed: (e) => `保存失败: ${e}`,
      padmRemoving: '删除中...',
      padmRemoved: '已删除',
      padmRemoveFailed: (e) => `删除失败: ${e}`,
      padmLoading: '加载...',
      padmLoadedN: (n) => `已登记 ${n} 个 peer`,
      padmHostNoIdentity: 'host 未启用 identity / peer (个人模式)',
      padmLoadFailed: (e) => `加载失败: ${e}`,
      // 配对码向导 (peer-admin-ui.js, ease-of-use ④-M1)
      padmPairTitle: '配对码向导（便捷登记）',
      padmPairNote:
        '配对码只是把 Peer ID、端点、共享令牌打包成一段可复制文本，方便交换 —— 它不是新的安全机制：令牌仍是双方共享的密钥，明文装在里面，请只通过你信任的渠道发送。',
      padmPairPasteLabel: '粘贴对方发来的配对码',
      padmPairPastePlaceholder: '把对方生成的配对码粘到这里',
      padmPairDecodeBtn: '解析并预填表单',
      padmPairGenTitle: '生成我方配对码',
      padmPairMyId: '我方 Peer ID（对方登记我们时用）',
      padmPairMyIdLoading: '读取中…',
      padmPairMyEndpoint: '我方端点（对方拨入的地址）',
      padmPairMyEndpointHint: '默认按本机推断，请改成对端真正能访问的公网 wss 地址',
      padmPairToken: '共享令牌',
      padmPairTokenHint: '256 位随机密钥，两端登记同一个；粘贴对方配对码会自动同步',
      padmPairNewToken: '新令牌',
      padmPairGenBtn: '生成配对码',
      padmPairOutLabel: '把这段发给对方',
      padmPairCopyBtn: '复制',
      padmPairDecoded: '已预填下方表单，请核对后点「添加」；令牌已同步到生成区，可回邮给对方。',
      padmPairDecodeFailed: '不是有效的配对码。',
      padmPairGenerated: '配对码已生成。',
      padmPairGenFailed: '生成失败：请填好 Peer ID、端点和令牌。',
      padmPairCopied: '已复制到剪贴板。',
      padmPairNoSelfId: '读不到本 hub 的 Peer ID，请手动填写。',
      padmPairNoEndpoint: '请填写我方端点。',
      padmPairNoToken: '请填写或生成共享令牌。',
      // SAML 2.0 IdP 注册面板 (saml-ui.js)
      samlTitle: '单点登录 / SSO (SAML 2.0)',
      samlIntro:
        '注册本 hub 接受 SAML 断言的外部身份提供方 (IdP)。' +
        '成员在登录页会看到「用 X 登录」按钮。<strong>SSO 只放已存在的本地用户进门</strong> —— ' +
        '按 IdP 签名断言里的邮箱匹配现有账号,绝不自动开户。',
      samlAcsHint: (path) =>
        `断言接收地址 (ACS, 在 IdP 处登记): <code>${path}</code> —— ` +
        `即 <code>https://&lt;你的域名&gt;${path}</code>。注册后每行有「SP 元数据」链接可交给 IdP 管理员。`,
      samlRegisterIdp: '注册 IdP',
      samlPhIdpEntityId: 'IdP entityID (断言 Issuer)',
      samlPhLabel: '显示名 (按钮文字, 可选)',
      samlPhSsoUrl: 'SSO URL (HTTP-Redirect 端点)',
      samlPhSpEntityId: 'SP entityID (本 hub, 断言 Audience)',
      samlPhIdpCert: 'IdP 签名证书 (X.509 PEM, 公开验证钥)',
      samlEnabledLabel: '启用 (成员登录页立即可见)',
      samlRegisterBtn: '注册',
      samlRegisteredIdp: '已注册 IdP',
      samlColLabelEntity: '标签 / EntityID',
      samlColCert: '证书',
      samlColState: '状态',
      samlColActions: '操作',
      samlLoadingCell: '载入中…',
      samlEmpty: '还没有注册 IdP。在上面表单注册一个后,成员登录页会出现对应的 SSO 按钮。',
      samlStateEnabled: '启用',
      samlStateDisabled: '停用',
      samlBtnDisable: '停用',
      samlBtnEnable: '启用',
      samlBtnRotateCert: '轮换证书',
      samlBtnMetadata: 'SP 元数据',
      samlBtnRemove: '删除',
      samlCertPrompt: '粘贴新的 IdP 签名证书 (X.509 PEM):',
      samlCertEmpty: '证书不能为空 (留空已忽略)',
      samlCertRotated: '证书已轮换',
      samlRemoveConfirm: (name) => `删除 IdP「${name}」? 已联结的用户将无法再用它登录。`,
      samlDisabled: '已停用',
      samlEnabled: '已启用',
      samlHostNoIdentity: '此主机未启用身份存储 (SAML 不可用)',
      samlLoading: '载入…',
      samlLoadedN: (n) => `已注册 ${n} 个 IdP`,
      samlLoadFailed: (e) => `载入失败:${e}`,
      samlRegistering: '注册…',
      samlRegistered: '已注册',
      samlRegisterFailed: (e) => `注册失败:${e}`,
      samlSaving: '保存…',
      samlSaved: '已保存',
      samlSaveFailed: (e) => `保存失败:${e}`,
      samlRemoving: '删除…',
      samlRemoved: '已删除',
      samlRemoveFailed: (e) => `删除失败:${e}`,
      // OIDC IdP 注册面板 (oidc-ui.js)
      oidcTitle: '单点登录 / SSO (OIDC)',
      oidcIntro:
        '注册本 hub 接受单点登录的外部身份提供方 (IdP)。' +
        '成员在登录页会看到「用 X 登录」按钮。<strong>SSO 只放已存在的本地用户进门</strong> —— ' +
        '按 IdP 断言的已验证邮箱匹配现有账号,绝不自动开户。',
      oidcCallbackHint: (path) =>
        `回调地址 (在 IdP 处也要登记同一个): <code>${path}</code> —— ` +
        `即 <code>https://&lt;你的域名&gt;${path}</code>`,
      oidcRegisterIdp: '注册 IdP',
      oidcPhIssuer: 'issuer (https://accounts.google.com)',
      oidcPhLabel: '显示名 (按钮文字, 可选)',
      oidcPhClientId: 'client_id',
      oidcPhRedirectUri: (path) => `redirect_uri (…${path})`,
      oidcPhScope: 'scope (留空=openid email profile)',
      oidcPhClientSecret: 'client_secret (留空=公开/PKCE 客户端)',
      oidcEnabledLabel: '启用 (成员登录页立即可见)',
      oidcRegisterBtn: '注册',
      oidcRegisteredIdp: '已注册 IdP',
      oidcColLabelIssuer: '标签 / Issuer',
      oidcColScope: 'Scope',
      oidcColState: '状态',
      oidcColSecret: '密钥',
      oidcColActions: '操作',
      oidcLoadingCell: '载入中…',
      oidcEmpty: '还没有注册 IdP。在上面表单注册一个后,成员登录页会出现对应的 SSO 按钮。',
      oidcStateEnabled: '启用',
      oidcStateDisabled: '停用',
      oidcSecretSet: '有',
      oidcSecretPublic: '公开',
      oidcBtnDisable: '停用',
      oidcBtnEnable: '启用',
      oidcBtnRotateSecret: '轮换密钥',
      oidcBtnRemove: '删除',
      oidcSecretPrompt: '输入新的 client_secret (留空=改为公开/PKCE 客户端):',
      oidcSecretRotated: '密钥已轮换',
      oidcSecretCleared: '已改为公开客户端',
      oidcRemoveConfirm: (name) => `删除 IdP「${name}」? 已联结的用户将无法再用它登录。`,
      oidcDisabled: '已停用',
      oidcEnabled: '已启用',
      oidcHostNoIdentity: '此主机未启用身份存储 (OIDC 不可用)',
      oidcLoading: '载入…',
      oidcLoadedN: (n) => `已注册 ${n} 个 IdP`,
      oidcLoadFailed: (e) => `载入失败:${e}`,
      oidcRegistering: '注册…',
      oidcRegistered: '已注册',
      oidcRegisterFailed: (e) => `注册失败:${e}`,
      oidcSaving: '保存…',
      oidcSaved: '已保存',
      oidcSaveFailed: (e) => `保存失败:${e}`,
      oidcRemoving: '删除…',
      oidcRemoved: '已删除',
      oidcRemoveFailed: (e) => `删除失败:${e}`,
      // —— 工作流 AI 助手 (admin-wf-assist.js) ——
      wfaChipWarnN: (n) => `⚠ schema 通过，但有 ${n} 项深度警告`,
      wfaChipValid: '✓ 校验通过 (可保存)',
      wfaChipInvalid: '✗ YAML 不合 v1 schema',
      wfaChipNoYaml: '— LLM 没生成 YAML',
      wfaChipUnknown: '(未知)',
      wfaViolUnknownAgent: '指向不存在的 agent',
      wfaViolUnknownCapability: '当前 hub 没 agent 提供该 capability',
      wfaViolBadRef: '$ref 指向不存在的 step',
      wfaViolForwardRef: '$ref 指向更晚执行的 step',
      wfaViolSelfTriggerCycle: '会触发自己 — 死循环',
      wfaViolIdCollision: 'workflow.id 已存在',
      wfaViolUnknownKind: '(unknown)',
      wfaDeepOk: '深度检查通过 (0 项警告)',
      wfaDeepWarnN: (n) => `深度检查警告 — ${n} 项 (workflow 可保存，但运行时可能失败)`,
      wfaYamlEmpty: '(空 — LLM 没生成 YAML fence)',
      wfaNeedDescription: '请先填一句描述',
      wfaGenerating: '生成中…',
      wfaGeneratingMsg: '正在生成,通常 5-20 秒…',
      wfaWaitingChunk: '等待 LLM 第一个 chunk…',
      wfaStreamTask: (id) => `task=${id}…`,
      wfaStreamProgress: (done, chars, tools) =>
        `${done ? '✓ 流结束' : '● 生成中'} · ${chars} chars${tools ? ` · 🔧 ${tools}` : ''}`,
      wfaStreamEnd: '✓ 流结束 — 等待 schema 校验 + 深度检查…',
      wfaAssistDisabled: 'AI 助手未启用 — 设置 GOTONG_ASSISTANT_PROVIDER + 对应 API key 后重启 host',
      wfaGenFailed: (e) => `生成失败:${e}`,
      wfaGenerateBtn: '生成草稿',
      wfaSaving: '保存中…',
      wfaSaveFailed: (e) => `保存失败:${e}`,
      wfaSavedOk: (id) => `已保存 workflow ${id}`,
      usgGroupUser: '用户',
      usgGroupAgent: '智能体',
      usgGroupWorkflow: '工作流',
      usgGroupModel: '模型',
      usgGroupDay: '按天',
      usgGroupPeer: '联邦对端',
      usgTitle: '用量 / 成本',
      usgIntro:
        '从用量账本(usage ledger)按维度汇总 token 与成本。成本由服务端按模型价目表算好(整数 micro-USD),这里换算成美元显示;未知模型记 token、成本计 0。价目可用 <code>&lt;GOTONG_SPACE&gt;/pricing.json</code> 覆盖。',
      usgGroupByLabel: '分组',
      usgRefreshBtn: '刷新',
      usgColDimension: '维度',
      usgColCalls: '调用数',
      usgColInputTokens: '输入 token',
      usgColOutputTokens: '输出 token',
      usgColCostUsd: '成本(USD)',
      usgLoadingCell: '加载中...',
      usgTotal: '合计',
      usgExportTitle: '导出',
      usgExportHint: '下载完整账本或审计日志(最多 10000 行)。',
      usgDlLedgerCsv: '账本 CSV',
      usgDlLedgerJsonl: '账本 JSONL',
      usgDlAuditCsv: '审计 CSV',
      usgDlAuditJsonl: '审计 JSONL',
      usgLoading: '加载...',
      usgLoadedN: (n) => `已加载 ${n} 行`,
      usgHostDisabled: 'host 未启用用量账本',
      usgLoadFailed: (e) => `加载失败:${e}`,
      usgEmpty: '还没有用量数据。一旦有 LLM 调用产生 token,这里会自动出现。',
      qtaTitle: '组织配额(软上限)',
      qtaIntro: '阈值跨越时会写入审计日志(<code>org_quota_warn</code> / <code>org_quota_over</code> / <code>org_quota_recover</code>)。配额为软限,不阻断 LLM 调用;真正硬阻断由 per-user 配额负责。',
      qtaRefreshBtn: '刷新',
      qtaColMetric: 'Metric',
      qtaColPeriod: 'Period',
      qtaColUsageQuota: '用量 / 配额',
      qtaColPct: '%',
      qtaColState: 'State',
      qtaColWarnPct: 'warnPct',
      qtaColLastSweep: 'last sweep',
      qtaLoadingCell: '加载中...',
      qtaFormTitle: '新增 / 修改配额',
      qtaFormHint: '同 (metric, period) 再次提交即覆盖既有值;不重置已累计的用量。',
      qtaSaveBtn: '保存',
      qtaLoading: '加载...',
      qtaLoadedN: (n) => `已加载 ${n} 条`,
      qtaLoadFailed: (msg) => `加载失败:${msg}`,
      qtaEmpty: '还没有配额。在下方表单新增。',
      qtaSweepTip: (live, last) => `host sweep 还没跑到这个状态(实时:${live} / 上次扫描:${last});审计日志要等下次 sweep 才补上`,
      qtaDisabledDenom: '0 (禁用)',
      qtaSweepStale: '⚠ sweep stale',
      qtaEditBtn: '编辑',
      qtaDelBtn: '删除',
      qtaConfirmDelete: (metric, period) => `删除 ${metric} / ${period} 的配额?`,
      qtaDeleted: '已删除',
      qtaDeleteFailed: (msg) => `删除失败:${msg}`,
      qtaMetricRequired: 'metric 必填',
      qtaQuotaInvalid: 'quota 必须是非负整数',
      qtaWarnPctInvalid: 'warnPct 必须是 1~99 的整数',
      qtaSaved: '已保存',
      qtaSaveFailed: (msg) => `保存失败:${msg}`,
      repTitle: 'Peer 信誉(reputation)',
      repMeta: 'EWMA(α=0.7)的滑动平均,从 hub.feedback ledger 派生。范围 <code>[-1, +1]</code>;调度器按分数降序排候选 peer(详见 <code>docs/zh/REPUTATION-ROUTING.md</code>)。本面板只读 — 想压低评分请写负反馈,不要手动重置。',
      repRefresh: '刷新',
      repColPeer: 'Peer',
      repColScore: 'Score',
      repColSamples: '样本数',
      repColUpdated: '最近更新',
      repLoadingCell: '加载中...',
      repLoadingStatus: '加载...',
      repLoadedN: (n) => `已加载 ${n} 个 peer`,
      repNotEnabled: 'host 未启用 reputation snapshot',
      repLoadFailed: (msg) => `加载失败:${msg}`,
      repEmpty: '还没有反馈数据。一旦跨 hub 任务跑过 + feedback ledger 有写入,这里会自动出现。',
      contribToggleTitle: '是否将我派发的任务计入贡献榜',
      setupTitle: '首次设置 — 给 owner 设密码',
      setupIntro: 'host 已启动,但 owner 账号还没设密码。在<strong>本机</strong>(<code>127.0.0.1</code>)上设置一次,以后用 Email + 密码登录。<br>反向代理后的部署请改用 CLI: <code>gotong-host mint-admin-token</code>。',
      setupPwNew: '新密码 (至少 12 位)',
      setupPwConfirm: '再输一次',
      setupSubmit: '设置密码',
      setupSubmitMeta: '完成后进入下一步,配置 AI 模型 Key。',
      setupKeyTitle: '第二步 (可选) — 配置 AI 模型 Key',
      setupKeyIntro: '填一个模型 Key,你创建的第一个智能体就能直接跑。Key 只存在本机的加密保险库,绝不外传。也可以跳过,以后在「凭证」里再配。',
      setupKeyProvider: '模型提供方',
      setupKeyProviderDeepseek: 'DeepSeek (推荐 · 性价比高)',
      setupKeyProviderAnthropic: 'Anthropic (Claude)',
      setupKeyProviderOpenai: 'OpenAI',
      setupKeyInput: 'API Key',
      setupKeyPlaceholder: '粘贴你的 API Key',
      setupKeySubmit: '保存并完成',
      setupKeySkip: '跳过,以后再配',
      setupKeyNeed: '请填入 API Key,或点「跳过」。',
      setupKeySaving: '保存中…',
      setupKeySaved: 'Key 已保存,进入下一步…',
      // DEPLOY-B2 — first-run IM step (wizard step 3).
      setupImTitle: '第三步 (可选) — 接一个 IM 机器人',
      setupImIntro: '填一个机器人凭证,成员就能直接在聊天软件里用这个 hub(出站长连接,家里电脑不用公网)。token 只存本机加密保险库。也可以跳过,以后用环境变量配。',
      setupImPlatform: '平台',
      setupImPlatformTelegram: 'Telegram (找 @BotFather 建机器人)',
      setupImPlatformLark: '飞书 / Lark (企业自建应用)',
      setupImToken: 'Bot Token',
      setupImTokenPlaceholder: '粘贴 BotFather 给的 token',
      setupImAppId: 'App ID',
      setupImAppSecret: 'App Secret',
      setupImSubmit: '保存并启动机器人',
      setupImSkip: '跳过,以后再配',
      setupImNeedToken: '请填入 Bot Token,或点「跳过」。',
      setupImNeedLark: '请填入 App ID 和 App Secret,或点「跳过」。',
      setupImSaving: '保存并启动中…',
      setupImSavedLive: '机器人已上线!去登录,然后在「我的」里领绑定码私信它。',
      setupImSavedRestart: 'token 已保存,重启 host 后机器人上线。去登录…',
      // ease-of-use ①TC — "test connection" probe (shared by the setup wizard
      // key step AND the admin agent-create form). The verdict `code` → 人话
      // mapping lives in describeKeyTest() below; these are its strings.
      testConnBtn: '测试连接',
      testConnHint: '会用你填的 Key 向模型方发一次最小请求来验证。只用来测试,不保存、不外传。',
      testConnTesting: '测试中…',
      testConnNeedKey: '请先填入 API Key 再测试。',
      testConnOk: (model, ms) => `连接成功 ✓（模型 ${model}，${ms}ms）`,
      testConnInvalidKey: 'Key 无效或未授权 — 检查是否复制完整、提供方是否选对。',
      testConnInsufficientQuota: '余额/额度不足 — 这个 Key 没钱了或超出了配额。',
      testConnRateLimited: '触发限流 — 稍等片刻再试(Key 本身可能没问题)。',
      testConnNotFound: '模型或端点不存在 — 检查 Base URL 和模型名。',
      testConnBadRequest: '请求被拒 — 可能选错了提供方或 Base URL。',
      testConnUpstream: '对方服务暂时出错 — 稍后再试。',
      testConnNetwork: '连不上 — 检查网络或 Base URL。',
      testConnTimeout: '超时 — 网络慢或端点无响应。',
      testConnUnknown: '测试失败(未知错误)。',
      // ease-of-use ③TC — short, actionable fix hints appended to a friendly
      // error (describeError in app-core.js maps an error code → one of these).
      errFixKey: '→ 去「API Key 管理」检查或补一个 key。',
      errFixModel: '→ 检查模型名是否填对。',
      errFixProvider: '→ 确认提供方 / Base URL 选对了。',
      // Additive to testConnNetwork ("连不上 — 检查网络或 Base URL"): that line
      // already says network/Base-URL, so the hint points at what it doesn't —
      // is the provider actually reachable, is the port right.
      errFixNetwork: '→ 确认服务商在线、端口没填错。',
      // ease-of-use ②TC — after a CREATE, the user is nudged to talk to the
      // brand-new agent right here and see it respond. The reply comes from the
      // agent itself (reuses the wait:true dispatch path).
      quickChatTitle: '✅ 助手已就位 — 现在跟它说句话试试',
      quickChatHint: '随便发一句，确认它真的会回应你。回应来自它本人。',
      quickChatInputLabel: '你的消息',
      quickChatSend: '发送',
      quickChatDone: '完成',
      quickChatSending: '发送中…',
      quickChatNeedMsg: '先输入一句话再发送。',
      quickChatOk: '回应来了 ✓',
      quickChatNoResult: '没有拿到回应（可能超时）。',
      quickChatFailed: (msg) => `发送失败：${msg}`,
      quickChatAgentFailed: (reason) => `它没能回应：${reason}`,
      loginTitle: '登录 Gotong',
      loginPassword: '密码',
      loginTotp: '两步验证码',
      loginTotpPlaceholder: '6 位验证码',
      loginSubmit: '登录',
      loginNoAccount: '还没有账号? 联系 owner 给你创建,或者用收到的邀请链接 (<code>/invite/&lt;token&gt;</code>) 注册。',
      loginSsoOr: '或',
      navMain: '主导航',
      tabHome: '我的',
      tabUsers: '用户',
      tabQuotas: '配额',
      tabUsage: '用量',
      tabReputation: '信誉',
      tabSettings: '设置',
      // REL-8c — /me member workspace + settings static HTML
      meWhoami: '当前用户',
      meDispatchTitle: '触发新一次工作流',
      meDispatchHint: '你只能为自己发起:归属字段由系统自动绑定到你的 userId,你看不到也改不了 — 不同用户的记录互不可见。',
      meSelectWorkflow: '选择工作流',
      meDispatchBtn: '发起',
      meWfEditTitle: '用大白话改这个工作流',
      meWfEditHint1: '不用写 YAML — 用一句话说你想怎么改上面选中的工作流(例如「把第一步的提示语改得更礼貌些」「加一步先让我确认」)。需要 editor 权限。',
      meWfEditHint2: '⚠️ 如果这个工作流连着别的 hub,跨 hub 的<strong>出入口</strong>(谁能触发、发去哪个 hub、带什么数据)锁定不可改 — 你只能改自己这边的步骤。',
      meWfEditLoadBtn: '打开编辑器',
      meRunsTitle: '最近运行',
      meRunsHint: '你最近发起的工作流运行,只显示你自己的记录。',
      meColWorkflow: '工作流',
      meColStatus: '状态',
      meColStart: '开始',
      meColEnd: '结束',
      meNotLoaded: '尚未加载',
      meInboxTitle: '待处理任务',
      meInboxHint: '工作流在某一步需要你拍板时,会出现在这里。处理后工作流会带着你的决定继续往下走。',
      meReportsTitle: '我的报告',
      meColFile: '文件',
      meColSize: '大小',
      meColTime: '时间',
      meAgentsTitle: '我的 AI 助手',
      meAgentsHint: '管理员配置好、你可以通过上面的工作流间接调用的智能体。系统提示词 / 密钥等敏感配置不会展示。',
      meOwnTitle: '我自己搭的助手',
      meOwnHint: '用你的话搭一个属于你自己的 AI 助手。优先用机构配置的模型额度（按用量计费）；机构没配的话，就用你在下方「我的 API 密钥」里加的自带 key。只有你能看到 / 修改 / 删除它。',
      meOwnHandle: '短名（英文/数字，创建后不可改）',
      meOwnLabel: '显示名',
      meOwnLabelPh: '我的中文写手',
      meOwnCaps: '能力标签（逗号或空格分隔）',
      meProvider: '模型供应商',
      meOwnModel: '模型（可选，留空用默认）',
      meOwnSystem: '系统提示词（告诉它你要它做什么）',
      meOwnSystemPh: '你是我的中文写作助手……',
      meOwnCancel: '取消编辑',
      meCredTitle: '我的 API 密钥',
      meCredHint: '给你自己的助手配一把你自己的模型密钥（自带 key）。当机构没有为该供应商配置密钥时，你的助手会用这把。密钥加密保存，存进去后不再显示；只有你能管理。',
      meCredKey: 'API 密钥',
      meCredLabel: '备注（可选）',
      meCredLabelPh: '我的个人 key',
      meCredSubmit: '保存密钥',
      // Personal Butler M6c — "what it remembers about you" privacy view (被遗忘权)
      meButlerMemTitle: '管家记得你什么',
      meButlerMemHint: '你的管家会记住一些关于你的长期信息（你在做的项目、你的偏好），好在下次对话时记得你。这里能看到它记下的一切，随时忘掉单条或全部，也可以导出。只有你能看、只有你能删。',
      meButlerMemRefresh: '刷新',
      meButlerMemExport: '导出全部',
      meButlerMemForgetAll: '忘掉全部',
      meButlerMemProfile: '它对你的长期了解',
      meButlerMemRecent: '最近记下的',
      meButlerMemLastDream: (promoted, pruned) =>
        `上次复盘：提升 ${promoted} 条进画像 / 封存 ${pruned} 条陈旧记忆`,
      meButlerMemLastMaint: (summary) =>
        summary ? `上次维护：${summary}` : '上次维护：无需改动',
      meButlerMemKindSemantic: '画像',
      meButlerMemKindEpisodic: '记录',
      meButlerMemForget: '忘掉这条',
      meButlerMemLoading: '加载中…',
      meButlerMemEmpty: '它还没记下任何关于你的东西。',
      meButlerMemForgetConfirm: '让管家忘掉这一条？此操作无法撤销。',
      meButlerMemForgetAllConfirm: '让管家忘掉关于你的全部记忆？此操作无法撤销。',
      meButlerMemForgotten: '已忘掉。',
      meButlerMemExported: (n) => `已导出 ${n} 条记忆。`,
      meButlerMemTierPersona: '画像',
      meButlerMemTierProjects: '项目',
      meButlerMemTierPeople: '人物',
      meButlerMemTierCommitments: '承诺',
      meButlerMemTierMisc: '其它',
      meButlerMemLevelDigest: '中层摘要',
      meButlerMemLevelProfile: '稳定画像',
      meButlerMemImportance: (n) => `重要度 ${n}`,
      meButlerMemActive: '有效中',
      meButlerMemClosed: '已失效',
      meButlerMemRecalls: (n) => `回想 ${n} 次`,
      meButlerMemLinks: (n) => `关联 ${n}`,
      meButlerMemProcedure: '步骤',
      setAccount: '账号',
      setLogout: '登出',
      setChangePw: '修改密码',
      setCurrentPw: '当前密码',
      setNewPw: '新密码 (至少 12 位)',
      setSubmit: '提交',
      setMfa: '两步验证 (2FA)',
      setSimpleMode: '界面模式',
      setSimpleModeHint: '简单模式只保留常用标签页 (总览 / 智能体 / 工作流 / 任务 / 用量),把联邦、用户、SSO 等高级功能收起来。随时可切回完整界面 — 不影响任何权限。',
      setSimpleModeLabel: '开启简单模式',
      setPersonalMode: '个人模式',
      setPersonalModeHint: '当前是个人模式 (1 用户, 简化界面)。升级后开放完整 admin 控件 — 用户管理 / 邀请 / peer / 配额。',
      // REL-8d — admin modals + static HTML (disclaimer / growth reports / wf-assist / wf-start / bundle import)
      importBundle: '导入团队 (bundle)',
      wfAssistBtn: 'AI 助手 (beta)',
      close: '关闭',
      download: '下载',
      disclaimerTitle: '欢迎使用 Gotong · 先看几条',
      disclaimerP1: '<strong>1. 这是个人本地工具,不是云服务。</strong>你的对话、画像、报告、API key 都存在你这台机器的 <code>.gotong-*</code> 目录里。我们不收集任何数据,host 也不上报任何遥测。',
      disclaimerP2: '<strong>2. LLM 推理走第三方 API。</strong>你的 4 段自述会发给你配置的模型供应商(DeepSeek / Anthropic / OpenAI 等)做推理。供应商各自有自己的数据政策,看他们的隐私条款。如果有顾虑,可以用 mock provider 或本地 LLM。',
      disclaimerP3: '<strong>3. 这不是医生 / 心理咨询师 / 财务顾问 / 关系治疗师的替代品。</strong>个人成长教练们都被设计成"有边界的陪伴者"——触及红旗信号会让你去找专业人。不要把它们当成诊断或处方。',
      disclaimerP4: '<strong>4. 如果你正在心理危机中,请立即联系:</strong>',
      disclaimerCrisisCn1: '🇨🇳 北京心理危机研究与干预中心:<strong>010-82951332</strong>',
      disclaimerCrisisCn2: '🇨🇳 全国心理援助热线:<strong>400-161-9995</strong>',
      disclaimerCrisisIntl: '🌏 其他地区:<a href="https://findahelpline.com" target="_blank" rel="noopener">findahelpline.com</a>',
      disclaimerP5: '<strong>5. 你可以随时删除自己的数据。</strong>停掉 host,删除 <code>.gotong-*</code> 目录即可彻底清掉。',
      disclaimerAccept: '我看完了,开始用',
      growthReportsTitle: '成长报告',
      growthReportsHint: '个人成长工作流跑完一轮后,综合规划师把 7 段产出汇总成一篇 Markdown 报告,落在这里。点"下载"把它存成本地文件。',
      growthReportsEmpty: '还没有报告 — 跑一次"个人成长发展路径"工作流就会出现。',
      colGeneratedTime: '生成时间',
      colActions: '操作',
      wfAssistModalTitle: '工作流架构师 — 生成工作流草稿',
      wfAssistModalHint: '用一句话描述你想要的工作流(中文 / 英文都行)。AI 会按 <code>gotong.workflow/v1</code> 生成 YAML 草稿,自动 validate 通过后才能保存。',
      wfAssistDescLabel: '描述',
      wfAssistDescPh: '例:每周一爬 5 个新闻源、用 DeepSeek 总结、发到 Telegram 群',
      wfAssistGenerate: '生成草稿',
      wfAssistStreaming: 'LLM 正在生成中…',
      wfAssistStatusLabel: '状态:',
      wfAssistYamlSummary: 'YAML 草稿',
      wfAssistErrorSummary: '校验错误',
      wfAssistDeepcheckSummary: '深度检查警告',
      wfAssistSave: '保存为工作流',
      wfAssistRegenerate: '重新生成',
      // workflow-architect ARCH-M4 — depth selector + diagram + explain mode.
      wfAssistDepthLabel: '讲解深度',
      wfAssistDepthOneliner: '一句话',
      wfAssistDepthBrief: '简要',
      wfAssistDepthDetailed: '详细',
      wfAssistGraphLabel: '流程图',
      wfAssistGraphDownload: '下载 SVG',
      wfaArchExplainTitle: (id) => `工作流架构师 — 解释「${id}」`,
      wfaArchExplainBtn: '讲解',
      wfaArchExplainLoadFailed: '加载工作流失败',
      wfStartTitle: '开始工作流',
      wfStartSubmit: '派发任务',
      bundleImportHint: 'gotong.bundle/v1 格式 — 一个文件包含一组 agent + 一条 workflow + API key 输入提示。导入后所有 agent 一次创建,workflow 自动注册,可直接派发。',
      bundleImportTemplates: '模板：<a href="https://github.com/Gotong/Gotong/tree/main/templates/bundles" target="_blank" rel="noopener">templates/bundles/</a> · 或用内置模板:',
      bundleBuiltinPg: '🎁 用内置模板:个人成长 (7 教练 + 12 周墙上计划)',
      bundleKeyPh: '为 openai-compatible 类 agent 一次性填 key (留空跳过)',
      bundleKeyHint: '如果 bundle 里有 <code>openai-compatible</code> 类 agent (e.g. DeepSeek),粘贴一次 API key,自动应用到所有该类 agent — 不再需要逐个手填。',
      lbWindowAria: '时段',
    },
    en: {
      subtitle: 'communication space',
      connecting: 'connecting…',
      connected: 'connected',
      reconnecting: 'reconnecting…',
      unreachable: 'cannot reach server',
      langButton: '中',
      langTitle: '切换到中文',
      workerBadge: 'worker',
      logout: 'log out',
      switchToWorker: '→ Worker',
      switchToAdmin: '→ Admin',
      participants: 'Online',
      noParticipants: 'no one online',
      noCaps: 'no caps',
      load: 'load',
      pKind: { agent: 'agent', human: 'human' },
      transcript: 'Transcript',
      pending: 'Pending for humans',
      noPending: 'no pending tasks',
      untitled: '(untitled)',
      approve: 'Approve',
      reject: 'Reject',
      retry: 'Retry',
      joinSpace: 'Join the space',
      nickname: 'Nickname (ID)',
      capabilitiesLabel: 'Capabilities (comma-separated, optional)',
      capabilitiesPlaceholder: 'e.g. review, translate',
      joinButton: 'Join',
      leaveButton: 'Leave',
      myTasksLabel: 'Tasks for you',
      noMyTasks: 'no tasks assigned to you',
      adminTitle: 'Admin console',
      // --- admin tab labels ---
      tabOverview: 'Overview',
      tabAgents: 'Agents',
      tabWorkflows: 'Workflows',
      tabTasks: 'Tasks',
      tabActivity: 'Activity',
      tabServices: 'Services',
      tabMcp: 'MCP',
      tabFederation: 'Federation',
      tabOidc: 'SSO',
      tabSaml: 'SAML',
      // --- MCP integration tab (#2-M4) ---
      mcpPanel: 'MCP Integration',
      mcpIntro: 'Install external MCP servers into the hub; agents opt in by name in their Edit form to get the tools. Reference credentials with ${ENV}, never paste plaintext.',
      mcpDisabled: 'MCP registry not enabled on this host',
      mcpEmpty: 'No MCP servers installed yet',
      mcpName: 'Name',
      mcpTransport: 'Transport',
      mcpTarget: 'Target',
      mcpDescriptionCol: 'Description',
      mcpInstallTitle: 'Install an MCP server',
      mcpCommand: 'Command',
      mcpArgs: 'Args (space-separated)',
      mcpEnv: 'Env (KEY=value per line)',
      mcpUrl: 'URL',
      mcpHeaders: 'Headers (Name=value per line)',
      mcpDescriptionField: 'Description (optional)',
      mcpInstallBtn: 'Install',
      mcpUninstall: 'Uninstall',
      mcpInstalled: 'Installed',
      mcpConfirmUninstall: (name) => `Uninstall '${name}'? Running agents that opted in will lose its tools.`,
      mcpAgentOptIn: 'MCP integrations (checked = this agent may call)',
      mcpAgentOptInEmpty: 'No MCP integrations available yet. Install one on the “MCP” tab.',
      mcpAgentFedHeading: 'Shared by peers (cross-hub)',
      mcpAgentOffline: '(currently unreachable)',
      mcpShared: 'Shared to peers',
      mcpSharedHint: 'When checked, agents on peer hubs can call this server’s tools over the federation link; its credentials / subprocess stay on this host.',
      // --- MCD-M3: built-in connector directory ---
      mcpDirTitle: 'Browse built-in connectors',
      mcpDirIntro: 'Pick a ready-made MCP component and install it with one click. Don’t see what you need? Install “MCP registry search” and let an agent search the mainstream registry live.',
      mcpDirHomepage: 'Homepage',
      mcpDirNeedsEnv: (vars) => `Set ${vars} in the host environment (variable names only — secrets are never stored)`,
      mcpDirInstalledMsg: (name) => `Installed “${name}”. See it in the list above, or tick it by name on an agent’s Edit form.`,
      mcpDirCat: { discovery: 'Discovery', rag: 'RAG', notes: 'Notes', search: 'Search', files: 'Files', web: 'Web' },
      // --- services tab (v2.2) ---
      servicesPanel: 'Hub Services',
      servicesEmpty: 'No service plugins registered',
      servicesPlugin: 'Plugin',
      servicesOwner: 'Owner',
      servicesSize: 'Size',
      servicesItemCount: 'Items',
      servicesLastAccess: 'Last access',
      servicesActions: 'Actions',
      servicesDelete: 'Trash',
      servicesDetail: 'Details',
      servicesTrashTitle: 'Trash',
      servicesTrashEmpty: 'Trash is empty',
      servicesTrashRestore: 'Restore',
      servicesTrashHardDelete: 'Delete forever',
      servicesTrashedAt: 'Deleted',
      servicesExpiresAt: 'Expires',
      servicesTrashReason: 'Reason',
      servicesSweepBtn: 'Purge expired now',
      servicesSweepResult: (s, p) => `Scanned ${s}, purged ${p}`,
      servicesToastTrashed: 'Moved to trash — auto-deletes in 30 days',
      servicesToastRestored: 'Restored from trash',
      servicesToastHardDeleted: 'Permanently deleted',
      servicesConfirmHardDelete: 'Delete forever? This cannot be undone.',
      servicesDisabled: 'Hub Services are not enabled on this host',
      // --- v1.1 services-over-ws additions ---
      appServicesRequested: 'Services requested',
      // v1.2: per-decl method ACL placeholder shown when client did not narrow
      appServicesMethodsAny: '(any method)',
      servicesAuditTitle: 'SERVICE_CALL audit',
      servicesAuditEmpty: 'No remote service calls recorded yet',
      refresh: 'Refresh',
      auditTime: 'Time',
      auditAgent: 'Agent',
      auditService: 'Service',
      auditOwner: 'Owner',
      auditMethod: 'Method',
      auditOutcome: 'Outcome',
      auditDuration: 'Duration',
      pendingAgents: 'Pending agent admissions',
      noPendingAgents: 'No pending admissions',
      remoteAddress: 'remote',
      clientLabel: 'client',
      pendingSince: 'since',
      rejectReason: 'Reject reason (optional)',
      dispatchPanel: 'Dispatch a task',
      strategyKind: 'Strategy',
      strategyExplicit: 'Explicit participant',
      strategyCapability: 'By capability',
      strategyBroadcast: 'Broadcast',
      dispatchTo: 'Target ID',
      dispatchCaps: 'Capabilities (comma-separated)',
      dispatchTitle: 'Title (optional)',
      dispatchPayload: 'Payload (JSON)',
      dispatchPriority: 'Priority (integer, optional)',
      dispatchButton: 'Dispatch',
      dispatchSuccess: 'Dispatched — watch the transcript for the result',
      tasksPanel: 'Tasks',
      tasksFilterAll: 'All',
      tasksFilterPending: 'In flight',
      tasksFilterDone: 'Done',
      tasksFilterFailed: 'Failed',
      noTasks: 'no tasks yet',
      taskStatusPending: 'pending',
      taskStatusDone: 'done',
      taskStatusFailed: 'failed',
      taskStatusCancelled: 'cancelled',
      evaluatePanel: 'Evaluate a task',
      evaluateTaskId: 'task ID',
      evaluateRating: 'Rating (1-5, optional)',
      evaluateComment: 'Comment (optional)',
      evaluateButton: 'Submit',
      evaluateSuccess: 'Evaluation recorded',
      evaluateEmpty: 'Enter a rating or a comment before submitting',
      pickTaskHint: 'Click a task_result row in the transcript to autofill task ID',
      // --- expandable task detail panel ---
      taskIdHint: 'Click to expand and fill the evaluation form',
      detailCreated: 'Created',
      detailCompleted: 'Completed',
      detailDuration: 'Duration',
      detailPayload: 'Payload',
      detailOutput: 'Output',
      detailUsage: 'tokens',
      detailBy: 'by',
      detailStopReason: 'stop reason',
      detailEvaluations: 'Past evaluations',
      detailEvaluate: 'Rate this task',
      detailCommentOnly: 'comment only',
      knownRoster: 'Roster on disk',
      knownAdmins: 'Admins',
      knownWorkers: 'Workers',
      // --- contribution system (v2.1) ---
      dispatchWeight: 'Weight (0.1–10, 1 decimal, default 1.0)',
      weightLabel: 'weight',
      ratingLabel: 'rating',
      contributionLabel: 'score',
      unrated: 'unrated',
      leaderboardTitle: 'Leaderboard',
      lbWindowAll: 'all time',
      lbWindowToday: 'today',
      lbWindowWeek: 'last 7 days',
      lbWindowMonth: 'last 30 days',
      lbEmpty: 'no rated contributions in this window yet',
      lbColRank: '#',
      lbColId: 'participant',
      lbColScore: 'score',
      lbColTasks: 'tasks',
      lbColAvg: 'avg',
      lbColLastSeen: 'last',
      lbColCaps: 'caps',
      lbSummary: (total, unrated) =>
        unrated > 0
          ? `${total} completed task(s) in window — ${unrated} still awaiting review`
          : `${total} completed task(s) in window — all rated`,
      contribToggleLabel: 'My dispatches feed the leaderboard',
      // --- room health banner (admin v2.1+) ---
      healthToday: "Today's tasks",
      healthTodaySub: 'done + in-flight',
      healthOnline: 'Online',
      healthOnlineSub: (agents, humans) => `${agents} agents · ${humans} humans`,
      healthUnrated: 'Unrated',
      healthUnratedSub: 'last 7 days',
      healthTop3: 'Top 3 contributors (7d)',
      healthTop3Empty: 'No rated contributions in the last 7 days',
      commonCaps: 'Common:',
      contribToggleTitleOn: 'On: tasks I dispatch are counted in the leaderboard (tasks I receive are unaffected)',
      contribToggleTitleOff: 'Off: tasks I dispatch are excluded from the leaderboard (tasks I receive are unaffected)',
      // --- managed agents (v2.1) ---
      managedAgentsTitle: 'Agents (local + cloud)',
      newAgent: '+ New local agent',
      importAgent: 'Import',
      localAgentBadge: 'local',
      cloudAgentBadge: 'cloud',
      workflowsTitle: 'Workflows',
      importWorkflow: 'Import workflow',
      workflowsHint: 'Workflows chain several agents in sequence / in parallel. Admin dispatches one task to the workflow\'s trigger capability and gets one final result back. Templates:',
      workflowImportHint: 'Accepts schema: gotong.workflow/v1 only. On import, the runner is registered immediately as a workflow:<id> participant and the file is written to .gotong/workflows/definitions/ (host auto-loads on restart).',
      workflowsEmpty: 'No workflows loaded yet',
      workflowsSummary: (count) => `${count} loaded`,
      // LIFE-L1-M3 — zero-LLM workflow-schedule card
      wfSchedTitle: 'Schedules',
      wfSchedHint: 'Run a workflow for a member on a clock (the scheduling loop is zero-LLM). The run belongs to that member — same gate as them clicking "run" in /me; members who told their butler "打开运行播报" get the result in IM.',
      wfSchedSummary: (n) => `${n} row${n === 1 ? '' : 's'}`,
      wfSchedEmpty: 'No schedules yet. Create one below — e.g. the morning brief, daily at 8.',
      wfSchedWorkflow: 'Workflow (published + member-facing)',
      wfSchedNoWorkflow: '(nothing schedulable — publish a workflow with surface.me enabled first)',
      wfSchedUser: 'Member id',
      wfSchedKind: 'Cadence',
      wfSchedKindDaily: 'Daily',
      wfSchedKindWeekly: 'Weekly',
      wfSchedKindInterval: 'Every',
      wfSchedWeekday: 'Weekday',
      wfSchedWeekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      wfSchedHour: 'Hour (0-23, default tz UTC+8)',
      wfSchedMinutes: 'Interval minutes (≥1)',
      wfSchedCreateBtn: 'Add schedule',
      wfSchedCadenceDaily: (h) => `daily ${h}:00`,
      wfSchedCadenceWeekly: (wd, h) => `${wd} ${h}:00`,
      wfSchedCadenceInterval: (min) => `every ${min} min`,
      wfSchedTz: (tz) => (tz === 480 ? '' : ` (UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz) / 60})`),
      wfSchedEnabled: 'on',
      wfSchedDisabled: 'paused',
      wfSchedInvalid: 'invalid config',
      wfSchedLastFired: (mark) => `last fired ${mark}`,
      wfSchedNeverFired: 'never fired',
      wfSchedFireBtn: 'Fire now',
      wfSchedPauseBtn: 'Pause',
      wfSchedResumeBtn: 'Resume',
      wfSchedRemoveBtn: 'Delete',
      wfSchedCreated: (id) => `Schedule ${id} created. It fires on the clock; "Fire now" verifies immediately.`,
      wfSchedFired: (wfId, userId) => `Dispatched ${wfId} once for ${userId} (ignores clock/pause, member gate still applies). See "History" for the run.`,
      wfSchedFireFail: (reason) =>
        ({
          not_found: 'Schedule not found (maybe just deleted).',
          invalid: 'This row is invalid — fix it and retry.',
          unrunnable: 'Workflow not runnable: it must be published with surface.me enabled and the role allowed.',
          dispatch_failed: 'Dispatch failed — check host logs.',
        })[reason] || reason,
      confirmRemoveSchedule: (id) => `Delete schedule "${id}"? Runs already dispatched are unaffected.`,
      workflowStepsLabel: (n) => `${n} step${n === 1 ? '' : 's'}`,
      workflowTriggerLabel: 'Trigger capability',
      workflowImportDone: (id) => `Imported workflow:${id}. Ready to dispatch. File saved to definitions/.`,
      workflowRemoveBtn: 'Remove',
      confirmRemoveWorkflow: (id) =>
        `Remove workflow "${id}"? The runner goes offline immediately and the YAML file will be deleted (no recovery). In-flight tasks already dispatched finish normally.`,
      workflowRunsBtn: 'History',
      workflowRunsTitle: 'Run history',
      workflowRunsEmpty: 'No runs recorded yet for this workflow.',
      workflowRunsPickHint: 'Pick a run on the left to see details.',
      workflowRunStepCount: (n) => `${n} step${n === 1 ? '' : 's'}`,
      workflowRunDuration: 'Duration',
      workflowRunStillRunning: 'still running',
      workflowRunLive: 'auto-refreshing…',
      workflowRunTriggeredBy: 'Trigger task',
      workflowRunTriggerPayload: 'Trigger payload',
      workflowRunFinal: 'Final output',
      workflowRunOutput: 'Output',
      workflowRunSubTasks: 'Sub-tasks',
      workflowRunNoSteps: 'No steps recorded yet.',
      workflowRunErrorRaw: 'Raw error',
      workflowRunAttempts: (n) => `${n} attempt${n === 1 ? '' : 's'}`,
      // Phase 15 — workflow lifecycle (state badge on cards + revision history)
      workflowStateLabel: (s) =>
        ({ published: 'Published', deprecated: 'Deprecated', draft: 'Draft', review: 'In review', archived: 'Archived' }[s] || s),
      workflowRevTag: (n) => `rev ${n}`,
      // DAG-M4 — read-only flow chart (graph) viewer.
      workflowGraphBtn: 'Flow chart',
      // workflow-architect ARCH-M4 — explain an existing workflow at depth.
      workflowExplainBtn: 'Explain',
      workflowGraphHeading: 'Flow chart',
      workflowGraphTrigger: 'Trigger',
      workflowGraphOutput: 'Output',
      workflowGraphParallel: 'Parallel',
      workflowGraphBranch: 'Branch',
      workflowGraphReadsTrigger: 'reads trigger',
      workflowGraphWhen: (pred) => `when ${pred}`,
      workflowGraphDestCapability: (caps) => `cap: ${caps}`,
      workflowGraphDestExplicit: (to) => `to: ${to}`,
      workflowGraphDestBroadcast: (caps) => (caps ? `broadcast: ${caps}` : 'broadcast: all'),
      workflowGraphCrossHub: (dest) => `cross-hub → ${dest}`,
      workflowGraphLegendSeq: 'solid = execution order',
      workflowGraphLegendData: 'dashed = data dependency',
      workflowGraphEmpty: 'This workflow has no steps to draw.',
      workflowGraphError: (msg) => `Failed to load flow chart: ${msg}`,
      // Phase 19 P5 — governance / risk summary on workflow cards
      workflowGovSummary: '⚠️ Risk summary',
      workflowGovSensitivity: 'Data sensitivity',
      workflowGovSensitivityLabel: (s) =>
        ({ public: 'Public', internal: 'Internal', confidential: 'Confidential', pii: 'Personal data (PII)' }[s] || s),
      workflowGovCredentials: 'Credentials needed',
      workflowGovCost: 'Est. cost/run',
      workflowGovHumanRoles: 'Human roles required',
      workflowGovExternal: 'External systems',
      // Stream G day-2 / H — off-hub step indicator on workflow cards / start dialog.
      // Two destination kinds with different behavior: a mesh peer hub may pause
      // for inbox approval (if gated); an external A2A agent fires immediately.
      workflowCrossHubSummary: (n) => `🔗 Cross-hub steps (${n})`,
      workflowCrossHubPeer: (peer) => `→ peer hub: ${peer}`,
      workflowCrossHubA2a: (dest) => `→ external A2A agent: ${dest}`,
      workflowCrossHubNote: (peerDests, a2aDests) => {
        const parts = []
        if (peerDests.length)
          parts.push(`${peerDests.length} step(s) dispatch to a peer hub (${peerDests.join(', ')}); if that peer requires approval, the run waits for your inbox sign-off before the step is sent`)
        if (a2aDests.length)
          parts.push(`${a2aDests.length} step(s) dispatch to an external A2A agent (${a2aDests.join(', ')}); these have no approval gate and fire immediately`)
        return `Note: ${parts.join('. ')}.`
      },
      // Stream G day-3 — post-launch CONFIRMATION badge on a run-detail step:
      // where it ACTUALLY ran (resolved from the persisted executedBy), as
      // opposed to the pre-launch crossHubSteps PREDICTION on the card.
      workflowRunCrossHub: (dest, kind) =>
        kind === 'a2a' ? `🔗 ran on external A2A agent ${dest}` : `🔗 ran on peer hub ${dest}`,
      // PB — the parallel analog: ONE branch of a fan-out step ran off-hub. Names
      // the branch so a mixed local+off-hub fan-out reads unambiguously.
      workflowRunBranchCrossHub: (branchId, dest, kind) =>
        kind === 'a2a'
          ? `🔗 branch "${branchId}" ran on external A2A agent ${dest}`
          : `🔗 branch "${branchId}" ran on peer hub ${dest}`,
      // Stream G day-4 — post-launch APPROVAL LOOP: a step that is both
      // `suspended` and cross-hub is parked at the outbound-approval gate,
      // awaiting a human approval in the inbox. Run-level status stays `running`
      // (RunStatus has no `suspended`), so this per-step signal is the only way
      // to tell a parked-needing-approval run from one still executing.
      workflowRunAwaitingApproval: (dest) =>
        `⏸ Awaiting your approval — the outbound request to peer hub ${dest} must be confirmed in your inbox before it is sent`,
      workflowRunGoToInbox: 'Approve in inbox →',
      workflowRunParkedApproval: (dests) =>
        `This run is paused: ${dests.length} outbound request(s) to peer hub(s) are waiting for your approval (${dests.join(', ')}). It resumes once you approve.`,
      // Stream G day-5 — the post-launch transcript CHAIN. A cross-hub step's
      // viewer pulls the FAR hub's trace of that one dispatched task (opt-in,
      // fail-closed: a peer that never set share_transcript yields fetch_failed).
      workflowRunPeerTranscriptBtn: 'View peer execution trace ▾',
      workflowRunPeerTranscriptHead: (hubId, taskId) =>
        `Peer hub ${hubId}'s trace of task ${taskId}`,
      workflowRunPeerTranscriptTruncated: '(truncated — see the peer directly for the full trace)',
      workflowRunPeerTranscriptEmpty: 'The peer returned an empty trace (no visible events for this task).',
      workflowRunPeerTranscriptFail: (code) =>
        code === 'fetch_failed' ? 'The peer has not opted into transcript sharing, or it is momentarily unavailable (fail-closed).'
        : code === 'no_link' ? 'No link to that peer was found.'
        : code === 'not_cross_hub' ? 'This step did not run cross-hub — there is no peer trace.'
        : code === 'unknown_step' ? 'That step was not found in the run.'
        : code === 'unknown_run' ? 'That run was not found.'
        : `Failed to fetch the peer trace (${code}).`,
      workflowDeprecateBtn: 'Deprecate',
      workflowRepublishBtn: 'Re-publish',
      workflowArchiveBtn: 'Archive',
      workflowRevisionsBtn: 'Revisions',
      workflowSubmitReviewBtn: 'Submit for review',
      workflowBackToDraftBtn: 'Back to draft',
      workflowPublishBtn: 'Publish',
      confirmDeprecateWorkflow: (id) =>
        `Mark "${id}" as deprecated? It disappears from the /me member surface immediately, but in-flight tasks and admin re-runs are unaffected.`,
      confirmArchiveWorkflow: (id) =>
        `Archive "${id}"? The runner goes offline and it can no longer run (revision history is kept; you can re-import).`,
      confirmPublishWorkflow: (id) =>
        `Publish "${id}"? It goes live immediately and shows on the /me member surface.`,
      confirmSubmitReview: (id) =>
        `Submit "${id}" for review? Freezes the current draft as a candidate; still not live.`,
      confirmBackToDraft: (id) => `Send "${id}" back to draft for more editing?`,
      confirmRollback: (id, rev) =>
        `Roll "${id}" back to the content of rev ${rev}? A new revision cloned from rev ${rev} is appended and set as current. In-flight / suspended tasks keep running their own original revision.`,
      workflowRevisionsTitle: 'Revision history',
      workflowRevisionsEmpty: 'No revisions yet.',
      workflowRevRollbackBtn: 'Roll back to this',
      workflowRevCurrent: 'current',
      workflowRevOrigin: (o) => ({ import: 'import', publish: 'publish', rollback: 'rollback' }[o] || o),
      // Phase 19 P2-M4 — governance audit sub-section.
      workflowAuditTitle: 'Governance audit',
      workflowAuditActionAll: 'All actions',
      workflowAuditRefresh: 'Query',
      workflowAuditEmpty: 'No audit records.',
      workflowAuditExportCsv: 'Export CSV',
      workflowAuditExportJsonl: 'Export JSONL',
      workflowAuditOwnerOnly: 'Owner role required to view the governance audit.',
      workflowAuditUnavailable: 'Audit log is not enabled on this host.',
      // Phase 19 P2-M5c — access control (resource RBAC grants).
      workflowGrantsTitle: 'Access control',
      workflowGrantsRefresh: 'Refresh',
      workflowGrantsEmpty: 'No grants yet (owner / admin only).',
      workflowGrantsUserPh: 'User ID',
      workflowGrantsAdd: 'Grant',
      workflowGrantsRemove: 'Revoke',
      workflowGrantsOwnerOnly: 'Owner role required to manage this workflow’s access control.',
      workflowGrantsUnavailable: 'Resource-level permissions are not enabled on this host.',
      workflowGrantsNeedUser: 'Enter a user ID.',
      // v5 E4-M2 — agent access control.
      agentAccessManage: 'Manage access',
      agentAccessTitle: 'Agent access control',
      agentGrantsOwnerOnly: 'Owner role required to manage this agent’s access control.',
      loading: 'Loading…',
      doImport: 'Import',
      editAgent: 'Edit local agent',
      save: 'Save',
      saveOk: 'Saved',
      savedWithWarning: (err) => `Saved, but spawn failed: ${err}`,
      edit: 'Edit',
      export_: 'Export',
      remove: 'Remove',
      online: 'online',
      offline: 'offline',
      externalAgent: 'cloud agent (external SDK)',
      providerDisabled: 'API key not set',
      agentId: 'ID (unique)',
      agentDisplayName: 'Display name (optional)',
      agentCaps: 'Capabilities (comma-separated)',
      agentProvider: 'Provider',
      agentModel: 'Model (optional)',
      agentSystem: 'System prompt',
      agentWeightDefault: 'Default task weight (optional, 0.1-10)',
      agentHeartbeatLegend: 'Proactive heartbeat',
      agentHeartbeatEnable: 'Enable proactive wake-up',
      agentHeartbeatInterval: 'Interval (minutes)',
      agentHeartbeatChecklist: 'Checklist (optional)',
      agentHeartbeatHint: 'When on, this agent wakes itself on the interval and runs a turn; it stays quiet when there is nothing to do.',
      editWarning: '⚠️ Editing restarts the agent; consider stopping ongoing tasks first.',
      templatesHint: 'Standard agent / team / workflow templates live in the repo’s templates/ directory. Open any yaml and paste into "Import" below:',
      importHint: 'Accepts YAML or JSON. Upload a file or paste content.',
      uploadFile: 'Upload file',
      orPaste: 'Or paste content',
      importEmpty: 'Upload a file or paste content',
      importDone: (created, skipped, errors) =>
        `Import done: ${created} created${skipped ? `, ${skipped} skipped (id exists)` : ''}${errors ? `, ${errors} spawn failed` : ''}`,
      // --- import menu + GitHub import ---
      importMenuLabel: 'Import ▾',
      importMenuFile: 'Upload / paste YAML',
      importMenuGithub: 'From GitHub URL',
      ghImportTitle: 'Import from GitHub',
      ghImportHint: 'Paste a GitHub link to an agent / team / workflow yaml (blob or raw both work). If GitHub is slow from your network, switch the download source below with one click.',
      ghImportUrlLabel: 'File URL',
      ghImportSourceLabel: 'Download source (one-click switch)',
      ghSourceJsdelivr: 'jsDelivr CDN (China-reachable, recommended)',
      ghSourceGhproxy: 'ghproxy mirror (China backup)',
      ghSourceGithub: 'GitHub raw (raw.githubusercontent.com)',
      ghResolvedLabel: 'Actual download URL:',
      ghImportSubmit: 'Fetch & import',
      ghImportBadUrl: 'Could not parse this URL — use github.com/<owner>/<repo>/blob/<ref>/<path> or a raw URL',
      ghFetchFailed: (msg) => `Download failed: ${msg} (try a different source)`,
      confirmRemoveAgent: (id) => `Remove agent "${id}"? Cannot be undone.`,
      maEmpty: 'No agents registered yet (local or cloud)',
      maSummary: (managed, online, external) =>
        `${managed} local (${online} online)${external > 0 ? ` · ${external} cloud` : ''}`,
      apiKeysBtn: 'API Keys',
      apiKeysModalTitle: 'Workspace API Keys',
      apiKeysHint: 'Keys here are encrypted into secrets.enc.json; plaintext never appears in any GET response. Each agent can also carry its own override key in its edit form — that takes priority.',
      apiKeySet: 'configured',
      apiKeyEnv: 'from environment',
      apiKeyMissing: 'not set',
      apiKeyUpdated: (ts) => `· updated ${new Date(ts).toLocaleString()}`,
      setKey: 'Set',
      updateKey: 'Update',
      clearKey: 'Clear',
      keyEnterHere: 'paste key, hit enter',
      keySetOk: 'Saved (encrypted)',
      keyRemoved: 'Removed',
      keyWarnRestart: 'Saved. To apply to a running agent, edit + save it (which restarts it).',
      agentApiKey: 'Private API key (optional, encrypted)',
      agentApiKeyHint: 'Empty → workspace default; "Clear" removes this agent\'s own key',
      agentApiKeyHintEdit: 'A private key is set. Empty = unchanged; new value = update; "Clear" removes it.',
      agentApiKeyHintCompat: '**Required**: openai-compatible has no workspace fallback (every baseURL is a different vendor).',
      // --- openai-compatible provider ---
      openaiCompatHint: 'DeepSeek / Qwen / Zhipu / Ollama / vLLM / …',
      agentBaseUrl: 'Base URL',
      agentBaseUrlHint: 'Any OpenAI-compatible /v1/chat/completions endpoint: DeepSeek, Qwen, Zhipu, Moonshot, Ollama, vLLM, etc.',
      agentProviderLabel: 'Provider label (optional)',
      failedAlert: (msg) => `failed: ${msg}`,
      sumJoined: (id, kind, caps) =>
        `${id} (${(I18N.en.pKind[kind] || kind)}) caps=[${caps}]`,
      sumLeft: (id) => id,
      sumMessage: (from, ch) => `${from} → #${ch}`,
      sumTask: (from, title, strategy, target) =>
        `${from} "${title}" via ${strategy} ${target}`,
      sumStrategyTo: (to) => `to=${to}`,
      sumStrategyCaps: (caps) => `caps=[${caps}]`,
      sumStrategyBroadcast: 'broadcast',
      sumOk: (by) => `ok by ${by}`,
      sumFailed: (by, err) => `failed by ${by}: ${err}`,
      sumCancelled: (reason) => `cancelled: ${reason}`,
      sumNoParticipant: (reason) => `no_participant: ${reason}`,
      sumAgentPending: (ids) => `pending approval: ${ids.join(',')}`,
      sumAgentApproved: (ids, by) => `approved: ${ids.join(',')}${by ? ` by ${by}` : ''}`,
      sumAgentRejected: (ids, reason, by) =>
        `rejected: ${ids.join(',')} · ${reason}${by ? ` by ${by}` : ''}`,
      sumEvaluation: (taskId, rating, comment, by) =>
        `${by} evaluated ${taskId.slice(0, 8)}…${rating != null ? ` · ${rating}/5` : ''}${comment ? ` · "${comment}"` : ''}`,

      // --- /me member SPA (REL-7) ----------------------------------------
      // Shared/recurring
      meLoading: 'Loading…',
      meLoadFailed: 'Load failed',
      meLoadFailedHttp: (s) => `Load failed (HTTP ${s})`,
      meLoadFailedErr: (e) => `Load failed: ${e}`,
      meSubmitting: 'Submitting…',
      meSavingDots: 'Saving…',
      meSaved: 'Saved',
      meCreated: 'Created',
      meFailedColon: (e) => `Failed: ${e}`,
      meOpFailedHttp: (s) => `Action failed (HTTP ${s})`,
      meOpFailedErr: (e) => `Action failed: ${e}`,
      meNone: 'none',
      meOnline: 'online',
      meOffline: 'offline',
      meEdit: 'Edit',
      meDelete: 'Delete',
      meRevoke: 'Revoke',
      meDownload: 'Download',
      meCancel: 'Cancel',
      meManageAccess: 'Manage access',
      meRoleWord: 'role',
      meDeleteFailedErr: (e) => `Delete failed: ${e}`,
      // Role labels + subtitles
      meRoleOwner: 'Owner',
      meRoleAdmin: 'Admin',
      meRoleMember: 'Member',
      meRoleViewer: 'Viewer',
      meNotSignedIn: 'Not signed in',
      meSubtitleAdmin: 'Admin console',
      meSubtitleMember: 'My workflows',
      meSubtitlePersonal: 'My AI Desktop',
      // Setup wizard
      meSetupSettingUp: 'Setting up…',
      meSetupPwMismatch: 'Passwords do not match',
      meSetupPwTooShort: 'Password must be at least 12 characters',
      meSetupFailedHttp: (s) => `Setup failed (HTTP ${s})`,
      meSetupDone: 'Password set — sign in now…',
      meSetupFailedErr: (e) => `Setup failed: ${e}`,
      // Login
      meLoginLoggingIn: 'Signing in…',
      meLoginTotpWrong: 'Wrong code, please try again',
      meLoginTotpNeeded: 'Enter your two-factor code',
      meLoginFailedHttp: (s) => `Sign-in failed (HTTP ${s})`,
      meLoginOk: 'Signed in — loading…',
      meLoginFailedErr: (e) => `Sign-in failed: ${e}`,
      meSsoFailed: (e) => `Single sign-on failed: ${e}`,
      meSsoButton: (n) => `Sign in with ${n}`,
      // Workflow catalog
      meNoWorkflows: 'No workflows available',
      meNoWorkflowsYet: 'No workflows available yet',
      meNoMemberWorkflowsPre: 'No member-facing workflows yet — an admin can enable ',
      meNoMemberWorkflowsPost: ' in a workflow definition.',
      meWfNoFields: 'This workflow needs no extra fields.',
      // Dispatch
      meSelectWfFirst: 'Pick a workflow first',
      meDispatchFailedHttp: (s) => `Dispatch failed (HTTP ${s})`,
      meDispatched: (id) => `Dispatched — run id: ${id}`,
      meDispatchFailedErr: (e) => `Dispatch failed: ${e}`,
      // Workflow edit (NL boundary)
      meWfEditTrigger: 'Ingress (trigger capability): ',
      meWfEditDataClasses: (c) => `(data classes ${c})`,
      meWfEditEgressStep: 'Egress step ',
      meWfEditEgressArrow: ' → cross-hub capability ',
      meWfEditLockedTitle:
        '🔒 This workflow links to another hub. The cross-hub ingress/egress below is locked — you can only edit your own steps:',
      meWfEditLocalTitlePre:
        '✅ This workflow runs only inside this hub, so you can freely edit the steps.',
      meWfEditLocalTitlePost: '(Only the ingress ',
      meWfEditLocalTitleEnd: ' is locked.)',
      meWfEditViewYaml: 'View current workflow definition (YAML)',
      meWfEditInstructionLabel: 'Describe your change in one sentence',
      meWfEditInstructionPlaceholder: 'e.g. make the first step’s prompt more polite',
      meWfEditApplyBtn: 'Apply',
      meWfEditNotEditable: 'This workflow cannot be edited in its current state (under review or archived).',
      meWfEditSelectFirst: 'Pick a workflow above first.',
      meWfEditOpenFirst: 'Open a workflow editor first.',
      meWfEditDescribeFirst: 'Describe your change in one sentence.',
      meWfEditAiWorking: 'Letting the AI edit… (may take a few seconds)',
      meWfEditStreamBroken:
        'Connection dropped, no result received. The change may still be saving in the background — refresh to check.',
      meWfEditPublished: 'published live',
      meWfEditDraftSaved: 'saved as draft',
      meWfEditSuccessLine: (applied, expl) => `✅ ${applied}. ${expl}`,
      meWfEditChatSuccess: (applied, expl) => `${applied}. ${expl}`,
      meWfEditChatFailure: (t, v) => `Failed: ${t}${v ? ` (${v})` : ''}`,
      meWfEditSaveFailedErr: (e) => `Save failed: ${e}`,
      meWfEditAiTyping: '✨ AI is typing…',
      meWfEditViewDiff: 'View this change',
      meWfDiffSkip: (n) => `… ${n} unchanged line(s) …`,
      meWfEditChatHistory: 'Edits in this session',
      meWfEditChatYou: 'You: ',
      meWfErrForbidden: 'You do not have edit permission on this workflow (editor required).',
      meWfErrNotFound: 'Workflow not found.',
      meWfErrNoSource: 'This workflow has no editable source definition.',
      meWfErrUnderReview: 'This workflow is under review and cannot be edited.',
      meWfErrArchived: 'This workflow is archived and cannot be edited.',
      meWfErrBoundaryLocked: 'This change touched the cross-hub ingress/egress — you can only edit your own steps.',
      meWfErrAssistantFailed: 'The AI could not produce a valid workflow — try rephrasing.',
      meWfErrParseFailed: 'The AI output failed to parse — try rephrasing.',
      meWfErrIdChanged: 'The workflow id cannot be changed.',
      meWfErrStructureFailed: 'The generated workflow failed structure validation.',
      meWfErrAssistantUnavailable: 'The AI assistant is currently unavailable (not configured by an admin).',
      // ARCH-M7 — workflow architect: NL create + explain (member SPA).
      meWfExplainTitle: 'Understand this workflow',
      meWfExplainHint:
        'Let the Workflow Architect explain, in plain language, what the workflow selected above does — and draw its flowchart. You choose how detailed.',
      meWfDepthLabel: 'Explanation depth',
      meWfDepthOneliner: 'One line',
      meWfDepthBrief: 'Brief',
      meWfDepthDetailed: 'Detailed',
      meWfExplainBtn: 'Explain this workflow',
      meWfExplainSelectFirst: 'Pick a workflow above first.',
      meWfExplainResultHead: (id) => `Workflow “${id}”`,
      meWfCreateTitle: 'Create a workflow in plain language',
      meWfCreateHint:
        'No YAML needed — describe the automation you want in one sentence and the Workflow Architect drafts one for you, with a flowchart. New workflows are saved as a draft (never auto-published) and run only inside this hub.',
      meWfCreatePlaceholder:
        'e.g. every morning, summarize the new emails in my inbox into a paragraph, then ask me whether to reply',
      meWfCreateBtn: 'Draft it for me',
      meWfCreateDescribeFirst: 'Describe the workflow you want in one sentence.',
      meWfCreateResultHead: (id) => `New workflow draft “${id}”`,
      meWfCreateSuccessLine: (id) => `✅ Drafted and saved as a draft: ${id} (not live yet)`,
      meWfCreateChatHistory: 'What you created in this session',
      meWfCreateChatYou: 'You: ',
      meWfCreateChatSuccess: (id) => `Drafted: ${id}`,
      meWfCreateChatFailure: (msg) => `Failed: ${msg}`,
      meWfArchDownloadSvg: 'Download flowchart (SVG)',
      meWfArchViewYaml: 'View workflow definition (YAML)',
      meWfArchWorking: 'Letting the Workflow Architect work… (may take a few seconds)',
      meWfArchAiTyping: '✨ Workflow Architect is typing…',
      meWfArchStreamBroken: 'Connection dropped, no result received. Please refresh or retry.',
      meWfArchSaveFailedErr: (e) => `Draft failed: ${e}`,
      meWfArchLoadFailedErr: (e) => `Explain failed: ${e}`,
      meWfArchBadRequest: 'The request was malformed — please retry.',
      meWfArchCrossHub:
        'New workflows can’t be cross-hub yet (they run only inside this hub). Cross-hub collaboration needs an admin to configure peer trust first.',
      meWfArchIdExists: 'A workflow with that name already exists — rephrase to give it a different name.',
      meWfArchDraftCap: 'You’ve reached your draft limit — clear some drafts before creating another.',
      meWfArchInternal: 'Something went wrong — please try again later.',
      // SW-M7 — hub steward chat panel
      meStewardTitle: 'Steward',
      meStewardHint:
        'Tell the steward in plain language what you want — it can build / edit your own AI helpers, or change your workflows the way you describe. The steward only PROPOSES; you preview, then decide to run it. Deleting a helper or a cross-hub workflow change is sent to “Pending tasks” below for a second confirmation.',
      meStewardPlaceholder: 'e.g. build me a helper that summarizes each day’s tickets into one paragraph',
      meStewardSend: 'Ask',
      // ease-of-use ⑨-M1 (B1) — starter prompts.
      meStewardTryLabel: 'Try one of these:',
      meStewardEg1: 'Build me an assistant that summarizes the day’s news into one Chinese paragraph',
      meStewardEg2: 'Build me a support assistant that replies to customer messages',
      meStewardEg3: 'Build me an assistant that translates English emails into Chinese',
      // ease-of-use ⑨-M2 (A2) — "how to get a key" guide chrome.
      keyGuideSummary: 'No key yet? See the step-by-step guide',
      keyGuideOpenLink: 'Open the official site and get your key →',
      meStewardThinking: 'The steward is thinking…',
      meStewardEmptyInput: 'Tell the steward in one line what you want to do.',
      meStewardNoActions: '(The steward just replied — nothing to run this time.)',
      meStewardApply: 'Apply',
      meStewardSubmitApproval: 'Submit for approval',
      meStewardApplying: 'Working…',
      meStewardTierSafe: 'Safe to run',
      meStewardTierDangerous: 'Dangerous · confirm again',
      meStewardTierCrossHub: 'Cross-hub · confirm again',
      meStewardTierForbidden: 'Out of scope',
      meStewardForbiddenNote: 'The steward won’t do this — ',
      meStewardDone: '✅ Done.',
      meStewardCreated: (label) => `✅ Built your helper “${label}”.`,
      meStewardEditedAgent: (label) => `✅ Updated your helper “${label}”.`,
      meStewardWorkflowEdited: (applied, expl) => `✅ ${applied}. ${expl}`,
      meStewardPending: 'Sent to your inbox for confirmation — it only runs after you approve it under “Pending tasks” below.',
      meStewardNeedsApproval: 'This action needs a second confirmation, but no inbox is wired, so it can’t be submitted right now.',
      meStewardGoInbox: 'Go to inbox',
      meStewardApplyFailed: (e) => `Apply failed: ${e}`,
      meStewardPlanFailed: (e) => `Ask failed: ${e}`,
      // SW-M9 A-M8 — operator-console steward (site-wide twin of the member one)
      opStewardTitle: 'Site steward',
      opStewardHint:
        'Manage the whole site in plain language — create / edit / delete any managed agent, or edit any workflow by describing it. The steward only PROPOSES; you preview, then decide. Deleting an agent, cross-hub workflow edits (and, later, credential / peer / security changes) are sent to your inbox under “Home” for a second confirmation.',
      opStewardPlaceholder: 'e.g. create a site agent that summarizes each day’s tickets into one Chinese paragraph',
      opStewardPending: 'Sent to your inbox under “Home” for confirmation — it only runs after you approve it there.',
      // setting-ops M4 — unified deterministic "Ops / Settings" console (overview tab)
      settingOpsTitle: 'Ops / Settings console',
      settingOpsHint:
        'Deterministic ops on this machine (no LLM): see status, validate definitions, create missing dirs, edit config (owner). Destructive operations — cold-start / restore from backup / rotate master key — can only run from the server CLI; they are listed here so you know where to run them.',
      settingOpsLoading: 'Loading ops commands…',
      settingOpsLoaded: (n, here) => `Loaded ${n} command(s) (${here} runnable here).`,
      settingOpsLoadFailed: (e) => `Load failed: ${e}`,
      settingOpsEmpty: 'No ops commands available.',
      settingOpsTierRead: 'read',
      settingOpsTierSafe: 'safe change',
      settingOpsTierConfig: 'config write',
      settingOpsTierDestructive: 'destructive · offline',
      settingOpsRun: 'Run',
      settingOpsRunning: 'Running…',
      settingOpsRunFailed: (e) => `Run failed: ${e}`,
      settingOpsOk: 'Done.',
      settingOpsWhereCli: 'Run it from the server CLI: the hub is down (or being replaced) during this operation, so only the CLI can.',
      settingOpsWhereOwner: 'A hub owner makes this change from the admin web UI or the server CLI.',
      settingOpsUsageConfigSet: 'KEY value, e.g. GOTONG_WEB_PORT 8080',
      settingOpsUsageConfigPrice: 'model inputPer1M outputPer1M [cacheWrite] [cacheRead]',
      settingOpsCmd: {
        status: {
          title: 'Status snapshot',
          summary: 'Where is my hub right now — definition counts, config check verdict, and (when running) live health.',
        },
        check: {
          title: 'Validate workspace',
          summary: 'Deterministic config + workflow + agent validation (same checks as gotong check and boot).',
        },
        list: { title: 'List ops commands', summary: 'Every setting command, its tier, and where it can run.' },
        inventory: { title: 'Backup inventory', summary: 'Recovery candidates in the backup directory (read-only, newest first).' },
        'fix-dirs': { title: 'Create missing dirs', summary: 'Ensure the workspace directories exist (mkdir -p; idempotent, reversible).' },
        config: {
          title: 'Effective config',
          summary: 'Show managed env knobs, secret env vars (set/unset only) and pricing override status.',
        },
        'config-set': {
          title: 'Set an env knob',
          summary: 'Set one whitelisted non-secret env knob in <space>/gotong.env (takes effect on restart).',
        },
        'config-price': {
          title: 'Set a model price',
          summary: 'Upsert one model price in <space>/pricing.json — validated before it lands (takes effect on restart).',
        },
        'cold-start': { title: 'Cold start', summary: 'Pre-flight → validate definitions → boot the host. CLI-only.' },
        restore: { title: 'Restore from backup', summary: 'Extract a backup tarball into a fresh workspace (runs verify.sh). CLI-only.' },
        'rotate-master-key': { title: 'Rotate master key', summary: 'Rotate the identity-vault master key. CLI-only.' },
      },
      // File upload
      meUploadSelectFile: (k) => `Pick a file for “${k}”`,
      meUploading: 'Uploading…',
      meUploaded: (n, s) => `Uploaded: ${n} (${s})`,
      meUploadFailed: (e) => `Upload failed: ${e}`,
      meUploadFailedFile: (e) => `File upload failed: ${e}`,
      meFieldMaxSize: (mb) => `(≤ ${mb} MB)`,
      // Runs
      meNoRuns: 'No runs yet — start a workflow above to try.',
      meInProgress: 'in progress',
      meRunStatusRunning: 'in progress',
      meRunStatusDone: 'done',
      meRunStatusFailed: 'failed',
      meRunStatusCancelled: 'cancelled',
      meRunStatusSuspended: 'suspended',
      meRunFailReason: 'Why it failed:',
      // Inbox
      meInboxEmpty: 'No pending tasks.',
      meInboxHandoff: (n) => `📨 Handoff note: ${n}`,
      meInboxCommentPlaceholder: 'Comment (required when requesting changes)',
      meInboxApprove: 'Approve',
      meInboxRequestChanges: 'Request changes',
      meInboxReject: 'Reject',
      meInboxSubmit: 'Submit',
      meInboxDelegateToggle: 'Delegate to someone…',
      meInboxDelegateEmail: 'Their email',
      meInboxDelegateNote: 'Handoff note (optional)',
      meInboxDelegateConfirm: 'Confirm delegation',
      meInboxChangesNeedComment: 'Requesting changes needs a comment',
      meInboxProcessFailedHttp: (s) => `Action failed (HTTP ${s})`,
      meInboxProcessFailedErr: (e) => `Action failed: ${e}`,
      meInboxNeedEmail: 'Enter their email',
      meInboxDelegating: 'Delegating…',
      meInboxDelegateFailedHttp: (s) => `Delegation failed (HTTP ${s})`,
      meInboxDelegateFailedErr: (e) => `Delegation failed: ${e}`,
      // Growth reports
      meNoReports: 'No reports yet — dispatch a workflow to try.',
      // Agents (catalog + own)
      meNoAgents: 'No AI assistants available yet — an admin can create them under “Agents”.',
      meHeartbeatTitle: 'Scheduled wake-up enabled',
      meHeartbeatBadge: '⏰ Scheduled',
      meNoOwnAgents: 'You haven’t built your own assistant yet. Use the form above to create one.',
      meNoModels: '(No models available yet — add your own key under “My API keys” below)',
      meCreateAgent: 'Create assistant',
      meSaveChanges: 'Save changes',
      meConfirmDeleteAgent: 'Delete this assistant? This cannot be undone.',
      // Grants
      meCollapseAccess: 'Collapse access',
      meTryChat: 'Try it',
      meChatClose: 'Close',
      meChatGoAddKey: 'Add a key →',
      // ②TC-NEXT-ME — after a quick-chat reply lands, the next-step card nudges
      // the member toward real work on the same home page (run a workflow / steward).
      meChatNextLead: 'It works! Next:',
      meChatNextRunWf: 'Run a workflow →',
      meChatNextAskSteward: 'Ask the steward to do more →',
      meConfirmRevokeGrant: 'Revoke this access grant?',
      meGrantKindUser: 'User',
      meGrantKindAgent: 'Assistant',
      meGrantKindPeer: 'Peer hub',
      meGrantKindHub: 'This hub',
      meGrantPermViewer: 'Viewer',
      meGrantPermEditor: 'Editor',
      meGrantPermOwner: 'Co-owner',
      meNoGrants: 'Not shared with anyone yet.',
      meGrantKindAria: 'Principal type',
      meGrantPidPlaceholder: 'Their ID',
      meGrantPermAria: 'Permission',
      meGrantAdd: 'Grant',
      meGrantSelf: '(you)',
      meGrantNeedPid: 'Enter their ID',
      meGranting: 'Granting…',
      meRevokeFailedErr: (e) => `Revoke failed: ${e}`,
      // Credentials
      meNoCreds: 'You haven’t saved your own key yet. Not needed if your org has configured one.',
      meNoProviders: '(No providers available)',
      meCredSavedTitle: 'Saved',
      meConfirmDeleteCred: 'Delete this key? Assistants relying on it will fall back to the org key (if any).',
      // MFA
      meMfaNoCrypto: 'This hub has no encryption configured, so two-factor auth is unavailable.',
      meMfaLoadFailed: 'Could not load two-factor status.',
      meMfaStatusWord: 'Status: ',
      meMfaStatusEnabled: 'Enabled ✅',
      meMfaDisableLabel: 'Enter your current code to disable',
      meMfaCodePlaceholder: '6-digit code',
      meMfaDisableBtn: 'Disable two-factor',
      meMfaDisabled: 'Two-factor disabled',
      meMfaStatusPending: 'Pending confirmation',
      meMfaStatusPendingNote: ' — there is an unfinished setup.',
      meMfaConfirmLabel: 'Enter the code from your authenticator to finish enabling',
      meMfaConfirmBtn: 'Confirm enable',
      meMfaRegenBtn: 'Regenerate key',
      meMfaEnabled: 'Two-factor enabled',
      meMfaSetupCancelled: 'Setup cancelled',
      meMfaIntro: 'Two-factor adds an extra layer of protection using one-time codes.',
      meMfaEnrollBtn: 'Enable two-factor',
      meMfaGenerating: 'Generating…',
      meMfaEnrollFailedHttp: (s) => `Enable failed (HTTP ${s})`,
      meMfaAddKey: 'Add this key in your authenticator app (manual entry):',
      meMfaOtpauthLink: 'otpauth link',
      meMfaQrTodo: ' · QR rendering coming later',
      meMfaEnterCode: 'Enter the code from your authenticator',
      meMfaEnrollFailedErr: (e) => `Enable failed: ${e}`,
      mePwChangeFailedHttp: (s) => `Change failed (HTTP ${s})`,
      mePwUpdated: 'Password updated',
      mePwChangeFailedErr: (e) => `Change failed: ${e}`,
      // Upgrade to team
      meUpgradeBtn: 'Upgrade to team mode',
      meUpgradeHint:
        'After upgrading, the admin console shows the full management tabs. You can invite other users / connect cross-hub peers / manage quotas. This cannot be one-click reverted.',
      meConfirmUpgrade: 'Upgrade to team mode? Some admin controls will become visible after upgrading.',
      meUpgrading: 'Upgrading…',
      meUpgradeOk: 'Upgraded — refreshing…',
      meUpgradeFailed: (e) => `Failed: ${e}`,
      // ── admin: main.js (REL-8) ──
      admAgentsWaiting: (n) => `${n} agent(s) awaiting your answer`,
      admReportsCount: (n) => `${n} total`,
      admView: 'View',
      admDownload: 'Download',
      admGrowthReportTitle: (when) => `Growth report · ${when}`,
      admLoading: 'Loading...',
      admLoadFailedHttp: (s) => `Load failed: HTTP ${s}`,
      admLoadFailedErr: (e) => `Load failed: ${e}`,
      admDispatchCap: (cap) => `Dispatch capability: ${cap}`,
      admNoPayloadSchema:
        'This workflow declares no payload_schema; fill in the JSON manually. See the trigger section of workflow.yaml for the required fields.',
      admAgentAsksMore: (agent, n) => `🤖 ${agent} wants to ask you ${n} more thing(s)`,
      admSubmitAnswer: 'Submit answer (the agent will continue)',
      admSkip: 'Skip',
      admSkipTitle: 'Skip — the agent will continue with its first-round judgment',
      admSubmitting: 'Submitting…',
      admFieldRequired: (label) => `${label} is required`,
      admSubmittedAgent: 'Submitted — the agent received it and is continuing',
      admSubmitFailedErr: (e) => `Submit failed: ${e}`,
      admSkipping: 'Skipping…',
      admSkipped: 'Skipped — the agent used its first-round judgment',
      admSkipFailedErr: (e) => `Skip failed: ${e}`,
      admUnknownBlock: (type) => `Unrecognized ${type} block`,
      admMaxSize: (mb) => `Max ${mb} MB`,
      admFileTooLarge: (label, mb) => `${label} file exceeds the ${mb} MB limit`,
      admUploading: 'Uploading…',
      admUploaded: (size) => `Uploaded (${size})`,
      admUploadFailedMsg: (msg) => `Upload failed: ${msg}`,
      admFieldUploadFailed: (label, msg) => `${label} upload failed: ${msg}`,
      admFieldMustBeNumber: (label) => `${label} must be a number`,
      admPayloadJsonInvalid: (e) => `Payload JSON is invalid: ${e}`,
      admFailedReason: (reason) => `Failed: ${reason}`,
      admHttp: (s) => `HTTP ${s}`,
      admDispatched: 'Dispatched — check progress in the "Run history" panel.',
      admBundleNeeded: 'Please upload or paste bundle yaml',
      admCreatedAgents: (n) => `Created ${n} agent(s)`,
      admSkippedAgents: (n) => `Skipped ${n} (already exist)`,
      admWorkflowRegistered: (id) => `workflow ${id} registered`,
      admWorkflowWarning: (e) => `(workflow warning: ${e})`,
      admSpawnFailed: (n) => `(${n} spawn failure(s): see agent tab)`,
      admImportDone: 'Import complete — ',
      admListSep: ', ',
      // Template gallery — one-click install of shipped templates (G-M3)
      templateGalleryBtn: 'Template gallery',
      templateGalleryTitle: 'Template gallery — one-click install',
      templateGalleryHint:
        'These ready-to-run templates ship with the framework. A template carries structure only (agents + workflow wiring + knowledge-base slots), never knowledge content or personnel. Installing creates its agents and registers its workflows; agents that need an API key are configured in the "agents" panel after install.',
      templateGalleryEmpty: 'No templates available.',
      templateGalleryInstall: 'Install',
      templateGalleryInstalling: 'Installing…',
      templateGalleryCountAgents: (n) => `${n} agent(s)`,
      templateGalleryCountWorkflows: (n) => `${n} workflow(s)`,
      templateGalleryCountKbs: (n) => `${n} KB slot(s)`,
      templateGalleryNeedsKey: (label) => `needs ${label} key`,
      templateGalleryWorkflowsLanded: (n) => `registered ${n} workflow(s)`,
      templateGalleryKbSlots: (n) => `${n} KB slot(s) to wire`,
      // Post-install checklist (ease-of-use ③-M1): tell the operator what to do next.
      templateGalleryChecklistTitle: 'Next steps',
      templateGalleryKbSlotTodo: (name) =>
        `KB slot "${name}" needs wiring → connect an MCP server in the Services / MCP panel`,
      templateGalleryKbSlotTodoRef: (name, server) =>
        `KB slot "${name}" references MCP server "${server}" → confirm it is online in the Services / MCP panel`,
      templateGalleryAgentNoKey: (id, provider) =>
        `agent "${id}" (${provider}) has no resolvable API key yet → add one in the agents panel or first-run wizard`,
      // ⑧ — each checklist row carries a deep-link button to the panel that
      // resolves it (KB slot → MCP tab; missing key → API-key modal).
      templateGalleryTodoGotoMcp: 'Go to MCP panel →',
      templateGalleryTodoGotoKey: 'Configure key →',
      // RES-M3 — resource-adaptation proposals in the post-install checklist. An
      // `applicable` proposal gets a one-click apply button (the operator's click
      // IS the approval — nothing is applied silently). Advisory proposals show a
      // hint only; the fix is a human action outside the hub.
      resAdaptApply: 'Apply',
      resAdaptApplying: 'Applying…',
      resAdaptApplied: (agentId) =>
        `Applied to "${agentId}" (takes effect after restart/reconnect; you may need to tune the model in the agents panel)`,
      resAdaptFailed: (e) => `Apply failed: ${e}`,
      resAdaptManual: 'manual step',
      // RES-M4 — always-on resource-adaptation section in the hub-health panel.
      resAdaptPanelTitle: 'Local resources',
      resAdaptPanelHint:
        "Detected local resources — one click makes the agents below runnable (clicking applies it; that click is your approval):",
      admTemplateLoadFailedHttp: (s) => `Failed to load builtin template: HTTP ${s}`,
      admGrowthBundleLoaded:
        'Loaded personal-growth bundle. Paste your DeepSeek key, then click "Import".',
      admTemplateLoadFailedErr: (e) => `Failed to load builtin template: ${e}`,
      admWillClear: '(will clear)',
      admApiKeyClearHintSuffix: ": the agent's private key will be removed after saving",
      admStart: 'Start',
      admOnboardPgPrompt: 'First time? Try generating a "12-week personal growth plan" in 5 minutes:',
      admOnboardPgBtn: '🎁 Install the personal-growth team (7 coaches · DeepSeek)',
      admOnboardDeepseekHint: (link) => `First grab an API key at ${link} (new users get ¥10 free credit ≈ dozens of workflow runs).`,
      // --- ease-of-use ⑦-M1 — first-run "start here" coaching card (overview tab) ---
      startHereTitle: 'Start here',
      startHereIntro: 'Welcome! Three steps get your AI desktop running — no code needed.',
      startHereStep1Title: '① Create my AI assistant',
      startHereStep1Desc: 'Get a chat-and-help assistant in seconds. Click, confirm, and it’s built.',
      startHereStep1Btn: 'Create my AI assistant',
      startHereStep2Title: '② Or install a ready-made template',
      startHereStep2Desc: 'Pick a personal / org hub template and install a whole set of agents + workflows in one click.',
      startHereStep2Btn: 'Browse the template gallery',
      startHereStep3Title: '③ Configure a model key',
      startHereStep3Desc: 'Your assistant needs an LLM to reply. DeepSeek is recommended for value.',
      startHereStep3Btn: 'Configure a model key',
      startHereKeyDone: '✓ Model key configured',
      startHereDismiss: 'Got it, don’t show again',
      startHereAssistantName: 'My AI assistant',
      startHereAssistantSystem: 'You are a helpful, concise AI assistant.',
      // --- ease-of-use ⑨-M3 — value before a key (experience it without one) ---
      startHereTryFreeLabel: 'No cloud key yet? Try it free first ↓',
      startHereNoKeyHelp: 'With Ollama installed locally you can run a real assistant with no cloud key; without it, watch a short demo first.',
      startHereOllamaBtn: '⚡ One-click local Ollama',
      startHereOllamaDetected: (model) => `Local Ollama detected (model: ${model})`,
      startHereOllamaName: 'Local assistant (Ollama)',
      startHereDemoBtn: '▶ Watch the steward demo (no key)',
      startHereDemoBanner: 'Demo · not real AI output',
      startHereDemoTitle: 'Steward demo: manage your hub in plain language',
      startHereDemoUser: 'Create a customer-support assistant that answers customer questions',
      startHereDemoTier: 'Safe',
      startHereDemoProposal: 'I’ll create a new assistant “Support assistant” (capability: chat). This is a safe action — it takes effect once you confirm.',
      startHereDemoApprove: 'Confirm & create',
      startHereDemoDone: '✓ Created assistant “Support assistant” — that’s what managing a hub in plain language looks like.',
      startHereDemoCta: 'Ready for the real thing? Configure a model key, or one-click connect a local Ollama (free, no cloud key).',
      startHereDemoClose: 'Close demo',
      // --- ease-of-use ❷-M2 — overview "hub health" health-check panel ---
      healthTitle: 'Hub health',
      healthRefresh: 'Refresh',
      healthAllGreen: 'All clear — nothing needs attention.',
      healthHasIssues: (n) => (n === 1 ? '1 item needs attention' : `${n} items need attention`),
      healthAgentMissingKey: (id, provider) => `Agent "${id}" (${provider}) has no usable model key`,
      healthGoAddKey: 'Add key →',
      healthMcpUnwired: (name) => `MCP server "${name}" is configured but no agent uses it`,
      healthGoMcp: 'Open MCP →',
      healthSpaceUnwritable: (path) => `Data directory not writable: ${path} — check disk space and permissions`,
      healthRosterTitle: (online, total) => `Agents (${online}/${total} online)`,
      healthTest: 'Test',
      healthOffline: 'Offline',
      healthTestTitle: (id) => `Test connection — ${id}`,
      // --- EH-M2 — agents-tab per-row "missing key" health badge (the badge IS the fix button) ---
      agentKeyWarnBadge: 'No key',
      agentKeyWarnHint: 'This agent has no working API key — likely why it is offline. Click to add it.',
      // --- EH-M1 — health panel "next step" config-progress guidance ---
      healthNextLabel: 'Suggested next step',
      healthNextNoWorkflow: 'You have an agent — next, install a workflow template or build one in plain language with the architect.',
      healthNextNoPublished: 'You have a draft workflow that is not published yet — publish it so members can use it under "Home".',
      healthNextNoRun: 'Your workflow is ready but has never run — give it a test run.',
      healthNextNoMcp: 'Want your assistant to look things up or reach a knowledge base? Hook up an MCP connector.',
      healthGoWorkflows: 'Go to Workflows →',
      healthGoPublish: 'Publish →',
      healthGoRun: 'Run it →',
      // --- DEPLOY-B3 — admin settings page "Hub ops" stitched area (ops-quick + IM channel status) ---
      opsQuickTitle: 'Hub ops',
      opsQuickHint: 'Deployment-related status and settings live on this page: IM channels / credentials / health check / ops console.',
      opsKeysBtn: 'Manage API keys',
      imStatusTitle: 'IM channels',
      imStatusNone: 'No IM channel connected yet. Paste a bot token in the first-boot wizard, or set an env var (e.g. GOTONG_TELEGRAM_BOT_TOKEN) and restart the host.',
      imStatusHint: 'To rotate a token: set the matching env var and restart — env vars always take precedence over vault-stored tokens.',
      imSourceEnv: 'env var',
      imSourceVault: 'vault',
      // --- peer-manifest-ui.js (federation tab — peer capability manifest) ---
      pmTitle: 'Peer capability manifest (federation manifest)',
      pmDesc: 'Capabilities each connected peer advertises over the authenticated mesh link (<code>peer.manifest</code> RPC). ' +
        'Manifests are cached in memory — before a refresh a peer reads <strong>unknown</strong> rather than a stale snapshot. ' +
        'This panel is read-only; the inbound trust contract deciding what we accept from a peer lives elsewhere (the policy editor).',
      pmRefreshAll: 'Refresh all',
      pmColStatus: 'Status',
      pmColCaps: 'Capabilities',
      pmColLastRefresh: 'Last refresh',
      pmLoading: 'Loading...',
      pmEmpty: 'No peers configured yet. Add one in the "Peers" panel above and its advertised capabilities will be listed here.',
      pmStOnlineUnrefreshed: 'online · not refreshed',
      pmStOnline: 'online',
      pmStStale: 'offline · cached',
      pmStUnknown: 'offline · unknown',
      pmCostPrefix: 'cost:',
      pmDataPrefix: 'data:',
      pmCapUnknown: 'unknown (click refresh)',
      pmRefresh: 'Refresh',
      pmStatusLoading: 'Loading...',
      pmLoaded: (n) => `Loaded ${n} peers`,
      pmHostNoFederation: 'host has peer federation disabled',
      pmLoadFailed: (e) => `Load failed: ${e}`,
      pmRefreshingOne: (id) => `Refreshing ${id}...`,
      pmRefreshingAll: 'Refreshing all...',
      pmRefreshed: 'Refreshed',
      pmRefreshFailed: (e) => `Refresh failed: ${e}`,
      // --- peer-summary-ui.js (联邦 tab — cross-hub control plane / 控制面) ---
      psTitle: 'Control plane (cross-hub summary aggregation)',
      psDesc: "This hub's privacy-safe footprint, plus each connected peer's <strong>voluntarily shared</strong> summary " +
        '(<code>peer.summary</code> RPC). <strong>Counts only</strong> — assets / runs / recent-window LLM usage / suspended tasks, ' +
        'never raw rows. A peer only shows numbers if it opted into "share summary with this peer" in its per-link policy; otherwise it shows the reason. ' +
        'The control plane only <strong>observes</strong>, it never takes over — each hub decides what to disclose.',
      psRefreshAll: 'Refresh all',
      psColStatus: 'Status',
      psColAssets: 'Assets',
      psColRuns: 'Runs',
      psColHealth: 'Health',
      psColLastRefresh: 'Last refresh',
      psLoading: 'Loading...',
      psAlertsTitle: 'Alerts',
      psAlertsDesc: 'Rules are evaluated live against the <strong>current</strong> summaries, with no firing history saved — a breach is a fact about "now". ' +
        'The source can be "this hub", a specific peer, or "any source (*)".',
      psFiringsTitle: 'Firing history',
      psFiringsDesc: 'Each row is one complete <strong>open → resolve</strong> lifecycle (<strong>edge-triggered</strong>: ' +
        'logged once on breach, marked resolved on recovery, not re-logged every evaluation). Counts only — threshold, fired value, timestamps, never raw rows.',
      psColSource: 'Source',
      psColMetric: 'Metric',
      psColCondition: 'Condition',
      psColFiredValue: 'Fired value',
      psColOpened: 'Opened',
      psColResolved: 'Resolved',
      psTrendTitle: 'Trend',
      psFieldSource: 'Source',
      psFieldMetric: 'Metric',
      psPickSourceMetric: 'Pick a source and metric',
      psTrendDesc: 'Trends read from persisted <strong>count snapshots</strong> — each "refresh" captures one data point ' +
        '(this hub is always captured, a peer only when its summary fetch succeeds).',
      psRulesTitle: 'Alert rules',
      psFieldCompare: 'Compare',
      psFieldThreshold: 'Threshold',
      psFieldLabelOpt: 'Label (optional)',
      psRuleLabelPh: 'e.g. too many suspended',
      psAddRule: 'Add rule',
      psColLabel: 'Label',
      psColActions: 'Actions',
      psChannelsTitle: 'Notification channels',
      psChannelsDesc: 'When an alert breaches, deliver a <strong>count summary</strong> to a webhook / instant messaging (IM) / email (edge-triggered: send once on open, once on resolve). ' +
        'A channel stores only the <strong>env-var name</strong> (headerEnv) and destination, never the secret itself — the host reads the token from that env var at delivery time. ' +
        'IM uses <strong>stateless platform send</strong>: slack/discord/lark are incoming-webhooks (token in the URL), telegram uses the bot API (token read from an env var, spliced into the path). ' +
        '<strong>Proactive delivery requires polling</strong>: set <code>GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS</code> (≥10000) for the host to evaluate ' +
        'and deliver periodically; until then channels only fire when you press the "Test" button below.',
      psFieldKind: 'Kind',
      psKindIm: 'IM (instant messaging)',
      psKindEmail: 'email',
      psFieldPlatform: 'Platform',
      psFieldTarget: 'Target',
      psTargetPh: 'e.g. -1001234567890 or ops@example.com',
      psFieldAuthEnvOpt: 'Auth env var (optional)',
      psAuthEnvPh: 'e.g. OPS_WEBHOOK_TOKEN',
      psChannelLabelPh: 'e.g. ops channel',
      psAddChannel: 'Add channel',
      psColChannel: 'Channel',
      psColDestination: 'Destination',
      psColAuth: 'Auth',
      psCmpGt: 'greater than',
      psCmpGte: 'greater than or equal',
      psCmpLt: 'less than',
      psCmpLte: 'less than or equal',
      psMetricLabels: {
        'assets.agents': 'Agents',
        'assets.workflows': 'Workflows',
        'assets.publishedWorkflows': 'Published workflows',
        'assets.peers': 'Peers',
        'runs.total': 'Total runs',
        'llm.calls': 'LLM calls',
        'llm.tokens': 'LLM tokens',
        'llm.costMicros': 'LLM cost (µ$)',
        'health.suspendedTasks': 'Suspended tasks',
        'alerts.openFirings': 'Alerts · open',
      },
      psStOnline: 'online',
      psStOfflineCached: 'offline · cached',
      psStNotShared: 'not shared',
      psStOnlineNoSummary: 'online · no summary',
      psStOfflineUnknown: 'offline · unknown',
      psSourceAny: 'any source',
      psSourceAnyOpt: 'any source (*)',
      psSourceLocal: 'this hub',
      psBadgeLocal: 'local',
      psLocalUnavailable: 'Local footprint unavailable',
      psNoPeers: 'No peers configured yet. Add a peer in the "Peers" panel on this page, ' +
        'and once you opt into "share summary with this peer" in its policy, its counts will aggregate here.',
      psRefresh: 'Refresh',
      psNotRefreshedYet: 'not refreshed yet',
      psAssetsText: (agents, wf, pub, peers) =>
        `Agents ${agents} · Workflows ${wf} (published ${pub}) · Peers ${peers}`,
      psRunsTotal: (n) => `total ${n}`,
      psLlmText: (calls, tokens, cost) => `${calls} calls · ${tokens} tok · ${cost}`,
      psLlmWindow: (days) => `last ${days}d`,
      psHealthText: (suspended, firings) => `suspended ${suspended} · alerts ${firings}`,
      psAggLabel: (n) => `Federation alert aggregate: ${n} open`,
      psAggDetail: (known, unknown) =>
        `(across ${known} shared hub${known === 1 ? '' : 's'}${unknown > 0 ? `; ${unknown} not shared/offline excluded` : ''})`,
      psTrendNoSnapshots: 'No snapshots yet — "Refresh all" to capture the first data point',
      psTrendMeta: (n, from, to, last, min, max) =>
        `${n} data points · ${from} → ${to} · latest ${last} · min ${min} · max ${max}`,
      psTrendLoading: 'Loading trend...',
      psTrendLoadFailed: (e) => `Trend load failed: ${e}`,
      psHostNoFederation: 'host has peer federation disabled',
      psNoBreaches: 'No alerts firing right now',
      psNoRules: 'No alert rules yet. Add one with the form above.',
      psEnabled: 'enabled',
      psDisabled: 'disabled',
      psEnable: 'Enable',
      psDisable: 'Disable',
      psDelete: 'Delete',
      psTest: 'Test',
      psConfirmDeleteRule: 'Delete this alert rule?',
      psConfirmDeleteChannel: 'Delete this notification channel?',
      psFiringOpen: 'open',
      psFiringResolved: 'resolved',
      psNoFirings: 'No firings yet. When a rule breaches, an open→resolve lifecycle will appear here.',
      psNoChannels: 'No notification channels yet. Add a webhook / IM / email channel with the form above.',
      psTargetEmail: 'Recipient',
      psTargetChatRoom: 'Target chat/room id',
      psUrlRequired: 'URL is required',
      psAddingChannel: 'Adding channel...',
      psChannelAdded: 'Channel added',
      psAddChannelFailed: (e) => `Add channel failed: ${e}`,
      psSavingChannel: 'Saving channel...',
      psChannelSaved: 'Channel saved',
      psSaveChannelFailed: (e) => `Save channel failed: ${e}`,
      psDeletingChannel: 'Deleting channel...',
      psChannelDeleted: 'Channel deleted',
      psDeleteChannelFailed: (e) => `Delete channel failed: ${e}`,
      psSendingTest: 'Sending test...',
      psTestDeliverOk: (status) => `Test delivery succeeded (${status})`,
      psTestDeliverFailed: (e) => `Test delivery failed: ${e}`,
      psTestFailed: (e) => `Test failed: ${e}`,
      psSourceMetricRequired: 'Source / metric are required',
      psThresholdNumber: 'Threshold must be a number',
      psAddingRule: 'Adding rule...',
      psRuleAdded: 'Rule added',
      psAddRuleFailed: (e) => `Add rule failed: ${e}`,
      psSavingRule: 'Saving rule...',
      psRuleSaved: 'Rule saved',
      psSaveRuleFailed: (e) => `Save rule failed: ${e}`,
      psDeletingRule: 'Deleting rule...',
      psRuleDeleted: 'Rule deleted',
      psDeleteRuleFailed: (e) => `Delete rule failed: ${e}`,
      psLoadingStatus: 'Loading...',
      psLoaded: (n) => `Loaded ${n} peers`,
      psLoadFailed: (e) => `Load failed: ${e}`,
      psRefreshingOne: (id) => `Refreshing ${id}...`,
      psRefreshingAll: 'Refreshing all...',
      psRefreshed: 'Refreshed',
      psRefreshFailed: (e) => `Refresh failed: ${e}`,
      // identity / user-management panel (tab "Users")
      idnConfirmPrompt: (phrase) => 'To continue, type: ' + phrase,
      idnNoV4Binding: '(v3 admin · no v4 user linked)',
      idnMeLine: (who, display, role, source) =>
        'Current: ' + who + display + ' · role ' + role + ' · source ' + source,
      idnMeReadFailed: (msg) => 'Cannot read current user: ' + msg,
      idnLoading: 'Loading…',
      idnUsersLoadFailed: (msg) => 'Failed to load user list: ' + msg,
      idnAuditLoadFailed: (msg) => 'Failed to load audit log: ' + msg,
      idnAuditEmpty: 'No matching audit records',
      idnUsersEmpty: 'No users yet',
      idnBtnCreds: 'Credentials',
      idnBtnCredsTitle: 'View / revoke credentials',
      idnBtnPw: 'Password',
      idnBtnPwTitle: 'Change password',
      idnBtnKey: 'Issue API key',
      idnBtnKeyTitle: 'Issue API key',
      idnGrantOwnerTitle: '⚠ Grant owner role',
      idnGrantOwnerBody:
        'This grants full admin rights (create/delete users, revoke credentials, change any user password).\n' +
        'The action is written to the audit log but does not trigger an alert.',
      idnGrantOwnerCancelled: 'Owner grant cancelled',
      idnRoleUpdated: (role) => 'Role updated to ' + role,
      idnRoleUpdateFailed: (msg) => 'Failed to change role: ' + msg,
      idnPwPrompt: 'New password (at least 8 characters):',
      idnPwUpdated: 'Password updated',
      idnPwUpdateFailed: (msg) => 'Failed to change password: ' + msg,
      idnKeyLabelPrompt: 'API key label (optional, for later identification):',
      idnKeyShowOnce: 'The API key is shown only once — copy it now (Ctrl/Cmd+C):',
      idnKeyIssued: (id) => 'API key issued, credentialId=' + id,
      idnKeyIssueFailed: (msg) => 'Failed to issue API key: ' + msg,
      idnNoCreds: 'This user has no credentials',
      idnCredKindLabel: (kind) => '(' + kind + ' credential)',
      idnCredListPrompt: 'Credential list (enter the credential id to revoke, leave blank to cancel):\n\n',
      idnCredNotFound: 'No matching credential id found',
      idnRevokePwTitle: '⚠ Revoke password credential',
      idnRevokePwBody: (who) =>
        'This user will immediately be unable to log in with a password (' + who + ').\n' +
        'They will need an owner to reset the password or issue a token to regain access.',
      idnRevokePwCancelled: 'Password credential revocation cancelled',
      idnConfirmRevokeCred: (kind, id) => 'Revoke ' + kind + ' credential ' + id + '?',
      idnCredRevoked: 'Credential revoked',
      idnCredOpFailed: (msg) => 'Credential operation failed: ' + msg,
      idnInvitesLoadFailed: (msg) => 'Failed to load invitation list: ' + msg,
      idnInvitesEmpty: 'No matching invitations',
      idnBtnRevoke: 'Revoke',
      idnBtnRevokeTitle: 'Revoke invitation',
      idnConfirmRevokeInvite: (email) => 'Revoke the invitation for ' + email + '?',
      idnInviteRevoked: 'Invitation revoked',
      idnInviteRevokeFailed: (msg) => 'Revoke failed: ' + msg,
      idnEmailRequired: 'email is required',
      idnTtlPositive: 'TTL must be a positive number of hours',
      idnInviteShowOnce: (email) =>
        'The invite link is shown only once — copy it now and send it to ' +
        email +
        ' over a private channel (Signal/1Password/paper).' +
        '\n\nThe link is valid for 24 hours (or your TTL); the invitee sets their own password after clicking.',
      idnInviteCreated: (email) => 'Invitation created for ' + email,
      idnInviteCreateFailed: (msg) => 'Failed to create invitation: ' + msg,
      idnCreateOwnerTitle: '⚠ Create new owner user',
      idnCreateOwnerBody: (email) =>
        'This creates a user with full admin rights: ' + email + '\n' +
        'They can create/delete any user, revoke credentials, and change any password.',
      idnCreateOwnerCancelled: 'Owner creation cancelled',
      idnUserCreated: (email) => 'User ' + email + ' created',
      idnUserCreateFailed: (msg) => 'Failed to create user: ' + msg,
      idnHeading: 'User management / Users',
      idnNewUser: 'New user',
      idnPhDisplayName: 'Display name (optional)',
      idnPhPassword: 'Password (optional, 8+ chars)',
      idnBtnCreateUser: 'Create user',
      idnUserList: 'User list',
      idnColDisplayName: 'Display name',
      idnColRole: 'Role',
      idnColCreated: 'Created',
      idnColLastLogin: 'Last login',
      idnColActions: 'Actions',
      idnInvitations: 'Invitations',
      idnTtlTitle: 'Link validity (hours); max 30 days',
      idnBtnCreateInvite: 'Create invite link',
      idnInviteHint:
        'The link contains a one-time token and is shown in a popup after creation — copy it immediately. Owner cannot be created via invite; invite a regular role first, then promote with setRole.',
      idnBtnRefresh: 'Refresh',
      idnColStatus: 'Status',
      idnColExpires: 'Expires',
      idnAuditLog: 'Audit log',
      idnColTime: 'Time',
      a2aTitle: 'Outbound A2A agents',
      a2aDesc:
        'Register A2A agents this hub forwards to. When a matching local capability is dispatched, it is turned into a <code>message/send</code> call to the external agent. Replaces the old <code>GOTONG_A2A_AGENTS</code> env var with persistent config that takes effect immediately.',
      a2aTokenNote:
        '<strong>The token is not entered here</strong> — the "token env var" is the <strong>name</strong> of the env var the host reads the bearer from; the secret itself never enters the database or browser. A row whose env var is unset reads "Inactive"; once you set it on the host, toggle the row off→on to make the host re-read it and come online (no restart needed).',
      a2aAddSummary: 'Register outbound agent',
      a2aPhId: 'Local participant id (dispatch target, unique)',
      a2aPhLabel: 'Display name (optional)',
      a2aPhCaps: 'Capabilities (comma-separated, at least one)',
      a2aPhUrl: 'Remote A2A message/send URL',
      a2aPhTokenEnv: 'Token env var name (e.g. WRITER_A2A_TOKEN)',
      a2aPhPeerId: 'X-Gotong-Peer-Id (for Gotong↔Gotong, optional)',
      a2aPhTargetSkill: 'Remote skill (metadata.skill, optional)',
      a2aLifecycleLabel:
        'Long-running mode (poll <code>tasks/get</code> when the remote returns a parked task; unchecked = blocking, the remote must answer in one turn)',
      a2aPhPollInterval: 'Poll interval ms (optional, default 3000)',
      a2aPhMaxAttempts: 'Max poll attempts (optional, default 20)',
      a2aEnabledLabel: 'Enabled (comes online immediately if the token env var is set)',
      a2aBtnRegister: 'Register',
      a2aRegisteredHeading: 'Registered outbound agents',
      a2aColIdLabel: 'id / display name',
      a2aColCaps: 'Capabilities',
      a2aColUrl: 'URL',
      a2aColTokenEnv: 'Token env var',
      a2aColMode: 'Mode',
      a2aColStatus: 'Status',
      a2aColActions: 'Actions',
      a2aLoading: 'Loading…',
      a2aStRunning: 'Running',
      a2aStDisabled: 'Disabled',
      a2aStTokenUnset: 'Inactive · env var unset',
      a2aStIdConflict: 'Inactive · id conflict',
      a2aStInactive: 'Inactive',
      a2aModeBlocking: 'Blocking',
      a2aModeLongTitle: 'Polls tasks/get when the remote returns a parked task',
      a2aModeLong: (detail) => 'Long-running' + detail,
      a2aModeDefault: ' (default)',
      a2aEmpty:
        'No outbound A2A agents registered yet. Register one in the form above — then dispatching a capability it declares forwards to the remote.',
      a2aBtnDisable: 'Disable',
      a2aBtnEnable: 'Enable',
      a2aBtnToBlocking: 'To blocking',
      a2aBtnToLong: 'To long-running',
      a2aBtnDelete: 'Delete',
      a2aConfirmDelete: (name) =>
        'Delete outbound agent "' + name + '"? Workflows dispatching its capabilities will no longer forward to the remote.',
      a2aUnwired: 'Identity store not enabled on this host (outbound A2A unavailable)',
      a2aLoadingStatus: 'Loading…',
      a2aLoadedStatus: (total, live) => total + ' total (' + live + ' running)',
      a2aLoadFailed: (msg) => 'Load failed: ' + msg,
      a2aRegistering: 'Registering…',
      a2aRegistered: 'Registered',
      a2aRegisterFailed: (msg) => 'Register failed: ' + msg,
      a2aSaving: 'Saving…',
      a2aSaved: 'Saved',
      a2aSaveFailed: (msg) => 'Save failed: ' + msg,
      a2aDeleting: 'Deleting…',
      a2aDeleted: 'Deleted',
      a2aDeleteFailed: (msg) => 'Delete failed: ' + msg,
      a2aOkDisabled: 'Disabled',
      a2aOkEnabled: 'Enabled',
      a2aOkToBlocking: 'Changed to blocking',
      a2aOkToLong: 'Changed to long-running',
      // Item 2 — outbound-edge gate (data-class / quota / approval).
      a2aPhDataClasses: 'Data-class allowlist (comma-separated; empty = unrestricted)',
      a2aPhQuotaBudget: 'Outbound quota per window (optional; empty or 0 = unlimited)',
      a2aApprovalLabel: 'Require outbound approval (confirm each send in the /me inbox)',
      a2aColGate: 'Outbound gate',
      a2aGateNone: '—',
      a2aGateDcLocked: 'Data-class · locked',
      a2aGateDcList: (s) => 'Data-class: ' + s,
      a2aGateQuota: (n) => 'Quota: ' + n + '/window',
      a2aGateApproval: 'Approval',
      a2aStApprovalUnconfigured: 'Inactive · approval not configured',
      a2aBtnToApproval: 'Require approval',
      a2aBtnToDirect: 'Allow direct',
      a2aOkToApproval: 'Now requires approval',
      a2aOkToDirect: 'Now sends directly',
      acpTitle: 'Outbound ACP coding agents',
      acpDesc:
        'Register coding agents (Claude Code / Codex) this hub drives over a long-lived ACP session. When a matching local capability is dispatched, it is <strong>spawned once → the session is held → many tasks are dispatched to it</strong> (context preserved across tasks), running the coding work in a child process. Replaces the old example glue with persistent config that takes effect immediately.',
      acpKeyNote:
        '<strong>No secret is needed here</strong> — the ACP bridge reuses the underlying agent\'s <strong>own login</strong> (<code>claude</code> / <code>codex</code> already logged in on this machine), so the command / args / working directory are all non-secret config, stored in full. A disabled row reads "Disabled"; enable it and the host registers it on the running hub immediately (no restart). Destructive actions (edit files / delete / push…) are fail-closed and denied on the spot by default.',
      acpAddSummary: 'Register outbound coding agent',
      acpPhId: 'Local participant id (dispatch target, unique)',
      acpPhLabel: 'Display name (optional)',
      acpPhCaps: 'Capabilities (comma-separated, at least one)',
      acpPhCommand: 'Command (e.g. npx or codex-acp)',
      acpPhArgs: 'Args (space-separated, e.g. @zed-industries/claude-code-acp)',
      acpPhCwd: 'Working directory cwd (optional, defaults to host process dir)',
      acpEnabledLabel: 'Enabled (registers on the hub immediately; child process is only spawned on first dispatch)',
      acpBtnRegister: 'Register',
      acpRegisteredHeading: 'Registered outbound coding agents',
      acpColIdLabel: 'id / display name',
      acpColCaps: 'Capabilities',
      acpColCmd: 'Command + args',
      acpColCwd: 'Working directory',
      acpColStatus: 'Status',
      acpColActions: 'Actions',
      acpLoading: 'Loading…',
      acpStRunning: 'Running',
      acpStDisabled: 'Disabled',
      acpStIdConflict: 'Inactive · id conflict',
      acpStNotFound: 'Inactive · not found',
      acpStInactive: 'Inactive',
      acpEmpty:
        'No outbound ACP coding agents registered yet. Register one in the form above — then dispatching a capability it declares spawns and drives Claude Code / Codex.',
      acpBtnDisable: 'Disable',
      acpBtnEnable: 'Enable',
      acpBtnDelete: 'Delete',
      acpConfirmDelete: (name) =>
        'Delete outbound coding agent "' + name + '"? Workflows dispatching its capabilities will no longer drive this agent.',
      acpUnwired: 'Identity store not enabled on this host (outbound ACP unavailable)',
      acpLoadingStatus: 'Loading…',
      acpLoadedStatus: (total, live) => total + ' total (' + live + ' running)',
      acpLoadFailed: (msg) => 'Load failed: ' + msg,
      acpRegistering: 'Registering…',
      acpRegistered: 'Registered',
      acpRegisterFailed: (msg) => 'Register failed: ' + msg,
      acpSaving: 'Saving…',
      acpSaved: 'Saved',
      acpSaveFailed: (msg) => 'Save failed: ' + msg,
      acpDeleting: 'Deleting…',
      acpDeleted: 'Deleted',
      acpDeleteFailed: (msg) => 'Delete failed: ' + msg,
      acpOkDisabled: 'Disabled',
      acpOkEnabled: 'Enabled',
      // Item 2 — outbound-edge gate (data-class allowlist / quota; no approval, D5).
      acpPhDataClasses: 'Data-class allowlist (comma-separated; empty = unrestricted; governance control)',
      acpPhQuotaBudget: 'Outbound quota per window (optional; empty or 0 = unlimited; runaway guard)',
      acpColGate: 'Outbound gate',
      acpGateNone: '—',
      acpGateDcLocked: 'Data-class · locked',
      acpGateDcList: (s) => 'Data-class: ' + s,
      acpGateQuota: (n) => 'Quota: ' + n + '/window',
      // peer-admin-ui.js — federation tab peer onboarding panel (Route B P1-M7b/c)
      padmTitle: 'Peers (federation)',
      padmDesc:
        'Register the federation peers this hub trusts. Authentication is <strong>symmetric</strong>: ' +
        'register the same bearer token on both sides — generate it with <code>gotong mint-peer-token</code> ' +
        'and exchange it over a secure channel. The token is a secret, stored vault-encrypted and <strong>never displayed</strong> (write / rotate only).',
      padmLabelOptional: 'Label (optional)',
      padmLabelPlaceholder: 'partner hub',
      padmKind: 'Kind',
      padmAddBtn: 'Add peer',
      padmColPeer: 'Peer',
      padmColKind: 'Kind',
      padmColState: 'State',
      padmColActions: 'Actions',
      padmLoadingCell: 'Loading...',
      padmEmpty: 'No peers registered yet. Add one with the form above.',
      padmStateEnabled: 'Enabled',
      padmStateDisabled: 'Disabled',
      padmStateOnline: 'Online',
      padmStateOffline: 'Offline',
      padmStateRevoked: 'Revoked',
      padmBtnPolicy: 'Policy',
      padmBtnEnable: 'Enable',
      padmBtnDisable: 'Disable',
      padmBtnRotate: 'Rotate token',
      padmBtnRemove: 'Remove',
      padmPolAclCaps: 'Inbound ACL capabilities',
      padmPolAclCapsHint: '(comma-separated, blank = accept all)',
      padmPolRequireOrigin: 'Require origin on inbound',
      padmPolOutCaps: 'Outbound capability allowlist',
      padmPolOutCapsHint: '(blank = allow all)',
      padmPolApprove: 'Require approval for outbound',
      padmPolDataClasses: 'Allowed data classes',
      padmPolDataClassesHint: '(blank = allow all)',
      padmPolKb: 'Callable knowledge bases',
      padmPolKbHint: '(blank = all callable)',
      padmPolQuota: 'Per-link inbound quota',
      padmPolQuotaHint: '(non-negative integer, blank = unlimited)',
      padmPolRevState: 'Revocation state',
      padmPolShareSummary: 'Share this hub’s summary with this peer',
      padmPolShareSummaryHint: '(counts only, for the control plane)',
      padmPolShareTranscript: 'Share cross-hub task traces with this peer',
      padmPolShareTranscriptHint: '(step-by-step transcript, more sensitive than the summary)',
      padmPolSave: 'Save policy',
      padmQuotaMustBeInt: 'Per-link quota must be a non-negative integer',
      padmSavingPolicy: 'Saving policy...',
      padmPolicySaved: 'Policy saved',
      padmPolicySaveFailed: (e) => `Save policy failed: ${e}`,
      padmRotatePrompt:
        'Paste the new peer token (generate it with `gotong mint-peer-token`).\nBoth sides must change to the same new value.',
      padmTokenEmpty: 'Token cannot be empty',
      padmTokenRotated: 'Token rotated',
      padmConfirmRemove: (name) => `Remove peer ${name}? The link will disconnect.`,
      padmFieldsRequired: 'Peer ID / Endpoint / Token are all required',
      padmAdding: 'Adding...',
      padmAdded: (id) => `Added ${id}`,
      padmAddFailed: (e) => `Add failed: ${e}`,
      padmSaving: 'Saving...',
      padmSaved: 'Saved',
      padmSaveFailed: (e) => `Save failed: ${e}`,
      padmRemoving: 'Removing...',
      padmRemoved: 'Removed',
      padmRemoveFailed: (e) => `Remove failed: ${e}`,
      padmLoading: 'Loading...',
      padmLoadedN: (n) => `${n} peers registered`,
      padmHostNoIdentity: 'host has identity / peer disabled (personal mode)',
      padmLoadFailed: (e) => `Load failed: ${e}`,
      padmPairTitle: 'Pairing-code wizard (convenience enrolment)',
      padmPairNote:
        'A pairing code just bundles the Peer ID, endpoint and shared token into one copy-paste string for easy exchange — it is NOT a new security mechanism: the token is still the secret both sides share, carried here in the clear, so only send it over a channel you trust.',
      padmPairPasteLabel: "Paste the other side's pairing code",
      padmPairPastePlaceholder: 'Paste the pairing code they generated here',
      padmPairDecodeBtn: 'Decode & pre-fill the form',
      padmPairGenTitle: 'Generate our pairing code',
      padmPairMyId: 'Our Peer ID (they enrol us under this)',
      padmPairMyIdLoading: 'Loading…',
      padmPairMyEndpoint: 'Our endpoint (the address they dial)',
      padmPairMyEndpointHint: 'Defaulted from this machine — change it to the public wss address the other side can actually reach',
      padmPairToken: 'Shared token',
      padmPairTokenHint: '256-bit random key; both sides enrol the same one. Decoding their code syncs it automatically',
      padmPairNewToken: 'New token',
      padmPairGenBtn: 'Generate pairing code',
      padmPairOutLabel: 'Send this to the other side',
      padmPairCopyBtn: 'Copy',
      padmPairDecoded: 'Pre-filled the form below — check it and click "Add". The token was synced into the generate box so you can mail it back.',
      padmPairDecodeFailed: 'Not a valid pairing code.',
      padmPairGenerated: 'Pairing code generated.',
      padmPairGenFailed: 'Generation failed: fill in Peer ID, endpoint and token first.',
      padmPairCopied: 'Copied to clipboard.',
      padmPairNoSelfId: "Couldn't read this hub's Peer ID — please fill it in manually.",
      padmPairNoEndpoint: 'Please fill in our endpoint.',
      padmPairNoToken: 'Please fill in or generate a shared token.',
      // SAML 2.0 IdP 注册面板 (saml-ui.js)
      samlTitle: 'Single Sign-On / SSO (SAML 2.0)',
      samlIntro:
        'Register the external Identity Providers (IdPs) this hub accepts SAML assertions from. ' +
        'Members will see a "Sign in with X" button on the login page. ' +
        '<strong>SSO only admits users that already exist locally</strong> — it matches the email ' +
        'in the IdP-signed assertion to an existing account, and never provisions new accounts.',
      samlAcsHint: (path) =>
        `Assertion Consumer Service (ACS, register at the IdP): <code>${path}</code> — ` +
        `i.e. <code>https://&lt;your-domain&gt;${path}</code>. After registering, each row has an ` +
        `"SP metadata" link to hand to the IdP admin.`,
      samlRegisterIdp: 'Register an IdP',
      samlPhIdpEntityId: 'IdP entityID (assertion Issuer)',
      samlPhLabel: 'Display name (button text, optional)',
      samlPhSsoUrl: 'SSO URL (HTTP-Redirect endpoint)',
      samlPhSpEntityId: 'SP entityID (this hub, assertion Audience)',
      samlPhIdpCert: 'IdP signing certificate (X.509 PEM, public verification key)',
      samlEnabledLabel: 'Enabled (visible on the member login page immediately)',
      samlRegisterBtn: 'Register',
      samlRegisteredIdp: 'Registered IdPs',
      samlColLabelEntity: 'Label / EntityID',
      samlColCert: 'Certificate',
      samlColState: 'State',
      samlColActions: 'Actions',
      samlLoadingCell: 'Loading…',
      samlEmpty: 'No IdPs registered yet. Register one with the form above and the matching SSO button will appear on the member login page.',
      samlStateEnabled: 'Enabled',
      samlStateDisabled: 'Disabled',
      samlBtnDisable: 'Disable',
      samlBtnEnable: 'Enable',
      samlBtnRotateCert: 'Rotate certificate',
      samlBtnMetadata: 'SP metadata',
      samlBtnRemove: 'Remove',
      samlCertPrompt: 'Paste the new IdP signing certificate (X.509 PEM):',
      samlCertEmpty: 'Certificate cannot be empty (blank ignored)',
      samlCertRotated: 'Certificate rotated',
      samlRemoveConfirm: (name) => `Remove IdP "${name}"? Linked users will no longer be able to sign in with it.`,
      samlDisabled: 'Disabled',
      samlEnabled: 'Enabled',
      samlHostNoIdentity: 'This host has no identity store enabled (SAML unavailable)',
      samlLoading: 'Loading…',
      samlLoadedN: (n) => `${n} IdPs registered`,
      samlLoadFailed: (e) => `Load failed: ${e}`,
      samlRegistering: 'Registering…',
      samlRegistered: 'Registered',
      samlRegisterFailed: (e) => `Registration failed: ${e}`,
      samlSaving: 'Saving…',
      samlSaved: 'Saved',
      samlSaveFailed: (e) => `Save failed: ${e}`,
      samlRemoving: 'Removing…',
      samlRemoved: 'Removed',
      samlRemoveFailed: (e) => `Remove failed: ${e}`,
      // OIDC IdP 注册面板 (oidc-ui.js)
      oidcTitle: 'Single Sign-On / SSO (OIDC)',
      oidcIntro:
        'Register the external identity providers (IdPs) this hub accepts single sign-on from. ' +
        'Members see a "Sign in with X" button on the login page. <strong>SSO only lets existing local users in</strong> —— ' +
        "it matches the IdP's asserted verified email against an existing account, and never auto-provisions one.",
      oidcCallbackHint: (path) =>
        `Callback URL (register the same one at the IdP too): <code>${path}</code> —— ` +
        `i.e. <code>https://&lt;your-domain&gt;${path}</code>`,
      oidcRegisterIdp: 'Register an IdP',
      oidcPhIssuer: 'issuer (https://accounts.google.com)',
      oidcPhLabel: 'Display name (button text, optional)',
      oidcPhClientId: 'client_id',
      oidcPhRedirectUri: (path) => `redirect_uri (…${path})`,
      oidcPhScope: 'scope (blank = openid email profile)',
      oidcPhClientSecret: 'client_secret (blank = public / PKCE client)',
      oidcEnabledLabel: 'Enabled (visible on the member login page immediately)',
      oidcRegisterBtn: 'Register',
      oidcRegisteredIdp: 'Registered IdPs',
      oidcColLabelIssuer: 'Label / Issuer',
      oidcColScope: 'Scope',
      oidcColState: 'State',
      oidcColSecret: 'Secret',
      oidcColActions: 'Actions',
      oidcLoadingCell: 'Loading…',
      oidcEmpty: 'No IdPs registered yet. Register one with the form above and the matching SSO button will appear on the member login page.',
      oidcStateEnabled: 'Enabled',
      oidcStateDisabled: 'Disabled',
      oidcSecretSet: 'Set',
      oidcSecretPublic: 'Public',
      oidcBtnDisable: 'Disable',
      oidcBtnEnable: 'Enable',
      oidcBtnRotateSecret: 'Rotate secret',
      oidcBtnRemove: 'Remove',
      oidcSecretPrompt: 'Enter the new client_secret (blank = switch to a public / PKCE client):',
      oidcSecretRotated: 'Secret rotated',
      oidcSecretCleared: 'Switched to a public client',
      oidcRemoveConfirm: (name) => `Remove IdP "${name}"? Linked users will no longer be able to sign in with it.`,
      oidcDisabled: 'Disabled',
      oidcEnabled: 'Enabled',
      oidcHostNoIdentity: 'This host has no identity store enabled (OIDC unavailable)',
      oidcLoading: 'Loading…',
      oidcLoadedN: (n) => `${n} IdPs registered`,
      oidcLoadFailed: (e) => `Load failed: ${e}`,
      oidcRegistering: 'Registering…',
      oidcRegistered: 'Registered',
      oidcRegisterFailed: (e) => `Registration failed: ${e}`,
      oidcSaving: 'Saving…',
      oidcSaved: 'Saved',
      oidcSaveFailed: (e) => `Save failed: ${e}`,
      oidcRemoving: 'Removing…',
      oidcRemoved: 'Removed',
      oidcRemoveFailed: (e) => `Remove failed: ${e}`,
      // —— Workflow AI assistant (admin-wf-assist.js) ——
      wfaChipWarnN: (n) => `⚠ Schema valid, but ${n} deep-check warning${n === 1 ? '' : 's'}`,
      wfaChipValid: '✓ Validated (ready to save)',
      wfaChipInvalid: "✗ YAML doesn't match the v1 schema",
      wfaChipNoYaml: '— LLM produced no YAML',
      wfaChipUnknown: '(unknown)',
      wfaViolUnknownAgent: 'References an agent that does not exist',
      wfaViolUnknownCapability: 'No agent on this hub provides that capability',
      wfaViolBadRef: '$ref points to a step that does not exist',
      wfaViolForwardRef: '$ref points to a step that runs later',
      wfaViolSelfTriggerCycle: 'Triggers itself — infinite loop',
      wfaViolIdCollision: 'workflow.id already exists',
      wfaViolUnknownKind: '(unknown)',
      wfaDeepOk: 'Deep check passed (0 warnings)',
      wfaDeepWarnN: (n) =>
        `Deep-check warnings — ${n} item${n === 1 ? '' : 's'} (the workflow can be saved, but may fail at runtime)`,
      wfaYamlEmpty: '(empty — the LLM produced no YAML fence)',
      wfaNeedDescription: 'Please enter a one-line description first',
      wfaGenerating: 'Generating…',
      wfaGeneratingMsg: 'Generating, usually 5-20 seconds…',
      wfaWaitingChunk: 'Waiting for the first LLM chunk…',
      wfaStreamTask: (id) => `task=${id}…`,
      wfaStreamProgress: (done, chars, tools) =>
        `${done ? '✓ Stream ended' : '● Generating'} · ${chars} chars${tools ? ` · 🔧 ${tools}` : ''}`,
      wfaStreamEnd: '✓ Stream ended — waiting for schema validation + deep check…',
      wfaAssistDisabled:
        'AI assistant is disabled — set GOTONG_ASSISTANT_PROVIDER + the matching API key and restart the host',
      wfaGenFailed: (e) => `Generation failed: ${e}`,
      wfaGenerateBtn: 'Generate draft',
      wfaSaving: 'Saving…',
      wfaSaveFailed: (e) => `Save failed: ${e}`,
      wfaSavedOk: (id) => `Saved workflow ${id}`,
      usgGroupUser: 'User',
      usgGroupAgent: 'Agent',
      usgGroupWorkflow: 'Workflow',
      usgGroupModel: 'Model',
      usgGroupDay: 'By day',
      usgGroupPeer: 'Federated peer',
      usgTitle: 'Usage / Cost',
      usgIntro:
        'Token and cost rolled up by dimension from the usage ledger. Cost is computed server-side from the model price list (integer micro-USD) and shown here in USD; unknown models record tokens at $0 cost. Prices can be overridden with <code>&lt;GOTONG_SPACE&gt;/pricing.json</code>.',
      usgGroupByLabel: 'Group by',
      usgRefreshBtn: 'Refresh',
      usgColDimension: 'Dimension',
      usgColCalls: 'Calls',
      usgColInputTokens: 'Input tokens',
      usgColOutputTokens: 'Output tokens',
      usgColCostUsd: 'Cost (USD)',
      usgLoadingCell: 'Loading...',
      usgTotal: 'Total',
      usgExportTitle: 'Export',
      usgExportHint: 'Download the full ledger or audit log (up to 10,000 rows).',
      usgDlLedgerCsv: 'Ledger CSV',
      usgDlLedgerJsonl: 'Ledger JSONL',
      usgDlAuditCsv: 'Audit CSV',
      usgDlAuditJsonl: 'Audit JSONL',
      usgLoading: 'Loading...',
      usgLoadedN: (n) => `Loaded ${n} rows`,
      usgHostDisabled: 'Host has no usage ledger enabled',
      usgLoadFailed: (e) => `Load failed: ${e}`,
      usgEmpty: 'No usage data yet. Once an LLM call produces tokens it will appear here automatically.',
      qtaTitle: 'Org quotas (soft limits)',
      qtaIntro: 'Threshold crossings are written to the audit log (<code>org_quota_warn</code> / <code>org_quota_over</code> / <code>org_quota_recover</code>). These are soft limits — they do not block LLM calls; real hard blocking is handled by per-user quotas.',
      qtaRefreshBtn: 'Refresh',
      qtaColMetric: 'Metric',
      qtaColPeriod: 'Period',
      qtaColUsageQuota: 'Used / Quota',
      qtaColPct: '%',
      qtaColState: 'State',
      qtaColWarnPct: 'warnPct',
      qtaColLastSweep: 'last sweep',
      qtaLoadingCell: 'Loading...',
      qtaFormTitle: 'Add / edit quota',
      qtaFormHint: 'Submitting the same (metric, period) again overrides the existing value; it does not reset accumulated usage.',
      qtaSaveBtn: 'Save',
      qtaLoading: 'Loading...',
      qtaLoadedN: (n) => `Loaded ${n} rows`,
      qtaLoadFailed: (msg) => `Load failed: ${msg}`,
      qtaEmpty: 'No quotas yet. Add one with the form below.',
      qtaSweepTip: (live, last) => `Host sweep has not reached this state yet (live: ${live} / last scan: ${last}); the audit log entry will catch up on the next sweep`,
      qtaDisabledDenom: '0 (disabled)',
      qtaSweepStale: '⚠ sweep stale',
      qtaEditBtn: 'Edit',
      qtaDelBtn: 'Delete',
      qtaConfirmDelete: (metric, period) => `Delete the quota for ${metric} / ${period}?`,
      qtaDeleted: 'Deleted',
      qtaDeleteFailed: (msg) => `Delete failed: ${msg}`,
      qtaMetricRequired: 'metric is required',
      qtaQuotaInvalid: 'quota must be a non-negative integer',
      qtaWarnPctInvalid: 'warnPct must be an integer between 1 and 99',
      qtaSaved: 'Saved',
      qtaSaveFailed: (msg) => `Save failed: ${msg}`,
      repTitle: 'Peer reputation',
      repMeta: 'A rolling EWMA (α=0.7) derived from the hub.feedback ledger. Range <code>[-1, +1]</code>; the scheduler ranks candidate peers by descending score (see <code>docs/zh/REPUTATION-ROUTING.md</code>). This panel is read-only — to lower a score, write negative feedback rather than resetting manually.',
      repRefresh: 'Refresh',
      repColPeer: 'Peer',
      repColScore: 'Score',
      repColSamples: 'Samples',
      repColUpdated: 'Last updated',
      repLoadingCell: 'Loading...',
      repLoadingStatus: 'Loading...',
      repLoadedN: (n) => `Loaded ${n} peers`,
      repNotEnabled: 'Host has not enabled reputation snapshot',
      repLoadFailed: (msg) => `Load failed: ${msg}`,
      repEmpty: 'No feedback data yet. Once cross-hub tasks have run and the feedback ledger has writes, scores will appear here automatically.',
      contribToggleTitle: 'Whether tasks I dispatch count toward the contribution leaderboard',
      setupTitle: 'First-time setup — set the owner password',
      setupIntro: 'The host is up, but the owner account has no password yet. Set one once on <strong>this machine</strong> (<code>127.0.0.1</code>); afterwards sign in with Email + password.<br>For deployments behind a reverse proxy, use the CLI instead: <code>gotong-host mint-admin-token</code>.',
      setupPwNew: 'New password (at least 12 chars)',
      setupPwConfirm: 'Enter it again',
      setupSubmit: 'Set password',
      setupSubmitMeta: 'Next step: configure an AI model key.',
      setupKeyTitle: 'Step 2 (optional) — configure an AI model key',
      setupKeyIntro: 'Add a model key so the first agent you create can run right away. The key lives only in this machine\'s encrypted vault and is never sent anywhere. You can skip and add it later under "Credentials".',
      setupKeyProvider: 'Model provider',
      setupKeyProviderDeepseek: 'DeepSeek (recommended · great value)',
      setupKeyProviderAnthropic: 'Anthropic (Claude)',
      setupKeyProviderOpenai: 'OpenAI',
      setupKeyInput: 'API Key',
      setupKeyPlaceholder: 'Paste your API key',
      setupKeySubmit: 'Save and finish',
      setupKeySkip: 'Skip, configure later',
      setupKeyNeed: 'Enter an API key, or click "Skip".',
      setupKeySaving: 'Saving…',
      setupKeySaved: 'Key saved, next step…',
      // DEPLOY-B2 — first-run IM step (wizard step 3).
      setupImTitle: 'Step 3 (optional) — connect an IM bot',
      setupImIntro: 'Add a bot credential and members can use this hub straight from their chat app (outbound long-poll — a home machine needs no public endpoint). The token lives only in this machine\'s encrypted vault. You can skip and configure via env vars later.',
      setupImPlatform: 'Platform',
      setupImPlatformTelegram: 'Telegram (create a bot via @BotFather)',
      setupImPlatformLark: 'Feishu / Lark (custom enterprise app)',
      setupImToken: 'Bot token',
      setupImTokenPlaceholder: 'Paste the token from BotFather',
      setupImAppId: 'App ID',
      setupImAppSecret: 'App Secret',
      setupImSubmit: 'Save and start the bot',
      setupImSkip: 'Skip, configure later',
      setupImNeedToken: 'Enter the bot token, or click "Skip".',
      setupImNeedLark: 'Enter both App ID and App Secret, or click "Skip".',
      setupImSaving: 'Saving and starting…',
      setupImSavedLive: 'Bot is live! Sign in, then grab a binding code under "Me" and DM it to the bot.',
      setupImSavedRestart: 'Token saved — the bot starts on the next host restart. Heading to sign-in…',
      // ease-of-use ①TC — "test connection" probe (shared by the setup wizard
      // key step AND the admin agent-create form). The verdict `code` → words
      // mapping lives in describeKeyTest() below; these are its strings.
      testConnBtn: 'Test connection',
      testConnHint: 'Sends one tiny request to the provider with the key you typed, just to verify it. Used only for the test — not saved, not shared.',
      testConnTesting: 'Testing…',
      testConnNeedKey: 'Enter an API key before testing.',
      testConnOk: (model, ms) => `Connected ✓ (model ${model}, ${ms}ms)`,
      testConnInvalidKey: 'Key invalid or unauthorized — check it was copied in full and the provider is right.',
      testConnInsufficientQuota: 'Out of balance/quota — this key has no credit left or hit its limit.',
      testConnRateLimited: 'Rate limited — wait a moment and retry (the key itself may be fine).',
      testConnNotFound: 'Model or endpoint not found — check the Base URL and model name.',
      testConnBadRequest: 'Request rejected — wrong provider or Base URL?',
      testConnUpstream: 'The provider had a temporary error — try again later.',
      testConnNetwork: 'Could not connect — check your network or the Base URL.',
      testConnTimeout: 'Timed out — slow network or an unresponsive endpoint.',
      testConnUnknown: 'Test failed (unknown error).',
      // ease-of-use ③TC — short, actionable fix hints appended to a friendly
      // error (describeError in app-core.js maps an error code → one of these).
      errFixKey: '→ Check or add a key under "API keys".',
      errFixModel: '→ Check the model name is correct.',
      errFixProvider: '→ Confirm the provider / Base URL is right.',
      errFixNetwork: '→ Make sure the provider is reachable and the port is right.',
      // ease-of-use ②TC — after a CREATE, the user is nudged to talk to the
      // brand-new agent right here and see it respond. The reply comes from the
      // agent itself (reuses the wait:true dispatch path).
      quickChatTitle: '✅ Assistant is live — say something to it now',
      quickChatHint: 'Send any message to confirm it actually responds. The reply comes from the agent itself.',
      quickChatInputLabel: 'Your message',
      quickChatSend: 'Send',
      quickChatDone: 'Done',
      quickChatSending: 'Sending…',
      quickChatNeedMsg: 'Type a message before sending.',
      quickChatOk: 'Got a reply ✓',
      quickChatNoResult: 'No reply received (it may have timed out).',
      quickChatFailed: (msg) => `Send failed: ${msg}`,
      quickChatAgentFailed: (reason) => `It couldn't respond: ${reason}`,
      loginTitle: 'Sign in to Gotong',
      loginPassword: 'Password',
      loginTotp: 'Two-factor code',
      loginTotpPlaceholder: '6-digit code',
      loginSubmit: 'Sign in',
      loginNoAccount: 'No account yet? Ask the owner to create one for you, or register with the invite link you received (<code>/invite/&lt;token&gt;</code>).',
      loginSsoOr: 'or',
      navMain: 'Main navigation',
      tabHome: 'Home',
      tabUsers: 'Users',
      tabQuotas: 'Quotas',
      tabUsage: 'Usage',
      tabReputation: 'Reputation',
      tabSettings: 'Settings',
      // REL-8c — /me member workspace + settings static HTML
      meWhoami: 'Current user',
      meDispatchTitle: 'Start a new workflow run',
      meDispatchHint: 'You can only start runs for yourself: the scope field is bound to your userId automatically — you can\'t see or change it, and other users\' records stay invisible to you.',
      meSelectWorkflow: 'Pick a workflow',
      meDispatchBtn: 'Start',
      meWfEditTitle: 'Edit this workflow in plain words',
      meWfEditHint1: 'No YAML needed — describe in one sentence how you want to change the workflow selected above (e.g. "make the first step\'s prompt more polite", "add a step that asks me to confirm first"). Requires editor permission.',
      meWfEditHint2: '⚠️ If this workflow connects to another hub, the cross-hub <strong>entry/exit</strong> (who can trigger it, which hub it sends to, what data it carries) is locked — you can only reshape your own local steps.',
      meWfEditLoadBtn: 'Open editor',
      meRunsTitle: 'Recent runs',
      meRunsHint: 'Your most recent workflow runs — only your own records are shown.',
      meColWorkflow: 'Workflow',
      meColStatus: 'Status',
      meColStart: 'Started',
      meColEnd: 'Finished',
      meNotLoaded: 'Not loaded yet',
      meInboxTitle: 'Pending tasks',
      meInboxHint: 'When a workflow step needs your decision, it shows up here. Once you handle it, the workflow continues with your choice.',
      meReportsTitle: 'My reports',
      meColFile: 'File',
      meColSize: 'Size',
      meColTime: 'Time',
      meAgentsTitle: 'My AI assistants',
      meAgentsHint: 'Agents the admin configured that you can call indirectly through the workflows above. Sensitive config like system prompts / keys is not shown.',
      meOwnTitle: 'Assistants I built myself',
      meOwnHint: 'Build your own AI assistant in your own words. It uses the org\'s model quota first (billed by usage); if the org hasn\'t configured one, it falls back to the key you add under "My API keys" below. Only you can see / edit / delete it.',
      meOwnHandle: 'Short name (letters/digits, immutable after creation)',
      meOwnLabel: 'Display name',
      meOwnLabelPh: 'My Chinese writer',
      meOwnCaps: 'Capability tags (comma or space separated)',
      meProvider: 'Model provider',
      meOwnModel: 'Model (optional, leave blank for default)',
      meOwnSystem: 'System prompt (tell it what you want it to do)',
      meOwnSystemPh: 'You are my Chinese writing assistant…',
      meOwnCancel: 'Cancel edit',
      meCredTitle: 'My API keys',
      meCredHint: 'Give your own assistants your own model key (bring your own key). When the org has no key for that provider, your assistant uses this one. The key is stored encrypted and never shown again; only you can manage it.',
      meCredKey: 'API key',
      meCredLabel: 'Note (optional)',
      meCredLabelPh: 'My personal key',
      meCredSubmit: 'Save key',
      // Personal Butler M6c — "what it remembers about you" privacy view (right to be forgotten)
      meButlerMemTitle: 'What your butler remembers',
      meButlerMemHint: 'Your butler keeps some long-term notes about you (the project you are on, your preferences) so it remembers you next time. Here you can see everything it has noted, forget any single entry or all of it, and export the lot. Only you can see it, only you can erase it.',
      meButlerMemRefresh: 'Refresh',
      meButlerMemExport: 'Export all',
      meButlerMemForgetAll: 'Forget all',
      meButlerMemProfile: 'What it knows about you long-term',
      meButlerMemRecent: 'Recently noted',
      meButlerMemLastDream: (promoted, pruned) =>
        `Last review: promoted ${promoted} into the profile / archived ${pruned} stale memories`,
      meButlerMemLastMaint: (summary) =>
        summary ? `Last maintenance: ${summary}` : 'Last maintenance: nothing to change',
      meButlerMemKindSemantic: 'Profile',
      meButlerMemKindEpisodic: 'Note',
      meButlerMemForget: 'Forget this',
      meButlerMemLoading: 'Loading…',
      meButlerMemEmpty: 'It has not noted anything about you yet.',
      meButlerMemForgetConfirm: 'Have the butler forget this entry? This cannot be undone.',
      meButlerMemForgetAllConfirm: 'Have the butler forget everything it remembers about you? This cannot be undone.',
      meButlerMemForgotten: 'Forgotten.',
      meButlerMemExported: (n) => `Exported ${n} ${n === 1 ? 'memory' : 'memories'}.`,
      meButlerMemTierPersona: 'Persona',
      meButlerMemTierProjects: 'Projects',
      meButlerMemTierPeople: 'People',
      meButlerMemTierCommitments: 'Commitments',
      meButlerMemTierMisc: 'Misc',
      meButlerMemLevelDigest: 'Digest',
      meButlerMemLevelProfile: 'Profile',
      meButlerMemImportance: (n) => `Importance ${n}`,
      meButlerMemActive: 'In effect',
      meButlerMemClosed: 'Expired',
      meButlerMemRecalls: (n) => `Recalled ${n}×`,
      meButlerMemLinks: (n) => `Links ${n}`,
      meButlerMemProcedure: 'How-to',
      setAccount: 'Account',
      setLogout: 'Log out',
      setChangePw: 'Change password',
      setCurrentPw: 'Current password',
      setNewPw: 'New password (at least 12 chars)',
      setSubmit: 'Submit',
      setMfa: 'Two-factor authentication (2FA)',
      setSimpleMode: 'Interface mode',
      setSimpleModeHint: 'Simple mode keeps only the everyday tabs (overview / agents / workflows / tasks / usage) and tucks away advanced areas like federation, users and SSO. Switch back to the full interface anytime — it changes no permissions.',
      setSimpleModeLabel: 'Enable simple mode',
      setPersonalMode: 'Personal mode',
      setPersonalModeHint: 'Currently in personal mode (1 user, simplified UI). Upgrading unlocks the full admin controls — user management / invitations / peers / quotas.',
      // REL-8d — admin modals + static HTML (disclaimer / growth reports / wf-assist / wf-start / bundle import)
      importBundle: 'Import team (bundle)',
      wfAssistBtn: 'AI assistant (beta)',
      close: 'Close',
      download: 'Download',
      disclaimerTitle: 'Welcome to Gotong · A few things first',
      disclaimerP1: '<strong>1. This is a personal local tool, not a cloud service.</strong> Your conversations, profiles, reports and API keys all live in the <code>.gotong-*</code> directories on this machine. We collect no data and the host sends no telemetry.',
      disclaimerP2: '<strong>2. LLM inference goes through a third-party API.</strong> Your four self-description sections are sent to the model provider you configure (DeepSeek / Anthropic / OpenAI, etc.) for inference. Each provider has its own data policy — read their privacy terms. If you have concerns, use a mock provider or a local LLM.',
      disclaimerP3: '<strong>3. This is not a substitute for a doctor / therapist / financial advisor / relationship counselor.</strong> The personal-growth coaches are designed as "bounded companions" — when they hit a red-flag signal they steer you to a professional. Do not treat them as diagnosis or prescription.',
      disclaimerP4: '<strong>4. If you are in a mental-health crisis, reach out immediately:</strong>',
      disclaimerCrisisCn1: '🇨🇳 Beijing Psychological Crisis Research & Intervention Center: <strong>010-82951332</strong>',
      disclaimerCrisisCn2: '🇨🇳 National Psychological Support Hotline: <strong>400-161-9995</strong>',
      disclaimerCrisisIntl: '🌏 Other regions: <a href="https://findahelpline.com" target="_blank" rel="noopener">findahelpline.com</a>',
      disclaimerP5: '<strong>5. You can delete your data at any time.</strong> Stop the host and remove the <code>.gotong-*</code> directories to wipe everything.',
      disclaimerAccept: "I've read it — let's start",
      growthReportsTitle: 'Growth reports',
      growthReportsHint: 'After a personal-growth workflow finishes a round, the synthesist consolidates the 7 outputs into one Markdown report, which lands here. Click "Download" to save it as a local file.',
      growthReportsEmpty: 'No reports yet — run the "Personal growth path" workflow once and they will appear.',
      colGeneratedTime: 'Generated',
      colActions: 'Actions',
      wfAssistModalTitle: 'Workflow Architect — generate workflow draft',
      wfAssistModalHint: 'Describe the workflow you want in one sentence (Chinese or English). The AI generates a YAML draft per <code>gotong.workflow/v1</code>; you can only save it after it validates automatically.',
      wfAssistDescLabel: 'Description',
      wfAssistDescPh: 'e.g. every Monday crawl 5 news sources, summarize with DeepSeek, post to a Telegram group',
      wfAssistGenerate: 'Generate draft',
      wfAssistStreaming: 'LLM is generating…',
      wfAssistStatusLabel: 'Status:',
      wfAssistYamlSummary: 'YAML draft',
      wfAssistErrorSummary: 'Validation errors',
      wfAssistDeepcheckSummary: 'Deep-check warnings',
      wfAssistSave: 'Save as workflow',
      wfAssistRegenerate: 'Regenerate',
      // workflow-architect ARCH-M4 — depth selector + diagram + explain mode.
      wfAssistDepthLabel: 'Explain depth',
      wfAssistDepthOneliner: 'One-liner',
      wfAssistDepthBrief: 'Brief',
      wfAssistDepthDetailed: 'Detailed',
      wfAssistGraphLabel: 'Flow chart',
      wfAssistGraphDownload: 'Download SVG',
      wfaArchExplainTitle: (id) => `Workflow Architect — explain “${id}”`,
      wfaArchExplainBtn: 'Explain',
      wfaArchExplainLoadFailed: 'Failed to load workflow',
      wfStartTitle: 'Start workflow',
      wfStartSubmit: 'Dispatch task',
      bundleImportHint: 'gotong.bundle/v1 format — one file holds a set of agents + one workflow + an API-key prompt. On import all agents are created at once, the workflow auto-registers, and you can dispatch right away.',
      bundleImportTemplates: 'Templates: <a href="https://github.com/Gotong/Gotong/tree/main/templates/bundles" target="_blank" rel="noopener">templates/bundles/</a> · or use a built-in template:',
      bundleBuiltinPg: '🎁 Use built-in template: Personal Growth (7 coaches + 12-week wall plan)',
      bundleKeyPh: 'Fill the key once for openai-compatible agents (leave blank to skip)',
      bundleKeyHint: 'If the bundle has <code>openai-compatible</code> agents (e.g. DeepSeek), paste the API key once and it applies to every such agent — no need to fill them one by one.',
      lbWindowAria: 'Time window',
    },
  }

  // --- language precedence (REL-9) ---------------------------------------
  // cookie (explicit toggle) > navigator.language (first-visit) >
  // config.defaultLang (applied later via syncLangFromConfig) > 'zh'.
  function readLangCookie() {
    try {
      const m = /(?:^|;\s*)lang=([^;]+)/.exec(document.cookie || '')
      if (m) {
        const v = decodeURIComponent(m[1]).toLowerCase()
        if (v === 'zh' || v === 'en') return v
      }
    } catch (e) { /* no cookie access */ }
    return null
  }
  function writeLangCookie(v) {
    // Non-HttpOnly (JS-set) so it survives reloads and the standalone
    // invite/offline pages read the same choice. Lax + 1-year; no Secure
    // flag so it still works over plain http on localhost / self-host.
    try {
      document.cookie = 'lang=' + encodeURIComponent(v) + '; path=/; max-age=31536000; samesite=lax'
    } catch (e) { /* */ }
  }
  function navigatorSeed() {
    try {
      const n = (navigator.language || navigator.userLanguage || '').toLowerCase()
      if (!n) return null
      return n.indexOf('zh') === 0 ? 'zh' : 'en'
    } catch (e) { return null }
  }

  // Seed at module load: cookie, else browser language, else 'zh' (config
  // from the server arrives later and only fills in when neither applies).
  let lang = readLangCookie() || navigatorSeed() || 'zh'
  let t = I18N[lang]

  // persist=true writes the cookie (a deliberate user toggle); programmatic
  // callers (syncLangFromConfig) leave it falsy so config never overwrites a
  // real choice.
  function setLang(next, persist) {
    if (next !== 'zh' && next !== 'en') return
    lang = next
    t = I18N[lang]
    if (persist) writeLangCookie(lang)
    document.documentElement.setAttribute('lang', lang)
    applyStaticI18n()
    for (const fn of langSubscribers) {
      try { fn(lang) } catch (e) { console.error(e) }
    }
  }

  const langSubscribers = []
  function onLangChange(fn) { langSubscribers.push(fn) }

  function applyStaticI18n() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const key = el.getAttribute('data-i18n')
      if (key && typeof t[key] === 'string') el.textContent = t[key]
    }
    // data-i18n-html: for elements whose translated content contains inline
    // markup (<strong>/<code>/<a>/<br>); innerHTML instead of textContent so
    // the markup survives. Dict values are author-controlled (never user
    // input), so this is not an injection surface.
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const key = el.getAttribute('data-i18n-html')
      if (key && typeof t[key] === 'string') el.innerHTML = t[key]
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      const key = el.getAttribute('data-i18n-placeholder')
      if (key && typeof t[key] === 'string') el.placeholder = t[key]
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      const key = el.getAttribute('data-i18n-title')
      if (key && typeof t[key] === 'string') el.setAttribute('title', t[key])
    }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) {
      const key = el.getAttribute('data-i18n-aria')
      if (key && typeof t[key] === 'string') el.setAttribute('aria-label', t[key])
    }
    const btn = document.getElementById('lang-toggle')
    if (btn) {
      btn.textContent = t.langButton
      btn.title = t.langTitle
    }
  }

  // --- DOM utilities -----------------------------------------------------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function escapeHtml(s) {
    // null/undefined → '' (not the literal "null"/"undefined") so callers
    // can pass possibly-absent fields without rendering a stray word.
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c])
  }
  const $ = (id) => document.getElementById(id)

  function setConn(status, label) {
    const el = $('conn')
    if (!el) return
    el.dataset.status = status
    el.textContent = label
  }

  function statusLabel(status) {
    switch (status) {
      case 'open':    return t.connected
      case 'error':   return t.reconnecting
      case 'pending': return t.connecting
      default:        return ''
    }
  }

  // --- transcript summary ------------------------------------------------

  function summarize(e) {
    switch (e.kind) {
      case 'participant_joined':
        return t.sumJoined(e.data.id, e.data.participantKind, (e.data.capabilities || []).join(','))
      case 'participant_left':
        return t.sumLeft(e.data.id)
      case 'message':
        return t.sumMessage(e.data.from, e.data.channel)
      case 'task': {
        const s = e.data.strategy
        const target =
          s.kind === 'explicit'   ? t.sumStrategyTo(s.to)
        : s.kind === 'capability' ? t.sumStrategyCaps(s.capabilities.join(','))
        :                            t.sumStrategyBroadcast
        return t.sumTask(e.data.from, e.data.title || '', s.kind, target)
      }
      case 'task_result': {
        const r = e.data
        if (r.kind === 'ok')        return t.sumOk(r.by)
        if (r.kind === 'failed')    return t.sumFailed(r.by, r.error)
        if (r.kind === 'cancelled') return t.sumCancelled(r.reason)
        return t.sumNoParticipant(r.reason)
      }
      case 'agent_pending':
        return t.sumAgentPending(e.data.agents.map((a) => a.id))
      case 'agent_approved':
        return t.sumAgentApproved(e.data.agentIds, e.data.by)
      case 'agent_rejected':
        return t.sumAgentRejected(e.data.agentIds, e.data.reason, e.data.by)
      case 'evaluation':
        return t.sumEvaluation(e.data.taskId, e.data.rating, e.data.comment, e.data.by)
    }
    return ''
  }

  function isBadResult(e) {
    return e.kind === 'task_result' &&
      (e.data.kind === 'failed' || e.data.kind === 'no_participant')
  }

  // --- HTTP utilities ----------------------------------------------------

  async function fetchJson(url, opts) {
    const r = await fetch(url, opts)
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      throw new Error(body.error || `${r.status} ${r.statusText}`)
    }
    if (r.status === 204) return null
    return r.json()
  }

  // SSE event types the server may emit. The server uses named SSE
  // events (`event: ${kind}\ndata: ...`) which the EventSource API
  // routes ONLY to per-name listeners — the default 'message' handler
  // never sees them. Pre-Phase-8 only the polling-based refresh path
  // kept the UI in sync; named-event handling was a silent miss. We
  // register a listener per known kind so every transcript event the
  // server forwards reaches applyEvent in real time.
  //
  // Add new TranscriptEntry kinds here when @gotong/core grows one;
  // unknown server events fall through to the generic 'message'
  // listener so future kinds don't go silent until this list is
  // updated.
  const SSE_EVENT_KINDS = [
    'participant_joined',
    'participant_left',
    'message',
    'task',
    'task_result',
    'agent_pending',
    'agent_approved',
    'agent_rejected',
    'evaluation',
    'service_trashed',
    'service_purged',
    'service_call',
    'llm_stream_chunk', // Phase 8 M6 — real-time LLM agent output
  ]

  function connectStream(onEvent) {
    setConn('pending', t.connecting)
    const es = new EventSource('/api/stream')
    es.addEventListener('open', () => setConn('open', t.connected))
    es.addEventListener('error', () => setConn('error', t.reconnecting))
    const handler = (e) => {
      try { onEvent(JSON.parse(e.data)) }
      catch (err) { console.error('SSE parse failed:', err) }
    }
    for (const kind of SSE_EVENT_KINDS) es.addEventListener(kind, handler)
    return () => es.close()
  }

  // --- contribution system (v2.1) ----------------------------------------

  /**
   * Convert a window preset (`all` / `today` / `week` / `month`) to a
   * `?from=&to=` URL query suffix understood by /api/leaderboard.
   * `today` is "since local midnight"; week/month are rolling.
   */
  function windowToQuery(win) {
    const now = Date.now()
    switch (win) {
      case 'today': {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        return `?from=${d.getTime()}&to=${now + 1}`
      }
      case 'week':
        return `?from=${now - 7 * 24 * 3600 * 1000}&to=${now + 1}`
      case 'month':
        return `?from=${now - 30 * 24 * 3600 * 1000}&to=${now + 1}`
      case 'all':
      default:
        return ''
    }
  }

  /**
   * GET /api/leaderboard with the given window preset. Resolves to the
   * Leaderboard object verbatim (rows already sorted by score desc).
   */
  function fetchLeaderboard(win) {
    return fetchJson(`/api/leaderboard${windowToQuery(win)}`)
  }

  /**
   * Render a Leaderboard into a container as a compact HTML table.
   * Workers and admins both call this; layout is identical between the
   * two surfaces. Empty windows render a single "no contributions yet"
   * row so the panel doesn't collapse to zero-height.
   */
  function renderLeaderboard(container, lb, summaryEl) {
    if (!container) return
    const rows = lb?.rows ?? []
    if (summaryEl) {
      summaryEl.textContent = t.lbSummary(lb?.totalTaskCount ?? 0, lb?.unratedTaskCount ?? 0)
    }
    if (rows.length === 0) {
      container.innerHTML = `<p class="empty">${escapeHtml(t.lbEmpty)}</p>`
      return
    }
    const head =
      `<thead><tr>` +
        `<th>${escapeHtml(t.lbColRank)}</th>` +
        `<th>${escapeHtml(t.lbColId)}</th>` +
        `<th class="num">${escapeHtml(t.lbColScore)}</th>` +
        `<th class="num">${escapeHtml(t.lbColTasks)}</th>` +
        `<th class="num">${escapeHtml(t.lbColAvg)}</th>` +
        `<th>${escapeHtml(t.lbColCaps)}</th>` +
        `<th>${escapeHtml(t.lbColLastSeen)}</th>` +
      `</tr></thead>`
    const body = rows.map((row, i) => {
      const caps = Object.entries(row.byCapability || {})
        .sort((a, b) => b[1].contribution - a[1].contribution)
        .map(([cap, v]) => `<span class="cap">${escapeHtml(cap)}·${formatScore(v.contribution)}</span>`)
        .join('') || `<em class="empty">–</em>`
      const lastSeen = row.lastActivityTs
        ? new Date(row.lastActivityTs).toLocaleString()
        : ''
      return (
        `<tr>` +
          `<td class="lb-rank">${i + 1}</td>` +
          `<td class="lb-id"><strong>${escapeHtml(row.participantId)}</strong></td>` +
          `<td class="num lb-score">${formatScore(row.totalContribution)}</td>` +
          `<td class="num">${row.taskCount}</td>` +
          `<td class="num">${formatScore(row.averageRating)}</td>` +
          `<td class="lb-caps">${caps}</td>` +
          `<td class="lb-last">${escapeHtml(lastSeen)}</td>` +
        `</tr>`
      )
    }).join('')
    container.innerHTML = `<table class="leaderboard-table">${head}<tbody>${body}</tbody></table>`
  }

  /**
   * Format a contribution number for display: at most 1 decimal place,
   * trailing zero trimmed (so 10.0 → "10", 4.5 → "4.5").
   */
  function formatScore(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '–'
    const r = Math.round(n * 10) / 10
    return Number.isInteger(r) ? String(r) : r.toFixed(1)
  }

  /**
   * Wire up the contribution opt-out toggle in the header. Pass the
   * label-wrapper element (the `<label id="contrib-toggle">`) plus the
   * checkbox `<input>`. We POST /api/me/contribution-opt-out on every
   * change; the server is the source of truth. The toggle is set to
   * the value last returned by /api/whoami.
   *
   * Convention: the checkbox represents the *positive* "count me" state
   * because that's what users want to keep on by default. So
   * `checkbox.checked === !contributionOptOut`.
   */
  function attachContribToggle(toggleEl, inputEl) {
    if (!toggleEl || !inputEl) return
    inputEl.addEventListener('change', async () => {
      const value = !inputEl.checked   // checkbox on -> opt-out off
      try {
        const r = await fetchJson('/api/me/contribution-opt-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        })
        applyContribToggleState(toggleEl, inputEl, r?.contributionOptOut === true)
      } catch (err) {
        // revert the visual on failure
        inputEl.checked = !inputEl.checked
        alert(t.failedAlert(err.message || String(err)))
      }
    })
  }

  /** Render the toggle's checked-state and tooltip for a given optOut value. */
  function applyContribToggleState(toggleEl, inputEl, optOut) {
    if (!toggleEl || !inputEl) return
    inputEl.checked = !optOut
    toggleEl.title = optOut ? t.contribToggleTitleOff : t.contribToggleTitleOn
    toggleEl.classList.toggle('contrib-toggle-off', optOut)
  }

  /**
   * Common capability strings — surface in <datalist> + a one-click "chip"
   * row underneath every `capabilities` input across admin and worker
   * UIs. Purely a UX prop: nothing in the Hub or scheduler knows about
   * this list. Picked to be:
   *   - verb-like, kebab-case
   *   - covers the most common patterns from `templates/` and
   *     `templates/community/`
   *   - small enough to be skimmable (≤ 24 entries)
   *
   * Users can still type any string — chips are suggestions, not a
   * controlled vocabulary.
   */
  const CAPABILITY_SUGGESTIONS = [
    'draft', 'review', 'summarize', 'translate', 'improve-prose',
    'code', 'code-review', 'debug', 'refactor', 'test', 'document',
    'analyze', 'classify', 'extract', 'stats',
    'tutor', 'explain', 'coach',
    'approve', 'evaluate', 'interview', 'story', 'prompt-design', 'tech-doc',
  ]

  /**
   * Mount a chip-row of common capabilities next to an `<input>` whose
   * value is a comma-separated capability list. Each chip click toggles
   * its capability in the input. Idempotent — calling twice no-ops.
   *
   * Renders into the element passed as `container`. Falls back to
   * `input.parentNode` if no container is given.
   */
  function attachCapChips(input, container) {
    if (!input) return
    ensureCapDatalist()
    input.setAttribute('list', 'cap-datalist')
    const host = container || input.parentNode
    if (!host || host.querySelector('.cap-chips')) return // already mounted
    const row = document.createElement('div')
    row.className = 'cap-chips'

    const label = document.createElement('span')
    label.className = 'cap-chips-label'
    label.textContent = t.commonCaps ?? '常用：'
    row.appendChild(label)

    const chipFor = (cap) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cap-chip'
      b.dataset.cap = cap
      b.textContent = cap
      b.title = cap
      return b
    }
    for (const cap of CAPABILITY_SUGGESTIONS) row.appendChild(chipFor(cap))

    function syncChipState() {
      const set = new Set(parseCapsInput(input.value))
      for (const chip of row.querySelectorAll('.cap-chip')) {
        if (set.has(chip.dataset.cap)) chip.classList.add('cap-chip-active')
        else chip.classList.remove('cap-chip-active')
      }
    }

    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.cap-chip')
      if (!chip) return
      const cap = chip.dataset.cap
      const caps = parseCapsInput(input.value)
      const idx = caps.indexOf(cap)
      if (idx === -1) caps.push(cap)
      else caps.splice(idx, 1)
      input.value = caps.join(', ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      syncChipState()
    })

    // Live re-sync when the user edits the input by hand.
    input.addEventListener('input', syncChipState)
    onLangChange(() => { label.textContent = t.commonCaps ?? '常用：' })

    host.appendChild(row)
    syncChipState()
  }

  function parseCapsInput(value) {
    return String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  function ensureCapDatalist() {
    if (document.getElementById('cap-datalist')) return
    const dl = document.createElement('datalist')
    dl.id = 'cap-datalist'
    for (const cap of CAPABILITY_SUGGESTIONS) {
      const opt = document.createElement('option')
      opt.value = cap
      dl.appendChild(opt)
    }
    // Body is fine — datalist is invisible and just an id-based lookup.
    document.body.appendChild(dl)
  }

  /**
   * Inline metrics shown on a task card: "权重 2.0 · 评分 4.5 · 贡献 9.0"
   * (or "权重 2.0 · 未评" if no rating yet). Returns a safe HTML string
   * already escaped — callers should drop it into innerHTML as-is.
   */
  function taskMetricsHtml(view) {
    const parts = []
    const w = view.weight ?? view.task?.weight ?? 1.0
    parts.push(`<span class="metric metric-weight">${escapeHtml(t.weightLabel)} ${formatScore(w)}</span>`)
    if (typeof view.effectiveRating === 'number') {
      parts.push(`<span class="metric metric-rating">${escapeHtml(t.ratingLabel)} ${formatScore(view.effectiveRating)}/5</span>`)
      parts.push(`<span class="metric metric-contribution">${escapeHtml(t.contributionLabel)} ${formatScore(view.contribution ?? 0)}</span>`)
    } else if (view.status === 'done') {
      parts.push(`<span class="metric metric-unrated">${escapeHtml(t.unrated)}</span>`)
    }
    return parts.join('')
  }

  // Compact byte-count + timestamp formatters, shared across app.js and the
  // admin console. Collapsed here from 3 duplicated copies (R14). formatBytes
  // guards non-numbers (→ '—'); the numeric tiers match the old copies.
  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }
  function formatTs(ts) {
    if (!ts) return '—'
    try {
      const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts))
      if (Number.isNaN(d.getTime())) return String(ts)
      return d.toLocaleString()
    } catch { return String(ts) }
  }

  // ease-of-use ①TC — turn a /test-llm-key verdict into one localized line.
  // The `code → words` map lives HERE, in one place, so the setup wizard and
  // the admin agent-create form render identical, honest verdicts. Reads the
  // live `t` (module-scoped, flips on setLang), so it follows the toggle.
  // Returns { level: 'ok' | 'error', text } — callers pick the CSS class.
  const KEY_TEST_CODE_KEYS = {
    invalid_key: 'testConnInvalidKey',
    insufficient_quota: 'testConnInsufficientQuota',
    rate_limited: 'testConnRateLimited',
    not_found: 'testConnNotFound',
    bad_request: 'testConnBadRequest',
    upstream: 'testConnUpstream',
    network: 'testConnNetwork',
    timeout: 'testConnTimeout',
  }
  function describeKeyTest(result) {
    if (!result || typeof result !== 'object') {
      return { level: 'error', text: t.testConnUnknown }
    }
    if (result.ok) {
      const fn = t.testConnOk
      const text = typeof fn === 'function'
        ? fn(result.model || '?', Math.max(0, Math.round(Number(result.latencyMs) || 0)))
        : 'ok'
      return { level: 'ok', text }
    }
    const key = KEY_TEST_CODE_KEYS[result.code] || 'testConnUnknown'
    return { level: 'error', text: t[key] || t.testConnUnknown }
  }

  // ease-of-use ③TC — friendly errors. A dispatch / quick-chat failure reaches
  // the browser as a RAW provider error STRING (no structured HTTP status the
  // way the key-test probe verdict carries one), so classify the text into the
  // SAME category vocabulary the backend probe uses (llm-key-test.ts
  // classifyKeyError) and reuse the SAME friendly explanation (KEY_TEST_CODE_KEYS
  // above → testConn* words, one source of truth) plus a short, actionable fix
  // hint. This is the string-only mirror of the server-side classifier; the
  // pattern order matches its priority (transport → auth → quota → rate → …).
  const ERROR_FIX_KEYS = {
    invalid_key: 'errFixKey',
    insufficient_quota: 'errFixKey',
    not_found: 'errFixModel',
    bad_request: 'errFixProvider',
    network: 'errFixNetwork',
    // rate_limited / timeout / upstream / unknown — transient or unclear; no
    // single fix action, so the caller shows just the explanation.
  }
  function classifyErrorText(raw) {
    const s = String(raw || '').toLowerCase()
    if (!s) return 'unknown'
    // Transport — never reached the provider's HTTP layer (wrong Base URL / DNS).
    // The OpenAI / DeepSeek / Anthropic SDKs all surface a dead endpoint as the
    // bare string "Connection error." (no errno prefix), so the human-readable
    // connection-* phrases must be here too, not just the low-level errno codes.
    if (/econnrefused|enotfound|eai_again|econnreset|etimedout|epipe|fetch failed|socket hang up|getaddrinfo|other side closed|network error|und_err|connection error|connection refused|connection reset|connection closed|connection timed|connect timeout|unable to connect|could not connect|failed to connect/.test(s)) return 'network'
    // Our own abort budget, or any deliberate cancel/timeout.
    if (/abort(ed|error)?|timed?\s?out|timeout|deadline exceeded/.test(s)) return 'timeout'
    // Explicit auth signals win over quota (mirror: backend keys 401/403 before 429 body).
    if (/\b401\b|\b403\b|unauthorized|unauthenticated|forbidden|invalid[^.]{0,16}(api[ _-]?key|token)|incorrect api key|authentication|no api key|missing api key|api key.{0,16}(missing|not|invalid)|not configured/.test(s)) return 'invalid_key'
    if (/\b402\b|quota|insufficient|balance|credit|billing|exceeded your current|out of/.test(s)) return 'insufficient_quota'
    if (/\b429\b|rate[ _-]?limit|too many requests/.test(s)) return 'rate_limited'
    if (/\b404\b|not found|no such model|unknown model|does not exist|model_not_found/.test(s)) return 'not_found'
    if (/\b400\b|\b422\b|bad request|invalid request|unprocessable/.test(s)) return 'bad_request'
    if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded|upstream/.test(s)) return 'upstream'
    return 'unknown'
  }
  // Returns { code, text, fix, fixIsKey } — `text` is the friendly explanation,
  // `fix` is the actionable next step ('' when none applies), and `fixIsKey` is
  // the one authoritative "this failure is fixed by adding/replacing an LLM key"
  // flag: it is TRUE exactly for the codes whose fix hint is errFixKey
  // (invalid_key + insufficient_quota). Both the member quick-chat (③TC-ME) and
  // the admin quick-chat (③TC-ADMIN) read THIS flag to decide whether to show a
  // one-click "go add a key" button, so the code→is-key-fix mapping lives in
  // ERROR_FIX_KEYS alone and neither surface re-encodes the code list.
  function describeError(raw) {
    const code = classifyErrorText(raw)
    const text = t[KEY_TEST_CODE_KEYS[code]] || t.testConnUnknown
    const fixKey = ERROR_FIX_KEYS[code]
    return { code, text, fix: fixKey ? (t[fixKey] || '') : '', fixIsKey: fixKey === 'errFixKey' }
  }

  // --- expose -------------------------------------------------------------

  window.Gotong = {
    get lang() { return lang },
    get t() { return t },
    setLang,
    onLangChange,
    applyStaticI18n,
    statusLabel,
    setConn,
    escapeHtml,
    formatBytes,
    formatTs,
    summarize,
    isBadResult,
    describeKeyTest,
    describeError,
    fetchJson,
    connectStream,
    $,
    // contribution system (v2.1)
    fetchLeaderboard,
    renderLeaderboard,
    windowToQuery,
    formatScore,
    taskMetricsHtml,
    attachContribToggle,
    applyContribToggleState,
    // Capability suggestion chips (v2.1+)
    CAPABILITY_SUGGESTIONS,
    attachCapChips,
    /**
     * Synchronise language with what the server says is the space default.
     * Pages call this once on boot after fetching /api/state.
     *
     * Precedence (REL-9): an explicit `lang` cookie or a navigator-language
     * seed already decided things at module load, so config.defaultLang is
     * an OPERATOR FALLBACK only — it applies solely when the visitor has
     * neither a saved choice nor a recognisable browser language. We never
     * persist here (persist omitted), so a config flip can't overwrite a
     * member's real toggle on their next visit.
     */
    syncLangFromConfig(defaultLang) {
      if (readLangCookie() || navigatorSeed()) return
      if (defaultLang === 'zh' || defaultLang === 'en') {
        if (defaultLang !== lang) setLang(defaultLang)
      }
    },
  }

  document.documentElement.setAttribute('lang', lang)
  document.addEventListener('DOMContentLoaded', () => {
    applyStaticI18n()
    const btn = $('lang-toggle')
    if (btn) {
      // persist=true: a deliberate toggle writes the `lang` cookie so the
      // choice survives reloads and follows the member to the standalone
      // invite/offline pages (which read the same cookie).
      btn.addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh', true))
    }
  })
})()
