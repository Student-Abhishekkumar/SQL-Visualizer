import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  deleteDatabase,
  duplicateDatabase,
  exportDatabase,
  exportDatabaseSql,
  getActiveDatabase,
  getActiveDatabaseId,
  getDatabases,
  getLiveDatabase,
  hasSqliteHeader,
  importDatabase,
  initDatabaseManager,
  openDatabase,
  persistActiveDatabase,
  renameDatabase,
  resetDatabase,
  resetDatabaseManagerForTests,
  validateDatabaseName,
} from './databaseManager'
import { getDatabaseSchema } from './schemaService'
import { SQLiteDatabase } from './sqliteService'
import { SCHEMA_SQL, SEED_SQL } from './seedData'
import {
  clearAllDatabaseData,
  loadDatabaseSnapshot,
  loadHistory,
  saveDatabaseSnapshot,
} from '../persistence/persistenceService'
import { useDatabaseStore } from '../../store/databaseStore'
import { useHistoryStore } from '../../store/historyStore'
import { useVisualizationStore } from '../../store/visualizationStore'

/**
 * End-to-end multi-database workspace tests using real sql.js and
 * fake-indexeddb. Covers creation, switching, isolation, DDL/DML,
 * persistence, metadata operations, import/export, history and
 * visualization invalidation.
 */

function live(): SQLiteDatabase {
  const db = getLiveDatabase()
  if (db === null) throw new Error('Expected a live database')
  return db
}

function execute(sql: string): void {
  live().executeBatch(sql)
}

async function executeAndPersist(sql: string): Promise<void> {
  execute(sql)
  await persistActiveDatabase()
}

function activeSchema() {
  const info = getActiveDatabase()
  if (info === null) throw new Error('Expected an active database')
  return getDatabaseSchema(live(), info.name)
}

