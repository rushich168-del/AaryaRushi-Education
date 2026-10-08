import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { examLibraryService } from '../../services/examLibraryService.js'
import { bringBackSharedPaper } from '../../services/librarySharing.js'
import AdminPaperImport from './publishing/AdminPaperImport.jsx'
import PaperList from './publishing/PaperList.jsx'
import ProgramPicker from './publishing/ProgramPicker.jsx'
import PublishDialog from './publishing/PublishDialog.jsx'
import PublishSuccess from './publishing/PublishSuccess.jsx'
import PublishedList from './publishing/PublishedList.jsx'
import DeleteConfirm from './DeleteConfirm.jsx'
import { deliveryAudience, plainMessage, publicationKey } from './publishing/paperFormat.js'
import { clearRequest, requestIdFor } from './publishing/publishRequest.js'
import { usePublishingLibrary } from './publishing/usePublishingLibrary.js'
import './publishing/publishing.css'

const viewFromUrl = () => (new URLSearchParams(window.location.search).get('view') === 'published' ? 'published' : 'library')

function programsFrom(papers, isPublished) {
  const programs = new Map()
  for (const paper of papers) {
    const program = programs.get(paper.exam_id) || { id: paper.exam_id, name: paper.exam_name, ready: 0 }
    if (!isPublished(paper)) program.ready += 1
    programs.set(paper.exam_id, program)
  }
  return [...programs.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function LibrarySkeleton() {
  return (
    <div className="pub-skeleton" role="status" aria-label="Loading papers">
      <span className="pub-skeleton-chip" />
      <span className="pub-skeleton-chip" />
      <span className="pub-skeleton-chip" />
      <span className="pub-skeleton-row" />
      <span className="pub-skeleton-row" />
      <span className="pub-skeleton-row" />
    </div>
  )
}

// Publish a test: every ready paper has its own Publish button → confirm → done.
// Admins and teachers share this screen; only admins get paper management.
export default function ProgramLibraryWorkspace({ adminView = false, basePath = '/dashboard/teacher', api = examLibraryService }) {
  const [tab, setTab] = useState(viewFromUrl)
  const [programId, setProgramId] = useState('')
  const [highlightId, setHighlightId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [success, setSuccess] = useState(null)
  const [justPublished, setJustPublished] = useState(() => new Set())
  const [managing, setManaging] = useState(false)
  const [actionError, setActionError] = useState('')
  const [broughtBack, setBroughtBack] = useState('')
  const [linkError, setLinkError] = useState('')
  const [removing, setRemoving] = useState(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const [removed, setRemoved] = useState(null)

  const link = useRef(new URLSearchParams(window.location.search))
  const working = useRef(false)
  const lastTrigger = useRef(null)
  const chooser = useRef(null)
  const library = usePublishingLibrary(api, working)
  const requestKey = 'ksc-program-publication:' + basePath

  const publishedKeys = new Set([...library.programTests.map(test => publicationKey(test.version_id, test.exam_id)), ...justPublished])
  const isPublished = paper => publishedKeys.has(publicationKey(paper.id, paper.exam_id))
  const programs = programsFrom(library.papers, isPublished)
  const activeProgram = programs.find(program => program.id === programId)
  const shownPapers = activeProgram ? library.papers.filter(paper => paper.exam_id === activeProgram.id) : library.papers
  const target = library.papers.find(paper => paper.id === targetId)
  const readyCount = library.papers.filter(paper => !isPublished(paper)).length
  const locked = publishing || managing

  // ?paper=<id> shows that paper's program with the paper highlighted;
  // &publish=1 (the dashboard's Publish link) goes straight to the confirm step.
  useEffect(() => {
    const requested = link.current.get('paper')
    if (library.loading || library.error || !requested) return
    const wantsPublish = link.current.get('publish') === '1'
    link.current = new URLSearchParams()
    const url = new URL(window.location.href)
    url.searchParams.delete('paper')
    url.searchParams.delete('publish')
    window.history.replaceState({}, '', url.pathname + url.search)
    const match = library.papers.find(paper => paper.id === requested)
    if (!match) {
      setLinkError('This paper is no longer in the library. Choose another test.')
      return
    }
    setProgramId(match.exam_id)
    setHighlightId(match.id)
    if (wantsPublish && !isPublished(match)) setTargetId(match.id)
  }, [library.loading, library.error, library.papers]) // eslint-disable-line react-hooks/exhaustive-deps

  // Bring a linked paper into view and put focus on its action.
  useEffect(() => {
    if (!highlightId || targetId) return
    const row = chooser.current?.querySelector(`[data-paper="${CSS.escape(highlightId)}"]`)
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('.pub-paper-actions button')?.focus({ preventScroll: true })
  }, [highlightId, targetId])

  function switchTab(next) {
    setTab(next)
    if (next === 'published') setSuccess(null)
    else setRemoved(null)
    const url = new URL(window.location.href)
    if (next === 'published') url.searchParams.set('view', 'published')
    else url.searchParams.delete('view')
    window.history.replaceState({}, '', url.pathname + url.search)
    // The sidebar highlights "Published tests" or "Paper library" from this.
    window.dispatchEvent(new Event('ksc-library-view'))
  }

  function selectProgram(id) {
    setProgramId(id)
    setHighlightId('')
    setSuccess(null)
    setLinkError('')
  }

  function openPublish(paper, trigger) {
    lastTrigger.current = trigger
    setHighlightId(paper.id)
    setTargetId(paper.id)
    setSuccess(null)
    setLinkError('')
  }

  function closeDialog() {
    const id = targetId
    setTargetId('')
    setPublishError('')
    requestAnimationFrame(() => {
      const trigger = lastTrigger.current?.isConnected ? lastTrigger.current : chooser.current?.querySelector(`[data-publish="${CSS.escape(id)}"]`)
      trigger?.focus()
    })
  }

  async function publish() {
    if (working.current || !target) return
    working.current = true
    setPublishing(true)
    setPublishError('')
    const paper = target
    try {
      const requestId = requestIdFor(requestKey, JSON.stringify([paper.id, paper.exam_id, paper.title]))
      const result = await api.publishProgram(paper.id, paper.exam_id, paper.title, requestId)
      if (!result?.test_id) throw new Error('Publishing was not confirmed. Retry to check this test.')
      clearRequest(requestKey)
      setJustPublished(keys => new Set(keys).add(publicationKey(paper.id, paper.exam_id)))
      setSuccess({ title: paper.title, program: paper.exam_name, alreadyPublished: Boolean(result.already_published) })
      setTargetId('')
      setHighlightId(paper.id)
      library.refresh()
    } catch (error) {
      setPublishError(plainMessage(error, 'This test could not be published. Please retry.'))
    } finally {
      setPublishing(false)
      working.current = false
    }
  }

  async function manage(paper, action) {
    if (working.current) return
    working.current = true
    setManaging(true)
    setActionError('')
    setBroughtBack('')
    try {
      await action()
      if (paper.id === highlightId) setHighlightId('')
      library.refresh()
    } catch (error) {
      setActionError(plainMessage(error, 'That could not be completed. Please retry.'))
    } finally {
      setManaging(false)
      working.current = false
    }
  }

  function bringBack(paper) {
    return manage(paper, async () => {
      await bringBackSharedPaper(paper.id, api)
      setBroughtBack(paper.title)
    })
  }

  function deletePaper(paper) {
    if (!window.confirm('Delete ' + paper.title + ' from the shared library? Published tests and results are kept.')) return
    return manage(paper, () => api.archive(paper.id))
  }

  async function removePublished() {
    if (working.current || !removing) return
    working.current = true
    setRemoveBusy(true)
    setRemoveError('')
    const test = removing
    try {
      const result = await api.withdrawPublished(test.test_id)
      if (!result?.withdrawn) throw new Error('Deleting was not confirmed. Retry to check this test.')
      if (test.version_id) setJustPublished(keys => {
        const next = new Set(keys)
        next.delete(publicationKey(test.version_id, test.exam_id))
        return next
      })
      setRemoved({ title: test.title, kept: Number(result.results_kept) || 0 })
      setRemoving(null)
      library.refresh()
    } catch (error) {
      setRemoveError(plainMessage(error, 'This test could not be deleted. Please retry.'))
    } finally {
      setRemoveBusy(false)
      working.current = false
    }
  }

  function publishAnother() {
    setSuccess(null)
    setHighlightId('')
    requestAnimationFrame(() => chooser.current?.querySelector('[data-publish]')?.focus())
  }

  const showingLibrary = tab === 'library'
  return (
    <div className="publish-journey">
      <header className="pub-header">
        <div>
          <h2>{showingLibrary ? 'Publish a test' : 'Published tests'}</h2>
          <p>
            {showingLibrary
              ? 'Press Publish on any ready paper. Students in its program can take it right away.'
              : 'Tests your students can take, newest first.'}
          </p>
        </div>
        <button
          type="button"
          className="pub-icon-button"
          aria-label="Refresh"
          disabled={library.refreshing || locked}
          onClick={library.refresh}
        >
          <RefreshCw size={18} aria-hidden="true" className={library.refreshing ? 'pub-spinning' : ''} />
        </button>
      </header>

      <div className="pub-tabs" role="group" aria-label="Library view">
        <button type="button" aria-pressed={showingLibrary} onClick={() => switchTab('library')}>
          Ready papers
          {!library.loading && <span className="pub-tab-count">{readyCount}</span>}
        </button>
        <button type="button" aria-pressed={!showingLibrary} onClick={() => switchTab('published')}>
          Published tests
          {!library.loading && <span className="pub-tab-count">{library.published.length}</span>}
        </button>
      </div>

      {library.loading ? (
        <LibrarySkeleton />
      ) : showingLibrary ? (
        <>
          {library.error && (
            <p className="pub-alert" role="alert">
              {library.error}
              <button type="button" className="pub-link-button" onClick={library.refresh}>
                Retry
              </button>
            </p>
          )}
          {linkError && <p className="pub-alert" role="alert">{linkError}</p>}
          {actionError && <p className="pub-alert" role="alert">{actionError}</p>}
          {success && (
            <PublishSuccess result={success} onViewPublished={() => switchTab('published')} onPublishAnother={publishAnother} />
          )}
          {broughtBack && (
            <section className="pub-success" role="status">
              <CheckCircle2 className="pub-success-icon" size={28} aria-hidden="true" />
              <div>
                <h3>Paper brought back</h3>
                <p>
                  <strong>{broughtBack}</strong> is now a ready copy in this browser. Published tests and results are kept.
                </p>
                <a className="pub-test-link" href="/testcreator/preview?view=library">
                  Open ready copy to edit →
                </a>
              </div>
            </section>
          )}
          {library.papers.length ? (
            <div ref={chooser} className="pub-choose">
              <ProgramPicker programs={programs} selectedId={activeProgram?.id || ''} disabled={locked} onSelect={selectProgram} />
              <PaperList
                key={activeProgram?.id || 'all'}
                programName={activeProgram?.name || (programs.length === 1 ? programs[0].name : '')}
                papers={shownPapers}
                highlightedId={highlightId}
                isPublished={isPublished}
                disabled={locked}
                showManagement={adminView}
                onPublish={openPublish}
                onViewPublished={() => switchTab('published')}
                onBringBack={bringBack}
                onDelete={deletePaper}
              />
            </div>
          ) : (
            !library.error && (
              <section className="pub-empty">
                <h3>No ready papers yet</h3>
                <p>A test creator shares finished papers here.</p>
              </section>
            )
          )}
          {adminView && <AdminPaperImport onAdded={library.refresh} />}
        </>
      ) : (
        <>
          {removed && (
            <section className="pub-success" role="status">
              <CheckCircle2 className="pub-success-icon" size={28} aria-hidden="true" />
              <div>
                <h3>Published test deleted</h3>
                <p>
                  <strong>{removed.title}</strong> is no longer available to students.{' '}
                  {removed.kept
                    ? `${removed.kept} submitted ${removed.kept === 1 ? 'result is' : 'results are'} kept in Student results.`
                    : 'No student had submitted it.'}{' '}
                  The paper stays in Ready papers if you want to publish it again.
                </p>
              </div>
            </section>
          )}
          <PublishedList
            tests={library.published}
            error={library.historyError}
            resultsHref={basePath + '/results'}
            canDelete={adminView}
            disabled={removeBusy}
            onRetry={library.refresh}
            onChooseTest={() => switchTab('library')}
            onDelete={test => {
              setRemoved(null)
              setRemoveError('')
              setRemoving(test)
            }}
          />
        </>
      )}

      {removing && (
        <DeleteConfirm
          title="Delete this published test?"
          summary={
            <>
              <strong>{removing.title}</strong>
              <span>{deliveryAudience(removing)}</span>
            </>
          }
          facts={[
            'Students can no longer see or start it.',
            'Results already submitted stay in Student results.',
            'The paper stays in Ready papers, so you can publish it again.',
          ]}
          confirmLabel="Delete test"
          busy={removeBusy}
          error={removeError}
          onCancel={() => {
            setRemoving(null)
            setRemoveError('')
          }}
          onConfirm={removePublished}
        />
      )}
      {target && (
        <PublishDialog paper={target} busy={publishing} error={publishError} onCancel={closeDialog} onPublish={publish} />
      )}
    </div>
  )
}
