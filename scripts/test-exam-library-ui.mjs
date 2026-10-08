import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
let browser,bundle,css,logo
before(async()=>{
 logo=await readFile('public/ksc/institute-logo.png')
 css=(await Promise.all(['staff.css','teacher-portal.css','exam-library.css','local-library.css','admin-workspace.css'].map(f=>readFile('src/pages/staff/'+f,'utf8')))).join('\n')
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {CourseLibraryWorkspace as Library} from './src/pages/staff/ExamLibraryWorkspace.jsx';import Creator from './src/pages/staff/LocalLibraryPreview.jsx';import {deliverySettings,readyTransfer} from './src/services/examLibraryService.js';import {localLibrary} from './src/services/localExamLibrary.js';window.helpers={deliverySettings,readyTransfer,readLibrary:()=>localLibrary('read')};window.mount=async()=>{if(window.fixture.ready||window.fixture.drafts)await localLibrary('write',{drafts:window.fixture.drafts||[],ready:window.fixture.ready||[],deliveries:[]});const api={bringBack:async(id)=>{(window.bringBackCalls||=[]).push(id);window.fixture.papers=window.fixture.papers.filter(p=>p.id!==id);return window.fixture.bringBackResult},list:async()=>{if(window.fixture.listError)throw new Error(window.fixture.listError);return window.fixture.papers||[]},deliveries:async()=>{if(window.fixture.historyError)throw new Error(window.fixture.historyError);return window.fixture.deliveries||[]},audiences:async()=>{if(window.fixture.audienceError)throw new Error(window.fixture.audienceError);return window.fixture.audiences||[]},publish:async(...args)=>{(window.calls||=[]).push(args);if(window.fixture.failOnce&&window.calls.length===1)throw new Error('Temporary connection failure');return {id:'delivery',test_id:'test',title:args[3].title,opens_at:args[3].opens_at||new Date().toISOString()}}};createRoot(document.getElementById('root')).render(window.fixture.creator?<Creator connected onSignOut={window.fixture.signOut?async()=>{window.signedOut=true}:null}/>:<Library api={api} adminView={!!window.fixture.admin} courses={window.fixture.courses||null}/>);};`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'import.meta.url':JSON.stringify('http://127.0.0.1:55555/bundle.js')},loader:{'.css':'empty'},plugins:[{name:'private-transport',setup(b){b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'transport',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({loader:'js',contents:`export const supabase={rpc:(name,args={})=>{const promise=Promise.resolve().then(async()=>{
 const f=window.fixture;(window.rpcCalls||=[]).push({name,args});let data=[],error=null;
 if(name==='ksc_exam_library_list'){data=f.sharedPapers||[];if(f.sharedError)error={message:f.sharedError}}
 if(['ksc_creator_setup','ksc_my_creator_exams'].includes(name))data=f.exams||[];
 if(name==='ksc_library_add_ready'){
  if(f.failTransfer&&window.rpcCalls.filter(c=>c.name===name).length===1)error={message:'TypeError: Failed to fetch'};
  else{if(f.pauseShare)await new Promise(resolve=>window.releaseShare=resolve);const p=args.p_paper;data='version-'+args.p_request;const row={id:data,source_id:p.id,exam_id:args.p_exam,exam_name:f.exams?.find(e=>e.id===args.p_exam)?.name||'Group II',title:p.title,version:p.version||1,question_count:p.questions.length,duration:p.duration,marks:p.marks,negative:p.negative,subjects:[],created_at:'2026-10-06',can_delete:true,can_bring_back:true};f.sharedPapers=[row,...(f.sharedPapers||[]).filter(x=>x.id!==data)];if(f.failReceipt){window.originalIndexedDbOpen=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{throw new Error('Storage unavailable')}}if(f.loseShareResponse)error={message:'TypeError: Failed to fetch'}}
 }
 if(name==='ksc_library_archive_ready'||name==='ksc_library_bring_back'){const row=(f.sharedPapers||[]).find(p=>p.id===args.p_version)||(f.archivedPapers||[]).find(p=>p.id===args.p_version);f.archivedPapers=[row,...(f.archivedPapers||[]).filter(p=>p?.id!==args.p_version)].filter(Boolean);f.sharedPapers=(f.sharedPapers||[]).filter(p=>p.id!==args.p_version);if(name==='ksc_library_bring_back')data={paper:(f.ready||[]).find(p=>p.id===row?.source_id),exam_id:row?.exam_id,version_id:args.p_version};}
 if(name==='ksc_library_restore_ready'){const row=f.archivedPapers.find(p=>p.id===args.p_version);f.sharedPapers=[row,...(f.sharedPapers||[]).filter(p=>p.id!==args.p_version)];data=args.p_version;}
 return {data,error};});return {then:(r,j)=>promise.then(r,j),abortSignal:()=>({then:(r,j)=>promise.then(r,j)})}}}` }))}}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
});after(async()=>browser?.close())
const paper={id:'version',exam_id:'exam',exam_name:'AP DSC-SGT',title:'DSC-SGT · Grand practice',version:2,question_count:160,duration:150,marks:.5,negative:0,subjects:['Biology','Teaching Methodology','Educational Psychology','Geography','Telugu / Language I','Physical Science'],created_at:'2026-10-03T10:00:00Z'}
test('admin dashboard library entry opens requested paper or published view and rejects unavailable paper links',async t=>{
 const p=await open(t,{admin:true,path:'/library?paper=version'});await p.getByRole('heading',{name:'Who will take this test?'}).waitFor();assert.equal(await p.getByRole('button',{name:'Publish to students'}).count(),0)
 const published=await open(t,{admin:true,path:'/library?view=published',deliveries:[{id:'d',title:'Scheduled practice',course:'Reviewed course',batches:['Morning'],opens_at:'2030-01-01'}]});await published.getByText('Scheduled practice',{exact:true}).waitFor();assert.equal(await published.getByRole('button',{name:'Published tests',exact:true}).getAttribute('aria-pressed'),'true')
 const missing=await open(t,{admin:true,path:'/library?paper=not-authorized'});await missing.getByRole('alert').waitFor();assert.match(await missing.getByRole('alert').innerText(),/unavailable in your authorized library/);await missing.getByRole('button',{name:'Retry',exact:true}).click();await missing.getByRole('button',{name:'Publish this paper',exact:true}).waitFor()
})
test('creator shared library recovers read failures and shows authorized metadata without publishing controls',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'AP DSC-SGT'}],sharedError:'Shared library unavailable'})
 await p.getByRole('button',{name:'Paper library',exact:true}).click();const shared=p.getByRole('region',{name:'Shared institute library'});await shared.getByRole('alert').waitFor()
 await p.evaluate(paper=>{window.fixture.sharedError='';window.fixture.sharedPapers=[paper]},paper)
 await shared.getByRole('button',{name:'Retry shared library'}).click();await shared.getByText('DSC-SGT · Grand practice',{exact:true}).waitFor();await shared.getByText('Shared · v2',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:/Publish/}).count(),0)
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/creator-shared-library-${width}.png`,fullPage:true})}
})
const audiences=[{id:'course',name:'DSC-SGT preparation',tracks:[{id:'track',name:'SGT'}],batches:[{id:'a',name:'Morning batch',students:24},{id:'b',name:'Weekend batch',students:18}]}]
test('admin publication drawer keeps audience/settings together, requires review and retries one publication',async t=>{
 const p=await open(t,{admin:true,failOnce:true});assert.equal(await p.getByRole('region',{name:'How to publish a test'}).count(),0)
 await p.getByRole('button',{name:'Publish this paper',exact:true}).click();const dialog=p.getByRole('dialog',{name:'Publish library paper'});await dialog.waitFor();await dialog.getByLabel('Student test title').waitFor();assert.equal(await dialog.getByRole('button',{name:'Continue to settings'}).count(),0);assert.equal(await dialog.getByRole('button',{name:'Review delivery'}).isEnabled(),false);assert.equal(await p.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true)
 await dialog.getByLabel('Institute course').selectOption('course');await dialog.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();await dialog.getByRole('checkbox',{name:'Weekend batch 18 enrolled students'}).check();await dialog.getByText('More delivery settings',{exact:true}).click();await dialog.getByLabel('Answer review').selectOption('SUMMARY_ONLY')
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);await p.screenshot({path:`scratch/staff-accounts/admin-publication-panel-${width}.png`,fullPage:true})}
 await dialog.getByRole('button',{name:'Review delivery'}).click();await dialog.getByRole('heading',{name:'Review the student delivery'}).waitFor();await dialog.getByRole('button',{name:'Publish to students'}).click();await dialog.getByRole('alert').waitFor();await dialog.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor();const calls=await p.evaluate(()=>window.calls);assert.equal(calls.length,2);assert.equal(calls[0][4],calls[1][4]);assert.deepEqual(calls[1].slice(0,3),['version','course',['a','b']]);assert.equal(calls[1][3].review_policy,'SUMMARY_ONLY');assert.equal(await dialog.count(),0)
})
test('admin panel rejects missing schedule and closes with Escape without publishing',async t=>{
 const p=await open(t,{admin:true});await p.getByRole('button',{name:'Publish this paper'}).click();const dialog=p.getByRole('dialog',{name:'Publish library paper'});await dialog.getByLabel('Institute course').selectOption('course');await dialog.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();await dialog.getByRole('radio',{name:'Schedule opening',exact:true}).check();await dialog.getByRole('button',{name:'Review delivery'}).click();await dialog.getByRole('alert').waitFor();assert.match(await dialog.getByRole('alert').innerText(),/opening date/);await p.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await p.evaluate(()=>window.calls?.length||0),0);await p.getByRole('button',{name:'Publish this paper'}).waitFor()
})
test('published tests filter by title, batch and availability and preserve the published URL on reload',async t=>{
 const p=await open(t,{admin:true,deliveries:[{id:'a',title:'Scheduled practice',course:'DSC course',batches:['Morning'],opens_at:'2030-01-01',question_count:100},{id:'b',title:'Closed practice',course:'DSC course',batches:['Weekend'],opens_at:'2020-01-01',closes_at:'2021-01-01',question_count:100}]});await p.getByRole('button',{name:'Published tests',exact:true}).click();assert.equal(new URL(p.url()).searchParams.get('view'),'published');await p.getByLabel('Published test availability').selectOption('Scheduled');await p.getByRole('heading',{name:'Scheduled practice',exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'Closed practice'}).count(),0);await p.getByLabel('Search published tests').fill('Weekend');await p.getByRole('heading',{name:'No matching published tests'}).waitFor();await p.getByLabel('Published test availability').selectOption('');await p.getByRole('heading',{name:'Closed practice'}).waitFor();await p.reload();await p.getByRole('heading',{name:'Published tests',exact:true}).waitFor();await p.getByRole('heading',{name:'Scheduled practice'}).waitFor()
})
async function open(t,fixture={},width=1440){const context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());await context.route('**/*',r=>new URL(r.request().url()).pathname.startsWith('/brand/')?r.fulfill({contentType:'image/png',path:'public'+new URL(r.request().url()).pathname}):new URL(r.request().url()).pathname==='/bundle.js'?r.fulfill({contentType:'text/javascript',body:bundle}):r.fulfill({contentType:'text/html; charset=utf-8',body:`<style>*,*:before,*:after{box-sizing:border-box}body{margin:0;background:#f4f7fb;font-family:Arial,sans-serif}button,input,select{font:inherit}h2,h3,p,dl,dd{margin:0}button{cursor:pointer}.staff-button{background:#10374f;color:white;border:1px solid #10374f;padding:12px 16px;border-radius:8px;font-weight:650}.staff-button-light{background:white;color:#10374f}.staff-card{padding:24px;background:white;border:1px solid #dce6ee;border-radius:14px}.staff-eyebrow{font-size:10px;font-weight:700;letter-spacing:1px}.staff-error{padding:15px;background:#fff1ef;color:#a33222;border-radius:9px;margin:12px 0}.staff-success{color:#18764f;margin:12px 0}${css}</style><main style="max-width:1240px;padding:28px;margin:auto"><div id="root"></div></main><script src="/bundle.js"></script><script>window.fixture=${JSON.stringify({papers:[paper],audiences,...fixture}).replaceAll('<','\\u003c')};window.mount()</script>`}));const page=await context.newPage();await page.goto('http://127.0.0.1:55555'+(fixture.path||'/library'));await page.getByRole('heading',{name:fixture.creator?'Prepare a paper':fixture.admin?(fixture.path?.includes('view=published')?'Published tests':'Paper library'):(fixture.path?.includes('view=published')?'Published tests':'Paper library'),exact:true}).waitFor();return page}
async function choose(page){await page.getByRole('button',{name:'Publish this paper',exact:true}).click();await page.getByLabel('Assigned course').selectOption('course');await page.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();await page.getByRole('dialog',{name:'Publish library paper'}).waitFor()}
test('empty staff libraries explain the next action and never offer unauthorized teacher import',async t=>{
 const teacher=await open(t,{papers:[],courses:[]});await teacher.getByText('Your publishing assignments need setup',{exact:true}).waitFor();await teacher.getByRole('heading',{name:'No ready papers yet'}).waitFor();
 assert.equal(await teacher.getByRole('link',{name:'Check my assignments',exact:true}).getAttribute('href'),'/dashboard/teacher/courses');
 assert.equal(await teacher.getByRole('button',{name:'Connect saved papers'}).count(),0);
 await teacher.getByRole('button',{name:'Publish a test',exact:true}).click();assert.equal(await teacher.getByRole('region',{name:'How to publish a test'}).count(),0);
 const admin=await open(t,{admin:true,papers:[],exams:[{id:'exam',name:'Group II'}]});await admin.getByRole('button',{name:'Connect saved papers'}).click();await admin.getByRole('heading',{name:'Add a prepared paper'}).waitFor();
 assert.equal(await admin.getByRole('link',{name:'Set up courses & batches →'}).getAttribute('href'),'/dashboard/admin/assignments');
 for(const width of [1440,390,320]){await teacher.setViewportSize({width,height:1000});assert.equal(await teacher.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await teacher.screenshot({path:`scratch/staff-accounts/library-guided-empty-${width}.png`,fullPage:true})}
})
test('publish entry clears filters and missing teacher access can recover without losing the selected paper',async t=>{
 const p=await open(t,{audiences:[]});await p.getByLabel('Search library').fill('missing');await p.getByRole('button',{name:'Publish a test',exact:true}).click();await p.getByRole('button',{name:'Publish this paper',exact:true}).click();
 await p.getByRole('heading',{name:'No matching course yet'}).waitFor();assert.equal(await p.getByRole('button',{name:'Review delivery'}).isEnabled(),false);
 await p.evaluate(a=>window.fixture.audiences=a,audiences);await p.getByRole('button',{name:'Refresh course & batch access'}).click();await p.getByLabel('Assigned course').selectOption('course');
 await p.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor();assert.equal((await p.evaluate(()=>window.calls))[0][0],'version')
})
test('teacher chooses ready paper, multiple assigned batches and publishes without content review',async t=>{const p=await open(t);assert.equal(await p.getByRole('button',{name:'Add ready paper'}).count(),0);await p.getByRole('button',{name:'Publish this paper'}).click();assert.equal(await p.getByRole('button',{name:'Review delivery'}).isEnabled(),false);await p.getByLabel('Assigned course').selectOption('course');await p.getByRole('button',{name:'Select all assigned batches'}).click();await p.getByText('2 batches selected · 42 enrollments',{exact:false}).waitFor();await p.getByLabel('Student test title').fill('DSC weekly test');await p.getByText('More delivery settings',{exact:true}).click();await p.getByLabel('Answer review').selectOption('SUMMARY_ONLY');await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor();const calls=await p.evaluate(()=>window.calls);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,3),['version','course',['a','b']]);assert.equal(calls[0][3].level_id,'track');assert.equal(calls[0][3].review_policy,'SUMMARY_ONLY');assert.equal(await p.getByRole('checkbox').count(),0)})
test('failed publication keeps choices and recovers the same operation id after refresh',async t=>{const p=await open(t,{failOnce:true});await choose(p);await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('alert').waitFor();assert.match(await p.getByRole('alert').innerText(),/Temporary connection/);const pendingId=await p.evaluate(()=>window.calls[0][4]);await p.reload();await choose(p);await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('alert').waitFor();await p.getByRole('button',{name:'Publish to students'}).click();await p.getByRole('heading',{name:'Test published',exact:true}).waitFor();const calls=await p.evaluate(()=>window.calls);assert.equal(calls[0][4],calls[1][4]);assert.equal(calls[0][4],pendingId)})
test('invalid schedule is blocked; valid local times become explicit timestamps',async t=>{const p=await open(t);await choose(p);await p.getByRole('radio',{name:'Schedule opening',exact:true}).check();await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('alert').waitFor();assert.match(await p.getByRole('alert').innerText(),/opening date/);const future=new Date(Date.now()+86400000*3).toISOString().slice(0,16);await p.getByLabel('Opens at',{exact:true}).fill(future);await p.getByText('More delivery settings',{exact:true}).click();await p.getByLabel('Closes at (optional)').fill('2020-01-01T10:00');await p.getByRole('button',{name:'Review delivery'}).click();assert.match(await p.getByRole('alert').innerText(),/Closing time/);await p.getByLabel('Closes at (optional)').fill('');await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('button',{name:'Schedule test',exact:true}).click();await p.getByRole('heading',{name:'Test scheduled',exact:true}).waitFor();assert.match((await p.evaluate(()=>window.calls))[0][3].opens_at,/Z$/)})
test('missing matching audience and service failures have recovery instead of publish controls',async t=>{const p=await open(t,{audiences:[]});await p.getByRole('button',{name:'Publish this paper'}).click();await p.getByRole('heading',{name:'No matching course yet'}).waitFor();assert.equal(await p.getByRole('button',{name:'Review delivery'}).isEnabled(),false);const q=await open(t,{listError:'Library activation required'});await q.getByRole('alert').waitFor();assert.equal(await q.getByRole('button',{name:'Publish this paper'}).count(),0);await q.getByRole('button',{name:'Retry',exact:true}).waitFor()})
test('filters, published test status and desktop/mobile delivery layout',async t=>{const p=await open(t,{deliveries:[{id:'delivery',title:'Existing weekly test',course:'DSC course',batches:['Morning'],question_count:100,opens_at:'2020-01-01T10:00:00Z',closes_at:'2020-01-02T10:00:00Z'}]});await p.getByLabel('Search library').fill('Missing');await p.getByRole('heading',{name:'No matching papers'}).waitFor();await p.getByLabel('Search library').fill('Biology');await p.getByRole('button',{name:'Publish this paper'}).waitFor();await p.getByRole('button',{name:'Published tests',exact:true}).click();await p.locator('.library-status').filter({hasText:'Closed'}).waitFor();await p.getByRole('button',{name:'Ready papers',exact:true}).click();await choose(p);await p.getByRole('button',{name:'Review delivery'}).click();for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/library-publish-review-${width}.png`,fullPage:true})}})
test('admin can transfer a validated ready version without publishing it',async t=>{const ready={id:'11111111-1111-4111-8111-111111111111',state:'ready',title:'Prepared practice',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,questions:[{number:1,content:'Prepared question',options:['A','B','C','D'],correct:0}]};const p=await open(t,{admin:true,ready:[ready],exams:[{id:'exam',name:'Group II'}]});await p.getByRole('button',{name:'Add ready paper',exact:true}).click();await p.getByLabel('Ready paper',{exact:true}).selectOption(ready.id);await p.getByLabel('Institute program').selectOption('exam');await p.getByRole('button',{name:'Add to shared library',exact:true}).click();await p.getByRole('status').waitFor();const calls=await p.evaluate(()=>window.rpcCalls);assert.equal(calls.at(-1).name,'ksc_library_add_ready');assert.equal(await p.evaluate(()=>window.calls?.length||0),0)})
test('creator save-ready connects to shared library and failed transfer retries the same version',async t=>{
 const p=await open(t,{creator:true,failTransfer:true,exams:[{id:'exam',name:'Group II'}]})
 await p.getByRole('button',{name:'Load a sample paper'}).click();await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 await p.getByRole('button',{name:'Save to institute library',exact:true}).click();await p.getByRole('alert').waitFor();assert.match(await p.getByRole('alert').innerText(),/Could not reach the institute library\. Check your internet connection and retry\./);assert.doesNotMatch(await p.getByRole('alert').innerText(),/TypeError|Failed to fetch/)
 const pendingRequest=(await p.evaluate(()=>window.rpcCalls)).find(c=>c.name==='ksc_library_add_ready').args.p_request
 await p.reload();await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.getByText('Ready save interrupted. Continue to retry the same version.').waitFor();await p.getByRole('button',{name:'Continue',exact:true}).click()
 assert.equal(await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).isChecked(),true)
 await p.getByRole('button',{name:'Save to institute library',exact:true}).click();await p.getByRole('alert').waitFor()
 await p.getByRole('button',{name:'Save to institute library',exact:true}).click();assert.match(await p.locator('.lp-success').filter({hasText:'saved as v1'}).innerText(),/General awareness · practice paper saved as v1 and shared to the library\./);await p.getByRole('button',{name:'Open Paper library',exact:true}).click();await p.getByRole('heading',{name:'Paper library',exact:true}).waitFor()
 const calls=(await p.evaluate(()=>window.rpcCalls)).filter(c=>c.name==='ksc_library_add_ready');assert.equal(calls.length,2);assert.equal(calls[0].args.p_request,calls[1].args.p_request);assert.equal(calls[1].args.p_exam,'exam')
 assert.equal(calls[1].args.p_request,pendingRequest)
 await p.getByRole('region',{name:'Shared institute library'}).waitFor();assert.equal(await p.getByRole('button',{name:/Publish/}).count(),0)
 await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.getByRole('heading',{name:'No drafts yet',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Continue',exact:true}).count(),0);assert.equal(await p.getByText('Ready save interrupted. Continue to retry the same version.').count(),0)
 await p.getByRole('button',{name:'Paper library',exact:true}).click()
 assert.equal(await p.getByRole('button',{name:'View version'}).count(),0);await p.setViewportSize({width:320,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
test('creator shared save waits for durable browser storage and retains work when storage fails',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}]})
 await p.getByRole('button',{name:'Load a sample paper'}).click();await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 await p.evaluate(()=>{window.originalOpen=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{throw new Error('Storage unavailable')}})
 await p.getByRole('button',{name:'Save to institute library',exact:true}).click();await p.getByRole('alert').waitFor();assert.match(await p.getByRole('alert').innerText(),/Storage unavailable/);assert.equal(await p.evaluate(()=>window.rpcCalls.filter(c=>c.name==='ksc_library_add_ready').length),0);await p.getByText('Question 1',{exact:true}).waitFor()
 await p.evaluate(()=>{indexedDB.open=window.originalOpen});await p.getByRole('button',{name:'Save to institute library',exact:true}).click();await p.getByRole('button',{name:'Open Paper library',exact:true}).click();await p.getByRole('heading',{name:'Paper library',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'View version'}).count(),0)
})



test('teacher publishing panel traps focus, restores trigger and requires final review',async t=>{
 const p=await open(t);await p.getByRole('button',{name:'Publish this paper',exact:true}).click();const dialog=p.getByRole('dialog',{name:'Publish library paper'});await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'Continue to settings'}).count(),0);await dialog.getByLabel('Student test title').waitFor();assert.equal(await p.getByRole('button',{name:'Publish to students'}).count(),0);assert.equal(await p.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
 await dialog.getByLabel('Assigned course').selectOption('course');await dialog.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth),false);await p.screenshot({path:`scratch/staff-accounts/teacher-current-publishing-${width}.png`,fullPage:true})}
 await p.keyboard.press('Escape');assert.equal(await p.getByRole('dialog').count(),0);await p.waitForFunction(()=>document.activeElement.dataset.libraryPaper==='version');assert.equal(await p.evaluate(()=>window.calls?.length||0),0)
})


test('one authorized course, track and batch are preselected with settings still requiring review',async t=>{
 const p=await open(t,{audiences:[{...audiences[0],batches:[audiences[0].batches[0]]}]});await p.getByRole('button',{name:'Publish this paper'}).click();await p.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).waitFor();assert.equal(await p.getByLabel('Assigned course').inputValue(),'course');assert.equal(await p.getByLabel('Course track').inputValue(),'track');assert.equal(await p.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).isChecked(),true);assert.equal(await p.getByRole('button',{name:'Review delivery'}).isEnabled(),true);assert.equal(await p.getByLabel('Answer review').isVisible(),false);await p.getByText('More delivery settings',{exact:true}).click();await p.getByLabel('Closes at (optional)').fill('2020-01-01T10:00');await p.getByRole('button',{name:'Review delivery'}).click();await p.getByRole('alert').waitFor();assert.equal(await p.getByRole('button',{name:'Publish to students'}).count(),0);assert.equal(await p.evaluate(()=>window.calls?.length||0),0)
})



test('ready papers and published history fail independently and recover on refresh',async t=>{
 const p=await open(t,{historyError:'History unavailable'});await p.getByRole('button',{name:'Publish this paper',exact:true}).waitFor();await p.getByRole('button',{name:'Published tests',exact:true}).click();await p.getByRole('alert').filter({hasText:'History unavailable'}).waitFor();
 await p.evaluate(()=>{window.fixture.historyError='';window.fixture.deliveries=[{id:'d',title:'Recovered publication',course:'DSC',batches:['Morning'],opens_at:'2020-01-01'}]});await p.getByRole('button',{name:'Retry',exact:true}).click();await p.getByRole('heading',{name:'Recovered publication',exact:true}).waitFor();
 const q=await open(t,{listError:'Ready papers unavailable',deliveries:[{id:'d',title:'Known publication',course:'DSC',batches:['Morning'],opens_at:'2020-01-01'}]});await q.getByRole('alert').filter({hasText:'Ready papers unavailable'}).waitFor();await q.getByRole('button',{name:'Published tests',exact:true}).click();await q.getByRole('heading',{name:'Known publication',exact:true}).waitFor();assert.equal(await q.getByRole('alert').count(),0);
})

test('creator shared library searches subjects and programs without confusing browser copies with publication',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'AP DSC-SGT'}],sharedPapers:[paper,{...paper,id:'second',exam_id:'group',exam_name:'Group II',title:'Group II practice',subjects:['History']}]});await p.getByRole('button',{name:'Paper library',exact:true}).click();const shared=p.getByRole('region',{name:'Shared institute library'});
 await shared.getByText('DSC-SGT · Grand practice',{exact:true}).waitFor();await shared.getByLabel('Find a shared paper',{exact:true}).fill('History');await shared.getByText('Group II practice',{exact:true}).waitFor();assert.equal(await shared.getByText('DSC-SGT · Grand practice',{exact:true}).count(),0);
 await shared.getByLabel('Shared program',{exact:true}).selectOption('exam');await shared.getByText('No matching shared papers. Change the search or program filter.').waitFor();await shared.getByLabel('Find a shared paper',{exact:true}).fill('');await shared.getByText('DSC-SGT · Grand practice',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:/Publish/}).count(),0);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/creator-filtered-shared-${width}.png`,fullPage:true})}
})