function tableNames(): string[] {
  return activeSchema().tables.map((table) => table.name)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  resetDatabaseManagerForTests()
  useDatabaseStore.setState({
    status: 'uninitialized',
    initError: null,
    schema: null,
    activeDatabaseId: null,
    databases: [],
    isExecuting: false,
    lastResult: null,
  })
  useHistoryStore.setState({ history: [], savedQueries: [], loaded: true })
  useVisualizationStore.getState().resetForDatabaseSwitch()
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('database creation', () => {
  it('creates a genuinely empty blank database', async () => {
    const { info, schema } = await createDatabase({
      name: 'Blank Workspace',
      template: 'blank',
    })

    expect(schema.tables).toEqual([])
    expect(info.tableCount).toBe(0)
    expect(info.rowCount).toBe(0)
    expect(info.template).toBe('blank')
    expect(getActiveDatabaseId()).toBe(info.id)
    expect(
      live().queryAll(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).values,
    ).toEqual([])
  })

  it('creates a database from the example template with seed data only there', async () => {
    const { info, schema } = await createDatabase({
      name: 'Example Copy',
      template: 'example',
    })

    expect(info.template).toBe('example')
    expect(schema.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['employees', 'departments', 'projects', 'employee_projects']),
    )
    expect(live().queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
  })

  it('creates a custom database from setup SQL', async () => {
    const { schema } = await createDatabase({
      name: 'Custom Setup',
      template: 'custom',
      setupSql: `
        CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO students (name) VALUES ('Ada'), ('Grace');
      `,
    })

    expect(schema.tables.map((table) => table.name)).toContain('students')
    expect(live().queryAll('SELECT COUNT(*) FROM students').values[0]?.[0]).toBe(2)
  })

  it('supports multiple independent databases and validates names', async () => {
    await createDatabase({ name: 'First', template: 'blank' })
    await createDatabase({ name: 'Second', template: 'blank' })
    await createDatabase({ name: 'Third', template: 'blank' })

    expect(getDatabases().map((database) => database.name)).toEqual(
      expect.arrayContaining(['First', 'Second', 'Third']),
    )
    expect(getDatabases()).toHaveLength(3)

    await expect(
      createDatabase({ name: 'First', template: 'blank' }),
    ).rejects.toThrow(/already exists/i)
    expect(() => validateDatabaseName('  ', getDatabases())).toThrow(/name/i)
    expect(() => validateDatabaseName('bad/name', getDatabases())).toThrow(/cannot contain/i)
    expect(() => validateDatabaseName('x'.repeat(61), getDatabases())).toThrow(/60/)


  })
})

describe('custom schema and data operations', () => {
  it('discovers a created table, its columns, indexes and rows', async () => {
    await createDatabase({ name: 'College', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER,
        department TEXT
      );
      CREATE INDEX idx_students_department ON students (department);
    `)

    const schema = activeSchema()
    const students = schema.tables.find((table) => table.name === 'students')
    expect(students).toBeDefined()
    expect(students?.columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'age',
      'department',
    ])
    expect(students?.columns.find((column) => column.name === 'id')?.isPrimaryKey).toBe(true)
    expect(students?.indexes.some((index) => index.name === 'idx_students_department')).toBe(true)
    expect(students?.sql).toContain('CREATE TABLE students')
  })

  it('inserts, queries, updates and deletes records', async () => {
    await createDatabase({ name: 'CRUD', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);
      INSERT INTO students (name, age) VALUES ('Ada', 21), ('Grace', 24);
    `)

    expect(live().queryAll('SELECT COUNT(*) FROM students').values[0]?.[0]).toBe(2)

    execute("UPDATE students SET age = 22 WHERE name = 'Ada'")
    expect(
      live().queryAll("SELECT age FROM students WHERE name = 'Ada'").values[0]?.[0],
    ).toBe(22)

    execute("DELETE FROM students WHERE name = 'Grace'")
    expect(live().queryAll('SELECT COUNT(*) FROM students').values[0]?.[0]).toBe(1)
  })
})

describe('switching and isolation', () => {
  it('never leaks data between databases', async () => {
    // Database A: students
    const a = await createDatabase({ name: 'Database A', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO students (name) VALUES ('Ada'), ('Grace');
    `)

    // Database B: completely empty on creation
    const b = await createDatabase({ name: 'Database B', template: 'blank' })
    expect(getActiveDatabaseId()).toBe(b.info.id)
    expect(tableNames()).toEqual([])

    await executeAndPersist(`
      CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO employees (name) VALUES ('Rahul');
    `)

    // Back to A: students exist, employees must not.
    await openDatabase(a.info.id)
    expect(tableNames()).toContain('students')
    expect(tableNames()).not.toContain('employees')
    expect(live().queryAll('SELECT name FROM students ORDER BY name').values).toEqual([
      ['Ada'],
      ['Grace'],
    ])

    // Back to B: employees exist, students must not.
    await openDatabase(b.info.id)
    expect(tableNames()).toContain('employees')
    expect(tableNames()).not.toContain('students')
    expect(live().queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(1)
    expect(() => live().queryAll('SELECT * FROM students')).toThrow(/no such table/i)
  })

  it('preserves each database after switching many times', async () => {
    const first = await createDatabase({ name: 'Switch A', template: 'blank' })
    await executeAndPersist("CREATE TABLE alpha (value TEXT); INSERT INTO alpha VALUES ('a')")
    const second = await createDatabase({ name: 'Switch B', template: 'blank' })
    await executeAndPersist("CREATE TABLE beta (value TEXT); INSERT INTO beta VALUES ('b')")

    for (let round = 0; round < 3; round++) {
      await openDatabase(first.info.id)
      expect(tableNames()).toEqual(['alpha'])
      await openDatabase(second.info.id)
      expect(tableNames()).toEqual(['beta'])
    }
  })
})

describe('persistence', () => {
  it('restores databases, active selection and data after a refresh', async () => {
    const created = await createDatabase({ name: 'Persisted', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO notes (body) VALUES ('survives a reload');
    `)
    await createDatabase({ name: 'Other', template: 'blank' })
    await openDatabase(created.info.id)

    // Simulate a full page refresh: drop all in-memory state.
    resetDatabaseManagerForTests()
    const result = await initDatabaseManager()

    expect(result.activeDatabaseId).toBe(created.info.id)
    expect(result.restored).toBe(true)
    expect(getDatabases()).toHaveLength(2)
    expect(getActiveDatabase()?.name).toBe('Persisted')
    expect(
      live().queryAll('SELECT body FROM notes').values[0]?.[0],
    ).toBe('survives a reload')
  })

  it('keeps the current live database and stored bytes when another snapshot cannot restore', async () => {
    const source = await createDatabase({ name: 'Recovery Source', template: 'blank' })
    await executeAndPersist("CREATE TABLE valuables (id INTEGER PRIMARY KEY); INSERT INTO valuables VALUES (1)")
    const validSnapshot = await loadDatabaseSnapshot(source.info.id)
    const other = await createDatabase({ name: 'Still Live', template: 'blank' })
    await executeAndPersist("CREATE TABLE current_data (id INTEGER PRIMARY KEY); INSERT INTO current_data VALUES (42)")
    const currentConnection = live()
    const corruptSnapshot = new Uint8Array([9, 8, 7])
    await saveDatabaseSnapshot(corruptSnapshot, source.info.id)

    await expect(openDatabase(source.info.id)).rejects.toMatchObject({
      name: 'DatabaseRestoreError',
      failure: 'corrupt-snapshot',
    })
    expect(live()).toBe(currentConnection)
    expect(getActiveDatabaseId()).toBe(other.info.id)
    expect(live().queryAll('SELECT id FROM current_data').values).toEqual([[42]])
    expect(await loadDatabaseSnapshot(source.info.id)).toEqual(corruptSnapshot)

    await saveDatabaseSnapshot(validSnapshot as Uint8Array, source.info.id)
    await openDatabase(source.info.id)
    expect(live().queryAll('SELECT id FROM valuables').values).toEqual([[1]])
  })

  it('restores the example database on a fresh workspace', async () => {
    const result = await initDatabaseManager()
    expect(result.restored).toBe(false)
    expect(result.schema?.tables.map((table) => table.name)).toContain('employees')
    expect(getDatabases()).toHaveLength(1)
    expect(getActiveDatabase()?.template).toBe('example')
  })
})

describe('atomic execution and persistence', () => {
  it('returns accurate statement results, refreshes schema, and persists only after commit', async () => {
    const created = await createDatabase({ name: 'Atomic Success', template: 'blank' })
    const result = await useDatabaseStore.getState().execute(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT UNIQUE);
      INSERT INTO items (id, label) VALUES (1, 'one'), (2, 'two');
      SELECT id, label FROM items ORDER BY id;
    `)

    expect(result.success).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.rolledBack).toBe(false)
    expect(result.persistencePending).toBe(false)
    expect(result.statements).toHaveLength(3)
    expect(result.statements[0]?.rowsModified).toBe(0)
    expect(result.statements[1]?.rowsModified).toBe(2)
    expect(result.statements[2]?.values).toEqual([[1, 'one'], [2, 'two']])
    expect(result.rows).toEqual([{ id: 1, label: 'one' }, { id: 2, label: 'two' }])
    expect(useDatabaseStore.getState().schema?.tables.map((table) => table.name)).toContain('items')

    const bytes = await loadDatabaseSnapshot(created.info.id)
    expect(bytes).not.toBeNull()
    const restored = await SQLiteDatabase.create(undefined, bytes as Uint8Array)
    expect(restored.queryAll('SELECT COUNT(*) FROM items').values[0]?.[0]).toBe(2)
    restored.close()
  })

  it('keeps failed batch mutations out of both the live database and IndexedDB', async () => {
    const created = await createDatabase({ name: 'Atomic Failure', template: 'blank' })
    const setup = await useDatabaseStore.getState().execute(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT UNIQUE);
      INSERT INTO items (id, label) VALUES (1, 'one');
    `)
    expect(setup.success).toBe(true)
    const before = await loadDatabaseSnapshot(created.info.id)

    const result = await useDatabaseStore.getState().execute(`
      INSERT INTO items (id, label) VALUES (2, 'two');
      INSERT INTO items (id, label) VALUES (3, 'one');
      INSERT INTO items (id, label) VALUES (4, 'four');
    `)

    expect(result.success).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.persistencePending).toBe(false)
    expect(result.errorStatementIndex).toBe(1)
    expect(result.error).toMatch(/rolled back/i)
    expect(live().queryAll('SELECT id FROM items ORDER BY id').values).toEqual([[1]])
    expect(useDatabaseStore.getState().lastResult).toEqual(result)

    const after = await loadDatabaseSnapshot(created.info.id)
    expect(after).toEqual(before)
    const restored = await SQLiteDatabase.create(undefined, after as Uint8Array)
    expect(restored.queryAll('SELECT id FROM items').values).toEqual([[1]])
    restored.close()
  })

  it('reports post-commit IndexedDB failure without claiming rollback or durability', async () => {
    const created = await createDatabase({ name: 'Persistence Failure', template: 'blank' })
    const before = await loadDatabaseSnapshot(created.info.id)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(
      function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'snapshots') {
          throw new DOMException('Simulated snapshot write failure', 'QuotaExceededError')
        }
        return key === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, key)
      },
    )

    const result = await useDatabaseStore.getState().execute(`
      CREATE TABLE committed_items (id INTEGER PRIMARY KEY);
      INSERT INTO committed_items (id) VALUES (1);
    `)

    expect(result.success).toBe(false)
    expect(result.committed).toBe(true)
    expect(result.rolledBack).toBe(false)
    expect(result.persistencePending).toBe(true)
    expect(result.persistenceError).toMatch(/snapshot/i)
    expect(result.error).toMatch(/committed.*persistence failed/i)
    expect(result.statements).toHaveLength(2)
    expect(live().queryAll('SELECT id FROM committed_items').values).toEqual([[1]])
    expect(useDatabaseStore.getState().schema?.tables.map((table) => table.name))
      .toContain('committed_items')

    const afterFailure = await loadDatabaseSnapshot(created.info.id)
    expect(afterFailure).toEqual(before)
    const restored = await SQLiteDatabase.create(undefined, afterFailure as Uint8Array)
    expect(() => restored.queryAll('SELECT * FROM committed_items')).toThrow(/no such table/i)
    restored.close()

    vi.restoreAllMocks()
    expect(await persistActiveDatabase()).toBe(true)
    const afterRetry = await loadDatabaseSnapshot(created.info.id)
    const durable = await SQLiteDatabase.create(undefined, afterRetry as Uint8Array)
    expect(durable.queryAll('SELECT id FROM committed_items').values).toEqual([[1]])
    durable.close()
  })
})

