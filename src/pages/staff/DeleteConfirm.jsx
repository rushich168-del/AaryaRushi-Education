import { useEffect, useRef } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { keepTabInside } from './dialogFocus.js'
import './delete-confirm.css'

// Admin-only "are you sure?" for deleting a published test or a student result.
// Stays open while the server works so the admin sees the outcome; Escape cannot cancel mid-delete.
export default function DeleteConfirm({ title, summary, facts = [], confirmLabel, busy, error, onCancel, onConfirm }) {
  const dialog = useRef(null)
  const cancel = useRef(null)

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    cancel.current?.focus()
    return () => node.close()
  }, [])

  useEffect(() => {
    if (busy) dialog.current.focus()
  }, [busy])

  return (
    <dialog
      ref={dialog}
      className="del-dialog"
      aria-labelledby="del-dialog-title"
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape' && busy) event.preventDefault()
        keepTabInside(event, dialog.current)
      }}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onClose={() => {
        if (dialog.current.open) return
        if (busy) dialog.current.showModal()
        else onCancel()
      }}
    >
      <div className="del-head">
        <span className="del-icon" aria-hidden="true">
          <AlertTriangle size={22} />
        </span>
        <h3 id="del-dialog-title">{title}</h3>
      </div>
      {summary && <div className="del-summary">{summary}</div>}
      {facts.length > 0 && (
        <ul className="del-facts">
          {facts.map(fact => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="del-alert" role="alert">
          {error}
        </p>
      )}
      <div className="del-actions">
        <button ref={cancel} type="button" className="del-button del-button-light" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="del-button del-button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? <span className="del-spinner" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
          {busy ? 'Deleting…' : error ? 'Retry' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
