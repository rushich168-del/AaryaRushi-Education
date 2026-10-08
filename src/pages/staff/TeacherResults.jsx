import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BarChart3, CheckCircle2, ClipboardCheck, MinusCircle, Search, Trash2, Users, XCircle } from 'lucide-react'
import { staffAccountService as service } from '../../services/staffAccountService.js'
import PrintedContent from '../../components/site/PrintedQuestionContent.jsx'
import RowMenu from './RowMenu.jsx'
import DeleteConfirm from './DeleteConfirm.jsx'
import './results.css'

const LETTERS = 'ABCDEFGH'
const initials = name =>
  String(name || 'Learner')
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map(word => word[0])
    .join('')
    .toUpperCase()
const percent = (score, total) => (score == null || !Number(total) ? null : Math.round((Number(score) / Number(total)) * 100))
const shortDate = value => (value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const round1 = value => Math.round(value * 10) / 10

function questionState(q) {
  if (!q.selected_option_id) return 'unanswered'
  if (!q.correct_option_id) return 'unknown'
  return q.selected_option_id === q.correct_option_id ? 'correct' : 'wrong'
}
const STATE_LABEL = { correct: 'Correct', wrong: 'Wrong', unanswered: 'Unanswered', unknown: 'Answer key unavailable' }

function ScoreBlock({ score, total, large = false }) {
  const pct = percent(score, total)
  return (
    <div className={'res-score' + (large ? ' is-large' : '')}>
      <span className="res-score-value">
        {score ?? '—'} <small>/ {total ?? '—'}</small>
      </span>
      {pct === null ? (
        <span className="res-score-note">Score unavailable</span>
      ) : (
        <span className="res-meter" aria-label={`${pct} percent`}>
          <span style={{ width: Math.max(0, Math.min(100, pct)) + '%' }} />
          <b>{pct}%</b>
        </span>
      )}
    </div>
  )
}

function deleteMessage(error) {
  if (error?.code === 'STAFF_SETUP_REQUIRED') return 'Deleting results needs the latest database update. Ask your developer to apply it, then retry.'
  const message = String(error?.message || '')
  if (/no longer available|Only finished/i.test(message)) return message.endsWith('.') ? message : message + '.'
  return 'This result could not be deleted. Please retry.'
}

// Admin-only: confirm, delete on the server, then tell the screen which result went away.
function useResultDelete(onDeleted) {
  const [target, setTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    if (!target || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await service.deleteResult(target.id)
      if (!result?.deleted) throw new Error('Deleting was not confirmed.')
      onDeleted(target)
      setTarget(null)
    } catch (e) {
      setError(deleteMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const dialog = target && (
    <DeleteConfirm
      title="Delete this result?"
      summary={
        <>
          <strong>{target.student || 'Learner'}</strong>
          <span>
            {target.test} · Score {target.score ?? '—'} / {target.total_marks ?? '—'}
          </span>
        </>
      }
      facts={[
        'The score and every answer in this attempt are removed. This can’t be undone.',
        'The student can take the test again while it is still published.',
      ]}
      confirmLabel="Delete result"
      busy={busy}
      error={error}
      onCancel={() => {
        setTarget(null)
        setError('')
      }}
      onConfirm={confirm}
    />
  )
  return { ask: item => (setError(''), setTarget(item)), dialog }
}

function AnswerReview({ attempt, basePath, canDelete }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [index, setIndex] = useState(0)
  const [deleted, setDeleted] = useState(false)
  const remover = useResultDelete(() => setDeleted(true))

  useEffect(() => {
    let active = true
    setDetail(null)
    setIndex(0)
    setError('')
    setLoading(true)
    service
      .resultReview(attempt)
      .then(data => active && setDetail(data))
      .catch(e => {
        if (active)
          setError(
            e.code === 'STAFF_SETUP_REQUIRED'
              ? 'Answer review is not enabled yet. Ask the administrator to complete result-access setup.'
              : 'This answer review is unavailable. Check that the test and student belong to your assigned course and batch, or contact the administrator.',
          )
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [attempt, retry])

  const questions = detail?.questions || []
  const q = questions[index]
  const counts = questions.reduce((all, item) => ({ ...all, [questionState(item)]: (all[questionState(item)] || 0) + 1 }), {})

  return (
    <section className="results-page">
      <a className="res-back" href={basePath + '/results'}>
        <ArrowLeft size={16} aria-hidden="true" />
        All student results
      </a>
      <h2 className="res-title">Student answer review</h2>
      {deleted ? (
        <section className="res-empty" role="status">
          <span className="res-empty-icon" aria-hidden="true">
            <CheckCircle2 size={26} />
          </span>
          <h3>Result deleted</h3>
          <p>The score and answers were removed. The student can take the test again while it is published.</p>
          <a className="res-link" href={basePath + '/results'}>
            Back to all student results
          </a>
        </section>
      ) : loading ? (
        <div className="res-skeleton" role="status" aria-label="Loading answer review">
          <span />
          <span />
        </div>
      ) : error ? (
        <p className="res-alert" role="alert">
          {error}{' '}
          <button type="button" className="res-link-button" onClick={() => setRetry(x => x + 1)}>
            Retry
          </button>
        </p>
      ) : detail ? (
        <>
          <div className="res-review-head">
            <span className="res-avatar is-large" aria-hidden="true">
              {initials(detail.student)}
            </span>
            <div className="res-review-who">
              <h3>{detail.student || 'Learner'}</h3>
              <p>
                <span className="res-pill">{detail.program || 'Program label unavailable'}</span>
                {detail.test}
              </p>
              <p className="res-muted">Automatic score. This review does not change the result.</p>
            </div>
            <ScoreBlock score={detail.score} total={detail.total_marks} large />
          </div>
          {canDelete && (
            <div className="res-admin-actions">
              <button
                type="button"
                className="res-button res-button-danger"
                onClick={() => remover.ask({ id: attempt, student: detail.student, test: detail.test, score: detail.score, total_marks: detail.total_marks })}
              >
                <Trash2 size={16} aria-hidden="true" /> Delete this result
              </button>
            </div>
          )}

          {questions.length ? (
            <>
              <div className="res-tally" aria-label="Answer summary">
                <span className="is-correct">
                  <CheckCircle2 size={16} aria-hidden="true" /> {counts.correct || 0} correct
                </span>
                <span className="is-wrong">
                  <XCircle size={16} aria-hidden="true" /> {counts.wrong || 0} wrong
                </span>
                <span className="is-unanswered">
                  <MinusCircle size={16} aria-hidden="true" /> {counts.unanswered || 0} unanswered
                </span>
              </div>
              <nav className="res-qnav" aria-label="Jump to reviewed question">
                {questions.map((item, i) => (
                  <button
                    type="button"
                    key={item.question_id}
                    className={'is-' + questionState(item)}
                    aria-label={'Question ' + (i + 1)}
                    aria-pressed={index === i}
                    title={STATE_LABEL[questionState(item)]}
                    onClick={() => setIndex(i)}
                  >
                    {i + 1}
                  </button>
                ))}
              </nav>
              <article key={q.question_id} className="res-question">
                <div className="res-question-top">
                  <span className="res-question-number">
                    Question {index + 1} of {questions.length}
                    {q.section && <> · {q.section}</>}
                  </span>
                  <span className={'res-state is-' + questionState(q)}>{STATE_LABEL[questionState(q)]}</span>
                </div>
                <div className="res-question-text">
                  <PrintedContent text={q.content} />
                </div>
                <ul className="res-options">
                  {q.options.map((o, i) => {
                    const chosen = o.id === q.selected_option_id
                    const right = o.id === q.correct_option_id
                    return (
                      <li key={o.id} className={'res-option' + (right ? ' is-correct' : '') + (chosen && !right ? ' is-wrong' : '') + (chosen ? ' is-selected' : '')}>
                        <span className="res-letter" aria-hidden="true">
                          {LETTERS[i] || i + 1}
                        </span>
                        <div className="res-option-text">
                          {(chosen || right) && (
                            <strong className="res-option-tags">
                              {chosen ? 'Student answer · ' : ''}
                              {right ? 'Correct answer · ' : ''}
                            </strong>
                          )}
                          <PrintedContent text={o.content} />
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {!q.selected_option_id && <p className="res-muted">Unanswered</p>}
                {!q.correct_option_id && <p className="res-muted">Answer key unavailable</p>}
                <p className="res-marks">Marks awarded: {q.marks_awarded ?? 'Unavailable'}</p>
                {q.explanation && (
                  <div className="res-explanation">
                    <strong>Explanation</strong>
                    <PrintedContent text={q.explanation} />
                  </div>
                )}
              </article>
              <div className="res-steps">
                <button type="button" className="res-button res-button-light" disabled={index === 0} onClick={() => setIndex(i => i - 1)}>
                  <ArrowLeft size={16} aria-hidden="true" /> Previous question
                </button>
                <button type="button" className="res-button res-button-navy" disabled={index >= questions.length - 1} onClick={() => setIndex(i => i + 1)}>
                  Next question <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <p className="res-empty">No question snapshots are available.</p>
          )}
        </>
      ) : null}
      {remover.dialog}
    </section>
  )
}

export default function TeacherResults({ results, staffRole, basePath = '/dashboard/teacher' }) {
  const query = new URLSearchParams(window.location.search)
  const attempt = query.get('attempt'),
    student = query.get('student'),
    course = query.get('course'),
    testId = query.get('test')
  const [search, setSearch] = useState('')
  const [program, setProgram] = useState('')
  const [deletedIds, setDeletedIds] = useState(() => new Set())
  const [notice, setNotice] = useState('')
  const canDelete = staffRole === 'admin'
  const remover = useResultDelete(item => {
    setDeletedIds(ids => new Set(ids).add(item.id))
    setNotice(`${item.student || 'Learner'}’s result for ${item.test} was deleted.`)
  })
  if (attempt) return <AnswerReview attempt={attempt} basePath={basePath} canDelete={canDelete} />
  results = results.filter(r => !deletedIds.has(r.id))

  const programs = [...new Map(results.filter(r => r.exam_id).map(r => [r.exam_id, r.program || 'Program label unavailable'])).entries()]
  const scoped = results.filter(r => (!student || r.student_id === student) && (!course || r.course_id === course) && (!testId || r.test_id === testId))
  const visible = scoped.filter(r => (!program || r.exam_id === program) && ((r.student || '') + ' ' + (r.test || '')).toLowerCase().includes(search.toLowerCase()))
  const testResults = testId ? results.filter(r => r.test_id === testId) : []
  const testName = testResults[0]?.test || ''
  const scored = testResults.filter(r => r.score != null)
  const average = scored.length ? round1(scored.reduce((sum, r) => sum + Number(r.score), 0) / scored.length) : '—'
  const percents = visible.map(r => percent(r.score, r.total_marks)).filter(p => p !== null)
  const stats = [
    { icon: ClipboardCheck, value: visible.length, label: visible.length === 1 ? 'Result' : 'Results' },
    { icon: Users, value: new Set(visible.map(r => r.student_id || r.student)).size, label: 'Students' },
    { icon: BarChart3, value: percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) + '%' : '—', label: 'Average score' },
  ]

  return (
    <section className="results-page">
      <header className="res-header">
        <h2 className="res-title">Student results</h2>
        <p>
          {staffRole === 'admin'
            ? 'All completed student results, including shared practice tests.'
            : 'Completed results for tests you published and for students in your assigned batches.'}{' '}
          Open a result to check the student’s answers and the frozen answer key.
        </p>
      </header>

      {testId && (
        <div className="result-test-banner" role="status">
          <div>
            <strong>{testName ? 'Results for ' + testName : 'Results for one published test'}</strong>
            <span>
              {testResults.length
                ? `${testResults.length} ${testResults.length === 1 ? 'student has' : 'students have'} finished this test` +
                  (scored.length ? ` · Average ${average} / ${testResults[0].total_marks ?? '—'}` : '')
                : 'No student has finished this test yet.'}
            </span>
          </div>
          <a className="res-link" href={basePath + '/results'}>
            Show all results
          </a>
        </div>
      )}

      {notice && (
        <p className="res-notice" role="status">
          <CheckCircle2 size={18} aria-hidden="true" /> {notice}
        </p>
      )}

      {results.length > 0 && (
        <div className="res-stats">
          {stats.map(({ icon: Icon, value, label }) => (
            <div className="res-stat" key={label}>
              <span className="res-stat-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <div>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <div className="res-filters">
          {programs.length > 1 && !testId && (
            <div className="res-chips" role="group" aria-label="Filter student results by program">
              <button type="button" aria-pressed={!program} onClick={() => setProgram('')}>
                All programs
              </button>
              {programs.map(([id, name]) => (
                <button type="button" key={id} aria-pressed={program === id} onClick={() => setProgram(id)}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <label className="res-search">
            <Search size={18} aria-hidden="true" />
            <span className="res-visually-hidden">Search student or test</span>
            <input type="search" placeholder="Search student or test" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          {(student || course) && (
            <a className="res-link" href={basePath + '/results'}>
              Clear student/course filter
            </a>
          )}
        </div>
      )}

      {visible.length ? (
        <ul className="res-list" aria-label="Completed results">
          {visible.map(r => (
            <li className={'res-row' + (canDelete ? ' is-managed' : '')} key={r.id}>
              <span className="res-avatar" aria-hidden="true">
                {initials(r.student)}
              </span>
              <div className="res-row-main">
                <h3>{r.student || 'Learner'}</h3>
                <p>
                  {r.program && <span className="res-pill">{r.program}</span>}
                  <span>{r.test}</span>
                  {r.submitted_at && <span className="res-date">· {shortDate(r.submitted_at)}</span>}
                </p>
              </div>
              <ScoreBlock score={r.score} total={r.total_marks} />
              <a className="res-button res-button-outline" href={basePath + '/results?attempt=' + encodeURIComponent(r.id)}>
                View answers
              </a>
              {canDelete && (
                <RowMenu
                  prefix="res"
                  label={`More actions for ${r.student || 'Learner'}, ${r.test}`}
                  items={[{ label: 'Delete result', danger: true, onSelect: () => (setNotice(''), remover.ask(r)) }]}
                />
              )}
            </li>
          ))}
        </ul>
      ) : results.length ? (
        <p className="res-empty" role="status">
          {search ? `No results match “${search}”.` : 'No results in this view yet.'}
        </p>
      ) : (
        <section className="res-empty">
          <span className="res-empty-icon" aria-hidden="true">
            <ClipboardCheck size={26} />
          </span>
          <h3>No completed results yet</h3>
          <p>
            Results appear after students finish tests. You can see results for tests you published and for students in your assigned
            batches.
          </p>
          {staffRole === 'admin' && (
            <a className="res-link" href="/dashboard/admin/assignments">
              Check student & teacher assignments →
            </a>
          )}
        </section>
      )}
      {remover.dialog}
    </section>
  )
}
