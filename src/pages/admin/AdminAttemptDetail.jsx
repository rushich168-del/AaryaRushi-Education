import { useState, useEffect } from 'react'
import { ArrowLeft, Target, Trophy, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { resultService, resultValue, resultPercent, attemptedCount } from '../../services/resultService.js'
import MathText from '../../components/math/MathText.jsx'

function navigateTo(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function AdminAttemptDetail({ attemptId }) {
  const [attempt, setAttempt] = useState(null)
  const [sections, setSections] = useState([])
  const [reviewData, setReviewData] = useState([])
  const [optionSnaps, setOptionSnaps] = useState([])
  
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    load()
  }, [attemptId])

  async function load() {
    setLoading(true)
    setError(null)
    setAttempt(null)
    setSections([])
    setReviewData([])
    setOptionSnaps([])
    try {
      // Reuse the staff-authorized result projection, including the student name.
      const allResults = await resultService.getTeacherResults()
      const current = allResults.find(a => a.id === attemptId)
      
      if (!current) throw new Error("Attempt not found")
      setAttempt(current)

      const details = await resultService.getResultDetails(current, { teacher: true })
      setSections(details.sections)
      setReviewData(details.review)
      setOptionSnaps(details.options)

    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="p-8 text-slate-500">Loading attempt details...</div>
  if (error) return <div className="p-8 text-red-500">{error}</div>
  if (!attempt) return null

  const percentage = resultPercent(attempt.score, attempt.max_score)
  const answeredCount = attemptedCount(attempt)
  const accuracy = resultPercent(attempt.correct_count, answeredCount)
  const verified = attempt.tests?.snapshot_contract_version === 1
  const sectionsAvailable = verified

  const getOptionContent = (optId) => {
    if (!optId) return 'Unavailable'
    return optionSnaps.find(o => o.id === optId)?.content || 'Unavailable'
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <div className="flex items-center gap-4">
        <button onClick={() => navigateTo('/dashboard/admin/results')} className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-black text-slate-900">Attempt Details</h1>
          <p className="text-slate-500 mt-1">Reviewing {attempt.student_profiles?.full_name}</p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        
        {/* Profile Card */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Student & Test Info</div>
          <div className="space-y-4">
            <div>
              <div className="text-sm text-slate-500 font-medium">Student</div>
              <div className="font-bold text-slate-800">{attempt.student_profiles?.full_name}</div>
            </div>
            <div className="pt-4 border-t border-slate-100">
              <div className="text-sm text-slate-500 font-medium">Test</div>
              <div className="font-bold text-slate-800">{attempt.tests?.name}</div>
              <div className="text-sm text-slate-500">{attempt.tests?.exams?.name}</div>
            </div>
            <div className="pt-4 border-t border-slate-100 flex justify-between items-center">
              <div className="text-sm text-slate-500 font-medium flex items-center gap-2"><Clock size={16}/> Submitted</div>
              <div className="text-sm font-bold text-slate-800">{attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleString() : 'Unavailable'}</div>
            </div>
          </div>
        </div>

        {/* Score Card */}
        <div className="bg-slate-900 text-white p-6 rounded-xl shadow-sm relative overflow-hidden flex flex-col justify-center items-center text-center">
          <Trophy size={100} className="absolute right-0 bottom-0 opacity-10" />
          <div className="relative z-10 w-full">
            <div className="text-xs font-bold text-blue-300 uppercase tracking-wider mb-2">Final Score</div>
            <div className="text-6xl font-black mb-2">{resultValue(attempt.score)} <span className="text-3xl text-slate-500">/ {resultValue(attempt.max_score)}</span></div>
            <div className="bg-blue-600/20 text-blue-300 px-4 py-1.5 rounded-full inline-block font-bold border border-blue-500/30">
              {percentage}
            </div>
          </div>
        </div>

        {/* Accuracy Card */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Statistics</div>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Accuracy</span>
              <span className="font-black text-lg text-slate-800">{accuracy}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Correct</span>
              <span className="font-black text-lg text-green-600">{resultValue(attempt.correct_count)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Incorrect</span>
              <span className="font-black text-lg text-red-600">{resultValue(attempt.incorrect_count)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Unanswered</span>
              <span className="font-black text-lg text-slate-400">{resultValue(attempt.unanswered_count)}</span>
            </div>
          </div>
        </div>

      </div>

      {/* Sections */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Target size={20} className="text-blue-600"/> Section Performance</h3>
        {!sectionsAvailable ? <p className="text-sm text-slate-500">Historical section grading is unavailable.</p> : <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
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

      {/* Detailed Review */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
        <h3 className="text-lg font-bold border-b border-slate-100 pb-2">Detailed Response Review</h3>
        
        {!verified && <p className="text-sm text-slate-500">Historical per-question grading is unavailable. Preserved answers and explanations are shown where available.</p>}
        {reviewData.length === 0 && <p className="text-sm text-slate-500">Review details unavailable.</p>}
        <div className="space-y-8">
          {reviewData.map((rev, idx) => {
            let statusColor = 'text-slate-500 border-slate-200 bg-slate-50'
            let statusIcon = <div className="w-2 h-2 rounded-full bg-slate-400" />
            let statusText = 'Unanswered'
            
            if (!verified || (rev.is_correct == null && !rev.is_unanswered)) {
              statusText = 'Grading unavailable'
            } else if (rev.is_correct) {
              statusColor = 'text-green-700 border-green-200 bg-green-50'
              statusIcon = <CheckCircle2 size={16} />
              statusText = 'Correct'
            } else if (!rev.is_unanswered) {
              statusColor = 'text-red-700 border-red-200 bg-red-50'
              statusIcon = <XCircle size={16} />
              statusText = 'Incorrect'
            }

            return (
              <div key={rev.question_id} className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-slate-50 p-4 border-b border-slate-200 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <span className="font-black text-slate-800">Q{idx + 1}</span>
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 bg-slate-200 px-2 py-0.5 rounded">{rev.section_name ?? 'Historical label unavailable'}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold border ${statusColor}`}>
                      {statusIcon} {statusText}
                    </div>
                    <span className="text-sm font-black text-slate-700 w-16 text-right">
                      {!verified || rev.marks_awarded == null ? 'Unavailable' : rev.marks_awarded > 0 ? `+${rev.marks_awarded}` : rev.marks_awarded} <span className="text-xs font-medium text-slate-500">mk</span>
                    </span>
                  </div>
                </div>
                
                <div className="p-6 bg-white space-y-6">
                  <div className="text-slate-800 font-medium">
                    <MathText text={rev.content} />
                  </div>
                  
                  <div className="grid md:grid-cols-2 gap-4 pt-4 border-t border-slate-100">
                    <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Student's Answer</div>
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
              </div>
            )
          })}
        </div>

      </div>

    </div>
  )
}