test('an unshared device copy sits under Needs attention while shared papers stay visible, with no list filters',async t=>{
 const ready={id:'11111111-1111-4111-8111-111111111111',state:'ready',title:'Device copy',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,version:1,createdAt:'2026-10-05',sharedReceipt:{program:'exam'},questions:[{number:1,content:'Prepared question',options:['A','B','C','D'],correct:0}]};
 const p=await open(t,{creator:true,ready:[ready],exams:[{id:'exam',name:'AP DSC-SGT'}],sharedPapers:[paper]});await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('button',{name:'View version',exact:true}).waitFor();
 await p.getByRole('region',{name:'Needs attention'}).getByRole('heading',{name:'Device copy',exact:true}).waitFor();await p.getByRole('region',{name:'Shared institute library'}).getByText(paper.title,{exact:true}).waitFor();
 assert.equal(await p.getByLabel('Find a paper',{exact:true}).count(),0);assert.equal(await p.getByLabel('Exam collection').count(),0);assert.equal(await p.getByRole('heading',{name:/Ready papers|No ready|No matching ready/}).count(),0)
 assert.equal(await p.getByRole('heading',{name:'Add a prepared paper',exact:true}).count(),0)
})
test('one row shares directly, moves to Shared, brings back and re-shares without uploading again',async t=>{
 const ready={id:'11111111-1111-4111-8111-111111111111',state:'ready',title:'Saved browser paper',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,version:1,createdAt:'2026-10-06',questions:[{number:1,content:'Prepared question',options:['A','B','C','D'],correct:0}]};const p=await open(t,{creator:true,ready:[ready],exams:[{id:'exam',name:'Group-II'}],pauseShare:true});await p.getByRole('button',{name:'Paper library',exact:true}).click();assert.equal(await p.getByRole('heading',{name:'Add a prepared paper',exact:true}).count(),0);assert.equal(await p.getByLabel('Ready paper',{exact:true}).count(),0);await p.getByRole('button',{name:'Share to library',exact:true}).click();await p.getByRole('button',{name:'Sharing…',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Sharing…',exact:true}).isEnabled(),false);await p.evaluate(()=>window.releaseShare());
 const shared=p.getByRole('region',{name:'Shared institute library'});await shared.getByText(ready.title,{exact:true}).waitFor();await shared.getByText('Shared · v1',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'View version',exact:true}).count(),0);await shared.getByRole('button',{name:'Bring back Saved browser paper',exact:true}).click();await p.getByRole('button',{name:'Share to library',exact:true}).waitFor();assert.equal(await shared.getByText(ready.title,{exact:true}).count(),0);await p.getByRole('button',{name:'Share to library',exact:true}).click();await shared.getByText(ready.title,{exact:true}).waitFor();const calls=await p.evaluate(()=>window.rpcCalls);assert.equal(calls.filter(c=>c.name==='ksc_library_add_ready').length,1);assert.equal(calls.filter(c=>c.name==='ksc_library_restore_ready').length,1);assert.equal(calls.find(c=>c.name==='ksc_library_add_ready').args.p_exam,'exam');
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/simple-library-sharing-${width}.png`,fullPage:true})}
})
test('shared deletion is explicit; papers the creator cannot manage hide their actions behind one plain line',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'AP DSC-SGT'}],sharedPapers:[{...paper,can_delete:true,can_bring_back:true},{...paper,id:'other',title:'Other creator version',can_delete:false,can_bring_back:false}]});await p.getByRole('button',{name:'Paper library',exact:true}).click();const shared=p.getByRole('region',{name:'Shared institute library'});await shared.getByRole('button',{name:'Delete shared paper '+paper.title,exact:true}).waitFor();await shared.getByText('Finished papers your institute can publish. Admins and teachers publish them to a program’s students.',{exact:true}).waitFor();assert.equal(await shared.getByText(/authorized course|course and batch|Management access is restricted/i).count(),0);assert.equal(await shared.getByRole('button',{name:'Delete shared paper Other creator version',exact:true}).count(),0);assert.equal(await shared.getByRole('button',{name:'Bring back Other creator version',exact:true}).count(),0);assert.equal(await shared.getByRole('button',{name:'Bring back '+paper.title,exact:true}).isEnabled(),true);assert.equal(await shared.getByText('Shared by another account. Only that creator or an admin can bring back or delete it.',{exact:true}).count(),1);for(const width of [390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'shared papers overflow at '+width);await p.screenshot({path:`scratch/publish-journey/creator-shared-restricted-${width}.png`,fullPage:true})}await p.setViewportSize({width:1440,height:1000});p.once('dialog',d=>d.dismiss());await shared.getByRole('button',{name:'Delete shared paper '+paper.title,exact:true}).click();assert.equal(await p.evaluate(()=>window.rpcCalls.filter(c=>c.name==='ksc_library_archive_ready').length),0);p.once('dialog',d=>d.accept());await shared.getByRole('button',{name:'Delete shared paper '+paper.title,exact:true}).click();await p.waitForFunction(()=>window.rpcCalls.some(c=>c.name==='ksc_library_archive_ready'));await shared.getByText(paper.title,{exact:true}).waitFor({state:'hidden'});await shared.getByText('Other creator version',{exact:true}).waitFor();assert.equal(await shared.getByText(paper.title,{exact:true}).count(),0)
})

test('server-confirmed sharing remains visible if the reply or browser receipt fails',async t=>{
 const ready={id:'11111111-1111-4111-8111-111111111111',state:'ready',title:'Confirmed shared paper',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,version:1,createdAt:'2026-10-06',questions:[{number:1,content:'Prepared question',options:['A','B','C','D'],correct:0}]};
 for(const patch of [{failReceipt:true},{loseShareResponse:true}]){const p=await open(t,{creator:true,ready:[ready],exams:[{id:'exam',name:'Group-II'}],...patch});await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('button',{name:'Share to library',exact:true}).click();await p.getByRole('region',{name:'Shared institute library'}).getByText(ready.title,{exact:true}).waitFor();await p.getByText('Shared · v1',{exact:true}).waitFor();await p.waitForFunction(()=>document.querySelectorAll('.lp-attention .lp-lib-row').length===0);assert.equal(await p.evaluate(()=>window.rpcCalls.filter(c=>c.name==='ksc_library_add_ready').length),1);await p.getByRole('status').filter({hasText:'is Shared'}).waitFor();if(patch.loseShareResponse)assert.equal(await p.getByRole('alert').count(),0)}
})

test('teacher and admin libraries refresh on return without resetting delivery choices',async t=>{
 for(const admin of [false,true]){const p=await open(t,{admin});await p.getByRole('button',{name:'Publish this paper',exact:true}).click();const panel=p.getByRole('dialog',{name:'Publish library paper'});await panel.getByLabel(admin?'Institute course':'Assigned course').selectOption('course');await panel.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).check();await panel.getByLabel('Student test title').fill('Keep delivery choices');await p.evaluate(()=>{window.fixture.papers.push({...window.fixture.papers[0],id:'new-version',title:'New creator paper'});window.dispatchEvent(new Event('focus'))});await panel.getByLabel('Student test title').waitFor();assert.equal(await panel.getByLabel('Student test title').inputValue(),'Keep delivery choices');assert.equal(await panel.getByRole('checkbox',{name:'Morning batch 24 enrolled students'}).isChecked(),true);await panel.getByRole('button',{name:'Close publishing panel',exact:true}).click();await p.getByRole('heading',{name:'New creator paper',exact:true}).waitFor()}
})

test('ready version opens above a long list and revisions keep the original immutable',async t=>{
 const ready={id:'11111111-1111-4111-8111-111111111111',state:'ready',title:'Ready paper to correct',exam:'Group II',instituteProgram:'exam',duration:60,marks:1,negative:0,confirmed:true,version:3,createdAt:'2026-10-06',returnedReceipt:{version:'old-server-version',program:'exam'},questions:[{number:1,content:'First original question',options:['A','B','C','D'],correct:0},{number:2,content:'Second original question',options:['A','B','C','D'],correct:2}]}
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group-II'}],ready:[ready,...Array.from({length:15},(_,i)=>({...ready,id:'copy-'+i,title:'Other ready '+i}))]});await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('button',{name:'View version',exact:true}).first().click();const dialog=p.getByRole('dialog',{name:'Ready version: '+ready.title});await dialog.waitFor();await dialog.getByText('First original question',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Next question'}).click();await dialog.getByText('Second original question',{exact:true}).waitFor();await dialog.getByText('Answer: C',{exact:true}).waitFor();
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/ready-version-preview-${width}.png`})}
 await dialog.getByRole('button',{name:'Create revised draft'}).click();await p.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor();await p.getByText('First original question',{exact:true}).waitFor();assert.equal(await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).isChecked(),false);await p.getByRole('button',{name:'Save draft',exact:true}).click();
 const data=await p.evaluate(()=>window.helpers.readLibrary());assert.deepEqual(data.ready[0],ready);assert.equal(data.drafts.length,1);assert.notEqual(data.drafts[0].id,ready.id);assert.equal(data.drafts[0].state,'draft');assert.equal(data.drafts[0].returnedReceipt,undefined);assert.equal(data.drafts[0].sharedReceipt,undefined);assert.deepEqual(data.drafts[0].questions,ready.questions);assert.equal(data.drafts[0].instituteProgram,'exam')
})

