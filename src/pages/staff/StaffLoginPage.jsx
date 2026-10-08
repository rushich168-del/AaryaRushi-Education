import {useEffect,useRef,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {navigateTo} from '../../utils/routes.js'
import {getAuthError} from '../../utils/authErrors.js'
import StaffGate from '../../components/auth/StaffGate.jsx'
import './staff.css'
import brand from '../../config/brand.js'
function Landing({role}){useEffect(()=>{const paper=new URLSearchParams(window.location.search).get('paper');const connect=paper&&/^[0-9a-f-]{36}$/i.test(paper)?'?view=library&connect='+encodeURIComponent(paper):'';navigateTo(role==='admin'?'/dashboard/admin/overview':role==='creator'?'/dashboard/testcreator/prepare'+connect:'/dashboard/teacher')},[role]);return <p role="status">Opening your portal…</p>}
export default function StaffLoginPage({role}){
 const {session,loading,signIn,signOut,isConfigured}=useAuth()
 const [acceptedUserId,setAcceptedUserId]=useState(null)
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const lock=useRef(false)
 const admin=role==='admin',creator=role==='creator'
 async function submit(e){
  e.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('')
  try{
   if(!isConfigured)throw new Error('Account service is not configured in this environment yet.')
   const response=await signIn(email.trim(),password)
   if(response.error)throw response.error
   if(!response.data?.session)throw new Error('Sign in did not establish a session. Please retry.')
   setAcceptedUserId(response.data.session.user.id)
   setPassword('')
  }catch(error){setError(getAuthError(error,'Sign in failed. Check your email and password.'))}
  finally{lock.current=false;setBusy(false)}
 }
 async function switchAccount(){
  if(lock.current)return;lock.current=true;setBusy(true);setError('')
  try{
   const response=await signOut()
   if(response?.error)throw response.error
   setAcceptedUserId(null);setEmail('');setPassword('')
  }catch(error){setError(getAuthError(error,'Could not sign out. Please retry.'))}
  finally{lock.current=false;setBusy(false)}
 }
 if(loading)return <main className="staff-status" role="status">Checking session…</main>
 if(session&&(!creator||acceptedUserId===session.user.id))return <StaffGate role={role}><Landing role={role}/></StaffGate>
 const content=<main className="staff-login-page"><div className="staff-login-shell">
  <aside className="staff-login-story"><a href="/" className="staff-brand">{brand.initials} <span>{brand.name}</span></a><p className="staff-eyebrow">{brand.tagline}</p><h1>{admin?'Lead with clarity.':creator?'Prepare with precision.':'Teach with purpose.'}</h1><p>{admin?'Manage your team, assign access, and keep the institute organised.':creator?'Prepare and correct papers for your assigned exams. Finished papers connect to the teacher exam library.':'Your assigned courses, students and teaching tools, in one focused workspace.'}</p><span className="staff-story-note">One account. Clear responsibilities.</span></aside>
  <section className="staff-login-form"><p className="staff-eyebrow">{admin?'ADMINISTRATOR':creator?'TEST CREATOR':'TEACHER'} PORTAL</p><h2>{admin?'Admin Login':creator?'Test Creator Login':'Teacher Login'}</h2><p>{session?'You’re already signed in. Continue with this account or switch to another.':'Use your institute-approved email and password.'}</p>
   {session?<div className="staff-form">
    <div className="staff-login-help"><strong>Signed in as</strong><p className="staff-account-email">{session.user.email}</p></div>
    {error&&<p className="staff-error" role="alert">{error}</p>}
    <button type="button" disabled={busy} className="staff-button" onClick={()=>setAcceptedUserId(session.user.id)}>Continue to paper preparation →</button>
    <button type="button" disabled={busy} className="staff-button staff-button-light" onClick={switchAccount}>{busy?'Signing out…':'Switch account'}</button>
   </div>:<>
   <form onSubmit={submit} className="staff-form">
    <label>Email address<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label>
    <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
    {error&&<p className="staff-error" role="alert">{error}</p>}
    <button disabled={busy} className="staff-button">{busy?'Signing in…':'Sign in securely →'}</button>
   </form>
   <a href={`/forgot-password?portal=${admin?'admin':creator?'testcreator':'teacher'}`} className="staff-link">Forgot password?</a>
   </>}
   <div className="staff-login-help">{admin?<><strong>First time setting up the institute?</strong><p>Use your existing account. The one-time owner setup enables administrator permission; signing up alone does not grant it.</p><a className="staff-link" href="/admin/setup">Set up the first administrator →</a></>:creator?'Your administrator creates your Test Creator account and assigns exams. Change your temporary password on first use.':'Your administrator creates your account and assigns your courses. A temporary password must be changed on first use.'}</div>
   <a href="/" className="staff-link">← Back to homepage</a>
  </section>
 </div></main>
 return session?<StaffGate role={role}>{content}</StaffGate>:content
}

