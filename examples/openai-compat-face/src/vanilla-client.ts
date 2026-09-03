/**
 * 一个**普普通通的 OpenAI 客户端**。
 *
 * 这个文件是整个 demo 的主张所在：它只 import `openai`，只知道一个 base URL 和
 * 一把 key，此外**对它要说话的那一头一无所知**。没有 shim、没有 header 补丁、
 * 没有响应改写、没有任何一处分支写着"如果对面是某某就怎样"。
 *
 * `index.ts` 会读这个文件的源码，断言它的 import 清单恰好是 `['openai']`、
 * 且全文不出现产品名。那条断言能证明的是「没有任何专用模块或专用命名参与」；
 * 它**证不了**「没有一个长得很通用的 shim」——那一层留给读代码的人，所以
 * demo 会把下面那行构造原样打出来给你看。
 */

import OpenAI from 'openai'

/** 换一个 base URL 和一把 key —— 指向 Azure / Together / Ollama 时你也是这么写的。 */
export function connect(apiKey: string, baseURL: string): OpenAI {
  return new OpenAI({ apiKey, baseURL })
}

export async function listModels(client: OpenAI): Promise<string[]> {
  const page = await client.models.list()
  return page.data.map((m) => m.id)
}

export async function askOnce(client: OpenAI, model: string, prompt: string): Promise<string> {
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  })
  return r.choices[0]?.message?.content ?? ''
}

/** 非流式那次的完整响应 —— 用来看 `usage` 这类字段在不在。 */
export async function askRaw(
  client: OpenAI,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const r = await client.chat.completions.create({ model, messages, ...extra } as never)
  return r as unknown as Record<string, unknown>
}

export interface StreamedAnswer {
  readonly text: string
  readonly frames: number
  readonly roles: readonly string[]
  readonly finishes: readonly string[]
}

/** SDK 自己解析 SSE —— 这里没有一行手写的帧解析。 */
export async function askStreaming(client: OpenAI, model: string, prompt: string): Promise<StreamedAnswer> {
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  })
  let text = ''
  let frames = 0
  const roles: string[] = []
  const finishes: string[] = []
  for await (const chunk of stream) {
    frames += 1
    const choice = chunk.choices[0]
    if (choice?.delta?.role) roles.push(choice.delta.role)
    if (choice?.delta?.content) text += choice.delta.content
    if (choice?.finish_reason) finishes.push(choice.finish_reason)
  }
  return { text, frames, roles, finishes }
}
