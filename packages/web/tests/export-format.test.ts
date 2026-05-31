/**
 * Phase 17 — CSV / JSONL export helpers (pure).
 */

import { describe, expect, it } from 'vitest'

import {
  csvCell,
  parseExportFormat,
  toCsv,
  toJsonl,
  type CsvColumn,
} from '../src/export-format.js'

describe('export-format — csvCell', () => {
  it('passes plain values through', () => {
    expect(csvCell('hello')).toBe('hello')
    expect(csvCell(42)).toBe('42')
  })

  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('quotes + escapes cells with comma / quote / newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('JSON-encodes object cells', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
  })
})

describe('export-format — toCsv', () => {
  const cols: CsvColumn<{ a: number; b: string }>[] = [
    { header: 'a', value: (r) => r.a },
    { header: 'b', value: (r) => r.b },
  ]

  it('emits a header line even with no rows', () => {
    expect(toCsv(cols, [])).toBe('a,b\n')
  })

  it('emits header + one line per row', () => {
    expect(toCsv(cols, [{ a: 1, b: 'x' }, { a: 2, b: 'y,z' }])).toBe(
      'a,b\n1,x\n2,"y,z"\n',
    )
  })
})

describe('export-format — toJsonl', () => {
  it('emits empty string for no rows', () => {
    expect(toJsonl([])).toBe('')
  })

  it('emits one JSON object per line, trailing newline', () => {
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n')
  })
})

describe('export-format — parseExportFormat', () => {
  it('defaults to csv', () => {
    expect(parseExportFormat(null)).toBe('csv')
    expect(parseExportFormat('csv')).toBe('csv')
    expect(parseExportFormat('weird')).toBe('csv')
  })
  it('switches to jsonl only on exact match', () => {
    expect(parseExportFormat('jsonl')).toBe('jsonl')
  })
})
