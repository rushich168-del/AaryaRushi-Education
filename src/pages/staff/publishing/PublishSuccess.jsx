import { useEffect, useRef } from 'react'
import { CheckCircle2 } from 'lucide-react'

export default function PublishSuccess({ result, onViewPublished, onPublishAnother }) {
  const card = useRef(null)

  // Bring the confirmation into view, including on phones where Publish sat at the bottom.
  useEffect(() => {
    card.current?.focus()
    card.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  return (
    <section ref={card} className="pub-success" role="status" tabIndex={-1}>
      <CheckCircle2 className="pub-success-icon" size={28} aria-hidden="true" />
      <div>
        <h3>{result.alreadyPublished ? 'Already published' : 'Test published'}</h3>
        <p>
          <strong>{result.title}</strong>{' '}
          {result.alreadyPublished
            ? `was already available to ${result.program} students. Nothing was published twice.`
            : `is now available to ${result.program} students.`}
        </p>
        <div className="pub-success-actions">
          <button type="button" className="pub-button pub-button-navy" onClick={onViewPublished}>
            View published tests
          </button>
          <button type="button" className="pub-button pub-button-secondary" onClick={onPublishAnother}>
            Publish another
          </button>
        </div>
      </div>
    </section>
  )
}
