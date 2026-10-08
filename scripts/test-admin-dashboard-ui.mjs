import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'
let browser,bundle,css,logo
before(async()=>{
 logo=await readFile('public/ksc/institute-logo.png')
 css=(await Promise.all(['staff.css','admin-workspace.css'].map(p=>readFile('src/pages/staff/'+p,'utf8')))).join('\n')
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Page,{publishedStatus} from './src/pages/staff/AdminOverviewPage.jsx';window.publishedStatus=publishedStatus;const api={load:async()=>{window.loads=(window.loads||0)+1;if(window.fixture.loading)await new Promise(r=>window.finishLoad=r);return window.fixture.sections}};createRoot(document.getElementById('root')).render(<Page api={api}/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'auth-fixture',setup(b){b.onResolve({filter:/AuthContext\.jsx$/},()=>({path:'auth',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useAuth=()=>({user:window.fixture.user,signOut:async()=>{window.signOutCalls=(window.signOutCalls||0)+1;return {error:window.fixture.signOutError?new Error('Unavailable'):null}}})`}))}}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(()=>browser?.close())
const empty=()=>Object.fromEntries(['courses','materials','papers','published','people'].map(k=>[k,{data:[]}]))
async function open(t,fixture={},width=1440){const context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().endsWith('/ksc/institute-logo.png')?r.fulfill({contentType:'image/png',body:logo}):r.request().url().endsWith('/bundle.js')?r.fulfill({contentType:'text/javascript',body:bundle}):r.fulfill({contentType:'text/html',body:`<style>body{margin:0}button,input{font:inherit}h1,h2,h3,p{margin:0}${css}</style><div id="root"></div><script>window.fixture=${JSON.stringify({sections:empty(),user:{email:'admin@fixture.test',user_metadata:{full_name:'Institute administrator'}},...fixture}).replaceAll('<','\\u003c')}</script><script src="/bundle.js"></script>`}));const p=await context.newPage();await p.goto('http://127.0.0.1:55557/dashboard/admin/overview');return p}
test('profile-first dashboard follows approved section order and honest empty states',async t=>{
 const p=await open(t);await p.getByRole('heading',{name:'Hello, Institute administrator'}).waitFor();await p.getByText('No courses yet',{exact:true}).waitFor();assert.deepEqual(await p.locator('.admin-panel').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Courses & batches','Study materials','Ready papers in library','Published tests','People & access']);await p.getByText(/Standalone PDF uploads are not available/).waitFor();assert.equal(await p.getByRole('heading',{name:'SGT revision notes'}).count(),0);assert.equal(await p.locator('a[aria-current=page]').innerText(),'Dashboard')
 assert.equal(await p.getByRole('link',{name:'Create your first course'}).getAttribute('href'),'/dashboard/admin/teaching/courses')
})
test('real section records link to existing course, lesson, ready-library and results workflows',async t=>{
 const sections=empty();sections.courses.data=[{id:'c',name:'Reviewed course',batches:[{id:'b'}]}];sections.materials.data=[{id:'lesson',course_id:'c',course:'Reviewed course',title:'Reviewed lesson',is_published:false}];sections.papers.data=[{id:'paper',title:'Reviewed ready paper',exam_name:'Group II',question_count:150,duration:90,version:2}];sections.published.data=[{id:'delivery',title:'Published practice',course:'Reviewed course',batches:['Morning'],opens_at:'2020-01-01T00:00:00Z'}];sections.people.data=[{id:'staff'}]
 const p=await open(t,{sections});await p.getByText('Reviewed ready paper',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Manage course →',exact:true}).getAttribute('href'),'/dashboard/admin/assignments?course=c');assert.equal(await p.getByRole('link',{name:'Manage material →',exact:true}).getAttribute('href'),'/dashboard/admin/teaching/courses?course=c&lesson=lesson');assert.equal(await p.getByRole('link',{name:'Publish Reviewed ready paper'}).getAttribute('href'),'/dashboard/admin/teaching/library?paper=paper&publish=1');await p.getByText('Available now',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Student results for Published practice',exact:true}).getAttribute('href'),'/dashboard/admin/teaching/results')
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/staff-accounts/admin-dashboard-${width}.png`,fullPage:true})}
})
test('section failures preserve other data and retry recovers without fake zero counts',async t=>{
 const sections=empty();sections.courses={error:'Course service unavailable'};sections.papers.data=[{id:'p',title:'Preserved ready paper',exam_name:'DSC',version:1,question_count:100,duration:60}];sections.people={error:'Staff service unavailable'};const p=await open(t,{sections});await p.getByText('Preserved ready paper',{exact:true}).waitFor();assert.equal(await p.getByText('No courses yet',{exact:true}).count(),0);assert.equal(await p.getByText(/0 staff accounts/).count(),0)
 await p.evaluate(()=>{window.fixture.sections.courses={data:[]};window.fixture.sections.people={data:[]}});await p.getByRole('button',{name:'Retry courses & batches'}).click();await p.getByText('No courses yet',{exact:true}).waitFor();assert.equal(await p.getByRole('alert').count(),0)
})
test('loading and sign-out failures are explicit; mobile navigation is operable',async t=>{
 const p=await open(t,{loading:true,signOutError:true},320);await p.getByText('Loading courses & batches…',{exact:true}).waitFor();assert.equal(await p.getByText('No courses yet',{exact:true}).count(),0);await p.evaluate(()=>window.finishLoad());await p.getByText('No courses yet',{exact:true}).waitFor();await p.getByRole('button',{name:'Open navigation'}).click();await p.getByRole('link',{name:'Paper library',exact:true}).waitFor();await p.getByRole('button',{name:'Sign out / switch account'}).click();await p.getByRole('alert').waitFor();assert.equal(await p.getByRole('button',{name:'Sign out / switch account'}).isEnabled(),true);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
test('published statuses use actual opening/closing windows',async t=>{const p=await open(t);assert.deepEqual(await p.evaluate(()=>[publishedStatus({opens_at:'2030-01-01'},Date.parse('2026-10-05')),publishedStatus({opens_at:'2020-01-01',closes_at:'2021-01-01'},Date.parse('2026-10-05'))]),['Scheduled','Closed'])})

test('dashboard includes program publications without implying batch enrollment',async t=>{
 const sections=empty();sections.published.data=[{id:'program-test',test_id:'t1',title:'Group-II program publication',program:'Group-II',opens_at:'2026-10-06T05:00:00Z',question_count:150}];const p=await open(t,{sections});await p.getByRole('heading',{name:'Group-II program publication',exact:true}).waitFor();await p.getByText('Group-II · Program students · Published 6 Oct 2026',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Student results for Group-II program publication'}).getAttribute('href'),'/dashboard/admin/teaching/results?test=t1');assert.equal(await p.getByText('Batch details unavailable',{exact:true}).count(),0)
})

test('ready papers are one row each: waiting papers first, published ones say so, and the list stays short',async t=>{
 const sections=empty()
 const paper=(id,title,exam_id,exam_name,question_count,duration)=>({id,title,exam_id,exam_name,question_count,duration,version:1})
 sections.papers.data=[paper('si4','SI & Constable Test - 4','si','SI & Constable',200,180),paper('dsc1','DSC DIVISIONAL TEST - 1','dsc','DSC',100,100),paper('si1','SI & Constable Model Test-1','si','SI & Constable',200,200),paper('g1','Group-II Grand Test-1','group','Group-II',150,150),paper('g10','Group-II Grand Test-10','group','Group-II',150,150)]
 sections.published.data=[{id:'d',version_id:'dsc1',exam_id:'dsc',title:'DSC DIVISIONAL TEST - 1',program:'DSC',opens_at:'2020-01-01'}]
 const p=await open(t,{sections})
 const rows=p.getByRole('list',{name:'Ready papers'}).getByRole('listitem')
 await rows.first().waitFor()
 assert.deepEqual(await rows.getByRole('heading').allInnerTexts(),['SI & Constable Test - 4','SI & Constable Model Test-1','Group-II Grand Test-1','Group-II Grand Test-10'])
 await p.getByText('4 papers are ready to publish · Showing 4 of 5',{exact:true}).waitFor()
 assert.equal(await rows.first().getByText('SI & Constable · 200 questions · 180 min',{exact:true}).count(),1)
 assert.equal(await p.getByRole('link',{name:'Publish SI & Constable Test - 4'}).getAttribute('href'),'/dashboard/admin/teaching/library?paper=si4&publish=1')
 const heights=await rows.evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().height)))
 assert.ok(heights.every(h=>h<=72),'each paper is a single compact row at 1440: '+heights)
 await p.screenshot({path:'scratch/staff-accounts/admin-dashboard-papers-1440.png',fullPage:true})

 sections.papers.data=sections.papers.data.slice(0,2);sections.published.data.push({id:'e',version_id:'si4',exam_id:'si',program:'SI & Constable',opens_at:'2020-01-01'})
 const q=await open(t,{sections})
 await q.getByText('Every ready paper is published',{exact:true}).waitFor()
 assert.equal(await q.getByRole('link',{name:'View DSC DIVISIONAL TEST - 1 in the library'}).getAttribute('href'),'/dashboard/admin/teaching/library?paper=dsc1')
 assert.equal(await q.getByRole('link',{name:/^Publish /}).count(),0)
 for(const width of [390,320]){const r=await open(t,{sections:{...sections,papers:{data:[paper('si4','SI & Constable Test - 4 with a much longer descriptive title','si','SI & Constable',200,180)]},published:{data:[]}}},width);await r.getByRole('link',{name:/^Publish /}).waitFor();assert.equal(await r.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await r.screenshot({path:`scratch/staff-accounts/admin-dashboard-papers-${width}.png`,fullPage:true})}
})
