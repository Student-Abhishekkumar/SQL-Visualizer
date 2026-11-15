import type {
  DatabaseInfo,
  DatabaseSchema,
  DatabaseTemplateId,
} from '../../types/database'
import {
  deleteDatabaseRecord,
  deleteDatabaseSnapshot,
  loadActiveDatabaseId,
  loadDatabaseRecords,
  loadDatabaseSnapshot,
  saveActiveDatabaseId,
  saveDatabaseRecord,
  saveDatabaseSnapshot,
} from '../persistence/persistenceService'
import { buildSqlDump } from './databaseDump'
import {
  getDatabaseSchema,
  getSchemaStats,
  quoteIdentifier,
} from './schemaService'
import { SQLiteDatabase } from './sqliteService'
import {
  EXAMPLE_DATABASE_DESCRIPTION,
  EXAMPLE_DATABASE_NAME,
  templateSetupSql,
  type UserDatabaseTemplateId,
} from './templates'

/**
 * Multi-database workspace manager.
 *
 * Owns every independent SQLite instance in the app:
 *  - persistent metadata records (`databases`)
 *  - exactly one live `SQLiteDatabase` connection at a time
 *  - the active database id, restored after a page refresh
 *
 * All switching goes through this module so a stale connection can
 * never be used against the wrong database. Mutating executions should
 * call `persistActiveDatabase` afterwards.
 */

export type SqlJsConfig = Parameters<typeof SQLiteDatabase.create>[0]

const MAX_NAME_LENGTH = 60
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|]/
const UNSAFE_FILE_CHARACTERS = '\\/:*?"<>|'
const SQLITE_HEADER = 'SQLite format 3\u0000'

/** True when the string contains an ASCII control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 0x1f) return true
  }
  return false
}

/** Replace filesystem-hostile characters (and control characters). */
function stripUnsafeCharacters(value: string, replacement: string): string {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    result +=
      code <= 0x1f || UNSAFE_FILE_CHARACTERS.includes(character)
        ? replacement
        : character
  }
  return result
}

let liveDatabase: SQLiteDatabase | null = null
let activeDatabaseId: string | null = null
let databases: DatabaseInfo[] = []
let initPromise: Promise<InitResult> | null = null

export interface InitResult {
  schema: DatabaseSchema | null
  activeDatabaseId: string | null
  /** True when an existing database was restored instead of created. */
  restored: boolean
  databases: DatabaseInfo[]
}

export interface CreateDatabaseInput {
  name: string
  description?: string
  template: UserDatabaseTemplateId
  setupSql?: string
}

export interface ImportDatabaseInput {
  fileName: string
  bytes: Uint8Array
  name?: string
  description?: string
}

export interface DatabaseActionResult {
  info: DatabaseInfo
  schema: DatabaseSchema
}

export interface DeleteDatabaseResult {
  activeDatabaseId: string | null
  schema: DatabaseSchema | null
}

// ------------------------------ Read access -------------------------------

/** The currently open database, or null before initialization. */
export function getLiveDatabase(): SQLiteDatabase | null {
  return liveDatabase
}

/** Id of the active database, or null when none is selected. */
export function getActiveDatabaseId(): string | null {
  return activeDatabaseId
}

/** Metadata for the active database, or null when none is selected. */
export function getActiveDatabase(): DatabaseInfo | null {
  return databases.find((database) => database.id === activeDatabaseId) ?? null
}

/** Cached metadata for every known database, most recently used first. */
export function getDatabases(): readonly DatabaseInfo[] {
  return databases
}

/** Re-read metadata records from persistence into memory. */
export async function refreshDatabases(): Promise<DatabaseInfo[]> {
  const records = await loadDatabaseRecords()
  databases = records
  return databases
}

// ------------------------------- Lifecycle --------------------------------

/**
 * Initialize the workspace:
 *  1. Load persisted database metadata.
 *  2. On first run, create the optional Example database so existing
 *     users keep the University sample data.
 *  3. Restore the last selected database (or the most recent one).
 */
