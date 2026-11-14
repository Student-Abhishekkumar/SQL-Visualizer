// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  StageSnapshot,
  VisualizationEvent,
  VisualizationTrace,
} from '../../types/visualization'
import { VisualizationWorkspace } from './VisualizationWorkspace'
import { useVisualizationStore } from '../../store/visualizationStore'

/**
 * UI behavior tests for the visualization workspace: pipeline stage
 * selection, snapshot rendering, unsupported-query handling and
 * validation warnings. Store state is driven through the real store
 * actions — no component props short-circuits.
 */

function stageSnapshot(stage: StageSnapshot['stage'], rowCount: number): StageSnapshot {
  return {
    stage,
    label: `${stage} stage`,
    columns: ['name', 'salary'],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: `r${index + 1}`,
      values: [`Emp${index + 1}`, 50000 + index * 1000],
    })),
    removedRows:
      stage === 'WHERE'
        ? [{ id: 'rX', values: ['Filtered', 1000] }]
        : [],
    roles: stage === 'WHERE' ? { rX: 'filtered', r1: 'accepted' } : {},
    groups: [],
    explanation: `${stage} applied.`,
    inputRowCount: rowCount + 1,
    outputRowCount: rowCount,
    truncated: false,
  }
}

function event(
  type: VisualizationEvent['type'],
  stage: VisualizationEvent['stage'],
  index: number,
  snapshot?: StageSnapshot,
): VisualizationEvent {
  return {
    id: `evt${index + 1}`,
    type,
    description: `${type} on ${stage ?? 'query'}`,
    stage,
    snapshot,
  }
}

