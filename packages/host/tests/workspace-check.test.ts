import { describe, expect, it } from 'vitest'

import {
  checkAgentsFile,
  checkHostConfig,
  checkWorkflowFiles,
  formatCheckReport,
  runCheckCli,
  validateWorkspace,
  type HostConfigCheckInput,
  type WorkspaceCheckReport,
} from '../src/workspace-check.js'
import type { LoadReport } from '../src/workflow-loader.js'

/** A safe loopback config with every field valid. */
function goodConfig(over: Partial<HostConfigCheckInput> = {}): HostConfigCheckInput {
  return {
    host: '127.0.0.1',
    cookieSecure: false,
    gating: 'admin-approval',
    defaultLang: 'zh',
    webPort: 3000,
    wsPort: 4000,
    allowedHosts: undefined,
    allowInsecure: false,
    masterKeyProvider: '',
    masterKeyPresent: false,
    ...over,
  }
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code)

describe('checkHostConfig — 主机配置体检', () => {
  it('a loopback default config produces zero findings', () => {
    expect(checkHostConfig(goodConfig())).toEqual([])
  })

  it('reuses auditBootSecurity: exposed host with no defenses → two config errors', () => {
    const out = checkHostConfig(goodConfig({ host: '0.0.0.0' }))
    expect(codes(out)).toEqual(
      expect.arrayContaining([
        'config.host_check_disabled_while_exposed',
        'config.cookie_insecure_while_exposed',
      ]),
    )
    // fatal severity → error level
    for (const f of out.filter((x) => x.code.startsWith('config.host_check') || x.code.startsWith('config.cookie'))) {
      expect(f.level).toBe('error')
    }
  })

  it('GOTONG_ALLOW_INSECURE downgrades exposure findings to warnings', () => {
    const out = checkHostConfig(
      goodConfig({ host: '0.0.0.0', allowInsecure: true, allowedHosts: undefined }),
    )
    const exposure = out.filter((f) => f.code.includes('exposed') && f.code !== 'config.open_gating_exposed')
    expect(exposure.length).toBeGreaterThan(0)
    for (const f of exposure) expect(f.level).toBe('warn')
  })

  it('flags a bad gating enum', () => {
    expect(codes(checkHostConfig(goodConfig({ gating: 'nonsense' })))).toContain('config.bad_gating')
  })

  it('flags a bad defaultLang enum', () => {
    expect(codes(checkHostConfig(goodConfig({ defaultLang: 'fr' })))).toContain('config.bad_lang')
  })

  it('flags out-of-range ports and a web/ws collision', () => {
    expect(codes(checkHostConfig(goodConfig({ webPort: 0 })))).toContain('config.bad_web_port')
    expect(codes(checkHostConfig(goodConfig({ wsPort: 70000 })))).toContain('config.bad_ws_port')
    expect(codes(checkHostConfig(goodConfig({ webPort: 5000, wsPort: 5000 })))).toContain('config.port_collision')
  })

  it('requires GOTONG_MASTER_KEY when provider=env', () => {
    expect(codes(checkHostConfig(goodConfig({ masterKeyProvider: 'env', masterKeyPresent: false })))).toContain(
      'config.master_key_missing',
    )
    expect(codes(checkHostConfig(goodConfig({ masterKeyProvider: 'env', masterKeyPresent: true })))).not.toContain(
      'config.master_key_missing',
    )
  })

  it('warns (not errors) on open gating while network-exposed', () => {
    const out = checkHostConfig(
      goodConfig({ host: '203.0.113.5', gating: 'open', allowedHosts: ['x'], cookieSecure: true }),
    )
    const adv = out.find((f) => f.code === 'config.open_gating_exposed')
    expect(adv?.level).toBe('warn')
  })

  it('does not warn about open gating on loopback', () => {
    expect(codes(checkHostConfig(goodConfig({ gating: 'open' })))).not.toContain('config.open_gating_exposed')
  })
})

describe('checkWorkflowFiles — reuse loadWorkflows', () => {
  const fakeLoad = (report: LoadReport) => async () => report

  it('a clean load yields no findings and an ok count', async () => {
    const res = await checkWorkflowFiles(
      '/x',
      fakeLoad({ dir: '/x', loaded: [{} as never, {} as never], failed: [] }),
    )
    expect(res).toMatchObject({ ok: 2, bad: 0 })
    expect(res.findings).toEqual([])
  })

  it('each failed file becomes an error finding carrying the file path', async () => {
    const res = await checkWorkflowFiles(
      '/x',
      fakeLoad({
        dir: '/x',
        loaded: [],
        failed: [{ file: '/x/bad.yaml', error: 'parse failed: boom' }],
      }),
    )
    expect(res.bad).toBe(1)
    expect(res.findings[0]).toMatchObject({
      domain: 'workflow',
      level: 'error',
      code: 'workflow.parse_failed',
      file: '/x/bad.yaml',
    })
  })
})

