import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { captureDdlSchema, readDdlCatalog, readDdlTable } from './ddlSchema'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE,
      amount NUMERIC DEFAULT 12.5,
      doubled INTEGER GENERATED ALWAYS AS (amount * 2) VIRTUAL
    );
    INSERT INTO parents VALUES (1);
    INSERT INTO items (id, email, parent_id, amount) VALUES (1, 'a@example.test', 1, 3);
    CREATE INDEX items_parent ON items(parent_id);
    CREATE INDEX items_expression ON items(lower(email));
  `)
})
afterEach(() => db.close())

describe('real DDL schema introspection', () => {
  it('captures catalog objects, columns, constraints, indexes and rows from SQLite', () => {
    const catalog = readDdlCatalog(db)
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'table', name: 'items' }),
      expect.objectContaining({ type: 'index', name: 'items_parent', tableName: 'items' }),
      expect.objectContaining({ type: 'index', name: 'items_expression', tableName: 'items' }),
    ]))

    const table = readDdlTable(db, 'ITEMS')
    expect(table).not.toBeNull()
    expect(table?.rowCount).toBe(1)
    expect(table?.rows).toEqual([[1, 'a@example.test', 1, 3, 6]])
    expect(table?.columns.map((column) => column.name)).toEqual([
      'id', 'email', 'parent_id', 'amount', 'doubled',
    ])
    expect(table?.columns[0]).toMatchObject({ declaredType: 'INTEGER', affinity: 'INTEGER', unique: true })
    expect(table?.columns[1]).toMatchObject({ notNull: true, unique: true, affinity: 'TEXT' })
    expect(table?.columns[2]?.foreignKeys).toEqual([{
      targetTable: 'parents', targetColumn: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE',
    }])
    expect(table?.columns[3]).toMatchObject({ defaultSql: '12.5', affinity: 'NUMERIC' })
  })

  it('retains expression index keys as null instead of inventing a column', () => {
    const table = readDdlTable(db, 'items')
    const expression = table?.indexes.find((index) => index.name === 'items_expression')
    expect(expression?.columns).toEqual([null])
    expect(expression?.sql).toContain('lower(email)')
    expect(table?.indexes.find((index) => index.name === 'items_parent')).toMatchObject({
      origin: 'created', unique: false, columns: ['parent_id'],
    })
    expect(table?.indexes.some((index) => index.origin === 'unique' && index.unique)).toBe(true)
  })

  it('captures table and index states with case-insensitive names', () => {
    const tableState = captureDdlSchema(db, 'TABLE', 'ItEmS')
    expect(tableState.table?.name).toBe('items')
    expect(tableState.index).toBeNull()

    const indexState = captureDdlSchema(db, 'INDEX', 'ITEMS_PARENT')
    expect(indexState.table?.name).toBe('items')
    expect(indexState.index).toMatchObject({ name: 'items_parent', tableName: 'items' })

    const missing = captureDdlSchema(db, 'INDEX', 'missing', 'items')
    expect(missing.table?.name).toBe('items')
    expect(missing.index).toBeNull()
  })
})
