// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('associates its description with the trigger and preserves existing IDs', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip label="Database settings">
        <button aria-describedby="existing-description">Settings</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Settings' })
    const tooltip = screen.getByRole('tooltip')
    expect(trigger).toHaveAttribute(
      'aria-describedby',
      `existing-description ${tooltip.id}`,
    )
    expect(tooltip).toHaveTextContent('Database settings')

    await user.tab()
    expect(trigger).toHaveFocus()
    expect(tooltip).toHaveClass('group-focus-within/tooltip:opacity-100')
    expect(tooltip).toHaveClass('motion-reduce:transition-none')
    expect(tooltip).toHaveClass('-translate-x-1/2')
  })

  it('anchors to the right edge when align is end', () => {
    render(
      <Tooltip label="Refresh" align="end">
        <button aria-label="Refresh">Refresh</button>
      </Tooltip>,
    )

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveClass('right-0')
    expect(tooltip).not.toHaveClass('-translate-x-1/2')
  })
})
