// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { interpretQuery } from '../../services/visualization/astInterpreter'
import { blocksOf } from '../../services/visualization/queryBlocks'
import { simulateQuery, type TableData } from '../../services/visualization/simulator'
import { PipelinePanel } from './PipelinePanel'

const departments: TableData = {
  columns: ['id', 'department_name'],
  rows: [
    [1, 'Engineering'],
    [2, 'Sales'],
  ],
}

const employees: TableData = {
  columns: ['id', 'name', 'department_id'],
  rows: [
    [1, 'Ravi', 1],
    [2, 'Priya', 2],
  ],
}

const TABLES: Record<string, TableData> = { employees, departments }

function traceFor(sql: string) {
  const interpretation = interpretQuery(sql, [sql])
  expect(interpretation.unsupportedReasons).toEqual([])
  const outcome = simulateQuery(sql, interpretation.structure!, (name) => TABLES[name] ?? null)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

describe('subquery blocks in the pipeline selector', () => {
  it('lists an IN subquery as its own query block', () => {
    const trace = traceFor(
      'SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments)',
    )
    render(
      <PipelinePanel
        stages={trace.stages}
        completedByStage={new Map()}
        activeStage={null}
        selectedStage={null}
        onSelectStage={vi.fn()}
        blocks={blocksOf(trace)}
        onSelectBlock={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Query block' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /IN subquery/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Outer query/ })).toBeInTheDocument()
  })

  it('lists an EXISTS subquery as its own query block', () => {
    const trace = traceFor(
      'SELECT id FROM employees WHERE EXISTS (SELECT 1 FROM departments WHERE id = 1)',
    )
    render(
      <PipelinePanel
        stages={trace.stages}
        completedByStage={new Map()}
        activeStage={null}
        selectedStage={null}
        onSelectStage={vi.fn()}
        blocks={blocksOf(trace)}
        onSelectBlock={vi.fn()}
      />,
    )
    expect(screen.getByRole('option', { name: /EXISTS subquery/ })).toBeInTheDocument()
  })
})