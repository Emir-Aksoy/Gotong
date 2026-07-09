/**
 * A3 成员语言偏好 — pin the language the butler replies in.
 *
 * Pins: (1) the card injects only while a preference is set (empty/missing →
 * null → byte-identical prompt); (2) the set_reply_language tool writes / clears
 * the pref file and length-caps a runaway value; (3) file I/O tolerates missing
 * / corrupt / empty.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildButlerLanguageProbe,
  buildButlerLanguageToolset,
  buildLanguageCard,
  readReplyLanguage,
  writeReplyLanguage,
} from '../src/personal-butler-language.js'

describe('buildLanguageCard', () => {
  it('names the pinned language and tells the model to hold it', () => {
    const card = buildLanguageCard('中文')
    expect(card).toContain('用「中文」回复')
    expect(card).toContain('除非用户在当前这条消息里明确改用别的语言')
  })
})

describe('reply-language file I/O', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-lang-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('missing / corrupt / empty → null', async () => {
    expect(await readReplyLanguage(join(dir, 'nope.json'))).toBeNull()
    const f = join(dir, 'x.json')
    await writeReplyLanguage(f, 'English')
    expect(await readReplyLanguage(f)).toBe('English')
    await writeReplyLanguage(f, '   ') // whitespace = no preference
    expect(await readReplyLanguage(f)).toBeNull()
  })
})

describe('buildButlerLanguageProbe', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-lang-probe-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('null when no preference is set', async () => {
    const probe = buildButlerLanguageProbe({ file: join(dir, 'ls.json') })
    expect(await probe()).toBeNull()
  })

  it('injects the card once a preference exists', async () => {
    const f = join(dir, 'ls.json')
    await writeReplyLanguage(f, 'Türkçe')
    const probe = buildButlerLanguageProbe({ file: f })
    expect(await probe()).toContain('用「Türkçe」回复')
  })
})

describe('set_reply_language tool', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-lang-tool-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('sets, then clears (empty value) the preference', async () => {
    const f = join(dir, 'ls.json')
    const ts = buildButlerLanguageToolset({ file: f })
    const set = await ts.callTool('set_reply_language', { language: '中文' })
    expect(set.isError).toBeUndefined()
    expect(await readReplyLanguage(f)).toBe('中文')

    const cleared = await ts.callTool('set_reply_language', { language: '' })
    expect(cleared.isError).toBeUndefined()
    expect(await readReplyLanguage(f)).toBeNull()
  })

  it('length-caps a runaway value', async () => {
    const f = join(dir, 'ls.json')
    const ts = buildButlerLanguageToolset({ file: f })
    await ts.callTool('set_reply_language', { language: 'x'.repeat(200) })
    const stored = await readReplyLanguage(f)
    expect(stored!.length).toBe(40)
  })

  it('an unknown tool name is a tool error, not a throw', async () => {
    const ts = buildButlerLanguageToolset({ file: join(dir, 'ls.json') })
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })

  it('the pinned language round-trips into the injected card', async () => {
    const f = join(dir, 'ls.json')
    const ts = buildButlerLanguageToolset({ file: f })
    await ts.callTool('set_reply_language', { language: 'English' })
    const probe = buildButlerLanguageProbe({ file: f })
    expect(await probe()).toContain('用「English」回复')
  })
})
