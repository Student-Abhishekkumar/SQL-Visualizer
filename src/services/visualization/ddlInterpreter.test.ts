import { describe, expect, it } from 'vitest'
import { interpretDdl } from './ddlInterpreter'

function supported(sql: string) {
  const result = interpretDdl([sql])
  expect(result.supported, result.supported ? '' : result.reasons.join('; ')).toBe(true)
  if (!result.supported) throw new Error('Expected supported DDL')
  return result.statement
}

function rejected(sql: string, pattern?: RegExp) {
  const result = interpretDdl([sql])
  expect(result.supported).toBe(false)
  if (result.supported) throw new Error('Expected unsupported DDL')
  if (pattern !== undefined) expect(result.reasons.join(' ')).toMatch(pattern)
}

describe('central DDL capability classification', () => {
  it('classifies CREATE TABLE and CREATE INDEX options', () => {
    expect(supported('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')).toMatchObject({
      operation: 'CREATE_TABLE', table: 'items', ifNotExists: false,
    })
    expect(supported('CREATE TABLE IF NOT EXISTS items (id INTEGER)')).toMatchObject({
      operation: 'CREATE_TABLE', ifNotExists: true,
    })
    expect(supported('CREATE UNIQUE INDEX IF NOT EXISTS items_name ON items (name)')).toMatchObject({
      operation: 'CREATE_INDEX', index: 'items_name', table: 'items', unique: true, ifNotExists: true,
    })
  })

  it('classifies every supported SQLite ALTER TABLE action', () => {
    expect(supported('ALTER TABLE items RENAME TO products')).toMatchObject({
      operation: 'ALTER_TABLE', action: { kind: 'RENAME_TABLE', newTable: 'products' },
    })
    expect(supported('ALTER TABLE items RENAME COLUMN name TO label')).toMatchObject({
      operation: 'ALTER_TABLE', action: { kind: 'RENAME_COLUMN', oldColumn: 'name', newColumn: 'label' },
    })
    expect(supported("ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'new'")).toMatchObject({
      operation: 'ALTER_TABLE', action: { kind: 'ADD_COLUMN', column: 'note' },
    })
    expect(supported('ALTER TABLE items DROP COLUMN note')).toMatchObject({
      operation: 'ALTER_TABLE', action: { kind: 'DROP_COLUMN', column: 'note' },
    })
  })

  it('classifies DROP TABLE and DROP INDEX with optional existence checks', () => {
    expect(supported('DROP TABLE IF EXISTS items')).toMatchObject({ operation: 'DROP_TABLE', ifExists: true })
    expect(supported('DROP INDEX items_name')).toMatchObject({ operation: 'DROP_INDEX', index: 'items_name' })
    expect(supported('-- comment\nDROP INDEX IF EXISTS "items""name"')).toMatchObject({
      operation: 'DROP_INDEX', index: 'items"name', ifExists: true,
    })
  })

  it.each([
    ['CREATE TEMP TABLE items (id INTEGER)', /Temporary/i],
    ['CREATE TABLE items AS SELECT 1 AS id', /explicit column|AS SELECT/i],
    ['CREATE VIEW item_view AS SELECT 1 AS id', /Only CREATE TABLE/i],
    ['CREATE TRIGGER item_trigger AFTER INSERT ON items BEGIN SELECT 1; END', /Only CREATE TABLE/i],
    ['ALTER TABLE main.items RENAME TO products', /main database/i],
    ['ALTER TABLE items RENAME TO products; DROP TABLE products', /parsed|supported/i],
    ['DROP INDEX main.items_name', /main database/i],
    ['DROP INDEX', /index name/i],
  ])('rejects unsupported input before execution: %s', (sql, pattern) => rejected(sql, pattern))

  it('rejects batches, empty input, and non-DDL statements', () => {
    expect(interpretDdl([]).supported).toBe(false)
    expect(interpretDdl(['CREATE TABLE a (id INTEGER)', 'DROP TABLE a']).supported).toBe(false)
    rejected('SELECT * FROM items', /Only SELECT/i)
  })
})
