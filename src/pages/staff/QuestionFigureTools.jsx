import { useMemo, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { sharedPassage, addFigure, removeFigure, addedFigures, figureWarnings, dismissFigureWarnings, restoreFigureWarnings } from '../../services/questionFigures.js'
import FigureFromPageDialog from './FigureFromPageDialog.jsx'

// Under a question in the review screen: add a figure the import missed (to the question or to its
// shared passage), take one away again, or say that the question needs no figure.
export default function QuestionFigureTools({ questions, index, sourceFile, answerKeyPage, disabled, onChange }) {
  const question = questions[index]
  const [open, setOpen] = useState(false)
  // Undo is offered only while the paper is exactly as the last added figure left it.
  const [last, setLast] = useState(null)
  const passage = useMemo(() => sharedPassage(questions, index), [questions, index])
  const figures = useMemo(() => addedFigures(questions, index), [questions, index])
  const range = passage && `${passage.numbers[0]}–${passage.numbers[passage.numbers.length - 1]}`
  const replace = change => onChange(questions.map((q, i) => (i === index ? change(q) : q)))

  function add(figure, target) {
    const next = addFigure(questions, index, figure, target)
    setLast({ before: questions, after: next, text: target === 'passage' ? `Figure added to the shared passage for questions ${range}.` : `Figure added to question ${question.number}.` })
    setOpen(false)
    onChange(next)
  }

  return (
    <div className="lp-figure-tools">
      <div className="lp-figure-actions">
        <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
          <ImagePlus size={16} aria-hidden="true" />
          Add figure from page
        </button>
        {figureWarnings(question).length > 0 && question.reviewConfirmed !== true && (
          <button type="button" disabled={disabled} onClick={() => replace(dismissFigureWarnings)}>
            No figure needed
          </button>
        )}
      </div>
      {last?.after === questions && (
        <p role="status" className="lp-figure-note">
          <span>{last.text}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(last.before)
              setLast(null)
            }}
          >
            Undo
          </button>
        </p>
      )}
      {figures.map((figure, i) => (
        <p className="lp-figure-note" key={figure.src.slice(-40) + i}>
          <span>{figure.shared ? `${figure.alt} · shown with the shared passage for questions ${range}.` : `${figure.alt}.`}</span>
          <button type="button" disabled={disabled} onClick={() => onChange(removeFigure(questions, index, figure.src))}>
            {figure.shared ? 'Remove added figure from the shared passage' : 'Remove added figure'}
          </button>
        </p>
      ))}
      {question.figureDismissed?.length > 0 && (
        <p className="lp-figure-note">
          <span>Marked as no figure needed.</span>
          <button type="button" disabled={disabled} onClick={() => replace(restoreFigureWarnings)}>
            Bring back the figure check
          </button>
        </p>
      )}
      {open && (
        <FigureFromPageDialog
          question={question}
          passage={passage}
          sourceFile={sourceFile}
          answerKeyPage={answerKeyPage}
          onAdd={add}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  )
}
