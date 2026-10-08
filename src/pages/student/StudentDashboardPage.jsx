import {useState,useEffect} from 'react'
import {ArrowRight,ClipboardCheck,GraduationCap,Trophy} from 'lucide-react'
import {useAuth} from '../../context/AuthContext.jsx'
import {supabase} from '../../lib/supabaseClient.js'
import {studentExamService} from '../../services/studentExamService.js'
import {resultService,resultValue} from '../../services/resultService.js'
import StudentPortalLayout from './StudentPortalLayout.jsx'
import {useStudentLearning} from './StudentLearningOverview.jsx'
import StudentLearningCards from './StudentLearningCards.jsx'
import {useStudentProgram} from '../../components/auth/StudentProgramGate.jsx'

export default function StudentDashboardPage(){
 const {user}=useAuth()
 const programState=useStudentProgram(),selection=programState?.selection
 const [availableTests,setAvailableTests]=useState([]),[attempts,setAttempts]=useState([]),[questionCounts,setQuestionCounts]=useState({})
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[missingProfile,setMissingProfile]=useState(false),[retry,setRetry]=useState(0),[profile,setProfile]=useState(null),[search,setSearch]=useState('')
 const learning=useStudentLearning(user?.id,selection?.level_id)
 useEffect(()=>{
  if(!user?.id)return
  let active=true
  async function load(){
   setLoading(true);setError('');setMissingProfile(false)
   try{
    const {data:current,error:profileError}=await supabase.from('student_profiles').select('id,full_name').eq('id',user.id).maybeSingle()
    if(!active)return
    if(profileError)throw profileError
    setProfile(current)
    if(!current){setMissingProfile(true);return}
    await resultService.triggerExpiredFinalization()
    const [testsData,attemptsData]=await Promise.all([studentExamService.getAvailableTests(),studentExamService.getMyAttempts()])
    if(!active)return
    const attemptedIds=new Set(attemptsData.map(a=>a.test_id))
    const fresh=testsData.filter(t=>!attemptedIds.has(t.id))
    setAvailableTests(fresh);setAttempts(attemptsData)
    studentExamService.getQuestionCounts(fresh.slice(0,24).map(t=>t.id)).then(counts=>{if(active)setQuestionCounts(counts)}).catch(()=>{})
   }catch{if(active)setError('Tests and results could not be loaded. Your learning space is available separately.')}
   finally{if(active)setLoading(false)}
  }
  load();return()=>{active=false}
 },[user?.id,retry])
 useEffect(()=>{const refresh=()=>setRetry(x=>x+1);window.addEventListener('focus',refresh);window.addEventListener('ksc-refresh-student-tests',refresh);return()=>{window.removeEventListener('focus',refresh);window.removeEventListener('ksc-refresh-student-tests',refresh)}},[])
 useEffect(()=>{if(loading||learning.loading)return;const id=window.location.hash.slice(1);if(['student-tests','student-results','study-materials','my-learning','course-progress'].includes(id))document.getElementById(id)?.scrollIntoView({block:'start'})},[loading,learning.loading])
 const name=profile?.full_name||user?.user_metadata?.full_name||user?.user_metadata?.name||'Learner'
 const match=value=>String(value||'').toLowerCase().includes(search.trim().toLowerCase())
 const inProgram=test=>!selection||(test?.exam_id===selection.exam_id&&(test?.program_wide===true||test?.level_id===selection.level_id))
 const inProgress=attempts.filter(a=>a.status==='IN_PROGRESS'&&inProgram(a.tests))
 const completed=attempts.filter(a=>['SUBMITTED','EXPIRED'].includes(a.status)&&inProgram(a.tests))
 const programTests=availableTests.filter(inProgram)
 const tests=programTests.filter(t=>match(t.name+' '+(t.exams?.name||'')))
 const results=completed.filter(a=>match(a.tests?.name+' '+(a.tests?.exams?.name||'')))
 const activeAttempts=inProgress.filter(a=>match(a.tests?.name+' '+(a.tests?.exams?.name||'')))
 return <StudentPortalLayout name={name} search={search} setSearch={setSearch} program={selection?selection.program+' · '+selection.track:undefined}>
 {selection&&<section className="student-selected-program"><GraduationCap size={25}/><div><strong>{selection.program} · {selection.track}</strong><span className={'program-status-badge'+(programState.enrolled.some(p=>p.level_id===selection.level_id)?'':' pending')}>{programState.enrolled.some(p=>p.level_id===selection.level_id)?'Course enrolled':'Program selected'}</span><p>{programState.enrolled.some(p=>p.level_id===selection.level_id)?'Your enrolled learning space':'Explore shared practice. The institute will confirm course and batch enrollment separately.'}</p></div><a href="/dashboard/student/program">Switch program</a></section>}
 {programState?.setupRequired&&<p className="student-program-backend-note">Program selection is being prepared. Your existing courses, tests and results remain available.</p>}
 {missingProfile?<section className="student-panel student-profile-message"><GraduationCap size={40}/><h2>Profile Incomplete</h2><p>Your account has been created, but your student profile is not yet fully set up. Please contact the institute to complete your account setup. Course enrollment is separate.</p><button className="student-primary" onClick={()=>setRetry(x=>x+1)}>Retry account setup</button></section>:<>
 <StudentLearningCards learning={learning} search={search}/>
 <section className="student-panel student-available" id="student-tests" aria-label="Available tests"><div className="student-panel-heading"><div><h2><ClipboardCheck size={21}/>Available tests</h2><p>Published papers for your selected program. Start here or continue an unfinished test.</p></div><button className="student-secondary" disabled={loading} onClick={()=>setRetry(x=>x+1)}>Refresh tests</button></div>
 {loading?<p className="student-empty" role="status">Loading available tests…</p>:error?<div className="student-empty"><p>Tests could not be loaded.</p><button className="student-primary" onClick={()=>setRetry(x=>x+1)}>Retry tests</button></div>:<>
 {activeAttempts.length>0&&<div className="student-resume"><h4>Continue your test</h4>{activeAttempts.map(a=><div key={a.id}><div><h4>{a.tests?.name||'Test in progress'}</h4><p>{a.tests?.exams?.name}</p></div><a className="student-secondary" href={'/test/'+a.test_id+'/attempt'}>Resume test <ArrowRight size={14}/></a></div>)}</div>}
 <div className="student-available-grid">{tests.map(t=><article key={t.id}><span className="student-badge">Ready to start</span><h4>{t.name}</h4><p>{t.exams?.name}</p><p className="student-label">{[questionCounts[t.id]&&questionCounts[t.id]+(questionCounts[t.id]===1?' question':' questions'),t.duration_minutes&&t.duration_minutes+' minutes',t.total_marks!=null&&(Number(t.total_marks)===1?'1 mark':t.total_marks+' marks')].filter(Boolean).join(' · ')}</p><a className="student-secondary" href={'/test/'+t.id+'/instructions'}>Start test <ArrowRight size={14}/></a></article>)}</div>
 {!tests.length&&!activeAttempts.length&&<div className="student-empty"><ClipboardCheck size={31}/><h4>{programTests.length||inProgress.length?'No tests match your search':'No tests to start yet'}</h4><p>{programTests.length||inProgress.length?'Try another test name.':'Your admin or teacher will publish tests for this program here.'}</p></div>}
 </>}</section>
 <section className="student-panel student-results" id="student-results" aria-label="Finished tests"><div className="student-panel-heading"><h2><Trophy size={21}/>Finished tests</h2><span className="student-label">{loading?'':error?'':completed.length+' completed'+(selection?' · '+selection.program:'')}</span></div>{loading?<p className="student-empty" role="status">Loading completed tests…</p>:error?<p className="student-empty">Results are unavailable until tests finish loading.</p>:results.length?<div className="student-result-list">{results.map(a=><a key={a.id} href={'/test/'+a.test_id+'/result'}><span className="student-result-icon"><Trophy size={19}/></span><div><h4>{a.tests?.name||'Completed test'}</h4><p>{a.submitted_at?new Date(a.submitted_at).toLocaleDateString('en-IN'):'Completed'}</p></div><span className="student-score">{resultValue(a.score)} / {resultValue(a.max_score)}</span><span className="student-result-action">View result →</span></a>)}</div>:<div className="student-empty"><Trophy size={31}/><h4>{completed.length?'No results match your search':'Your progress starts with a try'}</h4><p>{completed.length?'Try another test name.':"You haven't completed any tests yet."}</p></div>}</section>
 {search&&<p className="student-search-note" role="status">Showing courses and tests matching “{search}”. <button onClick={()=>setSearch('')}>Clear search</button></p>}
 {error&&<section className="student-panel student-error" role="alert"><h3>Could not load tests and results</h3><p>{error}</p><button className="student-primary" onClick={()=>setRetry(x=>x+1)}>Retry tests and results</button></section>}
 </>}
 </StudentPortalLayout>
}
