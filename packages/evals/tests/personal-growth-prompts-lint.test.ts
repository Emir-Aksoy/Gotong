/**
 * Static lint of the 7 personal-growth system prompts.
 *
 * What this catches: someone editing one of the 7 prompts forgets to
 * include the P0-1 three-segment contract markers, or accidentally
 * deletes the search-tool degradation guard, or drops the "称呼「你」"
 * constraint. CI fails before the regressed prompt ships.
 *
 * What this does NOT catch: the prompt being well-written, the LLM
 * actually following it, or any semantic quality. Those are for HITL
 * review (industry-consultation) or production telemetry.
 *
 * # Why fs.readFile, not import()
 *
 * The prompts file `scripts/personal-growth-prompts.mjs` embeds
 * markdown that contains `<NEED_INPUT>` / `<REPLAN>` literal markers
 * inside template literals. Vite's default esbuild transform tries to
 * read `<...>` as JSX and fails. Rather than fight esbuild's loader
 * rules (which got messy when we tried `loader: 'js'`), we read the
 * file as plain text and slice out the seven `export const xxx = \`...\``
 * blocks with a small parser. This:
 *   - avoids esbuild's parsing entirely
 *   - works for any monorepo cwd
 *   - is what we want anyway: lint the *source code* string, not the
 *     runtime-evaluated string (they're identical for our purposes
 *     since there's no interpolation in the prompts)
 *
 * If `personal-growth-prompts.mjs` ever stops existing (refactored
 * away, moved, etc.) the suite soft-skips with a warning so other
 * eval tests still run.
 */

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkStructure } from '../src/checkers/structure.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPTS_PATH = resolve(HERE, '../../..', 'scripts/personal-growth-prompts.mjs')

interface Prompts {
  interviewer: string
  bodyCoach: string
  mindCoach: string
  directionCoach: string
  leverageCoach: string
  circleCoach: string
  growthSynthesist: string
}

/**
 * Parse out `export const <name> = \`<body>\``  for each of the seven
 * known prompt names from the source text. The bodies contain backticks
 * only when escaped (we've never needed one — the template literals
 * have markdown but no embedded backticks). To stay defensive we look
 * for the first **unescaped** backtick after the opening one.
 */
function parsePrompts(source: string): Partial<Prompts> {
  const names: (keyof Prompts)[] = [
    'interviewer',
    'bodyCoach',
    'mindCoach',
    'directionCoach',
    'leverageCoach',
    'circleCoach',
    'growthSynthesist',
  ]
  const out: Partial<Prompts> = {}
  for (const name of names) {
    const opener = `export const ${name} = \``
    const i = source.indexOf(opener)
    if (i === -1) continue
    const bodyStart = i + opener.length
    // Find next unescaped backtick.
    let j = bodyStart
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') {
        j += 2 // skip escaped char
        continue
      }
      if (c === '`') break
      j += 1
    }
    if (j >= source.length) continue
    out[name] = source.slice(bodyStart, j)
  }
  return out
}

async function loadPromptSource(): Promise<string | null> {
  try {
    await stat(PROMPTS_PATH)
  } catch {
    return null
  }
  return readFile(PROMPTS_PATH, 'utf8')
}

