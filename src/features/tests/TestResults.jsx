import { useEffect, useMemo, useState } from 'react'
import { gradeAttempt } from './demoAttempt.js'

const labels = { correct: 'Correct', wrong: 'Wrong', unanswered: 'Unanswered', 'needs-review': 'Needs teacher review' }
const tones = { correct: 'bg-emerald-50 text-emerald-800', wrong: 'bg-red-50 text-red-800', unanswered: 'bg-slate-100 text-slate-700', 'needs-review': 'bg-amber-50 text-amber-900' }

export default function TestResults({ test, attempt, loadKey, onRestart }) {
  const [key, setKey] = useState(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState('all')
  const [showRestart, setShowRestart] = useState(false)
  useEffect(() => {
    let active = true
    setError('')
    loadKey().then(value => { if (active) setKey(value) }).catch(() => { if (active) setError('The answer review could not load. Your submitted answers are saved in this browser if storage is available.') })
    return () => { active = false }
  }, [loadKey, reload])
  const result = useMemo(() => {
    if (!key) return null
    try { return gradeAttempt(test, key, attempt) } catch { return { invalid: true } }
  }, [test, key, attempt])
  if (error) return <div role="alert" className="rounded-2xl border border-amber-200 bg-white p-6"><p>{error}</p><button className="mt-4 min-h-11 rounded-lg border px-4" onClick={() => setReload(reload + 1)}>Retry answer review</button></div>
  if (!result) return <p role="status">Preparing your result and answer review…</p>
  if (result.invalid) return <p role="alert">The answer key could not be matched to this test. Your attempt is retained; no score has been guessed.</p>
  const subjects = [...new Set(test.questions.map(q => q.subject))]
  const visibleRows = result.rows.filter(row => filter === 'all' || row.status === filter)
  function downloadReview() {
    const lines = [test.title + ' — answer key', 'Key version: ' + key.version,
      key.policy,
      `Score: ${result.score}/${result.maximum}. Correct: ${result.counts.correct}; wrong: ${result.counts.wrong}; unanswered (scored): ${result.counts.unanswered}; excluded: ${result.counts['needs-review']}.`, '',
      ...result.rows.flatMap(row => [
        `Q${row.question.id} | ${row.question.subject} | Your option: ${row.selected ?? 'Unanswered'} | Key: ${row.answer.option ?? 'Needs teacher review'} | ${labels[row.status]}`,
        row.answer.explanation, '',
      ]), ...(key.sources.length ? ['References consulted for selected entries:', ...key.sources.map(source => source.title + ': ' + source.url)] : [])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = test.id + '-answer-review.txt'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    <section aria-labelledby="result-heading" className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 mb-6">
      <p className="text-sm font-semibold text-blue-700 mb-2">{attempt.submitReason === 'time-expired' ? 'Time ended — automatically submitted' : 'Test submitted'}</p>
      <h2 id="result-heading" className="text-3xl font-extrabold mb-3">Your result</h2>
      <p className="text-slate-600 mb-6">Your answers were marked in this browser. Nothing is sent to the institute in this demo.</p>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl bg-blue-50 p-4"><p className="text-sm text-blue-900">Marks</p><p data-testid="score" className="text-3xl font-bold text-blue-900">{result.score} / {result.maximum}</p></div>
        {Object.entries(labels).map(([status, label]) => <div key={status} className={'rounded-xl p-4 ' + tones[status]}><p className="text-sm">{label}{status === 'unanswered' ? ' (scored)' : ''}</p><p data-testid={'count-' + status} className="text-3xl font-bold">{result.counts[status]}</p></div>)}
      </div>
      <p className="mt-4 text-sm text-slate-600">{result.answered} answered · {result.totalUnanswered} unanswered across all {test.questions.length} questions. +{test.marksPerCorrect} per correct answer; no negative marking. No pass/fail or rank is assigned.</p>
      <button onClick={downloadReview} className="mt-6 min-h-11 rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white">Download answer review</button>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 mb-6">
      <h2 className="text-xl font-bold mb-4">Subject-wise marks</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{subjects.map(subject => {
        const rows = result.rows.filter(row => row.question.subject === subject)
        return <div key={subject} className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold">{subject}</h3><p className="text-slate-600 mt-2">{rows.filter(row => row.status === 'correct').length} / {rows.filter(row => row.status !== 'needs-review').length} marks</p><p className="text-sm text-slate-500">{rows.filter(row => row.status === 'needs-review').length} excluded for review</p></div>
      })}</div>
    </section>
    <section aria-labelledby="key-heading">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-5">
        <h2 id="key-heading" className="text-2xl font-bold">Answer key and review</h2>
        <label className="text-sm font-semibold">Show <select value={filter} onChange={e => setFilter(e.target.value)} className="ml-2 min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-3"><option value="all">All questions</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <p className="text-sm text-slate-600 mb-4">Expand a row to compare the question, your answer and the explanation.</p>
      {visibleRows.length === 0 && <p className="rounded-xl border bg-white p-6">No questions in this group.</p>}
      <div className="space-y-3">{visibleRows.map(row => <details key={row.question.id} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <summary className="cursor-pointer font-semibold leading-7">Q{row.question.id} · {row.question.subject} — <span className={'inline-block rounded px-2 text-sm ' + tones[row.status]}>{labels[row.status]}</span><span className="block text-sm font-normal text-slate-600">Your answer: {row.selected === null ? 'Unanswered' : 'Option ' + row.selected} · Key: {row.answer.option === null ? 'Under review' : 'Option ' + row.answer.option + ' (provisional)'}</span></summary>
        <div className="mt-4 space-y-2 border-t pt-4 text-slate-700 leading-8 break-words">{row.question.paragraphs.map((p, i) => <p key={i} lang={/[\u0C00-\u0C7F]/.test(p) ? 'te' : 'en'} className="whitespace-pre-wrap">{p}</p>)}</div>
        <p className="mt-4 rounded-lg bg-slate-50 p-4 leading-7"><strong>{row.answer.option === null ? 'Review note: ' : 'Explanation: '}</strong>{row.answer.explanation}</p>
        {row.answer.sourceIds.length > 0 && <div className="mt-3 text-sm space-y-2">{row.answer.sourceIds.map(id => key.sources.find(source => source.id === id)).filter(Boolean).map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer" className="block text-blue-700 underline break-words">{source.title}</a>)}</div>}
      </details>)}</div>
    </section>
    <div className="mt-8 border-t border-slate-200 pt-6">
      {!showRestart ? <button onClick={() => setShowRestart(true)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-5 font-semibold">Try the demo again</button> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p className="mb-4">Starting again replaces this browser's attempt. Download the review first if you want to keep it.</p><div className="flex flex-wrap gap-3"><button onClick={onRestart} className="min-h-11 rounded-lg bg-blue-600 px-5 text-white font-semibold">Replace attempt and restart</button><button onClick={() => setShowRestart(false)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-5">Keep this result</button></div></div>}
    </div>
  </>
}
