import {takeReturnPath} from '../../services/paymentService.js'
import {useEffect, useRef, useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {supabase} from '../../lib/supabaseClient.js'
import {navigateTo} from '../../utils/routes.js'
import '../../pages/staff/staff.css'

// A shared Auth session is not evidence that the visitor chose the staff portal.
export default function StudentGate({children, entry=false}) {
 const {user,loading,signOut}=useAuth()
 const [result,setResult]=useState(null),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[exitError,setExitError]=useState('')
 const signedInFromEntry=useRef(false)
 const id=user?.id
 useEffect(()=>{if(entry&&!loading&&!id)signedInFromEntry.current=true},[entry,loading,id])
 useEffect(()=>{
  let active=true
  if(loading||!id)return()=>{active=false}
  setResult(null)
  async function check(){
   try{
    const {data,error}=await supabase.rpc('ksc_my_access')
    let role=data?.role
    if(error){
     if(!['PGRST202','42883'].includes(error.code))throw error
     const fallback=await supabase.rpc('is_teacher')
     if(fallback.error||typeof fallback.data!=='boolean')throw Error('Access unavailable')
     role=fallback.data?'teacher':'student'
    }
    if(!['student','teacher','admin','creator'].includes(role))throw Error('Access unavailable')
    if(active)setResult({id,role})
   }catch{if(active)setResult({id,error:'Could not verify student access. Please retry.'})}
  }
  check();return()=>{active=false}
 },[id,loading,retry])
 const current=result?.id===id?result:null
 const signupEntry=entry&&window.location.pathname==='/signup'
 useEffect(()=>{if(entry&&(signupEntry||signedInFromEntry.current)&&id&&current?.role==='student')navigateTo(takeReturnPath())},[entry,signupEntry,id,current?.role])
 async function switchAccount(){
  setBusy(true);setExitError('')
  try{const response=await signOut();if(response?.error)throw response.error;navigateTo('/login')}
  catch{setExitError('Sign out failed. Please retry.');setBusy(false)}
 }
 if(loading||(id&&!current))return <main className="staff-status" role="status">Checking student access…</main>
 if(!id||current?.role==='student')return signupEntry&&id?<main className="staff-status" role="status">Opening student portal…</main>:children
 return <main className="staff-status"><section className="staff-card staff-access-message"><p className="staff-eyebrow">STUDENT LOGIN</p><h1>{current.error?'Could not check student access':'A staff account is signed in'}</h1><p className="staff-account-email">{user.email}</p><p>{current.error||'To open the student portal, switch to your student account. Your current staff session will stay active until you choose to switch.'}</p>{exitError&&<p role="alert">{exitError}</p>}<div className="staff-actions">{current.error&&<button className="staff-button" onClick={()=>setRetry(x=>x+1)}>Retry</button>}<button className="staff-button" disabled={busy} onClick={switchAccount}>{busy?'Signing out…':'Switch to student account'}</button><a className="staff-link" href="/">Back to homepage</a></div></section></main>
}
