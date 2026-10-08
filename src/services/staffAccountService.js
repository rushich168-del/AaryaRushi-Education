import { supabase } from '../lib/supabaseClient.js'
const setupCodes = ['PGRST202','PGRST205','42P01','42883']
async function timed(operation) {
 let timer
 try { return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The account service took too long. Refresh the account status before retrying.')),15000)})]) }
 finally { clearTimeout(timer) }
}
export async function staffResult(operation) {
 const {data,error}=await timed(operation)
 if(error){if(setupCodes.includes(error.code)){const setupError=new Error('Your sign-in worked. The staff backend has not been enabled yet. The first administrator must be set up before this portal can open.');setupError.code='STAFF_SETUP_REQUIRED';throw setupError}throw new Error(error.message || 'That step could not finish. Please retry.')}
 return data
}
export const staffAccountService={
 access:()=>staffResult(supabase.rpc('ksc_my_access')),
 list:()=>staffResult(supabase.rpc('ksc_staff_list')),
 creatorSetup:()=>staffResult(supabase.rpc('ksc_creator_setup')),
 creatorExams:()=>staffResult(supabase.rpc('ksc_my_creator_exams')),
 creatorAssignments:(person,exams)=>staffResult(supabase.rpc('ksc_creator_assign',{p_user:person.id,p_exams:exams,p_version:person.version})),
 courses:()=>staffResult(supabase.rpc('ksc_teaching_courses')),
 resultReview:attempt=>staffResult(supabase.rpc('ksc_teaching_result_review',{p_attempt:attempt})),
 deleteResult:attempt=>staffResult(supabase.rpc('ksc_delete_student_result',{p_attempt:attempt})),
 results:()=>staffResult(supabase.rpc('ksc_teaching_results')),
 assignments:(person,courses,batches)=>staffResult(supabase.rpc('ksc_staff_assign',{p_user:person.id,p_courses:courses,p_batches:batches,p_version:person.version})),
 state:(person,state)=>staffResult(supabase.rpc('ksc_staff_set_state',{p_user:person.id,p_state:state,p_version:person.version})),
 async grantExisting(email,name,courses,batches,role='teacher',exams=[]){
  const id=await staffResult(supabase.rpc('ksc_staff_lookup_existing',{p_email:email.trim().toLowerCase()}))
  return staffResult(supabase.rpc(role==='creator'?'ksc_creator_grant_existing':'ksc_staff_grant_existing',{p_user:id,p_email:email,p_name:name,...(role==='creator'?{p_exams:exams}:{p_courses:courses,p_batches:batches})}))
 },
 async action(body){
  const {data,error}=await timed(supabase.functions.invoke('edu-staff-accounts',{body}))
  if(error){
   let message='The staff account service is unavailable. Check setup and retry.',fieldErrors
   try{const details=await error.context?.json();if(details?.error)message=details.error;fieldErrors=details?.fieldErrors}catch{}
   const failure=new Error(message);if(fieldErrors)failure.fieldErrors=fieldErrors;throw failure
  }
  if(data?.error)throw new Error(data.error)
  if(!data || (!data.created && !data.changed && !data.reset))throw new Error('Account operation was not confirmed. Retry before sharing credentials.')
  return data
 },
}
export function temporaryPassword(){
 const values=crypto.getRandomValues(new Uint32Array(15))
 const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*'
 return 'Ksc!7'+Array.from(values,x=>alphabet[x%alphabet.length]).join('')
}
export const teacherCourse = () => new URLSearchParams(window.location.search).get('course')
export const inTeacherWorkspace = () => window.location.pathname.startsWith('/dashboard/teacher') || window.location.pathname.startsWith('/dashboard/admin/teaching')
