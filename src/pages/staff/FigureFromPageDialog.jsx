import { useEffect, useRef, useState } from 'react'
import SourcePagePicker from '../../components/site/SourcePagePicker.jsx'
import { keepTabInside } from './dialogFocus.js'

// The creator drags a rectangle on a page of the source PDF; the crop becomes a figure of this question,
// or of the shared passage so every question of the passage shows it. onAdd receives (figure, target).
export default function FigureFromPageDialog({ question, passage, sourceFile, answerKeyPage, onAdd, onCancel }) {
  const dialog = useRef(null)
  const [target, setTarget] = useState('question')
  const range = passage && `${passage.numbers[0]}–${passage.numbers[passage.numbers.length - 1]}`

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="lp-dialog lp-figure-dialog"
      aria-labelledby="lp-figure-title"
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
      <h2 id="lp-figure-title">Add figure from page</h2>
      <p>Open the page of the paper that shows the figure, table or diagram, and drag a rectangle around it.</p>
      {passage && (
        <fieldset className="lp-figure-target">
          <legend>Add it to</legend>
          <label>
            <input type="radio" name="lp-figure-target" checked={target === 'question'} onChange={() => setTarget('question')} />
            This question (Q{question.number})
          </label>
          <label>
            <input type="radio" name="lp-figure-target" checked={target === 'passage'} onChange={() => setTarget('passage')} />
            The shared passage for questions {range}
          </label>
        </fieldset>
      )}
      <SourcePagePicker
        sourceFile={sourceFile}
        initialPage={question.sourcePages?.[0] || 1}
        answerKeyPage={answerKeyPage}
        actionLabel="Add figure"
        actionClassName="lp-primary lp-figure-add"
        hint="Drag around the figure only. You can add more than one."
        tooSmall="Draw a larger rectangle around the figure."
        onCrop={(src, page) => onAdd({ src, page }, target)}
      />
      <div className="lp-dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  )
}
