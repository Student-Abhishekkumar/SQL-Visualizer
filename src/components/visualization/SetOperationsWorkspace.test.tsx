// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VisualizationWorkspace } from './VisualizationWorkspace'
import { useVisualizationStore } from '../../store/visualizationStore'
import { interpretQuery } from '../../services/visualization/astInterpreter'
import { simulateQuery, type TableData } from '../../services/visualization/simulator'

const a: TableData = {
  columns: ['id', 'v'],
  rows: [[1, 'left-only'], [2, 'shared'], [2, 'shared'], [3, 'left-too']],
}
const b: TableData = {
  columns: ['id', 'v'],
  rows: [[2, 'shared'], [3, 'right-only'], [2, 'shared']],
}
const c: TableData = { columns: ['id', 'v'], rows: [[2, 'shared']] }
const d: TableData = { columns: ['id', 'v'], rows: [[4, 'final-only']] }
const TABLES = { a, b, c, d }
const MIXED = `SELECT id AS left_id, v AS label FROM a
  UNION ALL SELECT id, v FROM b
  INTERSECT SELECT id, v FROM b
  EXCEPT SELECT id, v FROM c
  UNION ALL SELECT id, v FROM d`
const getTableData = (name: string): TableData | null => TABLES[name as keyof typeof TABLES] ?? null

function traceFor(sql: string) {
  const interpretation = interpretQuery(sql, [sql])
  expect(interpretation.unsupportedReasons).toEqual([])
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

function renderTrace(sql: string) {
  const trace = traceFor(sql)
  useVisualizationStore.getState().loadTrace(trace)
  useVisualizationStore.setState({
    status: 'ready',
    validation: { validated: true, method: 'unordered' },
    actualRowCount: trace.finalRows.length,
  })
  useVisualizationStore.getState().jumpToEnd()
  render(<VisualizationWorkspace queryName={sql} onClose={() => {}} />)
  return trace
}

beforeEach(() => {
  useVisualizationStore.getState().clear()
  useVisualizationStore.setState({ status: 'idle', unavailableReasons: [], validation: null, actualRowCount: null })
})

afterEach(() => {
  cleanup()
  useVisualizationStore.getState().clear()
})

describe('set-operation workspace integration', () => {
  it('shows the final compound result and first-branch columns in Table View', () => {
    renderTrace(MIXED)
    fireEvent.click(screen.getByRole('tab', { name: /table/i }))

    expect(screen.getByText('right-only')).toBeInTheDocument()
    expect(screen.getByText('final-only')).toBeInTheDocument()
    expect(screen.getByText('left_id')).toBeInTheDocument()
    expect(screen.getByText('label')).toBeInTheDocument()
    expect(screen.queryByText('left-only')).not.toBeInTheDocument()
    expect(screen.queryByText('shared')).not.toBeInTheDocument()
  })

  it('opens an intermediate operation with its own explanation and inputs', () => {
    renderTrace(MIXED)
    fireEvent.click(screen.getByRole('button', { name: /Operation INTERSECT/ }))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText(/INTERSECT kept only distinct rows present in both inputs/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Input' }))
    expect(within(dialog).getByText('Accumulated left input')).toBeInTheDocument()
    expect(within(dialog).getByText(/Next right input/)).toBeInTheDocument()
  })

  it('opens the compound inspector and shows real left/right inputs and output', () => {
    renderTrace('SELECT id, v FROM a INTERSECT SELECT id, v FROM b')
    fireEvent.click(screen.getByRole('button', { name: /Operation INTERSECT/ }))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dialog).toBeInTheDocument()
    const inspector = within(dialog)

    fireEvent.click(inspector.getByRole('tab', { name: 'Input' }))
    expect(inspector.getByText('Accumulated left input')).toBeInTheDocument()
    expect(inspector.getByText(/Next right input/)).toBeInTheDocument()
    expect(inspector.getAllByText('left-only').length).toBeGreaterThan(0)
    expect(inspector.getAllByText('right-only').length).toBeGreaterThan(0)

    fireEvent.click(inspector.getByRole('tab', { name: 'Output' }))
    expect(inspector.getAllByText('shared').length).toBeGreaterThan(0)
    expect(inspector.queryByText('left-only')).not.toBeInTheDocument()
  })

  it('explains duplicate removal and excluded rows in Table View', () => {
    renderTrace('SELECT id, v FROM a INTERSECT SELECT id, v FROM b')
    fireEvent.click(screen.getByRole('tab', { name: /table/i }))
    expect(screen.getAllByText(/INTERSECT kept only distinct rows present in both inputs/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Removed rows/)).toBeInTheDocument()
    expect(screen.getAllByText('left-only').length).toBeGreaterThan(0)
  })

  it('handles an empty compound result in Table View', () => {
    renderTrace('SELECT id, v FROM a EXCEPT SELECT id, v FROM a')
    fireEvent.click(screen.getByRole('tab', { name: /table/i }))
    expect(screen.getByText('No rows')).toBeInTheDocument()
  })
})
