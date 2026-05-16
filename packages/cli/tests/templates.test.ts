/**
 * Template generator tests. We don't shell out to `aipehub new` here —
 * `templates/{ts,py}-agent.ts` are pure functions, so we can assert on
 * the rendered strings directly. The fs side of `new-agent.ts` is
 * exercised by hand in CI when needed.
 */

import { describe, expect, it } from 'vitest'

import { renderTsTemplate } from '../src/templates/ts-agent.js'
import { renderPyTemplate } from '../src/templates/py-agent.js'

describe('ts-agent template', () => {
  it('drops the agent id and capabilities into the source', () => {
    const out = renderTsTemplate({
      name: 'coach',
      id: 'coach-1',
      capabilities: 'draft,review',
      includeServices: true,
    })
    expect(out.source).toContain("super({ id: \"coach-1\", capabilities: [\"draft\",\"review\"] })")
    // Class name is pascalCased from the project name.
    expect(out.source).toContain('class CoachAgent')
    // Services declaration appears.
    expect(out.source).toContain("services: [")
    expect(out.source).toContain("kind: 'agent', id: 'self'")
  })

  it('omits services scaffolding under --no-services', () => {
    const out = renderTsTemplate({
      name: 'logger',
      id: 'logger',
      capabilities: 'log',
      includeServices: false,
    })
    expect(out.source).not.toContain('services: [')
    expect(out.source).not.toContain('ServiceClient')
  })

  it('emits a valid package.json with sdk-node as a dep', () => {
    const out = renderTsTemplate({
      name: 'echo',
      id: 'echo',
      capabilities: 'echo',
      includeServices: true,
    })
    const pkg = JSON.parse(out.packageJson) as { dependencies?: Record<string, string>, bin?: unknown }
    expect(pkg.dependencies?.['@aipehub/sdk-node']).toMatch(/^[\^~]?\d/)
  })

  it('handles single-word names cleanly (no empty splits)', () => {
    const out = renderTsTemplate({
      name: 'a',
      id: 'a',
      capabilities: 'x',
      includeServices: true,
    })
    expect(out.source).toContain('class AAgent')
  })
})

describe('py-agent template', () => {
  it('renders module name with underscores, class name PascalCase', () => {
    const out = renderPyTemplate({
      name: 'industry-coach',
      id: 'industry-coach',
      capabilities: 'draft',
      includeServices: true,
    })
    expect(out.source).toContain('class IndustryCoachAgent')
    expect(out.pyproject).toContain('industry_coach = "industry_coach.agent:main"')
    expect(out.pyproject).toContain('packages = ["src/industry_coach"]')
  })

  it('includes ServiceUseRequest import when services are on', () => {
    const out = renderPyTemplate({
      name: 'mem',
      id: 'mem',
      capabilities: 'noop',
      includeServices: true,
    })
    expect(out.source).toContain('ServiceUseRequest')
    expect(out.source).toContain('services=[')
  })

  it('drops services scaffolding under --no-services', () => {
    const out = renderPyTemplate({
      name: 'plain',
      id: 'plain',
      capabilities: 'noop',
      includeServices: false,
    })
    expect(out.source).not.toContain('services=[')
    expect(out.source).not.toContain('ServiceUseRequest')
  })

  it('depends on aipehub >=1.1 (Python SDK with services)', () => {
    const out = renderPyTemplate({
      name: 'p',
      id: 'p',
      capabilities: 'x',
      includeServices: true,
    })
    expect(out.pyproject).toMatch(/aipehub>=1\.1/)
  })

  it('emits __init__.py and __main__.py for `python -m <pkg>` to work', () => {
    const out = renderPyTemplate({
      name: 'demo',
      id: 'demo',
      capabilities: 'noop',
      includeServices: false,
    })
    // __init__ re-exports main from agent.py so callers can also import
    // the package programmatically.
    expect(out.initPy).toContain('from .agent import main')
    expect(out.initPy).toContain('__all__ = ["main"]')
    // __main__ is the file `python -m demo` actually executes.
    expect(out.mainPy).toContain('from .agent import main')
    expect(out.mainPy).toContain('main()')
  })
})
