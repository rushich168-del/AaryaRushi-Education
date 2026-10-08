import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createStaffHandler} from '../supabase/functions/edu-staff-accounts/handler.mjs'
import {passwordChecks} from '../supabase/functions/edu-staff-accounts/validation.mjs'
const actor='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333'
const fixturePassword='Synthetic!Password123'

test('creator create uses scoped trusted operation; invalid roles and missing exams never create an identity',async()=>{
 const f=fixture(),r=await f.post({...create(),role:'creator',exams:[target],courses:[],batches:[]});
 assert.equal(r.body.created,true);assert.ok(f.calls.includes('ksc_creator_begin_create'));assert.ok(!f.calls.includes('ksc_staff_begin_create'));
 for(const bad of [{role:'admin',exams:[target]},{role:'creator',exams:[]},{role:'creator',exams:['bad']},{role:'creator',exams:[target],courses:[target]}]){
  const rejected=fixture();assert.equal((await rejected.post({...create(),courses:[],batches:[],...bad})).status,400);assert.deepEqual(rejected.calls,[]);
 }
 const denied=fixture({notAdmin:true});assert.equal((await denied.post({...create(),role:'creator',exams:[target],courses:[],batches:[]})).status,409);assert.deepEqual(denied.calls,['ksc_creator_begin_create']);
 const missing=fixture({creatorMissing:true});assert.equal((await missing.post({...create(),role:'creator',exams:[target],courses:[],batches:[]})).status,503);assert.deepEqual(missing.calls,['ksc_creator_begin_create']);
});

test('manual password validation identifies the missing rule and never echoes credentials',async()=>{
 const f=fixture();const custom='manualpassword123!';
 const rejected=await f.post({...create(),password:custom,courses:[],batches:[]});
 assert.equal(rejected.status,400);assert.match(rejected.body.fieldErrors.password,/uppercase/);
 assert.equal(rejected.body.fieldErrors.assignments,undefined);assert.ok(!JSON.stringify(rejected.body).includes(custom));
 assert.deepEqual(f.calls,[]);
 const accepted=await f.post({...create(),password:'CustomPassword123!',courses:[],batches:[]});
 assert.equal(accepted.body.created,true);
 assert.equal(passwordChecks('CustomPassword123!').every(c=>c.valid),true);
});

