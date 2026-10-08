// Publish-a-test journey (Paper library) for teacher and admin: Publish on a row → Confirm → Done.
// Runs the real components against a fixture API; no backend is contacted.
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'

let browser,bundle,css
const styles=['staff.css','exam-library.css','admin-workspace.css','publishing/publishing.css','delete-confirm.css']
const harness=`
import React from 'react'
import {createRoot} from 'react-dom/client'
import Library from './src/pages/staff/ExamLibraryWorkspace.jsx'
const fx=()=>window.fixture
const api={
 list:async()=>{
  window.listCalls=(window.listCalls||0)+1
  if(fx().hold)await new Promise(resolve=>window.releaseList=resolve)
  if(fx().listError)throw Error(fx().listError)
  return fx().papers
 },
 programDeliveries:async()=>{if(fx().historyError)throw Error(fx().historyError);return fx().deliveries||[]},
 deliveries:async()=>fx().legacy||[],
 publishProgram:async(...args)=>{
  (window.calls||=[]).push(args)
  if(fx().failOnce&&window.calls.length===1)throw Error(fx().failOnce)
  if(fx().pause)await new Promise(resolve=>window.releasePublish=resolve)
  if(fx().unconfirmed)return {}
  const paper=fx().papers.find(p=>p.id===args[0])
  const result={id:'delivery-'+args[0],test_id:'test',title:args[2],exam_id:args[1],version_id:args[0],program:paper.exam_name,opens_at:'2020-01-01',question_count:paper.question_count}
  if(fx().alreadyElsewhere)result.already_published=true
  fx().deliveries=[...(fx().deliveries||[]),result]
  return result
 },
 withdrawPublished:async id=>{(window.withdrawn||=[]).push(id);if(fx().withdrawFailOnce&&window.withdrawn.length===1)throw Error('PGRST202 schema cache');fx().deliveries=(fx().deliveries||[]).filter(d=>d.test_id!==id);return {test_id:id,withdrawn:true,results_kept:fx().kept||0}},
 archive:async id=>{(window.archived||=[]).push(id);fx().papers=fx().papers.filter(p=>p.id!==id)},
 bringBack:async id=>{
  (window.broughtBack||=[]).push(id)
  const paper=fx().papers.find(p=>p.id===id)
  fx().papers=fx().papers.filter(p=>p.id!==id)
  return {paper:{id:'device-copy',title:paper.title,questions:[]},exam_id:paper.exam_id,version_id:id}
 },
}
window.mount=()=>createRoot(document.getElementById('root')).render(
 <div className="staff-workspace"><main className="staff-workspace-content">
  <Library api={api} adminView={fx().admin} basePath={fx().admin?'/dashboard/admin/teaching':'/dashboard/teacher'}/>
 </main></div>)
`

before(async()=>{
 css=(await Promise.all(styles.map(file=>readFile('src/pages/staff/'+file,'utf8')))).join('\n')
 bundle=(await build({
  stdin:{contents:harness,resolveDir:process.cwd(),loader:'jsx'},
  bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},
  define:{'import.meta.url':JSON.stringify('http://127.0.0.1:55555/bundle.js')},
  plugins:[{name:'no-real-backend',setup(b){
   b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'offline',namespace:'test'}))
   b.onLoad({filter:/.*/,namespace:'test'},()=>({loader:'js',contents:'export const supabase={rpc:()=>{throw Error("Unexpected backend call")}}'}))
  }}],
 })).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(async()=>browser?.close())

const groupOne={id:'group-1',exam_id:'group',exam_name:'Group-II',title:'Group-2 G.S. Test-1(Final)',version:'1',question_count:150,duration:60,marks:1,created_at:'2026-10-01T05:00:00Z'}
const groupFour={id:'group-4',exam_id:'group',exam_name:'Group-II',title:'Group-2 G.S. Test-4(Final)',version:'1',question_count:150,duration:60,marks:1,created_at:'2026-10-02T05:00:00Z'}
const dscOne={id:'dsc-1',exam_id:'dsc',exam_name:'DSC',title:'KUTTI DSC DIVISIONAL TEST - 1',version:'1',question_count:160,duration:90,marks:0.5,created_at:'2026-10-03T05:00:00Z'}
const papers=[groupOne,groupFour,dscOne]
const oldFlowCopy=/course|batch|audience|setup request|approval|approve|who will take|link a program/i
const technicalCopy=/PGRST|\bRPC\b|snapshot|version id|cache|ksc_/i

