#!/usr/bin/env node
/**
 * kernel-deps-gate — GUARD-M1. A load-bearing gate on the kernel's dependency
 * direction. Reads each package's `dependencies` and asserts the arrows that
 * make AipeHub's core clean (CLAUDE.md 缺口 2: "protocol 零依赖 → core →
 * workflow / inbox, 依赖方向正确"). It fails the moment someone adds an edge
 * that inverts the graph — a hub package reaching up into the assembly layer,
 * the wire root growing a dependency, the workflow runner pulling in an LLM.
 *
 * Only `dependencies` (the runtime graph) are checked; devDependencies (build
 * tooling) don't define architecture. Names are compared with the `@aipehub/`
 * prefix stripped.
 *
 *   node scripts/kernel-deps-gate.mjs      # exit 0 clean / 1 on any violation
 *
 * Each rule is an invariant, not a snapshot: it says what an edge is ALLOWED /
 * FORBIDDEN to be, so refactors that keep the direction pass, and only genuine
 * inversions go red.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** The assembly / entry layer — nothing in the kernel may depend on these. */
const ASSEMBLY = ['host', 'web', 'cli']
/** The kernel packages that must never reach up into the assembly layer. */
const KERNEL = ['protocol', 'core', 'workflow', 'inbox', 'a2a']

/**
 * Per-package invariants. `allowExactly` / `allowSubsetOf` bound the @aipehub
 * deps; `forbid` names edges that must never appear. Omitted fields = unchecked.
 */
const RULES = [
  // The wire root: zero @aipehub dependencies, forever. Everything points AT it.
  { pkg: 'protocol', allowExactly: [] },
  // Core sees only the wire types — never a leaf, never the assembly layer.
  { pkg: 'core', allowSubsetOf: ['protocol'] },
  // Leaves that must stay thin: only core (+ protocol transitively).
  { pkg: 'inbox', allowSubsetOf: ['core', 'protocol'] },
  { pkg: 'a2a', allowSubsetOf: ['core', 'protocol'] },
  // The workflow runner is deliberately LLM-free — the framework never runs a
  // model (north star #1). Depending on an llm package would break that.
  {
    pkg: 'workflow',
    allowSubsetOf: ['core', 'protocol'],
    forbid: ['llm', 'llm-openai', 'llm-anthropic', 'workflow-assistant'],
  },
  // Surface-pattern invariant (see docs/zh/SURFACE-PATTERN.md): the web layer
  // consumes host capabilities as injected duck-typed surfaces and must never
  // gain a runtime dependency on host.
  { pkg: 'web', forbid: ['host'] },
]

function aipehubDeps(pkg) {
  const p = join(REPO, 'packages', pkg, 'package.json')
  if (!existsSync(p)) return { missing: true, deps: [] }
  const json = JSON.parse(readFileSync(p, 'utf8'))
  const deps = Object.keys(json.dependencies ?? {})
    .filter((k) => k.startsWith('@aipehub/'))
    .map((k) => k.slice('@aipehub/'.length))
    .sort()
  return { missing: false, deps }
}

function main() {
  const violations = []

  for (const rule of RULES) {
    const { pkg } = rule
    const { missing, deps } = aipehubDeps(pkg)
    if (missing) {
      violations.push(`${pkg}: package.json not found (stale rule in kernel-deps-gate?)`)
      continue
    }
    if (rule.allowExactly) {
      const extra = deps.filter((d) => !rule.allowExactly.includes(d))
      if (extra.length) violations.push(`${pkg}: must have exactly [${rule.allowExactly.join(', ') || '∅'}] @aipehub deps, but also has [${extra.join(', ')}]`)
    }
    if (rule.allowSubsetOf) {
      const extra = deps.filter((d) => !rule.allowSubsetOf.includes(d))
      if (extra.length) violations.push(`${pkg}: may only depend on [${rule.allowSubsetOf.join(', ')}], but reaches [${extra.join(', ')}]`)
    }
    if (rule.forbid) {
      const bad = deps.filter((d) => rule.forbid.includes(d))
      if (bad.length) violations.push(`${pkg}: forbidden dependency [${bad.join(', ')}] — this edge inverts the architecture`)
    }
  }

  // Global rule: no kernel package may depend on the assembly / entry layer.
  for (const pkg of KERNEL) {
    const { missing, deps } = aipehubDeps(pkg)
    if (missing) continue
    const up = deps.filter((d) => ASSEMBLY.includes(d))
    if (up.length) violations.push(`${pkg} (kernel) depends on assembly layer [${up.join(', ')}] — the arrow must point the other way`)
  }

  if (violations.length === 0) {
    console.log(`PASS kernel-deps-gate: ${RULES.length} package invariants + kernel↛assembly rule hold.`)
    return
  }

  console.error(`FAIL kernel-deps-gate: ${violations.length} dependency-direction violation(s):`)
  for (const v of violations) console.error(`  ✗ ${v}`)
  console.error(`\n  The kernel's clean direction is load-bearing (CLAUDE.md 缺口 2). If an edge is`)
  console.error(`  genuinely intended, update the rule in scripts/kernel-deps-gate.mjs deliberately.`)
  process.exit(1)
}

main()
