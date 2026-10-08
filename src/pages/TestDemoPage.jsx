import { useEffect, useRef, useState } from 'react'
import { Clock, Flag } from 'lucide-react'
import PublicLayout from '../components/site/PublicLayout.jsx'
import '../features/tests/demo-workspace.css'
import TestResults from '../features/tests/TestResults.jsx'
import { createAttempt, isValidAttempt, remainingSeconds, storageKey, updateAttempt } from '../features/tests/demoAttempt.js'

function readSaved(test) {
  try {
    const raw = window.localStorage.getItem(storageKey(test))
    if (!raw) return { attempt: null, notice: '' }
    const saved = JSON.parse(raw)
    if (!isValidAttempt(saved, test)) return { attempt: null, notice: 'The saved demo attempt is not compatible with this test. Start a new attempt to continue.' }
    return { attempt: updateAttempt(saved, { type: 'tick' }, test), notice: '' }
  } catch { return { attempt: null, notice: 'Saved progress could not be read. You can start the demo, but browser storage may be unavailable.' } }
}

function timerText(seconds) {
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
}

export default function TestDemoPage({ test, loadKey }) {
  const [initial] = useState(() => readSaved(test))
  const [attempt, setAttempt] = useState(initial.attempt)
  const current = useRef(initial.attempt)
  const [notice, setNotice] = useState(initial.notice)
  const [now, setNow] = useState(Date.now())
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const questionHeading = useRef(null)
  const questionBody = useRef(null)
  const submitDialog = useRef(null)
  const submitTrigger = useRef(null)

  useEffect(() => {
    if (confirmSubmit) submitDialog.current?.showModal()
    else if (submitDialog.current?.open) submitDialog.current.close()
  }, [confirmSubmit])

  function persist(next) {
    current.current = next
    setAttempt(next)
    try {
      if (next) window.localStorage.setItem(storageKey(test), JSON.stringify(next))
      else window.localStorage.removeItem(storageKey(test))
    } catch { setNotice('Browser storage is unavailable. Your answers work in this tab, but leaving or refreshing may lose this attempt.') }
  }

  function act(action) {
    let base = current.current
    // Respect another tab's final submission before applying a new answer.
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey(test)) || 'null')
      if (action.type !== 'tick' && isValidAttempt(saved, test) && saved.startedAt === base?.startedAt) base = saved
    } catch { /* The in-memory attempt still works when storage is unavailable. */ }
    const next = updateAttempt(base, action, test)
    if (next !== current.current) persist(next)
  }

  useEffect(() => {
    if (initial.attempt) persist(initial.attempt)
    function sync(event) {
      if (event.key !== storageKey(test)) return
      const saved = readSaved(test)
      current.current = saved.attempt
      setAttempt(saved.attempt)
      if (saved.notice) setNotice(saved.notice)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [test])

  useEffect(() => {
    if (attempt?.status !== 'in-progress') return
    const tick = () => { setNow(Date.now()); act({ type: 'tick' }) }
    const timer = window.setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    tick()
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick) }
  }, [attempt?.status, test])

  const answered = attempt ? Object.keys(attempt.answers).length : 0
  const seconds = attempt ? remainingSeconds(attempt, now) : test.durationSeconds
  const question = attempt ? test.questions[attempt.currentIndex] : null
  function go(index) {
    act({ type: 'navigate', index })
    setConfirmSubmit(false)
    setNavigatorOpen(false)
    requestAnimationFrame(() => { questionHeading.current?.focus({ preventScroll: true }); questionBody.current?.scrollTo({ top: 0 }) })
  }

  function requestSubmit(event) {
    submitTrigger.current = event.currentTarget
    setConfirmSubmit(true)
  }

  return <PublicLayout><div className={attempt?.status === 'in-progress' ? 'demo-workspace' : 'mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12'}>
    {attempt?.status !== 'in-progress' && <><a href={'/exams/' + test.examSlug} className="inline-flex min-h-11 items-center text-blue-700 font-semibold mb-3">← Exam overview</a>
    <div className="mb-6"><p className="text-xs font-bold uppercase tracking-widest text-blue-700 mb-2">Free sample test · Demo answer key</p><h1 className="text-3xl sm:text-4xl font-extrabold">{test.title}</h1></div></>}
    {notice && <p role="alert" className="demo-storage-notice mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">{notice}</p>}
    {!attempt && <section className="max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
      <h2 className="text-2xl font-bold mb-4">Before you start</h2>
      <div className="flex flex-wrap gap-3 mb-6">{[test.questions.length + ' questions', test.durationSeconds / 60 + ' minutes', 'English'].map(label => <span key={label} className="rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-900">{label}</span>)}</div>
      <ul className="list-disc pl-5 space-y-3 text-slate-700 leading-7">
        <li>Read the options in the paper and select one option number for each question. You can change or clear your answer before submission.</li>
        <li>Use the question navigator to jump between subjects. Mark questions for review if you want to return to them.</li>
        <li>The timer starts when you select Start test. It continues if you close or refresh this page, and the test submits when time ends.</li>
        <li>Demo marking: +{test.marksPerCorrect} for a correct answer, no negative marking. These are demo settings.</li>
        <li>Every question has a worked explanation in the answer review. The maximum score is {(test.questions.length - test.excludedQuestionCount) * test.marksPerCorrect}.</li>
        <li>Your result and answer key appear only after submission. Progress stays in this browser; it is not sent to the institute. Use one tab for the demo.</li>
      </ul>
      <p className="mt-6 text-sm text-slate-500">This is a practice attempt, not a scheduled admission or recruitment exam.</p>
      <button onClick={() => { setNow(Date.now()); persist(createAttempt(test)); }} className="mt-6 min-h-12 rounded-lg bg-blue-600 px-7 py-3 font-bold text-white hover:bg-blue-700">Start test</button>
    </section>}
    {attempt?.status === 'in-progress' && <>
      <div className="demo-topbar">
        <div className="demo-test-title"><a href={'/exams/' + test.examSlug}>← Exam overview</a><h1>{test.title}</h1><span>Sample test</span></div>
        <p className="demo-progress">{answered} / {test.questions.length} answered</p>
        <p aria-label={'Time remaining ' + timerText(seconds)} className={'flex items-center gap-2 font-mono text-xl font-bold ' + (seconds < 300 ? 'text-red-700' : 'text-blue-900')}><Clock size={20} aria-hidden="true" /><span data-testid="exam-timer">{timerText(seconds)}</span></p>
      </div>
      <div className={'demo-exam-grid' + (navigatorOpen ? ' navigator-open' : '')}>
        <section className="demo-question-panel">
          <div className="demo-question-heading"><div><p>{question.subject}</p><h2 ref={questionHeading} tabIndex={-1}>Question {question.id} <span>of {test.questions.length}</span></h2></div><button className="demo-navigator-toggle" aria-expanded={navigatorOpen} aria-controls="demo-question-navigator" onClick={() => setNavigatorOpen(!navigatorOpen)}>{navigatorOpen ? 'Hide questions' : 'All questions'}</button></div>
          <div ref={questionBody} tabIndex={0} role="region" aria-label="Question text" className="demo-question-body text-base sm:text-lg leading-8 break-words">{question.paragraphs.map((paragraph, index) => <p className="whitespace-pre-wrap" key={index} lang={/[\u0C00-\u0C7F]/.test(paragraph) ? 'te' : 'en'}>{paragraph}</p>)}</div>
          <div className="demo-answer-dock">
          <fieldset><legend>Your answer <span>Choose the option number above</span></legend><div className="demo-option-grid">{question.optionIds.map(option => <label key={option} className={'demo-option ' + (attempt.answers[question.id] === option ? 'is-selected' : '')}><input type="radio" name={'question-' + question.id} value={option} checked={attempt.answers[question.id] === option} onChange={() => act({ type: 'answer', option })} className="h-4 w-4 accent-blue-600" /><span>Option {option}</span></label>)}</div></fieldset>
          <div className="demo-controls">
          <div className="mt-5 flex flex-wrap gap-3"><button onClick={() => act({ type: 'clear' })} disabled={!attempt.answers[question.id]} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40">Clear answer</button><button aria-pressed={attempt.review.includes(question.id)} onClick={() => act({ type: 'review' })} className={'min-h-11 flex items-center gap-2 rounded-lg border px-4 text-sm font-semibold ' + (attempt.review.includes(question.id) ? 'bg-amber-50 border-amber-400 text-amber-900' : 'border-slate-300')}><Flag size={16} aria-hidden="true" />{attempt.review.includes(question.id) ? 'Marked for review' : 'Mark for review'}</button></div>
          <div className="demo-step-actions"><button onClick={() => go(attempt.currentIndex - 1)} disabled={attempt.currentIndex === 0} className="min-h-11 rounded-lg border border-slate-300 px-5 font-semibold disabled:opacity-40">Previous</button>{attempt.currentIndex < test.questions.length - 1 ? <button onClick={() => go(attempt.currentIndex + 1)} className="min-h-11 rounded-lg bg-blue-600 px-6 font-semibold text-white">Next</button> : <button onClick={requestSubmit} className="min-h-11 rounded-lg bg-blue-600 px-6 font-semibold text-white">Finish test</button>}<button onClick={requestSubmit} className="demo-submit-shortcut">Submit test</button></div>
          </div></div>
        </section>
        <aside id="demo-question-navigator" className="demo-navigator" hidden={!navigatorOpen}>
          <h2 className="text-lg font-bold mb-3">Question navigator</h2>
          <p className="text-xs leading-6 text-slate-600 mb-4">Blue: answered · White: unanswered · Amber: marked for review. Marked answers are still submitted.</p>
          {[...new Set(test.questions.map(q => q.subject))].map(subject => <div key={subject} className="mb-5"><h3 className="text-sm font-semibold mb-2">{subject}</h3><div className="grid grid-cols-5 gap-2">{test.questions.filter(q => q.subject === subject).map(q => {
            const index = test.questions.indexOf(q)
            const marked = attempt.review.includes(q.id)
            const selected = Boolean(attempt.answers[q.id])
            return <button key={q.id} onClick={() => go(index)} aria-label={'Go to question ' + q.id + ', ' + (selected ? 'answered' : 'unanswered') + (marked ? ', marked for review' : '')} aria-current={question.id === q.id ? 'step' : undefined} className={'min-h-11 rounded-lg border text-sm font-semibold ' + (marked ? 'bg-amber-50 border-amber-400 text-amber-900' : selected ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 bg-white') + (question.id === q.id ? ' ring-2 ring-offset-2 ring-slate-900' : '')}>{q.id}</button>
          })}</div></div>)}
          <button onClick={requestSubmit} className="w-full min-h-12 rounded-lg bg-slate-900 px-4 py-3 font-semibold text-white">Submit test</button>
        </aside>
      </div>
      <dialog ref={submitDialog} id="confirm-submission" aria-label="Confirm submission" className="demo-submit-dialog" onCancel={() => setConfirmSubmit(false)} onClose={() => { setConfirmSubmit(false); submitTrigger.current?.focus() }}>
        <h2 className="text-2xl font-bold mb-3">Ready to submit?</h2><p className="text-slate-600 leading-7">{answered} answered, {test.questions.length - answered} unanswered, {attempt.review.length} marked for review. You cannot change answers after submission.</p>
        <div className="mt-5 flex flex-wrap gap-3"><button onClick={() => { act({ type: 'submit' }); setConfirmSubmit(false); window.scrollTo({ top: 0, behavior: 'instant' }) }} className="min-h-11 rounded-lg bg-blue-600 px-5 py-3 font-bold text-white">Confirm and submit</button><button onClick={() => setConfirmSubmit(false)} className="min-h-11 rounded-lg border border-slate-300 px-5 font-semibold">Continue test</button></div>
      </dialog>
    </>}
    {attempt?.status === 'submitted' && <TestResults test={test} attempt={attempt} loadKey={loadKey} onRestart={() => { persist(null); setConfirmSubmit(false); window.scrollTo({ top: 0, behavior: 'instant' }) }} />}
  </div></PublicLayout>
}
