/**
 * KIT-M2 — migrate 的落地验收(计划原文):fixture space 埋满残留 →
 * `gotong migrate apply` → 用 host 的真件确认「host 装得下」:
 *
 *   - 零 definition 错:每个 definitions/*.yaml 过今天的 parseWorkflow;
 *   - revisions / lifecycle 用真 store 读回,contentHash 与重算一致
 *     (publish 去重 / rollback 断言依赖的就是这份一致性);
 *   - services ready 非空:bootstrapServices 真 import 迁移后的
 *     @gotong/* 插件包,零 errors;
 *   - transcript 字节不变(审计日志不可变,哪怕正文里出现旧串)。
 *
 * migrate 本体经 @gotong/cli 的 runCli 走——与用户敲的命令同一条路。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from '@gotong/cli'
import { Space } from '@gotong/core'
import { FileLifecycleStore, FileRevisionStore, hashDefinition, parseWorkflow } from '@gotong/workflow'

import { bootstrapServices } from '../src/services/bootstrap.js'

const OLD_DEF = {
  id: 'demo',
  trigger: { capability: 'run-demo' },
  steps: [
    {
      id: 'ask',
      dispatch: {
        strategy: { kind: 'capability', capabilities: ['aipehub.human/v1'] },
        payload: '$trigger.payload',
      },
    },
  ],
}

const OLD_YAML = `schema: aipehub.workflow/v1
workflow:
  id: demo
  trigger:
    capability: run-demo
  steps:
    - id: ask
      dispatch:
        strategy: { kind: capability, capabilities: [aipehub.human/v1] }
        payload: $trigger.payload
`

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotong-migrate-e2e-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('KIT-M2 — migrate 后 host 真件全环', () => {
  it('vintage space → apply → parseWorkflow 零错 + store 读回 hash 一致 + services ready 非空', async () => {
    // ① 真 Space.init 打底(space.json / 目录骨架都是真的),再叠 vintage 残留。
    const { space } = await Space.init(root, { name: 'migrate-e2e' })

    mkdirSync(join(root, 'services'), { recursive: true })
    mkdirSync(join(root, 'workflows', 'definitions'), { recursive: true })
    mkdirSync(join(root, 'workflows', 'revisions', 'demo'), { recursive: true })
    mkdirSync(join(root, 'workflows', 'lifecycle'), { recursive: true })

    writeFileSync(
      join(root, 'services', 'plugins.json'),
      JSON.stringify(
        {
          plugins: [
            '@aipehub/service-memory-file',
            '@aipehub/service-artifact-file',
            { package: '@aipehub/service-datastore-sqlite', enabled: true },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )
    writeFileSync(join(root, 'workflows', 'definitions', 'demo.yaml'), OLD_YAML, 'utf8')
    const oldHash = hashDefinition(OLD_DEF as never)
    writeFileSync(
      join(root, 'workflows', 'revisions', 'demo', '1.json'),
      `${JSON.stringify({ revision: 1, contentHash: oldHash, createdAt: 1751700000000, origin: 'publish', definition: OLD_DEF }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(
      join(root, 'workflows', 'lifecycle', 'demo.json'),
      `${JSON.stringify(
        {
          workflowId: 'demo',
          state: 'published',
          currentRevision: 1,
          headRevision: 1,
          triggerCapability: 'run-demo',
          revisions: [{ revision: 1, contentHash: oldHash, createdAt: 1751700000000, origin: 'publish' }],
          history: [],
          updatedAt: 1751700000000,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const transcriptPath = join(root, 'transcript.jsonl')
    writeFileSync(transcriptPath, '{"seq":1,"note":"aipehub.workflow/v1 in history"}\n', 'utf8')
    const transcriptBefore = readFileSync(transcriptPath, 'utf8')

    // 迁移前的现实:老 schema 过不了今天的解析器——这就是要修的病。
    expect(() => parseWorkflow(OLD_YAML)).toThrow(/unexpected 'schema' value/)

    // ② 与用户同一条路:runCli。
    const code = await runCli(['migrate', 'apply', root, '--brand'])
    expect(code).toBe(0)

    // ③ 零 definition 错:definitions 目录逐个过 parseWorkflow。
    const defDir = join(root, 'workflows', 'definitions')
    const defFiles = (await readdir(defDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'))
    expect(defFiles.length).toBeGreaterThan(0)
    for (const f of defFiles) {
      const def = parseWorkflow(readFileSync(join(defDir, f), 'utf8'))
      expect(def.id).toBe('demo')
    }

    // ④ 真 store 读回:revision 与 lifecycle 的 contentHash 与重算一致。
    const revision = await new FileRevisionStore(root).read('demo', 1)
    expect(revision).not.toBeNull()
    expect(JSON.stringify(revision!.definition)).toContain('gotong.human/v1')
    expect(revision!.contentHash).toBe(hashDefinition(revision!.definition))
    const record = await new FileLifecycleStore(root).read('demo')
    expect(record).not.toBeNull()
    expect(record!.revisions[0]!.contentHash).toBe(revision!.contentHash)

    // ⑤ services ready 非空:真 import 迁移后的 @gotong/* 插件,零 errors。
    const boot = await bootstrapServices({ space, seedDefaults: false })
    expect(boot.errors).toEqual([])
    expect(boot.ready.length).toBeGreaterThan(0)
    const types = boot.ready.map((p) => p.type).sort()
    expect(types).toContain('memory')

    // ⑥ transcript 字节不变。
    expect(readFileSync(transcriptPath, 'utf8')).toBe(transcriptBefore)
  })
})
