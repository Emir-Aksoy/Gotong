/**
 * M3 config-write — injected-pure tests. No real fs, no host boot: every fs
 * touch and the audit sink are fakes, so these assert the SECURITY contract
 * directly — legal writes land + audit a row; malformed values and secret-name
 * keys are refused with NO write and NO success audit; a bad price is refused
 * BEFORE the write (not at the next boot); the effective-config view never leaks
 * a secret value; and the `runOpsCommand` chokepoint refuses config-write from a
 * surface that may not write it.
 */

import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'

import {
  applyEnvKnob,
  unsetEnvKnob,
  applyPricingUpsert,
  readEffectiveConfig,
  isSecretKey,
  ENV_KNOBS,
  ENV_KNOB_KEYS,
  parseEnvFile,
  serializeEnvFile,
  type ConfigWriteAuditSink,
  type EnvKnobKey,
} from '../src/ops-config-write.js'
import { runOpsCommand, OpsError, OpsTierError, type OpsCaller, type OpsDeps } from '../src/ops-core.js'
import { parseButlerEnv, type ButlerEnvConfig } from '../src/butler-env.js'
import { parseTranscriptRetention } from '../src/transcript-retention.js'
import { parseRunRetention } from '../src/run-retention.js'
import { butlerVoiceFromEnv } from '../src/butler-voice.js'
import { envBool } from '../src/main-cli.js'
import { versionCheckEnabled } from '../src/version-check.js'

const ENV_PATH = '/space/gotong.env'
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
    const map = parseEnvFile('# header\n\nGOTONG_MODE=team\nGOTONG_WEB_PORT=3001\n')
    expect(map.get('GOTONG_MODE')).toBe('team')
    expect(map.get('GOTONG_WEB_PORT')).toBe('3001')
    const text = serializeEnvFile(map)
    // keys are sorted for a clean diff; values survive
    expect(parseEnvFile(text).get('GOTONG_MODE')).toBe('team')
    expect(parseEnvFile(text).get('GOTONG_WEB_PORT')).toBe('3001')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// isSecretKey
// ───────────────────────────────────────────────────────────────────────────

