import { useEffect, useRef } from 'react'
import { Lock, Send, Users } from 'lucide-react'
import { keepTabInside } from '../dialogFocus.js'
import { paperStats } from './paperFormat.js'

// The publisher's own final check before students can see the test.
export default function PublishDialog({ paper, busy, error, onCancel, onPublish }) {
  const dialog = useRef(null)
  const primary = useRef(null)

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  // Both buttons are disabled while publishing, so hold focus on the dialog itself.
  useEffect(() => {
    if (busy) dialog.current.focus()
    else if (error) primary.current?.focus()
  }, [busy, error])

  function onKeyDown(event) {
    // Escape must not close the dialog while the test is being published.
    if (event.key === 'Escape' && busy) event.preventDefault()
    keepTabInside(event, dialog.current)
  }

  return (
    <dialog
      ref={dialog}
      className="pub-dialog"
      aria-labelledby="pub-dialog-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      // Safety net: if the browser closes the dialog anyway, never lose it mid-publish.
      onClose={() => {
        if (dialog.current.open) return
        if (busy) dialog.current.showModal()
        else onCancel()
      }}
    >
      <div className="pub-dialog-head">
        <span className="pub-dialog-icon" aria-hidden="true">
          <Send size={22} />
        </span>
        <div>
          <h3 id="pub-dialog-title">Publish this test?</h3>
          <p className="pub-dialog-sub">Check the details once. Students see it as soon as you publish.</p>
        </div>
      </div>
      <div className="pub-dialog-paper">
        <span className="pub-dialog-program">{paper.exam_name}</span>
        <strong>{paper.title}</strong>
        <span className="pub-dialog-version">Version {paper.version}</span>
        <dl className="pub-dialog-stats">
          {paperStats(paper).map(stat => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ul className="pub-dialog-facts">
        <li>
          <Users size={18} aria-hidden="true" />
          <span>
            <strong>All {paper.exam_name} students</strong> can start it right away.
          </span>
        </li>
        <li>
          <Lock size={18} aria-hidden="true" />
          <span>Questions are locked after publishing. To change them, publish a revised version.</span>
        </li>
      </ul>
      {error && (
        <p className="pub-alert" role="alert">
          {error} Retrying is safe. The test will not be published twice.
        </p>
      )}
      <div className="pub-dialog-actions">
        <button type="button" className="pub-button pub-button-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button ref={primary} type="button" className="pub-button pub-button-primary" disabled={busy} onClick={onPublish}>
          {busy ? <span className="pub-spinner" aria-hidden="true" /> : !error && <Send size={16} aria-hidden="true" />}
          {busy ? 'Publishing…' : error ? 'Retry' : 'Publish now'}
        </button>
      </div>
    </dialog>
  )
}
