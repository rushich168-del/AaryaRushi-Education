import {useEffect,useRef,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {learningService as service} from '../../services/learningService.js'
import {navigateTo} from '../../utils/routes.js'
import StudentPortalLayout from './StudentPortalLayout.jsx'
import {useStudentProgram} from '../../components/auth/StudentProgramGate.jsx'
import StudentLearning from './learning/StudentLearning.jsx'
const blankLesson=()=>({title:'',body:'',sort_order:0,is_published:false})
const field='block mt-1 w-full rounded-lg border border-slate-300 p-3 text-slate-900 bg-white'
const button='rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50'
// Students get the dedicated Learning (LMS) experience; staff keep the course/lesson editor below.
export default function LearningPage(props) {
 return props.staff?<ManageLearning {...props}/>:<StudentLearningPage/>
}
function StudentLearningPage() {
 const {user}=useAuth()
 const selection=useStudentProgram()?.selection
 return <StudentPortalLayout name={user?.user_metadata?.full_name||user?.user_metadata?.name||user?.email?.split('@')[0]||'Learner'} program={selection?selection.program+' · '+selection.track:undefined} searchEnabled={false}><StudentLearning userId={user.id} levelId={selection?.level_id} program={selection?selection.program+' · '+selection.track:undefined}/></StudentPortalLayout>
}
function ManageLearning({staff=false,assignedOnly=false,materialsOnly=false}) {
 const {user}=useAuth()
 const selection=useStudentProgram()?.selection
 const [courses,setCourses]=useState([]),[institutes,setInstitutes]=useState([]),[courseId,setCourseId]=useState(()=>new URLSearchParams(window.location.search).get('course')||'')
 const initialLesson=useRef(new URLSearchParams(window.location.search).get('lesson'))
 const [search,setSearch]=useState(''),[lessonSearch,setLessonSearch]=useState(''),[lessonStatus,setLessonStatus]=useState('')
 const [lessons,setLessons]=useState([]),[batches,setBatches]=useState([]),[completed,setCompleted]=useState([])
 const [batchId,setBatchId]=useState(''),[roster,setRoster]=useState([]),[lesson,setLesson]=useState(null),[viewLesson,setViewLesson]=useState(null)
 const [progress,setProgress]=useState([]),[detailLoading,setDetailLoading]=useState(false)
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0)
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[institute,setInstitute]=useState(''),[batchName,setBatchName]=useState(''),[email,setEmail]=useState('')
 const lock=useRef(false)
 function remember(course,selectedLesson) {
  const url=new URL(window.location.href)
  if(course)url.searchParams.set('course',course);else url.searchParams.delete('course')
  if(selectedLesson)url.searchParams.set('lesson',selectedLesson);else url.searchParams.delete('lesson')
  window.history.replaceState({},'',url.pathname+url.search)
 }
 const original=lesson?.id?lessons.find(l=>l.id===lesson.id):blankLesson()
 const dirty=lesson&&['title','body','sort_order','is_published'].some(key=>String(lesson[key])!==String(original?.[key]))
 function discard(){return !dirty||window.confirm('Discard unsaved lesson changes?')}
 useEffect(()=>{if(!dirty)return;const warn=e=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty])
 useEffect(()=>{
  let active=true;setLoading(true);setError('')
  Promise.all([assignedOnly?service.teachingCourses():!staff&&selection?service.programCourses(selection.level_id):service.courses(),staff&&!assignedOnly?service.institutes():Promise.resolve([]),staff?Promise.resolve([]):service.completions(user.id)])
   .then(([c,i,done])=>{if(active){setCourses(c);setInstitutes(i);setInstitute(current=>current||i[0]?.id||'');setCompleted(done.map(x=>x.lesson_id))}})
   .catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false}
 },[staff,user.id,revision,selection?.level_id])
 const canReadCourse=staff||(!loading&&courses.some(c=>c.id===courseId))
 useEffect(()=>{
  let active=true;setLessons([]);setBatches([]);setViewLesson(null)
  if(courseId&&canReadCourse) {setDetailLoading(true);Promise.all([service.lessons(courseId),service.batches(courseId),staff?service.progress():Promise.resolve([])]).then(([l,b,p])=>{if(active){const readable=staff?l:l.filter(x=>x.is_published);setLessons(readable);setBatches(b);setProgress(p);if(initialLesson.current){const chosen=readable.find(x=>x.id===initialLesson.current);if(chosen){if(staff)setLesson({...chosen});else setViewLesson(chosen)}else setError('The requested lesson is unavailable.');initialLesson.current=null}}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setDetailLoading(false)})}
  return()=>{active=false}
 },[courseId,revision,canReadCourse])
 useEffect(()=>{
  let active=true;setRoster([])
  if(staff&&batchId)service.roster(batchId).then(r=>{if(active)setRoster(r)}).catch(e=>{if(active)setError(e.message)})
  return()=>{active=false}
 },[staff,batchId,revision])
 async function act(work,message) {
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('')
  try{await work();setNotice(message);setRevision(x=>x+1)}catch(e){setError(e.message)}finally{lock.current=false;setBusy(false)}
 }
 const course=courses.find(x=>x.id===courseId)
 const published=lessons.filter(x=>x.is_published)
 const done=published.filter(x=>completed.includes(x.id)).length
 const visibleCourses=courses.filter(c=>`${c.name} ${c.description}`.toLowerCase().includes(search.trim().toLowerCase()))
 const visibleLessons=lessons.filter(l=>l.title.toLowerCase().includes(lessonSearch.trim().toLowerCase())&&(!lessonStatus||(lessonStatus==='published'?l.is_published:!l.is_published)))
 const content=<section className={'mx-auto max-w-5xl space-y-6 p-4 text-slate-900 md:p-8'+(materialsOnly?' admin-materials':'')}>
  {!staff&&selection&&<div className="student-selected-program"><div><strong>{selection.program} · {selection.track}</strong><p>Your selected learning workspace</p></div><a href="/dashboard/student/program">Switch program</a></div>}
  <header className="flex flex-wrap items-center justify-between gap-3">
   <div><h1 className="text-2xl font-bold">{materialsOnly?'Study materials':assignedOnly?'My courses & batches':staff?'Courses & batches':'Learning'}</h1><p className="text-slate-600">{materialsOnly?'Choose a course to prepare lesson materials and manage their availability to enrolled students.':assignedOnly?'Manage lessons and view learners in your assigned batches.':staff?'Create lessons and enroll learners into course batches.':'Open your enrolled courses and continue learning.'}</p></div>
   {!staff&&<button className="text-blue-700 font-semibold" onClick={()=>navigateTo('/dashboard/student')}>Tests & results</button>}
  </header>
  {error&&<div role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">{error}<button className="ml-3 underline" onClick={()=>setRevision(x=>x+1)}>Retry loading</button></div>}
  {notice&&<p role="status" className="rounded-lg bg-green-50 p-3 text-green-800">{notice}</p>}
  {materialsOnly&&<p className="admin-materials-note">Materials use course lesson content. Standalone PDF uploads are not available yet. <a href={assignedOnly?'/dashboard/teacher/courses':'/dashboard/admin/assignments'}>{assignedOnly?'View assigned courses →':'Manage course and batch access →'}</a></p>}
  {loading?<p role="status">Loading courses…</p>:!courseId?<>
   {courses.length===0&&<p className="rounded-lg border p-6">{assignedOnly?'No courses assigned yet. Contact your administrator.':staff?(materialsOnly?'No courses yet. Create a course before adding its materials.':'No courses yet. Create your first course below.'):'No courses assigned yet. Your institute will enroll you into a batch.'}</p>}
   <label className="block">Search courses<input className={field} value={search} onChange={e=>setSearch(e.target.value)}/></label>
   {courses.length>0&&visibleCourses.length===0&&<p>No courses match your search.</p>}
   <div className="grid gap-4 md:grid-cols-2">{visibleCourses.map(c=><button key={c.id} className="rounded-xl border bg-white p-5 text-left hover:border-blue-500" onClick={()=>{remember(c.id);setCourseId(c.id);setBatchId('');setLesson(null);setLessonSearch('');setLessonStatus('')}}><h2 className="text-xl font-bold">{c.name}</h2><p className="mt-2 text-slate-600">{c.description}</p><span className="mt-3 block font-semibold text-blue-700">Open course →</span></button>)}</div>
   {materialsOnly&&!assignedOnly&&!courses.length&&<a className="staff-button staff-button-yellow" href="/dashboard/admin/courses">Create a course →</a>}
   {staff&&!assignedOnly&&!materialsOnly&&<form className="space-y-4 rounded-xl border bg-white p-5" onSubmit={e=>{e.preventDefault();act(async()=>{await service.createCourse(institute,name,description);setName('');setDescription('')},'Course created.')}}>
    <h2 className="text-lg font-bold">Create course</h2>
    {institutes.length===0?<p>Institute staff membership is required. Complete staff setup first.</p>:<>
     <label className="block">Institute<select className={field} value={institute} onChange={e=>setInstitute(e.target.value)}>{institutes.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
     <label className="block">Course name<input className={field} required value={name} onChange={e=>setName(e.target.value)} /></label>
     <label className="block">Description<textarea className={field} value={description} onChange={e=>setDescription(e.target.value)} /></label>
     <button disabled={busy} className={button}>Create course</button>
    </>}
   </form>}
  </>:!course?<p>Course is unavailable. <button className="underline" onClick={()=>setCourseId('')}>Back to courses</button></p>:<>
   <button className="font-semibold text-blue-700" onClick={()=>{if(!discard())return;remember('');setCourseId('');setBatchId('');setLesson(null)}}>← All courses</button>
   <h2 className="text-2xl font-bold">{course.name}</h2><p>{course.description}</p>
   {!staff&&<p className="rounded-lg bg-blue-50 p-4">{published.length?`${done} of ${published.length} published lessons completed`:'Your teacher has not published lessons yet.'}</p>}
   {detailLoading&&<p role="status">Loading lessons and batches…</p>}
   {materialsOnly&&!detailLoading&&!lessons.length&&<div className="admin-panel"><h3>No lesson materials yet</h3><p>Add your first lesson below. Keep it as a draft until it is ready for enrolled students.</p></div>}
   <div className="flex flex-wrap gap-3"><label className="flex-1">Search lessons<input className={field} value={lessonSearch} onChange={e=>setLessonSearch(e.target.value)}/></label>{staff&&<label>Lesson status<select className={field} value={lessonStatus} onChange={e=>setLessonStatus(e.target.value)}><option value="">All lessons</option><option value="draft">Draft</option><option value="published">Published</option></select></label>}</div>
   {!detailLoading&&lessons.length>0&&visibleLessons.length===0&&<p>No lessons match these filters.</p>}
   <div className="space-y-3">{visibleLessons.map(l=><div key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4">
    <div><h3 className="font-bold">{l.title}</h3><p className="text-sm text-slate-500">{staff?(l.is_published?'Published':'Draft'):completed.includes(l.id)?'Completed':'Ready to learn'}</p></div>
    <button className="font-semibold text-blue-700" onClick={()=>{if(!discard())return;remember(courseId,l.id);staff?setLesson({...l}):setViewLesson(l)}}>{staff?'Edit lesson':'Open lesson'}</button>
   </div>)}</div>
   {!staff&&viewLesson&&<article className="space-y-4 rounded-xl border bg-white p-6">
    <h2 className="text-2xl font-bold">{viewLesson.title}</h2><div className="whitespace-pre-wrap break-words leading-8">{viewLesson.body}</div>
    <button className={button} disabled={busy||completed.includes(viewLesson.id)} onClick={()=>act(()=>service.complete(viewLesson.id),'Lesson completed. Your progress is saved.')}>{completed.includes(viewLesson.id)?'Completed':'Mark as completed'}</button>
   </article>}
   {staff&&<>
    <button className={button} onClick={()=>{if(!discard())return;remember(courseId);setLesson(blankLesson())}}>Add lesson</button>
    {lesson&&<form className="space-y-4 rounded-xl border bg-white p-5" onSubmit={e=>{e.preventDefault();act(async()=>{await service.saveLesson(courseId,lesson);setLesson(null)},'Lesson saved.')}}>
     <h3 className="text-xl font-bold">{lesson.id?'Edit lesson':'New lesson'}</h3>
     <label className="block">Lesson title<input className={field} required value={lesson.title} onChange={e=>setLesson({...lesson,title:e.target.value})}/></label>
     <label className="block">Lesson text<textarea className={field} rows={12} value={lesson.body} onChange={e=>setLesson({...lesson,body:e.target.value})}/></label>
     <label className="block">Lesson order<input className={field} type="number" min="0" step="1" value={lesson.sort_order} onChange={e=>setLesson({...lesson,sort_order:e.target.value})}/></label>
     <label className="flex gap-2"><input type="checkbox" checked={lesson.is_published} onChange={e=>setLesson({...lesson,is_published:e.target.checked})}/>Publish for enrolled learners</label>
     <div className="flex gap-3"><button disabled={busy} className={button}>Save lesson</button><button type="button" onClick={()=>{if(discard()){remember(courseId);setLesson(null)}}}>Cancel</button></div>
    </form>}
    {!assignedOnly&&!materialsOnly&&<form className="space-y-3 rounded-xl border bg-white p-5" onSubmit={e=>{e.preventDefault();act(async()=>{await service.createBatch(courseId,batchName);setBatchName('')},'Batch created.')}}>
     <h3 className="text-xl font-bold">Course batches</h3><label className="block">New batch name<input required className={field} value={batchName} onChange={e=>setBatchName(e.target.value)}/></label><button disabled={busy} className={button}>Create batch</button>
    </form>}
    {!materialsOnly&&<div className="space-y-4 rounded-xl border bg-white p-5">
     <label className="block">Manage batch<select className={field} value={batchId} onChange={e=>setBatchId(e.target.value)}><option value="">Choose batch…</option>{batches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
     {batchId&&<><h3 className="font-bold">Enrolled learners ({roster.length})</h3>{roster.map(r=><p key={r.student_id}>{r.student_profiles?.full_name||'Learner'} — {published.filter(l=>progress.some(p=>p.student_id===r.student_id&&p.lesson_id===l.id)).length} / {published.length} published lessons completed</p>)}
      {!assignedOnly&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();act(()=>service.enroll(batchId,email),'Learner enrolled.')}}>
       <label className="block">Confirmed learner email<input type="email" required className={field} value={email} onChange={e=>setEmail(e.target.value)}/></label>
       <p className="text-sm text-slate-500">Use an existing confirmed account. Enrollment sends no email.</p>
       <div className="flex flex-wrap gap-3"><button disabled={busy} className={button}>Enroll learner</button><button type="button" disabled={busy||!email.trim()} className="text-red-700" onClick={()=>act(()=>service.enroll(batchId,email,true),'Enrollment removed for this batch.')}>Remove enrollment</button></div>
      </form>}
     </>}
    </div>}
   </>}
  </>}
 </section>
 return staff?content:<StudentPortalLayout name={user?.user_metadata?.full_name||user?.user_metadata?.name||user?.email?.split('@')[0]||'Learner'} program={selection?selection.program+' · '+selection.track:undefined} searchEnabled={false}><div className="student-learning-page">{content}</div></StudentPortalLayout>
}