async function mount(p,fixture){
 await p.addStyleTag({content:css})
 await p.evaluate(f=>{window.fixture=f},fixture)
 await p.addScriptTag({content:bundle})
 await p.evaluate(()=>window.mount())
}
async function open(t,patch={},path='/library',width=1440){
 const context=await browser.newContext({viewport:{width,height:900}})
 t.after(()=>context.close())
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'
  ?route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>'})
  :route.abort())
 const p=await context.newPage()
 p.setDefaultTimeout(5000)
 const errors=[]
 p.on('pageerror',e=>errors.push(e.message))
 t.after(()=>assert.deepEqual(errors,[]))
 await p.goto('http://127.0.0.1:55555'+path)
 await mount(p,{papers,...patch})
 return p
}
const esc=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
const chip=(p,name)=>p.getByRole('button',{name:new RegExp('^'+esc(name)+', ')})
const filter=p=>p.getByRole('group',{name:'Filter by program',exact:true})
const row=(p,title)=>p.locator('.pub-paper').filter({has:p.getByRole('heading',{name:title,exact:true})})
const publishButton=(p,title=groupOne.title)=>p.getByRole('button',{name:'Publish '+title,exact:true})
const viewButton=(p,title)=>p.getByRole('button',{name:`View ${title} in published tests`,exact:true})
const group=(p,name)=>p.getByRole('list',{name,exact:true})
const titlesIn=async(p,name)=>(await group(p,name).count())?group(p,name).getByRole('heading').allInnerTexts():[]
const dialog=p=>p.getByRole('dialog',{name:'Publish this test?',exact:true})
const confirmButton=p=>dialog(p).getByRole('button',{name:'Publish now',exact:true})
const calls=p=>p.evaluate(()=>window.calls||[])
const fits=p=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
// Facts use non-breaking spaces so they wrap as whole units; compare with plain spaces.
const plain=text=>text.replace(/\s+/g,' ')
const pageText=async p=>plain(await p.locator('body').innerText())
async function publishGroupOne(p){
 await publishButton(p).click()
 await confirmButton(p).click()
}

