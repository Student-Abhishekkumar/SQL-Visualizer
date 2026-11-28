// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from './HomePage'
import { finishHomeIntro, releaseHomeIntro, resetHomeIntro } from './homeIntro'
import { useUIStore } from '../../store/uiStore'

function firstLink(name: RegExp): HTMLElement {
  const [link] = screen.getAllByRole('link', { name })
  if (!link) throw new Error(`link not found: ${String(name)}`)
  return link
}

beforeEach(() => {
  localStorage.clear()
  resetHomeIntro()
  useUIStore.setState({ theme: 'dark', reducedEffects: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HomePage', () => {
  it('presents the headline, navigation and full set of sections', () => {
    render(<HomePage onEnter={() => {}} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /Every query has a shape\./,
    )
    expect(screen.getByRole('navigation', { name: 'Homepage sections' })).toBeInTheDocument()
    expect(document.querySelectorAll('.home-section').length).toBe(4)
    expect(document.querySelector('#method')).toBeInTheDocument()
    expect(document.querySelector('#themes')).toBeInTheDocument()
    expect(document.querySelector('#start')).toBeInTheDocument()

    expect(firstLink(/Open the workspace/i)).toHaveAttribute('href', '#/app')
  })

  it('offers all nine themes and updates the shared theme store', () => {
    render(<HomePage onEnter={() => {}} />)

    expect(screen.getAllByRole('radio')).toHaveLength(9)
    fireEvent.click(screen.getByRole('radio', { name: 'Light theme' }))
    expect(useUIStore.getState().theme).toBe('light')

    fireEvent.click(screen.getByRole('radio', { name: 'Cyberpunk theme' }))
    expect(useUIStore.getState().theme).toBe('cyberpunk')
  })

  it('rests until the entrance hands over, then plays its landing animation', () => {
    render(<HomePage onEnter={() => {}} />)
    const root = document.querySelector('.home')

    // The entrance still owns the screen: nothing may animate yet.
    expect(root).toHaveAttribute('data-intro', 'settled')

    act(() => {
      releaseHomeIntro()
    })
    expect(root).toHaveAttribute('data-intro', 'playing')

    fireEvent.click(screen.getByRole('button', { name: /Skip intro/i }))
    expect(root).toHaveAttribute('data-intro', 'settled')
  })

  it('settles on its own once the landing beats have run', () => {
    vi.useFakeTimers()
    render(<HomePage onEnter={() => {}} />)
    const root = document.querySelector('.home')

    act(() => {
      releaseHomeIntro()
    })
    expect(root).toHaveAttribute('data-intro', 'playing')
    expect(screen.getByRole('button', { name: /Skip intro/i })).toBeVisible()

    // The sequence is not cut short: it only settles after its longest beat.
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(root).toHaveAttribute('data-intro', 'playing')

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(root).toHaveAttribute('data-intro', 'settled')
    expect(screen.queryByRole('button', { name: /Skip intro/i })).not.toBeInTheDocument()
  })

  it('does not replay the landing animation once it was consumed', () => {
    act(() => {
      releaseHomeIntro()
      finishHomeIntro()
    })
    render(<HomePage onEnter={() => {}} />)
    expect(document.querySelector('.home')).toHaveAttribute('data-intro', 'settled')
  })

  it('hands control to the workspace after the launch beat', () => {
    vi.useFakeTimers()
    const onEnter = vi.fn()
    const onWarm = vi.fn()
    render(<HomePage onEnter={onEnter} onWarm={onWarm} />)

    fireEvent.click(firstLink(/Open the workspace/i))
    expect(onWarm).toHaveBeenCalledTimes(1)
    expect(onEnter).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it('does not intercept modified clicks (open in new tab)', () => {
    const onEnter = vi.fn()
    render(<HomePage onEnter={onEnter} />)

    fireEvent.click(firstLink(/Open the workspace/i), { metaKey: true })
    expect(onEnter).not.toHaveBeenCalled()
  })
})