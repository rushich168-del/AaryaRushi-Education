import { useState } from 'react'
import { CheckCircle2, Search, Send } from 'lucide-react'
import PaperMenu from './PaperMenu.jsx'
import { paperFacts, programInitials, sharedDate } from './paperFormat.js'

const SEARCH_FROM = 7

// One paper per row: who it is for, its size, and the one action that matters.
function PaperRow({ paper, published, highlighted, showProgram, repeatedTitle, disabled, menu, onPublish, onViewPublished }) {
  const shared = repeatedTitle ? sharedDate(paper) : ''
  return (
    <li className={'pub-paper' + (published ? ' is-published' : '') + (highlighted ? ' is-highlighted' : '')} data-paper={paper.id}>
      <span className="pub-paper-avatar" aria-hidden="true">
        {programInitials(paper.exam_name)}
      </span>
      <div className="pub-paper-text">
        <h4 className="pub-paper-title">{paper.title}</h4>
        <p className="pub-paper-facts">
          {showProgram && <span className="pub-paper-program">{paper.exam_name}</span>}
          <span>
            {paperFacts(paper)}
            {shared && ` · Shared ${shared}`}
          </span>
        </p>
      </div>
      <div className="pub-paper-actions">
        {published ? (
          <>
            <span className="pub-badge is-published">
              <CheckCircle2 size={15} aria-hidden="true" />
              Published
            </span>
            <button
              type="button"
              className="pub-button pub-button-secondary pub-button-compact"
              aria-label={`View ${paper.title} in published tests`}
              onClick={onViewPublished}
            >
              View
            </button>
          </>
        ) : (
          <button
            type="button"
            className="pub-button pub-button-primary pub-button-compact"
            aria-label={`Publish ${paper.title}`}
            data-publish={paper.id}
            disabled={disabled}
            onClick={event => onPublish(paper, event.currentTarget)}
          >
            <Send size={16} aria-hidden="true" />
            Publish
          </button>
        )}
        {menu}
      </div>
    </li>
  )
}

function Group({ label, papers, rowProps }) {
  if (!papers.length) return null
  return (
    <section className="pub-group" aria-label={label}>
      <h3 className="pub-group-title">
        {label} <span className="pub-group-count">{papers.length}</span>
      </h3>
      <ul className="pub-papers" aria-label={label}>
        {papers.map(paper => (
          <PaperRow key={paper.id} paper={paper} {...rowProps(paper)} />
        ))}
      </ul>
    </section>
  )
}

export default function PaperList({
  programName,
  papers,
  highlightedId,
  isPublished,
  disabled,
  showManagement,
  onPublish,
  onViewPublished,
  onBringBack,
  onDelete,
}) {
  const [search, setSearch] = useState('')
  const searchable = papers.length >= SEARCH_FROM
  const query = searchable ? search.trim().toLowerCase() : ''
  const visible = papers.filter(paper => paper.title.toLowerCase().includes(query))
  const titleCount = papers.reduce((counts, paper) => counts.set(paper.title, (counts.get(paper.title) || 0) + 1), new Map())
  const ready = visible.filter(paper => !isPublished(paper))
  const done = visible.filter(paper => isPublished(paper))
  const scope = programName ? `${programName} tests` : 'tests'

  const rowProps = paper => ({
    published: isPublished(paper),
    highlighted: paper.id === highlightedId,
    showProgram: !programName,
    repeatedTitle: titleCount.get(paper.title) > 1,
    disabled,
    onPublish,
    onViewPublished,
    menu: showManagement && <PaperMenu paper={paper} disabled={disabled} onBringBack={onBringBack} onDelete={onDelete} />,
  })

  return (
    <div className="pub-list">
      {searchable && (
        <label className="pub-search">
          <Search size={18} aria-hidden="true" />
          <span className="pub-visually-hidden">Search {scope}</span>
          <input type="search" placeholder={`Search ${scope}`} value={search} onChange={event => setSearch(event.target.value)} />
        </label>
      )}
      {visible.length ? (
        <>
          <Group label="Ready to publish" papers={ready} rowProps={rowProps} />
          {!ready.length && !query && (
            <p className="pub-hint pub-all-done">
              <CheckCircle2 size={18} aria-hidden="true" />
              Every {programName ? programName + ' ' : ''}paper is published. New papers from test creators appear here.
            </p>
          )}
          <Group label="Already published" papers={done} rowProps={rowProps} />
        </>
      ) : (
        <p className="pub-hint" role="status">
          No tests match “{search.trim()}”.
        </p>
      )}
    </div>
  )
}