test('teacher and admin publish in two clicks: Publish on the row, then confirm',async t=>{
 for(const admin of [false,true]){
  const p=await open(t,{admin})
  await p.getByRole('heading',{name:'Publish a test',exact:true}).waitFor()
  // Nothing has to be chosen first: every ready paper is listed with its own Publish button.
  assert.deepEqual(await titlesIn(p,'Ready to publish'),[groupOne.title,groupFour.title,dscOne.title])
  assert.equal(await chip(p,'All programs').getAttribute('aria-pressed'),'true')
  assert.deepEqual(await filter(p).getByRole('button').allInnerTexts().then(list=>list.map(plain)),['All programs 3','DSC 1','Group-II 2'])
  assert.match(plain(await row(p,groupOne.title).innerText()),/Group-II Version 1 · 150 questions · 60 min · 150 marks/)

  await publishButton(p).click()                                     // click 1
  await dialog(p).waitFor()
  assert.equal((await calls(p)).length,0)
  const confirmation=plain(await dialog(p).innerText())
  assert.match(confirmation,new RegExp(esc(`Group-II ${groupOne.title} Version 1`)))
  assert.match(confirmation,/Questions 150 Minutes 60 Marks 150/)
  assert.match(confirmation,/All Group-II students can start it right away\./)
  assert.match(confirmation,/Questions are locked after publishing\. To change them, publish a revised version\./)
  assert.doesNotMatch(await pageText(p),oldFlowCopy)
  await confirmButton(p).click()                                     // click 2

  await p.getByRole('heading',{name:'Test published',exact:true}).waitFor()
  await p.getByText('is now available to Group-II students.').waitFor()
  assert.deepEqual((await calls(p)).map(call=>call.slice(0,3)),[['group-1','group',groupOne.title]])
  assert.equal(await p.getByRole('alert').count(),0)
  assert.deepEqual(await titlesIn(p,'Already published'),[groupOne.title])
  assert.equal(await publishButton(p).count(),0)
  assert.match(await row(p,groupOne.title).innerText(),/Published/)
  const text=await pageText(p)
  assert.doesNotMatch(text,oldFlowCopy)
  assert.doesNotMatch(text,technicalCopy)

  await p.getByRole('button',{name:'View published tests',exact:true}).click()
  await p.getByRole('heading',{name:'Published tests',exact:true}).waitFor()
  await p.getByRole('heading',{name:groupOne.title,exact:true}).waitFor()
  await p.getByText('Group-II · Program students',{exact:true}).waitFor()
  assert.equal(new URL(p.url()).searchParams.get('view'),'published')
  assert.equal(await p.getByRole('link',{name:'Student results for '+groupOne.title}).getAttribute('href'),(admin?'/dashboard/admin/teaching':'/dashboard/teacher')+'/results?test=test')
 }
})

test('the program filter narrows the list, one program needs no filter, and Publish another focuses the next paper',async t=>{
 const p=await open(t)
 await chip(p,'DSC').click()
 assert.equal(await chip(p,'DSC').getAttribute('aria-pressed'),'true')
 assert.deepEqual(await titlesIn(p,'Ready to publish'),[dscOne.title])
 // Inside one program the program name is not repeated on every row.
 assert.equal(await row(p,dscOne.title).locator('.pub-paper-program').count(),0)
 assert.equal(await row(p,dscOne.title).locator('.pub-paper-avatar').getAttribute('aria-hidden'),'true')
 await chip(p,'All programs').click()
 assert.equal((await titlesIn(p,'Ready to publish')).length,3)

 const q=await open(t,{papers:[groupOne,groupFour]})
 await publishButton(q).waitFor()
 assert.equal(await filter(q).count(),0)
 await publishGroupOne(q)
 await q.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 await q.getByRole('button',{name:'Publish another',exact:true}).click()
 assert.equal(await q.getByRole('heading',{name:'Test published',exact:true}).count(),0)
 await q.waitForFunction(title=>document.activeElement?.getAttribute('aria-label')==='Publish '+title,groupFour.title)

 // Once everything in a program is published the list says so instead of looking empty.
 await publishButton(q,groupFour.title).click()
 await confirmButton(q).click()
 await q.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 await q.getByText('Every Group-II paper is published. New papers from test creators appear here.',{exact:true}).waitFor()
})

test('?paper= highlights its row, &publish=1 opens the confirm step, and a missing paper is explained',async t=>{
 const p=await open(t,{},'/library?paper=dsc-1')
 await row(p,dscOne.title).waitFor()
 assert.equal(await chip(p,'DSC').getAttribute('aria-pressed'),'true')
 assert.match(await row(p,dscOne.title).getAttribute('class'),/is-highlighted/)
 await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Publish KUTTI DSC DIVISIONAL TEST - 1')
 assert.match(plain(await row(p,dscOne.title).innerText()),/160 questions · 90 min · 80 marks/)
 assert.equal(await dialog(p).count(),0)
 assert.equal(new URL(p.url()).search,'')

 const q=await open(t,{},'/library?paper=dsc-1&publish=1')
 await dialog(q).waitFor()
 assert.match(plain(await dialog(q).innerText()),/Questions 160 Minutes 90 Marks 80/)
 assert.equal(new URL(q.url()).search,'')
 await confirmButton(q).click()
 await q.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 assert.deepEqual((await calls(q)).map(call=>call[0]),['dsc-1'])

 // A paper that is already published is shown, never offered for publishing again.
 const r=await open(t,{deliveries:[{id:'x',version_id:'dsc-1',exam_id:'dsc',title:dscOne.title,program:'DSC',opens_at:'2020-01-01'}]},'/library?paper=dsc-1&publish=1')
 await viewButton(r,dscOne.title).waitFor()
 assert.equal(await dialog(r).count(),0)

 const s=await open(t,{},'/library?paper=gone')
 await s.getByRole('alert').filter({hasText:'This paper is no longer in the library. Choose another test.'}).waitFor()
 await chip(s,'Group-II').click()
 assert.equal(await s.getByRole('alert').count(),0)
})

