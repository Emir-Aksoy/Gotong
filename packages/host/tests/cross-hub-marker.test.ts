/**
 * WFEDIT-S1 — unit tests for the sticky cross-hub marker store. File-first,
 * monotonic union, best-effort reads. No Hub, no versioning.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileCrossHubMarkerStore } from '../src/cross-hub-marker.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aipe-xhub-marker-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const markerFile = (id: string) => join(root, 'workflows', 'cross-hub', `${id}.json`)

describe('FileCrossHubMarkerStore', () => {
  it('returns [] for an unknown workflow', async () => {
    const store = new FileCrossHubMarkerStore(root)
    expect(await store.get('nope')).toEqual([])
  })

  it('merge then get returns the canonical (deduped + sorted) set', async () => {
    const store = new FileCrossHubMarkerStore(root)
    await store.merge('flow', ['supplier.express', 'supplier.confirm-order', 'supplier.express'])
    expect(await store.get('flow')).toEqual(['supplier.confirm-order', 'supplier.express'])
  })

  it('is monotonic — a later merge unions in, never shrinks', async () => {
    const store = new FileCrossHubMarkerStore(root)
    await store.merge('flow', ['a'])
    await store.merge('flow', ['b'])
    expect(await store.get('flow')).toEqual(['a', 'b'])
    // Merging a subset (or stale set) never drops what's recorded.
    await store.merge('flow', ['a'])
    expect(await store.get('flow')).toEqual(['a', 'b'])
  })

  it('treats an empty merge as a no-op and writes no file', async () => {
    const store = new FileCrossHubMarkerStore(root)
    await store.merge('flow', [])
    expect(await store.get('flow')).toEqual([])
    // No file should have been created for an empty merge.
    await expect(readFile(markerFile('flow'), 'utf8')).rejects.toThrow()
  })

  it('survives a corrupt marker file (reads as unknown, never throws)', async () => {
    await mkdir(join(root, 'workflows', 'cross-hub'), { recursive: true })
    await writeFile(markerFile('flow'), '{ not valid json', 'utf8')
    const store = new FileCrossHubMarkerStore(root)
    expect(await store.get('flow')).toEqual([])
    // A corrupt file doesn't block a fresh merge.
    await store.merge('flow', ['c'])
    expect(await store.get('flow')).toEqual(['c'])
  })

  it('persists across store instances (file-backed)', async () => {
    await new FileCrossHubMarkerStore(root).merge('flow', ['supplier.confirm-order'])
    const reopened = new FileCrossHubMarkerStore(root)
    expect(await reopened.get('flow')).toEqual(['supplier.confirm-order'])
  })

  it('keeps a path-unsafe workflow id from escaping the marker dir', async () => {
    const store = new FileCrossHubMarkerStore(root)
    await store.merge('../../etc/passwd', ['x'])
    // The sanitized file lives under the marker dir; nothing was written outside.
    expect(await store.get('../../etc/passwd')).toEqual(['x'])
    await expect(readFile(join(root, '..', '..', 'etc', 'passwd'), 'utf8')).rejects.toThrow()
  })
})
