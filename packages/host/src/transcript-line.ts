import type { TranscriptEntry } from '@gotong/core'

/**
 * 把一条 transcript 事件渲染成 host stdout 的那一行。
 *
 * 纯函数、无闭包依赖——它待在 main.ts 里没有任何理由,只是历史上写在那儿。
 * 抽出来一是给 main.ts 腾预算,二是让「host 日志长什么样」这件事第一次可以
 * **单独测**:每个 kind 都得有一行,漏一个 kind 的回归以前只有肉眼盯 stdout
 * 才看得见。
 *
 * 一行一事件,前缀是定宽的动词(`JOIN` / `MSG` / `RESULT` …),好让 `grep`
 * 和肉眼扫日志都对得齐。内容刻意留白:大块负载(LLM chunk 正文、service_call
 * 的结果)一律只报形状不报内容——stdout 不是 transcript,真数据在 `.gotong/`
 * 里,面板/API 才是读它的地方。
 */
export function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
    case 'task':
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      if (e.data.kind === 'ok') return `RESULT   ok by ${e.data.by}`
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      // Phase 11 M2 — suspended kind in TaskResult union. Show the
      // wake-up time in the host log so operators tailing the
      // stdout can see "task X is parked until 12:34" without
      // opening the SQLite row directly.
      if (e.data.kind === 'suspended')
        return `RESULT   suspended by ${e.data.by} until ${new Date(e.data.resumeAt).toISOString()}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'agent_pending':
      return `PENDING  app=${e.data.id} agents=[${e.data.agents.map((a) => a.id).join(',')}]`
    case 'agent_approved':
      return `APPROVE  app=${e.data.applicationId} agents=[${e.data.agentIds.join(',')}] by ${e.data.by ?? '?'}`
    case 'agent_rejected':
      return `REJECT   app=${e.data.applicationId} by ${e.data.by ?? '?'}: ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId} rating=${e.data.rating ?? '?'} by ${e.data.by}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId} ref=${e.data.ref.id}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
    case 'service_call':
      // v1.2: one line per resolved SERVICE_CALL. Audit lines for OK
      // calls are noisy at the host's stdout level but useful when
      // debugging; admins prefer the structured `/api/admin/transcript/
      // service-calls` view. Either way the data lives in the
      // transcript.
      return `SVCCALL  ${e.data.from} ${e.data.type}:${e.data.impl}#${e.data.method} → ${e.data.outcome} (${e.data.durationMs}ms)`
    case 'llm_stream_chunk':
      // Phase 8 M6 — agent stream chunks. Don't print every chunk to
      // stdout (would dominate the log); just summarize the chunk
      // type. Operators wanting the actual text use the admin UI's
      // SSE stream where chunks arrive in real time.
      return `LLMCHUNK ${e.data.agentId} task=${e.data.taskId} kind=${
        (e.data.chunk as { type?: string } | null)?.type ?? '?'
      }`
    case 'task_resumed':
      // Phase 11 M3 — resume sweep signal. Paired with a subsequent
      // task_result line; together they trace "task X woken on agent
      // Y, then produced result Z" in the host stdout.
      return `RESUME   task=${e.data.taskId} by ${e.data.by}`
  }
}
