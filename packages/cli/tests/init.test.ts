import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { init } from '../src/commands/init.js'

function tmpSpace(): string {
  return join(tmpdir(), `aipehub-init-test-${randomBytes(6).toString('hex')}`)
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* noop */ }
  }
  dirs.length = 0
})

describe('aipehub init', () => {
  it('creates workspace with default settings', async () => {
    const dir = tmpSpace()
    dirs.push(dir)
    const code = await init([`--space-dir=${dir}`])
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'space.json'))).toBe(true)
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
    expect(existsSync(join(dir, 'runtime'))).toBe(true)
    expect(existsSync(join(dir, 'services'))).toBe(true)

    const space = JSON.parse(await readFile(join(dir, 'space.json'), 'utf8'))
    expect(space.name).toBe('AipeHub')
    expect(space.hubId).toMatch(/^hub_[a-f0-9]{8}$/)
  })

  it('creates admin when --admin-name is provided', async () => {
    const dir = tmpSpace()
    dirs.push(dir)
    const code = await init([`--space-dir=${dir}`, '--admin-name=Alice'])
    expect(code).toBe(0)

    const admins = JSON.parse(await readFile(join(dir, 'admins.json'), 'utf8'))
    expect(admins.admins).toHaveLength(1)
    expect(admins.admins[0].displayName).toBe('Alice')
  })

  it('defaults admin name to Operator', async () => {
    const dir = tmpSpace()
    dirs.push(dir)
    await init([`--space-dir=${dir}`])

    const admins = JSON.parse(await readFile(join(dir, 'admins.json'), 'utf8'))
    expect(admins.admins[0].displayName).toBe('Operator')
  })

  it('refuses to init over existing workspace', async () => {
    const dir = tmpSpace()
    dirs.push(dir)
    await init([`--space-dir=${dir}`])
    const code = await init([`--space-dir=${dir}`])
    expect(code).toBe(1)
  })

  it('returns 2 on --help', async () => {
    const code = await init(['--help'])
    expect(code).toBe(2)
  })

  it('returns 2 on unknown option', async () => {
    const code = await init(['--bogus'])
    expect(code).toBe(2)
  })

  it('--pin-team writes team config', async () => {
    const dir = tmpSpace()
    dirs.push(dir)
    await init([`--space-dir=${dir}`, '--pin-team'])

    const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    expect(config.orgMode).toBe('team')
  })
})
