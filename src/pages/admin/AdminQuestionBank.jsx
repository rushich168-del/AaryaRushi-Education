import { useState, useEffect } from 'react'
import { Plus, Search, Filter, Edit, CheckCircle, Clock, BookOpen, ChevronRight, Check } from 'lucide-react'
import { questionBankService } from '../../services/questionBankService.js'
import { examConfigService } from '../../services/examConfigService.js'
import MathText from '../../components/site/PrintedQuestionContent.jsx'
import { PRINTED_PREFIX } from '../../services/printedPaperContract.js'
import AcademicContext from '../../components/site/AcademicContext.jsx'
import { contextFromUrl, emptyAcademicContext } from '../../services/programService.js'
import QuestionImportWorkspace from '../../components/site/QuestionImportWorkspace.jsx'

function StatusBadge({ status }) {
  const styles = {
    DRAFT: 'bg-slate-100 text-slate-700 border-slate-200',
    APPROVED: 'bg-green-50 text-green-700 border-green-200',
    REJECTED: 'bg-red-50 text-red-700 border-red-200',
  }
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status] || styles.DRAFT}`}>
      {status}
    </span>
  )
}

function QuestionList({ onEdit, onReview, onCreate, onImport }) {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  // Filters
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [difficultyFilter, setDifficultyFilter] = useState('')

  useEffect(() => {
    loadQuestions()
  }, [statusFilter, academic])

  async function loadQuestions() {
    setLoading(true)
    setError(null)
    try {
      const data = await questionBankService.getQuestions({
        ...academic,
        status: statusFilter || undefined
      })
      setQuestions(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const filtered = questions.filter(q => 
    Object.entries(academic).every(([key,value])=>!value||q[key]===value) && (!searchQuery || q.content.toLowerCase().includes(searchQuery.toLowerCase())) && (!difficultyFilter || q.difficulty === difficultyFilter)
  )

  const stats = {
    total: questions.length,
    draft: questions.filter(q => q.status === 'DRAFT').length,
    approved: questions.filter(q => q.status === 'APPROVED').length,
  }

  return (
    <div className="space-y-6">
      <AcademicContext value={academic} onChange={setAcademic}/>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Question Bank</h2>
          <div className="flex gap-4 mt-2 text-sm text-slate-500">
            <span>Total: <strong>{stats.total}</strong></span>
            <span>Draft: <strong>{stats.draft}</strong></span>
            <span>Approved: <strong>{stats.approved}</strong></span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2"><button onClick={onImport} className="rounded-lg border border-blue-600 px-4 py-2 font-medium text-blue-700">Import Questions</button>
        <button
          onClick={onCreate}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition"
        >
          <Plus size={18} /> Create Question
        </button></div>
      </div>

      <div className="flex flex-wrap gap-4 mb-6">
        <label className="text-sm">Difficulty<select aria-label="Difficulty" value={difficultyFilter} onChange={e=>setDifficultyFilter(e.target.value)} className="block rounded-lg border p-2"><option value="">All levels</option>{['EASY','MEDIUM','HARD'].map(d=><option key={d}>{d}</option>)}</select></label>
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input 
            type="text" 
            placeholder="Search questions..." 
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <select 
          className="px-4 py-2 rounded-lg border border-slate-200 focus:border-blue-500 outline-none"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading questions...</div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
          <BookOpen className="mx-auto text-slate-400 mb-3" size={32} />
          <h3 className="text-lg font-bold text-slate-700">No questions found</h3>
          <p className="text-slate-500 mt-1 mb-4">Create your first question to start building the bank.</p>
          <button onClick={onCreate} className="text-blue-600 font-medium hover:underline">
            + Create Question
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {filtered.map(q => (
            <div key={q.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row gap-4 justify-between sm:items-center hover:border-blue-200 transition">
              <div className="flex-1 min-w-0">
                <div className="flex gap-2 items-center mb-2">
                  <StatusBadge status={q.status} />
                  <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{q.question_type} • {q.difficulty}</span>
                  {q.exams && <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{q.exams.name}</span>}
                  {q.exam_subjects && <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{q.exam_subjects.name}</span>}
                </div>
                <div className="text-slate-800 line-clamp-2 pr-4">
                  {q.content.startsWith(PRINTED_PREFIX) ? <span>Printed question · {q.source_reference}</span> : <MathText text={q.content} />}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => q.content.startsWith(PRINTED_PREFIX) ? onReview(q.id) : onEdit(q.id)} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition" title={q.content.startsWith(PRINTED_PREFIX) ? 'View printed question' : 'Edit'}>
                  <Edit size={18} />
                </button>
                <button onClick={() => onReview(q.id)} className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition">
                  Review <ChevronRight size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function QuestionEditor({ questionId, onCancel, onSaved }) {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(!!questionId)
  const [error, setError] = useState(null)
  
  // Form State
  const [content, setContent] = useState('')
  const [explanation, setExplanation] = useState('')
  const [difficulty, setDifficulty] = useState('MEDIUM')
  const [options, setOptions] = useState(['', '', '', ''])
  const [correctIndex, setCorrectIndex] = useState(0)
  
  const [examId, setExamId] = useState(()=>contextFromUrl().exam_id)
  const [subjectId, setSubjectId] = useState(()=>contextFromUrl().subject_id)
  
  // Lookups
  const [exams, setExams] = useState([])
  const [subjects, setSubjects] = useState([])

  useEffect(() => {
    async function init() {
      try {
        const examsData = await examConfigService.getExamCategories()
        setExams(examsData)

        if (questionId) {
          const q = await questionBankService.getQuestionById(questionId)
          setContent(q.content || '')
          setExplanation(q.explanation || '')
          setDifficulty(q.difficulty || 'MEDIUM')
          setAcademic(Object.fromEntries(Object.keys(emptyAcademicContext).map(key=>[key,q[key]||''])))
          setExamId(q.exam_id || '')
          
          if (q.exam_id) {
            const subs = await examConfigService.getSubjectsForExam(q.exam_id)
            setSubjects(subs)
          }
          setSubjectId(q.subject_id || '')
          
          if (q.options && q.options.length > 0) {
            setOptions(q.options.map(o => o.content))
            const cIdx = q.options.findIndex(o => o.id === q.correct_option_id)
            if (cIdx >= 0) setCorrectIndex(cIdx)
          }
        }
      } catch (err) {
        setError(err.message)
      } finally {
        setInitialLoading(false)
      }
    }
    init()
  }, [questionId])

  useEffect(() => {
    if (examId) {
      examConfigService.getSubjectsForExam(examId).then(setSubjects).catch(console.error)
    } else {
      setSubjects([])
    }
  }, [examId])

  const handleOptionChange = (idx, val) => {
    const newOpts = [...options]
    newOpts[idx] = val
    setOptions(newOpts)
  }

  const handleAddOption = () => setOptions([...options, ''])
  const handleRemoveOption = (idx) => {
    if (options.length <= 2) return
    const newOpts = options.filter((_, i) => i !== idx)
    setOptions(newOpts)
    if (correctIndex === idx) setCorrectIndex(0)
    else if (correctIndex > idx) setCorrectIndex(correctIndex - 1)
  }

  const handleSave = async () => {
    if (!content.trim()) return setError('Question text is required')
    if (options.some(o => !o.trim())) return setError('All options must be filled out')
    if (!examId || !subjectId) return setError('Exam and Subject are required')

    setLoading(true)
    setError(null)
    try {
      const qData = {
        ...Object.fromEntries(Object.entries(academic).map(([k,v])=>[k,v||null])),
        exam_id: examId,
        subject_id: subjectId,
        content,
        explanation,
        difficulty,
        question_type: 'MCQ'
      }

      if (questionId) {
        await questionBankService.updateQuestion(questionId, qData, options, correctIndex)
      } else {
        await questionBankService.createQuestion(qData, options, correctIndex)
      }
      onSaved()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  if (initialLoading) return <div className="py-12 text-center text-slate-500">Loading...</div>

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">{questionId ? 'Edit Question' : 'Create Question'}</h2>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-900 font-medium">Cancel</button>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error}</div>}

      <AcademicContext value={academic} onChange={next=>{setAcademic(next);setExamId(next.exam_id);setSubjectId(next.subject_id)}} disabled={loading} authoring/>
      <p className="text-sm text-slate-500">Program and subject are required. Use available track and syllabus context; chapter and topic are optional until configured.</p>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Difficulty</label>
        <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="w-full md:w-1/3 px-3 py-2 border rounded-lg">
          <option value="EASY">Easy</option>
          <option value="MEDIUM">Medium</option>
          <option value="HARD">Hard</option>
        </select>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700">Question Text * (LaTeX supported)</label>
          <textarea 
            value={content} 
            onChange={(e) => setContent(e.target.value)} 
            rows={5}
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="e.g. If $2x + 3 = 11$, what is the value of $x$?"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700">Math Preview</label>
          <div className="w-full h-[132px] overflow-y-auto px-4 py-3 border border-slate-100 bg-slate-50 rounded-xl text-slate-800">
            {content ? <MathText text={content} /> : <span className="text-slate-400 italic">Preview will appear here...</span>}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h3 className="font-bold text-slate-800 mb-4">Options (Single Correct)</h3>
        <div className="space-y-3">
          {options.map((opt, idx) => (
            <div key={idx} className="flex items-start gap-3">
              <button 
                type="button"
                onClick={() => setCorrectIndex(idx)}
                className={`mt-2 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                  correctIndex === idx ? 'border-green-500 bg-green-500 text-white' : 'border-slate-300 hover:border-slate-400'
                }`}
                title="Mark as correct answer"
              >
                {correctIndex === idx && <Check size={14} strokeWidth={3} />}
              </button>
              <div className="flex-1 space-y-2">
                <input 
                  type="text" 
                  value={opt} 
                  onChange={(e) => handleOptionChange(idx, e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:border-blue-500 outline-none"
                  placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                />
                {opt && (
                  <div className="text-sm text-slate-600 px-1 bg-slate-50 rounded py-1">
                    Preview: <MathText text={opt} />
                  </div>
                )}
              </div>
              <button 
                onClick={() => handleRemoveOption(idx)}
                disabled={options.length <= 2}
                className="mt-2 text-slate-400 hover:text-red-500 disabled:opacity-30 p-1"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {options.length < 6 && (
          <button onClick={handleAddOption} className="mt-4 text-sm text-blue-600 font-medium hover:underline">
            + Add Option
          </button>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Explanation (Optional)</label>
        <textarea 
          value={explanation} 
          onChange={(e) => setExplanation(e.target.value)} 
          rows={3}
          className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
        />
        {explanation && (
           <div className="mt-2 text-sm text-slate-600 px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
             <MathText text={explanation} />
           </div>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-6 border-t border-slate-100">
        <button onClick={onCancel} className="px-5 py-2.5 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition">
          Cancel
        </button>
        <button 
          onClick={handleSave} 
          disabled={loading}
          className="px-5 py-2.5 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition disabled:opacity-70"
        >
          {loading ? 'Saving...' : 'Save Draft'}
        </button>
      </div>
    </div>
  )
}

function QuestionReview({ questionId, onBack, onStatusChange }) {
  const [q, setQ] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    questionBankService.getQuestionById(questionId)
      .then(setQ)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [questionId])

  const handleApprove = async () => {
    setSaving(true)
    try {
      await questionBankService.updateQuestionStatus(questionId, 'APPROVED')
      onStatusChange()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const handleReject = async () => {
    setSaving(true)
    try {
      await questionBankService.updateQuestionStatus(questionId, 'REJECTED')
      onStatusChange()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  if (loading) return <div className="py-12 text-center text-slate-500">Loading details...</div>
  if (error || !q) return <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error || 'Not found'}</div>

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <button onClick={onBack} className="text-blue-600 font-medium hover:underline flex items-center gap-1 mb-6">
        &larr; Back to Bank
      </button>

      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Review Question</h2>
          <div className="flex gap-2 items-center text-sm">
            <StatusBadge status={q.status} />
            <span className="text-slate-400">|</span>
            <span className="font-medium text-slate-600">{q.exams?.name}</span>
            <span className="text-slate-400">&gt;</span>
            <span className="font-medium text-slate-600">{q.exam_subjects?.name}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {q.status !== 'APPROVED' && (
            <button 
              onClick={handleApprove} disabled={saving}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-bold transition disabled:opacity-50"
            >
              Approve Question
            </button>
          )}
          {q.status === 'DRAFT' && (
            <button 
              onClick={handleReject} disabled={saving}
              className="bg-red-50 text-red-600 hover:bg-red-100 px-4 py-2 rounded-lg font-medium transition disabled:opacity-50"
            >
              Reject
            </button>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
        <div className="prose prose-slate max-w-none text-lg text-slate-800 mb-8">
          <MathText text={q.content} />
        </div>

        <div className="space-y-3 mb-8">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">Options</h3>
          {q.options?.map((opt, idx) => {
            const isCorrect = opt.id === q.correct_option_id
            return (
              <div key={opt.id} className={`p-4 rounded-lg border-2 flex items-center gap-4 ${isCorrect ? 'border-green-500 bg-green-50' : 'border-slate-100 bg-slate-50'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${isCorrect ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {String.fromCharCode(65 + idx)}
                </div>
                <div className={`flex-1 ${isCorrect ? 'text-green-900 font-medium' : 'text-slate-700'}`}>
                  <MathText text={opt.content} />
                </div>
                {isCorrect && <CheckCircle className="text-green-600 shrink-0" size={24} />}
              </div>
            )
          })}
        </div>

        {q.explanation && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-5">
            <h3 className="text-sm font-bold text-blue-800 mb-2">Explanation</h3>
            <div className="text-blue-900">
              <MathText text={q.explanation} />
            </div>
          </div>
        )}
      </div>

      <div className="text-sm text-slate-500 flex justify-between px-2">
        <span>Source: {q.source_reference}</span>
        <span>Difficulty: {q.difficulty}</span>
      </div>
    </div>
  )
}

