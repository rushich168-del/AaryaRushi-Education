import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir} from 'node:fs/promises'
let browser,bundle,logo
const uid='11111111-1111-4111-8111-111111111111', teacherId='22222222-2222-4222-8222-222222222222',courseId='33333333-3333-4333-8333-333333333333'
before(async()=>{
 logo=await readFile('public/ksc/institute-logo.png')
 bundle=(await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {AuthProvider} from './src/context/AuthContext.jsx';
 import StaffLogin from './src/pages/staff/StaffLoginPage.jsx';import StaffGate from './src/components/auth/StaffGate.jsx';
 import StudentGate from './src/components/auth/StudentGate.jsx';import StudentLogin from './src/pages/LoginPage.jsx';
 import App from './src/App.jsx';
 import Admin from './src/pages/staff/AdminAccountsPage.jsx';import Teacher from './src/pages/staff/TeacherPortalPage.jsx';import Learning from './src/pages/student/LearningPage.jsx';
 import Creator from './src/pages/staff/TestCreatorWorkspace.jsx';import Setup from './src/pages/staff/AdminSetupPage.jsx';
 const Probe=()=>{window.toolsMounted=(window.toolsMounted||0)+1;return <div>Verified staff tools</div>};
 window.mount=screen=>createRoot(document.getElementById('root')).render(<AuthProvider>{
 screen==='app'?<App/>:
 screen==='student-login'?<StudentGate entry><StudentLogin/></StudentGate>:screen==='student-private'?<StudentGate><Probe/></StudentGate>:
 screen==='creator-login'?<StaffLogin role="creator"/>:screen==='creator'?<StaffGate role="creator"><Creator/></StaffGate>:screen==='setup'?<Setup/>:screen==='admin-login'?<StaffLogin role="admin"/>:screen==='teacher-login'?<StaffLogin role="teacher"/>:
 screen==='admin'?<StaffGate role="admin"><Admin/></StaffGate>:screen==='teacher'?<StaffGate role="teacher"><Teacher/></StaffGate>:
 screen==='learning'?<StaffGate role="teacher"><Learning staff assignedOnly/></StaffGate>:<StaffGate role="admin"><Probe/></StaffGate>
 }</AuthProvider>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',
 define:{'import.meta.url':JSON.stringify('http://127.0.0.1:55555/entry.js'),'import.meta.env.DEV':'true','import.meta.env.VITE_PUBLIC_PREVIEW':'"false"'},loader:{'.css':'empty'},
 plugins:[{name:'isolated-auth-transport',setup(b){
  b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'transport',namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`
  export const isSupabaseConfigured=true;const f=()=>window.fixture;
  const query=table=>{let filters={},single=false;const q={insert:row=>{if(table==='ksc_course_tracks'){window.linkedTrack=row;f().links=[...(f().links||[]),row]}return q},select:()=>q,order:()=>q,eq:(key,value)=>{filters[key]=value;return q},single:()=>{single=true;return q},then:resolve=>{let data=table==='ksc_courses'?f().courses||[]:table==='ksc_batches'?f().batches||[]:table==='ksc_lessons'?f().lessons||[]:table==='ksc_enrollments'?f().roster||[]:table==='ksc_lesson_completions'?f().progress||[]:table==='student_profiles'?f().profiles||[]:table==='ksc_course_tracks'?f().links||[]:table==='ksc_institutes'?f().institutes||[]:table==='ksc_staff_access'?(f().people||[]).map(p=>({user_id:p.id,role:p.role})):[];data=data.filter(x=>Object.entries(filters).every(([key,value])=>x[key]===value));return resolve({data:single?data[0]||null:data,error:f().rosterError&&table==='ksc_enrollments'?{message:'Roster unavailable'}:null})}};return q};
  export const supabase={auth:{
   getSession:async()=>({data:{session:f().session||null}}),
   onAuthStateChange:callback=>{window.emitAuth=callback;return {data:{subscription:{unsubscribe(){}}}}},
   signInWithPassword:async details=>{window.signInCalls=(window.signInCalls||0)+1;if(f().signInError)return {error:{message:f().signInError}};const session={user:{id:'11111111-1111-4111-8111-111111111111',email:details.email}};window.emitAuth('SIGNED_IN',session);return {data:{session}}},
   signOut:async()=>{if(f().signOutError)return {error:{message:'Sign out failed'}};window.emitAuth('SIGNED_OUT',null);return {error:null}}},
   from:query,rpc:(name,args)=>{const execute=async()=>{
    if(name==='ksc_my_access'){const captured=f().access;if(f().holdRole)await new Promise(resolve=>window.releaseRole=resolve);return f().roleError?{error:{code:f().roleError,message:'Role unavailable'}}:{data:captured}}
    if(name==='ksc_student_program_state')return f().programState?{data:f().programState}:{error:{code:'PGRST202',message:'Baseline program setup'}};
    if(name==='is_teacher')return {data:f().legacyTeacher??false};
    if(name==='ksc_program_library_deliveries')return {data:f().programDeliveries||[]};if(name==='ksc_publish_program_paper'){window.publishedProgram=args;const paper=f().sharedPapers.find(p=>p.id===args.p_version);const result={id:'program-delivery',version_id:args.p_version,test_id:'program-test',title:args.p_title,exam_id:args.p_exam,program:paper.exam_name,opens_at:new Date().toISOString()};f().programDeliveries=[result];return {data:result}};if(name==='ksc_exam_library_list')return {data:f().sharedPapers||[]};if(name==='ksc_library_deliveries')return {data:f().deliveries||[]};
    if(name==='ksc_save_lesson'){window.savedLesson=args;const lesson={id:args.p_id||'new-lesson',course_id:args.p_course,title:args.p_title,body:args.p_body,sort_order:args.p_order,is_published:args.p_published};f().lessons=[...(f().lessons||[]).filter(l=>l.id!==lesson.id),lesson];return {data:lesson.id}};
    if(name==='ksc_creator_setup')return f().creatorMissing?{error:{code:'PGRST202'}}:{data:f().exams||[]};if(name==='ksc_my_creator_exams')return {data:f().exams||[]};if(name==='ksc_creator_assign'){window.savedExams=args;return {data:null}};if(name==='ksc_staff_lookup_existing')return {data:'22222222-2222-4222-8222-222222222222'};if(name==='ksc_creator_grant_existing'){window.creatorGrant=args;return {data:null}};if(name==='ksc_signup_catalogue')return {data:{programs:f().programs||[]}};if(name==='ksc_enroll_student'){window.enrollment=args;if(f().enrollError)return {error:{message:f().enrollError}};if(!args.p_remove)f().roster=[...(f().roster||[]),{batch_id:args.p_batch,student_id:'learner-id',student_profiles:{full_name:'Learner One'}}];return {data:null}};if(name==='ksc_staff_list')return {data:f().people||[]};if(name==='ksc_teaching_courses')return f().courseError?{error:{message:f().courseError}}:{data:f().courses||[]};if(name==='ksc_teaching_results')return f().resultsError?{error:{message:f().resultsError}}:{data:f().results||[]};if(name==='ksc_delete_student_result'){(window.deletedResults||=[]).push(args.p_attempt);if(f().deleteFailOnce&&window.deletedResults.length===1)return {error:{message:'Connection lost'}};return {data:{attempt_id:args.p_attempt,deleted:true}}};if(name==='ksc_teaching_result_review'){window.reviewRequest=args;return f().reviewError?{error:{message:'Assigned student result access required'}}:{data:f().review}};
    if(name==='ksc_staff_assign'){window.savedAssignments=args;if(f().assignError)return {error:{message:f().assignError}};f().people=f().people.map(p=>p.id===args.p_user?{...p,courses:args.p_courses,batches:args.p_batches,version:p.version+1}:p);return {data:null}};if(name==='ksc_staff_set_state'){window.stateChange=args;return {data:null}};if(name==='ksc_create_course'){window.createdCourse=args;const id='aaaaaaaa-0000-4000-8000-00000000000'+((f().courses||[]).length+1);f().courses=[...(f().courses||[]),{id,name:args.p_name,description:''}];return {data:id}};if(name==='ksc_create_batch'){window.createdBatch=args;const id='bbbbbbbb-0000-4000-8000-00000000000'+((f().batches||[]).length+1);f().batches=[...(f().batches||[]),{id,course_id:args.p_course,name:args.p_name}];return {data:id}};
    throw Error('Unexpected fixture RPC '+name);
   };const request={then:(resolve,reject)=>execute().then(resolve,reject),abortSignal:()=>request};return request;
   },functions:{invoke:async(name,{body})=>{
    window.accountCalls=(window.accountCalls||0)+1;window.accountAction=body.action;window.lastCreate=body;window.createdRole=body.role;window.createdExams=body.exams;
    if(body.action==='create')(window.creationRequests||=[]).push({request_id:body.request_id,email:body.email,name:body.name,exams:body.exams});
    if(f().accountError)return {error:{context:{json:async()=>({error:f().accountError})}}};
    if(body.action==='change_password')f().access={...f().access,password_change_required:false};
    return {data:body.action==='create'?{created:true,id:'22222222-2222-4222-8222-222222222222',repeated:!!f().repeated}:body.action==='temporary_password'?{reset:true}:{changed:true}};
   }}};
  `}))
 }}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(async()=>browser?.close())
test('actual app student login and signup never auto-open an existing teacher session',async t=>{
 for(const path of ['/login','/signup','/dashboard/student']){
  const p=await open(t,'app',{session,access:teacher},390,path);
  await p.getByRole('heading',{name:'A staff account is signed in'}).waitFor();
  assert.equal(new URL(p.url()).pathname,path);
  assert.equal(await p.getByRole('heading',{name:'Teacher Portal',exact:true}).count(),0);
 }
 const p=await open(t,'app',{access:teacher},390,'/login');
 await p.getByLabel('Email',{exact:true}).fill('teacher@ksc.local');await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123');
 await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('heading',{name:'A staff account is signed in'}).waitFor();assert.equal(new URL(p.url()).pathname,'/login');
});
test('student entry keeps the older role check compatible without admitting staff',async t=>{
 for(const legacyTeacher of [true,false]){
  const p=await open(t,'student-login',{session,roleError:'PGRST202',legacyTeacher},390,'/login');
  if(legacyTeacher)await p.getByRole('heading',{name:'A staff account is signed in'}).waitFor();
  else {await p.getByRole('link',{name:'Continue with this account'}).waitFor();assert.equal(new URL(p.url()).pathname,'/login');}
 }
});
test('student entry keeps existing staff sessions on student login until account switching',async t=>{
 for(const role of ['teacher','admin','creator']){
  const p=await open(t,'student-login',{session,access:{role,state:'active'}},390,'/login');
  await p.getByRole('heading',{name:'A staff account is signed in'}).waitFor();
  assert.equal(new URL(p.url()).pathname,'/login');
  await p.getByRole('button',{name:'Switch to student account'}).click();
  await p.getByRole('textbox',{name:'Email',exact:true}).waitFor();
  assert.equal(new URL(p.url()).pathname,'/login');
 }
 const p=await open(t,'student-login',{session,access:teacher,signOutError:true},320,'/login');
 await p.getByRole('button',{name:'Switch to student account'}).click();
 await p.getByRole('alert').filter({hasText:'Sign out failed'}).waitFor();
 assert.equal(await p.getByRole('textbox',{name:'Email',exact:true}).count(),0);
});
test('student fresh sign-in and returning sessions use verified student access',async t=>{
 const student={role:'student'};
 const returning=await open(t,'student-login',{session,access:student},390,'/login');
 await returning.getByRole('link',{name:'Continue with this account'}).waitFor();
 assert.equal(new URL(returning.url()).pathname,'/login');
 for(const role of ['student','teacher']){
  const p=await open(t,'student-login',{access:{role}},390,'/login');
  await p.getByRole('textbox',{name:'Email',exact:true}).fill('synthetic@ksc.local');
  await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123');
  await p.getByRole('button',{name:'Sign in',exact:true}).click();
  if(role==='student')await p.waitForURL('**/dashboard/student');
  else {await p.getByRole('heading',{name:'A staff account is signed in'}).waitFor();assert.equal(new URL(p.url()).pathname,'/login')}
 }
 const denied=await open(t,'student-private',{session,access:teacher},390,'/dashboard/student');
 await denied.getByRole('heading',{name:'A staff account is signed in'}).waitFor();
 assert.equal(await denied.getByText('Verified staff tools').count(),0);
});
test('student permission failure fails closed and retry never guesses a role',async t=>{
 const p=await open(t,'student-private',{session,roleError:'42501'},390,'/dashboard/student');
 await p.getByRole('heading',{name:'Could not check student access'}).waitFor();
 assert.equal(await p.getByText('Verified staff tools').count(),0);
 await p.evaluate(()=>{window.fixture.roleError=null;window.fixture.access={role:'student'}});
 await p.getByRole('button',{name:'Retry',exact:true}).click();await p.getByText('Verified staff tools').waitFor();
});
test('teacher reference dashboard uses scoped values, search, working links and mobile navigation',async t=>{
 for(const width of [1440,390,320]){
  const p=await open(t,'teacher',{session:{user:{...session.user,user_metadata:{full_name:'KSC Teacher'}}},access:teacher,courses:[{id:courseId,name:'Sainik School · Mathematics',description:'Assigned preparation course'},{id:teacherId,name:'RMS · Mathematics'}],results:[{id:'r1',student:'Synthetic learner',test:'Mathematics test',score:40,total_marks:50,submitted_at:'2026-10-01T10:00:00Z'}]},width,'/dashboard/teacher');
  await p.getByRole('heading',{name:'Ready papers in library'}).waitFor();
  await p.getByText('40 / 50',{exact:false}).waitFor();
  assert.deepEqual(await p.locator('.admin-panel').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['My courses','Study materials','Ready papers in library','Published tests','Student results']);
  await p.getByLabel('Search assigned courses').fill('RMS');
  assert.equal(await p.getByRole('link',{name:'Open course →',exact:true}).count(),1);
  await p.getByLabel('Search assigned courses').fill('');
  assert.equal(await p.getByRole('link',{name:'View library',exact:true}).getAttribute('href'),'/dashboard/teacher/library');
  if(width<700){await p.getByRole('button',{name:'Open navigation'}).click();await p.getByRole('navigation',{name:'Teacher navigation'}).waitFor();await p.getByRole('button',{name:'Close navigation'}).click()}
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:`scratch/staff-accounts/teacher-portal-${width}.png`,fullPage:true});
 }
});
async function open(t,screen,fixture={},width=390,path='/teacher/login'){
 const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close())
 await context.route('**/*',r=>new URL(r.request().url()).pathname==='/ksc/institute-logo.png'?r.fulfill({contentType:'image/png',body:logo}):r.request().url().startsWith('http://127.0.0.1:55555/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const page=await context.newPage();page.setDefaultTimeout(5000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]))
 await page.goto('http://127.0.0.1:55555'+path)
 const css=(await readdir('dist/assets')).find(f=>f.endsWith('.css'));await page.addStyleTag({content:await readFile('dist/assets/'+css,'utf8')})
 await page.evaluate(f=>window.fixture=f,fixture);await page.addScriptTag({content:bundle});await page.evaluate(s=>window.mount(s),screen)
 return page
}
const session={user:{id:uid,email:'staff@ksc.local'}}
const admin={role:'admin',state:'active',password_change_required:false}
const teacher={role:'teacher',state:'active',password_change_required:false}
const creator={role:'creator',state:'active',password_change_required:false}
test('admin linked materials, library, published tests and students use the current shell and correct navigation',async t=>{
 for(const [path,title,active] of [['courses','Study materials','Study materials'],['library','Publish a test','Paper library'],['library?view=published','Published tests','Published tests'],['students','Students','Students']]){
  const p=await open(t,'app',{session,access:admin},390,'/dashboard/admin/teaching/'+path);await p.getByRole('heading',{name:title,exact:true}).waitFor();await p.getByRole('heading',{name:'Hello, staff',exact:true}).waitFor();assert.equal(await p.locator('.teacher-sidebar').count(),0);await p.getByRole('button',{name:'Open navigation'}).click();assert.equal(await p.locator('.admin-sidebar a[aria-current=page]').innerText(),active);assert.equal(await p.locator('a[href^="/dashboard/teacher"]').count(),0)
  for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/admin-linked-${active.replaceAll(' ','-').toLowerCase()}-${width}.png`,fullPage:true})}
 }
})
test('admin material deep link edits and persists a lesson without batch/enrollment controls',async t=>{
 const p=await open(t,'app',{session,access:admin,courses:[{id:courseId,name:'Reviewed course'}],lessons:[{id:'l',course_id:courseId,title:'Reviewed material',body:'Original content',sort_order:1,is_published:false}]},1440,'/dashboard/admin/teaching/courses?course='+courseId+'&lesson=l')
 await p.getByLabel('Lesson title').waitFor();assert.equal(await p.getByLabel('Lesson title').inputValue(),'Reviewed material');assert.equal(await p.getByLabel('Manage batch').count(),0);assert.equal(await p.getByRole('button',{name:'Create batch',exact:true}).count(),0);await p.screenshot({path:'scratch/staff-accounts/admin-material-editor-current.png',fullPage:true});await p.getByLabel('Lesson text').fill('Corrected material');await p.getByRole('button',{name:'Save lesson',exact:true}).click();await p.getByText('Lesson saved.',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.savedLesson.p_body),'Corrected material');await p.reload();await p.evaluate(f=>window.fixture=f,{session,access:admin,courses:[{id:courseId,name:'Reviewed course'}],lessons:[{id:'l',course_id:courseId,title:'Reviewed material',body:'Corrected material',sort_order:1,is_published:false}]});await p.addScriptTag({content:bundle});await p.evaluate(()=>window.mount('app'));await p.getByRole('button',{name:'Edit lesson',exact:true}).click();assert.equal(await p.getByLabel('Lesson text').inputValue(),'Corrected material')
})
test('admin students filter enrolled and unassigned learners while excluding staff accounts',async t=>{
 const p=await open(t,'app',{session,access:admin,courses:[{id:courseId,name:'Reviewed course'}],batches:[{id:'b',course_id:courseId,name:'Morning'}],roster:[{batch_id:'b',student_id:'learner-a',student_profiles:{full_name:'Enrolled learner'}}],profiles:[{id:'learner-a',full_name:'Enrolled learner'},{id:'learner-b',full_name:'Unassigned learner'},{id:teacherId,full_name:'Teacher account'}],people:[{id:teacherId,role:'teacher'}]},390,'/dashboard/admin/teaching/students')
 await p.getByText('Unassigned learner',{exact:true}).waitFor();await p.screenshot({path:'scratch/staff-accounts/admin-students-current.png',fullPage:true});await p.getByLabel('Student enrollment').selectOption('unassigned');assert.equal(await p.getByText('Enrolled learner',{exact:true}).count(),0);assert.equal(await p.getByText('Teacher account',{exact:true}).count(),0);await p.getByRole('button',{name:'Clear filters',exact:true}).click();await p.getByText('Enrolled learner',{exact:true}).waitFor()
})
test('new admin dashboard is role-gated and current login landing remains Staff & access',async t=>{
 const p=await open(t,'app',{session,access:admin},1440,'/dashboard/admin/overview');await p.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await p.getByRole('heading',{name:'Hello, staff',exact:true}).waitFor();await p.getByText('No courses yet',{exact:true}).waitFor()
 const landing=await open(t,'app',{session,access:admin},390,'/dashboard/admin');await landing.getByRole('heading',{name:'Staff & access',exact:true}).waitFor();assert.equal(await landing.getByRole('heading',{name:'Dashboard',exact:true}).count(),0)
 for(const access of [teacher,creator,{role:null,state:'active',password_change_required:false}]){const q=await open(t,'app',{session,access},320,'/dashboard/admin/overview');await q.getByRole('heading',{name:/access|account|sign in/i}).waitFor();assert.equal(await q.getByRole('heading',{name:'Dashboard',exact:true}).count(),0)}
})
test('actual creator preparation route uses signed-in profile and keeps other roles outside upload tools',async t=>{
 const p=await open(t,'app',{session:{user:{id:uid,email:'creator@ksc.local',user_metadata:{full_name:'Creator Example'}}},access:creator,exams:[{id:courseId,name:'Group II'}]},390,'/dashboard/testcreator/prepare')
 await p.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor();await p.getByText('Hello, Creator Example',{exact:true}).waitFor();assert.equal(await p.locator('.lp-avatar').innerText(),'C')
 await p.getByRole('button',{name:'Choose file',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:/Publish/}).count(),0)
 await p.getByRole('button',{name:'Sign out',exact:true}).click();await p.waitForURL('**/testcreator/login')
 const denied=await open(t,'app',{session,access:teacher},320,'/dashboard/testcreator/prepare');await denied.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();assert.equal(await denied.getByRole('button',{name:'Choose file',exact:true}).count(),0)
})

test('creator login establishes a session and checks the actual creator role',async t=>{
 const p=await open(t,'creator-login',{access:creator},320,'/testcreator/login');
 await p.getByRole('heading',{name:'Test Creator Login'}).waitFor();
 await p.getByLabel('Email address').fill('creator@ksc.local');await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123');
 await p.getByRole('button',{name:/Sign in securely/}).click();await p.waitForURL('**/dashboard/testcreator/prepare');
 assert.equal(await p.evaluate(()=>window.signInCalls),1);
 const denied=await open(t,'creator-login',{session,access:teacher},390,'/testcreator/login');
 await denied.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();assert.equal(await denied.locator('form').count(),0);
 for(const screen of ['teacher','admin']){
  const wrong=await open(t,screen,{session,access:creator});await wrong.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();
 }
});
test('creator temporary password gate precedes workspace and account switching returns to creator login',async t=>{
 const p=await open(t,'creator-login',{session,access:{...creator,password_change_required:true}},390,'/testcreator/login');
 await p.getByRole('heading',{name:'Choose your own password'}).waitFor();await p.getByRole('button',{name:'Sign out',exact:true}).click();await p.waitForURL('**/testcreator/login');
 const suspended=await open(t,'creator',{session,access:{...creator,state:'suspended'}});await suspended.getByRole('heading',{name:'Staff access is suspended'}).waitFor();
 assert.equal(await suspended.getByRole('heading',{name:'My exam access'}).count(),0);
});
test('admin creates creator with exams, retains failed form and shares the correct login link',async t=>{
 const p=await open(t,'admin',{session,access:admin,exams:[{id:courseId,name:'Assigned exam'}],accountError:'Setup unavailable'},390,'/dashboard/admin');
 await p.getByRole('button',{name:'Add Test Creator',exact:true}).click();await p.getByLabel('Full name').fill('QA Creator');await p.getByLabel('Email address').fill('creator@ksc.local');
 await p.getByRole('button',{name:'Create Test Creator account',exact:true}).click();await p.getByText('Select at least one valid exam for this Test Creator.',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.accountCalls||0),0);
 assert.equal(await p.getByRole('group',{name:'Assigned courses'}).count(),0);
 await p.getByRole('checkbox',{name:'Assigned exam'}).check();await p.getByRole('button',{name:'Create Test Creator account',exact:true}).click();await p.getByRole('alert').filter({hasText:'Setup unavailable'}).waitFor();
 assert.equal(await p.getByLabel('Full name').inputValue(),'QA Creator');assert.ok(await p.getByRole('checkbox',{name:'Assigned exam'}).isChecked());
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.screenshot({path:'scratch/staff-accounts/creator-admin-mobile.png',fullPage:true});
 await p.evaluate(()=>window.fixture.accountError=null);await p.getByRole('button',{name:'Create Test Creator account',exact:true}).click();
 await p.getByRole('heading',{name:'Share these details privately with the staff member'}).waitFor();
 await p.getByText('Login: http://127.0.0.1:55555/testcreator/login',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.createdRole),'creator');assert.deepEqual(await p.evaluate(()=>window.createdExams),[courseId]);
});
test('creator retries follow account details while edits and reverted scopes preserve safe operation keys',async t=>{
 const secondExam='44444444-4444-4444-8444-444444444444';
 const p=await open(t,'admin',{session,access:admin,exams:[{id:courseId,name:'First exam'},{id:secondExam,name:'Second exam'}],accountError:'Network unavailable'},390,'/dashboard/admin');
 await p.getByRole('button',{name:'Add Test Creator',exact:true}).click();await p.getByLabel('Full name').fill('QA Creator');await p.getByLabel('Email address').fill('first@ksc.local');
 await p.getByRole('checkbox',{name:'Second exam'}).check();await p.getByRole('checkbox',{name:'First exam'}).check();
 const submit=async()=>{await p.getByRole('button',{name:'Create Test Creator account',exact:true}).click();await p.getByRole('alert').filter({hasText:'Network unavailable'}).waitFor()};
 await submit();await submit();
 await p.getByLabel('Email address').fill('corrected@ksc.local');await submit();
 await p.getByLabel('Email address').fill('first@ksc.local');await p.getByLabel('Full name').fill(' QA Creator ');
 await p.getByRole('checkbox',{name:'Second exam'}).uncheck();await p.getByRole('checkbox',{name:'Second exam'}).check();
 await p.getByRole('button',{name:'Generate password',exact:true}).click();await submit();
 const requests=await p.evaluate(()=>window.creationRequests);
 assert.equal(requests[0].request_id,requests[1].request_id);assert.notEqual(requests[0].request_id,requests[2].request_id);assert.equal(requests[0].request_id,requests[3].request_id);
 assert.deepEqual(requests[0].exams,[courseId,secondExam]);assert.equal(requests[2].email,'corrected@ksc.local');
 assert.equal(await p.getByLabel('Email address').inputValue(),'first@ksc.local');assert.ok(await p.getByLabel('Temporary password').inputValue());
 await p.evaluate(()=>window.fixture.accountError=null);await p.getByRole('button',{name:'Create Test Creator account',exact:true}).click();await p.getByRole('heading',{name:'Share these details privately with the staff member'}).waitFor();
 assert.equal((await p.evaluate(()=>window.creationRequests)).at(-1).request_id,requests[0].request_id);
});

test('admin creator assignments and existing-account access use creator operations',async t=>{
 const person={id:teacherId,name:'Creator',email:'creator@ksc.local',...creator,version:2,exams:[courseId],courses:[],batches:[]};
 const p=await open(t,'admin',{session,access:admin,people:[person],exams:[{id:courseId,name:'Assigned exam'}]},1440,'/dashboard/admin');
 await p.getByRole('button',{name:'Edit access for Creator',exact:true}).click();await p.getByRole('checkbox',{name:'Assigned exam'}).uncheck();await p.getByRole('button',{name:'Save assignments',exact:true}).click();await p.getByRole('status').filter({hasText:'Assignments saved'}).waitFor();
 assert.deepEqual(await p.evaluate(()=>window.savedExams),{p_user:teacherId,p_exams:[],p_version:2});
 await p.getByRole('button',{name:'Grant existing account access'}).click();await p.getByLabel('Staff role').selectOption('creator');await p.getByLabel('Full name').fill('Existing creator');await p.getByLabel('Email address').fill('existing@ksc.local');await p.getByRole('checkbox',{name:'Assigned exam'}).check();
 await p.getByRole('button',{name:'Grant Test Creator access',exact:true}).click();await p.getByRole('status').filter({hasText:'Staff access granted'}).waitFor();assert.deepEqual((await p.evaluate(()=>window.creatorGrant)).p_exams,[courseId]);assert.equal(await p.evaluate(()=>window.accountCalls||0),0);
 await p.screenshot({path:'scratch/staff-accounts/creator-admin-desktop.png',fullPage:true});
});
test('missing creator upgrade disables new creator provisioning without blocking teachers',async t=>{
 const p=await open(t,'admin',{session,access:admin,creatorMissing:true},320,'/dashboard/admin');await p.getByRole('status').filter({hasText:'creator permission update'}).waitFor();assert.equal(await p.getByRole('button',{name:'Add Test Creator',exact:true}).isDisabled(),true);assert.equal(await p.getByRole('button',{name:'Add teacher',exact:true}).isEnabled(),true);
});
test('creator workspace shows only supplied exam assignments and keeps sample papers out of account data',async t=>{
 const p=await open(t,'creator',{session,access:creator,exams:[{id:courseId,name:'Assigned exam'}]},320,'/dashboard/testcreator');await p.getByRole('heading',{name:'Assigned exam'}).waitFor();assert.equal(await p.getByRole('button',{name:'Publish',exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:'Prepare a paper',exact:true}).getAttribute('href'),'/dashboard/testcreator/prepare');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const empty=await open(t,'creator',{session,access:creator});await empty.getByRole('heading',{name:'No exams assigned'}).waitFor();
});
test('distinct staff forms have no signup, fit mobile, and render desktop/mobile screenshots',async t=>{
 for(const [role,width] of [['teacher',320],['teacher',390],['admin',1440]]){
  const p=await open(t,role+'-login',{},width)
  await p.getByRole('heading',{name:role==='admin'?'Admin Login':'Teacher Login'}).waitFor()
  assert.equal(await p.locator('a[href="/signup"]').count(),0);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await p.screenshot({path:'scratch/staff-accounts/'+role+'-login-'+width+'.png',fullPage:true})
 }
})
test('sign-in failure releases form; retry verifies teacher permissions',async t=>{
 const p=await open(t,'teacher-login',{signInError:'Invalid login credentials',access:teacher})
 await p.getByLabel('Email address').fill('qa@ksc.local');await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123')
 await p.getByRole('button',{name:/Sign in securely/}).click();await p.getByRole('alert').waitFor()
 await p.evaluate(()=>window.fixture.signInError=null);await p.getByRole('button',{name:/Sign in securely/}).click()
 await p.waitForURL('**/dashboard/teacher');assert.equal(await p.evaluate(()=>window.signInCalls),2)
})
test('student cannot mount admin tools; failed sign-out keeps the account',async t=>{
 const p=await open(t,'gate',{session,access:{role:'student',state:'active'},signOutError:true})
 await p.getByRole('heading',{name:'This account cannot open this portal'}).waitFor()
 assert.equal(await p.evaluate(()=>window.toolsMounted||0),0)
 await p.getByRole('button',{name:'Switch account'}).click();await p.getByRole('alert').waitFor()
 assert.equal(new URL(p.url()).pathname,'/teacher/login')
})
test('role failure is retryable without mounting tools',async t=>{
 const p=await open(t,'gate',{session,roleError:'PGRST202',access:admin})
 await p.getByRole('heading',{name:'First administrator setup is needed'}).waitFor();assert.equal(await p.evaluate(()=>window.toolsMounted||0),0)
 assert.equal(await p.getByRole('link',{name:'View first administrator setup'}).getAttribute('href'),'/admin/setup')
 await p.evaluate(()=>window.fixture.roleError=null);await p.getByRole('button',{name:'Retry',exact:true}).click();await p.getByText('Verified staff tools').waitFor()
})

test('ordinary access-check failures do not claim missing setup or grant access',async t=>{
 const p=await open(t,'gate',{session,roleError:'NETWORK',access:admin})
 await p.getByRole('heading',{name:'Could not check staff access'}).waitFor()
 assert.equal(await p.getByRole('link',{name:'View first administrator setup'}).count(),0)
 assert.equal(await p.evaluate(()=>window.toolsMounted||0),0)
})

test('first-admin guide explains existing-account setup without creating staff or offering public admin signup',async t=>{
 const p=await open(t,'setup',{session},320,'/admin/setup')
 await p.getByRole('heading',{name:'Set up your first administrator'}).waitFor()
 await p.getByText(/You can use an existing account/).waitFor()
 await p.getByText(/Open Staff & access, select Add teacher/).waitFor()
 assert.equal(await p.locator('form').count(),0)
 assert.equal(await p.evaluate(()=>window.accountCalls||0),0)
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await p.screenshot({path:'scratch/staff-accounts/first-admin-guide-320.png',fullPage:true})
})
test('late privileged role response cannot authorize a replacement student',async t=>{
 const p=await open(t,'gate',{session,access:admin,holdRole:true})
 await p.waitForFunction(()=>!!window.releaseRole)
 await p.evaluate(()=>{window.oldRelease=window.releaseRole;window.fixture.holdRole=false;window.fixture.access={role:'student',state:'active'};window.emitAuth('SIGNED_IN',{user:{id:'22222222-2222-4222-8222-222222222222',email:'learner@ksc.local'}})})
 await p.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();await p.evaluate(()=>window.oldRelease());assert.equal(await p.evaluate(()=>window.toolsMounted||0),0)
})
test('mandatory password setup validates confirmation and retries server error',async t=>{
 const p=await open(t,'teacher-login',{session,access:{...teacher,password_change_required:true},accountError:'Account service unavailable'})
 await p.getByRole('heading',{name:'Choose your own password'}).waitFor()
 await p.getByLabel('Current temporary password').fill('Synthetic!Temporary123');await p.getByLabel('New password',{exact:true}).fill('Synthetic!NewPassword123');await p.getByLabel('Confirm new password').fill('Different!Password123')
 await p.getByRole('button',{name:'Save password & continue'}).click();assert.equal(await p.evaluate(()=>window.accountCalls||0),0)
 await p.getByLabel('Confirm new password').fill('Synthetic!NewPassword123');await p.getByRole('button',{name:'Save password & continue'}).click();await p.getByRole('alert').filter({hasText:'Account service unavailable'}).waitFor()
 await p.evaluate(()=>window.fixture.accountError=null);await p.getByRole('button',{name:'Save password & continue'}).click();await p.waitForURL('**/dashboard/teacher')
})
test('expired temporary access has no password update form',async t=>{
 const p=await open(t,'teacher-login',{session,access:{...teacher,password_change_required:true,temporary_expired:true}})
 await p.getByRole('heading',{name:'Temporary access has expired'}).waitFor();assert.equal(await p.locator('form').count(),0)
})
const accessFixture=()=>({session,access:admin,institutes:[{id:'inst-1',name:'AaryaRushi Education'}],
 courses:[{id:'c-g2',name:'Group-II Foundation'},{id:'c-dsc',name:'DSC 2026'}],
 batches:[{id:'b-m',course_id:'c-g2',name:'Morning'},{id:'b-e',course_id:'c-g2',name:'Evening'},{id:'b-d',course_id:'c-dsc',name:'Weekend'}],
 links:[{course_id:'c-g2',level_id:'lvl-g2'}],programs:[{id:'g2',name:'Group-II',tracks:[{id:'lvl-g2',name:'General'}]},{id:'dsc',name:'DSC',tracks:[{id:'lvl-sgt',name:'SGT'},{id:'lvl-sa',name:'School Assistant'}]}],
 people:[{id:uid,name:'QA Admin',email:'admin@ksc.local',role:'admin',state:'active',courses:[],batches:[]},
  {id:teacherId,name:'Ravi Kumar',email:'ravi@ksc.local',role:'teacher',state:'active',password_change_required:false,version:3,courses:[],batches:[]},
  {id:'t-2',name:'Sita Devi',email:'sita@ksc.local',role:'teacher',state:'active',password_change_required:false,version:1,courses:['c-dsc'],batches:['b-d']}]})
test('admin assigns a teacher to course batches with batch chips, sees the change summary and the saved access on the card',async t=>{
 const p=await open(t,'admin',accessFixture(),1440,'/dashboard/admin')
 const ravi=p.locator('.sa-person').filter({hasText:'Ravi Kumar'})
 await ravi.getByText('Not teaching any batch yet').waitFor()
 await p.getByText('Batches without a teacher',{exact:true}).waitFor()
 assert.equal(await p.locator('.sa-stat.is-warn strong').innerText(),'2')
 assert.equal(await p.getByRole('button',{name:/^Needs attention/}).innerText().then(x=>x.replace(/\s+/g,' ')),'Needs attention 1')
 await p.getByRole('button',{name:/^Needs attention/}).click();assert.equal(await p.locator('.sa-person').count(),1)
 await p.getByRole('button',{name:/^Everyone/}).click()
 await p.locator('.sa-person').filter({hasText:'Sita Devi'}).getByText('DSC 2026 › Weekend').waitFor()
 await ravi.getByRole('button',{name:'Edit access for Ravi Kumar'}).click()
 const drawer=p.getByRole('dialog',{name:'Edit teacher assignments'});await drawer.waitFor()
 await drawer.getByText('Ravi Kumar · ravi@ksc.local').waitFor()
 await drawer.getByText('Group-II',{exact:true}).waitFor()
 const save=drawer.getByRole('button',{name:'No changes yet'});assert.equal(await save.isDisabled(),true)
 await drawer.getByRole('checkbox',{name:'Group-II Foundation · Morning'}).check()
 assert.equal(await drawer.getByRole('checkbox',{name:'Group-II Foundation',exact:true}).isChecked(),true,'a batch brings its course')
 await drawer.getByText('+ Group-II Foundation › Morning').waitFor()
 await drawer.getByRole('button',{name:'Select all batches'}).click()
 assert.equal(await drawer.getByRole('checkbox',{name:'Group-II Foundation · Evening'}).isChecked(),true)
 await drawer.getByRole('checkbox',{name:'Group-II Foundation · Evening'}).uncheck()
 await drawer.getByRole('checkbox',{name:'DSC 2026',exact:true}).check()
 await drawer.getByText('+ DSC 2026 (course only)').waitFor();await drawer.getByText(/Course only: lessons and materials/).waitFor()
 await drawer.getByRole('checkbox',{name:'DSC 2026',exact:true}).uncheck()
 await p.screenshot({path:'scratch/staff-accounts/staff-access-drawer-1440.png'})
 await drawer.getByRole('button',{name:'Save assignments'}).click()
 await p.getByRole('status').filter({hasText:'Assignments saved.'}).waitFor()
 assert.deepEqual(await p.evaluate(()=>window.savedAssignments),{p_user:teacherId,p_courses:['c-g2'],p_batches:['b-m'],p_version:3})
 await ravi.getByText('Group-II Foundation › Morning').waitFor()
 assert.equal(await p.locator('.sa-stat.is-warn strong').innerText(),'1')
 await p.screenshot({path:'scratch/staff-accounts/staff-access-1440.png',fullPage:true})
 // Removing a course takes its batches with it.
 await ravi.getByRole('button',{name:'Edit access for Ravi Kumar'}).click()
 await drawer.getByRole('checkbox',{name:'Group-II Foundation',exact:true}).uncheck()
 assert.equal(await drawer.getByRole('checkbox',{name:'Group-II Foundation · Morning'}).isChecked(),false)
 await drawer.getByText('− Group-II Foundation › Morning').waitFor()
 await drawer.getByRole('button',{name:'Cancel'}).click();await drawer.waitFor({state:'hidden'})
 // Suspend from the More menu.
 await ravi.getByRole('button',{name:'More actions for Ravi Kumar'}).click()
 await p.getByRole('menuitem',{name:'Suspend access'}).click()
 await p.getByRole('status').filter({hasText:'Staff access suspended.'}).waitFor()
 assert.equal((await p.evaluate(()=>window.stateChange)).p_state,'suspended')
})
test('admin with no courses creates a course and batch inside the teacher form and assigns them in one go',async t=>{
 const fixture={...accessFixture(),courses:[],batches:[],links:[]}
 const p=await open(t,'admin',fixture,390,'/dashboard/admin')
 await p.getByRole('button',{name:'Add teacher',exact:true}).click()
 const drawer=p.getByRole('dialog',{name:'Add a teacher'});await drawer.waitFor()
 await drawer.getByLabel('Full name').fill('New Teacher');await drawer.getByLabel('Email address').fill('new@ksc.local')
 await drawer.getByText('No courses yet',{exact:true}).waitFor()
 await drawer.getByRole('button',{name:'Create a course'}).click()
 await drawer.getByLabel('Course name').fill('Group-II Foundation 2026')
 await drawer.getByLabel('Program (optional)').selectOption({label:'DSC · SGT'})
 await drawer.getByRole('button',{name:'Create course'}).click()
 const course=drawer.getByRole('checkbox',{name:'Group-II Foundation 2026',exact:true});await course.waitFor()
 assert.equal(await course.isChecked(),true,'new course is selected')
 assert.deepEqual(await p.evaluate(()=>window.createdCourse),{p_institute:'inst-1',p_name:'Group-II Foundation 2026',p_description:''})
 assert.deepEqual(await p.evaluate(()=>window.linkedTrack),{course_id:'aaaaaaaa-0000-4000-8000-000000000001',level_id:'lvl-sgt'})
 await drawer.getByText('DSC · SGT',{exact:true}).waitFor()
 await drawer.getByRole('button',{name:'Add a batch to Group-II Foundation 2026'}).click()
 await drawer.getByLabel('New batch name for Group-II Foundation 2026').fill('Morning')
 await drawer.getByRole('button',{name:'Add',exact:true}).click()
 const batch=drawer.getByRole('checkbox',{name:'Group-II Foundation 2026 · Morning'});await batch.waitFor()
 assert.equal(await batch.isChecked(),true,'new batch is selected')
 assert.deepEqual(await p.evaluate(()=>window.createdBatch),{p_course:'aaaaaaaa-0000-4000-8000-000000000001',p_name:'Morning'})
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await p.screenshot({path:'scratch/staff-accounts/staff-access-create-390.png'})
 await drawer.getByRole('button',{name:'Create teacher account',exact:true}).click()
 await p.getByRole('heading',{name:'Share these details privately with the staff member'}).waitFor()
 const sent=await p.evaluate(()=>window.creationRequests.at(-1));assert.equal(sent.email,'new@ksc.local');assert.deepEqual(await p.evaluate(()=>[window.lastCreate.courses,window.lastCreate.batches]),[['aaaaaaaa-0000-4000-8000-000000000001'],['bbbbbbbb-0000-4000-8000-000000000001']])
 await p.getByText('Login: http://127.0.0.1:55555/teacher/login',{exact:true}).waitFor()
 await p.screenshot({path:'scratch/staff-accounts/staff-access-credential-390.png',fullPage:true})
})

test('admin creation reveals credential only after success and can clear it',async t=>{
 const p=await open(t,'admin',{session,access:admin,people:[{id:uid,name:'QA Admin',email:'admin@ksc.local',role:'admin',state:'active',courses:[],batches:[]}],courses:[{id:courseId,name:'School foundation'}],batches:[]},1440,'/dashboard/admin')
 await p.getByRole('button',{name:'Add teacher',exact:true}).click();await p.getByLabel('Full name').fill('QA Teacher');await p.getByLabel('Email address').fill('teacher@ksc.local');await p.getByRole('checkbox',{name:'School foundation'}).check()
 for(let i=0;i<12;i++){
  await p.getByRole('button',{name:'Generate password',exact:true}).click();const generated=await p.getByLabel('Temporary password',{exact:true}).inputValue()
  assert.equal(generated.length,20);for(const pattern of [/[a-z]/,/[A-Z]/,/[0-9]/,/[^a-zA-Z0-9]/])assert.match(generated,pattern)
 }
 await p.getByRole('button',{name:'Create teacher account',exact:true}).click();await p.getByRole('heading',{name:'Share these details privately with the staff member'}).waitFor()
 assert.equal(await p.evaluate(()=>window.accountAction),'create');await p.screenshot({path:'scratch/staff-accounts/admin-desktop.png',fullPage:true})
 await p.getByRole('button',{name:'Done — clear password'}).click();assert.equal(await p.getByRole('heading',{name:'Share these details privately with the staff member'}).count(),0)
})
test('completed request retry does not display a potentially different password',async t=>{
 const p=await open(t,'admin',{session,access:admin,people:[],courses:[],batches:[],repeated:true},390,'/dashboard/admin')
 await p.getByRole('button',{name:'Add teacher',exact:true}).click();await p.getByLabel('Full name').fill('QA');await p.getByLabel('Email address').fill('qa@ksc.local');await p.getByRole('button',{name:'Create teacher account',exact:true}).click()
 await p.getByRole('status').filter({hasText:'already created'}).waitFor();assert.equal(await p.getByRole('heading',{name:'Share these details privately with the staff member'}).count(),0)
})
test('teacher sees honest empty assignment state and no admin creation/enrollment controls',async t=>{
 const p=await open(t,'teacher',{session,access:teacher,courses:[]},390,'/dashboard/teacher');await p.getByText('No courses assigned yet',{exact:true}).waitFor()
 const c=await open(t,'learning',{session,access:teacher,courses:[{id:courseId,name:'School foundation',description:'Learn'}],batches:[],lessons:[]},390,'/dashboard/teacher/courses')
 await c.getByRole('button',{name:/School foundation/}).click();await c.getByRole('button',{name:'Add lesson'}).waitFor()
 for(const name of ['Create course','Create batch','Enroll learner'])assert.equal(await c.getByRole('button',{name,exact:true}).count(),0)
})

test('a temporary-password teacher signing into admin login sees account mismatch first',async t=>{
 const p=await open(t,'admin-login',{session,access:{...teacher,password_change_required:true}});
 await p.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();
 assert.equal(await p.locator('form').count(),0);
});

test('custom password checklist identifies missing uppercase before sending and accepts corrected custom password without assignments',async t=>{
 const p=await open(t,'admin',{session,access:admin,people:[]},390,'/dashboard/admin');
 await p.getByRole('button',{name:'Add teacher',exact:true}).click();
 await p.getByLabel('Full name').fill('QA Teacher');await p.getByLabel('Email address').fill('qa@ksc.local');
 await p.getByLabel('Temporary password',{exact:true}).fill('manualpassword123!');
 await p.getByRole('button',{name:'Create teacher account',exact:true}).click();
 await p.getByText('Temporary password needs: An uppercase letter (A–Z).',{exact:true}).waitFor();
 assert.equal(await p.evaluate(()=>window.accountCalls||0),0);
 assert.equal(await p.getByRole('button',{name:'Retry',exact:true}).count(),0);
 assert.equal(await p.getByLabel('Temporary password',{exact:true}).inputValue(),'manualpassword123!');
 assert.equal(await p.getByRole('list',{name:'Password requirements'}).locator('li.is-met').count(),4);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.screenshot({path:'scratch/staff-accounts/custom-password-guidance.png',fullPage:true});
 await p.getByLabel('Temporary password',{exact:true}).fill('CustomPassword123!');
 await p.getByRole('button',{name:'Create teacher account',exact:true}).click();
 await p.getByRole('heading',{name:'Share these details privately with the staff member'}).waitFor();
 assert.equal(await p.evaluate(()=>window.accountCalls),1);
});


test('Student results from a published test open filtered to that test with a count and average',async t=>{
 const results=[{id:'r1',student:'Learner A',test:'DSC divisional test',test_id:'t-dsc',exam_id:'dsc',program:'DSC',score:60,total_marks:100},{id:'r2',student:'Learner B',test:'DSC divisional test',test_id:'t-dsc',exam_id:'dsc',program:'DSC',score:75,total_marks:100},{id:'r3',student:'Learner C',test:'Group-II test',test_id:'t-g2',exam_id:'group2',program:'Group-II',score:2,total_marks:150}]
 const p=await open(t,'teacher',{session,access:teacher,results},390,'/dashboard/teacher/results?test=t-dsc')
 const banner=p.locator('.result-test-banner');await banner.getByText('Results for DSC divisional test',{exact:true}).waitFor()
 await banner.getByText('2 students have finished this test · Average 67.5 / 100',{exact:true}).waitFor()
 assert.equal(await p.getByText('Group-II test',{exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:'View answers'}).count(),2)
 assert.equal(await banner.getByRole('link',{name:'Show all results'}).getAttribute('href'),'/dashboard/teacher/results')
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'scratch/staff-accounts/results-one-test-390.png',fullPage:true})
 // Every result is one card: whole words, the score with a bar, and a 44px View answers button.
 const card=p.getByRole('list',{name:'Completed results'}).getByRole('listitem').filter({hasText:'Learner A'})
 assert.ok((await card.getByRole('heading',{name:'Learner A'}).boundingBox()).height<30,'student name stays on one line')
 await card.getByText('60%',{exact:true}).waitFor()
 assert.ok((await card.getByRole('link',{name:'View answers'}).boundingBox()).height>=44)
 await p.setViewportSize({width:320,height:800});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'scratch/staff-accounts/results-cards-320.png',fullPage:true})
 const none=await open(t,'teacher',{session,access:teacher,results},390,'/dashboard/teacher/results?test=t-new')
 await none.locator('.result-test-banner').getByText('No student has finished this test yet.',{exact:true}).waitFor()
})

test('admins delete a student result from the list or the review after confirming; teachers never see delete',async t=>{
 const results=[{id:'r1',student:'Learner A',test:'DSC divisional test',test_id:'t-dsc',exam_id:'dsc',program:'DSC',score:60,total_marks:100},{id:'r2',student:'Learner B',test:'DSC divisional test',test_id:'t-dsc',exam_id:'dsc',program:'DSC',score:75,total_marks:100}]
 const teacherView=await open(t,'teacher',{session,access:teacher,results},1440,'/dashboard/teacher/results')
 await teacherView.getByRole('heading',{name:'Learner A'}).waitFor();assert.equal(await teacherView.getByRole('button',{name:/More actions/}).count(),0)
 const p=await open(t,'app',{session,access:admin,results,deleteFailOnce:true},1440,'/dashboard/admin/teaching/results')
 await p.getByRole('heading',{name:'Learner A'}).waitFor()
 await p.getByRole('button',{name:'More actions for Learner A, DSC divisional test'}).click()
 await p.getByRole('menuitem',{name:'Delete result'}).click()
 const dialog=p.getByRole('dialog',{name:'Delete this result?'});await dialog.waitFor()
 assert.match(await dialog.innerText(),/Learner A[\s\S]*Score 60 \/ 100[\s\S]*can’t be undone[\s\S]*take the test again/)
 await dialog.getByRole('button',{name:'Cancel'}).click();await dialog.waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>window.deletedResults?.length||0),0)
 await p.getByRole('button',{name:'More actions for Learner A, DSC divisional test'}).click();await p.getByRole('menuitem',{name:'Delete result'}).click()
 await dialog.getByRole('button',{name:'Delete result'}).click()
 await dialog.getByRole('alert').filter({hasText:'This result could not be deleted. Please retry.'}).waitFor()
 await p.screenshot({path:'scratch/staff-accounts/results-delete-dialog-1440.png'})
 await dialog.getByRole('button',{name:'Retry'}).click();await dialog.waitFor({state:'hidden'})
 await p.getByText('Learner A’s result for DSC divisional test was deleted.').waitFor()
 assert.equal(await p.getByRole('heading',{name:'Learner A'}).count(),0);await p.getByRole('heading',{name:'Learner B'}).waitFor()
 assert.deepEqual(await p.evaluate(()=>window.deletedResults),['r1','r1'])
 const review={student:'Learner B',test:'DSC divisional test',program:'DSC',score:75,total_marks:100,questions:[{question_id:'q1',section:'Maths',content:'2 + 2?',selected_option_id:'o1',correct_option_id:'o1',marks_awarded:1,options:[{id:'o1',content:'4'},{id:'o2',content:'3'}]}]}
 const r=await open(t,'app',{session,access:admin,results,review},390,'/dashboard/admin/teaching/results?attempt=r2')
 await r.getByText('2 + 2?',{exact:true}).waitFor();await r.getByRole('button',{name:'Delete this result'}).click()
 await r.getByRole('dialog',{name:'Delete this result?'}).getByRole('button',{name:'Delete result'}).click()
 await r.getByRole('heading',{name:'Result deleted'}).waitFor();assert.equal(await r.getByRole('link',{name:'Back to all student results'}).getAttribute('href'),'/dashboard/admin/teaching/results')
 assert.equal(await r.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 const d=await open(t,'teacher',{session,access:teacher,results,review},390,'/dashboard/teacher/results?attempt=r2');await d.getByText('2 + 2?',{exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'Delete this result'}).count(),0)
})

test('teacher results filter by program and open frozen answer review without changing scores',async t=>{
 const results=[{id:'r1',student:'Learner A',test:'DSC test',exam_id:'dsc',program:'DSC',score:1,total_marks:150},{id:'r2',student:'Learner B',test:'Group-II test',exam_id:'group2',program:'Group-II',score:2,total_marks:150}]
 const p=await open(t,'teacher',{session,access:teacher,results},390,'/dashboard/teacher/results')
 await p.getByRole('heading',{name:'Student results',exact:true}).waitFor();await p.getByRole('group',{name:'Filter student results by program'}).getByRole('button',{name:'DSC',exact:true}).click()
 assert.equal(await p.getByText('Group-II test',{exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:'View answers'}).getAttribute('href'),'/dashboard/teacher/results?attempt=r1')
 const review={student:'Learner A',test:'DSC test',program:'DSC',score:1,total_marks:150,questions:[{question_id:'q1',section:'Maths',content:'2 + 2?',selected_option_id:'o2',correct_option_id:'o1',marks_awarded:-1,options:[{id:'o1',content:'4'},{id:'o2',content:'3'}],explanation:'Add two and two.'}]}
 const detail=await open(t,'teacher',{session,access:teacher,results,review},320,'/dashboard/teacher/results?attempt=r1')
 await detail.getByText('2 + 2?',{exact:true}).waitFor();await detail.getByText('Student answer ·',{exact:true}).waitFor();await detail.getByText('Correct answer ·',{exact:true}).waitFor();await detail.getByText('Marks awarded: -1',{exact:true}).waitFor()
 assert.deepEqual(await detail.evaluate(()=>window.reviewRequest),{p_attempt:'r1'});assert.equal(await detail.getByRole('button',{name:/Approve|Change score/}).count(),0);assert.equal(await detail.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await detail.screenshot({path:'scratch/staff-accounts/teacher-answer-review-320.png',fullPage:true});await detail.setViewportSize({width:1440,height:900});await detail.screenshot({path:'scratch/staff-accounts/teacher-answer-review-1440.png',fullPage:true})
 const denied=await open(t,'teacher',{session,access:teacher,results,reviewError:true},390,'/dashboard/teacher/results?attempt=unassigned')
 await denied.getByRole('alert').filter({hasText:'assigned course and batch'}).waitFor();assert.equal(await denied.getByText('2 + 2?',{exact:true}).count(),0)
})

const batchId='44444444-4444-4444-8444-444444444444';
const assignmentFixture={session,access:admin,courses:[{id:courseId,name:'DSC Teaching Course'},{id:'other-course',name:'Group-II Course'}],batches:[{id:batchId,course_id:courseId,name:'DSC Batch A'}],people:[{id:teacherId,name:'Teacher One',email:'teacher@fixture.test',role:'teacher',state:'active',password_change_required:false,courses:['other-course'],batches:['other-batch'],version:5}],profiles:[{id:teacherId,full_name:'Learner One'}]};
test('Admin teaching view keeps admin routes and clearly identifies institute oversight',async t=>{
 const p=await open(t,'app',{session,access:admin,courses:assignmentFixture.courses,results:[]},1440,'/dashboard/admin/teaching');
 await p.getByRole('heading',{name:'Hello, staff',exact:true}).waitFor();
 await p.getByText(/Admin workspace/).waitFor();
 assert.equal(await p.getByRole('link',{name:'Teaching workspace',exact:true}).count(),0);
 assert.equal(await p.getByRole('link',{name:'Study materials',exact:true}).getAttribute('href'),'/dashboard/admin/teaching/courses');
 assert.equal(await p.getByRole('link',{name:'Student results',exact:true,includeHidden:true}).first().getAttribute('href'),'/dashboard/admin/teaching/results');
 assert.equal(await p.locator('a[href^="/dashboard/teacher"]').count(),0);
 await p.screenshot({path:'scratch/staff-accounts/admin-teaching-overview.png',fullPage:true});
});
test('Teacher account cannot open admin teaching oversight or student assignments',async t=>{
 for(const path of ['/dashboard/admin/teaching','/dashboard/admin/assignments']){
  const p=await open(t,'app',{session,access:teacher},320,path);
  await p.getByRole('heading',{name:'This account cannot open this portal'}).waitFor();
  assert.equal(await p.getByRole('heading',{name:'Students & assignments'}).count(),0);
 }
});
test('Assignment review preserves other teacher scopes and requires explicit save',async t=>{
 const p=await open(t,'app',assignmentFixture,1440,'/dashboard/admin/assignments');
 await p.getByRole('heading',{name:'Students & assignments'}).waitFor();await p.getByLabel('Course',{exact:true}).selectOption(courseId);await p.getByLabel('Batch',{exact:true}).selectOption(batchId);
 await p.getByLabel('Teacher',{exact:true}).selectOption(teacherId);await p.getByRole('button',{name:'Review assignment'}).click();
 assert.equal(await p.evaluate(()=>window.savedAssignments),undefined);
 await p.getByRole('button',{name:'Confirm & save'}).click();await p.getByRole('status').filter({hasText:'Teacher assigned'}).waitFor();
 const saved=await p.evaluate(()=>window.savedAssignments);assert.deepEqual(saved.p_courses,['other-course',courseId]);assert.deepEqual(saved.p_batches,['other-batch',batchId]);assert.equal(saved.p_version,5);
 await p.screenshot({path:'scratch/staff-accounts/admin-assignments-1440.png',fullPage:true});
});
test('Stale assignment conflict stays visible and does not claim success',async t=>{
 const p=await open(t,'app',{...assignmentFixture,assignError:'Assignments changed. Refresh and try again.'},320,'/dashboard/admin/assignments');
 await p.getByLabel('Course',{exact:true}).selectOption(courseId);await p.getByLabel('Batch',{exact:true}).selectOption(batchId);await p.getByLabel('Teacher',{exact:true}).selectOption(teacherId);await p.getByRole('button',{name:'Review assignment'}).click();await p.getByRole('button',{name:'Confirm & save'}).click();await p.getByRole('alert').filter({hasText:'Assignments changed'}).waitFor();
 assert.equal(await p.getByRole('status').filter({hasText:'Teacher assigned'}).count(),0);assert.equal(await p.getByRole('button',{name:'Confirm & save'}).count(),1);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'scratch/staff-accounts/admin-assignments-320.png',fullPage:true});
});
test('Enrollment resolves confirmed account, reviews batch and preserves entered details on failure',async t=>{
 const p=await open(t,'app',{...assignmentFixture,people:[],enrollError:'Enrollment could not save.'},390,'/dashboard/admin/assignments');
 await p.getByLabel('Course',{exact:true}).selectOption(courseId);await p.getByLabel('Batch',{exact:true}).selectOption(batchId);await p.getByLabel('Student email').fill('learner@fixture.test');await p.getByRole('button',{name:'Find student',exact:true}).click();await p.getByRole('button',{name:'Review enrollment'}).click();
 assert.equal(await p.evaluate(()=>window.enrollment),undefined);await p.getByRole('button',{name:'Confirm & save'}).click();await p.getByRole('alert').filter({hasText:'Enrollment could not save'}).waitFor();
 assert.equal(await p.getByLabel('Student email').inputValue(),'learner@fixture.test');await p.evaluate(()=>window.fixture.enrollError=null);await p.getByRole('button',{name:'Confirm & save'}).click();await p.getByRole('status').filter({hasText:'Student enrolled'}).waitFor();assert.equal((await p.evaluate(()=>window.enrollment)).p_batch,batchId);
});
test('Scoped roster shows recorded lesson progress and admin result links remain in admin session',async t=>{
 const p=await open(t,'app',{...assignmentFixture,roster:[{student_id:'learner-id',batch_id:batchId,student_profiles:{full_name:'Learner One'}}],lessons:[{id:'lesson-1',course_id:courseId,is_published:true}],progress:[{lesson_id:'lesson-1',student_id:'learner-id'}]},1440,'/dashboard/admin/teaching/students');
 await p.getByText('1 / 1 published lessons completed').waitFor();assert.match(await p.getByRole('link',{name:'View results & answers'}).getAttribute('href'),/^\/dashboard\/admin\/teaching\/results\?student=learner-id&course=/);await p.getByLabel('Search students').fill('missing');await p.getByText('No students match these filters.').waitFor();
});
test('Missing roster details blocks enrollment controls instead of presenting an empty successful batch',async t=>{
 const p=await open(t,'app',{...assignmentFixture,rosterError:true},390,'/dashboard/admin/assignments');await p.getByLabel('Course',{exact:true}).selectOption(courseId);await p.getByLabel('Batch',{exact:true}).selectOption(batchId);await p.getByRole('alert').filter({hasText:'Roster unavailable'}).waitFor();assert.equal(await p.getByRole('button',{name:'Find student',exact:true}).count(),0);
});

test('Admin sees unassigned learners but excludes staff profiles from student directory',async t=>{
 const p=await open(t,'app',{...assignmentFixture,profiles:[{id:'unassigned-learner',full_name:'New Learner'},{id:teacherId,full_name:'Staff Profile'}]},320,'/dashboard/admin/teaching/students');
 await p.getByRole('heading',{name:'New Learner'}).waitFor();await p.getByText('Not enrolled in a batch yet').waitFor();assert.equal(await p.getByRole('heading',{name:'Staff Profile'}).count(),0);assert.match(await p.getByRole('link',{name:'View results & answers'}).getAttribute('href'),/student=unassigned-learner$/);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});
test('Result deep link filters by student and course while admin answer links stay in admin portal',async t=>{
 const p=await open(t,'app',{session,access:admin,courses:assignmentFixture.courses,results:[{id:'attempt-1',student_id:'learner-id',course_id:courseId,student:'Learner One',test:'DSC Test',score:4,total_marks:10},{id:'attempt-2',student_id:'other-learner',course_id:courseId,student:'Other Learner',test:'DSC Test',score:7,total_marks:10},{id:'attempt-3',student_id:'learner-id',course_id:'other-course',student:'Learner One',test:'Group-II Test',score:9,total_marks:10}]},390,'/dashboard/admin/teaching/results?student=learner-id&course='+courseId);
 await p.getByRole('link',{name:'View answers',exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'View answers',exact:true}).count(),1);assert.equal(await p.getByRole('link',{name:'View answers',exact:true}).getAttribute('href'),'/dashboard/admin/teaching/results?attempt=attempt-1');assert.equal(await p.getByText('Group-II Test',{exact:true}).count(),0);
});

test('Answer review supports one-question navigation without changing automatic scores',async t=>{
 const review={student:'Learner A',test:'DSC Test',program:'DSC',score:2,total_marks:10,questions:[{question_id:'q1',section:'Maths',content:'First saved question',options:[],marks_awarded:1},{question_id:'q2',section:'Science',content:'Second saved question',options:[],marks_awarded:1}]};
 const p=await open(t,'teacher',{session,access:teacher,results:[],review},320,'/dashboard/teacher/results?attempt=navigation');await p.getByText('First saved question',{exact:true}).waitFor();assert.equal(await p.getByText('Second saved question',{exact:true}).count(),0);await p.getByRole('button',{name:'Next question'}).click();await p.getByText('Second saved question',{exact:true}).waitFor();assert.equal(await p.getByText('First saved question',{exact:true}).count(),0);await p.getByRole('button',{name:'Question 1',exact:true}).click();await p.getByText('First saved question',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});



test('teacher dashboard shows assigned materials, ready papers, deliveries and result deep links',async t=>{
 const p=await open(t,'app',{session:{user:{...session.user,user_metadata:{full_name:'KSC Teacher'}}},access:teacher,courses:[{id:courseId,name:'Assigned DSC course'}],lessons:[{id:'lesson',course_id:courseId,title:'Assigned lesson notes',is_published:false},{id:'unassigned',course_id:'other',title:'Outside lesson'}],sharedPapers:[{id:'version',title:'Prepared weekly paper',exam_name:'AP DSC',question_count:100,duration:60,version:2}],deliveries:[{id:'delivery',title:'Scheduled batch practice',course:'Assigned DSC course',batches:['Morning'],opens_at:'2030-01-01'}],results:[{id:'result',student:'Fixture learner',test:'Completed practice',score:40,total_marks:50}]},1440,'/dashboard/teacher');
 await p.getByText('Prepared weekly paper',{exact:true}).waitFor();assert.equal(await p.getByText('Outside lesson',{exact:true}).count(),0);
 assert.equal(await p.getByRole('link',{name:'Edit material →',exact:true}).getAttribute('href'),'/dashboard/teacher/materials?course='+courseId+'&lesson=lesson');
 assert.equal(await p.getByRole('link',{name:'Publish paper →',exact:true}).getAttribute('href'),'/dashboard/teacher/library?paper=version');assert.equal(await p.getByRole('link',{name:'View result →',exact:true}).getAttribute('href'),'/dashboard/teacher/results?attempt=result');await p.getByText('Scheduled',{exact:true}).waitFor();
 assert.equal(await p.locator('a[href^="/dashboard/admin"]').count(),0);assert.equal(await p.locator('.teacher-welcome,.teacher-stats').count(),0);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/teacher-current-dashboard-${width}.png`,fullPage:true})}
})
test('teacher section failures retain library data and recover without reporting false empty courses',async t=>{
 const p=await open(t,'app',{session,access:teacher,courseError:'Assigned courses unavailable',resultsError:'Results unavailable',sharedPapers:[{id:'version',title:'Preserved assigned paper',exam_name:'DSC',question_count:100,duration:60,version:1}]},320,'/dashboard/teacher');await p.getByText('Preserved assigned paper',{exact:true}).waitFor();await p.getByRole('button',{name:'Retry my courses'}).waitFor();assert.equal(await p.getByText('No courses assigned yet',{exact:true}).count(),0);await p.getByRole('button',{name:'Retry student results'}).waitFor();await p.evaluate(()=>{window.fixture.courseError=null;window.fixture.resultsError=null});await p.getByRole('button',{name:'Retry my courses'}).click();await p.getByText('No courses assigned yet',{exact:true}).waitFor();assert.equal(await p.getByRole('alert').count(),0)
})
test('teacher materials route uses current shell, assigned lesson editing and no admin setup links',async t=>{
 const p=await open(t,'app',{session,access:teacher,courses:[{id:courseId,name:'Assigned DSC course'}],lessons:[{id:'lesson',course_id:courseId,title:'Assigned lesson',body:'Reviewed notes',is_published:false}]},390,'/dashboard/teacher/materials?course='+courseId+'&lesson=lesson');await p.getByRole('heading',{name:'Study materials',exact:true}).waitFor();await p.locator('textarea').filter({visible:true}).waitFor();assert.equal(await p.locator('textarea').first().inputValue(),'Reviewed notes');await p.getByText(/Standalone PDF uploads are not available/).waitFor();assert.equal(await p.locator('a[href^="/dashboard/admin"]').count(),0);await p.getByRole('button',{name:'Open navigation'}).click();assert.equal(await p.locator('.admin-sidebar a[aria-current=page]').innerText(),'Study materials');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})



