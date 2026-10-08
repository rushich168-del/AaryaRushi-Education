import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

// A small "More" (⋯) menu for a list row. `prefix` picks the screen's own styles
// (pub- in the publisher, lp- in the creator workspace). Renders nothing without items.
export default function RowMenu({ label, items, disabled = false, prefix = 'pub' }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const menu = useRef(null)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector('button')?.focus()
    const closeOutside = event => {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  if (!items.length) return null

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...menu.current.querySelectorAll('button')]
    const step = event.key === 'ArrowDown' ? 1 : -1
    buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length].focus()
  }

  // Focus goes back to the ⋯ button first, so a dialog opened by the action can return there.
  function choose(item) {
    close()
    item.onSelect()
  }

  return (
    <div className={`${prefix}-menu`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`${prefix}-menu-trigger`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          className={`${prefix}-menu-list`}
          role="menu"
          aria-label="More actions"
          onKeyDown={onKeyDown}
          onBlur={event => {
            if (!root.current?.contains(event.relatedTarget)) setOpen(false)
          }}
        >
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? `${prefix}-menu-danger` : undefined}
              onClick={() => choose(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
