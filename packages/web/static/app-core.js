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
      pickTaskHint: '点击下方消息流里 task_result 行可自动填入 task ID',
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
      pickTaskHint: 'Click a task_result row in the transcript to autofill task ID',
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
    return String(s).replace(/[&<>"']/g, (c) => ESC[c])
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

  function connectStream(onEvent) {
    setConn('pending', t.connecting)
    const es = new EventSource('/api/stream')
    es.addEventListener('open', () => setConn('open', t.connected))
    es.addEventListener('error', () => setConn('error', t.reconnecting))
    es.addEventListener('message', (e) => {
      try { onEvent(JSON.parse(e.data)) }
      catch (err) { console.error('SSE parse failed:', err) }
    })
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
