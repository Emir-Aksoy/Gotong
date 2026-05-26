import { describe, expect, it } from 'vitest'

import {
  WORKFLOW_SCHEMA_V1,
  WorkflowSchemaError,
  parseWorkflow,
} from '../src/index.js'

/**
 * `parseWorkflow` is the single trust boundary between "untrusted YAML
 * from the internet / admin paste" and the runner. Every reject path
 * needs a clear, human-friendly error message so the admin UI can
 * surface it verbatim.
 */
describe('parseWorkflow', () => {
  it('parses a minimal sequential workflow', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  name: 编辑流水线
  trigger:
    capability: run-editorial
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: $trigger.payload
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [review] }
        payload: { draft: $draft.output }
  output: $review.output
`
    const wf = parseWorkflow(yaml)
    expect(wf.schema).toBe(WORKFLOW_SCHEMA_V1)
    expect(wf.id).toBe('editorial')
    expect(wf.name).toBe('编辑流水线')
    expect(wf.trigger.capability).toBe('run-editorial')
    expect(wf.steps).toHaveLength(2)
    expect(wf.steps[0]!.id).toBe('draft')
    expect(wf.steps[1]!.id).toBe('review')
    expect(wf.output).toBe('$review.output')
    expect(wf.onFailure).toBe('halt')
  })

  it('parses an equivalent JSON workflow', () => {
    const json = JSON.stringify({
      schema: 'aipehub.workflow/v1',
      workflow: {
        id: 'short',
        trigger: { capability: 'go' },
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['x'] },
              payload: 'hi',
            },
          },
        ],
      },
    })
    const wf = parseWorkflow(json)
    expect(wf.id).toBe('short')
    expect(wf.steps).toHaveLength(1)
  })

  it('parses a parallel step', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: fanout
  trigger:
    capability: fanout-trigger
  steps:
    - id: prepare
      dispatch:
        strategy: { kind: capability, capabilities: [prep] }
        payload: $trigger.payload
    - id: fanout
      parallel: true
      branches:
        - id: a
          dispatch:
            strategy: { kind: capability, capabilities: [a-job] }
            payload: $prepare.output
        - id: b
          dispatch:
            strategy: { kind: capability, capabilities: [b-job] }
            payload: $prepare.output
`
    const wf = parseWorkflow(yaml)
    const par = wf.steps[1]
    expect(par).toBeDefined()
    if (par && 'parallel' in par) {
      expect(par.parallel).toBe(true)
      expect(par.branches).toHaveLength(2)
      expect(par.branches[0]!.id).toBe('a')
      expect(par.branches[1]!.id).toBe('b')
    } else {
      throw new Error('expected parallel step')
    }
  })

  it('parses explicit and broadcast dispatch strategies', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: mixed
  trigger:
    capability: go
  steps:
    - id: e1
      dispatch:
        strategy: { kind: explicit, to: worker-1 }
        payload: hello
    - id: b1
      dispatch:
        strategy: { kind: broadcast, capabilities: [review] }
        payload: world
`
    const wf = parseWorkflow(yaml)
    const s1 = wf.steps[0]!
    const s2 = wf.steps[1]!
    if ('parallel' in s1) throw new Error('expected simple step')
    if ('parallel' in s2) throw new Error('expected simple step')
    expect(s1.dispatch.strategy).toEqual({ kind: 'explicit', to: 'worker-1' })
    expect(s2.dispatch.strategy).toEqual({
      kind: 'broadcast',
      capabilities: ['review'],
    })
  })

  it('parses step-level onFailure: retry', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: retrier
  trigger: { capability: go }
  steps:
    - id: s1
      dispatch:
        strategy: { kind: capability, capabilities: [x] }
        payload: hi
      onFailure: { action: retry, max: 2 }
`
    const wf = parseWorkflow(yaml)
    const s1 = wf.steps[0]!
    if ('parallel' in s1) throw new Error('expected simple step')
    expect(s1.onFailure).toEqual({ action: 'retry', max: 2 })
  })

  it('rejects empty input', () => {
    expect(() => parseWorkflow('')).toThrow(WorkflowSchemaError)
    expect(() => parseWorkflow('  \n  ')).toThrow(/empty/)
  })

  it('rejects wrong schema header', () => {
    const yaml = `
schema: aipehub.workflow/v0
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - { id: s, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: {} } }
`
    expect(() => parseWorkflow(yaml)).toThrow(/aipehub.workflow\/v1/)
  })

  it('rejects missing trigger', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  steps:
    - { id: s, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: {} } }
`
    expect(() => parseWorkflow(yaml)).toThrow(/trigger is required/)
  })

  it('rejects missing steps', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
`
    expect(() => parseWorkflow(yaml)).toThrow(/steps must be a non-empty array/)
  })

  it('rejects duplicate step ids', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - { id: same, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: 1 } }
    - { id: same, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: 2 } }
