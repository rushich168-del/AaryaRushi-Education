import { test } from 'node:test'
import assert from 'node:assert/strict'
import { academicChoices, reconcileAcademicContext } from '../src/services/academicContext.js'
import { importCandidate, reviseImportCandidate, validateImportCandidate, readyForDraft } from '../src/services/questionImportContract.js'
import { catalogue } from './fixtures/portal-catalogue.mjs'
const data = { ...catalogue, syllabi: catalogue.syllabi.map(row=>({...row,status:'ACTIVE'})) }
const context = {exam_id:'sainik',level_id:'six',subject_id:'math',syllabus_id:'',chapter_id:'',topic_id:''}
test('single active subject syllabus is selected; archive and other tracks are excluded',()=>{
  const rows={...data,syllabi:[...data.syllabi,{...data.syllabi[0],id:'archive',status:'ARCHIVED'},{...data.syllabi[0],id:'other',level_id:'nine'}]}
  assert.equal(reconcileAcademicContext(rows,context).syllabus_id,'syllabus')
  assert.equal(academicChoices(rows,context,true)[3][2].length,1)
  assert.equal(reconcileAcademicContext({...data,syllabi:[...data.syllabi,{...data.syllabi[0],id:'second'}]},context).syllabus_id,'')
})
test('invalid ancestry is cleared and inactive curriculum cannot survive authoring reconciliation',()=>{
  const old={...context,level_id:'nine',syllabus_id:'syllabus',chapter_id:'chapter',topic_id:'topic'}
  const next=reconcileAcademicContext(data,old)
  assert.equal(next.syllabus_id,'');assert.equal(next.chapter_id,'');assert.equal(next.topic_id,'')
  assert.equal(reconcileAcademicContext({...data,exams:data.exams.map(row=>({...row,is_active:false}))},context).subject_id,'')
})
test('import contract never invents an answer or trusts parser confirmation',()=>{
  const item=importCandidate({content:'2+2?',options:['3','4'],confirmed:true},context,{kind:'PDF',name:'paper.pdf',page:3})
  assert.equal(item.correctAnswerIndex,null);assert.equal(item.confirmed,false)
  assert.equal(validateImportCandidate(item).state,'INVALID');assert.equal(readyForDraft(item),false)
  const valid=reviseImportCandidate(item,{correctAnswerIndex:1})
  assert.equal(validateImportCandidate(valid).state,'VALID')
  assert.equal(readyForDraft({...valid,confirmed:true}),true)
  assert.equal(readyForDraft({...valid,confirmed:true,included:false}),false)
  assert.equal(reviseImportCandidate({...valid,confirmed:true},{content:'Changed'}).confirmed,false)
  assert.equal(valid.source.page,3)
})
test('incomplete options and classification cannot become draft-ready',()=>{
  for(const changes of [{options:['']},{options:['3','']},{correctAnswerIndex:8},{difficulty:'UNKNOWN'},{academic:{...context,subject_id:''}},{academic:{...context,topic_id:'topic'}}]){
    const item={...importCandidate({content:'2+2?',options:['3','4'],correctAnswerIndex:1},context),...changes,confirmed:true}
    assert.equal(readyForDraft(item),false)
  }
})
