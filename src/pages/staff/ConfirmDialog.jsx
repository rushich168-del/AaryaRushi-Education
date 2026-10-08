import { useEffect, useRef } from 'react'
import { keepTabInside } from './dialogFocus.js'

// A small modal question with Cancel and one action. Escape and the browser closing it both cancel.
export default function ConfirmDialog({ titleId, title, confirmLabel, danger = false, onCancel, onConfirm, children }) {
  const dialog = useRef(null)

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="lp-dialog"
      aria-labelledby={titleId}
      onKeyDown={event => keepTabInside(event, dialog.current)}
      onCancel={event => {
        event.preventDefault()
        onCancel()
      }}
      // If the browser closes the dialog by itself, keep the screen in step with it.
      onClose={() => {
        if (!dialog.current.open) onCancel()
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="lp-dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={danger ? 'lp-danger' : 'lp-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
