import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir} from 'node:fs/promises'
let browser,bundle,styles
before(async()=>{
 const css=(await readdir('dist/assets')).find(f=>f.endsWith('.css'));styles=await readFile('dist/assets/'+css,'utf8')
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthProvider} from './src/context/AuthContext.jsx';import Dashboard from './src/pages/student/StudentDashboardPage.jsx';import Gate from './src/components/auth/StudentProgramGate.jsx';createRoot(document.getElementById('root')).render(<AuthProvider>{window.fixture.programState?<Gate><Dashboard/></Gate>:<Dashboard/>}</AuthProvider>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'offline-student',setup(b){
  b.onResolve({filter:/\/(supabaseClient|learningService|studentExamService|resultService)\.js$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='supabaseClient.js'?`
   const f=()=>window.fixture;export const isSupabaseConfigured=true;export const supabase={rpc:async()=>({data:f().programState}),auth:{getSession:async()=>({data:{session:{user:{id:'student',email:'learner@ksc.test'}}}}),onAuthStateChange:cb=>{window.authCallback=cb;return {data:{subscription:{unsubscribe(){}}}}},signOut:async()=>{window.signOutCalls=(window.signOutCalls||0)+1;if(f().signOutError)return {error:{message:'Offline'}};window.authCallback('SIGNED_OUT',null);return {error:null}}},from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>{if(f().profileError)return {error:{message:'Offline'}};return {data:f().missingProfile?null:{id:'student',full_name:'Arjun'}}}};return q}};`
   :args.path==='learningService.js'?`export const learningService={programCourses:async level=>{window.scopedLevel=level;return window.fixture.courses},courses:async()=>{if(window.fixture.courseError)throw Error('Offline');return window.fixture.courses},completions:async id=>{window.progressUser=id;return [{lesson_id:'done'},{lesson_id:'done'}]},lessons:async id=>{if(window.fixture.badCourse===id)throw Error('Offline');return window.fixture.lessons[id]||[]}};`
   :args.path==='studentExamService.js'?`export const studentExamService={getAvailableTests:async()=>{window.testsLoaded=(window.testsLoaded||0)+1;if(window.fixture.testError)throw Error('Offline');return window.fixture.tests},getMyAttempts:async()=>window.fixture.attempts,getQuestionCounts:async ids=>{if(window.fixture.countError)throw Error('Count unavailable');return Object.fromEntries(ids.filter(id=>window.fixture.questionCounts?.[id]).map(id=>[id,window.fixture.questionCounts[id]]))}};`
   :`export const resultValue=value=>value==null?'Unavailable':value;export const resultService={triggerExpiredFinalization:async()=>{window.finalizationCalls=(window.finalizationCalls||0)+1}};`
  }))
 }}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(async()=>browser?.close())
