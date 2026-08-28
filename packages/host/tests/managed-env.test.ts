/**
 * UXCFG-M1 — host 自己在 boot 读 `<space>/gotong.env`。
 *
 * 这份门守四件事,每一件都是承重的:
 *   1. **白名单是结构性的** —— 认的键恰好是写入方允许写的那一份。凭证不是被
 *      「挡下来」的,是**根本没有那条路**。
 *   2. **环境永远赢**,且「已设」的判据与 `main-cli.ts` 的 `env()` 逐字一致
 *      (空串 = 未设)。两边不一致会造出一个既不是文件说的、也不是环境说的旋钮。
 *   3. **非法值不注入** —— 手改坏了要响亮跳过,不要注入进去让下游静默回落默认。
 *   4. **写入方与读取方拼的是同一个路径** —— 这条最要紧:两边各自单测全绿而
 *      路径不一致,正是这一刀在修的那个 bug(`config-set` 写 `<space>/gotong.env`,
 *      systemd 读 `/etc/gotong.env`)。故这条门**跨模块**跑一次真 round-trip。
 */

import { describe, it, expect } from 'vitest'

import { loadManagedEnv, managedEnvFilePath } from '../src/managed-env.js'
import { ENV_KNOB_KEYS } from '../src/ops-config-write.js'
import { runOpsCommand, type OpsCaller, type OpsDeps } from '../src/ops-core.js'

const SPACE = '/space'

function fileSeam(files: Record<string, string>) {
  return (p: string): string => {
    if (p in files) return files[p]!
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
}

function load(text: string | null, target: Record<string, string | undefined> = {}) {
  const files = text === null ? {} : { [managedEnvFilePath(SPACE)]: text }
  return { r: loadManagedEnv(SPACE, { target, readFileImpl: fileSeam(files) }), target }
}

describe('loadManagedEnv', () => {
  it('文件不在 = 诚实的「没有」,不是问题(绝大多数部署本来就没有)', () => {
    const { r, target } = load(null)
    expect(r.problem).toBeUndefined()
    expect(r.applied).toEqual([])
    expect(target).toEqual({})
  })

  it('白名单内的合法值注入 process.env', () => {
    const { r, target } = load('GOTONG_MODE=team\nGOTONG_WEB_PORT=3001\n')
    expect(r.applied).toEqual(['GOTONG_MODE', 'GOTONG_WEB_PORT'])
    expect(target.GOTONG_MODE).toBe('team')
    expect(target.GOTONG_WEB_PORT).toBe('3001')
  })

  it('环境里已经设了 ⇒ 环境赢,文件让位', () => {
    const { r, target } = load('GOTONG_WEB_PORT=3001\n', { GOTONG_WEB_PORT: '9000' })
    expect(r.shadowed).toEqual(['GOTONG_WEB_PORT'])
    expect(r.applied).toEqual([])
    expect(target.GOTONG_WEB_PORT).toBe('9000')
  })

  it('环境里是空串 ⇒ 按 `env()` 的语义算「未设」,文件的值照进', () => {
    // 这条不是风格问题:`env()` 对 `''` 回落 fallback。如果这里把 `''` 当「已设」,
    // 一个 `FOO=` 会 shadow 掉文件的值、而下游又当它没设——那个旋钮于是两头落空。
    const { r, target } = load('GOTONG_MODE=team\n', { GOTONG_MODE: '' })
    expect(r.applied).toEqual(['GOTONG_MODE'])
    expect(target.GOTONG_MODE).toBe('team')
  })

  it('白名单外的键结构性看不见 —— 凭证搬不进来', () => {
    const { r, target } = load(
      'GOTONG_MASTER_KEY=deadbeef\nANTHROPIC_API_KEY=sk-nope\nGOTONG_TELEGRAM_BOT_TOKEN=123\nGOTONG_MODE=team\n',
    )
    expect(r.ignored).toEqual(['ANTHROPIC_API_KEY', 'GOTONG_MASTER_KEY', 'GOTONG_TELEGRAM_BOT_TOKEN'])
    expect(r.applied).toEqual(['GOTONG_MODE'])
    expect(target.GOTONG_MASTER_KEY).toBeUndefined()
    expect(target.ANTHROPIC_API_KEY).toBeUndefined()
    expect(target.GOTONG_TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('注入的键集合恒是白名单的子集(一份定义两处执法)', () => {
    const text = ENV_KNOB_KEYS.map((k) => `${k}=zzz-not-a-valid-value`).join('\n') + '\nSOMETHING_ELSE=1\n'
    const { r } = load(text)
    for (const k of [...r.applied, ...r.rejected.map((x) => x.key)]) {
      expect(ENV_KNOB_KEYS).toContain(k as (typeof ENV_KNOB_KEYS)[number])
    }
    expect(r.ignored).toEqual(['SOMETHING_ELSE'])
  })

  it('值过不了写入方的校验器 ⇒ 不注入,带病名记进 rejected', () => {
    const { r, target } = load('GOTONG_WEB_PORT=70000\nGOTONG_MODE=team\n')
    expect(r.applied).toEqual(['GOTONG_MODE'])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.key).toBe('GOTONG_WEB_PORT')
    expect(r.rejected[0]!.reason).toBeTruthy()
    expect(target.GOTONG_WEB_PORT).toBeUndefined()
  })

  it('校验器会归一的值,注入的是归一后的那个', () => {
    // `always` / `never` 是 doctor 印在人眼前的名字,而 parseOpenBrowserEnv 不认它们。
    const { r, target } = load('GOTONG_OPEN_BROWSER=never\n')
    expect(r.applied).toEqual(['GOTONG_OPEN_BROWSER'])
    expect(target.GOTONG_OPEN_BROWSER).toBe('false')
  })

  it('读不动(非 ENOENT)⇒ 响亮说出来,但不拒启', () => {
    const r = loadManagedEnv(SPACE, {
      target: {},
      readFileImpl: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    })
    expect(r.problem).toContain('EACCES')
    expect(r.applied).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 跨模块:写入方写下去的字节,读取方真读得回来
// ───────────────────────────────────────────────────────────────────────────

describe('config-set → loadManagedEnv round-trip', () => {
  it('两边拼的是同一个路径,且值真的到达 process.env', async () => {
    const files = new Map<string, string>()
    // 刻意**不传** envFilePath —— 要测的正是那个默认值,它必须与 managedEnvFilePath 一致。
    const deps: OpsDeps = {
      spaceDir: SPACE,
      readFileImpl: async (p: string): Promise<string> => {
        if (files.has(p)) return files.get(p)!
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      writeFileImpl: async (p: string, data: string): Promise<void> => {
        files.set(p, data)
      },
      mkdirpImpl: async (): Promise<void> => {},
    }
    const CLI: OpsCaller = { surface: 'cli', allowConfigWrite: true }

    await runOpsCommand('config-set', ['GOTONG_WEB_PORT', '3007'], CLI, deps)
    expect(files.has(managedEnvFilePath(SPACE))).toBe(true)

    const target: Record<string, string | undefined> = {}
    const r = loadManagedEnv(SPACE, { target, readFileImpl: (p) => files.get(p)! })
    expect(r.applied).toEqual(['GOTONG_WEB_PORT'])
    expect(target.GOTONG_WEB_PORT).toBe('3007')
  })
})
