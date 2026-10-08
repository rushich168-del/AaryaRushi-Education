import {createContext,useContext,useEffect,useState} from 'react'
import {useAuth} from '../../context/AuthContext.jsx'
import {studentProgramService as service,programOptions} from '../../services/studentProgramService.js'
import ProgramOnboardingShell from '../site/ProgramOnboardingShell.jsx'
import ProgramChoice from '../site/ProgramChoice.jsx'
import {navigateTo} from '../../utils/routes.js'
const ProgramContext=createContext(null)
export const useStudentProgram=()=>useContext(ProgramContext)
export default function StudentProgramGate({children}){
 const {user,signOut}=useAuth()
 const [record,setRecord]=useState(null),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false)
 const uid=user?.id
 useEffect(()=>{
  let active=true;setRecord(null)
  if(!uid)return()=>{active=false}
  async function load(){
   try{
    let state=await service.state()
    if(!active)return
    if(!state.selection&&state.suggested_level_id){state=await service.select(state.suggested_level_id,0,uid);if(!active)return}
    setRecord({uid,state})
   }catch(error){if(active)setRecord({uid,error:error.message,setupRequired:error.setupRequired})}
  }
  load();return()=>{active=false}
 },[uid,revision])
 const current=record?.uid===uid?record:null
 if(!uid||!current)return <main className="staff-status" role="status">Opening your learning workspace…</main>
 // Compatibility with the installed baseline until the reviewed forward migration is activated.
 if(current.setupRequired)return <ProgramContext.Provider value={{setupRequired:true}}>{children}</ProgramContext.Provider>
 if(current.error)return <ProgramOnboardingShell existing><div className="program-error" role="alert">{current.error}</div><button className="program-primary" onClick={()=>setRevision(x=>x+1)}>Retry program setup</button><button className="program-text-button" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await signOut();if(r?.error)throw r.error;navigateTo('/login')}catch{setRecord({...current,error:'Sign out failed. Please retry.'});setBusy(false)}}}>Switch account</button></ProgramOnboardingShell>
 const changing=window.location.pathname==='/dashboard/student/program'
 if(!current.state.selection?.available||changing)return <StudentProgramSetup key={uid} state={current.state} onRefresh={()=>setRevision(x=>x+1)} onSaved={state=>{setRecord({uid,state});navigateTo('/dashboard/student')}}/>
 return <ProgramContext.Provider value={current.state}>{children}</ProgramContext.Provider>
}
function StudentProgramSetup({state,onSaved,onRefresh}){
 const {user,signOut}=useAuth()
 const [catalogue,setCatalogue]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [choice,setChoice]=useState({exam:'',level:''})
 useEffect(()=>{let active=true;setCatalogue(null);setError('');service.catalogue().then(c=>{if(active)setCatalogue(c)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[])
 const rows=[...state.enrolled,...(state.memberships||[]).filter(m=>m.available),...(state.selection?.available?[{exam_id:state.selection.exam_id,level_id:state.selection.level_id,program:state.selection.program,track:state.selection.track}]:[])]
 async function save(){
  if(busy)return;setBusy(true);setError('')
  try{onSaved(await service.select(choice.level,state.selection?.version||0,user.id))}catch(e){setError(e.message)}finally{setBusy(false)}
 }
 return <ProgramOnboardingShell existing step={choice.exam?2:1}>{state.memberships?.length>0&&<section className="program-saved-memberships"><h2>My preparation programs</h2><p>Keep multiple programs in one account. Switch the active workspace without losing another program.</p>{state.memberships.map(m=><button key={m.level_id} type="button" className="program-text-button" disabled={busy||!m.available} onClick={()=>setChoice({exam:m.exam_id,level:m.level_id})}>{m.program} · {m.track}{m.level_id===state.selection?.level_id?' · Current':' · Select'}</button>)}</section>}<p className="program-notice">{state.selection?.available?'Switch your preparation workspace. Your enrollments, test history and results stay with your account.':state.selection?'Your previous program is currently unavailable. Choose an available program; your past results are preserved.':'Choose your preparation program to complete your student setup.'}</p>{error&&<div className="program-error" role="alert">{error}<button onClick={onRefresh}>Refresh program status</button></div>}{!catalogue?!error&&<p role="status" className="program-onboarding-loading">Loading available programs…</p>:<ProgramChoice programs={programOptions(catalogue,rows)} value={choice} onChange={setChoice} busy={busy} onContinue={save}/>}<p className="program-notice">Selecting a program does not enroll you in a course or batch. Your institute manages access to enrolled lessons.</p><button className="program-text-button" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await signOut();if(r?.error)throw r.error;navigateTo("/login")}catch{setError("Sign out failed. Please retry.");setBusy(false)}}}>Sign out / switch account</button>{state.selection?.available&&<a className="program-text-button" href="/dashboard/student">Keep my current program</a>}</ProgramOnboardingShell>
}
