import { useState, useEffect } from 'react'
import { Plus, Settings, Edit, PlayCircle, Archive, Trash2 } from 'lucide-react'
import { examPatternService } from '../../services/examPatternService.js'
import { examConfigService } from '../../services/examConfigService.js'
import AcademicContext from '../../components/site/AcademicContext.jsx'
import { contextFromUrl } from '../../services/programService.js'

function StatusBadge({ status }) {
  const styles = {
    DRAFT: 'bg-slate-100 text-slate-700',
    ACTIVE: 'bg-green-100 text-green-700',
    ARCHIVED: 'bg-orange-100 text-orange-700'
  }
  return (
    <span className={`px-2 py-1 rounded text-xs font-bold tracking-wider ${styles[status] || styles.DRAFT}`}>
      {status}
    </span>
  )
}

function PatternList({ onCreate }) {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [patterns, setPatterns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    loadPatterns()
  }, [])

  async function loadPatterns() {
    setLoading(true)
    setError('')
    try {
      const data = await examPatternService.getPatterns()
      setPatterns(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleActivate = async (id) => {
    try {
      await examPatternService.activatePattern(id)
      loadPatterns()
    } catch (e) {
      alert(e.message)
    }
  }

  const handleArchive = async (id) => {
    if (!confirm('Archive this pattern? It will no longer be available for new tests.')) return
    try {
      await examPatternService.archivePattern(id)
      loadPatterns()
    } catch (e) {
      alert(e.message)
    }
  }

  if (loading) return <div className="py-12 text-slate-500">Loading patterns...</div>
  const visiblePatterns = patterns.filter(p => (!academic.exam_id||p.exam_id===academic.exam_id)&&(!academic.level_id||p.level_id===academic.level_id)&&(!status || p.status === status) && `${p.name} ${p.exams?.name || ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <div className="space-y-6">
      <AcademicContext value={academic} onChange={setAcademic} depth="level"/>
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-900">Exam Patterns</h2>
        <button onClick={onCreate} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          <Plus size={18} /> Create Pattern
        </button>
      </div>

      <div className="flex flex-wrap gap-3"><label className="flex-1">Search patterns<input className="block w-full rounded-lg border p-2" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>Pattern status<select className="block rounded-lg border p-2" value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option>{['DRAFT','ACTIVE','ARCHIVED'].map(s=><option key={s}>{s}</option>)}</select></label></div>
      {error ? <p role="alert" className="text-red-700">{error} <button className="underline" onClick={loadPatterns}>Retry patterns</button></p> : patterns.length === 0 ? (
        <div className="py-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
          <Settings className="mx-auto text-slate-400 mb-3" size={32} />
          <h3 className="text-lg font-bold text-slate-700">No patterns configured</h3>
          <p className="text-slate-500 mb-4">Create a pattern to define test structures (sections, question counts, marks).</p>
          <button onClick={onCreate} className="text-blue-600 font-medium hover:underline">
            + Create Exam Pattern
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {visiblePatterns.length === 0 && <p>No patterns match these filters.</p>}
          {visiblePatterns.map(p => (
            <div key={p.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row justify-between gap-4 md:items-center">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="font-bold text-lg">{p.name}</h3>
                  <StatusBadge status={p.status} />
                </div>
                <div className="text-sm text-slate-600 space-x-3">
                  <span>Exam: <strong>{p.exams?.name}</strong></span>
                  <span>Sections: <strong>{p.exam_pattern_sections?.length || 0}</strong></span>
                  <span>Marks: <strong>{p.total_marks}</strong></span>
                  {p.total_duration_minutes && <span>Duration: <strong>{p.total_duration_minutes}m</strong></span>}
                </div>
              </div>
              <div className="flex gap-2">
                {p.status === 'DRAFT' && (
                  <button onClick={() => handleActivate(p.id)} className="px-3 py-1.5 text-sm bg-green-50 text-green-700 hover:bg-green-100 rounded-lg font-medium flex items-center gap-1">
                    <PlayCircle size={16} /> Activate
                  </button>
                )}
                {p.status === 'ACTIVE' && (
                  <button onClick={() => handleArchive(p.id)} className="px-3 py-1.5 text-sm bg-orange-50 text-orange-700 hover:bg-orange-100 rounded-lg font-medium flex items-center gap-1">
                    <Archive size={16} /> Archive
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PatternEditor({ onCancel, onSaved }) {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [exams, setExams] = useState([])
  const [subjects, setSubjects] = useState([])

  const [examId, setExamId] = useState(()=>contextFromUrl().exam_id)
  const [name, setName] = useState('')
  const [duration, setDuration] = useState('')
  const [sections, setSections] = useState([])

  useEffect(() => {
    examConfigService.getExamCategories().then(setExams).catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    if (examId) {
      examConfigService.getSubjectsForExam(examId).then(setSubjects).catch(e => setError(e.message))
      setSections([]) // reset sections when exam changes
    }
  }, [examId])

  const handleAddSection = () => {
    setSections([...sections, { subject_id: '', section_name: '', question_count: 10, marks_per_question: 1, negative_marks: 0 }])
  }

  const updateSection = (idx, field, val) => {
    const newSecs = [...sections]
    newSecs[idx][field] = val
    if (field === 'subject_id' && !newSecs[idx].section_name) {
      const sub = subjects.find(s => s.id === val)
      if (sub) newSecs[idx].section_name = sub.name
    }
    setSections(newSecs)
  }

  const removeSection = (idx) => {
    setSections(sections.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    if (!examId || !name.trim()) return setError('Exam and Pattern Name are required')
    if (!Number.isInteger(Number(duration)) || Number(duration) <= 0) return setError('Enter a positive duration in minutes')
    if (sections.length === 0) return setError('At least one section is required')
    
    for (const s of sections) {
      if (!s.subject_id || !s.section_name) return setError('All sections must have a subject and name')
      if (s.question_count <= 0 || s.marks_per_question <= 0) return setError('Questions and Marks must be > 0')
    }

    setLoading(true)
    try {
      await examPatternService.createPattern({
        level_id: academic.level_id || null,
        exam_id: examId,
        name,
        total_duration_minutes: duration ? parseInt(duration) : null
      }, sections)
      onSaved()
    } catch (e) {
      setError(e.message)
      setLoading(false)
    }
  }

  const totalQuestions = sections.reduce((sum, s) => sum + (parseInt(s.question_count)||0), 0)
  const totalMarks = sections.reduce((sum, s) => sum + ((parseInt(s.question_count)||0) * (parseInt(s.marks_per_question)||0)), 0)

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Create Exam Pattern</h2>
        <button onClick={onCancel} className="text-slate-500">Cancel</button>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error}</div>}

      <div className="bg-white p-6 rounded-xl border border-slate-200 space-y-4">
        <h3 className="font-bold text-lg mb-4 border-b pb-2">1. Basic Information</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="md:col-span-2"><AcademicContext value={academic} depth="level" onChange={next=>{setAcademic(next);setExamId(next.exam_id)}} disabled={loading}/></div>
          <div>
            <label className="block text-sm font-medium mb-1">Pattern Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Class 6 Mock 2026" className="w-full border rounded px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Total Duration (minutes)</label>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} placeholder="e.g. 120" className="w-full border rounded px-3 py-2" />
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-200 space-y-4">
        <div className="flex justify-between items-center border-b pb-2 mb-4">
          <h3 className="font-bold text-lg">2. Sections</h3>
          <button onClick={handleAddSection} disabled={!examId} className="text-sm bg-blue-50 text-blue-600 px-3 py-1 rounded font-medium disabled:opacity-50">
            + Add Section
          </button>
        </div>

        {!examId ? (
          <p className="text-slate-500 text-sm italic">Select an Exam first to configure sections.</p>
        ) : sections.length === 0 ? (
          <p className="text-slate-500 text-sm">No sections added yet.</p>
        ) : (
          <div className="space-y-4">
            {sections.map((sec, idx) => (
              <div key={idx} className="flex flex-wrap md:flex-nowrap gap-3 items-end p-4 border border-slate-100 bg-slate-50 rounded-lg relative">
                <button onClick={() => removeSection(idx)} className="absolute top-2 right-2 text-slate-400 hover:text-red-500"><Trash2 size={16}/></button>
                
                <div className="w-full md:w-1/4">
                  <label className="block text-xs font-medium mb-1">Subject *</label>
                  <select value={sec.subject_id} onChange={e => updateSection(idx, 'subject_id', e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">Select...</option>
                    {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="w-full md:w-1/4">
                  <label className="block text-xs font-medium mb-1">Section Name *</label>
                  <input type="text" value={sec.section_name} onChange={e => updateSection(idx, 'section_name', e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="e.g. Mathematics" />
                </div>
                <div className="w-1/3 md:w-20">
                  <label className="block text-xs font-medium mb-1">Count *</label>
                  <input type="number" min="1" value={sec.question_count} onChange={e => updateSection(idx, 'question_count', parseInt(e.target.value))} className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
                <div className="w-1/3 md:w-24">
                  <label className="block text-xs font-medium mb-1">Marks/Q *</label>
                  <input type="number" min="1" value={sec.marks_per_question} onChange={e => updateSection(idx, 'marks_per_question', parseInt(e.target.value))} className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
                <div className="w-1/3 md:w-24">
                  <label className="block text-xs font-medium mb-1">-ve Marks</label>
                  <input type="number" step="0.25" value={sec.negative_marks} onChange={e => updateSection(idx, 'negative_marks', parseFloat(e.target.value))} className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-slate-800 text-white p-6 rounded-xl flex justify-between items-center">
        <div>
          <div className="text-slate-400 text-sm">Calculated Totals</div>
          <div className="font-bold text-xl">{totalQuestions} Questions • {totalMarks} Marks</div>
        </div>
        <button onClick={handleSave} disabled={loading} className="bg-blue-600 hover:bg-blue-500 px-6 py-2.5 rounded-lg font-bold disabled:opacity-50 transition">
          {loading ? 'Saving...' : 'Save Draft'}
        </button>
      </div>
    </div>
  )
}

export default function AdminExamPatterns() {
  const [view, setView] = useState('LIST') // LIST, CREATE

  if (view === 'CREATE') {
    return <PatternEditor onCancel={() => setView('LIST')} onSaved={() => setView('LIST')} />
  }

  return <PatternList onCreate={() => setView('CREATE')} />
}
