import { describe, expect, it } from 'vitest'
import {
  countStatements,
  hasExecutableContent,
  splitStatements,
} from './queryHelpers'

describe('splitStatements', () => {
  it('splits simple statements on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps semicolons inside string literals', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT 2;")).toEqual([
      "SELECT 'a;b'",
      'SELECT 2',
    ])
  })

  it('handles escaped quotes inside strings', () => {
    expect(splitStatements("SELECT 'it''s; fine';")).toEqual([
      "SELECT 'it''s; fine'",
    ])
  })

  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('SELECT 1 -- comment; still comment\n; SELECT 2;')).toEqual([
      'SELECT 1 -- comment; still comment',
      'SELECT 2',
    ])
  })

  it('ignores semicolons inside block comments', () => {
    expect(splitStatements('SELECT /* a;b;c */ 1;')).toEqual([
      'SELECT /* a;b;c */ 1',
    ])
  })

  it('drops statements that are only whitespace or comments', () => {
    expect(splitStatements(';   ; -- nothing\n; SELECT 1; /* x */ ;')).toEqual([
      'SELECT 1',
    ])
  })

  it('returns the last unterminated statement', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('returns empty for empty input', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('   \n  ')).toEqual([])
  })
})

describe('hasExecutableContent', () => {
  it('detects real SQL', () => {
    expect(hasExecutableContent('SELECT 1')).toBe(true)
  })
  it('rejects comment-only text', () => {
    expect(hasExecutableContent('-- just a comment')).toBe(false)
    expect(hasExecutableContent('/* block */')).toBe(false)
    expect(hasExecutableContent('   ')).toBe(false)
  })
})

describe('countStatements', () => {
  it('counts executable statements', () => {
    expect(countStatements('SELECT 1; SELECT 2; SELECT 3;')).toBe(3)
    expect(countStatements('')).toBe(0)
  })
})
