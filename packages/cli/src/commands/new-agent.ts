/**
 * `aipehub new agent <name>` / `aipehub new python-agent <name>`.
 *
 * Scaffolds a self-contained sidecar agent project under `<cwd>/<name>/`.
 * Writes a minimal `package.json` (or `pyproject.toml`) + one source
 * file + a README pointing at `docs/SIDECAR.md`.
 *
 * The generated project deliberately depends on the **published** SDK
 * (not workspace:*) so it works outside the AipeHub monorepo. We do
 * NOT run `npm install` for the user — the README tells them how.
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { renderTsTemplate } from '../templates/ts-agent.js'
import { renderPyTemplate } from '../templates/py-agent.js'

export interface NewAgentOpts {
  language: 'ts' | 'py'
  args: readonly string[]
}

interface ParsedOpts {
  name: string
  id: string
  capabilities: string
  includeServices: boolean
}

export async function newAgent(opts: NewAgentOpts): Promise<number> {
  const parsed = parseArgs(opts.args)
  if (!parsed) return 2

  const target = resolve(process.cwd(), parsed.name)
  if (await pathExists(target)) {
    console.error(`[aipehub] target directory already exists: ${target}`)
    return 1
  }
  await mkdir(target, { recursive: true })

  if (opts.language === 'ts') {
    const out = renderTsTemplate(parsed)
    await mkdir(join(target, 'src'), { recursive: true })
    await writeFile(join(target, 'package.json'), out.packageJson, 'utf8')
    await writeFile(join(target, 'tsconfig.json'), out.tsconfig, 'utf8')
    await writeFile(join(target, 'src', 'index.ts'), out.source, 'utf8')
    await writeFile(join(target, 'README.md'), out.readme, 'utf8')
    await writeFile(join(target, '.gitignore'), 'node_modules\ndist\n', 'utf8')
    console.log(`✓ created TypeScript sidecar at ${target}`)
    console.log(`  next: cd ${parsed.name} && npm install && npm start`)
  } else {
    const out = renderPyTemplate(parsed)
    const modName = parsed.name.replace(/-/g, '_')
    // Hatchling's `packages = ["src/<modName>"]` (see py-agent template)
    // expects the source under `src/<modName>/`, NOT under `src/`. Writing
    // `src/agent.py` made `pip install -e .` fail with "package not found".
    await mkdir(join(target, 'src', modName), { recursive: true })
    await writeFile(join(target, 'pyproject.toml'), out.pyproject, 'utf8')
    await writeFile(join(target, 'src', modName, '__init__.py'), out.initPy, 'utf8')
    await writeFile(join(target, 'src', modName, '__main__.py'), out.mainPy, 'utf8')
    await writeFile(join(target, 'src', modName, 'agent.py'), out.source, 'utf8')
    await writeFile(join(target, 'README.md'), out.readme, 'utf8')
    await writeFile(join(target, '.gitignore'), '__pycache__\n.venv\n*.egg-info\n', 'utf8')
    console.log(`✓ created Python sidecar at ${target}`)
    console.log(`  next: cd ${parsed.name} && python -m venv .venv && .venv/bin/pip install -e . && .venv/bin/python -m ${modName}`)
  }
  return 0
}

function parseArgs(args: readonly string[]): ParsedOpts | null {
  const positional: string[] = []
  let id: string | undefined
  let capabilities = 'noop'
  let includeServices = true
  for (const arg of args) {
    if (arg === '--no-services') {
      includeServices = false
    } else if (arg.startsWith('--id=')) {
      id = arg.slice('--id='.length)
    } else if (arg.startsWith('--capabilities=')) {
      capabilities = arg.slice('--capabilities='.length)
    } else if (arg.startsWith('--')) {
      console.error(`[aipehub] unknown option: ${arg}`)
      return null
    } else {
      positional.push(arg)
    }
  }
  const name = positional[0]
  if (!name) {
    console.error('[aipehub] missing <name> argument')
    return null
  }
  // Light validation — npm package names accept hyphens / lowercase /
  // digits. Reject upper-case / spaces / shell metacharacters early
  // so the user gets a useful error before npm does.
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`[aipehub] invalid name '${name}': use lowercase letters, digits, and hyphens`)
    return null
  }
  return { name, id: id ?? name, capabilities, includeServices }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}
