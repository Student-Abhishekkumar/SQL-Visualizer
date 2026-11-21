// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SQLiteDatabase } from '../../services/database/sqliteService'
import { simulateAndValidate } from '../../services/visualization/validation'
import { TransformationPanel } from './TransformationPanel'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
})
afterEach(() => db.close())

function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok).toBe(true)
  if (!outcome.simulation.ok) throw new Error(outcome.simulation.reasons.join('; '))
  return outcome.simulation.trace
}

describe('DDL Table View integration', () => {
  it('renders real schema columns and the isolated-preview description', () => {
    const trace = traceOf('CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT)')
    const snapshot = trace.stageSnapshots.find((candidate) => candidate.stage === 'COLUMN_DEFINITIONS')
    expect(snapshot).toBeDefined()
    if (snapshot === undefined) return
    render(<TransformationPanel snapshot={snapshot} activeStage={null} inspecting={false} />)

    expect(screen.getByText('Real column definitions from PRAGMA table_xinfo.')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'declared_type' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'id' })).toBeInTheDocument()
    expect(screen.getAllByRole('cell', { name: 'INTEGER' }).length).toBeGreaterThan(0)
    expect(screen.getByText('1 in')).toBeInTheDocument()
    expect(screen.getByText('2 out')).toBeInTheDocument()
  })
})
