import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
let browser,bundle
before(async()=>{
 bundle=(await build({stdin:{contents:`import * as service from './src/services/localExamLibrary.js';window.service=service`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(()=>browser?.close())
async function open(t){const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<script>'+bundle+'</script>'}));const page=await context.newPage();await page.goto('http://127.0.0.1:55556/');return page}
const paper={id:'draft-a',title:'Saved paper',exam:'Group II',testFormat:'subject',targetCount:1,sections:[{subject:'Mixed subjects',count:1}],duration:60,marks:1,negative:0,confirmed:true,questions:[{number:1,content:'Question',options:['A','B','C','D'],correct:0}]}
test('atomic saved-work updates preserve drafts written concurrently and existing ready/delivery records',async t=>{
 const p=await open(t)
 const result=await p.evaluate(async paper=>{
  await service.localLibrary('write',{drafts:[],ready:[{id:'previous-ready'}],deliveries:[{id:'previous-delivery'}]})
  await Promise.all([service.saveDraft(paper,0,'program-a'),service.saveDraft({...paper,id:'draft-b'},1,'program-b')])
  return service.localLibrary('read')
 },paper)
 assert.deepEqual(result.drafts.map(d=>d.id).sort(),['draft-a','draft-b']);assert.equal(result.ready[0].id,'previous-ready');assert.equal(result.deliveries[0].id,'previous-delivery');assert.equal(result.drafts.find(d=>d.id==='draft-b').resumeIndex,1)
})
test('durable reservation recovers its request after reload; changed program/account/content receives a new request',async t=>{
 const p=await open(t)
 const id=await p.evaluate(async paper=>{const data=await service.reserveReady(paper,'exam','creator-a',0);return data.drafts[0].readyOperation.version.id},paper)
 await p.reload()
 const ids=await p.evaluate(async()=>{
  const draft=(await service.localLibrary('read')).drafts[0]
  const recovered=(await service.reserveReady(draft,'exam','creator-a',0)).drafts[0].readyOperation
  const changed=(await service.reserveReady({...draft,title:'Changed paper'},'exam','creator-a',0)).drafts[0].readyOperation
  const account=(await service.reserveReady(draft,'exam','creator-b',0)).drafts[0].readyOperation
  const program=(await service.reserveReady(draft,'other','creator-a',0)).drafts[0].readyOperation
  return [recovered.version.id,changed.version.id,account.version.id,program.version.id]
 })
 assert.equal(ids[0],id);assert.equal(new Set(ids).size,4)
})
// A finished paper must leave My drafts: the ready version keeps the content.
const complete=async(p,{shared,program='exam',account='creator'}={shared:true})=>p.evaluate(async({paper,shared,program,account})=>{
 const reserved=await service.reserveReady(paper,program,shared?account:null,0),op=reserved.drafts.find(d=>d.id===paper.id).readyOperation
 const completed=await service.completeReady(paper,op,shared,shared?'server-version':null)
 return {op,completed}
},{paper,shared,program,account})
test('a completed ready save removes the draft in the same write, connected or offline, and freezes one ready copy',async t=>{
 for(const shared of [true,false]){
  const p=await open(t)
  await p.evaluate(async paper=>{await service.localLibrary('write',{drafts:[{...paper,id:'other-draft',title:'Still in progress'}],ready:[{id:'previous-ready',title:'Earlier',version:1,questions:[]}],deliveries:[{id:'previous-delivery'}]})},paper)
  const {op,completed}=await complete(p,{shared})
  assert.deepEqual(completed.drafts.map(d=>d.id),['other-draft'])
  assert.deepEqual(completed.ready.map(v=>v.id),[op.version.id,'previous-ready'])
  assert.equal(completed.deliveries[0].id,'previous-delivery')
  const version=completed.ready[0]
  assert.equal(version.title,'Saved paper');assert.equal(version.version,1);assert.equal(version.state,'ready');assert.equal(version.readyOperation,undefined)
  if(shared){assert.equal(version.sharedReceipt.version,'server-version');assert.equal(version.sharedReceipt.program,'exam');assert.equal(version.sharedReceipt.account,'creator')}
  else assert.equal(version.sharedReceipt,undefined)
  // Completing the same operation again (a repeated click or reply) changes nothing.
  const again=await p.evaluate(async({paper,op})=>service.completeReady(paper,op,false),{paper,op})
  assert.equal(again.ready.length,2);assert.deepEqual(again.drafts.map(d=>d.id),['other-draft'])
 }
})
test('an interrupted share keeps the draft and its request; the retry reuses the same version and then removes the draft',async t=>{
 const p=await open(t)
 const first=await p.evaluate(async paper=>{const data=await service.reserveReady(paper,'exam','creator',0);return data.drafts[0].readyOperation.version.id},paper)
 // The share never completed: the page is closed and reopened.
 await p.reload()
 const result=await p.evaluate(async()=>{
  const loaded=await service.cleanFinishedDrafts(),draft=loaded.drafts[0]
  const retry=(await service.reserveReady(draft,'exam','creator',0)).drafts[0].readyOperation
  const completed=await service.completeReady(draft,retry,true,'server-version')
  return {kept:loaded.drafts.length,interrupted:!!draft.readyOperation,retry:retry.version.id,completed}
 })
 assert.equal(result.kept,1);assert.equal(result.interrupted,true);assert.equal(result.retry,first)
 assert.deepEqual(result.completed.drafts,[]);assert.deepEqual(result.completed.ready.map(v=>v.id),[first])
})
test('a draft edited since its reservation is never removed by an older completion',async t=>{
 const p=await open(t)
 const result=await p.evaluate(async paper=>{
  const op=(await service.reserveReady(paper,'exam','creator',0)).drafts[0].readyOperation
  await service.reserveReady({...paper,title:'Edited in another tab'},'exam','creator',0)
  return service.completeReady(paper,op,true,'server-version')
 },paper)
 assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].title,'Edited in another tab');assert.equal(result.ready.length,1)
})
test('leftover finished drafts are cleaned on load only when identical to a ready version; edited ones are kept',async t=>{
 const p=await open(t)
 const result=await p.evaluate(async paper=>{
  const ready={...paper,id:'ready-1',state:'ready',createdAt:'2026-10-01T00:00:00.000Z',version:1,sharedReceipt:{program:'exam',version:'server-version'}}
  // A copy brought back from the server arrives with its keys in a different order.
  const reordered=Object.fromEntries(Object.entries({...paper,id:'ready-2',title:'Brought back',state:'ready',createdAt:'2026-10-02T00:00:00.000Z',version:3}).reverse())
  await service.localLibrary('write',{deliveries:[],ready:[ready,reordered],drafts:[
   {...paper,id:'same',version:1,savedAt:'2026-10-03T00:00:00.000Z',resumeIndex:0,instituteProgram:'exam'},
   {...paper,id:'same-reordered',title:'Brought back',version:3,savedAt:'2026-10-03T00:00:00.000Z'},
   {...paper,id:'edited',version:1,confirmed:false,questions:[{...paper.questions[0],correct:2}],savedAt:'2026-10-04T00:00:00.000Z'},
   {...paper,id:'interrupted',version:1,readyOperation:{signature:'pending',version:{id:'pending-version'}}},
   {...paper,id:'revised',state:'draft',version:1,confirmed:false},
   {...paper,id:'new-work',title:'Never finished'},
  ]})
  const cleaned=await service.cleanFinishedDrafts()
  return {cleaned,stored:await service.localLibrary('read')}
 },paper)
 assert.deepEqual(result.cleaned.drafts.map(d=>d.id),['edited','interrupted','revised','new-work'])
 assert.deepEqual(result.stored.drafts.map(d=>d.id),['edited','interrupted','revised','new-work'])
 assert.deepEqual(result.stored.ready.map(v=>v.id),['ready-1','ready-2'])
 assert.equal(result.stored.ready[0].sharedReceipt.version,'server-version')
})
test('a revised draft is a new draft, saves as the next version and leaves drafts after its own completion',async t=>{
 const p=await open(t)
 const {completed}=await complete(p)
 const result=await p.evaluate(async original=>{
  const revised={...service.revisedDraft(original),title:'Revised paper',confirmed:true}
  const saved=await service.saveDraft(revised,0,'exam')
  const afterLoad=await service.cleanFinishedDrafts()
  const op=(await service.reserveReady(revised,'exam','creator',0)).drafts[0].readyOperation
  const done=await service.completeReady(revised,op,true,'server-version-2')
  return {revisedId:revised.id,saved:saved.drafts.map(d=>d.id),afterLoad:afterLoad.drafts.map(d=>d.id),done}
 },completed.ready[0])
 assert.notEqual(result.revisedId,completed.ready[0].id)
 assert.deepEqual(result.saved,[result.revisedId]);assert.deepEqual(result.afterLoad,[result.revisedId])
 assert.deepEqual(result.done.drafts,[])
 assert.deepEqual(result.done.ready.map(v=>[v.title,v.version]),[['Revised paper',2],['Saved paper',1]])
 assert.equal(result.done.ready[0].readyOperation,undefined);assert.equal(result.done.ready[1].sharedReceipt.version,'server-version')
})
test('removing a draft leaves ready versions, shared receipts and other drafts untouched',async t=>{
 const p=await open(t)
 const result=await p.evaluate(async paper=>{
  await service.localLibrary('write',{deliveries:[{id:'delivery'}],ready:[{...paper,id:'ready-1',state:'ready',version:1,sharedReceipt:{version:'server-version'}}],drafts:[{...paper,id:'leftover',version:1,confirmed:false},{...paper,id:'keep'}]})
  return service.removeDraft('leftover')
 },paper)
 assert.deepEqual(result.drafts.map(d=>d.id),['keep']);assert.equal(result.ready[0].sharedReceipt.version,'server-version');assert.equal(result.deliveries.length,1)
})

test('draft progress counts ready questions and points at the first one needing attention',async t=>{
 const p=await open(t)
 const result=await p.evaluate(paper=>{
  const ok=paper.questions[0]
  return [
   service.draftProgress({...paper,questions:[ok,{...ok,number:2},{...ok,number:3,correct:null},{...ok,number:4,content:''},{...ok,number:5,markedForReview:true}]}),
   service.draftProgress({...paper,questions:[ok,{...ok,number:2}]}),
   service.draftProgress({...paper,questions:[]}),
  ]
 },paper)
 assert.deepEqual(result[0],{total:5,ready:2,attention:3,firstIndex:2})
 assert.deepEqual(result[1],{total:2,ready:2,attention:0,firstIndex:-1})
 assert.deepEqual(result[2],{total:0,ready:0,attention:0,firstIndex:-1})
})
test('a deleted draft can be put back exactly where it was, once, without touching ready versions',async t=>{
 const p=await open(t)
 const result=await p.evaluate(async paper=>{
  const drafts=[{...paper,id:'first'},{...paper,id:'middle',title:'Middle draft',savedAt:'2026-10-06T05:00:00.000Z',resumeIndex:0,readyOperation:{signature:'pending',version:{id:'pending-version'}}},{...paper,id:'last'}]
  const ready=[{...paper,id:'ready-1',state:'ready',version:1,sharedReceipt:{version:'server-version'}}]
  await service.localLibrary('write',{drafts,ready,deliveries:[{id:'delivery'}]})
  const removed=await service.removeDraft('middle')
  const restored=await service.restoreDraft(drafts[1],1)
  const twice=await service.restoreDraft(drafts[1],1)
  const beyond=await service.restoreDraft({...paper,id:'late'},99)
  return {drafts,ready,removed,restored,twice,beyond}
 },paper)
 assert.deepEqual(result.removed.drafts.map(d=>d.id),['first','last'])
 assert.deepEqual(result.restored.drafts,result.drafts)
 assert.deepEqual(result.twice.drafts,result.drafts)
 assert.deepEqual(result.beyond.drafts.map(d=>d.id),['first','middle','last','late'])
 for(const state of [result.removed,result.restored,result.twice,result.beyond]){assert.deepEqual(state.ready,result.ready);assert.equal(state.deliveries.length,1)}
})
