// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorResultsSeparator } from './EditorResultsSeparator'

function renderSeparator(onChange = vi.fn(), value = 52) {
  const boundsRef = createRef<HTMLElement>()
  Object.defineProperty(boundsRef, 'current', {
    value: {
      getBoundingClientRect: () => ({ top: 100, height: 500 }),
    },
  })
  render(<EditorResultsSeparator value={value} onChange={onChange} boundsRef={boundsRef} />)
  return { onChange, separator: screen.getByRole('separator') }
}

describe('EditorResultsSeparator', () => {
  it('exposes separator values and clamps keyboard resizing', () => {
    const onChange = vi.fn()
    const { separator } = renderSeparator(onChange)
    expect(separator).toHaveAttribute('tabindex', '0')
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    expect(separator).toHaveAttribute('aria-controls', 'query-editor-region')
    expect(separator).toHaveAttribute('aria-valuemin', '20')
    expect(separator).toHaveAttribute('aria-valuemax', '80')
    expect(separator).toHaveAttribute('aria-valuenow', '52')
    expect(separator).toHaveAttribute('aria-valuetext', 'Editor 52 percent, results 48 percent')

    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(54)
    fireEvent.keyDown(separator, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(50)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(54)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith(50)
    fireEvent.keyDown(separator, { key: 'PageDown' })
    expect(onChange).toHaveBeenLastCalledWith(62)
    fireEvent.keyDown(separator, { key: 'PageUp' })
    expect(onChange).toHaveBeenLastCalledWith(42)
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(20)
    fireEvent.keyDown(separator, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(80)
  })

  it('uses larger steps with Shift + Arrow', () => {
    const onChange = vi.fn()
    const { separator } = renderSeparator(onChange)
    fireEvent.keyDown(separator, { key: 'ArrowDown', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(62)
    fireEvent.keyDown(separator, { key: 'ArrowUp', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(42)
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(62)
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(42)
  })

  it('clamps keyboard resizing at both boundaries', () => {
    const minChange = vi.fn()
    const { separator: atMin } = renderSeparator(minChange, 20)
    fireEvent.keyDown(atMin, { key: 'ArrowUp' })
    expect(minChange).toHaveBeenLastCalledWith(20)

    cleanup()

    const maxChange = vi.fn()
    const { separator: atMax } = renderSeparator(maxChange, 80)
    fireEvent.keyDown(atMax, { key: 'ArrowDown' })
    expect(maxChange).toHaveBeenLastCalledWith(80)
  })

  it('preserves pointer resizing and clamps it to the same limits', () => {
    const onChange = vi.fn()
    const { separator } = renderSeparator(onChange)
    fireEvent.pointerDown(separator, { pointerId: 1, clientY: 350 })
    expect(onChange).toHaveBeenLastCalledWith(50)
    fireEvent.pointerMove(separator, { pointerId: 1, clientY: 450 })
    expect(onChange).toHaveBeenLastCalledWith(70)
    fireEvent.pointerMove(separator, { pointerId: 1, clientY: 10_000 })
    expect(onChange).toHaveBeenLastCalledWith(80)
    fireEvent.pointerUp(separator, { pointerId: 1, clientY: 450 })

    const callCount = onChange.mock.calls.length
    fireEvent.pointerMove(separator, { pointerId: 1, clientY: 200 })
    expect(onChange).toHaveBeenCalledTimes(callCount)
  })

  it('supports touch dragging and focuses the handle on pointer down', () => {
    const onChange = vi.fn()
    const { separator } = renderSeparator(onChange)

    fireEvent.pointerDown(separator, { pointerId: 2, pointerType: 'touch', clientY: 350 })
    expect(separator).toHaveFocus()
    expect(onChange).toHaveBeenLastCalledWith(50)

    fireEvent.pointerMove(separator, { pointerId: 2, pointerType: 'touch', clientY: 450 })
    expect(onChange).toHaveBeenLastCalledWith(70)

    fireEvent.pointerMove(separator, { pointerId: 2, pointerType: 'touch', clientY: -10_000 })
    expect(onChange).toHaveBeenLastCalledWith(20)

    fireEvent.pointerUp(separator, { pointerId: 2, pointerType: 'touch', clientY: 450 })
    const callCount = onChange.mock.calls.length
    fireEvent.pointerMove(separator, { pointerId: 2, pointerType: 'touch', clientY: 200 })
    expect(onChange).toHaveBeenCalledTimes(callCount)
  })

  it('reflects a new value in the ARIA value text', () => {
    const onChange = vi.fn()
    const { separator } = renderSeparator(onChange, 33)
    expect(separator).toHaveAttribute('aria-valuenow', '33')
    expect(separator).toHaveAttribute('aria-valuetext', 'Editor 33 percent, results 67 percent')
  })
})