test('an already published paper cannot be published again and links to Published tests',async t=>{
 const p=await open(t,{deliveries:[{id:'published',version_id:'group-1',exam_id:'group',title:groupOne.title,program:'Group-II',opens_at:'2020-01-01',question_count:150}]})
 assert.equal(plain(await chip(p,'Group-II').innerText()),'Group-II 1')
 assert.deepEqual(await titlesIn(p,'Already published'),[groupOne.title])
 assert.equal(await publishButton(p).count(),0)
 await viewButton(p,groupOne.title).click()
 await p.getByRole('heading',{name:'Published tests',exact:true}).waitFor()
 await p.getByRole('heading',{name:groupOne.title,exact:true}).waitFor()
 assert.equal((await calls(p)).length,0)

 // Someone else published it a moment ago: the server answers "already published", nothing is duplicated.
 const q=await open(t,{alreadyElsewhere:true})
 await publishGroupOne(q)
 await q.getByRole('heading',{name:'Already published',exact:true}).waitFor()
 await q.getByText('Nothing was published twice.').waitFor()
 assert.equal(await q.getByRole('heading',{name:'Test published',exact:true}).count(),0)
})

test('confirm dialog: Escape cancels and returns focus to the row; busy state blocks Escape and double submit',async t=>{
 const p=await open(t,{pause:true})
 await publishButton(p).click()
 await dialog(p).waitFor()
 // Focus is trapped inside the dialog.
 for(let i=0;i<4;i++){
  await p.keyboard.press('Tab')
  assert.equal(await p.evaluate(()=>!!document.activeElement.closest('dialog')),true)
 }
 await p.keyboard.press('Escape')
 await dialog(p).waitFor({state:'hidden'})
 await p.waitForFunction(title=>document.activeElement?.getAttribute('aria-label')==='Publish '+title,groupOne.title)
 assert.equal((await calls(p)).length,0)

 await publishButton(p).click()
 await confirmButton(p).click()
 await p.waitForFunction(()=>window.calls?.length===1)
 const busy=dialog(p).getByRole('button',{name:'Publishing…',exact:true})
 assert.equal(await busy.isDisabled(),true)
 assert.equal(await dialog(p).getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true)
 // Other rows cannot start a second publish meanwhile.
 assert.equal(await publishButton(p,groupFour.title).isDisabled(),true)
 await busy.click({force:true}).catch(()=>{})
 await p.keyboard.press('Escape')
 await p.keyboard.press('Escape')
 assert.equal(await dialog(p).isVisible(),true)
 await p.evaluate(()=>window.releasePublish())
 await p.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 assert.equal((await calls(p)).length,1)
})