const fixtures=()=>({courses:[{id:'c1',name:'Sainik School · Mathematics',description:'Your mathematics learning space'},{id:'c2',name:'Science'}],lessons:{c1:[{id:'draft',title:'Unpublished secret',is_published:false},{id:'done',title:'Number system',is_published:true},{id:'next',title:'Integers – Introduction and Properties',is_published:true}],c2:[]},tests:[{id:'t1',name:'Weekly Practice Test – 05',exams:{name:'Sainik School'},duration_minutes:60,total_marks:100},{id:'t2',name:'Science chapter test',exams:{name:'Sainik School'},duration_minutes:30,total_marks:50},{id:'past',name:'Already attempted test'}],attempts:[{id:'a1',test_id:'past',status:'SUBMITTED',tests:{name:'Weekly Test 04',exams:{name:'Sainik School'}},score:78,max_score:100,submitted_at:'2026-10-01T10:00:00Z'},{id:'a2',test_id:'pending',status:'IN_PROGRESS',tests:{name:'Maths Practice Test',exams:{name:'Sainik School'}}}]})
async function open(t,patch={},width=1440){
 const context=await browser.newContext({viewport:{width,height:980}});t.after(()=>context.close())
 await context.route('**/*',async r=>{
  const url=new URL(r.request().url());if(url.hostname!=='ksc.test')return r.abort()
  if(url.pathname.startsWith('/brand/'))return r.fulfill({contentType:'image/png',body:await readFile('public'+url.pathname)})
  return r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>'})
 })
 const p=await context.newPage();p.setDefaultTimeout(6000)
 const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]))
 await p.goto('http://ksc.test/dashboard/student');await p.addStyleTag({content:styles});await p.evaluate(f=>window.fixture=f,{...fixtures(),...patch});await p.addScriptTag({content:bundle})
 await p.getByRole('heading',{name:patch.missingProfile?'Profile Incomplete':'Hello, Arjun'}).waitFor();return p
}
test('reference dashboard uses original logo, scoped lessons and actual scores at desktop/mobile widths',async t=>{
 for(const width of [1440,390,320]){
  const p=await open(t,{},width)
  await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor()
  assert.equal(await p.getByRole('link',{name:'Continue learning',exact:true}).getAttribute('href'),'/dashboard/student/courses?course=c1&lesson=next')
  assert.equal(await p.getByRole('progressbar').getAttribute('max'),'2');assert.equal(await p.getByRole('progressbar').getAttribute('value'),'1')
  assert.equal(await p.getByText('Unpublished secret',{exact:true}).count(),0)
  await p.getByText('78 / 100',{exact:true}).waitFor()
  assert.equal(await p.getByRole('link',{name:/Start test/}).first().getAttribute('href'),'/test/t1/instructions')
  assert.equal(await p.getByRole('link',{name:/Resume/}).getAttribute('href'),'/test/pending/attempt')
  assert.equal(await p.locator('.student-result-list>a').getAttribute('href'),'/test/past/result')
  assert.equal(await p.locator('.student-available-grid article').count(),2)
  assert.equal(await p.evaluate(()=>window.progressUser),'student')
  await p.locator('.student-logo img').evaluate(img=>img.decode())
  assert.equal(await p.getByAltText('AaryaRushi Education logo').getAttribute('src'),'/ksc/institute-logo.png')
  if(width<800){await p.getByRole('button',{name:'Open navigation'}).click();await p.getByRole('navigation',{name:'Student navigation'}).waitFor();await p.getByRole('button',{name:'Close navigation'}).click()}
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await p.screenshot({path:`scratch/student-portal/student-portal-${width}.png`,fullPage:true})
  if(width===1440)await p.screenshot({path:'scratch/student-portal/student-portal-preview.png'})
 }
})
test('Test Portal stays in the dashboard and refreshed DSC papers can start or resume directly',async t=>{
 const state={selection:{exam_id:'dsc',level_id:'sgt',program:'DSC',track:'SGT',available:true,version:1},enrolled:[{level_id:'sgt'}]}
 const p=await open(t,{courses:[],tests:[],attempts:[],programState:state})
 await p.getByRole('heading',{name:'No tests to start yet'}).waitFor()
 const nav=p.getByRole('navigation',{name:'Student navigation'}).getByRole('link',{name:'Tests',exact:true})
 assert.equal(await nav.getAttribute('href'),'/dashboard/student#student-tests')
 await p.evaluate(()=>{window.fixture.tests=[{id:'dsc-admin',name:'DSC divisional · Admin',exam_id:'dsc',level_id:'sgt',test_kind:'MODEL',total_marks:100,duration_minutes:60},{id:'dsc-one',name:'DSC single mark check',exam_id:'dsc',level_id:'sgt',test_kind:'MODEL',total_marks:1,duration_minutes:5}];window.fixture.questionCounts={'dsc-admin':100}})
 await nav.click();await p.getByRole('heading',{name:'DSC divisional · Admin',exact:true}).waitFor()
 // Cards show the question count when it is known and never block on a failed count.
 await p.getByText('100 questions · 60 minutes · 100 marks',{exact:true}).waitFor();await p.getByText('5 minutes · 1 mark',{exact:true}).waitFor()
 await p.evaluate(()=>{window.fixture.countError=true;window.fixture.tests=window.fixture.tests.slice(0,1)});await p.getByRole('button',{name:'Refresh tests',exact:true}).click();await p.getByRole('heading',{name:'DSC divisional · Admin',exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'DSC single mark check',exact:true}).count(),0);await p.evaluate(()=>{window.fixture.countError=false})
 assert.equal(new URL(p.url()).pathname,'/dashboard/student');assert.equal(new URL(p.url()).hash,'#student-tests')
 assert.equal(await p.getByRole('link',{name:'Start test',exact:true}).getAttribute('href'),'/test/dsc-admin/instructions')
 assert.equal(await p.getByRole('button',{name:'Full Mock Tests'}).count(),0)
 await p.evaluate(()=>window.fixture.attempts=[{id:'attempt',test_id:'dsc-admin',status:'IN_PROGRESS',tests:{name:'DSC divisional · Admin',exam_id:'dsc',level_id:'sgt'}}])
 await p.getByRole('button',{name:'Refresh tests',exact:true}).click();await p.getByRole('link',{name:'Resume test',exact:true}).waitFor()
 assert.equal(await p.getByRole('link',{name:'Start test',exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:'Resume test',exact:true}).getAttribute('href'),'/test/dsc-admin/attempt')
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:980});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
})
test('portal search filters courses, available tests and results and can be cleared',async t=>{
 const p=await open(t);await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor()
 await p.getByLabel('Search your courses and tests').fill('Science')
 assert.equal(await p.locator('.student-available-grid article').count(),1)
 assert.equal(await p.locator('.student-course-progress article').count(),1)
 await p.getByText('No results match your search',{exact:true}).waitFor()
 await p.getByRole('button',{name:'Clear search'}).click();assert.equal(await p.locator('.student-available-grid article').count(),2)
})
test('new accounts show honest empty states without fabricated progress, attendance or dates',async t=>{
 const p=await open(t,{courses:[],tests:[],attempts:[]},320)
 await p.getByText('No courses assigned yet. Your institute will enroll you into a batch.').waitFor()
 await p.getByText('Your admin or teacher will publish tests for this program here.').waitFor()
 await p.getByText("You haven't completed any tests yet.").waitFor()
 assert.equal(await p.locator('progress').count(),0)
 assert.equal(await p.getByText(/83%|75%|60% completed|17 MAY|Classes Attended/).count(),0)
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await p.screenshot({path:'scratch/student-portal/student-empty-320.png',fullPage:true})
})
test('test failures retain course learning and retry recovers while course failures stay distinct from no enrollment',async t=>{
 const p=await open(t,{testError:true})
 await p.getByRole('heading',{name:'Could not load tests and results'}).waitFor();await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor()
 await p.evaluate(()=>window.fixture.testError=false);await p.getByRole('button',{name:'Retry tests and results'}).click();await p.getByText('78 / 100',{exact:true}).waitFor()
 const bad=await open(t,{courseError:true})
 await bad.getByRole('alert').filter({hasText:'Course progress could not be loaded.'}).first().waitFor()
 assert.equal(await bad.getByText(/No courses assigned/).count(),0)
 await bad.evaluate(()=>window.fixture.courseError=false);await bad.getByRole('button',{name:'Retry course progress'}).click();await bad.getByRole('link',{name:'Continue learning',exact:true}).waitFor()
})
test('partial course failure preserves other learning and missing scores are not shown as zero',async t=>{
 const f=fixtures();f.attempts[0].score=null
 const p=await open(t,{badCourse:'c1',attempts:f.attempts});await p.getByRole('alert').filter({hasText:'Progress unavailable for this course.'}).waitFor()
 await p.getByText('Unavailable / 100',{exact:true}).waitFor();await p.getByRole('heading',{name:'Science',exact:true}).first().waitFor()
})
test('missing student profile retains institute branding and blocks test loading; failed logout retains portal',async t=>{
 const p=await open(t,{missingProfile:true})
 await p.getByRole('heading',{name:'Profile Incomplete'}).waitFor();assert.equal(await p.evaluate(()=>window.testsLoaded||0),0)
 const bad=await open(t,{signOutError:true});await bad.getByRole('button',{name:'Sign out / switch account'}).click();await bad.getByRole('alert').filter({hasText:'Sign out failed'}).waitFor();assert.equal(new URL(bad.url()).pathname,'/dashboard/student')
 await bad.evaluate(()=>window.fixture.signOutError=false);await bad.getByRole('button',{name:'Sign out / switch account'}).click();await bad.waitForURL('**/login')
})
test('saved program isolates tests, scores and unfinished attempts without deleting history',async t=>{
 const f=fixtures();f.tests[0].exam_id='sainik';f.tests[0].level_id='vi';f.tests[1].exam_id='sainik';f.tests[1].level_id='ix'
 const p=await open(t,{tests:f.tests,programState:{selection:{exam_id:'sainik',level_id:'vi',program:'Sainik School',track:'Class VI',available:true,version:1},enrolled:[]}})
 await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.scopedLevel),'vi');assert.equal(await p.locator('.student-available-grid article').count(),1)
 assert.equal(await p.getByText('78 / 100',{exact:true}).count(),0);assert.equal(await p.getByRole('link',{name:/Resume/}).count(),0);assert.equal(await p.locator('.student-result-list>a').count(),0);assert.equal(await p.getByRole('link',{name:/Switch program/}).getAttribute('href'),'/dashboard/student/program')
})



