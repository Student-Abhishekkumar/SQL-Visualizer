import { useState } from 'react'
import { Database, Plus, RefreshCw, Settings2, Table2 } from 'lucide-react'
import { useDatabaseStore } from '../../store/databaseStore'
import { useUIStore } from '../../store/uiStore'
import { TableNode } from './TableNode'
import { SchemaViewer } from './SchemaViewer'
import { Tooltip } from '../common/Tooltip'
import { getLiveDatabase } from '../../services/database/databaseManager'

/** Left sidebar section: live schema browser for the active database. */
export function DatabaseExplorer() {
  const schema = useDatabaseStore((state) => state.schema)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const databases = useDatabaseStore((state) => state.databases)
  const refreshSchema = useDatabaseStore((state) => state.refreshSchema)
  const setManagerOpen = useUIStore((state) => state.setDatabaseManagerOpen)
  const [viewerTable, setViewerTable] = useState<string | null>(null)

  const active = databases.find((database) => database.id === activeDatabaseId) ?? null
  const totalRows = schema?.tables.reduce((total, table) => total + table.rowCount, 0) ?? 0
  const hasDatabase = activeDatabaseId !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Database Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip label="Manage databases" align="end">
            <button
              onClick={() => setManagerOpen(true)}
              aria-label="Manage databases"
              className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Settings2 className="size-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="Refresh schema" align="end">
            <button
              onClick={refreshSchema}
              aria-label="Refresh database schema"
              className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mx-3 mb-2 rounded-md border border-border bg-surface-2 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Database className="size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-secondary">
            {active?.name ?? (hasDatabase ? 'Loading…' : 'No database selected')}
          </span>
          {hasDatabase && (
            <span className="flex items-center gap-1 text-[10px] text-success">
              <span className="size-1.5 rounded-full bg-success" />
              Live
            </span>
          )}
        </div>
        {schema && (
          <div className="mt-0.5 pl-5 text-[10px] text-text-muted">
            {schema.tables.length} table{schema.tables.length === 1 ? '' : 's'} ·{' '}
            {totalRows} row{totalRows === 1 ? '' : 's'}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!schema ? (
          <div className="px-2 py-6 text-center">
            <Database className="mx-auto mb-2 size-6 text-text-muted/50" />
            <p className="text-xs text-text-muted">
              {hasDatabase
                ? 'Database is initializing…'
                : 'No database is open. Create one to start working with SQL.'}
            </p>
            {!hasDatabase && (
              <button
                type="button"
                onClick={() => setManagerOpen(true)}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface-3 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
              >
                <Plus className="size-3" aria-hidden />
                Create database
              </button>
            )}
          </div>
        ) : schema.tables.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <Table2 className="mx-auto mb-2 size-6 text-text-muted/50" />
            <p className="text-xs text-text-muted">
              No tables yet. Create one with a CREATE TABLE statement.
            </p>
          </div>
        ) : (
          <>
            {schema.tables.map((table) => (
              <TableNode
                key={table.name}
                table={table}
                onOpenSchema={setViewerTable}
              />
            ))}
            {(schema.views.length > 0 || schema.triggers.length > 0) && (
              <div className="mt-2 border-t border-border px-2 pt-2 text-[10px] text-text-muted">
                {schema.views.length > 0 && (
                  <div>
                    {schema.views.length} view{schema.views.length === 1 ? '' : 's'}
                  </div>
                )}
                {schema.triggers.length > 0 && (
                  <div>
                    {schema.triggers.length} trigger{schema.triggers.length === 1 ? '' : 's'}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <SchemaViewer
        tableName={viewerTable}
        schema={schema}
        db={getLiveDatabase()}
        onClose={() => setViewerTable(null)}
      />
    </div>
  )
}
