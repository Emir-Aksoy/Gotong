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
 * - 每次婉拒记一条结构化 warn(server 名 + 问题 + 字段名),操作者在日志
 *   里能看见「连接器想要什么」;模型侧则看到 server 自己的降级文案。
 *
 * 显式推迟:交互式应答器(把问题递给正在会话中的成员并在窗内收答)需要
 * 一套会话内问答机——等真实连接器高频撞上再起,缝(McpElicitationHandler
 * 注入点)已留好,届时是换 handler 不是改结构。
 */

import type { McpElicitationHandler } from '@gotong/mcp-client'

export interface McpElicitationLogger {
  warn(msg: string, data?: Record<string, unknown>): void
}

/**
 * 确定性婉拒策略(零 LLM):对每个 elicitation 请求返回 `decline` 并
 * 记一条带上下文的 warn。绝不 accept(没有人授权任何答案)、绝不抛
 * (toolset 层已把 handler 崩溃折成 cancel,这里连那条路都不走)。
 */
export function declineElicitations(
  log: McpElicitationLogger,
  agentId?: string,
): McpElicitationHandler {
  return async (req) => {
    log.warn('mcp elicitation auto-declined (no interactive answerer on the agent path)', {
      ...(agentId ? { agentId } : {}),
      serverName: req.serverName,
      message: req.message,
      fields: Object.keys(req.requestedSchema?.properties ?? {}),
    })
    return { action: 'decline' }
  }
}