test('student learning uses current shell, published lesson deep links and mobile navigation',async t=>{
 const p=await open(t,'app',{session:{user:{...session.user,user_metadata:{full_name:'Student One'}}},access:{role:'student',state:'active'},courses:[{id:courseId,name:'Enrolled course'}],lessons:[{id:'lesson',course_id:courseId,title:'Published lesson',body:'Reviewed lesson content',is_published:true},{id:'draft',course_id:courseId,title:'Private draft',body:'Hidden content',is_published:false}]},1440,'/dashboard/student/courses?course='+courseId+'&lesson=lesson');await p.getByRole('heading',{name:'Learning',exact:true}).waitFor();await p.getByText('Reviewed lesson content',{exact:true}).waitFor();assert.equal(await p.locator('.student-sidebar a[aria-current=page]').innerText(),'Learning');assert.equal(await p.getByText('Private draft',{exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:'Tests',exact:true}).getAttribute('href'),'/dashboard/student#student-tests');
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/student-portal/learning-current-${width}.png`,fullPage:true})}
})
test('role login destinations open current dashboards while wrong roles and password setup remain gated',async t=>{
 const a=await open(t,'admin-login',{session,access:admin},390,'/admin/login');await a.waitForURL('**/dashboard/admin/overview');const c=await open(t,'creator-login',{session,access:creator},390,'/testcreator/login');await c.getByRole('heading',{name:'Test Creator Login'}).waitFor();assert.equal(new URL(c.url()).pathname,'/testcreator/login');await c.getByRole('button',{name:/Continue to paper preparation/}).click();await c.waitForURL('**/dashboard/testcreator/prepare');const legacy=await open(t,'app',{session,access:creator},390,'/dashboard/testcreator');await legacy.getByRole('button',{name:'Choose file',exact:true}).waitFor();assert.equal(new URL(legacy.url()).pathname,'/dashboard/testcreator/prepare');
 const locked=await open(t,'admin-login',{session,access:{...admin,password_change_required:true}},320,'/admin/login');await locked.getByRole('heading',{name:'Choose your own password'}).waitFor();assert.equal(new URL(locked.url()).pathname,'/admin/login')
})




test('returning creator sees account choice on login with readable desktop and mobile layout',async t=>{
 const p=await open(t,'app',{session:{user:{...session.user,email:'creator.with.long.email.address@ksc.local'}},access:creator},1440,'/testcreator/login');
 await p.getByRole('heading',{name:'Test Creator Login'}).waitFor();await p.getByText('creator.with.long.email.address@ksc.local',{exact:true}).waitFor();
 assert.equal(new URL(p.url()).pathname,'/testcreator/login');assert.equal(await p.getByRole('button',{name:'Choose file',exact:true}).count(),0);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/creator-returning-login-${width}.png`,fullPage:true})}
 await p.getByRole('button',{name:/Continue to paper preparation/}).click();await p.waitForURL('**/dashboard/testcreator/prepare');await p.getByRole('button',{name:'Choose file',exact:true}).waitFor();
})

