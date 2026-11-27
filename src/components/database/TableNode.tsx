import { useState } from 'react'
import { ChevronRight, KeyRound, Link2, Table2 } from 'lucide-react'
import type { TableSchema } from '../../types/database'

interface TableNodeProps {
  table: TableSchema
  /** Clicking the table name opens the schema viewer. */
  onOpenSchema: (tableName: string) => void
}

/** One expandable table entry with its typed columns, PK/FK markers. */
export function TableNode({ table, onOpenSchema }: TableNodeProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="select-none">
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-2">
        <button
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} table ${table.name}`}
          className="-ml-0.5 flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronRight
            className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        <button
          onClick={() => onOpenSchema(table.name)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={`View schema of ${table.name}`}
        >
          <Table2 className="size-3.5 shrink-0 text-accent/80" />
          <span className="truncate text-[13px] font-medium text-text-secondary group-hover:text-text-primary">
            {table.name}
          </span>
        </button>
        <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
          {table.rowCount}
        </span>
      </div>

      {expanded && (
        <ul className="mb-1 ml-5 border-l border-border pl-2">
          {table.columns.map((column) => (
            <li
              key={column.name}
              className="flex items-center gap-1.5 rounded px-1 py-[3px] hover:bg-surface-2"
              title={
                column.foreignKey
                  ? `References ${column.foreignKey.table}.${column.foreignKey.column}`
                  : column.isPrimaryKey
                    ? 'Primary key'
                    : undefined
              }
            >
              {column.isPrimaryKey ? (
                <KeyRound className="size-3 shrink-0 text-warning" />
              ) : column.isForeignKey ? (
                <Link2 className="size-3 shrink-0 text-accent" />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span className="truncate font-mono text-[12px] text-text-secondary">
                {column.name}
              </span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                {column.type}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
