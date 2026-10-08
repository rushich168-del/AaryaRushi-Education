import {useEffect,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {staffAccountService} from '../../services/staffAccountService.js'
import {navigateTo} from '../../utils/routes.js'
import StaffPasswordPage from '../../pages/staff/StaffPasswordPage.jsx'
export default function StaffGate({role='teacher',children}) {
 const {user,loading,signOut}=useAuth()
 const [result,setResult]=useState(null),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[exitError,setExitError]=useState('')
 const id=user?.id
 useEffect(()=>{
  let active=true
  if(loading||!id)return()=>{active=false}
  setResult(null)
  staffAccountService.access().then(access=>{if(active)setResult({id,access})}).catch(error=>{if(active)setResult({id,error:error.message,setupRequired:error.code==='STAFF_SETUP_REQUIRED'})})
  return()=>{active=false}
 },[id,loading,retry])
 const current=result?.id===id?result:null
 async function switchAccount(){
  if(busy)return
  setBusy(true);setExitError('')
  try{const response=await signOut();if(response?.error)throw response.error;navigateTo(role==='admin'?'/admin/login':role==='creator'?'/testcreator/login':'/teacher/login')}
  catch{setExitError('Sign out failed. Please retry.');setBusy(false)}
 }
 if(loading||(id&&!current))return <main className="staff-status" role="status">Checking account access…</main>
 if(current?.access){
  const a=current.access
  const matches=((role==='either'&&['teacher','admin','creator'].includes(a.role))||a.role===role||(role==='teacher'&&a.role==='admin'))&&['admin','teacher','creator'].includes(a.role)
  if(matches&&a.state==='active'&&a.password_change_required)return <StaffPasswordPage role={a.role} expired={a.temporary_expired} onComplete={()=>setRetry(x=>x+1)}/>
  if(matches&&a.state==='active'&&!a.password_change_required)return typeof children==='function'?children(a):children
 }
 const account=current?.access
 return <main className="staff-status"><section className="staff-card staff-access-message">
  <p className="staff-eyebrow">{role==='admin'?'ADMINISTRATOR':role==='creator'?'TEST CREATOR':'TEACHER'} ACCESS</p>
  <h1>{current?.setupRequired?'First administrator setup is needed':current?.error?'Could not check staff access':!id?'Sign in to continue':account?.state==='pending'?'Your staff access needs setup':account?.state==='suspended'?'Staff access is suspended':'This account cannot open this portal'}</h1>
  {user?.email&&<p className="staff-account-email">{user.email}</p>}
  <p>{current?.error||(!id?'Use the account provided by your institute.':account?.state==='pending'?'Ask your administrator to activate your account and assign access.':account?.state==='suspended'?'Contact your institute administrator for help.':'Your account permissions do not match this portal. Sign in with the correct staff account.')}</p>
  {exitError&&<p role="alert">{exitError}</p>}
  {current?.setupRequired&&<p>Creating another account or resetting your password will not enable administrator access. Complete the one-time institute setup, then retry.</p>}
  {current?.setupRequired&&<p><a className="staff-link" href="/admin/setup">View first administrator setup</a></p>}
  <div className="staff-actions">{current?.error&&<button className="staff-button" onClick={()=>setRetry(x=>x+1)}>Retry</button>}{id?<button disabled={busy} className="staff-button staff-button-light" onClick={switchAccount}>{busy?'Signing out…':'Switch account'}</button>:<a className="staff-button" href={role==='admin'?'/admin/login':role==='creator'?'/testcreator/login':'/teacher/login'}>Sign in</a>}<a href="/" className="staff-link">Back to homepage</a></div>
 </section></main>
}
