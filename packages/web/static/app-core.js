/* AipeHub web UI — shared core (v2.0).
 *
 * "File-first" mindset extends to the browser: NO localStorage, NO
 * sessionStorage. The only state the browser keeps is HttpOnly cookies
 * set by the server (admin / worker session pointers, opaque to JS).
 * Everything else round-trips to the server and back.
 *
 * Language preference defaults to the value the server returns in
 * /api/state.config.defaultLang; switching it is a per-tab, non-persistent
 * toggle. This is intentional.
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
      adminBadge: '管理员',
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
      youAre: '你的身份',
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
      servicesPreview: '预览',
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
      servicesNoneForAgent: '此智能体未使用任何服务',
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
      workflowImportHint: '只支持 schema: aipehub.workflow/v1 格式。导入后立刻在 Hub 注册为一个 workflow:<id> 参与者，并写入 .aipehub/workflows/definitions/ 目录（host 重启自动加载）。',
      workflowsEmpty: '尚未加载任何工作流',
      workflowsSummary: (count) => `已加载 ${count} 个`,
      workflowStepsLabel: (n) => `${n} 步`,
      workflowTriggerLabel: '触发能力',
      workflowImportDone: (id) => `已导入 workflow:${id}，立刻可用。文件已写入 definitions/。`,
      workflowRemoveBtn: '移除',
      confirmRemoveWorkflow: (id) =>
        `确定要移除 workflow "${id}" 吗？runner 立刻下线，YAML 文件会被删除（不可恢复）。已派出未完成的任务会照常跑完。`,
      workflowRemoveDone: (id) => `已移除 workflow:${id}`,
      workflowRunsBtn: '历史',
      workflowRunsTitle: '运行历史',
      workflowRunsEmpty: '还没有跑过这条工作流。',
      workflowRunsPickHint: '从左侧点一行查看明细。',
      workflowRunStepCount: (n) => `${n} 步`,
      workflowRunDuration: '耗时',
      workflowRunStillRunning: '进行中',
      workflowRunTriggeredBy: '触发任务',
      workflowRunTriggerPayload: '触发 payload',
      workflowRunFinal: '最终输出',
      workflowRunOutput: '输出',
      workflowRunSubTasks: '子任务',
      workflowRunNoSteps: '尚未开始任何步骤。',
      workflowRunAttempts: (n) => `${n} 次尝试`,
      // Phase 15 — workflow lifecycle (state badge on cards + revision history)
      workflowStateLabel: (s) =>
        ({ published: '已发布', deprecated: '已弃用', draft: '草稿', review: '待审核', archived: '已归档' }[s] || s),
      workflowRevTag: (n) => `rev ${n}`,
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
      ghImportBtn: '从 GitHub 导入',
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
      errorAlert: (msg) => `错误：${msg}`,
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
    },
    en: {
      subtitle: 'communication space',
      connecting: 'connecting…',
      connected: 'connected',
      reconnecting: 'reconnecting…',
      unreachable: 'cannot reach server',
      langButton: '中',
      langTitle: '切换到中文',
      adminBadge: 'admin',
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
      youAre: 'You are',
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
      servicesPreview: 'Preview',
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
      servicesNoneForAgent: 'This agent uses no services',
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
      workflowImportHint: 'Accepts schema: aipehub.workflow/v1 only. On import, the runner is registered immediately as a workflow:<id> participant and the file is written to .aipehub/workflows/definitions/ (host auto-loads on restart).',
      workflowsEmpty: 'No workflows loaded yet',
      workflowsSummary: (count) => `${count} loaded`,
      workflowStepsLabel: (n) => `${n} step${n === 1 ? '' : 's'}`,
      workflowTriggerLabel: 'Trigger capability',
      workflowImportDone: (id) => `Imported workflow:${id}. Ready to dispatch. File saved to definitions/.`,
      workflowRemoveBtn: 'Remove',
      confirmRemoveWorkflow: (id) =>
        `Remove workflow "${id}"? The runner goes offline immediately and the YAML file will be deleted (no recovery). In-flight tasks already dispatched finish normally.`,
      workflowRemoveDone: (id) => `Removed workflow:${id}`,
      workflowRunsBtn: 'History',
      workflowRunsTitle: 'Run history',
      workflowRunsEmpty: 'No runs recorded yet for this workflow.',
      workflowRunsPickHint: 'Pick a run on the left to see details.',
      workflowRunStepCount: (n) => `${n} step${n === 1 ? '' : 's'}`,
      workflowRunDuration: 'Duration',
      workflowRunStillRunning: 'still running',
      workflowRunTriggeredBy: 'Trigger task',
      workflowRunTriggerPayload: 'Trigger payload',
      workflowRunFinal: 'Final output',
      workflowRunOutput: 'Output',
      workflowRunSubTasks: 'Sub-tasks',
      workflowRunNoSteps: 'No steps recorded yet.',
      workflowRunAttempts: (n) => `${n} attempt${n === 1 ? '' : 's'}`,
      // Phase 15 — workflow lifecycle (state badge on cards + revision history)
      workflowStateLabel: (s) =>
        ({ published: 'Published', deprecated: 'Deprecated', draft: 'Draft', review: 'In review', archived: 'Archived' }[s] || s),
      workflowRevTag: (n) => `rev ${n}`,
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
      ghImportBtn: 'Import from GitHub',
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
      errorAlert: (msg) => `error: ${msg}`,
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
    },
  }

  // The default lang comes from the server (space config.defaultLang); the
  // toggle is per-tab and non-persistent.
  let lang = 'zh'
  let t = I18N[lang]

  function setLang(next) {
    if (next !== 'zh' && next !== 'en') return
    lang = next
    t = I18N[lang]
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
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      const key = el.getAttribute('data-i18n-placeholder')
      if (key && typeof t[key] === 'string') el.placeholder = t[key]
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
  // Add new TranscriptEntry kinds here when @aipehub/core grows one;
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

  // --- expose -------------------------------------------------------------

  window.AipeHub = {
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
     */
    syncLangFromConfig(defaultLang) {
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
      btn.addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh'))
    }
  })
})()
