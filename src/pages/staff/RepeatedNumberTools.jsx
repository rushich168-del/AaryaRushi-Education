import { useState } from 'react'
import { mergeCopy, deleteQuestion, renumberFrom } from '../../services/repeatedNumbers.js'
import ConfirmDialog from './ConfirmDialog.jsx'

// Shown on the extra copy of a repeated question number. onApply receives the paper fields to change,
// the sentence for the Undo notice, and the question to show afterwards.
export default function RepeatedNumberTools({ paper, index, disabled, onApply }) {
  const [asking, setAsking] = useState(null)
  const number = paper.questions[index].number

  return (
    <div className="lp-repeat-tools" role="group" aria-label={`Question ${number} is used twice`}>
      <strong>Question number {number} is used twice.</strong>
      <p>
        An earlier question already has this number. If this is the same question in another language, merge it. Renumber
        only when the paper really has one more question.
      </p>
      <div className="lp-repeat-actions">
        <button
          type="button"
          className="lp-primary"
          disabled={disabled}
          onClick={() => {
            const { target, ...patch } = mergeCopy(paper, index)
            onApply(patch, `Merged into question ${number}.`, target)
          }}
        >
          Merge into question {number} (same question in another language)
        </button>
        <button type="button" disabled={disabled} onClick={() => setAsking('delete')}>
          Delete this question
        </button>
        <button type="button" disabled={disabled} onClick={() => setAsking('renumber')}>
          Renumber from here…
        </button>
      </div>
      {asking === 'delete' && (
        <ConfirmDialog
          titleId="lp-delete-question-title"
          title="Delete this question?"
          confirmLabel="Delete question"
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null)
            onApply(deleteQuestion(paper, index), `Question ${number} deleted.`, index)
          }}
        >
          <p>
            This copy of question {number} will be removed from the draft. The earlier question {number} is kept. You can undo
            this straight afterwards.
          </p>
        </ConfirmDialog>
      )}
      {asking === 'renumber' && (
        <ConfirmDialog
          titleId="lp-renumber-title"
          title="Renumber from here?"
          confirmLabel="Renumber"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null)
            onApply(renumberFrom(paper, index), `Renumbered from question ${Number(number) + 1}.`, index)
          }}
        >
          <p>
            This question becomes {Number(number) + 1} and every question after it moves up by one. Use this only when the
            paper really has an extra question; check its answer afterwards.
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

// A numbering or count issue as the creator reads it. The repeated-number line links to each extra copy.
export function NumberingIssue({ issue, copies, onOpen }) {
  if (!/^Repeated question numbers:/.test(issue) || !copies.length) return issue
  return (
    <>
      Repeated question numbers:{' '}
      {copies.map((copy, i) => (
        <span key={copy.index}>
          {i > 0 && ', '}
          <button type="button" className="lp-inline-link" aria-label={`Open the extra copy of question ${copy.number}`} onClick={() => onOpen(copy.index)}>
            {copy.number}
          </button>
        </span>
      ))}
      . Open each one to merge or delete the extra copy.
    </>
  )
}