export default function AdminQuestionBank() {
  // view: 'LIST', 'CREATE', 'EDIT', 'REVIEW'
  // B4.7: `?import=<id>` reopens a PDF import (its preparation state is re-derived from the database).
  const [view, setView] = useState(() => { const p = new URLSearchParams(window.location.search); return p.has('question') ? 'REVIEW' : p.has('import') ? 'IMPORT' : 'LIST' })
  const [activeQuestionId, setActiveQuestionId] = useState(() => new URLSearchParams(window.location.search).get('question'))
  useEffect(() => {
    const url = new URL(window.location.href)
    if (activeQuestionId && ['EDIT','REVIEW'].includes(view)) url.searchParams.set('question', activeQuestionId)
    else url.searchParams.delete('question')
    window.history.replaceState({}, '', url.pathname + url.search)
  }, [view, activeQuestionId])

  const handleEdit = (id) => {
    setActiveQuestionId(id)
    setView('EDIT')
  }

  const handleReview = (id) => {
    setActiveQuestionId(id)
    setView('REVIEW')
  }

  const handleBackToList = () => {
    setActiveQuestionId(null)
    setView('LIST')
  }

  if (view === 'CREATE' || view === 'EDIT') {
    return (
      <QuestionEditor 
        questionId={view === 'EDIT' ? activeQuestionId : null} 
        onCancel={handleBackToList}
        onSaved={handleBackToList}
      />
    )
  }

  if (view === 'IMPORT') return <QuestionImportWorkspace onBack={handleBackToList}/>

  if (view === 'REVIEW') {
    return (
      <QuestionReview 
        questionId={activeQuestionId}
        onBack={handleBackToList}
        onStatusChange={handleBackToList}
      />
    )
  }

  return (
    <QuestionList 
      onImport={() => setView('IMPORT')}
      onCreate={() => setView('CREATE')}
      onEdit={handleEdit}
      onReview={handleReview}
    />
  )
}
