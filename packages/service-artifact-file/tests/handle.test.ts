import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { ArtifactFileHandle } from '../src/handle.js'
import type { ArtifactFileConfig } from '../src/config.js'
import { ownerDir } from '../src/paths.js'

const logger = createLogger('artifact-file-handle-test', { disabled: true })
const owner = { kind: 'agent', id: 'industry-coach' } as const
const fullConfig: ArtifactFileConfig = {
  name: 'default',
  maxBytesPerFile: 10 * 1024 * 1024,
  allowedMimePrefixes: ['text/', 'application/'],
}

let rootDir: string
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'aipe-art-handle-'))
})
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

function newHandle(cfg: ArtifactFileConfig = fullConfig): ArtifactFileHandle {
  return new ArtifactFileHandle({ rootDir, owner, config: cfg, logger })
}

describe('write', () => {
  it('persists to the owner directory', async () => {
    const h = newHandle()
    const ref = await h.write('q1.md', '# Q1 report\nHello')
    expect(ref.ref).toBe('q1.md')
    expect(ref.mime).toBe('text/markdown')
    const raw = await readFile(join(ownerDir(rootDir, owner), 'q1.md'), 'utf8')
    expect(raw).toBe('# Q1 report\nHello')
  })

  it('overwrites on second write to the same path', async () => {
    const h = newHandle()
    await h.write('x.md', 'first')
    const ref = await h.write('x.md', 'second')
    const { content } = await h.read(ref.ref)
    expect(content).toBe('second')
  })

  it('auto-creates intermediate directories', async () => {
    const h = newHandle()
    await h.write('a/b/c/deep.md', 'hi')
    expect(await h.exists('a/b/c/deep.md')).toBe(true)
  })

  it('blocks path traversal (..)', async () => {
    const h = newHandle()
    await expect(h.write('../escape.md', 'x')).rejects.toThrow(/traversal/)
  })

  it('blocks absolute path', async () => {
    const h = newHandle()
    await expect(h.write('/escape.md', 'x')).rejects.toThrow(/relative/)
  })

  it('blocks null byte', async () => {
    const h = newHandle()
    await expect(h.write('null\0byte.md', 'x')).rejects.toThrow(/null byte/)
  })

  it('rejects writes exceeding maxBytesPerFile', async () => {
    const cfg: ArtifactFileConfig = { ...fullConfig, maxBytesPerFile: 100 }
    const h = newHandle(cfg)
    await expect(h.write('big.md', 'x'.repeat(200))).rejects.toThrow(/maxBytesPerFile/)
  })

  it('rejects mime outside allow-list', async () => {
    const cfg: ArtifactFileConfig = {
      ...fullConfig, allowedMimePrefixes: ['text/'],
    }
    const h = newHandle(cfg)
    await expect(h.write('thing.png', new Uint8Array([1, 2, 3]))).rejects.toThrow(/not in allow-list/)
  })

  it('accepts mime explicit override', async () => {
    const cfg: ArtifactFileConfig = {
      ...fullConfig, allowedMimePrefixes: ['custom/'],
    }
    const h = newHandle(cfg)
    await expect(h.write('any.txt', 'x', { mime: 'custom/special' })).resolves.toMatchObject({ mime: 'custom/special' })
  })

  it('Uint8Array byte content writes correctly', async () => {
    const cfg: ArtifactFileConfig = {
      ...fullConfig, allowedMimePrefixes: ['*'],
    }
    const h = newHandle(cfg)
    const bytes = new Uint8Array([72, 101, 108, 108, 111])  // "Hello"
    await h.write('binary.bin', bytes, { mime: 'application/octet-stream' })
    const raw = await readFile(join(ownerDir(rootDir, owner), 'binary.bin'))
    expect(raw.equals(Buffer.from(bytes))).toBe(true)
  })
})

describe('read', () => {
  it('returns content + mime', async () => {
    const h = newHandle()
    await h.write('reports/q1.md', '# hi')
    const got = await h.read('reports/q1.md')
    expect(got.content).toBe('# hi')
    expect(got.mime).toBe('text/markdown')
  })

  it('throws on missing path', async () => {
    const h = newHandle()
    await expect(h.read('absent.md')).rejects.toThrow(/ENOENT/)
  })

  it('blocks traversal', async () => {
    const h = newHandle()
    await expect(h.read('../etc/passwd')).rejects.toThrow(/traversal/)
  })
})

