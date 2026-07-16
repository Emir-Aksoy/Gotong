/**
 * butler-toolface-report.ts — AFR-M1. Pure measurement core for the butler's
 * per-turn TOOL FACE: every tool schema the model carries each turn.
 *
 * Why measure first: NA-M0 clocked the butler at ~34+ tool schemas (6–10K
 * tokens) per turn, and NA explicitly deferred "工具面瘦身先度量后动". AFR-M2's
 * two-tier split (first-class vs directory) must be cut from DATA, not vibes —
 * this module produces that data, and AFR-M3's anti-rot gate will reuse it.
 * Zero behaviour change: nothing on the runtime path imports this module; only
 * the report test does.
 *
 * The token estimate is honest-approximate: each tool is serialized to the
 * wire-ish JSON shape ({name, description, input_schema}) and counted with a
 * CJK-aware heuristic (CJK ≈ 1 token/char, the rest ≈ 4 chars/token — butler
 * tool descriptions are mostly Chinese, where bytes/4 would badly undercount).
 * It's a ruler for before/after comparison, not a billing meter.
 */

import type { LlmAgentToolset } from '@gotong/llm'

/** Which side of the butler's tool face a module sits on. */
export type ToolFaceKind = 'benign' | 'governed' | 'memory'

/** One measured module — mirrors a factory builder (or the agent-internal memory set). */
export interface ToolFaceEntry {
  /** Module label, mirroring the factory's builder (e.g. 'observe', 'steward'). */
  module: string
  kind: ToolFaceKind
  toolset: LlmAgentToolset
}

/** One tool's measured footprint. */
export interface ToolFaceRow {
  module: string
  kind: ToolFaceKind
  name: string
  /** UTF-8 bytes of the wire-ish serialized definition. */
  schemaBytes: number
  /** CJK-aware token estimate of the same serialization. */
  estTokens: number
}

/** Per-module rollup (insertion order preserved). */
export interface ToolFaceModuleRollup {
  module: string
  kind: ToolFaceKind
  tools: number
  schemaBytes: number
  estTokens: number
}

export interface ToolFaceReport {
  rows: readonly ToolFaceRow[]
  modules: readonly ToolFaceModuleRollup[]
  totalTools: number
  totalSchemaBytes: number
  totalEstTokens: number
  /** Subtotals by kind — the raw material for AFR-M2's tier cut. */
  byKind: Readonly<Record<ToolFaceKind, { tools: number; estTokens: number }>>
}

/**
 * CJK-aware token estimate: CJK ideographs/fullwidth ≈ 1 token per char,
 * everything else ≈ 4 chars per token. Deliberately simple and deterministic —
 * the report compares BEFORE/AFTER with the same ruler, so the constant factors
 * cancel out of the comparison.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isCjk =
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals … unified ideographs (incl. 3000–303f punctuation)
      (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
      (cp >= 0xff00 && cp <= 0xffef) // fullwidth forms
    if (isCjk) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

const encoder = new TextEncoder()

/** Measure every entry's tools (listTools may be sync or async on a given toolset). */
export async function measureToolFace(entries: readonly ToolFaceEntry[]): Promise<ToolFaceReport> {
  const rows: ToolFaceRow[] = []
  for (const e of entries) {
    const tools = await e.toolset.listTools()
    for (const t of tools) {
      // The Anthropic wire shape a tool definition actually costs on: name +
      // description + input_schema (OpenAI's is isomorphic modulo nesting).
      const wire = JSON.stringify({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })
      rows.push({
        module: e.module,
        kind: e.kind,
        name: t.name,
        schemaBytes: encoder.encode(wire).length,
        estTokens: estimateTokens(wire),
      })
    }
  }

  const modules: ToolFaceModuleRollup[] = []
  const byModule = new Map<string, ToolFaceModuleRollup>()
  for (const e of entries) {
    const roll: ToolFaceModuleRollup = {
      module: e.module,
      kind: e.kind,
      tools: 0,
      schemaBytes: 0,
      estTokens: 0,
    }
    modules.push(roll)
    byModule.set(e.module, roll)
  }
  const byKind: Record<ToolFaceKind, { tools: number; estTokens: number }> = {
    benign: { tools: 0, estTokens: 0 },
    governed: { tools: 0, estTokens: 0 },
    memory: { tools: 0, estTokens: 0 },
  }
  let totalSchemaBytes = 0
  let totalEstTokens = 0
  for (const r of rows) {
    const roll = byModule.get(r.module)
    if (roll) {
      roll.tools++
      roll.schemaBytes += r.schemaBytes
      roll.estTokens += r.estTokens
    }
    byKind[r.kind].tools++
    byKind[r.kind].estTokens += r.estTokens
    totalSchemaBytes += r.schemaBytes
    totalEstTokens += r.estTokens
  }

  return {
    rows,
    modules,
    totalTools: rows.length,
    totalSchemaBytes,
    totalEstTokens,
    byKind,
  }
}

/** Render the report as a plain-text table (the pnpm report script prints this). */
export function renderToolFaceReport(report: ToolFaceReport): string {
  const lines: string[] = []
  lines.push('=== 阿同工具面基线(AFR-M1)===')
  lines.push('kind      module            tool                        bytes  ~tokens')
  for (const r of report.rows) {
    lines.push(
      `${r.kind.padEnd(9)} ${r.module.padEnd(17)} ${r.name.padEnd(27)} ${String(r.schemaBytes).padStart(5)}  ${String(r.estTokens).padStart(6)}`,
    )
  }
  lines.push('---- 按模块 ----')
  for (const m of report.modules) {
    lines.push(
      `${m.module.padEnd(17)} (${m.kind})  ${m.tools} tools  ${m.schemaBytes} bytes  ~${m.estTokens} tokens`,
    )
  }
  lines.push('---- 合计 ----')
  lines.push(
    `tools=${report.totalTools}  bytes=${report.totalSchemaBytes}  ~tokens=${report.totalEstTokens}`,
  )
  const k = report.byKind
  lines.push(
    `kind 小计: benign=${k.benign.tools} 工具/~${k.benign.estTokens}tk  governed=${k.governed.tools} 工具/~${k.governed.estTokens}tk  memory=${k.memory.tools} 工具/~${k.memory.estTokens}tk`,
  )
  lines.push(
    '注:MCP 连接器 `<server>__<tool>` 与 pool base 工具随部署变化,基线按 0 计(装了连接器只会更大)。',
  )
  return lines.join('\n')
}
