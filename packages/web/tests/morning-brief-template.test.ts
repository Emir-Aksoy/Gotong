/**
 * Anti-rot acceptance gate for the morning-brief loadable template (LIFE-L2①).
 *
 * Reads the SHIPPED `examples/morning-brief-hub/template/…yaml` off disk and
 * runs it through the real parser + the real import route, so the gallery card
 * can never silently drift out of the template schema. Beyond the usual
 * structure pins, this one pins the SCHEDULE SEAM: the workflow lands with
 * `surface.me.enabled` + `user_scope_field: reader_id` — exactly the member
 * gate the workflow-schedule sweeper resolves through (a schedule row for
 * `morning-brief` is runnable the moment this template is installed and
 * published; the loop itself is pinned host-side in
 * host/tests/morning-brief-e2e.test.ts).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL(
    '../../../examples/morning-brief-hub/template/morning-brief-hub.template.yaml',
    import.meta.url,
  ),
)
// The single-install twin. The host e2e (morning-brief-e2e.test.ts) feeds THIS
// file through the real parseWorkflow + a full scheduled run; the deep-equality
// pin below makes that validity transfer to the template's inner block.
const STANDALONE_PATH = fileURLToPath(
  new URL('../../../templates/workflows/morning-brief-flow.yaml', import.meta.url),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/morning-brief-hub/template (LIFE-L2①)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('我的晨报(定时工作流)')
    expect(t.version).toBe(1)
    expect(t.agents.map((a) => a.id)).toEqual(['brief-writer'])
    expect(t.agents[0]!.capabilities).toContain('brief.compose')
    expect(t.workflows).toHaveLength(1)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: agent lands, ONE workflow yaml reaches the runtime with the member gate open', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-mbh-'))
    const { space } = await Space.init(tmp, { name: 'mbh-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    const wfCalls: string[] = []
    const workflows = {
      importFromText: async (yaml: string) => {
        wfCalls.push(yaml)
        return { id: 'morning-brief' }
      },
    } as unknown as WorkflowSurface

    let server: WebServerHandle | undefined
    try {
      server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows })
      const res = await fetch(`${server.url}/api/admin/templates/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ template: templateText }),
      })
      expect(res.status).toBe(200)
      const json: any = await res.json()
      expect(json.ok).toBe(true)
      expect((await space.agents()).map((a) => a.id)).toContain('brief-writer')

      // THE SCHEDULE SEAM: the re-serialized workflow yaml (what the runtime
      // registers) carries the same member gate the schedule sweeper resolves
      // through. This exact yaml shape is what the host e2e feeds createFromYaml.
      expect(wfCalls).toHaveLength(1)
      const wf = parseYaml(wfCalls[0]!) as {
        schema: string
        workflow: {
          id: string
          trigger: { capability: string }
          surface?: { me?: { enabled?: boolean; user_scope_field?: string } }
        }
      }
      expect(wf.schema).toBe('gotong.workflow/v1')
      expect(wf.workflow.id).toBe('morning-brief')
      expect(wf.workflow.trigger.capability).toBe('brief.request')
      expect(wf.workflow.surface?.me).toMatchObject({
        enabled: true,
        user_scope_field: 'reader_id',
      })
      // Same-shape pin: the template's inner block ≡ the standalone
      // templates/workflows/morning-brief-flow.yaml (the host e2e's fixture).
      // Edit one without the other and this fails — the host-side proof
      // (real parseWorkflow + full scheduled run) covers both only while
      // they stay identical.
      const standalone = parseYaml(await readFile(STANDALONE_PATH, 'utf8')) as {
        workflow: unknown
      }
      expect(wf.workflow).toEqual(standalone.workflow)
      // Structure-only import: no secrets, no personnel.
      expect(json.secretsApplied).toBe(0)
      expect(json.personnelOmitted).toBe(false)
    } finally {
      await server?.close()
      await hub.stop?.()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
