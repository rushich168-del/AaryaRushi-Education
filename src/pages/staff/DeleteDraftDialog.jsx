import ConfirmDialog from './ConfirmDialog.jsx'

// Confirms removing one draft from this device. Nothing in the library is affected.
export default function DeleteDraftDialog({ title, interrupted, onCancel, onDelete }) {
  return (
    <ConfirmDialog titleId="lp-delete-draft-title" title="Delete this draft?" confirmLabel="Delete draft" danger onCancel={onCancel} onConfirm={onDelete}>
      <p>
        <strong>{title}</strong> will be removed from this device. Papers in your library and published tests are not
        affected.
      </p>
      {interrupted && <p>This paper’s save to the library was interrupted. Deleting stops the retry.</p>}
    </ConfirmDialog>
  )
}
