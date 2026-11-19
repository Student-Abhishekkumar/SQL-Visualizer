// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { QueryExecutionResult } from '../../types/query'
import { MessagesPanel } from './MessagesPanel'

afterEach(cleanup)

describe('MessagesPanel transaction outcomes', () => {
  it('distinguishes post-commit persistence failure from a failed SQL statement', () => {
    const result: QueryExecutionResult = {
      success: false,
      query: 'CREATE TABLE items (id INTEGER PRIMARY KEY)',
      columns: [],
      rows: [],
      rowCount: 0,
      executionTime: 1,
      statementType: 'CREATE',
      statements: [{
        statement: 'CREATE TABLE items (id INTEGER PRIMARY KEY)',
        statementType: 'CREATE',
        columns: [],
        rows: [],
        values: [],
        rowCount: 0,
        rowsModified: 0,
        hasResultSet: false,
        executionTime: 1,
      }],
      committed: true,
      rolledBack: false,
      persistencePending: true,
      persistenceError: 'The database snapshot could not be saved.',
      error: 'SQLite committed, but persistence failed: The database snapshot could not be saved.',
    }

    render(<MessagesPanel result={result} />)

    expect(screen.getByText('SQLite committed; persistence failed')).toBeInTheDocument()
    expect(screen.queryByText(/Statement #\d+ failed/i)).not.toBeInTheDocument()
    expect(screen.getByText(/#1 CREATE/)).toBeInTheDocument()
  })
})
