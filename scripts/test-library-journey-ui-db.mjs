// Real role-scoped PostgreSQL RPCs/RLS behind real creator, library and student UI.
// Identity and selected program are isolated test fixtures; never uses hosted services.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir,mkdir} from 'node:fs/promises'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import JSZip from 'jszip'
import {createLocalKscDb} from './lib/local-draft-db.mjs'

test('creator upload and shared handoff → teacher/admin publishing → enrolled student attempt and result',async t=>{
 const db=await createLocalKscDb()
 let browser
 const pages=[]
 try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  for(const file of ['202610020036_staff_accounts.sql','202610020037_creator_accounts.sql','202610030040_teaching_result_review.sql','202610030042_student_enrollment_audit.sql','202610040043_exam_library_delivery.sql','202610060044_library_archive.sql','202610060045_simple_library_sharing.sql'])db.applyMigration(file)
  const admin=db.teacher,teacher=db.otherTeacher,creator=randomUUID(),student=randomUUID(),outsider=randomUUID(),idle=randomUUID()
  await db.pool.query("UPDATE ksc_staff_access SET state='active',password_change_required=false,role=CASE WHEN user_id=$1 THEN 'admin' ELSE 'teacher' END",[admin])
  for(const [id,email] of [[creator,'journey.creator@ksc.local'],[student,'journey.student@ksc.local'],[outsider,'journey.outsider@ksc.local'],[idle,'journey.idle@ksc.local']])await db.pool.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[id,email])
  await db.pool.query("INSERT INTO ksc_staff_access(user_id,full_name,role,state,password_change_required) VALUES($1,'Journey Creator','creator','active',false)",[creator])
  await db.pool.query('INSERT INTO ksc_creator_exams VALUES($1,$2)',[creator,db.catalogue.examId])
  await db.pool.query("INSERT INTO ksc_staff_access(user_id,full_name,role,state,password_change_required) VALUES($1,'Journey Unassigned','teacher','active',false)",[idle])
  const program=(await db.pool.query('SELECT name FROM exams WHERE id=$1',[db.catalogue.examId])).rows[0].name
  const rpc=(uid,name,args={})=>db.runner.rpc(uid,name,args)
  const course=await rpc(admin,'ksc_create_course',{p_institute:'00000000-0000-4000-8000-000000000001',p_name:'Journey preparation',p_description:''})
  // Link the course to its program track the way the admin setup page does: under the admin's own RLS scope.
  const link=uid=>db.runner.asUser(uid,conn=>conn.query('INSERT INTO public.ksc_course_tracks(course_id,level_id) VALUES($1,$2)',[course,db.catalogue.levelId]))
  await assert.rejects(link(teacher),/row-level security/);await link(admin)
  const batch=await rpc(admin,'ksc_create_batch',{p_course:course,p_name:'Selected students'}),other=await rpc(admin,'ksc_create_batch',{p_course:course,p_name:'Other students'})
  await rpc(admin,'ksc_staff_assign',{p_user:teacher,p_courses:[course],p_batches:[batch],p_version:1})
  await rpc(admin,'ksc_enroll_student',{p_batch:batch,p_email:'journey.student@ksc.local'})
  await rpc(admin,'ksc_enroll_student',{p_batch:other,p_email:'journey.outsider@ksc.local'})
  const cssName=(await readdir('dist/assets')).find(f=>f.endsWith('.css')),css=await readFile('dist/assets/'+cssName,'utf8'),logo=await readFile('public/ksc/institute-logo.png')
  const transport=`export const isSupabaseConfigured=true;
   const request=(kind,body)=>{const promise=window.bridge({kind,...body});return {then:(r,j)=>promise.then(r,j),abortSignal:()=>({then:(r,j)=>promise.then(r,j)})}};
   export const supabase={rpc:(name,args={})=>request('rpc',{name,args}),from:table=>{const body={table,filters:[],orders:[],columns:'*',single:false};const q={select:(columns,options)=>{body.columns=columns;body.head=options?.head===true;return q},eq:(key,value)=>{body.filters.push({key,value});return q},order:(key,options={})=>{body.orders.push({key,ascending:options.ascending!==false});return q},single:()=>{body.single=true;return q},maybeSingle:()=>{body.single=true;body.optional=true;return q},then:(r,j)=>request('query',body).then(r,j)};return q}};`
  const entry=`import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
   import Creator from './src/pages/staff/LocalLibraryPreview.jsx';import Library from './src/pages/staff/ExamLibraryWorkspace.jsx';import StaffGate from './src/components/auth/StaffGate.jsx';import StaffWorkspace from './src/pages/staff/StaffWorkspace.jsx';
   import Dashboard from './src/pages/student/StudentDashboardPage.jsx';import Instructions from './src/pages/student/TestInstructions.jsx';import Attempt from './src/pages/student/ExamWorkspace.jsx';import Result from './src/pages/student/TestResult.jsx';
   import {localLibrary} from './src/services/localExamLibrary.js';window.readBrowserLibrary=()=>localLibrary('read');
   function Journey(){const [path,setPath]=useState(location.pathname);useEffect(()=>{const update=()=>setPath(location.pathname);addEventListener('popstate',update);return()=>removeEventListener('popstate',update)},[]);const actor=window.actor;
    if(actor.role==='creator')return <StaffGate role='creator'><Creator connected account={actor.user}/></StaffGate>;
    if(actor.role==='teacher'||actor.role==='admin')return <StaffGate role={actor.role}><StaffWorkspace role={actor.role}><Library adminView={actor.role==='admin'} basePath={actor.role==='admin'?'/dashboard/admin/teaching':'/dashboard/teacher'}/></StaffWorkspace></StaffGate>;
    const match=path.match(new RegExp('^/test/([^/]+)/(instructions|attempt|result)$'));return match?match[2]==='instructions'?<Instructions testId={match[1]}/>:match[2]==='attempt'?<Attempt testId={match[1]}/>:<Result testId={match[1]}/>:<Dashboard/>;
   }createRoot(document.getElementById('root')).render(<Journey/>);`
  const bundle=(await build({stdin:{contents:entry,loader:'jsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('http://127.0.0.1:55555/journey.js')},plugins:[{name:'local-transport',setup(b){
   b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'transport',namespace:'journey'}))
   b.onResolve({filter:/AuthContext\.jsx$/},()=>({path:'auth',namespace:'journey'}))
   b.onResolve({filter:/StudentProgramGate\.jsx$/},()=>({path:'program',namespace:'journey'}))
   b.onResolve({filter:/learningService\.js$/},()=>({path:'learning',namespace:'journey'}))
   b.onLoad({filter:/.*/,namespace:'journey'},({path})=>({loader:'js',contents:path==='transport'?transport:path==='auth'?`export const useAuth=()=>({user:window.actor.user,loading:false,signOut:async()=>({error:null})});`:path==='program'?`export const useStudentProgram=()=>({selection:window.actor.selection,enrolled:[{level_id:window.actor.selection?.level_id}]});`:`export const learningService={programCourses:async()=>[],courses:async()=>[],completions:async()=>[]};`}))
  }}]})).outputFiles[0].text
  browser=await chromium.launch({headless:true})
  const calls=[],errors=[]
  const tables=new Set(['student_profiles','tests','test_attempts','test_question_snapshots','test_option_snapshots','attempt_answers'])
  const identifier=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"'}
  async function open(uid,role,path){
   const context=await browser.newContext({viewport:{width:1440,height:1000}});t.after(()=>context.close())
   await context.exposeBinding('bridge',async(_,body)=>{
    calls.push({uid,...body})
    try{
     if(body.kind==='rpc')return {data:await rpc(uid,body.name,body.args),error:null}
     assert.ok(tables.has(body.table),'Unexpected table: '+body.table)
     const data=await db.runner.asUser(uid,async c=>{
      const values=[],where=body.filters.map(({key,value})=>{values.push(value);return `t.${identifier(key)}=$${values.length}`})
      const nested=body.table==='test_attempts'&&body.columns.includes('tests(')
      const sql=`SELECT t.*${nested?',(SELECT row_to_json(test) FROM public.tests test WHERE test.id=t.test_id) AS tests':''} FROM public.${identifier(body.table)} t${where.length?' WHERE '+where.join(' AND '):''}${body.orders.length?' ORDER BY '+body.orders.map(o=>'t.'+identifier(o.key)+(o.ascending?' ASC':' DESC')).join(','):''}`
      return (await c.query(sql,values)).rows
     })
     if(body.head)return {data:null,count:data.length,error:null}
     if(body.single&&!body.optional&&data.length!==1)return {data:null,error:{message:'This test is unavailable for this account.',code:'PGRST116'}}
     return {data:body.single?data[0]||null:data,error:null}
    }catch(e){return {data:null,error:{message:e.message,code:e.code}}}
   })
   const actor={role,user:{id:uid,email:'journey.'+role+'@ksc.local',user_metadata:{full_name:'Journey '+role}},selection:role==='student'?{exam_id:db.catalogue.examId,level_id:db.catalogue.levelId,program:'Journey program',track:'Journey track'}:null}
   await context.route('**/*',r=>{const url=new URL(r.request().url());if(url.origin!=='http://127.0.0.1:55555')return r.abort();if(url.pathname==='/ksc/institute-logo.png')return r.fulfill({contentType:'image/png',body:logo});return r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>${css}</style><div id='root'></div><script>window.actor=${JSON.stringify(actor)}</script><script>${bundle.replaceAll('</script','<\/script')}</script>`})})
   const page=await context.newPage();pages.push(page);page.setDefaultTimeout(12000);page.on('pageerror',e=>{errors.push(e.message);console.error('Isolated browser error:',e.message)});await page.goto('http://127.0.0.1:55555'+path);return page
  }
  await mkdir('scratch/library-journey',{recursive:true})
  async function proof(page,name){for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' overflows at '+width);await page.screenshot({path:`scratch/library-journey/${name}-${width}.png`,fullPage:true})}await page.setViewportSize({width:1440,height:1000})}
  const c=await open(creator,'creator','/dashboard/testcreator/prepare')
  await c.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor()
  await c.getByRole('button',{name:'My exam access',exact:true}).click();await c.getByRole('heading',{name:'My exam access',exact:true}).waitFor()
  await c.getByRole('region',{name:'Assigned institute programs'}).getByText(program,{exact:true}).waitFor();assert.equal(new URL(c.url()).pathname,'/dashboard/testcreator/prepare');await proof(c,'creator-access')
  await c.getByRole('button',{name:'Prepare a paper',exact:true}).click();await c.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor()
  await c.getByLabel('Paper title',{exact:true}).fill('Journey source paper')
  await c.getByLabel('Exam collection',{exact:true}).selectOption('SI & Constable')
  await c.getByLabel('Duration (minutes)').fill('30');await c.getByLabel('Marks per question',{exact:true}).fill('0.5')
  const zip=new JSZip()
  zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${['1. What is two plus two?','A) 4    B) 5    C) 6    D) 7','2. What is three plus three?','A) 4    B) 5    C) 6    D) 7'].map((text,i)=>`<w:p><w:r>${i%2===0?'<w:rPr><w:b/></w:rPr>':''}<w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  await c.getByLabel('Source paper',{exact:true}).setInputFiles({name:'journey-paper.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await zip.generateAsync({type:'nodebuffer'})})
  await c.getByRole('button',{name:'Prepare paper',exact:true}).click();await c.getByText('Question 1',{exact:true}).waitFor()
  assert.equal(await c.locator('.lp-status').innerText(),'Needs review');assert.match(await c.locator('.lp-steps li.current').innerText(),/Questions & answers/);assert.equal(await c.getByRole('button',{name:'Save to institute library',exact:true}).isEnabled(),false)
  // Complete missing source answers through the same creator controls used for real papers.
  await c.getByRole('radio',{name:'1',exact:true}).check();await c.getByLabel('Go to question',{exact:true}).selectOption({label:'2'});await c.getByText('Question 2',{exact:true}).waitFor();await c.getByRole('radio',{name:'3',exact:true}).check()
  assert.equal(await c.locator('.lp-status').innerText(),'Final check needed');assert.match(await c.locator('.lp-steps li.current').innerText(),/Save to library/)
  assert.match(await c.locator('.lp-destination').innerText(),new RegExp('Saving to institute program: '+program.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
  await c.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check();assert.equal(await c.locator('.lp-status').innerText(),'Ready to save');await proof(c,'creator-ready');assert.equal(await c.getByRole('button',{name:'Save to institute library',exact:true}).isEnabled(),true)
  await c.getByRole('button',{name:'Save to institute library',exact:true}).click();await c.getByRole('region',{name:'Shared institute library'}).getByText('Journey source paper',{exact:true}).waitFor()
  assert.equal(await c.getByRole('button',{name:/Publish/}).count(),0)
  const saved=await c.evaluate(()=>window.readBrowserLibrary());assert.equal(saved.drafts.length,1);assert.equal(saved.ready.length,1);assert.ok(saved.ready[0].sharedReceipt)
  await c.reload();await c.getByRole('button',{name:'Paper library',exact:true}).click();await c.getByRole('region',{name:'Shared institute library'}).getByText('Journey source paper',{exact:true}).waitFor();await proof(c,'creator-shared')
  const version=(await rpc(teacher,'ksc_exam_library_list'))[0];assert.equal(version.question_count,2);assert.equal(version.marks,.5);assert.ok(!JSON.stringify(version).includes('correct'))
  const s=await open(student,'student','/dashboard/student#student-tests');await s.getByRole('heading',{name:'No tests to start yet',exact:true}).waitFor()
  const a=await open(admin,'admin','/dashboard/admin/teaching/library');await a.getByRole('heading',{name:'Journey source paper',exact:true}).waitFor()
  const u=await open(idle,'teacher','/dashboard/teacher/library');await u.getByRole('heading',{name:'Journey source paper',exact:true}).waitFor();await u.getByRole('button',{name:'Publish this paper',exact:true}).click();await u.getByRole('heading',{name:'No matching course yet',exact:true}).waitFor();assert.equal(await u.getByRole('button',{name:'Review delivery',exact:true}).isEnabled(),false)
  assert.equal((await rpc(idle,'ksc_exam_library_list')).length,1);assert.deepEqual(await rpc(idle,'ksc_library_audiences',{p_version:version.id}),[])
  await assert.rejects(rpc(idle,'ksc_teacher_publish_library',{p_version:version.id,p_course:course,p_batches:[batch],p_settings:{title:'Blocked',review_policy:'AFTER_SUBMISSION',opens_at:null,closes_at:null,level_id:db.catalogue.levelId},p_request:randomUUID()}),/Assigned course/)
  const p=await open(teacher,'teacher','/dashboard/teacher/library');await p.getByRole('heading',{name:'Journey source paper',exact:true}).waitFor();await p.getByRole('button',{name:'Publish this paper',exact:true}).click()
  const panel=p.getByRole('dialog',{name:'Publish library paper'});await panel.getByRole('checkbox',{name:'Selected students 1 enrolled students'}).waitFor();assert.equal(await panel.getByRole('checkbox',{name:/Other students/}).count(),0)
  await panel.getByLabel('Student test title').fill('Journey weekly practice');await panel.getByRole('button',{name:'Review delivery',exact:true}).click();await panel.getByText('1 enrolled student',{exact:true}).waitFor();await proof(p,'teacher-review')
  await panel.getByRole('button',{name:'Publish to students',exact:true}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor()
  const deliveries=await rpc(teacher,'ksc_library_deliveries'),testId=deliveries[0].test_id;assert.equal(deliveries.length,1)
  await p.getByRole('button',{name:'View published tests',exact:true}).click();await p.getByRole('heading',{name:'Journey weekly practice',exact:true}).waitFor()
  await a.getByRole('button',{name:'Refresh library',exact:true}).click();await a.getByRole('button',{name:'Published tests',exact:true}).click();await a.getByRole('heading',{name:'Journey weekly practice',exact:true}).waitFor()
  await s.getByRole('button',{name:'Refresh tests',exact:true}).click();await s.getByRole('heading',{name:'Journey weekly practice',exact:true}).waitFor();await s.getByText('2 questions · 30 minutes · 1 mark',{exact:true}).waitFor();await proof(s,'student-available')
  const o=await open(outsider,'student','/dashboard/student#student-tests');await o.getByRole('heading',{name:'No tests to start yet',exact:true}).waitFor();assert.equal(await o.getByRole('heading',{name:'Journey weekly practice',exact:true}).count(),0)
  await assert.rejects(rpc(outsider,'start_test_attempt',{p_test_id:testId}),/not available/)
  await o.goto('http://127.0.0.1:55555/test/'+testId+'/instructions');await o.getByRole('heading',{name:'This test is not available',exact:true}).waitFor();assert.doesNotMatch(await o.locator('body').innerText(),/Error:|PGRST|JSON object|Journey weekly practice/);await proof(o,'student-unavailable')
  await o.getByRole('button',{name:'Back to my tests',exact:true}).click();await o.getByRole('heading',{name:'No tests to start yet',exact:true}).waitFor()
  await s.getByRole('link',{name:'Start test',exact:true}).click();await s.getByRole('heading',{name:'Journey weekly practice',exact:true}).waitFor();await s.getByRole('button',{name:'Start Test',exact:true}).click()
  await s.getByRole('group',{name:'Your answer'}).waitFor();assert.equal(await s.getByText('What is two plus two?',{exact:false}).count()>0,true)
  await s.getByRole('button',{name:'Option 1',exact:true}).click();await s.getByRole('button',{name:'Save & Next',exact:true}).click();await s.getByRole('button',{name:'Option 3',exact:true}).click();await s.getByText('Saved',{exact:true}).waitFor()
  await s.reload();await s.getByRole('group',{name:'Your answer'}).waitFor();assert.equal(await s.getByRole('button',{name:'Option 1',exact:true}).getAttribute('aria-pressed'),'true');await proof(s,'student-resume')
  await s.getByRole('button',{name:'Submit Test',exact:true}).first().click();await s.getByRole('button',{name:'Confirm Submit',exact:true}).click();await s.getByRole('heading',{name:'Test Result',exact:true}).waitFor();await proof(s,'student-result')
  const attempt=(await db.pool.query('SELECT * FROM test_attempts WHERE student_id=$1 AND test_id=$2',[student,testId])).rows[0];assert.equal(attempt.status,'SUBMITTED');assert.equal(attempt.score,1);assert.equal(attempt.max_score,1)
  assert.equal((await db.runner.asUser(student,conn=>conn.query('SELECT * FROM test_answer_key_snapshots'))).rows.length,0)
  await a.getByRole('button',{name:'Ready papers',exact:true}).click();await a.getByRole('button',{name:'Publish this paper',exact:true}).click();const adminPanel=a.getByRole('dialog',{name:'Publish library paper'});await adminPanel.getByRole('checkbox',{name:'Other students 1 enrolled students'}).check();await adminPanel.getByLabel('Student test title').fill('Journey admin practice');await adminPanel.getByRole('button',{name:'Review delivery',exact:true}).click();await adminPanel.getByRole('button',{name:'Publish to students',exact:true}).click();await a.getByRole('heading',{name:'Test published',exact:true}).waitFor()
  await o.getByRole('button',{name:'Refresh tests',exact:true}).click();await o.getByRole('heading',{name:'Journey admin practice',exact:true}).waitFor()
  const adminDeliveries=await rpc(admin,'ksc_library_deliveries');assert.equal(adminDeliveries.length,2)
  const adminTest=adminDeliveries.find(d=>d.title==='Journey admin practice').test_id
  await o.getByRole('link',{name:'Start test',exact:true}).click();await o.getByRole('heading',{name:'Journey admin practice',exact:true}).waitFor()
  await db.pool.query("UPDATE ksc_private.library_deliveries SET closes_at=now()-interval '1 minute' WHERE test_id=$1",[adminTest])
  await o.getByRole('button',{name:'Start Test',exact:true}).click();await o.getByRole('alert').getByText(/not open for your batch right now/).waitFor();assert.equal(await o.getByRole('button',{name:'Start Test',exact:true}).isEnabled(),true)
  assert.equal(Number((await db.pool.query('SELECT count(*) FROM test_attempts WHERE student_id=$1',[outsider])).rows[0].count),0)
  // A later creator version never changes a test students already received.
  const frozen=async()=>JSON.stringify([(await db.pool.query('SELECT * FROM test_question_snapshots WHERE test_id=$1 ORDER BY sort_order',[testId])).rows,(await db.pool.query('SELECT * FROM test_option_snapshots WHERE test_id=$1 ORDER BY question_id,sort_order',[testId])).rows,(await db.pool.query('SELECT paper FROM ksc_private.library_versions WHERE id=$1',[version.id])).rows])
  const before=await frozen(),original=JSON.parse(before)[2][0].paper
  await c.getByRole('button',{name:'Bring back Journey source paper',exact:true}).click();await c.getByRole('button',{name:'Share to library',exact:true}).waitFor();assert.equal((await rpc(teacher,'ksc_exam_library_list')).length,0);assert.equal(await frozen(),before)
  await c.getByRole('button',{name:'Share to library',exact:true}).click();await c.getByRole('region',{name:'Shared institute library'}).getByText('Journey source paper',{exact:true}).waitFor();assert.equal((await rpc(teacher,'ksc_exam_library_list'))[0].id,version.id);assert.equal(await frozen(),before)
  const revised={...original,id:randomUUID(),version:2,title:'Journey source paper (revised)',questions:original.questions.map(q=>({...q,content:q.content.replace('two plus two','nine plus nine')}))}
  await rpc(creator,'ksc_library_add_ready',{p_request:revised.id,p_exam:db.catalogue.examId,p_level:null,p_paper:revised})
  assert.equal((await rpc(admin,'ksc_exam_library_list')).length,2);assert.equal(await frozen(),before)
  await c.getByRole('button',{name:'Refresh shared library',exact:true}).click();await c.getByRole('region',{name:'Shared institute library'}).getByText(revised.title,{exact:true}).waitFor()
  c.once('dialog',dialog=>dialog.accept());await c.getByRole('button',{name:'Delete shared paper Journey source paper',exact:true}).click();await c.waitForFunction(()=>!Array.from(document.querySelectorAll('[aria-label="Shared institute library"] strong')).some(e=>e.textContent==='Journey source paper'))
  assert.equal((await rpc(admin,'ksc_exam_library_list')).length,1);assert.equal((await rpc(teacher,'ksc_exam_library_list')).length,1);assert.equal(await frozen(),before)
  await p.getByRole('button',{name:'Refresh library',exact:true}).click();await p.getByRole('button',{name:'Ready papers',exact:true}).click();await p.getByRole('heading',{name:revised.title,exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'Journey source paper',exact:true}).count(),0)
  await s.reload();await s.getByRole('heading',{name:'Test Result',exact:true}).waitFor();assert.equal((await db.pool.query('SELECT score FROM test_attempts WHERE id=$1',[attempt.id])).rows[0].score,1)
  assert.equal(Number((await db.pool.query('SELECT count(*) FROM ksc_private.library_deliveries')).rows[0].count),2)
  assert.ok(calls.some(call=>call.uid===creator&&call.name==='ksc_library_add_ready'));assert.ok(calls.some(call=>call.uid===teacher&&call.name==='ksc_teacher_publish_library'));assert.ok(calls.some(call=>call.uid===admin&&call.name==='ksc_teacher_publish_library'));assert.deepEqual(errors,[])
 }catch(error){for(const page of pages)console.error('Isolated journey page:',page.url(),(await page.locator('body').innerText().catch(()=>'' )).slice(-6500));throw error}
 finally{await browser?.close();await db.stop()}
})
