// Keeps Tab and Shift+Tab inside an open dialog. Call from the dialog's onKeyDown.
export function keepTabInside(event, dialog) {
  if (event.key !== 'Tab') return
  const buttons = [...dialog.querySelectorAll('button:not(:disabled)')]
  const edge = buttons[event.shiftKey ? 0 : buttons.length - 1]
  if (buttons.length && document.activeElement !== edge) return
  event.preventDefault()
  buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus()
}
