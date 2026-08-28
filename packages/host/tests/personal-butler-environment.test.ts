/**
 * HANDS-M4 环境卡的门。分六组:
 *   ① 工具面与只读契约(schema 封闭;探针不 spawn 不联网)
 *   ② 采集(逐块降级;每块读不动只让那块 null)
 *   ③ 提案引擎纯函数(端口撞车两支 / 待生效 / 手 / 工具链 / 内存 / 磁盘 / 出网)
 *   ④ 判别联合的承重性(applicable:false 结构性带不上动作;可应用只指向 M3c)
 *   ⑤ 渲染(逐行降级;敏感事实结构性不出现)
 *   ⑥ 真实默认探针(默认实现自己也要被跑一次,否则生产那条路没人验过)
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerEnvironmentToolset,
  defaultHubEnvProbe,
  probeHubEnvironment,
  proposeEnvironmentFixes,
  renderHubEnvironment,
  type HubEnvironment,
  type HubEnvProbe,
} from '../src/personal-butler-environment.js'
import { ENV_KNOB_KEYS } from '../src/ops-config-write.js'

const GIB = 1024 * 1024 * 1024

function probeOf(over: Partial<HubEnvProbe> = {}): HubEnvProbe {
  return {
    cpuCount: () => 4,
    totalMem: () => 8 * GIB,
    freeMem: () => 4 * GIB,
    nodeVersion: () => 'v20.20.2',
    platform: () => 'linux/x64',
    diskFree: () => 20 * GIB,
    pathDirs: () => ['/usr/bin'],
    exists: (p) => p === '/usr/bin/ffmpeg' || p === '/usr/bin/git' || p === '/usr/bin/docker',
    ...over,
  }
}

function knob(key: string, fileValue: string | null, envValue: string | null, def: string) {
  return { key, summary: '', default: def, fileValue, envValue }
}

/** 一份「什么都好」的采集结果——每组测试只改自己关心的那一块。 */
function healthyEnv(over: Partial<HubEnvironment> = {}): HubEnvironment {
  return {
    machine: {
      cpus: 4,
      totalMemBytes: 8 * GIB,
      freeMemBytes: 4 * GIB,
      diskFreeBytes: 20 * GIB,
      nodeVersion: 'v20.20.2',
      platform: 'linux/x64',
    },
    tools: [
      { command: 'ffmpeg', found: true },
      { command: 'git', found: true },
      { command: 'docker', found: true },
    ],
    hands: { armed: true, kind: 'bwrap' },
    knobs: [
      knob('GOTONG_WEB_PORT', null, '3000', '3000'),
      knob('GOTONG_WS_PORT', null, '4000', '4000'),
    ],
    outage: null,
    ...over,
  }
}

// ── ① 工具面与只读契约 ───────────────────────────────────────────────────────

describe('HANDS-M4 工具面', () => {
  it('恒装一件工具,参数空间封闭', () => {
    const tools = buildButlerEnvironmentToolset({}).listTools()
    expect(tools.map((t) => t.name)).toEqual(['hub_environment'])
    const schema = tools[0]!.inputSchema as Record<string, unknown>
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties).toEqual({})
  })

  it('描述如实声明只读:不跑命令、不发网络请求', () => {
    const d = buildButlerEnvironmentToolset({}).listTools()[0]!.description
    expect(d).toContain('只读')
    expect(d).toContain('不跑任何命令')
    expect(d).toContain('不发任何网络请求')
    // 指路的是 M3c 那件 governed 工具,不是别的写入口。
    expect(d).toContain('set_hub_config')
  })

  it('未知工具名拒绝', async () => {
    const r = await buildButlerEnvironmentToolset({}).callTool('nope', {})
    expect(r.isError).toBe(true)
  })

  it('探针只做 existsSync,绝不 spawn 也绝不 fetch(源码级断言)', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(
      new URL('../src/personal-butler-environment.ts', import.meta.url),
      'utf8',
    )
    // 注释里可以谈这件事,代码里不许写(与 innerHTML 门同姿态:剥掉注释再看)。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of ['child_process', 'spawn(', 'execFile', 'fetch(', 'node:http']) {
      expect(code.includes(forbidden), `环境探针不该出现 ${forbidden}`).toBe(false)
    }
  })
})