describe('isSecretKey', () => {
  it('flags secret-suffix keys, not the whitelisted knobs', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'GOTONG_TELEGRAM_BOT_TOKEN', 'GOTONG_LARK_APP_SECRET', 'GOTONG_MASTER_KEY', 'DB_PASSWORD']) {
      expect(isSecretKey(k)).toBe(true)
    }
    for (const k of ['GOTONG_MODE', 'GOTONG_WEB_PORT', 'GOTONG_WS_PORT', 'GOTONG_OPEN_BROWSER']) {
      expect(isSecretKey(k)).toBe(false)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 旋钮名单的类型面(Codex 轮 B / LOW 5)
// ───────────────────────────────────────────────────────────────────────────

describe('ENV_KNOB_KEYS / EnvKnobKey', () => {
  it('与 ENV_KNOBS 同序同内容(一份真相,不是手抄的第二份)', () => {
    expect([...ENV_KNOB_KEYS]).toEqual(ENV_KNOBS.map((k) => k.key))
    expect(ENV_KNOB_KEYS.length).toBeGreaterThan(0)
  })

  it('是**窄联合**不是 string —— 执法的那行必须还在源码里', () => {
    // 「窄不窄」是编译期的事,运行期断言不到:`EnvKnobKey` 塌成 `string` 之后,
    // 每一条 `toEqual` / `toContain` 照样绿。真正的门是 `ops-config-write.ts` 里
    // 那行 `@ts-expect-error` 自检——它一旦变成合法赋值,tsc 就红。
    //
    // 这条测试守的是**那行门自己还在**。刻意不写在测试文件里做类型断言:本包
    // tsconfig 只 include `src/**\/*.ts`,vitest 又走 esbuild 剥类型,写在这儿的
    // `@ts-expect-error` 两边都没人看,是一条永远绿的假门。
    const src = readFileSync(new URL('../src/ops-config-write.ts', import.meta.url), 'utf8')
    expect(src).toContain('] as const satisfies readonly EnvKnobSpec[]')
    expect(src).toMatch(/@ts-expect-error[^\n]*\n\s*const _envKnobKeyMustStayNarrow: EnvKnobKey = 'nope'/)
    const real: EnvKnobKey = 'GOTONG_WEB_PORT'
    expect(ENV_KNOB_KEYS).toContain(real)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GOTONG_OPEN_BROWSER 的别名与归一(Codex 轮 B / LOW 6)
// ───────────────────────────────────────────────────────────────────────────

describe('GOTONG_OPEN_BROWSER', () => {
  const spec = ENV_KNOBS.find((k) => k.key === 'GOTONG_OPEN_BROWSER')!

  it('拒绝语里许过的词,自己收得下(always / never)', () => {
    // 原来的拒绝语写着「auto/always/never」,而校验器只认 auto/1/0/true/false…
    // ——照着提示打字的人会被自己的 hub 拒绝。
    expect(spec.validate('always').ok).toBe(true)
    expect(spec.validate('never').ok).toBe(true)
  })

  it('收下之后必须**归一**成 host 真的会解析的词', () => {
    // 承重的是这一半:`parseOpenBrowserEnv` 根本不认识字面量 `always`,存进去
    // 会被它当成不认识的值落回 `auto`。存一个宿主读不懂的词 = 一次安静的撒谎。
    const a = spec.validate('always')
    expect(a.ok && a.value).toBe('true')
    const n = spec.validate('NEVER')
    expect(n.ok && n.value).toBe('false')
    const auto = spec.validate('  Auto ')
    expect(auto.ok && auto.value).toBe('auto')
    // 既有别名一个都没被这次改动挤掉。
    for (const [raw, want] of [
      ['1', 'true'],
      ['on', 'true'],
      ['yes', 'true'],
      ['0', 'false'],
      ['off', 'false'],
      ['no', 'false'],
    ] as const) {
      const v = spec.validate(raw)
      expect(v.ok && v.value).toBe(want)
    }
  })

  it('不认识的词照拒,且拒绝语里点名 always/never', () => {
    const v = spec.validate('maybe')
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('always')
    expect(v.ok === false && v.reason).toContain('never')
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
      { key: 'GOTONG_MODE', value: 'team' },
      { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...fs },
    )
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('GOTONG_MODE')).toBe('team')
    expect(audit.calls).toHaveLength(1)
    expect(audit.calls[0]).toMatchObject({ kind: 'env', key: 'GOTONG_MODE', value: 'team', surface: 'cli', takesEffectOnRestart: true })
    expect(result.data).toMatchObject({ kind: 'env', key: 'GOTONG_MODE', value: 'team' })
  })

  it('normalizes a port and rejects a non-integer port — no write on reject', async () => {
    const ok = fakeFs()
    await applyEnvKnob({ key: 'GOTONG_WEB_PORT', value: ' 8080 ' }, { envFilePath: ENV_PATH, surface: 'cli', ...ok })
    expect(parseEnvFile(ok.files.get(ENV_PATH)!).get('GOTONG_WEB_PORT')).toBe('8080')

    const bad = fakeFs()
    const audit = fakeAudit()
    await expect(
      applyEnvKnob({ key: 'GOTONG_WEB_PORT', value: '8080abc' }, { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...bad }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(bad.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
  })

  it('rejects an out-of-range port', async () => {
    const fs = fakeFs()
    await expect(
      applyEnvKnob({ key: 'GOTONG_WS_PORT', value: '99999' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(fs.writes).toBe(0)
  })

  it('rejects a mode outside the closed set', async () => {
    const fs = fakeFs()
    await expect(
      applyEnvKnob({ key: 'GOTONG_MODE', value: 'enterprise' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
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
      applyEnvKnob({ key: 'GOTONG_FANCY', value: 'x' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'unknown_knob' })
    expect(fs.writes).toBe(0)
  })

  it('merges over existing knobs (does not clobber the file)', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_WEB_PORT=3001\n' })
    await applyEnvKnob({ key: 'GOTONG_MODE', value: 'team' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    const after = parseEnvFile(fs.files.get(ENV_PATH)!)
    expect(after.get('GOTONG_WEB_PORT')).toBe('3001')
    expect(after.get('GOTONG_MODE')).toBe('team')
  })
})

// ---------------------------------------------------------------------------
// unsetEnvKnob (config-unset) — the way BACK to the built-in default
//
// Why this is its own verb rather than `config-set <KEY> <default>`: writing the
// default still leaves a pin on disk. The page then goes on reporting "you set
// this" about a knob the operator just asked to stop setting, and that pin
// freezes today's default across every future release. `''` can't stand in for
// "unset" either — it is already an *explicit clear* for the five sensory knobs.
// ---------------------------------------------------------------------------

describe('unsetEnvKnob', () => {
  it('removes just that line and leaves its neighbours alone', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_WEB_PORT=3001\nGOTONG_MODE=team\n' })
    const res = await unsetEnvKnob({ key: 'GOTONG_MODE' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    const after = parseEnvFile(fs.files.get(ENV_PATH)!)
    expect(after.has('GOTONG_MODE')).toBe(false)
    expect(after.get('GOTONG_WEB_PORT')).toBe('3001')
    expect((res.data as Record<string, unknown>).removed).toBe(true)
    expect(res.lines.join(' ')).toContain('personal') // reports the default it falls back to
  })

  it('an absent key is a success that writes ZERO bytes', async () => {
    // Load-bearing: `serializeEnvFile` always emits the header, so a blind
    // read-merge-write here would conjure a managed gotong.env onto a hub that
    // never had one — just because someone clicked "reset" on a knob that was
    // already sitting on its default.
    const fs = fakeFs()
    const res = await unsetEnvKnob({ key: 'GOTONG_MODE' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    expect(fs.writes).toBe(0)
    expect(fs.files.has(ENV_PATH)).toBe(false)
    expect((res.data as Record<string, unknown>).removed).toBe(false)
  })

  it('refuses a secret name on this door too — no write, no audit', async () => {
    // Removing a secret line could not leak anything; the refusal is here so the
    // editor has exactly ONE answer to "which keys do you touch". A second,
    // laxer door is how a whitelist rots.
    const fs = fakeFs({ [ENV_PATH]: 'ANTHROPIC_API_KEY=sk-live\n' })
    const audit = fakeAudit()
    await expect(
      unsetEnvKnob({ key: 'ANTHROPIC_API_KEY' }, { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...fs }),
    ).rejects.toMatchObject({ code: 'secret_key_refused' })
    expect(fs.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('ANTHROPIC_API_KEY')).toBe('sk-live')
  })

  it('refuses an unknown (non-whitelisted) knob', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_FANCY=x\n' })
    await expect(
      unsetEnvKnob({ key: 'GOTONG_FANCY' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs }),
    ).rejects.toMatchObject({ code: 'unknown_knob' })
    expect(fs.writes).toBe(0)
  })

  it('writes an audit row that says which key went away, and from where', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_MODE=team\n' })
    const audit = fakeAudit()
    await unsetEnvKnob({ key: 'GOTONG_MODE' }, { envFilePath: ENV_PATH, surface: 'butler', audit: audit.sink, ...fs })
    expect(audit.calls).toHaveLength(1)
    expect(audit.calls[0]).toMatchObject({
      kind: 'env-unset',
      surface: 'butler',
      key: 'GOTONG_MODE',
      removed: true,
      takesEffectOnRestart: true,
    })
  })

  it('says "unset" — not an empty default — for a knob whose default is empty', async () => {
    // Five sensory knobs default to ''. Printing "falls back to the built-in
    // default: " with nothing after the colon reads like a truncated message.
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_BUTLER_VOICE_MODEL=mimo-v2.5-tts\n' })
    const res = await unsetEnvKnob({ key: 'GOTONG_BUTLER_VOICE_MODEL' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    expect(res.lines[0]).toContain('unset')
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).has('GOTONG_BUTLER_VOICE_MODEL')).toBe(false)
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
      env: { GOTONG_MASTER_KEY: 'super-secret-value', ANTHROPIC_API_KEY: '' },
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const master = view.secrets.find((s) => s.key === 'GOTONG_MASTER_KEY')
    const anthropic = view.secrets.find((s) => s.key === 'ANTHROPIC_API_KEY')
    expect(master?.set).toBe(true)
    expect(anthropic?.set).toBe(false)
    // the value appears NOWHERE in the serialized view
    expect(JSON.stringify(view)).not.toContain('super-secret-value')
  })

  it('names the env file it is describing — the settings page prints this path', async () => {
    // UXCFG-M3: the view has to answer "where does this land?" itself. A UI that
    // has to reconstruct the path (from `pricing.path`, say) is right only until
    // someone overrides one of the two seams independently.
    const fs = fakeFs()
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: {},
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    expect(view.envFilePath).toBe(ENV_PATH)
  })

  it('splits knob file value vs live env value', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_MODE=team\n' })
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { GOTONG_WEB_PORT: '9000' },
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const mode = view.knobs.find((k) => k.key === 'GOTONG_MODE')!
    const port = view.knobs.find((k) => k.key === 'GOTONG_WEB_PORT')!
    expect(mode.fileValue).toBe('team')
    expect(mode.envValue).toBe(null)
    expect(port.fileValue).toBe(null)
    expect(port.envValue).toBe('9000')
  })

  // ── envInjectedKeys: the hub echoing its own file back is not an override ──
  //
  // UXCFG-M1 made the host read the managed env file at boot and inject it into
  // `process.env`. From that moment `deps.env[key]` returns the hub's OWN value,
  // and a naive read reports "set by the environment" — which the settings page
  // renders as a LOCKED control. The three tests below pin the whole rule: what
  // we injected is subtracted, what we did not is not.

  it("does not mistake the hub's own boot injection for an environment override", async () => {
    // The file says team; the host injected that same value at boot. This is a
    // FILE-controlled knob and the operator must still be able to change it.
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_MODE=team\n' })
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { GOTONG_MODE: 'team' },
      envInjectedKeys: ['GOTONG_MODE'],
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const mode = view.knobs.find((k) => k.key === 'GOTONG_MODE')!
    expect(mode.fileValue).toBe('team')
    expect(mode.envValue).toBe(null)
  })

  it('reads as default again the moment the file line is gone, even before restart', async () => {
    // The reset-to-default path: `config-unset` removed the line, but the value
    // this host injected at boot is still sitting in `process.env` and will be
    // until the next restart. Without the subtraction the operator would watch a
    // successful reset turn into "set by the environment".
    const fs = fakeFs({ [ENV_PATH]: '' })
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { GOTONG_MODE: 'team' },
      envInjectedKeys: ['GOTONG_MODE'],
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const mode = view.knobs.find((k) => k.key === 'GOTONG_MODE')!
    expect(mode.fileValue).toBe(null)
    expect(mode.envValue).toBe(null)
  })

  it('still reports a GENUINE external override — it is never in the injected set', async () => {
    // The safety net. `loadManagedEnv` records a key in `applied` only when it
    // actually wrote it; a variable the real environment already had lands in
    // `shadowed` instead. So the subtraction structurally cannot hide a real
    // `Environment=` / `export`, and the control stays locked as it should.
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_MODE=team\n' })
    const view = await readEffectiveConfig({
      spaceDir: '/space',
      env: { GOTONG_MODE: 'team', GOTONG_WEB_PORT: '9000' },
      envInjectedKeys: ['GOTONG_MODE'],
      envFilePath: ENV_PATH,
      pricingPath: PRICING_PATH,
      readFileImpl: fs.readFileImpl,
    })
    const port = view.knobs.find((k) => k.key === 'GOTONG_WEB_PORT')!
    expect(port.envValue).toBe('9000')
    expect(port.fileValue).toBe(null)
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
    await expect(runOpsCommand('config-set', ['GOTONG_MODE', 'team'], IM, depsWith(fs))).rejects.toBeInstanceOf(OpsTierError)
    await expect(runOpsCommand('config-set', ['GOTONG_MODE', 'team'], IM, depsWith(fs))).rejects.toMatchObject({
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
    const res = await runOpsCommand('config-set', ['GOTONG_MODE', 'team'], CLI, depsWith(fs, audit.sink))
    expect(res.command).toBe('config-set')
    expect(res.tier).toBe('config-write')
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('GOTONG_MODE')).toBe('team')
    expect(audit.calls).toHaveLength(1)
  })

  it('refuses config-unset from IM too — the way back is the same tier as the way in', async () => {
    const fs = fakeFs({ [ENV_PATH]: 'GOTONG_MODE=team\n' })
    await expect(runOpsCommand('config-unset', ['GOTONG_MODE'], IM, depsWith(fs))).rejects.toMatchObject({
      code: 'config_write_not_permitted',
      tier: 'config-write',
    })
    expect(fs.writes).toBe(0)
  })

  it('set then unset THROUGH the chokepoint leaves the file with no pin at all', async () => {
    // The round-trip the settings page needs: this is what "reset to default"
    // has to mean. Setting the default value instead would leave a line behind
    // and the page would keep answering "you set this".
    const fs = fakeFs()
    const set = await runOpsCommand('config-set', ['GOTONG_MODE', 'team'], CLI, depsWith(fs))
    expect(set.command).toBe('config-set')
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('GOTONG_MODE')).toBe('team')

    const unset = await runOpsCommand('config-unset', ['GOTONG_MODE'], CLI, depsWith(fs))
    expect(unset.command).toBe('config-unset')
    expect(unset.tier).toBe('config-write')
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).has('GOTONG_MODE')).toBe(false)
  })

  it('config-unset without a key is a usage error, not a silent no-op', async () => {
    const fs = fakeFs()
    await expect(runOpsCommand('config-unset', [], CLI, depsWith(fs))).rejects.toBeInstanceOf(OpsError)
    expect(fs.writes).toBe(0)
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

// ───────────────────────────────────────────────────────────────────────────
// read-merge-write safety (Codex 轮 B MEDIUM 3)
//
// 这一族守的不是「写得对不对」，是**写之前那次读**。config-set 的形状是
// read → merge → write：读那一步只要撒一次谎（把「读不动」读成「空文件」），
// 下一步的序列化就会把**别的每一个键**擦掉——而人点头批准的那张卡上只写了
// 一个键。同理，两个并发的 read-merge-write 会双双读到旧内容，后写的把前一个
// 悄悄丢掉，两边却各自都拿到过一次批准。
// ───────────────────────────────────────────────────────────────────────────

/** fs seam whose READ has a real await gap — 并发不是思想实验，是可复现的交错。 */
function slowFakeFs(initial: Record<string, string> = {}, readDelayTicks = 3) {
  const base = fakeFs(initial)
  return {
    ...base,
    get writes() {
      return base.writes
    },
    readFileImpl: async (p: string): Promise<string> => {
      for (let i = 0; i < readDelayTicks; i += 1) await Promise.resolve()
      return base.readFileImpl(p)
    },
  }
}

/** fs seam whose read fails with something that is NOT ENOENT. */
function unreadableFs(path: string, code: string, initial: Record<string, string> = {}) {
  const base = fakeFs(initial)
  return {
    ...base,
    get writes() {
      return base.writes
    },
    readFileImpl: async (p: string): Promise<string> => {
      if (p === path) throw Object.assign(new Error(code), { code })
      return base.readFileImpl(p)
    },
  }
}

describe('read-merge-write safety', () => {
  it('an UNREADABLE env file is refused before the write — the other knobs survive', async () => {
    const existing = 'GOTONG_MODE=team\nGOTONG_WEB_PORT=3001\n'
    const fs = unreadableFs(ENV_PATH, 'EACCES', { [ENV_PATH]: existing })
    const audit = fakeAudit()
    await expect(
      applyEnvKnob({ key: 'GOTONG_WS_PORT', value: '9000' }, { envFilePath: ENV_PATH, surface: 'cli', audit: audit.sink, ...fs }),
    ).rejects.toMatchObject({ code: 'config_file_unreadable' })
    expect(fs.writes).toBe(0)
    expect(audit.calls).toHaveLength(0)
    // 载重断言：盘上那份**逐字节没动**。吞掉读错误的版本会把它变成
    // `GOTONG_WS_PORT=9000\n`，两个别的键人间蒸发。
    expect(fs.files.get(ENV_PATH)).toBe(existing)
  })

  it('CONTROL — an ABSENT env file still creates it (absent is mergeable, unreadable is not)', async () => {
    const fs = fakeFs()
    await applyEnvKnob({ key: 'GOTONG_WS_PORT', value: '9000' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('GOTONG_WS_PORT')).toBe('9000')
  })

  it('an UNREADABLE pricing file is refused before the write (same chokepoint)', async () => {
    const existing = '{"m":{"inputPer1M":1,"outputPer1M":2}}'
    const fs = unreadableFs(PRICING_PATH, 'EIO', { [PRICING_PATH]: existing })
    await expect(
      applyPricingUpsert(
        { model: 'n', price: { inputPer1M: 3, outputPer1M: 4 } },
        { pricingPath: PRICING_PATH, surface: 'cli', ...fs },
      ),
    ).rejects.toMatchObject({ code: 'config_file_unreadable' })
    expect(fs.writes).toBe(0)
    expect(fs.files.get(PRICING_PATH)).toBe(existing)
  })

  it('two concurrent env writes BOTH survive (the later read sees the earlier write)', async () => {
    const fs = slowFakeFs()
    await Promise.all([
      applyEnvKnob({ key: 'GOTONG_MODE', value: 'team' }, { envFilePath: ENV_PATH, surface: 'web', ...fs }),
      applyEnvKnob({ key: 'GOTONG_WS_PORT', value: '9000' }, { envFilePath: ENV_PATH, surface: 'butler', ...fs }),
    ])
    const after = parseEnvFile(fs.files.get(ENV_PATH)!)
    expect(after.get('GOTONG_MODE')).toBe('team')
    expect(after.get('GOTONG_WS_PORT')).toBe('9000')
  })

  it('two concurrent price writes BOTH survive', async () => {
    const fs = slowFakeFs()
    await Promise.all([
      applyPricingUpsert({ model: 'a', price: { inputPer1M: 1, outputPer1M: 2 } }, { pricingPath: PRICING_PATH, surface: 'web', ...fs }),
      applyPricingUpsert({ model: 'b', price: { inputPer1M: 3, outputPer1M: 4 } }, { pricingPath: PRICING_PATH, surface: 'cli', ...fs }),
    ])
    const after = JSON.parse(fs.files.get(PRICING_PATH)!) as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual(['a', 'b'])
  })

  it('a failed write does not poison the queue for the next writer', async () => {
    const fs = slowFakeFs()
    const boom = { ...fs, writeFileImpl: async () => { throw new Error('disk on fire') } }
    await expect(
      applyEnvKnob({ key: 'GOTONG_MODE', value: 'team' }, { envFilePath: ENV_PATH, surface: 'cli', ...boom }),
    ).rejects.toBeTruthy()
    await applyEnvKnob({ key: 'GOTONG_WS_PORT', value: '9000' }, { envFilePath: ENV_PATH, surface: 'cli', ...fs })
    expect(parseEnvFile(fs.files.get(ENV_PATH)!).get('GOTONG_WS_PORT')).toBe('9000')
  })

  it('the DEFAULT write is atomic (tmp + rename), not a bare writeFile', async () => {
    // 原子性本身没法在不断电的情况下观察到，能守的是**它走哪条实现**：默认写
    // 必须是 core 的 `writeFileAtomic`，而这个模块不许再从 node:fs/promises
    // 里拿 `writeFile`（拿了就会有人图省事用它）。散文里可以谈，代码里不许写。
    const src = readFileSync(new URL('../src/ops-config-write.ts', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toMatch(/import\s*\{[^}]*\bwriteFileAtomic\b[^}]*\}\s*from\s*'@gotong\/core'/)
    expect(code).not.toMatch(/import\s*\{[^}]*\bwriteFile\b\s*[,}][^}]*\}\s*from\s*'node:fs\/promises'/)
    expect(code).toMatch(/seams\.writeFileImpl\s*\?\?[\s\S]{0,80}writeFileAtomic/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// UXCFG-M2 — 白名单扩到 23 个之后,写侧校验器与读侧解析器必须说同一种话。
//
// 这一组测试**刻意不复制任何一个数字**。上下界抄一遍就是第二份真相,它会跟着
// 第一份一起漂移而没有人被通知。钉的是行为等价:
//
//   设置页收下的值 ⟺ 阿同逐字照跑的值。
//
// 谁先动都会红:放宽 `cadenceMs` ⇒ 出现「收了但被钳走」的值;收紧 `cadence()` ⇒
// 同样一条。而「被钳走」正是界面替旋钮撒谎的那个形状 —— 页面上写着 6h,后台跑的
// 是别的数。
// ───────────────────────────────────────────────────────────────────────────
describe('UXCFG-M2 whitelist ⇄ butler-env agreement', () => {
  const knob = (key: EnvKnobKey) => ENV_KNOBS.find((k) => k.key === key)!

  const CADENCES = [
    { key: 'GOTONG_BUTLER_MAINTENANCE_MS' as const, read: (c: ButlerEnvConfig) => c.maintenanceMs },
    { key: 'GOTONG_BUTLER_PROACTIVE_MS' as const, read: (c: ButlerEnvConfig) => c.proactiveMs },
    { key: 'GOTONG_BUTLER_RUN_BROADCAST_MS' as const, read: (c: ButlerEnvConfig) => c.runBroadcastMs },
  ]

  // 从 30s 到 48h,横跨三个旋钮的全部上下界,外加它们的边界前后一格。
  const PROBES_MS = [
    1, 1_000, 30_000, 59_999, 60_000, 60_001,
    5 * 60_000 - 1, 5 * 60_000, 5 * 60_000 + 1,
    60 * 60_000 - 1, 60 * 60_000, 60 * 60_000 + 1,
    6 * 60 * 60_000, 24 * 60 * 60_000 - 1, 24 * 60 * 60_000, 24 * 60 * 60_000 + 1,
    48 * 60 * 60_000,
  ]

  for (const c of CADENCES) {
    it(`${c.key}: 收下的一律逐字生效,会被钳走的一律先被拒`, () => {
      let accepted = 0
      for (const ms of PROBES_MS) {
        const verdict = knob(c.key).validate(String(ms))
        const live = c.read(parseButlerEnv({ [c.key]: String(ms) }, '/space'))
        if (verdict.ok) {
          accepted++
          // 收了就必须原样跑 —— 这条断言就是「界面不许撒谎」。
          expect(live, `${c.key}=${ms} 被设置页收下,却被 cadence() 钳成 ${live}`).toBe(ms)
        } else {
          // 拒了必须真的是因为它会被钳走(而不是拒了一个本来好好的值)。
          expect(live, `${c.key}=${ms} 被设置页拒绝,但 cadence() 其实原样接受`).not.toBe(ms)
        }
      }
      // 探针集必须真的两边都探到 —— 否则上面两条可能空洞地真。
      expect(accepted).toBeGreaterThan(0)
      expect(accepted).toBeLessThan(PROBES_MS.length)
    })

    it(`${c.key}: 写法不影响裁决,只有数值影响`, () => {
      // 同一个时长换三种写法必须得到同一个裁决与同一个值 —— 这样就钉住了「形式
      // 解析」而完全不必在测试里复述这个旋钮的量程(那正是要避免的第二份真相)。
      for (const [a, b, c2] of [
        ['1800000', '1800s', '30m'],
        ['3600000', '3600s', '1h'],
      ]) {
        const va = knob(c.key).validate(a)
        expect(knob(c.key).validate(b)).toEqual(va)
        expect(knob(c.key).validate(c2)).toEqual(va)
        expect(knob(c.key).validate(`  ${c2.toUpperCase()} `)).toEqual(va)
      }
      // 不是时长的一律拒,绝不 Number() 出个 NaN 再让 `|| fallback` 悄悄兜底。
      expect(knob(c.key).validate('soon').ok).toBe(false)
      expect(knob(c.key).validate('6 hours').ok).toBe(false)
      expect(knob(c.key).validate('-1').ok).toBe(false)
      expect(knob(c.key).validate('').ok).toBe(false)
    })

    it(`${c.key}: 默认值本身过得了自己的校验器`, () => {
      const spec = knob(c.key)
      const v = spec.validate(spec.defaultValue)
      expect(v.ok, `${c.key} 的 defaultValue '${spec.defaultValue}' 过不了自己的校验器`).toBe(true)
    })
  }

  it('时长的人类写法落到毫秒(在量程最宽的 _MAINTENANCE_MS 上断一次)', () => {
    const k = knob('GOTONG_BUTLER_MAINTENANCE_MS')
    expect(k.validate('90s')).toEqual({ ok: true, value: '90000' })
    expect(k.validate('  30M ')).toEqual({ ok: true, value: '1800000' })
    expect(k.validate('6h')).toEqual({ ok: true, value: '21600000' })
    expect(k.validate('21600000')).toEqual({ ok: true, value: '21600000' })
  })

  // 三套互不兼容的布尔解析器(onUnlessDisabled / onlyIfEnabled / envBool)是本仓
  // 既有的事实。validateBool 归一化成 'true'/'false' 正是为了同时喂饱它们 ——
  // 若有人把归一化改成 'on'/'off',envBool 会静默读成 false,这里当场红。
  const SWITCHES = [
    { key: 'GOTONG_BUTLER_MAINTENANCE' as const, read: (c: ButlerEnvConfig) => c.maintenanceOn, onWhenUnset: true },
    { key: 'GOTONG_BUTLER_PROACTIVE' as const, read: (c: ButlerEnvConfig) => c.proactiveOn, onWhenUnset: true },
    { key: 'GOTONG_BUTLER_RUN_BROADCAST' as const, read: (c: ButlerEnvConfig) => c.runBroadcastOn, onWhenUnset: true },
    { key: 'GOTONG_BUTLER_MEMORY_GIT' as const, read: (c: ButlerEnvConfig) => c.memoryGitOn, onWhenUnset: false },
    { key: 'GOTONG_BUTLER_MEMORY_LIBRARIAN' as const, read: (c: ButlerEnvConfig) => c.memoryLibrarianOn, onWhenUnset: false },
    { key: 'GOTONG_BUTLER_MEMORY_RECONCILE' as const, read: (c: ButlerEnvConfig) => c.memoryReconcileOn, onWhenUnset: false },
    { key: 'GOTONG_BUTLER_MEMORY_LINKS' as const, read: (c: ButlerEnvConfig) => c.memoryLinksOn, onWhenUnset: false },
  ]

  for (const s of SWITCHES) {
    it(`${s.key}: 归一化后的 true/false 真的能两向拨动它`, () => {
      const on = knob(s.key).validate('yes')
      const off = knob(s.key).validate('off')
      expect(on).toEqual({ ok: true, value: 'true' })
      expect(off).toEqual({ ok: true, value: 'false' })
      expect(s.read(parseButlerEnv({ [s.key]: on.ok ? on.value : '' }, '/space'))).toBe(true)
      expect(s.read(parseButlerEnv({ [s.key]: off.ok ? off.value : '' }, '/space'))).toBe(false)
      // 未设时的样子必须与 defaultValue 声明的一致 —— 面板拿 defaultValue 当
      // 「你没改过时它是什么」印给人看。
      expect(s.read(parseButlerEnv({}, '/space'))).toBe(s.onWhenUnset)
      expect(knob(s.key).defaultValue).toBe(s.onWhenUnset ? 'true' : 'false')
    })
  }

  it('归一化后的值必须喂得饱**最挑剔**的那个解析器', () => {
    // envBool 只认 '1' / 'true' / 'yes' —— 连 'on' 都不认。它读 GOTONG_A2A_SIGN_CARD;
    // versionCheckEnabled 另有自己一套读 GOTONG_UPDATE_CHECK。把归一化改成 'on'
    // 之类,这两个旋钮会静默停留在关闭状态,而设置页会显示「已开启」。
    const on = knob('GOTONG_A2A_SIGN_CARD').validate('enable')
    const off = knob('GOTONG_A2A_SIGN_CARD').validate('disabled')
    expect([on, off]).toEqual([{ ok: true, value: 'true' }, { ok: true, value: 'false' }])

    const prev = process.env.GOTONG_A2A_SIGN_CARD
    try {
      process.env.GOTONG_A2A_SIGN_CARD = on.ok ? on.value : ''
      expect(envBool('GOTONG_A2A_SIGN_CARD', false)).toBe(true)
      process.env.GOTONG_A2A_SIGN_CARD = off.ok ? off.value : ''
      expect(envBool('GOTONG_A2A_SIGN_CARD', true)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.GOTONG_A2A_SIGN_CARD
      else process.env.GOTONG_A2A_SIGN_CARD = prev
    }

    const u = knob('GOTONG_UPDATE_CHECK')
    expect(versionCheckEnabled({ GOTONG_UPDATE_CHECK: (u.validate('y') as { value: string }).value })).toBe(true)
    expect(versionCheckEnabled({ GOTONG_UPDATE_CHECK: (u.validate('n') as { value: string }).value })).toBe(false)
  })

  it('五个感官旋钮:空串 = 显式清除,不是错误', () => {
    const SENSORY = [
      'GOTONG_BUTLER_VOICE_MODEL',
      'GOTONG_BUTLER_VOICE_VOICE',
      'GOTONG_BUTLER_ASR_MODEL',
      'GOTONG_BUTLER_VISION_MODEL',
      'GOTONG_BUTLER_EMBEDDER_MODEL',
    ] as const
    for (const key of SENSORY) {
      expect(knob(key).validate(''), `${key} 收不了空串 = 打开了就再也关不掉`).toEqual({ ok: true, value: '' })
      expect(knob(key).validate('   ')).toEqual({ ok: true, value: '' })
    }
    // 清成空串之后,那条腿必须真的不存在(等同从没设过)。
    expect(
      butlerVoiceFromEnv({
        GOTONG_BUTLER_VOICE_URL: 'https://example.invalid/v1',
        GOTONG_BUTLER_VOICE_KEY: 'k',
        GOTONG_BUTLER_VOICE_MODEL: '',
        GOTONG_BUTLER_VOICE_VOICE: '茉莉',
      }),
    ).toBeUndefined()
  })

  it('标识符类旋钮拒控制字符 —— 一个换行就是往 env 文件里多写一行', () => {
    const key: EnvKnobKey = 'GOTONG_BUTLER_VOICE_MODEL'
    const nl = String.fromCharCode(10)
    const injected = `mimo${nl}GOTONG_MASTER_KEY=pwned`
    expect(knob(key).validate(injected).ok).toBe(false)
    expect(knob(key).validate(`a${String.fromCharCode(0)}b`).ok).toBe(false)
    // 反向:中文音色 id 是合法的(校验器刻意不限 ASCII)。
    expect(knob(key).validate('茉莉')).toEqual({ ok: true, value: '茉莉' })
  })

  it('标识符类旋钮有长度上界 —— 「值域有界」这条性质要有人守', () => {
    // 这条是变异测试逼出来的:把 `if (t.length > 96)` 改成 `> 99999`,本文件
    // **一条都不红**。也就是说在此之前,「标识符不是一段任意长的自由文本」这条
    // 性质在单元层没有任何东西守着。
    //
    // 它承重,是因为 `set_hub_config` 能进 `IM_APPROVABLE_TOOLS`,靠的正是参数
    // 空间封闭 + 值域有界(见 personal-butler-config.ts 头注边界 3)。一旦某个
    // 键能收下任意长的字符串,这件工具就跟 `hands_*` 的 argv 是同一类东西了。
    const key: EnvKnobKey = 'GOTONG_BUTLER_VOICE_MODEL'
    const over = knob(key).validate('x'.repeat(97))
    expect(over.ok).toBe(false)
    // 拒绝语要说得出**为什么**,不然模型只能瞎试。
    expect(over.ok === false && over.reason).toContain('96')
    // 边界就在它自称的地方 —— 否则 96 是个没人核过的数字。
    expect(knob(key).validate('x'.repeat(96)).ok).toBe(true)
  })

  it('每个旋钮的 defaultValue 都过得了自己的校验器', () => {
    for (const spec of ENV_KNOBS) {
      const v = spec.validate(spec.defaultValue)
      expect(v.ok, `${spec.key} 的 defaultValue '${spec.defaultValue}' 过不了自己的校验器`).toBe(true)
    }
  })

  it('刻意拒收的那几个,确实不在名单上', () => {
    // 每一条都在 ENV_KNOBS 的头注里写了理由。名单上多出任何一个 = 判据被绕过。
    const REFUSED = [
      'GOTONG_BUTLER', // 关掉它 = 关掉手机上唯一能把它开回来的路
      'GOTONG_BUTLER_GOVERNED', // 审批闸本身
      'GOTONG_HOST', // 单独设 0.0.0.0 ⇒ auditBootSecurity 两条 fatal ⇒ 拒启
      'GOTONG_SPACE_NAME', // openOrInit 对已存在的 space 忽略 opts.name
      'GOTONG_LOG_LEVEL',
      'GOTONG_LOG_FORMAT',
      'GOTONG_ALLOW_INSECURE',
      'GOTONG_COOKIE_SECURE',
      'GOTONG_TRUST_PROXY',
      'GOTONG_ALLOWED_HOSTS',
      'GOTONG_GATING',
      'GOTONG_SPACE',
      'GOTONG_AUDIT_KEEP_DAYS', // identity SQL DELETE 族 —— 行删了就没了;STOR-M3b 收归档族时仍拒
    ]
    for (const key of REFUSED) {
      expect(ENV_KNOB_KEYS as readonly string[], `${key} 溜进了可改名单`).not.toContain(key)
    }
  })
})

describe('STOR-M3b: 存储归档旋钮的校验域 ⊆ boot 解析域(单向 containment)', () => {
  // 这四个旋钮与上面 cadence 那批(UXCFG-M2)守的是方向相反的两种谎:cadence 的
  // 读侧对越界值**钳位**,校验器放松一寸 = 写进去的值被静默改掉;这四个的读侧
  // (parseTranscriptRetention / parseRunRetention)对坏值是**抛错拒启**,校验器
  // 放松一寸 = 写进去一颗重启炸弹——设置页存一次,下次 boot 起不来,而炸的人
  // 正是刚才那个以为「保存成功」的人。
  //
  // 所以合同是单向的:凡校验器收下的 verdict.value(applyEnvKnob 真正落盘的是
  // 它,不是原始输入),喂给**真 parse** 必须不抛、且落到确切的数;反过来 parse
  // 收得下而校验器拒收('10001'/'1e3')是刻意收窄——安全方向,不是 bug,但要
  // 钉住,免得哪天有人把收窄当 bug「修」松了。
  //
  // containment 必须逐旋钮验,不能按字符串形状一概而论:同一个 '1.5',KEEP 的
  // parse(要整数)会抛,DAYS 的 parse(要正数)却收得下——校验器唯一的正确姿势
  // 是比**两个** parse 都严,这正是 `^\d+$` 一条规则同时站得住的原因。
  const NOW = 1_756_000_000_000
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  const knob = (key: EnvKnobKey) => {
    const spec = ENV_KNOBS.find((k) => k.key === key)
    if (!spec) throw new Error(`${key} 不在 ENV_KNOBS 名单上`)
    return spec
  }

  type Family = {
    key: EnvKnobKey
    /** 只设这一个键,喂给真 parse,返回它落到的数(undefined = 读成未配置)。 */
    parsed: (value: string) => number | undefined
    /** verdict.value 归一后的数 n → parse 应落到的确切值。 */
    expected: (n: number) => number
    /** 校验器该收下的(含 trim / 去前导零两个归一化探针)。 */
    accepted: string[]
    /** 校验器拒收、真 parse 却收得下的 —— 刻意收窄的证据。 */
    stricterThanParse: string[]
    /** 两边都拒的坏形状 —— parse 真的抛,证明校验器守着一道真崖(非空洞)。 */
    brokenForBoth: string[]
  }

  const FAMILIES: Family[] = [
    {
      key: 'GOTONG_TRANSCRIPT_KEEP_SEGMENTS',
      parsed: (v) => parseTranscriptRetention({ GOTONG_TRANSCRIPT_KEEP_SEGMENTS: v }, NOW)?.keepLast,
      expected: (n) => n,
      accepted: ['0', '1', '8', '007', '  8  ', '10000'],
      stricterThanParse: ['10001', '1e3', '+5'],
      brokenForBoth: ['1.5', '-1', 'abc'],
    },
    {
      key: 'GOTONG_TRANSCRIPT_ARCHIVE_DAYS',
      parsed: (v) => parseTranscriptRetention({ GOTONG_TRANSCRIPT_ARCHIVE_DAYS: v }, NOW)?.before,
      expected: (n) => NOW - n * MS_PER_DAY,
      accepted: ['1', '30', '0030', '3650'],
      stricterThanParse: ['3651', '0.5', '1e2'],
      brokenForBoth: ['0', '-1', 'abc'],
    },
    {
      key: 'GOTONG_RUN_KEEP',
      parsed: (v) => parseRunRetention({ GOTONG_RUN_KEEP: v }, NOW)?.keepLast,
      expected: (n) => n,
      accepted: ['0', '1', '200', '007', '10000'],
      stricterThanParse: ['10001', '1e3', '+5'],
      brokenForBoth: ['1.5', '-1', 'abc'],
    },
    {
      key: 'GOTONG_RUN_ARCHIVE_DAYS',
      parsed: (v) => parseRunRetention({ GOTONG_RUN_ARCHIVE_DAYS: v }, NOW)?.before,
      expected: (n) => NOW - n * MS_PER_DAY,
      accepted: ['1', '30', '3650'],
      stricterThanParse: ['3651', '0.5'],
      brokenForBoth: ['0', '-1', 'abc'],
    },
  ]

  for (const fam of FAMILIES) {
    it(`${fam.key}: 收下的每个 verdict.value,boot 解析必须收下且落到同一个数`, () => {
      const spec = knob(fam.key)
      for (const raw of fam.accepted) {
        const v = spec.validate(raw)
        expect(v.ok, `名单应收下 '${raw}'`).toBe(true)
        if (!v.ok) continue
        // 落盘的是 verdict.value(归一化后),containment 必须对真正会写进
        // gotong.env 的那份字节成立 —— 不是对成员敲进输入框的原始字符串。
        const n = Number(v.value)
        expect(fam.parsed(v.value), `parse('${v.value}') ← 校验通过的 '${raw}'`).toBe(fam.expected(n))
      }
    })

    it(`${fam.key}: 空串是显式清除 —— 校验器收下,boot 读成「未配置」`, () => {
      // defaultValue 是 '',「每个旋钮的 defaultValue 都过得了自己的校验器」那道
      // 通用门也压着这半;这里钉的是另一半:'' 落盘后 parse 把它读成没设过,
      // 即「清空输入框保存」= 关掉归档,不是一颗坏值炸弹。
      const v = knob(fam.key).validate('')
      expect(v.ok).toBe(true)
      expect(v.ok && v.value).toBe('')
      expect(fam.parsed('')).toBeUndefined()
    })

    it(`${fam.key}: 拒收但 parse 收得下的值 —— 刻意收窄,方向安全`, () => {
      const spec = knob(fam.key)
      for (const raw of fam.stricterThanParse) {
        expect(spec.validate(raw).ok, `'${raw}' 应被名单拒收(哪怕 parse 收得下)`).toBe(false)
        expect(() => fam.parsed(raw), `parse 本身收得下 '${raw}' —— 收窄在名单侧`).not.toThrow()
      }
    })

    it(`${fam.key}: 坏形状 parse 真的抛 —— 校验器守的这道崖是真的`, () => {
      const spec = knob(fam.key)
      for (const raw of fam.brokenForBoth) {
        expect(spec.validate(raw).ok, `'${raw}' 应被名单拒收`).toBe(false)
        expect(() => fam.parsed(raw), `parse('${raw}') 应抛错(= 校验器若放行,写完下次 boot 拒启)`).toThrow()
      }
    })
  }
})