export async function initDatabaseManager(config?: SqlJsConfig): Promise<InitResult> {
  if (initPromise) return initPromise

  initPromise = (async (): Promise<InitResult> => {
    if (liveDatabase !== null && activeDatabaseId !== null) {
      const info = getActiveDatabase()
      return {
        schema: info ? getDatabaseSchema(liveDatabase, info.name) : null,
        activeDatabaseId,
        restored: true,
        databases: [...databases],
      }
    }

    databases = await loadDatabaseRecords()

    if (databases.length === 0) {
      const created = await createDatabase(
        {
          name: EXAMPLE_DATABASE_NAME,
          description: EXAMPLE_DATABASE_DESCRIPTION,
          template: 'example',
        },
        config,
      )
      return {
        schema: created.schema,
        activeDatabaseId: created.info.id,
        restored: false,
        databases: [...databases],
      }
    }

    const storedActiveId = await loadActiveDatabaseId()
    const active =
      databases.find((database) => database.id === storedActiveId) ??
      [...databases].sort((a, b) => b.updatedAt - a.updatedAt)[0]

    if (!active) {
      return {
        schema: null,
        activeDatabaseId: null,
        restored: true,
        databases: [...databases],
      }
    }

    const schema = await openDatabase(active.id, config)
    return {
      schema,
      activeDatabaseId: active.id,
      restored: true,
      databases: [...databases],
    }
  })()

  try {
    return await initPromise
  } finally {
    initPromise = null
  }
}

/**
 * Open a database by id and make it the active connection.
 * Creating the replacement connection happens before the previous one
 * is closed, so a failed switch leaves the current database usable.
 */
export async function openDatabase(
  id: string,
  config?: SqlJsConfig,
): Promise<DatabaseSchema> {
  const info = databases.find((database) => database.id === id)
  if (!info) {
    throw new Error('That database no longer exists.')
  }

  if (liveDatabase !== null && activeDatabaseId === id) {
    return getDatabaseSchema(liveDatabase, info.name)
  }

  const snapshot = await loadDatabaseSnapshot(id)
  let next: SQLiteDatabase | null = null

  if (snapshot && snapshot.byteLength > 0) {
    try {
      const restored = await SQLiteDatabase.create(config, snapshot)
      // Ensure the bytes are a real, readable SQLite database.
      restored.queryAll('SELECT name FROM sqlite_master LIMIT 1')
      next = restored
    } catch {
      next?.close()
      next = null
    }
  }

  if (next === null) {
    // Missing or corrupt snapshot: rebuild from the database's template.
    next = await SQLiteDatabase.create(config)
    const setup = templateSetupSql(
      info.template === 'imported' ? 'blank' : info.template,
      info.setupSql,
    )
    if (setup.trim() !== '') next.runRaw(setup)
    await saveDatabaseSnapshot(next.exportSnapshot(), id)
  }

  const schema = getDatabaseSchema(next, info.name)

  liveDatabase?.close()
  liveDatabase = next
  activeDatabaseId = id
  await saveActiveDatabaseId(id)
  await syncRecordStats(info, schema, { touch: false })
  return schema
}

/** Create a database from a template (or custom SQL) and switch to it. */
export async function createDatabase(
  input: CreateDatabaseInput,
  config?: SqlJsConfig,
): Promise<DatabaseActionResult> {
  const name = validateDatabaseName(input.name, databases)
  const setupSql =
    input.template === 'custom'
      ? (input.setupSql ?? '')
      : templateSetupSql(input.template)

  if (input.template === 'custom' && setupSql.trim() === '') {
    throw new Error('Enter the SQL used to initialise this database.')
  }

  const db = await SQLiteDatabase.create(config)
  try {
    if (setupSql.trim() !== '') {
      db.runRaw(setupSql)
    }
  } catch (error) {
    db.close()
    throw new Error(`The setup SQL could not be executed: ${errorMessage(error)}`)
  }

  const schema = getDatabaseSchema(db, name)
  const bytes = db.exportSnapshot()
  const now = Date.now()
  const info: DatabaseInfo = {
    id: newId(),
    name,
    description: (input.description ?? '').trim(),
    template: input.template,
    createdAt: now,
    updatedAt: now,
    ...getSchemaStats(schema),
    sizeBytes: bytes.byteLength,
  }
  if (input.template === 'custom') info.setupSql = setupSql

  await saveDatabaseRecord(info)
  await saveDatabaseSnapshot(bytes, info.id)

  databases = [info, ...databases]
  await activate(db, info.id)
  return { info, schema }
}

/**
 * Import a SQLite file (`.db`, `.sqlite`, `.sqlite3`) or a `.sql` script
 * into a brand-new independent database. Existing databases are never
 * replaced; a clashing name simply gets a numeric suffix.
 */
