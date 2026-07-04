import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatLoadReport, loadWorkflows } from '../src/workflow-loader.js'

describe('workflow-loader', () => {
  let tmp: string
  let dir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'host-wf-loader-'))
    dir = join(tmp, 'definitions')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("silently no-ops when the directory doesn't exist", async () => {
    const report = await loadWorkflows({ dir: join(tmp, 'does-not-exist') })
    expect(report.loaded).toEqual([])
    expect(report.failed).toEqual([])
    expect(formatLoadReport(report)).toBe('')
  })

  it('parses a single valid workflow file (no registration — versioning does that)', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'editorial.yaml'),
      `
schema: gotong.workflow/v1
workflow:
  id: ed
  trigger: { capability: run-editorial }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: $trigger.payload
`,
    )
    const report = await loadWorkflows({ dir })
    expect(report.loaded).toHaveLength(1)
    expect(report.failed).toEqual([])
    expect(report.loaded[0]!.participantId).toBe('workflow:ed')
    expect(report.loaded[0]!.definition.id).toBe('ed')
  })

  it('skips dotfiles and non-yaml/json files', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.hidden.yaml'), 'irrelevant')
    writeFileSync(join(dir, 'readme.txt'), 'docs only')
    const report = await loadWorkflows({ dir })
    expect(report.loaded).toHaveLength(0)
    expect(report.failed).toHaveLength(0)
  })

  it('records parse failures without crashing the host boot', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.yaml'), `this is not\n  : valid: workflow yaml`)
    writeFileSync(
      join(dir, 'good.yaml'),
      `
schema: gotong.workflow/v1
workflow:
  id: ok
  trigger: { capability: go }
  steps:
    - id: s1
      dispatch:
        strategy: { kind: capability, capabilities: [x] }
        payload: hi
`,
    )
    const report = await loadWorkflows({ dir })
    expect(report.loaded).toHaveLength(1)
    expect(report.loaded[0]!.definition.id).toBe('ok')
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]!.error).toMatch(/parse failed/)
  })

  it('rejects a duplicate workflow id (second file fails dedup)', async () => {
    mkdirSync(dir, { recursive: true })
    const sameId = `
schema: gotong.workflow/v1
workflow:
  id: dup
  trigger: { capability: trig }
  steps:
    - id: s1
      dispatch:
        strategy: { kind: capability, capabilities: [x] }
        payload: hi
`
    writeFileSync(join(dir, 'a-first.yaml'), sameId)
    writeFileSync(join(dir, 'b-second.yaml'), sameId)
    const report = await loadWorkflows({ dir })
    expect(report.loaded).toHaveLength(1) // alphabetical sort -> 'a-first' wins
    expect(report.loaded[0]!.file).toMatch(/a-first\.yaml$/)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]!.error).toMatch(/duplicate workflow id/)
  })

  it('formatLoadReport produces a readable summary line', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'one.yaml'),
      `
schema: gotong.workflow/v1
workflow:
  id: one
  trigger: { capability: c1 }
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [x] }
        payload: 1
    - id: b
      dispatch:
        strategy: { kind: capability, capabilities: [y] }
        payload: 2
`,
    )
    writeFileSync(join(dir, 'broken.yaml'), '{ this is not parseable workflow }')
    const report = await loadWorkflows({ dir })
    const out = formatLoadReport(report)
    expect(out).toMatch(/loaded 1/)
    expect(out).toMatch(/workflow:one/)
    expect(out).toMatch(/2 steps/)
    expect(out).toMatch(/1 file\(s\) failed/)
    expect(out).toMatch(/broken\.yaml/)
  })
})
