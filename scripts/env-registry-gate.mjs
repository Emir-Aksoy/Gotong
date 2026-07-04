#!/usr/bin/env node
/**
 * env-registry-gate — GUARD-M1. A load-bearing gate against silent knob sprawl.
 *
 * 缺口 2 called out "~107 个 GOTONG_*" as the ease-of-use regression: every new
 * env knob is a hidden way the system can behave differently, and nothing forced
 * them to be written down. This gate pins the set. It extracts every `GOTONG_*`
 * literal referenced in the src tree of every package (source only, tests
 * excluded) and asserts it equals the set registered in
 * `scripts/gotong-env-registry.txt`.
 *
 *   - Add a knob to code without registering it  → gate goes red (the point).
 *   - Delete a knob but leave it in the registry → gate goes red (stay honest).
 *
 * So knob #125 cannot land silently — you must consciously edit the registry,
 * which is exactly the friction that keeps the surface from creeping.
 *
 *   node scripts/env-registry-gate.mjs           # check (exit 0/1)
 *   node scripts/env-registry-gate.mjs --list     # print the current code set (seeds the registry)
 *
 * The `--list` output IS the registry's source of truth: the registry file is
 * seeded from it, so the gate and the file agree by construction. Only static
 * `GOTONG_FOO` literals are seen (there are no dynamically-built knob names in the
 * tree — verified); if that ever changes, add the constructed names to the
 * registry with a `# dynamic:` note.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PACKAGES = join(REPO, 'packages')
const REGISTRY = join(HERE, 'gotong-env-registry.txt')

const KNOB_RE = /GOTONG_[A-Z0-9_]+/g

/** Recursively collect every `.ts` under each `<pkg>/src` (source only — tests/fixtures excluded). */
function collectSrcFiles() {
  const out = []
  for (const pkg of readdirSync(PACKAGES)) {
    const srcDir = join(PACKAGES, pkg, 'src')
    if (!existsSync(srcDir)) continue
    walk(srcDir, out)
  }
  return out
}
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
}

/** The authoritative code-referenced knob set. */
function codeKnobs() {
  const set = new Set()
  for (const f of collectSrcFiles()) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(KNOB_RE)) set.add(m[0])
  }
  return set
}

/** Registered knob set: non-comment, non-blank lines of the registry. */
function registeredKnobs() {
  if (!existsSync(REGISTRY)) return null
  const set = new Set()
  for (const raw of readFileSync(REGISTRY, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line) set.add(line)
  }
  return set
}

const sorted = (s) => [...s].sort()

function main() {
  const code = codeKnobs()

  if (process.argv.includes('--list')) {
    for (const k of sorted(code)) console.log(k)
    return
  }

  const registered = registeredKnobs()
  if (registered === null) {
    console.error(`FAIL env-registry-gate: registry missing at ${REGISTRY}`)
    console.error(`Seed it:  node scripts/env-registry-gate.mjs --list > scripts/gotong-env-registry.txt`)
    process.exit(1)
  }

  const unregistered = sorted(code).filter((k) => !registered.has(k)) // in code, not registered
  const stale = sorted(registered).filter((k) => !code.has(k)) // registered, not in code

  if (unregistered.length === 0 && stale.length === 0) {
    console.log(`PASS env-registry-gate: ${code.size} GOTONG_* knobs, all registered, none stale.`)
    return
  }

  console.error(`FAIL env-registry-gate: code set (${code.size}) ≠ registry set (${registered.size})`)
  if (unregistered.length) {
    console.error(`\n  ${unregistered.length} knob(s) referenced in code but NOT in the registry:`)
    for (const k of unregistered) console.error(`    + ${k}`)
    console.error(`  → a new knob must be registered in scripts/gotong-env-registry.txt (that's the guard).`)
  }
  if (stale.length) {
    console.error(`\n  ${stale.length} knob(s) in the registry but NOT referenced in code (stale):`)
    for (const k of stale) console.error(`    - ${k}`)
    console.error(`  → remove it from the registry, or restore its use.`)
  }
  console.error(`\n  Re-seed after a deliberate change:  node scripts/env-registry-gate.mjs --list > scripts/gotong-env-registry.txt`)
  process.exit(1)
}

main()