// ── ② 采集:逐块降级 ─────────────────────────────────────────────────────────

describe('HANDS-M4 采集', () => {
  it('全通时四块都在,工具按 PATH 命中', async () => {
    const env = await probeHubEnvironment({
      probe: probeOf(),
      hands: { armed: true, kind: 'sandbox-exec' },
      config: { knobs: async () => [knob('GOTONG_WEB_PORT', null, '3000', '3000')] },
      health: () => ({ snapshot: async () => ({ llmOutage: null }) }),
    })
    expect(env.machine?.cpus).toBe(4)
    expect(env.tools).toEqual([
      { command: 'ffmpeg', found: true },
      { command: 'git', found: true },
      { command: 'docker', found: true },
    ])
    expect(env.knobs?.length).toBe(1)
    expect(env.outage).toBe(null)
  })

  it('PATH 上没有就是没有(不 fallback 到别处)', async () => {
    const env = await probeHubEnvironment({ probe: probeOf({ exists: () => false }) })
    expect(env.tools?.every((t) => !t.found)).toBe(true)
  })

  it('机器探针抛错只让机器那块 null,别的照常', async () => {
    const warns: string[] = []
    const env = await probeHubEnvironment({
      probe: probeOf({
        cpuCount: () => {
          throw new Error('boom')
        },
      }),
      config: { knobs: async () => [knob('GOTONG_MODE', null, null, 'personal')] },
      logger: { warn: (m) => warns.push(m) },
    })
    expect(env.machine).toBe(null)
    expect(env.tools?.length).toBe(3)
    expect(env.knobs?.length).toBe(1)
    expect(warns.length).toBe(1)
  })

  it('旋钮读不动 = null(不是空数组:没接与读不动要分得开)', async () => {
    const noSurface = await probeHubEnvironment({ probe: probeOf() })
    expect(noSurface.knobs).toBe(null)
    const failed = await probeHubEnvironment({
      probe: probeOf(),
      config: {
        knobs: async () => {
          throw new Error('disk')
        },
      },
    })
    expect(failed.knobs).toBe(null)
  })

  it('体检三态:未接 / 读不动 / 有值', async () => {
    expect((await probeHubEnvironment({ probe: probeOf() })).outage).toBe('not_wired')
    expect(
      (
        await probeHubEnvironment({
          probe: probeOf(),
          health: () => ({
            snapshot: async () => {
              throw new Error('x')
            },
          }),
        })
      ).outage,
    ).toBe('unknown')
    // 体检面在但没接断供监测 ⇒ 字段 undefined ⇒ 'unknown',不当成「没断供」。
    expect(
      (
        await probeHubEnvironment({
          probe: probeOf(),
          health: () => ({ snapshot: async () => ({}) }),
        })
      ).outage,
    ).toBe('unknown')
  })
})

// ── ③ 提案引擎 ───────────────────────────────────────────────────────────────