test('creation validation distinguishes identity, email and request errors from a password error',async()=>{
 for(const [field,value] of [['request_id','invalid'],['name',' '],['email','bad-email'],['courses',['bad-course']]]){
  const f=fixture(),r=await f.post({...create(),[field]:value});assert.equal(r.status,400);
  assert.ok(r.body.fieldErrors[field==='courses'?'assignments':field]);assert.equal(r.body.fieldErrors.password,undefined);assert.deepEqual(f.calls,[]);
 }
 const f=fixture();assert.equal((await f.post({...create(),email:' qa@ksc.local '})).body.created,true);
});
function fixture(options={}){
 const calls=[]
 const publicClient={auth:{getUser:async()=>options.unauthenticated?{error:{}}:{data:{user:{id:actor,email:'admin@ksc.local'}}},signInWithPassword:async details=>{calls.push('reauth');return options.badCurrent?{error:{}}:{data:{user:{id:actor}}}}}}
 const adminClient={rpc:async(name,args)=>{
  calls.push(name)
  if(options.creatorMissing&&name==='ksc_creator_begin_create')return {error:{code:'PGRST202'}}
  if(options.notAdmin&&['ksc_staff_begin_create','ksc_creator_begin_create'].includes(name))return {error:{message:'Administrator access required'}}
  if(options.failComplete&&name==='ksc_staff_complete_create')return {error:{message:'Setup failure'}}
  if(options.failPasswordComplete&&name==='ksc_staff_password_complete')return {error:{message:'Account changed during password setup'}}
  if(['ksc_staff_begin_create','ksc_creator_begin_create'].includes(name))return {data:{state:options.repeated?'complete':'prepared',target_id:target}}
  if(name==='ksc_staff_created_identity')return {data:options.recovered?target:null}
  if(name==='ksc_staff_complete_create')return {data:{created:true,id:target}}
  if(name==='ksc_staff_password_gate')return {data:{version:7}}
  return {data:null}
 },auth:{admin:{
  createUser:async input=>{calls.push('createAuth');assert.ok(input.app_metadata.ksc_staff_request);assert.equal(input.user_metadata,undefined);return options.duplicate?{error:{}}:{data:{user:{id:target}}}},
  updateUserById:async(id,input)=>{calls.push('updateAuth');return options.failAuthUpdate?{error:{}}:{data:{user:{id}}}},
 }}}
 const handle=createStaffHandler({publicClient,adminClient,allowedOrigins:['http://127.0.0.1:5173'],rateLimit:async()=>!options.rateLimited})
 const post=async body=>{
  const response=await handle(new Request('http://service.test',{method:'POST',headers:{origin:'http://127.0.0.1:5173',authorization:'Bearer synthetic-test-token','content-type':'application/json'},body:JSON.stringify(body)}))
  return {status:response.status,body:await response.json()}
 }
 return {handle,post,calls}
}
const create=()=>({action:'create',request_id:requestId,name:'QA Teacher',email:'teacher@ksc.local',password:fixturePassword,courses:[],batches:[]})
test('unauthenticated and non-admin calls never create Auth identities',async()=>{
 for(const flags of [{unauthenticated:true},{notAdmin:true}]){const f=fixture(flags);const response=await f.post(create());assert.ok(response.status>=400);assert.ok(!f.calls.includes('createAuth'))}
})
test('create completes database setup before success; secret is never returned',async()=>{
 const f=fixture();const r=await f.post(create());assert.equal(r.status,200);assert.equal(r.body.created,true)
 assert.deepEqual(f.calls,['ksc_staff_begin_create','ksc_staff_created_identity','createAuth','ksc_staff_complete_create'])
 assert.ok(!JSON.stringify(r.body).includes(fixturePassword))
})
test('duplicate account never resets an existing password',async()=>{
 const f=fixture({duplicate:true});const r=await f.post(create());assert.equal(r.status,409);assert.ok(!f.calls.includes('updateAuth'));assert.ok(!f.calls.includes('ksc_staff_complete_create'))
})
test('partial provisioning returns failure; retry recovers only operation-stamped identity',async()=>{
 const f=fixture({failComplete:true});assert.ok((await f.post(create())).status>=400)
 const recovered=fixture({recovered:true});assert.equal((await recovered.post(create())).body.created,true);assert.ok(!recovered.calls.includes('createAuth'));assert.ok(recovered.calls.includes('updateAuth'))
})
test('completed idempotent retry never regenerates or resets a credential',async()=>{
 const f=fixture({repeated:true});const r=await f.post(create());assert.equal(r.body.repeated,true);assert.deepEqual(f.calls,['ksc_staff_begin_create'])
})
test('password setup requires current credential and server-confirmed Auth update',async()=>{
 const input={action:'change_password',current_password:'Synthetic!Temporary123',new_password:fixturePassword}
 const invalid=fixture({badCurrent:true});assert.equal((await invalid.post(input)).status,403);assert.ok(!invalid.calls.includes('updateAuth'))
 const f=fixture();assert.equal((await f.post(input)).body.changed,true);assert.deepEqual(f.calls,['reauth','ksc_staff_password_gate','updateAuth','ksc_staff_password_complete'])
})
test('failed Auth update never clears the academic-access gate',async()=>{
 const f=fixture({failAuthUpdate:true});const r=await f.post({action:'change_password',current_password:'Synthetic!Temporary123',new_password:fixturePassword});assert.ok(r.status>=400);assert.ok(!f.calls.includes('ksc_staff_password_complete'))
})
test('failed database completion never reports a successful password change',async()=>{
 const f=fixture({failPasswordComplete:true});const r=await f.post({action:'change_password',current_password:'Synthetic!Temporary123',new_password:fixturePassword});assert.ok(r.status>=400);assert.equal(r.body.changed,undefined)
})
test('temporary reissue locks staff access before changing Auth and releases operation after success',async()=>{
 const f=fixture();assert.equal((await f.post({action:'temporary_password',user_id:target,version:2,password:fixturePassword})).body.reset,true)
 assert.deepEqual(f.calls,['ksc_staff_password_gate','updateAuth','ksc_staff_password_release'])
})
test('origin, methods, oversized input, weak passwords and rate limits fail closed',async()=>{
 const f=fixture()
 const rejected=await f.handle(new Request('http://service.test',{method:'POST',headers:{origin:'https://other.test'}}));assert.equal(rejected.status,403)
 assert.equal((await fixture({rateLimited:true}).post(create())).status,429)
 assert.equal((await f.post({...create(),password:'weak'})).status,400)
 assert.equal((await f.post({...create(),name:'x'.repeat(20000)})).status,413)
 const get=await f.handle(new Request('http://service.test',{headers:{origin:'http://127.0.0.1:5173'}}));assert.equal(get.status,405)
})
