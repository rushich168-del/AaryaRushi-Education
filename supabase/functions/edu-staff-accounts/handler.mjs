// Pure handler with injected transports: tests never call live Auth.
import {validUuid as uuid,strongPassword as strong,passwordError,staffAccountErrors} from './validation.mjs';
class Failure extends Error { constructor(message,status=400){super(message);this.status=status} }
const unwrap = async operation => {
 const {data,error}=await operation
 if(error){
  if(['PGRST202','42883'].includes(error.code))throw new Failure('The staff account service needs its database update before use.',503)
  const safe=/^(Administrator access required|Active staff account required|Temporary access expired|A password operation is already running|Account creation is already running|Account changed|Teacher changed|Choose valid courses|Request changed|Existing identity cannot|Account operation not found)/
  throw new Failure(safe.test(error.message||'')?error.message:'The account operation could not finish. Check the details and retry.',409)
 }
 return data
};
async function body(request){
 const reader=request.body?.getReader();if(!reader)throw new Failure('Enter account details.');
 let size=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw new Failure('Request is too large.',413)}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
 try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new Failure('Enter valid account details.')}
}
export function createStaffHandler({publicClient,adminClient,allowedOrigins,rateLimit}){
 return async request=>{
  const origin=request.headers.get('origin');
  const allowed=allowedOrigins.includes(origin);
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',
   ...(allowed?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
  const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
  if(!allowed)return respond({error:'This application origin is not allowed.'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return respond({error:'Use POST.'},405);
  try{
   const authorization=request.headers.get('authorization')||'';
   if(!authorization.startsWith('Bearer '))throw new Failure('Sign in again to continue.',401);
   const token=authorization.slice(7);
   const {data:verified,error:authError}=await publicClient.auth.getUser(token);
   const actor=verified?.user;
   if(authError||!actor?.id)throw new Failure('Sign in again to continue.',401);
   if(!await rateLimit(actor.id))throw new Failure('Too many requests. Wait a minute and retry.',429);
   if(!(request.headers.get('content-type')||'').includes('application/json'))throw new Failure('Use JSON account details.');
   const input=await body(request);
   if(input.action==='create'){
    const fieldErrors=staffAccountErrors(input);
    if(Object.keys(fieldErrors).length)return respond({error:Object.values(fieldErrors)[0],fieldErrors},400);
    const email=input.email.trim().toLowerCase();
    const creator=input.role==='creator';
    const operation=await unwrap(adminClient.rpc(creator?'ksc_creator_begin_create':'ksc_staff_begin_create',{p_actor:actor.id,p_request:input.request_id,p_email:email,p_name:input.name.trim(),...(creator?{p_exams:input.exams}:{p_courses:input.courses,p_batches:input.batches})}));
    if(operation.state==='complete')return respond({id:operation.target_id,created:true,repeated:true});
    let target=await unwrap(adminClient.rpc('ksc_staff_created_identity',{p_actor:actor.id,p_request:input.request_id}));
    if(!target){
     const {data,error}=await adminClient.auth.admin.createUser({email,password:input.password,email_confirm:true,app_metadata:{ksc_staff_request:input.request_id}});
     if(error||!data?.user?.id)throw new Failure('Account creation failed. If this email already exists, use Grant existing account access. No existing password was changed.',409);
     target=data.user.id;
    }else{
     // Recovery only for an unfinished identity stamped by THIS trusted request.
     // Completed operations returned above never reset an existing credential.
     await unwrap(adminClient.auth.admin.updateUserById(target,{password:input.password}));
    }
    const completed=await unwrap(adminClient.rpc('ksc_staff_complete_create',{p_actor:actor.id,p_request:input.request_id,p_target:target}));
    return respond(completed);
   }
   if(input.action==='change_password'){
    if(!strong(input.new_password)||typeof input.current_password!=='string'||input.current_password===input.new_password)
     throw new Failure('Choose a different password with at least 12 characters, uppercase, lowercase, a number and a symbol.');
    // Never unlock access on a browser-supplied flag. Reauthenticate and update here.
    const {data:login,error:loginError}=await publicClient.auth.signInWithPassword({email:actor.email,password:input.current_password});
    if(loginError||login?.user?.id!==actor.id)throw new Failure('The current password is incorrect.',403);
    const gate=await unwrap(adminClient.rpc('ksc_staff_password_gate',{p_actor:actor.id,p_target:actor.id,p_reset:false}));
    await unwrap(adminClient.auth.admin.updateUserById(actor.id,{password:input.new_password}));
    await unwrap(adminClient.rpc('ksc_staff_password_complete',{p_actor:actor.id,p_version:gate.version}));
    return respond({changed:true});
   }
   if(input.action==='temporary_password'){
    if(!uuid(input.user_id)||!Number.isInteger(input.version))throw new Failure('Choose a teacher and retry.');
    if(!strong(input.password))return respond({error:passwordError(input.password),fieldErrors:{password:passwordError(input.password)}},400);
    // Lock academic access before touching Auth. Partial failure remains blocked.
    const gate=await unwrap(adminClient.rpc('ksc_staff_password_gate',{p_actor:actor.id,p_target:input.user_id,p_reset:true,p_version:input.version}));
    await unwrap(adminClient.auth.admin.updateUserById(input.user_id,{password:input.password}));
    await unwrap(adminClient.rpc('ksc_staff_password_release',{p_actor:actor.id,p_target:input.user_id,p_version:gate.version}));
    return respond({reset:true});
   }
   throw new Failure('Unknown account operation.');
  }catch(error){
   return respond({error:error instanceof Failure?error.message:'The account service is unavailable. Retry later.'},error instanceof Failure?error.status:503);
  }
 };
}

