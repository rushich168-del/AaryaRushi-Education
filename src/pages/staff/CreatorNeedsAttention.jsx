import { ArrowRight } from 'lucide-react'

// Finished papers go straight to Shared. A ready copy only stays on this device when its share
// did not finish or it was brought back for editing; those are listed here. Nothing to do, nothing shown.
export default function CreatorNeedsAttention({
  papers,
  programs,
  programChoices,
  needsProgram,
  busy,
  sharingId,
  onChooseProgram,
  onShare,
  onView,
  onDelete,
}) {
  if (!papers.length) return null

  return (
    <section className="lp-panel lp-attention" aria-label="Needs attention">
      <h2>Needs attention</h2>
      {papers.map(paper => (
        <article className="lp-lib-row" key={paper.id}>
          <div className="lp-lib-info">
            <div className="lp-lib-text">
              <h3 className="lp-lib-title" title={paper.title}>
                {paper.title}
              </h3>
              <p>
                <span className="lp-lib-status">{paper.returnedReceipt ? 'Brought back for editing' : 'Not shared yet'}</span>
                {` · v${paper.version} · ${paper.exam} · ${paper.questions.length} questions · ${paper.duration} minutes`}
              </p>
            </div>
          </div>
          <div className="lp-lib-actions">
            {needsProgram(paper) && (
              <select
                className="lp-row-program"
                aria-label={'Program for ' + paper.title}
                value={programChoices[paper.id] || ''}
                onChange={event => onChooseProgram(paper.id, event.target.value)}
              >
                <option value="">Choose program</option>
                {programs.map(program => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            )}
            <button className="lp-primary" disabled={busy} onClick={() => onShare(paper)}>
              {sharingId === paper.id ? 'Sharing…' : 'Share to library'}
            </button>
            <button onClick={() => onView(paper)}>
              View version <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
              className="lp-lib-delete"
              disabled={busy}
              aria-label={'Delete device copy ' + paper.title}
              onClick={() => onDelete(paper)}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}
