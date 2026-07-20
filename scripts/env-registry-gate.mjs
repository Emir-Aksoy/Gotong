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
 *
 * Two precision rules keep the headline number honest — it is quoted in every
 * milestone ledger entry ("旋钮 N 零新增"), and an FDE reads it as "how many
 * things can change how this deployment behaves":
 *
 *   1. COMMENTS DON'T COUNT. A name that appears only in prose is not part of
 *      the surface. Three used to inflate the count: `GOTONG_A2A_AGENTS` (an
 *      env blob DELETED in Route-B P1-M11b, still named in "replaces the old…"
 *      comments), `GOTONG_WS_HARDENING_PROFILE` (aspirational, never read), and
 *      `GOTONG_MASTER_KEY_` (a `GOTONG_MASTER_KEY_*` wildcard fragment).
 *      Stripping comments before the scan also keeps the gate's teeth: every
 *      real reference — `process.env.X`, a `'GOTONG_X'` string argument, a
 *      disclosure array — is code, so it is still caught.
 *
 *   2. `# not-a-knob:` MARKS THE LOOK-ALIKES. A few `GOTONG_*` literals are in
 *      code but are not environment variables of this hub (HTML placeholders,
 *      shell examples in help text, env vars belonging to *generated* scaffold
 *      files). They stay pinned — the gate still fails if one appears or
 *      vanishes unannounced — but they are counted separately, so the headline
 *      number means "knobs an operator can actually set".
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

/**
 * Blank out `//` and `/* *\/` comments, leaving string literals intact.
 *
 * A regex can't do this: `'https://x'` contains `//`, and a knob name inside a
 * template literal is real code. So walk the file with a 6-state machine
 * (code / line / block / '…' / "…" / `…`). Whitespace replaces comment bytes
 * rather than deleting them, so nothing downstream shifts.
 */
function stripComments(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length;) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') state = c
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++; continue
    }
    // inside a string literal: honour escapes so `\'` doesn't close it early
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === state) state = 'code'
    out += c; i++
  }
  return out
}

/** The authoritative code-referenced knob set (comments excluded — rule 1). */
function codeKnobs() {
  const set = new Set()
  for (const f of collectSrcFiles()) {
    const text = stripComments(readFileSync(f, 'utf8'))
    for (const m of text.matchAll(KNOB_RE)) set.add(m[0])
  }
  return set
}

/**
 * Registered set, plus the subset tagged `# not-a-knob:` (rule 2). Both are
 * needed: the gate compares the FULL set against code, and reports the
 * difference as the operator-facing knob count.
 */
function registeredKnobs() {
  if (!existsSync(REGISTRY)) return null
  const all = new Set()
  const notKnobs = new Set()
  for (const raw of readFileSync(REGISTRY, 'utf8').split('\n')) {
    const name = raw.replace(/#.*$/, '').trim()
    if (!name) continue
    all.add(name)
    if (/#\s*not-a-knob:/.test(raw)) notKnobs.add(name)
  }
  return { all, notKnobs }
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

  const unregistered = sorted(code).filter((k) => !registered.all.has(k)) // in code, not registered
  const stale = sorted(registered.all).filter((k) => !code.has(k)) // registered, not in code

  if (unregistered.length === 0 && stale.length === 0) {
    const knobs = code.size - registered.notKnobs.size
    console.log(
      `PASS env-registry-gate: ${knobs} GOTONG_* knobs, all registered, none stale.` +
      ` (+${registered.notKnobs.size} pinned look-alikes that are not env vars: ` +
      `${sorted(registered.notKnobs).join(', ')})`,
    )
    return
  }

  console.error(`FAIL env-registry-gate: code set (${code.size}) ≠ registry set (${registered.all.size})`)
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
