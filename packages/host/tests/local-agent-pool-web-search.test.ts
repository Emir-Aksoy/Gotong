/**
 * WSE — pool 侧承重门:host 探测到的 web-search bonus specs 只挂**管家行**。
 *
 * 三条钉子:
 *   1. butler 行挂上(server 名进 `mcpServersForAgent` —— 用死命令 spec,
 *      connect 失败也要可见:装配事实与连接健康是两回事,零网络零真凭证);
 *   2. 非 butler 行绝不挂(普通 agent 不因 host 探测到 key 偷偷多工具);
 *   3. 同名让位:行自己配了同名 server ⇒ 恰好一份(用户配置赢,单元测已锁
 *      「赢的是哪份」,这里锁「不重复」)。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  AgentParticipant,
  type AgentRecord,
  type ManagedAgentSpec,
  type McpServerSpec,
  type Task,
} from '@gotong/core'

import { LocalAgentPool, type ButlerFactory } from '../src/local-agent-pool.js'

class FakeButler extends AgentParticipant {
  constructor(id: string, caps: readonly string[]) {
    super({ id, capabilities: caps })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { butler: true, saw: task.payload }
  }
}

const fakeFactory: ButlerFactory = (base) => new FakeButler(base.id, base.capabilities ?? [])

/** 死命令 stdio spec — spawn 必失败,但装配(serverNames)仍可见。 */
const deadSpec = (name: string, command = '/nonexistent-gotong-wse'): McpServerSpec => ({
  name,
  command,
  args: [],
})

function chatRow(id: string, extra: Partial<ManagedAgentSpec> = {}): AgentRecord {
  return {
    id,
    allowedCapabilities: ['chat'],
    createdAt: new Date().toISOString(),
    managed: { kind: 'llm', provider: 'mock', system: 'assistant', ...extra },
  }
}

describe('LocalAgentPool — WSE butler bonus MCP specs', () => {
  let root: string
  let space: Space
  let hub: Hub

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-wse-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('butler 行挂 bonus spec(connect 失败装配仍可见,spawn 不炸)', async () => {
    await space.upsertAgent(chatRow('assistant'))
    const pool = new LocalAgentPool({
      hub,
      space,
      butlerFactory: fakeFactory,
      butlerDefaultOn: true,
      butlerBonusMcpSpecs: [deadSpec('testsrv')],
    })
    await pool.start()
    expect(pool.mcpServersForAgent('assistant')).toContain('testsrv')
    await pool.stop()
  })

  it('非 butler 行绝不挂(butler 关掉 ⇒ 同一 bonus 零注入)', async () => {
    await space.upsertAgent(chatRow('assistant'))
    const pool = new LocalAgentPool({
      hub,
      space,
      butlerFactory: fakeFactory,
      butlerDefaultOn: false, // 行没 opt-in ⇒ 普通 LlmAgent
      butlerBonusMcpSpecs: [deadSpec('testsrv')],
    })
    await pool.start()
    expect(pool.mcpServersForAgent('assistant')).not.toContain('testsrv')
    await pool.stop()
  })

  it('同名让位:行自己配了同名 server ⇒ 恰好一份', async () => {
    await space.upsertAgent(
      chatRow('assistant', { mcpServers: [deadSpec('testsrv', '/user-own-cmd')] }),
    )
    const pool = new LocalAgentPool({
      hub,
      space,
      butlerFactory: fakeFactory,
      butlerDefaultOn: true,
      butlerBonusMcpSpecs: [deadSpec('testsrv'), deadSpec('other')],
    })
    await pool.start()
    const names = pool.mcpServersForAgent('assistant')
    expect(names.filter((n) => n === 'testsrv')).toHaveLength(1)
    expect(names).toContain('other')
    await pool.stop()
  })
})