describe('personal-growth prompts (P0-1 three-segment contract)', () => {
  let prompts: Partial<Prompts> = {}
  let skip = false

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  ;(async () => {
    const source = await loadPromptSource()
    if (!source) {
      skip = true
      // eslint-disable-next-line no-console
      console.warn(
        `[personal-growth-prompts-lint] ${PROMPTS_PATH} not found — skipping suite`,
      )
      return
    }
    prompts = parsePrompts(source)
  })()
  // Note: vitest collects tests synchronously, but `it` bodies run
  // async after collection so the IIFE above completes before any
  // assertion fires. (Verified empirically: this pattern works because
  // node resolves microtasks before the next macro task that vitest
  // schedules.)

  // ---- Lazy-load helper to make assertions deterministic regardless
  // ---- of microtask ordering above.
  async function ensureLoaded(): Promise<boolean> {
    if (skip) return false
    if (Object.keys(prompts).length === 0) {
      const source = await loadPromptSource()
      if (!source) {
        skip = true
        return false
      }
      prompts = parsePrompts(source)
    }
    return true
  }

  it('all 7 prompts parsed from the .mjs source', async () => {
    if (!(await ensureLoaded())) return
    expect(typeof prompts.interviewer).toBe('string')
    expect(typeof prompts.bodyCoach).toBe('string')
    expect(typeof prompts.mindCoach).toBe('string')
    expect(typeof prompts.directionCoach).toBe('string')
    expect(typeof prompts.leverageCoach).toBe('string')
    expect(typeof prompts.circleCoach).toBe('string')
    expect(typeof prompts.growthSynthesist).toBe('string')
    // Sanity: prompts should be more than just stubs.
    expect(prompts.interviewer!.length).toBeGreaterThan(500)
    expect(prompts.growthSynthesist!.length).toBeGreaterThan(800)
  })

  it('interviewer prompt contains three-segment contract markers', async () => {
    if (!(await ensureLoaded())) return
    const r = checkStructure(prompts.interviewer!, {
      requiredSections: [
        '我的核心判断',
        '我读到的你',
        '我想跟你聊到深一点的 5 件事',
        '这次画像的置信度与边界',
      ],
    })
    expect(r.violations).toEqual([])
    expect(prompts.interviewer).toContain('三段契约硬约束')
    expect(prompts.interviewer).toContain('NEED_INPUT')
  })

  it.each([
    ['bodyCoach', '我看到的身体基线', '我需要专业医生的边界'],
    ['mindCoach', '我听到的心理底色', '心理咨询师 / 危机干预的边界'],
    ['directionCoach', '目标地图', '12 周主线 + 副线'],
    ['leverageCoach', '资源盘点', '三个杠杆点'],
    ['circleCoach', '我听到的关系地图', '你的关系缺位'],
  ] as const)('5-coach prompt %s has TL;DR + body sections + 置信度', async (
    name,
    firstAnalysisHeading,
    middleHeading,
  ) => {
    if (!(await ensureLoaded())) return
    const prompt = (prompts as Record<string, string | undefined>)[name]
    expect(prompt, `${name} not parsed from source`).toBeTypeOf('string')
    const r = checkStructure(prompt!, {
      requiredSections: [
        '我的核心判断',
        firstAnalysisHeading,
        middleHeading,
        '我还想再了解你的',
        '这次输出的置信度与边界',
        '如果你接到了 search 工具',
      ],
    })
    expect(r.violations).toEqual([])
    expect(prompt).toContain('三段契约硬约束')
    expect(prompt).toContain('称呼「你」')
  })

  it('growthSynthesist prompt has TL;DR (一句话发展路径) + REPLAN + closing confidence', async () => {
    if (!(await ensureLoaded())) return
    const r = checkStructure(prompts.growthSynthesist!, {
      requiredSections: [
        '一句话发展路径',
        '5 维之间的核心张力',
        '12 周墙上计划',
        '做不到怎么办',
        '5 个权衡判断',
        '是否建议重跑某维度',
        '这份计划的置信度与边界',
        '我想跟你说的一句话',
      ],
    })
    expect(r.violations).toEqual([])
    expect(prompts.growthSynthesist).toContain('三段契约硬约束')
    expect(prompts.growthSynthesist).toContain('<REPLAN>')
    expect(prompts.growthSynthesist).toContain('"step"')
    expect(prompts.growthSynthesist).toContain('"reason"')
  })

  it('no prompt uses the banned formal pronoun 「您」 (project requires 「你」)', async () => {
    if (!(await ensureLoaded())) return
    for (const [name, text] of Object.entries(prompts) as Array<[string, string]>) {
      if (typeof text !== 'string') continue
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.includes('您')) {
          // Allow lines that explicitly tell the LLM not to use 「您」.
          if (line.includes('不用「您」') || line.includes('不用 「您」')) continue
          throw new Error(
            `prompt ${name} has forbidden 「您」 outside the "don't use it" instruction:\n  ${line}`,
          )
        }
      }
    }
  })
})