test('a failed publish explains itself in plain words and Retry reuses the same request, even after reload',async t=>{
 const p=await open(t,{failOnce:'Connection lost'})
 await publishGroupOne(p)
 await dialog(p).getByRole('alert').filter({hasText:'Connection lost'}).waitFor()
 const first=(await calls(p))[0][3]
 assert.match(first,/^[0-9a-f-]{36}$/)
 assert.equal(await p.evaluate(()=>JSON.parse(sessionStorage.getItem('ksc-program-publication:/dashboard/teacher')).id),first)
 await dialog(p).getByRole('button',{name:'Cancel',exact:true}).click()
 assert.match(await row(p,groupOne.title).getAttribute('class'),/is-highlighted/)

 await p.reload()
 await mount(p,{papers})
 await publishGroupOne(p)
 await p.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 assert.equal((await calls(p))[0][3],first)
 assert.equal(await p.evaluate(()=>sessionStorage.getItem('ksc-program-publication:/dashboard/teacher')),null)

 // Retry inside the dialog keeps the same request too.
 const q=await open(t,{failOnce:'Connection lost'})
 await publishGroupOne(q)
 await dialog(q).getByRole('button',{name:'Retry',exact:true}).click()
 await q.getByRole('heading',{name:'Test published',exact:true}).waitFor()
 const attempts=await calls(q)
 assert.equal(attempts.length,2)
 assert.equal(attempts[0][3],attempts[1][3])
})

test('technical failures never reach the screen and an unconfirmed reply is not shown as success',async t=>{
 const p=await open(t,{failOnce:'PGRST202 Could not find the function public.ksc_publish_program_paper in the schema cache'})
 await publishGroupOne(p)
 await dialog(p).getByRole('alert').filter({hasText:'This test could not be published. Please retry.'}).waitFor()
 assert.doesNotMatch(plain(await dialog(p).innerText()),technicalCopy)

 const q=await open(t,{unconfirmed:true})
 await publishGroupOne(q)
 await dialog(q).getByRole('alert').waitFor()
 assert.equal(await q.getByRole('heading',{name:'Test published',exact:true}).count(),0)

 const r=await open(t,{listError:'42883 function ksc_exam_library_list() does not exist'})
 await r.getByRole('alert').filter({hasText:'The paper library could not be loaded. Please retry.'}).waitFor()
 assert.doesNotMatch(await pageText(r),technicalCopy)
})

test('admin manages a paper from the More menu using server flags; teachers never see it',async t=>{
 const managed=[{...groupOne,can_bring_back:true,can_delete:true},{...groupFour,can_bring_back:false,can_delete:false},{...dscOne,can_bring_back:true,can_delete:false}]
 const teacher=await open(t,{papers:managed})
 await publishButton(teacher).waitFor()
 assert.equal(await teacher.getByRole('button',{name:/More actions/}).count(),0)
 assert.equal(await teacher.getByText(/Delete|Bring back/).count(),0)
 assert.equal(await teacher.getByRole('button',{name:'Add a ready paper from this device'}).count(),0)

 const p=await open(t,{papers:managed,admin:true})
 await chip(p,'Group-II').click()
 assert.equal(await p.getByRole('button',{name:/More actions/}).count(),1)
 const more=p.getByRole('button',{name:`More actions for ${groupOne.title}, version 1`,exact:true})
 await more.click()
 const menu=p.getByRole('menu',{name:'More actions'})
 assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(),['Bring back to edit','Delete from library'])
 await p.keyboard.press('Escape')
 await menu.waitFor({state:'hidden'})
 assert.equal(await more.evaluate(el=>el===document.activeElement),true)

 // Declining the confirmation keeps the paper.
 p.once('dialog',d=>d.dismiss())
 await more.click()
 await menu.getByRole('menuitem',{name:'Delete from library'}).click()
 assert.equal(await p.evaluate(()=>window.archived?.length||0),0)
 let message=''
 p.once('dialog',d=>{message=d.message();d.accept()})
 await more.click()
 await menu.getByRole('menuitem',{name:'Delete from library'}).click()
 await row(p,groupOne.title).waitFor({state:'detached'})
 assert.match(message,/Published tests and results are kept\./)
 assert.deepEqual(await p.evaluate(()=>window.archived),['group-1'])
 assert.equal((await calls(p)).length,0)

 await chip(p,'DSC').click()
 await p.getByRole('button',{name:/More actions/}).click()
 assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(),['Bring back to edit'])
 await menu.getByRole('menuitem',{name:'Bring back to edit'}).click()
 await p.getByRole('heading',{name:'Paper brought back',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>window.broughtBack),['dsc-1'])
 assert.equal(await p.getByRole('link',{name:'Open ready copy to edit →'}).getAttribute('href'),'/testcreator/preview?view=library')
})

