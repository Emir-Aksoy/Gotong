/**
 * Unit tests for `parseReplCommand` — the pure-function REPL parser.
 */

import { describe, expect, it } from 'vitest'

import { parseReplCommand } from '../src/repl/parse.js'

describe('parseReplCommand', () => {
  describe('noop cases', () => {
    it('empty string → noop', () => {
      expect(parseReplCommand('')).toEqual({ kind: 'noop' })
    })
    it('whitespace only → noop', () => {
      expect(parseReplCommand('   \t  ')).toEqual({ kind: 'noop' })
    })
    it('non-string → noop', () => {
      expect(parseReplCommand(null)).toEqual({ kind: 'noop' })
      expect(parseReplCommand(undefined)).toEqual({ kind: 'noop' })
      expect(parseReplCommand(42)).toEqual({ kind: 'noop' })
    })
    it('lone `:` → noop (saves users a typo)', () => {
      expect(parseReplCommand(':')).toEqual({ kind: 'noop' })
      expect(parseReplCommand(':   ')).toEqual({ kind: 'noop' })
    })
  })

  describe('help', () => {
    it(':help / :h / :?', () => {
      expect(parseReplCommand(':help')).toEqual({ kind: 'help' })
      expect(parseReplCommand(':h')).toEqual({ kind: 'help' })
      expect(parseReplCommand(':?')).toEqual({ kind: 'help' })
    })
    it('case-insensitive', () => {
      expect(parseReplCommand(':HELP')).toEqual({ kind: 'help' })
      expect(parseReplCommand(':Help')).toEqual({ kind: 'help' })
    })
    it('trailing args ignored on :help', () => {
      // We choose to treat `:help foo` as `:help` rather than
      // unknown. Lower friction; the user's intent is plain.
      expect(parseReplCommand(':help foo bar')).toEqual({ kind: 'help' })
    })
  })

  describe('quit', () => {
    it(':quit / :q / :exit', () => {
      expect(parseReplCommand(':quit')).toEqual({ kind: 'quit' })
      expect(parseReplCommand(':q')).toEqual({ kind: 'quit' })
      expect(parseReplCommand(':exit')).toEqual({ kind: 'quit' })
    })
  })

  describe('agents', () => {
    it(':agents / :who / :ls', () => {
      expect(parseReplCommand(':agents')).toEqual({ kind: 'agents' })
      expect(parseReplCommand(':who')).toEqual({ kind: 'agents' })
      expect(parseReplCommand(':ls')).toEqual({ kind: 'agents' })
    })
  })

  describe('transcript', () => {
    it(':transcript with no arg → default 5', () => {
      expect(parseReplCommand(':transcript')).toEqual({ kind: 'transcript', lastN: 5 })
      expect(parseReplCommand(':t')).toEqual({ kind: 'transcript', lastN: 5 })
    })
    it(':transcript with number → that number', () => {
      expect(parseReplCommand(':transcript 20')).toEqual({ kind: 'transcript', lastN: 20 })
      expect(parseReplCommand(':t 3')).toEqual({ kind: 'transcript', lastN: 3 })
    })
    it('clamps to 200 to prevent dumping the world', () => {
      expect(parseReplCommand(':transcript 9999')).toEqual({ kind: 'transcript', lastN: 200 })
    })
    it('floor()s fractional', () => {
      expect(parseReplCommand(':transcript 7.9')).toEqual({ kind: 'transcript', lastN: 7 })
    })
    it('zero / negative / NaN → defaults to 5', () => {
      expect(parseReplCommand(':transcript 0')).toEqual({ kind: 'transcript', lastN: 5 })
      expect(parseReplCommand(':transcript -3')).toEqual({ kind: 'transcript', lastN: 5 })
      expect(parseReplCommand(':transcript banana')).toEqual({ kind: 'transcript', lastN: 5 })
    })
  })

  describe('dispatch', () => {
    it(':dispatch <id> <text>', () => {
      expect(parseReplCommand(':dispatch writer hello world')).toEqual({
        kind: 'dispatch',
        agentId: 'writer',
        text: 'hello world',
      })
    })
    it('alias :send', () => {
      expect(parseReplCommand(':send tester run tests please')).toEqual({
        kind: 'dispatch',
        agentId: 'tester',
        text: 'run tests please',
      })
    })
    it('alias :d', () => {
      expect(parseReplCommand(':d reviewer ship it')).toEqual({
        kind: 'dispatch',
        agentId: 'reviewer',
        text: 'ship it',
      })
    })
    it(':dispatch alone → unknown (so loop prints hint)', () => {
      expect(parseReplCommand(':dispatch')).toEqual({ kind: 'unknown', verb: 'dispatch' })
    })
    it(':dispatch <id> with no text → unknown', () => {
      expect(parseReplCommand(':dispatch writer')).toEqual({ kind: 'unknown', verb: 'dispatch' })
    })
    it(':dispatch <id> with whitespace-only text → unknown', () => {
      expect(parseReplCommand(':dispatch writer    ')).toEqual({ kind: 'unknown', verb: 'dispatch' })
    })
    it('preserves spacing in the body', () => {
      expect(parseReplCommand(':dispatch writer  multiple   spaces   here')).toEqual({
        kind: 'dispatch',
        agentId: 'writer',
        text: 'multiple   spaces   here',
      })
    })
  })

  describe('free-text', () => {
    it('plain text → free', () => {
      expect(parseReplCommand('hello there')).toEqual({ kind: 'free', text: 'hello there' })
    })
    it('text starting with `/` is free (not a meta command in REPL)', () => {
      // Important: IM bridges use `/`, REPL uses `:`. The REPL never
      // intercepts `/`, so `/help` from an IM-trained user goes to
      // the chat agent and the chat agent can render help if it
      // wants (or just echo).
      expect(parseReplCommand('/help in IM speak')).toEqual({
        kind: 'free',
        text: '/help in IM speak',
      })
    })
    it('trims surrounding whitespace but preserves inner', () => {
      expect(parseReplCommand('   spaces  in  middle    ')).toEqual({
        kind: 'free',
        text: 'spaces  in  middle',
      })
    })
  })

  describe('unknown commands', () => {
    it(':notacommand → unknown with verb', () => {
      expect(parseReplCommand(':notacommand args')).toEqual({
        kind: 'unknown',
        verb: 'notacommand',
      })
    })
    it('case folded on unknown', () => {
      expect(parseReplCommand(':Foo')).toEqual({ kind: 'unknown', verb: 'foo' })
    })
  })
})
