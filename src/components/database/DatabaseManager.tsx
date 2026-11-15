import { useRef, useState } from 'react'
import {
  ChevronRight,
  CircleCheck,
  Copy,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import type { DatabaseInfo } from '../../types/database'
import { useDatabaseStore } from '../../store/databaseStore'
import { useUIStore } from '../../store/uiStore'
import { safeFileName } from '../../services/database/databaseManager'
import { downloadFile } from '../../utils/download'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { CreateDatabaseForm } from './CreateDatabaseForm'
import {
  formatBytes,
  formatCount,
  formatDatabaseDate,
  tableSummary,
} from './format'

const TEMPLATE_LABELS: Record<DatabaseInfo['template'], string> = {
  blank: 'Blank',
  example: 'Example',
  custom: 'Custom SQL',
  imported: 'Imported',
}

type ConfirmAction = { kind: 'delete' | 'reset'; info: DatabaseInfo }

/**
 * Full database manager: create, open, rename, duplicate, reset,
 * export and delete independent SQLite databases, plus import.
 */
export function DatabaseManager() {
  const open = useUIStore((state) => state.isDatabaseManagerOpen)
  const setOpen = useUIStore((state) => state.setDatabaseManagerOpen)
  const mode = useUIStore((state) => state.databaseManagerMode)
  const setMode = useUIStore((state) => state.setDatabaseManagerMode)

  const databases = useDatabaseStore((state) => state.databases)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const openDatabase = useDatabaseStore((state) => state.openDatabase)
  const renameDatabase = useDatabaseStore((state) => state.renameDatabase)
  const duplicateDatabase = useDatabaseStore((state) => state.duplicateDatabase)
  const deleteDatabase = useDatabaseStore((state) => state.deleteDatabase)
  const resetDatabase = useDatabaseStore((state) => state.resetDatabase)
  const exportDatabase = useDatabaseStore((state) => state.exportDatabase)
  const exportDatabaseSql = useDatabaseStore((state) => state.exportDatabaseSql)
  const importDatabase = useDatabaseStore((state) => state.importDatabase)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Selection is derived, so creating/deleting databases can never leave
  // the panel pointing at a record that no longer exists.
  const effectiveSelectedId =
    selectedId !== null && databases.some((database) => database.id === selectedId)
      ? selectedId
      : (activeDatabaseId ?? databases[0]?.id ?? null)
  const selected =
    databases.find((database) => database.id === effectiveSelectedId) ?? null
  const isActive = selected !== null && selected.id === activeDatabaseId

  const close = () => {
    setMode('manage')
    setRenaming(false)
    setConfirm(null)
    setError(null)
    setNotice(null)
    setOpen(false)
  }

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : 'Something went wrong.',
      )
    } finally {
      setBusy(null)
    }
  }

  const handleOpen = (info: DatabaseInfo) =>
    run(`open-${info.id}`, async () => {
      await openDatabase(info.id)
      setNotice(`Opened “${info.name}”.`)
    })

  const handleRename = () => {
    if (selected === null) return
    void run('rename', async () => {
      const updated = await renameDatabase(selected.id, renameValue)
      setRenaming(false)
      setNotice(`Renamed to “${updated.name}”.`)
    })
  }

  const handleDuplicate = () => {
    if (selected === null) return
    void run('duplicate', async () => {
      const copy = await duplicateDatabase(selected.id)
      setSelectedId(copy.id)
      setNotice(`Created “${copy.name}”.`)
    })
  }

  const handleDelete = (info: DatabaseInfo) => {
    void run('delete', async () => {
      await deleteDatabase(info.id)
      setConfirm(null)
      setSelectedId(null)
      setNotice(`Deleted “${info.name}”.`)
    })
  }

  const handleReset = (info: DatabaseInfo) => {
    void run('reset', async () => {
      await resetDatabase(info.id)
      setConfirm(null)
      setNotice(
        info.template === 'imported'
          ? `Cleared “${info.name}” to an empty database.`
          : `Reset “${info.name}” to its starting state.`,
      )
    })
  }

  const handleExportSqlite = (info: DatabaseInfo) => {
    void run('export-sqlite', async () => {
      const bytes = await exportDatabase(info.id)
      downloadFile(`${safeFileName(info.name)}.sqlite`, bytes, 'application/vnd.sqlite3')
      setNotice('Exported a SQLite database file.')
    })
  }

  const handleExportSql = (info: DatabaseInfo) => {
    void run('export-sql', async () => {
      const { sql, fileName } = await exportDatabaseSql(info.id)
      downloadFile(fileName, sql, 'application/sql')
      setNotice('Exported a SQL script (not a binary database file).')
    })
  }

  const handleImportFile = (file: File | undefined) => {
    if (!file) return
    void run('import', async () => {
      const buffer = new Uint8Array(await file.arrayBuffer())
      const info = await importDatabase({ fileName: file.name, bytes: buffer })
      setSelectedId(info.id)
      setMode('manage')
      setNotice(`Imported “${info.name}”.`)
    }).finally(() => {
      if (fileInputRef.current) fileInputRef.current.value = ''
    })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      extraWide
      title={
        <span className="inline-flex items-center gap-2">
          <Database className="size-4 text-accent" aria-hidden />
          Database Manager
        </span>
      }
    >
      <div className="flex min-h-[440px] flex-col gap-4 md:flex-row">
        {/* Database list */}
        <aside className="flex w-full shrink-0 flex-col rounded-lg border border-border bg-surface-2 md:w-64">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Databases
            </span>
            <span className="text-[10px] text-text-muted">{databases.length}</span>
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {databases.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-text-muted">
                No databases yet. Create one or import a SQLite file.
              </p>
            ) : (
              databases.map((database) => {
                const active = database.id === activeDatabaseId
                const current = database.id === selectedId
                return (
                  <button
                    key={database.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(database.id)
                      setMode('manage')
                      setRenaming(false)
                      setConfirm(null)
                      setError(null)
                      setNotice(null)
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                      current ? 'bg-surface-3' : 'hover:bg-surface-3/60'
                    }`}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        active ? 'bg-success' : 'bg-text-muted/40'
                      }`}
                      aria-label={active ? 'Active database' : 'Inactive database'}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-text-primary">
                        {database.name}
                      </span>
                      <span className="block truncate text-[10px] text-text-muted">
                        {tableSummary(database)}
                      </span>
                    </span>
                    <ChevronRight
                      className={`size-3 shrink-0 ${current ? 'text-text-secondary' : 'text-text-muted/40'}`}
                      aria-hidden
                    />
                  </button>
                )
              })
            )}
          </div>

          <div className="space-y-1.5 border-t border-border p-2">
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-3.5" />}
              className="w-full justify-center"
              onClick={() => {
                setMode('create')
                setError(null)
                setNotice(null)
              }}
            >
              Create database
            </Button>
            <Button
              size="sm"
              icon={<Upload className="size-3.5" />}
              className="w-full justify-center"
              onClick={() => fileInputRef.current?.click()}
              loading={busy === 'import'}
            >
              Import database
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3,.sql"
              className="hidden"
              onChange={(event) => handleImportFile(event.target.files?.[0])}
            />
            <p className="px-1 text-center text-[9px] leading-snug text-text-muted">
              Supports .db, .sqlite, .sqlite3 and .sql scripts.
            </p>
          </div>
        </aside>

        {/* Detail / create panel */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mode === 'create' ? (
            <>
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  Create a database
                </h3>
                <p className="text-[11px] text-text-muted">
                  Every database is an independent SQLite instance with its own storage.
                </p>
              </div>
              <CreateDatabaseForm
                onCancel={() => setMode('manage')}
                onCreated={() => {
                  setMode('manage')
                  setSelectedId(null)
                  setNotice('Database created and opened.')
                }}
              />
            </>
          ) : selected === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <Database className="size-7 text-text-muted/50" aria-hidden />
              <p className="text-sm font-medium text-text-primary">No database selected</p>
              <p className="max-w-xs text-xs leading-relaxed text-text-muted">
                Create a blank database, start from the example template, or import an
                existing SQLite file.
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  {renaming ? (
                    <form
                      className="flex max-w-sm items-center gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault()
                        handleRename()
                      }}
                    >
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        autoFocus
                        maxLength={60}
                        aria-label="New database name"
                        className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                      />
                      <Button size="sm" type="submit" variant="primary" loading={busy === 'rename'}>
                        Save
                      </Button>
                      <Button size="sm" type="button" onClick={() => setRenaming(false)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text-primary">
                      <span className="truncate">{selected.name}</span>
                      {isActive ? (
                        <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                          <CircleCheck className="size-3" aria-hidden />
                          Active
                        </span>
                      ) : (
                        <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                          Inactive
                        </span>
                      )}
                    </h3>
                  )}
                  <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                    {selected.description || 'No description.'}
                  </p>
                </div>
                {!isActive && !renaming && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<FolderOpen className="size-3.5" />}
                    loading={busy === `open-${selected.id}`}
                    onClick={() => handleOpen(selected)}
                  >
                    Open
                  </Button>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Tables" value={formatCount(selected.tableCount)} />
                <Stat label="Rows" value={formatCount(selected.rowCount)} />
                <Stat label="Size" value={formatBytes(selected.sizeBytes)} />
                <Stat label="Template" value={TEMPLATE_LABELS[selected.template]} />
              </dl>

              <dl className="mt-3 grid gap-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Created</dt>
                  <dd className="text-text-secondary">{formatDatabaseDate(selected.createdAt)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Last modified</dt>
                  <dd className="text-text-secondary">{formatDatabaseDate(selected.updatedAt)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Identity</dt>
                  <dd className="truncate font-mono text-[10px] text-text-muted">
                    {selected.id}
                  </dd>
                </div>
              </dl>

              <div className="mt-4">
                <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Actions
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    icon={<Pencil className="size-3.5" />}
                    onClick={() => {
                      setRenameValue(selected.name)
                      setRenaming(true)
                      setError(null)
                      setNotice(null)
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    icon={<Copy className="size-3.5" />}
                    loading={busy === 'duplicate'}
                    onClick={handleDuplicate}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    icon={<Download className="size-3.5" />}
                    loading={busy === 'export-sqlite'}
                    onClick={() => handleExportSqlite(selected)}
                  >
                    Export .sqlite
                  </Button>
                  <Button
                    size="sm"
                    icon={<FileCode2 className="size-3.5" />}
                    loading={busy === 'export-sql'}
                    onClick={() => handleExportSql(selected)}
                  >
                    Export .sql
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<RotateCcw className="size-3.5" />}
                    onClick={() => {
                      setConfirm({ kind: 'reset', info: selected })
                      setError(null)
                      setNotice(null)
                    }}
                  >
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="size-3.5" />}
                    onClick={() => {
                      setConfirm({ kind: 'delete', info: selected })
                      setError(null)
                      setNotice(null)
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              {confirm !== null && (
                <div className="mt-4 rounded-lg border border-danger/40 bg-danger-soft p-3">
                  <p className="flex items-start gap-2 text-[13px] leading-relaxed text-danger">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>
                      {confirm.kind === 'delete'
                        ? `Delete “${confirm.info.name}” and its stored data permanently? This cannot be undone.`
                        : `Reset “${confirm.info.name}”? ${
                            confirm.info.template === 'example'
                              ? 'It returns to the original example schema and rows.'
                              : confirm.info.template === 'custom'
                                ? 'Its setup SQL runs again from scratch.'
                                : 'Every table and row is removed, leaving an empty database.'
                          }`}
                    </span>
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button size="sm" onClick={() => setConfirm(null)} disabled={busy !== null}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="!bg-danger hover:!bg-danger/85"
                      loading={busy === 'delete' || busy === 'reset'}
                      onClick={() =>
                        confirm.kind === 'delete'
                          ? handleDelete(confirm.info)
                          : handleReset(confirm.info)
                      }
                    >
                      {confirm.kind === 'delete' ? 'Delete database' : 'Reset database'}
                    </Button>
                  </div>
                </div>
              )}

              {error && (
                <p className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
                  {error}
                </p>
              )}
              {notice && (
                <p className="mt-3 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                  {notice}
                </p>
              )}

              <p className="mt-auto pt-4 text-[10px] leading-relaxed text-text-muted">
                Import creates a new database and never overwrites an existing one.
                Exported <code>.sql</code> files are readable SQL scripts, not binary
                SQLite databases.
              </p>
            </div>
          )}

          {mode !== 'create' && error && selected === null && (
            <p className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}
          {mode !== 'create' && notice && selected === null && (
            <p className="mt-3 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
              {notice}
            </p>
          )}
        </section>
      </div>
    </Modal>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-semibold text-text-primary">{value}</dd>
    </div>
  )
}