test('DSC, Group-II and SI dashboards contain only their own tests/results, including during program changes',async t=>{
 const tests=['dsc','group2','si'].map(program=>({id:program+'-new',name:program+' new test',exam_id:program,level_id:program+'-general',exams:{name:program}}))
 const attempts=['dsc','group2','si'].flatMap(program=>[{id:program+'-done',test_id:program+'-past',status:'SUBMITTED',score:1,max_score:150,tests:{name:program+' result',exam_id:program,level_id:program+'-general'}},{id:program+'-resume',test_id:program+'-ongoing',status:'IN_PROGRESS',tests:{name:program+' ongoing',exam_id:program,level_id:program+'-general'}}])
 for(const program of ['dsc','group2','si']){
  const p=await open(t,{tests,attempts,programState:{selection:{exam_id:program,level_id:program+'-general',program,track:'General preparation',available:true,version:1},enrolled:[]}})
  await p.getByText(program+' result',{exact:true}).waitFor()
  assert.equal(await p.locator('.student-result-list>a').count(),1);assert.equal(await p.locator('.student-resume a').count(),1);assert.equal(await p.locator('.student-available-grid article').count(),1)
  for(const other of ['dsc','group2','si'].filter(x=>x!==program)){assert.equal(await p.getByText(other+' result',{exact:true}).count(),0);assert.equal(await p.getByText(other+' ongoing',{exact:true}).count(),0);assert.equal(await p.getByText(other+' new test',{exact:true}).count(),0)}
  assert.equal(await p.locator('.student-result-list>a').count(),1);assert.equal(await p.locator('.student-resume a').count(),1)
  assert.equal(await p.evaluate(()=>window.fixture.attempts.length),6,'historical attempts remain intact')
 }
})