describe('checkAgentsFile — JSON + loadable shape', () => {
  const exists = () => true
  const reads = (body: string) => async () => body

  it('a missing agents.json is valid (no managed agents)', async () => {
    const res = await checkAgentsFile('/x/agents.json', reads(''), () => false)
    expect(res).toEqual({ findings: [], ok: 0, bad: 0 })
  })

  it('flags invalid JSON', async () => {
    const res = await checkAgentsFile('/x/agents.json', reads('{ not json'), exists)
    expect(codes(res.findings)).toEqual(['agent.invalid_json'])
  })

  it('flags the wrong top-level shape', async () => {
    const res = await checkAgentsFile('/x/agents.json', reads('[]'), exists)
    expect(codes(res.findings)).toEqual(['agent.bad_shape'])
  })

  it('accepts a valid managed-agent row and tolerates unknown fields', async () => {
    const body = JSON.stringify({
      agents: [
        {
          id: 'a1',
          allowedCapabilities: ['chat'],
          createdAt: 1,
          futureField: { whatever: true },
          managed: { kind: 'llm', provider: 'anthropic', system: 'hi', model: 'claude' },
        },
      ],
    })
    const res = await checkAgentsFile('/x/agents.json', reads(body), exists)
    expect(res).toMatchObject({ ok: 1, bad: 0 })
    expect(res.findings).toEqual([])
  })

  it('flags missing id and duplicate id', async () => {
    const body = JSON.stringify({ agents: [{}, { id: 'dup' }, { id: 'dup' }] })
    const res = await checkAgentsFile('/x/agents.json', reads(body), exists)
    expect(codes(res.findings)).toEqual(expect.arrayContaining(['agent.missing_id', 'agent.duplicate_id']))
    expect(res.bad).toBe(2)
    expect(res.ok).toBe(1)
  })

  it('flags a bad provider/kind and an openai-compatible row without baseURL', async () => {
    const body = JSON.stringify({
      agents: [
        { id: 'a', managed: { kind: 'wat', provider: 'nope' } },
        { id: 'b', managed: { provider: 'openai-compatible', system: 'x' } },
      ],
    })
    const res = await checkAgentsFile('/x/agents.json', reads(body), exists)
    expect(codes(res.findings)).toEqual(
      expect.arrayContaining(['agent.bad_kind', 'agent.bad_provider', 'agent.missing_base_url']),
    )
    expect(res.bad).toBe(2)
  })

  it('accepts openai-compatible WITH baseURL', async () => {
    const body = JSON.stringify({
      agents: [{ id: 'a', managed: { provider: 'openai-compatible', system: 'x', baseURL: 'https://api.deepseek.com' } }],
    })
    const res = await checkAgentsFile('/x/agents.json', reads(body), exists)
    expect(res).toMatchObject({ ok: 1, bad: 0 })
  })
})

describe('validateWorkspace — aggregate', () => {
  const cleanLoad: () => Promise<LoadReport> = async () => ({ dir: '/x', loaded: [], failed: [] })

  it('rolls config + workflow + agent findings into one report (live config path)', async () => {
    const report = await validateWorkspace({
      spaceDir: '/space',
      env: {},
      config: { host: '0.0.0.0', cookieSecure: false, gating: 'admin-approval', defaultLang: 'zh', webPort: 3000, wsPort: 4000 },
      loadWorkflowsImpl: async () => ({ dir: '/x', loaded: [], failed: [{ file: '/x/b.yaml', error: 'bad' }] }),
      existsImpl: () => false, // no agents.json
      readFileImpl: async () => '',
    })
    // exposed host → ≥1 config error; one workflow error
    expect(report.errors).toBeGreaterThanOrEqual(2)
    expect(report.workflows).toEqual({ ok: 0, bad: 1 })
    expect(report.findings.some((f) => f.domain === 'config')).toBe(true)
    expect(report.findings.some((f) => f.domain === 'workflow')).toBe(true)
  })

  it('standalone path reads config.json and flags it when malformed', async () => {
    const report = await validateWorkspace({
      spaceDir: '/space',
      env: {},
      loadWorkflowsImpl: cleanLoad,
      existsImpl: (p) => p.endsWith('config.json'),
      readFileImpl: async () => '{ broken',
    })
    expect(codes(report.findings)).toContain('config.bad_config_json')
  })

  it('a fully clean workspace yields zero errors and zero warnings', async () => {
    const report = await validateWorkspace({
      spaceDir: '/space',
      env: {},
      config: { host: '127.0.0.1', cookieSecure: false, gating: 'admin-approval', defaultLang: 'zh', webPort: 3000, wsPort: 4000 },
      loadWorkflowsImpl: cleanLoad,
      existsImpl: () => false,
      readFileImpl: async () => '',
    })
    expect(report.errors).toBe(0)
    expect(report.warnings).toBe(0)
    expect(report.findings).toEqual([])
  })
})

