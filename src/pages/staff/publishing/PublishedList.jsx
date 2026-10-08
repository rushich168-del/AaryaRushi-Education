import { useState } from 'react'
import RowMenu from '../RowMenu.jsx'
import { deliveryAudience, deliveryGroup, deliveryStatus, publishedDate, resultsLink } from './paperFormat.js'

export default function PublishedList({ tests, error, resultsHref, canDelete = false, disabled = false, onRetry, onChooseTest, onDelete }) {
  const [group, setGroup] = useState('')
  const groups = [...new Set(tests.map(deliveryGroup))]
  const activeGroup = groups.includes(group) ? group : ''
  const visible = activeGroup ? tests.filter(test => deliveryGroup(test) === activeGroup) : tests

  const alert = error && (
    <p className="pub-alert" role="alert">
      {error}
      <button type="button" className="pub-link-button" onClick={onRetry}>
        Retry
      </button>
    </p>
  )

  if (!tests.length) {
    if (alert) return alert
    return (
      <section className="pub-empty">
        <h3>No published tests yet</h3>
        <p>Publish a ready paper and it will appear here.</p>
        <button type="button" className="pub-button pub-button-primary" onClick={onChooseTest}>
          Choose a test
        </button>
      </section>
    )
  }

  return (
    <>
      {alert}
      {groups.length > 1 && (
        <div className="pub-chips pub-filter" role="group" aria-label="Filter published tests">
          <button type="button" className="pub-chip pub-chip-small" aria-pressed={!activeGroup} onClick={() => setGroup('')}>
            All
          </button>
          {groups.map(name => (
            <button
              key={name}
              type="button"
              className="pub-chip pub-chip-small"
              aria-pressed={name === activeGroup}
              onClick={() => setGroup(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <ul className="pub-tests" aria-label="Published tests">
        {visible.map(test => {
          const status = deliveryStatus(test)
          const facts = [test.question_count != null && `${test.question_count} questions`, publishedDate(test) && `Published ${publishedDate(test)}`].filter(Boolean)
          return (
            <li className={'pub-test' + (canDelete ? ' is-managed' : '')} key={test.id}>
              <div className="pub-test-text">
                <h3>{test.title}</h3>
                <p>{deliveryAudience(test)}</p>
                {facts.length > 0 && <p>{facts.join(' · ')}</p>}
              </div>
              <span className={'pub-status is-' + status.toLowerCase()}>{status}</span>
              <a className="pub-test-link" href={resultsLink(resultsHref, test)} aria-label={`Student results for ${test.title}`}>
                Student results →
              </a>
              {canDelete && test.test_id && (
                <RowMenu
                  label={`More actions for ${test.title}`}
                  disabled={disabled}
                  items={[{ label: 'Delete published test', danger: true, onSelect: () => onDelete(test) }]}
                />
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