function makeTrace(): VisualizationTrace {
  const events: VisualizationEvent[] = [
    event('QUERY_STARTED', null, 0),
    event('SOURCE_TABLE_LOADED', 'FROM', 1),
    event('ROW_EVALUATED', 'WHERE', 2),
    event('STAGE_COMPLETED', 'FROM', 3, stageSnapshot('FROM', 4)),
    event('ROW_FILTERED', 'WHERE', 4),
    event('STAGE_COMPLETED', 'WHERE', 5, stageSnapshot('WHERE', 3)),
    event('STAGE_COMPLETED', 'SELECT', 6, stageSnapshot('SELECT', 3)),
    event('QUERY_VISUALIZATION_COMPLETED', null, 7),
  ]
  return {
    query: 'SELECT name, salary FROM employees WHERE salary > 50000',
    statementType: 'SELECT',
    capability: {
      supported: true,
      supportedStages: ['FROM', 'WHERE', 'SELECT'],
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
    stages: ['FROM', 'WHERE', 'SELECT'],
    events,
    stageSnapshots: [stageSnapshot('FROM', 4), stageSnapshot('WHERE', 3), stageSnapshot('SELECT', 3)],
    sourceTables: [
      {
        name: 'employees',
        alias: null,
        columns: ['name', 'salary'],
        rowCount: 8,
        previewRows: [{ id: 'employees#1', values: ['Emp1', 50000] }],
        role: 'from',
        joinType: null,
        on: null,
      },
    ],
    totalSteps: events.length,
    finalRows: [],
    finalColumns: ['name', 'salary'],
    hasDeterministicOrder: false,
    truncated: false,
  }
}

function resetStore(): void {
  useVisualizationStore.getState().clear()
  useVisualizationStore.setState({ status: 'idle', unavailableReasons: [], validation: null, actualRowCount: null })
}

beforeEach(() => {
  resetStore()
})

afterEach(() => {
  cleanup()
  resetStore()
})

describe('unsupported query handling', () => {
  it('shows the unsupported reasons and the SQLite execution note', () => {
    useVisualizationStore.setState({
      status: 'unsupported',
      unavailableReasons: ['SELECT expression "ABS(salary)" is not visualizable yet.'],
      actualRowCount: 8,
    })
    render(<VisualizationWorkspace queryName="SELECT ABS(salary) FROM employees" onClose={() => {}} />)

    expect(screen.getAllByText('Cannot visualize this query').length).toBeGreaterThan(0)
    expect(
      screen.getByText('SELECT expression "ABS(salary)" is not visualizable yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/SQLite still executed the query normally/),
    ).toBeInTheDocument()
  })

  it('shows guidance when nothing was visualized yet', () => {
    render(<VisualizationWorkspace queryName="" onClose={() => {}} />)
    expect(screen.getAllByText('No visualization yet').length).toBeGreaterThan(0)
    expect(screen.getByText(/Run a single SELECT query/)).toBeInTheDocument()
  })

  it('shows the database-not-ready reason when the DB is unavailable', () => {
    useVisualizationStore.setState({
      status: 'unavailable',
      unavailableReasons: ['The database is not ready yet. Run a query first, then visualize.'],
    })
    render(<VisualizationWorkspace queryName="" onClose={() => {}} />)
    expect(screen.getAllByText('Database not ready').length).toBeGreaterThan(0)
    expect(screen.getByText(/database is not ready/)).toBeInTheDocument()
  })
})

describe('ready workspace', () => {
  it('renders pipeline stages, the snapshot table and the validated badge', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({
      status: 'ready',
      validation: { validated: true, method: 'ordered', actualColumns: ['name', 'salary'], actualRowCount: 3 },
      actualRowCount: 3,
    })
    useVisualizationStore.getState().seek(5) // WHERE completed

    render(<VisualizationWorkspace queryName="WHERE demo" onClose={() => {}} />)

    expect(screen.getAllByText('Simulation ready').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Validated (ordered) vs SQLite').length).toBeGreaterThan(0)
    expect(screen.getByText('SQLite returned 3 rows')).toBeInTheDocument()

    // Snapshot table details live in Table View.
    await user.click(screen.getByRole('tab', { name: /table/i }))
    expect(screen.getAllByText('Emp1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('51000').length).toBeGreaterThan(0)
    // Removed row from the WHERE snapshot is shown in its own section.
    expect(screen.getByText(/Removed rows/)).toBeInTheDocument()
    expect(screen.getByText('Filtered')).toBeInTheDocument()
  })

  it('pipeline stage selection inspects that stage and seeks to it (Table View)', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().jumpToEnd()

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    // Switch to Table View — the inspecting badge lives there.
    await user.click(screen.getByRole('tab', { name: /table/i }))

    const pipeline = screen.getByRole('navigation', { name: 'Execution pipeline' })
    const whereButton = Array.from(pipeline.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('WHERE'),
    )
    expect(whereButton).toBeDefined()
    expect(whereButton?.disabled).toBe(false)

    await user.click(whereButton!)

    // The inspected stage's snapshot replaces the live one.
    expect(screen.getByText(/inspecting/)).toBeInTheDocument()
    expect(screen.getAllByText('Filtered').length).toBeGreaterThan(0)
    // Seeking moved playback to the WHERE completion event.
    expect(useVisualizationStore.getState().eventIndex).toBe(5)
  })

  it('pending stages are clickable and jump the playback forward to them', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    const pipeline = screen.getByRole('navigation', { name: 'Execution pipeline' })
    const selectButton = Array.from(pipeline.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('SELECT'),
    )
    expect(selectButton).toBeDefined()
    expect(selectButton?.disabled).toBe(false)

    selectButton!.click()

    // Playback jumped to the SELECT completion event.
    expect(useVisualizationStore.getState().eventIndex).toBe(6)
    // The clicked stage is selected in the pipeline and its snapshot
    // data is visible in the graph state (stage completed after seek).
    expect(useVisualizationStore.getState().viewState.completedStages.map((snapshot) => snapshot.stage)).toContain('SELECT')
  })

  it('shows a warning banner when validation failed', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({
      status: 'ready',
      validation: {
        validated: false,
        method: 'unordered',
        detail: 'Row count differs: simulation produced 3, SQLite produced 4.',
        actualColumns: ['name', 'salary'],
        actualRowCount: 4,
      },
    })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    expect(
      screen.getByText(/Not validated against SQLite: Row count differs/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Validated/)).not.toBeInTheDocument()
  })

  it('shows the truncation warning for capped tables', () => {
    const store = useVisualizationStore.getState()
    const trace = makeTrace()
    useVisualizationStore.setState({})
    store.loadTrace({ ...trace, truncated: true })
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    expect(screen.getByText(/visualization is capped/)).toBeInTheDocument()
  })

  it('playback next/previous buttons drive the real store', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Next event' }))
    expect(useVisualizationStore.getState().eventIndex).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Next event' }))
    expect(useVisualizationStore.getState().eventIndex).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Previous event' }))
    expect(useVisualizationStore.getState().eventIndex).toBe(1)

    // Position counter reflects the folded view state.
    expect(screen.getByText('2/8')).toBeInTheDocument()
  })

  it('jump-to-end marks playback finished and enables Replay', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Jump to final result' }))
    expect(useVisualizationStore.getState().finished).toBe(true)
    expect(screen.getByRole('button', { name: 'Replay' })).toBeInTheDocument()
  })

  it('close returns to the results mode', async () => {
    const user = userEvent.setup()
    let closed = false
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(
      <VisualizationWorkspace
        queryName="demo"
        onClose={() => {
          closed = true
        }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Back to results' }))
    expect(closed).toBe(true)
  })
})

describe('Flow View behavior', () => {
  it('is the default mode and renders source and operation nodes from the trace', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    // Flow tab is selected by default.
    expect(screen.getByRole('tab', { name: /flow/i })).toHaveAttribute('aria-selected', 'true')
    // Source table node from the real sourceTables metadata.
    expect(screen.getByLabelText(/Source table employees, 8 rows/)).toBeInTheDocument()
    // Operation nodes for the pipeline stages.
    expect(screen.getByLabelText(/Operation WHERE/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Operation SELECT/)).toBeInTheDocument()
  })

  it('hides the rejected branch until WHERE completes, then shows real counts', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    // WHERE not completed → no rejected branch node.
    expect(screen.queryByLabelText(/Rejected rows \(1\)/)).not.toBeInTheDocument()

    act(() => {
      useVisualizationStore.getState().seekToStage('WHERE')
    })
    expect(screen.getByLabelText(/Rejected rows \(1\)/)).toBeInTheDocument()
  })

  it('clicking a data node opens the inspector with the real snapshot rows', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().seekToStage('WHERE')

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const inspector = screen.getByRole('complementary', { name: 'Node inspector' })
    expect(inspector).toBeInTheDocument()
    // Real snapshot rows appear inside the inspector (and the canvas node).
    expect(screen.getAllByText('Emp1').length).toBeGreaterThan(0)
    // Closing returns to the explanation panel.
    await user.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(screen.queryByRole('complementary', { name: 'Node inspector' })).not.toBeInTheDocument()
  })

  it('switching to Table View keeps the playback position', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().seek(4)

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByRole('tab', { name: /table/i }))
    await user.click(screen.getByRole('tab', { name: /flow/i }))
    // Playback position untouched by view switching.
    expect(useVisualizationStore.getState().eventIndex).toBe(4)
  })
})
