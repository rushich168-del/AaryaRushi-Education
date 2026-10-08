import { useEffect, useRef, useState } from 'react'
import AcademicContext from './AcademicContext.jsx'
import PrintedQuestionContent from './PrintedQuestionContent.jsx'
import PrintedQuestionEditor from './PrintedQuestionEditor.jsx'
import { contextFromUrl, programService } from '../../services/programService.js'
import { printedPaperService as service } from '../../services/printedPaperService.js'
import { parseAnswerKey } from '../../services/printedPaperContract.js'
import { reviewReasons, needsQuestionReview, numberingIssues } from '../../services/printedPaperReview.js'

const button = 'rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white disabled:opacity-50'
const field = 'mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5'
const initial = { name: '', duration_minutes: '', marks: '1', negative_marks: '0' }
export default function PrintedPaperWorkspace() {
  const [details, setDetails] = useState(initial), [context, setContext] = useState(contextFromUrl)
  const [file, setFile] = useState(null), [questions, setQuestions] = useState([]), [warnings, setWarnings] = useState([])
  const [paper, setPaper] = useState(null), [recent, setRecent] = useState([]), [listError, setListError] = useState('')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [index, setIndex] = useState(0)
  const [reviewed, setReviewed] = useState(false), [dirty, setDirty] = useState(false), [keyText, setKeyText] = useState('')
  const [published, setPublished] = useState(null), [source, setSource] = useState({})
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false), [onlyReview, setOnlyReview] = useState(false)
  const flight = useRef(false)
  const refresh = () => service.list().then(rows => { setRecent(rows); setListError('') }).catch(() => setListError('Saved papers are unavailable. Your administrator may need to enable paper-to-test publishing. You can still prepare and preview a file here.'))
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    const warn = e => { if (dirty || busy || editing) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy, editing])
  const change = fn => { fn(); setDirty(true); setReviewed(false) }
  async function work(fn) {
    if (flight.current) return
    flight.current = true; setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e.message || 'That step could not finish. Please try again.'); }
    finally { flight.current = false; setBusy('') }
  }
  async function prepare(e) {
    e.preventDefault()
    if (!file) return setError('Choose a PDF or Word (.docx) paper.')
    await work(async () => {
      setBusy('Opening your paper…')
      const { preparePrintedPdf, preparePrintedDocx } = await import('../../services/printedPaperPreparation.js')
      const bytes = new Uint8Array(await file.arrayBuffer())
      let result
      if (/\.docx$/i.test(file.name)) result = await preparePrintedDocx(bytes, setBusy)
      else {
        const { createBrowserPlatform } = await import('../../services/preparation/browserPlatform.js')
        result = await preparePrintedPdf(bytes, createBrowserPlatform(), setBusy)
      }
      setQuestions(result.questions); setWarnings(result.warnings); setIndex(0); setPaper(null); setPublished(null)
      setEditing(false); setOnlyReview(false); setKeyText('')
      setSource({ filename: file.name, source_type: result.sourceType, expected_count: result.expectedCount || result.questions.length, answer_key_page: result.answerKeyPage, preparation_version: 2 })
      setDirty(true); setReviewed(false)
    })
  }
  async function save(publish = false) {
    await work(async () => {
      if (!details.name.trim()) throw new Error('Enter a test name before saving.')
      if (publish && !context.exam_id) throw new Error('Choose the program for this test above.')
      if (publish && (!Number.isInteger(Number(details.duration_minutes)) || Number(details.duration_minutes) < 1 || Number(details.duration_minutes) > 1440)) throw new Error('Enter a duration from 1 to 1440 minutes before publishing.')
      if (publish && (!Number.isInteger(Number(details.marks)) || Number(details.marks) < 1 || Number(details.marks) > 100 || details.negative_marks === '' || !Number.isFinite(Number(details.negative_marks)) || Number(details.negative_marks) < 0 || Number(details.negative_marks) > Number(details.marks))) throw new Error('Use 1–100 marks per question and a wrong-answer deduction between 0 and the question marks.')
      if (publish && (!reviewed || questions.some(q => !Number.isInteger(q.correct)))) throw new Error('Check the paper and select every correct answer before publishing.')
      if (publish && (questions.some(needsQuestionReview) || numberingIssues(questions, source.expected_count).length)) throw new Error('Resolve the flagged questions and numbering issues before publishing.')
      let subjectId = context.subject_id
      if (publish && !subjectId) {
        setBusy('Setting up General / mixed subjects…')
        try { subjectId = await programService.ensurePaperSubject(context.exam_id) }
        catch (e) { throw new Error(`Could not set up the paper subject: ${e.message || 'Please try again.'}`) }
        setContext(v => ({ ...v, subject_id: subjectId }))
      }
      setBusy('Saving test details…')
      const metadata = { ...source, ...details, review_version: 2, exam_id: context.exam_id, subject_id: subjectId, level_id: context.level_id || null }
      let saved = await service.save(paper, metadata, null)
      setPaper(saved)
      for (let start = 0; start < questions.length; start += 10) {
        setBusy(`Saving questions ${start + 1}–${Math.min(start + 10, questions.length)} of ${questions.length}…`)
        saved = await service.save(saved, null, questions.slice(start, start + 10).map((q, i) => ({ ...q, reviewReasons: reviewReasons(q), position: start + i })))
        setPaper(saved)
      }
      setDirty(false)
      setNotice('Draft saved. You can reopen it from Saved papers below.')
      const url = new URL(location.href); url.searchParams.set('paper', saved.id); history.replaceState({}, '', url)
      if (publish) { setBusy('Publishing your online test…'); const id = await service.publish(saved); setPublished(id); setPaper({ ...saved, test_id: id }) }
      await refresh()
    })
  }
  async function open(id) {
    if ((dirty || editing) && !window.confirm('Leave this unsaved paper and open the saved paper?')) return
    await work(async () => {
      setBusy('Opening saved paper…')
      const { paper: saved, questions: rows } = await service.load(id)
      setPaper(saved); setQuestions(rows); setDetails(Object.fromEntries(Object.keys(initial).map(key=>[key,saved.metadata[key] ?? initial[key]]))); setContext(saved.metadata); setSource(saved.metadata)
      setPublished(saved.test_id); setIndex(0); setDirty(false); setReviewed(false); setWarnings([])
      setEditing(false); setOnlyReview(false); setFile(null)
      if (rows.length !== saved.metadata.expected_count) setError('This paper was only partly saved. Prepare the original file again to restore all questions.')
    })
  }
  useEffect(() => { const id = new URLSearchParams(location.search).get('paper'); if (id) open(id) }, [])
  const missing = questions.filter(q => !Number.isInteger(q.correct)).length
  const flagged = questions.filter(needsQuestionReview).length
  const sequenceIssues = numberingIssues(questions, Number(source.expected_count) || questions.length)
  const go = next => { if (editing && !window.confirm('Discard the unapplied question edits?')) return; setEditing(false); setIndex(next) }
  const q = questions[index]
  return <section className="space-y-5 w-full" aria-label="Paper to online test">
    <div><h2 className="text-2xl font-bold">Paper → Online test</h2><p className="mt-2 text-slate-600">Upload your paper. Check the questions and answer key. Publish for students.</p></div>
    <ol className="flex flex-wrap gap-3 text-sm font-semibold" aria-label="Progress"><li>1 · Choose paper</li><li className={q ? 'text-blue-700' : 'text-slate-500'}>2 · Check & set answers</li><li className={published ? 'text-emerald-700' : 'text-slate-500'}>3 · Publish</li></ol>
    {error && (!q || published) && <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">{error}</p>}
    {busy && <p role="status" className="rounded-lg bg-blue-50 p-4 text-blue-800">{busy} Keep this tab open.</p>}
    {published ? <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-5"><h3 className="font-bold text-emerald-900">Your online test is published</h3><p className="mt-2">Students can now find it in their test portal. The timer, answer saving and automatic scoring use the existing exam system.</p><a className="mt-3 inline-block text-blue-700 underline" href={`/dashboard/admin/tests?test=${published}`}>View published test</a></div> : null}
    {!q && <form onSubmit={prepare} className="space-y-4 rounded-xl border bg-white p-5">
      <label className="block font-semibold">PDF or Word paper<input aria-label="PDF or Word paper" type="file" accept=".pdf,.docx" disabled={!!busy} className={field} onChange={e => {
        const f = e.target.files?.[0]
        if (f && (!/\.(pdf|docx)$/i.test(f.name) || f.size > 30 * 1024 * 1024)) { setError('Choose a PDF or .docx file up to 30 MB.'); e.target.value = ''; setFile(null); return }
        setFile(f || null); setError(''); if (f) setDetails(d => ({ ...d, name: f.name.replace(/\.(pdf|docx)$/i, '').replace(/_/g, ' ') }))
      }} /></label>
      <p className="text-sm text-slate-600">PDFs keep their printed appearance, including Telugu and diagrams. Word keeps text and supported pictures. Scanned PDFs need a text layer.</p>
      <button className={button} disabled={!!busy || !file}>Prepare online test</button>
    </form>}
    {q && <>
      <details className="rounded-xl border bg-white p-5 space-y-4" open>
        <summary className="cursor-pointer font-semibold">Test settings · {details.name}</summary>
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-bold">{questions.length} questions · {missing ? `${missing} answers needed` : 'Answer key complete'}</h3><span className="text-sm text-slate-500">{dirty ? 'Unsaved changes' : 'Saved'}</span></div>
        {warnings.map(w => <p key={w} className="text-sm text-amber-900">{w}</p>)}
        <fieldset disabled={!!busy || !!published} className="space-y-3">
          <label className="block text-sm font-medium">Test name<input className={field} value={details.name} onChange={e => change(() => setDetails(d => ({ ...d, name: e.target.value })))} /></label>
          <AcademicContext value={context} onChange={v => change(() => setContext(v))} depth="subject" syncUrl={false} optionalLevel paperSubjects disabled={!!busy || !!published} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[['duration_minutes', 'Duration (minutes)', 1], ['marks', 'Marks per question', 1], ['negative_marks', 'Deduction per wrong answer', 0]].map(([key, label, min]) => <label key={key} className="text-sm font-medium">{label}<input type="number" min={min} step={key === 'negative_marks' ? '0.01' : '1'} className={field} value={details[key]} onChange={e => change(() => setDetails(d => ({ ...d, [key]: e.target.value })))} /></label>)}</div>
        </fieldset>
      </details>
      {!!sequenceIssues.length && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{sequenceIssues.map(issue=><p key={issue}>{issue}</p>)}<p>For a paper prepared before this update, choose the original file again to rebuild its boundaries. Saved papers are preserved.</p></div>}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="min-w-0 rounded-xl border bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm text-blue-700">Teacher review · {index+1} of {questions.length}{q.sourcePages?.length ? ` · PDF page ${q.sourcePages.join(', ')}` : ''}</p><h3 className="text-xl font-bold">Question {q.number}</h3></div><label className="text-sm">Go to question <select aria-label="Go to question" className="max-w-full rounded border p-2" value={index} onChange={e => go(Number(e.target.value))}>{questions.map((row, i) => <option key={i} value={i}>{row.number}{needsQuestionReview(row) ? ' · review needed' : ''}{!Number.isInteger(row.correct) ? ' · answer needed' : ''}</option>)}</select></label></div>
        <div className="min-h-64 text-lg"><PrintedQuestionContent text={q.content} /></div>
        {reviewReasons(q).length>0 && <div className={`rounded-lg p-3 text-sm ${needsQuestionReview(q)?'bg-amber-50 text-amber-950':'bg-emerald-50 text-emerald-900'}`}><p className="font-semibold">{needsQuestionReview(q)?'Teacher review needed':'Checked by teacher'}</p><ul className="mt-2 list-disc pl-5">{reviewReasons(q).map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
        {!published && <div className="flex flex-wrap gap-2"><button type="button" disabled={!!busy || editing} className="rounded-lg border px-3 py-2 text-blue-700" onClick={()=>setEditing(true)}>Edit question</button><button type="button" disabled={!!busy || editing || q.reviewConfirmed || !Number.isInteger(q.correct)} className="rounded-lg border px-3 py-2 text-emerald-800 disabled:opacity-40" onClick={()=>change(()=>setQuestions(rows=>rows.map((row,n)=>n===index?{...row,reviewConfirmed:true}:row)))}>{q.reviewConfirmed?'Question checked':'Mark question checked'}</button></div>}
        {editing && <PrintedQuestionEditor key={index} question={q} sourceFile={file} answerKeyPage={source.answer_key_page} onClose={()=>setEditing(false)} onSave={updated=>{change(()=>setQuestions(rows=>rows.map((row,n)=>n===index?updated:row)));setEditing(false)}}/>}
        <fieldset disabled={!!busy || !!published || editing}><legend className="mb-2 text-sm font-semibold">Correct answer (teacher only)</legend><div className="flex flex-wrap gap-2">{q.options.map((label, i) => <button type="button" key={i} aria-pressed={q.correct === i} className={`rounded-lg border px-5 py-2 ${q.correct === i ? 'bg-emerald-700 text-white' : 'bg-white'}`} onClick={() => change(() => setQuestions(rows => rows.map((row, n) => n === index ? { ...row, correct: i, reviewConfirmed:false } : row)))}>{label}</button>)}</div></fieldset>
        <div className="flex justify-between"><button type="button" disabled={index === 0} className="p-2 text-blue-700 disabled:opacity-40" onClick={() => go(index - 1)}>← Previous</button><button type="button" disabled={index === questions.length - 1} className="p-2 text-blue-700 disabled:opacity-40" onClick={() => go(index + 1)}>Next →</button></div>
      </div>
      <aside className="rounded-xl border bg-white p-4 lg:sticky lg:top-4" aria-label="Teacher question navigator"><h3 className="font-bold">Question navigator</h3><p className="mt-2 text-sm">{flagged} need review · {missing} answers needed</p><p className="mt-2 text-xs text-slate-600">Amber: review needed · Green: checked · White: no detected issue. All questions still need your final check.</p><button type="button" aria-pressed={onlyReview} className="my-3 rounded border px-3 py-2 text-sm" onClick={()=>setOnlyReview(v=>!v)}>{onlyReview?'Show all questions':'Show review needed'}</button><div className="grid max-h-96 grid-cols-5 gap-2 overflow-y-auto p-1">{questions.map((row,i)=>(!onlyReview || needsQuestionReview(row) || !Number.isInteger(row.correct)) && <button type="button" key={i} aria-label={`Review question ${row.number}${needsQuestionReview(row)?': needs review':''}${!Number.isInteger(row.correct)?': answer needed':''}`} aria-current={index===i?'step':undefined} onClick={()=>go(i)} className={`h-10 rounded border text-sm ${index===i?'ring-2 ring-slate-800 ring-offset-1':''} ${needsQuestionReview(row)?'border-amber-300 bg-amber-50 text-amber-900':row.reviewConfirmed?'border-emerald-300 bg-emerald-50 text-emerald-900':'border-slate-300'}`}>{row.number}</button>)}</div></aside>
      </div>
      {!published && <div className="space-y-4 rounded-xl border bg-white p-5">
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
        {busy && <p role="status" className="rounded-lg bg-blue-50 p-3 text-blue-800">{busy}</p>}
        {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{notice}</p>}
        <details><summary className="cursor-pointer font-semibold">Paste an answer key</summary><label className="block mt-2 text-sm">One answer per line, for example 1 A or 1 2<textarea className={field} rows={5} value={keyText} onChange={e => setKeyText(e.target.value)} /></label><button type="button" disabled={!!busy || editing || !keyText.trim()} className={button} onClick={() => { try { const rows = parseAnswerKey(keyText, questions).map((row,i)=>row.correct===questions[i].correct?row:{...row,reviewConfirmed:false}); change(() => setQuestions(rows)); setError('') } catch (e) { setError(e.message) } }}>Apply answer key</button></details>
        <label className="flex gap-3 items-start"><input type="checkbox" checked={reviewed} disabled={!!busy} onChange={e => setReviewed(e.target.checked)} className="mt-1" /><span>I checked all question boundaries, pictures, shared passages, answers and marking. This paper is ready for students.</span></label>
        <p className="text-sm text-slate-600">Publishing makes this test available to all students on this platform. Answers appear only after submission.</p>
        {(!reviewed || missing > 0) && <p className="text-sm text-amber-900">{missing > 0 ? `Choose the correct answer for ${missing} question${missing===1?'':'s'}. ` : ''}{!reviewed ? 'Tick the review box above to enable Publish.' : ''} You can save a draft at any time.</p>}
        {(flagged>0 || sequenceIssues.length>0) && <p className="text-sm text-amber-900">Resolve {flagged} flagged questions{sequenceIssues.length?' and the numbering issues':''} before publishing. You can save your progress.</p>}
        {editing && <p className="text-sm text-amber-900">Apply or cancel question edits before saving the paper.</p>}
        <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={!!busy || editing} onClick={() => save(false)}>Save draft</button><button type="button" className={button} disabled={!!busy || editing || !reviewed || missing > 0 || flagged > 0 || sequenceIssues.length > 0} onClick={() => save(true)}>Publish online test</button></div>
      </div>}
      <button type="button" disabled={!!busy} className="text-blue-700 underline" onClick={() => { if ((dirty || editing) && !window.confirm('Discard unsaved changes and choose another paper?')) return; setQuestions([]); setPaper(null); setPublished(null); setDirty(false); setReviewed(false); setFile(null); const url = new URL(location.href); const course = url.searchParams.get('course'); history.replaceState({}, '', location.pathname + (course ? '?course=' + encodeURIComponent(course) : '')); refresh() }}>Choose another paper</button>
    </>}
    <details open={!q} className="rounded-xl border bg-white p-5"><summary className="cursor-pointer font-semibold">Saved papers</summary>{listError ? <p className="mt-3 text-sm text-amber-900">{listError} <button onClick={refresh} className="underline">Retry</button></p> : !recent.length ? <p className="mt-3 text-sm text-slate-500">Your saved papers will appear here.</p> : <ul className="mt-3 space-y-2">{recent.map(row => <li key={row.id}><button disabled={!!busy} className="text-left text-blue-700 underline" onClick={() => open(row.id)}>{row.metadata.name} · {row.test_id ? 'Published' : 'Draft'}</button></li>)}</ul>}</details>
  </section>
}
