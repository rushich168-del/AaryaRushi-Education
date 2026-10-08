import {useEffect,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {staffAccountService} from '../../services/staffAccountService.js'
import ReadyPaperTransfer from './ReadyPaperTransfer.jsx'
import './exam-library.css'
import {navigateTo} from '../../utils/routes.js'
import './staff.css'
import brand from '../../config/brand.js'
export default function TestCreatorWorkspace(){
 const {user,signOut}=useAuth()
 const [exams,setExams]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false)
 useEffect(()=>{let active=true;setExams(null);setError('');staffAccountService.creatorExams().then(data=>{if(active)setExams(data)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[user?.id,retry])
 async function exit(){if(busy)return;setBusy(true);try{const response=await signOut();if(response?.error)throw response.error;navigateTo('/testcreator/login')}catch{setError('Sign out failed. Please retry.');setBusy(false)}}
 return <div className="staff-workspace"><header className="staff-workspace-header"><div><h1>{brand.shortName} Test Creator Portal</h1><p>{user?.email} · Test Creator</p></div><button disabled={busy} className="staff-button staff-button-light" onClick={exit}>{busy?'Signing out…':'Sign out / switch account'}</button></header><main className="staff-workspace-content">
  <p className="staff-eyebrow">YOUR EXAMS. CLEAR RESPONSIBILITIES.</p><h2>My exam access</h2><p className="staff-subtitle">Your administrator controls the exams assigned to your creator account. Teacher tools and student publishing require separate permissions.</p>
  {error&&<p role="alert" className="staff-error">{error} <button className="staff-link" onClick={()=>setRetry(x=>x+1)}>Retry</button></p>}
  {!exams&&!error?<p role="status">Loading assigned exams…</p>:exams?.length?<div className="staff-grid">{exams.map(exam=><section className="staff-card" key={exam.id}><h3>{exam.name}</h3><p>Assigned for test preparation</p></section>)}</div>:exams&&<section className="staff-card"><h3>No exams assigned</h3><p>Ask your administrator to assign an exam before preparing institute papers.</p></section>}
  <section className="staff-card" style={{marginTop:24}}><h3>Prepare a paper</h3><p>Import and correct your paper, add its answers, and save a ready version. Then connect it to an assigned institute program below.</p><a href="/dashboard/testcreator/prepare" className="staff-button">Prepare a paper</a></section>
  {exams?.length>0&&<ReadyPaperTransfer exams={exams} creator/>}
 </main></div>
}