describe('metadata operations', () => {
  it('renames a database and rejects duplicate names', async () => {
    const first = await createDatabase({ name: 'Alpha', template: 'blank' })
    await createDatabase({ name: 'Beta', template: 'blank' })

    const renamed = await renameDatabase(first.info.id, 'Alpha Renamed')
    expect(renamed.name).toBe('Alpha Renamed')
    expect(getDatabases().find((database) => database.id === first.info.id)?.name).toBe(
      'Alpha Renamed',
    )
    await expect(renameDatabase(first.info.id, 'beta')).rejects.toThrow(/already exists/i)
  })

  it('duplicates a database with independent storage', async () => {
    const original = await createDatabase({ name: 'Original', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items (label) VALUES ('one');
    `)

    const copy = await duplicateDatabase(original.info.id)
    expect(copy.id).not.toBe(original.info.id)
    expect(copy.name).toBe('Original copy')
    expect(copy.tableCount).toBe(1)

    // Mutating the copy must not affect the original.
    await openDatabase(copy.id)
    await executeAndPersist("INSERT INTO items (label) VALUES ('two')")
    expect(live().queryAll('SELECT COUNT(*) FROM items').values[0]?.[0]).toBe(2)

    await openDatabase(original.info.id)
    expect(live().queryAll('SELECT COUNT(*) FROM items').values[0]?.[0]).toBe(1)
  })

  it('deletes databases and selects another active one', async () => {
    const first = await createDatabase({ name: 'Delete A', template: 'blank' })
    const second = await createDatabase({ name: 'Delete B', template: 'blank' })

    expect(getActiveDatabaseId()).toBe(second.info.id)
    await deleteDatabase(second.info.id)
    expect(getDatabases().map((database) => database.id)).not.toContain(second.info.id)
    expect(getActiveDatabaseId()).toBe(first.info.id)
    expect(getActiveDatabase()).not.toBeNull()

    await deleteDatabase(first.info.id)
    expect(getDatabases()).toEqual([])
    expect(getActiveDatabaseId()).toBeNull()
    expect(getLiveDatabase()).toBeNull()
  })

  it('resets blank, example and custom databases to their starting state', async () => {
    // Blank + user tables → empty after reset.
    const blank = await createDatabase({ name: 'Blank Reset', template: 'blank' })
    await executeAndPersist('CREATE TABLE scratch (id INTEGER)')
    await resetDatabase(blank.info.id)
    expect(activeSchema().tables).toEqual([])

    // Example → original seed rows restored.
    const example = await createDatabase({ name: 'Example Reset', template: 'example' })
    await executeAndPersist('DELETE FROM employee_projects; DELETE FROM employees')
    expect(live().queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(0)
    await resetDatabase(example.info.id)
    expect(live().queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)

    // Custom → setup SQL replayed.
    const custom = await createDatabase({
      name: 'Custom Reset',
      template: 'custom',
      setupSql: "CREATE TABLE seeded (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO seeded (value) VALUES ('x');",
    })
    await executeAndPersist('DROP TABLE seeded')
    await resetDatabase(custom.info.id)
    expect(activeSchema().tables.map((table) => table.name)).toContain('seeded')
    expect(live().queryAll('SELECT COUNT(*) FROM seeded').values[0]?.[0]).toBe(1)
  })
})

describe('import and export', () => {
  it('imports a valid SQLite database file into a new database', async () => {
    const source = await SQLiteDatabase.create()
    source.runRaw(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO students (name) VALUES ('Ada'), ('Grace');
    `)
    const bytes = source.exportSnapshot()
    source.close()

    const { info, schema } = await importDatabase({ fileName: 'college.sqlite', bytes })

    expect(info.name).toBe('college')
    expect(info.template).toBe('imported')
    expect(schema.tables.map((table) => table.name)).toContain('students')
    expect(getActiveDatabaseId()).toBe(info.id)
    expect(live().queryAll('SELECT COUNT(*) FROM students').values[0]?.[0]).toBe(2)
  })

  it('imports a SQL script into an isolated database', async () => {
    const bytes = new TextEncoder().encode(
      "CREATE TABLE courses (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO courses (title) VALUES ('SQL');",
    )
    const { info, schema } = await importDatabase({ fileName: 'setup.sql', bytes })

    expect(info.template).toBe('custom')
    expect(schema.tables.map((table) => table.name)).toContain('courses')
  })

  it('rejects invalid or unsupported files with clear errors', async () => {
    await expect(
      importDatabase({ fileName: 'broken.db', bytes: new Uint8Array([1, 2, 3, 4]) }),
    ).rejects.toThrow(/unsupported file/i)

    await expect(
      importDatabase({
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('hello'),
      }),
    ).rejects.toThrow(/unsupported file/i)

    await expect(
      importDatabase({
        fileName: 'bad.sql',
        bytes: new TextEncoder().encode('THIS IS NOT SQL;'),
      }),
    ).rejects.toThrow(/could not be executed/i)

    // A SQLite header with corrupt contents is rejected, not registered.
    const corrupt = new Uint8Array(64)
    corrupt.set(new TextEncoder().encode('SQLite format 3\u0000'))
    await expect(
      importDatabase({ fileName: 'corrupt.db', bytes: corrupt }),
    ).rejects.toThrow(/could not be opened/i)
    expect(getDatabases()).toEqual([])
  })

  it('exports real SQLite bytes and a labelled SQL script', async () => {
    await createDatabase({ name: 'Export Me', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE INDEX idx_students_name ON students (name);
      INSERT INTO students (name) VALUES ('Ada'), ('O''Brien');
    `)

    const bytes = await exportDatabase()
    expect(hasSqliteHeader(bytes)).toBe(true)
    const restored = await SQLiteDatabase.create(undefined, bytes)
    expect(restored.queryAll('SELECT COUNT(*) FROM students').values[0]?.[0]).toBe(2)
    restored.close()

    const { sql, fileName } = await exportDatabaseSql()
    expect(fileName).toBe('Export Me.sql')
    expect(sql).toContain('CREATE TABLE students')
    expect(sql).toContain('CREATE INDEX idx_students_name')
    expect(sql).toContain('INSERT INTO "students"')
    expect(sql).toContain("'O''Brien'")
    expect(sql).toContain('not a binary SQLite database file')
  })

  it('round-trips an export through import', async () => {
    const created = await createDatabase({ name: 'Round Trip', template: 'example' })
    const bytes = await exportDatabase(created.info.id)

    const imported = await importDatabase({ fileName: 'round-trip.db', bytes })
    expect(imported.info.id).not.toBe(created.info.id)
    expect(imported.info.name).toBe('round-trip')
    expect(live().queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
    expect(imported.schema.tables).toHaveLength(4)
  })
})

describe('history and visualization integration', () => {
  it('associates history entries with the database they ran on', async () => {
    const a = await createDatabase({ name: 'History A', template: 'blank' })
    await executeAndPersist('CREATE TABLE alpha (id INTEGER)')
    const resultA = await useDatabaseStore.getState().execute('INSERT INTO alpha (id) VALUES (1)')
    useHistoryStore.getState().recordExecution(resultA, resultA.databaseId)

    const b = await createDatabase({ name: 'History B', template: 'blank' })
    await executeAndPersist('CREATE TABLE beta (id INTEGER)')
    const resultB = await useDatabaseStore.getState().execute('INSERT INTO beta (id) VALUES (2)')
    useHistoryStore.getState().recordExecution(resultB, resultB.databaseId)

    const entries = useHistoryStore.getState().history
    expect(entries.find((entry) => entry.sql.includes('alpha'))?.databaseId).toBe(a.info.id)
    expect(entries.find((entry) => entry.sql.includes('beta'))?.databaseId).toBe(b.info.id)

    expect(
      entries.filter((entry) => entry.databaseId === a.info.id),
    ).toHaveLength(1)
    expect(
      entries.filter((entry) => entry.databaseId === b.info.id),
    ).toHaveLength(1)

    await flush()
    const persisted = await loadHistory()
    expect(persisted.some((entry) => entry.databaseId === a.info.id)).toBe(true)
    expect(persisted.some((entry) => entry.databaseId === b.info.id)).toBe(true)
  })

  it('invalidates the visualization and results when switching databases', async () => {
    const a = await createDatabase({ name: 'Viz A', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO students (name) VALUES ('Ada');
    `)
    const sql = 'SELECT * FROM students'
    useVisualizationStore.getState().visualize(sql, [sql])
    expect(useVisualizationStore.getState().trace).not.toBeNull()
    expect(useVisualizationStore.getState().databaseId).toBe(a.info.id)

    const b = await createDatabase({ name: 'Viz B', template: 'blank' })
    await useDatabaseStore.getState().openDatabase(b.info.id)

    expect(useVisualizationStore.getState().trace).toBeNull()
    expect(useVisualizationStore.getState().databaseId).toBeNull()
    expect(useVisualizationStore.getState().status).toBe('idle')
    expect(useDatabaseStore.getState().lastResult).toBeNull()
    expect(useDatabaseStore.getState().schema?.tables).toEqual([])

    // Switching back restores A's schema (and still has its data).
    await useDatabaseStore.getState().openDatabase(a.info.id)
    expect(useDatabaseStore.getState().schema?.tables.map((table) => table.name)).toContain(
      'students',
    )
    expect(live().queryAll('SELECT name FROM students').values[0]?.[0]).toBe('Ada')
  })

  it('runs visualization against the selected database records only', async () => {
    const a = await createDatabase({ name: 'Viz Source', template: 'blank' })
    await executeAndPersist(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO students (name) VALUES ('Ada'), ('Grace');
    `)
    const other = await createDatabase({ name: 'Viz Empty', template: 'blank' })
    await openDatabase(a.info.id)

    const sql = 'SELECT * FROM students'
    useVisualizationStore.getState().visualize(sql, [sql])
    const state = useVisualizationStore.getState()
    expect(state.trace).not.toBeNull()
    expect(state.databaseId).toBe(a.info.id)
    expect(state.actualRowCount).toBe(2)
    expect(state.trace?.query).toBe(sql)

    // The other database has no students table, so it cannot borrow this trace.
    await openDatabase(other.info.id)
    useVisualizationStore.getState().visualize(sql, [sql])
    expect(useVisualizationStore.getState().trace).toBeNull()
    expect(useVisualizationStore.getState().status).toBe('unsupported')
  })
})

describe('example schema constants remain available', () => {
  it('keeps the University template DDL and seed data', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE employees')
    expect(SEED_SQL).toContain('INSERT INTO departments')
  })
})
