import { useState } from 'react'
import { Database, RefreshCw, Table2 } from 'lucide-react'
import { useDatabaseStore } from '../../store/databaseStore'
import { TableNode } from './TableNode'
import { SchemaViewer } from './SchemaViewer'
import { Tooltip } from '../common/Tooltip'
import { getLiveDatabase } from '../../services/database/databaseInitializer'

/** Left sidebar section: live database schema browser. */
export function DatabaseExplorer() {
  const schema = useDatabaseStore((state) => state.schema)
  const refreshSchema = useDatabaseStore((state) => state.refreshSchema)
  const [viewerTable, setViewerTable] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Database Explorer
        </span>
        <Tooltip label="Refresh schema">
          <button
            onClick={refreshSchema}
            aria-label="Refresh database schema"
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5">
        <Database className="size-3.5 shrink-0 text-accent" />
        <span className="truncate text-[12px] font-medium text-text-secondary">
          {schema?.name ?? 'Loading…'}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-success">
          <span className="size-1.5 rounded-full bg-success" />
          Live
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!schema ? (
          <p className="px-2 py-4 text-xs text-text-muted">
            Database is initializing…
          </p>
        ) : schema.tables.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <Table2 className="mx-auto mb-2 size-6 text-text-muted/50" />
            <p className="text-xs text-text-muted">
              No tables. Create one with a CREATE TABLE statement.
            </p>
          </div>
        ) : (
          schema.tables.map((table) => (
            <TableNode
              key={table.name}
              table={table}
              onOpenSchema={setViewerTable}
            />
          ))
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
