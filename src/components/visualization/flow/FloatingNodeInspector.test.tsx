// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildFlowGraph } from '../../../services/visualization/graphBuilder'
import { makeTrace } from '../../../test/fixtures/visualization'
import {
  FloatingNodeInspector,
  type InspectorWindowMode,
} from './FloatingNodeInspector'

const bounds = { width: 1000, height: 800 }
const rect = { x: 100, y: 100, width: 500, height: 400 }

function renderInspector(overrides: { whereRows?: number; status?: string } = {}) {
  const trace = makeTrace({ whereRows: overrides.whereRows })
  const graph = buildFlowGraph(trace)
  const node = graph.nodes.find((candidate) => candidate.id === 'op-WHERE')!
  const onRectChange = vi.fn()
  const onClose = vi.fn()
  function Harness() {
    const [mode, setMode] = useState<InspectorWindowMode>('expanded')
    const [currentRect, setCurrentRect] = useState(rect)
    return (
      <FloatingNodeInspector
        node={node}
        trace={trace}
        status={(overrides.status as never) ?? 'completed'}
        rect={currentRect}
        bounds={bounds}
        mode={mode}
        onModeChange={setMode}
        onRectChange={(next) => {
          onRectChange(next)
          setCurrentRect(next)
        }}
        onClose={onClose}
      />
    )
  }
  const utils = render(<Harness />)
  return { ...utils, onRectChange, onClose, node }
}

