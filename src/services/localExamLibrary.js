// Deliberately separate from all Supabase adapters. Preview data stays on this device.
import {paperReview,hasAnswer} from './creatorPaperReview.js'
import {formatIssues} from './examFormats.js'
export const previewExams = ['DSC-SGT', 'Group I', 'Group II', 'SI & Constable', 'Other competitive exams']
export const previewCourses = [{id:'dsc-sgt',name:'DSC-SGT · sample course',exam:'DSC-SGT',batches:['SGT · sample batch']},{id:'group-two',name:'Group II · sample course',exam:'Group II',batches:['Weekend · sample batch','Evening · sample batch']},{id:'police',name:'SI & Constable · sample course',exam:'SI & Constable',batches:['Evening · sample batch']}]
export function paperIssues(p) {
 const errors=[]
 if(!p.title?.trim()) errors.push('Add a paper title.')
 else if(p.title.length>200) errors.push('Shorten the paper title to 200 characters or fewer.')
 if(!previewExams.includes(p.exam)) errors.push('Choose an exam library.')
 if(!(Number.isInteger(Number(p.duration)) && Number(p.duration)>0 && Number(p.duration)<=600)) errors.push('Set a duration from 1 to 600 whole minutes.')
 if(!(Number(p.marks)>=0.01 && Number(p.marks)<=100) || !(Number(p.negative)>=0) || p.negative==='' || p.negative==null) errors.push('Set marks per question from 0.01 to 100 and negative marks of 0 or more.')
 else if(Number(p.negative)>Number(p.marks)) errors.push('Negative marks cannot be more than the marks per question.')
 if(!p.questions?.length) errors.push('Add at least one question.')
 const review=paperReview(p)
 errors.push(...review.numbering,...formatIssues(p))
 if(review.answersMissing.length)errors.push(`Answers needed for questions ${review.answersMissing.map(x=>x.q.number).join(', ')}. Apply an answer key or set the missing answers before saving ready.`)
 for(const item of review.pending) errors.push(`Question ${item.q.number}: ${item.reasons.join(' ')}`)
 if(!p.confirmed) errors.push('Confirm your final paper checks.')
 return errors
}
export function readyVersion(p) {
 const errors=paperIssues(p); if(errors.length) throw new Error(errors.join(' '))
 const {readyOperation,sharedReceipt,returnedReceipt,savedAt,resumeIndex,instituteProgram,...content}=structuredClone(p)
 return {...content,id:crypto.randomUUID(),state:'ready',createdAt:new Date().toISOString(),version:(p.version||0)+1}
}
export function revisedDraft(version){
 const {sharedReceipt,returnedReceipt,readyOperation,createdAt,savedAt,resumeIndex,...content}=structuredClone(version)
 return {...content,id:crypto.randomUUID(),state:'draft',confirmed:false}
}
export function readySignature(p,program,account) {
 const {savedAt,resumeIndex,instituteProgram,readyOperation,...content}=p
 return JSON.stringify([content,program,account||null])
}
export function saveDraft(p,resumeIndex,program) {
 return localLibrary('update',data=>({...data,drafts:[{...structuredClone(p),savedAt:new Date().toISOString(),resumeIndex,instituteProgram:program},...data.drafts.filter(d=>d.id!==p.id)]}))
}
export function deleteDeviceCopy(id) {
 return localLibrary('update',data=>({...data,ready:data.ready.filter(p=>p.id!==id)}))
}
export function reserveReady(p,program,account,resumeIndex) {
 const signature=readySignature(p,program,account)
 return localLibrary('update',data=>{
  const previous=data.drafts.find(d=>d.id===p.id)?.readyOperation
  const operation=previous?.signature===signature?previous:{signature,version:readyVersion(p),program,account:account||null}
  return {...data,drafts:[{...structuredClone(p),savedAt:new Date().toISOString(),resumeIndex,instituteProgram:program,readyOperation:operation},...data.drafts.filter(d=>d.id!==p.id)]}
 })
}
// The ready version now holds the finished paper, so its draft leaves My drafts in the same write.
// A draft whose reservation changed meanwhile (edited elsewhere) is different work and stays.
export function completeReady(p,operation,shared,sharedVersion=null) {
 return localLibrary('update',data=>{
  const version={...operation.version,...(shared?{sharedReceipt:{program:operation.program,account:operation.account,version:sharedVersion,savedAt:new Date().toISOString()}}:{})}
  return {...data,ready:[version,...data.ready.filter(v=>v.id!==version.id)],drafts:data.drafts.filter(d=>d.id!==p.id||d.readyOperation?.signature!==operation.signature)}
 })
}
export function removeDraft(id) {
 return localLibrary('update',data=>({...data,drafts:data.drafts.filter(d=>d.id!==id)}))
}
// Undo for a deleted draft: the same draft goes back to the place it had in My drafts.
export function restoreDraft(draft,index) {
 return localLibrary('update',data=>{
  if(data.drafts.some(d=>d.id===draft.id))return data
  const drafts=[...data.drafts];drafts.splice(Math.min(index,drafts.length),0,draft)
  return {...data,drafts}
 })
}
// How far a draft is: a question is ready once its content, four choices and answer are in place
// and nothing on it is waiting for the creator's check.
export function draftProgress(p) {
 const items=paperReview(p).items,waiting=items.filter(x=>x.reasons.length||!hasAnswer(x.q))
 return {total:items.length,ready:items.length-waiting.length,attention:waiting.length,firstIndex:waiting[0]?.index??-1}
}
// A draft that was already saved as a version: it is based on that version and may carry newer edits.
export const savedVersionOf=draft=>!draft.readyOperation&&Number(draft.version)>0?Number(draft.version):0
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,sorted(value[key])])):value
// The paper itself, without where or when a copy was saved; key order does not matter.
function paperContent(p) {
 const {id,state,createdAt,savedAt,resumeIndex,instituteProgram,readyOperation,sharedReceipt,returnedReceipt,...content}=p
 return JSON.stringify(sorted(content))
}
// Earlier ready saves left their draft behind. Remove a leftover only when a ready version on this
// device holds exactly the same paper; drafts with newer edits or an interrupted save are kept.
export function cleanFinishedDrafts() {
 return localLibrary('update',data=>{
  const finished=new Map()
  const sameAsReady=draft=>{
   const version=savedVersionOf(draft)
   if(!version)return false
   const candidates=data.ready.filter(v=>Number(v.version)===version&&v.questions?.length===draft.questions?.length)
   if(!candidates.length)return false
   const content=paperContent(draft)
   return candidates.some(v=>{if(!finished.has(v.id))finished.set(v.id,paperContent(v));return finished.get(v.id)===content})
  }
  return {...data,drafts:data.drafts.filter(d=>!sameAsReady(d))}
 })
}
export function previewDelivery(p,courseId,batch) {
 const course=previewCourses.find(c=>c.id===courseId)
 if(p.state!=='ready' || !course || course.exam!==p.exam || !course.batches.includes(batch)) throw new Error('Choose a matching sample course and batch for a ready paper.')
 return {id:crypto.randomUUID(),versionId:p.id,title:p.title,exam:p.exam,course:course.name,batch,createdAt:new Date().toISOString(),snapshot:structuredClone(p)}
}
export async function localLibrary(action,value) {
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ksc-local-library-preview-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Browser storage is unavailable. Allow storage to save this preview.'))})
 try {return await new Promise((resolve,reject)=>{
  const tx=db.transaction('workspace',action==='read'?'readonly':'readwrite'),s=tx.objectStore('workspace')
  let result=value
  const r=action==='write'?s.put(value,'data'):s.get('data')
  if(action!=='write')r.onsuccess=()=>{
   result=r.result||{drafts:[],ready:[],deliveries:[]}
   if(action==='update')try{result=value(result);s.put(result,'data')}catch(e){reject(e);tx.abort()}
  }
  tx.oncomplete=()=>resolve(result)
  tx.onerror=()=>reject(new Error('Could not save on this device. Free browser storage and retry.'))
  tx.onabort=()=>reject(new Error('Local save was interrupted. Retry before leaving.'))
 })} finally {db.close()}
}