test('creator switching accounts preserves failed session then allows a fresh sign-in',async t=>{
 const p=await open(t,'creator-login',{session,access:creator,signOutError:true},320,'/testcreator/login');await p.getByRole('button',{name:'Switch account',exact:true}).click();
 await p.getByRole('alert').filter({hasText:'Could not sign out. Please retry.'}).waitFor();await p.getByText(session.user.email,{exact:true}).waitFor();assert.equal(new URL(p.url()).pathname,'/testcreator/login');assert.equal(await p.getByLabel('Password',{exact:true}).count(),0);
 await p.evaluate(()=>window.fixture.signOutError=false);await p.getByRole('button',{name:'Switch account',exact:true}).click();await p.getByLabel('Email address').waitFor();assert.equal(await p.getByLabel('Email address').inputValue(),'');
 await p.getByLabel('Email address').fill('other.creator@ksc.local');await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123');await p.getByRole('button',{name:/Sign in securely/}).click();await p.waitForURL('**/dashboard/testcreator/prepare');assert.equal(await p.evaluate(()=>window.signInCalls),1);
})


test('creator sign-in keeps the selected device paper for the shared-library handoff',async t=>{
 const paperId='11111111-1111-4111-8111-111111111111';const p=await open(t,'creator-login',{session,access:creator},390,'/testcreator/login?paper='+paperId);await p.getByRole('button',{name:/Continue to paper preparation/}).click();await p.waitForURL('**/dashboard/testcreator/prepare?view=library&connect='+paperId);assert.equal(new URL(p.url()).searchParams.get('connect'),paperId)
})

