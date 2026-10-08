import { Fragment, useState, useEffect, useRef } from 'react'
import { Clock, CheckCircle2, ChevronLeft, ChevronRight, Bookmark, Search, XCircle } from 'lucide-react'
import { studentExamService } from '../../services/studentExamService.js'
import { createAttemptWriteQueue } from '../../services/attemptWriteQueue.js'
import MathText from '../../components/site/PrintedQuestionContent.jsx'
import { PRINTED_PREFIX } from '../../services/printedPaperContract.js'
import brand from '../../config/brand.js'

function navigateTo(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function ExamWorkspace({ testId }) {
  const [attempt, setAttempt] = useState(null)
  const [questions, setQuestions] = useState([])
  const [options, setOptions] = useState([])
  const [answers, setAnswers] = useState({}) // mapped by question_id
  
  const [currentIdx, setCurrentIdx] = useState(0)
  const [visited,setVisited]=useState(new Set())
  const [timeLeft, setTimeLeft] = useState(null)
  
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [writeState, setWriteState] = useState({ pending: 0, unsaved: 0, submitting: false, expired: false, submitError: '' })
  
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)
  const submitting = writeState.submitting
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false)

  const timerRef = useRef(null)
  const queueRef = useRef(null)
  const answersRef = useRef({})
  const loadRef = useRef(0)

  useEffect(()=>{
    const id=questions[currentIdx]?.question_id
    if(id)setVisited(previous=>new Set([...previous,id]))
  },[questions,currentIdx])

  useEffect(() => {
    loadData()
    return () => {
      loadRef.current++
      clearInterval(timerRef.current)
      queueRef.current?.dispose()
      queueRef.current = null
    }
  }, [testId])

  useEffect(() => {
    const warnUnsaved = event => {
      const state = queueRef.current?.state()
      if (state && !state.finished && (state.pending || state.unsaved || state.submitting || state.expired || state.confirmationPending)) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warnUnsaved)
    return () => window.removeEventListener('beforeunload', warnUnsaved)
  }, [])

  async function loadData() {
    const generation = ++loadRef.current
    clearInterval(timerRef.current)
    queueRef.current?.dispose()
    queueRef.current = null
    setLoading(true)
    setLoadError('')
    setTimeLeft(null)
    setCurrentIdx(0)
    setShowSubmitConfirm(false)
    try {
      // Find the attempt (must be IN_PROGRESS)
      const attemptsData = await studentExamService.getMyAttempts()
      if (generation !== loadRef.current) return
      const activeAttempt = attemptsData.find(a => a.test_id === testId && a.status === 'IN_PROGRESS')
      
      if (!activeAttempt) {
        // Not active, or submitted
        const completed = attemptsData.some(a => a.test_id === testId && ['SUBMITTED', 'EXPIRED'].includes(a.status))
        return navigateTo(completed ? `/test/${testId}/result` : '/dashboard/student')
      }
      
      setAttempt(activeAttempt)
      
      const [qs, opts, ansData] = await Promise.all([
        studentExamService.getAttemptQuestions(testId),
        studentExamService.getAttemptOptions(testId),
        studentExamService.getMyAnswers(activeAttempt.id)
      ])
      if (generation !== loadRef.current) return

      setQuestions(qs)
      setOptions(opts)
      
      const ansMap = {}
      ansData.forEach(a => {
        ansMap[a.question_id] = { selected_option_id: a.selected_option_id, is_marked_for_review: a.is_marked_for_review }
      })
      setAnswers(ansMap)
      setVisited(new Set(ansData.map(a=>a.question_id)))
      answersRef.current = ansMap
      const queue = createAttemptWriteQueue({
        save: (questionId, answer) => studentExamService.saveAnswer(activeAttempt.id, questionId,
          answer.selected_option_id, answer.is_marked_for_review || false, !answer.selected_option_id),
        finalize: () => studentExamService.submitAttempt(activeAttempt.id),
        onChange: setWriteState
      })
      queueRef.current = queue
      setWriteState(queue.state())

      // This is a local display of the stored deadline; the server decides acceptance.
      if (activeAttempt.expires_at) {
        const expiresAt = Date.parse(activeAttempt.expires_at)
        if (!Number.isFinite(expiresAt)) throw new Error('The test deadline is unavailable. Please reload the attempt.')
        const updateTime = () => {
          const diff = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
          setTimeLeft(diff)
          if (diff <= 0) {
            clearInterval(timerRef.current)
            submitQueue(queue, true)
          }
        }
        timerRef.current = setInterval(updateTime, 1000)
        updateTime()
      }

    } catch (e) {
      if (generation === loadRef.current) setLoadError(e.message || 'Failed to load exam data.')
    } finally {
      if (generation === loadRef.current) setLoading(false)
    }
  }

  const submitQueue = async (queue, deadlineReached = false) => {
    setShowSubmitConfirm(false)
    try {
      await queue.submit({ deadlineReached })
      if (queueRef.current === queue) {
        clearInterval(timerRef.current)
        queue.dispose()
        queueRef.current = null
        navigateTo(`/test/${testId}/result`)
      }
    } catch {
      // The coordinator retains unsaved answers and exposes a retryable error.
    }
  }

  const updateAnswer = (qId, changes) => {
    const answer = { ...answersRef.current[qId], ...changes }
    if (!queueRef.current?.enqueue(qId, answer)) return
    answersRef.current = { ...answersRef.current, [qId]: answer }
    setAnswers(answersRef.current)
  }

  const handleSelectOption = (qId, optId) => updateAnswer(qId, { selected_option_id: optId })

  const handleClearResponse = () => {
    const qId = questions[currentIdx].question_id
    updateAnswer(qId, { selected_option_id: null })
  }

  const handleMarkReview = () => {
    const qId = questions[currentIdx].question_id
    updateAnswer(qId, { is_marked_for_review: !answersRef.current[qId]?.is_marked_for_review })
  }

  const handleSubmit = () => submitQueue(queueRef.current)
  const locked = submitting || writeState.expired || writeState.finished || writeState.confirmationPending

  const formatTime = (sec) => {
    if (sec === null) return '--:--:--'
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-bold">Loading Exam Engine...</div>
  if (loadError) return <div role="alert" className="p-8 space-y-4"><p>{loadError}</p><button onClick={loadData} className="rounded-lg bg-brand px-4 py-2 text-white">Retry loading</button></div>
  if (!questions.length) return <div>No questions found for this test.</div>

  const currentQ = questions[currentIdx]
  const currentOpts = options.filter(o => o.question_id === currentQ.question_id)
  const currentAns = answers[currentQ.question_id] || {}
  const isPrinted = currentQ.content?.startsWith(PRINTED_PREFIX)

  // Calculate stats for confirmation
  const totalQ = questions.length
  let answered = 0
  let marked = 0
  questions.forEach(q => {
    const a = answers[q.question_id]
    if (a?.selected_option_id) answered++
    if (a?.is_marked_for_review) marked++
  })

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden md:p-4">
      {/* Header */}
      <header className="bg-brand text-white md:rounded-xl min-h-16 shrink-0 flex flex-wrap gap-2 justify-between items-center px-3 py-2 md:px-6 z-20 shadow-sm">
        <div className="flex min-w-0 items-center gap-3 pr-4"><img src={brand.logo.mark} alt="" aria-hidden="true" className="h-9 w-9 shrink-0 rounded-full ring-2 ring-white" /><div className="font-black text-lg text-white truncate">{attempt?.tests?.name}</div></div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-sm text-white/80"><b className="text-accent">{answered}</b> / {totalQ} answered</span>
          <div role="status" className="text-xs font-bold text-white/70 bg-white/10 rounded-md px-2 py-1">
            {writeState.pending > 0 ? <span className="text-accent">Saving...</span>
              : writeState.unsaved > 0 ? <span className="text-red-200">Unsaved answers</span>
              : <span className="text-emerald-200 flex items-center gap-1"><CheckCircle2 size={14}/> Saved</span>}
          </div>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-bold ${timeLeft !== null && timeLeft < 300 ? 'bg-red-100 text-red-700 animate-pulse' : 'bg-accent text-brand'}`}>
            <Clock size={18} />
            {formatTime(timeLeft)}
          </div>
          <button aria-label="Open question palette" onClick={() => setMobilePaletteOpen(!mobilePaletteOpen)} className="md:hidden p-2 text-brand bg-white rounded">
            <Search size={20} />
          </button>
        </div>
      </header>

      {(writeState.unsaved > 0 || writeState.submitError || submitting || writeState.expired) && (
        <div role={writeState.submitError || (!writeState.pending && writeState.unsaved) ? 'alert' : 'status'} className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {writeState.expired ? <p>Time has ended on this device. Answers are locked while the server confirms your result. Only answers accepted by the server count.</p>
            : submitting ? <p>Waiting for pending saves and confirming submission...</p>
            : !writeState.unsaved ? <p>Submission has not been confirmed. Retry to check with the server.</p>
            : <p>{writeState.pending ? 'Saving your changes. Keep this page open.' : 'Some answers are not saved. Keep this page open and retry saving before submitting.'}</p>}
          {writeState.submitError && <p>{writeState.submitError}</p>}
          {!locked && !writeState.pending && writeState.unsaved > 0 && <button onClick={() => queueRef.current.retry()} className="mt-2 rounded bg-white px-3 py-2 font-bold border border-amber-300">Retry saving</button>}
          {!submitting && writeState.submitError && (writeState.expired || !writeState.unsaved) && <button onClick={() => submitQueue(queueRef.current, writeState.expired)} className="mt-2 rounded bg-white px-3 py-2 font-bold border border-amber-300">Retry submission</button>}
        </div>
      )}

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden relative md:gap-4 md:pt-4">
        
        {/* Workspace */}
        <main className="min-w-0 flex-1 flex flex-col overflow-hidden relative z-10 bg-white md:rounded-xl md:border">
          <label className="border-b border-slate-100 px-4 py-2 text-sm font-medium">Section
            <select className="ml-2 max-w-[70%] rounded border p-1" value={currentQ.section_id||''} onChange={e=>{const index=questions.findIndex(q=>(q.section_id||'')===e.target.value);if(index>=0)setCurrentIdx(index)}}>
              {[...new Map(questions.map(q=>[q.section_id||'',q.exam_pattern_sections?.section_name||'Questions'])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className={`${isPrinted ? 'max-w-none' : 'max-w-3xl mx-auto'} space-y-6`}>
              
              <div className="flex justify-between items-end border-b border-slate-100 pb-4">
                <div>
                  <div className="inline-block text-xs font-bold text-brand bg-accent-soft rounded-md px-2 py-0.5 uppercase tracking-wider mb-2">{currentQ.exam_pattern_sections?.section_name}</div>
                  <div className="text-2xl font-bold text-brand">Question {currentIdx + 1} <span className="text-sm font-normal text-slate-500">of {totalQ}</span></div>
                </div>
                <div className="text-sm font-bold text-slate-400 text-right">
                  <span className="text-green-600">+{currentQ.marks}</span> / <span className="text-red-500">-{currentQ.negative_marks || 0}</span>
                </div>
              </div>

              <div className="text-lg text-slate-800 leading-relaxed font-medium">
                <MathText text={currentQ.content} />
              </div>

              {!isPrinted && <div className="space-y-3">
                {currentOpts.map((opt, i) => {
                  const isSelected = currentAns.selected_option_id === opt.id
                  return (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      disabled={locked}
                      key={opt.id}
                      onClick={() => handleSelectOption(currentQ.question_id, opt.id)}
                      className={`w-full text-left p-4 border-2 rounded-xl transition flex gap-4 disabled:opacity-60 ${isSelected ? 'border-brand bg-accent-soft' : 'border-slate-200 hover:border-brand/40 hover:bg-slate-50'}`}
                    >
                      <div className={`shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center mt-0.5 ${isSelected ? 'border-brand' : 'border-slate-300'}`}>
                        {isSelected && <div className="w-3 h-3 bg-brand rounded-full" />}
                      </div>
                      <div className="text-slate-800 font-medium">
                        <MathText text={opt.content} />
                      </div>
                    </button>
                  )
                })}
              </div>}

            </div>
          </div>
          
          {/* Action Bar */}
          <div className="shrink-0 bg-slate-50 border-t border-slate-200 p-4 flex flex-wrap justify-start items-center gap-3">
            {isPrinted && <div className="flex w-full flex-wrap items-center gap-2" role="group" aria-label="Your answer"><span className="mr-2 text-sm font-semibold">Your answer</span>{currentOpts.map((opt,i)=><button key={opt.id} type="button" disabled={locked} aria-pressed={currentAns.selected_option_id===opt.id} onClick={()=>handleSelectOption(currentQ.question_id,opt.id)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${currentAns.selected_option_id===opt.id?'border-brand bg-accent-soft text-brand font-semibold':'border-slate-300 bg-white'}`}><span className={`h-4 w-4 rounded-full border ${currentAns.selected_option_id===opt.id?'border-brand bg-brand':'border-slate-400'}`}/>{/^[A-D1-4]$/.test(opt.content)?`Option ${opt.content}`:<MathText text={opt.content}/>}</button>)}</div>}
            <div className="flex w-full flex-wrap items-center gap-2" role="group" aria-label="Question actions">
              <button 
                onClick={handleMarkReview}
                aria-pressed={!!currentAns.is_marked_for_review}
                disabled={locked}
                className={`flex items-center gap-2 px-4 py-2.5 font-bold rounded-lg border ${currentAns.is_marked_for_review ? 'bg-accent text-brand border-accent' : 'bg-white text-brand border-slate-300 hover:bg-accent-soft'}`}
              >
                <Bookmark size={18} fill={currentAns.is_marked_for_review ? "currentColor" : "none"} /> Mark for Review
              </button>
              <button onClick={handleClearResponse} disabled={locked || !currentAns.selected_option_id} className="px-4 py-2.5 font-bold bg-white border border-slate-300 text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50">
                Clear
              </button>
              <span className="hidden sm:block mx-1 h-8 w-px bg-slate-300" aria-hidden="true" />
              <div className="flex gap-2 w-full sm:w-auto">
                <button onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))} disabled={currentIdx === 0} className="flex-1 sm:flex-none flex justify-center items-center gap-1 px-5 py-2.5 bg-white border border-brand text-brand hover:bg-slate-100 rounded-lg font-bold disabled:opacity-40 disabled:border-slate-300">
                  <ChevronLeft size={20} /> Previous
                </button>
                {currentIdx < questions.length - 1 ? (
                  <button onClick={() => setCurrentIdx(currentIdx + 1)} className="flex-1 sm:flex-none flex justify-center items-center gap-1 px-7 py-2.5 bg-brand text-white hover:bg-brand-3 rounded-lg font-bold shadow-sm">
                    Save &amp; Next <ChevronRight size={20} />
                  </button>
                ) : (
                  <button disabled={locked} onClick={() => setShowSubmitConfirm(true)} className="flex-1 sm:flex-none flex justify-center items-center px-7 py-2.5 bg-accent text-brand hover:bg-accent-2 rounded-lg font-bold shadow-sm disabled:opacity-50">
                    Submit Test
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Palette Drawer */}
        <aside className={`absolute md:relative right-0 top-0 bottom-0 w-72 max-w-full shrink-0 bg-white border border-slate-200 md:rounded-xl shadow-xl md:shadow-none transition-transform duration-300 z-30 flex flex-col ${mobilePaletteOpen ? 'visible translate-x-0' : 'invisible translate-x-full md:visible md:translate-x-0'}`}>
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-white shrink-0">
            <h3 className="font-bold text-lg text-brand">Question navigator</h3>
            <button aria-label="Close question palette" onClick={() => setMobilePaletteOpen(false)} className="md:hidden text-slate-400 hover:text-slate-600"><XCircle size={24}/></button>
          </div>
          
          <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs font-medium text-slate-600" aria-label="Colour key">
              <div className="flex items-center gap-2"><div className="w-4 h-4 bg-brand rounded-sm"></div> Answered</div>
              <div className="flex items-center gap-2"><div className="w-4 h-4 bg-white border-2 border-slate-300 rounded-sm"></div> Not Answered</div>
              <div className="flex items-center gap-2"><div className="w-4 h-4 bg-slate-200 rounded-sm"></div> Not visited</div>
              <div className="flex items-center gap-2"><div className="w-4 h-4 bg-accent rounded-sm"></div> Marked</div>
              <div className="flex items-center gap-2"><div className="w-4 h-4 rounded-sm bg-white ring-2 ring-accent ring-offset-1 border border-brand"></div> Current</div>
            </div>
          </div>
          <div className="p-4 flex-1 overflow-y-auto">
            <div className="grid grid-cols-5 gap-2">
              {questions.map((q, idx) => {
                const ans = answers[q.question_id]
                const isCurrent = currentIdx === idx
                const hasAnswer = !!ans?.selected_option_id
                const isMarked = ans?.is_marked_for_review

                let bg = visited.has(q.question_id)?'bg-white border-slate-300 text-slate-600':'bg-slate-200 border-slate-200 text-slate-600'
                if (isMarked) bg = 'bg-accent border-accent text-brand'
                else if (hasAnswer) bg = 'bg-brand border-brand text-white'
                if (isCurrent) bg += ' ring-[3px] ring-accent ring-offset-2 ring-offset-white outline outline-2 outline-brand'

                return (
                  <Fragment key={q.question_id}>
                  {(idx===0 || q.section_id!==questions[idx-1].section_id) && <p className="col-span-5 mt-2 text-sm font-semibold text-slate-700">{q.exam_pattern_sections?.section_name || 'Questions'}</p>}
                  <button 
                    key={q.question_id}
                    aria-label={`Question ${idx+1}: ${isMarked?'marked for review':hasAnswer?'answered':visited.has(q.question_id)?'unanswered':'not visited'}`}
                    onClick={() => { setCurrentIdx(idx); setMobilePaletteOpen(false); }}
                    className={`h-10 rounded font-bold border-2 flex items-center justify-center transition-colors ${bg}`}
                  >
                    {idx + 1}
                  </button>
                  </Fragment>
                )
              })}
            </div>
          </div>
          
          <div className="p-4 bg-white border-t border-slate-200 shrink-0">
             <button disabled={locked} onClick={() => setShowSubmitConfirm(true)} className="w-full py-3 bg-accent text-brand hover:bg-accent-2 rounded-xl font-bold disabled:opacity-50">
               Submit Test
             </button>
          </div>
        </aside>

        {/* Submit Overlay */}
        {showSubmitConfirm && (
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center space-y-6 animate-in zoom-in-95 duration-200">
              <div className="w-16 h-16 bg-accent-soft text-brand rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 size={32} />
              </div>
              <div>
                <h2 className="text-2xl font-black mb-2">Submit Exam?</h2>
                <p className="text-slate-500">You will not be able to change your answers after submission.</p>
              </div>
              <div className="grid grid-cols-2 gap-4 text-left bg-slate-50 p-4 rounded-xl border border-slate-100">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-slate-400 uppercase">Answered</span>
                  <span className="text-xl font-black text-green-600">{answered}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-slate-400 uppercase">Unanswered</span>
                  <span className="text-xl font-black text-slate-600">{totalQ - answered}</span>
                </div>
                <div className="flex flex-col col-span-2">
                  <span className="text-xs font-bold text-slate-400 uppercase">Marked for Review</span>
                  <span className="text-xl font-black text-amber-600">{marked}</span>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowSubmitConfirm(false)} disabled={submitting} className="flex-1 py-3 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold rounded-xl disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={handleSubmit} disabled={submitting} className="flex-1 py-3 bg-brand text-white hover:bg-brand-3 font-bold rounded-xl shadow-md disabled:opacity-50">
                  {submitting ? 'Submitting...' : 'Confirm Submit'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