`
    expect(() => parseWorkflow(yaml)).toThrow(/duplicates an earlier step id/)
  })

  it('rejects duplicate branch ids inside a parallel step', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - id: par
      parallel: true
      branches:
        - { id: same, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: 1 } }
        - { id: same, dispatch: { strategy: { kind: capability, capabilities: [b] }, payload: 2 } }
`
    expect(() => parseWorkflow(yaml)).toThrow(/duplicates a sibling branch id/)
  })

  it('rejects parallel step without branches', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - id: par
      parallel: true
`
    expect(() => parseWorkflow(yaml)).toThrow(/branches must be a non-empty array/)
  })

  it('rejects bad ids', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: "x has spaces"
  trigger: { capability: go }
  steps:
    - { id: s, dispatch: { strategy: { kind: capability, capabilities: [a] }, payload: 1 } }
`
    expect(() => parseWorkflow(yaml)).toThrow(/may only contain/)
  })

  it('rejects unknown strategy.kind', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - id: s
      dispatch:
        strategy: { kind: vacuum, capabilities: [a] }
        payload: hi
`
    expect(() => parseWorkflow(yaml)).toThrow(/strategy.kind/)
  })

  it('rejects retry policy without positive max', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: x
  trigger: { capability: go }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: hi
      onFailure: { action: retry, max: 0 }
`
    expect(() => parseWorkflow(yaml)).toThrow(/positive integer/)
  })

  // --- payload_schema (UI dispatch form descriptors) -----------------
  // Phase 9 M4 adds the `file` type. The rest of this block tests the
  // 4 pre-existing types alongside the new one so a future reorder
  // doesn't silently drop a code path.

  it('parses payload_schema with the four legacy field types', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: form-demo
  trigger:
    capability: form
    payload_schema:
      - { id: name, label: 名字, type: text, required: true }
      - { id: bio, label: 自我介绍, type: textarea, rows: 8, hint: 简短一段 }
      - { id: age, label: 年龄, type: number, defaultValue: 30 }
      - id: tier
        label: 用户层级
        type: select
        options:
          - { value: free, label: 免费 }
          - { value: pro, label: 专业版 }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: $trigger.payload
`
    const wf = parseWorkflow(yaml)
    expect(wf.trigger.payloadSchema).toHaveLength(4)
    expect(wf.trigger.payloadSchema![0]).toMatchObject({
      id: 'name', label: '名字', type: 'text', required: true,
    })
    expect(wf.trigger.payloadSchema![1]).toMatchObject({
      id: 'bio', type: 'textarea', rows: 8, hint: '简短一段',
    })
    expect(wf.trigger.payloadSchema![2]).toMatchObject({
      id: 'age', type: 'number', defaultValue: 30,
    })
    expect(wf.trigger.payloadSchema![3]).toMatchObject({
      id: 'tier', type: 'select',
      options: [
        { value: 'free', label: '免费' },
        { value: 'pro', label: '专业版' },
      ],
    })
  })

  it('parses a file field with accept + maxSizeMb', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: upload-demo
  trigger:
    capability: describe-image
    payload_schema:
      - id: pic
        label: 上传图片
        type: file
        required: true
        accept: ['image/']
        maxSizeMb: 5
      - id: caption
        label: 可选说明
        type: text
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [vlm] }
        payload:
          image: $trigger.payload.pic
          caption: $trigger.payload.caption
`
    const wf = parseWorkflow(yaml)
    expect(wf.trigger.payloadSchema).toHaveLength(2)
    expect(wf.trigger.payloadSchema![0]).toEqual({
      id: 'pic',
      label: '上传图片',
      type: 'file',
      required: true,
      accept: ['image/'],
      maxSizeMb: 5,
    })
    expect(wf.trigger.payloadSchema![1]).toMatchObject({
      id: 'caption', type: 'text',
    })
  })

  it('parses a file field without accept/maxSizeMb (host defaults apply)', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: any-file
  trigger:
    capability: do-it
    payload_schema:
      - { id: doc, label: 文档, type: file }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: { f: $trigger.payload.doc }
`
    const wf = parseWorkflow(yaml)
    expect(wf.trigger.payloadSchema![0]).toEqual({
      id: 'doc', label: '文档', type: 'file',
    })
  })

  it('drops defaultValue / placeholder / rows on a file field (canonical shape)', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: ignore-noise
  trigger:
    capability: do-it
    payload_schema:
      - id: f
        label: 文件
        type: file
        defaultValue: ignored
        placeholder: ignored too
        rows: 5
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: $trigger.payload
`
    const wf = parseWorkflow(yaml)
    const spec = wf.trigger.payloadSchema![0]!
    expect(spec.type).toBe('file')
    expect(spec.defaultValue).toBeUndefined()
    expect(spec.placeholder).toBeUndefined()
    expect(spec.rows).toBeUndefined()
  })

  it('rejects file.accept as empty array', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad
  trigger:
    capability: do-it
    payload_schema:
      - { id: f, label: 文件, type: file, accept: [] }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/accept must be a non-empty array/)
  })

  it('rejects file.accept entry that is not a non-empty string', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad
  trigger:
    capability: do-it
    payload_schema:
      - { id: f, label: 文件, type: file, accept: ['', 'image/'] }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/non-empty strings/)
  })

  it('rejects file.maxSizeMb > 100', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad
  trigger:
    capability: do-it
    payload_schema:
      - { id: f, label: 文件, type: file, maxSizeMb: 200 }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/positive number ≤ 100/)
  })

  it('rejects file.maxSizeMb that is non-positive', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad
  trigger:
    capability: do-it
    payload_schema:
      - { id: f, label: 文件, type: file, maxSizeMb: 0 }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/positive number ≤ 100/)
  })

  it('rejects an unknown payload_schema type', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad
  trigger:
    capability: do-it
    payload_schema:
      - { id: f, label: 文件, type: blob }
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/'text' \| 'textarea' \| 'number' \| 'select' \| 'file'/)
  })
})