test('approved dashboard order, published materials and finished-test section navigation',async t=>{
 const p=await open(t);await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor();assert.deepEqual(await p.locator('.student-content>section[aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Continue learning','Study materials','Available tests','Finished tests']);assert.equal(await p.locator('.student-welcome,.student-quick-access,.student-activity').count(),0);
 const material=p.getByRole('link',{name:'Open material: Number system',exact:true});assert.equal(await material.getAttribute('href'),'/dashboard/student/courses?course=c1&lesson=done');assert.equal(await p.getByRole('link',{name:'Open material: Unpublished secret'}).count(),0);await p.getByText(/Standalone PDF downloads are not available/).waitFor();
 const nav=p.getByRole('navigation',{name:'Student navigation'});await nav.getByRole('link',{name:'Finished tests',exact:true}).click();await p.waitForFunction(()=>location.hash==='#student-results');await nav.locator('a[aria-current=page]').filter({hasText:'Finished tests'}).waitFor();assert.equal(new URL(p.url()).pathname,'/dashboard/student');await nav.getByRole('link',{name:'Study materials',exact:true}).click();await p.waitForFunction(()=>location.hash==='#study-materials');await nav.locator('a[aria-current=page]').filter({hasText:'Study materials'}).waitFor()
})
test('expired attempts appear only in Finished tests with existing result destination',async t=>{
 const f=fixtures();f.attempts[0].status='EXPIRED';const p=await open(t,{attempts:f.attempts});await p.getByText('78 / 100',{exact:true}).waitFor();assert.equal(await p.locator('.student-result-list>a').first().getAttribute('href'),'/test/past/result');assert.equal(await p.locator('.student-available-grid article').count(),2);assert.equal(await p.locator('.student-resume a').count(),1);assert.equal(await p.evaluate(()=>window.finalizationCalls),1)
})
test('search includes lesson materials and mobile section links close navigation',async t=>{
 const p=await open(t,{},320);await p.getByRole('link',{name:'Continue learning',exact:true}).waitFor();await p.getByLabel('Search your courses and tests').fill('Integers');assert.equal(await p.locator('.student-material-list article').count(),1);assert.equal(await p.locator('.student-course-progress article').count(),1);await p.getByRole('button',{name:'Clear search'}).click();assert.equal(await p.locator('.student-material-list article>div').first().evaluate(n=>n.clientWidth>=140),true);assert.equal(await p.locator('.student-learning-grid').evaluate(n=>n.scrollHeight<=n.clientHeight),true);await p.getByRole('button',{name:'Open navigation'}).click();await p.getByRole('navigation',{name:'Student navigation'}).getByRole('link',{name:'Tests',exact:true}).click();await p.waitForFunction(()=>location.hash==='#student-tests');assert.equal(await p.getByRole('button',{name:'Open navigation'}).getAttribute('aria-expanded'),'false');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})



test('program-wide publications appear in the matching dashboard while unrelated and unclassified tests remain hidden',async t=>{
 const p=await open(t,{tests:[{id:'wide',name:'Group-II shared program test',exam_id:'group2',level_id:null,program_wide:true},{id:'legacy-null',name:'Unclassified legacy test',exam_id:'group2',level_id:null},{id:'other',name:'DSC program test',exam_id:'dsc',level_id:null,program_wide:true}],attempts:[{id:'resume-wide',test_id:'wide-old',status:'IN_PROGRESS',tests:{name:'Continue Group-II program test',exam_id:'group2',level_id:null,program_wide:true}}],programState:{selection:{exam_id:'group2',level_id:'group2-general',program:'Group-II',track:'General preparation',available:true,version:1},enrolled:[]}});await p.getByText('Group-II shared program test',{exact:true}).waitFor();await p.getByText('Continue Group-II program test',{exact:true}).waitFor();assert.equal(await p.getByText('DSC program test',{exact:true}).count(),0);assert.equal(await p.getByText('Unclassified legacy test',{exact:true}).count(),0)
})
