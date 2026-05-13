/* AipeHub web UI — shared core.
 *
 * Loaded by both admin.html and worker.html. Owns:
 *   - i18n dictionary (zh default, en alt)
 *   - SSE connection to /api/stream
 *   - state snapshot fetch
 *   - common DOM utilities
 *
 * Page-specific scripts (admin.js / worker.js) consume `window.AipeHub.*`.
 *
 * No bundler, no framework — IIFE attached to window.
 */
(() => {
  // --- i18n --------------------------------------------------------------

  const I18N = {
    zh: {
      // header
      subtitle: '通信空间',
      connecting: '连接中…',
      connected: '已连接',
      reconnecting: '重连中…',
      unreachable: '无法连接服务器',
      langButton: 'EN',
      langTitle: 'Switch to English',
      // roles
      adminBadge: '管理员',
      workerBadge: '工人',
      logout: '退出',
      // participants
      participants: '参与者',
      noParticipants: '暂无参与者',
      noCaps: '无能力',
      load: '负载',
      pKind: { agent: '代理', human: '人类' },
      // transcript
      transcript: '消息流',
      // tasks
      pending: '待人类处理',
      noPending: '暂无待办任务',
      untitled: '（未命名）',
      approve: '批准',
      reject: '拒绝',
      // worker view
      joinSpace: '加入通信空间',
      nickname: '昵称（ID）',
      capabilitiesLabel: '擅长能力（逗号分隔，可选）',
      capabilitiesPlaceholder: '如：review, translate',
      joinButton: '进入',
      leaveButton: '离开',
      myTasksLabel: '派给我的任务',
      noMyTasks: '暂无派给你的任务',
      youAre: '你的身份',
      // admin view
      adminTitle: '管理员控制台',
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
      evaluatePanel: '任务评价',
      evaluateTaskId: 'task ID',
      evaluateRating: '评分（1-5，可选）',
      evaluateComment: '评语（可选）',
      evaluateButton: '提交评价',
      evaluateSuccess: '评价已记录',
      pickTaskHint: '点击下方消息流里 task_result 行可自动填入 task ID',
      // alerts
      failedAlert: (msg) => `失败：${msg}`,
      errorAlert: (msg) => `错误：${msg}`,
      // summary
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
      participants: 'Participants',
      noParticipants: 'no participants',
      noCaps: 'no caps',
      load: 'load',
      pKind: { agent: 'agent', human: 'human' },
      transcript: 'Transcript',
      pending: 'Pending for humans',
      noPending: 'no pending tasks',
      untitled: '(untitled)',
      approve: 'Approve',
      reject: 'Reject',
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
      evaluatePanel: 'Evaluate a task',
      evaluateTaskId: 'task ID',
      evaluateRating: 'Rating (1-5, optional)',
      evaluateComment: 'Comment (optional)',
      evaluateButton: 'Submit',
      evaluateSuccess: 'Evaluation recorded',
      pickTaskHint: 'Click a task_result row in the transcript to autofill task ID',
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

  const LANG_KEY = 'aipehub.lang'

  function getLang() {
    try {
      const stored = localStorage.getItem(LANG_KEY)
      if (stored === 'zh' || stored === 'en') return stored
    } catch (_) { /* ignore */ }
    return 'zh'
  }

  let lang = getLang()
  let t = I18N[lang]

  function setLang(next) {
    if (next !== 'zh' && next !== 'en') return
    lang = next
    t = I18N[lang]
    try { localStorage.setItem(LANG_KEY, lang) } catch (_) { /* ignore */ }
    document.documentElement.setAttribute('lang', lang)
    applyStaticI18n()
    // notify subscribers (page-specific re-renders)
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

  // --- SSE plumbing -------------------------------------------------------

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
  }

  // --- init ---------------------------------------------------------------

  document.documentElement.setAttribute('lang', lang)
  document.addEventListener('DOMContentLoaded', () => {
    applyStaticI18n()
    const btn = $('lang-toggle')
    if (btn) {
      btn.addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh'))
    }
  })
})()
