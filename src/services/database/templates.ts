import type { DatabaseTemplateId } from '../../types/database'
import { SCHEMA_SQL, SEED_SQL, UNIVERSITY_DB_NAME } from './seedData'

/**
 * Starter templates for new databases.
 *
 * Only the explicit "example" template seeds sample data — blank and
 * custom databases stay exactly as the user leaves them.
 */

export type UserDatabaseTemplateId = Exclude<DatabaseTemplateId, 'imported'>

export interface DatabaseTemplate {
  id: UserDatabaseTemplateId
  name: string
  description: string
}

export const DATABASE_TEMPLATES: readonly DatabaseTemplate[] = [
  {
    id: 'blank',
    name: 'Blank database',
    description: 'An empty SQLite database. Create your own tables with SQL.',
  },
  {
    id: 'example',
    name: 'Example database',
    description:
      'The University sample schema: employees, departments, projects and employee_projects.',
  },
  {
    id: 'custom',
    name: 'Custom SQL setup',
    description: 'Initialise the database by running your own SQL statements.',
  },
] as const

/** Name given to the default example database on first run. */
export const EXAMPLE_DATABASE_NAME = UNIVERSITY_DB_NAME

/** Description used for the default example database on first run. */
export const EXAMPLE_DATABASE_DESCRIPTION =
  'Sample University schema and data. Safe to modify or delete.'

/**
 * SQL executed once when a database is created from a template (and
 * replayed when an example/custom database is reset).
 */
export function templateSetupSql(
  template: DatabaseTemplateId,
  setupSql?: string,
): string {
  switch (template) {
    case 'example':
      return `${SCHEMA_SQL}\n${SEED_SQL}`
    case 'custom':
      return setupSql ?? ''
    case 'imported':
    case 'blank':
    default:
      return ''
  }
}
