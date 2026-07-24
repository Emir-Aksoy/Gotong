/**
 * KIT-M2 — `gotong migrate scan/apply` 机制面验收:
 *
 *   - fixture 埋满四类残留 → scan 全数报告(env 忠告只打命令,永不读文件);
 *   - apply 白名单替换:plugins / definitions / revisions(contentHash 重算)
 *     / lifecycle 同步;brand 无 --brand 跳过、有才动;
 *   - transcript / secrets / runtime/secret.key **字节不变**断言;
 *   - `.premigrate` = 原件副本,重跑不被中间态覆盖(idempotent);
 *   - 改前先验:坏 JSON 的 revision 一字不碰 + exit 1;
 *   - isForbiddenTarget 第二道保险单测。
 *
 * host 侧「migrate 后真启动零 definition 错 + services ready 非空」的
 * 验收在 packages/host/tests/migrate-e2e.test.ts(需要真 plugin 包)。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashDefinition } from '@gotong/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isForbiddenTarget,
  migrateRevisionText,
  replaceFormatIds,
  syncLifecycleHashes,
} from '../src/commands/migrate-core.js'
import { migrate } from '../src/commands/migrate.js'

let root: string
let space: string

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

function makeVintageSpace(dir: string): void {
  mkdirSync(join(dir, 'runtime'), { recursive: true })
  mkdirSync(join(dir, 'services'), { recursive: true })
  mkdirSync(join(dir, 'workflows', 'definitions'), { recursive: true })
  mkdirSync(join(dir, 'workflows', 'revisions', 'demo'), { recursive: true })
  mkdirSync(join(dir, 'workflows', 'lifecycle'), { recursive: true })

  writeFileSync(join(dir, 'space.json'), JSON.stringify({ name: 'AipeHub 之家', mode: 'personal' }, null, 2), 'utf8')
  writeFileSync(
    join(dir, 'agents.json'),
    JSON.stringify({ agents: [{ id: 'helper', persona: 'You are the AipeHub helper.' }] }, null, 2),
    'utf8',
  )
  // 永不许动的三件(字节级断言用):
  writeFileSync(join(dir, 'transcript.jsonl'), '{"seq":1,"note":"aipehub.workflow/v1 mentioned in history"}\n', 'utf8')
  writeFileSync(join(dir, 'secrets.enc.json'), '{"v":3,"blob":"@aipehub/opaque"}', 'utf8')
  writeFileSync(join(dir, 'runtime', 'secret.key'), 'raw-key-bytes', 'utf8')

  writeFileSync(
    join(dir, 'services', 'plugins.json'),
    JSON.stringify(
      { plugins: ['@aipehub/service-memory-file', { package: '@aipehub/service-datastore-sqlite', enabled: true }] },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(dir, 'workflows', 'definitions', 'demo.yaml'), OLD_YAML, 'utf8')

  const oldHash = hashDefinition(OLD_DEF as never)
  writeFileSync(
    join(dir, 'workflows', 'revisions', 'demo', '1.json'),
    `${JSON.stringify({ revision: 1, contentHash: oldHash, createdAt: 1751700000000, origin: 'publish', definition: OLD_DEF }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'workflows', 'lifecycle', 'demo.json'),
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
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await migrate(args, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-kit-m2-'))
  space = join(root, 'space')
  makeVintageSpace(space)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('KIT-M2 migrate scan', () => {
  it('四类全数报告 + env 忠告只打 sed 命令;exit 1', async () => {
    const r = await run(['scan', space])
    expect(r.code).toBe(1)
    expect(r.out).toContain('services/plugins.json')
    expect(r.out).toContain('workflows/definitions/demo.yaml')
    expect(r.out).toContain('workflows/revisions/demo/1.json')
    expect(r.out).toContain('space.json')
    expect(r.out).toContain('agents.json')
    expect(r.out).toContain('--brand')
    // env 忠告:一条给用户自己跑的 sed,连文件存在与否都不探测。
    expect(r.out).toContain("sed -i.bak -e 's/AIPEHUB_URL/GOTONG_URL/g' -e 's/AIPE_/GOTONG_/g'")
    expect(r.out).toContain('never read')
  })

  it('scan 是只读的:跑完全部文件字节不变', async () => {
    const before = new Map<string, string>()
    for (const rel of ['space.json', 'services/plugins.json', 'workflows/revisions/demo/1.json']) {
      before.set(rel, readFileSync(join(space, rel), 'utf8'))
    }
    await run(['scan', space])
    for (const [rel, bytes] of before) {
      expect(readFileSync(join(space, rel), 'utf8')).toBe(bytes)
    }
    expect(existsSync(join(space, 'space.json.premigrate'))).toBe(false)
  })

  it('干净 space → exit 0', async () => {
    const clean = join(root, 'clean')
    mkdirSync(clean, { recursive: true })
    writeFileSync(join(clean, 'space.json'), '{"name":"Gotong home"}', 'utf8')
    const r = await run(['scan', clean])
    expect(r.code).toBe(0)
    expect(r.out).toContain('no legacy identifiers')
  })

  it('不是 workspace → exit 2', async () => {
    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })
    expect((await run(['scan', bare])).code).toBe(2)
    expect((await run(['bogus', space])).code).toBe(2)
  })
})

describe('KIT-M2 migrate apply', () => {
  it('白名单替换全套 + hash 重算 + lifecycle 同步;brand 默认跳过;禁区字节不变', async () => {
    const transcriptBefore = readFileSync(join(space, 'transcript.jsonl'), 'utf8')
    const secretsBefore = readFileSync(join(space, 'secrets.enc.json'), 'utf8')
    const keyBefore = readFileSync(join(space, 'runtime', 'secret.key'), 'utf8')

    const r = await run(['apply', space])
    expect(r.code).toBe(0)
    expect(r.out).toContain('contentHash re-derived')
    expect(r.out).toContain('contentHash synced for rev 1')
    expect(r.out).toContain('parseWorkflow ok')
    expect(r.out).toContain('skipped space.json')

    // ① plugins:字符串与 {package} 两种条目都换。
    const plugins = JSON.parse(readFileSync(join(space, 'services', 'plugins.json'), 'utf8')) as {
      plugins: Array<string | { package: string }>
    }
    expect(plugins.plugins[0]).toBe('@gotong/service-memory-file')
    expect((plugins.plugins[1] as { package: string }).package).toBe('@gotong/service-datastore-sqlite')

    // ② definitions:schema 行 + human 步 capability 都换,YAML 原样结构。
    const yaml = readFileSync(join(space, 'workflows', 'definitions', 'demo.yaml'), 'utf8')
    expect(yaml).toContain('schema: gotong.workflow/v1')
    expect(yaml).toContain('gotong.human/v1')
    expect(yaml).not.toContain('aipehub')

    // ③ revisions:definition 里换干净 + contentHash 重算到位。
    const rev = JSON.parse(readFileSync(join(space, 'workflows', 'revisions', 'demo', '1.json'), 'utf8')) as {
      contentHash: string
      definition: unknown
    }
    expect(JSON.stringify(rev.definition)).toContain('gotong.human/v1')
    expect(JSON.stringify(rev.definition)).not.toContain('aipehub')
    expect(rev.contentHash).toBe(hashDefinition(rev.definition as never))

    //    lifecycle 里那份 meta 副本同步到同一个 hash;审计字段不动。
    const rec = JSON.parse(readFileSync(join(space, 'workflows', 'lifecycle', 'demo.json'), 'utf8')) as {
      revisions: Array<{ revision: number; contentHash: string }>
      history: unknown[]
    }
    expect(rec.revisions[0]!.contentHash).toBe(rev.contentHash)
    expect(rec.history).toEqual([])

    // ④ brand:没给 --brand,一字不动。
    expect(readFileSync(join(space, 'space.json'), 'utf8')).toContain('AipeHub')

    // 禁区三件字节不变(transcript 里即使出现旧串也绝不改——审计日志不可变)。
    expect(readFileSync(join(space, 'transcript.jsonl'), 'utf8')).toBe(transcriptBefore)
    expect(readFileSync(join(space, 'secrets.enc.json'), 'utf8')).toBe(secretsBefore)
    expect(readFileSync(join(space, 'runtime', 'secret.key'), 'utf8')).toBe(keyBefore)

    // premigrate 副本 = 原件。
    expect(readFileSync(join(space, 'workflows', 'definitions', 'demo.yaml.premigrate'), 'utf8')).toBe(OLD_YAML)
    expect(existsSync(join(space, 'services', 'plugins.json.premigrate'))).toBe(true)
    expect(existsSync(join(space, 'workflows', 'lifecycle', 'demo.json.premigrate'))).toBe(true)

    // 再 scan:只剩 brand 一类。
    const rescan = await run(['scan', space])
    expect(rescan.code).toBe(1)
    expect(rescan.out).toContain('space.json')
    expect(rescan.out).not.toContain('plugins.json  ')
    expect(rescan.out).not.toContain('demo.yaml  ')
  })

  it('--brand 才动品牌串;之后 scan 全绿', async () => {
    const r = await run(['apply', space, '--brand'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(space, 'space.json'), 'utf8')).toContain('Gotong 之家')
    expect(readFileSync(join(space, 'agents.json'), 'utf8')).toContain('the Gotong helper')
    const rescan = await run(['scan', space])
    expect(rescan.code).toBe(0)
  })

  it('idempotent:第二次 apply 无事可做,premigrate 仍是最初原件', async () => {
    await run(['apply', space, '--brand'])
    const backupAfterFirst = readFileSync(join(space, 'workflows', 'definitions', 'demo.yaml.premigrate'), 'utf8')
    const second = await run(['apply', space, '--brand'])
    expect(second.code).toBe(0)
    expect(second.out).toContain('nothing to migrate')
    expect(readFileSync(join(space, 'workflows', 'definitions', 'demo.yaml.premigrate'), 'utf8')).toBe(backupAfterFirst)
    expect(backupAfterFirst).toBe(OLD_YAML)
  })

  it('改前先验:坏 JSON 的 revision 一字不碰,exit 1,premigrate 不产生', async () => {
    const bad = join(space, 'workflows', 'revisions', 'demo', '2.json')
    writeFileSync(bad, '{ "revision": 2, "contentHash": "x", "definition": { "schema": "aipehub.workflow/v1" ', 'utf8')
    const before = readFileSync(bad, 'utf8')
    const r = await run(['apply', space])
    expect(r.code).toBe(1)
    expect(r.err).toContain('2.json')
    expect(r.err).toContain('left untouched')
    expect(readFileSync(bad, 'utf8')).toBe(before)
    expect(existsSync(`${bad}.premigrate`)).toBe(false)
    // 同批其他文件照常迁移(逐文件独立)。
    expect(readFileSync(join(space, 'workflows', 'definitions', 'demo.yaml'), 'utf8')).toContain('gotong.workflow/v1')
  })

  it('定义之外残留格式 id 的 revision 整体拒绝(白名单外不硬猜)', () => {
    const r = migrateRevisionText(
      JSON.stringify({ revision: 3, contentHash: 'h', origin: 'aipehub.future/v9', definition: { id: 'x' } }),
    )
    expect(r.kind).toBe('error')
    expect((r as { message: string }).message).toContain('OUTSIDE')
  })
})

describe('KIT-M2 纯函数核', () => {
  it('格式 id 替换认全历史词表,不误伤近似词', () => {
    expect(replaceFormatIds('aipehub.workflow/v1 aipehub.human/v1 aipehub.future/v9')).toBe(
      'gotong.workflow/v1 gotong.human/v1 gotong.future/v9',
    )
    // 不带版本尾巴的不动(可能是包名/散文),大写品牌词也不归这条管。
    expect(replaceFormatIds('aipehub.workflow without version')).toBe('aipehub.workflow without version')
    expect(replaceFormatIds('AipeHub.workflow/v1')).toBe('AipeHub.workflow/v1')
  })

  it('isForbiddenTarget 拦住全部禁区名字', () => {
    for (const rel of [
      'transcript.jsonl',
      'secrets.enc.json',
      'identity.sqlite',
      'identity.sqlite-wal',
      'runtime/secret.key',
      'runtime/secret.key.pre-unify.bak', // B① 退役改名件
      'secrets.enc.json.pre-unify.bak', // B① 迁移前备份
      'secrets.enc.json.next', // B① 轮换暂存件
      'identity-master.key',
      'identity-master.key.next',
      'runtime/admin-sessions.json',
      'runtime/worker-sessions.json',
    ]) {
      expect(isForbiddenTarget(rel), rel).toBe(true)
    }
    for (const rel of ['space.json', 'services/plugins.json', 'workflows/definitions/a.yaml']) {
      expect(isForbiddenTarget(rel), rel).toBe(false)
    }
  })

  it('syncLifecycleHashes 只动命中的 revision,其余原样', () => {
    const raw = JSON.stringify({
      workflowId: 'w',
      revisions: [
        { revision: 1, contentHash: 'old1' },
        { revision: 2, contentHash: 'keep' },
      ],
      history: [{ at: 1, from: 'draft', to: 'published' }],
    })
    const s = syncLifecycleHashes(raw, new Map([[1, 'new1']]))
    expect(s.kind).toBe('changed')
    const rec = JSON.parse((s as { text: string }).text) as {
      revisions: Array<{ contentHash: string }>
      history: unknown[]
    }
    expect(rec.revisions[0]!.contentHash).toBe('new1')
    expect(rec.revisions[1]!.contentHash).toBe('keep')
    expect(rec.history).toHaveLength(1)
    expect(syncLifecycleHashes(raw, new Map([[9, 'x']])).kind).toBe('unchanged')
    expect(syncLifecycleHashes('not json', new Map()).kind).toBe('error')
  })
})