export async function importDatabase(
  input: ImportDatabaseInput,
  config?: SqlJsConfig,
): Promise<DatabaseActionResult> {
  const requestedName =
    input.name?.trim() || databaseNameFromFileName(input.fileName)
  const name = uniqueDatabaseName(
    validateDatabaseName(requestedName, databases, undefined, { allowDuplicate: true }),
    databases,
  )

  const isSqlite = hasSqliteHeader(input.bytes)
  const isSqlScript = !isSqlite && /\.sql$/i.test(input.fileName)

  let db: SQLiteDatabase
  let template: DatabaseTemplateId
  let setupSql: string | undefined

  if (isSqlite) {
    try {
      db = await SQLiteDatabase.create(config, input.bytes)
      const integrity = db.queryOne('PRAGMA integrity_check')
      const verdict = String(integrity?.row[0] ?? '')
      if (verdict.toLowerCase() !== 'ok') {
        db.close()
        throw new Error(`SQLite integrity check failed: ${verdict || 'unknown error'}.`)
      }
      db.queryAll('SELECT name FROM sqlite_master LIMIT 1')
    } catch (error) {
      throw new Error(
        `That file could not be opened as a SQLite database. ${errorMessage(error)}`,
      )
    }
    template = 'imported'
  } else if (isSqlScript) {
    const script = new TextDecoder().decode(input.bytes)
    if (script.trim() === '') {
      throw new Error('That SQL file is empty.')
    }
    db = await SQLiteDatabase.create(config)
    try {
      db.runRaw(script)
    } catch (error) {
      db.close()
      throw new Error(`The SQL script could not be executed: ${errorMessage(error)}`)
    }
    template = 'custom'
    setupSql = script
  } else {
    throw new Error(
      'Unsupported file. Import a SQLite database (.db, .sqlite, .sqlite3) or a .sql script.',
    )
  }

  const schema = getDatabaseSchema(db, name)
  const bytes = db.exportSnapshot()
  const now = Date.now()
  const info: DatabaseInfo = {
    id: newId(),
    name,
    description:
      input.description?.trim() || `Imported from ${input.fileName}`,
    template,
    createdAt: now,
    updatedAt: now,
    ...getSchemaStats(schema),
    sizeBytes: bytes.byteLength,
  }
  if (setupSql !== undefined) info.setupSql = setupSql

  await saveDatabaseRecord(info)
  await saveDatabaseSnapshot(bytes, info.id)

  databases = [info, ...databases]
  await activate(db, info.id)
  return { info, schema }
}

/** Rename an existing database (name uniqueness is case-insensitive). */
export async function renameDatabase(id: string, name: string): Promise<DatabaseInfo> {
  const info = requireDatabase(id)
  const nextName = validateDatabaseName(name, databases, id)
  const updated: DatabaseInfo = {
    ...info,
    name: nextName,
    updatedAt: Date.now(),
  }
  await saveDatabaseRecord(updated)
  replaceRecord(updated)
  return updated
}

/** Clone a database (snapshot bytes + metadata) without switching to it. */
export async function duplicateDatabase(
  id: string,
  name?: string,
): Promise<DatabaseInfo> {
  const source = requireDatabase(id)
  const requested = name?.trim() || `${source.name} copy`
  const duplicateName = uniqueDatabaseName(
    validateDatabaseName(requested, databases, undefined, { allowDuplicate: true }),
    databases,
  )

  const snapshot =
    id === activeDatabaseId && liveDatabase !== null
      ? liveDatabase.exportSnapshot()
      : await loadDatabaseSnapshot(id)

  if (!snapshot || snapshot.byteLength === 0) {
    throw new Error('Could not read that database to duplicate it.')
  }

  const now = Date.now()
  const copy: DatabaseInfo = {
    ...source,
    id: newId(),
    name: duplicateName,
    createdAt: now,
    updatedAt: now,
    sizeBytes: snapshot.byteLength,
  }

  await saveDatabaseRecord(copy)
  await saveDatabaseSnapshot(snapshot, copy.id)
  databases = [copy, ...databases]
  return copy
}

/**
 * Delete a database and its snapshot. When the active database is
 * removed, the most recently updated remaining database is opened.
 * Deleting the last database leaves the workspace with no active db.
 */
