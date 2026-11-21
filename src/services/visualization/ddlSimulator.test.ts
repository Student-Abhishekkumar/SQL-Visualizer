import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { previewDdl } from './ddlSimulator'
import { captureDdlSchema, readDdlTable } from './ddlSchema'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
let beforeBytes: Uint8Array
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
  beforeBytes = db.exportSnapshot()
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

function preview(sql: string): VisualizationTrace {
  const activeExecute = vi.spyOn(db, 'executeBatch')
  const outcome = previewDdl(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected DDL preview')
  expect(outcome.validation?.validated).toBe(true)
  expect(activeExecute).not.toHaveBeenCalled()
  expect(db.exportSnapshot()).toEqual(beforeBytes)
  return outcome.simulation.trace
}

describe('isolated CREATE TABLE preview', () => {
  it('creates a table and reads its actual SQLite definition and constraints', () => {
    const sql = `CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES parents(id) ON DELETE SET NULL,
      name TEXT NOT NULL UNIQUE DEFAULT 'unnamed',
      score NUMERIC DEFAULT 2.5
    )`
    const trace = preview(sql)
    expect(trace.statementType).toBe('CREATE')
    expect(trace.stages).toEqual([
      'DATABASE', 'TABLE_DEFINITION', 'COLUMN_DEFINITIONS', 'CONSTRAINTS', 'CREATE_TABLE', 'RESULTING_SCHEMA',
    ])
    expect(trace.ddl).toMatchObject({
      operation: 'CREATE_TABLE', objectName: 'items', targetTable: 'items', noOp: false, rowDataChanged: false,
    })
    expect(trace.ddl?.before.table).toBeNull()
    expect(trace.ddl?.after.table?.columns.map((column) => column.name)).toEqual([
      'id', 'parent_id', 'name', 'score',
    ])
    expect(trace.ddl?.after.table?.columns[1]?.foreignKeys[0]).toMatchObject({
      targetTable: 'parents', targetColumn: 'id', onDelete: 'SET NULL',
    })
    expect(trace.ddl?.after.table?.indexes.some((index) => index.origin === 'unique')).toBe(true)
    expect(trace.finalColumns).toEqual(['type', 'name', 'table', 'sql'])
    expect(trace.finalRows.map((row) => row.values[1])).toContain('items')

    const reference = SQLiteDatabase.createFromSnapshot(beforeBytes)
    try {
      reference.runRaw(sql)
      expect(trace.ddl?.after.table).toEqual(readDdlTable(reference, 'items'))
    } finally {
      reference.close()
    }
  })

  it('reports CREATE TABLE IF NOT EXISTS as an honest no-op', () => {
    db.runRaw('CREATE TABLE existing (id INTEGER)')
    beforeBytes = db.exportSnapshot()
    const trace = preview('CREATE TABLE IF NOT EXISTS existing (different TEXT)')
    expect(trace.ddl?.noOp).toBe(true)
    expect(trace.ddl?.after.table?.sql).toBe('CREATE TABLE existing (id INTEGER)')
    expect(trace.ddl?.after.table?.columns.map((column) => column.name)).toEqual(['id'])
    expect(trace.stageSnapshots.find((snap) => snap.stage === 'CREATE_TABLE')?.explanation).toMatch(/no-op/i)
  })

  it('closes the clone after SQLite failure and never executes on the active connection', () => {
    db.runRaw('CREATE TABLE existing (id INTEGER)')
    beforeBytes = db.exportSnapshot()
    const closeSpies: Array<ReturnType<typeof vi.spyOn>> = []
    const create = SQLiteDatabase.createFromSnapshot.bind(SQLiteDatabase)
    vi.spyOn(SQLiteDatabase, 'createFromSnapshot').mockImplementation((bytes) => {
      const clone = create(bytes)
      closeSpies.push(vi.spyOn(clone, 'close'))
      return clone
    })
    const activeExecute = vi.spyOn(db, 'executeBatch')
    const outcome = previewDdl('CREATE TABLE existing (id INTEGER)', ['CREATE TABLE existing (id INTEGER)'], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected duplicate table failure')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/already exists/i)
    expect(closeSpies).toHaveLength(1)
    expect(closeSpies[0]).toHaveBeenCalledTimes(1)
    expect(activeExecute).not.toHaveBeenCalled()
    expect(db.exportSnapshot()).toEqual(beforeBytes)
    db.runRaw('CREATE TABLE still_usable (id INTEGER)')
    expect(db.queryAll("SELECT name FROM sqlite_master WHERE name = 'still_usable'").values).toEqual([['still_usable']])
  })

  it('rejects unsupported syntax before creating a clone', () => {
    const create = vi.spyOn(SQLiteDatabase, 'createFromSnapshot')
    const outcome = previewDdl('CREATE TABLE copied AS SELECT 1 AS id', ['CREATE TABLE copied AS SELECT 1 AS id'], db)
    expect(outcome.simulation.ok).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(db.exportSnapshot()).toEqual(beforeBytes)
  })
})

describe('isolated ALTER TABLE preview', () => {
  beforeEach(() => {
    db.runRaw("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score NUMERIC DEFAULT 1.5); INSERT INTO items VALUES (1, 'one', 2), (2, 'two', 3)")
    beforeBytes = db.exportSnapshot()
  })

  function expectReference(sql: string, tableName: string, trace: VisualizationTrace): void {
    const reference = SQLiteDatabase.createFromSnapshot(beforeBytes)
    try {
      reference.runRaw(sql)
      expect(trace.ddl?.after.table).toEqual(readDdlTable(reference, tableName))
    } finally {
      reference.close()
    }
  }

  it('renames a table without changing any row', () => {
    const sql = 'ALTER TABLE items RENAME TO products'
    const trace = preview(sql)
    expect(trace.ddl).toMatchObject({ operation: 'ALTER_TABLE', targetTable: 'products', rowDataChanged: false })
    expect(trace.ddl?.before.table?.name).toBe('items')
    expect(trace.ddl?.after.table?.rows).toEqual([[1, 'one', 2], [2, 'two', 3]])
    expect(trace.stageSnapshots.map((snap) => snap.stage)).toEqual([
      'ORIGINAL_SCHEMA', 'ALTER_OPERATION', 'SCHEMA_TRANSFORMATION', 'RESULTING_SCHEMA',
    ])
    expectReference(sql, 'products', trace)
  })

  it('renames a column while preserving values and constraints', () => {
    const sql = 'ALTER TABLE items RENAME COLUMN name TO label'
    const trace = preview(sql)
    expect(trace.ddl?.after.table?.columns.map((column) => column.name)).toEqual(['id', 'label', 'score'])
    expect(trace.ddl?.after.table?.columns[1]).toMatchObject({ notNull: true })
    expect(trace.ddl?.after.table?.rows).toEqual(trace.ddl?.before.table?.rows)
    expectReference(sql, 'items', trace)
  })

  it('adds a column with SQLite defaults and verifies all original columns', () => {
    const sql = "ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT 'new'"
    const trace = preview(sql)
    expect(trace.ddl?.after.table?.columns.map((column) => column.name)).toEqual(['id', 'name', 'score', 'note'])
    expect(trace.ddl?.after.table?.rows).toEqual([[1, 'one', 2, 'new'], [2, 'two', 3, 'new']])
    expect(trace.ddl?.rowDataChanged).toBe(false)
    expectReference(sql, 'items', trace)
  })

  it('drops a column and verifies every surviving column and row', () => {
    const sql = 'ALTER TABLE items DROP COLUMN score'
    const trace = preview(sql)
    expect(trace.ddl?.after.table?.columns.map((column) => column.name)).toEqual(['id', 'name'])
    expect(trace.ddl?.after.table?.rows).toEqual([[1, 'one'], [2, 'two']])
    expectReference(sql, 'items', trace)
  })

  it('reports SQLite ALTER failures without touching the active schema or rows', () => {
    const outcome = previewDdl('ALTER TABLE items ADD COLUMN name TEXT', ['ALTER TABLE items ADD COLUMN name TEXT'], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected duplicate column failure')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/duplicate|already exists/i)
    expect(db.exportSnapshot()).toEqual(beforeBytes)
    expect(db.queryAll('SELECT * FROM items ORDER BY id').values).toEqual([[1, 'one', 2], [2, 'two', 3]])
  })
})


describe('isolated DROP TABLE preview', () => {
  it('shows the removed table and the actual remaining catalog', () => {
    db.runRaw(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO items VALUES (1, 'one'), (2, 'two');
      CREATE INDEX items_name ON items(name);
      CREATE TRIGGER items_trigger AFTER INSERT ON items BEGIN SELECT 1; END;
    `)
    beforeBytes = db.exportSnapshot()
    const sql = 'DROP TABLE items'
    const trace = preview(sql)
    expect(trace.ddl).toMatchObject({ operation: 'DROP_TABLE', noOp: false, rowDataChanged: true })
    expect(trace.ddl?.before.table?.rowCount).toBe(2)
    expect(trace.ddl?.after.table).toBeNull()
    expect(trace.ddl?.after.catalog.some((object) => ['items', 'items_name', 'items_trigger'].includes(object.name))).toBe(false)
    expect(trace.stageSnapshots.map((snap) => snap.stage)).toEqual([
      'ORIGINAL_SCHEMA', 'DROP_TABLE', 'REMOVED_TABLE', 'REMAINING_SCHEMA',
    ])
    expect(trace.stageSnapshots.find((snap) => snap.stage === 'REMOVED_TABLE')?.rows[0]?.values).toEqual([
      'items', trace.ddl?.before.table?.sql, 2,
    ])

    const reference = SQLiteDatabase.createFromSnapshot(beforeBytes)
    try {
      reference.runRaw(sql)
      expect(trace.ddl?.after.catalog).toEqual(
        reference.queryAll(`SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE type IN ('table', 'index', 'view', 'trigger') ORDER BY type, name`).values.map((row) => ({
            type: String(row[0]), name: String(row[1]), tableName: String(row[2]), sql: row[3] == null ? null : String(row[3]),
          })),
      )
    } finally {
      reference.close()
    }
  })

  it('reports DROP TABLE IF EXISTS on a missing table as a no-op', () => {
    const trace = preview('DROP TABLE IF EXISTS missing')
    expect(trace.ddl?.noOp).toBe(true)
    expect(trace.ddl?.rowDataChanged).toBe(false)
    expect(trace.ddl?.before.catalog).toEqual(trace.ddl?.after.catalog)
    expect(trace.finalRows.map((row) => row.values)).toEqual(
      trace.ddl?.before.catalog.map((object) => [object.type, object.name, object.tableName, object.sql]),
    )
  })

  it('rejects foreign-key delete actions that could mutate other tables', () => {
    db.runRaw(`
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE
      );
      INSERT INTO parents VALUES (1);
      INSERT INTO children VALUES (1, 1);
    `)
    beforeBytes = db.exportSnapshot()
    const outcome = previewDdl('DROP TABLE parents', ['DROP TABLE parents'], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected cascading drop rejection')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/CASCADE|outside the target/i)
    expect(db.exportSnapshot()).toEqual(beforeBytes)
    expect(db.queryAll('SELECT * FROM children').values).toEqual([[1, 1]])
  })
})


describe('isolated CREATE INDEX preview', () => {
  beforeEach(() => {
    db.runRaw("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score NUMERIC); INSERT INTO items VALUES (1, 'Alpha', 2), (2, 'Beta', 3)")
    beforeBytes = db.exportSnapshot()
  })

  it('captures a real unique index and preserves every table row', () => {
    const sql = 'CREATE UNIQUE INDEX items_name ON items(name COLLATE NOCASE DESC)'
    const trace = preview(sql)
    expect(trace.ddl).toMatchObject({ operation: 'CREATE_INDEX', targetTable: 'items', noOp: false, rowDataChanged: false })
    expect(trace.ddl?.after.index).toMatchObject({
      name: 'items_name', tableName: 'items', unique: true, origin: 'created', columns: ['name'],
    })
    expect(trace.ddl?.after.table?.rows).toEqual(trace.ddl?.before.table?.rows)
    expect(trace.stages).toEqual(['DATABASE', 'INDEX_DEFINITION', 'CREATE_INDEX', 'INDEX_METADATA'])
    const reference = SQLiteDatabase.createFromSnapshot(beforeBytes)
    try {
      reference.runRaw(sql)
      expect(trace.ddl?.after).toEqual(captureDdlSchema(reference, 'INDEX', 'items_name'))
    } finally {
      reference.close()
    }
  })

  it('supports expression and partial indexes without inventing key columns', () => {
    const trace = preview('CREATE INDEX items_expression ON items(lower(name)) WHERE score > 1')
    expect(trace.ddl?.after.index?.columns).toEqual([null])
    expect(trace.ddl?.after.index?.sql).toContain('WHERE score > 1')
    expect(trace.finalRows[0]?.values[4]).toBe('<expression>')
  })

  it('reports IF NOT EXISTS as a no-op and retains the original index', () => {
    db.runRaw('CREATE INDEX items_name ON items(name)')
    beforeBytes = db.exportSnapshot()
    const trace = preview('CREATE UNIQUE INDEX IF NOT EXISTS items_name ON items(score)')
    expect(trace.ddl?.noOp).toBe(true)
    expect(trace.ddl?.after.index).toMatchObject({ unique: false, columns: ['name'] })
    expect(trace.ddl?.after.catalog).toEqual(trace.ddl?.before.catalog)
  })

  it('uses the real owner when IF NOT EXISTS finds the index on another table', () => {
    db.runRaw('CREATE TABLE other (id INTEGER); CREATE INDEX shared_name ON other(id)')
    beforeBytes = db.exportSnapshot()
    const trace = preview('CREATE INDEX IF NOT EXISTS shared_name ON items(name)')
    expect(trace.ddl?.noOp).toBe(true)
    expect(trace.ddl?.targetTable).toBe('other')
    expect(trace.ddl?.after.index).toMatchObject({ tableName: 'other', columns: ['id'] })
  })

  it('surfaces UNIQUE constraint failures without changing the active database', () => {
    db.runRaw("INSERT INTO items VALUES (3, 'Alpha', 4)")
    beforeBytes = db.exportSnapshot()
    const outcome = previewDdl('CREATE UNIQUE INDEX items_name ON items(name)', ['CREATE UNIQUE INDEX items_name ON items(name)'], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected UNIQUE failure')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/UNIQUE|constraint/i)
    expect(db.exportSnapshot()).toEqual(beforeBytes)
  })
})


describe('isolated DROP INDEX preview', () => {
  beforeEach(() => {
    db.runRaw(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score NUMERIC);
      INSERT INTO items VALUES (1, 'Alpha', 2), (2, 'Beta', 3);
      CREATE INDEX items_name ON items(name);
      CREATE INDEX items_score ON items(score);
    `)
    beforeBytes = db.exportSnapshot()
  })

  it('shows the existing index and actual remaining indexes without changing rows', () => {
    const sql = 'DROP INDEX items_name'
    const trace = preview(sql)
    expect(trace.ddl).toMatchObject({ operation: 'DROP_INDEX', targetTable: 'items', noOp: false, rowDataChanged: false })
    expect(trace.ddl?.before.index).toMatchObject({ name: 'items_name', columns: ['name'] })
    expect(trace.ddl?.after.index).toBeNull()
    expect(trace.ddl?.after.table?.indexes.map((index) => index.name)).toEqual(['items_score'])
    expect(trace.ddl?.after.table?.rows).toEqual(trace.ddl?.before.table?.rows)
    expect(trace.stages).toEqual(['EXISTING_INDEX', 'DROP_INDEX', 'REMAINING_INDEXES'])
    expect(trace.finalRows.map((row) => row.values[0])).toEqual(['items_score'])
    const reference = SQLiteDatabase.createFromSnapshot(beforeBytes)
    try {
      reference.runRaw(sql)
      expect(trace.ddl?.after).toEqual(captureDdlSchema(reference, 'INDEX', 'items_name', 'items'))
    } finally {
      reference.close()
    }
  })

  it('reports DROP INDEX IF EXISTS on a missing index as a no-op', () => {
    const trace = preview('DROP INDEX IF EXISTS missing')
    expect(trace.ddl?.noOp).toBe(true)
    expect(trace.ddl?.before.index).toBeNull()
    expect(trace.ddl?.after.catalog).toEqual(trace.ddl?.before.catalog)
  })

  it('supports quoted index names through the conservative DROP INDEX lexer', () => {
    db.runRaw('CREATE INDEX "odd index" ON items(name)')
    beforeBytes = db.exportSnapshot()
    const trace = preview('-- preview only\nDROP INDEX "odd index"')
    expect(trace.ddl?.before.index?.name).toBe('odd index')
    expect(trace.ddl?.after.table?.indexes.some((index) => index.name === 'odd index')).toBe(false)
  })
})
