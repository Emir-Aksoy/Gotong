/**
 * mcp-elicitation.ts — ELIC:连接器中途提问(MCP elicitation)的宿主策略。
 *
 * MCP 2025-06 起,server 可以在一次 tools/call 进行中反问 client
 * (`elicitation/create`,如「哪个 workspace?」)。agent 工具面这条路径上
 * **结构性没有人同步在场**:elicit 活在一次 callTool 的等待窗内(客户端
 * 超时默认 60s),而 Gotong 的人机面(/me 收件箱、IM 审批)是分钟到小时级
 * ——把问题 park 给成员再续等,物理上塞不进这扇窗。
 *
 * 所以 v1 策略 = **声明能力 + 确定性婉拒**:
 *
 * - 声明不是撒谎——capability 的含义是「能接收并应答 elicitation/create」,
 *   decline 是规范里的一等答案(spec 要求 server 对 decline 优雅降级);
 * - 比不声明更好:规范正确的 server 会先查能力,不声明=它直接抛
 *   「client 不支持」;声明+婉拒=走它自己设计的 decline 分支,给模型的
 *   降级信息更有含义;
 * - 每次婉拒记一条结构化 warn(server 名 + 截断清洗后的问题摘要 + 字段名
 *   摘要),操作者在日志里能看见「连接器想要什么」;模型侧则看到 server
 *   自己的降级文案。warn 里的 message/fields 是**对端任意内容**——清洗
 *   控制字符、截断长度、限字段数,日志面不给注入面当喇叭。
 *
 * 显式推迟:交互式应答器(把问题递给正在会话中的成员并在窗内收答)需要
 * 一套会话内问答机——等真实连接器高频撞上再起,缝(McpElicitationHandler
 * 注入点)已留好,届时是换 handler 不是改结构。
 */

import type { McpElicitationHandler } from '@gotong/mcp-client'

export interface McpElicitationLogger {
  warn(msg: string, data?: Record<string, unknown>): void
}

/** warn 摘要的边界——问题文本/单个字段名的截断长度与字段数上限。 */
const ELICIT_WARN_MESSAGE_MAX = 120
const ELICIT_WARN_FIELD_MAX = 40
const ELICIT_WARN_FIELDS_MAX = 8

/** 对端任意字符串 → 日志安全的一行摘要:去控制字符、折叠空白、截断。 */
function sanitizeForLog(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const oneLine = v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * 确定性婉拒策略(零 LLM):对每个 elicitation 请求返回 `decline` 并
 * 记一条带上下文的 warn。绝不 accept(没有人授权任何答案)、绝不抛
 * (toolset 层已把 handler 崩溃折成 cancel,这里连那条路都不走)。
 *
 * warn 的 message/fields 来自对端,按上面的常量清洗+截断;原始长度以
 * `messageChars` / `fieldCount` 保留,截断不是隐瞒。
 */
export function declineElicitations(
  log: McpElicitationLogger,
  agentId?: string,
): McpElicitationHandler {
  return async (req) => {
    const rawMessage = typeof req.message === 'string' ? req.message : ''
    const rawFields = Object.keys(req.requestedSchema?.properties ?? {})
    log.warn('mcp elicitation auto-declined (no interactive answerer on the agent path)', {
      ...(agentId ? { agentId } : {}),
      serverName: req.serverName,
      message: sanitizeForLog(rawMessage, ELICIT_WARN_MESSAGE_MAX),
      messageChars: rawMessage.length,
      fields: rawFields
        .slice(0, ELICIT_WARN_FIELDS_MAX)
        .map((f) => sanitizeForLog(f, ELICIT_WARN_FIELD_MAX)),
      fieldCount: rawFields.length,
    })
    return { action: 'decline' }
  }
}
