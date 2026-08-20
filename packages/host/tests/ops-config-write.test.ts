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
