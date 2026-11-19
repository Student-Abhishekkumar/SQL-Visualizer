import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitStatements } from '../../utils/queryHelpers'
import { buildSqlDump, formatSqlValue, SqlDumpError } from './databaseDump'
import { getDatabaseSchema } from './schemaService'
import { quoteLiteral } from './schemaService'
import { SQLiteDatabase } from './sqliteService'

const databases: SQLiteDatabase[] = []

async function createDatabase(): Promise<SQLiteDatabase> {
  const db = await SQLiteDatabase.create()
  databases.push(db)
  return db
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

describe('buildSqlDump', () => {
  it('exports and reconstructs multiple tables, values, and indexes', async () => {
    const db = await createDatabase()
    const special = "O'Brien; -- comment\nnext \"quoted\" \\ path"
    db.executeBatch(`
      CREATE TABLE "odd table" (id INTEGER PRIMARY KEY, text TEXT, nullable TEXT, payload BLOB);
      CREATE TABLE empty_table (id INTEGER PRIMARY KEY, label TEXT);
      CREATE INDEX odd_text_index ON "odd table" (text);
      INSERT INTO "odd table" VALUES (1, ${quoteLiteral(special)}, NULL, X'00FF10');
      INSERT INTO "odd table" VALUES (2, 'second row', 'present', X'');
    `)
    const schema = getDatabaseSchema(db, 'Dump test')

    const dump = buildSqlDump(db, schema, { databaseName: 'Dump test' })
    expect(dump).toContain('CREATE TABLE "odd table"')
    expect(dump).toContain('CREATE TABLE empty_table')
    expect(dump).toContain('CREATE INDEX odd_text_index')
    expect(dump).toContain("O''Brien; -- comment")
    expect(dump).toContain("X'00FF10'")
    expect(dump).toContain('NULL')
    expect(dump).not.toContain('INSERT INTO empty_table')

    const restored = await createDatabase()
    for (const statement of splitStatements(dump)) restored.runRaw(statement)
    expect(restored.queryAll('SELECT COUNT(*) FROM empty_table').values).toEqual([[0]])
    expect(restored.queryAll('SELECT id, text, nullable, payload FROM "odd table" ORDER BY id').values).toEqual([
      [1, special, null, new Uint8Array([0, 255, 16])],
      [2, 'second row', 'present', new Uint8Array()],
    ])
    expect(restored.queryAll(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'odd_text_index'",
    ).values).toEqual([[1]])
  })

  it('fails explicitly when any table rows cannot be retrieved', async () => {
    const db = await createDatabase()
    db.executeBatch(`
      CREATE TABLE broken (id INTEGER);
      CREATE TABLE complete (id INTEGER);
      INSERT INTO broken VALUES (1);
      INSERT INTO complete VALUES (2);
    `)
    const schema = getDatabaseSchema(db, 'Failure test')
    const queryAll = db.queryAll.bind(db)
    vi.spyOn(db, 'queryAll').mockImplementation((sql) => {
      if (sql === 'SELECT * FROM "broken"') throw new Error('simulated read failure')
      return queryAll(sql)
    })

    let thrown: unknown
    try {
      buildSqlDump(db, schema)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SqlDumpError)
    expect(thrown).toMatchObject({ tableName: 'broken' })
    expect(thrown).toMatchObject({ cause: expect.objectContaining({ message: 'simulated read failure' }) })
    expect((thrown as Error).message).toMatch(/dump was not generated/i)
  })
})

describe('formatSqlValue', () => {
  it('preserves SQL escaping and serializes supported scalar values', () => {
    expect(formatSqlValue(null)).toBe('NULL')
    expect(formatSqlValue(undefined)).toBe('NULL')
    expect(formatSqlValue("a'b\n;c")).toBe("'a''b\n;c'")
    expect(formatSqlValue(new Uint8Array([0, 15, 255]))).toBe("X'000FFF'")
    expect(formatSqlValue(12.5)).toBe('12.5')
    expect(formatSqlValue(12n)).toBe('12')
    expect(formatSqlValue(true)).toBe('1')
    expect(formatSqlValue(Number.NaN)).toBe('NULL')
    expect(formatSqlValue(Number.POSITIVE_INFINITY)).toBe('NULL')
  })
})
