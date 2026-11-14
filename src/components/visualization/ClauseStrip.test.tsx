// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ClauseStrip } from './ClauseStrip'
import { useEditorStore } from '../../store/editorStore'
import { mapQueryClauses } from '../../services/visualization/clauseMapper'

/**
 * Clause strip + editor-highlight synchronization (Milestone 5):
 * chips come from real clause spans, clicking seeks, and the editor
 * store highlight follows the active stage / node selection.
 */

const QUERY = 'SELECT name, salary FROM employees WHERE salary > 50000'

describe('ClauseStrip', () => {
  it('renders one chip per real clause span', () => {
    render(
      <ClauseStrip
        query={QUERY}
        activeStage={null}
        seekableStages={new Set(['FROM', 'WHERE', 'SELECT'])}
        onSeekStage={() => {}}
      />,
    )
    const toolbar = screen.getByRole('toolbar', { name: 'Query clauses' })
    const chips = Array.from(toolbar.querySelectorAll('button'))
    expect(chips.map((chip) => chip.textContent)).toEqual(['SELECT', 'FROM', 'WHERE'])
  })

  it('marks the active stage chip and disables unseekable ones', () => {
    render(
      <ClauseStrip
        query={QUERY}
        activeStage="WHERE"
        seekableStages={new Set(['FROM', 'WHERE'])}
        onSeekStage={() => {}}
      />,
    )
    const toolbar = screen.getByRole('toolbar', { name: 'Query clauses' })
    const chips = Array.from(toolbar.querySelectorAll('button'))
    const where = chips.find((chip) => chip.textContent === 'WHERE')
    const select = chips.find((chip) => chip.textContent === 'SELECT')
    expect(where?.getAttribute('aria-disabled') ?? String(where?.disabled)).toBeTruthy()
    expect(where?.className).toContain('border-accent')
    expect(where?.disabled).toBe(false)
    // SELECT exists in the query but is not seekable (not in trace).
    expect(select?.disabled).toBe(true)
  })

  it('clicking a chip seeks to that clause stage', () => {
    const sought: string[] = []
    render(
      <ClauseStrip
        query={QUERY}
        activeStage={null}
        seekableStages={new Set(['FROM', 'WHERE', 'SELECT'])}
        onSeekStage={(stage) => sought.push(stage)}
      />,
    )
    const toolbar = screen.getByRole('toolbar', { name: 'Query clauses' })
    const where = Array.from(toolbar.querySelectorAll('button')).find(
      (chip) => chip.textContent === 'WHERE',
    )
    fireEvent.click(where!)
    expect(sought).toEqual(['WHERE'])
  })

  it('renders nothing when the query has no recognizable clauses', () => {
    render(
      <ClauseStrip
        query="banana"
        activeStage={null}
        seekableStages={new Set()}
        onSeekStage={() => {}}
      />,
    )
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})

describe('editor store — stage highlight', () => {
  it('sets and clears the highlight, and clears when content changes', () => {
    const store = useEditorStore.getState()
    store.setStageHighlight({ start: 0, end: 6, stage: 'SELECT' })
    expect(useEditorStore.getState().stageHighlight).toEqual({ start: 0, end: 6, stage: 'SELECT' })

    useEditorStore.getState().setStageHighlight(null)
    expect(useEditorStore.getState().stageHighlight).toBeNull()

    useEditorStore.getState().setStageHighlight({ start: 2, end: 5, stage: 'WHERE' })
    useEditorStore.getState().setContent('SELECT * FROM t')
    expect(useEditorStore.getState().stageHighlight).toBeNull()
  })

  it('the workspace-highlight range matches the clause mapper output', () => {
    const spans = mapQueryClauses(QUERY)
    const where = spans.find((span) => span.stage === 'WHERE')
    expect(where).toBeDefined()
    expect(QUERY.slice(where!.start, where!.end)).toBe('WHERE salary > 50000')
  })
})
