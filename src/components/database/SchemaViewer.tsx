import { KeyRound, Link2, Table2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import type { DatabaseSchema } from '../../types/database'
import type { SQLiteDatabase } from '../../services/database/sqliteService'
import { quoteIdentifier } from '../../services/database/schemaService'

interface SchemaViewerProps {
  tableName: string | null
  schema: DatabaseSchema | null
  db: SQLiteDatabase | null
  onClose: () => void
}

/**
 * Table details: full column list with constraints plus a live sample
 * of the first rows, queried directly from SQLite.
 */
export function SchemaViewer({ tableName, schema, db, onClose }: SchemaViewerProps) {
  if (!tableName) return null

  const table =
    schema?.tables.find((candidate) => candidate.name === tableName) ?? null

  // Live sample queried at render time — the modal opens rarely, so no
  // memoization is needed, and it always reflects the current database.
  let sample: { columns: string[]; values: unknown[][] } | null = null
  if (db && table) {
    try {
      sample = db.queryAll(
        `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT 5`,
      )
    } catch {
      sample = null
    }
  }

  return (
    <Modal
      open={tableName !== null}
      onClose={onClose}
      wide
      title={
        <span className="inline-flex items-center gap-2">
          <Table2 className="size-4 text-accent" />
          <span className="font-mono">{tableName}</span>
          {table && (
            <span className="text-xs font-normal text-text-muted">
              {table.columns.length} columns · {table.rowCount} rows
            </span>
          )}
        </span>
      }
    >
      {!table ? (
        <p className="text-sm text-text-muted">Table no longer exists.</p>
      ) : (
        <>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="py-1.5 pr-3 font-medium">Column</th>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 pr-3 font-medium">Constraints</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((column) => (
                <tr key={column.name} className="border-b border-border/60">
                  <td className="py-1.5 pr-3 font-mono text-text-primary">
                    {column.name}
                  </td>
                  <td className="py-1.5 pr-3 text-text-secondary">{column.type}</td>
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex flex-wrap gap-1">
                      {column.isPrimaryKey && (
                        <Constraint icon={<KeyRound className="size-3" />} text="PK" tone="warning" />
                      )}
                      {column.isForeignKey && column.foreignKey && (
                        <Constraint
                          icon={<Link2 className="size-3" />}
                          text={`FK → ${column.foreignKey.table}.${column.foreignKey.column}`}
                          tone="accent"
                        />
                      )}
                      {column.notNull && <Constraint text="NOT NULL" tone="muted" />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {table.indexes.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Indexes &amp; constraints
              </h3>
              <ul className="space-y-1">
                {table.indexes.map((index) => (
                  <li
                    key={index.name}
                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]"
                  >
                    <span className="font-mono text-text-primary">{index.name}</span>
                    <span className="font-mono text-[11px] text-text-muted">
                      ({index.columns.join(', ')})
                    </span>
                    {index.unique && <Constraint text="UNIQUE" tone="accent" />}
                    {index.origin === 'pk' && <Constraint text="PRIMARY KEY" tone="warning" />}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {table.sql && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                CREATE statement
              </h3>
              <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-text-secondary">
                {table.sql}
              </pre>
            </div>
          )}

          {sample && sample.columns.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Sample rows (first 5)
              </h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-max min-w-full text-[12px]">
                  <thead>
                    <tr className="bg-surface-2">
                      {sample.columns.map((column, index) => (
                        <th
                          key={`${column}-${index}`}
                          className="border-b border-border px-2.5 py-1.5 text-left font-mono font-medium text-text-primary"
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.values.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((value, columnIndex) => (
                          <td
                            key={columnIndex}
                            className="border-b border-border/60 px-2.5 py-1.5 font-mono text-text-secondary"
                          >
                            {value === null ? (
                              <span className="italic text-text-muted">NULL</span>
                            ) : (
                              String(value)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function Constraint({
  icon,
  text,
  tone,
}: {
  icon?: React.ReactNode
  text: string
  tone: 'warning' | 'accent' | 'muted'
}) {
  const tones = {
    warning: 'border-warning/40 text-warning',
    accent: 'border-accent/40 text-accent',
    muted: 'border-border text-text-muted',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {icon}
      {text}
    </span>
  )
}
