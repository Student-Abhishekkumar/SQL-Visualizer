// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    await user.click(screen.getByRole('button', { name: 'Back to query' }))
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
    const inspector = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(inspector).toBeInTheDocument()
    // Real snapshot rows appear inside the inspector (and the canvas node).
    expect(screen.getAllByText('Emp1').length).toBeGreaterThan(0)
    // Closing returns to the explanation panel.
    await user.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
  })

  it('selecting a node traces its path without moving playback', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().seekToStage('WHERE')
    const before = useVisualizationStore.getState().eventIndex
    const playingBefore = useVisualizationStore.getState().playing

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    // The click leaves the pointer over the node, which shows the temporary
    // hover trace. Leaving restores the pinned selection trace.
    fireEvent.pointerLeave(screen.getByLabelText(/Intermediate result after WHERE/))

    // Selection is inspection-only: the simulator never advances.
    expect(useVisualizationStore.getState().eventIndex).toBe(before)
    expect(useVisualizationStore.getState().playing).toBe(playingBefore)
    expect(
      document.querySelector('[data-selected-node]')?.getAttribute('data-selected-node'),
    ).toBe('data-WHERE')
    expect(document.querySelector('[data-selected-path="true"]')).not.toBeNull()
    // Node inspection is independent of the documentation sidebar and
    // must not force it closed or replace the canvas.
    expect(
      screen.getByRole('button', { name: 'Toggle documentation sidebar' }),
    ).toHaveAttribute('aria-pressed', 'true')
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

  it('timeline seeking and jump-to-end clear a pinned stage inspection', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().jumpToEnd()

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByRole('tab', { name: /table/i }))

    const inspectWhere = async (): Promise<void> => {
      const pipeline = screen.getByRole('navigation', { name: 'Execution pipeline' })
      const whereButton = Array.from(pipeline.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('WHERE'),
      )
      await user.click(whereButton!)
    }

    await inspectWhere()
    expect(screen.getByText(/inspecting/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Timeline position'), { target: { value: '2' } })
    expect(useVisualizationStore.getState().eventIndex).toBe(2)
    expect(screen.queryByText(/inspecting/)).not.toBeInTheDocument()

    await inspectWhere()
    expect(screen.getByText(/inspecting/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Jump to final result' }))
    expect(useVisualizationStore.getState().finished).toBe(true)
    expect(screen.queryByText(/inspecting/)).not.toBeInTheDocument()
  })

  it('clicking the selected node again deselects it without moving playback', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.setState({ status: 'ready' })
    useVisualizationStore.getState().seekToStage('WHERE')

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    const dataNode = screen.getByLabelText(/Intermediate result after WHERE/)
    await user.click(dataNode)
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toBeInTheDocument()
    const selectedIndex = useVisualizationStore.getState().eventIndex

    await user.click(dataNode)
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
    expect(useVisualizationStore.getState().eventIndex).toBe(selectedIndex)
  })

  it('does not reveal final rows in the inspector before playback produces them', async () => {
    const user = userEvent.setup()
    const store = useVisualizationStore.getState()
    store.loadTrace({
      ...makeTrace(),
      finalRows: [{ id: 'f1', values: ['FinalOnly', 99999] }],
      finalColumns: ['name', 'salary'],
    })
    useVisualizationStore.setState({ status: 'ready' })

    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByLabelText('Final result (pending)'))
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toBeInTheDocument()
    expect(screen.queryByText('FinalOnly')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Jump to final result' }))
    expect(screen.getAllByText('FinalOnly').length).toBeGreaterThan(0)
  })
})

/**
 * Floating Node Inspector integration: one draggable, resizable window
 * over the canvas, driven by node clicks.
 */

