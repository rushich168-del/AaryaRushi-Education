import { useState, useEffect } from 'react'
import { CheckCircle2, Trophy, ArrowLeft, Target, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { studentExamService } from '../../services/studentExamService.js'
import { resultService, resultValue, resultPercent, attemptedCount } from '../../services/resultService.js'
import MathText from '../../components/site/PrintedQuestionContent.jsx'

function navigateTo(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function TestResult({ testId, attemptId = null }) {
  const [attempt, setAttempt] = useState(null)
  const [sections, setSections] = useState([])
  const [reviewData, setReviewData] = useState([])
  const [optionSnaps, setOptionSnaps] = useState([])
  
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedQ, setExpandedQ] = useState(null)

  useEffect(() => {
    load()
  }, [testId, attemptId])

  async function load() {
    setLoading(true)
    setError(null)
    setAttempt(null)
    setSections([])
    setReviewData([])
    setOptionSnaps([])
    try {
      await resultService.triggerExpiredFinalization()
      
      let targetAttemptId = attemptId
      if (!targetAttemptId) {
        // Find latest for this test
        const attemptsData = await studentExamService.getMyAttempts()
        const submitted = attemptsData.find(a => a.test_id === testId && ['SUBMITTED', 'EXPIRED'].includes(a.status))
        if (!submitted) return navigateTo(`/dashboard/student`)
        targetAttemptId = submitted.id
      }

      const att = await resultService.getStudentAttempt(targetAttemptId)
      setAttempt(att)

      const details = await resultService.getResultDetails(att)
      setSections(details.sections)
      setReviewData(details.review)
      setOptionSnaps(details.options)

    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="p-12 text-center text-slate-500 font-bold h-screen flex items-center justify-center">Loading Result...</div>
  if (error) return <div className="p-12 text-center text-red-500 h-screen flex items-center justify-center">{error}</div>
  if (!attempt) return null

  const percentage = resultPercent(attempt.score, attempt.max_score)
  const answeredCount = attemptedCount(attempt)
  const accuracy = resultPercent(attempt.correct_count, answeredCount)
  const verified = attempt.tests?.snapshot_contract_version === 1
  const sectionsAvailable = verified && attempt.tests?.review_policy === 'AFTER_SUBMISSION'

  const getOptionContent = (optId) => {
    if (!optId) return 'Unavailable'
    return optionSnaps.find(o => o.id === optId)?.content || 'Unavailable'
  }

  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4 flex justify-center items-start">
      <div className="max-w-4xl w-full bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
        
        <div className="p-8 bg-slate-900 text-white text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-10">
            <Trophy size={160} />
          </div>
          <div className="relative z-10 space-y-4">
            <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4 border-4 border-slate-800">
              <CheckCircle2 size={32} className="text-slate-900" />
            </div>
            <h1 className="text-3xl font-black">Test Result</h1>
            <p className="text-slate-400 text-lg">{attempt.tests?.name} • {attempt.tests?.exams?.name}</p>
          </div>
        </div>

        <div className="p-8 space-y-10">
          
          <div className="grid md:grid-cols-2 gap-8">
            <div className="flex flex-col items-center justify-center bg-blue-50 py-8 rounded-2xl border border-blue-100">
              <div className="text-sm font-bold text-blue-500 uppercase tracking-widest mb-2">Score</div>
              <div className="text-6xl font-black text-blue-900 mb-2">{resultValue(attempt.score)} <span className="text-3xl text-blue-300">/ {resultValue(attempt.max_score)}</span></div>
              <div className="text-blue-700 font-medium bg-blue-100 px-4 py-1 rounded-full">{percentage}</div>
            </div>
            
            <div className="flex flex-col items-center justify-center bg-amber-50 py-8 rounded-2xl border border-amber-100">
              <div className="text-sm font-bold text-amber-500 uppercase tracking-widest mb-2">Accuracy</div>
              <div className="text-6xl font-black text-amber-900 mb-2">{accuracy}</div>
              <div className="text-amber-700 font-medium bg-amber-100 px-4 py-1 rounded-full">{resultValue(attempt.correct_count)} correct out of {resultValue(answeredCount)} attempted</div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-center">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Attempted</div>
              <div className="text-2xl font-black text-slate-800">{resultValue(answeredCount)}</div>
            </div>
            <div className="bg-green-50 p-4 rounded-xl border border-green-100 text-center">
              <div className="text-xs font-bold text-green-600/70 uppercase tracking-wider mb-1">Correct</div>
              <div className="text-2xl font-black text-green-700">{resultValue(attempt.correct_count)}</div>
            </div>
            <div className="bg-red-50 p-4 rounded-xl border border-red-100 text-center">
              <div className="text-xs font-bold text-red-600/70 uppercase tracking-wider mb-1">Incorrect</div>
              <div className="text-2xl font-black text-red-700">{resultValue(attempt.incorrect_count)}</div>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-center">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Unanswered</div>
              <div className="text-2xl font-black text-slate-800">{resultValue(attempt.unanswered_count)}</div>
            </div>
          </div>

          <div>
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2"><Target size={20} className="text-blue-600"/> Section Performance</h3>
            {!sectionsAvailable ? <p className="text-sm text-slate-500">{!verified ? 'Historical section grading is unavailable.' : 'Section details are unavailable under the summary-only review policy.'}</p> : <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
                    <th className="p-3 font-semibold">Section</th>
                    <th className="p-3 font-semibold">Score</th>
                    <th className="p-3 font-semibold">Correct</th>
                    <th className="p-3 font-semibold">Incorrect</th>
                    <th className="p-3 font-semibold">Unanswered</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map(sec => (
                    <tr key={sec.section_id} className="border-b border-slate-100">
                      <td className="p-3">
                        <div className="font-bold text-slate-800">{sec.section_name}</div>
                        <div className="text-xs text-slate-500">{sec.subject_name}</div>
                      </td>
                      <td className="p-3 font-black text-blue-600">{sec.score} <span className="text-sm text-slate-400 font-medium">/ {sec.max_score}</span></td>
                      <td className="p-3 font-medium text-green-600">{sec.correct_count}</td>
                      <td className="p-3 font-medium text-red-600">{sec.incorrect_count}</td>
                      <td className="p-3 font-medium text-slate-400">{sec.unanswered_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
          </div>

          {attempt.tests?.review_policy !== 'AFTER_SUBMISSION' ? (
            <div className="bg-amber-50 p-5 rounded-xl border border-amber-200 text-amber-800 flex items-start gap-4">
              <AlertTriangle className="shrink-0 mt-0.5" />
              <div className="text-sm font-medium leading-relaxed">
                Detailed review and answer keys are unavailable under this test’s review policy.
              </div>
            </div>
          ) : (
            <div>
              <h3 className="text-xl font-bold mb-4 border-b pb-2">Detailed Review</h3>
              {!verified && <p className="text-sm text-slate-500">Historical per-question grading is unavailable. Preserved answers and explanations are shown where available.</p>}
              {reviewData.length === 0 && <p className="text-sm text-slate-500">Review details unavailable.</p>}
              <div className="space-y-4">
                {reviewData.map((rev, idx) => {
                  const isExpanded = expandedQ === rev.question_id
                  let statusColor = 'text-slate-500 border-slate-200 bg-slate-50'
                  let statusText = 'Unanswered'
                  if (!verified || (rev.is_correct == null && !rev.is_unanswered)) {
                    statusText = 'Grading unavailable'
                  } else if (rev.is_correct) {
                    statusColor = 'text-green-700 border-green-200 bg-green-50'
                    statusText = 'Correct'
                  } else if (!rev.is_unanswered) {
                    statusColor = 'text-red-700 border-red-200 bg-red-50'
                    statusText = 'Incorrect'
                  }

                  return (
                    <div key={rev.question_id} className={`border rounded-xl overflow-hidden transition-all ${isExpanded ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'}`}>
                      <button onClick={() => setExpandedQ(isExpanded ? null : rev.question_id)} className={`w-full p-4 flex justify-between items-center bg-white hover:bg-slate-50`}>
                        <div className="flex items-center gap-4">
                          <span className="font-bold text-slate-400 w-6">Q{idx + 1}</span>
                          <span className={`px-2 py-1 rounded text-xs font-bold border ${statusColor}`}>{statusText}</span>
                          <span className="text-sm font-bold text-slate-700">{!verified || rev.marks_awarded == null ? 'Unavailable' : rev.marks_awarded > 0 ? `+${rev.marks_awarded}` : rev.marks_awarded} marks</span>
                        </div>
                        {isExpanded ? <ChevronUp size={20} className="text-slate-400"/> : <ChevronDown size={20} className="text-slate-400"/>}
                      </button>
                      
                      {isExpanded && (
                        <div className="p-6 border-t border-slate-100 bg-white space-y-6">
                          <div className="text-slate-800 font-medium">
                            <MathText text={rev.content} />
                          </div>
                          
                          <div className="grid md:grid-cols-2 gap-4">
                            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Your Answer</div>
                              <div className={`font-medium ${rev.is_unanswered ? 'text-slate-400 italic' : (!verified || rev.is_correct == null ? 'text-slate-600' : rev.is_correct ? 'text-green-700' : 'text-red-700')}`}>
                                {rev.is_unanswered ? 'Did not answer' : <MathText text={getOptionContent(rev.selected_option_id)} />}
                              </div>
                            </div>
                            <div className="p-4 rounded-xl border border-green-200 bg-green-50 space-y-2">
                              <div className="text-xs font-bold uppercase tracking-wider text-green-600">Correct Answer</div>
                              <div className="font-medium text-green-800">
                                <MathText text={getOptionContent(rev.correct_option_id)} />
                              </div>
                            </div>
                          </div>
                          <div><h4 className="font-bold mb-2">Explanation</h4>{rev.explanation ? <MathText text={rev.explanation} /> : <p>Explanation unavailable.</p>}</div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="pt-4 flex justify-center border-t border-slate-100">
            <button onClick={() => navigateTo('/dashboard/student')} className="flex items-center gap-2 px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition shadow-sm">
              <ArrowLeft size={18} /> Return to Dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