test('assignment setup keeps its program preselection and no longer shows a publishing return banner',async t=>{
 const p=await open(t,'app',{...assignmentFixture,programs:[{id:'dsc',name:'DSC',tracks:[{id:'dsc-track',name:'DSC track'}]}],links:[{course_id:courseId,level_id:'dsc-track'}]},390,'/dashboard/admin/assignments?program=dsc&paper=chosen-version');await p.getByRole('heading',{name:'Students & assignments',exact:true}).waitFor();assert.equal(await p.getByLabel('Program',{exact:true}).inputValue(),'dsc');assert.equal(await p.getByRole('link',{name:/Return to selected paper/}).count(),0);assert.equal(await p.getByText('Set up the test audience').count(),0);await p.getByLabel('Course',{exact:true}).selectOption(courseId);await p.getByLabel('Batch',{exact:true}).selectOption(batchId);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})

test('teacher and admin publish a program paper without course setup or another role approval',async t=>{
 for(const role of ['teacher','admin']){const p=await open(t,'app',{session,access:{role,state:'active',password_change_required:false},courseError:'Course setup must not be loaded',sharedPapers:[{id:'ready-program-version',exam_id:'group-program',exam_name:'Group-II',title:'Group-II approved ready paper',question_count:150,duration:60,marks:1,version:1}]},390,role==='admin'?'/dashboard/admin/teaching/library':'/dashboard/teacher/library');await p.getByRole('heading',{name:'Publish a test',exact:true}).waitFor();await p.getByRole('button',{name:'Publish Group-II approved ready paper',exact:true}).click();await p.getByRole('dialog',{name:'Publish this test?'}).getByRole('button',{name:'Publish now',exact:true}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor();assert.doesNotMatch(await p.locator('.publish-journey').innerText(),/course|batch|audience|setup request|approval/i);assert.equal(await p.getByRole('button',{name:/More actions/}).count(),0);const request=await p.evaluate(()=>window.publishedProgram);assert.equal(request.p_exam,'group-program');assert.equal(request.p_version,'ready-program-version');assert.equal(await p.getByRole('alert').count(),0)}
})

test('teacher dashboard shows new program publications with their program audience',async t=>{
 const p=await open(t,'app',{session,access:teacher,programDeliveries:[{id:'program-publication',title:'Group-II program test',program:'Group-II',opens_at:'2020-01-01'}]},390,'/dashboard/teacher');await p.getByRole('heading',{name:'Group-II program test',exact:true}).waitFor();await p.getByText('Group-II · Program students',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Student results →',exact:true}).getAttribute('href'),'/dashboard/teacher/results')
})
