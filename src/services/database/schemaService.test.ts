import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_SQL, SEED_SQL } from './seedData'
import { SQLiteDatabase } from './sqliteService'
import { getDatabaseSchema, getTableSchema, quoteIdentifier } from './schemaService'

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(SCHEMA_SQL)
  db.runRaw(SEED_SQL)
})

describe('schemaService', () => {
  it('lists all four seeded tables', () => {
    const schema = getDatabaseSchema(db, 'University Database')
    const names = schema.tables.map((table) => table.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'departments',
        'employees',
        'projects',
        'employee_projects',
      ]),
    )
    expect(schema.name).toBe('University Database')
  })

  it('reads columns with types and primary keys', () => {
    const schema = getTableSchema(db, 'employees')
    const idColumn = schema.columns.find((column) => column.name === 'id')
    expect(idColumn?.isPrimaryKey).toBe(true)
    expect(idColumn?.type.toUpperCase()).toBe('INTEGER')

    const nameColumn = schema.columns.find((column) => column.name === 'name')
    expect(nameColumn?.type.toUpperCase()).toBe('TEXT')
    expect(nameColumn?.notNull).toBe(true)
    expect(nameColumn?.isPrimaryKey).toBe(false)
  })

  it('detects foreign keys with their targets', () => {
    const schema = getTableSchema(db, 'employees')
    const deptId = schema.columns.find((column) => column.name === 'department_id')
    expect(deptId?.isForeignKey).toBe(true)
    expect(deptId?.foreignKey).toEqual({ table: 'departments', column: 'id' })

    const junction = getTableSchema(db, 'employee_projects')
    const employeeId = junction.columns.find((column) => column.name === 'employee_id')
    expect(employeeId?.foreignKey?.table).toBe('employees')
    const projectId = junction.columns.find((column) => column.name === 'project_id')
    expect(projectId?.foreignKey?.table).toBe('projects')
  })

  it('reports live row counts', () => {
    const schema = getDatabaseSchema(db, 'University Database')
    const byName = new Map(schema.tables.map((table) => [table.name, table]))
    expect(byName.get('employees')?.rowCount).toBe(8)
    expect(byName.get('departments')?.rowCount).toBe(3)
    expect(byName.get('projects')?.rowCount).toBe(4)
    expect(byName.get('employee_projects')?.rowCount).toBe(7)
  })

  it('reflects schema changes made at runtime', () => {
    db.executeBatch(
      "CREATE TABLE clubs (id INTEGER PRIMARY KEY, club_name TEXT NOT NULL)",
    )
    const schema = getDatabaseSchema(db, 'University Database')
    expect(schema.tables.map((table) => table.name)).toContain('clubs')
  })
})

describe('quoteIdentifier', () => {
  it('escapes embedded double quotes', () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"')
  })
})