function installWorkspaceBounds(
  width: number,
  height: number,
): { resize: (w: number, h: number) => void; restore: () => void } {
  const originalRect = Element.prototype.getBoundingClientRect
  let size = { width, height }
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this instanceof HTMLElement && this.hasAttribute('data-inspector-layer')) {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: size.width,
        bottom: size.height,
        width: size.width,
        height: size.height,
        toJSON: () => ({}),
      } as DOMRect
    }
    return originalRect.call(this)
  }
  const originalResizeObserver = globalThis.ResizeObserver
  class ResizeObserverMock {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(): void {
      this.callback([], this as unknown as ResizeObserver)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
  return {
    resize: (w, h) => {
      size = { width: w, height: h }
      fireEvent(window, new Event('resize'))
    },
    restore: () => {
      Element.prototype.getBoundingClientRect = originalRect
      globalThis.ResizeObserver = originalResizeObserver
    },
  }
}

function readyWorkspace(): void {
  const store = useVisualizationStore.getState()
  store.loadTrace(makeTrace())
  useVisualizationStore.setState({ status: 'ready' })
  useVisualizationStore.getState().seekToStage('WHERE')
}

describe('Floating node inspector', () => {
  let bounds: ReturnType<typeof installWorkspaceBounds>

  beforeEach(() => {
    bounds = installWorkspaceBounds(1000, 800)
  })

  afterEach(() => {
    bounds.restore()
  })

  it('opens a single popup and reuses it when another node is clicked', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const dialogs = screen.getAllByRole('dialog', { name: 'Node inspector' })
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveAttribute('data-node-id', 'data-WHERE')

    await user.click(screen.getByLabelText(/Operation SELECT/))
    const after = screen.getAllByRole('dialog', { name: 'Node inspector' })
    expect(after).toHaveLength(1)
    expect(after[0]).toHaveAttribute('data-node-id', 'op-SELECT')
  })

  it('closes with the close button and restores position and size on reopen', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const first = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = first.style.left
    const width = first.style.width

    await user.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const reopened = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(reopened.style.left).toBe(left)
    expect(reopened.style.width).toBe(width)
  })

  it('keeps position and size when selecting another node', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const first = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = first.style.left
    const width = first.style.width

    await user.click(screen.getByLabelText(/Operation SELECT/))
    const second = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(second.style.left).toBe(left)
    expect(second.style.width).toBe(width)
  })

  it('drags the popup without panning the canvas or moving nodes', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const surface = screen.getByRole('application').firstElementChild as HTMLElement
    const canvasTransform = surface.style.transform
    const node = screen.getByLabelText(/Intermediate result after WHERE/)
    const nodeLeft = node.style.left
    const before = screen.getByRole('dialog', { name: 'Node inspector' }).style.left

    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 3, clientX: 140, clientY: 130 })
    fireEvent.pointerUp(header, { pointerId: 3 })

    expect(screen.getByRole('dialog', { name: 'Node inspector' }).style.left).not.toBe(before)
    expect(surface.style.transform).toBe(canvasTransform)
    expect(node.style.left).toBe(nodeLeft)
  })

  it('does not open the popup when a node is dragged', () => {
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    const canvas = screen.getByRole('application')
    const node = screen.getByLabelText(/Operation WHERE/)
    fireEvent.pointerDown(node, { button: 0, pointerId: 9, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 70, clientY: 60 })
    fireEvent.pointerUp(canvas, { pointerId: 9 })
    fireEvent.click(node)
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
  })

  it('opens the popup on pointer release alone, and hovering never opens it', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    const canvas = screen.getByRole('application')
    const node = screen.getByLabelText(/Intermediate result after WHERE/)

    fireEvent.pointerOver(node)
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()

    // A real browser retargets the compatibility click to the captured
    // canvas, so open on the pointer release itself.
    fireEvent.pointerDown(node, { button: 0, pointerId: 77, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 77 })
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toHaveAttribute(
      'data-node-id',
      'data-WHERE',
    )

    await user.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
  })

  it('does not pan the canvas when clicking inside the popup', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const surface = screen.getByRole('application').firstElementChild as HTMLElement
    const before = surface.style.transform

    const tab = screen.getByRole('tab', { name: 'Details' })
    fireEvent.pointerDown(tab, { button: 0, pointerId: 78, clientX: 300, clientY: 220 })
    fireEvent.pointerMove(tab, { pointerId: 78, clientX: 360, clientY: 260 })
    fireEvent.pointerUp(tab, { pointerId: 78 })

    expect(surface.style.transform).toBe(before)
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toBeInTheDocument()
  })

  it('resizes the popup without panning or zooming the canvas', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    const surface = screen.getByRole('application').firstElementChild as HTMLElement
    const transform = surface.style.transform
    const width = Number.parseFloat(dialog.style.width)

    const handle = dialog.querySelector('[data-edge="se"]')!
    fireEvent.pointerDown(handle, { pointerId: 11, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(handle, { pointerId: 11, clientX: 260, clientY: 250 })
    fireEvent.pointerUp(handle, { pointerId: 11 })

    expect(Number.parseFloat(dialog.style.width)).toBeGreaterThan(width)
    expect(surface.style.transform).toBe(transform)
  })

  it('keeps the selected node and popup position when playback changes', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const before = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = before.style.left
    const width = before.style.width
    const eventIndex = useVisualizationStore.getState().eventIndex

    act(() => {
      useVisualizationStore.getState().seekToStage('SELECT')
    })

    const after = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(after).toHaveAttribute('data-node-id', 'data-WHERE')
    expect(after.style.left).toBe(left)
    expect(after.style.width).toBe(width)
    expect(useVisualizationStore.getState().eventIndex).toBeGreaterThan(eventIndex)
  })

  it('collapses to the header without reserving height and restores geometry and tab', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    await user.click(screen.getByRole('tab', { name: 'Details' }))
    const before = screen.getByRole('dialog', { name: 'Node inspector' })
    const geometry = {
      left: before.style.left,
      top: before.style.top,
      width: before.style.width,
      height: before.style.height,
    }

    await user.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    const collapsed = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(collapsed).toHaveAttribute('data-mode', 'collapsed')
    expect(collapsed).toHaveStyle({ height: '52px' })
    expect(collapsed.style.left).toBe(geometry.left)
    expect(collapsed.style.width).toBe(geometry.width)
    // Content is removed from the layout, not merely hidden.
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    const restored = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(restored).toHaveAttribute('data-mode', 'expanded')
    expect(restored.style.left).toBe(geometry.left)
    expect(restored.style.top).toBe(geometry.top)
    expect(restored.style.width).toBe(geometry.width)
    expect(restored.style.height).toBe(geometry.height)
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('drags the collapsed header using its real height and restores the saved height', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const expanded = screen.getByRole('dialog', { name: 'Node inspector' })
    const savedWidth = expanded.style.width
    const savedHeight = expanded.style.height
    expect(savedHeight).toBe('576px')

    await user.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    const collapsed = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(collapsed).toHaveStyle({ height: '52px', width: savedWidth })

    // Drag far past the bottom: the visible header is clamped by its real
    // 52px height (800 - 52 = 748), not by the saved 576px expanded height.
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 21, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 21, clientX: 100, clientY: 9000 })
    fireEvent.pointerUp(header, { pointerId: 21 })

    const dragged = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dragged).toHaveStyle({ height: '52px', top: '748px', width: savedWidth })
    expect(dragged.style.top).toBe('748px')
    // Nothing from the expanded layout survives below the header.
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
    expect(document.querySelector('[data-edge]')).toBeNull()

    // Expanding restores the saved height exactly; the full rectangle is
    // clamped back inside the 800px workspace (800 - 576 = 224).
    await user.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    const restored = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(restored).toHaveAttribute('data-mode', 'expanded')
    expect(restored).toHaveStyle({ width: savedWidth, height: savedHeight, top: '224px' })
  })

  it('minimizes into a dock item and restores the same window', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const before = screen.getByRole('dialog', { name: 'Node inspector' })
    const geometry = {
      left: before.style.left,
      top: before.style.top,
      width: before.style.width,
      height: before.style.height,
    }

    await user.click(screen.getByRole('button', { name: 'Minimize node inspector' }))
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
    const dock = screen.getByTestId('inspector-dock')
    expect(dock).toHaveTextContent('Filtered rows · 3')
    // The dock layer must never intercept canvas gestures.
    expect(dock.className).toContain('pointer-events-none')

    await user.click(
      screen.getByRole('button', {
        name: 'Restore inspector for Filtered rows · 3',
      }),
    )
    const restored = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(restored.style.left).toBe(geometry.left)
    expect(restored.style.top).toBe(geometry.top)
    expect(restored.style.width).toBe(geometry.width)
    expect(restored.style.height).toBe(geometry.height)
    expect(screen.queryByTestId('inspector-dock')).not.toBeInTheDocument()
  })

  it('updates the dock identity when another node is selected while minimized', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    await user.click(screen.getByRole('button', { name: 'Minimize node inspector' }))
    await user.click(screen.getByLabelText(/Operation SELECT/))

    const dock = screen.getByTestId('inspector-dock')
    expect(dock).toHaveTextContent('SELECT')
    await user.click(
      screen.getByRole('button', { name: 'Restore inspector for SELECT' }),
    )
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toHaveAttribute(
      'data-node-id',
      'op-SELECT',
    )
  })

  it('closes a minimized inspector from its dock item', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    await user.click(screen.getByRole('button', { name: 'Minimize node inspector' }))
    await user.click(screen.getByRole('button', { name: 'Close minimized inspector' }))
    expect(screen.queryByTestId('inspector-dock')).not.toBeInTheDocument()
  })

  it('keeps cursor-hover tracing working while the popup is open', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    fireEvent.pointerOver(screen.getByLabelText(/Operation WHERE/))
    const canvasEl = screen.getByRole('application')
    expect(canvasEl.getAttribute('data-hovered-node')).toBe('op-WHERE')
    expect(canvasEl.getAttribute('data-trace-mode')).toBe('hover')
    expect(document.querySelector('[data-hover-path="true"]')).not.toBeNull()
  })

  it('clamps the popup inside a small workspace', async () => {
    bounds.restore()
    bounds = installWorkspaceBounds(500, 400)
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = Number.parseFloat(dialog.style.left)
    const top = Number.parseFloat(dialog.style.top)
    const width = Number.parseFloat(dialog.style.width)
    const height = Number.parseFloat(dialog.style.height)
    expect(width).toBeGreaterThanOrEqual(380)
    expect(height).toBeGreaterThanOrEqual(280)
    expect(left + width).toBeLessThanOrEqual(500)
    expect(top + height).toBeLessThanOrEqual(400)
  })

  it('reclamps the popup when the workspace shrinks', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const before = screen.getByRole('dialog', { name: 'Node inspector' }).style.left

    act(() => {
      bounds.resize(420, 360)
    })
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = Number.parseFloat(dialog.style.left)
    const width = Number.parseFloat(dialog.style.width)
    expect(left + width).toBeLessThanOrEqual(420)
    expect(left).not.toBe(Number.parseFloat(before))
  })

  it('uses theme tokens so light and dark rendering stay consistent', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)
    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dialog.className).toContain('bg-surface')
    expect(dialog.className).toContain('border-border')

    document.documentElement.classList.add('dark')
    expect(screen.getByRole('dialog', { name: 'Node inspector' })).toBeInTheDocument()
    document.documentElement.classList.remove('dark')
  })
})