describe('HANDS-M4 提案引擎', () => {
  it('一切正常 = 零提案', () => {
    expect(proposeEnvironmentFixes(healthyEnv())).toEqual([])
  })

  it('端口撞车(文件里)⇒ 可应用,指向 set_hub_config 把 WS 端口改回活着的值', () => {
    // 正是 M3c 让手机能造出来的那个错:两个端口都被写成 3000。
    const env = healthyEnv({
      knobs: [
        knob('GOTONG_WEB_PORT', null, '3000', '3000'),
        knob('GOTONG_WS_PORT', '3000', '4000', '4000'),
      ],
    })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'port-collision')
    expect(p?.applicable).toBe(true)
    expect(p?.applicable === true && p.apply).toEqual({
      tool: 'set_hub_config',
      key: 'GOTONG_WS_PORT',
      value: '4000',
    })
  })

  it('活着的值也撞 ⇒ 降级成只指路(挑端口是人的决定)', () => {
    const env = healthyEnv({
      knobs: [
        knob('GOTONG_WEB_PORT', '3000', '3000', '3000'),
        knob('GOTONG_WS_PORT', '3000', '3000', '4000'),
      ],
    })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'port-collision')
    expect(p?.applicable).toBe(false)
    expect(p?.applicable === false && p.howTo).toContain('得你定')
  })

  it('文件值与活值不同 ⇒ 报待生效,且如实说我重启不了 hub', () => {
    const env = healthyEnv({
      knobs: [knob('GOTONG_WEB_PORT', '8080', '3000', '3000'), knob('GOTONG_WS_PORT', null, '4000', '4000')],
    })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'pending-restart')
    expect(p?.detail).toContain('GOTONG_WEB_PORT')
    expect(p?.detail).toContain('8080')
    expect(p?.applicable).toBe(false)
    expect(p?.applicable === false && p.howTo).toContain('我自己重启不了 hub')
  })

  it('文件值写的就是活值 ⇒ 不报待生效(写过 ≠ 待生效)', () => {
    const env = healthyEnv({
      knobs: [knob('GOTONG_WEB_PORT', '3000', '3000', '3000'), knob('GOTONG_WS_PORT', '4000', '4000', '4000')],
    })
    expect(proposeEnvironmentFixes(env).some((x) => x.id === 'pending-restart')).toBe(false)
  })

  it('文件里写着一个过不了校验的值 ⇒ 报根因,且**那个值一个字符都不复述**', () => {
    // 卡面会进模型的上下文,而 gotong.env 不是这个编辑器一个人在写。
    const poison = 'abc<<INJECTED>>'
    const env = healthyEnv({
      knobs: [knob('GOTONG_WEB_PORT', poison, '3000', '3000'), knob('GOTONG_WS_PORT', null, '4000', '4000')],
    })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'invalid-knob-value')
    expect(p?.applicable).toBe(false)
    expect(p?.detail).toContain('GOTONG_WEB_PORT')
    // 载重:整张卡里找不到那个串(提案清单 + 渲染出来的正文都算)。
    expect(JSON.stringify(proposeEnvironmentFixes(env))).not.toContain('INJECTED')
    expect(renderHubEnvironment(env, 0)).not.toContain('INJECTED')
  })

  it('两个端口写成同一个不合法的值 ⇒ 只报根因,不报「撞车」', () => {
    // 两个 `abc` 确实相等,但那不是撞车,是「这根本不是端口」。指人去改一个
    // 不存在的问题,比不说更糟。
    const env = healthyEnv({
      knobs: [knob('GOTONG_WEB_PORT', 'abc', '3000', '3000'), knob('GOTONG_WS_PORT', 'abc', '4000', '4000')],
    })
    const ids = proposeEnvironmentFixes(env).map((x) => x.id)
    expect(ids).toContain('invalid-knob-value')
    expect(ids).not.toContain('port-collision')
  })

  it('活着的值自己就不合法 ⇒ 端口撞车降级成只指路(不提一个注定被 400 的值)', () => {
    const env = healthyEnv({
      knobs: [
        knob('GOTONG_WEB_PORT', null, '3000', '3000'),
        // 活值 `0` 不在 1-65535 里:拿它当 revert 会被 set_hub_config 当场拒。
        knob('GOTONG_WS_PORT', '3000', '0', '4000'),
      ],
    })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'port-collision')
    expect(p?.applicable).toBe(false)
  })

  it('活值合法只是文件值撞了 ⇒ 仍然可应用(上一条不是把整支关掉)', () => {
    const env = healthyEnv({
      knobs: [
        knob('GOTONG_WEB_PORT', null, '3000', '3000'),
        knob('GOTONG_WS_PORT', '3000', '4000', '4000'),
      ],
    })
    expect(
      proposeEnvironmentFixes(env).find((x) => x.id === 'port-collision')?.applicable,
    ).toBe(true)
  })

  it('没手 ⇒ 提案原样带上 boot 那次的原因,并说清我自己装不了监狱', () => {
    const env = healthyEnv({ hands: { armed: false, reason: '监狱缺席:no bwrap(装法…)' } })
    const p = proposeEnvironmentFixes(env).find((x) => x.id === 'no-hands')
    expect(p?.detail).toBe('监狱缺席:no bwrap(装法…)')
    expect(p?.applicable === false && p.howTo).toContain('我自己装不了')
  })

  it('缺 ffmpeg / git 出提案,缺 docker 不出(hub 自己不需要它)', () => {
    const env = healthyEnv({
      tools: [
        { command: 'ffmpeg', found: false },
        { command: 'git', found: false },
        { command: 'docker', found: false },
      ],
    })
    const ids = proposeEnvironmentFixes(env).map((p) => p.id)
    expect(ids).toContain('no-ffmpeg')
    expect(ids).toContain('no-git')
    expect(ids).not.toContain('no-docker')
  })

  it('内存/磁盘低于线才报,且都只指路(那些开关不在可改白名单里)', () => {
    const ok = proposeEnvironmentFixes(healthyEnv())
    expect(ok.some((p) => p.id === 'low-memory' || p.id === 'low-disk')).toBe(false)
    const tight = proposeEnvironmentFixes(
      healthyEnv({
        machine: {
          cpus: 1,
          totalMemBytes: 1 * GIB,
          freeMemBytes: 100 * 1024 * 1024,
          diskFreeBytes: 300 * 1024 * 1024,
          nodeVersion: 'v20.20.2',
          platform: 'linux/x64',
        },
      }),
    )
    const mem = tight.find((p) => p.id === 'low-memory')
    const disk = tight.find((p) => p.id === 'low-disk')
    expect(mem?.applicable).toBe(false)
    expect(disk?.applicable).toBe(false)
    expect(disk?.applicable === false && disk.howTo).toContain('删东西这件事我不做')
  })

  it('磁盘探不动(null)不当成 0:没有数字就不报', () => {
    const env = healthyEnv({
      machine: {
        cpus: 4,
        totalMemBytes: 8 * GIB,
        freeMemBytes: 4 * GIB,
        diskFreeBytes: null,
        nodeVersion: 'v20.20.2',
        platform: 'linux/x64',
      },
    })
    expect(proposeEnvironmentFixes(env).some((p) => p.id === 'low-disk')).toBe(false)
  })

  it('只有 network 类断供算环境问题,配额/鉴权类不算', () => {
    const net = proposeEnvironmentFixes(healthyEnv({ outage: { kind: 'network', since: 0 } }))
    expect(net.some((p) => p.id === 'no-egress')).toBe(true)
    for (const kind of ['quota', 'auth', 'rate_limited']) {
      const other = proposeEnvironmentFixes(healthyEnv({ outage: { kind, since: 0 } }))
      expect(other.some((p) => p.id === 'no-egress'), `${kind} 不该算出网问题`).toBe(false)
    }
  })

  it('每一块读不动都不产生提案(null ≠ 有问题)', () => {
    const blind: HubEnvironment = {
      machine: null,
      tools: null,
      hands: undefined,
      knobs: null,
      outage: 'unknown',
    }
    expect(proposeEnvironmentFixes(blind)).toEqual([])
  })
})