describe('formatCheckReport', () => {
  const empty: WorkspaceCheckReport = { findings: [], errors: 0, warnings: 0, workflows: { ok: 3, bad: 0 }, agents: { ok: 2, bad: 0 } }

  it('reports a pass when there are no findings', () => {
    const txt = formatCheckReport(empty)
    expect(txt).toContain('workspace check passed')
    expect(txt).toContain('3 workflow file(s)')
  })

  it('ends with an error verdict when there are errors', () => {
    const r: WorkspaceCheckReport = {
      findings: [{ domain: 'config', level: 'error', code: 'config.bad_gating', message: 'bad' }],
      errors: 1,
      warnings: 0,
      workflows: { ok: 0, bad: 0 },
      agents: { ok: 0, bad: 0 },
    }
    expect(formatCheckReport(r)).toContain('1 error(s)')
  })

  it('ends with a safe-with-warnings verdict when only warnings', () => {
    const r: WorkspaceCheckReport = {
      findings: [{ domain: 'config', level: 'warn', code: 'config.open_gating_exposed', message: 'w' }],
      errors: 0,
      warnings: 1,
      workflows: { ok: 0, bad: 0 },
      agents: { ok: 0, bad: 0 },
    }
    expect(formatCheckReport(r)).toContain('0 errors')
  })

  it('compact mode omits the per-finding fix lines', () => {
    const r: WorkspaceCheckReport = {
      findings: [{ domain: 'config', level: 'error', code: 'config.bad_gating', message: 'bad', fix: 'do x' }],
      errors: 1,
      warnings: 0,
      workflows: { ok: 0, bad: 0 },
      agents: { ok: 0, bad: 0 },
    }
    expect(formatCheckReport(r, { compact: true })).not.toContain('fix: do x')
    expect(formatCheckReport(r)).toContain('fix: do x')
  })
})

describe('runCheckCli — exit codes', () => {
  const sink = () => {
    const lines: string[] = []
    return { lines, write: (l: string) => lines.push(l) }
  }
  const ok: WorkspaceCheckReport = { findings: [], errors: 0, warnings: 0, workflows: { ok: 0, bad: 0 }, agents: { ok: 0, bad: 0 } }
  const withWarn: WorkspaceCheckReport = { findings: [{ domain: 'config', level: 'warn', code: 'c', message: 'm' }], errors: 0, warnings: 1, workflows: { ok: 0, bad: 0 }, agents: { ok: 0, bad: 0 } }
  const withErr: WorkspaceCheckReport = { findings: [{ domain: 'config', level: 'error', code: 'c', message: 'm' }], errors: 1, warnings: 0, workflows: { ok: 0, bad: 0 }, agents: { ok: 0, bad: 0 } }

  it('--help prints usage and exits 0', async () => {
    const o = sink()
    const code = await runCheckCli({ argv: ['--help'], out: o.write, validate: async () => ok })
    expect(code).toBe(0)
    expect(o.lines.join('\n')).toContain('gotong check')
  })

  it('a clean workspace exits 0', async () => {
    expect(await runCheckCli({ argv: [], env: {}, out: () => {}, validate: async () => ok })).toBe(0)
  })

  it('any error exits 1', async () => {
    expect(await runCheckCli({ argv: [], env: {}, out: () => {}, validate: async () => withErr })).toBe(1)
  })

  it('warnings exit 0 by default but 1 with --strict', async () => {
    expect(await runCheckCli({ argv: [], env: {}, out: () => {}, validate: async () => withWarn })).toBe(0)
    expect(await runCheckCli({ argv: ['--strict'], env: {}, out: () => {}, err: () => {}, validate: async () => withWarn })).toBe(1)
  })

  it('a stray argument exits 2', async () => {
    expect(await runCheckCli({ argv: ['--what'], env: {}, err: () => {}, validate: async () => ok })).toBe(2)
  })

  it('passes GOTONG_SPACE through to the validator', async () => {
    let seen = ''
    await runCheckCli({ argv: [], env: { GOTONG_SPACE: '/custom' }, out: () => {}, validate: async (o) => { seen = o.spaceDir; return ok } })
    expect(seen).toBe('/custom')
  })
})
