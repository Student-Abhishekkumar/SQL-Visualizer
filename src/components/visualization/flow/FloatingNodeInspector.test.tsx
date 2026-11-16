// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildFlowGraph } from '../../../services/visualization/graphBuilder'
import { makeTrace } from '../../../test/fixtures/visualization'
import { FloatingNodeInspector } from './FloatingNodeInspector'

const bounds = { width: 1000, height: 800 }
const rect = { x: 100, y: 100, width: 500, height: 400 }

function renderInspector(overrides: { whereRows?: number; status?: string } = {}) {
  const trace = makeTrace({ whereRows: overrides.whereRows })
  const graph = buildFlowGraph(trace)
  const node = graph.nodes.find((candidate) => candidate.id === 'op-WHERE')!
  const onRectChange = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <FloatingNodeInspector
      node={node}
      trace={trace}
      status={(overrides.status as never) ?? 'completed'}
      rect={rect}
      bounds={bounds}
      onRectChange={onRectChange}
      onClose={onClose}
    />,
  )
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

  it('minimizes to the header and restores', () => {
    renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize node inspector' }))
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveStyle({ height: '48px' })
    fireEvent.click(screen.getByRole('button', { name: 'Restore node inspector' }))
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
  })

  it('maximizes to the workspace and restores', () => {
    renderInspector()
    fireEvent.click(screen.getByRole('button', { name: 'Maximize node inspector' }))
    expect(screen.getByRole('dialog')).toHaveStyle({ width: '1000px', height: '800px' })
    expect(screen.getByRole('dialog')).toHaveAttribute('data-maximized', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Restore node inspector' }))
    expect(screen.getByRole('dialog')).not.toHaveAttribute('data-maximized')
  })

  it('drags by the header', () => {
    const { onRectChange } = renderInspector()
    const header = screen.getByTestId('node-inspector-header')
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 160, clientY: 140 })
    fireEvent.pointerUp(header, { pointerId: 1 })
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 160, y: 140, width: 500, height: 400 })
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
