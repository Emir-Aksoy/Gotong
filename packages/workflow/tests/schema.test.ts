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

/**
 * `surface.me` (Phase 14) — declares a workflow as runnable from the
 * member-facing `/me` workbench. The runner ignores it; the web layer
 * derives its allowlist from it, so a bad block must fail loudly at import.
 */
describe('surface.me', () => {
  const SKELETON = (surface: string) => `
schema: aipehub.workflow/v1
workflow:
  id: member-flow
  name: 成员流程
  trigger:
    capability: run-member-flow
${surface}
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: $trigger.payload
`

  it('parses a full surface.me block', () => {
    const wf = parseWorkflow(
      SKELETON(`  surface:
    me:
      enabled: true
      label: 我的流程
      description: 给成员用的
      allowed_roles: [owner, admin, member]
      user_scope_field: owner_user_id
      input_schema:
        - { id: topic, label: 主题, type: text, required: true }`),
    )
    expect(wf.surface?.me).toBeDefined()
    const me = wf.surface!.me!
    expect(me.enabled).toBe(true)
    expect(me.label).toBe('我的流程')
    expect(me.description).toBe('给成员用的')
    expect(me.allowedRoles).toEqual(['owner', 'admin', 'member'])
    expect(me.userScopeField).toBe('owner_user_id')
    expect(me.inputSchema).toEqual([
      { id: 'topic', label: '主题', type: 'text', required: true },
    ])
  })

  it('leaves surface undefined when the block is absent (no regression)', () => {
    const wf = parseWorkflow(SKELETON(''))
    expect(wf.surface).toBeUndefined()
  })

  it('parses a minimal block (enabled only) with disabled allowed', () => {
    const on = parseWorkflow(SKELETON(`  surface:
    me:
      enabled: true`))
    expect(on.surface?.me?.enabled).toBe(true)
    expect(on.surface?.me?.allowedRoles).toBeUndefined()
    const off = parseWorkflow(SKELETON(`  surface:
    me:
      enabled: false`))
    expect(off.surface?.me?.enabled).toBe(false)
  })

  it('accepts camelCase keys too (json convention)', () => {
    const json = JSON.stringify({
      schema: WORKFLOW_SCHEMA_V1,
      workflow: {
        id: 'member-flow',
        trigger: { capability: 'run-member-flow' },
        surface: {
          me: {
            enabled: true,
            allowedRoles: ['member'],
            userScopeField: 'case_id',
            inputSchema: [{ id: 'note', label: 'Note', type: 'textarea' }],
          },
        },
        steps: [
          { id: 's', dispatch: { strategy: { kind: 'capability', capabilities: ['a'] }, payload: 1 } },
        ],
      },
    })
    const wf = parseWorkflow(json)
    expect(wf.surface?.me?.allowedRoles).toEqual(['member'])
    expect(wf.surface?.me?.userScopeField).toBe('case_id')
    expect(wf.surface?.me?.inputSchema).toHaveLength(1)
  })

  it('dedupes allowed_roles', () => {
    const wf = parseWorkflow(SKELETON(`  surface:
    me:
      enabled: true
      allowed_roles: [member, member, owner]`))
    expect(wf.surface?.me?.allowedRoles).toEqual(['member', 'owner'])
  })

  it('requires me.enabled', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  surface:
    me:
      label: 没开关`)),
    ).toThrow(/me\.enabled is required/)
  })

  it('rejects an unknown role', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  surface:
    me:
      enabled: true
      allowed_roles: [member, superuser]`)),
    ).toThrow(/allowed_roles entries must be one of/)
  })

  it('reuses payload-field validation for input_schema', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  surface:
    me:
      enabled: true
      input_schema:
        - { id: f, label: 文件, type: blob }`)),
    ).toThrow(/'text' \| 'textarea' \| 'number' \| 'select' \| 'file'/)
  })

  it('rejects a dangerous user_scope_field key', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  surface:
    me:
      enabled: true
      user_scope_field: __proto__`)),
    ).toThrow(/user_scope_field must match/)
  })

  it('rejects a non-object surface block', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  surface: not-an-object`)),
    ).toThrow(/workflow\.surface must be an object/)
  })
})

/**
 * `governance` (Phase 19 P5) — declarative risk metadata. The runner ignores
 * it; the web layer renders a risk summary before import/publish, so a bad
 * block must fail loudly at import rather than ship malformed metadata.
 */
describe('governance', () => {
  const SKELETON = (governance: string) => `
schema: aipehub.workflow/v1
workflow:
  id: gov-flow
  trigger:
    capability: run-gov-flow
${governance}
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: $trigger.payload
`

  it('parses a full governance block', () => {
    const wf = parseWorkflow(
      SKELETON(`  governance:
    data_sensitivity: pii
    required_credentials: [anthropic, crm-api]
    expected_cost_usd: 0.12
    required_human_roles: [legal counsel, senior consultant]
    external_systems: [chroma-mcp, windmill]
    notes: 处理客户合同, 含个人数据`),
    )
    expect(wf.governance).toBeDefined()
    const g = wf.governance!
    expect(g.dataSensitivity).toBe('pii')
    expect(g.requiredCredentials).toEqual(['anthropic', 'crm-api'])
    expect(g.expectedCostUsd).toBe(0.12)
    expect(g.requiredHumanRoles).toEqual(['legal counsel', 'senior consultant'])
    expect(g.externalSystems).toEqual(['chroma-mcp', 'windmill'])
    expect(g.notes).toBe('处理客户合同, 含个人数据')
  })

  it('leaves governance undefined when absent (no regression)', () => {
    const wf = parseWorkflow(SKELETON(''))
    expect(wf.governance).toBeUndefined()
  })

  it('parses a partial block (any subset of fields)', () => {
    const wf = parseWorkflow(SKELETON(`  governance:
    data_sensitivity: internal`))
    expect(wf.governance?.dataSensitivity).toBe('internal')
    expect(wf.governance?.requiredCredentials).toBeUndefined()
  })

  it('accepts camelCase keys too (json convention)', () => {
    const json = JSON.stringify({
      schema: WORKFLOW_SCHEMA_V1,
      workflow: {
        id: 'gov-flow',
        trigger: { capability: 'run-gov-flow' },
        governance: {
          dataSensitivity: 'confidential',
          requiredCredentials: ['openai'],
          expectedCostUsd: 1,
          externalSystems: ['peer:legal-org'],
        },
        steps: [
          { id: 's', dispatch: { strategy: { kind: 'capability', capabilities: ['a'] }, payload: 1 } },
        ],
      },
    })
    const wf = parseWorkflow(json)
    expect(wf.governance?.dataSensitivity).toBe('confidential')
    expect(wf.governance?.requiredCredentials).toEqual(['openai'])
    expect(wf.governance?.externalSystems).toEqual(['peer:legal-org'])
  })

  it('dedupes string-list fields', () => {
    const wf = parseWorkflow(SKELETON(`  governance:
    required_credentials: [anthropic, anthropic, openai]`))
    expect(wf.governance?.requiredCredentials).toEqual(['anthropic', 'openai'])
  })

  it('rejects an unknown data_sensitivity', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  governance:
    data_sensitivity: top-secret`)),
    ).toThrow(/data_sensitivity must be one of/)
  })

  it('rejects a negative expected_cost_usd', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  governance:
    expected_cost_usd: -1`)),
    ).toThrow(/expected_cost_usd must be a finite number/)
  })

  it('rejects a non-string entry in a string list', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  governance:
    required_credentials: [anthropic, 42]`)),
    ).toThrow(/required_credentials entries must be non-empty strings/)
  })

  it('rejects an empty string list', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  governance:
    external_systems: []`)),
    ).toThrow(/external_systems must be a non-empty array/)
  })

  it('rejects a non-object governance block', () => {
    expect(() =>
      parseWorkflow(SKELETON(`  governance: not-an-object`)),
    ).toThrow(/workflow\.governance must be an object/)
  })
})
