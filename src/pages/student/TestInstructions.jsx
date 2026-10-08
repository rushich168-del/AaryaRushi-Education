import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, Clock, ListChecks, Play } from 'lucide-react'
import { studentExamService } from '../../services/studentExamService.js'
import brand from '../../config/brand.js'

function navigateTo(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function TestInstructions({ testId }) {
  const [test, setTest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [startError, setStartError] = useState('')
  const [retry, setRetry] = useState(0)
  const startLock = useRef(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setUnavailable(false)
    studentExamService.getTestDetails(testId)
      .then(details => { if (active) setTest(details) })
      .catch(e => { console.error('[test] instructions', e); if (active) { setTest(null); setUnavailable(true) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [testId, retry])

  const handleStart = async () => {
    if (startLock.current) return
    startLock.current = true
    setStarting(true)
    setStartError('')
    try {
      await studentExamService.startAttempt(testId)
      navigateTo(`/test/${testId}/attempt`)
    } catch (e) {
      console.error('[test] start', e)
      setStartError(/not available for your enrolled batch or access window/i.test(e?.message || '')
        ? 'This test is not open for your batch right now. It may not have opened yet or it may have closed. Check the timing with your teacher.'
        : 'The test could not be started. Check your internet connection and try again.')
      setStarting(false)
    } finally {
      startLock.current = false
    }
  }

  if (loading) return <div className="p-12 text-slate-500" role="status">Loading test instructions…</div>
  if (unavailable || !test) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-xl w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8 text-center" role="alert">
        <AlertTriangle className="mx-auto text-amber-500 mb-3" size={36} />
        <h1 className="text-2xl font-black text-slate-800 mb-2">This test is not available</h1>
        <p className="text-slate-600 mb-6">It may not be open yet, it may have closed, or it is not assigned to your batch. Your dashboard lists every test you can start.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <button onClick={() => navigateTo('/dashboard/student#student-tests')} className="bg-brand text-white px-6 py-3 rounded-xl font-bold hover:bg-brand-3 transition">Back to my tests</button>
          <button onClick={() => setRetry(x => x + 1)} className="px-6 py-3 rounded-xl font-bold border border-slate-300 text-slate-700 hover:bg-slate-50 transition">Try again</button>
        </div>
      </div>
    </div>
  )

  const sections = test.exam_patterns?.exam_pattern_sections || []
  const totalQs = sections.reduce((sum, s) => sum + s.question_count, 0)

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
        <div className="relative p-8 bg-brand text-white border-b-4 border-accent">
          <img src={brand.logo.mark} alt="" aria-hidden="true" className="absolute right-6 top-6 h-16 w-16 rounded-full ring-2 ring-white shadow-[0_0_0_5px_rgba(255,206,22,0.35)] hidden sm:block" />
          <button onClick={() => navigateTo('/dashboard/student')} className="text-white/75 text-sm font-semibold hover:text-accent mb-4">&larr; Back to Dashboard</button>
          <h1 className="text-3xl font-black mb-2 pr-16">{test.name}</h1>
          <span className="inline-block rounded-md bg-accent px-2.5 py-0.5 text-sm font-bold text-brand">{test.exams?.name}</span>
        </div>
        
        <div className="p-8 space-y-8">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 bg-white rounded-xl border border-slate-200 flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-brand"><Clock size={22} /></span>
              <div>
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Duration</div>
                <div className="text-lg font-bold text-brand">{test.duration_minutes ? `${test.duration_minutes} Mins` : 'Untimed'}</div>
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl border border-slate-200 flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-brand"><ListChecks size={22} /></span>
              <div>
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Questions</div>
                <div className="text-lg font-bold text-brand">{totalQs}</div>
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl border border-slate-200 flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-xl font-black text-brand">★</span>
              <div>
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Max Marks</div>
                <div className="text-lg font-bold text-brand">{test.total_marks}</div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xl font-bold mb-4 text-brand">Exam Sections</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-brand text-white text-sm">
                    <th className="p-3 font-semibold">Section</th>
                    <th className="p-3 font-semibold">Questions</th>
                    <th className="p-3 font-semibold">Marks/Q</th>
                    <th className="p-3 font-semibold">-ve Marks</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map(sec => (
                    <tr key={sec.id} className="border-b border-slate-100 last:border-0 even:bg-slate-50">
                      <td className="p-3 font-semibold text-brand">{sec.section_name}</td>
                      <td className="p-3 font-semibold text-brand">{sec.question_count}</td>
                      <td className="p-3 text-emerald-700 font-semibold">+{sec.marks_per_question}</td>
                      <td className="p-3 text-red-600 font-semibold">{sec.negative_marks > 0 ? `-${sec.negative_marks}` : '0'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-accent-soft border border-accent border-l-4 rounded-xl p-5 text-brand">
            <h4 className="font-bold mb-2 flex items-center gap-2"><AlertTriangle size={18}/> General Instructions</h4>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>Once you start the test, the timer will begin immediately.</li>
              <li>Your answers are saved automatically when you select an option.</li>
              <li>You can navigate freely between questions using the question palette.</li>
              <li>Do not refresh the page or close the browser unnecessarily, though your progress will be saved.</li>
              <li>The test will auto-submit when the timer expires.</li>
            </ul>
          </div>

          {startError && <p role="alert" className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm font-medium">{startError}</p>}

          <div className="flex justify-end pt-4">
            <button 
              onClick={handleStart} 
              disabled={starting}
              className="bg-accent text-brand px-8 py-3.5 rounded-xl font-bold text-lg flex items-center gap-2 shadow-md hover:bg-accent-2 disabled:opacity-50 transition"
            >
              {starting ? 'Starting Test...' : <><Play size={20} fill="currentColor" /> Start Test</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
