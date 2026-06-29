import { describe, expect, it } from 'vitest'

import {
  cleanSteps,
  formatProcedureSteps,
  formOf,
  isProcedure,
  stepsOf,
} from '../src/index.js'
import { entry } from './fake-memory.js'

describe('procedure accessors (G-M1)', () => {
  describe('formOf / isProcedure', () => {
    it('reads meta.form, falling back when absent or non-string', () => {
      expect(formOf(entry('a', 'semantic', 'x', 1, { form: 'procedure' }))).toBe('procedure')
      expect(formOf(entry('b', 'semantic', 'x', 1))).toBe('')
      expect(formOf(entry('c', 'semantic', 'x', 1), 'none')).toBe('none')
      // non-string form → fallback (no crash)
      expect(formOf(entry('d', 'semantic', 'x', 1, { form: 7 as unknown as string }))).toBe('')
    })

    it('isProcedure is true only for the procedure form', () => {
      expect(isProcedure(entry('a', 'semantic', 'x', 1, { form: 'procedure' }))).toBe(true)
      expect(isProcedure(entry('b', 'semantic', 'x', 1, { form: 'note' }))).toBe(false)
      expect(isProcedure(entry('c', 'semantic', 'x', 1))).toBe(false)
    })
  })

  describe('cleanSteps', () => {
    it('drops non-string / blank items, trims, and preserves order', () => {
      const raw = ['  draft  ', '', '   ', 'send', 42, null, 'record']
      expect(cleanSteps(raw)).toEqual(['draft', 'send', 'record'])
    })

    it('returns [] for a non-array', () => {
      expect(cleanSteps(undefined)).toEqual([])
      expect(cleanSteps('draft; send')).toEqual([])
      expect(cleanSteps({ 0: 'draft' })).toEqual([])
    })
  })

  describe('stepsOf', () => {
    it('reads and cleans meta.steps', () => {
      expect(stepsOf(entry('a', 'semantic', 'goal', 1, { steps: [' a ', '', 'b'] }))).toEqual([
        'a',
        'b',
      ])
    })

    it('is [] when there are no steps', () => {
      expect(stepsOf(entry('a', 'semantic', 'goal', 1))).toEqual([])
      expect(stepsOf(entry('b', 'semantic', 'goal', 1, { form: 'procedure' }))).toEqual([])
    })
  })

  describe('formatProcedureSteps', () => {
    it('renders a compact numbered one-liner', () => {
      expect(formatProcedureSteps(['draft', 'assess', 'route'])).toBe(
        '1. draft; 2. assess; 3. route',
      )
    })

    it('renders empty for no steps', () => {
      expect(formatProcedureSteps([])).toBe('')
    })
  })
})
