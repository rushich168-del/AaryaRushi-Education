import {useEffect,useState} from 'react'
import TeacherResults from './TeacherResults.jsx'
import StaffWorkspace from './StaffWorkspace.jsx'
import TeacherOverview from './TeacherOverview.jsx'
import AdminOverviewPage from './AdminOverviewPage.jsx'
import StudentRoster from './StudentRoster.jsx'
import {staffAccountService as service} from '../../services/staffAccountService.js'
import LearningPage from '../student/LearningPage.jsx'
import PrintedPaperWorkspace from '../../components/site/PrintedPaperWorkspace.jsx'
import ExamLibraryWorkspace from './ExamLibraryWorkspace.jsx'
import './assignments.css'
export default function TeacherPortalPage({staffRole='teacher',adminView=false}){
 const path=window.location.pathname,base=adminView?'/dashboard/admin/teaching':'/dashboard/teacher'
 const [courses,setCourses]=useState([]),[results,setResults]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const selected=new URLSearchParams(window.location.search).get('course')
 useEffect(()=>{if(path===base||path.endsWith('/library')){setLoading(false);return}let active=true;setLoading(true);setError('')
  Promise.all([service.courses(),(path.endsWith('/results')||path===base)?service.results():Promise.resolve([])]).then(([c,r])=>{if(active){setCourses(c);setResults(r)}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false}
 },[path,retry,base])
 if(adminView&&path===base)return <AdminOverviewPage/>
 let content
 if(path===base)content=<TeacherOverview basePath={base}/>
 else if(error)content=<div className="staff-error" role="alert">{error}<button className="staff-link" onClick={()=>setRetry(x=>x+1)}>Retry</button></div>
 else if(loading)content=<p role="status">Loading {adminView?'institute':'assigned'} work…</p>
 else if(path.endsWith('/library'))content=<ExamLibraryWorkspace adminView={adminView} basePath={base}/>
 else if(path.endsWith('/materials'))content=<LearningPage staff assignedOnly materialsOnly/>
 else if(path.endsWith('/courses'))content=<LearningPage staff assignedOnly={!adminView} materialsOnly={adminView}/>
 else if(path.endsWith('/students'))content=<StudentRoster courses={courses} adminView={adminView} basePath={base}/>
 else if(path.endsWith('/results'))content=<TeacherResults results={results} staffRole={staffRole} basePath={base}/>
 else if(path.endsWith('/paper-tests'))content=<><section className="staff-card library-workflow"><h3>Already have a ready paper?</h3><p>Publish it from the exam library. Select the program and test name, then publish to its students.</p><a className="staff-button" href={base+'/library'}>Publish a test from library →</a></section><h2>Prepare a test for your course</h2><p className="staff-subtitle">Choose a course first. Your paper must use a program linked to that course. Review questions and answers before publishing.</p>{courses.some(c=>c.id===selected)?<><p className="staff-success">Working in: <strong>{courses.find(c=>c.id===selected).name}</strong>. Save your draft before switching courses.</p><PrintedPaperWorkspace/></>:<div className="staff-grid">{courses.map(c=><a className="staff-card" key={c.id} href={base+'/paper-tests?course='+encodeURIComponent(c.id)}><h3>{c.name}</h3><span className="staff-link">Prepare a paper →</span></a>)}</div>}{!courses.length&&<section className="staff-card"><h3>{adminView?'No institute courses yet':'No courses assigned yet'}</h3><p>Your administrator manages courses and batches.</p></section>}</>
 else content=<TeacherOverview courses={courses} results={results} adminView={adminView} basePath={base}/>
 return <StaffWorkspace role={adminView?'admin':'teacher'} accountRole={staffRole} adminView={adminView}>{content}</StaffWorkspace>
}

