import {useRef,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {staffAccountService} from '../../services/staffAccountService.js'
import {navigateTo} from '../../utils/routes.js'
import './staff.css'
export default function StaffPasswordPage({expired=false,onComplete,role='teacher'}){
 const {user,signOut}=useAuth()
 const [current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const lock=useRef(false)
 async function submit(e){
  e.preventDefault();if(lock.current)return
  if(password!==confirm)return setError('The new passwords do not match.')
  lock.current=true;setBusy(true);setError('')
  try{await staffAccountService.action({action:'change_password',current_password:current,new_password:password});setCurrent('');setPassword('');setConfirm('');onComplete?.();if(!onComplete)navigateTo('/dashboard')}
  catch(e){setError(e.message)}finally{lock.current=false;setBusy(false)}
 }
 async function exit(){if(busy)return;setBusy(true);try{const response=await signOut();if(response?.error)throw response.error;navigateTo(role==='creator'?'/testcreator/login':role==='admin'?'/admin/login':'/teacher/login')}catch{setError('Sign out failed. Please retry.');setBusy(false)}}
 return <main className="staff-status"><section className="staff-card staff-access-message">
  <p className="staff-eyebrow">FIRST-TIME STAFF SETUP</p><h1>{expired?'Temporary access has expired':'Choose your own password'}</h1><p className="staff-account-email">{user?.email}</p>
  {expired?<p>Ask your administrator for a new temporary password. Your saved work is preserved.</p>:<><p>Complete this step before opening your workspace. Use at least 12 characters, uppercase, lowercase, a number and a symbol.</p>
   <form className="staff-form" onSubmit={submit}><label>Current temporary password<input type="password" required autoComplete="current-password" disabled={busy} value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>New password<input type="password" minLength={12} maxLength={128} required autoComplete="new-password" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label><label>Confirm new password<input type="password" required autoComplete="new-password" disabled={busy} value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>{error&&<p className="staff-error" role="alert">{error}</p>}<button className="staff-button" disabled={busy}>{busy?'Updating password…':'Save password & continue'}</button></form></>}
  {expired&&error&&<p role="alert">{error}</p>}<button disabled={busy} className="staff-link" onClick={exit}>Sign out</button>
 </section></main>
}
