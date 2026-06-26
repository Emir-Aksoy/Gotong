/**
 * M3 config-write — injected-pure tests. No real fs, no host boot: every fs
 * touch and the audit sink are fakes, so these assert the SECURITY contract
 * directly — legal writes land + audit a row; malformed values and secret-name
 * keys are refused with NO write and NO success audit; a bad price is refused
 * BEFORE the write (not at the next boot); the effective-config view never leaks
 * a secret value; and the `runOpsCommand` chokepoint refuses config-write from a
 * surface that may not write it.
 */

import { describe, it, expect } from 'vitest'

import {
  applyEnvKnob,
  applyPricingUpsert,
  readEffectiveConfig,
  isSecretKey,
  parseEnvFile,
  serializeEnvFile,
  type ConfigWriteAuditSink,
} from '../src/ops-config-write.js'
import { runOpsCommand, OpsError, OpsTierError, type OpsCaller, type OpsDeps } from '../src/ops-core.js'

const ENV_PATH = '/space/aipehub.env'
const PRICING_PATH = '/space/pricing.json'

/** In-memory fs seam: ENOENT (thrown) for absent paths so `readFileOr` falls back. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  let writes = 0
  return {
    files,
    get writes() {
      return writes
    },
    readFileImpl: async (p: string): Promise<string> => {
      if (files.has(p)) return files.get(p)!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeFileImpl: async (p: string, data: string): Promise<void> => {
      writes++
      files.set(p, data)
    },
    mkdirpImpl: async (): Promise<void> => {},
  }
}

function fakeAudit() {
  const calls: Array<Record<string, unknown>> = []
  const sink: ConfigWriteAuditSink = (m) => {
    calls.push(m)
  }
  return { calls, sink }
}

// ───────────────────────────────────────────────────────────────────────────
// env-file parse / serialize round-trip
// ───────────────────────────────────────────────────────────────────────────

describe('parseEnvFile / serializeEnvFile', () => {
  it('round-trips KEY=value, ignoring comments and blanks', () => {
    const map = parseEnvFile('# header\n\nAIPE_MODE=team\nAIPE_WEB_PORT=3001\n')
    expect(map.get('AIPE_MODE')).toBe('team')
    expect(map.get('AIPE_WEB_PORT')).toBe('3001')
    const text = serializeEnvFile(map)
    // keys are sorted for a clean diff; values survive
    expect(parseEnvFile(text).get('AIPE_MODE')).toBe('team')
    expect(parseEnvFile(text).get('AIPE_WEB_PORT')).toBe('3001')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// isSecretKey
// ───────────────────────────────────────────────────────────────────────────

describe('isSecretKey', () => {
  it('flags secret-suffix keys, not the whitelisted knobs', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'AIPE_TELEGRAM_BOT_TOKEN', 'AIPE_LARK_APP_SECRET', 'AIPE_MASTER_KEY', 'DB_PASSWORD']) {
      expect(isSecretKey(k)).toBe(true)
    }
    for (const k of ['AIPE_MODE', 'AIPE_WEB_PORT', 'AIPE_WS_PORT', 'AIPE_OPEN_BROWSER']) {
      expect(isSecretKey(k)).toBe(false)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// applyEnvKnob (config-set)
// ───────────────────────────────────────────────────────────────────────────

describe('applyEnvKnob', () => {
  it('lands a legal value and writes an audit row', async () => {
    const fs = fakeFs()
    const audit = fakeAudit()
    const result = await applyEnvKnob(
      { key: 'AIPE_MODE', value: 'team' },
      { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...fs },
    )
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('AIPE_MODE')).toBe('team')
    expect(audit.calls).toHaveLength(1)
    expect(audit.calls[0]).toMatchObject({ kind: 'env', key: 'AIPE_MODE', value: 'team', surface: 'cli', takesEffectOnRestart: true })
    expect(result.data).toMatchObject({ kind: 'env', key: 'AIPE_MODE', value: 'team' })
  })

  it('normalizes a port and rejects a non-integer port — no write on reject', async () => {
    const ok = fakeFs()
    await applyEnvKnob({ key: 'AIPE_WEB_PORT', value: ' 8080 ' }, { envFilePath: ENV_PATH, surface: 'cli', ...ok })
    expect(parseEnvFile(ok.files.get(ENV_PATH)!).get('AIPE_WEB_PORT')).toBe('8080')

    const bad = fakeFs()
    const audit = fakeAudit()
    await expect(
      applyEnvKnob({ key: 'AIPE_WEB_PORT', value: '8080abc' }, { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...bad }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(bad.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
  })

  it('rejects an out-of-range port', async () => {
    const fs = fakeFs()
    await expect(
      applyEnvKnob({ key: 'AIPE_WS_PORT', value: '99999' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(fs.writes).toBe(0)
  })

  it('rejects a mode outside the closed set', async () => {
    const fs = fakeFs()
    await expect(
      applyEnvKnob({ key: 'AIPE_MODE', value: 'enterprise' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(fs.writes).toBe(0)
  })

  it('HARD-refuses a secret-name key before any write or audit', async () => {
    const fs = fakeFs()
    const audit = fakeAudit()
    await expect(
      applyEnvKnob({ key: 'ANTHROPIC_API_KEY', value: 'sk-leak' }, { envFilePath: ENV_PATH, surface: 'web', audit: audit.sink, ...fs }),
    ).rejects.toMatchObject({ code: 'secret_key_refused' })
    expect(fs.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
    // the secret value never reached disk
    expect([...fs.files.values()].join('')).not.toContain('sk-leak')
  })

  it('refuses an unknown (non-whitelisted) knob', async () => {
    const fs = fakeFs()
    await expect(
      applyEnvKnob({ key: 'AIPE_FANCY', value: 'x' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'unknown_knob' })
    expect(fs.writes).toBe(0)
  })

  it('merges over existing knobs (does not clobber the file)', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'AIPE_WEB_PORT=3001\n' })
    await applyEnvKnob({ key: 'AIPE_MODE', value: 'team' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    const after = parseEnvFile(fs.files.get(ENV_PATH)!)
    expect(after.get('AIPE_WEB_PORT')).toBe('3001')
    expect(after.get('AIPE_MODE')).toBe('team')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// applyPricingUpsert (config-price)
// ───────────────────────────────────────────────────────────────────────────

describe('applyPricingUpsert', () => {
  it('lands a legal price and writes an audit row', async () => {
    const fs = fakeFs()
    const audit = fakeAudit()
    await applyPricingUpsert(
      { model: 'my-model', price: { inputPer1M: 1.5, outputPer1M: 6 } },
      { pricingPath: PRICING_PATH, surface: 'cli', audit: audit.sink, ...fs },
    )
    const written = JSON.parse(fs.files.get(PRICING_PATH)!)
    expect(written['my-model']).toEqual({ inputPer1M: 1.5, outputPer1M: 6 })
    expect(audit.calls[0]).toMatchObject({ kind: 'pricing', model: 'my-model', surface: 'cli', takesEffectOnRestart: true })
  })

  it('refuses a malformed price BEFORE the write (not at boot) — no write, no audit', async () => {
    const fs = fakeFs()
    const audit = fakeAudit()
    await expect(
      applyPricingUpsert(
        { model: 'm', price: { inputPer1M: -1, outputPer1M: 2 } },
        { pricingPath: PRICING_PATH, surface: 'cli', audit: audit.sink, ...fs },
      ),
    ).rejects.toMatchObject({ code: 'invalid_price' })
    expect(fs.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
  })

  it('refuses a non-numeric rate', async () => {
    const fs = fakeFs()
    await expect(
      applyPricingUpsert(
        { model: 'm', price: { inputPer1M: Number('abc'), outputPer1M: 2 } },
        { pricingPath: PRICING_PATH, surface: 'cli', ...fs },
      ),
    ).rejects.toMatchObject({ code: 'invalid_price' })
    expect(fs.writes).toBe(0)
  })

  it('refuses to write into a corrupt existing pricing file', async () => {
    const fs = fakeFs({ [PRICING_PATH]: 'not json at all' })
    await expect(
      applyPricingUpsert(
        { model: 'm', price: { inputPer1M: 1, outputPer1M: 2 } },
        { pricingPath: PRICING_PATH, surface: 'cli', ...fs },
      ),
    ).rejects.toMatchObject({ code: 'pricing_corrupt' })
    expect(fs.writes).toBe(0)
  })

  it('upserts: merges into existing overrides', async () => {
    const fs = fakeFs({ [PRICING_PATH]: JSON.stringify({ a: { inputPer1M: 1, outputPer1M: 2 } }) })
    await applyPricingUpsert(
      { model: 'b', price: { inputPer1M: 3, outputPer1M: 4 } },
      { pricingPath: PRICING_PATH, surface: 'cli', ...fs },
    )
    const written = JSON.parse(fs.files.get(PRICING_PATH)!)
    expect(Object.keys(written).sort()).toEqual(['a', 'b'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// readEffectiveConfig (config read view)
// ───────────────────────────────────────────────────────────────────────────

describe('readEffectiveConfig', () => {
  it('shows secret env vars set/unset ONLY — never their values', async () => {
    const fs = fakeFs()
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { AIPE_MASTER_KEY: 'super-secret-value', ANTHROPIC_API_KEY: '' },
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const master = view.secrets.find((s) => s.key === 'AIPE_MASTER_KEY')
    const anthropic = view.secrets.find((s) => s.key === 'ANTHROPIC_API_KEY')
    expect(master?.set).toBe(true)
    expect(anthropic?.set).toBe(false)
    // the value appears NOWHERE in the serialized view
    expect(JSON.stringify(view)).not.toContain('super-secret-value')
  })

  it('splits knob file value vs live env value', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'AIPE_MODE=team\n' })
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { AIPE_WEB_PORT: '9000' },
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const mode = view.knobs.find((k) => k.key === 'AIPE_MODE')!
    const port = view.knobs.find((k) => k.key === 'AIPE_WEB_PORT')!
    expect(mode.fileValue).toBe('team')
    expect(mode.envValue).toBe(null)
    expect(port.fileValue).toBe(null)
    expect(port.envValue).toBe('9000')
  })

  it('reports pricing absent / present / corrupt honestly', async () => {
    const absent = fakeFs()
    expect((await readEffectiveConfig({ spaceDir: '/space', env: {}, pricingPath: PRICING_PATH, envFilePath: ENV_PATH, readFileImpl: absent.readFileImpl })).pricing).toMatchObject({ present: false })

    const present = fakeFs({ [PRICING_PATH]: JSON.stringify({ a: { inputPer1M: 1, outputPer1M: 2 }, b: { inputPer1M: 3, outputPer1M: 4 } }) })
    expect((await readEffectiveConfig({ spaceDir: '/space', env: {}, pricingPath: PRICING_PATH, envFilePath: ENV_PATH, readFileImpl: present.readFileImpl })).pricing).toMatchObject({ present: true, overrideModels: 2 })

    const corrupt = fakeFs({ [PRICING_PATH]: '{ broken' })
    expect((await readEffectiveConfig({ spaceDir: '/space', env: {}, pricingPath: PRICING_PATH, envFilePath: ENV_PATH, readFileImpl: corrupt.readFileImpl })).pricing).toMatchObject({ present: true, corrupt: true })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// runOpsCommand — the config-write tier chokepoint
// ───────────────────────────────────────────────────────────────────────────

describe('runOpsCommand config-write gate', () => {
  function depsWith(fs: ReturnType<typeof fakeFs>, audit?: ConfigWriteAuditSink): OpsDeps {
    return {
      spaceDir: '/space',
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      ...(audit ? { audit } : {}),
      readFileImpl: fs.readFileImpl,
      writeFileImpl: fs.writeFileImpl,
      mkdirpImpl: fs.mkdirpImpl,
    }
  }
  const IM: OpsCaller = { surface: 'im', allowConfigWrite: false }
  const CLI: OpsCaller = { surface: 'cli', allowConfigWrite: true }

  it('refuses config-set when caller may not write config — and NOTHING is written', async () => {
    const fs = fakeFs()
    await expect(runOpsCommand('config-set', ['AIPE_MODE', 'team'], IM, depsWith(fs))).rejects.toBeInstanceOf(OpsTierError)
    await expect(runOpsCommand('config-set', ['AIPE_MODE', 'team'], IM, depsWith(fs))).rejects.toMatchObject({
      code: 'config_write_not_permitted',
      tier: 'config-write',
    })
    expect(fs.writes).toBe(0)
  })

  it('refuses config-price from IM too', async () => {
    const fs = fakeFs()
    await expect(runOpsCommand('config-price', ['m', '1', '2'], IM, depsWith(fs))).rejects.toMatchObject({
      code: 'config_write_not_permitted',
    })
    expect(fs.writes).toBe(0)
  })

  it('runs config-set when the caller may write config', async () => {
    const fs = fakeFs()
    const audit = fakeAudit()
    const res = await runOpsCommand('config-set', ['AIPE_MODE', 'team'], CLI, depsWith(fs, audit.sink))
    expect(res.command).toBe('config-set')
    expect(res.tier).toBe('config-write')
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('AIPE_MODE')).toBe('team')
    expect(audit.calls).toHaveLength(1)
  })

  it('runs the config READ view on any surface (no gate)', async () => {
    const fs = fakeFs()
    const res = await runOpsCommand('config', [], IM, depsWith(fs))
    expect(res.command).toBe('config')
    expect(res.tier).toBe('read')
  })

  it('validates a bad price THROUGH the chokepoint (no write)', async () => {
    const fs = fakeFs()
    await expect(runOpsCommand('config-price', ['m', '-1', '2'], CLI, depsWith(fs))).rejects.toBeInstanceOf(OpsError)
    expect(fs.writes).toBe(0)
  })
})
