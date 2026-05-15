/**
 * End-to-end CLI tests — invoke `runCli` programmatically and check
 * its return code + side effects on a tmp directory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../src/main.js'

describe('runCli', () => {
  let cwd: string | null = null
  let cwdBefore: string

  afterEach(async () => {
    if (cwd) {
      process.chdir(cwdBefore)
      await rm(cwd, { recursive: true, force: true })
      cwd = null
    }
  })

  async function newCwd(): Promise<string> {
    cwdBefore = process.cwd()
    cwd = await mkdtemp(join(tmpdir(), 'aipehub-cli-'))
    process.chdir(cwd)
    return cwd
  }

  it('help with no args returns 0', async () => {
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runCli([])
    expect(code).toBe(0)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('rejects unknown command with code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runCli(['wat'])
    expect(code).toBe(2)
    err.mockRestore()
    out.mockRestore()
  })

  it('`new agent` scaffolds a TypeScript project', async () => {
    await newCwd()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['new', 'agent', 'demo-agent', '--capabilities=draft,review'])
    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(cwd!, 'demo-agent', 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
    }
    expect(pkg.name).toBe('demo-agent')
    expect(pkg.dependencies['@aipehub/sdk-node']).toBeDefined()
    const src = await readFile(join(cwd!, 'demo-agent', 'src', 'index.ts'), 'utf8')
    expect(src).toContain('class DemoAgentAgent extends AgentParticipant')
    expect(src).toContain('capabilities: ["draft","review"]')
    log.mockRestore()
  })

  it('`new python-agent` scaffolds a Python project', async () => {
    await newCwd()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['new', 'python-agent', 'py-classify'])
    expect(code).toBe(0)
    const pyproject = await readFile(join(cwd!, 'py-classify', 'pyproject.toml'), 'utf8')
    expect(pyproject).toContain('name = "py-classify"')
    expect(pyproject).toContain('py_classify = "py_classify.agent:main"')
    const src = await readFile(join(cwd!, 'py-classify', 'src', 'agent.py'), 'utf8')
    expect(src).toContain('class PyClassifyAgent(AgentParticipant)')
    log.mockRestore()
  })

  it('rejects invalid agent names', async () => {
    await newCwd()
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['new', 'agent', 'Bad Name!'])
    expect(code).toBe(2)
    err.mockRestore()
  })

  it('rejects duplicate target dir', async () => {
    await newCwd()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['new', 'agent', 'twice'])).toBe(0)
    expect(await runCli(['new', 'agent', 'twice'])).toBe(1)
    log.mockRestore()
    err.mockRestore()
  })

  it('ping rejects non-ws urls', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['ping', 'http://localhost'])).toBe(2)
    err.mockRestore()
  })
})