test('loading, empty and error states read clearly; Retry recovers',async t=>{
 const p=await open(t,{hold:true})
 await p.getByRole('status',{name:'Loading papers'}).waitFor()
 assert.equal(await p.getByText('No ready papers yet').count(),0)
 await p.evaluate(()=>{window.fixture.papers=[];window.releaseList()})
 await p.getByRole('heading',{name:'No ready papers yet',exact:true}).waitFor()
 await p.getByText('A test creator shares finished papers here.',{exact:true}).waitFor()

 const q=await open(t,{listError:'Could not reach the institute library. Check your internet connection and retry.'})
 const alert=q.getByRole('alert')
 await alert.filter({hasText:'Could not reach the institute library.'}).waitFor()
 assert.equal(await q.getByText('No ready papers yet').count(),0)
 await q.evaluate(()=>{window.fixture.listError=''})
 await alert.getByRole('button',{name:'Retry',exact:true}).click()
 await chip(q,'Group-II').waitFor()
 assert.equal(await q.getByRole('alert').count(),0)
})

test('returning to the tab refreshes quietly and keeps the chosen program and highlighted paper',async t=>{
 const p=await open(t,{},'/library?paper=group-1')
 await row(p,groupOne.title).waitFor()
 const before=await p.evaluate(()=>window.listCalls)
 const added={id:'group-9',exam_id:'group',exam_name:'Group-II',title:'Group-2 G.S. Test-9',version:'1',question_count:150,duration:60,marks:1}
 await p.waitForTimeout(2100)
 await p.evaluate(paper=>{window.fixture.papers=[...window.fixture.papers,paper];window.dispatchEvent(new Event('focus'))},added)
 await publishButton(p,added.title).waitFor()
 assert.equal(await p.getByRole('status',{name:'Loading papers'}).count(),0)
 assert.equal(await p.evaluate(()=>window.listCalls),before+1)
 assert.equal(await chip(p,'Group-II').getAttribute('aria-pressed'),'true')
 assert.match(await row(p,groupOne.title).getAttribute('class'),/is-highlighted/)
})

test('search appears only for long lists and repeated titles stay distinguishable',async t=>{
 const p=await open(t)
 await publishButton(p).waitFor()
 assert.equal(await p.getByRole('searchbox').count(),0)

 const many=[
  ...Array.from({length:6},(_,i)=>({...groupOne,id:'paper-'+i,title:'Group-2 Practice '+(i+1)})),
  {...groupOne,id:'repeat-1',title:'Group-2 Grand Test',version:'1',created_at:'2026-10-01T05:00:00Z'},
  {...groupOne,id:'repeat-2',title:'Group-2 Grand Test',version:'2',created_at:'2026-10-05T05:00:00Z'},
 ]
 const q=await open(t,{papers:many})
 const repeats=row(q,'Group-2 Grand Test')
 await repeats.first().waitFor()
 assert.deepEqual((await repeats.allInnerTexts()).map(text=>plain(text).match(/Version \d/)[0]),['Version 1','Version 2'])
 assert.match(plain(await repeats.first().innerText()),/Shared 1 Oct 2026/)
 const search=q.getByRole('searchbox',{name:'Search Group-II tests'})
 await search.fill('grand')
 assert.equal(await group(q,'Ready to publish').getByRole('listitem').count(),2)
 await search.fill('nothing like this')
 await q.getByText('No tests match “nothing like this”.',{exact:true}).waitFor()
})