export async function deleteDatabase(id: string): Promise<DeleteDatabaseResult> {
  const info = requireDatabase(id)
  const wasActive = activeDatabaseId === id

  if (wasActive) {
    liveDatabase?.close()
    liveDatabase = null
    activeDatabaseId = null
  }

  await deleteDatabaseRecord(info.id)
  await deleteDatabaseSnapshot(info.id)
  databases = databases.filter((database) => database.id !== id)

  if (!wasActive) {
    const active = getActiveDatabase()
    return {
      activeDatabaseId,
      schema:
        liveDatabase !== null && active !== null
          ? getDatabaseSchema(liveDatabase, active.name)
          : null,
    }
  }

  if (databases.length === 0) {
    await saveActiveDatabaseId(null)
    return { activeDatabaseId: null, schema: null }
  }

  const next = [...databases].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!next) return { activeDatabaseId: null, schema: null }
  const schema = await openDatabase(next.id)
  return { activeDatabaseId: next.id, schema }
}

/**
 * Reset a database to its template state:
 *  - blank / imported → empty database
 *  - example → original University schema and seed data
 *  - custom → replay the original setup SQL
 */
export async function resetDatabase(
  id: string = activeDatabaseId ?? '',
  config?: SqlJsConfig,
): Promise<DatabaseSchema> {
  const info = requireDatabase(id)
  const db = await SQLiteDatabase.create(config)
  const setup = templateSetupSql(
    info.template === 'imported' ? 'blank' : info.template,
    info.setupSql,
  )
  try {
    if (setup.trim() !== '') db.runRaw(setup)
  } catch (error) {
    db.close()
    throw new Error(`The database could not be reset: ${errorMessage(error)}`)
  }

  const schema = getDatabaseSchema(db, info.name)
  const bytes = db.exportSnapshot()

  await saveDatabaseRecord({
    ...info,
    updatedAt: Date.now(),
    ...getSchemaStats(schema),
    sizeBytes: bytes.byteLength,
  })
  await saveDatabaseSnapshot(bytes, info.id)

  const updated = databases.find((database) => database.id === info.id)
  if (updated) {
    replaceRecord({
      ...updated,
      updatedAt: Date.now(),
      ...getSchemaStats(schema),
      sizeBytes: bytes.byteLength,
    })
  }

  if (id === activeDatabaseId) {
    liveDatabase?.close()
    liveDatabase = db
    await saveActiveDatabaseId(id)
  } else {
    db.close()
  }
  return schema
}

// ------------------------------- Persistence ------------------------------

/**
 * Persist the live database bytes + refreshed metadata. Called after
 * mutating statements. Ignores stale connections so a switch mid-flight
 * can never overwrite the newly active database.
 */
export async function persistActiveDatabase(
  db: SQLiteDatabase | null = liveDatabase,
): Promise<void> {
  if (db === null || liveDatabase === null || db !== liveDatabase) return
  const id = activeDatabaseId
  if (id === null) return
  const info = databases.find((database) => database.id === id)
  if (!info) return

  const schema = getDatabaseSchema(db, info.name)
  const bytes = db.exportSnapshot()
  await saveDatabaseSnapshot(bytes, id)
  await syncRecordStats(info, schema, { touch: true, bytes })
}

/** Read the raw SQLite snapshot of a database (active or stored). */
export async function exportDatabase(id: string = activeDatabaseId ?? ''): Promise<Uint8Array> {
  const info = requireDatabase(id)
  if (id === activeDatabaseId && liveDatabase !== null) {
    return liveDatabase.exportSnapshot()
  }
  const snapshot = await loadDatabaseSnapshot(info.id)
  if (!snapshot || snapshot.byteLength === 0) {
    throw new Error('That database has no stored snapshot to export.')
  }
  return snapshot
}

/** Build a labelled SQL script dump for a database. */
export async function exportDatabaseSql(
  id: string = activeDatabaseId ?? '',
  config?: SqlJsConfig,
): Promise<{ sql: string; fileName: string }> {
  const info = requireDatabase(id)
  let db: SQLiteDatabase
  let temporary = false

  if (id === activeDatabaseId && liveDatabase !== null) {
    db = liveDatabase
  } else {
    const snapshot = await loadDatabaseSnapshot(info.id)
    if (!snapshot || snapshot.byteLength === 0) {
      throw new Error('That database has no stored snapshot to export.')
    }
    db = await SQLiteDatabase.create(config, snapshot)
    temporary = true
  }

  try {
    const schema = getDatabaseSchema(db, info.name)
    const sql = buildSqlDump(db, schema, { databaseName: info.name })
    return { sql, fileName: `${safeFileName(info.name)}.sql` }
  } finally {
    if (temporary) db.close()
  }
}