test('publishing setup provides role-appropriate steps and refresh unlocks delivery settings',async t=>{
 for(const admin of [false,true]){const p=await open(t,{admin,audiences:[]});await p.getByRole('button',{name:'Publish this paper',exact:true}).click();const panel=p.getByRole('dialog',{name:'Publish library paper'});await panel.getByRole('region',{name:'Set up publishing access'}).waitFor();assert.equal(await panel.getByLabel('Student test title').count(),0);assert.equal(await panel.getByRole('button',{name:'Review delivery'}).isEnabled(),false);
 if(admin){assert.equal(await panel.getByRole('link',{name:'Create or choose a course'}).getAttribute('href'),'/dashboard/admin/courses');assert.equal(await panel.getByRole('link',{name:'Link program track'}).getAttribute('href'),'/dashboard/admin/exams');assert.match(await panel.getByRole('link',{name:'Set up batch & access'}).getAttribute('href'),/program=exam&paper=version/)}else{await panel.getByRole('button',{name:'Copy setup request'}).waitFor();assert.equal(await panel.getByRole('link',{name:'Link program track'}).count(),0)}
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/publishing-setup-${admin?'admin':'teacher'}-${width}.png`,fullPage:true})}
 await p.evaluate(()=>window.fixture.audiences=[{id:'course',name:'Configured DSC course',tracks:[{id:'track',name:'DSC track'}],batches:[{id:'batch',name:'DSC batch',students:3}]}]);await panel.getByRole('button',{name:'Refresh course & batch access'}).click();await panel.getByLabel('Student test title').waitFor();assert.equal(await panel.getByLabel('Student test title').inputValue(),paper.title);await panel.getByRole('button',{name:'Review delivery'}).click();await panel.getByRole('button',{name:'Publish to students'}).waitFor();assert.equal(await p.evaluate(()=>window.calls?.length||0),0)
 }
})

test('admin can bring back a shared paper into a browser ready copy without touching publication',async t=>{
 const source={id:'source-dsc',state:'ready',title:paper.title,exam:'DSC-SGT',confirmed:true,version:2,questions:[{number:1,content:'Original DSC question',options:['A','B','C','D'],correct:1}]};const p=await open(t,{admin:true,papers:[{...paper,can_bring_back:true,can_delete:true}],bringBackResult:{paper:source,exam_id:'exam',version_id:'version'}});await p.getByRole('button',{name:'Bring back '+paper.title,exact:true}).click();await p.getByRole('heading',{name:'Paper brought back',exact:true}).waitFor();assert.deepEqual(await p.evaluate(()=>window.bringBackCalls),['version']);assert.equal(await p.getByRole('button',{name:'Publish this paper',exact:true}).count(),0);const data=await p.evaluate(()=>window.helpers.readLibrary());assert.equal(data.ready[0].id,source.id);assert.deepEqual(data.ready[0].questions,source.questions);assert.equal(data.ready[0].returnedReceipt.version,'version');assert.equal(await p.evaluate(()=>window.calls?.length||0),0)
})

const sampleTitle='General awareness · practice paper'
const finishedQuestion={number:1,content:'Which is correct?\nA. One\nB. Two\nC. Three\nD. Four',options:['A','B','C','D'],correct:0,reviewConfirmed:false}
const finishedPaper={title:'Finished paper',exam:'Group II',testFormat:'subject',targetCount:1,sections:[{subject:'Mixed subjects',count:1}],duration:60,marks:1,negative:0,confirmed:true,version:1,questions:[finishedQuestion]}
async function creatorDraftShots(p,name){
 const {mkdir}=await import('node:fs/promises');await mkdir('scratch/creator-drafts',{recursive:true})
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' overflows at '+width);await p.screenshot({path:`scratch/creator-drafts/${name}-${width}.png`,fullPage:true})}
 await p.setViewportSize({width:1440,height:1000})
}
test('a finished paper leaves My drafts; the success state links to Paper library and Save draft cannot bring it back',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}]})
 await p.getByRole('button',{name:'Load a sample paper'}).click();await p.getByRole('button',{name:'Save draft',exact:true}).click();await p.getByRole('status').filter({hasText:'Draft saved on this device.'}).waitFor()
 await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.locator('.lp-list-row').filter({hasText:sampleTitle}).getByRole('button',{name:'Continue',exact:true}).click()
 await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check();await p.getByRole('button',{name:'Save to institute library',exact:true}).click()
 const done=p.getByRole('status').filter({hasText:sampleTitle+' saved as v1 and shared to the library.'});await done.waitFor()
 await p.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor();assert.equal(await p.getByLabel('Paper title').inputValue(),'');assert.equal(await p.getByText('Question 1',{exact:true}).count(),0)
 await done.getByRole('button',{name:'Open Paper library',exact:true}).waitFor();assert.doesNotMatch(await done.innerText(),/draft is kept/i)
 await creatorDraftShots(p,'success-state')
 let stored=await p.evaluate(()=>window.helpers.readLibrary())
 assert.deepEqual(stored.drafts,[]);assert.equal(stored.ready.length,1);assert.equal(stored.ready[0].title,sampleTitle);assert.equal(stored.ready[0].version,1);assert.equal(stored.ready[0].sharedReceipt.program,'exam');assert.ok(stored.ready[0].sharedReceipt.version)
 // Saving a draft now stores the fresh paper, never the finished one.
 await p.getByRole('button',{name:'Save draft',exact:true}).click();await p.getByRole('status').filter({hasText:'Draft saved on this device.'}).waitFor()
 stored=await p.evaluate(()=>window.helpers.readLibrary())
 assert.deepEqual(stored.drafts.map(d=>[d.title,d.questions.length]),[['',0]]);assert.notEqual(stored.drafts[0].id,stored.ready[0].id);assert.equal(stored.ready.length,1)
 assert.equal((await p.evaluate(()=>window.rpcCalls)).filter(c=>c.name==='ksc_library_add_ready').length,1)
 await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('region',{name:'Shared institute library'}).getByText(sampleTitle,{exact:true}).waitFor()
 await p.reload();await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.locator('.lp-list-row').filter({hasText:'Untitled paper'}).waitFor()
 assert.equal(await p.locator('.lp-list-row').count(),1);assert.equal(await p.getByText(sampleTitle).count(),0)

})
test('leftover drafts: identical ones are cleaned on load, edited ones are labelled and use the same Delete draft menu',async t=>{
 const drafts=[
  {...finishedPaper,id:'leftover-same',savedAt:'2026-10-05T05:00:00.000Z',resumeIndex:0,instituteProgram:'exam'},
  {...finishedPaper,id:'leftover-edited',confirmed:false,questions:[{...finishedQuestion,correct:2}],savedAt:'2026-10-06T05:00:00.000Z',instituteProgram:'exam'},
  {...finishedPaper,id:'leftover-other',title:'Second finished paper',confirmed:false,questions:[{...finishedQuestion,correct:1}],savedAt:'2026-10-06T06:00:00.000Z'},
  {...finishedPaper,id:'new-work',title:'Work in progress',version:undefined,confirmed:false},
  {...finishedPaper,id:'interrupted',title:'Interrupted paper',version:undefined,readyOperation:{signature:'pending',program:'exam',account:null,version:{...finishedPaper,id:'pending-version',title:'Interrupted paper',state:'ready'}}},
 ]
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}],ready:[{...finishedPaper,id:'ready-1',state:'ready',createdAt:'2026-10-05T05:00:00.000Z'}],drafts})
 await p.getByRole('button',{name:'My drafts',exact:true}).click()
 const rows=p.locator('.lp-list-row');await rows.filter({hasText:'Work in progress'}).waitFor()
 assert.deepEqual(await rows.locator('strong').allInnerTexts(),['Finished paper','Second finished paper','Work in progress','Interrupted paper'])
 assert.deepEqual((await p.evaluate(()=>window.helpers.readLibrary())).drafts.map(d=>d.id),['leftover-edited','leftover-other','new-work','interrupted'])
 assert.equal(await p.getByText('Saved as v1 · has newer edits',{exact:true}).count(),2)
 assert.equal(await rows.filter({hasText:'Work in progress'}).getByText(/Saved as v/).count(),0)
 await rows.filter({hasText:'Interrupted paper'}).getByText('Ready save interrupted. Continue to retry the same version.').waitFor();assert.equal(await p.getByRole('button',{name:/^More actions for /}).count(),4)
 assert.equal(await p.getByRole('button',{name:'Continue',exact:true}).count(),4)
 await creatorDraftShots(p,'my-drafts')
 // Leftovers use the same More menu and dialog as every other draft.
 assert.equal(await p.getByRole('button',{name:/Remove draft/}).count(),0)
 await deleteDraft(p,'Second finished paper');assert.equal(await rows.count(),3)
 let stored=await p.evaluate(()=>window.helpers.readLibrary());assert.deepEqual(stored.drafts.map(d=>d.id),['leftover-edited','new-work','interrupted']);assert.deepEqual(stored.ready.map(v=>v.id),['ready-1'])
 // Continue saves the edited leftover as the next version, and then it leaves My drafts too.
 await rows.filter({hasText:'Finished paper'}).getByRole('button',{name:'Continue',exact:true}).click();await p.getByText('Question 1',{exact:true}).waitFor()
 await p.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check();await p.getByRole('button',{name:'Save to institute library',exact:true}).click()
 await p.getByRole('status').filter({hasText:'Finished paper saved as v2 and shared to the library.'}).waitFor()
 stored=await p.evaluate(()=>window.helpers.readLibrary());assert.deepEqual(stored.drafts.map(d=>d.id),['new-work','interrupted']);assert.deepEqual(stored.ready.map(v=>v.version),[2,1]);assert.equal(stored.ready[1].id,'ready-1')
 await p.getByRole('button',{name:'My drafts',exact:true}).click();assert.deepEqual(await rows.locator('strong').allInnerTexts(),['Work in progress','Interrupted paper'])
})
test('My drafts keeps its empty state when nothing is in progress',async t=>{
 const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}],ready:[{...finishedPaper,id:'ready-1',state:'ready',createdAt:'2026-10-05T05:00:00.000Z'}],drafts:[{...finishedPaper,id:'leftover-same',savedAt:'2026-10-05T05:00:00.000Z'}]})
 await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.getByRole('heading',{name:'No drafts yet',exact:true}).waitFor();await p.getByText('Saved work will appear here until you are ready to add it to the library.',{exact:true}).waitFor()
 assert.equal(await p.getByRole('button',{name:'Continue',exact:true}).count(),0);await creatorDraftShots(p,'my-drafts-empty')
})

// ---- Delete any draft ----
const okQuestion=number=>({...finishedQuestion,number})
const draftSet=[
 {...finishedPaper,id:'incomplete',title:'Half-done paper',version:undefined,confirmed:false,savedAt:'2026-10-06T05:00:00.000Z',instituteProgram:'exam',questions:[okQuestion(1),okQuestion(2),{...okQuestion(3),correct:null},{...okQuestion(4),content:''}]},
 {...finishedPaper,id:'complete',title:'Complete paper',version:undefined,confirmed:false,savedAt:'2026-10-06T06:00:00.000Z',instituteProgram:'exam'},
 {...finishedPaper,id:'interrupted',title:'Interrupted paper',version:undefined,readyOperation:{signature:'pending',program:'exam',account:null,version:{...finishedPaper,id:'pending-version',title:'Interrupted paper',state:'ready'}}},
 {...finishedPaper,id:'leftover',title:'Leftover paper',confirmed:false,questions:[{...finishedQuestion,correct:2}],savedAt:'2026-10-06T07:00:00.000Z'},
 {...finishedPaper,id:'details-only',title:'Details only',version:undefined,confirmed:false,questions:[]},
]
const readySet=[{...finishedPaper,id:'ready-1',state:'ready',createdAt:'2026-10-05T05:00:00.000Z',sharedReceipt:{program:'exam',version:'server-version'}}]
const openDrafts=async(t,width=1440)=>{const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}],ready:readySet,drafts:draftSet},width);await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.locator('.lp-draft-row').first().waitFor();return p}
const draftRow=(p,title)=>p.locator('.lp-draft-row').filter({hasText:title})
const moreButton=(p,title)=>p.getByRole('button',{name:'More actions for '+title,exact:true})
const deleteDialog=p=>p.getByRole('dialog',{name:'Delete this draft?',exact:true})
const toast=p=>p.getByRole('status').filter({hasText:'Draft deleted'})
const library=p=>p.evaluate(()=>window.helpers.readLibrary())
async function deleteDraft(p,title){await moreButton(p,title).click();await p.getByRole('menuitem',{name:'Delete draft',exact:true}).click();await deleteDialog(p).getByRole('button',{name:'Delete draft',exact:true}).click();await toast(p).waitFor()}
test('every draft shows its progress; Fix missing questions opens the first question that needs attention',async t=>{
 const p=await openDrafts(t)
 assert.deepEqual(await p.locator('.lp-draft-row strong').allInnerTexts(),draftSet.map(d=>d.title))
 await draftRow(p,'Half-done paper').getByText('2 of 4 questions ready · 2 need attention',{exact:true}).waitFor()
 await draftRow(p,'Complete paper').getByText('All questions ready · complete final checks',{exact:true}).waitFor()
 await draftRow(p,'Details only').getByText('No questions added yet',{exact:true}).waitFor()
 await draftRow(p,'Leftover paper').getByText('Saved as v1 · has newer edits',{exact:true}).waitFor()
 assert.equal(await draftRow(p,'Half-done paper').getByRole('button',{name:'Continue',exact:true}).count(),0)
 for(const title of ['Complete paper','Interrupted paper','Leftover paper','Details only'])assert.equal(await draftRow(p,title).getByRole('button',{name:'Continue',exact:true}).count(),1,title)
 assert.equal(await p.getByRole('button',{name:/^More actions for /}).count(),5)
 await creatorDraftShots(p,'my-drafts-progress')
 await draftRow(p,'Half-done paper').getByRole('button',{name:'Fix missing questions',exact:true}).click()
 await p.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor();await p.getByText('Question 3',{exact:true}).waitFor();assert.equal(await p.getByText('Question 1',{exact:true}).count(),0)
 assert.equal(await p.getByLabel('Go to question').inputValue(),'2')
})
test('Delete draft removes only that draft after a confirmation; ready versions and other drafts stay',async t=>{
 const p=await openDrafts(t),before=await library(p)
 await moreButton(p,'Half-done paper').click();assert.deepEqual(await p.getByRole('menu').getByRole('menuitem').allInnerTexts(),['Delete draft'])
 await p.getByRole('menuitem',{name:'Delete draft',exact:true}).click()
 const text=await deleteDialog(p).innerText()
 assert.match(text,/Half-done paper will be removed from this device\. Papers in your library and published tests are not affected\./);assert.doesNotMatch(text,/interrupted/i)
 await deleteDialog(p).getByRole('button',{name:'Cancel',exact:true}).click();await deleteDialog(p).waitFor({state:'hidden'});assert.deepEqual(await library(p),before)
 await deleteDraft(p,'Half-done paper')
 assert.equal(await draftRow(p,'Half-done paper').count(),0);assert.equal(await p.locator('.lp-draft-row').count(),4)
 const after=await library(p)
 assert.deepEqual(after.drafts,before.drafts.filter(d=>d.id!=='incomplete'));assert.deepEqual(after.ready,before.ready);assert.deepEqual(after.deliveries,before.deliveries)
 assert.equal((await p.evaluate(()=>window.rpcCalls)).filter(c=>!['ksc_exam_library_list','ksc_my_creator_exams'].includes(c.name)).length,0)
})
test('Undo puts the draft back exactly; without Undo the toast closes and the draft stays deleted',async t=>{
 const p=await openDrafts(t),before=await library(p)
 await p.clock.install()
 await deleteDraft(p,'Complete paper');assert.equal((await library(p)).drafts.length,4)
 await toast(p).getByRole('button',{name:'Undo',exact:true}).click();await draftRow(p,'Complete paper').waitFor();await toast(p).waitFor({state:'hidden'})
 assert.deepEqual(await library(p),before);assert.deepEqual(await p.locator('.lp-draft-row strong').allInnerTexts(),draftSet.map(d=>d.title))
 await deleteDraft(p,'Complete paper');await p.clock.fastForward(7000);assert.equal(await toast(p).count(),1)
 await p.clock.fastForward(1500);await toast(p).waitFor({state:'hidden'});assert.equal(await p.getByRole('button',{name:'Undo',exact:true}).count(),0)
 const after=await library(p);assert.deepEqual(after.drafts.map(d=>d.id),['incomplete','interrupted','leftover','details-only']);assert.deepEqual(after.ready,before.ready)
 await p.reload();await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.locator('.lp-draft-row').first().waitFor()
})
test('Delete draft in Prepare resets the screen; Save draft cannot bring it back and Undo reopens it',async t=>{
 const p=await openDrafts(t),before=await library(p)
 await draftRow(p,'Complete paper').getByRole('button',{name:'Continue',exact:true}).click();await p.getByText('Question 1',{exact:true}).waitFor()
 await p.getByRole('button',{name:'More draft actions',exact:true}).click();await p.getByRole('menuitem',{name:'Delete draft',exact:true}).click()
 assert.match(await deleteDialog(p).innerText(),/Complete paper will be removed from this device\./)
 await deleteDialog(p).getByRole('button',{name:'Delete draft',exact:true}).click();await toast(p).waitFor()
 await p.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor();assert.equal(await p.getByLabel('Paper title').inputValue(),'');assert.equal(await p.getByText('Question 1',{exact:true}).count(),0)
 assert.equal(await p.getByRole('button',{name:'More draft actions',exact:true}).count(),0)
 await p.getByRole('button',{name:'Save draft',exact:true}).click();await p.getByRole('status').filter({hasText:'Draft saved on this device.'}).waitFor()
 let stored=await library(p);assert.equal(stored.drafts.some(d=>d.id==='complete'||d.title==='Complete paper'),false);assert.equal(stored.drafts.length,5);assert.deepEqual(stored.ready,before.ready)
 // Undo from Prepare, on an untouched screen, reopens the draft where the creator left it.
 const q=await openDrafts(t)
 await draftRow(q,'Complete paper').getByRole('button',{name:'Continue',exact:true}).click();await q.getByText('Question 1',{exact:true}).waitFor()
 await q.getByRole('button',{name:'More draft actions',exact:true}).click();await q.getByRole('menuitem',{name:'Delete draft',exact:true}).click();await deleteDialog(q).getByRole('button',{name:'Delete draft',exact:true}).click()
 await toast(q).getByRole('button',{name:'Undo',exact:true}).click();await q.getByText('Question 1',{exact:true}).waitFor();assert.equal(await q.getByRole('heading',{name:/^Complete paper/}).count(),1)
 assert.deepEqual(await library(q),before)
})
test('a draft with an interrupted library save warns that deleting stops the retry',async t=>{
 const p=await openDrafts(t)
 await moreButton(p,'Interrupted paper').click();await p.getByRole('menuitem',{name:'Delete draft',exact:true}).click()
 assert.match(await deleteDialog(p).innerText(),/This paper’s save to the library was interrupted\. Deleting stops the retry\./)
 await deleteDialog(p).getByRole('button',{name:'Delete draft',exact:true}).click();await toast(p).waitFor()
 const stored=await library(p);assert.equal(stored.drafts.some(d=>d.id==='interrupted'),false);assert.deepEqual(stored.ready.map(v=>v.id),['ready-1'])
 assert.equal((await p.evaluate(()=>window.rpcCalls)).filter(c=>c.name==='ksc_library_add_ready').length,0)
})
test('draft menu and delete dialog work from the keyboard and return focus to the row menu',async t=>{
 const p=await openDrafts(t)
 await moreButton(p,'Half-done paper').focus();await p.keyboard.press('Enter')
 const item=p.getByRole('menuitem',{name:'Delete draft',exact:true});await item.waitFor();assert.equal(await item.evaluate(el=>el===document.activeElement),true)
 await p.keyboard.press('Escape');await p.getByRole('menu').waitFor({state:'hidden'});assert.equal(await moreButton(p,'Half-done paper').evaluate(el=>el===document.activeElement),true)
 await p.keyboard.press('Enter');await p.keyboard.press('Enter');await deleteDialog(p).waitFor()
 for(let i=0;i<4;i++){await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>!!document.activeElement.closest('dialog')),true)}
 await p.keyboard.press('Escape');await deleteDialog(p).waitFor({state:'hidden'})
 await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='More actions for Half-done paper')
 assert.equal((await library(p)).drafts.length,5)
})
test('My drafts rows, menu, delete dialog and Undo toast fit 1440, 390 and 320 with 44px tap targets',async t=>{
 const {mkdir}=await import('node:fs/promises');await mkdir('scratch/creator-drafts',{recursive:true})
 for(const width of [1440,390,320]){
  const p=await openDrafts(t,width),fits=()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),shot=name=>p.screenshot({path:`scratch/creator-drafts/${name}-${width}.png`})
  assert.equal(await fits(),true,'rows overflow at '+width)
  const small=await p.locator('.lp-draft-row button:visible').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().height<44||n.getBoundingClientRect().width<44).map(n=>n.textContent||n.getAttribute('aria-label')))
  assert.deepEqual(small,[],'tap targets under 44px at '+width)
  const onScreen=async(locator,what)=>{const b=await locator.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width,what+' leaves the screen at '+width)}
  await moreButton(p,'Half-done paper').click();await p.getByRole('menu').waitFor();assert.equal(await fits(),true,'menu overflows at '+width);await onScreen(p.getByRole('menu'),'row menu');await shot('draft-menu-open')
  await p.getByRole('menuitem',{name:'Delete draft',exact:true}).click();await deleteDialog(p).waitFor()
  const box=await deleteDialog(p).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0,'dialog leaves the screen at '+width);await shot('delete-dialog')
  await deleteDialog(p).getByRole('button',{name:'Delete draft',exact:true}).click();await toast(p).waitFor();assert.equal(await fits(),true,'toast overflows at '+width)
  const undo=await toast(p).getByRole('button',{name:'Undo',exact:true}).boundingBox();assert.ok(undo.height>=44&&undo.x+undo.width<=width,'Undo is hard to tap at '+width);await shot('undo-toast')
  // The same menu beside Save draft in Prepare.
  await draftRow(p,'Complete paper').getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'More draft actions',exact:true}).click();await onScreen(p.getByRole('menu'),'Prepare menu');assert.equal(await fits(),true,'Prepare menu overflows at '+width);await p.getByRole('menu').scrollIntoViewIfNeeded();await shot('prepare-draft-menu')
 }
})

// ---- Paper library row layout ----
const sharedRows=[
 {...paper,id:'short',title:'Grand Test-8',exam_name:'Group-II',subjects:['General Studies'],version:1,can_delete:true,can_bring_back:true},
 {...paper,id:'medium',title:'KUTTI DSC DIVISIONAL TEST - 1',subjects:['Biology','Teaching Methodology','Geography'],version:2,can_delete:true,can_bring_back:true},
 {...paper,id:'long',title:'KUTTI DSC DIVISIONAL TEST - 2 (Biology, Teaching Methodology and Educational Psychology) final corrected paper for all divisions',subjects:['Telugu'],version:3,can_delete:false,can_bring_back:false},
]
const deviceCopy=(id,title)=>({...finishedPaper,id,title,state:'ready',createdAt:'2026-10-05T05:00:00.000Z'})
const readyRows=[deviceCopy('copy-short','Mock 1'),deviceCopy('copy-medium','Group-II General Studies practice paper'),deviceCopy('copy-long','Group-II General Studies and Mental Ability grand test series paper fourteen, final corrected copy for sharing')]
const openLibrary=async(t,width)=>{const p=await open(t,{creator:true,exams:[{id:'exam',name:'Group II'}],sharedPapers:sharedRows,ready:readyRows},width);await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('region',{name:'Shared institute library'}).locator('.lp-lib-row').first().waitFor();await p.locator('.lp-attention .lp-lib-row').first().waitFor();return p}
test('shared paper rows show two lines, keep subjects searchable and order actions badge, Bring back, Delete',async t=>{
 const p=await openLibrary(t,1440),shared=p.getByRole('region',{name:'Shared institute library'}),rows=shared.locator('.lp-lib-row')
 assert.equal(await rows.count(),3)
 // Two lines only: the subjects line is gone from every row.
 for(const line of await rows.locator('.lp-lib-text p').allInnerTexts())assert.doesNotMatch(line,/Biology|Teaching Methodology|General Studies|Geography|Telugu/)
 assert.deepEqual(await rows.evaluateAll(list=>list.map(row=>row.querySelector('.lp-lib-text').children.length)),[2,2,3])
 assert.deepEqual(await rows.nth(1).locator('.lp-lib-text > *').allInnerTexts(),['KUTTI DSC DIVISIONAL TEST - 1','AP DSC-SGT · 160 questions · 150 minutes · 80 marks'])
 assert.equal(await rows.nth(2).locator('.lp-lib-title').getAttribute('title'),sharedRows[2].title)
 assert.equal(await rows.nth(2).locator('.lp-lib-title').evaluate(el=>el.scrollWidth>el.clientWidth&&getComputedStyle(el).textOverflow==='ellipsis'),true)
 // Actions: badge, then Bring back, then Delete; a paper the creator cannot manage shows only its badge.
 for(const i of [0,1])assert.deepEqual(await rows.nth(i).locator('.lp-lib-actions > *').allInnerTexts(),['Shared · v'+(i+1),'Bring back','Delete'])
 assert.deepEqual(await rows.nth(2).locator('.lp-lib-actions > *').allInnerTexts(),['Shared · v3']);assert.equal(await rows.nth(2).getByRole('button').count(),0)
 await rows.nth(2).getByText('Shared by another account. Only that creator or an admin can bring back or delete it.',{exact:true}).waitFor()
 const look=await rows.nth(0).evaluate(row=>{const style=el=>getComputedStyle(el),back=row.querySelector('.lp-lib-bring-back'),del=row.querySelector('.lp-lib-delete');return {back:[back.offsetHeight,style(back).backgroundColor,style(back).borderTopColor],del:[del.offsetHeight,style(del).backgroundColor,style(del).color]}})
 assert.deepEqual(look.back,[44,'rgb(255, 255, 255)','rgb(5, 44, 73)']);assert.deepEqual(look.del,[44,'rgb(255, 255, 255)','rgb(163, 34, 34)'])
 // Subjects still find their paper.
 await shared.getByLabel('Find a shared paper').fill('geography');assert.deepEqual(await rows.locator('.lp-lib-title').allInnerTexts(),['KUTTI DSC DIVISIONAL TEST - 1'])
 await shared.getByLabel('Find a shared paper').fill('telugu');assert.equal(await rows.count(),1);assert.match(await rows.locator('.lp-lib-title').innerText(),/^KUTTI DSC DIVISIONAL TEST - 2/)
 await shared.getByLabel('Find a shared paper').fill('');assert.equal(await rows.count(),3)
 // The existing delete confirmation and server call are unchanged.
 let question='';p.once('dialog',d=>{question=d.message();d.dismiss()});await rows.nth(0).getByRole('button',{name:'Delete shared paper Grand Test-8',exact:true}).click()
 assert.match(question,/^Delete Grand Test-8\?/);assert.equal((await p.evaluate(()=>window.rpcCalls)).filter(c=>c.name==='ksc_library_archive_ready').length,0)
})
test('library action groups line up across rows at 1920 and 1440 and stack without overflow at 390 and 320',async t=>{
 const {mkdir}=await import('node:fs/promises');await mkdir('scratch/creator-library',{recursive:true})
 for(const width of [1920,1440,390,320]){
  const p=await openLibrary(t,width)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'library overflows at '+width)
  const groups=await p.evaluate(()=>[...document.querySelectorAll('.lp-lib-row')].map(row=>{const info=row.querySelector('.lp-lib-info').getBoundingClientRect(),actions=row.querySelector('.lp-lib-actions').getBoundingClientRect(),items=[...row.querySelectorAll('.lp-lib-actions > *')].map(el=>{const b=el.getBoundingClientRect();return {text:el.textContent.trim(),left:Math.round(b.left),right:Math.round(b.right),top:Math.round(b.top),height:Math.round(b.height)}});return {card:!!row.closest('.lp-attention'),infoBottom:Math.round(info.bottom),infoRight:Math.round(info.right),actionsTop:Math.round(actions.top),right:Math.round(actions.right),items}}))
  assert.equal(groups.length,6)
  for(const list of [groups.filter(g=>!g.card),groups.filter(g=>g.card)]){
   // Every action group ends at the same right edge, whatever the title length.
   assert.equal(new Set(list.map(g=>g.right)).size,1,'action groups end at different places at '+width)
   const full=list.filter(g=>g.items.length===list[0].items.length)
   for(const group of full)assert.deepEqual(group.items.map(item=>item.left),full[0].items.map(item=>item.left),'actions shift between rows at '+width)
   for(const group of list){
    assert.equal(group.items.at(-1).right,group.right,'last action is not at the right edge at '+width)
    for(const item of group.items.filter(item=>!/ · v\d+$/.test(item.text)))assert.equal(item.height,44,item.text+' is not 44px at '+width)
    if(width>640)assert.ok(group.infoRight<=group.items[0].left,'info runs under the actions at '+width)
    else assert.ok(group.actionsTop>=group.infoBottom,'actions do not sit below the info at '+width)
   }
  }
  if(width<=640){const shared=groups.filter(g=>!g.card)[0],buttons=shared.items.slice(1);assert.equal(buttons[0].top,buttons[1].top,'Bring back and Delete are not side by side at '+width)}
  await p.screenshot({path:`scratch/creator-library/paper-library-rows-${width}.png`,fullPage:true})
 }
})

// ---- Creator workspace polish ----
const creatorFixture={creator:true,signOut:true,exams:[{id:'exam',name:'Group II'}]}
const unshared={...finishedPaper,id:'unshared',title:'Interrupted share paper',state:'ready',createdAt:'2026-10-05T05:00:00.000Z'}
const broughtBack={...finishedPaper,id:'returned',title:'Brought back paper',state:'ready',version:2,createdAt:'2026-10-06T05:00:00.000Z',returnedReceipt:{version:'old-server-version',program:'exam'}}
const sharedCopy={...finishedPaper,id:'shared-copy',title:'Already shared paper',state:'ready',createdAt:'2026-10-04T05:00:00.000Z',sharedReceipt:{program:'exam',version:'version'}}
const sharedRow={...paper,id:'version',source_id:'shared-copy',title:'Already shared paper',can_delete:true,can_bring_back:true}
const viewOf=p=>new URL(p.url()).searchParams.get('view')
const mainHeading=(p,name)=>p.getByRole('heading',{level:1,name,exact:true})
test('Ready papers is hidden when nothing is waiting and becomes Needs attention for unshared or brought-back copies',async t=>{
 const clean=await open(t,{...creatorFixture,sharedPapers:[sharedRow],ready:[sharedCopy]})
 await clean.getByRole('button',{name:'Paper library',exact:true}).click();await clean.getByRole('region',{name:'Shared institute library'}).getByText('Already shared paper',{exact:true}).waitFor()
 assert.equal(await clean.getByRole('region',{name:'Needs attention'}).count(),0);assert.equal(await clean.getByRole('heading',{name:/Ready papers|Ready copies|No ready papers/}).count(),0)
 assert.equal(await clean.getByText(/Share a ready paper|Bring back returns it here/).count(),0);assert.equal(await clean.getByRole('button',{name:'Share to library'}).count(),0)
 assert.equal(await clean.locator('.lp-footer').innerText(),'Drafts are saved in this browser. Shared papers are saved to the institute library.')

 const p=await open(t,{...creatorFixture,sharedPapers:[sharedRow],ready:[unshared,broughtBack,sharedCopy]})
 await p.getByRole('button',{name:'Paper library',exact:true}).click()
 const card=p.getByRole('region',{name:'Needs attention'}),rows=card.locator('.lp-lib-row');await card.getByRole('heading',{name:'Needs attention',exact:true}).waitFor()
 assert.deepEqual(await rows.locator('.lp-lib-title').allInnerTexts(),['Interrupted share paper','Brought back paper'])
 assert.deepEqual(await rows.locator('.lp-lib-status').allInnerTexts(),['Not shared yet','Brought back for editing'])
 assert.match(await rows.nth(1).locator('.lp-lib-text p').innerText(),/^Brought back for editing · v2 · Group II · 1 questions · 60 minutes$/)
 for(const i of [0,1])assert.deepEqual((await rows.nth(i).locator('.lp-lib-actions > *').allInnerTexts()).map(x=>x.trim()),['Share to library','View version','Delete'])
 const look=await rows.nth(0).evaluate(row=>{const s=el=>getComputedStyle(el),share=row.querySelector('.lp-primary'),del=row.querySelector('.lp-lib-delete');return [s(share).backgroundColor,s(share).color,s(del).backgroundColor,s(del).color]})
 assert.deepEqual(look,['rgb(255, 206, 22)','rgb(5, 44, 73)','rgb(255, 255, 255)','rgb(163, 34, 34)'])
 // Sharing still goes through the same request and the row leaves the card.
 await rows.nth(0).getByRole('button',{name:'Share to library',exact:true}).click();await p.getByRole('region',{name:'Shared institute library'}).getByText('Interrupted share paper',{exact:true}).waitFor()
 await p.waitForFunction(()=>document.querySelectorAll('.lp-attention .lp-lib-row').length===1);assert.equal((await p.evaluate(()=>window.rpcCalls)).filter(c=>c.name==='ksc_library_add_ready').length,1)
})
test('My exam access is a main nav item; the footer keeps quiet Sign out and Homepage links; one yellow everywhere',async t=>{
 const p=await open(t,creatorFixture),nav=p.locator('.lp-sidebar nav'),footer=p.locator('.lp-sidebar-footer')
 assert.deepEqual((await nav.getByRole('button').allInnerTexts()).map(x=>x.trim()),['Prepare a paper','My drafts','Paper library','My exam access'])
 assert.deepEqual((await footer.locator('button, a').allInnerTexts()).map(x=>x.trim()),['Sign out','Homepage']);assert.equal(await footer.getByRole('link',{name:'Homepage'}).getAttribute('href'),'/')
 const icons=await p.locator('.lp-sidebar nav button svg, .lp-sidebar-footer svg').evaluateAll(list=>list.map(svg=>[svg.getAttribute('width'),svg.getAttribute('stroke-width'),svg.getAttribute('aria-hidden'),svg.getAttribute('stroke')]))
 assert.equal(icons.length,6);for(const icon of icons)assert.deepEqual(icon,['20','1.75','true','currentColor'])
 assert.deepEqual(await footer.locator('button, a').evaluateAll(list=>list.map(el=>[getComputedStyle(el).borderTopWidth,getComputedStyle(el).backgroundColor])),[['0px','rgba(0, 0, 0, 0)'],['0px','rgba(0, 0, 0, 0)']])
 await nav.getByRole('button',{name:'My exam access',exact:true}).click();await mainHeading(p,'My exam access').waitFor();await p.getByText('Assigned for paper preparation').waitFor()
 assert.equal(await nav.getByRole('button',{name:'My exam access',exact:true}).getAttribute('aria-current'),'page');assert.equal(await nav.locator('[aria-current=page]').count(),1)
 // The active nav item, New paper and the primary buttons share one yellow with navy text.
 const yellow=async locator=>locator.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el).color])
 const brand=['rgb(255, 206, 22)','rgb(5, 44, 73)']
 assert.deepEqual(await yellow(nav.getByRole('button',{name:'My exam access',exact:true})),brand);assert.deepEqual(await yellow(p.getByRole('button',{name:'New paper',exact:true})),brand)
 assert.equal(await p.locator('.lp-sidebar').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(5, 44, 73)')
 await nav.getByRole('button',{name:'Prepare a paper',exact:true}).click();assert.deepEqual(await yellow(p.locator('.lp-steps .current > span')),brand)
 await p.getByRole('button',{name:'Load a sample paper'}).click();assert.deepEqual(await yellow(p.getByRole('button',{name:'Save to institute library',exact:true})),brand)
 await nav.getByRole('button',{name:'My drafts',exact:true}).focus();await p.keyboard.press('Tab')
 assert.deepEqual(await p.evaluate(()=>{const s=getComputedStyle(document.activeElement);return [s.outlineWidth,s.outlineStyle]}),['2px','solid'])
})
test('the open view lives in the address: Back, Forward and refresh stay inside the workspace',async t=>{
 const p=await open(t,creatorFixture);assert.equal(viewOf(p),null);await mainHeading(p,'Prepare a paper').waitFor()
 const start=await p.evaluate(()=>history.length)
 await p.getByRole('button',{name:'My drafts',exact:true}).click();await mainHeading(p,'My drafts').waitFor();assert.equal(viewOf(p),'drafts')
 await p.getByRole('button',{name:'Paper library',exact:true}).click();await mainHeading(p,'Paper library').waitFor();assert.equal(viewOf(p),'library')
 await p.getByRole('button',{name:'My exam access',exact:true}).click();await mainHeading(p,'My exam access').waitFor();assert.equal(viewOf(p),'access')
 assert.equal(await p.evaluate(()=>history.length),start+3)
 await p.goBack();await mainHeading(p,'Paper library').waitFor();assert.equal(viewOf(p),'library')
 await p.goBack();await mainHeading(p,'My drafts').waitFor();assert.equal(viewOf(p),'drafts')
 await p.goForward();await mainHeading(p,'Paper library').waitFor();assert.equal(await p.locator('.lp-sidebar nav .active').innerText(),'Paper library')
 await p.reload();await mainHeading(p,'Paper library').waitFor();assert.equal(viewOf(p),'library')
 await p.goBack();await mainHeading(p,'My drafts').waitFor()
 await p.goBack();await mainHeading(p,'Prepare a paper').waitFor();assert.equal(viewOf(p),null)
 // In-page anchors keep working and do not change the view.
 await p.getByRole('button',{name:'Load a sample paper'}).click();await p.evaluate(()=>{location.hash='lp-answer-key'});await p.waitForFunction(()=>location.hash==='#lp-answer-key')
 await mainHeading(p,'Prepare a paper').waitFor();await p.getByText('Question 1',{exact:true}).waitFor()
})
test('declining to leave unsaved changes on Back keeps the screen and puts the address back',async t=>{
 const p=await open(t,creatorFixture)
 await p.getByRole('button',{name:'My drafts',exact:true}).click();await mainHeading(p,'My drafts').waitFor()
 await p.getByRole('button',{name:'Prepare a paper',exact:true}).click();await mainHeading(p,'Prepare a paper').waitFor();assert.equal(viewOf(p),'prepare')
 await p.getByLabel('Paper title').fill('Unsaved work')
 let asked='';p.once('dialog',d=>{asked=d.message();d.dismiss()})
 await p.evaluate(()=>history.back());await p.waitForFunction(()=>new URLSearchParams(location.search).get('view')==='prepare')
 assert.match(asked,/Leave your unsaved changes\?/);await mainHeading(p,'Prepare a paper').waitFor();assert.equal(await p.getByLabel('Paper title').inputValue(),'Unsaved work')
 p.once('dialog',d=>d.accept());await p.evaluate(()=>history.back());await mainHeading(p,'My drafts').waitFor();assert.equal(viewOf(p),'drafts')
})
test('creator workspace views fit 1440, 390 and 320 with and without Needs attention',async t=>{
 const {mkdir}=await import('node:fs/promises');await mkdir('scratch/creator-polish',{recursive:true})
 for(const width of [1440,390,320]){
  const fits=async(p,what)=>assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,what+' overflows at '+width)
  const shot=(p,name)=>p.screenshot({path:`scratch/creator-polish/${name}-${width}.png`,fullPage:true})
  const p=await open(t,{...creatorFixture,sharedPapers:[sharedRow],ready:[unshared,broughtBack,sharedCopy],drafts:draftSet},width)
  await fits(p,'Prepare');await shot(p,'1-prepare')
  await p.getByRole('button',{name:'My drafts',exact:true}).click();await p.locator('.lp-draft-row').first().waitFor();await fits(p,'My drafts');await shot(p,'2-my-drafts')
  await p.getByRole('button',{name:'Paper library',exact:true}).click();await p.getByRole('region',{name:'Needs attention'}).waitFor();await p.getByRole('region',{name:'Shared institute library'}).locator('.lp-lib-row').first().waitFor();await fits(p,'Paper library with Needs attention');await shot(p,'3-library-needs-attention')
  await p.getByRole('button',{name:'My exam access',exact:true}).click();await p.getByText('Assigned for paper preparation').waitFor();await fits(p,'My exam access');await shot(p,'5-my-exam-access')
  const small=await p.locator('.lp-sidebar nav button:visible, .lp-sidebar-footer button:visible, .lp-sidebar-footer a:visible').evaluateAll(list=>list.filter(el=>el.getBoundingClientRect().height<44).map(el=>el.textContent))
  assert.deepEqual(small,[],'sidebar tap targets under 44px at '+width)
  const clean=await open(t,{...creatorFixture,sharedPapers:[sharedRow],ready:[sharedCopy]},width)
  await clean.getByRole('button',{name:'Paper library',exact:true}).click();await clean.getByRole('region',{name:'Shared institute library'}).locator('.lp-lib-row').first().waitFor();await fits(clean,'Paper library');await shot(clean,'4-library-nothing-waiting')
 }
})

// ---- Sidebar brand and top strip ----
test('signed-in creator sidebar shows the round emblem with the institute name and no top strip',async t=>{
 const {mkdir}=await import('node:fs/promises');await mkdir('scratch/creator-brand',{recursive:true})
 for(const width of [1440,390,320]){
  const p=await open(t,creatorFixture,width),brand=p.locator('.lp-sidebar .lp-brand'),mark=brand.locator('img')
  // No strip above the workspace when signed in.
  assert.equal(await p.locator('.lp-preview-note').count(),0);assert.equal(await p.getByText(/CREATOR WORKSPACE ·|WORKSPACE PREVIEW|Preview mode|Drafts stay in this browser/).count(),0)
  assert.equal(await p.locator('.library-preview').evaluate(el=>el.firstElementChild.classList.contains('lp-shell')&&Math.round(el.firstElementChild.getBoundingClientRect().top-el.getBoundingClientRect().top)===0),true)
  assert.equal(await brand.getAttribute('aria-label'),'AaryaRushi Education home');assert.equal(await brand.getAttribute('href'),'/testcreator/login')
  assert.equal(await p.getByRole('link',{name:'AaryaRushi Education home',exact:true}).count(),1)
  assert.equal(await mark.getAttribute('src'),'/brand/logo-mark-light.svg');assert.equal(await mark.getAttribute('alt'),'');assert.equal(await mark.getAttribute('aria-hidden'),'true')
  assert.equal(await p.locator('img[src*="institute-logo"]').count(),0)
  await p.waitForFunction(()=>{const img=document.querySelector('.lp-brand img');return img.complete&&img.naturalWidth===512})
  const look=await brand.evaluate(link=>{
   const img=link.querySelector('img'),name=link.querySelector('strong'),tag=link.querySelector('small'),s=el=>getComputedStyle(el),box=el=>el.getBoundingClientRect()
   const icon=document.querySelector('.lp-sidebar nav button svg')
   return {size:[Math.round(box(img).width),Math.round(box(img).height)],radius:s(img).borderRadius,background:s(img).backgroundColor,padding:s(img).paddingTop,
    name:[name.textContent,s(name).fontSize,s(name).fontWeight,s(name).color],tag:[tag.textContent,s(tag).fontSize,s(tag).fontWeight,s(tag).color],
    nameLines:Math.round(box(name).height/parseFloat(s(name).lineHeight)),tagLines:Math.round(box(tag).height/parseFloat(s(tag).lineHeight)),
    left:Math.round(box(img).left),iconLeft:Math.round(box(icon).left),gap:Math.round(box(link.querySelector('.lp-brand-text')).left-box(img).right),
    centered:Math.abs((box(img).top+box(img).bottom)/2-(box(link.querySelector('.lp-brand-text')).top+box(link.querySelector('.lp-brand-text')).bottom)/2)<=1,right:Math.round(box(link).right)}
  })
  const emblem=width>700?44:36
  assert.deepEqual(look.size,[emblem,emblem]);assert.equal(look.radius,'50%');assert.equal(look.background,'rgba(0, 0, 0, 0)');assert.equal(look.padding,'0px')
  assert.deepEqual(look.name,['AaryaRushi Education','16px','700','rgb(255, 255, 255)']);assert.deepEqual(look.tag,['Learn. Practise. Succeed.','12px','500','rgb(255, 206, 22)'])
  assert.equal(look.left,look.iconLeft,'emblem is not lined up with the nav icons at '+width);assert.equal(look.centered,true);assert.ok(look.right<=width)
  assert.equal(look.gap,width>1150||width<=700?12:10)
  assert.equal(look.nameLines,1,'name wraps at '+width);assert.equal(look.tagLines,1,'tagline wraps at '+width)
  if(width>1150)assert.deepEqual(await brand.locator('strong, small').evaluateAll(list=>list.map(el=>el.scrollWidth<=el.clientWidth)),[true,true],'brand text is cut off at '+width)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'brand overflows at '+width)
  await p.screenshot({path:`scratch/creator-brand/sidebar-top-${width}.png`,clip:{x:0,y:0,width:Math.min(width,520),height:width>700?330:240}})
  await brand.screenshot({path:`scratch/creator-brand/brand-block-${width}.png`,scale:'device'})
 }
})