describe('Documentation sidebar', () => {
  it('opens and closes independently, releasing the canvas width', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    const sidebar = screen.getByTestId('documentation-sidebar')
    const toggle = screen.getByRole('button', { name: 'Toggle documentation sidebar' })
    expect(sidebar).toHaveAttribute('data-state', 'open')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(sidebar.style.width).not.toBe('0px')
    expect(screen.queryByRole('button', { name: 'Open documentation sidebar' })).not.toBeInTheDocument()

    await user.click(toggle)
    expect(sidebar).toHaveAttribute('data-state', 'closed')
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    // A compact edge tab keeps the hidden panel reachable.
    const edgeTab = screen.getByRole('button', { name: 'Open documentation sidebar' })
    expect(edgeTab).toBeInTheDocument()

    await user.click(edgeTab)
    expect(sidebar).toHaveAttribute('data-state', 'open')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('preserves canvas pan and zoom when the sidebar is toggled', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 40, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(canvas, { pointerId: 40, clientX: 560, clientY: 340 })
    fireEvent.pointerUp(canvas, { pointerId: 40 })
    const transform = surface.style.transform
    const zoomLabel = screen.getByText(/%$/).textContent

    await user.click(screen.getByRole('button', { name: 'Toggle documentation sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Open documentation sidebar' }))

    expect(surface.style.transform).toBe(transform)
    expect(screen.getByText(/%$/).textContent).toBe(zoomLabel)
  })

  it('preserves documentation scroll position while closed', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    const explanation = screen.getByLabelText('Explanation')
    explanation.scrollTop = 180
    expect(explanation.scrollTop).toBe(180)

    await user.click(screen.getByRole('button', { name: 'Toggle documentation sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Open documentation sidebar' }))

    // The same mounted element, so its scroll offset was never reset.
    expect(screen.getByLabelText('Explanation')).toBe(explanation)
    expect(explanation.scrollTop).toBe(180)
  })

  it('closes with the keyboard while focus is inside the sidebar', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    const sidebar = screen.getByTestId('documentation-sidebar')
    const levelTab = screen.getByRole('tab', { name: 'Beginner' })
    levelTab.focus()
    await user.keyboard('{Escape}')
    expect(sidebar).toHaveAttribute('data-state', 'closed')
  })

  it('is independent of the floating inspector', async () => {
    const user = userEvent.setup()
    readyWorkspace()
    render(<VisualizationWorkspace queryName="demo" onClose={() => {}} />)

    await user.click(screen.getByLabelText(/Intermediate result after WHERE/))
    const inspector = screen.getByRole('dialog', { name: 'Node inspector' })
    const left = inspector.style.left

    await user.click(screen.getByRole('button', { name: 'Toggle documentation sidebar' }))
    expect(screen.getByTestId('documentation-sidebar')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByRole('dialog', { name: 'Node inspector' }).style.left).toBe(left)

    await user.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(screen.queryByRole('dialog', { name: 'Node inspector' })).not.toBeInTheDocument()
    expect(screen.getByTestId('documentation-sidebar')).toHaveAttribute('data-state', 'closed')
  })
})
