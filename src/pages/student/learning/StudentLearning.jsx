import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,BookOpen,BookOpenCheck,CheckCircle2,ChevronDown,Clock,GraduationCap,ListChecks,PlayCircle,RotateCw,Search,Sparkles,Trophy} from 'lucide-react'
import {learningService as service} from '../../../services/learningService.js'
import './learning.css'

// Student-facing Learning (LMS) experience: My courses → course overview → lesson reader.
// Uses only published lessons and the student's own completions; progress = lessons marked complete.
const WORDS_PER_MINUTE=180
export const readMinutes=text=>{const words=String(text||'').trim().split(/\s+/).filter(Boolean).length;return words?Math.max(1,Math.round(words/WORDS_PER_MINUTE)):0}
export const formatMinutes=m=>m<60?`${m} min`:`${Math.floor(m/60)} h${m%60?` ${m%60} min`:''}`
const formatDate=value=>{if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
const percentOf=(done,total)=>total?Math.round(done*100/total):0
const initials=name=>String(name||'Course').split(/[\s·\-–&]+/).filter(w=>/[A-Za-z0-9]/.test(w)).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'C'
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`
const memoryKey=user=>'ksc.learning.last.'+user
function readLast(user){try{return JSON.parse(localStorage.getItem(memoryKey(user))||'null')}catch{return null}}
function writeLast(user,value){try{localStorage.setItem(memoryKey(user),JSON.stringify(value))}catch{/* per-viewer convenience only */}}
function readUrl(){const q=new URLSearchParams(window.location.search);return{course:q.get('course')||'',lesson:q.get('lesson')||''}}

function useLearningData(userId,levelId){
 const [state,setState]=useState({loading:true,error:'',courses:[]})
 const [completed,setCompleted]=useState(()=>new Map())
 const [revision,setRevision]=useState(0)
 useEffect(()=>{
  let active=true
  setState(s=>({...s,loading:true,error:''}))
  ;(async()=>{
   try{
    const [courses,done]=await Promise.all([levelId?service.programCourses(levelId):service.courses(),service.completions(userId)])
    const rows=await Promise.all(courses.map(async course=>{
     try{return{...course,lessons:(await service.lessons(course.id)).filter(l=>l.is_published),failed:false}}
     catch{return{...course,lessons:[],failed:true}}
    }))
    if(!active)return
    setCompleted(new Map(done.map(r=>[r.lesson_id,r.completed_at||null])))
    setState({loading:false,error:'',courses:rows})
   }catch(e){if(active)setState({loading:false,error:e?.message||'Your courses could not be loaded.',courses:[]})}
  })()
  return()=>{active=false}
 },[userId,levelId,revision])
 const complete=useCallback(async id=>{
  await service.complete(id)
  setCompleted(m=>{const n=new Map(m);if(!n.has(id))n.set(id,new Date().toISOString());return n})
 },[])
 return{...state,completed,complete,retry:()=>setRevision(x=>x+1)}
}

function summarise(course,completed){
 const lessons=course.lessons||[]
 const total=lessons.length,done=lessons.filter(l=>completed.has(l.id)).length
 const next=lessons.find(l=>!completed.has(l.id))||null
 const minutes=lessons.reduce((sum,l)=>sum+readMinutes(l.body),0)
 const minutesLeft=lessons.filter(l=>!completed.has(l.id)).reduce((sum,l)=>sum+readMinutes(l.body),0)
 const lastActivity=lessons.map(l=>completed.get(l.id)).filter(Boolean).sort().pop()||''
 const status=course.failed?'unavailable':!total?'soon':done===total?'completed':done?'progress':'new'
 return{...course,lessons,total,done,next,minutes,minutesLeft,lastActivity,status,percent:percentOf(done,total)}
}
function pickResume(courses,completed,last){
 const open=courses.filter(c=>c.next)
 if(!open.length)return null
 const fromLast=last&&open.find(c=>c.id===last.course)
 const recent=open.filter(c=>c.lastActivity).sort((a,b)=>b.lastActivity.localeCompare(a.lastActivity))[0]
 const course=fromLast||recent||open[0]
 const remembered=fromLast&&course.lessons.find(l=>l.id===last.lesson&&!completed.has(l.id))
 const lesson=remembered||course.next
 return{course,lesson,index:course.lessons.indexOf(lesson)}
}

const STATUS={progress:['In progress','blue'],new:['Not started','grey'],completed:['Completed','green'],soon:['Lessons coming soon','grey'],unavailable:['Could not load','red']}
function StatusPill({status}){const [label,tone]=STATUS[status];return <span className={'lx-pill lx-pill-'+tone}>{status==='completed'&&<CheckCircle2 size={13}/>}{label}</span>}
function Bar({percent,label}){return <div className="lx-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{width:percent+'%'}}/></div>}
function Ring({percent,size=96,stroke=9,children}){
 const r=(size-stroke)/2,c=2*Math.PI*r
 return <div className="lx-ring" style={{width:size,height:size}} role="img" aria-label={percent+'% of lessons completed'}>
  <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true"><circle cx={size/2} cy={size/2} r={r} strokeWidth={stroke} className="lx-ring-track"/><circle cx={size/2} cy={size/2} r={r} strokeWidth={stroke} className="lx-ring-value" strokeDasharray={c} strokeDashoffset={c*(1-percent/100)} transform={`rotate(-90 ${size/2} ${size/2})`}/></svg>
  <span className="lx-ring-label" aria-hidden="true">{children??<strong>{percent}%</strong>}</span>
 </div>
}

function Loading(){return <div className="lx-loading" role="status" aria-live="polite"><span className="lx-sr">Loading your courses…</span><div className="lx-skel lx-skel-hero"/><div className="lx-skel-row"><div className="lx-skel"/><div className="lx-skel"/><div className="lx-skel"/></div><div className="lx-skel-grid"><div className="lx-skel lx-skel-card"/><div className="lx-skel lx-skel-card"/></div></div>}
function Notice({icon:Icon=BookOpen,title,children,actions,role}){return <section className="lx-empty" role={role}><span className="lx-empty-icon"><Icon size={30}/></span><h2 className="lx-title">{title}</h2><div className="lx-empty-text">{children}</div>{actions&&<div className="lx-empty-actions">{actions}</div>}</section>}

function Home({courses,completed,resume,go}){
 const [filter,setFilter]=useState('all'),[search,setSearch]=useState('')
 const total=courses.reduce((a,c)=>a+c.total,0),done=courses.reduce((a,c)=>a+c.done,0)
 const minutesLeft=courses.reduce((a,c)=>a+c.minutesLeft,0)
 const overall=percentOf(done,total)
 const counts={all:courses.length,progress:0,new:0,completed:0};courses.forEach(c=>{if(counts[c.status]!==undefined)counts[c.status]++})
 const term=search.trim().toLowerCase()
 const visible=courses.filter(c=>(filter==='all'||c.status===filter)&&(!term||`${c.name} ${c.description||''} ${c.lessons.map(l=>l.title).join(' ')}`.toLowerCase().includes(term)))
 if(!courses.length)return <Notice icon={GraduationCap} title="Your learning space is ready" actions={<a className="lx-btn lx-btn-navy" href="/dashboard/student">Go to dashboard <ArrowRight size={16}/></a>}><p>No courses assigned yet. Your institute will enroll you into a batch, and your lessons will appear here automatically.</p></Notice>
 const heading=resume?(done?'Pick up where you left off':'Start your first lesson'):total?'You’re all caught up':'Lessons are on the way'
 const sub=resume?(done?`You’ve completed ${plural(done,'lesson')} so far. Keep going — every lesson counts.`:'Your courses are ready. Begin with the first lesson below.'):total?'You’ve completed every published lesson. New lessons from your teachers will appear here.':'Your teachers haven’t published lessons yet. Check back soon.'
 return <>
  <section className="lx-hero" aria-labelledby="lx-hero-title">
   <div className="lx-hero-copy">
    <p className="lx-eyebrow"><Sparkles size={15}/>My learning</p>
    <h2 id="lx-hero-title" className="lx-title">{heading}</h2>
    <p className="lx-hero-sub">{sub}</p>
    {resume&&<div className="lx-resume">
     <span className="lx-resume-icon" aria-hidden="true"><PlayCircle size={26}/></span>
     <div className="lx-resume-text"><small>{resume.course.name} · Lesson {resume.index+1} of {resume.course.total}</small><strong>{resume.lesson.title}</strong><Bar percent={resume.course.percent} label={resume.course.name+' progress'}/></div>
     <button type="button" className="lx-btn lx-btn-yellow" onClick={()=>go(resume.course.id,resume.lesson.id)}>{resume.course.done?'Resume lesson':'Start lesson'}<ArrowRight size={17}/></button>
    </div>}
   </div>
   {total>0&&<div className="lx-hero-ring"><Ring percent={overall} size={136} stroke={12}><strong>{overall}%</strong><small>overall</small></Ring><p>{done} of {plural(total,'lesson')} completed</p></div>}
  </section>
  <ul className="lx-stats" aria-label="Learning summary">
   <li><span className="lx-stat-icon"><BookOpen size={20}/></span><div><strong>{courses.length}</strong><small>{courses.length===1?'Course':'Courses'}</small></div></li>
   <li><span className="lx-stat-icon is-green"><CheckCircle2 size={20}/></span><div><strong>{done}</strong><small>Lessons completed</small></div></li>
   <li><span className="lx-stat-icon is-yellow"><ListChecks size={20}/></span><div><strong>{total-done}</strong><small>Lessons left</small></div></li>
   <li><span className="lx-stat-icon"><Clock size={20}/></span><div><strong>{minutesLeft?'≈ '+formatMinutes(minutesLeft):'—'}</strong><small>Reading left (est.)</small></div></li>
  </ul>
  <section className="lx-section" aria-labelledby="lx-courses-title">
   <div className="lx-section-head">
    <div><h2 id="lx-courses-title" className="lx-title">My courses</h2><p>Courses from the batches you’re enrolled in.</p></div>
    <label className="lx-search"><Search size={17} aria-hidden="true"/><input type="search" aria-label="Search my courses" placeholder="Search courses or lessons" value={search} onChange={e=>setSearch(e.target.value)}/></label>
   </div>
   {courses.length>1&&<div className="lx-chips" role="group" aria-label="Filter courses">{[['all','All'],['progress','In progress'],['new','Not started'],['completed','Completed']].map(([key,label])=><button key={key} type="button" aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div>}
   {visible.length?<div className="lx-grid">{visible.map(c=><CourseCard key={c.id} course={c} go={go}/>)}</div>
    :<div className="lx-inline-empty"><p>No courses match {term?`“${search.trim()}”`:'this filter'}.</p><button type="button" className="lx-link" onClick={()=>{setSearch('');setFilter('all')}}>Show all courses</button></div>}
   <p className="lx-footnote">Progress counts the lessons you mark as complete. It doesn’t include test scores.</p>
  </section>
 </>
}

function CourseCard({course:c,go}){
 const primary=c.status==='progress'?'Continue':c.status==='new'?'Start course':null
 return <article className={'lx-card is-'+c.status}>
  <div className="lx-card-top"><span className="lx-initials" aria-hidden="true">{initials(c.name)}</span><StatusPill status={c.status}/></div>
  <h3 className="lx-card-title">{c.name}</h3>
  {c.description&&<p className="lx-card-desc">{c.description}</p>}
  <p className="lx-meta"><span><BookOpen size={14}/>{plural(c.total,'lesson')}</span>{c.minutes>0&&<span><Clock size={14}/>≈ {formatMinutes(c.minutes)}</span>}</p>
  {c.total>0&&<div className="lx-card-progress"><Bar percent={c.percent} label={c.name+' progress'}/><p><span>{c.done} of {c.total} completed</span><strong>{c.percent}%</strong></p></div>}
  {c.status==='unavailable'&&<p className="lx-card-warn" role="alert">This course’s lessons couldn’t load. Try again shortly.</p>}
  {c.next&&<p className="lx-upnext"><span>Up next</span>{c.next.title}</p>}
  <div className="lx-card-actions">
   {primary&&<button type="button" className="lx-btn lx-btn-yellow" aria-label={`${primary}: ${c.name}`} onClick={()=>go(c.id,c.next.id)}>{primary}<ArrowRight size={16}/></button>}
   <button type="button" className={primary?'lx-btn lx-btn-ghost':'lx-btn lx-btn-navy'} aria-label={`${c.status==='completed'?'Review course':'View lessons'}: ${c.name}`} onClick={()=>go(c.id)}>{c.status==='completed'?'Review course':'View lessons'}{!primary&&<ArrowRight size={16}/>}</button>
  </div>
 </article>
}

function CourseView({course,completed,go}){
 const [search,setSearch]=useState('')
 const term=search.trim().toLowerCase()
 const rows=course.lessons.map((l,i)=>({l,i})).filter(({l})=>!term||l.title.toLowerCase().includes(term))
 const cta=course.next?<button type="button" className="lx-btn lx-btn-yellow" onClick={()=>go(course.id,course.next.id)}>{course.done?'Continue':'Start'}: {course.next.title}<ArrowRight size={17}/></button>
  :course.total?<button type="button" className="lx-btn lx-btn-light" onClick={()=>go(course.id,course.lessons[0].id)}><RotateCw size={16}/>Review from the first lesson</button>:null
 return <>
  <Crumbs go={go} course={course}/>
  <section className="lx-course-head" aria-labelledby="lx-course-title">
   <div className="lx-course-main">
    <div className="lx-course-badges"><span className="lx-initials is-light" aria-hidden="true">{initials(course.name)}</span><StatusPill status={course.status}/></div>
    <h2 id="lx-course-title" className="lx-title">{course.name}</h2>
    {course.description&&<p className="lx-course-desc">{course.description}</p>}
    <ul className="lx-facts"><li><BookOpen size={16}/>{plural(course.total,'lesson')}</li>{course.minutes>0&&<li><Clock size={16}/>≈ {formatMinutes(course.minutes)} reading</li>}<li><CheckCircle2 size={16}/>{course.done} completed</li></ul>
    {cta&&<div className="lx-course-cta">{cta}</div>}
   </div>
   {course.total>0&&<div className="lx-course-ring"><Ring percent={course.percent} size={124} stroke={11}><strong>{course.percent}%</strong><small>complete</small></Ring><p>{course.done} of {course.total} published lessons completed</p></div>}
  </section>
  <section className="lx-section" aria-labelledby="lx-lessons-title">
   <div className="lx-section-head"><div><h2 id="lx-lessons-title" className="lx-title">Lessons</h2><p>{course.total?'Work through them in order, or open any lesson to revise.':'Nothing published yet.'}</p></div>
    {course.total>5&&<label className="lx-search"><Search size={17} aria-hidden="true"/><input type="search" aria-label="Search lessons" placeholder="Search lessons" value={search} onChange={e=>setSearch(e.target.value)}/></label>}</div>
   {course.status==='unavailable'?<p className="lx-card-warn" role="alert">Lessons for this course couldn’t load. Go back and try again.</p>
   :!course.total?<Notice icon={BookOpen} title="Lessons are on the way"><p>Your teacher has not published lessons yet. They’ll appear here as soon as they’re ready.</p></Notice>
   :rows.length?<ol className="lx-lessons">{rows.map(({l,i})=>{
     const isDone=completed.has(l.id),isNext=course.next?.id===l.id,m=readMinutes(l.body),at=formatDate(completed.get(l.id))
     const action=isDone?'Review':isNext?'Start':'Open'
     return <li key={l.id} className={isDone?'is-done':isNext?'is-next':''}><button type="button" className="lx-lesson-row" onClick={()=>go(course.id,l.id)} aria-label={`${action} lesson ${i+1}: ${l.title}${isDone?' (completed)':''}`}>
      <span className="lx-step" aria-hidden="true">{isDone?<CheckCircle2 size={20}/>:i+1}</span>
      <span className="lx-lesson-text"><strong>{l.title}</strong><small>{m?`≈ ${m} min read`:'Short lesson'}{isDone?(at?` · Completed ${at}`:' · Completed'):''}</small></span>
      {isNext&&<span className="lx-pill lx-pill-yellow">Up next</span>}
      <span className="lx-row-action" aria-hidden="true">{action}<ArrowRight size={15}/></span>
     </button></li>})}</ol>
   :<div className="lx-inline-empty"><p>No lessons match “{search.trim()}”.</p><button type="button" className="lx-link" onClick={()=>setSearch('')}>Clear search</button></div>}
  </section>
 </>
}

function Crumbs({go,course,lessonNumber}){return <nav className="lx-crumbs" aria-label="Breadcrumb">
 <button type="button" onClick={()=>go()}><ArrowLeft size={15}/>My courses</button>
 {course&&lessonNumber&&<><span aria-hidden="true">/</span><button type="button" onClick={()=>go(course.id)}>{course.name}</button><span aria-hidden="true">/</span><span aria-current="page">Lesson {lessonNumber}</span></>}
 {course&&!lessonNumber&&<><span aria-hidden="true">/</span><span aria-current="page">{course.name}</span></>}
</nav>}

function Outline({course,lesson,completed,go}){return <ol className="lx-outline-list">{course.lessons.map((l,i)=>{const isDone=completed.has(l.id),current=l.id===lesson.id
 return <li key={l.id}><button type="button" aria-current={current?'step':undefined} className={(current?'is-current ':'')+(isDone?'is-done':'')} onClick={()=>go(course.id,l.id)}><span className="lx-dot" aria-hidden="true">{isDone?<CheckCircle2 size={16}/>:i+1}</span><span>{l.title}</span>{isDone&&<span className="lx-sr"> (completed)</span>}</button></li>})}</ol>}

function LessonReader({course,lesson,completed,go,onComplete,busy,notice,error}){
 const index=course.lessons.findIndex(l=>l.id===lesson.id)
 const prev=course.lessons[index-1],next=course.lessons[index+1]
 const isDone=completed.has(lesson.id),at=formatDate(completed.get(lesson.id)),m=readMinutes(lesson.body)
 const paragraphs=String(lesson.body||'').split(/\n\s*\n/).map(p=>p.replace(/^\n+|\n+$/g,'')).filter(p=>p.trim())
 const heading=useRef(null)
 useEffect(()=>{heading.current?.focus({preventScroll:true})},[lesson.id])
 return <div className="lx-reader">
  <aside className="lx-outline" aria-label="Lessons in this course">
   <button type="button" className="lx-outline-course" onClick={()=>go(course.id)}><ArrowLeft size={15}/><span>{course.name}</span></button>
   <Bar percent={course.percent} label={course.name+' progress'}/><p className="lx-outline-count">{course.done} of {course.total} completed</p>
   <Outline course={course} lesson={lesson} completed={completed} go={go}/>
  </aside>
  <article className="lx-lesson" aria-labelledby="lx-lesson-title">
   <Crumbs go={go} course={course} lessonNumber={index+1}/>
   <details className="lx-outline-mobile"><summary><ListChecks size={18}/><span>Lessons in this course</span><em>{course.done}/{course.total}</em><ChevronDown size={18} className="lx-chevron"/></summary><Outline course={course} lesson={lesson} completed={completed} go={go}/></details>
   <div className="lx-lesson-card">
    <p className="lx-lesson-meta"><span>Lesson {index+1} of {course.total}</span>{m>0&&<span><Clock size={14}/>≈ {m} min read</span>}{isDone&&<span className="lx-pill lx-pill-green"><CheckCircle2 size={13}/>Completed</span>}</p>
    <h2 id="lx-lesson-title" className="lx-title lx-lesson-title" tabIndex={-1} ref={heading}>{lesson.title}</h2>
    <div className="lx-lesson-body">{paragraphs.length?paragraphs.map((p,i)=><p key={i}>{p}</p>):<p className="lx-muted">This lesson has no written content yet.</p>}</div>
    <div className={'lx-complete'+(isDone?' is-done':'')}>
     {isDone?<><span className="lx-complete-icon"><CheckCircle2 size={26}/></span><div><strong>Lesson completed</strong><p>{at?`Completed on ${at}. `:''}Nice work — keep the momentum going.</p></div></>
     :<><span className="lx-complete-icon"><BookOpenCheck size={26}/></span><div><strong>Finished reading?</strong><p>Mark this lesson as complete to save your progress.</p></div><button type="button" className="lx-btn lx-btn-yellow" disabled={busy} onClick={()=>onComplete(lesson.id)}>{busy?'Saving…':'Mark as completed'}</button></>}
    </div>
    {notice&&<p role="status" className="lx-notice"><CheckCircle2 size={16}/>{notice}</p>}
    {error&&<p role="alert" className="lx-alert">{error}</p>}
    {isDone&&course.status==='completed'&&!next&&<div className="lx-celebrate"><span className="lx-celebrate-icon"><Trophy size={26}/></span><div><strong>Course complete!</strong><p>You’ve finished every published lesson in {course.name}.</p></div><button type="button" className="lx-btn lx-btn-navy" onClick={()=>go()}>Back to my courses</button></div>}
   </div>
   <nav className="lx-pager" aria-label="Lesson navigation">
    {prev?<button type="button" className="lx-pager-btn" onClick={()=>go(course.id,prev.id)}><small><ArrowLeft size={14}/>Previous lesson</small><span>{prev.title}</span></button>:<span className="lx-pager-spacer"/>}
    {next?<button type="button" className="lx-pager-btn is-next" onClick={()=>go(course.id,next.id)}><small>Next lesson<ArrowRight size={14}/></small><span>{next.title}</span></button>
     :<button type="button" className="lx-pager-btn is-next" onClick={()=>go(course.id)}><small>Course overview<ArrowRight size={14}/></small><span>Back to all lessons</span></button>}
   </nav>
  </article>
 </div>
}

export default function StudentLearning({userId,levelId,program}){
 const data=useLearningData(userId,levelId)
 const [route,setRoute]=useState(readUrl)
 const [last,setLast]=useState(()=>readLast(userId))
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[actionError,setActionError]=useState('')
 const lock=useRef(false)
 useEffect(()=>{const pop=()=>{setRoute(readUrl());setNotice('');setActionError('')};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop)},[])
 const go=useCallback((course='',lesson='')=>{
  const url=new URL(window.location.href)
  if(course)url.searchParams.set('course',course);else url.searchParams.delete('course')
  if(lesson)url.searchParams.set('lesson',lesson);else url.searchParams.delete('lesson')
  window.history.pushState({},'',url.pathname+url.search)
  setRoute({course,lesson});setNotice('');setActionError('')
  try{window.scrollTo({top:0,behavior:'smooth'})}catch{/* ignore */}
 },[])
 const courses=useMemo(()=>data.courses.map(c=>summarise(c,data.completed)),[data.courses,data.completed])
 const course=courses.find(c=>c.id===route.course)
 const lesson=course?.lessons.find(l=>l.id===route.lesson)
 useEffect(()=>{if(course&&lesson){const value={course:course.id,lesson:lesson.id};writeLast(userId,value);setLast(value)}},[course?.id,lesson?.id,userId])
 const resume=useMemo(()=>pickResume(courses,data.completed,last),[courses,data.completed,last])
 async function onComplete(id){
  if(lock.current)return;lock.current=true;setBusy(true);setActionError('');setNotice('')
  try{await data.complete(id);setNotice('Lesson completed. Your progress is saved.')}
  catch(e){setActionError((e?.message?e.message+' ':'')+'Your progress was not saved. Please try again.')}
  finally{lock.current=false;setBusy(false)}
 }
 let view
 if(data.loading)view=<Loading/>
 else if(data.error)view=<Notice role="alert" icon={RotateCw} title="We couldn’t load your courses" actions={<button type="button" className="lx-btn lx-btn-navy" onClick={data.retry}><RotateCw size={16}/>Retry loading</button>}><p>{data.error}</p><p>Check your connection and try again.</p></Notice>
 else if(route.course&&!course)view=<><Crumbs go={go}/><Notice role="alert" icon={BookOpen} title="Course not available" actions={<button type="button" className="lx-btn lx-btn-navy" onClick={()=>go()}>Back to my courses</button>}><p>This course isn’t part of your current learning space. If you think this is a mistake, contact your institute.</p></Notice></>
 else if(course&&route.lesson&&!lesson)view=<><Crumbs go={go} course={course}/><Notice role="alert" icon={BookOpen} title="Lesson not available" actions={<button type="button" className="lx-btn lx-btn-navy" onClick={()=>go(course.id)}>See course lessons</button>}><p>The requested lesson is unavailable. It may have been moved or not published yet.</p></Notice></>
 else if(course&&lesson)view=<LessonReader course={course} lesson={lesson} completed={data.completed} go={go} onComplete={onComplete} busy={busy} notice={notice} error={actionError}/>
 else if(course)view=<CourseView key={course.id} course={course} completed={data.completed} go={go}/>
 else view=<Home courses={courses} completed={data.completed} resume={resume} go={go}/>
 return <div className="lx">
  {program&&<div className="lx-program"><span><GraduationCap size={17}/>Program</span><strong>{program}</strong><a href="/dashboard/student/program">Switch program</a></div>}
  {view}
 </div>
}