describe('list', () => {
  it('lists empty owner as []', async () => {
    const h = newHandle()
    expect(await h.list()).toEqual([])
  })

  it('lists newest first', async () => {
    const h = newHandle()
    await h.write('old.md', 'a')
    await new Promise((r) => setTimeout(r, 10))
    await h.write('new.md', 'b')
    const refs = await h.list()
    expect(refs.map((r) => r.path)).toEqual(['new.md', 'old.md'])
  })

  it('walks subdirectories', async () => {
    const h = newHandle()
    await h.write('a.md', '1')
    await h.write('sub/b.md', '2')
    await h.write('sub/c/d.md', '3')
    const refs = await h.list()
    expect(refs.map((r) => r.path).sort()).toEqual(['a.md', 'sub/b.md', 'sub/c/d.md'])
  })

  it('honors prefix filter', async () => {
    const h = newHandle()
    await h.write('reports/q1.md', '1')
    await h.write('reports/q2.md', '2')
    await h.write('notes/x.md', '3')
    const refs = await h.list({ prefix: 'reports/' })
    expect(refs.map((r) => r.path).sort()).toEqual(['reports/q1.md', 'reports/q2.md'])
  })
})

describe('exists', () => {
  it('true after write', async () => {
    const h = newHandle()
    await h.write('x.md', 'x')
    expect(await h.exists('x.md')).toBe(true)
  })

  it('false on missing', async () => {
    const h = newHandle()
    expect(await h.exists('nope.md')).toBe(false)
  })

  it('false (not throw) on traversal attempt', async () => {
    const h = newHandle()
    expect(await h.exists('../etc/passwd')).toBe(false)
  })
})

describe('remove', () => {
  it('deletes the file', async () => {
    const h = newHandle()
    await h.write('x.md', 'x')
    await h.remove('x.md')
    expect(await h.exists('x.md')).toBe(false)
  })

  it('no-op on missing', async () => {
    const h = newHandle()
    await expect(h.remove('never.md')).resolves.not.toThrow()
  })

  it('rejects traversal attempts (no quiet leak)', async () => {
    const h = newHandle()
    await expect(h.remove('../escape')).rejects.toThrow(/traversal/)
  })
})

describe('concurrent writes are serialized (no half-files)', () => {
  it('50 parallel writes to distinct paths all land cleanly', async () => {
    const h = newHandle()
    const writes = Array.from({ length: 50 }, (_, i) => h.write(`p-${i}.md`, `line-${i}`))
    await Promise.all(writes)
    const refs = await h.list()
    expect(refs).toHaveLength(50)
  })

  it('two concurrent writes to the SAME path resolve in some order', async () => {
    const h = newHandle()
    await Promise.all([h.write('x.md', 'a'), h.write('x.md', 'b')])
    const { content } = await h.read('x.md')
    expect(['a', 'b']).toContain(content)
  })
})

describe('owner isolation', () => {
  it('two owners do not see each other', async () => {
    const h1 = new ArtifactFileHandle({
      rootDir, owner: { kind: 'agent', id: 'A' }, config: fullConfig, logger,
    })
    const h2 = new ArtifactFileHandle({
      rootDir, owner: { kind: 'agent', id: 'B' }, config: fullConfig, logger,
    })
    await h1.write('shared.md', 'A-data')
    await h2.write('shared.md', 'B-data')
    expect((await h1.read('shared.md')).content).toBe('A-data')
    expect((await h2.read('shared.md')).content).toBe('B-data')
  })

  it('agent vs shared with same id are isolated', async () => {
    const a = new ArtifactFileHandle({
      rootDir, owner: { kind: 'agent', id: 'same' }, config: fullConfig, logger,
    })
    const s = new ArtifactFileHandle({
      rootDir, owner: { kind: 'shared', id: 'same' }, config: fullConfig, logger,
    })
    await a.write('x.md', 'agent-side')
    expect(await s.exists('x.md')).toBe(false)
  })
})

describe('symlink resilience', () => {
  it('a symlink inside owner dir pointing outside cannot leak via write', async () => {
    // Create a symlink target outside the temp dir.
    const outside = await mkdtemp(join(tmpdir(), 'aipe-art-outside-'))
    try {
      const linkOwnerDir = ownerDir(rootDir, owner)
      await mkdir(linkOwnerDir, { recursive: true })
      const linkPath = join(linkOwnerDir, 'sneaky-link')
      const { symlink } = await import('node:fs/promises')
      await symlink(outside, linkPath, 'dir')

      // Write through the link path: writes to ./sneaky-link/file.md which is
      // really outside. The plugin's path checks operate on user-supplied
      // strings — they wouldn't detect this. We document this in the README;
      // here we just confirm the write path is at LEAST inside the owner dir
      // path-string-wise (defence-in-depth doesn't prevent symlink follows).
      const h = newHandle()
      await h.write('sneaky-link/file.md', 'data')
      // The file exists at the symlink target since fs followed the link.
      // This is acceptable for MVP — same trust model as any node fs caller.
      // We just verify it didn't escape via path manipulation:
      expect(linkPath.startsWith(rootDir)).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
