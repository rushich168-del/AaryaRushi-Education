import {useRef,useState} from 'react'
import {ArrowRight,UserRound} from 'lucide-react'
import {useAuth} from '../context/AuthContext.jsx'
import {getAuthError} from '../utils/authErrors.js'
import ProgramOnboardingShell from '../components/site/ProgramOnboardingShell.jsx'

export default function LoginPage(){
 const {user,signIn,signOut,isConfigured}=useAuth()
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const submitting=useRef(false)
 async function submit(event){
  event.preventDefault();if(submitting.current)return
  setError('');if(!isConfigured){setError('Student sign-in is not available yet. Please try again later.');return}
  submitting.current=true;setBusy(true)
  try{
   const {data,error:failure}=await signIn(email.trim(),password)
   if(failure)throw failure
   if(!data?.session)throw Error('Sign in failed. No active session established.')
   setPassword('')
  }catch(e){setError(getAuthError(e,'Sign in could not be completed. Please retry.'))}
  finally{submitting.current=false;setBusy(false)}
 }
 async function switchAccount(){
  if(busy)return;setBusy(true);setError('')
  try{const response=await signOut();if(response?.error)throw response.error;setEmail('');setPassword('')}
  catch{setError('Sign out failed. Please retry.')}finally{setBusy(false)}
 }
 return <ProgramOnboardingShell step={3} login>
 <section className="program-account-form"><h2>Student Login</h2><p>One account for all your programs. Sign in with the email you registered.</p>
 {user?<div className="program-current-account"><UserRound size={30}/><h3>A student account is already signed in</h3><p>This browser is currently using <strong>{user.email}</strong>.</p><a className="program-primary" href="/dashboard/student">Continue with this account <ArrowRight size={16}/></a><button type="button" className="program-text-button" disabled={busy} onClick={switchAccount}>{busy?'Signing out…':'Use a different student account'}</button></div>:<form onSubmit={submit}>
 <label>Email<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label>
 <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
 <button type="submit" className="program-primary" disabled={busy||!isConfigured}>{busy?'Signing in…':'Sign in'}<ArrowRight size={16}/></button>
 </form>}
 {error&&<div className="program-error" role="alert">{error}</div>}
 {!user&&<p className="program-notice">Newly registered? Confirm your email before signing in. Your program selection stays with that account.</p>}
 <div className="program-onboarding-actions"><a className="program-text-button" href="/forgot-password">Forgot password?</a><a className="program-text-button" href="/signup">Create a student account</a></div>
 </section>
 </ProgramOnboardingShell>
}