describe('FloatingNodeInspector', () => {
  it('renders a dialog with the node name, operation, status and section tabs', () => {
    renderInspector()
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Operation: WHERE')).toBeInTheDocument()
    expect(screen.getByTestId('node-inspector-status')).toHaveTextContent('completed')
    for (const label of ['Overview', 'Input', 'Output', 'Details']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  it('shows overview rows in/out and switches sections', () => {
    renderInspector()
    expect(screen.getByText('rows in')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
    // The real output row is rendered in the table.
    expect(screen.getByText('person 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByText('WHERE salary > 50000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Input' }))
    expect(screen.getByText('person 5')).toBeInTheDocument()
  })

  it('paginates a large result instead of rendering every row', () => {
    renderInspector({ whereRows: 60 })
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    expect(screen.getByText('Rows 1–25 of 60')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next rows' }))
    expect(screen.getByText('Rows 26–50 of 60')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next rows' }))
    expect(screen.getByText('Rows 51–60 of 60')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next rows' })).toBeDisabled()
  })

  it('closes via the close button', () => {
    const { onClose } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Close node inspector' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('collapses to a real header-only window and expands to the previous size', () => {
    renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))

    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
    const collapsed = screen.getByRole('dialog')
    expect(collapsed).toHaveAttribute('data-mode', 'collapsed')
    expect(collapsed).toHaveStyle({ height: '52px' })
    // The header stays visible and usable while collapsed.
    expect(screen.getByTestId('node-inspector-header')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand node inspector' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    const expanded = screen.getByRole('dialog')
    expect(expanded).toHaveAttribute('data-mode', 'expanded')
    expect(expanded).toHaveStyle({ height: '400px' })
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
  })

  it('preserves the active tab through collapse and expand', () => {
    renderInspector()
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('minimizes the whole window without leaving it in the layout', () => {
    const { container } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize node inspector' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const minimized = container.querySelector('[data-mode="minimized"]')
    expect(minimized).not.toBeNull()
    expect(minimized).toHaveStyle({ display: 'none' })
  })

  it('maximizes to the workspace and restores', () => {
    renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Maximize node inspector' }))
    expect(screen.getByRole('dialog')).toHaveStyle({ width: '1000px', height: '800px' })
    expect(screen.getByRole('dialog')).toHaveAttribute('data-maximized', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Restore node inspector size' }))
    expect(screen.getByRole('dialog')).not.toHaveAttribute('data-maximized')
  })

  it('renders the saved expanded bounding size', () => {
    renderInspector()
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    expect(dialog).toHaveStyle({ left: '100px', top: '100px', width: '500px', height: '400px' })
    expect(getComputedStyle(dialog).height).toBe('400px')
  })

  it('drags by the header', () => {
    const { onRectChange } = renderInspector()
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 160, clientY: 140 })
    fireEvent.pointerUp(header, { pointerId: 1 })
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 160, y: 140, width: 500, height: 400 })
  })

  it('drags the whole collapsed window by its remaining header', () => {
    const { onRectChange } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    const header = screen.getByTestId('node-inspector-header')
    expect(header).toHaveClass('cursor-move')

    fireEvent.pointerDown(header, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 3, clientX: 160, clientY: 140 })
    fireEvent.pointerUp(header, { pointerId: 3 })

    // The full rectangle moves (so expanding restores the same size), while
    // the visible collapsed bar keeps its header-only height.
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 160, y: 140, width: 500, height: 400 })
    const collapsed = screen.getByRole('dialog')
    expect(collapsed).toHaveAttribute('data-mode', 'collapsed')
    expect(collapsed).toHaveStyle({ left: '160px', top: '140px', width: '500px', height: '52px' })
  })

  it('keeps dragging working after collapsing and expanding again', () => {
    const { onRectChange } = renderInspector()
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    fireEvent.pointerDown(header, { pointerId: 4, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 4, clientX: 150, clientY: 130 })
    fireEvent.pointerUp(header, { pointerId: 4 })

    fireEvent.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    expect(screen.getByRole('dialog')).toHaveStyle({ height: '400px' })

    fireEvent.pointerDown(header, { pointerId: 5, clientX: 150, clientY: 130 })
    fireEvent.pointerMove(header, { pointerId: 5, clientX: 200, clientY: 180 })
    fireEvent.pointerUp(header, { pointerId: 5 })
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 200, y: 180, width: 500, height: 400 })
  })

  it('does not start a drag from header buttons', () => {
    const { onRectChange } = renderInspector()
    const collapse = screen.getByRole('button', { name: 'Collapse node inspector' })
    fireEvent.pointerDown(collapse, { pointerId: 6, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(collapse, { pointerId: 6, clientX: 160, clientY: 140 })
    fireEvent.pointerUp(collapse, { pointerId: 6 })
    fireEvent.click(collapse)
    expect(onRectChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Expand node inspector' })).toBeInTheDocument()
  })

  it('does not let header dragging bubble to a parent canvas layer', () => {
    const trace = makeTrace()
    const graph = buildFlowGraph(trace)
    const node = graph.nodes.find((candidate) => candidate.id === 'op-WHERE')!
    const onPointerDown = vi.fn()
    render(
      <div onPointerDown={onPointerDown}>
        <FloatingNodeInspector
          node={node}
          trace={trace}
          status="completed"
          rect={rect}
          bounds={bounds}
          mode="expanded"
          onModeChange={vi.fn()}
          onRectChange={vi.fn()}
          onClose={vi.fn()}
        />
      </div>,
    )
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 7, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 7, clientX: 150, clientY: 130 })
    fireEvent.pointerUp(header, { pointerId: 7 })
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('keeps a collapsed window inside the workspace when dragged far', () => {
    const { onRectChange } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 8, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 8, clientX: 5000, clientY: 5000 })
    fireEvent.pointerUp(header, { pointerId: 8 })

    // 800 - 52: the collapsed box is clamped by its real header height,
    // not by the saved 400px expanded height. The saved height is still
    // committed separately so expansion restores 400px.
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 500, y: 748, width: 500, height: 400 })
    const collapsed = screen.getByRole('dialog')
    expect(collapsed).toHaveStyle({ left: '500px', top: '748px', height: '52px' })

    fireEvent.click(screen.getByRole('button', { name: 'Expand node inspector' }))
    const expanded = screen.getByRole('dialog')
    expect(expanded).toHaveStyle({ height: '400px', top: '400px' })
  })

  it('has no hidden content or resize handles in collapsed mode', () => {
    const { container } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
    const dialog = screen.getByRole('dialog', { name: 'Node inspector' })
    // The visible box is only the header: content and handles are gone
    // from the DOM, so nothing below it can intercept pointer events.
    expect(dialog.children).toHaveLength(1)
    expect(dialog.firstElementChild).toBe(screen.getByTestId('node-inspector-header'))
    expect(dialog.querySelector('[role="tabpanel"]')).toBeNull()
    expect(container.querySelector('[data-edge]')).toBeNull()
    expect(getComputedStyle(dialog).height).toBe('52px')
    expect(getComputedStyle(dialog).width).toBe('500px')
  })

  it('survives repeated collapse/expand cycles without layout drift', () => {
    renderInspector()
    for (let cycle = 0; cycle < 3; cycle += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse node inspector' }))
      expect(screen.getByRole('dialog')).toHaveStyle({ height: '52px' })
      fireEvent.click(screen.getByRole('button', { name: 'Expand node inspector' }))
      expect(screen.getByRole('dialog')).toHaveStyle({
        left: '100px',
        top: '100px',
        width: '500px',
        height: '400px',
      })
    }
  })

  it('exposes eight resize handles with directional cursors', () => {
    const { container } = renderInspector()
    const handles = container.querySelectorAll('[data-edge]')
    expect(handles).toHaveLength(8)
    expect(container.querySelector('[data-edge="se"]')).toHaveStyle({ cursor: 'nwse-resize' })
    expect(container.querySelector('[data-edge="n"]')).toHaveStyle({ cursor: 'ns-resize' })
  })

  it('resizes from each handle', () => {
    for (const [edge, expected] of [
      ['se', { x: 100, y: 100, width: 550, height: 450 }],
      ['nw', { x: 150, y: 150, width: 450, height: 350 }],
      ['e', { x: 100, y: 100, width: 550, height: 400 }],
    ] as const) {
      const { container, onRectChange } = renderInspector()
      const handle = container.querySelector(`[data-edge="${edge}"]`)!
      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 200, clientY: 200 })
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 250, clientY: 250 })
      fireEvent.pointerUp(handle, { pointerId: 2 })
      expect(onRectChange).toHaveBeenLastCalledWith(expected)
    }
  })
})