test('Published tests keeps older batch tests, filters by program and offers a way back when empty',async t=>{
 const future=new Date(Date.now()+86400000).toISOString()
 const p=await open(t,{
  deliveries:[
   {id:'p1',version_id:'group-1',exam_id:'group',title:'Group-II weekly test',program:'Group-II',opens_at:'2026-10-05T05:00:00Z',question_count:150},
   {id:'p2',version_id:'dsc-1',exam_id:'dsc',title:'DSC divisional test',program:'DSC',opens_at:'2026-10-04T05:00:00Z',question_count:160},
  ],
  legacy:[
   {id:'old',title:'Older batch test',course:'Existing course',batches:['Existing batch'],opens_at:'2020-01-01',closes_at:'2020-02-01',created_at:'2020-01-01',question_count:10},
   {id:'later',title:'Scheduled batch test',course:'Existing course',batches:['Morning','Evening'],opens_at:future,created_at:'2020-01-02',question_count:20},
  ],
 },'/library?view=published')
 await p.getByRole('heading',{name:'Published tests',exact:true}).waitFor()
 const rows=p.getByRole('list',{name:'Published tests'}).getByRole('listitem')
 assert.deepEqual(await rows.getByRole('heading').allInnerTexts(),['Group-II weekly test','DSC divisional test','Scheduled batch test','Older batch test'])
 await p.getByText('Existing course · Existing batch',{exact:true}).waitFor()
 await p.getByText('150 questions · Published 5 Oct 2026',{exact:true}).waitFor()
 // Older tests without a test id still reach the full results list.
 assert.equal(await p.getByRole('link',{name:'Student results for Older batch test'}).getAttribute('href'),'/dashboard/teacher/results')
 await p.getByText('Existing course · Morning, Evening',{exact:true}).waitFor()
 assert.deepEqual(await p.locator('.pub-status').allInnerTexts(),['Available','Available','Scheduled','Closed'])
 const filter=p.getByRole('group',{name:'Filter published tests'})
 assert.deepEqual(await filter.getByRole('button').allInnerTexts(),['All','Group-II','DSC','Existing course'])
 await filter.getByRole('button',{name:'DSC',exact:true}).click()
 assert.deepEqual(await rows.getByRole('heading').allInnerTexts(),['DSC divisional test'])
 await filter.getByRole('button',{name:'All',exact:true}).click()
 assert.equal(await rows.count(),4)

 const one=await open(t,{deliveries:[{id:'p1',version_id:'group-1',exam_id:'group',title:'Only test',program:'Group-II',opens_at:'2020-01-01',question_count:150}]},'/library?view=published')
 await one.getByRole('heading',{name:'Only test',exact:true}).waitFor()
 assert.equal(await one.getByRole('group',{name:'Filter published tests'}).count(),0)

 const empty=await open(t,{},'/library?view=published')
 await empty.getByRole('heading',{name:'No published tests yet',exact:true}).waitFor()
 await empty.getByRole('button',{name:'Choose a test',exact:true}).click()
 await empty.getByRole('heading',{name:'Publish a test',exact:true}).waitFor()
 assert.equal(new URL(empty.url()).searchParams.get('view'),null)

 const failed=await open(t,{historyError:'Connection lost'},'/library?view=published')
 await failed.getByRole('alert').filter({hasText:'Connection lost'}).waitFor()
 await failed.evaluate(()=>{window.fixture.historyError=''})
 await failed.getByRole('alert').getByRole('button',{name:'Retry',exact:true}).click()
 await failed.getByRole('heading',{name:'No published tests yet',exact:true}).waitFor()
})

