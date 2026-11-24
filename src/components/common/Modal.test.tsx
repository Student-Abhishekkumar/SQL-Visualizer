// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

function ModalHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Workspace settings"
        description="Manage local preferences."
      >
        <button>Save changes</button>
      </Modal>
    </>
  )
}

describe('Modal', () => {
  it('labels the dialog, traps focus, closes with Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(<ModalHarness />)
    const trigger = screen.getByRole('button', { name: 'Open settings' })
    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Workspace settings' })
    const close = screen.getByRole('button', { name: 'Close dialog' })
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute(
      'aria-describedby',
      screen.getByText('Manage local preferences.').id,
    )
    expect(close).toHaveFocus()

    await user.tab()
    expect(save).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(save).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('respects autoFocus and does not reset focus when the parent rerenders', async () => {
    const user = userEvent.setup()
    function AutoFocusDialog() {
      const [value, setValue] = useState('')
      return (
        <Modal open onClose={() => undefined} title="Rename database">
          <input
            autoFocus
            aria-label="Database name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button>Save name</button>
        </Modal>
      )
    }

    render(<AutoFocusDialog />)
    const input = screen.getByRole('textbox', { name: 'Database name' })
    expect(input).toHaveFocus()
    await user.type(input, 'University')
    expect(input).toHaveValue('University')
    expect(input).toHaveFocus()
  })

  it('closes only when the backdrop itself is pressed', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Settings">
        <p>Dialog content</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
