import { useState, useEffect, useRef } from 'react'
import { Plus, BookOpen, ChevronRight, CheckCircle, AlertTriangle, Eye, Send } from 'lucide-react'
import { testBuilderService } from '../../services/testBuilderService.js'
import { examPatternService } from '../../services/examPatternService.js'
import { examConfigService } from '../../services/examConfigService.js'
import MathText from '../../components/site/PrintedQuestionContent.jsx'
import AcademicContext from '../../components/site/AcademicContext.jsx'
import { contextFromUrl, testKinds } from '../../services/programService.js'

function StatusBadge({ status }) {
  const styles = {
    DRAFT: 'bg-slate-100 text-slate-700',
    PUBLISHED: 'bg-green-100 text-green-700',
    ARCHIVED: 'bg-orange-100 text-orange-700'
  }
  return <span className={`px-2 py-1 rounded text-xs font-bold ${styles[status] || styles.DRAFT}`}>{status}</span>
}

export default function AdminTestBuilder() {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [view, setView] = useState(() => new URLSearchParams(window.location.search).has('test') ? 'BUILD' : 'LIST')
  const [activeTestId, setActiveTestId] = useState(() => new URLSearchParams(window.location.search).get('test'))
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    const url = new URL(window.location.href)
    if (activeTestId && (view === 'BUILD' || view === 'PREVIEW')) url.searchParams.set('test', activeTestId)
    else url.searchParams.delete('test')
    window.history.replaceState({}, '', url.pathname + url.search)
  }, [view, activeTestId])

  const [tests, setTests] = useState([])
  const [listError, setListError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (view === 'LIST') loadTests()
  }, [view])

  async function loadTests() {
    setLoading(true)
    setListError(null)
    try {
      const data = await testBuilderService.getTests()
      setTests(data)
    } catch (e) {
      setListError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (view === 'CREATE') return <TestCreator onCancel={() => setView('LIST')} onSaved={(id) => { setActiveTestId(id); setView('BUILD') }} />
  if (view === 'BUILD') return <TestConfigurator testId={activeTestId} onBack={() => setView('LIST')} onPreview={() => setView('PREVIEW')} />
  if (view === 'PREVIEW') return <TestPreview testId={activeTestId} onBack={() => setView('BUILD')} onPublished={() => setView('LIST')} />
  const visibleTests = tests.filter(t => (!academic.exam_id||t.exam_id===academic.exam_id)&&(!academic.level_id||t.level_id===academic.level_id)&&(!status || t.status === status) && `${t.name} ${t.exams?.name || ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <div className="space-y-6">
      <AcademicContext value={academic} onChange={setAcademic} depth="level"/>
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-900">Test Builder</h2>
        <button onClick={() => setView('CREATE')} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          <Plus size={18} /> Create Test
        </button>
      </div>

      <div className="flex flex-wrap gap-3"><label className="flex-1">Search tests<input value={search} onChange={e=>setSearch(e.target.value)} className="block w-full rounded-lg border p-2" /></label><label>Test status<select value={status} onChange={e=>setStatus(e.target.value)} className="block rounded-lg border p-2"><option value="">All statuses</option>{['DRAFT','PUBLISHED','ARCHIVED'].map(s=><option key={s}>{s}</option>)}</select></label></div>
      {listError ? <div role="alert" className="p-4 bg-red-50 text-red-700">{listError} <button onClick={loadTests} className="underline">Retry</button></div> : loading ? (
        <div className="py-12 text-slate-500">Loading tests...</div>
      ) : tests.length === 0 ? (
        <div className="py-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
          <BookOpen className="mx-auto text-slate-400 mb-3" size={32} />
          <h3 className="text-lg font-bold text-slate-700">No tests created yet</h3>
          <p className="text-slate-500 mb-4">Select an active exam pattern and assemble your first test.</p>
          <button onClick={() => setView('CREATE')} className="text-blue-600 font-medium hover:underline">+ Create Test</button>
        </div>
      ) : (
        <div className="grid gap-4">
          {visibleTests.length === 0 && <p>No tests match your search or status filter.</p>}
          {visibleTests.map(t => (
            <div key={t.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-wrap gap-4 justify-between items-center">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="font-bold text-lg">{t.name}</h3>
                  <StatusBadge status={t.status} />
                </div>
                <div className="text-sm text-slate-500 space-x-3">
                  <span>Exam: <strong>{t.exams?.name}</strong></span>
                  <span>Pattern: <strong>{t.exam_patterns?.name}</strong></span>
                  <span>Marks: <strong>{t.total_marks}</strong></span>
                </div>
              </div>
              <div>
                <button onClick={() => { setActiveTestId(t.id); setView(t.status === 'DRAFT' ? 'BUILD' : 'PREVIEW') }} className="px-4 py-2 bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100 rounded-lg font-medium">
                  {t.status === 'DRAFT' ? 'Build Test' : 'View Test'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TestCreator({ onCancel, onSaved }) {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [kind,setKind]=useState('GENERAL')
  const [reviewPolicy,setReviewPolicy]=useState('AFTER_SUBMISSION')
  const [name, setName] = useState('')
  const [examId, setExamId] = useState(()=>contextFromUrl().exam_id)
  const [patternId, setPatternId] = useState('')
  
  const [exams, setExams] = useState([])
  const [patterns, setPatterns] = useState([])
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    examConfigService.getExamCategories().then(setExams).catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    let active = true
    setPatternId('')
    setPatterns([])
    if (examId) {
      examPatternService.getPatterns(examId)
        .then(p => { if (active) setPatterns(p.filter(x => x.status === 'ACTIVE' && (!academic.level_id || x.level_id===academic.level_id))) })
        .catch(e => { if (active) setError(e.message) })
    }
    return () => { active = false }
  }, [examId,academic.level_id])

  const handleCreate = async () => {
    if (!name || !examId || !patternId) return setError('All fields are required')
    const pattern = patterns.find(p => p.id === patternId)
    if (!pattern) return setError('Choose an active pattern for this exam')
    
    setSaving(true)
    try {
      const test = await testBuilderService.createTest({
        test_kind:kind, review_policy:reviewPolicy,
        name,
        exam_id: examId,
        pattern_id: patternId,
        total_marks: pattern.total_marks,
        duration_minutes: pattern.total_duration_minutes
      })
      onSaved(test.id)
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto bg-white p-8 rounded-xl border border-slate-200 shadow-sm space-y-6">
      <h2 className="text-2xl font-bold">Create New Test</h2>
      {error && <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error}</div>}
      
      <div className="space-y-4">
        <AcademicContext value={academic} depth="level" onChange={next=>{setAcademic(next);setExamId(next.exam_id)}} disabled={saving}/>
        <label className="block">Test area<select className="mt-1 block w-full rounded-lg border p-2" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(testKinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label className="block">Student review policy<select className="mt-1 block w-full rounded-lg border p-2" value={reviewPolicy} onChange={e=>setReviewPolicy(e.target.value)}><option value="AFTER_SUBMISSION">Review after submission</option><option value="SUMMARY_ONLY">Summary only</option></select></label>
        <div>
          <label className="block text-sm font-medium mb-1">Active Pattern</label>
          <select value={patternId} onChange={e => setPatternId(e.target.value)} disabled={!examId} className="w-full border rounded-lg px-4 py-2 disabled:bg-slate-50">
            <option value="">Select Pattern...</option>
            {patterns.map(p => <option key={p.id} value={p.id}>{p.name} ({p.total_marks} Marks)</option>)}
          </select>
          {examId && patterns.length === 0 && <p className="text-xs text-amber-600 mt-1">No active patterns available for this exam.</p>}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Test Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Weekly Mock Test 1" className="w-full border rounded-lg px-4 py-2" />
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t">
        <button onClick={onCancel} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
        <button onClick={handleCreate} disabled={saving || !patternId} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold disabled:opacity-50">Create & Build</button>
      </div>
    </div>
  )
}

function TestConfigurator({ testId, onBack, onPreview }) {
  const mutation = useRef(false)
  const [savingQuestion, setSavingQuestion] = useState(false)
  const [test, setTest] = useState(null)
  const [testQs, setTestQs] = useState([])
  
  const [activeSectionId, setActiveSectionId] = useState(null)
  const [availableQs, setAvailableQs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    load()
  }, [testId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const t = await testBuilderService.getTestById(testId)
      setTest(t)
      if (t.exam_patterns?.exam_pattern_sections?.length > 0 && !activeSectionId) {
        setActiveSectionId(t.exam_patterns.exam_pattern_sections[0].id)
      }
      const tq = await testBuilderService.getTestQuestions(testId)
      setTestQs(tq)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    setAvailableQs([])
    if (activeSectionId && test) {
      const sec = test.exam_patterns.exam_pattern_sections.find(s => s.id === activeSectionId)
      if (sec) {
        testBuilderService.getEligibleQuestions(sec.id, sec.subject_id, test.exam_id, test.level_id)
          .then(data => { if (active) setAvailableQs(data) }).catch(e => { if (active) setError(e.message) })
      }
    }
    return () => { active = false }
  }, [activeSectionId, test])

  const handleToggleQuestion = async (qId) => {
    if (mutation.current) return
    mutation.current = true
    setSavingQuestion(true)
    const exists = testQs.find(tq => tq.question_id === qId)
    try {
      if (exists) {
        await testBuilderService.removeQuestionFromTest(testId, qId)
      } else {
        const sec = test.exam_patterns.exam_pattern_sections.find(s => s.id === activeSectionId)
        const currentCount = testQs.filter(tq => tq.section_id === activeSectionId).length
        if (currentCount >= sec.question_count) {
          return alert(`This section already has the required ${sec.question_count} questions.`)
        }
        const order = Math.max(-1, ...testQs.map(q => q.sort_order ?? 0)) + 1
        await testBuilderService.addQuestionToTest(testId, qId, activeSectionId, order)
      }
      const tq = await testBuilderService.getTestQuestions(testId)
      setTestQs(tq)
    } catch (e) {
      alert(e.message)
    } finally {
      mutation.current = false
      setSavingQuestion(false)
    }
  }

  if (loading) return <div>Loading...</div>
  if (error) return <div role="alert">{error} <button onClick={load} className="underline">Retry</button></div>
  if (!test) return <div>Test not found</div>
  if (test.is_published) return <div className="space-y-3"><p>This test is already published. Its questions cannot be edited.</p><button onClick={onPreview} className="text-blue-700 underline">View published test</button><button onClick={onBack} className="ml-4 underline">Back to tests</button></div>

  const sections = test.exam_patterns?.exam_pattern_sections || []
  const isComplete = sections.every(sec => {
    const selected = testQs.filter(tq => tq.section_id === sec.id).length
    return selected === sec.question_count
  })

  return (
    <div className="space-y-6 pb-20">
      <div className="flex justify-between items-center">
        <div>
          <button onClick={onBack} className="text-blue-600 text-sm font-medium hover:underline mb-2 block">&larr; Back to Tests</button>
          <h2 className="text-2xl font-bold">{test.name}</h2>
          <p className="text-slate-500">{test.exam_patterns?.name}</p>
        </div>
        <button 
          onClick={onPreview} disabled={savingQuestion}
          className="bg-slate-900 text-white px-5 py-2.5 rounded-lg font-bold flex items-center gap-2 hover:bg-slate-800"
        >
          <Eye size={18} /> Preview & Publish
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        <div className="w-full md:w-1/3 space-y-4">
          <h3 className="font-bold text-lg">Sections Progress</h3>
          {sections.map(sec => {
            const selected = testQs.filter(tq => tq.section_id === sec.id).length
            const isFull = selected === sec.question_count
            return (
              <div 
                key={sec.id} 
                onClick={() => setActiveSectionId(sec.id)}
                className={`p-4 rounded-xl border-2 cursor-pointer transition ${activeSectionId === sec.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-300'}`}
              >
                <div className="flex justify-between items-center mb-2">
                  <div className="font-bold">{sec.section_name}</div>
                  {isFull && <CheckCircle size={18} className="text-green-500" />}
                </div>
                <div className="text-sm text-slate-500 mb-2">Subject: {sec.exam_subjects?.name}</div>
                <div className="w-full bg-slate-200 rounded-full h-2">
                  <div className={`h-2 rounded-full ${isFull ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, (selected/sec.question_count)*100)}%` }}></div>
                </div>
                <div className="text-xs font-medium text-slate-600 mt-2 text-right">{selected} / {sec.question_count} Selected</div>
              </div>
            )
          })}
        </div>
        <div className="w-full md:w-2/3 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-lg mb-4 border-b pb-4">Select Questions</h3>
          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
            {availableQs.length === 0 ? (
              <div className="text-center py-8 text-slate-500 bg-slate-50 rounded-lg border border-dashed">
                No approved questions available for this subject. Go to Question Bank.
              </div>
            ) : availableQs.map(q => {
              const isSelected = testQs.some(tq => tq.question_id === q.id)
              const selectedInSection = testQs.filter(tq => tq.section_id === activeSectionId).length
              const activeSec = sections.find(s => s.id === activeSectionId)
              const isFull = selectedInSection >= (activeSec?.question_count || 0)

              return (
                <div key={q.id} className={`p-4 border rounded-lg flex gap-4 ${isSelected ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-blue-300'}`}>
                  <div className="flex-1">
                    <div className="mb-2 text-xs font-bold text-slate-400 uppercase">{q.difficulty}</div>
                    <MathText text={q.content} />
                  </div>
                  <button 
                    onClick={() => handleToggleQuestion(q.id)}
                    disabled={savingQuestion || (!isSelected && isFull)}
                    className={`px-4 py-2 shrink-0 rounded font-medium h-fit ${isSelected ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50'}`}
                  >
                    {isSelected ? 'Remove' : 'Add'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function TestPreview({ testId, onBack, onPublished }) {
  const [test, setTest] = useState(null)
  const [testQs, setTestQs] = useState([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active=true
    async function loadPreview(){
      const t=await testBuilderService.getTestById(testId)
      const preview=t.is_published?await testBuilderService.getPublishedPreview(testId):{test:t,questions:await testBuilderService.getTestQuestions(testId)}
      if(active){setTest(preview.test);setTestQs(preview.questions)}
    }
    loadPreview().catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  }, [testId])

  const handlePublish = async () => {
    // Validation
    const sections = test.exam_patterns?.exam_pattern_sections || []
    for (const sec of sections) {
      const count = testQs.filter(tq => tq.section_id === sec.id).length
      if (count !== sec.question_count) {
        return setError(`Cannot publish: Section "${sec.section_name}" requires exactly ${sec.question_count} questions (currently ${count}).`)
      }
    }

    setPublishing(true)
    setError(null)
    try {
      await testBuilderService.publishTest(testId)
      onPublished()
    } catch (e) {
      setError(e.message)
      setPublishing(false)
    }
  }

  if (loading) return <div>Loading...</div>
  if (!test) return <div role="alert">{error || 'Test not found'} <button onClick={onBack} className="underline">Back to builder</button></div>

  const sections = test.exam_patterns?.exam_pattern_sections || []
  const groupedQs = sections.map(sec => ({
    ...sec,
    questions: testQs.filter(tq => tq.section_id === sec.id).map(tq => tq.questions)
  }))

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <button onClick={onBack} className="text-blue-600 text-sm font-medium hover:underline mb-2 block">&larr; Back to Builder</button>

      <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm mb-6">
        <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Published tests are available to all students in this institute. Batch enrollment controls course lessons; tests are currently shared practice.</p>
        <h2 className="text-3xl font-black mb-2">{test.name}</h2>
        <p className="mb-3 text-sm text-slate-600">{test.level_name || (test.level_id ? 'Selected pattern track' : 'Unclassified track')} · {testKinds[test.test_kind] || testKinds.GENERAL}</p>
        <div className="flex gap-4 text-slate-600 mb-6 border-b pb-6">
          <span>Total Marks: <strong>{test.total_marks}</strong></span>
          {test.duration_minutes && <span>Duration: <strong>{test.duration_minutes} min</strong></span>}
          <span>Sections: <strong>{sections.length}</strong></span>
        </div>

        {error && <div className="p-4 mb-6 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-start gap-3"><AlertTriangle className="shrink-0 mt-0.5" size={18}/> {error}</div>}

        <div className="space-y-12">
          {groupedQs.map((sec, sIdx) => (
            <div key={sec.id}>
              <h3 className="text-xl font-bold border-b-2 border-slate-800 pb-2 mb-6">
                Section {String.fromCharCode(65 + sIdx)}: {sec.section_name}
                <span className="text-sm font-normal text-slate-500 ml-4">({sec.question_count} Questions • {sec.marks_per_question} Marks each)</span>
              </h3>
              
              <div className="space-y-8">
                {sec.questions.length === 0 ? (
                  <div className="text-amber-600 bg-amber-50 p-4 rounded border border-amber-200">Missing questions! Requires {sec.question_count}.</div>
                ) : sec.questions.map((q, qIdx) => (
                  <div key={q.id} className="flex gap-4">
                    <div className="font-bold text-slate-400 mt-1">{qIdx + 1}.</div>
                    <div className="flex-1">
                      <div className="text-lg text-slate-800 mb-4"><MathText text={q.content} /></div>
                      <div className="text-sm text-slate-400 italic">Options explicitly hidden in standard preview to replicate student view.</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {test.status === 'DRAFT' && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-slate-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] flex justify-center z-50">
          <div className="max-w-4xl w-full flex justify-end gap-4">
            <button onClick={onBack} className="px-6 py-3 font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Keep Editing</button>
            <button onClick={handlePublish} disabled={publishing} className="bg-green-600 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-green-700 disabled:opacity-50">
              {publishing ? 'Publishing...' : <><Send size={18} /> Publish Test</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