test('admins delete a published test after confirming; it returns to Ready papers and teachers never see delete',async t=>{
 const deliveries=[{id:'p1',version_id:'group-1',exam_id:'group',test_id:'t1',title:groupOne.title,program:'Group-II',opens_at:'2026-10-05T05:00:00Z',question_count:150}]
 const teacher=await open(t,{deliveries},'/library?view=published')
 await teacher.getByRole('heading',{name:groupOne.title,exact:true}).waitFor();assert.equal(await teacher.getByRole('button',{name:/More actions/}).count(),0)
 const p=await open(t,{admin:true,deliveries,kept:3,withdrawFailOnce:true},'/library?view=published')
 await p.getByRole('button',{name:'More actions for '+groupOne.title}).click()
 await p.getByRole('menuitem',{name:'Delete published test'}).click()
 const box=p.getByRole('dialog',{name:'Delete this published test?'});await box.waitFor()
 const text=plain(await box.innerText())
 assert.match(text,/Students can no longer see or start it\. Results already submitted stay in Student results\. The paper stays in Ready papers, so you can publish it again\./)
 assert.match(text,new RegExp(esc(groupOne.title)+' Group-II · Program students'))
 await box.getByRole('button',{name:'Cancel'}).click();await box.waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>window.withdrawn?.length||0),0)
 await p.getByRole('button',{name:'More actions for '+groupOne.title}).click();await p.getByRole('menuitem',{name:'Delete published test'}).click()
 await box.getByRole('button',{name:'Delete test'}).click()
 await box.getByRole('alert').filter({hasText:'This test could not be deleted. Please retry.'}).waitFor()
 assert.doesNotMatch(plain(await box.innerText()),technicalCopy)
 await box.getByRole('button',{name:'Retry'}).click();await box.waitFor({state:'hidden'})
 await p.getByRole('heading',{name:'Published test deleted',exact:true}).waitFor()
 await p.getByText('3 submitted results are kept in Student results.',{exact:false}).waitFor()
 await p.getByRole('heading',{name:'No published tests yet',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>window.withdrawn),['t1','t1'])
 await p.getByRole('button',{name:/^Ready papers/}).click()
 await publishButton(p).waitFor()
 assert.equal(await p.getByRole('heading',{name:'Published test deleted'}).count(),0)
})

test('every step fits 320, 390 and 1440 wide screens with 44px tap targets',async t=>{
 const long={...groupOne,id:'long',title:'Group-II General Studies and Mental Ability Grand Test Series Paper 14 (Final corrected)'}
 for(const width of [320,390,1440]){
  const p=await open(t,{admin:true,papers:[...papers,{...long,can_delete:true,can_bring_back:true}],deliveries:[{id:'x',version_id:'group-4',exam_id:'group',title:groupFour.title,program:'Group-II',opens_at:'2020-01-01'}],legacy:[{id:'old',title:'Older batch test with a long descriptive title for wrapping',course:'Existing course',batches:['Morning batch','Evening batch'],opens_at:'2020-01-01',question_count:10}]},'/library',width)
  await publishButton(p,long.title).waitFor()
  assert.equal(await fits(p),true,`library overflows at ${width}`)
  await chip(p,'Group-II').click()
  assert.equal(await fits(p),true,`filtered list overflows at ${width}`)
  const small=await p.locator('.publish-journey button:visible, .publish-journey a:visible').evaluateAll(nodes=>nodes.filter(node=>node.getBoundingClientRect().height<44).map(node=>node.textContent||node.getAttribute('aria-label')))
  assert.deepEqual(small,[],`tap targets under 44px at ${width}`)
  // The Publish button sits inside its own row, never in a separate bar.
  const inside=await row(p,long.title).evaluate((node,title)=>node.contains(document.querySelector(`[aria-label="Publish ${title}"]`)),long.title)
  assert.equal(inside,true)
  await p.getByRole('button',{name:/More actions/}).first().click()
  assert.equal(await fits(p),true,`menu overflows at ${width}`)
  await p.keyboard.press('Escape')
  await publishButton(p,long.title).click()
  await dialog(p).waitFor()
  const box=await dialog(p).boundingBox()
  assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=900,`dialog leaves the screen at ${width}`)
  await confirmButton(p).click()
  await p.getByRole('heading',{name:'Test published',exact:true}).waitFor()
  assert.equal(await fits(p),true,`success overflows at ${width}`)
  await p.getByRole('button',{name:'View published tests',exact:true}).click()
  await p.getByRole('heading',{name:'Older batch test with a long descriptive title for wrapping'}).waitFor()
  assert.equal(await fits(p),true,`published tests overflow at ${width}`)
 }
})