/** Persisted bytes for a database without opening it as live. */
export async function getDatabaseSnapshot(id: string): Promise<Uint8Array | null> {
  if (id === activeDatabaseId && liveDatabase !== null) {
    return liveDatabase.exportSnapshot()
  }
  return loadDatabaseSnapshot(id)
}

// -------------------------------- Helpers ---------------------------------

/** Validate a user-supplied database name; returns the trimmed name. */
export function validateDatabaseName(
  name: string,
  existing: readonly DatabaseInfo[] = databases,
  excludeId?: string,
  options: { allowDuplicate?: boolean } = {},
): string {
  const trimmed = name.trim()
  if (trimmed === '') {
    throw new Error('Give the database a name.')
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Database names can be at most ${MAX_NAME_LENGTH} characters.`)
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('That name is reserved.')
  }
  if (UNSAFE_NAME_CHARACTERS.test(trimmed) || hasControlCharacter(trimmed)) {
    throw new Error('Database names cannot contain \\ / : * ? " < > | or control characters.')
  }

  if (!options.allowDuplicate) {
    const clash = existing.find(
      (database) =>
        database.id !== excludeId &&
        database.name.toLowerCase() === trimmed.toLowerCase(),
    )
    if (clash) {
      throw new Error(`A database named “${clash.name}” already exists.`)
    }
  }
  return trimmed
}

/** Append a numeric suffix until the name is unique. */
export function uniqueDatabaseName(
  base: string,
  existing: readonly DatabaseInfo[] = databases,
): string {
  const taken = new Set(existing.map((database) => database.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  let candidate = `${base} (${index})`
  while (taken.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${base} (${index})`
  }
  return candidate
}

/** Derive a safe database name from an imported file name. */
export function databaseNameFromFileName(fileName: string): string {
  const base = stripUnsafeCharacters(fileName.replace(/\.[^.]+$/, ''), ' ')
  const cleaned = base.replace(/\s+/g, ' ').trim()
  return cleaned === '' ? 'Imported database' : cleaned
}

/** File-system-friendly export name (no extension). */
export function safeFileName(name: string): string {
  const cleaned = stripUnsafeCharacters(name, '-').trim()
  return cleaned === '' ? 'database' : cleaned
}

/** True when bytes start with the SQLite file header. */
export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_HEADER.length) return false
  for (let index = 0; index < SQLITE_HEADER.length; index++) {
    if (bytes[index] !== SQLITE_HEADER.charCodeAt(index)) return false
  }
  return true
}

/** Human-readable table list, used in confirmation copy. */
export function describeTables(schema: DatabaseSchema): string {
  if (schema.tables.length === 0) return 'no tables'
  return schema.tables.map((table) => quoteIdentifier(table.name)).join(', ')
}

/** Close the live connection but keep metadata (tests / hot reload). */
export function closeLiveDatabase(): void {
  liveDatabase?.close()
  liveDatabase = null
}

/** Full module-state reset — tests only. Persistence is not touched. */
export function resetDatabaseManagerForTests(): void {
  liveDatabase?.close()
  liveDatabase = null
  activeDatabaseId = null
  databases = []
  initPromise = null
}

async function activate(db: SQLiteDatabase, id: string): Promise<void> {
  liveDatabase?.close()
  liveDatabase = db
  activeDatabaseId = id
  await saveActiveDatabaseId(id)
}

function replaceRecord(record: DatabaseInfo): void {
  const index = databases.findIndex((database) => database.id === record.id)
  if (index >= 0) {
    databases = databases.map((database) =>
      database.id === record.id ? record : database,
    )
  } else {
    databases = [record, ...databases]
  }
}

async function syncRecordStats(
  info: DatabaseInfo,
  schema: DatabaseSchema,
  options: { touch: boolean; bytes?: Uint8Array },
): Promise<void> {
  const sizeBytes = options.bytes?.byteLength ?? info.sizeBytes
  const updated: DatabaseInfo = {
    ...info,
    ...getSchemaStats(schema),
    sizeBytes,
    updatedAt: options.touch ? Date.now() : info.updatedAt,
  }
  replaceRecord(updated)
  await saveDatabaseRecord(updated)
}

function requireDatabase(id: string): DatabaseInfo {
  const info = databases.find((database) => database.id === id)
  if (!info) throw new Error('That database no longer exists.')
  return info
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `db-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