// ── ④ 判别联合的承重性 ──────────────────────────────────────────────────────

describe('HANDS-M4 可应用 = 只指向 M3c 那件 governed 工具', () => {
  it('凡 applicable:true,apply.tool 恒为 set_hub_config 且 key 在白名单内', () => {
    // 把每一种能产生可应用提案的输入都跑一遍,断言出口只有一个。
    const env = healthyEnv({
      knobs: [
        knob('GOTONG_WEB_PORT', null, '3000', '3000'),
        knob('GOTONG_WS_PORT', '3000', '4000', '4000'),
      ],
      hands: { armed: false, reason: 'x' },
      tools: [
        { command: 'ffmpeg', found: false },
        { command: 'git', found: false },
        { command: 'docker', found: false },
      ],
      outage: { kind: 'network', since: 0 },
    })
    const all = proposeEnvironmentFixes(env)
    expect(all.length).toBeGreaterThan(3)
    for (const p of all) {
      if (p.applicable) {
        expect(p.apply.tool).toBe('set_hub_config')
        expect(['GOTONG_MODE', 'GOTONG_WEB_PORT', 'GOTONG_WS_PORT', 'GOTONG_OPEN_BROWSER']).toContain(
          p.apply.key,
        )
      } else {
        // 判别联合承重:不可应用那一支结构上没有 apply 字段。
        expect(Object.prototype.hasOwnProperty.call(p, 'apply')).toBe(false)
        expect(p.howTo.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── ⑤ 渲染 ───────────────────────────────────────────────────────────────────

describe('HANDS-M4 渲染', () => {
  it('健康时六段齐全 + 明说没事,不编提案', () => {
    const out = renderHubEnvironment(healthyEnv(), 0)
    expect(out).toContain('4 核')
    expect(out).toContain('Node v20.20.2')
    expect(out).toContain('ffmpeg 有')
    expect(out).toContain('bwrap 监狱,已装')
    expect(out).toContain('没发现需要处理的地方')
  })

  it('基础设置那几行不回显不合法的值,只说「(值不合法)」', () => {
    const out = renderHubEnvironment(
      healthyEnv({
        knobs: [
          knob('GOTONG_WEB_PORT', 'not-a-port<<INJECTED>>', '3000', '3000'),
          knob('GOTONG_WS_PORT', null, '4000', '4000'),
        ],
      }),
      0,
    )
    expect(out).toContain('GOTONG_WEB_PORT = (值不合法)')
    expect(out).not.toContain('INJECTED')
    // 合法的那个照常印出来——这条门守的是「不合法不回显」,不是「都别印」。
    expect(out).toContain('GOTONG_WS_PORT = 4000')
  })

  it('全是默认值时折成一行并报条数,不刷 23 行', () => {
    // UXCFG-M2 把白名单扩到 23 项后,「全列出来」会让 20 行「跟出厂一样」把真正
    // 有人动过的那两三行埋掉。折叠**必须报出条数**——不是静默截断。
    const out = renderHubEnvironment(
      healthyEnv({
        knobs: [
          knob('GOTONG_WEB_PORT', null, null, '3000'),
          knob('GOTONG_WS_PORT', null, null, '4000'),
          knob('GOTONG_DEFAULT_LANG', null, null, 'zh'),
        ],
      }),
      0,
    )
    expect(out).toContain('3 项全是默认值')
    expect(out).not.toContain('GOTONG_WEB_PORT =')
  })

  it('有人动过的照常逐行列,没动过的折成一行', () => {
    const out = renderHubEnvironment(
      healthyEnv({
        knobs: [
          knob('GOTONG_WEB_PORT', '8080', '3000', '3000'),
          knob('GOTONG_WS_PORT', null, null, '4000'),
          knob('GOTONG_DEFAULT_LANG', null, null, 'zh'),
        ],
      }),
      0,
    )
    expect(out).toContain('GOTONG_WEB_PORT = 8080(现在还是 3000)')
    expect(out).toContain('其余 2 项都是默认值')
    expect(out).not.toContain('GOTONG_WS_PORT =')
  })

  it('内存那条点名的开关必须真在白名单上(能改 ≠ 该替你决定改哪个)', () => {
    // 这条门守的是**能力声明的诚实**:UXCFG-M2 之前这段文案写着「不在我能改的四个
    // 设置项里」,扩名单当天就变成了假话。反过来也一样——将来谁把这几个从白名单上
    // 拿掉,这里就会开始许一个做不到的诺。
    const tight = proposeEnvironmentFixes(
      healthyEnv({ machine: { cpus: 1, totalMemBytes: GIB, freeMemBytes: 100 * 1024 * 1024, diskFreeBytes: 20 * GIB, nodeVersion: 'v20.20.2', platform: 'linux/x64', pathDirs: [] } }),
    ).find((x) => x.id === 'low-memory')
    expect(tight).toBeTruthy()
    expect(tight!.applicable).toBe(false)   // 关哪一个是人的取舍,算不出确定安全的值
    const named = (tight!.applicable ? '' : tight!.howTo).match(/GOTONG_[A-Z_]+/g) ?? []
    expect(named.length).toBeGreaterThan(0)
    for (const k of named) expect(ENV_KNOB_KEYS).toContain(k)
  })

  it('出网那行明说是被动看的,不主动探', () => {
    expect(renderHubEnvironment(healthyEnv(), 0)).toContain('被动看,不主动探')
    const down = renderHubEnvironment(healthyEnv({ outage: { kind: 'network', since: 0 } }), 120_000)
    expect(down).toContain('断供中约 2 分钟')
  })

  it('逐块降级:读不动的块各自说话,整卡不失效', () => {
    const out = renderHubEnvironment(
      { machine: null, tools: null, hands: undefined, knobs: null, outage: 'unknown' },
      0,
    )
    expect(out).toContain('- 机器:(读取失败)')
    expect(out).toContain('- 工具链:(读取失败)')
    expect(out).toContain('- 手(监狱工作区):(未接)')
    expect(out).toContain('- 基础设置:(未接)')
  })

  it('待生效的旋钮在清单里标出「现在还是 X」', () => {
    const out = renderHubEnvironment(
      healthyEnv({
        knobs: [knob('GOTONG_WEB_PORT', '8080', '3000', '3000'), knob('GOTONG_WS_PORT', null, '4000', '4000')],
      }),
      0,
    )
    expect(out).toContain('GOTONG_WEB_PORT = 8080(现在还是 3000)')
    expect(out).toContain('GOTONG_WS_PORT = 4000')
    expect(out).not.toContain('GOTONG_WS_PORT = 4000(现在还是')
  })

  it('有可应用提案时,汇总句说清要 /me 批准', () => {
    const out = renderHubEnvironment(
      healthyEnv({
        knobs: [
          knob('GOTONG_WEB_PORT', null, '3000', '3000'),
          knob('GOTONG_WS_PORT', '3000', '4000', '4000'),
        ],
      }),
      0,
    )
    expect(out).toContain('我能帮你改(要你在 /me 批准)')
    expect(out).toContain('set_hub_config')
    expect(out).toContain('下次重启生效')
  })

  it('敏感事实结构性不出现:没有绝对路径 / 主机名 / 用户名', async () => {
    // 采集面根本不收这些,所以真跑一遍默认探针也不可能渲染出来。
    const env = await probeHubEnvironment({ probe: defaultHubEnvProbe(process.cwd()) })
    const out = renderHubEnvironment(env, 0)
    expect(out.includes(process.cwd())).toBe(false)
    expect(out.includes('/usr/bin')).toBe(false)
    const user = process.env.USER ?? process.env.LOGNAME
    if (user && user.length > 2) expect(out.includes(user)).toBe(false)
  })

  it('工具走到底:真调一次 hub_environment 拿到一张卡', async () => {
    const r = await buildButlerEnvironmentToolset({
      probe: probeOf(),
      hands: { armed: false, reason: '未开启' },
    }).callTool('hub_environment', {})
    expect(r.isError).toBeUndefined()
    expect(r.content[0]!.type === 'text' && r.content[0]!.text).toContain('这台 hub 的环境')
  })
})

// ── ⑥ 真实默认探针 ──────────────────────────────────────────────────────────

describe('HANDS-M4 默认探针', () => {
  it('默认实现自己也跑得通(生产走的就是这条路)', () => {
    const p = defaultHubEnvProbe(process.cwd())
    expect(p.cpuCount()).toBeGreaterThanOrEqual(1)
    expect(p.totalMem()).toBeGreaterThan(0)
    expect(p.nodeVersion()).toMatch(/^v\d+\./)
    expect(p.platform()).toContain('/')
    expect(p.pathDirs().length).toBeGreaterThan(0)
    // statfs 在这台机器上要么给出正数,要么诚实 null——绝不给 0 或负数。
    const free = p.diskFree()
    expect(free === null || free > 0).toBe(true)
  })

  it('不给 spaceRoot ⇒ 磁盘诚实 null,不猜 cwd', () => {
    expect(defaultHubEnvProbe().diskFree()).toBe(null)
  })
})
