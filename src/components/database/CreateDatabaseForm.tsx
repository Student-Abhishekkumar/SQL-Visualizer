import { useState } from 'react'
import { Database, FileCode2, Table2 } from 'lucide-react'
import { useDatabaseStore } from '../../store/databaseStore'
import { validateDatabaseName } from '../../services/database/databaseManager'
import {
  DATABASE_TEMPLATES,
  type UserDatabaseTemplateId,
} from '../../services/database/templates'
import { Button } from '../common/Button'

const TEMPLATE_ICONS = {
  blank: Database,
  example: Table2,
  custom: FileCode2,
} as const

const CUSTOM_SQL_PLACEHOLDER = `CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER
);

INSERT INTO students (name, age) VALUES ('Ada', 21);`

interface CreateDatabaseFormProps {
  onCreated: () => void
  onCancel: () => void
}

/** Create-database form: name, description and starter template. */
export function CreateDatabaseForm({ onCreated, onCancel }: CreateDatabaseFormProps) {
  const createDatabase = useDatabaseStore((state) => state.createDatabase)
  const databases = useDatabaseStore((state) => state.databases)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<UserDatabaseTemplateId>('blank')
  const [setupSql, setSetupSql] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError(null)
    let validName: string
    try {
      validName = validateDatabaseName(name, databases)
    } catch (validationError) {
      setError(
        validationError instanceof Error ? validationError.message : 'Invalid database name.',
      )
      return
    }

    setBusy(true)
    try {
      await createDatabase({
        name: validName,
        description,
        template,
        setupSql: template === 'custom' ? setupSql : undefined,
      })
      onCreated()
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Could not create the database.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="database-name"
            className="block text-xs font-medium text-text-secondary"
          >
            Database name
          </label>
          <input
            id="database-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. College Database"
            autoFocus
            maxLength={60}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="database-description"
            className="block text-xs font-medium text-text-secondary"
          >
            Description <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="database-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this database for?"
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">
            Starter template
          </span>
          <div className="grid gap-2 sm:grid-cols-3">
            {DATABASE_TEMPLATES.map((option) => {
              const Icon = TEMPLATE_ICONS[option.id]
              const selected = template === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setTemplate(option.id)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    selected
                      ? 'border-accent bg-accent-soft'
                      : 'border-border bg-surface-2 hover:border-border-strong'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
                    <Icon
                      className={`size-3.5 ${selected ? 'text-accent' : 'text-text-muted'}`}
                      aria-hidden
                    />
                    {option.name}
                  </span>
                  <span className="mt-1 block text-[10px] leading-snug text-text-muted">
                    {option.description}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {template === 'custom' && (
          <div>
            <label
              htmlFor="database-setup-sql"
              className="block text-xs font-medium text-text-secondary"
            >
              Setup SQL
            </label>
            <textarea
              id="database-setup-sql"
              value={setupSql}
              onChange={(event) => setSetupSql(event.target.value)}
              placeholder={CUSTOM_SQL_PLACEHOLDER}
              rows={8}
              spellCheck={false}
              className="mt-1.5 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-text-muted">
              Statements run once when the database is created and again when it is reset.
            </p>
          </div>
        )}

        {template === 'example' && (
          <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-text-secondary">
            Adds the optional University sample tables (employees, departments,
            projects, employee_projects) with seed rows. You can edit or drop them later.
          </p>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} icon={<Database className="size-3.5" />}>
          Create database
        </Button>
      </div>
    </form>
  )
}
