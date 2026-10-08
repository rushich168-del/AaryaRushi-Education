import { ArrowRight } from 'lucide-react'
import { draftProgress, savedVersionOf } from '../../services/localExamLibrary.js'
import RowMenu from './RowMenu.jsx'

function progressLine({ total, ready, attention }) {
  if (!total) return 'No questions added yet'
  if (!attention) return 'All questions ready · complete final checks'
  return `${ready} of ${total} questions ready · ${attention} ${attention === 1 ? 'needs' : 'need'} attention`
}

// One draft in My drafts: where it stands, the next step, and a More menu with Delete draft.
// onOpen receives the question to open at, or -1 to resume where the creator stopped.
export default function CreatorDraftRow({ draft, busy, onOpen, onDelete }) {
  const title = draft.title || 'Untitled paper'
  const progress = draftProgress(draft)
  const savedVersion = savedVersionOf(draft)

  return (
    <div className="lp-list-row lp-draft-row">
      <div>
        <strong>{title}</strong>
        <p>
          {draft.exam}
          {draft.savedAt && ` · Saved ${new Date(draft.savedAt).toLocaleString()}`}
        </p>
        {draft.readyOperation ? (
          <p>Ready save interrupted. Continue to retry the same version.</p>
        ) : (
          <p className="lp-draft-progress">{progressLine(progress)}</p>
        )}
        {savedVersion > 0 && <p className="lp-draft-saved">Saved as v{savedVersion} · has newer edits</p>}
      </div>
      <div className="lp-draft-actions">
        <button className="lp-primary" onClick={() => onOpen(progress.firstIndex)}>
          {progress.attention ? 'Fix missing questions' : 'Continue'} <ArrowRight size={16} />
        </button>
        <RowMenu
          prefix="lp"
          label={'More actions for ' + title}
          disabled={busy}
          items={[{ label: 'Delete draft', onSelect: onDelete }]}
        />
      </div>
    </div>
  )
}
