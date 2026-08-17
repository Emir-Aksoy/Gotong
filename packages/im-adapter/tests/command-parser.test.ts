/**
 * Phase 12 M1 — `parseImCommand` coverage.
 *
 * Tests are by intent (one assertion per recognised form) and by
 * fall-through (anything we don't recognise stays as `free` text so
 * an LLM-backed default agent can still read it).
 */

import { describe, expect, it } from 'vitest'

import { parseImCommand } from '../src/command-parser.js'

describe('parseImCommand', () => {
  // --- help -------------------------------------------------------

  it.each(['/help', '/HELP', '/h', '/?', '  /help  '])(
    'parses %s as help',
    (input) => {
      expect(parseImCommand(input)).toEqual({ kind: 'help' })
    },
  )

  // --- bind -------------------------------------------------------

  it('parses /bind <code>', () => {
    expect(parseImCommand('/bind 123456')).toEqual({
      kind: 'bind',
      code: '123456',
    })
  })

  it('parses /bind with alphanumeric code', () => {
    expect(parseImCommand('/bind ABC123')).toEqual({
      kind: 'bind',
      code: 'ABC123',
    })
  })

  it('ignores extra args after the code', () => {
    // We only take the first whitespace-separated token. Trailing
    // garbage shouldn't break the parse.
    expect(parseImCommand('/bind 123456 garbage')).toEqual({
      kind: 'bind',
      code: '123456',
    })
  })

  it('bare /bind falls through to free so bridge can show help', () => {
    expect(parseImCommand('/bind')).toEqual({ kind: 'free', text: '/bind' })
    expect(parseImCommand('/bind   ')).toEqual({ kind: 'free', text: '/bind' })
  })

  it('strips bot-mention suffix from verb', () => {
    expect(parseImCommand('/bind@MyGotongBot 123456')).toEqual({
      kind: 'bind',
      code: '123456',
    })
  })

  // --- unbind -----------------------------------------------------

  it.each(['/unbind', '/disconnect', '/UNBIND'])(
    'parses %s as unbind',
    (input) => {
      expect(parseImCommand(input)).toEqual({ kind: 'unbind' })
    },
  )

  // --- agents -----------------------------------------------------

  it.each(['/agents', '/who', '/AGENTS', '/agents@bot'])(
    'parses %s as agents',
    (input) => {
      expect(parseImCommand(input)).toEqual({ kind: 'agents' })
    },
  )

  // --- workflow ---------------------------------------------------

  it('parses /workflow <name>', () => {
    expect(parseImCommand('/workflow daily-summary')).toEqual({
      kind: 'workflow',
      name: 'daily-summary',
      args: '',
    })
  })

  it('parses /workflow <name> <args>', () => {
    expect(parseImCommand('/workflow daily-summary topic=ai depth=deep')).toEqual({
      kind: 'workflow',
      name: 'daily-summary',
      args: 'topic=ai depth=deep',
    })
  })

  it('preserves leading whitespace inside args', () => {
    // Real users sometimes type extra spaces; the bridge / workflow
    // runner is responsible for canonicalising. We must not eat the
    // payload here.
    expect(parseImCommand('/workflow daily   topic=x')).toEqual({
      kind: 'workflow',
      name: 'daily',
      args: 'topic=x',
    })
  })

  it('accepts /wf as workflow alias', () => {
    expect(parseImCommand('/wf summarize')).toEqual({
      kind: 'workflow',
      name: 'summarize',
      args: '',
    })
  })

  it('bare /workflow falls through to free', () => {
    expect(parseImCommand('/workflow')).toEqual({
      kind: 'free',
      text: '/workflow',
    })
    expect(parseImCommand('/wf   ')).toEqual({ kind: 'free', text: '/wf' })
  })

  // --- free text --------------------------------------------------

  it('plain text → free', () => {
    expect(parseImCommand('hello there')).toEqual({
      kind: 'free',
      text: 'hello there',
    })
  })

  it('trims surrounding whitespace on free text', () => {
    expect(parseImCommand('  ping  ')).toEqual({ kind: 'free', text: 'ping' })
  })

  it('unknown slash command → free (preserves original /verb)', () => {
    // An LLM-backed default agent might still understand `/research`
    // even though we don't have it as a built-in.
    expect(parseImCommand('/research climate')).toEqual({
      kind: 'free',
      text: '/research climate',
    })
  })

  it('empty input → empty free', () => {
    expect(parseImCommand('')).toEqual({ kind: 'free', text: '' })
    expect(parseImCommand('   ')).toEqual({ kind: 'free', text: '' })
  })

  // --- IMA-M1: /inbox /approve /deny ------------------------------

  it('parses /inbox and /pending alias', () => {
    expect(parseImCommand('/inbox')).toEqual({ kind: 'inbox' })
    expect(parseImCommand('/pending')).toEqual({ kind: 'inbox' })
    expect(parseImCommand('/INBOX')).toEqual({ kind: 'inbox' })
  })

  it('parses /approve <shortId>', () => {
    expect(parseImCommand('/approve 1a2b3c4d')).toEqual({ kind: 'approve', shortId: '1a2b3c4d' })
  })

  it('parses /deny and /reject alias', () => {
    expect(parseImCommand('/deny 1a2b3c4d')).toEqual({ kind: 'deny', shortId: '1a2b3c4d' })
    expect(parseImCommand('/reject 1a2b3c4d')).toEqual({ kind: 'deny', shortId: '1a2b3c4d' })
  })

  it('approve/deny ignore extra args after the shortId', () => {
    expect(parseImCommand('/approve 1a2b3c4d please')).toEqual({
      kind: 'approve',
      shortId: '1a2b3c4d',
    })
  })

  it('bare /approve and /deny fall through to free so bridge shows help', () => {
    expect(parseImCommand('/approve')).toEqual({ kind: 'free', text: '/approve' })
    expect(parseImCommand('/deny  ')).toEqual({ kind: 'free', text: '/deny' })
  })

  it('strips bot-mention suffix on the new verbs', () => {
    expect(parseImCommand('/approve@MyBot 1a2b3c4d')).toEqual({
      kind: 'approve',
      shortId: '1a2b3c4d',
    })
    expect(parseImCommand('/inbox@MyBot')).toEqual({ kind: 'inbox' })
  })

  // --- HANDS-M3 credential verbs ------------------------------------

  describe('/setkey (HANDS-M3)', () => {
    // The secret used across this block. Kept in one const so the
    // "never carried" assertions below can look for it verbatim.
    const SECRET = 'sk-test-abcdefghijklmnop'

    it('two tokens → paste with target and secret preserved verbatim', () => {
      expect(parseImCommand(`/setkey assistant ${SECRET}`)).toEqual({
        kind: 'setkey',
        mode: 'paste',
        target: 'assistant',
        secret: SECRET,
      })
    })

    it.each(['setkey', 'set-key', 'set_key', 'key'])(
      '/%s is claimed by the credential branch (near-miss typos never leak)',
      (verb) => {
        expect(parseImCommand(`/${verb} assistant ${SECRET}`)).toEqual({
          kind: 'setkey',
          mode: 'paste',
          target: 'assistant',
          secret: SECRET,
        })
      },
    )

    // THE load-bearing property of this whole command: a malformed setkey
    // must not become `free`, because free text is recorded into the session
    // window / transcript / episodic memory and replayed into a model's
    // context. It must also not carry the unrecognised remainder anywhere in
    // the parse result — so we assert on the SERIALISED result, which catches
    // a future field added in good faith ("keep the raw for the help text").
    it.each([
      ['no tokens', '/setkey'],
      ['trailing space only', '/setkey   '],
      ['one token (target missing)', `/setkey ${SECRET}`],
      ['three tokens (key pasted with a space)', `/setkey assistant ${SECRET} extra`],
      ['sub-verb we have not built yet', '/setkey link'],
    ])('malformed (%s) → help, and the parse result holds no leftover text', (_label, raw) => {
      const parsed = parseImCommand(raw)
      expect(parsed).toEqual({ kind: 'setkey', mode: 'help' })
      const serialised = JSON.stringify(parsed)
      expect(serialised).not.toContain(SECRET)
      expect(serialised).not.toContain('assistant')
    })

    it('strips the bot-mention suffix (a mention must not make it malformed)', () => {
      expect(parseImCommand(`/setkey@MyBot assistant ${SECRET}`)).toEqual({
        kind: 'setkey',
        mode: 'paste',
        target: 'assistant',
        secret: SECRET,
      })
    })

    it('/keys lists; it takes no argument, so nothing can ride along', () => {
      expect(parseImCommand('/keys')).toEqual({ kind: 'keys' })
      expect(parseImCommand(`/keys ${SECRET}`)).toEqual({ kind: 'keys' })
      expect(parseImCommand('/KEYS')).toEqual({ kind: 'keys' })
    })
  })

  // --- defensive --------------------------------------------------

  it('non-string input → empty free (defensive fallback)', () => {
    // Bridges shouldn't pass non-strings but the parser shouldn't
    // blow up if they do.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseImCommand(undefined as any)).toEqual({ kind: 'free', text: '' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseImCommand(null as any)).toEqual({ kind: 'free', text: '' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseImCommand(42 as any)).toEqual({ kind: 'free', text: '' })
  })
})
