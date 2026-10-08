import { useEffect, useState } from 'react'
import AcademicContext from '../../components/site/AcademicContext.jsx'
import { programService, contextFromUrl, contextQuery } from '../../services/programService.js'
import { learningService } from '../../services/learningService.js'
import SignupProgramSettings from './SignupProgramSettings.jsx'

export default function AdminExamsConfig() {
  const [data,setData]=useState(null),[context,setContext]=useState(contextFromUrl)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
  const [entity,setEntity]=useState('exams'),[name,setName]=useState(''),[category,setCategory]=useState('')
  const [courses,setCourses]=useState([]),[links,setLinks]=useState([]),[course,setCourse]=useState('')
  const [courseError,setCourseError]=useState('')
  useEffect(()=>{
    let active=true
    setError('');setCourseError('')
    programService.catalogue().then(d=>{if(active)setData(d)}).catch(()=>{if(active)setError('Unable to load program configuration. Check that the Test Portal upgrade is installed.')})
    Promise.all([learningService.courses(),programService.courseTracks()]).then(([c,l])=>{if(active){setCourses(c);setLinks(l)}}).catch(()=>{if(active)setCourseError('Course links could not be loaded.')})
    return()=>{active=false}
  },[revision])
  const definitions={program_categories:'Category',exams:'Program',exam_levels:'Track / class',exam_subjects:'Subject',syllabi:'Syllabus / track subject',chapters:'Chapter',topics:'Topic'}
  async function create(event){
    event.preventDefault();setError('');setBusy(true)
    try{
      const v={name:name.trim()}
      if(!v.name)throw Error('Enter a name.')
      if(entity==='program_categories'||entity==='exams')v.slug=v.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||crypto.randomUUID()
      if(entity==='exams') {if(!category)throw Error('Select a category.');v.category_id=category}
      if(['exam_levels','exam_subjects','syllabi'].includes(entity)){if(!context.exam_id)throw Error('Select a program first.');v.exam_id=context.exam_id}
      if(entity==='syllabi') {if(!context.level_id||!context.subject_id)throw Error('Select track and subject first.');v.level_id=context.level_id;v.subject_id=context.subject_id;v.status='ACTIVE'}
      if(entity==='chapters'){if(!context.syllabus_id)throw Error('Select a syllabus first.');v.syllabus_id=context.syllabus_id}
      if(entity==='topics'){if(!context.chapter_id)throw Error('Select a chapter first.');v.chapter_id=context.chapter_id}
      await programService.create(entity,v);setName('');setRevision(x=>x+1)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function link(remove=false,existingCourse=course){
    setBusy(true);setCourseError('')
    try{await (remove?programService.unlinkCourse:programService.linkCourse)(existingCourse,context.level_id);setRevision(x=>x+1)}catch(e){setCourseError(e.message)}finally{setBusy(false)}
  }
  const query=contextQuery(context)
  return <div className="space-y-6">
    <SignupProgramSettings />
    <header><h2 className="text-2xl font-bold">Exam Programs</h2><p className="mt-2 text-slate-600">Configure programs and curriculum, then use the existing question bank and test workflows.</p></header>
    {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error} <button className="underline" onClick={()=>setRevision(x=>x+1)}>Retry configuration</button></p>}
    {!data?<p role="status">Program configuration is not loaded.</p>:<>
      <section className="rounded-xl border bg-white p-5"><h3 className="mb-4 font-bold">Academic context</h3><AcademicContext value={context} onChange={setContext} catalogue={data}/>
        <nav className="mt-5 flex flex-wrap gap-4" aria-label="Context workflows">{[['questions','Question Bank'],['patterns','Patterns'],['tests','Tests'],['results','Results']].map(([path,label])=><a key={path} className="font-semibold text-blue-700" href={`/dashboard/admin/${path}${query?'?'+query:''}`}>{label} →</a>)}</nav>
      </section>
      <form onSubmit={create} className="space-y-4 rounded-xl border bg-white p-5"><h3 className="font-bold">Add curriculum entry</h3><p className="text-sm text-slate-600">Subjects belong to a program. A syllabus connects a subject to its track. Names and curriculum are institute configuration, not official exam rules.</p>
        <div className="grid gap-3 sm:grid-cols-2"><label>Entry type<select className="mt-1 block w-full rounded-lg border p-2" value={entity} onChange={e=>setEntity(e.target.value)}>{Object.entries(definitions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        {entity==='exams'&&<label>Category<select className="mt-1 block w-full rounded-lg border p-2" value={category} onChange={e=>setCategory(e.target.value)} required><option value="">Select category</option>{data.categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label>Entry name<input required className="mt-1 block w-full rounded-lg border p-2" value={name} onChange={e=>setName(e.target.value)}/></label></div>
        <button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Add entry</button>
      </form>
      <section className="space-y-3 rounded-xl border bg-white p-5"><h3 className="font-bold">Link enrolled courses to this track</h3><p className="text-sm text-slate-600">These links populate My Programs for enrolled learners. Test access remains shared practice. Only courses you manage can be changed.</p>
        {courseError&&<p role="alert" className="text-red-700">{courseError}</p>}
        <label>Course<select className="mt-1 block w-full rounded-lg border p-2" value={course} onChange={e=>setCourse(e.target.value)}><option value="">Select course</option>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <button disabled={busy||!context.level_id||!course} onClick={()=>link()} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Link course to track</button>
        {context.level_id&&links.filter(l=>l.level_id===context.level_id).map(l=><div key={l.course_id} className="flex flex-wrap items-center gap-3"><span>{courses.find(c=>c.id===l.course_id)?.name||'Course'}</span><button disabled={busy} className="text-red-700 underline" onClick={()=>link(true,l.course_id)}>Remove course link</button></div>)}
      </section>
    </>}
  </div>
}
