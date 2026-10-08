import {takeReturnPath} from '../services/paymentService.js'
import {useEffect,useRef,useState} from 'react'
import {CheckCircle2,ArrowRight} from 'lucide-react'
import {useAuth} from '../context/AuthContext.jsx'
import {navigateTo} from '../utils/routes.js'
import {getAuthError} from '../utils/authErrors.js'
import {studentProgramService as service} from '../services/studentProgramService.js'
import ProgramOnboardingShell from '../components/site/ProgramOnboardingShell.jsx'
import ProgramChoice from '../components/site/ProgramChoice.jsx'
import brand from '../config/brand.js'

export default function SignupPage(){
 const {signUp,isConfigured}=useAuth()
 const [catalogue,setCatalogue]=useState(null),[catalogueError,setCatalogueError]=useState(''),[retry,setRetry]=useState(0)
 const [choice,setChoice]=useState({exam:'',level:''}),[account,setAccount]=useState(false)
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState('')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false)
 const submitting=useRef(false)
 const requestedApplied=useRef(false)
 useEffect(()=>{
  let active=true;setCatalogue(null);setCatalogueError('')
  if(!isConfigured){setCatalogueError('Account creation is not available yet. Please try again later.');return()=>{active=false}}
  service.catalogue().then(data=>{if(active){setCatalogue(data);if(!requestedApplied.current){requestedApplied.current=true;const slug=new URLSearchParams(window.location.search).get('program');const requested=data.programs.find(p=>p.slug===slug);if(requested)setChoice({exam:requested.id,level:''})}}}).catch(e=>{if(active)setCatalogueError(e.message)})
  return()=>{active=false}
 },[isConfigured,retry])
 const program=catalogue?.programs?.find(p=>p.id===choice.exam),track=program?.tracks.find(t=>t.id===choice.level)
 async function submit(event){
  event.preventDefault();if(submitting.current)return
  setError('');if(!name.trim()){setError('Enter the student’s full name.');return}
  if(!program||!track){setError('Choose a valid program and preparation track.');setAccount(false);return}
  submitting.current=true;setBusy(true)
  try{
   // Recheck availability before creating an identity; metadata is a preference hint, never an access grant.
   const latest=await service.catalogue()
   if(!latest.programs.some(p=>p.id===choice.exam&&p.tracks.some(t=>t.id===choice.level))){setCatalogue(latest);setAccount(false);setChoice({exam:'',level:''});throw Error('This program is no longer open for registration. Please choose an available program.')}
   const {data,error:signupError}=await signUp(email.trim(),password,{name:name.trim(),level:choice.level})
   if(signupError)throw signupError
   if(data?.session){setPassword('');navigateTo(takeReturnPath());return}
   if(data?.user?.identities?.length===0)throw Error('Unable to create this account. Sign in if you already registered.')
   if(!data?.user)throw Error('Account creation was not confirmed. Please retry.')
   setPassword('');setConfirmed(true)
  }catch(e){setError(getAuthError(e,'Account creation could not be completed. Please retry.'))}
  finally{submitting.current=false;setBusy(false)}
 }
 return <ProgramOnboardingShell step={account||confirmed?3:choice.exam?2:1}>
 {confirmed?<div className="program-confirmation"><CheckCircle2 size={45}/><h2>Check your email</h2><p>We’ve saved your chosen preparation track with your registration. Confirm your email, then sign in to continue.</p><div className="program-account-summary"><div><strong>{program?.name}</strong>{track?.name}</div></div><p>Check your inbox and spam folder. If the confirmation email does not arrive, contact {brand.name}. Already registered? Use your existing account.</p><a href="/login" className="program-primary">Go to Student Login <ArrowRight size={16}/></a></div>:<>
 {catalogueError?<div className="program-error" role="alert">{catalogueError}<button onClick={()=>setRetry(x=>x+1)}>Retry program list</button></div>:!catalogue?<p className="program-onboarding-loading" role="status">Loading programs…</p>:!account?<ProgramChoice programs={catalogue.programs} value={choice} onChange={setChoice} onContinue={()=>{setError('');setAccount(true)}}/>:<section className="program-account-form"><h2>Create your student account</h2><p>Your learning journey starts with one account.</p><div className="program-account-summary"><div><strong>{program?.name}</strong>{track?.name}</div><button className="program-text-button" disabled={busy} onClick={()=>setAccount(false)}>Edit selection</button></div><form onSubmit={submit}><label>Student full name<input required maxLength={200} autoComplete="name" value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label><label>Email<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label><label>Password<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/><span className="text-xs font-normal text-slate-500">Use at least 8 characters.</span></label><button className="program-primary" disabled={busy}>{busy?'Creating your account…':'Create student account'}<ArrowRight size={16}/></button></form></section>}
 {error&&<div className="program-error" role="alert">{error}</div>}
 <p className="program-notice">Your selected program personalizes your workspace. Enrollment in a course or batch is confirmed separately by the institute.</p>
 </>}
 </ProgramOnboardingShell>
}
