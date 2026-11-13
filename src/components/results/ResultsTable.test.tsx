/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResultsTable } from './ResultsTable'
import type { StatementResult } from '../../types/query'

function makeStatement(
  overrides: Partial<StatementResult> = {},
): StatementResult {
  return {
    statement: 'SELECT * FROM employees',
    statementType: 'SELECT',
    columns: ['id', 'name', 'salary'],
    rows: [],
    values: [
      [1, 'Rahul', 45000],
      [2, 'Priya', null],
    ],
    rowCount: 2,
    rowsModified: null,
    hasResultSet: true,
    executionTime: 1.5,
    ...overrides,
  }
}

describe('ResultsTable', () => {
  it('renders column headers with real values', () => {
    const { container } = render(<ResultsTable result={makeStatement()} />)
    expect(screen.getByText('id')).toBeInTheDocument()
    expect(screen.getByText('name')).toBeInTheDocument()
    expect(screen.getByText('salary')).toBeInTheDocument()
    expect(screen.getByText('Rahul')).toBeInTheDocument()
    expect(screen.getByText('45000')).toBeInTheDocument()
    // One row-number cell per row in the first column.
    const rowNumbers = container.querySelectorAll('tbody tr td:first-child')
    expect(rowNumbers).toHaveLength(2)
    expect(rowNumbers[0]?.textContent).toBe('1')
    expect(rowNumbers[1]?.textContent).toBe('2')
  })

  it('renders NULL values distinctly', () => {
    render(<ResultsTable result={makeStatement()} />)
    expect(screen.getByText('NULL')).toBeInTheDocument()
  })

  it('shows an empty state when no result exists yet', () => {
    render(<ResultsTable result={null} />)
    expect(screen.getByText('No results yet')).toBeInTheDocument()
  })

  it('shows a distinct state for zero matching rows', () => {
    const zeroRows = makeStatement({ rowCount: 0, values: [] })
    render(<ResultsTable result={zeroRows} />)
    expect(screen.getByText('Query returned no rows')).toBeInTheDocument()
  })

  it('shows success state for statements without a result set', () => {
    const insert = makeStatement({
      statementType: 'INSERT',
      hasResultSet: false,
      columns: [],
      values: [],
      rowsModified: 1,
    })
    render(<ResultsTable result={insert} />)
    expect(screen.getByText('Statement executed successfully')).toBeInTheDocument()
  })

  it('renders duplicate column names from joins', () => {
    const joined = makeStatement({
      columns: ['id', 'id', 'name'],
      values: [[1, 10, 'x']],
    })
    const { container } = render(<ResultsTable result={joined} />)
    const headers = container.querySelectorAll('thead th')
    expect(headers.length).toBe(4) // row number + 3 columns
  })

  it('formats blob values', () => {
    const blob = makeStatement({
      columns: ['data'],
      values: [[new Uint8Array([1, 2, 3])]],
    })
    render(<ResultsTable result={blob} />)
    expect(screen.getByText('BLOB (3 bytes)')).toBeInTheDocument()
  })
})
